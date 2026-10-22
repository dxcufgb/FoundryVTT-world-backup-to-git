'use strict';
// Self-update helper for the backup service itself (not for the worlds it backs up). Looks up the latest GitHub release of this
// repository, compares it with the installed version and, if it is strictly newer, downloads the release archive
// (foundry-world-backup-<version>-linux.tar.gz or -windows.zip) and verifies it against the release's SHA256SUMS.txt.
// Installing is left to the install scripts. A newer release without these files
// is reported as an error and nothing is installed.
//
//   node src/updater.js --check    [--token-file FILE] [--app-dir DIR]
//   node src/updater.js --download DIR [--token-file FILE] [--app-dir DIR] [--format tar.gz|zip]
//
// Exit codes: 0 = up to date, 10 = newer release available (--check) or downloaded (--download), 1 = error.
// This repository is public, so no token is needed. A token, when there is one, raises GitHub's rate limit (60
// requests an hour per IP address without one): it is read from FILE (a `GITHUB_TOKEN=...` line, as in the service's
// env file, or the bare token; a missing FILE means no token) or from the UPDATER_GITHUB_TOKEN environment variable.
// A token GitHub refuses (HTTP 401: expired or revoked) is dropped for the rest of the run. It is only ever sent to
// api.github.com and never printed.
// No dependencies: built-in fs, path, crypto and fetch only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = 'dxcufgb/FoundryVTT-world-backup-to-git';
const GITHUB_API = 'https://api.github.com';
const PACKAGE = 'foundry-world-backup';
const SUMS_NAME = 'SHA256SUMS.txt';
const API_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXIT_CURRENT = 0;
const EXIT_UPDATE = 10;
const EXIT_ERROR = 1;

class UpdateError extends Error {}

/** Parse version text into major, minor, patch and prerelease parts; return null on invalid syntax. */
function parseVersion(text) {
  const m = SEMVER_RE.exec(String(text).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semantic Versioning 2.0.0 precedence: <0, 0 or >0. Build metadata is ignored. */
function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) throw new UpdateError(`not a semantic version: "${!va ? a : b}"`);
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (!va.pre.length || !vb.pre.length) return Math.sign(vb.pre.length - va.pre.length);
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Parses `sha256sum` output: "<64 hex>  <name>" or "<64 hex> *<name>". Returns a name -> hash map. */
function parseSha256Sums(text) {
  const sums = Object.create(null);
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (!m) throw new UpdateError(`${SUMS_NAME} has a malformed line`);
    sums[m[2]] = m[1].toLowerCase();
  }
  return sums;
}

/** Return the release filename for a version and format; reject formats other than tar.gz or zip. */
function archiveName(version, format) {
  if (format === 'tar.gz') return `${PACKAGE}-${version}-linux.tar.gz`;
  if (format === 'zip') return `${PACKAGE}-${version}-windows.zip`;
  throw new UpdateError(`unknown archive format "${format}"`);
}

/** Picks the archive and SHA256SUMS.txt assets of a release. */
function selectAssets(release, format) {
  const version = String(release.tag_name).replace(/^v/, '');
  const name = archiveName(version, format);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archive = assets.find((a) => a && a.name === name);
  const sums = assets.find((a) => a && a.name === SUMS_NAME);
  if (!archive) throw new UpdateError(`release ${release.tag_name} has no asset ${name}; nothing installed`);
  if (!sums) throw new UpdateError(`release ${release.tag_name} has no ${SUMS_NAME} asset; nothing installed`);
  return { archive, sums };
}

/** Token from a file: a GITHUB_TOKEN=... line (env-file syntax) or the first non-comment line. */
function parseTokenFile(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const assignment = lines.find((l) => /^(export\s+)?GITHUB_TOKEN\s*=/.test(l));
  let token = assignment ? assignment.replace(/^(export\s+)?GITHUB_TOKEN\s*=\s*/, '') : lines.find((l) => !l.includes('='));
  if (token === undefined) return '';
  token = token.replace(/^(["'])(.*)\1$/, '$2').trim();
  return token === 'REPLACE_ME' || token === 'github_pat_REPLACE_ME' ? '' : token;
}

/** Create release lookup, check and download helpers with an optional token and injectable fetch/logger. */
function createUpdater({ token = '', fetchImpl = fetch, log = console.log, repo = REPO } = {}) {
  let authToken = token || '';

  /** Build GitHub API headers (with the token, when there is one) for the requested response media type. */
  const apiHeaders = (accept) => ({
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${PACKAGE}-updater`,
  });

  /** The error for a failed API answer: a used-up rate limit (403/429) is named as such, with what helps. */
  function httpError(res, what) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isInteger(reset) && reset > 0 ? `; it resets at ${new Date(reset * 1000).toISOString()}` : '';
      const hint = authToken
        ? 'try again later'
        : 'try again later, or give the updater a token (UPDATER_GITHUB_TOKEN; see README, "Automatic updates")';
      const limit = authToken ? "GitHub's rate limit" : "GitHub's rate limit for requests without a token (60 an hour per IP address)";
      return new UpdateError(`${what}: ${limit} is used up (HTTP ${res.status})${when}; ${hint}`);
    }
    return new UpdateError(`${what} failed (HTTP ${res.status})`);
  }

  /** Fetch an HTTPS URL with a timeout, rejecting authenticated requests outside the GitHub API. */
  async function request(url, init, timeoutMs, what) {
    if (!url.startsWith('https://')) throw new UpdateError(`${what}: refusing non-HTTPS URL`);
    if (init.headers && init.headers.Authorization && !url.startsWith(`${GITHUB_API}/`)) {
      // Never reached with GitHub's own JSON, but keeps the token on api.github.com no matter what.
      throw new UpdateError(`${what}: refusing to send the token outside ${GITHUB_API}`);
    }
    try {
      return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (err) {
      throw new UpdateError(`${what}: request failed (${err.name === 'TimeoutError' ? 'timeout' : err.message})`);
    }
  }

  /** Reads a response body, refusing more than `limit` bytes. */
  async function readCapped(res, limit, what) {
    const declared = Number(res.headers.get('content-length'));
    if (declared > limit) {
      await res.body?.cancel?.();
      throw new UpdateError(`${what}: too large (${declared} bytes, limit ${limit})`);
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new UpdateError(`${what}: too large (over ${limit} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** Fetch and parse the latest release within the size cap; throw UpdateError on lookup or data errors. */
  async function latestRelease() {
    /** One release lookup with the headers of the moment (with or without the token). */
    const lookup = () =>
      request(
        `${GITHUB_API}/repos/${repo}/releases/latest`,
        { headers: apiHeaders('application/vnd.github+json') },
        API_TIMEOUT_MS,
        'release lookup',
      );
    let res = await lookup();
    if (res.status === 401 && authToken) {
      // The repository is public: an expired or revoked token must not stop the update.
      await res.body?.cancel?.();
      log('GitHub refused the token (HTTP 401); continuing without a token');
      authToken = '';
      res = await lookup();
    }
    if (res.status === 404) {
      await res.body?.cancel?.();
      throw new UpdateError(
        authToken
          ? 'no published release found, or the token cannot read this repository (HTTP 404)'
          : 'no published release found (HTTP 404)',
      );
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      throw httpError(res, 'release lookup');
    }
    let release;
    try {
      release = JSON.parse((await readCapped(res, MAX_JSON_BYTES, 'release lookup')).toString('utf8'));
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw new UpdateError('release lookup returned invalid JSON');
    }
    if (!release || typeof release.tag_name !== 'string') throw new UpdateError('release lookup returned no tag');
    return release;
  }

  /** Release asset via the API URL: the token (if any) on the API request only, the redirect target never gets it. */
  async function downloadAsset(asset, limit) {
    const what = `download of ${asset.name}`;
    if (typeof asset.url !== 'string' || !asset.url.startsWith(`${GITHUB_API}/repos/${repo}/releases/assets/`)) {
      throw new UpdateError(`${what}: unexpected asset URL`);
    }
    let res = await request(
      asset.url,
      { headers: apiHeaders('application/octet-stream'), redirect: 'manual' },
      DOWNLOAD_TIMEOUT_MS,
      what,
    );
    if (REDIRECTS.has(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel?.();
      if (!location) throw new UpdateError(`${what}: redirect without a location`);
      // The pre-signed URL rejects requests that also carry an Authorization header, and it must not see the token.
      res = await request(
        location,
        { headers: { 'User-Agent': `${PACKAGE}-updater` }, redirect: 'error' },
        DOWNLOAD_TIMEOUT_MS,
        what,
      );
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      throw httpError(res, what);
    }
    return readCapped(res, limit, what);
  }

  /** Returns { current, latest, newer, release }. Drafts and prereleases never count as an update. */
  async function check(currentVersion) {
    const current = parseVersion(currentVersion);
    if (!current) throw new UpdateError(`installed version "${currentVersion}" is not a semantic version`);
    const release = await latestRelease();
    const latest = parseVersion(release.tag_name);
    if (!latest) throw new UpdateError(`latest release tag "${release.tag_name}" is not a semantic version`);
    const usable = !release.draft && !release.prerelease && latest.pre.length === 0;
    const newer = usable && compareVersions(latest, current) > 0;
    return { current: String(currentVersion).replace(/^v/, ''), latest: release.tag_name.replace(/^v/, ''), newer, release };
  }

  /** Downloads and verifies the archive into `dir`. Returns the file path. */
  async function download(release, format, dir) {
    const { archive, sums } = selectAssets(release, format);
    const sumsText = (await downloadAsset(sums, MAX_SUMS_BYTES)).toString('utf8');
    const expected = parseSha256Sums(sumsText)[archive.name];
    if (!expected) throw new UpdateError(`${SUMS_NAME} has no entry for ${archive.name}`);
    const data = await downloadAsset(archive, MAX_ARCHIVE_BYTES);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== expected) throw new UpdateError(`checksum mismatch for ${archive.name}`);
    const file = path.join(dir, archive.name);
    fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    log(`downloaded ${archive.name} (${data.length} bytes, sha256 verified)`);
    return file;
  }

  return { check, download, latestRelease };
}

/** Parse CLI arguments with platform defaults; reject unknown options, missing values or a missing mode. */
function parseArgs(argv) {
  const opts = { format: process.platform === 'win32' ? 'zip' : 'tar.gz', appDir: path.join(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** Consume the next argument as the current option value; throw UpdateError if none remains. */
    const value = () => {
      if (i + 1 >= argv.length) throw new UpdateError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--check') opts.mode = 'check';
    else if (arg === '--download') {
      opts.mode = 'download';
      opts.dir = value();
    } else if (arg === '--token-file') opts.tokenFile = value();
    else if (arg === '--app-dir') opts.appDir = value();
    else if (arg === '--format') opts.format = value();
    else throw new UpdateError(`unknown argument "${arg}"`);
  }
  if (!opts.mode) throw new UpdateError('use --check or --download DIR');
  return opts;
}

/** Run a release check or download; return 0 if current, 10 for an update, or 1 for an expected error. */
async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  try {
    const opts = parseArgs(argv);
    archiveName('0.0.0', opts.format);
    let token = env.UPDATER_GITHUB_TOKEN || '';
    if (!token && opts.tokenFile) {
      try {
        token = parseTokenFile(fs.readFileSync(opts.tokenFile, 'utf8'));
      } catch (err) {
        // No token file is no token (this repository is public); a file that exists but cannot be read is an error.
        if (err.code !== 'ENOENT') throw new UpdateError(`cannot read token file ${opts.tokenFile} (${err.code || err.message})`);
        log(`no token file ${opts.tokenFile}; asking GitHub without a token`);
      }
    }
    let installed;
    try {
      installed = JSON.parse(fs.readFileSync(path.join(opts.appDir, 'package.json'), 'utf8')).version;
    } catch (err) {
      throw new UpdateError(`cannot read the installed version from ${opts.appDir} (${err.code || err.message})`);
    }
    const updater = createUpdater({ token, fetchImpl, log });
    const result = await updater.check(installed);
    if (!result.newer) {
      log(`up to date: installed ${result.current}, latest release ${result.latest}`);
      return EXIT_CURRENT;
    }
    log(`update available: ${result.current} -> ${result.latest}`);
    if (opts.mode === 'check') return EXIT_UPDATE;
    const file = await updater.download(result.release, opts.format, opts.dir);
    log(`ARCHIVE=${file}`);
    log(`VERSION=${result.latest}`);
    return EXIT_UPDATE;
  } catch (err) {
    if (!(err instanceof UpdateError)) throw err;
    console.error(`${PACKAGE} updater: ${err.message}`);
    return EXIT_ERROR;
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`${PACKAGE} updater: internal error: ${err.message}`);
      process.exit(EXIT_ERROR);
    },
  );
}

module.exports = {
  REPO,
  createUpdater,
  compareVersions,
  parseVersion,
  parseSha256Sums,
  parseTokenFile,
  selectAssets,
  archiveName,
  main,
  UpdateError,
  EXIT_CURRENT,
  EXIT_UPDATE,
  EXIT_ERROR,
};

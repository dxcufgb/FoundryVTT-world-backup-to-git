'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  createUpdater,
  compareVersions,
  parseSha256Sums,
  parseTokenFile,
  selectAssets,
  main,
  UpdateError,
  EXIT_CURRENT,
  EXIT_UPDATE,
  EXIT_ERROR,
} = require('../src/updater.js');

const API = 'https://api.github.com';
const REPO = 'dxcufgb/FoundryVTT-world-backup-to-git';
const LATEST = `${API}/repos/${REPO}/releases/latest`;
const TOKEN = 'updater-token-secret';

/** Create a JSON response fixture with the requested HTTP status and headers. */
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
/** Create a redirect response fixture pointing to the supplied location. */
const redirect = (location) => new Response(null, { status: 302, headers: { location } });
/** Return the hexadecimal SHA-256 digest of fixture data. */
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Create a fetch stub that dispatches URL routes and records requests in its calls array. */
function mockFetch(routes) {
  const calls = [];
  /** Record a request and invoke its route handler; reject unexpected URLs. */
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(init);
  };
  fn.calls = calls;
  return fn;
}

/** Other file names a release might carry (the proxy's old ones): the updater must ignore them. */
function legacyNames(v) {
  return [`foundry-world-backup-${v}.tar.gz`, `foundry-world-backup-${v}.zip`, 'SHA256SUMS'];
}

/** Build release metadata with archive and checksum assets (new names first, then legacy), allowing overrides. */
function release(tag, extra = {}) {
  const v = tag.replace(/^v/, '');
  const names = [
    `foundry-world-backup-${v}-linux.tar.gz`,
    `foundry-world-backup-${v}-windows.zip`,
    'SHA256SUMS.txt',
    ...legacyNames(v),
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: names.map((name, i) => ({ name, url: `${API}/repos/${REPO}/releases/assets/${100 + i}` })),
    ...extra,
  };
}

/** Build release lookup and asset routes, with optional checksum data for mismatch tests. */
function releaseRoutes(tag, archive, { sumsFor = archive } = {}) {
  const rel = release(tag);
  const v = tag.replace(/^v/, '');
  const sums =
    `${sha(sumsFor)}  foundry-world-backup-${v}-linux.tar.gz\n${'0'.repeat(64)}  foundry-world-backup-${v}-windows.zip\n` +
    `${'1'.repeat(64)}  foundry-world-backup-${v}.tar.gz\n`;
  const routes = {
    [LATEST]: () => json(rel),
    [rel.assets[0].url]: () => redirect('https://objects.example/signed-archive'),
    [rel.assets[2].url]: () => redirect('https://objects.example/signed-sums'),
    'https://objects.example/signed-archive': () => new Response(archive),
    'https://objects.example/signed-sums': () => new Response(sums),
  };
  return { rel, routes };
}

/** Create and return an isolated temporary directory; the caller must remove it. */
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
}

test('semantic version comparison', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), UpdateError);
  assert.throws(() => compareVersions('latest', '1.0.0'), UpdateError);
});

test('SHA256SUMS parsing', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseSha256Sums(`${a}  one.tar.gz\r\n${b} *two.zip\n\n`);
  assert.equal(sums['one.tar.gz'], a);
  assert.equal(sums['two.zip'], 'b'.repeat(64));
  assert.equal(Object.getPrototypeOf(sums), null);
  assert.throws(() => parseSha256Sums('nothex  file'), UpdateError);
  assert.throws(() => parseSha256Sums(`${a}file`), UpdateError);
});

test('token file parsing', () => {
  assert.equal(parseTokenFile('GITHUB_TOKEN=github_pat_abc\nPORT=8787\n'), 'github_pat_abc');
  assert.equal(parseTokenFile('# comment\nPORT=1\nGITHUB_TOKEN="ghp_quoted"\n'), 'ghp_quoted');
  assert.equal(parseTokenFile('  github_pat_bare  \n'), 'github_pat_bare');
  assert.equal(parseTokenFile('GITHUB_TOKEN=REPLACE_ME\n'), '');
  assert.equal(parseTokenFile('PORT=8787\n'), '');
  assert.equal(parseTokenFile(''), '');
});

test('asset selection picks the new-style archive of the requested format and SHA256SUMS.txt', () => {
  const rel = release('v1.2.0');
  assert.equal(selectAssets(rel, 'tar.gz').archive.name, 'foundry-world-backup-1.2.0-linux.tar.gz');
  assert.equal(selectAssets(rel, 'zip').archive.name, 'foundry-world-backup-1.2.0-windows.zip');
  assert.equal(selectAssets(rel, 'zip').sums.name, 'SHA256SUMS.txt');
  assert.throws(() => selectAssets({ ...rel, assets: rel.assets.slice(1) }, 'tar.gz'), /no asset/);
  assert.throws(() => selectAssets({ ...rel, assets: rel.assets.slice(0, 2) }, 'tar.gz'), /SHA256SUMS\.txt/);
  assert.throws(() => selectAssets(rel, 'exe'), /unknown archive format/);
});

test('asset selection does not fall back to other archive names', () => {
  const old = release('v1.1.1');
  old.assets = old.assets.slice(3);
  assert.deepEqual(old.assets.map((a) => a.name), legacyNames('1.1.1'));
  assert.throws(() => selectAssets(old, 'tar.gz'), /no asset foundry-world-backup-1\.1\.1-linux\.tar\.gz; nothing installed/);
  assert.throws(() => selectAssets(old, 'zip'), /no asset foundry-world-backup-1\.1\.1-windows\.zip/);
});

test('check: only a strictly newer, non-prerelease release is an update', async () => {
  const cases = [
    [release('v1.1.0'), '1.0.0', true],
    [release('v1.0.0'), '1.0.0', false],
    [release('v0.9.0'), '1.0.0', false],
    [release('v1.1.0', { prerelease: true }), '1.0.0', false],
    [release('v1.1.0', { draft: true }), '1.0.0', false],
    [release('v1.1.0-rc.1'), '1.0.0', false],
  ];
  for (const [rel, installed, newer] of cases) {
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => json(rel) }), log: () => {} });
    const r = await u.check(installed);
    assert.equal(r.newer, newer, `${rel.tag_name} vs ${installed}`);
  }
});

test('check: the release lookup carries the token, and errors are reported without it', async () => {
  const f = mockFetch({ [LATEST]: () => json(release('v1.0.0')) });
  await createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} }).check('1.0.0');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(f.calls[0].init.signal, 'request has a timeout signal');

  for (const [status, re] of [
    [404, /HTTP 404/],
    [401, /HTTP 401/],
  ]) {
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => json({}, status) }) });
    await assert.rejects(u.check('1.0.0'), (err) => re.test(err.message) && !err.message.includes(TOKEN));
  }
  const bad = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => new Response('not json') }) });
  await assert.rejects(bad.check('1.0.0'), /invalid JSON/);
});

test('check: without a token the release lookup has no Authorization header (the repository is public)', async () => {
  for (const token of [undefined, '']) {
    const f = mockFetch({ [LATEST]: () => json(release('v1.1.0')) });
    const r = await createUpdater({ token, fetchImpl: f, log: () => {} }).check('1.0.0');
    assert.equal(r.newer, true);
    assert.equal(f.calls.length, 1);
    assert.ok(!('Authorization' in f.calls[0].init.headers), 'no Authorization header without a token');
    assert.equal(f.calls[0].init.headers['User-Agent'], 'foundry-world-backup-updater');
  }
  const missing = createUpdater({ fetchImpl: mockFetch({ [LATEST]: () => json({}, 404) }), log: () => {} });
  await assert.rejects(missing.check('1.0.0'), (err) => /no published release found \(HTTP 404\)/.test(err.message) && !/token/.test(err.message));
});

test('check: a token GitHub refuses (401) is dropped and the lookup is repeated without it', async () => {
  const logs = [];
  const f = mockFetch({ [LATEST]: (init) => (init.headers.Authorization ? json({ message: 'Bad credentials' }, 401) : json(release('v1.1.0'))) });
  const r = await createUpdater({ token: TOKEN, fetchImpl: f, log: (l) => logs.push(l) }).check('1.0.0');
  assert.equal(r.newer, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!('Authorization' in f.calls[1].init.headers));
  assert.match(logs.join('\n'), /refused the token \(HTTP 401\); continuing without a token/);
  assert.ok(!logs.join('\n').includes(TOKEN));
});

test('check: a used-up rate limit (403 / 429) gives a clear error', async () => {
  const limited = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' };
  let u = createUpdater({ fetchImpl: mockFetch({ [LATEST]: () => json({ message: 'API rate limit exceeded' }, 403, limited) }), log: () => {} });
  await assert.rejects(u.check('1.0.0'), (err) =>
    /rate limit for requests without a token \(60 an hour per IP address\) is used up \(HTTP 403\)/.test(err.message) &&
    /resets at 2026-01-01T00:00:00\.000Z/.test(err.message) && /UPDATER_GITHUB_TOKEN/.test(err.message));
  u = createUpdater({ fetchImpl: mockFetch({ [LATEST]: () => json({ message: 'slow down' }, 429) }), log: () => {} });
  await assert.rejects(u.check('1.0.0'), /rate limit .*is used up \(HTTP 429\); try again later/);
  u = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => json({}, 403, limited) }), log: () => {} });
  await assert.rejects(u.check('1.0.0'), (err) => /GitHub's rate limit is used up \(HTTP 403\)/.test(err.message) && !err.message.includes(TOKEN));
  // a 403 that is not the rate limit stays a plain HTTP error
  u = createUpdater({ fetchImpl: mockFetch({ [LATEST]: () => json({}, 403) }), log: () => {} });
  await assert.rejects(u.check('1.0.0'), (err) => err.message === 'release lookup failed (HTTP 403)');
  // the asset download reports it the same way
  const { rel, routes } = releaseRoutes('v1.1.0', Buffer.from('x'));
  routes[rel.assets[2].url] = () => json({}, 429);
  const dir = tmpdir();
  u = createUpdater({ fetchImpl: mockFetch(routes), log: () => {} });
  await assert.rejects(u.download(rel, 'tar.gz', dir), /download of SHA256SUMS\.txt: GitHub's rate limit .*\(HTTP 429\)/);
  fs.rmSync(dir, { recursive: true });
});

test('download: redirect is followed without the token and the checksum is verified', async () => {
  const archive = Buffer.from('fake archive contents');
  const { rel, routes } = releaseRoutes('v1.1.0', archive);
  const f = mockFetch(routes);
  const dir = tmpdir();
  const file = await createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} }).download(rel, 'tar.gz', dir);
  assert.equal(path.basename(file), 'foundry-world-backup-1.1.0-linux.tar.gz');
  assert.deepEqual(fs.readFileSync(file), archive);

  for (const call of f.calls) {
    const auth = call.init.headers?.Authorization;
    if (call.url.startsWith(`${API}/`)) assert.equal(auth, `Bearer ${TOKEN}`);
    else assert.equal(auth, undefined, `no token sent to ${call.url}`);
    assert.ok(call.init.signal, `timeout on ${call.url}`);
  }
  const assetCall = f.calls.find((c) => c.url === rel.assets[0].url);
  assert.equal(assetCall.init.headers.Accept, 'application/octet-stream');
  assert.equal(assetCall.init.redirect, 'manual');
  fs.rmSync(dir, { recursive: true });
});

test('download without a token: no Authorization header anywhere, the checksum is still verified', async () => {
  const archive = Buffer.from('public archive contents');
  const { rel, routes } = releaseRoutes('v1.1.0', archive);
  const f = mockFetch(routes);
  const dir = tmpdir();
  const file = await createUpdater({ fetchImpl: f, log: () => {} }).download(rel, 'tar.gz', dir);
  assert.deepEqual(fs.readFileSync(file), archive);
  assert.ok(f.calls.length >= 4);
  for (const call of f.calls) assert.equal(call.init.headers?.Authorization, undefined, `no Authorization header to ${call.url}`);
  const { rel: rel2, routes: routes2 } = releaseRoutes('v1.1.0', Buffer.from('tampered'), { sumsFor: Buffer.from('original') });
  const dir2 = tmpdir();
  await assert.rejects(createUpdater({ fetchImpl: mockFetch(routes2), log: () => {} }).download(rel2, 'tar.gz', dir2), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(dir2), []);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(dir2, { recursive: true });
});

test('download: a checksum mismatch is refused and nothing is written', async () => {
  const { rel, routes } = releaseRoutes('v1.1.0', Buffer.from('tampered'), { sumsFor: Buffer.from('original') });
  const dir = tmpdir();
  const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
  await assert.rejects(u.download(rel, 'tar.gz', dir), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

test('download: missing SHA256SUMS.txt entry, non-HTTPS redirect, oversized body and foreign asset URLs are refused', async () => {
  const dir = tmpdir();
  const archive = Buffer.from('x');

  // zip has a zero hash in SHA256SUMS.txt -> mismatch; drop its line entirely -> no entry.
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes['https://objects.example/signed-sums'] = () => new Response(`${sha(archive)}  other.tar.gz\n`);
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /no entry/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes[rel.assets[0].url] = () => redirect('http://objects.example/plain-http');
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /non-HTTPS/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes['https://objects.example/signed-archive'] = () =>
      new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } });
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /too large/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    const big = new ReadableStream({
      /** Feed one MiB per read so the download test exercises the streamed size limit. */
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    routes['https://objects.example/signed-archive'] = () => new Response(big);
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /too large/);
  }
  {
    const rel = release('v1.1.0');
    rel.assets[2].url = 'https://evil.example/steal';
    const f = mockFetch({});
    const u = createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /unexpected asset URL/);
    assert.equal(f.calls.length, 0);
  }
  {
    // Asset URLs must be under the repo's current name; the pre-rename name is refused, not followed.
    const rel = release('v1.1.0');
    rel.assets[2].url = `${API}/repos/dxcufgb/FoundryVTT-Realese-backup/releases/assets/102`;
    const f = mockFetch({});
    const u = createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /unexpected asset URL/);
    assert.equal(f.calls.length, 0);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

/** Create a temporary install containing version and token fixtures; the caller must remove it. */
function fakeInstall(version) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'token'), `GITHUB_TOKEN=${TOKEN}\nPORT=8787\n`);
  return dir;
}

test('cli: --check reports and exits 0 when current, 10 when newer; never prints the token', async () => {
  const dir = fakeInstall('1.0.0');
  const out = [];
  /** Collect CLI output for assertions without writing it to the console. */
  const log = (l) => out.push(l);
  const args = ['--check', '--app-dir', dir, '--token-file', path.join(dir, 'token')];

  let f = mockFetch({ [LATEST]: () => json(release('v1.0.0')) });
  assert.equal(await main(args, { env: {}, fetchImpl: f, log }), EXIT_CURRENT);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);

  f = mockFetch({ [LATEST]: () => json(release('v1.0.1')) });
  assert.equal(await main(args, { env: {}, fetchImpl: f, log }), EXIT_UPDATE);
  assert.equal(f.calls.length, 1, '--check does not download');
  assert.match(out.join('\n'), /update available: 1\.0\.0 -> 1\.0\.1/);
  assert.ok(!out.join('\n').includes(TOKEN));
  fs.rmSync(dir, { recursive: true });
});

test('cli: --download writes the verified archive and prints its path', async () => {
  const dir = fakeInstall('1.0.0');
  const outDir = tmpdir();
  const archive = Buffer.from('release archive');
  const { routes } = releaseRoutes('v1.1.0', archive);
  const out = [];
  const code = await main(['--download', outDir, '--app-dir', dir, '--format', 'tar.gz'], {
    env: { UPDATER_GITHUB_TOKEN: TOKEN },
    fetchImpl: mockFetch(routes),
    log: (l) => out.push(l),
  });
  assert.equal(code, EXIT_UPDATE);
  const file = path.join(outDir, 'foundry-world-backup-1.1.0-linux.tar.gz');
  assert.ok(out.includes(`ARCHIVE=${file}`));
  assert.ok(out.includes('VERSION=1.1.0'));
  assert.deepEqual(fs.readFileSync(file), archive);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outDir, { recursive: true });
});

test('cli: errors exit 1 with a message that never contains the token', async () => {
  const dir = fakeInstall('1.0.0');
  const errors = [];
  const orig = console.error;
  console.error = (l) => errors.push(l);
  try {
    const f = mockFetch({ [LATEST]: () => json({ message: 'Bad credentials' }, 401) });
    const args = ['--check', '--app-dir', dir, '--token-file', path.join(dir, 'token')];
    assert.equal(await main(args, { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
    assert.equal(await main(['--bogus'], { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
    // a token file that exists but cannot be read (here: a folder) is an error
    const unreadable = ['--check', '--app-dir', dir, '--token-file', dir];
    assert.equal(await main(unreadable, { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 3);
  assert.match(errors[0], /HTTP 401/);
  assert.match(errors[2], /cannot read token file/);
  assert.ok(errors.every((e) => !e.includes(TOKEN)));
  fs.rmSync(dir, { recursive: true });
});

test('cli: without a token (none given, a missing token file or a placeholder) it checks and downloads anonymously', async () => {
  const dir = fakeInstall('1.0.0');
  fs.writeFileSync(path.join(dir, 'env'), 'GITHUB_TOKEN=REPLACE_ME\nPORT=8787\n');
  const out = [];
  const log = (l) => out.push(l);
  for (const extra of [[], ['--token-file', path.join(dir, 'nope')], ['--token-file', path.join(dir, 'env')]]) {
    const f = mockFetch({ [LATEST]: () => json(release('v1.0.1')) });
    assert.equal(await main(['--check', '--app-dir', dir, ...extra], { env: {}, fetchImpl: f, log }), EXIT_UPDATE);
    assert.ok(!('Authorization' in f.calls[0].init.headers), `no Authorization header (${extra.join(' ') || 'no token file'})`);
  }
  assert.match(out.join('\n'), /no token file .*nope; asking GitHub without a token/);
  const outDir = tmpdir();
  const archive = Buffer.from('anonymous download');
  const { routes } = releaseRoutes('v1.1.0', archive);
  const f = mockFetch(routes);
  assert.equal(await main(['--download', outDir, '--app-dir', dir, '--format', 'tar.gz'], { env: {}, fetchImpl: f, log }), EXIT_UPDATE);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'foundry-world-backup-1.1.0-linux.tar.gz')), archive);
  assert.ok(f.calls.every((c) => c.init.headers?.Authorization === undefined));
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outDir, { recursive: true });
});

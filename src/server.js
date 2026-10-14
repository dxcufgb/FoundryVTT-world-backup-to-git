'use strict';
// The Foundry world backup service: scans the worlds of a Foundry VTT installation, backs each one up to its own
// private GitHub repository on a schedule (src/backup.js, src/scheduler.js) and serves the administration page
// (src/admin.js) on the admin port, HTTPS with a self-signed certificate by default. No dependencies: built-in
// http, https, fs and fetch only, plus the git command.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAdmin, loadAdminSettings, rewriteFile, replaceEnvValue, tokenKind, SettingsError } = require('./admin.js');
const { loadConfig, parseConfig, serializeConfig, worldRepo, effectiveSettings, ConfigError } = require('./config.js');
const { createBackups } = require('./backup.js');
const { createScheduler } = require('./scheduler.js');
const { createGithub, foundryStatus, GithubError } = require('./github.js');
const { createSelfSigned, defaultNames } = require('./selfsigned.js');
const { REPO: SERVICE_REPO, compareVersions, parseVersion } = require('./updater.js');
const { notify } = require('./notify.js');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_ADMIN_PORT = 8484;
// The version of this copy: the release build stamps the release's version into package.json.
const SERVICE_VERSION = require('../package.json').version;
// Windows: the SYSTEM task "Update now" starts (install-service.ps1 lets LOCAL SERVICE run it, nothing more).
const TASK_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * "Update now" on Linux: rewrite the request file in place (root-owned systemd path unit watches it and starts
 * the root update run; root never reads what is written). problem() => '' when the service may write it.
 */
function fileUpdateTrigger(file) {
  return {
    async problem() {
      try {
        fs.closeSync(fs.openSync(file, 'r+'));
        return '';
      } catch (err) {
        return err.code === 'ENOENT'
          ? `${file} is missing; re-run the installer of this version to set up "Update now"`
          : `the service's account may not write ${file} (${err.code || err.message}); re-run the installer of this version`;
      }
    },
    async request() {
      rewriteFile(file, `${new Date().toISOString()}\n`);
    },
  };
}

/** "Update now" on Windows: start the installer's SYSTEM task (no arguments can be passed to it). */
function taskUpdateTrigger(taskName, run = execFile) {
  if (!TASK_NAME_RE.test(taskName)) throw new ConfigError(`invalid UPDATE_TASK "${taskName}"`);
  const schtasks = (args) => new Promise((resolve, reject) => {
    run('schtasks.exe', args, { windowsHide: true, timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
  });
  return {
    async problem() {
      try {
        await schtasks(['/Query', '/TN', taskName]);
        return '';
      } catch {
        return `the scheduled task ${taskName} is missing or the service may not run it; re-run the installer of this version`;
      }
    },
    async request() {
      await schtasks(['/Run', '/TN', taskName]);
    },
  };
}

/**
 * The service. config: the parsed config.json; token: the GitHub token; configFile / envFile / adminFile: the
 * settings files (the admin page rewrites them in place); admin: { file, settings, hosts, trustProxy } turns the
 * admin page on; dataDir: FOUNDRY_DATA; stateDir: where repos/ and status.json live; foundryUrl: Foundry's address
 * for /api/status from FOUNDRY_URL (config.json's foundry.url, set on the admin page, wins); updateTrigger: "Update now". fetchImpl / run / log / mailer / now are injected by the tests.
 */
function createApp({
  config,
  token,
  configFile,
  envFile,
  adminFile,
  admin,
  dataDir,
  stateDir,
  foundryUrl = '',
  gitBin = 'git',
  remoteUrl,
  updateTrigger,
  version = SERVICE_VERSION,
  fetchImpl = fetch,
  run,
  log = console.log,
  mailer,
  now = () => new Date(),
  env = process.env,
}) {
  let currentConfig = config;
  let currentToken = token;
  let owner = null; // the token's GitHub login once confirmed
  const github = createGithub({ fetchImpl });
  // Foundry's address in use: the one saved on the admin page (config.json), else FOUNDRY_URL; '' = never ask.
  const currentFoundryUrl = () => (currentConfig.foundry.url !== null ? currentConfig.foundry.url : foundryUrl);

  /** The Foundry check of "Test setup" and the Foundry page: { status, message, world? }. */
  async function checkFoundry(url = currentFoundryUrl()) {
    if (!url) return { status: 'warn', message: 'no address set: active worlds cannot be detected (backups still run)' };
    const f = await foundryStatus(url, fetchImpl);
    if (!f.reachable) {
      return { status: 'warn', message: `${url} did not answer /api/status (${f.problem}); active worlds cannot be detected (backups still run)` };
    }
    return { status: 'ok', world: f.active ? f.world : null,
      message: f.active ? `reachable at ${url}, world "${f.world}" is active` : `reachable at ${url}, no world active` };
  }

  async function mail(subject, message) {
    if (!adminFile) return log('notify: no admin.json, so nobody to e-mail');
    await notify({ 'admin-file': adminFile, subject, message }, { mailer, log: (l) => log(l) });
  }

  const backups = createBackups({
    dataDir,
    stateDir,
    getFoundryUrl: currentFoundryUrl,
    gitBin,
    remoteUrl: remoteUrl || undefined,
    getConfig: () => currentConfig,
    getToken: () => currentToken,
    getOwner: () => owner,
    notify: mail,
    run: run || undefined,
    fetchImpl,
    now,
    log,
    env,
  });
  const scheduler = createScheduler({ backups, getConfig: () => currentConfig, now, log });

  // Where a token set on the admin page goes: the GITHUB_TOKEN line of envFile, rewritten in place. '' = it can.
  function tokenStorageProblem() {
    if (!envFile) return 'no env file (set ENV_FILE)';
    let text;
    try {
      text = fs.readFileSync(envFile, 'utf8');
    } catch (err) {
      return `cannot read it (${err.code || err.message})`;
    }
    if (replaceEnvValue(text, 'GITHUB_TOKEN', 'x') === null) return 'it has no GITHUB_TOKEN line';
    try {
      // Opening for writing (nothing is written) is the real test: systemd's read-only mounts, Windows ACLs.
      fs.closeSync(fs.openSync(envFile, 'r+'));
    } catch (err) {
      return `the service's account may not write it (${err.code || err.message}); re-run the installer of this version`;
    }
    return '';
  }

  /** GET /user with the token in use; remembers the login (the owner of the world repositories). */
  async function confirmOwner() {
    if (!currentToken) return null;
    const r = await github.checkToken(currentToken);
    if (r.login) owner = r.login;
    return r;
  }

  /** The world repository check of "Test setup" and the daily check. */
  async function checkWorldRepo(world, tok, tokenOwner) {
    const repo = worldRepo(currentConfig, world.id, tokenOwner);
    const base = { kind: 'world', name: world.title, id: world.id, repo };
    if (!tokenOwner) return { ...base, status: 'bad', message: 'cannot tell: GitHub did not say whose token this is' };
    let info;
    try {
      info = await github.repoInfo(repo, tok);
    } catch (err) {
      if (err instanceof GithubError) return { ...base, status: 'bad', unreachable: err.status === 'network', message: err.message };
      throw err;
    }
    if (info.exists) {
      if (!info.canPush) return { ...base, status: 'bad', message: 'exists, but the token may not push to it (Contents: read and write)' };
      if (!info.private) return { ...base, status: 'warn', message: 'exists and the token may push, but it is PUBLIC' };
      return { ...base, status: 'ok', message: 'exists (private), the token may push' };
    }
    const [repoOwner] = repo.split('/');
    if (!currentConfig.github.createRepos) return { ...base, status: 'bad', message: 'does not exist and "create repositories" is off' };
    if (repoOwner.toLowerCase() !== tokenOwner.toLowerCase()) {
      return { ...base, status: 'bad', message: `does not exist and is not under the token's account (${tokenOwner}), so it cannot be created` };
    }
    return { ...base, status: 'warn', message: 'does not exist yet: it is created (private) on the first backup' };
  }

  // "Test setup": the token, git, the data folder, Foundry, the service's own repository and every world's repository.
  async function testSetup(tok = currentToken) {
    const tokenResult = await github.checkToken(tok);
    const checks = [];
    const gitProblem = await backups.gitProblem();
    checks.push({ kind: 'git', name: 'git', status: gitProblem ? 'bad' : 'ok', message: gitProblem || 'found' });
    let worlds = [];
    try {
      worlds = backups.worlds({ fresh: true });
      const unreadable = worlds.filter((w) => !w.readable);
      checks.push({ kind: 'data', name: 'Foundry data folder', status: unreadable.length ? 'bad' : 'ok',
        message: `${dataDir}: ${worlds.length} world(s)` + (unreadable.length ? `, ${unreadable.length} not readable (${unreadable.map((w) => w.id).join(', ')})` : '') });
    } catch (err) {
      checks.push({ kind: 'data', name: 'Foundry data folder', status: 'bad', message: err.message });
    }
    try {
      fs.accessSync(stateDir, fs.constants.W_OK);
      checks.push({ kind: 'state', name: 'State folder', status: 'ok', message: `${stateDir} is writable` });
    } catch (err) {
      checks.push({ kind: 'state', name: 'State folder', status: 'bad', message: `${stateDir} is not writable (${err.code || err.message})` });
    }
    if (currentFoundryUrl()) {
      const { status, message } = await checkFoundry();
      checks.push({ kind: 'foundry', name: 'Foundry', status, message });
    }
    if (tokenResult.status === 'bad') return { token: tokenResult, checks };
    const tokenOwner = tokenResult.login || null;
    if (tok === currentToken && tokenOwner) owner = tokenOwner;
    const service = github.repoInfo(SERVICE_REPO, tok).then(
      (r) => ({ kind: 'service', name: 'Automatic updates', repo: SERVICE_REPO,
        ...(r.exists ? { status: 'ok', message: 'the token can read the release repository' }
          : { status: 'warn', message: 'the token cannot see the release repository; automatic updates need it unless they have their own updater token' }) }),
      (err) => ({ kind: 'service', name: 'Automatic updates', repo: SERVICE_REPO, status: 'warn', message: err.message }),
    );
    const repos = worlds.filter((w) => effectiveSettings(currentConfig, w.id).enabled).map((w) => checkWorldRepo(w, tok, tokenOwner));
    checks.push(...(await Promise.all([service, ...repos])));
    return { token: tokenResult, checks };
  }

  // The daily token check: a token GitHub refuses or that expires soon is mailed every day it lasts, and once more
  // when it is fine again (backups themselves mail their own failures).
  let failing = false;
  async function runDailyCheck() {
    const r = await confirmOwner();
    const problem = r && r.status !== 'ok' ? r.message : '';
    log(problem ? `daily check: GitHub token: ${problem}` : 'daily check: token OK');
    try {
      if (problem) {
        await mail('GitHub token problem', `The daily check of the Foundry world backup found a problem with the GitHub token:\n\n${problem}\n\n` +
          'Backups fail until it is fixed. Paste a new token on the administration page.\n');
      } else if (failing) {
        await mail('GitHub token OK again', 'The daily check of the Foundry world backup finds the GitHub token fine again.\n');
      }
    } catch (err) {
      log(`daily check: e-mail not sent (${err.message})`);
    }
    failing = Boolean(problem);
    return problem;
  }

  function startDailyChecks({ firstDelayMs = HOUR_MS, intervalMs = DAY_MS } = {}) {
    let timer = null;
    const schedule = (ms) => {
      timer = setTimeout(async () => {
        try {
          await runDailyCheck();
        } catch (err) {
          log(`daily check: failed (${err.message})`);
        }
        if (timer) schedule(intervalMs);
      }, ms);
      timer.unref();
    };
    schedule(firstDelayMs);
    return () => {
      clearTimeout(timer);
      timer = null;
    };
  }

  // "Update now": the installed version, the latest release the token can see, and the trigger.
  const serviceUpdate = {
    version,
    async info() {
      const out = { installed: version, latest: null, newer: null, latestProblem: '', canUpdate: false, problem: '' };
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${SERVICE_REPO}/releases/latest`, {
          signal: AbortSignal.timeout(20000),
          headers: { Authorization: `Bearer ${currentToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'foundry-world-backup' },
        });
        if (res.status === 404) {
          await res.body?.cancel?.();
          out.latestProblem = `the token cannot see ${SERVICE_REPO} (the updater may have a token of its own)`;
        } else if (!res.ok) {
          await res.body?.cancel?.();
          out.latestProblem = `GitHub request failed (${res.status})`;
        } else {
          const release = await res.json();
          out.latest = String(release.tag_name || '').replace(/^v/, '');
          if (parseVersion(out.latest) && parseVersion(version)) out.newer = compareVersions(out.latest, version) > 0;
        }
      } catch (err) {
        out.latestProblem = `GitHub request failed (${err.name === 'TimeoutError' ? 'timeout' : err.message})`;
      }
      out.problem = await serviceUpdate.problem();
      out.canUpdate = !out.problem;
      return out;
    },
    // '' when "Update now" can be used here.
    problem: async () => (updateTrigger ? updateTrigger.problem() : 'not set up on this machine (the installers set it up)'),
    async request() {
      if (!updateTrigger) throw new Error('not set up on this machine');
      await updateTrigger.request();
    },
  };

  const githubToken = {
    info: () => ({ kind: tokenKind(currentToken || ''), file: envFile || null, problem: tokenStorageProblem(), owner }),
    check: (tok) => github.checkToken(tok),
    test: testSetup,
    save(tok, login) {
      const text = replaceEnvValue(fs.readFileSync(envFile, 'utf8'), 'GITHUB_TOKEN', tok);
      if (text === null) throw new Error('no GITHUB_TOKEN line');
      rewriteFile(envFile, text);
      currentToken = tok;
      if (login) owner = login;
    },
  };

  const adminPage = admin && createAdmin({
    adminFile: admin.file,
    settings: admin.settings,
    extraHosts: admin.hosts,
    trustProxy: admin.trustProxy || [],
    log,
    mailer,
    backups,
    scheduler,
    getConfig: () => currentConfig,
    saveConfig: (raw) => {
      const parsed = parseConfig(JSON.stringify(raw), 'admin');
      rewriteFile(configFile, serializeConfig(parsed));
      currentConfig = parsed;
    },
    githubToken,
    serviceUpdate,
    foundry: { defaultUrl: foundryUrl, url: currentFoundryUrl, test: checkFoundry },
    paths: { dataDir, stateDir },
    now: () => now().getTime(),
  });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  // The admin listener serves the admin page only; "/" leads to it.
  async function adminRoute(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://backup').pathname;
    } catch {
      return send(res, 404, 'not found');
    }
    if (pathname === '/') return send(res, 302, 'see /_admin/', { Location: '/_admin/' });
    if (adminPage && adminPage.handles(pathname)) return adminPage.handle(req, res, pathname);
    return send(res, 404, 'not found');
  }

  // Runs a route handler, turning a thrown/rejected error into the 500 response.
  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((err) => {
      log(`internal error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    });
  };

  // tls { cert, key }: HTTPS on the admin port, where a plain-HTTP request gets a redirect to https:// (like Webmin);
  // no tls: plain HTTP (behind a reverse proxy that does HTTPS).
  function createAdminServer(tls) {
    if (!tls) return http.createServer(wrap(adminRoute));
    const secure = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, wrap(adminRoute));
    const redirect = http.createServer((req, res) => {
      const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : null;
      if (!host) return send(res, 400, 'use https://');
      return send(res, 301, 'use https://', { Location: `https://${host}/_admin/` });
    });
    // A TLS connection starts with a handshake record (0x16); anything else is plain HTTP.
    const front = net.createServer((socket) => {
      socket.once('data', (first) => {
        socket.pause();
        socket.unshift(first);
        (first[0] === 0x16 ? secure : redirect).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
      socket.on('error', () => socket.destroy());
      socket.setTimeout(30000, () => socket.destroy());
    });
    front.on('close', () => {
      secure.close();
      redirect.close();
    });
    return front;
  }

  return {
    backups,
    scheduler,
    createAdminServer,
    confirmOwner,
    runDailyCheck,
    startDailyChecks,
    testSetup,
    serviceUpdate,
    githubToken,
    getConfig: () => currentConfig,
    getOwner: () => owner,
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Certificate for the admin port: ADMIN_TLS_CERT/ADMIN_TLS_KEY (default admin-tls.crt/.key next to config.json, made
// by the installers). Without those files a temporary self-signed one is made (it changes on every restart).
function adminTls(env, configFile, extraNames) {
  const dir = path.dirname(configFile);
  const certFile = env.ADMIN_TLS_CERT || path.join(dir, 'admin-tls.crt');
  const keyFile = env.ADMIN_TLS_KEY || path.join(dir, 'admin-tls.key');
  try {
    return { tls: { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, note: `certificate ${certFile}` };
  } catch (err) {
    if (env.ADMIN_TLS_CERT || env.ADMIN_TLS_KEY) {
      throw new ConfigError(`cannot read ADMIN_TLS_CERT / ADMIN_TLS_KEY (${err.message})`);
    }
    return {
      tls: createSelfSigned(defaultNames(extraNames)),
      note: `temporary self-signed certificate (no ${certFile}; it changes on every restart)`,
    };
  }
}

/** Reads the environment (see .env.example), validates it and returns everything main() needs. Throws ConfigError. */
function readEnv(env) {
  const token = env.GITHUB_TOKEN || '';
  const dataDir = env.FOUNDRY_DATA;
  if (!dataDir) throw new ConfigError('FOUNDRY_DATA is not set (the Foundry user data folder)');
  const configFile = env.CONFIG_FILE || './config.json';
  const adminFile = env.ADMIN_FILE || path.join(path.dirname(configFile), 'admin.json');
  const envFile = env.ENV_FILE || path.join(path.dirname(configFile), 'env');
  const stateDir = env.STATE_DIR || path.join(path.dirname(configFile), 'state');
  const foundryUrl = env.FOUNDRY_URL === undefined ? 'http://localhost:30000' : env.FOUNDRY_URL;
  if (foundryUrl) {
    try {
      new URL(foundryUrl);
    } catch {
      throw new ConfigError(`invalid FOUNDRY_URL "${foundryUrl}" (empty turns the active-world check off)`);
    }
  }
  const adminPort = env.ADMIN_PORT === undefined || env.ADMIN_PORT === '' ? DEFAULT_ADMIN_PORT : Number(env.ADMIN_PORT);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) throw new ConfigError(`invalid ADMIN_PORT "${env.ADMIN_PORT}"`);
  const adminHost = env.ADMIN_HOST || '0.0.0.0';
  const hosts = (env.ADMIN_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (adminHost !== '0.0.0.0' && adminHost !== '::') hosts.push(adminHost);
  if (env.ADMIN_PUBLIC_URL) {
    try {
      hosts.push(new URL(env.ADMIN_PUBLIC_URL).hostname);
    } catch {
      throw new ConfigError(`invalid ADMIN_PUBLIC_URL "${env.ADMIN_PUBLIC_URL}"`);
    }
  }
  // ADMIN_TRUST_PROXY: 1 = a reverse proxy on this machine; or the proxies' addresses, comma separated.
  let trustProxy = [];
  const tp = (env.ADMIN_TRUST_PROXY || '').trim().toLowerCase();
  if (tp === '1' || tp === 'true' || tp === 'yes') trustProxy = ['loopback'];
  else if (tp && !/^(0|false|no)$/.test(tp)) {
    trustProxy = tp.split(',').map((a) => a.trim()).filter(Boolean);
    const bad = trustProxy.find((a) => a !== 'loopback' && !net.isIP(a));
    if (bad) throw new ConfigError(`ADMIN_TRUST_PROXY: "${bad}" is not an IP address (use 1, or the proxies' addresses)`);
  }
  const tlsOff = /^(off|0|false|no)$/i.test(env.ADMIN_TLS || '');
  const dailyCheck = !/^(off|0|false|no)$/i.test(env.DAILY_CHECK || '');
  const gitBin = env.GIT_BIN || 'git';
  return { token, dataDir, configFile, adminFile, envFile, stateDir, foundryUrl, adminPort, adminHost, hosts, trustProxy, tlsOff, dailyCheck, gitBin };
}

// Reads the environment, starts the scheduler and the admin port; returns the admin server.
function main(env = process.env) {
  try {
    const e = readEnv(env);
    let adminSettings;
    try {
      adminSettings = loadAdminSettings(e.adminFile);
    } catch (err) {
      if (err instanceof SettingsError) throw new ConfigError(err.message);
      throw err;
    }
    const adminOn = Boolean(adminSettings.passwordHash);
    const config = loadConfig(e.configFile);
    fs.mkdirSync(e.stateDir, { recursive: true, mode: 0o700 });
    if (!e.token || /REPLACE_ME/.test(e.token)) console.log('WARNING: GITHUB_TOKEN is not set; backups fail until a token is pasted on the administration page');
    const updateTrigger = process.platform === 'win32'
      ? taskUpdateTrigger(env.UPDATE_TASK || 'FoundryWorldBackup-UpdateNow')
      : fileUpdateTrigger(env.UPDATE_REQUEST_FILE || path.join(path.dirname(e.configFile), 'update-request'));
    const app = createApp({
      config,
      token: /REPLACE_ME/.test(e.token) ? '' : e.token,
      configFile: e.configFile,
      envFile: e.envFile,
      adminFile: e.adminFile,
      admin: adminOn ? { file: e.adminFile, settings: adminSettings, hosts: e.hosts, trustProxy: e.trustProxy } : undefined,
      dataDir: e.dataDir,
      stateDir: e.stateDir,
      foundryUrl: e.foundryUrl,
      gitBin: e.gitBin,
      updateTrigger,
    });
    const tls = adminOn && !e.tlsOff ? adminTls(env, e.configFile, e.hosts) : undefined;
    const adminServer = app.createAdminServer(tls && tls.tls);
    adminServer.on('error', (err) => {
      console.error(`admin port ${e.adminHost}:${e.adminPort}: ${err.message}`);
      process.exit(1);
    });
    adminServer.listen(e.adminPort, e.adminHost, () => {
      const scheme = tls ? 'https' : 'http';
      console.log(`foundry-world-backup ${SERVICE_VERSION}: worlds in ${e.dataDir}, state in ${e.stateDir}`);
      console.log(adminOn
        ? `admin page: ${scheme}://${e.adminHost}:${e.adminPort}/ (${tls ? tls.note : 'plain HTTP'})`
        : `admin page off (no password in ${e.adminFile}); backups still run on the schedule in ${e.configFile}`);
      if (adminOn && !tls && !LOOPBACK.has(e.adminHost) && !e.trustProxy.length) {
        console.log('WARNING: ADMIN_TLS=off on a network address: the admin password crosses the network unencrypted');
      }
    });
    app.confirmOwner().then((r) => {
      if (r) console.log(r.status === 'bad' ? `GitHub token: ${r.message}` : `GitHub token ${r.message}`);
    }).catch((err) => console.log(`GitHub token check failed: ${err.message}`));
    app.backups.gitProblem().then((p) => {
      if (p) console.log(`WARNING: ${p}`);
    });
    app.scheduler.start();
    if (e.dailyCheck) app.startDailyChecks();
    console.log(e.dailyCheck ? 'daily token check on (problems are e-mailed to the recipients in admin.json)' : 'daily token check off (DAILY_CHECK)');
    return adminServer;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`foundry-world-backup: refusing to start: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { createApp, readEnv, fileUpdateTrigger, taskUpdateTrigger, adminTls, ConfigError, DEFAULT_ADMIN_PORT };

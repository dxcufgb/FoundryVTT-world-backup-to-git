'use strict';
// The administration page's API through createApp(): login and sessions, the worlds list, per-world and global
// settings written to config.json, "Back up now" with the real git command (pushing to a local repository), the
// GitHub token, "Test setup", notifications, the mailer against a fake SMTP server, the password and "Update now".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createApp, readEnv, fileUpdateTrigger, taskUpdateTrigger, ConfigError } = require('../src/server.js');
const {
  hashPassword,
  verifyPassword,
  parseAdminSettings,
  serializeAdminSettings,
  defaultNotify,
  setup,
} = require('../src/admin.js');
const { parseConfig } = require('../src/config.js');
const { sendMail, buildMessage, encodeHeader, isEmail, smtpProblem } = require('../src/mailer.js');
const { notify, parseEnvFile, adminFileFromEnv } = require('../src/notify.js');

const API = 'https://api.github.com';
const TOKEN = 'ghp_testtoken_not_real_0123456789';
const NEW_TOKEN = `github_pat_${'N'.repeat(40)}`;
const BAD_TOKEN = `github_pat_${'B'.repeat(40)}`;
const PASSWORD = 'correct horse battery';
const SMTP_SECRET = 'smtp-secret-pw';
const SERVICE_REPO = 'dxcufgb/FoundryVTT-world-backup-to-git';

function tmpDir(name = 'admin') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fwb-${name}-`));
}

function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

let hashCache;
async function passwordHash() {
  hashCache = hashCache || (await hashPassword(PASSWORD));
  return hashCache;
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

// A fake GitHub: `tokens` maps a token to its owner's login (unknown tokens get 401); `repos[owner/name]` =
// { private, push } for world repositories, { tag } for the service's release repository; `expires` is the expiry
// header GitHub would send; POST /user/repos creates a repository unless createStatus says otherwise.
function fakeGithub({ tokens = { [TOKEN]: 'octo' }, expires = '2099-01-01 00:00:00 UTC', repos = {}, down = false, createStatus = 201, foundry = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const auth = (init.headers && init.headers.Authorization) || '';
    seen.push({ url, auth, body: init.body });
    const json = (code, body, headers = {}) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...headers } });
    if (url.endsWith('/api/status')) {
      if (!foundry) throw new TypeError('fetch failed');
      return json(200, foundry);
    }
    if (down) throw new TypeError('fetch failed');
    const tok = auth.replace(/^Bearer /, '');
    if (!Object.hasOwn(tokens, tok)) return json(401, { message: 'Bad credentials' });
    if (url === `${API}/user`) return json(200, { login: tokens[tok] }, expires ? { 'github-authentication-token-expiration': expires } : {});
    if (url === `${API}/user/repos` && init.method === 'POST') {
      if (createStatus !== 201) return json(createStatus, { message: 'nope' });
      const body = JSON.parse(init.body);
      repos[`${tokens[tok]}/${body.name}`] = { private: true, push: true };
      return json(201, {});
    }
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(\/releases\/latest)?$/.exec(url);
    const repo = m && repos[m[1]];
    if (!repo) return json(404, { message: 'Not Found' });
    if (!m[2]) return json(200, { private: repo.private !== false, default_branch: 'main', permissions: { push: repo.push !== false } });
    if (!repo.tag) return json(404, { message: 'Not Found' });
    return json(200, { tag_name: repo.tag, assets: [] });
  };
  return { fetchImpl, seen, repos };
}

// Starts the service with config.json, admin.json and env in a temp folder, a Foundry data folder with the given
// worlds and a local bare repository per world repository standing in for GitHub; returns helpers for the admin API.
async function start({
  worlds = { alpha: { 'packs/actors.ldb': 'actors v1' }, beta: {} },
  config = '{}',
  notifySettings,
  fetchImpl,
  mailer,
  envText = `GITHUB_TOKEN=${TOKEN}\n`,
  updateTrigger,
  version = '1.4.2',
  foundryUrl = '',
  token = TOKEN,
} = {}) {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'foundry');
  for (const [id, files] of Object.entries(worlds)) {
    const folder = path.join(dataDir, 'Data', 'worlds', id);
    fs.mkdirSync(path.join(folder, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'world.json'), JSON.stringify({ title: `World ${id}`, system: 'dnd5e' }));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  }
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  const remotes = path.join(dir, 'remotes');
  fs.mkdirSync(remotes);
  const configFile = path.join(dir, 'config.json');
  const adminFile = path.join(dir, 'admin.json');
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(configFile, config);
  if (envText !== null) fs.writeFileSync(envFile, envText, { mode: 0o600 });
  const settings = { passwordHash: await passwordHash(), notify: notifySettings || defaultNotify() };
  fs.writeFileSync(adminFile, serializeAdminSettings(settings));
  const logs = [];
  const mails = [];
  const app = createApp({
    config: parseConfig(config, 'test'),
    token,
    configFile,
    envFile,
    adminFile,
    dataDir,
    stateDir,
    foundryUrl,
    remoteUrl: (repo) => {
      const r = path.join(remotes, repo.replace('/', '__'));
      if (!fs.existsSync(r)) execFileSync('git', ['init', '-q', '--bare', r]);
      return r;
    },
    updateTrigger,
    version,
    admin: { file: adminFile, settings: parseAdminSettings(fs.readFileSync(adminFile, 'utf8')), hosts: [] },
    fetchImpl: fetchImpl || (async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }),
    mailer: mailer || (async (smtp, msg) => mails.push(msg)),
    log: (line) => logs.push(line),
    env: { PATH: process.env.PATH, HOME: stateDir },
  });
  const server = app.createAdminServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  const call = async (method, route, body, extra = {}) => {
    const headers = { Cookie: cookie, ...extra };
    if (method !== 'GET') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      if (csrf && headers['X-CSRF-Token'] === undefined) headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`${url}/_admin/api/${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers, text };
  };
  const login = async (password = PASSWORD) => call('POST', 'login', { password });
  return {
    url,
    dir,
    dataDir,
    stateDir,
    configFile,
    adminFile,
    envFile,
    app,
    server,
    logs,
    mails,
    call,
    login,
    remote: (repo) => path.join(remotes, repo.replace('/', '__')),
    worldFolder: (id) => path.join(dataDir, 'Data', 'worlds', id),
    get csrf() {
      return csrf;
    },
    clearCookie() {
      cookie = '';
    },
    close: async () => {
      await app.backups.idle();
      await new Promise((r) => server.close(r));
    },
  };
}

const until = async (fn, ms = 15000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('password hashes verify and reject wrong passwords', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('s3cret-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('s3cret-password', ''), false);
  assert.notEqual(await hashPassword('s3cret-password'), hash, 'salted');
});

test('admin settings are validated', async () => {
  assert.deepEqual(parseAdminSettings('').notify.recipients, []);
  assert.throws(() => parseAdminSettings('{"x":1}'), /unknown key "x"/);
  assert.throws(() => parseAdminSettings('{"passwordHash":"plain"}'), /invalid "passwordHash"/);
  assert.throws(() => parseAdminSettings('{"passwordHash":"scrypt$99999999$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
    `${'A'.repeat(64)}"}`), /invalid "passwordHash"/);
  assert.throws(() => parseAdminSettings('{"notify":{"recipients":["a@b.c\\r\\nBcc: x@y.z"]}}'), /invalid e-mail/);
  assert.throws(() => parseAdminSettings('{"notify":{"recipients":["not-an-address"]}}'), /invalid e-mail/);
  assert.throws(
    () => parseAdminSettings('{"notify":{"smtp":{"host":"mail.example.com","port":25,"security":"none",' +
      '"user":"u","password":"p","from":"a@example.com"}}}'),
    /without TLS/,
  );
  const ok = parseAdminSettings('{"notify":{"recipients":["A@example.com","a@example.com","b@example.com"]}}');
  assert.deepEqual(ok.notify.recipients, ['A@example.com', 'b@example.com']);
});

test('the admin page is off (404) without a password and needs a login for the API', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', 'state')).status, 401);
    assert.equal((await s.call('PUT', 'settings', {})).status, 401);
    assert.equal((await fetch(`${s.url}/_admin/`)).status, 200);
    assert.equal((await fetch(`${s.url}/`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${s.url}/other`)).status, 404);
    assert.equal((await s.login('wrong')).status, 401);
  } finally {
    await s.close();
  }
  // no password hash: the page is off
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.mkdirSync(path.join(dir, 'foundry', 'Data', 'worlds'), { recursive: true });
  const app = createApp({
    config: parseConfig('{}'), token: TOKEN, configFile: path.join(dir, 'config.json'), dataDir: path.join(dir, 'foundry'),
    stateDir: dir, admin: undefined, fetchImpl: async () => { throw new Error('no'); }, log: () => {},
  });
  const server = app.createAdminServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/_admin/`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('login sets a strict HttpOnly cookie and lists the worlds with their status, size and repository', async () => {
  const s = await start();
  try {
    const res = await s.login();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /^fwb_admin=[A-Za-z0-9_-]+; Path=\/_admin; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    assert.ok(res.data.csrf);
    assert.deepEqual(res.data.worlds.map((w) => w.id), ['alpha', 'beta']);
    const alpha = res.data.worlds[0];
    assert.equal(alpha.title, 'World alpha');
    assert.equal(alpha.system, 'dnd5e');
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.lastResult, null);
    assert.equal(alpha.repo, '/foundry-world-alpha', 'the owner is not confirmed yet');
    assert.equal(alpha.folder, undefined, 'server paths stay on the server');
    assert.ok(alpha.nextRun);
    assert.equal(res.data.settings.schedule.frequency, 'daily');
    assert.equal(res.data.token.owner, null);
    assert.equal(res.data.version, '1.4.2');
    assert.ok(!res.text.includes(TOKEN));
    // sizes are summed in the background
    await until(async () => (await s.call('GET', 'state')).data.worlds[0].size !== null);
    const state = await s.call('GET', 'state');
    assert.equal(state.data.worlds[0].size, 'actors v1'.length + fs.statSync(path.join(s.worldFolder('alpha'), 'world.json')).size);
    assert.equal(state.data.busy, false);
    // a rescan picks up a new world
    fs.mkdirSync(s.worldFolder('gamma'));
    fs.writeFileSync(path.join(s.worldFolder('gamma'), 'world.json'), '{"title":"Gamma"}');
    const rescan = await s.call('POST', 'worlds/rescan', {});
    assert.deepEqual(rescan.data.worlds.map((w) => w.id), ['alpha', 'beta', 'gamma']);
  } finally {
    await s.close();
  }
});

test('world and global settings are written to config.json and validated', async () => {
  const s = await start();
  try {
    await s.login();
    let res = await s.call('PUT', 'worlds/beta', { enabled: false, repo: 'friend/shared', schedule: { frequency: 'hourly', everyHours: 2, time: '04:00', weekday: 0 }, whenActive: 'skip' });
    assert.equal(res.status, 200, res.text);
    const beta = res.data.worlds.find((w) => w.id === 'beta');
    assert.equal(beta.enabled, false);
    assert.equal(beta.repo, 'friend/shared');
    assert.equal(beta.customSchedule, true);
    assert.equal(beta.schedule.everyHours, 2);
    assert.equal(beta.whenActive, 'skip');
    assert.equal(beta.nextRun, null, 'off: no next run');
    let file = JSON.parse(fs.readFileSync(s.configFile, 'utf8'));
    assert.deepEqual(file.worlds, { beta: { enabled: false, repo: 'friend/shared', schedule: { frequency: 'hourly', time: '04:00', weekday: 0, everyHours: 2 }, whenActive: 'skip' } });
    // back to the defaults: the entry disappears
    res = await s.call('PUT', 'worlds/beta', { enabled: true, repo: '', schedule: null, whenActive: '' });
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).worlds.beta, undefined);
    // bad input changes nothing
    res = await s.call('PUT', 'worlds/beta', { repo: 'no-slash' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /repo must be owner\/name/);
    res = await s.call('PUT', 'worlds/beta', { schedule: { frequency: 'sometimes' } });
    assert.equal(res.status, 400);
    assert.equal((await s.call('PUT', 'worlds/nope', { enabled: false })).status, 404);
    assert.equal((await s.call('PUT', 'worlds/..%2Fx', { enabled: false })).status, 404);
    // the global schedule, GitHub settings and the active-world rule
    res = await s.call('PUT', 'settings', { schedule: { frequency: 'weekly', weekday: 6, time: '23:30', everyHours: 6 }, github: { repoPrefix: 'fvtt-', createRepos: false }, whenActive: 'skip' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.settings.schedule.frequency, 'weekly');
    assert.equal(res.data.settings.github.repoPrefix, 'fvtt-');
    assert.equal(res.data.worlds[0].repo, '/fvtt-alpha');
    file = JSON.parse(fs.readFileSync(s.configFile, 'utf8'));
    assert.equal(file.whenActive, 'skip');
    assert.equal(file.github.createRepos, false);
    res = await s.call('PUT', 'settings', { github: { repoPrefix: 'bad prefix' } });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).github.repoPrefix, 'fvtt-');
    assert.ok(s.logs.some((l) => /admin: settings of world beta changed/.test(l)));
    // forgetting a world removes its settings
    await s.call('PUT', 'worlds/beta', { enabled: false });
    res = await s.call('DELETE', 'worlds/beta');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).worlds.beta, undefined);
    assert.equal(res.data.worlds.find((w) => w.id === 'beta').enabled, true, 'still on disk, so back with the defaults');
  } finally {
    await s.close();
  }
});

test('"Back up now" runs a backup with git, pushes it and the page shows the result', async () => {
  const gh = fakeGithub({ repos: {} });
  const s = await start({ fetchImpl: gh.fetchImpl, worlds: { alpha: { 'packs/a.ldb': 'data' } } });
  try {
    await s.login();
    assert.equal((await s.app.confirmOwner()).login, 'octo');
    let res = await s.call('POST', 'worlds/alpha/backup', {});
    assert.equal(res.status, 202, res.text);
    const w = res.data.worlds[0];
    assert.equal(w.queued || w.running, true);
    assert.equal(res.data.busy, true);
    assert.equal((await s.call('POST', 'worlds/alpha/backup', {})).status, 409, 'already queued');
    await s.app.backups.idle();
    res = await s.call('GET', 'state');
    const done = res.data.worlds[0];
    assert.equal(done.lastResult, 'ok', done.lastError);
    assert.equal(done.repo, 'octo/foundry-world-alpha');
    assert.match(done.commit, /^[0-9a-f]{40}$/);
    assert.equal(done.changed, true);
    assert.ok(done.lastSuccess);
    assert.equal(git(s.remote('octo/foundry-world-alpha'), 'rev-parse', 'main'), done.commit);
    assert.ok(gh.seen.some((c) => c.url === `${API}/user/repos`), 'the repository was created');
    assert.ok(!fs.existsSync(path.join(s.worldFolder('alpha'), '.git')));
    assert.equal(s.mails.length, 0);
    assert.equal((await s.call('POST', 'worlds/nope/backup', {})).status, 404);
    await s.call('PUT', 'worlds/alpha', { enabled: false });
    const off = await s.call('POST', 'worlds/alpha/backup', {});
    assert.equal(off.status, 409);
    assert.match(off.data.error, /turned off/);
    assert.ok(!s.logs.join('\n').includes(TOKEN));
  } finally {
    await s.close();
  }
});

test('state-changing calls need the CSRF token, JSON and an allowed host', async () => {
  const s = await start();
  try {
    await s.login();
    let res = await s.call('PUT', 'settings', { whenActive: 'skip' }, { 'X-CSRF-Token': 'wrong' });
    assert.equal(res.status, 403);
    res = await s.call('PUT', 'settings', { whenActive: 'skip' }, { 'X-CSRF-Token': '' });
    assert.equal(res.status, 403);
    res = await s.call('PUT', 'settings', { whenActive: 'skip' }, { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 415);
    res = await s.call('PUT', 'settings', { whenActive: 'skip' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    // fetch() does not let a test set Host, http.get does (a DNS-rebinding page would send its own name)
    assert.equal(await statusWithHost(`${s.url}/_admin/`, 'evil.example'), 403);
    assert.equal(await statusWithHost(`${s.url}/_admin/`, 'localhost:8484'), 200);
    assert.equal(fs.readFileSync(s.configFile, 'utf8'), '{}', 'nothing was written');
    assert.equal((await fetch(`${s.url}/_admin/app.js`, { method: 'POST' })).status, 405);
  } finally {
    await s.close();
  }
});

test('logins are locked out after repeated failures', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.login('nope nope')).status, 401);
    assert.equal((await s.login()).status, 429);
  } finally {
    await s.close();
  }
});

test('logout ends the session', async () => {
  const s = await start();
  try {
    await s.login();
    const res = await s.call('POST', 'logout', {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await s.call('GET', 'state')).status, 401);
  } finally {
    await s.close();
  }
});

test('notification settings are saved without ever returning the SMTP password', async () => {
  const sent = [];
  const mailer = async (smtp, msg) => sent.push({ smtp, msg });
  const s = await start({ mailer });
  try {
    await s.login();
    assert.equal((await s.call('POST', 'notify/test', {})).status, 400, 'no recipients yet');
    const body = {
      recipients: ['ops@example.com', 'gm@example.org'],
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'backup', password: SMTP_SECRET,
        from: 'backup@example.com' },
    };
    let res = await s.call('PUT', 'notify', body);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.notify.recipients, body.recipients);
    assert.equal(res.data.notify.smtp.passwordSet, true);
    assert.ok(!res.text.includes(SMTP_SECRET));
    assert.equal(JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).notify.smtp.password, SMTP_SECRET);
    // an empty password keeps the stored one
    res = await s.call('PUT', 'notify', { ...body, recipients: ['ops@example.com'], smtp: { ...body.smtp, password: '' } });
    assert.equal(JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).notify.smtp.password, SMTP_SECRET);
    assert.ok(!(await s.call('GET', 'state')).text.includes(SMTP_SECRET));
    // invalid addresses are refused, header injection included
    res = await s.call('PUT', 'notify', { ...body, recipients: ['a@example.com\r\nBcc: x@example.com'] });
    assert.equal(res.status, 400);
    res = await s.call('PUT', 'notify', { ...body, smtp: { ...body.smtp, security: 'none' } });
    assert.equal(res.status, 400);
    // test mail
    res = await s.call('POST', 'notify/test', {});
    assert.equal(res.status, 200);
    assert.deepEqual(sent[0].msg.to, ['ops@example.com']);
    assert.equal(sent[0].smtp.password, SMTP_SECRET);
    // clearPassword removes it
    res = await s.call('PUT', 'notify', { ...body, smtp: { ...body.smtp, password: '', clearPassword: true } });
    assert.equal(res.data.notify.smtp.passwordSet, false);
    assert.ok(s.logs.every((l) => !l.includes(SMTP_SECRET)));
  } finally {
    await s.close();
  }
});

test('a failed backup is e-mailed to the recipients in admin.json', async () => {
  const sent = [];
  const mailer = async (smtp, msg) => sent.push({ smtp, msg });
  const gh = fakeGithub({ repos: { 'octo/foundry-world-alpha': { private: true, push: false } } });
  const notifySettings = { recipients: ['gm@example.org'], smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: '', password: '', from: 'backup@example.com' } };
  const s = await start({ fetchImpl: gh.fetchImpl, mailer, notifySettings, worlds: { alpha: {} } });
  try {
    await s.login();
    await s.app.confirmOwner();
    await s.call('POST', 'worlds/alpha/backup', {});
    await s.app.backups.idle();
    const w = (await s.call('GET', 'state')).data.worlds[0];
    assert.equal(w.lastResult, 'error');
    assert.match(w.lastError, /may not push/);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].msg.to, ['gm@example.org']);
    assert.match(sent[0].msg.subject, /^Foundry world backup \(.*\): backup of World alpha failed$/);
    assert.match(sent[0].msg.text, /may not push to octo\/foundry-world-alpha/);
  } finally {
    await s.close();
  }
});

test('changing the password needs the current one and ends other sessions', async () => {
  const s = await start();
  try {
    await s.login();
    const oldCsrf = s.csrf;
    assert.equal((await s.call('PUT', 'password', { current: 'wrong', password: 'new password 1' })).status, 403);
    assert.equal((await s.call('PUT', 'password', { current: PASSWORD, password: 'short' })).status, 400);
    const res = await s.call('PUT', 'password', { current: PASSWORD, password: 'new password 1' });
    assert.equal(res.status, 200);
    assert.notEqual(s.csrf, oldCsrf);
    const stored = JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).passwordHash;
    assert.equal(await verifyPassword('new password 1', stored), true);
    assert.equal((await s.call('GET', 'state')).status, 200, 'this session goes on');
    s.clearCookie();
    assert.equal((await s.login()).status, 401);
    assert.equal((await s.login('new password 1')).status, 200);
  } finally {
    await s.close();
  }
});

test('setup creates admin.json from the environment and keeps what is not given', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'admin.json');
  let changed = await setup(file, {
    FOUNDRY_BACKUP_ADMIN_PASSWORD: 'first password',
    FOUNDRY_BACKUP_NOTIFY_EMAILS: 'a@example.com, b@example.com',
    FOUNDRY_BACKUP_SMTP_HOST: 'smtp.example.com',
    FOUNDRY_BACKUP_SMTP_PORT: '465',
    FOUNDRY_BACKUP_SMTP_SECURITY: 'tls',
    FOUNDRY_BACKUP_SMTP_FROM: 'backup@example.com',
  });
  assert.deepEqual(changed, ['admin password', 'notification recipients', 'SMTP settings']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let settings = parseAdminSettings(fs.readFileSync(file, 'utf8'));
  assert.equal(await verifyPassword('first password', settings.passwordHash), true);
  assert.deepEqual(settings.notify.recipients, ['a@example.com', 'b@example.com']);
  assert.equal(settings.notify.smtp.port, 465);
  changed = await setup(file, { FOUNDRY_BACKUP_NOTIFY_EMAILS: 'c@example.com' });
  assert.deepEqual(changed, ['notification recipients']);
  settings = parseAdminSettings(fs.readFileSync(file, 'utf8'));
  assert.equal(await verifyPassword('first password', settings.passwordHash), true);
  assert.equal(settings.notify.smtp.host, 'smtp.example.com');
  await assert.rejects(setup(file, { FOUNDRY_BACKUP_ADMIN_PASSWORD: 'short' }), /at least 8/);
  await assert.rejects(setup(file, { FOUNDRY_BACKUP_NOTIFY_EMAILS: 'nope' }), /invalid e-mail/);
});

test('mail helpers refuse unsafe input', () => {
  assert.equal(isEmail('a@example.com'), true);
  assert.equal(isEmail('a@example.com>\r\nRCPT TO:<b@example.com'), false);
  assert.equal(isEmail('Name <a@example.com>'), false);
  assert.equal(encodeHeader('Update\r\nBcc: x'), 'Update Bcc: x');
  assert.equal(encodeHeader('Uppdatering klar – v1.2'), `=?UTF-8?B?${Buffer.from('Uppdatering klar – v1.2').toString('base64')}?=`);
  assert.match(smtpProblem({ host: 'h.example', port: 25, security: 'none', user: 'u', from: 'a@example.com' }), /TLS/);
  const msg = buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 'Hi', text: '.\nline' });
  assert.match(msg, /^From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n/);
  const body = msg.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), '.\r\nline');
});

// A tiny SMTP server for the mailer test: records the conversation.
function fakeSmtp() {
  const transcript = [];
  const server = net.createServer((socket) => {
    let data = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        transcript.push(line);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 queued\r\n');
          }
        } else if (/^EHLO /.test(line)) socket.write('250-fake\r\n250-SIZE 1000000\r\n250 8BITMIME\r\n');
        else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') {
          data = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 no\r\n');
      }
    });
  });
  return { server, transcript };
}

test('sendMail talks SMTP and the notifier mails the configured recipients', async () => {
  const { server, transcript } = fakeSmtp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const smtp = { host: '127.0.0.1', port, security: 'none', user: '', password: '', from: 'backup@example.com' };
    await sendMail(smtp, { to: ['a@example.com', 'b@example.com'], subject: 'Hello', text: 'Body' });
    assert.ok(transcript.includes('MAIL FROM:<backup@example.com>'));
    assert.ok(transcript.includes('RCPT TO:<a@example.com>'));
    assert.ok(transcript.includes('RCPT TO:<b@example.com>'));
    assert.ok(transcript.includes('Subject: Hello'));
    // STARTTLS is not silently skipped
    await assert.rejects(sendMail({ ...smtp, security: 'starttls' }, { to: ['a@example.com'], subject: 'x', text: 'y' }),
      /does not offer STARTTLS/);

    // notify.js reads admin.json through the env file
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'env'), `GITHUB_TOKEN=x\nCONFIG_FILE=${path.join(dir, 'config.json')}\n`);
    assert.equal(adminFileFromEnv(path.join(dir, 'env')), path.join(dir, 'admin.json'));
    const logs = [];
    // no admin.json yet: nothing to do, not an error
    assert.equal(await notify({ 'service-env': path.join(dir, 'env'), subject: 's' }, { log: (l) => logs.push(l) }), 0);
    assert.match(logs[0], /no recipients/);
    fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({
      notify: { recipients: ['gm@example.com'], smtp: { ...smtp, user: undefined, password: undefined } },
    }));
    transcript.length = 0;
    await notify({ 'service-env': path.join(dir, 'env'), subject: 'updated to 1.3.0', message: 'Updated.' },
      { log: () => {} });
    assert.ok(transcript.includes('RCPT TO:<gm@example.com>'));
    assert.ok(transcript.some((l) => /^Subject: Foundry world backup \(.*\): updated to 1\.3\.0$/.test(l)));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('env files are parsed without shell expansion', () => {
  const env = parseEnvFile('# c\nexport A=1\nB="two words"\nC=\'$HOME\'\nbad line\n');
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two words');
  assert.equal(env.C, '$HOME');
  assert.equal(env.bad, undefined);
});

test('the GitHub token can be replaced on the admin page once GitHub accepts it, and is never shown', async () => {
  const gh = fakeGithub({ tokens: { [TOKEN]: 'octo', [NEW_TOKEN]: 'octo-new' } });
  const s = await start({ fetchImpl: gh.fetchImpl, envText: `# token\r\nGITHUB_TOKEN=${TOKEN}\r\nFOUNDRY_DATA=/x\r\n` });
  try {
    let res = await s.login();
    assert.equal(res.data.token.canChange, true);
    assert.equal(res.data.token.kind, 'classic personal access token');
    assert.equal(res.data.token.file, s.envFile);
    // a token GitHub refuses is not saved
    res = await s.call('PUT', 'token', { token: BAD_TOKEN });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /not saved: GitHub rejects the token/);
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), `# token\r\nGITHUB_TOKEN=${TOKEN}\r\nFOUNDRY_DATA=/x\r\n`);
    for (const bad of ['', 'short', 'github_pat_REPLACE_ME', `${'a'.repeat(30)}\nX=1`]) {
      assert.equal((await s.call('PUT', 'token', { token: bad })).status, 400, bad);
    }
    // an accepted one replaces the GITHUB_TOKEN line in place and switches the owner
    res = await s.call('PUT', 'token', { token: NEW_TOKEN });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.token.kind, 'fine-grained personal access token');
    assert.equal(res.data.token.owner, 'octo-new');
    assert.equal(res.data.worlds[0].repo, 'octo-new/foundry-world-alpha');
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), `# token\r\nGITHUB_TOKEN=${NEW_TOKEN}\r\nFOUNDRY_DATA=/x\r\n`);
    assert.ok(!res.text.includes(NEW_TOKEN) && !res.text.includes(TOKEN));
    assert.ok(s.logs.every((l) => !l.includes(NEW_TOKEN) && !l.includes(TOKEN)));
    assert.ok(s.logs.some((l) => /GitHub token changed \(fine-grained personal access token, saved to /.test(l)));
  } finally {
    await s.close();
  }
  // no writable env file with a GITHUB_TOKEN line: the token cannot be changed here
  const s2 = await start({ envText: 'FOUNDRY_DATA=/x\n' });
  try {
    const res = await s2.login();
    assert.equal(res.data.token.canChange, false);
    assert.match(res.data.token.problem, /no GITHUB_TOKEN line/);
    assert.equal((await s2.call('PUT', 'token', { token: NEW_TOKEN })).status, 409);
  } finally {
    await s2.close();
  }
});

test('the Foundry page saves and tests Foundry\'s address; the saved one wins over FOUNDRY_URL', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === 'http://foundry.test:30000/api/status') return new Response(JSON.stringify({ active: true, world: 'alpha' }));
    if (url === 'http://other.test:30001/api/status') return new Response(JSON.stringify({ active: false }));
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const s = await start({ fetchImpl, foundryUrl: 'http://foundry.test:30000' });
  try {
    await s.login();
    let res = await s.call('GET', 'state');
    assert.deepEqual(res.data.settings.foundry, { url: null, inUse: 'http://foundry.test:30000', defaultUrl: 'http://foundry.test:30000' });
    // the address in use
    res = await s.call('POST', 'foundry-test', {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.tested, 'saved');
    assert.equal(res.data.status, 'ok');
    assert.match(res.data.message, /world "alpha" is active/);
    // a typed one is tested without being saved
    res = await s.call('POST', 'foundry-test', { url: 'http://down.test:1' });
    assert.equal(res.data.tested, 'typed');
    assert.equal(res.data.status, 'warn');
    assert.match(res.data.message, /did not answer \/api\/status \(cannot connect \(ECONNREFUSED\)\)/);
    assert.equal((await s.call('GET', 'state')).data.settings.foundry.inUse, 'http://foundry.test:30000');
    res = await s.call('POST', 'foundry-test', { url: 'ftp://foundry.test' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /http:\/\/ or https:\/\//);
    // saved: config.json, used by the backups and Test setup
    res = await s.call('PUT', 'settings', { foundry: { url: 'http://other.test:30001' } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.data.settings.foundry, { url: 'http://other.test:30001', inUse: 'http://other.test:30001', defaultUrl: 'http://foundry.test:30000' });
    assert.deepEqual(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).foundry, { url: 'http://other.test:30001' });
    assert.ok(s.logs.includes('admin: Foundry settings changed'));
    asked.length = 0;
    res = await s.call('POST', 'foundry-test', {});
    assert.match(res.data.message, /reachable at http:\/\/other.test:30001, no world active/);
    assert.deepEqual(asked, ['http://other.test:30001/api/status']);
    // off: nobody is asked
    res = await s.call('PUT', 'settings', { foundry: { url: '' } });
    assert.equal(res.data.settings.foundry.inUse, '');
    res = await s.call('POST', 'foundry-test', {});
    assert.equal(res.data.status, 'warn');
    assert.match(res.data.message, /no address set/);
    // back to FOUNDRY_URL
    res = await s.call('PUT', 'settings', { foundry: { url: null } });
    assert.equal(res.data.settings.foundry.inUse, 'http://foundry.test:30000');
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).foundry, undefined);
    // bad input changes nothing
    res = await s.call('PUT', 'settings', { foundry: { url: 'http://u:p@foundry.test' } });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /user name or password/);
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).foundry, undefined);
  } finally {
    await s.close();
  }
});

test('the saved Foundry address decides whether a backup waits for an active world', async () => {
  const gh = fakeGithub({ repos: { 'octo/foundry-world-alpha': { private: true, push: true } }, foundry: { active: true, world: 'alpha' } });
  // FOUNDRY_URL is off; the address saved on the page is asked
  const s = await start({ fetchImpl: gh.fetchImpl, config: '{"whenActive":"skip","foundry":{"url":"http://foundry.test:30000"}}', worlds: { alpha: {} } });
  try {
    await s.login();
    const res = await s.call('POST', 'worlds/alpha/backup', {});
    assert.equal(res.status, 202, res.text);
    await s.app.backups.idle();
    const alpha = (await s.call('GET', 'state')).data.worlds.find((w) => w.id === 'alpha');
    assert.equal(alpha.lastResult, 'skipped');
  } finally {
    await s.close();
  }
});

test('Test setup checks the token, git, the data folder, the state folder, Foundry and every world repository', async () => {
  const gh = fakeGithub({
    tokens: { [TOKEN]: 'octo', [NEW_TOKEN]: 'other' },
    repos: { 'octo/foundry-world-alpha': { private: true, push: true }, [SERVICE_REPO]: { tag: 'v1.4.2' }, 'friend/shared': { private: false, push: true } },
    foundry: { active: true, world: 'alpha' },
  });
  const s = await start({ fetchImpl: gh.fetchImpl, config: '{"worlds":{"beta":{"repo":"friend/shared"},"gamma":{"enabled":false}}}',
    worlds: { alpha: {}, beta: {}, gamma: {}, delta: {} }, foundryUrl: 'http://foundry.test:30000' });
  try {
    await s.login();
    let res = await s.call('POST', 'setup-test', {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.tested, 'saved');
    assert.equal(res.data.token.status, 'ok');
    assert.match(res.data.token.message, /accepted \(octo\); expires 2099/);
    const by = Object.fromEntries(res.data.checks.map((c) => [c.id || c.kind, c]));
    assert.equal(by.git.status, 'ok');
    assert.equal(by.data.status, 'ok');
    assert.match(by.data.message, /4 world\(s\)/);
    assert.equal(by.state.status, 'ok');
    assert.equal(by.foundry.status, 'ok');
    assert.match(by.foundry.message, /world "alpha" is active/);
    assert.equal(by.service.status, 'ok');
    assert.equal(by.alpha.status, 'ok');
    assert.equal(by.beta.status, 'warn');
    assert.match(by.beta.message, /PUBLIC/);
    assert.equal(by.gamma, undefined, 'disabled worlds are not checked');
    assert.equal(by.delta.status, 'warn');
    assert.match(by.delta.message, /created \(private\) on the first backup/);
    assert.equal(by.delta.repo, 'octo/foundry-world-delta');
    assert.equal((await s.call('GET', 'state')).data.token.owner, 'octo');
    // a typed token is tested without being saved
    res = await s.call('POST', 'setup-test', { token: NEW_TOKEN });
    assert.equal(res.data.tested, 'typed');
    assert.match(res.data.token.message, /accepted \(other\)/);
    const typed = Object.fromEntries(res.data.checks.map((c) => [c.id || c.kind, c]));
    assert.equal(typed.alpha.status, 'warn', 'other/foundry-world-alpha does not exist yet');
    assert.equal(typed.alpha.repo, 'other/foundry-world-alpha');
    assert.equal(typed.beta.status, 'warn', 'friend/shared exists and is public');
    assert.equal(typed.service.status, 'ok', 'the fake GitHub shows the release repository to every valid token');
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), `GITHUB_TOKEN=${TOKEN}\n`);
    assert.equal((await s.call('GET', 'state')).data.token.owner, 'octo', 'the saved token stays in use');
    // a refused token stops the repository checks
    res = await s.call('POST', 'setup-test', { token: BAD_TOKEN });
    assert.equal(res.data.token.status, 'bad');
    assert.ok(!res.data.checks.some((c) => c.kind === 'world'));
    assert.ok(gh.seen.every((c) => !c.body || !c.body.includes(TOKEN)));
  } finally {
    await s.close();
  }
  // "create repositories" off: a missing one is a problem; GitHub down: the token check says so
  const gh2 = fakeGithub({ repos: {} });
  const s2 = await start({ fetchImpl: gh2.fetchImpl, config: '{"github":{"createRepos":false}}', worlds: { alpha: {} } });
  try {
    await s2.login();
    const res = await s2.call('POST', 'setup-test', {});
    const alpha = res.data.checks.find((c) => c.id === 'alpha');
    assert.equal(alpha.status, 'bad');
    assert.match(alpha.message, /"create repositories" is off/);
  } finally {
    await s2.close();
  }
  const s3 = await start({ fetchImpl: fakeGithub({ down: true }).fetchImpl });
  try {
    await s3.login();
    const res = await s3.call('POST', 'setup-test', {});
    assert.equal(res.data.token.status, 'bad');
    assert.equal(res.data.token.unreachable, true);
  } finally {
    await s3.close();
  }
});

test('the daily check e-mails a token problem every day it lasts and once more when it is gone', async () => {
  const gh = fakeGithub({ expires: '2099-01-01 00:00:00 UTC' });
  const notifySettings = { recipients: ['gm@example.org'], smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: '', password: '', from: 'b@example.com' } };
  const s = await start({ fetchImpl: gh.fetchImpl, notifySettings });
  try {
    assert.equal(await s.app.runDailyCheck(), '');
    assert.equal(s.mails.length, 0);
    assert.equal(s.app.getOwner(), 'octo');
  } finally {
    await s.close();
  }
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const gh2 = fakeGithub({ expires: soon });
  const s2 = await start({ fetchImpl: gh2.fetchImpl, notifySettings });
  try {
    assert.match(await s2.app.runDailyCheck(), /expires in 2 day\(s\)/);
    assert.equal(s2.mails.length, 1);
    assert.match(s2.mails[0].subject, /GitHub token problem/);
    assert.match(s2.mails[0].text, /expires in 2 day/);
    assert.match(await s2.app.runDailyCheck(), /expires/);
    assert.equal(s2.mails.length, 2, 'every day it lasts');
  } finally {
    await s2.close();
  }
  // a timer-driven run, then OK again
  let expires = '2026-01-01 00:00:00 UTC';
  const gh3 = { fetchImpl: async (url, init) => fakeGithub({ expires }).fetchImpl(url, init) };
  const s3 = await start({ fetchImpl: gh3.fetchImpl, notifySettings });
  try {
    const stop = s3.app.startDailyChecks({ firstDelayMs: 10, intervalMs: 20 });
    await until(() => s3.mails.length >= 1, 5000);
    stop();
    assert.match(s3.mails[0].text, /expired on 2026-01-01/);
    expires = '2099-01-01 00:00:00 UTC';
    assert.equal(await s3.app.runDailyCheck(), '');
    assert.match(s3.mails.at(-1).subject, /OK again/);
  } finally {
    await s3.close();
  }
});

test('the environment is read with the defaults of the service', () => {
  const e = readEnv({ FOUNDRY_DATA: '/srv/foundry', GITHUB_TOKEN: 'x', CONFIG_FILE: '/etc/fwb/config.json' });
  assert.equal(e.adminPort, 8484);
  assert.equal(e.adminHost, '0.0.0.0');
  assert.equal(e.stateDir, path.join('/etc/fwb', 'state'));
  assert.equal(e.envFile, path.join('/etc/fwb', 'env'));
  assert.equal(e.foundryUrl, 'http://localhost:30000');
  assert.equal(e.tlsOff, false);
  assert.deepEqual(e.trustProxy, []);
  assert.throws(() => readEnv({}), /FOUNDRY_DATA is not set/);
  assert.throws(() => readEnv({ FOUNDRY_DATA: '/x', ADMIN_PORT: 'abc' }), /invalid ADMIN_PORT/);
  assert.throws(() => readEnv({ FOUNDRY_DATA: '/x', FOUNDRY_URL: 'nope' }), /invalid FOUNDRY_URL/);
  assert.throws(() => readEnv({ FOUNDRY_DATA: '/x', ADMIN_TRUST_PROXY: 'evil' }), /not an IP address/);
  assert.equal(readEnv({ FOUNDRY_DATA: '/x', FOUNDRY_URL: '' }).foundryUrl, '');
  assert.deepEqual(readEnv({ FOUNDRY_DATA: '/x', ADMIN_TRUST_PROXY: '1' }).trustProxy, ['loopback']);
  assert.deepEqual(readEnv({ FOUNDRY_DATA: '/x', ADMIN_HOSTS: 'a.lan, b.lan', ADMIN_PUBLIC_URL: 'https://backup.example.com' }).hosts, ['a.lan', 'b.lan', 'backup.example.com']);
  assert.throws(() => readEnv({ FOUNDRY_DATA: '/x', ADMIN_PUBLIC_URL: '::' }), /invalid ADMIN_PUBLIC_URL/);
});

test('the Linux update trigger rewrites the request file the systemd path unit watches', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'update-request');
  const trigger = fileUpdateTrigger(file);
  assert.match(await trigger.problem(), /update-request is missing; re-run the installer/);
  fs.writeFileSync(file, '', { mode: 0o600 });
  assert.equal(await trigger.problem(), '');
  await trigger.request();
  assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
});

test('the Windows update trigger only queries and runs the named task', async () => {
  const calls = [];
  let fail = false;
  const run = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    cb(fail ? new Error('Access is denied.') : null);
  };
  const trigger = taskUpdateTrigger('FoundryWorldBackup-UpdateNow', run);
  assert.equal(await trigger.problem(), '');
  await trigger.request();
  assert.deepEqual(calls, [
    ['schtasks.exe', '/Query', '/TN', 'FoundryWorldBackup-UpdateNow'],
    ['schtasks.exe', '/Run', '/TN', 'FoundryWorldBackup-UpdateNow'],
  ]);
  fail = true;
  assert.match(await trigger.problem(), /missing or the service may not run it/);
  assert.throws(() => taskUpdateTrigger('bad" & calc', run), ConfigError);
});

test('"Update now" shows the versions and asks the updater to run, at most every two minutes', async () => {
  const requests = [];
  let problem = '';
  const updateTrigger = { problem: async () => problem, request: async () => requests.push(Date.now()) };
  const gh = fakeGithub({ repos: { [SERVICE_REPO]: { tag: 'v1.5.0' } } });
  const s = await start({ fetchImpl: gh.fetchImpl, updateTrigger, version: '1.4.2' });
  try {
    let res = await s.login();
    assert.equal(res.data.version, '1.4.2');
    res = await s.call('GET', 'update');
    assert.deepEqual(res.data, {
      installed: '1.4.2', latest: '1.5.0', newer: true, latestProblem: '', canUpdate: true, problem: '', requestedAt: null,
    });
    assert.equal((await s.call('POST', 'update', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
    res = await s.call('POST', 'update', {});
    assert.equal(res.status, 202);
    assert.equal(requests.length, 1);
    assert.ok(s.logs.some((l) => /update requested \(installed 1\.4\.2\)/.test(l)));
    res = await s.call('POST', 'update', {});
    assert.equal(res.status, 429);
    assert.equal(requests.length, 1);
    assert.ok((await s.call('GET', 'update')).data.requestedAt);
  } finally {
    await s.close();
  }
  problem = 'the scheduled task is missing';
  const s2 = await start({ fetchImpl: fakeGithub({}).fetchImpl, updateTrigger, version: '1.4.2' });
  try {
    await s2.login();
    const res = await s2.call('GET', 'update');
    assert.equal(res.data.latest, null);
    assert.match(res.data.latestProblem, /cannot see dxcufgb\/FoundryVTT-world-backup-to-git/);
    assert.equal(res.data.canUpdate, false);
    const post = await s2.call('POST', 'update', {});
    assert.equal(post.status, 409);
    assert.match(post.data.error, /not available: the scheduled task is missing/);
    assert.equal(requests.length, 1);
  } finally {
    await s2.close();
  }
});

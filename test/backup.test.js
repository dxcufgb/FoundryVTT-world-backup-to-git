'use strict';
// The backup itself, with the real git command: the world folder becomes the work tree of a git directory in the
// state folder, commits land in a local bare repository standing in for GitHub, the GitHub API is faked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createBackups, loadStatus, gitDetail, RELEASE_WORKFLOW, RELEASE_TEMPLATE } = require('../src/backup.js');
const { parseConfig } = require('../src/config.js');
const { createGithub, foundryStatus } = require('../src/github.js');

const API = 'https://api.github.com';
const TOKEN = 'ghp_testtoken_not_real_0123456789';
const OWNER = 'octo';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fwb-${name}-`));
}

/** A Foundry data folder with the given worlds (id -> extra files). */
function dataDir(worlds) {
  const dir = tmp('data');
  for (const [id, files] of Object.entries(worlds)) {
    const folder = path.join(dir, 'Data', 'worlds', id);
    fs.mkdirSync(path.join(folder, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'world.json'), JSON.stringify({ title: `World ${id}`, system: 'dnd5e' }));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  }
  return dir;
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

/** A fake GitHub API: repos[owner/name] = { private, push } or absent; POST /user/repos creates one. */
function fakeGithub({ repos = {}, login = OWNER, createStatus = 201, status = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const auth = (init.headers || {}).Authorization;
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/status')) return json(200, status);
    if (auth !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    if (url === `${API}/user`) return json(200, { login });
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url);
    if (m) {
      const r = repos[m[1]];
      if (!r) return json(404, { message: 'Not Found' });
      return json(200, { private: r.private, default_branch: 'main', permissions: { push: r.push, admin: false } });
    }
    if (url === `${API}/user/repos` && (init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body);
      if (createStatus !== 201) return json(createStatus, { message: 'Resource not accessible by personal access token' });
      repos[`${login}/${body.name}`] = { private: body.private, push: true, created: body };
      return json(201, { full_name: `${login}/${body.name}` });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  fn.repos = repos;
  return fn;
}

/** createBackups() against a data folder, with a bare repository per world standing in for GitHub. */
function setup({ worlds = { alpha: { 'packs/actors.ldb': 'actors v1', 'notes.txt': 'hello' } }, config = '{}', github, foundryUrl = '', token = TOKEN } = {}) {
  const data = dataDir(worlds);
  const state = tmp('state');
  const remotes = tmp('remotes');
  const logs = [];
  const mails = [];
  const fetchImpl = github || fakeGithub({ repos: {} });
  const cfg = parseConfig(config);
  const backups = createBackups({
    dataDir: data,
    stateDir: state,
    foundryUrl,
    getConfig: () => cfg,
    getToken: () => token,
    getOwner: () => OWNER,
    remoteUrl: (repo) => {
      const dir = path.join(remotes, repo.replace('/', '__'));
      if (!fs.existsSync(dir)) execFileSync('git', ['init', '-q', '--bare', dir]);
      return dir;
    },
    notify: async (subject, text) => mails.push({ subject, text }),
    fetchImpl,
    log: (l) => logs.push(l),
    env: { PATH: process.env.PATH, HOME: state },
  });
  const remote = (repo) => path.join(remotes, repo.replace('/', '__'));
  return { data, state, backups, logs, mails, fetchImpl, cfg, remote, worldFolder: (id) => path.join(data, 'Data', 'worlds', id) };
}

const until = async (fn, ms = 10000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('a world is committed with the git directory outside its folder and pushed; the repository is created when missing', async () => {
  const t = setup();
  const list = t.backups.worlds();
  assert.equal(list.length, 1);
  assert.equal(list[0].repo, 'octo/foundry-world-alpha');
  assert.equal(list[0].lastResult, null);
  assert.deepEqual(t.backups.enqueue('alpha', { reason: 'test run' }), { queued: true });
  assert.deepEqual(t.backups.enqueue('alpha'), { queued: false, reason: 'a backup of this world is already running or queued' });
  await t.backups.idle();
  const s = t.backups.statusOf('alpha');
  assert.equal(s.lastResult, 'ok', s.lastError);
  assert.equal(s.changed, true);
  assert.equal(s.repo, 'octo/foundry-world-alpha');
  assert.match(s.commit, /^[0-9a-f]{40}$/);
  assert.ok(s.lastSuccess && s.lastAttempt);
  // the repository was created, private, under the token's account
  const created = t.fetchImpl.repos['octo/foundry-world-alpha'].created;
  assert.equal(created.private, true);
  assert.match(created.description, /World alpha/);
  // no .git inside the world folder; the git directory is in the state folder
  assert.ok(!fs.existsSync(path.join(t.worldFolder('alpha'), '.git')));
  assert.ok(fs.existsSync(path.join(t.state, 'repos', 'alpha', 'HEAD')));
  // the bare "GitHub" repository holds the commit with the world's files
  const remote = t.remote('octo/foundry-world-alpha');
  assert.equal(git(remote, 'rev-parse', 'main'), s.commit);
  assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort(), ['notes.txt', 'packs/actors.ldb', 'world.json']);
  assert.match(git(remote, 'log', '-1', '--format=%s%n%b', 'main'), /^Backup of World alpha \(alpha\) \d{4}-\d\d-\d\dT.*\nFoundry VTT world backup, test run\.$/);
  assert.equal(git(remote, 'log', '-1', '--format=%an <%ae>', 'main'), 'Foundry world backup <foundry-world-backup@localhost>');
  // status.json carries it, without the token
  const file = fs.readFileSync(path.join(t.state, 'status.json'), 'utf8');
  assert.ok(!file.includes(TOKEN));
  assert.equal(loadStatus(path.join(t.state, 'status.json')).worlds.alpha.commit, s.commit);
  assert.ok(!t.logs.join('\n').includes(TOKEN));
  assert.match(t.logs.join('\n'), /created the private repository octo\/foundry-world-alpha/);
  assert.match(t.logs.join('\n'), /alpha: backed up to octo\/foundry-world-alpha \(new commit, test run\)/);
  assert.equal(t.mails.length, 0);

  // a second run without changes makes no commit but still succeeds; a change makes a new commit
  t.backups.enqueue('alpha', { reason: 'again' });
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').changed, false);
  assert.equal(t.backups.statusOf('alpha').commit, s.commit);
  fs.writeFileSync(path.join(t.worldFolder('alpha'), 'packs', 'actors.ldb'), 'actors v2');
  fs.unlinkSync(path.join(t.worldFolder('alpha'), 'notes.txt'));
  t.backups.enqueue('alpha', { reason: 'changed' });
  await t.backups.idle();
  const s3 = t.backups.statusOf('alpha');
  assert.equal(s3.changed, true);
  assert.notEqual(s3.commit, s.commit);
  assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort(), ['packs/actors.ldb', 'world.json']);
  assert.equal(git(remote, 'rev-list', '--count', 'main'), '2');
  // the size was summed
  await until(() => t.backups.statusOf('alpha').size !== undefined);
  assert.equal(t.backups.statusOf('alpha').size, 'actors v2'.length + fs.statSync(path.join(t.worldFolder('alpha'), 'world.json')).size);
});

test('an existing repository the token may push to is used as it is; a world can name another one', async () => {
  const github = fakeGithub({ repos: { 'octo/foundry-world-alpha': { private: true, push: true }, 'friend/shared': { private: true, push: true } } });
  const t = setup({ worlds: { alpha: {}, beta: {} }, config: '{"worlds":{"beta":{"repo":"friend/shared"}}}', github });
  t.backups.enqueue('alpha');
  t.backups.enqueue('beta');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').lastResult, 'ok', t.backups.statusOf('alpha').lastError);
  assert.equal(t.backups.statusOf('beta').lastResult, 'ok', t.backups.statusOf('beta').lastError);
  assert.equal(t.backups.statusOf('beta').repo, 'friend/shared');
  assert.ok(!github.calls.some((c) => c.url.endsWith('/user/repos')), 'nothing created');
  assert.equal(git(t.remote('friend/shared'), 'rev-list', '--count', 'main'), '1');
});

test('failures are reported without the token and e-mailed, once more when the world backs up again', async () => {
  // 1. the repository exists but the token may not push
  const github = fakeGithub({ repos: { 'octo/foundry-world-alpha': { private: true, push: false } } });
  const t = setup({ github });
  t.backups.enqueue('alpha');
  await t.backups.idle();
  let s = t.backups.statusOf('alpha');
  assert.equal(s.lastResult, 'error');
  assert.match(s.lastError, /may not push to octo\/foundry-world-alpha/);
  assert.equal(t.mails.length, 1);
  assert.equal(t.mails[0].subject, 'backup of World alpha failed');
  assert.match(t.mails[0].text, /may not push/);
  assert.ok(!t.mails[0].text.includes(TOKEN));
  // 2. the repository is missing and may not be created
  github.repos['octo/foundry-world-alpha'] = undefined;
  t.cfg.github.createRepos = false;
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.match(t.backups.statusOf('alpha').lastError, /does not exist \(create it on GitHub/);
  assert.equal(t.mails.length, 2);
  // 3. GitHub refuses to create it
  t.cfg.github.createRepos = true;
  const refusing = fakeGithub({ repos: {}, createStatus: 403 });
  const t2 = setup({ github: refusing });
  t2.backups.enqueue('alpha');
  await t2.backups.idle();
  assert.match(t2.backups.statusOf('alpha').lastError, /needs Administration: read and write/);
  // 4. a repository outside the token's account cannot be created
  const t3 = setup({ config: '{"worlds":{"alpha":{"repo":"someone/else"}}}' });
  t3.backups.enqueue('alpha');
  await t3.backups.idle();
  assert.match(t3.backups.statusOf('alpha').lastError, /not under the token's account \(octo\)/);
  // 5. no token at all
  const t4 = setup({ token: '' });
  t4.backups.enqueue('alpha');
  await t4.backups.idle();
  assert.equal(t4.backups.statusOf('alpha').lastError, 'no GitHub token');
  // 6. the push itself fails (git's message is kept, the token is not in it): then it works again
  const t5 = setup({ github: fakeGithub({ repos: { 'octo/foundry-world-alpha': { private: true, push: true } } }) });
  fs.writeFileSync(t5.remote('octo/foundry-world-alpha'), 'not a repository'); // a file where the remote should be
  t5.backups.enqueue('alpha');
  await t5.backups.idle();
  s = t5.backups.statusOf('alpha');
  assert.equal(s.lastResult, 'error');
  assert.match(s.lastError, /git push failed/);
  assert.ok(!s.lastError.includes(TOKEN));
  assert.equal(t5.mails.length, 1);
  fs.unlinkSync(t5.remote('octo/foundry-world-alpha'));
  t5.backups.enqueue('alpha');
  await t5.backups.idle();
  assert.equal(t5.backups.statusOf('alpha').lastResult, 'ok', t5.backups.statusOf('alpha').lastError);
  assert.equal(t5.mails.length, 2);
  assert.equal(t5.mails[1].subject, 'backup of World alpha OK again');
  // a second success sends nothing more
  t5.backups.enqueue('alpha');
  await t5.backups.idle();
  assert.equal(t5.mails.length, 2);
});

test('an active world is skipped or backed up with a note, as its settings say', async () => {
  const github = fakeGithub({ repos: {}, status: { active: true, world: 'alpha', version: '13.348' } });
  const t = setup({ worlds: { alpha: {}, beta: {} }, config: '{"whenActive":"skip","worlds":{"beta":{"whenActive":"backup"}}}', github, foundryUrl: 'http://foundry.test:30000' });
  t.backups.enqueue('alpha');
  t.backups.enqueue('beta');
  await t.backups.idle();
  const alpha = t.backups.statusOf('alpha');
  assert.equal(alpha.lastResult, 'skipped');
  assert.match(alpha.lastError, /active in Foundry/);
  assert.equal(alpha.commit, undefined);
  assert.equal(t.mails.length, 0, 'a skip is not a failure');
  // beta was not the active world: a plain backup
  assert.equal(t.backups.statusOf('beta').lastResult, 'ok');
  assert.equal(t.backups.statusOf('beta').wasActive, false);
  // now beta is active and says "back up anyway": the commit says so
  github.calls.length = 0;
  const active = fakeGithub({ repos: github.repos, status: { active: true, world: 'beta' } });
  const t2 = setup({ worlds: { beta: {} }, config: '{"whenActive":"backup"}', github: active, foundryUrl: 'http://foundry.test:30000' });
  t2.backups.enqueue('beta');
  await t2.backups.idle();
  assert.equal(t2.backups.statusOf('beta').wasActive, true);
  assert.match(git(t2.remote('octo/foundry-world-beta'), 'log', '-1', '--format=%b', 'main'), /The world was active in Foundry during the backup/);
  assert.deepEqual(await foundryStatus('http://foundry.test:30000', active), { reachable: true, active: true, world: 'beta' });
  assert.deepEqual(await foundryStatus('', active), { reachable: false, active: false, world: null, problem: 'no Foundry address set' });
  assert.deepEqual(await foundryStatus('http://down.test', async () => { throw new Error('ECONNREFUSED'); }),
    { reachable: false, active: false, world: null, problem: 'cannot connect' });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal((await foundryStatus('http://down.test', async () => { throw refused; })).problem, 'cannot connect (ECONNREFUSED)');
  assert.equal((await foundryStatus('http://web.test', async () => new Response('nope', { status: 404 }))).problem, 'HTTP 404');
  assert.match((await foundryStatus('http://web.test', async () => new Response('<html>'))).problem, /not JSON/);
});

test('worlds are listed with their effective settings; forget removes status and local copy; git is checked', async () => {
  const t = setup({ worlds: { alpha: {}, beta: {} }, config: '{"worlds":{"beta":{"enabled":false,"schedule":{"frequency":"hourly","everyHours":2}}}}' });
  const [alpha, beta] = t.backups.worlds();
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.customSchedule, false);
  assert.equal(beta.enabled, false);
  assert.equal(beta.customSchedule, true);
  assert.equal(beta.schedule.everyHours, 2);
  assert.equal(beta.ownRepo, '');
  assert.equal(beta.ownWhenActive, '');
  assert.equal(alpha.running, false);
  t.backups.enqueue('alpha');
  assert.equal(t.backups.isBusy(), true);
  assert.equal(t.backups.worlds().find((w) => w.id === 'alpha').queued || t.backups.worlds().find((w) => w.id === 'alpha').running, true);
  await t.backups.idle();
  assert.ok(fs.existsSync(path.join(t.state, 'repos', 'alpha')));
  t.backups.forget('alpha');
  assert.ok(!fs.existsSync(path.join(t.state, 'repos', 'alpha')));
  assert.equal(t.backups.statusOf('alpha').lastResult, undefined);
  assert.equal(await t.backups.gitProblem(), '');
  const noGit = createBackups({ dataDir: t.data, stateDir: t.state, gitBin: '/nonexistent/git', getConfig: () => t.cfg, getToken: () => TOKEN, getOwner: () => OWNER, log: () => {} });
  assert.match(await noGit.gitProblem(), /cannot run \/nonexistent\/git/);
  assert.equal(gitDetail({ stdout: '', stderr: 'hint: ignore me\nfatal: real problem\n' }), 'fatal: real problem');
});

test('the GitHub helper classifies token answers and repository lookups', async () => {
  const gh = createGithub({ fetchImpl: fakeGithub({ repos: { 'octo/pub': { private: false, push: true } } }) });
  const ok = await gh.checkToken(TOKEN);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.login, OWNER);
  const bad = await gh.checkToken('wrong');
  assert.equal(bad.status, 'bad');
  assert.match(bad.message, /rejects the token/);
  const down = createGithub({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(await down.checkToken(TOKEN), { status: 'bad', unreachable: true, message: 'could not reach GitHub (ENOTFOUND)' });
  assert.deepEqual(await gh.repoInfo('octo/pub', TOKEN), { exists: true, private: false, canPush: true, defaultBranch: 'main' });
  assert.deepEqual(await gh.repoInfo('octo/none', TOKEN), { exists: false });
  await assert.rejects(gh.repoInfo('octo/none', 'wrong'), /rejects the token/);
});

test('with releases on, every commit carries the release workflow without it ever being written into the world folder', async () => {
  const t = setup({ config: '{"github":{"releases":true}}' });
  const remote = t.remote('octo/foundry-world-alpha');
  const files = () => git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort();
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').lastResult, 'ok', t.backups.statusOf('alpha').lastError);
  assert.deepEqual(files(), [RELEASE_WORKFLOW, 'notes.txt', 'packs/actors.ldb', 'world.json'].sort());
  assert.equal(git(remote, 'show', `main:${RELEASE_WORKFLOW}`), fs.readFileSync(RELEASE_TEMPLATE, 'utf8').trim());
  assert.ok(!fs.existsSync(path.join(t.worldFolder('alpha'), '.github')), 'nothing written into the world folder');
  // the next run keeps it and, with nothing else changed, makes no commit
  const first = git(remote, 'rev-parse', 'main');
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').changed, false);
  assert.equal(git(remote, 'rev-parse', 'main'), first);
  // a world change keeps the workflow in the new commit
  fs.writeFileSync(path.join(t.worldFolder('alpha'), 'notes.txt'), 'changed');
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').changed, true);
  assert.ok(files().includes(RELEASE_WORKFLOW));
  // turned off: the next commit removes it and leaves the world's files alone
  t.cfg.github.releases = false;
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').lastResult, 'ok', t.backups.statusOf('alpha').lastError);
  assert.equal(t.backups.statusOf('alpha').changed, true);
  assert.deepEqual(files(), ['notes.txt', 'packs/actors.ldb', 'world.json']);
  assert.ok(!fs.existsSync(path.join(t.worldFolder('alpha'), '.github')));
});

test('with releases off, a world that has never had the workflow backs up as before', async () => {
  const t = setup();
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').lastResult, 'ok', t.backups.statusOf('alpha').lastError);
  assert.deepEqual(git(t.remote('octo/foundry-world-alpha'), 'ls-tree', '-r', '--name-only', 'main').split('\n').sort(),
    ['notes.txt', 'packs/actors.ldb', 'world.json']);
});

test('a push GitHub refuses for lack of the Workflows permission fails with a message saying what to change', async () => {
  const t = setup({ config: '{"github":{"releases":true}}' });
  t.backups.enqueue('alpha');
  await t.backups.idle();
  assert.equal(t.backups.statusOf('alpha').lastResult, 'ok', t.backups.statusOf('alpha').lastError);
  // GitHub's answer to a token without "Workflows: read and write", played by a pre-receive hook
  const hook = path.join(t.remote('octo/foundry-world-alpha'), 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "refusing to allow a Personal Access Token to create or update workflow ' +
    '`.github/workflows/release-world.yml` without `workflows` permission" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(t.worldFolder('alpha'), 'notes.txt'), 'changed');
  t.backups.enqueue('alpha');
  await t.backups.idle();
  const s = t.backups.statusOf('alpha');
  assert.equal(s.lastResult, 'error');
  assert.match(s.lastError, /token lacks "Workflows: read and write".*turn "Publish releases" off/);
  assert.equal(t.mails.length, 1);
  assert.ok(!s.lastError.includes(TOKEN));
});

'use strict';
// Backs a world folder up to its own private GitHub repository with git: the git directory lives in the service's
// state folder (<STATE_DIR>/repos/<world id>), never inside the world folder (Foundry serves that folder, so a .git
// there would be downloadable), and the world folder is the work tree. One run = `git add -A`, a commit when
// anything changed, create the GitHub repository if it is missing (and allowed), `git push`. The token reaches git
// through a credential helper in the environment: it is never on a command line, in a URL, in a log line or in
// the status file. Results go to <STATE_DIR>/status.json, which the administration page shows.
//
// With github.releases on, every commit also carries .github/workflows/release-world.yml (from src/templates), which
// builds an installable release of the world on GitHub. It only goes into git's index (marked skip-worktree, so
// `git add -A` leaves it alone), never into the world folder; turning the setting off removes it with the next commit.
//
// Runs are serialized (one world at a time; a world cannot be queued twice). Failures are e-mailed through the
// injected `notify`, once per failed run, and one more e-mail says when a world backs up again.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { listWorlds, folderSize } = require('./worlds.js');
const { createGithub, foundryStatus, GithubError } = require('./github.js');
const { worldRepo, worldSettings, effectiveSettings, REPO_RE } = require('./config.js');

const GIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;
const SIZE_MAX_AGE_MS = 10 * 60 * 1000;
const BRANCH = 'main';
const GIT_USER = 'Foundry world backup';
const GIT_EMAIL = 'foundry-world-backup@localhost';
// The credential helper git calls for the push: the token is read from the environment of that git process.
// The release workflow: where it goes in the repository and the template it comes from.
const RELEASE_WORKFLOW = '.github/workflows/release-world.yml';
const RELEASE_TEMPLATE = path.join(__dirname, 'templates', 'release-world.yml');
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$FWB_GITHUB_TOKEN"; }; f';

class BackupError extends Error {}

/** Runs a command; resolves { stdout, stderr, code }. Never throws for a non-zero exit (the caller decides). */
function defaultRun(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, ...options }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const detail = err && typeof err.code !== 'number' ? `${err.code || err.message}` : '';
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') + (detail ? `\n${detail}` : ''), code });
    });
  });
}

/** Rewrites a JSON file atomically (temp file + rename) in a folder the service owns. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadStatus(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const worlds = raw && typeof raw === 'object' && raw.worlds && typeof raw.worlds === 'object' ? raw.worlds : {};
    const out = Object.create(null);
    for (const id of Object.keys(worlds)) if (worlds[id] && typeof worlds[id] === 'object') out[id] = worlds[id];
    return { worlds: out };
  } catch {
    return { worlds: Object.create(null) };
  }
}

/** The first lines of git's output that say what went wrong, trimmed for the status file and the e-mail. */
function gitDetail(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(hint:|To https:\/\/|\s*!\s*\[)/.test(l));
  return lines.slice(0, 4).join(' | ').slice(0, MAX_ERROR_CHARS);
}

/**
 * dataDir: FOUNDRY_DATA; stateDir: writable folder for repos/ and status.json; getConfig() => the current config;
 * getToken() => the GitHub token in use; getOwner() => the token's GitHub login (null until known);
 * getFoundryUrl() => where Foundry answers /api/status ('' = never ask; default: the fixed foundryUrl);
 * notify(subject, text) mails the recipients; run / fetchImpl / now / log are injected for the tests.
 */
function createBackups({
  dataDir,
  stateDir,
  getConfig,
  getToken,
  getOwner,
  foundryUrl = '',
  getFoundryUrl = () => foundryUrl,
  gitBin = 'git',
  // the URL git pushes to; the tests point it at a local repository
  remoteUrl = (repo) => `https://github.com/${repo}.git`,
  notify = async () => {},
  run = defaultRun,
  fetchImpl = fetch,
  now = () => new Date(),
  log = console.log,
  env = process.env,
}) {
  const github = createGithub({ fetchImpl });
  const reposDir = path.join(stateDir, 'repos');
  const statusFile = path.join(stateDir, 'status.json');
  const status = loadStatus(statusFile);
  const queue = []; // world ids waiting
  let running = null; // world id being backed up
  let worldsCache = { at: 0, list: [] };
  const sizing = new Map(); // id -> promise while a size is being summed

  function saveStatus() {
    writeJsonAtomic(statusFile, status);
  }

  function worldStatus(id) {
    if (!Object.hasOwn(status.worlds, id)) status.worlds[id] = {};
    return status.worlds[id];
  }

  /** The worlds on disk (cached for 30 s), each with its status, size and effective settings. */
  function worlds({ fresh = false } = {}) {
    const t = now().getTime();
    if (fresh || t - worldsCache.at > 30000) {
      worldsCache = { at: t, list: listWorlds(dataDir) };
    }
    const config = getConfig();
    const owner = getOwner();
    return worldsCache.list.map((w) => {
      const s = worldStatus(w.id);
      const eff = effectiveSettings(config, w.id);
      const own = worldSettings(config, w.id);
      if (!s.size || t - Date.parse(s.sizeAt || 0) > SIZE_MAX_AGE_MS) refreshSize(w);
      return {
        ...w,
        enabled: eff.enabled,
        schedule: eff.schedule,
        customSchedule: eff.custom,
        whenActive: eff.whenActive,
        ownWhenActive: own.whenActive,
        ownRepo: own.repo,
        repo: worldRepo(config, w.id, owner),
        size: s.size === undefined ? null : s.size,
        sizeAt: s.sizeAt || null,
        lastAttempt: s.lastAttempt || null,
        lastSuccess: s.lastSuccess || null,
        lastResult: s.lastResult || null,
        lastError: s.lastError || '',
        commit: s.commit || null,
        changed: s.changed === undefined ? null : s.changed,
        wasActive: s.wasActive === true,
        running: running === w.id,
        queued: queue.includes(w.id),
      };
    });
  }

  function refreshSize(world) {
    if (sizing.has(world.id)) return sizing.get(world.id);
    const p = folderSize(world.folder).then((size) => {
      const s = worldStatus(world.id);
      s.size = size;
      s.sizeAt = now().toISOString();
      saveStatus();
    }).catch((err) => log(`${world.id}: size not summed (${err.message})`)).finally(() => sizing.delete(world.id));
    sizing.set(world.id, p);
    return p;
  }

  function git(world, args, extraEnv = {}) {
    const gitDir = path.join(reposDir, world.id);
    const childEnv = {
      ...env,
      HOME: env.HOME || stateDir,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: world.folder,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      LC_ALL: 'C',
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: GIT_USER,
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: GIT_EMAIL,
      GIT_CONFIG_KEY_2: 'core.autocrlf',
      GIT_CONFIG_VALUE_2: 'false',
      // an empty value resets the helper list (system or global helpers would prompt or use another login)
      GIT_CONFIG_KEY_3: 'credential.helper',
      GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'credential.helper',
      GIT_CONFIG_VALUE_4: CREDENTIAL_HELPER,
      ...extraEnv,
    };
    return run(gitBin, args, { cwd: world.folder, env: childEnv, timeout: GIT_TIMEOUT_MS });
  }

  /** Scrubs the token from text that ends up in the status file, a log line or an e-mail. */
  function scrub(text) {
    const token = getToken();
    return token ? String(text).split(token).join('[token]') : String(text);
  }

  async function gitOk(world, args, what, extraEnv) {
    const result = await git(world, args, extraEnv);
    if (result.code !== 0) throw new BackupError(`${what} failed: ${scrub(gitDetail(result)) || `git exited with ${result.code}`}`);
    return result;
  }

  /** The repository the world goes to, checked and created if needed. Returns owner/name. */
  async function ensureRepo(world, token) {
    const config = getConfig();
    const owner = getOwner();
    const repo = worldRepo(config, world.id, owner);
    if (!REPO_RE.test(repo)) {
      throw new BackupError(owner ? `invalid repository name "${repo}"` : 'the GitHub token has not been confirmed yet (run "Test setup")');
    }
    let info;
    try {
      info = await github.repoInfo(repo, token);
    } catch (err) {
      if (err instanceof GithubError) throw new BackupError(`GitHub: ${err.message}`);
      throw err;
    }
    if (info.exists) {
      if (!info.canPush) throw new BackupError(`the token may not push to ${repo} (it needs Contents: read and write there)`);
      if (!info.private) log(`${world.id}: WARNING: ${repo} is a public repository`);
      return repo;
    }
    if (!config.github.createRepos) throw new BackupError(`repository ${repo} does not exist (create it on GitHub, or turn on "create repositories")`);
    const [repoOwner, name] = repo.split('/');
    if (owner && repoOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new BackupError(`repository ${repo} does not exist and it is not under the token's account (${owner}), so it cannot be created here`);
    }
    try {
      await github.createRepo(name, token, { description: `Backup of the Foundry VTT world "${world.title}" (${world.id})` });
    } catch (err) {
      if (err instanceof GithubError) throw new BackupError(err.message);
      throw err;
    }
    log(`${world.id}: created the private repository ${repo}`);
    return repo;
  }

  /** Puts the release workflow into the index (not the world folder) and marks it so `git add -A` keeps it. */
  async function stageReleaseWorkflow(world) {
    const blob = (await gitOk(world, ['hash-object', '-w', '--no-filters', '--', RELEASE_TEMPLATE], 'git hash-object')).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new BackupError('git hash-object returned no object id for the release workflow');
    await gitOk(world, ['update-index', '--add', '--cacheinfo', `100644,${blob},${RELEASE_WORKFLOW}`], 'git update-index');
    await gitOk(world, ['update-index', '--skip-worktree', '--', RELEASE_WORKFLOW], 'git update-index');
  }

  /** One backup of one world; returns the status entry. Throws BackupError with a message safe to show. */
  async function backupOnce(world, { reason }) {
    const token = getToken();
    if (!token) throw new BackupError('no GitHub token');
    if (!world.readable) throw new BackupError(`cannot read the world folder (${world.problem})`);
    const s = worldStatus(world.id);
    const settings = effectiveSettings(getConfig(), world.id);
    const foundry = await foundryStatus(getFoundryUrl(), fetchImpl);
    const active = foundry.active && foundry.world === world.id;
    if (active && settings.whenActive === 'skip') {
      return { skipped: `the world is active in Foundry (its settings say to wait)` };
    }
    const gitDir = path.join(reposDir, world.id);
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(reposDir, { recursive: true, mode: 0o700 });
      await gitOk(world, ['init', '-q', '--initial-branch', BRANCH], 'git init');
    }
    const releases = getConfig().github.releases === true;
    // off: drop the index-only copy first, so a file of that name in the world folder itself is still backed up
    if (!releases) await gitOk(world, ['update-index', '--force-remove', '--', RELEASE_WORKFLOW], 'git update-index');
    await gitOk(world, ['add', '-A', '--', '.'], 'git add');
    if (releases) await stageReleaseWorkflow(world);
    const changes = await gitOk(world, ['status', '--porcelain', '--untracked-files=no'], 'git status');
    const hasHead = (await git(world, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    const changed = changes.stdout.trim() !== '' || !hasHead;
    if (changed) {
      const when = now().toISOString();
      const message = `Backup of ${world.title} (${world.id}) ${when}\n\nFoundry VTT world backup, ${reason}` +
        (active ? '. The world was active in Foundry during the backup.' : '.');
      await gitOk(world, ['commit', '-q', '--no-verify', '-m', message], 'git commit');
    }
    const repo = await ensureRepo(world, token);
    const pushed = await git(world, ['push', '-q', remoteUrl(repo), `HEAD:refs/heads/${BRANCH}`], { FWB_GITHUB_TOKEN: token });
    if (pushed.code !== 0) {
      // GitHub's reason for refusing a workflow file is only in the "! [remote rejected]" line, which gitDetail drops
      if (/refusing to allow .*workflow/i.test(`${pushed.stderr}\n${pushed.stdout}`)) {
        throw new BackupError('git push failed: GitHub refuses the release workflow file because the token lacks ' +
          '"Workflows: read and write" (a classic token: the workflow scope); give the token that permission or turn ' +
          '"Publish releases" off');
      }
      throw new BackupError(`git push failed: ${scrub(gitDetail(pushed)) || `git exited with ${pushed.code}`}`);
    }
    const head = (await gitOk(world, ['rev-parse', 'HEAD'], 'git rev-parse')).stdout.trim();
    s.commit = /^[0-9a-f]{40}$/.test(head) ? head : null;
    s.changed = changed;
    s.repo = repo;
    s.wasActive = active;
    return {};
  }

  /** Runs one world's backup, records the result and sends the e-mails. */
  async function runOne(id, { reason, scheduled }) {
    const world = worlds({ fresh: true }).find((w) => w.id === id);
    const s = worldStatus(id);
    const started = now();
    s.lastAttempt = started.toISOString();
    if (scheduled) s.lastScheduled = scheduled;
    const previous = s.lastResult;
    let outcome;
    try {
      if (!world) throw new BackupError('the world folder is gone');
      outcome = await backupOnce(world, { reason });
      if (outcome.skipped) {
        s.lastResult = 'skipped';
        s.lastError = outcome.skipped;
        log(`${id}: skipped (${outcome.skipped})`);
      } else {
        s.lastResult = 'ok';
        s.lastSuccess = now().toISOString();
        s.lastError = '';
        log(`${id}: backed up to ${s.repo} (${s.changed ? 'new commit' : 'no changes'}, ${reason})`);
      }
    } catch (err) {
      const message = scrub(err instanceof BackupError ? err.message : `internal error: ${err.message}`).slice(0, MAX_ERROR_CHARS);
      s.lastResult = 'error';
      s.lastError = message;
      log(`${id}: backup FAILED (${message})`);
    }
    saveStatus();
    if (world) refreshSize(world);
    const title = world ? world.title : id;
    try {
      if (s.lastResult === 'error') {
        await notify(`backup of ${title} failed`,
          `The backup of the Foundry world "${title}" (${id}) to GitHub failed:\n\n${s.lastError}\n\n` +
          `Started ${started.toISOString()} (${reason}). The next scheduled run tries again; "Back up now" on the ` +
          'administration page starts one at once.\n');
      } else if (s.lastResult === 'ok' && previous === 'error') {
        await notify(`backup of ${title} OK again`, `The backup of the Foundry world "${title}" (${id}) to GitHub works again.\n`);
      }
    } catch (err) {
      log(`${id}: notification e-mail not sent (${scrub(err.message)})`);
    }
    return s;
  }

  let draining = null;
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (queue.length) {
        const { id, options } = queue.shift();
        running = id;
        try {
          await runOne(id, options);
        } catch (err) {
          log(`${id}: backup crashed (${scrub(err.message)})`);
        } finally {
          running = null;
        }
      }
      draining = null;
    })();
    return draining;
  }

  /**
   * Queues a backup; returns { queued: true } or { queued: false, reason }. reason: for the commit message;
   * scheduled: the slot time (ISO) a scheduled run is for.
   */
  function enqueue(id, { reason = 'manual run', scheduled = null } = {}) {
    if (running === id || queue.some((q) => q.id === id)) return { queued: false, reason: 'a backup of this world is already running or queued' };
    queue.push({ id, options: { reason, scheduled } });
    drain();
    return { queued: true };
  }

  /** Waits for the queue to empty (tests and the scheduler's shutdown). */
  const idle = () => (draining ? draining : Promise.resolve());

  /** Forgets a world's status and local git copy (the GitHub repository stays). */
  function forget(id) {
    if (running === id || queue.some((q) => q.id === id)) throw new BackupError('a backup of this world is running or queued');
    delete status.worlds[id];
    saveStatus();
    fs.rmSync(path.join(reposDir, id), { recursive: true, force: true });
  }

  /** `git --version`: '' when git is usable, else what is wrong. */
  async function gitProblem() {
    const result = await run(gitBin, ['--version'], { env: { ...env, LC_ALL: 'C' }, timeout: 20000 });
    if (result.code !== 0) return `cannot run ${gitBin} (${gitDetail(result) || `exit ${result.code}`}); install git`;
    const m = /git version (\d+)\.(\d+)/.exec(result.stdout);
    if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 31))) {
      return `${result.stdout.trim()} is too old; git 2.31 or newer is needed`;
    }
    return '';
  }

  return {
    worlds,
    enqueue,
    idle,
    forget,
    gitProblem,
    refreshSize,
    statusOf: (id) => ({ ...worldStatus(id) }),
    isBusy: () => running !== null || queue.length > 0 || sizing.size > 0,
    statusFile,
    reposDir,
  };
}

module.exports = { createBackups, loadStatus, gitDetail, BackupError, CREDENTIAL_HELPER, BRANCH, RELEASE_WORKFLOW, RELEASE_TEMPLATE };

'use strict';
// config.json: the backup schedule, the GitHub repository settings and the per-world settings, validated here and
// edited on the administration page (which writes the file back in place). Worlds that are not listed get the
// defaults (enabled, the global schedule, a repository named after the world), so a new world is backed up without
// any setup.
//
//   {
//     "schedule": { "frequency": "daily", "time": "04:00", "weekday": 0, "everyHours": 6 },
//     "github": { "repoPrefix": "foundry-world-", "createRepos": true, "releases": false },
//     "whenActive": "backup",
//     "foundry": { "url": "http://localhost:30000" },
//     "worlds": {
//       "my-world": { "enabled": true, "repo": "owner/name", "schedule": null, "whenActive": "" }
//     }
//   }
//
// frequency: "hourly" (every everyHours hours, counted from midnight), "daily" (at time) or "weekly" (weekday 0 =
// Sunday ... 6 = Saturday, at time); times are local. whenActive: what to do when Foundry has the world launched at
// backup time, "backup" (back it up anyway, noted in the commit) or "skip" (wait for the next run). A world's
// "schedule" or "whenActive" overrides the global one; "" / null means "use the global setting"; "repo" ""
// means <token owner>/<repoPrefix><world id>. github.releases: every backup commit also carries the GitHub Actions
// workflow that builds an installable release of the world (src/templates/release-world.yml). foundry.url: where Foundry answers /api/status (which world is active);
// absent / null = FOUNDRY_URL from the environment, "" = never ask.

const fs = require('node:fs');

const FREQUENCIES = new Set(['hourly', 'daily', 'weekly']);
const WHEN_ACTIVE = new Set(['backup', 'skip']);
const WORLD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const REPO_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const PREFIX_RE = /^[A-Za-z0-9_.-]{0,60}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_URL_LENGTH = 500;
const MAX_WORLDS = 500;

class ConfigError extends Error {}

function defaultSchedule() {
  return { frequency: 'daily', time: '04:00', weekday: 0, everyHours: 6 };
}

function defaultConfig() {
  return {
    schedule: defaultSchedule(),
    github: { repoPrefix: 'foundry-world-', createRepos: true, releases: false },
    whenActive: 'backup',
    foundry: { url: null },
    worlds: Object.create(null),
  };
}

function defaultWorld() {
  return { enabled: true, repo: '', schedule: null, whenActive: '' };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function knownKeys(obj, keys, make, what) {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw make(`${what} has unknown key "${key}"`);
  }
}

/** Validates a schedule object; throws make(message), returns a clean copy with every field present. */
function cleanSchedule(raw, make, what = '"schedule"') {
  const out = defaultSchedule();
  if (raw === undefined) return out;
  if (!isObject(raw)) throw make(`${what} must be an object`);
  knownKeys(raw, ['frequency', 'time', 'weekday', 'everyHours'], make, what);
  if (raw.frequency !== undefined) {
    if (!FREQUENCIES.has(raw.frequency)) throw make(`${what}: frequency must be hourly, daily or weekly`);
    out.frequency = raw.frequency;
  }
  if (raw.time !== undefined) {
    if (typeof raw.time !== 'string' || !TIME_RE.test(raw.time)) throw make(`${what}: time must be HH:MM`);
    out.time = raw.time;
  }
  if (raw.weekday !== undefined) {
    if (!Number.isInteger(raw.weekday) || raw.weekday < 0 || raw.weekday > 6) {
      throw make(`${what}: weekday must be 0 (Sunday) to 6 (Saturday)`);
    }
    out.weekday = raw.weekday;
  }
  if (raw.everyHours !== undefined) {
    if (!Number.isInteger(raw.everyHours) || raw.everyHours < 1 || raw.everyHours > 24 || 24 % raw.everyHours !== 0) {
      throw make(`${what}: everyHours must divide 24 (1, 2, 3, 4, 6, 8, 12 or 24)`);
    }
    out.everyHours = raw.everyHours;
  }
  return out;
}

/**
 * Validates Foundry's address: null / undefined = not set (FOUNDRY_URL applies), "" = off, otherwise an http(s) URL
 * without user name or password. Returns the trimmed URL, '' or null; throws make(message).
 */
function cleanFoundryUrl(raw, make, what = '"foundry": url') {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw make(`${what} must be a string`);
  const url = raw.trim();
  if (url === '') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw make(`${what} is not a valid address (e.g. http://localhost:30000)`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw make(`${what} must start with http:// or https://`);
  if (parsed.username || parsed.password) throw make(`${what} must not contain a user name or password`);
  if (parsed.search || parsed.hash) throw make(`${what} must not contain "?" or "#"`);
  if (url.length > MAX_URL_LENGTH) throw make(`${what} is too long (at most ${MAX_URL_LENGTH} characters)`);
  return url;
}

/** Validates one world's settings; "" / null / undefined fields mean "use the global setting". */
function cleanWorld(id, raw, make) {
  const what = `world "${id}"`;
  const out = defaultWorld();
  if (raw === undefined) return out;
  if (!isObject(raw)) throw make(`${what} must be an object`);
  knownKeys(raw, ['enabled', 'repo', 'schedule', 'whenActive'], make, what);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw make(`${what}: enabled must be true or false`);
    out.enabled = raw.enabled;
  }
  if (raw.repo !== undefined && raw.repo !== null && raw.repo !== '') {
    if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) throw make(`${what}: repo must be owner/name`);
    out.repo = raw.repo;
  }
  if (raw.schedule !== undefined && raw.schedule !== null) out.schedule = cleanSchedule(raw.schedule, make, `${what}: schedule`);
  if (raw.whenActive !== undefined && raw.whenActive !== null && raw.whenActive !== '') {
    if (!WHEN_ACTIVE.has(raw.whenActive)) throw make(`${what}: whenActive must be backup or skip`);
    out.whenActive = raw.whenActive;
  }
  return out;
}

/** Parses config.json text into { schedule, github, whenActive, foundry, worlds }; throws ConfigError on anything off. */
function parseConfig(text, source = 'config') {
  const make = (msg) => new ConfigError(`${source}: ${msg}`);
  let raw;
  try {
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    throw make(`not valid JSON (${err.message})`);
  }
  if (!isObject(raw)) throw make('top level must be an object');
  knownKeys(raw, ['schedule', 'github', 'whenActive', 'foundry', 'worlds'], make, 'config');
  const out = defaultConfig();
  out.schedule = cleanSchedule(raw.schedule, make);
  if (raw.github !== undefined) {
    if (!isObject(raw.github)) throw make('"github" must be an object');
    knownKeys(raw.github, ['repoPrefix', 'createRepos', 'releases'], make, '"github"');
    if (raw.github.repoPrefix !== undefined) {
      if (typeof raw.github.repoPrefix !== 'string' || !PREFIX_RE.test(raw.github.repoPrefix)) {
        throw make('"github": repoPrefix may only contain letters, digits, "-", "_" and "." (at most 60)');
      }
      out.github.repoPrefix = raw.github.repoPrefix;
    }
    if (raw.github.createRepos !== undefined) {
      if (typeof raw.github.createRepos !== 'boolean') throw make('"github": createRepos must be true or false');
      out.github.createRepos = raw.github.createRepos;
    }
    if (raw.github.releases !== undefined) {
      if (typeof raw.github.releases !== 'boolean') throw make('"github": releases must be true or false');
      out.github.releases = raw.github.releases;
    }
  }
  if (raw.whenActive !== undefined) {
    if (!WHEN_ACTIVE.has(raw.whenActive)) throw make('whenActive must be backup or skip');
    out.whenActive = raw.whenActive;
  }
  if (raw.foundry !== undefined && raw.foundry !== null) {
    if (!isObject(raw.foundry)) throw make('"foundry" must be an object');
    knownKeys(raw.foundry, ['url'], make, '"foundry"');
    out.foundry.url = cleanFoundryUrl(raw.foundry.url, make);
  }
  if (raw.worlds !== undefined) {
    if (!isObject(raw.worlds)) throw make('"worlds" must be an object mapping world ids to their settings');
    const ids = Object.keys(raw.worlds);
    if (ids.length > MAX_WORLDS) throw make(`at most ${MAX_WORLDS} worlds`);
    for (const id of ids) {
      if (!WORLD_ID_RE.test(id)) throw make(`invalid world id "${id}"`);
      out.worlds[id] = cleanWorld(id, raw.worlds[id], make);
    }
  }
  return out;
}

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${err.message}`);
  }
  return parseConfig(text, file);
}

/** The JSON written to config.json: only settings that differ from the defaults, so the file stays readable. */
function serializeConfig(config) {
  const worlds = {};
  for (const id of Object.keys(config.worlds).sort()) {
    const w = config.worlds[id];
    const entry = {};
    if (!w.enabled) entry.enabled = false;
    if (w.repo) entry.repo = w.repo;
    if (w.schedule) entry.schedule = w.schedule;
    if (w.whenActive) entry.whenActive = w.whenActive;
    if (Object.keys(entry).length) worlds[id] = entry;
  }
  const github = { repoPrefix: config.github.repoPrefix, createRepos: config.github.createRepos };
  if (config.github.releases) github.releases = true;
  const out = { schedule: config.schedule, github, whenActive: config.whenActive };
  if (config.foundry && config.foundry.url !== null) out.foundry = { url: config.foundry.url };
  out.worlds = worlds;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The settings of a world: its own entry or the defaults. */
function worldSettings(config, id) {
  return Object.hasOwn(config.worlds, id) ? config.worlds[id] : defaultWorld();
}

/** The repository a world is backed up to: its own, or <owner>/<prefix><id> (owner '' when the token's owner is not known yet). */
function worldRepo(config, id, owner) {
  const w = worldSettings(config, id);
  if (w.repo) return w.repo;
  return `${owner || ''}/${config.github.repoPrefix}${id}`;
}

/** The schedule and active-world rule that apply to a world. */
function effectiveSettings(config, id) {
  const w = worldSettings(config, id);
  return {
    enabled: w.enabled,
    schedule: w.schedule || config.schedule,
    whenActive: w.whenActive || config.whenActive,
    custom: Boolean(w.schedule),
  };
}

module.exports = {
  parseConfig,
  loadConfig,
  serializeConfig,
  defaultConfig,
  defaultSchedule,
  defaultWorld,
  cleanSchedule,
  cleanFoundryUrl,
  worldSettings,
  worldRepo,
  effectiveSettings,
  ConfigError,
  WORLD_ID_RE,
  REPO_RE,
  REPO_NAME_RE,
};

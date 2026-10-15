'use strict';
// The password-protected administration page (served under /_admin on the admin port) and its settings file,
// admin.json:
//
//   { "passwordHash": "scrypt$16384$8$1$<salt>$<hash>",
//     "notify": { "recipients": ["you@example.com"],
//                 "smtp": { "host": "smtp.example.com", "port": 587, "security": "starttls",
//                           "user": "...", "password": "...", "from": "backup@example.com" } } }
//
// The page is off unless admin.json holds a password hash. "notify" is used for the failed-backup e-mails (and by
// src/notify.js for the auto-updater's) and edited on the page. The page lists the worlds with their backup status,
// changes the schedule and the per-world settings (written to config.json in place), starts a backup, replaces the
// GitHub token (the GITHUB_TOKEN line of the env file is rewritten in place, see replaceEnvValue) and runs "Test
// setup". The file is created by the installers (`node src/admin.js setup FILE`) and only ever rewritten in place:
// the service's account may write it but cannot create files in the settings folder.
//
//   node src/admin.js setup FILE   create FILE if missing, then apply the FOUNDRY_BACKUP_* variables that are set:
//                                  FOUNDRY_BACKUP_ADMIN_PASSWORD, FOUNDRY_BACKUP_NOTIFY_EMAILS (comma separated),
//                                  FOUNDRY_BACKUP_SMTP_HOST, _PORT, _SECURITY, _USER, _PASSWORD, _FROM
//   node src/admin.js check FILE   exit 0 when FILE has a password hash (the page is on), 3 when not, 1 on error
//
// Secrets come from the environment, never from the command line, and are never printed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { sendMail, isEmail, smtpProblem } = require('./mailer.js');
const { ConfigError, WORLD_ID_RE, cleanFoundryUrl } = require('./config.js');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;
const MAX_RECIPIENTS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
// Across all addresses: more failed logins than this within GLOBAL_WINDOW_MS pause every login for that long.
const GLOBAL_FAILURES = 50;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
// "Update now" can be pressed again after this long (the update itself takes a minute or two).
const UPDATE_COOLDOWN_MS = 2 * 60 * 1000;
const COOKIE = 'fwb_admin';
const PREFIX = '/_admin';
const SMTP_KEYS = ['host', 'port', 'security', 'user', 'password', 'from'];
// GitHub tokens (github_pat_..., ghp_..., 40 hex digits of an old classic token): letters, digits and "_" only, so a
// token can never break out of its line in the env file.
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const UI_FILES = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/logo.png': { file: 'logo.png', type: 'image/png' },
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

class SettingsError extends Error {}

// A client error in an admin API call: answered with its status and message.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Default notification settings: nobody to notify. */
function defaultNotify() {
  return {
    recipients: [],
    smtp: { host: '', port: 587, security: 'starttls', user: '', password: '', from: '' },
  };
}

/** Validates notification settings; throws `make(message)` on the first problem, returns a clean copy. */
function cleanNotify(raw, make) {
  const out = defaultNotify();
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw make('"notify" must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'recipients' && key !== 'smtp') throw make(`"notify" has unknown key "${key}"`);
  }
  if (raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) throw make('"recipients" must be a list of e-mail addresses');
    const seen = new Set();
    for (const r of raw.recipients) {
      const address = typeof r === 'string' ? r.trim() : r;
      if (!isEmail(address)) throw make(`invalid e-mail address "${String(r).slice(0, 100)}"`);
      if (!seen.has(address.toLowerCase())) out.recipients.push(address);
      seen.add(address.toLowerCase());
    }
    if (out.recipients.length > MAX_RECIPIENTS) throw make(`at most ${MAX_RECIPIENTS} recipients`);
  }
  const smtp = raw.smtp;
  if (smtp !== undefined) {
    if (smtp === null || typeof smtp !== 'object' || Array.isArray(smtp)) throw make('"smtp" must be an object');
    for (const key of Object.keys(smtp)) {
      if (!SMTP_KEYS.includes(key)) throw make(`"smtp" has unknown key "${key}"`);
    }
    for (const key of ['host', 'user', 'password', 'from']) {
      if (smtp[key] === undefined) continue;
      if (typeof smtp[key] !== 'string' || /[\r\n\0]/.test(smtp[key]) || smtp[key].length > 1024) {
        throw make(`invalid SMTP ${key}`);
      }
      out.smtp[key] = key === 'password' ? smtp[key] : smtp[key].trim();
    }
    if (smtp.port !== undefined) out.smtp.port = smtp.port;
    if (smtp.security !== undefined) out.smtp.security = smtp.security;
    // Everything but a missing host (= no mail server yet) must be valid.
    if (out.smtp.host) {
      const problem = smtpProblem(out.smtp);
      if (problem) throw make(problem);
    } else if (!Number.isInteger(out.smtp.port) || out.smtp.port < 1 || out.smtp.port > 65535) {
      throw make('invalid SMTP port');
    } else if (!['starttls', 'tls', 'none'].includes(out.smtp.security)) {
      throw make('SMTP security must be starttls, tls or none');
    } else if (out.smtp.from && !isEmail(out.smtp.from)) {
      throw make('invalid sender address');
    }
  }
  return out;
}

/** Parses admin.json text into { passwordHash, notify }. */
function parseAdminSettings(text, source = 'admin settings') {
  const make = (msg) => new SettingsError(`${source}: ${msg}`);
  let raw;
  try {
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    throw make(`not valid JSON (${err.message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw make('top level must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'passwordHash' && key !== 'notify') throw make(`unknown key "${key}"`);
  }
  let passwordHash = '';
  if (raw.passwordHash !== undefined && raw.passwordHash !== '') {
    if (typeof raw.passwordHash !== 'string' || !parseHash(raw.passwordHash)) throw make('invalid "passwordHash"');
    passwordHash = raw.passwordHash;
  }
  return { passwordHash, notify: cleanNotify(raw.notify, make) };
}

/** Reads admin.json; a missing file means "no admin page, nobody to notify". */
function loadAdminSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { passwordHash: '', notify: defaultNotify(), missing: true };
    throw new SettingsError(`cannot read ${file}: ${err.message}`);
  }
  return parseAdminSettings(text, file);
}

function serializeAdminSettings(settings) {
  return `${JSON.stringify({ passwordHash: settings.passwordHash || undefined, notify: settings.notify }, null, 2)}\n`;
}

/**
 * Replaces the contents of an existing file without creating a new one (the service cannot create files in its
 * settings folder, so there is no temp-file-and-rename; the files are small enough for a single write).
 */
function rewriteFile(file, text) {
  const data = Buffer.from(text, 'utf8');
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function parseHash(text) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bounds keep a tampered file from making every login take minutes.
  if (N < 1024 || N > 1048576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(m[4], 'base64');
  const hash = Buffer.from(m[5], 'base64');
  if (salt.length < 16 || hash.length < 32 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

/** Checks a GitHub token typed on the page; returns an error message or ''. */
function tokenProblem(token) {
  if (typeof token !== 'string' || token === '') return 'paste the new token first';
  if (/REPLACE_ME/.test(token)) return 'that is the placeholder, not a token';
  if (!TOKEN_RE.test(token)) return 'that does not look like a GitHub token (letters, digits and "_" only, 20 to 255 characters)';
  return '';
}

/** What kind of token this is, from its prefix (shown instead of the token). */
function tokenKind(token) {
  if (/^github_pat_/.test(token)) return 'fine-grained personal access token';
  if (/^ghp_/.test(token)) return 'classic personal access token';
  if (/^gh[ousr]_/.test(token)) return 'GitHub App or OAuth token';
  return 'GitHub token';
}

/**
 * Env-file text with KEY set to VALUE: the first KEY= line is replaced and any later ones dropped (the last one would
 * win), everything else and the line endings stay as they are. null when the text has no KEY= line.
 */
function replaceEnvValue(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let found = false;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || m[1] !== key) out.push(line);
    else if (!found) {
      out.push(`${key}=${value}`);
      found = true;
    }
  }
  return found ? out.join(eol) : null;
}

/** Checks a new password's length; returns an error message or ''. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `the password needs at least ${MIN_PASSWORD} characters`;
  }
  if (password.length > MAX_PASSWORD) return 'the password is too long';
  return '';
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(String(password).normalize('NFC'), salt, keylen, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const h = parseHash(stored || '');
  if (!h || typeof password !== 'string' || password.length > MAX_PASSWORD) return false;
  const got = await scrypt(password.normalize('NFC'), h.salt, h.hash.length, {
    N: h.N,
    r: h.r,
    p: h.p,
    maxmem: 256 * h.N * h.r + 1024 * 1024,
  });
  return crypto.timingSafeEqual(got, h.hash);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Host names a request for the admin page may carry (a guard against DNS rebinding). */
function allowedHosts(extra = []) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const h of extra) if (h) hosts.add(String(h).trim().toLowerCase());
  return hosts;
}

let machineCache = { at: 0, names: new Set() };
/** This machine's host name (and name.local) and IP addresses: a browser on the LAN may use any of them. */
function machineHosts(now) {
  if (now - machineCache.at < 30000) return machineCache.names;
  const names = new Set();
  const host = os.hostname().toLowerCase();
  names.add(host);
  if (!host.includes('.')) names.add(`${host}.local`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const addr = a.address.replace(/%.*$/, '').toLowerCase();
      names.add(a.family === 'IPv6' || a.family === 6 ? `[${addr}]` : addr);
    }
  }
  machineCache = { at: now, names };
  return names;
}

function hostOf(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The /_admin handler.
 *   backups: createBackups() (worlds(), enqueue(), forget(), isBusy()); scheduler: createScheduler() (nextRun(id));
 *   getConfig() => the current config; saveConfig(raw) validates the would-be config.json and writes it (throws
 *   ConfigError on bad input);
 *   githubToken (none of these ever return the token):
 *     info() => { kind, file, problem, owner }   problem = '' when a new token can be saved to file
 *     check(token) => { status, message, ... }  what GitHub says about the token (status 'bad' = refused or unreachable)
 *     save(token)                               writes it to file and switches the service over
 *     test(token) => { token, checks }          the token, git, the data folder, Foundry and every world's repository
 *   serviceUpdate: { version, info(), problem(), request() } – "Update now" only asks the root/SYSTEM updater to run.
 *   foundry: { defaultUrl, url(), test(url) } – Foundry's address from FOUNDRY_URL, the one in use, and its check
 *     ({ status, message }).
 *   paths: { dataDir, stateDir } shown on the page.
 * Returns { handles(pathname), handle(req, res, pathname) }.
 */
function createAdmin({
  adminFile,
  settings,
  backups,
  scheduler,
  getConfig,
  saveConfig,
  githubToken,
  serviceUpdate,
  foundry,
  paths = {},
  extraHosts = [],
  trustProxy = false,
  log = console.log,
  mailer = sendMail,
  now = Date.now,
}) {
  const hosts = allowedHosts(extraHosts);
  const sessions = new Map(); // id -> { csrf, expires }
  const failures = new Map(); // remote address -> { count, until }
  let globalFailures = []; // times of recent failed logins, any address
  let updateRequestedAt = 0;
  // DNS rebinding sends the attacker's own name; this machine's names and addresses (LAN access) are fine.
  const hostAllowed = (h) => hosts.has(h) || machineHosts(now()).has(h);
  const ui = Object.create(null);
  for (const [route, { file, type }] of Object.entries(UI_FILES)) {
    ui[route] = { body: fs.readFileSync(path.join(__dirname, 'admin-ui', file)), type };
  }

  const enabled = () => Boolean(settings.passwordHash);

  function persist(next) {
    rewriteFile(adminFile, serializeAdminSettings(next));
    settings = next;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, obj, headers = {}) =>
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  function session(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (s.expires < now()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...s };
  }

  function newSession() {
    for (const [id, s] of sessions) if (s.expires < now()) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { csrf, expires: now() + SESSION_MS });
    return { id, csrf };
  }

  // Forwarded headers count only from a trusted proxy (ADMIN_TRUST_PROXY): one on this machine ("loopback", what
  // ADMIN_TRUST_PROXY=1 means) or one of the listed addresses. Anyone else could fake them to dodge the lockout.
  const trusted = trustProxy === true ? ['loopback'] : Array.isArray(trustProxy) ? trustProxy : [];
  // True when the request's peer address is a trusted reverse proxy.
  function fromProxy(req) {
    if (!trusted.length) return false;
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '').toLowerCase();
    if (trusted.includes('loopback') && (/^127\./.test(peer) || peer === '::1')) return true;
    return trusted.includes(peer);
  }

  // HTTPS: the admin listener's own TLS, or a trusted reverse proxy that says so.
  const isSecure = (req) =>
    Boolean(req.socket.encrypted) || (fromProxy(req) && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '')));

  // Behind a trusted reverse proxy the client is the last address it added to X-Forwarded-For.
  function clientIp(req) {
    const fwd = fromProxy(req) ? String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
    return fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress || '?';
  }

  // The session cookie; Secure when the request is HTTPS (directly, or reported by a trusted proxy).
  const cookie = (req, id, maxAge) =>
    `${COOKIE}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (isSecure(req) ? '; Secure' : '');

  function notifyView() {
    const { password, ...smtp } = settings.notify.smtp;
    return { recipients: settings.notify.recipients, smtp: { ...smtp, passwordSet: Boolean(password) } };
  }

  function tokenView() {
    if (!githubToken) return { kind: '', file: null, canChange: false, problem: 'not available', owner: null };
    const { kind, file, problem, owner } = githubToken.info();
    return { kind, file, canChange: !problem, problem, owner: owner || null };
  }

  function worldsView({ fresh = false } = {}) {
    try {
      const list = backups.worlds({ fresh });
      return { worlds: list.map((w) => ({ ...w, folder: undefined, nextRun: w.enabled ? scheduler.nextRun(w.id) : null })), worldsProblem: '' };
    } catch (err) {
      log(`admin: cannot list the worlds (${err.message})`);
      return { worlds: [], worldsProblem: err.message };
    }
  }

  function state(csrf, { fresh = false } = {}) {
    const config = getConfig();
    return {
      csrf,
      ...worldsView({ fresh }),
      settings: {
        schedule: config.schedule,
        github: config.github,
        whenActive: config.whenActive,
        // url: the saved one (null = FOUNDRY_URL applies); inUse: the address asked; defaultUrl: FOUNDRY_URL
        foundry: { url: config.foundry.url, inUse: foundry ? foundry.url() : '', defaultUrl: foundry ? foundry.defaultUrl : '' },
      },
      notify: notifyView(),
      token: tokenView(),
      version: serviceUpdate ? serviceUpdate.version : null,
      paths,
      busy: backups.isBusy(),
    };
  }

  /** The config.json that results from a change, validated and written. */
  function applyConfig(mutate, what) {
    const config = getConfig();
    const raw = JSON.parse(JSON.stringify({ schedule: config.schedule, github: config.github, whenActive: config.whenActive,
      foundry: config.foundry, worlds: config.worlds }));
    mutate(raw);
    try {
      saveConfig(raw);
    } catch (err) {
      if (err instanceof ConfigError) throw new HttpError(400, err.message.replace(/^admin: /, ''));
      throw err;
    }
    log(`admin: ${what}`);
  }

  // Checks the password, with a per-address lockout and a global pause once too many addresses fail at once.
  async function login(req, res, body) {
    const ip = clientIp(req);
    const f = failures.get(ip);
    globalFailures = globalFailures.filter((t) => t > now() - GLOBAL_WINDOW_MS);
    if ((f && f.until > now()) || globalFailures.length >= GLOBAL_FAILURES) {
      return sendJson(res, 429, { error: 'too many failed logins; try again in a few minutes' });
    }
    if (await verifyPassword(body.password, settings.passwordHash)) {
      failures.delete(ip);
      const s = newSession();
      log('admin: login');
      return sendJson(res, 200, state(s.csrf), { 'Set-Cookie': cookie(req, s.id, SESSION_MS / 1000) });
    }
    // A lockout that has run out starts the count again.
    const count = (f && !f.until ? f.count : 0) + 1;
    failures.set(ip, { count, until: count >= LOGIN_FAILURES ? now() + LOCKOUT_MS : 0 });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
    globalFailures.push(now());
    log(`admin: failed login from ${ip}`);
    return sendJson(res, 401, { error: 'wrong password' });
  }

  async function api(req, res, route, s) {
    const method = req.method;
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        throw new HttpError(415, 'expected application/json');
      }
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !hostAllowed(hostOf(origin.replace(/^[a-z]+:\/\//i, '')))) {
        throw new HttpError(403, 'cross-origin request refused');
      }
      const text = await readBody(req);
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, 'invalid JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid JSON');
    }

    if (route === '/api/login' && method === 'POST') return login(req, res, body);
    if (!s) throw new HttpError(401, 'not logged in');
    if (route === '/api/state' && method === 'GET') return sendJson(res, 200, state(s.csrf));
    if (method !== 'GET' && !sameSecret(req.headers['x-csrf-token'] || '', s.csrf)) {
      throw new HttpError(403, 'missing or wrong CSRF token; reload the page');
    }

    if (route === '/api/logout' && method === 'POST') {
      sessions.delete(s.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }

    if (route === '/api/worlds/rescan' && method === 'POST') {
      const view = state(s.csrf, { fresh: true });
      for (const w of backups.worlds()) backups.refreshSize(w);
      return sendJson(res, 200, view);
    }

    const m = /^\/api\/worlds\/([^/]+)(\/backup)?$/.exec(route);
    if (m) {
      let id;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        throw new HttpError(404, 'no such world');
      }
      if (!WORLD_ID_RE.test(id)) throw new HttpError(404, 'no such world');
      const known = backups.worlds().some((w) => w.id === id) || Object.hasOwn(getConfig().worlds, id);
      if (!known) throw new HttpError(404, 'no such world');
      if (m[2] && method === 'POST') {
        const world = backups.worlds().find((w) => w.id === id);
        if (!world) throw new HttpError(404, 'the world folder is gone');
        if (!world.enabled) throw new HttpError(409, 'this world is turned off in its settings');
        if (!world.readable) throw new HttpError(409, `the world folder cannot be read (${world.problem})`);
        const r = backups.enqueue(id, { reason: 'started on the administration page' });
        if (!r.queued) throw new HttpError(409, r.reason);
        log(`admin: backup of ${id} requested`);
        return sendJson(res, 202, { ok: true, ...state(s.csrf) });
      }
      if (!m[2] && method === 'PUT') {
        applyConfig((raw) => {
          const entry = {};
          if (body.enabled !== undefined) entry.enabled = body.enabled;
          if (typeof body.repo === 'string' && body.repo.trim()) entry.repo = body.repo.trim();
          if (body.schedule !== undefined && body.schedule !== null) entry.schedule = body.schedule;
          if (typeof body.whenActive === 'string' && body.whenActive) entry.whenActive = body.whenActive;
          raw.worlds[id] = entry;
        }, `settings of world ${id} changed`);
        return sendJson(res, 200, state(s.csrf));
      }
      if (!m[2] && method === 'DELETE') {
        try {
          backups.forget(id);
        } catch (err) {
          throw new HttpError(409, err.message);
        }
        applyConfig((raw) => {
          delete raw.worlds[id];
        }, `world ${id} forgotten (settings, status and local git copy removed)`);
        return sendJson(res, 200, state(s.csrf, { fresh: true }));
      }
    }

    if (route === '/api/settings' && method === 'PUT') {
      applyConfig((raw) => {
        if (body.schedule !== undefined) raw.schedule = body.schedule;
        if (body.github !== undefined) raw.github = body.github;
        if (body.whenActive !== undefined) raw.whenActive = body.whenActive;
        if (body.foundry !== undefined) raw.foundry = body.foundry;
      }, body.foundry !== undefined ? 'Foundry settings changed' : 'schedule / GitHub settings changed');
      return sendJson(res, 200, state(s.csrf));
    }

    if (route === '/api/notify' && method === 'PUT') {
      const smtpIn = body.smtp && typeof body.smtp === 'object' && !Array.isArray(body.smtp) ? body.smtp : {};
      const smtp = {};
      for (const key of SMTP_KEYS) if (smtpIn[key] !== undefined) smtp[key] = smtpIn[key];
      // An empty or missing password keeps the stored one; clearPassword removes it.
      if (smtp.password === undefined || smtp.password === '') smtp.password = settings.notify.smtp.password;
      if (smtpIn.clearPassword === true) smtp.password = '';
      if (typeof smtp.port === 'string' && /^\d+$/.test(smtp.port)) smtp.port = Number(smtp.port);
      const notify = cleanNotify({ recipients: body.recipients, smtp }, (msg) => new HttpError(400, msg));
      persist({ ...settings, notify });
      log(`admin: notification settings saved (${notify.recipients.length} recipient(s))`);
      return sendJson(res, 200, state(s.csrf));
    }

    if (route === '/api/notify/test' && method === 'POST') {
      const { recipients, smtp } = settings.notify;
      if (!recipients.length) throw new HttpError(400, 'add at least one recipient first');
      try {
        await mailer(smtp, {
          to: recipients,
          subject: 'Foundry world backup: test e-mail',
          text: 'This is a test e-mail from the administration page of the Foundry world backup service.\n' +
            'Failed backups and automatic-update results are sent to these addresses.\n',
        });
      } catch (err) {
        log(`admin: test e-mail failed (${err.message})`);
        throw new HttpError(502, `sending failed: ${err.message}`);
      }
      log(`admin: test e-mail sent to ${recipients.length} recipient(s)`);
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/token' && method === 'PUT') {
      if (!githubToken) throw new HttpError(404, 'not found');
      const token = typeof body.token === 'string' ? body.token.trim() : body.token;
      const problem = tokenProblem(token);
      if (problem) throw new HttpError(400, problem);
      const { problem: storage, file } = githubToken.info();
      if (storage) throw new HttpError(409, `the token cannot be changed here: ${file || 'env file'}: ${storage}`);
      // GitHub must accept it first: a mistyped token would break every backup at once.
      const check = await githubToken.check(token);
      if (check.status === 'bad') throw new HttpError(400, `not saved: ${check.message}`);
      try {
        githubToken.save(token, check.login);
      } catch (err) {
        log(`admin: saving the GitHub token to ${file} failed (${err.code || err.message})`);
        throw new HttpError(500, `could not write ${file} (${err.code || 'error'}); the old token is still in use`);
      }
      log(`admin: GitHub token changed (${tokenKind(token)}, saved to ${file})`);
      return sendJson(res, 200, state(s.csrf));
    }

    if (route === '/api/setup-test' && method === 'POST') {
      if (!githubToken) throw new HttpError(404, 'not found');
      // A token typed on the page is tested without saving it; without one, the token in use.
      const typed = typeof body.token === 'string' ? body.token.trim() : '';
      if (typed) {
        const problem = tokenProblem(typed);
        if (problem) throw new HttpError(400, problem);
      }
      const result = await githubToken.test(typed || undefined);
      const bad = result.checks.filter((c) => c.status === 'bad').length;
      log(`admin: setup test (${typed ? 'typed' : 'saved'} token): token ${result.token.status}, ${bad} problem(s) in ${result.checks.length} check(s)`);
      return sendJson(res, 200, { tested: typed ? 'typed' : 'saved', ...result });
    }

    if (route === '/api/foundry-test' && method === 'POST') {
      if (!foundry) throw new HttpError(404, 'not found');
      // An address typed on the page is tested without saving it; without one, the address in use.
      const url = cleanFoundryUrl(body.url, (msg) => new HttpError(400, msg), 'the address');
      const tested = url ? 'typed' : 'saved';
      const result = await foundry.test(url || undefined);
      log(`admin: Foundry test (${tested} address): ${result.status}`);
      return sendJson(res, 200, { tested, ...result });
    }

    if (route === '/api/update' && method === 'GET') {
      if (!serviceUpdate) throw new HttpError(404, 'not found');
      const info = await serviceUpdate.info();
      return sendJson(res, 200, { ...info, requestedAt: updateRequestedAt ? new Date(updateRequestedAt).toISOString() : null });
    }

    if (route === '/api/update' && method === 'POST') {
      if (!serviceUpdate) throw new HttpError(404, 'not found');
      const wait = updateRequestedAt + UPDATE_COOLDOWN_MS - now();
      if (wait > 0) {
        throw new HttpError(429, `an update was requested ${Math.round((now() - updateRequestedAt) / 1000)} s ago; ` +
          `try again in ${Math.ceil(wait / 1000)} s`);
      }
      const problem = await serviceUpdate.problem();
      if (problem) throw new HttpError(409, `"Update now" is not available: ${problem}`);
      try {
        await serviceUpdate.request();
      } catch (err) {
        log(`admin: requesting the update failed (${err.code || err.message})`);
        throw new HttpError(500, 'could not start the update; see the service log');
      }
      updateRequestedAt = now();
      log(`admin: update requested (installed ${serviceUpdate.version})`);
      return sendJson(res, 202, { ok: true, requestedAt: new Date(updateRequestedAt).toISOString() });
    }

    if (route === '/api/password' && method === 'PUT') {
      if (!(await verifyPassword(body.current, settings.passwordHash))) {
        throw new HttpError(403, 'the current password is wrong');
      }
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      persist({ ...settings, passwordHash: await hashPassword(body.password) });
      // Every other session ends; this one gets a fresh id.
      sessions.clear();
      const fresh = newSession();
      log('admin: password changed');
      return sendJson(res, 200, state(fresh.csrf), { 'Set-Cookie': cookie(req, fresh.id, SESSION_MS / 1000) });
    }

    throw new HttpError(404, 'not found');
  }

  return {
    /** True for every path below /_admin (answered here, or 404 while the page is off). */
    handles: (pathname) => pathname === PREFIX || pathname.startsWith(`${PREFIX}/`),

    // certificate: the admin port's self-signed certificate (PEM) when the request came in over HTTPS, else undefined.
    async handle(req, res, pathname, { certificate } = {}) {
      if (!enabled()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!hostAllowed(hostOf(req.headers.host || ''))) {
        return send(res, 403, 'admin page: unknown host name (see ADMIN_HOSTS in the README)', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      const route = pathname.slice(PREFIX.length);
      if (Object.hasOwn(ui, route)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
        }
        return send(res, 200, req.method === 'HEAD' ? undefined : ui[route].body, { 'Content-Type': ui[route].type });
      }
      if (route === '/certificate.crt' && certificate) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
        }
        return send(res, 200, req.method === 'HEAD' ? undefined : certificate, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="foundry-world-backup.crt"',
        });
      }
      if (!route.startsWith('/api/')) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      try {
        await api(req, res, route, session(req));
      } catch (err) {
        if (err instanceof HttpError) {
          if (!res.headersSent) sendJson(res, err.status, { error: err.message });
          return;
        }
        throw err;
      }
    },
  };
}

/** `node src/admin.js setup FILE`: create FILE if missing and apply the FOUNDRY_BACKUP_* variables that are set. */
async function setup(file, env) {
  let settings = { passwordHash: '', notify: defaultNotify() };
  if (fs.existsSync(file)) settings = loadAdminSettings(file);
  const changed = [];
  if (env.FOUNDRY_BACKUP_ADMIN_PASSWORD) {
    const problem = passwordProblem(env.FOUNDRY_BACKUP_ADMIN_PASSWORD);
    if (problem) throw new SettingsError(`admin password: ${problem}`);
    settings.passwordHash = await hashPassword(env.FOUNDRY_BACKUP_ADMIN_PASSWORD);
    changed.push('admin password');
  }
  const notify = { recipients: settings.notify.recipients, smtp: { ...settings.notify.smtp } };
  if (env.FOUNDRY_BACKUP_NOTIFY_EMAILS !== undefined && env.FOUNDRY_BACKUP_NOTIFY_EMAILS !== '') {
    notify.recipients = env.FOUNDRY_BACKUP_NOTIFY_EMAILS.split(/[,;\s]+/).filter(Boolean);
    changed.push('notification recipients');
  }
  for (const key of SMTP_KEYS) {
    const v = env[`FOUNDRY_BACKUP_SMTP_${key.toUpperCase()}`];
    if (v === undefined || v === '') continue;
    notify.smtp[key] = key === 'port' ? Number(v) : v;
    if (!changed.includes('SMTP settings')) changed.push('SMTP settings');
  }
  settings.notify = cleanNotify(notify, (msg) => new SettingsError(`notification settings: ${msg}`));
  const text = serializeAdminSettings(settings);
  if (fs.existsSync(file)) rewriteFile(file, text);
  else fs.writeFileSync(file, text, { mode: 0o600 });
  return changed;
}

async function cli(argv, env) {
  const [command, file] = argv;
  if (!file || (command !== 'setup' && command !== 'check')) {
    console.error('usage: node src/admin.js setup FILE | check FILE');
    return 2;
  }
  try {
    if (command === 'check') return loadAdminSettings(file).passwordHash ? 0 : 3;
    const changed = await setup(file, env);
    console.log(changed.length ? `${file}: set ${changed.join(', ')}` : `${file}: unchanged`);
    return 0;
  } catch (err) {
    console.error(`admin: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  cli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  createAdmin,
  parseAdminSettings,
  loadAdminSettings,
  serializeAdminSettings,
  rewriteFile,
  hashPassword,
  verifyPassword,
  passwordProblem,
  tokenProblem,
  tokenKind,
  replaceEnvValue,
  defaultNotify,
  setup,
  cli,
  SettingsError,
};

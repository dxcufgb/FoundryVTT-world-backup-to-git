'use strict';
// The GitHub side: what the token is good for, whether a world's repository exists and creating one when it does
// not. The token only ever goes to api.github.com (git pushes get it through a credential helper, see backup.js)
// and is never part of a result or a log line. A lookup without a token (token '') is anonymous: used for the
// service's own public release repository. No dependencies: global fetch only.

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 20000;
const EXPIRY_WARN_DAYS = 14;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

// Raised for failures talking to GitHub (network, unexpected status).
class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createGithub({ fetchImpl = fetch, userAgent = 'foundry-world-backup' } = {}) {
  const apiHeaders = (token, accept = 'application/vnd.github+json') => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  });

  async function api(pathname, token, init = {}) {
    let res;
    try {
      res = await fetchImpl(`${GITHUB_API}${pathname}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...init,
        headers: { ...apiHeaders(token), ...(init.headers || {}) },
      });
    } catch (err) {
      throw new GithubError(`could not reach GitHub (${err.name === 'TimeoutError' ? 'timeout' : err.message})`, 'network');
    }
    let body = null;
    const type = res.headers.get('content-type') || '';
    if (/json/i.test(type)) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } else {
      await res.body?.cancel?.();
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body };
  }

  /** GET /user: whether GitHub accepts the token, whose it is and when it expires. */
  async function checkToken(token) {
    let res;
    try {
      res = await api('/user', token);
    } catch (err) {
      return { status: 'bad', unreachable: true, message: err.message };
    }
    const header = res.headers.get('github-authentication-token-expiration') || '';
    const expires = /^[0-9A-Za-z :+-]{1,40}$/.test(header) ? header : null;
    const login = res.ok && res.body && typeof res.body.login === 'string' && LOGIN_RE.test(res.body.login) ? res.body.login : null;
    if (res.status === 401) return { status: 'bad', message: 'GitHub rejects the token (expired, revoked or mistyped)' };
    if (res.status === 403) {
      return { status: 'bad', message: 'GitHub did not confirm the token (HTTP 403: rate limit, or a token type that cannot read its account)' };
    }
    if (!res.ok) return { status: 'bad', message: `GitHub answered HTTP ${res.status}` };
    const days = expires ? (Date.parse(expires) - Date.now()) / 86400000 : NaN;
    const owner = login ? ` (${login})` : '';
    if (days < 0) return { status: 'bad', login, expires, message: `the token expired on ${expires}` };
    if (days < EXPIRY_WARN_DAYS) {
      const left = days < 1 ? 'within a day' : `in ${Math.floor(days)} day(s)`;
      return { status: 'warn', login, expires, message: `accepted${owner}, but it expires ${left}: replace it soon` };
    }
    return { status: 'ok', login, expires, message: `accepted${owner}` + (expires ? `; expires ${expires}` : '; no expiry date') };
  }

  /**
   * GET /repos/<repo>: { exists, private, canPush, defaultBranch } or { exists: false }. A 404 means the repository
   * does not exist or the token cannot see it (GitHub hides private repositories with 404). Without a token ('')
   * only public repositories are found.
   */
  async function repoInfo(repo, token) {
    const res = await api(`/repos/${repo}`, token);
    if (res.status === 404) return { exists: false };
    if (res.status === 401) throw new GithubError('GitHub rejects the token', 401);
    if (res.status === 403) throw new GithubError('GitHub refused access to the repository (HTTP 403)', 403);
    if (!res.ok || !res.body) throw new GithubError(`repository lookup failed (HTTP ${res.status})`, res.status);
    const perms = res.body.permissions && typeof res.body.permissions === 'object' ? res.body.permissions : {};
    return {
      exists: true,
      private: res.body.private === true,
      canPush: perms.push === true || perms.admin === true || perms.maintain === true,
      defaultBranch: typeof res.body.default_branch === 'string' ? res.body.default_branch : null,
    };
  }

  /** POST /user/repos: creates a private repository under the token's account. */
  async function createRepo(name, token, { description = '' } = {}) {
    const res = await api('/user/repos', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true, description, auto_init: false, has_issues: false, has_wiki: false, has_projects: false }),
    });
    if (res.status === 201) return;
    if (res.status === 422) {
      const detail = res.body && Array.isArray(res.body.errors) && res.body.errors[0] && res.body.errors[0].message;
      throw new GithubError(`GitHub did not create the repository "${name}": ${String(detail || 'invalid name or it already exists').slice(0, 200)}`, 422);
    }
    if (res.status === 403 || res.status === 404 || res.status === 401) {
      throw new GithubError(`GitHub did not let the token create the repository "${name}" (HTTP ${res.status}): the token needs Administration: read and write on all repositories of its account`, res.status);
    }
    throw new GithubError(`creating the repository "${name}" failed (HTTP ${res.status})`, res.status);
  }

  return { checkToken, repoInfo, createRepo };
}

/**
 * GET <foundryUrl>/api/status: the world Foundry has launched ({ reachable, active, world }); when Foundry cannot be
 * asked, { reachable: false, active: false, world: null, problem } with a short reason.
 */
async function foundryStatus(foundryUrl, fetchImpl = fetch) {
  const down = (problem) => ({ reachable: false, active: false, world: null, problem });
  if (!foundryUrl) return down('no Foundry address set');
  try {
    const res = await fetchImpl(`${foundryUrl.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      await res.body?.cancel?.();
      return down(`HTTP ${res.status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return down('the answer is not JSON (is this Foundry?)');
    }
    const world = body && typeof body.world === 'string' ? body.world : null;
    return { reachable: true, active: Boolean(body && body.active) && Boolean(world), world };
  } catch (err) {
    if (err && err.name === 'TimeoutError') return down('no answer within 5 seconds');
    const cause = err && err.cause && err.cause.code;
    return down(cause ? `cannot connect (${cause})` : 'cannot connect');
  }
}

module.exports = { createGithub, foundryStatus, GithubError, GITHUB_API };

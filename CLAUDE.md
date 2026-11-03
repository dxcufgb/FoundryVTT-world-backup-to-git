# Foundry world backup

A dependency-free Node service (`src/server.js`) that backs every world of a Foundry VTT installation up to its own
private GitHub repository on a schedule, with git: the world folder is the work tree, the git directory lives in the
service's state folder, every run commits what changed and pushes. It serves a password-protected administration
page on its own HTTPS port (8484) and e-mails failed backups. It runs as a systemd service on a Raspberry Pi next to
Foundry, or as a Windows scheduled task. An opt-in auto-updater installs new releases of the service itself. It
mirrors the design of `dxcufgb/FoundryVTT-Private-Github-proxy` (admin page, installers, updater, release flow);
the worlds table replaces the proxy's modules table.

## Layout
- `src/server.js` – `createApp(...)` wires everything: the backups, the scheduler, the admin page, the daily token check
  (`startDailyChecks`, off with `DAILY_CHECK=off`: a refused or soon-expiring token is mailed every day it lasts plus
  one "OK again" mail), "Test setup" (`testSetup`: token, git, data folder, state folder, Foundry `/api/status`, the
  release repository (public: looked up without the token first, never 'bad'), every enabled world's repository) and "Update now" (`serviceUpdate`: Linux `fileUpdateTrigger`
  rewrites `update-request`, which the installer's systemd path unit watches; Windows `taskUpdateTrigger` runs the
  SYSTEM task `FoundryWorldBackup-UpdateNow`). `readEnv` validates the environment; `main()` only runs when executed
  directly and opens the admin listener (`createAdminServer(tls)`: HTTPS, a plain-HTTP first byte gets a 301 to
  https://, `/` → `/_admin/`, and a self-signed certificate (only the certificate) at `/_admin/certificate.crt`,
  which the login page links (Chrome saves no passwords on an untrusted certificate); nothing else is served).
- `src/config.js` – `config.json`: schedule (`hourly`/`daily`/`weekly`), `github` (`repoPrefix`, `createRepos`, `releases`),
  `whenActive`, `foundry.url` (Foundry's address from the admin page; unset = `FOUNDRY_URL`, `""` = off), per-world
  settings (`enabled`, `repo`, `schedule`, `whenActive`; unlisted worlds get the defaults).
  `parseConfig`, `serializeConfig` (only non-default values are written), `worldRepo`, `effectiveSettings`.
- `src/worlds.js` – finds the worlds (`FOUNDRY_DATA`, its `Data` or `Data/worlds` folder; every folder with a
  `world.json`), reads title/system/version, sums folder sizes (symlinks not followed).
- `src/backup.js` – `createBackups`: the serialized run queue, one backup (`git init`/`add -A`/`status`/`commit`,
  repository lookup or creation through `src/github.js`, `git push HEAD:refs/heads/main`), `status.json` in the state
  folder, failure / OK-again e-mails through the injected `notify`. With `github.releases` each commit also carries
  `src/templates/release-world.yml` as `.github/workflows/release-world.yml` (index only, skip-worktree: the world
  folder never gets it; off removes it), the GitHub Actions workflow that builds an installable world release
  (`world.json` + `world.zip`) on every push, linked through the Foundry release proxy when the world repository's
  `FOUNDRY_PROXY_URL` variable is set. Git gets `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_TERMINAL_PROMPT=0`, identity and the credential helper through `GIT_CONFIG_COUNT` variables; the token is only
  in `FWB_GITHUB_TOKEN` of the push's environment. `remoteUrl` is injectable (the tests push into a local bare repo).
- `src/scheduler.js` – slots in local time (`lastSlot`/`nextSlot`); every minute, an enabled world whose latest slot
  is newer than its `lastScheduled` is queued (a missed slot runs when the machine is back; a fresh install backs
  everything up once).
- `src/github.js` – `checkToken` (`GET /user`, expiry header), `repoInfo`, `createRepo` (private, under the token's
  account); `foundryStatus` (`GET <foundry address>/api/status`: the active world, or why Foundry did not answer).
- `src/admin.js` – the admin page (`/_admin/`, UI files in `src/admin-ui/`: one HTML page whose views are picked by the
  URL fragment, `#/` worlds and `#/schedule`, `#/foundry`, `#/github`, `#/notifications`, `#/password` from the
  cogwheel menu, which starts with Worlds and highlights the current page; the GitHub page shows a checkmark when a
  token is set and "Add new token" (a dialog); logged in, the dark top bar shows the logo; the footer
  ("Built by Dxcufgb 2026", also on the login page) holds the version and "Check for update", which opens the
  "Update now / Not now" dialog when a newer release exists; a per-row checkbox turns a world on/off, a
  per-row cogwheel opens the world dialog): JSON API `GET state`, `POST worlds/rescan`, `PUT worlds/<id>`,
  `POST worlds/<id>/backup`, `DELETE worlds/<id>` (forget), `PUT settings`, `POST foundry-test` (Foundry's
  `/api/status` at a typed or the saved address), `PUT token` (format check, GitHub must accept it, then the
  `GITHUB_TOKEN` line of `env` is rewritten in place), `POST setup-test`, `PUT notify`, `POST notify/test`,
  `PUT password`, `GET`/`POST update`. Settings in `admin.json` (scrypt `passwordHash` + `notify`), the backup settings
  in `config.json`. CLI: `setup FILE` (installers; secrets via `FOUNDRY_BACKUP_*` env), `check FILE`.
- `src/mailer.js` – minimal SMTP client (STARTTLS / TLS / plain relay, AUTH PLAIN/LOGIN only over TLS).
  `src/notify.js` – `--service-env FILE --subject --message`: mails the `admin.json` recipients; used by the service
  and the auto-update scripts. `src/selfsigned.js` – ECDSA P-256 self-signed certificate built with `node:crypto`.
- `src/updater.js` – self-update helper (`--check` / `--download` the latest release:
  `foundry-world-backup-<version>-linux.tar.gz` / `-windows.zip`, verified against `SHA256SUMS.txt`). Exit 0 = up to
  date, 10 = update available/downloaded, 1 = error. Installing is left to the scripts. No token needed (this repository
  is public); one from `--token-file` / `UPDATER_GITHUB_TOKEN` is used when present (a missing file = none, a 401 drops
  it); a used-up rate limit (403/429) is a clear error.
- `test/config.test.js` (config, scheduler, worlds), `test/backup.test.js` (the real `git` command against a local
  bare repository, a fake GitHub API), `test/admin.test.js` (admin API through `createApp`, mailer against a fake
  SMTP server, notifier, daily check, update triggers), `test/adminweb.test.js` (HTTPS admin port, host allowlist,
  reverse-proxy headers), `test/updater.test.js` – `node:test` suites, no network.
- `install.sh` – the single Linux entry point (the one-liner of `dxcufgb/install` runs it as root): finds a system-wide
  Node (>= 18) or downloads the official Node 22 (SHA-256 checked) to `/opt/foundry-world-backup-node`, then runs
  `scripts/install-service.sh`. Common option set of the dxcufgb services: `--yes`/`-y`, `--auto-update`/
  `--no-auto-update`, `--enable-auto-update`/`--disable-auto-update`, `--check-update` (0 / 10 / other),
  `--update-now`, `--uninstall [--purge]`, `--help`.
- `scripts/install-service.sh` – systemd installer (`sudo`; the common options plus `--foundry-data DIR`,
  `--run-as USER`, `--admin-port PORT`, `--grant-access`, `--set-admin-password`, `--set-notify`, `--renew-admin-cert`,
  `--upgrade` (used by the updater)). Code in `/opt/foundry-world-backup` (root-owned), settings in
  `/etc/foundry-world-backup/`, state in `/var/lib/foundry-world-backup/` (service user, 700). Needs `git`. The
  service user `foundry-backup` gets read access to the worlds folder with `setfacl` (default ACL for new worlds);
  `--run-as` uses an existing user (the Foundry user) instead.
- `scripts/auto-update.sh` – run as root by the `foundry-world-backup-update` timer: locks, extracts, backs up to
  `/opt/foundry-world-backup.prev`, runs `install-service.sh --upgrade`, rolls back on failure.
- `scripts/install-service.ps1`, `scripts/auto-update.ps1` – the same for Windows: code in
  `C:\Program Files\FoundryWorldBackup`, settings, state and logs in `C:\ProgramData\FoundryWorldBackup`; the service
  runs as LOCAL SERVICE (which gets `(OI)(CI)RX` on the worlds folder with `icacls`), the daily update task as SYSTEM.
  Needs Git for Windows installed for all users (`GIT_BIN` in `env`).
- `packaging/windows/` – the Inno Setup installer: `foundry-world-backup.iss` (wizard + bundled Node.js in
  `Program Files\FoundryWorldBackup-Node`, refuses to start without Git for Windows, then runs
  `install-service.ps1 -Upgrade`), `stop-service.ps1`, `build-installer.ps1` and `smoke-test.ps1` (silent
  install/uninstall against a fake Foundry data folder, run by CI).
- `scripts/build-release.sh OUT VERSION` – builds the archives with VERSION stamped into the packed `package.json`;
  `--finish OUT VERSION` adds the fixed-name copies and `SHA256SUMS.txt`. `scripts/release-notes.sh` prints the
  per-OS download table. `.github/workflows/release.yml`: Actions → Release → Run workflow → type the version.
- `.github/ruleset-protect-main.json`, `.github/ruleset-protect-release-tags.json` – the "Protect main" ruleset (squash
  only, 1 approval, required CI checks) and the release-tag ruleset, the same as in the other FoundryVTT repos and
  enforced by GitHub. Keep the check names in step with the job names in `ci.yml` (only jobs that run on every PR
  belong in it). `.github/` also holds the PR and issue templates and `SECURITY.md`.
- `config.example.json`, `.env.example` – templates. Real `config.json`/`admin.json`/`env` are gitignored.

## Commands
- `npm test` – the unit tests. `npm start` – run the service.
- Local run: `GITHUB_TOKEN=... FOUNDRY_DATA=/path/to/foundrydata CONFIG_FILE=config.example.json ADMIN_TLS=off node src/server.js`
- CI (`.github/workflows/ci.yml`): `node --check` on `src/*.js` and `src/admin-ui/app.js` + `npm test` on
  Node 20/22/24, `shellcheck install.sh scripts/*.sh`, PSScriptAnalyzer on `scripts/*.ps1` and
  `packaging/windows/*.ps1`, an `install.sh` run under systemd on the runner (a data folder owned by another user,
  mode 700, read through the ACL; a backup run that fails at GitHub; `--run-as`), and a silent install/uninstall of
  the Inno Setup exe on a Windows runner. Workflow changes are linted by actionlint and zizmor.
- Security (`.github/workflows/security.yml`, required checks `Secrets (gitleaks)`, `Code (Semgrep)`, `Dependencies`;
  push to main, PRs, weekly): locally `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .`,
  `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`,
  and no npm dependencies, so nothing to audit (the job fails if `package.json` gains one). Semgrep false positives:
  `// nosemgrep: <rule-id>` with a reason; gitleaks: `.gitleaks.toml` with `[extend]` `useDefault = true`.

## Install on Linux and releasing
- **Install on Linux**: `curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-world-backup`,
  or download `foundry-world-backup-linux.tar.gz`, `tar xzf`, `cd foundry-world-backup-X.Y.Z`, `sudo ./install.sh`.
  This repository is public (MIT, `LICENSE`); the world-backup repositories the service creates stay private.
- **Releasing**: Actions → Release → Run workflow → type the version. Fallback: publish a release `vX.Y.Z` on GitHub,
  files are attached afterwards. No version bump in the code.

## Conventions
- CommonJS, `'use strict'`, **no npm dependencies** – Node built-ins, global `fetch` and the `git` command only.
  Adding a dependency needs a very good reason.
- 2-space indent, single quotes, semicolons. Small closures inside `createApp` / `createBackups` / `createAdmin`;
  dependencies (`fetchImpl`, `run`, `remoteUrl`, `mailer`, `now`, `log`) are injected so tests can replace them.
- Errors: `ConfigError` → exit 1 ("refusing to start"), `BackupError` → the world's `lastError` and an e-mail,
  `HttpError` → its status on the admin API, anything else → 500 "internal error".
- Logging is one plain line through the injected `log`, prefixed with the world id (`admin:`, `scheduler:`,
  `daily check:` otherwise).
- Behaviour changes need a test and matching wiki edits (the wiki documents settings, the page, the API and the
  installers).

## Review focus
- **The token** may only go to `api.github.com` (fetch) and to git's push through the credential helper in the
  environment of that git process (`FWB_GITHUB_TOKEN`). It must never be on a git command line, in a remote URL, in
  a commit, in `status.json`, in a response body, in an e-mail or in a log line (`scrub()` and the tests check
  that). `TOKEN_RE` (letters, digits, `_`) must hold before a token is written to `env`, so it can never add a line;
  never loosen it. The token API never answers 401 (the UI reads 401 as "logged out").
- **The world folder is read-only for the service**: the git directory is in the state folder (`GIT_DIR` /
  `GIT_WORK_TREE`), never a `.git` inside the world (Foundry serves that folder). Nothing may write into the data
  folder; the systemd unit and the Windows ACL only give read access.
- **Repositories are private**: `createRepo` always passes `private: true`; a public repository is reported as a
  warning by "Test setup" and in the log, never silently used as the default.
- **Path handling**: world ids come from folder names and must match `WORLD_ID_RE` before they reach a git command,
  a URL or a file path; repository names must match `REPO_RE`. `config.json` keys are looked up with `Object.hasOwn`
  on a null-prototype map.
- **One backup at a time**: the queue serializes runs; a world cannot be queued twice. The scheduler must never
  re-queue a slot that ran (`lastScheduled`).
- Every admin response is `Cache-Control: no-store` with the strict CSP (no inline script/style: the UI only uses
  `textContent`). Every API call but login needs the session cookie (HttpOnly, SameSite=Strict, Path=/_admin); every
  change also the `X-CSRF-Token` and `Content-Type: application/json`; unknown `Host`/`Origin` → 403 (DNS rebinding).
  Login lockout after 5 failures. Neither the token, the password hash nor the SMTP password may appear in a response
  or a log line (tested).
- **Admin port**: HTTPS by default. Host allowlist = localhost, this machine's names and interface addresses,
  `ADMIN_HOST`, `ADMIN_PUBLIC_URL`'s host, `ADMIN_HOSTS`. `X-Forwarded-*` only from a peer that `ADMIN_TRUST_PROXY`
  names. No HSTS (self-signed certificates would become un-bypassable). The certificate files are root-owned,
  readable by the service.
- The service's account may rewrite `config.json`/`admin.json`/`env` (only its `GITHUB_TOKEN` line) and, on Linux,
  the empty `update-request` in place but never create files in the settings folder (Linux: files owned by the
  service user, `ReadWritePaths=` exactly these four plus the state folder; Windows: LOCAL SERVICE `(R,W)`, no
  delete). The state folder is the service's own: `status.json` is written atomically there.
- **Update now** may only *request* the existing root/SYSTEM update run; nothing the service writes or sends may
  reach that run (root never reads `update-request`; the Windows task takes no arguments and LOCAL SERVICE has only
  read+run on it). Root/SYSTEM read `env` as text only, never source it. Root never parses `admin.json`:
  `auto-update.sh` runs `notify.js` as the service user via `setpriv`.
- Installer: re-running it must never overwrite `config.json`, `admin.json` or `env`; `env` stays mode 600 owned by
  the service user; the ACL grant must never widen access for anyone but the service user; keep the systemd
  hardening (`ProtectHome=read-only`, not `true`: the data folder is usually under `/home`) and keep the scripts
  clean under shellcheck.
- **Auto-update** stays opt-in and runs as root (Linux) / SYSTEM (Windows). It needs no token; an optional one
  (updater token or the service's `GITHUB_TOKEN`) goes only to `api.github.com`, never on a command line or in a log,
  and the installers never stop to ask for one (`--yes` never asks anything). Downloads must match `SHA256SUMS.txt`;
  only strictly newer, non-draft, non-prerelease versions install. Root/SYSTEM must never run code a non-admin
  account can change (code folder root-owned with explicit modes; Program Files on Windows). Upgrades keep the
  settings and the state; a failed install puts the previous code back.
- `main` is protected by the "Protect main" ruleset: changes go through pull requests, merged with squash; release
  tags `v*` are protected by the "Protect release tags" ruleset.
- **Versions**: the version comes from the release tag; nobody bumps `package.json`.
- The Windows installer must not duplicate `install-service.ps1`: the wizard only collects answers and calls the
  script (token via `FOUNDRY_BACKUP_GITHUB_TOKEN`, never on a command line). PowerShell scripts must run on Windows
  PowerShell 5.1 and stay PSScriptAnalyzer-clean.
- `engines` says Node >= 18 but CI tests 20/22/24; avoid APIs newer than Node 20. git must be 2.31 or newer
  (`GIT_CONFIG_COUNT`).

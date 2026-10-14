# Foundry world backup

A small service that lives next to a self-hosted **Foundry VTT** server and backs every **world** up to its own
**private GitHub repository** on a schedule. Each run is a git commit of the world folder (the files in
`Data/worlds/<world id>`: `world.json`, the LevelDB packs, scenes, uploaded assets…) pushed to GitHub, so the full
history of every world is kept and any state can be restored with `git`. Node.js only, no npm dependencies; the
backups are made with the `git` command. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a scheduled
task on Windows, and can optionally keep itself up to date from this repository's releases.

A password-protected **administration page** on port **8484** (HTTPS) lists the worlds of the Foundry server with
whether each one is backed up, when it was last backed up and the size of its folder, with a cogwheel per world for
its own settings (on/off, repository name, its own schedule, what to do while the world is active in Foundry). The
page also holds the global schedule, the GitHub token, the notification e-mail settings and the admin password, and
starts a backup by hand. When a backup fails (GitHub refuses the token, a push is rejected, the folder cannot be
read…) a warning e-mail goes to the configured addresses, and one more says when the world backs up again.

```
Foundry data ─── Data/worlds/<id> ──▶ git add / commit (git dir in the service's state folder) ──▶ git push ──▶ github.com/<you>/foundry-world-<id> (private)
                                                                           ▲
schedule (daily 04:00 by default) ─ or "Back up now" on the admin page ───┘      failures ──▶ e-mail
```

| Where | What |
| --- | --- |
| `https://<host>:8484/` | the [administration page](#administration-page) (`/` → `302 /_admin/`, plain `http://` → `301 https://`) |
| `/_admin/api/...` | its JSON API (session cookie + CSRF token; `401` without a login) |
| `/var/lib/foundry-world-backup/repos/<id>` | the git directory of a world (never inside the world folder: Foundry serves that folder) |
| `/var/lib/foundry-world-backup/status.json` | last attempt / success / error, commit and folder size per world |
| `github.com/<token owner>/<prefix><id>` | the world's repository, created (private) on the first backup if it is missing |

## Configuration

`config.json` (path from `CONFIG_FILE`, default `./config.json`; see `config.example.json`) holds the schedule and the
per-world settings and is written by the administration page:

```json
{
  "schedule": { "frequency": "daily", "time": "04:00", "weekday": 0, "everyHours": 6 },
  "github": { "repoPrefix": "foundry-world-", "createRepos": true },
  "whenActive": "backup",
  "foundry": { "url": "http://localhost:30000" },
  "worlds": {
    "my-campaign": { "enabled": true, "repo": "", "schedule": null, "whenActive": "" },
    "test-world": { "enabled": false }
  }
}
```

- `schedule.frequency`: `daily` (at `time`), `weekly` (on `weekday`, 0 = Sunday … 6 = Saturday, at `time`) or
  `hourly` (every `everyHours` hours counted from midnight; 1, 2, 3, 4, 6, 8, 12 or 24). Times are the local time of
  the machine. A slot missed while the machine was off runs as soon as the service is back, so a freshly installed
  service backs every world up once right away.
- `github.repoPrefix`: a world goes to `<token owner>/<repoPrefix><world id>` unless its own `repo` (`owner/name`)
  says otherwise. `github.createRepos`: create a missing repository (always private) on the first backup; off =
  a missing repository is an error.
- `whenActive`: what to do when Foundry has the world launched at backup time: `backup` (back it up anyway; the
  commit message says so) or `skip` (wait for the next run). Foundry's `/api/status` tells which world is active.
- `foundry.url`: where Foundry answers `/api/status` (http or https, no user name or password); set on the admin
  page's **Foundry** page. Absent = `FOUNDRY_URL` from the environment; `""` = never ask (no active-world check).
- `worlds.<id>`: `enabled` (default true: a new world is backed up without any setup), `repo`, `schedule` (its own
  schedule, or `null` for the global one) and `whenActive` (`""` for the global setting). Worlds that are not listed
  get the defaults. A world id is the folder name under `Data/worlds`.

Environment variables (see `.env.example`): `GITHUB_TOKEN`, `FOUNDRY_DATA` (required: the Foundry user data folder,
the one with `Config`, `Data` and `Logs`; its `Data` or `Data/worlds` folder works too), `CONFIG_FILE`, `STATE_DIR`
(default `state` next to `CONFIG_FILE`), `ADMIN_FILE` (default `admin.json` next to `CONFIG_FILE`), `ENV_FILE` (the
file holding `GITHUB_TOKEN`, where a token changed on the admin page is saved; default `env` next to `CONFIG_FILE`),
`FOUNDRY_URL` (default `http://localhost:30000`; empty = never ask whether a world is active; `foundry.url` in
`config.json`, set on the admin page, wins), `GIT_BIN`,
`DAILY_CHECK` (`off` turns off the [daily token check](#daily-check)), and the admin page settings `ADMIN_PORT`
(default `8484`), `ADMIN_HOST` (default `0.0.0.0`), `ADMIN_TLS` (`off` = plain HTTP, only behind a reverse proxy),
`ADMIN_TLS_CERT`, `ADMIN_TLS_KEY`, `ADMIN_HOSTS`, `ADMIN_PUBLIC_URL`, `ADMIN_TRUST_PROXY`.

Run locally: `GITHUB_TOKEN=... FOUNDRY_DATA=/path/to/foundrydata CONFIG_FILE=config.example.json node src/server.js`.
Tests: `npm test` (config and scheduler, the backup with the real `git` command against a local repository, admin
page, mailer and updater; no network needed).

## 1. Create the GitHub token

The service pushes to and creates repositories with a GitHub token that is stored on the Foundry machine, so make it
as narrow as possible:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner**: your account (the world repositories are created under it). **Repository access**: **All
   repositories** when the service may create the repositories (creation needs that), or **Only select
   repositories** with the world repositories you created yourself (`foundry-world-<world id>`, private).
3. **Permissions → Repository permissions**: **Contents: Read and write** (push the backups) and, for creating
   repositories, **Administration: Read and write**. Nothing else. For [automatic updates](#automatic-updates) of
   the service itself the token also needs **Contents: Read-only** on `dxcufgb/FoundryVTT-world-backup-to-git`, or
   the updater gets a token of its own.
4. Set an expiry you will remember; the admin page's **Test setup** and the daily check warn two weeks before.

GitHub rejects files over 100 MB in a push and recommends repositories under a few GB. A world with huge uploaded
assets (videos, large maps) fails to push: move such files out of the world folder (Foundry can use them from
anywhere under `Data`) or keep that world off.

## 2. Install on Linux (Raspberry Pi)

Prerequisites: `git` (`sudo apt install git`), and the `acl` package when the Foundry data folder is only readable
by the Foundry user (it usually is; `sudo apt install acl`). Node.js 18+ is used when installed system-wide,
otherwise the installer downloads the official Node.js 22.

```sh
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-world-backup
```

(the repository is private: the one-liner asks for a fine-grained token with read-only *Contents* access to it), or
download `foundry-world-backup-linux.tar.gz` from the latest release, `tar xzf` it, `cd foundry-world-backup-X.Y.Z`
and `sudo ./install.sh`. The installer asks for:

- the **Foundry user data folder** (it guesses `/home/*/foundrydata` and the like),
- the **GitHub token** (Enter = paste it on the admin page later),
- the **admin page password** (required: the page is where everything is set up),
- the **notification e-mail** addresses and mail server (Enter = none),
- whether to turn on **automatic updates**.

Then it creates the system user `foundry-backup`, gives it read access to the worlds folder with a POSIX ACL
(inherited by new worlds; `--grant-access` repeats that later), writes the settings to `/etc/foundry-world-backup/`,
the state to `/var/lib/foundry-world-backup/`, the code to `/opt/foundry-world-backup/`, installs and starts the
systemd service, and prints the address of the admin page (`https://<host>:8484/`; the self-signed certificate makes
the browser warn once). Re-running the installer updates the code and keeps every setting.

Non-interactive (`--yes`): settings come from `FOUNDRY_BACKUP_*` variables passed through `sudo --preserve-env`:

```sh
export FOUNDRY_BACKUP_GITHUB_TOKEN=github_pat_... FOUNDRY_BACKUP_ADMIN_PASSWORD='a long password'
sudo --preserve-env=FOUNDRY_BACKUP_GITHUB_TOKEN,FOUNDRY_BACKUP_ADMIN_PASSWORD ./install.sh --yes \
  --foundry-data /home/foundry/foundrydata --auto-update
```

Options (`sudo ./install.sh --help` lists them all): `--foundry-data DIR`, `--run-as USER` (run as the Foundry user
instead of `foundry-backup`, so no ACL is needed), `--admin-port PORT`, `--grant-access`, `--set-admin-password`,
`--set-notify`, `--renew-admin-cert`, `--auto-update` / `--no-auto-update`, `--enable-auto-update` /
`--disable-auto-update`, `--check-update`, `--update-now`, `--uninstall [--purge]` (`--purge` also deletes the
settings, the local git copies and the service user; the repositories on GitHub stay), `--install-node` /
`--no-install-node`. Environment: `FOUNDRY_BACKUP_DATA`, `FOUNDRY_BACKUP_ADMIN_PORT`, `FOUNDRY_BACKUP_ADMIN_PUBLIC_URL`,
`FOUNDRY_BACKUP_FOUNDRY_URL`, `FOUNDRY_BACKUP_NOTIFY_EMAILS`, `FOUNDRY_BACKUP_SMTP_*`, `UPDATER_GITHUB_TOKEN`.

### Check that it runs

```sh
systemctl status foundry-world-backup
journalctl -u foundry-world-backup -f
```

The log shows the worlds folder, the state folder, the admin page address, the result of the token check and one line
per backup (`<world id>: backed up to <repo> (new commit, scheduled run for …)` or `backup FAILED (…)`). The token
never appears in the log.

Layout: code in `/opt/foundry-world-backup` (root-owned, replaced by updates), settings in
`/etc/foundry-world-backup/` (`config.json`, `admin.json`, `env` with the token, `admin-tls.crt/.key`,
`update-request`; the three JSON/env files are owned by the service user, mode 600, and rewritten in place by the
admin page), the git copies and `status.json` in `/var/lib/foundry-world-backup/` (service user, mode 700). The
service runs under systemd hardening (`ProtectSystem=strict`, `ProtectHome=read-only` so a data folder under `/home`
stays readable, `ReadWritePaths` = the state folder and the four settings files).

## 2b. Install on Windows

Prerequisites: [Git for Windows](https://git-scm.com/download/win) installed for all users (the service runs as
LOCAL SERVICE and cannot use a per-user install). The installer brings its own Node.js.

Run `foundry-world-backup-X.Y.Z-setup.exe` (administrator rights are asked for). The wizard asks for the Foundry user
data folder (it guesses `C:\Users\<you>\AppData\Local\FoundryVTT`), the GitHub token, the admin page port (8484),
automatic updates, the admin page password and the notification e-mail settings, then runs
`scripts\install-service.ps1`, which

- copies the code to `C:\Program Files\FoundryWorldBackup` and Node.js to `C:\Program Files\FoundryWorldBackup-Node`,
- writes `env`, `config.json` and `admin.json` to `C:\ProgramData\FoundryWorldBackup` (administrators, SYSTEM and
  LOCAL SERVICE only), the git copies to `C:\ProgramData\FoundryWorldBackup\state`, logs to `...\logs\service.log`,
- gives LOCAL SERVICE read access to the worlds folder (inherited by new worlds; `-GrantAccess` repeats that),
- registers the scheduled task `FoundryWorldBackup` (at boot, under LOCAL SERVICE), the `FoundryWorldBackup-UpdateNow`
  task for "Update now" and, if asked, the daily `FoundryWorldBackup-Update` task (SYSTEM),
- opens the admin port in Windows Firewall for domain and private networks.

Running the installer again upgrades the code and keeps every setting. Silent install (secrets only through the
environment): `set FOUNDRY_BACKUP_GITHUB_TOKEN=...`, `set FOUNDRY_BACKUP_ADMIN_PASSWORD=...`, then
`foundry-world-backup-X.Y.Z-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /FOUNDRYDATA=C:\Users\me\AppData\Local\FoundryVTT
[/ADMINPORT=8484 /AUTOUPDATE=1 /NOTIFYEMAILS=... /SMTPHOST=... /SMTPPORT=... /SMTPSECURITY=... /SMTPUSER=... /SMTPFROM=...]`.
Uninstall through *Apps & features*; a silent uninstall keeps the settings, token and state (`/DELETEDATA=1` removes
them). Without the wizard: unpack `foundry-world-backup-windows.zip` and run `.\scripts\install-service.ps1
-FoundryData <folder>` from an elevated PowerShell (`-SetAdminPassword`, `-SetNotify`, `-GrantAccess`,
`-RenewAdminCert`, `-AutoUpdate`, `-Check`, `-UpdateNow`, `-Uninstall`).

## Administration page

`https://<host>:8484/` (plain `http://` on that port is redirected). Log in with the admin password. The **Worlds**
page is a table with one row per world folder:

| Column | Shows |
| --- | --- |
| Back up | a checkbox, ticked while the world is backed up; clearing it turns the world off (its other settings stay) |
| World | the title from `world.json`, the id, the game system, and the world's own schedule if it has one |
| Backed up | **Yes** (the last run succeeded; "no changes since the backup before" when nothing had changed), **Failed** with the reason, **Skipped** (the world was active and its settings say to wait), **Not yet** with the time of the first run, **Off**, or **Not readable** |
| Last backup | how long ago the last successful backup was (hover for the exact time) and when the next run is |
| Size | the size of the world folder (summed in the background, refreshed every 10 minutes and after a backup) |
| Repository | the GitHub repository the world goes to (a link) |
| Actions | **Back up now** and the **cogwheel** with the world's settings |

**Rescan** re-reads the worlds folder (a new world is also found on the next scheduled run); **Back up all now**
queues every enabled world. The cogwheel of a world opens its settings: back this world up (on/off, the same as the
row's checkbox), repository
(empty = the default name), the global schedule or its own, and what to do while the world is active in Foundry.
A world whose folder is gone can be **forgotten** there (its settings, status and local git copy are removed; the
repository on GitHub stays).

The cogwheel in the header opens the menu of pages (the current one is highlighted): **Worlds** (the table above)
and

- **Schedule**: the global schedule (every day / every week / every few hours, at a time) and the active-world rule.
- **Foundry**: the address Foundry answers `/api/status` on (which world is active), saved to `config.json`
  (`foundry.url`), or "do not ask Foundry"; **Test** asks the typed address without saving it (reachable, which
  world is active, or why it did not answer); **Use the installer's address** goes back to `FOUNDRY_URL`.
- **GitHub**: the token (never shown: a checkmark says one is set, and **Add new token** opens a dialog for the next
  one; a new token is checked with GitHub before it replaces the old one in `env`; without a token the field is on
  the page),
  **Test setup** (the token, `git`, the data folder, the state folder, Foundry's `/api/status`, the release
  repository for automatic updates and every enabled world's repository: exists / will be created / cannot be
  pushed to / is public), the repository name prefix and whether missing repositories are created.
- **Notifications**: the recipients and the SMTP server (see below), with a test e-mail.
- **Admin password**.

The footer shows the installed version, whether a newer release exists, and **Check for update**: when a newer
release exists it asks whether to [update now](#update-now) (**Update now** / **Not now**).

API rules (for scripts): every call but `POST /_admin/api/login` needs the session cookie; every change also the
`X-CSRF-Token` header (from the login or state answer) and `Content-Type: application/json`; a request with an
unknown `Host`/`Origin` is refused (403, DNS rebinding); five failed logins lock the address out for five minutes.
Routes: `GET state`, `POST worlds/rescan`, `PUT worlds/<id>`, `POST worlds/<id>/backup` (202; 409 while queued,
turned off or unreadable), `DELETE worlds/<id>`, `PUT settings` (`schedule`, `github`, `whenActive`, `foundry`), `POST foundry-test` (`url`
optional: without it the address in use), `PUT token`, `POST setup-test`, `PUT notify`,
`POST notify/test`, `PUT password`, `GET`/`POST update`, `POST logout`.

### The admin page on a public address

The page is served on `ADMIN_HOST` (all addresses) with a self-signed certificate for this machine's names and
addresses (`ADMIN_PUBLIC_URL`'s host is added; `--renew-admin-cert` makes a new one). For a real certificate set
`ADMIN_TLS_CERT`/`ADMIN_TLS_KEY`, or put a reverse proxy in front with `ADMIN_TLS=off`, `ADMIN_HOST=127.0.0.1`,
`ADMIN_TRUST_PROXY=1` (so the client address behind `X-Forwarded-For` is the one locked out, and the cookie is
`Secure` behind `X-Forwarded-Proto: https`) and the public name in `ADMIN_HOSTS` or `ADMIN_PUBLIC_URL`.

## How a backup works

1. The world folder is checked (readable; and, through Foundry's `/api/status`, whether the world is active).
2. `git add -A` in the world folder with the git directory in `STATE_DIR/repos/<id>` (`GIT_DIR` and
   `GIT_WORK_TREE`; nothing is written into the world folder), then a commit when anything changed
   (`Backup of <title> (<id>) <time>`, author `Foundry world backup`). Nothing changed = no commit, still a success.
3. The repository is looked up on GitHub: created (private) when missing and `createRepos` is on; a repository the
   token cannot push to, or that is outside the token's account and missing, is an error.
4. `git push` of `HEAD` to the repository's `main` branch. The token reaches git only through a credential helper in
   the environment of that one git process: it is never on a command line, in a URL, in a log line, in a commit or
   in `status.json`.
5. `status.json` is updated and, on a failure, an e-mail is sent; the first success after a failure sends an
   "OK again" e-mail.

One world is backed up at a time; "Back up now" queues a world that is not already running or queued. A world whose
backup is running when the service restarts is retried on its next slot (its `lastScheduled` is only set when the
run started, so a missed slot shows up as due).

## Restoring a world

The repository holds the world folder as it was at each backup. On the Foundry machine (Foundry stopped, or at
least with the world not launched):

```sh
cd /home/foundry/foundrydata/Data/worlds
mv my-campaign my-campaign.broken              # keep the current folder
git clone https://github.com/<you>/foundry-world-my-campaign.git my-campaign
# an older state instead of the latest: git -C my-campaign log --oneline, then git -C my-campaign checkout <commit>
rm -rf my-campaign/.git                        # Foundry serves the folder, so do not leave the history in it
chown -R foundry:foundry my-campaign
```

Start Foundry (or return to setup and launch the world). The service keeps backing the restored world up as before.

## Daily check

Once a day (the first time an hour after the service starts) the service asks GitHub about the token in use. A token
GitHub refuses, or one that expires within two weeks, is e-mailed to the notification recipients every day it lasts,
and one more e-mail says when it is fine again. Backups themselves report their own failures as they happen.
`DAILY_CHECK=off` turns the check off.

## Notifications by e-mail

The recipients and the SMTP server (host, port, STARTTLS / TLS / none, user, password, sender) are entered by the
installer or on the admin page and stored in `admin.json`. E-mails are sent for a failed backup (one per failed
run) and the first success after it, for the daily check, and by the auto-updater when it installed a new version
or failed. The SMTP password is only sent over TLS (a login with security `none` is refused) and never shown on the
page or in a log. Without recipients nothing is sent.

## Automatic updates

Off unless asked for (`--auto-update` / the wizard's checkbox / `--enable-auto-update`). A daily root (Linux) or
SYSTEM (Windows) run checks the latest release of this repository and installs it when it is strictly newer and not a
pre-release: the archive is verified against the release's `SHA256SUMS.txt`, the previous code is kept in
`/opt/foundry-world-backup.prev` (`C:\Program Files\FoundryWorldBackup.prev`) and put back when the install fails or
the service does not come back. Settings, `env` and the state are never touched. The updater uses the service's
token (which then needs Contents: read-only on this repository) or a separate token (`UPDATER_GITHUB_TOKEN`; the
one-line installer offers the token it downloaded the release with), stored root-only. Results are e-mailed.

### Update now

**Update now** in the dialog of the footer's **Check for update** asks the installer's own updater to run at once (at most once every two minutes). The
service may only *request* the run: on Linux it rewrites `/etc/foundry-world-backup/update-request`, which a systemd
path unit watches to start the root update service; on Windows it starts the SYSTEM task `FoundryWorldBackup-UpdateNow`
(which takes no arguments). The service restarts when a newer release was installed; a running backup is interrupted
and retried on its next slot.

## Releases

Actions → **Release** → *Run workflow* → the version (e.g. `1.2.3`; `1.2.3-rc.1` makes a pre-release). The workflow
runs the whole CI (tests, shellcheck, PSScriptAnalyzer, a real Linux and a real Windows install), builds
`foundry-world-backup-<version>-linux.tar.gz`, `-windows.zip` and `-setup.exe`, the fixed-name copies
(`foundry-world-backup-linux.tar.gz` etc., so `.../releases/latest/download/<name>` always points at the newest
release) and `SHA256SUMS.txt`, and publishes the release with a download table in front of the generated notes.
Fallback: publish a release with a tag `vX.Y.Z` by hand; the files are attached afterwards. The version comes from
the tag; nobody bumps `package.json` (the build stamps it into the archives).

## Development

- `npm test`: `node --test` over `test/*.test.js`. The backup tests run the real `git` command (git ≥ 2.31) and push
  into a local bare repository; GitHub, Foundry and SMTP are faked.
- `shellcheck install.sh scripts/*.sh`; PSScriptAnalyzer (`Invoke-ScriptAnalyzer -Path scripts, packaging -Recurse`)
  for the PowerShell scripts, which target Windows PowerShell 5.1.
- Security scans as in CI: `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .`
  and `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript
  --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`.
- Conventions: CommonJS, `'use strict'`, no npm dependencies, 2-space indent, single quotes, semicolons; behaviour
  changes need a test and a README edit. See `CLAUDE.md` for the review focus.

## Branch protection

`main` is protected by the **Protect main** ruleset (`.github/ruleset-protect-main.json`, applied through the
GitHub API/UI): no deletion or force push, changes through pull requests merged with squash, one approval, and the
CI and security jobs as required status checks. Release tags `v*` are protected by **Protect release tags**
(`.github/ruleset-protect-release-tags.json`): no deletion, update or force push. Keep the check names in the ruleset
in step with the job names in `ci.yml` and `security.yml`.

## Troubleshooting

- **A world shows "Not readable"**: the service user cannot read its folder. Linux: `sudo ./install.sh --grant-access`
  (needs the `acl` package), or reinstall with `--run-as <the Foundry user>`. Windows: `install-service.ps1 -GrantAccess`.
- **"the token has not been confirmed yet"**: GitHub has not told the service whose token this is (no network, or a
  refused token). Run **Test setup** on the GitHub page; the repository names need the owner.
- **"GitHub did not let the token create the repository"**: the token lacks Administration: read and write on all
  repositories of its account. Either give it that, or create `foundry-world-<id>` (private) on GitHub yourself and
  give the token Contents: read and write on it.
- **A push fails with a file over 100 MB** (GitHub's limit): move the big files out of the world folder, or turn
  the world off. The error text (git's message) is in the Backed up column and in the e-mail.
- **"the world is active in Foundry"**: the world is launched and its settings say to wait. Change the rule in the
  world's cogwheel (or the global one on the Schedule page) to back it up anyway.
- **The admin page says "unknown host name"**: the name in the address bar is not one the page accepts (DNS
  rebinding guard). Add it to `ADMIN_HOSTS` or `ADMIN_PUBLIC_URL` in `env` and restart.
- **The first backup ran right after installing**: by design — the most recent slot had not run yet.

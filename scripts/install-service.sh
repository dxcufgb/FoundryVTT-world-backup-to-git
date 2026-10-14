#!/usr/bin/env bash
# Installs (or removes) the Foundry world backup as a systemd service that starts on boot and restarts automatically
# if it crashes. ./install.sh at the top of the repository / release archive is the entry point (it also sets up
# Node.js) and passes its options on to this script; both accept the options below.
#
#   sudo ./scripts/install-service.sh                       # install or update the code, then (re)start
#   sudo ./scripts/install-service.sh --auto-update         # same, and turn on automatic updates
#   sudo ./scripts/install-service.sh --enable-auto-update  # turn automatic updates on for an existing install
#   sudo ./scripts/install-service.sh --disable-auto-update # turn them off again
#   sudo ./scripts/install-service.sh --check-update        # is a newer release available? (report only; also --check)
#   sudo ./scripts/install-service.sh --update-now          # install the latest release now
#   sudo ./scripts/install-service.sh --uninstall [--purge] # stop + remove service, updater and code (--purge: also config)
#   sudo ./scripts/install-service.sh --foundry-data DIR    # first install: the Foundry user data folder (has Data/worlds)
#   sudo ./scripts/install-service.sh --run-as USER         # first install: run as this user (e.g. the Foundry user) instead
#                                                           # of the dedicated foundry-backup user
#   sudo ./scripts/install-service.sh --grant-access        # give the service user read access to the worlds again (ACL)
#   sudo ./scripts/install-service.sh --set-admin-password  # change the password of the administration page
#   sudo ./scripts/install-service.sh --set-notify          # (re)enter the notification e-mail settings
#   sudo ./scripts/install-service.sh --renew-admin-cert    # make a new self-signed certificate for the admin page
#
# Layout (the settings survive code updates; re-running this script never overwrites them):
#   /opt/foundry-world-backup/                   code (replaced on every run)
#   /opt/foundry-world-backup.prev/              previous code, kept by the updater for rollback
#   /etc/foundry-world-backup/config.json        schedule and per-world settings (600, owned by the service user, which
#                                                rewrites it when settings are changed on the administration page)
#   /etc/foundry-world-backup/admin.json         admin page password hash + notification e-mail settings (600, service user)
#   /etc/foundry-world-backup/env                GITHUB_TOKEN, FOUNDRY_DATA, ADMIN_PORT, ... (600, owned by the service
#                                                user, which rewrites its GITHUB_TOKEN line from the admin page)
#   /etc/foundry-world-backup/update-request     "Update now" on the admin page: the service user rewrites it, a systemd
#                                                path unit then starts the root update (root never reads it)
#   /etc/foundry-world-backup/admin-tls.crt/.key self-signed certificate of the admin page (root:service user, 644/640)
#   /etc/foundry-world-backup/auto-update.conf   auto-update on/off and which token it uses (root, 600)
#   /etc/foundry-world-backup/updater-token      only if the updater has its own token (root, 600)
#   /var/lib/foundry-world-backup/               the service's state: one git directory per world (repos/) and
#                                                status.json (700, owned by the service user)
#
# The service reads the worlds with the dedicated system user foundry-backup, which gets read access to the Foundry
# data folder through an ACL (setfacl); --run-as makes it run as another user (the Foundry user, say) instead.
# Automatic updates are off unless asked for. The tokens are taken from a prompt or from the environment
# (FOUNDRY_BACKUP_GITHUB_TOKEN for the service, UPDATER_GITHUB_TOKEN for the updater, INSTALL_GITHUB_TOKEN from the
# one-line installer as a candidate updater token), never from the command line. The same goes for the admin page
# password (FOUNDRY_BACKUP_ADMIN_PASSWORD) and the SMTP password (FOUNDRY_BACKUP_SMTP_PASSWORD).
#
# Logs:    journalctl -u foundry-world-backup -f      (updates: journalctl -u foundry-world-backup-update)
# Control: sudo systemctl {start|stop|restart|status} foundry-world-backup
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-foundry-world-backup}"
SERVICE_USER="${SERVICE_USER:-}"            # the saved choice, --run-as or foundry-backup (set below)
DEFAULT_USER="foundry-backup"
APP_DIR="${APP_DIR:-/opt/${SERVICE_NAME}}"
CONF_DIR="${CONF_DIR:-/etc/${SERVICE_NAME}}"
STATE_DIR="${STATE_DIR:-/var/lib/${SERVICE_NAME}}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
UPDATE_UNIT="/etc/systemd/system/${SERVICE_NAME}-update.service"
UPDATE_TIMER="/etc/systemd/system/${SERVICE_NAME}-update.timer"
UPDATE_NOW_UNIT="/etc/systemd/system/${SERVICE_NAME}-update-now.service"
UPDATE_NOW_PATH="/etc/systemd/system/${SERVICE_NAME}-update-now.path"
UPDATE_REQUEST="$CONF_DIR/update-request"
AUTO_CONF="$CONF_DIR/auto-update.conf"
UPDATER_TOKEN_FILE="$CONF_DIR/updater-token"
UPDATE_REPO="dxcufgb/FoundryVTT-world-backup-to-git"
DEFAULT_ADMIN_PORT=8484
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Print the option list (common set first, then this installer's own options).
print_usage() {
    cat <<'USAGE'
Usage: sudo ./install.sh [options]      (or: sudo ./scripts/install-service.sh [options])

  (no options)             install or upgrade in place, interactive (asks for what it needs)
  --yes, -y                non-interactive: no questions; missing required settings -> clear error
  --auto-update            turn automatic updates on as part of this install
  --no-auto-update         turn automatic updates off as part of this install
  --enable-auto-update     turn automatic updates on for an existing install, nothing else
  --disable-auto-update    turn them off for an existing install, nothing else
  --check-update           only check: exit 0 = up to date, 10 = newer release available, other = error
                           (75 = could not check now: another update run holds the lock)
  --update-now             install the latest release now (same path as the daily updater)
  --uninstall [--purge]    remove (keep / also delete settings, the state and the service user)
  --help, -h               this list

Options of this installer:
  --foundry-data DIR       first install: the Foundry user data folder (the one with Config, Data and Logs)
  --run-as USER            first install: run the service as USER (e.g. the user Foundry runs as) instead of the
                           dedicated foundry-backup user; USER then needs no ACL to read the worlds
  --admin-port PORT        the port of the administration page (default 8484; also FOUNDRY_BACKUP_ADMIN_PORT)
  --grant-access           give the service user read access to the worlds again (setfacl), e.g. after moving them
  --install-node           (install.sh) download the official Node.js 22 without asking if none is usable
  --no-install-node        (install.sh) never download Node.js
  --check                  same as --check-update
  --upgrade                non-interactive re-install that keeps every setting (used by the updater)
  --set-admin-password     change the password of the administration page
  --set-notify             (re)enter the e-mail settings for notifications (also editable on the admin page)
  --renew-admin-cert       make a new self-signed certificate for the admin page

Environment (tokens are never taken as arguments and never logged):
  FOUNDRY_BACKUP_GITHUB_TOKEN   the service's token (Contents: read and write on the world repositories, Administration:
                                read and write to create them); can also be pasted on the admin page later
  FOUNDRY_BACKUP_ADMIN_PASSWORD password of the administration page (at least 8 characters; required on a first
                                install with --yes)
  FOUNDRY_BACKUP_DATA           the Foundry user data folder (like --foundry-data)
  FOUNDRY_BACKUP_ADMIN_PORT     port of the administration page (default 8484)
  FOUNDRY_BACKUP_ADMIN_PUBLIC_URL  the address it is reached at from outside, e.g. https://backup.example.com:8484
  FOUNDRY_BACKUP_FOUNDRY_URL    where Foundry answers (default http://localhost:30000; empty = no active-world check)
  FOUNDRY_BACKUP_NOTIFY_EMAILS  notification recipients, comma separated (first install or --set-notify)
  FOUNDRY_BACKUP_SMTP_HOST, FOUNDRY_BACKUP_SMTP_PORT, FOUNDRY_BACKUP_SMTP_SECURITY (starttls|tls|none),
  FOUNDRY_BACKUP_SMTP_USER, FOUNDRY_BACKUP_SMTP_PASSWORD, FOUNDRY_BACKUP_SMTP_FROM
                                the mail server for those e-mails
  UPDATER_GITHUB_TOKEN          a separate token for the updater (Contents: read-only on this repository)
  INSTALL_GITHUB_TOKEN          set by the one-line installer; stored as the updater token when automatic updates
                                are turned on (asked first when interactive)
  NODE_BIN                      the node binary to use
USAGE
}

# Print the option list to stderr and exit with status 2 (bad usage).
usage() {
    print_usage >&2
    exit 2
}

orig_args=("$@")
action=install
auto_update=""     # yes/no when asked for on the command line, empty = keep the current choice
upgrade=no         # --upgrade: non-interactive, used by the updater
assume_yes=no      # --yes: non-interactive, missing required settings are an error
purge=no           # --purge (with --uninstall): also delete the settings and the service user
foundry_data="${FOUNDRY_BACKUP_DATA:-}"
run_as=""
admin_port="${FOUNDRY_BACKUP_ADMIN_PORT:-}"
while [[ $# -gt 0 ]]; do
    arg="$1"
    shift
    case "$arg" in
        --foundry-data)
            [[ $# -gt 0 ]] || { echo "--foundry-data needs a folder" >&2; usage; }
            foundry_data="$1"
            shift
            ;;
        --run-as)
            [[ $# -gt 0 ]] || { echo "--run-as needs a user name" >&2; usage; }
            run_as="$1"
            shift
            ;;
        --admin-port)
            [[ $# -gt 0 ]] || { echo "--admin-port needs a port" >&2; usage; }
            admin_port="$1"
            shift
            ;;
        --auto-update) auto_update=yes ;;
        --no-auto-update) auto_update=no ;;
        --upgrade) upgrade=yes ;;
        --yes | -y) assume_yes=yes ;;
        --enable-auto-update) action=enable ;;
        --disable-auto-update) action=disable ;;
        --check | --check-update) action=check ;;
        --update-now) action=update ;;
        --uninstall) action=uninstall ;;
        --set-admin-password) action=admin-password ;;
        --set-notify) action=notify ;;
        --renew-admin-cert) action=renew-cert ;;
        --grant-access) action=grant ;;
        --purge) purge=yes ;;
        -h | --help) print_usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage ;;
    esac
done
if [[ "$purge" == yes && "$action" != uninstall ]]; then
    echo "--purge only goes with --uninstall" >&2
    usage
fi

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo: sudo $0 ${orig_args[*]}" >&2
    exit 1
fi

# Return success only for a terminal session outside an unattended upgrade or --yes.
interactive() { [[ "$upgrade" == no && "$assume_yes" == no && -t 0 ]]; }

# KEY=value from auto-update.conf without sourcing it.
setting() {
    [[ -f "$AUTO_CONF" ]] || return 0
    sed -n "s/^$1=//p" "$AUTO_CONF" | tail -n 1
}

# Value of KEY in the env file (the last line wins; empty when not set). Read as text, never sourced.
env_value() {
    [[ -f "$CONF_DIR/env" ]] || return 0
    sed -n "s/^$1=//p" "$CONF_DIR/env" | tail -n 1
}

# The service user: the one in the unit file of an existing install, --run-as, or the dedicated user.
if [[ -z "$SERVICE_USER" ]]; then
    if [[ -n "$run_as" ]]; then
        SERVICE_USER="$run_as"
    elif [[ -f "$UNIT_FILE" ]]; then
        SERVICE_USER="$(sed -n 's/^User=//p' "$UNIT_FILE" | head -n 1)"
    fi
    SERVICE_USER="${SERVICE_USER:-$DEFAULT_USER}"
fi
if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "Invalid service user name '$SERVICE_USER'." >&2
    exit 1
fi

# Stop and disable the update timer, then remove its service and timer unit files.
remove_updater_units() {
    systemctl disable --now "${SERVICE_NAME}-update.timer" 2>/dev/null || true
    rm -f "$UPDATE_UNIT" "$UPDATE_TIMER"
}

# Stop the "Update now" watcher and remove its units and request file.
remove_update_now_units() {
    systemctl disable --now "${SERVICE_NAME}-update-now.path" 2>/dev/null || true
    rm -f "$UPDATE_NOW_PATH" "$UPDATE_NOW_UNIT" "$UPDATE_REQUEST"
}

if [[ "$action" == uninstall ]]; then
    remove_updater_units
    remove_update_now_units
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    rm -rf "$APP_DIR" "${APP_DIR}.prev"
    rm -f "$AUTO_CONF" "$UPDATER_TOKEN_FILE" "/run/lock/${SERVICE_NAME}-update.lock"
    systemctl daemon-reload
    echo "Removed $SERVICE_NAME, its updater and $APP_DIR."
    if [[ "$purge" == yes ]]; then
        rm -rf "$CONF_DIR" "$STATE_DIR"
        if [[ "$SERVICE_USER" == "$DEFAULT_USER" ]] && id "$SERVICE_USER" >/dev/null 2>&1; then
            userdel "$SERVICE_USER" 2>/dev/null || true
            echo "Purged $CONF_DIR (settings and token), $STATE_DIR (local git copies) and the '$SERVICE_USER' user."
        else
            echo "Purged $CONF_DIR (settings and token) and $STATE_DIR (local git copies); the ACLs on the worlds stay."
        fi
    else
        echo "Kept $CONF_DIR (settings and token), $STATE_DIR (local git copies) and the '$SERVICE_USER' user; add --purge to delete them too."
    fi
    exit 0
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
    echo "node not found in PATH. Install Node.js (>= 18) or run: sudo NODE_BIN=/path/to/node $0" >&2
    exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
if [[ "$NODE_BIN" == /home/* || "$NODE_BIN" == /root/* ]]; then
    echo "Node at $NODE_BIN is inside a home directory (nvm?) which the service user cannot use." >&2
    echo "Install a system-wide Node.js (e.g. NodeSource or apt) or set NODE_BIN to one." >&2
    exit 1
fi
BASH_BIN="$(readlink -f "$(command -v bash)")"

# Run the installed updater with mode $1 and the configured paths; return its exit status.
run_updater() {
    if [[ ! -f "$APP_DIR/scripts/auto-update.sh" ]]; then
        echo "$APP_DIR has no updater; install this version first: sudo $0" >&2
        exit 1
    fi
    local rc=0
    export SERVICE_NAME SERVICE_USER APP_DIR CONF_DIR NODE_BIN
    "$BASH_BIN" "$APP_DIR/scripts/auto-update.sh" "$1" || rc=$?
    return "$rc"
}

if [[ "$action" == check ]]; then
    rc=0
    run_updater --check || rc=$?
    exit "$rc"
fi
if [[ "$action" == update ]]; then
    run_updater --apply
    exit 0
fi

# Asks for the updater's token on the terminal and prints it, or prints nothing for "use the service's GITHUB_TOKEN".
# An EOF or read error never yields a token: it means "use the service's GITHUB_TOKEN".
ask_updater_token() {
    local answer="" token=""
    echo "The updater needs a GitHub token that can read releases of $UPDATE_REPO." >&2
    echo "The service's own GITHUB_TOKEN works if you also give it Contents: read-only on that repository." >&2
    read -rp "Use the service's GITHUB_TOKEN from $CONF_DIR/env? [Y/n] " answer || return 0
    if [[ "$answer" =~ ^[Nn] ]]; then
        if read -rsp "Updater token (fine-grained, Contents: read-only on $UPDATE_REPO): " token; then
            printf '%s' "$token"
        fi
        echo >&2
    fi
}

# Chooses the updater's token: UPDATER_GITHUB_TOKEN, the token already configured, INSTALL_GITHUB_TOKEN (the one the
# one-line installer downloaded this release with; asked first when interactive, and only an explicit answer other
# than "n" stores it: an EOF stores nothing and asks nothing more), a prompt, or the service's own GITHUB_TOKEN from env.
choose_updater_token() {
    local current token="" answer=""
    current="$(setting TOKEN_FILE)"
    if [[ -n "${UPDATER_GITHUB_TOKEN:-}" ]]; then
        token="$UPDATER_GITHUB_TOKEN"
    elif [[ -n "$current" && -f "$current" ]]; then
        echo "$current"
        return
    elif [[ -n "${INSTALL_GITHUB_TOKEN:-}" ]] && ! interactive; then
        token="$INSTALL_GITHUB_TOKEN"
    elif [[ -n "${INSTALL_GITHUB_TOKEN:-}" ]]; then
        if read -rp "Use the GitHub token this release was downloaded with for automatic updates? [Y/n] " answer; then
            if [[ "$answer" =~ ^[Nn] ]]; then
                token="$(ask_updater_token)"
            else
                token="$INSTALL_GITHUB_TOKEN"
            fi
        fi
    elif interactive; then
        token="$(ask_updater_token)"
    fi
    if [[ -n "$token" ]]; then
        (umask 077 && printf '%s\n' "$token" > "$UPDATER_TOKEN_FILE")
        chown root:root "$UPDATER_TOKEN_FILE"
        chmod 600 "$UPDATER_TOKEN_FILE"
        echo "$UPDATER_TOKEN_FILE"
    else
        echo "$CONF_DIR/env"
    fi
}

# Persist enabled state $1 and token path $2 in a root-owned, mode-600 settings file.
write_auto_conf() {
    (umask 077 && printf 'AUTO_UPDATE=%s\nTOKEN_FILE=%s\n' "$1" "$2" > "$AUTO_CONF")
    chown root:root "$AUTO_CONF"
    chmod 600 "$AUTO_CONF"
}

# Write the hardened oneshot unit $1 (description $2) that runs the updater (auto-update.sh --apply) as root.
write_update_service() {
    local parent
    parent="$(dirname "$APP_DIR")"
    cat > "$1" <<UNIT
[Unit]
Description=$2
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=SERVICE_NAME=${SERVICE_NAME} SERVICE_USER=${SERVICE_USER} APP_DIR=${APP_DIR} CONF_DIR=${CONF_DIR} NODE_BIN=${NODE_BIN}
ExecStart=${BASH_BIN} ${APP_DIR}/scripts/auto-update.sh --apply
TimeoutStartSec=15min
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${parent} ${CONF_DIR} /etc/systemd/system /run/lock
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
UNIT
    chmod 644 "$1"  # explicit: root's umask may be strict
}

# Write hardened daily update units, reload systemd and enable the update timer.
install_updater_units() {
    write_update_service "$UPDATE_UNIT" "Update ${SERVICE_NAME} from its latest GitHub release"
    cat > "$UPDATE_TIMER" <<UNIT
[Unit]
Description=Daily update check for ${SERVICE_NAME}

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
    chmod 644 "$UPDATE_UNIT" "$UPDATE_TIMER"  # explicit: root's umask may be strict
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}-update.timer" >/dev/null
}

# "Update now" on the admin page, whether or not daily updates are on: the service may rewrite $UPDATE_REQUEST (and no
# other new file in /etc); a change starts the same root update run as the daily timer. Root never reads the file, and
# nothing the service writes reaches the update: it only says "run now".
install_update_now_units() {
    # paused while the file is (re)made: creating it or changing its owner would count as a request
    systemctl stop "${SERVICE_NAME}-update-now.path" 2>/dev/null || true
    if [[ ! -f "$UPDATE_REQUEST" || -L "$UPDATE_REQUEST" ]]; then
        rm -f "$UPDATE_REQUEST"
        (umask 077 && : > "$UPDATE_REQUEST")
    fi
    chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$UPDATE_REQUEST"
    chmod 600 "$UPDATE_REQUEST"
    write_update_service "$UPDATE_NOW_UNIT" "Update ${SERVICE_NAME} now (requested on its admin page)"
    cat > "$UPDATE_NOW_PATH" <<UNIT
[Unit]
Description=Start ${SERVICE_NAME}-update-now when the admin page asks for an update

[Path]
PathChanged=${UPDATE_REQUEST}
Unit=${SERVICE_NAME}-update-now.service

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$UPDATE_NOW_PATH"
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}-update-now.path" >/dev/null
}

# Save the token choice, enable daily updates and check access unless upgrading unattended.
enable_auto_update() {
    local token_file
    token_file="$(choose_updater_token)"
    write_auto_conf yes "$token_file"
    install_updater_units
    echo "Automatic updates on: daily check (randomized time) of $UPDATE_REPO, token from $token_file."
    if [[ "$upgrade" == no ]]; then
        local rc=0
        run_updater --check >/dev/null 2>&1 || rc=$?
        if [[ $rc -eq 75 ]]; then
            echo "Another update run is in progress; check later with: sudo $APP_DIR/scripts/install-service.sh --check-update" >&2
        elif [[ $rc -ne 0 && $rc -ne 10 ]]; then
            echo "Warning: the update check failed; make sure the token in $token_file can read $UPDATE_REPO." >&2
            echo "Try it with: sudo $APP_DIR/scripts/install-service.sh --check-update" >&2
        fi
    fi
}

# Remove update units and the separate token, then persist the disabled state.
disable_auto_update() {
    remove_updater_units
    systemctl daemon-reload
    rm -f "$UPDATER_TOKEN_FILE"
    write_auto_conf no ""
    echo "Automatic updates off."
}

if [[ "$action" == enable || "$action" == disable ]]; then
    if [[ ! -f "$APP_DIR/src/updater.js" ]]; then
        echo "$APP_DIR is not installed (or too old for auto-update); run: sudo $0 --auto-update" >&2
        exit 1
    fi
    "${action}_auto_update"
    exit 0
fi

# Asks for a new admin page password (twice, hidden) and prints it; prints nothing when none was given.
ask_admin_password() {
    local pw="" again=""
    while true; do
        read -rsp "Password for the administration page (at least 8 characters): " pw || pw=""
        echo >&2
        [[ -z "$pw" ]] && return 0
        if [[ ${#pw} -lt 8 ]]; then
            echo "Too short; use at least 8 characters." >&2
            continue
        fi
        read -rsp "Repeat the password: " again || again=""
        echo >&2
        if [[ "$pw" == "$again" ]]; then
            printf '%s' "$pw"
            return 0
        fi
        echo "The passwords do not match; try again." >&2
    done
}

# Asks for the notification e-mail settings and exports them as FOUNDRY_BACKUP_* variables for src/admin.js setup.
ask_notify() {
    local value=""
    echo "The service can e-mail you when a backup fails (and when it has updated itself)." >&2
    read -rp "E-mail addresses for these notifications (comma separated; Enter = none): " value || value=""
    [[ -z "$value" ]] && return 0
    export FOUNDRY_BACKUP_NOTIFY_EMAILS="$value"
    read -rp "SMTP server (e.g. smtp.gmail.com): " value || value=""
    export FOUNDRY_BACKUP_SMTP_HOST="$value"
    read -rp "SMTP security, starttls / tls / none [starttls]: " value || value=""
    export FOUNDRY_BACKUP_SMTP_SECURITY="${value:-starttls}"
    local port=587
    [[ "$FOUNDRY_BACKUP_SMTP_SECURITY" == tls ]] && port=465
    [[ "$FOUNDRY_BACKUP_SMTP_SECURITY" == none ]] && port=25
    read -rp "SMTP port [$port]: " value || value=""
    export FOUNDRY_BACKUP_SMTP_PORT="${value:-$port}"
    read -rp "SMTP user name (Enter = no login): " value || value=""
    export FOUNDRY_BACKUP_SMTP_USER="$value"
    if [[ -n "$value" ]]; then
        read -rsp "SMTP password: " value || value=""
        echo >&2
        export FOUNDRY_BACKUP_SMTP_PASSWORD="$value"
    fi
    read -rp "Sender address (From): " value || value=""
    export FOUNDRY_BACKUP_SMTP_FROM="$value"
}

# Creates or updates admin.json through src/admin.js (secrets go through the environment only), owned by the service
# user with mode 600. $1: first = new file (asks for everything when interactive; the password is required),
# password / notify = change that part.
configure_admin() {
    local what="$1" file="$CONF_DIR/admin.json" pw=""
    if interactive; then
        if [[ "$what" != notify && -z "${FOUNDRY_BACKUP_ADMIN_PASSWORD:-}" ]]; then
            while [[ -z "$pw" ]]; do
                pw="$(ask_admin_password)"
                [[ -n "$pw" ]] || echo "The administration page is where the backups are set up, so it needs a password." >&2
            done
            export FOUNDRY_BACKUP_ADMIN_PASSWORD="$pw"
        fi
        if [[ "$what" != password && -z "${FOUNDRY_BACKUP_NOTIFY_EMAILS:-}" ]]; then ask_notify; fi
    fi
    if [[ "$what" != notify && -z "${FOUNDRY_BACKUP_ADMIN_PASSWORD:-}" ]]; then
        echo "No admin password given (set FOUNDRY_BACKUP_ADMIN_PASSWORD, at least 8 characters, or run this in a terminal)." >&2
        exit 1
    fi
    if [[ "$what" == password ]]; then
        # only the password: notification variables from the caller's environment stay out
        unset FOUNDRY_BACKUP_NOTIFY_EMAILS FOUNDRY_BACKUP_SMTP_HOST FOUNDRY_BACKUP_SMTP_PORT FOUNDRY_BACKUP_SMTP_SECURITY \
            FOUNDRY_BACKUP_SMTP_USER FOUNDRY_BACKUP_SMTP_PASSWORD FOUNDRY_BACKUP_SMTP_FROM
    elif [[ "$what" == notify ]]; then
        unset FOUNDRY_BACKUP_ADMIN_PASSWORD
    fi
    (umask 077 && "$NODE_BIN" "$SRC_DIR/src/admin.js" setup "$file")
    chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$file"
    chmod 600 "$file"
    unset FOUNDRY_BACKUP_ADMIN_PASSWORD FOUNDRY_BACKUP_SMTP_PASSWORD
}

ADMIN_CERT="$CONF_DIR/admin-tls.crt"
ADMIN_KEY="$CONF_DIR/admin-tls.key"

# Set KEY=VALUE in the env file, or remove KEY when VALUE is empty; the file stays 600 and owned by the service user.
set_env_value() {
    local key="$1" value="$2" tmp
    tmp="$(mktemp "$CONF_DIR/.env.XXXXXX")"
    grep -v "^${key}=" "$CONF_DIR/env" > "$tmp" || true
    if [[ -n "$value" ]]; then printf '%s=%s\n' "$key" "$value" >> "$tmp"; fi
    chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$CONF_DIR/env"
}

# Self-signed certificate for the admin page (made once; $1 = force makes a new one). root-owned, so the service
# reads it but cannot change it.
make_admin_cert() {
    if [[ -f "$ADMIN_CERT" && -f "$ADMIN_KEY" && "${1:-}" != force ]]; then return 0; fi
    local public host=""
    public="$(env_value ADMIN_PUBLIC_URL)"
    if [[ -n "$public" ]]; then
        host="$("$NODE_BIN" -e 'console.log(new URL(process.argv[1]).hostname)' "$public" 2>/dev/null || true)"
    fi
    (umask 077 && "$NODE_BIN" "$SRC_DIR/src/selfsigned.js" "$ADMIN_CERT" "$ADMIN_KEY" ${host:+"$host"})
    chown "root:$(id -gn "$SERVICE_USER")" "$ADMIN_CERT" "$ADMIN_KEY"
    chmod 644 "$ADMIN_CERT"
    chmod 640 "$ADMIN_KEY"
}

# The worlds folder of the Foundry data folder $1 (prints nothing when $1 is not one).
worlds_dir_of() {
    local d
    for d in "$1/Data/worlds" "$1/worlds" "$1"; do
        if [[ -d "$d" && "$(basename "$d")" == worlds ]]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}

# Succeeds when the service user can list the worlds folder $1 and read a world.json in it.
can_read_worlds() {
    local dir="$1" probe
    command -v setpriv >/dev/null 2>&1 || return 0
    probe="$(find "$dir" -mindepth 2 -maxdepth 2 -name world.json 2>/dev/null | head -n 1)"
    setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups \
        test -r "$dir" -a -x "$dir" -a \( -z "$probe" -o -r "$probe" \)
}

# Gives the service user read access to the worlds folder $1 and the right to traverse its parents (POSIX ACLs; new
# folders and files Foundry creates inherit the read right through the default ACL). Prints the manual commands when
# setfacl is missing or refuses (a filesystem without ACL support).
grant_access() {
    local dir="$1" parent
    if can_read_worlds "$dir"; then
        echo "The service user $SERVICE_USER can read $dir."
        return 0
    fi
    if command -v setfacl >/dev/null 2>&1; then
        parent="$(dirname "$dir")"
        local ok=yes
        while [[ "$parent" != / && "$parent" != . ]]; do
            setfacl -m "u:$SERVICE_USER:x" "$parent" 2>/dev/null || ok=no
            parent="$(dirname "$parent")"
        done
        setfacl -R -m "u:$SERVICE_USER:rX" -m "d:u:$SERVICE_USER:rX" "$dir" 2>/dev/null || ok=no
        if [[ "$ok" == yes ]] && can_read_worlds "$dir"; then
            echo "Gave $SERVICE_USER read access to $dir (ACL; new worlds inherit it)."
            return 0
        fi
    fi
    echo "WARNING: the service user $SERVICE_USER cannot read $dir, so no world can be backed up yet. Either:" >&2
    echo "  - install the acl package and re-run: sudo $APP_DIR/scripts/install-service.sh --grant-access" >&2
    echo "  - or give it access by hand: setfacl -m u:$SERVICE_USER:x <each parent folder>; setfacl -R -m u:$SERVICE_USER:rX -m d:u:$SERVICE_USER:rX $dir" >&2
    echo "  - or reinstall with --run-as <the user Foundry runs as> (after: sudo $APP_DIR/scripts/install-service.sh --uninstall --purge)" >&2
    return 1
}

# A likely Foundry data folder on this machine, for the prompt (prints nothing when none is found).
guess_foundry_data() {
    local d
    for d in /home/*/foundrydata /home/*/FoundryVTT /home/*/foundryvtt-data /home/*/.local/share/FoundryVTT \
        /opt/foundrydata /opt/foundryvtt/data /opt/foundryvtt-data /var/lib/foundryvtt /srv/foundrydata /srv/foundryvtt/data; do
        if [[ -d "$d/Data/worlds" ]]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}

# The service's systemd unit. An admin port below 1024 (e.g. 443) gets CAP_NET_BIND_SERVICE and nothing else.
write_unit() {
    local caps="" port group
    port="$(env_value ADMIN_PORT)"
    group="$(id -gn "$SERVICE_USER")"
    if [[ "$port" =~ ^[0-9]+$ ]] && (( port < 1024 )); then
        caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
    fi
    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Foundry VTT world backup to GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${group}
EnvironmentFile=${CONF_DIR}/env
Environment=HOME=${STATE_DIR}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
# the admin page rewrites these four files in place (and nothing else under /etc); the git copies live in the state folder
ReadWritePaths=-${CONF_DIR}/config.json -${CONF_DIR}/admin.json -${CONF_DIR}/env -${CONF_DIR}/update-request ${STATE_DIR}
# read-only, not hidden: Foundry's data folder is often under /home
ProtectHome=read-only
PrivateTmp=true
${caps}

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$UNIT_FILE"  # explicit: root's umask may be strict
}

# Where the admin page is, for the end of a run.
print_admin_info() {
    local port scheme public
    port="$(env_value ADMIN_PORT)"
    port="${port:-$DEFAULT_ADMIN_PORT}"
    scheme=https
    if [[ "$(env_value ADMIN_TLS)" =~ ^(off|0|false|no)$ ]]; then scheme=http; fi
    echo "Admin:   $scheme://$(uname -n):$port/ in a browser on any computer here, or:"
    for ip in $(hostname -I 2>/dev/null); do
        if [[ "$ip" == *:* ]]; then echo "         $scheme://[$ip]:$port/"; else echo "         $scheme://$ip:$port/"; fi
    done
    public="$(env_value ADMIN_PUBLIC_URL)"
    if [[ -n "$public" ]]; then echo "         $public (public address)"; fi
    if [[ "$scheme" == https && -f "$ADMIN_CERT" ]]; then
        echo "         self-signed certificate: the browser warns once; its SHA-256 fingerprint is"
        echo "         $("$NODE_BIN" -e 'console.log(new (require("crypto").X509Certificate)(require("fs").readFileSync(process.argv[1])).fingerprint256)' "$ADMIN_CERT")"
    fi
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
        echo "         the ufw firewall is on: allow the port with: sudo ufw allow $port/tcp"
    fi
}

if [[ "$action" == renew-cert || "$action" == grant ]]; then
    if [[ ! -f "$APP_DIR/src/selfsigned.js" || ! -f "$CONF_DIR/env" ]]; then
        echo "The service is not installed; install it first: sudo $0" >&2
        exit 1
    fi
    SRC_DIR="$APP_DIR"
    if [[ "$action" == renew-cert ]]; then
        make_admin_cert force
        systemctl restart "$SERVICE_NAME"
        echo "Restarted $SERVICE_NAME with a new certificate."
        print_admin_info
    else
        worlds="$(worlds_dir_of "$(env_value FOUNDRY_DATA)")" || { echo "FOUNDRY_DATA in $CONF_DIR/env is not a Foundry data folder." >&2; exit 1; }
        grant_access "$worlds"
    fi
    exit 0
fi

if [[ "$action" == admin-password || "$action" == notify ]]; then
    if [[ ! -f "$APP_DIR/src/admin.js" || ! -f "$CONF_DIR/env" ]]; then
        echo "The service is not installed; install it first: sudo $0" >&2
        exit 1
    fi
    SRC_DIR="$APP_DIR"
    if [[ "$action" == admin-password ]]; then configure_admin password; else configure_admin notify; fi
    systemctl restart "$SERVICE_NAME"
    echo "Restarted $SERVICE_NAME."
    exit 0
fi

# git does the backups; the service user must be able to run it.
if ! command -v git >/dev/null 2>&1; then
    echo "git is not installed; the backups need it. Install it first (Debian/Ubuntu/Raspberry Pi OS: sudo apt install git)." >&2
    exit 1
fi

# A first install needs the Foundry data folder and, with --yes, the admin password; fail before anything is changed.
if [[ ! -f "$CONF_DIR/env" ]]; then
    if [[ -z "$foundry_data" ]]; then
        guess="$(guess_foundry_data || true)"
        if interactive; then
            read -rp "Foundry user data folder (the one with Config, Data and Logs)${guess:+ [$guess]}: " foundry_data || foundry_data=""
            foundry_data="${foundry_data:-$guess}"
        else
            foundry_data="$guess"
        fi
    fi
    if [[ -z "$foundry_data" ]]; then
        echo "No Foundry data folder: pass --foundry-data DIR (or set FOUNDRY_BACKUP_DATA)." >&2
        exit 1
    fi
    foundry_data="$(readlink -f "$foundry_data")"
    worlds="$(worlds_dir_of "$foundry_data")" || { echo "$foundry_data has no Data/worlds folder; is it the Foundry user data folder?" >&2; exit 1; }
    if [[ "$assume_yes" == yes && -z "${FOUNDRY_BACKUP_ADMIN_PASSWORD:-}" ]]; then
        echo "--yes: no admin password. Set FOUNDRY_BACKUP_ADMIN_PASSWORD (at least 8 characters) and pass it through sudo:" >&2
        echo "sudo --preserve-env=FOUNDRY_BACKUP_ADMIN_PASSWORD,FOUNDRY_BACKUP_GITHUB_TOKEN ..." >&2
        exit 1
    fi
    if [[ -n "$admin_port" ]] && { [[ ! "$admin_port" =~ ^[0-9]+$ ]] || (( admin_port < 1 || admin_port > 65535 )); }; then
        echo "Invalid admin port '$admin_port' (1-65535)." >&2
        exit 1
    fi
fi

# The service user: a dedicated unprivileged one unless --run-as named an existing user.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    if [[ "$SERVICE_USER" != "$DEFAULT_USER" ]]; then
        echo "User $SERVICE_USER does not exist (--run-as needs an existing user)." >&2
        exit 1
    fi
    useradd --system --no-create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created system user $SERVICE_USER."
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

# Code: replaced on each run so updating = pull + re-run this script (or let the updater do it).
if [[ "$SRC_DIR" != "$(readlink -f "$APP_DIR" 2>/dev/null || echo "$APP_DIR")" ]]; then
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    cp -r "$SRC_DIR/src" "$SRC_DIR/scripts" "$SRC_DIR/package.json" "$APP_DIR/"
    for f in README.md config.example.json .env.example; do
        if [[ -f "$SRC_DIR/$f" ]]; then cp "$SRC_DIR/$f" "$APP_DIR/"; fi
    done
    chown -R root:root "$APP_DIR"
    # Explicit modes, whatever root's umask was: root may write, everyone may read and enter.
    chmod -R u=rwX,go=rX "$APP_DIR"
fi

# Settings and state: created once, never overwritten.
install -d -m 750 -o root -g "$SERVICE_GROUP" "$CONF_DIR"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
    (umask 077 && echo '{}' > "$CONF_DIR/config.json")
    echo "Wrote $CONF_DIR/config.json (the administration page fills it in)."
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/config.json"
chmod 600 "$CONF_DIR/config.json"
# admin.json: created once (asks for the admin password and notification e-mails), never overwritten here.
if [[ ! -f "$CONF_DIR/admin.json" ]]; then
    configure_admin first
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/admin.json"
chmod 600 "$CONF_DIR/admin.json"
if [[ ! -f "$CONF_DIR/env" ]]; then
    token="REPLACE_ME"
    if [[ -n "${FOUNDRY_BACKUP_GITHUB_TOKEN:-}" ]]; then
        token="$FOUNDRY_BACKUP_GITHUB_TOKEN"
    elif interactive; then
        read -rsp "GitHub token (fine-grained: Contents read/write + Administration read/write; Enter to paste it on the admin page later): " input || true
        echo
        [[ -n "${input:-}" ]] && token="$input"
    fi
    (
        umask 077
        {
            echo "GITHUB_TOKEN=${token}"
            echo "FOUNDRY_DATA=${foundry_data}"
            echo "CONFIG_FILE=${CONF_DIR}/config.json"
            echo "STATE_DIR=${STATE_DIR}"
            echo "ADMIN_PORT=${admin_port:-$DEFAULT_ADMIN_PORT}"
            echo "ADMIN_HOST=0.0.0.0"
            echo "FOUNDRY_URL=${FOUNDRY_BACKUP_FOUNDRY_URL-http://localhost:30000}"
            if [[ -n "${FOUNDRY_BACKUP_ADMIN_PUBLIC_URL:-}" ]]; then echo "ADMIN_PUBLIC_URL=${FOUNDRY_BACKUP_ADMIN_PUBLIC_URL}"; fi
        } > "$CONF_DIR/env"
    )
    echo "Wrote $CONF_DIR/env."
elif [[ -n "$admin_port" && "$admin_port" != "$(env_value ADMIN_PORT)" ]]; then
    set_env_value ADMIN_PORT "$admin_port"
    echo "Admin port changed to $admin_port."
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/env"
chmod 600 "$CONF_DIR/env"
if [[ ! "$(env_value ADMIN_TLS)" =~ ^(off|0|false|no)$ ]]; then make_admin_cert; fi

# Read access to the worlds (a warning, not an error: the page shows which worlds cannot be read).
worlds="$(worlds_dir_of "$(env_value FOUNDRY_DATA)" || true)"
if [[ -n "$worlds" ]]; then grant_access "$worlds" || true; else echo "WARNING: FOUNDRY_DATA in $CONF_DIR/env is not a Foundry data folder." >&2; fi

install_update_now_units
write_unit

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
echo "Installed $UNIT_FILE (user: $SERVICE_USER, code: $APP_DIR, settings: $CONF_DIR, state: $STATE_DIR)."
if grep -q '^GITHUB_TOKEN=REPLACE_ME' "$CONF_DIR/env"; then
    echo "No GitHub token yet: paste one on the administration page (GitHub) before the first backup."
fi

# Automatic updates: the command line wins, then the saved choice, then (first install only) a prompt.
saved="$(setting AUTO_UPDATE)"
if [[ -z "$auto_update" ]]; then
    if [[ -n "$saved" ]]; then
        auto_update="$saved"
    elif interactive; then
        read -rp "Turn on automatic updates (daily check for new releases of this service)? [y/N] " answer || true
        if [[ "${answer:-}" =~ ^[Yy] ]]; then auto_update=yes; else auto_update=no; fi
    else
        auto_update=no
    fi
fi
if [[ "$auto_update" == yes ]]; then
    enable_auto_update
elif [[ "$saved" == yes || -f "$UPDATE_TIMER" ]]; then
    disable_auto_update
elif [[ -z "$saved" ]]; then
    write_auto_conf no ""
fi

echo "Status:  systemctl status $SERVICE_NAME"
echo "Logs:    journalctl -u $SERVICE_NAME -f"
print_admin_info

#!/usr/bin/env bash
# Updates an installed service from the latest GitHub release of this repository.
# Normally run as root by the systemd timer that `install-service.sh --enable-auto-update` sets up;
# `install-service.sh --check` and `--update-now` run it by hand.
#
#   auto-update.sh --check   report whether a newer release exists (exit 0 = up to date, 10 = update available,
#                            75 = another update run holds the lock, so nothing was checked; anything else = error)
#   auto-update.sh --apply   download, verify (SHA256SUMS.txt), install it through install-service.sh --upgrade and
#                            restart the service; on any failure the previous install is put back
#
# The release lookup, version comparison, download and checksum check are in src/updater.js; this script only
# locks, extracts, backs up, installs and rolls back. config.json, env and the state are never touched (the installer keeps
# them). This repository is public, so no token is needed; when the file named in auto-update.conf (default: env) holds
# one, the updater uses it (a higher rate limit). The token is read from that file by updater.js and never printed.
#
# --apply e-mails the recipients in admin.json (installer or admin page) when it installed a new version or failed;
# src/notify.js does that as the service's own user (setpriv), so root never parses the file that user can write.
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-foundry-world-backup}"
SERVICE_USER="${SERVICE_USER:-foundry-backup}"
APP_DIR="${APP_DIR:-/opt/${SERVICE_NAME}}"
CONF_DIR="${CONF_DIR:-/etc/${SERVICE_NAME}}"
BACKUP_DIR="${APP_DIR}.prev"
LOCK_FILE="/run/lock/${SERVICE_NAME}-update.lock"
AUTO_CONF="$CONF_DIR/auto-update.conf"

# Write the supplied message to stdout with the updater prefix.
log() { echo "auto-update: $*"; }
# Write the supplied error to stderr and exit with status 1.
fail() { echo "auto-update: ERROR: $*" >&2; exit 1; }

# E-mail subject $1 / text $2 to the notification recipients, as the service user. Never fails the update.
notify() {
    local script="$APP_DIR/src/notify.js"
    [[ -f "$script" && -f "$CONF_DIR/admin.json" && -r "$CONF_DIR/env" ]] || return 0
    if ! command -v setpriv >/dev/null 2>&1 || ! id "$SERVICE_USER" >/dev/null 2>&1; then
        log "cannot switch to $SERVICE_USER (setpriv); no notification e-mail"
        return 0
    fi
    setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups \
        "$NODE_BIN" "$script" --service-env "$CONF_DIR/env" --subject "$1" --message "$2" 2>&1 |
        sed 's/^/auto-update: /' || true
}
# --apply only: report the failure $* by e-mail, then fail.
apply_fail() {
    notify "automatic update failed" "The automatic update of the Foundry world backup failed: $*"
    fail "$*"
}

mode="${1:-}"
[[ "$mode" == "--check" || "$mode" == "--apply" ]] || fail "usage: $0 --check|--apply"
[[ $EUID -eq 0 ]] || fail "must run as root"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || fail "node not found; set NODE_BIN"
[[ -f "$APP_DIR/src/updater.js" ]] || fail "$APP_DIR/src/updater.js not found; is the service installed?"

# KEY=value from auto-update.conf without sourcing it.
setting() {
    [[ -f "$AUTO_CONF" ]] || return 0
    sed -n "s/^$1=//p" "$AUTO_CONF" | tail -n 1
}
TOKEN_FILE="$(setting TOKEN_FILE)"
TOKEN_FILE="${TOKEN_FILE:-$CONF_DIR/env}"
# Optional: without a readable token file the release lookup and download go to GitHub without a token.
token_args=()
if [[ -r "$TOKEN_FILE" ]]; then
    token_args=(--token-file "$TOKEN_FILE")
else
    log "no token file $TOKEN_FILE; checking the public releases without a token"
fi

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    # --check could not look, so it must not report "up to date" (0) or "update available" (10)
    if [[ "$mode" == "--check" ]]; then
        echo "auto-update: another update run is in progress; could not check (exit 75)" >&2
        exit 75
    fi
    log "another update run is in progress; nothing to do"
    exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/${SERVICE_NAME}-update.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

if [[ "$mode" == "--check" ]]; then
    rc=0
    "$NODE_BIN" "$APP_DIR/src/updater.js" --check --app-dir "$APP_DIR" ${token_args[@]+"${token_args[@]}"} || rc=$?
    exit "$rc"
fi

mkdir "$work/download" "$work/extract"
rc=0
out="$("$NODE_BIN" "$APP_DIR/src/updater.js" --download "$work/download" --format tar.gz \
    --app-dir "$APP_DIR" ${token_args[@]+"${token_args[@]}"})" || rc=$?
printf '%s\n' "$out" | grep -v -e '^ARCHIVE=' -e '^VERSION=' | sed 's/^/auto-update: /' || true
case "$rc" in
    0) exit 0 ;;
    10) ;;
    *) apply_fail "update check failed (exit $rc); the installed version is unchanged" ;;
esac
archive="$(printf '%s\n' "$out" | sed -n 's/^ARCHIVE=//p')"
version="$(printf '%s\n' "$out" | sed -n 's/^VERSION=//p')"
[[ -f "$archive" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || apply_fail "updater gave no archive"

# Every entry must sit below foundry-world-backup-<version>/ with no absolute paths or "..".
top="foundry-world-backup-${version}"
while IFS= read -r entry; do
    if [[ "$entry" != "$top" && "$entry" != "$top/"* ]] || [[ "/$entry/" == *"/../"* ]]; then
        apply_fail "archive contains an unexpected path; refusing it"
    fi
done < <(tar -tzf "$archive")
tar -xzf "$archive" -C "$work/extract" --no-same-owner --no-same-permissions
new="$work/extract/$top"
[[ -f "$new/scripts/install-service.sh" && -f "$new/src/server.js" ]] || apply_fail "archive is missing the installer or server"
grep -q "\"version\": *\"${version//./\\.}\"" "$new/package.json" || apply_fail "archive package.json is not version $version"

was_active=no
systemctl is-active --quiet "$SERVICE_NAME" && was_active=yes
installed="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1)"

rm -rf "$BACKUP_DIR"
cp -a "$APP_DIR" "$BACKUP_DIR"
log "backed up $installed to $BACKUP_DIR; installing $version"

export SERVICE_NAME APP_DIR CONF_DIR NODE_BIN
# If the service was active before updating, wait ten seconds and return its active status.
healthy() {
    [[ "$was_active" == no ]] && return 0
    sleep 10
    systemctl is-active --quiet "$SERVICE_NAME"
}
if bash "$new/scripts/install-service.sh" --upgrade && healthy; then
    log "updated $installed -> $version"
    notify "updated to $version" "The Foundry world backup updated itself from $installed to $version."
    exit 0
fi

log "install of $version failed or the service did not come back; restoring $installed"
if [[ -f "$BACKUP_DIR/scripts/install-service.sh" ]]; then
    restore="$work/restore"
    cp -a "$BACKUP_DIR" "$restore"
    restored=yes
    bash "$restore/scripts/install-service.sh" --upgrade || restored=no
else
    restored=yes
    if ! { rm -rf "$APP_DIR" && cp -a "$BACKUP_DIR" "$APP_DIR"; }; then restored=no; fi
    if [[ "$was_active" == yes ]]; then systemctl restart "$SERVICE_NAME" || restored=no; fi
fi
if [[ "$restored" == yes ]] && healthy; then
    apply_fail "update to $version rolled back to $installed; see the log above (journalctl -u ${SERVICE_NAME}-update)"
fi
apply_fail "ROLLBACK FAILED: $installed could not be restored; reinstall it by hand from $BACKUP_DIR (sudo bash $BACKUP_DIR/scripts/install-service.sh --upgrade)"

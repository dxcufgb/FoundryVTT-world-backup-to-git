#!/usr/bin/env bash
# The Linux installer (systemd), at the top of the release archive and of the repository: checks for a usable
# Node.js, downloads the official one if needed, then runs scripts/install-service.sh, which sets up the service.
# It is what the one-line installer runs (as root, with your arguments):
#
#   curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-world-backup
#
#   sudo ./install.sh                                   # interactive: asks for the Foundry data folder, the token, ...
#   sudo ./install.sh --yes --auto-update               # no questions (settings from FOUNDRY_BACKUP_* variables)
#   FOUNDRY_BACKUP_GITHUB_TOKEN=github_pat_... FOUNDRY_BACKUP_ADMIN_PASSWORD=... \
#     sudo --preserve-env=FOUNDRY_BACKUP_GITHUB_TOKEN,FOUNDRY_BACKUP_ADMIN_PASSWORD ./install.sh --yes \
#       --foundry-data /home/foundry/foundrydata               # fully unattended
#   sudo ./install.sh --check-update                    # exit 0 = up to date, 10 = newer release available
#   sudo ./install.sh --set-admin-password              # change the password of the admin page
#   sudo ./install.sh --uninstall [--purge]             # remove service, updater, code and a Node.js installed here
#
# `./install.sh --help` lists every option. install.sh itself handles --install-node (download Node.js without asking),
# --no-install-node (never download) and --yes (no questions; implies --install-node unless --no-install-node is given);
# everything else is passed on to scripts/install-service.sh.
#
# Node.js: an existing system-wide node (>= 18, not under /home or /root) or $NODE_BIN is used as is. Otherwise the
# official Node.js 22 tarball for this CPU is downloaded from nodejs.org, checked against its published SHA-256 and
# unpacked to /opt/foundry-world-backup-node (outside the code folder, so updates keep it). git must be installed
# (apt install git); the installer says so when it is missing.
set -euo pipefail

NODE_MAJOR=22
NODE_MIN_MAJOR=18
NODE_DIR="${NODE_DIR:-/opt/foundry-world-backup-node}"
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist/latest-v${NODE_MAJOR}.x}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install_node=ask
assume_yes=no
manage=no          # an action on an existing install: never download Node.js for it
passthrough=()
uninstall=no
for arg in "$@"; do
    case "$arg" in
        --install-node) install_node=yes ;;
        --no-install-node) install_node=no ;;
        --yes | -y) assume_yes=yes; passthrough+=("$arg") ;;
        -h | --help)
            if [[ -f "$HERE/scripts/install-service.sh" ]]; then
                exec bash "$HERE/scripts/install-service.sh" --help
            fi
            sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        --uninstall) uninstall=yes; passthrough+=("$arg") ;;
        --check | --check-update | --update-now | --enable-auto-update | --disable-auto-update | \
            --set-admin-password | --set-notify | --renew-admin-cert | --grant-access)
            manage=yes; passthrough+=("$arg") ;;
        *) passthrough+=("$arg") ;;
    esac
done
if [[ "$assume_yes" == yes && "$install_node" == ask ]]; then install_node=yes; fi

if [[ $EUID -ne 0 ]]; then
    echo "Re-running with sudo..." >&2
    keep=FOUNDRY_BACKUP_GITHUB_TOKEN,UPDATER_GITHUB_TOKEN,INSTALL_GITHUB_TOKEN,NODE_BIN,FOUNDRY_BACKUP_ADMIN_PASSWORD
    keep+=,FOUNDRY_BACKUP_NOTIFY_EMAILS,FOUNDRY_BACKUP_SMTP_HOST,FOUNDRY_BACKUP_SMTP_PORT,FOUNDRY_BACKUP_SMTP_SECURITY
    keep+=,FOUNDRY_BACKUP_SMTP_USER,FOUNDRY_BACKUP_SMTP_PASSWORD,FOUNDRY_BACKUP_SMTP_FROM
    keep+=,FOUNDRY_BACKUP_DATA,FOUNDRY_BACKUP_ADMIN_PORT,FOUNDRY_BACKUP_ADMIN_PUBLIC_URL,FOUNDRY_BACKUP_FOUNDRY_URL
    exec sudo --preserve-env="$keep" "$0" "$@"
fi
if [[ ! -x "$HERE/scripts/install-service.sh" ]]; then
    echo "scripts/install-service.sh not found next to install.sh; run it from a clone or an unpacked release." >&2
    exit 1
fi

if [[ "$uninstall" == yes ]]; then
    "$HERE/scripts/install-service.sh" "${passthrough[@]}"
    rm -rf "$NODE_DIR"
    exit 0
fi

# Succeeds when $1 is a node binary of version >= NODE_MIN_MAJOR outside the home directories the service cannot use.
usable_node() {
    local bin="$1" real major
    [[ -n "$bin" && -x "$bin" ]] || return 1
    real="$(readlink -f "$bin")"
    [[ "$real" == /home/* || "$real" == /root/* ]] && return 1
    major="$("$real" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
    [[ "$major" =~ ^[0-9]+$ && "$major" -ge "$NODE_MIN_MAJOR" ]]
}

# Download, verify and unpack the official Node.js tarball into NODE_DIR.
download_node() {
    local arch tmp name sums
    case "$(uname -m)" in
        x86_64 | amd64) arch=x64 ;;
        aarch64 | arm64) arch=arm64 ;;
        armv7l | armv8l) arch=armv7l ;;
        *) echo "No official Node.js build for $(uname -m); install Node.js >= $NODE_MIN_MAJOR yourself." >&2; exit 1 ;;
    esac
    for tool in curl tar xz sha256sum; do
        command -v "$tool" >/dev/null || { echo "'$tool' is needed to download Node.js." >&2; exit 1; }
    done
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    echo "Downloading Node.js ${NODE_MAJOR}.x for linux-${arch} from nodejs.org..."
    curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$NODE_DIST/SHASUMS256.txt"
    sums="$(grep -E " node-v[0-9.]+-linux-${arch}\\.tar\\.xz\$" "$tmp/SHASUMS256.txt" | head -n 1)"
    [[ -n "$sums" ]] || { echo "nodejs.org lists no linux-${arch} build of Node.js ${NODE_MAJOR}." >&2; exit 1; }
    name="${sums##* }"
    curl -fsSL --retry 3 -o "$tmp/$name" "$NODE_DIST/$name"
    (cd "$tmp" && printf '%s\n' "$sums" | sha256sum --check --status) \
        || { echo "Checksum mismatch for $name; not installing it." >&2; exit 1; }
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xJf "$tmp/$name" -C "$NODE_DIR" --strip-components=1
    chown -R root:root "$NODE_DIR"
    # the service user must be able to run it, whatever root's umask is
    chmod -R u=rwX,go=rX "$NODE_DIR"
    rm -rf "$tmp"
    trap - EXIT
    echo "Installed ${name%.tar.xz} to $NODE_DIR."
}

node_bin="${NODE_BIN:-$(command -v node || true)}"
if ! usable_node "$node_bin"; then
    if usable_node "$NODE_DIR/bin/node"; then
        node_bin="$NODE_DIR/bin/node"
    elif [[ "$manage" == yes ]]; then
        # checking, updating or switching auto-update on/off never installs Node.js; the service script reports it
        exec "$HERE/scripts/install-service.sh" ${passthrough[@]+"${passthrough[@]}"}
    else
        case "$install_node" in
            yes) ;;
            no)
                echo "No usable Node.js (>= $NODE_MIN_MAJOR, system-wide) found and --no-install-node was given." >&2
                exit 1
                ;;
            *)
                if [[ -t 0 ]]; then
                    read -rp "No usable system-wide Node.js found. Download the official Node.js ${NODE_MAJOR} to $NODE_DIR? [Y/n] " answer || true
                    if [[ "${answer:-}" =~ ^[Nn] ]]; then
                        echo "Install Node.js >= $NODE_MIN_MAJOR system-wide (not nvm) or set NODE_BIN, then re-run." >&2
                        exit 1
                    fi
                else
                    echo "No usable system-wide Node.js found; re-run with --install-node (or --yes) to download one." >&2
                    exit 1
                fi
                ;;
        esac
        download_node
        node_bin="$NODE_DIR/bin/node"
    fi
fi
export NODE_BIN="$node_bin"
echo "Using Node.js $("$NODE_BIN" -p process.versions.node) at $NODE_BIN."

exec "$HERE/scripts/install-service.sh" ${passthrough[@]+"${passthrough[@]}"}

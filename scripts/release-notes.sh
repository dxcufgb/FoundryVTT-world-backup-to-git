#!/usr/bin/env bash
# Prints the top of a release's notes: per-OS download links and install commands, as Markdown.
#
#   ./scripts/release-notes.sh VERSION OWNER/REPO > notes.md
#
# release.yml puts it in front of GitHub's generated notes (the list of merged pull requests), or in front of the notes
# of a release published by hand. The file names must match scripts/build-release.sh.
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 VERSION OWNER/REPO" >&2
    exit 2
fi
VERSION="$1"
REPO="$2"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "version '$VERSION' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE" >&2
    exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "repository '$REPO' is not OWNER/REPO" >&2
    exit 1
fi

TAG="v$VERSION"
NAME="foundry-world-backup-$VERSION"
BASE="https://github.com/$REPO/releases"
DL="$BASE/download/$TAG"
LATEST="$BASE/latest/download"

cat <<EOF
## Downloads

| OS | File | This release | Always the latest |
| --- | --- | --- | --- |
| Windows 10/11 (x64) | Setup wizard, brings its own Node.js (git must be installed) | [$NAME-setup.exe]($DL/$NAME-setup.exe) | [foundry-world-backup-setup.exe]($LATEST/foundry-world-backup-setup.exe) |
| Windows (manual / PowerShell) | Archive | [$NAME-windows.zip]($DL/$NAME-windows.zip) | [foundry-world-backup-windows.zip]($LATEST/foundry-world-backup-windows.zip) |
| Linux / Raspberry Pi (x64, arm64, armv7) | Archive with \`install.sh\` (git must be installed) | [$NAME-linux.tar.gz]($DL/$NAME-linux.tar.gz) | [foundry-world-backup-linux.tar.gz]($LATEST/foundry-world-backup-linux.tar.gz) |

Checksums of all files: [SHA256SUMS.txt]($DL/SHA256SUMS.txt).
The repository is private, so the links only work when you are signed in to GitHub with access to it.

### Linux / Raspberry Pi

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-world-backup
\`\`\`

It asks for a fine-grained token with read-only *Contents* access to this repository. Or by hand:

\`\`\`sh
gh release download $TAG --repo $REPO --pattern '$NAME-linux.tar.gz' --pattern SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt
tar xzf $NAME-linux.tar.gz
cd $NAME
sudo ./install.sh
\`\`\`

\`sudo ./install.sh --help\` lists the options (non-interactive install, automatic updates, update check, uninstall).

### Windows

Run \`$NAME-setup.exe\` and follow the wizard (it asks for administrator rights). Running it over an existing install
upgrades it and keeps the token, \`config.json\` and the local git copies. Unattended install and the manual PowerShell route are in the README.

Installs with automatic updates turned on pick this release up within a day.
EOF

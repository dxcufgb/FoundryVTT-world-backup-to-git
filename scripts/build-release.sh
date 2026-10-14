#!/usr/bin/env bash
# Builds the release files and their checksums from the working tree, with VERSION stamped into the built copy of
# package.json (the repository's own package.json is not changed; the release tag is the version):
#
#   ./scripts/build-release.sh [OUT_DIR] [VERSION]       build the archives, then do what --finish does
#   ./scripts/build-release.sh --finish OUT_DIR VERSION  only (re)make the copies and the checksum file in OUT_DIR
#
#   OUT_DIR defaults to dist, VERSION to the version in package.json (MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRE).
#
#   foundry-world-backup-<version>-linux.tar.gz   Linux archive (install.sh at the top of its folder)
#   foundry-world-backup-<version>-windows.zip    Windows archive
#   foundry-world-backup-<version>-setup.exe      Windows installer; built on Windows (packaging/windows), --finish only
#                                                  adds its copies when it is already in OUT_DIR
#   foundry-world-backup-linux.tar.gz, foundry-world-backup-windows.zip, foundry-world-backup-setup.exe
#                                                  the same files under fixed names, so .../releases/latest/download/<name>
#                                                  always points at the newest release
#   SHA256SUMS.txt                                 sha256sum of every other file above
#
# Both archives hold one folder, foundry-world-backup-<version>/, with install.sh, src/, scripts/, package.json, the
# README and the example config files. The same commit and version always give byte-identical archives.
# Needs tar, gzip, zip and sha256sum (all present on GitHub's Ubuntu runners).
# release.yml uploads exactly the files named in SHA256SUMS.txt plus SHA256SUMS.txt itself.
set -euo pipefail

PACKAGE="foundry-world-backup"
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

finish_only=no
if [[ "${1:-}" == "--finish" ]]; then
    finish_only=yes
    shift
    [[ $# -eq 2 ]] || { echo "usage: $0 --finish OUT_DIR VERSION" >&2; exit 2; }
fi
[[ $# -le 2 ]] || { echo "usage: $0 [OUT_DIR] [VERSION]" >&2; exit 2; }
OUT="$(mkdir -p "${1:-dist}" && cd "${1:-dist}" && pwd)"
VERSION="${2:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)}"
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ $SEMVER_RE ]]; then
    echo "version '$VERSION' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE" >&2
    exit 1
fi
NAME="${PACKAGE}-${VERSION}"
LINUX="$NAME-linux.tar.gz"
WINDOWS="$NAME-windows.zip"
SETUP="$NAME-setup.exe"


# Builds the Linux and Windows archives from a staged copy of the working tree with VERSION stamped in.
build_archives() {
    local stage
    stage="$(mktemp -d)"
    # shellcheck disable=SC2064 # expand now: $stage is local
    trap "rm -rf '$stage'" EXIT
    mkdir "$stage/$NAME"
    cp -r "$ROOT/src" "$ROOT/scripts" "$ROOT/install.sh" "$ROOT/package.json" "$ROOT/README.md" \
        "$ROOT/config.example.json" "$ROOT/.env.example" "$stage/$NAME/"
    chmod 755 "$stage/$NAME"/install.sh "$stage/$NAME"/scripts/*.sh
    # Stamp the version into the built package.json only (the first "version" line, the top-level one).
    sed -i "0,/^\\( *\"version\": *\"\\)[^\"]*\"/s//\\1${VERSION}\"/" "$stage/$NAME/package.json"
    if ! grep -q "^ *\"version\": *\"${VERSION//./\\.}\"" "$stage/$NAME/package.json"; then
        echo "could not stamp version $VERSION into package.json" >&2
        exit 1
    fi
    # Reproducible: the same commit and version give byte-identical archives (fixed modes, owners, order and times;
    # the time is the commit's, or SOURCE_DATE_EPOCH).
    local epoch
    epoch="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 315532800)}"
    chmod -R u+rwX,go+rX,go-w "$stage/$NAME"
    find "$stage/$NAME" -exec touch -h -d "@$epoch" {} +
    rm -f "$OUT/$LINUX" "$OUT/$WINDOWS"
    tar -C "$stage" --owner=0 --group=0 --numeric-owner --sort=name --mtime="@$epoch" -cf - "$NAME" | gzip -9n > "$OUT/$LINUX"
    (cd "$stage" && find "$NAME" -print | LC_ALL=C sort | TZ=UTC zip -qX -@ "$OUT/$WINDOWS")
    rm -rf "$stage"
    trap - EXIT
}

# Makes the fixed-name copies and the checksum file for the files already in OUT.
finish() {
    local files=() f
    for f in "$LINUX" "$WINDOWS"; do
        [[ -f "$OUT/$f" ]] || { echo "$OUT/$f is missing" >&2; exit 1; }
    done
    # start from a clean set of derived files
    rm -f "$OUT/${PACKAGE}-linux.tar.gz" "$OUT/${PACKAGE}-windows.zip" "$OUT/${PACKAGE}-setup.exe" "$OUT/SHA256SUMS.txt"

    files+=("$LINUX" "$WINDOWS")
    cp "$OUT/$LINUX" "$OUT/${PACKAGE}-linux.tar.gz"
    cp "$OUT/$WINDOWS" "$OUT/${PACKAGE}-windows.zip"
    files+=("${PACKAGE}-linux.tar.gz" "${PACKAGE}-windows.zip")
    if [[ -f "$OUT/$SETUP" ]]; then
        cp "$OUT/$SETUP" "$OUT/${PACKAGE}-setup.exe"
        files+=("$SETUP" "${PACKAGE}-setup.exe")
    fi

    (cd "$OUT" && printf '%s\n' "${files[@]}" | LC_ALL=C sort | xargs sha256sum > SHA256SUMS.txt)
    echo "Release files in $OUT:"
    printf '  %s\n' SHA256SUMS.txt
    sed 's/^[0-9a-f]*  /  /' "$OUT/SHA256SUMS.txt"
}

if [[ "$finish_only" == no ]]; then
    build_archives
fi
finish

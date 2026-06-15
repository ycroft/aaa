#!/usr/bin/env bash
# Build aaa-hub release tarball for Linux x86_64.
# Usage: ./scripts/server/build-release.sh [--no-bundle]
#
# Outputs:
#   target/server-dist/aaa-hub-<ver>-linux-x86_64/      # dist directory
#   target/server-dist/aaa-hub-<ver>-linux-x86_64.tar.gz # tarball (unless --no-bundle)
set -euo pipefail

NO_BUNDLE=0
for arg in "$@"; do
  case "$arg" in
    --no-bundle) NO_BUNDLE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Resolve workspace root (this script lives at <root>/scripts/server/...).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

VER="$(awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' server/Cargo.toml)"
if [ -z "$VER" ]; then
  echo "could not parse server version from server/Cargo.toml" >&2
  exit 1
fi

echo ">> building aaa-hub v$VER (release)"
cargo build --release -p aaa-hub

DIST_NAME="aaa-hub-$VER-linux-x86_64"
DIST_DIR="target/server-dist/$DIST_NAME"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp target/release/aaa-hub "$DIST_DIR/aaa-hub"
cp -r server/migrations "$DIST_DIR/migrations"
cp -r server/admin-ui "$DIST_DIR/admin-ui"
cp scripts/server/config.toml.example "$DIST_DIR/config.toml.example"
cp scripts/server/README.md "$DIST_DIR/README.md"

echo ">> dist ready: $DIST_DIR"

if [ "$NO_BUNDLE" -eq 0 ]; then
  TAR="target/server-dist/$DIST_NAME.tar.gz"
  rm -f "$TAR"
  tar -czf "$TAR" -C target/server-dist "$DIST_NAME"
  echo ">> tarball: $TAR"
fi

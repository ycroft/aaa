#!/usr/bin/env bash
# Local dev run for AAA · Agent Analyzer.
#
# Starts Vite (HMR) + Tauri host with cargo incremental rebuild and pops
# the desktop window. Use this for fast iteration; for a release build
# see scripts/build-release.sh.
#
# Usage:  ./scripts/dev.sh [extra args forwarded to `tauri dev`]
#
# Inputs honoured from the environment:
#   PATH           Same Node-on-PATH rule as build-release.sh — if your
#                  distro Node is too old, this script auto-prepends
#                  $HOME/.local/node/bin if it exists.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Auto-pick a vendored Node if the system one is missing or too old.
if [ -d "$HOME/.local/node/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.local/node/bin:"*) ;;
    *) PATH="$HOME/.local/node/bin:$PATH" ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found in PATH." >&2
  echo "       Install Node ≥20.19 or pass an explicit PATH, e.g.:" >&2
  echo "       PATH=\$HOME/.local/node/bin:\$PATH $0" >&2
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".").map(Number)[0]')
node_minor=$(node -p 'process.versions.node.split(".").map(Number)[1]')
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 19 ]; }; then
  echo "error: Node $(node -v) is too old; Vite 8 needs ≥20.19." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ">> npm install"
  npm install
fi

echo ">> tauri dev $*"
exec npx tauri dev "$@"

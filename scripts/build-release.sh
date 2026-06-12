#!/usr/bin/env bash
# Release build for AAA · Agent Analyzer.
#
# Usage:  ./scripts/build-release.sh [--no-bundle]
#
#   (default)     Build all bundles tauri.conf.json declares (deb + rpm + appimage on Linux).
#   --no-bundle   Build only the standalone executable, skip installer bundling.
#
# Inputs honoured from the environment:
#   PATH           If your distro Node is too old for Vite 8, prepend a newer one,
#                  e.g. PATH=$HOME/.local/node/bin:$PATH ./scripts/build-release.sh
#   TAURI_TARGET   Cross-target triple, forwarded as `tauri build --target ...`.
#
# Outputs (relative to repo root tools/aaa):
#   target/release/aaa                                  – the binary
#   target/release/bundle/appimage/AAA_<ver>_*.AppImage – portable single-file
#   target/release/bundle/deb/AAA_<ver>_*.deb           – Debian/Ubuntu
#   target/release/bundle/rpm/AAA-<ver>-*.rpm           – Fedora/openSUSE

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

bundle=1
for arg in "$@"; do
  case "$arg" in
    --no-bundle) bundle=0 ;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Tauri 2 requires Node ≥20.19 (Vite 8). Fail fast with a clear hint.
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

# Prime ~/.cache/tauri/ with vendored AppImage assets so tauri-bundler skips
# its GitHub downloads (which routinely time out / TLS-truncate from CN).
# Files are kept in vendor/tauri-cache/ — see the README there for details.
vendor_cache="$ROOT_DIR/vendor/tauri-cache"
tauri_cache="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
if [ -d "$vendor_cache" ]; then
  mkdir -p "$tauri_cache"
  for f in AppRun-x86_64 \
           linuxdeploy-x86_64.AppImage \
           linuxdeploy-plugin-appimage.AppImage \
           linuxdeploy-plugin-gtk.sh \
           linuxdeploy-plugin-gstreamer.sh; do
    if [ -f "$vendor_cache/$f" ] && [ ! -e "$tauri_cache/$f" ]; then
      cp "$vendor_cache/$f" "$tauri_cache/$f"
      chmod +x "$tauri_cache/$f"
    fi
  done
fi

# Hosts with only fuse3 (Ubuntu 24.04+) cannot mount classic AppImages.
# Telling the AppImage runtime to extract-and-run avoids needing libfuse.so.2,
# and the flag propagates into nested AppImages (linuxdeploy → plugin-appimage).
export APPIMAGE_EXTRACT_AND_RUN=1

cli_args=()
if [ "$bundle" -eq 0 ]; then
  cli_args+=(--no-bundle)
fi
if [ "${TAURI_TARGET:-}" != "" ]; then
  cli_args+=(--target "$TAURI_TARGET")
fi

echo ">> tauri build ${cli_args[*]:-}"
npx tauri build "${cli_args[@]}"

echo
echo "Build artefacts:"
if [ "${TAURI_TARGET:-}" != "" ]; then
  out_dir="target/$TAURI_TARGET/release"
else
  out_dir="target/release"
fi
[ -x "$out_dir/aaa" ] && echo "  binary : $out_dir/aaa"
if [ "$bundle" -eq 1 ] && [ -d "$out_dir/bundle" ]; then
  find "$out_dir/bundle" -maxdepth 2 -type f \
       \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.dmg' -o -name '*.msi' -o -name '*.exe' \) \
       -printf '  bundle : %p\n'
fi

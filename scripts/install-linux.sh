#!/usr/bin/env bash
# User-level install/uninstall for AAA on Linux.
#
# Default mode lays down per-user files under $XDG_DATA_HOME (~/.local/share)
# and $HOME/.local/bin so no root, no system pollution. The desktop entry
# follows the freedesktop.org spec, so GNOME/KDE/XFCE/Sway all pick it up.
#
# Usage:
#   ./scripts/install-linux.sh                # install to ~/.local
#   ./scripts/install-linux.sh --prefix /opt  # system install (needs sudo)
#   ./scripts/install-linux.sh --uninstall    # remove what we put in ~/.local

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

APP_ID="dev.aaa.analyzer"   # must match tauri.conf.json `identifier`
APP_NAME="AAA"
BIN_NAME="aaa"

prefix="$HOME/.local"
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --prefix=*)  prefix="${arg#--prefix=}" ;;
    --prefix)    shift; prefix="${1:?--prefix needs a value}" ;;
    --uninstall) uninstall=1 ;;
    -h|--help)
      sed -n '2,11p' "$0"; exit 0 ;;
  esac
done

bin_dir="$prefix/bin"
share_dir="$prefix/share"
install_dir="$share_dir/$BIN_NAME"
desktop_file="$share_dir/applications/$APP_ID.desktop"
icon_dir="$share_dir/icons/hicolor/512x512/apps"
icon_file="$icon_dir/$APP_ID.png"
launcher="$bin_dir/$BIN_NAME"

if [ "$uninstall" -eq 1 ]; then
  echo "Removing AAA from $prefix"
  rm -f "$launcher" "$desktop_file" "$icon_file"
  rm -rf "$install_dir"
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$share_dir/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && gtk-update-icon-cache -q -f "$share_dir/icons/hicolor" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# Locate the release binary. Honour a workspace target dir if cargo points elsewhere.
candidates=(
  "$ROOT_DIR/target/release/$BIN_NAME"
  "$ROOT_DIR/src-tauri/target/release/$BIN_NAME"
  "${CARGO_TARGET_DIR:-}/release/$BIN_NAME"
)
src_bin=""
for c in "${candidates[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] && { src_bin="$c"; break; }
done
if [ -z "$src_bin" ]; then
  echo "error: release binary not found." >&2
  echo "       Run ./scripts/build-release.sh first." >&2
  exit 1
fi

# Pick best icon — prefer 512x512, fall back to whatever exists.
src_icon=""
for c in \
  "$ROOT_DIR/src-tauri/icons/icon.png" \
  "$ROOT_DIR/src-tauri/icons/512x512.png" \
  "$ROOT_DIR/src-tauri/icons/128x128@2x.png"
do
  [ -f "$c" ] && { src_icon="$c"; break; }
done

echo "Installing AAA to $prefix"

mkdir -p "$install_dir" "$bin_dir" "$share_dir/applications" "$icon_dir"
install -m 0755 "$src_bin" "$install_dir/$BIN_NAME"
if [ -n "$src_icon" ]; then
  install -m 0644 "$src_icon" "$icon_file"
fi

# Tiny launcher: keeps the binary out of $PATH directly so we can swap install_dir
# without touching ~/.local/bin, and lets us inject env in one place if needed.
cat >"$launcher" <<EOF
#!/usr/bin/env sh
exec "$install_dir/$BIN_NAME" "\$@"
EOF
chmod 0755 "$launcher"

cat >"$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME · Agent Analyzer
GenericName=AI Agent Session Analyzer
Comment=Inspect local AI coding agent session logs
Exec=$launcher %U
Icon=$APP_ID
Terminal=false
Categories=Development;Utility;
StartupWMClass=$APP_ID
EOF
chmod 0644 "$desktop_file"

command -v update-desktop-database >/dev/null 2>&1 \
  && update-desktop-database "$share_dir/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -q -f "$share_dir/icons/hicolor" 2>/dev/null || true

echo "Installed:"
echo "  binary  : $install_dir/$BIN_NAME"
echo "  launcher: $launcher  (make sure $bin_dir is on PATH)"
echo "  desktop : $desktop_file"
if [ -n "$src_icon" ]; then
  echo "  icon    : $icon_file"
fi
echo
echo "Run from terminal:    $BIN_NAME"
echo "Or find 'AAA' in your application menu."

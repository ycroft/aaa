#!/usr/bin/env bash
# Pack a portable tarball: binary + icon + a self-contained installer.
#
# Output:  dist/aaa-<version>-linux-<arch>.tar.gz
#
# Recipient workflow:
#     tar xzf aaa-0.1.0-linux-x86_64.tar.gz
#     cd aaa-0.1.0-linux-x86_64
#     ./install.sh           # user install to ~/.local
#     ./install.sh --uninstall
#
# Recipient still needs WebKitGTK / GTK runtime libraries from their distro:
#   Debian/Ubuntu : libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0
#                   libjavascriptcoregtk-4.1-0 librsvg2-2
#   Fedora/RHEL   : webkit2gtk4.1 gtk3 libsoup3 javascriptcoregtk4.1 librsvg2

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BIN_NAME="aaa"
APP_ID="dev.aaa.analyzer"
APP_NAME="AAA"

# Pull version from src-tauri/Cargo.toml — single source of truth.
version=$(awk -F'"' '/^version *= *"/{print $2; exit}' src-tauri/Cargo.toml)
arch=$(uname -m)

src_bin=""
for c in target/release/$BIN_NAME src-tauri/target/release/$BIN_NAME; do
  [ -x "$c" ] && { src_bin="$c"; break; }
done
if [ -z "$src_bin" ]; then
  echo "error: release binary not found. Run scripts/build-release.sh first." >&2
  exit 1
fi

src_icon=""
for c in src-tauri/icons/icon.png src-tauri/icons/512x512.png src-tauri/icons/128x128@2x.png; do
  [ -f "$c" ] && { src_icon="$c"; break; }
done

stage_name="$BIN_NAME-$version-linux-$arch"
stage_root="$(mktemp -d)"
stage_dir="$stage_root/$stage_name"
mkdir -p "$stage_dir/bin" "$stage_dir/share/icons"

cp "$src_bin" "$stage_dir/bin/$BIN_NAME"
chmod 0755 "$stage_dir/bin/$BIN_NAME"
[ -n "$src_icon" ] && cp "$src_icon" "$stage_dir/share/icons/$APP_ID.png"
[ -f README.md ]    && cp README.md "$stage_dir/README.md"

cat >"$stage_dir/install.sh" <<EOF
#!/usr/bin/env bash
# Installer baked into the AAA portable tarball.
# User install (no root):     ./install.sh
# System install:             sudo ./install.sh --prefix /usr/local
# Uninstall (matches prefix): ./install.sh --uninstall  [--prefix <p>]

set -euo pipefail

APP_ID="$APP_ID"
APP_NAME="$APP_NAME"
BIN_NAME="$BIN_NAME"

prefix="\$HOME/.local"
uninstall=0
for arg in "\$@"; do
  case "\$arg" in
    --prefix=*)  prefix="\${arg#--prefix=}" ;;
    --prefix)    shift; prefix="\${1:?}" ;;
    --uninstall) uninstall=1 ;;
    -h|--help)   sed -n '2,5p' "\$0"; exit 0 ;;
  esac
done

bin_dir="\$prefix/bin"
share_dir="\$prefix/share"
install_dir="\$share_dir/\$BIN_NAME"
desktop_file="\$share_dir/applications/\$APP_ID.desktop"
icon_dir="\$share_dir/icons/hicolor/512x512/apps"
icon_file="\$icon_dir/\$APP_ID.png"
launcher="\$bin_dir/\$BIN_NAME"

here="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"

if [ "\$uninstall" -eq 1 ]; then
  echo "Removing \$APP_NAME from \$prefix"
  rm -f "\$launcher" "\$desktop_file" "\$icon_file"
  rm -rf "\$install_dir"
  command -v update-desktop-database >/dev/null 2>&1 \\
    && update-desktop-database "\$share_dir/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 \\
    && gtk-update-icon-cache -q -f "\$share_dir/icons/hicolor" 2>/dev/null || true
  echo "Done."
  exit 0
fi

mkdir -p "\$install_dir" "\$bin_dir" "\$share_dir/applications" "\$icon_dir"
install -m 0755 "\$here/bin/\$BIN_NAME" "\$install_dir/\$BIN_NAME"
if [ -f "\$here/share/icons/\$APP_ID.png" ]; then
  install -m 0644 "\$here/share/icons/\$APP_ID.png" "\$icon_file"
fi

cat >"\$launcher" <<LAUNCH
#!/usr/bin/env sh
exec "\$install_dir/\$BIN_NAME" "\\\$@"
LAUNCH
chmod 0755 "\$launcher"

cat >"\$desktop_file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=\$APP_NAME · Agent Analyzer
GenericName=AI Agent Session Analyzer
Comment=Inspect local AI coding agent session logs
Exec=\$launcher %U
Icon=\$APP_ID
Terminal=false
Categories=Development;Utility;
StartupWMClass=\$APP_ID
DESKTOP
chmod 0644 "\$desktop_file"

command -v update-desktop-database >/dev/null 2>&1 \\
  && update-desktop-database "\$share_dir/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 \\
  && gtk-update-icon-cache -q -f "\$share_dir/icons/hicolor" 2>/dev/null || true

echo "Installed \$APP_NAME to \$prefix"
echo "  Run:  \$BIN_NAME           (need \$bin_dir on PATH)"
echo "  Or:   find '\$APP_NAME' in your application menu."
EOF
chmod 0755 "$stage_dir/install.sh"

mkdir -p dist-pkg
out="dist-pkg/$stage_name.tar.gz"
( cd "$stage_root" && tar czf - "$stage_name" ) >"$out"
rm -rf "$stage_root"

size=$(du -h --apparent-size "$out" | awk '{print $1}')
echo "Packed: $out  ($size)"
echo
echo "Recipient command:"
echo "  tar xzf $stage_name.tar.gz && cd $stage_name && ./install.sh"

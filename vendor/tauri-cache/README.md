# Vendored tauri-bundler AppImage assets

`tauri build --bundles appimage` 会从 GitHub 拉这五个文件放到 `~/.cache/tauri/`：

| 文件 | 来源 |
|------|------|
| `AppRun-x86_64` | `github.com/tauri-apps/binary-releases/releases/download/apprun-old/` |
| `linuxdeploy-x86_64.AppImage` | `github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/` |
| `linuxdeploy-plugin-appimage.AppImage` | `github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage` （注意 vendor 里不带 `-x86_64` 后缀，因为 tauri-bundler 查找用的就是不带后缀的名字 — 这是它自身的不一致） |
| `linuxdeploy-plugin-gtk.sh` | `raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/` |
| `linuxdeploy-plugin-gstreamer.sh` | `raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/` |

直连 GitHub 在国内常常超时或 TLS 中断，把这些产物入库后 `scripts/build-release.sh` 会预填到 `~/.cache/tauri/`，跳过下载。

`SHA256SUMS` 是冷冻这些文件的指纹，以便：

- 后续升级时 diff 出来的版本变化一目了然。
- 在受控环境里复核：`(cd vendor/tauri-cache && sha256sum -c SHA256SUMS)`。

## 升级流程

`linuxdeploy-plugin-gtk.sh` / `linuxdeploy-plugin-gstreamer.sh` 是 master 分支 raw 文件，会跟着 upstream 漂移；其余几个跟 release tag。需要更新时：

1. 删 `~/.cache/tauri/` 里的对应文件；
2. 跑一次 `tauri build --bundles appimage`，让 tauri 自己重新下；
3. 复制新文件回 `vendor/tauri-cache/`，重算 `SHA256SUMS`；
4. 在 commit 信息里写明动机和上游版本。

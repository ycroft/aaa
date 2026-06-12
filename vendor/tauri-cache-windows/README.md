# Vendored tauri-bundler Windows assets

`tauri build` 在 Windows 第一次跑时会从 GitHub 拉这 3 个文件并落到 `%LOCALAPPDATA%\tauri\` 下，国内/内网经常超时（错误：`failed to bundle project: timeout: global` / `Couldn't connect to server`）。把它们入库后，`scripts\build-release.ps1` 在 build 前会预填到缓存目录，跳过下载。

## 需要 vendor 的文件

| 文件 | 来源 | 校验 |
|------|------|------|
| `wix314-binaries.zip` | https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip | SHA256 `6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31` |
| `nsis-3.11.zip` | https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip | SHA1 `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D` |
| `nsis_tauri_utils.dll` | https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll | SHA1 `75197FEE3C6A814FE035788D1C34EAD39349B860` |

URL、校验值与 tauri-bundler v2.11.2 源码（`crates/tauri-bundler/src/bundle/windows/{msi,nsis}/mod.rs`）保持一致；升级 tauri-bundler 时同步更新本表与 `SHA256SUMS`。

## 下载（在能连 GitHub 的环境里跑一次）

PowerShell：

```powershell
cd tools\aaa\vendor\tauri-cache-windows
Invoke-WebRequest -Uri "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip" -OutFile "wix314-binaries.zip"
Invoke-WebRequest -Uri "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip" -OutFile "nsis-3.11.zip"
Invoke-WebRequest -Uri "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll" -OutFile "nsis_tauri_utils.dll"
```

bash（任一 Linux/macOS）：

```bash
cd tools/aaa/vendor/tauri-cache-windows
curl -fLO https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip
curl -fLO https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
curl -fLO https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll
```

下载完落地校验：

```bash
sha256sum -c SHA256SUMS
```

或 PowerShell：

```powershell
Get-FileHash wix314-binaries.zip   -Algorithm SHA256  # 比对 SHA256SUMS 第 1 行
Get-FileHash nsis-3.11.zip         -Algorithm SHA1    # 比对 SHA1
Get-FileHash nsis_tauri_utils.dll  -Algorithm SHA1    # 比对 SHA1
```

校验通过后 `git add` 提交本目录全部产物。

## 构建脚本如何使用这些 vendor

`scripts\build-release.ps1` 在调用 `tauri build` 之前，会按下表把 vendor 文件摆到 `%LOCALAPPDATA%\tauri\` 下：

| vendor 文件 | 目标路径 | 备注 |
|------------|---------|------|
| `wix314-binaries.zip` | 解压到 `%LOCALAPPDATA%\tauri\WixTools314\` | 解压后含 `candle.exe`/`light.exe`/`wix.dll` 等 |
| `nsis-3.11.zip` | 解压（顶层为 `nsis-3.11\`），改名为 `%LOCALAPPDATA%\tauri\NSIS\` | tauri-bundler 找的是 `NSIS\makensis.exe` |
| `nsis_tauri_utils.dll` | 复制到 `%LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll` | 此为 tauri 必需的插件路径，tauri-bundler 会校验 SHA1 |

如果目标目录已经存在且文件齐全，脚本不会覆盖（与 tauri-bundler 自身的存在性检查一致）。

## 升级流程

升级 tauri-cli/bundler 时：

1. 在 [tauri-bundler 同 tag 源码](https://github.com/tauri-apps/tauri/tree/tauri-v2.11.2/crates/tauri-bundler/src/bundle/windows) 的 `msi/mod.rs` 与 `nsis/mod.rs` 里查 `WIX_URL` / `WIX_SHA256` / `NSIS_URL` / `NSIS_SHA1` / `NSIS_TAURI_UTILS_URL` / `NSIS_TAURI_UTILS_SHA1` 这几个常量
2. 用新 URL 重下，更新本目录文件
3. 同步更新 `SHA256SUMS`、本 README 的常量、以及 `scripts\build-release.ps1` 里写死的子目录名（多半不需要，因 `WixTools314` / `NSIS` 这两个名字 tauri-bundler 长期未变）
4. commit 信息说明上游版本与动机

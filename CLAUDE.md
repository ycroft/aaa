# AAA · Agent Analyzer

跨后端的本地 AI 编码代理会话日志分析工具。读取磁盘上各家 agent（Claude Code、opencode、…）的原生日志，统一成共享数据模型，在桌面 UI 里呈现：会话列表、可折叠时间线、token 成本与上下文窗口走势，标红峰值节点和上下文跳跃点，方便定位"窗口炸在哪条消息"。

更详细的使用说明见 [`README.md`](README.md)；本文件给 Claude Code 看，覆盖工程结构、扩展点、构建分发。

## 工程结构

```
tools/aaa/
├── core/             # tauri-free 业务核心（cargo workspace 成员）
│   └── src/
│       ├── model.rs        # SessionSummary / SessionNode / MessagePart / TokenUsage
│       ├── providers/      # SessionProvider trait + claude_code / opencode 实现
│       └── settings.rs     # AppSettings 持久化（~/.config/aaa/settings.json）
├── src-tauri/        # Tauri host：commands.rs 暴露 5 个命令给前端
├── src/              # React + TypeScript UI（Vite 8 / React 18）
│   ├── App.tsx              # 顶层状态机：当前 backend / 会话列表 / 选中会话
│   ├── api.ts               # 包装 @tauri-apps/api 的 invoke
│   ├── components/          # Menubar / Toolbar / SessionList / SessionViewer / SettingsDialog / ProviderSplash / StatusBar
│   ├── hooks/useStatusHint  # 状态栏提示
│   ├── types.ts             # 与 core/model.rs 对齐的 TS 类型
│   └── format.ts            # 路径/数字/时间格式化
├── scripts/          # build-release / install-linux / package-portable
├── vendor/tauri-cache/  # Linux AppImage 打包所需上游产物（避免 build 时联网拉 GitHub）
├── vendor/tauri-cache-windows/  # Windows MSI/NSIS 打包所需上游产物（同上）
└── Cargo.toml        # workspace = [src-tauri, core]，release profile = LTO + strip + opt-level=s
```

技术栈：Tauri 2 + React 18 + TypeScript 5 + Vite 8（前端），Rust（后端 + host），Node ≥ 20.19。

## 架构与扩展点

数据流：**provider 解析磁盘日志 → 统一数据模型 → Tauri command → React UI**。前端永远不接触原生日志格式。

核心抽象在 `core/src/providers/mod.rs`：

```rust
pub trait SessionProvider: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn default_root(&self) -> Option<PathBuf>;     // 该 backend 在本机的默认日志目录
    fn is_implemented(&self) -> bool { true }      // 未实现则 UI 灰显
    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>>;
    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail>;
}
```

新增 backend 的步骤：

1. 在 `core/src/providers/` 加一个文件实现 `SessionProvider`，把原生日志翻译成 `SessionNode + MessagePart + TokenUsage`。
2. 在 `providers/mod.rs::all()` 里注册一行。
3. 不需要动 `commands.rs`，也不需要动前端——`list_providers` 命令会自动把它列出来。

统一数据模型（`core/src/model.rs`）：

| 类型 | 作用 |
|------|------|
| `SessionSummary` | 列表项：title / cwd / branch / 起止时间 / 消息数 / token 累计 / `peak_context_tokens` |
| `SessionNode` | 时间线节点：kind（user/assistant/system/tool_result/sidechain/meta）+ `parts` + `usage` + `cumulative_context_tokens` |
| `MessagePart` | 节点内片段：Text / Thinking / ToolUse / ToolResult / Image / Attachment / Note |
| `TokenUsage` | input / output / cache_creation / cache_read，`context_window()` 把 4 项加起来 |

UI 的"峰值标红 + 跳跃标橙"靠的是 `cumulative_context_tokens` 这个累计最大值字段——所有 provider 都需要正确填充它。

Tauri 命令面（`src-tauri/src/commands.rs`，对应 `src/api.ts`）：

| 命令 | 用途 |
|------|------|
| `list_providers` | 返回所有 backend + 默认目录是否存在 |
| `list_sessions` | 列指定 backend 下的会话（支持目录覆盖） |
| `load_session` | 按文件路径加载完整 `SessionDetail` |
| `get_settings` / `save_settings` | 读写 `AppSettings`（含 provider 目录覆盖、UI 偏好、AI 集成预留字段） |

## 当前 Backend

| ID | 状态 | 默认目录 | 说明 |
|----|------|---------|------|
| `claude-code` | 已实现 | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 逐行 JSONL 解析，按 `type` 字段映射节点 |
| `opencode` | 已实现 | `~/.local/share/opencode/opencode.db`（可在设置里覆盖目录或直接指向 db 文件） | 读 SQLite `session/message/part` 三张表；`source_path` 编码为 `<db>#<session_id>`；tool 调用合并为单个 ToolUse 节点 |

## 模型参考

UI 里的"上下文窗口走势"会跟模型自身的窗口上限做比对，新增模型时在此登记，便于在前端做峰值/超限提示。

| 模型 | 上下文窗口 | 备注 |
|------|-----------|------|
| GLM-4.7 | 200KB | — |

## 提交约束（重要）

> **每次 commit 都必须同步 bump 版本号 + 追加 release notes。** 这是 AAA 子项目的硬性约束，没有例外——哪怕只是改一个 typo、调一行 CSS、补一句注释。版本号是分发产物（deb/rpm/AppImage/MSI/NSIS/portable）唯一的可识别标记，提交不动版本号会导致同事拿到的安装包与代码对不上。

需要同步修改的 4 处版本字段（必须保持一致）：

| 文件 | 字段 |
|------|------|
| `tools/aaa/package.json` | `"version"` |
| `tools/aaa/src-tauri/tauri.conf.json` | `"version"` |
| `tools/aaa/src-tauri/Cargo.toml` | `[package].version` |
| `tools/aaa/core/Cargo.toml` | `[package].version` |

外加一处必须同步更新的文件：

| 文件 | 要做的事 |
|------|---------|
| `tools/aaa/release-notes.txt` | 在文件**顶部**追加新版本块：先写 `vX.Y.Z` 标题行，再用一行短横线分隔，最后用 `- ` 列出本次提交的关键改动。该文件由 `src-tauri/src/commands.rs` 通过 `include_str!("../../release-notes.txt")` 在编译期内联到二进制，About 对话框直接展示其内容；忘了改这个文件，About 里看到的就是上一版的描述。 |

版本号语义参考 SemVer：

- **patch**（`0.1.0 → 0.1.1`）：bug 修复、文案、UI 微调、依赖小升级
- **minor**（`0.1.0 → 0.2.0`）：新增 backend、新增 Tauri 命令、新增可见功能
- **major**（`0.1.0 → 1.0.0`）：数据模型/命令面破坏性改动，或正式发布里程碑

工作流：改完代码后，先更新这 4 个版本字段 + `release-notes.txt`，再 `git add`，把版本号变更、release notes 变更和功能变更放进**同一个 commit**。如果忘了，就用 `git commit --amend` 补回去（前提是该提交还没推到远端）。

## 构建与分发

> Linux 与 Windows 都有对应脚本，下面的小节先讲 Linux，再讲 Windows。

### Linux · 系统先决条件（一次性）

Debian/Ubuntu：

```bash
sudo apt install -y pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libxdo-dev
```

Node ≥ 20.19（Vite 8 要求）。推荐解压到 `~/.local/node` 不污染系统：

```bash
curl -fsSL -o /tmp/node22.tar.xz \
  https://nodejs.org/dist/v22.13.1/node-v22.13.1-linux-x64.tar.xz
mkdir -p ~/.local/node
tar -xJf /tmp/node22.tar.xz -C ~/.local/node --strip-components=1
```

直连 crates.io 不稳就在 `~/.cargo/config.toml` 配 USTC sparse 镜像。

### Linux · 构建 release

```bash
cd tools/aaa
PATH=$HOME/.local/node/bin:$PATH ./scripts/build-release.sh
```

`tauri.conf.json` 的 `targets: "all"` 默认出全套 Linux 产物：

| 产物 | 路径 |
|------|------|
| 裸二进制 | `target/release/aaa` |
| Debian 包 | `target/release/bundle/deb/AAA_<ver>_amd64.deb` |
| RPM 包 | `target/release/bundle/rpm/AAA-<ver>-1.x86_64.rpm` |
| AppImage | `target/release/bundle/appimage/AAA_<ver>_amd64.AppImage` |

`--no-bundle` 跳过安装包，迭代时只出裸二进制。AppImage 打包不会再联网拉 GitHub —— `vendor/tauri-cache/` 已 vendor 上游产物，`build-release.sh` 启动时预填到 `~/.cache/tauri/`。版本升级流程见 `vendor/tauri-cache/README.md`。

### Linux · 本机安装

```bash
./scripts/install-linux.sh                # 装到 ~/.local（无需 sudo）
./scripts/install-linux.sh --prefix /opt  # 系统级
./scripts/install-linux.sh --uninstall    # 卸载
```

默认布局：`~/.local/share/aaa/aaa`（实际二进制）+ `~/.local/bin/aaa`（wrapper）+ desktop / icon。装完终端跑 `aaa` 或应用菜单搜 "Agent Analyzer"。

### Linux · 分发给同事

| 场景 | 推荐产物 | 安装命令 |
|------|---------|----------|
| Debian/Ubuntu | `.deb` | `sudo apt install ./AAA_<ver>_amd64.deb` |
| Fedora/RHEL/openSUSE | `.rpm` | `sudo dnf install ./AAA-<ver>-1.x86_64.rpm` |
| 跨发行版 / 不想 sudo | AppImage | `chmod +x … && ./AAA_<ver>_amd64.AppImage` |
| 用户级带桌面集成 | portable tarball | `./scripts/package-portable.sh` 出 `dist-pkg/aaa-<ver>-linux-<arch>.tar.gz`，解压后跑 `./install.sh` |

`.deb`/`.rpm` 依赖关系已写入包元数据。AppImage 自带 GTK 库（约 80MB）开箱即用。tarball / 裸二进制需要确认运行时库在位：

| 发行版 | 运行时包 |
|-------|---------|
| Debian/Ubuntu | `libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0 libjavascriptcoregtk-4.1-0 librsvg2-2` |
| Fedora/RHEL | `webkit2gtk4.1 gtk3 libsoup3 javascriptcoregtk4.1 librsvg2` |

桌面 Ubuntu/Fedora 默认基本都带。

### Windows · 先决条件

- Node ≥ 20.19（Vite 8 要求），从 nodejs.org 装 LTS 即可
- Rust stable（`rustup-init.exe`）
- Microsoft Edge WebView2 Runtime —— Win 11 与现行 Win 10 自带；老镜像可去微软官网下载 Evergreen 安装一次
- 可选：构建 MSI 需要 WiX，构建 NSIS 需要 NSIS。`scripts\build-release.ps1` 启动时会从 `vendor\tauri-cache-windows\` 把 WiX/NSIS 工具链摆到 `%LOCALAPPDATA%\tauri\`，跳过 tauri-bundler 自身的 GitHub 下载。**首次进库时 vendor 目录是空的**，需要在能连 GitHub 的环境里跑一次 `vendor\tauri-cache-windows\README.md` 里给出的下载命令并提交，之后内网构建机就完全离线可用。

### Windows · 构建 release

PowerShell：

```powershell
cd tools\aaa
.\scripts\build-release.ps1            # 出 .msi + NSIS .exe + 裸 aaa.exe
.\scripts\build-release.ps1 -NoBundle  # 只出裸 aaa.exe，迭代用
```

不想折腾执行策略就双击 `scripts\build-release.cmd`，`.cmd` 会用 `-ExecutionPolicy Bypass` 调对应的 `.ps1`。

`tauri.conf.json` 的 `targets: "all"` 在 Windows 默认产物：

| 产物 | 路径 |
|------|------|
| 裸二进制 | `target\release\aaa.exe` |
| MSI 安装包 | `target\release\bundle\msi\AAA_<ver>_x64_en-US.msi` |
| NSIS 安装包 | `target\release\bundle\nsis\AAA_<ver>_x64-setup.exe` |

### Windows · 本机安装

直接把构建好的裸 `aaa.exe` 放进 `%LOCALAPPDATA%\Programs\AAA`，加开始菜单快捷方式 + 用户 PATH，免管理员：

```powershell
.\scripts\install-windows.ps1               # 安装
.\scripts\install-windows.ps1 -Uninstall    # 卸载
```

或双击 `install-windows.cmd`。安装后开新终端跑 `aaa`，或开始菜单搜 "AAA · Agent Analyzer"。

### Windows · 分发给同事

| 场景 | 推荐产物 | 安装命令 |
|------|---------|----------|
| 标准发行 | MSI | 双击 `AAA_<ver>_x64_en-US.msi` |
| 替代 | NSIS | 双击 `AAA_<ver>_x64-setup.exe` |
| 不想要安装包，只发可执行 | portable zip | `.\scripts\package-portable.ps1` 出 `dist-pkg\aaa-<ver>-windows-<arch>.zip`，解压后双击 `install.cmd` |

portable zip 内含 `bin\aaa.exe` + 图标 + 自包含 `install.ps1`/`install.cmd`，同事不需要装 Rust/Node，但若是老 Win10 需要先装一次 WebView2 Runtime。

### 脚本一览

| 脚本 | 用途 |
|------|------|
| `scripts/dev.sh` | 本地快速运行（Vite HMR + cargo 增量重编 + 自动开窗） |
| `scripts/build-release.sh` | Linux release 构建（含 deb/rpm/appimage） |
| `scripts/install-linux.sh` | 本机安装到 `~/.local` 或自定义 prefix |
| `scripts/package-portable.sh` | Linux portable tarball（含自包含 install.sh） |
| `scripts/build-release.ps1` / `.cmd` | Windows release 构建（含 MSI / NSIS） |
| `scripts/install-windows.ps1` / `.cmd` | Windows 本机安装到 `%LOCALAPPDATA%\Programs\AAA` |
| `scripts/package-portable.ps1` / `.cmd` | Windows portable zip（含自包含 install.ps1/install.cmd） |

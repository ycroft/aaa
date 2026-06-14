# AAA · Agent Analyzer

跨后端的本地 AI 编码代理会话日志分析工具。读取磁盘上各家 agent（Claude Code、opencode、…）的原生日志，统一成共享数据模型，在桌面 UI 里呈现：会话列表、可折叠时间线、token 成本与上下文窗口走势，标红峰值节点和上下文跳跃点，方便定位"窗口炸在哪条消息"。

更详细的使用说明见 [`README.md`](README.md)；本文件给 Claude Code 看，覆盖工程结构、扩展点、构建分发。

## 工程结构

```
tools/aaa/
├── core/             # tauri-free 业务核心（cargo workspace 成员）
│   └── src/
│       ├── model.rs        # 统一数据模型（SessionSummary/SessionNode/MessagePart/TokenUsage/SubAgentSession 等）
│       ├── providers/      # SessionProvider trait + claude_code / opencode 实现
│       ├── settings.rs     # AppSettings 持久化（~/.config/aaa/settings.json）
│       ├── remote/         # SSH 远程同步子系统（ssh/mirror/probe/known_hosts）
│       ├── stats.rs        # 跨 provider 的按需统计（skill 用量聚合等）
│       ├── feedback.rs     # 本地 feedback ticket 持久化（~/.config/aaa/tickets.json）
│       ├── log_buffer.rs   # WARN+ERROR 日志环形缓冲（给 feedback excerpt 用）
│       ├── log_excerpt.rs  # 日志脱敏/截断
│       └── logger.rs       # 滚动文件日志（flexi_logger，AAA_LOG 环境变量覆盖）
├── server/            # aaa-hub 服务端（cargo workspace 成员，Axum + SQLite）
│   ├── src/
│   │   ├── routes/          # health / feedback / updates(manifest+artifacts) / admin
│   │   ├── domain/          # feedback / update 领域模型
│   │   └── notify/          # email 通知（lettre SMTP）
│   ├── admin-ui/            # 管理后台静态页（index.html + admin.js）
│   ├── migrations/          # SQLite 迁移脚本
│   └── tests/               # 11 个集成测试
├── src-tauri/         # Tauri host
│   └── src/
│       ├── commands.rs      # 核心命令 + 远程同步 + 导出 + AI agent 启动
│       ├── hub_commands.rs  # aaa-hub 相关命令（feedback / update）
│       └── hub.rs           # HubClient（reqwest 封装，fail-silent 规则）
├── src/               # React + TypeScript UI（Vite 8 / React 18）
│   ├── App.tsx              # 顶层状态机
│   ├── api.ts               # 包装所有 Tauri invoke
│   ├── model-context.ts     # 模型→上下文窗口静态查找表（正则前缀匹配）
│   ├── types.ts             # 与 core/model.rs 对齐的 TS 类型
│   ├── format.ts            # 路径/数字/时间格式化
│   ├── hooks/useStatusHint  # 状态栏提示
│   ├── styles/app.css       # 全局样式
│   └── components/          # 14 个组件（见下文）
├── docs/              # 设计文档（aaa-hub 实现方案、更新/反馈服务设计）
├── scripts/           # 构建/安装/打包脚本（Linux + Windows）
├── vendor/tauri-cache/         # Linux AppImage 打包上游产物
├── vendor/tauri-cache-windows/ # Windows MSI/NSIS 打包上游产物
└── Cargo.toml         # workspace = [src-tauri, core, server]
```

技术栈：Tauri 2 + React 18 + TypeScript 5 + Vite 8（前端），Rust（core + src-tauri + server），Node ≥ 20.19。

### 前端组件一览

`Menubar` · `Toolbar` · `SessionList` · `SessionViewer` · `SettingsDialog` · `ProviderSplash` · `StatusBar` · `AboutDialog` · `AiAnalysisDialog` · `FeedbackDialog` · `FeedbackList` · `RemoteEditor` · `RemoteProgressDialog` · `UpdateBanner`

## 架构与扩展点

数据流：**provider 解析磁盘日志 → 统一数据模型 → Tauri command → React UI**。前端永远不接触原生日志格式。

核心抽象在 `core/src/providers/mod.rs`：

```rust
pub trait SessionProvider: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn default_root(&self) -> Option<PathBuf>;
    fn is_implemented(&self) -> bool { true }
    fn remote_root_candidates(&self) -> Vec<&'static str> { Vec::new() }
    fn remote_sync_files(&self) -> Option<Vec<&'static str>> { None }
    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>>;
    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail>;
}
```

- `remote_root_candidates()` — 远程主机上的候选日志路径（`{home}` 占位符会被替换为远程 `$HOME`）
- `remote_sync_files()` — 选择性同步文件列表（如 SQLite 仅需 db 文件本身）；`None` 表示整树镜像

新增 backend 的步骤：

1. 在 `core/src/providers/` 加一个文件实现 `SessionProvider`，把原生日志翻译成 `SessionNode + MessagePart + TokenUsage`。
2. 在 `providers/mod.rs::all()` 里注册一行。
3. 不需要动 `commands.rs`，也不需要动前端——`list_providers` 命令会自动把它列出来。

### 统一数据模型（`core/src/model.rs`）

| 类型 | 作用 |
|------|------|
| `SessionSummary` | 列表项：title / cwd / branch / 起止时间 / 消息数 / token 累计 / `peak_context_tokens` |
| `SessionNode` | 时间线节点：kind（user/assistant/system/tool_result/sidechain/meta）+ `parts` + `usage` + `cumulative_context_tokens` |
| `MessagePart` | 节点内片段：Text / Thinking / ToolUse / ToolResult / Image / Attachment / Note |
| `TokenUsage` | input / output / cache_creation / cache_read / service_tier，`context_window()` 把前 4 项加起来 |
| `SessionDetail` | 完整会话：summary + nodes + subagents |
| `SubAgentSession` | 子代理会话：agent_id / agent_type / kind / parent_tool_use_id / summary + nodes |
| `SubAgentKind` | 子代理类型：Normal（真实子代理）/ AsideQuestion（/aside 侧链）/ Compact（自动压缩快照） |
| `ProviderInfo` | 序列化的 provider 描述符（id / display_name / default_root / root_exists / is_implemented） |

UI 的"峰值标红 + 跳跃标橙"靠的是 `cumulative_context_tokens` 这个累计最大值字段——所有 provider 都需要正确填充它。

### Tauri 命令面

`src-tauri/src/commands.rs` + `hub_commands.rs`，对应 `src/api.ts`：

| 命令 | 用途 |
|------|------|
| `get_app_info` | 返回 AppInfo（name / version / author / release_notes，release_notes 由 include_str! 内联） |
| `list_providers` | 返回所有 backend + 默认目录是否存在 |
| `list_sessions` | 列指定 backend 下的会话（支持目录覆盖） |
| `load_session` | 按文件路径加载完整 `SessionDetail` |
| `session_skill_usage` | 按需计算 skill 用量统计（当前仅 claude-code 有结构化数据） |
| `get_settings` / `save_settings` | 读写 `AppSettings`（remotes 字段由专用命令管理，不会被通用保存覆盖） |
| `list_remotes` / `save_remote` / `delete_remote` | 远程 SSH 主机 CRUD |
| `list_remote_caches` | 列出已同步到本地的远程缓存 |
| `remote_probe` | 探测远程主机上可用的 provider |
| `remote_open` | SSH 连接 → 探测 → SFTP 增量同步，通过 Tauri event 流式报告进度，支持 `remote_cancel` 取消 |
| `remote_cancel` | 取消进行中的 `remote_open` |
| `check_command_exists` | 检查命令是否在 PATH 上可用 |
| `export_session` / `export_all_sessions` | 导出会话为 pretty-printed JSON |
| `launch_agent` | 在新终端窗口启动 AI agent（写入 prompt.txt 后通过 cmd_template 展开命令） |
| `hub_status` | 探测 aaa-hub 健康端点 |
| `submit_feedback` | 提交 feedback ticket（可选附件 + 日志 excerpt），本地也留存一份 |
| `get_feedback_status` | 查询 ticket 远端状态 |
| `list_local_tickets` | 列出本地已提交的 ticket |
| `check_update` | 预留（前端直接调用 @tauri-apps/plugin-updater） |
| `refresh_hub` | 设置变更后重新绑定 HubClient |

### Settings 结构（`core/src/settings.rs`）

`AppSettings` 持久化在 `~/.config/aaa/settings.json`：

| 字段 | 说明 |
|------|------|
| `provider_roots` | `HashMap<String, String>` — provider 目录覆盖 |
| `remotes` | `Vec<RemoteHost>` — SSH 远程主机列表 |
| `ai` | `AiSettings` — mode（None/Agent/Api）+ agents 列表 + prompt 模板 |
| `ui` | `UiSettings` — theme / preview_chars / auto_expand_threshold_tokens |
| `hub` | `HubSettings` — base_url + device_id（空 base_url = 未配置，不发请求） |

### 远程同步子系统（`core/src/remote/`）

通过 SSH（russh）连接远程主机，增量同步 agent 日志到本地缓存（`~/.cache/aaa/remotes/<host_id>/<provider_id>/`）。

- `ssh.rs` — SSH 连接、SFTP 会话、TOFU host-key 验证
- `mirror.rs` — 增量目录镜像（mtime 对比）或选择性文件同步
- `probe.rs` — 探测远程主机上各 provider 的日志目录
- `known_hosts.rs` — TOFU host-key 存储
- 抽象 `RemoteFs` trait 便于测试 mock

### aaa-hub 服务端（`server/`）

独立部署的 Axum Web 服务，为桌面客户端提供反馈提交、更新检查等功能：

- **路由**：`/v1/feedback`（创建/查询）、`/v1/updates/manifest`（版本清单）、`/v1/updates/artifacts`（静态文件）、`/admin`（管理后台）、`/healthz`
- **存储**：SQLite（sqlx + migrations）
- **通知**：SMTP 邮件（lettre）
- **限流**：governor（feedback 创建、manifest 查询）
- **认证**：admin token
- 遵循 fail-silent 规则：客户端侧所有 hub 错误都静默处理，不弹给用户

## 当前 Backend

| ID | 状态 | 默认目录 | 说明 |
|----|------|---------|------|
| `claude-code` | 已实现 | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 逐行 JSONL 解析，按 `type` 字段映射节点；含子代理（`subagents/agent-<id>.jsonl`） |
| `opencode` | 已实现 | `~/.local/share/opencode/opencode.db`（可在设置里覆盖目录或直接指向 db 文件） | 读 SQLite `session/message/part` 三张表；`source_path` 编码为 `<db>#<session_id>`；tool 调用合并为单个 ToolUse 节点；`remote_sync_files()` 返回选择性文件列表 |

## 模型上下文窗口

`src/model-context.ts` 维护静态查找表，正则前缀匹配，首个命中即返回。未匹配时回退到 `session.peak_context_tokens`。新增模型在此文件登记。

当前覆盖：Claude 系列（opus-4 ≥4.6 = 1M，其余 200K）· GPT 系列（4o/4-turbo = 128K，4 = 32K，3.5 = 16K）· o1 系列（o1 = 200K，o1-preview/mini = 128K）。

## 提交约束（重要）

> **涉及代码/功能改动的 commit 必须同步 bump 版本号 + 追加 release notes。** 版本号是分发产物（deb/rpm/AppImage/MSI/NSIS/portable）唯一的可识别标记，代码变了不动版本号会导致同事拿到的安装包与代码对不上。
>
> **纯文档改动（README、CLAUDE.md、docs/、注释、commit message 错字之类）可以不动版本号、也不必追加 release notes。** 这类 commit 不会改变二进制行为，硬要 bump 反而会污染发布历史。判断标准：编译产物字节是否会变？不会就跳过版本号。`release-notes.txt` 例外——它会被 `include_str!` 内联进二进制，所以改它本身就算"代码改动"，需要伴随版本号 bump。

需要同步修改的 4 处版本字段（必须保持一致）：

| 文件 | 字段 |
|------|------|
| `tools/aaa/package.json` | `"version"` |
| `tools/aaa/src-tauri/tauri.conf.json` | `"version"` |
| `tools/aaa/src-tauri/Cargo.toml` | `[package].version` |
| `tools/aaa/core/Cargo.toml` | `[package].version` |

> 注：`server/Cargo.toml` 版本号独立管理，不参与同步。

外加一处必须同步更新的文件：

| 文件 | 要做的事 |
|------|---------|
| `tools/aaa/release-notes.txt` | 在文件**顶部**追加新版本块：先写 `vX.Y.Z` 标题行，再用一行短横线分隔，最后用 `- ` 列出本次提交的关键改动。该文件由 `src-tauri/src/commands.rs` 通过 `include_str!("../../release-notes.txt")` 在编译期内联到二进制，About 对话框直接展示其内容。 |

版本号语义参考 SemVer：

- **patch**（`0.1.0 → 0.1.1`）：bug 修复、UI 微调、依赖小升级（注：纯文档改动**不**走 patch，不动版本号）
- **minor**（`0.1.0 → 0.2.0`）：新增 backend、新增 Tauri 命令、新增可见功能
- **major**（`0.1.0 → 1.0.0`）：数据模型/命令面破坏性改动，或正式发布里程碑

工作流：涉及代码/功能改动时，先更新这 4 个版本字段 + `release-notes.txt`，再 `git add`，把版本号变更、release notes 变更和功能变更放进**同一个 commit**。如果忘了，就用 `git commit --amend` 补回去（前提是该提交还没推到远端）。纯文档改动跳过版本号步骤即可。

> **每次完成修改都要 push 到远端。** 本仓库的"完成"包含 commit + `git push origin <branch>` 两步——只本地 commit 不推、或者推完忘了告知，都视为没完成。理由：分发产物（deb/rpm/AppImage/MSI/NSIS/portable）都基于远端 master 构建，本地未推的 commit 等同于没做过。原则上不要 force push 到 master；如果是修正未推 commit 的常规 amend，正常 push 即可。

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
- 可选：构建 MSI 需要 WiX，构建 NSIS 需要 NSIS。`scripts\build-release.ps1` 启动时会从 `vendor\tauri-cache-windows\` 把工具链摆到 `%LOCALAPPDATA%\tauri\`，跳过 tauri-bundler 自身的 GitHub 下载。**首次进库时 vendor 目录是空的**，需要在能连 GitHub 的环境里跑一次 `vendor\tauri-cache-windows\README.md` 里给出的下载命令并提交，之后内网构建机就完全离线可用。

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

### Windows · 发布到 GitHub Release

**触发：等用户明确指令才发布。** 每次代码改动都要 bump 版本号（见 [提交约束](#提交约束重要)），但**版本号 bump ≠ 自动发布**。GitHub Release 是面向同事的对外分发渠道，必须由用户显式说"发布 vX.Y.Z"或"把当前版本发出去"才走这个流程。中间多个 patch/minor commit 累计后再一次性发布是常态。

**Release notes 用英文，且要累计。** `release-notes.txt` 仓库内是中文（About 对话框直接展示），但 GitHub Release 的 body 一律翻成英文。每次发布的 body **必须包含从上次已发布 GitHub Release 之后的所有版本块**——不只是当前 HEAD 那一版。例如上一次发布是 v1.3.0，本次发布 v1.4.2，那 body 里要按从新到旧的顺序包含 v1.4.2 / v1.4.1 / v1.4.0 / v1.3.4 / v1.3.3 / v1.3.2 / v1.3.1 七个版本块（v1.3.0 不含），都翻成英文。

**产物：** MSI + NSIS 两个安装包都传，同事按习惯挑一个用。

**步骤**（假设当前版本 `<ver>`，已 commit + push 到 master）：

```bash
# 1. 确定上一次已发布的 release tag（用来界定 release notes 的累计范围）
gh release list --limit 5

# 2. 从 release-notes.txt 截取 (last_published, current] 范围内的所有版本块，翻译成英文，
#    写到 target/release-notes-v<ver>.md（参考已有 release 的格式：
#    每个版本一段 ## vX.Y.Z 标题 + bullet 列表，末尾加一段 ### Install 表格）。
#    target/ 已被 .gitignore 覆盖，不要提交。

# 3. 构建（约 2-3 分钟，已 vendor 上游产物，离线可用）
.\scripts\build-release.ps1

# 4. 打 tag 并推送（基于 master HEAD，必须与已 push 的版本号 commit 一致）
git tag -a v<ver> -m "v<ver>"
git push origin v<ver>

# 5. 创建 release 并上传两个安装包
gh release create v<ver> \
  --title "v<ver>" \
  --notes-file target/release-notes-v<ver>.md \
  "target/release/bundle/msi/AAA_<ver>_x64_en-US.msi" \
  "target/release/bundle/nsis/AAA_<ver>_x64-setup.exe"
```

**注意事项：**

- 打 tag 前先 `git fetch origin master && git log -1 origin/master` 确认远端 HEAD 跟本地一致——版本号 bump 的 commit 必须已 push，否则 tag 指向的 commit 在远端不存在。
- 不要用 `--notes-file release-notes.txt`：那会把全部历史 notes 都贴进 release body，且语言是中文。一定要走"截取 + 翻译"这步。
- `gh auth status` 不通时让用户 `gh auth login`，需要 `repo` scope；这一步不要自动跑，登录是交互式的。
- 不要给 release 打 `--draft` 或 `--prerelease`，除非用户明确要求。
- 发布后用 `gh release view v<ver>` 抽查：title / assets / body 三项都对再算完。

### 脚本一览

| 脚本 | 用途 |
|------|------|
| `scripts/dev.sh` / `scripts/dev.ps1` / `scripts/dev.cmd` | 本地快速运行（Vite HMR + cargo 增量重编 + 自动开窗） |
| `scripts/build-release.sh` | Linux release 构建（含 deb/rpm/appimage） |
| `scripts/install-linux.sh` | 本机安装到 `~/.local` 或自定义 prefix |
| `scripts/package-portable.sh` | Linux portable tarball（含自包含 install.sh） |
| `scripts/build-release.ps1` / `.cmd` | Windows release 构建（含 MSI / NSIS） |
| `scripts/install-windows.ps1` / `.cmd` | Windows 本机安装到 `%LOCALAPPDATA%\Programs\AAA` |
| `scripts/package-portable.ps1` / `.cmd` | Windows portable zip（含自包含 install.ps1/install.cmd） |

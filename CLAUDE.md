# AAA · Agent Analyzer

跨后端的本地 AI 编码代理会话日志分析工具。读取磁盘上各家 agent（Claude Code、opencode、…）的原生日志，统一成共享数据模型，在桌面 UI 里呈现：会话列表、可折叠时间线、token 成本与上下文窗口走势，标红峰值节点和上下文跳跃点，方便定位"窗口炸在哪条消息"。

更详细的使用说明见 [`README.md`](README.md)；本文件给 Claude Code 看，覆盖工程结构、扩展点、构建分发。

## 工程结构

```
aaa/
├── core/             # tauri-free 业务核心（cargo workspace 成员）
│   └── src/
│       ├── model.rs        # 统一数据模型（SessionSummary/SessionNode/MessagePart/TokenUsage/SubAgentSession/TpsMetrics 等）
│       ├── providers/      # SessionProvider trait + claude_code / code_agent_3x / opencode 实现 + 共享的 anthropic_jsonl 解析器
│       ├── settings.rs     # AppSettings 持久化（~/.config/aaa/settings.json）
│       ├── remote/         # SSH 远程同步子系统（ssh/mirror/probe/known_hosts/incremental）
│       ├── stats.rs        # 跨 provider 的按需统计（skill 用量聚合等）
│       ├── skills.rs       # SKILL.md 指纹注册表（前 128 字节做指纹，对齐 user-text 注入识别 skill 调用）
│       ├── skill_detect.rs # 统一 skill 检测 pipeline（user-text 指纹 + assistant tool_use，case-insensitive）
│       ├── tps.rs          # tokens-per-second 聚合（per-agent 曲线 + per-session 汇总）
│       ├── feedback.rs     # 本地 feedback ticket 持久化（~/.config/aaa/tickets.json）
│       ├── log_buffer.rs   # WARN+ERROR 日志环形缓冲（给 feedback excerpt 用）
│       ├── log_excerpt.rs  # 日志脱敏/截断
│       └── logger.rs       # 滚动文件日志（flexi_logger，AAA_LOG 环境变量覆盖）
├── wire/             # aaa-wire crate（客户端↔服务端共享 wire schema 的唯一定义源）
│   └── src/
│       ├── feedback.rs   # CreateFeedbackRequest/Response, GetFeedbackResponse, AttachmentMeta, Category/Severity/Status
│       ├── health.rs     # HealthResponse
│       └── version.rs    # SCHEMA_VERSION 常量 + default 助手
├── server/            # aaa-hub 服务端（cargo workspace 成员，Axum + SQLite）
│   ├── src/
│   │   ├── routes/          # health / feedback / updates(manifest+artifacts) / web_api / web_static
│   │   ├── auth_web.rs      # 伪 SSO 提取器（RequireAuth/RequireAdmin，预留真实 SSO TODO）
│   │   ├── domain/          # update 领域模型（feedback 领域逻辑直接落在 routes/feedback.rs）
│   │   └── notify/          # email 通知（lettre SMTP）
│   ├── web/                 # Web 前端（React 18 + TypeScript 5 + Vite 8）
│   │   └── src/
│   │       ├── components/SessionViewer/  # 从桌面端移植，无 Tauri 依赖
│   │       ├── pages/       # Landing / Download / Login / Dashboard / Analysis / Admin/*
│   │       ├── types.ts     # 与 core/model.rs 对齐（同桌面端 src/types.ts）
│   │       └── api.ts       # fetch 封装（代理到后端 /api/*）
│   ├── migrations/          # SQLite 迁移脚本（0001_init: feedback；0002_web: web_sessions）
│   └── tests/               # 集成测试
├── src-tauri/         # Tauri host
│   └── src/
│       ├── commands.rs      # 核心命令 + 远程同步 + 导出 + AI agent 启动
│       ├── hub_commands.rs  # aaa-hub 相关命令（feedback / update）
│       └── hub.rs           # HubClient（reqwest 封装，fail-silent 规则）
├── src/               # React + TypeScript UI（Vite 8 / React 18）
│   ├── App.tsx              # 顶层状态机 + I18nProvider 包裹 + 多 tab 工作区
│   ├── api.ts               # 包装所有 Tauri invoke
│   ├── model-context.ts     # 模型→上下文窗口静态查找表（正则前缀匹配）
│   ├── panels.ts            # 多 tab 面板身份键（panelIdentity）+ PanelDescriptor
│   ├── types.ts             # 与 core/model.rs 对齐的 TS 类型
│   ├── format.ts            # 路径/数字/时间格式化
│   ├── i18n/                # 中英文 catalog（zh.ts 为权威源，en.ts 须镜像形状）+ DeepStrings 类型卫戍
│   ├── hooks/useStatusHint  # 状态栏提示
│   ├── styles/app.css       # 全局样式
│   └── components/          # 17 个组件（见下文 · SessionViewer 已是子目录）
├── docs/              # 设计文档（按 superpowers 工作流，分 plans/ 与 specs/）
├── scripts/           # 构建/安装/打包脚本（Linux + Windows，含 server/ 子目录）
├── vendor/tauri-cache/         # Linux AppImage 打包上游产物
├── vendor/tauri-cache-windows/ # Windows MSI/NSIS 打包上游产物
└── Cargo.toml         # workspace = [src-tauri, core, server, wire]
```

技术栈：Tauri 2 + React 18 + TypeScript 5 + Vite 8（前端），Rust（core + src-tauri + server），Node ≥ 20.19。

### 前端组件一览

按职责分三层：

- **壳层（多 tab 工作区）**：`Menubar` · `Toolbar` · `TabBar` · `StatusBar` · `EmptyWorkspace` · `SessionPanel` · `ProviderSplash` · `UpdateBanner`
- **业务对话框**：`SettingsDialog` · `AboutDialog` · `AiAnalysisDialog` · `FeedbackDialog` · `FeedbackList` · `RemoteEditor` · `RemoteProgressDialog`
- **会话查看器子树**：`SessionList` · `SessionViewer/`（`index.tsx` + `parts/`：BashView / DiffView / ReadView / TodoView / Highlight / Metric / CtxBar / PartView / SkillChips / ToolChips / ToolFilterDropdown / Tooltips / AgentSwitcher 等 part 视图与 `edit-detect.ts` / `rich-tools.ts` 工具；`hooks/`：useDropdownDismiss / useMessageSearch / useSkillUsage；`stats.ts` + `viz.ts` 负责图表）

`SessionPanel` 是单个 tab 的壳——一个 panel 对应一个"已打开的 backend 来源"，由 `panels.ts::panelIdentity` 按 (provider, root) 或 (provider, remoteId) 去重。`App.tsx` 内层 `AppInner` 维护 panel 列表，`I18nProvider` 在外层包裹，靠 `src/i18n/` 的 catalog（zh 权威 / en 镜像，DeepStrings 类型卫戍）解析 `t(...)` 文案。

## 架构与扩展点

数据流：**provider 解析磁盘日志 → 统一数据模型 → Tauri command → React UI**。前端永远不接触原生日志格式。

核心抽象在 `core/src/providers/mod.rs`：

```rust
pub enum RemoteSyncStrategy {
    Default,                // mirror::sync_files / sync_dir 整树或白名单镜像
    OpencodeIncremental,    // 远端 sqlite3 行级增量 SELECT，全量 SFTP 兜底
}

pub trait SessionProvider: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn default_root(&self) -> Option<PathBuf>;
    fn is_implemented(&self) -> bool { true }
    fn remote_root_candidates(&self) -> Vec<&'static str> { Vec::new() }
    fn remote_sync_files(&self) -> Option<Vec<&'static str>> { None }
    fn remote_sync_strategy(&self) -> RemoteSyncStrategy { RemoteSyncStrategy::Default }
    fn skill_usage(&self, _detail: &SessionDetail) -> Vec<SkillUsage> { Vec::new() }
    fn skill_roots(&self, _cwd: Option<&Path>) -> Vec<PathBuf> { Vec::new() }
    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>>;
    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail>;
}
```

- `remote_root_candidates()` — 远程主机上的候选日志路径（`{home}` 占位符会被替换为远程 `$HOME`）
- `remote_sync_files()` — 选择性同步文件列表（如 SQLite 仅需 db 文件本身）；`None` 表示整树镜像
- `remote_sync_strategy()` — 同步算法选择：默认走 `mirror::*`，opencode 选 `OpencodeIncremental` 跑 `remote/incremental.rs` 的行级增量
- `skill_usage()` — 把已加载的 `SessionDetail` 折成 `Vec<SkillUsage>` 的聚合视图（按 `core/src/skill_detect.rs` 统一 pipeline 处理）
- `skill_roots()` — 探测 `<root>/<id>/SKILL.md` 指纹的根目录（如 `~/.claude/skills`、`<cwd>/.opencode/skills`），由 `core/src/skills.rs` 注册到指纹表

新增 backend 的步骤分两档，按是否与现有 provider 同协议选：

**A. 协议与 Claude Code 完全相同（jsonl 形态，例如 Code Agent 3.x）：**

1. 在 `core/src/providers/<id>.rs` 写 ~50 行薄壳：const ID + display_name + default_root + remote_root_candidates，`list_sessions` / `load_session` / `skill_usage` 全部委托到 `super::anthropic_jsonl`
2. 在 `providers/mod.rs` 加 `pub mod <id>;` 并在 `all()` 注册一行
3. （可选）若是可启动的 agent，在 `settings.rs::AiSettings::default()` 加一条 `AgentConfig` 进 `agents` 列表（自动会被 `ensure_canonical_presets` 迁移给老用户补上）
4. 在 `core/tests/smoke.rs` 加一个 `parses_a_real_<id>_session_when_one_is_present` 测试
5. 完成 —— 前端、Tauri 命令、远程同步全部零改动

**B. 协议不同（自定义存储，例如 opencode 的 SQLite）：**

1. 在 `core/src/providers/<id>.rs` 完整实现 `SessionProvider`，把原生日志翻译成 `SessionNode + MessagePart + TokenUsage`，正确填充 `cumulative_context_tokens` 与 `generation_duration_ms`（后者驱动 TPS 计算）
2. 若需结构化 skill 检测，override `fn skill_usage()` 自定义提取逻辑（参考 `anthropic_jsonl::collect_skill_usage` 的两遍扫描思路），需要 SKILL.md 指纹识别时 override `fn skill_roots()` 把候选根目录吐给 `core/src/skills.rs`
3. 远程同步按需求三档选其一：
   - 整树镜像（默认） — 啥都不 override
   - 白名单文件镜像 — override `fn remote_sync_files()` 返回名单（参考 opencode：`vec!["opencode.db", "opencode.db-wal", "opencode.db-shm"]`）
   - 行级增量 — override `fn remote_sync_strategy()` 返回 `RemoteSyncStrategy::OpencodeIncremental`，并在 `core/src/remote/incremental.rs` 那一类模块里实现增量算法；失败自动回落到 `remote_sync_files()`/全树镜像
4. 在 `providers/mod.rs::all()` 注册
5. （可选）AI preset 同 A 第 3 步，smoke test 同 A 第 4 步
6. 前端通常零改动；唯一需要前端配合的场景：display_name 需要本地化后缀，加到 `src/format.ts::providerLabel`（参考 opencode 的 nga-compat 后缀）

> **关键不变量**：凡是涉及 provider 派发的逻辑都已经走 `providers::find(&provider_id)` 动态查找，**`core/src/stats.rs` / Tauri 命令 / 前端组件里都不应该出现按 provider_id 字符串 match 的代码**。如果你正想加一行这样的 match —— 退一步，加一个 trait 方法。

### 统一数据模型（`core/src/model.rs`）

| 类型 | 作用 |
|------|------|
| `SessionSummary` | 列表项：title / cwd / branch / 起止时间 / 消息数 / token 累计 / `peak_context_tokens` / `used_skills`（已检测到的 skill id 列表） |
| `SessionNode` | 时间线节点：kind（user/assistant/system/tool_result/sidechain/meta）+ `parts` + `usage` + `cumulative_context_tokens` |
| `MessagePart` | 节点内片段：Text / Thinking / ToolUse / ToolResult / Image / Attachment / Note |
| `TokenUsage` | input / output / cache_creation / cache_read / service_tier / `generation_duration_ms`（assistant 生成耗时，TPS 用），`context_window()` 把 input + 两个 cache 桶加起来 |
| `SessionDetail` | 完整会话：summary + nodes + subagents + `tps_session`（可选）+ `tps_per_agent`（含主代理 + Normal 子代理） |
| `SubAgentSession` | 子代理会话：agent_id / agent_type / kind / `type_ordinal`（同 type 内 1-based 序号，UI 标 "Explore@2"）/ `description` / parent_tool_use_id / summary + nodes |
| `SubAgentKind` | 子代理类型：Normal（真实子代理）/ AsideQuestion（/aside 侧链）/ Compact（自动压缩快照） |
| `TpsMetrics` | 一组 assistant turn 的 TPS 聚合：`tps_mean`（per-turn 算术平均，不是 total/total）/ `tps_median` / `sample_count` / `excluded_count` 等 |
| `TpsSeriesPoint` | per-agent 曲线点：`tps` 永远非零（不合格的 turn 走 forward-fill，并标 `interpolated = true`） |
| `AgentTps` | 单个 agent 的 metrics + series 打包，键入 `SessionDetail.tps_per_agent`，主代理用常量 `"<main>"` 作 key |
| `ProviderInfo` | 序列化的 provider 描述符（id / display_name / default_root / root_exists / is_implemented） |

UI 的"峰值标红 + 跳跃标橙"靠的是 `cumulative_context_tokens` 这个累计最大值字段——所有 provider 都需要正确填充它。TPS 曲线由 `core/src/tps.rs` 在 `load_session` 时计算填进 `tps_per_agent` / `tps_session`，provider 只需把 `generation_duration_ms` 填好。

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
| `check_update` | 占位实现（始终返回 `Ok(None)`），未通过 `api.ts` 暴露；前端实际走 `@tauri-apps/plugin-updater` 直连 |
| `refresh_hub` | 设置变更后重新绑定 HubClient |

### Settings 结构（`core/src/settings.rs`）

`AppSettings` 持久化在 `~/.config/aaa/settings.json`：

| 字段 | 说明 |
|------|------|
| `provider_roots` | `HashMap<String, String>` — provider 目录覆盖 |
| `remotes` | `Vec<RemoteHost>` — SSH 远程主机列表 |
| `ai` | `AiSettings` — `mode`（None/Agent/Api）+ `selected_agent` + `agents: Vec<AgentConfig>`（preset 由 `ensure_canonical_presets` 迁移补齐）+ `prompt_templates: Vec<PromptTemplate>`（每条带 `TemplateScope::Single`/`All`） |
| `ui` | `UiSettings` — `theme` / `preview_chars` / `auto_expand_threshold_tokens` / `language`（"auto" 跟随 `navigator.language`，"zh" / "en" 显式覆盖） |
| `hub` | `HubSettings` — `base_url` + `device_id`（空 base_url = 未配置，不发请求） |

### 远程同步子系统（`core/src/remote/`）

通过 SSH（russh）连接远程主机，增量同步 agent 日志到本地缓存（`~/.cache/aaa/remotes/<host_id>/<provider_id>/`）。

- `ssh.rs` — SSH 连接、SFTP 会话、TOFU host-key 验证
- `mirror.rs` — 增量目录镜像（mtime 对比）或选择性文件同步
- `probe.rs` — 探测远程主机上各 provider 的日志目录（opencode 探测会要求远端 sqlite3 ≥ 3.33.0）
- `incremental.rs` — opencode 行级增量同步：远端跑 sqlite3 SELECT，本地 cache db 应用结果，watermark 持久化在 `aaa_sync_state` 表；任意失败回落到 `mirror::sync_files` 全量 SFTP
- `known_hosts.rs` — TOFU host-key 存储
- 抽象 `RemoteFs` trait 便于测试 mock

### aaa-hub 服务端（`server/`）

独立部署的 Axum Web 服务，兼顾桌面客户端 API 和完整的产品网站（BS/CS 混合架构）：

- **路由**：
  - `/v1/*` — 桌面客户端 API（feedback 创建/查询/撤销、updates manifest/artifacts）
  - `/api/*` — Web 前端 API（auth/me、sessions CRUD、releases、release-notes；admin 子路由需 SSO admin 身份）
  - `/healthz` — 健康检查
  - `/*` — React SPA（rust-embed 编译期内嵌 `server/web/dist/`，未命中的路径回退 index.html）
- **Web 前端功能**：产品宣传首页、下载页（版本列表 + release notes）、会话日志分析（SessionViewer 移植自桌面端）、Dashboard（占位）、后台管理（反馈 + 版本发布）
- **鉴权**：读取 SSO cookie（`config.server.sso_cookie_name`，默认 `aaa_user`）；当前为伪实现，cookie 值直接作为 user_id；`config.server.admin_users` 配置 admin 工号列表（后端强制，不下发前端）
- **存储**：SQLite（sqlx + migrations）— `0001_init`（feedback/attachment）、`0002_web`（web_auth_sessions/web_sessions）
- **通知**：SMTP 邮件（lettre）
- **限流**：governor（feedback 创建、manifest 查询）
- 遵循 fail-silent 规则：客户端侧所有 hub 错误都静默处理，不弹给用户

**Web 前端构建：**`server/web/dist/` 必须在 `cargo build` 前构建好（rust-embed 编译期读取）。
```bash
cd server/web && npm install && npm run build   # 先构建前端
cargo build -p aaa-hub                          # 再编译后端（embed dist/）
```
开发时用 Vite HMR（`npm run dev`，代理 `/api/` `/v1/` 到后端端口）+ `scripts/server/dev.sh` 独立跑后端。

**SSO 接入点**：`server/src/auth_web.rs` 的 `fake_extract_user()` 函数，TODO 注释处替换为真实 SSO 验证逻辑。

## 当前 Backend

| ID | 状态 | 默认目录 | 说明 |
|----|------|---------|------|
| `claude-code` | 已实现 | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 逐行 JSONL 解析，按 `type` 字段映射节点；含子代理（`subagents/agent-<id>.jsonl`） |
| `code-agent-3x` | 已实现 | `~/.cac/projects/<encoded-cwd>/<sessionId>.jsonl` | Claude Code 兼容客户端，与 `claude-code` 共享 `core/src/providers/anthropic_jsonl.rs` 解析模块 |
| `opencode` | 已实现 | `~/.local/share/opencode/opencode.db`（可在设置里覆盖目录或直接指向 db 文件） | 读 SQLite `session/message/part` 三张表；`source_path` 编码为 `<db>#<session_id>`；tool 调用合并为单个 ToolUse 节点；远程同步默认走 `RemoteSyncStrategy::OpencodeIncremental`（远端 sqlite3 行级增量 SELECT），失败回落到 `remote_sync_files()` 白名单全量 SFTP（`opencode.db` + `-wal` + `-shm`） |

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
| `aaa/package.json` | `"version"` |
| `aaa/src-tauri/tauri.conf.json` | `"version"` |
| `aaa/src-tauri/Cargo.toml` | `[package].version` |
| `aaa/core/Cargo.toml` | `[package].version` |

> 注：`server/Cargo.toml` 版本号独立管理，不参与同步。

外加一处必须同步更新的文件：

| 文件 | 要做的事 |
|------|---------|
| `aaa/release-notes.txt` | 在文件**顶部**追加新版本块：先写 `vX.Y.Z` 标题行，再用一行短横线分隔，最后用 `- ` 列出本次提交的关键改动。该文件由 `src-tauri/src/commands.rs` 通过 `include_str!("../../release-notes.txt")` 在编译期内联到二进制，About 对话框直接展示其内容。 |

> **Release notes 写功能、不写代码。** `release-notes.txt` 与 GitHub Release body 都是面向用户的——同事关心"这版能多干什么、修了什么看得见的毛病"，不关心改了哪个 `.rs` 文件、抽出了哪个 trait、删掉了哪个内部函数。每条 bullet 应当从用户视角描述行为变化（看得到什么、原来错在哪、现在怎样），文件路径 / 类型名 / 函数名 / 重构动作一律不出现。改动如果纯属内部重构、用户完全无感，那就不必单列一条；只在它解锁了未来某个能力时简短带一句。这条规则同时适用于中文 `release-notes.txt` 和翻译后的 GitHub Release body。

版本号语义参考 SemVer：

- **patch**（`0.1.0 → 0.1.1`）：bug 修复、UI 微调、依赖小升级（注：纯文档改动**不**走 patch，不动版本号）
- **minor**（`0.1.0 → 0.2.0`）：新增 backend、新增 Tauri 命令、新增可见功能
- **major**（`0.1.0 → 1.0.0`）：数据模型/命令面破坏性改动，或正式发布里程碑

工作流：涉及代码/功能改动时，**先把代码改完、跑过测试**，把版本号 + release notes 留到最后一步——临 commit 前再做。纯文档改动跳过这一步。

> **bump 前必须先同步 master，再决定下一个版本号。** 版本号字段（4 处）和 `release-notes.txt` 顶部是天然的冲突磁铁——任何同事并行合一个 PR 都会把这几行改掉。临 bump 前固定动作：
>
> 1. `git fetch origin master` 看远端 HEAD 是不是已经动过；
> 2. 如果远端跑前面去了，先 `git pull --rebase origin master`（或者切到 master `--ff-only`）把基准对齐，然后从**远端 master 当前的版本号** + 1 patch 开始 bump，不要从本地陈旧的 base 算；
> 3. **不在 master 分支也一样**：远端 master 是版本号事实来源，feature 分支也得 fetch 一下读 origin/master 的版本号当基准，不能拿本地 stale 的 HEAD 算下一版；
> 4. bump 完 4 处版本字段 + 在 `release-notes.txt` **顶部**追加新版本块，跟功能改动塞进**同一个 commit**，然后 push。

如果忘了在功能 commit 里 bump，发现时该 commit 还没推到远端就 `git commit --amend` 补；已推就再开一个 fix-up commit。

> **每次完成修改都要 push 到远端。** 本仓库的"完成"包含 commit + `git push origin <branch>` 两步——只本地 commit 不推、或者推完忘了告知，都视为没完成。理由：分发产物（deb/rpm/AppImage/MSI/NSIS/portable）都基于远端 master 构建，本地未推的 commit 等同于没做过。原则上不要 force push 到 master；如果是修正未推 commit 的常规 amend，正常 push 即可。

## Wire 兼容规则（重要）

`wire/` crate 是客户端 ↔ aaa-hub 服务端 wire format 的唯一 Rust 定义源。两侧独立发版，所以演进必须满足：

- **新增字段必须 `Option<T>` + `#[serde(default)]`**：旧客户端不发，新服务端能默认；旧服务端不返回，新客户端能默认。
- **枚举必须有 `#[serde(other)] Unknown` 兜底变体**：避免任何一端引入新值时另一端崩。
- **不要加 `#[serde(deny_unknown_fields)]`**：未知字段必须被 silently 忽略。
- **改 `aaa-wire` 任何 pub 类型，必须同步检查 `src/types.ts`** —— TS 这边是手动 mirror，PR review 守门。
- **删除字段 / 重命名字段 → bump `wire::SCHEMA_VERSION`**，并在 `release-notes.txt` 标注破坏性变更；新增 Optional 字段或新增枚举变体不动 `SCHEMA_VERSION`（前向兼容已由 Optional + Unknown 保证）。
- **server 独立版本号**（`server/Cargo.toml`）：影响外部行为时按 SemVer 走自己的 bump，不与桌面端 4 处同步。

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
cd aaa
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
cd aaa
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
- **Install 表格只能列实际上传成的 asset。** body 末尾的 `### Install` 表格里每一行的文件名，必须能在该 release 的 assets 里找到——同事点表格里的链接是要下载的，行在表里但 asset 不在就是死链。如果某次构建漏出了 NSIS 或 MSI（比如只在 Linux 机上构建、或者 WiX/NSIS 工具链缺失），上传前就把对应那一行从表里删掉，不要留着"理论上有"的行。`gh release view v<ver> --json body,assets` 可以一眼看出 body 里写了哪些文件、assets 里实际有哪些文件，发布完务必对一遍。

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
| `scripts/server/dev.sh` | 服务端本地开发（自动生成 dev config，启动 aaa-hub，默认 :8787） |
| `scripts/server/build-release.sh` | 服务端 release 构建（需先 `cd server/web && npm run build`） |

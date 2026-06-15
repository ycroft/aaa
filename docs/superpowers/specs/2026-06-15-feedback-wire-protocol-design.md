# Feedback Wire Protocol & Server Release Script — Design

**Date:** 2026-06-15
**Status:** Approved (brainstorming phase)
**Owner:** ycroft

## Background

`aaa` 桌面端与 `aaa-hub` 服务端目前通过 HTTP+JSON 通信，但没有任何共享 schema：
- 服务端 (`server/src/domain/feedback.rs`) 用 `serde(rename_all="lowercase")` 强类型解析；
- 客户端 (`src-tauri/src/hub.rs`) 反过来用 `serde_json::Value` + `v["status"].as_str()` 这种字符串读法；
- 请求体在 `src-tauri/src/hub_commands.rs` 里用 `json!()` 宏现拼，没有共享类型；
- 没有版本协商；HTTP 路径写死 `/v1/feedback`，但客户端发出去什么、服务端能否识别旧字段，完全没规则。

由于桌面端和服务端独立发版（前者打 .msi/.deb/.AppImage，后者将来要部署成一个长跑的 Linux 进程），两边的版本组合会随时间发散，必须把 wire format 形式化、并立下前向兼容规则。

同时优先级上，软件自动更新先放一放，反馈这条路要做实；服务端目前缺一个 release 打包脚本（仅需 Linux）。

## Goals

1. 客户端 ↔ 服务端 wire format 有**唯一定义源**，用 Rust 类型表达；
2. 任意一端**先升级**都不破坏功能：新字段是 Optional、未知字段忽略、未知枚举值兜底；
3. 服务端有 **`scripts/server/build-release.sh`**，输出可发布的 dist 目录（裸二进制 + migrations + admin-ui + config 模板 + README），无需触碰桌面端构建。

## Non-Goals

- 引入 protobuf / gRPC / 代码生成工具链（YAGNI；JSON + 文档化兼容规则足够）；
- 接入 `tauri-plugin-updater` 走自动更新流程（推迟）；
- 服务端 Windows 构建、Docker 镜像、.deb/.rpm 打包（部署规模不需要）；
- 路径版本化 `/v2/...`（先用 `schema_version` 字段；真有破坏性变更再升级路径）。

## Decisions (from brainstorming)

| 决策点 | 选择 |
|--------|------|
| Wire format | JSON + `schema_version` 字段 + 宽进严出兼容规则 |
| 版本协商颗粒度 | 仅 `schema_version`（不做 `/v1/capabilities` 探测） |
| Schema 类型放哪 | 新增 workspace 成员 `aaa-wire`（lean crate，仅 serde + thiserror） |
| 一期覆盖范围 | 反馈接口 + healthz；manifest/auto-update 不动 |
| 服务端发布形态 | scripts/server/build-release.sh，裸二进制 + dist 目录，Linux only |

## Architecture

### Crate 布局

```
tools/aaa/
├── core/        # 不变（业务核心，不参与 hub 通信）
├── server/      # 新增依赖 aaa-wire
├── src-tauri/   # 新增依赖 aaa-wire
├── wire/        # 新建 crate aaa-wire
│   ├── src/
│   │   ├── lib.rs        # re-exports + 顶层 doc（兼容规则三铁律）
│   │   ├── version.rs    # SCHEMA_VERSION 常量 + default_schema_version()
│   │   ├── feedback.rs   # 反馈相关 DTO + 枚举
│   │   └── health.rs     # HealthResponse
│   └── Cargo.toml        # 依赖：serde, serde_json, thiserror
└── Cargo.toml            # workspace.members += ["wire"]
```

### 依赖方向

```
aaa-wire ← aaa-hub (server)
aaa-wire ← src-tauri
aaa-core ← src-tauri
```

`aaa-core` 不依赖 `aaa-wire`：core 是会话解析/远程同步的业务核心，与 hub 通信彻底解耦。
`aaa-wire` 不依赖任何项目内 crate：保持极轻，server 二进制不被迫拉进 russh/rusqlite 等无关传递依赖。

### 类型清单（一期）

`wire/src/feedback.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFeedbackRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub category: Category,
    pub severity: Option<Severity>,
    pub title: String,
    pub description: String,
    pub contact_email: Option<String>,
    pub app_version: String,
    pub os_info: String,
    pub device_id: String,
    pub log_excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFeedbackResponse {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub ticket_id: String,
    pub claim_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetFeedbackResponse {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub status: Status,
    pub category: Category,
    pub severity: Option<Severity>,
    pub title: String,
    pub description: String,
    pub admin_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attachments: Vec<AttachmentMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Bug, Feature, Question, Other,
    #[serde(other)] Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker, Major, Minor, Trivial,
    #[serde(other)] Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    New, Triaged, InProgress, Resolved, Wontfix,
    #[serde(other)] Unknown,
}
```

`wire/src/health.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,   // 总是 "ok"，保留现有 wire 形状
    pub version: String,  // 服务端 CARGO_PKG_VERSION
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
}
```

> 现有 `/healthz` 响应已经是 `{"status":"ok","version":"X.Y.Z"}`（见 `routes/health.rs`），改造**只新增 `schema_version` 字段**，wire 形状对外完全兼容。

`wire/src/version.rs`：

```rust
pub const SCHEMA_VERSION: u32 = 1;
pub(crate) fn default_schema_version() -> u32 { SCHEMA_VERSION }
```

### 兼容规则（写进 `wire/src/lib.rs` 顶层 doc comment）

1. **新增字段必须 `Option<T>`**，且 `#[serde(default)]`；
2. **枚举必须有 `#[serde(other)] Unknown` 兜底变体**；
3. **未知字段不报错**：默认 serde 行为，不要加 `#[serde(deny_unknown_fields)]`。

服务端日志策略：收到 `schema_version > SCHEMA_VERSION` 时写 INFO（"客户端比我新"是预期），不告警；客户端永远按自己 `SCHEMA_VERSION` 解析返回。

## Migration Plan

按"小步、可测、不破坏现有 commit 边界"拆四步，每步独立 commit。

### Step 1: 落地 `aaa-wire` crate（功能等价占位）

- 新建 `wire/Cargo.toml` + `wire/src/{lib,version,feedback,health}.rs`
- 把 server `domain/feedback.rs` 的 `Category`/`Severity`/`Status`/`NewFeedback`/`CreateResponse` 整体搬到 `aaa-wire`，并按上节加 `Unknown` 变体、Optional 兜底、`schema_version` 字段
- 加 `GetFeedbackResponse` + `AttachmentMeta`（从 `routes/feedback.rs` 的 `FeedbackView`/`AttachmentView` 抽取）
- 加 `HealthResponse`
- workspace `Cargo.toml` 追加 `"wire"` 成员
- wire crate 自带单元测试：
  - 未知枚举值（如 `"category": "wontknow"`）反序列化成 `Unknown`
  - 缺失 Optional 字段填默认
  - 多余未知字段被忽略
  - 缺失 `schema_version` 字段时填 `SCHEMA_VERSION`
- 此时 server / src-tauri 还没切，整个 workspace 编译过即可

### Step 2: server 切到 `aaa-wire`

- `server/Cargo.toml` 追加 `aaa-wire = { path = "../wire" }`
- `domain/feedback.rs` 直接删除（类型已搬走），`routes/feedback.rs` 的 import 改为 `use aaa_wire::feedback::*`
- handler 签名 `Json<CreateFeedbackRequest>` / `Json<CreateFeedbackResponse>`
- `routes/health.rs` 返回 `Json<HealthResponse>`（之前是 `json!()` 宏拼的 `{status, version}`，改成结构体，wire 形状完全兼容，只新增可选 `schema_version` 字段）
- `routes/feedback.rs` 的 `FeedbackView`/`AttachmentView` 退役，用 `GetFeedbackResponse`/`AttachmentMeta`
- 适配 `server/tests/*` 的所有集成测试，行为预期不变

### Step 3: src-tauri 切到 `aaa-wire`

- `src-tauri/Cargo.toml` 追加 `aaa-wire = { path = "../wire" }`
- `hub.rs::submit` 签名从 `body: serde_json::Value` 改为 `req: CreateFeedbackRequest`
- `hub_commands.rs` 的 `json!()` 拼 body 替换为构造 `CreateFeedbackRequest { ... }`
- `hub.rs::get_status` 用 `GetFeedbackResponse` 反序列化，删除 `v["status"].as_str()` 这种字符串读法
- `RemoteTicketView` 保留作为给前端的轻量化投影类型（前端不需要看到完整响应）
- 前端 `src/types.ts` 同步加 `schema_version` 字段，与 wire 字段顺序对齐

### Step 4: 服务端发布脚本

详见 [Server Release Script](#server-release-script)。

### 版本号

| Step | 桌面端 4 处版本字段 | `server/Cargo.toml` | `wire/Cargo.toml` | release-notes.txt |
|------|---------------------|---------------------|-------------------|-------------------|
| 1 | 不动（仅新建 crate，无人 depend，桌面端二进制字节不变） | 不动 | 起步 `0.1.0` | 不加 |
| 2 | 不动（server 改不影响桌面端二进制） | patch bump `0.1.0 → 0.1.1`（内部切到 wire 类型；wire 形状仅新增可选 schema_version 字段，外部兼容） | 不动 | 不加 |
| 3 | patch bump（src-tauri 开始依赖 aaa-wire，hub.rs 改了） | 不动 | 不动 | 加一行"Typed feedback wire schema (aaa-wire); forward-compatible Optional fields and Unknown enum fallback" |
| 4 | 不动（纯 scripts 改动，且不内联进二进制） | 不动 | 不动 | 不加 |

> Step 1 起 crate 但无人 depend，桌面端 + server 二进制都不变；workspace `Cargo.lock` 的 wire 行只是元数据，不进任何二进制。
> Step 2 桌面端不动——`server/Cargo.toml` 是独立版本；server 改的是内部类型来源，对外 wire 形状仅新增可选字段。
> Step 4 改的是 scripts/，不影响任何二进制；按 CLAUDE.md "纯文档/脚本改动跳过版本号"。

## Server Release Script

### `scripts/server/build-release.sh`

参数：
- `--no-bundle`：跳过 tarball，只出 dist 目录

流程：
1. `cd` 到 workspace 根
2. `cargo build --release -p aaa-hub`（`-p` 限定只编 server）
3. 从 `server/Cargo.toml` 读出 version
4. 创建 `target/server-dist/aaa-hub-<ver>-linux-x86_64/`，里面放：
   - `aaa-hub`（拷自 `target/release/aaa-hub`）
   - `migrations/`（拷自 `server/migrations/`）
   - `admin-ui/`（拷自 `server/admin-ui/`）
   - `config.toml.example`（拷自 `scripts/server/config.toml.example`）
   - `README.md`（拷自 `scripts/server/README.md`）
5. 默认打 tarball：`tar -czf target/server-dist/aaa-hub-<ver>-linux-x86_64.tar.gz -C target/server-dist aaa-hub-<ver>-linux-x86_64/`

### `scripts/server/config.toml.example`

按 `server/src/config.rs` 反推全字段，每项配注释（中文，与 release-notes.txt 风格一致）。占位值用 `<change-me>` 而不是真实值。

### `scripts/server/README.md`

极简部署手册：
- 解压后目录布局
- `cp config.toml.example config.toml && vim config.toml`
- `AAA_HUB_CONFIG=./config.toml ./aaa-hub`，**工作目录必须在 dist 根**（因为 `db.rs` 里 `sqlx::migrate!("./migrations")` 用相对路径）
- nginx 反向代理样例（把 `/v1/*` 和 `/admin` 转给 `127.0.0.1:8080`）
- systemd unit 模板（5 行最小版本，`WorkingDirectory=` 指向 dist 根）

## Documentation Changes

`CLAUDE.md` 改两处：

1. "工程结构"小节的目录树加 `wire/` 一行：
   ```
   ├── wire/             # aaa-wire crate（客户端↔服务端 wire schema 唯一定义源）
   ```
2. "提交约束"附近新增一段"Wire 兼容规则"：
   - 改动 `aaa-wire` 任何 pub 类型，必须同步改 `src/types.ts`
   - 删除字段 / 重命名字段 → bump `SCHEMA_VERSION` + release notes 里标注破坏性变更
   - 新增 Optional 字段 / 新增枚举变体 → 不动 `SCHEMA_VERSION`（前向兼容已由 Optional + Unknown 兜底变体保证）

## Testing Strategy

- **wire crate 单元测试**（Step 1 内）：枚举 Unknown 兜底、Optional 字段缺失、未知字段忽略、`schema_version` 缺失填默认，每条 round-trip 一次
- **server 集成测试**（Step 2 内）：现有 `server/tests/*` 11 个测试全部通过，无功能回归；新增一个 `tests/wire_compat.rs`：手工构造一份"未来字段"的 JSON（多一个未知字段、多一个未知枚举值），POST 进去看能否照常创建 ticket
- **src-tauri 编译/类型检查**（Step 3 内）：`cargo check -p aaa` + `npm run build`（前端 tsc）通过即可；功能层面手动 smoke test 一次反馈提交
- **build-release.sh smoke**（Step 4 内）：跑一次脚本，验证 tarball 解压后 `./aaa-hub` 能 `--help`（或起来后 `curl localhost:8080/healthz`）

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| `routes/health.rs` 从 `json!()` 宏改 `Json<HealthResponse>`，现有 health.rs 集成测试仍然通过（断言 `status == "ok"` 和 `version` 是字符串） | 实际 wire 形状未变，纯内部类型重构 |
| `domain/feedback.rs` 删除后，server 内部其他模块（如 notify）若曾 import 这些类型会断 | Step 2 实施时全工程 grep `domain::feedback::` 确认 |
| `aaa-wire` 与前端 TS 类型脱节漂移 | doc comment 强约束 + PR review 守门；不引入 codegen（YAGNI） |
| `migrations/` 目录用相对路径加载——dist 解压后若用户 `./aaa-hub` 时不在 dist 根会启动失败 | README 显式说明；systemd unit 样例带 `WorkingDirectory=` |

## Open Questions

无。所有澄清问题已在 brainstorming 中收敛。

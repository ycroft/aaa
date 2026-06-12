# aaa-hub · 升级与反馈服务端设计

> 为 AAA 桌面端（Tauri 2 + React）提供两件事：自动检查升级、提交并跟踪反馈。
>
> 目标受众：内网团队 < 100 人。技术栈：Rust + Axum + SQLite，单一二进制。

## 1. 顶层架构

`aaa-hub` 是一个 Rust 单二进制，集成 Axum HTTP 服务、SQLite 持久层、本地静态文件分发、可选 SMTP 出站。

```
┌─────────────── 桌面端 AAA ────────────────┐    HTTPS    ┌─────────── aaa-hub ───────────┐
│ Tauri host                                │            │ Axum 路由                       │
│ ├─ tauri-plugin-updater (官方)            │◀─────────▶│ ├─ /v1/updates/manifest         │
│ │   读 manifest → 校验签名 → 拉产物       │            │ ├─ /v1/updates/artifacts/...    │
│ │   → 替换 → 重启                         │            │ ├─ /v1/feedback                 │
│ ├─ feedback module（自研约 200 行 Rust）  │            │ ├─ /v1/feedback/:id             │
│ │   POST /feedback / GET /feedback/:id    │            │ ├─ /v1/feedback/:id/attach      │
│ │   本地持久化 (ticket_id, claim_token)   │            │ ├─ /healthz                     │
│ └─ React UI: UpdateBanner / FeedbackDialog│            │ └─ /admin/* (HTML + JSON API)   │
└───────────────────────────────────────────┘            └────┬───────────────────────────┘
                                                              │
                                          ┌───────────────────┼──────────────────┐
                                          ▼                   ▼                  ▼
                                       SQLite          artifacts/<ver>/       SMTP（可选）
                                       (单文件)         uploads/<ticket>/      运维邮箱
```

四条不可妥协的原则：

1. **客户端"能连就用，连不上静默"**——所有出站请求失败只记日志，不弹任何 UI 错误。"反馈"按钮在启动后探测失败时灰显，tooltip 一句"无法连接到 hub"。
2. **客户端只承担两件事**：`tauri-plugin-updater` 全权处理升级（下载 / 校验 / 替换 / 重启），自研 `feedback` 模块负责创建 / 查询反馈。前端不接触升级产物字节流。
3. **签名离线**：发布者本地用 `tauri signer sign` 对每个产物签名，私钥永不上服务器。服务端只做静态分发。
4. **存储朴素**：SQLite 单文件 + `artifacts/` + `uploads/` 三个目录。备份 = `tar` 整个数据目录。

## 2. 服务端组件

### 2.1 工程结构

新增 cargo workspace 成员 `tools/aaa/server/`（与 `core/`、`src-tauri/` 平级）：

```
tools/aaa/server/
├── Cargo.toml
├── src/
│   ├── main.rs              # 启动 + tracing 初始化
│   ├── config.rs            # toml 配置加载
│   ├── db.rs                # SQLite 连接池 + migrations
│   ├── routes/
│   │   ├── mod.rs
│   │   ├── updates.rs       # GET /v1/updates/manifest, /artifacts/*
│   │   ├── feedback.rs      # POST/GET/attach
│   │   ├── health.rs        # /healthz
│   │   └── admin.rs         # /admin/* (静态 HTML + JSON API)
│   ├── domain/
│   │   ├── mod.rs
│   │   ├── update.rs        # Manifest, Channel, Artifact
│   │   └── feedback.rs      # Ticket, Status, Attachment
│   ├── notify/
│   │   ├── mod.rs
│   │   └── email.rs         # lettre SMTP 客户端
│   ├── auth.rs              # admin Bearer token + claim token 校验
│   └── error.rs             # AppError → HTTP 状态码
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_feedback_attachments.sql
└── admin-ui/                # 静态 HTML + 少量 vanilla JS（不上 React，避免引入构建链）
    ├── index.html
    ├── feedback.html
    └── releases.html
```

依赖：`axum 0.7`、`tokio`、`sqlx`（sqlite）、`serde`、`serde_json`、`tracing`、`tracing-subscriber`、`tower-http`（CORS、限流、静态文件）、`lettre`（SMTP）、`anyhow`、`thiserror`、`ulid`、`time`、`toml`、`figment`。

### 2.2 配置文件

`/etc/aaa-hub/config.toml`（路径可由 `AAA_HUB_CONFIG` 环境变量覆盖）：

```toml
[server]
bind = "0.0.0.0:8443"
public_url = "https://aaa.example.intranet"
data_dir = "/var/lib/aaa-hub"
admin_token = "REPLACE_ME"             # 长随机字符串

[updates]
artifacts_dir = "/var/lib/aaa-hub/artifacts"
# tauri-plugin-updater 公钥；服务端不持有私钥，仅在 manifest 里签名 url+pubkey 关系
pubkey = "..."

[uploads]
dir = "/var/lib/aaa-hub/uploads"
max_attachment_bytes = 10485760        # 10 MB
allowed_mime = ["image/png", "image/jpeg", "application/zip", "text/plain"]

[notify.email]
enabled = true
smtp_host = "smtp.example.intranet"
smtp_port = 587
smtp_user = "aaa-hub@example.intranet"
smtp_password = "..."
from = "aaa-hub@example.intranet"
to = ["ops@example.intranet", "author@example.intranet"]

[ratelimit]
feedback_per_ip_per_hour = 10
manifest_per_ip_per_minute = 60
```

热更新非必须；改完 systemctl restart 即可。

### 2.3 数据模型（SQLite）

```sql
-- migrations/0001_init.sql
CREATE TABLE feedback (
    id              TEXT PRIMARY KEY,         -- ULID
    claim_token     TEXT NOT NULL,            -- 32 字节 base64url；只在创建时返回一次
    category        TEXT NOT NULL,            -- 'bug' | 'feature' | 'question' | 'other'
    severity        TEXT,                     -- 'blocker' | 'major' | 'minor' | 'trivial' | NULL
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    contact_email   TEXT,
    app_version     TEXT NOT NULL,
    os_info         TEXT NOT NULL,            -- 'linux/ubuntu/22.04/x86_64' 之类
    device_id       TEXT NOT NULL,            -- 客户端匿名 ULID
    log_excerpt     TEXT,                     -- 脱敏后的 warn/error 行
    status          TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'triaged' | 'in_progress' | 'resolved' | 'wontfix'
    admin_note      TEXT,
    created_at      INTEGER NOT NULL,         -- unix ms
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_feedback_status_created ON feedback(status, created_at DESC);
CREATE INDEX idx_feedback_device_id      ON feedback(device_id);

CREATE TABLE feedback_attachment (
    id           TEXT PRIMARY KEY,            -- ULID
    feedback_id  TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    storage_path TEXT NOT NULL,               -- 相对 uploads_dir 的路径
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachment_feedback ON feedback_attachment(feedback_id);

-- 注意：升级数据不进库。manifest 在请求时从文件系统现读现拼。
-- "当前最新版本" 由 artifacts_dir 下文件名最大版本号决定。
```

不引入 channel 表；当前只有单一通道。后续要加 stable/beta，在 `artifacts/` 下分子目录即可，不动 schema。

### 2.4 路由表

| Method | 路径                                | 鉴权        | 说明                                                                                                   |
|--------|-------------------------------------|-------------|--------------------------------------------------------------------------------------------------------|
| GET    | `/healthz`                          | 无          | 200 + JSON `{"status":"ok","version":"..."}`，客户端探测用                                              |
| GET    | `/v1/updates/manifest`              | 无          | 返回 tauri-plugin-updater 期望的 JSON：`version`、`pub_date`、各平台 `url` + `signature`               |
| GET    | `/v1/updates/artifacts/{file}`      | 无          | 静态分发产物（deb/AppImage/MSI/NSIS）和对应 `.sig` 文件                                                |
| POST   | `/v1/feedback`                      | 无          | multipart 或 JSON 提交一条新反馈，返回 `{ticket_id, claim_token}`                                       |
| GET    | `/v1/feedback/{id}?token={claim}`   | claim token | 返回该 ticket 当前状态、admin_note、附件列表                                                           |
| POST   | `/v1/feedback/{id}/attach`          | claim token | 单独追加附件（提交后想补图片用）                                                                        |
| GET    | `/admin/`                           | admin token | Admin 单页（HTML），列出反馈、改状态、上传发布                                                         |
| GET    | `/admin/api/feedback`               | admin token | 列表 + 过滤 + 分页                                                                                     |
| PATCH  | `/admin/api/feedback/{id}`          | admin token | 改 status / admin_note                                                                                  |
| GET    | `/admin/api/feedback/{id}/attachment/{aid}` | admin token | 下载附件原文件                                                                                |
| POST   | `/admin/api/releases`               | admin token | multipart 上传：`version` + 一组产物文件 + 对应 `.sig`，落盘到 `artifacts/<version>/`，自动成为最新版本 |

鉴权细节：
- `admin_token`：`Authorization: Bearer <token>`，与配置文件的 `admin_token` 比对（恒定时比较，避免 timing attack）。
- `claim_token`：作为查询参数 `?token=` 或 header `X-Claim-Token`。匿名 + 持有 token 即可。
- 限流：靠 `tower-http` 的 governor 中间件按 IP 桶，配置见 2.2。

### 2.5 manifest 生成逻辑

服务端不自己签名，只在 `/v1/updates/manifest` 把"当前最新版本"和"对应平台产物的 URL + 离线已生成的 .sig 内容"拼在一起返回：

1. 启动时扫一遍 `artifacts_dir`，把每个 `<version>/` 子目录解析成 `(version, platform → (artifact_file, sig_file))`。版本比较走 semver。
2. 每次请求 `/v1/updates/manifest`：取最大版本号目录，读取对应平台的 `.sig` 内容（短文本），返回如下 JSON：

```json
{
  "version": "0.9.0",
  "pub_date": "2026-06-12T03:00:00Z",
  "notes": "见应用内 About",
  "platforms": {
    "linux-x86_64": {
      "url": "https://aaa.example.intranet/v1/updates/artifacts/0.9.0/AAA_0.9.0_amd64.AppImage",
      "signature": "<.sig 文件内容>"
    },
    "windows-x86_64": {
      "url": "https://aaa.example.intranet/v1/updates/artifacts/0.9.0/AAA_0.9.0_x64-setup.exe",
      "signature": "<.sig 文件内容>"
    }
  }
}
```

3. Admin 上传新版本后 invalidate 一个内存缓存即可，不必重启。

发布流程：
1. 打包机跑 `build-release.sh` / `build-release.ps1` 出全套产物。
2. 本地用项目仓库里的 tauri 私钥跑 `tauri signer sign <artifact>` 生成 `.sig`。
3. Admin Web `/admin/` 里"上传发布"，选版本号 + 拖入产物 + .sig，hub 落盘到 `artifacts/<version>/`。私钥不离开发布者机器。

### 2.6 反馈通知

提交成功后异步触发 `notify::email::send`：
- SMTP 走 `lettre`，TLS / STARTTLS 由 host 配置决定。
- 发送失败 retry 3 次（指数退避），最终失败只 `tracing::warn!`，不影响 200 返回。
- 邮件正文包含：ticket id、category/severity、title、description 前 500 字、app_version、os_info、admin URL `https://hub/admin/feedback?id=<id>`。
- Admin 状态变更**不**触发邮件（避免循环骚扰）。

## 3. 客户端改造

### 3.1 项目改动面

| 位置 | 改动 |
|------|------|
| `src-tauri/Cargo.toml` | 新增 `tauri-plugin-updater = "2"`、`reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "multipart"] }` |
| `src-tauri/tauri.conf.json` | 新增 `plugins.updater` 字段：`endpoints = ["https://aaa.example.intranet/v1/updates/manifest"]`，`pubkey = "..."` |
| `src-tauri/src/lib.rs` | `.plugin(tauri_plugin_updater::Builder::new().build())`；初始化 `HubClient` 并放进 state |
| `src-tauri/src/commands.rs` | 新增 `hub_status / check_update / submit_feedback / get_feedback / device_id` 五个命令 |
| `src-tauri/src/hub.rs`（新增） | `HubClient`：reqwest 客户端 + 端点拼接 + 失败静默 + tracing 记录 |
| `core/src/settings.rs` | `AppSettings` 新增字段：`hub: HubSettings { base_url, device_id }`；首次启动生成 ULID 落盘 |
| `core/src/feedback.rs`（新增） | 本地状态：保存 `Vec<LocalTicket { id, claim_token, title, created_at }>`，独立文件 `~/.config/aaa/tickets.json`（与 settings.json 同目录，权限 0600） |
| `core/src/log_buffer.rs`（新增） | 进程内环形缓冲，容量 200 行，仅收 `WARN`/`ERROR`。通过 `tracing-subscriber` 自定义 Layer 注入。**不**新增磁盘日志文件 |
| `core/src/log_excerpt.rs`（新增） | 从 `log_buffer` 取出当前内容，用正则脱敏邮箱 / 绝对路径 / IP / token |
| `src/components/UpdateBanner.tsx`（新增） | tauri-plugin-updater 事件触发 → 顶部横条提示"有新版本，点此安装" |
| `src/components/FeedbackDialog.tsx`（新增） | 表单 + 自动附带预览面板 |
| `src/components/FeedbackList.tsx`（新增） | 设置里"我的反馈"标签页，列出本机历史 ticket + 当前状态 |
| `src/api.ts` | 包装 5 个新命令 |
| `src/App.tsx` | 顶层探测 `hub_status`，结果传给 Toolbar 决定反馈按钮是否灰显 |

### 3.2 探测、升级、反馈三条流

**A. 探测连通性**（应用启动一次 + 每 30 分钟一次后台轮询）：

```
hub_status() in Rust:
    timeout 3s GET <hub.base_url>/healthz
    → ok → cache state = Connected
    → fail → tracing::info!("hub unreachable: {err}"), state = Disconnected
    永不 Err，永不 panic，前端拿到的就是 Connected | Disconnected
```

UI 反应：仅控制反馈按钮 disabled + tooltip。**不**显示任何错误 toast / 弹窗。

**B. 自动升级**：

- 启动后 5 秒由 `tauri_plugin_updater::UpdaterExt::check()` 拉 manifest。
- 有新版本：触发 `update-available` 事件 → React 顶部出现 `UpdateBanner`：「v0.9.0 可用 · 立即安装 / 稍后」。
- 用户点"立即安装"：plugin 下载 → 验签 → 替换 → 提示重启。整个过程 plugin 自带 progress 事件，UI 显示进度条。
- 任何失败（网络、签名、磁盘）：`tracing::warn!` + Banner 静默消失。**不**给用户看错误。

**C. 提交反馈**：

UI 流：
1. Toolbar"反馈"按钮（连不上时灰显）→ 打开 `FeedbackDialog`。
2. 表单字段：
   - **必填**：分类（select：bug / feature / question / other）、标题（input，≤80 字）、详细描述（textarea）。
   - **选填**：严重程度（select：blocker / major / minor / trivial）、联系邮箱（input）、截图（拖入 / 选择 PNG/JPG，可多张，每张 ≤ 10 MB）。
3. **提交前预览面板**（默认折叠）：
   - 应用版本号 ✓ 可取消
   - 操作系统信息 ✓ 可取消
   - 近期日志摘要 ✓ 可取消（点击展开看到将要发送的内容，已脱敏）
   - 客户端设备 id（匿名 ULID）✓ 可取消
4. 提交：multipart POST `/v1/feedback` → 拿到 `{ticket_id, claim_token}` → 本地 `tickets.json` 追加一条 → 关闭对话框，状态栏"反馈已提交：#<ticket_id 短前缀>"。
5. 提交失败：`tracing::warn!` + 状态栏"反馈未送达，已留存草稿"。**草稿保留在内存里**，直到下次 hub 重新可达再后台重试一次。

**反馈状态回查**（设置里"我的反馈"页签）：
- 进入该页签时，对每个本地 `tickets.json` 条目并发 `GET /v1/feedback/:id?token=...`。
- 返回 200 → 列表显示状态 + admin_note。
- 返回 404 / 网络失败 → 显示"未知"灰字，不报错。

### 3.3 日志摘要脱敏

`core/src/log_excerpt.rs::collect()`：
1. 从 `log_buffer`（进程内环形缓冲，容量 200 行 WARN/ERROR）拷贝出当前内容。
2. 用正则替换：邮箱 → `<email>`，绝对路径 `/home/<user>/...` → `/home/<redacted>/...`，IPv4/IPv6 → `<ip>`，连续 32+ 位 hex/base64 → `<token>`。
3. 截到 64 KB，超出尾部截断并加 `... (truncated)`。
4. 返回字符串供 UI 预览 + 提交。

## 4. 错误处理

**服务端**：
- `AppError` 枚举（`NotFound` / `Unauthorized` / `BadRequest(String)` / `RateLimited` / `Internal(anyhow::Error)`）实现 `IntoResponse`，对应 4xx/5xx + JSON `{error, message}`。
- `tracing` 全链路结构化日志：每条请求一条 INFO，错误一条 WARN/ERROR，含 `request_id`（中间件注入）。
- panic safety：`tower-http::CatchPanic`，进程不挂。
- SQLite 用 `WAL` 模式，单写多读够用。

**客户端**：
- `HubClient` 所有方法返回 `Result<T, HubError>`；`HubError` 仅在内部使用，不会冒泡到 UI。
- Tauri command 包装：失败统一返回 `Ok(SilentFailure)` 或 `Ok(None)`，前端永远拿不到 `Err`。
- 唯一例外：用户主动点"提交反馈"时，按钮区给一行小字"反馈未送达，已留存草稿"——这不是 toast，是状态栏。

## 5. 测试

**服务端**（`tools/aaa/server/tests/`）：
- 集成测试用 `axum::test` + 临时 SQLite + 临时 `data_dir`：
  - `feedback_lifecycle`：POST → 拿 token → GET 自查 → 错 token GET 401 → admin PATCH 改状态 → claim GET 看到新状态。
  - `manifest_picks_latest`：放 0.8.0 / 0.8.1 / 0.9.0 三套 artifacts，断言返回 0.9.0。
  - `manifest_missing_signature`：缺 `.sig` → 平台从 manifest 中省略，不 500。
  - `attachment_size_limit`：超 10 MB 返回 413。
  - `ratelimit_feedback`：第 11 次 POST 返回 429。
  - `admin_auth`：缺/错 admin token 返回 401。
- 邮件通知用 `lettre` 的 `StubTransport` 断言被调用。

**客户端**：
- `core/src/log_excerpt.rs` 单元测试：脱敏正则覆盖 email / 绝对路径 / IP / 长 token。
- `core/src/feedback.rs` 单元测试：tickets.json 读写 + 并发安全。
- `src-tauri/src/hub.rs` 用 `wiremock` 起本地 HTTP，覆盖：超时、5xx、200、401。每条都断言"不返回 Err 给前端"。

## 6. 部署

`aaa-hub` 单二进制：

```
sudo useradd -r -s /usr/sbin/nologin aaa-hub
sudo install -m 755 aaa-hub /usr/local/bin/
sudo install -d -o aaa-hub /var/lib/aaa-hub /var/lib/aaa-hub/artifacts /var/lib/aaa-hub/uploads
sudo install -m 600 -o aaa-hub config.toml /etc/aaa-hub/config.toml
sudo install -m 644 aaa-hub.service /etc/systemd/system/
sudo systemctl enable --now aaa-hub
```

`aaa-hub.service` 走标准 systemd 单元；前端 nginx 反代 + Let's Encrypt（或公司内网 CA）。

备份：`tar -czf backup.tar.gz /var/lib/aaa-hub` 即可。

## 7. 后续可选演进（明确不进当前 spec）

- stable / beta 多通道
- 灰度发布（按 device_id 哈希 % 100）
- IM 机器人通知（企微 / 飞书 / Slack webhook）
- 用户主动认领账号体系（邮箱登录看历史所有反馈）
- 升级产物 CDN 化

这些都不动当前 schema 即可后增。

## 8. 提交约束（按 CLAUDE.md）

服务端代码进 cargo workspace，但 **桌面端版本号语义不变**：每次 commit 仍同步 bump `package.json` / `tauri.conf.json` / `src-tauri/Cargo.toml` / `core/Cargo.toml` 的版本字段，并追加 `release-notes.txt`。`server/Cargo.toml` 的版本独立维护，初始 `0.1.0`。

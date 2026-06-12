# aaa-hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `aaa-hub` (Rust/Axum/SQLite server) plus AAA desktop client integration so the desktop app silently checks for updates via tauri-plugin-updater and lets users submit & track anonymous feedback tickets.

**Architecture:** Single Rust binary `aaa-hub` exposes `/v1/updates/manifest` (signed manifest for tauri-plugin-updater), `/v1/updates/artifacts/*` (static serve), `/v1/feedback*` (anonymous ticket CRUD with claim tokens), and `/admin/*` (Bearer-auth admin UI + JSON API). Desktop client adds an in-process tracing buffer for log excerpts, a `HubClient` wrapping reqwest, three React components (UpdateBanner / FeedbackDialog / FeedbackList), and follows the "fail silently" rule: every network failure is logged, never surfaced as a UI error; the feedback button greys out when the hub is unreachable.

**Tech Stack:**
- Server: Rust 1.75+, Axum 0.7, sqlx 0.8 (SQLite, runtime-tokio-rustls), tokio, tower-http, tracing, lettre, figment, governor (rate limit), ulid, time
- Client additions: tauri-plugin-updater 2, reqwest 0.12 (rustls-tls), tracing layer (custom in-process buffer)
- Admin UI: vanilla HTML + a small inline JS module (no React, no build step)
- Spec: `docs/aaa-hub-update-feedback-server-design.md`

---

## File Structure

**New crate `tools/aaa/server/`:**

```
tools/aaa/server/
├── Cargo.toml
├── migrations/
│   └── 0001_init.sql
├── src/
│   ├── main.rs               # binary entry
│   ├── lib.rs                # re-export modules + build_router for tests
│   ├── config.rs             # Config loader (figment: toml + env)
│   ├── state.rs              # AppState (db pool, config, mailer)
│   ├── error.rs              # AppError + IntoResponse
│   ├── auth.rs               # admin Bearer + claim token extractors
│   ├── db.rs                 # SqlitePool + migrate
│   ├── domain/
│   │   ├── mod.rs
│   │   ├── feedback.rs       # Feedback, Status, Severity, NewFeedback
│   │   └── update.rs         # ManifestPlatform, scan_artifacts
│   ├── routes/
│   │   ├── mod.rs            # build_router()
│   │   ├── health.rs
│   │   ├── feedback.rs       # POST /v1/feedback, GET /v1/feedback/:id, attach
│   │   ├── updates.rs        # GET /v1/updates/manifest, /v1/updates/artifacts/*
│   │   └── admin.rs          # /admin/api/* + static HTML
│   └── notify/
│       ├── mod.rs
│       └── email.rs          # lettre transport
├── admin-ui/
│   └── index.html            # single-page admin (lists feedback, releases tab)
└── tests/
    ├── common/mod.rs         # shared test harness (temp data dir, http client)
    ├── health.rs
    ├── feedback_lifecycle.rs
    ├── attachments.rs
    ├── manifest.rs
    ├── ratelimit.rs
    └── admin.rs
```

**Client changes (existing files modified, new files created):**

```
tools/aaa/
├── Cargo.toml                # add server to workspace members
├── src-tauri/
│   ├── Cargo.toml            # +tauri-plugin-updater, +reqwest
│   ├── tauri.conf.json       # +plugins.updater config
│   └── src/
│       ├── lib.rs            # register updater plugin + HubClient state + log layer
│       ├── commands.rs       # +5 commands: hub_status, check_update, submit_feedback,
│       │                     #              get_feedback_status, list_local_tickets
│       ├── hub.rs            # NEW: HubClient (reqwest + silent fail + tracing)
│       └── log_layer.rs      # NEW: tracing-subscriber Layer → core::log_buffer
├── core/
│   ├── Cargo.toml            # +regex, +ulid (already there)
│   └── src/
│       ├── lib.rs            # pub mod feedback; pub mod log_buffer; pub mod log_excerpt;
│       ├── settings.rs       # +HubSettings { base_url, device_id }
│       ├── feedback.rs       # NEW: LocalTicket persistence (~/.config/aaa/tickets.json)
│       ├── log_buffer.rs     # NEW: in-process ring buffer (200 lines, WARN+ERROR)
│       └── log_excerpt.rs    # NEW: redact + format excerpt
└── src/
    ├── api.ts                # +5 wrappers
    ├── types.ts              # +HubStatus, +FeedbackDraft, +LocalTicket, +TicketStatus
    ├── App.tsx               # poll hub_status, pass to Toolbar
    ├── components/
    │   ├── Toolbar.tsx       # disable Feedback btn when disconnected
    │   ├── UpdateBanner.tsx  # NEW
    │   ├── FeedbackDialog.tsx# NEW
    │   └── FeedbackList.tsx  # NEW (tab inside SettingsDialog)
    └── components/SettingsDialog.tsx  # +"我的反馈" tab
```

---

## Task Index

Execute tasks in numeric order. Each task is independently committable; commit on the final step of every task.

| # | Task | Layer |
|---|------|-------|
| 1 | Server scaffold: cargo workspace member + main.rs + healthz | server |
| 2 | Config loading (figment) | server |
| 3 | DB pool + migrations | server |
| 4 | Feedback domain + POST /v1/feedback | server |
| 5 | GET /v1/feedback/:id with claim token | server |
| 6 | POST /v1/feedback/:id/attach (multipart) | server |
| 7 | Updates: artifacts scan + GET /v1/updates/manifest | server |
| 8 | Static serve /v1/updates/artifacts/* | server |
| 9 | Admin auth + JSON API (list / patch / download attachment) | server |
| 10 | Admin: POST /admin/api/releases (publish) | server |
| 11 | Admin static HTML | server |
| 12 | Rate limiting | server |
| 13 | Email notification (lettre) | server |
| 14 | Workspace hookup + version bump (server v0.1.0) | server |
| 15 | core::log_buffer + log_excerpt | client/core |
| 16 | core::feedback (LocalTicket persistence) | client/core |
| 17 | core::settings.HubSettings + device_id | client/core |
| 18 | src-tauri: HubClient + log_layer plumbing | client/host |
| 19 | src-tauri: 5 new Tauri commands | client/host |
| 20 | src-tauri: tauri-plugin-updater wiring | client/host |
| 21 | UI: api.ts + types.ts wrappers | client/ui |
| 22 | UI: hub_status polling + Toolbar disabled state | client/ui |
| 23 | UI: UpdateBanner | client/ui |
| 24 | UI: FeedbackDialog | client/ui |
| 25 | UI: FeedbackList (settings tab) | client/ui |
| 26 | Version bump + release notes for client integration | client |

---

## Task 1: Server scaffold + healthz

**Files:**
- Create: `tools/aaa/server/Cargo.toml`
- Create: `tools/aaa/server/src/main.rs`
- Create: `tools/aaa/server/src/lib.rs`
- Create: `tools/aaa/server/src/routes/mod.rs`
- Create: `tools/aaa/server/src/routes/health.rs`
- Create: `tools/aaa/server/tests/health.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "aaa-hub"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "aaa-hub"
path = "src/main.rs"

[lib]
name = "aaa_hub"
path = "src/lib.rs"

[dependencies]
axum = { version = "0.7", features = ["multipart", "macros"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "signal", "fs"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "fs", "limit"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "macros", "migrate", "time"] }
anyhow = "1"
thiserror = "2"
ulid = { version = "1", features = ["serde"] }
time = { version = "0.3", features = ["serde", "formatting"] }
figment = { version = "0.10", features = ["toml", "env"] }
lettre = { version = "0.11", default-features = false, features = ["tokio1-rustls-tls", "smtp-transport", "builder"] }
governor = "0.7"
mime_guess = "2"
sha2 = "0.10"
hex = "0.4"
base64 = "0.22"

[dev-dependencies]
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "multipart"] }
tempfile = "3"
tokio = { version = "1", features = ["test-util"] }
```

- [ ] **Step 2: Create lib.rs**

```rust
pub mod routes;

use axum::Router;

pub fn build_router() -> Router {
    Router::new().merge(routes::health::router())
}
```

- [ ] **Step 3: Create routes/mod.rs**

```rust
pub mod health;
```

- [ ] **Step 4: Write the failing health test** in `tests/health.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

#[tokio::test]
async fn health_returns_ok() {
    let app = aaa_hub::build_router();
    let res = app
        .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert!(json["version"].is_string());
}
```

- [ ] **Step 5: Run the test to confirm it fails**

```bash
cd tools/aaa/server && cargo test --test health
```

Expected: compile error, `routes::health` not found.

- [ ] **Step 6: Implement routes/health.rs**

```rust
use axum::{routing::get, Json, Router};
use serde_json::json;

pub fn router() -> Router {
    Router::new().route("/healthz", get(handler))
}

async fn handler() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
```

- [ ] **Step 7: Re-run test, expect PASS**

```bash
cargo test --test health
```

- [ ] **Step 8: Implement main.rs binary**

```rust
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let app = aaa_hub::build_router();
    let addr: SocketAddr = "127.0.0.1:8443".parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 9: Verify it builds** with `cargo build`.

- [ ] **Step 10: Commit**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): scaffold aaa-hub server with healthz endpoint"
```

---

## Task 2: Config loading

**Files:**
- Create: `tools/aaa/server/src/config.rs`
- Modify: `tools/aaa/server/src/lib.rs`
- Create: `tools/aaa/server/tests/config.rs`

- [ ] **Step 1: Write the failing test** in `tests/config.rs`:

```rust
use aaa_hub::config::Config;
use std::io::Write;
use tempfile::NamedTempFile;

#[test]
fn loads_config_from_toml() {
    let mut f = NamedTempFile::new().unwrap();
    writeln!(f, r#"
[server]
bind = "0.0.0.0:9999"
public_url = "https://example.test"
data_dir = "/tmp/aaa-hub-test"
admin_token = "secret"

[updates]
artifacts_dir = "/tmp/aaa-hub-test/artifacts"
pubkey = "PUB"

[uploads]
dir = "/tmp/aaa-hub-test/uploads"
max_attachment_bytes = 1024
allowed_mime = ["image/png"]

[notify.email]
enabled = false
smtp_host = ""
smtp_port = 0
smtp_user = ""
smtp_password = ""
from = ""
to = []

[ratelimit]
feedback_per_ip_per_hour = 10
manifest_per_ip_per_minute = 60
"#).unwrap();
    let cfg = Config::load_from(f.path()).unwrap();
    assert_eq!(cfg.server.bind, "0.0.0.0:9999");
    assert_eq!(cfg.uploads.max_attachment_bytes, 1024);
    assert!(!cfg.notify.email.enabled);
}
```

- [ ] **Step 2: Run test to verify it fails** (`cargo test --test config`).

- [ ] **Step 3: Implement config.rs**

```rust
use std::path::{Path, PathBuf};
use serde::Deserialize;
use figment::{Figment, providers::{Format, Toml, Env}};

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub server: Server,
    pub updates: Updates,
    pub uploads: Uploads,
    pub notify: Notify,
    pub ratelimit: RateLimit,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Server {
    pub bind: String,
    pub public_url: String,
    pub data_dir: PathBuf,
    pub admin_token: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Updates {
    pub artifacts_dir: PathBuf,
    pub pubkey: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Uploads {
    pub dir: PathBuf,
    pub max_attachment_bytes: u64,
    pub allowed_mime: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Notify {
    pub email: EmailNotify,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EmailNotify {
    pub enabled: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub from: String,
    pub to: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimit {
    pub feedback_per_ip_per_hour: u32,
    pub manifest_per_ip_per_minute: u32,
}

impl Config {
    pub fn load_from(path: &Path) -> anyhow::Result<Self> {
        let cfg: Config = Figment::new()
            .merge(Toml::file(path))
            .merge(Env::prefixed("AAA_HUB_").split("__"))
            .extract()?;
        Ok(cfg)
    }
}
```

- [ ] **Step 4: Add `pub mod config;` to lib.rs** and re-run test, expect PASS.

- [ ] **Step 5: Wire config into main.rs**

```rust
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg_path = std::env::var("AAA_HUB_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/etc/aaa-hub/config.toml"));
    let cfg = aaa_hub::config::Config::load_from(&cfg_path)?;
    let app = aaa_hub::build_router();
    let listener = tokio::net::TcpListener::bind(&cfg.server.bind).await?;
    tracing::info!(bind = %cfg.server.bind, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 6: cargo build** to verify, then commit.

```bash
git add tools/aaa/server/
git commit -m "feat(hub): toml + env config loader"
```

---

## Task 3: DB pool + migrations

**Files:**
- Create: `tools/aaa/server/migrations/0001_init.sql`
- Create: `tools/aaa/server/src/db.rs`
- Create: `tools/aaa/server/src/state.rs`
- Modify: `tools/aaa/server/src/lib.rs`
- Create: `tools/aaa/server/tests/db.rs`

- [ ] **Step 1: Create migration file `migrations/0001_init.sql`**

```sql
CREATE TABLE feedback (
    id              TEXT PRIMARY KEY,
    claim_token     TEXT NOT NULL,
    category        TEXT NOT NULL,
    severity        TEXT,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    contact_email   TEXT,
    app_version     TEXT NOT NULL,
    os_info         TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    log_excerpt     TEXT,
    status          TEXT NOT NULL DEFAULT 'new',
    admin_note      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_feedback_status_created ON feedback(status, created_at DESC);
CREATE INDEX idx_feedback_device_id      ON feedback(device_id);

CREATE TABLE feedback_attachment (
    id           TEXT PRIMARY KEY,
    feedback_id  TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachment_feedback ON feedback_attachment(feedback_id);
```

- [ ] **Step 2: Write the failing test** in `tests/db.rs`:

```rust
use aaa_hub::db;
use sqlx::Row;

#[tokio::test]
async fn pool_runs_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = db::open(&db_path).await.unwrap();
    let row = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("name"), "feedback");
}
```

- [ ] **Step 3: Run test, expect compile error.**

- [ ] **Step 4: Implement db.rs**

```rust
use std::path::Path;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

pub async fn open(path: &Path) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

- [ ] **Step 5: Add `pub mod db;` to lib.rs** and re-run test, expect PASS.

- [ ] **Step 6: Implement state.rs**

```rust
use crate::config::Config;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: SqlitePool,
}
```

Add `pub mod state;` to lib.rs.

- [ ] **Step 7: Wire into main.rs** — open the pool, build state:

```rust
let db_path = cfg.server.data_dir.join("aaa-hub.db");
let pool = aaa_hub::db::open(&db_path).await?;
let state = aaa_hub::state::AppState { cfg: std::sync::Arc::new(cfg.clone()), db: pool };
let app = aaa_hub::build_router_with(state);
```

Update `lib.rs::build_router` signature to accept state. Initially just keep healthz unchanged — pass-through state is fine:

```rust
pub fn build_router_with(state: state::AppState) -> axum::Router {
    axum::Router::new()
        .merge(routes::health::router())
        .with_state(state)
}
```

Make health::router() use `Router::<AppState>::new()` typed appropriately (or leave it stateless and merge before `.with_state`).

- [ ] **Step 8: cargo build && cargo test**, all green, commit.

```bash
git add tools/aaa/server/migrations tools/aaa/server/src tools/aaa/server/tests/db.rs
git commit -m "feat(hub): sqlite pool + migrations + AppState"
```

---

## Task 4: Feedback domain + POST /v1/feedback

**Files:**
- Create: `tools/aaa/server/src/error.rs`
- Create: `tools/aaa/server/src/domain/mod.rs`
- Create: `tools/aaa/server/src/domain/feedback.rs`
- Create: `tools/aaa/server/src/routes/feedback.rs`
- Modify: `tools/aaa/server/src/routes/mod.rs`
- Modify: `tools/aaa/server/src/lib.rs`
- Create: `tools/aaa/server/tests/common/mod.rs`
- Create: `tools/aaa/server/tests/feedback_create.rs`

- [ ] **Step 1: Implement error.rs**

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("rate limited")]
    RateLimited,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self { AppError::Internal(e.into()) }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too large".to_string()),
            AppError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate limited".to_string()),
            AppError::Internal(e) => {
                tracing::error!(error=?e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({"error": status.as_u16(), "message": msg}))).into_response()
    }
}
```

Add `pub mod error;` to lib.rs.

- [ ] **Step 2: Implement domain/feedback.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category { Bug, Feature, Question, Other }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity { Blocker, Major, Minor, Trivial }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status { New, Triaged, InProgress, Resolved, Wontfix }

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::New => "new", Status::Triaged => "triaged",
            Status::InProgress => "in_progress",
            Status::Resolved => "resolved", Status::Wontfix => "wontfix",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct NewFeedback {
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

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub ticket_id: String,
    pub claim_token: String,
}
```

Add `pub mod domain;` to lib.rs and `pub mod feedback;` to `domain/mod.rs`.

- [ ] **Step 3: Build common test harness `tests/common/mod.rs`**

```rust
use aaa_hub::{config::*, state::AppState};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

pub struct Harness {
    pub dir: TempDir,
    pub state: AppState,
}

pub async fn make() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        server: Server {
            bind: "127.0.0.1:0".into(),
            public_url: "http://test.local".into(),
            data_dir: dir.path().to_path_buf(),
            admin_token: "TEST_ADMIN".into(),
        },
        updates: Updates {
            artifacts_dir: dir.path().join("artifacts"),
            pubkey: "PUBKEY".into(),
        },
        uploads: Uploads {
            dir: dir.path().join("uploads"),
            max_attachment_bytes: 1024 * 1024,
            allowed_mime: vec!["image/png".into(), "image/jpeg".into()],
        },
        notify: Notify { email: EmailNotify {
            enabled: false, smtp_host: "".into(), smtp_port: 0,
            smtp_user: "".into(), smtp_password: "".into(),
            from: "".into(), to: vec![],
        }},
        ratelimit: RateLimit { feedback_per_ip_per_hour: 1000, manifest_per_ip_per_minute: 1000 },
    };
    std::fs::create_dir_all(&cfg.uploads.dir).unwrap();
    std::fs::create_dir_all(&cfg.updates.artifacts_dir).unwrap();
    let pool = aaa_hub::db::open(&dir.path().join("test.db")).await.unwrap();
    let state = AppState { cfg: Arc::new(cfg), db: pool };
    Harness { dir, state }
}
```

- [ ] **Step 4: Write the failing test** in `tests/feedback_create.rs`:

```rust
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_feedback_returns_ticket_and_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let payload = json!({
        "category": "bug",
        "title": "X crashes on startup",
        "description": "details...",
        "app_version": "0.8.1",
        "os_info": "linux/ubuntu/22.04/x86_64",
        "device_id": "01HXYZ"
    });
    let res = app.oneshot(Request::builder()
        .method("POST")
        .uri("/v1/feedback")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string())).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert!(body["ticket_id"].as_str().unwrap().len() == 26);
    assert!(body["claim_token"].as_str().unwrap().len() >= 32);
}
```

- [ ] **Step 5: Run, expect failure.**

- [ ] **Step 6: Implement routes/feedback.rs**

```rust
use crate::domain::feedback::*;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use rand::RngCore;
use ulid::Ulid;

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/feedback", post(create))
}

async fn create(
    State(s): State<AppState>,
    Json(input): Json<NewFeedback>,
) -> Result<(StatusCode, Json<CreateResponse>), AppError> {
    if input.title.trim().is_empty() || input.title.len() > 80 {
        return Err(AppError::BadRequest("title length 1..=80".into()));
    }
    if input.description.trim().is_empty() {
        return Err(AppError::BadRequest("description required".into()));
    }
    let id = Ulid::new().to_string();
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let claim = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let category = serde_json::to_string(&input.category).unwrap().trim_matches('"').to_string();
    let severity = input.severity.map(|sv| serde_json::to_string(&sv).unwrap().trim_matches('"').to_string());
    sqlx::query(r#"INSERT INTO feedback(id, claim_token, category, severity, title, description,
        contact_email, app_version, os_info, device_id, log_excerpt, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)"#)
        .bind(&id).bind(&claim).bind(&category).bind(severity)
        .bind(&input.title).bind(&input.description)
        .bind(&input.contact_email).bind(&input.app_version)
        .bind(&input.os_info).bind(&input.device_id)
        .bind(&input.log_excerpt).bind(now).bind(now)
        .execute(&s.db).await?;
    tracing::info!(ticket = %id, "feedback created");
    Ok((StatusCode::CREATED, Json(CreateResponse { ticket_id: id, claim_token: claim })))
}
```

Add `rand = "0.8"` to Cargo.toml. Wire `pub mod feedback;` in `routes/mod.rs` and merge in `build_router_with`.

- [ ] **Step 7: Run test, expect PASS.**

- [ ] **Step 8: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): POST /v1/feedback with claim token issuance"
```

---

## Task 5: GET /v1/feedback/:id with claim token

**Files:**
- Modify: `tools/aaa/server/src/routes/feedback.rs`
- Create: `tools/aaa/server/tests/feedback_get.rs`

- [ ] **Step 1: Write the failing test** `tests/feedback_get.rs`:

```rust
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

async fn create_one(app: &axum::Router) -> (String, String) {
    let payload = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    });
    let res = app.clone().oneshot(Request::builder().method("POST")
        .uri("/v1/feedback").header("content-type","application/json")
        .body(Body::from(payload.to_string())).unwrap()).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    (body["ticket_id"].as_str().unwrap().into(),
     body["claim_token"].as_str().unwrap().into())
}

#[tokio::test]
async fn get_feedback_with_correct_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let res = app.oneshot(Request::builder()
        .uri(format!("/v1/feedback/{}?token={}", id, token))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["status"], "new");
    assert_eq!(body["title"], "t");
}

#[tokio::test]
async fn get_feedback_with_wrong_token_is_unauthorized() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, _) = create_one(&app).await;
    let res = app.oneshot(Request::builder()
        .uri(format!("/v1/feedback/{}?token=WRONG", id))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_unknown_feedback_returns_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder()
        .uri("/v1/feedback/01HXNOTREAL?token=x").body(Body::empty()).unwrap())
        .await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}
```

- [ ] **Step 2: Run, expect failures (route missing).**

- [ ] **Step 3: Add the GET handler** to `routes/feedback.rs`:

```rust
use axum::extract::{Path, Query};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ClaimQuery { pub token: String }

#[derive(Serialize)]
pub struct FeedbackView {
    pub id: String,
    pub status: String,
    pub category: String,
    pub severity: Option<String>,
    pub title: String,
    pub description: String,
    pub admin_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attachments: Vec<AttachmentView>,
}

#[derive(Serialize)]
pub struct AttachmentView {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub bytes: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/feedback", post(create))
        .route("/v1/feedback/:id", axum::routing::get(get_one))
}

async fn get_one(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ClaimQuery>,
) -> Result<Json<FeedbackView>, AppError> {
    let row = sqlx::query("SELECT * FROM feedback WHERE id = ?")
        .bind(&id).fetch_optional(&s.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    let stored: String = row.try_get("claim_token").map_err(|e| AppError::Internal(e.into()))?;
    if !ct_eq(stored.as_bytes(), q.token.as_bytes()) {
        return Err(AppError::Unauthorized);
    }
    let view = FeedbackView {
        id: row.try_get("id")?, status: row.try_get("status")?,
        category: row.try_get("category")?, severity: row.try_get("severity")?,
        title: row.try_get("title")?, description: row.try_get("description")?,
        admin_note: row.try_get("admin_note")?,
        created_at: row.try_get("created_at")?, updated_at: row.try_get("updated_at")?,
        attachments: vec![],
    };
    Ok(Json(view))
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) { diff |= x ^ y; }
    diff == 0
}
```

Add `use sqlx::Row;` at the top. Map `sqlx::Error` via the existing `From` impl in `error.rs`.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): GET /v1/feedback/:id with claim token guard"
```

---

## Task 6: POST /v1/feedback/:id/attach (multipart)

**Files:**
- Modify: `tools/aaa/server/src/routes/feedback.rs`
- Modify: `tools/aaa/server/src/domain/feedback.rs` (add Attachment row helpers)
- Create: `tools/aaa/server/tests/attachments.rs`

- [ ] **Step 1: Write failing tests** in `tests/attachments.rs`:

```rust
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use serde_json::json;
use tower::ServiceExt;

async fn create_one(app: &axum::Router) -> (String, String) {
    let payload = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    });
    let res = app.clone().oneshot(Request::builder().method("POST")
        .uri("/v1/feedback").header("content-type","application/json")
        .body(Body::from(payload.to_string())).unwrap()).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    (body["ticket_id"].as_str().unwrap().into(),
     body["claim_token"].as_str().unwrap().into())
}

fn multipart_png(filename: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = "----X";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n", filename).as_bytes());
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    (format!("multipart/form-data; boundary={}", boundary), body)
}

#[tokio::test]
async fn attach_png_succeeds() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let (ct, body) = multipart_png("a.png", b"\x89PNG\r\n\x1a\nfake");
    let res = app.oneshot(Request::builder().method("POST")
        .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body)).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn attach_oversize_returns_413() {
    let h = common::make().await;
    // shrink limit
    let mut cfg = (*h.state.cfg).clone();
    cfg.uploads.max_attachment_bytes = 4;
    let mut state = h.state.clone();
    state.cfg = std::sync::Arc::new(cfg);
    let app = aaa_hub::build_router_with(state);
    let (id, token) = create_one(&app).await;
    let (ct, body) = multipart_png("a.png", b"\x89PNG\r\n\x1a\nLOTSOFBYTES");
    let res = app.oneshot(Request::builder().method("POST")
        .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body)).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn attach_unknown_mime_rejected() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let boundary = "----X";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"a.exe\"\r\n");
    body.extend_from_slice(b"Content-Type: application/x-msdownload\r\n\r\nMZ");
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    let res = app.oneshot(Request::builder().method("POST")
        .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={}", boundary))
        .body(Body::from(body)).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Add the attach handler** to `routes/feedback.rs`:

```rust
use axum::extract::Multipart;
use sha2::{Sha256, Digest};
use tokio::io::AsyncWriteExt;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/feedback", post(create))
        .route("/v1/feedback/:id", axum::routing::get(get_one))
        .route("/v1/feedback/:id/attach", post(attach))
}

async fn attach(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ClaimQuery>,
    mut mp: Multipart,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let row = sqlx::query("SELECT claim_token FROM feedback WHERE id = ?")
        .bind(&id).fetch_optional(&s.db).await?
        .ok_or(AppError::NotFound)?;
    let stored: String = row.try_get("claim_token")?;
    if !ct_eq(stored.as_bytes(), q.token.as_bytes()) { return Err(AppError::Unauthorized); }

    let mut field = mp.next_field().await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
        .ok_or_else(|| AppError::BadRequest("no file part".into()))?;
    let filename = field.file_name().unwrap_or("upload.bin").to_string();
    let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
    if !s.cfg.uploads.allowed_mime.iter().any(|m| m == &mime) {
        return Err(AppError::BadRequest(format!("disallowed mime: {}", mime)));
    }

    let limit = s.cfg.uploads.max_attachment_bytes as usize;
    let mut total = 0usize;
    let aid = ulid::Ulid::new().to_string();
    let dir = s.cfg.uploads.dir.join(&id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Internal(e.into()))?;
    let path = dir.join(format!("{}-{}", aid, sanitize(&filename)));
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| AppError::Internal(e.into()))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = field.chunk().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        total = total.saturating_add(chunk.len());
        if total > limit {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::PayloadTooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| AppError::Internal(e.into()))?;
    }
    file.flush().await.map_err(|e| AppError::Internal(e.into()))?;
    let digest = hex::encode(hasher.finalize());

    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let rel = path.strip_prefix(&s.cfg.uploads.dir).unwrap().to_string_lossy().to_string();
    sqlx::query("INSERT INTO feedback_attachment(id, feedback_id, filename, mime, bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&aid).bind(&id).bind(&filename).bind(&mime)
        .bind(total as i64).bind(&digest).bind(&rel).bind(now)
        .execute(&s.db).await?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({"id": aid, "bytes": total}))))
}

fn sanitize(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect()
}
```

- [ ] **Step 4: Update `get_one`** to load attachments via a second query and populate `attachments`.

- [ ] **Step 5: Run all server tests, expect PASS.**

- [ ] **Step 6: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): multipart attachment upload with size + mime guards"
```

---

## Task 7: Updates manifest scan + GET /v1/updates/manifest

**Files:**
- Create: `tools/aaa/server/src/domain/update.rs`
- Create: `tools/aaa/server/src/routes/updates.rs`
- Modify: `tools/aaa/server/src/routes/mod.rs` and `lib.rs`
- Create: `tools/aaa/server/tests/manifest.rs`

- [ ] **Step 1: Implement domain/update.rs**

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct VersionedArtifacts {
    pub version: semver::Version,
    pub linux: Option<PlatformAsset>,
    pub windows: Option<PlatformAsset>,
}

#[derive(Debug, Clone)]
pub struct PlatformAsset {
    pub artifact: PathBuf,
    pub signature: String,
}

/// Walk artifacts_dir/<version>/ — pick newest semver.
pub fn pick_latest(artifacts_dir: &Path) -> std::io::Result<Option<VersionedArtifacts>> {
    let mut best: Option<VersionedArtifacts> = None;
    if !artifacts_dir.exists() { return Ok(None); }
    for entry in std::fs::read_dir(artifacts_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() { continue; }
        let name = entry.file_name(); let s = name.to_string_lossy();
        let Ok(ver) = semver::Version::parse(&s) else { continue };
        let dir = entry.path();
        let linux = read_pair(&dir, &["AppImage"]).ok();
        let windows = read_pair(&dir, &["msi", "exe"]).ok();
        let cand = VersionedArtifacts { version: ver.clone(), linux, windows };
        match &best {
            None => best = Some(cand),
            Some(b) if ver > b.version => best = Some(cand),
            _ => {}
        }
    }
    Ok(best)
}

fn read_pair(dir: &Path, exts: &[&str]) -> std::io::Result<PlatformAsset> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        let Some(ext) = p.extension().and_then(|e| e.to_str()) else { continue };
        if !exts.contains(&ext) { continue; }
        let sig_path = p.with_extension(format!("{}.sig", ext));
        if !sig_path.exists() { continue; }
        let signature = std::fs::read_to_string(&sig_path)?.trim().to_string();
        return Ok(PlatformAsset { artifact: p, signature });
    }
    Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no matching artifact"))
}
```

Add to `Cargo.toml`: `semver = "1"`. Wire `pub mod update;` in `domain/mod.rs`.

- [ ] **Step 2: Write the failing tests** in `tests/manifest.rs`:

```rust
mod common;
use axum::body::Body; use axum::http::{Request, StatusCode}; use tower::ServiceExt;

fn write(p: &std::path::Path, content: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

#[tokio::test]
async fn manifest_picks_latest_semver() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.8.0/AAA_0.8.0_amd64.AppImage"), "old");
    write(&root.join("0.8.0/AAA_0.8.0_amd64.AppImage.sig"), "SIG_OLD");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "new");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage.sig"), "SIG_NEW");
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder().uri("/v1/updates/manifest")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(v["version"], "0.9.0");
    assert_eq!(v["platforms"]["linux-x86_64"]["signature"], "SIG_NEW");
    assert!(v["platforms"]["linux-x86_64"]["url"].as_str().unwrap()
        .ends_with("/v1/updates/artifacts/0.9.0/AAA_0.9.0_amd64.AppImage"));
}

#[tokio::test]
async fn manifest_skips_platform_without_signature() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "new");
    // no .sig
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder().uri("/v1/updates/manifest")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn manifest_when_empty_returns_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder().uri("/v1/updates/manifest")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}
```

- [ ] **Step 3: Run, expect failures.**

- [ ] **Step 4: Implement routes/updates.rs**

```rust
use crate::domain::update::{pick_latest, VersionedArtifacts};
use crate::error::AppError;
use crate::state::AppState;
use axum::{extract::State, Json, Router, routing::get};
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/updates/manifest", get(manifest))
}

async fn manifest(State(s): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let latest = pick_latest(&s.cfg.updates.artifacts_dir)
        .map_err(|e| AppError::Internal(e.into()))?
        .ok_or(AppError::NotFound)?;
    let mut platforms = serde_json::Map::new();
    let url_for = |fname: &str, ver: &semver::Version| {
        format!("{}/v1/updates/artifacts/{}/{}", s.cfg.server.public_url.trim_end_matches('/'), ver, fname)
    };
    let mut push = |key: &str, asset: &Option<crate::domain::update::PlatformAsset>, ver: &semver::Version| {
        if let Some(a) = asset {
            let fname = a.artifact.file_name().unwrap().to_string_lossy().to_string();
            platforms.insert(key.to_string(), json!({"url": url_for(&fname, ver), "signature": a.signature}));
        }
    };
    push("linux-x86_64", &latest.linux, &latest.version);
    push("windows-x86_64", &latest.windows, &latest.version);
    if platforms.is_empty() { return Err(AppError::NotFound); }
    let pub_date = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    Ok(Json(json!({
        "version": latest.version.to_string(),
        "pub_date": pub_date,
        "notes": "see in-app About",
        "platforms": platforms,
    })))
}
```

Add `pub mod updates;` in `routes/mod.rs`. Merge in `lib.rs::build_router_with`.

- [ ] **Step 5: Run tests, expect PASS.**

- [ ] **Step 6: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): /v1/updates/manifest scans artifacts dir for latest semver"
```

---

## Task 8: Static serve /v1/updates/artifacts/*

**Files:**
- Modify: `tools/aaa/server/src/routes/updates.rs`
- Modify: `tools/aaa/server/tests/manifest.rs` (add 1 test)

- [ ] **Step 1: Add test** appending to `tests/manifest.rs`:

```rust
#[tokio::test]
async fn artifact_static_serve_works() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "DOWNLOAD_BYTES");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage.sig"), "SIG");
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder()
        .uri("/v1/updates/artifacts/0.9.0/AAA_0.9.0_amd64.AppImage")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    assert_eq!(&body[..], b"DOWNLOAD_BYTES");
}
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Add nested static service** at the bottom of `routes/updates.rs::router`:

```rust
use tower_http::services::ServeDir;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/updates/manifest", get(manifest))
        .nest_service("/v1/updates/artifacts", ServeDir::new_with_dir_lazy(/* placeholder */))
}
```

The `ServeDir` needs the configured artifacts_dir, which lives in state. Since `nest_service` needs the path at build time, change `build_router_with` to build the static service from `state.cfg.updates.artifacts_dir`:

```rust
// in lib.rs::build_router_with, before merging:
let artifacts = state.cfg.updates.artifacts_dir.clone();
let app = axum::Router::new()
    .merge(routes::health::router())
    .merge(routes::feedback::router())
    .merge(routes::updates::router())
    .nest_service("/v1/updates/artifacts", tower_http::services::ServeDir::new(artifacts))
    .with_state(state);
```

Drop the `nest_service` line from updates::router; keep only the manifest route there.

- [ ] **Step 4: Run all tests, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): static serve /v1/updates/artifacts via ServeDir"
```

---

## Task 9: Admin auth + JSON API (list / patch / download attachment)

**Files:**
- Create: `tools/aaa/server/src/auth.rs`
- Create: `tools/aaa/server/src/routes/admin.rs`
- Modify: `tools/aaa/server/src/routes/mod.rs` and `lib.rs`
- Create: `tools/aaa/server/tests/admin.rs`

- [ ] **Step 1: Implement auth.rs**

```rust
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use crate::error::AppError;
use crate::state::AppState;

pub struct AdminAuth;

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, s: &AppState) -> Result<Self, Self::Rejection> {
        let want = s.cfg.server.admin_token.as_bytes();
        let got = parts.headers.get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        if want.len() != got.len() { return Err(AppError::Unauthorized); }
        let mut diff = 0u8;
        for (a, b) in want.iter().zip(got.as_bytes()) { diff |= a ^ b; }
        if diff == 0 { Ok(AdminAuth) } else { Err(AppError::Unauthorized) }
    }
}
```

Add `pub mod auth;` to lib.rs.

- [ ] **Step 2: Write failing tests** in `tests/admin.rs`:

```rust
mod common;
use axum::body::Body; use axum::http::{Request, StatusCode}; use serde_json::json;
use tower::ServiceExt;

async fn create_one(app: &axum::Router) -> String {
    let payload = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    });
    let res = app.clone().oneshot(Request::builder().method("POST")
        .uri("/v1/feedback").header("content-type","application/json")
        .body(Body::from(payload.to_string())).unwrap()).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    body["ticket_id"].as_str().unwrap().into()
}

#[tokio::test]
async fn list_requires_admin_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app.oneshot(Request::builder().uri("/admin/api/feedback")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_with_token_returns_items() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let _id = create_one(&app).await;
    let res = app.oneshot(Request::builder().uri("/admin/api/feedback")
        .header("authorization", "Bearer TEST_ADMIN")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn patch_status_persists() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let id = create_one(&app).await;
    let res = app.clone().oneshot(Request::builder().method("PATCH")
        .uri(format!("/admin/api/feedback/{}", id))
        .header("authorization", "Bearer TEST_ADMIN")
        .header("content-type", "application/json")
        .body(Body::from(json!({"status": "in_progress", "admin_note": "looking"}).to_string()))
        .unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app.oneshot(Request::builder().uri("/admin/api/feedback")
        .header("authorization", "Bearer TEST_ADMIN")
        .body(Body::empty()).unwrap()).await.unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(v["items"][0]["status"], "in_progress");
    assert_eq!(v["items"][0]["admin_note"], "looking");
}
```

- [ ] **Step 3: Run, expect failures.**

- [ ] **Step 4: Implement routes/admin.rs**

```rust
use crate::auth::AdminAuth;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Path, State, Query};
use axum::{Json, Router};
use axum::routing::{get, patch};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/api/feedback", get(list))
        .route("/admin/api/feedback/:id", patch(update_one))
        .route("/admin/api/feedback/:id/attachment/:aid", get(download))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list(_a: AdminAuth, State(s): State<AppState>, Query(q): Query<ListQuery>)
    -> Result<Json<serde_json::Value>, AppError>
{
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = if let Some(st) = q.status.as_deref() {
        sqlx::query("SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(st).bind(limit).bind(offset).fetch_all(&s.db).await?
    } else {
        sqlx::query("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(limit).bind(offset).fetch_all(&s.db).await?
    };
    let items: Vec<serde_json::Value> = rows.iter().map(|r| json!({
        "id": r.get::<String,_>("id"),
        "status": r.get::<String,_>("status"),
        "category": r.get::<String,_>("category"),
        "severity": r.get::<Option<String>,_>("severity"),
        "title": r.get::<String,_>("title"),
        "description": r.get::<String,_>("description"),
        "contact_email": r.get::<Option<String>,_>("contact_email"),
        "app_version": r.get::<String,_>("app_version"),
        "os_info": r.get::<String,_>("os_info"),
        "device_id": r.get::<String,_>("device_id"),
        "log_excerpt": r.get::<Option<String>,_>("log_excerpt"),
        "admin_note": r.get::<Option<String>,_>("admin_note"),
        "created_at": r.get::<i64,_>("created_at"),
        "updated_at": r.get::<i64,_>("updated_at"),
    })).collect();
    Ok(Json(json!({"items": items})))
}

#[derive(Deserialize)]
struct PatchBody { status: Option<String>, admin_note: Option<String> }

async fn update_one(_a: AdminAuth, State(s): State<AppState>, Path(id): Path<String>, Json(b): Json<PatchBody>)
    -> Result<Json<serde_json::Value>, AppError>
{
    if let Some(st) = &b.status {
        if !matches!(st.as_str(), "new"|"triaged"|"in_progress"|"resolved"|"wontfix") {
            return Err(AppError::BadRequest("invalid status".into()));
        }
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let res = sqlx::query("UPDATE feedback SET status = COALESCE(?, status), admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?")
        .bind(&b.status).bind(&b.admin_note).bind(now).bind(&id)
        .execute(&s.db).await?;
    if res.rows_affected() == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({"ok": true})))
}

async fn download(_a: AdminAuth, State(s): State<AppState>, Path((_id, aid)): Path<(String, String)>)
    -> Result<axum::response::Response, AppError>
{
    use axum::body::Body;
    use axum::http::header;
    let row = sqlx::query("SELECT filename, mime, storage_path FROM feedback_attachment WHERE id = ?")
        .bind(&aid).fetch_optional(&s.db).await?
        .ok_or(AppError::NotFound)?;
    let path = s.cfg.uploads.dir.join(row.get::<String,_>("storage_path"));
    let bytes = tokio::fs::read(&path).await.map_err(|e| AppError::Internal(e.into()))?;
    let mime: String = row.get("mime");
    let filename: String = row.get("filename");
    Ok(axum::response::Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", filename))
        .body(Body::from(bytes)).unwrap())
}
```

Wire `pub mod admin;` in `routes/mod.rs` and merge in `lib.rs`.

- [ ] **Step 5: Run all tests, expect PASS.**

- [ ] **Step 6: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): admin JSON API with Bearer auth (list/patch/download)"
```

---

## Task 10: Admin: POST /admin/api/releases (publish)

**Files:**
- Modify: `tools/aaa/server/src/routes/admin.rs`
- Modify: `tools/aaa/server/tests/admin.rs`

- [ ] **Step 1: Add failing test** (append to `tests/admin.rs`):

```rust
#[tokio::test]
async fn publish_release_writes_artifacts_and_updates_manifest() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let boundary = "----X";
    let mut body = Vec::new();
    let mut push_part = |name: &str, filename: Option<&str>, mime: &str, content: &[u8]| {
        body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        if let Some(fn_) = filename {
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n", name, fn_).as_bytes());
        } else {
            body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{}\"\r\n", name).as_bytes());
        }
        body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime).as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(b"\r\n");
    };
    push_part("version", None, "text/plain", b"0.9.0");
    push_part("artifact", Some("AAA_0.9.0_amd64.AppImage"), "application/octet-stream", b"BIN");
    push_part("signature", Some("AAA_0.9.0_amd64.AppImage.sig"), "text/plain", b"SIG");
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let res = app.clone().oneshot(Request::builder().method("POST")
        .uri("/admin/api/releases")
        .header("authorization", "Bearer TEST_ADMIN")
        .header("content-type", format!("multipart/form-data; boundary={}", boundary))
        .body(Body::from(body)).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let res = app.oneshot(Request::builder().uri("/v1/updates/manifest")
        .body(Body::empty()).unwrap()).await.unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(v["version"], "0.9.0");
}
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Add publish handler** (append to `routes/admin.rs::router` chain `.route("/admin/api/releases", post(publish))`, then):

```rust
use axum::extract::Multipart;
use axum::http::StatusCode;

async fn publish(_a: AdminAuth, State(s): State<AppState>, mut mp: Multipart)
    -> Result<(StatusCode, Json<serde_json::Value>), AppError>
{
    let mut version: Option<String> = None;
    struct File { filename: String, bytes: Vec<u8> }
    let mut artifact: Option<File> = None;
    let mut signature: Option<File> = None;

    while let Some(mut f) = mp.next_field().await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = f.name().unwrap_or("").to_string();
        let filename = f.file_name().map(|s| s.to_string());
        let mut buf = Vec::new();
        while let Some(chunk) = f.chunk().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
            buf.extend_from_slice(&chunk);
            if buf.len() > 500 * 1024 * 1024 { return Err(AppError::PayloadTooLarge); }
        }
        match name.as_str() {
            "version" => version = Some(String::from_utf8(buf).map_err(|_| AppError::BadRequest("version utf8".into()))?.trim().to_string()),
            "artifact" => artifact = Some(File { filename: filename.unwrap_or_default(), bytes: buf }),
            "signature" => signature = Some(File { filename: filename.unwrap_or_default(), bytes: buf }),
            _ => {}
        }
    }
    let version = version.ok_or_else(|| AppError::BadRequest("version required".into()))?;
    semver::Version::parse(&version).map_err(|e| AppError::BadRequest(format!("bad version: {}", e)))?;
    let art = artifact.ok_or_else(|| AppError::BadRequest("artifact required".into()))?;
    let sig = signature.ok_or_else(|| AppError::BadRequest("signature required".into()))?;
    if !art.filename.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(AppError::BadRequest("artifact filename contains illegal chars".into()));
    }

    let dir = s.cfg.updates.artifacts_dir.join(&version);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Internal(e.into()))?;
    tokio::fs::write(dir.join(&art.filename), &art.bytes).await
        .map_err(|e| AppError::Internal(e.into()))?;
    tokio::fs::write(dir.join(&sig.filename), &sig.bytes).await
        .map_err(|e| AppError::Internal(e.into()))?;
    tracing::info!(%version, "release published");
    Ok((StatusCode::CREATED, Json(json!({"version": version}))))
}
```

- [ ] **Step 4: Run all tests, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): admin publish endpoint accepts artifact+signature multipart"
```

---

## Task 11: Admin static HTML

**Files:**
- Create: `tools/aaa/server/admin-ui/index.html`
- Modify: `tools/aaa/server/src/lib.rs` (mount static dir at `/admin/`)

- [ ] **Step 1: Write `admin-ui/index.html`** — single page using `fetch` against `/admin/api/*`. Two tabs: "Feedback" and "Releases". Token kept in localStorage; the user pastes once and it goes into `Authorization` header for every fetch. Provide:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>aaa-hub admin</title>
<style>
body{font:14px system-ui;margin:0;background:#fafafa}
header{padding:8px 16px;background:#222;color:#fff;display:flex;gap:12px;align-items:center}
nav button{background:transparent;color:#fff;border:0;cursor:pointer;padding:4px 8px}
nav button.active{border-bottom:2px solid #fff}
main{padding:16px}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}
.status-new{color:#0a7} .status-resolved{color:#888}
textarea,input,select{font:inherit}
</style></head>
<body>
<header>
  <strong>aaa-hub</strong>
  <nav><button id="tab-fb" class="active">Feedback</button><button id="tab-rel">Releases</button></nav>
  <span style="margin-left:auto"><input id="token" placeholder="admin token" size="32"/></span>
</header>
<main>
  <section id="view-fb">
    <p><button id="reload">Reload</button>
       <select id="filter"><option value="">all</option><option>new</option><option>triaged</option><option>in_progress</option><option>resolved</option><option>wontfix</option></select></p>
    <table id="fb-table"><thead><tr><th>Time</th><th>Status</th><th>Cat</th><th>Title</th><th>Version</th><th>OS</th><th></th></tr></thead><tbody></tbody></table>
  </section>
  <section id="view-rel" hidden>
    <h3>Publish a release</h3>
    <form id="rel-form">
      <p>Version (semver): <input name="version" required/></p>
      <p>Artifact: <input type="file" name="artifact" required/></p>
      <p>Signature (.sig): <input type="file" name="signature" required/></p>
      <button>Upload</button>
    </form>
    <pre id="rel-out"></pre>
  </section>
</main>
<script type="module" src="./admin.js"></script>
</body></html>
```

- [ ] **Step 2: Create `admin-ui/admin.js`** with the fetch logic:

```js
const $ = (id) => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.token || '';
tokenInput.addEventListener('change', () => { localStorage.token = tokenInput.value; });

function authHeaders() { return { 'Authorization': 'Bearer ' + (localStorage.token || '') }; }

async function loadFeedback() {
  const status = $('filter').value;
  const url = status ? '/admin/api/feedback?status=' + encodeURIComponent(status) : '/admin/api/feedback';
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) { alert('请求失败: ' + res.status); return; }
  const j = await res.json();
  const tbody = $('fb-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const it of j.items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(it.created_at).toLocaleString()}</td>
      <td class="status-${it.status}">${it.status}</td>
      <td>${it.category}${it.severity?'/'+it.severity:''}</td>
      <td>${escapeHtml(it.title)}</td>
      <td>${escapeHtml(it.app_version)}</td>
      <td>${escapeHtml(it.os_info)}</td>
      <td><button data-id="${it.id}">详情</button></td>`;
    tr.querySelector('button').addEventListener('click', () => openDetail(it));
    tbody.appendChild(tr);
  }
}

function openDetail(it) {
  const note = prompt('admin_note', it.admin_note || '');
  if (note === null) return;
  const status = prompt('status (new|triaged|in_progress|resolved|wontfix)', it.status);
  if (status === null) return;
  fetch('/admin/api/feedback/' + it.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ status, admin_note: note }),
  }).then(r => r.ok ? loadFeedback() : alert('更新失败: ' + r.status));
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

$('reload').addEventListener('click', loadFeedback);
$('filter').addEventListener('change', loadFeedback);
$('tab-fb').addEventListener('click', () => { $('view-fb').hidden = false; $('view-rel').hidden = true;
  $('tab-fb').classList.add('active'); $('tab-rel').classList.remove('active'); });
$('tab-rel').addEventListener('click', () => { $('view-fb').hidden = true; $('view-rel').hidden = false;
  $('tab-rel').classList.add('active'); $('tab-fb').classList.remove('active'); });

$('rel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch('/admin/api/releases', { method: 'POST', headers: authHeaders(), body: fd });
  $('rel-out').textContent = res.ok ? 'OK · ' + (await res.text()) : 'FAIL ' + res.status;
});

loadFeedback();
```

- [ ] **Step 3: Mount the static dir** in `lib.rs::build_router_with`:

```rust
.nest_service("/admin", tower_http::services::ServeDir::new("admin-ui").append_index_html_on_directories(true))
```

Note: this serves the SPA without auth — auth is enforced on the JSON endpoints. The HTML is harmless without a token (UI says "login").

- [ ] **Step 4: Smoke build with `cargo build`.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/server/admin-ui tools/aaa/server/src/lib.rs
git commit -m "feat(hub): static admin SPA mounted at /admin/"
```

---

## Task 12: Rate limiting

**Files:**
- Modify: `tools/aaa/server/src/lib.rs`
- Create: `tools/aaa/server/tests/ratelimit.rs`

- [ ] **Step 1: Write failing test** (creating > limit should return 429):

```rust
mod common;
use axum::body::Body; use axum::http::{Request, StatusCode}; use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_feedback_rate_limit_kicks_in() {
    let h = common::make().await;
    let mut cfg = (*h.state.cfg).clone();
    cfg.ratelimit.feedback_per_ip_per_hour = 2;
    let mut state = h.state.clone();
    state.cfg = std::sync::Arc::new(cfg);
    let app = aaa_hub::build_router_with(state);
    let body = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    }).to_string();
    let mk = || Request::builder().method("POST").uri("/v1/feedback")
        .header("content-type","application/json")
        .header("x-forwarded-for","1.2.3.4")
        .body(Body::from(body.clone())).unwrap();
    assert_eq!(app.clone().oneshot(mk()).await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(app.clone().oneshot(mk()).await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(app.clone().oneshot(mk()).await.unwrap().status(), StatusCode::TOO_MANY_REQUESTS);
}
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement IP-keyed limiter** in `lib.rs`. Use `governor::DefaultKeyedRateLimiter<IpAddr>`, build two limiters (feedback + manifest), wrap as Axum middleware that reads `X-Forwarded-For` first then peer address. On limit exceeded, short-circuit with `AppError::RateLimited`. Apply only to:
  - `/v1/feedback` POST → feedback limiter
  - `/v1/updates/manifest` GET → manifest limiter

Sketch:

```rust
use std::net::IpAddr;
use std::sync::Arc;
use governor::{RateLimiter, Quota, clock::DefaultClock, state::keyed::DefaultKeyedStateStore};
use std::num::NonZeroU32;

type IpLimiter = RateLimiter<IpAddr, DefaultKeyedStateStore<IpAddr>, DefaultClock>;

pub fn make_limiters(cfg: &config::Config) -> (Arc<IpLimiter>, Arc<IpLimiter>) {
    let fb = Arc::new(RateLimiter::keyed(
        Quota::per_hour(NonZeroU32::new(cfg.ratelimit.feedback_per_ip_per_hour.max(1)).unwrap())));
    let mf = Arc::new(RateLimiter::keyed(
        Quota::per_minute(NonZeroU32::new(cfg.ratelimit.manifest_per_ip_per_minute.max(1)).unwrap())));
    (fb, mf)
}

async fn limit_mw(limiter: Arc<IpLimiter>, req: axum::http::Request<axum::body::Body>, next: axum::middleware::Next) -> Result<axum::response::Response, error::AppError> {
    let ip = req.headers().get("x-forwarded-for")
        .and_then(|h| h.to_str().ok()).and_then(|s| s.split(',').next().map(|x| x.trim()))
        .and_then(|s| s.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::from([0,0,0,0]));
    if limiter.check_key(&ip).is_err() { return Err(error::AppError::RateLimited); }
    Ok(next.run(req).await)
}
```

Apply with `.route_layer(axum::middleware::from_fn_with_state(...))` on the two specific routes.

- [ ] **Step 4: Run all tests, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): per-IP rate limit for feedback POST and manifest GET"
```

---

## Task 13: Email notification on feedback creation

**Files:**
- Create: `tools/aaa/server/src/notify/mod.rs`
- Create: `tools/aaa/server/src/notify/email.rs`
- Modify: `tools/aaa/server/src/state.rs`
- Modify: `tools/aaa/server/src/routes/feedback.rs`
- Create: `tools/aaa/server/tests/notify.rs`

- [ ] **Step 1: Implement notify abstraction** in `notify/mod.rs`:

```rust
use crate::domain::feedback::NewFeedback;
use std::sync::Arc;

#[axum::async_trait]
pub trait Notifier: Send + Sync {
    async fn feedback_created(&self, ticket_id: &str, fb: &NewFeedback);
}

pub struct NoopNotifier;

#[axum::async_trait]
impl Notifier for NoopNotifier {
    async fn feedback_created(&self, _: &str, _: &NewFeedback) {}
}

pub mod email;

#[derive(Default, Clone)]
pub struct CountingNotifier { pub n: Arc<std::sync::atomic::AtomicUsize> }

#[axum::async_trait]
impl Notifier for CountingNotifier {
    async fn feedback_created(&self, _: &str, _: &NewFeedback) {
        self.n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}
```

Add `pub mod notify;` to lib.rs.

- [ ] **Step 2: Implement notify/email.rs**

```rust
use super::Notifier;
use crate::config::EmailNotify;
use crate::domain::feedback::NewFeedback;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor, Message};
use lettre::transport::smtp::authentication::Credentials;

pub struct EmailNotifier {
    cfg: EmailNotify,
    transport: AsyncSmtpTransport<Tokio1Executor>,
    admin_url_base: String,
}

impl EmailNotifier {
    pub fn new(cfg: EmailNotify, public_url: &str) -> anyhow::Result<Self> {
        let mut t = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.smtp_host)?
            .port(cfg.smtp_port);
        if !cfg.smtp_user.is_empty() {
            t = t.credentials(Credentials::new(cfg.smtp_user.clone(), cfg.smtp_password.clone()));
        }
        Ok(Self { cfg, transport: t.build(), admin_url_base: public_url.trim_end_matches('/').to_string() })
    }
}

#[axum::async_trait]
impl Notifier for EmailNotifier {
    async fn feedback_created(&self, ticket_id: &str, fb: &NewFeedback) {
        let subject = format!("[aaa-hub] {} · {}", serde_json::to_string(&fb.category).unwrap().trim_matches('"').to_string(), fb.title);
        let body = format!(
            "Ticket: {id}\nVersion: {ver}\nOS: {os}\n\nDescription:\n{desc}\n\nAdmin: {base}/admin/?id={id}\n",
            id=ticket_id, ver=fb.app_version, os=fb.os_info,
            desc=fb.description.chars().take(500).collect::<String>(), base=self.admin_url_base);
        for to in &self.cfg.to {
            let msg = match Message::builder()
                .from(self.cfg.from.parse().unwrap())
                .to(to.parse().unwrap())
                .subject(&subject)
                .body(body.clone())
            {
                Ok(m) => m, Err(e) => { tracing::warn!(error=%e, "build email"); continue }
            };
            for attempt in 1..=3 {
                match self.transport.send(msg.clone()).await {
                    Ok(_) => break,
                    Err(e) if attempt < 3 => {
                        tracing::warn!(attempt, error=%e, "smtp retry");
                        tokio::time::sleep(std::time::Duration::from_millis(200 * attempt)).await;
                    }
                    Err(e) => { tracing::warn!(error=%e, "smtp final fail"); }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Plug notifier into AppState**

In `state.rs`:

```rust
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: SqlitePool,
    pub notifier: Arc<dyn crate::notify::Notifier>,
}
```

Update `tests/common/mod.rs` to populate it with `Arc::new(crate::notify::CountingNotifier::default())` (export the counter so tests can check). Update production `main.rs` to construct either `EmailNotifier` (if `cfg.notify.email.enabled`) or `NoopNotifier`.

- [ ] **Step 4: Call from create handler** in `routes/feedback.rs`:

```rust
// after successful insert, before returning:
let notifier = s.notifier.clone();
let id_for_notify = id.clone();
let input_for_notify = input;  // requires NewFeedback: Clone or restructure
tokio::spawn(async move { notifier.feedback_created(&id_for_notify, &input_for_notify).await; });
```

To avoid having to clone, capture only the strings the notifier needs.

- [ ] **Step 5: Add notify test** `tests/notify.rs`:

```rust
mod common;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn create_calls_notifier() {
    let h = common::make().await;
    let counter = h.notifier_counter.clone();
    let app = aaa_hub::build_router_with(h.state.clone());
    use axum::body::Body; use axum::http::Request; use tower::ServiceExt;
    let payload = serde_json::json!({
        "category":"bug","title":"t","description":"d",
        "app_version":"0.8.1","os_info":"linux","device_id":"01H"
    });
    app.oneshot(Request::builder().method("POST").uri("/v1/feedback")
        .header("content-type","application/json")
        .body(Body::from(payload.to_string())).unwrap()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}
```

Update `Harness` to expose the counting notifier's counter.

- [ ] **Step 6: Run all tests, expect PASS.**

- [ ] **Step 7: Commit.**

```bash
git add tools/aaa/server/
git commit -m "feat(hub): email notification on feedback creation (with retry+silent fail)"
```

---

## Task 14: Workspace hookup + server v0.1.0

**Files:**
- Modify: `tools/aaa/Cargo.toml`
- Modify: `tools/aaa/release-notes.txt`
- Modify: `tools/aaa/package.json`, `tools/aaa/src-tauri/tauri.conf.json`, `tools/aaa/src-tauri/Cargo.toml`, `tools/aaa/core/Cargo.toml`

- [ ] **Step 1: Add `server` to workspace** — open `tools/aaa/Cargo.toml`, find `[workspace] members = [...]`, append `"server"`.

- [ ] **Step 2: Bump client versions** from `0.8.1` → `0.9.0` (minor, since this adds Tauri commands and visible features). Apply to all 4 files listed in CLAUDE.md.

- [ ] **Step 3: Append release-notes block at the top of `tools/aaa/release-notes.txt`**:

```
v0.9.0
------
- 新增 aaa-hub 服务端骨架（Rust/Axum/SQLite），含 healthz / feedback CRUD / updates manifest / admin JSON API / 邮件通知 / 限流
- 服务端 Cargo workspace 成员独立 versioned at 0.1.0
- 桌面端尚未接入，下一版引入

```

- [ ] **Step 4: `cargo build --workspace`** to confirm everything compiles together.

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/Cargo.toml tools/aaa/release-notes.txt tools/aaa/package.json tools/aaa/src-tauri/tauri.conf.json tools/aaa/src-tauri/Cargo.toml tools/aaa/core/Cargo.toml
git commit -m "chore: register aaa-hub in workspace; bump client to 0.9.0"
```

---

## Task 15: core::log_buffer + log_excerpt

**Files:**
- Modify: `tools/aaa/core/Cargo.toml`
- Modify: `tools/aaa/core/src/lib.rs`
- Create: `tools/aaa/core/src/log_buffer.rs`
- Create: `tools/aaa/core/src/log_excerpt.rs`

- [ ] **Step 1: Add deps to `core/Cargo.toml`**:

```toml
regex = "1"
parking_lot = "0.12"
```

- [ ] **Step 2: Implement log_buffer.rs**

```rust
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;

#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<VecDeque<String>>>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self { inner: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))), capacity }
    }
    pub fn push(&self, line: String) {
        let mut g = self.inner.lock();
        if g.len() == self.capacity { g.pop_front(); }
        g.push_back(line);
    }
    pub fn snapshot(&self) -> Vec<String> {
        self.inner.lock().iter().cloned().collect()
    }
}
```

- [ ] **Step 3: Write tests for log_excerpt** in `core/src/log_excerpt.rs` (inline `#[cfg(test)]`):

```rust
use crate::log_buffer::LogBuffer;
use regex::Regex;
use once_cell::sync::Lazy;

static EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap());
static HOMEPATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"/home/[^/\s]+").unwrap());
static WINPATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"[A-Z]:\\Users\\[^\\]+").unwrap());
static IPV4: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{1,3}(?:\.\d{1,3}){3}\b").unwrap());
static IPV6: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[0-9a-fA-F:]{2,}:[0-9a-fA-F:]+\b").unwrap());
static LONGTOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Za-z0-9+/=_-]{32,}\b").unwrap());

const MAX_BYTES: usize = 64 * 1024;

pub fn redact(text: &str) -> String {
    let s = EMAIL.replace_all(text, "<email>");
    let s = HOMEPATH.replace_all(&s, "/home/<redacted>");
    let s = WINPATH.replace_all(&s, |c: &regex::Captures| {
        c[0].split('\\').take(2).collect::<Vec<_>>().join("\\") + "\\<redacted>"
    });
    let s = IPV4.replace_all(&s, "<ip>");
    let s = IPV6.replace_all(&s, "<ip>");
    LONGTOKEN.replace_all(&s, "<token>").into_owned()
}

pub fn collect(buf: &LogBuffer) -> String {
    let mut out = buf.snapshot().join("\n");
    out = redact(&out);
    if out.len() > MAX_BYTES {
        let cut = out.len().saturating_sub(MAX_BYTES);
        let mut tail = out[cut..].to_string();
        tail.push_str("\n... (truncated)");
        return tail;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn redacts_email() {
        assert_eq!(redact("contact alice@example.com now"), "contact <email> now");
    }
    #[test] fn redacts_home_path() {
        assert!(redact("error at /home/alice/code/x.rs:1").starts_with("error at /home/<redacted>"));
    }
    #[test] fn redacts_long_tokens() {
        let s = "tok=abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert!(redact(s).contains("<token>"));
    }
    #[test] fn collect_truncates() {
        let buf = LogBuffer::new(10);
        for _ in 0..5 { buf.push("a".repeat(20_000)); }
        let s = collect(&buf);
        assert!(s.ends_with("(truncated)"));
        assert!(s.len() <= MAX_BYTES + 32);
    }
}
```

Add `once_cell = "1"` to `core/Cargo.toml`. Add `pub mod log_buffer; pub mod log_excerpt;` to `core/src/lib.rs`.

- [ ] **Step 4: Run `cargo test -p aaa-core`, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add tools/aaa/core/
git commit -m "feat(core): in-process log buffer + redacting log excerpt"
```

---

## Task 16: core::feedback (LocalTicket persistence)

**Files:**
- Create: `tools/aaa/core/src/feedback.rs`
- Modify: `tools/aaa/core/src/lib.rs`

- [ ] **Step 1: Implement feedback.rs**

```rust
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTicket {
    pub id: String,
    pub claim_token: String,
    pub title: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct LocalTickets {
    pub items: Vec<LocalTicket>,
}

fn path() -> Result<PathBuf> {
    let dir = dirs::config_dir().context("no config dir")?.join("aaa");
    std::fs::create_dir_all(&dir).context("create config dir")?;
    Ok(dir.join("tickets.json"))
}

pub fn load() -> Result<LocalTickets> {
    let p = path()?;
    if !p.exists() { return Ok(LocalTickets::default()); }
    let s = std::fs::read_to_string(&p).context("read tickets.json")?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

pub fn save(t: &LocalTickets) -> Result<()> {
    let p = path()?;
    let s = serde_json::to_string_pretty(t)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).context("write tmp")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).context("rename tickets.json")?;
    Ok(())
}

pub fn append(ticket: LocalTicket) -> Result<()> {
    let mut t = load().unwrap_or_default();
    t.items.push(ticket);
    save(&t)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn round_trip_in_memory() {
        let mut t = LocalTickets::default();
        t.items.push(LocalTicket { id: "01H".into(), claim_token: "T".into(),
            title: "x".into(), category: "bug".into(), created_at: 1 });
        let s = serde_json::to_string(&t).unwrap();
        let p: LocalTickets = serde_json::from_str(&s).unwrap();
        assert_eq!(p.items.len(), 1);
    }
}
```

- [ ] **Step 2: Add `pub mod feedback;` to `core/src/lib.rs`**.

- [ ] **Step 3: cargo test -p aaa-core, commit.**

```bash
git add tools/aaa/core/
git commit -m "feat(core): LocalTicket persistence under ~/.config/aaa/tickets.json"
```

---

## Task 17: HubSettings + device_id

**Files:**
- Modify: `tools/aaa/core/src/settings.rs`

- [ ] **Step 1: Extend `AppSettings`** — add `pub hub: HubSettings` field with `#[serde(default)]`. Define:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HubSettings {
    pub base_url: String,           // empty when not configured
    pub device_id: String,          // ULID, generated lazily on first save
}

impl Default for HubSettings {
    fn default() -> Self { Self { base_url: String::new(), device_id: String::new() } }
}
```

- [ ] **Step 2: After `load()` succeeds**, if `device_id.is_empty()` then set it to `ulid::Ulid::new().to_string()` and immediately `save(&parsed)?`. Keep this idempotent: never regenerate when present.

- [ ] **Step 3: Add `with_root` test variants** to `settings.rs` so tests can pass an explicit dir without touching `XDG_CONFIG_HOME`:

```rust
pub fn load_from_root(root: &std::path::Path) -> Result<AppSettings> {
    let p = root.join("aaa/settings.json");
    if !p.exists() { return Ok(AppSettings::default()); }
    let s = std::fs::read_to_string(&p)?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

pub fn save_to_root(root: &std::path::Path, settings: &AppSettings) -> Result<()> {
    let dir = root.join("aaa"); std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(settings)?)?;
    Ok(())
}
```

Refactor `load`/`save` to delegate to these (with `root = dirs::config_dir()?`). Then the test:

```rust
#[test]
fn device_id_generated_once_and_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = AppSettings::default();
    assert!(s.hub.device_id.is_empty());
    if s.hub.device_id.is_empty() { s.hub.device_id = ulid::Ulid::new().to_string(); }
    save_to_root(dir.path(), &s).unwrap();
    let again = load_from_root(dir.path()).unwrap();
    assert_eq!(again.hub.device_id, s.hub.device_id);
    assert_eq!(again.hub.device_id.len(), 26);
}
```

The "ensure-generated" call site in `load()`:

```rust
pub fn load() -> Result<AppSettings> {
    let root = dirs::config_dir().ok_or_else(|| anyhow!("no config dir"))?;
    let mut s = load_from_root(&root)?;
    if s.hub.device_id.is_empty() {
        s.hub.device_id = ulid::Ulid::new().to_string();
        save_to_root(&root, &s)?;
    }
    Ok(s)
}
```

- [ ] **Step 4: cargo test -p aaa-core, commit.**

```bash
git add tools/aaa/core/src/settings.rs
git commit -m "feat(core): AppSettings.hub with persistent anonymous device_id"
```

---

## Task 18: src-tauri::HubClient + log_layer

**Files:**
- Modify: `tools/aaa/src-tauri/Cargo.toml`
- Create: `tools/aaa/src-tauri/src/hub.rs`
- Create: `tools/aaa/src-tauri/src/log_layer.rs`
- Modify: `tools/aaa/src-tauri/src/lib.rs`

- [ ] **Step 1: Add deps** to `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "multipart"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

- [ ] **Step 2: Implement `log_layer.rs`** as a `tracing_subscriber::Layer` that writes WARN+ERROR events into the shared `aaa_core::log_buffer::LogBuffer`:

```rust
use aaa_core::log_buffer::LogBuffer;
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

pub struct BufferLayer { pub buf: LogBuffer }

impl<S: Subscriber> Layer<S> for BufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > tracing::Level::WARN { return; }   // WARN+ERROR only
        let mut visitor = StringVisitor(String::new());
        event.record(&mut visitor);
        let line = format!("[{}] {} {}", level, event.metadata().target(), visitor.0);
        self.buf.push(line);
    }
}

struct StringVisitor(String);
impl tracing::field::Visit for StringVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if !self.0.is_empty() { self.0.push(' '); }
        self.0.push_str(&format!("{}={:?}", field.name(), value));
    }
}
```

- [ ] **Step 3: Implement `hub.rs`**

```rust
use aaa_core::settings::HubSettings;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct HubClient {
    base: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub enum HubStatus { Connected, Disconnected }

#[derive(Debug, Clone, Serialize)]
pub struct CreatedTicket { pub ticket_id: String, pub claim_token: String }

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTicketView {
    pub status: String,
    pub admin_note: Option<String>,
    pub updated_at: i64,
}

impl HubClient {
    pub fn new(hs: &HubSettings) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .build().expect("reqwest client");
        Self { base: hs.base_url.trim_end_matches('/').to_string(), http }
    }

    pub fn is_configured(&self) -> bool { !self.base.is_empty() }

    pub async fn ping(&self) -> HubStatus {
        if !self.is_configured() { return HubStatus::Disconnected; }
        match self.http.get(format!("{}/healthz", self.base)).send().await {
            Ok(r) if r.status().is_success() => HubStatus::Connected,
            Ok(r) => { tracing::info!(status=%r.status(), "hub healthz non-200"); HubStatus::Disconnected }
            Err(e) => { tracing::info!(error=%e, "hub unreachable"); HubStatus::Disconnected }
        }
    }

    /// Submit. Returns None on any failure (logged), Some on success.
    pub async fn submit(&self, body: serde_json::Value, attachments: Vec<(String, String, Vec<u8>)>) -> Option<CreatedTicket> {
        if !self.is_configured() { return None; }
        let res = self.http.post(format!("{}/v1/feedback", self.base))
            .json(&body).send().await;
        let created: CreatedTicket = match res {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(c) => c,
                Err(e) => { tracing::warn!(error=%e, "submit json decode"); return None; }
            },
            Ok(r) => { tracing::warn!(status=%r.status(), "submit non-success"); return None; }
            Err(e) => { tracing::warn!(error=%e, "submit transport"); return None; }
        };
        for (filename, mime, bytes) in attachments {
            let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.clone()).mime_str(&mime).ok();
            let Some(part) = part else { continue };
            let form = reqwest::multipart::Form::new().part("file", part);
            let url = format!("{}/v1/feedback/{}/attach?token={}", self.base, created.ticket_id, created.claim_token);
            if let Err(e) = self.http.post(url).multipart(form).send().await {
                tracing::warn!(error=%e, "attach failed (silent)");
            }
        }
        Some(created)
    }

    pub async fn get_status(&self, id: &str, token: &str) -> Option<RemoteTicketView> {
        if !self.is_configured() { return None; }
        match self.http.get(format!("{}/v1/feedback/{}?token={}", self.base, id, token)).send().await {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok().map(|v| RemoteTicketView {
                status: v["status"].as_str().unwrap_or("unknown").to_string(),
                admin_note: v["admin_note"].as_str().map(|s| s.to_string()),
                updated_at: v["updated_at"].as_i64().unwrap_or(0),
            }),
            Ok(r) => { tracing::info!(status=%r.status(), "get_status non-success"); None }
            Err(e) => { tracing::info!(error=%e, "get_status transport"); None }
        }
    }
}
```

- [ ] **Step 4: Wire into `lib.rs`** — initialize `LogBuffer`, install the layer, set up `HubClient`, put both into Tauri state:

```rust
use aaa_core::log_buffer::LogBuffer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

pub fn run() {
    let buf = LogBuffer::new(200);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(crate::log_layer::BufferLayer { buf: buf.clone() })
        .init();

    let settings = aaa_core::settings::load().unwrap_or_default();
    let hub = crate::hub::HubClient::new(&settings.hub);

    tauri::Builder::default()
        .manage(buf)
        .manage(hub)
        // ... existing plugin and commands wiring ...
        .run(tauri::generate_context!())
        .expect("run");
}
```

- [ ] **Step 5: cargo build, commit.**

```bash
git add tools/aaa/src-tauri/
git commit -m "feat(host): HubClient + tracing log buffer layer"
```

---

## Task 19: Five new Tauri commands

**Files:**
- Modify: `tools/aaa/src-tauri/src/commands.rs`
- Modify: `tools/aaa/src-tauri/src/lib.rs` (register handlers)

- [ ] **Step 1: Add the commands** — append to `commands.rs`:

```rust
use aaa_core::feedback::{LocalTicket, LocalTickets};
use aaa_core::log_buffer::LogBuffer;
use aaa_core::log_excerpt;
use crate::hub::{HubClient, HubStatus};
use serde::Deserialize;
use serde_json::json;

#[tauri::command]
pub async fn hub_status(hub: State<'_, HubClient>) -> Result<HubStatus, String> {
    Ok(hub.ping().await)
}

#[derive(Deserialize)]
pub struct FeedbackInput {
    pub category: String,
    pub severity: Option<String>,
    pub title: String,
    pub description: String,
    pub contact_email: Option<String>,
    pub include_version: bool,
    pub include_os: bool,
    pub include_log_excerpt: bool,
    pub include_device_id: bool,
    pub attachments: Vec<FeedbackAttachmentInput>,  // base64 bytes
}

#[derive(Deserialize)]
pub struct FeedbackAttachmentInput {
    pub filename: String,
    pub mime: String,
    pub bytes_b64: String,
}

#[tauri::command]
pub async fn submit_feedback(
    hub: State<'_, HubClient>,
    buf: State<'_, LogBuffer>,
    input: FeedbackInput,
) -> Result<Option<LocalTicket>, String> {
    use base64::Engine;
    let settings = aaa_core::settings::load().map_err(err_to_string)?;
    let body = json!({
        "category": input.category,
        "severity": input.severity,
        "title": input.title,
        "description": input.description,
        "contact_email": input.contact_email,
        "app_version": if input.include_version { env!("CARGO_PKG_VERSION") } else { "redacted" },
        "os_info": if input.include_os { os_info_string() } else { "redacted".into() },
        "device_id": if input.include_device_id { settings.hub.device_id.clone() } else { "anonymous".into() },
        "log_excerpt": if input.include_log_excerpt { Some(log_excerpt::collect(&buf)) } else { None },
    });
    let mut atts = Vec::new();
    for a in input.attachments {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&a.bytes_b64).map_err(err_to_string)?;
        atts.push((a.filename, a.mime, bytes));
    }
    let created = hub.submit(body, atts).await;
    let Some(c) = created else { return Ok(None); };
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let local = LocalTicket {
        id: c.ticket_id.clone(), claim_token: c.claim_token,
        title: input.title, category: input.category, created_at: now,
    };
    aaa_core::feedback::append(local.clone()).map_err(err_to_string)?;
    Ok(Some(local))
}

#[tauri::command]
pub async fn get_feedback_status(
    hub: State<'_, HubClient>,
    id: String, token: String,
) -> Result<Option<crate::hub::RemoteTicketView>, String> {
    Ok(hub.get_status(&id, &token).await)
}

#[tauri::command]
pub fn list_local_tickets() -> Result<LocalTickets, String> {
    aaa_core::feedback::load().map_err(err_to_string)
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    match app.updater().map_err(err_to_string)?.check().await {
        Ok(Some(update)) => Ok(Some(update.version.clone())),
        Ok(None) => Ok(None),
        Err(e) => { tracing::info!(error=%e, "check_update failed"); Ok(None) }
    }
}

fn os_info_string() -> String {
    format!("{}/{}/{}", std::env::consts::OS, std::env::consts::FAMILY, std::env::consts::ARCH)
}
```

- [ ] **Step 2: Register handlers** in `lib.rs::tauri::Builder::default().invoke_handler(tauri::generate_handler![...])` — add `hub_status, submit_feedback, get_feedback_status, list_local_tickets, check_update`.

- [ ] **Step 3: cargo build && cargo test --workspace**, commit.

```bash
git add tools/aaa/src-tauri/
git commit -m "feat(host): 5 new Tauri commands wiring hub + feedback"
```

---

## Task 20: tauri-plugin-updater wiring

**Files:**
- Modify: `tools/aaa/src-tauri/Cargo.toml`
- Modify: `tools/aaa/src-tauri/tauri.conf.json`
- Modify: `tools/aaa/src-tauri/src/lib.rs`

- [ ] **Step 1: Add `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml`.**

- [ ] **Step 2: Edit `tauri.conf.json`** — add a `plugins.updater` section. The endpoint is read from settings at runtime, but tauri-plugin-updater requires a placeholder; we use a "pingback" pattern by setting it to the configured base URL via a JS bridge. Initial config:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://aaa.example.intranet/v1/updates/manifest"],
    "pubkey": "REPLACE_WITH_TAURI_PUBLIC_KEY"
  }
}
```

Document that real deployments need to substitute these values before building. (Per-build customization can come later via `tauri.conf.<env>.json` overrides; out of scope here.)

- [ ] **Step 3: Register the plugin** in `lib.rs::run()`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_dialog::init())
    .manage(buf)
    .manage(hub)
    .invoke_handler(tauri::generate_handler![/* existing + 5 new */])
    .run(tauri::generate_context!())
    .expect("run");
```

- [ ] **Step 4: cargo build, commit.**

```bash
git add tools/aaa/src-tauri/
git commit -m "feat(host): register tauri-plugin-updater"
```

---

## Task 21: UI: api.ts + types.ts wrappers

**Files:**
- Modify: `tools/aaa/src/api.ts`
- Modify: `tools/aaa/src/types.ts`

- [ ] **Step 1: Add types** in `types.ts`:

```ts
export type HubStatus = 'Connected' | 'Disconnected';

export type FeedbackCategory = 'bug' | 'feature' | 'question' | 'other';
export type FeedbackSeverity = 'blocker' | 'major' | 'minor' | 'trivial';

export interface FeedbackAttachmentInput {
  filename: string;
  mime: string;
  bytes_b64: string;
}

export interface FeedbackInput {
  category: FeedbackCategory;
  severity?: FeedbackSeverity;
  title: string;
  description: string;
  contact_email?: string;
  include_version: boolean;
  include_os: boolean;
  include_log_excerpt: boolean;
  include_device_id: boolean;
  attachments: FeedbackAttachmentInput[];
}

export interface LocalTicket {
  id: string;
  claim_token: string;
  title: string;
  category: string;
  created_at: number;
}

export interface LocalTickets { items: LocalTicket[] }

export interface RemoteTicketView {
  status: string;
  admin_note?: string;
  updated_at: number;
}
```

- [ ] **Step 2: Add command wrappers** in `api.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import type { HubStatus, FeedbackInput, LocalTicket, LocalTickets, RemoteTicketView } from './types';

export const hubStatus = () => invoke<HubStatus>('hub_status');
export const submitFeedback = (input: FeedbackInput) =>
  invoke<LocalTicket | null>('submit_feedback', { input });
export const getFeedbackStatus = (id: string, token: string) =>
  invoke<RemoteTicketView | null>('get_feedback_status', { id, token });
export const listLocalTickets = () => invoke<LocalTickets>('list_local_tickets');
export const checkUpdate = () => invoke<string | null>('check_update');
```

- [ ] **Step 3: `npm run build` to verify TS compiles, commit.**

```bash
git add tools/aaa/src/api.ts tools/aaa/src/types.ts
git commit -m "feat(ui): api wrappers + types for hub commands"
```

---

## Task 22: hub_status polling + Toolbar disabled state

**Files:**
- Modify: `tools/aaa/src/App.tsx`
- Modify: `tools/aaa/src/components/Toolbar.tsx`

- [ ] **Step 1: In `App.tsx`** add state + polling:

```tsx
const [hubState, setHubState] = useState<'Connected' | 'Disconnected'>('Disconnected');

useEffect(() => {
  let alive = true;
  const tick = async () => {
    try { const s = await hubStatus(); if (alive) setHubState(s); }
    catch { /* never surface */ }
  };
  tick();
  const t = setInterval(tick, 30 * 60 * 1000);  // 30 min
  return () => { alive = false; clearInterval(t); };
}, []);
```

Pass `hubConnected={hubState === 'Connected'}` into `<Toolbar />`.

- [ ] **Step 2: In `Toolbar.tsx`**, accept the new prop and pass it through to a "反馈" button:

```tsx
<button
  type="button"
  disabled={!hubConnected}
  title={hubConnected ? '提交问题或建议' : '无法连接到 hub'}
  onClick={onOpenFeedback}
>反馈</button>
```

`onOpenFeedback` is a new prop the App provides (it sets state to open the dialog).

- [ ] **Step 3: npm run build, commit.**

```bash
git add tools/aaa/src/App.tsx tools/aaa/src/components/Toolbar.tsx
git commit -m "feat(ui): poll hub status; disable feedback button when offline"
```

---

## Task 23: UpdateBanner

**Files:**
- Create: `tools/aaa/src/components/UpdateBanner.tsx`
- Modify: `tools/aaa/src/App.tsx`

- [ ] **Step 1: Implement `UpdateBanner.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

type State = 'idle' | 'available' | 'downloading' | 'ready' | 'failed';

export function UpdateBanner() {
  const [state, setState] = useState<State>('idle');
  const [version, setVersion] = useState<string>('');
  const [pending, setPending] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const u = await check();
        if (u) { setPending(u); setVersion(u.version); setState('available'); }
      } catch (e) { console.info('updater check failed', e); }
    }, 5_000);
    return () => clearTimeout(t);
  }, []);

  if (state === 'idle' || !pending) return null;

  const install = async () => {
    setState('downloading');
    try {
      let total = 0, got = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        else if (event.event === 'Progress' && total) {
          got += event.data.chunkLength;
          setProgress(Math.round((got / total) * 100));
        }
      });
      setState('ready');
      await relaunch();
    } catch (e) { console.info('update install failed', e); setState('failed'); setTimeout(()=>setState('idle'), 1500); }
  };

  return (
    <div style={{padding:'6px 12px',background:'#fffae5',borderBottom:'1px solid #f0d97a',display:'flex',gap:12,alignItems:'center'}}>
      <span>新版本 v{version} 可用</span>
      {state === 'available' && <><button onClick={install}>立即安装</button><button onClick={() => setState('idle')}>稍后</button></>}
      {state === 'downloading' && <span>下载中 {progress}%</span>}
    </div>
  );
}
```

- [ ] **Step 2: Render `<UpdateBanner />` at the top of `App.tsx`** above the existing layout.

- [ ] **Step 3: npm run build, commit.**

```bash
git add tools/aaa/src/components/UpdateBanner.tsx tools/aaa/src/App.tsx
git commit -m "feat(ui): UpdateBanner using tauri-plugin-updater (silent on failure)"
```

---

## Task 24: FeedbackDialog

**Files:**
- Create: `tools/aaa/src/components/FeedbackDialog.tsx`
- Modify: `tools/aaa/src/App.tsx` (mount the dialog)

- [ ] **Step 1: Implement `FeedbackDialog.tsx`**

```tsx
import { useState } from 'react';
import { submitFeedback } from '../api';
import type { FeedbackCategory, FeedbackSeverity, FeedbackAttachmentInput } from '../types';

interface Props { open: boolean; onClose: () => void; onSubmitted: (id: string) => void }

export function FeedbackDialog({ open, onClose, onSubmitted }: Props) {
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [severity, setSeverity] = useState<FeedbackSeverity | ''>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [incVersion, setIncVersion] = useState(true);
  const [incOs, setIncOs] = useState(true);
  const [incLog, setIncLog] = useState(true);
  const [incDevice, setIncDevice] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;
  const titleLen = title.length;
  const valid = title.trim().length > 0 && titleLen <= 80 && description.trim().length > 0;

  const handleSubmit = async () => {
    if (!valid) return;
    setSubmitting(true); setErr(null);
    try {
      const atts: FeedbackAttachmentInput[] = [];
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) continue;
        const buf = await f.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        atts.push({ filename: f.name, mime: f.type || 'application/octet-stream', bytes_b64: b64 });
      }
      const res = await submitFeedback({
        category, severity: severity || undefined, title, description,
        contact_email: email || undefined,
        include_version: incVersion, include_os: incOs,
        include_log_excerpt: incLog, include_device_id: incDevice,
        attachments: atts,
      });
      if (res) { onSubmitted(res.id); onClose(); }
      else { setErr('反馈未送达，已留存草稿'); }
    } catch (e) { console.info('submit feedback failed', e); setErr('反馈未送达，已留存草稿'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{maxWidth:560}}>
        <h3>提交反馈</h3>
        <label>分类
          <select value={category} onChange={e => setCategory(e.target.value as FeedbackCategory)}>
            <option value="bug">bug</option><option value="feature">feature</option>
            <option value="question">question</option><option value="other">other</option>
          </select>
        </label>
        <label>严重程度（选填）
          <select value={severity} onChange={e => setSeverity(e.target.value as FeedbackSeverity | '')}>
            <option value="">未指定</option>
            <option value="blocker">blocker</option><option value="major">major</option>
            <option value="minor">minor</option><option value="trivial">trivial</option>
          </select>
        </label>
        <label>标题（≤80 字符）<input maxLength={80} value={title} onChange={e=>setTitle(e.target.value)} /></label>
        <label>详细描述<textarea rows={6} value={description} onChange={e=>setDescription(e.target.value)} /></label>
        <label>联系邮箱（选填）<input type="email" value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label>截图（PNG/JPG，最多 10 MB/张）
          <input type="file" multiple accept="image/png,image/jpeg" onChange={e => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        <details>
          <summary>自动附带（可逐项取消）</summary>
          <label><input type="checkbox" checked={incVersion} onChange={e=>setIncVersion(e.target.checked)}/> 应用版本号</label><br/>
          <label><input type="checkbox" checked={incOs} onChange={e=>setIncOs(e.target.checked)}/> 操作系统信息</label><br/>
          <label><input type="checkbox" checked={incLog} onChange={e=>setIncLog(e.target.checked)}/> 近期日志摘要（已脱敏）</label><br/>
          <label><input type="checkbox" checked={incDevice} onChange={e=>setIncDevice(e.target.checked)}/> 客户端设备 id（匿名）</label>
        </details>
        {err && <div style={{color:'#a33'}}>{err}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onClose}>取消</button>
          <button disabled={!valid || submitting} onClick={handleSubmit}>提交</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `App.tsx`** with open/close state. On `onSubmitted`, call into the existing status hint to show "反馈已提交：#<id 短前缀>".

- [ ] **Step 3: npm run build, commit.**

```bash
git add tools/aaa/src/components/FeedbackDialog.tsx tools/aaa/src/App.tsx
git commit -m "feat(ui): FeedbackDialog with auto-attach preview + silent failure"
```

---

## Task 25: FeedbackList (settings tab)

**Files:**
- Create: `tools/aaa/src/components/FeedbackList.tsx`
- Modify: `tools/aaa/src/components/SettingsDialog.tsx`

- [ ] **Step 1: Implement `FeedbackList.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { listLocalTickets, getFeedbackStatus } from '../api';
import type { LocalTicket, RemoteTicketView } from '../types';

interface Row { local: LocalTicket; remote: RemoteTicketView | null }

export function FeedbackList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const t = await listLocalTickets();
        const initial: Row[] = t.items.map(local => ({ local, remote: null }));
        setRows(initial); setLoading(false);
        await Promise.all(initial.map(async (r, i) => {
          try { const remote = await getFeedbackStatus(r.local.id, r.local.claim_token);
                setRows(rs => rs.map((x, j) => j === i ? { ...x, remote } : x)); }
          catch { /* silent */ }
        }));
      } catch (e) { console.info('list local tickets failed', e); setLoading(false); }
    })();
  }, []);

  if (loading) return <div>加载中…</div>;
  if (rows.length === 0) return <div>还没有提交过反馈。</div>;
  return (
    <table>
      <thead><tr><th>时间</th><th>分类</th><th>标题</th><th>状态</th><th>备注</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.local.id}>
            <td>{new Date(r.local.created_at).toLocaleString()}</td>
            <td>{r.local.category}</td>
            <td>{r.local.title}</td>
            <td style={{color: r.remote ? '#0a7' : '#999'}}>{r.remote?.status ?? '未知'}</td>
            <td>{r.remote?.admin_note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Add a tab "我的反馈"** inside `SettingsDialog.tsx` rendering `<FeedbackList />`.

- [ ] **Step 3: npm run build, commit.**

```bash
git add tools/aaa/src/components/FeedbackList.tsx tools/aaa/src/components/SettingsDialog.tsx
git commit -m "feat(ui): FeedbackList tab in settings (silent on missing remote)"
```

---

## Task 26: Final version bump for client integration

**Files:**
- Modify: `tools/aaa/package.json`, `tools/aaa/src-tauri/tauri.conf.json`, `tools/aaa/src-tauri/Cargo.toml`, `tools/aaa/core/Cargo.toml`
- Modify: `tools/aaa/release-notes.txt`

- [ ] **Step 1: Bump 0.9.0 → 0.10.0** (still minor; client gained user-visible feedback + auto-update flow).

- [ ] **Step 2: Prepend the release-notes block**:

```
v0.10.0
-------
- 桌面端接入 aaa-hub：自动检查更新（tauri-plugin-updater）+ 反馈对话框 + "我的反馈"列表
- 反馈表单字段：必填 category/title/description；选填 severity/contact_email/截图；可逐项取消的 version/OS/log_excerpt/device_id
- 网络失败一律静默，仅日志记录；hub 不可达时反馈按钮灰显
- 新增设置项 hub.base_url；首次启动生成匿名 device_id（ULID）

```

- [ ] **Step 3: Run `cargo build --workspace && npm run build && cargo test --workspace`**, all green.

- [ ] **Step 4: Final commit.**

```bash
git add tools/aaa/package.json tools/aaa/src-tauri/tauri.conf.json tools/aaa/src-tauri/Cargo.toml tools/aaa/core/Cargo.toml tools/aaa/release-notes.txt
git commit -m "chore: bump to 0.10.0 — desktop hub integration"
```

---

## Verification

After all tasks complete:

1. `cargo build --workspace` — server + client both compile.
2. `cargo test --workspace` — all server integration tests + core unit tests pass.
3. `cd tools/aaa && PATH=$HOME/.local/node/bin:$PATH npm run build` — frontend builds.
4. End-to-end smoke test:
   - Start `aaa-hub` with a temporary config pointing data_dir to `/tmp/hub`.
   - In settings, set `hub.base_url = http://127.0.0.1:8443`.
   - Run `aaa` dev: `./scripts/dev.sh`.
   - Verify: green hub status, click "反馈" submits successfully, "我的反馈" shows status `new`.
   - Stop the hub. Reload aaa: feedback button greys out, no error toast appears, log shows `hub unreachable`.
   - Start hub again, place an artifact under `/tmp/hub/artifacts/0.99.0/` plus signed `.sig`. Restart aaa. UpdateBanner appears for v0.99.0.


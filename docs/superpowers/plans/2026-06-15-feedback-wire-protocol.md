# Feedback Wire Protocol & Server Release Script — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `aaa-wire` workspace crate as the single source of truth for client↔server message schemas, refactor `server` and `src-tauri` to use it, and add a Linux server release script under `scripts/server/`.

**Architecture:** New lean crate `aaa-wire` (only `serde` + `serde_json` deps) defines `CreateFeedbackRequest`/`CreateFeedbackResponse`/`GetFeedbackResponse`/`AttachmentMeta`/`HealthResponse` plus `Category`/`Severity`/`Status` enums with `#[serde(other)] Unknown` fallback. Each top-level message carries `schema_version: u32` (default-fills when absent). `server` and `src-tauri` both depend on `aaa-wire`; `aaa-core` does not. JSON wire format on `/healthz` and `/v1/feedback` is purely additive — only `schema_version` is new.

**Tech Stack:** Rust 2021, serde, serde_json, axum 0.7, sqlx 0.8 (server), reqwest 0.12 (client), Tauri 2 / React 18 (desktop). Bash for release script.

**Spec:** [docs/superpowers/specs/2026-06-15-feedback-wire-protocol-design.md](../specs/2026-06-15-feedback-wire-protocol-design.md)

---

## File Map

**Create:**
- `wire/Cargo.toml`
- `wire/src/lib.rs`
- `wire/src/version.rs`
- `wire/src/feedback.rs`
- `wire/src/health.rs`
- `server/tests/wire_compat.rs`
- `scripts/server/build-release.sh`
- `scripts/server/config.toml.example`
- `scripts/server/README.md`

**Modify:**
- `Cargo.toml` (workspace members += `wire`)
- `server/Cargo.toml` (add `aaa-wire` dep, version `0.1.0` → `0.1.1`)
- `server/src/domain/mod.rs` (remove `pub mod feedback`)
- `server/src/routes/feedback.rs` (use `aaa_wire::feedback::*`)
- `server/src/routes/health.rs` (return `Json<HealthResponse>`)
- `server/src/notify/mod.rs` (use `aaa_wire::feedback::CreateFeedbackRequest`)
- `server/src/notify/email.rs` (same import switch)
- `server/tests/common/mod.rs` (test harness uses wire types)
- `server/tests/feedback_create.rs` (no functional change required, sanity check)
- `src-tauri/Cargo.toml` (add `aaa-wire` dep, version patch bump)
- `src-tauri/src/hub.rs` (typed request/response)
- `src-tauri/src/hub_commands.rs` (no more `json!()` for feedback body)
- `src-tauri/tauri.conf.json` (version patch bump)
- `core/Cargo.toml` (version patch bump — keep 4-place sync)
- `package.json` (version patch bump)
- `release-notes.txt` (prepend new version block)
- `src/types.ts` (add `schema_version` to feedback types)
- `CLAUDE.md` (add `wire/` to project tree, add Wire compat rules section)

**Delete:**
- `server/src/domain/feedback.rs` (types moved to `aaa-wire`)

---
## Task 1: Create empty `aaa-wire` crate

**Files:**
- Create: `wire/Cargo.toml`
- Create: `wire/src/lib.rs`
- Modify: `Cargo.toml` (root)

- [ ] **Step 1.1: Create `wire/Cargo.toml`**

```toml
[package]
name = "aaa-wire"
version = "0.1.0"
edition = "2021"
description = "Wire schema shared between aaa desktop client and aaa-hub server. Forward-compatible JSON DTOs."

[lib]
name = "aaa_wire"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 1.2: Create `wire/src/lib.rs`**

```rust
//! Wire schema shared by `aaa` desktop client and `aaa-hub` server.
//!
//! # Forward-compatibility rules — three iron laws
//!
//! 1. **New fields MUST be `Option<T>` with `#[serde(default)]`** so that an
//!    older peer that doesn't send the field still parses, and a newer peer
//!    that sends it doesn't break older readers.
//! 2. **Enums MUST carry an `#[serde(other)] Unknown` fallback variant** so
//!    that a value introduced after this code was compiled deserializes to
//!    `Unknown` instead of an error.
//! 3. **Do NOT add `#[serde(deny_unknown_fields)]`** anywhere — readers must
//!    silently ignore fields they don't know about.
//!
//! Each top-level message carries a `schema_version: u32` (defaulted to
//! [`SCHEMA_VERSION`] when missing). Bump [`SCHEMA_VERSION`] only on
//! breaking changes (deletions, renames). Additive changes do NOT bump.
//!
//! Rust types here are the source of truth. The TypeScript mirror in
//! `src/types.ts` is hand-maintained — PR review must keep them aligned.

pub mod feedback;
pub mod health;
pub mod version;

pub use version::SCHEMA_VERSION;
```

- [ ] **Step 1.3: Add `wire` to workspace members**

Modify root `Cargo.toml`:

```toml
[workspace]
members = ["src-tauri", "core", "server", "wire"]
resolver = "2"
```

- [ ] **Step 1.4: Add empty placeholder modules so step 1.5 compiles**

Create `wire/src/version.rs`:
```rust
pub const SCHEMA_VERSION: u32 = 1;
pub(crate) fn default_schema_version() -> u32 { SCHEMA_VERSION }
```

Create `wire/src/feedback.rs`:
```rust
// types added in task 3
```

Create `wire/src/health.rs`:
```rust
// types added in task 4
```

- [ ] **Step 1.5: Verify workspace builds**

Run: `cargo check -p aaa-wire`
Expected: `Compiling aaa-wire ...` then `Finished` with no errors.

- [ ] **Step 1.6: Commit**

```bash
git add Cargo.toml wire/
git commit -m "chore(wire): scaffold aaa-wire workspace crate

New crate that will hold forward-compatible JSON DTOs shared by the
desktop client and aaa-hub server. Empty modules for now; types added
in subsequent commits.

纯 scaffold，无人 depend，桌面端/server 二进制字节不变，跳过版本号 bump。"
```

---
## Task 2: `aaa-wire::feedback` types — TDD

Write enums + DTOs and prove forward-compat behavior.

**Files:**
- Modify: `wire/src/feedback.rs`

- [ ] **Step 2.1: Write the failing test for Unknown enum fallback**

Append to `wire/src/feedback.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_category_falls_back() {
        let json = r#"{"category":"someday_future_value"}"#;
        #[derive(serde::Deserialize)]
        struct Wrap { category: Category }
        let w: Wrap = serde_json::from_str(json).unwrap();
        assert_eq!(w.category, Category::Unknown);
    }
}
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cargo test -p aaa-wire`
Expected: FAIL — `Category` is not defined yet.

- [ ] **Step 2.3: Implement minimal `Category`**

Prepend (above the test module) in `wire/src/feedback.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Bug,
    Feature,
    Question,
    Other,
    #[serde(other)]
    Unknown,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Bug => "bug",
            Category::Feature => "feature",
            Category::Question => "question",
            Category::Other => "other",
            Category::Unknown => "unknown",
        }
    }
}
```

- [ ] **Step 2.4: Run test, expect PASS**

Run: `cargo test -p aaa-wire unknown_category_falls_back`
Expected: PASS.

- [ ] **Step 2.5: Add Severity + Status enums (same shape)**

Append below `Category` block:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker,
    Major,
    Minor,
    Trivial,
    #[serde(other)]
    Unknown,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Blocker => "blocker",
            Severity::Major => "major",
            Severity::Minor => "minor",
            Severity::Trivial => "trivial",
            Severity::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    New,
    Triaged,
    InProgress,
    Resolved,
    Wontfix,
    #[serde(other)]
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::New => "new",
            Status::Triaged => "triaged",
            Status::InProgress => "in_progress",
            Status::Resolved => "resolved",
            Status::Wontfix => "wontfix",
            Status::Unknown => "unknown",
        }
    }
}
```

---
- [ ] **Step 2.6: Add `CreateFeedbackRequest` + test for missing `schema_version` + Optional default**

Append in the test module:

```rust
    #[test]
    fn create_request_defaults_schema_version_when_missing() {
        let json = r#"{
          "category":"bug","title":"t","description":"d",
          "app_version":"0","os_info":"linux","device_id":"0"
        }"#;
        let req: CreateFeedbackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.schema_version, super::super::version::SCHEMA_VERSION);
        assert_eq!(req.category, Category::Bug);
        assert!(req.severity.is_none());
        assert!(req.contact_email.is_none());
        assert!(req.log_excerpt.is_none());
    }

    #[test]
    fn create_request_ignores_unknown_top_level_fields() {
        let json = r#"{
          "category":"bug","title":"t","description":"d",
          "app_version":"0","os_info":"linux","device_id":"0",
          "future_field":"surprise"
        }"#;
        let req: CreateFeedbackRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.category, Category::Bug);
    }
```

Run: `cargo test -p aaa-wire`
Expected: FAIL — `CreateFeedbackRequest` undefined.

- [ ] **Step 2.7: Add `CreateFeedbackRequest` struct**

Append (above the test module) in `wire/src/feedback.rs`:

```rust
use crate::version::default_schema_version;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFeedbackRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub category: Category,
    #[serde(default)]
    pub severity: Option<Severity>,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub contact_email: Option<String>,
    pub app_version: String,
    pub os_info: String,
    pub device_id: String,
    #[serde(default)]
    pub log_excerpt: Option<String>,
}
```

Run: `cargo test -p aaa-wire`
Expected: PASS for both new tests.

- [ ] **Step 2.8: Add remaining DTOs**

Append (above test module):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFeedbackResponse {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub ticket_id: String,
    pub claim_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetFeedbackResponse {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub status: Status,
    pub category: Category,
    #[serde(default)]
    pub severity: Option<Severity>,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub admin_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attachments: Vec<AttachmentMeta>,
}
```

- [ ] **Step 2.9: Add round-trip test for `CreateFeedbackResponse` and `GetFeedbackResponse`**

Append in test module:

```rust
    #[test]
    fn create_response_round_trip() {
        let r = CreateFeedbackResponse {
            schema_version: 1,
            ticket_id: "01H".into(),
            claim_token: "TK".into(),
        };
        let s = serde_json::to_string(&r).unwrap();
        let back: CreateFeedbackResponse = serde_json::from_str(&s).unwrap();
        assert_eq!(back.ticket_id, "01H");
    }

    #[test]
    fn get_response_unknown_status_falls_back() {
        let json = r#"{
          "id":"x","status":"in_review","category":"bug","title":"t","description":"d",
          "created_at":0,"updated_at":0,"attachments":[]
        }"#;
        let r: GetFeedbackResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.status, Status::Unknown);
    }
```

Run: `cargo test -p aaa-wire`
Expected: PASS for all 5 tests.

- [ ] **Step 2.10: Commit**

```bash
git add wire/
git commit -m "feat(wire): feedback DTOs with forward-compat semantics

Category/Severity/Status enums carry Unknown fallback; CreateFeedbackRequest,
CreateFeedbackResponse, GetFeedbackResponse, AttachmentMeta defined with
schema_version default + Optional fields. Five round-trip tests cover
unknown enum value, missing schema_version, ignored unknown fields,
and Status fallback.

仍无 downstream depend，二进制不变，跳过版本号。"
```

---
## Task 3: `aaa-wire::health` type — TDD

**Files:**
- Modify: `wire/src/health.rs`

- [ ] **Step 3.1: Write failing test**

Replace contents of `wire/src/health.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::version::default_schema_version;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_existing_wire_format() {
        // Format produced by current server/src/routes/health.rs.
        let json = r#"{"status":"ok","version":"1.6.0"}"#;
        let h: HealthResponse = serde_json::from_str(json).unwrap();
        assert_eq!(h.status, "ok");
        assert_eq!(h.version, "1.6.0");
        assert_eq!(h.schema_version, crate::SCHEMA_VERSION);
    }

    #[test]
    fn round_trip_includes_schema_version() {
        let h = HealthResponse {
            status: "ok".into(),
            version: "9.9.9".into(),
            schema_version: 1,
        };
        let s = serde_json::to_string(&h).unwrap();
        assert!(s.contains("\"schema_version\":1"));
    }
}
```

Run: `cargo test -p aaa-wire health`
Expected: FAIL — `HealthResponse` undefined.

- [ ] **Step 3.2: Implement `HealthResponse`**

Insert above the test module:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
}
```

Run: `cargo test -p aaa-wire`
Expected: All tests PASS (existing 5 + new 2 = 7).

- [ ] **Step 3.3: Commit**

```bash
git add wire/src/health.rs
git commit -m "feat(wire): HealthResponse mirrors existing /healthz wire shape

Wire format unchanged: {status, version, schema_version?}. Field order
matches existing server output so old clients continue to parse.

仍无 downstream depend，二进制不变。"
```

---
## Task 4: `server` switches feedback types to `aaa-wire`

Refactor only — no externally observable wire-format change beyond adding optional `schema_version`.

**Files:**
- Modify: `server/Cargo.toml`
- Modify: `server/src/domain/mod.rs`
- Delete: `server/src/domain/feedback.rs`
- Modify: `server/src/routes/feedback.rs`
- Modify: `server/src/notify/mod.rs`
- Modify: `server/src/notify/email.rs`
- Modify: `server/tests/common/mod.rs`

- [ ] **Step 4.1: Add `aaa-wire` dependency**

Append to `[dependencies]` in `server/Cargo.toml`:

```toml
aaa-wire = { path = "../wire" }
```

- [ ] **Step 4.2: Drop the `feedback` submodule from domain**

Replace `server/src/domain/mod.rs` with:

```rust
pub mod update;
```

- [ ] **Step 4.3: Delete `server/src/domain/feedback.rs`**

```bash
git rm server/src/domain/feedback.rs
```

- [ ] **Step 4.4: Update `routes/feedback.rs` imports + types**

In `server/src/routes/feedback.rs`:

Replace the line:
```rust
use crate::domain::feedback::*;
```
with:
```rust
use aaa_wire::feedback::{
    AttachmentMeta, Category, CreateFeedbackRequest, CreateFeedbackResponse,
    GetFeedbackResponse, Severity, Status,
};
```

Inside the same file, change struct types throughout the handler bodies:
- `Json<NewFeedback>` → `Json<CreateFeedbackRequest>`
- The `create` handler currently builds `CreateResponse { ticket_id, claim_token }` — change to:

```rust
Json(CreateFeedbackResponse {
    schema_version: aaa_wire::SCHEMA_VERSION,
    ticket_id: id,
    claim_token: claim,
})
```

Add `use aaa_wire::SCHEMA_VERSION;` to the imports.

- Replace local `FeedbackView` struct with `GetFeedbackResponse` — and the `get_one` handler must construct it including `schema_version: aaa_wire::SCHEMA_VERSION`
- Replace local `AttachmentView` struct with `AttachmentMeta`
- The handler currently builds `FeedbackView { id: row.get("id"), status: row.get("status"), category: row.get("category"), severity: row.get("severity"), ... }` — `status`/`category` come back as strings from sqlx. Decode them via:

```rust
fn parse_category(s: &str) -> Category {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(Category::Unknown)
}
fn parse_severity(s: Option<String>) -> Option<Severity> {
    s.map(|v| serde_json::from_value(serde_json::Value::String(v)).unwrap_or(Severity::Unknown))
}
fn parse_status(s: &str) -> Status {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(Status::Unknown)
}
```

Add these helper fns at the bottom of `routes/feedback.rs`. Use them in `get_one` to populate the typed fields. For `attach`'s `AttachmentMeta` building, mirror the existing `AttachmentView` field layout 1:1.

- [ ] **Step 4.5: Update `notify/mod.rs`**

In `server/src/notify/mod.rs`, replace `use crate::domain::feedback::NewFeedback;` with:

```rust
use aaa_wire::feedback::CreateFeedbackRequest as NewFeedback;
```

(Keeping the `NewFeedback` alias avoids changing all call sites in `email.rs` and the test module below.)

- [ ] **Step 4.6: Update `notify/email.rs`**

In `server/src/notify/email.rs`, replace `use crate::domain::feedback::NewFeedback;` with:

```rust
use aaa_wire::feedback::CreateFeedbackRequest as NewFeedback;
```

The body uses `fb.category.as_str()`, `fb.title`, `fb.app_version`, `fb.os_info`, `fb.description` — all preserved on `CreateFeedbackRequest`.

- [ ] **Step 4.7: Update `tests/common/mod.rs`**

In `server/tests/common/mod.rs`, replace:
```rust
async fn feedback_created(&self, _ticket_id: &str, _fb: &aaa_hub::domain::feedback::NewFeedback)
```
with:
```rust
async fn feedback_created(&self, _ticket_id: &str, _fb: &aaa_wire::feedback::CreateFeedbackRequest)
```

- [ ] **Step 4.8: Verify all server tests pass**

Run: `cargo test -p aaa-hub`
Expected: 11 existing tests PASS.

If a test fails because the response body now contains an extra `schema_version` field that an old assertion doesn't expect: that's fine, JSON parsers in tests use `serde_json::Value` and only assert on specific keys; the extra key is ignored. If any test uses strict deserialization, switch it to `serde_json::Value`.

- [ ] **Step 4.9: Bump server version**

In `server/Cargo.toml`, change `version = "0.1.0"` to `version = "0.1.1"`.

- [ ] **Step 4.10: Commit**

```bash
git add server/ Cargo.lock
git commit -m "refactor(server): adopt aaa-wire types for feedback path

server/src/domain/feedback.rs deleted (types moved to aaa-wire). routes,
notify, and tests/common switched to aaa_wire::feedback::*. Wire format
on /v1/feedback is purely additive — only new field is optional
schema_version on responses. server bumped 0.1.0 -> 0.1.1.

桌面端二进制未变，跳过 4 处版本号同步。"
```

---
## Task 5: `server` switches health endpoint to `HealthResponse`

**Files:**
- Modify: `server/src/routes/health.rs`

- [ ] **Step 5.1: Replace `routes/health.rs` body**

```rust
use axum::{routing::get, Json, Router};

use aaa_wire::health::HealthResponse;
use aaa_wire::SCHEMA_VERSION;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/healthz", get(handler))
}

async fn handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: SCHEMA_VERSION,
    })
}
```

- [ ] **Step 5.2: Verify existing health test still passes**

The existing `server/tests/health.rs` asserts:
```rust
assert_eq!(json["status"], "ok");
assert!(json["version"].is_string());
```

Both fields are preserved verbatim. Run: `cargo test -p aaa-hub --test health`
Expected: PASS.

- [ ] **Step 5.3: Commit**

```bash
git add server/src/routes/health.rs
git commit -m "refactor(server): /healthz returns typed HealthResponse

Wire shape is bytewise identical to the previous json!() output, plus
the new optional schema_version field. Existing health test still
asserts on status + version and passes unchanged.

server 已在上一 commit bump 到 0.1.1，此处不再 bump。"
```

---

## Task 6: server forward-compat smoke test

Prove that an older server tolerates a newer client's payload (extra fields, unknown enum values).

**Files:**
- Create: `server/tests/wire_compat.rs`

- [ ] **Step 6.1: Write the test**

Create `server/tests/wire_compat.rs`:

```rust
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn accepts_payload_with_unknown_fields_and_future_enum() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    // Simulate a future client: extra unknown fields, schema_version higher,
    // severity carrying a value the server doesn't know yet.
    let payload = json!({
        "schema_version": 99,
        "category": "bug",
        "severity": "showstopper_v2",
        "title": "future client",
        "description": "should still parse",
        "app_version": "9.9.9",
        "os_info": "linux/future",
        "device_id": "FUTURE",
        "future_metadata": { "anything": [1, 2, 3] }
    });
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/feedback")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(body["ticket_id"].as_str().unwrap().len(), 26);
    // Response should now carry schema_version too.
    assert_eq!(body["schema_version"].as_u64(), Some(1));
}
```

- [ ] **Step 6.2: Verify `CreateFeedbackResponse` carries `schema_version`**

The `create` handler in `server/src/routes/feedback.rs` was already updated in Step 4.4 to construct:
```rust
Json(CreateFeedbackResponse {
    schema_version: aaa_wire::SCHEMA_VERSION,
    ticket_id: id,
    claim_token: claim,
})
```
Sanity-check this is in place before running the test below. If for any reason it is not, add it now and re-run the full server test suite (Step 4.8) before proceeding.

- [ ] **Step 6.3: Run test**

Run: `cargo test -p aaa-hub --test wire_compat`
Expected: PASS.

- [ ] **Step 6.4: Run full server test suite**

Run: `cargo test -p aaa-hub`
Expected: 12 tests PASS (11 original + 1 new).

- [ ] **Step 6.5: Commit**

```bash
git add server/tests/wire_compat.rs
git commit -m "test(server): forward-compat smoke for wire schema

Constructs a payload with unknown fields, an unknown severity enum,
and a higher schema_version; verifies the server still creates the
ticket and stamps its own schema_version on the response.

仅新增测试，server 二进制行为已在 Task 4 调整完毕，此处不动版本号。"
```

---
## Task 7: `src-tauri` switches `hub.rs` to typed wire DTOs

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/hub.rs`
- Modify: `src-tauri/src/hub_commands.rs`

- [ ] **Step 7.1: Add `aaa-wire` dependency**

Append in `[dependencies]` section of `src-tauri/Cargo.toml`:

```toml
aaa-wire = { path = "../wire" }
```

- [ ] **Step 7.2: Replace `submit` body type in `hub.rs`**

In `src-tauri/src/hub.rs`, change the `submit` signature from:

```rust
pub async fn submit(
    &self,
    body: serde_json::Value,
    attachments: Vec<(String, String, Vec<u8>)>,
) -> Option<CreatedTicket> {
```

to:

```rust
pub async fn submit(
    &self,
    req: aaa_wire::feedback::CreateFeedbackRequest,
    attachments: Vec<(String, String, Vec<u8>)>,
) -> Option<CreatedTicket> {
```

Inside the function, change `.json(&body)` to `.json(&req)`.

Then change the response decode from `serde_json::Value` ad-hoc to typed:

```rust
let created_resp: aaa_wire::feedback::CreateFeedbackResponse = match res {
    Ok(r) if r.status().is_success() => match r.json().await {
        Ok(v) => v,
        Err(e) => { log::warn!("submit json decode: {}", e); return None; }
    },
    Ok(r) => { log::warn!("submit non-success: {}", r.status()); return None; }
    Err(e) => { log::warn!("submit transport: {}", e); return None; }
};
let created = CreatedTicket {
    ticket_id: created_resp.ticket_id,
    claim_token: created_resp.claim_token,
};
```

(`CreatedTicket` is the existing local type used by callers; we keep it as the return shape so `hub_commands.rs` and downstream code don't change.)

- [ ] **Step 7.3: Replace `get_status` body decode in `hub.rs`**

Change `get_status` from the `serde_json::Value` + `v["status"].as_str()` style to:

```rust
pub async fn get_status(&self, id: &str, token: &str) -> Option<RemoteTicketView> {
    if !self.is_configured() { return None; }
    match self
        .http
        .get(format!("{}/v1/feedback/{}?token={}", self.base, id, token))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<aaa_wire::feedback::GetFeedbackResponse>()
            .await
            .ok()
            .map(|v| RemoteTicketView {
                status: v.status.as_str().to_string(),
                admin_note: v.admin_note,
                updated_at: v.updated_at,
            }),
        Ok(r) => { log::info!("get_status non-success: {}", r.status()); None }
        Err(e) => { log::info!("get_status transport: {}", e); None }
    }
}
```

- [ ] **Step 7.4: Update `hub_commands.rs` — drop `json!()` body for feedback**

In `src-tauri/src/hub_commands.rs`, replace the `let body = json!({...});` block with a typed construction:

```rust
let req = aaa_wire::feedback::CreateFeedbackRequest {
    schema_version: aaa_wire::SCHEMA_VERSION,
    category: parse_category(&input.category),
    severity: input.severity.as_deref().map(parse_severity),
    title: input.title.clone(),
    description: input.description.clone(),
    contact_email: input.contact_email.clone(),
    app_version,
    os_info,
    device_id,
    log_excerpt: log_excerpt_value,
};
```

Add helper fns at the bottom of `hub_commands.rs`:

```rust
fn parse_category(s: &str) -> aaa_wire::feedback::Category {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(aaa_wire::feedback::Category::Other)
}
fn parse_severity(s: &str) -> aaa_wire::feedback::Severity {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(aaa_wire::feedback::Severity::Trivial)
}
```

Then change `client.submit(body, atts).await` to `client.submit(req, atts).await`.

Remove the now-unused `use serde_json::json;` import if it's no longer referenced elsewhere in the file.

- [ ] **Step 7.5: Verify build**

Run: `cargo check -p aaa`
Expected: clean build, no warnings beyond the existing baseline.

- [ ] **Step 7.6: Smoke test (manual, optional)**

If you have a local `aaa-hub` running, launch the desktop app and submit a test feedback. Verify the ticket lands in the hub DB with all expected fields populated. If no hub is reachable, this step is skipped — the unit-level + type-level checks above suffice.

---
## Task 8: TypeScript wire types alignment

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 8.1: Locate the existing feedback types in `src/types.ts`**

Run: `grep -n "FeedbackCategory\|FeedbackSeverity\|FeedbackAttachmentInput\|RemoteTicketView" src/types.ts`

- [ ] **Step 8.2: Add `schema_version` to feedback request input**

If `src/types.ts` exposes a `FeedbackInput` type that mirrors the Rust `FeedbackInput` (the Tauri command's input, **not** the wire request — the wire request is built inside `hub_commands.rs`), no TS change is required for the request side.

If `src/types.ts` exposes a `RemoteTicketView` (response projection): no `schema_version` field needed there since the projection drops it.

If the file declares any direct mirror of `CreateFeedbackResponse` or `GetFeedbackResponse` (search shows it does NOT today — only `RemoteTicketView`), skip this step.

- [ ] **Step 8.3: Add a TS-side comment pointing at the wire crate**

Append at the bottom of `src/types.ts`:

```ts
// ---
// Wire schema source of truth lives in `wire/src/feedback.rs` and
// `wire/src/health.rs`. The TS types above are projections suitable for
// React state — they intentionally drop `schema_version` and other
// transport-only fields. If a new field is added on the wire that the
// UI must surface, mirror it here by hand.
```

- [ ] **Step 8.4: Verify the frontend builds**

Run: `npm run build`
Expected: Vite produces `dist/` with no TS errors.

> If `npm run build` is unavailable in the executor environment, run `npx tsc --noEmit` instead.

---

## Task 9: Bump desktop version + release notes

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `core/Cargo.toml`
- Modify: `release-notes.txt`

- [ ] **Step 9.1: Read current desktop version**

Run: `grep '"version"' package.json`
Expected: a value like `"version": "1.6.0"`. Compute next as patch: `1.6.0 → 1.6.1`. (If the current version on master differs, use the next patch from that.)

- [ ] **Step 9.2: Bump four version files**

Bump in `package.json` (`"version"` field), `src-tauri/tauri.conf.json` (`"version"` field), `src-tauri/Cargo.toml` (`[package].version`), `core/Cargo.toml` (`[package].version`) — all to the same patch-incremented value.

- [ ] **Step 9.3: Prepend release-notes block**

Open `release-notes.txt` and prepend at the very top:

```
v<NEW_VERSION>
-----
- 引入 aaa-wire crate：客户端与 aaa-hub 服务端共享前向兼容的 JSON wire schema
- 反馈接口请求/响应改为类型化 DTO，新增 schema_version 字段（Optional，旧服务端无感）
- 枚举（category/severity/status）增加 Unknown 兜底变体，未来扩展不会让客户端崩
```

- [ ] **Step 9.4: Verify the four versions match**

Run:
```bash
grep -E '"version"|^version' package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml core/Cargo.toml
```
Expected: all four show the same new version. (`server/Cargo.toml` is independently versioned — do NOT include in this check.)

- [ ] **Step 9.5: Build to ensure release-notes inlines cleanly**

Run: `cargo check -p aaa`
Expected: clean. (`include_str!("../../release-notes.txt")` in `src-tauri/src/commands.rs` re-reads the file — no quoting issues since text only.)

- [ ] **Step 9.6: Commit Tasks 7 + 8 + 9 together**

```bash
git add src-tauri/ src/types.ts package.json core/Cargo.toml release-notes.txt Cargo.lock
git commit -m "feat(client): typed wire DTOs for feedback path; v<NEW_VERSION>

src-tauri/src/hub.rs and hub_commands.rs no longer use serde_json::Value
for feedback request/response. Construction goes through
aaa_wire::feedback::CreateFeedbackRequest; decode goes through
GetFeedbackResponse. Adds schema_version (= 1) to outgoing request body.
Old hubs (without schema_version awareness) ignore unknown fields.

src/types.ts gets a footer comment pointing at wire/ as source of truth.
Four-place version bump + release notes block."
```

---
## Task 10: CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 10.1: Add `wire/` to the project tree**

In `CLAUDE.md`'s 工程结构 code block, locate the line `├── server/            # aaa-hub 服务端...` and insert above it (or right after the `core/` section, whichever is more readable):

```
├── wire/             # aaa-wire crate（客户端↔服务端共享 wire schema 的唯一定义源）
│   └── src/
│       ├── feedback.rs   # CreateFeedbackRequest/Response, GetFeedbackResponse, AttachmentMeta, Category/Severity/Status
│       ├── health.rs     # HealthResponse
│       └── version.rs    # SCHEMA_VERSION 常量 + default 助手
```

Also update the comment on `Cargo.toml` line at the bottom of the tree to mention 4 members:
```
└── Cargo.toml         # workspace = [src-tauri, core, server, wire]
```

- [ ] **Step 10.2: Add a "Wire 兼容规则" section**

Locate the 提交约束（重要） section. After it, before 构建与分发, insert a new section:

```markdown
## Wire 兼容规则（重要）

`wire/` crate 是客户端 ↔ aaa-hub 服务端 wire format 的唯一 Rust 定义源。两侧独立发版，所以演进必须满足：

- **新增字段必须 `Option<T>` + `#[serde(default)]`**：旧客户端不发，新服务端能默认；旧服务端不返回，新客户端能默认。
- **枚举必须有 `#[serde(other)] Unknown` 兜底变体**：避免任何一端引入新值时另一端崩。
- **不要加 `#[serde(deny_unknown_fields)]`**：未知字段必须被 silently 忽略。
- **改 `aaa-wire` 任何 pub 类型，必须同步检查 `src/types.ts`** —— TS 这边是手动 mirror，PR review 守门。
- **删除字段 / 重命名字段 → bump `wire::SCHEMA_VERSION`**，并在 `release-notes.txt` 标注破坏性变更；新增 Optional 字段或新增枚举变体不动 `SCHEMA_VERSION`（前向兼容已由 Optional + Unknown 保证）。
- **server 独立版本号**（`server/Cargo.toml`）：影响外部行为时按 SemVer 走自己的 bump，不与桌面端 4 处同步。
```

- [ ] **Step 10.3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): wire/ crate + Wire 兼容规则 section

纯文档，跳过版本号 bump。"
```

---

## Task 11: `scripts/server/build-release.sh`

**Files:**
- Create: `scripts/server/build-release.sh`
- Create: `scripts/server/config.toml.example`
- Create: `scripts/server/README.md`

- [ ] **Step 11.1: Create `scripts/server/config.toml.example`**

```toml
# aaa-hub server config. Copy to config.toml and edit.
# Pointed at by AAA_HUB_CONFIG env var (default: /etc/aaa-hub/config.toml).

[server]
bind = "0.0.0.0:8080"
public_url = "https://hub.example.com"
data_dir = "/var/lib/aaa-hub"
admin_token = "<change-me>"

[updates]
artifacts_dir = "/var/lib/aaa-hub/artifacts"
pubkey = "<change-me>"

[uploads]
dir = "/var/lib/aaa-hub/uploads"
max_attachment_bytes = 10485760
allowed_mime = ["image/png", "image/jpeg"]

[notify.email]
enabled = false
smtp_host = ""
smtp_port = 587
smtp_user = ""
smtp_password = ""
from = ""
to = []

[ratelimit]
feedback_per_ip_per_hour = 30
manifest_per_ip_per_minute = 60
```

- [ ] **Step 11.2: Create `scripts/server/README.md`**

```markdown
# aaa-hub deploy

Linux only. Built by `scripts/server/build-release.sh`.

## Layout (after extraction)

```
aaa-hub-<ver>-linux-x86_64/
├── aaa-hub                 # bare binary
├── migrations/             # sqlx migrations (loaded at runtime, relative path)
├── admin-ui/               # static admin pages served at /admin
├── config.toml.example     # template
└── README.md               # this file
```

## First-time setup

```bash
tar -xzf aaa-hub-<ver>-linux-x86_64.tar.gz
cd aaa-hub-<ver>-linux-x86_64/
cp config.toml.example config.toml
vim config.toml             # set bind, public_url, admin_token, etc.
mkdir -p $(awk -F\" '/^data_dir/{print $2}' config.toml)
AAA_HUB_CONFIG=./config.toml ./aaa-hub
```

> ⚠️ Working directory must be the dist root because `migrations/` is loaded
> via a relative path baked into the binary (`sqlx::migrate!("./migrations")`).

## systemd unit

`/etc/systemd/system/aaa-hub.service`:

```ini
[Unit]
Description=aaa-hub
After=network.target

[Service]
Type=simple
User=aaa-hub
WorkingDirectory=/opt/aaa-hub
Environment=AAA_HUB_CONFIG=/opt/aaa-hub/config.toml
ExecStart=/opt/aaa-hub/aaa-hub
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/aaa-hub aaa-hub
sudo cp -r aaa-hub-<ver>-linux-x86_64/* /opt/aaa-hub/
sudo chown -R aaa-hub:aaa-hub /opt/aaa-hub
sudo systemctl daemon-reload
sudo systemctl enable --now aaa-hub
```

## nginx reverse proxy (optional)

```nginx
location /v1/ { proxy_pass http://127.0.0.1:8080; }
location /admin { proxy_pass http://127.0.0.1:8080; }
location /healthz { proxy_pass http://127.0.0.1:8080; }
```
```

- [ ] **Step 11.3: Create `scripts/server/build-release.sh`**

```bash
#!/usr/bin/env bash
# Build aaa-hub release tarball for Linux x86_64.
# Usage: ./scripts/server/build-release.sh [--no-bundle]
#
# Outputs:
#   target/server-dist/aaa-hub-<ver>-linux-x86_64/      # dist directory
#   target/server-dist/aaa-hub-<ver>-linux-x86_64.tar.gz # tarball (unless --no-bundle)
set -euo pipefail

NO_BUNDLE=0
for arg in "$@"; do
  case "$arg" in
    --no-bundle) NO_BUNDLE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Resolve workspace root (this script lives at <root>/scripts/server/...).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

VER="$(awk -F'"' '/^version\s*=/{print $2; exit}' server/Cargo.toml)"
if [ -z "$VER" ]; then
  echo "could not parse server version from server/Cargo.toml" >&2
  exit 1
fi

echo ">> building aaa-hub v$VER (release)"
cargo build --release -p aaa-hub

DIST_NAME="aaa-hub-$VER-linux-x86_64"
DIST_DIR="target/server-dist/$DIST_NAME"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp target/release/aaa-hub "$DIST_DIR/aaa-hub"
cp -r server/migrations "$DIST_DIR/migrations"
cp -r server/admin-ui "$DIST_DIR/admin-ui"
cp scripts/server/config.toml.example "$DIST_DIR/config.toml.example"
cp scripts/server/README.md "$DIST_DIR/README.md"

echo ">> dist ready: $DIST_DIR"

if [ "$NO_BUNDLE" -eq 0 ]; then
  TAR="target/server-dist/$DIST_NAME.tar.gz"
  rm -f "$TAR"
  tar -czf "$TAR" -C target/server-dist "$DIST_NAME"
  echo ">> tarball: $TAR"
fi
```

- [ ] **Step 11.4: Make the script executable**

```bash
chmod +x scripts/server/build-release.sh
```

- [ ] **Step 11.5: Smoke test the script (dry build)**

Run: `./scripts/server/build-release.sh --no-bundle`
Expected:
- `cargo build --release -p aaa-hub` runs to completion
- `target/server-dist/aaa-hub-0.1.1-linux-x86_64/` exists with `aaa-hub`, `migrations/`, `admin-ui/`, `config.toml.example`, `README.md`
- No tarball created (because `--no-bundle`)

Then verify the binary actually starts:

```bash
cd target/server-dist/aaa-hub-0.1.1-linux-x86_64/
cp config.toml.example /tmp/aaa-hub-test.toml
sed -i 's|/var/lib/aaa-hub|/tmp/aaa-hub-test|g' /tmp/aaa-hub-test.toml
mkdir -p /tmp/aaa-hub-test/{artifacts,uploads}
sed -i 's|0.0.0.0:8080|127.0.0.1:18080|' /tmp/aaa-hub-test.toml
AAA_HUB_CONFIG=/tmp/aaa-hub-test.toml ./aaa-hub &
SVR=$!
sleep 1
curl -fsS http://127.0.0.1:18080/healthz
echo
kill $SVR
cd "$ROOT"
rm -rf /tmp/aaa-hub-test /tmp/aaa-hub-test.toml
```
Expected: curl prints `{"status":"ok","version":"0.1.1","schema_version":1}`.

- [ ] **Step 11.6: Run with bundle and verify tarball**

Run: `./scripts/server/build-release.sh`
Expected: `target/server-dist/aaa-hub-0.1.1-linux-x86_64.tar.gz` exists.

Verify:
```bash
tar -tzf target/server-dist/aaa-hub-0.1.1-linux-x86_64.tar.gz | head
```
Expected: file list includes `aaa-hub`, `migrations/`, `admin-ui/`, `config.toml.example`, `README.md`.

- [ ] **Step 11.7: Commit**

```bash
git add scripts/server/
git commit -m "build(server): add scripts/server/build-release.sh for Linux

Outputs target/server-dist/aaa-hub-<ver>-linux-x86_64/ with bare binary
+ migrations + admin-ui + config.toml.example + README.md, plus an
optional tarball. Linux x86_64 only.

纯脚本/文档改动，无二进制行为变化，跳过版本号 bump。"
```

---
## Task 12: Final verification and push

- [ ] **Step 12.1: Workspace-wide test pass**

Run from repo root:
```bash
cargo test --workspace
```
Expected:
- `aaa-wire`: 7 tests pass
- `aaa-hub`: 12 tests pass (11 original + wire_compat)
- `aaa-core`: existing tests pass (unchanged)
- `aaa` (src-tauri): builds (no test target changes)

- [ ] **Step 12.2: Frontend type-check**

Run: `npm run build`
Expected: `dist/` produced, no TS errors.

- [ ] **Step 12.3: Verify desktop release-notes inline**

Run: `cargo run -p aaa --release --bin aaa -- --version 2>/dev/null || true`

(Visual confirmation in About dialog is the canonical check; if running headlessly, just confirm `release-notes.txt` was inlined by inspecting the build artifact for the new version block.)

- [ ] **Step 12.4: Push everything**

```bash
git push origin master
```

Expected: all commits from Tasks 1–11 land on remote master. Per CLAUDE.md: "本仓库的'完成'包含 commit + git push origin master 两步".

---

## Self-Review Checklist (writer-side; remove before execution)

- [x] Spec coverage:
  - aaa-wire crate scaffold → Tasks 1–3
  - server adopts wire (feedback) → Task 4
  - server adopts wire (health) → Task 5
  - forward-compat smoke test → Task 6
  - src-tauri adopts wire → Task 7
  - TS types alignment → Task 8
  - desktop version bump + release notes → Task 9
  - CLAUDE.md updates → Task 10
  - server release script → Task 11
  - final test + push → Task 12
- [x] Placeholder scan: no "TBD"/"TODO" — exact code shown for every code step.
- [x] Type consistency: `CreateFeedbackRequest` / `CreateFeedbackResponse` / `GetFeedbackResponse` / `AttachmentMeta` / `HealthResponse` / `Category::Unknown` / `Severity::Unknown` / `Status::Unknown` / `SCHEMA_VERSION` used identically across tasks.
- [x] Version bump policy: Task 4 bumps server `0.1.0 → 0.1.1`; Task 9 bumps the 4-place desktop version + release notes; Tasks 1, 2, 3, 5, 6, 8, 10, 11 do not bump (scaffold-only / docs-only / scripts-only).
- [x] Per-task commit message includes a 中文 reasoning line about why version is or isn't bumped.

---

## Open Questions

无 — all decisions resolved during brainstorming and reflected above.











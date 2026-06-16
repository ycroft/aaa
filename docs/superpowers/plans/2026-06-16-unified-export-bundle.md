# Unified Export Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two existing export commands (`export_session` / `export_all_sessions`) with one unified bundle exporter shared by the toolbar export button and the AI-analysis dialog. Output is a directory containing `manifest.json` + `index.jsonl` + `analysis-guide.md` + `sessions/<id>/{events.jsonl, transcript.md, raw.json}` instead of flat pretty-JSON files.

**Architecture:**
- New `core/src/export.rs` owns bundle assembly. Input is a `Vec<source_path>`, output is a directory layout. No knowledge of Tauri.
- Single Tauri command `export_sessions(provider_id, source_paths, target_dir, scope)` replaces both old commands.
- Frontend converges: toolbar export → wraps active session id into a 1-element list; AI dialog → wraps active session or full provider listing into the same list. Same code path.
- DRY: bundle assembly lives once, all callers go through it.

**Tech Stack:** Rust (core, tauri host), serde_json, std::fs. TypeScript (React) for the call sites. No new dependencies.

---

## File Structure

**Create:**
- `aaa/core/src/export.rs` — bundle builder. Functions: `build_bundle(sessions, target_dir, scope) -> Result<BundlePaths>`. Internally calls helpers `write_manifest`, `write_index_row`, `write_events_jsonl`, `write_transcript_md`, `write_raw_json`, `render_analysis_guide`.
- `aaa/core/src/export/templates/analysis-guide.md.tmpl` — fixed skeleton with `{{INJECT_*}}` placeholders.
- `aaa/core/tests/export_bundle.rs` — integration tests for bundle shape and content.

**Modify:**
- `aaa/core/src/lib.rs` — add `pub mod export;`
- `aaa/src-tauri/src/commands.rs:401-432, 515-553` — delete `export_all_sessions` and `export_session`, add unified `export_sessions`.
- `aaa/src-tauri/src/lib.rs:52,54` — update command registration.
- `aaa/src/api.ts:47-56` — replace `exportSession` / `exportAllSessions` with single `exportSessions`.
- `aaa/src/components/SessionPanel.tsx:165-193` — toolbar handler calls new API with single-session list.
- `aaa/src/components/AiAnalysisDialog.tsx:48-78` — dialog handler calls new API with session list (1 or N).
- `aaa/src/i18n/zh.ts` + `aaa/src/i18n/en.ts` — update strings (status hints reference "bundle" / "目录" instead of "JSON file").
- 4 version fields + `release-notes.txt` — bump minor (new visible feature, breaking command surface).

---

## Task 1: Scaffold core/src/export.rs and add the failing first test

**Files:**
- Create: `aaa/core/src/export.rs`
- Modify: `aaa/core/src/lib.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Add module declaration**

In `aaa/core/src/lib.rs`, add `pub mod export;` right after `pub mod stats;`.

- [ ] **Step 2: Create empty module with public type**

Create `aaa/core/src/export.rs`:

```rust
//! Unified session-export bundle builder.
//!
//! Input: a list of (provider_id, source_path) pairs. Output: a directory
//! layout containing manifest.json + index.jsonl + analysis-guide.md and a
//! sessions/<id>/ subdir per session with events.jsonl + transcript.md +
//! raw.json. Same code path serves the toolbar export button and the
//! AI-analysis dialog — single = N=1, all = N=K.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportScope {
    Single,
    All,
}

#[derive(Debug, Clone)]
pub struct BundleInputs {
    pub provider_id: String,
    pub source_paths: Vec<PathBuf>,
    pub root: Option<PathBuf>,
    pub scope: ExportScope,
}

#[derive(Debug, Clone)]
pub struct BundlePaths {
    pub bundle_dir: PathBuf,
    pub session_count: usize,
}

pub fn build_bundle(_inputs: &BundleInputs, _target_dir: &Path) -> anyhow::Result<BundlePaths> {
    anyhow::bail!("not yet implemented");
}
```

- [ ] **Step 3: Write the first failing test**

Create `aaa/core/tests/export_bundle.rs`:

```rust
use std::path::PathBuf;
use aaa_core::export::{build_bundle, BundleInputs, ExportScope};

#[test]
fn build_bundle_creates_target_directory_and_manifest() {
    let tmp = tempfile::tempdir().expect("tmp");
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![],
        root: None,
        scope: ExportScope::All,
    };
    let out = build_bundle(&inputs, tmp.path()).expect("build");
    assert_eq!(out.session_count, 0);
    assert!(out.bundle_dir.starts_with(tmp.path()));
    assert!(out.bundle_dir.join("manifest.json").is_file());
    assert!(out.bundle_dir.join("index.jsonl").is_file());
    assert!(out.bundle_dir.join("analysis-guide.md").is_file());
    assert!(out.bundle_dir.join("sessions").is_dir());
}
```

Add `tempfile = "3"` to `aaa/core/Cargo.toml` `[dev-dependencies]` if it isn't already.

- [ ] **Step 4: Run the test, verify it fails**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
```

Expected: FAIL — `not yet implemented`.

- [ ] **Step 5: Commit**

```bash
git add aaa/core/src/lib.rs aaa/core/src/export.rs aaa/core/tests/export_bundle.rs aaa/core/Cargo.toml
git commit -m "scaffold(export): unified bundle module + failing first test"
```

---

## Task 2: Bundle directory creation + manifest.json

**Files:**
- Modify: `aaa/core/src/export.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Define the manifest types**

Append to `aaa/core/src/export.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ManifestSkill {
    pub id: String,
    pub display_name: String,
    pub source_path: String,
    pub fingerprint_first_128b: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub aaa_version: String,
    pub schema_version: u32,
    pub provider: String,
    pub root: Option<String>,
    pub export_ts: String,
    pub scope: &'static str,
    pub session_count: usize,
    pub known_skills: Vec<ManifestSkill>,
}

pub const BUNDLE_SCHEMA_VERSION: u32 = 1;
```

- [ ] **Step 2: Add a failing test for manifest content**

Append to `aaa/core/tests/export_bundle.rs`:

```rust
#[test]
fn manifest_contains_version_provider_and_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![],
        root: Some(PathBuf::from("/tmp/example")),
        scope: ExportScope::Single,
    };
    let out = build_bundle(&inputs, tmp.path()).unwrap();
    let m: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out.bundle_dir.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(m["provider"], "claude-code");
    assert_eq!(m["scope"], "single");
    assert_eq!(m["schema_version"], 1);
    assert!(m["aaa_version"].as_str().is_some());
    assert!(m["export_ts"].as_str().is_some());
    assert!(m["known_skills"].is_array());
}
```

- [ ] **Step 3: Implement build_bundle to create the directory and write manifest.json**

Replace the `build_bundle` body in `aaa/core/src/export.rs`:

```rust
use chrono::Utc;
use std::fs;

pub fn build_bundle(inputs: &BundleInputs, target_dir: &Path) -> anyhow::Result<BundlePaths> {
    let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let dir_name = match inputs.scope {
        ExportScope::Single => format!(
            "aaa-export-{}-{}-{}",
            inputs.provider_id,
            inputs
                .source_paths
                .first()
                .and_then(|p| p.file_stem().and_then(|s| s.to_str()))
                .map(|s| &s[..s.len().min(16)])
                .unwrap_or("session"),
            ts
        ),
        ExportScope::All => format!("aaa-export-{}-all-{}", inputs.provider_id, ts),
    };
    let bundle_dir = target_dir.join(&dir_name);
    fs::create_dir_all(bundle_dir.join("sessions"))?;

    let manifest = Manifest {
        aaa_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: BUNDLE_SCHEMA_VERSION,
        provider: inputs.provider_id.clone(),
        root: inputs.root.as_ref().map(|p| p.to_string_lossy().into_owned()),
        export_ts: ts,
        scope: match inputs.scope {
            ExportScope::Single => "single",
            ExportScope::All => "all",
        },
        session_count: inputs.source_paths.len(),
        known_skills: collect_known_skills(&inputs.provider_id),
    };
    fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    fs::write(bundle_dir.join("index.jsonl"), "")?;
    fs::write(bundle_dir.join("analysis-guide.md"), "")?;

    Ok(BundlePaths {
        bundle_dir,
        session_count: inputs.source_paths.len(),
    })
}

fn collect_known_skills(provider_id: &str) -> Vec<ManifestSkill> {
    let Some(provider) = crate::providers::find(provider_id) else {
        return Vec::new();
    };
    let roots = provider.skill_roots(None);
    let reg = crate::skills::SkillRegistry::build(&roots);
    reg.skills()
        .iter()
        .map(|s| ManifestSkill {
            id: s.id.clone(),
            display_name: s.display_name.clone(),
            source_path: s.source_path.to_string_lossy().into_owned(),
            fingerprint_first_128b: s.fingerprint.clone(),
        })
        .collect()
}
```

Note: `chrono` is already a workspace dependency (used by remote/incremental). If not in `core/Cargo.toml`, add it.

- [ ] **Step 4: Run tests, verify both pass**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
```

Expected: PASS for `build_bundle_creates_target_directory_and_manifest` and `manifest_contains_version_provider_and_scope`.

- [ ] **Step 5: Commit**

```bash
git add aaa/core/src/export.rs aaa/core/tests/export_bundle.rs aaa/core/Cargo.toml
git commit -m "feat(export): manifest.json + bundle dir scaffolding"
```

---

## Task 3: index.jsonl — one row per session

**Files:**
- Modify: `aaa/core/src/export.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Define the IndexRow type**

Append to `aaa/core/src/export.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct IndexRow {
    pub session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub total_turns: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub peak_ctx_tokens: u64,
    pub used_skills: Vec<String>,
    pub skill_invocations: u32,
    pub tool_calls: u32,
    pub tool_errors: u32,
    pub anomalies: Vec<String>,
    pub files: IndexFiles,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexFiles {
    pub events: String,
    pub transcript: String,
    pub raw: String,
}
```

- [ ] **Step 2: Add a failing test for index.jsonl**

Append to `aaa/core/tests/export_bundle.rs`. Use the smallest fixture available — the existing smoke tests show how to build a minimal `SessionDetail` in memory; if needed copy the helper. Otherwise gate this test on a real provider session.

```rust
#[test]
fn index_jsonl_has_one_row_per_session_with_files_paths() {
    // Find a real claude-code session to keep the test honest.
    let provider = aaa_core::providers::find("claude-code").unwrap();
    let Some(root) = provider.default_root() else { return; };
    if !root.exists() { return; }
    let sessions = match provider.list_sessions(&root) {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let one = sessions[0].source_path.clone();

    let tmp = tempfile::tempdir().unwrap();
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![PathBuf::from(&one)],
        root: Some(root),
        scope: ExportScope::Single,
    };
    let out = build_bundle(&inputs, tmp.path()).unwrap();
    let index = std::fs::read_to_string(out.bundle_dir.join("index.jsonl")).unwrap();
    let rows: Vec<&str> = index.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(rows.len(), 1);
    let row: serde_json::Value = serde_json::from_str(rows[0]).unwrap();
    assert!(row["session_id"].as_str().unwrap().len() > 0);
    assert!(row["files"]["events"].as_str().unwrap().starts_with("sessions/"));
    assert!(row["files"]["transcript"].as_str().unwrap().ends_with("transcript.md"));
    assert!(row["files"]["raw"].as_str().unwrap().ends_with("raw.json"));
}
```

- [ ] **Step 3: Implement per-session loop + index writer**

Modify `build_bundle` in `aaa/core/src/export.rs`. Replace the empty `index.jsonl` write with a real loop:

```rust
use std::io::Write;

let provider = crate::providers::find(&inputs.provider_id)
    .ok_or_else(|| anyhow::anyhow!("unknown provider: {}", inputs.provider_id))?;

let mut index_file = fs::File::create(bundle_dir.join("index.jsonl"))?;
let sessions_dir = bundle_dir.join("sessions");
let mut session_anomalies: Vec<(String, Vec<String>)> = Vec::new();

for src in &inputs.source_paths {
    let detail = provider.load_session(src)?;
    let sid = detail.summary.session_id.clone();
    let session_subdir = sessions_dir.join(&sid);
    fs::create_dir_all(&session_subdir)?;
    let row = build_index_row(&detail, &sid);
    session_anomalies.push((sid.clone(), row.anomalies.clone()));
    writeln!(index_file, "{}", serde_json::to_string(&row)?)?;
    // events.jsonl / transcript.md / raw.json — Tasks 4-6 will fill these in.
    fs::write(session_subdir.join("events.jsonl"), "")?;
    fs::write(session_subdir.join("transcript.md"), "")?;
    fs::write(
        session_subdir.join("raw.json"),
        serde_json::to_string_pretty(&detail)?,
    )?;
}
```

- [ ] **Step 4: Implement build_index_row helper**

Append to `aaa/core/src/export.rs`:

```rust
fn build_index_row(detail: &crate::model::SessionDetail, sid: &str) -> IndexRow {
    let s = &detail.summary;
    let mut tool_calls: u32 = 0;
    let mut tool_errors: u32 = 0;
    for n in &detail.nodes {
        for p in &n.parts {
            match p {
                crate::model::MessagePart::ToolUse { .. } => tool_calls += 1,
                crate::model::MessagePart::ToolResult { is_error: true, .. } => tool_errors += 1,
                _ => {}
            }
        }
    }
    let skill_rows = crate::stats::skill_usage(detail);
    let skill_invocations: u32 = skill_rows.iter().map(|r| r.count).sum();
    let anomalies = detect_anomalies(detail);
    IndexRow {
        session_id: sid.to_string(),
        title: s.title.clone(),
        cwd: s.cwd.clone(),
        branch: s.git_branch.clone(),
        started_at: s.started_at.clone(),
        ended_at: s.ended_at.clone(),
        total_turns: s.message_count,
        input_tokens: s.total_input_tokens,
        output_tokens: s.total_output_tokens,
        peak_ctx_tokens: s.peak_context_tokens,
        used_skills: s.used_skills.clone(),
        skill_invocations,
        tool_calls,
        tool_errors,
        anomalies,
        files: IndexFiles {
            events: format!("sessions/{}/events.jsonl", sid),
            transcript: format!("sessions/{}/transcript.md", sid),
            raw: format!("sessions/{}/raw.json", sid),
        },
    }
}

fn detect_anomalies(detail: &crate::model::SessionDetail) -> Vec<String> {
    // Stub for Task 4: we'll fill ctx_jump / tool_retry detection there.
    // For now, flag peak_ctx > 80% of best-known model window only when easy;
    // otherwise leave empty so the row is well-formed.
    let _ = detail;
    Vec::new()
}
```

- [ ] **Step 5: Run tests, commit**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
```

Expected: all three tests PASS (or skip on missing fixtures).

```bash
git add aaa/core/src/export.rs aaa/core/tests/export_bundle.rs
git commit -m "feat(export): index.jsonl with per-session row + per-session subdirs"
```

---

## Task 4: events.jsonl — per-node table with skill_id, ctx, tool, retry

**Files:**
- Modify: `aaa/core/src/export.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Define EventRow**

Append to `aaa/core/src/export.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct EventRow {
    pub i: u32,
    pub id: String,
    pub ts: Option<String>,
    pub kind: String,
    pub model: Option<String>,
    pub tool: Option<String>,
    pub tool_input_brief: Option<String>,
    pub ctx_after: Option<u64>,
    pub ctx_jump_pct: Option<f64>,
    pub tok_in: Option<u64>,
    pub tok_out: Option<u64>,
    pub dur_ms: Option<u64>,
    pub skill_id: Option<String>,
    pub is_error: bool,
    pub retry_of: Option<String>,
    pub text_brief: Option<String>,
}
```

- [ ] **Step 2: Add a failing test**

Append to `aaa/core/tests/export_bundle.rs`:

```rust
#[test]
fn events_jsonl_has_one_row_per_node_with_kind_and_brief() {
    let provider = aaa_core::providers::find("claude-code").unwrap();
    let Some(root) = provider.default_root() else { return; };
    if !root.exists() { return; }
    let sessions = match provider.list_sessions(&root) {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let one = sessions[0].source_path.clone();
    let detail = provider.load_session(&PathBuf::from(&one)).unwrap();
    if detail.nodes.is_empty() { return; }

    let tmp = tempfile::tempdir().unwrap();
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![PathBuf::from(&one)],
        root: Some(root),
        scope: ExportScope::Single,
    };
    let out = build_bundle(&inputs, tmp.path()).unwrap();
    let events_path = out.bundle_dir.join(format!("sessions/{}/events.jsonl", detail.summary.session_id));
    let s = std::fs::read_to_string(&events_path).unwrap();
    let rows: Vec<&str> = s.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(rows.len(), detail.nodes.len());
    let first: serde_json::Value = serde_json::from_str(rows[0]).unwrap();
    assert_eq!(first["i"], 0);
    assert!(first["kind"].as_str().is_some());
}
```

- [ ] **Step 3: Implement write_events_jsonl using shared SkillDetector**

Append to `aaa/core/src/export.rs`. Reuse the existing skill pipeline so we don't reinvent detection:

```rust
fn write_events_jsonl(
    detail: &crate::model::SessionDetail,
    file: &mut fs::File,
) -> anyhow::Result<()> {
    use crate::model::{MessagePart, NodeKind};

    // Run the canonical skill detector once; map node_id -> skill_id for fast lookup.
    let provider = crate::providers::find(&detail.summary.provider_id);
    let cwd = detail.summary.cwd.as_deref().map(std::path::Path::new);
    let roots = provider.as_ref().map(|p| p.skill_roots(cwd)).unwrap_or_default();
    let registry = crate::skills::SkillRegistry::build(&roots);
    let mut detector = crate::skill_detect::SkillDetector::new(&registry);
    crate::skill_detect::walk_session_nodes(&detail.nodes, &mut detector);
    let usage = detector.into_usage_rows();
    let mut node_skill: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for u in &usage {
        for nid in &u.node_ids {
            node_skill.insert(nid.clone(), u.skill_id.clone());
        }
    }

    // Track tool retry chains: identical (tool_name, input) within the session
    // points back to its predecessor node id.
    let mut last_seen: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    let mut prev_ctx: Option<u64> = None;

    for (i, n) in detail.nodes.iter().enumerate() {
        let mut tool: Option<String> = None;
        let mut tool_input_brief: Option<String> = None;
        let mut retry_of: Option<String> = None;
        let mut is_error = false;
        let mut text_brief: Option<String> = None;
        for p in &n.parts {
            match p {
                MessagePart::ToolUse { name, input, .. } => {
                    if tool.is_none() {
                        tool = Some(name.clone());
                        tool_input_brief = Some(brief(input, 120));
                        let key = (name.clone(), input.clone());
                        if let Some(prev_id) = last_seen.get(&key) {
                            retry_of = Some(prev_id.clone());
                        }
                        last_seen.insert(key, n.id.clone());
                    }
                }
                MessagePart::ToolResult { is_error: e, .. } => {
                    if *e { is_error = true; }
                }
                MessagePart::Text { text } | MessagePart::Thinking { text } => {
                    if text_brief.is_none() && !text.is_empty() {
                        text_brief = Some(brief(text, 120));
                    }
                }
                _ => {}
            }
        }

        let ctx_after = n.cumulative_context_tokens;
        let ctx_jump_pct = match (prev_ctx, ctx_after) {
            (Some(prev), Some(curr)) if prev > 0 && curr >= prev => {
                Some((curr - prev) as f64 / prev as f64)
            }
            _ => None,
        };
        if ctx_after.is_some() { prev_ctx = ctx_after; }

        let row = EventRow {
            i: i as u32,
            id: n.id.clone(),
            ts: n.timestamp.clone(),
            kind: kind_str(&n.kind).to_string(),
            model: n.model.clone(),
            tool,
            tool_input_brief,
            ctx_after,
            ctx_jump_pct,
            tok_in: n.usage.as_ref().map(|u| u.input_tokens),
            tok_out: n.usage.as_ref().map(|u| u.output_tokens),
            dur_ms: n.usage.as_ref().and_then(|u| u.generation_duration_ms),
            skill_id: node_skill.get(&n.id).cloned(),
            is_error,
            retry_of,
            text_brief,
        };
        writeln!(file, "{}", serde_json::to_string(&row)?)?;
    }
    Ok(())
}

fn kind_str(k: &crate::model::NodeKind) -> &'static str {
    use crate::model::NodeKind::*;
    match k {
        User => "user", Assistant => "assistant", System => "system",
        ToolResult => "tool_result", Sidechain => "sidechain", Meta => "meta",
    }
}

fn brief(s: &str, max_chars: usize) -> String {
    let trimmed: String = s.chars().take(max_chars).collect();
    let cleaned = trimmed.replace('\n', " ").replace('\r', " ");
    if s.chars().count() > max_chars { format!("{}…", cleaned) } else { cleaned }
}
```

- [ ] **Step 4: Wire write_events_jsonl into the bundle loop**

In `build_bundle`, replace the `fs::write(session_subdir.join("events.jsonl"), "")?;` line with:

```rust
let mut events_file = fs::File::create(session_subdir.join("events.jsonl"))?;
write_events_jsonl(&detail, &mut events_file)?;
```

- [ ] **Step 5: Tighten detect_anomalies using the same signal pass**

Replace the stub `detect_anomalies` body in `aaa/core/src/export.rs`:

```rust
fn detect_anomalies(detail: &crate::model::SessionDetail) -> Vec<String> {
    let mut out = Vec::new();
    let mut prev_ctx: Option<u64> = None;
    let mut retry_count = 0u32;
    let mut last_seen: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for n in &detail.nodes {
        if let Some(curr) = n.cumulative_context_tokens {
            if let Some(prev) = prev_ctx {
                if prev > 0 && curr > prev {
                    let pct = (curr - prev) as f64 / prev as f64;
                    if pct >= 0.30 {
                        out.push(format!("ctx_jump@{}", n.id));
                    }
                }
            }
            prev_ctx = Some(curr);
        }
        for p in &n.parts {
            if let crate::model::MessagePart::ToolUse { name, input, .. } = p {
                let key = (name.clone(), input.clone());
                if last_seen.contains_key(&key) {
                    retry_count += 1;
                    if retry_count >= 4 {
                        out.push(format!("tool_retry_loop@{}", n.id));
                        retry_count = 0;
                    }
                } else {
                    retry_count = 0;
                    last_seen.insert(key, n.id.clone());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}
```

- [ ] **Step 6: Run + commit**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
git add aaa/core/src/export.rs aaa/core/tests/export_bundle.rs
git commit -m "feat(export): events.jsonl + ctx_jump / tool_retry anomaly detection"
```

---

## Task 5: transcript.md — readable narrative with truncated tool results

**Files:**
- Modify: `aaa/core/src/export.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Add a failing test**

Append to `aaa/core/tests/export_bundle.rs`:

```rust
#[test]
fn transcript_md_contains_per_node_headers() {
    let provider = aaa_core::providers::find("claude-code").unwrap();
    let Some(root) = provider.default_root() else { return; };
    if !root.exists() { return; }
    let sessions = match provider.list_sessions(&root) {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let one = sessions[0].source_path.clone();
    let detail = provider.load_session(&PathBuf::from(&one)).unwrap();
    if detail.nodes.is_empty() { return; }

    let tmp = tempfile::tempdir().unwrap();
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![PathBuf::from(&one)],
        root: Some(root),
        scope: ExportScope::Single,
    };
    let out = build_bundle(&inputs, tmp.path()).unwrap();
    let path = out.bundle_dir.join(format!("sessions/{}/transcript.md", detail.summary.session_id));
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.starts_with("# "));
    assert!(content.contains("\n## "));
}
```

- [ ] **Step 2: Implement write_transcript_md**

Append to `aaa/core/src/export.rs`:

```rust
const TOOL_RESULT_HEAD_LINES: usize = 20;
const TOOL_RESULT_TAIL_LINES: usize = 5;

fn write_transcript_md(detail: &crate::model::SessionDetail, file: &mut fs::File) -> anyhow::Result<()> {
    use crate::model::MessagePart;
    let s = &detail.summary;
    writeln!(file, "# {}", s.title.clone().unwrap_or_else(|| s.session_id.clone()))?;
    writeln!(file, "")?;
    writeln!(file, "- session_id: `{}`", s.session_id)?;
    writeln!(file, "- provider: `{}`", s.provider_id)?;
    if let Some(c) = &s.cwd { writeln!(file, "- cwd: `{}`", c)?; }
    if let Some(b) = &s.git_branch { writeln!(file, "- branch: `{}`", b)?; }
    if let Some(t) = &s.started_at { writeln!(file, "- started_at: {}", t)?; }
    if let Some(t) = &s.ended_at { writeln!(file, "- ended_at: {}", t)?; }
    writeln!(file, "")?;

    for (i, n) in detail.nodes.iter().enumerate() {
        let kind = kind_str(&n.kind);
        let ts = n.timestamp.clone().unwrap_or_default();
        writeln!(file, "## [{}] {} {}", i, kind, ts)?;
        if let Some(m) = &n.model { writeln!(file, "_model: {}_", m)?; }
        writeln!(file, "")?;
        for p in &n.parts {
            match p {
                MessagePart::Text { text } => writeln!(file, "{}\n", text)?,
                MessagePart::Thinking { text } => writeln!(file, "> _thinking:_ {}\n", brief(text, 400))?,
                MessagePart::ToolUse { name, input, tool_use_id } => {
                    writeln!(file, "**tool_use** `{}` (id `{}`)\n```\n{}\n```\n", name, tool_use_id, brief(input, 400))?;
                }
                MessagePart::ToolResult { tool_use_id, content, is_error } => {
                    let head_marker = if *is_error { "**tool_result (ERROR)**" } else { "**tool_result**" };
                    writeln!(file, "{} ← `{}`\n```", head_marker, tool_use_id)?;
                    writeln!(file, "{}", truncate_lines(content, TOOL_RESULT_HEAD_LINES, TOOL_RESULT_TAIL_LINES))?;
                    writeln!(file, "```\n")?;
                }
                MessagePart::Image { media_type, bytes } => writeln!(file, "_image: {} ({} bytes)_\n", media_type, bytes)?,
                MessagePart::Attachment { path, .. } => writeln!(file, "_attachment: {}_\n", path)?,
                MessagePart::Note { text } => writeln!(file, "> _note:_ {}\n", brief(text, 400))?,
            }
        }
    }
    Ok(())
}

fn truncate_lines(s: &str, head: usize, tail: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() <= head + tail { return s.to_string(); }
    let omitted = lines.len() - head - tail;
    let mut out = lines[..head].join("\n");
    out.push_str(&format!("\n[+{} more lines]\n", omitted));
    out.push_str(&lines[lines.len() - tail..].join("\n"));
    out
}
```

- [ ] **Step 3: Wire into bundle loop**

Replace `fs::write(session_subdir.join("transcript.md"), "")?;` with:

```rust
let mut transcript_file = fs::File::create(session_subdir.join("transcript.md"))?;
write_transcript_md(&detail, &mut transcript_file)?;
```

- [ ] **Step 4: Run + commit**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
git add aaa/core/src/export.rs aaa/core/tests/export_bundle.rs
git commit -m "feat(export): transcript.md narrative with truncated tool_result"
```

---

## Task 6: analysis-guide.md — fixed skeleton + injected facts

**Files:**
- Modify: `aaa/core/src/export.rs`
- Test: `aaa/core/tests/export_bundle.rs`

- [ ] **Step 1: Add a failing test**

```rust
#[test]
fn analysis_guide_renders_with_injected_facts() {
    let tmp = tempfile::tempdir().unwrap();
    let inputs = BundleInputs {
        provider_id: "claude-code".into(),
        source_paths: vec![],
        root: None,
        scope: ExportScope::All,
    };
    let out = build_bundle(&inputs, tmp.path()).unwrap();
    let s = std::fs::read_to_string(out.bundle_dir.join("analysis-guide.md")).unwrap();
    assert!(s.contains("# AAA Session Export — Analysis Guide"));
    assert!(s.contains("## Bundle layout"));
    assert!(s.contains("## Reading order"));
    assert!(s.contains("provider: `claude-code`"));
    assert!(s.contains("session_count: 0"));
}
```

- [ ] **Step 2: Implement render_analysis_guide as an inline string**

Append to `aaa/core/src/export.rs`. Keep template inline (single string) so no extra include_str! plumbing is needed:

```rust
fn render_analysis_guide(manifest: &Manifest, anomalies: &[(String, Vec<String>)]) -> String {
    let mut hi = String::new();
    for (sid, items) in anomalies {
        if items.is_empty() { continue; }
        hi.push_str(&format!("- `{}`: {}\n", sid, items.join(", ")));
    }
    if hi.is_empty() { hi.push_str("- (none flagged)\n"); }
    format!(r#"# AAA Session Export — Analysis Guide

> This bundle is the canonical input for AI-driven analysis of AAA sessions.
> aaa version: `{aaa}` · schema_version: `{schema}` · provider: `{provider}` · scope: `{scope}` · session_count: {count}

## Bundle layout

```
manifest.json              head + known_skills inventory
index.jsonl                one row per session (peak_ctx, used_skills, anomalies)
analysis-guide.md          this file
sessions/<id>/
    events.jsonl           one row per node (skill_id, ctx_after, tool, retry_of)
    transcript.md          narrative drill-down with truncated tool_result bodies
    raw.json               full SessionDetail; fidelity escape hatch
```

## Reading order

1. Skim `index.jsonl` to pick interesting sessions (peak_ctx_pct, anomalies, skill counts).
2. Open `sessions/<id>/events.jsonl` for grep / per-node analysis.
3. Use `transcript.md` only when prose context is needed.
4. `raw.json` is for fidelity / regression — avoid as first read.

## Pre-computed signals (don't re-derive)

- `events.jsonl.skill_id` — already filled by the canonical `core::skill_detect` pipeline.
- `events.jsonl.ctx_jump_pct` — running pct against previous node's `cumulative_context_tokens`.
- `events.jsonl.retry_of` — same `(tool, input)` predecessor node id.
- `index.jsonl.anomalies` — strings like `ctx_jump@<node>`, `tool_retry_loop@<node>`.
- `manifest.json.known_skills` — every SKILL.md the provider can see; use this for "should this skill have triggered?" reasoning.

## Sessions with flagged anomalies

{hi}
"#,
    aaa = manifest.aaa_version, schema = manifest.schema_version,
    provider = manifest.provider, scope = manifest.scope, count = manifest.session_count,
    hi = hi)
}
```

- [ ] **Step 3: Wire into bundle**

In `build_bundle`, replace the empty `analysis-guide.md` write. After the per-session loop:

```rust
fs::write(
    bundle_dir.join("analysis-guide.md"),
    render_analysis_guide(&manifest, &session_anomalies),
)?;
```

- [ ] **Step 4: Run + commit**

```bash
cd aaa && cargo test -p aaa-core --test export_bundle
git add aaa/core/src/export.rs aaa/core/tests/export_bundle.rs
git commit -m "feat(export): analysis-guide.md skeleton with anomaly hints"
```

---

## Task 7: Replace Tauri commands with unified export_sessions

**Files:**
- Modify: `aaa/src-tauri/src/commands.rs:401-432, 515-553`
- Modify: `aaa/src-tauri/src/lib.rs:52,54`

- [ ] **Step 1: Delete old commands and add unified one**

In `aaa/src-tauri/src/commands.rs`, remove the entire `export_all_sessions` function (lines 398-433) and `export_session` function (lines 512-553). Replace with:

```rust
/// Export one or more sessions as a unified bundle directory.
/// Returns the absolute path of the bundle directory.
#[tauri::command]
pub fn export_sessions(
    provider_id: String,
    source_paths: Vec<String>,
    root: Option<String>,
    target_dir: String,
    scope: String,
) -> Result<String, String> {
    info!(
        "cmd export_sessions provider={} sessions={} target_dir={} scope={}",
        provider_id, source_paths.len(), target_dir, scope
    );
    let res: Result<String, String> = (|| {
        let scope = match scope.as_str() {
            "single" => aaa_core::export::ExportScope::Single,
            "all" => aaa_core::export::ExportScope::All,
            other => return Err(format!("invalid scope: {}", other)),
        };
        let inputs = aaa_core::export::BundleInputs {
            provider_id,
            source_paths: source_paths.into_iter().map(PathBuf::from).collect(),
            root: root.map(PathBuf::from),
            scope,
        };
        let dir = PathBuf::from(&target_dir);
        std::fs::create_dir_all(&dir).map_err(err_to_string)?;
        let out = aaa_core::export::build_bundle(&inputs, &dir).map_err(err_to_string)?;
        let canonical = std::fs::canonicalize(&out.bundle_dir)
            .unwrap_or(out.bundle_dir)
            .to_string_lossy()
            .into_owned();
        Ok(canonical)
    })();
    warn_on_err("export_sessions", res)
}
```

- [ ] **Step 2: Update command registration**

In `aaa/src-tauri/src/lib.rs`, replace the lines `commands::export_session,` and `commands::export_all_sessions,` with a single `commands::export_sessions,`.

- [ ] **Step 3: Build + commit**

```bash
cd aaa && cargo build -p aaa
git add aaa/src-tauri/src/commands.rs aaa/src-tauri/src/lib.rs
git commit -m "refactor(commands): unify export_session + export_all_sessions into export_sessions"
```

---

## Task 8: Frontend converges on single API

**Files:**
- Modify: `aaa/src/api.ts:47-56`
- Modify: `aaa/src/components/SessionPanel.tsx:165-193`
- Modify: `aaa/src/components/AiAnalysisDialog.tsx:48-78`
- Modify: `aaa/src/i18n/zh.ts`, `aaa/src/i18n/en.ts`

- [ ] **Step 1: Replace api.ts methods**

Remove `exportSession` (lines 47-52) and `exportAllSessions` (lines 55-56). Add:

```ts
exportSessions: (
  providerId: string,
  sourcePaths: string[],
  root: string | null,
  targetDir: string,
  scope: "single" | "all",
) =>
  invoke<string>("export_sessions", { providerId, sourcePaths, root, targetDir, scope }),
```

- [ ] **Step 2: Update SessionPanel toolbar export handler**

In `aaa/src/components/SessionPanel.tsx`, replace the body of `handleExport` (lines 165-193). Drop `sanitizeFileName` / `exportTimestamp` usage — bundle dir naming is owned by core:

```tsx
const handleExport = useCallback(async () => {
  if (!activeSession) return;
  const targetDir = await openDialog({ directory: true, multiple: false });
  if (typeof targetDir !== "string") {
    setStatus(t("status.export_cancelled"));
    return;
  }
  setExporting(true);
  setError(null);
  try {
    const bundleDir = await api.exportSessions(
      backend.provider.id,
      [activeSession.summary.source_path],
      backend.root,
      targetDir,
      "single",
    );
    setStatus(t("status.exported_to", { path: shortPath(bundleDir, 60) }));
  } catch (e: unknown) {
    setError(String(e));
    setStatus(t("status.export_failed"));
  } finally {
    setExporting(false);
  }
}, [activeSession, backend.provider.id, backend.root, t]);
```

- [ ] **Step 3: Update AiAnalysisDialog**

In `aaa/src/components/AiAnalysisDialog.tsx`, replace the export branch in `handleStart` (lines 56-67):

```tsx
const sourcePaths =
  scope === "all"
    ? (await api.listSessions(active.provider.id, active.root)).map((s) => s.source_path)
    : activeSession ? [activeSession.summary.source_path] : [];
if (sourcePaths.length === 0) return;

const bundleDir = await api.exportSessions(
  active.provider.id,
  sourcePaths,
  active.root,
  workDir,
  scope,
);

const fullPrompt = [
  promptText,
  appendText,
  `\n${t("ai_dialog.exported_files_label")}\n- ${bundleDir}`,
].filter(Boolean).join("\n\n");
```

Drop the `sanitizeFileName` import if it becomes unused.

- [ ] **Step 4: Adjust i18n status strings**

In `aaa/src/i18n/zh.ts` change `export_session_hint` to `"将已加载的会话保存为分析 bundle 目录"`. Mirror in `en.ts`. Search for any other strings that say "JSON file" and adjust to "bundle" / "目录".

- [ ] **Step 5: TypeScript check + commit**

```bash
cd aaa && npx tsc --noEmit
git add aaa/src/api.ts aaa/src/components/SessionPanel.tsx aaa/src/components/AiAnalysisDialog.tsx aaa/src/i18n/zh.ts aaa/src/i18n/en.ts
git commit -m "refactor(ui): converge toolbar export and AI dialog on exportSessions"
```

---

## Task 9: Version bump + release notes + final verification

**Files:**
- Modify: `aaa/package.json`, `aaa/src-tauri/tauri.conf.json`, `aaa/src-tauri/Cargo.toml`, `aaa/core/Cargo.toml`
- Modify: `aaa/release-notes.txt`

- [ ] **Step 1: Bump version to 1.8.0 in 4 places**

This is a minor bump — it's a visible feature change and breaks the command surface. Update each file's version field from `1.7.3` to `1.8.0`.

- [ ] **Step 2: Prepend a release-notes block**

Open `aaa/release-notes.txt` and insert at the top:

```
v1.8.0
-------
- 导出功能重构：无论是工具栏的"导出当前会话"还是 AI 辅助分析对话框，现在都产出统一的 bundle 目录（manifest.json + index.jsonl + analysis-guide.md + sessions/<id>/{events.jsonl, transcript.md, raw.json}），不再是单一 pretty-printed JSON 文件。AI 自分析时可以先扫 index.jsonl 挑可疑会话再下钻，token 占用大幅下降；想看完整原始数据时打开 raw.json 即可。
- bundle 内置上下文跳跃（≥30%）和工具重试链（≥4 次同入参）异常标记，以及 manifest 里的"本机已知 skill 清单"，方便 AI 推理"这里本该触发哪个 skill"。
```

- [ ] **Step 3: Run full verification**

```bash
cd aaa && cargo build -p aaa-core && cargo test -p aaa-core
cd aaa && PATH=$HOME/.local/node/bin:$PATH npx tsc --noEmit
cd aaa && PATH=$HOME/.local/node/bin:$PATH ./scripts/build-release.sh --no-bundle
```

Expected: all green, `target/release/aaa` produced.

- [ ] **Step 4: Smoke test the binary manually**

Launch `target/release/aaa`, click toolbar export on a session, verify a bundle directory appears with the correct layout. Open AI dialog with scope=all, verify same shape.

- [ ] **Step 5: Final commit + push**

```bash
git add aaa/package.json aaa/src-tauri/tauri.conf.json aaa/src-tauri/Cargo.toml aaa/core/Cargo.toml aaa/release-notes.txt
git commit -m "chore(release): v1.8.0 — unified export bundle"
git push origin master
```

---

## Self-review checklist

- Spec coverage: every concern from the design (manifest with known_skills, index per session, events with skill_id/ctx/retry, transcript with truncation, analysis-guide as fixed-skeleton entry, single-vs-all = scope flag) → mapped to Tasks 2/3/4/5/6/7.
- Placeholder scan: no `TBD` / `similar to` / `add validation`. Anomaly stub in Task 3 is intentionally replaced in Task 4 step 5.
- Type consistency: `BundleInputs`, `ExportScope`, `BundlePaths`, `Manifest`, `IndexRow`, `EventRow` names match across all references.
- DRY: skill detection reuses `core::skill_detect::SkillDetector` + `walk_session_nodes`; no per-export reimplementation.
- The toolbar and the AI dialog both go through `api.exportSessions` + `commands::export_sessions` + `core::export::build_bundle`. One code path.


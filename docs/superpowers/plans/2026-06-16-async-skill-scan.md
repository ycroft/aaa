# Async Skill Scan on Session List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 skill 检测从 `list_sessions` 路径里抽出去做成异步后台 pass，开数据源时列表立即出现，chips 区域留空，扫完逐行淡入；状态栏显示 `scanning skills (k/N)`。

**Architecture:** `SessionProvider` trait 多一个 `scan_session_skills(source_path)` 方法。两个 jsonl provider 把现有 `scan_summary` 里的 skill 检测段抽到共享 helper；opencode 把 `list_sessions` 里 inline 的 `collect_used_skills` 循环搬到新方法。Tauri 层新增 `start_skill_scan` / `cancel_skill_scan` 命令，仿现有 `RemoteTasks` 模式用 `Arc<AtomicBool>` 取消，逐 session emit `skill-scan-progress` 事件。前端 `SessionPanel` 在 `refreshSessions` 之后启动扫描，订阅事件 patch `summary.used_skills`，cleanup 时 cancel。

**Tech Stack:** Rust (anyhow, serde, log) · Tauri 2 (events / state) · React 18 + TypeScript 5 · CSS keyframes

---

## File Structure

**Create:**
- `core/tests/skill_scan.rs` — TDD tests for trait method + list_sessions stripping

**Modify:**
- `core/src/providers/mod.rs` — trait method addition
- `core/src/providers/anthropic_jsonl.rs` — extract helper, strip from `scan_summary` / `list_sessions`
- `core/src/providers/claude_code.rs` — add `scan_session_skills` impl, drop `skill_roots` arg from `list_sessions` call
- `core/src/providers/code_agent_3x.rs` — same as claude_code
- `core/src/providers/opencode.rs` — drop inline used_skills loop in `list_sessions`, add `scan_session_skills` impl
- `src-tauri/src/commands.rs` — new `SkillScanTasks` state + two commands
- `src-tauri/src/lib.rs` — `.manage(...)` + register handlers
- `src/api.ts` — wrappers
- `src/types.ts` — payload types
- `src/components/SessionPanel.tsx` — scan lifecycle + status integration
- `src/styles/app.css` — chips fade-in keyframe
- `src/i18n/zh.ts` — `status.scanning_skills`
- `src/i18n/en.ts` — same key (English)
- `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `core/Cargo.toml` — version bump
- `release-notes.txt` — new version block at top

---

### Task 1: Add trait method with default empty impl + TDD scaffold

**Files:**
- Modify: `core/src/providers/mod.rs`
- Create: `core/tests/skill_scan.rs`

- [ ] **Step 1: Add the failing test file**

```rust
// core/tests/skill_scan.rs
use std::path::PathBuf;
use aaa_core::providers::{claude_code::ClaudeCodeProvider, SessionProvider};

#[test]
fn list_sessions_does_not_populate_used_skills_anymore() {
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let project_dir = tmp.path().join("-home-user-proj");
    fs::create_dir_all(&project_dir).unwrap();
    let session_path = project_dir.join("01ABCDEF.jsonl");
    // Minimal session with a SkillTool call so the *old* scan_summary would
    // populate used_skills. The new code path should leave it empty.
    fs::write(
        &session_path,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-06-15T09:00:00Z","cwd":"/home/user/proj","message":{"content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-06-15T09:00:01Z","message":{"id":"msg_1","model":"claude-opus-4-6","content":[{"type":"tool_use","id":"tu1","name":"Skill","input":{"skill":"superpowers:brainstorming"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            "\n",
        ),
    ).unwrap();

    let provider = ClaudeCodeProvider;
    let summaries = provider.list_sessions(&tmp.path().to_path_buf()).expect("list_sessions");
    assert_eq!(summaries.len(), 1);
    assert!(
        summaries[0].used_skills.is_empty(),
        "list_sessions must not populate used_skills anymore (got {:?})",
        summaries[0].used_skills
    );
}

#[test]
fn scan_session_skills_extracts_skills_from_jsonl() {
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let project_dir = tmp.path().join("-home-user-proj");
    fs::create_dir_all(&project_dir).unwrap();
    let session_path = project_dir.join("01ABCDEF.jsonl");
    fs::write(
        &session_path,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-06-15T09:00:00Z","cwd":"/home/user/proj","message":{"content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-06-15T09:00:01Z","message":{"id":"msg_1","model":"claude-opus-4-6","content":[{"type":"tool_use","id":"tu1","name":"Skill","input":{"skill":"superpowers:brainstorming"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            "\n",
        ),
    ).unwrap();

    let provider = ClaudeCodeProvider;
    let used = provider
        .scan_session_skills(&PathBuf::from(session_path))
        .expect("scan_session_skills");
    assert!(
        used.iter().any(|s| s.contains("brainstorming")),
        "expected brainstorming skill, got {:?}",
        used
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p aaa-core --test skill_scan`
Expected: FAIL — first assertion `used_skills.is_empty()` fails because current code populates it; second test FAILs to compile because `scan_session_skills` doesn't exist yet.

- [ ] **Step 3: Add the trait method default empty impl**

In `core/src/providers/mod.rs`, inside `pub trait SessionProvider`, after the existing `skill_roots` block:

```rust
    /// Extract skill IDs used in a single session, identified by source_path.
    /// Default returns empty so providers without skill detection cost zero.
    /// Called by the Tauri layer's async background skill-scan task; must be
    /// safe to invoke off the main thread (no shared mutable state, returns
    /// `Vec<String>` by value).
    fn scan_session_skills(&self, _source_path: &Path) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }
```

- [ ] **Step 4: Run tests, expect compile pass + first test still failing**

Run: `cargo test -p aaa-core --test skill_scan`
Expected: `scan_session_skills_extracts_skills_from_jsonl` FAIL (default returns empty, no `brainstorming` match); `list_sessions_does_not_populate_used_skills_anymore` still FAIL.

This intermediate state is fine — the next tasks will make both pass.

- [ ] **Step 5: Commit (no version bump yet — feature incomplete)**

Defer the commit until Task 4 is done so the whole core-side change is one cohesive, behavior-changing commit. Do **not** commit a half-stripped state. Move on to Task 2.

---

### Task 2: Extract skill detection helper from anthropic_jsonl, strip from list_sessions

**Files:**
- Modify: `core/src/providers/anthropic_jsonl.rs`
- Modify: `core/src/providers/claude_code.rs`
- Modify: `core/src/providers/code_agent_3x.rs`

- [ ] **Step 1: Add the new public helper `extract_used_skills` to anthropic_jsonl.rs**

Insert this function into `core/src/providers/anthropic_jsonl.rs`, near the other public entry points (after `collect_skill_usage`):

```rust
/// Walk a single session's JSONL file and return the skill IDs detected.
/// Used by the async post-list scan that populates `summary.used_skills`
/// off the `list_sessions` critical path. Mirrors the two-pass structure
/// (collect observations, then replay through `SkillDetector`) the original
/// inline code in `scan_summary` used.
pub fn extract_used_skills(
    path: &Path,
    skill_roots_fn: &dyn Fn(Option<&Path>) -> Vec<PathBuf>,
) -> Result<Vec<String>> {
    let f = File::open(path).with_context(|| format!("open {:?}", path))?;
    let reader = BufReader::new(f);
    let mut cwd: Option<String> = None;
    let mut det_obs: Vec<SkillObs> = Vec::new();

    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            if cwd.is_none() {
                cwd = Some(c.to_string());
            }
        }
        let line_ts = v.get("timestamp").and_then(Value::as_str).map(str::to_string);
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = extract_user_text(&v) {
                    det_obs.push(SkillObs::UserText { text, timestamp: line_ts });
                }
            }
            Some("assistant") => {
                if let Some(blocks) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let tool_use_id = b
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            let input_str = serde_json::to_string(&input).unwrap_or_default();
                            if let Some(sid) = extract_skill_id_from_input(&input_str) {
                                det_obs.push(SkillObs::AssistantTool {
                                    tool_use_id,
                                    skill_id: sid,
                                    timestamp: line_ts.clone(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let cwd_path = cwd.as_deref().map(Path::new);
    let reg = SkillRegistry::build(&skill_roots_fn(cwd_path));
    let mut det = SkillDetector::new(&reg);
    for obs in det_obs {
        match obs {
            SkillObs::UserText { text, timestamp } => {
                det.observe_user_text(None, timestamp.as_deref(), &text);
            }
            SkillObs::AssistantTool { tool_use_id, skill_id, timestamp } => {
                det.observe_assistant_skill_tool(
                    None,
                    timestamp.as_deref(),
                    &tool_use_id,
                    &skill_id,
                );
            }
        }
    }
    Ok(det.used_skill_ids())
}
```

Note: `SkillObs` is currently a private enum inside `scan_summary`. We need to lift it to module scope. After adding `extract_used_skills`, also move the `enum SkillObs { … }` block (currently lines ~888–898) to module scope (just above `extract_used_skills` is fine), removing it from inside `scan_summary` (which keeps using it). Verify both `scan_summary` and `extract_used_skills` compile against the lifted enum.

- [ ] **Step 2: Strip skill detection from `scan_summary`**

In `core/src/providers/anthropic_jsonl.rs::scan_summary`:

  1. Drop the `skill_roots_fn` parameter (the new signature is `fn scan_summary(p: &Path, provider_id: &str) -> Result<SessionSummary>`).
  2. Remove these locals: `let mut reg: Option<SkillRegistry> = None;`, `let mut det_obs: Vec<SkillObs> = Vec::new();`.
  3. In the `Some("user") => { … }` branch: remove the `if reg.is_none() { … }` block and the `det_obs.push(SkillObs::UserText { … })` push. Keep the `extract_user_text → first_user_text` logic.
  4. In the `Some("assistant") => { … }` branch: remove the `det_obs.push(SkillObs::AssistantTool { … })` push. The branch only needs to keep `usage` / `peak` accumulation.
  5. Remove the entire trailing block from `// Replay accumulated observations …` down through `summary.used_skills = det.used_skill_ids();`.

After the cuts, `scan_summary` no longer references `SkillRegistry`, `SkillDetector`, `walk_session_nodes`, `extract_skill_id_from_input`, `SkillObs`, or `skill_roots_fn` — verify by inspection. `summary.used_skills` is left at its default empty `Vec::new()` from initialization.

- [ ] **Step 3: Drop `skill_roots_fn` parameter from `list_sessions`**

In `core/src/providers/anthropic_jsonl.rs::list_sessions`:

  - New signature: `pub fn list_sessions(root: &Path, provider_id: &str) -> Result<Vec<SessionSummary>>`.
  - Remove the `skill_roots_fn: &dyn Fn(...)` parameter.
  - Update the inner call: `scan_summary(&p, provider_id)` (no third arg).

- [ ] **Step 4: Update both jsonl shell providers**

In `core/src/providers/claude_code.rs::list_sessions`, change the call from
`anthropic_jsonl::list_sessions(root, ID, &|cwd| self.skill_roots(cwd))` to
`anthropic_jsonl::list_sessions(root, ID)`.

Add the `scan_session_skills` impl just before the closing brace of the `impl SessionProvider for ClaudeCodeProvider`:

```rust
    fn scan_session_skills(&self, source_path: &Path) -> anyhow::Result<Vec<String>> {
        anthropic_jsonl::extract_used_skills(source_path, &|cwd| self.skill_roots(cwd))
    }
```

In `core/src/providers/code_agent_3x.rs`, do the exact same two changes — call site update + new method — substituting the provider's own `skill_roots`. (If `code_agent_3x` doesn't have `skill_roots`, use `&|_| Vec::new()`.)

- [ ] **Step 5: Run the trait tests**

Run: `cargo test -p aaa-core --test skill_scan`
Expected: both tests PASS.

- [ ] **Step 6: Run full core test suite**

Run: `cargo test -p aaa-core`
Expected: all tests PASS (smoke tests on real sessions still load, `code_agent_3x_provider_parses_a_minimal_fixture` passes).

- [ ] **Step 7: Defer commit until Task 3 done so the whole core change lands as one commit**

---

### Task 3: Strip used_skills loop from opencode, add scan_session_skills impl

**Files:**
- Modify: `core/src/providers/opencode.rs`

- [ ] **Step 1: Drop the inline used_skills loop in `list_sessions`**

In `core/src/providers/opencode.rs::list_sessions` (around line 117–133), delete the entire block that starts with the comment `// Augment each summary with used_skills.` down through the end of the `for s in sessions.iter_mut() { … }` loop.

After: the `Ok(mut sessions)` arm's body becomes just the `info!("opencode scan_summaries …")` log line followed by `out.append(&mut sessions);`.

- [ ] **Step 2: Add `scan_session_skills` impl**

Inside `impl SessionProvider for OpencodeProvider`, just before the closing brace, add:

```rust
    fn scan_session_skills(&self, source_path: &Path) -> anyhow::Result<Vec<String>> {
        let (db_path, session_id) = parse_source_path(&source_path.to_path_buf())?;
        let conn = open_ro(&db_path)?;
        let cwd = scan_summaries(&conn, &db_path)
            .ok()
            .and_then(|sessions| sessions.into_iter().find(|s| s.session_id == session_id))
            .and_then(|s| s.cwd);
        let cwd_path = cwd.as_deref().map(Path::new);
        let reg = crate::skills::SkillRegistry::build(&self.skill_roots(cwd_path));
        collect_used_skills(&conn, &session_id, &reg).map_err(|e| anyhow::anyhow!(e))
    }
```

(If `collect_used_skills` already returns `anyhow::Result<Vec<String>>`, drop the `.map_err`. Inspect `core/src/providers/opencode.rs` line ~1034 to confirm.)

- [ ] **Step 3: Add an opencode skill_scan test**

Append to `core/tests/skill_scan.rs`:

```rust
#[test]
fn opencode_list_sessions_does_not_populate_used_skills_anymore() {
    use aaa_core::providers::opencode::OpencodeProvider;

    let Some(root) = dirs::data_local_dir().map(|d| d.join("opencode")) else {
        return;
    };
    if !root.join("opencode.db").exists() {
        return;
    }
    let provider = OpencodeProvider;
    let summaries = provider.list_sessions(&root).expect("list_sessions");
    if summaries.is_empty() {
        return;
    }
    for s in &summaries {
        assert!(
            s.used_skills.is_empty(),
            "opencode list_sessions must not populate used_skills (sid={}, got {:?})",
            s.session_id,
            s.used_skills
        );
    }
}
```

This test gracefully no-ops on machines without an opencode db.

- [ ] **Step 4: Run all tests**

Run: `cargo test -p aaa-core`
Expected: all tests PASS.

- [ ] **Step 5: Build the workspace to catch downstream compile fallout**

Run: `cargo build --workspace`
Expected: clean build (no errors). The `src-tauri/src/commands.rs::list_sessions` command should still compile because the trait shape is backwards-compatible.

- [ ] **Step 6: Commit core-side changes**

```bash
git add core/src/providers/mod.rs \
        core/src/providers/anthropic_jsonl.rs \
        core/src/providers/claude_code.rs \
        core/src/providers/code_agent_3x.rs \
        core/src/providers/opencode.rs \
        core/tests/skill_scan.rs
git commit -m "refactor(core): split skill detection out of list_sessions

引入 SessionProvider::scan_session_skills 让 skill 检测能在 list_sessions
之外按 source_path 单独跑。anthropic_jsonl 和 opencode 的 list_sessions
不再 inline 扫每个 session 的 skill；summary.used_skills 由调用方在异步
后台 pass 中填充。"
```

(Defer version bump until the full feature lands in Task 7.)

---

### Task 4: Add SkillScanTasks state + Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the new state struct + commands to `commands.rs`**

After the existing `RemoteTasks` definition (around line 37), add:

```rust
/// Per-scan cancel flags, registered by `start_skill_scan` and flipped by
/// `cancel_skill_scan`; the background thread polls the flag between sessions.
#[derive(Default)]
pub struct SkillScanTasks(pub Mutex<HashMap<String, Arc<AtomicBool>>>);
```

Then, near the other command definitions (placement: after `remote_cancel`, before `export_session`), add:

```rust
#[derive(serde::Serialize, Clone)]
struct SkillScanProgress<'a> {
    scan_id: &'a str,
    source_path: &'a str,
    used_skills: &'a [String],
    k: usize,
    n: usize,
}

#[derive(serde::Serialize, Clone)]
struct SkillScanDone<'a> {
    scan_id: &'a str,
    total: usize,
}

#[tauri::command]
pub fn start_skill_scan(
    app: tauri::AppHandle,
    tasks: tauri::State<'_, SkillScanTasks>,
    provider_id: String,
    scan_id: String,
    source_paths: Vec<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    debug!(
        "cmd start_skill_scan provider={} scan_id={} n={}",
        provider_id, scan_id, source_paths.len()
    );
    let provider = providers::find(&provider_id)
        .ok_or_else(|| format!("unknown provider: {}", provider_id))?;

    let cancelled = Arc::new(AtomicBool::new(false));
    tasks.0.lock().unwrap().insert(scan_id.clone(), cancelled.clone());

    // Move owned data into the worker thread.
    let app_for_worker = app.clone();
    let scan_id_for_worker = scan_id.clone();
    let source_paths_for_worker = source_paths.clone();
    std::thread::spawn(move || {
        let n = source_paths_for_worker.len();
        for (i, path) in source_paths_for_worker.iter().enumerate() {
            if cancelled.load(Ordering::SeqCst) {
                debug!("skill_scan {} cancelled at {}/{}", scan_id_for_worker, i, n);
                break;
            }
            let used = provider
                .scan_session_skills(&PathBuf::from(path))
                .unwrap_or_else(|e| {
                    log::warn!("scan_session_skills failed for {}: {}", path, e);
                    Vec::new()
                });
            let _ = app_for_worker.emit(
                "skill-scan-progress",
                SkillScanProgress {
                    scan_id: &scan_id_for_worker,
                    source_path: path,
                    used_skills: &used,
                    k: i + 1,
                    n,
                },
            );
        }
        let _ = app_for_worker.emit(
            "skill-scan-done",
            SkillScanDone {
                scan_id: &scan_id_for_worker,
                total: n,
            },
        );
    });
    // Drop our entry from the tasks map *outside* the worker so a
    // late-arriving cancel still finds the flag — we let the worker hold the
    // last Arc until it returns. To prevent the map growing forever, also
    // schedule cleanup at scan-done time:
    let tasks_for_cleanup = tasks.0.clone();
    let scan_id_for_cleanup = scan_id.clone();
    let app_for_cleanup = app.clone();
    let cleanup_id = scan_id.clone();
    let unlisten = app_for_cleanup.listen("skill-scan-done", move |evt| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(evt.payload()) {
            if payload.get("scan_id").and_then(|v| v.as_str()) == Some(&cleanup_id) {
                tasks_for_cleanup.lock().unwrap().remove(&scan_id_for_cleanup);
            }
        }
    });
    // Drop the listener handle right away — the once-per-scan cleanup above
    // is best-effort. The listener itself is auto-cleaned by Tauri when the
    // window closes; in the meantime it costs ~nothing.
    let _ = unlisten;

    Ok(())
}

#[tauri::command]
pub fn cancel_skill_scan(
    tasks: tauri::State<'_, SkillScanTasks>,
    scan_id: String,
) -> Result<(), String> {
    info!("cmd cancel_skill_scan scan={}", scan_id);
    if let Some(flag) = tasks.0.lock().unwrap().get(&scan_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}
```

The cleanup-listener pattern above is awkward — simpler is to remove the entry from the worker thread itself. Replace the body of the `std::thread::spawn` closure with this final form, and **drop the listen-based cleanup block entirely**:

```rust
let tasks_for_worker = tasks.0.clone();
let scan_id_for_worker = scan_id.clone();
let provider_id_for_worker = provider_id.clone();
std::thread::spawn(move || {
    // Re-resolve provider inside the worker so we don't smuggle a !Send Box
    // across threads.
    let provider = match providers::find(&provider_id_for_worker) {
        Some(p) => p,
        None => return,
    };
    let n = source_paths_for_worker.len();
    for (i, path) in source_paths_for_worker.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        let used = provider
            .scan_session_skills(&PathBuf::from(path))
            .unwrap_or_else(|e| {
                log::warn!("scan_session_skills failed for {}: {}", path, e);
                Vec::new()
            });
        let _ = app_for_worker.emit(
            "skill-scan-progress",
            SkillScanProgress {
                scan_id: &scan_id_for_worker,
                source_path: path,
                used_skills: &used,
                k: i + 1,
                n,
            },
        );
    }
    let _ = app_for_worker.emit(
        "skill-scan-done",
        SkillScanDone {
            scan_id: &scan_id_for_worker,
            total: n,
        },
    );
    tasks_for_worker.lock().unwrap().remove(&scan_id_for_worker);
});
```

Use this cleaner version. Drop the duplicated listen-based cleanup block.

Note: `tasks.0` is a `Mutex<HashMap<...>>`. To clone the inner `Mutex` for the worker, wrap the state's HashMap in an `Arc`. The simplest: change `RemoteTasks` and `SkillScanTasks` to `pub struct SkillScanTasks(pub Arc<Mutex<HashMap<…>>>)` if not already. **Inspect `commands.rs:33–37`** — if `RemoteTasks` is `Mutex<HashMap>` (no `Arc`), change *only* `SkillScanTasks` to `Arc<Mutex<HashMap>>` (don't mass-refactor `RemoteTasks`); store `tasks.0.clone()` (cloning the `Arc`, not the map) into the worker.

- [ ] **Step 2: Make sure `Box<dyn SessionProvider>` is `Send`**

The trait already has `Send + Sync` bounds (verified in `mod.rs`), so passing `provider` across threads via `provider_id` re-lookup inside the worker is the cleanest move (already shown above). Keep that pattern.

- [ ] **Step 3: Wire the new state + commands in `lib.rs`**

In `src-tauri/src/lib.rs`:

  1. Add `.manage(commands::SkillScanTasks::default())` after the existing `.manage(commands::RemoteTasks::default())` line.
  2. In the `tauri::generate_handler![…]` invocation, add `commands::start_skill_scan,` and `commands::cancel_skill_scan,` right after `commands::remote_cancel,`.

- [ ] **Step 4: Build the Tauri host**

Run: `cargo build -p aaa --bin aaa`
Expected: clean build.

If you hit `Box<dyn SessionProvider>` not `Send` issues, double-check the worker re-resolves via `providers::find` from owned `String` (not borrowed `provider`).

- [ ] **Step 5: Commit Tauri-side changes**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): start/cancel skill scan commands

新增 start_skill_scan / cancel_skill_scan，仿 RemoteTasks 模式用
Arc<AtomicBool> 取消，逐 session emit skill-scan-progress 事件，
让前端在 list_sessions 之外异步填充每行的 used_skills。"
```

---

### Task 5: Frontend api wrappers + types + payload subscribe

**Files:**
- Modify: `src/api.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add wrappers to `api.ts`**

Find the `listSessions` block (around line 24–25) and add immediately after it:

```ts
  startSkillScan: (providerId: string, scanId: string, sourcePaths: string[]) =>
    invoke<void>("start_skill_scan", { providerId, scanId, sourcePaths }),
  cancelSkillScan: (scanId: string) =>
    invoke<void>("cancel_skill_scan", { scanId }),
```

- [ ] **Step 2: Add payload types to `types.ts`**

Append to `src/types.ts` (TS-side mirrors of the Rust event payloads):

```ts
export interface SkillScanProgressPayload {
  scan_id: string;
  source_path: string;
  used_skills: string[];
  k: number; // 1-based completed count
  n: number; // total sessions in this scan
}

export interface SkillScanDonePayload {
  scan_id: string;
  total: number;
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 4: No commit yet — folded into Task 6**

---

### Task 6: Wire SessionPanel scan lifecycle + status bar + chips fade-in + i18n

**Files:**
- Modify: `src/components/SessionPanel.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: Add the i18n key**

In `src/i18n/zh.ts`, find the existing `loaded_sessions: "已加载 {count} 个会话。"` line and add right after it:

```ts
    scanning_skills: "正在后台扫描技能… {k}/{n}",
```

In `src/i18n/en.ts`, mirror with English wording. Find the corresponding `loaded_sessions` entry (the `DeepStrings` type guard will fail loudly on key drift) and add:

```ts
    scanning_skills: "Scanning skills in background… {k}/{n}",
```

- [ ] **Step 2: Add the chips fade-in keyframe to app.css**

In `src/styles/app.css`, near the existing `@keyframes aaa-spin` block (around line 306), add:

```css
@keyframes aaa-skill-fade-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}
.session-row .meta .pill.skill-pill {
  animation: aaa-skill-fade-in 240ms ease-out;
}
```

Find the existing `.session-row .meta .pill.skill-pill { … }` rule (around line 344) and append the `animation:` declaration to it instead of adding a duplicate selector.

- [ ] **Step 3: Wire the scan lifecycle in `SessionPanel.tsx`**

Imports: ensure `listen` from `@tauri-apps/api/event` and `SkillScanProgressPayload` / `SkillScanDonePayload` from `../types` are imported.

Add a new state for scan progress near the other `useState` calls (around line 116):

```ts
  const [skillScanProgress, setSkillScanProgress] = useState<{ k: number; n: number } | null>(null);
  const skillScanIdRef = useRef<string | null>(null);
```

Replace the body of `refreshSessions` (around line 120–135) with:

```ts
  const refreshSessions = useCallback(async () => {
    setBusy(true);
    setStatus(t("status.scanning", { root: backend.root }));
    // Cancel any in-flight skill scan from a previous root before kicking
    // off the new one. Both branches of the try/catch below need the new
    // scan id, so we mint it before the await.
    if (skillScanIdRef.current) {
      const prev = skillScanIdRef.current;
      skillScanIdRef.current = null;
      void api.cancelSkillScan(prev).catch(() => {});
    }
    setSkillScanProgress(null);

    try {
      const list = await api.listSessions(backend.provider.id, backend.root);
      setSessions(list);
      setStatus(t("status.loaded_sessions", { count: list.length }));
      setError(null);

      // Kick off the async skill-scan pass, if there is anything to scan.
      if (list.length > 0) {
        const scanId = crypto.randomUUID();
        skillScanIdRef.current = scanId;
        setSkillScanProgress({ k: 0, n: list.length });
        await api.startSkillScan(
          backend.provider.id,
          scanId,
          list.map((s) => s.source_path),
        );
      }
    } catch (e: unknown) {
      setError(String(e));
      setSessions([]);
      setStatus(t("status.scan_failed"));
    } finally {
      setBusy(false);
    }
  }, [backend.provider.id, backend.root, t]);
```

Add a new `useEffect` to subscribe to scan events and clean up on unmount/refresh, placed right after the existing `useEffect` that calls `refreshSessions` (around line 137–141):

```ts
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const p = await listen<SkillScanProgressPayload>("skill-scan-progress", (evt) => {
        if (evt.payload.scan_id !== skillScanIdRef.current) return;
        const { source_path, used_skills, k, n } = evt.payload;
        setSessions((prev) =>
          prev.map((s) =>
            s.source_path === source_path ? { ...s, used_skills } : s,
          ),
        );
        setSkillScanProgress({ k, n });
      });
      const d = await listen<SkillScanDonePayload>("skill-scan-done", (evt) => {
        if (evt.payload.scan_id !== skillScanIdRef.current) return;
        skillScanIdRef.current = null;
        setSkillScanProgress(null);
      });
      if (cancelled) {
        p();
        d();
      } else {
        unlistenProgress = p;
        unlistenDone = d;
      }
    })();
    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenDone?.();
      const id = skillScanIdRef.current;
      if (id) {
        skillScanIdRef.current = null;
        void api.cancelSkillScan(id).catch(() => {});
      }
    };
  }, []);
```

This effect runs once for the panel's lifetime (`[]` deps). The `skillScanIdRef` indirection means a refresh can change the active scan without re-subscribing.

Make the status string honor scan progress. Find the line that derives `status` for the StatusBar (search around line 226 for `sessionCount: sessions.length,`). Replace whatever computes the displayed status with:

```ts
  const displayStatus = useMemo(() => {
    if (skillScanProgress && skillScanProgress.n > 0) {
      return t("status.scanning_skills", {
        k: skillScanProgress.k,
        n: skillScanProgress.n,
      });
    }
    return status;
  }, [skillScanProgress, status, t]);
```

Then change the prop passed downstream from `status: status,` to `status: displayStatus,` in the `useMemo` block that builds the StatusBar's data.

If the existing code passes `status` directly without an enclosing `useMemo`, add the `useMemo` above and substitute `status` with `displayStatus` at the read site.

- [ ] **Step 4: Build the frontend**

Run: `npm run build`
Expected: clean build. If `tsc -b` complains about a missing key in `en.ts` because of `DeepStrings`, double-check the same key name was added to both catalogs.

- [ ] **Step 5: Smoke-run the dev app (manual)**

Run: `PATH=$HOME/.local/node/bin:$PATH ./scripts/dev.sh`
Open a Claude Code source. Confirm:
  1. List appears immediately, no chips.
  2. Status bar shows `正在后台扫描技能… k/N` (or English equivalent), counter advances.
  3. Chips fade in row-by-row.
  4. Switch root / close panel → status bar reverts.

If something looks off, debug then re-verify.

- [ ] **Step 6: No commit yet — folded into Task 7 with the version bump**

---

### Task 7: Bump version + release notes + final commit + push

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `core/Cargo.toml`
- Modify: `release-notes.txt`

- [ ] **Step 1: Decide bump level**

Current version: `1.7.4` (per `package.json`). New: `1.8.0` — minor bump since this introduces new Tauri commands (`start_skill_scan`, `cancel_skill_scan`) and a visible behavior change (列表立即出现 + chips 淡入).

- [ ] **Step 2: Update all four version fields to `1.8.0`**

  - `package.json`: `"version": "1.8.0"`
  - `src-tauri/tauri.conf.json`: `"version": "1.8.0"`
  - `src-tauri/Cargo.toml`: `[package].version = "1.8.0"`
  - `core/Cargo.toml`: `[package].version = "1.8.0"`

- [ ] **Step 3: Prepend a new block to `release-notes.txt`**

At the very top of `release-notes.txt`, insert:

```
v1.8.0
----
- 打开数据源更快：会话列表立即出现，使用过的技能标签会在后台扫描完成后逐条淡入，不再阻塞首屏。
- 状态栏在后台扫描期间显示当前进度。
```

(Above whatever was previously the top entry.)

- [ ] **Step 4: Build everything once more to confirm clean state**

Run in parallel:
- `cargo build --workspace`
- `npm run build`

Expected: both clean.

- [ ] **Step 5: Run the full core test suite**

Run: `cargo test -p aaa-core`
Expected: all PASS.

- [ ] **Step 6: Commit the frontend + version bump together**

```bash
git add src/api.ts src/types.ts src/components/SessionPanel.tsx \
        src/styles/app.css src/i18n/zh.ts src/i18n/en.ts \
        package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml core/Cargo.toml \
        release-notes.txt
git commit -m "feat(ui): async skill scan after list_sessions; v1.8.0

会话列表先到位，再用 skill-scan-progress 事件逐行淡入 chips；状态栏期间
显示 scanning skills (k/N)，关 panel/切源会取消后台扫描。"
```

- [ ] **Step 7: Push to remote**

```bash
git push origin dev/bugfix
```

Verify with:

```bash
git status
git log -2 --oneline
```

Expected: working tree clean, two new commits on dev/bugfix (the core refactor + the feat commit) plus the earlier docs commits, all pushed.

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks covering it |
|---|---|
| Goals 1 (cheap pass) | Task 2 (strip jsonl), Task 3 (strip opencode) |
| Goals 2 (independent cancellable scan) | Task 1 (trait method), Task 4 (Tauri commands) |
| Goals 3 (status bar progress) | Task 6 (i18n + displayStatus) |
| Goals 4 (chips fade in) | Task 6 (CSS) |
| Goals 5 (load_session unchanged) | Inspection-level — Task 2 explicitly does not touch `load_session` |
| Architecture data flow diagram | Task 4 (backend), Task 5 + 6 (frontend) |
| Components 1 (trait) | Task 1 |
| Components 2 (anthropic_jsonl) | Task 2 |
| Components 3 (opencode) | Task 3 |
| Components 4 (state + commands) | Task 4 |
| Components 5 (api.ts) | Task 5 |
| Components 6 (SessionPanel lifecycle) | Task 6 |
| Components 7 (chips fade-in) | Task 6 |
| Components 8 (i18n) | Task 6 |
| Tests | Tasks 1, 3 (skill_scan.rs); Task 6 manual smoke |
| Versioning | Task 7 |

No gaps.

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate error handling"/"similar to Task N" instances. Every code step shows the actual code.

**Type consistency:** `SkillScanProgress` / `SkillScanDone` field names (`scan_id`, `source_path`, `used_skills`, `k`, `n`, `total`) used identically across Rust struct (Task 4), TS payload type (Task 5), and the listener handlers (Task 6). The Tauri event names (`skill-scan-progress` / `skill-scan-done`) appear identically in the worker emits (Task 4) and the listen calls (Task 6). The trait method signature (`fn scan_session_skills(&self, source_path: &Path) -> anyhow::Result<Vec<String>>`) is identical in `mod.rs` (Task 1), `claude_code.rs` / `code_agent_3x.rs` (Task 2), and `opencode.rs` (Task 3).

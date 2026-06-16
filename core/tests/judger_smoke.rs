//! End-to-end smoke: locate any real session fixture from existing providers
//! tests, prepare a judgment, drop a result.json fixture, verify list/get.

use aaa_core::judger::{
    runner::{prepare_judgment, StartJudgmentArgs},
    schema::{Dimension, SessionRef},
    workdir,
};
use tempfile::tempdir;

#[test]
fn smoke_prepare_then_list_then_get() {
    // Skip if no fixture session is available (mirrors providers smoke pattern).
    let fixture = match find_fixture_session() {
        Some(f) => f,
        None => {
            eprintln!("skipping: no fixture session present");
            return;
        }
    };

    let tmp = tempdir().unwrap();
    let args = StartJudgmentArgs {
        provider_id: fixture.provider_id.clone(),
        session: SessionRef {
            session_id: fixture.session_id.clone(),
            source_path: fixture.source_path.clone(),
            title: None,
            cwd: None,
        },
        agent_cmd: "true".into(),
        dimensions: vec![Dimension::Context, Dimension::Safety],
        prompt_override: None,
    };

    let started = prepare_judgment(tmp.path(), &args).expect("prepare");

    // Workdir contents present.
    let dir = started.workdir.clone();
    assert!(dir.join("meta.json").is_file());
    assert!(dir.join("system-prompt.md").is_file());
    assert!(dir.join("prompt.txt").is_file());
    assert!(dir.join("export").is_dir());

    // No result.json yet → list says Pending.
    let ids = workdir::list_run_ids(tmp.path()).unwrap();
    assert_eq!(ids.len(), 1);

    // Drop a valid rubric fixture.
    std::fs::copy(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/judger/valid-rubric.json"),
        dir.join("result.json"),
    )
    .unwrap();

    let rubric = aaa_core::judger::result::read_rubric(&dir)
        .unwrap()
        .unwrap();
    assert_eq!(
        rubric.overall,
        aaa_core::judger::schema::OverallLevel::NeedsImprovement
    );

    // Delete is clean.
    workdir::delete_workdir(tmp.path(), &started.run_id).unwrap();
    assert!(!dir.exists());
}

struct Fixture {
    provider_id: String,
    session_id: String,
    source_path: String,
}

fn find_fixture_session() -> Option<Fixture> {
    // Mirrors the existing core/tests/smoke.rs pattern: walk
    // ~/.claude/projects for any real claude-code session jsonl. Falls back
    // to None on CI / clean dev boxes.
    let claude_root = dirs::home_dir()?.join(".claude/projects");
    if !claude_root.is_dir() {
        return None;
    }
    for proj in std::fs::read_dir(&claude_root).ok()?.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        for f in std::fs::read_dir(&proj_path).ok()?.flatten() {
            if f.path().extension().map(|e| e == "jsonl").unwrap_or(false) {
                let name = f.file_name().to_string_lossy().to_string();
                let session_id = name.trim_end_matches(".jsonl").to_string();
                return Some(Fixture {
                    provider_id: "claude-code".into(),
                    session_id,
                    source_path: f.path().to_string_lossy().to_string(),
                });
            }
        }
    }
    None
}

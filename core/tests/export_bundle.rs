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

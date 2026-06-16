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

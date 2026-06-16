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

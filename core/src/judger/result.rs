use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

use super::schema::Rubric;

/// Read and parse `<workdir>/result.json`. Returns `Ok(None)` if the file is absent
/// (judgment still pending). Returns `Err` if the file exists but is invalid.
pub fn read_rubric(workdir: &Path) -> Result<Option<Rubric>> {
    let path = workdir.join("result.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let rubric: Rubric = serde_json::from_slice(&raw)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(rubric))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judger::schema::{OverallLevel, Severity};
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/judger")
            .join(name)
    }

    fn copy_fixture_to_workdir(name: &str) -> tempfile::TempDir {
        let tmp = tempdir().unwrap();
        let src = fixture_path(name);
        std::fs::copy(&src, tmp.path().join("result.json")).unwrap();
        tmp
    }

    #[test]
    fn missing_result_returns_none() {
        let tmp = tempdir().unwrap();
        let r = read_rubric(tmp.path()).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn valid_rubric_parses() {
        let tmp = copy_fixture_to_workdir("valid-rubric.json");
        let r = read_rubric(tmp.path()).unwrap().unwrap();
        assert_eq!(r.overall, OverallLevel::NeedsImprovement);
        assert_eq!(r.dimensions.len(), 2);
    }

    #[test]
    fn unknown_severity_decodes_to_unknown() {
        let tmp = copy_fixture_to_workdir("unknown-severity.json");
        let r = read_rubric(tmp.path()).unwrap().unwrap();
        let f = &r.dimensions[0].findings[0];
        assert_eq!(f.severity, Severity::Unknown);
    }

    #[test]
    fn missing_summary_returns_err() {
        let tmp = copy_fixture_to_workdir("missing-summary.json");
        let r = read_rubric(tmp.path());
        assert!(r.is_err(), "expected parse error");
    }
}

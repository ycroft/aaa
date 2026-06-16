use serde::{Deserialize, Serialize};

pub const RUBRIC_SCHEMA_VERSION: u32 = 1;
pub const META_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    Context,
    Tools,
    Alignment,
    Safety,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warn,
    Critical,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OverallLevel {
    Good,
    NeedsImprovement,
    Poor,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRef {
    pub session_id: String,
    pub source_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JudgmentMeta {
    pub run_id: String,
    pub provider_id: String,
    pub session: SessionRef,
    pub started_at: String,
    pub agent_cmd: String,
    pub dimensions_enabled: Vec<Dimension>,
    pub schema_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Finding {
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub evidence_node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DimensionResult {
    pub dimension: Dimension,
    #[serde(default)]
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rubric {
    pub schema_version: u32,
    pub overall: OverallLevel,
    pub summary: String,
    pub dimensions: Vec<DimensionResult>,
    pub completed_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rubric_roundtrip_preserves_all_fields() {
        let rubric = Rubric {
            schema_version: RUBRIC_SCHEMA_VERSION,
            overall: OverallLevel::Good,
            summary: "All good".into(),
            dimensions: vec![DimensionResult {
                dimension: Dimension::Context,
                findings: vec![Finding {
                    severity: Severity::Warn,
                    title: "Big read".into(),
                    detail: "agent read whole file".into(),
                    evidence_node_ids: vec!["node-1".into(), "node-2".into()],
                }],
            }],
            completed_at: "2026-06-16T10:00:00Z".into(),
        };
        let json = serde_json::to_string(&rubric).unwrap();
        let back: Rubric = serde_json::from_str(&json).unwrap();
        assert_eq!(rubric, back);
    }

    #[test]
    fn unknown_severity_decodes_to_unknown_variant() {
        let json = r#"{"severity":"blocker","title":"x","detail":"y","evidence_node_ids":[]}"#;
        let f: Finding = serde_json::from_str(json).unwrap();
        assert_eq!(f.severity, Severity::Unknown);
    }

    #[test]
    fn missing_evidence_defaults_to_empty() {
        let json = r#"{"severity":"info","title":"x","detail":"y"}"#;
        let f: Finding = serde_json::from_str(json).unwrap();
        assert!(f.evidence_node_ids.is_empty());
    }

    #[test]
    fn unknown_overall_decodes() {
        let json = r#""excellent""#;
        let lvl: OverallLevel = serde_json::from_str(json).unwrap();
        assert_eq!(lvl, OverallLevel::Unknown);
    }
}

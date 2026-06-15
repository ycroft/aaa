use serde::{Deserialize, Serialize};

use crate::version::default_schema_version;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
}

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

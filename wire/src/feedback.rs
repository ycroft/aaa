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
}

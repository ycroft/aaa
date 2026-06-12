use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Bug,
    Feature,
    Question,
    Other,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Bug => "bug",
            Category::Feature => "feature",
            Category::Question => "question",
            Category::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker,
    Major,
    Minor,
    Trivial,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Blocker => "blocker",
            Severity::Major => "major",
            Severity::Minor => "minor",
            Severity::Trivial => "trivial",
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
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::New => "new",
            Status::Triaged => "triaged",
            Status::InProgress => "in_progress",
            Status::Resolved => "resolved",
            Status::Wontfix => "wontfix",
        }
    }
}

/// Server-side input for new feedback.
#[derive(Debug, Clone, Deserialize)]
pub struct NewFeedback {
    pub category: Category,
    pub severity: Option<Severity>,
    pub title: String,
    pub description: String,
    pub contact_email: Option<String>,
    pub app_version: String,
    pub os_info: String,
    pub device_id: String,
    pub log_excerpt: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub ticket_id: String,
    pub claim_token: String,
}

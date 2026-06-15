use aaa_wire::feedback::{
    AttachmentMeta, Category, CreateFeedbackRequest, CreateFeedbackResponse,
    GetFeedbackResponse, Severity, Status,
};
use aaa_wire::SCHEMA_VERSION;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Json, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::io::AsyncWriteExt;
use ulid::Ulid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/feedback", post(create_handler))
        .route("/v1/feedback/:id", get(get_one))
        .route("/v1/feedback/:id/attach", post(attach))
}

/// Same as `router` but without the rate-limited POST /v1/feedback (caller mounts
/// that route under a per-route limiter middleware in `lib.rs`).
pub fn unlimited_router() -> Router<AppState> {
    Router::new()
        .route("/v1/feedback/:id", get(get_one))
        .route("/v1/feedback/:id/attach", post(attach))
}

pub async fn create_handler(
    State(s): State<AppState>,
    Json(input): Json<CreateFeedbackRequest>,
) -> Result<(StatusCode, Json<CreateFeedbackResponse>), AppError> {
    create(State(s), Json(input)).await
}

#[derive(Deserialize)]
pub struct ClaimQuery {
    pub token: String,
}

async fn create(
    State(s): State<AppState>,
    Json(input): Json<CreateFeedbackRequest>,
) -> Result<(StatusCode, Json<CreateFeedbackResponse>), AppError> {
    if input.title.trim().is_empty() || input.title.chars().count() > 80 {
        return Err(AppError::BadRequest(
            "title length must be 1..=80 chars".into(),
        ));
    }
    if input.description.trim().is_empty() {
        return Err(AppError::BadRequest("description required".into()));
    }
    let id = Ulid::new().to_string();
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let claim = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let category = input.category.as_str();
    let severity: Option<&'static str> = input.severity.map(|s| s.as_str());
    sqlx::query(
        r#"INSERT INTO feedback(id, claim_token, category, severity, title, description,
            contact_email, app_version, os_info, device_id, log_excerpt, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)"#,
    )
    .bind(&id)
    .bind(&claim)
    .bind(category)
    .bind(severity)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.contact_email)
    .bind(&input.app_version)
    .bind(&input.os_info)
    .bind(&input.device_id)
    .bind(&input.log_excerpt)
    .bind(now)
    .bind(now)
    .execute(&s.db)
    .await?;
    tracing::info!(ticket = %id, "feedback created");
    let notifier = s.notifier.clone();
    let id_for_notify = id.clone();
    let input_for_notify = input.clone();
    tokio::spawn(async move {
        notifier
            .feedback_created(&id_for_notify, &input_for_notify)
            .await;
    });
    Ok((
        StatusCode::CREATED,
        Json(CreateFeedbackResponse {
            schema_version: SCHEMA_VERSION,
            ticket_id: id,
            claim_token: claim,
        }),
    ))
}

async fn get_one(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ClaimQuery>,
) -> Result<Json<GetFeedbackResponse>, AppError> {
    let row = sqlx::query("SELECT * FROM feedback WHERE id = ?")
        .bind(&id)
        .fetch_optional(&s.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let stored: String = row.get("claim_token");
    if !ct_eq(stored.as_bytes(), q.token.as_bytes()) {
        return Err(AppError::Unauthorized);
    }
    let attachments = sqlx::query(
        "SELECT id, filename, mime, bytes FROM feedback_attachment WHERE feedback_id = ? ORDER BY created_at ASC",
    )
    .bind(&id)
    .fetch_all(&s.db)
    .await?
    .into_iter()
    .map(|r| AttachmentMeta {
        id: r.get("id"),
        filename: r.get("filename"),
        mime: r.get("mime"),
        bytes: r.get("bytes"),
    })
    .collect();
    let status_str: String = row.get("status");
    let category_str: String = row.get("category");
    let severity_opt: Option<String> = row.get("severity");
    let view = GetFeedbackResponse {
        schema_version: SCHEMA_VERSION,
        id: row.get("id"),
        status: parse_status(&status_str),
        category: parse_category(&category_str),
        severity: parse_severity(severity_opt),
        title: row.get("title"),
        description: row.get("description"),
        admin_note: row.get("admin_note"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        attachments,
    };
    Ok(Json(view))
}

async fn attach(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ClaimQuery>,
    mut mp: Multipart,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let row = sqlx::query("SELECT claim_token FROM feedback WHERE id = ?")
        .bind(&id)
        .fetch_optional(&s.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let stored: String = row.get("claim_token");
    if !ct_eq(stored.as_bytes(), q.token.as_bytes()) {
        return Err(AppError::Unauthorized);
    }
    let mut field = mp
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
        .ok_or_else(|| AppError::BadRequest("no file part".into()))?;
    let filename = field
        .file_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "upload.bin".to_string());
    let mime = field
        .content_type()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if !s.cfg.uploads.allowed_mime.iter().any(|m| m == &mime) {
        return Err(AppError::BadRequest(format!("disallowed mime: {}", mime)));
    }
    let limit = s.cfg.uploads.max_attachment_bytes as usize;
    let mut total = 0usize;
    let aid = Ulid::new().to_string();
    let dir = s.cfg.uploads.dir.join(&id);
    tokio::fs::create_dir_all(&dir).await?;
    let safe_name = sanitize(&filename);
    let path = dir.join(format!("{}-{}", aid, safe_name));
    let mut file = tokio::fs::File::create(&path).await?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        total = total.saturating_add(chunk.len());
        if total > limit {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::PayloadTooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    let digest = hex::encode(hasher.finalize());
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let rel = path
        .strip_prefix(&s.cfg.uploads.dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .to_string_lossy()
        .to_string();
    sqlx::query(
        "INSERT INTO feedback_attachment(id, feedback_id, filename, mime, bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&aid)
    .bind(&id)
    .bind(&filename)
    .bind(&mime)
    .bind(total as i64)
    .bind(&digest)
    .bind(&rel)
    .bind(now)
    .execute(&s.db)
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"id": aid, "bytes": total})),
    ))
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

fn parse_category(s: &str) -> Category {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(Category::Unknown)
}
fn parse_severity(s: Option<String>) -> Option<Severity> {
    s.map(|v| serde_json::from_value(serde_json::Value::String(v)).unwrap_or(Severity::Unknown))
}
fn parse_status(s: &str) -> Status {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(Status::Unknown)
}

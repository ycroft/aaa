use crate::domain::feedback::*;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Json, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::io::AsyncWriteExt;
use ulid::Ulid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/feedback", post(create))
        .route("/v1/feedback/:id", get(get_one))
        .route("/v1/feedback/:id/attach", post(attach))
}

#[derive(Deserialize)]
pub struct ClaimQuery {
    pub token: String,
}

#[derive(Serialize)]
pub struct AttachmentView {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub bytes: i64,
}

#[derive(Serialize)]
pub struct FeedbackView {
    pub id: String,
    pub status: String,
    pub category: String,
    pub severity: Option<String>,
    pub title: String,
    pub description: String,
    pub admin_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attachments: Vec<AttachmentView>,
}

async fn create(
    State(s): State<AppState>,
    Json(input): Json<NewFeedback>,
) -> Result<(StatusCode, Json<CreateResponse>), AppError> {
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
        Json(CreateResponse {
            ticket_id: id,
            claim_token: claim,
        }),
    ))
}

async fn get_one(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ClaimQuery>,
) -> Result<Json<FeedbackView>, AppError> {
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
    .map(|r| AttachmentView {
        id: r.get("id"),
        filename: r.get("filename"),
        mime: r.get("mime"),
        bytes: r.get("bytes"),
    })
    .collect();
    let view = FeedbackView {
        id: row.get("id"),
        status: row.get("status"),
        category: row.get("category"),
        severity: row.get("severity"),
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

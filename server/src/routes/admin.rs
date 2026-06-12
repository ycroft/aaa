use crate::auth::AdminAuth;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::{body::Body, Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/api/feedback", get(list))
        .route("/admin/api/feedback/:id", patch(update_one))
        .route("/admin/api/feedback/:id/attachment/:aid", get(download))
        .route("/admin/api/releases", post(publish))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list(
    _a: AdminAuth,
    State(s): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = if let Some(st) = q.status.as_deref() {
        sqlx::query(
            "SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(st)
        .bind(limit)
        .bind(offset)
        .fetch_all(&s.db)
        .await?
    } else {
        sqlx::query("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(limit)
            .bind(offset)
            .fetch_all(&s.db)
            .await?
    };
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String,_>("id"),
                "status": r.get::<String,_>("status"),
                "category": r.get::<String,_>("category"),
                "severity": r.get::<Option<String>,_>("severity"),
                "title": r.get::<String,_>("title"),
                "description": r.get::<String,_>("description"),
                "contact_email": r.get::<Option<String>,_>("contact_email"),
                "app_version": r.get::<String,_>("app_version"),
                "os_info": r.get::<String,_>("os_info"),
                "device_id": r.get::<String,_>("device_id"),
                "log_excerpt": r.get::<Option<String>,_>("log_excerpt"),
                "admin_note": r.get::<Option<String>,_>("admin_note"),
                "created_at": r.get::<i64,_>("created_at"),
                "updated_at": r.get::<i64,_>("updated_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct PatchBody {
    status: Option<String>,
    admin_note: Option<String>,
}

async fn update_one(
    _a: AdminAuth,
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<PatchBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    if let Some(st) = &b.status {
        if !matches!(
            st.as_str(),
            "new" | "triaged" | "in_progress" | "resolved" | "wontfix"
        ) {
            return Err(AppError::BadRequest("invalid status".into()));
        }
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let res = sqlx::query(
        "UPDATE feedback SET status = COALESCE(?, status), admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?",
    )
    .bind(&b.status)
    .bind(&b.admin_note)
    .bind(now)
    .bind(&id)
    .execute(&s.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn download(
    _a: AdminAuth,
    State(s): State<AppState>,
    Path((_id, aid)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let row = sqlx::query(
        "SELECT filename, mime, storage_path FROM feedback_attachment WHERE id = ?",
    )
    .bind(&aid)
    .fetch_optional(&s.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let storage_rel: String = row.get("storage_path");
    let path = s.cfg.uploads.dir.join(storage_rel);
    let bytes = tokio::fs::read(&path).await?;
    let mime: String = row.get("mime");
    let filename: String = row.get("filename");
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(bytes))
        .unwrap())
}

async fn publish(
    _a: AdminAuth,
    State(s): State<AppState>,
    mut mp: Multipart,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let mut version: Option<String> = None;
    struct File {
        filename: String,
        bytes: Vec<u8>,
    }
    let mut artifact: Option<File> = None;
    let mut signature: Option<File> = None;

    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = f.name().unwrap_or("").to_string();
        let filename = f.file_name().map(|s| s.to_string());
        let mut buf = Vec::new();
        while let Some(chunk) = f
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?
        {
            buf.extend_from_slice(&chunk);
            if buf.len() > 500 * 1024 * 1024 {
                return Err(AppError::PayloadTooLarge);
            }
        }
        match name.as_str() {
            "version" => {
                version = Some(
                    String::from_utf8(buf)
                        .map_err(|_| AppError::BadRequest("version utf8".into()))?
                        .trim()
                        .to_string(),
                );
            }
            "artifact" => {
                artifact = Some(File {
                    filename: filename.unwrap_or_default(),
                    bytes: buf,
                });
            }
            "signature" => {
                signature = Some(File {
                    filename: filename.unwrap_or_default(),
                    bytes: buf,
                });
            }
            _ => {}
        }
    }
    let version = version.ok_or_else(|| AppError::BadRequest("version required".into()))?;
    semver::Version::parse(&version)
        .map_err(|e| AppError::BadRequest(format!("bad version: {}", e)))?;
    let art = artifact.ok_or_else(|| AppError::BadRequest("artifact required".into()))?;
    let sig = signature.ok_or_else(|| AppError::BadRequest("signature required".into()))?;
    if !art
        .filename
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(AppError::BadRequest(
            "artifact filename contains illegal chars".into(),
        ));
    }
    if !sig
        .filename
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(AppError::BadRequest(
            "signature filename contains illegal chars".into(),
        ));
    }
    let dir = s.cfg.updates.artifacts_dir.join(&version);
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(dir.join(&art.filename), &art.bytes).await?;
    tokio::fs::write(dir.join(&sig.filename), &sig.bytes).await?;
    tracing::info!(%version, "release published");
    Ok((StatusCode::CREATED, Json(json!({ "version": version }))))
}

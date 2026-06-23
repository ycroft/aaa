// Web frontend API routes.
//
// Authentication uses cookie-based fake SSO (see auth_web.rs).
// TODO(real-sso): Replace RequireAuth/RequireAdmin extractors with real SSO
// validation once the company identity service integration is ready.
use crate::auth_web::{RequireAdmin, RequireAuth};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::{body::Body, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

pub fn router() -> Router<AppState> {
    Router::new()
        // Auth
        .route("/api/auth/me", get(me))
        // Session analysis
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/:id", get(get_session).delete(delete_session))
        // POST /api/sessions/import — stub: internal data source not yet connected.
        // TODO(data-source): Implement this endpoint to query the internal data source:
        //   1. Accept { employee_id: String, start_date: String, end_date: String }.
        //   2. Query the internal session DB for matching records.
        //   3. Transform rows into SessionDetail (core/src/model.rs schema).
        //   4. Serialize and write to web_sessions table.
        //   5. Return the list of imported session IDs.
        // Until the internal data source schema is finalized, this returns 501.
        .route("/api/sessions/import", post(import_stub))
        // Public: version list for download page
        .route("/api/releases", get(list_releases))
        // Admin-only endpoints (same logic as routes/admin.rs, web-auth gated)
        .route("/api/admin/feedback", get(admin_list_feedback))
        .route("/api/admin/feedback/:id", patch(admin_update_feedback))
        .route("/api/admin/feedback/:id/attachment/:aid", get(admin_download_attachment))
        .route("/api/admin/releases", post(admin_publish_release))
}

async fn me(RequireAuth(user): RequireAuth) -> Json<Value> {
    Json(json!({
        "user_id": user.user_id,
        "display_name": user.display_name,
        "is_admin": user.is_admin,
    }))
}

async fn list_sessions(
    RequireAuth(user): RequireAuth,
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "SELECT id, imported_at, provider_id, session_id, import_source, summary_json \
         FROM web_sessions WHERE user_id = ? ORDER BY imported_at DESC LIMIT 200",
    )
    .bind(&user.user_id)
    .fetch_all(&s.db)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let summary: Value = serde_json::from_str(r.get("summary_json")).unwrap_or(json!({}));
            json!({
                "id": r.get::<String, _>("id"),
                "imported_at": r.get::<i64, _>("imported_at"),
                "provider_id": r.get::<String, _>("provider_id"),
                "session_id": r.get::<String, _>("session_id"),
                "import_source": r.get::<String, _>("import_source"),
                "summary": summary,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn get_session(
    RequireAuth(user): RequireAuth,
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query(
        "SELECT detail_json FROM web_sessions WHERE id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&user.user_id)
    .fetch_optional(&s.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let detail: Value = serde_json::from_str(row.get("detail_json"))
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(detail))
}

async fn delete_session(
    RequireAuth(user): RequireAuth,
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let res = sqlx::query("DELETE FROM web_sessions WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.user_id)
        .execute(&s.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn import_stub(
    RequireAuth(_user): RequireAuth,
) -> (StatusCode, Json<Value>) {
    // TODO(data-source): See route registration comment above for implementation plan.
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": 501,
            "message": "数据源导入功能待接入内网数据源，请联系管理员。Import from internal data source not yet implemented."
        })),
    )
}

async fn list_releases(State(s): State<AppState>) -> Result<Json<Value>, AppError> {
    let artifacts_dir = &s.cfg.updates.artifacts_dir;
    let mut versions: Vec<semver::Version> = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(artifacts_dir).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            if let Ok(name) = entry.file_name().into_string() {
                if let Ok(v) = semver::Version::parse(&name) {
                    versions.push(v);
                }
            }
        }
    }
    versions.sort_by(|a, b| b.cmp(a));

    let items: Vec<Value> = versions
        .iter()
        .map(|v| {
            let ver = v.to_string();
            let base = format!("{}/v1/updates/artifacts/{}", s.cfg.server.public_url, ver);
            json!({
                "version": ver,
                "msi_url": format!("{}/AAA_{}_x64_en-US.msi", base, ver),
                "nsis_url": format!("{}/AAA_{}_x64-setup.exe", base, ver),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

// --- Admin endpoints (web-auth based, mirrors routes/admin.rs logic) ---

#[derive(Deserialize)]
struct FeedbackListQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn admin_list_feedback(
    RequireAdmin(_admin): RequireAdmin,
    State(s): State<AppState>,
    Query(q): Query<FeedbackListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = if let Some(st) = q.status.as_deref() {
        sqlx::query(
            "SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(st).bind(limit).bind(offset)
        .fetch_all(&s.db).await?
    } else {
        sqlx::query("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(limit).bind(offset)
            .fetch_all(&s.db).await?
    };
    let items: Vec<Value> = rows.iter().map(|r| json!({
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
        "admin_note": r.get::<Option<String>,_>("admin_note"),
        "created_at": r.get::<i64,_>("created_at"),
        "updated_at": r.get::<i64,_>("updated_at"),
    })).collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct FeedbackPatch {
    status: Option<String>,
    admin_note: Option<String>,
}

async fn admin_update_feedback(
    RequireAdmin(_admin): RequireAdmin,
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<FeedbackPatch>,
) -> Result<Json<Value>, AppError> {
    if let Some(st) = &b.status {
        if !matches!(st.as_str(), "new"|"triaged"|"in_progress"|"resolved"|"wontfix") {
            return Err(AppError::BadRequest("invalid status".into()));
        }
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let res = sqlx::query(
        "UPDATE feedback SET status=COALESCE(?,status), admin_note=COALESCE(?,admin_note), updated_at=? WHERE id=?",
    ).bind(&b.status).bind(&b.admin_note).bind(now).bind(&id)
    .execute(&s.db).await?;
    if res.rows_affected() == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

async fn admin_download_attachment(
    RequireAdmin(_admin): RequireAdmin,
    State(s): State<AppState>,
    Path((_id, aid)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let row = sqlx::query(
        "SELECT filename, mime, storage_path FROM feedback_attachment WHERE id = ?",
    ).bind(&aid).fetch_optional(&s.db).await?.ok_or(AppError::NotFound)?;
    let path = s.cfg.uploads.dir.join(row.get::<String,_>("storage_path"));
    let bytes = tokio::fs::read(&path).await?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, row.get::<String,_>("mime"))
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", row.get::<String,_>("filename")))
        .body(Body::from(bytes)).unwrap())
}

async fn admin_publish_release(
    RequireAdmin(_admin): RequireAdmin,
    State(s): State<AppState>,
    mp: Multipart,
) -> Result<(StatusCode, Json<Value>), AppError> {
    // Delegate to the same logic as routes/admin.rs publish handler.
    // Re-use the admin token route's implementation via inner call.
    crate::routes::admin::publish_inner(s, mp).await
}

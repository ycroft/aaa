use crate::domain::update::{pick_latest, PlatformAsset};
use crate::error::AppError;
use crate::state::AppState;
use axum::{extract::State, routing::get, Json, Router};
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/updates/manifest", get(manifest_handler))
}

pub async fn manifest_handler(
    State(s): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    manifest(State(s)).await
}

async fn manifest(State(s): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let latest = pick_latest(&s.cfg.updates.artifacts_dir)
        .map_err(|e| AppError::Internal(e.into()))?
        .ok_or(AppError::NotFound)?;
    let mut platforms = serde_json::Map::new();
    let push = |key: &str,
                asset: &Option<PlatformAsset>,
                ver: &semver::Version,
                base: &str,
                map: &mut serde_json::Map<String, serde_json::Value>| {
        if let Some(a) = asset {
            let fname = a
                .artifact
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let url = format!(
                "{}/v1/updates/artifacts/{}/{}",
                base.trim_end_matches('/'),
                ver,
                fname
            );
            map.insert(
                key.to_string(),
                json!({"url": url, "signature": a.signature}),
            );
        }
    };
    push(
        "linux-x86_64",
        &latest.linux,
        &latest.version,
        &s.cfg.server.public_url,
        &mut platforms,
    );
    push(
        "windows-x86_64",
        &latest.windows,
        &latest.version,
        &s.cfg.server.public_url,
        &mut platforms,
    );
    if platforms.is_empty() {
        return Err(AppError::NotFound);
    }
    let pub_date = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    Ok(Json(json!({
        "version": latest.version.to_string(),
        "pub_date": pub_date,
        "notes": "see in-app About",
        "platforms": platforms,
    })))
}

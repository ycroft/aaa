use axum::{routing::get, Json, Router};
use serde_json::json;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/healthz", get(handler))
}

async fn handler() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

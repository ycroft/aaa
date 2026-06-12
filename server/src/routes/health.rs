use axum::{routing::get, Json, Router};
use serde_json::json;

pub fn router() -> Router {
    Router::new().route("/healthz", get(handler))
}

async fn handler() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

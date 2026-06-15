use axum::{routing::get, Json, Router};

use aaa_wire::health::HealthResponse;
use aaa_wire::SCHEMA_VERSION;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/healthz", get(handler))
}

async fn handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: SCHEMA_VERSION,
    })
}

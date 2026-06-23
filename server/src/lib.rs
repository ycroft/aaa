pub mod auth;
pub mod auth_web;
pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod notify;
pub mod ratelimit;
pub mod routes;
pub mod state;

use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::Router;
use state::AppState;
use tower_http::services::ServeDir;

pub fn build_router_with(state: AppState) -> Router {
    let artifacts = state.cfg.updates.artifacts_dir.clone();
    let limited_feedback_create = Router::new()
        .route("/v1/feedback", post(routes::feedback::create_handler))
        .route_layer(from_fn_with_state(state.clone(), ratelimit::limit_feedback));
    let limited_manifest = Router::new()
        .route("/v1/updates/manifest", get(routes::updates::manifest_handler))
        .route_layer(from_fn_with_state(state.clone(), ratelimit::limit_manifest));

    Router::new()
        .merge(routes::health::router())
        .merge(routes::feedback::unlimited_router())
        .merge(limited_feedback_create)
        .merge(limited_manifest)
        .merge(routes::web_api::router())
        .nest_service("/v1/updates/artifacts", ServeDir::new(artifacts))
        // SPA catch-all: must be last so API routes take priority.
        .merge(routes::web_static::router())
        .with_state(state)
}

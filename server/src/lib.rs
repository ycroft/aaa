pub mod auth;
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
    // Routes that need rate limiting are wired here so we can attach a per-route layer.
    let limited_feedback_create = Router::new()
        .route("/v1/feedback", post(routes::feedback::create_handler))
        .route_layer(from_fn_with_state(
            state.clone(),
            ratelimit::limit_feedback,
        ));
    let limited_manifest = Router::new()
        .route(
            "/v1/updates/manifest",
            get(routes::updates::manifest_handler),
        )
        .route_layer(from_fn_with_state(state.clone(), ratelimit::limit_manifest));

    Router::new()
        .merge(routes::health::router())
        .merge(routes::feedback::unlimited_router())
        .merge(limited_feedback_create)
        .merge(limited_manifest)
        .merge(routes::admin::router())
        .nest_service("/v1/updates/artifacts", ServeDir::new(artifacts))
        .nest_service(
            "/admin",
            ServeDir::new("server/admin-ui").append_index_html_on_directories(true),
        )
        .with_state(state)
}

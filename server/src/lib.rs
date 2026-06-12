pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod notify;
pub mod routes;
pub mod state;

use axum::Router;
use state::AppState;
use tower_http::services::ServeDir;

pub fn build_router_with(state: AppState) -> Router {
    let artifacts = state.cfg.updates.artifacts_dir.clone();
    Router::new()
        .merge(routes::health::router())
        .merge(routes::feedback::router())
        .merge(routes::updates::router())
        .nest_service("/v1/updates/artifacts", ServeDir::new(artifacts))
        .with_state(state)
}

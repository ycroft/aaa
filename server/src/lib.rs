pub mod config;
pub mod db;
pub mod routes;
pub mod state;

use axum::Router;
use state::AppState;

pub fn build_router_with(state: AppState) -> Router {
    Router::new()
        .merge(routes::health::router())
        .with_state(state)
}

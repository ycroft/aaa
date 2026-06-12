pub mod routes;

use axum::Router;

pub fn build_router() -> Router {
    Router::new().merge(routes::health::router())
}

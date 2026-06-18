// Admin UI static assets, embedded at compile time so the server works regardless
// of the current working directory at launch.
use crate::state::AppState;
use axum::body::Body;
use axum::http::header;
use axum::response::Response;
use axum::routing::get;
use axum::Router;

const INDEX_HTML: &[u8] = include_bytes!("../../admin-ui/index.html");
const ADMIN_JS: &[u8] = include_bytes!("../../admin-ui/admin.js");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin", get(index))
        .route("/admin/", get(index))
        .route("/admin/index.html", get(index))
        .route("/admin/admin.js", get(js))
}

async fn index() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(INDEX_HTML))
        .unwrap()
}

async fn js() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/javascript; charset=utf-8")
        .body(Body::from(ADMIN_JS))
        .unwrap()
}

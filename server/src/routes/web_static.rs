// Serves the React SPA (server/web/dist/) embedded at compile time via rust-embed.
// Any path not matched by an API route falls through to this handler, which
// returns the exact asset if it exists or index.html for SPA client-side routing.
use crate::state::AppState;
use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(|| serve("index.html")))
        .route("/*path", get(|Path(path): Path<String>| serve(path)))
}

async fn serve(path: impl AsRef<str>) -> Response {
    let path = path.as_ref().trim_start_matches('/');
    if let Some(asset) = WebAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return Response::builder()
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(asset.data.into_owned()))
            .unwrap();
    }
    // SPA fallback: return index.html for unknown paths so React Router handles them.
    if let Some(index) = WebAssets::get("index.html") {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("not found"))
        .unwrap()
}

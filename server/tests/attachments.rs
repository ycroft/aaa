mod common;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

async fn create_one(app: &axum::Router) -> (String, String) {
    let payload = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/feedback")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    (
        body["ticket_id"].as_str().unwrap().into(),
        body["claim_token"].as_str().unwrap().into(),
    )
}

fn multipart(
    name: &str,
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> (String, Vec<u8>) {
    let boundary = "----X";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
            name, filename
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime).as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    (
        format!("multipart/form-data; boundary={}", boundary),
        body,
    )
}

#[tokio::test]
async fn attach_png_succeeds_and_appears_in_get() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let (ct, body) = multipart("file", "a.png", "image/png", b"\x89PNG\r\n\x1a\nfake");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
                .header(header::CONTENT_TYPE, ct)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    // GET should now report 1 attachment
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/feedback/{}?token={}", id, token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(body["attachments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn attach_oversize_returns_413() {
    let h = common::make().await;
    // Shrink limit to 4 bytes
    let mut cfg = (*h.state.cfg).clone();
    cfg.uploads.max_attachment_bytes = 4;
    let mut state = h.state.clone();
    state.cfg = std::sync::Arc::new(cfg);
    let app = aaa_hub::build_router_with(state);
    let (id, token) = create_one(&app).await;
    let (ct, body) = multipart(
        "file",
        "a.png",
        "image/png",
        b"\x89PNG\r\n\x1a\nLOTSOFBYTES",
    );
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
                .header(header::CONTENT_TYPE, ct)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn attach_unknown_mime_rejected() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let (ct, body) = multipart(
        "file",
        "a.exe",
        "application/x-msdownload",
        b"MZ",
    );
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/feedback/{}/attach?token={}", id, token))
                .header(header::CONTENT_TYPE, ct)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

async fn create_one(app: &axum::Router) -> String {
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
    body["ticket_id"].as_str().unwrap().into()
}

#[tokio::test]
async fn list_requires_admin_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/admin/api/feedback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_with_token_returns_items() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let _id = create_one(&app).await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/admin/api/feedback")
                .header("authorization", "Bearer TEST_ADMIN")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 65536).await.unwrap())
            .unwrap();
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn patch_status_persists() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let id = create_one(&app).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/admin/api/feedback/{}", id))
                .header("authorization", "Bearer TEST_ADMIN")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"status":"in_progress","admin_note":"looking"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/admin/api/feedback")
                .header("authorization", "Bearer TEST_ADMIN")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 65536).await.unwrap())
            .unwrap();
    assert_eq!(v["items"][0]["status"], "in_progress");
    assert_eq!(v["items"][0]["admin_note"], "looking");
}

#[tokio::test]
async fn publish_release_writes_artifacts_and_updates_manifest() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let boundary = "----X";
    let mut body = Vec::new();
    let mut push_part = |name: &str, filename: Option<&str>, mime: &str, content: &[u8]| {
        body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        match filename {
            Some(fn_) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                    name, fn_
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{}\"\r\n", name).as_bytes(),
            ),
        }
        body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime).as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(b"\r\n");
    };
    push_part("version", None, "text/plain", b"0.9.0");
    push_part(
        "artifact",
        Some("AAA_0.9.0_amd64.AppImage"),
        "application/octet-stream",
        b"BIN",
    );
    push_part(
        "signature",
        Some("AAA_0.9.0_amd64.AppImage.sig"),
        "text/plain",
        b"SIG",
    );
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/api/releases")
                .header("authorization", "Bearer TEST_ADMIN")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={}", boundary),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/updates/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(v["version"], "0.9.0");
}

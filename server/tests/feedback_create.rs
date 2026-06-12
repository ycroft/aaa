mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_feedback_returns_ticket_and_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let payload = json!({
        "category": "bug",
        "title": "X crashes on startup",
        "description": "details...",
        "app_version": "0.8.1",
        "os_info": "linux/ubuntu/22.04/x86_64",
        "device_id": "01HXYZ"
    });
    let res = app
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
    assert_eq!(res.status(), StatusCode::CREATED);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(body["ticket_id"].as_str().unwrap().len(), 26);
    assert!(body["claim_token"].as_str().unwrap().len() >= 32);
}

#[tokio::test]
async fn create_feedback_rejects_empty_title() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let payload = json!({
        "category": "bug", "title": "", "description": "x",
        "app_version": "0", "os_info": "linux", "device_id": "0"
    });
    let res = app
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
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

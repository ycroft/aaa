mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
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

#[tokio::test]
async fn get_feedback_with_correct_token() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/feedback/{}?token={}", id, token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(body["status"], "new");
    assert_eq!(body["title"], "t");
    assert!(body["attachments"].is_array());
}

#[tokio::test]
async fn get_feedback_with_wrong_token_is_unauthorized() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, _) = create_one(&app).await;
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/feedback/{}?token=WRONG", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_unknown_feedback_returns_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/feedback/01HXNOTREAL?token=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

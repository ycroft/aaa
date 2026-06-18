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
async fn withdraw_with_correct_token_returns_204_and_makes_get_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/feedback/{}?token={}", id, token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // After withdrawal the ticket should be gone — even with the right token,
    // GET should return 404, not 401.
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/feedback/{}?token={}", id, token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn withdraw_with_wrong_token_is_unauthorized_and_keeps_record() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/feedback/{}?token=WRONG", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Record must still be retrievable with the real token.
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
}

#[tokio::test]
async fn withdraw_unknown_ticket_returns_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/feedback/01HXNOTREAL?token=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn withdraw_removes_attachment_dir_from_disk() {
    let h = common::make().await;
    let uploads = h.state.cfg.uploads.dir.clone();
    let app = aaa_hub::build_router_with(h.state.clone());
    let (id, token) = create_one(&app).await;

    // Simulate a previously-uploaded attachment by hand-crafting the dir.
    // The withdraw handler must clean this up even though we didn't go
    // through POST /attach (which would have inserted a DB row too).
    let ticket_dir = uploads.join(&id);
    std::fs::create_dir_all(&ticket_dir).unwrap();
    std::fs::write(ticket_dir.join("dummy.png"), b"not a real png").unwrap();
    assert!(ticket_dir.exists());

    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/feedback/{}?token={}", id, token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(!ticket_dir.exists(), "attachment dir should be gone");
}

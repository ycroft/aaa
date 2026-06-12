mod common;

use axum::body::Body;
use axum::http::Request;
use serde_json::json;
use std::sync::atomic::Ordering;
use tower::ServiceExt;

#[tokio::test]
async fn create_calls_notifier() {
    let h = common::make().await;
    let counter = h.notifier_counter.clone();
    let app = aaa_hub::build_router_with(h.state.clone());
    let payload = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
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
    assert_eq!(res.status().as_u16(), 201);
    // Notifier is fired asynchronously; give it a moment.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn accepts_payload_with_unknown_fields_and_future_enum() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    // Simulate a future client: extra unknown fields, schema_version higher,
    // severity carrying a value the server doesn't know yet.
    let payload = json!({
        "schema_version": 99,
        "category": "bug",
        "severity": "showstopper_v2",
        "title": "future client",
        "description": "should still parse",
        "app_version": "9.9.9",
        "os_info": "linux/future",
        "device_id": "FUTURE",
        "future_metadata": { "anything": [1, 2, 3] }
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
    // Response should now carry schema_version too.
    assert_eq!(body["schema_version"].as_u64(), Some(1));
}

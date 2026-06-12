mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_feedback_rate_limit_kicks_in() {
    let h = common::make().await;
    let mut cfg = (*h.state.cfg).clone();
    cfg.ratelimit.feedback_per_ip_per_hour = 2;
    let mut state = h.state.clone();
    state.cfg = std::sync::Arc::new(cfg);
    state.limiters = aaa_hub::ratelimit::build(&state.cfg.ratelimit);
    let app = aaa_hub::build_router_with(state);
    let body = json!({
        "category": "bug", "title": "t", "description": "d",
        "app_version": "0.8.1", "os_info": "linux", "device_id": "01H"
    })
    .to_string();
    let mk = || {
        Request::builder()
            .method("POST")
            .uri("/v1/feedback")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "1.2.3.4")
            .body(Body::from(body.clone()))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(mk()).await.unwrap().status(),
        StatusCode::CREATED
    );
    assert_eq!(
        app.clone().oneshot(mk()).await.unwrap().status(),
        StatusCode::CREATED
    );
    assert_eq!(
        app.clone().oneshot(mk()).await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

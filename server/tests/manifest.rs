mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

fn write(p: &std::path::Path, content: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

#[tokio::test]
async fn manifest_picks_latest_semver() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.8.0/AAA_0.8.0_amd64.AppImage"), "old");
    write(&root.join("0.8.0/AAA_0.8.0_amd64.AppImage.sig"), "SIG_OLD");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "new");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage.sig"), "SIG_NEW");
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/updates/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(v["version"], "0.9.0");
    assert_eq!(v["platforms"]["linux-x86_64"]["signature"], "SIG_NEW");
    assert!(v["platforms"]["linux-x86_64"]["url"]
        .as_str()
        .unwrap()
        .ends_with("/v1/updates/artifacts/0.9.0/AAA_0.9.0_amd64.AppImage"));
}

#[tokio::test]
async fn manifest_skips_platform_without_signature() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "new");
    // no .sig
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/updates/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn manifest_when_empty_returns_404() {
    let h = common::make().await;
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/updates/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn artifact_static_serve_works() {
    let h = common::make().await;
    let root = &h.state.cfg.updates.artifacts_dir;
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage"), "DOWNLOAD_BYTES");
    write(&root.join("0.9.0/AAA_0.9.0_amd64.AppImage.sig"), "SIG");
    let app = aaa_hub::build_router_with(h.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/updates/artifacts/0.9.0/AAA_0.9.0_amd64.AppImage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    assert_eq!(&body[..], b"DOWNLOAD_BYTES");
}

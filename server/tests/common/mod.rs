// Shared test harness — note: must be `pub` so test crates can `mod common;`.
#![allow(dead_code)]

use aaa_hub::config::*;
use aaa_hub::state::AppState;
use std::sync::Arc;
use tempfile::TempDir;

pub struct Harness {
    pub dir: TempDir,
    pub state: AppState,
}

pub async fn make() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        server: Server {
            bind: "127.0.0.1:0".into(),
            public_url: "http://test.local".into(),
            data_dir: dir.path().to_path_buf(),
            admin_token: "TEST_ADMIN".into(),
        },
        updates: Updates {
            artifacts_dir: dir.path().join("artifacts"),
            pubkey: "PUBKEY".into(),
        },
        uploads: Uploads {
            dir: dir.path().join("uploads"),
            max_attachment_bytes: 1024 * 1024,
            allowed_mime: vec!["image/png".into(), "image/jpeg".into()],
        },
        notify: Notify {
            email: EmailNotify {
                enabled: false,
                smtp_host: "".into(),
                smtp_port: 0,
                smtp_user: "".into(),
                smtp_password: "".into(),
                from: "".into(),
                to: vec![],
            },
        },
        ratelimit: RateLimit {
            feedback_per_ip_per_hour: 1000,
            manifest_per_ip_per_minute: 1000,
        },
    };
    std::fs::create_dir_all(&cfg.uploads.dir).unwrap();
    std::fs::create_dir_all(&cfg.updates.artifacts_dir).unwrap();
    let pool = aaa_hub::db::open(&dir.path().join("test.db")).await.unwrap();
    let state = AppState {
        cfg: Arc::new(cfg),
        db: pool,
    };
    Harness { dir, state }
}

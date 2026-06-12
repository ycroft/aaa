use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg_path = std::env::var("AAA_HUB_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/etc/aaa-hub/config.toml"));
    let cfg = aaa_hub::config::Config::load_from(&cfg_path)?;
    let db_path = cfg.server.data_dir.join("aaa-hub.db");
    let pool = aaa_hub::db::open(&db_path).await?;

    let notifier: Arc<dyn aaa_hub::notify::Notifier> = if cfg.notify.email.enabled {
        match aaa_hub::notify::email::EmailNotifier::new(
            cfg.notify.email.clone(),
            &cfg.server.public_url,
        ) {
            Ok(n) => Arc::new(n),
            Err(e) => {
                tracing::warn!(error=%e, "email notifier disabled (init failed)");
                Arc::new(aaa_hub::notify::NoopNotifier)
            }
        }
    } else {
        Arc::new(aaa_hub::notify::NoopNotifier)
    };

    let bind = cfg.server.bind.clone();
    let limiters = aaa_hub::ratelimit::build(&cfg.ratelimit);
    let state = aaa_hub::state::AppState {
        cfg: Arc::new(cfg),
        db: pool,
        notifier,
        limiters,
    };
    let app = aaa_hub::build_router_with(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}

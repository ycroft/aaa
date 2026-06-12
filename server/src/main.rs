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
    let bind = cfg.server.bind.clone();
    let state = aaa_hub::state::AppState { cfg: Arc::new(cfg), db: pool };
    let app = aaa_hub::build_router_with(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}

use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg_path = std::env::var("AAA_HUB_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/etc/aaa-hub/config.toml"));
    let cfg = aaa_hub::config::Config::load_from(&cfg_path)?;
    let app = aaa_hub::build_router();
    let listener = tokio::net::TcpListener::bind(&cfg.server.bind).await?;
    tracing::info!(bind = %cfg.server.bind, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}

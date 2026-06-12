use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let app = aaa_hub::build_router();
    let addr: SocketAddr = "127.0.0.1:8443".parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "aaa-hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}

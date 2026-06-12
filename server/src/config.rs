use std::path::{Path, PathBuf};
use serde::Deserialize;
use figment::{Figment, providers::{Format, Toml, Env}};

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub server: Server,
    pub updates: Updates,
    pub uploads: Uploads,
    pub notify: Notify,
    pub ratelimit: RateLimit,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Server {
    pub bind: String,
    pub public_url: String,
    pub data_dir: PathBuf,
    pub admin_token: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Updates {
    pub artifacts_dir: PathBuf,
    pub pubkey: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Uploads {
    pub dir: PathBuf,
    pub max_attachment_bytes: u64,
    pub allowed_mime: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Notify {
    pub email: EmailNotify,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EmailNotify {
    pub enabled: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub from: String,
    pub to: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimit {
    pub feedback_per_ip_per_hour: u32,
    pub manifest_per_ip_per_minute: u32,
}

impl Config {
    pub fn load_from(path: &Path) -> anyhow::Result<Self> {
        let cfg: Config = Figment::new()
            .merge(Toml::file(path))
            .merge(Env::prefixed("AAA_HUB_").split("__"))
            .extract()?;
        Ok(cfg)
    }
}

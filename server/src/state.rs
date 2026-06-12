use crate::config::Config;
use crate::notify::Notifier;
use crate::ratelimit::Limiters;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: SqlitePool,
    pub notifier: Arc<dyn Notifier>,
    pub limiters: Limiters,
}

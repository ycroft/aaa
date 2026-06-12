use crate::config::Config;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: SqlitePool,
}

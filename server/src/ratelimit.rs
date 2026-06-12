use crate::error::AppError;
use governor::clock::DefaultClock;
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};
use std::net::IpAddr;
use std::num::NonZeroU32;
use std::sync::Arc;

pub type IpLimiter = RateLimiter<IpAddr, DefaultKeyedStateStore<IpAddr>, DefaultClock>;

#[derive(Clone)]
pub struct Limiters {
    pub feedback: Arc<IpLimiter>,
    pub manifest: Arc<IpLimiter>,
}

pub fn build(cfg: &crate::config::RateLimit) -> Limiters {
    let fb = Quota::per_hour(NonZeroU32::new(cfg.feedback_per_ip_per_hour.max(1)).unwrap());
    let mf = Quota::per_minute(NonZeroU32::new(cfg.manifest_per_ip_per_minute.max(1)).unwrap());
    Limiters {
        feedback: Arc::new(RateLimiter::keyed(fb)),
        manifest: Arc::new(RateLimiter::keyed(mf)),
    }
}

pub fn extract_ip(headers: &axum::http::HeaderMap, fallback: IpAddr) -> IpAddr {
    headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(',').next().map(|x| x.trim()))
        .and_then(|s| s.parse::<IpAddr>().ok())
        .unwrap_or(fallback)
}

/// Middleware for the feedback POST limiter.
pub async fn limit_feedback(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let ip = extract_ip(req.headers(), IpAddr::from([0, 0, 0, 0]));
    if state.limiters.feedback.check_key(&ip).is_err() {
        return Err(AppError::RateLimited);
    }
    Ok(next.run(req).await)
}

/// Middleware for the manifest GET limiter.
pub async fn limit_manifest(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let ip = extract_ip(req.headers(), IpAddr::from([0, 0, 0, 0]));
    if state.limiters.manifest.check_key(&ip).is_err() {
        return Err(AppError::RateLimited);
    }
    Ok(next.run(req).await)
}

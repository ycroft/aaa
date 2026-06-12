use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

pub struct AdminAuth;

#[async_trait::async_trait]
impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, s: &AppState) -> Result<Self, Self::Rejection> {
        let want = s.cfg.server.admin_token.as_bytes();
        let got = parts
            .headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        if want.len() != got.len() {
            return Err(AppError::Unauthorized);
        }
        let mut diff = 0u8;
        for (a, b) in want.iter().zip(got.as_bytes()) {
            diff |= a ^ b;
        }
        if diff == 0 {
            Ok(AdminAuth)
        } else {
            Err(AppError::Unauthorized)
        }
    }
}

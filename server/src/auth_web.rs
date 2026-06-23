// Web authentication via company SSO cookie.
//
// CURRENT IMPLEMENTATION (fake/dev):
//   The configured cookie value is used directly as the user_id.
//   display_name is derived as "员工_<user_id>".
//   admin status is checked against config.server.admin_users.
//
// TODO(real-sso): Replace fake_extract_user with a real implementation:
//   1. Read the cookie named config.server.sso_cookie_name.
//   2. POST the cookie value to the company SSO validation endpoint
//      (e.g. https://sso.internal/api/validate) to obtain {user_id, display_name}.
//   3. Cache the result in web_auth_sessions for the cookie's TTL.
//   4. Return WebUser or 401 if the SSO service rejects the cookie.
//
// Log: Every auth decision is logged at DEBUG so ops can trace failures without
// exposing PII in production logs (user_id is considered non-sensitive).

use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

#[derive(Debug, Clone, serde::Serialize)]
pub struct WebUser {
    pub user_id: String,
    pub display_name: String,
    pub is_admin: bool,
}

fn extract_cookie<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts
        .headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| {
            raw.split(';').find_map(|pair| {
                let pair = pair.trim();
                pair.strip_prefix(name)
                    .and_then(|rest| rest.strip_prefix('='))
            })
        })
}

fn fake_extract_user(parts: &Parts, state: &AppState) -> Option<WebUser> {
    let cookie_name = &state.cfg.server.sso_cookie_name;
    let user_id = extract_cookie(parts, cookie_name)?;
    if user_id.is_empty() {
        return None;
    }
    let user_id = user_id.to_string();
    let is_admin = state.cfg.server.admin_users.contains(&user_id);
    tracing::debug!(%user_id, is_admin, "web auth resolved (fake-sso)");
    Some(WebUser {
        display_name: format!("员工_{user_id}"),
        is_admin,
        user_id,
    })
}

/// Extractor: requires a valid web user session (any authenticated user).
pub struct RequireAuth(pub WebUser);

#[async_trait::async_trait]
impl FromRequestParts<AppState> for RequireAuth {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        fake_extract_user(parts, state)
            .map(RequireAuth)
            .ok_or(AppError::Unauthorized)
    }
}

/// Extractor: requires an admin user.
pub struct RequireAdmin(pub WebUser);

#[async_trait::async_trait]
impl FromRequestParts<AppState> for RequireAdmin {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let user = fake_extract_user(parts, state).ok_or(AppError::Unauthorized)?;
        if !user.is_admin {
            return Err(AppError::Unauthorized);
        }
        Ok(RequireAdmin(user))
    }
}

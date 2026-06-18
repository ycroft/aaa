//! Tauri commands added for the aaa-hub integration.
//!
//! These commands enforce the "fail silently" rule: any HTTP / I/O / parse
//! failure is logged at info or warn level via the `log` crate and the
//! command returns `Ok(None)` / `Ok(default)`. The frontend never sees an
//! `Err` from these commands.

use crate::hub::{HubClient, HubStatus, RemoteTicketView};
use aaa_core::feedback::{LocalTicket, LocalTickets};
use aaa_core::log_buffer::LogBuffer;
use aaa_core::log_excerpt;
use base64::Engine;
use log::{info, warn};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn hub_status(hub: State<'_, Mutex<HubClient>>) -> Result<HubStatus, String> {
    // Clone behind the mutex so we don't hold it across await.
    let client = { hub.lock().unwrap().clone() };
    Ok(client.ping().await)
}

#[derive(Deserialize)]
pub struct FeedbackInput {
    pub category: String,
    pub severity: Option<String>,
    pub title: String,
    pub description: String,
    pub contact_email: Option<String>,
    pub include_version: bool,
    pub include_os: bool,
    pub include_log_excerpt: bool,
    pub include_device_id: bool,
    pub attachments: Vec<FeedbackAttachmentInput>,
}

#[derive(Deserialize)]
pub struct FeedbackAttachmentInput {
    pub filename: String,
    pub mime: String,
    pub bytes_b64: String,
}

#[tauri::command]
pub async fn submit_feedback(
    hub: State<'_, Mutex<HubClient>>,
    buf: State<'_, LogBuffer>,
    input: FeedbackInput,
) -> Result<Option<LocalTicket>, String> {
    let settings = aaa_core::settings::load().map_err(|e| e.to_string())?;
    let client = { hub.lock().unwrap().clone() };

    let app_version = if input.include_version {
        env!("CARGO_PKG_VERSION").to_string()
    } else {
        "redacted".into()
    };
    let os_info = if input.include_os {
        os_info_string()
    } else {
        "redacted".into()
    };
    let device_id = if input.include_device_id {
        settings.hub.device_id.clone()
    } else {
        "anonymous".into()
    };
    let log_excerpt_value = if input.include_log_excerpt {
        Some(log_excerpt::collect(&buf))
    } else {
        None
    };

    let req = aaa_wire::feedback::CreateFeedbackRequest {
        schema_version: aaa_wire::SCHEMA_VERSION,
        category: parse_category(&input.category),
        severity: input.severity.as_deref().map(parse_severity),
        title: input.title.clone(),
        description: input.description.clone(),
        contact_email: input.contact_email.clone(),
        app_version,
        os_info,
        device_id,
        log_excerpt: log_excerpt_value,
    };

    let mut atts = Vec::new();
    for a in input.attachments {
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&a.bytes_b64) {
            Ok(b) => b,
            Err(e) => {
                warn!("attachment base64 decode failed: {}", e);
                continue;
            }
        };
        atts.push((a.filename, a.mime, bytes));
    }

    let created = client.submit(req, atts).await;
    let Some(c) = created else {
        info!("submit_feedback: hub returned None (silent)");
        return Ok(None);
    };
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let local = LocalTicket {
        id: c.ticket_id.clone(),
        claim_token: c.claim_token,
        title: input.title,
        category: input.category,
        created_at: now,
    };
    if let Err(e) = aaa_core::feedback::append(local.clone()) {
        warn!("persist local ticket failed: {}", e);
    }
    Ok(Some(local))
}

#[tauri::command]
pub async fn get_feedback_status(
    hub: State<'_, Mutex<HubClient>>,
    id: String,
    token: String,
) -> Result<Option<RemoteTicketView>, String> {
    let client = { hub.lock().unwrap().clone() };
    Ok(client.get_status(&id, &token).await)
}

#[tauri::command]
pub fn list_local_tickets() -> Result<LocalTickets, String> {
    aaa_core::feedback::load().map_err(|e| e.to_string())
}

/// Ask the hub to delete a ticket the user submitted from this machine,
/// then drop it from the local `tickets.json`. Returns true on a clean
/// success (server responded 2xx or 404 — both end in "server doesn't have
/// this anymore"). Any other failure returns false and leaves both sides
/// untouched, so the user can retry once the hub is reachable.
#[tauri::command]
pub async fn withdraw_feedback(
    hub: State<'_, Mutex<HubClient>>,
    id: String,
    token: String,
) -> Result<bool, String> {
    let client = { hub.lock().unwrap().clone() };
    let ok = client.withdraw(&id, &token).await;
    if ok {
        if let Err(e) = aaa_core::feedback::remove(&id) {
            warn!("remove local ticket failed: {}", e);
        }
    } else {
        info!("withdraw_feedback: hub refused or unreachable (silent)");
    }
    Ok(ok)
}

#[tauri::command]
pub async fn check_update(_app: AppHandle) -> Result<Option<String>, String> {
    // Hook into tauri-plugin-updater's UpdaterExt at the JS layer instead
    // of duplicating the check here. The frontend calls
    // `@tauri-apps/plugin-updater::check()` directly. This command is kept as a
    // best-effort no-op for symmetry with the plan API surface — returning
    // None means "no available info".
    Ok(None)
}

/// Re-bind the HubClient to the latest base_url from settings (call after
/// SettingsDialog persists changes).
#[tauri::command]
pub fn refresh_hub(hub: State<'_, Mutex<HubClient>>) -> Result<(), String> {
    let settings = aaa_core::settings::load().map_err(|e| e.to_string())?;
    let mut g = hub.lock().unwrap();
    g.rebind(&settings.hub);
    Ok(())
}

fn os_info_string() -> String {
    format!(
        "{}/{}/{}",
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH
    )
}

fn parse_category(s: &str) -> aaa_wire::feedback::Category {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(aaa_wire::feedback::Category::Other)
}

fn parse_severity(s: &str) -> aaa_wire::feedback::Severity {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(aaa_wire::feedback::Severity::Trivial)
}

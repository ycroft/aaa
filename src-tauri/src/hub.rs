//! Thin reqwest wrapper over aaa-hub. All public methods follow the
//! "fail silently" rule: any error is logged at info or warn level and the
//! method returns `None` / `HubStatus::Disconnected`. Callers must never
//! propagate errors to the UI.

use aaa_core::settings::HubSettings;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct HubClient {
    base: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum HubStatus {
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreatedTicket {
    pub ticket_id: String,
    pub claim_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTicketView {
    pub status: String,
    pub admin_note: Option<String>,
    pub updated_at: i64,
}

impl HubClient {
    pub fn new(hs: &HubSettings) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("reqwest client");
        Self {
            base: hs.base_url.trim_end_matches('/').to_string(),
            http,
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.base.is_empty()
    }

    pub fn rebind(&mut self, hs: &HubSettings) {
        self.base = hs.base_url.trim_end_matches('/').to_string();
    }

    pub async fn ping(&self) -> HubStatus {
        if !self.is_configured() {
            return HubStatus::Disconnected;
        }
        match self
            .http
            .get(format!("{}/healthz", self.base))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => HubStatus::Connected,
            Ok(r) => {
                log::info!("hub healthz non-200: {}", r.status());
                HubStatus::Disconnected
            }
            Err(e) => {
                log::info!("hub unreachable: {}", e);
                HubStatus::Disconnected
            }
        }
    }

    pub async fn submit(
        &self,
        req: aaa_wire::feedback::CreateFeedbackRequest,
        attachments: Vec<(String, String, Vec<u8>)>,
    ) -> Option<CreatedTicket> {
        if !self.is_configured() {
            return None;
        }
        let res = self
            .http
            .post(format!("{}/v1/feedback", self.base))
            .json(&req)
            .send()
            .await;
        let created_resp: aaa_wire::feedback::CreateFeedbackResponse = match res {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("submit json decode: {}", e);
                    return None;
                }
            },
            Ok(r) => {
                log::warn!("submit non-success: {}", r.status());
                return None;
            }
            Err(e) => {
                log::warn!("submit transport: {}", e);
                return None;
            }
        };
        let created = CreatedTicket {
            ticket_id: created_resp.ticket_id,
            claim_token: created_resp.claim_token,
        };
        for (filename, mime, bytes) in attachments {
            let part = match reqwest::multipart::Part::bytes(bytes)
                .file_name(filename.clone())
                .mime_str(&mime)
            {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("bad mime {} for {}: {}", mime, filename, e);
                    continue;
                }
            };
            let form = reqwest::multipart::Form::new().part("file", part);
            let url = format!(
                "{}/v1/feedback/{}/attach?token={}",
                self.base, created.ticket_id, created.claim_token
            );
            if let Err(e) = self.http.post(url).multipart(form).send().await {
                log::warn!("attach failed (silent): {}", e);
            }
        }
        Some(created)
    }

    /// Withdraw (delete) a ticket the user originally submitted from this
    /// machine. Authenticates with the same `claim_token` flow as
    /// `get_status`. Returns true on success; both 2xx and 404 count as
    /// success — 404 means the server has already forgotten about this
    /// ticket, which is the same end-state we're after. All other failures
    /// (transport, 401, 5xx) return false and are logged at info / warn.
    pub async fn withdraw(&self, id: &str, token: &str) -> bool {
        if !self.is_configured() {
            return false;
        }
        match self
            .http
            .delete(format!("{}/v1/feedback/{}?token={}", self.base, id, token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() || r.status().as_u16() == 404 => true,
            Ok(r) => {
                log::warn!("withdraw non-success: {}", r.status());
                false
            }
            Err(e) => {
                log::warn!("withdraw transport: {}", e);
                false
            }
        }
    }

    pub async fn get_status(&self, id: &str, token: &str) -> Option<RemoteTicketView> {
        if !self.is_configured() {
            return None;
        }
        match self
            .http
            .get(format!("{}/v1/feedback/{}?token={}", self.base, id, token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r
                .json::<aaa_wire::feedback::GetFeedbackResponse>()
                .await
                .ok()
                .map(|v| RemoteTicketView {
                    status: v.status.as_str().to_string(),
                    admin_note: v.admin_note,
                    updated_at: v.updated_at,
                }),
            Ok(r) => {
                log::info!("get_status non-success: {}", r.status());
                None
            }
            Err(e) => {
                log::info!("get_status transport: {}", e);
                None
            }
        }
    }
}

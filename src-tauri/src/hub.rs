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
        body: serde_json::Value,
        attachments: Vec<(String, String, Vec<u8>)>,
    ) -> Option<CreatedTicket> {
        if !self.is_configured() {
            return None;
        }
        let res = self
            .http
            .post(format!("{}/v1/feedback", self.base))
            .json(&body)
            .send()
            .await;
        let created: CreatedTicket = match res {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(c) => c,
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
                .json::<serde_json::Value>()
                .await
                .ok()
                .map(|v| RemoteTicketView {
                    status: v["status"].as_str().unwrap_or("unknown").to_string(),
                    admin_note: v["admin_note"].as_str().map(|s| s.to_string()),
                    updated_at: v["updated_at"].as_i64().unwrap_or(0),
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

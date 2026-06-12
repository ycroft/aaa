use super::Notifier;
use crate::config::EmailNotify;
use crate::domain::feedback::NewFeedback;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub struct EmailNotifier {
    cfg: EmailNotify,
    transport: AsyncSmtpTransport<Tokio1Executor>,
    admin_url_base: String,
}

impl EmailNotifier {
    pub fn new(cfg: EmailNotify, public_url: &str) -> anyhow::Result<Self> {
        let mut t = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.smtp_host)?
            .port(cfg.smtp_port);
        if !cfg.smtp_user.is_empty() {
            t = t.credentials(Credentials::new(
                cfg.smtp_user.clone(),
                cfg.smtp_password.clone(),
            ));
        }
        Ok(Self {
            cfg,
            transport: t.build(),
            admin_url_base: public_url.trim_end_matches('/').to_string(),
        })
    }
}

#[async_trait::async_trait]
impl Notifier for EmailNotifier {
    async fn feedback_created(&self, ticket_id: &str, fb: &NewFeedback) {
        let from_addr = match self.cfg.from.parse::<lettre::message::Mailbox>() {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(error=%e, "invalid from address");
                return;
            }
        };
        let subject = format!("[aaa-hub] {} · {}", fb.category.as_str(), fb.title);
        let body = format!(
            "Ticket: {id}\nVersion: {ver}\nOS: {os}\n\nDescription:\n{desc}\n\nAdmin: {base}/admin/?id={id}\n",
            id = ticket_id,
            ver = fb.app_version,
            os = fb.os_info,
            desc = fb.description.chars().take(500).collect::<String>(),
            base = self.admin_url_base
        );
        for to in &self.cfg.to {
            let to_addr = match to.parse::<lettre::message::Mailbox>() {
                Ok(a) => a,
                Err(e) => {
                    tracing::warn!(error=%e, "invalid to address {}", to);
                    continue;
                }
            };
            let msg = match Message::builder()
                .from(from_addr.clone())
                .to(to_addr)
                .subject(&subject)
                .body(body.clone())
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error=%e, "build email");
                    continue;
                }
            };
            for attempt in 1u64..=3 {
                match self.transport.send(msg.clone()).await {
                    Ok(_) => break,
                    Err(e) if attempt < 3 => {
                        tracing::warn!(attempt, error=%e, "smtp retry");
                        tokio::time::sleep(std::time::Duration::from_millis(200 * attempt)).await;
                    }
                    Err(e) => {
                        tracing::warn!(error=%e, "smtp final fail");
                    }
                }
            }
        }
    }
}

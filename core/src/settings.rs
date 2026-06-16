//! Persistent app settings.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::remote::RemoteHost;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppSettings {
    pub provider_roots: std::collections::HashMap<String, String>,
    pub remotes: Vec<RemoteHost>,
    pub judger: JudgerSettings,
    pub ui: UiSettings,
    pub hub: HubSettings,
}

/// Settings for the optional aaa-hub backend (auto-update + feedback).
/// `base_url` empty means "not configured" — client treats every probe as
/// Disconnected and never makes outbound requests. `device_id` is generated
/// once on first save and persisted; lets the hub correlate multiple
/// submissions from the same machine without identifying the user.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HubSettings {
    pub base_url: String,
    pub device_id: String,
}

/// Per-user persistence for the Judger feature. `last_cmd` is the agent
/// command line the user submitted last so the form pre-fills it next time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct JudgerSettings {
    pub last_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiSettings {
    pub theme: String,
    pub preview_chars: u32,
    pub auto_expand_threshold_tokens: u64,
    /// "auto" follows navigator.language; "zh" / "en" are explicit overrides.
    pub language: String,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            preview_chars: 220,
            auto_expand_threshold_tokens: 0,
            language: "auto".into(),
        }
    }
}

fn settings_path() -> Result<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| anyhow!("no config dir"))?;
    let dir = dir.join("aaa");
    fs::create_dir_all(&dir).context("create config dir")?;
    Ok(dir.join("settings.json"))
}

pub fn load() -> Result<AppSettings> {
    let p = settings_path()?;
    if !p.exists() {
        let mut s = AppSettings::default();
        ensure_device_id(&mut s);
        save(&s)?;
        return Ok(s);
    }
    let raw = fs::read_to_string(&p).context("read settings.json")?;
    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(mut parsed) => {
            let dev_id_changed = ensure_device_id(&mut parsed);
            if dev_id_changed {
                let _ = save(&parsed);
            }
            Ok(parsed)
        }
        Err(e) => {
            log::warn!("settings.json parse failed at {:?}: {}; falling back to defaults", p, e);
            let mut s = AppSettings::default();
            ensure_device_id(&mut s);
            Ok(s)
        }
    }
}

/// Returns true if a new id was generated (caller may want to persist).
fn ensure_device_id(s: &mut AppSettings) -> bool {
    if s.hub.device_id.is_empty() {
        s.hub.device_id = ulid::Ulid::new().to_string();
        true
    } else {
        false
    }
}

pub fn save(settings: &AppSettings) -> Result<()> {
    let p = settings_path()?;
    let s = serde_json::to_string_pretty(settings)?;
    fs::write(&p, s).context("write settings.json")?;
    log::debug!("settings saved to {:?}", p);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_settings_round_trip() {
        let s = AppSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let parsed: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(parsed.remotes.is_empty());
    }

    #[test]
    fn missing_remotes_field_defaults_to_empty() {
        let json = r#"{"provider_roots":{},"ui":{"theme":"light","preview_chars":220,"auto_expand_threshold_tokens":0}}"#;
        let parsed: AppSettings = serde_json::from_str(json).unwrap();
        assert!(parsed.remotes.is_empty());
    }

    #[test]
    fn legacy_ai_field_is_silently_dropped() {
        let legacy = r#"{
            "provider_roots": {},
            "remotes": [],
            "ai": {"mode": "agent", "selected_agent": "claude"},
            "ui": {},
            "hub": {}
        }"#;
        let s: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.judger.last_cmd, None);
    }

    #[test]
    fn judger_last_cmd_persists() {
        let mut s = AppSettings::default();
        s.judger.last_cmd = Some("claude --skip".into());
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.judger.last_cmd.as_deref(), Some("claude --skip"));
    }
}

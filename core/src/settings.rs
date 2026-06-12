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
    pub ai: AiSettings,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiMode {
    #[default]
    None,
    Agent,
    Api,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TemplateScope {
    Single,
    #[default]
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub cmd_template: String,
    pub is_preset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
    pub scope: TemplateScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiSettings {
    pub mode: AiMode,
    pub selected_agent: Option<String>,
    pub agents: Vec<AgentConfig>,
    pub prompt_templates: Vec<PromptTemplate>,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            mode: AiMode::None,
            selected_agent: None,
            agents: vec![
                AgentConfig {
                    id: "claude".into(),
                    name: "Claude Code".into(),
                    cmd_template: "claude --dangerously-skip-permissions".into(),
                    is_preset: true,
                },
                AgentConfig {
                    id: "opencode".into(),
                    name: "opencode".into(),
                    cmd_template: "opencode".into(),
                    is_preset: true,
                },
                AgentConfig {
                    id: "nga".into(),
                    name: "NGA (opencode)".into(),
                    cmd_template: "opencode".into(),
                    is_preset: true,
                },
            ],
            prompt_templates: vec![
                PromptTemplate {
                    id: "analyze-single".into(),
                    name: "深度分析单个会话".into(),
                    content: "你是一位专业的 AI coding agent 会话分析师，精通 token 用量分析与上下文窗口管理。\n\n请深度分析提供的会话 JSON 文件，重点关注：\n1. Token 用量走势与峰值节点\n2. 上下文窗口占用率变化规律\n3. 高消耗操作（大文件读取、长工具结果等）\n4. 给出降低 token 消耗的具体建议".into(),
                    scope: TemplateScope::Single,
                },
                PromptTemplate {
                    id: "find-explosion".into(),
                    name: "上下文爆炸定位".into(),
                    content: "你是一位专业的 AI coding agent 会话分析师。\n\n请分析提供的会话 JSON 文件，定位导致上下文窗口激增的关键节点：\n1. 找出 cumulative_context_tokens 出现跳跃性增长的消息节点\n2. 分析该节点的内容，解释为何导致上下文激增\n3. 给出避免此类上下文爆炸的建议".into(),
                    scope: TemplateScope::Single,
                },
                PromptTemplate {
                    id: "cross-session-cost".into(),
                    name: "跨会话成本分析".into(),
                    content: "你是一位专业的 AI coding agent 使用成本分析师。\n\n请分析提供目录中的所有会话 JSON 文件，进行跨会话成本对比：\n1. 统计各会话的 token 消耗（input/output/cache）\n2. 识别高消耗会话的共同特征\n3. 找出成本异常的会话并分析原因\n4. 给出优化整体使用成本的建议".into(),
                    scope: TemplateScope::All,
                },
            ],
        }
    }
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
            if ensure_device_id(&mut parsed) {
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
        let json = r#"{"provider_roots":{},"ai":{},"ui":{"theme":"light","preview_chars":220,"auto_expand_threshold_tokens":0}}"#;
        let parsed: AppSettings = serde_json::from_str(json).unwrap();
        assert!(parsed.remotes.is_empty());
    }
}

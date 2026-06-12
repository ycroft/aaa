//! Local persistence for tickets the user has submitted from this machine.
//! Stored at `~/.config/aaa/tickets.json` (chmod 0600 on unix).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTicket {
    pub id: String,
    pub claim_token: String,
    pub title: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct LocalTickets {
    #[serde(default)]
    pub items: Vec<LocalTicket>,
}

fn path() -> Result<PathBuf> {
    let dir = dirs::config_dir().context("no config dir")?.join("aaa");
    std::fs::create_dir_all(&dir).context("create config dir")?;
    Ok(dir.join("tickets.json"))
}

pub fn load() -> Result<LocalTickets> {
    let p = path()?;
    if !p.exists() {
        return Ok(LocalTickets::default());
    }
    let s = std::fs::read_to_string(&p).context("read tickets.json")?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

pub fn save(t: &LocalTickets) -> Result<()> {
    let p = path()?;
    let s = serde_json::to_string_pretty(t)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).context("write tmp")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).context("rename tickets.json")?;
    Ok(())
}

pub fn append(ticket: LocalTicket) -> Result<()> {
    let mut t = load().unwrap_or_default();
    t.items.push(ticket);
    save(&t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_in_memory() {
        let mut t = LocalTickets::default();
        t.items.push(LocalTicket {
            id: "01H".into(),
            claim_token: "T".into(),
            title: "x".into(),
            category: "bug".into(),
            created_at: 1,
        });
        let s = serde_json::to_string(&t).unwrap();
        let p: LocalTickets = serde_json::from_str(&s).unwrap();
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].id, "01H");
    }
}

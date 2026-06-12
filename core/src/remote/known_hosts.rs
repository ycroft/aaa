//! `~/.config/aaa/known_hosts.json`: TOFU host-key cache.
//!
//! File lock prevents concurrent corruption; permissions 0600 on Unix.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use super::RemoteError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint_sha256: String,
}

pub struct KnownHosts {
    map: HashMap<String, Entry>,
    file: File,
}

impl KnownHosts {
    pub fn open() -> Result<Self, RemoteError> {
        let cfg = dirs::config_dir()
            .ok_or_else(|| RemoteError::Config("no config dir".into()))?;
        let dir = cfg.join("aaa");
        fs::create_dir_all(&dir)?;
        Self::open_at(dir.join("known_hosts.json"))
    }

    pub fn open_at(path: PathBuf) -> Result<Self, RemoteError> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)?;
        file.lock_exclusive().map_err(|e| RemoteError::Io(e.to_string()))?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)?;
        let map: HashMap<String, Entry> = if buf.trim().is_empty() {
            HashMap::new()
        } else {
            serde_json::from_str(&buf).unwrap_or_default()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(Self { map, file })
    }

    pub fn get(&self, host_id: &str) -> Option<&Entry> {
        self.map.get(host_id)
    }

    pub fn put_tofu(&mut self, host_id: &str, entry: Entry) -> Result<(), RemoteError> {
        self.map.insert(host_id.to_string(), entry);
        self.flush()
    }

    pub fn forget(&mut self, host_id: &str) -> Result<(), RemoteError> {
        self.map.remove(host_id);
        self.flush()
    }

    fn flush(&mut self) -> Result<(), RemoteError> {
        let json = serde_json::to_string_pretty(&self.map)
            .map_err(|e| RemoteError::Io(e.to_string()))?;
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(json.as_bytes())?;
        self.file.sync_all()?;
        Ok(())
    }
}

impl Drop for KnownHosts {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_entry(fp: &str) -> Entry {
        Entry {
            host: "h".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint_sha256: fp.into(),
        }
    }

    #[test]
    fn tofu_writes_and_reads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("kh.json");
        {
            let mut kh = KnownHosts::open_at(path.clone()).unwrap();
            kh.put_tofu("id-1", make_entry("AAA")).unwrap();
        }
        let kh = KnownHosts::open_at(path).unwrap();
        assert_eq!(kh.get("id-1").unwrap().fingerprint_sha256, "AAA");
    }

    #[test]
    fn forget_removes_entry() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("kh.json");
        let mut kh = KnownHosts::open_at(path).unwrap();
        kh.put_tofu("id-1", make_entry("AAA")).unwrap();
        kh.forget("id-1").unwrap();
        assert!(kh.get("id-1").is_none());
    }

    #[test]
    fn missing_file_starts_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("kh.json");
        let kh = KnownHosts::open_at(path).unwrap();
        assert!(kh.get("anything").is_none());
    }

    #[test]
    fn corrupted_file_recovers_to_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("kh.json");
        std::fs::write(&path, "this is not json").unwrap();
        let kh = KnownHosts::open_at(path).unwrap();
        assert!(kh.get("anything").is_none());
    }
}

//! russh client + russh-sftp session; TOFU host-key validation.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use log::{debug, info, warn};
use russh::client::{self, Handle, Handler};
use russh::keys::{key::PublicKey, load_secret_key};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;

use super::known_hosts::{Entry as KhEntry, KnownHosts};
use super::{DirEntry, FileMeta, RemoteAuth, RemoteError, RemoteFs, RemoteHost};

/// Stable fingerprint string: `SHA256:<base64>` — matches what users see from `ssh-keygen -lf`.
fn fingerprint_str(key: &PublicKey) -> String {
    format!("SHA256:{}", key.fingerprint())
}

#[derive(Default)]
struct HandshakeState {
    actual_fp: Option<(String, String)>, // (key_type, fingerprint)
    expected: Option<KhEntry>,
    mismatch: Option<(String, String)>, // (old, new)
}

struct AaaHandler {
    state: Arc<Mutex<HandshakeState>>,
}

#[async_trait]
impl Handler for AaaHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = fingerprint_str(server_public_key);
        let key_type = server_public_key.name().to_string();
        let mut s = self.state.lock().unwrap();
        s.actual_fp = Some((key_type, fp.clone()));
        if let Some(expected) = &s.expected {
            if expected.fingerprint_sha256 != fp {
                s.mismatch = Some((expected.fingerprint_sha256.clone(), fp));
                return Ok(false);
            }
        }
        Ok(true)
    }
}

pub struct RemoteSession {
    handle: Handle<AaaHandler>,
    sftp: SftpSession,
    home: Option<String>,
}

impl RemoteSession {
    pub async fn connect(
        remote: &RemoteHost,
        kh: &mut KnownHosts,
    ) -> Result<Self, RemoteError> {
        let state = Arc::new(Mutex::new(HandshakeState {
            expected: kh.get(&remote.id).cloned(),
            ..Default::default()
        }));
        let handler = AaaHandler { state: state.clone() };

        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..<_>::default()
        });
        let addr = format!("{}:{}", remote.host, remote.port);
        debug!("ssh connecting to {} as {}", addr, remote.user);
        let mut handle = match client::connect(config, addr.clone(), handler).await {
            Ok(h) => h,
            Err(e) => {
                if let Some((old, new)) = state.lock().unwrap().mismatch.clone() {
                    warn!(
                        "ssh host-key mismatch for {} (expected {}, got {})",
                        addr, old, new
                    );
                    return Err(RemoteError::HostKeyMismatch { old, new });
                }
                warn!("ssh connect failed {}: {}", addr, e);
                return Err(RemoteError::Connect(e.to_string()));
            }
        };

        let authed = match &remote.auth {
            RemoteAuth::Password { password } => handle
                .authenticate_password(&remote.user, password.expose())
                .await
                .map_err(|e| RemoteError::Auth(e.to_string()))?,
            RemoteAuth::PrivateKey { path, passphrase } => {
                let key = load_secret_key(path, passphrase.as_ref().map(|s| s.expose()))
                    .map_err(|e| RemoteError::Auth(e.to_string()))?;
                handle
                    .authenticate_publickey(&remote.user, Arc::new(key))
                    .await
                    .map_err(|e| RemoteError::Auth(e.to_string()))?
            }
        };
        if !authed {
            warn!("ssh auth failed for {}@{}", remote.user, addr);
            return Err(RemoteError::Auth("authentication failed".into()));
        }
        info!("ssh authenticated {}@{}", remote.user, addr);

        // TOFU: persist fingerprint on first successful auth.
        // Scope the MutexGuard so it does not cross the next `.await`.
        {
            let s = state.lock().unwrap();
            if s.expected.is_none() {
                if let Some((kt, fp)) = s.actual_fp.clone() {
                    info!("ssh TOFU: storing host key for {} (type={}, {})", remote.id, kt, fp);
                    drop(s);
                    kh.put_tofu(
                        &remote.id,
                        KhEntry {
                            host: remote.host.clone(),
                            port: remote.port,
                            key_type: kt,
                            fingerprint_sha256: fp,
                        },
                    )?;
                }
            }
        }

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| RemoteError::Connect(e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;

        Ok(Self { handle, sftp, home: None })
    }
}

#[async_trait]
impl RemoteFs for RemoteSession {
    async fn home_dir(&mut self) -> Result<String, RemoteError> {
        if let Some(h) = &self.home {
            return Ok(h.clone());
        }
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| RemoteError::Connect(e.to_string()))?;
        channel
            .exec(true, "echo $HOME")
            .await
            .map_err(|e| RemoteError::Connect(e.to_string()))?;
        let mut buf = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => buf.extend_from_slice(data),
                ChannelMsg::ExitStatus { .. } => break,
                _ => {}
            }
        }
        let home = String::from_utf8_lossy(&buf).trim().to_string();
        if home.is_empty() {
            return Err(RemoteError::Connect("empty $HOME from remote".into()));
        }
        self.home = Some(home.clone());
        Ok(home)
    }

    async fn metadata(&mut self, path: &str) -> Result<FileMeta, RemoteError> {
        let m = self
            .sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;
        Ok(FileMeta {
            size: m.size.unwrap_or(0),
            mtime: m.mtime.unwrap_or(0) as i64,
            is_dir: m.is_dir(),
        })
    }

    async fn read_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, RemoteError> {
        let entries = self
            .sftp
            .read_dir(path.to_string())
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;
        let mut out = Vec::new();
        for e in entries {
            let name = e.file_name();
            let m = e.metadata();
            out.push(DirEntry {
                name,
                meta: FileMeta {
                    size: m.size.unwrap_or(0),
                    mtime: m.mtime.unwrap_or(0) as i64,
                    is_dir: m.is_dir(),
                },
            });
        }
        Ok(out)
    }

    async fn download(&mut self, remote: &str, local: &Path) -> Result<u64, RemoteError> {
        use tokio::io::AsyncReadExt;
        let mut f = self
            .sftp
            .open(remote.to_string())
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .await
            .map_err(|e| RemoteError::Sftp(e.to_string()))?;
        std::fs::write(local, &buf)?;
        Ok(buf.len() as u64)
    }
}

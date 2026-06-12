//! Remote backend discovery: for each provider, try override first then candidates.

use crate::providers::SessionProvider;

use super::{RemoteError, RemoteFs, RemoteHost, RemoteProviderInfo};

pub async fn find_roots(
    fs: &mut dyn RemoteFs,
    home: &str,
    remote: &RemoteHost,
    providers: &[Box<dyn SessionProvider>],
) -> Result<Vec<RemoteProviderInfo>, RemoteError> {
    let mut out = Vec::with_capacity(providers.len());
    for p in providers {
        let pid = p.id().to_string();

        if let Some(path) = remote.provider_root_overrides.get(&pid) {
            let exists = fs.metadata(path).await.is_ok();
            out.push(RemoteProviderInfo {
                provider_id: pid,
                remote_root: Some(path.clone()),
                exists,
            });
            continue;
        }

        let mut found: Option<String> = None;
        for cand in p.remote_root_candidates() {
            let path = cand.replace("{home}", home);
            if fs.metadata(&path).await.is_ok() {
                found = Some(path);
                break;
            }
        }
        out.push(RemoteProviderInfo {
            provider_id: pid,
            remote_root: found.clone(),
            exists: found.is_some(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SessionDetail, SessionSummary};
    use crate::remote::{DirEntry, FileMeta, RemoteAuth, Secret};
    use async_trait::async_trait;
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};

    struct FakeFs {
        existing: HashSet<String>,
    }
    #[async_trait]
    impl RemoteFs for FakeFs {
        async fn home_dir(&mut self) -> Result<String, RemoteError> {
            Ok("/home/u".into())
        }
        async fn metadata(&mut self, path: &str) -> Result<FileMeta, RemoteError> {
            if self.existing.contains(path) {
                Ok(FileMeta { size: 0, mtime: 0, is_dir: true })
            } else {
                Err(RemoteError::Sftp("nope".into()))
            }
        }
        async fn read_dir(&mut self, _path: &str) -> Result<Vec<DirEntry>, RemoteError> {
            unreachable!()
        }
        async fn download(&mut self, _r: &str, _l: &Path) -> Result<u64, RemoteError> {
            unreachable!()
        }
    }

    struct TestProvider {
        id: &'static str,
        candidates: Vec<&'static str>,
    }
    impl SessionProvider for TestProvider {
        fn id(&self) -> &str { self.id }
        fn display_name(&self) -> &str { self.id }
        fn default_root(&self) -> Option<PathBuf> { None }
        fn remote_root_candidates(&self) -> Vec<&'static str> { self.candidates.clone() }
        fn list_sessions(&self, _: &PathBuf) -> anyhow::Result<Vec<SessionSummary>> { Ok(vec![]) }
        fn load_session(&self, _: &PathBuf) -> anyhow::Result<SessionDetail> {
            Err(anyhow::anyhow!("nope"))
        }
    }

    fn make_remote(overrides: &[(&str, &str)]) -> RemoteHost {
        let mut map = HashMap::new();
        for (k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        RemoteHost {
            id: "id-1".into(),
            label: "lbl".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: RemoteAuth::Password { password: Secret(String::new()) },
            provider_root_overrides: map,
        }
    }

    #[tokio::test]
    async fn picks_first_existing_candidate() {
        let mut fs = FakeFs {
            existing: ["/home/u/.b".to_string()].into_iter().collect(),
        };
        let providers: Vec<Box<dyn SessionProvider>> = vec![Box::new(TestProvider {
            id: "x",
            candidates: vec!["{home}/.a", "{home}/.b"],
        })];
        let r = make_remote(&[]);
        let out = find_roots(&mut fs, "/home/u", &r, &providers).await.unwrap();
        assert_eq!(out[0].remote_root.as_deref(), Some("/home/u/.b"));
        assert!(out[0].exists);
    }

    #[tokio::test]
    async fn override_beats_candidates() {
        let mut fs = FakeFs {
            existing: ["/custom/path".to_string(), "/home/u/.a".to_string()]
                .into_iter()
                .collect(),
        };
        let providers: Vec<Box<dyn SessionProvider>> = vec![Box::new(TestProvider {
            id: "x",
            candidates: vec!["{home}/.a"],
        })];
        let r = make_remote(&[("x", "/custom/path")]);
        let out = find_roots(&mut fs, "/home/u", &r, &providers).await.unwrap();
        assert_eq!(out[0].remote_root.as_deref(), Some("/custom/path"));
    }

    #[tokio::test]
    async fn missing_returns_exists_false() {
        let mut fs = FakeFs { existing: HashSet::new() };
        let providers: Vec<Box<dyn SessionProvider>> = vec![Box::new(TestProvider {
            id: "x",
            candidates: vec!["{home}/.a"],
        })];
        let r = make_remote(&[]);
        let out = find_roots(&mut fs, "/home/u", &r, &providers).await.unwrap();
        assert!(!out[0].exists);
        assert!(out[0].remote_root.is_none());
    }
}

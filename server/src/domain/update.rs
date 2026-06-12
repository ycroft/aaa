use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct VersionedArtifacts {
    pub version: semver::Version,
    pub linux: Option<PlatformAsset>,
    pub windows: Option<PlatformAsset>,
}

#[derive(Debug, Clone)]
pub struct PlatformAsset {
    pub artifact: PathBuf,
    pub signature: String,
}

/// Walk artifacts_dir/<version>/ and pick the newest semver directory that has
/// at least one (artifact + matching .sig) pair for some platform.
pub fn pick_latest(artifacts_dir: &Path) -> std::io::Result<Option<VersionedArtifacts>> {
    if !artifacts_dir.exists() {
        return Ok(None);
    }
    let mut best: Option<VersionedArtifacts> = None;
    for entry in std::fs::read_dir(artifacts_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let s = name.to_string_lossy();
        let Ok(ver) = semver::Version::parse(&s) else {
            continue;
        };
        let dir = entry.path();
        let linux = read_pair(&dir, &["AppImage"]).ok();
        let windows = read_pair(&dir, &["msi", "exe"]).ok();
        if linux.is_none() && windows.is_none() {
            continue;
        }
        let cand = VersionedArtifacts {
            version: ver.clone(),
            linux,
            windows,
        };
        match &best {
            None => best = Some(cand),
            Some(b) if ver > b.version => best = Some(cand),
            _ => {}
        }
    }
    Ok(best)
}

fn read_pair(dir: &Path, exts: &[&str]) -> std::io::Result<PlatformAsset> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !exts.contains(&ext) {
            continue;
        }
        let sig_path = p.with_extension(format!("{}.sig", ext));
        if !sig_path.exists() {
            continue;
        }
        let signature = std::fs::read_to_string(&sig_path)?.trim().to_string();
        return Ok(PlatformAsset {
            artifact: p,
            signature,
        });
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no matching artifact",
    ))
}

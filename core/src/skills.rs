//! On-disk SKILL.md fingerprint registry.
//!
//! Both opencode and Claude Code (when invoked via `/skill-name` slash) inject
//! the entire SKILL.md body into the user-text part of the next message. This
//! module builds a fingerprint table from `<root>/<id>/SKILL.md` files and
//! exposes a `match_text` that returns the matching skill when a user-text's
//! head equals a known fingerprint.
//!
//! Fingerprint = first 128 UTF-8 bytes of the body after frontmatter strip
//! and `trim()`, truncated on a codepoint boundary.

use std::fs;
use std::path::PathBuf;

use log::{debug, warn};

const FINGERPRINT_BYTES: usize = 128;

/// One known skill, loaded off disk.
#[derive(Debug, Clone)]
pub struct Skill {
    /// Directory name — used as the stable id (e.g. `customize-opencode`).
    pub id: String,
    /// Display name — frontmatter `name:` value if present, else `id`.
    pub display_name: String,
    /// The first 128 UTF-8 bytes of the body, post-frontmatter, post-trim.
    /// Stored as a `String` because we always slice on codepoint boundaries.
    pub fingerprint: String,
    /// Source path of the SKILL.md, kept for diagnostics.
    pub source_path: PathBuf,
}

/// In-memory fingerprint table built from a list of root directories.
/// Cheap to throw away and rebuild — typical user has < 50 skills.
#[derive(Debug, Clone, Default)]
pub struct SkillRegistry {
    skills: Vec<Skill>,
}

impl SkillRegistry {
    /// Walk each root for `<root>/<id>/SKILL.md` and parse what's there.
    /// Roots that don't exist are silently skipped. Duplicate fingerprints
    /// (same skill appearing under multiple roots) keep only the first.
    pub fn build(roots: &[PathBuf]) -> Self {
        let mut out: Vec<Skill> = Vec::new();
        for root in roots {
            if !root.exists() {
                continue;
            }
            let entries = match fs::read_dir(root) {
                Ok(e) => e,
                Err(e) => {
                    warn!("skill registry: read_dir {:?} failed: {}", root, e);
                    continue;
                }
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let skill_md = dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                let id = match dir.file_name().and_then(|s| s.to_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let content = match fs::read_to_string(&skill_md) {
                    Ok(c) => c,
                    Err(e) => {
                        warn!("skill registry: read {:?} failed: {}", skill_md, e);
                        continue;
                    }
                };
                let Some((display_name, fingerprint)) = parse_skill_md(&content, &id) else {
                    continue;
                };
                if fingerprint.is_empty() {
                    continue;
                }
                if out.iter().any(|s| s.fingerprint == fingerprint) {
                    continue;
                }
                out.push(Skill {
                    id,
                    display_name,
                    fingerprint,
                    source_path: skill_md,
                });
            }
        }
        debug!("skill registry built: {} unique skills", out.len());
        SkillRegistry { skills: out }
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn skills(&self) -> &[Skill] {
        &self.skills
    }

    /// Match text against every fingerprint. The fingerprint is searched as a
    /// substring within the first 8 KB of `text` (UTF-8-safe truncation), not
    /// only at position 0 — Claude Code prepends a `Base directory for this
    /// skill: <path>` line before the SKILL.md body when it inlines a
    /// `/skill-name` slash invocation, so a strict `starts_with` would miss
    /// it. opencode-style injection still works because the fingerprint is
    /// at offset 0 there.
    ///
    /// 8 KB is plenty for any conceivable preamble while bounding the scan
    /// cost on huge user messages.
    pub fn match_text(&self, text: &str) -> Option<&Skill> {
        const SCAN_BYTES: usize = 8 * 1024;
        let head = truncate_utf8_bytes(text, SCAN_BYTES);
        self.skills.iter().find(|s| head.contains(&s.fingerprint))
    }

    /// Build a registry from in-memory tuples — for use in tests across the
    /// crate without touching the filesystem. Each tuple is
    /// `(id, display_name, fingerprint)`.
    #[cfg(test)]
    pub fn for_testing(specs: Vec<(&str, &str, &str)>) -> Self {
        SkillRegistry {
            skills: specs
                .into_iter()
                .map(|(id, name, fp)| Skill {
                    id: id.to_string(),
                    display_name: name.to_string(),
                    fingerprint: fp.to_string(),
                    source_path: PathBuf::from(format!("/test/{}/SKILL.md", id)),
                })
                .collect(),
        }
    }
}

/// Parse a SKILL.md file body into `(display_name, fingerprint)`.
///
/// Returns `None` only when the resulting fingerprint would be empty —
/// missing frontmatter is fine, missing `name:` is fine (we fall back to id).
pub fn parse_skill_md(content: &str, fallback_id: &str) -> Option<(String, String)> {
    let (frontmatter, body) = split_frontmatter(content);
    let name = frontmatter
        .and_then(extract_name)
        .unwrap_or_else(|| fallback_id.to_string());
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    let fingerprint = truncate_utf8_bytes(trimmed, FINGERPRINT_BYTES).to_string();
    Some((name, fingerprint))
}

/// Split content at the optional leading `---\n…\n---\n` frontmatter fence.
/// Returns `(Some(frontmatter), body)` when both fences are present and on
/// their own lines; otherwise `(None, full_content)`.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    // First non-empty line must be exactly "---".
    let trimmed = content.trim_start_matches(|c: char| c == '\u{FEFF}'); // strip BOM
    let first_line_end = trimmed.find('\n').unwrap_or(trimmed.len());
    let first_line = trimmed[..first_line_end].trim_end_matches('\r');
    if first_line != "---" {
        return (None, content);
    }
    let after_first = &trimmed[first_line_end..];
    // skip the '\n' itself
    let body_start = after_first.strip_prefix('\n').unwrap_or(after_first);

    // Look for a closing "---" on its own line.
    let mut idx = 0usize;
    while idx < body_start.len() {
        let nl = body_start[idx..]
            .find('\n')
            .map(|i| idx + i)
            .unwrap_or(body_start.len());
        let line = body_start[idx..nl].trim_end_matches('\r');
        if line == "---" {
            let frontmatter = &body_start[..idx];
            let after_close = body_start.get(nl + 1..).unwrap_or("");
            return (Some(frontmatter), after_close);
        }
        if nl == body_start.len() {
            break;
        }
        idx = nl + 1;
    }
    // Unterminated frontmatter — treat whole content as body.
    (None, content)
}

/// Pull the `name:` field out of YAML frontmatter without depending on a yaml
/// crate. Accepts unquoted, single-quoted, and double-quoted values. Returns
/// the trimmed value or `None` if the field is absent or empty.
fn extract_name(frontmatter: &str) -> Option<String> {
    for raw_line in frontmatter.lines() {
        let line = raw_line.trim_end_matches('\r');
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("name:") else {
            continue;
        };
        let value = rest.trim();
        // strip optional trailing comment.
        let value = match value.find(" #") {
            Some(i) => value[..i].trim_end(),
            None => value,
        };
        let unquoted = strip_quotes(value);
        if unquoted.is_empty() {
            return None;
        }
        return Some(unquoted.to_string());
    }
    None
}

fn strip_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// Truncate `s` to at most `max_bytes` UTF-8 bytes, on a codepoint boundary.
/// The returned slice is always valid UTF-8.
pub fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn frontmatter_present_extracts_name_and_body() {
        let md = "---\nname: Customize Opencode\ndescription: foo\n---\n\n# Heading\n\nBody text here that is long enough.";
        let (name, fp) = parse_skill_md(md, "customize-opencode").unwrap();
        assert_eq!(name, "Customize Opencode");
        assert!(fp.starts_with("# Heading"));
        assert!(fp.len() <= FINGERPRINT_BYTES);
    }

    #[test]
    fn frontmatter_absent_uses_full_body_and_fallback_id() {
        let md = "# Heading\n\nNo frontmatter at all.";
        let (name, fp) = parse_skill_md(md, "fallback-id").unwrap();
        assert_eq!(name, "fallback-id");
        assert!(fp.starts_with("# Heading"));
    }

    #[test]
    fn unterminated_frontmatter_treated_as_body() {
        let md = "---\nname: foo\n# never closed";
        let (name, fp) = parse_skill_md(md, "id").unwrap();
        // Unterminated → no frontmatter parsed → name falls back to id.
        assert_eq!(name, "id");
        assert!(fp.starts_with("---"));
    }

    #[test]
    fn name_quoted_strips_quotes() {
        let md = "---\nname: \"My Skill\"\n---\nbody";
        let (name, _) = parse_skill_md(md, "id").unwrap();
        assert_eq!(name, "My Skill");
        let md2 = "---\nname: 'Other'\n---\nbody";
        let (name2, _) = parse_skill_md(md2, "id").unwrap();
        assert_eq!(name2, "Other");
    }

    #[test]
    fn name_missing_falls_back_to_id() {
        let md = "---\ndescription: just a desc\n---\nbody";
        let (name, _) = parse_skill_md(md, "the-id").unwrap();
        assert_eq!(name, "the-id");
    }

    #[test]
    fn empty_body_returns_none() {
        assert!(parse_skill_md("---\nname: x\n---\n   \n", "id").is_none());
        assert!(parse_skill_md("", "id").is_none());
    }

    #[test]
    fn truncate_at_utf8_boundary_for_chinese() {
        // Each Chinese char is 3 bytes in UTF-8. 128/3 = 42.66, so we should
        // get exactly 42 chars = 126 bytes when truncating to 128 bytes.
        let s = "中".repeat(50); // 150 bytes
        let truncated = truncate_utf8_bytes(&s, 128);
        assert_eq!(truncated.len(), 126);
        assert_eq!(truncated.chars().count(), 42);
    }

    #[test]
    fn truncate_no_op_when_short() {
        let s = "short";
        assert_eq!(truncate_utf8_bytes(s, 128), "short");
    }

    #[test]
    fn match_text_with_leading_whitespace() {
        let reg = SkillRegistry {
            skills: vec![Skill {
                id: "x".into(),
                display_name: "X".into(),
                fingerprint: "# Hello world".into(),
                source_path: PathBuf::from("/tmp/x/SKILL.md"),
            }],
        };
        assert!(reg.match_text("# Hello world more").is_some());
        assert!(reg.match_text("\n\n  # Hello world tail").is_some());
        assert!(reg.match_text("# Goodbye").is_none());
    }

    #[test]
    fn match_text_after_claude_code_preamble() {
        // Claude Code prepends a "Base directory for this skill: <path>" line
        // before the SKILL.md body when expanding a /skill-name slash.
        let reg = SkillRegistry {
            skills: vec![Skill {
                id: "claude-test-skill".into(),
                display_name: "claude-test-skill".into(),
                fingerprint: "# test skill\n\nbody…".into(),
                source_path: PathBuf::from("/tmp/SKILL.md"),
            }],
        };
        let user_text = "Base directory for this skill: /home/u/.claude/skills/claude-test-skill\n\n# test skill\n\nbody… extra after";
        assert!(reg.match_text(user_text).is_some());
    }

    #[test]
    fn registry_build_dedups_by_fingerprint() {
        let tmp = tempdir_for_test();
        let r1 = tmp.join("root1");
        let r2 = tmp.join("root2");
        write_skill(&r1, "foo", "---\nname: Foo\n---\nIdentical body content here, long enough.");
        write_skill(&r2, "foo", "---\nname: Foo Two\n---\nIdentical body content here, long enough.");
        let reg = SkillRegistry::build(&[r1, r2]);
        assert_eq!(reg.len(), 1);
        // First-wins: name from root1
        assert_eq!(reg.skills()[0].display_name, "Foo");
    }

    #[test]
    fn registry_build_skips_missing_roots_silently() {
        let tmp = tempdir_for_test();
        let real = tmp.join("real");
        let missing = tmp.join("does-not-exist");
        write_skill(&real, "bar", "body content for bar skill, long enough to fingerprint.");
        let reg = SkillRegistry::build(&[missing, real]);
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.skills()[0].id, "bar");
    }

    fn tempdir_for_test() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aaa-skills-test-{}", std::process::id()));
        p.push(format!("{}", rand_suffix()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn rand_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }

    fn write_skill(root: &Path, id: &str, content: &str) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), content).unwrap();
    }
}

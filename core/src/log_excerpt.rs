//! Build a redacted, size-capped excerpt from the in-memory log buffer for
//! feedback submission.
//!
//! Redacts: emails, /home/<user>, C:\Users\<user>, IPv4/IPv6, long
//! base64/hex tokens. Truncates to 64 KB tail.

use crate::log_buffer::LogBuffer;
use once_cell::sync::Lazy;
use regex::Regex;

static EMAIL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap());
static HOMEPATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"/home/[^/\s]+").unwrap());
static WINPATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"[A-Z]:\\Users\\[^\\]+").unwrap());
static IPV4: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{1,3}(?:\.\d{1,3}){3}\b").unwrap());
static IPV6: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b[0-9a-fA-F:]{2,}:[0-9a-fA-F:]+\b").unwrap());
static LONGTOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Za-z0-9+/=_-]{32,}\b").unwrap());

const MAX_BYTES: usize = 64 * 1024;

pub fn redact(text: &str) -> String {
    let s = EMAIL.replace_all(text, "<email>");
    let s = HOMEPATH.replace_all(&s, "/home/<redacted>");
    let s = WINPATH.replace_all(&s, |c: &regex::Captures| {
        let mut parts = c[0].splitn(3, '\\');
        let drive = parts.next().unwrap_or("C:");
        let users = parts.next().unwrap_or("Users");
        format!("{}\\{}\\<redacted>", drive, users)
    });
    let s = IPV4.replace_all(&s, "<ip>");
    let s = IPV6.replace_all(&s, "<ip>");
    LONGTOKEN.replace_all(&s, "<token>").into_owned()
}

pub fn collect(buf: &LogBuffer) -> String {
    let raw = buf.snapshot().join("\n");
    let redacted = redact(&raw);
    if redacted.len() > MAX_BYTES {
        let cut = redacted.len().saturating_sub(MAX_BYTES);
        // align to char boundary so we don't slice in the middle of a UTF-8 codepoint
        let mut start = cut;
        while start < redacted.len() && !redacted.is_char_boundary(start) {
            start += 1;
        }
        let mut tail = redacted[start..].to_string();
        tail.push_str("\n... (truncated)");
        return tail;
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_email() {
        assert_eq!(redact("contact alice@example.com now"), "contact <email> now");
    }

    #[test]
    fn redacts_home_path() {
        assert!(redact("error at /home/alice/code/x.rs:1").starts_with("error at /home/<redacted>"));
    }

    #[test]
    fn redacts_long_tokens() {
        let s = "tok=abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert!(redact(s).contains("<token>"));
    }

    #[test]
    fn redacts_ipv4() {
        assert_eq!(redact("from 10.0.0.1 to"), "from <ip> to");
    }

    #[test]
    fn collect_truncates() {
        let buf = LogBuffer::new(10);
        // Use a chunk that contains spaces so the long-token regex does not collapse
        // it into a single <token> placeholder.
        let chunk = (0..2_000).map(|i| format!("line{} ", i)).collect::<String>();
        for _ in 0..5 {
            buf.push(chunk.clone());
        }
        let s = collect(&buf);
        assert!(s.ends_with("(truncated)"), "got {} bytes", s.len());
        assert!(s.len() <= MAX_BYTES + 32);
    }
}

//! Wire schema shared by `aaa` desktop client and `aaa-hub` server.
//!
//! # Forward-compatibility rules — three iron laws
//!
//! 1. **New fields MUST be `Option<T>` with `#[serde(default)]`** so that an
//!    older peer that doesn't send the field still parses, and a newer peer
//!    that sends it doesn't break older readers.
//! 2. **Enums MUST carry an `#[serde(other)] Unknown` fallback variant** so
//!    that a value introduced after this code was compiled deserializes to
//!    `Unknown` instead of an error.
//! 3. **Do NOT add `#[serde(deny_unknown_fields)]`** anywhere — readers must
//!    silently ignore fields they don't know about.
//!
//! Each top-level message carries a `schema_version: u32` (defaulted to
//! [`SCHEMA_VERSION`] when missing). Bump [`SCHEMA_VERSION`] only on
//! breaking changes (deletions, renames). Additive changes do NOT bump.
//!
//! Rust types here are the source of truth. The TypeScript mirror in
//! `src/types.ts` is hand-maintained — PR review must keep them aligned.

pub mod feedback;
pub mod health;
pub mod version;

pub use version::SCHEMA_VERSION;

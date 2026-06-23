-- Web authentication session cache.
-- TODO(real-sso): When real SSO is integrated, validate the SSO cookie against
-- the company identity service here. Currently unused — auth is derived
-- directly from the cookie value on each request (see src/auth_web.rs).
CREATE TABLE IF NOT EXISTS web_auth_sessions (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,  -- unix ms
    expires_at   INTEGER NOT NULL   -- unix ms
);

-- Sessions analyzed and stored on the server for web-based log viewing.
-- detail_json holds the full serialized SessionDetail (core/src/model.rs).
--
-- Import pipeline (NOT YET IMPLEMENTED — see routes/web_api.rs):
--   1. User selects employee ID + date range in the web UI.
--   2. Frontend POSTs to /api/sessions/import.
--   3. Backend queries the internal data-source DB for matching sessions.
--   4. Transforms rows into SessionDetail, serializes to JSON, writes here.
--   5. Frontend can then load the session via GET /api/sessions/:id.
CREATE TABLE IF NOT EXISTS web_sessions (
    id            TEXT PRIMARY KEY,         -- ULID
    user_id       TEXT NOT NULL,
    imported_at   INTEGER NOT NULL,         -- unix ms
    provider_id   TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    -- 'import' = from internal data source (needs internal integration)
    -- 'manual'  = uploaded directly as JSON (for testing/dev)
    import_source TEXT NOT NULL DEFAULT 'import',
    summary_json  TEXT NOT NULL,            -- serialized SessionSummary
    detail_json   TEXT NOT NULL             -- serialized SessionDetail
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user
    ON web_sessions (user_id, imported_at DESC);

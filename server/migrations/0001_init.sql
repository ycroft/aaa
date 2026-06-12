CREATE TABLE feedback (
    id              TEXT PRIMARY KEY,
    claim_token     TEXT NOT NULL,
    category        TEXT NOT NULL,
    severity        TEXT,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    contact_email   TEXT,
    app_version     TEXT NOT NULL,
    os_info         TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    log_excerpt     TEXT,
    status          TEXT NOT NULL DEFAULT 'new',
    admin_note      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_feedback_status_created ON feedback(status, created_at DESC);
CREATE INDEX idx_feedback_device_id      ON feedback(device_id);

CREATE TABLE feedback_attachment (
    id           TEXT PRIMARY KEY,
    feedback_id  TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachment_feedback ON feedback_attachment(feedback_id);

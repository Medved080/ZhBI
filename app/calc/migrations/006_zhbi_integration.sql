ALTER TABLE projects ADD COLUMN zhbi_project_id INTEGER;
ALTER TABLE projects ADD COLUMN zhbi_project_name TEXT;
CREATE TABLE sync_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
);
CREATE TABLE sync_state (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    local_version INTEGER,
    synced_at TEXT NOT NULL,
    PRIMARY KEY(entity_kind, entity_id)
);
CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK(direction IN ('send','receive')),
    target TEXT,
    actor_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    summary_json TEXT NOT NULL
);

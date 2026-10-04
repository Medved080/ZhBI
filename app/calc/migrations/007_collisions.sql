CREATE TABLE collision_state (
    model_id TEXT NOT NULL,
    collision_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','designer','accepted','resolved')),
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(model_id, collision_key)
);
CREATE TABLE collision_notes (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    collision_key TEXT NOT NULL,
    author_id TEXT,
    author_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX collision_notes_key ON collision_notes(model_id, collision_key, created_at);

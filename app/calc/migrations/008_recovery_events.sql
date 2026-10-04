CREATE TABLE recovery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT
);
CREATE INDEX recovery_events_job ON recovery_events(job_id, id);
CREATE TABLE recovery_live (
    job_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

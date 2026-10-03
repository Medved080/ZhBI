CREATE TABLE model_discrepancies (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
    content_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(model_id, issue_key)
);
CREATE INDEX model_discrepancies_model ON model_discrepancies(model_id,status);
CREATE TABLE discrepancy_versions (
    id INTEGER PRIMARY KEY,
    discrepancy_id TEXT NOT NULL REFERENCES model_discrepancies(id),
    version INTEGER NOT NULL,
    detail_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(discrepancy_id,version)
);

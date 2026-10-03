CREATE TABLE recovery_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE recovery_batches (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','paused','cancelled')),
    config_json TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE recovery_jobs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES recovery_batches(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    model_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','review','failed','cancelled','published')),
    stage TEXT NOT NULL DEFAULT 'prepare',
    input_json TEXT,
    draft_json TEXT,
    candidate_json TEXT,
    qa_json TEXT,
    candidate_sha TEXT,
    error TEXT,
    lease_token TEXT,
    lease_until REAL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(batch_id,product_id)
);
CREATE INDEX recovery_jobs_queue ON recovery_jobs(state,created_at);
CREATE UNIQUE INDEX recovery_jobs_active_product ON recovery_jobs(product_id)
    WHERE state IN ('queued','running');
CREATE TABLE recovery_steps (
    job_id TEXT NOT NULL REFERENCES recovery_jobs(id),
    step_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(job_id,step_key)
);
CREATE TABLE recovery_revisions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES recovery_jobs(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    base_model_id TEXT NOT NULL,
    artifact_json TEXT NOT NULL,
    artifact_sha TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE recovery_publications (
    product_id TEXT PRIMARY KEY REFERENCES products(id),
    revision_id TEXT NOT NULL REFERENCES recovery_revisions(id)
);

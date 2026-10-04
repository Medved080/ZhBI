CREATE TABLE price_list (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    parameters_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    actor_id TEXT
);
ALTER TABLE products ADD COLUMN manual_fields TEXT;

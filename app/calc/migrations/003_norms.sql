CREATE TABLE production_norms (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    parameters_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    actor_id TEXT
);
CREATE TABLE product_resource_baselines (
    product_id TEXT NOT NULL REFERENCES products(id),
    code TEXT NOT NULL,
    quantity TEXT NOT NULL,
    rate TEXT NOT NULL,
    PRIMARY KEY(product_id, code)
);
ALTER TABLE products ADD COLUMN norms_version INTEGER;
ALTER TABLE products ADD COLUMN norms_labour_rate TEXT;

CREATE TABLE product_verifications (
    product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    note TEXT
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE calculation_profiles (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    name TEXT NOT NULL,
    parameters_json TEXT NOT NULL
);
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    profile_id TEXT NOT NULL REFERENCES calculation_profiles(id),
    name TEXT NOT NULL,
    concrete_class TEXT NOT NULL,
    volume TEXT NOT NULL,
    steel_weight TEXT NOT NULL,
    labour_hours TEXT NOT NULL,
    concrete_rate TEXT NOT NULL,
    other_materials TEXT NOT NULL,
    geometry_json TEXT,
    volume_from_geometry INTEGER NOT NULL DEFAULT 0 CHECK(volume_from_geometry IN (0,1)),
    source TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    legacy_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX products_project ON products(project_id, created_at, id);
CREATE TABLE extra_lines (
    product_id TEXT NOT NULL REFERENCES products(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    quantity TEXT NOT NULL,
    rate TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY(product_id, code)
);
CREATE TABLE line_overrides (
    product_id TEXT NOT NULL REFERENCES products(id),
    line_code TEXT NOT NULL,
    quantity TEXT,
    rate TEXT,
    amount TEXT,
    PRIMARY KEY(product_id, line_code),
    CHECK(quantity IS NOT NULL OR rate IS NOT NULL OR amount IS NOT NULL)
);
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX sessions_expiration ON sessions(expires_at);
CREATE TABLE calculation_versions (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    product_version INTEGER NOT NULL,
    profile_id TEXT NOT NULL REFERENCES calculation_profiles(id),
    profile_version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    actor_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(product_id, product_version)
);
CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    original_name TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL CHECK(size >= 0),
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    migration_key TEXT,
    actor_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(product_id, migration_key)
);
CREATE INDEX files_product ON project_files(product_id, created_at, id);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_id TEXT,
    detail_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE mutations (
    request_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE browser_imports (
    browser_id TEXT PRIMARY KEY,
    mapping_json TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE application_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE login_attempts (id INTEGER PRIMARY KEY, login_key TEXT NOT NULL, ip_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX login_attempts_time ON login_attempts(created_at);

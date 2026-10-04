import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 7
PROFILE_ID = "msu-1-v1"
PROJECT_ID = "84b8c4ae-7400-4e80-8d51-cd21d5d6b252"
SEED_IDS = ["ee285265-9a26-41bc-b402-399c183938fa", "f79f3f74-68be-45da-96c7-88c17bfa6058"]
PROFILE = {
    "labourRate": "795.3079178885630498533724340175953079179",
    "socialPercent": "21", "energyPercent": "11", "overheadPercent": "32.1",
    "adminPercent": "21.1", "commercialPercent": "2.1", "profitPercent": "5",
    "deliveryPercent": "9.5", "vatPercent": "22", "defaultConcreteRate": "7054.540983606557377049180327868852459016",
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def connect(path):
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


@contextmanager
def transaction(path):
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize(settings):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "uploads").mkdir(exist_ok=True)
    conn = connect(settings.database_path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)")
        for migration in sorted((Path(__file__).parent / "migrations").glob("*.sql")):
            version = int(migration.name.split("_")[0])
            content = migration.read_text()
            checksum = hashlib.sha256(content.encode()).hexdigest()
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT checksum FROM schema_migrations WHERE version=?", (version,)).fetchone()
            if existing:
                if existing[0] != checksum:
                    raise RuntimeError(f"Migration {version} checksum changed; create a new migration instead")
            else:
                # Split only complete SQL statements; do not use executescript's implicit commit.
                statement = ""
                for line in content.splitlines(True):
                    statement += line
                    if sqlite3.complete_statement(statement):
                        conn.execute(statement)
                        statement = ""
                if statement.strip():
                    raise RuntimeError("Incomplete migration statement")
                conn.execute("INSERT INTO schema_migrations VALUES(?,?,?)", (version, checksum, now()))
            conn.commit()
        found = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        if found != SCHEMA_VERSION:
            raise RuntimeError("Database schema is newer than this application; do not downgrade it")
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    with transaction(settings.database_path) as conn:
        from uuid import uuid4
        conn.execute("INSERT OR IGNORE INTO application_meta VALUES('installation_id',?)", (str(uuid4()),))
        conn.execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,?)", (PROJECT_ID, "Промышленный корпус", now()))
        conn.execute("INSERT OR IGNORE INTO calculation_profiles VALUES(?,?,?,?)", (PROFILE_ID, 1, "МСУ-1: исходная калькуляция", dumps(PROFILE)))
        from .norms import get_norms
        try:
            get_norms(conn)
        except (FileNotFoundError, KeyError):
            pass  # источники ещё не поставлены: нормы заведёт первый запуск после отправки пакета
        from .discrepancies import sync_catalog_issues
        sync_catalog_issues(conn)
        if not conn.execute("SELECT 1 FROM products LIMIT 1").fetchone():
            from .repository import save_product
            from .schemas import ProductSave
            for index, (name, volume, weight, hours, material) in enumerate([
                ("Колонна 1КС1", "5.7", "2.804", "20.645856", "224645.85232026232"),
                ("Колонна 2КС3", "4.59", ".998", "19.432224", "98438.57697600001"),
            ]):
                body = ProductSave.model_validate({"product": {"id": SEED_IDS[index], "name": name, "volume": volume, "weight": weight, "hours": hours, "material": material, "concreteRate": PROFILE["defaultConcreteRate"], "source": "excel"}, "expectedVersion": 0})
                save_product(conn, body, "system", legacy_key=f"product-{index}")


def audit(conn, actor, action, entity, details=None):
    conn.execute("INSERT INTO audit_log(actor_id,action,entity_id,detail_json,created_at) VALUES(?,?,?,?,?)", (actor, action, entity, dumps(details or {}), now()))

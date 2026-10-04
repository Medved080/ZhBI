"""Обмен данными калькулятора между серверами (локальный/тест → тест → бой).

Состав пакета: исходники и каталоги (`assets/`), вложения изделий (blobs) и
данные расчётов (профиль, нормы, изделия с версиями). Передаёт пакет тот
экземпляр, у которого настроены цели (sync_client.py); принимает любой — по
токену роли «Калькулятор» (sync_api.py).

ПРАВИЛО ПОВТОРНОЙ ПЕРЕДАЧИ (решение пользователя 2026-10-04): приоритет у
расчётов на принимающей стороне, чтобы не затереть работу людей. Конкретно:

* изделие, нормы и профиль, которых на сервере нет, создаются;
* существующие обновляются, ТОЛЬКО если на сервере их с прошлой передачи никто
  не менял (версия на сервере равна записанной в `sync_state`; для изделий,
  присланных до появления учёта, — единственная версия, созданная системой);
* иначе приходящие данные пропускаются и попадают в отчёт как `serverPriority`;
* файлы исходников обновляются по контрольной сумме; вложения только
  добавляются, ничего не удаляется;
* ничего не удаляется на принимающей стороне вообще.
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from uuid import uuid4

from .database import PROJECT_ID, SCHEMA_VERSION, now

FORMAT = 1
CHUNK = 8 * 1024 * 1024
# Что не передаётся: рабочие данные разбора чертежей на конкретной машине
# (журнал, редакции, блокировки) и служебные файлы.
SKIP_TOP = {"recovery", "recovery.seed", "backups"}
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){0,2}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
PRODUCT_COLUMNS_SKIP_IN_HASH = {"created_at", "updated_at", "version", "project_id"}


class SyncError(Exception):
    def __init__(self, message, status=422, extra=None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha_of(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ------------------------------------------------------------------ исходники
def asset_manifest(assets_dir):
    """Файлы каталога исходников: [{path,size,sha256}], относительные пути с «/»."""
    root = Path(assets_dir)
    result = []
    if not root.is_dir():
        return result
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        parts = relative.parts
        if parts[0] in SKIP_TOP or any(p.startswith(".") for p in parts) or path.suffix in {".tmp", ".lock", ".part"}:
            continue
        name = "/".join(parts)
        if not ASSET_RE.match(name):
            continue
        result.append({"path": name, "size": path.stat().st_size, "sha256": file_sha256(path)})
    return result


def valid_asset_path(name):
    return bool(ASSET_RE.match(name)) and name.split("/")[0] not in SKIP_TOP and ".." not in name.split("/")


# ------------------------------------------------------------------ данные
PRODUCT_CHILDREN = [
    ("extra_lines", "SELECT * FROM extra_lines WHERE product_id=? ORDER BY sort_order, code"),
    ("line_overrides", "SELECT * FROM line_overrides WHERE product_id=? ORDER BY line_code"),
    ("baselines", "SELECT * FROM product_resource_baselines WHERE product_id=? ORDER BY code"),
]


def product_bundle(conn, product_id, with_versions=True):
    row = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    if row is None:
        return None
    bundle = {"row": dict(row)}
    for key, query in PRODUCT_CHILDREN:
        bundle[key] = [dict(r) for r in conn.execute(query, (product_id,))]
    content = {k: v for k, v in bundle["row"].items() if k not in PRODUCT_COLUMNS_SKIP_IN_HASH}
    bundle["contentHash"] = sha_of({"row": content, **{k: bundle[k] for k, _ in PRODUCT_CHILDREN}})
    files = [{k: r[k] for k in ("id", "original_name", "size", "sha256", "mime_type", "migration_key", "created_at")}
             for r in conn.execute("SELECT * FROM project_files WHERE product_id=? ORDER BY created_at,id", (product_id,))]
    bundle["files"] = files
    if with_versions:
        bundle["versions"] = [dict(r) for r in conn.execute(
            "SELECT * FROM calculation_versions WHERE product_id=? ORDER BY product_version", (product_id,))]
    return bundle


def collect_package(conn, assets_dir, uploads_dir):
    products = [product_bundle(conn, r["id"]) for r in conn.execute("SELECT id FROM products ORDER BY created_at, id")]
    norms = conn.execute("SELECT * FROM production_norms").fetchall()
    profile = conn.execute("SELECT * FROM calculation_profiles").fetchall()
    blobs = {}
    for product in products:
        for f in product["files"]:
            blobs.setdefault(f["sha256"], f["size"])
    return {
        "format": FORMAT, "schema": SCHEMA_VERSION, "projectKey": PROJECT_ID, "createdAt": now(),
        "profiles": [dict(r) for r in profile],
        "norms": [dict(r) for r in norms],
        "products": products,
        "collisionNotes": [dict(r) for r in conn.execute("SELECT * FROM collision_notes ORDER BY created_at,id")],
        "collisionState": [dict(r) for r in conn.execute("SELECT * FROM collision_state")],
        "assets": asset_manifest(assets_dir),
        "blobs": [{"sha256": k, "size": v} for k, v in sorted(blobs.items())],
    }


def blob_path_for_row(uploads_dir, conn, sha):
    row = conn.execute("SELECT storage_name FROM project_files WHERE sha256=? LIMIT 1", (sha,)).fetchone()
    return Path(uploads_dir) / row["storage_name"] if row else None


# ------------------------------------------------------------------ приём
def _state(conn, kind, entity):
    return conn.execute("SELECT * FROM sync_state WHERE entity_kind=? AND entity_id=?", (kind, entity)).fetchone()


def _remember(conn, kind, entity, content_hash, version):
    conn.execute("INSERT INTO sync_state VALUES(?,?,?,?,?) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET "
                 "content_hash=excluded.content_hash,local_version=excluded.local_version,synced_at=excluded.synced_at",
                 (kind, entity, content_hash, version, now()))


def _untouched_product(conn, existing):
    state = _state(conn, "product", existing["id"])
    if state:
        return state["local_version"] == existing["version"]
    if existing["version"] != 1:
        return False
    versions = conn.execute("SELECT actor_id FROM calculation_versions WHERE product_id=?", (existing["id"],)).fetchall()
    return len(versions) == 1 and versions[0]["actor_id"] == "system"


def _validate_package(package):
    if not isinstance(package, dict) or package.get("format") != FORMAT:
        raise SyncError("Неизвестный формат пакета")
    if package.get("schema") != SCHEMA_VERSION:
        raise SyncError("Версия схемы калькулятора пакета (%s) не совпадает с серверной (%s): сначала обновите отстающую сторону" % (package.get("schema"), SCHEMA_VERSION), 409)
    if package.get("projectKey") != PROJECT_ID:
        raise SyncError("Пакет относится к другому проекту калькулятора")
    for product in package.get("products", []):
        row = product.get("row") or {}
        if not isinstance(row.get("id"), str) or not re.fullmatch(r"[0-9a-f-]{36}", row["id"]):
            raise SyncError("Недопустимый идентификатор изделия в пакете")
        if sha_of({"row": {k: v for k, v in row.items() if k not in PRODUCT_COLUMNS_SKIP_IN_HASH},
                   **{k: product[k] for k, _ in PRODUCT_CHILDREN}}) != product.get("contentHash"):
            raise SyncError("Контрольная сумма изделия %s не совпала: пакет повреждён" % row["id"])
    for blob in package.get("blobs", []):
        if not SHA_RE.match(blob.get("sha256", "")):
            raise SyncError("Недопустимая контрольная сумма вложения")
    for asset in package.get("assets", []):
        if not valid_asset_path(asset.get("path", "")) or not SHA_RE.match(asset.get("sha256", "")):
            raise SyncError("Недопустимый путь файла исходников: %r" % asset.get("path"))


PRODUCT_INSERT_COLUMNS = ["id", "project_id", "profile_id", "name", "concrete_class", "volume", "steel_weight", "labour_hours",
                          "concrete_rate", "other_materials", "geometry_json", "volume_from_geometry", "source", "version",
                          "legacy_key", "created_at", "updated_at", "document_model_id", "norms_version", "norms_labour_rate"]


def _write_product(conn, bundle, existing, actor, staged_blobs, uploads_dir):
    row = dict(bundle["row"])
    row["project_id"] = PROJECT_ID
    pid = row["id"]
    if existing:
        sets = ",".join(f"{c}=?" for c in PRODUCT_INSERT_COLUMNS if c not in {"id", "created_at"})
        conn.execute(f"UPDATE products SET {sets} WHERE id=?",
                     [row.get(c) for c in PRODUCT_INSERT_COLUMNS if c not in {"id", "created_at"}] + [pid])
        for table in ("extra_lines", "line_overrides", "product_resource_baselines"):
            conn.execute(f"DELETE FROM {table} WHERE product_id=?", (pid,))
    else:
        if row.get("legacy_key") and conn.execute("SELECT 1 FROM products WHERE legacy_key=?", (row["legacy_key"],)).fetchone():
            row["legacy_key"] = None
        conn.execute(f"INSERT INTO products({','.join(PRODUCT_INSERT_COLUMNS)}) VALUES({','.join('?' * len(PRODUCT_INSERT_COLUMNS))})",
                     [row.get(c) for c in PRODUCT_INSERT_COLUMNS])
    for r in bundle["extra_lines"]:
        conn.execute("INSERT INTO extra_lines VALUES(?,?,?,?,?,?,?)",
                     (pid, r["code"], r["name"], r["unit"], r["quantity"], r["rate"], r["sort_order"]))
    for r in bundle["line_overrides"]:
        conn.execute("INSERT INTO line_overrides VALUES(?,?,?,?,?)", (pid, r["line_code"], r["quantity"], r["rate"], r["amount"]))
    for r in bundle["baselines"]:
        conn.execute("INSERT INTO product_resource_baselines VALUES(?,?,?,?)", (pid, r["code"], r["quantity"], r["rate"]))
    for v in bundle.get("versions", []):
        conn.execute("INSERT OR IGNORE INTO calculation_versions VALUES(?,?,?,?,?,?,?,?)",
                     (v["id"], pid, v["product_version"], v["profile_id"], v["profile_version"], v["snapshot_json"], v["actor_id"], v["created_at"]))
    added = 0
    for f in bundle["files"]:
        if conn.execute("SELECT 1 FROM project_files WHERE product_id=? AND sha256=?", (pid, f["sha256"])).fetchone():
            continue
        staged = staged_blobs.get(f["sha256"])
        if staged is None:
            raise SyncError("Вложение %s не передано" % f["sha256"][:12], 409)
        identifier = str(uuid4())
        target = Path(uploads_dir) / (identifier + ".bin")
        shutil.copyfile(staged, target)
        key = f["migration_key"]
        if key and conn.execute("SELECT 1 FROM project_files WHERE product_id=? AND migration_key=?", (pid, key)).fetchone():
            key = None
        conn.execute("INSERT INTO project_files(id,product_id,original_name,storage_name,size,sha256,mime_type,migration_key,actor_id,created_at) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (identifier, pid, f["original_name"], target.name, f["size"], f["sha256"], f["mime_type"], key, actor, f["created_at"]))
        added += 1
    return added


def apply_package(conn, package, actor, staged_blobs=None, uploads_dir=None, dry_run=False):
    """Применяет данные пакета в открытой транзакции. Возвращает отчёт.

    При dry_run ничего не пишет: в отчёте то же, что было бы сделано."""
    _validate_package(package)
    staged_blobs = staged_blobs or {}
    report = {"profiles": {"created": 0, "updated": 0, "unchanged": 0, "serverPriority": []},
              "norms": {"created": 0, "updated": 0, "unchanged": 0, "serverPriority": []},
              "products": {"created": 0, "updated": 0, "unchanged": 0, "serverPriority": [], "senderOlder": []},
              "attachmentsAdded": 0, "collisions": {"notesAdded": 0, "statesAdded": 0}}

    for p in package.get("profiles", []):
        bucket = report["profiles"]
        existing = conn.execute("SELECT * FROM calculation_profiles WHERE id=?", (p["id"],)).fetchone()
        if existing is None:
            bucket["created"] += 1
            if not dry_run:
                conn.execute("INSERT INTO calculation_profiles VALUES(?,?,?,?)", (p["id"], p["version"], p["name"], p["parameters_json"]))
        elif existing["parameters_json"] == p["parameters_json"] and existing["version"] == p["version"]:
            bucket["unchanged"] += 1
        elif p["version"] > existing["version"]:
            bucket["updated"] += 1
            if not dry_run:
                conn.execute("UPDATE calculation_profiles SET version=?,name=?,parameters_json=? WHERE id=?",
                             (p["version"], p["name"], p["parameters_json"], p["id"]))
        else:
            bucket["serverPriority"].append(p["id"])

    for n in package.get("norms", []):
        bucket = report["norms"]
        existing = conn.execute("SELECT * FROM production_norms WHERE id=?", (n["id"],)).fetchone()
        incoming_hash = sha_of({"v": n["version"], "p": n["parameters_json"]})
        if existing is None:
            bucket["created"] += 1
            if not dry_run:
                conn.execute("INSERT INTO production_norms VALUES(?,?,?,?,?)", (n["id"], n["version"], n["parameters_json"], n["updated_at"], actor))
                _remember(conn, "norms", n["id"], incoming_hash, n["version"])
            continue
        if existing["parameters_json"] == n["parameters_json"] and existing["version"] == n["version"]:
            bucket["unchanged"] += 1
            if not dry_run:
                _remember(conn, "norms", n["id"], incoming_hash, existing["version"])
            continue
        state = _state(conn, "norms", n["id"])
        untouched = (state["local_version"] == existing["version"]) if state else (existing["version"] == 1 and existing["actor_id"] == "system")
        if untouched and n["version"] > existing["version"]:
            bucket["updated"] += 1
            if not dry_run:
                conn.execute("UPDATE production_norms SET version=?,parameters_json=?,updated_at=?,actor_id=? WHERE id=?",
                             (n["version"], n["parameters_json"], n["updated_at"], actor, n["id"]))
                _remember(conn, "norms", n["id"], incoming_hash, n["version"])
        else:
            bucket["serverPriority"].append(n["id"])

    for bundle in package.get("products", []):
        bucket = report["products"]
        row = bundle["row"]
        pid = row["id"]
        existing = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if existing is None:
            bucket["created"] += 1
            if not dry_run:
                report["attachmentsAdded"] += _write_product(conn, bundle, None, actor, staged_blobs, uploads_dir)
                _remember(conn, "product", pid, bundle["contentHash"], row["version"])
            continue
        current = product_bundle(conn, pid, with_versions=False)
        if current["contentHash"] == bundle["contentHash"]:
            bucket["unchanged"] += 1
            if not dry_run:  # вложения из пакета всё равно добавляются, версия изделия не меняется
                report["attachmentsAdded"] += _add_attachments_only(conn, bundle, actor, staged_blobs, uploads_dir)
                _remember(conn, "product", pid, bundle["contentHash"], existing["version"])
            continue
        if not _untouched_product(conn, existing):
            bucket["serverPriority"].append(pid)
            if not dry_run:
                report["attachmentsAdded"] += _add_attachments_only(conn, bundle, actor, staged_blobs, uploads_dir)
            continue
        if row["version"] <= existing["version"]:
            bucket["senderOlder"].append(pid)
            continue
        bucket["updated"] += 1
        if not dry_run:
            report["attachmentsAdded"] += _write_product(conn, bundle, existing, actor, staged_blobs, uploads_dir)
            _remember(conn, "product", pid, bundle["contentHash"], row["version"])
    # Комментарии и статусы коллизий — работа людей: комментарии объединяются по идентификатору (ничего не удаляется),
    # статус ставится только там, где на принимающей стороне его ещё не было (приоритет сервера).
    for n in package.get("collisionNotes", []):
        if conn.execute("SELECT 1 FROM collision_notes WHERE id=?", (n["id"],)).fetchone():
            continue
        report["collisions"]["notesAdded"] += 1
        if not dry_run:
            conn.execute("INSERT INTO collision_notes(id,model_id,collision_key,author_id,author_name,text,created_at) VALUES(?,?,?,?,?,?,?)",
                         (n["id"], n["model_id"], n["collision_key"], n["author_id"], n["author_name"], n["text"], n["created_at"]))
    for st in package.get("collisionState", []):
        if conn.execute("SELECT 1 FROM collision_state WHERE model_id=? AND collision_key=?", (st["model_id"], st["collision_key"])).fetchone():
            continue
        report["collisions"]["statesAdded"] += 1
        if not dry_run:
            conn.execute("INSERT INTO collision_state VALUES(?,?,?,?,?)", (st["model_id"], st["collision_key"], st["status"], st["updated_by"], st["updated_at"]))
    return report


def _add_attachments_only(conn, bundle, actor, staged_blobs, uploads_dir):
    pid = bundle["row"]["id"]
    added = 0
    for f in bundle["files"]:
        if conn.execute("SELECT 1 FROM project_files WHERE product_id=? AND sha256=?", (pid, f["sha256"])).fetchone():
            continue
        staged = staged_blobs.get(f["sha256"])
        if staged is None:
            continue
        identifier = str(uuid4())
        target = Path(uploads_dir) / (identifier + ".bin")
        shutil.copyfile(staged, target)
        conn.execute("INSERT INTO project_files(id,product_id,original_name,storage_name,size,sha256,mime_type,migration_key,actor_id,created_at) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (identifier, pid, f["original_name"], target.name, f["size"], f["sha256"], f["mime_type"], None, actor, f["created_at"]))
        added += 1
    return added


# ------------------------------------------------------------------ загрузки
class Staging:
    """Промежуточное хранилище принятых частями файлов: `<calc>/sync-staging/`.

    Файл становится «готовым» только когда принят целиком и сошлась SHA-256;
    повторная загрузка с нуля безопасна (offset=0 начинает заново)."""

    def __init__(self, base):
        self.base = Path(base)

    def _dir(self, kind):
        directory = self.base / kind
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def key_name(self, kind, key):
        if kind == "blob":
            if not SHA_RE.match(key):
                raise SyncError("Недопустимый ключ вложения")
            return key
        if kind == "asset":
            if not valid_asset_path(key):
                raise SyncError("Недопустимый путь файла")
            return hashlib.sha256(key.encode()).hexdigest()
        if kind == "package":  # сжатый JSON с данными расчётов: передаётся блоками, чтобы не упираться в лимит тела запроса прокси
            if not re.fullmatch(r"[0-9a-f]{32}", key):
                raise SyncError("Недопустимый ключ пакета")
            return key
        raise SyncError("Неизвестный вид файла")

    def purge_old(self, kind, seconds=86400):
        import time
        for path in self._dir(kind).glob("*"):
            if time.time() - path.stat().st_mtime > seconds:
                path.unlink(missing_ok=True)

    def part(self, kind, key):
        return self._dir(kind) / (self.key_name(kind, key) + ".part")

    def done(self, kind, key):
        return self._dir(kind) / (self.key_name(kind, key) + ".bin")

    def write_chunk(self, kind, key, sha256, size, offset, data):
        if not SHA_RE.match(sha256) or size < 0:
            raise SyncError("Недопустимые параметры загрузки")
        part = self.part(kind, key)
        if offset == 0:
            part.unlink(missing_ok=True)
        current = part.stat().st_size if part.exists() else 0
        if offset != current:
            raise SyncError("Смещение %d не совпадает с принятым объёмом %d" % (offset, current), 409, {"received": current})
        if current + len(data) > size:
            raise SyncError("Принято больше заявленного размера", 413)
        with part.open("ab") as stream:
            stream.write(data)
        received = current + len(data)
        if received == size:
            if file_sha256(part) != sha256:
                part.unlink(missing_ok=True)
                raise SyncError("Контрольная сумма файла не совпала, загрузите его заново", 409)
            os.replace(part, self.done(kind, key))
        return received

    def received(self, kind, key):
        return self.done(kind, key).exists()


def install_assets(assets_dir, staging, assets):
    """Переносит принятые файлы исходников на место (атомарно по файлу).
    Возвращает список обновлённых путей."""
    root = Path(assets_dir)
    updated = []
    for asset in assets:
        target = root / asset["path"]
        if target.exists() and file_sha256(target) == asset["sha256"]:
            continue
        source = staging.done("asset", asset["path"])
        if not source.exists():
            raise SyncError("Файл %s не передан" % asset["path"], 409)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name("." + target.name + "." + uuid4().hex + ".tmp")
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
        source.unlink(missing_ok=True)
        updated.append(asset["path"])
    return updated


def needed(package, assets_dir, staging, conn):
    """Что принимающей стороне ещё нужно получить: файлы исходников и вложения."""
    root = Path(assets_dir)
    assets = []
    for a in package.get("assets", []):
        target = root / a["path"]
        if target.exists() and target.stat().st_size == a["size"] and file_sha256(target) == a["sha256"]:
            continue
        if staging.received("asset", a["path"]):
            continue
        assets.append(a["path"])
    blobs = []
    known = {r["sha256"] for r in conn.execute("SELECT DISTINCT sha256 FROM project_files")}
    for b in package.get("blobs", []):
        if b["sha256"] not in known and not staging.received("blob", b["sha256"]):
            blobs.append(b["sha256"])
    return assets, blobs

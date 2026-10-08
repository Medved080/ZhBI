"""
ПОЛНАЯ резервная копия: всё, что сервис хранит и не может получить из git
(запрос пользователя 2026-10-08, после проверки состава обычной копии).

Зачем. Обычная копия (`app/backups.py`) — это файл основной базы и ничего
больше. Вне неё лежит то, что сервис создаёт сам и восстановить не может:
  * `uploads/` — вложения к проекту/объекту/изделию, внешние 3D-модели,
    загруженные через браузер чертежи. В базе остаются строки, на диске
    — пусто: карточка вложение показывает, скачать нельзя;
  * `data/calc/` — отдельная база калькулятора и её вложения.
Раньше «полную копию» приходилось собирать на сервере руками командой `tar`
по живой базе в режиме WAL — файл базы и журнал могли разойтись.

Состав архива (решение пользователя 2026-10-08):
  manifest.json                 — что это, откуда, когда, сколько строк;
  db/zhbi.db                    — основная база, снятая `Connection.backup()`;
  uploads/…                     — вложения как есть на диске;
  calc/calczhbi.sqlite3         — база калькулятора, снятая `Connection.backup()`;
  calc/uploads/…                — вложения калькулятора.
НЕ входят: источники калькулятора (`data/calc/assets`, ~0,5 ГБ, поставляются
пакетом отправки), `Input/`, классификатор адресов и карта (приносятся снаружи,
`Docs/DECISIONS.md`), файлы секретов (ключ ИИ-роутера, токены передачи): ключи
не должны лежать в архиве, который увозят с сервера. После переезда на другой
сервер их вводят заново.

Где лежит. `data/backups/full/` — рядом с обычными копиями, на том же томе
(в Docker он уже смонтирован), но в ОТДЕЛЬНОЙ папке: ротация обычных копий
(`*.db` в `data/backups`) их не видит и не трогает. Полные копии не удаляются
сами никогда — только кнопкой: каждая весит как вся база с вложениями, и
решать, какую оставить, должен человек.

Восстановление — как «Перенос базы» (`app/db_transfer.py`): кодовое слово,
служебная копия ПЕРЕД заменой, прежние вложения не удаляются, а отъезжают в
`data/backups/`. Схему после замены догоняет вызывающий (`init_db()` и
обработки релиза), схему калькулятора — эта функция.
"""

import json
import re
import shutil
import socket
import sqlite3
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import app.db as _db
from app import backups
from app.backups import BackupError
from app.db_transfer import (
    CONFIRM_WORD, MAX_UNPACKED_BYTES, UPLOADS_DIR, _check_db_file,
    _db_release_version, _swap_uploads, _table_counts, _uploads_stats,
)

FULL_DIR = backups.BACKUP_DIR / "full"

FORMAT_VERSION = 1
KIND = "full-backup"          # отличает наш архив от снимка «Переноса базы»

MANIFEST_NAME = "manifest.json"
DB_MEMBER = "db/zhbi.db"
UPLOADS_PREFIX = "uploads/"
CALC_DB_MEMBER = "calc/calczhbi.sqlite3"
CALC_UPLOADS_PREFIX = "calc/uploads/"

# Файлы, которые уже сжаты: deflate их не уменьшит, а время съест.
_STORED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".zip", ".7z", ".gz", ".mp4",
               ".mov", ".pdf", ".docx", ".xlsx", ".pptx", ".fbx", ".bin"}

# Одновременно — одна сборка: две сборки на одном томе вдвое увеличат и
# нагрузку, и требование к месту, а проверка места их не учитывает.
_BUILD_LOCK = threading.Lock()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _meta_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".json")


def _calc_settings():
    """Настройки калькулятора. Импорт локальный: подсистема необязательна, и
    модуль полной копии не должен ронять сервис, если она не поднялась."""
    from app.calc.config import Settings
    return Settings.embedded()


def _calc_present(cfg) -> bool:
    return cfg.database_path.is_file()


def _calc_schema(path: Path) -> Optional[int]:
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _snapshot(src_path: Path, dst_path: Path) -> None:
    """Согласованный снимок живой базы штатным онлайновым бэкапом SQLite
    (по той же причине, что в app/backups.py: простое копирование файла
    базы в режиме WAL даёт неполный или рваный файл)."""
    source = sqlite3.connect(src_path, timeout=60)
    try:
        dest = sqlite3.connect(dst_path)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()


def _quick_check(path: Path, что: str) -> None:
    conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    try:
        результат = conn.execute("PRAGMA quick_check").fetchone()[0]
    finally:
        conn.close()
    if результат != "ok":
        raise BackupError(500, f"Снимок {что} не прошёл проверку целостности: {результат}. Архив не создан.")


def _files(root: Path):
    if root.is_dir():
        for p in sorted(root.rglob("*")):
            if p.is_file():
                yield p


def estimate() -> dict:
    """Сколько займёт полная копия (до сжатия) — для экрана и проверки места."""
    cfg = _calc_settings()
    база = backups.database_bytes()
    вложения = _uploads_stats(UPLOADS_DIR)
    calc_db = cfg.database_path.stat().st_size if _calc_present(cfg) else 0
    calc_up = _uploads_stats(cfg.data_dir / "uploads")
    итого = база + вложения["bytes"] + calc_db + calc_up["bytes"]
    return {
        "db_bytes": база,
        "uploads": вложения,
        "calc_present": _calc_present(cfg),
        "calc_db_bytes": calc_db,
        "calc_uploads": calc_up,
        "total_bytes": итого,
    }


# ==================== СПИСОК ====================


def _safe_path(name: str) -> Path:
    """Имя приходит из HTTP: без разделителей, `..` и только `.zip`."""
    if not name or "/" in name or "\\" in name or ".." in name or not name.endswith(".zip"):
        raise BackupError(400, "Недопустимое имя полной копии")
    path = FULL_DIR / name
    if not path.is_file():
        raise BackupError(404, f"Полная копия «{name}» не найдена")
    return path


def list_full_backups() -> list:
    """Все полные копии, новые сверху. Файл без описания (.json) тоже
    показывается: физически он пригоден, просто происхождение неизвестно."""
    if not FULL_DIR.is_dir():
        return []
    items = []
    for path in FULL_DIR.glob("*.zip"):
        meta = {}
        mp = _meta_path(path)
        if mp.exists():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                meta = {}
        stat = path.stat()
        meta.setdefault("name", path.name)
        meta.setdefault("created_at", datetime.fromtimestamp(stat.st_mtime, timezone.utc)
                        .strftime("%Y-%m-%d %H:%M:%S"))
        meta.setdefault("user_name", None)
        meta.setdefault("comment", None)
        meta["size_bytes"] = stat.st_size
        items.append(meta)
    items.sort(key=lambda m: (m["created_at"], m["name"]), reverse=True)
    return items


# ==================== СОЗДАНИЕ ====================


def _write_tree(zf: zipfile.ZipFile, root: Path, prefix: str) -> dict:
    files = size = 0
    for p in _files(root):
        arc = prefix + p.relative_to(root).as_posix()
        сжатие = zipfile.ZIP_STORED if p.suffix.lower() in _STORED_EXT else zipfile.ZIP_DEFLATED
        try:
            zf.write(p, arc, compress_type=сжатие)
        except FileNotFoundError:
            continue          # файл удалили, пока шла сборка: в копию он уже не нужен
        files += 1
        size += p.stat().st_size if p.exists() else 0
    return {"files": files, "bytes": size}


def create_full_backup(user_name: Optional[str] = None, user_id: Optional[int] = None,
                       comment: Optional[str] = None) -> dict:
    """Собрать полную копию. Возвращает её описание (как `list_full_backups`).

    Порядок: место → снимки обеих баз во временную папку → проверка
    целостности снимков → запись архива во `.part` → проверка архива целиком
    (`testzip`) → переименование. Недособранный или непроверенный архив не
    должен выглядеть готовой копией.
    """
    if not _BUILD_LOCK.acquire(blocking=False):
        raise BackupError(409, "Полная копия уже собирается — дождитесь её окончания.")
    try:
        FULL_DIR.mkdir(parents=True, exist_ok=True)
        оценка = estimate()
        место = backups.disk_state()
        # Запас: сжатие вложений не гарантировано, плюс временные снимки баз
        # (они лежат рядом с архивом до его завершения).
        нужно = оценка["total_bytes"] + оценка["db_bytes"] + оценка["calc_db_bytes"] + 64 * 1024 ** 2
        if место.get("known") and место["free_bytes"] < нужно:
            raise BackupError(
                507,
                f"Недостаточно места для полной копии: нужно до {backups._объём(нужно)}, "
                f"свободно {backups._объём(место['free_bytes'])}. Удалите ненужные полные копии "
                f"или освободите место на сервере.")

        stamp = _utc_now().strftime("%Y%m%d_%H%M%S")
        path = FULL_DIR / f"zhbi-full_{stamp}.zip"
        n = 1
        while path.exists():
            path = FULL_DIR / f"zhbi-full_{stamp}_{n}.zip"
            n += 1
        part = path.with_name(path.name + ".part")

        cfg = _calc_settings()
        try:
            with tempfile.TemporaryDirectory(dir=FULL_DIR, prefix=".build-") as tmp:
                tmp = Path(tmp)
                db_copy = tmp / "zhbi.db"
                _snapshot(_db.DB_PATH, db_copy)
                _quick_check(db_copy, "основной базы")
                calc_copy = None
                if _calc_present(cfg):
                    calc_copy = tmp / "calczhbi.sqlite3"
                    _snapshot(cfg.database_path, calc_copy)
                    _quick_check(calc_copy, "базы калькулятора")

                from app.release_tasks import code_version
                manifest = {
                    "format": FORMAT_VERSION,
                    "kind": KIND,
                    "created_at": _utc_now().strftime("%Y-%m-%d %H:%M:%S"),
                    "created_by": user_name,
                    "comment": comment,
                    "host": socket.gethostname(),
                    "code_version": code_version(),
                    "db_version": _db_release_version(db_copy),
                    "db_bytes": db_copy.stat().st_size,
                    "tables": _table_counts(db_copy),
                    "calc": {
                        "present": calc_copy is not None,
                        "schema": _calc_schema(calc_copy) if calc_copy else None,
                        "tables": _table_counts(calc_copy) if calc_copy else {},
                    },
                }
                with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                    zf.write(db_copy, DB_MEMBER)
                    manifest["uploads"] = _write_tree(zf, UPLOADS_DIR, UPLOADS_PREFIX)
                    if calc_copy is not None:
                        zf.write(calc_copy, CALC_DB_MEMBER)
                        manifest["calc"]["uploads"] = _write_tree(
                            zf, cfg.data_dir / "uploads", CALC_UPLOADS_PREFIX)
                    zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
                with zipfile.ZipFile(part) as zf:
                    плохой = zf.testzip()
                if плохой:
                    raise BackupError(500, f"Собранный архив не прошёл проверку (файл {плохой}). Копия не создана.")
                part.replace(path)
        except BaseException:
            part.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            raise

        meta = {
            "name": path.name,
            "created_at": manifest["created_at"],
            "user_name": user_name,
            "user_id": user_id,
            "comment": comment,
            "size_bytes": path.stat().st_size,
            "code_version": manifest["code_version"],
            "tables": manifest["tables"],
            "uploads": manifest["uploads"],
            "calc": manifest["calc"],
        }
        _meta_path(path).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return meta
    finally:
        _BUILD_LOCK.release()


def delete_full_backup(name: str) -> None:
    path = _safe_path(name)
    path.unlink()
    _meta_path(path).unlink(missing_ok=True)


# ==================== ПРОВЕРКА И ВОССТАНОВЛЕНИЕ ====================


def _read_manifest(zf: zipfile.ZipFile) -> dict:
    try:
        manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
    except (KeyError, ValueError, UnicodeDecodeError):
        raise BackupError(400, "Это не полная копия: манифест отсутствует или повреждён.")
    if manifest.get("kind") != KIND:
        raise BackupError(400, "Это архив другого вида (например, снимок «Переноса базы»). "
                               "Восстанавливать можно только полную копию, созданную здесь.")
    if manifest.get("format") != FORMAT_VERSION:
        raise BackupError(400, f"Формат полной копии {manifest.get('format')!r} не поддерживается "
                               f"(этот сервис понимает {FORMAT_VERSION}).")
    return manifest


_CALC_UP_RE = re.compile(r"^calc/uploads/[^/]+$")


def _check_members(zf: zipfile.ZipFile) -> int:
    """Только известные имена, ничего за пределами папки, суммарный размер в
    разумных пределах. Возвращает распакованный размер."""
    total = 0
    names = set()
    for info in zf.infolist():
        name = info.filename
        if name.endswith("/"):
            continue
        if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
            raise BackupError(400, f"Недопустимое имя файла в архиве: {name}")
        допустимо = (name in (MANIFEST_NAME, DB_MEMBER, CALC_DB_MEMBER)
                     or name.startswith(UPLOADS_PREFIX) or _CALC_UP_RE.match(name))
        if not допустимо:
            raise BackupError(400, f"В архиве посторонний файл: {name}")
        names.add(name)
        total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise BackupError(400, "Архив слишком велик в распакованном виде.")
    if DB_MEMBER not in names:
        raise BackupError(400, "В архиве нет файла основной базы — это не полная копия.")
    return total


def _extract(zf: zipfile.ZipFile, member: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zf.open(member) as src, open(dest, "wb") as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)


def describe_full_backup(name: str) -> dict:
    """Что внутри полной копии и что сейчас на сервере — для окна
    подтверждения. Ничего не меняет. Числа основной базы считаются по самому
    файлу базы из архива, а не по манифесту."""
    path = _safe_path(name)
    try:
        with zipfile.ZipFile(path) as zf:
            manifest = _read_manifest(zf)
            _check_members(zf)
            with tempfile.TemporaryDirectory(dir=FULL_DIR, prefix=".peek-") as tmp:
                db_copy = Path(tmp) / "zhbi.db"
                _extract(zf, DB_MEMBER, db_copy)
                факт = _check_db_file(db_copy)
    except (OSError, zipfile.BadZipFile) as exc:
        raise BackupError(400, f"Архив не читается: {exc}")
    cfg = _calc_settings()
    return {
        "name": name,
        "created_at": manifest.get("created_at"),
        "created_by": manifest.get("created_by"),
        "code_version": manifest.get("code_version"),
        "snapshot": {"tables": факт["tables"], "uploads": manifest.get("uploads"),
                     "calc": manifest.get("calc")},
        "current": {
            "tables": _table_counts(Path(_db.DB_PATH)),
            "uploads": _uploads_stats(UPLOADS_DIR),
            "calc": {"present": _calc_present(cfg),
                     "uploads": _uploads_stats(cfg.data_dir / "uploads")},
        },
        "confirm_hint": "Для восстановления введите кодовое слово",
    }


def restore_full_backup(name: str, confirm: str, user_name: Optional[str] = None,
                        user_id: Optional[int] = None) -> dict:
    """ПОЛНАЯ ЗАМЕНА основной базы, вложений и данных калькулятора.

    Порядок выбран так, чтобы неудача на любом шаге оставляла систему в
    понятном состоянии:
      1. кодовое слово — до всего остального;
      2. распаковка и проверка во ВРЕМЕННУЮ папку: битый архив не доходит до
         рабочих файлов; схема калькулятора из архива не новее кода;
      3. служебные копии текущего состояния: основная база (`auto_before_full_restore`)
         и, если он есть, калькулятор (zip в `data/calc/backups`);
      4. замена баз `Connection.backup()` (в транзакции, открытые соединения не
         остаются без файла);
      5. замена вложений: прежние НЕ удаляются, а отъезжают в `data/backups/`.

    Схему основной базы и обработки релиза догоняет вызывающий (как после
    восстановления из обычной копии); схему калькулятора — шаг 6 здесь.
    """
    if (confirm or "").strip() != CONFIRM_WORD:
        raise BackupError(400, "Кодовое слово введено неверно — восстановление не выполнено")
    path = _safe_path(name)
    cfg = _calc_settings()
    stamp = _utc_now().strftime("%Y%m%d_%H%M%S")

    with tempfile.TemporaryDirectory(dir=FULL_DIR, prefix=".restore-") as tmp:
        tmp = Path(tmp)
        try:
            with zipfile.ZipFile(path) as zf:
                manifest = _read_manifest(zf)
                распаковано = _check_members(zf)
                место = backups.disk_state()
                if место.get("known") and место["free_bytes"] < распаковано * 2 + backups.database_bytes():
                    raise BackupError(507, "Недостаточно места для восстановления: нужно примерно "
                                           f"{backups._объём(распаковано * 2)}, свободно "
                                           f"{backups._объём(место['free_bytes'])}.")
                db_copy = tmp / "zhbi.db"
                _extract(zf, DB_MEMBER, db_copy)
                _check_db_file(db_copy)
                calc_copy = None
                if CALC_DB_MEMBER in zf.namelist():
                    calc_copy = tmp / "calczhbi.sqlite3"
                    _extract(zf, CALC_DB_MEMBER, calc_copy)
                    from app.calc.database import SCHEMA_VERSION as CALC_SCHEMA
                    версия = _calc_schema(calc_copy)
                    if _схема_новее(версия, CALC_SCHEMA):
                        raise BackupError(400, f"База калькулятора в копии (схема {версия}) новее кода "
                                               f"этого сервера (схема {CALC_SCHEMA}) — миграции назад не "
                                               f"ходят. Сначала обновите сервер.")
                    _quick_check(calc_copy, "калькулятора из архива")
                # Каталоги создаются ВСЕГДА: в архиве вложений может не быть, и тогда восстановление
                # означает «вложений нет», а не «оставить те, что лежат сейчас».
                uploads_new = tmp / "uploads"
                calc_uploads_new = tmp / "calc_uploads"
                uploads_new.mkdir()
                calc_uploads_new.mkdir()
                for info in zf.infolist():
                    if info.filename.endswith("/"):
                        continue
                    if info.filename.startswith(UPLOADS_PREFIX):
                        _extract(zf, info.filename, uploads_new / info.filename[len(UPLOADS_PREFIX):])
                    elif info.filename.startswith(CALC_UPLOADS_PREFIX):
                        _extract(zf, info.filename, calc_uploads_new / info.filename[len(CALC_UPLOADS_PREFIX):])
        except (OSError, zipfile.BadZipFile) as exc:
            raise BackupError(400, f"Архив не читается: {exc}")

        # --- служебные копии ТЕКУЩЕГО состояния (всё, что ниже, разрушает его) ---
        копия = backups.create_backup(
            kind=backups.KIND_BEFORE_FULL_RESTORE, user_name=user_name, user_id=user_id,
            comment=f"автоматически перед восстановлением из полной копии «{name}»")
        calc_safety = None
        if _calc_present(cfg):
            from app.calc.backup import create_backup as calc_create_backup
            calc_safety = cfg.data_dir / "backups" / f"before-full-restore-{stamp}.zip"
            try:
                calc_create_backup(cfg, calc_safety)
            except (ValueError, OSError) as exc:
                raise BackupError(500, "Не удалось снять служебную копию калькулятора перед "
                                       f"восстановлением: {exc}. Ничего не заменено (основная база "
                                       f"уже скопирована: {копия['name']}).")

        # --- замена ---
        _replace_db(db_copy, Path(_db.DB_PATH))
        отъехали = _swap_uploads(uploads_new, backups.BACKUP_DIR / f"uploads_{stamp}")

        calc_отъехали = None
        if calc_copy is not None:
            _replace_db(calc_copy, cfg.database_path)
            calc_uploads = cfg.data_dir / "uploads"
            calc_uploads.mkdir(parents=True, exist_ok=True)
            старые = list(calc_uploads.iterdir())
            if старые:
                куда = backups.BACKUP_DIR / f"calc_uploads_{stamp}"
                куда.mkdir(parents=True, exist_ok=True)
                for child in старые:
                    shutil.move(str(child), str(куда / child.name))
                calc_отъехали = куда
            for child in list(calc_uploads_new.iterdir()):
                shutil.move(str(child), str(calc_uploads / child.name))
            from app.calc.database import initialize as calc_initialize
            try:
                calc_initialize(cfg)       # схема калькулятора из архива могла быть старее кода
            except Exception as exc:       # noqa: BLE001 — данные уже заменены, человеку нужна внятная фраза
                raise BackupError(500, f"База и вложения восстановлены, но схему калькулятора догнать не "
                                       f"удалось: {exc}. Служебная копия калькулятора: {calc_safety.name if calc_safety else '—'}.")

    return {
        "restored_from": name,
        "safety_backup": копия,
        "calc_safety_backup": calc_safety.name if calc_safety else None,
        "uploads_moved_to": отъехали.name if отъехали else None,
        "calc_uploads_moved_to": calc_отъехали.name if calc_отъехали else None,
        "calc_restored": calc_copy is not None,
        "manifest_created_at": manifest.get("created_at"),
    }


def _схема_новее(версия, код) -> bool:
    return версия is not None and версия > код


def _replace_db(source_path: Path, target_path: Path) -> None:
    source = sqlite3.connect(f"file:{source_path}?mode=ro&immutable=1", uri=True)
    try:
        target = sqlite3.connect(target_path)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

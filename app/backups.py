"""
Резервные копии базы данных (живой запрос 2026-07-29, после инцидента, в
котором автоматическая пересборка БД стёрла статусы — см. Docs/backlog.md).

Три требования пользователя, каждое отражено в коде:
  1. Никаких операций с пересозданием БД без предварительной копии.
  2. При восстановлении система показывает ВСЕ копии и даёт выбрать момент.
  3. Видно, кем и когда создана копия; служебные (автоматические) отличимы
     от созданных человеком.

Копия — файл в `data/backups/`, рядом с самой БД. Это важно для Docker:
`data/` уже смонтирована как том (см. docker-compose.yml), значит копии
переживают пересоздание контейнера без единой новой настройки.

**Копируем средствами SQLite, а не `cp`.** Метод `Connection.backup()` —
штатный онлайновый бэкап: он согласован с транзакциями и корректно работает,
пока сервер пишет в базу. Простое копирование файла на живой БД может
поймать её посреди транзакции и дать неконсистентную копию — ровно тогда,
когда она нужнее всего.

Метаданные — в отдельном .json рядом с файлом копии. Держать их в имени
файла (кто создал, зачем) неудобно и хрупко: ФИО содержат пробелы, а
комментарий в имя не поместится. Имя при этом всё равно несёт дату и вид
копии, чтобы папка читалась глазами без всякого интерфейса.
"""

import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import app.db as _db

BACKUP_DIR = Path(__file__).resolve().parent.parent / "data" / "backups"

# Виды копий. Служебные создаёт система сама, перед потенциально
# разрушительной операцией; ручную — человек кнопкой.
KIND_MANUAL = "manual"
KIND_BEFORE_RESTORE = "auto_before_restore"
KIND_BEFORE_REBUILD = "auto_before_rebuild"
# Копия перед ПЕРВЫМ стартом новой версии — до миграций схемы и до обработок
# релиза (2026-08-04, см. app/release_tasks.py). Раньше её полагалось снимать
# руками перед деплоем; теперь сервис снимает сам, и это ещё одна причина не
# подключаться к серверу.
KIND_BEFORE_UPDATE = "auto_before_update"
# Копия перед УБОРКОЙ отживших структур: уборка удаляет то, что больше не
# используется, и вернуться к нему иначе будет неоткуда.
KIND_BEFORE_CLEANUP = "auto_before_cleanup"

KIND_LABELS = {
    KIND_MANUAL: "создана пользователем",
    KIND_BEFORE_RESTORE: "служебная — перед восстановлением",
    KIND_BEFORE_REBUILD: "служебная — перед пересборкой БД",
    KIND_BEFORE_UPDATE: "служебная — перед обновлением версии",
    KIND_BEFORE_CLEANUP: "служебная — перед уборкой отживших структур",
}


# Отметки времени по всему сервису пишутся в UTC (`datetime('now')` в SQL,
# `app/activity.py`, `app/auth.py`), а в местное их переводит КЛИЕНТ при
# показе (`activityTimeLocal`, app.js). Здесь стояло `datetime.now()` —
# местное время процесса, то есть нарушение конвенции сразу в двух местах:
# в контейнере (`python:3.12-slim`, TZ не задан) местное время И ЕСТЬ UTC,
# так что копия получала отметку на пояс раньше, а список копий печатал её
# как есть, без перевода в местное — отсюда «время бэкапа неверное».
# `now(timezone.utc)`, а не `utcnow()`: в 3.12 второй объявлен устаревшим.
def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_from_timestamp(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, timezone.utc)


class BackupError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _meta_path(backup_path: Path) -> Path:
    return backup_path.with_suffix(backup_path.suffix + ".json")


def _safe_name(name: str) -> Path:
    """Защита от выхода за пределы папки копий: в имени не должно быть ни
    разделителей пути, ни '..'. Имя приходит из HTTP, и без этой проверки
    восстановление можно было бы натравить на произвольный файл."""
    if not name or "/" in name or "\\" in name or ".." in name:
        raise BackupError(400, "Недопустимое имя резервной копии")
    path = BACKUP_DIR / name
    if not path.exists():
        raise BackupError(404, f"Резервная копия '{name}' не найдена")
    return path


def _db_stats(path: Path) -> dict:
    """Сколько строк в КАЖДОЙ таблице копии — чтобы при выборе точки
    восстановления было видно не только время, но и содержимое: пустая копия
    и копия с полной историей внешне отличаются только размером.

    Считаем по всем таблицам, а не по нескольким избранным, именно затем,
    чтобы полнота копии была видна, а не декларировалась. Копия — это файл
    БД целиком (`Connection.backup()`), поэтому в неё физически попадает ВСЁ:
    элементы и их история статусов, пользователи, контрагенты/договоры/
    спецификации/контракты с позициями, зоны и их цвета, все справочники
    (подтипы, префиксы марок, формы маркеров, цвета статусов), настройки,
    оси, сессии и журнал действий. Выборочного экспорта здесь нет и быть не
    может — нечему потеряться."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            tables = [r["name"] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
            stats = {}
            for t in tables:
                try:
                    stats[t] = conn.execute(f'SELECT COUNT(*) AS n FROM "{t}"').fetchone()["n"]
                except sqlite3.Error:
                    stats[t] = None
            return stats
        finally:
            conn.close()
    except sqlite3.Error:
        return {}


def create_backup(
    kind: str = KIND_MANUAL,
    user_name: Optional[str] = None,
    user_id: Optional[int] = None,
    comment: Optional[str] = None,
) -> dict:
    """Снять копию текущей БД. Возвращает описание созданной копии.

    Имя: `zhbi_ГГГГММДД_ЧЧММСС_<вид>.db` — дата и вид читаются глазами прямо
    в списке файлов, без интерфейса и без чтения .json. Время в имени тоже
    UTC: разойдясь с `created_at` внутри .json, оно путало бы сильнее, чем
    смещение на пояс.
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = _utc_now().strftime("%Y%m%d_%H%M%S")
    path = BACKUP_DIR / f"zhbi_{stamp}_{kind}.db"
    # Крайне маловероятно, но две копии в одну секунду затёрли бы друг друга.
    suffix = 1
    while path.exists():
        path = BACKUP_DIR / f"zhbi_{stamp}_{kind}_{suffix}.db"
        suffix += 1

    source = sqlite3.connect(_db.DB_PATH)
    try:
        target = sqlite3.connect(path)
        try:
            source.backup(target)  # штатный онлайновый бэкап SQLite
        finally:
            target.close()
    finally:
        source.close()

    meta = {
        "name": path.name,
        "created_at": _utc_now().strftime("%Y-%m-%d %H:%M:%S"),
        "kind": kind,
        "kind_label": KIND_LABELS.get(kind, kind),
        "user_name": user_name,
        "user_id": user_id,
        "comment": comment,
        "size_bytes": path.stat().st_size,
        "stats": _db_stats(path),
    }
    _meta_path(path).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def list_backups() -> list:
    """Все копии, новые сверху. Файл без .json (например, скопированный
    руками) всё равно показывается — иначе он был бы невидим для
    восстановления, хотя физически пригоден."""
    if not BACKUP_DIR.is_dir():
        return []
    items = []
    for path in BACKUP_DIR.glob("*.db"):
        meta_path = _meta_path(path)
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                meta = {}
        else:
            meta = {}
        stat = path.stat()
        meta.setdefault("name", path.name)
        meta.setdefault("created_at", _utc_from_timestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"))
        meta.setdefault("kind", "unknown")
        meta.setdefault("kind_label", "происхождение неизвестно (файл без описания)")
        meta.setdefault("user_name", None)
        meta.setdefault("comment", None)
        meta["size_bytes"] = stat.st_size
        # Пересчитываем, если статистики нет ИЛИ она в старом усечённом
        # формате (первая версия писала 4 избранных числа). Иначе у копий,
        # снятых до перехода на полный подсчёт, в интерфейсе значилось бы
        # "всего таблиц: 4" — заметно хуже, чем ничего.
        if len(meta.get("stats") or {}) < 10:
            meta["stats"] = _db_stats(path)
        items.append(meta)
    items.sort(key=lambda m: m["created_at"], reverse=True)
    return items


def restore_backup(name: str, user_name: Optional[str] = None, user_id: Optional[int] = None) -> dict:
    """Восстановить БД из копии. ПЕРЕД восстановлением всегда снимается
    служебная копия текущего состояния — требование пользователя и просто
    здравый смысл: восстановление это тоже потенциальная потеря данных, если
    выбрали не ту точку.

    Восстанавливаем тем же `Connection.backup()`, только в обратную сторону:
    содержимое копии переносится В рабочую базу. Это лучше подмены файла —
    операция идёт внутри транзакции, и уже открытые соединения сервера
    продолжают видеть согласованную базу, а не исчезнувший из-под них файл.
    """
    path = _safe_name(name)
    safety = create_backup(
        kind=KIND_BEFORE_RESTORE,
        user_name=user_name,
        user_id=user_id,
        comment=f"автоматически перед восстановлением из «{name}»",
    )

    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(_db.DB_PATH)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

    return {"restored_from": name, "safety_backup": safety}


def delete_backup(name: str) -> None:
    path = _safe_name(name)
    meta_path = _meta_path(path)
    path.unlink()
    if meta_path.exists():
        meta_path.unlink()


def adopt_legacy_backup(path: Path, kind: str, comment: str) -> Optional[dict]:
    """Перенести в папку копий файл, оставшийся от прежнего механизма
    (`data/zhbi.db.bak-*` от аварийной пересборки). Такие файлы — полноценные
    копии, просто лежат не там и без описания; терять их нельзя."""
    if not path.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / f"{path.name}.db"
    if target.exists():
        return None
    shutil.move(str(path), str(target))
    meta = {
        "name": target.name,
        "created_at": _utc_from_timestamp(target.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "kind": kind,
        "kind_label": KIND_LABELS.get(kind, kind),
        "user_name": None,
        "user_id": None,
        "comment": comment,
        "size_bytes": target.stat().st_size,
        "stats": _db_stats(target),
    }
    _meta_path(target).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta

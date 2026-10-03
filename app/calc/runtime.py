"""Жизненный цикл подсистемы внутри процесса ЖБИ: старт, остановка, настройки."""
import logging

from .config import Settings
from .database import initialize
from .link import link_project

log = logging.getLogger(__name__)
_state = {"settings": None, "worker": None}


def settings():
    if _state["settings"] is None:
        _state["settings"] = Settings.embedded()
    return _state["settings"]


def backup_before_migration(cfg):
    """Копия базы калькулятора ПЕРЕД миграцией схемы (правило проекта: данные не
    мигрируются без копии). Новой базе и той же версии схемы копия не нужна."""
    import sqlite3
    from datetime import datetime, timezone

    from .backup import create_backup
    from .database import SCHEMA_VERSION
    path = cfg.database_path
    if not path.exists():
        return None
    conn = sqlite3.connect(path)
    try:
        version = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
    except sqlite3.OperationalError:
        version = None
    finally:
        conn.close()
    if version is None or version >= SCHEMA_VERSION:
        return None
    target = cfg.data_dir / "backups" / ("before-schema-%s-%s.zip" % (SCHEMA_VERSION, datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")))
    create_backup(cfg, target)
    log.info("calc: копия перед миграцией схемы %s→%s: %s", version, SCHEMA_VERSION, target)
    return target


def startup():
    """Применяет миграции калькулятора и привязывает его к проекту ЖБИ.

    Падение подсистемы не должно ронять весь сервис ЖБИ (трекер важнее): ошибка
    пишется в журнал, а запросы /calc/* отвечают 503 до исправления.
    """
    try:
        cfg = settings()
        backup_before_migration(cfg)
        initialize(cfg)
        from . import recovery
        from .document_models import configure_recovery_assets
        configure_recovery_assets(recovery.assets_dir(cfg))
        try:
            recovery.restore_revision_assets(cfg)
        except Exception:  # noqa: BLE001 — источники ещё не поставлены или недоступны
            log.exception("calc: восстановление редакций моделей пропущено")
        info = link_project(cfg)
        if not info["linked"]:
            log.warning("calc: расчёты не привязаны к проекту ЖБИ: %s", info)
        if cfg.recovery_worker_enabled:
            _state["worker"] = recovery.RecoveryWorker(cfg)
            _state["worker"].start()
        _state["ready"] = True
    except Exception:  # noqa: BLE001
        _state["ready"] = False
        log.exception("calc: подсистема не запущена")


def shutdown():
    worker = _state.get("worker")
    if worker:
        worker.stop()


def ready():
    return bool(_state.get("ready"))


def require_ready():
    from fastapi import HTTPException
    if not ready():
        raise HTTPException(503, "Калькулятор не запущен: см. журнал сервера (calc: подсистема не запущена)")

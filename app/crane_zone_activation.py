"""Вступление в силу ожидающих редакций по московскому календарному дню."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, time, timedelta

from app import activity
from app.crane_zone_service import activate_due
from app.crane_zone_transition import TransitionIncomplete, transition_pending
from app.crane_zone_versions import BUSINESS_TZ
from app.db import get_connection

_log = logging.getLogger(__name__)


def activate_now(*, retry_transition: bool = True) -> list[int]:
    """Идемпотентно применить наступившие редакции; ошибку не скрывать."""
    conn = get_connection()
    try:
        ids = activate_due(conn)
    finally:
        conn.close()
    for version_id in ids:
        activity.log(
            "crane_zone_version_activate", source="system", entity_type="crane_zone_version",
            entity_id=version_id, new_value=str(version_id),
        )
    if retry_transition:
        conn = get_connection()
        try:
            try:
                transition_pending(conn)
                pending_release = conn.execute(
                    "SELECT status FROM release_tasks WHERE name = ?",
                    ("2026-09-27-crane-stance-union",),
                ).fetchone()
            except TransitionIncomplete as exc:
                _log.info("Крановый переход ожидает повторения: %s", exc)
            else:
                if pending_release and pending_release["status"] != "ok":
                    # Старый error у обработки релиза должен стать ok после
                    # автоматического перехода ожидавшего будущую редакцию.
                    from app.release_tasks import run_by_name
                    run_by_name("2026-09-27-crane-stance-union")
        finally:
            conn.close()
    return ids


def _seconds_to_next_day() -> float:
    now = datetime.now(BUSINESS_TZ)
    tomorrow = now.date() + timedelta(days=1)
    return max(0.1, (datetime.combine(tomorrow, time.min, BUSINESS_TZ) - now).total_seconds())


def start_worker() -> threading.Event:
    """Один лёгкий таймер на воркер; повтор при ошибке не сдвигает дату."""
    stop = threading.Event()

    def run():
        while not stop.is_set():
            if stop.wait(min(_seconds_to_next_day() + 0.1, 300)):
                return
            try:
                activate_now()
            except Exception:
                _log.exception("Не удалось активировать крановые зоны; повтор в следующем цикле")

    threading.Thread(target=run, name="crane-zone-activation", daemon=True).start()
    return stop

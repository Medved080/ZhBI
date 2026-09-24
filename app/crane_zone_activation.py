"""Вступление в силу ожидающих редакций по московскому календарному дню."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, time, timedelta

from app import activity
from app.crane_zone_service import activate_due
from app.crane_zone_versions import BUSINESS_TZ
from app.db import get_connection

_log = logging.getLogger(__name__)


def activate_now() -> list[int]:
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
            if stop.wait(_seconds_to_next_day() + 0.1):
                return
            while not stop.is_set():
                try:
                    activate_now()
                    break
                except Exception:
                    _log.exception("Не удалось активировать крановые зоны; повтор через минуту")
                    if stop.wait(60):
                        return

    threading.Thread(target=run, name="crane-zone-activation", daemon=True).start()
    return stop

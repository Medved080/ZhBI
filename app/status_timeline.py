"""История статусов объекта одним компактным массивом — для «хронологического» режима схемы (2026-10-08).

Схема умеет показать состояние модели на любой момент («срез») и воспроизвести динамику за период. Для плавного
воспроизведения браузер не должен ходить в базу за статусами на каждый показываемый момент: он один раз получает ВСЮ
историю объекта в бинарном виде и дальше считает срез у себя (бинарный поиск по записям изделия).

Формат ответа (всё — little-endian, base64):
  statuses — коды статусов в порядке жизненного цикла; индекс статуса в `st` — позиция в этом списке;
  n        — число изделий в массивах;
  ids      — Int32[n]: id изделий;
  off      — Int32[n+1]: смещения записей изделия в `ts`/`st` (записи изделия k — off[k]..off[k+1]-1);
  ts       — Int32[m]: момент записи в секундах от 2020-01-01 00:00:00 «по стенным часам» (changed_at хранится без пояса —
             это «рабочая дата», вводимая человеком, и клиент считает срез в тех же стенных часах);
  st       — Uint8[m]: статус.
Записи изделия упорядочены по (changed_at, id) — той же парой, по которой система определяет текущий статус. Подряд
идущие записи с одним статусом схлопнуты. Изделия, у которых вся история — одна запись «Запланирован», в ответ не входят:
до первой записи изделие и так «Запланирован» (решение пользователя 2026-10-08)."""
import base64
import sqlite3
import struct
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app.access import assert_object_feature
from app.auth import get_current_user
from app.db import get_connection, visible_elements_clause
from app.models import STATUS_ORDER

router = APIRouter(tags=["status-timeline"])

EPOCH = datetime(2020, 1, 1)
STATUSES = [s.value for s in STATUS_ORDER]


def _seconds(text: str) -> Optional[int]:
    """«2026-07-25 22:21:55» (или с «T») → секунды от EPOCH; нераспознанное — None."""
    s = (text or "").strip().replace("T", " ")[:19]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int((datetime.strptime(s, fmt) - EPOCH).total_seconds())
        except ValueError:
            continue
    return None


def build_timeline(conn: sqlite3.Connection, object_id: int) -> dict:
    index = {code: i for i, code in enumerate(STATUSES)}
    rows = conn.execute(
        f"""
        SELECT h.element_id AS element_id, h.status AS status, h.changed_at AS changed_at
        FROM status_history h JOIN elements e ON e.id = h.element_id
        WHERE e.object_id = ? AND {visible_elements_clause("e")}
        ORDER BY h.element_id, h.changed_at, h.id
        """,
        (object_id,),
    ).fetchall()
    ids, off, ts, st = [], [0], [], []
    current, records = None, []

    def flush():
        # схлопнуть подряд идущие одинаковые статусы; изделие «только planned» не нужно
        out = []
        for t, s in records:
            if not out or out[-1][1] != s:
                out.append((t, s))
        if not out or (len(out) == 1 and out[0][1] == index["planned"]):
            return
        ids.append(current)
        for t, s in out:
            ts.append(t)
            st.append(s)
        off.append(len(ts))

    for r in rows:
        t, s = _seconds(r["changed_at"]), index.get(r["status"])
        if t is None or s is None:
            continue
        if r["element_id"] != current:
            if current is not None:
                flush()
            current, records = r["element_id"], []
        records.append((t, s))
    if current is not None:
        flush()

    def pack(fmt, values):
        return base64.b64encode(struct.pack(f"<{len(values)}{fmt}", *values)).decode("ascii")

    return {
        "statuses": STATUSES, "n": len(ids), "m": len(ts),
        "ids": pack("i", ids), "off": pack("i", off), "ts": pack("i", ts), "st": pack("B", st),
        "t_min": min(ts) if ts else None, "t_max": max(ts) if ts else None,
    }


@router.get("/objects/{object_id}/status-timeline")
def status_timeline(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        return build_timeline(conn, object_id)
    finally:
        conn.close()

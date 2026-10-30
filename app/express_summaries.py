"""Независимая рассылка сводок объекта нескольким контактам."""
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import activity, express_dialog, headcount
from app.access import assert_object_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection
from app.express_bot import BotxError

router = APIRouter(prefix="/objects/{object_id}/express/summary-schedules", tags=["express"])


class SummaryScheduleIn(BaseModel):
    contact_ids: list[int] = Field(min_length=1, max_length=100)
    weekdays: list[int] = Field(default_factory=lambda: [1, 2, 3, 4, 5])
    send_time: str = "12:30"
    day_offset: int = 0
    active: bool = True
    note: Optional[str] = None


def schedule_out(conn, row):
    item = dict(row)
    item["active"] = bool(row["active"])
    item["weekdays"] = [int(x) for x in row["weekdays"].split(",")]
    contacts = conn.execute("SELECT c.id, c.name FROM express_summary_recipients r JOIN express_contacts c ON c.id=r.contact_id WHERE r.schedule_id=? ORDER BY c.name", (row["id"],)).fetchall()
    item["contact_ids"] = [c["id"] for c in contacts]
    item["contact_names"] = [c["name"] for c in contacts]
    return item


@router.get("")
def list_summary_schedules(object_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "read")
        return [schedule_out(conn, r) for r in conn.execute("SELECT * FROM express_summary_schedules WHERE object_id=? ORDER BY send_time,id", (object_id,)).fetchall()]
    finally:
        conn.close()


def save_schedule(object_id, body, user, schedule_id=None):
    from app.express_scheduler import parse_hhmm
    days = sorted(set(body.weekdays))
    if not days or any(d not in range(1, 8) for d in days) or parse_hhmm(body.send_time) is None or body.day_offset not in (0, -1):
        raise HTTPException(status_code=400, detail="Проверьте дни недели, время ЧЧ:ММ и день сводки")
    ids = list(dict.fromkeys(body.contact_ids))
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        begin_write(conn)
        for cid in ids:
            if conn.execute("SELECT 1 FROM express_contacts WHERE id=? AND active=1", (cid,)).fetchone() is None:
                raise HTTPException(status_code=400, detail="Выберите действующих получателей из контактов бота")
        values = (",".join(map(str, days)), body.send_time, body.day_offset, int(body.active), (body.note or "").strip()[:300])
        if schedule_id is None:
            schedule_id = conn.execute("INSERT INTO express_summary_schedules (weekdays,send_time,day_offset,active,note,object_id) VALUES (?,?,?,?,?,?)", (*values, object_id)).lastrowid
        else:
            if conn.execute("SELECT 1 FROM express_summary_schedules WHERE id=? AND object_id=?", (schedule_id, object_id)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Расписание сводки не найдено")
            conn.execute("UPDATE express_summary_schedules SET weekdays=?,send_time=?,day_offset=?,active=?,note=?,effective_from=datetime('now') WHERE id=?", (*values, schedule_id))
            conn.execute("DELETE FROM express_summary_recipients WHERE schedule_id=?", (schedule_id,))
        conn.executemany("INSERT INTO express_summary_recipients (schedule_id,contact_id) VALUES (?,?)", [(schedule_id, cid) for cid in ids])
        result = schedule_out(conn, conn.execute("SELECT * FROM express_summary_schedules WHERE id=?", (schedule_id,)).fetchone())
        conn.commit()
    finally:
        conn.close()
    activity.log("express_schedule", user=user, entity_type="object", entity_id=object_id,
                 details={"действие": "сводка: расписание сохранено", "расписание": schedule_id, "получатели": ids})
    return result


@router.post("")
def create_summary_schedule(object_id: int, body: SummaryScheduleIn, user=Depends(get_current_user)):
    return save_schedule(object_id, body, user)


@router.patch("/{schedule_id}")
def update_summary_schedule(object_id: int, schedule_id: int, body: SummaryScheduleIn, user=Depends(get_current_user)):
    return save_schedule(object_id, body, user, schedule_id)


@router.delete("/{schedule_id}")
def delete_summary_schedule(object_id: int, schedule_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        begin_write(conn)
        if not conn.execute("DELETE FROM express_summary_schedules WHERE id=? AND object_id=?", (schedule_id, object_id)).rowcount:
            raise HTTPException(status_code=404, detail="Расписание сводки не найдено")
        conn.commit()
    finally:
        conn.close()
    activity.log("express_schedule", user=user, entity_type="object", entity_id=object_id,
                 details={"действие": "сводка: расписание удалено", "расписание": schedule_id})
    return {"deleted": schedule_id}


def dispatch(conn, now, stats):
    from app.express_scheduler import _moment, _utc, weekdays_of
    for schedule in conn.execute("SELECT * FROM express_summary_schedules WHERE active=1").fetchall():
        moment = _moment(now.date(), schedule["send_time"])
        if now.isoweekday() not in weekdays_of(schedule["weekdays"]) or moment is None or not moment <= now <= moment + timedelta(hours=3) or _utc(moment) < schedule["effective_from"]:
            continue
        recipients = conn.execute("SELECT c.* FROM express_summary_recipients r JOIN express_contacts c ON c.id=r.contact_id WHERE r.schedule_id=? AND c.active=1", (schedule["id"],)).fetchall()
        for contact in recipients:
            key = (schedule["id"], contact["id"], now.date().isoformat())
            conn.execute("INSERT OR IGNORE INTO express_summary_deliveries (schedule_id,contact_id,run_date) VALUES (?,?,?)", key)
            conn.commit()
            claimed = conn.execute("UPDATE express_summary_deliveries SET status='sending',attempts=attempts+1,last_attempt_at=? WHERE schedule_id=? AND contact_id=? AND run_date=? AND status IN ('pending','sending') AND attempts<5 AND (last_attempt_at IS NULL OR last_attempt_at<=?)",
                                   (_utc(now), *key, _utc(now-timedelta(minutes=5))))
            conn.commit()
            if not claimed.rowcount:
                continue
            try:
                work_date = (now.date()+timedelta(days=schedule["day_offset"])).isoformat()
                name = conn.execute("SELECT name FROM objects WHERE id=?", (schedule["object_id"],)).fetchone()[0]
                lines, workers, itr, mech = express_dialog.day_lines(conn, schedule["object_id"], work_date, limit=100000)
                header = f"Сводка: объект «{name}», {express_dialog._fmt_date(work_date)}. Обе смены.\nПодрядчик / Примечание / Рабочие / ИТР / Механизаторы"
                parts, chunk = [], header
                for line in lines or ["Численность за день не внесена."]:
                    if len(chunk)+len(line)>3000:
                        parts.append(chunk); chunk=header
                    chunk += "\n"+line
                parts.append(chunk+f"\nИтого: рабочие {workers}, ИТР {itr}, механизаторы {mech}.")
                for part in parts:
                    express_dialog._deliver(contact, None, part, None, "summary")
                conn.execute("UPDATE express_summary_deliveries SET status='sent',last_error=NULL WHERE schedule_id=? AND contact_id=? AND run_date=?", key)
                stats["summaries"] += 1
            except BotxError as exc:
                conn.execute("UPDATE express_summary_deliveries SET status='pending',last_error=? WHERE schedule_id=? AND contact_id=? AND run_date=?", (str(exc)[:500], *key))
            conn.commit()

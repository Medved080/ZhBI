"""Планировщик бота eXpress: по расписанию отправляет запросы, напоминания и сводки (2026-10-23, Docs/express-bot.md).

Один фоновый поток обходит расписания раз в `INTERVAL` секунд (`tick`). Время — московское, как и срок внесения численности
(`app/headcount.py`). Защита от дублей и «лавины после простоя»:

- пара (расписание, день) уникальна в БД — повторный обход и второй процесс (`--reload`) запрос не задвоят;
- срабатывание догоняется только в окно `CATCHUP` после назначенного времени: сервер, поднявшийся в три часа дня, не рассылает
  утренние запросы задним числом;
- расписание не срабатывает за моменты, которые были раньше `effective_from` (создание или правка времени/дней/включения): завели
  расписание в 11:00 на 10:30 — сегодня оно не сработает;
- напоминание и сводка «захватываются» атомарным UPDATE до отправки; неудача отправки напоминания или сводки не повторяется.

Неудачную отправку самого запроса (нет сети, контакт ещё не писал боту) планировщик повторяет до `MAX_ATTEMPTS` раз с паузой
`RETRY_PAUSE`, а когда контакт наконец напишет боту, ждущие запросы уходят сразу (`flush_waiting`).
"""

import threading
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Optional

from app import express_bot, express_dialog, headcount
from app.db import get_connection
from app.express_bot import BotxError, log_event

INTERVAL = 20
CATCHUP = timedelta(hours=1)
SUMMARY_CATCHUP = timedelta(hours=3)
RETRY_PAUSE = timedelta(minutes=5)
MAX_ATTEMPTS = 5
SECTIONS = ("headcount",)
_DB_FORMAT = "%Y-%m-%d %H:%M:%S"


def parse_hhmm(value: Optional[str]) -> Optional[dtime]:
    if not value:
        return None
    try:
        hour, minute = value.split(":")
        return dtime(int(hour), int(minute))
    except (ValueError, TypeError):
        return None


def _moment(day: date, hhmm: Optional[str]) -> Optional[datetime]:
    t = parse_hhmm(hhmm)
    return datetime.combine(day, t, tzinfo=headcount.MSK) if t else None


def _utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(_DB_FORMAT)


def weekdays_of(value: str) -> set:
    return {int(p) for p in (value or "").split(",") if p.strip().isdigit() and 1 <= int(p) <= 7}


def _run_day(work_date: str, day_offset: int) -> date:
    """День срабатывания расписания по дню, за который спрашивали: work_date = день срабатывания + смещение."""
    return date.fromisoformat(work_date) - timedelta(days=day_offset)


# ------------------------------------------------------------------ отправка запроса

def _attempt_send(conn, request_id: int, now: Optional[datetime] = None) -> bool:
    """Одна попытка отправить первое сообщение запроса. `now` — часы обхода (в проверках подставляются): пауза повтора считается по ним же."""
    stamp = _utc(now) if now is not None else _utc(headcount.now_msk())
    conn.execute("UPDATE express_requests SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?", (stamp, request_id))
    conn.commit()
    try:
        express_dialog.send_intro(request_id)
    except BotxError as exc:
        conn.execute("UPDATE express_requests SET status = 'failed', last_error = ? WHERE id = ? AND status IN ('pending', 'failed')",
                     (str(exc)[:500], request_id))
        conn.commit()
        return False
    conn.execute("UPDATE express_requests SET status = 'sent', sent_at = datetime('now'), last_error = NULL "
                 "WHERE id = ? AND status IN ('pending', 'failed')", (request_id,))
    conn.commit()
    return True


def create_manual(conn, object_id: int, contact_id: int, work_date: date, user_id: Optional[int]) -> int:
    """Ручная отправка запроса «прямо сейчас» (вне расписания). Возвращает номер запроса; результат отправки — в его статусе."""
    cur = conn.execute("INSERT INTO express_requests (schedule_id, object_id, contact_id, section, work_date, status, created_by) "
                       "VALUES (NULL, ?, ?, 'headcount', ?, 'pending', ?)", (object_id, contact_id, work_date.isoformat(), user_id))
    conn.commit()
    _attempt_send(conn, cur.lastrowid)
    return cur.lastrowid


def flush_waiting(contact_id: int) -> int:
    """Контакт написал боту впервые: отправить его запросы, не дошедшие из-за отсутствия чата."""
    conn = get_connection()
    try:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM express_requests WHERE contact_id = ? AND status IN ('pending', 'failed') AND created_at >= datetime('now', '-2 day')",
            (contact_id,))]
        return sum(1 for rid in ids if _attempt_send(conn, rid))
    finally:
        conn.close()


# ------------------------------------------------------------------ обход

def _dispatch_new(conn, now: datetime, stats: dict) -> None:
    today = now.date()
    for s in conn.execute(
            "SELECT s.* FROM express_schedules s JOIN express_contacts c ON c.id = s.contact_id "
            "WHERE s.active = 1 AND c.active = 1 AND s.section IN ({})".format(",".join("?" * len(SECTIONS))), SECTIONS).fetchall():
        if now.isoweekday() not in weekdays_of(s["weekdays"]):
            continue
        moment = _moment(today, s["send_time"])
        if moment is None or not (moment <= now <= moment + CATCHUP) or _utc(moment) < s["effective_from"]:
            continue
        work_date = (today + timedelta(days=s["day_offset"])).isoformat()
        cur = conn.execute("INSERT OR IGNORE INTO express_requests (schedule_id, object_id, contact_id, section, work_date, status) "
                           "VALUES (?, ?, ?, ?, ?, 'pending')", (s["id"], s["object_id"], s["contact_id"], s["section"], work_date))
        conn.commit()
        if cur.rowcount:
            stats["created"] += 1
            stats["sent" if _attempt_send(conn, cur.lastrowid, now) else "failed"] += 1


def _retry_failed(conn, now: datetime, stats: dict) -> None:
    border = _utc(now - RETRY_PAUSE)
    for r in conn.execute(
            "SELECT id FROM express_requests WHERE status IN ('pending', 'failed') AND attempts < ? AND created_at >= datetime('now', '-6 hour') "
            "AND (last_attempt_at IS NULL OR last_attempt_at <= ?)", (MAX_ATTEMPTS, border)).fetchall():
        stats["retried"] += 1
        stats["sent" if _attempt_send(conn, r["id"], now) else "failed"] += 1


def _due_today(conn, now: datetime, time_column: str, done_column: str, window: timedelta):
    """Запросы расписаний, у которых наступило время `time_column`, но ещё не отмечено `done_column` (и это не позже окна)."""
    today = now.date()
    out = []
    for r in conn.execute(
            f"SELECT q.id, q.work_date, q.status, s.day_offset, s.{time_column} AS at_time, s.summary_contact_id, s.send_time "
            f"FROM express_requests q JOIN express_schedules s ON s.id = q.schedule_id "
            f"WHERE s.active = 1 AND s.{time_column} IS NOT NULL AND q.{done_column} IS NULL AND q.work_date >= date(?, '-2 day')",
            (today.isoformat(),)).fetchall():
        if _run_day(r["work_date"], r["day_offset"]) != today:
            continue
        moment = _moment(today, r["at_time"])
        if moment is not None and moment <= now <= moment + window:
            out.append(r)
    return out


def _reminders(conn, now: datetime, stats: dict) -> None:
    for r in _due_today(conn, now, "remind_time", "reminded_at", CATCHUP):
        if r["status"] != "sent":
            continue                                         # ответил или закрыл — напоминать не о чем
        claimed = conn.execute("UPDATE express_requests SET reminded_at = datetime('now') WHERE id = ? AND reminded_at IS NULL AND status = 'sent'", (r["id"],))
        conn.commit()
        if not claimed.rowcount:
            continue
        try:
            express_dialog.send_reminder(r["id"])
            stats["reminded"] += 1
        except BotxError:
            pass                                             # причина уже в журнале обмена; напоминание не повторяем


def _summaries(conn, now: datetime, stats: dict) -> None:
    for r in _due_today(conn, now, "summary_time", "summary_at", SUMMARY_CATCHUP):
        if not r["summary_contact_id"]:
            continue
        claimed = conn.execute("UPDATE express_requests SET summary_at = datetime('now') WHERE id = ? AND summary_at IS NULL", (r["id"],))
        conn.commit()
        if not claimed.rowcount:
            continue
        try:
            express_dialog.send_summary(r["id"], r["summary_contact_id"])
            stats["summaries"] += 1
        except BotxError:
            pass


def tick(now: Optional[datetime] = None) -> dict:
    """Один обход. `now` — московское время (в проверках подставляется). Неактивный бот — ничего не делает."""
    stats = {"created": 0, "sent": 0, "failed": 0, "retried": 0, "reminded": 0, "summaries": 0}
    if not express_bot.is_active():
        return stats
    now = now or headcount.now_msk()
    conn = get_connection()
    try:
        _dispatch_new(conn, now, stats)
        _retry_failed(conn, now, stats)
        _reminders(conn, now, stats)
        _summaries(conn, now, stats)
    finally:
        conn.close()
    return stats


# ------------------------------------------------------------------ фоновый поток

def start_worker(interval: int = INTERVAL) -> threading.Event:
    stop = threading.Event()

    def run() -> None:
        stop.wait(15)                                        # старт сервера (миграции, обработки релиза) закончен раньше первого обхода
        last_prune: Optional[date] = None
        while not stop.is_set():
            try:
                tick()
                today = headcount.now_msk().date()
                if last_prune != today:
                    express_bot.prune_log()
                    last_prune = today
            except Exception as exc:                        # поток не должен умирать: ошибка — в журнал, следующий обход через интервал
                log_event("sys", "system", "Сбой планировщика", ok=False, error=f"{type(exc).__name__}: {exc}")
            stop.wait(interval)

    threading.Thread(target=run, name="express-scheduler", daemon=True).start()
    return stop

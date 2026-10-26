"""HTTP-интерфейс бота eXpress (2026-10-23, Docs/express-bot.md).

Два набора маршрутов.

1. Для CTS (сервера eXpress), БЕЗ сессии пользователя: `GET /status`, `POST /command`, `POST /notification/callback`. Защита —
   подпись JWT ключом бота (`express_bot.verify_incoming`): запрос без верной подписи отклоняется 401, ничего не читая из тела.
   На эти адреса CTS ходит по адресу бота, зарегистрированному в eXpress (http://pm-test.mcy-1.ru:8011 → …/command).
   Входящее обрабатывает ОДИН рабочий поток по очереди: CTS ждёт ответ на /command недолго (отвечаем 202 сразу), а порядок
   сообщений одному человеку не должен перемешиваться.
2. Для людей, под учётной записью: настройка подключения и ключа (раздел `express_admin`), контакты и расписания
   (раздел `express_bot`), журнал обмена.
"""

import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import activity, express_bot, express_dialog, express_scheduler, headcount
from app.access import assert_object_feature, require_service_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection
from app.express_bot import BotxError, log_event

webhook_router = APIRouter(tags=["express-webhook"])
router = APIRouter(prefix="/express", tags=["express"])
object_router = APIRouter(prefix="/objects/{object_id}/express", tags=["express"])

_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="express-dialog")

STATUS_COMMANDS = [
    {"description": "Начать работу и показать текущий запрос численности", "body": "/start", "name": "/start", "elements": []},
    {"description": "Как со мной работать", "body": "/help", "name": "/help", "elements": []},
]
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_HHMM = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


# ------------------------------------------------------------------ CTS → бот

def _verify(request: Request) -> Optional[JSONResponse]:
    try:
        express_bot.verify_incoming(request.headers.get("authorization"))
    except BotxError as exc:
        # В журнале видно, ЧТО пришло: метод и адрес, откуда (ip), что написано в токене. Так «бот не отвечает» разбирается без догадок.
        log_event("in", "system", f"{request.method} {request.url.path} от {request.client.host if request.client else '?'}; "
                  f"{express_bot.describe_token(request.headers.get('authorization'))}", ok=False, error=str(exc))
        return JSONResponse(status_code=exc.status or 403, content={"status": "error", "reason": str(exc)})
    return None


@webhook_router.get("/status")
def bot_status(request: Request):
    denied = _verify(request)
    if denied is not None:
        return denied
    log_event("in", "system", "GET /status — CTS спрашивает состояние бота")      # запись о ДОШЕДШЕМ запросе: нет записей вообще — CTS до сервиса не достучался
    return {"status": "ok", "result": {"enabled": True, "status_message": "Бот собирает численность по объектам", "commands": STATUS_COMMANDS}}


@webhook_router.post("/command", status_code=202)
async def bot_command(request: Request):
    denied = _verify(request)
    if denied is not None:
        return denied
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse(status_code=400, content={"status": "error", "reason": "Тело запроса не разобрано"})
    if isinstance(payload, dict):
        _worker.submit(express_dialog.handle_incoming, payload)
    return {"result": "accepted"}


@webhook_router.post("/notification/callback")
async def bot_callback(request: Request):
    # Результат асинхронного метода BotX. В примере администраторов (pybotx) подпись этих запросов не проверяется: CTS может слать их без токена,
    # поэтому отказ 401 тут только мешал бы. Подписанный запрос попадает в журнал как есть, неподписанный — коротким предупреждением без содержимого.
    try:
        express_bot.verify_incoming(request.headers.get("authorization"))
        signed = True
    except BotxError:
        signed = False
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    if not signed:
        log_event("in", "system", f"POST /notification/callback без верной подписи от {request.client.host if request.client else '?'} (принят, содержимое не разбиралось)", ok=False,
                  error="подпись не подтверждена")
    elif isinstance(payload, dict) and payload.get("status") == "error":
        log_event("in", "system", f"callback sync_id={payload.get('sync_id')}", ok=False, error=str(payload.get("reason") or payload.get("errors") or "ошибка доставки")[:300])
    return {"result": "accepted"}


# ------------------------------------------------------------------ подключение и ключ

class ConfigIn(BaseModel):
    enabled: bool = False
    cts_url: str = ""
    bot_id: str = ""
    bot_name: str = ""
    verify_tls: bool = True


class KeyIn(BaseModel):
    key: str = Field(min_length=1, max_length=400)


@router.get("/config")
def get_config(user: sqlite3.Row = Depends(require_service_feature("express_admin", "read"))):
    conn = get_connection()
    try:
        cfg = express_bot.config_public(conn)
    finally:
        conn.close()
    cfg["webhooks"] = ["POST /command", "GET /status", "POST /notification/callback"]
    return cfg


@router.get("/status")
def bot_state(user: sqlite3.Row = Depends(require_service_feature("express_bot", "read"))):
    """Для экрана расписаний: работает ли бот (без адреса сервера и прочих реквизитов — их видит только администратор)."""
    cfg = express_bot.config_public()
    return {"active": express_bot.is_active(), "enabled": cfg["enabled"], "ready": cfg["ready"], "bot_name": cfg["bot_name"]}


@router.put("/config")
def put_config(body: ConfigIn, user: sqlite3.Row = Depends(require_service_feature("express_admin", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        try:
            cfg = express_bot.save_config(conn, body.model_dump(), user["id"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        conn.commit()
    finally:
        conn.close()
    activity.log("express_config", user=user, details={"включён": cfg["enabled"], "сервер": cfg["cts_url"], "бот": cfg["bot_name"] or cfg["bot_id"]})
    return get_config(user)


@router.put("/key")
def put_key(body: KeyIn, user: sqlite3.Row = Depends(require_service_feature("express_admin", "write"))):
    try:
        express_bot.set_secret(body.key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    activity.log("express_key", user=user, details={"действие": "задан"})       # сам ключ в журнал не попадает никогда
    return {"secret_configured": True}


@router.delete("/key")
def delete_key(user: sqlite3.Row = Depends(require_service_feature("express_admin", "write"))):
    express_bot.clear_secret()
    conn = get_connection()
    try:
        conn.execute("UPDATE express_config SET enabled = 0 WHERE id = 1")      # без ключа бот работать не может
        conn.commit()
    finally:
        conn.close()
    activity.log("express_key", user=user, details={"действие": "удалён"})
    return {"secret_configured": False}


@router.post("/test")
def test_connection(user: sqlite3.Row = Depends(require_service_feature("express_admin", "write"))):
    """Проверка связи: бот получает токен у CTS. Ничего никому не отправляется."""
    try:
        result = express_bot.ping()
    except BotxError as exc:
        activity.log("express_test", user=user, details={"результат": "ошибка", "причина": str(exc)})
        log_event("sys", "test", "Проверка связи", ok=False, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc))
    activity.log("express_test", user=user, details={"результат": "связь есть"})
    log_event("sys", "test", "Проверка связи")
    return result


@router.get("/log")
def get_log(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0), only_errors: bool = False,
            user: sqlite3.Row = Depends(require_service_feature("express_admin", "read"))):
    conn = get_connection()
    try:
        where = "WHERE l.ok = 0" if only_errors else ""
        rows = conn.execute(
            f"SELECT l.*, c.name AS contact_name FROM express_log l LEFT JOIN express_contacts c ON c.id = l.contact_id {where} "
            "ORDER BY l.id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        total = conn.execute(f"SELECT COUNT(*) FROM express_log l {where}").fetchone()[0]
    finally:
        conn.close()
    return {"total": total, "items": [dict(r) for r in rows]}


# ------------------------------------------------------------------ контакты

class ContactIn(BaseModel):
    individual_id: Optional[int] = None
    name: Optional[str] = None
    email: Optional[str] = None
    ad_login: Optional[str] = None
    phone: Optional[str] = None
    active: bool = True


def _contact_out(row) -> dict:
    return {"id": row["id"], "individual_id": row["individual_id"], "name": row["name"], "email": row["email"], "ad_login": row["ad_login"],
            "phone": row["phone"], "code_active": bool(row["bind_code_hash"]) and bool(row["code_live"]), "code_expires": row["bind_code_expires"] if row["code_live"] else None,
            "bound": bool(row["chat_id"]), "recognized": bool(row["user_huid"]), "bound_at": row["bound_at"], "active": bool(row["active"]),
            "schedules": row["schedules"] if "schedules" in row.keys() else None}


def _clean_contact(conn, body: ContactIn, exclude_id: Optional[int] = None) -> dict:
    name = " ".join((body.name or "").split())
    if body.individual_id is not None:
        ind = conn.execute("SELECT id, name FROM individuals WHERE id = ?", (body.individual_id,)).fetchone()
        if ind is None:
            raise HTTPException(status_code=400, detail="Физлицо не найдено в справочнике")
        name = name or ind["name"]
        dup = conn.execute("SELECT id FROM express_contacts WHERE individual_id = ? AND id IS NOT ?", (body.individual_id, exclude_id)).fetchone()
        if dup is not None:
            raise HTTPException(status_code=409, detail="Для этого физлица контакт уже заведён")
    if not name:
        raise HTTPException(status_code=400, detail="Укажите ФИО контакта или выберите физлицо из справочника")
    email = (body.email or "").strip() or None
    if email and not _EMAIL.fullmatch(email):
        raise HTTPException(status_code=400, detail="E-mail: ожидается адрес вида имя@домен")
    login = (body.ad_login or "").strip() or None
    if login and "\\" in login:
        login = login.split("\\")[-1]                       # «DOMAIN\ivanov» → «ivanov»
    if login and "@" in login:
        login = login.split("@")[0]
    phone = " ".join((body.phone or "").split()) or None
    if phone and (len(phone) > 30 or not re.fullmatch(r"[0-9+\-() ]+", phone)):
        raise HTTPException(status_code=400, detail="Телефон: только цифры, +, -, пробелы и скобки, не длиннее 30 знаков")
    return {"individual_id": body.individual_id, "name": name[:200], "email": email, "ad_login": login, "phone": phone, "active": 1 if body.active else 0}


_CONTACT_SELECT = ("SELECT c.*, (SELECT COUNT(*) FROM express_schedules s WHERE s.contact_id = c.id) AS schedules, "
                   "(c.bind_code_expires > datetime('now')) AS code_live FROM express_contacts c ")


@router.get("/contacts")
def list_contacts(user: sqlite3.Row = Depends(require_service_feature("express_bot", "read"))):
    conn = get_connection()
    try:
        rows = conn.execute(_CONTACT_SELECT + "ORDER BY c.name COLLATE NOCASE").fetchall()
    finally:
        conn.close()
    return [_contact_out(r) for r in rows]


@router.post("/contacts")
def create_contact(body: ContactIn, user: sqlite3.Row = Depends(require_service_feature("express_bot", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        c = _clean_contact(conn, body)
        cur = conn.execute("INSERT INTO express_contacts (individual_id, name, email, ad_login, phone, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (c["individual_id"], c["name"], c["email"], c["ad_login"], c["phone"], c["active"], user["id"]))
        conn.commit()
        row = conn.execute(_CONTACT_SELECT + "WHERE c.id = ?", (cur.lastrowid,)).fetchone()
    finally:
        conn.close()
    activity.log("express_contact", user=user, entity_type="express_contact", entity_id=row["id"], new_value=row["name"], details={"действие": "добавлен"})
    return _contact_out(row)


@router.patch("/contacts/{contact_id}")
def update_contact(contact_id: int, body: ContactIn, user: sqlite3.Row = Depends(require_service_feature("express_bot", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        old = conn.execute("SELECT * FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()
        if old is None:
            raise HTTPException(status_code=404, detail="Контакт не найден")
        c = _clean_contact(conn, body, exclude_id=contact_id)
        # Сменили e-mail или логин — прежнее сопоставление с eXpress больше не доказано: контакт опознаётся заново.
        reset = (c["email"] != old["email"] or c["ad_login"] != old["ad_login"]) and not old["chat_id"]
        conn.execute("UPDATE express_contacts SET individual_id = ?, name = ?, email = ?, ad_login = ?, phone = ?, active = ?, "
                     "user_huid = CASE WHEN ? THEN NULL ELSE user_huid END, updated_at = datetime('now') WHERE id = ?",
                     (c["individual_id"], c["name"], c["email"], c["ad_login"], c["phone"], c["active"], 1 if reset else 0, contact_id))
        conn.commit()
        row = conn.execute(_CONTACT_SELECT + "WHERE c.id = ?", (contact_id,)).fetchone()
    finally:
        conn.close()
    activity.log("express_contact", user=user, entity_type="express_contact", entity_id=contact_id, new_value=row["name"], details={"действие": "изменён"})
    return _contact_out(row)


@router.delete("/contacts/{contact_id}")
def delete_contact(contact_id: int, user: sqlite3.Row = Depends(require_service_feature("express_admin", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        row = conn.execute("SELECT name FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Контакт не найден")
        conn.execute("DELETE FROM express_contacts WHERE id = ?", (contact_id,))
        conn.commit()
    finally:
        conn.close()
    activity.log("express_contact_delete", user=user, entity_type="express_contact", entity_id=contact_id, old_value=row["name"])
    return {"deleted": contact_id}


@router.post("/contacts/{contact_id}/lookup")
def lookup_contact(contact_id: int, user: sqlite3.Row = Depends(require_service_feature("express_bot", "write"))):
    """Найти контакта в eXpress по e-mail и запомнить его идентификатор: так бот опознает его по первому же сообщению."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Контакт не найден")
        if not row["email"]:
            raise HTTPException(status_code=400, detail="У контакта не указан e-mail: искать в eXpress не по чему")
        try:
            found = express_bot.find_user_by_email(row["email"])
        except BotxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        if not found or not found.get("user_huid"):
            raise HTTPException(status_code=404, detail="В eXpress пользователя с таким e-mail не нашли")
        taken = conn.execute("SELECT name FROM express_contacts WHERE lower(user_huid) = ? AND id != ?", (found["user_huid"].lower(), contact_id)).fetchone()
        if taken is not None:
            raise HTTPException(status_code=409, detail=f"Этот пользователь eXpress уже сопоставлен с контактом «{taken['name']}»")
        conn.execute("UPDATE express_contacts SET user_huid = ?, ad_login = COALESCE(ad_login, ?), updated_at = datetime('now') WHERE id = ?",
                     (found["user_huid"], found.get("ad_login"), contact_id))
        conn.commit()
        out = conn.execute(_CONTACT_SELECT + "WHERE c.id = ?", (contact_id,)).fetchone()
    finally:
        conn.close()
    return {**_contact_out(out), "express_name": found.get("name")}


@router.post("/contacts/{contact_id}/bind-code")
def issue_bind_code(contact_id: int, user: sqlite3.Row = Depends(require_service_feature("express_bot", "write"))):
    """Одноразовый код привязки контакта: человек отправляет боту `/start КОД`, и бот запоминает его аккаунт eXpress и личный чат — без e-mail, доменного
    логина и поиска. Действует сутки, прежний код отменяется, сам код в БД не хранится (только sha256) и показывается один раз — в ответе на этот запрос."""
    conn = get_connection()
    try:
        begin_write(conn)
        row = conn.execute("SELECT id, name, active FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Контакт не найден")
        if not row["active"]:
            raise HTTPException(status_code=400, detail="Контакт отключён: включите его, чтобы выдать код")
        code, expires = express_dialog.issue_code(conn, contact_id)
    finally:
        conn.close()
    activity.log("express_bind_code", user=user, entity_type="express_contact", entity_id=contact_id, new_value=row["name"], details={"действие": "выдан код привязки"})   # сам код в журнал не пишется
    return {"code": code, "expires": expires, "hours": express_dialog.CODE_HOURS}


# ------------------------------------------------------------------ расписания

class ScheduleIn(BaseModel):
    contact_id: int
    weekdays: list[int] = Field(default_factory=lambda: [1, 2, 3, 4, 5])
    send_time: str = "10:30"
    day_offset: int = 0
    remind_time: Optional[str] = None
    summary_time: Optional[str] = None
    summary_contact_id: Optional[int] = None
    active: bool = True
    note: Optional[str] = None


def _next_run(row, now: Optional[datetime] = None) -> Optional[str]:
    now = now or headcount.now_msk()
    days = express_scheduler.weekdays_of(row["weekdays"])
    if not row["active"] or not days:
        return None
    for shift in range(0, 9):
        day = now.date() + timedelta(days=shift)
        moment = express_scheduler._moment(day, row["send_time"])
        if day.isoweekday() in days and moment is not None and moment > now:
            return moment.isoformat()
    return None


def _schedule_out(row) -> dict:
    return {"id": row["id"], "object_id": row["object_id"], "section": row["section"], "contact_id": row["contact_id"], "contact_name": row["contact_name"],
            "contact_bound": bool(row["contact_chat"]), "weekdays": sorted(express_scheduler.weekdays_of(row["weekdays"])), "send_time": row["send_time"],
            "day_offset": row["day_offset"], "remind_time": row["remind_time"], "summary_time": row["summary_time"],
            "summary_contact_id": row["summary_contact_id"], "summary_contact_name": row["summary_name"], "active": bool(row["active"]),
            "note": row["note"], "next_run": _next_run(row)}


_SCHEDULE_SELECT = ("SELECT s.*, c.name AS contact_name, c.chat_id AS contact_chat, sc.name AS summary_name FROM express_schedules s "
                    "JOIN express_contacts c ON c.id = s.contact_id LEFT JOIN express_contacts sc ON sc.id = s.summary_contact_id ")


def _clean_schedule(conn, body: ScheduleIn) -> dict:
    days = sorted(set(body.weekdays))
    if not days or any(d < 1 or d > 7 for d in days):
        raise HTTPException(status_code=400, detail="Выберите хотя бы один день недели")
    if not _HHMM.fullmatch(body.send_time or ""):
        raise HTTPException(status_code=400, detail="Время отправки: ожидается ЧЧ:ММ")
    if body.day_offset not in (0, -1):
        raise HTTPException(status_code=400, detail="Спрашивать можно за сегодня или за вчера")
    for label, value in (("напоминания", body.remind_time), ("сводки", body.summary_time)):
        if value:
            if not _HHMM.fullmatch(value):
                raise HTTPException(status_code=400, detail=f"Время {label}: ожидается ЧЧ:ММ")
            if value <= body.send_time:
                raise HTTPException(status_code=400, detail=f"Время {label} должно быть позже времени отправки")
    if body.summary_time and body.remind_time and body.summary_time <= body.remind_time:
        raise HTTPException(status_code=400, detail="Сводка должна идти после напоминания")
    if body.summary_time and not body.summary_contact_id:
        raise HTTPException(status_code=400, detail="Для сводки выберите, кому её отправлять")
    for cid in {body.contact_id, body.summary_contact_id} - {None}:
        if conn.execute("SELECT 1 FROM express_contacts WHERE id = ?", (cid,)).fetchone() is None:
            raise HTTPException(status_code=400, detail="Контакт не найден")
    contact = conn.execute("SELECT active FROM express_contacts WHERE id = ?", (body.contact_id,)).fetchone()
    if body.active and not contact["active"]:
        raise HTTPException(status_code=400, detail="Контакт отключён: включите его или выберите другого")
    return {"contact_id": body.contact_id, "weekdays": ",".join(map(str, days)), "send_time": body.send_time, "day_offset": body.day_offset,
            "remind_time": body.remind_time or None, "summary_time": body.summary_time or None,
            "summary_contact_id": body.summary_contact_id if body.summary_time else None,
            "active": 1 if body.active else 0, "note": (body.note or "").strip()[:300] or None}


@object_router.get("/schedules")
def list_schedules(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "read")
        rows = conn.execute(_SCHEDULE_SELECT + "WHERE s.object_id = ? ORDER BY s.send_time, s.id", (object_id,)).fetchall()
    finally:
        conn.close()
    return [_schedule_out(r) for r in rows]


@object_router.post("/schedules")
def create_schedule(object_id: int, body: ScheduleIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        begin_write(conn)
        c = _clean_schedule(conn, body)
        cur = conn.execute(
            "INSERT INTO express_schedules (object_id, contact_id, weekdays, send_time, day_offset, remind_time, summary_time, summary_contact_id, "
            "active, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (object_id, c["contact_id"], c["weekdays"], c["send_time"], c["day_offset"], c["remind_time"], c["summary_time"],
             c["summary_contact_id"], c["active"], c["note"], user["id"]))
        conn.commit()
        row = conn.execute(_SCHEDULE_SELECT + "WHERE s.id = ?", (cur.lastrowid,)).fetchone()
    finally:
        conn.close()
    activity.log("express_schedule", user=user, entity_type="object", entity_id=object_id, new_value=f"{row['contact_name']} {row['send_time']}", details={"действие": "добавлено"})
    return _schedule_out(row)


@object_router.patch("/schedules/{schedule_id}")
def update_schedule(object_id: int, schedule_id: int, body: ScheduleIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        begin_write(conn)
        old = conn.execute("SELECT * FROM express_schedules WHERE id = ? AND object_id = ?", (schedule_id, object_id)).fetchone()
        if old is None:
            raise HTTPException(status_code=404, detail="Расписание не найдено")
        c = _clean_schedule(conn, body)
        # Менялись время, дни, адресат или включение — срабатывания «задним числом» не догоняем (см. express_scheduler).
        moved = (c["send_time"], c["weekdays"], c["day_offset"], c["active"], c["contact_id"]) != \
                (old["send_time"], old["weekdays"], old["day_offset"], old["active"], old["contact_id"])
        conn.execute(
            "UPDATE express_schedules SET contact_id = ?, weekdays = ?, send_time = ?, day_offset = ?, remind_time = ?, summary_time = ?, "
            "summary_contact_id = ?, active = ?, note = ?, updated_at = datetime('now'), "
            "effective_from = CASE WHEN ? THEN datetime('now') ELSE effective_from END WHERE id = ?",
            (c["contact_id"], c["weekdays"], c["send_time"], c["day_offset"], c["remind_time"], c["summary_time"], c["summary_contact_id"],
             c["active"], c["note"], 1 if moved else 0, schedule_id))
        conn.commit()
        row = conn.execute(_SCHEDULE_SELECT + "WHERE s.id = ?", (schedule_id,)).fetchone()
    finally:
        conn.close()
    activity.log("express_schedule", user=user, entity_type="object", entity_id=object_id, new_value=f"{row['contact_name']} {row['send_time']}", details={"действие": "изменено"})
    return _schedule_out(row)


@object_router.delete("/schedules/{schedule_id}")
def delete_schedule(object_id: int, schedule_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        begin_write(conn)
        row = conn.execute(_SCHEDULE_SELECT + "WHERE s.id = ? AND s.object_id = ?", (schedule_id, object_id)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Расписание не найдено")
        conn.execute("DELETE FROM express_schedules WHERE id = ?", (schedule_id,))
        conn.commit()
    finally:
        conn.close()
    activity.log("express_schedule_delete", user=user, entity_type="object", entity_id=object_id, old_value=f"{row['contact_name']} {row['send_time']}")
    return {"deleted": schedule_id}


# ------------------------------------------------------------------ запросы по объекту

class SendNowIn(BaseModel):
    contact_id: int
    date: Optional[str] = None


@object_router.get("/requests")
def list_requests(object_id: int, days: int = Query(14, ge=1, le=90), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "read")
        since = (headcount.now_msk().date() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT q.*, c.name AS contact_name FROM express_requests q JOIN express_contacts c ON c.id = q.contact_id "
            "WHERE q.object_id = ? AND q.work_date >= ? ORDER BY q.work_date DESC, q.id DESC", (object_id, since)).fetchall()
        out = []
        for q in rows:
            lines, workers, itr, mech = express_dialog.day_lines(conn, object_id, q["work_date"], limit=0)
            out.append({"id": q["id"], "schedule_id": q["schedule_id"], "work_date": q["work_date"], "contact_id": q["contact_id"],
                        "contact_name": q["contact_name"], "status": q["status"], "manual": q["schedule_id"] is None,
                        "sent_at": q["sent_at"], "reminded_at": q["reminded_at"], "answered_at": q["answered_at"], "closed_at": q["closed_at"],
                        "attempts": q["attempts"], "last_error": q["last_error"], "workers": workers, "itr": itr, "mech": mech})
    finally:
        conn.close()
    return out


@object_router.post("/send-now")
def send_now(object_id: int, body: SendNowIn, user: sqlite3.Row = Depends(get_current_user)):
    if not express_bot.is_active():
        raise HTTPException(status_code=409, detail="Бот eXpress выключен или не настроен: включите его в «Администрировании»")
    try:
        work_date = date.fromisoformat(body.date) if body.date else headcount.now_msk().date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Дата: ожидается ГГГГ-ММ-ДД")
    if work_date > headcount.now_msk().date():
        raise HTTPException(status_code=400, detail="Спрашивать численность за будущую дату нельзя")
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "express_bot", "write")
        contact = conn.execute("SELECT * FROM express_contacts WHERE id = ?", (body.contact_id,)).fetchone()
        if contact is None or not contact["active"]:
            raise HTTPException(status_code=400, detail="Контакт не найден или отключён")
        request_id = express_scheduler.create_manual(conn, object_id, body.contact_id, work_date, user["id"])
        row = conn.execute("SELECT status, last_error FROM express_requests WHERE id = ?", (request_id,)).fetchone()
    finally:
        conn.close()
    activity.log("express_send_now", user=user, entity_type="object", entity_id=object_id, new_value=work_date.isoformat(),
                 details={"контакт": contact["name"], "результат": row["status"]})
    return {"request_id": request_id, "status": row["status"], "error": row["last_error"]}

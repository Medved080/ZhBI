"""Диалог бота eXpress с контактом: запрос численности по объекту (2026-10-23, Docs/express-bot.md).

Как выглядит разговор. Бот присылает сообщение «Объект …, нужна численность за такой-то день» с кнопкой «Внести численность».
Дальше кнопки: подрядчик объекта → вид работ (недавние по этому подрядчику или поиск по названию/коду) → число рабочих → число
ИТР. КАЖДАЯ строка пишется в `headcount_records` сразу (источник `bot`), а не пакетом в конце: если человек бросил диалог на
середине, внесённое не пропадает. «Готово» закрывает запрос. Повторный ввод того же подрядчика и вида работ заменяет число — как в
форме, прежнее остаётся в истории.

Состояние диалога — JSON в `express_requests.dialog` (шаг и выбранное), поэтому переживает перезапуск сервера. Кнопки несут номер
запроса: нажатие на кнопку закрытого или чужого запроса отклоняется, а не пишет в чужой день.

Права. Прав в системе у контакта нет и быть не должно: он может вносить численность ТОЛЬКО по объекту и за день своего запроса —
это записано в самом запросе, а не берётся из слов контакта.
"""

import json
import re
import sqlite3
import time
from datetime import date, datetime
from typing import Optional

from app import express_bot, headcount
from app.db import get_connection
from app.express_bot import BotxError, button, log_event

PAGE = 8
MAX_LABEL = 52
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
OPEN_STATUSES = ("sent", "answered")
HELP_TEXT = ("Я спрашиваю численность по объектам и записываю ответ в систему.\n"
             "Когда придёт запрос, нажмите «Внести численность» и выбирайте кнопками: подрядчик → вид работ → рабочие → ИТР.\n"
             "Команды: /start — начать или показать текущий запрос, /help — эта справка.")


# ------------------------------------------------------------------ вспомогательное

def _fmt_date(work_date: str) -> str:
    d = date.fromisoformat(work_date)
    return f"{d.strftime('%d.%m.%Y')} ({WEEKDAYS[d.weekday()]})"


def _short(text: str, limit: int = MAX_LABEL) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _contractor_label(row) -> str:
    name = row["name_raw"] or row["counterparty_name"]
    if name and row["inn_raw"]:
        return _short(f"{name} · {row['inn_raw']}")
    return _short(name or (f"ИНН {row['inn_raw']}" if row["inn_raw"] else f"Подрядчик №{row['id']}"))


def _load_dialog(row) -> dict:
    try:
        data = json.loads(row["dialog"] or "{}")
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _store_dialog(conn, request_id: int, dialog: dict) -> None:
    dialog["ts"] = time.time()
    conn.execute("UPDATE express_requests SET dialog = ? WHERE id = ?", (json.dumps(dialog, ensure_ascii=False), request_id))


def _request(conn, request_id: int):
    return conn.execute(
        "SELECT r.*, o.name AS object_name FROM express_requests r JOIN objects o ON o.id = r.object_id WHERE r.id = ?",
        (request_id,)).fetchone()


def _contact(conn, contact_id: int):
    return conn.execute("SELECT * FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()


def _deliver(contact, request_id: Optional[int], text: str, bubble: Optional[list], kind: str) -> None:
    """Отправить и записать в журнал; сбой — BotxError наружу (планировщик по нему повторяет отправку)."""
    if not contact["chat_id"]:
        err = "Контакт ещё не писал боту: пусть откроет бота в eXpress и отправит /start"
        log_event("out", kind, text, contact_id=contact["id"], request_id=request_id, ok=False, error=err)
        raise BotxError(err, retryable=True, reason="chat_not_found")
    try:
        express_bot.send_message(contact["chat_id"], text, bubble)
    except BotxError as exc:
        log_event("out", kind, text, contact_id=contact["id"], request_id=request_id, ok=False, error=str(exc))
        raise
    log_event("out", kind, text, contact_id=contact["id"], request_id=request_id)


def _say(contact, request_id: Optional[int], text: str, bubble: Optional[list] = None, kind: str = "reply") -> None:
    """Ответ внутри диалога: сбой только пишется в журнал — отвечать на него больше нечем."""
    try:
        _deliver(contact, request_id, text, bubble, kind)
    except BotxError:
        pass


# ------------------------------------------------------------------ тексты и экраны

def day_lines(conn, object_id: int, work_date: str, limit: int = 12):
    """Что за день уже внесено по объекту: (строки текста, рабочих, ИТР)."""
    rows = conn.execute(
        "SELECT c.name_raw, c.inn_raw, c.id AS cid, w.code, w.name AS wname, r.workers, r.itr, cp.short_name AS cp_short, cp.full_name AS cp_full "
        "FROM headcount_records r JOIN headcount_contractors c ON c.id = r.contractor_id JOIN work_codifier w ON w.id = r.codifier_id "
        "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE r.object_id = ? AND r.work_date = ? ORDER BY c.name_raw, w.code",
        (object_id, work_date)).fetchall()
    lines = []
    for r in rows[:limit]:
        who = r["name_raw"] or r["cp_short"] or r["cp_full"] or (f"ИНН {r['inn_raw']}" if r["inn_raw"] else f"№{r['cid']}")
        lines.append(f"• {_short(who, 36)} · {_short(r['code'] + ' ' + r['wname'], 40)}: рабочие {r['workers']}, ИТР {r['itr']}")
    if len(rows) > limit:
        lines.append(f"… и ещё {len(rows) - limit}")
    return lines, sum(r["workers"] for r in rows), sum(r["itr"] for r in rows)


def intro(conn, request_id: int):
    req = _request(conn, request_id)
    deadline = headcount.deadline_for(date.fromisoformat(req["work_date"]))
    text = (f"Здравствуйте! Объект «{req['object_name']}».\n"
            f"Нужна численность за {_fmt_date(req['work_date'])}. Срок внесения — до {deadline.strftime('%H:%M %d.%m')}.")
    bubble = [[button("Внести численность", {"a": "menu", "r": request_id})],
              [button("Вносить нечего", {"a": "close", "r": request_id})]]
    return text, bubble


def _menu(conn, req, page: int = 0):
    contractors = conn.execute(
        "SELECT c.*, COALESCE(cp.short_name, cp.full_name) AS counterparty_name, "
        "(SELECT COUNT(*) FROM headcount_records r WHERE r.contractor_id = c.id AND r.work_date >= date(?, '-30 day')) AS recent "
        "FROM headcount_contractors c LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE c.object_id = ?",
        (req["work_date"], req["object_id"])).fetchall()
    contractors = sorted(contractors, key=lambda c: (-c["recent"], (c["name_raw"] or c["counterparty_name"] or "").lower()))
    lines, workers, itr = day_lines(conn, req["object_id"], req["work_date"])
    head = f"Объект «{req['object_name']}», {_fmt_date(req['work_date'])}."
    if lines:
        head += "\nВнесено за день:\n" + "\n".join(lines) + f"\nИтого: рабочие {workers}, ИТР {itr}."
    else:
        head += "\nПока ничего не внесено."
    if not contractors:
        text = head + "\n\nУ объекта нет подрядчиков. Добавьте их в системе (вкладка «Подрядчики» учёта численности) и вернитесь сюда."
        return text, [[button("Готово", {"a": "close", "r": req["id"]})]]
    pages = (len(contractors) + PAGE - 1) // PAGE
    page = max(0, min(page, pages - 1))
    bubble = [[button(_contractor_label(c), {"a": "con", "r": req["id"], "c": c["id"]})] for c in contractors[page * PAGE:(page + 1) * PAGE]]
    nav = []
    if page > 0:
        nav.append(button("‹ Назад", {"a": "menu", "r": req["id"], "p": page - 1}))
    if page < pages - 1:
        nav.append(button("Далее ›", {"a": "menu", "r": req["id"], "p": page + 1}))
    if nav:
        bubble.append(nav)
    bubble.append([button("Готово", {"a": "close", "r": req["id"]})])
    return head + ("\n\nВыберите подрядчика" + (f" (стр. {page + 1} из {pages})" if pages > 1 else "") + ":"), bubble


def _recent_works(conn, req, contractor_id: int):
    return conn.execute(
        "SELECT w.id, w.code, w.name, COUNT(*) AS n FROM headcount_records r JOIN work_codifier w ON w.id = r.codifier_id "
        "WHERE r.object_id = ? AND r.contractor_id = ? AND r.work_date >= date(?, '-60 day') AND w.retired_at IS NULL "
        "GROUP BY w.id ORDER BY n DESC, w.code LIMIT 6", (req["object_id"], contractor_id, req["work_date"])).fetchall()


def _contractor_row(conn, req, contractor_id: int):
    return conn.execute(
        "SELECT c.*, COALESCE(cp.short_name, cp.full_name) AS counterparty_name FROM headcount_contractors c "
        "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE c.id = ? AND c.object_id = ?", (contractor_id, req["object_id"])).fetchone()


def _work_screen(conn, req, contractor_id: int):
    contractor = _contractor_row(conn, req, contractor_id)
    works = _recent_works(conn, req, contractor_id)
    text = f"Подрядчик: {_contractor_label(contractor)}.\n"
    text += "Выберите вид работ или найдите его по названию или коду." if works else "Напишите часть названия или код вида работ — я найду."
    bubble = [[button(_short(f"{w['code']} {w['name']}"), {"a": "work", "r": req["id"], "w": w["id"]})] for w in works]
    bubble.append([button("Найти по названию или коду", {"a": "search", "r": req["id"]})])
    bubble.append([button("‹ К подрядчикам", {"a": "menu", "r": req["id"]})])
    return text, bubble


def search_works(conn, query: str, limit: int = 8):
    """Действующие виды работ, у которых в коде или названии есть запрос (без учёта регистра — в Python, SQLite кириллицу не сравнивает)."""
    needle = " ".join(query.lower().split())
    if not needle:
        return [], 0
    found = [w for w in conn.execute("SELECT id, code, name FROM work_codifier WHERE retired_at IS NULL ORDER BY sort_order, code")
             if needle in (w["code"] or "").lower() or needle in (w["name"] or "").lower()]
    return found[:limit], len(found)


def _existing_text(conn, req, contractor_id: int, codifier_id: int) -> str:
    cur = conn.execute("SELECT workers, itr FROM headcount_records WHERE object_id = ? AND work_date = ? AND contractor_id = ? AND codifier_id = ?",
                       (req["object_id"], req["work_date"], contractor_id, codifier_id)).fetchone()
    return f"\nСейчас внесено: рабочие {cur['workers']}, ИТР {cur['itr']}. Новое значение заменит прежнее." if cur else ""


# ------------------------------------------------------------------ ввод чисел

_NUMBER = re.compile(r"\s*(\d{1,6})\s*")


def parse_count(text: str) -> Optional[int]:
    m = _NUMBER.fullmatch(text or "")
    if not m:
        return None
    value = int(m.group(1))
    return value if 0 <= value <= headcount.MAX_WORKERS else None


# ------------------------------------------------------------------ обработка входящих

def identify(conn, sender: dict) -> Optional[sqlite3.Row]:
    """Контакт по отправителю. Сначала по user_huid, затем по доменному логину (контакт, заведённый до первого сообщения боту)."""
    huid = (sender.get("user_huid") or "").lower()
    if huid:
        row = conn.execute("SELECT * FROM express_contacts WHERE lower(user_huid) = ?", (huid,)).fetchone()
        if row is not None:
            return row
    login = (sender.get("ad_login") or "").strip().lower()
    if login:
        for row in conn.execute("SELECT * FROM express_contacts WHERE user_huid IS NULL AND ad_login IS NOT NULL"):
            if row["ad_login"].strip().lower() == login:
                return row
    return None


def bind(conn, contact, sender: dict) -> sqlite3.Row:
    """Запомнить, как контакт выглядит в eXpress: идентификатор и личный чат — без них боту некуда писать."""
    huid = sender.get("user_huid") or contact["user_huid"]
    chat = sender.get("group_chat_id") or contact["chat_id"]
    if huid != contact["user_huid"] or chat != contact["chat_id"]:
        conn.execute("UPDATE express_contacts SET user_huid = ?, chat_id = ?, bound_at = COALESCE(bound_at, datetime('now')), "
                     "updated_at = datetime('now') WHERE id = ?", (huid, chat, contact["id"]))
        conn.commit()
    return _contact(conn, contact["id"])


def current_request(conn, contact_id: int):
    """Запрос, к которому относится свободный текст: открытый запрос с самым свежим диалогом."""
    rows = conn.execute(
        "SELECT r.*, o.name AS object_name FROM express_requests r JOIN objects o ON o.id = r.object_id "
        "WHERE r.contact_id = ? AND r.status IN ('sent', 'answered') AND r.work_date >= date('now', '-4 day') ORDER BY r.id DESC",
        (contact_id,)).fetchall()
    if not rows:
        return None
    return max(rows, key=lambda r: (_load_dialog(r).get("ts", 0), r["id"]))


def handle_incoming(payload: dict) -> None:
    """Обработать входящую команду от CTS (вызывается рабочим потоком, не обработчиком HTTP). Ничего не бросает наружу."""
    try:
        _handle(payload)
    except Exception as exc:       # диалог не должен падать молча: причина — в журнал обмена
        log_event("sys", "system", "Сбой обработки входящего", ok=False, error=f"{type(exc).__name__}: {exc}")


def _handle(payload: dict) -> None:
    sender = payload.get("from") or {}
    command = payload.get("command") or {}
    body = (command.get("body") or "").strip()
    data = command.get("data") if isinstance(command.get("data"), dict) else {}
    conn = get_connection()
    try:
        if not express_bot.is_active(conn):
            return
        contact = identify(conn, sender)
        if contact is None or not contact["active"]:
            who = f"huid={sender.get('user_huid')} логин={sender.get('ad_login')} имя={sender.get('username')}"
            log_event("in", "command", f"{body[:80]} ({who})", ok=False, error="отправитель не в списке контактов бота")
            if sender.get("group_chat_id"):
                try:
                    express_bot.send_message(sender["group_chat_id"], "Вас нет в списке контактов бота. Обратитесь к руководителю проекта, чтобы вас добавили.")
                except BotxError:
                    pass
            return
        if sender.get("chat_type") not in (None, "chat"):
            return                                   # групповые чаты бот не обслуживает: численность запрашивается лично
        was_bound = bool(contact["chat_id"])
        contact = bind(conn, contact, sender)
        log_event("in", "command", body[:200] if not data else f"{body[:80]} {json.dumps(data, ensure_ascii=False)[:120]}", contact_id=contact["id"])
        if body.startswith("system:"):
            if body == "system:chat_created" and not was_bound:
                _after_bind(conn, contact)
            return
        if data.get("a"):
            _button(conn, contact, data)
        elif body.lower().startswith("/start"):
            if not was_bound:
                _after_bind(conn, contact)
            req = current_request(conn, contact["id"])
            if req is None:
                _say(contact, None, "Здравствуйте! Сейчас запросов нет — я напишу по расписанию.\n" + HELP_TEXT)
            else:
                _show_menu(conn, contact, req)
        elif body.lower().startswith("/help"):
            _say(contact, None, HELP_TEXT)
        else:
            _text(conn, contact, body)
    finally:
        conn.close()


def _after_bind(conn, contact) -> None:
    """Контакт написал боту впервые: теперь есть куда слать — доставить запросы, которые ждали (не ушли из-за отсутствия чата)."""
    from app import express_scheduler
    express_scheduler.flush_waiting(contact["id"])


def _show_menu(conn, contact, req, page: int = 0) -> None:
    dialog = _load_dialog(req)
    dialog.update({"step": "menu"})
    _store_dialog(conn, req["id"], dialog)
    conn.commit()
    text, bubble = _menu(conn, req, page)
    _say(contact, req["id"], text, bubble)


def _own_open_request(conn, contact, data: dict):
    try:
        rid = int(data.get("r"))
    except (TypeError, ValueError):
        return None
    req = _request(conn, rid)
    if req is None or req["contact_id"] != contact["id"]:
        return None
    return req


def _button(conn, contact, data: dict) -> None:
    req = _own_open_request(conn, contact, data)
    if req is None:
        _say(contact, None, "Этот запрос не найден.")
        return
    if req["status"] not in OPEN_STATUSES:
        _say(contact, req["id"], "Этот запрос уже закрыт. Новый придёт по расписанию.")
        return
    action = data.get("a")
    dialog = _load_dialog(req)
    if action == "menu":
        _show_menu(conn, contact, req, int(data.get("p") or 0))
    elif action == "close":
        _close(conn, contact, req)
    elif action == "con":
        cid = int(data.get("c") or 0)
        if _contractor_row(conn, req, cid) is None:
            _say(contact, req["id"], "Подрядчик не найден на этом объекте.")
            return
        dialog.update({"step": "work", "contractor_id": cid})
        dialog.pop("codifier_id", None)
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        text, bubble = _work_screen(conn, req, cid)
        _say(contact, req["id"], text, bubble)
    elif action == "search":
        if not dialog.get("contractor_id"):
            _show_menu(conn, contact, req)
            return
        dialog["step"] = "search"
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"], "Напишите часть названия или код вида работ.", [[button("‹ Назад", {"a": "con", "r": req["id"], "c": dialog["contractor_id"]})]])
    elif action == "work":
        wid = int(data.get("w") or 0)
        work = conn.execute("SELECT * FROM work_codifier WHERE id = ? AND retired_at IS NULL", (wid,)).fetchone()
        if work is None or not dialog.get("contractor_id"):
            _say(contact, req["id"], "Вид работ не найден или выведен из действия.")
            return
        dialog.update({"step": "workers", "codifier_id": wid})
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"],
             f"{_short(work['code'] + ' ' + work['name'], 90)}.{_existing_text(conn, req, dialog['contractor_id'], wid)}\n"
             "Сколько РАБОЧИХ? Напишите число (0, если рабочих не было).",
             [[button("‹ К видам работ", {"a": "con", "r": req["id"], "c": dialog["contractor_id"]})]])
    elif action == "itr":
        _save_row(conn, contact, req, dialog, itr=int(data.get("v") or 0))
    else:
        _say(contact, req["id"], "Не понял команду. Нажмите кнопку или отправьте /help.")


def _text(conn, contact, body: str) -> None:
    req = current_request(conn, contact["id"])
    if req is None:
        _say(contact, None, "Сейчас нет открытых запросов численности. Я напишу по расписанию.\n" + HELP_TEXT)
        return
    dialog = _load_dialog(req)
    step = dialog.get("step")
    if step == "search":
        found, total = search_works(conn, body)
        back = [button("‹ К подрядчикам", {"a": "menu", "r": req["id"]})]
        if not found:
            _say(contact, req["id"], "Ничего не нашлось. Попробуйте другое слово или код.", [back])
            return
        bubble = [[button(_short(f"{w['code']} {w['name']}"), {"a": "work", "r": req["id"], "w": w["id"]})] for w in found]
        bubble.append([button("Искать заново", {"a": "search", "r": req["id"]})])
        _say(contact, req["id"], "Нашлось: " + (f"показаны первые {len(found)} из {total} — уточните запрос." if total > len(found) else f"{total}.") +
             "\nВыберите вид работ:", bubble)
    elif step == "workers":
        value = parse_count(body)
        if value is None:
            _say(contact, req["id"], f"Нужно целое число от 0 до {headcount.MAX_WORKERS}. Сколько РАБОЧИХ?")
            return
        dialog.update({"step": "itr", "workers": value})
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"], f"Рабочие: {value}. Теперь число ИТР (0, если не было).",
             [[button("0", {"a": "itr", "r": req["id"], "v": 0})]])
    elif step == "itr":
        value = parse_count(body)
        if value is None:
            _say(contact, req["id"], f"Нужно целое число от 0 до {headcount.MAX_WORKERS}. Сколько ИТР?",
                 [[button("0", {"a": "itr", "r": req["id"], "v": 0})]])
            return
        _save_row(conn, contact, req, dialog, itr=value)
    else:
        _show_menu(conn, contact, req)


def _save_row(conn, contact, req, dialog: dict, *, itr: int) -> None:
    contractor_id, codifier_id, workers = dialog.get("contractor_id"), dialog.get("codifier_id"), dialog.get("workers")
    if not (contractor_id and codifier_id and workers is not None):
        _show_menu(conn, contact, req)
        return
    try:
        result = headcount.save_row_from_bot(req["object_id"], date.fromisoformat(req["work_date"]), contractor_id, codifier_id,
                                            workers, itr, contact_name=contact["name"])
    except ValueError as exc:
        dialog.update({"step": "workers"})
        dialog.pop("workers", None)
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"], f"Не записал: {exc}. Сколько РАБОЧИХ?")
        return
    if req["status"] == "sent":
        conn.execute("UPDATE express_requests SET status = 'answered', answered_at = datetime('now') WHERE id = ? AND status = 'sent'", (req["id"],))
    dialog.update({"step": "menu"})
    for key in ("workers", "codifier_id"):
        dialog.pop(key, None)
    _store_dialog(conn, req["id"], dialog)
    conn.commit()
    work = conn.execute("SELECT code, name FROM work_codifier WHERE id = ?", (codifier_id,)).fetchone()
    contractor = _contractor_row(conn, _request(conn, req["id"]), contractor_id)
    verdict = {"created": "Записано", "changed": "Заменено", "unchanged": "Без изменений"}[result["action"]]
    note = " Внесено позже срока — это отмечено в системе." if result["action"] == "created" and result["late"] else ""
    _say(contact, req["id"], f"{verdict}: {_contractor_label(contractor)} · {_short(work['code'] + ' ' + work['name'], 50)} — рабочие {workers}, ИТР {itr}.{note}")
    text, bubble = _menu(conn, _request(conn, req["id"]), 0)
    _say(contact, req["id"], text, bubble)


def _close(conn, contact, req) -> None:
    conn.execute("UPDATE express_requests SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status IN ('sent', 'answered')", (req["id"],))
    conn.commit()
    lines, workers, itr = day_lines(conn, req["object_id"], req["work_date"])
    tail = f"Внесено за день: рабочие {workers}, ИТР {itr}." if lines else "Ничего не внесено."
    _say(contact, req["id"], f"Спасибо! Запрос по объекту «{req['object_name']}» за {_fmt_date(req['work_date'])} закрыт. {tail}")


# ------------------------------------------------------------------ сообщения планировщика

def send_intro(request_id: int) -> None:
    """Отправить контакту первое сообщение запроса. Бросает BotxError — планировщик помечает неудачу и повторяет."""
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        contact = _contact(conn, req["contact_id"])
        text, bubble = intro(conn, request_id)
        _deliver(contact, request_id, text, bubble, "request")
    finally:
        conn.close()


def send_reminder(request_id: int) -> None:
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        contact = _contact(conn, req["contact_id"])
        text = f"Напоминание: по объекту «{req['object_name']}» ещё нет численности за {_fmt_date(req['work_date'])}."
        _deliver(contact, request_id, text, [[button("Внести численность", {"a": "menu", "r": request_id})]], "reminder")
    finally:
        conn.close()


def summary_text(conn, req) -> str:
    lines, workers, itr = day_lines(conn, req["object_id"], req["work_date"], limit=25)
    contact = _contact(conn, req["contact_id"])
    state = {"sent": "не ответил", "answered": "внёс, но не закрыл запрос", "closed": "ответил", "failed": "сообщение не доставлено", "pending": "не отправлено"}[req["status"]]
    out = [f"Сводка: объект «{req['object_name']}», {_fmt_date(req['work_date'])}.", f"Опрошен: {contact['name']} — {state}."]
    out += lines if lines else ["Численность за день не внесена."]
    if lines:
        out.append(f"Итого: рабочие {workers}, ИТР {itr}, всего {workers + itr}.")
    return "\n".join(out)


def send_summary(request_id: int, recipient_id: int) -> None:
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        recipient = _contact(conn, recipient_id)
        _deliver(recipient, request_id, summary_text(conn, req), None, "summary")
    finally:
        conn.close()

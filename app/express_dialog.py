"""Диалог бота eXpress с контактом: запрос численности по объекту (2026-10-23, Docs/express-bot.md).

Как выглядит разговор. Главное меню всегда предлагает внести численность, уточнить данные или получить сводку.
Ввод и уточнение доступны за сегодня или выбранную дату без ожидания расписания. По расписанию бот также присылает запрос.
Дальше кнопки: закреплённая строка «подрядчик + вид работ» → число рабочих → число
ИТР → число механизаторов (на каждом шаге кнопка «0» — «не было»). КАЖДАЯ строка пишется в `headcount_records` сразу (источник `bot`), а не пакетом в конце: если человек бросил диалог на
середине, внесённое не пропадает. «Готово» закрывает запрос. Повторный ввод того же подрядчика и вида работ заменяет число — как в
форме, прежнее остаётся в истории.

Состояние диалога — JSON в `express_requests.dialog` (шаг и выбранное), поэтому переживает перезапуск сервера. Кнопки несут номер
запроса: нажатие на кнопку закрытого или чужого запроса отклоняется, а не пишет в чужой день.

Права. Контакт может вносить численность только по назначенным ему строкам активных подрядчиков.
Выбранные объект и дата проверяются сервером и сохраняются в запросе; сводка охватывает только строки контакта.
"""

import hashlib
import json
import re
import secrets
import sqlite3
import time
from datetime import date, datetime, timedelta
from typing import Optional

from app import express_bot, headcount
from app.db import get_connection
from app.express_bot import BotxError, button, log_event

PAGE = 8
MAX_LABEL = 52
FULL_LABEL = 400   # подпись строки в тексте сообщения: название и примечание целиком
BTN_LABEL = 34
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
OPEN_STATUSES = ("sent", "answered")
MAIN_ACTIONS = {"entry": "Внести численность", "edit": "Уточнить данные", "summary": "Получить сводку"}
HELP_TEXT = ("Выберите действие кнопками:\n"
             "• Внести численность — за сегодня или на дату.\n"
             "• Уточнить данные — за сегодня или на дату; прежние значения сохраняются в истории.\n"
             "• Получить сводку — сегодня, неделя или месяц. Среднее за текущую неделю и месяц учитывает все прошедшие календарные дни.\n"
             "Доступны только закреплённые за вами строки. Ввод: строка → рабочие → ИТР → механизаторы.\n"
             "Команды: /start — главное меню, /help — эта справка.")


# ------------------------------------------------------------------ вспомогательное

def _fmt_date(work_date: str) -> str:
    d = date.fromisoformat(work_date)
    return f"{d.strftime('%d.%m.%Y')} ({WEEKDAYS[d.weekday()]})"


def _short(text: str, limit: int = MAX_LABEL) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


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
        # Три основных действия показываем только в главном меню. На остальных
        # экранах — их собственные кнопки и один явный возврат в главное меню.
        bubble = list(bubble or [])
        shown = {b.get("data", {}).get("a") for row in bubble for b in row}
        if not shown.intersection(MAIN_ACTIONS) and "home" not in shown:
            bubble.append([button("В меню", {"a": "home"})])
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
    """Что за день уже внесено по объекту: (строки текста, рабочих, ИТР, механизаторов)."""
    rows = conn.execute(
        f"SELECT {headcount.CTR_NAME} AS ctr_name, {headcount.CTR_INN} AS ctr_inn, c.id AS cid, COALESCE(cw.note, '') AS note, "
        "SUM(r.workers) AS workers, SUM(r.itr) AS itr, SUM(r.mech) AS mech "
        "FROM headcount_records r JOIN headcount_contractors c ON c.id=r.contractor_id "
        "LEFT JOIN counterparties cp ON cp.id=c.counterparty_id "
        "LEFT JOIN headcount_contractor_works cw ON cw.contractor_id=r.contractor_id AND cw.codifier_id=r.codifier_id "
        f"WHERE r.object_id=? AND r.work_date=? GROUP BY c.id, COALESCE(cw.note, '') ORDER BY {headcount.CTR_NAME}, note",
        (object_id, work_date)).fetchall()
    lines = []
    for r in rows[:limit]:
        who = r["ctr_name"] or (f"ИНН {r['ctr_inn']}" if r["ctr_inn"] else f"№{r['cid']}")
        lines.append(f"• {who} / {r['note'] or '—'} / {r['workers']} / {r['itr']} / {r['mech']}")
    if len(rows) > limit:
        lines.append(f"… и ещё {len(rows) - limit}")
    return lines, sum(r["workers"] for r in rows), sum(r["itr"] for r in rows), sum(r["mech"] for r in rows)


def _own_rows(conn, req) -> list:
    """Строки («подрядчик + вид работ»), по которым бот спрашивает ЭТОГО контакта: те, где ответственным назначено его физлицо
    («Численность → Подрядчики → виды работ»). По остальным строкам объекта бот контакта не спрашивает и их не показывает."""
    contact = _contact(conn, req["contact_id"])
    return list(headcount.responsible_rows(conn, req["object_id"], contact["individual_id"]))


def _row_label(r, limit: int = MAX_LABEL) -> str:
    who = r["ctr_name"] or (f"ИНН {r['ctr_inn']}" if r["ctr_inn"] else f"Подрядчик №{r['contractor_id']}")
    # Примечание подрядчика к виду работ (до 10 символов) идёт в скобках и не обрезается: при нехватке места сокращается название
    note = f" ({r['note']})" if r["note"] else ""
    head = f"{who} · {r['code']} "
    return _short(head + _short(r["work_name"], max(10, limit - len(head) - len(note))) + note, max(limit, len(head) + len(note) + 10))


def _row_btn(r) -> str:
    """Короткая подпись кнопки выбора строки: подрядчик · код · примечание (название вида работ — в тексте над кнопками)."""
    who = r["ctr_name"] or (f"ИНН {r['ctr_inn']}" if r["ctr_inn"] else f"№{r['contractor_id']}")
    return " · ".join(x for x in (_short(who, BTN_LABEL), r["code"], _short(r["note"], headcount.NOTE_MAX) if r["note"] else "") if x)


def _entered(conn, req) -> dict:
    return {(r["contractor_id"], r["codifier_id"]): r for r in conn.execute(
        "SELECT contractor_id, codifier_id, workers, itr, mech FROM headcount_records WHERE object_id = ? AND work_date = ? AND shift = ?", (req["object_id"], req["work_date"], _load_dialog(req).get("shift", "day")))}


def own_lines(conn, req, rows):
    """Внесено за день по строкам контакта: (строки текста, рабочих, ИТР, механизаторов, сколько строк уже внесено)."""
    entered = _entered(conn, req)
    lines, workers, itr, mech, done = [], 0, 0, 0, 0
    for r in rows:
        e = entered.get((r["contractor_id"], r["codifier_id"]))
        if e is None:
            continue
        done += 1
        workers, itr, mech = workers + e["workers"], itr + e["itr"], mech + e["mech"]
        lines.append(f"• {_row_label(r, FULL_LABEL)}: рабочие {e['workers']}, ИТР {e['itr']}, механизаторы {e['mech']}")
    return lines, workers, itr, mech, done


def intro(conn, request_id: int):
    req = _request(conn, request_id)
    deadline = headcount.deadline_for(date.fromisoformat(req["work_date"]))
    n = len(_own_rows(conn, req))
    text = (f"Здравствуйте! Объект «{req['object_name']}».\n"
            f"Нужна численность за {_fmt_date(req['work_date'])}. Срок внесения — до {deadline.strftime('%H:%M %d.%m')}.\n"
            f"Строк, за которые вы ответственны: {n}.")
    bubble = [[button("Внести численность", {"a": "menu", "r": request_id})],
              [button("Вносить нечего", {"a": "close", "r": request_id})]]
    return text, bubble


def _shift_buttons(req):
    return [[button("Дневная смена", {"a": "shift", "r": req["id"], "v": "day"}),
             button("Ночная смена", {"a": "shift", "r": req["id"], "v": "night"})]]


def _menu(conn, req, page: int = 0):
    rows = _own_rows(conn, req)
    lines, workers, itr, mech, done = own_lines(conn, req, rows)
    head = f"Объект «{req['object_name']}», {_fmt_date(req['work_date'])}."
    shift = _load_dialog(req).get("shift", "day")
    head += "\n" + ("Дневная смена" if shift == "day" else "Ночная смена (дата начала)")
    if not rows:
        text = (head + "\n\nЗа вами не закреплено ни одной строки (подрядчик + вид работ) по этому объекту. "
                "Руководитель назначает ответственных в «Численность → Подрядчики».")
        return text, [[button("Готово", {"a": "close", "r": req["id"]})]]
    head += f"\nВаши строки: внесено {done} из {len(rows)}."
    if lines:
        head += "\n" + "\n".join(lines) + f"\nИтого по вашим строкам: рабочие {workers}, ИТР {itr}, механизаторы {mech}."
    entered = _entered(conn, req)
    mode = _load_dialog(req).get("mode")
    if mode in ("entry", "edit"):
        rows = [r for r in rows if ((r["contractor_id"], r["codifier_id"]) in entered) == (mode == "edit")]
        head += "\n" + MAIN_ACTIONS[mode] + "."
        if not rows:
            message = "Все ваши строки за этот день уже внесены. Для изменения выберите «Уточнить данные»." if mode == "entry" else "За этот день по вашим строкам ничего не внесено. Выберите «Внести численность»."
            return head + "\n\n" + message, _shift_buttons(req) + [[button("Готово", {"a": "close", "r": req["id"]})]]
    pages = (len(rows) + PAGE - 1) // PAGE
    page = max(0, min(page, pages - 1))
    # Полные подписи строк — в тексте нумерованным списком (кнопка в eXpress обрезает длинное название, 2026-10-28);
    # на кнопке — подрядчик, код и примечание
    shown = list(enumerate(rows[page * PAGE:(page + 1) * PAGE], start=page * PAGE + 1))
    marks = {r["id"]: "✓ " if (r["contractor_id"], r["codifier_id"]) in entered else "" for _, r in shown}
    head += "\n\n" + "\n".join(f"{n}. {marks[r['id']]}{_row_label(r, FULL_LABEL)}" for n, r in shown)
    bubble = [[button(f"{marks[r['id']]}{_row_btn(r)}", {"a": "row", "r": req["id"], "i": r["id"]})] for n, r in shown]
    nav = []
    if page > 0:
        nav.append(button("‹ Назад", {"a": "menu", "r": req["id"], "p": page - 1}))
    if page < pages - 1:
        nav.append(button("Далее ›", {"a": "menu", "r": req["id"], "p": page + 1}))
    if nav:
        bubble.append(nav)
    bubble += _shift_buttons(req)
    bubble.append([button("Готово", {"a": "close", "r": req["id"]})])
    return head + ("\n\nВыберите строку" + (f" (стр. {page + 1} из {pages})" if pages > 1 else "") + ":"), bubble


def _assigned_row(conn, req, cw_id: int):
    return next((r for r in _own_rows(conn, req) if r["id"] == cw_id), None)


# ------------------------------------------------------------------ главное меню и самостоятельный ввод

def _session(conn, contact) -> dict:
    return _load_dialog({"dialog": _contact(conn, contact["id"])["menu_dialog"]})


def _set_session(conn, contact, dialog: dict) -> None:
    conn.execute("UPDATE express_contacts SET menu_dialog = ? WHERE id = ?",
                 (json.dumps(dialog, ensure_ascii=False), contact["id"]))
    conn.commit()


def _home(conn, contact) -> None:
    _set_session(conn, contact, {"step": "home"})
    _say(contact, None, "Сбор численности. Выберите действие.",
         [[button(label, {"a": action})] for action, label in MAIN_ACTIONS.items()])


def _available_objects(conn, contact, *, summary: bool = False):
    # Права бота определяются назначением ответственного, а не наличием расписания.
    return conn.execute(
        "SELECT DISTINCT o.id, o.name FROM objects o JOIN headcount_contractors c ON c.object_id = o.id "
        "JOIN headcount_contractor_works cw ON cw.contractor_id = c.id JOIN work_codifier w ON w.id = cw.codifier_id "
        "WHERE cw.responsible_id = ? " + ("" if summary else "AND w.retired_at IS NULL AND c.is_archived = 0 ") + "ORDER BY o.name, o.id",
        (contact["individual_id"],)).fetchall()


def _choose_object(conn, contact, session: dict, page: int = 0) -> None:
    objects = _available_objects(conn, contact, summary=session.get("mode") == "summary")
    if not objects:
        _set_session(conn, contact, {"step": "home"})
        _say(contact, None, "За вами не закреплены строки активных подрядчиков. Руководитель назначает ответственных в «Численность → Подрядчики».")
        return
    _set_session(conn, contact, session)
    if len(objects) == 1:
        _select_object(conn, contact, session, objects[0])
        return
    page = max(0, min(page, (len(objects) - 1) // PAGE))
    bubble = [[button(_short(o["name"]), {"a": "self_object", "o": o["id"]})] for o in objects[page * PAGE:(page + 1) * PAGE]]
    nav = []
    if page:
        nav.append(button("‹ Назад", {"a": "self_objects", "p": page - 1}))
    if (page + 1) * PAGE < len(objects):
        nav.append(button("Далее ›", {"a": "self_objects", "p": page + 1}))
    if nav:
        bubble.append(nav)
    _say(contact, None, "Выберите объект:", bubble)


def _select_object(conn, contact, session: dict, obj) -> None:
    if session.get("mode") == "summary":
        _self_summary(conn, contact, obj, session["period"])
        return
    work_date = session.get("date")
    if not work_date or date.fromisoformat(work_date) > headcount.now_msk().date():
        _home(conn, contact)
        return
    # Закрытые запросы остаются закрытыми. Новый сеанс уточнения использует новую запись,
    # открытый запрос за тот же день переиспользуется без повторной рассылки.
    req = conn.execute("SELECT id FROM express_requests WHERE contact_id = ? AND object_id = ? AND work_date = ? "
                       "AND status IN ('sent', 'answered') ORDER BY id DESC LIMIT 1",
                       (contact["id"], obj["id"], work_date)).fetchone()
    if req is None:
        rid = conn.execute("INSERT INTO express_requests (object_id, contact_id, work_date, status, sent_at) "
                           "VALUES (?, ?, ?, 'sent', datetime('now'))", (obj["id"], contact["id"], work_date)).lastrowid
    else:
        rid = req["id"]
    req = _request(conn, rid)
    _store_dialog(conn, rid, {"step": "menu", "mode": session["mode"]})
    _set_session(conn, contact, {"step": "request", "r": rid})
    _show_menu(conn, contact, _request(conn, rid))


def _self_summary(conn, contact, obj, period: str) -> None:
    today = headcount.now_msk().date()
    start = today - timedelta(days=today.weekday()) if period == "week" else today.replace(day=1) if period == "month" else today
    rows = conn.execute(
        "SELECT r.work_date, SUM(r.workers) AS workers, SUM(r.itr) AS itr, SUM(r.mech) AS mech "
        "FROM headcount_records r JOIN headcount_contractors c ON c.id = r.contractor_id "
        "JOIN headcount_contractor_works cw ON cw.contractor_id = r.contractor_id AND cw.codifier_id = r.codifier_id "
        "JOIN work_codifier w ON w.id = cw.codifier_id "
        "WHERE r.object_id = ? AND cw.responsible_id = ? "
        "AND r.work_date BETWEEN ? AND ? GROUP BY r.work_date",
        (obj["id"], contact["individual_id"], start.isoformat(), today.isoformat())).fetchall()
    title = {"today": "Сегодня", "week": "Неделя", "month": "Месяц"}[period]
    text = f"Сводка по вашим строкам. Объект «{obj['name']}».\n{title}: {start:%d.%m.%Y} — {today:%d.%m.%Y}."
    if not rows:
        text += "\nЗа этот период данных нет."
    else:
        divisor = (today - start).days + 1
        values = {k: sum(r[k] for r in rows) / divisor for k in ("workers", "itr", "mech")}
        fmt = lambda n: f"{n:.3f}".rstrip("0").rstrip(".").replace(".", ",")
        prefix = "Итого" if period == "today" else "Среднее за день"
        text += (f"\n{prefix}: рабочие {fmt(values['workers'])}, ИТР {fmt(values['itr'])}, "
                 f"механизаторы {fmt(values['mech'])}; всего {fmt(sum(values.values()))}.")
        if period != "today":
            text += f"\nДней с данными: {len(rows)} из {(today - start).days + 1}. Среднее рассчитано по всем календарным дням периода, включая дни без работы."
    _set_session(conn, contact, {"step": "home"})
    _say(contact, None, text)


def _main_button(conn, contact, data: dict) -> bool:
    action = data.get("a")
    if action in MAIN_ACTIONS:
        _set_session(conn, contact, {"step": "period" if action == "summary" else "day", "mode": action})
        if action == "summary":
            bubble = [[button(label, {"a": "self_period", "v": value})] for value, label in
                      (("today", "Сегодня"), ("week", "Неделя"), ("month", "Месяц"))]
            _say(contact, None, "За какой период получить сводку?", bubble)
        else:
            _say(contact, None, f"{MAIN_ACTIONS[action]}. Выберите дату:",
                 [[button("За сегодня", {"a": "self_today"}), button("На дату", {"a": "self_date"})]])
        return True
    if action not in ("home", "self_today", "self_date", "self_period", "self_object", "self_objects"):
        return False
    session = _session(conn, contact)
    if action == "home":
        _home(conn, contact)
    elif action in ("self_today", "self_date") and session.get("mode") in ("entry", "edit") and session.get("step") in ("day", "date"):
        if action == "self_date":
            _set_session(conn, contact, {"step": "date", "mode": session["mode"]})
            _say(contact, None, "Введите дату в формате ДД.ММ.ГГГГ (например, 23.10.2026).")
        else:
            _choose_object(conn, contact, {"step": "object", "mode": session["mode"], "date": headcount.now_msk().date().isoformat()})
    elif action == "self_period" and session.get("mode") == "summary" and session.get("step") == "period" and data.get("v") in ("today", "week", "month"):
        _choose_object(conn, contact, {"step": "object", "mode": "summary", "period": data["v"]})
    elif action == "self_objects" and session.get("step") == "object":
        _choose_object(conn, contact, session, int(data.get("p") or 0))
    elif action == "self_object" and session.get("step") == "object":
        obj = next((o for o in _available_objects(conn, contact, summary=session.get("mode") == "summary") if o["id"] == data.get("o")), None)
        if obj is None:
            _say(contact, None, "Этот объект недоступен. Выберите действие заново.")
        else:
            _select_object(conn, contact, session, obj)
    else:
        _say(contact, None, "Этот шаг уже завершён. Выберите действие заново.")
    return True


def _existing_text(conn, req, contractor_id: int, codifier_id: int) -> str:
    cur = conn.execute("SELECT workers, itr, mech FROM headcount_records WHERE object_id = ? AND work_date = ? AND contractor_id = ? AND codifier_id = ? AND shift = ?",
                       (req["object_id"], req["work_date"], contractor_id, codifier_id, _load_dialog(req).get("shift", "day"))).fetchone()
    return f"\nСейчас внесено: рабочие {cur['workers']}, ИТР {cur['itr']}, механизаторы {cur['mech']}. Новое значение заменит прежнее." if cur else ""


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
    contact = _contact(conn, contact_id)
    session = _session(conn, contact)
    if session:
        req = _own_open_request(conn, contact, session) if session.get("step") == "request" else None
        return req if req is not None and req["status"] in OPEN_STATUSES else None
    rows = conn.execute(
        "SELECT r.*, o.name AS object_name FROM express_requests r JOIN objects o ON o.id = r.object_id "
        "WHERE r.contact_id = ? AND r.status IN ('sent', 'answered') AND r.work_date >= date('now', '-4 day') ORDER BY r.id DESC",
        (contact_id,)).fetchall()
    if not rows:
        return None
    return max(rows, key=lambda r: (_load_dialog(r).get("ts", 0), r["id"]))


# ------------------------------------------------------------------ привязка по одноразовому коду (2026-10-26)

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"      # без I, O, 0, 1: код читают по телефону и вводят вручную
CODE_LENGTH = 8
CODE_HOURS = 24
FAIL_LIMIT = 5                                           # неверных кодов с одного аккаунта eXpress за окно — и блокировка на окно
FAIL_WINDOW = 600
_FAILS: dict = {}


def normalize_code(text: str) -> str:
    return re.sub(r"[\s\-]", "", text or "").upper()


def hash_code(code: str) -> str:
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()


def issue_code(conn, contact_id: int):
    """Новый одноразовый код привязки контакта (прежний перестаёт действовать). Возвращает (код для показа «ABCD-EFGH», момент окончания по БД, UTC).
    В БД лежит только sha256 кода: показать его можно один раз, при выдаче."""
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    conn.execute("UPDATE express_contacts SET bind_code_hash = ?, bind_code_expires = datetime('now', ?), updated_at = datetime('now') WHERE id = ?",
                 (hash_code(raw), f"+{CODE_HOURS} hours", contact_id))
    conn.commit()
    expires = conn.execute("SELECT bind_code_expires FROM express_contacts WHERE id = ?", (contact_id,)).fetchone()[0]
    return f"{raw[:4]}-{raw[4:]}", expires


def extract_code(body: str, known: bool) -> Optional[str]:
    """Код привязки в сообщении: «/start КОД» от любого; просто «КОД» — только от того, кого бот ещё не знает (иначе число или слово в диалоге могло бы сойти за код)."""
    text = (body or "").strip()
    m = re.match(r"(?is)^/start(?:@\S+)?\s+(.+)$", text)
    arg = m.group(1) if m else (None if known else text)
    if arg is None:
        return None
    norm = normalize_code(arg)
    return norm if len(norm) == CODE_LENGTH and all(c in CODE_ALPHABET for c in norm) else None


def bind_by_code(conn, sender: dict, code: str):
    """Привязать аккаунт отправителя к контакту, которому выдан этот код. Возвращает (контакт, причина): причина ok / throttled / invalid / conflict:<имя>.
    Неверные коды считаются по аккаунту eXpress: пять за десять минут — и пока ждать (код из 8 знаков перебором не подобрать, а сутки жизни ограничивают окно)."""
    huid = str(sender.get("user_huid") or "").lower()
    now = time.time()
    fails = [t for t in _FAILS.get(huid, []) if now - t < FAIL_WINDOW]
    if len(fails) >= FAIL_LIMIT:
        _FAILS[huid] = fails
        return None, "throttled"
    row = conn.execute("SELECT * FROM express_contacts WHERE bind_code_hash = ? AND active = 1 AND bind_code_expires > datetime('now')", (hash_code(code),)).fetchone()
    if row is None:
        fails.append(now)
        _FAILS[huid] = fails
        return None, "invalid"
    other = conn.execute("SELECT name FROM express_contacts WHERE lower(user_huid) = ? AND id != ?", (huid, row["id"])).fetchone()
    if other is not None:
        return None, f"conflict:{other['name']}"
    conn.execute("UPDATE express_contacts SET user_huid = ?, chat_id = ?, bound_at = datetime('now'), bind_code_hash = NULL, bind_code_expires = NULL, "
                 "updated_at = datetime('now') WHERE id = ?", (sender.get("user_huid"), sender.get("group_chat_id"), row["id"]))
    conn.commit()
    _FAILS.pop(huid, None)
    return _contact(conn, row["id"]), "ok"


def _try_code(conn, sender: dict, body: str, known) -> bool:
    """Если сообщение — код привязки, обработать его. True — сообщение разобрано полностью; False — это обычное сообщение, идём дальше."""
    code = extract_code(body, known is not None and bool(known["active"]))
    if code is None:
        return False
    chat = sender.get("group_chat_id")
    if sender.get("chat_type") not in (None, "chat") or not chat or not sender.get("user_huid"):
        return False
    contact, reason = bind_by_code(conn, sender, code)
    who = f"huid={sender.get('user_huid')} логин={sender.get('ad_login')} имя={sender.get('username')}"
    if contact is not None:
        log_event("in", "command", f"привязка по коду ({who})", contact_id=contact["id"])
        was_waiting = current_request(conn, contact["id"])
        _say(contact, None, f"Готово: вы привязаны как «{contact['name']}». Теперь я могу писать вам по расписанию.")
        _after_bind(conn, contact)
        if was_waiting is not None:
            _show_menu(conn, contact, was_waiting)
        _home(conn, contact)
        return True
    log_event("in", "command", f"код привязки не принят ({who})", ok=False, error=reason)
    if known is not None and known["active"] and reason in ("invalid", "throttled"):
        return False                        # известный контакт прислал «/start что-то»: это обычный /start, лишний аргумент игнорируем (конфликт аккаунтов — сообщаем)
    text = {"throttled": "Слишком много неверных кодов. Подождите десять минут и попробуйте снова.",
            "invalid": "Код не подошёл или срок его действия истёк. Попросите руководителя выдать новый код и отправьте: /start КОД"}.get(reason)
    if text is None and reason.startswith("conflict:"):
        text = f"Этот аккаунт eXpress уже привязан к контакту «{reason[9:]}». Обратитесь к руководителю проекта."
    try:
        express_bot.send_message(chat, text or "Не удалось привязать контакт.")
    except BotxError:
        pass
    return True


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
        if not data.get("a") and not body.startswith("system:") and _try_code(conn, sender, body, contact):
            return
        if contact is None or not contact["active"]:
            who = f"huid={sender.get('user_huid')} логин={sender.get('ad_login')} имя={sender.get('username')}"
            log_event("in", "command", f"{body[:80]} ({who})", ok=False, error="отправитель не в списке контактов бота")
            if sender.get("group_chat_id"):
                try:
                    express_bot.send_message(sender["group_chat_id"], "Вас нет в списке контактов бота. Если руководитель выдал вам код привязки, отправьте: /start КОД. "
                                                                    "Иначе обратитесь к руководителю проекта, чтобы вас добавили.")
                except BotxError:
                    pass
            return
        if sender.get("chat_type") not in (None, "chat"):
            return                                   # групповые чаты бот не обслуживает: численность запрашивается лично
        was_bound = bool(contact["chat_id"])
        contact = bind(conn, contact, sender)
        log_event("in", "command", body[:200] if not data else f"{body[:80]} {json.dumps(data, ensure_ascii=False)[:120]}", contact_id=contact["id"],
                  request_id=_log_request_id(conn, contact, data))
        if body.startswith("system:"):
            if body == "system:chat_created" and not was_bound:
                _after_bind(conn, contact)
                _home(conn, contact)
            return
        if data.get("a"):
            _button(conn, contact, data)
        elif body.lower() in ("/entry", "/edit", "/summary"):
            _main_button(conn, contact, {"a": body.lower()[1:]})
        elif body.lower().startswith("/start"):
            if not was_bound:
                _after_bind(conn, contact)
            _home(conn, contact)
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


def _log_request_id(conn, contact, data: dict) -> Optional[int]:
    """К какому запросу (а значит и объекту) относится входящее: кнопка несёт номер запроса, свободный текст — текущий открытый запрос
    контакта. Без этого входящие в журнале не привязать к объекту (2026-10-28)."""
    req = _own_open_request(conn, contact, data) if data.get("r") is not None else current_request(conn, contact["id"])
    return req["id"] if req is not None else None


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
    if _main_button(conn, contact, data):
        return
    req = _own_open_request(conn, contact, data)
    if req is None:
        _say(contact, None, "Этот запрос не найден.")
        return
    if req["status"] not in OPEN_STATUSES:
        _say(contact, req["id"], "Этот запрос уже закрыт. Для изменения численности нажмите «В меню» и выберите «Уточнить данные».")
        return
    action = data.get("a")
    _set_session(conn, contact, {"step": "request", "r": req["id"]})
    dialog = _load_dialog(req)
    if action == "menu":
        _show_menu(conn, contact, req, int(data.get("p") or 0))
    elif action == "shift" and data.get("v") in ("day", "night"):
        _store_dialog(conn, req["id"], {"step": "menu", "mode": dialog.get("mode"), "shift": data["v"]})
        conn.commit()
        _show_menu(conn, contact, _request(conn, req["id"]))
    elif action == "close":
        _close(conn, contact, req)
    elif action == "row":
        row = _assigned_row(conn, req, int(data.get("i") or 0))
        if row is None:
            _say(contact, req["id"], "Эта строка за вами не закреплена (руководитель мог переназначить ответственного). Вот ваш актуальный список.")
            _show_menu(conn, contact, req)
            return
        exists = (row["contractor_id"], row["codifier_id"]) in _entered(conn, req)
        if dialog.get("mode") in ("entry", "edit") and exists != (dialog["mode"] == "edit"):
            _show_menu(conn, contact, req)
            return
        dialog.update({"step": "workers", "contractor_id": row["contractor_id"], "codifier_id": row["codifier_id"]})
        dialog.pop("workers", None)
        dialog.pop("itr", None)
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"],
             f"{_row_label(row, 100)}.{_existing_text(conn, req, row['contractor_id'], row['codifier_id'])}\n"
             "Сколько РАБОЧИХ? Напишите число (0, если рабочих не было).",
             [[button("‹ К списку строк", {"a": "menu", "r": req["id"]})]])
    elif action in ("con", "search", "work"):
        # кнопки прежней версии диалога (выбор подрядчика и поиск вида работ отменён): показываем актуальный список строк
        _show_menu(conn, contact, req)
    elif action == "itr":
        if dialog.get("step") == "itr":
            _after_itr(conn, contact, req, dialog, int(data.get("v") or 0))
        else:
            _show_menu(conn, contact, req)
    elif action == "mech":
        if dialog.get("step") == "mech":
            _save_row(conn, contact, req, dialog, mech=int(data.get("v") or 0))
        else:
            _show_menu(conn, contact, req)
    else:
        _say(contact, req["id"], "Не понял команду. Нажмите кнопку или отправьте /help.")


def _text(conn, contact, body: str) -> None:
    session = _session(conn, contact)
    if session.get("step") == "date":
        try:
            day = datetime.strptime(body, "%d.%m.%Y").date()
        except ValueError:
            _say(contact, None, "Нужна существующая дата в формате ДД.ММ.ГГГГ. Попробуйте ещё раз.")
            return
        if day > headcount.now_msk().date():
            _say(contact, None, "Численность за будущую дату внести нельзя. Введите сегодня или прошедшую дату.")
            return
        _choose_object(conn, contact, {"step": "object", "mode": session["mode"], "date": day.isoformat()})
        return
    req = current_request(conn, contact["id"])
    if req is None:
        _say(contact, None, "Выберите действие: нажмите «В меню».\n" + HELP_TEXT)
        return
    dialog = _load_dialog(req)
    step = dialog.get("step")
    if step == "workers":
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
        _after_itr(conn, contact, req, dialog, value)
    elif step == "mech":
        value = parse_count(body)
        if value is None:
            _say(contact, req["id"], f"Нужно целое число от 0 до {headcount.MAX_WORKERS}. Сколько МЕХАНИЗАТОРОВ?",
                 [[button("0", {"a": "mech", "r": req["id"], "v": 0})]])
            return
        _save_row(conn, contact, req, dialog, mech=value)
    else:
        _show_menu(conn, contact, req)


def _after_itr(conn, contact, req, dialog: dict, itr: int) -> None:
    """ИТР названы — следующий шаг «механизаторы» (кнопка «0» — не было). Без выбранных подрядчика, вида работ и рабочих — в меню."""
    if not (dialog.get("contractor_id") and dialog.get("codifier_id") and dialog.get("workers") is not None):
        _show_menu(conn, contact, req)
        return
    dialog.update({"step": "mech", "itr": itr})
    _store_dialog(conn, req["id"], dialog)
    conn.commit()
    _say(contact, req["id"], f"ИТР: {itr}. Теперь число МЕХАНИЗАТОРОВ (0, если не было).",
         [[button("0", {"a": "mech", "r": req["id"], "v": 0})]])


def _save_row(conn, contact, req, dialog: dict, *, mech: int) -> None:
    contractor_id, codifier_id, workers = dialog.get("contractor_id"), dialog.get("codifier_id"), dialog.get("workers")
    itr = dialog.get("itr") or 0
    if not (contractor_id and codifier_id and workers is not None):
        _show_menu(conn, contact, req)
        return
    if not any(r["contractor_id"] == contractor_id and r["codifier_id"] == codifier_id for r in _own_rows(conn, req)):
        _say(contact, req["id"], "Эта строка больше за вами не закреплена — ничего не записано. Вот ваш актуальный список.")
        _show_menu(conn, contact, req)
        return
    try:
        result = headcount.save_row_from_bot(req["object_id"], date.fromisoformat(req["work_date"]), contractor_id, codifier_id,
                                            workers, itr, mech, contact_name=contact["name"], shift=dialog.get("shift", "day"))
    except ValueError as exc:
        dialog.update({"step": "workers"})
        dialog.pop("workers", None)
        dialog.pop("itr", None)
        _store_dialog(conn, req["id"], dialog)
        conn.commit()
        _say(contact, req["id"], f"Не записал: {exc}. Сколько РАБОЧИХ?")
        return
    if req["status"] == "sent":
        conn.execute("UPDATE express_requests SET status = 'answered', answered_at = datetime('now') WHERE id = ? AND status = 'sent'", (req["id"],))
    dialog.update({"step": "menu"})
    for key in ("workers", "itr", "codifier_id"):
        dialog.pop(key, None)
    _store_dialog(conn, req["id"], dialog)
    conn.commit()
    row = next(r for r in _own_rows(conn, req) if r["contractor_id"] == contractor_id and r["codifier_id"] == codifier_id)
    verdict = {"created": "Записано", "changed": "Заменено", "unchanged": "Без изменений"}[result["action"]]
    note = " Внесено позже срока — это отмечено в системе." if result["action"] == "created" and result["late"] else ""
    _say(contact, req["id"], f"{verdict}: {_row_label(row, 90)} — рабочие {workers}, ИТР {itr}, механизаторы {mech}.{note}")
    text, bubble = _menu(conn, _request(conn, req["id"]), 0)
    _say(contact, req["id"], text, bubble)


def _close(conn, contact, req) -> None:
    conn.execute("UPDATE express_requests SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status IN ('sent', 'answered')", (req["id"],))
    conn.commit()
    lines, workers, itr, mech, done = own_lines(conn, req, _own_rows(conn, req))
    tail = f"Внесено по вашим строкам: рабочие {workers}, ИТР {itr}, механизаторы {mech}." if lines else "Ничего не внесено."
    _say(contact, req["id"], f"Спасибо! Запрос по объекту «{req['object_name']}» за {_fmt_date(req['work_date'])} закрыт. {tail}")


# ------------------------------------------------------------------ сообщения планировщика

def send_intro(request_id: int) -> bool:
    """Отправить контакту первое сообщение запроса. Бросает BotxError — планировщик помечает неудачу и повторяет."""
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        contact = _contact(conn, req["contact_id"])
        if not _own_rows(conn, req):
            return False
        text, bubble = intro(conn, request_id)
        _deliver(contact, request_id, text, bubble, "request")
        return True
    finally:
        conn.close()


def send_reminder(request_id: int) -> bool:
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        contact = _contact(conn, req["contact_id"])
        if not _own_rows(conn, req):
            return False
        text = f"Напоминание: по объекту «{req['object_name']}» ещё нет численности за {_fmt_date(req['work_date'])}."
        _deliver(contact, request_id, text, [[button("Внести численность", {"a": "menu", "r": request_id})]], "reminder")
        return True
    finally:
        conn.close()


def summary_text(conn, req) -> str:
    lines, workers, itr, mech = day_lines(conn, req["object_id"], req["work_date"], limit=25)
    contact = _contact(conn, req["contact_id"])
    if req["status"] == "closed" and req["last_error"]:
        return "\n".join([f"Сводка: объект «{req['object_name']}», {_fmt_date(req['work_date'])}.", f"Опрос {contact['name']} не проводился: {req['last_error']}."])
    state = {"sent": "не ответил", "answered": "внёс, но не закрыл запрос", "closed": "ответил", "failed": "сообщение не доставлено", "pending": "не отправлено"}[req["status"]]
    out = [f"Сводка: объект «{req['object_name']}», {_fmt_date(req['work_date'])}.", f"Опрошен: {contact['name']} — {state}."]
    out += lines if lines else ["Численность за день не внесена."]
    if lines:
        out.append(f"Итого: рабочие {workers}, ИТР {itr}, механизаторы {mech}, всего {workers + itr + mech}.")
    return "\n".join(out)


def send_summary(request_id: int, recipient_id: int) -> None:
    conn = get_connection()
    try:
        req = _request(conn, request_id)
        recipient = _contact(conn, recipient_id)
        _deliver(recipient, request_id, summary_text(conn, req), None, "summary")
    finally:
        conn.close()

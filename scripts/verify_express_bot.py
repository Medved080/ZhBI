"""Сквозная проверка бота eXpress (app/express_*.py) на МАКЕТЕ сервера eXpress (CTS) — настоящий CTS не вызывается.

Пишет в базу ZHBI_DB_PATH (она МЕНЯЕТСЯ) — гонять ТОЛЬКО на копии обезличенной базы:

    cp data/zhbi.anon.db /tmp/ex.db && ZHBI_DB_PATH=/tmp/ex.db .venv312/bin/python scripts/verify_express_bot.py

Что проверяется: подпись токена и входящего JWT; настройка и ключ (ключ — в файле, не в БД); расписание (время, дни, окно догона, `effective_from`,
отсутствие дублей); отправка, повтор при отсутствии чата, доставка ждущих запросов после первого сообщения контакта; диалог кнопками и текстом
(подрядчик → вид работ → рабочие → ИТР) с записью в `headcount_records` источником `bot`; замена числа и история; просрочка; защита от чужих и
закрытых запросов; напоминание и сводка; настоящие HTTP-маршруты /status, /command, /notification/callback через uvicorn.
"""
import base64, hashlib, hmac, json, os, sys, threading, time, urllib.request, urllib.error
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_db = os.environ.get("ZHBI_DB_PATH")
if not _db or os.path.basename(_db) == "zhbi.db":
    sys.exit("Скрипт пишет в базу: задайте ZHBI_DB_PATH на КОПИЮ обезличенной базы (боевой data/zhbi.db не годится)")

from app import db, headcount as hc, express_bot as eb, express_dialog as ed, express_scheduler as es

ok = lambda cond, msg: print(("OK   " if cond else "FAIL ") + msg) or (cond or sys.exit(1))

import express_cts_mock as mock
from express_cts_mock import BOT_ID, KEY, TOKEN, SENT, STATE, sign_jwt

cts, _cts_port = mock.start()
CTS_URL = f"http://127.0.0.1:{_cts_port}"

db.init_db()
conn = db.get_connection()
admin = conn.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
obj = conn.execute("SELECT id, name FROM objects ORDER BY id LIMIT 1").fetchone()
obj2 = conn.execute("SELECT id FROM objects ORDER BY id LIMIT 1 OFFSET 1").fetchone()["id"]
OBJ = obj["id"]
for code, name, sec in [("130-01-01", "3.1.1. Бетон", "3. Монолит"), ("130-03", "3.3. Арматура", "3. Монолит"), ("340-03-02", "23.1.1. Земляные", "23. Сети")]:
    conn.execute("INSERT OR IGNORE INTO work_codifier (code,name,section_name) VALUES (?,?,?)", (code, name, sec))
conn.execute("INSERT OR IGNORE INTO work_codifier (code,name,section_name,retired_at) VALUES ('999-X','Выведен','X','2026-01-01')")
for inn, name in [("7701000001", "Альфа ООО"), ("7701000002", "Бета ООО")]:
    conn.execute("INSERT OR IGNORE INTO headcount_contractors (object_id, name_raw, inn_raw) VALUES (?,?,?)", (OBJ, name, inn))
conn.execute("DELETE FROM headcount_records WHERE object_id = ?", (OBJ,))
conn.commit()
W = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM work_codifier")}
CON = {r["inn_raw"]: r["id"] for r in conn.execute("SELECT id, inn_raw FROM headcount_contractors WHERE object_id = ?", (OBJ,))}
conn.close()

# ------------------------------------------------------------------ подпись, ключ, настройка
ok(eb.signature("abc", "k") == hmac.new(b"k", b"abc", hashlib.sha256).hexdigest().upper(), "подпись токена: HMAC-SHA256, hex в верхнем регистре")
ok(not eb.is_active() and not eb.secret_configured(), "до настройки бот не активен")
try:
    eb.save_config(db.get_connection(), {"enabled": True, "cts_url": CTS_URL, "bot_id": BOT_ID}, admin["id"]); ok(False, "включение без ключа должно отказывать")
except ValueError:
    ok(True, "включить без ключа нельзя")
for bad in ("ftp://x", "http://u:p@h", "http://h/path", "http://h?x=1", "nonsense"):
    try: eb.validate_cts_url(bad); ok(False, f"адрес {bad} должен отклоняться")
    except ValueError: pass
ok(True, "адрес CTS: чужие схемы, логин, путь и параметры отклоняются")
try: eb.save_config(db.get_connection(), {"cts_url": CTS_URL, "bot_id": "не-uuid"}, admin["id"]); ok(False, "UUID")
except ValueError: ok(True, "идентификатор бота должен быть UUID")
eb.set_secret(KEY)
c = db.get_connection(); cfg = eb.save_config(c, {"enabled": True, "cts_url": CTS_URL, "bot_id": BOT_ID, "bot_name": "pm_bot"}, admin["id"]); c.commit(); c.close()
ok(cfg["enabled"] and eb.is_active(), "после ключа бот включается")
path = eb.secret_path()
ok(path.exists() and oct(path.stat().st_mode & 0o777) == "0o600", f"ключ в файле {path.name} с правами 0600")
c = db.get_connection(); dump = "".join(str(tuple(r)) for t in ("express_config", "express_log") for r in c.execute(f"SELECT * FROM {t}")); c.close()
ok(KEY not in dump, "ключа нет ни в express_config, ни в журнале")
ok(eb.ping()["ok"], "ping: токен получен у макета CTS")
ok(KEY not in eb.redact(f"ошибка {KEY}") and "***" in eb.redact(f"ошибка {KEY}"), "redact убирает ключ из текстов")

# ------------------------------------------------------------------ JWT
jwt = sign_jwt
good = {"iss": BOT_ID, "aud": "host", "exp": time.time() + 60}
ok(eb.verify_incoming("Bearer " + jwt(good)), "верный JWT (iss = бот) принят")
ok(eb.verify_incoming("Bearer " + jwt({"iss": "cts.corp", "aud": [BOT_ID], "exp": time.time() + 60})), "верный JWT (aud = [бот]) принят")
ok(eb.verify_incoming("Bearer " + jwt({"iss": BOT_ID.upper(), "aud": "host", "exp": time.time() + 60})), "UUID бота в токене сравнивается без учёта регистра")
ok("iss=" in eb.describe_token("Bearer " + jwt(good)) and KEY not in eb.describe_token("Bearer " + jwt(good)), "describe_token показывает iss/aud и не содержит ключа")
for label, hdr in [("чужой ключ", "Bearer " + jwt(good, key="other-secret-1")), ("истёк", "Bearer " + jwt({**good, "exp": time.time() - 5})),
                   ("чужой бот", "Bearer " + jwt({"iss": "x", "aud": ["y"]})), ("без токена", None), ("мусор", "Bearer a.b.c"),
                   ("alg none", "Bearer " + jwt(good, alg="none"))]:
    try: eb.verify_incoming(hdr); ok(False, f"JWT «{label}» должен отклоняться")
    except eb.BotxError: pass
ok(True, "JWT: чужой ключ, истёкший, чужой бот, без токена, мусор, alg=none — отклонены")

# ------------------------------------------------------------------ контакты и расписание
c = db.get_connection()
for table in ("express_requests", "express_schedules", "express_log", "express_contacts"):    # копия базы могла быть «грязной» (стенд, прошлые прогоны)
    c.execute(f"DELETE FROM {table}")
c.commit()
ind = c.execute("SELECT id, name FROM individuals LIMIT 1").fetchone()
cur = c.execute("INSERT INTO express_contacts (individual_id, name, email, ad_login) VALUES (?, 'Иванов И.И.', 'known@corp.ru', 'ivanov')", (ind["id"] if ind else None,))
IVAN = cur.lastrowid
cur = c.execute("INSERT INTO express_contacts (name, ad_login) VALUES ('Петров П.П. (произвольный)', 'petrov')")
PETR = cur.lastrowid
cur = c.execute("INSERT INTO express_schedules (object_id, contact_id, weekdays, send_time, day_offset, remind_time, summary_time, summary_contact_id, effective_from) "
                "VALUES (?, ?, '1,2,3,4,5', '10:30', 0, '11:30', '12:30', ?, '2000-01-01 00:00:00')", (OBJ, IVAN, PETR))
SCH = cur.lastrowid
c.commit(); c.close()

FRI = datetime(2026, 10, 23, 10, 30, tzinfo=hc.MSK)           # пятница
SAT = datetime(2026, 10, 24, 10, 30, tzinfo=hc.MSK)
ok(FRI.isoweekday() == 5 and SAT.isoweekday() == 6, "даты проверки: пятница и суббота")

ok(es.tick(FRI - timedelta(minutes=5))["created"] == 0, "до 10:30 запрос не создаётся")
ok(es.tick(FRI + timedelta(hours=2))["created"] == 0, "через 2 часа после времени — не догоняется (окно 1 час)")
ok(es.tick(SAT)["created"] == 0, "в субботу (дни 1–5) не срабатывает")

# контакт ещё не писал боту → запрос создан, отправка не удалась, статус failed
s = es.tick(FRI)
ok(s["created"] == 1 and s["failed"] == 1 and not SENT, "нет чата: запрос создан, отправка не удалась, ничего не ушло")
c = db.get_connection(); q = c.execute("SELECT * FROM express_requests").fetchone(); c.close()
ok(q["status"] == "failed" and "/start" in q["last_error"] and q["attempts"] == 1, "причина понятна человеку: пусть напишет /start")
ok(es.tick(FRI)["created"] == 0, "повторный обход не создаёт дубль (пара расписание+день)")
RID = q["id"]

# ------------------------------------------------------------------ контакт пишет боту → ждущий запрос уходит
CHAT = "22222222-2222-2222-2222-222222222222"
HUID = "33333333-3333-3333-3333-333333333333"
def sender(huid=HUID, login="ivanov", chat=CHAT, chat_type="chat"):
    return {"user_huid": huid, "ad_login": login, "group_chat_id": chat, "chat_type": chat_type, "username": "Иванов"}
def say(body, data=None, **kw):
    SENT.clear()
    ed.handle_incoming({"from": sender(**kw), "command": {"body": body, "data": data or {}, "command_type": "user"}, "bot_id": BOT_ID})
    return list(SENT)
def last(): return SENT[-1] if SENT else None
def buttons(msg): return [b for row in (msg[2] or []) for b in row]
def press(label_part, msg=None):
    msg = msg or last()
    for b in buttons(msg):
        if label_part in b["label"]:
            return say(b["command"], b["data"])
    raise AssertionError(f"кнопки «{label_part}» нет: {[b['label'] for b in buttons(msg)]}")

out = say("/start")
ok(out and any("Внести численность" in b["label"] for m in out for b in buttons(m)), "/start: контакт опознан по логину, чат запомнен, ждавший запрос доставлен")
c = db.get_connection()
ct = c.execute("SELECT * FROM express_contacts WHERE id = ?", (IVAN,)).fetchone(); q = c.execute("SELECT * FROM express_requests WHERE id = ?", (RID,)).fetchone(); c.close()
ok(ct["user_huid"] == HUID and ct["chat_id"] == CHAT and ct["bound_at"], "контакт сопоставлен: huid и чат записаны")
ok(q["status"] == "sent" and q["sent_at"] and q["last_error"] is None, "запрос получил статус sent")
ok(out[0][0] == CHAT and f"«{obj['name']}»" in out[0][1] and "23.10.2026" in out[0][1] and "11:00" in out[0][1], "текст: объект, день, срок 11:00")

# посторонний
SENT.clear()
ed.handle_incoming({"from": sender(huid="99999999-9999-9999-9999-999999999999", login="stranger", chat="44444444-4444-4444-4444-444444444444"), "command": {"body": "/start", "data": {}}})
ok(SENT and "нет в списке" in SENT[-1][1], "чужой человек получает отказ, а не данные")
c = db.get_connection(); bad = c.execute("SELECT * FROM express_log WHERE ok = 0 AND kind = 'command' ORDER BY id DESC LIMIT 1").fetchone(); c.close()
ok(bad and "stranger" in bad["text"], "в журнале обмена виден логин постороннего (админ может завести контакт)")
ok(not say("/start", chat="55555555-5555-5555-5555-555555555555", chat_type="group_chat") , "групповой чат не обслуживается")

# ------------------------------------------------------------------ диалог
menu = press("Внести", out[0])[0]
ok("Пока ничего не внесено" in menu[1] and "Альфа" in str(buttons(menu)) and "Бета" in str(buttons(menu)), "меню: подрядчики объекта")
out = press("Альфа")
ok(out and "Найти по названию" in str(buttons(out[-1])), "выбран подрядчик → экран видов работ с поиском")
say_search = press("Найти")
ok("названия или код" in say_search[-1][1], "поиск: бот просит слово")
out = say("арматур")
ok(out and "3.3. Арматура" in str(buttons(out[-1])), "поиск по части названия без учёта регистра находит вид работ")
out = say("130-01")
ok(out and "3.1.1. Бетон" in str(buttons(out[-1])), "поиск по коду")
out = say("неттакого")
ok("Ничего не нашлось" in out[-1][1], "пустой поиск: понятное сообщение")
out = say("арматур"); out = press("3.3. Арматура")
ok("РАБОЧИХ" in out[-1][1], "выбран вид работ → вопрос про рабочих")
ok("число" in say("много")[-1][1], "нечисловой ввод отклоняется с подсказкой")
ok("число" in say("-5")[-1][1] and "число" in say("100001")[-1][1], "отрицательное и слишком большое отклоняются")
out = say("12")
ok("ИТР" in out[-1][1] and any(b["label"] == "0" for b in buttons(out[-1])), "рабочие приняты → вопрос про ИТР с кнопкой «0»")
out = say("3")
ok(any("Записано" in m[1] for m in out), "ИТР введены → строка записана сразу")
c = db.get_connection()
rec = c.execute("SELECT * FROM headcount_records WHERE object_id = ? AND contractor_id = ? AND codifier_id = ?", (OBJ, CON["7701000001"], W["130-03"])).fetchone()
ok(rec and rec["workers"] == 12 and rec["itr"] == 3 and rec["source"] == "bot" and rec["work_date"] == "2026-10-23", "в headcount_records: 12/3, источник bot, нужный день")
hist = c.execute("SELECT * FROM headcount_history WHERE record_id = ?", (rec["id"],)).fetchall()
ok(len(hist) == 1 and hist[0]["source"] == "bot" and hist[0]["old_workers"] is None, "история: создание источником bot")
ok(rec["entered_by"] is None, "автор — не учётная запись (контакт бота)")
q = c.execute("SELECT status, answered_at FROM express_requests WHERE id = ?", (RID,)).fetchone(); c.close()
ok(q["status"] == "answered" and q["answered_at"], "запрос перешёл в answered")
ok(any("Внесено за день" in m[1] and "Альфа" in m[1] for m in out), "после записи меню снова с итогом дня")

# вторая строка кнопкой «0» у ИТР; замена числа
out = press("Бета", out[-1]); out = press("Найти"); out = say("бетон"); out = press("3.1.1. Бетон"); out = say("7")
out = press("0", out[-1])
c = db.get_connection(); r2 = c.execute("SELECT workers, itr FROM headcount_records WHERE contractor_id = ? AND codifier_id = ?", (CON["7701000002"], W["130-01-01"])).fetchone(); c.close()
ok(r2 and r2["workers"] == 7 and r2["itr"] == 0, "кнопка «0» у ИТР: запись 7/0")
out = press("Альфа", out[-1]); out = press("Найти"); out = say("арматур"); out = press("3.3. Арматура")
ok("Сейчас внесено: рабочие 12, ИТР 3" in out[-1][1], "при повторном вводе показано текущее значение")
out = say("20"); out = say("4")
ok(any("Заменено" in m[1] for m in out), "повторный ввод заменяет число")
c = db.get_connection()
rec = c.execute("SELECT workers, itr FROM headcount_records WHERE id = ?", (rec["id"],)).fetchone()
hist = c.execute("SELECT old_workers, new_workers, old_itr, new_itr, source FROM headcount_history WHERE record_id = ? ORDER BY id", (hc and c.execute("SELECT id FROM headcount_records WHERE contractor_id=? AND codifier_id=?", (CON["7701000001"], W["130-03"])).fetchone()["id"],)).fetchall(); c.close()
ok(rec["workers"] == 20 and rec["itr"] == 4 and len(hist) == 2 and (hist[1]["old_workers"], hist[1]["new_workers"], hist[1]["old_itr"], hist[1]["new_itr"]) == (12, 20, 3, 4), "история: было 12/3 → стало 20/4")

# запрет «0 и 0»
out = press("Альфа", out[-1]); out = press("Найти"); out = say("земл"); out = press("Земляные"); out = say("0"); out = say("0")
ok(any("не меньше 1" in m[1] for m in out), "0 рабочих и 0 ИТР не записываются, бот объясняет почему")
c = db.get_connection(); ok(c.execute("SELECT 1 FROM headcount_records WHERE codifier_id = ?", (W["340-03-02"],)).fetchone() is None, "пустая строка в БД не попала"); c.close()
# выведенный из действия вид работ не находится поиском
say("/hc", {"a": "search", "r": RID})
out = say("выведен")
ok(out and "Ничего не нашлось" in out[-1][1], "выведенный вид работ в поиске не предлагается")

# защита кнопок
foreign = {"a": "con", "r": 999999, "c": CON["7701000001"]}
ok("не найден" in say("/hc", foreign)[-1][1], "кнопка с несуществующим запросом отклонена")
c = db.get_connection(); c.execute("UPDATE express_contacts SET chat_id='66666666-6666-6666-6666-666666666666', user_huid='77777777-7777-7777-7777-777777777777' WHERE id = ?", (PETR,)); c.commit(); c.close()
ok("не найден" in say("/hc", {"a": "menu", "r": RID}, huid="77777777-7777-7777-7777-777777777777", login="petrov", chat="66666666-6666-6666-6666-666666666666")[-1][1], "чужой запрос чужой кнопкой не открывается")

# отчёт по записанному
c = db.get_connection()
tot = c.execute("SELECT SUM(workers) w, SUM(itr) i FROM headcount_records WHERE object_id = ? AND work_date = '2026-10-23'", (OBJ,)).fetchone(); c.close()
ok((tot["w"], tot["i"]) == (27, 4), "итог дня по объекту 27 рабочих / 4 ИТР")

# ------------------------------------------------------------------ напоминание и сводка
c = db.get_connection()
c.execute("INSERT INTO express_requests (schedule_id, object_id, contact_id, work_date, status) VALUES (NULL, ?, ?, '2026-10-22', 'sent')", (OBJ, IVAN)); c.commit(); c.close()
SENT.clear()
st = es.tick(FRI + timedelta(hours=1))
ok(st["reminded"] == 0, "ответивший (answered) напоминания не получает")
c = db.get_connection(); c.execute("UPDATE express_requests SET status='sent' WHERE id = ?", (RID,)); c.commit(); c.close()
st = es.tick(FRI + timedelta(hours=1))
ok(st["reminded"] == 1 and any("Напоминание" in m[1] for m in SENT), "не ответившему уходит напоминание в 11:30")
SENT.clear()
ok(es.tick(FRI + timedelta(hours=1, minutes=5))["reminded"] == 0 and not SENT, "напоминание не повторяется")
SENT.clear()
st = es.tick(FRI + timedelta(hours=2))
ok(st["summaries"] == 1 and SENT and SENT[-1][0] == "66666666-6666-6666-6666-666666666666" and "Итого: рабочие 27, ИТР 4" in SENT[-1][1], "сводка в 12:30 уходит адресату сводки с итогом дня")
ok(es.tick(FRI + timedelta(hours=2, minutes=1))["summaries"] == 0, "сводка не повторяется")

# закрытие
c = db.get_connection(); c.execute("UPDATE express_requests SET status='answered' WHERE id = ?", (RID,)); c.commit(); c.close()
out = say("/hc", {"a": "close", "r": RID})
ok(any("закрыт" in m[1] and "рабочие 27" in m[1] for m in out), "«Готово»: запрос закрыт, итог в ответе")
ok("уже закрыт" in say("/hc", {"a": "menu", "r": RID})[-1][1], "после закрытия кнопки не работают")
c = db.get_connection(); c.execute("UPDATE express_requests SET status='closed' WHERE contact_id = ? AND status IN ('sent', 'answered')", (IVAN,)); c.commit(); c.close()
ok("нет открытых запросов" in say("привет")[-1][1], "свободный текст без открытого запроса — подсказка")

# ------------------------------------------------------------------ расписание: правка и догон
c = db.get_connection()
c.execute("UPDATE express_schedules SET effective_from = ? WHERE id = ?", ((datetime(2026, 10, 26, 10, 31)).strftime("%Y-%m-%d %H:%M:%S"), SCH)); c.commit(); c.close()
MON = datetime(2026, 10, 26, 10, 30, tzinfo=hc.MSK)
ok(es.tick(MON)["created"] == 0, "расписание правили после 10:30 (в UTC позже) — сегодня не срабатывает")
c = db.get_connection(); c.execute("UPDATE express_schedules SET effective_from = '2000-01-01 00:00:00', day_offset = -1 WHERE id = ?", (SCH,)); c.commit(); c.close()
SENT.clear(); es.tick(MON)
c = db.get_connection(); q2 = c.execute("SELECT work_date FROM express_requests WHERE schedule_id = ? ORDER BY id DESC LIMIT 1", (SCH,)).fetchone(); c.close()
ok(q2["work_date"] == "2026-10-25", "смещение -1: в понедельник спрашиваем за воскресенье")

# повтор при сбое сервера
STATE["down"] = True
c = db.get_connection(); c.execute("INSERT INTO express_requests (schedule_id, object_id, contact_id, work_date, status) VALUES (NULL, ?, ?, '2026-10-21', 'pending')", (OBJ, IVAN)); c.commit(); c.close()
st = es.tick(MON + timedelta(minutes=10))
c = db.get_connection(); f = c.execute("SELECT status, attempts, last_error FROM express_requests WHERE work_date = '2026-10-21'").fetchone(); c.close()
ok(f["status"] == "failed" and "eXpress" in f["last_error"], "сервер eXpress недоступен → failed с понятной причиной")
STATE["down"] = False
a0 = f["attempts"]
ok(es.tick(MON + timedelta(minutes=11))["retried"] == 0, "повтор не раньше чем через 5 минут")
st = es.tick(MON + timedelta(minutes=20))
c = db.get_connection(); f = c.execute("SELECT status, attempts FROM express_requests WHERE work_date = '2026-10-21'").fetchone(); c.close()
ok(f["status"] == "sent" and f["attempts"] == a0 + 1, "после восстановления связи запрос доставлен повтором")

# ручная отправка и поиск пользователя
c = db.get_connection(); rid = es.create_manual(c, OBJ, IVAN, date(2026, 10, 23), admin["id"])
ok(c.execute("SELECT status FROM express_requests WHERE id = ?", (rid,)).fetchone()["status"] == "sent", "ручная отправка доставлена"); c.close()
ok(eb.find_user_by_email("known@corp.ru")["user_huid"] == "11111111-1111-1111-1111-111111111111" and eb.find_user_by_email("none@corp.ru") is None, "поиск пользователя eXpress по e-mail")

# ------------------------------------------------------------------ настоящие HTTP-маршруты
import uvicorn
from app.main import app
import socket
sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started: break
    time.sleep(0.2)
ok(server.started, "сервер поднят")
def http(method, path, body=None, auth=True):
    h = {"Content-Type": "application/json"}
    if auth: h["Authorization"] = "Bearer " + jwt({"iss": BOT_ID, "aud": "host", "exp": time.time() + 60})
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
st, body = http("GET", "/status")
ok(st == 200 and body["result"]["commands"][0]["body"] == "/start", "GET /status отвечает списком команд")
ok(http("GET", "/status", auth=False)[0] == 401 and http("POST", "/command", {}, auth=False)[0] == 401 and http("POST", "/notification/callback", {}, auth=False)[0] == 401, "без подписи все три маршрута дают 401")
SENT.clear()
st, body = http("POST", "/command", {"from": sender(), "command": {"body": "/start", "data": {}, "command_type": "user"}, "bot_id": BOT_ID})
ok(st == 202 and body["result"] == "accepted", "POST /command принят (202)")
for _ in range(50):
    if SENT: break
    time.sleep(0.1)
ok(SENT, "входящая команда обработана рабочим потоком, ответ ушёл в макет CTS")
st, _ = http("POST", "/notification/callback", {"sync_id": "s", "status": "error", "reason": "chat_not_found"})
ok(st == 200, "POST /notification/callback принят")
c = db.get_connection(); ok(c.execute("SELECT 1 FROM express_log WHERE kind = 'system' AND ok = 0 AND error LIKE '%chat_not_found%'").fetchone(), "ошибка доставки из callback попала в журнал"); c.close()

# выключенный бот не отвечает
c = db.get_connection(); c.execute("UPDATE express_config SET enabled = 0"); c.commit(); c.close()
SENT.clear(); say("/start")
ok(not SENT and es.tick(FRI)["created"] == 0, "выключенный бот молчит, расписание не срабатывает")
server.should_exit = True
print("\nВсе проверки пройдены")

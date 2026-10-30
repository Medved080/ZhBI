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
_r = eb.ping()
ok(_r["ok"] and _r["auth"] == "v2", "ping: настоящий вызов BotX API; при обеих схемах первой работает v2 (JWT, как в pybotx)")
_jwt = eb.build_jwt_v2({"cts_url": "https://cts.example.ru:8443/x", "bot_id": BOT_ID}, KEY, now=1000)
_claims = json.loads(base64.urlsafe_b64decode(_jwt.split(".")[1] + "=="))
ok(_claims["iss"] == BOT_ID and _claims["aud"] == "cts.example.ru" and _claims["exp"] == 1060 and _claims["nbf"] == 1000 and _claims["version"] == 2 and len(_claims["jti"]) == 24,
   "JWT v2: iss — бот, aud — имя хоста без схемы и порта, срок 60 с, nbf, jti, version=2")
STATE["auth"] = "v1only"; eb._drop_token()
_r = eb.ping(); eb.send_message("chat-x", "проба")
ok(_r["auth"] == "v1" and eb._auth_mode["v"] == "v1" and SENT and SENT[-1][1] == "проба", "CTS принимает только токен v1: клиент переходит на запасную схему и отправляет")
STATE["auth"] = "v2only"; eb._drop_token()
_r = eb.ping(); eb.send_message("chat-y", "проба2")
ok(_r["auth"] == "v2" and SENT[-1][1] == "проба2", "CTS принимает только JWT v2: отправка проходит без токена v1")
STATE["auth"] = "none"; eb._drop_token()
try:
    eb.ping(); ok(False, "отказ по обеим схемам должен давать ошибку")
except eb.BotxError as _e:
    ok("HTTP 401" in str(_e) and "обеим схемам" in str(_e), "CTS отклоняет обе схемы: «Проверить связь» сообщает об отказе, а не «связь есть»")
try:
    eb.send_message("chat-z", "x"); ok(False, "отправка при отказе")
except eb.BotxError as _e:
    ok("unauthorized" in str(_e) and "HTTP 401" in str(_e), "отправка при отказе по обеим схемам: ошибка с кодом и причиной CTS")
STATE["auth"] = "both"; eb._drop_token(); SENT.clear()
ok(KEY not in eb.redact(f"ошибка {KEY}") and "***" in eb.redact(f"ошибка {KEY}"), "redact убирает ключ из текстов")

# ------------------------------------------------------------------ JWT
jwt = sign_jwt
good = {"iss": BOT_ID, "aud": "host", "exp": time.time() + 60}
ok(eb.verify_incoming("Bearer " + jwt(good)), "верный JWT (iss = бот) принят")
ok(eb.verify_incoming("Bearer " + jwt({"iss": "cts.corp", "aud": [BOT_ID], "exp": time.time() + 60})), "верный JWT (aud = [бот]) принят")
ok(eb.verify_incoming("Bearer " + jwt({"iss": BOT_ID.upper(), "aud": "host", "exp": time.time() + 60})), "UUID бота в токене сравнивается без учёта регистра")
ok("iss=" in eb.describe_token("Bearer " + jwt(good)) and KEY not in eb.describe_token("Bearer " + jwt(good)), "describe_token показывает iss/aud и не содержит ключа")
_e = str(eb._fail(401, {"reason": "unauthorized", "errors": ["bad token"]}, "Сообщение не отправлено"))
ok("unauthorized" in _e and "HTTP 401" in _e and "bad token" in _e, "ошибка отправки называет код ответа CTS и его подробности")
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
IVAN_IND = ind["id"]
OTHER_IND = c.execute("INSERT INTO individuals (name) VALUES ('Другой Ответственный')").lastrowid
c.commit(); c.close()

# Виды работ подрядчиков и ответственные (физлицо из справочника): Иванов отвечает за «Альфа + Арматура» и «Бета + Бетон», чужая строка — «Альфа + Земляные»
CW = {}
for _ctr, _work, _who in (("7701000001", "130-03", IVAN_IND), ("7701000002", "130-01-01", IVAN_IND), ("7701000001", "340-03-02", OTHER_IND)):
    CW[(_ctr, _work)] = hc.add_contractor_work(OBJ, CON[_ctr], hc.ContractorWorkIn(codifier_id=W[_work], responsible_id=_who), user=admin)["id"]

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

# ------------------------------------------------------------------ диалог: бот спрашивает только строки, где контакт — ответственный
ok("Строк, за которые вы ответственны: 2" in out[0][1], "приглашение называет число строк контакта")
menu = press("Внести", out[0])[0]
btns = str(buttons(menu))
ok("внесено 0 из 2" in menu[1] and "130-03" in btns and "130-01-01" in btns and "340-03-02" not in btns,
   "меню: только строки, где контакт назначен ответственным (чужая строка «Альфа + Земляные» не показана)")
ok("Альфа" in btns and "Бета" in btns, "кнопка строки называет подрядчика и вид работ")
out = press("130-03")
ok("РАБОЧИХ" in out[-1][1] and "Альфа" in out[-1][1], "выбрана строка → сразу вопрос про рабочих (выбора подрядчика и поиска вида работ больше нет)")
ok("число" in say("много")[-1][1], "нечисловой ввод отклоняется с подсказкой")
ok("число" in say("-5")[-1][1] and "число" in say("100001")[-1][1], "отрицательное и слишком большое отклоняются")
out = say("12")
ok("ИТР" in out[-1][1] and any(b["label"] == "0" for b in buttons(out[-1])), "рабочие приняты → вопрос про ИТР с кнопкой «0»")
out = say("3")
ok("МЕХАНИЗАТОР" in out[-1][1] and any(b["label"] == "0" for b in buttons(out[-1])), "ИТР приняты → вопрос про механизаторов с кнопкой «0»")
ok("число" in say("много")[-1][1], "механизаторы: нечисловой ввод отклоняется")
out = say("2")
ok(any("Записано" in m[1] for m in out), "механизаторы введены → строка записана сразу")
c = db.get_connection()
rec = c.execute("SELECT * FROM headcount_records WHERE object_id = ? AND contractor_id = ? AND codifier_id = ?", (OBJ, CON["7701000001"], W["130-03"])).fetchone()
ok(rec and rec["workers"] == 12 and rec["itr"] == 3 and rec["mech"] == 2 and rec["source"] == "bot" and rec["work_date"] == "2026-10-23", "в headcount_records: 12/3/2, источник bot, нужный день")
hist = c.execute("SELECT * FROM headcount_history WHERE record_id = ?", (rec["id"],)).fetchall()
ok(len(hist) == 1 and hist[0]["source"] == "bot" and hist[0]["old_workers"] is None, "история: создание источником bot")
ok(rec["entered_by"] is None, "автор — не учётная запись (контакт бота)")
q = c.execute("SELECT status, answered_at FROM express_requests WHERE id = ?", (RID,)).fetchone(); c.close()
ok(q["status"] == "answered" and q["answered_at"], "запрос перешёл в answered")
ok("внесено 1 из 2" in out[-1][1] and "✓" in str(buttons(out[-1])) and "Итого по вашим строкам: рабочие 12" in out[-1][1], "после записи меню отмечает внесённую строку ✓ и показывает итог по строкам контакта")

# вторая строка: кнопка «0» у ИТР и механизаторов
out = press("130-01-01", out[-1]); out = say("7")
out = press("0", out[-1]); out = press("0", out[-1])
c = db.get_connection(); r2 = c.execute("SELECT workers, itr, mech FROM headcount_records WHERE contractor_id = ? AND codifier_id = ?", (CON["7701000002"], W["130-01-01"])).fetchone(); c.close()
ok(r2 and r2["workers"] == 7 and r2["itr"] == 0 and r2["mech"] == 0, "кнопка «0» у ИТР и у механизаторов: запись 7/0/0")
out = press("130-03", out[-1])
ok("Сейчас внесено: рабочие 12, ИТР 3, механизаторы 2" in out[-1][1], "при повторном вводе показано текущее значение")
out = say("20"); out = say("4"); out = say("1")
ok(any("Заменено" in m[1] for m in out), "повторный ввод заменяет число")
c = db.get_connection()
rec = c.execute("SELECT workers, itr, mech FROM headcount_records WHERE id = ?", (rec["id"],)).fetchone()
hist = c.execute("SELECT old_workers, new_workers, old_itr, new_itr, old_mech, new_mech, source FROM headcount_history WHERE record_id = ? ORDER BY id", (c.execute("SELECT id FROM headcount_records WHERE contractor_id=? AND codifier_id=?", (CON["7701000001"], W["130-03"])).fetchone()["id"],)).fetchall(); c.close()
ok(rec["workers"] == 20 and rec["itr"] == 4 and len(hist) == 2 and (hist[1]["old_workers"], hist[1]["new_workers"], hist[1]["old_itr"], hist[1]["new_itr"], hist[1]["old_mech"], hist[1]["new_mech"]) == (12, 20, 3, 4, 2, 1), "история: было 12/3/2 → стало 20/4/1")

# запрет «0 и 0 и 0»
out = press("130-01-01", out[-1]); out = say("0"); out = say("0"); out = say("0")
ok(any("не меньше 1" in m[1] for m in out), "0 рабочих, 0 ИТР и 0 механизаторов не записываются, бот объясняет почему")
c = db.get_connection(); ok(c.execute("SELECT workers FROM headcount_records WHERE contractor_id = ? AND codifier_id = ?", (CON["7701000002"], W["130-01-01"])).fetchone()["workers"] == 7, "прежняя запись при отказе не изменилась"); c.close()

# чужая строка недоступна: кнопка со строкой другого ответственного, выведенный вид работ, строка, снятая посреди диалога
foreign_row = CW[("7701000001", "340-03-02")]
out = say("/hc", {"a": "row", "r": RID, "i": foreign_row})
ok("не закреплена" in out[0][1], "кнопка с чужой строкой отклонена: ответственный — другой человек")
c = db.get_connection(); c.execute("INSERT INTO headcount_contractor_works (contractor_id, codifier_id, responsible_id) VALUES (?, ?, ?)", (CON["7701000001"], W["999-X"], IVAN_IND)); c.commit(); c.close()
out = say("/hc", {"a": "menu", "r": RID})
ok("из 2" in out[-1][1] and "Выведен" not in str(buttons(out[-1])), "выведенный из действия вид работ контакту не предлагается")
out = say("/hc", {"a": "con", "r": RID, "c": CON["7701000001"]})
ok("Ваши строки" in out[-1][1], "кнопки прежней версии диалога (выбор подрядчика) показывают актуальный список строк")
out = press("130-03", out[-1])
hc.set_contractor_work_responsible(OBJ, CON["7701000001"], CW[("7701000001", "130-03")], hc.ResponsibleIn(responsible_id=OTHER_IND), user=admin)
out = say("30"); out = say("0"); out = say("0")
c = db.get_connection(); w30 = c.execute("SELECT workers FROM headcount_records WHERE contractor_id = ? AND codifier_id = ?", (CON["7701000001"], W["130-03"])).fetchone()["workers"]; c.close()
ok(any("больше за вами не закреплена" in m[1] for m in out) and w30 == 20, "строку переназначили посреди диалога: число не записывается, бот сообщает об этом")
hc.set_contractor_work_responsible(OBJ, CON["7701000001"], CW[("7701000001", "130-03")], hc.ResponsibleIn(responsible_id=IVAN_IND), user=admin)

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
ok("Выберите действие" in say("привет")[-1][1], "свободный текст без открытого запроса — главное меню и подсказка")

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

# ------------------------------------------------------------------ привязка по одноразовому коду и телефон
from fastapi import HTTPException
from app import express_api as api_mod
STATE["auth"] = "both"; eb._drop_token(); SENT.clear()
c = db.get_connection(); c.execute("UPDATE express_config SET enabled = 1"); c.commit(); c.close()

def code_contact(name, **fields):
    """Контакт заводится только из справочника физлиц: для проверки на каждое имя заводится своё физлицо."""
    c = db.get_connection(); iid = c.execute("INSERT INTO individuals (name) VALUES (?)", (name,)).lastrowid; c.commit(); c.close()
    return api_mod.create_contact(api_mod.ContactIn(individual_id=iid, **fields), user=admin)
ext = code_contact("Внешний Подрядчик", phone="+7 (900) 000-00-00")
ok(ext["phone"] == "+7 (900) 000-00-00" and not ext["code_active"] and not ext["bound"], "контакт с телефоном заведён (телефон справочный, кода нет)")
try:
    code_contact("Плохой", phone="звоните вечером"); ok(False, "телефон с буквами должен отклоняться")
except HTTPException as e:
    ok(e.status_code == 400, "телефон: буквы отклоняются")
issued = api_mod.issue_bind_code(ext["id"], user=admin)
CODE = issued["code"]
ok(len(CODE) == 9 and CODE[4] == "-" and set(CODE.replace("-", "")) <= set(ed.CODE_ALPHABET), "код: 8 знаков из алфавита без I, O, 0, 1, показан как ABCD-EFGH")
c = db.get_connection(); row = c.execute("SELECT * FROM express_contacts WHERE id = ?", (ext["id"],)).fetchone()
dump = " ".join(str(v) for v in tuple(row)) + " ".join(str(tuple(r)) for r in c.execute("SELECT * FROM express_log")); c.close()
ok(CODE not in dump and CODE.replace("-", "") not in dump and row["bind_code_hash"] == ed.hash_code(CODE), "в БД и журнале нет самого кода — только sha256")
ok(api_mod.list_contacts(user=admin) and next(x for x in api_mod.list_contacts(user=admin) if x["id"] == ext["id"])["code_active"], "в списке контактов виден «код выдан»")

NEW_HUID, NEW_CHAT = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000001"
def ext_say(body, huid=NEW_HUID, chat=NEW_CHAT):
    return say(body, huid=huid, login=None, chat=chat)
bad = ext_say("/start ZZZZ-ZZZZ")
ok(bad and "не подошёл" in bad[-1][1], "неверный код: бот отвечает отказом и подсказывает, что делать")
ok(ext_say("привет") and "нет в списке" in SENT[-1][1] and "/start КОД" in SENT[-1][1], "незнакомому на обычное сообщение — отказ с подсказкой про код привязки")
out = ext_say("/start " + CODE.lower().replace("-", " "))
ok(out and "привязаны как «Внешний Подрядчик»" in out[0][1], "верный код (в любом регистре, с пробелом вместо дефиса) привязывает аккаунт")
c = db.get_connection(); row = c.execute("SELECT * FROM express_contacts WHERE id = ?", (ext["id"],)).fetchone(); c.close()
ok(row["user_huid"] == NEW_HUID and row["chat_id"] == NEW_CHAT and row["bound_at"] and row["bind_code_hash"] is None and row["bind_code_expires"] is None,
   "контакт привязан без e-mail и логина: аккаунт и личный чат записаны, код погашен")
ok("не подошёл" in ext_say("/start " + CODE, huid="aaaaaaaa-0000-0000-0000-000000000002", chat="bbbbbbbb-0000-0000-0000-000000000002")[-1][1], "использованный код повторно не работает")
out = ext_say("/start")
ok(out and not any("не подошёл" in m[1] or "нет в списке" in m[1] for m in out), "после привязки этот человек — обычный контакт: /start принимается")
out = ext_say("/start QQQQ-QQQQ")
ok(out and not any("не подошёл" in m[1] for m in out), "известный контакт с лишним аргументом после /start: аргумент игнорируется, ошибки кода нет")
out = ext_say("ABCD2345")
ok(not any("не подошёл" in m[1] for m in out), "известному контакту слово, похожее на код, кодом не считается")

# срок действия
issued = api_mod.issue_bind_code(ext["id"], user=admin)
c = db.get_connection(); c.execute("UPDATE express_contacts SET bind_code_expires = datetime('now', '-1 minute') WHERE id = ?", (ext["id"],)); c.commit(); c.close()
ed._FAILS.clear()
ok("не подошёл" in say("/start " + issued["code"], huid="aaaaaaaa-0000-0000-0000-000000000003", login=None, chat="bbbbbbbb-0000-0000-0000-000000000003")[-1][1], "истёкший код не принимается")
ok(next(x for x in api_mod.list_contacts(user=admin) if x["id"] == ext["id"])["code_active"] is False, "истёкший код в списке контактов не показывается как действующий")

# перепривязка по новому коду (человек сменил аккаунт)
issued = api_mod.issue_bind_code(ext["id"], user=admin)
OTHER_HUID, OTHER_CHAT = "aaaaaaaa-0000-0000-0000-000000000004", "bbbbbbbb-0000-0000-0000-000000000004"
out = say("/start " + issued["code"], huid=OTHER_HUID, login=None, chat=OTHER_CHAT)
c = db.get_connection(); row = c.execute("SELECT user_huid, chat_id FROM express_contacts WHERE id = ?", (ext["id"],)).fetchone(); c.close()
ok(out and row["user_huid"] == OTHER_HUID and row["chat_id"] == OTHER_CHAT, "новый код перепривязывает контакт к другому аккаунту eXpress")

# один аккаунт — один контакт
second = code_contact("Второй Контакт")
issued2 = api_mod.issue_bind_code(second["id"], user=admin)
out = say("/start " + issued2["code"], huid=OTHER_HUID, login=None, chat=OTHER_CHAT)
c = db.get_connection(); row2 = c.execute("SELECT user_huid FROM express_contacts WHERE id = ?", (second["id"],)).fetchone(); c.close()
ok(out and "уже привязан к контакту «Внешний Подрядчик»" in out[-1][1] and row2["user_huid"] is None, "аккаунт, уже привязанный к другому контакту, второй код не принимает")

# подбор: пять неверных кодов с аккаунта — и блокировка, даже верный код не пройдёт, пока окно не истечёт
ed._FAILS.clear()
BR_HUID, BR_CHAT = "aaaaaaaa-0000-0000-0000-000000000005", "bbbbbbbb-0000-0000-0000-000000000005"
for _i in range(ed.FAIL_LIMIT):
    say("/start ZZZZ-ZZZ" + "ABCDE"[_i], huid=BR_HUID, login=None, chat=BR_CHAT)
out = say("/start " + issued2["code"], huid=BR_HUID, login=None, chat=BR_CHAT)
ok(out and "Слишком много" in out[-1][1], "после пяти неверных кодов аккаунт блокируется на десять минут, верный код тоже не принимается")
ed._FAILS.clear()
out = say("/start " + issued2["code"], huid=BR_HUID, login=None, chat=BR_CHAT)
ok(out and "привязаны как «Второй Контакт»" in out[0][1], "после окончания блокировки верный код работает")

# отключённому контакту код не выдаётся
c = db.get_connection(); c.execute("UPDATE express_contacts SET active = 0 WHERE id = ?", (second["id"],)); c.commit(); c.close()
try:
    api_mod.issue_bind_code(second["id"], user=admin); ok(False, "отключённому контакту код выдавать нельзя")
except HTTPException as e:
    ok(e.status_code == 400, "отключённому контакту код не выдаётся")
SENT.clear()

# ------------------------------------------------------------------ контакт — только из справочника физлиц; нет строк — не спрашиваем
try:
    api_mod.create_contact(api_mod.ContactIn(name="Без справочника"), user=admin); ok(False, "контакт без физлица должен отклоняться")
except HTTPException as e:
    ok(e.status_code == 400 and "справочника физлиц" in e.detail, "контакт без физлица из справочника не создаётся (имя вручную больше не принимается)")
try:
    api_mod.create_contact(api_mod.ContactIn(individual_id=IVAN_IND), user=admin); ok(False, "второй контакт на то же физлицо")
except HTTPException as e:
    ok(e.status_code == 409, "второй контакт на то же физлицо не заводится")
c = db.get_connection(); ind_name = c.execute("SELECT name FROM individuals WHERE id = ?", (OTHER_IND,)).fetchone()["name"]; c.close()
_oc = api_mod.create_contact(api_mod.ContactIn(individual_id=OTHER_IND, name="Имя, набранное руками"), user=admin)
ok(_oc["name"] == ind_name, "имя контакта берётся из справочника физлиц, а не из введённого")

norows = code_contact("Контакт без строк")
c = db.get_connection()
c.execute("INSERT INTO express_schedules (object_id, contact_id, weekdays, send_time, day_offset, effective_from) VALUES (?, ?, '1,2,3,4,5,6,7', '10:30', 0, '2000-01-01 00:00:00')", (OBJ, norows["id"]))
c.commit(); c.close()
SENT.clear()
st = es.tick(FRI)
c = db.get_connection(); nq = c.execute("SELECT * FROM express_requests WHERE contact_id = ?", (norows["id"],)).fetchone(); c.close()
ok(st["skipped"] == 1 and nq and nq["status"] == "closed" and "не закреплено ни одной строки" in nq["last_error"] and nq["attempts"] == 0 and nq["sent_at"] is None,
   "у контакта нет строк, где он ответственный: запрос не отправляется (попыток 0), фиксируется закрытым с причиной")
ok(es.tick(FRI)["skipped"] == 0, "повторный обход не повторяет пропуск (пара «расписание + день» занята)")
try:
    api_mod.send_now(OBJ, api_mod.SendNowIn(contact_id=norows["id"]), user=admin); ok(False, "ручной запрос без строк")
except HTTPException as e:
    ok(e.status_code == 400 and "Подрядчики" in e.detail, "«Спросить сейчас» контакту без строк отклоняется с указанием, где назначить ответственного")
try:
    api_mod.send_now(OBJ, api_mod.SendNowIn(contact_id=PETR), user=admin); ok(False, "ручной запрос контакту без физлица")
except HTTPException as e:
    ok(e.status_code == 400 and "не привязан к физлицу" in e.detail, "контакт не из справочника: ручной запрос отклоняется, подсказка выбрать физлицо")
c = db.get_connection(); c.execute("UPDATE express_contacts SET active = 0 WHERE id = ?", (norows["id"],)); c.commit(); c.close()

# ------------------------------------------------------------------ виды работ подрядчика: API
cl = hc.list_contractors(OBJ, user=admin)["contractors"]
alfa = next(x for x in cl if x["id"] == CON["7701000001"])
ok(len(alfa["works"]) >= 3 and any(w["responsible_id"] == IVAN_IND for w in alfa["works"]), "список подрядчиков отдаёт виды работ с ответственными")
try:
    hc.add_contractor_work(OBJ, CON["7701000001"], hc.ContractorWorkIn(codifier_id=W["130-03"]), user=admin); ok(False, "дубль вида работ")
except HTTPException as e:
    ok(e.status_code == 409, "тот же вид работ подрядчику второй раз не добавляется")
try:
    hc.add_contractor_work(OBJ, CON["7701000001"], hc.ContractorWorkIn(codifier_id=W["999-X"]), user=admin); ok(False, "выведенный вид работ")
except HTTPException as e:
    ok(e.status_code == 400, "выведенный из действия вид работ подрядчику не добавляется")
try:
    hc.set_contractor_work_responsible(OBJ, CON["7701000001"], CW[("7701000001", "130-03")], hc.ResponsibleIn(responsible_id=99999999), user=admin); ok(False, "ответственный вне справочника")
except HTTPException as e:
    ok(e.status_code == 400, "ответственный выбирается только из справочника физлиц")
hc.set_contractor_work_responsible(OBJ, CON["7701000001"], CW[("7701000001", "130-03")], hc.ResponsibleIn(responsible_id=None), user=admin)
ok(not [r for r in hc.responsible_rows(db.get_connection(), OBJ, IVAN_IND) if r["id"] == CW[("7701000001", "130-03")]], "ответственный снят — строка у бота пропала")
hc.set_contractor_work_responsible(OBJ, CON["7701000001"], CW[("7701000001", "130-03")], hc.ResponsibleIn(responsible_id=IVAN_IND), user=admin)
try:
    hc.delete_contractor_work(OBJ, CON["7701000002"], CW[("7701000001", "130-03")], user=admin); ok(False, "чужой подрядчик")
except HTTPException as e:
    ok(e.status_code == 404, "вид работ нельзя убрать через другого подрядчика")

# ------------------------------------------------------------------ удаление физлица: новые ссылки учтены
from app import dict_delete
c = db.get_connection()
row = dict_delete._individual_load(c, IVAN_IND)
checks = dict_delete._сверка_ссылок(c, "individual", row)
ok(all(x["handled"] != "НЕ УЧТЕНО" for x in checks if x["label"] in ("express_contacts.individual_id", "headcount_contractor_works.responsible_id")) and len(checks) >= 6, "сверка ссылок по схеме: на физлицо ссылаются контакты бота и ответственные за виды работ, и обе ссылки объяснены")
a_id = c.execute("INSERT INTO individuals (name) VALUES ('Заменяемый А')").lastrowid
b_id = c.execute("INSERT INTO individuals (name) VALUES ('Замена Б')").lastrowid
c.execute("INSERT INTO express_contacts (individual_id, name) VALUES (?, 'Контакт А')", (a_id,))
c.execute("INSERT INTO headcount_contractor_works (contractor_id, codifier_id, responsible_id) VALUES (?, ?, ?)", (CON["7701000002"], W["340-03-02"], a_id))
c.commit()
dict_delete._individual_repoint(c, dict_delete._individual_load(c, a_id), dict_delete._individual_load(c, b_id)); c.commit()
ok(c.execute("SELECT individual_id FROM express_contacts WHERE name = 'Контакт А'").fetchone()[0] == b_id
   and c.execute("SELECT responsible_id FROM headcount_contractor_works WHERE contractor_id = ? AND codifier_id = ?", (CON["7701000002"], W["340-03-02"])).fetchone()[0] == b_id,
   "удаление физлица с заменой: контакт бота и ответственность переходят на замену")
e_id = c.execute("INSERT INTO individuals (name) VALUES ('Заменяемый В')").lastrowid
c.execute("INSERT INTO express_contacts (individual_id, name) VALUES (?, 'Контакт В')", (e_id,)); c.commit()
dict_delete._individual_repoint(c, dict_delete._individual_load(c, e_id), dict_delete._individual_load(c, b_id)); c.commit()
ok(c.execute("SELECT individual_id FROM express_contacts WHERE name = 'Контакт В'").fetchone()[0] is None, "если у замены уже есть контакт, второй не заводится: прежний остаётся без физлица, а не пропадает")
c.close()

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
ok(http("GET", "/status", auth=False)[0] == 401 and http("POST", "/command", {}, auth=False)[0] == 401 and http("POST", "/notification/callback", {}, auth=False)[0] == 200, "без подписи /status и /command дают 401, /notification/callback принимается без разбора (как в примере pybotx)")
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

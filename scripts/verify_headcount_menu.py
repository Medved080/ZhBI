"""Главное меню бота, архив подрядчиков и создание ответственного. Только на КОПИИ обезличенной БД.

ZHBI_DB_PATH=/tmp/hc-menu-verify.db .venv312/bin/python scripts/verify_headcount_menu.py
Исходящие сообщения подменены: настоящий CTS не вызывается.
"""
import os
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if not os.environ.get("ZHBI_DB_PATH") or Path(os.environ["ZHBI_DB_PATH"]).name == "zhbi.db":
    sys.exit("Нужна ZHBI_DB_PATH на копию обезличенной БД")

from fastapi import HTTPException
from app import db, express_bot as eb, express_dialog as ed, express_scheduler as es, headcount as hc, reference_catalogs as refs
from app.db_schema_doc import verify
from app.access import require_service_feature


def ok(condition, message):
    assert condition, message
    print("OK  " + message)


db.init_db()
c = db.get_connection()
admin = c.execute("SELECT * FROM users WHERE role = 'admin' LIMIT 1").fetchone()
objects = c.execute("SELECT id FROM objects ORDER BY id LIMIT 2").fetchall()
obj, other_obj = objects[0]["id"], objects[1]["id"]
ok(not [e for e in verify(c) if "headcount_" in e or "express_" in e], "Описание схемы численности и бота соответствует мигрированной базе")
person = refs.create_individual(refs.CatalogEntryIn(name="Тест Меню Ответственный"), admin=admin)
try:
    refs.create_individual(refs.CatalogEntryIn(name=person["name"]), admin=admin)
    raise AssertionError("дубль ФИО")
except HTTPException as e:
    ok(e.status_code == 409, "Повторное создание того же физлица отклоняется")
try:
    refs.create_individual(refs.CatalogEntryIn(name="  "), admin=admin)
    raise AssertionError("пустое ФИО")
except HTTPException as e:
    ok(e.status_code == 400, "Пустое ФИО отклоняется")

contact = c.execute("INSERT INTO express_contacts (individual_id, name, ad_login, user_huid, chat_id) VALUES (?, ?, 'menu-test', 'menu-user', 'menu-chat')",
                    (person["id"], person["name"])).lastrowid
ctr = c.execute("INSERT INTO headcount_contractors (object_id, name_raw) VALUES (?, 'Тест меню подрядчик')", (obj,)).lastrowid
foreign_ctr = c.execute("INSERT INTO headcount_contractors (object_id, name_raw) VALUES (?, 'Чужой подрядчик меню')", (other_obj,)).lastrowid
work = c.execute("INSERT INTO work_codifier (code, name) VALUES ('MENU-TEST', '987654. Работы меню')").lastrowid
work2 = c.execute("INSERT INTO work_codifier (code, name) VALUES ('MENU-OTHER', '987655. Другие работы меню')").lastrowid
c.commit()
cw = hc.add_contractor_work(obj, ctr, hc.ContractorWorkIn(codifier_id=work, responsible_id=person["id"]), user=admin)["id"]
hc.add_contractor_work(obj, ctr, hc.ContractorWorkIn(codifier_id=work2), user=admin)
c.close()

sent = []


def say(text="/hc", data=None):
    sent.clear()
    ed.handle_incoming({"from": {"user_huid": "menu-user", "group_chat_id": "menu-chat", "chat_type": "chat"},
                        "command": {"body": text, "data": data or {}}})
    assert sent, "Бот должен ответить"
    for message in sent:
        actions = [b["data"]["a"] for row in message[2] for b in row]
        main = set(actions).intersection(ed.MAIN_ACTIONS)
        if main:
            assert set(actions) == set(ed.MAIN_ACTIONS) and len(actions) == 3, "Главное меню содержит только три основных действия"
        else:
            assert actions.count("home") == 1, "Каждый вложенный экран содержит ровно одну кнопку «В меню»"
    return sent[-1]


def press(label):
    buttons = [b for row in sent[-1][2] for b in row]
    b = next(b for b in buttons if label in b["label"])
    return say(data=b["data"])


def text():
    return "\n".join(m[1] for m in sent)


def open_action(label):
    if any(b["data"]["a"] == "home" for row in sent[-1][2] for b in row):
        press("В меню")
    return press(label)


fixed = datetime(2026, 10, 30, 12, tzinfo=hc.MSK)
with patch.object(eb, "is_active", return_value=True), patch.object(eb, "send_message", side_effect=lambda *a: sent.append(a)), patch.object(hc, "now_msk", return_value=fixed):
    say("/start")
    ok({b["label"] for row in sent[-1][2] for b in row} == set(ed.MAIN_ACTIONS.values()), "Без расписания /start показывает три основных действия")
    for label, expected in (("Внести численность", {"За сегодня", "На дату", "В меню"}),
                            ("Уточнить данные", {"За сегодня", "На дату", "В меню"}),
                            ("Получить сводку", {"Сегодня", "Неделя", "Месяц", "В меню"})):
        press(label)
        ok({b["label"] for row in sent[-1][2] for b in row} == expected, f"{label}: только кнопки раздела и «В меню»")
        press("В меню")
        ok({b["label"] for row in sent[-1][2] for b in row} == set(ed.MAIN_ACTIONS.values()), "«В меню» возвращает три основных действия")
    say("/entry"); ok("Выберите дату" in text(), "Команда из меню eXpress запускает самостоятельный ввод")
    open_action("Внести численность"); press("На дату")
    say("31.02.2026"); ok("существующая дата" in text(), "Неверная дата отклонена")
    say("31.10.2026"); ok("будущую дату" in text(), "Будущая дата отклонена")
    say("01.09.2026"); ok("01.09.2026" in text(), "Самостоятельный ввод за давнюю дату без запроса по расписанию")
    press("MENU-TEST"); press("В меню"); say("999")
    c = db.get_connection()
    ok(c.execute("SELECT COUNT(*) FROM headcount_records WHERE contractor_id = ?", (ctr,)).fetchone()[0] == 0,
       "Возврат в меню прерывает ввод: последующее число ничего не записывает")
    c.close()
    open_action("Внести численность"); press("На дату"); say("01.09.2026"); press("MENU-TEST")
    say("10"); say("2"); say("1")
    ok("Записано" in text() and "Все ваши строки" in text(), "Ввод сохранился за выбранную давнюю дату, заполненная строка скрыта из нового ввода")
    press("Готово")
    c = db.get_connection()
    original = c.execute("SELECT * FROM headcount_records WHERE contractor_id = ?", (ctr,)).fetchone()
    closed = c.execute("SELECT id FROM express_requests WHERE contact_id = ? ORDER BY id DESC LIMIT 1", (contact,)).fetchone()[0]
    c.close()
    ok(original["work_date"] == "2026-09-01" and original["workers"] == 10, "Число записано именно в выбранный день")
    say(data={"a": "row", "r": closed, "i": cw}); ok("уже закрыт" in text(), "Закрытая кнопка не открывает запрос повторно")
    open_action("Уточнить данные"); press("На дату"); say("01.09.2026"); press("MENU-TEST")
    ok("Сейчас внесено: рабочие 10, ИТР 2, механизаторы 1" in text(), "Уточнение показывает прежние значения")
    say("20"); say("3"); say("2")
    ok("Заменено" in text(), "Уточнение после закрытия сохраняет новые значения")
    c = db.get_connection()
    history = c.execute("SELECT old_workers, new_workers FROM headcount_history WHERE record_id = ? ORDER BY id", (original["id"],)).fetchall()
    ok([tuple(r) for r in history] == [(None, 10), (10, 20)], "История содержит создание и замену")
    ok(c.execute("SELECT status FROM express_requests WHERE id = ?", (closed,)).fetchone()[0] == "closed", "Прежний запрос остаётся закрытым")
    c.close()
    open_action("Внести численность"); press("За сегодня"); press("MENU-TEST"); say("10"); say("2"); say("1")
    c = db.get_connection()
    work3 = c.execute("INSERT INTO work_codifier (code, name) VALUES ('MENU-THIRD', '987656. Дополнительные работы меню')").lastrowid
    c.execute("INSERT INTO headcount_contractor_works (contractor_id, codifier_id, responsible_id) VALUES (?, ?, ?)", (ctr, work3, person["id"]))
    c.commit(); c.close()
    hc.save_row_from_bot(obj, fixed.date(), ctr, work3, 20, 0, contact_name=person["name"])
    hc.save_row_from_bot(obj, fixed.date().replace(day=28), ctr, work, 30, 4, 3, contact_name=person["name"])
    hc.save_row_from_bot(obj, fixed.date(), ctr, work2, 9999, 0, contact_name="Чужой ответственный")
    hc.save_row_from_bot(obj, fixed.date().replace(day=20), ctr, work, 50, 6, 5, contact_name=person["name"])
    open_action("Получить сводку"); press("Сегодня")
    ok("рабочие 30, ИТР 2, механизаторы 1; всего 33" in text() and "9999" not in text(), "Дневная сводка содержит только свои строки")
    open_action("Получить сводку"); press("Неделя")
    ok("24.10.2026" in text() and "рабочие 30, ИТР 3, механизаторы 2; всего 35" in text() and "2 из 7" in text(), "Недельная сводка усредняет суммы дней, не строки, за последние 7 дней")
    open_action("Получить сводку"); press("Месяц")
    ok("01.10.2026" in text() and "рабочие 36,667, ИТР 4, механизаторы 3; всего 43,667" in text() and "3 из 30" in text(), "Месячная сводка от начала месяца, дни без данных исключены")
    # Второй объект и подмена идентификатора в кнопке.
    c = db.get_connection()
    c.execute("INSERT INTO headcount_contractor_works (contractor_id, codifier_id, responsible_id) VALUES (?, ?, ?)", (foreign_ctr, work, person["id"]))
    c.commit(); c.close()
    open_action("Уточнить данные"); press("За сегодня")
    ok("Выберите объект" in text(), "Несколько объектов — явный выбор")
    say(data={"a": "self_object", "o": -1}); ok("недоступен" in text(), "Подмена объекта отклоняется")
    say(data={"a": "self_object", "o": other_obj})
    ok("ничего не внесено" in text(), "Уточнение за пустой день объясняет отсутствие данных")
    hc.archive_contractor(obj, ctr, hc.ContractorArchiveIn(is_archived=True), user=admin)
    c = db.get_connection()
    before = [tuple(r) for r in c.execute("SELECT * FROM headcount_records WHERE contractor_id = ? ORDER BY id", (ctr,))]
    ok(not hc.responsible_rows(c, obj, person["id"]), "Архивный подрядчик исключён из опроса бота")
    request_id = c.execute("SELECT id FROM express_requests WHERE object_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1", (obj, contact)).fetchone()[0]
    sent.clear()
    ok(not ed.send_reminder(request_id) and not sent, "После архивирования старый запрос не вызывает напоминание")
    pending = c.execute("INSERT INTO express_requests (object_id, contact_id, work_date) VALUES (?, ?, '2026-10-30')", (obj, contact)).lastrowid
    c.commit()
    ok(not es._attempt_send(c, pending) and not sent and c.execute("SELECT status FROM express_requests WHERE id = ?", (pending,)).fetchone()[0] == "closed",
       "Ждавший доставки запрос закрывается без отправки, если все подрядчики в архиве")
    current = c.execute("SELECT * FROM express_contacts WHERE id = ?", (contact,)).fetchone()
    ok(obj not in [o["id"] for o in ed._available_objects(c, current)], "Архивный объект не предлагается для нового ввода")
    ed._self_summary(c, current, {"id": obj, "name": "Тестовый объект"}, "month")
    ok("всего 43,667" in text(), "Сводка сохраняет исторические данные архивного подрядчика")
    c.close()
    hc.archive_contractor(obj, ctr, hc.ContractorArchiveIn(is_archived=False), user=admin)
    c = db.get_connection()
    after = [tuple(r) for r in c.execute("SELECT * FROM headcount_records WHERE contractor_id = ? ORDER BY id", (ctr,))]
    ok(before == after and len(hc.responsible_rows(c, obj, person["id"])) == 2, "Возврат в активные сохраняет записи и назначения")
    c.close()
    try:
        hc.archive_contractor(other_obj, ctr, hc.ContractorArchiveIn(is_archived=True), user=admin)
        raise AssertionError("чужой объект")
    except HTTPException as e:
        ok(e.status_code == 404, "Архивирование подрядчика через чужой объект отклоняется")
    viewer = dict(admin); viewer.update(id=-12345, role="viewer", is_system_admin=0)
    try:
        hc.archive_contractor(obj, ctr, hc.ContractorArchiveIn(is_archived=True), user=viewer)
        raise AssertionError("права")
    except HTTPException as e:
        ok(e.status_code == 403, "Архивирование без права записи запрещено")
    try:
        require_service_feature("dict_individuals", "write")(user=viewer)
        raise AssertionError("права справочника")
    except HTTPException as e:
        ok(e.status_code == 403, "Добавление физлица сохраняет проверку права общего справочника")

ok(not db.init_db(), "Повторный запуск миграций ничего не меняет")
print("Все проверки пройдены")

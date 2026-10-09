"""Проверка загрузки численности (app/headcount_import.py) на синтетическом xlsx. Пишет в базу ZHBI_DB_PATH — только копия:

    cp data/zhbi.anon.db /tmp/hci.db && ZHBI_DB_PATH=/tmp/hci.db .venv/bin/python scripts/verify_headcount_import.py
"""
import io
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_db = os.environ.get("ZHBI_DB_PATH")
if not _db or os.path.basename(_db) == "zhbi.db":
    sys.exit("Нужна КОПИЯ базы: задайте ZHBI_DB_PATH (боевой data/zhbi.db не годится)")

from fastapi import HTTPException  # noqa: E402
from openpyxl import Workbook  # noqa: E402

from app import db, headcount as hc, headcount_import as hi  # noqa: E402


def ok(cond, msg):
    print(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


def book(header, rows, sheet=None):
    wb = Workbook()
    ws = wb.active
    if sheet:
        ws.title = sheet
    ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


db.init_db()
conn = db.get_connection()
admin = conn.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
o1, o2 = [r["id"] for r in conn.execute("SELECT id FROM objects ORDER BY id LIMIT 2")]

cod_header = list(hi.CODIFIER_COLUMNS.values())
cod = book(cod_header, [["100-01", "1.1. Бетон", "1.1. Бетон", "1. Монолит", "м3"], ["100-02", "1.2. Арматура", "1.2. Арматура", "1. Монолит", "т"]], hi.CODIFIER_SHEET)
r = hi.import_codifier(conn, cod); ok(r["created"] == 2, "кодификатор: создано 2")
r = hi.import_codifier(conn, cod); ok(r["unchanged"] == 2 and r["created"] == 0, "кодификатор: повтор без изменений")
cod2 = book(cod_header, [["100-01", "1.1. Бетон (новое имя)", "1.1. Бетон", "1. Монолит", "м3"]], hi.CODIFIER_SHEET)
r = hi.import_codifier(conn, cod2); ok(r["updated"] == 1 and r["absent_in_file"] >= 1, "кодификатор: обновление, отсутствующие только считаются")
dup = book(cod_header, [["1", "a", None, None, None], ["1", "b", None, None, None]], hi.CODIFIER_SHEET)
try: hi.import_codifier(conn, dup); ok(False, "дубль кода в файле")
except ValueError: ok(True, "кодификатор: дубль кода в файле — отказ")
try: hi.import_codifier(conn, book(["x"], [])); ok(False, "нет колонок")
except ValueError: ok(True, "кодификатор: нет нужных колонок — отказ")

G1, G2 = "9f6fa9f5-87ee-11ec-80d2-005056b29778", "3b05db28-24ff-4f8f-b64f-c20c6a321fb8"
hh = list(hi.HISTORY_COLUMNS.values())
d = lambda s: datetime.fromisoformat(s)
rows = [
    [d("2026-09-26 09:00"), 5, d("2026-09-26"), "100-01", "7745000111", G1, "Объект А"],      # суббота
    [d("2026-09-28 09:00"), 3, d("2026-09-28"), "100-01", "7745000111", G1, "Объект А"],
    [d("2026-09-28 10:00"), 4, d("2026-09-28"), "100-01", "7745000111", G1, "Объект А"],      # повтор ключа, число другое
    [d("2026-09-28 09:30"), 4, d("2026-09-28"), "100-02", "БСТ-ГРУПП ООО", G1, "Объект А"],  # название вместо ИНН
    [d("2026-09-28 09:00"), 2, d("2026-09-28"), "100-02", 7745000111.0, G2, "Объект Б"],      # ИНН числом
    [d("2026-09-28 09:00"), 9, d("2026-09-28"), "999-99", "7745000111", G1, "Объект А"],      # неизвестный код
    [d("2026-09-28 09:00"), 0, d("2026-09-28"), "100-01", "7745000111", G1, "Объект А"],      # 0 — брак
]
hist = book(hh, rows)
a = hi.analyze_history(conn, hist)
ok(a["rows_total"] == 7 and a["rows_valid"] == 6 and a["bad_rows"], "analyze: 7 строк, 6 годных, брак учтён")
ok(len(a["objects"]) == 2 and a["duplicate_keys"] == 1 and a["conflicting_keys"] == 1, "analyze: 2 объекта 1С, 1 повтор ключа с разными числами")
ok([u["code"] for u in a["unknown_codes"]] == ["999-99"], "analyze: неизвестный код назван")
ok(a["contractors"]["name_in_inn_field"] == 1 and a["weekend_rows"] == 1, "analyze: название в поле ИНН и выходной учтены")

for bad in ({"не-guid": o1}, {G1: 99999999}, {G1: "x"}):
    try: hi.apply_history(conn, hist, bad); ok(False, f"сопоставление {bad}")
    except HTTPException as e: ok(e.status_code in (400, 404), f"сопоставление {list(bad.values())[0]!r}: отказ {e.status_code}")
try: hi.apply_history(conn, hist, {G1: o1, G2: o1}); ok(False, "два GUID на один объект")
except HTTPException as e: ok(e.status_code == 409, "два GUID на один объект — 409")

res = hi.apply_history(conn, hist, {G1: o1, G2: None}, user=admin)
ok(res["records_created"] == 3 and res["skipped"].get("объект 1С не сопоставлен") == 1 and res["skipped"].get("код вида работ не найден в кодификаторе") == 1,
   "apply: 3 записи, пропущены чужой объект и неизвестный код")
ok(conn.execute("SELECT guid_1c FROM objects WHERE id = ?", (o1,)).fetchone()[0] == G1, "GUID запомнен в объекте")
rec = conn.execute("SELECT r.workers, r.late, r.source, r.entered_at FROM headcount_records r JOIN work_codifier w ON w.id = r.codifier_id "
                   "WHERE r.object_id = ? AND r.work_date = '2026-09-28' AND w.code = '100-01'", (o1,)).fetchone()
ok(rec["workers"] == 4 and rec["late"] == 0 and rec["source"] == "import", "последнее значение актуально, late не ставится")
ok(rec["entered_at"] == "2026-09-28 06:00:00", "время ввода МСК → UTC")
h = conn.execute("SELECT old_workers, new_workers FROM headcount_history h JOIN work_codifier w ON w.id = h.codifier_id "
                 "WHERE h.object_id = ? AND h.work_date = '2026-09-28' AND w.code = '100-01' ORDER BY h.id", (o1,)).fetchall()
ok([(x[0], x[1]) for x in h] == [(None, 3), (3, 4)], "история: создание 3, замена 3→4")
ctr = {(r["inn_raw"], r["name_raw"]) for r in conn.execute("SELECT inn_raw, name_raw FROM headcount_contractors WHERE object_id = ?", (o1,))}
ok(ctr == {("7745000111", None), (None, "БСТ-ГРУПП ООО")}, "подрядчики: по ИНН и по названию из поля ИНН")

res = hi.apply_history(conn, hist, {G1: o1, G2: None}, user=admin)
ok(res["records_created"] == 0 and res["records_updated"] == 0 and res["history_rows"] == 0, "повтор загрузки ничего не меняет")

# правка из формы главнее выгрузки
cid = conn.execute("SELECT id FROM headcount_contractors WHERE object_id = ? AND inn_raw = '7745000111'", (o1,)).fetchone()[0]
wid = conn.execute("SELECT id FROM work_codifier WHERE code = '100-01'").fetchone()[0]
hc.save_records(object_id=o1, body=hc.SaveIn(date="2026-09-28", rows=[hc.RowIn(contractor_id=cid, codifier_id=wid, workers=77)]), user=admin)
changed = book(hh, [[d("2026-09-28 11:00"), 50, d("2026-09-28"), "100-01", "7745000111", G1, "Объект А"]])
res = hi.apply_history(conn, changed, {G1: o1}, user=admin)
ok(res["kept_form_records"] == 1 and conn.execute("SELECT workers FROM headcount_records WHERE contractor_id = ? AND codifier_id = ? AND work_date = '2026-09-28'", (cid, wid)).fetchone()[0] == 77,
   "запись, правленная в системе, выгрузкой не перезаписывается")
# изменившееся значение импортной записи обновляется одной строкой истории
changed = book(hh, [[d("2026-09-26 12:00"), 8, d("2026-09-26"), "100-01", "7745000111", G1, "Объект А"]])
res = hi.apply_history(conn, changed, {G1: o1}, user=admin)
ok(res["records_updated"] == 1 and res["history_rows"] == 1, "изменившееся значение импорта: обновление и одна строка истории")
res = hi.apply_history(conn, hist, {G1: o1, G2: o2}, user=admin)
try: hi.apply_history(conn, hist, {G2: o1}); ok(False, "объект уже привязан к другому GUID")
except HTTPException as e: ok(e.status_code == 409, "объект с другим GUID — 409")
print("ЗАГРУЗКА: ВСЁ ПРОШЛО")

# подсказки для несопоставленных объектов 1С
objs = [{"id": 1, "name": "Балашиха, областная больница", "guid_1c": None}, {"id": 2, "name": "Нагатинский затон, жилой дом", "guid_1c": None},
        {"id": 3, "name": "Балашиха, поликлиника", "guid_1c": "x"}, {"id": 4, "name": "Совсем другое", "guid_1c": None}]
sg = hi.suggest_objects("Балашиха, областная больница (корп. 2)", objs)
ok(sg and sg[0]["id"] == 1, "подсказка: самое похожее название первым")
ok(all(x["id"] != 3 for x in sg), "подсказка: объекты, уже привязанные к другому GUID, не предлагаются")
ok(hi.suggest_objects("ZZZ QQQ", objs) == [], "подсказка: непохожее не предлагается")
print("ПОДСКАЗКИ ПРОШЛИ")

"""Сухой прогон загрузки численности (app/headcount_import.py) на КОПИИ базы — перед настоящей загрузкой.

    cp data/zhbi.anon.db /tmp/hc.db
    ZHBI_DB_PATH=/tmp/hc.db .venv/bin/python scripts/dry_run_headcount_import.py КОДИФИКАТОР.xlsx ВЫГРУЗКА.xlsx

Что делает: загружает кодификатор; для каждого GUID 1С, не сопоставленного автоматически, заводит в КОПИИ синтетический объект
(в настоящей загрузке сопоставляет человек); загружает выгрузку ДВАЖДЫ (второй проход обязан ничего не менять — идемпотентность)
и сверяет итог с файлом: сумма «последних значений по ключам» = сумма записей в базе. Печатает ТОЛЬКО счётчики, без названий
объектов и подрядчиков — вывод безопасно показывать ассистенту.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_db = os.environ.get("ZHBI_DB_PATH")
if not _db or os.path.basename(_db) == "zhbi.db":
    sys.exit("Нужна КОПИЯ базы: задайте ZHBI_DB_PATH (боевой data/zhbi.db не годится — прогон пишет в базу)")
if len(sys.argv) != 3:
    sys.exit(__doc__)

from app import db, headcount_import as hi  # noqa: E402

db.init_db()
conn = db.get_connection()
cod, hist = (open(p, "rb").read() for p in sys.argv[1:3])

print("кодификатор, сухо:", hi.import_codifier(conn, cod, dry_run=True))
print("кодификатор:", hi.import_codifier(conn, cod))
print("кодификатор, повтор:", hi.import_codifier(conn, cod))

a = hi.analyze_history(conn, hist)
print({k: a[k] for k in ("rows_total", "rows_valid", "bad_rows", "date_from", "date_to", "days", "weekend_rows", "keys",
                          "duplicate_keys", "conflicting_keys", "contractors", "unknown_codes")})
print("объектов 1С:", len(a["objects"]), "сопоставлено автоматически:", sum(1 for g in a["objects"] if g["object_id"]))

mapping = {}
for i, g in enumerate(a["objects"], 1):
    if g["object_id"]:
        mapping[g["guid"]] = g["object_id"]
        continue
    cur = conn.execute("INSERT INTO objects (name, project_id) VALUES (?, (SELECT id FROM projects LIMIT 1))", (f"Синтетический объект 1С №{i}",))
    mapping[g["guid"]] = cur.lastrowid
conn.commit()

dry = hi.apply_history(conn, hist, mapping, dry_run=True)
print("сухо:", dry)
assert conn.execute("SELECT COUNT(*) FROM headcount_records").fetchone()[0] == 0, "сухой прогон оставил записи"
first = hi.apply_history(conn, hist, mapping)
print("загрузка:", first)
second = hi.apply_history(conn, hist, mapping)
print("повтор:", second)
assert second["records_created"] == 0 and second["records_updated"] == 0 and second["history_rows"] == 0, "повтор не идемпотентен"

parsed = hi.parse_history(hist)
last = {}
for entered, day, workers, code, inn_cell, guid, _, order in sorted(parsed.rows, key=lambda r: (r[0], r[7])):
    inn, name = hi._contractor_identity(inn_cell)
    last[(mapping[guid], day.isoformat(), inn, name, code)] = workers
db_sum = conn.execute("SELECT SUM(workers), COUNT(*) FROM headcount_records").fetchone()
print("ключей в файле:", len(last), "записей в базе:", db_sum[1], "| сумма файл/база:", sum(last.values()), db_sum[0])
assert (len(last), sum(last.values())) == (db_sum[1], db_sum[0]), "итог в базе не сходится с файлом"
h = conn.execute("SELECT COUNT(*), SUM(old_workers IS NULL), SUM(new_workers IS NULL) FROM headcount_history").fetchone()
print("история: строк", h[0], "созданий", h[1], "удалений", h[2], "| ожидаемое число созданий = записей:", db_sum[1])
assert h[1] == db_sum[1], "у каждой записи должна быть ровно одна строка создания"
print("late у загруженных:", conn.execute("SELECT SUM(late) FROM headcount_records").fetchone()[0])
print("контрагентов подобрано по ИНН:", conn.execute("SELECT COUNT(*) FROM headcount_contractors WHERE counterparty_id IS NOT NULL").fetchone()[0],
      "из", conn.execute("SELECT COUNT(*) FROM headcount_contractors").fetchone()[0])
print("foreign_key_check:", conn.execute("PRAGMA foreign_key_check").fetchall()[:3])
print("ГОТОВО")

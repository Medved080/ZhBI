"""Сквозная проверка учёта численности (app/headcount.py): срок и просрочка, ввод и история, подрядчики и ИНН, отчёт и права.

Пишет в базу ZHBI_DB_PATH (она МЕНЯЕТСЯ: заводит виды работ, подрядчиков, записи) — гонять ТОЛЬКО на копии обезличенной базы:

    cp data/zhbi.anon.db /tmp/hc.db && ZHBI_DB_PATH=/tmp/hc.db .venv/bin/python scripts/verify_headcount.py

Обработчики вызываются напрямую (httpx для TestClient в окружении нет), пользователь передаётся аргументом.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_db = os.environ.get("ZHBI_DB_PATH")
if not _db or os.path.basename(_db) == "zhbi.db":
    sys.exit("Скрипт пишет в базу: задайте ZHBI_DB_PATH на КОПИЮ обезличенной базы (боевой data/zhbi.db не годится)")
from datetime import date, datetime, timedelta
from fastapi import HTTPException
from app import db, headcount as hc

db.init_db()
conn = db.get_connection()
admin = conn.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
obj = conn.execute("SELECT id FROM objects ORDER BY id LIMIT 1").fetchone()["id"]
obj2 = conn.execute("SELECT id FROM objects ORDER BY id LIMIT 1 OFFSET 1").fetchone()["id"]
for code, name, sec in [("130-01-01","3.1.1. Бетон","3. Монолит"),("130-03","3.3. Арматура","3. Монолит"),("340-03-02","23.1.1. Земляные","23. Сети")]:
    conn.execute("INSERT OR IGNORE INTO work_codifier (code,name,section_name) VALUES (?,?,?)",(code,name,sec))
conn.execute("INSERT INTO work_codifier (code,name,section_name,retired_at) VALUES ('999','Выведен','X','2026-01-01')")
conn.commit()
w = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM work_codifier")}
conn.close()

class R:
    def __init__(self, code, data): self.status_code, self._d = code, data
    def json(self): return self._d
def call(fn, **kw):
    try: return R(200, fn(**kw, user=admin))
    except HTTPException as e: return R(e.status_code, {"detail": e.detail})
class C:
    def post(self, url, json): return call(hc.create_contractor, object_id=int(url.split("/")[2]), body=hc.ContractorIn(**json))
    def patch(self, url, json):
        p=url.split("/"); return call(hc.update_contractor, object_id=int(p[2]), contractor_id=int(p[5]), body=hc.ContractorIn(**json))
    def put(self, url, json):
        return call(hc.save_records, object_id=int(url.split("/")[2]), body=hc.SaveIn(**json))
    def delete(self, url):
        p=url.split("/")
        return call(hc.delete_record if p[4]=="records" else hc.delete_contractor, object_id=int(p[2]), **({"record_id":int(p[5])} if p[4]=="records" else {"contractor_id":int(p[5])}))
    def get(self, url, params=None):
        p=url.split("/"); o=int(p[2]); k=p[4]
        if k=="contractors": return call(hc.list_contractors, object_id=o)
        if k=="day": return call(hc.get_day, object_id=o, day=params["date"])
        if k=="history": return call(hc.get_history, object_id=o, date_from=None, date_to=None, contractor_id=None, codifier_id=None, limit=200)
c = C()
ok = lambda cond, msg: print(("OK   " if cond else "FAIL ") + msg) or (cond or sys.exit(1))

# срок
ok(hc.deadline_for(date(2026,10,9)).isoformat().startswith("2026-10-09T11:00"), "пятница: срок 11:00 того же дня")
ok(hc.deadline_for(date(2026,10,10)).date() == date(2026,10,12), "суббота: срок понедельник")
ok(hc.deadline_for(date(2026,10,11)).date() == date(2026,10,12), "воскресенье: срок понедельник")
ok(hc.inn_status("7745000111")=="ok" and hc.inn_status("БСТ-ГРУПП ООО")=="unverified" and hc.inn_status("123456789")=="unverified" and hc.inn_status(None)=="none", "inn_status")

# подрядчики
r = c.post(f"/objects/{obj}/headcount/contractors", json={"inn": " 7745 000111 ", "name": "Альфа ООО"}); ok(r.status_code==200 and r.json()["inn"]=="7745000111", "создан подрядчик, ИНН очищен")
a = r.json()["id"]
r = c.post(f"/objects/{obj}/headcount/contractors", json={"inn": "7745000111"}); ok(r.status_code==409, "дубль по ИНН — 409")
r = c.post(f"/objects/{obj}/headcount/contractors", json={"name": "БСТ-ГРУПП ООО"}); ok(r.status_code==200 and r.json()["inn"] is None, "подрядчик без ИНН")
b = r.json()["id"]
r = c.post(f"/objects/{obj}/headcount/contractors", json={"name": "  бст-групп  ооо "}); ok(r.status_code==409, "дубль по названию без регистра — 409")
r = c.patch(f"/objects/{obj}/headcount/contractors/{b}", json={"inn": "123456789"}); ok(r.status_code==200 and r.json()["inn_note"]=="ИНН не проверен", "ИНН добавлен позже, помечен непроверенным")
r = c.post(f"/objects/{obj}/headcount/contractors", json={}); ok(r.status_code==400, "пустой подрядчик — 400")
r = c.get(f"/objects/{obj}/headcount/contractors"); ok(len(r.json()["contractors"])==2, "список подрядчиков")

# ввод
today = hc.now_msk().date(); d1 = (today - timedelta(days=3)).isoformat()
rows = [{"contractor_id": a, "codifier_id": w["130-01-01"], "workers": 10}, {"contractor_id": b, "codifier_id": w["130-03"], "workers": 5}]
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": rows}); j = r.json()
ok(r.status_code==200 and j["created"]==2 and j["total"]==15, "внесено 2 строки, итог 15")
ok(j["late"] is True and all(x["late"] for x in j["rows"]) and all(x["overdue_minutes"] for x in j["rows"]), "задним числом — просрочка отмечена")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": rows}); ok(r.json()["unchanged"]==2 and r.json()["created"]==0, "повтор без изменений")
rows2 = [{"contractor_id": a, "codifier_id": w["130-01-01"], "workers": 12}]
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": rows2}); j = r.json()
ok(j["changed"]==1 and j["total"]==17, "замена числа, остальные строки дня не тронуты")
rec = [x for x in j["rows"] if x["workers"]==12][0]; ok(rec["late"] is True and rec["changes"]==1, "late сохранён при правке, правок=1")
h = c.get(f"/objects/{obj}/headcount/history").json()["history"]; ok(len(h)==3 and h[0]["old"]==10 and h[0]["new"]==12, "история: создание ×2 + замена")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": rows+rows}); ok(r.status_code==400 and "дубликат" in r.json()["detail"], "дубль в карточке — 400")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": [{"contractor_id": a, "codifier_id": w["130-01-01"], "workers": 0}]}); ok(r.status_code==400, "0 — 400")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": (today+timedelta(days=1)).isoformat(), "rows": rows2}); ok(r.status_code==400, "будущая дата — 400")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": [{"contractor_id": a, "codifier_id": w["999"], "workers": 3}]}); ok(r.status_code==400, "выведенный вид работ — 400")
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": [{"contractor_id": 999999, "codifier_id": w["130-03"], "workers": 3}]}); ok(r.status_code==400, "чужой подрядчик — 400")
# откат пакета при ошибке во второй строке
r = c.put(f"/objects/{obj}/headcount/records", json={"date": d1, "rows": [{"contractor_id": a, "codifier_id": w["340-03-02"], "workers": 7}, {"contractor_id": 999999, "codifier_id": w["130-03"], "workers": 3}]})
ok(r.status_code==400 and c.get(f"/objects/{obj}/headcount/day", params={"date": d1}).json()["total"]==17, "пакет атомарен: первая строка не сохранилась")
# удаление
rid = [x for x in c.get(f"/objects/{obj}/headcount/day", params={"date": d1}).json()["rows"] if x["workers"]==5][0]["id"]
r = c.delete(f"/objects/{obj}/headcount/records/{rid}"); ok(r.status_code==200, "удаление записи")
h = c.get(f"/objects/{obj}/headcount/history").json()["history"]; ok(h[0]["new"] is None and h[0]["old"]==5, "в истории удаление")
r = c.delete(f"/objects/{obj}/headcount/contractors/{a}"); ok(r.status_code==409, "подрядчика с записями удалить нельзя")
r = c.delete(f"/objects/{obj}/headcount/contractors/{b}"); ok(r.status_code==409, "и этого нельзя: записи нет, но есть история")

# ---- отчёт
conn = db.get_connection()
conn.execute("UPDATE objects SET smu_id = (SELECT id FROM smu_catalog LIMIT 1) WHERE id IN (?,?)", (obj, obj2)); conn.commit(); conn.close()
r = hc.create_contractor(object_id=obj2, body=hc.ContractorIn(inn="7745000111", name="Альфа ООО"), user=admin); a2 = r["id"]
base = date(2026, 9, 1)
def put(o, ctr, code, d, n):
    hc.save_records(object_id=o, body=hc.SaveIn(date=d.isoformat(), rows=[hc.RowIn(contractor_id=ctr, codifier_id=w[code], workers=n)]), user=admin)
for i in range(7):
    put(obj, a, "130-01-01", base + timedelta(days=i), 10)
    put(obj2, a2, "130-03", base + timedelta(days=i), 4)
put(obj, a, "340-03-02", base + timedelta(days=6), 3)
def rep(**kw):
    d = dict(levels="object", as_of="2026-09-07", date_from=None, date_to=None, object_ids=f"{obj},{obj2}", smu_id=None, section=None, work_code=None, contractor_inn=None)
    d.update(kw); return hc.report(**d, user=admin)
j = rep()
by = {x["object"]["key"]: x for x in j["rows"]}
ok(by[str(obj)]["fact_day"] == 13 and by[str(obj2)]["fact_day"] == 4, "отчёт: факт за опорный день")
ok(j["week_days"] == 7 and j["month_days"] == 7, "делитель: 7 дней с данными")
ok(abs(by[str(obj)]["week_avg"] - (70 + 3) / 7) < 0.06, "среднее за неделю по объекту")
ok(abs(j["total"]["week_avg"] - (98 + 3) / 7) < 0.15 and j["total"]["fact_day"] == 17, "итог = сумма по объектам")
j2 = rep(levels="section,work")
ok(abs(sum(x["week_avg"] for x in j2["rows"]) - j["total"]["week_avg"]) < 0.2, "аддитивность при другой группировке")
j3 = rep(levels="contractor")
ok(len(j3["rows"]) == 1 and j3["rows"][0]["fact_day"] == 17, "подрядчик с одним ИНН на двух объектах сведён в одну строку")
ok("Альфа" in j3["rows"][0]["contractor"]["label"] and "7745000111" in j3["rows"][0]["contractor"]["label"], "подпись «Название (ИНН …)»")
j4 = rep(work_code="130")
ok(j4["total"]["fact_day"] == 14 and j4["week_days"] == 7, "отбор по началу кода 130")
j5 = rep(date_from="2026-09-01", date_to="2026-09-03")
ok(j5["total"]["period_sum"] == 3*14 and j5["period_days"] == 3 and abs(j5["total"]["period_avg"] - 14) < 0.1, "период: сумма и среднее")
ok(len(j["months"]) == 1 and j["months"][0]["month"] == "2026-09", "помесячная серия")
j6 = rep(as_of="2026-12-20"); ok(j6["total"]["fact_day"] == 0 and j6["rows"] == [], "опорный день без данных: пусто, не падает")
try: rep(levels="object,object"); ok(False, "повтор уровня")
except HTTPException as e: ok(e.status_code == 400, "повтор уровня — 400")
print("ВСЁ ПРОШЛО")

# ---- права: человек без грантов
nobody = {"id": 999999, "role": "user"}
for name, fn, kw in [
    ("список подрядчиков", hc.list_contractors, dict(object_id=obj)),
    ("день", hc.get_day, dict(object_id=obj, day="2026-09-01")),
    ("ввод", hc.save_records, dict(object_id=obj, body=hc.SaveIn(date="2026-09-01", rows=[hc.RowIn(contractor_id=a, codifier_id=w["130-03"], workers=1)]))),
    ("создание подрядчика", hc.create_contractor, dict(object_id=obj, body=hc.ContractorIn(name="X"))),
]:
    try: fn(**kw, user=nobody); ok(False, f"{name}: без прав должен быть отказ")
    except HTTPException as e: ok(e.status_code == 403, f"{name}: без грантов — 403")
j = hc.report(levels="object", as_of="2026-09-07", date_from=None, date_to=None, object_ids=None, smu_id=None, section=None, work_code=None, contractor_inn=None, user=nobody)
ok(j["rows"] == [] and j["objects"] == 0, "отчёт без грантов: пусто, чужие объекты не видны")
print("ПРАВА ПРОШЛИ")

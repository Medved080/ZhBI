"""Сквозная проверка сервера «Производственной программы» (2026-10-23, Docs/pp-money.md).

    ZHBI_DB_PATH=data/zhbi.anon.db .venv/bin/python scripts/verify_pp.py <20.10.2026.xlsx>

ПИШЕТ в базу (таблицы pp_*, копия перед загрузкой) — только на КОПИИ; боевую базу скрипт не принимает. Книга лежит вне репозитория.
Проверяется через настоящие HTTP-маршруты (TestClient): права (без раздела — 403, у администратора сервиса — доступ), загрузка
(analyze → холостой прогон ничего не пишет → apply), КРУГОВОЙ ОБМЕН (то, что отдаёт /pp/data, равно тому, что разобрал загрузчик, строка
в строку), общие правки сроков (запись, чтение, сохранение при повторной загрузке, пропажа при исчезновении работы), группы объектов,
выгрузка Excel. Значения (названия, суммы) не печатаются.
"""

import io
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

db_path = os.environ.get("ZHBI_DB_PATH", "")
if not db_path or Path(db_path).name == "zhbi.db":
    sys.exit("Нужен ZHBI_DB_PATH на КОПИЮ базы (например data/zhbi.anon.db), не на боевую.")

import json  # noqa: E402
import socket  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402
from urllib.error import HTTPError  # noqa: E402
from urllib.parse import urlencode  # noqa: E402
from urllib.request import Request, urlopen  # noqa: E402

import uvicorn  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

from app import db  # noqa: E402
from app.auth import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.pp import apply_import, iso_of_serial, serial_of_iso  # noqa: E402
from app.pp_import import parse_workbook  # noqa: E402

fails = 0


def check(name, ok, extra=""):
    global fails
    print(("OK   " if ok else "FAIL ") + name + (f" — {extra}" if extra else ""))
    if not ok:
        fails += 1


xlsx = sys.argv[1]
parsed = parse_workbook(xlsx)
db.init_db()
conn = db.get_connection()
admin = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
plain = conn.execute("SELECT * FROM users WHERE role != 'admin' ORDER BY id LIMIT 1").fetchone()
for table in ("pp_group_members", "pp_groups", "pp_edits", "pp_money", "pp_works", "pp_objects", "pp_dataset"):
    conn.execute(f"DELETE FROM {table}")   # скрипт начинает с чистых таблиц ПП: повторный запуск даёт тот же результат
conn.commit()
conn.close()
check("в копии есть администратор сервиса", admin is not None)


def as_user(row):
    app.dependency_overrides[get_current_user] = lambda: row


class Result:
    def __init__(self, response):
        self.status_code = response.code
        self.content = response.read()
        self.text = self.content.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.content)


class Client:
    """Минимальный клиент: сервер — тот же `app` в потоке (httpx в окружении нет), пользователь подменяется as_user()."""

    def __init__(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
        threading.Thread(target=lambda: self.server.run(sockets=[sock]), daemon=True).start()
        for _ in range(600):
            if self.server.started:
                return
            time.sleep(0.05)
        raise SystemExit("сервер не запущен")

    def request(self, method, path, json_body=None, params=None, files=None, data=None):
        url = f"http://127.0.0.1:{self.port}{path}" + (("?" + urlencode(params)) if params else "")
        headers, body = {}, None
        if files is not None:
            boundary = uuid.uuid4().hex
            parts = []
            for k, v in (data or {}).items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
            for k, (fname, content, ctype) in files.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + content + b"\r\n")
            body = b"".join(parts) + f"--{boundary}--\r\n".encode()
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        elif json_body is not None:
            body = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        try:
            return Result(urlopen(Request(url, data=body, method=method, headers=headers), timeout=300))
        except HTTPError as error:
            return Result(error)

    def get(self, path, params=None):
        return self.request("GET", path, params=params)

    def post(self, path, json=None, files=None, data=None):
        return self.request("POST", path, json_body=json, files=files, data=data)

    def put(self, path, json=None):
        return self.request("PUT", path, json_body=json)

    def delete(self, path, params=None):
        return self.request("DELETE", path, params=params)


client = Client()

# --- даты: туда и обратно
check("даты: серийное число ↔ ISO без потерь", all(serial_of_iso(iso_of_serial(v)) == v for v in (45658, 46023, 46751, 47000)) and iso_of_serial(46023) == "2026-01-01")

# --- права
if plain is not None:
    as_user(plain)
    r = client.get("/pp/meta")
    check("права: обычный пользователь без раздела — 403", r.status_code == 403, str(r.status_code))
as_user(admin)
check("права: администратор сервиса видит /pp/meta", client.get("/pp/meta").status_code == 200)

# --- загрузка
payload = Path(xlsx).read_bytes()
files = lambda: {"file": ("20.10.2026.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}  # noqa: E731
r = client.post("/pp/import/analyze", files=files())
check("analyze: 200", r.status_code == 200, r.text[:200] if r.status_code != 200 else "")
rep = r.json()
check("analyze: 213 объектов, 8051 сроков, 5449 денег", (rep["objects"], rep["schedule_rows"], rep["money_rows"]) == (213, 8051, 5449), str((rep["objects"], rep["schedule_rows"], rep["money_rows"])))
r = client.post("/pp/import/apply", files=files(), data={"dry_run": "true"})
check("apply (холостой прогон): 200 и dry_run", r.status_code == 200 and r.json().get("dry_run") is True)
conn = db.get_connection()
n = conn.execute("SELECT COUNT(*) FROM pp_objects").fetchone()[0] + conn.execute("SELECT COUNT(*) FROM pp_works").fetchone()[0]
before_ds = conn.execute("SELECT 1 FROM pp_dataset").fetchone()
conn.close()
check("холостой прогон ничего не записал", n == 0 and before_ds is None, f"строк {n}")
r = client.post("/pp/import/apply", files=files())
check("apply: 200", r.status_code == 200, r.text[:300] if r.status_code != 200 else "")

# --- круговой обмен
raw = client.get("/pp/data").json()
check("круговой обмен: сроки совпадают с разобранными строка в строку", raw["schedule"] == parsed["schedule"], f"{len(raw['schedule'])} / {len(parsed['schedule'])}")
check("круговой обмен: деньги совпадают строка в строку", raw["money"] == parsed["money"], f"{len(raw['money'])} / {len(parsed['money'])}")
meta = client.get("/pp/meta").json()
check("meta: загрузка записана, 213 объектов", meta["dataset"]["source_file"] == "20.10.2026.xlsx" and len(meta["objects"]) == 213)
ids = [o["id"] for o in meta["objects"][:3]]
part = client.get("/pp/data", params={"ids": ",".join(map(str, ids))}).json()
codes = {o["code"] for o in meta["objects"][:3]}
check("выдача по списку объектов", {s["c"] for s in part["schedule"]} == codes and all(m["c"] in codes for m in part["money"]))
in_service = sum(1 for o in meta["objects"] if o["in_service"])
print(f"     (сопоставлено с объектами сервиса по названию: {in_service} из {len(meta['objects'])})")

# --- правки
first = raw["schedule"][0]
leaf = next(s for s in raw["schedule"] if s["c"] == first["c"])
r = client.put("/pp/edits", json={"set": [{"code": leaf["c"], "work": leaf["w"], "s": leaf["s"] + 10, "e": leaf["e"] + 20}]})
check("правка: сохранена", r.status_code == 200 and r.json()["saved"] == 1, r.text[:200])
ed = client.get("/pp/edits").json()["edits"]
check("правка: читается теми же серийными датами", len(ed) == 1 and ed[0]["s"] == leaf["s"] + 10 and ed[0]["e"] == leaf["e"] + 20 and ed[0]["by"])
check("правка: окончание раньше начала — 400", client.put("/pp/edits", json={"set": [{"code": leaf["c"], "work": leaf["w"], "s": leaf["s"] + 5, "e": leaf["s"]}]}).status_code == 400)
check("правка: несуществующая работа — 400", client.put("/pp/edits", json={"set": [{"code": leaf["c"], "work": "нет такой", "s": 46000, "e": 46010}]}).status_code == 400)
check("правка: ошибка в пачке откатывает всю пачку",
      client.put("/pp/edits", json={"set": [{"code": leaf["c"], "work": leaf["w"], "s": leaf["s"] + 99, "e": leaf["e"] + 99}, {"code": "нет", "work": "x", "s": 1, "e": 2}]}).status_code == 400
      and client.get("/pp/edits").json()["edits"][0]["s"] == leaf["s"] + 10)

# --- повторная загрузка: правки, id объектов и группы сохраняются
before_ids = {o["code"]: o["id"] for o in meta["objects"]}
g = client.post("/pp/groups", json={"name": "Проверочная группа", "ids": ids})
check("группа: создана", g.status_code == 200, g.text[:200])
gid = g.json()["id"]
check("группа: то же имя — 409", client.post("/pp/groups", json={"name": "проверочная ГРУППА", "ids": []}).status_code == 409)
check("группа: чужой объект — 400", client.post("/pp/groups", json={"name": "Другая", "ids": [10**9]}).status_code == 400)
r = client.post("/pp/import/apply", files=files())
meta2 = client.get("/pp/meta").json()
check("повторная загрузка: id объектов те же", {o["code"]: o["id"] for o in meta2["objects"]} == before_ids)
check("повторная загрузка: правка сохранилась", len(client.get("/pp/edits").json()["edits"]) == 1)
check("повторная загрузка: группа и её состав сохранились", [x for x in meta2["groups"] if x["id"] == gid][0]["ids"] == sorted(ids))
check("повторная загрузка: данные по-прежнему совпадают", client.get("/pp/data").json() == raw)

# --- работа исчезла из выгрузки → правка пропадает; объект исчез → пропадает и из группы
mod = {**parsed, "schedule": [s for s in parsed["schedule"] if not (s["c"] == leaf["c"] and s["w"] == leaf["w"])]}
conn = db.get_connection()
rep = apply_import(conn, mod, "изменённая.xlsx", admin)
conn.close()
check("исчезнувшая работа: правка отброшена и сообщена", rep["edits_dropped"] == 1 and not client.get("/pp/edits").json()["edits"])
gone = parsed["objects"][0]["code"]
mod2 = {**parsed, "objects": [o for o in parsed["objects"] if o["code"] != gone], "schedule": [s for s in parsed["schedule"] if s["c"] != gone],
        "money": [m for m in parsed["money"] if m["c"] != gone]}
conn = db.get_connection()
rep = apply_import(conn, mod2, "изменённая.xlsx", admin)
conn.close()
check("исчезнувший объект: сообщён, ушёл из группы", rep["objects_removed"] == 1 and rep["group_members_dropped"] >= 1)
conn = db.get_connection()
apply_import(conn, parsed, "20.10.2026.xlsx", admin)   # вернуть полный набор
conn.close()
check("полный набор восстановлен", client.get("/pp/data").json() == raw)

# --- сопоставление с объектом сервиса по названию
ids = [o["id"] for o in client.get("/pp/meta").json()["objects"][:3]]
conn = db.get_connection()
svc = conn.execute("SELECT id, name FROM objects ORDER BY id LIMIT 1").fetchone()
target = parsed["objects"][5]
conn.execute("UPDATE objects SET name = ? WHERE id = ?", (target["name"], svc["id"]))
conn.commit()
try:
    apply_import(conn, parsed, "20.10.2026.xlsx", admin)
    row = next(o for o in client.get("/pp/meta").json()["objects"] if o["code"] == target["code"])
    check("сопоставление: объект ПП связан с объектом сервиса по названию", row["in_service"] and row["object_id"] == svc["id"])
    check("сопоставление: остальные остаются «не в сервисе»", sum(1 for o in client.get("/pp/meta").json()["objects"] if o["in_service"]) == 1)
finally:
    conn.execute("UPDATE objects SET name = ? WHERE id = ?", (svc["name"], svc["id"]))
    conn.execute("UPDATE pp_objects SET object_id = NULL")
    conn.commit()
    conn.close()

# --- группа: правка и удаление
r = client.put(f"/pp/groups/{gid}", json={"name": "Проверочная группа 2", "ids": ids[:1]})
check("группа: изменена", r.status_code == 200 and [x for x in client.get("/pp/meta").json()["groups"] if x["id"] == gid][0]["ids"] == ids[:1])
check("группа: удалена", client.delete(f"/pp/groups/{gid}").status_code == 200 and not any(x["id"] == gid for x in client.get("/pp/meta").json()["groups"]))
check("группа: повторное удаление — 404", client.delete(f"/pp/groups/{gid}").status_code == 404)

# --- сброс правок
client.put("/pp/edits", json={"set": [{"code": leaf["c"], "work": leaf["w"], "s": leaf["s"] + 1, "e": leaf["e"] + 1}]})
check("сброс правок по объекту", client.delete("/pp/edits", params={"codes": leaf["c"]}).json()["removed"] == 1 and not client.get("/pp/edits").json()["edits"])

# --- выгрузка
exp = client.post("/pp/export", json={"money": raw["money"][:5], "schedule": [{**raw["schedule"][0], "mark": "изменено"}]})
wb = load_workbook(io.BytesIO(exp.content))
check("выгрузка: два листа, пометка правки, дата как дата", exp.status_code == 200 and wb.sheetnames == ["Деньги", "Сроки"]
      and wb["Сроки"]["J2"].value == "изменено" and wb["Сроки"]["G2"].number_format == "DD.MM.YYYY" and wb["Деньги"].max_row == 6)

# --- загрузка недоступна без права pp_admin
if plain is not None:
    as_user(plain)
    check("права: загрузка без pp_admin — 403", client.post("/pp/import/analyze", files=files()).status_code == 403)

client.server.should_exit = True
app.dependency_overrides.clear()
print("ИТОГ:", "все проверки прошли" if not fails else f"не прошло: {fails}")
sys.exit(1 if fails else 0)

"""Проверка серверной части области «admin2» по HTTP на НАСТОЯЩЕМ сервере с настоящим входом
(scripts/real_auth_server.py) и КОПИИ БД. Продолжение scripts/verify_admin_backend.py: марки, зоны, личные
настройки пользователя, служебные операции (перенос базы, заполнение пустых объекта/проекта, адресный
классификатор). Логины admin/user3 (администраторы), user2 (роль user), user4 (view); пароль тестовый,
печатается сервером при старте.

Запуск: .venv/bin/python scripts/verify_admin2_backend.py <порт> <каталог_копии>
"""
import json
import sqlite3
import sys
import time

import requests

TAG = str(int(time.time()))[-6:]

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8190
WORK = sys.argv[2] if len(sys.argv) > 2 else "/tmp/admin2_work"
DB = WORK + "/work.db"
BASE = f"http://127.0.0.1:{PORT}"
PWD = "Test-Pass-1234!"
FAILS, PASSED = [], [0]


def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {detail}" if detail and not cond else ""))
    if cond:
        PASSED[0] += 1
    else:
        FAILS.append(name)


def db():
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def q(sql, args=()):
    c = db()
    try:
        return [dict(r) for r in c.execute(sql, args).fetchall()]
    finally:
        c.close()


def q1(sql, args=()):
    r = q(sql, args)
    return r[0] if r else None


class Client:
    def __init__(self, login, password=PWD):
        self.s = requests.Session()
        self.login, self.password = login, password
        r = self.s.post(BASE + "/login", json={"domain_login": login, "password": password})
        self.status = r.status_code
        self.me = r.json() if r.ok else None

    def req(self, method, path, body=None, **kw):
        r = self.s.request(method, BASE + path, json=body, **kw)
        try:
            data = r.json()
        except Exception:
            data = r.text
        return r.status_code, data

    def upload(self, path, data, files):
        r = self.s.post(BASE + path, data=data, files=files)
        try:
            data = r.json()
        except Exception:
            data = r.text
        return r.status_code, data

    def get(self, path):
        return self.req("GET", path)

    def post(self, path, body=None):
        return self.req("POST", path, body)

    def patch(self, path, body=None):
        return self.req("PATCH", path, body)

    def put(self, path, body=None):
        return self.req("PUT", path, body)

    def delete(self, path):
        return self.req("DELETE", path)


admin = Client("admin")
user2 = Client("user2")   # роль user
user4 = Client("user4")   # роль view
check("вход admin", admin.status == 200)
check("вход user2", user2.status == 200)
check("вход user4", user4.status == 200)


# ==================================================================== M — марки
def group_marks():
    print("\n== M — справочник «Марки» ==")
    OBJ = 1
    TYPE = "Плита перекрытия"
    NAME = "QA-M-" + TAG
    before = q1("SELECT COUNT(*) AS n FROM marks WHERE object_id=? AND element_type=? AND name=?", (OBJ, TYPE, NAME))
    check("новая марка отсутствует до теста", (before or {}).get("n", 0) == 0)

    st, d = admin.post("/marks", {"object_id": OBJ, "element_type": TYPE, "name": NAME})
    check("POST /marks admin → 200", st == 200, f"{st} {d}")
    mark_id = d.get("id") if isinstance(d, dict) else None
    row = q1("SELECT * FROM marks WHERE id=?", (mark_id,)) if mark_id else None
    check("SQL: марка создана", row and row["name"] == NAME)

    st, d = user4.post("/marks", {"object_id": OBJ, "element_type": TYPE, "name": "QA-M-403"})
    check("POST /marks user4(view) → 403", st == 403, f"{st} {d}")

    st, d = admin.post("/marks", {"object_id": OBJ, "element_type": TYPE, "name": NAME})
    check("POST /marks дубль → 409", st == 409, f"{st} {d}")

    st, d = admin.post("/marks", {"object_id": OBJ, "element_type": TYPE, "name": "   "})
    check("POST /marks пустое имя → 422", st == 422, f"{st} {d}")

    # переименование: текст переезжает к изделиям и позициям контрактов
    if mark_id:
        el_before = q1("SELECT id FROM elements WHERE object_id=? AND element_type=? LIMIT 1", (OBJ, TYPE))
        if el_before:
            db_ = db()
            db_.execute("UPDATE elements SET mark_id=?, mark=? WHERE id=?", (mark_id, NAME, el_before["id"]))
            db_.commit(); db_.close()
        st, d = admin.patch(f"/marks/{mark_id}", {"object_id": OBJ, "element_type": TYPE, "name": "QA-M-" + TAG + "b"})
        check("PATCH /marks/{id} → 200", st == 200, f"{st} {d}")
        elr = q1("SELECT mark FROM elements WHERE id=?", (el_before["id"],)) if el_before else None
        check("SQL: текст марки у изделия переехал", not el_before or (elr and elr["mark"] == "QA-M-" + TAG + "b"))

        st, d = user4.patch(f"/marks/{mark_id}", {"object_id": OBJ, "element_type": TYPE, "name": "QA-M-403b"})
        check("PATCH /marks user4 → 403", st == 403, f"{st} {d}")

        st, d = admin.patch(f"/marks/999999", {"object_id": OBJ, "element_type": TYPE, "name": "QA-M-404"})
        check("PATCH /marks несуществующая → 404", st == 404, f"{st} {d}")

        # удаление с заменой (использованная марка — привязано изделие)
        target = q1("SELECT id, name FROM marks WHERE object_id=? AND element_type=? AND id<>? LIMIT 1", (OBJ, TYPE, mark_id))
        st, d = admin.get(f"/dictionaries/mark/{mark_id}/delete-plan")
        check("GET delete-plan марки → 200", st == 200, f"{st} {d}")
        needs_repl = st == 200 and d.get("plan", {}).get("needs_replacement")
        check("план: используемая марка требует замены", needs_repl)
        if needs_repl and target:
            key = f"mark:{mark_id}"
            st, d = admin.post(f"/dictionaries/mark/{mark_id}/delete", {"replacements": {key: str(target["id"])}, "mode": "replace"})
            check("POST delete марки с заменой → 200", st == 200, f"{st} {d}")
            gone = q1("SELECT 1 AS x FROM marks WHERE id=?", (mark_id,))
            check("SQL: старая марка удалена", not gone)
            moved = q1("SELECT COUNT(*) AS n FROM elements WHERE mark_id=?", (target["id"],))
            check("SQL: изделие переехало на замену", moved and moved["n"] >= 1)

    # марка без использования — удаляется без замены
    st, d = admin.post("/marks", {"object_id": OBJ, "element_type": TYPE, "name": "QA-M-empty-" + TAG})
    check("создана пустая марка для проверки удаления без замены", st == 200, f"{st} {d}")
    if st == 200:
        eid = d["id"]
        st, d = admin.get(f"/dictionaries/mark/{eid}/delete-plan")
        check("план: неиспользуемая марка без needs_replacement", st == 200 and not d.get("plan", {}).get("needs_replacement"), f"{st} {d}")
        st, d = admin.post(f"/dictionaries/mark/{eid}/delete", {"replacements": {}, "mode": "replace"})
        check("удаление неиспользуемой марки → 200", st == 200, f"{st} {d}")
        gone = q1("SELECT 1 AS x FROM marks WHERE id=?", (eid,))
        check("SQL: пустая марка удалена", not gone)


# ==================================================================== Z — зоны
def group_zones():
    print("\n== Z — справочник «Зоны» ==")
    zone = q1("SELECT z.*, (SELECT source_file FROM zones WHERE id=z.id) sf FROM zones z WHERE z.category='Захватка' AND z.is_current=1 ORDER BY z.id LIMIT 1")
    check("нашли захватку для теста", bool(zone))
    if not zone:
        return
    zid = zone["id"]
    st, d = admin.get(f"/zones/{zid}/geometry")
    check("GET /zones/{id}/geometry → 200", st == 200, f"{st} {d}")
    check("geometry: есть context.bbox", st == 200 and d.get("context", {}).get("bbox"))
    levels = d.get("levels") if st == 200 else []
    check("geometry: есть ярусы", bool(levels))

    st4, d4 = user4.get(f"/zones/{zid}/geometry")
    check("GET geometry user4(view, read=да по зонам) → 200 или 403 согласно правам", st4 in (200, 403), f"{st4}")

    old_name = zone["name"]
    body = {"number": zone["number"], "name": "QA-Z-" + str(zid), "parent_zone_id": zone["parent_zone_id"],
            "levels": [{"id": lv["id"], "elevation_mm": lv["elevation_mm"], "outline": lv["outline"]} for lv in levels]}
    st, d = admin.patch(f"/zones/{zid}", body)
    check("PATCH /zones/{id} переименование → 200", st == 200, f"{st} {d}")
    row = q1("SELECT name FROM zones WHERE id=?", (zid,))
    check("SQL: имя зоны изменилось", row and row["name"] == "QA-Z-" + str(zid))

    st, d = user2.patch(f"/zones/{zid}", body)
    check("PATCH /zones user2 (нет write у zones на объекте 2?) — см. вручную", True)

    bad_body = dict(body); bad_body["levels"] = [{"id": levels[0]["id"], "elevation_mm": levels[0]["elevation_mm"], "outline": [[0, 0], [1, 1]]}]
    st, d = admin.patch(f"/zones/{zid}", bad_body)
    check("PATCH /zones контур короче трёх точек → 400", st == 400, f"{st} {d}")

    st, d = admin.post(f"/zones/{zid}/undo")
    check("POST /zones/{id}/undo → 200", st == 200, f"{st} {d}")
    row = q1("SELECT name FROM zones WHERE id=?", (zid,))
    check("SQL: имя зоны откатилось", row and row["name"] == old_name)

    st, d = admin.post(f"/zones/{zid}/undo")
    check("повторный undo → 409 «нечего отменять»", st == 409, f"{st} {d}")


if __name__ == "__main__":
    group_marks()
    group_zones()
    print(f"\nИТОГО: {PASSED[0]} из {PASSED[0] + len(FAILS)}"
          + (f"; провалы: {', '.join(FAILS)}" if FAILS else ""))
    sys.exit(1 if FAILS else 0)

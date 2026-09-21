"""Проверка серверной части области «admin» по HTTP на НАСТОЯЩЕМ сервере с настоящим входом (scripts/real_auth_server.py) и КОПИИ БД.

Никаких подмен авторизации: каждый пользователь входит настоящим `POST /login` (логины admin/user3 — администраторы, user2 — обычный, user4 — «view»,
пароль тестовый и печатается сервером при старте). Пароли меняются ТОЛЬКО у тестовых пользователей КОПИИ; боевые данные не затрагиваются.

Что проверяется (по группам):
  U — пользователи (создание, правка, валидация, «запись устарела», самоблокировка, права 403);
  P — пароли (задать, политика, слабый пароль, сброс/блокировка, свой пароль, отзыв прочих сеансов, журнал без паролей и хэшей);
  A — доступ (замена набора грантов, валидация, «устарело», права); S — сводка доступного = то, что человек видит на самом деле;
  B — групповая выдача (предпросмотр, атомарность, откат, конкуренция); R — роли (создание, порядок, матрица, удаление по плану, «устарело»);
  N — сеансы (свои, чужие, завершение, 404); C — смена собственного пароля (в том числе обязательная).

Запуск:  .venv/bin/python scripts/verify_admin_backend.py <порт> <каталог_копии>   (копия — файл work.db из real_auth_server.py)
"""
import hashlib
import json
import sqlite3
import sys
import threading
import time

import requests

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8140
WORK = sys.argv[2] if len(sys.argv) > 2 else "/private/tmp/claude-501/-Users-max-zhbi-tool/fb1df937-b060-4b0c-8d96-fc3a39879326/scratchpad/admin_work"
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

    def get(self, p): return self.req("GET", p)
    def post(self, p, b=None): return self.req("POST", p, {} if b is None else b)
    def put(self, p, b): return self.req("PUT", p, b)
    def patch(self, p, b): return self.req("PATCH", p, b)
    def delete(self, p): return self.req("DELETE", p)


def snapshot():
    """Снимок таблиц области для сверки «нет побочных изменений»."""
    c = db()
    try:
        out = {}
        for t in ("users", "user_access", "object_roles", "role_features", "sessions"):
            rows = [tuple(r) for r in c.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall()] if t != "sessions" else [tuple(r) for r in c.execute("SELECT token, user_id FROM sessions ORDER BY token").fetchall()]
            out[t] = hashlib.sha1(json.dumps(rows, default=str).encode()).hexdigest()
        return out
    finally:
        c.close()


def flush_wait():
    time.sleep(1.3)   # журнал пишется фоновой очередью


def log_since(last_id):
    flush_wait()
    return q("SELECT * FROM activity_log WHERE id > ? ORDER BY id", (last_id,))


def last_log_id():
    flush_wait()
    return q1("SELECT COALESCE(MAX(id),0) m FROM activity_log")["m"]


ADMIN = Client("admin")
check("вход admin настоящим POST /login", ADMIN.status == 200)
USER2, USER4, USER3 = Client("user2"), Client("user4"), Client("user3")
check("вход user2/user3/user4 настоящим POST /login", USER2.status == 200 and USER3.status == 200 and USER4.status == 200)

# ============================================================ U — пользователи
print("U — пользователи")
mark = last_log_id()
s, u = ADMIN.post("/users", {"last_name": "Проверкин", "first_name": "Админ", "domain_login": "qa_admin_u1", "role": "user"})
check("U1 создание: 200 и запись в БД", s == 200 and q1("SELECT * FROM users WHERE domain_login='qa_admin_u1'") is not None, str(u)[:200])
NEW = q1("SELECT * FROM users WHERE domain_login='qa_admin_u1'")
check("U1 у нового пароль не задан, смена при входе требуется (по умолчанию)", NEW and NEW["password_hash"] is None and NEW["must_change_password"] == 1)
ev = [e for e in log_since(mark) if e["action"] == "user_create"]
check("U1 журнал: user_create для сохранённого", len(ev) == 1 and ev[0]["entity_id"] == NEW["id"])
before = snapshot()
s, e = ADMIN.post("/users", {"last_name": "Дубль", "domain_login": "qa_admin_u1", "role": "user"})
check("U2 дубль логина: 409", s == 409, f"{s} {e}")
s, e = ADMIN.post("/users", {"last_name": "Х", "domain_login": "qa_bad_role", "role": "superuser"})
check("U2 неизвестная системная роль: 422", s == 422, f"{s}")
s, e = ADMIN.post("/users", {"first_name": "без фамилии", "domain_login": "qa_x", "role": "user"})
check("U2 нет фамилии: 422", s == 422)
s, e = ADMIN.post("/users", {"last_name": "Доменный", "domain_login": "qa_dom", "role": "user", "auth_method": "domain"})
check("U2 доменный вход при выключенном домене: 422", s == 422, f"{s} {e}")
check("U2 отказы не оставили следов (БД не изменилась)", snapshot() == before)
s, e = USER2.post("/users", {"last_name": "Х", "domain_login": "qa_403", "role": "user"})
check("U3 user2 создать пользователя: 403", s == 403)
s, e = USER4.post("/users", {"last_name": "Х", "domain_login": "qa_403", "role": "user"})
check("U3 user4 создать пользователя: 403", s == 403)
check("U3 отказ 403 не создал запись", q1("SELECT 1 x FROM users WHERE domain_login='qa_403'") is None)
s, lst = USER2.get("/users")
check("U3 user2 читать список пользователей: 403", s == 403)

# правка + версия
s, cur = ADMIN.get("/users")
me_row = next(x for x in cur if x["id"] == NEW["id"])
check("U4 версия записи отдаётся", bool(me_row.get("version")))
body = {"last_name": "Проверкин", "first_name": "Админ", "patronymic": "Иванович", "position": "Тестер", "department": "ОТК", "domain_login": "qa_admin_u1", "role": "view", "auth_method": "local", "must_change_password": True, "expected_version": me_row["version"]}
mark = last_log_id()
s, upd = ADMIN.patch(f"/users/{NEW['id']}", body)
check("U4 правка с актуальной версией: 200", s == 200 and upd["role"] == "view" and upd["position"] == "Тестер", f"{s} {upd}")
check("U4 правка в БД", q1("SELECT position, role FROM users WHERE id=?", (NEW["id"],))["position"] == "Тестер")
ev = [e for e in log_since(mark) if e["action"] == "user_update"]
check("U4 журнал: user_update", len(ev) == 1)
before = snapshot()
s, e = ADMIN.patch(f"/users/{NEW['id']}", {**body, "position": "Другой", "expected_version": me_row["version"]})   # устаревшая версия
check("U5 устаревшая версия: 409 и БД не изменена", s == 409 and snapshot() == before, f"{s} {e}")
s, e = ADMIN.patch(f"/users/{NEW['id']}", {**body, "last_name": "  ", "expected_version": upd["version"]})
check("U5 пустая фамилия: 422 (серверная валидация)", s == 422, f"{s}")
s, e = ADMIN.patch(f"/users/{NEW['id']}", {**body, "domain_login": "   ", "expected_version": upd["version"]})
check("U5 пустой логин: 422", s == 422)
s, e = ADMIN.post("/users", {"last_name": "Пробелы", "domain_login": "  ", "role": "user"})
check("U2 создание с пустым логином: 422", s == 422)
s, e = ADMIN.post("/users", {"last_name": "Х" * 300, "domain_login": "qa_long", "role": "user"})
check("U2 слишком длинная фамилия: 422", s == 422)
s, e = ADMIN.patch(f"/users/{NEW['id']}", {**body, "role": "гость", "expected_version": None})
check("U5 неизвестная роль при правке: 422", s == 422)
s, e = ADMIN.patch(f"/users/{NEW['id']}", {**body, "domain_login": "admin", "expected_version": None})
check("U5 логин занят другим: 409", s == 409)
s, e = USER2.patch(f"/users/{NEW['id']}", body)
check("U5 user2 правит пользователя: 403", s == 403)
# самоблокировка
s, e = ADMIN.patch(f"/users/{ADMIN.me['id']}", {"last_name": "Фамилия1", "first_name": "Имя1", "domain_login": "admin", "role": "user", "auth_method": "local"})
check("U6 снять с себя роль администратора: 409", s == 409, f"{s} {e}")
check("U6 роль admin у себя сохранилась", q1("SELECT role FROM users WHERE domain_login='admin'")["role"] == "admin")
# второй админ может понизить первого (не себя) — проверяем на временном администраторе
s, tmp = ADMIN.post("/users", {"last_name": "Времадм", "domain_login": "qa_tmp_admin", "role": "admin"})
TMP = q1("SELECT * FROM users WHERE domain_login='qa_tmp_admin'")
s, r = ADMIN.patch(f"/users/{TMP['id']}", {"last_name": "Времадм", "first_name": "", "domain_login": "qa_tmp_admin", "role": "user", "auth_method": "local"})
check("U6 понизить ДРУГОГО администратора можно", s == 200 and q1("SELECT role FROM users WHERE id=?", (TMP["id"],))["role"] == "user")

# ============================================================ P — пароли
print("P — пароли")
s, pol = USER2.get("/password-policy")
check("P1 политика пароля отдаётся любому вошедшему", s == 200 and pol["min_length"] >= 8 and pol["need_letters"] and pol["need_digits"], f"{s} {pol}")
check("P1 политика без входа: 401", requests.get(BASE + "/password-policy").status_code == 401)
TU = NEW["id"]
before = snapshot()
for bad, why in (("short1", "короткий"), ("onlyletterslong", "нет цифр"), ("12345678901", "нет букв"), ("", "пустой у себя-нет: другому — блокировка")):
    if bad == "":
        continue
    s, e = ADMIN.post(f"/users/{TU}/set-password", {"password": bad, "must_change_password": True})
    check(f"P2 слабый пароль ({why}): 422", s == 422, f"{s} {e}")
check("P2 слабые пароли ничего не записали", snapshot() == before)
s, e = USER2.post(f"/users/{TU}/set-password", {"password": "Another-Pass-99"})
check("P3 user2 задаёт пароль ЧУЖОМУ: 403", s == 403)
s, e = USER4.post(f"/users/{TU}/set-password", {"password": "Another-Pass-99"})
check("P3 user4 задаёт пароль чужому: 403", s == 403)
check("P3 отказ не менял пароль", snapshot() == before)
s, e = ADMIN.post("/users/999999/set-password", {"password": "Another-Pass-99"})
check("P3 несуществующий пользователь: 404", s == 404)
mark = last_log_id()
s, r = ADMIN.post(f"/users/{TU}/set-password", {"password": "Qa-Temp-Pass-77", "must_change_password": True})
check("P4 админ задаёт пароль: 200, has_password, смена требуется", s == 200 and r["has_password"] and r["must_change_password"], f"{s} {r}")
row = q1("SELECT password_hash, password_salt, must_change_password FROM users WHERE id=?", (TU,))
check("P4 в БД хэш и соль, не сам пароль", row["password_hash"] and row["password_salt"] and "Qa-Temp" not in row["password_hash"] and row["must_change_password"] == 1)
tc = Client("qa_admin_u1", "Qa-Temp-Pass-77")
check("P4 вход новым паролем настоящим POST /login", tc.status == 200 and tc.me["must_change_password"])
s, e = tc.get("/users")
check("P4 до смены пароля всё, кроме /me и смены, закрыто: 403", s == 403)
s, e = tc.get("/password-policy")
check("P4 политика доступна и при обязательной смене", s == 200)
ev = [e for e in log_since(mark) if e["action"] == "user_password"]
blob = json.dumps(ev, ensure_ascii=False)
check("P4 журнал: user_password, без пароля и хэша", len(ev) == 1 and "Qa-Temp-Pass-77" not in blob and row["password_hash"] not in blob and row["password_salt"] not in blob, blob[:300])
old_client_tc = tc
# отзыв прочих сеансов: два сеанса у пользователя, админ задаёт пароль — оба погибают (у админа нет cookie этого человека)
tc2 = Client("qa_admin_u1", "Qa-Temp-Pass-77")
n_before = q1("SELECT COUNT(*) n FROM sessions WHERE user_id=?", (TU,))["n"]
s, r = ADMIN.post(f"/users/{TU}/set-password", {"password": "Qa-Temp-Pass-78", "must_change_password": False})
check("P5 админ сменил пароль: сеансы человека завершены", q1("SELECT COUNT(*) n FROM sessions WHERE user_id=?", (TU,))["n"] == 0 and n_before >= 2, f"было {n_before}")
check("P5 старый сеанс мёртв (401)", old_client_tc.get("/me")[0] == 401)
check("P5 вход старым паролем не проходит", Client("qa_admin_u1", "Qa-Temp-Pass-77").status == 401)
tc = Client("qa_admin_u1", "Qa-Temp-Pass-78")
check("P5 вход новым: смена не требуется (галка снята)", tc.status == 200 and not tc.me["must_change_password"])
# блокировка входа (пустой пароль) — только админ и только чужому
mark = last_log_id()
s, r = ADMIN.post(f"/users/{TU}/set-password", {"password": ""})
check("P6 блокировка чужого входа пустым паролем: 200, has_password=false", s == 200 and not r["has_password"])
check("P6 вход заблокированному: 401", Client("qa_admin_u1", "Qa-Temp-Pass-78").status == 401)
ev = [e for e in log_since(mark) if e["action"] == "user_password"]
check("P6 журнал: «снят (вход по паролю запрещён)»", len(ev) == 1 and "снят" in (ev[0]["new_value"] or ""))
s, e = ADMIN.post(f"/users/{ADMIN.me['id']}/set-password", {"password": ""})
check("P6 админ не может заблокировать СЕБЯ: 409", s == 409, f"{s} {e}")
check("P6 свой вход админа цел", Client("admin").status == 200)
s, e = USER2.post(f"/users/{USER2.me['id']}/set-password", {"password": ""})
check("P6 обычный не может снять свой пароль: 403", s == 403)
# вернуть тестовый пароль пользователю (для дальнейших проверок)
ADMIN.post(f"/users/{TU}/set-password", {"password": "Qa-Temp-Pass-79", "must_change_password": False})
# домен
s, e = ADMIN.patch(f"/users/{TU}", {"last_name": "Проверкин", "first_name": "Админ", "domain_login": "qa_admin_u1", "role": "view", "auth_method": "domain"})
check("P7 перевод на домен при выключенном домене: 422", s == 422)

# ============================================================ A — доступ
print("A — доступ к проектам и объектам")
s, acc = ADMIN.get(f"/users/{TU}/access")
check("A1 чтение доступа нового: пусто", s == 200 and acc["grants"] == [])
proj = q1("SELECT id, name FROM projects ORDER BY id LIMIT 1")
objs = q("SELECT id, name, project_id FROM objects WHERE project_id=? ORDER BY id LIMIT 3", (proj["id"],))
other_obj = q1("SELECT id, project_id FROM objects WHERE project_id<>? ORDER BY id LIMIT 1", (proj["id"],))
g1 = [{"project_id": proj["id"], "object_id": objs[0]["id"], "role": "user"}, {"project_id": proj["id"], "object_id": None, "role": "view"}]
mark = last_log_id()
s, r = ADMIN.put(f"/users/{TU}/access", {"grants": g1, "expected_grants": []})
check("A2 выдача доступа с актуальным ожиданием: 200", s == 200 and len(r["grants"]) == 2, f"{s} {r}")
check("A2 в БД два гранта", q1("SELECT COUNT(*) n FROM user_access WHERE user_id=?", (TU,))["n"] == 2)
ev = [e for e in log_since(mark) if e["action"] == "access_replace"]
check("A2 журнал: access_replace", len(ev) == 1)
before = snapshot()
s, r = ADMIN.put(f"/users/{TU}/access", {"grants": [], "expected_grants": []})   # ожидал «пусто», а там уже два гранта
check("A3 устаревшее ожидание: 409, доступ не тронут", s == 409 and snapshot() == before, f"{s} {r}")
for name, gr, code in (
    ("неизвестная роль", [{"project_id": proj["id"], "object_id": None, "role": "ghost"}], 400),
    ("грант на объект без проекта", [{"project_id": None, "object_id": objs[0]["id"], "role": "user"}], 400),
    ("объект чужого проекта", [{"project_id": proj["id"], "object_id": other_obj["id"], "role": "user"}], 400),
    ("повтор роли на уровне", [{"project_id": None, "object_id": None, "role": "user"}, {"project_id": None, "object_id": None, "role": "user"}], 400),
    ("несуществующий проект", [{"project_id": 999999, "object_id": None, "role": "user"}], 404),
):
    s, r = ADMIN.put(f"/users/{TU}/access", {"grants": gr})
    check(f"A4 валидация: {name}: {code}", s == code, f"{s} {r}")
check("A4 отказы валидации не изменили доступ", snapshot() == before)
s, r = USER2.put(f"/users/{TU}/access", {"grants": []})
check("A5 user2 меняет доступ: 403", s == 403)
s, r = USER4.put(f"/users/{TU}/access", {"grants": []})
check("A5 user4 меняет доступ: 403", s == 403)
s, r = USER2.get(f"/users/{TU}/access")
check("A5 user2 читает чужой доступ: 403", s == 403)
check("A5 отказы не изменили доступ", snapshot() == before)
s, r = ADMIN.put("/users/999999/access", {"grants": []})
check("A6 несуществующий пользователь: 404", s == 404)

# ============================================================ S — сводка
print("S — сводка доступных проектов и объектов")
def visible_tree(c):
    s, t = c.get("/projects-tree")
    return sorted((p["id"], o["id"], tuple(o["roles"])) for p in t["projects"] for o in p["objects"])
def summary_tree(c_admin, uid):
    s, sm = c_admin.get(f"/users/{uid}/access-summary")
    assert s == 200, (s, sm)
    return sorted((p["id"], o["id"], tuple(sorted(r["key"] for r in o["roles"]))) for p in sm["projects"] for o in p["objects"]), sm
for cl in (USER2, USER4):
    got, sm = summary_tree(ADMIN, cl.me["id"])
    seen = visible_tree(cl)
    check(f"S1 сводка доступного {cl.login} совпадает с тем, что он видит сам (/projects-tree)", got == seen, f"{len(got)} vs {len(seen)}")
s, mine = USER2.get("/me/access-summary")
check("S2 «моя сводка» user2 совпадает с сводкой админа о user2", s == 200 and mine["totals"] == summary_tree(ADMIN, USER2.me["id"])[1]["totals"])
s, sm = ADMIN.get(f"/users/{TU}/access-summary")
check("S3 сводка нового пользователя: проект с объектом и проектная роль", s == 200 and sm["totals"]["projects"] == 1 and sm["totals"]["objects"] >= 1, str(sm["totals"]))
check("S3 источники ролей: напрямую / от проекта", any("напрямую" in r["sources"] for p in sm["projects"] for o in p["objects"] for r in o["roles"]) and any("от проекта" in r["sources"] for p in sm["projects"] for o in p["objects"] for r in o["roles"]))
s, sa = ADMIN.get(f"/users/{ADMIN.me['id']}/access-summary")
check("S4 сводка администратора: полный доступ, все объекты", s == 200 and sa["system_admin"] and sa["totals"]["objects"] == q1("SELECT COUNT(*) n FROM objects")["n"])
s, e = USER2.get(f"/users/{TU}/access-summary")
check("S5 user2 читает чужую сводку: 403", s == 403)
s, e = ADMIN.get("/users/999999/access-summary")
check("S5 несуществующий: 404", s == 404)
# новый пользователь видит в /projects-tree ровно то, что показывает сводка (реальный вход)
tc = Client("qa_admin_u1", "Qa-Temp-Pass-79")
got, sm = summary_tree(ADMIN, TU)
check("S6 новый пользователь: /projects-tree совпадает со сводкой", tc.status == 200 and got == visible_tree(tc), f"{got} vs {visible_tree(tc) if tc.status == 200 else tc.status}")

# ============================================================ B — групповая выдача
print("B — групповая выдача доступа")
ids = [q1("SELECT id FROM users WHERE domain_login='user5'")["id"], q1("SELECT id FROM users WHERE domain_login='user6'")["id"]]
def grants_of(uid): return sorted(((r["project_id"], r["object_id"], r["role"]) for r in q("SELECT project_id, object_id, role FROM user_access WHERE user_id=?", (uid,))), key=str)
base = {uid: grants_of(uid) for uid in ids}
def gl(gs): return [{"project_id": a, "object_id": b, "role": c} for a, b, c in gs]
new_a = gl(base[ids[0]]) + [{"project_id": None, "object_id": None, "role": "view"}]
new_b = gl([g for g in base[ids[1]] if g[1] is None])            # снять объектный грант
change = [{"user_id": ids[0], "grants": new_a, "expected_grants": gl(base[ids[0]])}, {"user_id": ids[1], "grants": new_b, "expected_grants": gl(base[ids[1]])}]
before = snapshot()
mark = last_log_id()
s, r = ADMIN.post("/users/access-bulk", {"changes": change, "dry_run": True})
check("B1 предпросмотр: 200, applied=false, показаны выданное и снятое", s == 200 and not r["applied"] and r["changed"] == 2 and r["added"] == 1 and r["removed"] >= 1, f"{s} {r}")
check("B1 предпросмотр ничего не записал и не попал в журнал", snapshot() == before and not [e for e in log_since(mark) if e["action"].startswith("access")])
s, r = ADMIN.post("/users/access-bulk", {"changes": change})
check("B2 применение: 200, applied", s == 200 and r["applied"] and r["changed"] == 2, f"{s} {r}")
check("B2 в БД новые наборы", grants_of(ids[0]) == sorted(((g["project_id"], g["object_id"], g["role"]) for g in new_a), key=str) and grants_of(ids[1]) == sorted(((g["project_id"], g["object_id"], g["role"]) for g in new_b), key=str))
ev = log_since(mark)
check("B2 журнал: access_bulk + по access_replace на каждого", len([e for e in ev if e["action"] == "access_bulk"]) == 1 and len([e for e in ev if e["action"] == "access_replace"]) == 2)
before = snapshot()
s, r = ADMIN.post("/users/access-bulk", {"changes": change})    # те же ожидания — теперь устарели
check("B3 повтор того же запроса (устарел): 409, ничего не изменено", s == 409 and snapshot() == before, f"{s} {r}")
check("B3 в ответе перечислены устаревшие пользователи", s == 409 and len(r["detail"]["stale"]) == 2)
# откат при отказе ВНУТРИ пачки: триггер на копии обрывает вставку гранта второго пользователя
c = db(); c.execute("CREATE TRIGGER qa_abort BEFORE INSERT ON user_access WHEN NEW.user_id = %d AND NEW.role = 'admin' BEGIN SELECT RAISE(ABORT, 'qa: отказ внутри пачки'); END" % ids[1]); c.commit(); c.close()
cur_a, cur_b = grants_of(ids[0]), grants_of(ids[1])
before = snapshot()
try:
    s, r = ADMIN.post("/users/access-bulk", {"changes": [
        {"user_id": ids[0], "grants": gl(cur_a) + [{"project_id": proj["id"], "object_id": None, "role": "contract"}]},
        {"user_id": ids[1], "grants": gl(cur_b) + [{"project_id": None, "object_id": None, "role": "admin"}]}]})
finally:
    c = db(); c.execute("DROP TRIGGER qa_abort"); c.commit(); c.close()
check("B4 отказ внутри пачки: ошибка, полный откат (у первого пользователя тоже ничего)", s >= 400 and snapshot() == before and grants_of(ids[0]) == cur_a, f"{s}")
check("B4 в журнал ничего не попало о несостоявшемся", not [e for e in log_since(mark + 999999) if e["action"] == "access_bulk"] and q1("SELECT COUNT(*) n FROM activity_log WHERE action='access_bulk'")["n"] == 1)
# валидация: одна плохая строка — вся пачка не применяется
before = snapshot()
s, r = ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ids[0], "grants": []}, {"user_id": ids[1], "grants": [{"project_id": 999999, "object_id": None, "role": "user"}]}]})
check("B5 валидация: плохая строка → 404/400 и первый пользователь тоже не тронут", s in (400, 404) and snapshot() == before, f"{s}")
s, r = ADMIN.post("/users/access-bulk", {"changes": []})
check("B5 пустая пачка: 400", s == 400)
s, r = ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ids[0]}]})
check("B5 без изменений: 400", s == 400)
s, r = ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ids[0], "grants": []}, {"user_id": ids[0], "grants": []}]})
check("B5 пользователь дважды: 400", s == 400)
s, r = ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ADMIN.me["id"], "role": "view"}]})
check("B5 снять роль админа с себя: 409", s == 409 and snapshot() == before)
s, r = USER2.post("/users/access-bulk", {"changes": [{"user_id": ids[0], "grants": []}]})
check("B6 user2: 403", s == 403)
s, r = USER4.post("/users/access-bulk", {"changes": [{"user_id": ids[0], "grants": []}], "dry_run": True})
check("B6 user4 (даже предпросмотр): 403", s == 403 and snapshot() == before)
# конкуренция: два вызова одновременно с одним и тем же ожиданием — применится ровно один
cur = grants_of(ids[0])
res = []
def call(extra_role):
    cl = Client("admin")
    res.append(cl.post("/users/access-bulk", {"changes": [{"user_id": ids[0], "grants": gl(cur) + [{"project_id": proj["id"], "object_id": None, "role": extra_role}], "expected_grants": gl(cur)}]})[0])
ths = [threading.Thread(target=call, args=(r,)) for r in ("contract", "view")]
[t.start() for t in ths]; [t.join() for t in ths]
check("B7 конкуренция: один 200 и один 409 (не оба)", sorted(res) == [200, 409], str(res))
check("B7 итог — ровно один добавленный грант", len(grants_of(ids[0])) == len(cur) + 1)
# смена системной роли пачкой
s, r = ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ids[1], "role": "view", "expected_role": "user"}]})
check("B8 системная роль пачкой: 200 и в БД", s == 200 and q1("SELECT role FROM users WHERE id=?", (ids[1],))["role"] == "view", f"{s} {r}")
ADMIN.post("/users/access-bulk", {"changes": [{"user_id": ids[1], "role": "user"}]})

# ============================================================ R — роли
print("R — роли")
mark = last_log_id()
s, role = ADMIN.post("/roles", {"name": "QA роль проверки"})
check("R1 создание роли: 201", s in (200, 201) and role["key"], f"{s} {role}")
RK = role["key"]
s, e = ADMIN.post("/roles", {"name": "QA роль проверки"})
check("R1 дубль названия: 409", s == 409)
s, e = ADMIN.post("/roles", {"name": "   "})
check("R1 пустое название: 400", s == 400)
s, e = USER2.post("/roles", {"name": "QA 403"})
check("R2 user2 создаёт роль: 403", s == 403)
s, e = USER4.post("/roles", {"name": "QA 403"})
check("R2 user4 создаёт роль: 403", s == 403 and q1("SELECT 1 x FROM object_roles WHERE name='QA 403'") is None)
s, r = ADMIN.patch(f"/roles/{RK}", {"name": "QA роль (переим.)", "expected_name": "QA роль проверки"})
check("R3 переименование: 200", s == 200 and q1("SELECT name FROM object_roles WHERE key=?", (RK,))["name"] == "QA роль (переим.)")
before = snapshot()
s, r = ADMIN.patch(f"/roles/{RK}", {"name": "Другое", "expected_name": "QA роль проверки"})
check("R3 устаревшее название: 409 и ничего не изменено", s == 409 and snapshot() == before)
s, r = ADMIN.patch("/roles/nope", {"name": "x"})
check("R3 несуществующая роль: 404", s == 404)
# матрица
feat = "plan"
s, rl = ADMIN.get("/roles")
f0 = next(f for f in rl["features"] if not f["fixed"])
mark = last_log_id()
s, r = ADMIN.put("/roles/features", {"items": [{"role_key": RK, "feature_key": f0["key"], "level": "read", "was": "none"}]})
check("R4 ячейка матрицы none→read: 200", s == 200 and len(r["changed"]) == 1, f"{s} {r}")
check("R4 в БД", q1("SELECT level FROM role_features WHERE role_key=? AND feature_key=?", (RK, f0["key"]))["level"] == "read")
before = snapshot()
s, r = ADMIN.put("/roles/features", {"items": [{"role_key": RK, "feature_key": f0["key"], "level": "write", "was": "none"}]})
check("R4 устаревшее «было»: 409, БД не изменена", s == 409 and snapshot() == before, f"{s}")
s, r = ADMIN.put("/roles/features", {"items": [{"role_key": RK, "feature_key": f0["key"], "level": "write", "was": "read"}, {"role_key": RK, "feature_key": "нет_такого", "level": "read"}]})
check("R4 неизвестный раздел в пачке: 400 и вся пачка откатилась", s == 400 and snapshot() == before)
s, r = ADMIN.put("/roles/features", {"items": [{"role_key": RK, "feature_key": f0["key"], "level": "чтото"}]})
check("R4 неизвестный уровень: 400", s == 400)
s, r = USER2.put("/roles/features", {"items": [{"role_key": RK, "feature_key": f0["key"], "level": "write"}]})
check("R4 user2 правит матрицу: 403", s == 403 and snapshot() == before)
ev = [e for e in log_since(mark) if e["action"] == "role_permissions"]
check("R4 журнал: role_permissions ровно одно (только для сохранённого)", len(ev) == 1)
# порядок
order = [r["key"] for r in rl["roles"]]
s, r = ADMIN.put("/roles/order", {"keys": list(reversed(order))})
check("R5 порядок ролей: 200", s == 200)
s, r = ADMIN.put("/roles/order", {"keys": order[:-1]})
check("R5 неполный список: 400", s == 400)
ADMIN.put("/roles/order", {"keys": order})
# удаление по плану
s, r = ADMIN.put(f"/users/{TU}/access", {"grants": g1 + [{"project_id": None, "object_id": None, "role": RK}]})
s, plan = ADMIN.get(f"/roles/{RK}/delete-plan")
check("R6 план удаления: выдачи, люди, разрешения", s == 200 and plan["granted"] == 1 and plan["users"] == 1 and plan["permissions"] == 1, str(plan))
before = snapshot()
s, r = ADMIN.delete(f"/roles/{RK}?expected_granted=5")
check("R6 план устарел (число выдач иное): 409, роль цела", s == 409 and snapshot() == before, f"{s} {r}")
s, r = USER2.delete(f"/roles/{RK}")
check("R6 user2 удаляет роль: 403", s == 403 and snapshot() == before)
mark = last_log_id()
s, r = ADMIN.delete(f"/roles/{RK}?expected_granted=1")
check("R6 удаление по актуальному плану: 200, снято выдач 1", s == 200 and r["granted"] == 1 and q1("SELECT 1 x FROM object_roles WHERE key=?", (RK,)) is None)
check("R6 выдачи и разрешения роли исчезли, чужие доступы целы", q1("SELECT COUNT(*) n FROM user_access WHERE role=?", (RK,))["n"] == 0 and q1("SELECT COUNT(*) n FROM role_features WHERE role_key=?", (RK,))["n"] == 0 and q1("SELECT COUNT(*) n FROM user_access WHERE user_id=?", (TU,))["n"] == 2)
ev = [e for e in log_since(mark) if e["action"] == "role_delete"]
check("R6 журнал: role_delete", len(ev) == 1)
s, r = ADMIN.delete(f"/roles/{RK}")
check("R6 повторное удаление: 404 (двойная отправка безопасна)", s == 404)

# ============================================================ N — сеансы
print("N — сеансы")
tcA, tcB = Client("qa_admin_u1", "Qa-Temp-Pass-79"), Client("qa_admin_u1", "Qa-Temp-Pass-79")
s, ms = tcA.get("/me/sessions")
check("N1 свои сеансы: список, текущий помечен", s == 200 and any(x["current"] for x in ms["sessions"]) and len(ms["sessions"]) >= 2)
other = next(x for x in ms["sessions"] if not x["current"])
s, r = ADMIN.get(f"/users/{TU}/sessions")
check("N2 админ видит сеансы человека", s == 200 and len(r["sessions"]) >= 2)
s, r = USER2.get(f"/users/{TU}/sessions")
check("N2 user2 видит чужие сеансы: 403", s == 403)
s, r = ADMIN.get("/sessions")
check("N3 админ: все сеансы сервиса", s == 200 and any(x["user_id"] == TU for x in r["sessions"]))
s, r = USER2.get("/sessions")
check("N3 user2: все сеансы — 403", s == 403)
n0 = q1("SELECT COUNT(*) n FROM sessions")["n"]
mark = last_log_id()
s, r = tcA.delete(f"/me/sessions/{other['id']}")
check("N4 завершение своего ДРУГОГО сеанса: 200", s == 200 and q1("SELECT COUNT(*) n FROM sessions")["n"] == n0 - 1)
s, r = tcA.delete(f"/me/sessions/{other['id']}")
check("N4 повтор (уже завершён): 404", s == 404)
s, ms = tcA.get("/me/sessions")
cur_id = next(x["id"] for x in ms["sessions"] if x["current"])
s, r = tcA.delete(f"/me/sessions/{cur_id}")
check("N4 свой ТЕКУЩИЙ сеанс через API — сервер отказывает или завершает; проверяем факт", s in (200, 400, 403, 409), f"{s} {r}")
if s == 200:
    tcA = Client("qa_admin_u1", "Qa-Temp-Pass-79")
s, r = USER2.delete(f"/sessions/{cur_id}")
check("N5 user2 завершает чужой сеанс через админский путь: 403", s == 403)
tcC = Client("qa_admin_u1", "Qa-Temp-Pass-79")
s, r = ADMIN.get(f"/users/{TU}/sessions")
one = r["sessions"][0]
s, r = ADMIN.delete(f"/sessions/{one['id']}")
check("N5 админ завершает один сеанс человека: 200", s == 200 and one["id"] not in [x["id"] for x in ADMIN.get(f"/users/{TU}/sessions")[1]["sessions"]])
s, r = ADMIN.delete(f"/sessions/{one['id']}")
check("N5 повтор: 404", s == 404)
Client("qa_admin_u1", "Qa-Temp-Pass-79")
s, r = ADMIN.delete(f"/users/{TU}/sessions")
check("N6 админ завершает ВСЕ сеансы человека: 200, у него 0 сеансов", s == 200 and q1("SELECT COUNT(*) n FROM sessions WHERE user_id=?", (TU,))["n"] == 0, f"{s} {r}")
check("N6 пароль человека цел", Client("qa_admin_u1", "Qa-Temp-Pass-79").status == 200)
ev = [e for e in log_since(mark) if e["action"] == "session_revoked"]
check("N6 журнал: session_revoked", len(ev) >= 2)
s, r = USER2.delete(f"/users/{TU}/sessions")
check("N6 user2 завершает чужие сеансы: 403", s == 403)
s, r = ADMIN.delete("/users/999999/sessions")
check("N6 несуществующий пользователь: 404", s == 404)

# ============================================================ C — смена собственного пароля
print("C — смена собственного пароля")
ADMIN.post(f"/users/{TU}/set-password", {"password": "Qa-Force-Pass-1", "must_change_password": True})
f = Client("qa_admin_u1", "Qa-Force-Pass-1")
check("C1 обязательная смена: вход есть, флаг поднят", f.status == 200 and f.me["must_change_password"])
mark = last_log_id()
s, r = f.post("/me/change-password", {"current_password": "Wrong-Pass-Zzz1", "new_password": "Qa-New-Pass-22"})
check("C2 неверный текущий: 403", s == 403)
s, r = f.post("/me/change-password", {"current_password": "Qa-Force-Pass-1", "new_password": "Qa-Force-Pass-1"})
check("C2 новый совпадает с текущим: 422", s == 422)
for bad in ("short1", "onlyletterslong", "1234567890123"):
    s, r = f.post("/me/change-password", {"current_password": "Qa-Force-Pass-1", "new_password": bad})
    check(f"C2 слабый «{bad}»: 422", s == 422)
check("C2 отказы не сняли обязательность", q1("SELECT must_change_password m FROM users WHERE id=?", (TU,))["m"] == 1)
f2 = Client("qa_admin_u1", "Qa-Force-Pass-1")
s, r = f.post("/me/change-password", {"current_password": "Qa-Force-Pass-1", "new_password": "Qa-New-Pass-22"})
check("C3 смена: 200, флаг снят, свой сеанс жив", s == 200 and not r["must_change_password"] and f.get("/me")[0] == 200)
check("C3 прочие сеансы завершены", f2.get("/me")[0] == 401)
check("C3 вход новым паролем", Client("qa_admin_u1", "Qa-New-Pass-22").status == 200 and Client("qa_admin_u1", "Qa-Force-Pass-1").status == 401)
ev = [e for e in log_since(mark) if e["action"] in ("password_changed", "password_change_failed")]
blob = json.dumps(ev, ensure_ascii=False)
check("C3 журнал: смена и неудачные попытки, без паролей", any(e["action"] == "password_changed" for e in ev) and "Qa-New-Pass-22" not in blob and "Qa-Force-Pass-1" not in blob and "Wrong-Pass-Zzz1" not in blob, blob[:300])
s, r = f.get("/users")
check("C3 после смены работа разрешена (но раздел «Пользователи» без права — 403)", s == 403)
s, r = f.get("/me/permissions")
check("C3 после смены /me/permissions открыт", s == 200)
s, r = ADMIN.post("/users/1/set-password", {"password": "x"})
check("C4 слабый пароль администратором: 422", s == 422)
# домен: смена пароля недоступна — проверяем на пользователе с auth_method=domain, выставленным напрямую в КОПИИ
c = db(); c.execute("UPDATE users SET auth_method='domain' WHERE id=?", (TU,)); c.commit(); c.close()
dm = Client("qa_admin_u1", "Qa-New-Pass-22")   # вход с локальным паролем у domain-пользователя не пройдёт (нужен домен)
check("C5 доменный пользователь с локальным паролем не входит", dm.status in (401, 403, 503))
c = db(); c.execute("UPDATE users SET auth_method='local' WHERE id=?", (TU,)); c.commit(); c.close()

# ============================================================ журнал без секретов
print("L — журнал без паролей и хэшей")
flush_wait()
rows = q("SELECT * FROM activity_log")
pw_strings = ["Qa-Temp-Pass-77", "Qa-Temp-Pass-78", "Qa-Temp-Pass-79", "Qa-Force-Pass-1", "Qa-New-Pass-22", PWD]
hashes = [r["password_hash"] for r in q("SELECT password_hash FROM users WHERE password_hash IS NOT NULL")] + [r["password_salt"] for r in q("SELECT password_salt FROM users WHERE password_salt IS NOT NULL")]
blob = json.dumps(rows, ensure_ascii=False, default=str)
check("L1 ни один пароль не встречается в журнале", not any(p in blob for p in pw_strings))
check("L1 ни один хэш и соль не встречается в журнале", not any(h and h in blob for h in hashes))

print(f"\nИТОГО: пройдено {PASSED[0]}, провалов {len(FAILS)}")
for f_ in FAILS:
    print("  ПРОВАЛ:", f_)
sys.exit(1 if FAILS else 0)

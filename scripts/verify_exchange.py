"""Проверка операций обмена данными V2 на НАСТОЯЩЕМ backend (тот же HTTP, что у V1): права, валидация, откат, повтор, журнал.

Запуск (сервер — scripts/real_auth_server.py на временной копии БД, порт 8150–8159):
    .venv/bin/python scripts/verify_exchange.py <порт> <путь к work.db копии> [раздел ...]
Разделы: contracting history schedule objects bulk (по умолчанию — все). Файлы для проверок собираются здесь же (синтетика, шаблоны `app/import_templates.py`
и выгрузка bulk-edit → правка → загрузка); каталоги test_data/, Input/, uploads/ и боевые данные не читаются.

Что проверяется для каждой изменяющей операции:
  * права: 403 у user2 (роль user) и user4 (роль view), успех у admin;
  * серверная валидация файла: пустой, не xlsx, битый, чужой формат, слишком большой — 4xx и БЕЗ изменений (снимок БД до/после совпадает);
  * успех и результат (проверка в БД), повтор того же файла (идемпотентность там, где так в V1);
  * откат: операция, упавшая внутри, не оставляет частичных изменений и НЕ пишет событий в журнал;
  * журнал: событие есть только у сохранённого.
Завершается кодом 1, если хоть одна проверка не прошла.
"""
import hashlib
import io
import json
import sqlite3
import sys
import warnings

warnings.filterwarnings("ignore")
import requests  # noqa: E402
import openpyxl  # noqa: E402

PORT = int(sys.argv[1])
DB = sys.argv[2]
SECTIONS = set(sys.argv[3:]) or {"contracting", "history", "schedule", "objects", "bulk", "drawing", "input", "revit", "settings"}
BASE = f"http://127.0.0.1:{PORT}"
PW = "Test-Pass-1234!"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

FAILS = []
OK = 0


def check(cond, msg):
    global OK
    if cond:
        OK += 1
        print("  ok  ", msg)
    else:
        FAILS.append(msg)
        print("  FAIL", msg)


def login(user):
    s = requests.Session()
    r = s.post(BASE + "/login", json={"domain_login": user, "password": PW})
    assert r.status_code == 200, (user, r.status_code, r.text[:200])
    return s


def con():
    c = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


TABLES = ["counterparties", "agreements", "specifications", "contracts", "contract_lines", "elements", "status_history", "objects", "projects",
          "smu", "individuals", "schedule_versions", "schedule_version_items", "mark_type_prefixes", "status_colors", "label_visibility", "users"]


def snap():
    c = con()
    out = {}
    for t in TABLES:
        try:
            rows = [tuple(r) for r in c.execute(f"SELECT * FROM {t} ORDER BY 1")]
        except sqlite3.Error:
            continue
        out[t] = (len(rows), hashlib.md5(repr(rows).encode()).hexdigest()[:10])
    c.close()
    return out


def changed(a, b):
    return sorted(t for t in b if a.get(t) != b.get(t))


def journal_max():
    c = con()
    n = c.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    c.close()
    return n


def journal_since(n, action=None):
    import time
    time.sleep(1.6)  # очередь журнала пишется пачками раз в секунду
    c = con()
    q = "SELECT * FROM activity_log WHERE id > ?" + (" AND action = ?" if action else "")
    rows = [dict(r) for r in c.execute(q, (n, action) if action else (n,))]
    c.close()
    return rows


def xlsx_bytes(rows, header, title="Лист1"):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = title
    ws.append(header)
    for r in rows:
        ws.append(r)
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


def up(s, path, content, name="f.xlsx", data=None, params=None):
    return s.post(BASE + path, files={"file": (name, content, XLSX)}, data=data or {}, params=params or {}, timeout=300)


def sample(s, key):
    r = s.get(BASE + f"/import-templates/{key}/sample")
    assert r.status_code == 200
    return r.content


def roles_denied(path, content, data=None, params=None, name="f.xlsx"):
    for user in ("user2", "user4"):
        s = login(user)
        before = snap()
        r = up(s, path, content, name=name, data=data, params=params)
        check(r.status_code == 403, f"{path}: {user} получает 403 (получен {r.status_code})")
        check(snap() == before, f"{path}: {user} — БД не изменена")


def bad_files(path, admin, data=None, params=None, what=""):
    """Пустой / не xlsx / битый / без файла: 4xx и БЕЗ изменений и без копии-побочки в БД."""
    for name, content in (("empty.xlsx", b""), ("note.txt", b"hello"), ("bad.xlsx", b"PK not a zip")):
        before = snap()
        r = up(admin, path, content, name=name, data=data, params=params)
        check(400 <= r.status_code < 500, f"{path}: {name} ({what}) → {r.status_code}")
        check(snap() == before, f"{path}: {name} — БД не изменена")
    r = admin.post(BASE + path, data=data or {}, params=params or {})
    check(r.status_code == 422, f"{path}: запрос без файла → {r.status_code}")


def section_contracting():
    print("== импорт контрактации")
    admin = login("admin")
    HEAD = ("Покупатель", "Поставщик", "Договор поставки", "Спецификация", "Наименование товара", "Кол-во")
    new = xlsx_bytes([("АО «Заказчик»", "ООО «Тест-В2»", "V2-001 от 01.09.2026", "1 от 02.09.2026", "Кв5", 3),
                      ("АО «Заказчик»", "ООО «Тест-В2»", "V2-001 от 01.09.2026", "1 от 02.09.2026", "Кв6", 5)], HEAD, "Контрактация")
    roles_denied("/import-contracting-xlsx", new, params={"object_id": 2})
    bad_files("/import-contracting-xlsx", admin, params={"object_id": 2})
    r = up(admin, "/import-contracting-xlsx", new, params={"object_id": 99999})
    check(r.status_code == 404, f"несуществующий объект → {r.status_code}")
    r = up(admin, "/import-contracting-xlsx", new)
    check(r.status_code == 422, f"без object_id → {r.status_code}")
    # успех
    before, j0 = snap(), journal_max()
    r = up(admin, "/import-contracting-xlsx", new, params={"object_id": 2})
    check(r.status_code == 200 and r.json()["rows_processed"] == 2, f"успех: {r.status_code} {r.text[:120]}")
    after = snap()
    check({"counterparties", "agreements", "specifications", "contracts", "contract_lines"} <= set(changed(before, after)), "созданы контрагент/договор/спецификация/контракт/позиции")
    ev = journal_since(j0, "import_contracting")
    check(len(ev) == 1 and ev[0]["entity_id"] == 2, f"в журнале одно событие import_contracting по объекту 2 (найдено {len(ev)})")
    # повтор — идемпотентно
    r = up(admin, "/import-contracting-xlsx", new, params={"object_id": 2})
    check(r.status_code == 200 and r.json()["lines_inserted"] == 0, f"повтор: позиций не добавлено ({r.text[:120]})")
    check(snap() == after, "повтор того же файла не меняет данные")
    # откат: новый договор + строка, ломающая существующий контракт (количество ниже занятого)
    roll = xlsx_bytes([("АО «Заказчик»", "ООО «Тест-Откат»", "V2-ROLL от 01.09.2026", "1 от 02.09.2026", "Кв5", 2),
                       ("АО «Заказчик»", "Контрагент-03", "Д-003 от 09.04.2026", "С-004 от 09.04.2026", "4П-13", 1)], HEAD, "Контрактация")
    before, j0 = snap(), journal_max()
    r = up(admin, "/import-contracting-xlsx", roll, params={"object_id": 1})
    check(r.status_code >= 400, f"откат: файл отклонён стражем ({r.status_code}: {r.text[:160]})")
    check(snap() == before, "откат: частичных изменений нет (снимок БД совпал)")
    check(not journal_since(j0, "import_contracting"), "откат: событий import_contracting в журнале нет")
    # неверные заголовки
    wrong = xlsx_bytes([(1, 2)], ("Что-то", "Ещё"), "Контрактация")
    before = snap()
    r = up(admin, "/import-contracting-xlsx", wrong, params={"object_id": 2})
    check(400 <= r.status_code < 500 and snap() == before, f"чужие заголовки → {r.status_code}, БД не изменена")
    # слишком большой файл (лимит сервера 200 МБ)
    class Zeros(io.RawIOBase):
        def __init__(self, n):
            self.n = n
        def readable(self):
            return True
        def readinto(self, b):
            k = min(len(b), self.n)
            b[:k] = b"\0" * k
            self.n -= k
            return k
    big = io.BufferedReader(Zeros(201 * 1024 * 1024))
    before = snap()
    try:
        r = admin.post(BASE + "/import-contracting-xlsx", params={"object_id": 2}, files={"file": ("big.xlsx", big, XLSX)}, timeout=600)
        check(r.status_code == 413, f"файл 201 МБ → {r.status_code}")
    except requests.RequestException as e:  # сервер оборвал приём — тоже отказ
        check(True, f"файл 201 МБ: приём оборван сервером ({type(e).__name__})")
    check(snap() == before, "файл 201 МБ: БД не изменена")


def upj(s, path, content, name="settings.json", data=None):
    return s.post(BASE + path, files={"file": (name, content, "application/json")}, data=data or {}, timeout=60)


def section_settings():
    print("== экспорт/импорт настроек")
    admin = login("admin")

    # ---- экспорт: права и форма файла ----
    r = admin.get(BASE + "/settings/export")
    check(r.status_code == 200, f"export: 200 (получен {r.status_code})")
    exported = r.json()
    check({"users", "status_colors", "label_visibility", "label_dates_visibility"} <= set(exported), "export: файл содержит все разделы")
    check(any(u.get("password_hash") for u in exported["users"]), "export: файл несёт хэши паролей (как и в V1)")
    for user in ("user2", "user4"):
        r2 = login(user).get(BASE + "/settings/export")
        check(r2.status_code == 403, f"export: {user} получает 403 (получен {r2.status_code})")

    # ---- готовим файл: новый пользователь (create) + изменённый цвет статуса; существующих не трогаем ----
    cur_colors = dict(exported["status_colors"])
    some_status = next(iter(cur_colors))
    new_color = "#00ff00" if cur_colors[some_status] != "#00ff00" else "#00ff01"
    login_tag = "v2settest" + str(int(__import__("time").time()) % 100000)
    payload = {
        "users": [{"domain_login": login_tag, "last_name": "Проверка", "first_name": "V2", "role": "view", "auth_method": "local"}],
        "status_colors": {**cur_colors, some_status: new_color},
        "label_visibility": {}, "label_dates_visibility": {},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    # ---- analyze: права, форма файла, содержимое сверки ----
    for user in ("user2", "user4"):
        before = snap()
        r2 = upj(login(user), "/settings/import/analyze", body)
        check(r2.status_code == 403 and snap() == before, f"analyze: {user} → {r2.status_code}, БД не изменена")
    for name, content, what in (("e.json", b"", "пустой"), ("n.json", b"not json", "не JSON"), ("a.json", b"[1,2]", "не объект")):
        before = snap()
        r2 = upj(admin, "/settings/import/analyze", content, name=name)
        check(400 <= r2.status_code < 500 and snap() == before, f"analyze: {what} файл → {r2.status_code}, БД не изменена")
    before = snap()
    r = upj(admin, "/settings/import/analyze", body)
    check(r.status_code == 200, f"analyze: 200 (получен {r.status_code}: {r.text[:150]})")
    a = r.json()
    check(snap() == before, "analyze: ничего не пишет (снимок БД совпал)")
    check(a["has_changes"] is True, "analyze: has_changes=true")
    check(any(u["kind"] == "create" and u["login"] == login_tag for u in a["users"]), "analyze: новый пользователь показан как create")
    check(not any(u.get("password_set") for u in a["users"] if u["login"] == login_tag), "analyze: без пароля в файле — password_set=false")
    check(any(c["status"] == some_status and c["now"] == new_color for c in a["status_colors"]), "analyze: изменённый цвет статуса показан")
    check("password_hash" not in json.dumps(a), "analyze: хэши паролей в сверке не раскрываются")
    digest = a["digest"]

    # ---- apply: права ----
    for user in ("user2", "user4"):
        before = snap()
        r2 = login(user).post(BASE + "/settings/import/apply", files={"file": ("s.json", body, "application/json")}, data={"digest": digest})
        check(r2.status_code == 403 and snap() == before, f"apply: {user} → {r2.status_code}, БД не изменена")

    # ---- устаревшая сверка: база меняется между analyze и apply (другой администратор поправил цвет напрямую) ----
    other_status = next(s for s in cur_colors if s != some_status)
    c = sqlite3.connect(DB, timeout=30)
    c.execute("UPDATE status_colors SET color = ? WHERE status = ?", ("#123123", other_status))
    c.commit(); c.close()
    before = snap()
    r = admin.post(BASE + "/settings/import/apply", files={"file": ("s.json", body, "application/json")}, data={"digest": digest})
    check(r.status_code == 409, f"apply: устаревшая сверка → {r.status_code} (получен {r.text[:150]})")
    check(snap() == before, "apply: устаревшая сверка — БД не изменена")

    # актуальный digest после прямого изменения базы
    r = upj(admin, "/settings/import/analyze", body)
    digest = r.json()["digest"]

    # ---- откат: сбой посреди применения (несколько таблиц в одной операции) ----
    payload_fault = {
        "users": [{"domain_login": login_tag, "last_name": "Проверка", "first_name": "V2", "role": "view", "auth_method": "local"}],
        "status_colors": {**cur_colors, some_status: new_color, "v2_fault_probe": "#abcdef"},
        "label_visibility": {}, "label_dates_visibility": {},
    }
    body_fault = json.dumps(payload_fault, ensure_ascii=False).encode("utf-8")
    r = upj(admin, "/settings/import/analyze", body_fault)
    check(r.status_code == 200, f"analyze (с провокацией сбоя): 200 (получен {r.status_code})")
    digest_fault = r.json()["digest"]
    j0 = journal_max()
    before = snap()
    with Fault("CREATE TRIGGER v2_fault BEFORE INSERT ON status_colors WHEN NEW.status = 'v2_fault_probe' "
              "BEGIN SELECT RAISE(ABORT, 'v2 test fault'); END"):
        r = admin.post(BASE + "/settings/import/apply", files={"file": ("s.json", body_fault, "application/json")}, data={"digest": digest_fault})
        check(r.status_code >= 400, f"apply: сбой внутри операции → {r.status_code}")
    after = snap()
    check(after == before, "apply: откат — снимок БД совпал (ни пользователь, ни цвет не остались)")
    check(not journal_since(j0, "settings_import"), "apply: откат — событий settings_import в журнале нет")
    check(not rows("SELECT 1 FROM users WHERE domain_login = ?", login_tag), "apply: откат — новый пользователь не создан")

    # ---- успех: применяем по-настоящему (тот же файл без провокации, digest актуальный) ----
    r = upj(admin, "/settings/import/analyze", body)
    digest = r.json()["digest"]
    j0 = journal_max()
    r = admin.post(BASE + "/settings/import/apply", files={"file": ("s.json", body, "application/json")}, data={"digest": digest})
    check(r.status_code == 200, f"apply: успех → {r.status_code} ({r.text[:150]})")
    res = r.json()
    check(res["users_upserted"] == 1, f"apply: users_upserted=1 (получено {res.get('users_upserted')})")
    new_user = rows("SELECT * FROM users WHERE domain_login = ?", login_tag)
    check(len(new_user) == 1 and new_user[0]["role"] == "view" and not new_user[0]["password_hash"], "apply: пользователь создан без пароля, роль view")
    color_row = rows("SELECT color FROM status_colors WHERE status = ?", some_status)
    check(color_row and color_row[0]["color"] == new_color, "apply: цвет статуса применён")
    ev = journal_since(j0, "settings_import")
    check(len(ev) == 1, f"apply: одно событие settings_import в журнале (найдено {len(ev)})")
    check("password_hash" not in (ev[0].get("details") or "") and "password_hash" not in (ev[0].get("new_value") or ""), "apply: журнал не содержит хэш пароля")

    # ---- повторное применение того же файла: пользователь уже есть — update, а не create; изменений в цвете нет ----
    r = upj(admin, "/settings/import/analyze", body)
    a2 = r.json()
    check(not any(u["login"] == login_tag for u in a2["users"]), "повторная сверка: пользователь уже как в файле — без правок")
    check(not any(c["status"] == some_status for c in a2["status_colors"]), "повторная сверка: цвет уже как в файле — без правок")

    # ---- одношаговый V1-эндпоинт (/settings/import): совместимость после рефакторинга общей логики ----
    v1_status = next(s for s in cur_colors if s not in (some_status, "v2_fault_probe"))
    v1_color = "#654321"
    v1_payload = {"users": [], "status_colors": {**cur_colors, some_status: new_color, v1_status: v1_color},
                 "label_visibility": {}, "label_dates_visibility": {}}
    j0 = journal_max()
    r = upj(admin, "/settings/import", json.dumps(v1_payload, ensure_ascii=False).encode("utf-8"))
    check(r.status_code == 200, f"V1 /settings/import: 200 (получен {r.status_code}: {r.text[:150]})")
    check(rows("SELECT color FROM status_colors WHERE status = ?", v1_status)[0]["color"] == v1_color, "V1 /settings/import: цвет применён")
    check(len(journal_since(j0, "settings_import")) == 1, "V1 /settings/import: событие в журнале")
    # V1-эндпоинт тоже атомарен теперь (begin_write): сбой посреди — откат без частичных изменений
    before = snap()
    j0 = journal_max()
    bad_v1 = {"users": [], "status_colors": {some_status: "not-a-color"}, "label_visibility": {}, "label_dates_visibility": {}}
    r = upj(admin, "/settings/import", json.dumps(bad_v1, ensure_ascii=False).encode("utf-8"))
    check(r.status_code == 422, f"V1 /settings/import: неверный цвет → {r.status_code}")
    check(snap() == before, "V1 /settings/import: неверный цвет — БД не изменена")
    check(not journal_since(j0, "settings_import"), "V1 /settings/import: неверный цвет — журнала нет")


# ---------------------------------------------------------------- вспомогательное: внесение сбоя в копию БД
class Fault:
    """Временный триггер в КОПИИ БД: заставляет операцию упасть посреди записи — так проверяется откат и отсутствие событий журнала."""

    def __init__(self, sql):
        self.sql = sql

    def __enter__(self):
        c = sqlite3.connect(DB, timeout=30)
        c.execute("DROP TRIGGER IF EXISTS v2_fault")
        c.execute(self.sql)
        c.commit()
        c.close()

    def __exit__(self, *a):
        c = sqlite3.connect(DB, timeout=30)
        c.execute("DROP TRIGGER IF EXISTS v2_fault")
        c.commit()
        c.close()


def rows(q, *args):
    c = con()
    out = [dict(r) for r in c.execute(q, args)]
    c.close()
    return out


def section_history():
    print("== импорт истории статусов / восстановление")
    import time
    admin = login("admin")
    src = "Чертёж-4.dxf"
    HEAD = ["DXF handle", "Марка", "Статус", "Статус изменён", "Кто изменил", "Комментарий"]
    els = rows("SELECT id, dxf_handle, mark FROM elements WHERE source_file=? AND is_current=1 AND current_status='planned' ORDER BY id LIMIT 6", src)
    assert len(els) >= 6, "нужно ≥ 6 запланированных изделий объекта 2"
    a, b_, c_ = els[0:3]
    d, e, f = els[3:6]
    tag = str(int(time.time()))[-4:]
    delivered = [[x["dxf_handle"], x["mark"], "Доставлен", "2026-09-01 09:00:00", "Тест В2", f"импорт {tag}"] for x in (a, b_, c_)]
    file_merge = xlsx_bytes(delivered, HEAD, "Статус на дату")
    form = {"source_file": src, "mode": "merge"}
    roles_denied("/import-history-xlsx", file_merge, data=form)
    bad_files("/import-history-xlsx", admin, data=form)
    before = snap()
    r = up(admin, "/import-history-xlsx", file_merge, data={"source_file": src, "mode": "xyz"})
    check(r.status_code == 422 and snap() == before, f"неизвестный режим → {r.status_code}, БД не изменена")
    r = up(admin, "/import-history-xlsx", file_merge, data={"mode": "merge"})
    check(r.status_code == 422, f"без source_file → {r.status_code}")
    wrong = xlsx_bytes([[1, 2]], ["Что-то", "Ещё"], "Статус на дату")
    r = up(admin, "/import-history-xlsx", wrong, data=form)
    check(400 <= r.status_code < 500 and snap() == before, f"чужие заголовки → {r.status_code}, БД не изменена")
    # дополнить
    j0 = journal_max()
    r = up(admin, "/import-history-xlsx", file_merge, data=form)
    check(r.status_code == 200 and r.json()["inserted"] == 3, f"merge: добавлено 3 ({r.text[:100]})")
    st = rows("SELECT current_status, actual_delivery_date FROM elements WHERE id IN (?,?,?)", a["id"], b_["id"], c_["id"])
    check(all(x["current_status"] == "delivered" for x in st), "текущий статус изделий пересчитан: «Доставлен»")
    ev = journal_since(j0)
    check(len([x for x in ev if x["action"] == "import_history"]) == 1 and len([x for x in ev if x["action"] == "history_import"]) == 3, "журнал: одно сводное и три поэлементных события")
    # повтор
    s1 = snap()
    r = up(admin, "/import-history-xlsx", file_merge, data=form)
    check(r.status_code == 200 and r.json()["inserted"] == 0 and r.json()["skipped_duplicate"] == 3, f"повтор merge: дубли пропущены ({r.text[:100]})")
    check(changed(s1, snap()) in ([], ["elements"]), f"повтор merge: история не меняется (изменились: {changed(s1, snap())})")
    # скорректировать даты
    file_sync = xlsx_bytes([[x["dxf_handle"], x["mark"], "Доставлен", "2026-09-02 10:00:00", "Тест В2", f"импорт {tag}"] for x in (a, b_, c_)], HEAD, "Статус на дату")
    n_before = rows("SELECT COUNT(*) n FROM status_history")[0]["n"]
    r = up(admin, "/import-history-xlsx", file_sync, data={"source_file": src, "mode": "sync"})
    check(r.status_code == 200 and r.json()["updated"] == 3, f"sync: исправлено 3 записи ({r.text[:100]})")
    check(rows("SELECT COUNT(*) n FROM status_history")[0]["n"] == n_before, "sync: новых записей не создано (нет дублей)")
    # заменить
    file_rep = xlsx_bytes([[x["dxf_handle"], x["mark"], "Смонтирован", "2026-09-03 11:00:00", "Тест В2", None] for x in (a, b_)], HEAD, "Статус на дату")
    r = up(admin, "/import-history-xlsx", file_rep, data={"source_file": src, "mode": "replace"})
    check(r.status_code == 200, f"replace: {r.status_code}")
    check(all(rows("SELECT COUNT(*) n FROM status_history WHERE element_id=?", x["id"])[0]["n"] == 1 for x in (a, b_)), "replace: у сопоставленных изделий ровно одна запись (прежняя история заменена)")
    check(rows("SELECT COUNT(*) n FROM status_history WHERE element_id=?", c_["id"])[0]["n"] == 2, "replace: у изделия вне файла история не тронута")
    # откат: изделие привязывается к контракту, в котором нет его позиции → страж покрытия (409); события журнала не должны остаться
    contract_rows = [[d["dxf_handle"], d["mark"], "Контрактация", "2026-09-04 09:00:00", "Тест В2", None, "ООО «Тест-В2»", "V2-001 от 01.09.2026", "1 от 02.09.2026"]]
    file_roll = xlsx_bytes(contract_rows, HEAD + ["Поставщик", "Договор (номер и дата)", "Спецификация (номер и дата)"], "Статус на дату")
    before, j0 = snap(), journal_max()
    r = up(admin, "/import-history-xlsx", file_roll, data={"source_file": src, "mode": "merge"})
    check(r.status_code == 409, f"откат: страж покрытия отклонил файл → {r.status_code} {r.text[:120]}")
    check(snap() == before, "откат: частичных изменений нет (снимок БД совпал)")
    check(not [x for x in journal_since(j0) if x["action"] in ("import_history", "history_import")], "откат: событий истории в журнале нет (нет записей о несостоявшемся)")


def section_schedule():
    print("== импорт графика MS Project")
    admin = login("admin")
    HEAD = ["Тип и Подтип", "Начало", "Окончание", "Кран", "Захватка", "Стоянка", "Этаж"]
    row = ["Колонна верхняя", "Пн 07.09.26", "Пт 11.09.26", "Кран 1", "Захватка 1", "Стоянка 01", "7 этаж"]
    f1 = xlsx_bytes([row], HEAD, "График СМР")
    form = {"object_id": "2", "kind": "baseline"}
    roles_denied("/import-schedule-xlsx", f1, data=form)
    bad_files("/import-schedule-xlsx", admin, data=form)
    before = snap()
    r = up(admin, "/import-schedule-xlsx", f1, data={"object_id": "2", "kind": "xyz"})
    check(r.status_code == 422 and snap() == before, f"неизвестный вид → {r.status_code}, БД не изменена")
    r = up(admin, "/import-schedule-xlsx", f1, data={"object_id": "99999", "kind": "baseline"})
    check(r.status_code == 404 and snap() == before, f"несуществующий объект → {r.status_code}, БД не изменена")
    j0 = journal_max()
    r = up(admin, "/import-schedule-xlsx", f1, data=form)
    check(r.status_code == 200 and r.json()["elements_updated"] > 0, f"baseline: изделий обновлено {r.json().get('elements_updated')}")
    n = r.json()["elements_updated"]
    dates = rows("SELECT COUNT(*) n FROM elements WHERE object_id=2 AND project_delivery_date='2026-09-11'")[0]["n"]
    check(dates == n, f"baseline: даты завершения проставлены в изделия ({dates} = {n})")
    ev = journal_since(j0)
    check(len([x for x in ev if x["action"] == "import_schedule"]) == 1 and len([x for x in ev if x["action"] == "schedule_import"]) == n, "журнал: сводное событие и по событию на изделие")
    v1 = rows("SELECT COUNT(*) n FROM schedule_versions WHERE object_id=2")[0]["n"]
    r = up(admin, "/import-schedule-xlsx", f1, data=form)
    check(r.status_code == 200, "повтор baseline: 200")
    check(rows("SELECT COUNT(*) n FROM schedule_versions WHERE object_id=2")[0]["n"] == v1, "повтор baseline: базовая версия заменяется, не копится")
    check(rows("SELECT COUNT(*) n FROM elements WHERE object_id=2 AND project_delivery_date='2026-09-11'")[0]["n"] == n, "повтор baseline: даты те же")
    # прогноз: новая версия, поля изделий не трогает
    f2 = xlsx_bytes([["Колонна верхняя", "Пн 14.09.26", "Пт 18.09.26", "Кран 1", "Захватка 1", "Стоянка 01", "7 этаж"]], HEAD, "График СМР")
    r = up(admin, "/import-schedule-xlsx", f2, data={"object_id": "2", "kind": "current"})
    check(r.status_code == 200 and r.json()["kind"] == "current", f"прогноз: {r.status_code}")
    check(rows("SELECT COUNT(*) n FROM schedule_versions WHERE object_id=2")[0]["n"] == v1 + 1, "прогноз: добавлена новая версия")
    check(rows("SELECT COUNT(*) n FROM elements WHERE object_id=2 AND project_delivery_date='2026-09-18'")[0]["n"] == 0, "прогноз: даты изделий не менялись")
    r = up(admin, "/import-schedule-xlsx", f2, data={"object_id": "2", "kind": "current"})
    check(rows("SELECT COUNT(*) n FROM schedule_versions WHERE object_id=2")[0]["n"] == v1 + 2, "повтор прогноза: версии копятся (как в V1)")
    # откат: сбой при сохранении версии после проставления дат
    f3 = xlsx_bytes([["Колонна верхняя", "Пн 21.09.26", "Пт 25.09.26", "Кран 1", "Захватка 1", "Стоянка 01", "7 этаж"]], HEAD, "График СМР")
    before, j0 = snap(), journal_max()
    with Fault("CREATE TRIGGER v2_fault BEFORE INSERT ON schedule_versions BEGIN SELECT RAISE(ABORT, 'v2 fault'); END"):
        r = up(admin, "/import-schedule-xlsx", f3, data=form)
    check(r.status_code >= 500, f"откат: сбой внутри операции → {r.status_code}")
    check(snap() == before, "откат: даты изделий и версии не изменены (снимок БД совпал)")
    check(not [x for x in journal_since(j0) if x["action"] in ("import_schedule", "schedule_import")], "откат: событий графика в журнале нет")


def section_objects():
    print("== справочник объектов из Excel")
    import time
    tag = str(int(time.time()))[-5:]
    admin = login("admin")
    HEAD = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"]
    new_name = f"Тест-В2 объект {tag}"
    f = xlsx_bytes([[new_name, "г. Город, ул. Тестовая, 1", f"СМУ-Тест-{tag}", None, None, "Активный", 55.75, 37.61, None, None],
                    ["Объект-2", None, None, None, None, None, None, None, "https://example.test/v2", None]], HEAD, "Объекты на карте")
    roles_denied("/objects-import/analyze", f)
    bad_files("/objects-import/analyze", admin)
    before = snap()
    r = up(admin, "/objects-import/analyze", f)
    check(r.status_code == 200, f"сверка: {r.status_code}")
    data = r.json()
    check(data["objects_new"] == 1 and any(c["kind"] == "update" and c["field"] == "media_url" for c in data["changes"]), f"сверка: 1 новый объект и правка Объекта-2 ({data['objects_new']}, {len(data['changes'])} правок)")
    check(snap() == before, "сверка ничего не пишет (снимок БД совпал)")
    changes = data["changes"]
    # права на применение
    for user in ("user2", "user4"):
        s = login(user)
        r = s.post(BASE + "/objects-import/apply", json={"changes": changes})
        check(r.status_code == 403 and snap() == before, f"apply: {user} → {r.status_code}, БД не изменена")
    r = admin.post(BASE + "/objects-import/apply", json={"changes": []})
    check(r.status_code == 400, f"apply без правок → {r.status_code}")
    # недопустимые поля (защита от подстановки колонок)
    bad_create = [{**changes[0], "fields": {"status": "active", "name) VALUES ('x'); --": 1}}] if changes[0]["kind"] == "create" else []
    if bad_create:
        r = admin.post(BASE + "/objects-import/apply", json={"changes": bad_create})
        check(r.status_code == 400 and snap() == before, f"apply: чужое имя колонки в «новом объекте» → {r.status_code}, БД не изменена")
    bad_update = [{"kind": "update", "key": "Объект-2", "field": "id", "now": 5, "was": 2}]
    r = admin.post(BASE + "/objects-import/apply", json={"changes": bad_update})
    check(r.status_code == 400 and snap() == before, f"apply: недопустимое поле правки → {r.status_code}, БД не изменена")
    # откат: второй объект падает при вставке — первый не должен остаться
    f_roll = xlsx_bytes([[f"Тест-В2 первый {tag}", None, None, None, None, "Активный", None, None, None, None],
                         [f"Тест-В2 ОТКАТ {tag}", None, None, None, None, "Активный", None, None, None, None]], HEAD, "Объекты на карте")
    ch_roll = admin.post(BASE + "/objects-import/analyze", files={"file": ("f.xlsx", f_roll, XLSX)}).json()["changes"]
    before, j0 = snap(), journal_max()
    with Fault("CREATE TRIGGER v2_fault BEFORE INSERT ON objects WHEN NEW.name LIKE '%ОТКАТ%' BEGIN SELECT RAISE(ABORT, 'v2 fault'); END"):
        r = admin.post(BASE + "/objects-import/apply", json={"changes": ch_roll})
    check(r.status_code >= 500, f"откат: сбой на втором объекте → {r.status_code}")
    check(snap() == before, "откат: первый объект, проект и справочник не остались (снимок БД совпал)")
    check(not [x for x in journal_since(j0) if x["action"] in ("object_import", "project_create")], "откат: событий в журнале нет")
    # применение
    j0 = journal_max()
    r = admin.post(BASE + "/objects-import/apply", json={"changes": changes})
    check(r.status_code == 200 and r.json()["created"] == 1 and r.json()["updated"] == 1, f"apply: создан 1, обновлён 1 ({r.text[:100]})")
    check(rows("SELECT COUNT(*) n FROM objects WHERE name=?", new_name)[0]["n"] == 1 and rows("SELECT COUNT(*) n FROM projects WHERE name=?", new_name)[0]["n"] == 1, "в БД есть новый объект и проект с тем же названием")
    check(rows("SELECT media_url FROM objects WHERE name='Объект-2'")[0]["media_url"] == "https://example.test/v2", "правка Объекта-2 записана")
    ev = journal_since(j0)
    check(len([x for x in ev if x["action"] == "object_import"]) == 2 and len([x for x in ev if x["action"] == "project_create"]) == 1, "журнал: 2 события объектов и создание проекта")
    # повтор
    n_obj = rows("SELECT COUNT(*) n FROM objects")[0]["n"]
    r = admin.post(BASE + "/objects-import/apply", json={"changes": changes})
    check(r.status_code == 200 and r.json()["created"] == 0 and len(r.json()["skipped"]) == 1, f"повтор apply: новый объект не задваивается, пропущен ({r.text[:120]})")
    check(rows("SELECT COUNT(*) n FROM objects")[0]["n"] == n_obj, "повтор apply: число объектов то же")
    # вернуть правку Объекта-2
    c = sqlite3.connect(DB, timeout=30)
    c.execute("UPDATE objects SET media_url=NULL WHERE name='Объект-2'")
    c.commit()
    c.close()



def section_bulk():
    print("== массовая правка через Excel")
    import time
    from concurrent.futures import ThreadPoolExecutor
    admin = login("admin")
    SRC = "Чертёж-4.dxf"
    # ---- выгрузка
    for user in ("user2", "user4"):
        r = login(user).post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "object_id": 2})
        check(r.status_code == 403, f"export: {user} → {r.status_code}")
    r = admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "object_id": 2})
    check(r.status_code == 200 and r.content[:2] == b"PK", f"export по объекту 2: {r.status_code}, {len(r.content)} байт")
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    ws = wb["Элементы"]
    check(ws.max_row - 1 == rows("SELECT COUNT(*) n FROM elements WHERE object_id=2 AND is_current=1")[0]["n"], f"export по объекту: строк {ws.max_row - 1} = числу изделий объекта")
    check(all(ws.cell(row=i, column=2).value == "Объект-2" for i in range(2, min(ws.max_row, 50) + 1)), "export по объекту: все строки — Объект-2")
    check(admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "object_id": 2, "element_ids": [1]}).status_code == 400, "export: object_id вместе с element_ids → 400")
    check(admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "contracting", "object_id": 2}).status_code == 400, "export контрактации с object_id → 400")
    check(admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "object_id": 99999}).status_code == 404, "export: несуществующий объект → 404")
    check(admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "object_id": 12}).status_code == 400, "export: у объекта нет изделий → 400")
    check(admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "zzz"}).status_code == 400, "export: неизвестный режим → 400")
    els = rows("SELECT id, mark, element_uid FROM elements WHERE object_id=2 AND is_current=1 AND current_status='planned' ORDER BY id LIMIT 4")
    ids = [x["id"] for x in els]
    r = admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "element_ids": ids})
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    ws = wb["Элементы"]
    head = [c.value for c in ws[1]]
    col = {h: i + 1 for i, h in enumerate(head)}
    tag = str(int(time.time()))[-4:]
    # ---- права на сверку и применение
    plain = io.BytesIO()
    wb.save(plain)
    roles_denied("/elements/bulk-edit/analyze", plain.getvalue(), data={"mode": "fields"})
    for user in ("user2", "user4"):
        r = login(user).post(BASE + "/elements/bulk-edit/apply", json={"changes": [{"element_id": ids[0], "field": "comment", "now": "x"}], "mode": "fields"})
        check(r.status_code == 403, f"apply: {user} → {r.status_code}")
    bad_files("/elements/bulk-edit/analyze", admin, data={"mode": "fields"})
    r = up(admin, "/elements/bulk-edit/analyze", plain.getvalue(), data={"mode": "zzz"})
    check(r.status_code == 400, f"analyze: неизвестный режим → {r.status_code}")
    # ---- реквизиты: правка → сверка → применение → повтор
    ws.cell(row=2, column=col["Комментарий"]).value = f"v2 комментарий {tag}"
    FLOOR = 100 + int(tag) % 800
    ws.cell(row=3, column=col["Этаж"]).value = FLOOR
    buf = io.BytesIO()
    wb.save(buf)
    before = snap()
    r = up(admin, "/elements/bulk-edit/analyze", buf.getvalue(), data={"mode": "fields"})
    check(r.status_code == 200 and len(r.json()["changes"]) == 2, f"analyze fields: 2 расхождения ({r.status_code})")
    check(snap() == before, "analyze: ничего не пишет (снимок БД совпал)")
    changes = r.json()["changes"]
    j0 = journal_max()
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": changes, "mode": "fields"})
    check(r.status_code == 200 and r.json()["elements_updated"] == 2 and not r.json()["skipped"], f"apply fields: {r.text[:100]}")
    c_comment = next(c for c in changes if c["field"] == "comment")
    c_floor = next(c for c in changes if c["field"] == "floor")
    check(rows("SELECT comment FROM elements WHERE id=?", c_comment["element_id"])[0]["comment"] == f"v2 комментарий {tag}" and rows("SELECT floor FROM elements WHERE id=?", c_floor["element_id"])[0]["floor"] == FLOOR, "значения записаны в БД")
    ev = journal_since(j0, "element_bulk_edit")
    check(len(ev) == 2, f"журнал: 2 события element_bulk_edit (найдено {len(ev)})")
    j1 = journal_max()
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": changes, "mode": "fields"})
    check(r.status_code == 200 and r.json()["elements_updated"] == 0, f"повтор apply: ничего не меняется ({r.text[:80]})")
    check(not journal_since(j1, "element_bulk_edit"), "повтор apply: новых событий журнала нет")
    # ---- недопустимые поля в теле (нельзя писать произвольные колонки)
    before = snap()
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": [{"element_id": ids[0], "field": "object_id", "now": 1, "was": 2}], "mode": "fields"})
    check(r.status_code == 400 and snap() == before, f"apply: недопустимое поле → {r.status_code}, БД не изменена")
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": [], "mode": "fields"})
    check(r.status_code == 400, f"apply без правок → {r.status_code}")
    # ---- откат: вторая правка падает — первая не должна остаться, журнал пуст
    ch_roll = [{"element_id": ids[2], "field": "floor", "now": 11, "was": None}, {"element_id": ids[3], "field": "comment", "now": "__FAIL__", "was": None}]
    before, j0 = snap(), journal_max()
    with Fault("CREATE TRIGGER v2_fault BEFORE UPDATE OF comment ON elements WHEN NEW.comment = '__FAIL__' BEGIN SELECT RAISE(ABORT, 'v2 fault'); END"):
        r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": ch_roll, "mode": "fields"})
    check(r.status_code >= 500, f"откат: сбой внутри применения → {r.status_code}")
    check(snap() == before, "откат: первая правка не осталась (снимок БД совпал)")
    check(not journal_since(j0, "element_bulk_edit"), "откат: событий в журнале нет")
    # ---- конкуренция: два одинаковых применения одновременно → одно изменение, второе — пустое
    ch_c = [{"element_id": ids[2], "field": "comment", "now": f"конкуренция {tag}", "was": None}]
    j0 = journal_max()

    def go(_):
        return login("admin").post(BASE + "/elements/bulk-edit/apply", json={"changes": ch_c, "mode": "fields"})
    with ThreadPoolExecutor(2) as ex:
        res = list(ex.map(go, range(2)))
    codes = sorted(x.status_code for x in res)
    upd = sorted(x.json().get("elements_updated") for x in res if x.status_code == 200)
    check(codes == [200, 200] and upd == [0, 1], f"два одновременных применения: ответы {codes}, обновлено {upd} — записано один раз ({[x.text[:120] for x in res if x.status_code != 200]})")
    check(len(journal_since(j0, "element_bulk_edit")) == 1, "конкуренция: в журнале одно событие")
    # ---- назначение контракта запланированному изделию (событие «Контрактация» + дата)
    cand = rows("SELECT id, mark FROM elements WHERE object_id=2 AND is_current=1 AND current_status='planned' AND contract_id IS NULL AND mark IN ('Кв5','Кв6') ORDER BY id LIMIT 1")
    check(bool(cand), "есть запланированное изделие с маркой из позиций контракта V2-001")
    cand = cand[0]
    r = admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "fields", "element_ids": [cand["id"]]})
    wb2 = openpyxl.load_workbook(io.BytesIO(r.content))
    names = [c.value for c in wb2["Контракты"]["A"][1:] if c.value]
    cname = next((n for n in names if "V2-001" in str(n)), None)
    check(cname is not None, f"в справочнике файла есть контракт V2-001 ({cname})")
    if cname:
        w2 = wb2["Элементы"]
        h2 = [c.value for c in w2[1]]
        w2.cell(row=2, column=h2.index("Контракт") + 1).value = cname
        b2 = io.BytesIO()
        wb2.save(b2)
        an = up(admin, "/elements/bulk-edit/analyze", b2.getvalue(), data={"mode": "fields"}).json()
        cc = [c for c in an["changes"] if c["field"] == "contract_id"]
        check(len(cc) == 1 and cc[0].get("needs_contracting"), f"analyze: назначение контракта помечено needs_contracting ({len(cc)})")
        if cc:
            before = snap()
            r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": cc, "mode": "fields", "contracting_date": None})
            check(r.status_code == 200 and len(r.json()["skipped"]) == 1 and snap() == before, f"без даты статуса: правка пропущена с причиной, БД не изменена ({r.text[:120]})")
            r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": cc, "mode": "fields", "contracting_date": "2026-09-05"})
            st = rows("SELECT current_status, contract_id FROM elements WHERE id=?", cand["id"])[0]
            check(r.status_code == 200 and st["current_status"] == "contracting" and st["contract_id"], f"с датой: статус «Контрактация» и контракт записаны ({st})")
            check(rows("SELECT COUNT(*) n FROM status_history WHERE element_id=? AND status='contracting'", cand["id"])[0]["n"] == 1, "в истории появилась запись «Контрактация»")
    # ---- история статусов
    r = admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "statuses", "element_ids": [ids[1], ids[2]]})
    wb3 = openpyxl.load_workbook(io.BytesIO(r.content))
    w3 = wb3["История статусов"]
    h3 = [c.value for c in w3[1]]
    import datetime as _dt
    w3.cell(row=2, column=h3.index("Дата и время установки") + 1).value = _dt.datetime(2026, 8, 1 + int(tag) % 27, 10, int(tag) % 60, 0)
    b3 = io.BytesIO()
    wb3.save(b3)
    an = up(admin, "/elements/bulk-edit/analyze", b3.getvalue(), data={"mode": "statuses"}).json()
    check(len(an["changes"]) == 1, f"analyze statuses: 1 расхождение ({len(an['changes'])})")
    j0 = journal_max()
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": an["changes"], "mode": "statuses"})
    check(r.status_code == 200 and r.json()["records_updated"] == 1, f"apply statuses: {r.text[:100]}")
    check(len(journal_since(j0, "status_bulk_edit")) == 1, "журнал: событие status_bulk_edit")
    # ---- контрактация
    r = admin.post(BASE + "/elements/bulk-edit/export", json={"mode": "contracting"})
    wb4 = openpyxl.load_workbook(io.BytesIO(r.content))
    w4 = wb4["Контрактация"]
    h4 = [c.value for c in w4[1]]
    target_row = next(i for i in range(2, w4.max_row + 1) if w4.cell(row=i, column=h4.index("Марка") + 1).value == cand["mark"] and "V2-001" in str(w4.cell(row=i, column=h4.index("Контракт (справочно)") + 1).value))
    QTY = 10 + int(tag) % 30
    w4.cell(row=target_row, column=h4.index("Количество") + 1).value = QTY
    b4 = io.BytesIO()
    wb4.save(b4)
    an = up(admin, "/elements/bulk-edit/analyze", b4.getvalue(), data={"mode": "contracting"}).json()
    check(len(an["changes"]) == 1 and an["changes"][0]["field"] == "quantity", f"analyze contracting: изменение количества ({len(an['changes'])})")
    j0 = journal_max()
    r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": an["changes"], "mode": "contracting"})
    check(r.status_code == 200 and r.json()["entities_updated"] >= 1, f"apply contracting: {r.text[:100]}")
    check(rows("SELECT quantity FROM contract_lines WHERE id=?", an["changes"][0]["line_id"])[0]["quantity"] == QTY, "количество позиции записано")
    check(len(journal_since(j0, "contracting_bulk_edit")) >= 1, "журнал: событие contracting_bulk_edit")
    # страж покрытия: количество ниже уже привязанного не применяется (правка возвращается, попадает в «пропущено»)
    w4.cell(row=target_row, column=h4.index("Количество") + 1).value = 0
    b5 = io.BytesIO()
    wb4.save(b5)
    an = up(admin, "/elements/bulk-edit/analyze", b5.getvalue(), data={"mode": "contracting"}).json()
    line_id = an["changes"][0]["line_id"] if an["changes"] else None
    qty_before = rows("SELECT quantity FROM contract_lines WHERE id=?", line_id)[0]["quantity"] if line_id else None
    if an["changes"]:
        j0 = journal_max()
        r = admin.post(BASE + "/elements/bulk-edit/apply", json={"changes": an["changes"], "mode": "contracting"})
        check(r.status_code == 200 and len(r.json()["skipped"]) == 1, f"количество ниже привязанного: правка пропущена с причиной ({r.text[:140]})")
        check(rows("SELECT quantity FROM contract_lines WHERE id=?", line_id)[0]["quantity"] == qty_before, "количество осталось прежним")
        check(not journal_since(j0, "contracting_bulk_edit"), "пропущенная правка не попала в журнал")
    else:
        check(bool(an["rejected"]), f"количество ниже привязанного отклонено уже на сверке ({an['rejected'][:1]})")



def section_drawing():
    print("== загрузка чертежа DXF")
    import time
    from concurrent.futures import ThreadPoolExecutor
    tag = str(int(time.time()))[-5:]
    admin = login("admin")
    sample_dxf = sample(admin, "dxf")
    # свежий объект под чертёж (через справочник объектов, как в интерфейсе)
    name = f"Тест-В2 чертёж {tag}"
    HEAD = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"]
    f = xlsx_bytes([[name, None, None, None, None, "Активный", None, None, None, None]], HEAD, "Объекты на карте")
    ch = admin.post(BASE + "/objects-import/analyze", files={"file": ("o.xlsx", f, XLSX)}).json()["changes"]
    admin.post(BASE + "/objects-import/apply", json={"changes": ch})
    oid = rows("SELECT id FROM objects WHERE name=?", name)[0]["id"]

    def analyze(session, dxf=sample_dxf, fname=f"v2_{tag}.dxf", object_id=oid):
        data = {"object_id": str(object_id)} if object_id is not None else {}
        return session.post(BASE + "/import-dxf/analyze", files={"file": (fname, dxf, "application/octet-stream")}, data=data, timeout=300)

    # права на разбор
    for user in ("user2", "user4"):
        before = snap()
        r = analyze(login(user))
        check(r.status_code == 403 and snap() == before, f"analyze: {user} → {r.status_code}, БД не изменена")
    # валидация файла
    for fname, content in (("empty.dxf", b""), ("junk.dxf", "это не чертёж".encode("utf-8")), ("note.txt", b"hello")):
        before = snap()
        r = analyze(admin, content, fname)
        check(400 <= r.status_code < 500 and snap() == before, f"analyze: {fname} → {r.status_code} ({r.text[:80]}), БД не изменена")
    r = admin.post(BASE + "/import-dxf/analyze", data={"object_id": str(oid)})
    check(r.status_code == 422, f"analyze без файла → {r.status_code}")
    r = analyze(admin, object_id=99999)
    check(400 <= r.status_code < 500, f"analyze: несуществующий объект → {r.status_code}")
    # разбор ничего не пишет
    before = snap()
    r = analyze(admin)
    check(r.status_code == 200 and r.json()["counts"]["new"] > 0, f"analyze: 200, новых {r.json()['counts']['new']}")
    check(snap() == before, "analyze: изделия, зоны, справочники и объекты не изменены (снимок БД совпал)")
    an = r.json()
    token = an["token"]
    check(rows("SELECT COUNT(*) n FROM elements WHERE object_id=?", oid)[0]["n"] == 0, "analyze: изделий объекта в БД нет")
    # права на применение (токен принадлежит разбору админа)
    for user in ("user2", "user4"):
        r = login(user).post(BASE + "/import-dxf/apply", json={"token": token, "accept_mark_changes": True, "keep_mark_element_ids": [], "refill_manual_fields": {}, "create_new_zone_ids": []})
        check(r.status_code == 403 and snap() == before, f"apply: {user} → {r.status_code}, БД не изменена")
    r = admin.post(BASE + "/import-dxf/apply", json={"token": "0" * 32, "accept_mark_changes": True, "keep_mark_element_ids": [], "refill_manual_fields": {}, "create_new_zone_ids": []})
    check(r.status_code == 410, f"apply: неизвестный токен → {r.status_code} ({r.text[:70]})")
    # двойная отправка: два одновременных применения одного токена
    body = {"token": token, "accept_mark_changes": True, "keep_mark_element_ids": [], "refill_manual_fields": {}, "create_new_zone_ids": []}
    j0 = journal_max()

    def go(_):
        return login("admin").post(BASE + "/import-dxf/apply", json=body, timeout=300)
    with ThreadPoolExecutor(2) as ex:
        res = list(ex.map(go, range(2)))
    codes = sorted(x.status_code for x in res)
    check(codes[0] == 200 and codes[1] in (409, 410), f"два одновременных применения одного токена: {codes} — выполнено один раз")
    n_el = rows("SELECT COUNT(*) n FROM elements WHERE object_id=? AND is_current=1", oid)[0]["n"]
    check(n_el == an["counts"]["new"], f"в БД {n_el} изделий (= новых в разборе)")
    ev = journal_since(j0)
    check(len([x for x in ev if x["action"] == "import_dxf"]) == 1, "журнал: одно событие import_dxf")
    r = admin.post(BASE + "/import-dxf/apply", json=body)
    check(r.status_code == 410, f"повторное применение того же токена → {r.status_code}")
    check(rows("SELECT COUNT(*) n FROM object_drawings WHERE object_id=? AND is_current=1", oid)[0]["n"] == 1, "у объекта один актуальный чертёж")
    # повторный разбор того же чертежа: все сопоставлены по handle, применение не задваивает
    an2 = analyze(admin).json()
    check(an2["counts"]["new"] == 0 and an2["counts"]["matched_by_handle"] == n_el, f"повторный разбор: сопоставлено по handle {an2['counts']['matched_by_handle']}, новых 0")
    r = admin.post(BASE + "/import-dxf/apply", json={**body, "token": an2["token"]}, timeout=300)
    check(r.status_code == 200 and r.json()["inserted"] == 0, f"повторное применение чертежа: новых 0 ({r.text[:80]})")
    check(rows("SELECT COUNT(*) n FROM elements WHERE object_id=? AND is_current=1", oid)[0]["n"] == n_el, "повторная загрузка: число изделий то же")
    # этапность (как в V1): сбой на этапе зон оставляет записанными завершённые этапы; повтор с тем же токеном догружает
    an3 = analyze(admin, fname=f"v2_{tag}_b.dxf").json()
    body3 = {**body, "token": an3["token"]}
    j0 = journal_max()
    with Fault("CREATE TRIGGER v2_fault BEFORE INSERT ON axis_lines BEGIN SELECT RAISE(ABORT, 'v2 fault'); END"):
        r = admin.post(BASE + "/import-dxf/apply", json=body3, timeout=300)
    check(r.status_code >= 500, f"сбой на этапе «сетка осей»: ответ {r.status_code}")
    check(rows("SELECT COUNT(*) n FROM elements WHERE source_file=?", f"v2_{tag}_b.dxf")[0]["n"] > 0, "этапность: изделия нового файла уже записаны (завершённый этап остался, как в V1)")
    ev = journal_since(j0)
    check(not [x for x in ev if x["action"] == "import_dxf"], "сводное событие import_dxf при сбое не пишется")
    r = admin.post(BASE + "/import-dxf/apply", json=body3, timeout=300)
    check(r.status_code == 200, f"повтор с тем же токеном после сбоя догружает загрузку ({r.status_code})")
    check(rows("SELECT COUNT(*) n FROM axis_lines WHERE source_file=?", f"v2_{tag}_b.dxf")[0]["n"] > 0, "после повтора сетка осей записана")



def section_input():
    print("== загрузка из папки Input")
    import os
    import time
    from concurrent.futures import ThreadPoolExecutor
    tag = str(int(time.time()))[-5:]
    admin = login("admin")
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Input")   # каталог Input/ этой (тестовой) рабочей копии
    os.makedirs(root, exist_ok=True)
    created = []

    def put(name, content):
        path = os.path.join(root, name)
        with open(path, "wb") as fh:
            fh.write(content)
        created.append(path)

    try:
        # объект под пачку
        name = f"Тест-В2 папка {tag}"
        HEAD = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"]
        f = xlsx_bytes([[name, None, None, None, None, "Активный", None, None, None, None]], HEAD, "Объекты на карте")
        ch = admin.post(BASE + "/objects-import/analyze", files={"file": ("o.xlsx", f, XLSX)}).json()["changes"]
        admin.post(BASE + "/objects-import/apply", json={"changes": ch})
        oid = rows("SELECT id FROM objects WHERE name=?", name)[0]["id"]
        # права
        for user in ("user2", "user4"):
            s2 = login(user)
            r = s2.get(BASE + "/admin/input-files")
            r2 = s2.post(BASE + "/admin/import-input", json={"object_id": oid})
            check(r.status_code == 403 and r2.status_code == 403, f"{user}: список папки и загрузка → {r.status_code}/{r2.status_code}")
        # пустая папка
        r = admin.get(BASE + "/admin/input-files")
        check(r.status_code == 200 and r.json() == {"dxf": [], "xlsx": []}, f"пустая папка: {r.text[:80]}")
        # файлы: рабочий чертёж, битый чертёж, таблица графика и таблица без маршрута
        put(f"input_{tag}.dxf", sample(admin, "dxf"))
        put(f"broken_{tag}.dxf", b"not a drawing")
        put(f"прогноз_{tag}.xlsx", xlsx_bytes([["Колонна нижняя", "Пн 05.10.26", "Пт 09.10.26", "Кран 1", "Захватка 1", "Стоянка 01", "1 этаж"]], ["Тип и Подтип", "Начало", "Окончание", "Кран", "Захватка", "Стоянка", "Этаж"], "График СМР"))
        put(f"прочее_{tag}.xlsx", xlsx_bytes([[1]], ["A"], "Лист1"))
        lst = admin.get(BASE + "/admin/input-files").json()
        check(len(lst["dxf"]) == 2 and len(lst["xlsx"]) == 2, f"список папки: {lst}")
        before = snap()
        r = admin.post(BASE + "/admin/import-input", json={"object_id": 99999})
        check(r.status_code == 404 and snap() == before, f"несуществующий объект → {r.status_code}, БД не изменена")
        j0 = journal_max()
        # двойная отправка: вторая при работающей первой получает 409
        def go(_):
            return login("admin").post(BASE + "/admin/import-input", json={"object_id": oid}, timeout=600)
        with ThreadPoolExecutor(2) as ex:
            res = list(ex.map(go, range(2)))
        codes = sorted(x.status_code for x in res)
        check(codes in ([200, 200], [200, 409]), f"две одновременные загрузки: {codes}")
        ok = next(x for x in res if x.status_code == 200).json()["report"]
        text = "\n".join(ok)
        check(f"input_{tag}.dxf" in text and "элементов" in text, f"отчёт: чертёж загружен ({[l[:70] for l in ok][:2]})")
        check(f"broken_{tag}.dxf" in text and "ОШИБКА" in text, "отчёт: битый чертёж — ошибка отдельной строкой, остальные загружены")
        check(rows("SELECT COUNT(*) n FROM elements WHERE source_file=?", f"input_{tag}.dxf")[0]["n"] == 5, "в БД 5 изделий чертежа из папки")
        ev = journal_since(j0, "import_input")
        check(len(ev) >= 1, f"журнал: событие import_input ({len(ev)})")
        # повтор безопасен
        r = admin.post(BASE + "/admin/import-input", json={"object_id": oid}, timeout=600)
        check(r.status_code == 200 and rows("SELECT COUNT(*) n FROM elements WHERE source_file=?", f"input_{tag}.dxf")[0]["n"] == 5, "повторная загрузка: число изделий то же")
    finally:
        for p in created:
            try:
                os.remove(p)
            except OSError:
                pass



def section_revit():
    print("== загрузка из Revit")
    import gzip
    import time
    from concurrent.futures import ThreadPoolExecutor
    tag = str(int(time.time()))[-5:]
    admin = login("admin")
    global TABLES
    saved_tables = TABLES
    TABLES = saved_tables + ["revit_elements", "revit_packages", "object_levels", "object_sections", "object_flats"]
    try:
        def package(section="КР", n=3, uid_tag="a", mark="М", date="2026-09-21", drop_from=0):
            els = []
            for i in range(drop_from, n):
                els.append({"uid": f"v2{tag}-{uid_tag}-{section}-{i:04d}", "id": 1000 + i, "категория": "Стены", "семейство": "Стена", "типоразмер": "Стена_200", "марка": f"{mark}{i}",
                            "уровень": "С01-02_1_этаж_основной_0.000", "отметка_низа": 0, "высота": 3000, "точка": [i * 1000.0, 0.0, 0.0],
                            "контур": [[i * 1000.0, 0], [i * 1000.0 + 800, 0], [i * 1000.0 + 800, 200], [i * 1000.0, 200]], "MCY_Секция": "С01"})
            return json.dumps({"формат": "zhbi-revit-package", "версия_схемы": 1, "выгрузка": {"раздел": section, "модель": "synthetic", "дата": date, "единицы": "мм", "координаты": "общие"},
                               "уровни": [{"имя": "С01-02_1_этаж_основной_0.000", "отметка": 0}], "элементы": els, "помещения": [], "оси": []}, ensure_ascii=False).encode("utf-8")
        pr = admin.get(BASE + "/projects-tree").json()["projects"]
        pid = next(p["id"] for p in pr if any(o["kind"] == "mfr" for o in p["objects"]))
        r = admin.post(BASE + "/objects", json={"name": f"Тест-В2 МФР {tag}", "project_id": pid, "kind": "mfr"})
        check(r.status_code == 200, f"создан объект МФР ({r.status_code})")
        oid = r.json()["id"]

        def analyze(session, files, object_id=oid):
            return session.post(BASE + "/import-revit/analyze", files=[("files", (n, c, "application/octet-stream")) for n, c in files], data={"object_id": str(object_id)}, timeout=300)

        kr = ("kr.zhbi.json", package())
        for user in ("user2", "user4"):
            before = snap()
            r = analyze(login(user), [kr])
            check(r.status_code == 403 and snap() == before, f"analyze: {user} → {r.status_code}, БД не изменена")
        for label, files in (("пустой файл", [("e.json", b"")]), ("не JSON", [("j.json", b"not json")]), ("чужой формат", [("o.json", b'{"format":"other"}')]),
                             ("два пакета одного раздела", [kr, ("kr2.zhbi.json", package(uid_tag="z"))])):
            before = snap()
            r = analyze(admin, files)
            check(400 <= r.status_code < 500 and snap() == before, f"analyze: {label} → {r.status_code} ({r.text[:70]}), БД не изменена")
        r = admin.post(BASE + "/import-revit/analyze", data={"object_id": str(oid)})
        check(r.status_code == 422, f"analyze без файлов → {r.status_code}")
        r = analyze(admin, [kr], object_id=99999)
        check(r.status_code == 404, f"analyze: несуществующий объект → {r.status_code}")
        before = snap()
        r = analyze(admin, [kr, ("ar.zhbi.json", package(section="АР", n=2, uid_tag="b"))])
        check(r.status_code == 200 and r.json()["elements"]["counts"]["новых"] == 5, f"analyze: 200, новых {r.json()['elements']['counts'].get('новых')}")
        check(snap() == before, "analyze: справочники и элементы модели не изменены (снимок БД совпал)")
        token = r.json()["token"]
        for user in ("user2", "user4"):
            r2 = login(user).post(BASE + "/import-revit/apply", json={"token": token})
            check(r2.status_code == 403 and snap() == before, f"apply: {user} → {r2.status_code}, БД не изменена")
        check(admin.post(BASE + "/import-revit/apply", json={"token": "0" * 32}).status_code == 410, "apply: неизвестный токен → 410")
        j0 = journal_max()

        def go(_):
            return login("admin").post(BASE + "/import-revit/apply", json={"token": token}, timeout=300)
        with ThreadPoolExecutor(2) as ex:
            res = list(ex.map(go, range(2)))
        codes = sorted(x.status_code for x in res)
        check(codes[0] == 200 and codes[1] in (409, 410), f"два одновременных применения одного токена: {codes}")
        check(rows("SELECT COUNT(*) n FROM revit_elements WHERE object_id=? AND is_current=1", oid)[0]["n"] == 5, "в БД 5 элементов модели объекта")
        check(len(journal_since(j0, "import_revit")) == 1, "журнал: одно событие import_revit")
        check(admin.post(BASE + "/import-revit/apply", json={"token": token}).status_code == 410, "повторное применение токена → 410")
        # повторный разбор того же — без изменений
        r = analyze(admin, [kr, ("ar.zhbi.json", package(section="АР", n=2, uid_tag="b"))])
        c = r.json()["elements"]["counts"]
        check(c.get("новых", 0) == 0 and c.get("без изменений") == 5, f"повторный разбор: новых 0, без изменений {c.get('без изменений')}")
        # пакет КР без двух элементов: исчезновение списывается только внутри раздела КР
        small = ("kr.zhbi.json", package(n=3, drop_from=2))
        r = analyze(admin, [small])
        c = r.json()["elements"]["counts"]
        check(c.get("исчезло из модели") == 2, f"исчезло из модели (раздел КР): {c.get('исчезло из модели')} — АР не затронут")
        res = admin.post(BASE + "/import-revit/apply", json={"token": r.json()["token"]}, timeout=300)
        check(res.status_code == 200 and res.json()["retired"] == 2, f"apply: списано 2 ({res.text[:80]})")
        check(rows("SELECT COUNT(*) n FROM revit_elements WHERE object_id=? AND is_current=1 AND section_code='АР'", oid)[0]["n"] == 2, "элементы АР остались текущими")
        # старая выгрузка: предупреждение
        r = analyze(admin, [("kr.zhbi.json", package(date="2026-01-01"))])
        check(any("СТАРШЕ" in w for w in r.json()["warnings"]), "выгрузка старше загруженной — предупреждение в сводке")
    finally:
        TABLES = saved_tables


SECTION_FUNCS = {"contracting": section_contracting, "history": section_history, "schedule": section_schedule, "objects": section_objects, "bulk": section_bulk, "drawing": section_drawing, "input": section_input, "revit": section_revit, "settings": section_settings}

if __name__ == "__main__":
    for name in ("contracting", "history", "schedule", "objects", "bulk", "drawing", "input", "revit", "settings"):
        if name in SECTIONS and name in SECTION_FUNCS:
            SECTION_FUNCS[name]()
    print(f"\nПроверок пройдено: {OK}, не пройдено: {len(FAILS)}")
    for f in FAILS:
        print("  НЕ ПРОЙДЕНО:", f)
    sys.exit(1 if FAILS else 0)

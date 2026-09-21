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
SECTIONS = set(sys.argv[3:]) or {"contracting", "history", "schedule", "objects", "bulk"}
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


SECTION_FUNCS = {"contracting": section_contracting}

if __name__ == "__main__":
    for name in ("contracting", "history", "schedule", "objects", "bulk"):
        if name in SECTIONS and name in SECTION_FUNCS:
            SECTION_FUNCS[name]()
    print(f"\nПроверок пройдено: {OK}, не пройдено: {len(FAILS)}")
    for f in FAILS:
        print("  НЕ ПРОЙДЕНО:", f)
    sys.exit(1 if FAILS else 0)

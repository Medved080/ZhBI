"""Общие помощники проверок backend на КОПИИ обезличенной БД (scripts/verify_*.py): подготовка временной копии, данные сценариев,
вызов обработчиков, отслеживание соединений и — для проверок по HTTP — тестовый сервер с подменой авторизации.

Импортировать ПЕРВЫМ: путь к БД (ZHBI_DB_PATH) задаётся до импорта app. Сама БД-источник не меняется.
Подмена авторизации (`X-Test-User: <id>` вместо сеанса) действует ТОЛЬКО в этом тестовом процессе на временной копии; без заголовка запрос
идёт штатной проверкой сеанса (проверка 401 остаётся настоящей).
"""

import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BASE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else None
if BASE is None:
    print("нужен путь к копии обезличенной БД первым аргументом")
    sys.exit(2)
WORK = Path(tempfile.mkdtemp(prefix="zhbi_guard_")) / "work.db"
os.environ["ZHBI_DB_PATH"] = str(WORK)
shutil.copyfile(BASE, WORK)

from fastapi import HTTPException  # noqa: E402

import app.db as appdb  # noqa: E402

assert Path(appdb.DB_PATH) == WORK


def fresh_db():
    for suf in ("-wal", "-shm"):
        p = Path(str(WORK) + suf)
        if p.exists():
            p.unlink()
    shutil.copyfile(BASE, WORK)


def db():
    c = sqlite3.connect(WORK)
    c.row_factory = sqlite3.Row
    return c


def user_row(where="role = 'admin'", args=()):
    c = db()
    try:
        return c.execute(f"SELECT * FROM users WHERE {where} ORDER BY id LIMIT 1", args).fetchone()
    finally:
        c.close()


def call(fn, *a, **kw):
    """('ok', ответ) | (код HTTP, текст) | ('exc', тип: текст)."""
    try:
        return ("ok", fn(*a, **kw))
    except HTTPException as e:
        return (e.status_code, e.detail if isinstance(e.detail, (dict, list)) else str(e.detail)[:160])
    except Exception as e:  # noqa: BLE001
        return ("exc", f"{type(e).__name__}: {str(e)[:120]}")


def race(jobs):
    out = [None] * len(jobs)
    bar = threading.Barrier(len(jobs))

    def run(i, job):
        bar.wait()
        out[i] = call(*job)

    ts = [threading.Thread(target=run, args=(i, j)) for i, j in enumerate(jobs)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return out


# ---------------------------------------------------------------- данные
def find_position(c, need_free, obj=1, skip=0):
    """Позиция контракта объекта, у которой есть >= need_free запланированных изделий без контракта той же (тип, марка)."""
    rows = c.execute(
        "SELECT cl.contract_id, cl.element_type, cl.mark, co.specification_id FROM contract_lines cl "
        "JOIN contracts co ON co.id = cl.contract_id JOIN specifications s ON s.id = co.specification_id "
        "JOIN agreements a ON a.id = s.agreement_id WHERE a.object_id = ? AND co.is_archived = 0 AND cl.mark IS NOT NULL", (obj,)).fetchall()
    for r in rows:
        ids = [x["id"] for x in c.execute(
            "SELECT id FROM elements WHERE object_id = ? AND element_type = ? AND mark = ? AND contract_id IS NULL "
            "AND current_status = 'planned' ORDER BY id LIMIT ?", (obj, r["element_type"], r["mark"], need_free + 4))]
        if len(ids) >= need_free:
            if skip:
                skip -= 1
                continue
            return dict(r), ids
    raise SystemExit("в копии не нашлось подходящей позиции")


def linked_n(c, cid, etype, mark):
    return c.execute("SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND element_type = ? AND mark = ? AND current_status != 'planned'",
                     (cid, etype, mark)).fetchone()["n"]


def bought(c, cid, etype, mark):
    return c.execute("SELECT COALESCE(SUM(quantity), 0) n FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?",
                     (cid, etype, mark)).fetchone()["n"]


def make_room(c, pos, remaining):
    fact = linked_n(c, pos["contract_id"], pos["element_type"], pos["mark"])
    c.execute("UPDATE contract_lines SET quantity = ? WHERE contract_id = ? AND element_type = ? AND mark = ?",
              (fact + remaining, pos["contract_id"], pos["element_type"], pos["mark"]))
    c.commit()


def set_status(c, ids, status):
    """Подготовка: изделия без контракта в заданном статусе (с записью истории)."""
    for e in ids:
        c.execute("UPDATE elements SET current_status = ? WHERE id = ?", (status, e))
        c.execute("INSERT INTO status_history (element_id, status, changed_by) VALUES (?, ?, 'тест')", (e, status))
    c.commit()


TABLES = ("elements", "status_history", "contract_lines", "contracts", "contract_incidents", "supplier_change_docs", "supplier_change_items")


def checksum(tables=TABLES):
    """Отпечаток таблиц, где могут остаться частичные изменения (только чтение)."""
    c = db()
    h = hashlib.sha256()
    for t in tables:
        h.update(t.encode())
        for r in c.execute(f"SELECT * FROM {t} ORDER BY 1"):
            h.update(repr(tuple(r)).encode())
    c.close()
    return h.hexdigest()[:16]


# ---------------------------------------------------------------- соединения
TRACKED = []


def track_connections(*modules):
    """Запоминает каждое соединение, открытое обработчиками (ссылки держим, чтобы освобождение не зависело от сборщика мусора)."""
    orig = appdb.get_connection

    def tracking():
        c = orig()
        TRACKED.append(c)
        return c

    for m in modules:
        if hasattr(m, "get_connection"):
            m.get_connection = tracking


def released():
    """Все ли соединения обработчиков закрыты / без открытой транзакции. Возвращает список проблем."""
    bad = []
    for i, c in enumerate(TRACKED):
        try:
            if c.in_transaction:
                bad.append(f"соединение #{i} осталось с ОТКРЫТОЙ транзакцией")
        except sqlite3.ProgrammingError:
            pass   # закрыто
    return bad


def other_writer_ok():
    """Может ли ДРУГОЙ писатель сразу начать пишущую транзакцию (ожидание 0,3 с)."""
    w = sqlite3.connect(WORK, timeout=0.3, isolation_level=None)
    try:
        w.execute("BEGIN IMMEDIATE")
        w.execute("ROLLBACK")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        w.close()

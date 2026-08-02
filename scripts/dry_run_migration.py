"""Холостой прогон миграции на копии боевой базы.

Запускать ПЕРЕД деплоем, который несёт изменения схемы: показывает, что
именно init_db() сделает с реальными данными сервера, до того как это
случится на сервере.

Работает на КОПИИ КОПИИ: переданный файл не изменяется ни при каких
условиях — иначе единственный снимок сервера был бы испорчен той самой
миграцией, которую мы проверяем.

  python3 scripts/dry_run_migration.py /путь/к/снимку.db

Зависимостей нет — только стандартная библиотека (app/db.py её и не
выходит за пределы). Поэтому скрипт можно запускать прямо на сервере
системным python3, не поднимая контейнер и не трогая рабочую базу: это
и есть основной способ проверить миграцию ДО того, как пайплайн её
применит.
"""

import os
import shutil
import sqlite3
import sys
import time

# Корень репозитория — от расположения самого скрипта, а не жёстким
# путём: скрипт запускают и на Mac разработчика, и на сервере, где
# чекаут лежит совсем в другом месте.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Таблицы, чьи счётчики сверяются до и после. Порядок — от самого
# ценного к служебному: если что-то пропадёт, это должно броситься в
# глаза первой строкой, а не потеряться в середине списка.
COUNTED = [
    "elements", "status_history", "zones", "zone_levels", "axis_lines",
    "objects", "projects", "object_drawings", "users", "user_access",
    "contracts", "contract_lines", "counterparties", "agreements",
    "specifications", "label_visibility", "zone_colors", "report_notes",
    "default_contracts", "app_settings", "activity_log",
]

OBJECT_SCOPED = ["label_visibility", "zone_colors", "report_notes",
                 "default_contracts", "app_settings"]


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def tables(conn):
    return {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}


def counts(conn):
    present = tables(conn)
    out = {}
    for t in COUNTED:
        out[t] = conn.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"] if t in present else None
    return out


def columns(conn, table):
    if table not in tables(conn):
        return None
    return [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]


def markers(conn):
    if "app_settings" not in tables(conn):
        return {}
    cols = columns(conn, "app_settings")
    q = "SELECT key, value FROM app_settings WHERE key LIKE '%purged%' OR key LIKE '%seeded%'"
    return {r["key"]: r["value"] for r in conn.execute(q)}


def orphan_history(conn):
    """Записи истории, чей элемент не существует. Каскад ON DELETE обязан
    их убирать; ненулевое значение здесь однажды уже означало, что миграция
    отработала с выключенными внешними ключами."""
    if "status_history" not in tables(conn):
        return 0
    return conn.execute(
        "SELECT COUNT(*) AS n FROM status_history sh "
        "LEFT JOIN elements e ON e.id = sh.element_id WHERE e.id IS NULL"
    ).fetchone()["n"]


def статусы(conn):
    if "elements" not in tables(conn):
        return {}
    return {r["current_status"]: r["n"] for r in conn.execute(
        "SELECT current_status, COUNT(*) AS n FROM elements GROUP BY current_status")}


def snapshot(conn):
    return {
        "counts": counts(conn),
        "markers": markers(conn),
        "orphans": orphan_history(conn),
        "statuses": статусы(conn),
        "columns": {t: columns(conn, t) for t in OBJECT_SCOPED},
        "integrity": conn.execute("PRAGMA integrity_check").fetchone()[0],
        "fk": len(conn.execute("PRAGMA foreign_key_check").fetchall()),
    }


def главное(src):
    if not os.path.isfile(src):
        sys.exit(f"[ОШИБКА] Нет файла: {src}")

    # Рабочая копия — рядом со снимком, а не рядом со скриптом: у чекаута
    # на сервере может не быть прав на запись, а место под снимок заведомо
    # есть, раз он там лежит.
    work = os.path.join(os.path.dirname(os.path.abspath(src)), "dry_run_work.db")
    shutil.copyfile(src, work)
    print(f"Снимок сервера : {src}")
    print(f"Рабочая копия  : {work}  (исходный файл не изменяется)\n")

    before = snapshot(connect(work))

    print("=" * 78)
    print("ДО МИГРАЦИИ")
    print("=" * 78)
    print(f"  целостность файла : {before['integrity']}")
    print(f"  нарушений внешних ключей : {before['fk']}")
    print(f"  осиротевших записей истории : {before['orphans']}")
    print(f"  маркеры одноразовых миграций : {before['markers'] or 'нет — этапы A–C ещё НЕ применялись'}")
    print("  форма объектных таблиц:")
    for t in OBJECT_SCOPED:
        cols = before["columns"][t]
        есть = cols and "object_id" in cols
        print(f"    {t:20} {'object_id уже есть' if есть else 'БЕЗ object_id — миграция D применится'}")
    print("  статусы элементов:", before["statuses"])

    sys.path.insert(0, REPO)
    os.environ["ZHBI_DB_PATH"] = work
    from app.db import init_db

    print("\n" + "=" * 78)
    print("ПРОГОН init_db() — ровно то, что сделает сервер при старте")
    print("=" * 78)
    t0 = time.time()
    changes = init_db()
    длительность = time.time() - t0
    if changes:
        for c in changes:
            print(f"  • {c}")
    else:
        print("  (изменений схемы нет — база уже актуальна)")
    print(f"\n  время: {длительность:.1f} с")

    print("\n  повторный прогон (должен быть пустым — миграции идемпотентны):")
    повтор = init_db()
    print(f"    {повтор if повтор else 'пусто, всё верно'}")

    after = snapshot(connect(work))

    print("\n" + "=" * 78)
    print("ПОСЛЕ МИГРАЦИИ")
    print("=" * 78)
    print(f"  целостность файла : {after['integrity']}")
    print(f"  нарушений внешних ключей : {after['fk']}")
    print(f"  осиротевших записей истории : {after['orphans']}")
    print(f"  маркеры : {after['markers']}")

    print("\n  строки по таблицам (было -> стало):")
    тревога = []
    for t in COUNTED:
        b, a = before["counts"][t], after["counts"][t]
        if b == a:
            continue
        знак = "" if b is None else f"{a - b:+d}"
        строка = f"    {t:20} {b} -> {a}  {знак}"
        print(строка)
        if b is not None and a is not None and a < b:
            тревога.append((t, b, a))
    if all(before["counts"][t] == after["counts"][t] for t in COUNTED):
        print("    (ни одна таблица не изменилась в размере)")

    print("\n  статусы элементов после:", after["statuses"])
    if before["statuses"] != after["statuses"]:
        print("    ВНИМАНИЕ: распределение статусов изменилось")

    print("\n  объектные таблицы после — по объектам:")
    conn = connect(work)
    объекты = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM objects ORDER BY id")}
    for oid, имя in объекты.items():
        части = []
        for t in OBJECT_SCOPED:
            n = conn.execute(f"SELECT COUNT(*) AS n FROM {t} WHERE object_id = ?", (oid,)).fetchone()["n"]
            части.append(f"{t}={n}")
        print(f"    #{oid} {имя}: " + ", ".join(части))
    системные = conn.execute(
        "SELECT COUNT(*) AS n FROM app_settings WHERE object_id IS NULL").fetchone()["n"]
    print(f"    системных настроек (object_id IS NULL, маркеры миграций): {системные}")

    print("\n" + "=" * 78)
    print("ИТОГ")
    print("=" * 78)
    проблемы = []
    if after["integrity"] != "ok":
        проблемы.append(f"целостность файла: {after['integrity']}")
    if after["fk"]:
        проблемы.append(f"нарушений внешних ключей: {after['fk']}")
    if after["orphans"] > before["orphans"]:
        проблемы.append(f"осиротевших записей истории стало больше: {before['orphans']} -> {after['orphans']}")
    if повтор:
        проблемы.append("повторный прогон не пуст — миграция не идемпотентна")
    for t, b, a in тревога:
        проблемы.append(f"строк в {t} стало МЕНЬШЕ: {b} -> {a}")

    if проблемы:
        print("  ТРЕБУЕТ РАЗБОРА ДО ДЕПЛОЯ:")
        for p in проблемы:
            print(f"    ✗ {p}")
        print("\n  (уменьшение elements/zones/axis_lines ожидаемо, если сработала")
        print("   одноразовая чистка дообъектного наследия — сверьте со списком")
        print("   изменений выше)")
    else:
        print("  ✓ расхождений не обнаружено: данные на месте, ключи целы,")
        print("    повторный прогон пуст")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    главное(sys.argv[1])

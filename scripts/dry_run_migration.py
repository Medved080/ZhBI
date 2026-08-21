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
    "specifications", "marks", "allowed_subtypes", "label_visibility", "zone_colors",
    "report_notes", "default_contracts", "app_settings", "activity_log",
]

# Раскладка по объектам печатается отдельно: у этих таблиц ошибка миграции
# выглядит не как «строк стало меньше», а как «строки уехали не в тот
# объект», и общий счётчик её не поймает. allowed_subtypes здесь с
# 2026-08-21 — её раскладка считается ПО ФАКТУ УПОТРЕБЛЕНИЯ подтипов в
# elements, то есть зависит от ЗНАЧЕНИЙ, и на боевых данных может выйти
# иначе, чем на копии.
OBJECT_SCOPED = ["allowed_subtypes", "label_visibility", "zone_colors", "report_notes",
                 "default_contracts", "app_settings"]


def copy_db(src, dst):
    """Снять копию базы штатным механизмом SQLite, а не `shutil.copyfile`.

    С 2026-08-14 база работает в режиме WAL, и свежие страницы живут в
    отдельном файле `-wal` до контрольной точки. Обычное копирование одного
    файла взяло бы данные БЕЗ последних транзакций — на живом сервере это
    ровно те правки, ради проверки которых прогон и запускается. Метод
    `Connection.backup()` копирует согласованный снимок целиком, включая
    незачекпойнченное, и не мешает работающему серверу (так же копируют
    резервные копии, app/backups.py).
    """
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        # Убирается не только сам файл, но и его СПУТНИКИ `-wal`/`-shm`
        # (2026-08-19). Оставшийся от прошлого прогона журнал не подходит к
        # новой копии, и SQLite отвечает на это «unable to open database
        # file» — сообщением, по которому думаешь на права доступа и на
        # исходный снимок, а не на мусор рядом. Ловится ровно тогда, когда
        # прогон нужен: после прерванной проверки перед деплоем.
        for хвост in ("", "-wal", "-shm"):
            if os.path.exists(dst + хвост):
                os.remove(dst + хвост)
        dst_conn = sqlite3.connect(dst)
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


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


def прогон_обработок(work):
    """Обработки релиза (`app/release_tasks.py`) — второй, после миграций
    схемы, шаг первого старта новой версии. Раньше холостой прогон их не
    трогал, то есть проверял ровно половину того, что сервер сделает с
    данными: миграция добавляла колонку, а заполняла её обработка, и увидеть
    заранее, ЧТО она заполнит на реальных данных, было негде.

    Прогоняется ДВАЖДЫ. Первый раз — как на сервере: только те, у которых ещё
    нет успешной записи. Второй — ВСЕ обработки данных принудительно
    (`run_by_name`), чтобы проверить их идемпотентность на реальных данных:
    администратор может повторить упавшую кнопкой, и повтор обязан быть
    безвредным. Сравниваются счётчики строк до и после повтора — расхождение
    и означает, что обработка не идемпотентна.

    Уборка (KIND_CLEANUP) не запускается ни разу: при старте она не
    выполняется и здесь тоже не должна — она ждёт решения человека.
    """
    from app.release_tasks import (
        KIND_CLEANUP, RELEASE_TASKS, code_version, data_task_names, db_version,
        run_by_name, run_pending,
    )

    print("\n" + "=" * 78)
    print("ОБРАБОТКИ РЕЛИЗА — что сервер сделает с ДАННЫМИ при первом старте")
    print("=" * 78)
    conn = connect(work)
    print(f"  версия кода : {code_version()}")
    print(f"  версия базы до обработок : {db_version(conn) or 'не проставлена'}")
    conn.close()

    результаты = run_pending()
    if результаты:
        for r in результаты:
            метка = "✓" if r["status"] == "ok" else "✗"
            print(f"  {метка} {r['name']}: {r['note']}  ({r['duration_ms']} мс)")
    else:
        print("  (незавершённых обработок нет — все уже выполнены на этой базе)")

    до_повтора = counts(connect(work))
    print("\n  повторный прогон всех обработок данных (проверка идемпотентности):")
    повторы = []
    for name in data_task_names():
        r = run_by_name(name)
        повторы.append(r)
        метка = "✓" if r["status"] == "ok" else "✗"
        print(f"    {метка} {name}: {r['note']}")
    после_повтора = counts(connect(work))
    расхождения = [(t, до_повтора[t], после_повтора[t])
                   for t in COUNTED if до_повтора[t] != после_повтора[t]]
    if расхождения:
        for t, b, a in расхождения:
            print(f"    ВНИМАНИЕ: повтор изменил {t}: {b} -> {a}")
    else:
        print("    строки не изменились — обработки идемпотентны")

    conn = connect(work)
    print(f"\n  версия базы после обработок : {db_version(conn) or 'не проставлена'}"
          f" (должна совпасть с версией кода)")
    conn.close()

    уборка = [t["title"] for t in RELEASE_TASKS if t.get("kind") == KIND_CLEANUP]
    if уборка:
        print("  уборка (при старте НЕ выполняется, ждёт кнопки администратора):")
        for t in уборка:
            print(f"    • {t}")

    return {
        "первый": результаты,
        "повторы": повторы,
        "расхождения": расхождения,
        "версия_совпала": (lambda c: db_version(c) == code_version())(connect(work)),
    }


def главное(src):
    if not os.path.isfile(src):
        sys.exit(f"[ОШИБКА] Нет файла: {src}")

    # Рабочая копия — рядом со снимком, а не рядом со скриптом: у чекаута
    # на сервере может не быть прав на запись, а место под снимок заведомо
    # есть, раз он там лежит.
    work = os.path.join(os.path.dirname(os.path.abspath(src)), "dry_run_work.db")
    copy_db(src, work)
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

    обработки = прогон_обработок(work)

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
    # Обработки релиза — вторая половина того, что делает первый старт.
    for r in обработки["первый"] + обработки["повторы"]:
        if r["status"] != "ok":
            проблемы.append(f"обработка «{r['name']}» упала: {r['note']}")
    for t, b, a in обработки["расхождения"]:
        проблемы.append(f"повтор обработок изменил {t}: {b} -> {a} — обработка не идемпотентна")
    if not обработки["версия_совпала"]:
        проблемы.append("версия базы не догнала версию кода — часть обработок не завершилась")

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

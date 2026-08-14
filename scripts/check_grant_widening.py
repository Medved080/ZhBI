# -*- coding: utf-8 -*-
"""Гранты, у которых объём прав ВЫРОС при переходе на сложение ролей.

Зачем. До 2026-08-14 частный грант ПЕРЕКРЫВАЛ общий: «полные права на все
проекты» плюс «просмотр на объекте №5» означало на пятом объекте просмотр —
так человека понижали точечно. С переходом на независимые роли гранты всех
трёх уровней СКЛАДЫВАЮТСЯ (решение пользователя), и то же сочетание даёт на
пятом объекте полные права.

Менять чужие доступы молча нельзя, поэтому миграция их не трогает — этот
скрипт показывает, где расхождение есть, чтобы решение принял человек.
Способ понижать права теперь другой: не выдавать общий грант вовсе, а
раздавать роли по объектам.

Только ЧТЕНИЕ. Запуск:
    .venv/bin/python scripts/check_grant_widening.py [путь-к-базе]
"""

import os
import sqlite3
import sys

ПУТЬ = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZHBI_DB_PATH", "data/zhbi.db")

conn = sqlite3.connect(f"file:{ПУТЬ}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Кто как назывался — для читаемого вывода.
роли = {r["key"]: r["name"] for r in conn.execute("SELECT key, name FROM object_roles")}
люди = {r["id"]: (f"{r['last_name'] or ''} {r['first_name'] or ''}".strip()
                  or r["domain_login"])
        for r in conn.execute("SELECT id, last_name, first_name, domain_login FROM users")}
объекты = {r["id"]: (r["name"], r["project_id"])
           for r in conn.execute("SELECT id, name, project_id FROM objects")}

# Все гранты по пользователям.
гранты = {}
for r in conn.execute("SELECT user_id, project_id, object_id, role FROM user_access"):
    гранты.setdefault(r["user_id"], []).append(dict(r))

находки = []
for uid, свои in гранты.items():
    общие = {г["role"] for г in свои if г["project_id"] is None and г["object_id"] is None}
    по_проектам = {}
    по_объектам = {}
    for г in свои:
        if г["object_id"] is not None:
            по_объектам.setdefault(г["object_id"], set()).add(г["role"])
        elif г["project_id"] is not None:
            по_проектам.setdefault(г["project_id"], set()).add(г["role"])

    for oid, роли_объекта in по_объектам.items():
        имя, pid = объекты.get(oid, (f"#{oid}", None))
        перекрытые = общие | по_проектам.get(pid, set())
        # Раньше действовал ТОЛЬКО объектный набор; теперь к нему прибавятся
        # роли верхних уровней. Если там есть что-то, чего нет на объекте, —
        # объём прав вырос.
        новые = перекрытые - роли_объекта
        if новые:
            находки.append({
                "user": люди.get(uid, f"#{uid}"),
                "object": имя,
                "было": sorted(роли.get(р, р) for р in роли_объекта),
                "добавится": sorted(роли.get(р, р) for р in новые),
            })

    # То же на уровне проекта: проектный грант перекрывался общим.
    for pid, роли_проекта in по_проектам.items():
        новые = общие - роли_проекта
        if новые:
            находки.append({
                "user": люди.get(uid, f"#{uid}"),
                "object": f"весь проект #{pid}",
                "было": sorted(роли.get(р, р) for р in роли_проекта),
                "добавится": sorted(роли.get(р, р) for р in новые),
            })

print(f"База: {ПУТЬ}")
print(f"Пользователей с грантами: {len(гранты)}")
if not находки:
    print("\nРасхождений нет: ни у кого частный грант не перекрывал общий, "
          "объём прав ни у кого не вырастет.")
else:
    print(f"\nГде объём прав ВЫРАСТЕТ — {len(находки)}:\n")
    print(f"{'пользователь':28} {'объект':28} {'было':34} добавится")
    for н in находки:
        print(f"{н['user'][:27]:28} {н['object'][:27]:28} "
              f"{', '.join(н['было'])[:33]:34} {', '.join(н['добавится'])}")
    print("\nЧто с этим делать: снять лишний общий грант («все проекты») и раздать "
          "роли по объектам — понижать точечно сложением больше нельзя.")
conn.close()

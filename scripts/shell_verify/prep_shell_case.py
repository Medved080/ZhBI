"""Подготовка ВРЕМЕННОЙ копии БД для проверки оболочки V2 (задача «shell», Docs/v2-progress/shell.md).

Строит сценарий из раздела 5 задания: ≥300 объектов (в основном разных проектов), из которых ровно 3 — с
данными; одинаковые названия объектов в РАЗНЫХ проектах; длинные названия; архивные объект и проект. Источник —
обезличенная копия `data/zhbi.anon.db` (читать можно, реальных реквизитов там нет — CLAUDE.md); правки — ТОЛЬКО
во временной копии, переданной вторым аргументом.

Запуск: .venv/bin/python scripts/shell_verify/prep_shell_case.py <источник.db> <копия.db>
"""
import random
import shutil
import sqlite3
import sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(src, dst)

conn = sqlite3.connect(str(dst))
conn.execute("PRAGMA foreign_keys=OFF")

# ---- ровно 3 объекта "с данными": объекты 1,2 (элементы ЖБИ) уже есть в анонимной копии; объект 3 (kind=mfr,
# revit_elements) тоже оставляем; объект 4 (тоже mfr с данными) — ОБНУЛЯЕМ, иначе с данными окажется четыре.
before = conn.execute(
    "SELECT (SELECT COUNT(DISTINCT object_id) FROM elements) + "
    "(SELECT COUNT(DISTINCT object_id) FROM revit_elements)"
).fetchone()[0]
conn.execute("DELETE FROM revit_elements WHERE object_id = 4")
after = conn.execute(
    "SELECT (SELECT COUNT(DISTINCT object_id) FROM elements) + "
    "(SELECT COUNT(DISTINCT object_id) FROM revit_elements)"
).fetchone()[0]
print(f"объектов с данными: было {before}, стало {after} (ожидание — 3)")
assert after == 3, "сценарий требует РОВНО 3 объекта с данными"

# ---- ≥300 объектов: досыпаем синтетические пустые проекты/объекты поверх уже существующих (195 объектов
# в анонимной копии на момент подготовки задачи). Имена — заведомо синтетические (не путать с анонимными, но
# настоящими исходными данными заказчика в остальной части копии).
rnd = random.Random(20260922)
TOWNS = ["Северный", "Заречный", "Южный", "Приморский", "Лесной", "Полевой", "Береговой", "Нагорный"]
KINDS = ["ЖК", "МФК", "Корпус", "Секция", "Квартал"]

next_project_id = conn.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM projects").fetchone()[0]
next_object_id = conn.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM objects").fetchone()[0]
pid, oid = next_project_id, next_object_id
new_objects_total = 0

def add_project(name, status="active", address=None):
    global pid
    this = pid
    conn.execute(
        "INSERT INTO projects (id, name, address, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        (this, name, address, status),
    )
    pid += 1
    return this

def add_object(project_id, name, status="active"):
    global oid, new_objects_total
    this = oid
    conn.execute(
        "INSERT INTO objects (id, name, project_id, status, kind, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 'zhbi', datetime('now'), datetime('now'))",
        (this, name, project_id, status),
    )
    oid += 1
    new_objects_total += 1
    return this

# 60 проектов по 1-3 объекта — типичная форма дерева (большинство "без модели", один объект в проекте — самый частый случай).
#
# ВАЖНО (найдено при подготовке этого сценария, а не додумано): и `projects.name`, и `objects.name` в схеме
# ОБЪЯВЛЕНЫ UNIQUE (см. CREATE TABLE — не индекс приложения, а ограничение самой БД). Поэтому буквально
# «одинаковое название объекта в РАЗНЫХ проектах», как просит п.5 задания, в этой системе СОЗДАТЬ НЕЛЬЗЯ —
# это не пробел проверки, а инвариант БД (схему трогать нельзя — правило BRIEF). Ближайший реальный аналог —
# объекты с ОДИНАКОВЫМ НАЧАЛОМ названия ("Корпус 1" в четырёх разных проектах, различающихся только номером
# проекта в скобках) — ниже он выдержан: имена различаются, но визуально почти неотличимы без подписи проекта,
# ЧТО И ЕСТЬ настоящая проверка «выбор должен вести по id, а не по (похожему) тексту». Подробности — в отчёте
# (Docs/v2-progress/shell.md, «Отклонения от сценария проверки»).
for i in range(80):
    proj = add_project(f"{rnd.choice(KINDS)} «Тест-{i+1:03d}» {rnd.choice(TOWNS)}", address=f"г. Тестовград, ул. Пробная, д. {i+1}")
    n_obj = rnd.choice([1, 1, 1, 2, 2, 3])
    for j in range(n_obj):
        add_object(proj, f"Корпус {j+1} (проект {i+1})" if n_obj > 1 else f"Объект-Т{i+1:03d}")

# Почти неразличимые названия объектов в РАЗНЫХ проектах (см. пояснение выше про UNIQUE) — визуально это
# "Корпус 1" везде, отличается только скобка с номером проекта, который в свёрнутом списке не всегда на виду.
for i in range(4):
    proj = add_project(f"Проект-двойник {i+1}")
    add_object(proj, f"Корпус 1 (двойник {i+1})")

# Длинные названия — проверка обрезания текста в колонках с сохранением полного title/tooltip.
long_proj = add_project("ЖК «Очень длинное название жилого комплекса для проверки обрезания текста в списке выбора объекта, часть первая»")
add_object(long_proj, "Объект с очень длинным названием, которое не должно ломать колонку количества элементов и обязано показываться полностью во всплывающей подсказке")

# Архивные объект и проект — проверка правила видимости V1 (показывать по чекбоксу «Показывать архивные»).
arch_proj_active = add_project("Проект с архивным объектом внутри")
add_object(arch_proj_active, "Архивный объект", status="archived")
arch_proj = add_project("Архивный проект целиком", status="archived")
add_object(arch_proj, "Объект архивного проекта")

conn.commit()
total_objects = conn.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
print(f"добавлено объектов: {new_objects_total}; всего объектов в копии: {total_objects} (ожидание — ≥300)")
assert total_objects >= 300
conn.close()
print(f"готово: {dst}")

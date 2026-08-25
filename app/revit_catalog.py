"""
Справочники объекта из выгрузок Revit: секции и этажи.

Двухфазно, как импорт чертежа (решение И3): `analyze` считает, что
изменится, и ничего не пишет; `apply` применяет уже посчитанное. Между
фазами пользователь видит сводку — потому что на справочники ссылаются
элементы, и молча заведённая третья «секция» с именем «Автостоянка»
обнаруживается потом только живым отчётом.

Ключевое решение — как сшиваются РАЗНЫЕ разделы одного объекта.

  Секция сводится к канонической форме `С01`: КР пишет `С01`, АР —
  `Секция 1`, попадается `С1`. Сведение делает
  `app/revit_package.normalize_section`.

  Этаж сшивается по НОМЕРУ, а не по имени и не по отметке. Один и тот же
  8-й этаж в КР назван `С01-02_8_этаж_основной_+22.950` и стоит на
  180630 мм, в АР — `С01-02_8_этаж` на 178660 мм: разные схемы именования
  и разные отметки (верх плиты против чистого пола, расхождение 1970 мм).
  Имя раздела хранится отдельно, в `object_level_aliases` — по нему
  элемент своего раздела находит общий этаж объекта.
"""

import json

from app.revit_package import KIND_ROOF, Package, normalize_section

# Кровля идёт после всех этажей: номера у неё нет, а сортировать надо.
_ROOF_ORDER_BASE = 9000


def _level_sort_order(level, roof_index: int) -> int:
    if level.floor is not None:
        return level.floor
    return _ROOF_ORDER_BASE + roof_index


def collect(packages) -> tuple:
    """Что вообще есть в пакетах: секции и этажи.

    Секции берутся из ДВУХ источников — параметра элемента и имени уровня.
    Второй нужен потому, что `MCY_Секция` заполнен не везде: в АР пусто у
    17% элементов, а имя уровня секцию часто называет.
    """
    sections = {}
    levels = {}

    for package in packages:
        for element in package.elements:
            code = normalize_section(element.get("секция"))
            if code:
                sections[code] = sections.get(code, 0) + 1

        for level in package.levels:
            if not level.parsed:
                continue
            for code in level.sections:
                sections.setdefault(code, 0)
            entry = levels.setdefault(level.key, {
                "key": level.key,
                "floor": level.floor,
                "kind": level.kind,
                "name": level.name,
                "elevation_mm": level.elevation_mm,
                "elevation_source": package.section_code,
                "suspect": False,
                "aliases": {},
            })
            # Имя и отметка объекта берутся из ПЕРВОГО раздела, который
            # этот этаж принёс, и дальше не переписываются: иначе значение
            # прыгало бы от порядка загрузки разделов.
            entry["aliases"][(package.section_code, level.name)] = level.elevation_mm

    # Разброс отметок одного этажа между алиасами означает, что отметке
    # верить нельзя (см. комментарий в schema.sql к elevation_suspect).
    for entry in levels.values():
        values = [v for v in entry["aliases"].values() if v is not None]
        if len(values) > 1 and max(values) - min(values) > 1.0:
            entry["suspect"] = True

    return sections, levels


def _existing(conn, object_id: int) -> tuple:
    sections = {
        row["code"]: row["id"]
        for row in conn.execute(
            "SELECT id, code FROM object_sections WHERE object_id = ?", (object_id,))
    }
    levels = {
        row["key"]: dict(row)
        for row in conn.execute(
            "SELECT id, key, floor, kind, name, elevation_mm FROM object_levels "
            "WHERE object_id = ?", (object_id,))
    }
    aliases = {
        (row["section_code"], row["level_name"]): row["level_id"]
        for row in conn.execute(
            "SELECT section_code, level_name, level_id FROM object_level_aliases "
            "WHERE object_id = ?", (object_id,))
    }
    return sections, levels, aliases


def analyze(conn, object_id: int, packages) -> dict:
    """Фаза 1: что появится в справочниках. Ничего не пишет."""
    found_sections, found_levels = collect(packages)
    have_sections, have_levels, have_aliases = _existing(conn, object_id)

    new_sections = sorted(code for code in found_sections if code not in have_sections)
    new_levels = sorted(
        (key for key in found_levels if key not in have_levels),
        key=lambda k: found_levels[k]["floor"]
        if found_levels[k]["floor"] is not None else _ROOF_ORDER_BASE,
    )

    new_aliases = []
    for entry in found_levels.values():
        for (section_code, name) in entry["aliases"]:
            if (section_code, name) not in have_aliases:
                new_aliases.append({"раздел": section_code, "имя": name,
                                    "этаж": entry["key"]})

    # Расхождение отметок одного этажа между разделами — НЕ ошибка (верх
    # плиты против чистого пола), но пользователь должен его видеть: это
    # единственный признак того, что разделы моделируют этаж по-разному.
    elevation_gaps = []
    for entry in found_levels.values():
        values = [v for v in entry["aliases"].values() if v is not None]
        if len(values) > 1 and max(values) - min(values) > 1.0:
            elevation_gaps.append({
                "этаж": entry["key"],
                "разброс_мм": round(max(values) - min(values), 1),
                "разделы": sorted({s for s, _ in entry["aliases"]}),
            })

    warnings = []
    for package in packages:
        for text in package.warnings:
            warnings.append("%s: %s" % (package.section_code, text))

    return {
        "object_id": object_id,
        "packages": [
            {"раздел": p.section_code, "модель": p.model, "дата": p.exported_at,
             "элементов": len(p.elements), "помещений": len(p.rooms),
             "уровней": len(p.levels), "осей": len(p.grids)}
            for p in packages
        ],
        "sections": {
            "new": new_sections,
            "existing": sorted(code for code in found_sections if code in have_sections),
            "counts": found_sections,
        },
        "levels": {
            "new": [found_levels[k] for k in new_levels],
            "existing": sorted(k for k in found_levels if k in have_levels),
            "new_aliases": new_aliases,
            "elevation_gaps": elevation_gaps,
        },
        "warnings": warnings,
        "_found": (found_sections, found_levels),
    }


def apply(conn, object_id: int, packages, analysis: dict) -> dict:
    """Фаза 2: применяет посчитанное. Справочники только ДОПОЛНЯЮТСЯ —
    удаление секции или этажа не делается никогда: на них ссылаются
    элементы и статусы работ, а исчезновение этажа из одной выгрузки не
    означает, что его нет в объекте."""
    found_sections, found_levels = analysis["_found"]
    have_sections, have_levels, have_aliases = _existing(conn, object_id)

    added_sections = 0
    for code in sorted(found_sections):
        if code in have_sections:
            continue
        cur = conn.execute(
            "INSERT INTO object_sections (object_id, code, name, sort_order) "
            "VALUES (?, ?, ?, ?)",
            (object_id, code, code, int(code[1:]) if code[1:].isdigit() else 0),
        )
        have_sections[code] = cur.lastrowid
        added_sections += 1

    roof_index = 0
    added_levels = 0
    for key in sorted(found_levels,
                      key=lambda k: (found_levels[k]["floor"] is None,
                                     found_levels[k]["floor"] or 0, k)):
        entry = found_levels[key]
        if entry["kind"] == KIND_ROOF:
            roof_index += 1
        if key in have_levels:
            continue
        cur = conn.execute(
            "INSERT INTO object_levels (object_id, key, floor, kind, name, "
            "elevation_mm, elevation_source, elevation_suspect, sort_order) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (object_id, key, entry["floor"], entry["kind"], entry["name"],
             entry["elevation_mm"], entry["elevation_source"],
             1 if entry.get("suspect") else 0,
             _level_sort_order(_Entry(entry), roof_index)),
        )
        have_levels[key] = {"id": cur.lastrowid}
        added_levels += 1

    added_aliases = 0
    for entry in found_levels.values():
        level_id = have_levels[entry["key"]]["id"]
        for (section_code, name), elevation in entry["aliases"].items():
            if (section_code, name) in have_aliases:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO object_level_aliases "
                "(object_id, section_code, level_name, level_id, elevation_mm) "
                "VALUES (?,?,?,?,?)",
                (object_id, section_code, name, level_id, elevation),
            )
            have_aliases[(section_code, name)] = level_id
            added_aliases += 1

    for package in packages:
        # Актуальным остаётся один пакет на раздел: предыдущая выгрузка
        # того же раздела перестаёт быть текущей, но из реестра не
        # удаляется — история загрузок нужна для разбора «когда это
        # приехало».
        conn.execute(
            "UPDATE revit_packages SET is_current = 0 "
            "WHERE object_id = ? AND section_code = ?",
            (object_id, package.section_code),
        )
        conn.execute(
            "INSERT INTO revit_packages (object_id, section_code, model, "
            "exported_at, exporter, coordinates, base_point, elements_count, "
            "is_current) VALUES (?,?,?,?,?,?,?,?,1)",
            (object_id, package.section_code, package.model, package.exported_at,
             package.exporter, package.coordinates,
             json.dumps(package.base_point) if package.base_point else None,
             len(package.elements)),
        )

    conn.commit()
    return {
        "sections_added": added_sections,
        "levels_added": added_levels,
        "aliases_added": added_aliases,
        "packages": len(packages),
    }


class _Entry:
    """Мостик: _level_sort_order ждёт объект с полем floor, а в apply
    этажи лежат словарями."""

    def __init__(self, data):
        self.floor = data["floor"]


def level_index(conn, object_id: int) -> dict:
    """(раздел, имя уровня) -> id этажа объекта. То, ради чего заведены
    алиасы: элемент любого раздела находит общий этаж."""
    return {
        (row["section_code"], row["level_name"]): row["level_id"]
        for row in conn.execute(
            "SELECT section_code, level_name, level_id FROM object_level_aliases "
            "WHERE object_id = ?", (object_id,))
    }

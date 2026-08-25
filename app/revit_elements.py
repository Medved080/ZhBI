"""
Элементы и помещения из выгрузок Revit: сверка и запись.

Двухфазно, как всё остальное в загрузке: `analyze` считает, что изменится,
`apply` применяет. Между фазами пользователь видит сводку.

Идентичность — `Element.UniqueId`, устойчивый GUID: он переживает правки,
пересохранение и отсоединение от центральной модели. Это качественно
надёжнее, чем `dxf_handle` в старом конвейере, который дважды обнулялся
целиком, когда заказчик перерисовывал чертёж (`app/element_identity.py`).
Геометрическая сверка здесь поэтому НЕ нужна.

«Исчез из модели» считается СТРОГО внутри своего раздела: в комплекте
может приехать только АР, и списывать по нему элементы КР нельзя.

Порядок в `apply` важен: сначала справочники (`app/revit_catalog`), потом
элементы — иначе этаж и секция элемента не к чему привязать.
"""

import json

from app.revit_package import normalize_section, resolve_section

# Поля, расхождение которых показывается в сводке. Марка — отдельно и
# громко: у сборных изделий она привязана к позиции контракта.
TRACKED = ("mark", "category", "family", "type_name",
           "level_name", "elevation_mm", "height_mm")

DETAIL_LIMIT = 50

# Именованные параметры, для которых нет отдельной колонки. Складываются в
# params_json целиком — состав параметров у заказчика меняется, и заводить
# колонку под каждый значит править схему на каждую их правку.
_EXTRA_PARAMS = ("корпус", "тип_этажа", "часть_здания", "раздел_модели",
                 "марка_конструкции", "марка_изделия", "бетон_w", "бетон_f",
                 "id_1c", "этаж")


def build_row(element: dict, package, level, level_id, section_id) -> dict:
    """Единственное место, где элемент пакета превращается в строку БД."""
    section_code, section_source = resolve_section(element, level)
    point = element.get("точка") or [None, None, None]
    extra = {k: element.get(k) for k in _EXTRA_PARAMS if element.get(k) is not None}
    outline = element.get("контур")
    return {
        "section_code": package.section_code,
        "uid": element.get("uid"),
        "revit_id": element.get("id"),
        "category": element.get("категория"),
        "family": element.get("семейство"),
        "type_name": element.get("типоразмер"),
        "mark": element.get("марка"),
        "level_id": level_id,
        "level_name": element.get("уровень"),
        "section_id": section_id,
        "section_source": section_source if section_code else "не определена",
        "elevation_mm": element.get("отметка_низа"),
        "height_mm": element.get("высота"),
        "x": point[0] if len(point) > 0 else None,
        "y": point[1] if len(point) > 1 else None,
        "z": point[2] if len(point) > 2 else None,
        "outline_json": json.dumps(outline, ensure_ascii=False) if outline else None,
        "outline_approx": 1 if element.get("контур_приблизительный") else 0,
        "volume": element.get("объём"),
        "area": element.get("площадь"),
        "workset": element.get("рабочий_набор"),
        "params_json": json.dumps(extra, ensure_ascii=False) if extra else None,
        "_section_code_value": section_code,
    }


def build_room_row(room: dict, package, level_id, section_id) -> dict:
    return {
        "section_code": package.section_code,
        "uid": room.get("uid"),
        "number": room.get("номер"),
        "name": room.get("имя"),
        "area": room.get("площадь"),
        "level_id": level_id,
        "level_name": room.get("уровень"),
        "section_id": section_id,
        "flat": room.get("квартира"),
        "rooms_count": room.get("комнат"),
        "plan_type": room.get("тип_планировки"),
        "flat_area": room.get("площадь_квартиры"),
        "living_area": room.get("жилая_площадь"),
        "total_area": room.get("площадь_с_неотапливаемыми"),
        "room_category": room.get("категория_помещения"),
    }


def _levels_by_name(packages) -> dict:
    """(раздел, имя уровня) -> Level. Нужен и на фазе анализа, когда
    справочник этажей ещё не заведён."""
    out = {}
    for package in packages:
        for level in package.levels:
            out[(package.section_code, level.name)] = level
    return out


def analyze(conn, object_id: int, packages) -> dict:
    """Фаза 1: что изменится. В БД не пишет."""
    levels = _levels_by_name(packages)
    codes = [p.section_code for p in packages]

    existing = {}
    for row in conn.execute(
        "SELECT uid, section_code, mark, category, family, type_name, "
        "level_name, elevation_mm, height_mm FROM revit_elements "
        "WHERE object_id = ? AND is_current = 1", (object_id,)
    ):
        existing[row["uid"]] = dict(row)

    in_scope = {uid: row for uid, row in existing.items()
                if row["section_code"] in codes}

    new = updated = unchanged = 0
    changes = []
    seen = set()
    by_section = {}
    without_section = 0
    approx_outline = 0

    for package in packages:
        stats = by_section.setdefault(package.section_code,
                                      {"новых": 0, "изменённых": 0, "всего": 0})
        for element in package.elements:
            uid = element.get("uid")
            if not uid:
                continue
            seen.add(uid)
            stats["всего"] += 1
            level = levels.get((package.section_code, element.get("уровень")))
            row = build_row(element, package, level, None, None)
            if row["_section_code_value"] is None:
                without_section += 1
            if row["outline_approx"]:
                approx_outline += 1

            was = in_scope.get(uid)
            if was is None:
                new += 1
                stats["новых"] += 1
                continue
            diff = {}
            for field in TRACKED:
                if was.get(field) != row.get(field):
                    diff[field] = (was.get(field), row.get(field))
            if diff:
                updated += 1
                stats["изменённых"] += 1
                if len(changes) < DETAIL_LIMIT:
                    changes.append({"uid": uid, "тип": row["type_name"],
                                    "изменения": diff})
            else:
                unchanged += 1

    retired = [uid for uid in in_scope if uid not in seen]

    rooms_new = rooms_total = 0
    for package in packages:
        rooms_total += len(package.rooms)
    have_rooms = {
        row["uid"] for row in conn.execute(
            "SELECT uid FROM revit_rooms WHERE object_id = ? AND is_current = 1",
            (object_id,))
    }
    flats = set()
    for package in packages:
        for room in package.rooms:
            if room.get("uid") not in have_rooms:
                rooms_new += 1
            if room.get("квартира"):
                flats.add((room.get("секция"), room.get("уровень"),
                           room.get("квартира")))

    return {
        "counts": {
            "новых": new,
            "изменённых": updated,
            "без изменений": unchanged,
            "исчезло из модели": len(retired),
            "без секции": without_section,
            "контур габаритный": approx_outline,
            "помещений": rooms_total,
            "помещений новых": rooms_new,
            "квартир": len(flats),
        },
        "by_section": by_section,
        "changes": changes,
        "retired_uids": retired,
    }


_INSERT = (
    "INSERT INTO revit_elements (object_id, section_code, uid, revit_id, "
    "category, family, type_name, mark, level_id, level_name, section_id, "
    "section_source, elevation_mm, height_mm, x, y, z, outline_json, "
    "outline_approx, volume, area, workset, params_json, is_current) "
    "VALUES (:object_id, :section_code, :uid, :revit_id, :category, :family, "
    ":type_name, :mark, :level_id, :level_name, :section_id, :section_source, "
    ":elevation_mm, :height_mm, :x, :y, :z, :outline_json, :outline_approx, "
    ":volume, :area, :workset, :params_json, 1) "
    "ON CONFLICT (object_id, uid) DO UPDATE SET "
    "section_code=excluded.section_code, revit_id=excluded.revit_id, "
    "category=excluded.category, family=excluded.family, "
    "type_name=excluded.type_name, mark=excluded.mark, "
    "level_id=excluded.level_id, level_name=excluded.level_name, "
    "section_id=excluded.section_id, section_source=excluded.section_source, "
    "elevation_mm=excluded.elevation_mm, height_mm=excluded.height_mm, "
    "x=excluded.x, y=excluded.y, z=excluded.z, "
    "outline_json=excluded.outline_json, outline_approx=excluded.outline_approx, "
    "volume=excluded.volume, area=excluded.area, workset=excluded.workset, "
    "params_json=excluded.params_json, is_current=1, "
    "updated_at=datetime('now')"
)

_INSERT_ROOM = (
    "INSERT INTO revit_rooms (object_id, section_code, uid, number, name, area, "
    "level_id, level_name, section_id, flat, rooms_count, plan_type, flat_area, "
    "living_area, total_area, room_category, is_current) "
    "VALUES (:object_id, :section_code, :uid, :number, :name, :area, :level_id, "
    ":level_name, :section_id, :flat, :rooms_count, :plan_type, :flat_area, "
    ":living_area, :total_area, :room_category, 1) "
    "ON CONFLICT (object_id, uid) DO UPDATE SET "
    "section_code=excluded.section_code, number=excluded.number, "
    "name=excluded.name, area=excluded.area, level_id=excluded.level_id, "
    "level_name=excluded.level_name, section_id=excluded.section_id, "
    "flat=excluded.flat, rooms_count=excluded.rooms_count, "
    "plan_type=excluded.plan_type, flat_area=excluded.flat_area, "
    "living_area=excluded.living_area, total_area=excluded.total_area, "
    "room_category=excluded.room_category, is_current=1, "
    "updated_at=datetime('now')"
)


def apply(conn, object_id: int, packages, analysis: dict) -> dict:
    """Фаза 2. Требует уже применённых справочников: этаж и секция берутся
    из них по алиасам."""
    from app.revit_catalog import level_index

    levels = _levels_by_name(packages)
    level_ids = level_index(conn, object_id)
    section_ids = {
        row["code"]: row["id"] for row in conn.execute(
            "SELECT id, code FROM object_sections WHERE object_id = ?", (object_id,))
    }

    written = 0
    for package in packages:
        batch = []
        for element in package.elements:
            if not element.get("uid"):
                continue
            name = element.get("уровень")
            level = levels.get((package.section_code, name))
            row = build_row(element, package, level,
                            level_ids.get((package.section_code, name)), None)
            # Секция считается ОДИН раз, внутри build_row, и здесь только
            # переводится в id: на 28 тысячах элементов второй вызов
            # resolve_section — лишний проход по тем же данным.
            row["section_id"] = section_ids.get(row.pop("_section_code_value"))
            row["object_id"] = object_id
            batch.append(row)
        conn.executemany(_INSERT, batch)
        written += len(batch)

    rooms_written = 0
    for package in packages:
        batch = []
        for room in package.rooms:
            if not room.get("uid"):
                continue
            name = room.get("уровень")
            row = build_room_row(
                room, package,
                level_ids.get((package.section_code, name)),
                section_ids.get(normalize_section(room.get("секция"))),
            )
            row["object_id"] = object_id
            batch.append(row)
        conn.executemany(_INSERT_ROOM, batch)
        rooms_written += len(batch)

    retired = analysis.get("retired_uids") or []
    if retired:
        conn.executemany(
            "UPDATE revit_elements SET is_current = 0, updated_at = datetime('now') "
            "WHERE object_id = ? AND uid = ?",
            [(object_id, uid) for uid in retired],
        )

    flats = rebuild_flats(conn, object_id)
    conn.commit()
    return {"elements": written, "rooms": rooms_written,
            "retired": len(retired), "flats": flats}


def rebuild_flats(conn, object_id: int) -> int:
    """Квартиры пересобираются из комнат целиком.

    Полная пересборка, а не инкремент: квартира — производная сущность, у
    неё нет собственных данных, которые можно потерять. Ключ — тройка
    (секция, этаж, номер): номер не сквозной, и по одному ему квартиры
    разных этажей склеились бы в одну.
    """
    conn.execute("DELETE FROM object_flats WHERE object_id = ?", (object_id,))
    conn.execute(
        "INSERT INTO object_flats (object_id, section_id, level_id, number, "
        "rooms_count, plan_type, flat_area, living_area) "
        "SELECT ?, section_id, level_id, flat, MAX(rooms_count), "
        "       MAX(plan_type), MAX(flat_area), MAX(living_area) "
        "FROM revit_rooms "
        "WHERE object_id = ? AND is_current = 1 AND flat IS NOT NULL AND flat <> '' "
        "GROUP BY section_id, level_id, flat",
        (object_id, object_id),
    )
    return conn.execute(
        "SELECT COUNT(*) FROM object_flats WHERE object_id = ?", (object_id,)
    ).fetchone()[0]

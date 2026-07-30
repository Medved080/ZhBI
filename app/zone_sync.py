"""
Запись зон чертежа в СПРАВОЧНИК (этап 2, решения З1–З5, З7, З9).

Раньше это делала scripts/import_elements.upsert_zones: полное
DELETE + INSERT всех зон файла на каждый импорт. Так было можно, пока зона
была производной от чертежа — у неё не было ни номера, ни правок руками, а
id всё равно менялся при каждом переимпорте (из-за этого цвет крана
пришлось ключевать по имени, а не по id).

Теперь зона — запись справочника уровня Объекта, на которую ссылаются
элементы (elements.zone_*_id). Снести её и создать заново означает потерять
эти ссылки, поэтому импорт ОПОЗНАЁТ зону и обновляет её геометрию.

Ключ опознания — категория + НОМЕР (+ родительский кран у стоянки), решение
З2. Не имя: формат имени менялся между версиями чертежа («Стоянка 1» в
260720, «Стоянка 01» в 260723), и сравнение строк дало бы «новая зона» на
ровном месте. Не геометрия: она как раз и меняется, её расхождение — это то,
что нужно ПОКАЗАТЬ пользователю, а не то, по чему искать пару.
"""

import json
import sqlite3
from typing import Optional

from app.db import parse_zone_number


def _zone_key(category: str, number: Optional[int], name: Optional[str]) -> tuple:
    """Номер — основа ключа; имя добавляется только когда номера нет вовсе
    (зона без числа в подписи). Иначе «Стоянка 1» и «Стоянка 01» из двух
    версий чертежа считались бы разными зонами."""
    return (category, number) if number is not None else (category, None, name)


def load_catalog(conn: sqlite3.Connection, object_id: int) -> dict:
    """{ключ_опознания: строка zones} по актуальным записям справочника
    объекта. Стоянки ключуются вместе с родительским краном — номер стоянки
    уникален только внутри своего крана («Стоянка 1» есть у каждого крана)."""
    catalog = {}
    for row in conn.execute(
        "SELECT * FROM zones WHERE object_id = ? AND is_current = 1", (object_id,)
    ):
        key = _zone_key(row["category"], row["number"], row["name"])
        if row["category"] == "Стоянка":
            key = key + (row["parent_zone_id"],)
        catalog[key] = row
    return catalog


def _polygon_area(outline) -> float:
    """Площадь по формуле шнурков — нужна только для «на сколько процентов
    изменился контур» в сводке, поэтому shapely здесь не нужен."""
    total = 0.0
    n = len(outline)
    for i in range(n):
        x1, y1 = outline[i][0], outline[i][1]
        x2, y2 = outline[(i + 1) % n][0], outline[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def _centroid(outline) -> tuple:
    n = len(outline)
    return (sum(p[0] for p in outline) / n, sum(p[1] for p in outline) / n)


def analyze_zones(conn: sqlite3.Connection, object_id: int, zones: list) -> dict:
    """Что изменится в справочнике зон, если применить чертёж (решение З1).

    Ничего не пишет. Зона опознаётся тем же ключом, что и при применении
    (категория + номер + родительский кран), а ГЕОМЕТРИЯ сравнивается только
    для показа расхождений — искать пару по ней нельзя, она как раз и меняется.

    По каждому ярусу отдаётся, что с ним стало: изменился (с процентом
    изменения площади и сдвигом центра), добавился или исчез. Проценты и
    миллиметры, а не «геометрия изменилась» — по такому расхождению
    пользователь и решает, правка это или уже другая зона.
    """
    catalog = load_catalog(conn, object_id)
    levels_by_zone = {}
    for row in conn.execute(
        "SELECT zone_id, elevation_mm, outline_json FROM zone_levels WHERE zone_id IN "
        "(SELECT id FROM zones WHERE object_id = ? AND is_current = 1)", (object_id,)
    ):
        levels_by_zone.setdefault(row["zone_id"], {})[row["elevation_mm"]] = json.loads(row["outline_json"])

    # Краны — первыми, как и в sync_zones: ключ стоянки включает своего крана.
    order = {"Кран": 0, "Захватка": 1, "Стоянка": 2}
    handle_to_zone_id = {}
    conflicts, new_zones = [], []

    for record in sorted(zones, key=lambda z: order.get(z.category, 9)):
        number = parse_zone_number(record.name)
        key = _zone_key(record.category, number, record.name)
        parent_zone_id = None
        if record.category == "Стоянка" and record.parent_zone_handle:
            parent_zone_id = handle_to_zone_id.get(record.parent_zone_handle)
            key = key + (parent_zone_id,)
        existing = catalog.get(key)
        if existing is None:
            new_zones.append({"category": record.category, "number": number, "name": record.name})
            continue
        handle_to_zone_id[record.handle] = existing["id"]

        # Собираем по зоне все ярусы из чертежа (у зоны их несколько, и в
        # список zones они приходят отдельными записями).
        entry = next((c for c in conflicts if c["zone_id"] == existing["id"]), None)
        if entry is None:
            entry = {
                "zone_id": existing["id"], "category": record.category,
                "number": number, "name": record.name, "levels": [], "seen_elevations": [],
            }
            conflicts.append(entry)
        entry["seen_elevations"].append(record.elevation_mm)

        before = (levels_by_zone.get(existing["id"]) or {}).get(record.elevation_mm)
        if before is None:
            entry["levels"].append({
                "elevation_mm": record.elevation_mm, "kind": "добавлен",
                "points_after": len(record.outline),
            })
            continue
        area_before, area_after = _polygon_area(before), _polygon_area(record.outline)
        cb, ca = _centroid(before), _centroid(record.outline)
        shift = max(abs(ca[0] - cb[0]), abs(ca[1] - cb[1]))
        area_pct = abs(area_after - area_before) / area_before * 100 if area_before else 0.0
        # Порог 1 мм и 0.01% — чтобы округления при записи/чтении JSON не
        # выглядели как правка чертежа.
        if shift > 1 or area_pct > 0.01 or len(before) != len(record.outline):
            entry["levels"].append({
                "elevation_mm": record.elevation_mm, "kind": "изменён",
                "points_before": len(before), "points_after": len(record.outline),
                # float()/int() обязательны: вершины приходят из ezdxf как
                # numpy-числа, и np.float64 не сериализуется в JSON — поймано
                # первым же прогоном анализа.
                "area_change_pct": round(float(area_pct), 1),
                "centroid_shift_mm": int(round(float(shift))),
            })

    # Ярусы, которых в новом чертеже нет вовсе.
    for entry in conflicts:
        for elevation in (levels_by_zone.get(entry["zone_id"]) or {}):
            if elevation not in entry["seen_elevations"]:
                entry["levels"].append({"elevation_mm": elevation, "kind": "исчез"})
        entry.pop("seen_elevations", None)

    conflicts = [c for c in conflicts if c["levels"]]
    return {"zone_conflicts": conflicts, "new_zones": new_zones}


def sync_zones(
    conn: sqlite3.Connection, object_id: int, source_file: str, zones: list,
    create_new_zone_ids: Optional[set] = None,
) -> dict:
    """Обновляет справочник зон по разобранному чертежу.

    zones — список ZoneRecord (scripts/zone_parser). Возвращает
    {dxf_handle: (zone_id, level_id)} для apply_zone_bindings: привязка
    элемента считается по КОНКРЕТНОМУ полигону (handle), а знать нужно и
    запись справочника, и ярус внутри неё (решение З10).

    Зоны, которых в новом чертеже нет, помечаются неактуальными
    (is_current=0, решение З4) — не удаляются: на них могут ссылаться
    элементы, и их история привязки не должна исчезать молча.
    """
    # Краны — первыми: стоянка ссылается на кран, и ключ опознания стоянки
    # включает parent_zone_id, поэтому кран должен уже иметь id в справочнике.
    order = {"Кран": 0, "Захватка": 1, "Стоянка": 2}
    parsed = sorted(zones, key=lambda z: order.get(z.category, 9))

    catalog = load_catalog(conn, object_id)
    handle_to_zone_id = {}   # handle полигона -> id записи справочника
    handle_to_level = {}     # handle полигона -> id яруса
    seen_zone_ids = set()
    # Ярусы переписываются целиком по зоне, но только один раз за импорт:
    # у зоны несколько полигонов (по одному на ярус), и чистить её ярусы на
    # каждом полигоне означало бы удалять только что вставленные.
    cleared = set()

    for record in parsed:
        number = parse_zone_number(record.name)
        key = _zone_key(record.category, number, record.name)
        parent_zone_id = None
        if record.category == "Стоянка" and record.parent_zone_handle:
            parent_zone_id = handle_to_zone_id.get(record.parent_zone_handle)
            key = key + (parent_zone_id,)

        existing = catalog.get(key)
        # Решение пользователя «создать новую запись справочника вместо правки
        # существующей» (решение З1): прежняя запись помечается неактуальной и
        # больше не участвует в опознании, новая заводится с тем же номером —
        # уникальность номера проверяется только среди актуальных.
        if existing is not None and existing["id"] in (create_new_zone_ids or ()):
            conn.execute("UPDATE zones SET is_current = 0 WHERE id = ?", (existing["id"],))
            catalog.pop(key, None)
            existing = None
        if existing is not None:
            zone_id = existing["id"]
            conn.execute(
                "UPDATE zones SET name = ?, number = ?, source_file = ?, dxf_handle = ?, "
                "match_status = ?, parent_match_status = ?, parent_zone_id = ?, is_current = 1 "
                "WHERE id = ?",
                (record.name, number, source_file, record.handle, record.match_status,
                 record.parent_match_status, parent_zone_id, zone_id),
            )
        else:
            conn.execute(
                "INSERT INTO zones (object_id, source_file, dxf_handle, category, elevation_mm, "
                "name, outline_json, match_status, parent_match_status, parent_zone_id, number, is_current) "
                "VALUES (?, ?, ?, ?, NULL, ?, '', ?, ?, ?, ?, 1)",
                (object_id, source_file, record.handle, record.category, record.name,
                 record.match_status, record.parent_match_status, parent_zone_id, number),
            )
            zone_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            catalog[key] = conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()

        if zone_id not in cleared:
            conn.execute("DELETE FROM zone_levels WHERE zone_id = ?", (zone_id,))
            cleared.add(zone_id)
        conn.execute(
            "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, ?, ?, ?, ?)",
            (zone_id, record.elevation_mm, json.dumps(record.outline), source_file, record.handle),
        )
        handle_to_level[record.handle] = conn.execute(
            "SELECT last_insert_rowid() AS id").fetchone()["id"]
        handle_to_zone_id[record.handle] = zone_id
        seen_zone_ids.add(zone_id)

    # Чего в чертеже больше нет — неактуально (решение З4).
    stale = [
        row["id"] for row in conn.execute(
            "SELECT id FROM zones WHERE object_id = ? AND is_current = 1", (object_id,)
        ) if row["id"] not in seen_zone_ids
    ]
    if stale:
        placeholders = ", ".join("?" for _ in stale)
        conn.execute(
            f"UPDATE zones SET is_current = 0 WHERE id IN ({placeholders})", tuple(stale)
        )

    conn.commit()
    return {
        handle: (zone_id, handle_to_level.get(handle))
        for handle, zone_id in handle_to_zone_id.items()
    }


def summary(conn: sqlite3.Connection, object_id: int, mapping: dict) -> dict:
    """Числа для отчёта импорта: сколько записей справочника актуально, сколько
    ярусов и сколько зон ушло в неактуальные этим импортом."""
    zone_ids = {zone_id for zone_id, _ in mapping.values()}
    retired = conn.execute(
        "SELECT COUNT(*) AS n FROM zones WHERE object_id = ? AND is_current = 0", (object_id,)
    ).fetchone()["n"]
    levels = conn.execute(
        "SELECT COUNT(*) AS n FROM zone_levels WHERE zone_id IN "
        f"({', '.join('?' for _ in zone_ids) or 'NULL'})", tuple(zone_ids)
    ).fetchone()["n"] if zone_ids else 0
    return {"zones": len(zone_ids), "levels": levels, "retired": retired}

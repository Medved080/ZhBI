"""
Загружает результат assign_axes.py (elements_with_address.csv) в БД
(data/zhbi.db). Идемпотентно: повторный импорт того же файла обновляет
геометрию/марку/адрес, но НЕ трогает current_status и историю статусов —
иначе повторный импорт чертежа сбрасывал бы прогресс поставки/монтажа,
уже отмеченный на площадке.

Совпадение элементов между запусками — по паре (source_file, dxf_handle).
Если DXF будет пересобран так, что handle-ы у тех же физических колонн
изменятся, эта пара перестанет совпадать и вместо обновления создастся
новый элемент — известное ограничение первой версии (см.
Docs/requirements-notes.md).

С флагом --dxf дополнительно сохраняет сетку осей (axis_lines) — тогда
интерактивная схема в браузере рисуется полностью из БД, без обращения к
исходному DXF (он может быть огромным и лежать только на машине, где
делали импорт). У сетки осей нет истории/статуса, поэтому она просто
перезаписывается целиком при каждом импорте с --dxf.

Запуск:
    python scripts/import_elements.py output/260713_v2_elements_with_address.csv \\
        --source-file "260713_Чертежи для WEB_2.dxf" \\
        --dxf "test_data/260713_Чертежи для WEB_2.dxf"
"""

import argparse
import csv
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import get_connection, init_db
from parse_zhbi import ElementRecord  # тот же каталог scripts/

FIELDS = [
    "dxf_handle", "layer", "element_type", "mark", "mark_source",
    "x", "y", "z", "address", "axis_status", "axis_number", "axis_letter",
    "nearest_axis_number", "nearest_axis_letter", "offset_x_mm", "offset_y_mm",
]


def to_float_or_none(value):
    if value in (None, ""):
        return None
    return float(value)


def build_row(record: ElementRecord, address: dict) -> dict:
    """
    Единственное место, где ElementRecord (из parse_zhbi.parse_dxf) и словарь
    assign_axes.assign_address() превращаются в строку для БД. И CSV-путь
    (read_rows, используется CLI-скриптами), и in-memory путь (загрузка DXF
    через веб-UI, app/dxf_import.py) проходят через эту же функцию — чтобы
    не завести два места с одной и той же логикой маппинга.
    """
    return {
        "dxf_handle": record.id,
        "layer": record.layer,
        "element_type": record.element_type,
        "mark": record.mark,
        "mark_source": record.source,
        "x": record.x,
        "y": record.y,
        "z": record.z,
        "address": address.get("address"),
        "axis_status": address["status"],
        "axis_number": address.get("axis_number"),
        "axis_letter": address.get("axis_letter"),
        "nearest_axis_number": address.get("nearest_axis_number"),
        "nearest_axis_letter": address.get("nearest_axis_letter"),
        "offset_x_mm": address.get("offset_x_mm"),
        "offset_y_mm": address.get("offset_y_mm"),
        # Только у элементов из LWPOLYLINE (см. ElementRecord.outline) — путь
        # через CSV (read_rows ниже) его не восстанавливает, там всегда None.
        "outline_json": json.dumps(record.outline) if record.outline else None,
        # Только у элементов нового стандарта имён слоёв (см.
        # scripts/layer_naming.py, scripts/new_standard_pipeline.py) —
        # всегда None у элементов старого конвейера (LAYER_CONFIG).
        "subtype": record.subtype,
        "elevation_mm": record.elevation_mm,
        # Только у элементов, чей слой несёт суффикс "_этаж N" (см.
        # scripts/layer_naming.py) — иначе None, как subtype/elevation_mm
        # у элементов без нового стандарта имён слоёв.
        "floor": record.floor,
    }


def read_rows(csv_path):
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            record = ElementRecord(
                id=row["id"],
                layer=row["layer"],
                element_type=row["element_type"],
                mark=row.get("mark") or None,
                source=row["source"],
                x=float(row["x"]),
                y=float(row["y"]),
                z=float(row.get("z") or 0),
            )
            address = {
                "address": row.get("address") or None,
                "status": row["status"],
                "axis_number": row.get("axis_number") or None,
                "axis_letter": row.get("axis_letter") or None,
                "nearest_axis_number": row.get("nearest_axis_number") or None,
                "nearest_axis_letter": row.get("nearest_axis_letter") or None,
                "offset_x_mm": to_float_or_none(row.get("offset_x_mm")),
                "offset_y_mm": to_float_or_none(row.get("offset_y_mm")),
            }
            yield build_row(record, address)


def ensure_label_visibility(conn, element_types):
    """Заводит запись в label_visibility (ВЫКЛЮЧЕНА по умолчанию — заказчик
    сам включает нужные из "Настройки", см. Docs/backlog.md, быстродействие
    на больших файлах) для каждого нового element_type — типы элементов не
    жёстко зашиты (сейчас "Колонна"/"Ригель", остальные появятся позже),
    поэтому настройка самообслуживается по мере импорта, а не заполняется
    заранее."""
    for element_type in element_types:
        conn.execute(
            "INSERT OR IGNORE INTO label_visibility (element_type, visible) VALUES (?, 0)",
            (element_type,),
        )


def upsert_elements(conn, rows, source_file):
    """Принимает уже открытое соединение и готовый iterable строк (build_row()).

    УНАСЛЕДОВАННЫЙ путь: сопоставление по паре (source_file, dxf_handle), то
    есть имя файла входит в идентичность. Загрузка чертежа (и через
    интерфейс, и из Input/) им больше НЕ пользуется — с 2026-07-30 она идёт
    через app/element_sync.py, где элементы принадлежат Объекту и переимпорт
    обновляет их, сохраняя статусы (см. Docs/TZ.md, Docs/backlog.md). Здесь
    остался только CLI-импорт из CSV (main() ниже): элементы, заведённые
    этим путём, получают object_id = NULL и в модели объектов не участвуют.
    Если CLI-путь понадобится всерьёз, его нужно переводить на element_sync,
    а не расширять эту функцию."""
    inserted = updated = 0
    element_types = set()
    for row in rows:
        element_types.add(row["element_type"])
        existing = conn.execute(
            "SELECT id FROM elements WHERE source_file = ? AND dxf_handle = ?",
            (source_file, row["dxf_handle"]),
        ).fetchone()

        values = {**row, "source_file": source_file}

        if existing:
            conn.execute(
                """
                UPDATE elements SET
                    layer=:layer, element_type=:element_type, mark=:mark,
                    mark_source=:mark_source, x=:x, y=:y, z=:z,
                    address=:address, axis_status=:axis_status,
                    axis_number=:axis_number, axis_letter=:axis_letter,
                    nearest_axis_number=:nearest_axis_number,
                    nearest_axis_letter=:nearest_axis_letter,
                    offset_x_mm=:offset_x_mm, offset_y_mm=:offset_y_mm,
                    outline_json=:outline_json, subtype=:subtype, elevation_mm=:elevation_mm,
                    floor=:floor,
                    updated_at=datetime('now')
                WHERE source_file=:source_file AND dxf_handle=:dxf_handle
                """,
                values,
            )
            updated += 1
        else:
            conn.execute(
                """
                INSERT INTO elements (
                    source_file, dxf_handle, layer, element_type, mark,
                    mark_source, x, y, z, address, axis_status,
                    axis_number, axis_letter, nearest_axis_number,
                    nearest_axis_letter, offset_x_mm, offset_y_mm, outline_json,
                    subtype, elevation_mm, floor
                ) VALUES (
                    :source_file, :dxf_handle, :layer, :element_type, :mark,
                    :mark_source, :x, :y, :z, :address, :axis_status,
                    :axis_number, :axis_letter, :nearest_axis_number,
                    :nearest_axis_letter, :offset_x_mm, :offset_y_mm, :outline_json,
                    :subtype, :elevation_mm, :floor
                )
                """,
                values,
            )
            element_id = conn.execute(
                "SELECT id FROM elements WHERE source_file = ? AND dxf_handle = ?",
                (source_file, row["dxf_handle"]),
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO status_history (element_id, status, changed_by, comment) "
                "VALUES (?, 'planned', 'import', 'создан импортом')",
                (element_id,),
            )
            inserted += 1

    ensure_label_visibility(conn, element_types)
    conn.commit()
    return inserted, updated


def import_elements(csv_path, source_file):
    init_db()
    conn = get_connection()
    try:
        return upsert_elements(conn, read_rows(csv_path), source_file)
    finally:
        conn.close()


def save_axis_grid(conn, grid, source_file):
    """Принимает уже открытое соединение и готовый AxisGrid — общий код для
    CLI (import_axis_grid читает DXF сам) и веб-загрузки (DXF уже открыт)."""
    conn.execute("DELETE FROM axis_lines WHERE source_file = ?", (source_file,))
    rows = [
        (source_file, "numeric", label, coord) for label, coord in grid.numeric_axes.items()
    ] + [
        (source_file, "letter", label, coord) for label, coord in grid.letter_axes.items()
    ]
    conn.executemany(
        "INSERT INTO axis_lines (source_file, kind, label, coord) VALUES (?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(grid.numeric_axes), len(grid.letter_axes)


# Палитра для автоназначения цвета зоны каждому КРАНУ (см. Docs/backlog.md,
# item 7) — циклическая, если кранов в файле больше, чем цветов в палитре.
ZONE_COLOR_PALETTE = [
    "#c0392b", "#1f8a4c", "#8e44ad", "#d68910", "#2471a3",
    "#16a085", "#a04000", "#5b2c6f", "#117864", "#b03a2e",
]


def _ensure_zone_colors(conn, zones, source_file):
    """Автоназначает цвет каждому крану этого файла, у которого его ещё
    нет — не трогает уже настроенные админом цвета (`INSERT OR IGNORE`,
    старый цвет крана при переимпорте того же файла не сбрасывается).
    Стоянки отдельного цвета не получают — наследуют цвет своего крана на
    отображении (см. app/main.py plan_data, scripts/zone_parser.
    _link_stances_to_cranes)."""
    crane_names = sorted({z.name for z in zones if z.category == "Кран" and z.name})
    if not crane_names:
        return
    existing_rows = conn.execute(
        "SELECT name, color FROM zone_colors WHERE source_file = ? AND category = 'Кран'", (source_file,)
    ).fetchall()
    existing_names = {r["name"] for r in existing_rows}
    used_colors = {r["color"] for r in existing_rows}

    for name in crane_names:
        if name in existing_names:
            continue
        color = next((c for c in ZONE_COLOR_PALETTE if c not in used_colors), None)
        if color is None:
            color = ZONE_COLOR_PALETTE[len(used_colors) % len(ZONE_COLOR_PALETTE)]
        used_colors.add(color)
        conn.execute(
            "INSERT OR IGNORE INTO zone_colors (source_file, category, name, color) VALUES (?, 'Кран', ?, ?)",
            (source_file, name, color),
        )
    conn.commit()


def upsert_zones(conn, zones, source_file):
    """Полностью перезаписывает зоны source_file — как сетка осей (см.
    save_axis_grid выше), у зон нет истории/статуса, только "как сейчас
    на чертеже". Возвращает {dxf_handle: id_в_БД} для apply_zone_bindings.

    parent_zone_id (только у category="Стоянка" — связь со "своим" краном,
    см. scripts/zone_parser._link_stances_to_cranes) заполняется ВТОРЫМ
    проходом отдельными UPDATE, после того как все зоны уже вставлены и
    получили db id — иначе пришлось бы гарантировать, что зона крана
    вставляется раньше своих стоянок, а порядок в списке zones это не
    гарантирует."""
    conn.execute("DELETE FROM zones WHERE source_file = ?", (source_file,))
    handle_to_id = {}
    for z in zones:
        conn.execute(
            "INSERT INTO zones (source_file, dxf_handle, category, elevation_mm, name, outline_json, match_status, parent_match_status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                source_file, z.handle, z.category, z.elevation_mm, z.name, json.dumps(z.outline),
                z.match_status, z.parent_match_status,
            ),
        )
        handle_to_id[z.handle] = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

    for z in zones:
        parent_handle = z.parent_zone_handle
        if parent_handle and parent_handle in handle_to_id:
            conn.execute(
                "UPDATE zones SET parent_zone_id = ? WHERE id = ?",
                (handle_to_id[parent_handle], handle_to_id[z.handle]),
            )

    _ensure_zone_colors(conn, zones, source_file)
    conn.commit()
    return handle_to_id


_ZONE_CATEGORY_COLUMNS = {
    "Захватка": ("zone_zakhvatka_id", "zone_zakhvatka_status"),
    "Кран": ("zone_crane_id", "zone_crane_status"),
    "Стоянка": ("zone_stance_id", "zone_stance_status"),
}


def apply_zone_bindings(conn, source_file, element_records, zone_handle_to_id):
    """element_records — те же ElementRecord (нового стандарта), что ушли
    в upsert_elements, с уже посчитанным record.zone_bindings (см.
    scripts/new_standard_pipeline.process). Элементы старого конвейера
    (zone_bindings=None) просто пропускаются — их zone_*-поля остаются
    NULL, как и было до этой функции.

    zone_handle_to_id — {handle полигона: (id записи справочника, id яруса)},
    см. app/zone_sync.sync_zones. Привязка считается по КОНКРЕТНОМУ полигону,
    а записать нужно и запись справочника (elements.zone_*_id), и — для
    стоянки — ярус внутри неё (zone_stance_level_id, решение З10): после
    склейки ярусов в одну запись справочника ярус иначе потерялся бы."""
    for record in element_records:
        if not record.zone_bindings:
            continue
        element_row = conn.execute(
            "SELECT id FROM elements WHERE source_file = ? AND dxf_handle = ?",
            (source_file, record.id),
        ).fetchone()
        if not element_row:
            continue
        updates = {"element_id": element_row["id"]}
        for category, result in record.zone_bindings.items():
            id_col, status_col = _ZONE_CATEGORY_COLUMNS[category]
            resolved = zone_handle_to_id.get(result.zone_handle) if result.zone_handle else None
            zone_id, level_id = resolved if resolved else (None, None)
            updates[id_col] = zone_id
            updates[status_col] = result.status
            if category == "Стоянка":
                updates["zone_stance_level_id"] = level_id
        set_clause = ", ".join(f"{col}=:{col}" for col in updates if col != "element_id")
        conn.execute(f"UPDATE elements SET {set_clause} WHERE id=:element_id", updates)
    conn.commit()


def import_axis_grid(dxf_path, source_file):
    import ezdxf

    logging.getLogger("ezdxf").setLevel(logging.ERROR)
    from assign_axes import AXIS_LAYER, build_axis_grid  # тот же каталог scripts/

    doc = ezdxf.readfile(dxf_path)
    grid = build_axis_grid(doc, AXIS_LAYER)

    conn = get_connection()
    try:
        return save_axis_grid(conn, grid, source_file)
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", help="Путь к elements_with_address.csv")
    parser.add_argument(
        "--source-file", required=True,
        help="Имя исходного DXF (ключ для сопоставления при повторном импорте)",
    )
    parser.add_argument(
        "--dxf", default=None,
        help="Путь к исходному DXF — если указан, сетка осей тоже сохраняется в БД",
    )
    args = parser.parse_args()

    inserted, updated = import_elements(args.csv_path, args.source_file)
    total = inserted + updated

    print(f"Источник: {args.source_file}")
    print(f"Новых элементов: {inserted}")
    print(f"Обновлено (статус сохранён): {updated}")
    print(f"Итого в файле: {total}")

    if args.dxf:
        n_num, n_let = import_axis_grid(args.dxf, args.source_file)
        print(f"Сетка осей: {n_num} числовых, {n_let} буквенных")


if __name__ == "__main__":
    main()

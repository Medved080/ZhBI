"""
Импорт чертежа В РАМКАХ ОБЪЕКТА: сверка, сводка расхождений, применение.

Заменяет прежнюю схему "новый файл = новые строки" (см.
scripts/import_elements.upsert_elements, где сопоставление шло по паре
(source_file, dxf_handle) и имя файла входило в идентичность). Теперь
элементы объекта живут одним набором строк: переимпорт ОБНОВЛЯЕТ их,
статусы, история, контракты и даты остаются на месте.

Импорт двухфазный (решение И3): analyze_import() ничего не пишет и отдаёт
сводку, apply_import() применяет её по решениям пользователя. Оба
неинтерактивных пути (scripts/rebuild_db.py, загрузка из Input/) вызывают
их подряд с решениями по умолчанию — решение З3.

Сама механика сопоставления — в app/element_identity.py (чистый модуль без
БД, замеры и обоснование уровней сверки там же).
"""

import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from import_elements import ensure_label_visibility

from app.db import assign_missing_element_uids
from app.element_identity import MatchResult, match_elements

# Поля строки чертежа, которые переносятся в существующую строку БД при
# сопоставлении. Здесь НЕТ ни current_status, ни contract_id, ни дат
# поставки, ни element_uid — всё это принадлежит элементу как объекту
# учёта, а не чертежу, и переимпорт их не касается (ровно то свойство,
# из-за которого вся эта переработка и делалась).
_GEOMETRY_FIELDS = (
    "layer", "element_type", "mark", "mark_source", "x", "y", "z",
    "address", "axis_status", "axis_number", "axis_letter",
    "nearest_axis_number", "nearest_axis_letter", "offset_x_mm", "offset_y_mm",
    "outline_json", "subtype", "elevation_mm", "floor",
)

_EXISTING_FIELDS = (
    "manual_fields", "address",
    "id", "dxf_handle", "element_type", "mark", "subtype", "elevation_mm",
    "floor", "outline_json", "contract_id", "current_status",
)

# Сколько строк расхождений отдавать в сводку на каждый раздел. Разворот
# построчно пользователь просил (решение И3), но отдавать 9422 строки в
# браузер незачем — на реальных переходах интересны единицы и сотни, а не
# тысячи; остальное видно числом в заголовке раздела.
DETAIL_LIMIT = 500


def get_current_object(conn: sqlite3.Connection) -> Optional[sqlite3.Row]:
    """Единственный объект, если он один — обычный случай на сегодня.
    Множественные объекты появятся, когда сервис реально пойдёт на второе
    здание; выбор объекта тогда придёт явным параметром импорта."""
    rows = conn.execute("SELECT * FROM objects ORDER BY id").fetchall()
    return rows[0] if len(rows) == 1 else None


def resolve_import_object(conn: sqlite3.Connection, object_id: Optional[int], source_file: str) -> int:
    """Определяет объект, в который идёт импорт. Если объектов ещё нет
    (первая установка) — заводит первый по имени файла: пользователь
    переименует его в справочнике, но безымянным объект не остаётся."""
    if object_id is not None:
        row = conn.execute("SELECT id FROM objects WHERE id = ?", (object_id,)).fetchone()
        if row is None:
            raise ValueError(f"Объект #{object_id} не найден")
        return row["id"]

    existing = conn.execute("SELECT id FROM objects ORDER BY id").fetchall()
    if len(existing) == 1:
        return existing[0]["id"]
    if len(existing) > 1:
        raise ValueError("В базе несколько объектов — укажите, в какой импортировать")

    conn.execute("INSERT INTO objects (name) VALUES (?)", (source_file,))
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def load_object_elements(conn: sqlite3.Connection, object_id: int) -> list:
    """Только АКТУАЛЬНЫЕ элементы объекта: исчезнувшие при прошлом импорте
    (is_current=0) в сверке не участвуют — иначе элемент, который заказчик
    убрал с чертежа, а потом вернул, породил бы неоднозначность с уже
    заведённым заново. Возвращать их к жизни — отдельное решение, не
    побочный эффект сверки."""
    rows = conn.execute(
        f"SELECT {', '.join(_EXISTING_FIELDS)} FROM elements "
        "WHERE object_id = ? AND is_current = 1 ORDER BY id",
        (object_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _contract_conflict(conn, contract_id, element_type, mark) -> bool:
    """После смены марки элемент перестаёт соответствовать позиции своего
    контракта (решение И4/Э5). Позиция контракта — (тип, марка) NULL-safe,
    как в contracts.contract_line_warning."""
    if contract_id is None:
        return False
    line = conn.execute(
        "SELECT 1 FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark IS ?",
        (contract_id, element_type, mark),
    ).fetchone()
    return line is None


def analyze_import(conn: sqlite3.Connection, object_id: int, rows: list) -> dict:
    """Ничего не пишет. Возвращает сводку с разворотом построчно:
    {counts: {...}, details: {mark_changes: [...], ...}}, а также сам
    MatchResult под ключом "match" — apply_import принимает его как есть,
    чтобы не считать сопоставление дважды."""
    existing = load_object_elements(conn, object_id)
    match = match_elements(existing, rows)
    existing_by_id = {row["id"]: row for row in existing}

    mark_changes, attribute_changes = [], []
    for item in match.matched:
        if not item.changes:
            continue
        was = existing_by_id[item.element_id]
        incoming = rows[item.incoming_index]
        entry = {
            "element_id": item.element_id,
            "matched_by": item.how,
            "dxf_handle": incoming["dxf_handle"],
            "element_type": incoming["element_type"],
            "changes": {k: list(v) for k, v in item.changes.items()},
        }
        if "mark" in item.changes:
            entry["current_status"] = was["current_status"]
            entry["contract_conflict"] = _contract_conflict(
                conn, was["contract_id"], incoming["element_type"], incoming["mark"]
            )
            mark_changes.append(entry)
        else:
            attribute_changes.append(entry)

    retired = []
    for element_id in match.retired_ids:
        row = existing_by_id[element_id]
        retired.append({
            "element_id": element_id,
            "dxf_handle": row["dxf_handle"],
            "element_type": row["element_type"],
            "mark": row["mark"],
            "current_status": row["current_status"],
        })

    new_items = []
    for index in match.new_indexes:
        row = rows[index]
        new_items.append({
            "dxf_handle": row["dxf_handle"],
            "element_type": row["element_type"],
            "mark": row.get("mark"),
            "elevation_mm": row.get("elevation_mm"),
        })

    # Расхождения с ПРАВЛЕННЫМИ РУКАМИ полями (решение Э4): чертёж говорит
    # одно, в справочнике админ поставил другое. Импорт по умолчанию
    # сохраняет ручное значение, но пользователь должен видеть расхождение и
    # уметь по каждому полю выбрать «перезаполнить из чертежа».
    manual_conflicts = []
    for item in match.matched:
        was = existing_by_id[item.element_id]
        manual = set(json.loads(was.get("manual_fields") or "[]"))
        if not manual:
            continue
        incoming = rows[item.incoming_index]
        diffs = {
            field: [was.get(field), incoming.get(field)]
            for field in sorted(manual)
            # Только поля, которые импорт вообще пишет: плановую дату,
            # например, чертёж не несёт, и «расхождением» это не является.
            if field in _GEOMETRY_FIELDS and was.get(field) != incoming.get(field)
        }
        if diffs:
            manual_conflicts.append({
                "element_id": item.element_id,
                "dxf_handle": incoming["dxf_handle"],
                "element_type": was.get("element_type"),
                "mark": was.get("mark"),
                "changes": diffs,
            })

    counts = match.counts()
    counts["manual_conflicts"] = len(manual_conflicts)
    counts["mark_change_contract_conflicts"] = sum(1 for e in mark_changes if e["contract_conflict"])
    # Исчезающие элементы, по которым уже есть работа на площадке — то, что
    # в сводке надо видеть в первую очередь: их статус будет сохранён, но
    # сам элемент уйдёт со схемы.
    counts["retired_with_progress"] = sum(1 for e in retired if e["current_status"] != "planned")

    return {
        "object_id": object_id,
        "counts": counts,
        "details": {
            "mark_changes": mark_changes[:DETAIL_LIMIT],
            "attribute_changes": attribute_changes[:DETAIL_LIMIT],
            "retired": retired[:DETAIL_LIMIT],
            "new": new_items[:DETAIL_LIMIT],
            "manual_conflicts": manual_conflicts[:DETAIL_LIMIT],
        },
        "detail_limit": DETAIL_LIMIT,
        "match": match,
    }


def apply_import(
    conn: sqlite3.Connection,
    object_id: int,
    source_file: str,
    rows: list,
    match: MatchResult,
    accept_mark_changes: bool = True,
    keep_mark_element_ids: Optional[set] = None,
    refill_manual_fields: Optional[dict] = None,
) -> dict:
    """Применяет сверку. accept_mark_changes=False (или перечисление
    element_id в keep_mark_element_ids) оставляет ПРЕЖНЮЮ марку у
    сопоставленного элемента — решение И4: смена марки согласуется, потому
    что марка привязана к позиции контракта. Вся остальная геометрия
    обновляется в любом случае: расходиться с чертежом по форме и
    координатам элемент не должен.
    """
    keep_marks = set(keep_mark_element_ids or ())
    refill_fields = refill_manual_fields or {}
    element_types = set()
    updated = inserted = retired = marks_kept = manual_kept = 0

    manual_by_id = {
        r["id"]: set(json.loads(r["manual_fields"] or "[]"))
        for r in conn.execute(
            "SELECT id, manual_fields FROM elements WHERE manual_fields IS NOT NULL")
    }

    for item in match.matched:
        row = rows[item.incoming_index]
        element_types.add(row["element_type"])
        values = {field: row.get(field) for field in _GEOMETRY_FIELDS}
        # Поля, правленные руками в справочнике, чертёж НЕ перезаписывает
        # (решение Э4): расхождение показывается в сводке, а решение
        # «оставить ручное / перезаполнить» принимает пользователь.
        for field in manual_by_id.get(item.element_id, ()):
            if field in values and field not in refill_fields.get(item.element_id, ()):
                values.pop(field)
                manual_kept += 1
        if "mark" in item.changes and (not accept_mark_changes or item.element_id in keep_marks):
            values.pop("mark", None)
            marks_kept += 1
        assignments = ", ".join(f"{field} = :{field}" for field in values)
        values.update({
            "id": item.element_id,
            "source_file": source_file,
            "dxf_handle": row["dxf_handle"],
        })
        conn.execute(
            f"UPDATE elements SET {assignments}, source_file = :source_file, "
            "dxf_handle = :dxf_handle, is_current = 1, updated_at = datetime('now') "
            "WHERE id = :id",
            values,
        )
        updated += 1

    for index in match.new_indexes:
        row = rows[index]
        element_types.add(row["element_type"])
        values = {field: row.get(field) for field in _GEOMETRY_FIELDS}
        values.update({
            "source_file": source_file,
            "dxf_handle": row["dxf_handle"],
            "object_id": object_id,
        })
        columns = ", ".join(values)
        placeholders = ", ".join(f":{name}" for name in values)
        conn.execute(
            f"INSERT INTO elements ({columns}, is_current) VALUES ({placeholders}, 1)",
            values,
        )
        element_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        # Та же стартовая запись истории, что и у прежнего upsert_elements —
        # элемент без единой записи в status_history сломал бы вычисление
        # current_status "по последней записи по changed_at".
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, comment) "
            "VALUES (?, 'planned', 'import', 'создан импортом')",
            (element_id,),
        )
        inserted += 1

    if match.retired_ids:
        # Статусы, история, контракт и даты сохраняются — меняется только
        # признак присутствия в актуальном чертеже (решение И2, п.3).
        placeholders = ", ".join("?" for _ in match.retired_ids)
        conn.execute(
            f"UPDATE elements SET is_current = 0, updated_at = datetime('now') "
            f"WHERE id IN ({placeholders})",
            tuple(match.retired_ids),
        )
        retired = len(match.retired_ids)

    assign_missing_element_uids(conn, object_id)
    _register_drawing(conn, object_id, source_file)

    ensure_label_visibility(conn, element_types, object_id)
    conn.commit()

    return {
        "updated": updated,
        "inserted": inserted,
        "retired": retired,
        "marks_kept": marks_kept,
        "manual_kept": manual_kept,
        "total_current": updated + inserted,
    }


def _register_drawing(conn: sqlite3.Connection, object_id: int, source_file: str) -> None:
    """Актуальным становится только что загруженный чертёж; прежний
    остаётся в списке чертежей объекта как история загрузок."""
    conn.execute(
        "UPDATE object_drawings SET is_current = 0 WHERE object_id = ?", (object_id,)
    )
    conn.execute(
        "INSERT INTO object_drawings (object_id, source_file, is_current, imported_at) "
        "VALUES (?, ?, 1, datetime('now')) "
        "ON CONFLICT(object_id, source_file) DO UPDATE SET "
        "is_current = 1, imported_at = datetime('now')",
        (object_id, source_file),
    )


def summary_for_log(counts: dict) -> str:
    """Одна строка для журнала действий и для печати в неинтерактивных
    путях импорта (решение З3 — молча не обновляем)."""
    return (
        f"сопоставлено по handle {counts.get('matched_by_handle', 0)}, "
        f"по геометрии {counts.get('matched_by_geometry', 0)}, "
        f"новых {counts.get('new', 0)}, исчезло {counts.get('retired', 0)}, "
        f"смена марки {counts.get('mark_changed', 0)}"
    )

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

from app import activity
from app.db import touch_elements, assign_missing_element_uids
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
    переименует его в справочнике, но безымянным объект не остаётся.

    ValueError здесь — не сбой сервера, а «так нельзя»: вызывающий обязан
    превратить его в понятный отказ клиенту (400), а не дать уйти наверх
    пятисоткой. См. app/main.import_dxf и app/input_import.import_input_dxf.
    """
    if object_id is not None:
        row = conn.execute("SELECT id FROM objects WHERE id = ?", (object_id,)).fetchone()
        if row is None:
            raise ValueError(f"Объект #{object_id} не найден")
        return row["id"]

    existing = conn.execute("SELECT id FROM objects ORDER BY id").fetchall()
    if len(existing) == 1:
        return existing[0]["id"]
    if len(existing) > 1:
        # Текст НЕЙТРАЛЬНЫЙ: куда идти дальше, знает только вызывающий, и у
        # разных путей это разные места (форма загрузки чертежа, выбор
        # объекта в форме папки Input). Раньше подсказка была зашита прямо
        # сюда и устарела в тот же день, когда у папки Input появился свой
        # выбор объекта.
        raise ValueError(
            "В базе несколько объектов — не определить, в какой из них загружать. "
            "Объект нужно выбрать явно."
        )

    conn.execute("INSERT INTO objects (name) VALUES (?)", (source_file,))
    новый = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    # Объект, заведённый САМИМ импортом (первая в жизни установка), — тоже
    # событие: иначе единственный путь, которым объект появляется без
    # участия справочника «Объекты», не оставлял бы следа.
    activity.log("object_create", source="system", entity_type="object", entity_id=новый,
                 new_value=source_file, details={"причина": "заведён при загрузке чертежа"})
    return новый


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
    user=None,
    request_id: Optional[str] = None,
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
    изменённые = set()   # чьи поля чертёж реально поправил (см. touch_elements ниже)

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
        # Событие пишется ТОЛЬКО тем изделиям, у которых чертёж реально
        # что-то изменил (item.changes), а не всем сопоставленным
        # (2026-08-03): переимпорт трогает все 9422 строки, но меняет
        # заметно меньше, и «обновлено» у нетронутого изделия было бы
        # ложью в его истории изменений. Сводка операции — у вызывающего,
        # связь через общий request_id.
        реально = {f: v for f, v in item.changes.items() if f in values or f == "mark"}
        if реально:
            # Тот же набор, что получает событие в журнале: изделия, у
            # которых чертёж РЕАЛЬНО что-то изменил. Им переставляется
            # updated_at перед фиксацией — иначе чужие вкладки не увидят
            # переимпорт до перезагрузки (см. app.db.touch_elements).
            изменённые.add(item.element_id)
            activity.log(
                "import_dxf_element", user=user, entity_type="element",
                entity_id=item.element_id, element_type=row.get("element_type"),
                subtype=row.get("subtype"), mark=row.get("mark"),
                old_value="; ".join(f"{f}: {было}" for f, (было, _) in реально.items())[:500],
                new_value="; ".join(f"{f}: {стало}" for f, (_, стало) in реально.items())[:500],
                request_id=request_id, details={"чертёж": source_file},
            )

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
    _sync_mark_links(conn, object_id)
    _register_drawing(conn, object_id, source_file)

    ensure_label_visibility(conn, element_types, object_id)
    # Штамп ПОСЛЕДНИМ действием перед фиксацией: переимпорт чертежа —
    # самая длинная запись в системе, и опрос чужих вкладок за это время
    # успевает уйти вперёд по метке времени (см. app.db.touch_elements).
    touch_elements(conn, изменённые)
    conn.commit()

    return {
        "updated": updated,
        "inserted": inserted,
        "retired": retired,
        "marks_kept": marks_kept,
        "manual_kept": manual_kept,
        "total_current": updated + inserted,
    }


def _sync_mark_links(conn: sqlite3.Connection, object_id: int) -> None:
    """Привести `elements.mark_id` в соответствие тексту марки после импорта.

    Импорт пишет марку ТЕКСТОМ (так устроен весь конвейер разбора DXF), а
    ссылка на справочник производна от текста — см.
    `app/element_fields.resolve_mark_id`. Без этого прохода новая версия
    чертежа принесла бы марки, которых нет в справочнике, и ссылка у таких
    изделий осталась бы пустой: справочник начал бы отставать от данных
    ровно там, где данные и меняются.

    Одним проходом по объекту, а не по строке на изделие: переимпорт трогает
    все девять с лишним тысяч строк, и запрос на каждую стоил бы дороже
    самого импорта.
    """
    пары = conn.execute(
        """
        SELECT DISTINCT e.element_type, e.mark FROM elements e
        WHERE e.object_id = ? AND e.element_type IS NOT NULL
          AND e.mark IS NOT NULL AND trim(e.mark) <> ''
        """,
        (object_id,),
    ).fetchall()
    for пара in пары:
        conn.execute(
            "INSERT OR IGNORE INTO marks (object_id, element_type, name) VALUES (?, ?, ?)",
            (object_id, пара["element_type"], пара["mark"]),
        )
    conn.execute(
        """
        UPDATE elements SET mark_id = (
            SELECT m.id FROM marks m
            WHERE m.object_id = elements.object_id
              AND m.element_type = elements.element_type
              AND m.name = elements.mark
        )
        WHERE object_id = ?
        """,
        (object_id,),
    )


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

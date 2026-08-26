"""
Дерево видов работ и статусы по блокам (Docs/block-accounting.md §1, §3).

Статус ставит человек, отсутствие записи в `work_progress` значит «План» —
таблица не хранит строку на каждую пару вид-работ/блок со значением по
умолчанию. Привязка статуса (блок / секция целиком / объект целиком)
определяется ЕДИНСТВЕННО единицей измерения вида работ — своя для каждого
вида, не выбирается отдельно.
"""

UNIT_BLOCK = "эт/сек"      # блок = секция + этаж
UNIT_SECTION = "сек"       # секция целиком
UNIT_WHOLE = "компл"       # объект целиком

STATUS_PLAN = "plan"       # нет строки в work_progress
STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"
STATUSES = (STATUS_IN_PROGRESS, STATUS_DONE)

# Виды работ вне блочного контура (`шт`, `м2`, `м3`, `т`, `пог.м`, `опора`,
# `кв.эт/сек` — квартиры без Revit-выгрузки завести нечем, block-accounting.md
# §2/§9) в матрице показываются, но статус на них не ставится.
ADDRESSABLE_UNITS = (UNIT_BLOCK, UNIT_SECTION, UNIT_WHOLE)


class ProgressError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _addressing_key(unit, block_id, section_id):
    if unit == UNIT_BLOCK:
        if not block_id or section_id:
            raise ProgressError(422, "Для вида работ «%s» нужен блок (секция+этаж)." % unit)
    elif unit == UNIT_SECTION:
        if not section_id or block_id:
            raise ProgressError(422, "Для вида работ «%s» нужна секция целиком." % unit)
    elif unit == UNIT_WHOLE:
        if block_id or section_id:
            raise ProgressError(422, "Вид работ «%s» — на объект целиком, без блока/секции." % unit)
    else:
        raise ProgressError(
            422, "Вид работ с единицей «%s» вне блочного контура, статус здесь не ставится."
            % (unit or "—"))


def matrix(conn, object_id: int) -> dict:
    """Дерево видов работ (активных, не `retired_at`) с колонками блоков и
    секций и уже проставленными статусами в листьях."""
    blocks = [
        dict(row)
        for row in conn.execute(
            "SELECT b.id, b.section_id, s.code AS section_code, s.sort_order AS section_sort, "
            "b.level_id, l.name AS level_name, l.floor, l.sort_order AS level_sort "
            "FROM blocks b JOIN object_sections s ON s.id = b.section_id "
            "JOIN object_levels l ON l.id = b.level_id "
            "WHERE b.object_id = ? ORDER BY s.sort_order, l.sort_order",
            (object_id,),
        )
    ]
    sections = [
        dict(row)
        for row in conn.execute(
            "SELECT id, code, name, sort_order FROM object_sections "
            "WHERE object_id = ? ORDER BY sort_order", (object_id,))
    ]

    rows = [
        dict(row)
        for row in conn.execute(
            "SELECT id, parent_id, row_kind, code, name, unit, sort_order FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL ORDER BY sort_order",
            (object_id,),
        )
    ]
    progress = {}
    for row in conn.execute(
        "SELECT wp.work_type_id, wp.block_id, wp.section_id, wp.status "
        "FROM work_progress wp JOIN work_types wt ON wt.id = wp.work_type_id "
        "WHERE wt.object_id = ?", (object_id,),
    ):
        progress[(row["work_type_id"], row["block_id"], row["section_id"])] = row["status"]

    def cells_for(work_type_id: int, unit) -> dict:
        if unit == UNIT_BLOCK:
            return {
                b["id"]: progress.get((work_type_id, b["id"], None), STATUS_PLAN)
                for b in blocks
            }
        if unit == UNIT_SECTION:
            return {
                s["id"]: progress.get((work_type_id, None, s["id"]), STATUS_PLAN)
                for s in sections
            }
        if unit == UNIT_WHOLE:
            return {"объект": progress.get((work_type_id, None, None), STATUS_PLAN)}
        return {}

    by_id = {}
    roots = []
    for row in rows:
        node = {
            "id": row["id"], "row_kind": row["row_kind"], "code": row["code"],
            "name": row["name"], "unit": row["unit"], "children": [],
            "addressable": row["unit"] in ADDRESSABLE_UNITS,
        }
        if row["row_kind"] != "узел":
            node["cells"] = cells_for(row["id"], row["unit"])
        by_id[row["id"]] = node
        parent = by_id.get(row["parent_id"]) if row["parent_id"] else None
        (parent["children"] if parent else roots).append(node)

    return {"blocks": blocks, "sections": sections, "tree": roots}


def set_status(conn, object_id: int, user_id: int, work_type_id: int,
              block_id, section_id, status: str) -> None:
    if status not in STATUSES:
        raise ProgressError(422, "Неизвестный статус «%s»." % status)
    wt = conn.execute(
        "SELECT id, unit FROM work_types WHERE id = ? AND object_id = ? AND retired_at IS NULL",
        (work_type_id, object_id),
    ).fetchone()
    if not wt:
        raise ProgressError(404, "Вид работ не найден.")
    _addressing_key(wt["unit"], block_id, section_id)

    cur = conn.execute(
        "UPDATE work_progress SET status = ?, updated_at = datetime('now'), updated_by = ? "
        "WHERE work_type_id = ? AND block_id IS ? AND section_id IS ?",
        (status, user_id, work_type_id, block_id, section_id),
    )
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO work_progress (work_type_id, block_id, section_id, status, updated_by) "
            "VALUES (?,?,?,?,?)",
            (work_type_id, block_id, section_id, status, user_id),
        )
    conn.commit()


def block_status_summary(conn, object_id: int, block_id: int) -> dict:
    """Сводка статусов ОДНОГО блока — для карточки блока в «Модели МФР»
    (Docs/TZ.md, «Геометрия блока»). Считает только виды работ,
    адресуемые на блок (`UNIT_BLOCK`) — секция/объект целиком сюда не
    входят, у них не блок, а другая единица учёта."""
    total = conn.execute(
        "SELECT COUNT(*) FROM work_types WHERE object_id = ? AND retired_at IS NULL AND unit = ?",
        (object_id, UNIT_BLOCK),
    ).fetchone()[0]
    by_status = dict(conn.execute(
        "SELECT wp.status, COUNT(*) FROM work_progress wp "
        "JOIN work_types wt ON wt.id = wp.work_type_id "
        "WHERE wt.object_id = ? AND wt.retired_at IS NULL AND wp.block_id = ? "
        "GROUP BY wp.status", (object_id, block_id),
    ).fetchall())
    выполнено = by_status.get(STATUS_DONE, 0)
    в_работе = by_status.get(STATUS_IN_PROGRESS, 0)
    return {"всего": total, "план": total - выполнено - в_работе,
            "в_работе": в_работе, "выполнено": выполнено}


def clear_status(conn, object_id: int, work_type_id: int, block_id, section_id) -> None:
    wt = conn.execute(
        "SELECT id FROM work_types WHERE id = ? AND object_id = ?", (work_type_id, object_id),
    ).fetchone()
    if not wt:
        raise ProgressError(404, "Вид работ не найден.")
    conn.execute(
        "DELETE FROM work_progress WHERE work_type_id = ? AND block_id IS ? AND section_id IS ?",
        (work_type_id, block_id, section_id),
    )
    conn.commit()

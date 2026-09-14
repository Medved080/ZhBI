"""
Плоская «Шахматка» (2026-09-14, Docs/design/chess-flat/CLAUDE-PROMPT.md) —
развёртка здания по этажам и секциям для просмотра, массового ввода факта и
печати бланка обхода, поверх уже существующей 2D/3D «Шахматки»
(app/work_fact.py). Геометрию и проценты этот модуль не пересчитывает
заново — источник истины прежний (`app/blocks.py`, `app/work_fact.py`);
здесь только раскладка готовых данных под плоский экран и атомарная запись
пакета из нескольких блоков разом, которой у одиночного
POST .../fact-reports нет.
"""

import json
import sqlite3

from app import blocks as blocks_mod
from app import work_fact
from app.work_fact import FactError
# Приватное имя по месту объявления (`app/work_fact.py`), но «текущий
# процент операции на блоке» — один и тот же расчёт что там, что здесь:
# проверка конфликта перед пакетной записью должна сравнивать ровно с тем
# значением, что показал экран, — вторая реализация разошлась бы при первой
# же правке правила «максимальная дата, при равенстве — больший id» (тот же
# приём, что у app/block_works.py).
from app.work_fact import _current_percents


class ConflictError(Exception):
    """Кто-то другой изменил факт после того, как эти данные показал
    экран (§7.8 задания) — пакет не пишется целиком, ни одной строкой."""

    def __init__(self, conflicts: list):
        self.conflicts = conflicts
        super().__init__("Данные на сервере изменились с момента ввода.")


def layout(conn: sqlite3.Connection, object_id: int, track_code: str) -> dict:
    """Всё, что нужно плоскому экрану разом: справочник операций доски,
    секции и уровни объекта (в порядке отображения) и по каждому
    существующему блоку — применимые операции этой доски с их текущим
    процентом (остальные операции доски у блока — «не применяется», см.
    `work_fact.board_block_values`)."""
    ops = work_fact.board_ops(conn, object_id, track_code)
    if not ops:
        raise FactError(404, "Доска «%s» не найдена или в ней нет операций." % track_code)
    sections = blocks_mod.list_sections(conn, object_id)
    # Уровни объекта хранятся по возрастанию отметки/номера (sort_order) —
    # развёртке нужен обратный порядок, сверху вниз (см. проверку на
    # обезличенной копии: кровля/верхние этажи — наибольший sort_order).
    levels = list(reversed(blocks_mod.list_levels(conn, object_id)))
    geometry = blocks_mod.list_blocks(conn, object_id)
    board = work_fact.board_block_values(conn, object_id, track_code)

    out_blocks = []
    for b in geometry:
        entry = board.get(b["id"])
        percents = {op["id"]: op["percent"] for op in entry["ops"]} if entry else {}
        out_blocks.append({
            "id": b["id"], "section_id": b["section_id"], "level_id": b["level_id"],
            "percents": percents,
        })
    obj = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
    return {
        "object_name": obj["name"] if obj else "",
        "ops": ops,
        "sections": [
            {"id": s["id"], "code": s["code"], "name": s["name"], "sort_order": s["sort_order"]}
            for s in sections
        ],
        "levels": [
            {"id": l["id"], "floor": l["floor"], "kind": l["kind"], "name": l["name"],
             "sort_order": l["sort_order"]}
            for l in levels
        ],
        "blocks": out_blocks,
    }


def commit_batch(conn: sqlite3.Connection, object_id: int, user_id: int, *,
                 track_code: str, report_date: str, idempotency_key: str,
                 items: list) -> dict:
    """Пакетная запись факта плоской «Шахматки» — весь пакет атомарно, или
    ни одной новой/дополненной строки (§7.6 задания). Каждый затронутый блок
    получает СВОЙ документ на `report_date` (новый или уже существующий на
    эту дату): в него добавляются/правятся ТОЛЬКО введённые операции — уже
    записанные в этом документе строки ДРУГИХ операций (в т.ч. с других
    досок) сохраняются как есть, а не переписываются скрытым текущим
    значением (§7.5 — иначе полный слепок `work_fact.save_report`
    незаметно стёр бы соседние операции того же отчёта)."""
    if not report_date:
        raise FactError(422, "Не указана дата факта.")
    if not items:
        raise FactError(422, "Нет заполненных значений для записи.")
    if not idempotency_key:
        raise FactError(422, "Не передан ключ идемпотентности.")

    # Повтор того же запроса (таймаут, повторная отправка браузером) —
    # отдаём уже сохранённый результат, вторая транзакция не открывается.
    existing_batch = conn.execute(
        "SELECT result_json FROM chess_flat_batches WHERE object_id = ? AND idempotency_key = ?",
        (object_id, idempotency_key),
    ).fetchone()
    if existing_batch:
        return json.loads(existing_batch["result_json"])

    board_op_ids = {o["id"] for o in work_fact.board_ops(conn, object_id, track_code)}
    if not board_op_ids:
        raise FactError(404, "Доска «%s» не найдена или в ней нет операций." % track_code)

    block_ids = sorted({it["block_id"] for it in items})
    placeholders = ",".join("?" * len(block_ids))
    real_blocks = {
        r["id"] for r in conn.execute(
            "SELECT id FROM blocks WHERE object_id = ? AND id IN (%s)" % placeholders,
            (object_id, *block_ids),
        )
    }
    missing = set(block_ids) - real_blocks
    if missing:
        raise FactError(404, "Блоки не найдены на объекте: %s." % sorted(missing))

    selected_by_block: dict = {}
    current_by_block: dict = {}
    by_block: dict = {}
    conflicts = []
    for it in items:
        block_id, wt_id, percent = it["block_id"], it["work_type_id"], it["percent"]
        if not isinstance(percent, int) or not (0 <= percent <= 100):
            raise FactError(422, "Процент вне 0..100 у блока %s, операции %s." % (block_id, wt_id))
        if wt_id not in board_op_ids:
            raise FactError(422, "Операция %s не входит в доску «%s»." % (wt_id, track_code))
        if block_id not in selected_by_block:
            selected_by_block[block_id] = set(
                work_fact.block_settings(conn, object_id, block_id)["selected"])
            current_by_block[block_id] = _current_percents(conn, block_id)
        if wt_id not in selected_by_block[block_id]:
            raise FactError(422, "Операция %s не применяется к блоку %s." % (wt_id, block_id))
        actual = current_by_block[block_id].get(wt_id, 0)
        expected = it.get("expected_percent", 0)
        if actual != expected:
            conflicts.append({
                "block_id": block_id, "work_type_id": wt_id,
                "expected": expected, "actual": actual,
            })
        by_block.setdefault(block_id, {})[wt_id] = percent

    if conflicts:
        raise ConflictError(conflicts)

    # Ни одного conn.commit() до этой точки (save_report вызывается с
    # commit=False) — пакет копится в ОДНОЙ транзакции этого соединения,
    # атомарность обеспечивает единственный commit ниже.
    report_ids = {}
    for block_id, touched in by_block.items():
        existing_report = conn.execute(
            "SELECT id FROM work_fact_reports WHERE object_id = ? AND block_id = ? "
            "AND report_date = ?",
            (object_id, block_id, report_date),
        ).fetchone()
        old_items = {}
        if existing_report:
            old_items = work_fact.get_report(conn, object_id, block_id, existing_report["id"])["items"]
        merged = {**old_items, **touched}
        report_id = work_fact.save_report(
            conn, object_id, user_id, block_id,
            existing_report["id"] if existing_report else None,
            report_date, merged, commit=False,
        )
        report_ids[block_id] = report_id

    result = {
        "report_date": report_date,
        "items_count": len(items),
        "blocks_count": len(by_block),
        "reports": report_ids,
    }
    conn.execute(
        "INSERT INTO chess_flat_batches (object_id, idempotency_key, track_code, report_date, "
        "created_by, result_json) VALUES (?,?,?,?,?,?)",
        (object_id, idempotency_key, track_code, report_date, user_id, json.dumps(result)),
    )
    conn.commit()
    return result

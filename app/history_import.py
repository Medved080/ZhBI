"""
Импорт истории статусов из .xlsx (обратная операция к export.build_history_xlsx)
— переносит прогресс поставки/монтажа на другой сервер, где тот же чертёж уже
загружен (тот же source_file, те же dxf_handle).

Сопоставление элементов — по (source_file, dxf_handle), как и при обычном
upsert элементов. Элементы, которых нет в целевой БД, пропускаются и
попадают в сводку как unmatched — заказчик должен сначала загрузить тот же
DXF на новом сервере.

Режим "replace" — существующая история сопоставленных элементов удаляется
перед импортом. Режим "merge" — история дополняется, но не создаёт дубли:
если у элемента уже есть запись с тем же статусом в ту же дату, строка из
файла пропускается (см. Docs/backlog.md п.3).
"""

import io

from openpyxl import load_workbook

from app.models import STATUS_LABELS_RU

STATUS_LABEL_TO_VALUE = {label: status.value for status, label in STATUS_LABELS_RU.items()}

REQUIRED_HEADERS = ["DXF handle", "Статус", "Изменено"]


class HistoryImportError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def parse_history_xlsx(content: bytes):
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception:
        raise HistoryImportError(422, "Файл повреждён или не является корректным .xlsx")

    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise HistoryImportError(422, "Пустой файл")

    header = [str(h).strip() if h is not None else "" for h in header]
    missing = [h for h in REQUIRED_HEADERS if h not in header]
    if missing:
        raise HistoryImportError(
            422, f"В файле нет обязательных колонок: {', '.join(missing)}"
        )
    col = {name: idx for idx, name in enumerate(header)}

    def get(row, name):
        idx = col.get(name)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    parsed = []
    for row in rows:
        dxf_handle = get(row, "DXF handle")
        status_label = get(row, "Статус")
        changed_at = get(row, "Изменено")
        if not dxf_handle or not status_label or not changed_at:
            continue
        status = STATUS_LABEL_TO_VALUE.get(str(status_label).strip())
        if status is None:
            continue
        parsed.append(
            {
                "dxf_handle": str(dxf_handle),
                "status": status,
                "changed_at": str(changed_at),
                "changed_by": get(row, "Кто изменил") or None,
                "comment": get(row, "Комментарий") or None,
            }
        )

    return parsed


def import_history(conn, source_file: str, rows: list, mode: str):
    if mode not in ("replace", "merge"):
        raise HistoryImportError(422, "mode должен быть 'replace' или 'merge'")

    handles = sorted({r["dxf_handle"] for r in rows})
    element_ids = {}
    for handle in handles:
        found = conn.execute(
            "SELECT id FROM elements WHERE source_file = ? AND dxf_handle = ?",
            (source_file, handle),
        ).fetchone()
        if found:
            element_ids[handle] = found["id"]

    unmatched_handles = [h for h in handles if h not in element_ids]

    if mode == "replace":
        matched_ids = list(element_ids.values())
        if matched_ids:
            placeholders = ",".join("?" * len(matched_ids))
            conn.execute(
                f"DELETE FROM status_history WHERE element_id IN ({placeholders})", matched_ids
            )

    inserted = skipped_duplicate = skipped_unmatched = 0
    touched_element_ids = set()

    for row in rows:
        element_id = element_ids.get(row["dxf_handle"])
        if element_id is None:
            skipped_unmatched += 1
            continue

        date_part = row["changed_at"][:10]
        dup = conn.execute(
            "SELECT id FROM status_history WHERE element_id = ? AND status = ? "
            "AND substr(changed_at, 1, 10) = ?",
            (element_id, row["status"], date_part),
        ).fetchone()
        if dup:
            skipped_duplicate += 1
            continue

        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_at, changed_by, comment) "
            "VALUES (?, ?, ?, ?, ?)",
            (element_id, row["status"], row["changed_at"], row["changed_by"], row["comment"]),
        )
        inserted += 1
        touched_element_ids.add(element_id)

    for element_id in touched_element_ids:
        latest = conn.execute(
            "SELECT status FROM status_history WHERE element_id = ? ORDER BY changed_at DESC LIMIT 1",
            (element_id,),
        ).fetchone()
        if latest:
            conn.execute(
                "UPDATE elements SET current_status = ?, updated_at = datetime('now') WHERE id = ?",
                (latest["status"], element_id),
            )

    conn.commit()

    return {
        "matched_elements": len(element_ids),
        "unmatched_elements": len(unmatched_handles),
        "unmatched_handles": unmatched_handles[:20],
        "inserted": inserted,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unmatched": skipped_unmatched,
    }

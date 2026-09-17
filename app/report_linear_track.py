"""
Отчёт «Линейный трек» (живой запрос пользователя, 2026-09-17) — полный
список позиций справочника видов работ (WBS) объекта, БЕЗ привязки к
блоку/секции: то, что не попадает в «График работ по блокам»
(app/report_block_schedule.py, источник — только `block_works`, то есть
только операции с единицей `эт/сек`/`кв.эт/сек`). По алгоритму «Шахматки»
остальные единицы измерения справочника (`компл`, `сек`, `шт`, `м2`, `м3`,
`т`, `пог.м`, `опора`, вехи без единицы) в расчёт графика не попадают —
здесь они возвращаются в вид простого списка.

Пока БЕЗ прогресса, статуса и сроков (решение пользователя, 2026-09-17):
учёт прогресса по этим позициям и диаграмма Ганта — отдельная будущая
доработка. Отбор блочных операций (`block_works`/Шахматка) этим отчётом не
затрагивается и не меняется.
"""

from app import work_fact

_WBS_LEVELS = 4  # WBS 2..5 — тот же приём, что app/block_bulk_edit.py::_wbs_parts


def _wbs_parts(path: str) -> list:
    parts = (path or "").split(" / ")[1:]  # уровень 1 (корень справочника) в столбцы не идёт
    return (parts + [None] * _WBS_LEVELS)[:_WBS_LEVELS]


def build_linear_track_report(conn, object_id: int) -> dict:
    track_names = {t["код"]: t["название"] for t in work_fact.all_planning_tracks(conn, object_id)}

    rows = conn.execute(
        "SELECT id, row_kind, code, unit, note, planning_track_code, path "
        "FROM work_types WHERE object_id = ? AND retired_at IS NULL "
        "AND row_kind IN ('оп', 'веха') ORDER BY sort_order",
        (object_id,),
    ).fetchall()

    items = []
    for r in rows:
        track_code = r["planning_track_code"]
        items.append({
            "id": r["id"], "row_kind": r["row_kind"], "code": r["code"],
            "wbs": _wbs_parts(r["path"]), "unit": r["unit"], "note": r["note"],
            "track_code": track_code,
            "track_name": track_names.get(track_code, track_code) if track_code else None,
        })

    return {"title": "Линейный трек", "object_id": object_id, "rows": items, "count": len(items)}


# ---------------------------------------------------------------- XLSX

_XLSX_COLUMNS = [
    ("WBS, 2 уровень", 30), ("WBS, 3 уровень", 30), ("WBS, 4 уровень", 30), ("WBS, 5 уровень", 34),
    ("Код", 14), ("Ед. изм.", 10), ("Трек планирования", 22), ("Примечание", 34),
]


def build_linear_track_xlsx(report: dict, object_name: str) -> bytes:
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Линейный трек"
    ws.append([object_name])
    ws.cell(row=1, column=1).font = Font(bold=True, size=13)
    ws.append([f"Позиций: {report['count']}"])
    ws.append([])
    header_row = 4
    ws.append([c for c, _ in _XLSX_COLUMNS])
    for i, (_, width) in enumerate(_XLSX_COLUMNS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
        ws.cell(row=header_row, column=i).font = Font(bold=True)
    ws.freeze_panes = f"A{header_row + 1}"
    ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(_XLSX_COLUMNS))}{header_row}"

    for item in report["rows"]:
        ws.append([
            *item["wbs"], item["code"] or "", item["unit"] or "",
            item["track_name"] or "", item["note"] or "",
        ])

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()

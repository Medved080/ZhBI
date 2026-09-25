"""План и документы факта МФР по объекту для операций без блочной единицы."""

import hashlib
import json
from datetime import date

from app.work_progress import BLOCK_UNITS


class ObjectWorkError(Exception):
    def __init__(self, code, message):
        self.status_code = code
        self.message = message
        super().__init__(message)


def _date(value):
    if value is None:
        return True
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _rev(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()[:12]


def options(conn, object_id):
    placeholders = ",".join("?" for _ in BLOCK_UNITS)
    return [dict(row) for row in conn.execute(
        "SELECT id, path, name, unit, code FROM work_types WHERE object_id = ? "
        "AND retired_at IS NULL AND row_kind = 'оп' AND unit IS NOT NULL "
        f"AND unit NOT IN ({placeholders}) ORDER BY sort_order, id",
        (object_id, *BLOCK_UNITS),
    )]


def _rows(conn, object_id):
    return [dict(row) for row in conn.execute(
        "SELECT ow.*, wt.path, wt.name, wt.unit FROM object_works ow "
        "JOIN work_types wt ON wt.id = ow.work_type_id "
        "WHERE ow.object_id = ? ORDER BY wt.sort_order, ow.id", (object_id,),
    )]


def state(conn, object_id):
    works = _rows(conn, object_id)
    current = {}
    for row in conn.execute(
        "SELECT i.object_work_id, i.percent FROM object_fact_items i "
        "JOIN object_fact_reports r ON r.id = i.report_id "
        "WHERE r.object_id = ? ORDER BY r.report_date, r.id", (object_id,),
    ):
        current[row["object_work_id"]] = row["percent"]
    active = [dict(row, percent=current.get(row["id"], 0)) for row in works if row["retired_at"] is None]
    reports = [dict(row) for row in conn.execute(
        "SELECT id, report_date, created_at, updated_at FROM object_fact_reports "
        "WHERE object_id = ? ORDER BY report_date DESC, id DESC", (object_id,),
    )]
    return {"options": options(conn, object_id), "works": active, "reports": reports,
            "rev": _rev([(r["id"], r["work_type_id"], r["retired_at"]) for r in works])}


def save_settings(conn, object_id, user_id, chosen_ids, expected):
    if not isinstance(chosen_ids, list) or len(chosen_ids) != len(set(chosen_ids)):
        raise ObjectWorkError(422, "Список видов работ некорректен")
    valid = {r["id"] for r in options(conn, object_id)}
    if not set(chosen_ids) <= valid:
        raise ObjectWorkError(422, "Вид работы не относится к текущему объекту или не подходит для учёта по объекту")
    if state(conn, object_id)["rev"] != expected:
        raise ObjectWorkError(409, "Состав работ объекта изменился. Обновите форму и повторите выбор")
    existing = {r["work_type_id"]: r for r in _rows(conn, object_id)}
    wanted = set(chosen_ids)
    for wt_id in wanted:
        row = existing.get(wt_id)
        if row is None:
            conn.execute("INSERT INTO object_works (object_id, work_type_id, created_by, updated_by) VALUES (?, ?, ?, ?)",
                         (object_id, wt_id, user_id, user_id))
        elif row["retired_at"] is not None:
            conn.execute("UPDATE object_works SET retired_at = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ?",
                         (user_id, row["id"]))
    for wt_id, row in existing.items():
        if wt_id in wanted or row["retired_at"] is not None:
            continue
        has_fact = conn.execute("SELECT 1 FROM object_fact_items WHERE object_work_id = ? LIMIT 1", (row["id"],)).fetchone()
        if has_fact or any(row[key] for key in ("plan_start", "plan_end", "forecast_start", "forecast_end", "note")):
            conn.execute("UPDATE object_works SET retired_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?",
                         (user_id, row["id"]))
        else:
            conn.execute("DELETE FROM object_works WHERE id = ?", (row["id"],))
    conn.commit()


def save_dates(conn, object_id, work_id, user_id, values, expected):
    row = conn.execute("SELECT * FROM object_works WHERE id = ? AND object_id = ? AND retired_at IS NULL",
                       (work_id, object_id)).fetchone()
    if not row:
        raise ObjectWorkError(404, "Работа объекта не найдена")
    keys = ("plan_start", "plan_end", "forecast_start", "forecast_end")
    if expected != _rev([row[key] for key in (*keys, "note", "updated_at")]):
        raise ObjectWorkError(409, "Сроки работы изменились. Обновите форму")
    if any(key not in values or not _date(values[key]) for key in keys):
        raise ObjectWorkError(422, "Проверьте даты работы")
    if any(values[start] and values[end] and values[start] > values[end]
           for start, end in (("plan_start", "plan_end"), ("forecast_start", "forecast_end"))):
        raise ObjectWorkError(422, "Начало не может быть позже окончания")
    note = values.get("note", "")
    if not isinstance(note, str) or len(note) > 4000:
        raise ObjectWorkError(422, "Примечание слишком длинное")
    conn.execute("UPDATE object_works SET plan_start=?, plan_end=?, forecast_start=?, forecast_end=?, note=?, "
                 "updated_at=strftime('%Y-%m-%d %H:%M:%f','now'), updated_by=? WHERE id=?",
                 (*(values[key] for key in keys), note, user_id, work_id))
    conn.commit()


def work_rev(row):
    return _rev([row[key] for key in ("plan_start", "plan_end", "forecast_start", "forecast_end", "note", "updated_at")])


def report(conn, object_id, report_id):
    row = conn.execute("SELECT * FROM object_fact_reports WHERE id = ? AND object_id = ?", (report_id, object_id)).fetchone()
    if not row:
        raise ObjectWorkError(404, "Документ факта объекта не найден")
    items = {r["object_work_id"]: r["percent"] for r in conn.execute(
        "SELECT object_work_id, percent FROM object_fact_items WHERE report_id = ?", (report_id,))}
    data = dict(row)
    data["items"] = items
    data["rev"] = _rev([data["report_date"], data["updated_at"], sorted(items.items())])
    return data


def save_report(conn, object_id, user_id, report_id, report_date, items, expected=None):
    if not _date(report_date) or report_date is None:
        raise ObjectWorkError(422, "Неверная дата факта")
    if not isinstance(items, dict) or not items:
        raise ObjectWorkError(422, "Выберите работы для отчёта")
    active = {r["id"] for r in _rows(conn, object_id) if r["retired_at"] is None}
    if any(not isinstance(k, int) or k not in active or isinstance(v, bool) or
           not isinstance(v, int) or not 0 <= v <= 100 for k, v in items.items()):
        raise ObjectWorkError(422, "Факт должен содержать только работы текущего объекта с процентом 0–100")
    old = report(conn, object_id, report_id) if report_id is not None else None
    if old and expected != old["rev"]:
        raise ObjectWorkError(409, "Документ факта изменился. Обновите форму")
    if old:
        conn.execute("UPDATE object_fact_reports SET report_date=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now'), updated_by=? WHERE id=?",
                     (report_date, user_id, report_id))
        conn.execute("DELETE FROM object_fact_items WHERE report_id = ? AND object_work_id IN "
                     "(SELECT id FROM object_works WHERE object_id = ? AND retired_at IS NULL)", (report_id, object_id))
    else:
        report_id = conn.execute("INSERT INTO object_fact_reports (object_id, report_date, created_by, updated_by) VALUES (?, ?, ?, ?)",
                                 (object_id, report_date, user_id, user_id)).lastrowid
    conn.executemany("INSERT INTO object_fact_items (report_id, object_work_id, percent) VALUES (?, ?, ?)",
                     [(report_id, work_id, value) for work_id, value in items.items()])
    conn.commit()
    return report_id

"""Atomic V2 element form: element fields, current schedule dates and installation plan.

Uses existing tables and shared field/contract/date rules. The revision covers
the values shown in the form and the latest schedule version, under one lock.
"""
import hashlib
import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import activity
from app.access import assert_object_feature
from app.auth import get_current_user
from app.contracts import enrich_element_row
from app.db import begin_write, get_connection, touch_elements
from app.element_dates import set_planned_installation_dates
from app.element_fields import EDITABLE_FIELDS, FIELD_LABELS, FieldError, check_subtype, coerce_field, contract_mismatch, write_fields
from app.schedule_versions import latest_current_id

router = APIRouter()
FORECAST_FIELDS = {"forecast_start": "smr_start_date", "forecast_end": "smr_end_date"}
FORM_FIELDS = (*EDITABLE_FIELDS, *FORECAST_FIELDS, "planned_installation_date")
LABELS = {**FIELD_LABELS, "forecast_start": "Начало СМР актуализированное",
          "forecast_end": "Завершение СМР актуализированное", "planned_installation_date": "Плановая дата монтажа"}


class FormUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: str = Field(min_length=64, max_length=64)
    changes: dict = Field(min_length=1)


def _element(conn, element_id, user):
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Элемент не найден")
    assert_object_feature(conn, user, row["object_id"], "element_fields", "write")
    return row


def _snapshot(conn, row):
    version_id = latest_current_id(conn, row["object_id"])
    dates = conn.execute(
        "SELECT smr_start_date, smr_end_date FROM schedule_version_dates WHERE version_id = ? AND element_id = ?",
        (version_id, row["id"]),
    ).fetchone()
    state = {k: row[k] for k in (*EDITABLE_FIELDS, "planned_installation_date", "object_id", "current_status", "contract_id")}
    state.update({k: dates[column] if dates else None for k, column in FORECAST_FIELDS.items()})
    state["schedule_version_id"] = version_id
    revision = hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    result = dict(row)
    enrich_element_row(conn, result)
    result.update({k: state[k] for k in FORECAST_FIELDS})
    result.update(schedule_version_id=version_id, form_revision=revision)
    return result


def _date(value):
    if value is None or value == "":
        return None
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError
        return value
    except (TypeError, ValueError):
        raise HTTPException(400, "Ожидается существующая дата в формате ГГГГ-ММ-ДД")


@router.get("/fields/{element_id}")
def get_form(element_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        conn.execute("BEGIN")
        return _snapshot(conn, _element(conn, element_id, user))
    finally:
        conn.close()


@router.patch("/fields/{element_id}")
def update_form(element_id: int, body: FormUpdate, user=Depends(get_current_user)):
    unknown = set(body.changes) - set(FORM_FIELDS)
    if unknown:
        raise HTTPException(400, "Эти поля не правятся здесь: " + ", ".join(sorted(unknown)))
    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        row = _element(conn, element_id, user)
        before = _snapshot(conn, row)
        if before["form_revision"] != body.expected_revision:
            raise HTTPException(409, "Изделие или актуализированный график изменились. Закройте и откройте форму заново; введённые значения пока сохранены в форме.")
        try:
            values = {k: coerce_field(k, v) if k in EDITABLE_FIELDS else _date(v)
                      for k, v in body.changes.items()}
        except FieldError as exc:
            raise HTTPException(400, str(exc))
        values = {k: v for k, v in values.items() if v != before[k]}
        fields = {k: v for k, v in values.items() if k in EDITABLE_FIELDS}
        if "element_type" in fields or "subtype" in fields:
            error = check_subtype(conn, fields.get("element_type", row["element_type"]),
                                  fields.get("subtype", row["subtype"]), row["object_id"])
            if error:
                raise HTTPException(400, error)
        if "element_type" in fields or "mark" in fields:
            error = contract_mismatch(conn, row["contract_id"], fields.get("element_type", row["element_type"]),
                                      fields.get("mark", row["mark"]))
            if error:
                raise HTTPException(409, error + ". Сначала исправьте привязку к контракту.")
        forecast = {k: v for k, v in values.items() if k in FORECAST_FIELDS}
        version_id = before["schedule_version_id"]
        if forecast:
            if row["object_id"] is None:
                raise HTTPException(409, "Для актуализации СМР изделие должно быть привязано к объекту")
            assert_object_feature(conn, user, row["object_id"], "schedule", "write")
            start = forecast.get("forecast_start", before["forecast_start"])
            end = forecast.get("forecast_end", before["forecast_end"])
            if start and end and start > end:
                raise HTTPException(400, "Актуализированное завершение СМР не может быть раньше начала")
        if "planned_installation_date" in values:
            assert_object_feature(conn, user, row["object_id"], "planned_date", "write")
            set_planned_installation_dates(conn, [element_id], values["planned_installation_date"], user)
        write_fields(conn, element_id, row, fields)
        if forecast:
            if version_id is None:
                version_id = conn.execute(
                    "INSERT INTO schedule_versions (object_id, kind, title, origin, loaded_by, note) "
                    "VALUES (?, 'current', 'Ручная актуализация', 'manual', ?, 'Даты из формы изделия')",
                    (row["object_id"], user["id"]),
                ).lastrowid
            conn.execute(
                "INSERT INTO schedule_version_dates (version_id, element_id, smr_start_date, smr_end_date) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(version_id, element_id) DO UPDATE SET smr_start_date=excluded.smr_start_date, smr_end_date=excluded.smr_end_date",
                (version_id, element_id, start, end),
            )
        if values:
            touch_elements(conn, [element_id])
            activity.log("element_edit", user=user, entity_type="element", entity_id=element_id,
                         element_type=row["element_type"], mark=row["mark"],
                         old_value="; ".join(f"{LABELS[k]}: {before[k] or '—'}" for k in values)[:500],
                         new_value="; ".join(f"{LABELS[k]}: {v or '—'}" for k, v in values.items())[:500],
                         details={"changes": {k: {"old": before[k], "new": v} for k, v in values.items()},
                                  "schedule_version_id": version_id})
        result = _snapshot(conn, conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone())
        conn.commit()
        activity.defer_flush(events)
        return result
    finally:
        conn.close()
        activity.defer_end(events)

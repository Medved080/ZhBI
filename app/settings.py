"""
Общие настройки приложения (ключ-значение, таблица app_settings) — сейчас
единственная настройка — порог "красной" инфо-плашки в днях (см.
Docs/backlog.md, "Контрактация 2.0"). Серверная, не персональная —
значение одно на всех менеджеров, в отличие от клиентских Вид-переключателей
(state.zoneVisibility/labelVisibility/infoPlateVisible), которые остаются
только в браузере.
"""

import json
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

# До этапа D эти настройки хранятся ОДНОЙ записью на всю систему
# (app_settings, report_notes), поэтому правит их администратор
# СЕРВИСА. Отдать их «админу объекта» сейчас значило бы дать ему
# менять настройки всех объектов сразу — это не разграничение, а
# новая дыра. Переедут внутрь объекта вместе с таблицами.
from app.access import require_system_admin
from app.auth import get_current_user, require_admin
from app.db import get_connection

router = APIRouter(prefix="/settings", tags=["settings"])

INFO_PLATE_THRESHOLD_KEY = "info_plate_late_threshold_days"


def get_setting(conn, key: str, default: str = None):
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


# ---------- карточка объекта и ручные блоки ежедневного отчёта ----------
#
# Всё, чего нет и не может быть в данных чертежа: описание объекта,
# контрольные даты и три списка, которые ведёт ответственный руками
# (ключевые события, задачи, открытые вопросы). Хранится одним JSON в
# app_settings, а не отдельными таблицами: это единственная запись на всю
# систему, у неё нет ни связей, ни истории, ни поиска — таблица со строго
# одной строкой была бы церемонией без пользы.
PROJECT_CARD_KEY = "project_card"

PROJECT_CARD_DEFAULT = {
    "title": "",              # «Промышленный корпус на земельных участках…»
    "montage_deadline": None,  # окончание монтажа изделий — сноска под таблицей
    "delivery_deadline": None,  # окончание поставки изделий
    "milestones": [],          # [{"label": "Завершение 1 Захватки", "date": "2026-09-13"}]
    "key_events": [],          # списки строк — «Ключевые события»
    "key_tasks": [],           # «Ключевые задачи»
    "open_questions": [],      # «Открытые вопросы»
}


def get_project_card(conn) -> dict:
    raw = get_setting(conn, PROJECT_CARD_KEY)
    if not raw:
        return dict(PROJECT_CARD_DEFAULT)
    try:
        stored = json.loads(raw)
    except ValueError:
        return dict(PROJECT_CARD_DEFAULT)
    # Слияние с умолчаниями, а не подмена: карточка, сохранённая до
    # появления нового поля, не должна ронять отчёт отсутствующим ключом.
    # И наоборот — ключи, которых в умолчаниях БОЛЬШЕ нет (поле убрали),
    # отбрасываются, чтобы устаревшие данные не тянулись в отчёт и не
    # накапливались в хранилище.
    return {k: stored.get(k, v) for k, v in PROJECT_CARD_DEFAULT.items()}


class ProjectCardIn(BaseModel):
    title: str = ""
    montage_deadline: Optional[str] = None
    delivery_deadline: Optional[str] = None
    milestones: list[dict] = []
    key_events: list[str] = []
    key_tasks: list[str] = []
    open_questions: list[str] = []


@router.get("/project-card")
def read_project_card(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        return get_project_card(conn)
    finally:
        conn.close()


@router.put("/project-card")
def write_project_card(body: ProjectCardIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        set_setting(conn, PROJECT_CARD_KEY, json.dumps(body.model_dump(), ensure_ascii=False))
        conn.commit()
        return get_project_card(conn)
    finally:
        conn.close()


class InfoPlateSettingsOut(BaseModel):
    late_threshold_days: int


class InfoPlateSettingsIn(BaseModel):
    late_threshold_days: int


@router.get("/info-plate", response_model=InfoPlateSettingsOut)
def get_info_plate_settings(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        value = get_setting(conn, INFO_PLATE_THRESHOLD_KEY, "0")
        return {"late_threshold_days": int(value)}
    finally:
        conn.close()


@router.put("/info-plate", response_model=InfoPlateSettingsOut)
def set_info_plate_settings(body: InfoPlateSettingsIn, admin: sqlite3.Row = Depends(require_system_admin)):
    if body.late_threshold_days < 0:
        raise HTTPException(status_code=400, detail="Порог не может быть отрицательным")
    conn = get_connection()
    try:
        set_setting(conn, INFO_PLATE_THRESHOLD_KEY, str(body.late_threshold_days))
        conn.commit()
        return {"late_threshold_days": body.late_threshold_days}
    finally:
        conn.close()


# ---------- редакции текстовых блоков отчёта (на дату) ----------
#
# «Ключевые события», «Ключевые задачи», «Открытые вопросы» меняются по
# ходу стройки, и отчёт за прошлую дату должен показывать то, что было
# актуально ТОГДА, а не сегодняшний текст. Поэтому они хранятся редакциями
# с датой вступления в силу, а не одним значением.

NOTE_FIELDS = ("key_events", "key_tasks", "open_questions")


def _row_to_notes(row) -> dict:
    out = {"effective_date": row["effective_date"], "updated_at": row["updated_at"],
           "updated_by": row["updated_by"]}
    for f in NOTE_FIELDS:
        try:
            out[f] = json.loads(row[f]) or []
        except (ValueError, TypeError):
            out[f] = []
    return out


def get_notes_for_date(conn, on_date: str) -> dict:
    """Редакция, действующая НА дату: самая поздняя с effective_date <= date.
    Не «за этот день», а «последняя действовавшая» — блоки обновляют не
    каждый день, и отчёт за среду должен показывать текст, введённый в
    понедельник."""
    row = conn.execute(
        "SELECT * FROM report_notes WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1",
        (on_date[:10],),
    ).fetchone()
    if row is None:
        return {f: [] for f in NOTE_FIELDS} | {"effective_date": None, "updated_at": None, "updated_by": None}
    return _row_to_notes(row)


def list_notes(conn) -> list:
    return [_row_to_notes(r) for r in conn.execute(
        "SELECT * FROM report_notes ORDER BY effective_date DESC").fetchall()]


class ReportNotesIn(BaseModel):
    effective_date: str
    key_events: list[str] = []
    key_tasks: list[str] = []
    open_questions: list[str] = []


@router.get("/report-notes")
def read_report_notes(on_date: Optional[str] = None, user: sqlite3.Row = Depends(get_current_user)):
    """Без on_date — весь список редакций (для формы ведения). С on_date —
    одна редакция, действующая на эту дату (для отчёта)."""
    conn = get_connection()
    try:
        if on_date:
            return get_notes_for_date(conn, on_date)
        return {"revisions": list_notes(conn)}
    finally:
        conn.close()


@router.put("/report-notes")
def write_report_notes(body: ReportNotesIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO report_notes (effective_date, key_events, key_tasks, open_questions, updated_by) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(effective_date) DO UPDATE SET key_events=excluded.key_events, "
            "key_tasks=excluded.key_tasks, open_questions=excluded.open_questions, "
            "updated_at=datetime('now'), updated_by=excluded.updated_by",
            (body.effective_date[:10],
             json.dumps(body.key_events, ensure_ascii=False),
             json.dumps(body.key_tasks, ensure_ascii=False),
             json.dumps(body.open_questions, ensure_ascii=False),
             f"{admin['last_name']} {admin['first_name']}".strip() or admin["domain_login"]),
        )
        conn.commit()
        return {"revisions": list_notes(conn)}
    finally:
        conn.close()


@router.delete("/report-notes/{effective_date}", status_code=204)
def delete_report_notes(effective_date: str, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM report_notes WHERE effective_date = ?", (effective_date[:10],))
        conn.commit()
    finally:
        conn.close()

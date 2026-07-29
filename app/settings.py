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
    "subtitle": "о статусе производства работ и поставке ЖБ изделий на объекте строительства:",
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
    return dict(PROJECT_CARD_DEFAULT) | stored


class ProjectCardIn(BaseModel):
    title: str = ""
    subtitle: str = ""
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
def write_project_card(body: ProjectCardIn, admin: sqlite3.Row = Depends(require_admin)):
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
def set_info_plate_settings(body: InfoPlateSettingsIn, admin: sqlite3.Row = Depends(require_admin)):
    if body.late_threshold_days < 0:
        raise HTTPException(status_code=400, detail="Порог не может быть отрицательным")
    conn = get_connection()
    try:
        set_setting(conn, INFO_PLATE_THRESHOLD_KEY, str(body.late_threshold_days))
        conn.commit()
        return {"late_threshold_days": body.late_threshold_days}
    finally:
        conn.close()

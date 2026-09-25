"""HTTP-доступ к черновикам и редакциям кранов/стоянок ЖБИ."""

import json
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import assert_object_feature
from app.auth import format_display_name, get_current_user
from app.crane_zone_editor import ZoneDraftError, stance_containment_issues
from app.crane_zone_service import (
    create_draft, preview_draft, publish_draft, update_draft,
)
from app.db import get_connection

router = APIRouter(prefix="/objects/{object_id}/crane-zone-versions", tags=["crane-zone-versions"])


class DraftPatch(BaseModel):
    edit_token: int
    zones: list[dict]
    overrides: dict
    note: str = ""


class PublishIn(BaseModel):
    edit_token: int
    effective_date: str


def _check(conn, user, object_id: int, level: str) -> None:
    row = conn.execute("SELECT kind FROM objects WHERE id = ?", (object_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    if row["kind"] != "zhbi":
        raise HTTPException(status_code=400, detail="Крановые зоны доступны только для ЖБИ-объекта")
    assert_object_feature(conn, user, object_id, "zones", level)


def _public_error(exc: ZoneDraftError):
    raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("")
def list_versions(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "read")
        return [dict(row) for row in conn.execute(
            "SELECT id, revision_no, kind, effective_date, known_from, created_at, "
            "activated_at, author_name, note, assignment_count "
            "FROM crane_zone_versions WHERE object_id = ? ORDER BY revision_no DESC",
            (object_id,),
        )]
    finally:
        conn.close()


@router.get("/scene")
def zone_scene(object_id: int, version_id: Optional[int] = None,
               user: sqlite3.Row = Depends(get_current_user)):
    """Точки схемы с действующими либо сохранёнными в редакции назначениями.

    Координаты изделия остаются текущими: версия хранит принадлежность, а не
    геометрический снимок каждого изделия. Снятые с учёта изделия редакции
    остаются видны для проверки её полного состава.
    """
    conn = get_connection()
    try:
        _check(conn, user, object_id, "read")
        if version_id is not None:
            if conn.execute(
                "SELECT 1 FROM crane_zone_versions WHERE id = ? AND object_id = ?",
                (version_id, object_id),
            ).fetchone() is None:
                raise HTTPException(status_code=404, detail="Редакция не найдена")
            rows = conn.execute(
                "SELECT e.id, e.element_uid, e.element_type, e.mark, e.x, e.y, "
                "e.elevation_mm, a.crane_zone_id AS zone_crane_id, "
                "a.stance_zone_id AS zone_stance_id, e.current_status, e.is_current "
                "FROM crane_zone_version_assignments a "
                "JOIN elements e ON e.id = a.element_id "
                "WHERE a.version_id = ? AND e.object_id = ? ORDER BY e.id",
                (version_id, object_id),
            )
        else:
            rows = conn.execute(
                "SELECT id, element_uid, element_type, mark, x, y, elevation_mm, "
                "zone_crane_id, zone_stance_id, current_status, is_current "
                "FROM elements WHERE object_id = ? AND is_current = 1 ORDER BY id",
                (object_id,),
            )
        return {"elements": [dict(row) for row in rows],
                "coordinates_note": "Координаты изделий показаны по текущей схеме"}
    finally:
        conn.close()


@router.get("/{version_id:int}")
def get_version(object_id: int, version_id: int,
                user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "read")
        row = conn.execute(
            "SELECT * FROM crane_zone_versions WHERE id = ? AND object_id = ?",
            (version_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Редакция не найдена")
        result = dict(row)
        result["zones"] = json.loads(result.pop("zones_json"))
        return result
    finally:
        conn.close()


@router.post("/drafts", status_code=201)
def new_draft(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "write")
        try:
            draft_id = create_draft(conn, object_id, user["id"], format_display_name(user))
        except ZoneDraftError as exc:
            _public_error(exc)
        return {"draft_id": draft_id, "edit_token": 1}
    finally:
        conn.close()


@router.get("/drafts")
def list_drafts(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "read")
        return [dict(row) for row in conn.execute(
            "SELECT id, base_version_id, note, created_at, updated_at, author_name, edit_token "
            "FROM crane_zone_drafts WHERE object_id = ? ORDER BY updated_at DESC, id DESC",
            (object_id,),
        )]
    finally:
        conn.close()


@router.get("/drafts/{draft_id}")
def get_draft(object_id: int, draft_id: int,
              user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "read")
        row = conn.execute(
            "SELECT * FROM crane_zone_drafts WHERE id = ? AND object_id = ?",
            (draft_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Черновик не найден")
        result = dict(row)
        result["zones"] = json.loads(result.pop("zones_json"))
        result["overrides"] = json.loads(result.pop("overrides_json"))
        result["warnings"] = stance_containment_issues(result["zones"])
        return result
    finally:
        conn.close()


@router.patch("/drafts/{draft_id}")
def patch_draft(object_id: int, draft_id: int, body: DraftPatch,
                user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "write")
        try:
            token = update_draft(conn, object_id, draft_id, body.edit_token,
                                 body.zones, body.overrides, body.note)
        except ZoneDraftError as exc:
            _public_error(exc)
        return {"draft_id": draft_id, "edit_token": token,
                "warnings": stance_containment_issues(body.zones)}
    finally:
        conn.close()


@router.post("/drafts/{draft_id}/preview")
def preview(object_id: int, draft_id: int,
            user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "write")
        try:
            result = preview_draft(conn, object_id, draft_id)
        except ZoneDraftError as exc:
            _public_error(exc)
        # 10 тыс. строк назначений не нужны панели предпросмотра; они заново
        # рассчитываются под блокировкой при публикации.
        return {"total": result["total"], "counts": result["counts"]}
    finally:
        conn.close()


@router.post("/drafts/{draft_id}/publish")
def publish(object_id: int, draft_id: int, body: PublishIn,
            user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _check(conn, user, object_id, "write")
        try:
            result = publish_draft(
                conn, object_id, draft_id, body.edit_token, body.effective_date,
                user["id"], format_display_name(user),
            )
        except ZoneDraftError as exc:
            _public_error(exc)
        activity.log(
            "crane_zone_version_publish", user=user, entity_type="object", entity_id=object_id,
            new_value=f"Редакция {result['revision_no']} действует с {result['effective_date']}",
            details=result,
        )
        return result
    finally:
        conn.close()

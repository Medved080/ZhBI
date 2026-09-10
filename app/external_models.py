"""Внешние 3D-модели ОБЪЕКТА (благоустройство и т.п.) — API.
См. Docs/fbx-ground-implementation-task.md §7 (пересмотрено 2026-09-10:
модель принадлежит объекту, не проекту — проект в системе только
группирует объекты). Права — тот же раздел `external_models`
(app/features.py), что и у остальных операций объекта: чтение — роль на
объекте не ниже READ, запись — не ниже WRITE; администратор сервиса — как
обычно, в обход.
"""
import json
import math
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app import activity
from app.access import assert_object_feature
from app.auth import get_current_user
from app.db import get_connection
from app.external_model_storage import (
    ExternalModelTooLarge,
    delete_file,
    path_for,
    write_stream_with_hash,
)
from app.fbx_global_settings import FbxGlobalSettingsError, assert_supported_axis_profile, read_fbx_global_settings
from app.object_geometry_bounds import get_object_bounds, object_anchor_from_bounds
from app.upload_limits import MAX_UPLOAD_BYTES

router = APIRouter(prefix="/objects/{object_id}/external-models", tags=["external-models"])

MAX_MODEL_BYTES = min(50 * 1024 * 1024, MAX_UPLOAD_BYTES)
MAX_OFFSET_MM = 1e9
MAX_META_JSON_BYTES = 20_000
SUPPORTED_KINDS = ("ground",)
FEATURE_KEY = "external_models"


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _assert_object_exists(conn, object_id: int) -> None:
    if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")


def _row_out(row: sqlite3.Row) -> dict:
    meta = json.loads(row["metadata_json"] or "{}")
    return {
        "id": row["id"],
        "object_id": row["object_id"],
        "name": row["name"],
        "kind": row["kind"],
        "original_name": row["original_name"],
        "size_bytes": row["size_bytes"],
        "format_version": row["format_version"],
        "placement_mode": row["placement_mode"],
        "metadata": meta,
        "source_anchor_mm": {
            "x": row["source_anchor_x_mm"], "y": row["source_anchor_y_mm"], "z": row["source_anchor_z_mm"],
        },
        "object_anchor_mm": {"x": row["object_anchor_x_mm"], "y": row["object_anchor_y_mm"]},
        "offset_mm": {"x": row["offset_x_mm"], "y": row["offset_y_mm"]},
        "rotation_deg": row["rotation_deg"],
        "centering_revision": row["centering_revision"],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("")
def list_external_models(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(
            "SELECT * FROM object_external_models WHERE object_id = ? ORDER BY created_at",
            (object_id,),
        ).fetchall()
        return {"models": [_row_out(r) for r in rows]}
    finally:
        conn.close()


@router.get("/bounds")
def object_bounds(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        result = get_object_bounds(conn, object_id)
        anchor = object_anchor_from_bounds(result["bounds_mm"])
        return {
            "bounds_mm": result["bounds_mm"],
            "object_anchor_mm": {"x": anchor[0], "y": anchor[1]},
            "source_revision": result["source_revision"],
        }
    finally:
        conn.close()


@router.get("/{model_id}/content")
def download_content(object_id: int, model_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        row = conn.execute(
            "SELECT * FROM object_external_models WHERE id = ? AND object_id = ?",
            (model_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Модель не найдена")
    finally:
        conn.close()
    p = path_for(row["stored_name"])
    if not p.is_file():
        raise HTTPException(status_code=410, detail="Файл модели отсутствует на диске")
    from fastapi.responses import Response
    return Response(content=p.read_bytes(), media_type="application/octet-stream")


class UploadMeta(BaseModel):
    name: str = Field(default="Благоустройство", max_length=255)
    kind: str = "ground"
    source_anchor_mm: dict
    bbox_size_mm: Optional[dict] = None
    mesh_count: Optional[int] = None
    triangle_count: Optional[int] = None
    texture_count: Optional[int] = None
    warnings: list[str] = Field(default_factory=list)


@router.post("")
def upload_external_model(
    object_id: int,
    file: UploadFile = File(...),
    meta: str = Form(...),
    user: sqlite3.Row = Depends(get_current_user),
):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
    finally:
        conn.close()

    if len(meta.encode("utf-8")) > MAX_META_JSON_BYTES:
        raise HTTPException(status_code=422, detail="Метаданные предпросмотра слишком большие")
    try:
        parsed = json.loads(meta)
    except ValueError:
        raise HTTPException(status_code=422, detail="Метаданные предпросмотра — не JSON")
    try:
        body = UploadMeta.model_validate(parsed)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Метаданные предпросмотра не прошли проверку: {exc}")

    if body.kind not in SUPPORTED_KINDS:
        raise HTTPException(status_code=422, detail=f"Вид модели «{body.kind}» не поддерживается")
    name = body.name.strip() or "Благоустройство"
    if len(name) > 255:
        raise HTTPException(status_code=422, detail="Название слишком длинное")

    anchor = body.source_anchor_mm
    if not isinstance(anchor, dict) or not all(k in anchor for k in ("x", "y", "z")):
        raise HTTPException(status_code=422, detail="source_anchor_mm должен содержать x, y, z")
    anchor_xyz = []
    for k in ("x", "y", "z"):
        v = anchor[k]
        if not _finite(v) or abs(v) > MAX_OFFSET_MM:
            raise HTTPException(status_code=422, detail=f"source_anchor_mm.{k} не является конечным допустимым числом")
        anchor_xyz.append(float(v))

    if not (file.filename or "").lower().endswith(".fbx"):
        raise HTTPException(status_code=422, detail="Ожидается файл .fbx")

    try:
        stored_name, sha256_hex, size = write_stream_with_hash(file.file, MAX_MODEL_BYTES)
    except ExternalModelTooLarge:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_MODEL_BYTES // (1024 * 1024)} МБ")

    try:
        raw = path_for(stored_name).read_bytes()
        settings = read_fbx_global_settings(raw)
        assert_supported_axis_profile(settings)
    except FbxGlobalSettingsError as exc:
        delete_file(stored_name)
        raise HTTPException(status_code=422, detail=str(exc))
    del raw

    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        bounds_result = get_object_bounds(conn, object_id)
        object_anchor_x, object_anchor_y = object_anchor_from_bounds(bounds_result["bounds_mm"])

        metadata = {
            "schema_version": 1,
            "format_version": settings["format_version"],
            "mm_per_unit": settings["mm_per_unit"],
            "unit_scale_factor": settings["unit_scale_factor"],
            "axes": {
                "up_axis": settings["up_axis"], "up_axis_sign": settings["up_axis_sign"],
                "front_axis": settings["front_axis"], "front_axis_sign": settings["front_axis_sign"],
                "coord_axis": settings["coord_axis"], "coord_axis_sign": settings["coord_axis_sign"],
            },
            "bbox_size_mm": body.bbox_size_mm,
            "mesh_count": body.mesh_count,
            "triangle_count": body.triangle_count,
            "texture_count": body.texture_count,
            "warnings": body.warnings[:50],
        }

        try:
            cur = conn.execute(
                "INSERT INTO object_external_models ("
                "object_id, name, kind, original_name, stored_name, sha256, size_bytes, "
                "format_version, placement_mode, metadata_json, "
                "source_anchor_x_mm, source_anchor_y_mm, source_anchor_z_mm, "
                "object_anchor_x_mm, object_anchor_y_mm, centering_revision, "
                "offset_x_mm, offset_y_mm, revision, created_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unreferenced', ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)",
                (
                    object_id, name, body.kind, (file.filename or "")[:255], stored_name, sha256_hex, size,
                    int(settings["format_version"]), json.dumps(metadata, ensure_ascii=False),
                    anchor_xyz[0], anchor_xyz[1], anchor_xyz[2],
                    object_anchor_x, object_anchor_y, bounds_result["source_revision"],
                    user["id"],
                ),
            )
            conn.commit()
        except BaseException:
            delete_file(stored_name)
            raise
        model_id = cur.lastrowid
        row = conn.execute("SELECT * FROM object_external_models WHERE id = ?", (model_id,)).fetchone()
    finally:
        conn.close()
    activity.log("external_model_upload", user=user, entity_type="object", entity_id=object_id,
                new_value=name)
    return _row_out(row)


class PatchIn(BaseModel):
    offset_x_mm: Optional[float] = None
    offset_y_mm: Optional[float] = None
    rotation_deg: Optional[float] = None
    name: Optional[str] = None
    expected_revision: int


@router.patch("/{model_id}")
def patch_external_model(object_id: int, model_id: int, body: PatchIn,
                          user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        row = conn.execute(
            "SELECT * FROM object_external_models WHERE id = ? AND object_id = ?",
            (model_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Модель не найдена")

        set_parts = ["revision = revision + 1", "updated_at = datetime('now')"]
        params = []
        if body.offset_x_mm is not None:
            if not _finite(body.offset_x_mm) or abs(body.offset_x_mm) > MAX_OFFSET_MM:
                raise HTTPException(status_code=422, detail="offset_x_mm не является конечным допустимым числом")
            set_parts.append("offset_x_mm = ?"); params.append(float(body.offset_x_mm))
        if body.offset_y_mm is not None:
            if not _finite(body.offset_y_mm) or abs(body.offset_y_mm) > MAX_OFFSET_MM:
                raise HTTPException(status_code=422, detail="offset_y_mm не является конечным допустимым числом")
            set_parts.append("offset_y_mm = ?"); params.append(float(body.offset_y_mm))
        if body.rotation_deg is not None:
            if not _finite(body.rotation_deg):
                raise HTTPException(status_code=422, detail="rotation_deg не является конечным числом")
            # Нормализация в (-180, 180] — хранится и отдаётся один
            # канонический угол, а не произвольно накопленное число оборотов
            # (поле — числовой ввод, не счётчик перетаскиваний).
            normalized = ((float(body.rotation_deg) + 180) % 360) - 180
            set_parts.append("rotation_deg = ?"); params.append(normalized)
        if body.name is not None:
            name = body.name.strip()
            if not name or len(name) > 255:
                raise HTTPException(status_code=422, detail="Название пустое или слишком длинное")
            set_parts.append("name = ?"); params.append(name)

        params.extend([model_id, object_id, body.expected_revision])
        cur = conn.execute(
            f"UPDATE object_external_models SET {', '.join(set_parts)} "
            "WHERE id = ? AND object_id = ? AND revision = ?",
            params,
        )
        if cur.rowcount == 0:
            conn.rollback()
            fresh = conn.execute("SELECT * FROM object_external_models WHERE id = ?", (model_id,)).fetchone()
            raise HTTPException(
                status_code=409,
                detail="Модель изменена в другом месте — обновите настройки",
                headers={"X-Current-Revision": str(fresh["revision"]) if fresh else ""},
            )
        conn.commit()
        fresh = conn.execute("SELECT * FROM object_external_models WHERE id = ?", (model_id,)).fetchone()
    finally:
        conn.close()
    activity.log("external_model_update", user=user, entity_type="object", entity_id=object_id,
                new_value=fresh["name"])
    return _row_out(fresh)


class RecenterIn(BaseModel):
    expected_revision: int


@router.post("/{model_id}/recenter")
def recenter_external_model(object_id: int, model_id: int, body: RecenterIn,
                             user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        row = conn.execute(
            "SELECT * FROM object_external_models WHERE id = ? AND object_id = ?",
            (model_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Модель не найдена")

        bounds_result = get_object_bounds(conn, object_id)
        anchor_x, anchor_y = object_anchor_from_bounds(bounds_result["bounds_mm"])

        cur = conn.execute(
            "UPDATE object_external_models SET "
            "object_anchor_x_mm = ?, object_anchor_y_mm = ?, centering_revision = ?, "
            "offset_x_mm = 0, offset_y_mm = 0, revision = revision + 1, updated_at = datetime('now') "
            "WHERE id = ? AND object_id = ? AND revision = ?",
            (anchor_x, anchor_y, bounds_result["source_revision"], model_id, object_id, body.expected_revision),
        )
        if cur.rowcount == 0:
            conn.rollback()
            fresh = conn.execute("SELECT * FROM object_external_models WHERE id = ?", (model_id,)).fetchone()
            raise HTTPException(
                status_code=409,
                detail="Модель изменена в другом месте — обновите настройки",
                headers={"X-Current-Revision": str(fresh["revision"]) if fresh else ""},
            )
        conn.commit()
        fresh = conn.execute("SELECT * FROM object_external_models WHERE id = ?", (model_id,)).fetchone()
    finally:
        conn.close()
    activity.log("external_model_recenter", user=user, entity_type="object", entity_id=object_id,
                new_value=fresh["name"])
    return _row_out(fresh)


@router.delete("/{model_id}")
def delete_external_model(object_id: int, model_id: int,
                           user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _assert_object_exists(conn, object_id)
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        row = conn.execute(
            "SELECT * FROM object_external_models WHERE id = ? AND object_id = ?",
            (model_id, object_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Модель не найдена")
        conn.execute("DELETE FROM object_external_models WHERE id = ?", (model_id,))
        conn.commit()
    finally:
        conn.close()
    delete_file(row["stored_name"])
    activity.log("external_model_delete", user=user, entity_type="object", entity_id=object_id,
                old_value=row["name"])
    return {"ok": True}

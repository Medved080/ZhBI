"""Маршруты универсального классификатора видов работ (app/work_classifier.py).

Сам классификатор — общесервисный справочник (раздел `dict_work_classifier`:
читают все, правит администратор сервиса). Набор позиций в структуру работ
объекта и сопоставление категорий модели — операции ОБЪЕКТА, права те же, что
у загрузки видов работ объекта (`work_progress`)."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app import activity, work_classifier as wc
from app.access import assert_object_feature, require_service_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection
from app.upload_limits import read_upload_limited

router = APIRouter(tags=["work-classifier"])

_READ = require_service_feature("dict_work_classifier", "read")
_WRITE = require_service_feature("dict_work_classifier", "write")


def _fail(e: wc.ClassifierError):
    raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/work-classifier")
def get_classifier(user: sqlite3.Row = Depends(_READ)):
    conn = get_connection()
    try:
        return wc.tree(conn)
    finally:
        conn.close()


@router.post("/work-classifier/analyze")
def analyze_classifier(file: UploadFile = File(...), user: sqlite3.Row = Depends(_WRITE)):
    """Фаза 1: разбор xlsx. В БД не пишет."""
    data = read_upload_limited(file.file)
    conn = get_connection()
    try:
        try:
            analysis = wc.analyze(conn, data)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()
    token = wc.remember_pending(analysis)
    return {"token": token, **{k: v for k, v in analysis.items() if not k.startswith("_")}}


class ApplyIn(BaseModel):
    token: str


@router.post("/work-classifier/apply")
def apply_classifier(body: ApplyIn, user: sqlite3.Row = Depends(_WRITE)):
    """Фаза 2: применяет показанную сводку по токену."""
    try:
        analysis = wc.get_pending(body.token)
    except wc.ClassifierError as e:
        _fail(e)
    conn = get_connection()
    try:
        begin_write(conn)
        result = wc.apply(conn, analysis)
    finally:
        conn.close()
    wc.forget_pending(body.token)
    activity.log("import_work_classifier", user=user, details=result)
    return result


class CategoriesIn(BaseModel):
    names: list[str]


@router.put("/work-classifier/{classifier_id}/categories")
def set_categories(classifier_id: int, body: CategoriesIn, user: sqlite3.Row = Depends(_WRITE)):
    conn = get_connection()
    try:
        begin_write(conn)
        try:
            result = wc.set_position_categories(conn, classifier_id, body.names)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()
    activity.log("work_classifier_categories", user=user, entity_type="work_classifier",
                 entity_id=classifier_id, details={"категории": body.names})
    return result


@router.delete("/work-classifier/categories/{category_id}")
def delete_category(category_id: int, user: sqlite3.Row = Depends(_WRITE)):
    conn = get_connection()
    try:
        begin_write(conn)
        try:
            result = wc.delete_category(conn, category_id)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()
    activity.log("work_classifier_category_delete", user=user, entity_type="work_element_category",
                 entity_id=category_id, details=result)
    return result


# ------------------------------------------------------------------ объект

@router.get("/objects/{object_id}/work-structure")
def get_work_structure(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        data = wc.object_selection(conn, object_id)
        return data
    finally:
        conn.close()


class SelectionIn(BaseModel):
    ids: list[int]


@router.post("/objects/{object_id}/work-structure/preview")
def preview_work_structure(object_id: int, body: SelectionIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            return wc.preview_object_selection(conn, object_id, body.ids)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()


@router.put("/objects/{object_id}/work-structure")
def save_work_structure(object_id: int, body: SelectionIn,
                        user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        begin_write(conn)
        try:
            result = wc.save_object_selection(conn, object_id, body.ids)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()
    activity.log("work_structure_pick", user=user, entity_type="object", entity_id=object_id,
                 details=result)
    return result


@router.get("/objects/{object_id}/category-map")
def get_category_map(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        return wc.category_map_state(conn, object_id)
    finally:
        conn.close()


class CategoryMapIn(BaseModel):
    map: dict[str, list[str]]


@router.put("/objects/{object_id}/category-map")
def save_category_map(object_id: int, body: CategoryMapIn,
                      user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        begin_write(conn)
        try:
            result = wc.save_category_map(conn, object_id, body.map)
        except wc.ClassifierError as e:
            _fail(e)
    finally:
        conn.close()
    activity.log("object_category_map", user=user, entity_type="object", entity_id=object_id,
                 details=result)
    return result

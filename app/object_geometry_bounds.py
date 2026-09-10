"""Устойчивый горизонтальный габарит объекта — источник anchor для внешних
3D-моделей (см. Docs/fbx-ground-implementation-task.md §6, пересмотрено
2026-09-10: модель принадлежит ОБЪЕКТУ, а не проекту — проект в системе
только группирует объекты и собственных данных не имеет).

Считается по исходным данным САМОГО объекта: актуальным контурам его
элементов ЖБИ и актуальным абсолютным контурам его revit_elements — БЕЗ
текущих фильтров этажа/статуса/категории/видимости. Одна КОНКРЕТНАЯ
таблица данных на объект (ЖБИ либо revit_elements — на одном объекте не
бывает обеих), поэтому больше нет риска объединять несовместимые системы
координат РАЗНЫХ объектов, как было бы при проектном варианте: то, что тут
собрано, — геометрия ровно одного объекта.

Известное ограничение первой версии — объект, где геометрии совсем нет ни
в elements, ни в revit_elements, но есть в блоках «Учёт по блокам» с
координатами (без модели Revit), получит `bounds_mm=null`, хотя визуально
блоки на экране «Модели МФР» видны.
"""
import hashlib
import json
import sqlite3
from typing import Optional


def _extend(bounds: dict, x: float, y: float) -> None:
    if x < bounds["minX"]:
        bounds["minX"] = x
    if x > bounds["maxX"]:
        bounds["maxX"] = x
    if y < bounds["minY"]:
        bounds["minY"] = y
    if y > bounds["maxY"]:
        bounds["maxY"] = y


def _extend_from_row(bounds: dict, outline_json: Optional[str], x, y) -> bool:
    """True, если что-то реально расширило габарит."""
    pts = None
    if outline_json:
        try:
            parsed = json.loads(outline_json)
            if isinstance(parsed, list) and parsed:
                pts = parsed
        except (ValueError, TypeError):
            pts = None
    if pts:
        ok = False
        for p in pts:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    px, py = float(p[0]), float(p[1])
                except (TypeError, ValueError):
                    continue
                if not (px == px and py == py):  # NaN
                    continue
                _extend(bounds, px, py)
                ok = True
        if ok:
            return True
    # fallback — точка x/y элемента без контура
    if x is not None and y is not None:
        try:
            fx, fy = float(x), float(y)
        except (TypeError, ValueError):
            return False
        if fx == fx and fy == fy:
            _extend(bounds, fx, fy)
            return True
    return False


def get_object_bounds(conn: sqlite3.Connection, object_id: int) -> dict:
    """{'bounds_mm': {...} | None, 'source_revision': str}."""
    bounds = {"minX": float("inf"), "maxX": float("-inf"),
              "minY": float("inf"), "maxY": float("-inf")}
    found = False
    revision_parts = []

    for r in conn.execute(
        "SELECT outline_json, x, y, updated_at FROM elements WHERE object_id = ? AND is_current = 1",
        (object_id,),
    ):
        if _extend_from_row(bounds, r["outline_json"], r["x"], r["y"]):
            found = True
        if r["updated_at"]:
            revision_parts.append(r["updated_at"])

    for r in conn.execute(
        "SELECT outline_json, x, y, updated_at FROM revit_elements WHERE object_id = ? AND is_current = 1",
        (object_id,),
    ):
        if _extend_from_row(bounds, r["outline_json"], r["x"], r["y"]):
            found = True
        if r["updated_at"]:
            revision_parts.append(r["updated_at"])

    revision_source = json.dumps(
        {"object_id": object_id, "updates": sorted(set(revision_parts))[-50:]},
        sort_keys=True, ensure_ascii=False,
    )
    source_revision = hashlib.sha256(revision_source.encode("utf-8")).hexdigest()[:16]

    if not found:
        return {"bounds_mm": None, "source_revision": source_revision}
    return {
        "bounds_mm": {
            "minX": bounds["minX"], "maxX": bounds["maxX"],
            "minY": bounds["minY"], "maxY": bounds["maxY"],
        },
        "source_revision": source_revision,
    }


def object_anchor_from_bounds(bounds_mm: Optional[dict]) -> tuple:
    """Центр горизонтального габарита, Z всегда 0. Пустой объект —
    (0, 0) (§6: «В объекте пока нет геометрии. Модель размещена в начале
    координат»)."""
    if not bounds_mm:
        return 0.0, 0.0
    return (
        (bounds_mm["minX"] + bounds_mm["maxX"]) / 2,
        (bounds_mm["minY"] + bounds_mm["maxY"]) / 2,
    )

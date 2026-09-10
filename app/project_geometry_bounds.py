"""Устойчивый горизонтальный габарит ВСЕГО проекта — источник anchor для
внешних 3D-моделей (см. Docs/fbx-ground-implementation-task.md §6).

Считается по исходным данным объектов проекта: актуальным контурам
элементов ЖБИ и актуальным абсолютным контурам revit_elements — БЕЗ
текущих фильтров этажа/статуса/категории/видимости. Это не то же самое,
что габарит МФР-блоков (учёт по блокам без модели, `app/features.py`,
`Docs/block-accounting.md`) — блоки в первой версии в объединение не
входят: у части блоков координат вовсе нет (учёт по блокам работает и без
геометрии), а часть привязана к тем же элементам/чертежам, что уже учтены
через elements/revit_elements. Известное ограничение первой версии —
проект, где геометрии совсем нет НИ в elements, НИ в revit_elements, но
есть в блоках с координатами, получит `bounds_mm=null`, хотя визуально
блоки на экране «Модели МФР» видны; см. отчёт исполнителя.

Объединение существующих абсолютных координат разных источников — не
заявление об их геодезической согласованности (§6): в проекте нет
универсальной привязки между независимыми системами координат разных
чертежей.
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


def get_project_bounds(conn: sqlite3.Connection, project_id: int) -> dict:
    """{'bounds_mm': {...} | None, 'source_revision': str, 'object_ids': [...]}."""
    object_ids = [r["id"] for r in conn.execute(
        "SELECT id FROM objects WHERE project_id = ?", (project_id,))]
    bounds = {"minX": float("inf"), "maxX": float("-inf"),
              "minY": float("inf"), "maxY": float("-inf")}
    found = False
    revision_parts = []

    if object_ids:
        marks = ",".join("?" * len(object_ids))

        for r in conn.execute(
            f"SELECT outline_json, x, y, updated_at FROM elements "
            f"WHERE object_id IN ({marks}) AND is_current = 1",
            object_ids,
        ):
            if _extend_from_row(bounds, r["outline_json"], r["x"], r["y"]):
                found = True
            if r["updated_at"]:
                revision_parts.append(r["updated_at"])

        for r in conn.execute(
            f"SELECT outline_json, x, y, updated_at FROM revit_elements "
            f"WHERE object_id IN ({marks}) AND is_current = 1",
            object_ids,
        ):
            if _extend_from_row(bounds, r["outline_json"], r["x"], r["y"]):
                found = True
            if r["updated_at"]:
                revision_parts.append(r["updated_at"])

    # Ревизия — хэш от последних updated_at и состава объектов: пересчёт
    # центрирования от того же bounds не нужен, а другая ревизия проекта
    # (изменилась геометрия) обязана дать 409 на PATCH со старым
    # centering_revision (§7).
    revision_source = json.dumps(
        {"objects": sorted(object_ids), "updates": sorted(set(revision_parts))[-50:]},
        sort_keys=True, ensure_ascii=False,
    )
    source_revision = hashlib.sha256(revision_source.encode("utf-8")).hexdigest()[:16]

    if not found:
        return {"bounds_mm": None, "source_revision": source_revision, "object_ids": object_ids}
    return {
        "bounds_mm": {
            "minX": bounds["minX"], "maxX": bounds["maxX"],
            "minY": bounds["minY"], "maxY": bounds["maxY"],
        },
        "source_revision": source_revision,
        "object_ids": object_ids,
    }


def project_anchor_from_bounds(bounds_mm: Optional[dict]) -> tuple:
    """Центр горизонтального габарита, Z всегда 0. Пустой проект —
    (0, 0) (§6: «В проекте пока нет геометрии. Модель размещена в начале
    координат»)."""
    if not bounds_mm:
        return 0.0, 0.0
    return (
        (bounds_mm["minX"] + bounds_mm["maxX"]) / 2,
        (bounds_mm["minY"] + bounds_mm["maxY"]) / 2,
    )

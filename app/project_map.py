# -*- coding: utf-8 -*-
"""Карта проектов: точки объектов и отдача офлайн-подложки.

Зачем отдельный экран. Справочник отвечает на вопрос «какие у нас объекты»,
а карта — на вопрос «где они и как там дела»: при двух сотнях площадок в
разных городах список названий этого не показывает.

Почему это ОТЧЁТ, а не рабочее место. Рабочее место — раскладка вокруг
ТЕКУЩЕГО объекта, и раздел прав у него проверяется на объекте. Карта же
показывает все доступные объекты сразу, а по клику переключает текущий —
то есть ведёт себя как отчёт, а не как режим работы.

Подложка. Сервер в интернет не ходит, тайловых сервисов у него нет, поэтому
карта берётся из файла PMTiles на диске (`data/map/`). Файл готовится
скриптом `scripts/fetch_map_tiles.py` на машине с интернетом и переносится
руками. Формат PMTiles читается браузером по диапазонам байт, поэтому
FileResponse подходит как есть: Starlette умеет Range.

Файла нет — это НЕ ошибка: карта рисует точки на пустом фоне и говорит об
этом. Расположение объектов друг относительно друга видно и так.
"""

import os
import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.access import require_service_feature
from app.auth import get_current_user
from app.db import get_connection

MAP_DIR = os.environ.get("ZHBI_MAP_DIR") or "data/map"

# Подложка из OpenStreetMap распространяется по ODbL, и указание авторства —
# требование лицензии, а не вежливость. Показывается в углу карты.
ATTRIBUTION = "© OpenStreetMap contributors"

# Центр страны — куда смотреть, когда ни у одного объекта нет координат.
DEFAULT_CENTER = (55.75, 37.62)
DEFAULT_ZOOM = 4

router = APIRouter(prefix="/map", tags=["map"])


def _safe_name(name: str) -> str:
    """Имя файла подложки из запроса. Только базовое имя и только .pmtiles:
    путь из запроса — это чтение любого файла на сервере."""
    имя = os.path.basename(name or "")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}\.pmtiles", имя):
        raise HTTPException(status_code=400, detail="Недопустимое имя файла карты")
    return имя


def basemaps() -> list:
    """Файлы подложки, лежащие на сервере. Их может быть несколько: обзорный
    на всю страну и детальные вырезки по регионам присутствия."""
    out = []
    try:
        имена = sorted(os.listdir(MAP_DIR))
    except OSError:
        return out
    for имя in имена:
        if not имя.endswith(".pmtiles"):
            continue
        путь = os.path.join(MAP_DIR, имя)
        if os.path.isfile(путь):
            out.append({"name": имя, "size": os.path.getsize(путь),
                        "url": "/map/tiles/" + имя})
    return out


@router.get("/config")
def map_config(user: sqlite3.Row = Depends(require_service_feature("map", "read"))):
    """Что нужно клиенту до отрисовки: есть ли подложка и куда смотреть."""
    return {
        "basemaps": basemaps(),
        "attribution": ATTRIBUTION,
        "default_center": {"lat": DEFAULT_CENTER[0], "lon": DEFAULT_CENTER[1]},
        "default_zoom": DEFAULT_ZOOM,
    }


@router.get("/tiles/{name}")
def map_tiles(name: str, user: sqlite3.Row = Depends(get_current_user)):
    """Файл подложки. Читается браузером по диапазонам байт — Starlette
    отдаёт Range сам, своего кода это не требует.

    Проверка здесь только «вошёл ли человек»: подложка — это карта страны из
    OpenStreetMap, никаких сведений о стройках предприятия в ней нет.
    """
    путь = os.path.join(MAP_DIR, _safe_name(name))
    if not os.path.isfile(путь):
        raise HTTPException(status_code=404, detail="Файл карты не загружен")
    return FileResponse(
        путь, media_type="application/octet-stream",
        # Подложка неизменна и весит гигабайты: перекачивать её на каждое
        # открытие карты нельзя.
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/objects")
def map_objects(user: sqlite3.Row = Depends(require_service_feature("map", "read"))):
    """Объекты с координатами и сводкой по каждому.

    Одним запросом с группировкой, а не по объекту за раз: при двух сотнях
    площадок разница между одним запросом и двумя сотнями — это разница
    между мгновенным открытием и секундами ожидания.

    Отбор доступных — тем же способом, что и везде (`_accessible_objects_clause`
    в app/main.py): карта не должна показывать чужие стройки.
    """
    from app.main import _accessible_objects_clause   # цикл импорта: только здесь

    conn = get_connection()
    try:
        доступ, params = _accessible_objects_clause(conn, user, "o.id")
        строки = conn.execute(
            "SELECT o.id, o.name, o.kind, COALESCE(o.status, 'active') AS status, "
            "       o.address, o.address_region, o.lat, o.lon, "
            "       o.project_id, p.name AS project_name, "
            "       p.lat AS project_lat, p.lon AS project_lon, "
            "       COUNT(e.id) AS elements, "
            "       SUM(CASE WHEN e.current_status IN ('installed', 'accepted') THEN 1 ELSE 0 END) AS mounted, "
            "       MIN(e.project_smr_start_date) AS smr_start, "
            "       MAX(e.project_delivery_date) AS smr_end "
            "FROM objects o "
            "LEFT JOIN projects p ON p.id = o.project_id "
            "LEFT JOIN elements e ON e.object_id = o.id AND e.is_current = 1 "
            f"WHERE {доступ} "
            "GROUP BY o.id ORDER BY p.name, o.name",
            params,
        ).fetchall()

        объекты, без_координат = [], 0
        for r in строки:
            lat, lon = r["lat"], r["lon"]
            # Объект без своих координат наследует их у проекта: у площадки из
            # соседних зданий один адрес на всех, и заставлять расставлять пин
            # каждому корпусу — работа без смысла.
            унаследованы = False
            if lat is None or lon is None:
                lat, lon = r["project_lat"], r["project_lon"]
                унаследованы = lat is not None and lon is not None
            if lat is None or lon is None:
                без_координат += 1
                continue
            элементов = r["elements"] or 0
            смонтировано = r["mounted"] or 0
            объекты.append({
                "id": r["id"], "name": r["name"], "kind": r["kind"] or "zhbi",
                "status": r["status"],
                "project_id": r["project_id"], "project_name": r["project_name"],
                "address": r["address"], "region": r["address_region"],
                "lat": lat, "lon": lon, "inherited": унаследованы,
                "elements": элементов, "mounted": смонтировано,
                # Доля считается ЗДЕСЬ: у клиента она понадобилась бы и для
                # цвета точки, и для подписи, и два способа посчитать одно и
                # то же однажды разъезжаются.
                "percent": round(смонтировано * 100.0 / элементов) if элементов else None,
                "smr_start": r["smr_start"], "smr_end": r["smr_end"],
            })
        return {"objects": объекты, "without_coords": без_координат}
    finally:
        conn.close()

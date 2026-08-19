"""
Что пользователю доступно и в каком объёме — «матрица прав» (живой запрос
2026-08-04).

Зачем отдельный модуль. Роль отвечает на вопрос «кто он», а администратор
спрашивает другое: «что этот человек сможет сделать на этой стройке».
Раньше ответ собирался в уме по четырём ролям и полутора сотням эндпоинтов,
и ошибиться в нём было проще, чем не ошибиться: `.admin-only` (ведение
СЕРВИСА) и `.object-admin-only` (операции ВНУТРИ объекта) уже путались в
интерфейсе, а аудит 2026-08-03 нашёл пять эндпоинтов правки, проверявших
системную роль и не проверявших объект вовсе.

Что здесь лежит. Только СЧЁТ: перечень разделов переехал в app/features.py,
разрешения ролей — в базу (`role_features`, блок «Настройка ролей»,
2026-08-14), а этот модуль отвечает на вопрос «что выйдет у ЭТОГО человека
на ЭТОМ объекте при нынешней настройке».

Чем это перестало быть. До 2026-08-14 матрица была ОПИСАНИЕМ: пороги жили
в коде эндпоинтов, а здесь пересказывались администратору — и разъехаться
они могли только молча. Теперь описание и проверка читают одну и ту же
строку базы: `has_feature` в app/access.py и `feature_level` здесь — одна
функция и её витрина.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.access import (
    feature_level_for,
    is_system_admin,
    object_role_keys,
    require_service_feature,
    role_labels,
    role_level,
    role_list,
)
from app.auth import get_current_user
from app.db import get_connection
from app.features import FEATURES, IO_HINTS, LEVEL_LABELS, SCOPE_LABELS, SCOPE_OBJECT

router = APIRouter(tags=["rights"])

LEVELS = LEVEL_LABELS


def rights_for(conn, user_row, object_id: Optional[int]) -> dict:
    """Матрица одного пользователя на одном объекте.

    object_id=None — объект не выбран (или у человека нет ни одного
    доступного). Общесервисные разделы при этом всё равно считаются в своём
    настоящем объёме: их эндпоинты проверяют роли человека без объекта, и
    считать их по показываемому зданию значит показывать не то, что будет.
    """
    подписи = role_labels(conn)
    роли = (object_role_keys(conn, user_row, object_id)
            if object_id is not None and not is_system_admin(user_row) else set())
    rows = []
    for f in FEATURES:
        # Выбранный объект подставляется ТОЛЬКО объектным разделам —
        # см. docstring выше.
        цель = object_id if f.scope == SCOPE_OBJECT else None
        rows.append({
            "key": f.key, "section": f.section, "title": f.title,
            "note": f.note, "sources": f.sources,
            "io": f.io, "io_hint": IO_HINTS.get(f.io),
            "scope": f.scope, "scope_label": SCOPE_LABELS.get(f.scope),
            "level": feature_level_for(conn, user_row, f.key, цель),
            # Откуда взялся уровень: какие из ролей человека его дают.
            # Администратор спрашивает не только «что выйдет», но и
            # «почему именно столько», а при СЛОЖЕНИИ ролей ответ на второй
            # вопрос иначе негде взять.
            "from_roles": sorted(
                подписи.get(р, р) for р in роли if role_level(conn, [р], f.key) != "none"),
        })
    return {
        "user_id": user_row["id"],
        "object_id": object_id,
        "object_roles": sorted(подписи.get(р, р) for р in роли),
        "system_admin": is_system_admin(user_row),
        "features": rows,
    }


@router.get("/me/permissions")
def my_permissions(object_id: Optional[int] = Query(None),
                   user: sqlite3.Row = Depends(get_current_user)):
    """Что МОЖЕТ САМ спрашивающий на показываемом объекте: {раздел: уровень}.

    Ради этого эндпоинта блок настройки ролей и имеет смысл в интерфейсе.
    До 2026-08-14 клиент судил о правах по собственной копии лестницы и по
    классам `.object-admin-only` — то есть по правилам, переписанным на
    второй язык руками. Стоило разрешению стать настраиваемым, как эта
    копия начала бы врать при первой же правке: кнопка появлялась бы там,
    где сервер отказывает, и пропадала бы там, где он разрешает.

    Здесь считает ТОТ ЖЕ has_feature, что и проверки. Клиент ничего не
    выводит сам — он показывает присланное.
    """
    conn = get_connection()
    try:
        if object_id is not None and conn.execute(
                "SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        данные = rights_for(conn, user, object_id)
        return {
            "object_id": object_id,
            "object_roles": данные["object_roles"],
            "system_admin": данные["system_admin"],
            "features": {f["key"]: f["level"] for f in данные["features"]},
            # Разрешения ролей целиком — чтобы клиент мог посчитать доступ
            # на ДРУГОМ объекте, не показываемом сейчас: списки объектов в
            # формах документов отбираются именно так. Своего мнения о
            # правах у клиента при этом не появляется — он складывает те же
            # строки, что и сервер.
            "role_features": _role_features_map(conn),
            # Названия ролей нужны формам выдачи доступа. Отдаются здесь, а
            # не отдельным запросом: это единственный эндпоинт про права,
            # который клиент зовёт всегда, и второй список ролей рядом с
            # первым разъехался бы на первой же переименованной роли.
            "roles": role_list(conn),
        }
    finally:
        conn.close()


def _role_features_map(conn) -> dict:
    итог = {}
    for r in conn.execute("SELECT role_key, feature_key, level FROM role_features"):
        итог.setdefault(r["role_key"], {})[r["feature_key"]] = r["level"]
    return итог


@router.get("/users/{user_id}/rights-matrix")
def user_rights_matrix(
    user_id: int,
    object_id: Optional[int] = Query(None),
    admin: sqlite3.Row = Depends(require_service_feature("users", "read")),
):
    """«На что у человека есть права» — разделы системы против объёма прав.

    Считается ДЛЯ ОБЪЕКТА: роль — свойство гранта, а не пользователя, и
    один человек бывает прорабом на одном здании и наблюдателем на соседнем
    (app/access.py). Объект не передан — показываем картину «доступа к
    объекту нет», то есть ровно то, что даёт системная роль и
    общесервисные разделы.
    """
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        if object_id is not None and conn.execute(
                "SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        return rights_for(conn, row, object_id)
    finally:
        conn.close()


@router.get("/users/access-matrix")
def access_matrix(admin: sqlite3.Row = Depends(require_service_feature("users", "read"))):
    """Гранты ВСЕХ пользователей разом — для групповой настройки прав.

    Отдельный эндпоинт, а не GET /users/{id}/access в цикле: у формы по
    вертикали список пользователей, и запрос на каждого означал бы столько
    же запросов на одно открытие. Сами пользователи здесь НЕ возвращаются —
    их клиент берёт обычным GET /users: правка системной роли отправляется
    полным телом (UserUpdateIn), и второй, урезанный список пользователей
    рядом с полным разъехался бы на первом же новом поле.

    Гранты отдаются СПИСКОМ РОЛЕЙ на уровень (2026-08-14): ролей на одном
    уровне бывает несколько, и они складываются.
    """
    conn = get_connection()
    try:
        grants = {}
        for r in conn.execute(
            "SELECT user_id, project_id, object_id, role FROM user_access"
        ).fetchall():
            grants.setdefault(str(r["user_id"]), []).append(
                {"project_id": r["project_id"], "object_id": r["object_id"], "role": r["role"]})
        return {"grants": grants, "roles": role_list(conn),
                "role_labels": role_labels(conn)}
    finally:
        conn.close()

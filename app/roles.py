"""
Настройка ролей: роли и их разрешения (2026-08-14).

Что это меняет. До этой даты объём прав на стройке был свойством КОДА:
четыре роли перечислены в app/access.py, порог каждой операции вписан в её
эндпоинт (`require_object_editor` — это буквальное «user»), а «Матрица
прав» пересказывала всё это администратору. Изменить объём прав можно было
только выпуском новой версии.

Теперь роли и их разрешения — данные. Перечень РАЗДЕЛОВ остался за
разработчиком (app/features.py): раздел заводится вместе с кодом, который
его проверяет, и придумать в интерфейсе несуществующую проверку нельзя.

**Роли НЕЗАВИСИМЫ, разрешения СКЛАДЫВАЮТСЯ** (решение пользователя). Ни
одна роль не включает другую; человеку выдают столько ролей, сколько нужно,
а уровень доступа к разделу — максимум по ним. Лестницы, на которой всё
держалось до этого дня, больше нет, и слова «выше/ниже» у ролей не
осталось: `rank` в таблице задаёт только порядок колонок в матрице.

**Запереть систему настройкой нельзя.** Администратор сервиса проходит все
проверки в обход грантов (app/access.has_feature), поэтому что бы он ни
снял — включая раздел «Настройка ролей» — вернуть права себе он в
состоянии; снять роль администратора сервиса с самого себя тоже нельзя
(app/users.py). Отдельного стража от самозапирания поэтому нет: страж,
который ничего не ловит, со временем начинают считать работающим.

Удаление роли сделано по образцу app/dict_delete.py: молча снести роль, за
которую держатся выданные доступы, нельзя — форма показывает, сколько их, и
требует подтверждения. ЗАМЕНА при этом не нужна и не предлагается, и это
отличие от справочников: роли складываются, у человека их обычно несколько,
и «перевести доступ на другую роль» означало бы выдать ему права, которых
администратор не выдавал. Снятая роль просто исчезает из наборов.
"""

import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import require_service_feature, role_keys, role_list
from app.db import get_connection
from app.features import FEATURES, LEVEL_LABELS, LEVELS, NONE, SCOPE_LABELS, SCOPE_SELF, SECTIONS

router = APIRouter(prefix="/roles", tags=["roles"])

_ТРАНСЛИТ = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e",
    "ю": "yu", "я": "ya",
}


def _ключ_из_названия(conn: sqlite3.Connection, name: str) -> str:
    """Ключ роли из её названия.

    Ключ — то, что лежит в user_access.role и в role_features; он должен
    быть пригоден для чтения глазами в базе и в журнале. Кириллица
    переводится в латиницу: значение уезжает в SQL, выгрузки и переносы
    базы, и не всякий их потребитель дружелюбен к юникоду в идентификаторах.
    """
    основа = "".join(_ТРАНСЛИТ.get(с, с) for с in (name or "").strip().lower())
    основа = re.sub(r"[^a-z0-9]+", "_", основа).strip("_")[:24] or "role"
    занятые = set(role_keys(conn))
    if основа not in занятые:
        return основа
    n = 2
    while f"{основа}_{n}" in занятые:
        n += 1
    return f"{основа}_{n}"


def _выдано(conn: sqlite3.Connection, key: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM user_access WHERE role = ?", (key,)).fetchone()["n"]


class RoleIn(BaseModel):
    name: str


class RoleOrderIn(BaseModel):
    keys: list[str]


class CellIn(BaseModel):
    role_key: str
    feature_key: str
    level: str          # none | read | write


class CellsIn(BaseModel):
    items: list[CellIn]


@router.get("")
def read_roles(user: sqlite3.Row = Depends(require_service_feature("roles", "read"))):
    """Всё, что нужно матрице, одним запросом: роли, разделы, разрешения.

    Одним, а не тремя: форма — единая таблица «разделы × роли», и собрать её
    из трёх ответов, приехавших вразнобой, значит рисовать её дважды.
    """
    conn = get_connection()
    try:
        разрешения = {}
        for r in conn.execute("SELECT role_key, feature_key, level FROM role_features"):
            разрешения.setdefault(r["feature_key"], {})[r["role_key"]] = r["level"]
        разделы = []
        for f in FEATURES:
            разделы.append({
                "key": f.key, "section": f.section, "title": f.title, "note": f.note,
                "scope": f.scope, "scope_label": SCOPE_LABELS.get(f.scope),
                "sources": f.sources,
                # Что настраивать нельзя: «своё» роли не подчиняется вовсе.
                "fixed": f.scope == SCOPE_SELF,
                "levels": разрешения.get(f.key, {}),
            })
        return {
            "roles": [dict(r, granted=_выдано(conn, r["key"])) for r in role_list(conn)],
            "features": разделы,
            "sections": SECTIONS,
            "level_labels": LEVEL_LABELS,
        }
    finally:
        conn.close()


@router.post("", status_code=201)
def create_role(body: RoleIn, user: sqlite3.Row = Depends(require_service_feature("roles", "write"))):
    """Новая роль заводится ПУСТОЙ — без единого разрешения.

    Пустой, а не «как у похожей»: роль, которая с рождения что-то может,
    выдаётся людям раньше, чем администратор посмотрел, что именно. Права
    добавляются осознанно, галочка за галочкой.
    """
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Название роли не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM object_roles WHERE name = ?", (name,)).fetchone():
            raise HTTPException(status_code=409, detail=f"Роль «{name}» уже есть")
        последний = conn.execute(
            "SELECT COALESCE(MAX(rank), 0) AS r FROM object_roles").fetchone()["r"]
        key = _ключ_из_названия(conn, name)
        conn.execute("INSERT INTO object_roles (key, name, rank) VALUES (?, ?, ?)",
                     (key, name, последний + 10))
        conn.commit()
        activity.log("role_create", user=user, new_value=name, details={"key": key})
        return {"key": key, "name": name, "rank": последний + 10, "granted": 0}
    finally:
        conn.close()


@router.patch("/{key}")
def rename_role(key: str, body: RoleIn,
                user: sqlite3.Row = Depends(require_service_feature("roles", "write"))):
    """Переименование. Ключ НЕ меняется: за него держатся выданные доступы и
    разрешения, а смена ключа ради косметики переписывала бы обе таблицы."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Название роли не может быть пустым")
    conn = get_connection()
    try:
        было = conn.execute("SELECT name FROM object_roles WHERE key = ?", (key,)).fetchone()
        if было is None:
            raise HTTPException(status_code=404, detail="Роль не найдена")
        if conn.execute("SELECT 1 FROM object_roles WHERE name = ? AND key <> ?",
                        (name, key)).fetchone():
            raise HTTPException(status_code=409, detail=f"Роль «{name}» уже есть")
        conn.execute("UPDATE object_roles SET name = ? WHERE key = ?", (name, key))
        conn.commit()
        activity.log("role_rename", user=user, old_value=было["name"], new_value=name,
                     details={"key": key})
        return {"key": key, "name": name}
    finally:
        conn.close()


@router.put("/order")
def reorder_roles(body: RoleOrderIn,
                  user: sqlite3.Row = Depends(require_service_feature("roles", "write"))):
    """Порядок колонок в матрице. Только показ: роли независимы, и «старше»
    у них не бывает — переставить колонки объём прав не меняет.

    Порядок задаётся ПОЛНЫМ списком, а не «подвинуть одну»: отправлять из
    формы разницу значило бы считать её на клиенте и надеяться, что она
    совпала с серверной (тот же довод, что у выдачи доступов в
    app/users.py).
    """
    conn = get_connection()
    try:
        текущие = role_keys(conn)
        if sorted(body.keys) != sorted(текущие):
            raise HTTPException(
                status_code=400,
                detail="Порядок задаётся полным списком ролей: получен не тот набор")
        for позиция, key in enumerate(body.keys, start=1):
            conn.execute("UPDATE object_roles SET rank = ? WHERE key = ?", (позиция * 10, key))
        conn.commit()
        activity.log("role_reorder", user=user, new_value=", ".join(body.keys))
        return {"roles": role_list(conn)}
    finally:
        conn.close()


@router.get("/{key}/delete-plan")
def delete_plan(key: str, user: sqlite3.Row = Depends(require_service_feature("roles", "read"))):
    """Что произойдёт при удалении роли — до того, как оно произойдёт."""
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM object_roles WHERE key = ?", (key,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Роль не найдена")
        люди = conn.execute(
            "SELECT COUNT(DISTINCT user_id) AS n FROM user_access WHERE role = ?",
            (key,)).fetchone()["n"]
        разрешений = conn.execute(
            "SELECT COUNT(*) AS n FROM role_features WHERE role_key = ?", (key,)).fetchone()["n"]
        return {"key": key, "granted": _выдано(conn, key), "users": люди,
                "permissions": разрешений}
    finally:
        conn.close()


@router.delete("/{key}", status_code=200)
def delete_role(key: str, user: sqlite3.Row = Depends(require_service_feature("roles", "write"))):
    """Удаление роли: её разрешения и все её выдачи исчезают.

    Замены нет намеренно (см. заголовок модуля): роли складываются, и
    «перевести доступ на другую роль» выдало бы людям права, которых
    администратор не выдавал. У кого эта роль была единственной на объекте,
    доступ к объекту потеряет — форма показывает число таких людей заранее.
    """
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM object_roles WHERE key = ?", (key,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Роль не найдена")
        снято = _выдано(conn, key)
        # Порядок: сначала выдачи, потом сама роль. Внешний ключ у
        # role_features каскадный, у user_access — нет, и это правильно:
        # молча терять чьи-то доступы каскадом нельзя, они снимаются здесь,
        # явной строкой, и попадают в журнал числом.
        conn.execute("DELETE FROM user_access WHERE role = ?", (key,))
        conn.execute("DELETE FROM role_features WHERE role_key = ?", (key,))
        conn.execute("DELETE FROM object_roles WHERE key = ?", (key,))
        conn.commit()
        activity.log("role_delete", user=user, old_value=key, details={"granted": снято})
        return {"deleted": key, "granted": снято}
    finally:
        conn.close()


@router.put("/features")
def set_cells(body: CellsIn,
              user: sqlite3.Row = Depends(require_service_feature("roles", "write"))):
    """Ячейки матрицы: роль × раздел → Нет/Чтение/Изменение.

    Приходит только то, что менялось. Уровень NONE удаляет строку, а не
    пишет ноль: отсутствие строки и есть «Нет», и хранить нули значило бы
    держать в базе два разных способа сказать одно и то же.
    """
    conn = get_connection()
    try:
        известные = {f.key: f for f in FEATURES}
        роли = set(role_keys(conn))
        изменено = []
        for item in body.items:
            раздел = известные.get(item.feature_key)
            if раздел is None:
                raise HTTPException(status_code=400,
                                    detail=f"Неизвестный раздел «{item.feature_key}»")
            if раздел.scope == SCOPE_SELF:
                raise HTTPException(
                    status_code=400,
                    detail=f"«{раздел.title}» роли не подчиняется: своё каждый меняет сам")
            if item.role_key not in роли:
                raise HTTPException(status_code=400, detail=f"Неизвестная роль «{item.role_key}»")
            if item.level not in LEVELS:
                raise HTTPException(status_code=400, detail=f"Неизвестный уровень «{item.level}»")
            строка = conn.execute(
                "SELECT level FROM role_features WHERE role_key = ? AND feature_key = ?",
                (item.role_key, item.feature_key)).fetchone()
            было = строка["level"] if строка else NONE
            if было == item.level:
                continue
            if item.level == NONE:
                conn.execute("DELETE FROM role_features WHERE role_key = ? AND feature_key = ?",
                             (item.role_key, item.feature_key))
            else:
                conn.execute(
                    "INSERT INTO role_features (role_key, feature_key, level) VALUES (?, ?, ?) "
                    "ON CONFLICT(role_key, feature_key) DO UPDATE SET level = excluded.level, "
                    "updated_at = datetime('now')",
                    (item.role_key, item.feature_key, item.level))
            изменено.append({"role": item.role_key, "feature": item.feature_key,
                             "was": было, "now": item.level})
        conn.commit()
        if изменено:
            activity.log("role_permissions", user=user,
                         new_value=f"ячеек изменено: {len(изменено)}",
                         details={"changes": изменено})
        return {"changed": изменено}
    finally:
        conn.close()

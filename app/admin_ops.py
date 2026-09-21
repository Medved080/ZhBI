"""Операции области «администрирование» для интерфейса V2, которых нет у V1 в готовом виде (2026-09-21).

Что здесь и зачем (всё — НОВЫЕ маршруты; существующие маршруты V1 не меняются):

  * `GET /password-policy` — требования к паролю, как их проверяет сервер (`auth.validate_password_strength`): форма смены пароля
    показывает их ДО отправки, а не после отказа. Только чтение; доступно и при обязательной смене пароля (см. `auth.py`).
  * `GET /users/{id}/access-summary`, `GET /me/access-summary` — сводка ВСЕХ проектов и объектов, доступных человеку, с ролями и
    источником каждой роли (напрямую / от проекта / от «всех проектов»). Считается теми же функциями `app/access.py`, которыми сервер
    проверяет доступ на самом деле, — а не пересчётом на клиенте по выданным грантам.
  * `POST /users/access-bulk` — ГРУППОВАЯ выдача и снятие доступа (и системной роли) нескольким пользователям одной операцией:
    все изменения или ни одного. `dry_run` возвращает предпросмотр последствий и ничего не пишет. Устаревшие данные (пока форма была
    открыта, доступ человека изменил кто-то другой) — 409 без единого изменения. Блокировка записи берётся первым действием.

Права — как у прежних маршрутов: чтение — раздел «Пользователи» (read), изменение — «Пользователи» (write); сводка о самом себе — любой
вошедший. Снять роль администратора сервиса с самого себя нельзя и здесь (то же правило, что в `users.update_user`).
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import (is_system_admin, object_role_keys, object_role_sources, require_service_feature, role_keys, role_labels)
from app.auth import MIN_PASSWORD_LENGTH, get_current_user
from app.db import begin_write, get_connection

router = APIRouter(tags=["admin-ops"])

MAX_BULK_USERS = 200
MAX_BULK_GRANTS = 4000


# ----------------------------------------------------------------- политика пароля

@router.get("/password-policy")
def password_policy(user: sqlite3.Row = Depends(get_current_user)):
    """Требования к новому паролю. Правило одно — в `auth.validate_password_strength`; здесь оно только описано человеку."""
    return {
        "min_length": MIN_PASSWORD_LENGTH,
        "need_letters": True,
        "need_digits": True,
        "text": f"Не короче {MIN_PASSWORD_LENGTH} символов, обязательно и буквы, и цифры.",
    }


# ----------------------------------------------------------------- сводка доступного человеку

_SRC_ORDER = ("напрямую", "от проекта", "от всех проектов")


def _sources_of(conn, user_id: int, object_id: int, project_id) -> dict:
    """{роль: [источники]} по ВСЕМ уровням, на которых роль выдана (объект → проект → все проекты)."""
    out: dict = {}
    for r in conn.execute("SELECT role, project_id, object_id FROM user_access WHERE user_id = ?", (user_id,)):
        if r["object_id"] == object_id:
            src = "напрямую"
        elif r["object_id"] is None and r["project_id"] is not None and r["project_id"] == project_id:
            src = "от проекта"
        elif r["object_id"] is None and r["project_id"] is None:
            src = "от всех проектов"
        else:
            continue
        out.setdefault(r["role"], set()).add(src)
    return {k: [s for s in _SRC_ORDER if s in v] for k, v in out.items()}


def access_summary(conn, target: sqlite3.Row) -> dict:
    """Сводка доступного человеку: проекты → объекты → роли с источниками. Системный администратор — всё, без ролей."""
    labels = role_labels(conn)
    projects = conn.execute("SELECT id, name, status FROM projects ORDER BY name COLLATE NOCASE").fetchall()
    objs = conn.execute("SELECT id, name, project_id, status, kind FROM objects ORDER BY name COLLATE NOCASE").fetchall()
    by_project: dict = {}
    for o in objs:
        by_project.setdefault(o["project_id"], []).append(o)
    admin = is_system_admin(target)
    grants = conn.execute("SELECT project_id, object_id, role FROM user_access WHERE user_id = ?", (target["id"],)).fetchall()
    all_roles = sorted({g["role"] for g in grants if g["project_id"] is None and g["object_id"] is None})
    out_projects = []
    n_projects = n_objects = 0
    for p in projects:
        proj_roles = sorted({g["role"] for g in grants if g["object_id"] is None and g["project_id"] == p["id"]})
        rows = []
        for o in by_project.get(p["id"], []):
            if admin:
                roles = []
                accessible = True
            else:
                keys = object_role_keys(conn, target, o["id"])
                accessible = bool(keys)
                src = _sources_of(conn, target["id"], o["id"], p["id"]) if accessible else {}
                roles = [{"key": k, "name": labels.get(k, k), "sources": src.get(k, [])} for k in sorted(keys)]
            if accessible:
                rows.append({"id": o["id"], "name": o["name"], "status": o["status"] or "active", "kind": o["kind"] or "zhbi", "roles": roles})
        counted = admin or bool(rows) or bool(proj_roles)
        if not counted:
            continue
        n_projects += 1
        n_objects += len(rows)
        out_projects.append({
            "id": p["id"], "name": p["name"], "status": p["status"] or "active",
            "project_roles": [{"key": k, "name": labels.get(k, k)} for k in proj_roles],
            "objects_total": len(by_project.get(p["id"], [])),
            "objects": rows,
        })
    return {
        "user_id": target["id"], "system_admin": admin,
        "all_projects_roles": [{"key": k, "name": labels.get(k, k)} for k in all_roles],
        "projects": out_projects,
        "totals": {"projects": n_projects, "objects": n_objects},
    }


@router.get("/users/{user_id}/access-summary")
def user_access_summary(user_id: int, admin: sqlite3.Row = Depends(require_service_feature("users", "read"))):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        return access_summary(conn, row)
    finally:
        conn.close()


@router.get("/me/access-summary")
def my_access_summary(user: sqlite3.Row = Depends(get_current_user)):
    """То же о самом себе — для любого вошедшего (без права на раздел «Пользователи»)."""
    conn = get_connection()
    try:
        return access_summary(conn, user)
    finally:
        conn.close()


# ----------------------------------------------------------------- групповая выдача доступа

class BulkGrant(BaseModel):
    project_id: Optional[int] = None
    object_id: Optional[int] = None
    role: str


class BulkChange(BaseModel):
    user_id: int
    # Системная роль: None — не менять.
    role: Optional[str] = None
    # Новый ПОЛНЫЙ набор грантов человека: None — не менять.
    grants: Optional[list[BulkGrant]] = None
    # Что форма видела при открытии (для проверки «данные устарели»): None — не проверять.
    expected_role: Optional[str] = None
    expected_grants: Optional[list[BulkGrant]] = None


class BulkIn(BaseModel):
    changes: list[BulkChange]
    dry_run: bool = False


def _gkey(g) -> tuple:
    return (g.project_id, g.object_id, g.role) if not isinstance(g, sqlite3.Row) else (g["project_id"], g["object_id"], g["role"])


def _glabel(conn, key: tuple, labels: dict) -> str:
    project_id, object_id, role = key
    if project_id is None and object_id is None:
        where = "все проекты"
    elif object_id is None:
        r = conn.execute("SELECT name FROM projects WHERE id = ?", (project_id,)).fetchone()
        where = f"проект «{r['name'] if r else project_id}»"
    else:
        r = conn.execute("SELECT o.name AS o, p.name AS p FROM objects o LEFT JOIN projects p ON p.id = o.project_id WHERE o.id = ?", (object_id,)).fetchone()
        where = f"{r['p'] if r else '?'} / {r['o'] if r else object_id}"
    return f"{labels.get(role, role)} — {where}"


def _validate_bulk(conn, body: BulkIn, admin: sqlite3.Row) -> dict:
    if not body.changes:
        raise HTTPException(status_code=400, detail="Нет изменений")
    if len(body.changes) > MAX_BULK_USERS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_BULK_USERS} пользователей за одну операцию")
    if len({c.user_id for c in body.changes}) != len(body.changes):
        raise HTTPException(status_code=400, detail="Пользователь указан в операции дважды")
    known_roles = set(role_keys(conn))
    total = 0
    from app.users import VALID_ROLES
    projects = {r["id"] for r in conn.execute("SELECT id FROM projects")}
    objects = {r["id"]: r["project_id"] for r in conn.execute("SELECT id, project_id FROM objects")}
    users = {}
    for c in body.changes:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (c.user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Пользователь {c.user_id} не найден")
        users[c.user_id] = row
        if c.role is not None and c.role not in VALID_ROLES:
            raise HTTPException(status_code=422, detail=f"Неизвестная системная роль: {c.role}")
        # Снять роль администратора сервиса с самого себя нельзя (то же правило, что в PATCH /users/{id}).
        if c.user_id == admin["id"] and is_system_admin(row) and c.role is not None and c.role != "admin":
            raise HTTPException(status_code=409, detail="Нельзя снять роль администратора сервиса с самого себя: вернуть её будет некому. Попросите об этом другого администратора")
        for g in (c.grants or []):
            total += 1
            if g.role not in known_roles:
                raise HTTPException(status_code=400, detail=f"Неизвестная роль «{g.role}»")
            if g.object_id is not None and g.project_id is None:
                raise HTTPException(status_code=400, detail="Грант на объект должен указывать и проект")
            if g.project_id is not None and g.project_id not in projects:
                raise HTTPException(status_code=404, detail="Проект не найден")
            if g.object_id is not None:
                if g.object_id not in objects:
                    raise HTTPException(status_code=404, detail="Объект не найден")
                if objects[g.object_id] != g.project_id:
                    raise HTTPException(status_code=400, detail="Объект не принадлежит выбранному проекту")
        keys = [_gkey(g) for g in (c.grants or [])]
        if len(set(keys)) != len(keys):
            raise HTTPException(status_code=400, detail="В наборе есть повторяющиеся роли на одном уровне")
        if c.grants is None and c.role is None:
            raise HTTPException(status_code=400, detail="Для пользователя не указано, что менять")
    if total > MAX_BULK_GRANTS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_BULK_GRANTS} назначений за одну операцию")
    return users


@router.post("/users/access-bulk")
def access_bulk(body: BulkIn, admin: sqlite3.Row = Depends(require_service_feature("users", "write"))):
    """Групповая правка доступа: всё или ничего. `dry_run` — только предпросмотр (без записи и без журнала)."""
    conn = get_connection()
    events = activity.defer_begin()      # события уходят в журнал ТОЛЬКО после commit
    try:
        if not body.dry_run:
            begin_write(conn)            # блокировка записи ДО чтения состояния и проверки «устарело»
        users = _validate_bulk(conn, body, admin)
        labels = role_labels(conn)
        stale, report = [], []
        for c in body.changes:
            row = users[c.user_id]
            cur = conn.execute("SELECT project_id, object_id, role FROM user_access WHERE user_id = ?", (c.user_id,)).fetchall()
            cur_keys = {_gkey(g) for g in cur}
            name = f"{row['last_name']} {row['first_name']}".strip() or row["domain_login"]
            if c.expected_role is not None and c.expected_role != row["role"]:
                stale.append({"user_id": c.user_id, "user": name, "what": "системная роль"})
            if c.expected_grants is not None and {_gkey(g) for g in c.expected_grants} != cur_keys:
                stale.append({"user_id": c.user_id, "user": name, "what": "доступ к проектам и объектам"})
            new_keys = {_gkey(g) for g in c.grants} if c.grants is not None else cur_keys
            added, removed = sorted(new_keys - cur_keys, key=str), sorted(cur_keys - new_keys, key=str)
            role_change = c.role is not None and c.role != row["role"]
            if not (added or removed or role_change):
                continue
            report.append({
                "user_id": c.user_id, "user": name, "system_admin": is_system_admin(row),
                "role_from": row["role"] if role_change else None, "role_to": c.role if role_change else None,
                "added": [_glabel(conn, k, labels) for k in added], "removed": [_glabel(conn, k, labels) for k in removed],
                "_new": sorted(new_keys, key=str) if c.grants is not None else None,
            })
        if stale:
            raise HTTPException(status_code=409, detail={
                "message": "Данные устарели: пока форма была открыта, доступ кто-то изменил. Ничего не сохранено — обновите данные и повторите.",
                "stale": stale})
        result = {"dry_run": body.dry_run, "applied": False, "changed": len(report),
                  "added": sum(len(r["added"]) for r in report), "removed": sum(len(r["removed"]) for r in report),
                  "roles_changed": sum(1 for r in report if r["role_to"]), "users": []}
        if not body.dry_run:
            for r in report:
                if r["role_to"]:
                    conn.execute("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", (r["role_to"], r["user_id"]))
                if r["_new"] is not None:
                    conn.execute("DELETE FROM user_access WHERE user_id = ?", (r["user_id"],))
                    for (pid, oid, role) in r["_new"]:
                        conn.execute("INSERT INTO user_access (user_id, project_id, object_id, role) VALUES (?, ?, ?, ?)", (r["user_id"], pid, oid, role))
            conn.commit()
            for r in report:
                if r["role_to"]:
                    activity.log("user_update", user=admin, entity_type="user", entity_id=r["user_id"], old_value=f"системная роль {r['role_from']}", new_value=f"системная роль {r['role_to']} (групповая правка)")
                if r["_new"] is not None:
                    activity.log("access_replace", user=admin, entity_type="user", entity_id=r["user_id"], old_value=f"снято {len(r['removed'])}", new_value=f"выдано {len(r['added'])} (групповая правка)")
            activity.log("access_bulk", user=admin, new_value=f"пользователей: {len(report)}, выдано {result['added']}, снято {result['removed']}, системных ролей изменено {result['roles_changed']}")
            activity.defer_flush(events)
            result["applied"] = True
        result["users"] = [{k: v for k, v in r.items() if not k.startswith("_")} for r in report]
        return result
    finally:
        activity.defer_end(events)
        conn.close()

"""Привязка расчётов к проекту ЖБИ (по умолчанию «Москвич»).

Проект в ЖБИ НЕ создаётся: он заведён людьми, и автоматическое заведение на
боевом сервере создало бы дубль при другом написании названия. Не нашли —
расчёты остаются непривязанными, `/api/workspace` отдаёт `linked: false`, а
администратор привязывает вручную (`PUT /calc/api/project-link`).
"""
import os

from .database import PROJECT_ID, audit, now, transaction
from app.db import get_connection

DEFAULT_PROJECT_NAME = "Москвич"


def target_name():
    return (os.environ.get("ZHBI_CALC_PROJECT") or DEFAULT_PROJECT_NAME).strip()


def zhbi_projects():
    conn = get_connection()
    try:
        return [(r["id"], r["name"]) for r in conn.execute("SELECT id, name FROM projects ORDER BY id")]
    finally:
        conn.close()


def find_project(name, projects=None):
    wanted = " ".join(name.casefold().split())
    for pid, pname in (zhbi_projects() if projects is None else projects):
        if " ".join(pname.casefold().split()) == wanted:
            return pid, pname
    return None


def link_project(settings, actor="system"):
    """Идемпотентно. Действующую привязку не трогает, пока проект существует."""
    projects = zhbi_projects()
    with transaction(settings.database_path) as conn:
        row = conn.execute("SELECT zhbi_project_id, zhbi_project_name FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
        if row is None:
            return {"linked": False, "reason": "calc-project-missing"}
        if row["zhbi_project_id"] is not None and any(p == row["zhbi_project_id"] for p, _ in projects):
            current = next(n for p, n in projects if p == row["zhbi_project_id"])
            if current != row["zhbi_project_name"]:
                conn.execute("UPDATE projects SET zhbi_project_name=? WHERE id=?", (current, PROJECT_ID))
            return {"linked": True, "projectId": row["zhbi_project_id"], "projectName": current}
        found = find_project(target_name(), projects)
        if not found:
            return {"linked": False, "reason": "not-found", "wanted": target_name()}
        conn.execute("UPDATE projects SET zhbi_project_id=?, zhbi_project_name=? WHERE id=?", (found[0], found[1], PROJECT_ID))
        audit(conn, actor, "project.linked", PROJECT_ID, {"zhbiProjectId": found[0], "name": found[1], "at": now()})
        return {"linked": True, "projectId": found[0], "projectName": found[1]}


def set_link(settings, zhbi_project_id, actor):
    found = next(((p, n) for p, n in zhbi_projects() if p == zhbi_project_id), None)
    if not found:
        return None
    with transaction(settings.database_path) as conn:
        conn.execute("UPDATE projects SET zhbi_project_id=?, zhbi_project_name=? WHERE id=?", (found[0], found[1], PROJECT_ID))
        audit(conn, actor, "project.linked", PROJECT_ID, {"zhbiProjectId": found[0], "name": found[1], "manual": True})
    return {"linked": True, "projectId": found[0], "projectName": found[1]}

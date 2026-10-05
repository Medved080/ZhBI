"""Права по проектной команде (2026-10-05, протокол «Развитие WEB 4Q26», B2).

Идея заказчика: роли — это люди из перечня объектов (колонки «Директор СМУ», «Директор проекта», «Руководитель проекта»,
«Проектный офис», «Сметный отдел», «ПТО», «Снабжение», «Нач. участка», «ГИП»). Назначили человека на роль на объекте — ему на
ЭТОМ объекте открываются рабочие места, которые положены такой роли. Здесь нет второй системы прав: выдаются обычные гранты
`user_access` (object_id + системная роль из `object_roles`), а что именно положено каждой роли команды, задаёт
сопоставление `team_role_access` («роль команды → системные роли»). По умолчанию оно ПУСТО — ничего не выдаётся, пока
администратор не заполнит его (решение пользователя).

**Человек ↔ учётная запись.** В команде человек — запись справочника физлиц (`individuals.name`, чаще «Фамилия И. О.»), а
учётная запись — `users` с полным ФИО. Сопоставление:
1. явная привязка (`individual_user_links`): администратор выбрал учётную запись, либо «не сопоставлять» (user_id = NULL);
2. иначе автоматически — только при ОДНОЗНАЧНОМ совпадении «фамилия + инициалы» (отчество учитывается, если оно заполнено у обеих
   сторон). Несколько кандидатов или ни одного — права не выдаются: ошибочное сопоставление выдало бы доступ не тому человеку,
   поэтому неоднозначность не разрешается угадыванием, а показывается администратору на экране «Права по команде».

**Выданное по команде** — те же строки `user_access`, но помеченные в `team_access_grants` (грант + роль команды, из-за которой он
выдан). Один грант может держаться на нескольких ролях команды (человек — и ГИП, и РП, а обе дают «Наблюдателя»): он снимается,
только когда не осталось ни одного основания. Выданное вручную (то же сочетание пользователь/объект/роль уже было) не
помечается и никогда не снимается автоматически. Пересчёт идёт при любом изменении команды, сопоставления, привязок, учётных
записей и справочника физлиц (`sync_all`).
"""

import json
import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import require_service_feature
from app.db import begin_write, get_connection
from app.object_team import ROLE_LABELS, TEAM_ROLES

router = APIRouter(prefix="/team-access", tags=["team-access"])

# «Директор СМУ» живёт колонкой objects.smu_director_id, но в сопоставлении ролей он — такая же роль команды.
SMU_DIRECTOR_KEY = "smu_director"
ACCESS_TEAM_ROLES = [(SMU_DIRECTOR_KEY, "Директор СМУ")] + list(TEAM_ROLES)
ACCESS_ROLE_LABELS = dict(ACCESS_TEAM_ROLES)


# --------------------------------------------------------------- сопоставление ФИО

def _words(text) -> list:
    """Слова ФИО в нижнем регистре, ё = е, без точек и запятых («Иванов И. О.» → [иванов, и, о])."""
    cleaned = re.sub(r"[.,]+", " ", str(text or "").lower().replace("ё", "е"))
    return [w for w in cleaned.split() if w]


def parse_person(text) -> tuple:
    """(фамилия, инициалы) из «Фамилия И. О.», «Фамилия ИО» и «Фамилия Имя Отчество»; инициалы — строка букв («ио»)."""
    words = _words(text)
    if not words:
        return "", ""
    surname, rest = words[0], words[1:]
    # «Иванов ИО» / «Иванов И.О.»: после фамилии одно слово из 1–2 букв — инициалы слитно
    if len(rest) == 1 and len(rest[0]) <= 2:
        return surname, rest[0]
    return surname, "".join(w[0] for w in rest)


def user_key(row) -> tuple:
    """(фамилия, имя-инициал, отчество-инициал | '') учётной записи."""
    last = (_words(row["last_name"]) or [""])[0]
    first = (_words(row["first_name"]) or [""])[0][:1]
    patr = (_words(row["patronymic"]) or [""])[0][:1]
    return last, first, patr


def _compatible(person: tuple, key: tuple) -> bool:
    surname, initials = person
    last, first, patr = key
    if not surname or surname != last:
        return False
    if len(initials) >= 1 and first and initials[0] != first:
        return False
    if len(initials) >= 2 and patr and initials[1] != patr:
        return False
    # без инициалов совпадение по одной фамилии слишком слабое — не считается
    return len(initials) >= 1


def resolve_accounts(conn, individual_ids=None) -> dict:
    """individual_id -> {"user_id", "how": "link"|"auto"|"none"|"ambiguous"|"missing", "candidates": [user_id]}"""
    users = conn.execute("SELECT id, last_name, first_name, patronymic FROM users").fetchall()
    keys = {u["id"]: user_key(u) for u in users}
    links = {r["individual_id"]: r["user_id"] for r in conn.execute("SELECT individual_id, user_id FROM individual_user_links")}
    out = {}
    for ind in conn.execute("SELECT id, name FROM individuals"):
        if individual_ids is not None and ind["id"] not in individual_ids:
            continue
        if ind["id"] in links:
            uid = links[ind["id"]]
            out[ind["id"]] = ({"user_id": uid, "how": "link", "candidates": []} if uid is not None and uid in keys
                              else {"user_id": None, "how": "none", "candidates": []})
            continue
        person = parse_person(ind["name"])
        found = [uid for uid, key in keys.items() if _compatible(person, key)]
        if len(found) == 1:
            out[ind["id"]] = {"user_id": found[0], "how": "auto", "candidates": found}
        else:
            out[ind["id"]] = {"user_id": None, "how": "ambiguous" if found else "missing", "candidates": found}
    return out


# --------------------------------------------------------------- пересчёт грантов

def _assignments(conn, object_ids=None) -> list:
    """[(individual_id, object_id, team_role_key)] — все назначения, включая директора СМУ."""
    rows = [(r["individual_id"], r["object_id"], r["role_key"]) for r in conn.execute(
        "SELECT individual_id, object_id, role_key FROM object_team_members")]
    rows += [(r["smu_director_id"], r["id"], SMU_DIRECTOR_KEY) for r in conn.execute(
        "SELECT id, smu_director_id FROM objects WHERE smu_director_id IS NOT NULL")]
    if object_ids is not None:
        wanted = set(object_ids)
        rows = [r for r in rows if r[1] in wanted]
    return rows


def sync_all(conn, object_ids=None) -> dict:
    """Привести гранты «по команде» в соответствие с командами, сопоставлением ролей и учётными записями.
    Работает в транзакции вызывающего (коммит — его). `object_ids` — только эти объекты (пересчёт после правки одного)."""
    mapping: dict = {}
    for r in conn.execute("SELECT team_role_key, role_key FROM team_role_access"):
        mapping.setdefault(r["team_role_key"], set()).add(r["role_key"])
    assignments = _assignments(conn, object_ids)
    accounts = resolve_accounts(conn, {a[0] for a in assignments})
    project_of = {r["id"]: r["project_id"] for r in conn.execute("SELECT id, project_id FROM objects")}

    # желаемое: (user_id, project_id, object_id, system_role) -> {роли команды-основания}
    desired: dict = {}
    for ind, obj, team_role in assignments:
        acc = accounts.get(ind)
        project = project_of.get(obj)
        if not acc or acc["user_id"] is None or project is None:
            continue
        for system_role in mapping.get(team_role, ()):
            desired.setdefault((acc["user_id"], project, obj, system_role), set()).add(team_role)

    granted = revoked = 0
    scope = "" if object_ids is None else f" AND g.object_id IN ({','.join('?' * len(set(object_ids)))})"
    scope_params = [] if object_ids is None else list(set(object_ids))
    existing_links = conn.execute(
        "SELECT g.grant_id, g.team_role_key, g.object_id, ua.user_id, ua.project_id, ua.role "
        f"FROM team_access_grants g JOIN user_access ua ON ua.id = g.grant_id WHERE 1 = 1{scope}", scope_params).fetchall()
    derived_by_key = {}
    for r in existing_links:
        derived_by_key.setdefault((r["user_id"], r["project_id"], r["object_id"], r["role"]), {})[r["team_role_key"]] = r["grant_id"]

    for key, reasons in desired.items():
        user_id, project, obj, system_role = key
        row = conn.execute(
            "SELECT id FROM user_access WHERE user_id = ? AND project_id = ? AND object_id = ? AND role = ?",
            (user_id, project, obj, system_role)).fetchone()
        if row is None:
            conn.execute("INSERT INTO user_access (user_id, project_id, object_id, role) VALUES (?, ?, ?, ?)",
                         (user_id, project, obj, system_role))
            grant_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            granted += 1
        elif key in derived_by_key:
            grant_id = row["id"]
        else:
            continue   # такой грант выдан вручную — не трогаем и не помечаем
        for team_role in reasons:
            conn.execute("INSERT OR IGNORE INTO team_access_grants (grant_id, team_role_key, object_id) VALUES (?, ?, ?)",
                         (grant_id, team_role, obj))

    # снять основания, которых больше нет, и грант без оснований
    for key, reasons_map in derived_by_key.items():
        wanted = desired.get(key, set())
        for team_role, grant_id in reasons_map.items():
            if team_role not in wanted:
                conn.execute("DELETE FROM team_access_grants WHERE grant_id = ? AND team_role_key = ?", (grant_id, team_role))
        left = conn.execute("SELECT COUNT(*) AS n FROM team_access_grants WHERE grant_id = ?",
                            (next(iter(reasons_map.values())),)).fetchone()["n"]
        if not left:
            conn.execute("DELETE FROM user_access WHERE id = ?", (next(iter(reasons_map.values())),))
            revoked += 1
    if granted or revoked:
        activity.log("team_access_sync", user_name="система (проектная команда)", entity_type="object",
                     details={"granted": granted, "revoked": revoked, "objects": None if object_ids is None else sorted(set(object_ids))})
    return {"granted": granted, "revoked": revoked}


def derived_grant_ids(conn, user_id: int) -> set:
    """id грантов пользователя, выданных по команде (их ручная замена не трогает)."""
    return {r["grant_id"] for r in conn.execute(
        "SELECT g.grant_id FROM team_access_grants g JOIN user_access ua ON ua.id = g.grant_id WHERE ua.user_id = ?", (user_id,))}


# --------------------------------------------------------------- экран «Права по команде»

class MappingIn(BaseModel):
    mapping: dict   # {роль команды: [ключи системных ролей]}


class LinkIn(BaseModel):
    mode: str                    # "auto" — снять явную привязку; "none" — не сопоставлять; "user" — привязать к user_id
    user_id: Optional[int] = None


def _user_name(row) -> str:
    return " ".join(p for p in (row["last_name"], row["first_name"], row["patronymic"]) if p)


@router.get("")
def team_access_overview(admin: sqlite3.Row = Depends(require_service_feature("users", "read"))):
    conn = get_connection()
    try:
        roles = [{"key": r["key"], "name": r["name"]} for r in conn.execute("SELECT key, name FROM object_roles ORDER BY rank")]
        mapping: dict = {}
        for r in conn.execute("SELECT team_role_key, role_key FROM team_role_access"):
            mapping.setdefault(r["team_role_key"], []).append(r["role_key"])
        assignments = _assignments(conn)
        accounts = resolve_accounts(conn, {a[0] for a in assignments})
        users = conn.execute("SELECT id, last_name, first_name, patronymic, domain_login FROM users ORDER BY last_name, first_name").fetchall()
        user_by_id = {u["id"]: u for u in users}
        names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM individuals")}
        objects = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM objects")}
        grants = {}
        for r in conn.execute("SELECT ua.user_id AS uid, COUNT(DISTINCT g.grant_id) AS n FROM team_access_grants g "
                              "JOIN user_access ua ON ua.id = g.grant_id GROUP BY ua.user_id"):
            grants[r["uid"]] = r["n"]
        people: dict = {}
        for ind, obj, team_role in assignments:
            p = people.setdefault(ind, {"individual_id": ind, "name": names.get(ind), "assignments": []})
            p["assignments"].append({"object_id": obj, "object_name": objects.get(obj),
                                     "team_role": team_role, "team_role_label": ACCESS_ROLE_LABELS.get(team_role, team_role)})
        out = []
        for ind, p in sorted(people.items(), key=lambda kv: str(kv[1]["name"]).lower()):
            acc = accounts.get(ind, {"user_id": None, "how": "missing", "candidates": []})
            u = user_by_id.get(acc["user_id"])
            p["account"] = {"user_id": acc["user_id"], "user_name": _user_name(u) if u else None, "how": acc["how"],
                            "candidates": [{"id": c, "name": _user_name(user_by_id[c])} for c in acc["candidates"] if c in user_by_id]}
            p["team_grants"] = grants.get(acc["user_id"], 0) if acc["user_id"] else 0
            out.append(p)
        return {
            "team_roles": [{"key": k, "label": label} for k, label in ACCESS_TEAM_ROLES],
            "system_roles": roles, "mapping": mapping, "people": out,
            "users": [{"id": u["id"], "name": _user_name(u), "login": u["domain_login"]} for u in users],
        }
    finally:
        conn.close()


@router.put("/mapping")
def replace_mapping(body: MappingIn, admin: sqlite3.Row = Depends(require_service_feature("users", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        known_roles = {r["key"] for r in conn.execute("SELECT key FROM object_roles")}
        clean = {}
        for team_role, system_roles in (body.mapping or {}).items():
            if team_role not in ACCESS_ROLE_LABELS:
                raise HTTPException(status_code=400, detail=f"Неизвестная роль команды «{team_role}»")
            if not isinstance(system_roles, list):
                raise HTTPException(status_code=400, detail=f"{ACCESS_ROLE_LABELS[team_role]}: ожидается список ролей")
            bad = [x for x in system_roles if x not in known_roles]
            if bad:
                raise HTTPException(status_code=400, detail=f"{ACCESS_ROLE_LABELS[team_role]}: неизвестная роль «{bad[0]}»")
            clean[team_role] = sorted(set(system_roles))
        before = {(r["team_role_key"], r["role_key"]) for r in conn.execute("SELECT team_role_key, role_key FROM team_role_access")}
        conn.execute("DELETE FROM team_role_access")
        for team_role, system_roles in clean.items():
            for system_role in system_roles:
                conn.execute("INSERT INTO team_role_access (team_role_key, role_key) VALUES (?, ?)", (team_role, system_role))
        result = sync_all(conn)
        conn.commit()
    finally:
        conn.close()
    after = {(t, r) for t, rs in clean.items() for r in rs}
    activity.log("team_access_mapping", user=admin, entity_type="team_access",
                 old_value=json.dumps(sorted(before), ensure_ascii=False)[:500],
                 new_value=json.dumps(sorted(after), ensure_ascii=False)[:500], details=result)
    return {"mapping": {t: sorted(r) for t, r in clean.items()}, **result}


@router.put("/links/{individual_id}")
def set_link(individual_id: int, body: LinkIn, admin: sqlite3.Row = Depends(require_service_feature("users", "write"))):
    conn = get_connection()
    try:
        begin_write(conn)
        if conn.execute("SELECT 1 FROM individuals WHERE id = ?", (individual_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Физлицо не найдено")
        if body.mode == "auto":
            conn.execute("DELETE FROM individual_user_links WHERE individual_id = ?", (individual_id,))
        elif body.mode == "none":
            conn.execute("INSERT INTO individual_user_links (individual_id, user_id) VALUES (?, NULL) "
                         "ON CONFLICT (individual_id) DO UPDATE SET user_id = NULL", (individual_id,))
        elif body.mode == "user":
            if body.user_id is None or conn.execute("SELECT 1 FROM users WHERE id = ?", (body.user_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Учётная запись не найдена")
            conn.execute("INSERT INTO individual_user_links (individual_id, user_id) VALUES (?, ?) "
                         "ON CONFLICT (individual_id) DO UPDATE SET user_id = excluded.user_id", (individual_id, body.user_id))
        else:
            raise HTTPException(status_code=400, detail="Режим привязки: auto, none или user")
        result = sync_all(conn)
        conn.commit()
    finally:
        conn.close()
    activity.log("team_access_link", user=admin, entity_type="individual", entity_id=individual_id,
                 new_value=f"{body.mode}{'' if body.user_id is None else ' → пользователь %d' % body.user_id}", details=result)
    return {"individual_id": individual_id, "mode": body.mode, **result}

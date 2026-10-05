"""Проектная команда объекта (2026-10-05, протокол «Развитие WEB 4Q26», B1).

Роли команды — те, что заказчик ведёт в перечне объектов («Справочник ОС WEB»): директор проекта, руководитель проекта,
проектный офис, сметный отдел, ПТО, снабжение, начальник участка, ГИП. «Директор СМУ» в этот список НЕ входит: он давно
хранится колонкой `objects.smu_director_id` и показывается рядом с СМУ.

Человек — запись справочника физлиц (`individuals`, как директор СМУ и ответственный): так одного и того же человека можно
переименовать разом, а выбор в форме не плодит опечатки. Хранение — `object_team_members`, одна запись на пару (объект, роль);
пустая роль — отсутствие записи. Назначение роли пользователю с правами (чтобы ему открывались нужные рабочие места) — отдельный
блок B2 и сюда не входит.
"""

from typing import Optional

from fastapi import HTTPException

# (ключ, подпись) — порядок показа в форме и в файле.
TEAM_ROLES = [
    ("dir_project", "Директор проекта"),
    ("head_project", "Руководитель проекта"),
    ("pm_office", "Проектный офис"),
    ("estimate", "Сметный отдел"),
    ("pto", "ПТО"),
    ("supply", "Снабжение"),
    ("site_chief", "Нач. участка"),
    ("gip", "ГИП"),
]
ROLE_LABELS = dict(TEAM_ROLES)


def teams_by_object(conn, object_ids=None) -> dict:
    """object_id -> {role_key: {"id", "name"}} одним запросом на все объекты (список объектов строится на сотни строк)."""
    rows = conn.execute(
        "SELECT t.object_id, t.role_key, i.id AS individual_id, i.name AS name "
        "FROM object_team_members t JOIN individuals i ON i.id = t.individual_id").fetchall()
    out: dict = {}
    wanted = None if object_ids is None else set(object_ids)
    for r in rows:
        if wanted is not None and r["object_id"] not in wanted:
            continue
        if r["role_key"] in ROLE_LABELS:
            out.setdefault(r["object_id"], {})[r["role_key"]] = {"id": r["individual_id"], "name": r["name"]}
    return out


def team_signature(team: Optional[dict]) -> str:
    """Отпечаток состава команды — часть версии записи объекта (проверка «запись устарела» учитывает и команду)."""
    return "|".join(f"{k}:{(team or {}).get(k, {}).get('id', '')}" for k, _ in TEAM_ROLES)


def validate_team_edit(conn, edit: dict) -> dict:
    """Проверка присланных назначений {role_key: id | None}: роль известна, физлицо есть в справочнике.
    None снимает назначение. Незнакомая роль — отказ, а не молчаливый пропуск: опечатка в ключе иначе выглядела бы как успех."""
    clean = {}
    for role, value in (edit or {}).items():
        if role not in ROLE_LABELS:
            raise HTTPException(status_code=400, detail=f"Неизвестная роль проектной команды «{role}»")
        if value is not None:
            if not isinstance(value, int) or isinstance(value, bool):
                raise HTTPException(status_code=400, detail=f"{ROLE_LABELS[role]}: ожидается идентификатор физлица")
            if conn.execute("SELECT 1 FROM individuals WHERE id = ?", (value,)).fetchone() is None:
                raise HTTPException(status_code=404, detail=f"{ROLE_LABELS[role]}: физлицо не найдено в справочнике")
        clean[role] = value
    return clean


def write_team(conn, object_id: int, edit: dict) -> list:
    """Записать назначения (уже проверенные validate_team_edit); возвращает список изменённых ролей для журнала:
    [(role_key, было_имя | None, стало_имя | None)]."""
    changed = []
    names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM individuals")}
    current = {r["role_key"]: r["individual_id"] for r in conn.execute(
        "SELECT role_key, individual_id FROM object_team_members WHERE object_id = ?", (object_id,))}
    for role, value in edit.items():
        before = current.get(role)
        if before == value:
            continue
        if value is None:
            conn.execute("DELETE FROM object_team_members WHERE object_id = ? AND role_key = ?", (object_id, role))
        else:
            conn.execute(
                "INSERT INTO object_team_members (object_id, role_key, individual_id) VALUES (?, ?, ?) "
                "ON CONFLICT (object_id, role_key) DO UPDATE SET individual_id = excluded.individual_id, "
                "updated_at = datetime('now')", (object_id, role, value))
        changed.append((role, names.get(before), names.get(value)))
    if changed:
        # Назначение на роль меняет и права (B2): пересчёт — в той же транзакции, что и сама запись команды.
        from app import team_access
        team_access.sync_all(conn, [object_id])
    return changed

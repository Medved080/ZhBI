"""
Доступ к объектам и роли на них (этап C, 2026-08-01).

**Роль перестала быть свойством пользователя и стала свойством ГРАНТА**
(решение П2): один и тот же человек бывает прорабом на одном здании и
наблюдателем на соседнем. `users.role` осталась СИСТЕМНОЙ ролью — она про
ведение сервиса (пользователи, проекты, объекты, резервные копии), а не
про стройку.

Грант живёт в `user_access(user_id, project_id, object_id, role)` и ложится
на один из ТРЁХ уровней (третий добавлен 2026-08-02):

  оба поля NULL          — все проекты, включая те, что появятся позже;
  задан только project_id — весь проект, включая будущие объекты в нём;
  задан object_id         — конкретный объект.

Действующая роль ищется от САМОГО ЧАСТНОГО к общему: объект -> проект ->
все проекты -> доступа нет. Частный перекрывает общий, иначе выдача
«просмотр на все стройки» отняла бы у человека полные права там, где они
у него есть.

**Системный администратор видит и правит всё** в обход грантов. Иначе
первый же неверный грант запирал бы систему: выдать доступ было бы некому.

Почему проверка здесь, а не в каждом эндпоинте по месту: мест 54, и
пропущенное даёт либо дыру (чужой объект открыт), либо мёртвую кнопку
(своя операция запрещена). Одна таблица соответствий и четыре зависимости
— единственный способ пройти этот список один раз и потом видеть его
целиком.
"""

import sqlite3
from typing import Optional

from fastapi import Depends, HTTPException, Query

from app.auth import get_current_user
from app.db import get_connection

# Роли НА ОБЪЕКТЕ, по возрастанию прав. Порядок — основание для сравнения
# «не ниже требуемой», поэтому список один и здесь.
OBJECT_ROLES = ["view", "user", "admin"]
ROLE_LABELS = {
    "view": "Просмотр",
    "user": "Работа со статусами",
    "admin": "Полные права на объекте",
}


def is_system_admin(user: sqlite3.Row) -> bool:
    return user["role"] == "admin"


# Грант ложится на один из трёх уровней; чем ЧАСТНЕЕ, тем он главнее.
# Значение — «точность», по ней и сортируем: 0 перекрывает 1, 1 — 2.
_УРОВЕНЬ_ГРАНТА = """
    CASE WHEN ua.object_id IS NOT NULL THEN 0    -- конкретный объект
         WHEN ua.project_id IS NOT NULL THEN 1   -- весь проект
         ELSE 2 END                              -- все проекты
"""

# Какие гранты вообще относятся к объекту o. Три уровня перечислены явно, а
# не сведены к «object_id IS NULL» — иначе общий грант нельзя было бы
# отличить от проектного, и «все проекты» действовал бы как грант на тот
# проект, чей id случайно оказался в строке.
_ГРАНТ_ПОДХОДИТ = """
    ua.object_id = o.id
    OR (ua.object_id IS NULL AND ua.project_id = o.project_id)
    OR (ua.object_id IS NULL AND ua.project_id IS NULL)
"""


def object_role(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int) -> Optional[str]:
    """Действующая роль пользователя на объекте или None, если доступа нет.

    Три уровня, от частного к общему: грант на объект -> грант на проект ->
    грант на все проекты. Частный ПЕРЕКРЫВАЕТ общий — иначе невозможно было
    бы понизить или повысить права на одном здании, не трогая остальные, и
    выдача «просмотр всем стройкам» отняла бы у человека полные права там,
    где они у него есть.
    """
    if is_system_admin(user):
        return "admin"
    row = conn.execute(
        f"""
        SELECT ua.role, {_УРОВЕНЬ_ГРАНТА} AS точность
        FROM user_access ua
        JOIN objects o ON o.id = ?
        WHERE ua.user_id = ? AND ({_ГРАНТ_ПОДХОДИТ})
        ORDER BY точность
        LIMIT 1
        """,
        (object_id, user["id"]),
    ).fetchone()
    return row["role"] if row else None


def accessible_object_ids(conn: sqlite3.Connection, user: sqlite3.Row) -> Optional[set]:
    """Объекты, доступные пользователю. None — доступны ВСЕ (системный
    администратор): это не то же самое, что пустое множество, и путать их
    нельзя — пустое означает «не доступно ничего»."""
    if is_system_admin(user):
        return None
    rows = conn.execute(
        f"""
        SELECT o.id
        FROM objects o
        JOIN user_access ua ON ua.user_id = ? AND ({_ГРАНТ_ПОДХОДИТ})
        """,
        (user["id"],),
    ).fetchall()
    return {r["id"] for r in rows}


def object_roles(conn: sqlite3.Connection, user: sqlite3.Row) -> dict:
    """Действующая роль на КАЖДОМ доступном объекте: {object_id: role}.

    То же правило, что и в object_role (частный грант перекрывает общий),
    но одним запросом на все объекты сразу — иначе
    переключатель объектов делал бы запрос на каждый пункт списка.

    Нужно интерфейсу: пункты меню гасятся по роли НА ПОКАЗЫВАЕМОМ
    объекте, а не по системной роли. Без этого сервер разрешает
    администратору объекта править свои зоны и настройки, а меню ему их
    не показывает — разрешение есть, дотянуться нельзя.
    """
    if is_system_admin(user):
        return {r["id"]: "admin" for r in conn.execute("SELECT id FROM objects")}
    роли = {}
    for r in conn.execute(
        f"""
        SELECT o.id AS object_id, ua.role AS role, {_УРОВЕНЬ_ГРАНТА} AS точность
        FROM objects o
        JOIN user_access ua ON ua.user_id = ? AND ({_ГРАНТ_ПОДХОДИТ})
        ORDER BY точность          -- частный грант первым, он перекрывает общий
        """,
        (user["id"],),
    ):
        роли.setdefault(r["object_id"], r["role"])
    return роли


def has_object_access(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int,
                      minimum: str = "view") -> bool:
    role = object_role(conn, user, object_id)
    if role is None:
        return False
    return OBJECT_ROLES.index(role) >= OBJECT_ROLES.index(minimum)


def assert_object_access(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int,
                         minimum: str = "view") -> str:
    """Проверка с внятным отказом. Разные коды намеренно: 404 у объекта,
    которого нет, и 403 у существующего, но чужого — путать их значит либо
    подсказывать о существовании чужих объектов, либо прятать собственную
    ошибку в id."""
    if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    role = object_role(conn, user, object_id)
    if role is None:
        raise HTTPException(status_code=403, detail="Нет доступа к этому объекту")
    if OBJECT_ROLES.index(role) < OBJECT_ROLES.index(minimum):
        raise HTTPException(
            status_code=403,
            detail=f"Недостаточно прав на объекте: нужна роль «{ROLE_LABELS[minimum]}», "
                   f"у вас «{ROLE_LABELS[role]}»",
        )
    return role


def require_system_admin(user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
    """Ведение сервиса: пользователи, проекты, объекты, резервные копии,
    сквозные справочники, журнал действий."""
    if not is_system_admin(user):
        raise HTTPException(status_code=403, detail="Требуются права администратора сервиса")
    return user


def _object_dependency(minimum: str):
    """Фабрика зависимостей «доступ к объекту не ниже роли».

    object_id берётся из query — так его передают эндпоинты, работающие с
    объектом целиком. Там, где объект выводится из другой сущности
    (элемент, зона, контракт), проверка идёт внутри обработчика через
    assert_object_access: узнать объект можно только запросом.
    """
    def dependency(object_id: int = Query(..., description="Объект, к которому относится операция"),
                   user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
        conn = get_connection()
        try:
            assert_object_access(conn, user, object_id, minimum)
        finally:
            conn.close()
        return user
    return dependency


require_object_access = _object_dependency("view")
require_object_editor = _object_dependency("user")
require_object_admin = _object_dependency("admin")

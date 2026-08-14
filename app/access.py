"""
Доступ к объектам и роли на них (этап C, 2026-08-01; роли стали
настраиваемыми и независимыми 2026-08-14).

**Роль — свойство ГРАНТА, а не пользователя** (решение П2): один и тот же
человек бывает прорабом на одном здании и наблюдателем на соседнем.
`users.role` осталась СИСТЕМНОЙ ролью — она про ведение сервиса, а не про
стройку.

**Ролей на объекте бывает НЕСКОЛЬКО, и разрешения складываются**
(решение пользователя 2026-08-14). Лестницы больше нет: ни одна роль не
включает другую, уровень доступа к разделу — МАКСИМУМ по всем ролям
человека. Что может каждая роль, перечислено в `role_features`, что за
разделы бывают — в app/features.py.

Грант живёт в `user_access(user_id, project_id, object_id, role)` и ложится
на один из ТРЁХ уровней:

  оба поля NULL           — все проекты, включая те, что появятся позже;
  задан только project_id — весь проект, включая будущие объекты в нём;
  задан object_id         — конкретный объект.

**Гранты всех трёх уровней СКЛАДЫВАЮТСЯ.** До 2026-08-14 частный грант
перекрывал общий, и это был способ понизить человека на одном здании, не
трогая остальные. Со сложением понизить нельзя — можно только добавить,
и права понижаются иначе: общесервисные гранты («все проекты») не
выдаются вовсе, а роль даётся на каждый объект отдельно, где какая нужна
(решение пользователя, оно же способ работы).

**Системный администратор видит и правит всё** в обход грантов, и отнять
это нельзя ни настройкой ролей, ни правкой собственной учётной записи.
Иначе первый же неверный грант запирал бы систему: выдать доступ было бы
некому.

Почему проверка здесь, а не в каждом эндпоинте по месту: мест полторы
сотни, и пропущенное даёт либо дыру (чужой объект открыт), либо мёртвую
кнопку (своя операция запрещена).
"""

import sqlite3
from typing import Optional

from fastapi import Depends, HTTPException, Query

from app.auth import get_current_user
from app.db import get_connection
from app.features import (
    NONE,
    READ,
    SCOPE_OBJECT,
    SCOPE_SELF,
    WRITE,
    feature,
    stronger,
)

# ------------------------------------------------------------------- роли
#
# Ни лестницы, ни порогов здесь больше нет. Роль — набор разрешений, роли
# независимы, у человека их может быть несколько, и они СКЛАДЫВАЮТСЯ.
#
# Кэша НЕТ намеренно. Таблицы маленькие (роли — единицы, разрешения — сотни
# строк), чтение стоит микросекунды, а кэш в процессе означал бы, что после
# правки ролей один воркер живёт по новым правам, а другой по старым,
# причём расхождение видно только под нагрузкой. Права — не то место, где
# это допустимо.


def role_list(conn: sqlite3.Connection) -> list:
    """Роли в порядке показа: [{key, name, rank}, ...]."""
    return [dict(r) for r in conn.execute(
        "SELECT key, name, rank FROM object_roles ORDER BY rank, id")]


def role_keys(conn: sqlite3.Connection) -> list:
    return [r["key"] for r in conn.execute("SELECT key FROM object_roles ORDER BY rank, id")]


def role_labels(conn: sqlite3.Connection) -> dict:
    return {r["key"]: r["name"] for r in conn.execute("SELECT key, name FROM object_roles")}


def role_level(conn: sqlite3.Connection, roles, key: str) -> str:
    """Уровень доступа НАБОРА ролей к разделу — максимум по набору.

    Пустой набор даёт NONE, и это же ответ для роли, которой раздел не
    выдан: отсутствие строки в role_features означает «Нет». Хранить нули
    незачем, а новый раздел из будущей версии оказывается закрытым, а не
    открытым, — ошибка в безопасную сторону.
    """
    roles = list(roles)
    if not roles:
        return NONE
    marks = ",".join("?" * len(roles))
    итог = NONE
    for r in conn.execute(
        f"SELECT level FROM role_features WHERE feature_key = ? AND role_key IN ({marks})",
        (key, *roles),
    ):
        итог = stronger(итог, r["level"])
    return итог


def has_feature(conn: sqlite3.Connection, user: sqlite3.Row, key: str, kind: str,
                object_id: Optional[int] = None) -> bool:
    """Есть ли у человека доступ к разделу в требуемом объёме.

    Порядок проверок повторяет порядок в самих эндпоинтах, и менять его
    нельзя:

    1. «Своё» (личные настройки) роли не подчиняется вовсе.
    2. Администратор сервиса проходит всё в обход грантов. Отсюда главное
       свойство настройки ролей: ЗАПЕРЕТЬ СИСТЕМУ ЕЮ НЕЛЬЗЯ — что бы
       администратор ни выставил, у него самого доступ остаётся, и выдать
       права снова есть кому. Снять это с себя он тоже не может
       (app/users.py).
    3. Иначе — сумма ролей. Где их искать, решает НАЛИЧИЕ ОБЪЕКТА У
       ВЫЗОВА, а не описание раздела: объект передали — берём роли на нём,
       не передали — все роли человека, где бы они ни были выданы. Признак
       scope в app/features.py остаётся описанием для формы и подсказкой в
       тексте отказа, но правилом проверки не является: справочник марок
       общесервисный, а список марок запрашивается ДЛЯ ОБЪЕКТА, и «хотя бы
       где-то» открыло бы чужие объекты тому, у кого доступ есть к своему.
    """
    if kind not in (READ, WRITE):
        raise ValueError(f"Вид доступа бывает read или write, не {kind!r}")
    раздел = feature(key)
    if раздел.scope == SCOPE_SELF:
        return True
    if is_system_admin(user):
        return True

    if object_id is not None:
        роли = object_role_keys(conn, user, object_id)
    elif раздел.scope == SCOPE_OBJECT:
        # Объектная операция без объекта — ошибка вызова, а не «всё можно».
        return False
    else:
        роли = all_role_keys(conn, user)

    уровень = role_level(conn, роли, key)
    return уровень == WRITE if kind == WRITE else уровень in (READ, WRITE)


def has_any_feature(conn: sqlite3.Connection, user: sqlite3.Row, keys, kind: str,
                    object_id: Optional[int] = None) -> bool:
    """Доступ хотя бы к одному разделу из перечня.

    Нужно там, где ОДИН экран обслуживает несколько разделов: форма
    документов контрактации показывает и «Замену поставщика», и «Обмен
    привязками», а список документов и справочные запросы у них общие.
    Требовать оба значило бы закрыть форму тому, кому выдан один; требовать
    какой-то один поимённо — закрыть её тому, кому выдан другой.
    """
    return any(has_feature(conn, user, k, kind, object_id) for k in keys)


def feature_level_for(conn: sqlite3.Connection, user: sqlite3.Row, key: str,
                      object_id: Optional[int] = None) -> str:
    """Уровень доступа к разделу: none / read / write. Витрина has_feature —
    считает ТЕМИ ЖЕ вызовами, которыми отвечают эндпоинты."""
    if has_feature(conn, user, key, WRITE, object_id):
        return WRITE
    if has_feature(conn, user, key, READ, object_id):
        return READ
    return NONE


def assert_feature(conn: sqlite3.Connection, user: sqlite3.Row, key: str, kind: str,
                   object_id: Optional[int] = None) -> None:
    """Проверка с внятным отказом: человек должен понять, чего ему не хватает."""
    if has_feature(conn, user, key, kind, object_id):
        return
    раздел = feature(key)
    действие = "изменение" if kind == WRITE else "просмотр"
    где = "на объекте" if раздел.scope == SCOPE_OBJECT else "хотя бы на одном объекте"
    подходят = [подпись for ключ, подпись in role_labels(conn).items()
                if role_level(conn, [ключ], key) == WRITE
                or (kind == READ and role_level(conn, [ключ], key) != NONE)]
    хвост = (f"; такое даёт роль: {', '.join(sorted(подходят))}" if подходят
             else "; ни одной роли этот раздел не выдан — только администратору сервиса")
    raise HTTPException(
        status_code=403,
        detail=f"«{раздел.title}»: {действие} требует роли {где}{хвост}")


def is_system_admin(user: sqlite3.Row) -> bool:
    return user["role"] == "admin"


# Грант ложится на один из трёх уровней; чем ЧАСТНЕЕ, тем он главнее.
# Значение — «точность», по ней и сортируем: 0 перекрывает 1, 1 — 2.
# Какие гранты вообще относятся к объекту o. Три уровня перечислены явно, а
# не сведены к «object_id IS NULL» — иначе общий грант нельзя было бы
# отличить от проектного, и «все проекты» действовал бы как грант на тот
# проект, чей id случайно оказался в строке.
#
# «Точности» гранта здесь больше нет. До 2026-08-14 частный грант
# ПЕРЕКРЫВАЛ общий, и запрос выбирал самый частный; теперь роли всех трёх
# уровней складываются, и выбирать не из чего — берутся все подходящие.
_ГРАНТ_ПОДХОДИТ = """
    ua.object_id = o.id
    OR (ua.object_id IS NULL AND ua.project_id = o.project_id)
    OR (ua.object_id IS NULL AND ua.project_id IS NULL)
"""


def object_role_keys(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int) -> set:
    """ВСЕ роли пользователя на объекте: гранты трёх уровней складываются.

    Пустое множество — доступа к объекту нет. Администратор сервиса сюда не
    попадает: его проверки проходят раньше (has_feature), а роли ему не
    выдаются и не нужны.
    """
    return {r["role"] for r in conn.execute(
        f"""
        SELECT DISTINCT ua.role
        FROM user_access ua
        JOIN objects o ON o.id = ?
        WHERE ua.user_id = ? AND ({_ГРАНТ_ПОДХОДИТ})
        """,
        (object_id, user["id"]),
    )}


def all_role_keys(conn: sqlite3.Connection, user: sqlite3.Row) -> set:
    """Все роли человека, где бы они ни были выданы — для общесервисных
    разделов, у которых объекта нет (контрагенты, пользователи, копии).

    Считается по ГРАНТАМ, а не по объектам: грант «на все проекты» должен
    засчитываться и в пустой системе, где объектов ещё нет вовсе.
    """
    return {r["role"] for r in conn.execute(
        "SELECT DISTINCT role FROM user_access WHERE user_id = ?", (user["id"],))}


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
    """Роли на КАЖДОМ доступном объекте: {object_id: {роли}}.

    Одним запросом на все объекты сразу — иначе переключатель объектов
    делал бы запрос на каждый пункт списка.

    Администратор сервиса получает пустые наборы при полном списке
    объектов: ролей у него нет, а доступ есть — и это не то же самое, что
    «доступа нет». Решают за него проверки в has_feature, а не этот
    словарь.
    """
    if is_system_admin(user):
        return {r["id"]: set() for r in conn.execute("SELECT id FROM objects")}
    роли = {}
    for r in conn.execute(
        f"""
        SELECT o.id AS object_id, ua.role AS role
        FROM objects o
        JOIN user_access ua ON ua.user_id = ? AND ({_ГРАНТ_ПОДХОДИТ})
        """,
        (user["id"],),
    ):
        роли.setdefault(r["object_id"], set()).add(r["role"])
    return роли


def has_object_access(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int) -> bool:
    """Есть ли у человека доступ к объекту ВООБЩЕ — хоть какая-нибудь роль.

    Отбор объектов в списках и переключателях спрашивает именно это, а не
    «что он там может»: что может — решают разделы. Параметра «не ниже
    роли» больше нет: роли независимы, и слова «ниже» у них не осталось.
    """
    if is_system_admin(user):
        return conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is not None
    return bool(object_role_keys(conn, user, object_id))


def assert_object_access(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int) -> None:
    """Объект существует и доступ к нему есть. Разные коды намеренно: 404 у
    объекта, которого нет, и 403 у существующего, но чужого — путать их
    значит либо подсказывать о существовании чужих объектов, либо прятать
    собственную ошибку в id."""
    if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    if not has_object_access(conn, user, object_id):
        raise HTTPException(status_code=403, detail="Нет доступа к этому объекту")


def assert_object_feature(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int,
                          key: str, kind: str) -> None:
    """Доступ к РАЗДЕЛУ на конкретном объекте — основная проверка внутри
    обработчиков.

    Сначала существование объекта (404 против 403, довод тот же, что в
    assert_object_access), потом порог раздела из базы. Именно этим вызовом
    заменены прежние `assert_object_access(..., "admin")`: порог перестал
    быть буквой в коде и стал настройкой.
    """
    if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    assert_feature(conn, user, key, kind, object_id)


def assert_object_any_feature(conn: sqlite3.Connection, user: sqlite3.Row, object_id: int,
                              keys, kind: str) -> None:
    """Доступ хотя бы к одному разделу из перечня на конкретном объекте."""
    if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    if has_any_feature(conn, user, keys, kind, object_id):
        return
    названия = ", ".join(f"«{feature(k).title}»" for k in keys)
    raise HTTPException(status_code=403,
                        detail=f"Нужен доступ хотя бы к одному из разделов: {названия}")


def has_contracting_rights(conn: sqlite3.Connection, user: sqlite3.Row) -> bool:
    """Может ли человек вести справочник контрагентов хоть где-нибудь.

    Справочник общесервисный, к объекту не привязан, и объектной проверке
    зацепиться не за что; засчитывается роль не ниже порога хотя бы на одном
    доступном объекте. С 2026-08-14 это обычный общесервисный раздел, а
    «Комплектовщик» перестал быть вписанным сюда именем роли — порог
    настраивается вместе с остальными.

    Основание — ДЕЙСТВУЮЩИЕ роли (object_roles), а не сырые гранты: грант
    «комплектовщик на все проекты», перекрытый на конкретном объекте
    просмотром, всё равно оставляет человека комплектовщиком в других
    местах, а перекрытый везде — уже нет.
    """
    return has_feature(conn, user, "counterparties", "write")


def require_system_admin(user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
    """Ведение сервиса в обход разделов.

    Осталось у операций, которые не описываются разделом вовсе: вход в
    отладочный режим «от имени», перенос базы целиком. Всё, что показано
    администратору в матрице прав, проверяется через require_feature —
    иначе настройка рисовала бы порог, на который никто не смотрит.
    """
    if not is_system_admin(user):
        raise HTTPException(status_code=403, detail="Требуются права администратора сервиса")
    return user


def require_feature(key: str, kind: str = "write"):
    """Зависимость «доступ к разделу», объектная.

    object_id берётся из query — так его передают эндпоинты, работающие с
    объектом целиком. Там, где объект выводится из другой сущности (элемент,
    зона, контракт), проверка идёт внутри обработчика через
    assert_object_feature: узнать объект можно только запросом.
    """
    feature(key)  # ключ сверяется при СБОРКЕ приложения, а не при первом запросе

    def dependency(object_id: int = Query(..., description="Объект, к которому относится операция"),
                   user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
        conn = get_connection()
        try:
            assert_object_feature(conn, user, object_id, key, kind)
        finally:
            conn.close()
        return user
    return dependency


def require_any_feature(keys, kind: str = "write"):
    """Объектная зависимость «доступ хотя бы к одному из разделов»
    (см. has_any_feature)."""
    keys = list(keys)
    for k in keys:
        feature(k)

    def dependency(object_id: int = Query(..., description="Объект, к которому относится операция"),
                   user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
        conn = get_connection()
        try:
            if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Объект не найден")
            if not has_any_feature(conn, user, keys, kind, object_id):
                названия = ", ".join(f"«{feature(k).title}»" for k in keys)
                raise HTTPException(
                    status_code=403,
                    detail=f"Нужен доступ хотя бы к одному из разделов: {названия}")
        finally:
            conn.close()
        return user
    return dependency


def require_service_feature(key: str, kind: str = "write"):
    """Зависимость «доступ к разделу», общесервисная: объекта у операции нет.

    Отдельная фабрика, а не признак у первой: сигнатура зависимости
    определяет, требует ли FastAPI параметр object_id в запросе. Свести их в
    одну значило бы требовать object_id там, где его неоткуда взять
    (резервные копии, пользователи, журнал сервиса).
    """
    feature(key)

    def dependency(user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
        conn = get_connection()
        try:
            assert_feature(conn, user, key, kind)
        finally:
            conn.close()
        return user
    return dependency


require_contracting = require_service_feature("counterparties", "write")

# Прежние зависимости «не ниже роли» держатся на нижней ступени лестницы:
# они отвечают на вопрос «есть ли доступ к объекту вообще», а не «можно ли
# такую-то операцию». Всё, что про операции, переведено на require_feature.
require_object_access = require_feature("plan", "read")

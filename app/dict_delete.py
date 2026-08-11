"""
Удаление записи справочника с заменой (2026-08-05).

Задача пользователя дословно: «если на элемент могут быть ссылки в других
местах системы, то контролируй ссылочную целостность и не удаляй без замены
на другой элемент. То есть при запросе удаления сначала проверка, потом
если найдены ссылки, то предложение заменить, потом замена, потом удаление.
Причём если удаляется контрагент, то вместе с ним удаляются все его
договоры и спецификации. И выбрать замену обязательно для всех подчинённых
элементов и удалить тоже с подчинёнными. При выборе подчинённых элементов
контролировать иерархию владельцев».

Отсюда три правила, на которых держится весь модуль.

**1. Замена, а не обнуление.** Внешние ключи в схеме почти везде стоят
`ON DELETE SET NULL` — то есть база сама позволила бы удалить контракт,
молча оставив сотню изделий без контракта. Такое удаление и есть потеря
данных: изделие числится поставленным, а чем — уже неизвестно. Поэтому
ссылки ПЕРЕВОДЯТСЯ на замену, и только потом строка удаляется.

**2. Замена обязательна для всего поддерева.** Удаление контрагента уносит
его договоры, спецификации и контракты, а на контракты ссылаются изделия и
их история. Поэтому замену требуется указать для КАЖДОЙ записи поддерева, на
которую кто-то ссылается, — и, как следствие, для их владельцев тоже: без
контрагента-замены неоткуда взять список договоров-замен.

**3. Иерархия владельцев соблюдается при ВЫБОРЕ.** Договор-замена ищется
только среди договоров выбранного контрагента-замены, спецификация — только
среди спецификаций выбранного договора. Иначе замена собрала бы контракт из
чужих реквизитов, и наименование контракта (оно генерируется по цепочке,
см. app/contracts.build_contract_name) стало бы враньём.

Что НЕ делается заменой и почему. **Объект и проект** удаляются только
пустыми, замена для них не предлагается. Перенос содержимого объекта в
другой объект — это не восстановление ссылочной целостности, а слияние двух
зданий: у объекта своя версия чертежа, своя сетка осей и свои координаты, и
после «замены» на схеме оказались бы два здания одно поверх другого. План
удаления показывает, что именно держит объект, и этого достаточно, чтобы
убрать пустышку, заведённую по ошибке.

Права — администратор сервиса (решение пользователя 2026-08-05): действие
необратимо и трогает данные всех объектов сразу.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app.access import require_system_admin
from app.contracts import build_contract_name, build_document_label
from app.db import get_connection

router = APIRouter(tags=["dictionaries"])

# Разделитель составного ключа. Подтип адресуется парой (тип, подтип), и
# передавать её двумя параметрами пути значило бы городить отдельный маршрут
# ради одного справочника. Делится по ПЕРВОМУ вхождению (str.partition),
# поэтому тот же символ внутри подтипа ничего не ломает — достаточно, что
# его нет ни в одном из четырёх типов элементов.
SEP = "|"


class DeleteIn(BaseModel):
    # {"kind:key": "ключ замены"} — плоская карта на всё поддерево, а не
    # вложенная структура: клиент собирает её по мере выбора, и разбирать
    # вложенность на сервере пришлось бы вторым обходом дерева.
    replacements: dict[str, str] = {}
    # Что делать с подчинёнными записями (2026-08-05, живой репорт).
    #
    # "replace" — каждая подчинённая запись заменяется на ДРУГУЮ такую же у
    #   выбранного владельца. Годится, когда запись удаляют как ошибочную:
    #   «этот договор лишний, его изделия возить будет вон тот».
    #
    # "merge" — подчинённые ПЕРЕЕЗЖАЮТ к замене вместе со всем своим
    #   содержимым, и удаляется только опустевшая запись. Это и есть свёртка
    #   задвоенного: у дубля контрагента свои договоры, и «заменить» их на
    #   чужие означало бы увести изделия на чужой контракт — то есть соврать
    #   про то, кто и по какому документу возил.
    mode: str = "replace"


# ==================== СПРАВОЧНИК МАРОК ====================


def _mark_load(conn, key):
    return conn.execute("SELECT * FROM marks WHERE id = ?", (int(key),)).fetchone()


def _mark_label(conn, row):
    return f"{row['name']} ({row['element_type']})"


def _mark_refs(conn, row):
    изделий = conn.execute(
        "SELECT COUNT(*) AS n FROM elements WHERE mark_id = ?", (row["id"],)
    ).fetchone()["n"]
    позиций = conn.execute(
        """
        SELECT COUNT(*) AS n FROM contract_lines cl
        JOIN contracts co ON co.id = cl.contract_id
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        WHERE a.object_id = ? AND cl.element_type = ? AND cl.mark = ?
        """,
        (row["object_id"], row["element_type"], row["name"]),
    ).fetchone()["n"]
    return _непустые([("Изделия", изделий), ("Позиции контрактов", позиций)])


def _mark_candidates(conn, row, parent_target):
    rows = conn.execute(
        "SELECT id, name FROM marks WHERE object_id = ? AND element_type = ? AND id <> ? "
        "ORDER BY name COLLATE NOCASE",
        (row["object_id"], row["element_type"], row["id"]),
    ).fetchall()
    return [{"key": str(r["id"]), "label": r["name"]} for r in rows]


def _mark_repoint(conn, row, target):
    """Изделия переезжают на запись-замену вместе с ТЕКСТОМ марки: пока
    elements.mark живёт рядом с mark_id (см. app/marks.py), оставить старый
    текст значило бы получить изделие, у которого справочник говорит одно, а
    поле — другое."""
    from app.marks import _rename_contract_lines

    изделий = conn.execute(
        "UPDATE elements SET mark_id = ?, mark = ?, updated_at = datetime('now') "
        "WHERE mark_id = ?",
        (target["id"], target["name"], row["id"]),
    ).rowcount
    # Изделия, у которых ссылка не проставилась (нет объекта или типа), но
    # текст совпадает — их тоже надо увести, иначе удалённая марка останется
    # жить текстом и вернётся в справочник следующей же обработкой.
    изделий += conn.execute(
        "UPDATE elements SET mark_id = ?, mark = ?, updated_at = datetime('now') "
        "WHERE mark_id IS NULL AND object_id = ? AND element_type = ? AND mark = ?",
        (target["id"], target["name"], row["object_id"], row["element_type"], row["name"]),
    ).rowcount
    позиций = _rename_contract_lines(conn, row, target["name"])
    return _непустые([("Изделия", изделий), ("Позиции контрактов", позиций)])


def _mark_delete(conn, row):
    conn.execute("DELETE FROM marks WHERE id = ?", (row["id"],))


# ==================== ПОДТИПЫ ====================


def _subtype_load(conn, key):
    element_type, _, subtype = key.partition(SEP)
    return conn.execute(
        "SELECT element_type, subtype FROM allowed_subtypes WHERE element_type = ? AND subtype = ?",
        (element_type, subtype),
    ).fetchone()


def _subtype_key(row):
    return f"{row['element_type']}{SEP}{row['subtype']}"


def _subtype_refs(conn, row):
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM elements WHERE element_type = ? AND subtype = ?",
        (row["element_type"], row["subtype"]),
    ).fetchone()["n"]
    return _непустые([("Изделия", n)])


def _subtype_candidates(conn, row, parent_target):
    rows = conn.execute(
        "SELECT subtype FROM allowed_subtypes WHERE element_type = ? AND subtype <> ? "
        "ORDER BY subtype COLLATE NOCASE",
        (row["element_type"], row["subtype"]),
    ).fetchall()
    return [{"key": f"{row['element_type']}{SEP}{r['subtype']}", "label": r["subtype"]}
            for r in rows]


def _subtype_repoint(conn, row, target):
    n = conn.execute(
        "UPDATE elements SET subtype = ?, updated_at = datetime('now') "
        "WHERE element_type = ? AND subtype = ?",
        (target["subtype"], row["element_type"], row["subtype"]),
    ).rowcount
    return _непустые([("Изделия", n)])


def _subtype_delete(conn, row):
    conn.execute("DELETE FROM allowed_subtypes WHERE element_type = ? AND subtype = ?",
                 (row["element_type"], row["subtype"]))


# ==================== ПРЕФИКСЫ МАРОК ====================
#
# Ссылок на префикс не бывает: это эвристика, к которой импорт файла
# контрактации обращается в момент разбора и результат которой сохраняется
# уже в виде типа позиции. Удалять можно свободно — но проходит удаление
# тем же путём, что и остальные, чтобы у администратора не было двух разных
# «Удалить» с разным поведением.


def _prefix_load(conn, key):
    return conn.execute(
        "SELECT prefix, element_type FROM mark_type_prefixes WHERE prefix = ?", (key,)
    ).fetchone()


def _prefix_delete(conn, row):
    conn.execute("DELETE FROM mark_type_prefixes WHERE prefix = ?", (row["prefix"],))


# ==================== КОНТРАКТАЦИЯ ====================


def _counterparty_load(conn, key):
    return conn.execute("SELECT * FROM counterparties WHERE id = ?", (int(key),)).fetchone()


def _counterparty_children(conn, row):
    return [("agreement", str(r["id"])) for r in conn.execute(
        "SELECT id FROM agreements WHERE counterparty_id = ? ORDER BY number", (row["id"],))]


def _counterparty_candidates(conn, row, parent_target):
    rows = conn.execute(
        "SELECT id, short_name FROM counterparties WHERE id <> ? ORDER BY short_name COLLATE NOCASE",
        (row["id"],),
    ).fetchall()
    return [{"key": str(r["id"]), "label": r["short_name"]} for r in rows]


def _agreement_load(conn, key):
    return conn.execute("SELECT * FROM agreements WHERE id = ?", (int(key),)).fetchone()


def _agreement_label(conn, row):
    return "Договор " + build_document_label(row["number"], row["agreement_date"])


def _agreement_children(conn, row):
    return [("specification", str(r["id"])) for r in conn.execute(
        "SELECT id FROM specifications WHERE agreement_id = ? ORDER BY number", (row["id"],))]


def _agreement_candidates(conn, row, parent_target):
    """Владелец — контрагент. Если контрагента заменяют (удаляют вместе с
    ним), список берётся у КОНТРАГЕНТА-ЗАМЕНЫ: это и есть «контроль иерархии
    владельцев». Если удаляют один договор, владелец не меняется и список
    берётся у его же контрагента."""
    counterparty_id = int(parent_target) if parent_target else row["counterparty_id"]
    rows = conn.execute(
        "SELECT id, number, agreement_date FROM agreements "
        "WHERE counterparty_id = ? AND id <> ? ORDER BY number",
        (counterparty_id, row["id"]),
    ).fetchall()
    return [{"key": str(r["id"]),
             "label": build_document_label(r["number"], r["agreement_date"])} for r in rows]


def _specification_load(conn, key):
    return conn.execute("SELECT * FROM specifications WHERE id = ?", (int(key),)).fetchone()


def _specification_label(conn, row):
    return "Спецификация " + build_document_label(row["number"], row["specification_date"])


def _specification_children(conn, row):
    return [("contract", str(r["id"])) for r in conn.execute(
        "SELECT id FROM contracts WHERE specification_id = ? ORDER BY id", (row["id"],))]


def _specification_candidates(conn, row, parent_target):
    agreement_id = int(parent_target) if parent_target else row["agreement_id"]
    rows = conn.execute(
        "SELECT id, number, specification_date FROM specifications "
        "WHERE agreement_id = ? AND id <> ? ORDER BY number",
        (agreement_id, row["id"]),
    ).fetchall()
    return [{"key": str(r["id"]),
             "label": build_document_label(r["number"], r["specification_date"])} for r in rows]


def _contract_load(conn, key):
    return conn.execute("SELECT * FROM contracts WHERE id = ?", (int(key),)).fetchone()


def _contract_label(conn, row):
    chain = conn.execute(
        """
        SELECT s.number AS s_num, s.specification_date AS s_date,
               a.number AS a_num, a.agreement_date AS a_date, c.short_name AS cp
        FROM specifications s
        JOIN agreements a ON a.id = s.agreement_id
        JOIN counterparties c ON c.id = a.counterparty_id
        WHERE s.id = ?
        """,
        (row["specification_id"],),
    ).fetchone()
    if chain is None:
        return f"Контракт #{row['id']}"
    return build_contract_name(chain["cp"], chain["a_num"], chain["a_date"],
                               chain["s_num"], chain["s_date"], row["theme"])


def _contract_refs(conn, row):
    изделий = conn.execute(
        "SELECT COUNT(*) AS n FROM elements WHERE contract_id = ?", (row["id"],)
    ).fetchone()["n"]
    истории = conn.execute(
        "SELECT COUNT(*) AS n FROM status_history WHERE contract_id = ?", (row["id"],)
    ).fetchone()["n"]
    умолчаний = conn.execute(
        "SELECT COUNT(*) AS n FROM default_contracts WHERE contract_id = ?", (row["id"],)
    ).fetchone()["n"]
    return _непустые([("Изделия", изделий), ("Записи истории статусов", истории),
                      ("Контракт по умолчанию", умолчаний)])


def _contract_cascade(conn, row):
    позиций = conn.execute(
        "SELECT COUNT(*) AS n FROM contract_lines WHERE contract_id = ?", (row["id"],)
    ).fetchone()["n"]
    инцидентов = conn.execute(
        "SELECT COUNT(*) AS n FROM contract_incidents WHERE contract_id = ?", (row["id"],)
    ).fetchone()["n"]
    return _непустые([("Позиции контракта", позиций), ("Инциденты повреждения", инцидентов)])


def _contract_candidates(conn, row, parent_target):
    specification_id = int(parent_target) if parent_target else row["specification_id"]
    rows = conn.execute(
        "SELECT * FROM contracts WHERE specification_id = ? AND id <> ? ORDER BY id",
        (specification_id, row["id"]),
    ).fetchall()
    return [{"key": str(r["id"]), "label": _contract_label(conn, r)} for r in rows]


def _contract_repoint(conn, row, target):
    изделий = conn.execute(
        "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE contract_id = ?",
        (target["id"], row["id"]),
    ).rowcount
    истории = conn.execute(
        "UPDATE status_history SET contract_id = ? WHERE contract_id = ?",
        (target["id"], row["id"]),
    ).rowcount
    # У default_contracts ключ (object_id, element_type) — если на замену уже
    # назначен контракт по умолчанию для того же типа, второй строки быть не
    # может: прежнее назначение просто уходит вместе с контрактом.
    умолчаний = 0
    for r in conn.execute(
        "SELECT object_id, element_type FROM default_contracts WHERE contract_id = ?", (row["id"],)
    ).fetchall():
        занято = conn.execute(
            "SELECT 1 FROM default_contracts WHERE object_id = ? AND element_type = ? "
            "AND contract_id = ?", (r["object_id"], r["element_type"], target["id"]),
        ).fetchone()
        if занято:
            conn.execute(
                "DELETE FROM default_contracts WHERE object_id = ? AND element_type = ? "
                "AND contract_id = ?", (r["object_id"], r["element_type"], row["id"]))
        else:
            conn.execute(
                "UPDATE default_contracts SET contract_id = ? "
                "WHERE object_id = ? AND element_type = ? AND contract_id = ?",
                (target["id"], r["object_id"], r["element_type"], row["id"]))
        умолчаний += 1
    return _непустые([("Изделия", изделий), ("Записи истории статусов", истории),
                      ("Контракт по умолчанию", умолчаний)])


def _contract_delete(conn, row):
    # Позиции и инциденты — ЯВНО, хотя ON DELETE CASCADE их и так унесёт
    # (PRAGMA foreign_keys=ON стоит, см. app/db.get_connection). Явно —
    # потому что удаление обязано быть видно в коде: каскад базы легко
    # потерять при следующей пересборке таблицы, а тихо переставшая
    # удаляться позиция даёт контракт-призрак в остатках.
    conn.execute("DELETE FROM contract_lines WHERE contract_id = ?", (row["id"],))
    conn.execute("DELETE FROM contract_incidents WHERE contract_id = ?", (row["id"],))
    conn.execute("DELETE FROM default_contracts WHERE contract_id = ?", (row["id"],))
    conn.execute("DELETE FROM contracts WHERE id = ?", (row["id"],))


def _specification_delete(conn, row):
    conn.execute("DELETE FROM specifications WHERE id = ?", (row["id"],))


def _agreement_delete(conn, row):
    conn.execute("DELETE FROM agreements WHERE id = ?", (row["id"],))


def _counterparty_delete(conn, row):
    conn.execute("DELETE FROM counterparties WHERE id = ?", (row["id"],))


# ==================== ЗОНЫ ====================
#
# Три категории — Захватка / Кран / Стоянка — физически одна таблица
# (решение З15). Подчинение есть только у стоянки: она принадлежит крану
# (zones.parent_zone_id), и удаление крана обязано унести стоянки с собой.

_ZONE_ELEMENT_COLUMN = {
    "Захватка": "zone_zakhvatka_id",
    "Кран": "zone_crane_id",
    "Стоянка": "zone_stance_id",
}


def _zone_load(conn, key):
    return conn.execute("SELECT * FROM zones WHERE id = ?", (int(key),)).fetchone()


def _zone_label(conn, row):
    имя = row["name"] or f"{row['category']} {row['number']}"
    return имя if row["is_current"] else f"{имя} (неактуальна)"


def _zone_children(conn, row):
    if row["category"] != "Кран":
        return []
    return [("zone", str(r["id"])) for r in conn.execute(
        "SELECT id FROM zones WHERE parent_zone_id = ? ORDER BY number", (row["id"],))]


def _zone_refs(conn, row):
    колонка = _ZONE_ELEMENT_COLUMN.get(row["category"])
    if not колонка:
        return []
    n = conn.execute(
        f"SELECT COUNT(*) AS n FROM elements WHERE {колонка} = ?", (row["id"],)
    ).fetchone()["n"]
    return _непустые([("Изделия", n)])


def _zone_cascade(conn, row):
    ярусов = conn.execute(
        "SELECT COUNT(*) AS n FROM zone_levels WHERE zone_id = ?", (row["id"],)
    ).fetchone()["n"]
    return _непустые([("Ярусы (контуры)", ярусов)])


def _zone_candidates(conn, row, parent_target):
    """Замена ищется среди зон ТОЙ ЖЕ категории и того же объекта. У стоянки
    владелец — кран: при замене крана список стоянок берётся у крана-замены."""
    if row["category"] == "Стоянка":
        parent_id = int(parent_target) if parent_target else row["parent_zone_id"]
        if parent_id is None:
            rows = conn.execute(
                "SELECT * FROM zones WHERE object_id IS ? AND category = 'Стоянка' "
                "AND parent_zone_id IS NULL AND id <> ? ORDER BY number",
                (row["object_id"], row["id"]),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM zones WHERE category = 'Стоянка' AND parent_zone_id = ? "
                "AND id <> ? ORDER BY number",
                (parent_id, row["id"]),
            ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM zones WHERE object_id IS ? AND category = ? AND id <> ? ORDER BY number",
            (row["object_id"], row["category"], row["id"]),
        ).fetchall()
    return [{"key": str(r["id"]), "label": _zone_label(conn, r)} for r in rows]


def _zone_repoint(conn, row, target):
    колонка = _ZONE_ELEMENT_COLUMN[row["category"]]
    n = conn.execute(
        f"UPDATE elements SET {колонка} = ?, updated_at = datetime('now') WHERE {колонка} = ?",
        (target["id"], row["id"]),
    ).rowcount
    итог = [("Изделия", n)]
    if row["category"] == "Стоянка":
        # Ярус стоянки — отдельная ссылка (zone_stance_level_id): у стоянки
        # их несколько, и «просто перевесить» её нельзя. Ярус ищется у
        # замены по ТОЙ ЖЕ отметке; нет такой отметки — ссылка снимается,
        # потому что подставить чужой ярус значит соврать про высоту.
        по_отметке = {
            r["elevation_mm"]: r["id"] for r in conn.execute(
                "SELECT id, elevation_mm FROM zone_levels WHERE zone_id = ?", (target["id"],))
        }
        совпало = снято = 0
        for r in conn.execute(
            "SELECT zl.id, zl.elevation_mm FROM zone_levels zl WHERE zl.zone_id = ?", (row["id"],)
        ).fetchall():
            новый = по_отметке.get(r["elevation_mm"])
            затронуто = conn.execute(
                "UPDATE elements SET zone_stance_level_id = ? WHERE zone_stance_level_id = ?",
                (новый, r["id"]),
            ).rowcount
            if новый is not None:
                совпало += затронуто
            else:
                снято += затронуто
        итог += [("Ярус подобран по отметке", совпало), ("Ярус снят (нет такой отметки)", снято)]
    return _непустые(итог)


def _zone_delete(conn, row):
    conn.execute("DELETE FROM zone_levels WHERE zone_id = ?", (row["id"],))
    conn.execute("DELETE FROM zone_edit_undo WHERE zone_id = ?", (row["id"],))
    conn.execute("DELETE FROM zones WHERE id = ?", (row["id"],))


# ==================== ОБЪЕКТЫ И ПРОЕКТЫ ====================
#
# Замена не предлагается — см. шапку модуля. Удаляется только то, за чем
# ничего не стоит; план показывает, что именно держит запись.


def _object_load(conn, key):
    return conn.execute("SELECT * FROM objects WHERE id = ?", (int(key),)).fetchone()


def _object_blockers(conn, row):
    считать = [
        ("Изделия", "SELECT COUNT(*) AS n FROM elements WHERE object_id = ?"),
        ("Зоны", "SELECT COUNT(*) AS n FROM zones WHERE object_id = ?"),
        ("Договоры", "SELECT COUNT(*) AS n FROM agreements WHERE object_id = ?"),
        ("Версии чертежа", "SELECT COUNT(*) AS n FROM object_drawings WHERE object_id = ?"),
        ("Марки", "SELECT COUNT(*) AS n FROM marks WHERE object_id = ?"),
    ]
    return _непустые([(label, conn.execute(sql, (row["id"],)).fetchone()["n"])
                      for label, sql in считать])


def _object_cascade(conn, row):
    считать = [
        ("Настройки объекта", "SELECT COUNT(*) AS n FROM app_settings WHERE object_id = ?"),
        ("Видимость подписей", "SELECT COUNT(*) AS n FROM label_visibility WHERE object_id = ?"),
        ("Цвета зон", "SELECT COUNT(*) AS n FROM zone_colors WHERE object_id = ?"),
        ("События, задачи, вопросы", "SELECT COUNT(*) AS n FROM report_notes WHERE object_id = ?"),
        ("Контракты по умолчанию", "SELECT COUNT(*) AS n FROM default_contracts WHERE object_id = ?"),
        ("Выданные доступы", "SELECT COUNT(*) AS n FROM user_access WHERE object_id = ?"),
    ]
    return _непустые([(label, conn.execute(sql, (row["id"],)).fetchone()["n"])
                      for label, sql in считать])


def _object_delete(conn, row):
    from app.attachments import delete_for_entity
    delete_for_entity(conn, "object", row["id"])
    for sql in (
        "DELETE FROM app_settings WHERE object_id = ?",
        "DELETE FROM label_visibility WHERE object_id = ?",
        "DELETE FROM zone_colors WHERE object_id = ?",
        "DELETE FROM report_notes WHERE object_id = ?",
        "DELETE FROM default_contracts WHERE object_id = ?",
        "DELETE FROM user_access WHERE object_id = ?",
        "UPDATE users SET last_object_id = NULL WHERE last_object_id = ?",
        "DELETE FROM objects WHERE id = ?",
    ):
        conn.execute(sql, (row["id"],))


def _project_load(conn, key):
    return conn.execute("SELECT * FROM projects WHERE id = ?", (int(key),)).fetchone()


def _project_blockers(conn, row):
    n = conn.execute("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?",
                     (row["id"],)).fetchone()["n"]
    return _непустые([("Объекты", n)])


def _project_cascade(conn, row):
    n = conn.execute("SELECT COUNT(*) AS n FROM user_access WHERE project_id = ?",
                     (row["id"],)).fetchone()["n"]
    return _непустые([("Выданные доступы", n)])


def _project_delete(conn, row):
    from app.attachments import delete_for_entity
    delete_for_entity(conn, "project", row["id"])
    conn.execute("DELETE FROM user_access WHERE project_id = ?", (row["id"],))
    conn.execute("DELETE FROM projects WHERE id = ?", (row["id"],))


# ==================== ПЕРЕЕЗД ПОДЧИНЁННЫХ (свёртка дубля) ====================
#
# Задача, ради которой это написано: у контрагента, заведённого дважды в
# разном регистре, свои договоры со своими спецификациями и контрактами.
# «Заменить» их на договоры второй записи нельзя — это разные документы, и
# изделия уехали бы на чужой контракт. Правильный ход — перенести подчинённые
# к верной записи и удалить опустевшую.
#
# Ловушка переезда — УНИКАЛЬНОСТЬ. У договора уникален номер в пределах
# контрагента, у спецификации — в пределах договора. Если задвоен не только
# контрагент, но и его договор (а при задвоении так обычно и есть), простой
# UPDATE упадёт на индексе. Поэтому переезд РЕКУРСИВНЫЙ: совпал номер —
# сливаем содержимое в уже существующую запись и удаляем исходную; не совпал
# — просто перевешиваем.


def _merge_agreements(conn, src_id: int, dst_id: int, отчёт: list) -> None:
    """Договоры контрагента src → контрагенту dst."""
    for a in conn.execute("SELECT * FROM agreements WHERE counterparty_id = ?", (src_id,)).fetchall():
        двойник = conn.execute(
            "SELECT * FROM agreements WHERE counterparty_id = ? AND number = ?",
            (dst_id, a["number"]),
        ).fetchone()
        if двойник:
            _merge_specifications(conn, a["id"], двойник["id"], отчёт)
            conn.execute("DELETE FROM agreements WHERE id = ?", (a["id"],))
            отчёт.append(f"договор {a['number']} слит с одноимённым")
        else:
            conn.execute(
                "UPDATE agreements SET counterparty_id = ?, updated_at = datetime('now') WHERE id = ?",
                (dst_id, a["id"]))
            отчёт.append(f"договор {a['number']} перенесён")


def _merge_specifications(conn, src_id: int, dst_id: int, отчёт: list) -> None:
    """Спецификации договора src → договору dst."""
    for s in conn.execute("SELECT * FROM specifications WHERE agreement_id = ?", (src_id,)).fetchall():
        двойник = conn.execute(
            "SELECT * FROM specifications WHERE agreement_id = ? AND number = ?",
            (dst_id, s["number"]),
        ).fetchone()
        if двойник:
            _merge_contracts(conn, s["id"], двойник["id"], отчёт)
            conn.execute("DELETE FROM specifications WHERE id = ?", (s["id"],))
            отчёт.append(f"спецификация {s['number']} слита с одноимённой")
        else:
            conn.execute(
                "UPDATE specifications SET agreement_id = ?, updated_at = datetime('now') WHERE id = ?",
                (dst_id, s["id"]))
            отчёт.append(f"спецификация {s['number']} перенесена")


def _merge_contracts(conn, src_id: int, dst_id: int, отчёт: list) -> None:
    """Контракты спецификации src → спецификации dst. Слияния по имени тут
    нет и быть не может: у контракта нет номера, его наименование целиком
    выводится из цепочки, и двух «одинаковых» контрактов не существует —
    в одной спецификации их может быть сколько угодно."""
    n = conn.execute(
        "UPDATE contracts SET specification_id = ?, updated_at = datetime('now') "
        "WHERE specification_id = ?", (dst_id, src_id)).rowcount
    if n:
        отчёт.append(f"контрактов перенесено: {n}")


def _merge_stances(conn, src_id: int, dst_id: int, отчёт: list) -> None:
    """Стоянки крана src → крану dst. Совпал номер — изделия исходной
    стоянки переезжают на одноимённую (вместе с подбором яруса по отметке,
    см. _zone_repoint), сама она удаляется."""
    for z in conn.execute(
        "SELECT * FROM zones WHERE parent_zone_id = ? AND category = 'Стоянка'", (src_id,)
    ).fetchall():
        двойник = conn.execute(
            "SELECT * FROM zones WHERE parent_zone_id = ? AND category = 'Стоянка' AND number IS ?",
            (dst_id, z["number"]),
        ).fetchone()
        if двойник:
            _zone_repoint(conn, z, двойник)
            _zone_delete(conn, z)
            отчёт.append(f"стоянка {z['number']} слита с одноимённой")
        else:
            conn.execute("UPDATE zones SET parent_zone_id = ? WHERE id = ?", (dst_id, z["id"]))
            отчёт.append(f"стоянка {z['number']} перенесена")


# ==================== РЕЕСТР ====================
#
# Один список на все справочники — та же причина, по которой в проекте одна
# таблица прав (app/rights_matrix.py) и одно описание схемы
# (app/db_schema_doc.py): десять «удалить» по местам разъехались бы в
# поведении, и половина забыла бы про ссылки.

KINDS = {
    "mark": {
        "title": "Марка", "plural": "Марки", "table": "marks",
        "load": _mark_load, "label": _mark_label,
        "refs": _mark_refs, "candidates": _mark_candidates,
        "repoint": _mark_repoint, "delete": _mark_delete,
        "fk_handled": {"elements.mark_id": "перевод на замену"},
    },
    "subtype": {
        "title": "Подтип", "plural": "Подтипы",
        "load": _subtype_load, "label": lambda conn, row: row["subtype"],
        "key_of": _subtype_key, "table": "allowed_subtypes",
        "refs": _subtype_refs, "candidates": _subtype_candidates,
        "repoint": _subtype_repoint, "delete": _subtype_delete,
    },
    "mark_prefix": {
        "title": "Префикс марки", "plural": "Префиксы марок",
        "load": _prefix_load,
        "label": lambda conn, row: f"{row['prefix']} → {row['element_type']}",
        "key_of": lambda row: row["prefix"], "table": "mark_type_prefixes",
        "delete": _prefix_delete,
    },
    "counterparty": {
        "title": "Контрагент", "plural": "Контрагенты", "table": "counterparties",
        "fk_handled": {
            "agreements.counterparty_id": "подчинённые записи, уходят вместе",
            # Производительность завода (08-11) — его собственная
            # характеристика, переносить её на замену бессмысленно: у другого
            # завода свой темп, и подставить чужой значило бы соврать в
            # расчёте «Аналитической справки».
            "counterparty_capacity.counterparty_id": "удаляется вместе",
        },
        "load": _counterparty_load, "label": lambda conn, row: row["short_name"],
        "children": _counterparty_children, "candidates": _counterparty_candidates,
        "adopt": _merge_agreements, "adopt_title": "договоры со всем содержимым",
        "delete": _counterparty_delete,
    },
    "agreement": {
        "title": "Договор", "plural": "Договоры", "parent_kind": "counterparty",
        "table": "agreements",
        "fk_handled": {"specifications.agreement_id": "подчинённые записи, уходят вместе"},
        "load": _agreement_load, "label": _agreement_label,
        "children": _agreement_children, "candidates": _agreement_candidates,
        "adopt": _merge_specifications, "adopt_title": "спецификации со всем содержимым",
        "delete": _agreement_delete,
    },
    "specification": {
        "title": "Спецификация", "plural": "Спецификации", "parent_kind": "agreement",
        "table": "specifications",
        "fk_handled": {"contracts.specification_id": "подчинённые записи, уходят вместе"},
        "load": _specification_load, "label": _specification_label,
        "children": _specification_children, "candidates": _specification_candidates,
        "adopt": _merge_contracts, "adopt_title": "контракты",
        "delete": _specification_delete,
    },
    "contract": {
        "title": "Контракт", "plural": "Контракты", "parent_kind": "specification",
        "table": "contracts",
        "fk_handled": {
            "elements.contract_id": "перевод на замену",
            "status_history.contract_id": "перевод на замену",
            "default_contracts.contract_id": "перевод на замену",
            "contract_lines.contract_id": "удаляется вместе",
            "contract_incidents.contract_id": "удаляется вместе",
            # Переопределение производительности (08-11) относится к ЭТОМУ
            # документу; у контракта-замены свои условия.
            "contract_capacity.contract_id": "удаляется вместе",
        },
        "load": _contract_load, "label": _contract_label,
        "refs": _contract_refs, "cascade": _contract_cascade,
        "candidates": _contract_candidates, "repoint": _contract_repoint,
        "delete": _contract_delete,
    },
    "zone": {
        "title": "Зона", "plural": "Зоны", "parent_kind": "zone", "table": "zones",
        "fk_handled": {
            "elements.zone_zakhvatka_id": "перевод на замену",
            "elements.zone_crane_id": "перевод на замену",
            "elements.zone_stance_id": "перевод на замену",
            "zones.parent_zone_id": "подчинённые стоянки, уходят вместе",
            "zone_levels.zone_id": "удаляется вместе",
            "zone_edit_undo.zone_id": "удаляется вместе",
        },
        "load": _zone_load, "label": _zone_label,
        "children": _zone_children, "refs": _zone_refs, "cascade": _zone_cascade,
        "candidates": _zone_candidates, "repoint": _zone_repoint, "delete": _zone_delete,
        "adopt": _merge_stances, "adopt_title": "стоянки крана",
    },
    "object": {
        "title": "Объект", "plural": "Объекты", "table": "objects",
        "fk_handled": {
            "elements.object_id": "держит удаление", "zones.object_id": "держит удаление",
            "agreements.object_id": "держит удаление", "marks.object_id": "держит удаление",
            "object_drawings.object_id": "держит удаление",
            "app_settings.object_id": "удаляется вместе",
            "label_visibility.object_id": "удаляется вместе",
            "zone_colors.object_id": "удаляется вместе",
            "report_notes.object_id": "удаляется вместе",
            "default_contracts.object_id": "удаляется вместе",
            "user_access.object_id": "удаляется вместе",
            "users.last_object_id": "ссылка снимается",
        },
        "load": _object_load, "label": lambda conn, row: row["name"],
        "blockers": _object_blockers, "cascade": _object_cascade, "delete": _object_delete,
    },
    "project": {
        "title": "Проект", "plural": "Проекты", "table": "projects",
        "fk_handled": {
            "objects.project_id": "держит удаление",
            "user_access.project_id": "удаляется вместе",
        },
        "load": _project_load, "label": lambda conn, row: row["name"],
        "blockers": _project_blockers, "cascade": _project_cascade, "delete": _project_delete,
    },
}


def _непустые(пары) -> list:
    return [{"label": label, "count": n} for label, n in пары if n]


def _вид(kind: str) -> dict:
    вид = KINDS.get(kind)
    if вид is None:
        raise HTTPException(status_code=404, detail=f"Неизвестный справочник: {kind}")
    return вид


def _строка(conn, kind: str, key: str):
    вид = _вид(kind)
    try:
        row = вид["load"](conn, key)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="Неверный ключ записи")
    if row is None:
        raise HTTPException(status_code=404, detail=f"{вид['title']}: запись не найдена")
    return row


def _ключ(kind: str, row) -> str:
    вид = _вид(kind)
    return вид["key_of"](row) if "key_of" in вид else str(row["id"])


# ==================== ПЛАН УДАЛЕНИЯ ====================


def _ссылающиеся_таблицы(conn, table: str) -> list:
    """Кто ссылается на таблицу ПО ФАКТИЧЕСКОЙ СХЕМЕ базы, а не по списку в
    этом модуле: `PRAGMA foreign_key_list` по всем таблицам."""
    итог = []
    таблицы = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for t in таблицы:
        for r in conn.execute(f"PRAGMA foreign_key_list({t})"):
            if r["table"] == table:
                итог.append((t, r["from"]))
    return sorted(set(итог))


def _сверка_ссылок(conn, kind: str, row) -> list:
    """Проверка ссылочной целостности ПО СХЕМЕ, а не по моему списку.

    Зачем отдельно от `refs`. `refs` — то, что модуль ЗНАЕТ и умеет
    перевести; вопрос же в другом: не появилось ли в базе ссылки, о которой
    модуль не знает. Список ссылающихся мест здесь написан руками (см.
    `fk_handled` в реестре), а руками написанный список отстаёт от схемы на
    первой же миграции — и отстаёт молча, оставляя висячие ссылки ровно там,
    где их никто не искал.

    Поэтому ссылки перечисляет сама база, а реестр только ОБЪЯСНЯЕТ каждую:
    переводится на замену, уходит вместе, держит удаление. Ссылка, которой в
    объяснениях нет, попадает в ответ как «НЕ УЧТЕНО» и, если по ней есть
    строки, удаление не состоится. Так новая колонка со ссылкой ломает
    удаление громко, а не портит данные тихо.

    Работает только для справочников с числовым `id` — у подтипа и префикса
    ключ составной/текстовый, но на их таблицы внешних ключей нет вовсе
    (связь с изделиями текстовая и объявлена в `refs`).
    """
    вид = _вид(kind)
    таблица = вид.get("table")
    if not таблица or "id" not in row.keys():
        return []
    объяснения = вид.get("fk_handled", {})
    итог = []
    for t, колонка in _ссылающиеся_таблицы(conn, таблица):
        n = conn.execute(
            f"SELECT COUNT(*) AS n FROM {t} WHERE {колонка} = ?", (row["id"],)
        ).fetchone()["n"]
        итог.append({
            "label": f"{t}.{колонка}",
            "count": n,
            "handled": объяснения.get(f"{t}.{колонка}", "НЕ УЧТЕНО"),
        })
    return итог


def build_plan(conn, kind: str, key: str) -> dict:
    """Дерево: сама запись, её подчинённые, ссылки на каждом уровне.

    `needs_replacement` у узла — истина, если ссылки есть у него САМОГО ИЛИ
    у кого-то из подчинённых. Второе так же важно, как первое: без
    контрагента-замены неоткуда взять список договоров-замен, даже когда на
    самого контрагента не ссылается никто.
    """
    вид = _вид(kind)
    row = _строка(conn, kind, key)
    refs = вид["refs"](conn, row) if "refs" in вид else []
    cascade = вид["cascade"](conn, row) if "cascade" in вид else []
    blockers = вид["blockers"](conn, row) if "blockers" in вид else []
    дети = [build_plan(conn, дkind, дkey)
            for дkind, дkey in (вид["children"](conn, row) if "children" in вид else [])]
    нужна_замена = bool(refs) or any(д["needs_replacement"] for д in дети)
    # Замену предлагаем только там, где её есть чем выбрать: у справочника с
    # blockers («Объект», «Проект») замены не бывает по решению, у префикса
    # марок — за ненадобностью.
    можно_заменить = "candidates" in вид
    return {
        "kind": kind,
        "key": _ключ(kind, row),
        "kind_title": вид["title"],
        "label": вид["label"](conn, row),
        "parent_kind": вид.get("parent_kind"),
        "refs": refs,
        "cascade": cascade,
        "checked": _сверка_ссылок(conn, kind, row),
        "blockers": blockers,
        "children": дети,
        "needs_replacement": нужна_замена and можно_заменить,
        "replaceable": можно_заменить,
        # Можно ли вместо замены ПЕРЕНЕСТИ подчинённых к другой записи —
        # то есть свернуть задвоенное. Предлагается только там, где
        # подчинённые есть: переносить у марки или подтипа нечего.
        "mergeable": можно_заменить and "adopt" in вид and bool(дети),
        "adopt_title": вид.get("adopt_title"),
    }


def _все_узлы(узел) -> list:
    yield узел
    for ребёнок in узел["children"]:
        yield from _все_узлы(ребёнок)


def _блокировки(узел) -> list:
    """Всё, что мешает удалению во всём поддереве, с указанием, у кого."""
    итог = []
    for у in _все_узлы(узел):
        for b in у["blockers"]:
            итог.append({**b, "owner": f"{у['kind_title']} «{у['label']}»"})
        # Ссылка, которой нет в объяснениях реестра (появилась миграцией
        # позже этого модуля), останавливает удаление. Лучше отказать и
        # назвать колонку, чем оставить висячую ссылку молча.
        for c in у.get("checked", []):
            if c["handled"] == "НЕ УЧТЕНО" and c["count"]:
                итог.append({"label": f"неучтённая ссылка {c['label']}", "count": c["count"],
                             "owner": f"{у['kind_title']} «{у['label']}»"})
        if у["needs_replacement"] is False and у["refs"] and not у["replaceable"]:
            for r in у["refs"]:
                итог.append({**r, "owner": f"{у['kind_title']} «{у['label']}»"})
    return итог


@router.get("/dictionaries/{kind}/{key}/delete-plan")
def delete_plan(kind: str, key: str, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        план = build_plan(conn, kind, key)
        return {"plan": план, "blockers": _блокировки(план)}
    finally:
        conn.close()


@router.get("/dictionaries/{kind}/candidates")
def candidates(kind: str, key: str = Query(...), parent: Optional[str] = Query(None),
               admin: sqlite3.Row = Depends(require_system_admin)):
    """Чем можно заменить запись `key`, если её ВЛАДЕЛЕЦ заменён на `parent`.

    Отдельным запросом, а не списком внутри плана: список замен подчинённой
    записи зависит от того, что человек выберет владельцу, а это выясняется
    уже после того, как план построен.
    """
    вид = _вид(kind)
    if "candidates" not in вид:
        return []
    conn = get_connection()
    try:
        row = _строка(conn, kind, key)
        return вид["candidates"](conn, row, parent)
    finally:
        conn.close()


# ==================== ВЫПОЛНЕНИЕ ====================


def _проверить_и_собрать(conn, узел, замены: dict, выбор_владельца: Optional[str],
                         план_действий: list) -> None:
    """Обход сверху вниз: проверяем, что замена указана и допустима, и
    складываем в `план_действий` пары (узел, строка-замена).

    Допустимость проверяется ПО СПИСКУ КАНДИДАТОВ, а не просто «такая запись
    существует»: список кандидатов и есть выражение иерархии владельцев, и
    сверять с ним — единственный способ не разойтись с тем, что видел
    человек в форме.
    """
    вид = _вид(узел["kind"])
    цель = замены.get(f"{узел['kind']}:{узел['key']}")
    строка_замены = None
    if узел["needs_replacement"]:
        if not цель:
            raise HTTPException(
                status_code=400,
                detail=f"Не выбрана замена: {вид['title']} «{узел['label']}»")
        row = _строка(conn, узел["kind"], узел["key"])
        допустимые = {c["key"] for c in вид["candidates"](conn, row, выбор_владельца)}
        if not допустимые:
            raise HTTPException(
                status_code=409,
                detail=f"Заменить нечем: у выбранного владельца нет другой записи "
                       f"«{вид['title']}». Заведите её и повторите удаление.")
        if цель not in допустимые:
            raise HTTPException(
                status_code=400,
                detail=f"Замена для «{узел['label']}» не подходит выбранному владельцу — "
                       f"выберите из списка")
        строка_замены = _строка(conn, узел["kind"], цель)
        if узел["refs"]:
            план_действий.append((узел, строка_замены))
    for ребёнок in узел["children"]:
        _проверить_и_собрать(conn, ребёнок, замены, цель, план_действий)


def _удалить_снизу_вверх(conn, узел) -> None:
    for ребёнок in узел["children"]:
        _удалить_снизу_вверх(conn, ребёнок)
    вид = _вид(узел["kind"])
    вид["delete"](conn, _строка(conn, узел["kind"], узел["key"]))


@router.post("/dictionaries/{kind}/{key}/delete")
def delete_entry(kind: str, key: str, body: DeleteIn,
                 admin: sqlite3.Row = Depends(require_system_admin)):
    """Проверка → замена → удаление, всё в ОДНОЙ транзакции.

    Порядок обязателен и не переставляется: перевести ссылки после удаления
    было бы некуда, а удалить до перевода — значит на мгновение оставить
    изделия без контракта и, если что-то упадёт следом, оставить их так
    навсегда. Одна транзакция закрывает и это: либо переехало всё, либо
    ничего.
    """
    conn = get_connection()
    try:
        план = build_plan(conn, kind, key)
        мешает = _блокировки(план)
        if мешает:
            перечень = ", ".join(f"{b['owner']}: {b['label']} — {b['count']}" for b in мешает)
            raise HTTPException(
                status_code=409,
                detail=f"Удалить нельзя, за записью ещё стоят данные: {перечень}")

        сводка = []
        if body.mode == "merge":
            вид = _вид(kind)
            if "adopt" not in вид:
                raise HTTPException(
                    status_code=400,
                    detail=f"У записи «{вид['title']}» нет подчинённых, которые можно перенести")
            цель_ключ = body.replacements.get(f"{kind}:{план['key']}")
            row = _строка(conn, kind, план["key"])
            допустимые = {c["key"] for c in вид["candidates"](conn, row, None)}
            if not цель_ключ or цель_ключ not in допустимые:
                raise HTTPException(
                    status_code=400,
                    detail="Выберите запись, к которой перенести подчинённые")
            замена = _строка(conn, kind, цель_ключ)
            отчёт = []
            вид["adopt"](conn, row["id"], замена["id"], отчёт)
            # Ссылки на САМУ запись (у крана это изделия) переводятся так же,
            # как при обычной замене: перенос подчинённых их не касается.
            перенесено = вид["repoint"](conn, row, замена) if "repoint" in вид else []
            сводка.append({
                "kind": kind, "from": план["label"], "to": вид["label"](conn, замена),
                "moved": перенесено, "adopted": отчёт,
            })
            # Удаляется ТОЛЬКО сама запись: подчинённые уже уехали, и заново
            # обходить дерево нельзя — построенный план описывает состояние ДО
            # переезда, а половины его записей на прежнем месте больше нет.
            вид["delete"](conn, _строка(conn, kind, план["key"]))
        else:
            действия = []
            _проверить_и_собрать(conn, план, body.replacements, None, действия)
            for узел, замена in действия:
                вид = _вид(узел["kind"])
                row = _строка(conn, узел["kind"], узел["key"])
                перенесено = вид["repoint"](conn, row, замена)
                сводка.append({
                    "kind": узел["kind"], "from": узел["label"],
                    "to": вид["label"](conn, замена),
                    "moved": перенесено,
                })
            _удалить_снизу_вверх(conn, план)
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    # В режиме переноса удалена ОДНА запись — подчинённые уехали, а не
    # исчезли. Считать их удалёнными по плану значило бы врать в журнале.
    удалено = ([{"kind": план["kind"], "label": план["label"]}] if body.mode == "merge"
               else [{"kind": у["kind"], "label": у["label"]} for у in _все_узлы(план)])
    activity.log(
        "dictionary_merge" if body.mode == "merge" else "dictionary_delete",
        user=admin, entity_type=kind,
        old_value=план["label"],
        new_value="; ".join(f"{s['from']} → {s['to']}" for s in сводка) or None,
        details={"удалено записей": len(удалено),
                 "удалено": [f"{у['kind']}: {у['label']}" for у in удалено],
                 "перенос": сводка},
    )
    return {"deleted": удалено, "moved": сводка}

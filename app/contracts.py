"""
Контракты (см. Docs/backlog.md, "Контрактация 2.0"): контракт привязан к
одной Спецификации (app/counterparties.py) — а через неё транзитивно к
Договору и Контрагенту, с расшифровкой законтрактованных количеств по
(тип, марка) в contract_lines. Контракты не привязаны к конкретному
source_file — контракт на поставку колонн действует в рамках всего
проекта, не одного чертежа.

"Факт" по строке контракта — количество элементов с этим contract_id, этим
(element_type, mark) и статусом НЕ "planned".

Привязка элемента к контракту — ОБЫЧНОЕ ЖИВОЕ ПОЛЕ elements.contract_id
(с 2026-08-01). Раньше оно было денормализованным кэшем последней по
changed_at записи status_history; отказались, потому что версионировать
нечего: контракт проставляется один раз, при уходе с "Запланирован", и
дальше не меняется — кроме случая инцидента, когда элемент откатывают на
"Запланирован" (контракт снимается) и контрактуют заново. Прежний кэш к
тому же успел разойтись со своим источником на боевой базе, и первый же
пересчёт молча снял бы контракт с двух элементов из трёх (см.
Docs/backlog.md, запись 2026-08-01).

Инвариант: статус "Запланирован" ⇒ контракт пуст. Держится в одном месте —
sync_element_contract. status_history.contract_id остаётся аудиторским
СНИМКОМ "что выбрали в тот момент" (та же природа, что changed_by с ФИО), и
источником правды не является — кроме двух мест, где история и есть то, что
восстанавливают: импорт истории и ручная правка записи истории
(adopt_contract_from_history).

Партии (batches) убраны целиком (см. Docs/backlog.md) — плановая дата
поставки теперь простое живое поле на самом элементе
(elements.planned_delivery_date, app/element_dates.py), а не отдельная
сущность с разбивкой по маркам.
"""

import re
import json
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app.access import (
    assert_object_access,
    require_object_access,
    require_object_admin,
    require_system_admin,
)
from app.auth import get_current_user, require_admin
from app.db import get_connection

router = APIRouter(prefix="/contracts", tags=["contracts"])


class ContractLineIn(BaseModel):
    # None — тип не определён (см. app/contracting_import.py: марка не
    # найдена ни у одного элемента, эвристика по префиксу тоже не дала
    # результата); администратор донастраивает вручную в справочнике.
    # Форма создания контракта в UI требует выбор типа явно (не
    # позволяет отправить None), но модель должна уметь прочитать уже
    # существующую такую строку обратно.
    element_type: Optional[str] = None
    mark: Optional[str] = None
    quantity: int


class ContractLineOut(ContractLineIn):
    id: int
    fact: int
    damaged: int
    remaining: int
    exceeded: bool


# Инцидент повреждения элементов на стройке — только количество (тип +
# число), без привязки к конкретным elements.id, без марки и без
# отдельного статуса подтверждения (см. Docs/backlog.md, "Учёт
# повреждённых элементов..." — сознательно не расширяем маркой вместе с
# "Контрактация 2.0", это отдельная тема).
class ContractIncidentIn(BaseModel):
    element_type: str
    quantity: int
    incident_date: str
    description: Optional[str] = None


class ContractIncidentOut(ContractIncidentIn):
    id: int


class ContractIn(BaseModel):
    # Наименование контракта (name в ContractOut ниже) больше не вводится
    # руками — генерируется всегда заново из цепочки Контрагент/Договор/
    # Спецификация + theme (см. build_contract_name, живой запрос
    # пользователя, 2026-07-28). theme — единственное свободное поле,
    # относящееся к "названию". contract_date убрана целиком — дата
    # контракта избыточна, есть дата спецификации (specification_date).
    specification_id: int
    theme: Optional[str] = None
    lines: list[ContractLineIn]
    incidents: list[ContractIncidentIn] = []


class ContractOut(BaseModel):
    id: int
    name: str  # всегда сгенерировано (build_contract_name), не хранится как есть
    theme: Optional[str] = None
    specification_id: int
    specification_number: str
    specification_date: Optional[str] = None
    agreement_id: int
    agreement_number: str
    agreement_date: Optional[str] = None
    counterparty_id: int
    counterparty_short_name: str
    counterparty_code: Optional[str] = None
    lines: list[ContractLineOut]
    incidents: list[ContractIncidentOut]


def _ru_date(date_str: Optional[str]) -> Optional[str]:
    """"YYYY-MM-DD..." -> "ДД.ММ.ГГГГ" — тот же формат, что formatDateRu на
    фронтенде (app.js), нужен здесь только для build_contract_name (единое
    место генерации имени контракта, используется и API, и XLS-экспортом,
    см. app/export.py)."""
    if not date_str:
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", date_str)
    return f"{m.group(3)}.{m.group(2)}.{m.group(1)}" if m else date_str


def build_document_label(number: str, date_str: Optional[str]) -> str:
    """Реквизиты одного документа (договора или спецификации) — "НОМЕР от
    ДД.ММ.ГГГГ", а без даты просто "НОМЕР". Отдельная функция, потому что
    ровно этот же текст нужен не только внутри build_contract_name ниже, но
    и по отдельности — XLS-экспорт (app/export.py) выводит договор и
    спецификацию РАЗНЫМИ колонками (живой запрос пользователя, 2026-07-28),
    и формат должен совпадать с тем, что видно в интерфейсе."""
    return f"{number} от {_ru_date(date_str)}" if date_str else number


def build_contract_name(
    counterparty_short_name: str, agreement_number: str, agreement_date: Optional[str],
    specification_number: str, specification_date: Optional[str], theme: Optional[str],
) -> str:
    """Наименование контракта — ВСЕГДА генерируется из цепочки
    Контрагент/Договор/Спецификация (+ Тема, если задана), не хранится как
    отдельное поле (живой запрос пользователя, 2026-07-28) — нет риска,
    что имя разойдётся с реальными реквизитами после их правки.
    Единственное место генерации, переиспользуется _to_contract_out ниже,
    /plan-data (app/main.py) и XLS-экспортом (app/export.py)."""
    agreement_text = build_document_label(agreement_number, agreement_date)
    specification_text = build_document_label(specification_number, specification_date)
    name = f"{counterparty_short_name}/{agreement_text}/{specification_text}"
    if theme:
        name += f" ({theme})"
    return name


def _line_fact(conn, contract_id: int, element_type: Optional[str], mark: Optional[str]) -> int:
    """Факт по ОДНОЙ строке контракта. Остался для contract_line_warning —
    там нужна ровно одна строка на каждую смену статуса, групповой запрос
    (_load_contract_bundle) был бы дороже. Быстрый благодаря индексу
    idx_elements_contract_line (app/db.py) — без него это был полный скан
    elements на КАЖДЫЙ элемент массовой смены статуса."""
    row = conn.execute(
        "SELECT COUNT(*) as n FROM elements "
        "WHERE contract_id = ? AND element_type IS ? AND mark IS ? AND current_status != 'planned'",
        (contract_id, element_type, mark),
    ).fetchone()
    return row["n"]


def _line_damaged(conn, contract_id: int, element_type: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(quantity), 0) as n FROM contract_incidents WHERE contract_id = ? AND element_type = ?",
        (contract_id, element_type),
    ).fetchone()
    return row["n"]


def _load_contract_bundle(conn, contract_id: Optional[int] = None) -> dict:
    """Всё, что нужно для сборки ответа по контрактам, ЧЕТЫРЬМЯ групповыми
    запросами — вместо пары запросов НА КАЖДУЮ строку контракта.

    Так было раньше: `_line_fact` делал `COUNT(*) FROM elements WHERE
    contract_id=? AND element_type IS ? AND mark IS ?` на каждую строку.
    Индекса под этот набор колонок нет, то есть каждый вызов — полный скан
    `elements`. На реальных данных (16 контрактов, 406 строк, 9422
    элемента) это 860 SQL-запросов и **2757 мс** на один `GET /contracts` —
    замерено; из них 2841 мс приходилось ровно на 406 сканов (в пределах
    погрешности — всё время). Диалог массовой смены статуса ЖДАЛ этот
    ответ перед показом, отсюда живой репорт «долго открывается окно»
    (см. Docs/backlog.md).

    Ключи `facts` — кортеж (contract_id, element_type, mark), где оба
    последних могут быть None: `GROUP BY` в SQLite кладёт NULL в
    собственную группу, что в точности повторяет прежнюю NULL-безопасную
    семантику `IS ?` (обычное `=` с NULL не совпало бы никогда).

    contract_id — сузить до одного контракта (карточка/создание/правка);
    None — все сразу (список контрактов).
    """
    scope = " AND contract_id = ?" if contract_id is not None else ""
    args = (contract_id,) if contract_id is not None else ()

    facts = {
        (r["contract_id"], r["element_type"], r["mark"]): r["n"]
        for r in conn.execute(
            "SELECT contract_id, element_type, mark, COUNT(*) AS n FROM elements "
            f"WHERE contract_id IS NOT NULL AND current_status != 'planned'{scope} "
            "GROUP BY contract_id, element_type, mark",
            args,
        ).fetchall()
    }
    damaged = {
        (r["contract_id"], r["element_type"]): r["n"]
        for r in conn.execute(
            "SELECT contract_id, element_type, COALESCE(SUM(quantity), 0) AS n FROM contract_incidents "
            f"WHERE 1=1{scope} GROUP BY contract_id, element_type",
            args,
        ).fetchall()
    }

    lines: dict = {}
    for r in conn.execute(
        f"SELECT * FROM contract_lines WHERE 1=1{scope} ORDER BY contract_id, element_type, mark", args
    ).fetchall():
        lines.setdefault(r["contract_id"], []).append(r)

    incidents: dict = {}
    for r in conn.execute(
        f"SELECT * FROM contract_incidents WHERE 1=1{scope} ORDER BY contract_id, incident_date DESC, id DESC", args
    ).fetchall():
        incidents.setdefault(r["contract_id"], []).append(r)

    return {"facts": facts, "damaged": damaged, "lines": lines, "incidents": incidents}


def _specification_chain(conn, specification_id: int):
    """Джойн specification -> agreement -> counterparty — единственное
    место, откуда резолвится всё, что раньше лежало прямо в
    contracts.supplier/contracts.code."""
    row = conn.execute(
        """
        SELECT
            s.id AS specification_id, s.number AS specification_number, s.specification_date AS specification_date,
            a.id AS agreement_id, a.number AS agreement_number, a.agreement_date AS agreement_date,
            c.id AS counterparty_id, c.short_name AS counterparty_short_name, c.code AS counterparty_code
        FROM specifications s
        JOIN agreements a ON a.id = s.agreement_id
        JOIN counterparties c ON c.id = a.counterparty_id
        WHERE s.id = ?
        """,
        (specification_id,),
    ).fetchone()
    return row


def _to_contract_out(conn, contract_row, bundle: Optional[dict] = None) -> ContractOut:
    """bundle — предзагруженные агрегаты (см. _load_contract_bundle). Список
    контрактов строит его ОДИН раз на все контракты и передаёт сюда;
    одиночные вызовы могут не передавать — тогда он собирается здесь же, но
    сразу суженный до этого контракта (те же 4 запроса, не 2 на строку)."""
    cid = contract_row["id"]
    if bundle is None:
        bundle = _load_contract_bundle(conn, cid)
    chain = _specification_chain(conn, contract_row["specification_id"])
    line_rows = bundle["lines"].get(cid, [])
    lines = []
    for lr in line_rows:
        fact = bundle["facts"].get((cid, lr["element_type"], lr["mark"]), 0)
        damaged = bundle["damaged"].get((cid, lr["element_type"]), 0)
        lines.append(
            ContractLineOut(
                id=lr["id"], element_type=lr["element_type"], mark=lr["mark"], quantity=lr["quantity"],
                fact=fact, damaged=damaged, remaining=lr["quantity"] - fact - damaged,
                exceeded=(fact + damaged) > lr["quantity"],
            )
        )
    incident_rows = bundle["incidents"].get(cid, [])
    incidents = [
        ContractIncidentOut(
            id=ir["id"], element_type=ir["element_type"], quantity=ir["quantity"],
            incident_date=ir["incident_date"], description=ir["description"],
        )
        for ir in incident_rows
    ]
    name = build_contract_name(
        chain["counterparty_short_name"], chain["agreement_number"], chain["agreement_date"],
        chain["specification_number"], chain["specification_date"], contract_row["theme"],
    )
    return ContractOut(
        id=cid, name=name, theme=contract_row["theme"],
        specification_id=chain["specification_id"], specification_number=chain["specification_number"],
        specification_date=chain["specification_date"],
        agreement_id=chain["agreement_id"], agreement_number=chain["agreement_number"],
        agreement_date=chain["agreement_date"],
        counterparty_id=chain["counterparty_id"], counterparty_short_name=chain["counterparty_short_name"],
        counterparty_code=chain["counterparty_code"],
        lines=lines, incidents=incidents,
    )


@router.get("", response_model=list[ContractOut])
def list_contracts(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        # ORDER BY name невозможен — name больше не столбец, а генерируется
        # в _to_contract_out; сортируем по тому же порядку компонентов, что
        # и само наименование (Контрагент/Договор/Спецификация).
        rows = conn.execute(
            """
            SELECT co.* FROM contracts co
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            JOIN counterparties c ON c.id = a.counterparty_id
            ORDER BY c.short_name, a.number, s.number
            """
        ).fetchall()
        # Агрегаты — ОДИН раз на все контракты сразу (см. _load_contract_bundle),
        # иначе на каждую строку каждого контракта уходило по два запроса.
        bundle = _load_contract_bundle(conn)
        return [_to_contract_out(conn, r, bundle) for r in rows]
    finally:
        conn.close()


def find_or_create_contract(conn, specification_id: int, theme: Optional[str] = None) -> int:
    """Один Контракт на Спецификацию — используется импортом файла
    контрактации (app/contracting_import.py), где строка файла уже
    однозначно определяет (Контрагент, Договор, Спецификация). Наименование
    не передаётся — оно всегда генерируется (см. build_contract_name)."""
    row = conn.execute(
        "SELECT id FROM contracts WHERE specification_id = ?", (specification_id,)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT INTO contracts (specification_id, theme) VALUES (?, ?)",
        (specification_id, theme),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def _guard_specification(conn, user, specification_id: int) -> None:
    """Доступ к контракту — по объекту его спецификации: контракт ->
    спецификация -> договор -> object_id (цепочка этапа A).

    Объект контракта именно ВЫВОДИТСЯ, а не хранится полем — поэтому и
    проверять его надо по цепочке, иначе появился бы второй источник
    правды о принадлежности контракта.
    """
    row = conn.execute(
        "SELECT a.object_id FROM specifications s "
        "JOIN agreements a ON a.id = s.agreement_id WHERE s.id = ?",
        (specification_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Спецификация не найдена")
    if row["object_id"] is None:
        if user["role"] != "admin":
            raise HTTPException(
                status_code=403,
                detail="Договор спецификации не привязан к объекту — правит администратор сервиса",
            )
        return
    assert_object_access(conn, user, row["object_id"], "admin")


@router.post("", response_model=ContractOut)
def create_contract(body: ContractIn, admin: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    _guard_specification(conn, admin, body.specification_id)
    try:
        spec = conn.execute("SELECT id FROM specifications WHERE id = ?", (body.specification_id,)).fetchone()
        if not spec:
            raise HTTPException(status_code=404, detail="Спецификация не найдена")
        conn.execute(
            "INSERT INTO contracts (specification_id, theme) VALUES (?, ?)",
            (body.specification_id, body.theme),
        )
        contract_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        for line in body.lines:
            conn.execute(
                "INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)",
                (contract_id, line.element_type, line.mark, line.quantity),
            )
        for inc in body.incidents:
            conn.execute(
                "INSERT INTO contract_incidents (contract_id, element_type, quantity, incident_date, description) "
                "VALUES (?, ?, ?, ?, ?)",
                (contract_id, inc.element_type, inc.quantity, inc.incident_date, inc.description),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        return _to_contract_out(conn, row)
    finally:
        conn.close()


@router.patch("/{contract_id}", response_model=ContractOut)
def update_contract(contract_id: int, body: ContractIn, admin: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    _guard_specification(conn, admin, body.specification_id)
    try:
        existing = conn.execute("SELECT id FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Контракт не найден")
        spec = conn.execute("SELECT id FROM specifications WHERE id = ?", (body.specification_id,)).fetchone()
        if not spec:
            raise HTTPException(status_code=404, detail="Спецификация не найдена")
        conn.execute(
            "UPDATE contracts SET specification_id=?, theme=?, updated_at=datetime('now') WHERE id=?",
            (body.specification_id, body.theme, contract_id),
        )
        # Полная замена строк/инцидентов — список редактируется в UI
        # целиком, проще и предсказуемее частичного патча по id строки.
        conn.execute("DELETE FROM contract_lines WHERE contract_id = ?", (contract_id,))
        for line in body.lines:
            conn.execute(
                "INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)",
                (contract_id, line.element_type, line.mark, line.quantity),
            )
        conn.execute("DELETE FROM contract_incidents WHERE contract_id = ?", (contract_id,))
        for inc in body.incidents:
            conn.execute(
                "INSERT INTO contract_incidents (contract_id, element_type, quantity, incident_date, description) "
                "VALUES (?, ?, ?, ?, ?)",
                (contract_id, inc.element_type, inc.quantity, inc.incident_date, inc.description),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        return _to_contract_out(conn, row)
    finally:
        conn.close()


@router.get("/{contract_id}/elements")
def list_contract_elements(contract_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Развёрнутый вид контракта (см. Docs/backlog.md, "Контрактация 2.0",
    п.3) — одна строка на физический элемент, не на аггрегат по марке.
    Намеренно БЕЗ лимита пагинации, в отличие от GET /elements (максимум
    5000 там) — реалистичный контракт заведомо укладывается в память."""
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Контракт не найден")
        rows = conn.execute(
            "SELECT id, element_type, mark, current_status, planned_delivery_date, "
            "project_delivery_date, project_smr_start_date, actual_delivery_date "
            "FROM elements WHERE contract_id = ? ORDER BY element_type, mark, id",
            (contract_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# Контракт по умолчанию — настройка ОБЪЕКТА (этап D): «чем обычно возят на
# ЭТУ стройку». Общая запись означала бы, что поставщик, выбранный на одном
# здании, подставляется и на соседнем.
@router.get("/default-map")
def get_default_contracts(object_id: int = Query(...),
                          user: sqlite3.Row = Depends(require_object_access)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT element_type, contract_id FROM default_contracts WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: r["contract_id"] for r in rows}
    finally:
        conn.close()


@router.put("/default-map")
def set_default_contracts(mapping: dict, object_id: int = Query(...),
                          admin: sqlite3.Row = Depends(require_object_admin)):
    conn = get_connection()
    try:
        for element_type, contract_id in mapping.items():
            conn.execute(
                "INSERT INTO default_contracts (object_id, element_type, contract_id) VALUES (?, ?, ?) "
                "ON CONFLICT(object_id, element_type) DO UPDATE SET contract_id = excluded.contract_id",
                (object_id, element_type, contract_id),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT element_type, contract_id FROM default_contracts WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: r["contract_id"] for r in rows}
    finally:
        conn.close()


def resolve_contract_for_new_row(
    conn, element_id: int, explicit: bool, value: Optional[int]
) -> Optional[int]:
    """
    Контракт для СНИМКА в новой записи status_history — «что выбрали в этот
    момент». Если пользователь явно выбрал значение в диалоге подтверждения
    (`explicit=True` — поле было в теле запроса, даже если это null для "без
    контракта"), используется оно; иначе наследуется тот, что уже стоит у
    элемента.

    Источником правды с 2026-08-01 является elements.contract_id, а не
    история (см. sync_element_contract ниже) — здесь остаётся только
    аудиторский снимок, той же природы, что status_history.changed_by
    (текстовое ФИО на момент изменения).
    """
    if explicit:
        return value
    row = conn.execute(
        "SELECT contract_id FROM elements WHERE id = ?", (element_id,)
    ).fetchone()
    return row["contract_id"] if row else None


def sync_element_contract(
    conn, element_id: int, effective_status: str,
    explicit: bool = False, value: Optional[int] = None,
) -> Optional[int]:
    """
    Приводит elements.contract_id в соответствие с ЭФФЕКТИВНЫМ статусом.

    Контракт — обычное живое поле элемента, а НЕ кэш последней записи
    истории (как было до 2026-08-01). Причина не в удобстве: привязка
    происходит один раз, при уходе с «Запланирован», и дальше не меняется —
    кроме случая инцидента, когда элемент откатывают на «Запланирован»
    (контракт снимается) и контрактуют заново. То есть версионировать
    нечего. Хуже того, прежний кэш уже разошёлся со своим источником: на
    боевой базе у двух элементов из трёх контракт стоял при единственной
    записи истории «Запланирован» без контракта, и первый же пересчёт
    молча снял бы его (см. Docs/backlog.md, запись 2026-08-01).

    Решение принимается по ЭФФЕКТИВНОМУ статусу (тому, что вернул
    recompute_status_and_actual_date), а не по статусу вставляемой записи.
    Разница видна при backdating: запись «Запланирован» задним числом не
    делает элемент запланированным, если поверх неё лежит более поздний
    «Доставлен» — и контракт снимать в этом случае нельзя.

    updated_at двигаем при любом изменении: по нему опрос об изменениях
    (GET /changes) понимает, что элемент надо переслать другим открытым
    вкладкам.
    """
    row = conn.execute(
        "SELECT contract_id FROM elements WHERE id = ?", (element_id,)
    ).fetchone()
    current = row["contract_id"] if row else None
    # Инвариант: «Запланирован» ⇒ контракт пуст. Безусловно, даже если
    # contract_id передан явно — диалог выбора контракта для перехода НА
    # «Запланирован» не показывается (Docs/TZ.md §5), явного намерения
    # «оставить контракт» в этом направлении быть не может.
    if effective_status == "planned":
        new_id = None
    elif explicit:
        new_id = value
    else:
        new_id = current
    if new_id != current:
        conn.execute(
            "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
            (new_id, element_id),
        )
    return new_id


def adopt_contract_from_history(conn, element_id: int, effective_status: str) -> Optional[int]:
    """
    Принимает контракт элемента ИЗ снимка в истории — обратное направление
    к sync_element_contract.

    Нужно ровно в двух случаях, где история является источником, а не
    следствием: восстановление из выгрузки (app/history_import.py — файл
    и есть то, что восстанавливают) и ручная правка записи истории в
    интерфейсе (там пользователь меняет контракт именно через запись —
    это единственный путь "сменить контракт, не меняя статус").

    Во всех остальных местах контракт берётся с элемента: снимок в истории
    аудиторский и источником правды не является.
    """
    if effective_status == "planned":
        contract_id = None
    else:
        latest = conn.execute(
            "SELECT contract_id FROM status_history WHERE element_id = ? "
            "ORDER BY changed_at DESC, id DESC LIMIT 1",
            (element_id,),
        ).fetchone()
        contract_id = latest["contract_id"] if latest else None
    conn.execute(
        "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
        (contract_id, element_id),
    )
    return contract_id


def recompute_status_and_actual_date(conn, element_id: int) -> tuple[str, Optional[str]]:
    """
    elements.current_status и elements.actual_delivery_date — денормализованные
    кэши самой поздней по changed_at записи истории (тот же приём, что и у
    sync_element_contract выше). actual_delivery_date = момент
    перехода в статус "Доставлено" (Status.DELIVERED, см. Docs/backlog.md,
    "Контрактация 2.0", п.8) — если текущий эффективный статус не
    "delivered" (в т.ч. после отката/удаления записи истории), дата
    сбрасывается в NULL, а не остаётся висеть от прошлого визита в
    "Доставлено". Общая точка для apply_status_change ниже,
    delete_history_entry (app/main.py) и import_history
    (app/history_import.py) — раньше каждый пересчитывал только
    current_status по отдельности, actual_delivery_date могла бы протухнуть.
    """
    latest = conn.execute(
        "SELECT status, changed_at FROM status_history WHERE element_id = ? ORDER BY changed_at DESC, id DESC LIMIT 1",
        (element_id,),
    ).fetchone()
    effective_status = latest["status"]
    actual_delivery_date = latest["changed_at"] if effective_status == "delivered" else None
    conn.execute(
        "UPDATE elements SET current_status = ?, actual_delivery_date = ?, updated_at = datetime('now') WHERE id = ?",
        (effective_status, actual_delivery_date, element_id),
    )
    return effective_status, actual_delivery_date


def enrich_element_row(conn, row_dict: dict) -> dict:
    """Добавляет counterparty_code (денормализованный скаляр для допстроки
    подписи на схеме) в уже собранный словарь ответа элемента —
    используется везде, где элемент возвращается клиенту
    (apply_status_change, app/element_dates.py, GET /elements/{id}), не
    только в /plan-data."""
    # manual_fields в БД — JSON-текст; наружу отдаём списком имён полей.
    if "manual_fields" in row_dict:
        raw = row_dict.get("manual_fields")
        if isinstance(raw, str):
            try:
                row_dict["manual_fields"] = json.loads(raw)
            except ValueError:
                row_dict["manual_fields"] = None

    contract_id = row_dict.get("contract_id")
    row_dict["counterparty_code"] = None
    if contract_id is not None:
        r = conn.execute(
            """
            SELECT c.code FROM contracts co
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            JOIN counterparties c ON c.id = a.counterparty_id
            WHERE co.id = ?
            """,
            (contract_id,),
        ).fetchone()
        row_dict["counterparty_code"] = r["code"] if r else None
    return row_dict


def apply_status_change(
    conn, element_id: int, status: str, contract_explicit: bool, contract_value: Optional[int],
    changed_at: Optional[str], comment: Optional[str], changed_by: str, changed_by_user_id: int,
) -> dict:
    """
    Общее тело смены статуса ОДНОГО элемента — INSERT в status_history ->
    пересчёт current_status/actual_delivery_date (по самой поздней записи,
    не обязательно только что вставленной, важно для backdating) ->
    пересчёт кэша elements.contract_id -> contract_line_warning. НЕ
    коммитит сама — вызывающая сторона решает, когда коммитить (одиночный
    PATCH — сразу после вызова; массовая смена статуса — один раз после
    цикла по всем элементам, см. update_status_bulk в app/main.py).
    Используется и одиночным, и массовым эндпоинтом — не дублировать эту
    последовательность действий в другом месте.

    contract_explicit/contract_value — та же пара, что раньше собиралась
    вручную в app/main.py через body.model_fields_set (см.
    resolve_contract_for_new_row выше) — для массовой смены статуса
    contract_explicit всегда True (фронт гарантирует явный выбор в
    каждой строке таблицы, см. Docs/backlog.md).
    """
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    if row is None:
        raise LookupError(f"Элемент {element_id} не найден")

    # Снимок контракта для записи истории — «что выбрали в этот момент».
    # Откат на "Запланирован" снимает контракт и тем самым поставщика: у
    # элемента нет отдельного поля "поставщик", он везде резолвится ОТ
    # контракта (см. counterpartyFilterValue на фронтенде). Само поле
    # элемента приводится в соответствие ниже, ПОСЛЕ пересчёта статуса —
    # по эффективному статусу, а не по вставляемому (см.
    # sync_element_contract).
    if status == "planned":
        row_contract_id = None
    else:
        row_contract_id = resolve_contract_for_new_row(conn, element_id, contract_explicit, contract_value)

    if changed_at:
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_at, changed_by, changed_by_user_id, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (element_id, status, changed_at, changed_by, changed_by_user_id, comment, row_contract_id),
        )
    else:
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (element_id, status, changed_by, changed_by_user_id, comment, row_contract_id),
        )

    effective_status, _ = recompute_status_and_actual_date(conn, element_id)
    element_contract_id = sync_element_contract(
        conn, element_id, effective_status, contract_explicit, contract_value
    )
    warning = contract_line_warning(conn, element_contract_id, row["element_type"], row["mark"])

    # Журнал (app/activity.py) — здесь, а не в эндпоинтах: смену статуса
    # выполняют два разных роута (одиночный и массовый), и запись в одном
    # общем месте гарантирует, что ни один путь не окажется незалогированным.
    # Постановка в очередь стоит ~4 мкс, на массовой операции это доли
    # секунды на десяток тысяч элементов — на время ответа не влияет.
    # Тип/подтип/марка пишутся СНИМКОМ: искать в журнале будут по ним, а сам
    # элемент к тому времени мог измениться.
    activity.log(
        "status_change",
        user_id=changed_by_user_id,
        user_name=changed_by,
        entity_type="element",
        entity_id=element_id,
        element_type=row["element_type"],
        subtype=row["subtype"],
        mark=row["mark"],
        old_value=row["current_status"],
        new_value=status,
        at=changed_at or None,
        details={"contract_id": element_contract_id} if element_contract_id else None,
    )

    updated_row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    history_rows = conn.execute(
        "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at", (element_id,)
    ).fetchall()
    data = dict(updated_row)
    data["history"] = [dict(h) for h in history_rows]
    data["contract_warning"] = warning
    enrich_element_row(conn, data)
    return data


def contract_line_warning(conn, contract_id: Optional[int], element_type: str, mark: Optional[str]) -> Optional[dict]:
    """Неблокирующее предупреждение о превышении по СТРОКЕ контракта (не по
    контракту в целом) — факт плюс подтверждённые повреждения (см.
    Docs/backlog.md, "Учёт повреждённых элементов...") против плана.
    Строка теперь ключуется (element_type, mark) NULL-safe, не только
    типом — см. "Контрактация 2.0"."""
    if contract_id is None:
        return None
    line = conn.execute(
        "SELECT * FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark IS ?",
        (contract_id, element_type, mark),
    ).fetchone()
    if not line:
        return None
    fact = _line_fact(conn, contract_id, element_type, mark)
    damaged = _line_damaged(conn, contract_id, element_type)
    if (fact + damaged) <= line["quantity"]:
        return None
    # contracts.name как СТОЛБЦА больше нет ("Контрактация 2.0" — имя всегда
    # генерируется, см. build_contract_name). Здесь оставался забытый
    # `SELECT name FROM contracts`, который падал с "no such column: name" —
    # но только при реально СРАБОТАВШЕМ превышении остатка (выше стоит
    # ранний return), поэтому баг дожил незамеченным до правки соседнего
    # кода. Резолвим имя тем же способом, что и весь остальной код.
    contract_row = conn.execute("SELECT specification_id, theme FROM contracts WHERE id = ?", (contract_id,)).fetchone()
    contract_name = "?"
    if contract_row:
        chain = _specification_chain(conn, contract_row["specification_id"])
        if chain:
            contract_name = build_contract_name(
                chain["counterparty_short_name"], chain["agreement_number"], chain["agreement_date"],
                chain["specification_number"], chain["specification_date"], contract_row["theme"],
            )
    return {
        "contract_id": contract_id,
        "contract_name": contract_name,
        "quantity": line["quantity"],
        "fact": fact,
        "damaged": damaged,
    }

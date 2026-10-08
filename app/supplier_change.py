"""
Документы контрактации: «Замена поставщика» и «Обмен привязками»
(2026-08-11, запрос пользователя; второй вид и проведение — тем же днём).

**Два вида операции в одном документе** (`kind`), потому что шапка, права,
журнал и жизненный цикл у них общие, а различаются только правила
проведения:

- `supplier_change` — «Замена поставщика»: НЕПОСТАВЛЕННЫЙ остаток одного
  контракта переводится на другой. Поставщик не устраивает по срокам или
  качеству; до документа это делалось поштучно, правкой контракта у каждого
  изделия.
- `link_swap` — «Обмен привязками»: изделия ОДНОЙ марки, стоящие на двух
  контрактах, меняются попарно всем, что относится к поставке — контрактом,
  плановой датой и ВСЕЙ историей статусов. Нужен, когда привязку перепутали:
  физически изделия стоят там, где стоят, а в учёте числятся наоборот.

**Документ проводится.** Черновик (`draft`) данных не трогает — это
намерение; «Провести» применяет всё разом (`posted`), «Отменить проведение»
возвращает исходное состояние. Проведение — ВСЁ ИЛИ НИЧЕГО: строка, которая
перестала подходить (статус уехал вперёд, место в новом контракте занял
соседний документ), останавливает проведение с перечнем причин, а не
пропускается молча. Документ уже сохранён, состав правится в черновике.

Чем отмена возвращает данные:

- `supplier_change_items.prev_contract_id` / `prev_planned_delivery_date` —
  «что было» у каждого изделия. У документов, записанных ДО появления
  проведения, поле пустое, и прежний контракт берётся из шапки
  (`from_contract_id`);
- `supplier_change_history_moves` — переезды записей истории: строка с
  `prev_element_id` возвращается прежнему изделию, строка без него (запись
  СОЗДАНА проведением) удаляется.

- `date_rebalance` — «Балансировка поставки» (2026-10-05, протокол «Развитие WEB 4Q26», A4): одинаковые изделия ОДНОЙ
  марки на ОДНОМ контракте (= у одного поставщика) получают плановые даты поставки заново: изделия сортируются по
  требуемой дате (начало СМР последней актуализации), согласованные плановые даты поставщика — по возрастанию, и
  i-му изделию достаётся i-я дата — а если можно обойтись несколькими обменами «просроченное ↔ с запасом», то делаются
  только они (см. `_rebalance_allocate`). Набор дат поставщика не меняется, переставляются только даты между изделиями.
  Контракт, статус и история не трогаются. Раздел прав тот же, что у обмена привязками (`doc_link_swap`): отдельный
  раздел ради одной операции над датами завёл бы лишнюю строку в матрице ролей; решение пользователя пересмотреть можно.

Правила «Замены поставщика» (интерфейс их только показывает, держит сервер):

1. **Поставленное на площадку не переносится.** Порог — «Отгружен» и выше
   (решение пользователя): отгруженное изделие уже изготовлено старым
   заводом и уехало. «Запланирован» в переносе не участвует по устройству
   системы — у него контракта нет вовсе (инвариант, см. app/contracts.py
   sync_element_contract).
2. **Больше, чем есть в новом контракте, не переносится.** Доступное —
   `план − факт − повреждено` по (тип, марка), та же формула, что у остатка
   в карточке контракта и в выборе контракта при смене статуса.
3. **Позиции нового контракта нет — переносить некуда** (доступно 0, а не
   «сколько угодно»).

Правила «Обмена привязками»:

1. **Стороны равны по количеству** — иначе пары не составить. Пара это
   строка стороны 1 и строка стороны 2 с одним `pair_no`; порядок задаёт
   человек в форме.
2. **Одна марка на весь документ** (выбор пользователя): обмен осмыслен
   только между одинаковыми изделиями.
3. **Ограничений по статусу нет** (решение пользователя): перепутанную
   привязку чаще всего и обнаруживают у смонтированных изделий.
4. Изделия стороны 1 обязаны стоять на контракте 1, стороны 2 — на
   контракте 2; одно изделие не может встретиться в документе дважды.

Почему при обмене переезжает ВСЯ история (решение пользователя): текущий
статус и фактическая дата — производные от истории
(`recompute_status_and_actual_date`), и обменять их, оставив историю на
месте, значило бы получить изделие, чей статус противоречит собственным
записям. Живое поле рядом — только `contract_id` и плановая дата, их и
меняем явно.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity, contract_guard, impersonation, record_version
from app.access import (
    assert_object_any_feature,
    assert_object_feature,
    has_feature,
    require_any_feature,
)
from app.auth import audit_display_name, get_current_user
from app.contracts import _specification_chain, build_contract_name, recompute_status_and_actual_date
from app.db import begin_write, get_connection, touch_elements
from app.models import STATUS_LABELS_RU, STATUS_ORDER

router = APIRouter(prefix="/supplier-changes", tags=["supplier-change"])

STATUS_TITLES = {s.value: STATUS_LABELS_RU[s] for s in STATUS_ORDER}

KIND_SUPPLIER = "supplier_change"
KIND_SWAP = "link_swap"
KIND_REBALANCE = "date_rebalance"
KIND_TITLES = {KIND_SUPPLIER: "Замена поставщика", KIND_SWAP: "Обмен привязками",
               KIND_REBALANCE: "Балансировка поставки"}

# Раздел прав у каждого вида свой (2026-08-14): администратор может доверить
# кому-то замену поставщика, не открывая обмен привязками, и наоборот.
KIND_FEATURES = {KIND_SUPPLIER: "doc_supplier_change", KIND_SWAP: "doc_link_swap",
                 KIND_REBALANCE: "doc_link_swap"}
DOC_FEATURES = tuple(dict.fromkeys(KIND_FEATURES.values()))


def _раздел(kind: str) -> str:
    """Раздел прав по виду документа. Неизвестный вид — ошибка запроса, а не
    повод пустить: молча выбрать один из двух значило бы дать право,
    которого не давали."""
    try:
        return KIND_FEATURES[kind]
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Неизвестный вид документа «{kind}»") from None

DRAFT, POSTED = "draft", "posted"
DOC_STATUS_TITLES = {DRAFT: "Черновик", POSTED: "Проведён"}

# Порог «уже на площадке»: этот статус и все следующие за ним замене
# поставщика не подлежат. Считается ОТ порядка жизненного цикла, а не
# перечислением четырёх кодов: появится статус между «Отгружен» и
# «Доставлен» — он попадёт в запрет сам, а список из четырёх строк промолчал
# бы. К обмену привязками НЕ применяется (решение пользователя).
BLOCKED_FROM = "shipped"
_ORDER = [s.value for s in STATUS_ORDER]
BLOCKED_STATUSES = set(_ORDER[_ORDER.index(BLOCKED_FROM):])
# Балансировка поставки (2026-10-06, запрос пользователя): в неё входят и отгруженные, и доставленные, но ещё не смонтированные изделия —
# их плановая дата поставки переходит между изделиями наравне с прочими. Не входят смонтированные и принятые.
REBALANCE_BLOCKED_FROM = "installed"
REBALANCE_BLOCKED_STATUSES = set(_ORDER[_ORDER.index(REBALANCE_BLOCKED_FROM):])


class SupplierChangeIn(BaseModel):
    object_id: int
    kind: str = KIND_SUPPLIER
    # Пустой номер — сервер выдаст следующий по этому объекту. Ручной ввод
    # оставлен: у заказчика бывает свой номер распорядительного документа.
    number: Optional[str] = None
    doc_date: str
    from_contract_id: int = 0   # у балансировки «по всем контрактам» сервер подставляет сам
    to_contract_id: int = 0
    mark: Optional[str] = None
    # Балансировка: охват «все контракты» / «все марки» и общий пул дат между контрактами (2026-10-06). Для «все контракты»
    # from/to_contract_id сервер выбирает сам (колонки обязательны), для «все марки» mark не задаётся.
    all_contracts: bool = False
    all_marks: bool = False
    pool: bool = False
    reason: Optional[str] = None
    comment: Optional[str] = None
    # Замена поставщика: что переносим. Обмен привязками: side_a/side_b,
    # пара — одинаковые позиции в списках.
    element_ids: list[int] = []
    side_a: list[int] = []
    side_b: list[int] = []
    # Версия документа, которую видел клиент (см. _doc_version): при расхождении правка отклоняется 409 и ничего не меняет.
    # Необязательна — клиент без проверки (V1) поведения не меняет. Для создания игнорируется.
    expected_version: Optional[str] = None


class DocActionIn(BaseModel):
    """Необязательное тело проведения / отмены проведения: версия документа, которую видел человек, нажимая кнопку. Без тела — как раньше."""
    expected_version: Optional[str] = None


def _contract_name(conn, contract_id: int) -> str:
    row = conn.execute(
        "SELECT specification_id, theme FROM contracts WHERE id = ?", (contract_id,)
    ).fetchone()
    if row is None:
        return f"#{contract_id}"
    chain = _specification_chain(conn, row["specification_id"])
    if chain is None:
        return f"#{contract_id}"
    return build_contract_name(
        chain["counterparty_short_name"], chain["agreement_number"], chain["agreement_date"],
        chain["specification_number"], chain["specification_date"], row["theme"],
    )


def _contract_counterparty(conn, contract_id: int) -> Optional[str]:
    """Краткое название контрагента контракта (для столбцов списка документов)."""
    row = conn.execute(
        "SELECT specification_id FROM contracts WHERE id = ?", (contract_id,)).fetchone()
    if row is None:
        return None
    chain = _specification_chain(conn, row["specification_id"])
    return chain["counterparty_short_name"] if chain is not None else None


def _object_contracts(conn, object_id: int) -> list:
    """Контракты ОБЪЕКТА — те, чей договор привязан к нему (та же цепочка
    контракт → спецификация → договор.object_id, по которой считается и
    доступ, см. app/contracts.py _guard_contract).

    Свой запрос, а не общий `GET /contracts`: тот отдаёт контракты всех
    доступных человеку строек, а документ живёт на ОДНОМ объекте, и
    поставщика здания А нельзя менять на контракт здания Б.
    """
    rows = conn.execute(
        """
        SELECT co.id AS id, co.theme AS theme, co.is_archived AS is_archived,
               c.id AS counterparty_id, c.short_name AS counterparty_short_name,
               a.id AS agreement_id, a.number AS agreement_number, a.agreement_date AS agreement_date,
               s.number AS specification_number, s.specification_date AS specification_date
        FROM contracts co
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        JOIN counterparties c ON c.id = a.counterparty_id
        WHERE a.object_id = ?
        ORDER BY c.short_name, a.number, s.number
        """,
        (object_id,),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "name": build_contract_name(
                r["counterparty_short_name"], r["agreement_number"], r["agreement_date"],
                r["specification_number"], r["specification_date"], r["theme"],
            ),
            "counterparty_id": r["counterparty_id"],
            "counterparty_short_name": r["counterparty_short_name"],
            "agreement_id": r["agreement_id"],
            "agreement_number": r["agreement_number"],
            "agreement_date": r["agreement_date"],
            "specification_number": r["specification_number"],
            "specification_date": r["specification_date"],
            "is_archived": bool(r["is_archived"]),
        }
        for r in rows
    ]


def _assert_contract_of_object(conn, contract_id: int, object_id: int, роль: str) -> None:
    row = conn.execute(
        """
        SELECT a.object_id AS object_id FROM contracts co
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        WHERE co.id = ?
        """,
        (contract_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Контракт {роль} не найден")
    if row["object_id"] != object_id:
        raise HTTPException(
            status_code=400,
            detail=f"Контракт {роль} относится к другому объекту — операция возможна только внутри одного объекта",
        )


def _available_in_contract(conn, contract_id: int) -> dict:
    """Сколько ещё можно повесить на контракт, по (тип, марка).

    `план − факт − повреждено`, где факт — изделия схемы, УЖЕ привязанные к
    этому контракту. Именно «строки, не связанные с элементами модели», о
    которых просил пользователь: у привязанного изделия статус по инварианту
    не «Запланирован», поэтому «привязано» и «факт» здесь одно и то же
    число, а формула остаётся той же, что у остатка в карточке контракта.

    Повреждения известны только по ТИПУ (марки у инцидента нет, см.
    app/contracts.py ContractIncidentIn) — одно и то же число вычитается из
    каждой позиции этого типа, ровно как в карточке контракта и в выборе
    контракта при смене статуса.
    """
    факт = {
        (r["element_type"], r["mark"]): r["n"]
        for r in conn.execute(
            "SELECT element_type, mark, COUNT(*) AS n FROM elements "
            "WHERE contract_id = ? GROUP BY element_type, mark",
            (contract_id,),
        ).fetchall()
    }
    повреждено = {
        r["element_type"]: r["n"]
        for r in conn.execute(
            "SELECT element_type, COALESCE(SUM(quantity), 0) AS n FROM contract_incidents "
            "WHERE contract_id = ? GROUP BY element_type",
            (contract_id,),
        ).fetchall()
    }
    доступно = {}
    for r in conn.execute(
        "SELECT element_type, mark, quantity FROM contract_lines WHERE contract_id = ?", (contract_id,)
    ).fetchall():
        ключ = (r["element_type"], r["mark"])
        остаток = r["quantity"] - факт.get(ключ, 0) - повреждено.get(r["element_type"], 0)
        # Позиция может встретиться дважды только при рассинхроне уникального
        # индекса; складываем, а не перезаписываем — иначе часть плана молча
        # исчезла бы из доступного.
        доступно[ключ] = доступно.get(ключ, 0) + max(остаток, 0)
    return доступно


@router.get("/refs")
def supplier_change_refs(object_id: int = Query(...),
                         user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write"))):
    """Справочные данные формы: контракты объекта. Отдельным запросом, а не
    из `state.contracts` на клиенте: тот список общий на все доступные
    стройки, а документ работает внутри одного объекта."""
    conn = get_connection()
    try:
        return {"contracts": _object_contracts(conn, object_id)}
    finally:
        conn.close()


@router.get("/candidates")
def supplier_change_candidates(
    object_id: int = Query(...),
    from_contract_id: int = Query(...),
    to_contract_id: int = Query(...),
    user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write")),
):
    """Что и в каком количестве можно перенести ЗАМЕНОЙ ПОСТАВЩИКА: позиции
    (тип, марка) с перечнем самих изделий.

    Изделия перечисляются поимённо, а не одним числом: человек решает, какие
    именно колонны отдать новому заводу, — по адресу, ярусу и плановой дате,
    и без списка этот выбор делать нечем. Заблокированные (уже отгруженные и
    дальше) отдаются отдельным счётчиком: молча не показать их значило бы
    ответить «в контракте меньше изделий, чем есть на самом деле».
    """
    conn = get_connection()
    try:
        if from_contract_id == to_contract_id:
            raise HTTPException(status_code=400, detail="Текущий и новый контракты совпадают")
        _assert_contract_of_object(conn, from_contract_id, object_id, "«текущий»")
        _assert_contract_of_object(conn, to_contract_id, object_id, "«новый»")
        доступно = _available_in_contract(conn, to_contract_id)
        rows = conn.execute(
            """
            SELECT id, element_type, subtype, mark, address, current_status,
                   planned_delivery_date, project_delivery_date, elevation_mm
            FROM elements
            WHERE contract_id = ? AND object_id = ? AND is_current = 1
            ORDER BY element_type, mark, address, id
            """,
            (from_contract_id, object_id),
        ).fetchall()
        позиции: dict = {}
        заблокировано: dict = {}
        for r in rows:
            ключ = (r["element_type"], r["mark"])
            if r["current_status"] in BLOCKED_STATUSES:
                заблокировано[ключ] = заблокировано.get(ключ, 0) + 1
                continue
            поз = позиции.setdefault(ключ, {
                "element_type": r["element_type"], "mark": r["mark"],
                "available_in_new": доступно.get(ключ, 0), "elements": [],
            })
            поз["elements"].append({
                "id": r["id"], "element_type": r["element_type"], "subtype": r["subtype"],
                "mark": r["mark"], "address": r["address"], "current_status": r["current_status"],
                "planned_delivery_date": r["planned_delivery_date"],
                "project_delivery_date": r["project_delivery_date"],
                "elevation_mm": r["elevation_mm"],
            })
        return {
            "positions": sorted(позиции.values(),
                                key=lambda p: (p["element_type"] or "", p["mark"] or "")),
            "blocked": sorted(
                ({"element_type": t, "mark": m, "count": n} for (t, m), n in заблокировано.items()),
                key=lambda b: (b["element_type"] or "", b["mark"] or ""),
            ),
            "blocked_from_label": STATUS_TITLES[BLOCKED_FROM],
        }
    finally:
        conn.close()


@router.get("/swap-elements")
def swap_elements(
    object_id: int = Query(...),
    contract_id: int = Query(...),
    mark: str = Query(...),
    user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write")),
):
    """Изделия одной марки, стоящие на этом контракте, — материал для подбора
    рамкой на схеме.

    Геометрия (контур и координаты) отдаётся ЗДЕСЬ, а не берётся из уже
    загруженной схемы на клиенте: подбор идёт по контракту и марке, а
    рабочая область может показывать другой отбор или вовсе 3D. Изделий
    одной марки на объекте сотни, не тысячи — запрос дешёвый.

    Сравнение марки регистронезависимое: марка позиции контракта приходит из
    файла контрактации, марка изделия — из чертежа (та же причина, что у
    markKey в дашборде АРМ).
    """
    conn = get_connection()
    try:
        assert_object_any_feature(conn, user, object_id, DOC_FEATURES, "write")
        _assert_contract_of_object(conn, contract_id, object_id, "стороны")
        rows = conn.execute(
            """
            SELECT id, element_type, subtype, mark, address, floor, elevation_mm,
                   current_status, planned_delivery_date, x, y, outline_json, layer
            FROM elements
            WHERE contract_id = ? AND object_id = ? AND is_current = 1
              AND LOWER(TRIM(COALESCE(mark, ''))) = LOWER(TRIM(?))
            ORDER BY floor, address, id
            """,
            (contract_id, object_id, mark),
        ).fetchall()
        import json as _json
        elements = []
        for r in rows:
            outline = None
            if r["outline_json"]:
                try:
                    outline = _json.loads(r["outline_json"])
                except ValueError:
                    outline = None
            elements.append({
                "id": r["id"], "element_type": r["element_type"], "subtype": r["subtype"],
                "mark": r["mark"], "address": r["address"], "floor": r["floor"],
                "elevation_mm": r["elevation_mm"], "current_status": r["current_status"],
                "planned_delivery_date": r["planned_delivery_date"],
                # layer нужен схеме подбора: форма маркера назначается по паре
                # (слой, тип элемента) — та же настройка, что и на большой
                # схеме (state.elementShapes), и без слоя её не применить.
                "x": r["x"], "y": r["y"], "outline": outline, "layer": r["layer"],
            })
        floors = sorted({e["floor"] for e in elements if e["floor"] is not None})
        # Контекст — остальные изделия ТОГО ЖЕ ТИПА на объекте, только точкой
        # (x, y, этаж). Без него подбор нечитаем: четыре колонны одной марки
        # стоят в линию, схема вытягивается по ним, и человек видит четыре
        # точки в пустоте вместо плана здания. Тип, а не всё подряд: колонн
        # на объекте 1,3 тыс., а изделий девять с половиной тысяч — рисовать
        # всё значило бы платить секундами за фон.
        типы = sorted({e["element_type"] for e in elements if e["element_type"]})
        context = []
        if типы:
            места = ",".join("?" * len(типы))
            свои = {e["id"] for e in elements}
            context = [
                {"x": r["x"], "y": r["y"], "floor": r["floor"]}
                for r in conn.execute(
                    f"SELECT id, x, y, floor FROM elements WHERE object_id = ? AND is_current = 1 "
                    f"AND element_type IN ({места})", [object_id, *типы],
                ).fetchall()
                if r["id"] not in свои
            ]
        return {"elements": elements, "floors": floors, "context": context,
                "has_no_floor": any(e["floor"] is None for e in elements)}
    finally:
        conn.close()


@router.get("/contract-marks")
def contract_marks(
    object_id: int = Query(...),
    contract_id: int = Query(...),
    user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write")),
):
    """Марки, изделия которых стоят на ЭТОМ контракте, с количествами.

    Марка обмена выбирается по составу контракта СТОРОНЫ 1 (требование
    пользователя 2026-08-11): человек идёт от того, что у него на руках —
    «вот этот контракт, вот эта марка», — а не от пересечения двух списков,
    для которого вторую сторону надо знать заранее.
    """
    conn = get_connection()
    try:
        assert_object_any_feature(conn, user, object_id, DOC_FEATURES, "write")
        _assert_contract_of_object(conn, contract_id, object_id, "стороны 1")
        rows = conn.execute(
            "SELECT mark, element_type, COUNT(*) AS n FROM elements "
            "WHERE contract_id = ? AND object_id = ? AND is_current = 1 AND mark IS NOT NULL "
            "GROUP BY mark, element_type ORDER BY mark",
            (contract_id, object_id),
        ).fetchall()
        return {"marks": [{"mark": r["mark"], "element_type": r["element_type"], "count": r["n"]}
                          for r in rows]}
    finally:
        conn.close()


@router.get("/mark-contracts")
def mark_contracts(
    object_id: int = Query(...),
    mark: str = Query(...),
    exclude_contract_id: Optional[int] = Query(None),
    user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write")),
):
    """Контракты объекта, на которых стоят изделия ЭТОЙ марки, с количествами.

    Из них собирается выбор стороны 2 (требование пользователя): предлагать
    контрагента, у которого этой марки нет, значило бы вести человека в
    тупик — обменивать было бы нечего. Количество отдаётся вместе с
    контрактом и показывается прямо в списке: «сколько там таких изделий» —
    первое, что нужно знать, выбирая встречную сторону.

    Сравнение марки регистронезависимое — та же причина, что в swap_elements.
    """
    conn = get_connection()
    try:
        assert_object_any_feature(conn, user, object_id, DOC_FEATURES, "write")
        rows = conn.execute(
            """
            SELECT e.contract_id AS contract_id, e.element_type AS element_type, COUNT(*) AS n
            FROM elements e
            JOIN contracts co ON co.id = e.contract_id
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            WHERE e.object_id = ? AND e.is_current = 1 AND e.contract_id IS NOT NULL
              AND a.object_id = ? AND co.is_archived = 0
              AND LOWER(TRIM(COALESCE(e.mark, ''))) = LOWER(TRIM(?))
            GROUP BY e.contract_id, e.element_type
            """,
            (object_id, object_id, mark),
        ).fetchall()
        свод: dict = {}
        for r in rows:
            if exclude_contract_id is not None and r["contract_id"] == exclude_contract_id:
                continue
            запись = свод.setdefault(r["contract_id"], {"contract_id": r["contract_id"],
                                                        "element_type": r["element_type"], "count": 0})
            запись["count"] += r["n"]
        return {"contracts": sorted(свод.values(), key=lambda c: -c["count"])}
    finally:
        conn.close()


# ------------------------------------------------- балансировка поставки (A4)

def _rebalance_allocate(rows: list, need: dict) -> list:
    """Раскладка внутри группы одинаковых изделий: какое изделие какое МЕСТО займёт (изделия меняются местами).

    Из нескольких вариантов берётся лучший по (числу просроченных, максимальной просрочке, сумме дней опоздания, числу
    затронутых изделий) — но только из тех, что НЕ ХУЖЕ прежнего итога (до перехода на обмен местами) сразу по первым трём
    показателям. Варианты (плановые даты поставщика только переходят между изделиями группы):

    * **P — пары по выигрышу.** Непересекающиеся пары: просроченное изделие меняется с изделием, у которого дата раньше, если в сумме
      по паре просрочка уменьшается (партнёр может стать чуть позже, если выигрыш больше потери). Пары выбираются по убыванию выигрыша.
    * **C — строгие пары.** Просроченное меняется только с тем, кто после обмена тоже в срок (самый «тугой» партнёр).
    * **A — минимум обменов, как раньше.** Последовательные обмены, одно изделие может участвовать в нескольких (получаются цепочки).
    * **A2** — то же, но уже вставшее в срок изделие повторно не меняется.
    * **B — полная очередь.** Изделия по возрастанию требуемой даты получают плановые даты по возрастанию. Оптимум по максимальной
      просрочке и сумме дней, но сдвигает почти весь набор. Участвует только если прежний итог был ею (она была строго лучше «минимума
      обменов» по (просроченным, максимуму)) или она строго лучше любого локального варианта (2026-10-06: результат не хуже прежнего).

    Вариант задаёт, какие плановые даты где окажутся; по нему строится перестановка «место ← изделие» (`receives`): изделие, чья дата
    досталась месту, переезжает на это место со СВОИМИ статусом, историей и контрактом (механика «Обмена привязками»). Перестановка
    разбивается на циклы: цикл из двух — пара, из трёх и более — цепочка (каждое получает от следующего по кругу). Изделия без
    требуемой даты срочностью не обладают и могут быть только источником ранней даты. Результат детерминирован; повторный расчёт по
    уже сбалансированному набору ничего не меняет.
    """
    from datetime import date

    def ordinal(v):
        return date.fromisoformat(str(v)[:10]).toordinal() if v else None

    ids = sorted(r["id"] for r in rows)
    by = {r["id"]: r for r in rows}
    old = {i: ordinal(by[i]["planned_delivery_date"]) for i in ids}
    nd = {i: ordinal(need.get(i)) for i in ids}                        # требуемая дата (None — нет)

    def late(plan_day, i):
        return max(0, plan_day - nd[i]) if nd[i] is not None else 0

    def key(plan):
        lates = [late(plan[i], i) for i in ids]
        return (sum(1 for x in lates if x > 0), max(lates, default=0), sum(lates), sum(1 for i in ids if plan[i] != old[i]))

    def plan_min_swaps(skip_on_time):
        plan = dict(old)
        queue = sorted((i for i in ids if late(plan[i], i) > 0), key=lambda i: (-late(plan[i], i), i))
        for i in queue:
            if skip_on_time and late(plan[i], i) == 0:
                continue
            ni, best = nd[i], None
            for j in ids:
                pj = plan[j]
                if j == i or pj >= plan[i] or pj > ni:
                    continue        # партнёр: дата раньше, и просроченному она подходит
                nj = nd[j]
                if nj is not None and plan[i] > nj:
                    continue        # после обмена партнёр сам бы опоздал
                k = (10 ** 6 if nj is None else nj - plan[i], j)      # самый «тугой» подходящий — запас остальных не тратим
                if best is None or k < best[0]:
                    best = (k, j)
            if best:
                j = best[1]
                plan[i], plan[j] = plan[j], plan[i]
        return plan

    def plan_strict_pairs():
        plan, taken = dict(old), set()
        for i in sorted((i for i in ids if late(old[i], i) > 0), key=lambda i: (-late(old[i], i), i)):
            if i in taken:
                continue
            best = None
            for j in ids:
                if j == i or j in taken or old[j] >= old[i] or old[j] > nd[i]:
                    continue
                if nd[j] is not None and old[i] > nd[j]:
                    continue
                k = (10 ** 6 if nd[j] is None else nd[j] - old[i], j)
                if best is None or k < best[0]:
                    best = (k, j)
            if best:
                j = best[1]
                taken.update((i, j))
                plan[i], plan[j] = old[j], old[i]
        return plan

    def plan_gain_pairs():
        cand = []
        for i in ids:
            li = late(old[i], i)
            if li == 0:
                continue
            for j in ids:
                if j == i or old[j] >= old[i]:
                    continue
                lj, li2, lj2 = late(old[j], j), late(old[j], i), late(old[i], j)
                gc = (li > 0) + (lj > 0) - (li2 > 0) - (lj2 > 0)
                gd = li + lj - li2 - lj2
                if gc > 0 or (gc == 0 and gd > 0):
                    cand.append((-gc, -gd, i, j))
        cand.sort()
        plan, taken = dict(old), set()
        for _, _, i, j in cand:
            if i in taken or j in taken:
                continue
            taken.update((i, j))
            plan[i], plan[j] = old[j], old[i]
        return plan

    def plan_full_queue():
        queue = sorted(ids, key=lambda i: (nd[i] is None, nd[i] or 0, old[i], i))
        return dict(zip(queue, sorted(old.values())))

    def derive(plan):
        """Перестановка «место ← изделие» по плану дат: у места новая дата = старая дата изделия-источника; при одинаковых датах
        изделие, чья дата и так на месте, остаётся (лишних обменов нет), остальные сопоставляются по номеру."""
        sources: dict = {}
        targets: dict = {}
        for i in ids:
            sources.setdefault(old[i], []).append(i)
            targets.setdefault(plan[i], []).append(i)
        got: dict = {}
        for day, t_list in targets.items():
            s_list = sources.get(day, [])
            fixed = set(s_list) & set(t_list)
            for t, src in zip([x for x in t_list if x not in fixed], [x for x in s_list if x not in fixed]):
                got[t] = src
        return got

    def plan_of(got):
        return {i: old[got.get(i, i)] for i in ids}

    def prune(got):
        """Убрать бесполезные участия: изделие x выбрасывается из цикла (оно остаётся на своём месте, а получавшее от него место берёт
        у его источника), если от этого не растёт ни число просроченных, ни сумма дней, ни максимум. Так из «полной очереди» уходят
        изделия, которые и так в срок и просто сдвигались по очереди: статусы и история у них зря не переезжают."""
        got = dict(got)
        given = {src: t for t, src in got.items()}
        plan = plan_of(got)
        cnt = sum(1 for i in ids if late(plan[i], i) > 0)
        tot = sum(late(plan[i], i) for i in ids)
        mx = max((late(plan[i], i) for i in ids), default=0)
        changed = True
        while changed:
            changed = False
            for x in sorted(got):
                if x not in got:
                    continue
                t, src = given[x], got[x]                     # место t держит дату x, место x держит дату src
                lt, lx = late(old[x], t), late(old[src], x)
                lt2, lx2 = late(old[src], t), late(old[x], x)  # после выбрасывания: t берёт дату src, x остаётся при своей
                n_cnt = cnt - (lt > 0) - (lx > 0) + (lt2 > 0) + (lx2 > 0)
                n_tot = tot - lt - lx + lt2 + lx2
                if n_cnt <= cnt and n_tot <= tot and lt2 <= mx and lx2 <= mx:
                    cnt, tot = n_cnt, n_tot
                    del got[x], given[x]
                    if src == t:
                        del got[t], given[t]
                    else:
                        got[t] = src
                        given[src] = t
                    changed = True
        return got

    def keyed(got):
        return key(plan_of(got))

    raw_variants = (plan_gain_pairs(), plan_strict_pairs(), plan_min_swaps(True), plan_min_swaps(False))
    raw_full = plan_full_queue()
    # Прежний итог (до перехода на обмен местами): «минимум обменов», а «полная очередь» — только если строго лучше по (просроченным, максимуму).
    old_is_full = key(raw_full)[:2] < key(raw_variants[3])[:2]
    reference = key(raw_full if old_is_full else raw_variants[3])
    variants = [prune(derive(pl)) for pl in raw_variants]
    full = prune(derive(raw_full))
    best_local = min(variants, key=keyed)
    candidates = list(variants)
    if old_is_full or keyed(full)[:2] < keyed(best_local)[:2]:
        candidates.append(full)        # полная очередь — только если прежний итог был ею или она строго лучше любого локального
    # Результат не хуже прежнего ОДНОВРЕМЕННО по числу просроченных, максимальной просрочке и сумме дней опоздания; среди таких —
    # лучший, а при равенстве — с меньшим числом затронутых изделий
    feasible = [g for g in candidates if all(x <= y for x, y in zip(keyed(g)[:3], reference[:3]))]
    receives = min(feasible, key=keyed)

    seen: set = set()
    cycles: list = []
    for t in sorted(receives):
        if t in seen:
            continue
        cyc, x = [], t
        while x not in seen:
            seen.add(x)
            cyc.append(x)
            x = receives[x]
        lead = max(cyc, key=lambda i: (late(old[i], i), -i))             # ведущий — самое просроченное изделие цикла
        k = cyc.index(lead)
        cycles.append(cyc[k:] + cyc[:k])        # место i-го получает от (i+1)-го, последнее — от первого
    pos = {x: (n + 1, len(c)) for c in cycles for n, x in enumerate(c)}

    def iso(day):
        return date.fromordinal(day).isoformat()

    out = []
    for i in sorted(ids, key=lambda i: (nd[i] is None, nd[i] or 0, old[i], i)):
        r, src = by[i], receives.get(i)
        new_day = old[src] if src else old[i]
        delay_old = (old[i] - nd[i]) if nd[i] is not None else None
        delay_new = (new_day - nd[i]) if nd[i] is not None else None
        out.append({"element_id": i, "address": r["address"], "floor": r["floor"],
                    "status": r["current_status"], "status_new": by[src]["current_status"] if src else r["current_status"],
                    "need_date": need.get(i), "plan_old": iso(old[i]), "plan_new": iso(new_day),
                    "delay_old": delay_old, "delay_new": delay_new,
                    # partner_id — изделие, от которого место получает дату, статус, историю и контракт (в паре — взаимный партнёр)
                    "partner_id": src, "chain_pos": pos[i][0] if i in pos else None, "chain_size": pos[i][1] if i in pos else None,
                    "lead": bool(src) and pos[i][0] == 1})
    return out


def _rebalance_eligible(e, contract_id: Optional[int], mark: str) -> Optional[str]:
    """Почему изделие нельзя балансировать (None — можно). contract_id None — любой контракт, mark пустая — любая марка."""
    if e is None or not e["is_current"]:
        return "изделия нет в актуальном чертеже объекта"
    if contract_id is not None and e["contract_id"] != contract_id:
        return "изделие стоит не на контракте документа"
    if mark and (e["mark"] or "").strip().lower() != mark.strip().lower():
        return f"марка изделия не совпадает с маркой документа «{mark}»"
    if e["current_status"] in REBALANCE_BLOCKED_STATUSES:
        return "изделие уже смонтировано — его дата поставки не переставляется"
    if not e["planned_delivery_date"]:
        return "у изделия нет плановой даты поставки"
    return None


_REBALANCE_COLS = ("id, element_type, subtype, mark, address, floor, current_status, contract_id, object_id, is_current, "
                   "planned_delivery_date")


def _history_consistent_ids(conn, ids) -> set:
    """Изделия, у которых есть история статусов и кэш (текущий статус, фактическая дата поставки) с ней согласован.

    В обмене местами история переезжает к другому изделию, а кэш потом ПЕРЕСЧИТЫВАЕТСЯ из истории (`recompute_status_and_actual_date`).
    Без истории пересчёт невозможен (запись не из чего вывести), а при расхождении кэша с историей отмена проведения вернула бы
    выведенное значение, а не прежнее. Такие изделия в обмен не берутся — иначе «вернуть всё как было» нельзя гарантировать."""
    ids = list(ids)
    ok: set = set()
    for i in range(0, len(ids), 800):
        chunk = ids[i:i + 800]
        for r in conn.execute(
            "SELECT e.id AS id, e.current_status AS st, e.actual_delivery_date AS ad, "
            "(SELECT h.status FROM status_history h WHERE h.element_id = e.id ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) AS latest, "
            "(SELECT h.changed_at FROM status_history h WHERE h.element_id = e.id AND h.status = 'delivered' "
            " ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) AS delivered "
            f"FROM elements e WHERE e.id IN ({','.join('?' * len(chunk))})", chunk):
            if r["latest"] is None:
                continue
            derived = None if r["latest"] == "planned" else r["delivered"]
            if r["st"] == r["latest"] and (r["ad"] or None) == (derived or None):
                ok.add(r["id"])
    return ok


def _rebalance_groups(rows: list, pool: bool) -> dict:
    """Изделия по группам, внутри которых переставляются даты: (контракт, марка); при общем пуле — только марка."""
    группы: dict = {}
    for r in rows:
        ключ = (None if pool else r["contract_id"], (r["mark"] or "").strip().lower())
        группы.setdefault(ключ, []).append(r)
    return группы


def _contract_labels(conn, ids) -> dict:
    """{contract_id: (контрагент, название контракта)} — для группировки таблицы балансировки."""
    return {i: (_contract_counterparty(conn, i) or "—", _contract_name(conn, i)) for i in set(ids)}


def _rebalance_plan(conn, object_id: int, contract_id: Optional[int], mark: str, element_ids=None, pool: bool = False) -> dict:
    """Предпросмотр: подходящие изделия и их новые даты + сводка «было → стало».

    contract_id None — по всем контрактам объекта, mark пустая — по всем маркам. Расчёт ведётся по группам (контракт, марка),
    при `pool` — по маркам через контракты (даты переходят между контрактами). Строки отдаются сгруппированными: поставщик →
    контракт → марка. При охвате «все» группы, где ничего не меняется, не показываются — как и в списках выбора."""
    from app.schedule_versions import forecast_dates

    sql = f"SELECT {_REBALANCE_COLS} FROM elements WHERE object_id = ? AND is_current = 1 AND contract_id IS NOT NULL"
    args: list = [object_id]
    if contract_id is not None:
        sql += " AND contract_id = ?"
        args.append(contract_id)
    if mark:
        sql += " AND LOWER(TRIM(COALESCE(mark, ''))) = LOWER(TRIM(?))"
        args.append(mark)
    rows = [r for r in conn.execute(sql, args).fetchall() if _rebalance_eligible(r, contract_id, mark) is None]
    надёжные = _history_consistent_ids(conn, [r["id"] for r in rows])
    rows = [r for r in rows if r["id"] in надёжные]      # без истории / с расхождением кэша — в обмен не берутся
    if element_ids is not None:
        wanted = set(element_ids)
        rows = [r for r in rows if r["id"] in wanted]
    прогноз = forecast_dates(conn, object_id)
    need = {r["id"]: (прогноз[r["id"]][0] if r["id"] in прогноз and not прогноз[r["id"]][2] else None) for r in rows}
    широкий = contract_id is None or not mark
    метки = _contract_labels(conn, (r["contract_id"] for r in rows))
    items: list = []
    for (_, марка_ключ), изделия in _rebalance_groups(rows, pool and contract_id is None).items():
        раскладка = _rebalance_allocate(изделия, need)
        if широкий and (len(изделия) < 2 or not any(i["plan_old"] != i["plan_new"] for i in раскладка)):
            continue
        by_id = {r["id"]: r for r in изделия}
        по_id = {i["element_id"]: i for i in раскладка}
        for i in раскладка:
            e = by_id[i["element_id"]]
            контрагент, имя = метки[e["contract_id"]]
            i.update({"contract_id": e["contract_id"], "contract_name": имя, "counterparty": контрагент,
                      "mark": (e["mark"] or "").strip()})
            if i["partner_id"]:
                q = by_id[i["partner_id"]]
                i.update({"partner_address": q["address"], "partner_floor": q["floor"], "partner_status": q["current_status"],
                          "partner_contract_name": метки[q["contract_id"]][1], "partner_need_date": по_id[i["partner_id"]]["need_date"],
                          "partner_plan_old": по_id[i["partner_id"]]["plan_old"]})
            items.append(i)
    items.sort(key=lambda i: (str(i["counterparty"]).lower(), i["contract_name"], i["mark"].lower(),
                              i["need_date"] is None, i["need_date"] or "", i["element_id"]))
    по_id_все = {i["element_id"]: i for i in items}
    номер = 0                       # сквозной номер обмена (пары или цепочки): все изделия цикла носят один
    номера: dict = {}
    for i in items:
        if i["lead"]:
            номер += 1
            x = i
            for _ in range(i["chain_size"]):
                номера[x["element_id"]] = номер
                x = по_id_все[x["partner_id"]]
    for i in items:
        i["pair_no"] = номера.get(i["element_id"])

    def late(key):
        return [i[key] for i in items if i[key] is not None and i[key] > 0]
    return {"items": items, "summary": {
        "count": len(items), "changed": sum(1 for i in items if i["plan_old"] != i["plan_new"]),
        "pairs": sum(1 for i in items if i["lead"] and i["chain_size"] == 2),
        "chains": sum(1 for i in items if i["lead"] and i["chain_size"] > 2),
        "moved": sum(1 for i in items if i["pair_no"]),
        "late_before": len(late("delay_old")), "late_after": len(late("delay_new")),
        "max_delay_before": max(late("delay_old"), default=0), "max_delay_after": max(late("delay_new"), default=0),
        # Суммарное опоздание, дней (сумма положительных отклонений по изделиям) до и после — «насколько сокращено опоздание»
        "late_days_before": sum(late("delay_old")), "late_days_after": sum(late("delay_new")),
        "without_need": sum(1 for i in items if i["need_date"] is None)}}


def _rebalance_candidates(conn, object_id: int) -> dict:
    """Контракты объекта, по которым ЕСТЬ ЧТО балансировать, и марки в них, а также то же при общем пуле дат:
    {contracts: [{contract_id, counterparty, changed, late, marks:[{mark, count, changed, late}]}], pool: {changed, late, marks:[...]}}.
    «Есть что балансировать» — расчёт (`_rebalance_allocate`) меняет плановую дату хотя бы у одного изделия группы. Контракты и
    марки без изменений в списки не попадают: предлагать их в форме значило бы вести человека к документу, который ничего не
    сделает. Один проход по изделиям объекта, а не расчёт на каждую пару."""
    from app.schedule_versions import forecast_dates

    rows = conn.execute(
        f"SELECT {_REBALANCE_COLS} FROM elements WHERE object_id = ? AND is_current = 1 AND contract_id IS NOT NULL "
        "AND planned_delivery_date IS NOT NULL", (object_id,)).fetchall()
    rows = [r for r in rows if _rebalance_eligible(r, r["contract_id"], "") is None]
    прогноз = forecast_dates(conn, object_id)
    имена = {c["id"]: c for c in _object_contracts(conn, object_id)}
    живые = {i for i, c in имена.items() if not c["is_archived"]}
    rows = [r for r in rows if r["contract_id"] in живые]
    надёжные = _history_consistent_ids(conn, [r["id"] for r in rows])
    rows = [r for r in rows if r["id"] in надёжные]

    def считать(pool: bool):
        по_контрактам: dict = {}
        итого = {"changed": 0, "late": 0, "marks": {}}
        for (contract_id, _), изделия in _rebalance_groups(rows, pool).items():
            if len(изделия) < 2:
                continue
            need = {r["id"]: (прогноз[r["id"]][0] if r["id"] in прогноз and not прогноз[r["id"]][2] else None) for r in изделия}
            раскладка = _rebalance_allocate(изделия, need)
            изменится = sum(1 for i in раскладка if i["plan_old"] != i["plan_new"])
            if not изменится:
                continue
            просрочено = sum(1 for i in раскладка if i["delay_old"] is not None and i["delay_old"] > 0)
            марка = (изделия[0]["mark"] or "").strip()
            строка = {"mark": марка, "count": len(изделия), "changed": изменится, "late": просрочено}
            итого["changed"] += изменится
            итого["late"] += просрочено
            итого["marks"][марка.lower()] = строка
            if not pool:
                запись = по_контрактам.setdefault(contract_id, {"contract_id": contract_id, "changed": 0, "late": 0, "marks": []})
                запись["changed"] += изменится
                запись["late"] += просрочено
                запись["marks"].append(строка)
        return по_контрактам, итого

    по_контрактам, _ = считать(False)
    _, общий = считать(True)
    out = []
    for contract_id, запись in по_контрактам.items():
        c = имена[contract_id]
        запись["marks"].sort(key=lambda m: m["mark"])
        out.append({**запись, "name": c["name"], "counterparty": c["counterparty_short_name"]})
    out.sort(key=lambda x: (str(x["counterparty"]).lower(), x["name"]))
    return {"contracts": out, "pool": {"changed": общий["changed"], "late": общий["late"],
                                       "marks": sorted(общий["marks"].values(), key=lambda m: m["mark"])}}


@router.get("/rebalance-candidates")
def rebalance_candidates(object_id: int = Query(...),
                         user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write"))):
    """Контракты и марки, по которым балансировка что-то изменит, с числом изделий (для выбора в форме документа)."""
    conn = get_connection()
    try:
        assert_object_any_feature(conn, user, object_id, DOC_FEATURES, "write")
        return _rebalance_candidates(conn, object_id)
    finally:
        conn.close()


@router.get("/rebalance-preview")
def rebalance_preview(object_id: int = Query(...), contract_id: Optional[int] = Query(None), mark: str = Query(""),
                      pool: bool = Query(False), doc_id: Optional[int] = Query(None),
                      user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "write"))):
    """Что даст балансировка поставки — без записи (форма документа и проверка перед проведением).

    Без `contract_id` — по всем контрактам объекта, без `mark` — по всем маркам, `pool` — общий пул дат между контрактами.
    Без `doc_id` — по всем подходящим изделиям. С `doc_id` — только по составу сохранённого документа
    (список id в адресной строке не гоняем: изделий бывают тысячи)."""
    conn = get_connection()
    try:
        assert_object_any_feature(conn, user, object_id, DOC_FEATURES, "write")
        if contract_id is not None:
            _assert_contract_of_object(conn, contract_id, object_id, "контракта")
        element_ids = None
        if doc_id is not None:
            doc = conn.execute("SELECT object_id, kind FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
            if doc is None or doc["object_id"] != object_id or doc["kind"] != KIND_REBALANCE:
                raise HTTPException(status_code=404, detail="Документ не найден")
            element_ids = [r["element_id"] for r in conn.execute(
                "SELECT element_id FROM supplier_change_items WHERE doc_id = ?", (doc_id,))]
        return _rebalance_plan(conn, object_id, contract_id, mark.strip(), element_ids, pool)
    finally:
        conn.close()


def _post_rebalance(conn, doc, items, автор, user_id) -> dict:
    """Проведение балансировки: снимок «что было» → пересчёт раскладки по ТЕКУЩИМ данным → обмен изделий местами (парами и цепочками).

    Раскладка считается заново при проведении, а не берётся из черновика: между сохранением и проведением могли
    измениться требуемые даты (новая актуализация) и состав. Пересчёт по тем же изделиям документа даёт ровно то, что
    человек увидел бы в предпросмотре сейчас. Группы: (контракт, марка), при общем пуле — марка через контракты."""
    from app.schedule_versions import forecast_dates

    contract_id = None if doc["all_contracts"] else doc["from_contract_id"]
    марка = "" if doc["all_marks"] else (doc["mark"] or "").strip()
    elements, проблемы = [], []
    надёжные = _history_consistent_ids(conn, [it["element_id"] for it in items])
    for it in items:
        e = conn.execute(
            "SELECT id, element_type, subtype, mark, address, floor, current_status, contract_id, object_id, "
            "is_current, planned_delivery_date FROM elements WHERE id = ?", (it["element_id"],)).fetchone()
        причина = _rebalance_eligible(e, contract_id, марка) if e is not None and e["object_id"] == doc["object_id"] \
            else "изделия нет в актуальном чертеже объекта"
        if not причина and e["contract_id"] is None:
            причина = "у изделия нет контракта"
        if not причина and e["id"] not in надёжные:
            причина = "нет истории статусов или кэш статуса расходится с ней — обмен местами невозможен"
        if причина:
            проблемы.append(f"№{it['element_id']}" + (f" {e['mark']} · {e['address'] or ''}".rstrip(" ·") if e else "")
                            + f": {причина}")
        else:
            elements.append(e)
    if проблемы:
        raise HTTPException(status_code=409, detail="Провести нельзя:\n" + "\n".join(проблемы[:20]))
    прогноз = forecast_dates(conn, doc["object_id"])
    need = {e["id"]: (прогноз[e["id"]][0] if e["id"] in прогноз and not прогноз[e["id"]][2] else None) for e in elements}
    раскладка: dict = {}
    for изделия in _rebalance_groups(elements, bool(doc["pool"]) and bool(doc["all_contracts"])).values():
        раскладка.update({i["element_id"]: i for i in _rebalance_allocate(изделия, need)})
    by_item = {it["element_id"]: it for it in items}
    by_e = {e["id"]: e for e in elements}
    комментарий = _doc_comment(doc, "Балансировка поставки")
    # Снимок «что было» — ДО любых изменений, у ВСЕХ изделий документа: единственное основание для отмены проведения.
    for e in elements:
        conn.execute(
            "UPDATE supplier_change_items SET status_at_move = ?, prev_contract_id = ?, prev_planned_delivery_date = ?, "
            "element_type = ?, mark = ?, side = 1, pair_no = NULL WHERE id = ?",
            (e["current_status"], e["contract_id"], e["planned_delivery_date"], e["element_type"], e["mark"],
             by_item[e["id"]]["id"]))
    пар = цепочек = затронуто = номер = 0
    for r in sorted(раскладка.values(), key=lambda r: r["element_id"]):
        if not r["lead"]:
            continue
        номер += 1
        цикл, x = [], r
        for _ in range(r["chain_size"]):             # место i-го получает от (i+1)-го; последнее — от первого
            цикл.append(by_e[x["element_id"]])
            x = раскладка[x["partner_id"]]
        for позиция, e in enumerate(цикл, start=1):
            conn.execute("UPDATE supplier_change_items SET side = ?, pair_no = ? WHERE id = ?",
                         (позиция, номер, by_item[e["id"]]["id"]))
        _apply_cycle(conn, doc, цикл, автор, user_id, комментарий)
        if len(цикл) == 2:
            пар += 1
        else:
            цепочек += 1
        затронуто += len(цикл)
    return {"elements": len(elements), "pairs": пар, "chains": цепочек, "moved": затронуто}


def _apply_cycle(conn, doc, цикл, автор, user_id, комментарий) -> None:
    """Изделия цикла меняются МЕСТАМИ: место i-го изделия получает плановую дату, контракт и ВСЮ историю статусов (i+1)-го
    (последнее — первого). Цикл из двух — обычный обмен, как в «Обмене привязками» (`_post_link_swap`). Текущий статус и фактическая
    дата не переставляются отдельно — они производные от истории и пересчитываются (`recompute_status_and_actual_date`). Записи
    истории выбираются по СНИМКУ id, сделанному до первого UPDATE, поэтому переезд одной записи не задевает другую. Каждый
    переезд пишется в `supplier_change_history_moves` — им отменяется проведение."""
    k = len(цикл)
    история = {e["id"]: [r["id"] for r in conn.execute("SELECT id FROM status_history WHERE element_id = ?", (e["id"],)).fetchall()]
               for e in цикл}
    for n, место in enumerate(цикл):
        источник = цикл[(n + 1) % k]
        for history_id in история[источник["id"]]:
            conn.execute("UPDATE status_history SET element_id = ? WHERE id = ?", (место["id"], history_id))
            conn.execute("INSERT INTO supplier_change_history_moves (doc_id, history_id, prev_element_id) VALUES (?, ?, ?)",
                         (doc["id"], history_id, источник["id"]))
        conn.execute("UPDATE elements SET contract_id = ?, planned_delivery_date = ?, updated_at = datetime('now') WHERE id = ?",
                     (источник["contract_id"], источник["planned_delivery_date"], место["id"]))
    for n, место in enumerate(цикл):
        источник = цикл[(n + 1) % k]
        статус, _ = recompute_status_and_actual_date(conn, место["id"])
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (место["id"], статус, автор, user_id,
             f"{комментарий}: изделие {'поменялось местами с' if k == 2 else 'получило место (дату, статус, контракт) от'}"
             f" №{источник['id']} ({источник['address'] or 'без адреса'})",
             источник["contract_id"]))
        _remember_created_history(conn, doc["id"])
        activity.log("rebalance_swap", user_id=user_id, user_name=impersonation.plain_name(автор),
                     entity_type="element", entity_id=место["id"],
                     element_type=место["element_type"], subtype=место["subtype"], mark=место["mark"],
                     old_value=место["planned_delivery_date"], new_value=источник["planned_delivery_date"],
                     details={"doc_id": doc["id"], "number": doc["number"], "pair_with": источник["id"], "status": статус,
                              "chain_size": k})


def _rebalance_unpost_conflicts(conn, doc_id: int, items) -> list:
    """Что изменилось у изделий обмена ПОСЛЕ проведения: плановая дата и контракт должны быть теми, что записало проведение (даты и
    контракт источника по циклу), а последней записью истории — созданная самим документом. Иначе отмена перезатёрла бы чью-то
    правку или вернула бы изделию не тот статус. Документы без пар (проведённые до перехода на обмен местами) не проверяются."""
    created = {r["history_id"] for r in conn.execute(
        "SELECT history_id FROM supplier_change_history_moves WHERE doc_id = ? AND prev_element_id IS NULL", (doc_id,))}
    cycles: dict = {}
    for it in items:
        if it["pair_no"]:
            cycles.setdefault(it["pair_no"], []).append(it)
    problems: list = []
    for members in cycles.values():
        members.sort(key=lambda i: i["side"])
        k = len(members)
        for t, it in enumerate(members):
            src = members[(t + 1) % k]
            e = conn.execute("SELECT contract_id, planned_delivery_date, address, mark FROM elements WHERE id = ?",
                             (it["element_id"],)).fetchone()
            if e is None:
                problems.append(f"№{it['element_id']}: изделия больше нет")
                continue
            label = f"№{it['element_id']} {e['mark'] or ''} · {e['address'] or ''}".rstrip(" ·")
            if str(e["planned_delivery_date"] or "") != str(src["prev_planned_delivery_date"] or ""):
                problems.append(f"{label}: плановая дата изменена после проведения")
            if e["contract_id"] != src["prev_contract_id"]:
                problems.append(f"{label}: контракт изменён после проведения")
            last = conn.execute("SELECT id FROM status_history WHERE element_id = ? ORDER BY changed_at DESC, id DESC LIMIT 1",
                                (it["element_id"],)).fetchone()
            if last is None or last["id"] not in created:
                problems.append(f"{label}: после проведения менялась история статусов (новый статус)")
    return problems


def _next_number(conn, object_id: int) -> str:
    """Следующий номер документа в пределах объекта. Считается по МАКСИМУМУ
    из уже выданных чисто числовых номеров, а не по количеству записей:
    удалённый или заведённый вручную номер иначе выдавался бы повторно и
    упирался в UNIQUE."""
    максимум = 0
    for r in conn.execute(
        "SELECT number FROM supplier_change_docs WHERE object_id = ?", (object_id,)
    ).fetchall():
        текст = (r["number"] or "").strip()
        if текст.isdigit():
            максимум = max(максимум, int(текст))
    return str(максимум + 1)


# ---------------------------------------------------------------- чтение

def _doc_head(conn, r) -> dict:
    return {
        "id": r["id"], "object_id": r["object_id"],
        "kind": r["kind"], "kind_title": KIND_TITLES.get(r["kind"], r["kind"]),
        "status": r["status"], "status_title": DOC_STATUS_TITLES.get(r["status"], r["status"]),
        "number": r["number"], "doc_date": r["doc_date"], "mark": r["mark"],
        "reason": r["reason"], "comment": r["comment"],
        "all_contracts": bool(r["all_contracts"]), "all_marks": bool(r["all_marks"]), "pool": bool(r["pool"]),
        "created_at": r["created_at"], "created_by": r["created_by"],
        "posted_at": r["posted_at"], "posted_by": r["posted_by"],
        "from_contract_id": r["from_contract_id"], "to_contract_id": r["to_contract_id"],
        "from_contract_name": _contract_name(conn, r["from_contract_id"]),
        "to_contract_name": _contract_name(conn, r["to_contract_id"]),
        # Контрагенты сторон — отдельными полями для столбцов списка (2026-10-06: «в замену поставщика добавь столбцы с контрагентами»).
        "from_counterparty": _contract_counterparty(conn, r["from_contract_id"]),
        "to_counterparty": _contract_counterparty(conn, r["to_contract_id"]),
    }


def _doc_items(conn, doc_id: int) -> list:
    rows = conn.execute(
        """
        SELECT i.*, e.address AS address, e.current_status AS current_status,
               e.contract_id AS contract_id_now, e.mark AS mark_now, e.floor AS floor,
               e.planned_delivery_date AS plan_now
        FROM supplier_change_items i
        LEFT JOIN elements e ON e.id = i.element_id
        WHERE i.doc_id = ? ORDER BY i.pair_no, i.side, i.id
        """,
        (doc_id,),
    ).fetchall()
    метки = _contract_labels(conn, [r["contract_id_now"] for r in rows if r["contract_id_now"]]
                             + [r["prev_contract_id"] for r in rows if r["prev_contract_id"]])
    return [
        {
            "element_id": r["element_id"], "side": r["side"], "pair_no": r["pair_no"],
            "element_type": r["element_type"], "mark": r["mark"] or r["mark_now"],
            "status_at_move": r["status_at_move"], "address": r["address"],
            "floor": r["floor"], "current_status": r["current_status"],
            "contract_id_now": r["contract_id_now"],
            # Балансировка: «было» (снято при проведении) и «стало» (дата изделия сейчас).
            "prev_plan": r["prev_planned_delivery_date"], "plan_now": r["plan_now"],
            "counterparty": метки[r["contract_id_now"]][0] if r["contract_id_now"] in метки else None,
            "contract_name": метки[r["contract_id_now"]][1] if r["contract_id_now"] in метки else None,
            # Контракт и поставщик ДО проведения (у балансировки места меняются вместе с контрактом): по ним группируется таблица
            "prev_counterparty": метки[r["prev_contract_id"]][0] if r["prev_contract_id"] in метки else None,
            "prev_contract_name": метки[r["prev_contract_id"]][1] if r["prev_contract_id"] in метки else None,
        }
        for r in rows
    ]


def _doc_version(conn, doc) -> str:
    """Отпечаток документа для проверки устаревших данных: шапка (то, что правит форма), состояние и состав по сторонам и парам.
    Не зависит от служебных полей, которые проведение дописывает (status_at_move, prev_*)."""
    items = conn.execute(
        "SELECT element_id, side, pair_no FROM supplier_change_items WHERE doc_id = ? ORDER BY side, pair_no, element_id",
        (doc["id"],)).fetchall()
    return record_version.digest({
        "status": doc["status"], "number": doc["number"], "doc_date": doc["doc_date"], "from": doc["from_contract_id"],
        "to": doc["to_contract_id"], "mark": doc["mark"], "reason": doc["reason"], "comment": doc["comment"],
        "all_contracts": doc["all_contracts"], "all_marks": doc["all_marks"], "pool": doc["pool"],
        "items": [[i["element_id"], i["side"], i["pair_no"]] for i in items],
    })


def _doc_full(conn, doc_id: int) -> dict:
    """Документ целиком (шапка + состав + версия) — ответ создания, правки, проведения и отмены."""
    doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
    return {**_doc_head(conn, doc), "items": _doc_items(conn, doc_id), "version": _doc_version(conn, doc)}


@router.get("")
def list_supplier_changes(object_id: int = Query(...),
                          user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "read"))):
    conn = get_connection()
    try:
        allowed_kinds = tuple(kind for kind, feature_key in KIND_FEATURES.items()
                              if has_feature(conn, user, feature_key, "read", object_id))
        if not allowed_kinds:
            return []  # Право могли отозвать между проверкой зависимости и этим запросом.
        placeholders = ",".join("?" for _ in allowed_kinds)
        rows = conn.execute(
            f"""
            SELECT d.*, (SELECT COUNT(*) FROM supplier_change_items i WHERE i.doc_id = d.id) AS items
            FROM supplier_change_docs d WHERE d.object_id = ? AND d.kind IN ({placeholders})
            ORDER BY d.doc_date DESC, d.id DESC
            """,
            (object_id, *allowed_kinds),
        ).fetchall()
        return [{**_doc_head(conn, r), "items": r["items"]} for r in rows]
    finally:
        conn.close()


@router.get("/{doc_id}")
def get_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "read")
        return {**_doc_head(conn, doc), "items": _doc_items(conn, doc_id), "version": _doc_version(conn, doc)}
    finally:
        conn.close()


def _posting_changes(conn, doc) -> dict:
    """Протокол проведения: что документ изменил в каждом изделии (строки «изделие / что менялось / было / стало»).

    Берётся из снимка «что было» (`supplier_change_items.prev_*`, `status_at_move`) и из состава пар/цепочек документа, а НЕ из
    текущего состояния изделий: после проведения изделия могли править дальше, а протокол обязан показывать то, что записал
    документ. «Стало» выводится из источника: у замены поставщика это контракт шапки, у обмена и балансировки — снимок изделия,
    чьё место получено (сторона-партнёр пары; в цепочке место i-го получает от (i+1)-го, последнее — от первого)."""
    items = conn.execute(
        "SELECT i.*, e.address AS address, e.floor AS floor FROM supplier_change_items i "
        "LEFT JOIN elements e ON e.id = i.element_id WHERE i.doc_id = ? ORDER BY i.pair_no, i.side, i.id", (doc["id"],)).fetchall()
    moves = conn.execute("SELECT prev_element_id FROM supplier_change_history_moves WHERE doc_id = ?", (doc["id"],)).fetchall()
    ушло = {}
    for m in moves:
        if m["prev_element_id"] is not None:
            ушло[m["prev_element_id"]] = ушло.get(m["prev_element_id"], 0) + 1
    ids_контрактов = [i["prev_contract_id"] for i in items if i["prev_contract_id"]]
    ids_контрактов += [c for c in (doc["from_contract_id"], doc["to_contract_id"]) if c]
    метки = _contract_labels(conn, ids_контрактов)

    def контракт(cid):
        if not cid:
            return "—"
        cp, name = метки.get(cid, ("—", "—"))
        return f"{cp} · {name}"

    def дата(v):
        return "—" if not v else ".".join(reversed(str(v)[:10].split("-")))

    def статус(v):
        return STATUS_TITLES.get(v, v) if v else "—"

    источник = {}      # element_id -> строка изделия, чьё место он получил
    if doc["kind"] == KIND_SWAP:
        пары = {}
        for i in items:
            пары.setdefault(i["pair_no"], {})[i["side"]] = i
        for стороны in пары.values():
            if 1 in стороны and 2 in стороны:
                источник[стороны[1]["element_id"]] = стороны[2]
                источник[стороны[2]["element_id"]] = стороны[1]
    elif doc["kind"] == KIND_REBALANCE:
        циклы = {}
        for i in items:
            if i["pair_no"] is not None:
                циклы.setdefault(i["pair_no"], []).append(i)
        for цикл in циклы.values():
            цикл.sort(key=lambda r: r["side"])
            for n, i in enumerate(цикл):
                источник[i["element_id"]] = цикл[(n + 1) % len(цикл)]

    rows, без_изменений = [], 0
    for i in items:
        изделие = " · ".join(x for x in (i["element_type"], i["mark"]) if x) or f"№{i['element_id']}"
        адрес = i["address"] or ""
        общее = {"element_id": i["element_id"], "element": изделие, "address": адрес}
        прежний_контракт = i["prev_contract_id"] or (doc["from_contract_id"] if doc["kind"] == KIND_SUPPLIER else None)
        before = len(rows)

        def добавить(поле, было, стало):
            rows.append({**общее, "field": поле, "before": было, "after": стало})

        if doc["kind"] == KIND_SUPPLIER:
            добавить("Контракт", контракт(прежний_контракт), контракт(doc["to_contract_id"]))
            добавить("История статусов", "записей не добавлялось",
                     f"добавлена запись «{статус(i['status_at_move'])}» (замена поставщика), статус не менялся")
        elif i["element_id"] in источник:
            src = источник[i["element_id"]]
            if src["prev_contract_id"] != i["prev_contract_id"]:
                добавить("Контракт", контракт(i["prev_contract_id"]), контракт(src["prev_contract_id"]))
            if src["prev_planned_delivery_date"] != i["prev_planned_delivery_date"]:
                добавить("Плановая дата поставки", дата(i["prev_planned_delivery_date"]), дата(src["prev_planned_delivery_date"]))
            if src["status_at_move"] != i["status_at_move"]:
                добавить("Текущий статус", статус(i["status_at_move"]), статус(src["status_at_move"]))
            адрес_src = src["address"] or f"№{src['element_id']}"
            добавить("История статусов", f"собственная, записей: {ушло.get(i['element_id'], 0)}",
                     f"получена от изделия №{src['element_id']} ({адрес_src}), записей: {ушло.get(src['element_id'], 0)}; "
                     f"плюс запись о проведении")
        if len(rows) == before:
            без_изменений += 1
    return {"id": doc["id"], "number": doc["number"], "kind": doc["kind"], "kind_title": KIND_TITLES.get(doc["kind"], doc["kind"]),
            "doc_date": doc["doc_date"], "posted_at": doc["posted_at"], "posted_by": doc["posted_by"],
            "items": len(items), "unchanged": без_изменений, "rows": rows}


def _posting_changes_xlsx(протокол: dict) -> bytes:
    """Протокол проведения в XLSX: шапка документа и та же таблица, что на экране."""
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "Протокол изменений"
    ws.append([f"Протокол изменений — {протокол['kind_title']} № {протокол['number']}"])
    ws["A1"].font = Font(bold=True, size=13)
    posted = протокол["posted_at"] or ""
    ws.append([f"Дата документа: {протокол['doc_date'] or '—'}. Проведён: {posted}"
               + (f", {протокол['posted_by']}" if протокол["posted_by"] else "")
               + f". Изделий в документе: {протокол['items']}, без изменений: {протокол['unchanged']}."])
    ws.append([])
    thin = Side(style="thin", color="D5D8DC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    шапка = ["Изделие", "Адрес", "Что изменилось", "Было", "Стало"]
    ws.append(шапка)
    for c in range(1, len(шапка) + 1):
        cell = ws.cell(row=4, column=c)
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="EEF2F7")
        cell.border = border
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
    for r in протокол["rows"]:
        ws.append([r["element"], r["address"], r["field"], r["before"], r["after"]])
        for c in range(1, 6):
            cell = ws.cell(row=ws.max_row, column=c)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    for буква, ширина in zip("ABCDE", (28, 16, 24, 48, 60)):
        ws.column_dimensions[буква].width = ширина
    ws.freeze_panes = "A5"
    ws.auto_filter.ref = f"A4:E{max(ws.max_row, 4)}"
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


@router.get("/{doc_id}/changes.xlsx")
def get_posting_changes_xlsx(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Протокол проведения документа в Excel (те же права и тот же расчёт, что у экрана)."""
    from urllib.parse import quote

    from fastapi.responses import Response

    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "read")
        if doc["status"] != POSTED:
            raise HTTPException(status_code=409, detail="Документ не проведён: изменений ещё нет")
        протокол = _posting_changes(conn, doc)
    finally:
        conn.close()
    имя = f"Протокол изменений — {протокол['kind_title']} № {протокол['number']}.xlsx"
    return Response(
        content=_posting_changes_xlsx(протокол),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"protocol.xlsx\"; filename*=UTF-8''{quote(имя)}"})


@router.get("/{doc_id}/changes")
def get_posting_changes(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Протокол проведения документа: таблица «что изменил документ» (только проведённый)."""
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "read")
        if doc["status"] != POSTED:
            raise HTTPException(status_code=409, detail="Документ не проведён: изменений ещё нет")
        return _posting_changes(conn, doc)
    finally:
        conn.close()


# ------------------------------------------------------- создание и правка

def _load_elements(conn, ids: list, object_id: int) -> dict:
    """Изделия по id одним запросом. Отсев по объекту здесь же: документ
    работает на своей стройке, и чужое изделие не должно даже попасть в
    черновик."""
    if not ids:
        return {}
    места = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT id, element_type, subtype, mark, address, floor, current_status, contract_id, "
        f"object_id, is_current, planned_delivery_date FROM elements WHERE id IN ({места})",
        list(ids),
    ).fetchall()
    return {r["id"]: r for r in rows if r["object_id"] == object_id and r["is_current"]}


def _save_items(conn, doc_id: int, kind: str, object_id: int, body: SupplierChangeIn) -> int:
    """Табличная часть ЧЕРНОВИКА. Пишется целиком заново: состав правят
    списком, и вычислять разницу между старым и новым набором ради того же
    результата незачем."""
    conn.execute("DELETE FROM supplier_change_items WHERE doc_id = ?", (doc_id,))
    if kind in (KIND_SUPPLIER, KIND_REBALANCE):
        ids = list(dict.fromkeys(body.element_ids))
        elements = _load_elements(conn, ids, object_id)
        for element_id in ids:
            e = elements.get(element_id)
            if e is None:
                continue
            conn.execute(
                "INSERT INTO supplier_change_items (doc_id, element_id, side, element_type, mark) "
                "VALUES (?, ?, 1, ?, ?)",
                (doc_id, element_id, e["element_type"], e["mark"]),
            )
        return len(elements)

    a = list(dict.fromkeys(body.side_a))
    b = list(dict.fromkeys(body.side_b))
    пересечение = set(a) & set(b)
    if пересечение:
        raise HTTPException(
            status_code=400,
            detail=f"Изделия попали на обе стороны обмена: {', '.join(f'№{i}' for i in sorted(пересечение))}",
        )
    elements = _load_elements(conn, a + b, object_id)
    for сторона, ids in ((1, a), (2, b)):
        for номер, element_id in enumerate(ids, start=1):
            e = elements.get(element_id)
            if e is None:
                continue
            conn.execute(
                "INSERT INTO supplier_change_items (doc_id, element_id, side, pair_no, element_type, mark) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (doc_id, element_id, сторона, номер, e["element_type"], e["mark"]),
            )
    return len(a) + len(b)


def _validate_head(conn, body: SupplierChangeIn) -> None:
    if body.kind not in KIND_TITLES:
        raise HTTPException(status_code=400, detail=f"Неизвестный вид операции «{body.kind}»")
    if body.kind == KIND_REBALANCE:
        # Один контракт: в шапке он хранится дважды (обе колонки обязательны), чтобы не менять схему. «Все контракты» — шапке нужен
        # какой-то контракт объекта: берётся первый (он лишь представитель, охват задаёт all_contracts).
        if body.all_contracts:
            первый = conn.execute(
                "SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id "
                "JOIN agreements a ON a.id = s.agreement_id WHERE a.object_id = ? ORDER BY co.id LIMIT 1",
                (body.object_id,)).fetchone()
            if первый is None:
                raise HTTPException(status_code=400, detail="На объекте нет контрактов")
            body.from_contract_id = body.to_contract_id = первый["id"]
        elif body.from_contract_id != body.to_contract_id:
            raise HTTPException(status_code=400, detail="Балансировка выполняется внутри одного контракта")
        if body.all_marks:
            body.mark = None
        if body.pool and not body.all_contracts:
            body.pool = False      # общий пул осмыслен только между контрактами
    elif body.from_contract_id == body.to_contract_id:
        raise HTTPException(status_code=400, detail="Стороны операции совпадают — выберите разные контракты")
    роли = (("«текущий»", "«новый»") if body.kind == KIND_SUPPLIER
            else ("контракта", "контракта") if body.kind == KIND_REBALANCE else ("стороны 1", "стороны 2"))
    _assert_contract_of_object(conn, body.from_contract_id, body.object_id, роли[0])
    _assert_contract_of_object(conn, body.to_contract_id, body.object_id, роли[1])
    if not (body.doc_date or "").strip():
        raise HTTPException(status_code=400, detail="Не указана дата документа")
    if body.kind in (KIND_SWAP, KIND_REBALANCE) and not (body.mark or "").strip() and not (body.kind == KIND_REBALANCE and body.all_marks):
        raise HTTPException(status_code=400, detail="Не выбрана марка")
    if body.kind == KIND_SUPPLIER:
        архивный = conn.execute(
            "SELECT is_archived FROM contracts WHERE id = ?", (body.to_contract_id,)
        ).fetchone()
        if архивный and архивный["is_archived"]:
            raise HTTPException(
                status_code=400,
                detail="Новый контракт архивный — перенести на него нельзя. "
                       "Снимите признак архива в справочнике контрактов или выберите другой контракт.",
            )


@router.post("")
def create_supplier_change(body: SupplierChangeIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    """Создаёт ЧЕРНОВИК. Данные изделий при этом не меняются — документ пока
    только намерение; применяет его отдельная кнопка «Провести»."""
    conn = get_connection()
    try:
        # Блокировка записи первым действием: номер документа выдаётся по максимуму существующих — без неё два одновременных
        # черновика получили бы один номер (один из них упал бы на уникальном индексе)
        begin_write(conn)
        assert_object_feature(conn, user, body.object_id, _раздел(body.kind), "write")
        _validate_head(conn, body)
        номер = (body.number or "").strip() or _next_number(conn, body.object_id)
        if conn.execute(
            "SELECT 1 FROM supplier_change_docs WHERE object_id = ? AND number = ?",
            (body.object_id, номер),
        ).fetchone():
            raise HTTPException(status_code=409, detail=f"Документ № {номер} на этом объекте уже есть")
        автор = audit_display_name(user)
        conn.execute(
            "INSERT INTO supplier_change_docs (object_id, kind, status, number, doc_date, "
            "from_contract_id, to_contract_id, mark, reason, comment, created_by, created_by_user_id, "
            "all_contracts, all_marks, pool) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.object_id, body.kind, DRAFT, номер, body.doc_date, body.from_contract_id,
             body.to_contract_id, (body.mark or None), (body.reason or None), (body.comment or None),
             автор, user["id"], int(body.all_contracts), int(body.all_marks), int(body.pool)),
        )
        doc_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        _save_items(conn, doc_id, body.kind, body.object_id, body)
        conn.commit()
        activity.log("supplier_change_draft", user_id=user["id"],
                     user_name=impersonation.plain_name(автор),
                     entity_type="supplier_change", entity_id=doc_id,
                     new_value=f"{KIND_TITLES[body.kind]} № {номер}",
                     details={"kind": body.kind, "object_id": body.object_id})
        return _doc_full(conn, doc_id)
    finally:
        conn.close()


@router.patch("/{doc_id}")
def update_supplier_change(doc_id: int, body: SupplierChangeIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    """Правка ЧЕРНОВИКА. Проведённый документ не правится: его движения уже
    разошлись по изделиям, и подмена состава под ними означала бы отмену,
    сделанную втихую. Нужно поправить — отмените проведение."""
    conn = get_connection()
    try:
        # Блокировка записи первым действием: статус «черновик» проверяется и состав переписывается под одной блокировкой — иначе
        # параллельное проведение успевало бы между проверкой и записью, и состав ПРОВЕДЁННОГО документа менялся бы под уже
        # разошедшимися движениями
        begin_write(conn)
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] != DRAFT:
            raise HTTPException(status_code=409,
                                detail="Документ проведён — сначала отмените проведение")
        record_version.assert_fresh(body.expected_version, _doc_version(conn, doc), "Документ")
        body.object_id = doc["object_id"]
        body.kind = doc["kind"]      # вид операции у существующего документа не меняется
        _validate_head(conn, body)
        номер = (body.number or "").strip() or doc["number"]
        if номер != doc["number"] and conn.execute(
            "SELECT 1 FROM supplier_change_docs WHERE object_id = ? AND number = ? AND id != ?",
            (doc["object_id"], номер, doc_id),
        ).fetchone():
            raise HTTPException(status_code=409, detail=f"Документ № {номер} на этом объекте уже есть")
        conn.execute(
            "UPDATE supplier_change_docs SET number = ?, doc_date = ?, from_contract_id = ?, "
            "to_contract_id = ?, mark = ?, reason = ?, comment = ?, all_contracts = ?, all_marks = ?, pool = ? WHERE id = ?",
            (номер, body.doc_date, body.from_contract_id, body.to_contract_id,
             (body.mark or None), (body.reason or None), (body.comment or None),
             int(body.all_contracts), int(body.all_marks), int(body.pool), doc_id),
        )
        _save_items(conn, doc_id, doc["kind"], doc["object_id"], body)
        conn.commit()
        return _doc_full(conn, doc_id)
    finally:
        conn.close()


@router.delete("/{doc_id}")
def delete_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Удалить можно только ЧЕРНОВИК: проведённый документ — основание, на
    которое ссылаются движения по изделиям."""
    conn = get_connection()
    try:
        # Блокировка записи первым действием: проверка «это черновик» и удаление — под одной блокировкой (параллельное проведение не
        # должно успеть между ними: иначе удалялся бы уже проведённый документ вместе со своими движениями)
        begin_write(conn)
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] != DRAFT:
            raise HTTPException(status_code=409,
                                detail="Проведённый документ не удаляется — сначала отмените проведение")
        conn.execute("DELETE FROM supplier_change_docs WHERE id = ?", (doc_id,))
        conn.commit()
        activity.log("supplier_change_delete", user=user,
                     entity_type="supplier_change", entity_id=doc_id,
                     old_value=f"{KIND_TITLES.get(doc['kind'], doc['kind'])} № {doc['number']}")
        return {"deleted": doc_id}
    finally:
        conn.close()


# ---------------------------------------------------------------- проведение

def _doc_comment(doc, приставка: str) -> str:
    return (f"{приставка}, документ № {doc['number']} от {doc['doc_date']}")


def _post_supplier_change(conn, doc, items, автор, user_id) -> dict:
    """Замена поставщика: перенос остатка на новый контракт.

    Всё или ничего: строка, переставшая подходить, останавливает проведение
    с перечнем причин. Пропускать молча нельзя — документ уже сохранён и
    обязан означать ровно то, что в нём написано.
    """
    доступно = _available_in_contract(conn, doc["to_contract_id"])
    старое, новое = _contract_name(conn, doc["from_contract_id"]), _contract_name(conn, doc["to_contract_id"])
    комментарий = _doc_comment(doc, "Замена поставщика") + f": {старое} → {новое}"
    проблемы, взято = [], {}
    подготовка = []
    for it in items:
        e = conn.execute(
            "SELECT id, element_type, subtype, mark, address, current_status, contract_id, "
            "object_id, is_current, planned_delivery_date FROM elements WHERE id = ?",
            (it["element_id"],),
        ).fetchone()
        подпись = f"{it['mark'] or '—'} · №{it['element_id']}"
        if e is None or not e["is_current"] or e["object_id"] != doc["object_id"]:
            проблемы.append(f"{подпись}: изделия нет в актуальном чертеже объекта")
            continue
        подпись = f"{e['mark'] or '—'} · {e['address'] or ('№%d' % e['id'])}"
        if e["contract_id"] != doc["from_contract_id"]:
            проблемы.append(f"{подпись}: изделие уже не на текущем контракте")
            continue
        if e["current_status"] in BLOCKED_STATUSES:
            проблемы.append(f"{подпись}: статус «{STATUS_TITLES.get(e['current_status'], e['current_status'])}»"
                            f" — изделие уже поставлено на площадку")
            continue
        ключ = (e["element_type"], e["mark"])
        if взято.get(ключ, 0) >= доступно.get(ключ, 0):
            проблемы.append(f"{подпись}: в новом контракте нет свободного количества по позиции "
                            f"«{e['element_type'] or '—'} / {e['mark'] or '—'}» "
                            f"(доступно {доступно.get(ключ, 0)})")
            continue
        взято[ключ] = взято.get(ключ, 0) + 1
        подготовка.append(e)
    if проблемы:
        raise HTTPException(status_code=409, detail="Провести нельзя:\n" + "\n".join(проблемы[:20]))
    if not подготовка:
        raise HTTPException(status_code=409, detail="В документе нет ни одной позиции")

    for e in подготовка:
        conn.execute(
            "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
            (doc["to_contract_id"], e["id"]),
        )
        # Запись истории — ТЕМ ЖЕ статусом: замена поставщика не двигает
        # изделие по жизненному циклу, но обязана быть в истории, иначе
        # снимок контракта в последней записи остался бы от прежнего
        # поставщика. Момент — текущий, а не дата документа: запись задним
        # числом перестала бы быть последней.
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, "
            "comment, contract_id) VALUES (?, ?, ?, ?, ?, ?)",
            (e["id"], e["current_status"], автор, user_id, комментарий, doc["to_contract_id"]),
        )
        _remember_created_history(conn, doc["id"])
        conn.execute(
            "UPDATE supplier_change_items SET status_at_move = ?, prev_contract_id = ?, "
            "element_type = ?, mark = ? WHERE doc_id = ? AND element_id = ?",
            (e["current_status"], doc["from_contract_id"], e["element_type"], e["mark"],
             doc["id"], e["id"]),
        )
        activity.log("supplier_change", user_id=user_id, user_name=impersonation.plain_name(автор),
                     entity_type="element", entity_id=e["id"],
                     element_type=e["element_type"], subtype=e["subtype"], mark=e["mark"],
                     old_value=старое, new_value=новое,
                     details={"doc_id": doc["id"], "number": doc["number"],
                              "status": e["current_status"]})
    return {"moved": len(подготовка)}


def _remember_created_history(conn, doc_id: int) -> None:
    """Запомнить ТОЛЬКО ЧТО вставленную запись истории как созданную
    документом: при отмене проведения такие удаляются, а не возвращаются
    прежнему изделию."""
    history_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.execute(
        "INSERT INTO supplier_change_history_moves (doc_id, history_id, prev_element_id) "
        "VALUES (?, ?, NULL)", (doc_id, history_id),
    )


def _post_link_swap(conn, doc, items, автор, user_id) -> dict:
    """Обмен привязками: попарная перестановка контракта, плановой даты и
    ВСЕЙ истории статусов.

    Текущий статус и фактическая дата отдельно не переставляются — они
    производные от истории, и после переезда записей их пересчитывает
    recompute_status_and_actual_date. Переставлять их ещё и руками значило бы
    завести второй источник правды на одно значение.
    """
    сторона1 = [i for i in items if i["side"] == 1]
    сторона2 = [i for i in items if i["side"] == 2]
    if not сторона1 or not сторона2:
        raise HTTPException(status_code=409, detail="Обе стороны обмена должны быть заполнены")
    if len(сторона1) != len(сторона2):
        raise HTTPException(
            status_code=409,
            detail=f"Стороны не равны: {len(сторона1)} и {len(сторона2)} — обмен возможен только парами",
        )
    сторона1.sort(key=lambda i: (i["pair_no"] or 0, i["id"]))
    сторона2.sort(key=lambda i: (i["pair_no"] or 0, i["id"]))

    марка = (doc["mark"] or "").strip().lower()
    проблемы, пары = [], []
    for a_item, b_item in zip(сторона1, сторона2):
        пара = []
        for it, contract_id, подпись_стороны in (
            (a_item, doc["from_contract_id"], "сторона 1"), (b_item, doc["to_contract_id"], "сторона 2")
        ):
            e = conn.execute(
                "SELECT id, element_type, subtype, mark, address, floor, current_status, contract_id, "
                "object_id, is_current, planned_delivery_date FROM elements WHERE id = ?",
                (it["element_id"],),
            ).fetchone()
            подпись = f"{подпись_стороны}, №{it['element_id']}"
            if e is None or not e["is_current"] or e["object_id"] != doc["object_id"]:
                проблемы.append(f"{подпись}: изделия нет в актуальном чертеже объекта")
                пара.append(None)
                continue
            подпись = f"{подпись_стороны}: {e['mark'] or '—'} · {e['address'] or ('№%d' % e['id'])}"
            if e["contract_id"] != contract_id:
                проблемы.append(f"{подпись}: изделие стоит уже не на том контракте, что в документе")
                пара.append(None)
                continue
            if марка and (e["mark"] or "").strip().lower() != марка:
                проблемы.append(f"{подпись}: марка изделия не совпадает с маркой документа «{doc['mark']}»")
                пара.append(None)
                continue
            пара.append(e)
        пары.append(пара)
    if проблемы:
        raise HTTPException(status_code=409, detail="Провести нельзя:\n" + "\n".join(проблемы[:20]))

    комментарий = _doc_comment(doc, "Обмен привязками")
    for (a, b), a_item, b_item in zip(пары, сторона1, сторона2):
        # Снимок «что было» — ДО любых изменений: он единственное основание
        # для отмены проведения.
        for it, e in ((a_item, a), (b_item, b)):
            conn.execute(
                "UPDATE supplier_change_items SET status_at_move = ?, prev_contract_id = ?, "
                "prev_planned_delivery_date = ?, element_type = ?, mark = ? WHERE id = ?",
                (e["current_status"], e["contract_id"], e["planned_delivery_date"],
                 e["element_type"], e["mark"], it["id"]),
            )
        # История переезжает ЦЕЛИКОМ, обе стороны сразу. Промежуточный
        # element_id = 0 не нужен: записи выбираются по СПИСКУ id, снятому до
        # первого UPDATE, поэтому второй UPDATE не может задеть только что
        # переехавшие записи.
        записи_a = [r["id"] for r in conn.execute(
            "SELECT id FROM status_history WHERE element_id = ?", (a["id"],)).fetchall()]
        записи_b = [r["id"] for r in conn.execute(
            "SELECT id FROM status_history WHERE element_id = ?", (b["id"],)).fetchall()]
        for history_ids, откуда, куда in ((записи_a, a["id"], b["id"]), (записи_b, b["id"], a["id"])):
            for history_id in history_ids:
                conn.execute("UPDATE status_history SET element_id = ? WHERE id = ?", (куда, history_id))
                conn.execute(
                    "INSERT INTO supplier_change_history_moves (doc_id, history_id, prev_element_id) "
                    "VALUES (?, ?, ?)", (doc["id"], history_id, откуда),
                )
        # Живые поля — явно: контракт и плановая дата производными от истории
        # не являются.
        conn.execute(
            "UPDATE elements SET contract_id = ?, planned_delivery_date = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (b["contract_id"], b["planned_delivery_date"], a["id"]),
        )
        conn.execute(
            "UPDATE elements SET contract_id = ?, planned_delivery_date = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (a["contract_id"], a["planned_delivery_date"], b["id"]),
        )
        for e, встречный in ((a, b), (b, a)):
            статус, _ = recompute_status_and_actual_date(conn, e["id"])
            conn.execute(
                "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, "
                "comment, contract_id) VALUES (?, ?, ?, ?, ?, ?)",
                (e["id"], статус, автор, user_id,
                 f"{комментарий}: привязка получена от изделия №{встречный['id']}"
                 f" ({встречный['address'] or 'без адреса'})", встречный["contract_id"]),
            )
            _remember_created_history(conn, doc["id"])
            activity.log("link_swap", user_id=user_id, user_name=impersonation.plain_name(автор),
                         entity_type="element", entity_id=e["id"],
                         element_type=e["element_type"], subtype=e["subtype"], mark=e["mark"],
                         old_value=_contract_name(conn, e["contract_id"]) if e["contract_id"] else None,
                         new_value=_contract_name(conn, встречный["contract_id"]) if встречный["contract_id"] else None,
                         details={"doc_id": doc["id"], "number": doc["number"],
                                  "pair_with": встречный["id"], "status": статус})
    return {"pairs": len(пары)}


@router.post("/{doc_id}/post")
def post_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user), body: Optional[DocActionIn] = None):
    conn = get_connection()
    events = activity.defer_begin()   # события supplier_change по изделиям — только после commit (app/activity.py)
    try:
        begin_write(conn)   # блокировка записи ДО чтения документа, остатков и покрытия (app/db.py)
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] == POSTED:
            raise HTTPException(status_code=409, detail="Документ уже проведён")
        # Провести можно только то, что человек видел: состав/шапку мог изменить другой пользователь, пока форма была открыта
        record_version.assert_fresh(body.expected_version if body else None, _doc_version(conn, doc), "Документ")
        items = conn.execute(
            "SELECT * FROM supplier_change_items WHERE doc_id = ? ORDER BY pair_no, side, id", (doc_id,)
        ).fetchall()
        if not items:
            raise HTTPException(status_code=409, detail="В документе нет ни одной позиции")
        автор = audit_display_name(user)
        # Оба контракта документа под общим стражем (2026-08-14, см.
        # app/contract_guard.py). У замены поставщика своя проверка
        # свободного количества (_post_supplier_change) — она осталась,
        # потому что объясняет отказ по позициям документа; эта же ловит
        # то, чего та не видит: обмен привязками переставляет изделия
        # РАЗНЫХ марок, если марка в документе не задана.
        участники = [c for c in (doc["from_contract_id"], doc["to_contract_id"]) if c]
        if doc["kind"] == KIND_REBALANCE:    # изделия меняются местами вместе с контрактом — под стражем контракты ВСЕХ изделий документа
            for r in conn.execute("SELECT DISTINCT e.contract_id FROM supplier_change_items i JOIN elements e ON e.id = i.element_id "
                                  "WHERE i.doc_id = ? AND e.contract_id IS NOT NULL", (doc_id,)):
                if r["contract_id"] not in участники:
                    участники.append(r["contract_id"])
        покрытие_до = {c: contract_guard.coverage_state(conn, c) for c in участники}
        try:
            if doc["kind"] == KIND_SWAP:
                итог = _post_link_swap(conn, doc, [dict(i) for i in items], автор, user["id"])
            elif doc["kind"] == KIND_REBALANCE:
                итог = _post_rebalance(conn, doc, [dict(i) for i in items], автор, user["id"])
            else:
                итог = _post_supplier_change(conn, doc, [dict(i) for i in items], автор, user["id"])
            contract_guard.assert_no_regression(
                conn, участники, покрытие_до,
                "Проведение оставило бы изделия без позиции в контракте:")
        except HTTPException:
            # Проведение — всё или ничего: частично изменённые изделия при
            # документе, который так и остался черновиком, были бы хуже отказа.
            conn.rollback()
            raise
        conn.execute(
            "UPDATE supplier_change_docs SET status = ?, posted_at = datetime('now'), "
            "posted_by = ?, posted_by_user_id = ? WHERE id = ?",
            (POSTED, автор, user["id"], doc_id),
        )
        # Изделия документа — из его же позиций: так один вызов покрывает оба
        # вида документа, и набор не нужно тащить наружу из обработчиков
        # проведения (см. app.db.touch_elements).
        touch_elements(conn, [r["element_id"] for r in conn.execute(
            "SELECT element_id FROM supplier_change_items WHERE doc_id = ?", (doc_id,))])
        conn.commit()
        activity.defer_flush(events)
        activity.log("supplier_change_post", user_id=user["id"],
                     user_name=impersonation.plain_name(автор),
                     entity_type="supplier_change", entity_id=doc_id,
                     new_value=f"{KIND_TITLES.get(doc['kind'], doc['kind'])} № {doc['number']} проведён",
                     details={"kind": doc["kind"], **итог})
        return {**_doc_full(conn, doc_id), **итог}
    finally:
        activity.defer_end(events)
        conn.close()


@router.post("/{doc_id}/unpost")
def unpost_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user), body: Optional[DocActionIn] = None):
    """Отмена проведения: изделия возвращаются в состояние до документа.

    Порядок обратный проведению — сначала снимаются записи, созданные
    документом, потом возвращаются переехавшие, и только затем пересчитываются
    производные (текущий статус и фактическая дата). В другом порядке
    пересчёт опирался бы на историю, которую ещё не вернули.

    Страж остатка контракта (симметрично post_supplier_change, см.
    app/contract_guard.py): пока документ был проведён, освободившееся место
    на «прежнем» контракте мог занять кто-то другой — другая замена,
    распределение, ручное назначение. Возврат привязки вслепую тогда создал
    бы превышение остатка молча. Снимаем покрытие участвующих контрактов ДО
    возврата, после возврата сверяем assert_no_regression — как в
    проведении, запрещаем именно УХУДШЕНИЕ, а не любое накопленное
    превышение (оно уже могло быть и до этой операции по не связанной с ней
    причине).
    """
    conn = get_connection()
    try:
        begin_write(conn)   # блокировка записи ДО чтения документа и возврата привязок (app/db.py)
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] != POSTED:
            raise HTTPException(status_code=409, detail="Документ не проведён")
        record_version.assert_fresh(body.expected_version if body else None, _doc_version(conn, doc), "Документ")
        items = conn.execute(
            "SELECT * FROM supplier_change_items WHERE doc_id = ?", (doc_id,)
        ).fetchall()
        moves = conn.execute(
            "SELECT * FROM supplier_change_history_moves WHERE doc_id = ? ORDER BY id DESC", (doc_id,)
        ).fetchall()
        if doc["kind"] == KIND_REBALANCE:
            конфликты = _rebalance_unpost_conflicts(conn, doc_id, items)
            if конфликты:
                raise HTTPException(
                    status_code=409,
                    detail="Отменить проведение нельзя: после него изделия менялись, и отмена затёрла бы эти изменения. "
                           "Верните их или исправьте вручную:\n" + "\n".join(конфликты[:20])
                           + (f"\n… и ещё {len(конфликты) - 20}" if len(конфликты) > 20 else ""))

        # Участники сверки — контракты шапки (симметрично проведению) плюс
        # прежний контракт каждой позиции (то самое значение, что возврат
        # сейчас туда запишет) плюс ТЕКУЩИЙ контракт элемента прямо сейчас
        # (на случай, если после проведения его успела передвинуть ДРУГАЯ
        # операция — тогда список из одной шапки документа его бы не поймал).
        участники = {c for c in (doc["from_contract_id"], doc["to_contract_id"]) if c}
        for it in items:
            прежний = it["prev_contract_id"]
            if прежний is None and doc["kind"] == KIND_SUPPLIER:
                прежний = doc["from_contract_id"]
            if прежний:
                участники.add(прежний)
        ids_now = [it["element_id"] for it in items]
        if ids_now:
            места = ",".join("?" * len(ids_now))
            for r in conn.execute(f"SELECT DISTINCT contract_id FROM elements WHERE id IN ({места})", ids_now):
                if r["contract_id"]:
                    участники.add(r["contract_id"])
        покрытие_до = {c: contract_guard.coverage_state(conn, c) for c in участники}

        затронутые = set()
        try:
            for m in moves:
                if m["prev_element_id"] is None:
                    conn.execute("DELETE FROM status_history WHERE id = ?", (m["history_id"],))
                else:
                    conn.execute("UPDATE status_history SET element_id = ? WHERE id = ?",
                                 (m["prev_element_id"], m["history_id"]))
                    затронутые.add(m["prev_element_id"])
            conn.execute("DELETE FROM supplier_change_history_moves WHERE doc_id = ?", (doc_id,))

            for it in items:
                # Прежний контракт: у документов, записанных до появления
                # проведения, prev_contract_id пуст — там изделие пришло с
                # from_contract_id шапки, другого варианта у той операции не было.
                прежний = it["prev_contract_id"]
                if прежний is None and doc["kind"] == KIND_SUPPLIER:
                    прежний = doc["from_contract_id"]
                conn.execute(
                    "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
                    (прежний, it["element_id"]),
                )
                if doc["kind"] in (KIND_SWAP, KIND_REBALANCE):
                    conn.execute(
                        "UPDATE elements SET planned_delivery_date = ? WHERE id = ?",
                        (it["prev_planned_delivery_date"], it["element_id"]),
                    )
                затронутые.add(it["element_id"])
                conn.execute(
                    "UPDATE supplier_change_items SET prev_contract_id = NULL, "
                    "prev_planned_delivery_date = NULL, status_at_move = NULL WHERE id = ?", (it["id"],)
                )
                if doc["kind"] == KIND_REBALANCE:    # пары существуют только у проведённого документа
                    conn.execute("UPDATE supplier_change_items SET side = 1, pair_no = NULL WHERE id = ?", (it["id"],))

            for element_id in затронутые:
                if conn.execute("SELECT 1 FROM status_history WHERE element_id = ? LIMIT 1",
                                (element_id,)).fetchone():
                    recompute_status_and_actual_date(conn, element_id)

            contract_guard.assert_no_regression(
                conn, участники, покрытие_до,
                "Отмена проведения оставила бы изделия без позиции в контракте:")
        except HTTPException:
            # Страж отказал (или сам возврат наткнулся на исключение) —
            # откатываем ВСЮ транзакцию: документ остаётся проведённым,
            # привязки и история статусов не меняются (см. assert_no_regression).
            conn.rollback()
            raise

        conn.execute(
            "UPDATE supplier_change_docs SET status = ?, posted_at = NULL, posted_by = NULL, "
            "posted_by_user_id = NULL WHERE id = ?", (DRAFT, doc_id),
        )
        touch_elements(conn, затронутые)   # см. app.db.touch_elements
        conn.commit()
        автор = audit_display_name(user)
        activity.log("supplier_change_unpost", user_id=user["id"],
                     user_name=impersonation.plain_name(автор),
                     entity_type="supplier_change", entity_id=doc_id,
                     old_value=f"{KIND_TITLES.get(doc['kind'], doc['kind'])} № {doc['number']} проведён",
                     new_value="проведение отменено",
                     details={"kind": doc["kind"], "elements": len(затронутые)})
        return {**_doc_full(conn, doc_id), "elements": len(затронутые)}
    finally:
        conn.close()

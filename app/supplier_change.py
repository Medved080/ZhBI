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

from app import activity, contract_guard, impersonation
from app.access import (
    assert_object_any_feature,
    assert_object_feature,
    require_any_feature,
)
from app.auth import audit_display_name, get_current_user
from app.contracts import _specification_chain, build_contract_name, recompute_status_and_actual_date
from app.db import get_connection, touch_elements
from app.models import STATUS_LABELS_RU, STATUS_ORDER

router = APIRouter(prefix="/supplier-changes", tags=["supplier-change"])

STATUS_TITLES = {s.value: STATUS_LABELS_RU[s] for s in STATUS_ORDER}

KIND_SUPPLIER = "supplier_change"
KIND_SWAP = "link_swap"
KIND_TITLES = {KIND_SUPPLIER: "Замена поставщика", KIND_SWAP: "Обмен привязками"}

# Раздел прав у каждого вида свой (2026-08-14): администратор может доверить
# кому-то замену поставщика, не открывая обмен привязками, и наоборот.
KIND_FEATURES = {KIND_SUPPLIER: "doc_supplier_change", KIND_SWAP: "doc_link_swap"}
DOC_FEATURES = tuple(KIND_FEATURES.values())


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


class SupplierChangeIn(BaseModel):
    object_id: int
    kind: str = KIND_SUPPLIER
    # Пустой номер — сервер выдаст следующий по этому объекту. Ручной ввод
    # оставлен: у заказчика бывает свой номер распорядительного документа.
    number: Optional[str] = None
    doc_date: str
    from_contract_id: int
    to_contract_id: int
    mark: Optional[str] = None
    reason: Optional[str] = None
    comment: Optional[str] = None
    # Замена поставщика: что переносим. Обмен привязками: side_a/side_b,
    # пара — одинаковые позиции в списках.
    element_ids: list[int] = []
    side_a: list[int] = []
    side_b: list[int] = []


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
        "created_at": r["created_at"], "created_by": r["created_by"],
        "posted_at": r["posted_at"], "posted_by": r["posted_by"],
        "from_contract_id": r["from_contract_id"], "to_contract_id": r["to_contract_id"],
        "from_contract_name": _contract_name(conn, r["from_contract_id"]),
        "to_contract_name": _contract_name(conn, r["to_contract_id"]),
    }


def _doc_items(conn, doc_id: int) -> list:
    rows = conn.execute(
        """
        SELECT i.*, e.address AS address, e.current_status AS current_status,
               e.contract_id AS contract_id_now, e.mark AS mark_now, e.floor AS floor
        FROM supplier_change_items i
        LEFT JOIN elements e ON e.id = i.element_id
        WHERE i.doc_id = ? ORDER BY i.pair_no, i.side, i.id
        """,
        (doc_id,),
    ).fetchall()
    return [
        {
            "element_id": r["element_id"], "side": r["side"], "pair_no": r["pair_no"],
            "element_type": r["element_type"], "mark": r["mark"] or r["mark_now"],
            "status_at_move": r["status_at_move"], "address": r["address"],
            "floor": r["floor"], "current_status": r["current_status"],
            "contract_id_now": r["contract_id_now"],
        }
        for r in rows
    ]


@router.get("")
def list_supplier_changes(object_id: int = Query(...),
                          user: sqlite3.Row = Depends(require_any_feature(DOC_FEATURES, "read"))):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT d.*, (SELECT COUNT(*) FROM supplier_change_items i WHERE i.doc_id = d.id) AS items
            FROM supplier_change_docs d WHERE d.object_id = ?
            ORDER BY d.doc_date DESC, d.id DESC
            """,
            (object_id,),
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
        return {**_doc_head(conn, doc), "items": _doc_items(conn, doc_id)}
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
    if kind == KIND_SUPPLIER:
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
    if body.from_contract_id == body.to_contract_id:
        raise HTTPException(status_code=400, detail="Стороны операции совпадают — выберите разные контракты")
    роли = ("«текущий»", "«новый»") if body.kind == KIND_SUPPLIER else ("стороны 1", "стороны 2")
    _assert_contract_of_object(conn, body.from_contract_id, body.object_id, роли[0])
    _assert_contract_of_object(conn, body.to_contract_id, body.object_id, роли[1])
    if not (body.doc_date or "").strip():
        raise HTTPException(status_code=400, detail="Не указана дата документа")
    if body.kind == KIND_SWAP and not (body.mark or "").strip():
        raise HTTPException(status_code=400, detail="Не выбрана марка обмена")
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
            "from_contract_id, to_contract_id, mark, reason, comment, created_by, created_by_user_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.object_id, body.kind, DRAFT, номер, body.doc_date, body.from_contract_id,
             body.to_contract_id, (body.mark or None), (body.reason or None), (body.comment or None),
             автор, user["id"]),
        )
        doc_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        _save_items(conn, doc_id, body.kind, body.object_id, body)
        conn.commit()
        activity.log("supplier_change_draft", user_id=user["id"],
                     user_name=impersonation.plain_name(автор),
                     entity_type="supplier_change", entity_id=doc_id,
                     new_value=f"{KIND_TITLES[body.kind]} № {номер}",
                     details={"kind": body.kind, "object_id": body.object_id})
        return {**_doc_head(conn, conn.execute(
            "SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()),
            "items": _doc_items(conn, doc_id)}
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
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] != DRAFT:
            raise HTTPException(status_code=409,
                                detail="Документ проведён — сначала отмените проведение")
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
            "to_contract_id = ?, mark = ?, reason = ?, comment = ? WHERE id = ?",
            (номер, body.doc_date, body.from_contract_id, body.to_contract_id,
             (body.mark or None), (body.reason or None), (body.comment or None), doc_id),
        )
        _save_items(conn, doc_id, doc["kind"], doc["object_id"], body)
        conn.commit()
        return {**_doc_head(conn, conn.execute(
            "SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()),
            "items": _doc_items(conn, doc_id)}
    finally:
        conn.close()


@router.delete("/{doc_id}")
def delete_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Удалить можно только ЧЕРНОВИК: проведённый документ — основание, на
    которое ссылаются движения по изделиям."""
    conn = get_connection()
    try:
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
def post_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] == POSTED:
            raise HTTPException(status_code=409, detail="Документ уже проведён")
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
        покрытие_до = {c: contract_guard.coverage_state(conn, c) for c in участники}
        try:
            if doc["kind"] == KIND_SWAP:
                итог = _post_link_swap(conn, doc, [dict(i) for i in items], автор, user["id"])
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
        activity.log("supplier_change_post", user_id=user["id"],
                     user_name=impersonation.plain_name(автор),
                     entity_type="supplier_change", entity_id=doc_id,
                     new_value=f"{KIND_TITLES.get(doc['kind'], doc['kind'])} № {doc['number']} проведён",
                     details={"kind": doc["kind"], **итог})
        return {**_doc_head(conn, conn.execute(
            "SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()),
            "items": _doc_items(conn, doc_id), **итог}
    finally:
        conn.close()


@router.post("/{doc_id}/unpost")
def unpost_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Отмена проведения: изделия возвращаются в состояние до документа.

    Порядок обратный проведению — сначала снимаются записи, созданные
    документом, потом возвращаются переехавшие, и только затем пересчитываются
    производные (текущий статус и фактическая дата). В другом порядке
    пересчёт опирался бы на историю, которую ещё не вернули.
    """
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_feature(conn, user, doc["object_id"], _раздел(doc["kind"]), "write")
        if doc["status"] != POSTED:
            raise HTTPException(status_code=409, detail="Документ не проведён")
        items = conn.execute(
            "SELECT * FROM supplier_change_items WHERE doc_id = ?", (doc_id,)
        ).fetchall()
        moves = conn.execute(
            "SELECT * FROM supplier_change_history_moves WHERE doc_id = ? ORDER BY id DESC", (doc_id,)
        ).fetchall()

        затронутые = set()
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
            if doc["kind"] == KIND_SWAP:
                conn.execute(
                    "UPDATE elements SET planned_delivery_date = ? WHERE id = ?",
                    (it["prev_planned_delivery_date"], it["element_id"]),
                )
            затронутые.add(it["element_id"])
            conn.execute(
                "UPDATE supplier_change_items SET prev_contract_id = NULL, "
                "prev_planned_delivery_date = NULL, status_at_move = NULL WHERE id = ?", (it["id"],)
            )

        for element_id in затронутые:
            if conn.execute("SELECT 1 FROM status_history WHERE element_id = ? LIMIT 1",
                            (element_id,)).fetchone():
                recompute_status_and_actual_date(conn, element_id)

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
        return {**_doc_head(conn, conn.execute(
            "SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()),
            "items": _doc_items(conn, doc_id), "elements": len(затронутые)}
    finally:
        conn.close()

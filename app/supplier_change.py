"""
Документ «Смена поставщика» (2026-08-11, запрос пользователя).

Зачем: поставщик не устраивает по срокам или качеству, и НЕПОСТАВЛЕННЫЙ
остаток контракта переводится на другой контракт — обычно другого завода.
До этого документа такой перевод делался поштучно, через правку контракта
у каждого изделия: на сотне колонн это сотня действий, каждое из которых
можно сделать не так, и ни одно не объясняет, почему оно сделано.

Почему ДОКУМЕНТ, а не разовая форма (выбор пользователя): перевод —
основание, на которое потом ссылаются. Шапка хранит, когда и почему
перенос сделан и между какими контрактами, табличная часть — что именно
переехало. Правки и отмены записанного документа НЕТ намеренно: движения
уже разошлись по изделиям и по их истории статусов, и «отменить» значило
бы задним числом переписать чужие записи. Ошиблись — записывается обратный
документ.

Три правила, которые держит сервер (интерфейс их только показывает):

1. **Поставленное на площадку не переносится.** Порог — «Отгружен» и выше
   (решение пользователя): отгруженное изделие уже изготовлено старым
   заводом и уехало, менять ему поставщика поздно. Ниже порога у изделия с
   контрактом остаются «Контрактация» и «В производстве» — «Запланирован»
   в переносе не участвует по устройству системы, у него контракта нет
   вовсе (инвариант, см. app/contracts.py sync_element_contract).

2. **Больше, чем есть в новом контракте, не переносится.** Доступное
   считается по СТРОКАМ нового контракта, не связанным с изделиями схемы:
   `план − факт − повреждено` по (тип, марка) — та же формула, что у
   остатка в карточке контракта и в выборе контракта при смене статуса
   (`contract_positions`). Расходиться этим местам нельзя: человек видит
   остаток в одном месте, а перенос упирался бы в другой.

3. **Позиции нового контракта нет — переносить некуда.** Строка (тип,
   марка), которой в новом контракте не существует, доступна в нулевом
   количестве, а не «сколько угодно».

Что делает запись документа с изделием: меняет `elements.contract_id` и
добавляет запись в историю статусов ТЕМ ЖЕ статусом, с новым контрактом в
снимке и комментарием со ссылкой на документ (выбор пользователя). Прежние
записи истории не трогаются — они правда о том, чем изделие закрывали
раньше. Плюс поэлементная запись в журнал действий (требование
пользователя): «что именно переехало» должно искаться и в журнале, а не
только в документе.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity, impersonation
from app.access import assert_object_access, require_object_access, require_object_contractor
from app.auth import audit_display_name, get_current_user
from app.contracts import _specification_chain, build_contract_name
from app.db import get_connection
from app.models import STATUS_LABELS_RU, STATUS_ORDER

router = APIRouter(prefix="/supplier-changes", tags=["supplier-change"])

STATUS_TITLES = {s.value: STATUS_LABELS_RU[s] for s in STATUS_ORDER}

# Порог «уже на площадке»: этот статус и все следующие за ним переносу не
# подлежат. Считается ОТ порядка жизненного цикла, а не перечислением
# четырёх кодов: появится статус между «Отгружен» и «Доставлен» — он попадёт
# в запрет сам, а список из четырёх строк промолчал бы.
BLOCKED_FROM = "shipped"
_ORDER = [s.value for s in STATUS_ORDER]
BLOCKED_STATUSES = set(_ORDER[_ORDER.index(BLOCKED_FROM):])


class SupplierChangeIn(BaseModel):
    object_id: int
    # Пустой номер — сервер выдаст следующий по этому объекту. Ручной ввод
    # оставлен: у заказчика бывает свой номер распорядительного документа.
    number: Optional[str] = None
    doc_date: str
    from_contract_id: int
    to_contract_id: int
    reason: Optional[str] = None
    comment: Optional[str] = None
    element_ids: list[int]


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
            detail=f"Контракт {роль} относится к другому объекту — перенос возможен только внутри одного объекта",
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
                         user: sqlite3.Row = Depends(require_object_contractor)):
    """Справочные данные формы: контракты объекта. Отдельным запросом, а не
    из `state.contracts` на клиенте: тот список общий на все доступные
    стройки, а документ переносит внутри одного объекта."""
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
    user: sqlite3.Row = Depends(require_object_contractor),
):
    """Что и в каком количестве можно перенести: позиции (тип, марка) с
    перечнем самих изделий.

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


@router.get("")
def list_supplier_changes(object_id: int = Query(...),
                          user: sqlite3.Row = Depends(require_object_access)):
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
        return [
            {
                **{k: r[k] for k in ("id", "number", "doc_date", "reason", "comment",
                                     "created_at", "created_by", "items")},
                "from_contract_id": r["from_contract_id"],
                "to_contract_id": r["to_contract_id"],
                "from_contract_name": _contract_name(conn, r["from_contract_id"]),
                "to_contract_name": _contract_name(conn, r["to_contract_id"]),
            }
            for r in rows
        ]
    finally:
        conn.close()


@router.get("/{doc_id}")
def get_supplier_change(doc_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM supplier_change_docs WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Документ не найден")
        assert_object_access(conn, user, doc["object_id"], "view")
        items = conn.execute(
            """
            SELECT i.*, e.address AS address, e.current_status AS current_status
            FROM supplier_change_items i
            LEFT JOIN elements e ON e.id = i.element_id
            WHERE i.doc_id = ? ORDER BY i.element_type, i.mark, i.element_id
            """,
            (doc_id,),
        ).fetchall()
        return {
            **{k: doc[k] for k in ("id", "object_id", "number", "doc_date", "reason", "comment",
                                   "created_at", "created_by")},
            "from_contract_id": doc["from_contract_id"],
            "to_contract_id": doc["to_contract_id"],
            "from_contract_name": _contract_name(conn, doc["from_contract_id"]),
            "to_contract_name": _contract_name(conn, doc["to_contract_id"]),
            "items": [
                {
                    "element_id": i["element_id"], "element_type": i["element_type"],
                    "mark": i["mark"], "status_at_move": i["status_at_move"],
                    "address": i["address"], "current_status": i["current_status"],
                }
                for i in items
            ],
        }
    finally:
        conn.close()


@router.post("")
def create_supplier_change(body: SupplierChangeIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    """Запись документа: шапка, табличная часть, правка изделий, история
    статусов, журнал. Одной транзакцией — документ, ссылающийся на изделия,
    которые не переехали, был бы хуже отказа целиком.

    Проверки повторяются здесь, а не только при подборе кандидатов: между
    показом формы и записью статус изделия мог уехать вперёд, а место в
    новом контракте — занять соседний документ. Изделие, переставшее
    подходить, отбрасывается с причиной (`skipped`), а не роняет запись:
    отказать во всём из-за одной колонны значит заставить набирать документ
    заново.
    """
    conn = get_connection()
    try:
        assert_object_access(conn, user, body.object_id, "contract")
        if body.from_contract_id == body.to_contract_id:
            raise HTTPException(status_code=400, detail="Текущий и новый контракты совпадают")
        _assert_contract_of_object(conn, body.from_contract_id, body.object_id, "«текущий»")
        _assert_contract_of_object(conn, body.to_contract_id, body.object_id, "«новый»")
        архивный = conn.execute(
            "SELECT is_archived FROM contracts WHERE id = ?", (body.to_contract_id,)
        ).fetchone()
        if архивный and архивный["is_archived"]:
            raise HTTPException(
                status_code=400,
                detail="Новый контракт архивный — перенести на него нельзя. "
                       "Снимите признак архива в справочнике контрактов или выберите другой контракт.",
            )
        if not body.element_ids:
            raise HTTPException(status_code=400, detail="Не выбрано ни одной позиции для переноса")
        if not (body.doc_date or "").strip():
            raise HTTPException(status_code=400, detail="Не указана дата документа")

        доступно = _available_in_contract(conn, body.to_contract_id)
        старое_имя = _contract_name(conn, body.from_contract_id)
        новое_имя = _contract_name(conn, body.to_contract_id)
        номер = (body.number or "").strip() or _next_number(conn, body.object_id)
        if conn.execute(
            "SELECT 1 FROM supplier_change_docs WHERE object_id = ? AND number = ?",
            (body.object_id, номер),
        ).fetchone():
            raise HTTPException(status_code=409, detail=f"Документ № {номер} на этом объекте уже есть")

        автор = audit_display_name(user)
        conn.execute(
            "INSERT INTO supplier_change_docs (object_id, number, doc_date, from_contract_id, "
            "to_contract_id, reason, comment, created_by, created_by_user_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.object_id, номер, body.doc_date, body.from_contract_id, body.to_contract_id,
             (body.reason or None), (body.comment or None), автор, user["id"]),
        )
        doc_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

        комментарий = f"Смена поставщика, документ № {номер} от {body.doc_date}: {старое_имя} → {новое_имя}"
        перенесено, пропущено, взято = [], [], {}
        for element_id in dict.fromkeys(body.element_ids):     # порядок и без повторов
            row = conn.execute(
                "SELECT id, element_type, subtype, mark, address, current_status, contract_id, "
                "object_id, is_current FROM elements WHERE id = ?",
                (element_id,),
            ).fetchone()
            подпись = f"№{element_id}"
            if row is None:
                пропущено.append({"element_id": element_id, "label": подпись,
                                  "reason": "Изделие не найдено"})
                continue
            подпись = f"{row['mark'] or '—'} · {row['address'] or f'№{element_id}'}"
            if row["object_id"] != body.object_id:
                пропущено.append({"element_id": element_id, "label": подпись,
                                  "reason": "Изделие другого объекта"})
                continue
            if not row["is_current"]:
                # Изделие прошлой версии чертежа: на схеме его нет, в
                # остатках контракта оно не участвует — переносить нечего.
                пропущено.append({"element_id": element_id, "label": подпись,
                                  "reason": "Изделие не из актуальной версии чертежа"})
                continue
            if row["contract_id"] != body.from_contract_id:
                пропущено.append({"element_id": element_id, "label": подпись,
                                  "reason": "Изделие уже не на текущем контракте — его перевели раньше"})
                continue
            if row["current_status"] in BLOCKED_STATUSES:
                пропущено.append({
                    "element_id": element_id, "label": подпись,
                    "reason": f"Статус «{STATUS_TITLES.get(row['current_status'], row['current_status'])}» — "
                              f"изделие уже поставлено на площадку",
                })
                continue
            ключ = (row["element_type"], row["mark"])
            if взято.get(ключ, 0) >= доступно.get(ключ, 0):
                пропущено.append({
                    "element_id": element_id, "label": подпись,
                    "reason": f"В новом контракте нет свободного количества по позиции "
                              f"«{row['element_type'] or '—'} / {row['mark'] or '—'}» "
                              f"(доступно {доступно.get(ключ, 0)})",
                })
                continue
            взято[ключ] = взято.get(ключ, 0) + 1

            conn.execute(
                "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
                (body.to_contract_id, element_id),
            )
            # Запись истории — ТЕМ ЖЕ статусом (выбор пользователя): смена
            # поставщика не двигает изделие по жизненному циклу, но обязана
            # быть в истории — иначе снимок контракта в последней записи
            # остался бы от прежнего поставщика. Момент — текущий, а не дата
            # документа: история отвечает «когда это произошло в системе», а
            # запись задним числом перестала бы быть последней и вернула бы
            # в силу прежний снимок.
            conn.execute(
                "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, "
                "comment, contract_id) VALUES (?, ?, ?, ?, ?, ?)",
                (element_id, row["current_status"], автор, user["id"], комментарий, body.to_contract_id),
            )
            conn.execute(
                "INSERT INTO supplier_change_items (doc_id, element_id, element_type, mark, status_at_move) "
                "VALUES (?, ?, ?, ?, ?)",
                (doc_id, element_id, row["element_type"], row["mark"], row["current_status"]),
            )
            перенесено.append(element_id)
            # Поэлементно в журнал (требование пользователя): «что именно
            # переехало» ищут в журнале по марке и типу, а не только в
            # документе.
            activity.log(
                "supplier_change", user_id=user["id"],
                user_name=impersonation.plain_name(автор),
                entity_type="element", entity_id=element_id,
                element_type=row["element_type"], subtype=row["subtype"], mark=row["mark"],
                old_value=старое_имя, new_value=новое_имя,
                details={"doc_id": doc_id, "number": номер, "doc_date": body.doc_date,
                         "status": row["current_status"]},
            )

        if not перенесено:
            # Документ без единой позиции — не документ. Откатываем целиком:
            # пустая шапка в списке выглядела бы как сделанный перенос.
            conn.rollback()
            причины = "; ".join(dict.fromkeys(p["reason"] for p in пропущено)) or "нет подходящих изделий"
            raise HTTPException(status_code=409, detail=f"Ни одно изделие не перенесено: {причины}")

        conn.commit()
        activity.log(
            "supplier_change_doc", user_id=user["id"],
            user_name=impersonation.plain_name(автор),
            entity_type="supplier_change", entity_id=doc_id,
            old_value=старое_имя, new_value=новое_имя,
            details={"number": номер, "doc_date": body.doc_date, "object_id": body.object_id,
                     "moved": len(перенесено), "skipped": len(пропущено)},
        )
        return {"id": doc_id, "number": номер, "moved": len(перенесено),
                "element_ids": перенесено, "skipped": пропущено}
    finally:
        conn.close()

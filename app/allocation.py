"""Распределение изделий одной позиции контракта — ОДНА серверная операция на всю выбранную пачку.

Зачем отдельный маршрут. Существующие операции не дают нужной семантики целиком: `PATCH /elements/bulk-status` меняет ОДИН статус для
всех строк и явно перезаписывает контракт присланным значением (устаревшее выделение затирает контракт, назначенный другим человеком),
а `PATCH /elements/{id}/contract` назначает контракт одному изделию и не работает с «Запланирован». Смешанную пачку (часть изделий
«Запланирован», часть в других статусах, все БЕЗ контракта) цепочкой этих запросов не сделать без потери атомарности.

Что делает. `POST /contracts/{contract_id}/allocations`: под ОДНОЙ блокировкой записи (`begin_write`) читает состояние, проверяет и пишет.
  * права на всю пачку (`status: write` по объектам изделий), контракт существует, не архивный и того же объекта;
  * все изделия — выбранного объекта, актуального чертежа и выбранной позиции (тип + марка);
  * СОСТОЯНИЕ НА МОМЕНТ СОХРАНЕНИЯ сверяется с тем, что видел клиент (`expected_status`) и с «контракта нет»: изменилось — 409 с перечнем
    расхождений и БЕЗ каких-либо изменений (пачка не сужается молча до подходящей части);
  * «Запланирован» → «Контрактация» и контракт — тем же `apply_status_change`, что и в V1 (история, дата, журнал, страж остатка);
    остальные статусы СОХРАНЯЮТСЯ, контракт назначается тем же `sync_element_contract` под тем же стражем остатка, что у
    `PATCH /elements/{id}/contract` (записи в историю статусов при этом нет — как у той операции);
  * остаток проверяет страж (`contract_guard`) под той же блокировкой: превышение — 409 и откат ВСЕЙ пачки;
  * повторная отправка того же запроса (потерянный ответ): если ВСЕ изделия уже на этом контракте — 200 `already_applied`, без повторной
    истории и без второго расхода остатка; если только часть — 409.
Ответ содержит то, что фактически сохранено: изделия и остаток позиции после операции.
События журнала уходят только после commit (`activity.defer_*`).
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity, contract_guard
from app.auth import audit_display_name, get_current_user
from app.contracts import _line_damaged, _line_fact, apply_status_change, enrich_element_row, sync_element_contract
from app.db import begin_write, get_connection

router = APIRouter(prefix="/contracts", tags=["allocation"])
state_router = APIRouter(prefix="/allocation-state", tags=["allocation"])

MAX_ITEMS = 500


class AllocationItem(BaseModel):
    element_id: int
    # Статус, который клиент видел при формировании пачки: если на сервере он уже другой — конфликт, а не молчаливая подгонка
    expected_status: str


class AllocationIn(BaseModel):
    object_id: int
    element_type: str
    mark: Optional[str] = None
    items: list[AllocationItem]


def _conflict(message: str, conflicts: list, status_code: int = 409):
    return HTTPException(status_code=status_code, detail={"message": message, "conflicts": conflicts})


def _position_state(conn, contract_id: int, element_type: str, mark: Optional[str]) -> dict:
    quantity = conn.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS n FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark IS ?",
        (contract_id, element_type, mark)).fetchone()["n"]
    fact = _line_fact(conn, contract_id, element_type, mark)
    damaged = _line_damaged(conn, contract_id, element_type)
    return {"element_type": element_type, "mark": mark, "quantity": quantity, "fact": fact, "damaged": damaged,
            "remaining": quantity - fact - damaged}


def _element_out(conn, element_id: int) -> dict:
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    d = enrich_element_row(conn, dict(row))
    keep = ("id", "current_status", "contract_id", "counterparty_code", "planned_delivery_date", "actual_delivery_date",
            "project_delivery_date", "project_smr_start_date")
    return {k: d.get(k) for k in keep}


@router.post("/{contract_id}/allocations")
def allocate(contract_id: int, body: AllocationIn, user=Depends(get_current_user)):
    ids = [i.element_id for i in body.items]
    if not ids:
        raise HTTPException(status_code=400, detail="Пустая пачка")
    if len(ids) > MAX_ITEMS:
        raise HTTPException(status_code=400, detail=f"В пачке не больше {MAX_ITEMS} изделий")
    if len(set(ids)) != len(ids):
        dups = sorted({i for i in ids if ids.count(i) > 1})
        raise _conflict("В пачке повторяются изделия — ничего не изменено", [{"element_id": i, "reason": "duplicate"} for i in dups], 400)

    conn = get_connection()
    events = activity.defer_begin()   # события уходят в журнал только после commit (app/activity.py)
    try:
        begin_write(conn)   # блокировка записи ДО чтения состояния, проверки остатка и записи (app/db.py)
        from app.main import _guard_elements   # отложенный импорт: main подключает этот роутер
        contract = conn.execute("SELECT id, is_archived FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        if contract is None:
            raise HTTPException(status_code=404, detail="Контракт не найден")
        if contract["is_archived"]:
            raise HTTPException(status_code=409, detail="Контракт архивный — распределять на него нельзя")
        c_obj = conn.execute(
            "SELECT a.object_id FROM contracts co JOIN specifications s ON s.id = co.specification_id "
            "JOIN agreements a ON a.id = s.agreement_id WHERE co.id = ?", (contract_id,)).fetchone()
        if c_obj is None or c_obj["object_id"] != body.object_id:
            raise HTTPException(status_code=400, detail="Контракт относится к другому объекту — распределять на него изделия этого объекта нельзя")

        q = ",".join("?" * len(ids))
        rows = {r["id"]: r for r in conn.execute(f"SELECT * FROM elements WHERE id IN ({q})", ids)}
        missing = [i for i in ids if i not in rows]
        if missing:
            raise _conflict("Изделий нет в базе — ничего не изменено", [{"element_id": i, "reason": "not_found"} for i in missing], 404)
        # Права — на ВСЮ пачку разом (по объектам изделий); отказ — целиком
        _guard_elements(conn, user, ids, "status", "write")

        want_key = contract_guard.line_key(body.element_type, body.mark)
        conflicts = []
        todo, done = [], []
        for item in body.items:
            e = rows[item.element_id]
            base = {"element_id": e["id"], "current_status": e["current_status"], "contract_id": e["contract_id"]}
            if e["object_id"] != body.object_id:
                conflicts.append({**base, "reason": "other_object"})
            elif not e["is_current"]:
                conflicts.append({**base, "reason": "not_current"})
            elif contract_guard.line_key(e["element_type"], e["mark"]) != want_key:
                conflicts.append({**base, "reason": "other_position"})
            elif e["contract_id"] == contract_id and e["current_status"] != "planned":
                done.append(e)
            elif e["contract_id"] is not None:
                conflicts.append({**base, "reason": "contract_assigned"})
            elif e["current_status"] != item.expected_status:
                conflicts.append({**base, "reason": "status_changed", "expected_status": item.expected_status})
            else:
                todo.append(e)
        if conflicts:
            raise _conflict("Состояние изделий изменилось или пачка не подходит — ничего не изменено. Обновите схему и выберите заново.", conflicts)
        if done and todo:
            raise _conflict("Часть изделий уже распределена на этот контракт, часть — нет — ничего не изменено. Обновите схему и выберите заново.",
                            [{"element_id": e["id"], "current_status": e["current_status"], "contract_id": e["contract_id"], "reason": "partly_applied"} for e in done + todo])
        if not todo:   # повторная отправка: всё уже сделано — ничего не пишем и остаток второй раз не тратим
            return {"contract_id": contract_id, "already_applied": True, "applied": [], "already": [_element_out(conn, e["id"]) for e in done],
                    "position": _position_state(conn, contract_id, body.element_type, body.mark)}

        author = audit_display_name(user)
        for e in todo:
            if e["current_status"] == "planned":
                # «Запланирован» → «Контрактация» + контракт: то же, что смена статуса в V1 (история, журнал, страж остатка)
                apply_status_change(conn, e["id"], "contracting", True, contract_id, None, None, author, user["id"])
            else:
                # статус сохраняется; контракт — под тем же стражем остатка, что у PATCH /elements/{id}/contract
                contract_guard.assert_link_allowed(conn, contract_id, e["element_type"], e["mark"], element_id=e["id"],
                                                   current_contract_id=None, current_status=e["current_status"])
                sync_element_contract(conn, e["id"], e["current_status"], explicit=True, value=contract_id)
                activity.log("element_contract_set", user=user, entity_type="element", entity_id=e["id"], element_type=e["element_type"],
                             mark=e["mark"], old_value="нет", new_value=str(contract_id))
        applied = [_element_out(conn, e["id"]) for e in todo]
        position = _position_state(conn, contract_id, body.element_type, body.mark)
        activity.log("contract_allocate", user=user, entity_type="contract", entity_id=contract_id, element_type=body.element_type, mark=body.mark,
                     new_value=f"{len(todo)} шт.", details={"object_id": body.object_id, "planned_to_contracting": sum(1 for e in todo if e["current_status"] == "planned"),
                                                              "status_kept": sum(1 for e in todo if e["current_status"] != "planned")})
        conn.commit()
        activity.defer_flush(events)
        return {"contract_id": contract_id, "already_applied": False, "applied": applied, "already": [], "position": position}
    finally:
        activity.defer_end(events)   # откат/исключение: несброшенные события отбрасываются
        conn.close()



@state_router.get("")
def allocation_state(ids: str = Query(..., description="Идентификаторы изделий через запятую (не больше MAX_ITEMS)"), user=Depends(get_current_user)):
    """Текущее состояние ВСЕЙ пачки изделий — для сверки после неопределённого исхода распределения (потерян ответ).

    Только чтение: статус и контракт каждого изделия ОДНИМ запросом (один снимок, а не цепочка отдельных чтений).
    Не отвечает на вопрос «чей запрос это сделал»: идентификатора операции сервер не хранит, поэтому по этому ответу
    клиент различает лишь текущее состояние изделий, а не подтверждённый результат конкретной операции.
    Права — как у чтения карточки изделия (`plan: read` по объектам изделий); несуществующие id возвращаются в `missing`.
    """
    try:
        wanted = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids: ожидаются целые числа через запятую")
    if not wanted:
        raise HTTPException(status_code=400, detail="Не указаны изделия")
    if len(wanted) > MAX_ITEMS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_ITEMS} изделий за запрос")
    wanted = list(dict.fromkeys(wanted))
    conn = get_connection()
    try:
        from app.main import _guard_elements
        _guard_elements(conn, user, wanted, "plan", "read")
        q = ",".join("?" * len(wanted))
        rows = {r["id"]: r for r in conn.execute(
            f"SELECT id, object_id, current_status, contract_id FROM elements WHERE id IN ({q})", wanted)}
        return {"items": [{"id": i, "object_id": rows[i]["object_id"], "current_status": rows[i]["current_status"], "contract_id": rows[i]["contract_id"]}
                          for i in wanted if i in rows],
                "missing": [i for i in wanted if i not in rows]}
    finally:
        conn.close()

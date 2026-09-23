"""Построчные групповые операции над изделиями для экрана схемы V2 (модель ЖБИ, АРМ прораба): плановые даты «изделие → дата» и смена статуса
с контрактом по СТРОКАМ (`область: lines`, продолжение `app/element_ops.py`).

Что заменяет. В V1 группа выделенных изделий правится таблицей «строка → значение»:
  * `PATCH /elements/bulk-planned-delivery-date` — у каждой строки своя плановая дата (дата или очистка). Маршрут пишет вслепую: не берёт
    блокировку записи, не сверяет прежнюю дату с тем, что видел человек, не проверяет формат;
  * `PATCH /elements/bulk-status` — новый статус и у КАЖДОЙ строки свой контракт (изменить, оставить, «без контракта»). Устаревший контракт в
    теле молча перезаписывает чужую правку, контракт архивный принимается, «без контракта» снимает привязку без предупреждения.
V2 эти маршруты не использует. Ниже — те же возможности (пользователь выбирает значение для каждой строки), но безопасно.

Общие правила (те же, что в `app/element_ops.py`):
  * ВСЕ писатели берут блокировку записи первым действием (`begin_write`); состояние читается, сверяется и пишется под одной блокировкой;
  * у каждой строки — ОЖИДАЕМОЕ состояние (что видел клиент); расхождение хотя бы у одной строки → 409 с перечнем и без частичных изменений;
  * режим `preview` выполняет ТУ ЖЕ операцию и откатывает: отдаёт последствия по фактическому результату; `apply` требует подтверждения
    увиденных чисел (`expect`), иначе 409 `consequences_changed`;
  * повтор того же запроса после потерянного ответа — 200 `already_applied` (запись и история не задваиваются); «часть сделана, часть нет» — 409;
  * права проверяются на ВСЮ пачку разом; события журнала уходят в очередь только после commit (`activity.defer_*`).

  * `POST /element-ops/planned-date-rows` — у каждой строки своя новая плановая дата (`planned_date`) или очистка (`null`) со сверкой прежней.
  * `POST /element-ops/status-rows` — смена статуса пачки или контракта при прежнем статусе, у каждой строки явно указан контракт ПОСЛЕ операции (`contract_id`: число — назначить или
    заменить, `null` — «без контракта», то же значение, что было, — оставить). Контракт меняется только там, где строка это ЯВНО просит; снятие и
    замена контракта показываются в последствиях и подтверждаются числом. Страж остатка `contract_guard` — тот же, что в V1, под той же блокировкой.
Схема БД не меняется. Распределение изделий по позиции контракта (`POST /contracts/{id}/allocations`) эти маршруты не заменяют и не дублируют.
"""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import activity
from app.auth import audit_display_name, get_current_user
from app.contracts import apply_status_change
from app.db import begin_write, get_connection
from app.element_dates import set_planned_delivery_date
from app.element_ops import MAX_ITEMS, _contract_name, _element_out, _norm_date, _norm_datetime, _problem
from app.models import Status

router = APIRouter(prefix="/element-ops", tags=["element-ops"])


def _check_pack(ids: list[int]) -> None:
    if not ids:
        raise _problem(400, "Пустая пачка")
    if len(ids) > MAX_ITEMS:
        raise _problem(400, f"В пачке не больше {MAX_ITEMS} изделий")
    if len(set(ids)) != len(ids):
        dups = sorted({i for i in ids if ids.count(i) > 1})
        raise _problem(400, "В пачке повторяются изделия — ничего не изменено", [{"element_id": i, "reason": "duplicate"} for i in dups])


# ------------------------------------------------------------------ плановые даты по строкам

class PlannedRowItem(BaseModel):
    element_id: int
    expected_planned_date: Optional[str] = None      # прежняя дата, которую видел клиент (None — не была задана)
    planned_date: Optional[str] = None               # новая дата этой строки; None — снять


class PlannedRowsExpect(BaseModel):
    set_new: int = 0          # у скольких изделий даты не было и она будет задана
    replaced: int = 0         # у скольких заданная дата будет заменена другой
    cleared: int = 0          # у скольких дата будет снята


class PlannedRowsIn(BaseModel):
    mode: Literal["preview", "apply"]
    object_id: int
    expect: Optional[PlannedRowsExpect] = None
    items: list[PlannedRowItem]


@router.post("/planned-date-rows")
def planned_date_rows(body: PlannedRowsIn, user=Depends(get_current_user)):
    ids = [i.element_id for i in body.items]
    _check_pack(ids)
    for item in body.items:
        # «Очистить» — явное значение null, а не пропущенное поле: молчаливо не подставляем ни то, ни другое
        if "planned_date" not in item.model_fields_set or "expected_planned_date" not in item.model_fields_set:
            raise _problem(400, "У каждой строки должны быть указаны и прежняя, и новая дата (null — не задана / снять)")
    if body.mode == "apply" and body.expect is None:
        raise _problem(400, "Для записи нужно подтверждение последствий (expect): сначала выполните предпросмотр")
    targets = {i.element_id: _norm_date(i.planned_date) for i in body.items}

    conn = get_connection()
    events = activity.defer_begin()   # события уходят в журнал только после commit (app/activity.py)
    try:
        begin_write(conn)   # блокировка записи ДО чтения состояния, проверок и записи (app/db.py)
        from app.main import _guard_elements   # отложенный импорт: main подключает этот роутер
        q = ",".join("?" * len(ids))
        rows = {r["id"]: r for r in conn.execute(f"SELECT * FROM elements WHERE id IN ({q})", ids)}
        missing = [i for i in ids if i not in rows]
        if missing:
            raise _problem(404, "Изделий нет в базе — ничего не изменено", [{"element_id": i, "reason": "not_found"} for i in missing])
        _guard_elements(conn, user, ids, "planned_date", "write")   # права на ВСЮ пачку разом: отказ целиком

        conflicts, todo, done = [], [], []
        for item in body.items:
            e = rows[item.element_id]
            target = targets[e["id"]]
            base = {"element_id": e["id"], "planned_delivery_date": e["planned_delivery_date"]}
            if e["object_id"] != body.object_id:
                conflicts.append({**base, "reason": "other_object"})
            elif item.expected_planned_date == target:
                conflicts.append({**base, "reason": "same_value"})
            elif e["planned_delivery_date"] == item.expected_planned_date:
                todo.append((e, target))
            elif e["planned_delivery_date"] == target:
                done.append((e, target))      # уже стоит нужная дата: повтор после потерянного ответа
            else:
                conflicts.append({**base, "reason": "state_changed", "expected_planned_date": item.expected_planned_date})
        if conflicts:
            raise _problem(409, "Плановая дата изделий изменилась или пачка не подходит — ничего не изменено. Обновите схему и выберите заново.", conflicts)
        if done and todo:
            raise _problem(409, "Часть изделий уже изменена этой операцией, часть — нет — ничего не изменено. Обновите схему и выберите заново.",
                           [{"element_id": e["id"], "reason": "partly_applied"} for e, _ in done + todo])
        if not todo:    # всё уже сделано (потерянный ответ): ничего не пишем, журнал не задваивается
            return {"mode": body.mode, "already_applied": True, "applied": [], "already": [_element_out(conn, e["id"]) for e, _ in done],
                    "consequences": {"set_new": 0, "replaced": 0, "cleared": 0}, "items": []}

        set_new = replaced = cleared = 0
        for e, target in todo:
            before = e["planned_delivery_date"]
            if before is None:
                set_new += 1
            elif target is None:
                cleared += 1
            else:
                replaced += 1
        consequences = {"set_new": set_new, "replaced": replaced, "cleared": cleared}
        if body.mode == "apply" and (body.expect.set_new != set_new or body.expect.replaced != replaced or body.expect.cleared != cleared):
            raise _problem(409, "Последствия операции изменились с момента предпросмотра — ничего не изменено. Проверьте их и подтвердите заново.",
                           [], kind="consequences_changed", consequences=consequences)
        if body.mode == "preview":
            # ничего не пишем: последствия посчитаны по тем же сверенным строкам, что и запись (транзакция не подтверждается)
            return {"mode": "preview", "already_applied": False, "applied": [], "already": [], "consequences": consequences,
                    "items": [{"id": e["id"], "mark": e["mark"], "element_type": e["element_type"], "before": e["planned_delivery_date"], "after": t} for e, t in todo]}
        for e, target in todo:
            set_planned_delivery_date(conn, e["id"], target, user)     # та же единая точка записи и журнала, что в V1
        applied = [_element_out(conn, e["id"]) for e, _ in todo]
        conn.commit()
        activity.defer_flush(events)
        return {"mode": "apply", "already_applied": False, "applied": applied, "already": [], "consequences": consequences}
    finally:
        activity.defer_end(events)   # откат/исключение/предпросмотр: несброшенные события отбрасываются
        conn.close()


# ------------------------------------------------------------------ смена статуса с контрактом по строкам

class StatusRowItem(BaseModel):
    element_id: int
    # Что клиент видел при формировании пачки. Не совпало с сервером — конфликт, а не молчаливая подгонка.
    expected_status: str
    expected_contract_id: Optional[int] = None    # None — контракта не было
    # Контракт этой строки ПОСЛЕ операции — обязателен и явен: число — назначить/заменить/оставить (равен ожидаемому), None — «без контракта».
    contract_id: Optional[int] = None


class StatusRowsExpect(BaseModel):
    release_contracts: int = 0    # у скольких изделий контракт будет снят (и явно, и возвратом на «Запланирован»)
    replace_contracts: int = 0    # у скольких контракт будет заменён другим
    without_contract: int = 0     # сколько изделий по итогу останутся без контракта (статус не «Запланирован»)


class StatusRowsIn(BaseModel):
    mode: Literal["preview", "apply"]
    object_id: int
    status: Status
    changed_at: Optional[str] = None
    comment: Optional[str] = Field(default=None, max_length=500)
    expect: Optional[StatusRowsExpect] = None
    items: list[StatusRowItem]


def _contract_brief(conn, contract_id: int) -> Optional[dict]:
    """Контракт: архивный ли и какого объекта (объект выводится по цепочке контракт → спецификация → договор)."""
    r = conn.execute(
        "SELECT co.is_archived, a.object_id FROM contracts co JOIN specifications s ON s.id = co.specification_id "
        "JOIN agreements a ON a.id = s.agreement_id WHERE co.id = ?", (contract_id,)).fetchone()
    return None if r is None else {"archived": bool(r["is_archived"]), "object_id": r["object_id"]}


@router.post("/status-rows")
def status_rows(body: StatusRowsIn, user=Depends(get_current_user)):
    ids = [i.element_id for i in body.items]
    _check_pack(ids)
    target = body.status.value
    for item in body.items:
        if "contract_id" not in item.model_fields_set:
            raise _problem(400, "У каждой строки контракт указывается явно (число или null — «без контракта»); молчаливого «оставить» нет")
        if target == "planned" and item.contract_id is not None:
            raise _problem(400, "Для статуса «Запланирован» контракт назначить нельзя — у такого изделия контракта не бывает")
    if body.mode == "apply" and body.expect is None:
        raise _problem(400, "Для записи нужно подтверждение последствий (expect): сначала выполните предпросмотр")
    changed_at = _norm_datetime(body.changed_at)
    comment = (body.comment or "").strip() or None

    def after_contract(item: StatusRowItem):
        """Контракт изделия ПОСЛЕ операции: выбранный в строке (для «Запланирован» — никакого)."""
        return None if target == "planned" else item.contract_id

    def releases(item: StatusRowItem) -> bool:
        """Строка освобождает место на контракте (снимает или заменяет его): такие строки идут первыми, чтобы страж остатка видел освободившееся место."""
        return item.expected_contract_id is not None and after_contract(item) != item.expected_contract_id

    conn = get_connection()
    events = activity.defer_begin()   # события уходят в журнал только после commit (app/activity.py)
    try:
        begin_write(conn)   # блокировка записи ДО чтения состояния, проверок и записи (app/db.py)
        from app.main import _guard_elements
        q = ",".join("?" * len(ids))
        rows = {r["id"]: r for r in conn.execute(f"SELECT * FROM elements WHERE id IN ({q})", ids)}
        missing = [i for i in ids if i not in rows]
        if missing:
            raise _problem(404, "Изделий нет в базе — ничего не изменено", [{"element_id": i, "reason": "not_found"} for i in missing])
        _guard_elements(conn, user, ids, "status", "write")   # права на ВСЮ пачку разом: отказ целиком

        # Контракты, которые строки НАЗНАЧАЮТ или ЗАМЕНЯЮТ (оставляемый прежний не проверяется: архивный контракт уже стоит у изделия)
        for cid in sorted({i.contract_id for i in body.items if i.contract_id is not None and target != "planned" and i.contract_id != i.expected_contract_id}):
            brief = _contract_brief(conn, cid)
            if brief is None:
                raise _problem(404, f"Контракт №{cid} не найден — ничего не изменено")
            if brief["archived"]:
                raise _problem(409, f"Контракт «{_contract_name(conn, cid)}» архивный — назначать его нельзя. Ничего не изменено.")
            if brief["object_id"] != body.object_id:
                raise _problem(400, f"Контракт «{_contract_name(conn, cid)}» относится к другому объекту — назначить его нельзя. Ничего не изменено.")

        conflicts, todo, done = [], [], []
        for item in body.items:
            e = rows[item.element_id]
            base = {"element_id": e["id"], "current_status": e["current_status"], "contract_id": e["contract_id"]}
            if e["object_id"] != body.object_id:
                conflicts.append({**base, "reason": "other_object"})
            elif item.expected_status == target and item.expected_contract_id == after_contract(item):
                conflicts.append({**base, "reason": "same_status"})
            elif e["current_status"] == item.expected_status and e["contract_id"] == item.expected_contract_id:
                todo.append(item)
            elif e["current_status"] == target and e["contract_id"] == after_contract(item):
                done.append(item)    # уже в конечном состоянии: повторная отправка после потерянного ответа
            else:
                conflicts.append({**base, "reason": "state_changed", "expected_status": item.expected_status,
                                  "expected_contract_id": item.expected_contract_id})
        if conflicts:
            raise _problem(409, "Состояние изделий изменилось или пачка не подходит — ничего не изменено. Обновите схему и выберите заново.", conflicts)
        if done and todo:
            raise _problem(409, "Часть изделий уже изменена этой операцией, часть — нет — ничего не изменено. Обновите схему и выберите заново.",
                           [{"element_id": i.element_id, "reason": "partly_applied"} for i in done + todo])
        if not todo:    # всё уже сделано (потерянный ответ): ничего не пишем, история не задваивается
            return {"mode": body.mode, "already_applied": True, "applied": [], "already": [_element_out(conn, i.element_id) for i in done],
                    "consequences": {"release_contracts": 0, "replace_contracts": 0, "without_contract": 0, "actual_date_cleared": 0, "assigned": 0,
                                     "effective_differs": 0, "released_by_contract": [], "replaced": [], "assigned_by_contract": [], "warnings": []},
                    "problems": []}

        author = audit_display_name(user)
        problems, results = [], []
        for item in sorted(todo, key=lambda it: 0 if releases(it) else 1):    # sorted устойчива: внутри групп порядок пачки сохраняется
            e = rows[item.element_id]
            try:
                data = apply_status_change(conn, e["id"], target, True, after_contract(item), changed_at, comment, author, user["id"])
            except HTTPException as exc:    # страж остатка/позиции: проверка идёт ДО записи изделия, состояние остальных цело
                problems.append({"element_id": e["id"], "mark": e["mark"], "element_type": e["element_type"], "reason": "contract_guard",
                                 "message": exc.detail if isinstance(exc.detail, str) else str(exc.detail)})
                continue
            results.append((e, data))

        # последствия — по фактическому результату той же операции
        released, replaced, without_contract, assigned, actual_cleared, differs, warnings = 0, 0, 0, 0, 0, 0, []
        released_by, assigned_by, replaced_by = {}, {}, {}
        for e, data in results:
            before_c, after_c = e["contract_id"], data["contract_id"]
            if before_c is not None and after_c is None:
                released += 1
                released_by[before_c] = released_by.get(before_c, 0) + 1
            elif before_c is not None and after_c != before_c:
                replaced += 1
                replaced_by[(before_c, after_c)] = replaced_by.get((before_c, after_c), 0) + 1
            if before_c is None and after_c is not None:
                assigned += 1
                assigned_by[after_c] = assigned_by.get(after_c, 0) + 1
            if target != "planned" and after_c is None:
                without_contract += 1
            if e["actual_delivery_date"] is not None and data.get("actual_delivery_date") is None:
                actual_cleared += 1
            if data["current_status"] != target:
                differs += 1
            if data.get("contract_warning"):
                warnings.append({"element_id": e["id"], **{k: data["contract_warning"].get(k) for k in ("contract_name", "quantity", "fact", "damaged")}})
        consequences = {
            "release_contracts": released, "replace_contracts": replaced, "without_contract": without_contract, "assigned": assigned,
            "actual_date_cleared": actual_cleared, "effective_differs": differs,
            "released_by_contract": [{"contract_id": cid, "name": _contract_name(conn, cid), "count": n} for cid, n in sorted(released_by.items())],
            "replaced": [{"from_id": a, "from_name": _contract_name(conn, a), "to_id": b, "to_name": _contract_name(conn, b), "count": n}
                         for (a, b), n in sorted(replaced_by.items())],
            "assigned_by_contract": [{"contract_id": cid, "name": _contract_name(conn, cid), "count": n} for cid, n in sorted(assigned_by.items())],
            "warnings": warnings[:20],
        }
        if body.mode == "preview":
            # ничего не пишем: транзакция не подтверждается и откатывается при закрытии соединения (журнал отбрасывается в defer_end)
            return {"mode": "preview", "already_applied": False, "applied": [], "already": [], "consequences": consequences, "problems": problems,
                    "items": [{"id": e["id"], "mark": e["mark"], "element_type": e["element_type"], "status_before": e["current_status"],
                               "contract_before": e["contract_id"], "status_after": d["current_status"], "contract_after": d["contract_id"]}
                              for e, d in results][:MAX_ITEMS]}
        if problems:
            raise _problem(409, "Контракт не позволяет записать пачку — ничего не изменено", problems, kind="contract_guard")
        x = body.expect
        if x.release_contracts != released or x.replace_contracts != replaced or x.without_contract != without_contract:
            raise _problem(409, "Последствия операции изменились с момента предпросмотра — ничего не изменено. Проверьте их и подтвердите заново.",
                           [], kind="consequences_changed", consequences=consequences)
        applied = [_element_out(conn, e["id"]) for e, _ in results]
        conn.commit()
        activity.defer_flush(events)
        return {"mode": "apply", "already_applied": False, "applied": applied, "already": [], "consequences": consequences, "problems": []}
    finally:
        activity.defer_end(events)   # откат/исключение/предпросмотр: несброшенные события отбрасываются
        conn.close()

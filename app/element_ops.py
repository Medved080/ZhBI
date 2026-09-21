"""Безопасные пакетные и точечные операции над изделиями для экрана схемы V2 (модель ЖБИ, АРМ прораба).

Зачем отдельные маршруты. Существующие операции V1 не годятся для пачки, отправленной с экрана, который мог устареть:
  * `PATCH /elements/bulk-status` в КАЖДОЙ строке принимает `contract_id` и применяет его явно: устаревшее значение молча
    перезаписывает контракт, назначенный другим человеком, а `null` снимает его. Безопасной пачки «только статус» он не даёт;
  * `PATCH /elements/bulk-planned-delivery-date` перезаписывает дату, не сверяя её с тем, что видел человек, не проверяет формат
    и не берёт блокировку записи;
  * `PATCH /elements/{id}/contract` ставит/снимает контракт, не сверяя его с тем, что видел клиент.

Что делают эти маршруты. Все — под ОДНОЙ блокировкой записи (`begin_write`, первым действием): состояние читается, сверяется с ожидаемым
клиентом и пишется под одной блокировкой. Права проверяются на ВСЮ пачку разом (отказ целиком). События журнала уходят в очередь только
после commit (`activity.defer_*`): откат ничего в журнале не оставляет. Схема БД не меняется.

  * `POST /element-ops/status-batch` — смена статуса пачки. КОНТРАКТ СОХРАНЯЕТСЯ: клиент присылает только ожидаемое состояние
    (`expected_status`, `expected_contract_id`), а не контракты «для записи». Контракт меняется лишь там, где это решают бизнес-правила V1 —
    инвариант «Запланирован ⇒ контракта нет» (`sync_element_contract`, возврат на «Запланирован» снимает контракт и фактическую дату поставки) —
    или явным `assign_contract_id` для изделий, у которых контракта сейчас НЕТ (страж остатка `contract_guard` — тот же, что в V1).
    Режим `preview` ничего не пишет: выполняет операцию ТЕМ ЖЕ кодом и откатывает, отдавая последствия (сколько контрактов снимется, у каких
    изделий, на какие контракты, какие проблемы страж найдёт). Режим `apply` требует подтверждения увиденных последствий (`expect`): если
    они изменились (кто-то успел изменить состояние) — 409 и ничего не записано. Расхождение состояния — 409 с перечнем и без частичных
    изменений; повтор того же запроса (потерянный ответ) — 200 `already_applied`, история не задваивается.
  * `POST /element-ops/planned-date-batch` — плановая дата поставки пачки: одна дата (или снятие) на все изделия, сверка ожидаемой прежней даты.
  * `POST /element-ops/contract` — назначить/сменить/снять контракт ОДНОГО изделия без смены статуса, со сверкой ожидаемого состояния.
  * `GET /element-ops/state?ids=` — текущее состояние пачки одним запросом (сверка после потерянного ответа; операции не подтверждает).
"""

import re
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import activity, contract_guard
from app.auth import audit_display_name, get_current_user
from app.contracts import (_specification_chain, apply_status_change, build_contract_name, enrich_element_row,
                           sync_element_contract)
from app.db import begin_write, get_connection
from app.element_dates import set_planned_delivery_date
from app.models import Status

router = APIRouter(prefix="/element-ops", tags=["element-ops"])

MAX_ITEMS = 2000
_DT_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$")


def _problem(status_code: int, message: str, conflicts: Optional[list] = None, **extra):
    return HTTPException(status_code=status_code, detail={"message": message, "conflicts": conflicts or [], **extra})


def _norm_datetime(raw: Optional[str]) -> Optional[str]:
    """Момент из <input type=datetime-local> → «ГГГГ-ММ-ДД ЧЧ:ММ:СС» (так он лежит в status_history). Мусор — 400: строки сравниваются как текст."""
    if raw is None or not str(raw).strip():
        return None
    m = _DT_RE.match(str(raw).strip())
    if not m:
        raise _problem(400, "Дата и время указаны неверно (нужно ГГГГ-ММ-ДД ЧЧ:ММ)")
    y, mo, d, h, mi, s = m.groups()
    try:
        date(int(y), int(mo), int(d))
    except ValueError:
        raise _problem(400, "Такой даты нет в календаре")
    if int(h) > 23 or int(mi) > 59 or int(s or 0) > 59:
        raise _problem(400, "Время указано неверно")
    return f"{y}-{mo}-{d} {h}:{mi}:{s or '00'}"


def _norm_date(raw: Optional[str]) -> Optional[str]:
    if raw is None or not str(raw).strip():
        return None
    text = str(raw).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if not m:
        raise _problem(400, "Дата указана неверно (нужно ГГГГ-ММ-ДД)")
    try:
        date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        raise _problem(400, "Такой даты нет в календаре")
    return text


def _contract_name(conn, contract_id: Optional[int]) -> Optional[str]:
    if contract_id is None:
        return None
    row = conn.execute("SELECT specification_id, theme FROM contracts WHERE id = ?", (contract_id,)).fetchone()
    if row is None:
        return f"№{contract_id}"
    chain = _specification_chain(conn, row["specification_id"])
    if not chain:
        return f"№{contract_id}"
    return build_contract_name(chain["counterparty_short_name"], chain["agreement_number"], chain["agreement_date"],
                               chain["specification_number"], chain["specification_date"], row["theme"])


def _element_out(conn, element_id: int) -> dict:
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    d = enrich_element_row(conn, dict(row))
    keep = ("id", "current_status", "contract_id", "counterparty_code", "planned_delivery_date", "actual_delivery_date",
            "project_delivery_date", "project_smr_start_date", "comment")
    return {k: d.get(k) for k in keep}


def _position_state(conn, contract_id: int, element_type: str, mark: Optional[str]) -> dict:
    from app.contracts import _line_damaged, _line_fact
    quantity = conn.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS n FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark IS ?",
        (contract_id, element_type, mark)).fetchone()["n"]
    fact = _line_fact(conn, contract_id, element_type, mark)
    damaged = _line_damaged(conn, contract_id, element_type)
    return {"element_type": element_type, "mark": mark, "quantity": quantity, "fact": fact, "damaged": damaged,
            "remaining": quantity - fact - damaged}


# ------------------------------------------------------------------ смена статуса пачки

class StatusItem(BaseModel):
    element_id: int
    # Что клиент видел при формировании пачки. Не совпало с сервером — конфликт, а не молчаливая подгонка.
    expected_status: str
    expected_contract_id: Optional[int] = None    # None — контракта не было


class Expect(BaseModel):
    release_contracts: int = 0       # у скольких изделий контракт будет снят
    without_contract: int = 0        # сколько изделий уйдёт с «Запланирован» и останется без контракта


class StatusBatchIn(BaseModel):
    mode: Literal["preview", "apply"]
    object_id: int
    status: Status
    changed_at: Optional[str] = None
    comment: Optional[str] = Field(default=None, max_length=500)
    # Контракт для изделий, у которых его СЕЙЧАС нет (только они; чужие контракты не трогаются)
    assign_contract_id: Optional[int] = None
    expect: Optional[Expect] = None
    items: list[StatusItem]


@router.post("/status-batch")
def status_batch(body: StatusBatchIn, user=Depends(get_current_user)):
    ids = [i.element_id for i in body.items]
    if not ids:
        raise _problem(400, "Пустая пачка")
    if len(ids) > MAX_ITEMS:
        raise _problem(400, f"В пачке не больше {MAX_ITEMS} изделий")
    if len(set(ids)) != len(ids):
        dups = sorted({i for i in ids if ids.count(i) > 1})
        raise _problem(400, "В пачке повторяются изделия — ничего не изменено", [{"element_id": i, "reason": "duplicate"} for i in dups])
    if body.mode == "apply" and body.expect is None:
        raise _problem(400, "Для записи нужно подтверждение последствий (expect): сначала выполните предпросмотр")
    changed_at = _norm_datetime(body.changed_at)
    comment = (body.comment or "").strip() or None
    target = body.status.value

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
        _guard_elements(conn, user, ids, "status", "write")   # права на ВСЮ пачку разом: отказ целиком

        assign = body.assign_contract_id
        if assign is not None:
            c = conn.execute("SELECT id, is_archived FROM contracts WHERE id = ?", (assign,)).fetchone()
            if c is None:
                raise _problem(404, "Контракт не найден")
            if c["is_archived"]:
                raise _problem(409, "Контракт архивный — назначать его нельзя")
            if target == "planned":
                raise _problem(400, "Для статуса «Запланирован» контракт назначить нельзя — у такого изделия контракта не бывает")

        def after_contract(item: StatusItem):
            """Контракт изделия ПОСЛЕ операции (по бизнес-правилам V1)."""
            if target == "planned":
                return None
            if item.expected_contract_id is not None:
                return item.expected_contract_id    # сохраняется
            return assign                            # None, если назначения нет

        conflicts, todo, done = [], [], []
        for item in body.items:
            e = rows[item.element_id]
            base = {"element_id": e["id"], "current_status": e["current_status"], "contract_id": e["contract_id"]}
            if e["object_id"] != body.object_id:
                conflicts.append({**base, "reason": "other_object"})
            elif item.expected_status == target:
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
                    "consequences": {"release_contracts": 0, "without_contract": 0, "actual_date_cleared": 0, "assigned": 0, "released_by_contract": [],
                                     "effective_differs": 0}, "problems": []}

        author = audit_display_name(user)
        problems, results = [], []
        for item in todo:
            e = rows[item.element_id]
            explicit = assign is not None and target != "planned" and item.expected_contract_id is None
            try:
                data = apply_status_change(conn, e["id"], target, explicit, assign if explicit else None, changed_at, comment, author, user["id"])
            except HTTPException as exc:    # страж остатка/позиции: проверка идёт ДО записи изделия, состояние остальных цело
                problems.append({"element_id": e["id"], "mark": e["mark"], "element_type": e["element_type"], "reason": "contract_guard",
                                 "message": exc.detail if isinstance(exc.detail, str) else str(exc.detail)})
                continue
            results.append((e, data))

        # последствия — по фактическому результату той же операции
        released, released_by, assigned, without_contract, actual_cleared, differs, warnings = 0, {}, 0, 0, 0, 0, []
        for e, data in results:
            before_c, after_c = e["contract_id"], data["contract_id"]
            if before_c is not None and after_c is None:
                released += 1
                released_by[before_c] = released_by.get(before_c, 0) + 1
            if before_c is None and after_c is not None:
                assigned += 1
            if e["current_status"] == "planned" and target != "planned" and after_c is None:
                without_contract += 1
            if e["actual_delivery_date"] is not None and data.get("actual_delivery_date") is None:
                actual_cleared += 1
            if data["current_status"] != target:
                differs += 1
            if data.get("contract_warning"):
                warnings.append({"element_id": e["id"], **{k: data["contract_warning"].get(k) for k in ("contract_name", "quantity", "fact", "damaged")}})
        consequences = {
            "release_contracts": released, "without_contract": without_contract, "actual_date_cleared": actual_cleared, "assigned": assigned,
            "effective_differs": differs,
            "released_by_contract": [{"contract_id": cid, "name": _contract_name(conn, cid), "count": n} for cid, n in sorted(released_by.items())],
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
        if body.expect.release_contracts != released or body.expect.without_contract != without_contract:
            raise _problem(409, "Последствия операции изменились с момента предпросмотра — ничего не изменено. Проверьте их и подтвердите заново.",
                           [], kind="consequences_changed", consequences=consequences)
        applied = [_element_out(conn, e["id"]) for e, _ in results]
        conn.commit()
        activity.defer_flush(events)
        return {"mode": "apply", "already_applied": False, "applied": applied, "already": [], "consequences": consequences, "problems": []}
    finally:
        activity.defer_end(events)   # откат/исключение/предпросмотр: несброшенные события отбрасываются
        conn.close()


# ------------------------------------------------------------------ плановая дата поставки пачки

class PlannedItem(BaseModel):
    element_id: int
    expected_planned_date: Optional[str] = None    # прежняя дата, которую видел клиент (None — не была задана)


class PlannedBatchIn(BaseModel):
    object_id: int
    planned_date: Optional[str] = None             # новая дата; None — снять
    items: list[PlannedItem]


@router.post("/planned-date-batch")
def planned_date_batch(body: PlannedBatchIn, user=Depends(get_current_user)):
    ids = [i.element_id for i in body.items]
    if not ids:
        raise _problem(400, "Пустая пачка")
    if len(ids) > MAX_ITEMS:
        raise _problem(400, f"В пачке не больше {MAX_ITEMS} изделий")
    if len(set(ids)) != len(ids):
        raise _problem(400, "В пачке повторяются изделия — ничего не изменено",
                       [{"element_id": i, "reason": "duplicate"} for i in sorted({i for i in ids if ids.count(i) > 1})])
    target = _norm_date(body.planned_date)

    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        from app.main import _guard_elements
        q = ",".join("?" * len(ids))
        rows = {r["id"]: r for r in conn.execute(f"SELECT * FROM elements WHERE id IN ({q})", ids)}
        missing = [i for i in ids if i not in rows]
        if missing:
            raise _problem(404, "Изделий нет в базе — ничего не изменено", [{"element_id": i, "reason": "not_found"} for i in missing])
        _guard_elements(conn, user, ids, "planned_date", "write")

        conflicts, todo, done = [], [], []
        for item in body.items:
            e = rows[item.element_id]
            base = {"element_id": e["id"], "planned_delivery_date": e["planned_delivery_date"]}
            if e["object_id"] != body.object_id:
                conflicts.append({**base, "reason": "other_object"})
            elif item.expected_planned_date == target:
                conflicts.append({**base, "reason": "same_value"})
            elif e["planned_delivery_date"] == item.expected_planned_date:
                todo.append(e)
            elif e["planned_delivery_date"] == target:
                done.append(e)      # уже стоит нужная дата: повтор после потерянного ответа
            else:
                conflicts.append({**base, "reason": "state_changed", "expected_planned_date": item.expected_planned_date})
        if conflicts:
            raise _problem(409, "Плановая дата изделий изменилась или пачка не подходит — ничего не изменено. Обновите схему и выберите заново.", conflicts)
        if done and todo:
            raise _problem(409, "Часть изделий уже изменена этой операцией, часть — нет — ничего не изменено. Обновите схему и выберите заново.",
                           [{"element_id": e["id"], "reason": "partly_applied"} for e in done + todo])
        if not todo:
            return {"already_applied": True, "applied": [], "already": [_element_out(conn, e["id"]) for e in done]}
        for e in todo:
            set_planned_delivery_date(conn, e["id"], target, user)     # та же единая точка записи и журнала, что в V1
        applied = [_element_out(conn, e["id"]) for e in todo]
        conn.commit()
        activity.defer_flush(events)
        return {"already_applied": False, "applied": applied, "already": []}
    finally:
        activity.defer_end(events)
        conn.close()


# ------------------------------------------------------------------ контракт одного изделия

class ContractSetIn(BaseModel):
    element_id: int
    expected_status: str
    expected_contract_id: Optional[int] = None
    contract_id: Optional[int] = None       # None — снять контракт


@router.post("/contract")
def contract_set(body: ContractSetIn, user=Depends(get_current_user)):
    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        from app.main import _guard_elements
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (body.element_id,)).fetchone()
        if row is None:
            raise _problem(404, "Изделие не найдено")
        _guard_elements(conn, user, [body.element_id], "status", "write")
        matches = row["current_status"] == body.expected_status and row["contract_id"] == body.expected_contract_id
        if not matches:
            if row["current_status"] == body.expected_status and row["contract_id"] == body.contract_id:
                # уже стоит нужный контракт: повтор после потерянного ответа
                return {"already_applied": True, "element": _element_out(conn, row["id"]), "position": None}
            raise _problem(409, "Изделие изменилось после открытия формы — ничего не изменено. Обновите данные и повторите.",
                           [{"element_id": row["id"], "reason": "state_changed", "current_status": row["current_status"], "contract_id": row["contract_id"]}])
        if row["current_status"] == "planned":
            raise _problem(409, "У изделия в статусе «Запланирован» контракта быть не может — он проставляется при переводе в следующий статус")
        if body.contract_id == row["contract_id"]:
            raise _problem(400, "Этот контракт уже назначен — менять нечего")
        if body.contract_id is not None:
            c = conn.execute("SELECT id, is_archived FROM contracts WHERE id = ?", (body.contract_id,)).fetchone()
            if c is None:
                raise _problem(404, "Контракт не найден")
            if c["is_archived"]:
                raise _problem(409, "Контракт архивный — назначать его нельзя")
            c_obj = conn.execute(
                "SELECT a.object_id FROM contracts co JOIN specifications s ON s.id = co.specification_id "
                "JOIN agreements a ON a.id = s.agreement_id WHERE co.id = ?", (body.contract_id,)).fetchone()
            if c_obj is None or c_obj["object_id"] != row["object_id"]:
                raise _problem(400, "Контракт относится к другому объекту — назначить его этому изделию нельзя")
            try:
                contract_guard.assert_link_allowed(conn, body.contract_id, row["element_type"], row["mark"], element_id=row["id"],
                                                   current_contract_id=row["contract_id"], current_status=row["current_status"])
            except HTTPException as exc:
                raise _problem(409, exc.detail if isinstance(exc.detail, str) else "Контракт не подходит", kind="contract_guard")
        sync_element_contract(conn, row["id"], row["current_status"], explicit=True, value=body.contract_id)
        activity.log("element_contract_set", user=user, entity_type="element", entity_id=row["id"], element_type=row["element_type"],
                     mark=row["mark"], old_value=str(row["contract_id"] or "нет"), new_value=str(body.contract_id or "нет"))
        out = _element_out(conn, row["id"])
        position = _position_state(conn, body.contract_id, row["element_type"], row["mark"]) if body.contract_id is not None else None
        conn.commit()
        activity.defer_flush(events)
        return {"already_applied": False, "element": out, "position": position}
    finally:
        activity.defer_end(events)
        conn.close()


# ------------------------------------------------------------------ текущее состояние пачки (сверка после потерянного ответа)

@router.get("/state")
def element_state(ids: str = Query(..., description="Идентификаторы изделий через запятую (не больше MAX_ITEMS)"), user=Depends(get_current_user)):
    """Текущее состояние ВСЕЙ пачки изделий ОДНИМ запросом — для сверки после неопределённого исхода записи (потерян ответ, обрыв связи).

    Только чтение. Отвечает на вопрос «каково состояние изделий сейчас», а не «выполнил ли это МОЙ запрос»: идентификатора операции сервер не хранит,
    поэтому совпадение состояния клиент может назвать лишь текущим состоянием, но не подтверждённым результатом конкретной операции.
    Права — как у чтения карточки изделия (`plan: read` по объектам изделий); несуществующие идентификаторы возвращаются в `missing`."""
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
            f"SELECT id, object_id, current_status, contract_id, planned_delivery_date, actual_delivery_date, comment FROM elements WHERE id IN ({q})", wanted)}
        return {"items": [{"id": i, "object_id": rows[i]["object_id"], "current_status": rows[i]["current_status"], "contract_id": rows[i]["contract_id"],
                           "planned_delivery_date": rows[i]["planned_delivery_date"], "actual_delivery_date": rows[i]["actual_delivery_date"], "comment": rows[i]["comment"]}
                          for i in wanted if i in rows],
                "missing": [i for i in wanted if i not in rows]}
    finally:
        conn.close()

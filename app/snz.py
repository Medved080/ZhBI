"""СНЗ: справочники, расчёт, выдача, версии исправлений, реестр и факт."""
import json
import hashlib
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app import activity
from app.access import assert_object_feature, has_feature
from app.auth import audit_display_name, get_current_user
from app.db import begin_write, get_connection, touch_elements
from app.snz_core import build_schedule, default_state, operation_steps, suggest_card
from app.snz_policy import planning_state, order_items, step_fact
from app.snz_ordering import normalize_montage

router = APIRouter(prefix="/objects/{object_id}/snz", tags=["snz"])
KEY = r"^[a-zA-Z0-9_-]{1,64}$"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Crew(Strict):
    id: str = Field(pattern=KEY)
    name: str = Field(min_length=1, max_length=120)
    foreman: str = Field(default="", max_length=120)
    kind: Literal["preparation", "installation"]


class Operation(Strict):
    id: str = Field(pattern=KEY)
    name: str = Field(min_length=1, max_length=120)
    team: str = Field(min_length=1, max_length=80)
    scope: Literal["preparation", "element", "group"]


class Team(Strict):
    id: str = Field(pattern=KEY)
    name: str = Field(min_length=1, max_length=80)


class Step(Strict):
    operation_id: str = Field(pattern=KEY)
    minutes: int | None = Field(default=None, ge=1, le=43200)
    wait_after: int = Field(default=0, ge=0, le=43200)
    source_note: str = Field(default="", max_length=4000)


class Card(Strict):
    id: str = Field(pattern=KEY)
    name: str = Field(min_length=1, max_length=160)
    element_type: str = Field(default="", max_length=120)
    subtype: str = Field(default="", max_length=120)
    elevation_mm: int | None = None
    axis_direction: Literal["", "letter", "numeric"] = ""
    source_note: str = Field(default="", max_length=4000)
    steps: list[Step] = Field(min_length=1, max_length=100)


class Assignment(Strict):
    element_id: int = Field(gt=0)
    crew_id: str = Field(pattern=KEY)
    card_id: str = Field(pattern=KEY)
    date: date
    shift: Literal["day", "night"]
    priority: int | None = Field(default=None, ge=1, le=1000000)
    prep_priority: int | None = Field(default=None, ge=1, le=1000000)


class Group(Strict):
    id: str = Field(pattern=KEY)
    name: str = Field(min_length=1, max_length=120)
    element_ids: list[int] = Field(min_length=3, max_length=4)
    card_id: str | None = Field(default=None, pattern=KEY)


class StateIn(Strict):
    revision: int = Field(ge=0)
    catalog_seed: str = Field(default="", max_length=100)
    crews: list[Crew] = Field(min_length=2, max_length=100)
    operations: list[Operation] = Field(min_length=1, max_length=100)
    teams: list[Team] = Field(min_length=1, max_length=100)
    cards: list[Card] = Field(min_length=1, max_length=200)
    assignments: list[Assignment] = Field(max_length=20000)
    groups: list[Group] = Field(max_length=5000)


class PlanIn(Strict):
    revision: int = Field(ge=0)
    date: date
    shift: Literal["day", "night"]
    crew_id: str = Field(pattern=KEY)


class IssueIn(PlanIn):
    request_id: str = Field(pattern=KEY)
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class EditPreviewIn(Strict):
    revision: int = Field(ge=0)
    order_revision: int = Field(ge=1)
    exclude_element_ids: list[int] = Field(min_length=1, max_length=20000)
    reason: str = Field(min_length=1, max_length=1000)


class EditOrderIn(EditPreviewIn):
    request_id: str = Field(pattern=KEY)
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class FactIn(Strict):
    revision: int = Field(ge=0)
    task_key: str = Field(min_length=1, max_length=160)


class DeleteOrderIn(Strict):
    revision: int = Field(ge=0)
    order_revision: int = Field(ge=1)
    request_id: str = Field(pattern=KEY)


def _load(conn, object_id):
    row = conn.execute("SELECT revision,data_json FROM snz_state WHERE object_id=?", (object_id,)).fetchone()
    return (planning_state(json.loads(row["data_json"])), row["revision"]) if row else (default_state(), 0)


def _write(conn, object_id, state, revision):
    conn.execute("INSERT INTO snz_state(object_id,revision,data_json) VALUES (?,?,?) "
                 "ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
                 (object_id, revision + 1, json.dumps(state, ensure_ascii=False)))


def _version(actual, expected):
    if actual != expected:
        raise HTTPException(409, "СНЗ изменён другим пользователем. Обновите данные перед сохранением.")


def _elements(conn, object_id):
    return [dict(r) for r in conn.execute(
        "SELECT e.id,e.element_uid,e.mark,e.element_type,e.subtype,e.floor,e.elevation_mm,e.address,"
        "e.axis_number,e.axis_letter,e.x,e.y,e.outline_json,e.source_file,e.current_status,e.is_current,e.planned_installation_date,"
        "z.name AS zakhvatka,c.name AS crane,s.name AS stance,cp.short_name AS counterparty "
        "FROM elements e LEFT JOIN zones z ON z.id=e.zone_zakhvatka_id "
        "LEFT JOIN zones c ON c.id=e.zone_crane_id LEFT JOIN zones s ON s.id=e.zone_stance_id "
        "LEFT JOIN contracts ct ON ct.id=e.contract_id LEFT JOIN specifications sp ON sp.id=ct.specification_id "
        "LEFT JOIN agreements ag ON ag.id=sp.agreement_id LEFT JOIN counterparties cp ON cp.id=ag.counterparty_id "
        "WHERE e.object_id=? ORDER BY e.id", (object_id,))]


def _history(conn, object_id):
    return [json.loads(r[0]) for r in conn.execute(
        "SELECT snapshot_json FROM snz_orders WHERE object_id=? ORDER BY work_date,shift,id", (object_id,))]


def _unique(items, key, title):
    ids = [i[key] for i in items]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, f"Повторяются идентификаторы: {title}.")


def _validate(state, elements, old, history):
    for name in ("crews", "operations", "teams", "cards", "groups"):
        _unique(state[name], "id", name)
    _unique(state["assignments"], "element_id", "назначения изделий")
    if sum(c["kind"] == "preparation" for c in state["crews"]) != 1:
        raise HTTPException(422, "Нужна одна общая подготовительная бригада.")
    crews = {c["id"]: c for c in state["crews"]}
    ops = {o["id"]: o for o in state["operations"]}
    if any(o["team"] not in {t["id"] for t in state["teams"]} for o in state["operations"]):
        raise HTTPException(422, "Выберите звено из справочника для каждой операции.")
    cards = {c["id"]: c for c in state["cards"]}
    by_id = {e["id"]: e for e in elements}
    for card in state["cards"]:
        _unique(card["steps"], "operation_id", "операции карты")
        if any(s["operation_id"] not in ops for s in card["steps"]):
            raise HTTPException(422, "Карта ссылается на отсутствующую операцию.")
        scopes = [ops[s["operation_id"]]["scope"] for s in card["steps"]]
        if "preparation" in scopes[1:]:
            raise HTTPException(422, "Подготовка должна быть первой операцией карты.")
    for a in state["assignments"]:
        if a["element_id"] not in by_id:
            raise HTTPException(422, "Назначение содержит изделие другого объекта или удалённое изделие.")
        if a["card_id"] not in cards or crews.get(a["crew_id"], {}).get("kind") != "installation":
            raise HTTPException(422, "Назначьте существующую монтажную бригаду и операционную карту.")
    grouped = set()
    for g in state["groups"]:
        if g.get("card_id") and g["card_id"] not in cards:
            raise HTTPException(422, "Карта общих операций узла не найдена.")
        if len(set(g["element_ids"])) != len(g["element_ids"]) or grouped.intersection(g["element_ids"]):
            raise HTTPException(422, "Ригель может входить только в один узел, без повторений.")
        for eid in g["element_ids"]:
            if eid not in by_id or "ригел" not in by_id[eid]["element_type"].lower():
                raise HTTPException(422, "В узел входят только 3 или 4 ригеля этого объекта.")
        floors = {by_id[eid]["floor"] for eid in g["element_ids"]}
        if len(floors) != 1:
            raise HTTPException(422, "Ригели одного узла должны находиться на одном этаже.")
        grouped.update(g["element_ids"])
    # Definitions already issued are retained. History remains an immutable snapshot;
    # changing a norm only affects tasks which have never been issued.
    locked = {eid for order in history for eid in order_items(order)}
    old_assignments = {a["element_id"]: a for a in old["assignments"]}
    new_assignments = {a["element_id"]: a for a in state["assignments"]}
    for eid in locked:
        before, after = old_assignments.get(eid), new_assignments.get(eid)
        if before != after:
            raise HTTPException(409, "Изделие включено в выданный СНЗ. Сначала исправьте состав связанных документов кнопкой «Редактировать».")
    old_groups = {g["id"]: g for g in old["groups"]}
    new_groups = {g["id"]: g for g in state["groups"]}
    for gid, g in old_groups.items():
        if locked.intersection(g["element_ids"]) and new_groups.get(gid) != g:
            raise HTTPException(409, "Состав узла из выданного СНЗ изменять нельзя.")


@router.get("/state")
def get_state(object_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        state, revision = _load(conn, object_id)
        from app.snz_registry import registry
        register = registry(conn, object_id)
        locked = sorted({eid for order in _history(conn, object_id) for eid in order_items(order)})
        normalize_montage(state, locked)
        elements = _elements(conn, object_id)
        grouped = {eid: g for g in state["groups"] for eid in g["element_ids"]}
        for element in elements:
            element["suggested_card_id"] = suggest_card(state, element)
            element["completed_operations"] = [op["name"] for op in state["operations"]
                if state["facts"].get(f"e:{element['id']}:{op['id']}", {}).get("completed")
                or (element["id"] in grouped and state["facts"].get(f"g:{grouped[element['id']]['id']}:{op['id']}", {}).get("completed"))]
        return {"revision": revision, "state": state, "elements": elements, **register, "locked_element_ids": locked,
                "can_write": has_feature(conn, user, "planned_date", "write", object_id),
                "can_fact": has_feature(conn, user, "status", "write", object_id)}
    finally:
        conn.close()


@router.put("/state")
def save_state(object_id: int, body: StateIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        old, revision = _load(conn, object_id)
        _version(revision, body.revision)
        state = planning_state(body.model_dump(mode="json", exclude={"revision"}))
        state["facts"] = old["facts"]
        state["catalog_seed"] = old.get("catalog_seed", "")
        elements = _elements(conn, object_id)
        history = _history(conn, object_id)
        _validate(state, elements, old, history)
        normalize_montage(state, {eid for order in history for eid in order_items(order)})
        _write(conn, object_id, state, revision)
        # Keep the existing model's planned date in sync; no status or contract changes.
        before = {a["element_id"]: a for a in old["assignments"]}
        after = {a["element_id"]: a for a in state["assignments"]}
        changed = []
        by_id = {e["id"]: e for e in elements}
        for eid in before.keys() | after.keys():
            old_date = before.get(eid, {}).get("date")
            new_date = after.get(eid, {}).get("date")
            if old_date != new_date:
                if by_id[eid]["current_status"] != "ready_for_installation":
                    raise HTTPException(409, "План монтажа назначается только изделиям «Готов к монтажу».")
                conn.execute("UPDATE elements SET planned_installation_date=? WHERE id=? AND object_id=?", (new_date, eid, object_id))
                changed.append(eid)
        touch_elements(conn, changed)
        conn.commit()
        activity.log("snz_state", user=user, entity_type="object", entity_id=object_id, details={"revision": revision + 1, "assignments": len(after)})
        return {"revision": revision + 1}
    finally:
        conn.close()


def _calculate(conn, object_id, body):
    state, revision = _load(conn, object_id)
    _version(revision, body.revision)
    if body.crew_id not in {c["id"] for c in state["crews"]}:
        raise HTTPException(422, "Бригада не найдена.")
    snapshot = build_schedule(state, _elements(conn, object_id), _history(conn, object_id), body.date.isoformat(), body.shift, body.crew_id)
    snapshot["revision"] = revision
    snapshot["object_name"] = conn.execute("SELECT name FROM objects WHERE id=?", (object_id,)).fetchone()[0]
    snapshot["fingerprint"] = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return snapshot


@router.post("/preview")
def preview(object_id: int, body: PlanIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        state, revision = _load(conn, object_id)
        _version(revision, body.revision)
        issued = conn.execute("SELECT id FROM snz_orders WHERE object_id=? AND work_date=? AND shift=? AND crew_id=?", (object_id, body.date.isoformat(), body.shift, body.crew_id)).fetchone()
        if issued:
            snapshot = _order(conn, object_id, issued["id"])
            return {**snapshot, "id": issued["id"], "order_revision": snapshot.get("order_revision", 1), "facts": state["facts"], "current_revision": revision}
        return _calculate(conn, object_id, body)
    finally:
        conn.close()


@router.post("/orders")
def issue(object_id: int, body: IssueIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        existing = conn.execute("SELECT id,work_date,shift,crew_id FROM snz_orders WHERE object_id=? AND request_id=?", (object_id, body.request_id)).fetchone()
        if existing:
            if (existing["work_date"], existing["shift"], existing["crew_id"]) != (body.date.isoformat(), body.shift, body.crew_id):
                raise HTTPException(409, "Этот запрос уже использован для другого СНЗ.")
            return {"id": existing["id"], "already_issued": True}
        if conn.execute("SELECT 1 FROM snz_orders WHERE object_id=? AND work_date=? AND shift=? AND crew_id=?",
                        (object_id, body.date.isoformat(), body.shift, body.crew_id)).fetchone():
            raise HTTPException(409, "СНЗ этой бригады на выбранную смену уже выдан. Откройте его в списке выданных.")
        # Backdated issues would invalidate the planned carry-forward of a later snapshot.
        if conn.execute("SELECT 1 FROM snz_orders WHERE object_id=? AND crew_id=? AND "
                        "(work_date>? OR (work_date=? AND shift='night' AND ?='day'))",
                        (object_id, body.crew_id, body.date.isoformat(), body.date.isoformat(), body.shift)).fetchone():
            raise HTTPException(409, "На более позднюю смену уже выдан СНЗ. Выдача задним числом изменит расчёт остатков.")
        snapshot = _calculate(conn, object_id, body)
        if snapshot["fingerprint"] != body.expected_hash:
            raise HTTPException(409, "Расписание или данные модели изменились после предпросмотра. Рассчитайте смену заново перед выдачей.")
        if not order_items(snapshot):
            raise HTTPException(422, "Нет рассчитанных работ для выдачи. Проверьте нормативы, назначения и предупреждения.")
        name = audit_display_name(user)
        snapshot["issued_by"] = name
        task_ids = set(order_items(snapshot))
        snapshot["assignment_steps"] = {eid: steps for eid, steps in snapshot["assignment_steps"].items() if int(eid) in task_ids}
        oid = conn.execute("INSERT INTO snz_orders(object_id,work_date,shift,crew_id,source_revision,snapshot_json,created_by,request_id) "
                           "VALUES (?,?,?,?,?,?,?,?)", (object_id, body.date.isoformat(), body.shift, body.crew_id, body.revision,
                                                        json.dumps(snapshot, ensure_ascii=False), name, body.request_id)).lastrowid
        state, revision = _load(conn, object_id)
        _write(conn, object_id, state, revision)
        conn.commit()
        activity.log("snz_issue", user=user, entity_type="object", entity_id=object_id, details={"order_id": oid, "date": body.date.isoformat(), "shift": body.shift})
        return {"id": oid, "revision": revision + 1}
    finally:
        conn.close()


def _order(conn, object_id, order_id):
    row = conn.execute("SELECT * FROM snz_orders WHERE object_id=? AND id=?", (object_id, order_id)).fetchone()
    if not row:
        raise HTTPException(404, "СНЗ не найден.")
    return json.loads(row["snapshot_json"])


@router.get("/orders/{order_id}")
def read_order(object_id: int, order_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        result = _order(conn, object_id, order_id)
        state, revision = _load(conn, object_id)
        return {**result, "id": order_id, "order_revision": result.get("order_revision", 1), "facts": state["facts"], "current_revision": revision}
    finally:
        conn.close()


def _edit_preview(conn, object_id, order_id, body):
    from app.snz_order_edit import revise_order
    state, revision = _load(conn, object_id)
    _version(revision, body.revision)
    old = _order(conn, object_id, order_id)
    if old.get("order_revision", 1) != body.order_revision:
        raise HTTPException(409, "Редакция СНЗ изменилась. Откройте документ заново.")
    if not body.reason.strip():
        raise HTTPException(422, "Укажите причину исправления СНЗ.")
    if len(set(body.exclude_element_ids)) != len(body.exclude_element_ids) or any(eid <= 0 for eid in body.exclude_element_ids):
        raise HTTPException(422, "Недопустимый список исключаемых изделий.")
    try:
        snapshot = revise_order(old, state["facts"], body.exclude_element_ids, _history(conn, object_id))
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    snapshot["revision"] = revision
    snapshot["edit_reason"] = body.reason.strip()
    snapshot["fingerprint"] = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return snapshot


@router.post("/orders/{order_id}/edit-preview")
def preview_order_edit(object_id: int, order_id: int, body: EditPreviewIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        return _edit_preview(conn, object_id, order_id, body)
    finally:
        conn.close()


@router.post("/orders/{order_id}/revisions")
def edit_order(object_id: int, order_id: int, body: EditOrderIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        payload = body.model_dump(mode="json")
        request_hash = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        existing = conn.execute("SELECT order_id,revision,request_hash FROM snz_order_revisions WHERE object_id=? AND request_id=?", (object_id, body.request_id)).fetchone()
        if existing:
            if existing["order_id"] != order_id or existing["request_hash"] != request_hash:
                raise HTTPException(409, "Этот запрос исправления уже использован для другого действия.")
            return {"id": order_id, "order_revision": existing["revision"], "revision": _load(conn, object_id)[1], "already_applied": True}
        row = conn.execute("SELECT * FROM snz_orders WHERE object_id=? AND id=?", (object_id, order_id)).fetchone()
        if not row:
            raise HTTPException(404, "СНЗ не найден.")
        snapshot = _edit_preview(conn, object_id, order_id, body)
        if snapshot["fingerprint"] != body.expected_hash:
            raise HTTPException(409, "Данные СНЗ изменились после предпросмотра. Проверьте исправление заново.")
        state, revision = _load(conn, object_id)
        name = audit_display_name(user)
        old = json.loads(row["snapshot_json"])
        old_revision = old.get("order_revision", 1)
        # The original legacy row is archived lazily, inside this same transaction.
        conn.execute("INSERT OR IGNORE INTO snz_order_revisions(object_id,order_id,revision,snapshot_json,created_at,created_by,reason) VALUES (?,?,?,?,?,?,?)",
                     (object_id, order_id, old_revision, row["snapshot_json"], row["created_at"], old.get("edited_by", row["created_by"]), old.get("edit_reason", "Первоначальная выдача")))
        snapshot["edited_by"] = name
        snapshot["edited_at"] = datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds")
        raw = json.dumps(snapshot, ensure_ascii=False)
        conn.execute("INSERT INTO snz_order_revisions(object_id,order_id,revision,snapshot_json,created_by,reason,request_id,request_hash) VALUES (?,?,?,?,?,?,?,?)",
                     (object_id, order_id, snapshot["order_revision"], raw, name, body.reason.strip(), body.request_id, request_hash))
        conn.execute("UPDATE snz_orders SET snapshot_json=?,source_revision=? WHERE object_id=? AND id=?", (raw, revision, object_id, order_id))
        _write(conn, object_id, state, revision)
        conn.commit()
        activity.log("snz_issue", user=user, entity_type="object", entity_id=object_id,
                     details={"order_id": order_id, "order_revision": snapshot["order_revision"], "excluded_element_ids": body.exclude_element_ids, "reason": body.reason.strip()})
        return {"id": order_id, "order_revision": snapshot["order_revision"], "revision": revision + 1}
    finally:
        conn.close()


def _order_revision(conn, object_id, order_id, revision):
    current = _order(conn, object_id, order_id)
    if revision is None or revision == current.get("order_revision", 1):
        return current
    row = conn.execute("SELECT snapshot_json FROM snz_order_revisions WHERE object_id=? AND order_id=? AND revision=?", (object_id, order_id, revision)).fetchone()
    if not row:
        raise HTTPException(404, "Редакция СНЗ не найдена.")
    return json.loads(row[0])


@router.post("/orders/{order_id}/delete")
def delete_issued_order(object_id: int, order_id: int, body: DeleteOrderIn, user=Depends(get_current_user)):
    from app.snz_delete import delete_order
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        result = delete_order(conn, object_id, order_id, body, audit_display_name(user), _load, _write, _version)
        conn.commit()
        if not result.get("already_deleted"):
            activity.log("snz_delete", user=user, entity_type="object", entity_id=object_id, details=result)
        return result
    finally:
        conn.close()


@router.get("/orders/{order_id}/revisions")
def list_order_revisions(object_id: int, order_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        _order(conn, object_id, order_id)
        rows = [dict(row) for row in conn.execute("SELECT revision,reason,created_at,created_by FROM snz_order_revisions WHERE object_id=? AND order_id=? ORDER BY revision DESC", (object_id, order_id))]
        if not rows:
            row = conn.execute("SELECT created_at,created_by FROM snz_orders WHERE id=?", (order_id,)).fetchone()
            rows = [{"revision": 1, "reason": "Первоначальная выдача", **dict(row)}]
        return rows
    finally:
        conn.close()


@router.get("/orders/{order_id}/revisions/{revision}")
def read_order_revision(object_id: int, order_id: int, revision: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        snapshot = _order_revision(conn, object_id, order_id, revision)
        return {**snapshot, "id": order_id, "order_revision": revision, "historical": True, "facts": _load(conn, object_id)[0]["facts"]}
    finally:
        conn.close()


@router.post("/facts")
def complete(object_id: int, body: FactIn, user=Depends(get_current_user)):
    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "status", "write")
        state, revision = _load(conn, object_id)
        if state["facts"].get(body.task_key, {}).get("completed"):
            return {"revision": revision, "already_completed": True}
        _version(revision, body.revision)
        history = _history(conn, object_id)
        task = next((t for order in reversed(history) for t in order["tasks"] if t["key"] == body.task_key), None)
        if not task:
            raise HTTPException(422, "Отметить можно только операцию из выданного СНЗ.")
        now = datetime.now(ZoneInfo("Europe/Moscow")).replace(tzinfo=None)
        # Violations warn in the planning process; the actual completed fact is recorded
        # even when execution differed from the prescribed sequence.
        state["facts"][body.task_key] = {"completed": True, "completed_at": now.isoformat(timespec="minutes"), "completed_by": audit_display_name(user)}
        warnings = []
        for dep in task.get("dependencies", []):
            fact = state["facts"].get(dep, {})
            if not fact.get("completed"):
                warnings.append("Факт записан: предшествующая операция ещё не отмечена завершённой.")
            else:
                from datetime import timedelta
                predecessor = next((t for order in reversed(history) for t in order["tasks"] if t["key"] == dep), None)
                if predecessor and datetime.fromisoformat(fact["completed_at"]) + timedelta(minutes=predecessor["wait_after"]) > now:
                    warnings.append("Факт записан: технологический перерыв после предшествующей операции ещё не истёк.")
        elements = _elements(conn, object_id)
        by_id = {e["id"]: e for e in elements}
        group_map = {eid: g for g in state["groups"] for eid in g["element_ids"]}
        frozen_steps = {}
        for order in history:
            frozen_steps.update(order.get("assignment_steps", {}))
        installed = []
        for eid in task["element_ids"]:
            a = next((a for a in state["assignments"] if a["element_id"] == eid), None)
            if not a or eid not in by_id or by_id[eid]["current_status"] in ("installed", "accepted"):
                continue
            steps = frozen_steps.get(str(eid)) or operation_steps(state, a)
            keys = []
            for s in steps:
                g = group_map.get(eid)
                keys.append(f"g:{g['id']}:{s['id']}" if s["scope"] == "group" and g else f"e:{eid}:{s['id']}")
            if keys and all(step_fact(state, eid, s["id"], k).get("completed") for s,k in zip(steps,keys)):
                from app.contracts import apply_status_change
                apply_status_change(conn, eid, "installed", False, None, None, "Выполнены все операции СНЗ", audit_display_name(user), user["id"])
                installed.append(eid)
        _write(conn, object_id, state, revision)
        touch_elements(conn, installed)
        conn.commit()
        activity.defer_flush(events)
        activity.log("snz_fact", user=user, entity_type="object", entity_id=object_id, details={"task_key": body.task_key, "installed": installed})
        return {"revision": revision + 1, "installed": installed, "warnings": list(dict.fromkeys(warnings))}
    finally:
        activity.defer_end(events)
        conn.close()


@router.get("/registry.xlsx")
def export_registry(object_id: int, date: date, user=Depends(get_current_user)):
    from app.snz_registry import registry
    from app.snz_export import build_registry_xlsx
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        report = registry(conn, object_id, date.isoformat(), include_snapshots=True)
        data = build_registry_xlsx(report, date)
        return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="SNZ-register-{date.isoformat()}.xlsx"'})
    finally:
        conn.close()


@router.get("/orders/{order_id}/export.xlsx")
def export_xlsx(object_id: int, order_id: int, user=Depends(get_current_user), revision: int | None = None):
    from app.snz_export import build_xlsx
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        order = _order_revision(conn, object_id, order_id, revision)
        data = build_xlsx(order)
        return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="SNZ-{order_id}.xlsx"'})
    finally:
        conn.close()


@router.get("/orders/{order_id}/export.pdf")
def export_pdf(object_id: int, order_id: int, user=Depends(get_current_user), revision: int | None = None):
    from app.snz_export import build_pdf
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        order = _order_revision(conn, object_id, order_id, revision)
        sources = {e["source_file"] for task in order["tasks"] for e in task["elements"]}
        axes = [dict(r) for source in sources for r in conn.execute("SELECT * FROM axis_lines WHERE source_file=?", (source,))]
        return Response(build_pdf(order, _elements(conn, object_id), axes), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="SNZ-{order_id}.pdf"'})
    finally:
        conn.close()

"""СНЗ: справочники, расчёт, выдача, версии исправлений, реестр и факт."""
import json
import hashlib
from datetime import date, datetime
from datetime import date as DateValue
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app import activity
from app.access import assert_object_feature, has_feature
from app.auth import audit_display_name, get_current_user
from app.db import begin_write, get_connection, touch_elements
from app.snz_core import build_schedule, default_state, suggest_card
from app.snz_policy import planning_state, order_items
from app.snz_ordering import normalize_montage
from app.snz_montage import status_montage, project_montage, fact_rows

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


class FloorLevel(Strict):
    floor: int = Field(ge=-20, le=300)
    elevation_mm: int = Field(ge=-1000000, le=3000000)


class StateIn(Strict):
    revision: int = Field(ge=0)
    catalog_seed: str = Field(default="", max_length=100)
    crews: list[Crew] = Field(min_length=2, max_length=100)
    operations: list[Operation] = Field(min_length=1, max_length=100)
    teams: list[Team] = Field(min_length=1, max_length=100)
    cards: list[Card] = Field(min_length=1, max_length=200)
    assignments: list[Assignment] = Field(max_length=20000)
    groups: list[Group] = Field(max_length=5000)
    floor_levels: list[FloorLevel] = Field(default_factory=list, max_length=320)


class PlanIn(Strict):
    revision: int = Field(ge=0)
    date: date
    shift: Literal["day", "night"]
    crew_id: str = Field(pattern=KEY)
    ignore_fact: bool = Field(default=False, strict=True)


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
    completed_at: datetime | None = None
    expected_montage_rev: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    order_id: int | None = Field(default=None, gt=0)


class FactNoteIn(Strict):
    revision: int = Field(ge=0)
    element_id: int = Field(gt=0)
    note_key: str = Field(min_length=1, max_length=180)
    text: str = Field(max_length=4000)


class ExtraItemIn(Strict):
    element_id: int = Field(gt=0)
    expected_rev: str = Field(pattern=r"^[0-9a-f]{64}$")


class ExtraFactIn(Strict):
    revision: int = Field(ge=0)
    date: date
    crew_id: str = Field(pattern=KEY)
    completed_at: datetime | None = None
    request_id: str = Field(pattern=KEY)
    items: list[ExtraItemIn] = Field(min_length=1, max_length=500)


class CloseScopeIn(Strict):
    revision: int = Field(ge=0)
    date: DateValue | None = None
    shift: Literal['day','night'] | None = None
    crew_id: str | None = Field(default=None, pattern=KEY)
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    request_id: str = Field(pattern=KEY)


class DeleteOrderIn(Strict):
    revision: int = Field(ge=0)
    order_revision: int = Field(ge=1)
    request_id: str = Field(pattern=KEY)


def _public_facts(state):
    from app.snz_fact_store import KEY as report_key
    return {k:v for k,v in state['facts'].items() if k!=report_key}


def _load(conn, object_id):
    row = conn.execute("SELECT revision,data_json FROM snz_state WHERE object_id=?", (object_id,)).fetchone()
    state,revision = (planning_state(json.loads(row["data_json"])), row["revision"]) if row else (default_state(), 0)
    state.setdefault("floor_levels", [])
    project_montage(state,status_montage(conn,object_id))
    return state,revision


def _write(conn, object_id, state, revision):
    conn.execute("INSERT INTO snz_state(object_id,revision,data_json) VALUES (?,?,?) "
                 "ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
                 (object_id, revision + 1, json.dumps(state, ensure_ascii=False)))


def _version(actual, expected):
    if actual != expected:
        raise HTTPException(409, "СНЗ изменён другим пользователем. Обновите данные перед сохранением.")


def _elements(conn, object_id):
    result = [dict(r) for r in conn.execute(
        "SELECT e.id,e.element_uid,e.mark,e.element_type,e.subtype,e.floor,e.elevation_mm,e.address,"
        "e.axis_number,e.axis_letter,e.x,e.y,e.outline_json,e.source_file,e.current_status,e.is_current,e.planned_installation_date,"
        "e.zone_zakhvatka_id,z.name AS zakhvatka,c.name AS crane,s.name AS stance,cp.short_name AS counterparty "
        "FROM elements e LEFT JOIN zones z ON z.id=e.zone_zakhvatka_id "
        "LEFT JOIN zones c ON c.id=e.zone_crane_id LEFT JOIN zones s ON s.id=e.zone_stance_id "
        "LEFT JOIN contracts ct ON ct.id=e.contract_id LEFT JOIN specifications sp ON sp.id=ct.specification_id "
        "LEFT JOIN agreements ag ON ag.id=sp.agreement_id LEFT JOIN counterparties cp ON cp.id=ag.counterparty_id "
        "WHERE e.object_id=? ORDER BY e.id", (object_id,))]
    from app.snz_fact_store import records
    row=conn.execute('SELECT data_json FROM snz_state WHERE object_id=?',(object_id,)).fetchone()
    transfers=records(json.loads(row[0])).get('transfers',{}) if row else {}
    for e in result:
        if str(e['id']) in transfers:e['transfer_from']=transfers[str(e['id'])]['from_date']
    return result


def _history(conn, object_id):
    from app.snz_closure import closed_orders
    closed=closed_orders(conn,object_id)
    return [{**json.loads(r['snapshot_json']), "id":r["id"]} for r in conn.execute(
        "SELECT id,snapshot_json FROM snz_orders WHERE object_id=? ORDER BY work_date,shift,id", (object_id,)) if str(r['id']) not in closed]


def _schedule_history(conn,object_id):
    # Closing releases unmounted products; real unfinished post-montage work still carries.
    from app.snz_closure import closed_orders
    from copy import deepcopy
    result=_history(conn,object_id);closed=closed_orders(conn,object_id)
    if not closed:return result
    statuses=status_montage(conn,object_id)
    for row in conn.execute('SELECT id,snapshot_json FROM snz_orders WHERE object_id=?',(object_id,)):
        closure=closed.get(str(row['id']))
        if not closure:continue
        mounted={int(eid) for eid,item in closure['rows'].items() if item['status_confirmed']
                 and statuses.get(int(eid),{}).get('current_status') in ('installed','accepted')}
        if not mounted:continue
        order=deepcopy(json.loads(row['snapshot_json']))
        order['tasks']=[t for t in order['tasks'] if set(t['element_ids'])<=mounted]
        order['items']=[e for e in order.get('items',[]) if e['id'] in mounted]
        order['assignment_steps']={k:v for k,v in order.get('assignment_steps',{}).items() if int(k) in mounted}
        order['id']=row['id'];order['closed_at']=closure['closed_at'];result.append(order)
    return sorted(result,key=lambda o:(o['date'],o['shift']=='night',o.get('id',0)))


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
        return {"revision": revision, "state": {**state,"facts":_public_facts(state)}, "elements": elements, **register, "locked_element_ids": locked,
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
        if "floor_levels" not in body.model_fields_set:
            state["floor_levels"] = old.get("floor_levels", [])
        _unique(state["floor_levels"], "floor", "Этажи")
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
    snapshot = build_schedule(state, _elements(conn, object_id), _schedule_history(conn, object_id), body.date.isoformat(), body.shift, body.crew_id, ignore_fact=body.ignore_fact)
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
            return {**snapshot, "id": issued["id"], "order_revision": snapshot.get("order_revision", 1), "facts": (records_for_closed(conn,object_id,issued["id"]) or _public_facts(state)), "current_revision": revision}
        return _calculate(conn, object_id, body)
    finally:
        conn.close()


@router.post("/orders")
def issue(object_id: int, body: IssueIn, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "planned_date", "write")
        existing = conn.execute("SELECT id,work_date,shift,crew_id,snapshot_json FROM snz_orders WHERE object_id=? AND request_id=?", (object_id, body.request_id)).fetchone()
        if existing:
            if (existing["work_date"], existing["shift"], existing["crew_id"]) != (body.date.isoformat(), body.shift, body.crew_id):
                raise HTTPException(409, "Этот запрос уже использован для другого СНЗ.")
            if bool(json.loads(existing['snapshot_json']).get('ignore_fact')) != body.ignore_fact:
                raise HTTPException(409, "Этот запрос уже использован с другим режимом учёта факта.")
            return {"id": existing["id"], "already_issued": True}
        if conn.execute("SELECT 1 FROM snz_orders WHERE object_id=? AND work_date=? AND shift=? AND crew_id=?",
                        (object_id, body.date.isoformat(), body.shift, body.crew_id)).fetchone():
            raise HTTPException(409, "СНЗ этой бригады на выбранную смену уже выдан. Откройте его в списке выданных.")
        # Backdated issues would invalidate the planned carry-forward of a later snapshot.
        if conn.execute("SELECT 1 FROM snz_orders WHERE object_id=? AND crew_id=? AND "
                        "(work_date>? OR (work_date=? AND shift='night' AND ?='day'))",
                        (object_id, body.crew_id, body.date.isoformat(), body.date.isoformat(), body.shift)).fetchone():
            raise HTTPException(409, "На более позднюю смену уже выдан СНЗ. Выдача задним числом изменит расчёт остатков.")
        from app.snz_closure import assert_previous_orders_closed
        assert_previous_orders_closed(conn,object_id,body.date.isoformat(),body.shift,body.crew_id,body.ignore_fact)
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


def records_for_closed(conn,object_id,order_id):
    from app.snz_closure import closed_orders
    closure=closed_orders(conn,object_id).get(str(order_id))
    return closure['facts'] if closure else None


def _assert_open_order(conn,object_id,order_id):
    from app.snz_closure import closed_orders
    if str(order_id) in closed_orders(conn,object_id):raise HTTPException(409,'СНЗ закрыт. Дальнейшее редактирование запрещено.')


def _order(conn, object_id, order_id):
    row = conn.execute("SELECT * FROM snz_orders WHERE object_id=? AND id=?", (object_id, order_id)).fetchone()
    if not row:
        raise HTTPException(404, "СНЗ не найден.")
    from app.snz_closure import closed_orders,closure_projection
    return closure_projection(json.loads(row["snapshot_json"]),closed_orders(conn,object_id).get(str(order_id)))


@router.get("/orders/{order_id}")
def read_order(object_id: int, order_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "plan", "read")
        result = _order(conn, object_id, order_id)
        state, revision = _load(conn, object_id)
        return {**result, "id": order_id, "order_revision": result.get("order_revision", 1), "facts": (records_for_closed(conn,object_id,order_id) or _public_facts(state)), "current_revision": revision}
    finally:
        conn.close()


def _edit_preview(conn, object_id, order_id, body):
    from app.snz_order_edit import revise_order
    state, revision = _load(conn, object_id)
    _version(revision, body.revision)
    _assert_open_order(conn,object_id,order_id)
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
        _assert_open_order(conn,object_id,order_id)
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
        return {**snapshot, "id": order_id, "order_revision": revision, "historical": True, "facts": (records_for_closed(conn,object_id,order_id) or _public_facts(_load(conn, object_id)[0]))}
    finally:
        conn.close()


@router.get("/facts")
def montage_facts(object_id: int, date: date | None = None, shift: Literal["day","night"] | None = None,
                  crew_id: str | None = None, without_fact: bool = False, user=Depends(get_current_user)):
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,"plan","read")
        state,revision=_load(conn,object_id)
        items=fact_rows(conn,object_id,state,status_montage(conn,object_id),
                    date.isoformat() if date else None,shift,crew_id)
        if without_fact:items=[r for r in items if not r["status_confirmed"]]
        return {"revision":revision,"items":items,
                "can_fact":has_feature(conn,user,"status","write",object_id)}
    finally:conn.close()


@router.get("/facts/close-preview")
def preview_close_orders(object_id: int, date: date | None = None, shift: Literal['day','night'] | None = None,
                         crew_id: str | None = None, user=Depends(get_current_user)):
    from app.snz_closure import close_scope
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'status','write');state,revision=_load(conn,object_id)
        result=close_scope(conn,object_id,state,date.isoformat() if date else None,shift,crew_id)
        return {k:v for k,v in {**result,'revision':revision}.items() if k not in ('orders','statuses')}
    finally:conn.close()


@router.post("/facts/close")
def close_issued_orders(object_id: int, body: CloseScopeIn, user=Depends(get_current_user)):
    from app.snz_closure import close_scope
    from app.snz_fact_store import records
    from app.contracts import apply_status_change
    conn=get_connection();events=activity.defer_begin()
    try:
        begin_write(conn);assert_object_feature(conn,user,object_id,'status','write')
        state,revision=_load(conn,object_id);store=records(state,True)
        payload=hashlib.sha256(body.model_dump_json(exclude={'revision'}).encode()).hexdigest()
        previous=store.get('close_requests',{}).get(body.request_id)
        if previous:
            if previous['payload_hash']!=payload:raise HTTPException(409,'Ключ закрытия уже использован для другого набора СНЗ.')
            return {**previous['result'],'revision':revision,'already_closed':True}
        _version(revision,body.revision)
        scope=close_scope(conn,object_id,state,body.date.isoformat() if body.date else None,body.shift,body.crew_id)
        if scope['fingerprint']!=body.expected_hash:raise HTTPException(409,'Факт или состав СНЗ изменился. Обновите вкладку перед закрытием.')
        if not scope['orders']:raise HTTPException(409,'По выбранным дате, смене и бригаде нет незакрытых СНЗ.')
        pending=set(scope['pending_element_ids']);selected=set(scope['order_ids'])
        conflicts=[]
        for row in conn.execute('SELECT id,snapshot_json FROM snz_orders WHERE object_id=?',(object_id,)):
            if row['id'] in selected or str(row['id']) in store.get('closed',{}):continue
            if pending & set(order_items(json.loads(row['snapshot_json']))):conflicts.append(row['id'])
        if conflicts:raise HTTPException(409,'Невыполненные изделия включены также в незакрытые СНЗ № '+', '.join(map(str,conflicts))+'. Расширьте отбор для совместного закрытия.')
        now=datetime.now(ZoneInfo('Europe/Moscow')).replace(tzinfo=None,microsecond=0)
        for order in scope['orders']:
            items=order_items(order);rows={}
            for eid in items:
                status=scope['statuses'].get(eid,{})
                rows[str(eid)]={'current_status':status.get('current_status',items[eid].get('current_status')),
                    'status_confirmed':status.get('current_status') in ('installed','accepted'),
                    'completed':bool(status.get('completed_at')),'completed_at':status.get('completed_at')}
            frozen={t['key']:state['facts'].get(t['key'],{}).copy() for t in order['tasks']}
            for task in order['tasks']:
                if task['operation_id']=='install' and not all(rows[str(eid)]['status_confirmed'] for eid in task['element_ids']):
                    frozen[task['key']]={'completed':False}
            store.setdefault('closed',{})[str(order['id'])]={'closed_at':now.isoformat(timespec='seconds'),'closed_by':audit_display_name(user),
                'rows':rows,'facts':frozen}
        for eid in sorted(pending):
            state['facts'].pop(f'e:{eid}:install',None)
            if scope['statuses'][eid]['current_status']!='ready_for_installation':
                apply_status_change(conn,eid,'ready_for_installation',False,None,now.isoformat(sep=' ',timespec='seconds'),
                                    'Закрытие СНЗ: изделие не смонтировано',audit_display_name(user),user['id'])
                if conn.execute('SELECT current_status FROM elements WHERE id=?',(eid,)).fetchone()[0]!='ready_for_installation':
                    raise HTTPException(409,'У изделия есть более поздний статус. Проверьте историю перед закрытием СНЗ.')
            conn.execute('UPDATE elements SET planned_installation_date=NULL WHERE id=? AND object_id=?',(eid,object_id))
            source=max((o for o in scope['orders'] if eid in order_items(o)),key=lambda o:(o['date'],o['shift']=='night',o['id']))
            store.setdefault('transfers',{})[str(eid)]={'from_date':source['date'],'from_shift':source['shift'],'order_id':source['id'],'closed_at':now.isoformat(timespec='seconds')}
        state['assignments']=[a for a in state['assignments'] if a['element_id'] not in pending]
        result={'closed_order_ids':scope['order_ids'],'released_element_ids':sorted(pending),'revision':revision+1}
        store.setdefault('close_requests',{})[body.request_id]={'payload_hash':payload,'result':result}
        _write(conn,object_id,state,revision);touch_elements(conn,list(pending));conn.commit();activity.defer_flush(events)
        activity.log('snz_fact',user=user,entity_type='object',entity_id=object_id,
                     details={'action':'close','order_ids':scope['order_ids'],'released_element_ids':sorted(pending)})
        return result
    finally:activity.defer_end(events);conn.close()


@router.put("/facts/note")
def save_fact_note(object_id: int, body: FactNoteIn, user=Depends(get_current_user)):
    from app.snz_fact_store import records
    conn=get_connection()
    try:
        begin_write(conn);assert_object_feature(conn,user,object_id,"status","write")
        state,revision=_load(conn,object_id);_version(revision,body.revision)
        rows=fact_rows(conn,object_id,state,status_montage(conn,object_id))
        allowed=next((r for r in rows if r['id']==body.element_id and any(
            ref['note_key']==body.note_key for ref in r['orders']+r.get('extra',[]))),None)
        if not allowed:raise HTTPException(409,'Позиция больше не входит в текущий реестр факта. Обновите данные.')
        if any(ref['note_key']==body.note_key and ref.get('closed_at') for ref in allowed['orders']):
            raise HTTPException(409,'СНЗ закрыт. Редактирование примечания запрещено.')
        notes=records(state,True)['notes']
        notes[body.note_key]={'text':body.text,'updated_at':datetime.now(ZoneInfo('Europe/Moscow')).isoformat(timespec='seconds'),
                              'updated_by':audit_display_name(user)}
        _write(conn,object_id,state,revision);conn.commit()
        activity.log('snz_fact',user=user,entity_type='object',entity_id=object_id,
                     details={'action':'note','element_id':body.element_id,'note_key':body.note_key})
        return {'revision':revision+1}
    finally:conn.close()


@router.get("/facts/extra-candidates")
def extra_fact_candidates(object_id: int, date: date, user=Depends(get_current_user)):
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'plan','read')
        state,revision=_load(conn,object_id);statuses=status_montage(conn,object_id)
        planned={r['id'] for r in fact_rows(conn,object_id,state,statuses,date.isoformat()) if r['orders']}
        return {'revision':revision,'items':[{'id':e['id'],'expected_rev':statuses[e['id']]['expected_rev'],
                 'current_status':e['current_status']} for e in _elements(conn,object_id)
                 if e.get('is_current',1) and e['id'] not in planned and e['current_status'] not in ('installed','accepted')],
                'crews':[c for c in state['crews'] if c['kind']=='installation'],
                'can_fact':has_feature(conn,user,'status','write',object_id)}
    finally:conn.close()


@router.post("/facts/extra")
def complete_extra_fact(object_id: int, body: ExtraFactIn, user=Depends(get_current_user)):
    from app.snz_fact_store import records
    from app.contracts import apply_status_change
    from datetime import timedelta
    conn=get_connection();events=activity.defer_begin()
    try:
        begin_write(conn);assert_object_feature(conn,user,object_id,'status','write')
        state,revision=_load(conn,object_id)
        payload=hashlib.sha256(body.model_dump_json(exclude={'revision'}).encode()).hexdigest()
        store=records(state,True)
        prior=store['extra'].get(body.request_id)
        if prior:
            if prior['payload_hash']!=payload:raise HTTPException(409,'Ключ дополнительного факта уже использован для другой записи.')
            return {'revision':revision,'installed':[r['element']['id'] for r in prior['items']],'already_completed':True}
        _version(revision,body.revision)
        crew=next((c for c in state['crews'] if c['id']==body.crew_id and c['kind']=='installation'),None)
        if not crew:raise HTTPException(422,'Выберите монтажную бригаду.')
        now=body.completed_at or datetime.now(ZoneInfo('Europe/Moscow'))
        if now.tzinfo:now=now.astimezone(ZoneInfo('Europe/Moscow'))
        now=now.replace(tzinfo=None,microsecond=0)
        start=datetime.combine(body.date,datetime.min.time()).replace(hour=8)
        if not start<=now<start+timedelta(days=1):
            raise HTTPException(422,'Дополнительный факт должен попадать с 08:00 выбранной даты до 08:00 следующего дня. Уточните дату и время.')
        _unique([r.model_dump() for r in body.items],'element_id','Дополнительный факт')
        statuses=status_montage(conn,object_id);elements={e['id']:e for e in _elements(conn,object_id)}
        planned={r['id'] for r in fact_rows(conn,object_id,state,statuses,body.date.isoformat()) if r['orders']}
        for item in body.items:
            e=elements.get(item.element_id)
            if not e or not e.get('is_current',1):raise HTTPException(422,'Изделие отсутствует в актуальной модели объекта.')
            if item.element_id in planned:raise HTTPException(409,'Изделие уже включено в СНЗ выбранной даты. Отметьте его во вкладке «Факт».')
            if statuses[item.element_id]['expected_rev']!=item.expected_rev or e['current_status'] in ('installed','accepted'):
                raise HTTPException(409,'Статус выбранного изделия изменился. Обновите данные перед записью.')
        installed=[]
        for item in body.items:
            eid=item.element_id
            apply_status_change(conn,eid,'installed',False,None,now.isoformat(sep=' ',timespec='seconds'),
                                'Дополнительный факт монтажа вне СНЗ',audit_display_name(user),user['id'])
            if conn.execute('SELECT current_status FROM elements WHERE id=?',(eid,)).fetchone()[0] not in ('installed','accepted'):
                raise HTTPException(409,'После указанного времени есть другой статус. Проверьте время монтажа.')
            installed.append(eid)
        statuses=status_montage(conn,object_id)
        store['extra'][body.request_id]={'date':body.date.isoformat(),'crew_id':crew['id'],'crew':crew,
            'payload_hash':payload,'created_by':audit_display_name(user),'created_at':now.isoformat(timespec='seconds'),
            'items':[{'element':elements[eid],'history_id':statuses[eid]['history_id'],
                      'shift':'day' if now<start+timedelta(hours=12) else 'night'} for eid in installed]}
        for eid in installed:
            state['facts'].setdefault(f'e:{eid}:install',{})
        project_montage(state,statuses);_write(conn,object_id,state,revision);touch_elements(conn,installed);conn.commit()
        activity.defer_flush(events)
        activity.log('snz_fact',user=user,entity_type='object',entity_id=object_id,
                     details={'action':'extra','installed':installed,'date':body.date.isoformat(),'crew_id':crew['id']})
        return {'revision':revision+1,'installed':installed}
    finally:activity.defer_end(events);conn.close()


@router.post("/facts")
def complete(object_id: int, body: FactIn, user=Depends(get_current_user)):
    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, "status", "write")
        state, revision = _load(conn, object_id)
        history = _history(conn, object_id)
        if body.order_id is None:
            from app.snz_closure import closed_orders
            if any(body.task_key in closed.get("facts",{}) for closed in closed_orders(conn,object_id).values()):
                raise HTTPException(409,"Операция относится также к закрытому СНЗ. Обновите интерфейс и выберите действующее задание.")
        if body.order_id:
            _assert_open_order(conn,object_id,body.order_id)
            history=[o for o in history if o.get("id")==body.order_id]
        task = next((t for order in reversed(history) for t in order["tasks"] if t["key"] == body.task_key), None)
        if not task:
            raise HTTPException(422, "Отметить можно только операцию из выданного СНЗ.")
        statuses=status_montage(conn,object_id)
        if any(eid not in statuses for eid in task['element_ids']):
            raise HTTPException(409,'Изделие из СНЗ больше не принадлежит этому объекту. Обновите данные.')
        prior=state["facts"].get(body.task_key,{})
        montage=task['operation_id']=='install'
        status_done=all(statuses.get(eid,{}).get('current_status') in ('installed','accepted') for eid in task['element_ids'])
        supplied=body.completed_at
        if supplied and supplied.tzinfo:supplied=supplied.astimezone(ZoneInfo("Europe/Moscow")).replace(tzinfo=None)
        if prior.get('completed') and (not montage or status_done):
            if supplied and supplied.isoformat(timespec='seconds') != datetime.fromisoformat(prior['completed_at']).isoformat(timespec='seconds'):
                raise HTTPException(409,"Монтаж уже подтверждён. Время существующего статуса исправляется в истории изделия.")
            return {"revision": revision, "already_completed": True,"installed":[],"warnings":[]}
        _version(revision, body.revision)
        if body.expected_montage_rev and (not montage or len(task['element_ids'])!=1 or statuses[task['element_ids'][0]]['expected_rev']!=body.expected_montage_rev):
            raise HTTPException(409,"Статус или время монтажа изменились. Обновите вкладку «Факт».")
        now = body.completed_at or datetime.now(ZoneInfo("Europe/Moscow"))
        if now.tzinfo:now=now.astimezone(ZoneInfo("Europe/Moscow"))
        now=now.replace(tzinfo=None,microsecond=0)
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
        installed=[]
        if montage:
            from app.contracts import apply_status_change
            for eid in task['element_ids']:
                if statuses[eid]['current_status'] in ('installed','accepted'):continue
                apply_status_change(conn,eid,'installed',False,None,now.isoformat(sep=' ',timespec='seconds'),
                    'Факт монтажа из СНЗ',audit_display_name(user),user['id'])
                effective=conn.execute('SELECT current_status FROM elements WHERE id=?',(eid,)).fetchone()[0]
                if effective not in ('installed','accepted'):
                    raise HTTPException(409,"После указанного времени есть другой статус. Проверьте историю изделия и время монтажа.")
                installed.append(eid)
        state['facts'][body.task_key]={'completed':True,'completed_at':now.isoformat(timespec='seconds'),'completed_by':audit_display_name(user)}
        project_montage(state,status_montage(conn,object_id))
        _write(conn,object_id,state,revision)
        touch_elements(conn,installed)
        conn.commit()
        activity.defer_flush(events)
        activity.log("snz_fact",user=user,entity_type="object",entity_id=object_id,details={"task_key":body.task_key,"installed":installed,"completed_at":now.isoformat(timespec='seconds')})
        return {"revision":revision+1,"installed":installed,"warnings":list(dict.fromkeys(warnings))}
    finally:
        activity.defer_end(events)
        conn.close()


@router.get("/facts/report.xlsx")
def export_fact_xlsx(object_id: int, date: date, shift: Literal['day','night'] | None = None,
                     crew_id: str | None = None, user=Depends(get_current_user)):
    from app.snz_fact_report import report,build_xlsx
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'plan','read')
        state,_=_load(conn,object_id)
        data=build_xlsx(report(conn,object_id,state,date.isoformat(),shift,crew_id))
        return Response(data,media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        headers={'Content-Disposition':f'attachment; filename="SNZ-facts-{date.isoformat()}.xlsx"'})
    finally:conn.close()


@router.get("/facts/report.pdf")
def export_fact_pdf(object_id: int, date: date, shift: Literal['day','night'] | None = None,
                    crew_id: str | None = None, user=Depends(get_current_user)):
    from app.snz_fact_report import report,drawing_order
    from app.snz_export import build_pdf
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'plan','read')
        state,_=_load(conn,object_id);data=report(conn,object_id,state,date.isoformat(),shift,crew_id)
        order=drawing_order(data)
        sources={e['source_file'] for e in order['items']}
        axes=[dict(r) for source in sources for r in conn.execute('SELECT * FROM axis_lines WHERE source_file=?',(source,))]
        zones=[dict(r) for r in conn.execute("SELECT id,name,outline_json FROM zones WHERE object_id=? AND category='Захватка'",(object_id,))]
        colors={r['status']:r['color'] for r in conn.execute('SELECT status,color FROM status_colors')}
        return Response(build_pdf(order,_elements(conn,object_id),axes,zones,colors,state['floor_levels']),media_type='application/pdf',
                        headers={'Content-Disposition':f'attachment; filename="SNZ-facts-{date.isoformat()}.pdf"'})
    finally:conn.close()


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
        zones = [dict(r) for r in conn.execute("SELECT id,name,outline_json FROM zones WHERE object_id=? AND category='Захватка'", (object_id,))]
        colors = {r["status"]:r["color"] for r in conn.execute("SELECT status,color FROM status_colors")}
        return Response(build_pdf(order, _elements(conn, object_id), axes, zones, colors, _load(conn, object_id)[0]["floor_levels"]), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="SNZ-{order_id}.pdf"'})
    finally:
        conn.close()

"""Подготовка конкурсов СМР: РД → работы ↔ лоты → ВОР → ТЗ → факт 1С.

Ссылки регистрируют документы в принятом хранилище; файлы не объединяются,
запросы к 1С не отправляются. Все изменения сериализованы ревизией объекта.
"""
import json
import sqlite3
from datetime import date, datetime
from zoneinfo import ZoneInfo
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app import activity
from app.access import accessible_object_ids, assert_object_feature, has_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection

router = APIRouter(prefix="/objects/{object_id}/contracting-plan", tags=["contracting-plan"])
FEATURE = "contracting_plan"
TABLES = {"rd": "cp_rd", "work": "cp_works", "lot": "cp_lots", "assignment": "cp_assignments", "document": "cp_documents"}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Rd(Strict):
    id: Optional[int] = Field(default=None, gt=0)
    code: str = Field(min_length=1, max_length=150)
    name: str = Field(min_length=1, max_length=500)
    responsible_id: Optional[int] = Field(default=None, gt=0)
    composition_confirmed: bool = False
    note: str = Field(default="", max_length=4000)
    customer_agreement: str = Field(default="", max_length=4000)


class Work(Strict):
    id: Optional[int] = Field(default=None, gt=0)
    rd_id: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=500)
    classifier_id: Optional[int] = Field(default=None, gt=0)
    required_start: Optional[date] = None
    note: str = Field(default="", max_length=4000)


class Lot(Strict):
    id: Optional[int] = Field(default=None, gt=0)
    code: str = Field(min_length=1, max_length=150)
    title: str = Field(min_length=1, max_length=500)
    pto_id: Optional[int] = Field(default=None, gt=0)
    required_start: Optional[date] = None
    vor_due: Optional[date] = None
    tz_due: Optional[date] = None
    note: str = Field(default="", max_length=4000)
    gpr_note: str = Field(default="", max_length=4000)


class Assignment(Strict):
    id: Optional[int] = Field(default=None, gt=0)
    lot_id: int = Field(gt=0)
    work_id: int = Field(gt=0)
    share: int = Field(ge=1, le=100)
    scope: str = Field(min_length=1, max_length=1000)
    rd_planned: Optional[date] = None
    rd_agreed: Optional[date] = None
    rd_issued: Optional[date] = None
    rd_sufficient: bool = False
    rd_scope: str = Field(default="", max_length=2000)
    rd_ref: str = Field(default="", max_length=2000)


class Document(Strict):
    id: Optional[int] = Field(default=None, gt=0)
    lot_id: int = Field(gt=0)
    kind: Literal["vor", "tz"]
    number: str = Field(min_length=1, max_length=200)
    document_date: date
    reference: str = Field(min_length=1, max_length=2000)
    note: str = Field(default="", max_length=4000)
    item_ids: list[int] = Field(min_length=1, max_length=1000)


class Target(Strict):
    id: int = Field(gt=0)
    reason: str = Field(default="", max_length=4000)


class Upload(Strict):
    id: int = Field(gt=0)
    tz_id: int = Field(gt=0)
    uploaded_date: date
    upload_ref: str = Field(min_length=1, max_length=2000)


class Command(Strict):
    expected_revision: int = Field(ge=0)
    action: Literal["save_rd", "save_work", "save_lot", "save_assignment", "save_document", "delete_rd", "delete_work", "delete_assignment", "delete_document", "archive", "restore", "upload", "reopen"]
    payload: dict


def fail(message, status=400):
    raise HTTPException(status_code=status, detail=message)


def row(conn, entity, object_id, record_id):
    r = conn.execute(f"SELECT * FROM {TABLES[entity]} WHERE id=? AND object_id=?", (record_id, object_id)).fetchone()
    if r is None:
        fail("Запись не найдена на этом объекте", 404)
    return dict(r)


def _future(value, title):
    if value and str(value) > datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat():
        fail(f"{title}: фактическая дата не может быть в будущем")


def _person(conn, object_id, person_id):
    if person_id is None:
        return
    user = conn.execute("SELECT * FROM users WHERE id=?", (person_id,)).fetchone()
    if user is None:
        fail("Ответственный не найден")
    allowed = accessible_object_ids(conn, user)
    if allowed is not None and object_id not in allowed:
        fail("Ответственный не имеет доступа к этому объекту")


def _editable(conn, object_id, lot_ids):
    for lot_id in set(lot_ids):
        lot = row(conn, "lot", object_id, lot_id)
        if lot["archived_at"] or lot["uploaded_date"]:
            fail("Лот в архиве или завершён: сначала восстановите или возобновите его", 409)


def _work_lots(conn, object_id, work_ids):
    return [r[0] for wid in work_ids for r in conn.execute("SELECT lot_id FROM cp_assignments WHERE object_id=? AND work_id=?", (object_id, wid))]


def _related_work_ids(conn, object_id, rd_id):
    return [r[0] for r in conn.execute("SELECT id FROM cp_works WHERE object_id=? AND rd_id=?", (object_id, rd_id))]


def _save(conn, table, object_id, values, record_id):
    if record_id:
        conn.execute(f"UPDATE {table} SET {','.join(k+'=?' for k in values)} WHERE id=? AND object_id=?", [*values.values(), record_id, object_id])
        return record_id
    values = {"object_id": object_id, **values}
    return conn.execute(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", list(values.values())).lastrowid


def snapshot(conn, object_id, user):
    data = {key: [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE object_id=? ORDER BY id", (object_id,))] for key, table in TABLES.items()}
    state = conn.execute("SELECT revision FROM cp_state WHERE object_id=?", (object_id,)).fetchone()
    data["revision"] = state[0] if state else 0
    data["can_write"] = has_feature(conn, user, FEATURE, "write", object_id)
    data["document_work"] = [dict(r) for r in conn.execute("SELECT i.* FROM cp_document_work i JOIN cp_documents d ON d.id=i.document_id WHERE d.object_id=?", (object_id,))]
    data["tz_vor"] = [dict(r) for r in conn.execute("SELECT i.* FROM cp_tz_vor i JOIN cp_documents d ON d.id=i.tz_id WHERE d.object_id=?", (object_id,))]
    lots = {r["id"]: r for r in data["lot"]}
    docs = {r["id"]: r for r in data["document"]}
    works = {r["id"]: r for r in data["work"]}
    rds = {r["id"]: r for r in data["rd"]}
    today = datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    for work in data["work"]:
        work["allocated_share"] = sum(a["share"] for a in data["assignment"] if a["work_id"] == work["id"] and (not lots[a["lot_id"]]["archived_at"] or lots[a["lot_id"]]["uploaded_date"]))
    for lot in data["lot"]:
        assignments = [a for a in data["assignment"] if a["lot_id"] == lot["id"]]
        ids = {a["work_id"] for a in assignments}
        reasons = []
        if not ids:
            reasons.append("Нет состава работ")
        if any(works[w]["allocated_share"] != 100 for w in ids):
            reasons.append("Работы лота распределены не на 100% по действующим/завершённым лотам")
        if not lot["required_start"]:
            reasons.append("Не задан требуемый старт СМР лота")
        if not lot["pto_id"]:
            reasons.append("Не назначен ответственный ПТО")
        if any(not works[w]["required_start"] for w in ids):
            reasons.append("Не задан требуемый старт СМР работы")
        if any(not rds[works[w]["rd_id"]]["composition_confirmed"] for w in ids):
            reasons.append("Не подтверждена полнота детализации РД")
        if any(not rds[works[w]["rd_id"]]["responsible_id"] for w in ids):
            reasons.append("Не назначен ответственный по РД")
        rd_ready = bool(ids) and all(a["rd_sufficient"] and a["rd_issued"] and a["rd_scope"].strip() and a["rd_ref"].strip() for a in assignments)
        if not rd_ready:
            reasons.append("Не подтверждена достаточная для конкурса РД по каждой части работ")
        vors = [d for d in data["document"] if d["lot_id"] == lot["id"] and d["kind"] == "vor"]
        vor_ids = {d["id"] for d in vors}
        covered = {i["work_id"] for i in data["document_work"] if i["document_id"] in vor_ids}
        vor_ready = bool(ids) and ids <= covered
        if not vor_ready:
            reasons.append("ВОР не покрывают все работы лота")
        valid_tzs = []
        for tz in (d for d in data["document"] if d["lot_id"] == lot["id"] and d["kind"] == "tz"):
            included = {i["vor_id"] for i in data["tz_vor"] if i["tz_id"] == tz["id"]}
            tz_covered = {i["work_id"] for i in data["document_work"] if i["document_id"] in included}
            if ids and ids <= tz_covered and included <= vor_ids:
                valid_tzs.append(tz["id"])
        if not valid_tzs:
            reasons.append("Нет ТЗ со всеми необходимыми ВОР")
        # Завершение относится к зафиксированному составу; новые работы той же РД живут дальше.
        lot["blockers"] = [] if lot["uploaded_date"] and lot["completion_json"] else reasons
        lot["valid_tz_ids"] = valid_tzs
        lot["status"] = "archived" if lot["archived_at"] else ("completed" if lot["uploaded_date"] else ("rd" if not rd_ready else "vor" if not vor_ready else "tz" if not valid_tzs else "upload"))
        lot["overdue"] = bool(not lot["archived_at"] and not lot["uploaded_date"] and ((lot["required_start"] and lot["required_start"] < today) or (not vor_ready and lot["vor_due"] and lot["vor_due"] < today) or (not valid_tzs and lot["tz_due"] and lot["tz_due"] < today) or any(not a["rd_sufficient"] and (a["rd_agreed"] or a["rd_planned"] or "9999") < today for a in assignments)))
    data["completeness"] = {"rd_without_works": [r["id"] for r in data["rd"] if not any(w["rd_id"] == r["id"] for w in data["work"])], "rd_unconfirmed": [r["id"] for r in data["rd"] if not r["composition_confirmed"]], "unallocated_works": [w["id"] for w in data["work"] if w["allocated_share"] != 100]}
    # Только люди, имеющие доступ к этому объекту; не раскрываем общесервисный справочник.
    data["people"] = []
    for person in conn.execute("SELECT * FROM users ORDER BY last_name,first_name"):
        allowed = accessible_object_ids(conn, person)
        if allowed is None or object_id in allowed:
            data["people"].append({"id": person["id"], "name": " ".join(str(person[k] or "") for k in ("last_name", "first_name", "patronymic")).strip()})
    data["classifier"] = [dict(r) for r in conn.execute("SELECT id,code,name,path FROM work_classifier WHERE retired_at IS NULL ORDER BY sort_order,id")]
    data["history"] = [dict(r) for r in conn.execute("SELECT h.*,u.last_name AS actor FROM cp_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.object_id=? ORDER BY h.id DESC LIMIT 200", (object_id,))]
    return data


@router.get("")
def get_plan(object_id: int, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        conn.execute("BEGIN")
        assert_object_feature(conn, user, object_id, FEATURE, "read")
        return snapshot(conn, object_id, user)
    finally:
        conn.close()


@router.get("/history")
def get_history(object_id: int, before_id: int = Query(gt=0), user=Depends(get_current_user)):
    conn = get_connection()
    try:
        conn.execute("BEGIN")
        assert_object_feature(conn, user, object_id, FEATURE, "read")
        return [dict(r) for r in conn.execute(
            "SELECT h.*,u.last_name AS actor FROM cp_history h LEFT JOIN users u ON u.id=h.user_id "
            "WHERE h.object_id=? AND h.id<? ORDER BY h.id DESC LIMIT 200", (object_id, before_id))]
    finally:
        conn.close()


@router.post("/commands")
def command(object_id: int, body: Command, user=Depends(get_current_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        assert_object_feature(conn, user, object_id, FEATURE, "write")
        conn.execute("INSERT OR IGNORE INTO cp_state(object_id) VALUES (?)", (object_id,))
        revision = conn.execute("SELECT revision FROM cp_state WHERE object_id=?", (object_id,)).fetchone()[0]
        if body.expected_revision != revision:
            fail("График изменён другим пользователем. Обновите данные; введённые значения сохранены в форме.", 409)
        action = body.action
        model = {"save_rd": Rd, "save_work": Work, "save_lot": Lot, "save_assignment": Assignment, "save_document": Document, "upload": Upload}.get(action, Target)
        try:
            payload = model.model_validate(body.payload).model_dump(mode="json")
        except ValidationError as exc:
            fail("Проверьте поля: " + "; ".join('.'.join(map(str, e['loc'])) + ': ' + e['msg'] for e in exc.errors()))
        # Пустое/пробельное значение не является документом, названием или частью работ.
        for key in ("code", "name", "title", "scope", "number", "reference", "upload_ref"):
            if key in payload:
                payload[key] = payload[key].strip()
                if not payload[key]:
                    fail(f"Поле {key} обязательно")
        rid = payload.get("id")
        entity = action.split("_", 1)[1] if action.startswith(("save_", "delete_")) else "lot"
        before = row(conn, entity, object_id, rid) if rid else None
        audit_before = before
        if action == "save_rd":
            _person(conn, object_id, payload["responsible_id"])
            if payload["composition_confirmed"] and not (rid and _related_work_ids(conn, object_id, rid)):
                fail("Сначала добавьте виды работ марки, затем подтвердите полноту состава")
            rid = _save(conn, "cp_rd", object_id, {k: v for k, v in payload.items() if k != "id"}, rid)
        elif action == "save_work":
            row(conn, "rd", object_id, payload["rd_id"])
            if rid:
                _editable(conn, object_id, _work_lots(conn, object_id, [rid]))
                if before["rd_id"] != payload["rd_id"] and _work_lots(conn, object_id, [rid]):
                    fail("Сначала снимите работу с лотов перед сменой марки РД", 409)
            if before and any(before[k] != payload[k] for k in ("title", "rd_id", "classifier_id")) and conn.execute("SELECT 1 FROM cp_document_work WHERE work_id=?", (rid,)).fetchone():
                fail("Работа включена в ВОР: сначала актуализируйте состав документов перед изменением вида работ", 409)
            if payload["classifier_id"] and conn.execute("SELECT 1 FROM work_classifier WHERE id=? AND retired_at IS NULL", (payload["classifier_id"],)).fetchone() is None:
                fail("Позиция кодификатора не найдена")
            rid = _save(conn, "cp_works", object_id, {k: v for k, v in payload.items() if k != "id"}, rid)
            conn.execute("UPDATE cp_rd SET composition_confirmed=0 WHERE id IN (?,?)", (payload["rd_id"], before["rd_id"] if before else payload["rd_id"]))
        elif action == "save_lot":
            _person(conn, object_id, payload["pto_id"])
            if rid:
                _editable(conn, object_id, [rid])
            rid = _save(conn, "cp_lots", object_id, {k: v for k, v in payload.items() if k != "id"}, rid)
        elif action == "save_assignment":
            row(conn, "work", object_id, payload["work_id"])
            _editable(conn, object_id, [payload["lot_id"], *([before["lot_id"]] if before else [])])
            if before and (before["work_id"], before["lot_id"]) != (payload["work_id"], payload["lot_id"]):
                fail("Для переноса снимите назначение и создайте новое")
            if before and any(before[k] != payload[k] for k in ("share", "scope")) and conn.execute("SELECT 1 FROM cp_document_work i JOIN cp_documents d ON d.id=i.document_id WHERE d.lot_id=? AND i.work_id=?", (before["lot_id"], before["work_id"])).fetchone():
                fail("Часть работ включена в ВОР: сначала актуализируйте документы перед изменением границ или доли", 409)
            share = conn.execute("SELECT COALESCE(SUM(a.share),0) FROM cp_assignments a JOIN cp_lots l ON l.id=a.lot_id WHERE a.object_id=? AND a.work_id=? AND (l.archived_at IS NULL OR l.uploaded_date IS NOT NULL) AND a.id!=?", (object_id, payload["work_id"], rid or 0)).fetchone()[0]
            if share + payload["share"] > 100:
                fail("Сумма распределения работы по активным лотам превышает 100%")
            _future(payload["rd_issued"], "Выдача РД")
            if payload["rd_sufficient"] and not all(str(payload[k] or "").strip() for k in ("rd_issued", "rd_scope", "rd_ref")):
                fail("Для достаточной РД нужны дата выдачи, описание выданной части и ссылка/реквизиты документа")
            rid = _save(conn, "cp_assignments", object_id, {k: v for k, v in payload.items() if k != "id"}, rid)
        elif action == "save_document":
            _editable(conn, object_id, [payload["lot_id"], *([before["lot_id"]] if before else [])])
            if before and (before["lot_id"], before["kind"]) != (payload["lot_id"], payload["kind"]):
                fail("Вид документа и лот изменять нельзя")
            _future(payload["document_date"], "Документ")
            ids = payload.pop("item_ids")
            if len(ids) != len(set(ids)):
                fail("Повторяющиеся позиции документа")
            kind = payload["kind"]
            for iid in ids:
                if kind == "vor":
                    if conn.execute("SELECT 1 FROM cp_assignments WHERE object_id=? AND lot_id=? AND work_id=?", (object_id, payload["lot_id"], iid)).fetchone() is None:
                        fail("ВОР может включать только работы своего лота")
                else:
                    d = row(conn, "document", object_id, iid)
                    if d["kind"] != "vor" or d["lot_id"] != payload["lot_id"]:
                        fail("ТЗ может включать только ВОР своего лота")
                    if d["document_date"] > payload["document_date"]:
                        fail("Дата ТЗ не может предшествовать включённому ВОР")
            if before:
                audit_before = {**before, "items": [list(r) for r in conn.execute("SELECT * FROM cp_document_work WHERE document_id=?" if kind == "vor" else "SELECT * FROM cp_tz_vor WHERE tz_id=?", (rid,))]}
                if kind == "vor" and conn.execute("SELECT 1 FROM cp_tz_vor WHERE vor_id=?", (rid,)).fetchone():
                    fail("ВОР включена в ТЗ: сначала измените состав ТЗ или удалите его", 409)
            rid = _save(conn, "cp_documents", object_id, {k: v for k, v in payload.items() if k != "id"}, rid)
            conn.execute("DELETE FROM cp_document_work WHERE document_id=?" if kind == "vor" else "DELETE FROM cp_tz_vor WHERE tz_id=?", (rid,))
            conn.executemany("INSERT INTO cp_document_work VALUES (?,?)" if kind == "vor" else "INSERT INTO cp_tz_vor VALUES (?,?)", [(rid, iid) for iid in ids])
            payload["item_ids"] = ids
        elif action.startswith("delete_"):
            if entity == "rd":
                if _related_work_ids(conn, object_id, rid):
                    fail("Марка содержит работы: сначала удалите их", 409)
            elif entity == "work":
                if _work_lots(conn, object_id, [rid]):
                    fail("Работа распределена по лотам: сначала снимите назначения", 409)
                conn.execute("UPDATE cp_rd SET composition_confirmed=0 WHERE id=?", (before["rd_id"],))
            else:
                _editable(conn, object_id, [before["lot_id"]])
                if entity == "assignment" and conn.execute("SELECT 1 FROM cp_document_work i JOIN cp_documents d ON d.id=i.document_id WHERE d.lot_id=? AND i.work_id=?", (before["lot_id"], before["work_id"])).fetchone():
                    fail("Работа включена в ВОР: сначала измените документы", 409)
                if entity == "document":
                    audit_before = {**before, "items": [list(r) for r in conn.execute("SELECT * FROM cp_document_work WHERE document_id=?" if before["kind"] == "vor" else "SELECT * FROM cp_tz_vor WHERE tz_id=?", (rid,))]}
                if entity == "document" and conn.execute("SELECT 1 FROM cp_tz_vor WHERE vor_id=?", (rid,)).fetchone():
                    fail("ВОР включена в ТЗ: сначала измените состав ТЗ", 409)
            conn.execute(f"DELETE FROM {TABLES[entity]} WHERE id=? AND object_id=?", (rid, object_id))
        elif action == "archive":
            if not payload["reason"].strip():
                fail("Укажите причину вывода лота из работы")
            if before["archived_at"]:
                fail("Лот уже в архиве", 409)
            conn.execute("UPDATE cp_lots SET archived_at=datetime('now'),archive_reason=? WHERE id=?", (payload["reason"], rid))
        elif action == "restore":
            if not before["archived_at"]:
                fail("Лот уже активен", 409)
            for a in conn.execute("SELECT * FROM cp_assignments WHERE lot_id=?", (rid,)):
                total = conn.execute("SELECT COALESCE(SUM(a.share),0) FROM cp_assignments a JOIN cp_lots l ON l.id=a.lot_id WHERE a.work_id=? AND (l.archived_at IS NULL OR l.uploaded_date IS NOT NULL) AND l.id!=?", (a["work_id"], rid)).fetchone()[0]
                if total + a["share"] > 100:
                    fail("Восстановление превысит 100% распределения работы; сначала исправьте активные лоты", 409)
            conn.execute("UPDATE cp_lots SET archived_at=NULL,archive_reason='' WHERE id=?", (rid,))
        elif action == "upload":
            _editable(conn, object_id, [rid])
            current = snapshot(conn, object_id, user)
            lot = next(l for l in current["lot"] if l["id"] == rid)
            if lot["blockers"]:
                fail("Нельзя завершить лот: " + "; ".join(lot["blockers"]), 409)
            if payload["tz_id"] not in lot["valid_tz_ids"]:
                fail("Выберите ТЗ, покрывающее весь состав работ лота")
            _future(payload["uploaded_date"], "Загрузка в 1С")
            tz = row(conn, "document", object_id, payload["tz_id"])
            if payload["uploaded_date"] < tz["document_date"]:
                fail("Факт загрузки не может предшествовать дате ТЗ")
            assignments = [a for a in current["assignment"] if a["lot_id"] == rid]
            if any(a["rd_issued"] > payload["uploaded_date"] for a in assignments):
                fail("Факт загрузки не может предшествовать выдаче достаточной РД")
            work_ids = {a["work_id"] for a in assignments}
            rd_ids = {w["rd_id"] for w in current["work"] if w["id"] in work_ids}
            frozen = {"people": current["people"], "lot": lot, "assignment": assignments, "work": [w for w in current["work"] if w["id"] in work_ids], "rd": [r for r in current["rd"] if r["id"] in rd_ids], "document": [d for d in current["document"] if d["lot_id"] == rid], "document_work": [i for i in current["document_work"] if i["document_id"] in {d["id"] for d in current["document"] if d["lot_id"] == rid}], "tz_vor": [i for i in current["tz_vor"] if i["tz_id"] in {d["id"] for d in current["document"] if d["lot_id"] == rid}]}
            conn.execute("UPDATE cp_lots SET uploaded_date=?,upload_ref=?,uploaded_tz_id=?,completion_json=? WHERE id=?", (payload["uploaded_date"], payload["upload_ref"], payload["tz_id"], json.dumps(frozen, ensure_ascii=False), rid))
        elif action == "reopen":
            if not before["uploaded_date"] or before["archived_at"]:
                fail("Возобновить можно завершённый активный лот", 409)
            if not payload["reason"].strip():
                fail("Укажите причину снятия факта загрузки в 1С")
            conn.execute("UPDATE cp_lots SET uploaded_date=NULL,upload_ref='',uploaded_tz_id=NULL,completion_json=NULL WHERE id=?", (rid,))
        conn.execute("UPDATE cp_state SET revision=revision+1 WHERE object_id=?", (object_id,))
        conn.execute("INSERT INTO cp_history(object_id,user_id,action,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)", (object_id, user["id"], action, rid, json.dumps(audit_before, ensure_ascii=False), json.dumps(payload, ensure_ascii=False)))
        result = snapshot(conn, object_id, user)
        conn.commit()
        activity.log("contracting_plan_change", user=user, entity_type="object", entity_id=object_id, details={"action": action, "id": rid})
        return result
    except sqlite3.IntegrityError:
        conn.rollback()
        fail("Повторяющийся шифр/назначение или запись используется другими документами", 409)
    finally:
        conn.close()

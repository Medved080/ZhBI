"""Persistent, versioned procurement snapshots. Service-wide opt-in permission."""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app import activity
from app.access import require_service_feature
from app.db import begin_write, get_connection
from app.procurement import build_report, parse_xlsx, validate_allocations
from app.upload_limits import read_upload_limited

router = APIRouter(prefix="/procurement", tags=["procurement"])
read_user = require_service_feature("procurement", "read")
write_user = require_service_feature("procurement", "write")


def load_snapshot(conn, snapshot_id):
    row = conn.execute("SELECT * FROM procurement_snapshots WHERE id=?", (snapshot_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Загрузка не найдена")
    data = json.loads(row["data_json"])
    mappings = {r["order_line_id"]: json.loads(r["allocations_json"]) for r in conn.execute(
        "SELECT * FROM procurement_allocations WHERE snapshot_id=?", (snapshot_id,))}
    return row, data, mappings


def import_snapshot(conn, data, filename, user_id):
    """Called under BEGIN IMMEDIATE. Same bytes are idempotent; history retained."""
    old = conn.execute("SELECT id FROM procurement_snapshots WHERE sha256=?", (data["sha256"],)).fetchone()
    if old:
        return {"id": old["id"], "unchanged": True, "carried_mappings": 0}
    latest = conn.execute("SELECT id FROM procurement_snapshots ORDER BY id DESC LIMIT 1").fetchone()
    cursor = conn.execute("INSERT INTO procurement_snapshots(filename,sha256,data_json,created_by) VALUES(?,?,?,?)",
                          (filename, data["sha256"], json.dumps(data, ensure_ascii=False), user_id))
    sid = cursor.lastrowid
    carried = 0
    if latest:
        _, previous, mappings = load_snapshot(conn, latest["id"])
        old_orders = {r["id"]: r for r in previous["orders"]}
        old_requests = {r["id"]: r for r in previous["requests"]}
        new_requests = {r["id"]: r for r in data["requests"]}
        signature = lambda r: {k: v for k, v in r.items() if k != "source_rows"}
        for order in data["orders"]:
            oid = order["id"]
            if oid not in mappings or oid not in old_orders or signature(order) != signature(old_orders[oid]):
                continue
            alloc = mappings[oid]
            if any(a["request_line_id"] not in new_requests or signature(new_requests[a["request_line_id"]]) != signature(old_requests[a["request_line_id"]]) for a in alloc):
                continue
            validate_allocations(data, oid, alloc)
            conn.execute("INSERT INTO procurement_allocations(snapshot_id,order_line_id,allocations_json,updated_by) VALUES(?,?,?,?)",
                         (sid, oid, json.dumps(alloc), user_id))
            carried += 1
    return {"id": sid, "unchanged": False, "carried_mappings": carried}


def uploaded(file):
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(422, "Выберите файл .xlsx с листами ЗВП, ЗП и Оплаты ЗРДС")
    raw = read_upload_limited(file.file)
    try:
        return parse_xlsx(raw)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.post("/import/analyze")
def analyze(file: UploadFile = File(...), user=Depends(write_user)):
    data = uploaded(file)
    report = build_report(data)
    return {"sha256": data["sha256"], "summary": report["summary"], "rows": data["rows"], "warnings": data["warnings"]}


@router.post("/import/apply")
def apply(file: UploadFile = File(...), expected_sha256: str = Form(...), user=Depends(write_user)):
    data = uploaded(file)
    if data["sha256"] != expected_sha256:
        raise HTTPException(409, "Файл изменился после анализа. Выполните анализ заново")
    conn = get_connection()
    try:
        begin_write(conn)
        result = import_snapshot(conn, data, (file.filename or "Загрузка.xlsx").replace("\\", "/").split("/")[-1][:240], user["id"])
        conn.commit()
    finally:
        conn.close()
    activity.log("procurement_import", user=user, entity_type="procurement_snapshot", entity_id=result["id"],
                 details={"sha256": data["sha256"], **result})
    return result


@router.get("/snapshots")
def snapshots(user=Depends(read_user)):
    conn = get_connection()
    try:
        return {"items": [dict(r) for r in conn.execute(
            "SELECT id,filename,sha256,created_at,revision FROM procurement_snapshots ORDER BY id DESC")]}
    finally:
        conn.close()


@router.get("/snapshots/{snapshot_id}")
def report(snapshot_id: int, user=Depends(read_user)):
    conn = get_connection()
    try:
        row, data, mappings = load_snapshot(conn, snapshot_id)
        return {**build_report(data, mappings), "id": snapshot_id, "revision": row["revision"], "filename": row["filename"]}
    finally:
        conn.close()


class Allocation(BaseModel):
    request_line_id: str = Field(min_length=1, max_length=64)
    order_qty: float = Field(gt=0, allow_inf_nan=False)
    request_qty: float = Field(gt=0, allow_inf_nan=False)


class MappingChange(BaseModel):
    expected_revision: int = Field(ge=0)
    allocations: list[Allocation] = Field(max_length=500)
    reset: bool = False


@router.put("/snapshots/{snapshot_id}/allocations/{order_line_id}")
def save_mapping(snapshot_id: int, order_line_id: str, body: MappingChange, user=Depends(write_user)):
    conn = get_connection()
    try:
        begin_write(conn)
        row, data, mappings = load_snapshot(conn, snapshot_id)
        if row["revision"] != body.expected_revision:
            raise HTTPException(409, "Сопоставления изменены в другой вкладке. Обновите анализ и повторите")
        try:
            allocations = validate_allocations(data, order_line_id, [a.model_dump() for a in body.allocations])
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        before = mappings.get(order_line_id)
        if body.reset:
            conn.execute("DELETE FROM procurement_allocations WHERE snapshot_id=? AND order_line_id=?", (snapshot_id, order_line_id))
        else:
            conn.execute("INSERT INTO procurement_allocations(snapshot_id,order_line_id,allocations_json,updated_by) VALUES(?,?,?,?) "
                         "ON CONFLICT(snapshot_id,order_line_id) DO UPDATE SET allocations_json=excluded.allocations_json, "
                         "updated_by=excluded.updated_by,updated_at=datetime('now')",
                         (snapshot_id, order_line_id, json.dumps(allocations), user["id"]))
        conn.execute("UPDATE procurement_snapshots SET revision=revision+1 WHERE id=?", (snapshot_id,))
        conn.execute("INSERT INTO procurement_mapping_history(snapshot_id,order_line_id,before_json,after_json,changed_by) VALUES(?,?,?,?,?)",
                     (snapshot_id, order_line_id, json.dumps(before), json.dumps(None if body.reset else allocations), user["id"]))
        conn.commit()
    finally:
        conn.close()
    activity.log("procurement_mapping", user=user, entity_type="procurement_snapshot", entity_id=snapshot_id,
                 details={"order_line_id": order_line_id, "reset": body.reset, "allocations": allocations})
    return {"revision": body.expected_revision + 1}

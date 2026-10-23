"""Встроенные замеры производительности — API («Администрирование → Замеры производительности», 2026-10-23).

Сбор на сервере — `app/perf_core.py`, в браузере — `app/static/perf.js`; экран и окно-«бегущая строка» — `app/static/perf-panel.js`.

Кто что может:
* включить/выключить сбор, смотреть сводки, выгружать и очищать — только раздел `perf` (по умолчанию его нет ни у одной роли, то есть
  только администратор сервиса);
* `GET /perf/state` — любой вошедший: браузеру надо знать, идёт ли сбор (опрос раз в ~20 с), чтобы мерить и присылать пачки;
* `POST /perf/samples` — любой вошедший, но принимается только пока сбор идёт и только в текущий сбор (замеры чужого/прошлого сбора
  молча отбрасываются).

Что в таблице `perf_samples` (схема — `app/db_schema_doc.py`): `side` — server | client; `kind` — вид замера (http, fetch, screen, scene,
longtask, frame, event, page, memory, device, span); `op` — операция (для http — «GET /objects/{object_id}/blocks»); `duration_ms`;
`details` — JSON с разбивкой (у http: статус, время до первого байта, SQL, размер; у fetch: ожидание, скачивание, размер, серверное время).
Данных предметной области замеры НЕ содержат: ни марок, ни имён контрагентов — только маршруты, числа и обезличенные подписи элементов
интерфейса.
"""
import csv
import io
import json
import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import app.activity as activity
import app.perf_core as core
from app.access import has_feature, require_service_feature
from app.auth import get_current_user
from app.db import get_connection

router = APIRouter(tags=["perf"])

_KINDS = {"fetch", "screen", "scene", "longtask", "frame", "event", "page", "memory", "device", "span", "error"}
MAX_BATCH = 300


def _p(sorted_vals: list, q: float) -> float:
    """Ранговый квантиль (ближайший ранг) отсортированного списка."""
    if not sorted_vals:
        return 0.0
    i = max(0, min(len(sorted_vals) - 1, int(-(-q * len(sorted_vals) // 1)) - 1))
    return sorted_vals[i]


@router.get("/perf/state")
def perf_state(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        can = has_feature(conn, user, "perf", "write")
    finally:
        conn.close()
    return {**core.state_info(), "can_control": bool(can)}


class CaptureIn(BaseModel):
    on: bool
    minutes: Optional[int] = None


@router.post("/perf/capture")
def perf_capture(body: CaptureIn, admin: sqlite3.Row = Depends(require_service_feature("perf", "write"))):
    name = f"{admin['last_name'] or ''} {admin['first_name'] or ''}".strip() or admin["domain_login"]
    st = core.set_capture(body.on, name, body.minutes or core.DEFAULT_MINUTES)
    activity.log("perf_capture_start" if body.on else "perf_capture_stop", user=admin, entity_type="perf",
                 new_value=st.get("run_id") or "", details={"minutes": body.minutes or core.DEFAULT_MINUTES} if body.on else None)
    return {**st, "can_control": True}


class SampleIn(BaseModel):
    kind: str
    op: str
    ms: float
    ago: float = 0.0
    details: Optional[dict] = None
    object_id: Optional[int] = None


class SamplesIn(BaseModel):
    run_id: str
    client_id: str
    samples: list[SampleIn]


@router.post("/perf/samples")
def perf_samples(body: SamplesIn, user: sqlite3.Row = Depends(get_current_user)):
    run = core.current_run()
    if run is None or body.run_id != run:
        return {"accepted": 0, "on": run is not None, "run_id": run}
    name = f"{user['last_name'] or ''} {user['first_name'] or ''}".strip() or user["domain_login"]
    rows = []
    for s in body.samples[:MAX_BATCH]:
        if s.kind not in _KINDS or not (0.0 <= s.ms <= 3.6e6):
            continue
        details = None
        if s.details:
            try:
                details = json.dumps(s.details, ensure_ascii=False)
            except (TypeError, ValueError):
                details = None
            if details and len(details) > 3000:
                details = json.dumps({"усечено": details[:2900]}, ensure_ascii=False)
        rows.append({"at": core.at_ago(min(max(s.ago, 0.0), 3.6e6)), "run_id": run, "side": "client", "kind": s.kind,
                     "op": s.op[:160], "duration_ms": round(s.ms, 2), "user_id": user["id"], "user_name": name,
                     "client_id": body.client_id[:40], "object_id": s.object_id, "details": details})
    if rows:
        core.enqueue(rows)
    return {"accepted": len(rows), "dropped": len(body.samples) - len(rows), "on": True, "run_id": run}


def _resolve_run(conn: sqlite3.Connection, run_id: Optional[str]) -> Optional[str]:
    if run_id:
        return run_id
    cur = core.current_run()
    if cur:
        return cur
    row = conn.execute("SELECT run_id FROM perf_samples ORDER BY id DESC LIMIT 1").fetchone()
    return row[0] if row else None


@router.get("/perf/runs")
def perf_runs(admin: sqlite3.Row = Depends(require_service_feature("perf", "read"))):
    core.flush()
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT run_id, MIN(at) AS first_at, MAX(at) AS last_at, COUNT(*) AS n, "
            "SUM(side = 'server') AS n_server, SUM(side = 'client') AS n_client, COUNT(DISTINCT user_id) AS users "
            "FROM perf_samples GROUP BY run_id ORDER BY MIN(at) DESC").fetchall()
        total = conn.execute("SELECT COUNT(*) FROM perf_samples").fetchone()[0]
    finally:
        conn.close()
    return {"state": core.state_info(), "runs": [dict(r) for r in rows], "total": total,
            "retention_days": core.RETENTION_DAYS}


@router.get("/perf/summary")
def perf_summary(run_id: Optional[str] = Query(None), admin: sqlite3.Row = Depends(require_service_feature("perf", "read"))):
    core.flush()
    conn = get_connection()
    try:
        run = _resolve_run(conn, run_id)
        if run is None:
            return {"run_id": None, "ops": []}
        groups: dict = {}
        for side, kind, op, ms in conn.execute(
                "SELECT side, kind, op, duration_ms FROM perf_samples WHERE run_id = ? AND kind NOT IN ('device', 'memory')", (run,)):
            groups.setdefault((side, kind, op), []).append(ms or 0.0)
        extras = {}
        for r in conn.execute(
                "SELECT side, kind, op, AVG(json_extract(details, '$.ttfb_ms')) AS ttfb, AVG(json_extract(details, '$.sql_ms')) AS sql_ms, "
                "AVG(json_extract(details, '$.sql_fetch_ms')) AS sql_fetch, AVG(json_extract(details, '$.sql_n')) AS sql_n, "
                "AVG(json_extract(details, '$.bytes')) AS bytes, AVG(json_extract(details, '$.wait_ms')) AS wait, "
                "AVG(json_extract(details, '$.dl_ms')) AS dl, AVG(json_extract(details, '$.server_ms')) AS server "
                "FROM perf_samples WHERE run_id = ? AND kind IN ('http', 'fetch') GROUP BY side, kind, op", (run,)):
            extras[(r["side"], r["kind"], r["op"])] = {k: (round(r[k], 1) if r[k] is not None else None)
                                                        for k in ("ttfb", "sql_ms", "sql_fetch", "sql_n", "bytes", "wait", "dl", "server")}
        ops = []
        for (side, kind, op), vals in groups.items():
            vals.sort()
            n = len(vals)
            ops.append({"side": side, "kind": kind, "op": op, "n": n, "avg": round(sum(vals) / n, 1), "p50": round(_p(vals, 0.5), 1),
                        "p95": round(_p(vals, 0.95), 1), "max": round(vals[-1], 1), "total": round(sum(vals), 1),
                        "extra": extras.get((side, kind, op))})
        ops.sort(key=lambda o: -o["total"])
        return {"run_id": run, "ops": ops, "state": core.state_info()}
    finally:
        conn.close()


@router.get("/perf/slowest")
def perf_slowest(run_id: Optional[str] = Query(None), side: Optional[str] = Query(None), limit: int = Query(40, ge=1, le=200),
                 admin: sqlite3.Row = Depends(require_service_feature("perf", "read"))):
    core.flush()
    conn = get_connection()
    try:
        run = _resolve_run(conn, run_id)
        if run is None:
            return {"run_id": None, "items": []}
        sql = ("SELECT id, at, side, kind, op, duration_ms, user_name, client_id, object_id, details FROM perf_samples "
               "WHERE run_id = ? AND kind NOT IN ('device', 'memory')")
        args: list = [run]
        if side in ("server", "client"):
            sql += " AND side = ?"
            args.append(side)
        sql += " ORDER BY duration_ms DESC LIMIT ?"
        args.append(limit)
        return {"run_id": run, "items": [dict(r) for r in conn.execute(sql, args)]}
    finally:
        conn.close()


@router.get("/perf/clients")
def perf_clients(run_id: Optional[str] = Query(None), admin: sqlite3.Row = Depends(require_service_feature("perf", "read"))):
    """По компьютерам: кто, на какой машине, сколько замеров и насколько быстро отвечал сервер (взгляд браузера)."""
    core.flush()
    conn = get_connection()
    try:
        run = _resolve_run(conn, run_id)
        if run is None:
            return {"run_id": None, "clients": []}
        dev = {r["client_id"]: r["details"] for r in conn.execute(
            "SELECT client_id, details FROM perf_samples WHERE run_id = ? AND kind = 'device'", (run,))}
        out = {}
        for r in conn.execute("SELECT client_id, user_name, kind, side, duration_ms FROM perf_samples "
                              "WHERE run_id = ? AND side = 'client' AND kind NOT IN ('device', 'memory')", (run,)):
            c = out.setdefault(r["client_id"], {"client_id": r["client_id"], "user_name": r["user_name"], "n": 0, "fetch": [], "long": []})
            c["n"] += 1
            if r["kind"] == "fetch":
                c["fetch"].append(r["duration_ms"] or 0.0)
            elif r["kind"] in ("longtask", "frame"):
                c["long"].append(r["duration_ms"] or 0.0)
        items = []
        for cid, c in out.items():
            f = sorted(c["fetch"])
            try:
                device = json.loads(dev.get(cid) or "null")
            except ValueError:
                device = None
            items.append({"client_id": cid, "user_name": c["user_name"], "n": c["n"], "fetch_n": len(f),
                          "fetch_p50": round(_p(f, 0.5), 1), "fetch_p95": round(_p(f, 0.95), 1),
                          "long_n": len(c["long"]), "long_max": round(max(c["long"]), 1) if c["long"] else 0.0, "device": device})
        items.sort(key=lambda i: -i["n"])
        return {"run_id": run, "clients": items}
    finally:
        conn.close()


@router.get("/perf/export.csv")
def perf_export(run_id: Optional[str] = Query(None), admin: sqlite3.Row = Depends(require_service_feature("perf", "read"))):
    """Все строки сбора файлом CSV (UTF-8 с BOM — Excel открывает кириллицу сразу). Колонка details — JSON с разбивкой."""
    core.flush()
    conn = get_connection()
    run = _resolve_run(conn, run_id)
    if run is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Замеров нет: сбор ещё не запускали")
    activity.log("perf_export", user=admin, entity_type="perf", new_value=run)

    def stream():
        try:
            head = io.StringIO()
            head.write("﻿")
            w = csv.writer(head, delimiter=";")
            w.writerow(["время UTC", "сбор", "сторона", "вид", "операция", "мс", "пользователь", "компьютер", "объект", "подробности"])
            yield head.getvalue()
            buf = io.StringIO()
            w = csv.writer(buf, delimiter=";")
            i = 0
            for r in conn.execute("SELECT at, run_id, side, kind, op, duration_ms, user_name, client_id, object_id, details "
                                  "FROM perf_samples WHERE run_id = ? ORDER BY id", (run,)):
                w.writerow([r["at"], r["run_id"], r["side"], r["kind"], r["op"], str(r["duration_ms"]).replace(".", ","),
                            r["user_name"] or "", r["client_id"] or "", r["object_id"] or "", r["details"] or ""])
                i += 1
                if i % 2000 == 0:
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate()
            yield buf.getvalue()
        finally:
            conn.close()

    return StreamingResponse(stream(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="perf-{re.sub(r"[^0-9A-Za-z-]", "", run)}.csv"'})


@router.post("/perf/clear")
def perf_clear(admin: sqlite3.Row = Depends(require_service_feature("perf", "write"))):
    core.flush()
    conn = get_connection()
    try:
        n = conn.execute("DELETE FROM perf_samples").rowcount
        conn.commit()
    finally:
        conn.close()
    activity.log("perf_clear", user=admin, entity_type="perf", new_value=str(n))
    return {"deleted": n}

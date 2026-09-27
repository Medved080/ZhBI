"""Idempotent per-object transition from legacy crane polygons to stance boxes."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter

from app.crane_zone_conversion import FIELDS, build_conversion
from app.crane_zone_service import _apply_current, _assert_current_matches_version, _latest
from app.crane_zone_versions import business_date, snapshot_zones, version_for_date
from scripts.audit_crane_stance_union import read_object


class TransitionIncomplete(RuntimeError):
    pass


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _state(conn, object_id, state, version_id=None, error=None, summary=None):
    conn.execute(
        "INSERT INTO crane_zone_transition "
        "(object_id, state, conversion_version_id, last_error, summary_json, updated_at) "
        "VALUES (?, ?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(object_id) DO UPDATE SET state=excluded.state, "
        "conversion_version_id=excluded.conversion_version_id, "
        "last_error=excluded.last_error, summary_json=excluded.summary_json, "
        "updated_at=excluded.updated_at",
        (object_id, state, version_id, error, _json(summary) if summary else None),
    )


def _control(conn, object_id):
    return [tuple(row) for row in conn.execute(
        "SELECT id, element_uid, contract_id, current_status, "
        "zone_zakhvatka_id, zone_zakhvatka_status "
        "FROM elements WHERE object_id = ? AND is_current = 1 ORDER BY id",
        (object_id,),
    )]


def prepare_new_object(conn: sqlite3.Connection, object_id: int) -> bool:
    """Give a truly empty newly created object a new-format baseline.

    Existing legacy objects are never marked ready merely because they lack
    a versions row; their accumulated assignments must be audited instead.
    """
    if conn.execute("SELECT 1 FROM crane_zone_versions WHERE object_id = ?", (object_id,)).fetchone():
        return False
    if conn.execute("SELECT 1 FROM elements WHERE object_id = ? LIMIT 1", (object_id,)).fetchone() or \
       conn.execute("SELECT 1 FROM zones WHERE object_id = ? LIMIT 1", (object_id,)).fetchone():
        raise TransitionIncomplete("Существующий объект без исходной редакции требует конверсии")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO crane_zone_versions "
            "(object_id, revision_no, kind, effective_date, known_from, activated_at, "
            "zones_json, note) VALUES (?, 0, 'baseline', NULL, ?, datetime('now'), '[]', ?)",
            (object_id, business_date(), "Новый объект в формате стоянок"),
        )
        _state(conn, object_id, "ready", summary={"new_object": True})
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise


def _convert_one(conn: sqlite3.Connection, object_id: int,
                 failpoint: str | None = None) -> dict:
    """One object, one transaction; ready and its version commit together."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        prior_state = conn.execute(
            "SELECT state FROM crane_zone_transition WHERE object_id = ?", (object_id,),
        ).fetchone()
        if prior_state and prior_state["state"] == "ready":
            conn.commit()
            return {"already_ready": 1}
        completed = conn.execute(
            "SELECT * FROM crane_zone_versions WHERE object_id = ? AND kind = 'conversion'",
            (object_id,),
        ).fetchone()
        if completed is not None:
            _assert_current_matches_version(conn, object_id, completed)
            _state(conn, object_id, "ready", version_id=completed["id"],
                   summary={"recovered_committed_conversion": True})
            conn.commit()
            return {"already_ready": 1}
        future = conn.execute(
            "SELECT id, effective_date FROM crane_zone_versions WHERE object_id = ? "
            "AND activated_at IS NULL ORDER BY effective_date", (object_id,),
        ).fetchall()
        if future:
            date = future[0]["effective_date"]
            _state(conn, object_id, "waiting", error=f"Ожидается активация редакции с {date}",
                   summary={"pending_versions": [r["id"] for r in future]})
            conn.commit()
            return {"waiting": 1}
        base = version_for_date(conn, object_id, business_date())
        if base is None or base["activated_at"] is None or _latest(conn, object_id)["id"] != base["id"]:
            raise TransitionIncomplete("Нет однозначной действующей основы для конверсии")
        _assert_current_matches_version(conn, object_id, base)
        zones, elements, current, axes = read_object(conn, object_id)
        control = _control(conn, object_id)
        sources = {r["element_id"]: r["source"] for r in conn.execute(
            "SELECT element_id, source FROM crane_zone_version_assignments "
            "WHERE version_id = ? AND source = 'manual'", (base["id"],))}
        plan = build_conversion(zones, elements, axes, current, sources)
        if failpoint == "before_snapshot":
            raise RuntimeError("test failpoint before snapshot")
        cur = conn.execute(
            "INSERT INTO crane_zone_versions "
            "(object_id, revision_no, kind, effective_date, known_from, activated_at, "
            "note, zones_json, assignment_count) "
            "VALUES (?, ?, 'conversion', ?, ?, NULL, ?, ?, ?)",
            (object_id, base["revision_no"] + 1, business_date(), business_date(),
             "Переход: зона крана = объединение стоянок", _json(plan["zones"]),
             len(plan["assignments"])),
        )
        version_id = cur.lastrowid
        if failpoint == "after_snapshot":
            raise RuntimeError("test failpoint after snapshot")
        conn.executemany(
            "INSERT INTO crane_zone_version_assignments "
            "(version_id, element_id, element_uid, crane_zone_id, crane_status, "
            "stance_zone_id, stance_status, stance_elevation_mm, source, reason) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(version_id, a["element_id"], a["element_uid"], a["crane_zone_id"],
              a["crane_status"], a["stance_zone_id"], a["stance_status"],
              a["stance_elevation_mm"], a["source"],
              plan["overrides"].get(str(a["element_id"]), {}).get("reason"))
             for a in plan["assignments"]],
        )
        version = conn.execute("SELECT * FROM crane_zone_versions WHERE id = ?",
                               (version_id,)).fetchone()
        _apply_current(conn, object_id, version)
        if failpoint == "after_materialization":
            raise RuntimeError("test failpoint after materialization")
        actual_zones, _, actual, _ = read_object(conn, object_id)
        if actual_zones != plan["zones"]:
            raise TransitionIncomplete("После материализации изменился состав или свойства зон")
        if set(actual) != set(current):
            raise TransitionIncomplete("После материализации изменился состав изделий")
        expected = {a["element_id"]: a for a in plan["assignments"]}
        for element_id, old in current.items():
            if any(actual[element_id][field] != old[field] or
                   expected[element_id][field] != old[field] for field in FIELDS):
                raise TransitionIncomplete(f"Изменилось назначение изделия {element_id}")
        if _control(conn, object_id) != control:
            raise TransitionIncomplete("Изменились статус, контракт или захватка изделия")
        _assert_current_matches_version(conn, object_id, version)
        summary = {"elements": len(elements), "exceptions": sum(
            v["source"] == "conversion" for v in plan["overrides"].values()),
            "manual": sum(v["source"] == "manual" for v in plan["overrides"].values()),
            "reasons": plan["reasons"], "geometry": plan["geometry"]}
        _state(conn, object_id, "ready", version_id=version_id, summary=summary)
        conn.commit()
        return summary
    except Exception:
        conn.rollback()
        raise


def transition_pending(conn: sqlite3.Connection, *, failpoint: str | None = None) -> str:
    """Shared release/startup/timer/button handler; retries errors, skips ready."""
    ids = [r["id"] for r in conn.execute(
        "SELECT o.id FROM objects o LEFT JOIN crane_zone_transition t ON t.object_id=o.id "
        "WHERE o.kind='zhbi' AND (t.state IS NULL OR t.state <> 'ready') ORDER BY o.id"
    )]
    totals = Counter()
    errors = []
    for object_id in ids:
        try:
            result = _convert_one(conn, object_id, failpoint=failpoint)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            conn.execute("BEGIN IMMEDIATE")
            _state(conn, object_id, "error", error=message)
            conn.commit()
            errors.append(f"#{object_id}: {message}")
        else:
            totals.update({key: value for key, value in result.items()
                           if isinstance(value, int)})
    if errors or totals["waiting"]:
        raise TransitionIncomplete(
            f"успешно {totals['elements']} изделий; ожидают {totals['waiting']} объектов; "
            f"ошибок {len(errors)}" + ("; " + "; ".join(errors[:3]) if errors else "")
        )
    return f"сконвертировано изделий: {totals['elements']}; исключений: {totals['exceptions']}"

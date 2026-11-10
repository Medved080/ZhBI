"""Registry metadata is derived from issued snapshots, never live dictionaries."""
import json
from app.snz_policy import order_items


def registry(conn, object_id, work_date=None):
    sql = "SELECT id,work_date,shift,crew_id,created_at,created_by,snapshot_json FROM snz_orders WHERE object_id=?"
    args = [object_id]
    if work_date is not None:
        sql += " AND work_date=?"
        args.append(work_date)
    records, by_date, all_ids = [], {}, set()
    for row in conn.execute(sql + " ORDER BY work_date DESC,id DESC", args):
        record = dict(row)
        snapshot = json.loads(record.pop("snapshot_json"))
        ids = set(order_items(snapshot))
        record.update(order_revision=snapshot.get("order_revision", 1),
                      crew_name=snapshot["crew"]["name"], foreman=snapshot["crew"].get("foreman", ""),
                      quantity=len(ids), start=snapshot["start"], end=snapshot["end"])
        records.append(record)
        summary = by_date.setdefault(record["work_date"], {"quantity": 0, "ids": set()})
        summary["quantity"] += len(ids)
        summary["ids"].update(ids)
        all_ids.update(ids)
    return {"orders": records,
            "registry_by_date": {day: {"quantity": v["quantity"], "unique_quantity": len(v["ids"])} for day, v in by_date.items()},
            "registry_total": {"quantity": sum(r["quantity"] for r in records), "unique_quantity": len(all_ids)}}

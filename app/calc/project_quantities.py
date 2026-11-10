"""Current element counts across every object of the linked ZHBI project."""
from . import marks
from .database import PROJECT_ID


def project_quantities(calc_conn, zhbi_conn):
    products = [row["id"] for row in calc_conn.execute("SELECT id FROM products")]
    project = calc_conn.execute(
        "SELECT zhbi_project_id FROM projects WHERE id=?", (PROJECT_ID,)
    ).fetchone()
    project_id = project["zhbi_project_id"] if project else None
    linked = zhbi_conn.execute("SELECT id,name FROM projects WHERE id=?", (project_id,)).fetchone()
    if not linked:
        return {"project": None, "products": {pid: {"quantity": None, "status": "unlinked"} for pid in products}}

    strict, loose = marks.build_index(calc_conn, True), marks.build_index(calc_conn)
    counts, ambiguous = dict.fromkeys(products, 0), set()
    for row in zhbi_conn.execute("""
        SELECT e.element_type,e.mark,COUNT(*) AS quantity
        FROM elements e JOIN objects o ON o.id=e.object_id
        WHERE o.project_id=? AND e.is_current=1
        GROUP BY e.element_type,e.mark
    """, (project_id,)):
        candidates = list(strict.get(marks.normalize(row["mark"], True), {}).values())
        if not candidates:
            candidates = list(loose.get(marks.normalize(row["mark"]), {}).values())
        # A shared mark in different product types must not count as the same item.
        first = (row["element_type"] or "").split()[0].casefold() if row["element_type"] else ""
        if first:
            candidates = [c for c in candidates if not c["kind"] or first.startswith(c["kind"][:5]) or c["kind"].startswith(first[:5])]
        if len(candidates) == 1:
            counts[candidates[0]["id"]] += row["quantity"]
        elif candidates:
            ambiguous.update(c["id"] for c in candidates)
    return {
        "project": {"id": linked["id"], "name": linked["name"]},
        "products": {pid: {"quantity": None if pid in ambiguous else count,
                            "status": "ambiguous" if pid in ambiguous else "matched" if count else "not-found"}
                     for pid, count in counts.items()},
    }

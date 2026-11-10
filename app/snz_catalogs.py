"""Versioned, offline initial SNZ dictionaries; never replace manual settings.

The checked-in manifest is a reviewed projection of the source workbook, not a
spreadsheet evaluator. Only norms with a clear macro-operation mapping are used.
"""
import json
from copy import deepcopy
from pathlib import Path
from app.snz_policy import INDIVIDUAL_OPERATIONS

SEED_VERSION = "2026-11-10-oper-cards-v1"
TEAMS = [
    {"id": "1", "name": "Разнорабочие"},
    {"id": "2", "name": "Плотники"},
    {"id": "3", "name": "Монтажники"},
    {"id": "4", "name": "Арматурщики"},
]
OPERATIONS = [
    {"id": "prepare", "name": "Подготовка", "team": "1", "scope": "preparation"},
    {"id": "scaffold", "name": "Установка лесов", "team": "2", "scope": "element"},
    {"id": "install", "name": "Монтаж изделия", "team": "3", "scope": "element"},
    {"id": "rebar1", "name": "Армирование 1 этап", "team": "4", "scope": "element"},
    {"id": "concrete1", "name": "Бетонирование 1 этап", "team": "3", "scope": "element"},
    {"id": "rebar2", "name": "Армирование 2 этап", "team": "4", "scope": "element"},
    {"id": "concrete2", "name": "Бетонирование 2 этап", "team": "3", "scope": "element"},
]


def manifest():
    return json.loads(Path(__file__).with_name("snz_initial_catalogs.json").read_text(encoding="utf-8"))


def seed_catalogs(state):
    """Add missing entries exactly once, returning (new_state, skip_reason).

    A marker survives ordinary editing, including intentional deletion of a seed
    card. Rerunning the release task must not resurrect deleted configuration.
    Stable operation IDs are also used by issued task keys and group barriers.
    A conflicting scope therefore needs manual resolution instead of a guessed
    replacement. No assignments, facts, crews or historical orders are touched.
    """
    if state.get("catalog_seed"):
        return deepcopy(state), ""
    existing_ops = {o["id"]: o for o in state["operations"]}
    conflicts = [o["id"] for o in OPERATIONS
                 if o["id"] in existing_ops and existing_ops[o["id"]]["scope"] != o["scope"]
                 and not (o["id"] in INDIVIDUAL_OPERATIONS and existing_ops[o["id"]]["scope"] == "group")]
    if conflicts:
        return deepcopy(state), "область операций требует уточнения: " + ", ".join(conflicts)
    result = deepcopy(state)
    team_ids = {t["id"] for t in result["teams"]}
    mapping = {}
    for team in TEAMS:
        same = next((t for t in result["teams"] if t["name"].strip().casefold() == team["name"].casefold()), None)
        if same:
            mapping[team["id"]] = same["id"]
            continue
        key = team["id"]
        if key in team_ids:
            key = "ok_team_" + key
            suffix = 1
            while key in team_ids:
                key = f"ok_team_{team['id']}_{suffix}"
                suffix += 1
        result["teams"].append({**team, "id": key})
        team_ids.add(key)
        mapping[team["id"]] = key
    for op in OPERATIONS:
        if op["id"] not in existing_ops:
            result["operations"].append({**op, "team": mapping[op["team"]]})
    cards = result["cards"]
    for seed in manifest()["cards"]:
        # An employee may have created an equivalent card under another ID.
        def criteria(c):
            return tuple(c.get(k) or "" for k in ("element_type", "subtype", "elevation_mm", "axis_direction"))
        if any(c["id"] == seed["id"] or criteria(c) == criteria(seed) for c in cards):
            continue
        cards.append(deepcopy(seed))
    if len(result["teams"]) > 100 or len(result["operations"]) > 100 or len(cards) > 200:
        return deepcopy(state), "недостаточно места в справочниках для начального заполнения"
    result["catalog_seed"] = SEED_VERSION
    return result, ""


def fill_initial_catalogs(conn):
    """Release task; its caller owns the transaction and pre-update backup."""
    from app.db import begin_write
    from app.snz_core import default_state
    # Administrator retries may run while employees are saving dictionaries.
    # Acquire the writer lock BEFORE reading state, not at the first INSERT.
    if not conn.in_transaction:
        begin_write(conn)
    created = updated = skipped = 0
    reasons = set()
    for obj in conn.execute("SELECT id FROM objects WHERE kind='zhbi' ORDER BY id").fetchall():
        row = conn.execute("SELECT revision,data_json FROM snz_state WHERE object_id=?", (obj[0],)).fetchone()
        if row is None:
            conn.execute("INSERT INTO snz_state(object_id,revision,data_json) VALUES (?,1,?)",
                         (obj[0], json.dumps(default_state(), ensure_ascii=False)))
            created += 1
            continue
        state = json.loads(row[1])
        new, reason = seed_catalogs(state)
        if reason:
            skipped += 1
            reasons.add(reason)
        elif new != state:
            conn.execute("UPDATE snz_state SET revision=revision+1,data_json=? WHERE object_id=?",
                         (json.dumps(new, ensure_ascii=False), obj[0]))
            updated += 1
    note = f"СНЗ: создано состояний {created}, дополнено {updated}, требуют ручного уточнения {skipped}"
    return note + ("; " + "; ".join(sorted(reasons)) if reasons else "")

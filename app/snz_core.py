"""Shift orders: deterministic scheduling, without database or web dependencies.

Minutes in issued orders are planned allocations, not measured progress. A task
has only an unfinished/completed fact. Allocated fragments carry forward; if a
whole normative cycle was allocated but completion is still absent, it is due
again. Issued orders never change when dictionaries are edited.
"""
from copy import deepcopy
from datetime import date, datetime, time, timedelta

from app.snz_catalogs import OPERATIONS, TEAMS, seed_catalogs


def default_state():
    state = {
        "crews": [{"id": "preparation", "name": "Подготовительная бригада", "foreman": "", "kind": "preparation"},
                  {"id": "install1", "name": "Монтажная бригада 1", "foreman": "", "kind": "installation"},
                  {"id": "install2", "name": "Монтажная бригада 2", "foreman": "", "kind": "installation"}],
        "teams": deepcopy(TEAMS),
        "operations": deepcopy(OPERATIONS),
        "cards": [{"id": "base", "name": "Базовая карта — заполните нормативы", "element_type": "", "subtype": "",
                   "steps": [{"operation_id": op["id"], "minutes": None, "wait_after": 0} for op in OPERATIONS]}],
        "assignments": [], "groups": [], "facts": {},
    }
    return seed_catalogs(state)[0]


def shift_start(day, shift):
    return datetime.combine(date.fromisoformat(str(day)), time(8 if shift == "day" else 20))


def previous_shift(day, shift):
    start = shift_start(day, shift) - timedelta(hours=12)
    return start.date().isoformat(), "day" if start.hour == 8 else "night"


def work_windows(day, shift):
    start = shift_start(day, shift)
    lunch = 300 if shift == "day" else 240
    return [(start + timedelta(minutes=20), start + timedelta(minutes=lunch)),
            (start + timedelta(minutes=lunch + 60), start + timedelta(minutes=700))]


def fragments(earliest, minutes, windows):
    result = []
    for left, right in windows:
        start = max(left, earliest)
        count = min(minutes, max(0, int((right - start).total_seconds() // 60)))
        if count:
            end = start + timedelta(minutes=count)
            result.append({"start": start.isoformat(timespec="minutes"), "end": end.isoformat(timespec="minutes"), "minutes": count})
            minutes -= count
            earliest = end
        if not minutes:
            break
    return result, minutes


def operation_steps(state, assignment):
    operations = {o["id"]: o for o in state["operations"]}
    teams = {t["id"]: t["name"] for t in state["teams"]}
    card = next((c for c in state["cards"] if c["id"] == assignment["card_id"]), None)
    return [{**deepcopy(operations[s["operation_id"]]), **deepcopy(s),
             "team_id": operations[s["operation_id"]]["team"], "team": teams[operations[s["operation_id"]]["team"]]} for s in (card or {}).get("steps", [])]


def suggest_card(state, element):
    """Most specific unambiguous dictionary match; never guess an unknown axis."""
    import json
    import re
    direction = ""
    try:
        ps = json.loads(element.get("outline_json") or "[]")
        dx = max(p[0] for p in ps) - min(p[0] for p in ps)
        dy = max(p[1] for p in ps) - min(p[1] for p in ps)
        if max(dx, dy) > 2 * min(dx, dy):
            direction = "letter" if dx > dy else "numeric"
    except (ValueError, TypeError, IndexError):
        pass
    def elevation(v):
        return 15800 if v == 15000 else v
    def norm_text(key, value):
        value = str(value or "").strip().casefold()
        return re.sub(r"(?<!\d)15[.,](?:000|800)(?!\d)", "15.800", value) if key == "subtype" else value
    matches = []
    for card in state["cards"]:
        if any(card.get(k) and norm_text(k, card[k]) != norm_text(k, element.get(k)) for k in ("element_type", "subtype")):
            continue
        if card.get("elevation_mm") is not None and elevation(card["elevation_mm"]) != elevation(element.get("elevation_mm")):
            continue
        if card.get("axis_direction") and card["axis_direction"] != direction:
            continue
        score = sum(bool(card.get(k)) for k in ("element_type", "subtype", "axis_direction", "elevation_mm"))
        matches.append((score, card["id"]))
    if not matches:
        return None
    best = max(s for s, _ in matches)
    choices = [key for s, key in matches if s == best]
    return choices[0] if len(choices) == 1 else None


def build_schedule(state, elements, history, day, shift, crew_id):
    """Schedule the entire object's crews, then select one foreman's document.

    A shared group task has one identity, resource and set of predecessors.
    List scheduling considers earliest feasible start before priority so another
    profession can start immediately while the previous one moves to the next item.
    """
    start = shift_start(day, shift)
    windows = work_windows(day, shift)
    crews = {c["id"]: c for c in state["crews"]}
    by_id = {e["id"]: e for e in elements}
    assignments = {a["element_id"]: a for a in state["assignments"] if a["element_id"] in by_id}
    groups = {eid: g for g in state["groups"] for eid in g["element_ids"]}
    facts = state["facts"]
    used, frozen, issued_steps, issued_elements = {}, {}, {}, set()
    for order in sorted(history, key=lambda h: h["start"]):
        if datetime.fromisoformat(order["start"]) >= start:
            continue
        for eid, steps in order.get("assignment_steps", {}).items():
            issued_steps.setdefault(int(eid), steps)
        for task in order["tasks"]:
            issued_elements.update(task["element_ids"])
            key = task["key"]
            frozen.setdefault(key, task)
            used[key] = used.get(key, 0) + sum(s["minutes"] for s in task["segments"])
    started_elements = issued_elements | {int(key.split(":")[1]) for key, fact in facts.items()
                                           if key.startswith("e:") and len(key.split(":")) >= 3 and key.split(":")[1].isdigit() and fact.get("completed")}
    started_groups = {key.split(":")[1] for key, fact in facts.items() if key.startswith("g:") and len(key.split(":")) >= 3 and fact.get("completed")}
    started_elements.update(eid for g in state["groups"] if g["id"] in started_groups for eid in g["element_ids"])
    warnings = []
    nodes, chains, steps_by_id = {}, {}, {}
    preparation = next((c["id"] for c in state["crews"] if c["kind"] == "preparation"), None)
    for eid, a in assignments.items():
        e = by_id[eid]
        if e["current_status"] in ("installed", "accepted"):
            continue
        if not e.get("is_current", 1):
            warnings.append(f"{e.get('mark') or eid}: изделие отсутствует в актуальном чертеже; работы не назначены.")
            continue
        if e["current_status"] != "ready_for_installation":
            warnings.append(f"{e.get('mark') or eid}: статус не «Готов к монтажу»; работы не назначены.")
            continue
        release = shift_start(a["date"], a["shift"])
        prep_day, prep_shift = previous_shift(a["date"], a["shift"])
        # Fresh work belongs to exactly its assigned shift. Historical issued
        # work may continue, and preparation is due one shift before mounting.
        if release != start and shift_start(prep_day, prep_shift) != start and not (release < start and eid in started_elements):
            continue
        steps = deepcopy(issued_steps.get(eid) or operation_steps(state, a))
        steps_by_id[str(eid)] = steps
        chain = []
        for index, step in enumerate(steps):
            step = deepcopy(step)
            group = groups.get(eid) if step["scope"] == "group" else None
            if step["scope"] == "group" and not group:
                warnings.append(f"{e.get('mark') or eid}: для «{step['name']}» не задан узел из 3 или 4 ригелей.")
                # A missing prerequisite must block subsequent operations, not disappear.
                chain.append(f"missing-group:{eid}:{step['id']}")
                continue
            if group and group.get("card_id"):
                group_assignment = {**a, "card_id": group["card_id"]}
                shared = next((s for s in operation_steps(state, group_assignment) if s["id"] == step["id"]), None)
                step["minutes"] = shared["minutes"] if shared else None
                step["wait_after"] = shared["wait_after"] if shared else 0
            key = f"g:{group['id']}:{step['id']}" if group else f"e:{eid}:{step['id']}"
            owner = preparation if step["scope"] == "preparation" else a["crew_id"]
            if not owner or owner not in crews:
                warnings.append(f"{e.get('mark') or eid}: не назначена бригада для «{step['name']}».")
                chain.append(f"missing-crew:{key}")
                continue
            task_release = shift_start(prep_day, prep_shift) if step["scope"] == "preparation" else release
            if key not in nodes:
                old = frozen.get(key, {})
                normative = old.get("norm_minutes", step["minutes"])
                total_used = used.get(key, 0)
                remaining = normative - total_used % normative if normative else None
                nodes[key] = {"key": key, "operation_id": step["id"], "operation": old.get("operation", step["name"]),
                              "scope": step["scope"],
                              "team": old.get("team", step["team"]), "team_id": old.get("team_id", step["team_id"]), "crew_id": owner,
                              "norm_minutes": normative, "remaining_before": remaining,
                              "wait_after": old.get("wait_after", step.get("wait_after", 0)),
                              "element_ids": [], "group_id": group["id"] if group else None,
                              "group_name": group["name"] if group else None,
                              "priority": a["prep_priority"] if step["scope"] == "preparation" else a["priority"],
                              "carry": bool(total_used) or task_release < start, "release": task_release,
                              "dependencies": set(), "segments": [], "step_index": index}
            node = nodes[key]
            if group and key not in frozen and (node["norm_minutes"], node["wait_after"]) != (step["minutes"], step.get("wait_after", 0)):
                warnings.append(f"Узел «{group['name']}»: нормативы общих операций в картах изделий различаются; выберите карту узла.")
                node["norm_minutes"] = node["remaining_before"] = None
            node["release"] = max(node["release"], task_release)
            node["element_ids"].append(eid)
            if chain:
                node["dependencies"].add(chain[-1])
            chain.append(key)
        chains[eid] = chain
    # Group reinforcement/concreting is possible only after every member's installation.
    for key, node in nodes.items():
        if node["group_id"]:
            group = next(g for g in state["groups"] if g["id"] == node["group_id"])
            for eid in group["element_ids"]:
                a = assignments.get(eid)
                if not a or a["crew_id"] != node["crew_id"]:
                    node["dependencies"].add(f"missing-member:{eid}")
                    warnings.append(f"Узел «{group['name']}»: всем ригелям нужны задания одной монтажной бригады.")
                elif eid not in chains and by_id[eid]["current_status"] not in ("installed", "accepted"):
                    node["dependencies"].add(f"missing-member:{eid}")
                if by_id[eid]["current_status"] not in ("installed", "accepted"):
                    node["dependencies"].add(f"e:{eid}:install")
            if len(node["element_ids"]) != len(group["element_ids"]):
                # Installed members need no remaining task but still belong to the group document.
                node["element_ids"] = list(group["element_ids"])
    finished = {key: datetime.fromisoformat(fact["completed_at"]) for key, fact in facts.items() if fact.get("completed") and key not in nodes}
    resource, pending = {}, set(nodes)
    for key, node in nodes.items():
        fact = facts.get(key)
        if fact and fact.get("completed"):
            finished[key] = datetime.fromisoformat(fact["completed_at"]) + timedelta(minutes=node["wait_after"])
            pending.remove(key)
        elif not node["norm_minutes"]:
            warnings.append(f"«{node['operation']}»: не заполнен норматив; операция и зависимые работы не рассчитаны.")
    result = []
    while pending:
        candidates = []
        for key in pending:
            n = nodes[key]
            if not n["norm_minutes"] or n["release"] > windows[-1][1] or not n["dependencies"].issubset(finished):
                continue
            earliest = max([windows[0][0], n["release"], resource.get((n["crew_id"], n["team_id"]), windows[0][0])]
                           + [finished[d] for d in n["dependencies"]])
            segs, remaining = fragments(earliest, n["remaining_before"], windows)
            if segs:
                candidates.append((datetime.fromisoformat(segs[0]["start"]), 0 if n["carry"] else 1,
                                   n["priority"] if n["priority"] is not None else 10**9, n["step_index"], key, segs, remaining))
        if not candidates:
            break
        _, _, _, _, key, segments, remaining = min(candidates, key=lambda c: c[:5])
        node = nodes[key]
        node["segments"] = segments
        node["remaining_after"] = remaining
        end = datetime.fromisoformat(segments[-1]["end"])
        resource[node["crew_id"], node["team_id"]] = end
        if not remaining:
            finished[key] = end + timedelta(minutes=node["wait_after"])
        pending.remove(key)
        result.append(node)
    tasks = []
    for n in result:
        if n["crew_id"] == crew_id:
            task = {k: v for k, v in n.items() if k not in ("dependencies", "release")}
            task["dependencies"] = sorted(n["dependencies"])
            task["release"] = n["release"].isoformat(timespec="minutes")
            task["elements"] = [deepcopy(by_id[eid]) for eid in n["element_ids"]]
            task["priorities"] = {str(eid): assignments[eid]["priority"] for eid in n["element_ids"] if eid in assignments}
            tasks.append(task)
    for key in sorted(pending):
        n = nodes[key]
        if n["crew_id"] == crew_id and n["release"] <= start:
            warnings.append(f"«{n['operation']}» ({', '.join(str(i) for i in n['element_ids'])}): не вошла в смену или ожидает предшествующие работы.")
    if any(n["crew_id"] == crew_id and n["release"] < start and n["scope"] == "preparation" for n in result):
        warnings.append("Есть просроченная подготовка: она должна выполняться за одну смену до монтажа.")
    return {"date": str(day), "shift": shift, "start": start.isoformat(timespec="minutes"),
            "end": (start + timedelta(hours=12)).isoformat(timespec="minutes"), "crew": deepcopy(crews[crew_id]),
            "tasks": tasks, "warnings": list(dict.fromkeys(warnings)), "assignment_steps": steps_by_id,
            "completed": [key for key in nodes if facts.get(key, {}).get("completed")],
            "windows": [[a.isoformat(timespec="minutes"), b.isoformat(timespec="minutes")] for a, b in windows]}

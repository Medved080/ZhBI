#!/usr/bin/env python3
"""Independent coordinate regressions for the signed doc09 rigel datums."""
import argparse
import json
from pathlib import Path

LONG = {"Р5", "Р5.1", "Р5.2", "Р6", "Р7", "Р8", "Р9", "Р10", "Р10.1"}
STRANDS = {"Р5": 3, "Р5.1": 4, "Р5.2": 4, "Р6": 4, "Р7": 4,
           "Р8": 4, "Р9": 4, "Р10": 4, "Р10.1": 6}


def close(actual, expected, label):
    if abs(actual-expected) > 0.0001:
        raise ValueError(f"{label}: {actual}, expected {expected}")


def check_model(model):
    alias = model["alias"]
    length, height, width = [model["bounds"][1][i]-model["bounds"][0][i] for i in range(3)]
    close(height, 300, alias+" concrete height")
    close(width, 400, alias+" concrete width")
    groups = {g["id"]: g for g in model["groups"]}
    checked = ["signed concrete section 400x300"]
    if alias == "Р3" or alias in LONG:
        bars = [p for g in model["groups"] if "cage" in g["id"]
                for p in g["paths"] if "cross" not in p.get("id", "")]
        upper = [p for p in bars if max(q[1] for q in p["points"])-min(q[1] for q in p["points"]) > .0001]
        lower = [p for p in bars if all(abs(q[1]-180) < .0001 for q in p["points"])]
        if len(upper) != 2 or len(lower) != 2:
            raise ValueError(alias+": expected two upper and two lower longitudinal cage bars")
        for path in upper:
            close(path["points"][0][1], 255, alias+" upper end = 280-25")
            close(path["points"][-1][1], 255, alias+" upper far end")
            close(min(p[1] for p in path["points"]), 230, alias+" central upper = 280-50 = 300-70")
        for selected in (upper, lower):
            z = sorted({q[2] for p in selected for q in p["points"]})
            if z != [40, 360]:
                raise ValueError(f"{alias}: signed longitudinal cage axes {z}, expected 40/360")
        checked += ["upper 255/230 from common 280 datum", "lower 180", "longitudinal cage axes 40/360"]
    if alias in LONG:
        ordinary = groups["ordinary-longitudinal"]["paths"]
        if len(ordinary) != 2:
            raise ValueError(alias+": ordinary bar quantity")
        for path in ordinary:
            close(path["points"][0][0], 20, alias+" ordinary x start")
            close(path["points"][-1][0], length-20, alias+" ordinary x end")
            for q in path["points"]:
                close(q[1], 60, alias+" ordinary y")
        if sorted({p["points"][0][2] for p in ordinary}) != [50, 350]:
            raise ValueError(alias+": ordinary axes 50/350")
        strands = groups["prestressing"]["paths"]
        if len(strands) != STRANDS[alias]:
            raise ValueError(alias+": own-spec strand quantity")
        yz = {(77, 125), (77, 200), (77, 275)}
        if STRANDS[alias] == 4:
            yz.add((122, 200))
        elif STRANDS[alias] == 6:
            yz |= {(122, 125), (122, 200), (122, 275)}
        if {(p["points"][0][1], p["points"][0][2]) for p in strands} != yz:
            raise ValueError(alias+": strand section coordinates")
        for path in strands:
            close(path["points"][0][0], 500, alias+" central strand start")
            close(path["points"][-1][0], length-500, alias+" central strand end")
        checked += ["ordinary bar offsets 20/60/50/350", "own-spec strand count and section", "central strand limits"]
    return {"id": model["id"], "alias": alias, "result": "pass", "checks": checked}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    rows = [check_model(model) for path in args.packages
            for model in json.loads(path.read_text())["models"].values()]
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"passed": len(rows), "models": rows}, ensure_ascii=False, indent=2))
    print(f"PASS: independently measured datums in {len(rows)} rigels")


if __name__ == "__main__":
    main()

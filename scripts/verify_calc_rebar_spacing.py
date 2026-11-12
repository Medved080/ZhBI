#!/usr/bin/env python3
"""Regression of the signed wire spacings in doc09 PDF48 and PDF53–56.

Read actual coordinates, independently of generator constants and QA claims.
"""
import argparse
import json
from pathlib import Path


def constant(points, axis):
    values = [point[axis] for point in points]
    if max(values)-min(values) > 0.0001:
        raise ValueError("Longitudinal wire is not straight along x")
    return values[0]


def check_model(model):
    groups = {group["id"]: group for group in model["groups"]}
    upper = [path for path in groups["span-upper"]["paths"] if path["diameter"] == 5]
    lower = [path for path in groups["span-lower"]["paths"] if path["diameter"] == 5]
    ends = [path for path in groups["end-mesh"]["paths"] if path["diameter"] == 8]
    upper_z = sorted({constant(path["points"], 2) for path in upper})
    lower_y = min(constant(path["points"], 1) for path in lower)
    bottom_z = sorted({constant(path["points"], 2) for path in lower
                       if abs(constant(path["points"], 1)-lower_y) < 0.0001})
    side_y = sorted({constant(path["points"], 1) for path in lower
                     if abs(constant(path["points"], 1)-lower_y) > 0.0001})
    end_y = min(constant(path["points"], 1) for path in ends)
    end_z = sorted({constant(path["points"], 2) for path in ends
                    if abs(constant(path["points"], 1)-end_y) < 0.0001})
    actual = {"upperWireSpacingMm": upper_z[-1]-upper_z[0],
              "lowerBottomWireSpacingMm": bottom_z[-1]-bottom_z[0],
              "lowerSideWireSpacingMm": side_y[-1]-side_y[0],
              "endBottomWireSpacingMm": end_z[-1]-end_z[0]}
    expected = {"upperWireSpacingMm": 140, "lowerBottomWireSpacingMm": 175,
                "lowerSideWireSpacingMm": 110, "endBottomWireSpacingMm": 85}
    if len(upper_z) != 2 or len(bottom_z) != 2 or len(side_y) != 2 or len(end_z) != 2 or actual != expected:
        raise ValueError(f"{model['alias']}: signed spacings disagree: {actual}, expected {expected}")
    return {"id": model["id"], "alias": model["alias"], "result": "pass", **actual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    rows = []
    for path in args.packages:
        package = json.loads(path.read_text())
        for model in package["models"].values():
            rows.append(check_model(model))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"models": rows, "passed": len(rows)}, ensure_ascii=False, indent=2))
    print(f"PASS: four independently measured signed spacings in {len(rows)} models")


if __name__ == "__main__":
    main()

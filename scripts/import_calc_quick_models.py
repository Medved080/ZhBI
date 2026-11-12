#!/usr/bin/env python3
"""Validate and add separate drawing-based model packages, preserving existing data.

Dry run by default. Pass --write to publish locally, with recoverable backups.
"""
import argparse
import collections
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile

from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as geometry

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.calc.source_policy import SourcePolicy


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def point(value, length=3):
    require(isinstance(value, (list, tuple)) and len(value) == length,
            f"Expected {length} coordinates: {value!r}")
    require(all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
                for x in value), f"Invalid coordinate: {value!r}")


def part_volume(part):
    if part["type"] == "mesh":
        vertices = part["vertices"]
        require(len(vertices) >= 4, "Mesh has fewer than four vertices")
        for p in vertices:
            point(p)
        require(bool(part["indices"]), "Mesh has no triangles")
        edges = collections.Counter()
        for triangle in part["indices"]:
            require(len(triangle) == 3 and len(set(triangle)) == 3,
                    "Degenerate mesh triangle")
            require(all(isinstance(i, int) and 0 <= i < len(vertices) for i in triangle),
                    "Mesh index outside vertex array")
            a, b, c = [vertices[i] for i in triangle]
            u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            cross = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
            require(sum(x*x for x in cross) > 1e-12, "Zero-area mesh triangle")
            for start, end in zip(triangle, triangle[1:] + triangle[:1]):
                edges[start, end] += 1
        require(all(n == 1 and edges[end, start] == 1 for (start, end), n in edges.items()),
                "Mesh is not a closed, consistently oriented surface")
        return geometry.mesh_volume(part)
    require(part["type"] == "extrusion", f"Unsupported part type: {part['type']}")
    for key in ("origin", "u", "v", "direction"):
        point(part[key])
    axes = [part[key] for key in ("u", "v", "direction")]
    for i, axis in enumerate(axes):
        require(abs(sum(x*x for x in axis) - 1) < 1e-8, "Non-unit extrusion axis")
        for other in axes[:i]:
            require(abs(sum(x*y for x, y in zip(axis, other))) < 1e-8,
                    "Non-orthogonal extrusion axes")
    require(isinstance(part["depth"], (int, float)) and math.isfinite(part["depth"])
            and part["depth"] > 0, "Non-positive extrusion depth")
    for p in part["profile"]:
        point(p, 2)
    polygon = Polygon(part["profile"])
    require(polygon.is_valid and polygon.area > 0, "Invalid exterior profile")
    holes = []
    for hole in part.get("holes", []):
        if hole["type"] == "polygon":
            for p in hole["points"]:
                point(p, 2)
            cut = Polygon(hole["points"])
        else:
            require(hole["type"] == "circle", "Unsupported hole type")
            point(hole["center"], 2)
            require(hole["radius"] > 0 and math.isfinite(hole["radius"]), "Invalid hole radius")
            cut = Point(hole["center"]).buffer(hole["radius"], resolution=96)
        require(cut.is_valid and cut.area > 0 and polygon.covers(cut),
                "Hole is invalid or outside its profile")
        require(all(cut.intersection(other).area < 1e-6 for other in holes), "Overlapping holes")
        holes.append(cut)
    return (polygon.area - sum(hole.area for hole in holes)) * part["depth"]


def validate(models, supplies, catalog, existing, assets):
    policy = SourcePolicy(assets)
    for sid, supply in supplies.items():
        selected = {key: value for key, value in models.items() if value["supplyId"] == sid}
        require(bool(selected), f"Empty supply {sid}")
        require(supply["modelCount"] == len(selected), f"Incorrect model count: {sid}")
        sha = hashlib.sha256(dump(selected).encode()).hexdigest()
        require(supply["modelsSha256"] == sha == supply["qa"]["modelsSha256"],
                f"Package checksum mismatch: {sid}")
        require(set(supply["qa"]["models"]) == set(selected), f"QA coverage mismatch: {sid}")
        require(bool(supply.get("report")), f"Missing supply report: {sid}")
    results = []
    for key, solid in models.items():
        entry = catalog.get(key)
        require(entry and not entry.get("excluded") and not entry.get("excludedFromCalculation"),
                f"Unknown/excluded catalog item: {key}")
        require(not entry.get("groups"), f"Item already has individual geometry: {key}")
        require(key not in existing or existing[key] == solid, f"Refusing to replace existing model: {key}")
        require(solid["id"] == key and solid["alias"] == entry["alias"], f"Identity mismatch: {key}")
        require(solid["sourceId"] == entry["source"]["id"], f"Source mismatch: {key}")
        policy.model({**entry, "solidModel": solid})
        require(solid["format"] == "project-solids-mm-v1" and solid["status"] == "partial",
                f"Unexpected model format/status: {key}")
        require(solid.get("supersedesSketch") is True, f"Old sketch would hide new model: {key}")
        require(bool(solid.get("pending")) and bool(solid.get("readinessDescription")),
                f"Missing limitations: {key}")
        require(bool(solid.get("evidence")), f"Missing drawing evidence: {key}")
        source_pdf = geometry.SOURCES / (solid["sourceId"] + ".pdf")
        require(source_pdf.is_file(), f"Missing source PDF: {key}")
        require(any(ev.get("pdfPage") == entry["source"]["productPage"]
                    for ev in solid["evidence"]), f"Own product sheet not cited: {key}")
        parts = solid["concreteParts"]
        require(bool(parts), f"Empty concrete geometry: {key}")
        volume = sum(part_volume(part) for part in parts) / 1e9
        for part in solid.get("metalParts", []):
            require(part_volume(part) > 0, f"Invalid metal part: {key}")
        require(volume > 0, f"Non-positive volume: {key}")
        bounds = geometry._bounds_of(parts)
        require(bounds == solid["bounds"], f"Incorrect concrete bounds: {key}")
        qa = supplies[solid["supplyId"]]["qa"]["models"][key]
        require(qa["counts"]["checks"] == len(qa["checks"]), f"QA check count mismatch: {key}")
        require(qa["counts"]["failures"] == 0, f"Failed QA: {key}")
        require(all(check["result"] != "fail" for check in qa["checks"]), f"Failed QA check: {key}")
        dim = next((c for c in qa["checks"] if c["check"] == "signed-dimensions"), None)
        require(dim and dim["result"] == "pass", f"Missing signed-dimensions check: {key}")
        require(dim.get("expected") == dim.get("actual") and dim.get("actual") is not None,
                f"Signed dimensions disagree: {key}")
        spans = [bounds[1][i] - bounds[0][i] for i in range(3)]
        if isinstance(dim["actual"], dict):
            actual_spans = [dim["actual"][name] for name in ("lengthMm", "heightMm", "widthMm")]
        else:
            actual_spans = dim["actual"]
        require(len(actual_spans) == 3 and all(abs(a-b) < 0.001 for a, b in zip(actual_spans, spans)),
                f"Signed dimensions do not match concrete geometry: {key}")
        vol = next((c for c in qa["checks"] if c["check"] == "volume-vs-spec"), None)
        require(vol and vol["result"] == "pass", f"Volume check did not pass: {key}")
        require(abs(volume - vol["modelM3"]) <= 0.00002, f"Reported volume mismatch: {key}")
        require(entry.get("projectVolume") and abs(vol["specM3"] - entry["projectVolume"]) < 1e-8,
                f"Project specification mismatch: {key}")
        deviation = (volume / entry["projectVolume"] - 1) * 100
        require(abs(deviation) <= 2, f"Volume deviation exceeds 2%: {key}")
        results.append({"id": key, "alias": solid["alias"], "sourceId": solid["sourceId"],
                        "page": entry["source"]["productPage"], "bounds": bounds,
                        "modelM3": volume, "specM3": entry["projectVolume"],
                        "deviationPercent": deviation, "supplyId": solid["supplyId"]})
    return results


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(dump(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("packages", nargs="+", type=Path)
    ap.add_argument("--assets", type=Path, default=geometry.CATALOG_DIR)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    models, supplies = {}, {}
    for path in args.packages:
        package = json.loads(path.read_text())
        require(not (models.keys() & package["models"].keys()), "Duplicate model in input packages")
        require(not (supplies.keys() & package["supplies"].keys()), "Duplicate supply in input packages")
        models.update(package["models"])
        supplies.update(package["supplies"])
    require(bool(models), "No input models")
    catalog = {}
    for name in ("promka-models.json", "promka-register.json"):
        catalog.update(json.loads((args.assets / name).read_text()))
    from app.calc.source_link_repairs import repair_links
    from app.calc.readings import apply_readings
    repair_links(catalog)
    apply_readings(catalog, args.assets)
    model_path = args.assets / "promka-solid-models.json"
    supply_path = args.assets / "promka-solid-supplies.json"
    lock = (args.assets / ".quick-models-import.lock").open("a") if args.write else contextlib.nullcontext()
    with lock as handle:
        if args.write:
            fcntl.flock(handle, fcntl.LOCK_EX)
        before_models = json.loads(model_path.read_text())
        before_supplies = json.loads(supply_path.read_text())
        results = validate(models, supplies, catalog, before_models, args.assets)
        require(all(key not in before_supplies or before_supplies[key] == value
                    for key, value in supplies.items()), "Refusing to replace an existing supply")
        new_count = len(models.keys() - before_models.keys())
        if args.write and new_count:
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = args.assets.parent / "backups" / ("quick-models-" + stamp)
            backup.mkdir(parents=True)
            for path in (model_path, supply_path):
                shutil.copy2(path, backup / path.name)
            # Supplies first: a model must never become visible without its QA record.
            atomic_json(supply_path, {**before_supplies, **supplies})
            atomic_json(model_path, {**before_models, **models})
            after_models = json.loads(model_path.read_text())
            after_supplies = json.loads(supply_path.read_text())
            require(all(after_models[k] == v for k, v in before_models.items()), "Existing model changed")
            require(all(after_supplies[k] == v for k, v in before_supplies.items()), "Existing supply changed")
            print("Backup:", backup)
        report = {"createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "written": args.write, "newModels": new_count, "validatedModels": len(results),
                  "existingModelsPreserved": len(before_models), "models": results}
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            atomic_json(args.report, report)
        print(f"Validated {len(results)} models; new {new_count}; written {args.write}")
        for row in results:
            print(f"  {row['alias']}: {row['modelM3']:.5f} / {row['specM3']:.5f} m3 ({row['deviationPercent']:+.2f}%)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate drawing-based steel upgrades of the 78 quick concrete models.

Dry run by default; --write performs a guarded local update with backups.
Every replacement is tied to the exact previous model hash. Concrete and
calculation inputs are immutable, and unrelated models/supplies are preserved.
"""
import argparse
import collections
import datetime as dt
import fcntl
import hashlib
import json
import math
from pathlib import Path
import shutil

import import_calc_quick_models as base

ROOT = base.ROOT
FROZEN_FIELDS = ("id", "alias", "sourceId", "format", "concreteParts", "bounds",
                 "coordinateSystem", "coordinateOrigin")


def digest(value):
    return hashlib.sha256(base.dump(value).encode()).hexdigest()


def path_mass(path, group):
    length = sum(math.dist(a, b) for a, b in zip(path["points"], path["points"][1:]))
    material = path.get("material") or group.get("material") or ""
    stranded = path.get("wireCountPerStrand", group.get("wireCountPerStrand")) == 7 or "К7" in material or "K7" in material
    if stranded:
        return length / 1000 * path.get("kgPerM", group.get("kgPerM"))
    return math.pi * path["diameter"]**2 / 4 * length * 7850 / 1e9


def normalize_material(material):
    return str(material).upper().translate(str.maketrans({"А": "A", "С": "C", "К": "K"})).replace(" ", "")


def verify_mass_scopes(solid, qa):
    """Tie declared component masses to the actual selected geometry."""
    groups = {group["id"]: group for group in solid["groups"]}
    checked = 0
    scoped_paths, scoped_metals = set(), set()
    for check in qa["checks"]:
        if "modelKg" not in check or not ("groupIds" in check or "metalPartIndices" in check):
            continue
        gids, metal_indices = check.get("groupIds", []), check.get("metalPartIndices", [])
        base.require(len(gids) == len(set(gids)) and all(gid in groups for gid in gids),
                     "Mass verification refers to missing/duplicate groups")
        base.require(len(metal_indices) == len(set(metal_indices)) and
                     all(type(i) is int and 0 <= i < len(solid["metalParts"]) for i in metal_indices),
                     "Mass verification refers to invalid metal parts")
        mass = 0
        for gid in gids:
            group = groups[gid]
            for index, path in enumerate(group["paths"]):
                if check.get("diameterFilter") is not None and path["diameter"] != check["diameterFilter"]:
                    continue
                material = path.get("material") or group.get("material")
                if check.get("materialFilter") and normalize_material(material) != normalize_material(check["materialFilter"]):
                    continue
                mass += path_mass(path, group)
                scoped_paths.add((gid, index))
        mass += sum(base.part_volume(solid["metalParts"][i]) * 7850 / 1e9 for i in metal_indices)
        scoped_metals.update(metal_indices)
        base.require(isinstance(check["modelKg"], (int, float)) and math.isfinite(check["modelKg"]) and
                     abs(mass-check["modelKg"]) <= max(0.00005, abs(mass)*0.000001),
                     f"Reported component mass differs from actual geometry: {check['check']}")
        if check.get("specKg"):
            deviation = (mass/check["specKg"] - 1)*100
            if check.get("deviationPercent") is not None:
                base.require(abs(deviation-check["deviationPercent"]) < 0.005,
                             f"Incorrect mass deviation: {check['check']}")
            if check["result"] == "pass" and check.get("tolerancePercent") is not None:
                base.require(abs(deviation) <= check["tolerancePercent"] + 0.0001,
                             f"Mass check exceeds its declared tolerance: {check['check']}")
        checked += 1
    base.require(checked > 0, "No mass checks tied to actual geometry")
    base.require(scoped_paths == {(gid, index) for gid, group in groups.items()
                                  for index in range(len(group["paths"]))},
                 "Some reinforcement paths are outside every independently checked mass scope")
    base.require(scoped_metals == set(range(len(solid["metalParts"]))),
                 "Some metal parts are outside every independently checked mass scope")
    return checked


def steel_totals(solid):
    """Independent centerline mass; strands use their documented linear mass."""
    by_diameter = collections.defaultdict(lambda: {"paths": 0, "lengthMm": 0.0, "massKg": 0.0})
    groups = solid.get("groups", [])
    ids, unique_paths = set(), set()
    lo, hi = solid["bounds"]
    lengths = [hi[i] - lo[i] for i in range(3)]
    segments = 0
    for group in groups:
        gid = group.get("id")
        base.require(isinstance(gid, str) and gid and gid not in ids, f"Missing/duplicate steel group ID: {gid}")
        ids.add(gid)
        base.require(bool(group.get("sourcePages")), f"Missing steel group source: {gid}")
        base.require(bool(group.get("paths")), f"Empty steel group: {gid}")
        for path in group["paths"]:
            diameter = path.get("diameter")
            base.require(isinstance(diameter, (int, float)) and not isinstance(diameter, bool) and math.isfinite(diameter) and 0 < diameter <= 80,
                         f"Invalid bar diameter: {gid}")
            material = path.get("material") or group.get("material")
            base.require(isinstance(material, str) and material.strip(), f"Missing steel material: {gid}")
            points = path.get("points", [])
            base.require(len(points) >= 2, f"Empty steel path: {gid}")
            for point in points:
                base.point(point)
                base.require(all(lo[i]-max(1500, lengths[i]*0.25) <= point[i] <= hi[i]+max(1500, lengths[i]*0.25)
                                 for i in range(3)), f"Steel far outside product coordinates: {gid}")
            distances = [math.dist(a, b) for a, b in zip(points, points[1:])]
            base.require(all(length > 1e-7 for length in distances), f"Zero-length steel segment: {gid}")
            length = sum(distances)
            key = (float(diameter), material, min(tuple(map(tuple, points)), tuple(map(tuple, points[::-1]))))
            base.require(key not in unique_paths, f"Duplicate coincident steel path: {gid}")
            unique_paths.add(key)
            stranded = path.get("wireCountPerStrand", group.get("wireCountPerStrand")) == 7 or "К7" in material or "K7" in material
            linear_mass = path.get("kgPerM", group.get("kgPerM"))
            if stranded:
                base.require(isinstance(linear_mass, (int, float)) and not isinstance(linear_mass, bool) and math.isfinite(linear_mass) and linear_mass > 0,
                             f"Strand missing specification linear mass: {gid}")
                mass = linear_mass * length / 1000
            else:
                mass = math.pi * diameter**2 / 4 * length * 7850 / 1e9
            key = f"{material} Ø{diameter:g}"
            by_diameter[key]["paths"] += 1
            by_diameter[key]["lengthMm"] += length
            by_diameter[key]["massKg"] += mass
            segments += len(distances)
    metals = solid.get("metalParts", [])
    metal_mass = 0
    for part in metals:
        base.require(bool(part.get("sourcePages")), "Missing metal part source pages")
        metal_mass += base.part_volume(part) * 7850 / 1e9
    return {"groups": len(groups), "paths": len(unique_paths), "segments": segments,
            "rebarMassKg": sum(value["massKg"] for value in by_diameter.values()),
            "metalPartCount": len(metals), "metalMassKg": metal_mass,
            "byMaterialDiameter": dict(by_diameter)}


def validate_upgrade(package, catalog, existing, assets, allowed_ids):
    models, supplies, replaces = [package[name] for name in ("models", "supplies", "replaces")]
    base.require(set(models) == set(replaces), "Replacement hashes do not cover exactly the updated models")
    base.require(bool(models) and set(models) <= allowed_ids, "Upgrade must target only the previous 78 models")
    # Reuse the concrete/source/package gate without allowing unrelated replacement.
    concrete_report = base.validate(models, supplies, catalog,
                                    {key: value for key, value in existing.items() if key not in models}, assets)
    rows = []
    for row in concrete_report:
        key, new = row["id"], models[row["id"]]
        old = existing.get(key)
        base.require(old is not None, f"Upgrade target missing: {key}")
        same = old == new
        base.require(same or digest(old) == replaces[key], f"Previous model changed since review: {key}")
        if not same:
            for field in FROZEN_FIELDS:
                base.require(old.get(field) == new.get(field), f"Upgrade changes frozen {field}: {key}")
            base.require(old.get("supplyId") != new.get("supplyId"), f"Use a new delivery for steel upgrades: {key}")
            base.require(all(ev in new["evidence"] for ev in old.get("evidence", [])),
                         f"Old drawing evidence removed: {key}")
        totals = steel_totals(new)
        base.require(totals["paths"] > 0, f"No actual reinforcement added: {key}")
        qa = supplies[new["supplyId"]]["qa"]["models"][key]
        base.SourcePolicy(assets).reading(qa, new["sourceId"])
        base.require(qa["counts"]["warnings"] == sum(check["result"] == "warn" for check in qa["checks"]),
                     f"Incorrect QA warning count: {key}")
        base.require(any("mass" in check["check"] for check in qa["checks"]),
                     f"Missing mass verification against drawing: {key}")
        coverage = qa.get("componentCoverage")
        base.require(isinstance(coverage, list) and coverage, f"Missing component coverage: {key}")
        some_modeled = False
        for component in coverage:
            quantity, modeled = component.get("quantity"), component.get("modeledQuantity")
            base.require(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
                             for value in (quantity, modeled)), f"Invalid component count: {key}")
            base.require(modeled <= quantity, f"Modeled component count exceeds specification: {key}")
            status = component.get("status")
            base.require(status in ("modeled", "partial", "pending", "not-applicable"), f"Unknown component status: {key}")
            base.require(status != "modeled" or quantity == modeled, f"Incomplete component declared modeled: {key}")
            if modeled < quantity or status in ("partial", "pending"):
                base.require(bool(component.get("reason")), f"Unexplained incomplete component: {key}")
            some_modeled |= modeled > 0
        base.require(some_modeled, f"All components remain pending: {key}")
        base.require(qa["counts"]["groups"] == totals["groups"] and
                     qa["counts"]["metalParts"] == totals["metalPartCount"], f"Incorrect assembly QA counts: {key}")
        base.require(qa["counts"].get("paths") == totals["paths"], f"Incorrect steel path count: {key}")
        mass_checks = verify_mass_scopes(new, qa)
        rows.append({**row, **totals, "alreadyInstalled": same,
                     "componentCoverage": coverage, "warnings": qa["counts"]["warnings"],
                     "independentlyVerifiedMassChecks": mass_checks})
    return rows


def merge_packages(paths):
    result = {"models": {}, "supplies": {}, "replaces": {}}
    for path in paths:
        package = json.loads(path.read_text())
        for field, values in result.items():
            base.require(not (values.keys() & package[field].keys()), f"Duplicate {field} across packages")
            values.update(package[field])
    return result


def load_catalog(assets):
    from app.calc.source_link_repairs import repair_links
    from app.calc.readings import apply_readings
    catalog = {}
    for name in ("promka-models.json", "promka-register.json"):
        catalog.update(json.loads((assets / name).read_text()))
    repair_links(catalog)
    apply_readings(catalog, assets)
    return catalog


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("packages", nargs="+", type=Path)
    ap.add_argument("--assets", type=Path, default=base.geometry.CATALOG_DIR)
    ap.add_argument("--scope", type=Path, default=ROOT / "tmp/quick-models/import-result.json")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--report", type=Path, default=ROOT / "tmp/rebar-models/import-result.json")
    args = ap.parse_args()
    package = merge_packages(args.packages)
    allowed = {row["id"] for row in json.loads(args.scope.read_text())["models"]}
    catalog = load_catalog(args.assets)
    model_path, supply_path = [args.assets / name for name in ("promka-solid-models.json", "promka-solid-supplies.json")]
    # Same lock as the first-stage importer, including read/validation/write.
    with (args.assets / ".quick-models-import.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        models, supplies = json.loads(model_path.read_text()), json.loads(supply_path.read_text())
        rows = validate_upgrade(package, catalog, models, args.assets, allowed)
        for sid, delivery in package["supplies"].items():
            base.require(sid not in supplies or supplies[sid] == delivery, f"Existing supply collision: {sid}")
        changes = [row["id"] for row in rows if not row["alreadyInstalled"]]
        backup = None
        if args.write and changes:
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = args.assets.parent / "backups" / ("rebar-models-" + stamp)
            backup.mkdir(parents=True)
            for path in (model_path, supply_path):
                shutil.copy2(path, backup / path.name)
            base.atomic_json(supply_path, {**supplies, **package["supplies"]})
            base.atomic_json(model_path, {**models, **package["models"]})
            actual, actual_supplies = json.loads(model_path.read_text()), json.loads(supply_path.read_text())
            base.require(all(actual[key] == value for key, value in models.items() if key not in changes),
                         "An unrelated model changed")
            base.require(all(actual_supplies[key] == value for key, value in supplies.items()), "An existing supply changed")
        report = {"capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "written": args.write,
                  "upgradedModels": len(changes), "validatedModels": len(rows), "models": rows,
                  "originalModelCount": len(models), "unrelatedModelsPreserved": len(models)-len(changes),
                  "backup": str(backup) if backup else None}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        base.atomic_json(args.report, report)
        print(f"Validated {len(rows)} steel assemblies; updates {len(changes)}; written {args.write}")
        for row in rows:
            print(f"  {row['alias']}: {row['paths']} paths, {row['rebarMassKg']:.2f} kg bars, "
                  f"{row['metalPartCount']} metal parts, {row['metalMassKg']:.2f} kg metal")


if __name__ == "__main__":
    main()

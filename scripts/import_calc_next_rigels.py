#!/usr/bin/env python3
"""Guarded addition of the next source-reviewed doc09 rigel group.

Validates concrete, each steel path and every component mass scope. Existing
models, deliveries and all calculation inputs are preserved; --write is opt-in.
"""
import argparse
import datetime as dt
import fcntl
import json
import math
from pathlib import Path
import shutil

import import_calc_quick_models as base
import import_calc_rebar_models as steel

ALIASES = {"Рк1", "Р1", "Р1.1", "Р2", "Р2.1", "Р3", "Р5", "Р5.1", "Р5.2",
           "Р6", "Р7", "Р8", "Р9", "Р10", "Р10.1"}


def merge(paths):
    result = {"models": {}, "supplies": {}}
    for path in paths:
        package = json.loads(path.read_text())
        for key, values in result.items():
            base.require(not (values.keys() & package[key].keys()), f"Duplicate {key} across packages")
            values.update(package[key])
    base.require(bool(result["models"]), "No models supplied")
    return result


def validate(package, catalog, existing, assets):
    models, supplies = package["models"], package["supplies"]
    for key, model in models.items():
        base.require(model["sourceId"] == "doc09" and model["alias"] in ALIASES,
                     f"Outside the selected rigel group: {key}")
    rows = base.validate(models, supplies, catalog, existing, assets)
    policy = base.SourcePolicy(assets)
    for row in rows:
        model = models[row["id"]]
        qa = supplies[model["supplyId"]]["qa"]["models"][row["id"]]
        totals = steel.steel_totals(model)
        base.require(totals["paths"] > 0, f"No verified steel geometry: {model['alias']}")
        policy.reading(qa, model["sourceId"])
        counts = qa["counts"]
        for key, actual in (("concreteParts", len(model["concreteParts"])),
                            ("groups", totals["groups"]), ("paths", totals["paths"]),
                            ("metalParts", totals["metalPartCount"])):
            base.require(counts.get(key) == actual, f"Incorrect {key} count: {model['alias']}")
        base.require(counts["warnings"] == sum(c["result"] == "warn" for c in qa["checks"]),
                     f"Incorrect warnings count: {model['alias']}")
        coverage = qa.get("componentCoverage")
        base.require(isinstance(coverage, list) and coverage, "Missing own-sheet component coverage")
        for component in coverage:
            quantity, modeled = component.get("quantity"), component.get("modeledQuantity")
            base.require(type(quantity) in (int, float) and type(modeled) in (int, float) and
                         math.isfinite(quantity) and math.isfinite(modeled) and
                         0 <= modeled <= quantity, f"Invalid component quantities: {model['alias']}")
            base.require(component.get("status") in ("modeled", "partial", "pending", "not-applicable"),
                         "Unknown component coverage status")
            if modeled < quantity or component["status"] in ("partial", "pending"):
                base.require(bool(component.get("reason")), "Unexplained incomplete component")
            if component["status"] == "modeled":
                base.require(modeled == quantity, "Incomplete component marked modeled")
        mass_checks = steel.verify_mass_scopes(model, qa)
        row.update(totals, componentCoverage=coverage, warnings=counts["warnings"],
                   independentlyVerifiedMassChecks=mass_checks, alreadyInstalled=row["id"] in existing)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path)
    parser.add_argument("--assets", type=Path, default=base.geometry.CATALOG_DIR)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--report", type=Path, default=base.ROOT / "tmp/next-rigels/import-result.json")
    args = parser.parse_args()
    package = merge(args.packages)
    catalog = steel.load_catalog(args.assets)
    model_path = args.assets / "promka-solid-models.json"
    supply_path = args.assets / "promka-solid-supplies.json"
    with (args.assets / ".quick-models-import.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = json.loads(model_path.read_text())
        before_supplies = json.loads(supply_path.read_text())
        rows = validate(package, catalog, before, args.assets)
        for sid, delivery in package["supplies"].items():
            base.require(sid not in before_supplies or before_supplies[sid] == delivery,
                         f"Existing supply collision: {sid}")
        added = [row for row in rows if not row["alreadyInstalled"]]
        backup = None
        if args.write and added:
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = args.assets.parent / "backups" / ("next-rigels-" + stamp)
            backup.mkdir(parents=True)
            for path in (model_path, supply_path):
                shutil.copy2(path, backup / path.name)
            base.atomic_json(supply_path, {**before_supplies, **package["supplies"]})
            base.atomic_json(model_path, {**before, **package["models"]})
            actual = json.loads(model_path.read_text())
            actual_supplies = json.loads(supply_path.read_text())
            base.require(all(actual[k] == v for k, v in before.items()), "An existing model changed")
            base.require(all(actual_supplies[k] == v for k, v in before_supplies.items()),
                         "An existing delivery changed")
        report = {"capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "written": args.write,
                  "validatedModels": len(rows), "newModels": len(added), "models": rows,
                  "existingModelsPreserved": len(before), "existingSuppliesPreserved": len(before_supplies),
                  "backup": str(backup) if backup else None}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        base.atomic_json(args.report, report)
        print(f"Validated {len(rows)} rigels; new {len(added)}; written {args.write}")
        for row in rows:
            print(f"  {row['alias']}: {row['modelM3']:.5f} m3, {row['paths']} paths, "
                  f"{row['metalPartCount']} metal parts, {row['independentlyVerifiedMassChecks']} mass checks")


if __name__ == "__main__":
    main()

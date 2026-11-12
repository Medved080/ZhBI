#!/usr/bin/env python3
"""Protected partial upgrades: own-sheet straight Ø25 bars and ПВ1 of doc15.

Read-only with respect to live assets. Output is an independently importable
package with SHA-256 guards on the exact old raw solids. All concrete is copied.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
from pathlib import Path
from calc_models_kn45 import seg_dist

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "data/calc/assets"
SUPPLY_ID = "codex-rebar-plinths-20261111"
SOURCE_SHA = "7a27c733998a90320d3c2b8684d16ea59d564ed2b961f6f6dce06db665361df1"
# Own product page, own AB page, AB mark, panel length,
# own AB pos.3 length/unit mass, other own AB quantities and unit masses.
SPECS = {
    "ПЦ-1": (7, 8, "АБ1", 1160, 1130, 4.35, ("С1", 2, 18.30), ("К1", 4, 2.00), ("П7", 2, 1.70), ("ПГ6", 4, 1.31), ("Х2", 12, .18), ("СК1", 24, .08)),
    "ПЦ-2": (9, 10, "АБ2", 2030, 2000, 7.71, ("С2", 2, 33.07), ("К1", 6, 2.00), ("П7", 2, 1.70), ("ПГ6", 4, 1.31), ("Х2", 22, .18), ("СК1", 44, .08)),
    "ПЦ-3": (11, 12, "АБ3", 2940, 2910, 11.21, ("С3", 2, 48.02), ("К1", 9, 2.00), ("П2", 2, 3.96), ("ПГ7", 4, 2.84), ("Х2", 32, .18), ("СК1", 64, .08)),
    "ПЦ-4": (15, 14, "АБ4", 3760, 3730, 14.37, ("С4", 2, 60.79), ("К1", 11, 2.00), ("П4", 2, 5.72), ("ПГ7", 4, 2.84), ("Х2", 40, .18), ("СК1", 80, .08)),
    "ПЦ-6": (17, 18, "АБ6", 4160, 4130, 15.91, ("С6", 2, 67.13), ("К1", 12, 2.00), ("П3", 2, 7.22), ("ПГ5", 4, 3.48), ("Х2", 44, .18), ("СК1", 88, .08)),
    "ПЦ-7": (19, 20, "АБ7", 4260, 4230, 16.30, ("С7", 2, 67.94), ("К1", 12, 2.00), ("П3", 2, 7.22), ("ПГ5", 4, 3.48), ("Х2", 44, .18), ("СК1", 88, .08)),
    "ПЦ-8": (21, 22, "АБ8", 4360, 4330, 16.69, ("С8", 2, 71.76), ("К1", 12, 2.00), ("П3", 2, 7.22), ("ПГ5", 4, 3.48), ("Х2", 44, .18), ("СК1", 88, .08)),
    "ПЦ-9": (23, 24, "АБ9", 4460, 4430, 17.07, ("С9", 2, 72.57), ("К1", 13, 2.00), ("П3", 2, 7.22), ("ПГ5", 4, 3.48), ("Х2", 48, .18), ("СК1", 96, .08)),
    "ПЦ-10": (25, 26, "АБ10", 4960, 4930, 19.00, ("С10", 2, 79.72), ("К1", 14, 2.00), ("П3", 2, 7.22), ("ПГ5", 4, 3.48), ("Х2", 52, .18), ("СК1", 104, .08)),
}


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def path_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def bar_mass(d, length):
    return math.pi * d * d / 4 * length * 7850 / 1e9


def group_mass(group):
    return sum(bar_mass(p["diameter"], path_length(p["points"])) for p in group["paths"])


def steel_collisions(paths):
    """Independent closest-segment check between different modeled bars."""
    hits = []
    for i, p in enumerate(paths):
        for q in paths[i + 1:]:
            radii = (p["diameter"] + q["diameter"]) / 2
            bound_distance = math.sqrt(sum(max(0, min(v[d] for v in p["points"]) - max(v[d] for v in q["points"]),
                                               min(v[d] for v in q["points"]) - max(v[d] for v in p["points"])) ** 2 for d in range(3)))
            if bound_distance >= radii:
                continue
            distance = min(seg_dist(a, b, c, d) for a, b in zip(p["points"], p["points"][1:])
                           for c, d in zip(q["points"], q["points"][1:]))
            if distance < radii - .1:
                hits.append({"pathA": p["id"], "pathB": q["id"], "penetrationMm": round(radii - distance, 4)})
    return hits


def rounded(points):
    return [[round(v, 4) for v in p] for p in points]


def pv1_local():
    """Axis of Ø16 PV1 from its own outer dimensions (sheet69/PDF75).

    Local t points from the outermost end towards the concrete, w across
    thickness. R50 is an outer radius: the Ø16 centreline radius is42.
    Transitions have no assigned radius; only the signed straight segments
    are used, and the resulting 0.55% length discrepancy is reported.
    """
    points = [(955, -37), (340, -37), (240, -72), (50, -72)]
    for i in range(1, 46):
        angle = math.radians(-90 - 2 * i)
        points.append((50 + 42 * math.cos(angle), -30 + 42 * math.sin(angle)))
    points.append((8, 30))
    for i in range(1, 46):
        angle = math.radians(180 - 2 * i)
        points.append((50 + 42 * math.cos(angle), 30 + 42 * math.sin(angle)))
    points.extend([(240, 72), (340, 37), (955, 37)])
    return points


def group(gid, name, quantity, pages, paths):
    return {"id": gid, "name": name, "shortLabel": name, "designation": name,
            "quantity": quantity, "unit": "шт", "kind": "bar", "material": "A500C",
            "sourcePages": pages, "paths": paths}


def pv_group(product_page, length):
    paths = []
    local = pv1_local()
    for side in ("left", "right"):
        for n in range(9):
            y = 80 + 200 * n
            points = [(t - 290 if side == "left" else length + 290 - t, y, 125 + w) for t, w in local]
            paths.append({"id": f"pv1-{side}-{n + 1}", "diameter": 16, "material": "A500C",
                          "position": "2", "part": "ПВ1", "instance": f"ПВ1 {side} {n+1}",
                          "sourcePages": [product_page, 75, 80], "projectLength": 2025,
                          "points": rounded(points)})
    return group("pv1-end-loops", "ПВ1 · петлевые выпуски Ø16 А500С", 18, [product_page, 75, 80], paths)


def longitudinal_group(ab_page, ab_mark, length):
    paths = []
    for y in (80, 1700):
        for z in (50, 200):
            paths.append({"id": f"ab25-{y}-{z}", "diameter": 25, "material": "A500C",
                          "position": "3", "part": f"{ab_mark} поз.3", "instance": f"поз.3 y={y} z={z}",
                          "sourcePages": [ab_page], "projectLength": length,
                          "points": [[15, y, z], [15 + length, y, z]]})
    return group("ab-pos3-25", f"{ab_mark} поз.3 · прямые Ø25 А500С", 4, [ab_page], paths)


def steel_check(g, expected_kg, label, source):
    actual = group_mass(g)
    delta = (actual - expected_kg) / expected_kg * 100
    return {"check": "mass-vs-spec", "result": "pass" if abs(delta) <= 1 else "warn",
            "groupIds": [g["id"]], "metalPartIndices": [], "modelKg": round(actual, 5),
            "specKg": expected_kg, "deviationPercent": round(delta, 4), "tolerancePercent": 1,
            "detail": f"{label}: геометрическая масса {actual:.4f} кг, спецификация {expected_kg:.4f} кг ({source}); {delta:+.3f}%. Плотность 7850 кг/м³, масса по фактической оси, без подгонки длины."}


def coverage(position, mark, quantity, modeled, status, pages, reason=""):
    result = {"position": position, "mark": mark, "quantity": quantity,
              "modeledQuantity": modeled, "status": status, "sourcePages": pages}
    if reason:
        result["reason"] = reason
    return result


def build(base_path=None):
    register = json.loads((ASSETS / "promka-register.json").read_text())
    if base_path is None:
        candidate = ROOT / "tmp/rebar-models/plinths-base.json"
        base_path = candidate if candidate.exists() else None
    if base_path:
        base = json.loads(Path(base_path).read_text())
        live = base.get("models", base)
    else:
        live = json.loads((ASSETS / "promka-solid-models.json").read_text())
    supplies = json.loads((ASSETS / "promka-solid-supplies.json").read_text())
    assert hashlib.sha256((ASSETS / "sources/doc15.pdf").read_bytes()).hexdigest() == SOURCE_SHA
    by_alias = {v["alias"]: v for v in live.values()}
    models, qas, replaces = {}, {}, {}
    for alias, spec in SPECS.items():
        page, ab_page, ab, length, bar_length, bar_unit_mass, *others = spec
        old = by_alias[alias]
        assert old["sourceId"] == "doc15" and old["supplyId"] == "codex-quick-plinths-20261111"
        assert not old["groups"] and not old["metalParts"]
        entry = register[old["id"]]
        assert not entry.get("excluded") and not entry.get("groups")
        solid = copy.deepcopy(old)
        key = old["id"]
        replaces[key] = digest(old)
        old_qa = supplies[old["supplyId"]]["qa"]["models"][key]
        checks = copy.deepcopy(old_qa["checks"])
        groups = []
        component_coverage = []
        pending = [p for p in solid.get("pending", []) if p["id"] != "reinforcement-and-embedded"]
        if ab_page:
            g25 = longitudinal_group(ab_page, ab, bar_length)
            groups.append(g25)
            checks.append(steel_check(g25, 4 * bar_unit_mass, f"{ab} поз.3, 4×Ø25", f"PDF{ab_page}, собственная спецификация блока"))
            expected = {"quantity": 4, "diameter": 25, "lengthMm": bar_length, "x": [15, length - 15], "y": [80, 1700], "z": [50, 200]}
            actual = {"quantity": len(g25["paths"]), "diameter": 25,
                      "lengthMm": path_length(g25["paths"][0]["points"]),
                      "x": sorted({p["points"][i][0] for p in g25["paths"] for i in (0, 1)}),
                      "y": sorted({p["points"][0][1] for p in g25["paths"]}),
                      "z": sorted({p["points"][0][2] for p in g25["paths"]})}
            checks.append({"check": "signed-rebar-dimensions", "result": "pass" if expected == actual else "fail",
                           "groupIds": [g25["id"]], "expected": expected, "actual": actual,
                           "detail": f"{ab} поз.3: четыре прямых Ø25 L={bar_length}; АБ по длине центрирован с торцевыми отступами15; y=15+65 и15+65+1620; z=10+40 и10+40+150. Все цепочки подписаны в собственных видах/разрезе1-1."})
            component_coverage.append(coverage("изделие поз.1", ab, 1, 0, "partial", [page, ab_page], "Восстановлены только четыре прямых стержня поз.3; остальные позиции блока перечислены отдельно."))
            component_coverage.append(coverage(f"{ab} поз.3", f"Ø25 А500С L={bar_length}", 4, 4, "modeled", [ab_page]))
            positions = [1, 2, 4, 5, 6, 7]
            for position, (mark, quantity, unit_mass) in zip(positions, others):
                reason = "Собственная спецификация прочитана; точное размещение/слои и гибы этого компонента ещё не восстановлены. Геометрия другой марки не переносилась."
                component_coverage.append(coverage(f"{ab} поз.{position}", mark, quantity, 0, "pending", [ab_page], reason))
                pending.append({"id": f"ab-pos{position}", "kind": "not-modeled", "sourcePages": [ab_page],
                                "description": f"{ab} поз.{position}: {mark}, {quantity} шт. по {unit_mass:g} кг; {reason}"})
        if alias != "ПЦ-1":
            gp = pv_group(page, length)
            groups.append(gp)
            checks.append(steel_check(gp, 18 * 3.20, "ПВ1, 18×Ø16 А500С", f"PDF{page}:18шт по3,20кг; PDF75: L2025"))
            lengths = [path_length(p["points"]) for p in gp["paths"]]
            model_length = sum(lengths) / len(lengths)
            checks.append({"check": "component-length-vs-spec", "result": "pass" if abs(model_length / 2025 - 1) <= .01 else "warn",
                           "groupIds": [gp["id"]], "modelLengthMm": round(model_length, 5), "specLengthMm": 2025,
                           "deviationPercent": round((model_length / 2025 - 1) * 100, 4), "tolerancePercent": 1,
                           "detail": "ПВ1: ось восстановлена по наружному160, R50 (осьR42 дляØ16), размерной цепочке240+100+615=955 и хвостам с наружной шириной90; фактическая ось≈2014мм против заготовки2025. Разница не компенсирована выдуманными гибами/удлинением."})
            actual_y = sorted({p["points"][0][1] for p in gp["paths"]})
            expected_y = list(range(80, 1681, 200))
            checks.append({"check": "signed-pv-placement", "result": "pass" if actual_y == expected_y and len(gp["paths"]) == 18 else "fail",
                           "groupIds": [gp["id"]], "expected": {"quantity": 18, "perEnd": 9, "yMm": expected_y, "outsideProtrusionMm": 290, "outerWidthMm": 160},
                           "actual": {"quantity": len(gp["paths"]), "perEnd": 9, "yMm": actual_y,
                                      "outsideProtrusionMm": round(-(min(p[0] for p in gp["paths"][0]["points"]) - 8), 3),
                                      "outerWidthMm": round(max(p[2] for p in gp["paths"][0]["points"]) - min(p[2] for p in gp["paths"][0]["points"]) + 16, 3)},
                           "detail": f"Фасад PDF{page}:80+8×200+100=1780, 9выпусков с каждого торца; вид2-2:вылет290 и наружный размер160 по толщине250, отступы45. Два торца зеркальны."})
            component_coverage.append(coverage("изделие поз.2", "ПВ1 Ø16 А500С L2025", 18, 18, "modeled", [page, 75, 80]))
        else:
            reason = "Два ПВ1 с размером955 и вылетом290 дают заделку665 с каждого торца; при Lпанели1160 прямые хвосты встречных выпусков совпадают на170мм. Смещение по высоте/толщине или подрезка не размерены. Все18ПВ1 оставлены без геометрии, произвольный один торец не выбран."
            component_coverage.append(coverage("изделие поз.2", "ПВ1 Ø16 А500С L2025", 18, 0, "pending", [page, 75, 80], reason))
            pending.append({"id": "pv1-overlap-pc1", "kind": "source-conflict", "sourcePages": [page, 75, 80], "description": reason})
            checks.append({"check": "pv1-opposed-tail-conflict", "result": "warn", "detail": reason,
                           "expected": {"panelLengthMm": 1160, "pvOverallMm": 955, "protrusionMm": 290}, "actual": {"embedmentMmPerEnd": 665, "coincidentTailLengthMm": 170, "modeledQuantity": 0}})
        component_coverage.append(coverage("закладные пластины", "Пластины/металлические закладные", 0, 0, "modeled", [page], "В собственной спецификации изделия только арматурный блок и ПВ1; отдельных закладных пластин нет. Петли не считаются пластинами."))
        paths = [p for g in groups for p in g["paths"]]
        # Independent own-product steel schedule: all А500С of these four
        # diameters belongs respectively to К1, Сn, ПВ1 and AB pos.3.
        schedule = {8: others[1][1] * 2.00, 12: others[0][2] * 2,
                    16: 57.60, 25: 4 * bar_unit_mass}
        diameter_coverage = []
        for diameter, expected_kg in schedule.items():
            matching = [g for g in groups if all(p["diameter"] == diameter for p in g["paths"])]
            actual_kg = sum(group_mass(g) for g in matching)
            complete = bool(matching)
            diameter_coverage.append({"material": "A500C", "diameter": diameter,
                                      "sourcePages": [page], "specKg": round(expected_kg, 5),
                                      "modeledKg": round(actual_kg, 5),
                                      "status": "modeled" if complete else "pending",
                                      "reason": "Весь диаметр по собственной ведомости" if complete else "Позиции этого диаметра ещё не восстановлены; нулевая геометрия не считается сверкой полной массы."})
            if complete:
                delta = (actual_kg / expected_kg - 1) * 100
                checks.append({"check": "diameter-mass-vs-own-steel-schedule", "result": "pass" if abs(delta) <= 1 else "warn",
                               "material": "A500C", "diameter": diameter,
                               "groupIds": [g["id"] for g in matching], "metalPartIndices": [],
                               "modelKg": round(actual_kg, 5), "specKg": round(expected_kg, 5),
                               "deviationPercent": round(delta, 4), "tolerancePercent": 1,
                               "sourcePages": [page],
                               "detail": f"А500С Ø{diameter}: вся геометрия этого диаметра {actual_kg:.4f} кг против {expected_kg:.4f} кг собственной ведомости расхода стали PDF{page}; {delta:+.3f}%."})
        canonical = [dumps(p["points"]) for p in paths]
        checks.append({"check": "unique-rebar-paths", "result": "pass" if len(canonical) == len(set(canonical)) else "fail",
                       "detail": f"{len(paths)} отдельных путей; точные совпадающие пути отсутствуют. Это не является полной проверкой сварочных коллизий."})
        collisions = steel_collisions(paths)
        checks.append({"check": "modeled-steel-pairwise-clearance", "result": "fail" if collisions else "pass",
                       "penetrations": collisions, "toleranceMm": .1,
                       "detail": "Расстояния между осями разных восстановленных стержней проверены по всем отрезкам с учётом суммы радиусов. Пересечений добавленной стали нет; невосстановленные сетки и сварные узлы эта проверка не охватывает."})
        checks.append({"check": "concrete-preserved", "result": "pass" if all(solid[f] == old[f] for f in ("id", "sourceId", "alias", "bounds", "concreteParts")) else "fail",
                       "detail": "Исходные id/sourceId/alias, бетонные части и границы сохранены побайтово по структуре JSON; исходные бетонные проверки сохранены."})
        solid["groups"] = groups
        solid["supplyId"] = SUPPLY_ID
        solid["status"] = "partial"
        solid["pending"] = pending
        solid["sourcePolicy"] = {"mode": "own-product-and-explicit-component-references", "sourceId": "doc15", "sha256": SOURCE_SHA,
                                 "productPage": page, "assemblyPage": ab_page, "componentPages": [75, 80],
                                 "restriction": "Размеры и количество каждого компонента из собственной спецификации изделия/его явно указанного АБ. Чужой АБ и непоказанные сдвиги/гибы не используются."}
        if ab_page:
            solid["evidence"].append({"pdfPage": ab_page, "subject": f"{ab}: собственная спецификация и разрез1-1",
                                      "checks": [f"Поз.3:4×Ø25А500С L{bar_length}, {bar_unit_mass:g}кг/шт", "Положение по цепочкам40+150+40,65+1620+65 и торцевым отступам15; остальные позиции блока остаются pending"]})
        solid["evidence"].append({"pdfPage": 75, "sheet": "69", "subject": "ПВ1: собственный явно указанный компонент",
                                  "checks": ["Ø16А500С L2025,1шт,3,196кг (в таблице округлено3,20)", "Наружная ширина160, R50,240+100+615=955, ширина хвостов90"]})
        if alias != "ПЦ-1":
            solid["assumptions"].append({"id": "pv1-bend-resolution", "affects": ["pv1-end-loops"],
                                         "text": "Радиус50 прочитан по наружному контуру; осьØ16 имеет R42. Дуги разбиты через2°. В точках перехода240/340 радиус на листе не задан: дополнительных дуг не придумано. Поэтому длина оси отличается от заготовки2025 примерно на0,55%; расхождение сохранено вQA, масса не подгонялась."})
        names = ("четыре прямых Ø25 поз.3 собственного АБ" if ab_page else "")
        if alias != "ПЦ-1":
            names += (" и " if names else "") + "все18 торцевых выпусков ПВ1"
        solid["notes"] = ["Частичное восстановление стали по собственным листам; бетон, проектные объём, масса и калькуляция не изменяются.",
                          f"Показаны {names}. Остальная сталь конкретно перечислена в pending/QA.componentCoverage. Отдельных закладных пластин по спецификации нет."]
        solid["readinessDescription"] = f"Бетон сохранён; восстановлены {names}. Сетки, каркасы и прочие позиции ещё не восстановлены. Статус частичный; производственная готовность не заявляется."
        if alias == "ПЦ-1":
            solid["readinessDescription"] += " Все ПВ1 оставлены pending: встречные хвосты по размерам исходника совпадают на170мм, смещение или подрезка не заданы."
        # Recheck protected fields after all mutations, not only before updates.
        assert all(solid[f] == old[f] for f in ("id", "sourceId", "alias", "bounds", "concreteParts", "metalParts"))
        assert not any(c["result"] == "fail" for c in checks), (alias, checks)
        qa = {"alias": alias, "status": "partial", "checks": checks, "componentCoverage": component_coverage,
              "diameterCoverage": diameter_coverage,
              "modeledSteelKg": round(sum(group_mass(g) for g in groups), 5),
              "counts": {"concreteParts": len(solid["concreteParts"]), "metalParts": 0, "groups": len(groups), "paths": len(paths),
                         "checks": len(checks), "warnings": sum(c["result"] == "warn" for c in checks), "failures": 0}}
        models[key], qas[key] = solid, qa
    sha = digest(models)
    installed = supplies.get(SUPPLY_ID, {})
    captured_at = (installed["capturedAt"] if installed.get("modelsSha256") == sha
                   else datetime.datetime.now(datetime.timezone.utc).isoformat())
    delivery = {"label": "Codex · ПЦ: собственные прямыеØ25 и торцевыеПВ1", "snapshot": "20261111-rebar-plinths",
                "modelsSha256": sha, "modelCount": len(models), "capturedAt": captured_at,
                "sourcePolicy": {"mode": "own-product-and-explicit-component-references", "sourceId": "doc15", "sha256": SOURCE_SHA},
                "qa": {"modelsSha256": sha, "tool": "scripts/build_calc_rebar_plinths.py", "models": qas,
                       "covers": ["сохранность бетонной геометрии", "собственные количества/размеры прямыхØ25 иПВ1", "масса по фактическим осям с плотностью7850 против собственной спецификации", "явный остаток каждой позиции вcomponentCoverage"],
                       "doesNotCover": ["невосстановленные сетки/каркасы/петли/хомуты/скобы", "полная проверка сварочных коллизий", "производственная готовность"]},
                "report": "9 частичных улучшений. ПрямыеØ25 поз.3 собственныхАБ:ПЦ-1/2/3/4/6/7/8/9/10. Полные18ПВ1:ПЦ-2/3/4/6/7/8/9/10. ПЦ-1ПВ1pending:конфликт170мм встречных хвостов. Пластин по собственным спецификациям нет."}
    return {"models": models, "supplies": {SUPPLY_ID: delivery}, "replaces": replaces}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/rebar-models/plinths.json")
    parser.add_argument("--base", type=Path, help="JSON с исходными raw-моделями; по умолчанию plinths-base.json, если сохранён")
    args = parser.parse_args()
    payload = build(args.base)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(dumps(payload))
    for qa in payload["supplies"][SUPPLY_ID]["qa"]["models"].values():
        print(qa["alias"], qa["counts"], "modeledSteelKg", qa["modeledSteelKg"])
    print("Wrote", args.output)


if __name__ == "__main__":
    main()

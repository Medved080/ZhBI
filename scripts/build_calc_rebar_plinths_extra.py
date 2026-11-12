#!/usr/bin/env python3
"""Separate protected upgrades of 22 taller ПЦ panels: only own-spec 24 ПВ1.

Does not modify the first rebar package or shared assets. AB internals remain
pending; no geometry is borrowed from another AB. PV1 is explicitly referenced
by every selected product's own specification.
"""
import argparse
import copy
import datetime
import hashlib
import json
from pathlib import Path

from build_calc_rebar_plinths import (ASSETS, SOURCE_SHA, ROOT, coverage, digest,
                                     dumps, group, group_mass, path_length,
                                     pv1_local, rounded, steel_check, steel_collisions)

SUPPLY_ID = "codex-rebar-plinths-extra-20261111"
# Own product PDF page, signed length, own AB mark, AB sheet reference,
# PV1 is pos.2,24pieces,3.20kg each on every selected sheet.
SPECS = {
    "ПЦ-12": (29, 1700, "АБ12", "24"),
    "ПЦ-13": (31, 1800, "АБ13", "26"),
    "ПЦ-14": (33, 2110, "АБ14", "28"),
    "ПЦ-15": (35, 2820, "АБ15", "30"),
    "ПЦ-16": (37, 3120, "АБ16", "32"),
    "ПЦ-17": (39, 3210, "АБ17", "34"),
    "ПЦ-18": (41, 4160, "АБ18", "36"),
    "ПЦ-19": (43, 4260, "АБ19", "38"),
    "ПЦ-20": (45, 6110, "АБ20", "40"),
    "ПЦ-21": (47, 6160, "АБ21", "42"),
    "ПЦ-22": (49, 6260, "АБ22", "44"),
    "ПЦ-23": (51, 6560, "АБ23", "46"),
    "ПЦ-24": (53, 6860, "АБ24", "48"),
    "ПЦ-25": (55, 6960, "АБ25", "50"),
    "ПЦ-26": (57, 7660, "АБ26", "52"),
    "ПЦ-28": (61, 8660, "АБ28", "56"),
    "ПЦ-29": (63, 8810, "АБ29", "58"),
    "ПЦ-31": (67, 9290, "АБ31", "62"),
    "ПЦ-32": (69, 9350, "АБ32", "64"),
    "ПЦ-33": (71, 9660, "АБ33", "66"),
    "ПЦ-34": (73, 9720, "АБ34", "68"),
    "ПЦ-33-1": (87, 9660, "АБ33-1", "82"),
}
LEVELS = [80 + 200 * i for i in range(10)] + [2030, 2180]


def pv24(page, length):
    paths = []
    for side in ("left", "right"):
        for n, y in enumerate(LEVELS):
            points = [(t - 290 if side == "left" else length + 290 - t, y, 125 + w) for t, w in pv1_local()]
            paths.append({"id": f"pv1-{side}-{n+1}", "diameter": 16, "material": "A500C",
                          "position": "2", "part": "ПВ1", "instance": f"ПВ1 {side} {n+1}",
                          "projectLength": 2025, "sourcePages": [page, 75, 80], "points": rounded(points)})
    return group("pv1-end-loops", "ПВ1 · 24 торцевых выпуска Ø16 А500С", 24, [page, 75, 80], paths)


def build(base_path=None):
    if base_path is None:
        candidate = ROOT / "tmp/rebar-models/plinths-extra-base.json"
        base_path = candidate if candidate.exists() else None
    if base_path:
        base = json.loads(Path(base_path).read_text())
        live = base.get("models", base)
    else:
        live = json.loads((ASSETS / "promka-solid-models.json").read_text())
    register = json.loads((ASSETS / "promka-register.json").read_text())
    supplies = json.loads((ASSETS / "promka-solid-supplies.json").read_text())
    assert hashlib.sha256((ASSETS / "sources/doc15.pdf").read_bytes()).hexdigest() == SOURCE_SHA
    by_alias = {m["alias"]: m for m in live.values()}
    models, qas, replaces = {}, {}, {}
    for alias, (page, length, ab, ab_sheet) in SPECS.items():
        old = by_alias[alias]
        key = old["id"]
        entry = register[key]
        assert old["sourceId"] == "doc15" and old["supplyId"] == "codex-quick-plinths-20261111"
        assert entry["source"]["productPage"] == page and not entry.get("excluded") and not entry.get("groups")
        assert not old["groups"] and not old["metalParts"]
        assert old["bounds"] == [[0, 0, 0], [length, 2280, 250]]
        replaces[key] = digest(old)
        solid = copy.deepcopy(old)
        g = pv24(page, length)
        checks = copy.deepcopy(supplies[old["supplyId"]]["qa"]["models"][key]["checks"])
        checks.append(steel_check(g, 24 * 3.20, "ПВ1,24×Ø16А500С", f"собственная спецификация PDF{page}:24шт по3,20кг; детальПВ1 PDF75"))
        ell = path_length(g["paths"][0]["points"])
        checks.append({"check": "component-length-vs-spec", "result": "pass" if abs(ell / 2025 - 1) < .01 else "warn",
                       "groupIds": [g["id"]], "modelLengthMm": round(ell, 5), "specLengthMm": 2025,
                       "deviationPercent": round((ell / 2025 - 1) * 100, 4), "tolerancePercent": 1,
                       "detail": "ПВ1 по собственному листу69: наружные160,R50,240+100+615=955, наружная ширина хвостов90. ОсьØ16 имеет R42 и длину≈2014мм против заготовки2025; никакого добавленного удлинения для совпадения массы."})
        actual_y = sorted({p["points"][0][1] for p in g["paths"]})
        expected = {"quantity": 24, "perEnd": 12, "yMm": LEVELS, "outsideProtrusionMm": 290,
                    "outerWidthMm": 160, "bottomOffsetMm": 80, "topOffsetMm": 100,
                    "mainIntervalMm": 200, "topIntervalsMm": [150, 150]}
        first_points = g["paths"][0]["points"]
        actual = {"quantity": len(g["paths"]), "perEnd": sum("left" in p["id"] for p in g["paths"]),
                  "yMm": actual_y,
                  "outsideProtrusionMm": round(-(min(p[0] for p in first_points) - 8), 4),
                  "outerWidthMm": round(max(p[2] for p in first_points) - min(p[2] for p in first_points) + 16, 4),
                  "bottomOffsetMm": actual_y[0], "topOffsetMm": 2280 - actual_y[-1],
                  "mainIntervalMm": actual_y[1] - actual_y[0],
                  "topIntervalsMm": [actual_y[-2] - actual_y[-3], actual_y[-1] - actual_y[-2]]}
        checks.append({"check": "signed-pv-placement", "result": "pass" if expected == actual else "fail",
                       "groupIds": [g["id"]], "expected": expected, "actual": actual,
                       "detail": f"PDF{page}:12выпусков с каждого торца; цепочка80+9×200+2×150+100=2280. Вылет290, наружный160 и отступы45 по толщине250 подтверждены видами и узлом1."})
        collisions = steel_collisions(g["paths"])
        checks.append({"check": "modeled-steel-pairwise-clearance", "result": "fail" if collisions else "pass",
                       "penetrations": collisions, "toleranceMm": .1,
                       "detail": "Попарные расстояния между разными восстановленными выпусками с учётом радиусов: пересечений нет. Невосстановленная сталь АБ не проверялась."})
        checks.append({"check": "concrete-preserved", "result": "pass",
                       "detail": "Бетон, bounds и идентификаторы сохранены; исходные бетонные проверки перенесены без изменений."})
        coverage_list = [coverage("изделие поз.1", ab, 1, 0, "pending", [page],
                                  f"Собственный {ab}, л.{ab_sheet}, полностью ожидает восстановления. Включая его сетки, каркасы, петли, хомуты, скобы и возможные металлические детали. Содержимое другого АБ не переносилось."),
                         coverage("изделие поз.2", "ПВ1 Ø16А500С L2025", 24, 24, "modeled", [page, 75, 80]),
                         coverage("отдельные закладные пластины", "Отдельные позиции пластин в спецификации изделия", 0, 0, "modeled", [page],
                                  "В собственной спецификации изделия только АБ и ПВ1; отдельных пластин нет. Внутреннее содержимое АБ остаётся pending, отсутствие металла внутри АБ не утверждается. Петлевой выпуск не называется пластиной.")]
        pending = [p for p in solid.get("pending", []) if p["id"] != "reinforcement-and-embedded"]
        pending.append({"id": "assembly-block-pending", "kind": "not-modeled", "sourcePages": [page],
                        "description": f"{ab},1шт, собственная ссылка на л.{ab_sheet}: весь блок и его компоненты не восстановлены, в том числе лицевые/монтажные петли и возможные закладные. Показаны только24ПВ1 отдельной позиции2."})
        if alias in ("ПЦ-12", "ПЦ-13"):
            text = "В размерной цепочке напечатано200×10=1800; множитель10 арифметически неверен. Подписанный пролёт1800, шаг200,12 фактически нарисованных выпусков и два верхних интервала150 дают9 основных интервалов:80+1800+300+100=2280. Использовано9, геометрия не подгонялась по массе."
            checks.append({"check": "dimension-chain-print-conflict", "result": "warn", "sourcePages": [page], "detail": text})
            solid["issues"].append({"id": "pv-step-multiplier-typo", "kind": "source-conflict", "severity": "info", "blocksAcceptance": False,
                                    "sourcePages": [page], "title": "Опечатка множителя в цепочке200×10=1800", "description": text})
        solid["supplyId"] = SUPPLY_ID
        solid["groups"] = [g]
        solid["pending"] = pending
        solid["status"] = "partial"
        solid["sourcePolicy"] = {"mode": "own-product-and-explicit-component-reference", "sourceId": "doc15", "sha256": SOURCE_SHA,
                                 "productPage": page, "componentPages": [75, 80],
                                 "restriction": "Моделируется только собственная позиция2 ПВ1; размеры и количество по собственному листу. Арматурный блок позиции1 не моделируется и не копируется по сходству."}
        solid["evidence"].extend([{"pdfPage": page, "subject": f"{alias}: собственная позиция2 и размещениеПВ1",
                                    "checks": ["24ПВ1 по3,20кг,12на каждом торце", "Цепочка80+9×200+2×150+100=2280, вылет290 и толщина250", f"Поз.1:{ab},1шт,л.{ab_sheet},не восстановлен"]},
                                   {"pdfPage": 75, "sheet": "69", "subject": "ПВ1 — явно указанный компонент изделия",
                                    "checks": ["Ø16А500С L2025,1шт,3,196кг (3,20кг в округлении)", "160,R50,240+100+615=955,ширина хвостов90"]}])
        solid["assumptions"].append({"id": "pv1-bend-resolution", "affects": [g["id"]],
                                     "text": "R50 относится к наружному контуру, осьØ16 имеет R42; дуги разбиты через2°. Радиус переходов240/340 на листе не задан, дополнительные гибы не придуманы. Фактическая ось короче заготовки2025 примерно на0,55%; это явно отражено вQA, длина не удлинялась ради массы."})
        solid["notes"] = ["Частичное добавление стали по собственной спецификации; бетон, проектные объём, масса и калькуляция не меняются.",
                          "Показаны только24 торцевых ПВ1. Весь собственный арматурный блок, лицевые/монтажные петли и возможные закладные остаются pending. Отдельных пластин в спецификации изделия нет."]
        solid["readinessDescription"] = f"Бетон сохранён; добавлены все24 торцевых выпускаПВ1. Собственный {ab} целиком ожидает восстановления. Модель частичная; сетки, каркасы, прочие петли и металл блока не показаны."
        assert all(solid[f] == old[f] for f in ("id", "sourceId", "alias", "bounds", "concreteParts", "metalParts"))
        assert not any(c["result"] == "fail" for c in checks), (alias, checks)
        qa = {"alias": alias, "status": "partial", "checks": checks, "componentCoverage": coverage_list,
              "diameterCoverage": [{"scope": "только изделие поз.2 ПВ1; весь АБ pending", "material": "A500C", "diameter": 16,
                                    "specKg": 76.80, "modeledKg": round(group_mass(g), 5), "status": "modeled", "sourcePages": [page, 75]}],
              "modeledSteelKg": round(group_mass(g), 5),
              "counts": {"concreteParts": len(solid["concreteParts"]), "metalParts": 0, "groups": 1, "paths": 24,
                         "checks": len(checks), "warnings": sum(c["result"] == "warn" for c in checks), "failures": 0}}
        models[key], qas[key] = solid, qa
    sha = digest(models)
    installed = supplies.get(SUPPLY_ID, {})
    captured_at = (installed["capturedAt"] if installed.get("modelsSha256") == sha
                   else datetime.datetime.now(datetime.timezone.utc).isoformat())
    delivery = {"label": "Codex · высокие ПЦ: только24 торцевыхПВ1", "snapshot": "20261111-rebar-plinths-extra",
                "modelsSha256": sha, "modelCount": len(models), "capturedAt": captured_at,
                "sourcePolicy": {"mode": "own-product-and-explicit-component-reference", "sourceId": "doc15", "sha256": SOURCE_SHA},
                "qa": {"modelsSha256": sha, "tool": "scripts/build_calc_rebar_plinths_extra.py", "models": qas,
                       "covers": ["сохранность бетона", "собственные24ПВ1 на каждом изделии", "размеры/размещение/длина фактических осей", "геометрическая массаПВ1 против собственной спецификации", "попарная проверка добавленной стали"],
                       "doesNotCover": ["весь собственный арматурный блок", "сетки/каркасы/лицевые и монтажные петли/металл внутриАБ", "производственная готовность"]},
                "report": "22частичных улучшения, только полные комплекты24ПВ1 каждой панели. Все арматурные блоки целиком pending. ПЦ12/13: опечатка200×10=1800 раскрыта вQA, использованы12 нарисованных выпусков и согласованные подписанные размеры.",
                "skipped": {"ПЦ-11": "L910 меньше суммы заделок2×665; совпадение встречных хвостов420мм, сдвиг/подрезка не размерены",
                            "ПЦ-35": "Другой компонентПВ2 и разноуровневый контур; не переноситьПВ1"}}
    return {"models": models, "supplies": {SUPPLY_ID: delivery}, "replaces": replaces}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/rebar-models/plinths-extra.json")
    parser.add_argument("--base", type=Path, help="JSON с исходными raw-моделями; по умолчанию plinths-extra-base.json, если сохранён")
    args = parser.parse_args()
    package = build(args.base)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(dumps(package))
    print("models", len(package["models"]), "paths", sum(q["counts"]["paths"] for q in package["supplies"][SUPPLY_ID]["qa"]["models"].values()))
    print("Wrote", args.output)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build isolated, concrete-only partial models of visually checked doc15 panels.

Does not edit the shared catalog/solid files. Every dimension below was read from
the product sheet, including the two stepped profiles; no sketch dimensions are
used. Run with .venv312/bin/python scripts/build_calc_quick_plinths.py.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

from shapely.geometry import Polygon, box
import build_calc_slab_models as slab

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "data/calc/assets"
SUPPLY_ID = "codex-quick-plinths-20261111"
# alias: (PDF page, signed length, signed height, spec volume m3).
# Front elevation and two orthogonal sections were visually inspected for each.
SHEETS = {
    "ПЦ-1": (7, 1160, 1780, .516),
    "ПЦ-2": (9, 2030, 1780, .903),
    "ПЦ-3": (11, 2940, 1780, 1.308),
    "ПЦ-4": (15, 3760, 1780, 1.673),
    "ПЦ-6": (17, 4160, 1780, 1.851),
    "ПЦ-7": (19, 4260, 1780, 1.896),
    "ПЦ-8": (21, 4360, 1780, 1.940),
    "ПЦ-9": (23, 4460, 1780, 1.985),
    "ПЦ-10": (25, 4960, 1780, 2.207),
    "ПЦ-11": (27, 910, 2280, .519),
    "ПЦ-12": (29, 1700, 2280, .969),
    "ПЦ-13": (31, 1800, 2280, 1.026),
    "ПЦ-14": (33, 2110, 2280, 1.20),
    "ПЦ-15": (35, 2820, 2280, 1.61),
    "ПЦ-16": (37, 3120, 2280, 1.78),
    "ПЦ-17": (39, 3210, 2280, 1.83),
    "ПЦ-18": (41, 4160, 2280, 2.37),
    "ПЦ-19": (43, 4260, 2280, 2.43),
    "ПЦ-20": (45, 6110, 2280, 3.48),
    "ПЦ-21": (47, 6160, 2280, 3.51),
    "ПЦ-22": (49, 6260, 2280, 3.57),
    "ПЦ-23": (51, 6560, 2280, 3.74),
    "ПЦ-24": (53, 6860, 2280, 3.91),
    "ПЦ-25": (55, 6960, 2280, 3.97),
    "ПЦ-26": (57, 7660, 2280, 4.37),
    "ПЦ-28": (61, 8660, 2280, 4.94),
    "ПЦ-29": (63, 8810, 2280, 5.02),
    "ПЦ-31": (67, 9290, 2280, 5.30),
    "ПЦ-32": (69, 9350, 2280, 5.33),
    "ПЦ-33": (71, 9660, 2280, 5.51),
    "ПЦ-34": (73, 9720, 2280, 5.54),
    "ПЦ-35": (85, 9630, 2280, 4.43),
    "ПЦ-33-1": (87, 9660, 2280, 5.15),
}


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def profile_for(alias, length, height):
    if alias == "ПЦ-35":
        return Polygon([(0, 0), (9630, 0), (9630, 1080),
                        (6030, 1080), (6030, 2280), (0, 2280)]), \
            "(6030×2280 + 3600×1080)×250/10⁹ = 4,4091 м³; справа пониженная часть 3600×1080"
    if alias == "ПЦ-33-1":
        return Polygon([(0, 0), (9660, 0), (9660, 2280),
                        (6370, 2280), (6370, 1810), (3290, 1810),
                        (3290, 2280), (0, 2280)]), \
            "(9660×2280 − 3080×470)×250/10⁹ = 5,1443 м³; верхний вырез x=3290…6370, y=1810…2280"
    return box(0, 0, length, height), f"{length}×{height}×250/10⁹ м³; прямоугольный сплошной бетонный контур"


def build():
    register = json.loads((ASSETS / "promka-register.json").read_text())
    catalog_models = json.loads((ASSETS / "promka-models.json").read_text())
    existing = json.loads((ASSETS / "promka-solid-models.json").read_text())
    models, qas, skipped = {}, {}, {}
    for entry in register.values():
        alias = entry.get("alias")
        if alias not in SHEETS:
            continue
        key = entry["id"]
        if (key in existing and existing[key].get("supplyId") != SUPPLY_ID) or entry.get("groups") or entry.get("excluded") or catalog_models.get(key, {}).get("groups"):
            skipped[alias] = "Уже есть solid, арматурные группы либо изделие исключено"
            continue
        page, length, height, volume = SHEETS[alias]
        assert entry["source"]["id"] == "doc15" and entry["source"]["productPage"] == page
        profile, formula = profile_for(alias, length, height)
        part = slab.extrusion_part(f"Бетон {alias}: фасад по подписанным размерам, толщина 250", profile,
                                  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 250, [page])
        parts = [part]
        bounds = slab._bounds_of(parts)
        dimensions = [bounds[1][i] - bounds[0][i] for i in range(3)]
        expected = [length, height, 250]
        check = slab._volume_check(parts, volume, f"doc15, PDF {page}, лист {entry['source']['sheet']}, спецификация бетона", tolerance=.01)
        checks = [check, {"check": "signed-dimensions", "result": "pass" if dimensions == expected else "fail",
                         "expected": expected, "actual": dimensions, "units": "mm", "axes": ["x", "y", "z"],
                         "detail": f"Подписанные размеры фасада и разрезов: {length} × {height} × 250 мм; {formula}"},
                  {"check": "visual-profile-review", "result": "pass", "sourcePages": [page, 80],
                   "detail": "Проверены полный фасад, два ортогональных разреза и узел 1 л.74: видимые выпуски относятся к арматуре; сквозных отверстий в бетонном теле не показано. " + formula},
                  *slab._structure_checks(parts)]
        issues = []
        if alias == "ПЦ-35":
            issues.append({"id": "spec-volume-difference", "kind": "source-conflict", "severity": "info", "blocksAcceptance": False,
                           "sourcePages": [page], "title": "Размеры и объём спецификации отличаются на 0,0209 м³",
                           "description": "Фасад и разрез 3-3 дают высоту справа 1080, длину ступени 3600, слева 6030×2280, толщину 250 мм. По этим размерам 4,4091 м³; в спецификации 4,43 м³ (−0,47%). Геометрия не подгонялась к объёму."})
        solid = {
            "id": key, "sourceId": "doc15", "alias": alias, "supplyId": SUPPLY_ID,
            "format": "project-solids-mm-v1", "status": "partial", "modelType": "source-dimensioned-concrete-panel",
            "elementType": "цокольная стеновая панель", "concreteParts": parts, "metalParts": [], "groups": [], "bounds": bounds,
            "coordinateSystem": "мм; x — вдоль панели, y — вверх, z — толщина",
            "coordinateOrigin": "x=0 — левый торец фасада; y=0 — низ панели; z=0 — передняя бетонная грань",
            "evidence": [{"pdfPage": page, "sheet": entry["source"]["sheet"], "subject": f"{alias}: размеренный фасад, разрезы и спецификация",
                          "checks": [f"Габариты бетонного тела {length}×{height}×250 мм", formula, f"Спецификация бетона {volume:g} м³; прочитана визуально", "Контур проверен визуально, включая верхние ступени и отсутствие сквозных отверстий"]},
                         {"pdfPage": 80, "sheet": "74", "subject": "Узел 1: петлевой арматурный выпуск за торец бетонной панели",
                          "checks": ["Сужение в узле относится к стержням выпуска ПВ; бетонный торец остаётся прямым"]}],
            "pending": [{"id": "reinforcement-and-embedded", "kind": "not-modeled", "sourcePages": [page, 75, 80],
                         "description": "Арматурный блок, петлевые выпуски ПВ, монтажные и лицевые петли, закладные и их точное пространственное размещение не восстановлены. Показано только бетонное тело; масса арматуры моделью не проверялась."}],
            "assumptions": [{"id": "nominal-concrete-outline", "affects": ["concrete"],
                             "text": "Бетон построен по размеренному внешнему контуру фасада и толщине разрезов. Знаки лицевых петель не являются отверстиями. Мелкие технологические фаски, скругления и монтажные углубления без самостоятельных размеров не восстановлены; их учёт не заявляется."}],
            "issues": issues, "notes": ["Частичная модель бетонного тела по чертежу; проектные объём, масса и калькуляция не изменяются.",
                                        "Армирование, металлические детали и производственная деталировка остаются неподтверждёнными."],
            "readinessDescription": "Бетонный контур подтверждён фасадом и разрезами; арматура и закладные ожидают восстановления.",
            "supersedesSketch": True,
        }
        qa = {"alias": alias, "status": "partial", "checks": checks,
              "counts": {"concreteParts": 1, "metalParts": 0, "groups": 0, "checks": len(checks),
                         "warnings": sum(c["result"] == "warn" for c in checks), "failures": sum(c["result"] == "fail" for c in checks)}}
        assert not qa["counts"]["failures"] and check["result"] == "pass", (alias, qa)
        models[key], qas[key] = solid, qa
    sha = hashlib.sha256(dumps(models).encode()).hexdigest()
    previous = json.loads((ASSETS / "promka-solid-supplies.json").read_text()).get(SUPPLY_ID, {})
    captured_at = previous.get("capturedAt") if previous.get("modelsSha256") == sha else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery = {"label": "Codex · цокольные панели: бетон по размеренным чертежам", "snapshot": "20261111-quick-plinths",
                "modelsSha256": sha, "modelCount": len(models), "capturedAt": captured_at,
                "qa": {"modelsSha256": sha, "tool": "scripts/build_calc_quick_plinths.py", "models": qas,
                       "covers": ["визуальный контроль фасада и двух ортогональных разрезов каждой модели", "подписанные габариты", "вырезы и ступени внешнего бетонного контура", "объём против спецификации с допуском 1%", "валидность многоугольников"],
                       "doesNotCover": ["армирование и металл", "деталировка фасок и монтажных углублений без размеров", "производственная готовность"]},
                "report": "33 визуально проверенных листа doc15: 31 прямоугольная панель, ПЦ-35 со ступенью, ПЦ-33-1 с верхним вырезом. Только бетон. ПЦ-35: расхождение с объёмом спецификации −0,47%, сохранены размеры чертежа.",
                "skipped": {"ПЦ-5": "Источник актуализирован на doc22; подтверждённый бетонный лист изделия отсутствует", **skipped}}
    return {"models": models, "supplies": {SUPPLY_ID: delivery}}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=ROOT / "tmp/quick-models/plinths.json")
    args = ap.parse_args()
    payload = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(dumps(payload))
    for key, qa in payload["supplies"][SUPPLY_ID]["qa"]["models"].items():
        c = qa["checks"][0]
        print(f"{qa['alias']:9s} {c['modelM3']:.5f} / {c['specM3']:.3f} м³; {c['deviationPercent']:+.2f}% {c['result']}")
    print(f"Wrote {len(payload['models'])} models: {args.output}")


if __name__ == "__main__":
    main()

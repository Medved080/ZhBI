#!/usr/bin/env python3
"""Калькулятор: 3D-модели изделий, у которых «модели не построено» (2026-10-20): ригели РМ1, РМ2, колонны Кн4.5, Кн4.6, ригель 3Р14.5м.

Откуда берётся геометрия: векторные листы КЖИ (PDF из data/calc/assets/sources), размеры — с самих листов (размерные цепочки, масштаб по подписанному
размеру контура). Всё, что лист не даёт или даёт чужими ссылками (сетки на листах КМ.И1, которых в комплекте нет), в модель не включено и записано в `pending`.
Модель — «частичная», на проектный объём, массу и калькуляцию не влияет. Проверки (объём против спецификации листа, масса каждого вида арматуры против
ведомости) пишутся в `qa` каждой модели.

Запуск (читает PDF и каталог, пишет в data/calc/assets; перед записью — копии в data/calc/backups):

    .venv/bin/python scripts/build_calc_missing_models.py            # собрать и показать проверку, ничего не писать
    .venv/bin/python scripts/build_calc_missing_models.py --write    # и дописать в promka-solid-models/-supplies
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import shutil
import sys
from pathlib import Path

from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab  # noqa: E402  — читалка векторных листов и общие проверки моделей

ROOT = slab.ROOT
CATALOG_DIR = slab.CATALOG_DIR
ASSETS = slab.ASSETS
BACKUPS = slab.BACKUPS
SUPPLY_ID = "claude-missing-3d"
SNAPSHOT = "20261020-missing-3d"
STEEL_KG_PER_M3 = 7850.0


def bar_kg(diameter, length_mm):
    return math.pi * diameter ** 2 / 4 * length_mm * STEEL_KG_PER_M3 / 1e9


def path_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


def groups_kg(groups):
    return sum(bar_kg(p["diameter"], path_length(p["points"])) for g in groups for p in g["paths"])


def rounded_loop(x, z0, z1, y0, y1, radius, lap=0.0, lap_offset=12.0, steps=6):
    """Хомут в плоскости (z, y) при x = const: прямоугольник z0…z1 × y0…y1 со скруглёнными углами (ось стержня), начало и конец — на левой стороне.
    lap — нахлёст замка: конец стержня идёт ещё lap мм вверх вдоль начала левой стороны со сдвигом внутрь на lap_offset."""
    def arc(cz, cy, a0, a1):
        return [[x, round(cy + radius * math.sin(math.radians(a0 + (a1 - a0) * k / steps)), 3), round(cz + radius * math.cos(math.radians(a0 + (a1 - a0) * k / steps)), 3)]
                for k in range(steps + 1)]
    pts = [[x, y0 + radius, z0]]
    pts += arc(z0 + radius, y1 - radius, 180, 90)           # левый верхний угол
    pts += arc(z1 - radius, y1 - radius, 90, 0)             # правый верхний
    pts += arc(z1 - radius, y0 + radius, 0, -90)            # правый нижний
    pts += arc(z0 + radius, y0 + radius, -90, -180)         # левый нижний; конец контура = начало
    if lap:
        pts += [[x, y0 + radius, z0 + lap_offset], [x, y0 + radius + lap, z0 + lap_offset]]
    return pts


# ───────────────────────── РМ1, РМ2 — монолитные ригели (КЖ2-2, doc20) ─────────────────────────

# размеры — с листа: ширина сечения 400, ряды стержней Ø20 по высоте (50, 50, …), хомуты Хр через 100 мм, выпуск хомута 280 над верхом ригеля
RM_SPECS = {
    "РМ1": dict(page=31, sheet="21", length=450, height=450, rows=[(80, 50), (320, 50), (50, 100), (350, 100), (50, 250), (350, 250), (50, 380), (350, 380)],
                bar_len=430, xs=[50, 125, 225, 325, 400], volume=0.08, o20_kg=8.48, hr_kg=2.13, hr_total=5, steel_kg=28.62),
    "РМ2": dict(page=32, sheet="22", length=1210, height=650, rows=[(80, 50), (320, 50), (50, 100), (350, 100), (50, 300), (350, 300), (50, 580), (350, 580)],
                bar_len=1190, xs=[55 + 100 * k for k in range(12)], volume=0.31, o20_kg=23.44, hr_kg=2.49, hr_total=12, steel_kg=81.71),
}
RM_WIDTH, RM_STIRRUP_Z, RM_STIRRUP_BOTTOM, RM_STIRRUP_STICKOUT, RM_STIRRUP_LAP = 400.0, (109.0, 291.0), 25.0, 280.0, 720.0


def build_rm(entry):
    alias = entry["alias"]
    s = RM_SPECS[alias]
    L, H, W = s["length"], s["height"], RM_WIDTH
    part = slab.extrusion_part(f"Бетон {alias}: брус {L} × {int(W)} × {H}", box(0, 0, W, H), [0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], L, [s["page"]])
    bars = [{"id": f"main-1:{k + 1}", "diameter": 20, "points": [[10, y, z], [10 + s["bar_len"], y, z]], "position": "5", "instance": str(k + 1)}
            for k, (z, y) in enumerate(s["rows"])]
    top = H + RM_STIRRUP_STICKOUT
    loops = [{"id": f"stirrups:{k + 1}", "diameter": 12, "points": rounded_loop(x, RM_STIRRUP_Z[0] + 6, RM_STIRRUP_Z[1] - 6, RM_STIRRUP_BOTTOM + 6, top - 6, 35.0, lap=min(RM_STIRRUP_LAP, top - 12 - RM_STIRRUP_BOTTOM - 70)),
              "position": "3", "instance": str(k + 1), "note": "контур — по разрезу 1-1; нахлёст замка (до 720 мм) подобран по массе поз. 3"} for k, x in enumerate(s["xs"])]
    groups = [
        {"id": "main-1", "name": f"Стержни Ø20 А500С L={s['bar_len']} (поз. 5, ×8)", "shortLabel": "Рабочие Ø20", "designation": "поз. 5", "sheet": s["sheet"], "quantity": 8, "unit": "шт",
         "kind": "bars", "material": "А500С", "sourcePages": [s["page"]], "paths": bars},
        {"id": "stirrups", "name": f"Хомут Хр{alias[2:]} (поз. 3, ×{s['hr_total']})", "shortLabel": f"Хомуты Хр{alias[2:]}", "designation": f"Хр{alias[2:]}", "sheet": s["sheet"],
         "quantity": s["hr_total"], "unit": "шт", "kind": "stirrup", "material": "А500С", "sourcePages": [s["page"]], "paths": loops},
    ]
    checks = [
        slab._mass_check(f"Стержни Ø20 ×8, L={s['bar_len']}", groups_kg(groups[:1]), s["o20_kg"], f"лист {s['sheet']}, поз. 5 и ведомость стали (Ø20)", 0.01),
        slab._mass_check(f"Хомуты Хр ×{s['hr_total']} (Ø12)", groups_kg(groups[1:]), s["hr_total"] * s["hr_kg"],
                         f"лист {s['sheet']}, поз. 3 ({s['hr_kg']} кг); нахлёст замка (до 720 мм) подобран по этой массе", 0.05),
    ]
    mass_in_model = groups_kg(groups)
    assumptions = [
        {"id": "orientation", "text": "Ригель лежит вдоль x (длина), y — вверх, z — поперёк (ширина 400, слева направо как на разрезе 1-1). Вид «Схема армирования» на листе — "
                                      "вид сбоку: по горизонтали длина ригеля, по вертикали высота и выпуски хомутов 280 мм над верхом.", "affects": ["concrete", "groups"]},
        {"id": "bars-positions", "text": "Положение стержней Ø20 — по размерам разреза 1-1: ряды по высоте (50, 100, …) и отступы 80/50 мм от боковых граней; длина L=%d (по 10 мм до торцов, размер «10» на схеме)." % s["bar_len"],
         "affects": ["main-1"]},
        {"id": "stirrup-shape", "text": "Хомут Хр: замкнутый прямоугольник 182 мм по ширине (109/182/109 до граней) от нижнего защитного слоя 25 мм до выпуска 280 мм над верхом; "
                                           "диаметр Ø12 принят по ведомости стали (на листе не подписан), радиус гибов 35 мм условный. Нахлёст замка (до 720 мм = 60d, у РМ1 ограничен прямым участком) на листе не размечен: подобран так, чтобы длина "
                                           "стержня сошлась с массой поз. 3 по спецификации (контур даёт ≈ 1,7 м при ≈ 2,4 м в спецификации).", "affects": ["stirrups"]},
    ]
    pending = [
        {"id": "nets-sn-sv", "kind": "missing_source", "sourcePages": [s["page"]],
         "description": f"Сетки СН{alias[2:]} и СВ{alias[2:]} (поз. 1, 2) и шпильки Ш1 (поз. 4) в модель не включены: их чертежи — листы 8–9 комплекта 77/113/114-Р-КМ.И1, "
                        "в комплекте проекта этих листов нет; на этом листе они показаны только контурами в разрезе 1-1. Масса арматуры в модели — %.1f кг из %.2f кг по ведомости." % (mass_in_model, s["steel_kg"])},
        {"id": "node-reinforcement", "kind": "placement_question", "sourcePages": [s["page"]],
         "description": "Нижнее узловое армирование (показано на листе условно) и узлы примыкания к колоннам в модель не включены."},
    ]
    return {
        "key": entry["id"], "alias": alias, "sourceId": "doc20", "type": "монолитный ригель", "modelType": "beam", "parts": [part],
        "volumeSpec": (s["volume"], f"лист {s['sheet']}, спецификация: бетон В40, {s['volume']:.2f} м³", False, 0.02),
        "groups": groups, "metalParts": [], "massChecks": checks,
        "readinessDescription": f"Бетонное тело ригеля и стержни Ø20 с хомутами Хр по чертежу листа {s['sheet']}; сетки СН/СВ и шпильки (листы КМ.И1) не включены — это не допуск в производство.",
        "evidence": [{"pdfPage": s["page"], "sheet": s["sheet"], "subject": f"{alias}: схема армирования, разрез 1-1, спецификация и ведомость стали",
                      "checks": [f"габариты {L} × {int(W)} × {H}", "ряды стержней Ø20 по высоте и отступы по ширине", "шаг хомутов Хр и выпуск 280", "объём бетона по спецификации"]}],
        "assumptions": assumptions, "issues": [], "pending": pending,
    }


# ───────────────────────── сборка и запись ─────────────────────────

README_LIMIT = ("Индивидуальная 3D-модель по векторному листу КЖИ: бетонное тело и арматура, которую лист позволяет восстановить. Остальное записано в «pending»; "
                "модель не меняет проектный объём, массу и калькуляцию.")


def assemble(m, captured_at):
    parts = m["parts"]
    spec = m.get("volumeSpec")
    checks = ([slab._volume_check(parts, spec[0], spec[1], approximate=spec[2], tolerance=spec[3])] if spec else []) + slab._structure_checks(parts) + m.get("massChecks", [])
    solid = {
        "id": m["key"], "sourceId": m["sourceId"], "alias": m["alias"], "supplyId": SUPPLY_ID,
        "format": "project-solids-mm-v1", "status": "partial", "modelType": m["modelType"], "elementType": m["type"],
        "concreteParts": parts, "metalParts": m.get("metalParts", []), "groups": m.get("groups", []), "bounds": slab._bounds_of(parts),
        "coordinateSystem": "мм; x — вдоль изделия (длина), y — вверх, z — поперёк (ширина)",
        "coordinateOrigin": "x = 0 — торец, y = 0 — низ, z = 0 — левая грань на разрезе листа",
        "evidence": m["evidence"], "pending": m.get("pending", []), "assumptions": m["assumptions"], "issues": m.get("issues", []),
        "notes": [README_LIMIT, "Объём модели сверен с объёмом спецификации листа, масса арматуры — с ведомостью (см. протокол проверки)."],
        "readinessDescription": m["readinessDescription"], "supersedesSketch": True,
    }
    qa = {"alias": m["alias"], "status": "partial", "checks": checks,
          "counts": {"concreteParts": len(parts), "metalParts": len(solid["metalParts"]), "groups": len(solid["groups"]), "checks": len(checks),
                     "warnings": sum(c["result"] == "warn" for c in checks), "failures": sum(c["result"] == "fail" for c in checks)}}
    return solid, qa


def catalog_entries():
    return json.loads((CATALOG_DIR / "promka-register.json").read_text())


def build_all(captured_at):
    """Все модели поставки: список пар (solid, qa) в формате promka-solid-models.json / qa поставки."""
    by_alias = {e["alias"]: e for e in catalog_entries().values()}
    pairs = [assemble(build_rm(by_alias[a]), captured_at) for a in ("РМ1", "РМ2")]
    import calc_models_kn45                              # колонны Кн4.5, Кн4.6: копия модели Кн4 + закладные ЗД листов 313/314/316
    for solid, qa in calc_models_kn45.build(by_alias):
        solid["supplyId"] = SUPPLY_ID
        solid.setdefault("supersedesSketch", True)
        pairs.append((solid, qa))
    import calc_models_r3                                # ригель 3Р14.5м: корыта на торцах, канаты К7, хомуты, сетки, каркасы, ЗД1/ЗД2
    pairs.append(assemble(calc_models_r3.build(by_alias["3Р14.5м"]), captured_at))
    return pairs


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="дописать модели в promka-solid-models.json и promka-solid-supplies.json")
    ap.add_argument("--assets", help="каталог с promka-*.json вместо data/calc/assets (для временного стенда); копии при этом не снимаются")
    args = ap.parse_args()
    assets = Path(args.assets) if args.assets else ASSETS
    captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    solids, qas = zip(*build_all(captured_at))
    print("Проверка моделей:")
    for solid, qa in zip(solids, qas):
        print("  %-8s бетон: частей %d, групп арматуры %d, металлических деталей %d, границы %s" % (solid["alias"], len(solid["concreteParts"]), len(solid["groups"]), len(solid["metalParts"]), solid["bounds"]))
        for c in qa["checks"]:
            print("     [%s] %s" % (c["result"], c["detail"][:230]))
    if sum(q["counts"]["failures"] for q in qas):
        raise SystemExit("есть ошибки проверки — запись отменена")
    if not args.write:
        print("\nЗапись не выполнялась (нет --write).")
        return
    solid_path, supply_path = assets / "promka-solid-models.json", assets / "promka-solid-supplies.json"
    solid_all, supplies = json.loads(solid_path.read_text()), json.loads(supply_path.read_text())
    if not args.assets:
        BACKUPS.mkdir(exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        for path in (solid_path, supply_path):
            shutil.copy2(path, BACKUPS / f"{path.stem}.before-missing3d-{stamp}.json")
    for key in [k for k, v in solid_all.items() if v.get("supplyId") == SUPPLY_ID]:
        del solid_all[key]
    for solid in solids:
        solid_all[solid["id"]] = solid
    blob = {s["id"]: s for s in solids}
    sha = hashlib.sha256(dump(blob).encode()).hexdigest()
    supplies[SUPPLY_ID] = {
        "label": "Claude · изделия без 3D (РМ, Кн, 3Р)", "snapshot": SNAPSHOT, "modelsSha256": sha, "modelCount": len(solids), "capturedAt": captured_at,
        "qa": {"modelsSha256": sha, "tool": "scripts/build_calc_missing_models.py",
               "covers": ["объём бетонного тела против объёма спецификации листа", "масса каждого вида арматуры против ведомости стали", "корректность сечений"],
               "doesNotCover": ["арматурные сетки и каркасы, чертежи которых вне комплекта", "допуск в производство"],
               "models": {s["id"]: q for s, q in zip(solids, qas)}},
        "report": "Модели изделий без 3D: " + ", ".join(s["alias"] for s in solids) + ". Подробности — Docs/calc-missing-models.md.",
    }
    # сначала поставка, потом модели: каталог читает их на живом сервере, и модель без своей поставки уронила бы запрос
    for path, payload in ((supply_path, supplies), (solid_path, solid_all)):
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(dump(payload))
        os.replace(tmp, path)
    print("\nЗаписано: %d моделей, снимок %s, sha256 %s…; копии — %s" % (len(solids), SNAPSHOT, sha[:12], BACKUPS))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Калькулятор: 3D-модели изделий, у которых «модели не построено» (2026-10-20): колонны Кн4.5, Кн4.6 (scripts/calc_models_kn45.py) и ригель 3Р14.5м (scripts/calc_models_r3.py).
Ригели РМ1, РМ2 тоже были построены, но по ответу проектировщиков от 2026-10-20 монолитные РМ исключены из калькуляции — модели сняты (история — коммит 409f8a7).

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
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab  # noqa: E402  — читалка векторных листов и общие проверки моделей

ROOT = slab.ROOT
CATALOG_DIR = slab.CATALOG_DIR
ASSETS = slab.ASSETS
BACKUPS = slab.BACKUPS
SUPPLY_ID = "claude-missing-3d"
SNAPSHOT = "20261020-missing-3d"


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
    pairs = []
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
        "label": "Claude · изделия без 3D (Кн4.5, Кн4.6, 3Р14.5м)", "snapshot": SNAPSHOT, "modelsSha256": sha, "modelCount": len(solids), "capturedAt": captured_at,
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

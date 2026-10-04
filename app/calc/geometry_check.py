"""Собственная проверка пересечений труб со стержнями арматуры (2026-10-04).

Отчёт проверки модели от поставщика (solidModel.qa) пересечений трубы со стержнями не содержит, поэтому калькулятор считает их сам
по тем же координатам модели (мм):

* труба — деталь `metalParts` из группы `pipe`/`tube` (или с названием «Труба …»): выдавливание круглого профиля с отверстием, ось
  вдоль направления выдавливания; стенка — кольцо между радиусом отверстия Ri и наружным радиусом Ro, по оси от 0 до depth;
* стержень — каждая ломаная `groups[].paths[]` (кроме самих труб), радиус = диаметр/2 (для прядей К7 берётся огибающая);
* стержень пересекает трубу там, где его круглое сечение в одной плоскости с осью трубы перекрывает кольцо стенки:
  (ρ + r > Ri) и (ρ − r < Ro) при 0 ≤ z ≤ depth, ρ — расстояние оси стержня до оси трубы. Стержень, целиком проходящий внутри
  отверстия трубы или целиком снаружи, не пересекает её.

Ломаная стержня семплируется с шагом 1 мм. Для каждой пары «труба × стержень» сохраняется место наибольшего перекрытия (`at`),
проникновение (мм, толщина перекрытия стенки стержнем) и длина участка. Пересечения короче допуска (проникновение < 0,5 мм)
отбрасываются: это касание. Проверка не заменяет проверку поставщика модели и не удостоверяет допустимость пересечений.
"""
import math

import numpy as np

STEP_MM = 1.0
TOLERANCE_MM = 0.5
TUBE_GROUPS = {"pipe", "tube"}
ORIGIN_LABEL = "Проверка калькулятора"


def is_tube(part):
    return part.get("type") == "extrusion" and (part.get("group") in TUBE_GROUPS or str(part.get("name", "")).startswith("Труба"))


def tube_spec(part):
    profile = part.get("profile")
    if not isinstance(profile, list) or len(profile) < 3:
        return None
    pts = np.array(profile, dtype=float)
    center = pts.mean(axis=0)
    radii = np.hypot(pts[:, 0] - center[0], pts[:, 1] - center[1])
    outer = float(radii.max())
    if outer <= 0 or radii.min() < outer * 0.9:  # профиль не круглый: труба прямоугольного сечения здесь не поддержана
        return None
    inner = 0.0
    for hole in part.get("holes") or []:
        if hole.get("type") == "circle" and math.hypot(hole["center"][0] - center[0], hole["center"][1] - center[1]) < 1.0:
            inner = float(hole["radius"])
            break
    basis = np.array([part["u"], part["v"], part["direction"]], dtype=float)
    return {"name": part.get("name") or "Труба", "origin": np.array(part["origin"], dtype=float), "basis": basis,
            "center": center, "outer": outer, "inner": inner, "depth": float(part["depth"])}


def bar_paths(solid):
    """[(group_id, label, radius, np.array(points)), …] — стержни, кроме самих труб."""
    result = []
    for group in solid.get("groups") or []:
        gid = str(group.get("id", ""))
        if gid.lower().startswith(("tube", "pipe")):
            continue
        for index, path in enumerate(group.get("paths") or []):
            points = path.get("points") or []
            if len(points) < 2 or not path.get("diameter"):
                continue
            label = path.get("instance") or path.get("position") or ("№%d" % (index + 1))
            result.append((gid, str(label), float(path["diameter"]) / 2.0, np.array(points, dtype=float)))
    return result


def _check_tube_against(spec, bars):
    """{(group_id, label): {...}} — наибольшее перекрытие по каждому стержню."""
    found = {}
    ro, ri, depth, c = spec["outer"], spec["inner"], spec["depth"], spec["center"]
    for gid, label, r, points in bars:
        local = (points - spec["origin"]) @ spec["basis"].T          # x, y, z в системе трубы
        best = None
        total = 0.0
        for a, b in zip(local[:-1], local[1:]):
            if max(a[2], b[2]) < -r or min(a[2], b[2]) > depth + r:
                continue
            delta = b - a
            length = float(np.linalg.norm(delta))
            if length < 1e-9:
                continue
            xy_a, xy_d = a[:2] - c, delta[:2]
            # быстрый отсев по расстоянию оси стержня до оси трубы (минимум и максимум на отрезке)
            tt = np.clip(-np.dot(xy_a, xy_d) / max(np.dot(xy_d, xy_d), 1e-12), 0, 1)
            rho_min = np.linalg.norm(xy_a + tt * xy_d)
            rho_max = max(np.linalg.norm(xy_a), np.linalg.norm(xy_a + xy_d))
            if rho_min - r >= ro or rho_max + r <= ri:
                continue
            n = max(2, int(math.ceil(length / STEP_MM)) + 1)
            t = np.linspace(0.0, 1.0, n)
            samples = a + np.outer(t, delta)
            rho = np.hypot(samples[:, 0] - c[0], samples[:, 1] - c[1])
            inside = (samples[:, 2] >= 0) & (samples[:, 2] <= depth) & (rho + r > ri) & (rho - r < ro)
            if not inside.any():
                continue
            overlap = np.minimum(rho + r, ro) - np.maximum(rho - r, ri)
            overlap = np.where(inside, overlap, -1.0)
            k = int(overlap.argmax())
            total += float(inside.sum()) * length / (n - 1)
            if best is None or overlap[k] > best[0]:
                best = (float(overlap[k]), samples[k])
        if best and best[0] >= TOLERANCE_MM:
            at = spec["origin"] + best[1] @ spec["basis"]
            found[(gid, label)] = {"penetrationMm": round(best[0], 2), "lengthMm": round(total, 1), "at": [round(float(v), 1) for v in at]}
    return found


def _short(name):
    return name.split(" ГОСТ")[0].strip()


def tube_classes(model_id, solid):
    """Классы пересечений «труба × группа стержней» в формате collisions.extract (origin='check')."""
    tubes = [s for s in (tube_spec(p) for p in (solid.get("metalParts") or []) if is_tube(p)) if s]
    if not tubes:
        return [], {"tubes": 0, "bars": 0}
    bars = bar_paths(solid)
    grouped = {}
    for spec in tubes:
        for (gid, label), hit in _check_tube_against(spec, bars).items():
            grouped.setdefault((_short(spec["name"]), gid), []).append({"a": spec["name"], "b": "%s: %s" % (gid, label), **hit})
    classes = []
    for (tube_name, gid), items in sorted(grouped.items()):
        items.sort(key=lambda i: -i["penetrationMm"])
        classes.append({"parts": "%s × %s" % (tube_name, gid), "pairCount": len(items), "uniqueBarPairs": len(items),
                        "maxPenetrationMm": items[0]["penetrationMm"], "sourcePdfPages": [], "declaredAsSourceConflict": False,
                        "origin": "check", "originLabel": ORIGIN_LABEL, "items": items})
    return classes, {"tubes": len(tubes), "bars": len(bars)}


def main(argv=None):
    """CLI: проверка всех восстановленных моделей. Читает только каталог исходников (assets), базу данных не открывает.
    python -m app.calc.geometry_check [--json файл] [--products /путь/calczhbi.sqlite3]"""
    import argparse
    import json
    import sqlite3
    import time

    from .document_models import catalog, model

    parser = argparse.ArgumentParser()
    parser.add_argument("--json")
    parser.add_argument("--products", help="база калькулятора (только чтение): сопоставить модели с изделиями")
    args = parser.parse_args(argv)
    names = {}
    if args.products:
        conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % args.products, uri=True)
        for pid, name, mid in conn.execute("SELECT id,name,document_model_id FROM products"):
            names.setdefault(mid, []).append(name)
        conn.close()
    report = []
    started = time.time()
    for model_id in catalog():
        solid = (model(model_id) or {}).get("solidModel")
        if not solid:
            continue
        classes, scope = tube_classes(model_id, solid)
        pairs = sum(c["pairCount"] for c in classes)
        report.append({"modelId": model_id, "products": names.get(model_id, []), "tubes": scope["tubes"], "bars": scope["bars"],
                       "collidingBars": pairs, "maxPenetrationMm": max([c["maxPenetrationMm"] for c in classes] or [0]),
                       "classes": [{"parts": c["parts"], "pairs": c["pairCount"], "maxPenetrationMm": c["maxPenetrationMm"]} for c in classes]})
    print("Моделей с 3D-составом: %d; с трубами: %d; с пересечениями труб и арматуры: %d; время %.1f с" % (
        len(report), sum(1 for r in report if r["tubes"]), sum(1 for r in report if r["collidingBars"]), time.time() - started))
    for r in sorted(report, key=lambda r: -r["collidingBars"])[:40]:
        print("%-28s труб %d стержней %5d пересечений %4d макс %6.2f мм  %s" % (r["modelId"], r["tubes"], r["bars"], r["collidingBars"], r["maxPenetrationMm"], ", ".join(r["products"][:2])))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=1)
    return report


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Калькулятор: индивидуальные 3D-модели бетонного тела пяти плит перекрытия «максимально разных» типов.

Откуда берётся геометрия: векторные листы альбомов КЖИ (PDF из data/calc/assets/sources). Контуры читаются кодом
из штрихов листа (размеры в мм получаются по масштабу размера, указанного на самом листе), а не вводятся руками там,
где лист допускает чтение. Что не читается кодом (глубина узлов, положение отверстий на листе без размерной цепочки),
берётся из размерных цепочек листа и помечено в `assumptions`.

Пять изделий (каждое — отдельное конструктивное исполнение):

  4Пд-1   (doc10, лист 3 + сечения листа 1)  узкая многопустотная доборная полоса 720 мм, продольный пропил по пустоте
  4ПИ-18  (doc10, лист 12)                   многопустотная 1200 мм со срезом торцевого угла 520 × 430 (косая плоскость)
  Пл4.1   (doc11, лист 1)                    многопустотная 220 мм с угловыми вырезами 400 × 500 на торцах
  ПГП1    (doc12, лист 87, узлы лист 84)     сплошная плита покрытия подъёмника 300 мм, 8 вырезов под закладные
  ПШЛ1    (doc13, лист 91)                   сплошная плита шахты лифта 200 мм, 8 вырезов по контуру и 9 сквозных отверстий

Модель — «частичная»: армирование и закладные детали не восстановлены (на листах проекта многопустотных плит арматуры нет:
число проволок Вр1400 задаёт заводской альбом УДС-1ПБ3.02.2020, а нагрузка марок проекта вне его таблиц; для плит Пл альбомов
192/16 в комплекте нет). Проверка по объёму из спецификации печатается и записывается в `qa` каждой модели.

Запуск (читает PDF и каталог, пишет в data/calc/assets; перед записью — копия в data/calc/backups):

    .venv/bin/python scripts/build_calc_slab_models.py            # собрать и показать проверку, ничего не писать
    .venv/bin/python scripts/build_calc_slab_models.py --write    # и дописать в promka-solid-models/-supplies
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import fitz
from shapely import affinity
from shapely.geometry import Point, Polygon, box
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parent.parent
CATALOG_DIR = ROOT / "data" / "calc" / "assets"                # каталог изделий и эскизов читается всегда отсюда
SOURCES = CATALOG_DIR / "sources"                               # PDF-альбомы тоже
ASSETS = ROOT / "data" / "calc" / "assets"                     # куда пишутся модели (--assets меняет)
BACKUPS = ROOT / "data" / "calc" / "backups"
SUPPLY_ID = "claude-slabs"
SNAPSHOT = "20261020-slabs-all"


# ───────────────────────── чтение векторного листа ─────────────────────────

class Chain(list):
    """Цепочка точек штриха; width — толщина линии листа (pt)."""
    width = 0.0


def _chain(points, width):
    c = Chain(points)
    c.width = width
    return c


def _bezier(p0, p1, p2, p3, steps=12):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append(fitz.Point(u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
                              u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y))
    return out


def sheet_chains(doc_id, page, region, min_width=0.0, max_width=99.0):
    """Штрихи листа внутри области region (pt, координаты видимой страницы) как цепочки точек.
    Лист повёрнут: координаты рисунков переводятся матрицей поворота страницы."""
    pdf = fitz.open(SOURCES / f"{doc_id}.pdf")
    pg = pdf[page - 1]
    m = pg.rotation_matrix
    region = fitz.Rect(region)
    chains = []
    for d in pg.get_drawings():
        width = d.get("width") or 0
        if width < min_width or width > max_width:
            continue
        rect = fitz.Rect(d["rect"]).transform(m)
        if not (rect.x0 >= region.x0 - 0.3 and rect.x1 <= region.x1 + 0.3 and rect.y0 >= region.y0 - 0.3 and rect.y1 <= region.y1 + 0.3):
            continue
        for it in d["items"]:
            if it[0] == "l":
                a, b = it[1] * m, it[2] * m
                if math.hypot(a.x - b.x, a.y - b.y) >= 0.3:    # нулевые штрихи (засечки) — шум
                    chains.append(_chain([a, b], width))
            elif it[0] == "c":
                p = [it[1] * m, it[2] * m, it[3] * m, it[4] * m]
                chains.append(_chain([p[0]] + _bezier(*p), width))
            elif it[0] in ("re", "qu"):
                r = it[1]
                if it[0] == "re":
                    q = [fitz.Point(r.x0, r.y0), fitz.Point(r.x1, r.y0), fitz.Point(r.x1, r.y1), fitz.Point(r.x0, r.y1), fitz.Point(r.x0, r.y0)]
                else:
                    q = [r.ul, r.ur, r.lr, r.ll, r.ul]
                chains.append(_chain([x * m for x in q], width))
    return chains


def connected_groups(chains, tol=0.4):
    """Цепочки, сходящиеся концами, — в одну группу (контур)."""
    parent = list(range(len(chains)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    grid = defaultdict(list)
    for i, c in enumerate(chains):
        for p in (c[0], c[-1]):
            grid[(round(p.x / tol), round(p.y / tol))].append((i, p))
    for (kx, ky), v in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i, p in v:
                    for j, q in grid.get((kx + dx, ky + dy), []):
                        if i < j and abs(p.x - q.x) < tol and abs(p.y - q.y) < tol:
                            parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(len(chains)):
        groups[find(i)].append(chains[i])
    return list(groups.values())


def group_ring(group, tol=0.4):
    """Упорядоченный контур из цепочек группы. Замкнутый обходится от любой цепочки; открытый (дуга пустоты у линии
    пропила, контур с обрывом на разрыве) — от свободного конца; многоугольник потом замыкается хордой."""
    degree = defaultdict(int)
    key = lambda p: (round(p.x / tol), round(p.y / tol))
    for c in group:
        for p in (c[0], c[-1]):
            degree[key(p)] += 1
    rest = [list(c) for c in group]
    start = 0
    for k, c in enumerate(rest):
        if degree[key(c[0])] == 1 or degree[key(c[-1])] == 1:
            start = k
            if degree[key(c[-1])] == 1 and degree[key(c[0])] != 1:
                c.reverse()
            break
    ring = rest.pop(start)
    while rest:
        end = ring[-1]
        dist, k, reverse = min(((math.hypot((c[-1] if rv else c[0]).x - end.x, (c[-1] if rv else c[0]).y - end.y), k, rv)
                                for k, c in enumerate(rest) for rv in (False, True)))
        if dist > tol * 3:
            raise ValueError("контур не замыкается: разрыв %.2f pt" % dist)
        c = rest.pop(k)
        ring.extend((c[::-1] if reverse else c)[1:])
    return ring


def ring_to_mm(ring, x0, y_bottom, scale):
    """pt листа → мм сечения: z — слева направо, y — снизу вверх."""
    return [((p.x - x0) * scale, (y_bottom - p.y) * scale) for p in ring]


def read_section(doc_id, page, region, width_mm, min_width=0.0, max_width=99.0, height_mm=None):
    """Сечение плиты с листа: внешний контур и пустоты в мм (z поперёк плиты слева направо, y вверх от низа).
    Масштаб берётся из ширины внешнего контура = width_mm (размер этого сечения на листе). Если задана height_mm (подпись высоты
    или размер по названию альбома), высота нормируется к ней — расхождение масштаба по двум осям не больше 1 мм."""
    groups = connected_groups(sheet_chains(doc_id, page, region, min_width, max_width))
    rings = []
    for g in groups:
        pts = [p for c in g for p in c]
        bx = (min(p.x for p in pts), min(p.y for p in pts), max(p.x for p in pts), max(p.y for p in pts))
        rings.append((bx, g))
    rings.sort(key=lambda r: -(r[0][2] - r[0][0]))
    outline_box, outline_group = rings[0]
    scale = width_mm / (outline_box[2] - outline_box[0])
    height = (outline_box[3] - outline_box[1]) * scale
    stretch = 1.0
    if height_mm is not None:
        if abs(height - height_mm) > 1.0:
            raise ValueError("высота сечения по масштабу %.1f мм, ожидалось %s" % (height, height_mm))
        stretch = height_mm / height
    to_mm = lambda ring: [(z, y * stretch) for z, y in ring_to_mm(ring, outline_box[0], outline_box[3], scale)]
    # упрощение 0,1 мм снимает дребезг стыков штрихов листа (десятые доли мм), не трогая ни габариты, ни дуги пустот
    outline = Polygon(to_mm(group_ring(outline_group))).simplify(0.1)
    voids = []
    for bx, g in rings[1:]:
        # половина пустоты у линии пропила — открытая дуга; замыкаем её хордой, как на листе
        voids.append(Polygon(to_mm(group_ring(g))).simplify(0.1))
    return outline, voids, scale, height


def section_polygon(outline, voids):
    poly = outline
    for v in voids:
        poly = poly.difference(v.buffer(0))
    return poly


# ───────────────────────── триангуляция и меши ─────────────────────────

def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _segments_cross(a, b, c, d):
    """Отрезки ab и cd пересекаются во внутренних точках."""
    def side(p, q, r):
        return _cross(p, q, r)
    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    return ((d1 > 1e-9 and d2 < -1e-9) or (d1 < -1e-9 and d2 > 1e-9)) and ((d3 > 1e-9 and d4 < -1e-9) or (d3 < -1e-9 and d4 > 1e-9))


def triangulate(exterior, holes):
    """Триангуляция многоугольника с дырами (ушная отсечка с мостами). Вход: внешнее кольцо (против часовой)
    и дыры (по часовой) без повторной замыкающей точки. Выход: список троек индексов в склеенном массиве
    вершин и сам массив (мостовые вершины дублируются)."""
    ring = [tuple(p) for p in exterior]
    all_rings = [ring] + [[tuple(p) for p in h] for h in holes]

    def edges_of(rings):
        for r in rings:
            for i in range(len(r)):
                yield r[i], r[(i + 1) % len(r)]

    # мосты: от самой правой вершины дыры к ближайшей видимой вершине текущего кольца
    pending = sorted(range(len(holes)), key=lambda k: -max(p[0] for p in holes[k]))
    for k in pending:
        hole = [tuple(p) for p in holes[k]]
        others = [r for i, r in enumerate(all_rings[1:]) if i != k]
        cand = sorted(((math.dist(hv, ov), hi, oi) for hi, hv in enumerate(hole) for oi, ov in enumerate(ring)))
        for _, hi, oi in cand:
            hv, ov = hole[hi], ring[oi]
            if any(_segments_cross(hv, ov, a, b) for a, b in edges_of([ring] + others + [hole])):
                continue
            mid = ((hv[0] + ov[0]) / 2, (hv[1] + ov[1]) / 2)
            if not Polygon(ring).buffer(1e-7).contains(Point(mid)) or Polygon(hole).contains(Point(mid)):
                continue
            ring = ring[:oi + 1] + hole[hi:] + hole[:hi + 1] + ring[oi:]
            break
        else:
            raise ValueError("не нашлось моста для дыры")
    pts = ring
    n = len(pts)
    idx = list(range(n))
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10 * n * n:
        guard += 1
        clipped = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if _cross(a, b, c) <= 1e-9:
                continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = pts[j]
                if p == a or p == b or p == c:
                    continue
                if _cross(a, b, p) >= -1e-9 and _cross(b, c, p) >= -1e-9 and _cross(c, a, p) >= -1e-9:
                    ok = False
                    break
            if ok:
                tris.append((i0, i1, i2))
                idx.pop(k)
                clipped = True
                break
        if not clipped:
            # вырожденное остаётся: убираем нулевую по площади вершину, иначе — ошибка
            for k in range(len(idx)):
                a, b, c = pts[idx[k - 1]], pts[idx[k]], pts[idx[(k + 1) % len(idx)]]
                if abs(_cross(a, b, c)) <= 1e-9:
                    idx.pop(k)
                    clipped = True
                    break
            if not clipped:
                raise ValueError("триангуляция остановилась")
    if len(idx) == 3:
        tris.append((idx[0], idx[1], idx[2]))
    return tris, pts


def polygon_triangles(poly):
    """Треугольники (в плоскости чертежа) многоугольника shapely с дырами."""
    poly = orient(poly, 1.0)
    tris, pts = triangulate(list(poly.exterior.coords)[:-1], [list(r.coords)[:-1] for r in poly.interiors])
    return [(pts[a], pts[b], pts[c]) for a, b, c in tris]


def mesh_signed_volume(vertices, indices):
    v = 0.0
    for a, b, c in indices:
        pa, pb, pc = vertices[a], vertices[b], vertices[c]
        v += (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) / 6
    return v


def polygons_of(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon) and g.area > 1e-6]


# ───────────────────────── части модели ─────────────────────────

def round_pts(pts, nd=3):
    return [[round(x, nd), round(y, nd)] for x, y in pts]


def extrusion_part(name, poly, origin, u, v, direction, depth, pages):
    """Призма по сечению poly (с дырами) — формат solid-geometry.js: профиль в плоскости (u, v), выдавливание вдоль direction."""
    poly = orient(poly, 1.0)
    return {
        "type": "extrusion", "name": name, "profile": round_pts(list(poly.exterior.coords)[:-1]),
        "holes": [{"type": "polygon", "points": round_pts(list(r.coords)[:-1])} for r in poly.interiors],
        "origin": origin, "u": u, "v": v, "direction": direction, "depth": depth, "sourcePages": pages,
    }


def section_extrusions(name, section, x0, x1, pages):
    """Сечение (z поперёк, y вверх), выдавленное вдоль длины x0…x1. Распавшееся на куски — отдельными частями."""
    parts = []
    for k, poly in enumerate(polygons_of(section)):
        label = name if k == 0 else f"{name} (часть {k + 1})"
        parts.append(extrusion_part(label, poly, [x0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], x1 - x0, pages))
    return parts


def plan_extrusion(name, plan, thickness, pages):
    """Плита по плану (x вдоль длины, z поперёк) толщиной thickness вверх (ось y)."""
    return extrusion_part(name, plan, [0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], thickness, pages)


def oblique_end_mesh(name, section_piece, x_start, x_end_of_z, pages):
    """Призма сечения section_piece (z, y) от плоскости x=x_start до вертикальной косой плоскости x = x_end_of_z(z).
    Боковые грани — по рёбрам сечения, торцы — триангуляцией сечения; наружу смотрят нормали."""
    vertices, indices, index = [], [], {}

    def vid(x, y, z):
        key = (round(x, 4), round(y, 4), round(z, 4))
        if key not in index:
            index[key] = len(vertices)
            vertices.append([key[0], key[1], key[2]])
        return index[key]

    for poly in polygons_of(section_piece):
        poly = orient(poly, 1.0)
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)[:-1]
            for i in range(len(pts)):
                (zp, yp), (zq, yq) = pts[i], pts[(i + 1) % len(pts)]
                # стена между рёбрами сечения: тело слева от направления обхода — наружу смотрит правая сторона
                a, b = vid(x_start, yp, zp), vid(x_start, yq, zq)
                c, d = vid(x_end_of_z(zq), yq, zq), vid(x_end_of_z(zp), yp, zp)
                # на линии z, где косая плоскость сходится с передней (x_end = x_start), грань вырождается — не пишем
                indices += [t for t in ((a, c, b), (a, d, c)) if len(set(t)) == 3]
        for (p, q, r) in polygon_triangles(poly):
            # торцы обходятся навстречу рёбрам стен: передний (x_start) и задний (косая плоскость) — в противоположные стороны
            indices.append((vid(x_start, p[1], p[0]), vid(x_start, q[1], q[0]), vid(x_start, r[1], r[0])))
            indices.append((vid(x_end_of_z(p[0]), p[1], p[0]), vid(x_end_of_z(r[0]), r[1], r[0]), vid(x_end_of_z(q[0]), q[1], q[0])))
    volume = mesh_signed_volume(vertices, indices)
    if volume < 0:
        indices = [(a, c, b) for a, b, c in indices]
        volume = -volume
    return {"type": "mesh", "name": name, "vertices": vertices, "indices": [list(t) for t in indices], "sourcePages": pages}, volume


def extrusion_volume(part):
    poly = Polygon(part["profile"], [h["points"] for h in part["holes"]])
    return poly.area * part["depth"]


def mesh_volume(part):
    return abs(mesh_signed_volume(part["vertices"], part["indices"]))


def part_volume(part):
    return extrusion_volume(part) if part["type"] == "extrusion" else mesh_volume(part)


# ───────────────────────── исходные данные листов ─────────────────────────

MASS_DENSITY = 2500.0     # кг/м³: в проекте масса изделия = объём × 2500 (проверено по таблицам плит)

# лист 1 альбома КЖ.И3-1, сечение 1-1: полная ширина 1197 мм; высота на листе подписана «3000», по масштабу 300 (см. build_4pd1)
DOC10_SECTION_1_1 = dict(doc_id="doc10", page=7, region=(184, 48, 526, 140), width_mm=1197, height_mm=300)
# лист 1 КЖ.И3, сечение 3-3: сплошная часть 697 мм (+500 мм тонкой линией), высота 220 подписана
DOC11_SECTION_3_3 = dict(doc_id="doc11", page=6, region=(615, 438, 975, 515), width_mm=697, min_width=1.0, height_mm=220)

def mirrored_full_profile(outline, voids, full_width):
    """Профиль на всю ширину из сплошной части сечения: левая половина зеркалится относительно оси сечения
    (пустоты симметричны; на сечении 1-1 doc10 расхождение площади зеркальной сборки с полным листом 0,3%)."""
    solid = section_polygon(outline, voids)
    half = solid.intersection(box(-1, -1, full_width / 2, 1000))
    mirror = affinity.scale(half, -1, 1, origin=(full_width / 2, 0))
    return half.union(mirror).buffer(0)


def _bounds_of(parts):
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for part in parts:
        if part["type"] == "mesh":
            pts = part["vertices"]
        else:
            pts = [[part["origin"][i] + part["u"][i] * x + part["v"][i] * y + part["direction"][i] * d for i in range(3)]
                   for x, y in part["profile"] for d in (0, part["depth"])]
        for p in pts:
            for i in range(3):
                lo[i], hi[i] = min(lo[i], p[i]), max(hi[i], p[i])
    return [[round(v, 3) for v in lo], [round(v, 3) for v in hi]]


def _volume_check(parts, spec_m3, spec_source, tolerance=0.02, approximate=False):
    model = sum(part_volume(p) for p in parts) / 1e9
    deviation = (model - spec_m3) / spec_m3
    detail = "объём модели %.4f м³; по спецификации %.4f м³ (%s); расхождение %+.1f%%" % (model, spec_m3, spec_source, deviation * 100)
    return {"check": "volume-vs-spec", "result": "pass" if abs(deviation) <= tolerance else "warn", "detail": detail,
            "modelM3": round(model, 5), "specM3": spec_m3, "deviationPercent": round(deviation * 100, 2), "approximateSpec": approximate}


def _mass_check(what, model_kg, spec_kg, source, tolerance):
    deviation = (model_kg - spec_kg) / spec_kg
    return {"check": "mass-vs-spec", "result": "pass" if abs(deviation) <= tolerance else "warn",
            "detail": "%s: масса по модели %.1f кг, по спецификации %.1f кг (%s); расхождение %+.1f%%" % (what, model_kg, spec_kg, source, deviation * 100),
            "modelKg": round(model_kg, 2), "specKg": round(spec_kg, 2), "deviationPercent": round(deviation * 100, 2)}


def _structure_checks(parts):
    checks = []
    invalid = [p["name"] for p in parts if p["type"] == "extrusion" and not Polygon(p["profile"], [h["points"] for h in p["holes"]]).is_valid]
    checks.append({"check": "valid-section-polygons", "result": "fail" if invalid else "pass",
                   "detail": "сечения частей — корректные многоугольники" if not invalid else "некорректные: " + "; ".join(invalid)})
    for p in parts:
        if p["type"] == "mesh":
            edges = Counter()
            for a, b, c in p["indices"]:
                for u, w in ((a, b), (b, c), (c, a)):
                    edges[(u, w)] += 1
            open_edges = sum(1 for (u, w), n in edges.items() if n != 1 or (w, u) not in edges)
            checks.append({"check": "mesh-closed", "result": "pass" if open_edges == 0 else "fail",
                           "detail": "%s: замкнутая поверхность, %d треугольников" % (p["name"], len(p["indices"])) if open_edges == 0
                           else "%s: незамкнутых рёбер %d" % (p["name"], open_edges)})
    return checks


# ───────────────────────── пять моделей ─────────────────────────

def build_4pd1(full_1pb):
    """4Пд-1 = УДС-1ПБ33,5.7,2: 3350 мм, сечение 300 мм, ширина 720 пропилом по оси шестой пустоты."""
    section = full_1pb.intersection(box(-1, -1, 720, 400))
    parts = section_extrusions("Бетон 4Пд-1: многопустотная полоса 3350 × 720 × 300", section, 0, 3350, [9, 7])
    return {
        "key": "reg-doc10-bf98ff0aac9a", "alias": "4Пд-1", "sourceId": "doc10", "type": "многопустотная полоса, продольный пропил по пустоте",
        "parts": parts, "volumeSpec": (0.37, "лист 3, таблица, поз. 1; масса 925 кг", False),
        "evidence": [
            {"pdfPage": 9, "sheet": "3", "subject": "Плита 4Пд-1: длина 3350, ширина 720, спецификация (объём 0,37 м³, масса 925 кг)",
             "checks": ["марка и сечение 2-2", "габариты 3350 × 720", "объём и масса из таблицы"]},
            {"pdfPage": 7, "sheet": "1", "subject": "Сечения 1-1…8-8: профиль плиты с пустотами",
             "checks": ["масштаб сечения = подписанная ширина 1197 мм", "9 пустот, шаг 120 мм", "сечение 2-2 (720 мм) сверено с обрезкой полного профиля: расхождение площади 0,4%"]},
            {"source": "doc25", "pdfPage": 10, "sheet": "9", "subject": "Заводской альбом УДС-1ПБ3.02.2020, разрезы 1-1, 2-2: высота 300 мм, ширина 1197, шаг пустот 120, пустота 81 × 242",
             "checks": ["пустоты 81 × 242 мм и шаг 120 мм совпадают с профилем, снятым с листа проекта (81,5 × 241,6; 120)", "высота сечения 300 мм (пояснительная записка п. 1.1, 1.7)"]},
        ],
        "assumptions": [
            {"id": "section-height", "text": "Высота сечения подписана на листе «3000»; по масштабу сечения и по заводскому альбому УДС-1ПБ3.02.2020 (высота сечения 300 мм, п. 1.1) принято 300 мм. Подтверждено объёмом: площадь сечения × длина даёт 0,369 м³ при спецификации 0,37 м³.",
             "affects": ["concrete"]},
            {"id": "sawn-edge", "text": "Ширина 720 мм получена продольным пропилом по оси шестой пустоты (центр пустоты 718 мм): правая кромка без шпоночного паза, пустота вскрыта сверху вниз. Так показано на сечении 2-2.",
             "affects": ["concrete"]},
        ],
    }


def build_4pi18(full_1pb):
    """4ПИ-18 = УДС-1ПБ83.12: 8300 мм, ширина 1197 (в плане 1200), срез торцевого угла 520 × 430 косой вертикальной плоскостью."""
    width = 1197.0
    cut_z = width - 430.0
    end_x = lambda z: 8300.0 - (z - cut_z) * 520.0 / 430.0
    body = section_extrusions("Бетон 4ПИ-18: основная часть x 0…7780", full_1pb, 0, 7780, [18, 7])
    rest = section_extrusions("Бетон 4ПИ-18: торцевой участок x 7780…8300, до среза", full_1pb.intersection(box(-1, -1, cut_z, 400)), 7780, 8300, [18])
    wedge_section = full_1pb.intersection(box(cut_z, -1, width + 1, 400))
    wedge, _ = oblique_end_mesh("Бетон 4ПИ-18: срезанный угол, косой торец 520 × 430", wedge_section, 7780, end_x, [18])
    parts = body + rest + [wedge]
    return {
        "key": "reg-doc10-45c1079bd7ea", "alias": "4ПИ-18", "sourceId": "doc10", "type": "многопустотная плита со срезом торцевого угла",
        "parts": parts, "volumeSpec": (1.51, "лист 12, таблица, поз. 1; масса 3775 кг", False),
        "evidence": [
            {"pdfPage": 18, "sheet": "12", "subject": "Плита 4ПИ-18: длина 8300, ширина 1200, срез угла 520 × 430 (770 + 430)",
             "checks": ["габариты 8300 × 1200", "срез угла 520 × 430", "объём 1,51 м³ и масса 3775 кг из таблицы"]},
            {"pdfPage": 7, "sheet": "1", "subject": "Сечение 1-1 (1197 мм): профиль, ссылка «сечение 1-1 смотри лист 1»",
             "checks": ["масштаб сечения = подписанная ширина 1197 мм", "9 пустот, шаг 120 мм"]},
            {"source": "doc25", "pdfPage": 10, "sheet": "9", "subject": "Заводской альбом УДС-1ПБ3.02.2020, разрезы 1-1, 2-2: высота 300 мм, ширина 1197, шаг пустот 120, пустота 81 × 242",
             "checks": ["пустоты 81 × 242 мм и шаг 120 мм совпадают с профилем, снятым с листа проекта (81,5 × 241,6; 120)", "высота сечения 300 мм (пояснительная записка п. 1.1, 1.7)"]},
        ],
        "assumptions": [
            {"id": "section-height", "text": "Высота сечения подписана «3000»; по масштабу сечения, названию и тексту заводского альбома УДС-1ПБ (высота 300 мм) принято 300 мм; объём 1,505 м³ при спецификации 1,51 м³.", "affects": ["concrete"]},
            {"id": "plan-width", "text": "Ширина в плане — номинальные 1200 мм, ширина сечения — 1197 мм (шов 3 мм). Принято 1197; срез угла 520 × 430 отложен от угла 1197 мм.", "affects": ["concrete"]},
            {"id": "chamfer-side", "text": "Сторона среза относительно шпоночных пазов сечения на листе не указана: принята сторона z = 1197 (дальняя от левого края сечения).", "affects": ["concrete"]},
        ],
    }


def build_pl41(profile_half):
    """Пл4.1 = ПБ62.12-10Вр1400-30: 6200 мм, ширина 1197, сечение 220 мм; на торцах вырезы 400 × 500 с одной длинной стороны."""
    outline, voids = profile_half
    full = mirrored_full_profile(outline, voids, 1197.0)
    narrow = full.intersection(box(-1, -1, 697, 400))
    ends_a = section_extrusions("Бетон Пл4.1: торец x 0…400, ширина 697 (вырез 400 × 500)", narrow, 0, 400, [6])
    middle = section_extrusions("Бетон Пл4.1: средняя часть x 400…5800, ширина 1197", full, 400, 5800, [6])
    ends_b = section_extrusions("Бетон Пл4.1: торец x 5800…6200, ширина 697 (вырез 400 × 500)", narrow, 5800, 6200, [6])
    parts = ends_a + middle + ends_b
    return {
        "key": "reg-doc11-5eb2ada77a7c", "alias": "Пл4.1", "sourceId": "doc11", "type": "многопустотная плита с угловыми вырезами на торцах",
        "parts": parts, "volumeSpec": (2220 / MASS_DENSITY, "масса 2220 кг из таблицы листа 1 ÷ 2500 кг/м³; объёма в таблице нет", True),
        "evidence": [
            {"pdfPage": 6, "sheet": "1", "subject": "Пл4.1 (ПБ62.12-10Вр1400-30): план 6200 × 1197, вырезы 400 × 500, сечение 3-3 (697 + 500)",
             "checks": ["габариты 6200 × 1197", "вырезы на торцах 400 × 500 с одной стороны", "высота сечения 220 мм", "5 пустот на сплошной части 697 мм"]},
        ],
        "assumptions": [
            {"id": "mirrored-profile", "text": "Сечение 3-3 вычерчено сплошной линией только на 697 мм, остальные 500 мм — тонкой линией. Полный профиль 1197 мм собран зеркальным отражением левой половины относительно оси 598,5 мм (пустоты симметричны, шаг 120 мм).", "affects": ["concrete"]},
            {"id": "notch-side", "text": "Вырезы 400 × 500 — на одной длинной стороне (как на плане), оба торца с одной стороны. Какая именно сторона относительно шпоночных пазов — на листе не определено; принята сторона z > 697.", "affects": ["concrete"]},
            {"id": "mass-volume", "text": "Объёма бетона в таблице листа нет: проверка — по массе 2220 кг при плотности 2500 кг/м³ (приблизительно; масса включает арматуру).", "affects": ["qa"]},
        ],
    }


# ───────────────────────── семейство УДС-1ПБ: 4Пд-2…41 и 4ПИ-1…22 ─────────────────────────
#
# Профиль 1ПБ один (сечение 1-1 doc10 л. 1), меняются длина, ширина (продольный пропил по пустоте) и форма торца в плане.
# Длина, ширина и план торца берутся из каталога (`promka-sketches.json`: размеры по листам и размерным цепочкам), объём каждой модели
# сверяется с объёмом из таблицы листа.

WIDTH_OVERRIDES = {"4Пд-34": (850.0, "марка 1ПБ86.85: ширина 8,5 дм; в эскизе каталога ошибочно 8500 мм (объём по 850 мм сходится со спецификацией: +0,8%)")}
FAMILY_PAGES = {"doc10": 7}      # лист с сечениями 1-1…8-8
FAMILY_TOLERANCE = 0.03


def _end_profile(plan, length, width):
    """Торец в плане: вершины от (L, 0) до дальнего угла → x_end(z) кусочно-линейно по z сечения; z плана (номинал 1200) приведена к ширине сечения 1197
    от дальней кромки. Возвращает список пар (z, x_end) по возрастанию z."""
    pts = [tuple(p) for p in plan]
    i0 = next(i for i, p in enumerate(pts) if abs(p[0] - length) < 1e-6 and abs(p[1]) < 1e-6)
    end = []
    for x, z in pts[i0:] + pts[:i0]:
        end.append((x, z))
        if z >= 1200 - 1e-6:
            break
    return [(max(0.0, z + (width - 1200.0)) if z > 0 else 0.0, x) for x, z in end]


def build_1pb_pd(entry, sketch, full_1pb):
    alias = entry["alias"]
    length, _, width = sketch["dimensions"]
    note = None
    if alias in WIDTH_OVERRIDES:
        width, note = WIDTH_OVERRIDES[alias]
    section = full_1pb.intersection(box(-1, -1, width, 400))
    page = entry["source"]["productPage"]
    parts = section_extrusions(f"Бетон {alias}: многопустотная полоса {length:g} × {width:g} × 300", section, 0, length, [page, 7])
    spec = entry.get("projectVolume")
    assumptions = [
        {"id": "section-height", "text": "Высота сечения 1ПБ принята 300 мм (подпись сечений листа «3000» — опечатка; заводской альбом УДС-1ПБ, п. 1.1).", "affects": ["concrete"]},
        {"id": "sawn-width", "text": f"Ширина {width:g} мм получена продольным пропилом полного профиля 1197 мм по линии, как на сечениях листа 1 (для ширин 600, 700, 720, 850, 950, 1050, 1090 мм листом дано собственное сечение, для остальных — по аналогии); длина {length:g} мм по эскизу каталога и размерной цепочке листа.", "affects": ["concrete"]},
    ]
    if note:
        assumptions.append({"id": "width-fix", "text": note, "affects": ["concrete"]})
    return {"key": entry["id"], "alias": alias, "sourceId": entry["source"]["id"], "type": "многопустотная доборная полоса, пропил по пустоте", "hollow": "udc-1pb",
            "parts": parts, "volumeSpec": (spec, "таблица листа проекта", False, FAMILY_TOLERANCE) if spec else None,
            "evidence": _family_evidence(entry, page), "assumptions": assumptions}


def build_1pb_pi(entry, sketch, full_1pb):
    alias = entry["alias"]
    length, _, _ = sketch["dimensions"]
    width = 1197.0
    profile = _end_profile(sketch["planPolygon"], length, width)       # [(z, x_end)] возрастающе по z
    xs = [x for _, x in profile]
    x_min = min(xs)
    parts = section_extrusions(f"Бетон {alias}: основная часть x 0…{x_min:g}", full_1pb, 0, x_min, [entry["source"]["productPage"], 7])
    for (z0, x0), (z1, x1) in zip(profile, profile[1:]):
        band = full_1pb.intersection(box(z0, -1, z1, 400))
        if band.is_empty:
            continue
        if abs(x0 - x1) < 1e-6:
            if x0 > x_min + 1e-6:
                parts += section_extrusions(f"Бетон {alias}: торцевой участок x {x_min:g}…{x0:g}, z {z0:g}…{z1:g}", band, x_min, x0, [entry["source"]["productPage"]])
        else:
            slope = (x1 - x0) / (z1 - z0)
            mesh, _ = oblique_end_mesh(f"Бетон {alias}: косой торец, z {z0:g}…{z1:g}", band, x_min, lambda z, z0=z0, x0=x0, slope=slope: x0 + (z - z0) * slope,
                                       [entry["source"]["productPage"]])
            parts.append(mesh)
    cut = sketch.get("dimensionSource", "")
    spec = entry.get("projectVolume")
    return {"key": entry["id"], "alias": alias, "sourceId": entry["source"]["id"], "type": "многопустотная плита со скошенным торцом", "hollow": "udc-1pb",
            "parts": parts, "volumeSpec": (spec, "таблица листа проекта", False, FAMILY_TOLERANCE) if spec else None,
            "evidence": _family_evidence(entry, entry["source"]["productPage"]),
            "assumptions": [
                {"id": "section-height", "text": "Высота сечения 1ПБ принята 300 мм (подпись сечений листа «3000» — опечатка; заводской альбом УДС-1ПБ, п. 1.1).", "affects": ["concrete"]},
                {"id": "plan-width", "text": "Ширина в плане — номинальные 1200 мм, по сечению 1197 мм (шов 3 мм): принято 1197, размеры среза отложены от дальней кромки.", "affects": ["concrete"]},
                {"id": "chamfer-side", "text": "Скос торца по размерной цепочке листа: " + (cut.split(';', 1)[1].strip() if ';' in cut else 'см. лист') + ". Сторона среза относительно шпоночных пазов сечения на листе не определена: принята сторона z = 1197.", "affects": ["concrete"]},
            ]}


def _family_evidence(entry, page):
    return [
        {"pdfPage": page, "sheet": str(entry["source"].get("sheet") or ""), "subject": f"{entry['alias']}: габариты и объём (таблица листа)",
         "checks": ["длина, ширина и форма торца в плане по размерным цепочкам листа", "объём бетона и масса из таблицы"]},
        {"pdfPage": 7, "sheet": "1", "subject": "Сечения 1-1…8-8: профиль плиты (9 пустот 81 × 242, шаг 120)", "checks": ["масштаб сечения = подписанная ширина 1197 мм"]},
        {"source": "doc25", "pdfPage": 10, "sheet": "9", "subject": "Заводской альбом УДС-1ПБ3.02.2020: высота 300 мм, пустоты 81 × 242, шаг 120", "checks": ["совпадает с профилем, снятым с листа проекта"]},
    ]


def build_family(full_1pb, skip):
    catalog = json.loads((CATALOG_DIR / "promka-models.json").read_text())
    catalog.update(json.loads((CATALOG_DIR / "promka-register.json").read_text()))
    sketches = json.loads((CATALOG_DIR / "promka-sketches.json").read_text())
    out = []
    for key, entry in catalog.items():
        alias = entry.get("alias", "")
        if entry.get("family") != "Плиты" or entry["source"]["id"] != "doc10" or key in skip or key not in sketches:
            continue
        if alias.startswith("4Пд"):
            out.append(build_1pb_pd(entry, sketches[key], full_1pb))
        elif alias.startswith("4ПИ"):
            out.append(build_1pb_pi(entry, sketches[key], full_1pb))
    return sorted(out, key=lambda m: (m["alias"][:3], int(''.join(c for c in m["alias"].split('-')[1] if c.isdigit()))))


# ───────────────────────── контуры ПГП и ПШЛ по векторным листам ─────────────────────────

def _snap(v, step=5.0):
    return round(v / step) * step


def read_plan_outline(doc_id, page, region, width_mm, min_width=1.0, snap=5.0, tol=0.4):
    """Внешний контур плана по толстым штрихам листа: вершины в мм (x слева направо, y снизу вверх), привязка к сетке snap.
    Масштаб — по ширине контура width_mm (по горизонтали листа). Возвращает (вершины, масштаб, высота_мм)."""
    groups = connected_groups(sheet_chains(doc_id, page, region, min_width=min_width), tol=tol)
    best = max(groups, key=lambda g: max(p.x for c in g for p in c) - min(p.x for c in g for p in c))
    ring = group_ring(best, tol=tol)
    xs, ys = [p.x for p in ring], [p.y for p in ring]
    scale = width_mm / (max(xs) - min(xs))
    pts = [(_snap((p.x - min(xs)) * scale, snap), _snap((max(ys) - p.y) * scale, snap)) for p in ring]
    out = [pts[0]]
    for q in pts[1:]:
        if q != out[-1]:
            out.append(q)
    if out[0] == out[-1]:
        out.pop()
    # убрать лишние точки на прямых
    clean = []
    for i, q in enumerate(out):
        a, b = out[i - 1], out[(i + 1) % len(out)]
        if (a[0] == q[0] == b[0]) or (a[1] == q[1] == b[1]):
            continue
        clean.append(q)
    return clean, scale, (max(ys) - min(ys)) * scale


def read_plan_holes(doc_id, page, region, outline_box, scale, size_range=(50.0, 260.0)):
    """Прямоугольные сквозные отверстия плана: замкнутые прямоугольники (пять точек, линия 0,7…1,0 pt) размером size_range мм.
    outline_box = (x_левый_pt, y_нижний_pt) контура на листе. Возвращает [(x, y, w, h)] в мм, y снизу вверх."""
    x0, y_bottom = outline_box
    holes = set()
    for c in sheet_chains(doc_id, page, region, min_width=0.7, max_width=1.0):
        if len(c) != 5 or math.hypot(c[0].x - c[4].x, c[0].y - c[4].y) > 0.2:
            continue
        xs, ys = [p.x for p in c], [p.y for p in c]
        w, h = (max(xs) - min(xs)) * scale, (max(ys) - min(ys)) * scale
        if size_range[0] <= w <= size_range[1] and size_range[0] <= h <= size_range[1]:
            holes.add((_snap((min(xs) - x0) * scale, 1.0), _snap((y_bottom - max(ys)) * scale, 1.0), _snap(w, 5.0), _snap(h, 5.0)))
    return sorted(holes)


# ───────────────────────── плиты Пл (ПБ серии 192/16, doc11) ─────────────────────────
#
# Высота 220, пустоты 81 × 162 с шагом 120. Профиль зависит от ширины: 997, 1197, 1497 мм (свой набор пустот у каждой), 1080 — пропил профиля 1197 по оси
# девятой пустоты. План торцов (вырезы) — с вектора листа: каждая плита собирается из частей по интервалам длины, в каждом — профиль, обрезанный по ширине плана.

PL_SECTIONS = {  # профиль на всю ширину: (лист, область сечения, подписанная ширина сплошной части, полная ширина)
    997: ("doc11", 6, (140, 640, 350, 715), 697),
    1197: ("doc11", 6, (615, 438, 975, 515), 697),
    1497: ("doc11", 7, (130, 675, 570, 765), 1197),
}


def pl_profiles():
    profiles = {}
    for full, (doc, page, region, solid_w) in PL_SECTIONS.items():
        outline, voids, _, _ = read_section(doc, page, region, solid_w, min_width=1.0, height_mm=220)
        profiles[full] = mirrored_full_profile(outline, voids, float(full))
    profiles[1080] = profiles[1197].intersection(box(-1, -1, 1080, 400))
    return profiles


def page_plans(doc_id, page, expected):
    """Контуры планов на листе по порядку сверху вниз: толстые замкнутые контуры (до 8 штрихов), ширина по горизонтали не менее 200 pt."""
    groups = connected_groups(sheet_chains(doc_id, page, (30, 30, 700, 800), min_width=1.0))
    rings = []
    for g in groups:
        pts = [p for c in g for p in c]
        w = max(p.x for p in pts) - min(p.x for p in pts)
        h = max(p.y for p in pts) - min(p.y for p in pts)
        if w > 200 and h > 50 and len(g) <= 8:
            rings.append((min(p.y for p in pts), g))
    rings.sort(key=lambda r: r[0])
    if len(rings) < expected:
        raise SystemExit(f"лист {page}: найдено планов {len(rings)}, ожидалось {expected}")
    return [r[1] for r in rings[:expected]]


def plan_from_group(group, length_mm, snap=5.0):
    ring = group_ring(group)
    xs, ys = [p.x for p in ring], [p.y for p in ring]
    scale = length_mm / (max(xs) - min(xs))
    pts = [(_snap((p.x - min(xs)) * scale, snap), _snap((max(ys) - p.y) * scale, snap)) for p in ring]
    out = [pts[0]]
    for q in pts[1:]:
        if q != out[-1]:
            out.append(q)
    if out[0] == out[-1]:
        out.pop()
    return [q for i, q in enumerate(out) if not ((out[i - 1][0] == q[0] == out[(i + 1) % len(out)][0]) or (out[i - 1][1] == q[1] == out[(i + 1) % len(out)][1]))]


def plan_span_extrusions(name, plan, profile, pages):
    """Плита по плану (x длина, y ширина = z сечения) и профилю: части по интервалам длины между вершинами плана."""
    poly = Polygon(plan)
    xs = sorted({p[0] for p in plan})
    pieces = []
    for x0, x1 in zip(xs, xs[1:]):
        mid = (x0 + x1) / 2
        cut = poly.intersection(box(mid - 0.01, -1, mid + 0.01, 1e5))
        if cut.is_empty:
            continue
        ymin, ymax = cut.bounds[1], cut.bounds[3]
        if pieces and abs(pieces[-1][2] - ymin) < 1e-6 and abs(pieces[-1][3] - ymax) < 1e-6 and abs(pieces[-1][1] - x0) < 1e-6:
            pieces[-1][1] = x1
        else:
            pieces.append([x0, x1, ymin, ymax])
    parts = []
    for x0, x1, ymin, ymax in pieces:
        section = profile.intersection(box(ymin, -1, ymax, 400))
        parts += section_extrusions(f"{name}: x {x0:g}…{x1:g}, ширина {ymax - ymin:g}", section, x0, x1, pages)
    return parts


def build_pl_family(skip):
    catalog = json.loads((CATALOG_DIR / "promka-models.json").read_text())
    catalog.update(json.loads((CATALOG_DIR / "promka-register.json").read_text()))
    sketches = json.loads((CATALOG_DIR / "promka-sketches.json").read_text())
    readings = json.loads((CATALOG_DIR / "promka-readings.json").read_text())
    profiles = pl_profiles()
    by_page = {}
    for key, entry in catalog.items():
        if entry.get("family") == "Плиты" and entry["source"]["id"] == "doc11" and key in sketches:
            by_page.setdefault(entry["source"]["productPage"], []).append((key, entry))
    out = []
    for page, rows in sorted(by_page.items()):
        plans = page_plans("doc11", page, len(rows))
        for (key, entry), group in zip(rows, plans):
            if key in skip:
                continue
            alias = entry["alias"]
            length = sketches[key]["dimensions"][0]
            plan = plan_from_group(group, length)
            width = max(y for _, y in plan)
            full = min(profiles, key=lambda w: abs(w - width))
            length_note = ""
            if abs(full - width) > 15:
                # масштаб плана по длине из каталога не сходится с шириной профиля: длина на листе другая (марка округляет длину)
                k = full / width
                if abs(k - 1) > 0.04:
                    raise SystemExit(f"{alias}: ширина плана {width:g} не соответствует профилям {sorted(profiles)}")
                plan = plan_from_group(group, length * k)
                length_note = f"Длина по масштабу плана и ширине профиля {full} мм — {max(x for x, _ in plan):g} мм вместо {length:g} в эскизе каталога (по размерной цепочке листа ≈5600 мм)."
                width = max(y for _, y in plan)
            parts = plan_span_extrusions(f"Бетон {alias}", plan, profiles[full], [page])
            reading = readings.get(key, {})
            mass = reading.get("massKg")
            notches = len(plate_pockets(plan))
            out.append({
                "key": key, "alias": alias, "sourceId": "doc11", "type": f"многопустотная плита 220 мм, ширина {full}" + (", вырезы на торцах" if notches else ""),
                "hollow": "192-16", "parts": parts,
                "volumeSpec": (mass / MASS_DENSITY, f"масса {mass:g} кг из таблицы листа ÷ 2500 кг/м³ (объёма в таблице нет)", True, 0.04) if mass else None,
                "evidence": [{"pdfPage": page, "sheet": str(page - 5), "subject": f"{alias}: план {length:g} × {width:g}, вырезы торцов, сечение",
                              "checks": ["длина и контур плана с вектора листа (округление до 5 мм)", f"профиль ширины {full} мм из сечений листа", "масса из таблицы"]}],
                "assumptions": [
                    {"id": "profile", "text": f"Профиль на всю ширину {full} мм собран зеркальным отражением левой половины сечения листа (сплошная часть вычерчена целиком, остаток — тонкой линией); пустоты симметричны." if full != 1080 else "Ширина 1080 мм — пропил профиля 1197 мм по оси девятой пустоты (так показано сечением 8-8).", "affects": ["concrete"]},
                    {"id": "notch-side", "text": "Вырезы торцов — по контуру плана листа; сторона относительно шпоночных пазов сечения на листе не определена (принято: ось плана «вверх» = +z).", "affects": ["concrete"]},
                    {"id": "mass-volume", "text": "Объёма бетона в таблице нет: проверка по массе ÷ 2500 кг/м³ (приблизительно, масса включает арматуру).", "affects": ["qa"]},
                ] + ([{"id": "length-scale", "text": length_note, "affects": ["concrete"]}] if length_note else [])})
    return out


# ───────────────────────── заводские плиты 1П–4П (КЖ2-1, КЖ2-2: спецификация перекрытий) ─────────────────────────
#
# На листах спецификации — только марка, фактическая длина, количество и масса: плиты без вырезов, прямоугольные. 1П/2П/3П — ПБ серии 192/16 шириной 1,0 / 1,2 / 1,5 м
# (профиль Пл 997 / 1197 / 1497, высота 220), 4П — УДС-1ПБ шириной 1197 (профиль 1ПБ, высота 300). Длина — «L=» из той же строки спецификации.

FACTORY_SHEETS = {"1П": ("doc19", 87, 997, "192-16"), "2П": ("doc19", 87, 1197, "192-16"), "3П": ("doc19", 87, 1497, "192-16"), "4П": ("doc20", 227, 1197, "udc-1pb")}


def factory_lengths(doc_id, page):
    """Марка → фактическая длина по строкам спецификации листа («1 П -2 … L=5560»)."""
    import re
    lines = [l.strip() for l in fitz.open(SOURCES / f"{doc_id}.pdf")[page - 1].get_text().split("\n")]
    out, current = {}, None
    for line in lines:
        m = re.fullmatch(r"(\d)\s?П\s?-\s?(\d+)", line)
        if m:
            current = f"{m.group(1)}П-{m.group(2)}"
            continue
        m = re.fullmatch(r"L=(\d+)", line)
        if m and current:
            out.setdefault(current, int(m.group(1)))
    return out


def build_factory_family(full_1pb, profiles, skip):
    catalog = json.loads((CATALOG_DIR / "promka-models.json").read_text())
    catalog.update(json.loads((CATALOG_DIR / "promka-register.json").read_text()))
    readings = json.loads((CATALOG_DIR / "promka-readings.json").read_text())
    lengths = {}
    for doc_id, page in (("doc19", 87), ("doc20", 227)):
        lengths.update(factory_lengths(doc_id, page))
    out = []
    for key, entry in catalog.items():
        alias = entry.get("alias", "")
        series = alias[:2]
        if series not in FACTORY_SHEETS or entry["source"]["id"] not in ("doc19", "doc20") or key in skip or entry.get("excluded"):
            continue
        doc_id, page, width, hollow = FACTORY_SHEETS[series]
        if entry["source"]["id"] != doc_id or alias not in lengths:
            continue
        length = lengths[alias]
        profile = full_1pb if series == "4П" else profiles[width]
        height = 300 if series == "4П" else 220
        parts = section_extrusions(f"Бетон {alias}: плита {length} × {width} × {height}", profile, 0, length, [page])
        mass = readings.get(key, {}).get("massKg")
        out.append({
            "key": key, "alias": alias, "sourceId": doc_id, "type": f"заводская многопустотная плита {height} мм, прямоугольная", "hollow": hollow, "parts": parts,
            "volumeSpec": (mass / MASS_DENSITY, f"масса {mass:g} кг из спецификации перекрытий ÷ 2500 кг/м³ (объёма в спецификации нет)", True, 0.05) if mass else None,
            "evidence": [{"pdfPage": page, "sheet": str(entry["source"].get("sheet") or ""), "subject": f"{alias}: марка, фактическая длина L={length}, масса — спецификация перекрытий",
                          "checks": ["длина из строки спецификации", "масса из строки спецификации"]}],
            "assumptions": [
                {"id": "geometry-from-series", "text": (f"Плиты серии {series} на листах спецификации только перечислены (марка, длина, масса); геометрия взята по серии: ширина {width} мм, высота {height} мм, профиль с пустотами " + ("81 × 242 мм (УДС-1ПБ, лист 1 КЖ.И3-1)" if series == "4П" else "81 × 162 мм (ПБ серии 192/16, листы КЖ.И3)") + "; вырезов и закладных нет."), "affects": ["concrete"]},
                {"id": "mass-volume", "text": "Объёма бетона в спецификации нет: проверка по массе ÷ 2500 кг/м³ (приблизительно, масса включает проволоку).", "affects": ["qa"]},
            ]})
    return out


# ───────────────────────── арматура ПГП1 (листы 85, 86, 88) ─────────────────────────

STEEL_KG_PER_M3 = 7850.0
BLOCK_OFFSET = 15                      # арматурный блок 4450 × 3100 внутри плиты 4480 × 3130: по 15 мм с каждой стороны (сечение 1-1 листа 87)
NET_BOTTOM_Y, NET_TOP_Y = 35.0, 265.0  # защитный слой 35 мм сверху и снизу при высоте блока 230 мм (лист 88)


def bar_mass_kg(diameter, length_mm):
    return math.pi * diameter ** 2 / 4 * length_mm * STEEL_KG_PER_M3 / 1e9


def _polyline_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


class SheetMap:
    """Перевод координат листа (xs вправо, ys вверх) в координаты модели (x вдоль длины плиты, z поперёк, y вверх).
    Вид сверху в правой системе: «вверх по листу» — это −z (по умолчанию) либо лист повёрнут на 90° по часовой (rotate). Для вида снизу
    (ПШЛ, план «из шахты лифта») «вверх по листу» совпадает с +z (identity)."""
    def __init__(self, width_sheet, height_sheet, rotate=False, identity=False):
        self.w, self.h, self.rotate, self.identity = width_sheet, height_sheet, rotate, identity

    def xz(self, xs, ys):
        if self.identity:
            return (xs, ys)
        return (ys, xs) if self.rotate else (xs, self.h - ys)

    def vec(self, dxs, dys):
        if self.identity:
            return (dxs, dys)
        return (dys, dxs) if self.rotate else (dxs, -dys)


def _block_xz(sm, u, v):
    return sm.xz(BLOCK_OFFSET + u, BLOCK_OFFSET + v)


def abp_nets(sm, U, V, d, bars_u_v, bars_v_u, ident_prefix, sheet_page, spec_name, top_y=None):
    """Две сетки блока U × V: стержни вдоль u (длина U) на позициях v из bars_u_v, вдоль v (длина V) на позициях u из bars_v_u.
    Нижняя и верхняя: по два слоя Ø d, наружные слои — стержни вдоль большей стороны блока."""
    outer_u = U >= V
    top_y = NET_TOP_Y if top_y is None else top_y
    groups = []
    for name, ident, ys in (("нижняя", "net-bottom", (NET_BOTTOM_Y + d / 2, NET_BOTTOM_Y + d * 1.5)), ("верхняя", "net-top", (top_y - d * 1.5, top_y - d / 2))):
        outer, inner = (ys[0], ys[1]) if ident == "net-bottom" else (ys[1], ys[0])      # наружный слой — ближе к грани блока
        y_u, y_v = (outer, inner) if outer_u else (inner, outer)
        paths = []
        for k, v in enumerate(bars_u_v):
            (x0, z0), (x1, z1) = _block_xz(sm, 0, v), _block_xz(sm, U, v)
            paths.append({"id": f"{ident}:u:{k + 1}", "diameter": d, "points": [[x0, y_u, z0], [x1, y_u, z1]], "position": "1"})
        for k, u in enumerate(bars_v_u):
            (x0, z0), (x1, z1) = _block_xz(sm, u, 0), _block_xz(sm, u, V)
            paths.append({"id": f"{ident}:v:{k + 1}", "diameter": d, "points": [[x0, y_v, z0], [x1, y_v, z1]], "position": "1"})
        groups.append({"id": ident, "name": f"{spec_name}, {name} (поз. 1, ×2 в блоке)", "shortLabel": f"Сетка 2С · {name}", "designation": "Сетка2С",
                       "sheet": str(sheet_page - 8), "quantity": 1, "unit": "шт", "kind": "net", "material": "А500С", "sourcePages": [sheet_page], "paths": paths})
    return groups


def abp_loops(sm, d, R, centers, net_d, ident="loops", name="", designation="", sheet="85", pages=(), eye_height=None, target_len=None, tail=50.0):
    """Петли Ø d (Пп3 R80, Пп4 R50): два плоских полукольца R с хвостами 50 и ступенька 2R, по центру ступеньки подъёмная петля ∩ (лист 85).
    Ось петли — вдоль u блока; центры подъёмных дуг centers = [(u, v)]. Верх петли — 135 мм над верхней гранью блока."""
    base_y = NET_BOTTOM_Y + 2 * net_d + d / 2
    top_outer = NET_TOP_Y + 135.0 if eye_height is None else base_y - d / 2 + eye_height
    arc_cy = top_outer - d / 2 - R
    half = 350.0
    if target_len:                         # длина стержня по спецификации определяет вылет ветвей (форма в плане условна)
        riser = arc_cy - base_y
        run = (target_len - 2 * tail - 3 * math.pi * R - 2 * riser) / 2
        half = R + max(run, R)
    paths = []
    for ci, (uc, vc) in enumerate(centers, 1):
        def P(a, w, y):                      # a — по оси петли (0…700), w — вниз по листу; центр подъёмной дуги (350, 3R)
            x, z = _block_xz(sm, uc + (a - half), vc - (w - 3 * R))
            return [x, y, z]
        pts = [P(R + tail, 0, base_y), P(R, 0, base_y)]
        for ang in range(-90, -271, -15):
            pts.append(P(R + R * math.cos(math.radians(ang)), R + R * math.sin(math.radians(ang)), base_y))
        pts += [P(half, 2 * R, base_y), P(half, 2 * R, arc_cy)]
        for i in range(1, 13):
            t = math.radians(180 - 180 * i / 12)
            pts.append(P(half, 3 * R + R * math.cos(t), arc_cy + R * math.sin(t)))
        pts += [P(half, 4 * R, base_y), P(2 * half - R, 4 * R, base_y)]
        for ang in range(-90, 91, 15):
            pts.append(P(2 * half - R + R * math.cos(math.radians(ang)), 5 * R + R * math.sin(math.radians(ang)), base_y))
        pts.append(P(2 * half - R - tail, 6 * R, base_y))
        paths.append({"id": f"{ident}:{ci}", "diameter": d, "points": pts, "position": "2", "instance": str(ci),
                      "note": "форма условная: радиусы гибов по листу 85, подъёмная часть по разрезам"})
    return [{"id": ident, "name": name, "shortLabel": f"Петли {designation}", "designation": designation, "sheet": sheet, "quantity": len(centers), "unit": "шт",
             "kind": "loop", "material": "А500С", "sourcePages": list(pages), "paths": paths}]


def abp_frames(sm, U, V, d, run_axis, positions, net_d, ident="frames", name="", designation="", pages=()):
    """Каркасы-фиксаторы Ø d: линии вдоль run_axis ('v' или 'u') на позициях positions (по другой оси блока). Развёртка 530 мм сложена ∧ высотой
    230 мм: три продольных стержня с каждой стороны (65/140/215 от сгиба) и поперечные L=530 через 200 мм в каждой тысяче."""
    apex_y = NET_TOP_Y - net_d / 2
    dy, dx = 0.868, 0.496
    run_len = V if run_axis == "v" else U
    paths, cross = [], []

    def xz(across, along):
        return _block_xz(sm, across, along) if run_axis == "v" else _block_xz(sm, along, across)

    for fi, pos in enumerate(positions, 1):
        for t in (-215, -140, -65, 65, 140, 215):
            a = pos + math.copysign(abs(t) * dx, t)
            (x0, z0), (x1, z1) = xz(a, 0), xz(a, run_len)
            y = apex_y - abs(t) * dy
            paths.append({"id": f"{ident}:{fi}:{t}", "diameter": d, "points": [[x0, y, z0], [x1, y, z1]], "position": "Кф"})
        k = 0
        for base in range(0, int(run_len), 1000):
            for off in (200, 400, 600, 800):
                along = base + off
                if along > run_len:
                    continue
                k += 1
                pts = []
                for t in (-250, 0, 250):
                    x, z = xz(pos + math.copysign(abs(t) * dx, t), along)
                    pts.append([x, apex_y - abs(t) * dy, z])
                cross.append({"id": f"{ident}:{fi}:cross:{k}", "diameter": d, "points": pts, "position": "Кф"})
    return [{"id": ident, "name": name, "shortLabel": f"Каркасы {designation}", "designation": designation, "sheet": "85", "quantity": round(run_len * len(positions) / 1000, 2),
             "unit": "п.м", "kind": "frame", "material": "А500С", "sourcePages": list(pages), "paths": paths + cross}]


def plate_pockets(polygon_sheet):
    """Прямоугольные выемки контура (в координатах листа): (сторона, начало вдоль, конец вдоль, глубина); сторона left/right/bottom/top."""
    xs, ys = [p[0] for p in polygon_sheet], [p[1] for p in polygon_sheet]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    rest = box(x0, y0, x1, y1).difference(Polygon(polygon_sheet))
    out = []
    for g in polygons_of(rest):
        gx0, gy0, gx1, gy1 = g.bounds
        if abs(gx0 - x0) < 1e-6:
            out.append(("left", gy0, gy1, gx1 - gx0))
        elif abs(gx1 - x1) < 1e-6:
            out.append(("right", gy0, gy1, gx1 - gx0))
        elif abs(gy0 - y0) < 1e-6:
            out.append(("bottom", gx0, gx1, gy1 - gy0))
        elif abs(gy1 - y1) < 1e-6:
            out.append(("top", gx0, gx1, gy1 - gy0))
    return sorted(out, key=lambda r: (r[0], r[1]))


def abp_embedded(sm, polygon_sheet):
    """Закладные ЗД12 в каждой выемке контура: пластина −10×300 L=200 за дном выемки (глубокая выемка) либо заподлицо с краем (выемка ≤ 20 мм —
    узел Т) и четыре анкера Ø12 L=365 (215 в бетон + отгиб 150 вдоль пластины)."""
    xs, ys = [p[0] for p in polygon_sheet], [p[1] for p in polygon_sheet]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    plates, anchors = [], []
    for ni, (side, a0, a1, depth) in enumerate(plate_pockets(polygon_sheet), 1):
        acenter = (a0 + a1) / 2
        deep = depth > 20
        # пластина в координатах листа: bbox (xa, ya, xb, yb) и направление «в глубь плиты» (в листе)
        if side == "left":
            rect = (depth if deep else 0, a0, (depth + 10) if deep else 10, a1) if deep else (0, a0, 10, a1)
            back, inward, along = (depth + 10 if deep else 10, acenter), (1, 0), (0, 1)
        elif side == "right":
            rect = (x1 - 10, a0, x1, a1)
            back, inward, along = (x1 - 10, acenter), (-1, 0), (0, 1)
        elif side == "bottom":
            rect = (a0, depth, a1, depth + 10) if deep else (a0, 0, a1, 10)
            back, inward, along = (acenter, depth + 10 if deep else 10), (0, 1), (1, 0)
        else:
            rect = (a0, y1 - depth - 10, a1, y1 - depth) if deep else (a0, y1 - 10, a1, y1)
            back, inward, along = (acenter, y1 - depth - 10 if deep else y1 - 10), (0, -1), (1, 0)
        ca, cb = sm.xz(rect[0], rect[1]), sm.xz(rect[2], rect[3])
        bx0, bx1, bz0, bz1 = min(ca[0], cb[0]), max(ca[0], cb[0]), min(ca[1], cb[1]), max(ca[1], cb[1])
        if bx1 - bx0 <= bz1 - bz0:           # тонкая по x
            part = extrusion_part(f"Пластина ЗД12 −10×300, L=200 (выемка {ni})", box(bz0, 0, bz1, 300), [bx0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], bx1 - bx0, [92, 94])
        else:
            part = extrusion_part(f"Пластина ЗД12 −10×300, L=200 (выемка {ni})", box(bx0, 0, bx1, 300), [0, 0, bz0], [1, 0, 0], [0, 1, 0], [0, 0, 1], bz1 - bz0, [92, 94])
        part["group"] = "zd12"
        plates.append(part)
        bx, bz = sm.xz(*back)
        inx, inz = sm.vec(*inward)
        alx, alz = sm.vec(*along)
        for ai, (a, y) in enumerate(((50, 50), (150, 50), (50, 250), (150, 250)), 1):
            off = a - 100
            start = [bx + alx * off, y, bz + alz * off]
            mid = [start[0] + inx * 215, y, start[2] + inz * 215]
            end = [mid[0] + alx * math.copysign(150, off), y, mid[2] + alz * math.copysign(150, off)]
            anchors.append({"id": f"zd12:{ni}:{ai}", "diameter": 12, "points": [start, mid, end], "position": "ЗД12 поз. 2"})
    group = {"id": "zd12", "name": f"Закладная деталь ЗД12: пластина −10×300 L=200 и 4 анкера Ø12 А500С L=365 (×{len(plates)})", "shortLabel": "Закладные ЗД12",
             "designation": "ЗД12", "sheet": "86", "quantity": len(plates), "unit": "шт", "kind": "embedded", "material": "С245 / А500С",
             "sourcePages": [94, 92], "paths": anchors}
    return group, plates


def pk1_frames(sm, U, V, positions, top_y, net_d, ident="frames", name="", pages=()):
    """Поддерживающие каркасы ПК1 (лист 106): ∧ высотой 180 мм и основанием 200 мм, 4 продольных Ø8 L=2020 (по два на ветвь) и 11 поперечных
    Ø8 L=425 (по краям 55 и через 200 мм). Линии идут вдоль u на позициях v; длина — не больше 2020 и не больше ширины блока, по центру."""
    L = min(2020.0, U - 70.0)
    u0 = (U - L) / 2
    apex_y = top_y - net_d / 2
    h, half_base = 180.0, 100.0
    paths, cross = [], []
    cross_pos = [55.0] + [165.0 + 200 * k for k in range(9)] + [2020.0 - 55.0]
    for fi, v in enumerate(positions, 1):
        for side in (-1, 1):
            for drop in (40.0, 140.0):                    # вертикальные размеры 40 | 100 | 40 вида после сгиба
                x0, z0 = _block_xz(sm, u0, v + side * half_base * drop / h)
                x1, z1 = _block_xz(sm, u0 + L, v + side * half_base * drop / h)
                paths.append({"id": f"{ident}:{fi}:{side}:{int(drop)}", "diameter": 8, "points": [[x0, apex_y - drop, z0], [x1, apex_y - drop, z1]], "position": "4"})
        for k, a in enumerate(cross_pos, 1):
            if a > L:
                continue
            pts = []
            for side in (-1, 0, 1):
                x, z = _block_xz(sm, u0 + a, v + side * half_base)
                pts.append([x, apex_y - (0 if side == 0 else h), z])
            cross.append({"id": f"{ident}:{fi}:cross:{k}", "diameter": 8, "points": pts, "position": "3"})
    return [{"id": ident, "name": name, "shortLabel": "Каркасы ПК1", "designation": "ПК1", "sheet": "106", "quantity": len(positions), "unit": "шт",
             "kind": "frame", "material": "А500С", "sourcePages": list(pages), "paths": paths + cross}]


def mn5_embedded(sm, polygon_sheet):
    """Закладные МН5 (лист 109, узел Е листа 110) в выемках контура: пластина −10×100, L=200 за дном выемки по центру толщины плиты и два анкера
    Ø12 L=340 (200 в бетон + отгиб 140 вдоль пластины)."""
    plates, anchors = [], []
    for ni, (side, a0, a1, depth) in enumerate(plate_pockets(polygon_sheet), 1):
        acenter = (a0 + a1) / 2
        xs, ys = [p[0] for p in polygon_sheet], [p[1] for p in polygon_sheet]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        if side == "left":
            rect, back, inward, along = (depth, a0, depth + 10, a1), (depth + 10, acenter), (1, 0), (0, 1)
        elif side == "right":
            rect, back, inward, along = (x1 - depth - 10, a0, x1 - depth, a1), (x1 - depth - 10, acenter), (-1, 0), (0, 1)
        elif side == "bottom":
            rect, back, inward, along = (a0, depth, a1, depth + 10), (acenter, depth + 10), (0, 1), (1, 0)
        else:
            rect, back, inward, along = (a0, y1 - depth - 10, a1, y1 - depth), (acenter, y1 - depth - 10), (0, -1), (1, 0)
        ca, cb = sm.xz(rect[0], rect[1]), sm.xz(rect[2], rect[3])
        bx0, bx1, bz0, bz1 = min(ca[0], cb[0]), max(ca[0], cb[0]), min(ca[1], cb[1]), max(ca[1], cb[1])
        y_lo, y_hi = 50.0, 150.0
        if bx1 - bx0 <= bz1 - bz0:
            part = extrusion_part(f"Пластина МН5 −10×100, L=200 (выемка {ni})", box(bz0, y_lo, bz1, y_hi), [bx0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], bx1 - bx0, [120, 121])
        else:
            part = extrusion_part(f"Пластина МН5 −10×100, L=200 (выемка {ni})", box(bx0, y_lo, bx1, y_hi), [0, 0, bz0], [1, 0, 0], [0, 1, 0], [0, 0, 1], bz1 - bz0, [120, 121])
        part["group"] = "mn5"
        plates.append(part)
        bx, bz = sm.xz(*back)
        inx, inz = sm.vec(*inward)
        alx, alz = sm.vec(*along)
        for ai, off in enumerate((-70.0, 70.0), 1):         # анкеры в 30 мм от краёв пластины L=200
            start = [bx + alx * off, 100.0, bz + alz * off]
            mid = [start[0] + inx * 200, 100.0, start[2] + inz * 200]
            end = [mid[0] + alx * math.copysign(140, off), 100.0, mid[2] + alz * math.copysign(140, off)]
            anchors.append({"id": f"mn5:{ni}:{ai}", "diameter": 12, "points": [start, mid, end], "position": "МН5 поз. 2"})
    group = {"id": "mn5", "name": f"Закладная деталь МН5: пластина −10×100 L=200 и 2 анкера Ø12 А500С L=340 (×{len(plates)})", "shortLabel": "Закладные МН5",
             "designation": "МН5", "sheet": "109", "quantity": len(plates), "unit": "шт", "kind": "embedded", "material": "С245 / А500С",
             "sourcePages": [120, 121], "paths": anchors}
    return group, plates


def _group_mass(groups):
    return sum(bar_mass_kg(p["diameter"], _polyline_length(p["points"])) for g in groups for p in g["paths"])


PGP_ISSUE_VOLUME = {"id": "volume-mismatch", "kind": "source-conflict", "severity": "warning", "blocksAcceptance": False,
                    "title": "Объём по чертежу контура не сходится с объёмом спецификации",
                    "description": "Контур плана 4480 × 3130 с выемками × толщина 300 мм даёт 4,14 м³; спецификация — 4,37 м³ (масса 10925 кг = 4,37 × 2500). Даже габаритный брус 4480 × 3130 × 300 без выемок — 4,21 м³, то есть меньше 4,37; у ПГП2 и ПГПЗ объём спецификации (4,55) совпадает с брусом 6300 × 2410 × 300 без выемок. Нужна сверка проектировщика: толщина плиты, размеры или объём в спецификации.",
                    "sourcePages": [95, 97]}

# параметры плит подъёмника: лист PDF, ширина по горизонтали листа, тип блока, номера листов блока и спецификация
PGP_SPECS = {
    "ПГП1": dict(page=95, sheet="87", width=4480, length=4480, block="abp1", sheets=[96]),
    "ПГП1н": dict(page=97, sheet="89", width=4480, length=4480, block="abp1", sheets=[96]),
    "ПГП2": dict(page=98, sheet="90", width=2410, length=6300, block="abp2", sheets=[99]),
    "ПГП2н": dict(page=100, sheet="92", width=2410, length=6300, block="abp2", sheets=[99]),
    "ПГПЗ": dict(page=101, sheet="93", width=2410, length=6300, block="abp2", sheets=[99]),
}
ZD12_COUNT = {"ПГП1": 8, "ПГП1н": 8, "ПГП2": 6, "ПГП2н": 6, "ПГПЗ": 4}


def build_pgp(entry):
    """Плита покрытия грузового подъёмника (ПГП1, ПГП1н, ПГП2, ПГП2н, ПГПЗ): контур — с вектора листа, арматурный блок АБП1/АБП2, закладные ЗД12."""
    alias = entry["alias"]
    spec = PGP_SPECS[alias]
    region = (100, 60, 620, 430) if spec["block"] == "abp1" else (60, 50, 620, 560)
    plan, scale, plate_h = read_plan_outline("doc12", spec["page"], region, spec["width"], min_width=1.6)
    W, H = spec["width"], round(plate_h / 5) * 5
    sm = SheetMap(W, H, rotate=spec["block"] == "abp2")
    plan_model = Polygon([sm.xz(x, y) for x, y in plan])
    part = plan_extrusion(f"Бетон {alias}: плита {spec['length']} × {min(W, H)} × 300, выемки под закладные", plan_model, 300, [spec["page"], 92])
    zd12, plates = abp_embedded(sm, plan)
    if len(plates) != ZD12_COUNT[alias]:
        raise SystemExit(f"{alias}: выемок {len(plates)}, закладных ЗД12 по спецификации {ZD12_COUNT[alias]}")
    if spec["block"] == "abp1":
        U, V = 4450, 3100
        nets = abp_nets(sm, U, V, 14, [50 + 200 * k for k in range(16)], [25 + 200 * k for k in range(23)], "net", 96,
                        "Сетка 2С 14А500С-200(50)/14А500С-200 3100×4450")
        loops = abp_loops(sm, 20, 80, [(u, v) for v in (2365, 735) for u in (885, 2225, 3565)], 14,
                          name="Петля Пп3 Ø20 А500С L=1980 (поз. 2, ×6)", designation="Пп3", pages=[93, 96])
        frames = abp_frames(sm, U, V, 8, "v", [485, 1175, 1895, 2585, 3275, 3965], 14, name="Каркас-фиксатор Кф1 Ø8 А500С, 18,6 п.м. (поз. 3)", designation="Кф1", pages=[93, 96])
        specs = [("Арматурный блок АБП1 (сетки + петли + каркасы)", None, 444.61, "лист 88, спецификация АБП1", 0.05),
                 ("Сетки 2С ×2", nets, 2 * 177.81, "лист 88, поз. 1", 0.05),
                 ("Петли Пп3 ×6", loops, 6 * 4.88, "лист 88, поз. 2 (лист 85: Ø20 L=1980)", 0.08),
                 ("Каркасы Кф1, 18,6 п.м.", frames, 18.6 * 3.21, "лист 88, поз. 3 (лист 85: 3,21 кг/п.м.)", 0.05)]
        block_name, block_desc, sheet_block = "АБП1", "сетки 2С Ø14, петли Пп3 Ø20, каркасы Кф1 Ø8", "85, 86, 88"
    else:
        U, V = 2380, 6270
        nets = abp_nets(sm, U, V, 18, [35 + 200 * k for k in range(32)], [130 + 100 * k for k in range(23)], "net", 99,
                        "Сетка 2С 18А500С-100(130)/18А500С-200 2380×6270")
        loops = abp_loops(sm, 18, 50, [(u, v) for v in (885, 2385, 3885, 5385) for u in (585, 1795)], 18,
                          name="Петля Пп4 Ø18 А500С L=1850 (поз. 2, ×8)", designation="Пп4", pages=[93, 99])
        frames = abp_frames(sm, U, V, 10, "u", [385 + 500 * k for k in range(12)], 18, name="Каркас-фиксатор Кф2 Ø10 А500С, 28,56 п.м. (поз. 3)", designation="Кф2", pages=[93, 99])
        specs = [("Арматурный блок АБП2 (сетки + петли + каркасы)", None, 1079.25, "лист 91, спецификация АБП2", 0.06),
                 ("Сетки 2С ×2", nets, 2 * 453.28, "лист 91, поз. 1", 0.06),
                 ("Петли Пп4 ×8", loops, 8 * 3.70, "лист 91, поз. 2 (лист 85: Ø18 L=1850)", 0.10),
                 ("Каркасы Кф2, 28,56 п.м.", frames, 28.56 * 5.01, "лист 91, поз. 3 (лист 85: 5,01 кг/п.м.)", 0.06)]
        block_name, block_desc, sheet_block = "АБП2", "сетки 2С Ø18, петли Пп4 Ø18, каркасы Кф2 Ø10", "85, 86, 91"
    block_kg = _group_mass(nets) + _group_mass(loops) + _group_mass(frames)
    checks = []
    for what, groups, spec_kg, src, tol in specs:
        checks.append(_mass_check(what, block_kg if groups is None else _group_mass(groups), spec_kg, src, tol))
    zd12_unit = 6.01 if alias != "ПГПЗ" else 5.99
    checks.append(_mass_check(f"Закладные ЗД12 ×{len(plates)} (пластины + анкеры)", _group_mass([zd12]) + 4.71 * len(plates), len(plates) * zd12_unit,
                              "спецификация (6,01 кг на деталь, лист 86)", 0.05))
    vol = entry.get("projectVolume")
    issues = [PGP_ISSUE_VOLUME] if alias in ("ПГП1", "ПГП1н") else []
    pending = []
    if alias in ("ПГП1", "ПГП1н"):
        pending.append({"id": "volume-mismatch", "kind": "source-conflict", "sourcePages": [95, 97],
                        "description": "Объём контура 4,14 м³ против 4,37 м³ в спецификации (5%), при том что габаритный брус 4480 × 3130 × 300 — 4,21 м³: требует подтверждения проектировщика (толщина, размеры или объём в спецификации)."})
    pending.insert(0, {"id": "reinforcement-conventions", "kind": "placement_question", "sourcePages": [93, 94] + spec["sheets"],
                       "description": f"Форма и посадка петель, каркасов и анкеров ЗД12 условны (см. допущения); порядок слоёв сеток на листе не указан. Пересечения арматуры друг с другом и с закладными не проверялись."})
    assumptions = [
        {"id": "plan-view", "text": "План листа дан сверху; модель построена в правой системе координат (x вдоль длины плиты, y вверх, z поперёк) так, что вид сверху повторяет чертёж, а не зеркалит его." + (" Лист повёрнут на 90° (длина вдоль x)." if sm.rotate else ""), "affects": ["concrete"]},
        {"id": "outline-snap", "text": "Контур плана снят с вектора листа и округлён до 5 мм; выемки — по размерным цепочкам листа.", "affects": ["concrete"]},
        {"id": "notch-depth", "text": "Глубина выемок снята до дна по контуру листа (180 мм); пластина ЗД12 10 мм лежит за дном выемки, у неглубоких выемок (10 мм, узел Т) — заподлицо с краем плиты.", "affects": ["concrete", "zd12"]},
        {"id": "nets-layout", "text": (f"Сетка 2С 14А500С-200(50)/14А500С-200 3100 × 4450: 16 стержней вдоль 4450 (шаг 200, от кромки 50) и 23 вдоль 3100 (шаг 200, от кромки 25)" if spec["block"] == "abp1"
                                       else "Сетка 2С 18А500С-100(130)/18А500С-200 2380 × 6270: 23 стержня вдоль 6270 (шаг 100, от кромки 130) и 32 вдоль 2380 (шаг 200, от кромки 35)")
         + "; какое направление ближе к грани блока, лист не указывает — наружными приняты стержни вдоль большей стороны.", "affects": ["nets"]},
        {"id": "loops-shape", "text": "Петля собрана по развёртке и разрезам листа 85: в плане два полукольца с хвостами 50 и ступенька 2R, по центру ступеньки подъёмная петля ∩, верх на 135 мм выше верхней грани блока. Радиусы гибов в узлах и привязка размерных линий к стержню условны (линии привязаны к оси подъёмной дуги; ось петли вдоль горизонтали листа).", "affects": ["loops"]},
        {"id": "frames-shape", "text": "Каркас (развёртка 530 мм: шесть продольных стержней и поперечные L=530 через 200 мм) сложен ∧ по линии сгиба на высоту блока 230 мм; угол наклона и привязка по высоте условны.", "affects": ["frames"]},
        {"id": "anchors-shape", "text": "Анкеры ЗД12 Ø12 L=365 упрощены: 215 мм в глубь плиты и отгиб 150 мм вдоль пластины без радиуса R30; два анкера по высоте 50 и 250 мм, по длине пластины 50 и 150 мм, направления отгибов — наружу (вид 3-3 листа 86).", "affects": ["zd12"]},
    ]
    return {
        "key": entry["id"], "alias": alias, "sourceId": "doc12", "type": "сплошная плита покрытия с выемками под закладные",
        "parts": [part], "volumeSpec": (vol, f"лист {spec['sheet']}, спецификация: бетон В30, {vol:.2f} м³", False, 0.02) if vol else None,
        "groups": nets + loops + frames + [zd12], "metalParts": plates, "massChecks": checks,
        "readinessDescription": f"Бетонное тело по чертежам; арматурный блок {block_name} и закладные ЗД12 восстановлены по листам {sheet_block} с допущениями (форма петель, каркасов и анкеров условна, масса по каждому виду сверена со спецификацией). Не допуск в производство.",
        "evidence": [
            {"pdfPage": spec["page"], "sheet": spec["sheet"], "subject": f"{alias}: план, размерные цепочки выемок, сечение 1-1, спецификация",
             "checks": ["контур плана снят с вектора листа", "толщина 300", f"число выемок = число закладных ЗД12 по спецификации ({len(plates)})"]},
            {"pdfPage": 92, "sheet": "84", "subject": "Узлы С и Т: глубина выемок и закладная ЗД12", "checks": ["выемка 180 мм (+10 мм закладная), 10 мм у узла Т", "ширина выемки 200 мм"]},
            {"pdfPage": spec["sheets"][0], "sheet": str(spec["sheets"][0] - 8), "subject": f"Арматурный блок {block_name}: {block_desc}", "checks": ["составы и массы по спецификации блока"]},
        ],
        "assumptions": assumptions, "issues": issues, "pending": pending,
    }


def build_pgp_family(skip):
    catalog = json.loads((CATALOG_DIR / "promka-models.json").read_text())
    catalog.update(json.loads((CATALOG_DIR / "promka-register.json").read_text()))
    return [build_pgp(entry) for key, entry in catalog.items()
            if entry.get("alias") in PGP_SPECS and entry["source"]["id"] == "doc12" and key not in skip]



PSHL_PAGES = {"ПШЛ1": 102, "ПШЛ2": 104, "ПШЛ3": 106, "ПШЛ4": 108, "ПШЛ5": 110, "ПШЛ6": 112, "ПШЛ7": 114}


PSHL_LOOPS = {"ПГ3": dict(d=14, R=40.0, L=1630, kg=1.97), "ПГ4": dict(d=16, R=40.0, L=1630, kg=2.57), "ПГ5": dict(d=18, R=50.0, L=1965, kg=3.93)}


def _loop_corners(U, V, du, dv):
    return [(du, dv), (U - du, dv), (du, V - dv), (U - du, V - dv)]


# арматурные блоки АБ ПШЛ1…7 (листы 92, 94, 96, 98, 100, 102, 104 проекта = PDF 103, 105, 107, 109, 111, 113, 115):
# размеры блока U × V (по горизонтали и вертикали листа), масса сетки 2С (одной) и всего блока, тип петель и привязка, линии каркасов ПК1
PSHL_BLOCKS = {
    "ПШЛ1": dict(sheet_pdf=103, U=2870, V=3070, net_kg=81.65, block_kg=209.44, loop="ПГ5", loops=_loop_corners(2870, 3070, 710, 760), frames=[285 + 500 * k for k in range(6)]),
    "ПШЛ2": dict(sheet_pdf=105, U=3020, V=2070, net_kg=58.90, block_kg=145.96, loop="ПГ3", loops=_loop_corners(3020, 2070, 745, 510), frames=[285 + 500 * k for k in range(4)]),
    "ПШЛ3": dict(sheet_pdf=107, U=3070, V=1870, net_kg=53.82, block_kg=130.73, loop="ПГ3", loops=_loop_corners(3070, 1870, 745, 510), frames=[435 + 500 * k for k in range(3)]),
    "ПШЛ4": dict(sheet_pdf=109, U=3070, V=1850, net_kg=53.54, block_kg=130.17, loop="ПГ3", loops=_loop_corners(3070, 1850, 745, 510), frames=[425 + 500 * k for k in range(3)]),
    "ПШЛ5": dict(sheet_pdf=111, U=3070, V=2050, net_kg=59.10, block_kg=146.36, loop="ПГ3", loops=_loop_corners(3070, 2050, 745, 510), frames=[275 + 500 * k for k in range(4)]),
    "ПШЛ6": dict(sheet_pdf=113, U=2850, V=3070, net_kg=81.37, block_kg=203.44, loop="ПГ4", loops=_loop_corners(2850, 3070, 710, 760), frames=[285 + 500 * k for k in range(6)]),
    "ПШЛ7": dict(sheet_pdf=115, U=1870, V=3070, net_kg=53.82, block_kg=145.94, loop="ПГ3", loops=[(510, 760), (1360, 760), (510, 2310), (1360, 2310)], frames=[285 + 500 * k for k in range(6)]),
}


def build_pshl(entry, sketch):
    """Плита перекрытия шахты лифта (ПШЛ1…7): толщина 200, контур с восемью выемками и сквозные прямоугольные отверстия — с вектора листа
    (план дан видом из шахты лифта, то есть снизу). Армирование и закладные МН5 не включены."""
    alias = entry["alias"]
    page = PSHL_PAGES[alias]
    length, thickness, width = sketch["dimensions"]
    region = (60, 50, 520, 520)
    for min_w, tol in ((1.0, 0.4), (0.8, 0.4), (0.8, 1.5)):       # толщина линии контура на листах 1,08 или 0,84; на части листов стыки штрихов разведены до 1 pt
        try:
            plan, scale, plate_h = read_plan_outline("doc13", page, region, length, min_width=min_w, tol=tol)
        except ValueError:
            continue
        if abs(plate_h - width) <= 15:
            break
    else:
        raise SystemExit(f"{alias}: контур плана не прочитан (высота по эскизу каталога {width:g})")
    chains = sheet_chains("doc13", page, region, min_width=min_w)
    group = max(connected_groups(chains), key=lambda g: max(p.x for c in g for p in c) - min(p.x for c in g for p in c))
    pts = [p for c in group for p in c]
    holes = read_plan_holes("doc13", page, region, (min(p.x for p in pts), max(p.y for p in pts)), scale)
    holes = [(x, y, w, h) for x, y, w, h in holes if -5 <= x and x + w <= length + 5 and -5 <= y and y + h <= width + 5]
    plan_poly = Polygon(plan)
    for x, z, w, h in holes:                       # отверстие у самой кромки превращается в вырез контура — difference учитывает это
        plan_poly = plan_poly.difference(box(x, z, x + w, z + h))
    if not isinstance(plan_poly, Polygon):
        raise SystemExit(f"{alias}: плита распалась на части после вычитания отверстий")
    sizes = sorted({f"{int(w)}×{int(h)}" for _, _, w, h in holes})
    part = plan_extrusion(f"Бетон {alias}: плита {length:g} × {width:g} × 200, {len(plate_pockets(plan))} выемок, {len(holes)} сквозных отверстий", plan_poly, 200, [page, 121])
    spec = entry.get("projectVolume")
    blk = PSHL_BLOCKS[alias]
    sm = SheetMap(length, width, identity=True)
    U, V = blk["U"], blk["V"]
    top_y = 200 - 35.0                                # блок 130 мм между защитными слоями 35 мм при толщине плиты 200
    pos = lambda start: [start + 200.0 * k for k in range(int((V - 70.0) // 200) + 1)]
    nets = abp_nets(sm, U, V, 12, [35 + 200 * k for k in range(int((V - 70.0) // 200) + 1)], [35 + 200 * k for k in range(int((U - 70.0) // 200) + 1)], "net",
                    blk["sheet_pdf"], f"Сетка 2С 12А500С-200 {V / 10:g}×{U / 10:g}", top_y=top_y)
    loop = PSHL_LOOPS[blk["loop"]]
    loops = abp_loops(sm, loop["d"], loop["R"], blk["loops"], 12, ident="loops", name=f"Петля {blk['loop']} Ø{loop['d']} А240 L={loop['L']} (поз. 2, ×{len(blk['loops'])})",
                      designation=blk["loop"], sheet="108", pages=[119, blk["sheet_pdf"]], eye_height=240.0, target_len=loop["L"], tail=60.0)
    frames = pk1_frames(sm, U, V, blk["frames"], top_y, 12, name=f"Поддерживающий каркас ПК1 Ø8 А500С (поз. 3, ×{len(blk['frames'])})", pages=[117, blk["sheet_pdf"]])
    mn5, plates = mn5_embedded(sm, plan)
    block_kg = _group_mass(nets) + _group_mass(loops) + _group_mass(frames)
    checks = [
        _mass_check(f"Арматурный блок АБ {alias} (сетки + петли + каркасы)", block_kg, blk["block_kg"], f"лист {blk['sheet_pdf'] - 11}, спецификация блока", 0.08),
        _mass_check("Сетки 2С ×2", _group_mass(nets), 2 * blk["net_kg"], f"лист {blk['sheet_pdf'] - 11}, поз. 1", 0.08),
        _mass_check(f"Петли {blk['loop']} ×{len(blk['loops'])}", _group_mass(loops), len(blk["loops"]) * loop["kg"], f"лист {blk['sheet_pdf'] - 11}, поз. 2 (лист 108)", 0.06),
        _mass_check(f"Каркасы ПК1 ×{len(blk['frames'])}", _group_mass(frames), len(blk["frames"]) * 5.07, f"лист {blk['sheet_pdf'] - 11}, поз. 3 (лист 106: 5,07 кг)", 0.12),
        _mass_check(f"Закладные МН5 ×{len(plates)} (пластины + анкеры)", _group_mass([mn5]) + 1.57 * len(plates), 2.17 * len(plates), "лист 109: 2,17 кг на деталь", 0.05),
    ]
    return {
        "key": entry["id"], "alias": alias, "sourceId": "doc13", "type": "сплошная плита шахты лифта с отверстиями",
        "groups": nets + loops + frames + [mn5], "metalParts": plates, "massChecks": checks,
        "readinessDescription": f"Бетонное тело по чертежам; арматурный блок АБ {alias} (сетки 2С Ø12, петли {blk['loop']}, каркасы ПК1) и закладные МН5 восстановлены по листам 92–110 с допущениями (форма петель, каркасов и анкеров условна, масса видов сверена со спецификацией). Не допуск в производство.",
        "parts": [part], "volumeSpec": (spec, f"лист {page - 11}, спецификация: бетон В25, {spec:.2f} м³", False, 0.02) if spec else None,
        "evidence": [
            {"pdfPage": page, "sheet": str(page - 11), "subject": f"{alias}: план {length:g} × {width:g}, выемки, отверстия, спецификация",
             "checks": ["контур плана снят с вектора листа", "толщина 200", f"{len(holes)} сквозных отверстий (размеры {', '.join(sizes)})"]},
            {"pdfPage": 121, "sheet": "110", "subject": "Узел Е: выемка 200 × 110(90) с закладной МН5", "checks": ["глубина выемок по плану 120 мм = 110 + 10 мм закладная"]},
        ],
        "assumptions": [
            {"id": "hole-positions", "text": "Положение и размеры сквозных отверстий сняты с вектора листа (±1 мм, размеры округлены до 5 мм); размерные цепочки листа с положением отверстий построчно не сверялись.", "affects": ["concrete"]},
            {"id": "notch-depth", "text": "Выемки по контуру — 120 мм (контур листа, округление до 5 мм); в узле Е это 110 мм + закладная МН5 10 мм.", "affects": ["concrete"]},
            {"id": "plan-view", "text": "План дан видом из шахты лифта, то есть снизу (примечание листа). Модель построена так, что при взгляде на низ плиты (y = 0) «вверх по плану» совпадает с +z — вид повторяет чертёж, а не зеркалит его.", "affects": ["concrete"]},
            {"id": "nets-layout", "text": "Сетки 2С 12А500С-200: стержни Ø12 в обоих направлениях с шагом 200 мм от кромки 35 мм (число стержней по размеру сетки листа блока); нижняя и верхняя сетки — по два слоя, наружными приняты стержни вдоль большей стороны.", "affects": ["nets"]},
            {"id": "loops-shape", "text": "Петли ПГ3/ПГ4/ПГ5 (лист 108): в плане два полукольца с хвостами 60 мм и подъёмная петля ∩ высотой 240 мм; вылет ветвей подобран так, чтобы длина стержня равнялась спецификации (радиусы гибов и ступеньки плановой развёртки условны). Привязка 710/745/510/760 мм листа блока отнесена к оси подъёмной петли.", "affects": ["loops"]},
            {"id": "frames-shape", "text": "Каркас ПК1 (лист 106): ∧ высотой 180 мм и основанием 200 мм, по два продольных Ø8 на ветвь и 11 поперечных; линии — через 500 мм по размерам листа блока; длина 2020 мм, но не больше ширины блока (по центру).", "affects": ["frames"]},
            {"id": "anchors-shape", "text": "Анкеры МН5 Ø12 L=340 упрощены: 200 мм в глубь плиты и отгиб 140 мм вдоль пластины без радиуса; пластина −10×100 по центру толщины плиты.", "affects": ["mn5"]},
        ],
        "pending": [
            {"id": "reinforcement-conventions", "kind": "placement_question", "sourcePages": [page + 1, 117, 119, 120],
             "description": "Форма петель (плановая развёртка, вылет ветвей подобран по длине стержня), каркасов ПК1 и анкеров МН5 условна; положение пластин МН5 по толщине плиты на листе не размерено (принято по центру); пересечения арматуры не проверялись."},
        ],
    }


def build_pshl_family(skip):
    catalog = json.loads((CATALOG_DIR / "promka-models.json").read_text())
    catalog.update(json.loads((CATALOG_DIR / "promka-register.json").read_text()))
    sketches = json.loads((CATALOG_DIR / "promka-sketches.json").read_text())
    return [build_pshl(entry, sketches[key]) for key, entry in catalog.items()
            if entry.get("alias") in PSHL_PAGES and entry["source"]["id"] == "doc13" and key not in skip and key in sketches]


PENDING_VOIDS = {"id": "void-ends", "kind": "placement_question", "sourcePages": [],
                 "description": "Пустоты показаны сквозными (открытыми с обоих торцов): заглушки пустот и усиление торцов бетонными вкладышами на листах проекта не показаны."}
PENDING_WIRES = {
    "udc-1pb": {"id": "prestress-wires", "kind": "missing_source", "sourcePages": [],
                "description": "Напрягаемая проволока Ø5 Вр1400 (шаг пучков 120 мм, три ряда у нижней грани) и строповочные стержни в модель не включены: число проволок задаёт заводской альбом УДС-1ПБ3.02.2020 (doc25, листы 10–14, 28–37) по расчётной нагрузке марки, а в марках проекта нагрузка 24 кПа — вне таблиц альбома (3…16 кПа)."},
    "192-16": {"id": "prestress-wires", "kind": "missing_source", "sourcePages": [],
               "description": "Напрягаемая проволока Вр1400 и строповочные петли не раскрыты: на листе — только марка заводской плиты (192/16-2), самих заводских альбомов 192/16 в комплекте нет. Раскладка проволоки в модель не включена."},
}
HOLLOW_WIRES = {"reg-doc10-bf98ff0aac9a": "udc-1pb", "reg-doc10-45c1079bd7ea": "udc-1pb", "reg-doc11-5eb2ada77a7c": "192-16"}
PENDING_SOLID = {
}


# ───────────────────────── сборка и запись ─────────────────────────

README_LIMIT = ("Индивидуальная 3D-модель бетонного тела плиты по векторным листам КЖИ. Армирование и закладные детали не восстановлены; "
                "модель не меняет проектный объём, массу и калькуляцию.")


def assemble(m, captured_at):
    parts = m["parts"]
    checks = ([_volume_check(parts, m["volumeSpec"][0], m["volumeSpec"][1], approximate=m["volumeSpec"][2], **({"tolerance": m["volumeSpec"][3]} if len(m["volumeSpec"]) > 3 else {}))]
              if m.get("volumeSpec") else [{"check": "volume-vs-spec", "result": "note", "detail": "объёма в таблице листа нет: проверка по объёму не выполнялась; объём модели %.4f м³" % (sum(part_volume(p) for p in parts) / 1e9)}]) \
        + _structure_checks(parts) + m.get("massChecks", [])
    pages = [ev["pdfPage"] for ev in m["evidence"] if "source" not in ev]
    hollow = m.get("hollow") or HOLLOW_WIRES.get(m["key"])
    pending = ([dict(PENDING_WIRES[hollow], sourcePages=pages), dict(PENDING_VOIDS, sourcePages=pages)] if hollow else []) \
        + [dict(p) for p in PENDING_SOLID.get(m["key"], [])] + [dict(p) for p in m.get("pending", [])]
    solid = {
        "id": m["key"], "sourceId": m["sourceId"], "alias": m["alias"], "supplyId": SUPPLY_ID,
        "format": "project-solids-mm-v1", "status": "partial", "modelType": "slab", "slabType": m["type"],
        "concreteParts": parts, "metalParts": m.get("metalParts", []), "groups": m.get("groups", []), "bounds": _bounds_of(parts),
        "coordinateSystem": "мм; x — вдоль плиты, y — вверх (толщина), z — поперёк (ширина)",
        "coordinateOrigin": "x = 0 — торец плиты, y = 0 — низ плиты, z = 0 — левая кромка сечения (многопустотные) или нижний край плана (ПШЛ1) / верхний край плана (ПГП1)",
        "evidence": m["evidence"], "pending": pending, "assumptions": m["assumptions"], "issues": m.get("issues", []),
        "notes": [README_LIMIT, "Объём модели сверен с объёмом спецификации листа (см. протокол проверки)."],
        "readinessDescription": m.get("readinessDescription", "Бетонное тело плиты восстановлено по чертежам; армирование и закладные детали в модель не включены. Это не допуск в производство."),
        "supersedesSketch": True,
    }
    qa = {"alias": m["alias"], "status": "partial", "checks": checks,
          "counts": {"concreteParts": len(parts), "metalParts": len(solid["metalParts"]), "groups": len(solid["groups"]), "checks": len(checks),
                     "warnings": sum(c["result"] == "warn" for c in checks), "failures": sum(c["result"] == "fail" for c in checks)}}
    return solid, qa


def build_all():
    outline, voids, _, _ = read_section(**DOC10_SECTION_1_1)
    full_1pb = section_polygon(outline, voids)
    pl_outline, pl_voids, _, _ = read_section(**DOC11_SECTION_3_3)
    catalog = json.loads((CATALOG_DIR / "promka-register.json").read_text())
    pgp1 = next(e for e in catalog.values() if e.get("alias") == "ПГП1")
    sketches = json.loads((CATALOG_DIR / "promka-sketches.json").read_text())
    pshl1 = next((k, e) for k, e in catalog.items() if e.get("alias") == "ПШЛ1")
    five = [build_4pd1(full_1pb), build_4pi18(full_1pb), build_pl41((pl_outline, pl_voids)), build_pgp(pgp1), build_pshl(pshl1[1], sketches[pshl1[0]])]
    skip = {m["key"] for m in five}
    return five + build_family(full_1pb, skip) + build_pgp_family(skip) + build_pshl_family(skip) + build_pl_family(skip) + build_factory_family(full_1pb, pl_profiles(), skip)


def report_text(models, qas):
    lines = ["# Плиты перекрытия — 3D-модели бетонного тела (%s)" % SNAPSHOT, "",
             "Пять разных исполнений разобраны отдельно (4Пд-1, 4ПИ-18, Пл4.1, ПГП1 с арматурой, ПШЛ1); остальные плиты семейства УДС-1ПБ — "
             "4Пд-2…41 и 4ПИ-1…22 — собраны тем же кодом из общего профиля 1ПБ (длина, ширина и форма торца по эскизам каталога); плиты подъёмников "
             "ПГП1н, ПГП2, ПГП2н, ПГПЗ — с арматурным блоком и закладными ЗД12, плиты шахт лифтов ПШЛ1…7 — бетон с выемками и отверстиями, арматурный блок и закладные МН5 (контуры и отверстия сняты с векторных листов).", "",
             "Контуры сняты с векторных листов КЖИ (`scripts/build_calc_slab_models.py`); объём каждой модели сверен с объёмом таблицы листа.", ""]
    checked = [(m, next(c for c in qa["checks"] if c["check"] == "volume-vs-spec")) for m, qa in zip(models, qas)]
    for m, vol in checked:
        if m["alias"] in ("4Пд-1", "4ПИ-18", "Пл4.1", "ПГП1", "ПШЛ1"):
            lines.append("* **%s** — %s: %s" % (m["alias"], m["type"], vol["detail"]))
    family = [(m, v) for m, v in checked if m.get("hollow") == "udc-1pb" and m["alias"] not in ("4Пд-1", "4ПИ-18")]
    deviations = [abs(v["deviationPercent"]) for _, v in family if "deviationPercent" in v]
    lines += ["", "Семейство 1ПБ: %d моделей, объём сошёлся с таблицей листа у %d из них (допуск 3%%), наибольшее расхождение %.1f%%; "
              "у %s в таблице листа нет объёма." % (len(family), len(deviations), max(deviations), ", ".join(m["alias"] for m, v in family if "deviationPercent" not in v)),
              "", "Не включено: напрягаемая проволока 4Пд/4ПИ/Пл (для 4Пд/4ПИ нагрузка 24 кПа вне таблиц альбома УДС-1ПБ, для Пл альбомов нет).",
              "Замечания: на листе сечений 1ПБ высота подписана «3000» — принято 300 мм; у 4Пд-34 в эскизе каталога ширина 8500 мм — принято 850 мм; "
              "по ПГП1 объём контура (4,14 м³) на 5% меньше спецификации (4,37 м³)."]
    return "\n".join(lines)


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="дописать модели в promka-solid-models.json и promka-solid-supplies.json")
    ap.add_argument("--assets", help="каталог с promka-*.json вместо data/calc/assets (для временного стенда); копии при этом не снимаются")
    args = ap.parse_args()
    global ASSETS
    if args.assets:
        ASSETS = Path(args.assets)
    captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    models = build_all()
    solids, qas = zip(*[assemble(m, captured_at) for m in models])
    print("Проверка моделей:")
    for solid, qa in zip(solids, qas):
        print("  %-7s частей %d, границы %s" % (solid["alias"], len(solid["concreteParts"]), solid["bounds"]))
        for c in qa["checks"]:
            print("     [%s] %s" % (c["result"], c["detail"]))
    failures = sum(q["counts"]["failures"] for q in qas)
    if failures:
        raise SystemExit("есть ошибки проверки — запись отменена")
    if not args.write:
        print("\nЗапись не выполнялась (нет --write).")
        return
    solid_path, supply_path = ASSETS / "promka-solid-models.json", ASSETS / "promka-solid-supplies.json"
    solid_all, supplies = json.loads(solid_path.read_text()), json.loads(supply_path.read_text())
    if not args.assets:
        BACKUPS.mkdir(exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        for path in (solid_path, supply_path):
            shutil.copy2(path, BACKUPS / f"{path.stem}.before-slabs-{stamp}.json")
    for key in [k for k, v in solid_all.items() if v.get("supplyId") == SUPPLY_ID]:
        del solid_all[key]
    models_blob = {s["id"]: s for s in solids}
    for solid in solids:
        solid_all[solid["id"]] = solid
    sha = hashlib.sha256(dump(models_blob).encode()).hexdigest()
    supplies[SUPPLY_ID] = {
        "label": "Claude · плиты перекрытия", "snapshot": SNAPSHOT, "modelsSha256": sha, "modelCount": len(solids),
        "capturedAt": captured_at,
        "qa": {"modelsSha256": sha, "tool": "scripts/build_calc_slab_models.py",
               "covers": ["объём бетонного тела против объёма спецификации листа", "корректность сечений и замкнутость мешей",
                          "габариты частей против подписанных размеров"],
               "doesNotCover": ["арматура и закладные детали (не включены)", "сверка положения отверстий ПШЛ1 по размерным цепочкам",
                                "допуск в производство"],
               "models": {s["id"]: q for s, q in zip(solids, qas)}},
        "report": report_text(models, qas),
    }
    # сначала поставка, потом модели: каталог читает их на живом сервере, и модель без своей поставки уронила бы запрос
    for path, payload in ((supply_path, supplies), (solid_path, solid_all)):
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(dump(payload))
        os.replace(tmp, path)
    print("\nЗаписано: %d моделей, снимок %s, sha256 %s…; копии — %s" % (len(solids), SNAPSHOT, sha[:12], BACKUPS))


if __name__ == "__main__":
    main()

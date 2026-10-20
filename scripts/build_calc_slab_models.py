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
SOURCES = ROOT / "data" / "calc" / "assets" / "sources"      # PDF-альбомы читаются всегда отсюда
ASSETS = ROOT / "data" / "calc" / "assets"                     # куда пишутся модели (--assets меняет)
BACKUPS = ROOT / "data" / "calc" / "backups"
SUPPLY_ID = "claude-slabs"
SNAPSHOT = "20261020-slabs-five"


# ───────────────────────── чтение векторного листа ─────────────────────────

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
                    chains.append([a, b])
            elif it[0] == "c":
                p = [it[1] * m, it[2] * m, it[3] * m, it[4] * m]
                chains.append([p[0]] + _bezier(*p))
            elif it[0] in ("re", "qu"):
                r = it[1]
                if it[0] == "re":
                    q = [fitz.Point(r.x0, r.y0), fitz.Point(r.x1, r.y0), fitz.Point(r.x1, r.y1), fitz.Point(r.x0, r.y1), fitz.Point(r.x0, r.y0)]
                else:
                    q = [r.ul, r.ur, r.lr, r.ll, r.ul]
                chains.append([x * m for x in q])
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

# ПГП1, лист 87 (PDF 95): контур плана снят с вектора листа и проверен по размерной цепочке 800-200-700-200-695-200-700-200-785
# (низ), 460-200-930-200-1340 (бок); узлы С и Т (лист 84): выемка слева/снизу 180 мм, справа 10 мм, ширина 200 мм.
PGP1_PLAN = [(0, 0), (800, 0), (800, 180), (1000, 180), (1000, 0), (1700, 0), (1700, 180), (1900, 180), (1900, 0),
             (2595, 0), (2595, 180), (2795, 180), (2795, 0), (3495, 0), (3495, 180), (3695, 180), (3695, 0), (4480, 0),
             (4480, 1340), (4470, 1340), (4470, 1540), (4480, 1540), (4480, 2470), (4470, 2470), (4470, 2670), (4480, 2670),
             (4480, 3130), (0, 3130), (0, 2670), (180, 2670), (180, 2470), (0, 2470), (0, 1540), (180, 1540), (180, 1340), (0, 1340)]

# ПШЛ1, лист 91 (PDF 102): контур 2900 × 3100, восемь выемок 200 × 120 (размерные цепочки 470-200-1560-200-470 и 670-200-1360-200-670)
PSHL1_PLAN = [(0, 0), (470, 0), (470, 120), (670, 120), (670, 0), (2230, 0), (2230, 120), (2430, 120), (2430, 0), (2900, 0),
              (2900, 670), (2780, 670), (2780, 870), (2900, 870), (2900, 2230), (2780, 2230), (2780, 2430), (2900, 2430),
              (2900, 3100), (2430, 3100), (2430, 2980), (2230, 2980), (2230, 3100), (670, 3100), (670, 2980), (470, 2980),
              (470, 3100), (0, 3100), (0, 2430), (120, 2430), (120, 2230), (0, 2230), (0, 870), (120, 870), (120, 670), (0, 670)]
# сквозные отверстия, мм: (x левого края, z нижнего края, ширина, высота) — подписи на листе: 60×100, 200×150, 150×150, 100×150
PSHL1_HOLES = [(200, 2800, 60, 100), (288, 1875, 200, 150), (310, 1444, 150, 150), (711, 1444, 150, 150), (2065, 1444, 200, 150),
               (2320, 1844, 100, 150), (2320, 1595, 100, 150), (2601, 500, 100, 150), (2601, 200, 100, 150)]


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


def build_pgp1():
    """ПГП1: плита покрытия грузового подъёмника 4480 × 3130 × 300, восемь выемок под закладные ЗД12."""
    # План дан видом сверху: в правой системе координат модели (x вправо, y вверх) «вверх по плану» — это −z, поэтому z = 3130 − y плана
    plan = Polygon([(x, 3130 - y) for x, y in PGP1_PLAN])
    part = plan_extrusion("Бетон ПГП1: плита 4480 × 3130 × 300, 8 выемок под закладные", plan, 300, [95, 92])
    return {
        "key": "reg-doc12-3c58dd0aa171", "alias": "ПГП1", "sourceId": "doc12", "type": "сплошная плита покрытия с выемками под закладные",
        "parts": [part], "volumeSpec": (4.37, "лист 87, спецификация: бетон В30, 4,37 м³; масса 10925 кг", False),
        "evidence": [
            {"pdfPage": 95, "sheet": "87", "subject": "ПГП 44,8.31,3.30т-1: план 4480 × 3130, размерные цепочки выемок, сечение 1-1, спецификация",
             "checks": ["контур плана снят с вектора листа и сверен с цепочками размеров", "толщина 300", "бетон В30, 4,37 м³"]},
            {"pdfPage": 92, "sheet": "84", "subject": "Узлы С и Т: глубина выемок и закладная ЗД12",
             "checks": ["выемки слева и снизу 180 мм (+10 мм закладная), справа 10 мм", "ширина выемки 200 мм", "высота закладной 300 мм"]},
        ],
        "assumptions": [
            {"id": "right-recess", "text": "Справа выемки 10 мм (узел Т): на плане вектор даёт ≈8 мм, подпись узла — 10 мм; принято по подписи.", "affects": ["concrete"]},
            {"id": "plan-view", "text": "План листа дан сверху; в модели (правая система x–y–z, y вверх) направление «вверх по плану» совпадает с −z, чтобы вид сверху на модель повторял чертёж, а не зеркалил его.", "affects": ["concrete"]},
            {"id": "notch-bottom", "text": "Глубина выемок снята до внешней грани закладной ЗД12 (контур листа); пластина 10 мм лежит в дне выемки и в модель как отдельная деталь не включена.", "affects": ["concrete"]},
        ],
        "issues": [
            {"id": "volume-mismatch", "kind": "source-conflict", "severity": "warning", "blocksAcceptance": False,
             "title": "Объём по чертежу контура не сходится с объёмом спецификации",
             "description": "Контур плана 4480 × 3130 с выемками × толщина 300 мм даёт 4,14 м³; спецификация листа 87 — 4,37 м³ (масса 10925 кг = 4,37 × 2500). Даже габаритный брус 4480 × 3130 × 300 без выемок — 4,21 м³, то есть меньше 4,37; у ПГП2 и ПГПЗ объём спецификации (4,55) совпадает с брусом 6300 × 2410 × 300 без выемок. Нужна сверка проектировщика: толщина плиты, размеры или объём в спецификации.",
             "sourcePages": [95]},
        ],
    }


def build_pshl1():
    """ПШЛ1: плита перекрытия шахты лифта 2900 × 3100 × 200, восемь выемок по контуру и девять сквозных отверстий."""
    plan = Polygon(PSHL1_PLAN, [[(x, z), (x + w, z), (x + w, z + h), (x, z + h)] for x, z, w, h in PSHL1_HOLES])
    part = plan_extrusion("Бетон ПШЛ1: плита 2900 × 3100 × 200, 8 выемок, 9 сквозных отверстий", plan, 200, [102, 121])
    return {
        "key": "reg-doc13-f50d8a37fe0a", "alias": "ПШЛ1", "sourceId": "doc13", "type": "сплошная плита шахты лифта с отверстиями",
        "parts": [part], "volumeSpec": (1.73, "лист 91, спецификация: бетон В25, 1,73 м³; масса 4325 кг", False),
        "evidence": [
            {"pdfPage": 102, "sheet": "91", "subject": "ПШЛ 29.31.20т-1: план 2900 × 3100, выемки, отверстия, сечение 1-1, спецификация",
             "checks": ["контур плана снят с вектора листа и сверен с цепочками размеров", "толщина 200", "бетон В25, 1,73 м³", "9 отверстий по подписям 60×100, 200×150, 150×150, 100×150"]},
            {"pdfPage": 121, "sheet": "110", "subject": "Узел Е: выемка 200 × 110(90) с закладной МН5",
             "checks": ["глубина выемок по плану 120 мм = 110 + 10 мм закладная"]},
        ],
        "assumptions": [
            {"id": "hole-positions", "text": "Положение девяти сквозных отверстий снято с вектора листа (±1 мм), размеры — по подписям; размерные цепочки листа с положением отверстий построчно не сверялись.", "affects": ["concrete"]},
            {"id": "notch-depth", "text": "Выемки по контуру — 120 мм (контур листа); в узле Е это 110 мм + закладная МН5 10 мм.", "affects": ["concrete"]},
            {"id": "plan-view", "text": "План дан видом из шахты лифта, то есть снизу (примечание листа). Модель построена так, что при взгляде на низ плиты (y = 0) «вверх по плану» совпадает с +z — вид повторяет чертёж, а не зеркалит его.", "affects": ["concrete"]},
        ],
    }


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
    "reg-doc12-3c58dd0aa171": [
        {"id": "embedded-zd12", "kind": "missing_geometry", "sourcePages": [95, 92, 94],
         "description": "Закладные детали ЗД12 ×8 (пластина −10×300, L=200 и четыре анкера Ø12 А500С L=365 с отгибами 150) в узлах С и Т: в модель не включены."},
        {"id": "reinforcement-block", "kind": "missing_geometry", "sourcePages": [96],
         "description": "Арматурный блок АБП1 (две сетки 14А500С-200 в два слоя по 4450 × 3100, шесть петель Пп3, каркасы-фиксаторы Пф1, высота блока 230 мм, защитный слой 35 мм; масса 444,61 кг): не восстановлен."},
        {"id": "volume-mismatch", "kind": "source-conflict", "sourcePages": [95],
         "description": "Объём контура 4,14 м³ против 4,37 м³ в спецификации (5%), при том что габаритный брус 4480 × 3130 × 300 — 4,21 м³: требует подтверждения проектировщика (толщина, размеры или объём в спецификации)."},
    ],
    "reg-doc13-f50d8a37fe0a": [
        {"id": "embedded-mn5", "kind": "missing_geometry", "sourcePages": [102, 120, 121],
         "description": "Закладные МН5 ×8 (полоса −10×100, L=200 и два анкера Ø12 А500С L=340) в восьми выемках: положение по толщине плиты на листе не размерено, в модель не включены."},
        {"id": "reinforcement-block", "kind": "missing_geometry", "sourcePages": [103],
         "description": "Арматурный блок АБ ПШЛ1 (Ø18 А240, Ø8 и Ø12 А500С; масса 209,44 кг; высота блока 130 мм, защитный слой 35 мм): не восстановлен."},
    ],
}


# ───────────────────────── сборка и запись ─────────────────────────

README_LIMIT = ("Индивидуальная 3D-модель бетонного тела плиты по векторным листам КЖИ. Армирование и закладные детали не восстановлены; "
                "модель не меняет проектный объём, массу и калькуляцию.")


def assemble(m, captured_at):
    parts = m["parts"]
    checks = [_volume_check(parts, m["volumeSpec"][0], m["volumeSpec"][1], approximate=m["volumeSpec"][2])] + _structure_checks(parts)
    pages = [ev["pdfPage"] for ev in m["evidence"] if "source" not in ev]
    pending = ([dict(PENDING_WIRES[HOLLOW_WIRES[m["key"]]], sourcePages=pages), dict(PENDING_VOIDS, sourcePages=pages)] if m["key"] in HOLLOW_WIRES else []) \
        + [dict(p) for p in PENDING_SOLID.get(m["key"], [])]
    solid = {
        "id": m["key"], "sourceId": m["sourceId"], "alias": m["alias"], "supplyId": SUPPLY_ID,
        "format": "project-solids-mm-v1", "status": "partial", "modelType": "slab", "slabType": m["type"],
        "concreteParts": parts, "metalParts": [], "groups": [], "bounds": _bounds_of(parts),
        "coordinateSystem": "мм; x — вдоль плиты, y — вверх (толщина), z — поперёк (ширина)",
        "coordinateOrigin": "x = 0 — торец плиты, y = 0 — низ плиты, z = 0 — левая кромка сечения (многопустотные) или нижний край плана (ПШЛ1) / верхний край плана (ПГП1)",
        "evidence": m["evidence"], "pending": pending, "assumptions": m["assumptions"], "issues": m.get("issues", []),
        "notes": [README_LIMIT, "Объём модели сверен с объёмом спецификации листа (см. протокол проверки)."],
        "readinessDescription": "Бетонное тело плиты восстановлено по чертежам; армирование и закладные детали в модель не включены. Это не допуск в производство.",
        "supersedesSketch": True,
    }
    qa = {"alias": m["alias"], "status": "partial", "checks": checks,
          "counts": {"concreteParts": len(parts), "metalParts": 0, "groups": 0, "checks": len(checks),
                     "warnings": sum(c["result"] == "warn" for c in checks), "failures": sum(c["result"] == "fail" for c in checks)}}
    return solid, qa


def build_all():
    outline, voids, _, _ = read_section(**DOC10_SECTION_1_1)
    full_1pb = section_polygon(outline, voids)
    pl_outline, pl_voids, _, _ = read_section(**DOC11_SECTION_3_3)
    return [build_4pd1(full_1pb), build_4pi18(full_1pb), build_pl41((pl_outline, pl_voids)), build_pgp1(), build_pshl1()]


def report_text(models, qas):
    lines = ["# Пять плит перекрытия — 3D-модели бетонного тела (%s)" % SNAPSHOT, "",
             "Подобраны пять разных конструктивных исполнений: узкая многопустотная полоса (4Пд-1), многопустотная со срезанным углом "
             "(4ПИ-18), многопустотная с угловыми вырезами (Пл4.1), сплошная плита подъёмника с выемками под закладные (ПГП1) и "
             "сплошная плита шахты лифта с девятью сквозными отверстиями (ПШЛ1).", "",
             "Контуры сняты с векторных листов КЖИ кодом (`scripts/build_calc_slab_models.py`); объём каждой модели сверен с объёмом спецификации.", ""]
    for m, qa in zip(models, qas):
        vol = next(c for c in qa["checks"] if c["check"] == "volume-vs-spec")
        lines.append("* **%s** — %s: %s" % (m["alias"], m["type"], vol["detail"]))
    lines += ["", "Не включено: напрягаемая проволока плит 4Пд/4ПИ/Пл (число проволок по заводским альбомам: для 4Пд/4ПИ нагрузка 24 кПа вне таблиц УДС-1ПБ, для Пл альбомов нет), арматурные блоки и закладные детали ПГП1 и ПШЛ1.",
              "Замечание: на листе сечений 1ПБ высота подписана «3000» — по масштабу сечения и объёму принято 300 мм; "
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
        "label": "Claude · плиты перекрытия (пять типов)", "snapshot": SNAPSHOT, "modelsSha256": sha, "modelCount": len(solids),
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

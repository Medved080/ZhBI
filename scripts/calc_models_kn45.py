#!/usr/bin/env python3
"""Калькулятор: индивидуальные 3D-модели колонн Кн4.5 и Кн4.6 (doc05, листы 145–148 и закладные 313/314/316 КЖ.И1), 2026-10-20.

Колонны Кн4.5 и Кн4.6 — те же 500 × 400 × 8540 с тем же каркасом КПн4 (лист 12), что и у базовой Кн4 (лист 10). Отличаются закладными деталями и
трубой Ø68 (на листах 145/147 — стенка 1 мм, у Кн4 — 5 мм). Поэтому модель строится копией модели Кн4 из promka-solid-models.json (бетон с каналами, группы
арматуры main-1, SN, KK, SV, supplement, spiral, loops, трубы) с заменой ссылок на листы, трубы Ø68×1 и добавлением закладных деталей:

  Кн4.5 (лист 145, разрезы 146):   ЗД7.1 ×8 (поз. 4) и ЗД11 ×2 (поз. 5) — сквозные: две пластины на лицевой и тыльной гранях и анкеры Ø14 L=400 между ними
  Кн4.6 (лист 147, разрезы 148):   ЗД7.1 ×6, ЗД7.2н ×1 (сквозные), ЗД26 (лицевая грань, анкеры L=385 с концевыми пластинами), ЗД13 (то же, 9 анкеров),
                                   ЗД27 и ЗД14 (правая грань, вид А; анкеры Ø14 L=485 поперёк колонны)

Геометрия закладных — с листов 313 (ЗД7.1, ЗД7.2н, ЗД11), 314 (ЗД13, ЗД14), 316 (ЗД26, ЗД27) комплекта 77/113/114-Р-КЖ.И1 (PDF-страница = лист + 13): размеры
пластин и анкеров — по размерным цепочкам листов; высотные положения и стороны — по размерным цепочкам «Вида» и «Вида А» листов 145/147 (проверка — по вектору
листа, см. `_position_check`). Закладные одноимённых марок из чужих комплектов (doc01, 3КН…) НЕ переиспользованы: у них другие размеры (например ЗД11 из doc01 —
пластина 250 × 250 с четырьмя анкерами, а ЗД11 из doc05 — 320 × 250 с шестью, масса 17,96 кг).

Система координат та же, что у Кн4: x — вдоль колонны (0 — низ, 8540 — верх), y — слева направо на «Виде» (0…500), z — вглубь от лицевой грани «Вида» (0…400);
лицевая грань (z = 0) на «Виде А» — слева. Правая грань «Вида» (y = 500) — грань «Вида А».

Использование:

    import calc_models_kn45 as m
    pairs = m.build({e["alias"]: e for e in json.load(open("data/calc/assets/promka-register.json")).values()})   # [(solid, qa), …]

Протокол проверки каждой колонны (`qa.checks`): объём бетона против 1,61 м³; сечения; масса каждого вида закладных против спецификаций листов 313/314/316 и ведомости
расхода стали; сходимость состава закладных с ведомостью; масса труб; масса арматуры по диаметрам (с объяснением расхождений, унаследованных от Кн4); число и положение
закладных на «Виде» и «Виде А» по вектору листов 145/147; расположение закладных внутри бетона; пересечения анкеров между собой, с рабочими стержнями, трубами и петлями;
контакты с сетками (по примечанию 2 листа сетки обрезаются по месту).

Модуль ничего не пишет: только читает promka-solid-models.json (базовая Кн4), PDF doc05 (проверка положений по вектору листа) и записи реестра.
"""
import copy
import json
import math
import sys
from pathlib import Path

import fitz
from shapely.geometry import Point, Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab  # noqa: E402  — общие проверки моделей (объём, масса)

BASE_ALIAS = "Кн4"
STEEL_KG_PER_M3 = 7850.0
WIDTH_Y, WIDTH_Z = 500.0, 400.0                  # длина колонны 8540 (x), ширина по «Виду» 500 (y), по «Виду А» 400 (z)
PLATE_T = 12.0                                  # толщина пластин всех закладных, мм (прокат −12)
ANCHOR_D = 14                                   # анкеры закладных Ø14 А500С
ANCHOR_R = ANCHOR_D / 2.0
ZD_SHEETS = {"ЗД7.1": (313, 326), "ЗД7.2н": (313, 326), "ЗД11": (313, 326), "ЗД13": (314, 327), "ЗД14": (314, 327), "ЗД26": (316, 329), "ЗД27": (316, 329)}


# ───────────────────────── закладные детали: листы 313 / 314 / 316 ─────────────────────────

# w — размер пластины по горизонтали вида, h — по вертикали (вдоль колонны); cols — положение анкеров по горизонтали от левого края пластины, rows — от верха пластины;
# anchor — длина анкера Ø14; through — две пластины на противоположных гранях (анкеры от грани до грани), иначе одна пластина; end — концевые пластины 12 × 50 × 50.
# spec — по спецификации листа: масса изделия, кг; (число, кг) пластин, анкеров и концевых пластин.
ZD_SPECS = {
    "ЗД7.1": dict(w=250, h=250, cols=[60, 190], rows=[50, 200], anchor=400, through=True, end=False, total=13.70,
                  plate=(2, 5.89), rod=(4, 0.48), endp=(0, 0.0), note="Прокат 12×250 L=250 ×2, Ø14 L=400 ×4; пластина 250×250, анкеры 60/130/60 и 50/150/50"),
    "ЗД7.2н": dict(w=250, h=250, cols=[60, 190], rows=[50, 200], anchor=400, through=True, end=False, total=13.70,
                   plate=(2, 5.89), rod=(4, 0.48), endp=(0, 0.0), bore=dict(d=50, col=20, row=155), note="как ЗД7.1, в обеих пластинах отверстие Ø50 (20 от левой кромки, 155 от верха)"),
    "ЗД11": dict(w=320, h=250, cols=[50, 160, 270], rows=[50, 200], anchor=400, through=True, end=False, total=17.96,
                 plate=(2, 7.54), rod=(6, 0.48), endp=(0, 0.0), note="Прокат 12×320 L=250 ×2, Ø14 L=400 ×6; пластина 320×250, анкеры 50/110/110/50 и 50/150/50"),
    "ЗД26": dict(w=500, h=250, cols=[100, 250, 400], rows=[50, 200], anchor=385, through=False, end=True, total=16.04,
                 plate=(1, 11.78), rod=(6, 0.47), endp=(6, 0.24), note="Прокат 12×500 L=250, Ø14 L=385 ×6, концевые 12×50 L=50 ×6; анкеры 100/150/150/100 и 50/150/50"),
    "ЗД13": dict(w=500, h=375, cols=[100, 250, 400], rows=[50, 190, 325], anchor=385, through=False, end=True, total=24.05,
                 plate=(1, 17.66), rod=(9, 0.47), endp=(9, 0.24), note="Прокат 12×500 L=375, Ø14 L=385 ×9, концевые 12×50 L=50 ×9; анкеры 100/150/150/100 и 50/140/135/50"),
    "ЗД27": dict(w=250, h=445, cols=[80, 170], rows=[50, 225, 395], anchor=485, through=False, end=False, total=14.02,
                 plate=(1, 10.48), rod=(6, 0.59), endp=(0, 0.0), note="Прокат 12×250 L=445, Ø14 L=485 ×6; анкеры 80/90/80 и 50/175/170/50"),
    "ЗД14": dict(w=250, h=400, cols=[90, 160], rows=[50, 200, 350], anchor=485, through=False, end=False, total=12.96,
                 plate=(1, 9.42), rod=(6, 0.59), endp=(0, 0.0), note="Прокат 12×250 L=400, Ø14 L=485 ×6; анкеры 90/70/90 и 50/150/150/50"),
}

# Размещение. face: "through" — две пластины (z = 0 и z = 400), "F" — лицевая грань «Вида» (z = 0), "R" — правая грань (y = 500, «Вид А»).
# x0 — низ пластины от низа колонны, u0 — левый край пластины по горизонтали вида (y на «Виде», z на «Виде А»); pos — номер позиции в спецификации листа.
# Значения — из размерных цепочек: нижние края 1530, 2190 (410 от верха предыдущей), затем +585 через пластину высотой 250, и т. д.
KN45_ZD = [("ЗД7.1", "through", 1530, 80), ("ЗД7.1", "through", 2190, 80), ("ЗД7.1", "through", 3025, 80), ("ЗД7.1", "through", 3860, 80),
           ("ЗД7.1", "through", 4695, 80), ("ЗД7.1", "through", 5530, 80), ("ЗД7.1", "through", 6540, 80), ("ЗД7.1", "through", 7095, 80),
           ("ЗД11", "through", 7655, 80), ("ЗД11", "through", 8290, 80)]
KN46_ZD = [("ЗД7.1", "through", 1530, 80), ("ЗД7.1", "through", 2190, 80), ("ЗД7.1", "through", 3025, 80), ("ЗД7.1", "through", 3860, 80),
           ("ЗД26", "F", 4510, 0), ("ЗД27", "R", 4310, 150), ("ЗД7.1", "through", 5210, 80), ("ЗД7.2н", "through", 5780, 80),
           ("ЗД7.1", "through", 6540, 80), ("ЗД13", "F", 7655, 0), ("ЗД14", "R", 7610, 150)]

# Позиции спецификации листа и страницы источника по колоннам
COLUMNS = {
    "Кн4.5": dict(sheet="145", page=158, sections_sheet="146", sections_page=159, zd=KN45_ZD, positions={"ЗД7.1": 4, "ЗД11": 5},
                  steel=dict(plates=124.40, anchors=21.12, tube68=0.66, tube50=9.99, rebar_o8=84.24, rebar_o25=231.20, rebar_o16=9.28, rebar_o3=1.92, rebar_o18=62.72,
                             embedded_total=145.52, total=545.53),
                  mark="Кн85,4-4.5-39/8.8-4.5", stamp="19.12.25, изм. 1 (Нов. 448-25)"),
    "Кн4.6": dict(sheet="147", page=160, sections_sheet="148", sections_page=161, zd=KN46_ZD,
                  positions={"ЗД7.1": 4, "ЗД7.2н": 5, "ЗД26": 6, "ЗД13": 7, "ЗД27": 8, "ЗД14": 9},
                  steel=dict(plates=135.38, anchors=27.57, tube68=0.66, tube50=9.99, rebar_o8=84.24, rebar_o25=231.20, rebar_o16=9.28, rebar_o3=1.92, rebar_o18=62.72,
                             embedded_total=162.97, total=562.96),
                  mark="Кн85,4-4.5-39/8.8-4.6", stamp="19.12.25, изм. 1 (Нов. 448-25)"),
}
# Колонны с марками 4.5/4.6: общая спецификация бетона, листы каркаса КПн4 и его расшифровки
CONCRETE_SPEC_M3 = 1.61
FRAME_PAGES = {"sheet12": 25, "sn": 134, "kk": 135, "sv": 136, "sk1_loops": 137}


# ───────────────────────── геометрия ─────────────────────────

def bar_kg(diameter, length_mm):
    return math.pi * diameter ** 2 / 4 * length_mm * STEEL_KG_PER_M3 / 1e9


def path_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


def _round(v, nd=3):
    return round(v, nd)


def _hole_area(h):
    return math.pi * h["radius"] ** 2 if h["type"] == "circle" else Polygon(h["points"]).area


def extrusion_area(part):
    return Polygon(part["profile"]).area - sum(_hole_area(h) for h in part.get("holes", []))


def part_volume(part):
    """Объём детали, мм³: выдавливание с круглыми и многоугольными отверстиями или сетка (общая функция slab для сеток)."""
    return extrusion_area(part) * part["depth"] if part["type"] == "extrusion" else slab.mesh_volume(part)


def part_kg(part):
    return part_volume(part) * STEEL_KG_PER_M3 / 1e9


def _plate_polygon_xy(x0, x1, a0, a1, bore=None):
    """Контур пластины (x — вдоль колонны, a — по горизонтали вида); круглая вырезка Ø50 у кромки (центр на расстоянии 20 мм от кромки при радиусе 25) делает выем."""
    poly = box(x0, a0, x1, a1)
    if bore:
        poly = poly.difference(Point(*bore["center"]).buffer(bore["radius"], quad_segs=24))
    return poly


def _ring_coords(poly):
    return [[_round(x), _round(y)] for x, y in list(slab.orient(poly, 1.0).exterior.coords)[:-1]]


def make_zd(mark, face, x0, u0, index, position, pages):
    """Одна закладная деталь: (список пластин — деталей metalParts, список стержней-анкеров группы anchors-zd).
    Пластина на гранях z (лицевой и тыльной): профиль в плоскости (x, y); на грани y = 500 («Вид А»): профиль в плоскости (z, x), тройка u × v = направление (правая)."""
    s = ZD_SPECS[mark]
    w, h = s["w"], s["h"]
    instance = f"{mark}#{index}"
    sheet = str(ZD_SHEETS[mark][0])
    rods = [(x0 + h - r, u0 + c) for r in s["rows"] for c in s["cols"]]        # (вдоль колонны от верха пластины, по горизонтали вида слева направо)
    bore = None
    if s.get("bore"):
        bore = dict(center=(x0 + h - s["bore"]["row"], u0 + s["bore"]["col"]), radius=s["bore"]["d"] / 2.0)

    def part(title, rng_face, offset, poly, holes, depth):
        common = {"type": "extrusion", "name": title, "group": "plate", "instance": instance, "mark": mark, "sourcePages": pages, "sheet": sheet, "depth": depth, "holes": holes}
        if rng_face == "z":
            return {**common, "profile": _ring_coords(poly), "origin": [0, 0, offset], "u": [1, 0, 0], "v": [0, 1, 0], "direction": [0, 0, 1], "boreHoles": 1 if bore else 0}
        swapped = Polygon([(a, x) for x, a in poly.exterior.coords[:-1]])
        return {**common, "profile": _ring_coords(swapped), "origin": [0, offset, 0], "u": [0, 0, 1], "v": [1, 0, 0], "direction": [0, 1, 0], "boreHoles": 0}

    def circles(rng_face):
        return [{"type": "circle", "center": [_round(x if rng_face == "z" else a), _round(a if rng_face == "z" else x)], "radius": ANCHOR_R} for x, a in rods]

    faces = {"through": [("z", 0.0, "z=0"), ("z", WIDTH_Z - PLATE_T, f"z={int(WIDTH_Z)}")], "F": [("z", 0.0, "z=0")], "R": [("y", WIDTH_Y - PLATE_T, f"y={int(WIDTH_Y)}")]}[face]
    plates = [part(f"{mark} пластина {w}×{h}×12 (поз. {position}, грань {label})", rng_face, offset, _plate_polygon_xy(x0, x0 + h, u0, u0 + w, bore), circles(rng_face), PLATE_T)
              for rng_face, offset, label in faces]
    anchors = []
    for k, (x, a) in enumerate(rods):
        if face in ("through", "F"):
            points = [[x, a, 0.0], [x, a, float(WIDTH_Z if face == "through" else s["anchor"])]]
        else:
            points = [[x, WIDTH_Y, a], [x, WIDTH_Y - s["anchor"], a]]
        anchors.append({"diameter": ANCHOR_D, "position": f"{instance} анкер {k + 1}", "part": "ЗД анкер", "instance": f"{instance} анкер {k + 1}", "instanceOrigin": points[0],
                        "points": points, "plate": instance, "sheet": sheet})
        if s["end"]:
            # концевая пластина 12 × 50 × 50 на свободном конце анкера: наружная грань на расстоянии L от лицевой, отверстие под анкер
            poly = box(x - 25, a - 25, x + 25, a + 25)
            plates.append({"type": "extrusion", "name": f"{mark} концевая пластина 50×50×12 (поз. {position}, анкер {k + 1})", "group": "plate", "instance": instance, "mark": mark,
                           "sourcePages": pages, "sheet": sheet, "profile": _ring_coords(poly), "origin": [0, 0, s["anchor"] - PLATE_T], "u": [1, 0, 0], "v": [0, 1, 0],
                           "direction": [0, 0, 1], "depth": PLATE_T, "holes": [{"type": "circle", "center": [_round(x), _round(a)], "radius": ANCHOR_R}], "boreHoles": 0})
    return plates, anchors


# ───────────────────────── базовая модель Кн4 ─────────────────────────

def _load_base(assets_dir=None):
    path = Path(assets_dir or slab.CATALOG_DIR) / "promka-solid-models.json"
    for solid in json.loads(path.read_text()).values():
        if solid.get("alias") == BASE_ALIAS and solid.get("format") == "column-solids-mm-v1":
            return solid
    raise KeyError("в promka-solid-models.json нет базовой модели Кн4")


def _retag_pages(pages, old_pages, new_pages):
    out = []
    for p in pages or []:
        for old, new in zip(old_pages, new_pages):
            if p == old:
                p = new
        if p not in out:
            out.append(p)
    return out


def adapt_base(base, cfg):
    """Копия модели Кн4 для Кн4.5/Кн4.6: страницы листов Кн4 (23, 24) заменены на листы колонны, труба Ø68 — стенка 1 мм."""
    solid = copy.deepcopy(base)
    old, new = [23, 24], [cfg["page"], cfg["sections_page"]]
    for g in solid["groups"]:
        g["sourcePages"] = _retag_pages(g.get("sourcePages"), old, new)
        if g["id"] in ("tube68", "tube50"):
            g["sheet"] = cfg["sheet"]
        if g["id"] == "tube68":
            g["name"] = g["detail"] = "Труба 68×1"
        if g["id"] == "supplement":
            g["sourcePages"] = _retag_pages([25, 24], old, new)
    for part in solid["metalParts"]:
        part["sourcePages"] = _retag_pages(part.get("sourcePages"), old, new)
        if part.get("groupId") in ("tube68", "tube50"):
            part["sheet"] = cfg["sheet"]
        if part.get("groupId") == "tube68":
            part["name"] = "Т68×1 L400"
            part["holes"] = [{"type": "circle", "center": [0, 0], "radius": 33}]      # стенка 1 мм: внутренний радиус 33 при наружном 34
    return solid


# ───────────────────────── проверки ─────────────────────────

def _volume_check(parts, spec_m3, source, tolerance=0.02):
    model = sum(part_volume(p) for p in parts) / 1e9
    dev = (model - spec_m3) / spec_m3
    return {"check": "volume-vs-spec", "result": "pass" if abs(dev) <= tolerance else "warn",
            "detail": "объём модели %.4f м³; по спецификации %.4f м³ (%s); расхождение %+.1f%% (допуск ±%.0f%%; модель без каналов под трубы и глухих отверстий Ø50 — как в спецификации бетон брутто)"
                      % (model, spec_m3, source, dev * 100, tolerance * 100),
            "modelM3": round(model, 5), "specM3": spec_m3, "deviationPercent": round(dev * 100, 2), "approximateSpec": False}


def _poly_of(part):
    poly = Polygon(part["profile"])
    holes = []
    for h in part.get("holes", []):
        holes.append(Point(*h["center"]).buffer(h["radius"], quad_segs=24) if h["type"] == "circle" else Polygon(h["points"]))
    return poly, holes


def _structure_checks(concrete, metal):
    """Сечения частей — корректные многоугольники, отверстия целиком внутри профиля и не пересекаются друг с другом."""
    def bad(parts):
        out = []
        for p in parts:
            if p["type"] != "extrusion":
                continue
            poly, holes = _poly_of(p)
            if not poly.is_valid or poly.area <= 0 or any(not poly.contains(h) for h in holes) or any(holes[i].intersects(holes[j]) for i in range(len(holes)) for j in range(i)):
                out.append(p["name"])
        return out
    checks = []
    for label, parts in (("бетона", concrete), ("металлических деталей (пластины, трубы)", metal)):
        invalid = bad(parts)
        checks.append({"check": "valid-section-polygons", "result": "fail" if invalid else "pass",
                       "detail": f"сечения {label} — корректные многоугольники, отверстия внутри профиля ({len(parts)} частей)" if not invalid else f"некорректные сечения {label}: " + "; ".join(invalid)})
    return checks


def _mass_check(what, model_kg, spec_kg, source, tolerance, note=""):
    dev = (model_kg - spec_kg) / spec_kg
    detail = "%s: масса по модели %.2f кг, по спецификации %.2f кг (%s); расхождение %+.1f%% (допуск ±%.0f%%)" % (what, model_kg, spec_kg, source, dev * 100, tolerance * 100)
    if note:
        detail += ". " + note
    return {"check": "mass-vs-spec", "result": "pass" if abs(dev) <= tolerance else "warn", "detail": detail,
            "modelKg": round(model_kg, 3), "specKg": round(spec_kg, 3), "deviationPercent": round(dev * 100, 2)}


def seg_dist(p0, p1, q0, q1):
    """Наименьшее расстояние между отрезками p0p1 и q0q1 в пространстве (мм)."""
    d1 = [p1[i] - p0[i] for i in range(3)]
    d2 = [q1[i] - q0[i] for i in range(3)]
    r = [p0[i] - q0[i] for i in range(3)]
    a = sum(v * v for v in d1)
    e = sum(v * v for v in d2)
    f = sum(d2[i] * r[i] for i in range(3))
    if a <= 1e-12 and e <= 1e-12:
        return math.dist(p0, q0)
    if a <= 1e-12:
        s, t = 0.0, min(max(f / e, 0.0), 1.0)
    else:
        c = sum(d1[i] * r[i] for i in range(3))
        if e <= 1e-12:
            t, s = 0.0, min(max(-c / a, 0.0), 1.0)
        else:
            b = sum(d1[i] * d2[i] for i in range(3))
            denom = a * e - b * b
            s = min(max((b * f - c * e) / denom, 0.0), 1.0) if denom > 1e-12 else 0.0
            t = (b * s + f) / e
            if t < 0.0:
                t, s = 0.0, min(max(-c / a, 0.0), 1.0)
            elif t > 1.0:
                t, s = 1.0, min(max((b - c) / a, 0.0), 1.0)
    cp = [p0[i] + d1[i] * s for i in range(3)]
    cq = [q0[i] + d2[i] * t for i in range(3)]
    return math.dist(cp, cq)


def _tube_axes(metal):
    """Оси труб из metalParts: (начало, конец, наружный радиус, внутренний радиус, имя)."""
    axes = []
    for p in metal:
        if str(p.get("groupId", p.get("group", ""))).lower().startswith(("tube", "pipe")):
            xs, ys = [q[0] for q in p["profile"]], [q[1] for q in p["profile"]]
            cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
            start = [p["origin"][i] + p["u"][i] * cx + p["v"][i] * cy for i in range(3)]
            end = [start[i] + p["direction"][i] * p["depth"] for i in range(3)]
            axes.append((start, end, (max(xs) - min(xs)) / 2, p["holes"][0]["radius"] if p.get("holes") else 0.0, p["name"]))
    return axes


def collision_check(solid, anchors, tolerance=0.5):
    """Взаимное проникновение анкеров закладных: с анкерами других закладных, с рабочими стержнями Ø25, с трубами; с сетками/каркасами/петлями/спиралями — отдельно (примечание 2 листа:
    «сетки и каркасы в местах установки закладных обрезать по месту»)."""
    rods = [(p["instance"], p["plate"], p["points"][0], p["points"][1]) for p in anchors]
    hits = {"anchors": [], "main-1": [], "tubes": []}
    for i in range(len(rods)):
        for j in range(i):
            if rods[i][1] == rods[j][1]:
                continue
            gap = seg_dist(rods[i][2], rods[i][3], rods[j][2], rods[j][3])
            if gap < 2 * ANCHOR_R - tolerance:
                hits["anchors"].append((rods[i][0], rods[j][0], round(2 * ANCHOR_R - gap, 1)))
    for g in solid["groups"]:
        if g["id"] == "main-1":
            for rn, rp, p0, p1 in rods:
                for k, path in enumerate(g["paths"]):
                    pts = path["points"]
                    gap = seg_dist(p0, p1, pts[0], pts[-1])
                    if gap < ANCHOR_R + path["diameter"] / 2 - tolerance:
                        hits["main-1"].append((rn, f"Ø25 №{k + 1}", round(ANCHOR_R + path["diameter"] / 2 - gap, 1)))
    for start, end, ro, ri, name in _tube_axes(solid["metalParts"]):
        for rn, rp, p0, p1 in rods:
            gap = seg_dist(p0, p1, start, end)
            if gap < ro + ANCHOR_R - tolerance and gap > ri - ANCHOR_R:
                hits["tubes"].append((rn, name, round(ro + ANCHOR_R - gap, 1)))
    loop_hits = {}
    for g in solid["groups"]:
        if g["id"] == "loops":
            for k, path in enumerate(g["paths"]):
                pts = path["points"]
                rr = ANCHOR_R + path["diameter"] / 2
                for a, b in zip(pts[:-1], pts[1:]):
                    for rn, rp, p0, p1 in rods:
                        gap = seg_dist(p0, p1, a, b)
                        if gap < rr - tolerance:
                            key = (rn, f"П1 №{k + 1} (x≈{round(sum(q[0] for q in pts) / len(pts))})")
                            loop_hits[key] = max(loop_hits.get(key, 0.0), round(rr - gap, 1))
    hits["loops"] = [(a, b, pen) for (a, b), pen in sorted(loop_hits.items())]
    # сетки, каркасы, спирали: счёт пересечений (контакты прутков с анкерами), без отказа
    nets = {}
    for g in solid["groups"]:
        if g["id"] in ("SN", "KK", "SV", "spiral"):
            n = 0
            for path in g["paths"]:
                pts = path["points"]
                rr = ANCHOR_R + path["diameter"] / 2
                for a, b in zip(pts[:-1], pts[1:]):
                    lo = [min(a[i], b[i]) - rr for i in range(3)]
                    hi = [max(a[i], b[i]) + rr for i in range(3)]
                    for rn, rp, p0, p1 in rods:
                        if all(min(p0[i], p1[i]) <= hi[i] and max(p0[i], p1[i]) >= lo[i] for i in range(3)) and seg_dist(p0, p1, a, b) < rr - tolerance:
                            n += 1
            nets[g["id"]] = n
    return hits, nets


def plate_net_contacts(solid, plates, tolerance=0.5):
    """Число отрезков сеток Сн/Св и каркасов Кк (осевые линии с радиусом), заходящих в габарит пластин закладных: «обрезать по месту» (примечание 2 листа)."""
    boxes = []
    for p in plates:
        pts = _part_points(p)
        boxes.append(([min(q[i] for q in pts) for i in range(3)], [max(q[i] for q in pts) for i in range(3)]))
    count = {}
    for g in solid["groups"]:
        if g["id"] not in ("SN", "KK", "SV"):
            continue
        n = 0
        for path in g["paths"]:
            r = path["diameter"] / 2
            a, b = path["points"][0], path["points"][-1]
            lo = [min(a[i], b[i]) - r for i in range(3)]
            hi = [max(a[i], b[i]) + r for i in range(3)]
            if any(all(lo[i] < bhi[i] - tolerance and hi[i] > blo[i] + tolerance for i in range(3)) for blo, bhi in boxes):
                n += 1
        count[g["id"]] = n
    return count


def _part_points(part):
    return [[part["origin"][i] + part["u"][i] * x + part["v"][i] * y + part["direction"][i] * d for i in range(3)] for x, y in part["profile"] for d in (0, part["depth"])]


def _summarize_hits(hits):
    """[{what, pairs, max}] — пересечения, сгруппированные по паре «закладная × закладная / стержень»."""
    groups = {}
    for kind, items in hits.items():
        for a, b, pen in items:
            left = a.split(" анкер")[0]
            right = b.split(" анкер")[0] if kind == "anchors" else ("рабочие стержни Ø25" if kind == "main-1" else b if kind == "loops" else b)
            key = f"{left} × {right}"
            g = groups.setdefault(key, {"what": key, "pairs": 0, "max": 0.0})
            g["pairs"] += 1
            g["max"] = max(g["max"], pen)
    return list(groups.values())


def _concrete_x_ranges(concrete):
    """Сплошные интервалы по x, занятые бетоном (куски вокруг каналов склеиваются): у Кн4 это 0…6030 и 6540…8540, шея 6030…6540 без бетона."""
    spans = sorted((min(q[0] for q in _part_points(p)), max(q[0] for q in _part_points(p))) for p in concrete if p["type"] == "extrusion")
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1e-6:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [tuple(v) for v in merged]


# ── положения закладных по вектору листа («Вид» и «Вид А») ──

def _sheet_view_boxes(page_no):
    """Залитые контуры закладных на «Виде» и «Виде А» листа (doc05): [(вид, x0, x1, a0, a1)] в мм колонны (x — вдоль колонны, a — y на «Виде», z на «Виде А»).
    Масштаб — по контуру колонны на самом листе: нижний блок 6030 мм по высоте, 500 (Вид) и 400 (Вид А) по горизонтали; вертикаль укорочена в 2 раза относительно горизонтали."""
    pdf = fitz.open(slab.SOURCES / "doc05.pdf")
    pg = pdf[page_no - 1]
    rot = pg.rotation_matrix
    outlines = []
    for d in pg.get_drawings():
        r = fitz.Rect(d["rect"]).transform(rot)
        if (d.get("width") or 0) > 1.5 and r.height > 300 and r.y1 > 500:
            outlines.append(r)
    outlines.sort(key=lambda r: r.x0)
    view, view_a = outlines[0], outlines[1]
    k_vert = view.height / 6030.0
    scales = {"Вид": (view.x0, view.width / WIDTH_Y), "Вид А": (view_a.x0, view_a.width / WIDTH_Z)}
    found = []
    for d in pg.get_drawings():
        if d.get("type") not in ("fs", "f"):
            continue
        r = fitz.Rect(d["rect"]).transform(rot)
        name = "Вид" if view.x0 - 10 <= r.x0 and r.x1 <= view.x1 + 10 else ("Вид А" if view_a.x0 - 10 <= r.x0 and r.x1 <= view_a.x1 + 10 else None)
        if name is None or r.y1 < 50 or r.y0 > 545:
            continue
        x0, k_h = scales[name]
        a0, a1 = (r.x0 - x0) / k_h, (r.x1 - x0) / k_h
        xa, xb = (view.y1 - r.y1) / k_vert, (view.y1 - r.y0) / k_vert
        if xb - xa >= 240 and a1 - a0 >= 240:                 # залитые 250×250 и крупнее: пластины; метки (♦, петли) и пунктир Ø50 отсеиваются размером
            found.append((name, xa, xb, a0, a1))
    return sorted(found)


def _position_check(cfg, placements):
    """«Вид»: сколько пластин на лицевой грани в модели и на листе, наибольшее смещение центров и размеров; «Вид А» — то же для правой грани."""
    drawn = _sheet_view_boxes(cfg["page"])
    border_x, border_a = 12.0, {"Вид": 6.0, "Вид А": 6.0}            # толщина контура (≈0,68 pt): по вертикали 12 мм на сторону, по горизонтали вида 6 мм
    expected = {"Вид": [], "Вид А": []}
    for mark, face, x0, u0 in placements:
        s = ZD_SPECS[mark]
        if face in ("through", "F"):
            expected["Вид"].append((mark, x0, x0 + s["h"], u0, u0 + s["w"]))
        else:
            expected["Вид А"].append((mark, x0, x0 + s["h"], u0, u0 + s["w"]))
    lines, worst, ok = [], 0.0, True
    for view in ("Вид", "Вид А"):
        boxes = [b for b in drawn if b[0] == view]
        model = expected[view]
        left = list(boxes)
        for mark, x0, x1, a0, a1 in sorted(model, key=lambda m: (m[1], m[3])):
            if not left:
                ok = False
                lines.append(f"{view}: {mark} x={x0}…{x1} — на листе нет контура")
                continue
            exp = (x0 - border_x, x1 + border_x, a0 - border_a[view], a1 + border_a[view])
            best = min(left, key=lambda b: abs(b[1] - exp[0]) + abs(b[2] - exp[1]) + abs(b[3] - exp[2]) + abs(b[4] - exp[3]))
            left.remove(best)
            dev = max(abs(best[1] - exp[0]), abs(best[2] - exp[1]), abs(best[3] - exp[2]), abs(best[4] - exp[3]))
            worst = max(worst, dev)
            if dev > 5.0:
                ok = False
                lines.append(f"{view}: {mark} x={x0}…{x1}: смещение контура {dev:.1f} мм")
        if left:
            ok = False
            lines.append(f"{view}: на листе лишних контуров {len(left)}: " + "; ".join(f"x={b[1]:.0f}…{b[2]:.0f}" for b in left))
        lines.append(f"{view}: на листе {len(boxes)}, в модели {len(model)}")
    detail = ("положение закладных по вектору листа %d (контуры залитых пластин на «Виде» и «Виде А», масштаб по контуру колонны; контур листа шире пластины на 12 мм по вертикали и 6 по горизонтали): "
              % cfg["page"]) + "; ".join(lines) + "; наибольшее смещение %.1f мм (допуск 5 мм)" % worst
    return {"check": "zd-positions-vs-sheet", "result": "pass" if ok else "fail", "detail": detail, "drawn": len(drawn), "model": sum(len(v) for v in expected.values()),
            "maxDeviationMm": round(worst, 1)}


# ───────────────────────── сборка колонны ─────────────────────────

def _groups_mass(groups):
    out = {}
    for g in groups:
        for p in g["paths"]:
            out[p["diameter"]] = out.get(p["diameter"], 0.0) + bar_kg(p["diameter"], path_length(p["points"]))
    return out


def _inherited_pending(base_pending, cfg):
    out = []
    for text in base_pending:
        key = text.split(":", 1)[0]
        out.append({"id": "kn4-" + key.lower(), "kind": "inherited_open_item", "sourcePages": [FRAME_PAGES["sheet12"], 134, 135, 136, 137],
                    "description": "Унаследовано от модели базовой Кн4 (тот же каркас КПн4, лист 12): " + text})
    return out


def build_column(entry, base):
    alias = entry["alias"]
    cfg = COLUMNS[alias]
    solid = adapt_base(base, cfg)
    # закладные
    plates, anchors, counters = [], [], {}
    for mark, face, x0, u0 in cfg["zd"]:
        counters[mark] = counters.get(mark, 0) + 1
        pos = cfg["positions"][mark]
        pg = ZD_SHEETS[mark][1]
        p, a = make_zd(mark, face, x0, u0, counters[mark], pos, [pg, cfg["page"], cfg["sections_page"]])
        plates += p
        anchors += a
    solid["metalParts"] += plates
    sheets = sorted({str(ZD_SHEETS[m][0]) for m, *_ in cfg["zd"]})
    solid["groups"].append({
        "id": "anchors-zd", "name": "Анкеры закладных деталей Ø14 А500С", "detail": "Анкеры закладных деталей Ø14 А500С", "designation": "ЗД анкеры",
        "sheet": "/".join(sheets), "quantity": len(anchors), "unit": "шт", "sourcePages": sorted({ZD_SHEETS[m][1] for m, *_ in cfg["zd"]} | {cfg["page"]}),
        "kind": "bar", "steelClass": "А500С", "paths": anchors,
        "placementNote": "Анкеры сквозных закладных (ЗД7.1, ЗД7.2н, ЗД11) идут от грани до грани (L=400), остальных — от лицевой или правой грани вглубь (L=385/485).",
    })
    # evidence
    evidence = [
        {"pdfPage": cfg["page"], "sheet": cfg["sheet"], "subject": f"{alias}: «Вид», «Вид А», спецификация, сечения",
         "checks": ["габариты 8540 / 500 / 400, нижний блок 6030, шея 510, верхний блок 2000", "размерные цепочки высотных положений закладных на «Виде» и «Виде А»", "спецификация: КПн4, трубы, закладные, бетон 1,61 м³",
                    "горизонтальные привязки пластин (80/250/170, 80/320/100)"]},
        {"pdfPage": cfg["sections_page"], "sheet": cfg["sections_sheet"], "subject": "Сечения, ведомость расхода стали",
         "checks": ["стороны пластин и сквозные закладные по сечениям", "ведомость расхода стали: арматура Ø14, прокат −12, трубы Ø68×1 и Ø50×5"]},
        {"pdfPage": FRAME_PAGES["sheet12"], "sheet": "12", "subject": "Каркас КПн4", "checks": ["тот же каркас, что у Кн4 (лист 10): без изменений"]},
        {"pdfPage": 134, "sheet": "121", "subject": "Сн", "checks": ["как у Кн4"]}, {"pdfPage": 135, "sheet": "122", "subject": "Кк", "checks": ["как у Кн4"]},
        {"pdfPage": 136, "sheet": "123", "subject": "Св", "checks": ["как у Кн4"]}, {"pdfPage": 137, "sheet": "124", "subject": "СК1/петли", "checks": ["как у Кн4"]},
    ]
    seen_sheet = set()
    for mark, *_ in cfg["zd"]:
        sh, pg = ZD_SHEETS[mark]
        if pg in seen_sheet:
            continue
        seen_sheet.add(pg)
        marks = sorted({m for m, *_ in cfg["zd"] if ZD_SHEETS[m][1] == pg})
        evidence.append({"pdfPage": pg, "sheet": str(sh), "subject": "Закладные детали " + ", ".join(marks),
                         "checks": ["пластины, анкеры, концевые пластины, размеры привязок анкеров и масса по спецификации листа: " + "; ".join(f"{m}: {ZD_SPECS[m]['note']}" for m in marks)]})
    # проверки
    concrete = solid["concreteParts"]
    metal = solid["metalParts"]
    checks = [_volume_check(concrete, CONCRETE_SPEC_M3, f"лист {cfg['sheet']}, спецификация: бетон кл. В40, 1,61 м³")] + _structure_checks(concrete, metal)
    st = cfg["steel"]
    # масса каждого вида закладных: по изделию (спецификация листов 313/314/316) и в сумме
    by_mark = {}
    for mark, face, x0, u0 in cfg["zd"]:
        by_mark[mark] = by_mark.get(mark, 0) + 1
    for mark in sorted(by_mark, key=lambda m: cfg["positions"][m]):
        n = by_mark[mark]
        model_kg = sum(part_kg(p) for p in plates if p["mark"] == mark) + sum(bar_kg(p["diameter"], path_length(p["points"])) for p in anchors if p["plate"].startswith(mark + "#"))
        note = ""
        if mark == "ЗД7.2н":
            note = "в массе по модели учтены отверстия Ø50 в обеих пластинах (в спецификации масса пластины 5,89 кг — без отверстия)"
        checks.append(_mass_check(f"{mark} ×{n}", model_kg, n * ZD_SPECS[mark]["total"], f"лист {ZD_SHEETS[mark][0]}, спецификация: {ZD_SPECS[mark]['total']:.2f} кг на изделие", 0.05, note))
    plates_kg = sum(part_kg(p) for p in plates)
    anchors_kg = sum(bar_kg(p["diameter"], path_length(p["points"])) for p in anchors)
    checks.append(_mass_check("Прокат −12 (пластины закладных, вместе с концевыми)", plates_kg, st["plates"], f"лист {cfg['sections_sheet']}, ведомость расхода стали", 0.05,
                              "в массе по модели учтены отверстия под анкеры"))
    checks.append(_mass_check("Арматура Ø14 А500С (анкеры закладных)", anchors_kg, st["anchors"], f"лист {cfg['sections_sheet']}, ведомость расхода стали", 0.05))
    checks.append(_mass_check("Закладные детали всего (прокат + анкеры)", plates_kg + anchors_kg, st["embedded_total"], "реестр каталога: закладные детали", 0.05))
    # переписанные с листов массы позиций: сумма по составу изделия = масса изделия; сумма по ЗД колонны = итог ведомости (контроль состава и счёта закладных)
    spec_plates = sum(ZD_SPECS[m]["plate"][0] * ZD_SPECS[m]["plate"][1] + ZD_SPECS[m]["endp"][0] * ZD_SPECS[m]["endp"][1] for m, *_ in cfg["zd"])
    spec_anchors = sum(ZD_SPECS[m]["rod"][0] * ZD_SPECS[m]["rod"][1] for m, *_ in cfg["zd"])
    bad_items = [m for m in by_mark if abs(ZD_SPECS[m]["plate"][0] * ZD_SPECS[m]["plate"][1] + ZD_SPECS[m]["endp"][0] * ZD_SPECS[m]["endp"][1]
                                           + ZD_SPECS[m]["rod"][0] * ZD_SPECS[m]["rod"][1] - ZD_SPECS[m]["total"]) > 0.06]
    ok_spec = not bad_items and abs(spec_plates - st["plates"]) <= 0.1 and abs(spec_anchors - st["anchors"]) <= 0.1
    checks.append({"check": "zd-spec-consistency", "result": "pass" if ok_spec else "fail",
                   "detail": ("состав закладных колонны сходится с ведомостью листа %s: по спецификациям изделий (листы 313/314/316) прокат %.2f кг при ведомости %.2f, анкеры Ø14 %.2f кг при %.2f; "
                              "масса каждого изделия равна сумме масс его позиций" % (cfg["sections_sheet"], spec_plates, st["plates"], spec_anchors, st["anchors"]))
                             if ok_spec else "состав закладных не сходится с ведомостью: прокат %.2f / %.2f, анкеры %.2f / %.2f; изделия с расхождением: %s" % (spec_plates, st["plates"], spec_anchors, st["anchors"], ", ".join(bad_items))})
    # трубы
    t68 = sum(part_kg(p) for p in metal if p.get("groupId") == "tube68")
    t50 = sum(part_kg(p) for p in metal if p.get("groupId") == "tube50")
    checks.append(_mass_check("Труба 68×1 L=400", t68, st["tube68"], f"лист {cfg['sheet']}, поз. 2: 0,66 кг", 0.05))
    checks.append(_mass_check("Труба 50×5, 1,8 п.м. (4 отрезка 400+400+500+500)", t50, st["tube50"], f"лист {cfg['sheet']}, поз. 3: 5,549 кг/м × 1,8", 0.05))
    # арматура: масса по диаметрам модели против ведомости (без закладных); каркас — как у Кн4
    by_d = _groups_mass([g for g in solid["groups"] if g["id"] != "anchors-zd"])
    rebar_notes = {
        25: ("Арматура Ø25 А500С (рабочие, 8 × L=7500)", st["rebar_o25"], 0.02, ""),
        16: ("Арматура Ø16 А240 (петли П1 ×4)", st["rebar_o16"], 0.05, "форма петель П1 — как у Кн4 (его открытый вопрос «R внутренний, L1470»)"),
        8: ("Арматура Ø8 А500С (сетки Сн, Кк, Св)", st["rebar_o8"], 0.05,
            "ведомость листа %s даёт Ø8 = 84,24 кг, а лист 12 (каркас КПн4) — 78,90 кг: разница 5,34 кг на листах каркаса и расшифровки не показана, в модель не включена" % cfg["sections_sheet"]),
        3: ("Проволока Ø3 Вр-I (спирали СК1 ×8)", st["rebar_o3"], 0.05, "спираль СК1 — как у Кн4 (открытый вопрос: длина 4560 при Ø60/шаг 50)"),
    }
    for d, (what, spec, tol, note) in rebar_notes.items():
        checks.append(_mass_check(what, by_d.get(d, 0.0), spec, f"лист {cfg['sections_sheet']}, ведомость расхода стали", tol, note))
    checks.append({"check": "mass-vs-spec", "result": "warn",
                   "detail": "Арматура Ø18 А500С (отдельные стержни L=1960 ×16, 62,72 кг): в модели нет (0 кг при 62,72 по ведомости) — положение по Y/Z на листах не размерено, как у Кн4; осевой диапазон 6550…8510 сохранён в группе supplement",
                   "modelKg": 0.0, "specKg": st["rebar_o18"], "deviationPercent": -100.0})
    # положение закладных по вектору листа
    try:
        checks.append(_position_check(cfg, cfg["zd"]))
    except (OSError, RuntimeError, IndexError) as error:           # нет PDF doc05 рядом: проверку по вектору листа выполнить нельзя
        checks.append({"check": "zd-positions-vs-sheet", "result": "warn", "detail": f"положения закладных по вектору листа {cfg['page']} не проверены: PDF doc05 недоступен ({error})"})
    # границы: все анкеры и пластины внутри колонны и внутри бетонных блоков (не в шее 6030…6540)
    ranges = _concrete_x_ranges(concrete)
    inside = True
    for p in anchors:
        xs = [q[0] for q in p["points"]]
        lo, hi = min(xs) - ANCHOR_R, max(xs) + ANCHOR_R
        in_block = any(a - 1e-6 <= lo and hi <= b + 1e-6 for a, b in ranges)
        in_col = all(0 <= q[1] <= WIDTH_Y and 0 <= q[2] <= WIDTH_Z for q in p["points"])
        inside = inside and in_block and in_col
    for p in plates:
        xs = [q[0] if p["u"] == [1, 0, 0] else q[1] for q in p["profile"]]
        lo, hi = min(xs), max(xs)
        inside = inside and any(a - 1e-6 <= lo and hi <= b + 1e-6 for a, b in ranges)
    checks.append({"check": "zd-inside-concrete", "result": "pass" if inside else "fail",
                   "detail": "все пластины и анкеры закладных лежат внутри бетонных блоков 0…6030 и 6540…8540 и в пределах 500 × 400" if inside else "часть закладных выходит за бетон или в шею 6030…6540"})
    # пересечения
    hits, nets = collision_check(solid, [p for g in solid["groups"] if g["id"] == "anchors-zd" for p in g["paths"]])
    clashes = _summarize_hits(hits)
    if clashes:
        checks.append({"check": "zd-anchor-collisions", "result": "warn", "count": sum(c["pairs"] for c in clashes),
                       "detail": "пересечения анкеров закладных (проникновение > 0,5 мм): " + "; ".join(f"{c['what']}: {c['pairs']} пар, до {c['max']} мм" for c in clashes)
                                 + ". Это взаимное положение по размерам чертежей; на листах не разрешено (смещение рядов на 5…8 мм)"})
    else:
        checks.append({"check": "zd-anchor-collisions", "result": "pass", "count": 0,
                       "detail": "анкеры закладных не пересекаются между собой, с рабочими стержнями Ø25, трубами и петлями П1 (допуск 0,5 мм)"})
    in_plates = plate_net_contacts(solid, plates)
    checks.append({"check": "zd-anchor-vs-nets", "result": "note",
                   "detail": "контакты анкеров закладных с сетками Сн/Св, каркасами Кк и спиралями СК1 (отрезки прутков): " + ", ".join(f"{k} {v}" for k, v in sorted(nets.items()))
                             + "; прутки сеток и каркасов, заходящие в габарит пластин: " + ", ".join(f"{k} {v}" for k, v in sorted(in_plates.items()))
                             + "; по примечанию 2 листа сетки и каркасы в местах установки закладных обрезаются по месту — какие стержни и на сколько, лист не определяет, в модели не обрезаны",
                   "contacts": nets, "barsInsidePlates": in_plates})
    sections = "сечения 6-6, 4-4" if alias == "Кн4.5" else "сечения 2-2, 3-3, 4-4, 6-6"
    checks.append({"check": "zd-sections-overlay", "result": "note",
                   "detail": f"стороны (лицевая z=0 — внизу сечения, тыльная z=400 — вверху, правая y=500) и привязки закладных, анкеров и концевых пластин сверены глазами по наложению модели на растр листов "
                             f"{cfg['sections_sheet']} и {cfg['sheet']} ({sections}): пластины и ряды анкеров совпали с прорисовкой; автоматической проверки сечений нет"})
    # итог: описание, допущения, неопределённости
    through = [m for m in ("ЗД7.1", "ЗД7.2н", "ЗД11") if m in by_mark]
    single = [m for m in ("ЗД26", "ЗД13", "ЗД27", "ЗД14") if m in by_mark]
    zd_text = ", ".join(f"{m} ×{by_mark[m]}" for m in sorted(by_mark, key=lambda m: cfg["positions"][m]))
    assumptions = [
        {"id": "orientation", "text": "x — вдоль колонны (0 — низ, 8540 — верх), y — слева направо на «Виде» (0…500), z — вглубь от лицевой грани «Вида» (0…400), лицевая грань на «Виде А» слева; «Вид А» — вид справа (грань y = 500).",
         "affects": ["metalParts", "anchors-zd"]},
        {"id": "zd-heights", "text": "Высотные положения закладных — по размерным цепочкам «Вида» и «Вида А» листа %s (низ пластин: %s); пластина высотой 250 (375, 400, 445). Положения контуров сверены с вектором листа (см. qa)."
                                  % (cfg["sheet"], ", ".join(f"{m} {x0}" for m, f, x0, u0 in cfg["zd"])), "affects": ["plate", "anchors-zd"]},
        {"id": "zd-through", "text": "Сквозные закладные " + ", ".join(through) + ": две пластины 12 мм на лицевой (z = 0…12) и тыльной (z = 388…400) гранях и анкеры Ø14 L=400 от грани до грани — по спецификации листа 313 (прокат L=250/320 ×2, анкеры L=400, 12 + 376 + 12 = 400) "
                                  "и по разрезам с пластинами на обеих гранях." + (" Остальные (" + ", ".join(single) + ") — односторонние." if single else ""), "affects": ["plate", "anchors-zd"]},
        {"id": "zd-anchor-rows", "text": "Ряды анкеров отсчитаны от верха пластины по чертежу закладной детали в предположении, что верх чертежа закладной совпадает с верхом колонны на «Виде»; для несимметричных рядов (ЗД13: 50/140/135/50, "
                                          "ЗД27: 50/175/170/50) возможно зеркало на ±5 мм. Горизонтальные привязки симметричны, кроме отверстия Ø50 в ЗД7.2н (слева, 20 мм от кромки; совпадает с осью трубы Ø50 на x = 5875, y = 100).",
         "affects": ["anchors-zd"]},
        {"id": "zd-flush", "text": "Пластины ЗД лежат заподлицо с гранью колонны (z = 0…12, 388…400, y = 488…500); выем в бетоне под пластину не вырезан и объём бетона не уменьшен (как в других колоннах каталога). Анкеры проходят сквозь отверстия Ø14 пластин; швы Т12-Рэ не моделируются.",
         "affects": ["plate", "anchors-zd", "concrete"]},
        *([{"id": "zd27-length", "text": "Анкеры ЗД27: по спецификации листа 316 L=485 (473 + 12 пластины; масса 0,59 кг сходится с ведомостью), на разрезе 6-6 листа 148 прорисованы короче — до y ≈ 50 (≈ 450 мм). Принято по спецификации (до y = 15); анкеры ЗД14 на разрезе 4-4 прорисованы полной длины.",
            "affects": ["anchors-zd"]}] if "ЗД27" in by_mark else []),
        {"id": "zd-nets", "text": "Сетки и каркасы в местах установки закладных «обрезать по месту» (примечание 2 листа %s): какие стержни обрезаются, не определено — стержни сеток Сн/Кк/Св в модели не обрезаны (число контактов — в протоколе проверки)." % cfg["sheet"],
         "affects": ["SN", "KK", "SV"]},
        {"id": "base-kn4", "text": "Бетон, каркас КПн4 (рабочие Ø25, сетки Сн/Св, каркасы Кк, спираль СК1, петли П1) и трубы Ø50×5 — копия модели Кн4 (лист 10 и листы 12, 121–124): на листах %s/%s габариты, каркас и положения труб те же. "
                                  "Труба Ø68 — по спецификации этих листов 68×1 (у Кн4 68×5), внутренний радиус 33." % (cfg["sheet"], cfg["sections_sheet"]), "affects": ["concrete", "groups", "tube68"]},
    ]
    pending = [
        {"id": "kpn4-mass", "kind": "source-conflict", "sourcePages": [cfg["sections_page"], FRAME_PAGES["sheet12"]],
         "description": "Масса каркаса КПн4 в спецификации листа %s — 389,36 кг (Ø8 = 84,24 кг), а на листе самого каркаса (лист 12) — 384,02 кг (Ø8 = 78,90 кг, как у Кн4). Разница 5,34 кг арматуры Ø8 (при Ø8 в модели 78,9 кг) нигде не расшифрована "
                        "(≈ две лишние сетки Сн по 2,67 кг?). В модели — каркас листа 12 без добавки; нужен ответ проектировщика." % cfg["sections_sheet"]},
        {"id": "supplement-xy", "kind": "placement_question", "sourcePages": [cfg["sections_page"], FRAME_PAGES["sheet12"]],
         "description": "Отдельные стержни Ø18 L=1960 ×16 (62,72 кг; на сечении 4-4 «отд. стержни») — положение по Y/Z на листах не размерено; как и у Кн4, в модель не включены (осевой диапазон 6550…8510 в группе supplement)."},
        {"id": "zd-rows-orientation", "kind": "placement_question", "sourcePages": [ZD_SHEETS[m][1] for m in by_mark] + [cfg["page"]],
         "description": "Ориентация рядов анкеров несимметричных закладных (верх чертежа закладной = верх колонны) принята без явного указания на листе; возможное зеркало ±5 мм."},
        {"id": "zd-shape", "kind": "missing_source", "sourcePages": [ZD_SHEETS[m][1] for m in by_mark],
         "description": "Форма сварных швов Т12-Рэ анкеров, фаски и выем бетона под пластины на листах не заданы — в модель не включены."},
    ] + _inherited_pending(solid["pending"], cfg)
    if clashes:
        pending.append({"id": "zd-clashes", "kind": "source-conflict", "sourcePages": sorted({ZD_SHEETS[m][1] for m in by_mark} | {cfg["page"], cfg["sections_page"]}),
                        "description": "По размерам чертежей анкеры закладных пересекаются: " + "; ".join(f"{c['what']} — {c['pairs']} пар, проникновение до {c['max']} мм" for c in clashes)
                                       + ". Модель повторяет чертёж, смещений для обхода не вводилось; нужно подтверждение проектировщика (смещение ряда или обрезка по месту)."})
    issues = [{"id": "kpn4-mass-mismatch", "kind": "source-conflict", "severity": "warning", "blocksAcceptance": False,
               "title": "Масса каркаса КПн4 в спецификации колонны не совпадает с листом каркаса",
               "description": "Лист %s: КПн4 = 389,36 кг (Ø8 = 84,24 кг); лист 12: КПн4 = 384,02 кг (Ø8 = 78,90 кг). Разница 5,34 кг не объяснена ни на листах каркаса, ни на листах сеток и каркасов Сн/Кк/Св." % cfg["sheet"],
               "sourcePages": [cfg["sections_page"], FRAME_PAGES["sheet12"]]}]
    notes = [
        "Индивидуальная 3D-модель колонны %s по векторным листам КЖИ: бетон, каркас КПн4 (как у Кн4), трубы Ø68×1 и Ø50×5, закладные детали %s." % (alias, zd_text),
        "Объём бетона сверен с 1,61 м³ спецификации листа, масса закладных — с листами 313/314/316 и ведомостью расхода стали, положения закладных — по вектору листа (см. протокол проверки).",
        "Частичная модель: арматура Ø18 L=1960 (16 шт.) и ряд неопределённостей каркаса унаследованы от Кн4 и вынесены в pending. Это не допуск в производство.",
    ]
    for key in ("pending", "notes", "mark", "sourceRevision", "sourceSha256"):
        solid.pop(key, None)
    solid.update({
        "id": entry["id"], "sourceId": entry["source"]["id"], "alias": alias, "mark": cfg["mark"], "format": "column-solids-mm-v1", "status": "partial", "modelType": "column",
        "elementType": "колонна", "bounds": None, "coordinateSystem": "мм; x — вдоль колонны (0 — низ, 8540 — верх), y — слева направо на «Виде» (0…500), z — вглубь от лицевой грани «Вида» (0…400)",
        "coordinateOrigin": "x = 0 — низ колонны, y = 0 — левая грань «Вида», z = 0 — лицевая грань «Вида» (левая сторона «Вида А»)",
        "sourceRevision": "Штампы " + cfg["stamp"], "sourceSha256": entry["source"].get("sha256", ""),
        "evidence": evidence, "pending": pending, "assumptions": assumptions, "issues": issues, "notes": notes,
        "readinessDescription": "Бетон, каркас КПн4, трубы Ø68×1/Ø50×5 и закладные детали (%s) по чертежам листов %s–%s и 313/314/316; арматура Ø18 L=1960 и расшифровка добавки Ø8 +5,34 кг не восстановлены — это не допуск в производство."
                                % (zd_text, cfg["sheet"], cfg["sections_sheet"]),
        "supersedesSketch": True,
    })
    lo = [min(base["bounds"][0][i], *(q[i] for p in plates for q in _part_points(p))) for i in range(3)]
    hi = [max(base["bounds"][1][i], *(q[i] for p in plates for q in _part_points(p))) for i in range(3)]
    solid["bounds"] = [[round(v, 3) for v in lo], [round(v, 3) for v in hi]]
    qa = {"alias": alias, "status": "partial", "checks": checks,
          "counts": {"concreteParts": len(solid["concreteParts"]), "metalParts": len(solid["metalParts"]), "groups": len(solid["groups"]), "checks": len(checks),
                     "warnings": sum(c["result"] == "warn" for c in checks), "failures": sum(c["result"] == "fail" for c in checks)}}
    return solid, qa


def build(register_by_alias, assets_dir=None):
    """Пары (solid, qa) для Кн4.5 и Кн4.6; register_by_alias — {alias: запись реестра из promka-register.json}."""
    base = _load_base(assets_dir)
    return [build_column(register_by_alias[alias], base) for alias in ("Кн4.5", "Кн4.6")]


if __name__ == "__main__":
    reg = {e["alias"]: e for e in json.loads((slab.CATALOG_DIR / "promka-register.json").read_text()).values()}
    for solid, qa in build(reg):
        print(solid["alias"], solid["bounds"], qa["counts"])
        for c in qa["checks"]:
            print("  [%s] %s" % (c["result"], c["detail"]))

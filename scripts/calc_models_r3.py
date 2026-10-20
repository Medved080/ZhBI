#!/usr/bin/env python3
"""Калькулятор: индивидуальная 3D-модель ригеля 3Р14.5м («Ригель 3Р80,5.6.6-9-14.5м», doc07, листы 191–192) — бетон, арматура, закладные детали.

Откуда геометрия (всё — с векторных листов КЖ.И2-1.2 альбома doc07, PDF-страница = лист + 15):
  * лист 191 (PDF 206): фасад, вид сверху 1-1, схема армирования (шаги хомутов, положение петель, сеток и каркасов), ведомость стали;
  * лист 192 (PDF 207): разрезы 2-2, 3-3, вид А, спецификация — положение канатов, стержней Ø22, каркасов, сеток, хомутов в сечении
    (центры стержней сняты с вектора разреза 3-3 в масштабе 1:10: 600 мм = 170,0 pt), выносные размеры;
  * листы 159 (петли 3П5), 162 (хомуты 3Хм2), 163 (сетки 3С4), 167 (каркасы 3К14), 171 (сетки 3СВ14.5), 176 (сетки 3СР14.5) — формы и размеры деталей;
  * лист 213 (PDF 228) — закладные детали ЗД1, ЗД2 (в спецификации листа 192 они отсылают к «л. 211»: на листе 211 главный лист ригеля 3Р19.5м,
    чертёж ЗД1/ЗД2 — на листе 213).

Модель — «частичная» (см. `pending`): не показаны выпуски и загибы канатов в корытах, шпильки 3Ш1, смещение хомутов у закладных; проектный объём,
массу и калькуляцию она не меняет. Контроль: объём против спецификации, масса каждого вида арматуры против спецификации и ведомости стали.

Использование (модуль только строит словарь модели, ничего не пишет):

    import calc_models_r3
    model = calc_models_r3.build(entry)          # entry — запись реестра 3Р14.5м; дальше build_calc_missing_models.assemble(model, ...)
"""
import math
import sys
from pathlib import Path

from shapely.geometry import Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab  # noqa: E402  — extrusion_part и общие проверки моделей

STEEL_KG_PER_M3 = 7850.0
K7_KG_PER_M = 1.086                      # канат К7-15,2 по ГОСТ Р 53772-2010 (спецификация: 10,10 кг на L=9300 → 1,086 кг/м)
SOURCE_ID = "doc07"
PAGE_MAIN, PAGE_SECTIONS = 206, 207      # листы 191, 192
PAGE_LOOP, PAGE_STIRRUP, PAGE_END_MESH, PAGE_CAGE, PAGE_SV, PAGE_SR, PAGE_ZD = 174, 177, 178, 182, 186, 191, 228

# ───────────────────────── габариты и сечение (листы 191, 192) ─────────────────────────

L_BEAM, W, H = 8050.0, 600.0, 600.0                  # длина (x), ширина (z), высота (y)
TROUGH_LEN = 900.0                                   # корыта на торцах: пунктир 900 на фасаде
SLOT_Z0, SLOT_Z1, SLOT_FLOOR = 120.0, 480.0, 55.0    # вид А: стенки 120, прорезь 360, дно корыта 55 мм
SPEC_VOLUME = 2.545                                  # м³, лист 192

# ───────────────────────── пролётные хомуты 3Хм2 (лист 162, разрез 3-3) ─────────────────────────

STIRRUP_STATIONS = ([975.0, 1050.0, 1125.0]                                    # 75×2 от 975 (40 + 100×9 + 35)
                    + [1125.0 + 100.0 * k for k in range(1, 11)]               # 100×10 → 2125
                    + [2125.0 + 150.0 * k for k in range(1, 5)]                # 150×4 → 2725
                    + [2725.0 + 200.0 * k for k in range(1, 14)]               # 200×13 → 5325
                    + [5325.0 + 150.0 * k for k in range(1, 5)]                # 150×4 → 5925
                    + [5925.0 + 100.0 * k for k in range(1, 11)]               # 100×10 → 6925
                    + [6925.0 + 75.0 * k for k in range(1, 3)])                # 75×2 → 7075
STIRRUP_D, STIRRUP_R = 12.0, 35.0
STIRRUP_Z = (113.95, 393.9)                          # оси левой и правой ветви хомута A (по вектору разреза 3-3; ось 280 мм)
STIRRUP_Y_BOTTOM, STIRRUP_Y_TOP, STIRRUP_TAIL_BOTTOM, STIRRUP_TAIL_TOP = 34.35, 869.45, 24.2, 879.7
STIRRUP_DX = 14.0                                    # хомуты A и B станции — в плоскостях x ± 14 (фасад: линии ±7 и ±21), хвосты — по оси станции

# ───────────────────────── канаты К7, стержни Ø22 (разрезы 2-2, 3-3, вид А) ─────────────────────────

K7_D = 15.2
K7_FLOOR_Y, K7_FLOOR_Z = 77.0, (150.0, 225.0, 300.0, 375.0, 450.0)       # дно корыта: пять канатов
K7_SIDE = ((75.0, 122.0), (75.0, 167.0), (525.0, 122.0), (525.0, 167.0))   # (z, y) в стенках: 77 + 45 + 45
K7_SPEC_LEN, K7_SPEC_KG = 9300.0, 10.10
ROD22_D, ROD22_Y, ROD22_Z, ROD22_LEN = 22.0, 50.0, (75.0, 525.0), 8010.0

# ───────────────────────── петли 3П5 (лист 159) ─────────────────────────

LOOP_X = (1260.0, 3090.0, 4960.0, 6790.0)             # размеры 1260 | 1830 | 1870 | 1830 | 1260 по верху фасада
LOOP_D, LOOP_R_AXIS, LOOP_TOP_OUTER, LOOP_HEIGHT, LOOP_TAIL = 20.0, 50.0, 680.0, 520.0, 70.0   # R40 — по внутренней грани гиба, ось R50

# ───────────────────────── каркасы 3К14, сетки 3С4, 3СВ14.5, 3СР14.5 ─────────────────────────

CAGE_Z = (51.0, 549.0)
CAGE_X0, CAGE_L = 10.0, 8030.0                       # каркас 8030 по центру ригеля 8050
CAGE_ROD_LOW_Y, CAGE_JOGGLE = 305.5, 25.0            # нижний стержень; верхний выше на 240 на концах и на 215 в середине
CAGE_CROSS_Y0, CAGE_CROSS_LEN = 175.5, 400.0
CAGE_CROSS_X = [CAGE_X0 + 25.0 + 200.0 * k for k in range(6)]     # 25 от торца и шаг 200; симметрично справа; A = 5980

# сетка 3С4 после сгиба (лист 163, вид А; профиль снят с вектора: стойки 295, откосы, основание 550), мм, смещение в ригель: z + 25, y + 25
MESH4_HALF_LEG, MESH4_HALF_BASE = 184.65, 275.15
MESH4_Y_TOP, MESH4_Y_KINK, MESH4_Y_BASE, MESH4_R = 879.9, 585.0, 32.1, 41.0
MESH4_X_LEFT = [40.0 + 100.0 * k for k in range(10)]                # 20 | 100×9 = 900 (лист 163); справа зеркально
MESH4_LONG_LEN, MESH4_LONG_OFFSET = 1200.0, 20.0                    # Ø8 L=1200: 20 до первого стержня Ø12 и 280 после последнего
MESH4_LONG_BASE = [(175.0, 43.3), (300.0, 43.3), (425.0, 43.3)]     # (z, y): три Ø8 на основании (150 | 125 | 125 | 150 по листу 163)
MESH4_LONG_WALL = [(62.0, 191.6), (86.0, 339.0), (88.0, 491.2)]     # три Ø8 на левом откосе; на правом — зеркально (z → 600 − z)

NET_X = ((915.0, 1910.0, False), (2525.0, 3000.0, False), (5225.0, 1910.0, True))   # начало, длина, зеркально (3СВ14.5, 3СВ14.5-1, 3СВ14.5)
SV_OFFSETS = {1910: [100.0, 175.0, 250.0] + [350.0 + 100.0 * k for k in range(10)] + [1400.0, 1550.0, 1700.0],
              3000: [240.0 + 200.0 * k for k in range(7)] + [1555.0 + 200.0 * k for k in range(7)]}
SR_OFFSETS = {1910: [115.0, 190.0, 265.0] + [365.0 + 100.0 * k for k in range(10)] + [1415.0, 1565.0, 1715.0],
              3000: [255.0 + 200.0 * k for k in range(7)] + [1540.0 + 200.0 * k for k in range(7)]}
SV_Z, SV_Y_TOP, SV_Y_END, SV_R = 34.1, 569.5, 410.0, 41.0           # 3СВ: П-образная, ось верхней перемычки 569,5, концы ветвей 410
SR_Z, SR_Y_BOTTOM, SR_Y_END, SR_R = 33.45, 31.2, 590.0, 35.0        # 3СР: U-образная, ось дна 31,2, концы ветвей 590
SV_LONG = [(100.1, 559.5), (499.9, 559.5)]                          # Ø8 ×2 под верхней перемычкой (60 от внутренних граней ветвей)
SR_LONG = [(99.45, 41.2), (500.55, 41.2), (43.45, 182.0), (556.55, 182.0), (43.45, 382.0), (556.55, 382.0)]

# ───────────────────────── закладные детали (лист 213) ─────────────────────────

ZD1_X0, ZD1_LEN, ZD1_Y0, ZD1_H, ZD1_T = 4240.0, 350.0, 20.0, 250.0, 12.0       # лист 191: 4240 | 350, нижняя кромка 20 над низом
ZD2_X0, ZD2_LEN, ZD2_T = 4065.0, 700.0, 16.0                                   # лист 191: 4065 | 700, пластина −16 × 600 в уровне низа ригеля


# ───────────────────────── помощники ─────────────────────────

def bar_kg(diameter, length_mm):
    return math.pi * diameter ** 2 / 4 * length_mm * STEEL_KG_PER_M3 / 1e9


def path_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


def groups_kg(groups, only=None):
    return sum(bar_kg(p["diameter"], path_length(p["points"])) for g in groups for p in g["paths"] if only is None or only(p))


def _xyz(x, y, z):
    return [round(x, 3), round(y, 3), round(z, 3)]


def fillet(points, radii, step_deg=12.0):
    """Ломаная (a, b) со скруглёнными вершинами: radii[i] — радиус оси стержня в вершине i (0 — острый угол). Дуги дискретизируются шагом step_deg."""
    out = [points[0]]
    for i in range(1, len(points) - 1):
        r = radii[i]
        p, c, n = points[i - 1], points[i], points[i + 1]
        if not r:
            out.append(c)
            continue
        u1 = ((p[0] - c[0]), (p[1] - c[1]))
        u2 = ((n[0] - c[0]), (n[1] - c[1]))
        l1, l2 = math.hypot(*u1), math.hypot(*u2)
        u1, u2 = (u1[0] / l1, u1[1] / l1), (u2[0] / l2, u2[1] / l2)
        theta = math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1])))
        tangent = r / math.tan(theta / 2)
        if tangent > min(l1, l2) + 1e-6:
            raise ValueError("радиус %.1f не помещается между вершинами" % r)
        bis = (u1[0] + u2[0], u1[1] + u2[1])
        bl = math.hypot(*bis)
        centre = (c[0] + bis[0] / bl * r / math.sin(theta / 2), c[1] + bis[1] / bl * r / math.sin(theta / 2))
        a0 = math.atan2(c[1] + u1[1] * tangent - centre[1], c[0] + u1[0] * tangent - centre[0])
        a1 = math.atan2(c[1] + u2[1] * tangent - centre[1], c[0] + u2[0] * tangent - centre[0])
        sweep = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        n_steps = max(2, int(math.ceil(abs(math.degrees(sweep)) / step_deg)))
        for k in range(n_steps + 1):
            a = a0 + sweep * k / n_steps
            out.append((centre[0] + r * math.cos(a), centre[1] + r * math.sin(a)))
    out.append(points[-1])
    return out


def _zy_path(x, pts):
    """Плоская ломаная (z, y) в плоскости x = const → точки модели (x, y, z)."""
    return [_xyz(x, y, z) for z, y in pts]


def _group(gid, name, short, designation, sheet, quantity, unit, kind, material, pages, paths, **extra):
    g = {"id": gid, "name": name, "shortLabel": short, "designation": designation, "sheet": sheet, "quantity": quantity, "unit": unit,
         "kind": kind, "material": material, "sourcePages": pages, "paths": paths}
    g.update(extra)
    return g


# ───────────────────────── бетон ─────────────────────────

def concrete_parts():
    """Корыта на торцах (U-сечение: прорезь 360 сверху, дно 55) длиной 900 и сплошной брус между ними; профиль — как у ригелей 1Р5.1, Р4."""
    trough = [[0, 0], [W, 0], [W, H], [SLOT_Z1, H], [SLOT_Z1, SLOT_FLOOR], [SLOT_Z0, SLOT_FLOOR], [SLOT_Z0, H], [0, H]]
    solid = box(0, 0, W, H)
    parts = []
    for name, x0, x1, poly in (("Бетон 3Р14.5м: торец с корытом, x 0…900", 0.0, TROUGH_LEN, Polygon(trough)),
                               ("Бетон 3Р14.5м: сплошной брус 600 × 600, x 900…7150", TROUGH_LEN, L_BEAM - TROUGH_LEN, solid),
                               ("Бетон 3Р14.5м: торец с корытом, x 7150…8050", L_BEAM - TROUGH_LEN, L_BEAM, Polygon(trough))):
        parts.append(slab.extrusion_part(name, poly, [x0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], x1 - x0, [PAGE_MAIN, PAGE_SECTIONS]))
    return parts


# ───────────────────────── канаты К7 и стержни Ø22 ─────────────────────────

def k7_group():
    paths = []
    rows = [(z, K7_FLOOR_Y, True) for z in K7_FLOOR_Z] + [(z, y, False) for z, y in K7_SIDE]
    for k, (z, y, in_trough) in enumerate(rows, 1):
        x0, x1 = (TROUGH_LEN, L_BEAM - TROUGH_LEN) if in_trough else (0.0, L_BEAM)
        paths.append({"id": f"prestressing:{k}", "diameter": K7_D, "points": [_xyz(x0, y, z), _xyz(x1, y, z)], "position": "13", "instance": str(k),
                      "material": "К7-15,2-1770", "projectLength": K7_SPEC_LEN, "openStart": in_trough, "openEnd": in_trough, "finalPocketBendsModeled": False if in_trough else None,
                      "lengthBasis": "L спецификации (9300) — заготовка; показан прямой участок готового изделия",
                      "note": "канат в корыте: загнуть (прим. 4); показан участок в сплошной части 900…7150" if in_trough else "канат в теле бетона: срезать после распалубки (прим. 5); показан по всей длине 8050"})
    return _group("prestressing", "Преднапряжённые канаты К7-15,2 (поз. 13, ×9)", "Канаты К7", "К7-15,2-1770", "191", 9, "шт", "strand", "К7-15,2-1770", [PAGE_MAIN, PAGE_SECTIONS], paths,
                  position="13", wireCountPerStrand=7, specLengthMm=int(K7_SPEC_LEN),
                  renderedAs="К7: центральная проволока и шесть скрученных; шаг свивки условный, только для визуализации")


def k7_model_kg(group):
    return sum(path_length(p["points"]) for p in group["paths"]) * K7_KG_PER_M / 1000.0


def rod22_group():
    x0 = (L_BEAM - ROD22_LEN) / 2
    paths = [{"id": f"ordinary-longitudinal:{k}", "diameter": ROD22_D, "points": [_xyz(x0, ROD22_Y, z), _xyz(x0 + ROD22_LEN, ROD22_Y, z)], "position": "10", "instance": str(k),
              "material": "A500C", "projectLength": int(ROD22_LEN)} for k, z in enumerate(ROD22_Z, 1)]
    return _group("ordinary-longitudinal", "Стержни Ø22 А500С L=8010 (поз. 10, ×2)", "Ø22 А500С", "Ø22 А500С", "192", 2, "шт", "bars", "A500C", [PAGE_SECTIONS, PAGE_MAIN], paths, position="10")


# ───────────────────────── хомуты 3Хм2 ─────────────────────────

def stirrup_group():
    """Два хомута на станцию: A (хвост-нахлёст по левой ветви, z 114…394) и зеркальный B (z 206…486). Ось: 280 × 835, R35, L = 3025 (лист 162)."""
    z_l, z_r = STIRRUP_Z
    paths, n = [], 0
    for xs in STIRRUP_STATIONS:
        for name, mirror, dx in (("A", False, -STIRRUP_DX), ("B", True, +STIRRUP_DX)):
            def zz(z):
                return W - z if mirror else z
            plane = xs + dx
            loop = fillet([(zz(z_l), STIRRUP_TAIL_BOTTOM), (zz(z_l), STIRRUP_Y_TOP), (zz(z_r), STIRRUP_Y_TOP), (zz(z_r), STIRRUP_Y_BOTTOM), (zz(z_l), STIRRUP_Y_BOTTOM)],
                          [0, STIRRUP_R, STIRRUP_R, STIRRUP_R, STIRRUP_R])
            n += 1
            pts = [_xyz(plane, y, z) for z, y in loop]
            # нахлёст: после нижнего левого угла проволока идёт вверх по той же ветви рядом (в плоскости оси станции), заканчиваясь выше верхней перемычки
            tail_z = zz(z_l)
            pts.append(_xyz(xs, STIRRUP_Y_BOTTOM, tail_z))
            pts.append(_xyz(xs, STIRRUP_TAIL_TOP, tail_z))
            paths.append({"id": f"span-stirrups:{n}", "diameter": STIRRUP_D, "points": pts, "position": "4", "instance": str(n), "material": "A500C", "projectLength": 3025,
                          "note": "хомут %s станции x=%d: контур 280 × 835 по оси, R35; хвост нахлёста (≈ вся ветвь) вдоль %s ветви, виток 3025 мм" % (name, xs, "правой" if mirror else "левой")})
    return _group("span-stirrups", "Пролётный хомут 3Хм2 Ø12 А500С L=3025 (поз. 4, ×92)", "Хомуты 3Хм2", "3Хм2", "162", 92, "шт", "stirrup", "A500C", [PAGE_STIRRUP, PAGE_MAIN, PAGE_SECTIONS], paths, position="4")


# ───────────────────────── монтажные петли 3П5 ─────────────────────────

def loop_group():
    """Петля 3П5: ∩ из Ø20 с осевым радиусом 50 (R40 — внутренний), ветви 100 мм друг от друга, верх на 80 мм над ригелем; нижние концы загнуты
    полукругом с прямым концом 70 мм (вид Б листа 159). Крюки левых петель (x < 4025) смотрят в +x, правых — в −x (симметрия схемы армирования)."""
    paths = []
    r, d = LOOP_R_AXIS, LOOP_D
    top_axis = LOOP_TOP_OUTER - d / 2
    arc_cy = top_axis - r
    bottom_axis = LOOP_TOP_OUTER - LOOP_HEIGHT + d / 2
    hook_cy = bottom_axis + r
    for k, x0 in enumerate(LOOP_X, 1):
        s = 1.0 if x0 < L_BEAM / 2 else -1.0                      # направление крюков по x
        zl, zr = W / 2 - r, W / 2 + r
        pts = [_xyz(x0 + s * 2 * r, hook_cy + LOOP_TAIL, zl)]
        pts.append(_xyz(x0 + s * 2 * r, hook_cy, zl))
        for a in range(0, 181, 12):                               # крюк левой ветви: от (x0 ± 2r) вниз и обратно к x0
            t = math.radians(a)
            pts.append(_xyz(x0 + s * (r + r * math.cos(t)), hook_cy - r * math.sin(t), zl))
        pts.append(_xyz(x0, arc_cy, zl))
        for a in range(12, 181, 12):                              # верхняя полуокружность в плоскости (z, y)
            t = math.radians(a)
            pts.append(_xyz(x0, arc_cy + r * math.sin(t), W / 2 - r * math.cos(t)))
        pts.append(_xyz(x0, hook_cy, zr))
        for a in range(0, 181, 12):                               # крюк правой ветви
            t = math.radians(a)
            pts.append(_xyz(x0 + s * (r - r * math.cos(t)), hook_cy - r * math.sin(t), zr))
        pts.append(_xyz(x0 + s * 2 * r, hook_cy + LOOP_TAIL, zr))
        paths.append({"id": f"lifting-loops:{k}", "diameter": d, "points": pts, "position": "2", "instance": str(k), "material": "A240", "projectLength": 1450,
                      "note": "ветви z = 250 и 350, верх 680 (80 над ригелем), нижние крюки — в сторону %sx" % ("+" if s > 0 else "−")})
    return _group("lifting-loops", "Петли монтажные 3П5 Ø20 А240 L=1450 (поз. 2, ×4)", "Петли 3П5", "3П5", "159", 4, "шт", "loop", "A240", [PAGE_LOOP, PAGE_SECTIONS, PAGE_MAIN], paths, position="2")


# ───────────────────────── каркасы 3К14 ─────────────────────────

def cage_group():
    """Два плоских каркаса 3К14 в стенках (z = 51 и 549): стержень Ø20 L=8030 внизу, верхний Ø20 L=8040 с переломом на 25 мм (750 | 150 | …),
    12 поперечных Ø10 L=400 (25 от торца, шаг 200, A=5980)."""
    paths = []
    xr = CAGE_X0 + CAGE_L
    joggle_len = math.hypot(150.0, CAGE_JOGGLE)
    extra = (8040.0 - CAGE_L - 2 * (joggle_len - 150.0)) / 2           # верхний стержень L=8040 — длиннее нижнего с учётом перелома
    for ci, z in enumerate(CAGE_Z, 1):
        y_up_end, y_up_mid = CAGE_ROD_LOW_Y + 240.0, CAGE_ROD_LOW_Y + 240.0 - CAGE_JOGGLE
        paths.append({"id": f"flat-cages:{ci}:2", "diameter": 20, "points": [_xyz(CAGE_X0, CAGE_ROD_LOW_Y, z), _xyz(xr, CAGE_ROD_LOW_Y, z)],
                      "position": "3", "detailPosition": "2", "instance": str(ci), "material": "A500C", "projectLength": 8030})
        paths.append({"id": f"flat-cages:{ci}:1", "diameter": 20,
                      "points": [_xyz(CAGE_X0 - extra, y_up_end, z), _xyz(CAGE_X0 + 750.0, y_up_end, z), _xyz(CAGE_X0 + 900.0, y_up_mid, z), _xyz(xr - 900.0, y_up_mid, z),
                                 _xyz(xr - 750.0, y_up_end, z), _xyz(xr + extra, y_up_end, z)],
                      "position": "3", "detailPosition": "1", "instance": str(ci), "material": "A500C", "projectLength": 8040})
        for k, x in enumerate(CAGE_CROSS_X + [L_BEAM - xx for xx in CAGE_CROSS_X], 1):
            paths.append({"id": f"flat-cages:{ci}:3:{k}", "diameter": 10, "points": [_xyz(x, CAGE_CROSS_Y0, z), _xyz(x, CAGE_CROSS_Y0 + CAGE_CROSS_LEN, z)],
                          "position": "3", "detailPosition": "3", "instance": f"{ci}-{k}", "material": "A500C", "projectLength": 400})
    return _group("flat-cages", "Каркас плоский 3К14 (поз. 3, ×2): стержни Ø20 А500С L=8040 и 8030, поперечные Ø10 L=400 ×12", "Каркасы 3К14", "3К14", "167", 2, "шт", "frame", "A500C",
                  [PAGE_CAGE, PAGE_SECTIONS, PAGE_MAIN], paths, position="3")


# ───────────────────────── сетки: 3С4 (торцевые), 3СВ14.5 (верхние), 3СР14.5 (нижние) ─────────────────────────

def _mesh4_profile():
    zc = W / 2
    kink_l, kink_r = zc - MESH4_HALF_LEG, zc + MESH4_HALF_LEG
    base_l, base_r = zc - MESH4_HALF_BASE, zc + MESH4_HALF_BASE
    pts = [(kink_l, MESH4_Y_TOP), (kink_l, MESH4_Y_KINK), (base_l, MESH4_Y_BASE), (base_r, MESH4_Y_BASE), (kink_r, MESH4_Y_KINK), (kink_r, MESH4_Y_TOP)]
    return fillet(pts, [0, 0, MESH4_R, MESH4_R, 0, 0])


def end_mesh_group():
    """Сетка 3С4 ×2: стержни Ø12 L=2200 гнутые (U с откосами; ×10, шаг 100, от 40 торца), продольные Ø8 L=1200 ×9 по профилю листа 163 (вид А после сгиба)."""
    paths = []
    profile = _mesh4_profile()
    for side, xs in (("left", MESH4_X_LEFT), ("right", [L_BEAM - x for x in MESH4_X_LEFT])):
        for k, x in enumerate(xs, 1):
            paths.append({"id": f"end-mesh:{side}:1:{k}", "diameter": 12, "points": _zy_path(x, profile), "position": "1", "detailPosition": "1", "instance": f"{side}-{k}",
                          "material": "A500C", "projectLength": 2200})
        first, last = min(xs), max(xs)
        x_start = (first - MESH4_LONG_OFFSET) if side == "left" else (last + MESH4_LONG_OFFSET - MESH4_LONG_LEN)
        longs = MESH4_LONG_BASE + MESH4_LONG_WALL + [(W - z, y) for z, y in MESH4_LONG_WALL]
        for k, (z, y) in enumerate(longs, 1):
            paths.append({"id": f"end-mesh:{side}:2:{k}", "diameter": 8, "points": [_xyz(x_start, y, z), _xyz(x_start + MESH4_LONG_LEN, y, z)],
                          "position": "1", "detailPosition": "2", "instance": f"{side}-{k}", "material": "A500C", "projectLength": 1200})
    return _group("end-mesh", "Сетка 3С4 (поз. 1, ×2): Ø12 L=2200 ×10 и Ø8 L=1200 ×9", "Сетки 3С4", "3С4", "163", 2, "шт", "net", "A500C", [PAGE_END_MESH, PAGE_SECTIONS, PAGE_MAIN], paths, position="1")


def _span_net(gid, name, short, designation, sheet, pages, offsets, bar_pts, long_bars, long_d, bar_d, bar_len, positions):
    paths = []
    for ni, (x0, length, mirrored) in enumerate(NET_X, 1):
        off = offsets[int(length)]
        pos = positions[int(length)]
        for k, o in enumerate(off, 1):
            x = x0 + (length - o if mirrored else o)
            paths.append({"id": f"{gid}:{ni}:2:{k}", "diameter": bar_d, "points": _zy_path(x, bar_pts), "position": pos, "detailPosition": "2", "instance": f"{ni}-{k}",
                          "material": "A500C", "projectLength": bar_len})
        for k, (z, y) in enumerate(long_bars, 1):
            paths.append({"id": f"{gid}:{ni}:1:{k}", "diameter": long_d, "points": [_xyz(x0, y, z), _xyz(x0 + length, y, z)], "position": pos, "detailPosition": "1",
                          "instance": f"{ni}-{k}", "material": "A500C", "projectLength": int(length)})
    return _group(gid, name, short, designation, sheet, 3, "шт", "net", "A500C", pages, paths, position="5–6" if gid == "span-upper" else "7–8")


def span_nets():
    sv_bar = fillet([(SV_Z, SV_Y_END), (SV_Z, SV_Y_TOP), (W - SV_Z, SV_Y_TOP), (W - SV_Z, SV_Y_END)], [0, SV_R, SV_R, 0])
    sr_bar = fillet([(SR_Z, SR_Y_END), (SR_Z, SR_Y_BOTTOM), (W - SR_Z, SR_Y_BOTTOM), (W - SR_Z, SR_Y_END)], [0, SR_R, SR_R, 0])
    upper = _span_net("span-upper", "Сетки верхние 3СВ14.5 ×2 и 3СВ14.5-1 ×1 (поз. 5, 6): Ø12 L=810 П-образные и Ø8 ×2", "Сетки 3СВ14.5", "3СВ14.5", "171", [PAGE_SV, PAGE_SECTIONS, PAGE_MAIN],
                      SV_OFFSETS, sv_bar, SV_LONG, 8, 12, 810, {1910: "5", 3000: "6"})
    lower = _span_net("span-lower", "Сетки нижние 3СР14.5 ×2 и 3СР14.5-1 ×1 (поз. 7, 8): Ø12 L=1610 U-образные и Ø8 ×6", "Сетки 3СР14.5", "3СР14.5", "176", [PAGE_SR, PAGE_SECTIONS, PAGE_MAIN],
                      SR_OFFSETS, sr_bar, SR_LONG, 8, 12, 1610, {1910: "7", 3000: "8"})
    return upper, lower


# ───────────────────────── закладные детали ЗД1, ЗД2 ─────────────────────────

def embedded_groups():
    """ЗД1: пластина −12 × 250, L=350 на лицевой грани z = 600, шесть анкеров Ø12 L=412 (вглубь по −z) и два наклонных Ø12 L=470 (70 вдоль пластины + 400 под 30°).
    ЗД2: пластина −16 × 600, L=700 в уровне низа, шестнадцать анкеров Ø12 L=416 вертикально вверх (4 × 4 по сетке 70/180/200/180/70 × 120/125/110/125/120)."""
    zd1_plate = slab.extrusion_part("Закладная ЗД1: пластина −12 × 250, L=350", box(0, 0, ZD1_LEN, ZD1_H), [ZD1_X0, ZD1_Y0, W - ZD1_T], [1, 0, 0], [0, 1, 0], [0, 0, 1], ZD1_T, [PAGE_ZD, PAGE_SECTIONS])
    zd1_plate["group"] = "zd1"
    zd2_plate = slab.extrusion_part("Закладная ЗД2: пластина −16 × 600, L=700", box(0, 0, ZD2_LEN, W), [ZD2_X0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], ZD2_T, [PAGE_ZD, PAGE_SECTIONS])
    zd2_plate["group"] = "zd2"
    stud_len = 412.0
    paths1 = []
    for xi, dx in enumerate((50.0, 175.0, 300.0), 1):                 # анкеры поз. 3: 6 шт., 50 | 125 | 125 | 50 по длине, 80 и 110 по высоте
        for yi, dy in enumerate((80.0, 190.0), 1):
            x, y = ZD1_X0 + dx, ZD1_Y0 + dy
            paths1.append({"id": f"zd1:3:{xi}{yi}", "diameter": 12, "points": [_xyz(x, y, W), _xyz(x, y, W - stud_len)], "position": "ЗД1 поз. 3", "instance": f"{xi}{yi}",
                           "material": "A500C", "projectLength": 412})
    inc_dz, inc_dy = -400.0 * math.sin(math.radians(30)), 400.0 * math.cos(math.radians(30))
    for k, dx in enumerate((100.0, 250.0), 1):                        # поз. 2: 100 | 150 | 100 от кромки пластины
        x, y0, z = ZD1_X0 + dx, ZD1_Y0 + 80.0, W - ZD1_T - 6.0
        paths1.append({"id": f"zd1:2:{k}", "diameter": 12, "points": [_xyz(x, y0, z), _xyz(x, y0 + 70.0, z), _xyz(x, y0 + 70.0 + inc_dy, z + inc_dz)], "position": "ЗД1 поз. 2", "instance": str(k),
                       "material": "A500C", "projectLength": 470})
    paths2 = []
    for xi, dx in enumerate((70.0, 250.0, 450.0, 630.0), 1):
        for zi, z in enumerate((120.0, 245.0, 355.0, 480.0), 1):
            paths2.append({"id": f"zd2:5:{xi}{zi}", "diameter": 12, "points": [_xyz(ZD2_X0 + dx, 0.0, z), _xyz(ZD2_X0 + dx, 416.0, z)], "position": "ЗД2 поз. 5", "instance": f"{xi}{zi}",
                           "material": "A500C", "projectLength": 416})
    g1 = _group("zd1", "Закладная деталь ЗД1: пластина −12 × 250 L=350, анкеры Ø12 L=412 ×6 и L=470 ×2 (поз. 11)", "Закладная ЗД1", "ЗД1", "213", 1, "шт", "embedded", "С255 / А500С",
                [PAGE_ZD, PAGE_SECTIONS, PAGE_MAIN], paths1, position="11")
    g2 = _group("zd2", "Закладная деталь ЗД2: пластина −16 × 600 L=700, анкеры Ø12 L=416 ×16 (поз. 12)", "Закладная ЗД2", "ЗД2", "213", 1, "шт", "embedded", "С255 / А500С",
                [PAGE_ZD, PAGE_SECTIONS, PAGE_MAIN], paths2, position="12")
    return g1, g2, [zd1_plate, zd2_plate]


# ───────────────────────── сверка констант с векторными листами ─────────────────────────

SECTION_33 = dict(page=PAGE_SECTIONS, region=(100, 430, 350, 760))     # разрез 3-3: область листа 192 в pt видимой страницы


def _section_groups():
    """Контуры (двойные линии толщиной 0,84) разреза 3-3 с листа 192: список (z0, z1, y0, y1, число цепочек) в мм; масштаб — по наружному контуру 600 × 600."""
    chains = slab.sheet_chains(SOURCE_ID, SECTION_33["page"], SECTION_33["region"], 0.8, 0.9)
    boxes = []
    for g in slab.connected_groups(chains):
        pts = [q for c in g for q in c]
        boxes.append((min(q.x for q in pts), max(q.x for q in pts), min(q.y for q in pts), max(q.y for q in pts), len(g)))
    outline = max(boxes, key=lambda b: (b[1] - b[0]) * (b[3] - b[2]))
    k = (outline[1] - outline[0]) / W
    return [((b[0] - outline[0]) / k, (b[1] - outline[0]) / k, (outline[3] - b[3]) / k, (outline[3] - b[2]) / k, b[4]) for b in boxes], k


def check_against_sheets(tolerance=1.5):
    """Сверка констант модуля с вектором разреза 3-3 (PDF doc07, стр. 207): наружные габариты хомута A, пластины ЗД1, сеток 3СВ и 3СР.
    Возвращает список {what, measured, model, deltaMm, ok}; допуск — 1,5 мм (толщина штриха листа в масштабе 1:10 — 0,3 мм, дрожание стыков — до 1 мм)."""
    boxes, k = _section_groups()
    z_l, z_r = STIRRUP_Z
    expected = {
        "хомут 3Хм2 (контур A, z и y)": (z_l - STIRRUP_D / 2, z_r + STIRRUP_D / 2, STIRRUP_TAIL_BOTTOM, STIRRUP_Y_TOP + STIRRUP_D / 2),
        "пластина ЗД1 −12 × 250 (z, y)": (W - ZD1_T, W, ZD1_Y0, ZD1_Y0 + ZD1_H),
        "сетка 3СВ, П-образная (z, y)": (SV_Z - 6, W - SV_Z + 6, SV_Y_END, SV_Y_TOP + 6),
        "сетка 3СР, U-образная (z, y)": (SR_Z - 6, W - SR_Z + 6, SR_Y_BOTTOM - 6, SR_Y_END),
    }
    out = []
    for what, e in expected.items():
        near = min(boxes, key=lambda b: sum(abs(b[i] - e[i]) for i in range(4)))
        delta = max(abs(near[i] - e[i]) for i in range(4))
        out.append({"what": what, "measured": [round(v, 1) for v in near[:4]], "model": [round(v, 1) for v in e], "deltaMm": round(delta, 2), "ok": delta <= tolerance})
    out.append({"what": "масштаб разреза 3-3, pt на мм", "measured": round(k, 5), "model": round(170.0 / 600, 5), "deltaMm": 0.0, "ok": abs(k - 170.0 / 600) < 1e-3})
    return out


# ───────────────────────── сборка модели ─────────────────────────

def _plate_kg(part, thickness):
    poly = Polygon(part["profile"])
    return poly.area * thickness * STEEL_KG_PER_M3 / 1e9


def build(entry):
    parts = concrete_parts()
    k7 = k7_group()
    rods = rod22_group()
    stirrups = stirrup_group()
    loops = loop_group()
    cages = cage_group()
    end_mesh = end_mesh_group()
    upper, lower = span_nets()
    zd1, zd2, plates = embedded_groups()
    groups = [k7, rods, stirrups, loops, cages, end_mesh, upper, lower, zd1, zd2]

    def by_diam(gs, d):
        return groups_kg(gs, only=lambda p, d=d: p["diameter"] == d)

    checks = []
    k7_blank = 9 * K7_SPEC_LEN / 1000 * K7_KG_PER_M
    checks.append(slab._mass_check("Канаты К7-15,2 ×9: заготовка L=9300 по линейной массе 1,086 кг/м", k7_blank, 90.90, "лист 192, поз. 13 (10,10 кг) и ведомость стали (К7 90,90)", 0.01))
    straight = k7_model_kg(k7)
    checks.append(slab._mass_check("Канаты К7 ×9: прямые участки готового изделия в модели", straight, 90.90,
                                   "лист 192, поз. 13; в модели нет выпусков заготовки (по 625 мм с торца, 12,2 кг), загибов канатов в корытах и их участков в корытах (5 × 1,8 м, 9,8 кг)", 0.05))
    checks.append(slab._mass_check("Стержни Ø22 А500С ×2, L=8010", groups_kg([rods]), 47.80, "лист 191, ведомость стали (Ø22: 47,80 = 2 × 23,90, лист 192 поз. 10)", 0.01))
    checks.append(slab._mass_check("Хомуты 3Хм2 ×92 (Ø12, L=3025)", groups_kg([stirrups]), 92 * 2.69, "лист 192, поз. 4 (2,69 кг), лист 162", 0.02))
    checks.append(slab._mass_check("Петли 3П5 ×4 (Ø20 А240)", groups_kg([loops]), 4 * 3.58, "лист 192, поз. 2 (3,58 кг), лист 159; контур даёт L≈1411 при 1450 по спецификации", 0.05))
    checks.append(slab._mass_check("Каркасы 3К14 ×2 (Ø20 + Ø10)", groups_kg([cages]), 2 * 42.59, "лист 192, поз. 3 (42,59 кг), лист 167", 0.02))
    checks.append(slab._mass_check("Сетки 3С4 ×2 (Ø12 L=2200 ×20 + Ø8 L=1200 ×18)", groups_kg([end_mesh]), 2 * 23.80, "лист 192, поз. 1 (23,80 кг), лист 163", 0.03))
    checks.append(slab._mass_check("Сетки 3СВ14.5 ×2 + 3СВ14.5-1", groups_kg([upper]), 2 * 13.02 + 12.44, "лист 192, поз. 5–6 (13,02 / 12,44 кг), лист 171", 0.03))
    checks.append(slab._mass_check("Сетки 3СР14.5 ×2 + 3СР14.5-1", groups_kg([lower]), 2 * 27.40 + 27.12, "лист 192, поз. 7–8 (27,40 / 27,12 кг), лист 176", 0.03))
    p1, p2 = _plate_kg(plates[0], ZD1_T), _plate_kg(plates[1], ZD2_T)
    checks.append(slab._mass_check("ЗД1: пластина −12 × 250 × 350", p1, 8.24, "лист 213, поз. 1; ведомость (прокат −12: 8,24)", 0.01))
    checks.append(slab._mass_check("ЗД2: пластина −16 × 600 × 700", p2, 52.75, "лист 213, поз. 4; ведомость (прокат −16: 52,75)", 0.01))
    checks.append(slab._mass_check("ЗД1: анкеры Ø12 (6 × 412 + 2 × 470)", groups_kg([zd1]), 3.00, "лист 213, поз. 2–3 (2 × 0,42 + 6 × 0,36)", 0.05))
    checks.append(slab._mass_check("ЗД2: анкеры Ø12 (16 × 416)", groups_kg([zd2]), 5.92, "лист 213, поз. 5 (16 × 0,37)", 0.02))
    sheet = "лист 191, ведомость стали"
    checks.append(slab._mass_check("Ведомость: Ø8 А500С (3С4, 3СВ, 3СР)", by_diam([end_mesh, upper, lower], 8), 30.07, sheet, 0.02))
    checks.append(slab._mass_check("Ведомость: Ø10 А500С (поперечные каркасов 3К14)", by_diam([cages], 10), 5.92, sheet, 0.03))
    checks.append(slab._mass_check("Ведомость: Ø12 А500С (хомуты, 3С4, 3СВ, 3СР)", by_diam([stirrups, end_mesh, upper, lower], 12), 385.39, sheet, 0.02))
    checks.append(slab._mass_check("Ведомость: Ø20 А500С (стержни каркасов 3К14)", by_diam([cages], 20), 79.26, sheet, 0.02))
    modeled = groups_kg([rods, stirrups, loops, cages, end_mesh, upper, lower, zd1, zd2]) + straight + p1 + p2
    checks.append(slab._mass_check("Общий расход стали по модели (К7 — только прямые участки; без шпилек 3Ш1 2,40 кг)", modeled, 725.97 - 2.40,
                                   "лист 191, ведомость (общий расход 725,97 без шпилек); недобор — в основном К7 (см. выше)", 0.05))

    assumptions = [
        {"id": "orientation", "text": "Ригель лежит вдоль x (длина 8050), y — вверх, z — поперёк. Вид 1-1 сверху: «низ» листа — z = 600 (лицевая сторона, на которой показан ЗД1 в фасаде); разрезы 2-2, 3-3 и вид А смотрят вдоль +x, "
                                "слева направо на них z растёт 0 → 600. Фасад — вид с лицевой стороны z = 600.", "affects": ["concrete", "groups"]},
        {"id": "concrete-section", "text": "Сечение 600 × 600; на каждом торце — корыто длиной 900 (пунктир на фасаде и на 1-1): прорезь шириной 360 (стенки по 120) сверху вниз до дна толщиной 55 (вид А). "
                                            "Объём 8050 × 0,36 − 2 × 0,9 × 0,36 × 0,545 = 2,545 м³ совпадает со спецификацией; закладные пластины лежат заподлицо с гранью и объём не уменьшают.", "affects": ["concrete"]},
        {"id": "k7-straight", "text": "Центры канатов К7 сняты с вектора разреза 3-3: пять в дне корыта (z = 150…450 через 75, y = 77) и четыре в стенках (z = 75 и 525, y = 122 и 167). Канаты в стенках отнесены к «в теле бетона» (прим. 5: срезать) "
                                       "и показаны по всей длине 8050; канаты в дне корыта (прим. 4: загнуть) — только в сплошной части 900…7150. Загибы канатов в корытах и выпуски заготовки (9300 против 8050) на листах не размерены и не показаны.",
         "affects": ["prestressing"]},
        {"id": "stirrups-two", "text": "Станций хомутов 46 (75×2, 100×10, 150×4, 200×13, 150×4, 100×10, 75×2 от 975 мм; 975 = 40 + 100×9 + 35), на каждой по два хомута 3Хм2 (46 × 2 = 92, как в спецификации): A (z = 114…394, нахлёст по левой ветви) "
                                  "и зеркальный B (z = 206…486, нахлёст по правой), как на разрезе 3-3 и на виде 1-1. Размер 280 × 835 по оси, R35, длина оси 3025 мм сходится со спецификацией: виток нахлёста заходит выше верхней перемычки на 10 мм. "
                                  "Положение плоскостей по x (x станции ∓ 14 и общий хвост по оси станции) — по линиям ±7/±21 на фасаде, на листе не размечено.", "affects": ["span-stirrups"]},
        {"id": "loops-shape", "text": "Петля 3П5: R40 принят внутренним радиусом гиба (ось R50, ветви 100 мм друг от друга при подписи 80 между внутренними гранями), высота 520 по внешним граням, прямой конец крюка 70 мм; "
                                       "крюки обеих ветвей одной петли — в одну сторону: у петель x = 1260, 3090 в +x, у x = 4960, 6790 в −x (симметрично, по схеме армирования). Длина оси по контуру 1411 мм при 1450 по спецификации (−2,7%).", "affects": ["lifting-loops"]},
        {"id": "cage-position", "text": "Каркас 3К14 — плоский, в плоскости z = 51 (и 549): нижний Ø20 на y = 305,5, верхний выше на 240 на концах и на 215 в середине (перелом 25 мм на участке 150 мм после 750 мм от торца каркаса); поперечные Ø10 L=400 — "
                                         "от 130 ниже нижнего стержня до 30 выше верхнего. Каркас 8030 по центру ригеля (x от 10 до 8040): по схеме перелом начинается на x ≈ 760. Стержни каркаса пересекаются осями в одной плоскости (сварные узлы).", "affects": ["flat-cages"]},
        {"id": "net-layout", "text": "Сетки 3СВ и 3СР лежат тремя кусками 1910 | 3000 | 1910 с нахлёстом 300 (границы 915…2825, 2525…5525, 5225…7135; 15 мм от края корыта — размер на схеме). Положение стержней по размерам таблиц листов 171, 176 "
                                      "(A1, S1×K, S2×N, S3×M); у 3СВ и 3СР шаг сдвинут на 15 мм, так что поперечные стержни не пересекаются. Правый кусок 1910 принят зеркально левому (марка одна, направление укладки на листе не указано). "
                                      "По таблице сумма размеров 3СР14.5 даёт 1905 вместо 1910, 3СВ14.5-1 и 3СР14.5-1 — 2995 вместо 3000: принято по размерам таблицы.", "affects": ["span-upper", "span-lower"]},
        {"id": "net-profile", "text": "Профиль гнутых стержней сеток снят с вектора разреза 3-3 (сетки 3СВ — П-образная, оси ветвей z = 34,1 и 565,9, верх 569,5, концы ветвей 410; 3СР — U-образная, оси z = 33,45 и 566,55, дно 31,2, концы 590). "
                                "Длина оси даёт 815 против 810 у 3СВ и 1621 против 1610 у 3СР (+0,7%). Радиусы гибов R41 (3СВ) и R35 (3СР) оценены по контуру разреза.", "affects": ["span-upper", "span-lower"]},
        {"id": "mesh-3s4", "text": "Сетка 3С4: гнутые Ø12 по профилю вида А листа 163 (стойки 295 вверх до 880 — выпуск 280 над ригелем, откосы и основание 550, R41 по оси), смещение в ригель z + 25, y + 25; длина оси 2210 при 2200. "
                                    "Девять Ø8 L=1200 — по точкам вида А (на основании z = 175, 300, 425; на откосах по три), 20 мм до первого Ø12 и 280 мм после последнего.", "affects": ["end-mesh"]},
        {"id": "zd-embedded", "text": "ЗД1 лежит заподлицо с лицевой гранью (z = 588…600), по x 4240…4590, по y 20…270; анкеры Ø12 L=412 идут вглубь на 400 мм по −z, наклонные Ø12 L=470: 70 мм вдоль пластины от уровня нижнего ряда анкеров и 400 мм под 30° к плите вглубь и вверх. "
                                "ЗД2 — пластина −16 × 600 × 700 в уровне низа ригеля (x 4065…4765), 16 анкеров Ø12 L=416 вертикально вверх (пробочная сварка: стержень доходит до низа пластины).", "affects": ["zd1", "zd2"]},
        {"id": "radii-rounding", "text": "Радиусы гибов и дискретизация дуг (шаг 12°) условные; сварные узлы и пересечения стержней не проверялись, коллизии пересечения хомутов с анкерами ЗД2 не разрешены (см. pending).", "affects": ["groups"]},
    ]
    pending = [
        {"id": "strand-bends", "kind": "placement_question", "sourcePages": [PAGE_MAIN, PAGE_SECTIONS],
         "description": "Канаты в корытах должны быть загнуты (прим. 4); схема армирования показывает загиб вверх у торца у трёх рядов (y = 77, 122, 167; радиус около 200, вертикальный участок до y ≈ 770), "
                        "а прим. 4–5 относят к корытам только лежащие в корыте. Какие именно канаты загибаются, радиус, направление и участок загиба не размерены; на виде 1-1 канаты в корыте видны на x ≈ 25…350 и 580…900 с неразъяснённым разрывом. "
                        "Участки 5 канатов в корытах (по 900 мм с каждого торца) и выпуски заготовки (9300 против 8050) в модель не включены; канаты в стенках показаны прямыми по всей длине."},
        {"id": "ties-3sh1", "kind": "placement_question", "sourcePages": [PAGE_MAIN, 178],
         "description": "Шпильки 3Ш1 Ø6 А240 L=700 ×15 (поз. 9, шаг 400 по прим. 3, 2,40 кг) в модель не включены: на схеме армирования отмечены только 13 из 15 (по x ≈ 987…3387 через 400, затем ≈ 3938…6688 через 550), "
                        "положение остальных и высота установки в сечении не размерены."},
        {"id": "zd2-stirrup-shift", "kind": "placement_question", "sourcePages": [PAGE_MAIN],
         "description": "Прим. 7 листа 191 требует сместить хомуты, сетки и петли в местах анкеров ЗД: на величину смещения лист не даёт, а на самом листе (фасад, схема, вид 1-1) хомуты у ЗД стоят в номинальных местах. "
                        "В модели хомуты станций x = 4125…4725 стоят так же и задевают анкеры ЗД2 (x 4135…4695, z 120…480): 9 пар стержней, проникновение до 6 мм. Сдвиг не придуман."},
        {"id": "stirrup-lap-x", "kind": "placement_question", "sourcePages": [PAGE_STIRRUP, PAGE_SECTIONS],
         "description": "Положение витков нахлёста хомутов по x (хвост и контур рядом на 12–14 мм) и порядок слоёв сеток, каркасов и хомутов в местах пересечения на листах не размечены; принято по фасаду и виду 1-1. "
                        "При этом хомуты станций x = 1050, 1125, 7000, 7075 (шаг 75) задевают поперечные стержни 3СР (4 пары, проникновение до 5 мм): подбор положения по x листом не задан."},
        {"id": "net-orientation", "kind": "placement_question", "sourcePages": [PAGE_MAIN, PAGE_SV, PAGE_SR],
         "description": "Направление укладки (какой конец сетки справа) у правых кусков 3СВ14.5 и 3СР14.5 не указано; принято зеркально левым. В нахлёстах по 300 мм продольные Ø8 соседних сеток (6 у 3СР и 2 у 3СВ на каждый нахлёст) "
                        "лежат на одной линии: их взаимное смещение листом не задано, в модели они совпадают."},
    ]
    issues = [
        {"id": "zd-sheet-reference", "kind": "source-conflict", "severity": "info", "blocksAcceptance": False,
         "title": "Спецификация отсылает ЗД1, ЗД2 к «л. 211», а чертёж закладных — на листе 213",
         "description": "В спецификации листа 192 для поз. 11–12 указано «77/113/114-Р-КЖ.И2-1.2, л. 211»; PDF-страница 226 (лист 211) — главный лист ригеля 3Р19.5м. Закладные детали ЗД1, ЗД2 показаны на листе 213 (PDF 228), по нему и построены; "
                        "массы совпали со спецификацией (11,24 и 58,67 кг).", "sourcePages": [PAGE_SECTIONS, PAGE_ZD]},
        {"id": "loop-width", "kind": "source-conflict", "severity": "info", "blocksAcceptance": False,
         "title": "Ширина петли 3П5: 80 по внешним граням на разрезах и 80 в свету на детали",
         "description": "На разрезе 3-3 и виде А (лист 192) петля нарисована шириной 80 по внешним граням (ветви z = 260 и 340); на детали (лист 159) «80» — расстояние между внутренними гранями ветвей при внутреннем радиусе R40 "
                        "(120 по внешним граням). Принята деталь: по ней длина оси 1411 мм при 1450 по спецификации, у узкой петли (R_оси 30) выходит 1303 мм (−10%).", "sourcePages": [PAGE_LOOP, PAGE_SECTIONS]},
        {"id": "rod22-mass", "kind": "source-conflict", "severity": "info", "blocksAcceptance": False,
         "title": "Масса Ø22: 23,90 кг — на каждый стержень",
         "description": "В спецификации поз. 10 «Ø22 А500С L=8010, 2 шт., 23,90»: 23,90 — масса одного стержня (3,0 кг/м × 8,01 м); по ведомости стали Ø22 даёт 47,80 кг на два.", "sourcePages": [PAGE_SECTIONS, PAGE_MAIN]},
    ]
    evidence = [
        {"pdfPage": PAGE_MAIN, "sheet": "191", "subject": "Ригель 3Р14.5м: фасад, вид 1-1, схема армирования, ведомость стали",
         "checks": ["длина 8050, корыта 900 (пунктир), закладные 4065 | 700 и 4240 | 350", "шаги хомутов: 75×2, 100×10, 150×4, 200×13, 150×4, 100×10, 75×2 от 975 (сумма цепочки 8050)", "петли 3П5 на x = 1260, 3090, 4960, 6790",
                    "границы сеток 915, 2525, 5525 (нахлёст 300)", "общий расход стали 725,97 кг"]},
        {"pdfPage": PAGE_SECTIONS, "sheet": "192", "subject": "Разрезы 2-2, 3-3, вид А, спецификация: бетон 2,545 м³, арматура и закладные",
         "checks": ["сечение 600 × 600, прорезь корыта 360 × 545 (дно 55)", "центры К7, Ø22, Ø20 каркасов, хомутов, сеток и ЗД сняты с вектора разреза 3-3", "хомуты A и B по два на станцию (92 = 46 × 2)"]},
        {"pdfPage": PAGE_STIRRUP, "sheet": "162", "subject": "Хомуты 3Хм2: контур 280 × 840, R35, L=3025", "checks": ["длина оси 3025 по контуру листа"]},
        {"pdfPage": PAGE_LOOP, "sheet": "159", "subject": "Петли 3П5: Ø20, высота 520, R40, ветви 80 в свету, крюк 70", "checks": ["L=1450 против 1411 по контуру"]},
        {"pdfPage": PAGE_END_MESH, "sheet": "163", "subject": "Сетки 3С4: вид А после сгиба, Ø12 L=2200 ×10 и Ø8 L=1200 ×9", "checks": ["профиль и точки Ø8 сняты с вектора вида А"]},
        {"pdfPage": PAGE_CAGE, "sheet": "167", "subject": "Каркасы 3К14: Ø20 L=8040 и 8030, Ø10 L=400 ×12, A=5980", "checks": ["перелом верхнего стержня 750 | 150 | 25"]},
        {"pdfPage": PAGE_SV, "sheet": "171", "subject": "Сетки 3СВ14.5, 3СВ14.5-1: таблица размеров", "checks": ["16 и 14 поперечных Ø12 L=810"]},
        {"pdfPage": PAGE_SR, "sheet": "176", "subject": "Сетки 3СР14.5, 3СР14.5-1: таблица размеров", "checks": ["16 и 14 поперечных Ø12 L=1610"]},
        {"pdfPage": PAGE_ZD, "sheet": "213", "subject": "Закладные детали ЗД1, ЗД2: пластины, анкеры, разрезы", "checks": ["ЗД1 −12 × 250 L=350 (8,24 кг), ЗД2 −16 × 600 L=700 (52,75 кг)", "анкеры Ø12 L=412 ×6, 470 ×2, 416 ×16"]},
    ]
    return {
        "key": entry["id"], "alias": entry["alias"], "sourceId": SOURCE_ID, "type": "сборный железобетонный ригель с корытами на торцах", "modelType": "beam", "parts": parts,
        "volumeSpec": (SPEC_VOLUME, "лист 192, спецификация: бетон В40, 2,545 м³", False, 0.02),
        "groups": groups, "metalParts": plates, "massChecks": checks,
        "readinessDescription": "Бетон с корытами, канаты К7, стержни Ø22, хомуты 3Хм2, петли 3П5, каркасы 3К14, сетки 3С4, 3СВ14.5, 3СР14.5 и закладные ЗД1, ЗД2 по листам 191–192 и деталировке; не показаны загибы и выпуски канатов, "
                                "шпильки 3Ш1 и сдвиг хомутов у закладных — это не допуск в производство.",
        "evidence": evidence, "assumptions": assumptions, "issues": issues, "pending": pending,
    }

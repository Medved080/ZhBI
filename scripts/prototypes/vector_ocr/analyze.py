"""Оценка листа: размеры (число, интервал в pt) → калибровка масштаба печати k (лист мог быть уменьшен с большего формата) →
доля согласованных с геометрией + нулевая модель (те же интервалы, числа перемешаны) для оценки доли случайных совпадений."""
import random, collections
STD = [1, 2, 2.5, 4, 5, 10, 15, 20, 25, 40, 50, 75, 100]
TOL = 0.8
def agree(v, pt, k, std=STD):
    """Минимальная невязка (pt) между измеренным интервалом и ожидаемым для числа v при масштабе 1:s и коэффициенте печати k."""
    return min((abs(pt - v / (s * 0.3528) * k), s) for s in std)
def calibrate(dims, grid=None):
    """dims: [(значение:int, интервал_pt)]. Возвращает (k, число согласованных). Лист мог быть уменьшен с большего формата при печати в A3
    (по замерам k = 0,70 и 0,705 — A2→A3 с полями, а не точные 0,7071), поэтому k перебирается вокруг отношений сторон ISO шагом 0,005.
    k≠1 принимается только при заметном выигрыше (≥5 размеров и ≥15% от всех): произвольная подгонка k даёт ложные +1…2 размера."""
    grid = grid or ([1.0] + [round(0.5 + 0.005 * i, 3) for i in range(0, 5)] + [round(0.68 + 0.005 * i, 3) for i in range(0, 11)] + [0.35, 0.355])
    n1 = sum(1 for v, pt in dims if agree(v, pt, 1.0)[0] <= TOL); best = (1.0, n1)
    for k in grid:
        if k == 1.0: continue
        n = sum(1 for v, pt in dims if agree(v, pt, k)[0] <= TOL)
        if n > best[1] and n - n1 >= max(5, 0.15 * len(dims)): best = (k, n)
    return best
def null_rate(dims, k, trials=20, seed=1):
    rnd = random.Random(seed); vals = [v for v, _ in dims]; pts = [p for _, p in dims]; acc = []
    for _ in range(trials):
        rnd.shuffle(vals); acc.append(sum(1 for v, p in zip(vals, pts) if agree(v, p, k)[0] <= TOL) / max(1, len(dims)))
    return sum(acc) / len(acc)

def geometry_dims(segs):
    """Размеры, видимые по геометрии независимо от чтения цифр: интервал между соседними засечками (штрихи ≈45°, 3–10 pt) на размерной линии
    (длинная горизонталь/вертикаль), над/под которым есть мелкие компоненты текста (≥2 символа). Возвращает число таких интервалов."""
    import math, collections
    import vector_ocr as vo
    T = []; H = []; V = []
    for x0, y0, x1, y1, pi in segs:
        L = math.hypot(x1 - x0, y1 - y0)
        if 3 <= L <= 10 and abs(abs(x1 - x0) - abs(y1 - y0)) < 0.22 * L: T.append(((x0 + x1) / 2, (y0 + y1) / 2))
        if L < 12: continue
        if abs(y1 - y0) < 0.05: H.append((min(x0, x1), max(x0, x1), y0))
        elif abs(x1 - x0) < 0.05: V.append((min(y0, y1), max(y0, y1), x0))
    comp = vo.components(segs); small = []
    for c, idx in comp.items():
        xs = [segs[i][0] for i in idx] + [segs[i][2] for i in idx]; ys = [segs[i][1] for i in idx] + [segs[i][3] for i in idx]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 2 <= max(w, h) <= 10 and len(idx) >= 2: small.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
    grid = collections.defaultdict(list)
    for x, y in small: grid[(int(x // 20), int(y // 20))].append((x, y))
    def near(cx, cy, r):
        out = []
        for gx in range(int(cx // 20) - 1, int(cx // 20) + 2):
            for gy in range(int(cy // 20) - 1, int(cy // 20) + 2): out += grid.get((gx, gy), [])
        return out
    tg = collections.defaultdict(list)
    for x, y in T: tg[(int(x // 20), int(y // 20))].append((x, y))
    n = 0; seen = set()
    def intervals(lines, axis):
        nonlocal n
        for a, b, c in lines:
            ts = []
            for gx in range(int(((a if axis == 'h' else c)) // 20) - 1, int(((b if axis == 'h' else c)) // 20) + 2):
                for gy in range(int((c if axis == 'h' else a) // 20) - 1, int(((c if axis == 'h' else b)) // 20) + 2):
                    for x, y in tg.get((gx, gy), []):
                        if axis == 'h' and abs(y - c) < 0.6 and a - 1.5 <= x <= b + 1.5: ts.append(x)
                        if axis == 'v' and abs(x - c) < 0.6 and a - 1.5 <= y <= b + 1.5: ts.append(y)
            ts = sorted(set(round(t, 1) for t in ts))
            for t0, t1 in zip(ts, ts[1:]):
                if t1 - t0 < 4: continue
                mid = (t0 + t1) / 2; cnt = 0
                for x, y in near((mid if axis == 'h' else c), (c if axis == 'h' else mid), 20):
                    along, across = (x, y - c) if axis == 'h' else (y, x - c)
                    if t0 <= along <= t1 and 0.3 <= abs(across) <= 7: cnt += 1
                if cnt >= 2:
                    key = (axis, round(c, 0), round(t0, 0)); 
                    if key not in seen: seen.add(key); n += 1
    intervals(H, 'h'); intervals(V, 'v')
    return n

def scale_cluster(dims, tol=0.025):
    """Крупнейший кластер размеров с одинаковым отношением «значение / интервал» (±tol): масштаб вида. dims: [(значение, интервал_pt)].
    Возвращает (число размеров в кластере, отношение). Мало размеров в кластере на фоне прочитанных — лист (или его части) не в масштабе:
    схемы сеток, виды с разрывами; сверка с масштабом к такому листу неприменима."""
    import math
    rs = sorted(v / (pt * 0.3528) for v, pt in dims if pt > 3 and v > 0 and v < 30000)
    best = (0, 0.0); j = 0
    for i, r in enumerate(rs):
        while rs[j] < r * (1 - 2 * tol): j += 1
        if i - j + 1 > best[0]: best = (i - j + 1, r)
    return best

"""Текст шрифта КЖИ: компоненты → строки → расшатка курсива (сдвиг x на SHEAR·y) → ячейки символов (склейка фрагментов с перекрытием
по x: «к», «н», «й», «ё»…) → растр ячейки в системе строки (базовая линия и высота прописной = 1) для сравнения с эталонами."""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glyphs

SHEAR = 0.176
CW, CH = 20, 28      # растр ячейки: ширина, высота; по вертикали от -0.45 до 1.15 высоты прописной

def deshear(lines):
    return [(a[0] - SHEAR * a[1], a[1], a[2] - SHEAR * a[3], a[3]) for a in lines]

def bbox(lines):
    xs = [p for l in lines for p in (l[0], l[2])]; ys = [p for l in lines for p in (l[1], l[3])]
    return min(xs), min(ys), max(xs), max(ys)

def text_lines(gl, flat=0.9, minlen=2):
    """Строки: цепочки несплюснутых компонентов слева направо (перекрытие по высоте ≥ 40%, зазор ≤ 1,2 высоты символа),
    затем в строку добавляются плоские компоненты (чёрточки, перекладины), лежащие в её рамке."""
    thick = [i for i, g in enumerate(gl) if g['bb'][3] - g['bb'][1] >= flat]
    order = sorted(thick, key=lambda i: gl[i]['bb'][0]); used = set(); lines = []
    def h(i): b = gl[i]['bb']; return b[3] - b[1]
    for i in order:
        if i in used: continue
        chain = [i]; used.add(i)
        while True:
            # правая граница цепочки и её вертикальный диапазон по последним символам
            tail = chain[-3:]; bx = max(gl[j]['bb'][2] for j in tail); yb = min(gl[j]['bb'][1] for j in tail); yt = max(gl[j]['bb'][3] for j in tail)
            hh = max(h(j) for j in tail); best = None
            for j in order:
                if j in used: continue
                c = gl[j]['bb']
                if c[0] > bx + 1.2 * hh + 1: break
                if c[0] < gl[chain[-1]]['bb'][0] - 0.5: continue
                ov = min(yt, c[3]) - max(yb, c[1])
                if ov < 0.4 * min(hh, h(j)): continue
                if best is None or c[0] < gl[best]['bb'][0]: best = j
            if best is None: break
            chain.append(best); used.add(best)
        lines.append(chain)
    # мелкие одиночные знаки («,», «.», «-» ниже базы) присоединяем к соседней строке, которая заметно выше их
    def box(l):
        return (min(gl[j]['bb'][0] for j in l), min(gl[j]['bb'][1] for j in l), max(gl[j]['bb'][2] for j in l), max(gl[j]['bb'][3] for j in l))
    tiny_lines = [l for l in lines if len(l) == 1 and (gl[l[0]]['bb'][3] - gl[l[0]]['bb'][1]) < 3.2 and (gl[l[0]]['bb'][2] - gl[l[0]]['bb'][0]) < 3.2]
    rest = [l for l in lines if l not in tiny_lines]
    for t in tiny_lines:
        tb = box(t); th = max(tb[3] - tb[1], 0.5); cx = (tb[0] + tb[2]) / 2; cy = (tb[1] + tb[3]) / 2; best = None
        for k, L in enumerate(rest):
            x0, y0, x1, y1 = box(L); H = y1 - y0
            if H < 2.2 * th: continue
            ext = 0.7 * H
            if x0 - ext <= cx <= x1 + ext and y0 - 0.5 * H <= cy <= y1 - 0.3 * H:
                dx = 0 if x0 <= cx <= x1 else min(abs(cx - x0), abs(cx - x1))
                if best is None or dx < best[0]: best = (dx, k)
        if best: rest[best[1]].append(t[0])
        else: rest.append(t)
    lines = [l for l in rest if len(l) >= minlen]
    flats = [i for i, g in enumerate(gl) if g['bb'][3] - g['bb'][1] < flat]
    out = []
    for l in lines:
        x0 = min(gl[j]['bb'][0] for j in l); x1 = max(gl[j]['bb'][2] for j in l); y0 = min(gl[j]['bb'][1] for j in l); y1 = max(gl[j]['bb'][3] for j in l)
        out.append({'ids': list(l), 'box': (x0, y0, x1, y1)})
    taken = set()
    for i in flats:
        b = gl[i]['bb']; cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; best = None
        for li, L in enumerate(out):
            x0, y0, x1, y1 = L['box']; ext = 0.7 * (y1 - y0)       # хвостовая пунктуация («.», «,») лежит чуть правее последней буквы
            if x0 - ext <= cx <= x1 + ext and y0 - 0.3 <= cy <= y1 + 0.3:
                dx = 0 if x0 <= cx <= x1 else min(abs(cx - x0), abs(cx - x1))
                if best is None or dx < best[0]: best = (dx, li)
        if best: out[best[1]]['ids'].append(i)
    return out

XH = 0.66   # x-высота / высота прописной в шрифте КЖИ (по замеру: 5,6 / 8,5)

def line_metrics(gl, ids):
    """База строки (медиана нижних краёв) и высота прописной. Высота — наибольший верх, у которого есть «сосед» в пределах 6%
    (одиночный выброс — «й», «|» — отбрасывается). conf=True, если на этом уровне стоят ≥3 ячейки (есть прописные/цифры/выносные),
    иначе строка могла состоять из одних строчных, и настоящая высота прописной — cap/XH (решается при распознавании)."""
    big = [i for i in ids if gl[i]['bb'][3] - gl[i]['bb'][1] >= 0.9]
    bots = sorted(gl[i]['bb'][1] for i in big); base = bots[len(bots) // 2]
    tops = sorted((gl[i]['bb'][3] - base for i in big), reverse=True)
    cap = tops[0]; conf = False
    for t in tops:
        near = sum(1 for u in tops if abs(u - t) <= 0.06 * t)
        if near >= 2: cap = t; conf = near >= 3; break
    return base, max(cap, 1e-6), conf

def cells_of_line(gl, ids, xtol=-0.04, cap=None):
    """Ячейки символов: компоненты, пересекающиеся по x (после расшатки), склеиваются. → список {'ids','lines','x0','x1'}."""
    parts = [(gl[i]['bb'], i, deshear(gl[i]['lines'])) for i in ids]
    items = []
    for bb, i, ls in parts:
        b = bbox(ls); items.append([b[0], b[2], [i], list(ls)])
    items.sort(key=lambda t: t[0]); merged = []
    for it in items:
        w = it[1] - it[0]; ys = [p for l in it[3] for p in (l[1], l[3])]; tiny = cap is not None and w < 0.2 * cap and (max(ys) - min(ys)) < 0.2 * cap
        if merged:
            m = merged[-1]; ov = min(it[1], m[1]) - max(it[0], m[0])
            if tiny:
                join = ov >= 0.6 * w and not (len(m) > 4 and m[4])      # точка/запятая на краю соседней буквы — отдельный символ
            else:
                join = it[0] < m[1] - xtol * (cap or 1) and not (len(m) > 4 and m[4])
            if join:
                m[1] = max(m[1], it[1]); m[2] += it[2]; m[3] += it[3]; continue
        merged.append(it + [tiny])
    return [{'x0': m[0], 'x1': m[1], 'ids': m[2], 'lines': m[3]} for m in merged]

def cell_raster(lines, base, cap, w=CW, h=CH):
    """Растр ячейки: масштаб s = (h·0.625)/cap (прописная занимает 0,625 высоты растра), x от левого края ячейки, y от базовой линии."""
    s = (h * 0.625) / cap; x0 = min(min(l[0], l[2]) for l in lines); k = 4
    img = Image.new('L', (w * k, h * k), 0); dr = ImageDraw.Draw(img)
    y_of = lambda y: (h * (0.45 / 1.6) + (y - base) * s)    # от низа растра
    for a in lines:
        dr.line([((a[0] - x0) * s + 2) * k, (h - y_of(a[1])) * k, ((a[2] - x0) * s + 2) * k, (h - y_of(a[3])) * k], fill=255, width=4)
    return np.array(img.resize((w, h), Image.LANCZOS)).astype(float) / 255

def cells_for(gl, ids, base, cap):
    out = []
    for c in cells_of_line(gl, ids, cap=cap):
        b = bbox(c['lines'])
        out.append({'x0': c['x0'], 'x1': c['x1'], 'base': base, 'cap': cap, 'ids': c['ids'], 'lines': c['lines'],
                    'raster': cell_raster(c['lines'], base, cap), 'wrel': (c['x1'] - c['x0']) / cap,
                    'hrel': (b[3] - b[1]) / cap, 'toprel': (b[3] - base) / cap, 'botrel': (b[1] - base) / cap})
    return out

def sheet_lines(gl, flat=0.9, minlen=2):
    """Строки листа: {'ids','base','cap','conf'} (cap — оценка высоты прописной, см. line_metrics)."""
    out = []
    for L in text_lines(gl, flat, minlen):
        try: base, cap, conf = line_metrics(gl, L['ids'])
        except Exception: continue
        if cap < 2.0 or cap > 20: continue
        out.append({'ids': L['ids'], 'base': base, 'cap': cap, 'conf': conf})
    return out

def sheet_cells(gl, flat=0.9, only_conf=True):
    """Ячейки строк с надёжной оценкой высоты (для обучения эталонов). Каждой ячейке — номер строки 'line'."""
    out = []
    for li, L in enumerate(sheet_lines(gl, flat)):
        if only_conf and not L['conf']: continue
        for c in cells_for(gl, L['ids'], L['base'], L['cap']): c['line'] = li; out.append(c)
    return out

def blur(r, radius=0.9):
    im = Image.fromarray((r * 255).astype('uint8')).filter(__import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(radius))
    a = np.array(im).astype(float) / 255
    return a / max(a.max(), 1e-6)

def jdist(a, b):
    """1 − мягкий Жаккар: Σmin/Σmax по размытым растрам; для тонких линий различает «а», «о», «с», «е», в отличие от средней разности."""
    return 1 - np.minimum(a, b).sum() / max(np.maximum(a, b).sum(), 1e-6)

def cluster_cells(cells, thr=0.30, wtol=0.15):
    """Жадная группировка ячеек по мягкому Жаккару размытых растров и метрикам формы (ширина, верх, низ относительно строки)."""
    cents = []
    for i, c in enumerate(cells):
        rb = blur(c['raster']); best = None
        for k in cents:
            if abs(c['wrel'] - k['wrel']) > wtol or abs(c['toprel'] - k['toprel']) > 0.15 or abs(c['botrel'] - k['botrel']) > 0.15: continue
            d = jdist(k['rb'], rb)
            if d < thr and (best is None or d < best[0]): best = (d, k)
        if best: best[1]['members'].append(i)
        else: cents.append({'raster': c['raster'], 'rb': rb, 'wrel': c['wrel'], 'toprel': c['toprel'], 'botrel': c['botrel'], 'members': [i]})
    cents.sort(key=lambda k: -len(k['members']))
    return cents

def cell_sheet(cells, cents, path, start=0, count=84, cols=12, scale=4, labels=None):
    """Контактный лист: растр ячейки ×scale с линией базы; подпись #номер n=число (+ текущая метка, если есть)."""
    cw, ch = CW * scale + 8, CH * scale + 18; rows = (min(count, len(cents) - start) + cols - 1) // cols
    img = Image.new('RGB', (cols * cw, rows * ch), 'white'); dr = ImageDraw.Draw(img)
    for k, c in enumerate(cents[start:start + count]):
        r = (255 - (c['raster'] * 255)).astype('uint8'); im = Image.fromarray(r).resize((CW * scale, CH * scale), Image.NEAREST).convert('RGB')
        ox, oy = (k % cols) * cw + 4, (k // cols) * ch + 2; img.paste(im, (ox, oy))
        by = oy + CH * scale - int(CH * 0.45 / 1.6 * scale); dr.line([ox, by, ox + CW * scale, by], fill=(255, 150, 150))
        t = '#%d n=%d' % (start + k, len(c['members'])) + ((' ' + labels[start + k]) if labels and labels.get(start + k) else '')
        dr.text((ox, oy + CH * scale + 2), t, fill='red')
    img.save(path)

def pack(r):
    return ''.join(str(int(round(float(v) * 9))) for row in r for v in row)

def unpack(t, w=CW, h=CH):
    return (np.array([int(c) for c in t], dtype=float) / 9).reshape(h, w)

def save_font(items, path):
    """items: [{'ch','raster','wrel','toprel','botrel'}] → JSON (растр — строка цифр 0..9)."""
    import json
    out = [{'ch': it['ch'], 'wrel': round(it['wrel'], 3), 'toprel': round(it['toprel'], 3), 'botrel': round(it['botrel'], 3), 'r': pack(it['raster'])} for it in items]
    json.dump(out, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))
    return len(out)

def thin(items, mind=0.12):
    """Прореживание эталонов: экземпляр добавляется, если он дальше mind от всех уже взятых с той же меткой."""
    kept = []; by = {}
    for it in items:
        rb = blur(it['raster']); L = by.setdefault(it['ch'], [])
        if all(jdist(x, rb) > mind for x in L): L.append(rb); kept.append(it)
    return kept

class Font:
    """Распознавание ячеек по эталонам-экземплярам: ближайший по мягкому Жаккару размытых растров; метрики формы (ширина, верх, низ
    относительно строки) должны быть близки; дальше maxd от всех → None (мусор или неизвестный символ)."""
    def __init__(self, path):
        import json
        self.protos = json.load(open(path)); self.R = np.array([blur(unpack(p['r'])) for p in self.protos])
        self.M = np.array([[p['wrel'], p['toprel'], p['botrel']] for p in self.protos])
    def classify(self, cell, maxd=0.5):
        rb = blur(cell['raster']); mn = np.minimum(self.R, rb).sum(axis=(1, 2)); mx = np.maximum(self.R, rb).sum(axis=(1, 2)); d = 1 - mn / np.maximum(mx, 1e-6)
        pen = (np.abs(self.M[:, 0] - cell['wrel']) > 0.2) | (np.abs(self.M[:, 1] - cell['toprel']) > 0.2) | (np.abs(self.M[:, 2] - cell['botrel']) > 0.2)
        d = d + pen * 1.0; k = int(d.argmin())
        return (self.protos[k]['ch'], float(d[k])) if d[k] <= maxd else (None, float(d[k]))

def decode_line(gl, L, font, space=0.33, maxd=0.5):
    """Распознаёт строку при двух гипотезах высоты прописной (cap и cap/XH — на случай строки из одних строчных); берёт ту,
    где меньше нераспознанных ячеек и ниже среднее расстояние до эталонов."""
    best = None
    for cap in ([L['cap']] if L['conf'] else [L['cap'], L['cap'] / XH]):
        cs = sorted(cells_for(gl, L['ids'], L['base'], cap), key=lambda c: c['x0']); txt = ''; prev = None; ds = []; bad = 0; chars = []
        gaps = sorted(b['x0'] - a['x1'] for a, b in zip(cs, cs[1:])); med = gaps[len(gaps) // 2] if gaps else 0
        spc = max(space * cap, 2.2 * med)       # зазор между буквами в мелком тексте почти постоянен (≈2 pt), пробел — в разы больше
        for c in cs:
            ch, d = font.classify(c, maxd)
            if ch is None: ch = '·'; bad += 1
            chars.append((ch, d, c))
            if prev is not None and c['x0'] - prev['x1'] > spc: txt += ' '
            txt += ch; prev = c; ds.append(min(d, 1.0))
        score = bad + sum(ds) / max(1, len(ds))
        if best is None or score < best[0]: best = (score, txt, cap, cs, bad, chars)
    score, txt, cap, cs, bad, chars = best
    return {'text': txt, 'cap': cap, 'x0': cs[0]['x0'] if cs else 0, 'base': L['base'], 'bad': bad, 'n': len(cs), 'score': score, 'cells': cs, 'chars': chars}

LETTERS = set('абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')
# похожие по начертанию символы: буква ↔ цифра. Выбор по соседям в слове
DIG_OF = {'в': '6', 'б': '6', 'о': '0', 'О': '0', 'З': '3', 'з': '3', 'ч': '4', 'Ч': '4', 'ø': '0'}
LET_OF = {'0': 'О', '6': 'б', '3': 'З', '4': 'Ч'}

def postprocess(text):
    """«ь|» → «ы»; в словах с цифрами неоднозначные символы (в/6, о/0, З/3) разрешаются по соседям: цифра рядом с цифрой → цифра."""
    text = text.replace('ь|', 'ы'); out = []
    for tok in text.split(' '):
        n = len(tok); kind = []
        for ch in tok:
            if ch.isdigit() and ch not in LET_OF: kind.append('d')
            elif ch in LETTERS and ch not in DIG_OF: kind.append('l')
            elif ch in (',', '.', '-', '/', '=', '(', ')'): kind.append('p')
            else: kind.append('a')
        res = list(tok)
        for i, ch in enumerate(tok):
            if kind[i] != 'a': continue
            nb = [kind[j] for j in (i - 1, i + 1) if 0 <= j < n and kind[j] in 'dl']
            ds = nb.count('d'); ls = nb.count('l')
            if ds > ls: res[i] = DIG_OF.get(ch, ch)
            elif ls > ds: res[i] = LET_OF.get(ch, ch) if ch.isdigit() else ch
            elif ds == ls and n > 1:
                tot_d = kind.count('d'); tot_l = kind.count('l')
                if tot_d > tot_l: res[i] = DIG_OF.get(ch, ch)
        if 3 <= n <= 5 and kind[-1] == 'a' and (tok[-1] in DIG_OF or tok[-1] in LET_OF) and tok[0].isupper() and any(k == 'l' for k in kind[:-1]) and not tok[-2:-1].isdigit():
            res[-1] = DIG_OF.get(tok[-1], tok[-1])          # «КР3», «Кг3»: марка заканчивается номером
        out.append(''.join(res))
    return ' '.join(out)

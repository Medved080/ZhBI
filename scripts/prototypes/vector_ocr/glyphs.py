"""Глифы шрифта КЖИ: сбор символов-кластеров со страниц, группировка по форме, контактный лист для ручной разметки."""
import math, sys, json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vector_ocr as vo

N = 24   # сторона растра глифа

def glyph_raster(lines, n=N):
    """Растр по большей стороне (форма без привязки к высоте) — для группировки букв и знаков."""
    xs = [p for l in lines for p in (l[0], l[2])]; ys = [p for l in lines for p in (l[1], l[3])]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys); m = max(x1 - x0, y1 - y0, 1e-6); s = (n - 4) / m
    w = (x1 - x0) * s; h = (y1 - y0) * s; ox = (n - w) / 2; oy = (n - h) / 2
    k = 4; img = Image.new('L', (n * k, n * k), 0); dr = ImageDraw.Draw(img)
    for a in lines:
        dr.line([((a[0] - x0) * s + ox) * k, ((y1 - a[1]) * s + oy) * k, ((a[2] - x0) * s + ox) * k, ((y1 - a[3]) * s + oy) * k], fill=255, width=5)
    return np.array(img.resize((n, n), Image.LANCZOS)).astype(float) / 255

def collect(path, pageno, smin=0.45, smax=16):
    segs = vo.segments(path, pageno); comp = vo.components(segs); out = []
    for c, idx in comp.items():
        ls = [segs[i][:4] for i in idx]
        xs = [p for l in ls for p in (l[0], l[2])]; ys = [p for l in ls for p in (l[1], l[3])]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        if not (smin <= max(x1 - x0, y1 - y0) <= smax): continue
        out.append({'bb': (x0, y0, x1, y1), 'lines': ls})
    return segs, out

def cluster(glyphs, thr=0.11):
    """Жадная группировка по форме (средний модуль разности растров) + близость пропорций."""
    cents = []   # [растр, aspect, [индексы]]
    for i, g in enumerate(glyphs):
        r = glyph_raster(g['lines']); x0, y0, x1, y1 = g['bb']; asp = (x1 - x0) / max(y1 - y0, 1e-6)
        best = None
        for c in cents:
            if abs(math.log((asp + .05) / (c[1] + .05))) > 0.35: continue
            d = np.abs(c[0] - r).mean()
            if d < thr and (best is None or d < best[0]): best = (d, c)
        if best: best[1][2].append(i)
        else: cents.append([r, asp, [i]])
    cents.sort(key=lambda c: -len(c[2]))
    return cents

def contact_sheet(glyphs, cents, path, start=0, count=120, cols=10, cell=110):
    rows = (min(count, len(cents) - start) + cols - 1) // cols
    img = Image.new('RGB', (cols * cell, rows * cell), 'white'); dr = ImageDraw.Draw(img)
    for k, c in enumerate(cents[start:start + count]):
        g = glyphs[c[2][0]]; ox, oy = (k % cols) * cell, (k // cols) * cell
        ls = g['lines']; xs = [p for l in ls for p in (l[0], l[2])]; ys = [p for l in ls for p in (l[1], l[3])]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys); m = max(x1 - x0, y1 - y0, 1e-6); s = (cell - 40) / m
        for a in ls: dr.line([ox + 20 + (a[0] - x0) * s, oy + 14 + (y1 - a[1]) * s, ox + 20 + (a[2] - x0) * s, oy + 14 + (y1 - a[3]) * s], fill='black', width=2)
        dr.text((ox + 3, oy + cell - 14), '#%d n=%d' % (start + k, len(c[2])), fill='red')
        dr.rectangle([ox, oy, ox + cell - 1, oy + cell - 1], outline=(200, 200, 200))
    img.save(path)

def hwords(glyphs, minlen=3):
    """Горизонтальные строки текста: цепочки соседних символов слева направо (перекрытие по высоте ≥50%, зазор ≤0,9 высоты).
    Возвращает списки индексов символов; повёрнутый текст и одиночные штрихи сюда не попадают."""
    order = sorted(range(len(glyphs)), key=lambda i: glyphs[i]['bb'][0]); used = set(); words = []
    def h(i): b = glyphs[i]['bb']; return max(b[3] - b[1], 1e-6)
    for i in order:
        if i in used: continue
        chain = [i]; used.add(i); cur = i
        while True:
            b = glyphs[cur]['bb']; best = None
            for j in order:
                if j in used: continue
                c = glyphs[j]['bb']
                if c[0] < b[0] - 0.5: continue
                if c[0] > b[2] + 0.9 * max(h(cur), h(j), 3) + 2: break
                ov = min(b[3], c[3]) - max(b[1], c[1])
                if ov < 0.5 * min(h(cur), h(j)) or c[0] < b[2] - 0.2 * h(cur) - 1: continue
                if best is None or c[0] < glyphs[best]['bb'][0]: best = j
            if best is None: break
            chain.append(best); used.add(best); cur = best
        words.append(chain)
    return [w for w in words if len(w) >= minlen]

def annotated(glyphs, word, cid, path, k=9):
    """Картинка слова: каждый символ своим цветом, над ним — номер кластера (для ручной разметки)."""
    bbs = [glyphs[i]['bb'] for i in word]; x0 = min(b[0] for b in bbs) - 2; x1 = max(b[2] for b in bbs) + 2
    y0 = min(b[1] for b in bbs) - 2; y1 = max(b[3] for b in bbs) + 2
    img = Image.new('RGB', (int((x1 - x0) * k), int((y1 - y0) * k) + 22), 'white'); dr = ImageDraw.Draw(img)
    cols = [(200, 0, 0), (0, 0, 200), (0, 140, 0), (200, 100, 0)]
    for n, i in enumerate(word):
        for a in glyphs[i]['lines']:
            dr.line([(a[0] - x0) * k, (y1 - a[1]) * k + 22, (a[2] - x0) * k, (y1 - a[3]) * k + 22], fill=cols[n % 4], width=2)
        b = glyphs[i]['bb']; dr.text(((b[0] - x0) * k, 2 + (n % 2) * 10), str(cid[i]), fill=cols[n % 4])
    img.save(path)

def split_spaces(glyphs, word, factor=0.45):
    """Режет цепочку символов на слова по крупным зазорам (> factor × высоты строки)."""
    hh = sorted(glyphs[i]['bb'][3] - glyphs[i]['bb'][1] for i in word)[len(word) // 2]
    out = [[word[0]]]; right = glyphs[word[0]]['bb'][2]
    for i in word[1:]:
        b = glyphs[i]['bb']
        if b[0] - right > factor * hh: out.append([])
        out[-1].append(i); right = max(right, b[2])
    return out

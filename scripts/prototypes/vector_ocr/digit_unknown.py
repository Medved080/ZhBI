"""Цифроподобные символы (высота 5–10 pt), которые не принял ни один набор эталонов цифр, со многих листов: растры и поворот-нормализация
для кластеризации и разметки недостающих цифр. Использование: digit_unknown.py out.pkl doc:page ..."""
import sys, os, pickle
from multiprocessing import Pool
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vector_ocr as vo
D = '/Users/max/zhbi-tool/data/calc/assets/sources/'

def one(args):
    n, p = args; out = []
    try: segs = vo.segments(D + 'doc%02d.pdf' % n, p)
    except Exception: return out
    for c, idx in vo.components(segs).items():
        ls = [segs[i][:4] for i in idx]; xs = [q for l in ls for q in (l[0], l[2])]; ys = [q for l in ls for q in (l[1], l[3])]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if len(idx) < 2 or not (4.5 <= max(w, h) <= 10) or min(w, h) > 8 or min(w, h) < 0.9: continue
        if min(v[0] for v in vo.classify_all(ls).values()) < 17: continue
        if w > h: ls = vo.rot(ls, 90)           # горизонтально лежащий символ — скорее повёрнутый текст
        out.append({'lines': ls, 'raster': vo.raster(ls), 'src': (n, p)})
    return out

if __name__ == '__main__':
    pages = [tuple(map(int, a.split(':'))) for a in sys.argv[2:]]
    with Pool(4) as pool: res = pool.map(one, pages, chunksize=2)
    items = [c for r in res for c in r]; pickle.dump(items, open(sys.argv[1], 'wb')); print(len(pages), 'листов,', len(items), 'неузнанных цифроподобных')

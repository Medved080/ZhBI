"""Сбор нераспознанных символов с многих листов: ячейки, которые эталоны не узнали (None или расстояние > порога), с контекстом строки.
Кластеризация этих ячеек и контактный лист — основа для дообучения недостающих букв. Использование: unknown_cells.py out.pkl doc:page ..."""
import sys, os, pickle
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import textcells as tc, train_font as tf

def one(args):
    n, p = args; font = tc.Font(os.path.join(HERE, 'font_protos.json')); out = []
    try: gl, Ls = tf.load_sheet(n, p)
    except Exception: return out
    for L in Ls:
        r = tc.decode_line(gl, L, font)
        if r['n'] < 3: continue
        chars = r['chars']; s = ''.join(ch for ch, d, c in chars)
        for i, (ch, d, c) in enumerate(chars):
            if ch == '·' or d > 0.38:
                if c['hrel'] < 0.25 and c['wrel'] < 0.25: continue
                out.append({k: c[k] for k in ('raster', 'wrel', 'toprel', 'botrel', 'cap', 'x0')} | {'ctx': s[:i] + '[' + ch + ']' + s[i + 1:], 'src': (n, p), 'd': d})
    return out

if __name__ == '__main__':
    pages = [tuple(map(int, a.split(':'))) for a in sys.argv[2:]]
    with Pool(4) as pool: res = pool.map(one, pages, chunksize=2)
    cells = [c for r in res for c in r]; pickle.dump(cells, open(sys.argv[1], 'wb')); print(len(pages), 'листов,', len(cells), 'неузнанных ячеек')

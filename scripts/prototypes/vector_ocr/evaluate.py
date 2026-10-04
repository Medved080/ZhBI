"""Сводная оценка на листах разных альбомов: размеры (доля согласованных с геометрией после калибровки масштаба печати, нулевая модель),
спецификация (разобрана ли, внутренняя согласованность строк). Использование: evaluate.py doc:page [doc:page ...]"""
import sys, os, re, time, json, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vector_ocr as vo, analyze, glyphs, textcells as tc, tables as tb, train_font as tf
D = '/Users/max/zhbi-tool/data/calc/assets/sources/'

def dims_of(path, page):
    segs = vo.segments(path, page); res = vo.read_digits(segs); words = vo.chain_words(res); dims = vo.measure(segs, words)
    return segs, res, words, dims

def spec_check(sp):
    """Внутренняя согласованность разобранной спецификации: позиции подряд, количества — целые, массы — числа вида «12,34»."""
    rows = [r for r in sp['rows'] if r.get('pos', '').strip().isdigit()]
    if not rows: return {'rows': 0}
    pos = [int(r['pos']) for r in rows]; seq = pos == list(range(pos[0], pos[0] + len(pos)))
    qty = sum(1 for r in rows if re.fullmatch(r'\d+', r.get('qty', '').strip()))
    mass = sum(1 for r in rows if re.fullmatch(r'[\d ]+,\d{2}', r.get('mass', '').strip()))
    return {'rows': len(rows), 'pos_seq': seq, 'qty_ok': qty, 'mass_ok': mass}

def fail_kinds(dd, k):
    """Причины несогласованности размеров: 'chain' — слишком длинное число (цепочка «200х3=600» слилась в одно), 'span' — интервал между
    засечками длиннее/короче ожидаемого в целое число раз ≈ 1…3 (взяты не те засечки или соседний размер), 'read' — прочее (цифры прочитаны неверно)."""
    out = collections.Counter()
    for v, pt in dd:
        err, sc = analyze.agree(v, pt, k)
        if err <= analyze.TOL: continue
        if v > 30000: out['chain'] += 1
        else:
            ratio = pt / (v / (sc * 0.3528) * k) if v else 0
            out['span' if 0.45 < ratio < 3.2 and err > 3 else 'read'] += 1
    return dict(out)

def evaluate(doc, page, font, with_text=True):
    t0 = time.time(); path = D + 'doc%02d.pdf' % doc; out = {'doc': doc, 'page': page}
    segs, res, words, dims = dims_of(path, page)
    dd = [(int(d[0]), d[4]) for d in dims]
    k, n = analyze.calibrate(dd) if dd else (1.0, 0)
    out['fail'] = fail_kinds(dd, k); out['geo'] = analyze.geometry_dims(segs)
    out.update(strokes=len(segs), digits=len(res), numbers=sum(1 for w in words if w['n'] >= 2), dims=len(dd), k=k, agree=n,
               agree_k1=analyze.calibrate(dd, [1.0])[1] if dd else 0, null=round(analyze.null_rate(dd, k), 3) if dd else None)
    if with_text:
        H, V = tb.frame_lines(segs); gl, Ls = tf.load_sheet(doc, page, minlen=1)
        boxes = tb.text_in_boxes(gl, Ls, font, H, V); sp = tb.parse_spec(boxes)
        out['spec'] = spec_check(sp) if sp else None; out['spec_table'] = sp; out['all_text'] = ' '.join(' '.join(t) for t in boxes.values())
    out['sec'] = round(time.time() - t0, 1)
    return out

if __name__ == '__main__':
    font = tc.Font(os.path.join(HERE, 'font_protos.json')); rows = []
    for a in sys.argv[1:]:
        d, p = map(int, a.split(':'))
        try: r = evaluate(d, p, font)
        except Exception as e: print(a, 'ERR', repr(e)); continue
        sp = r.pop('spec_table', None); r.pop('all_text', None); rows.append(r)
        print('doc%02d p%d: геометрически %d; размеров %d, согл. %d (k=%.3f; при k=1: %d; нуль %.0f%%) | спец: %s | сбои %s | %.1fс' % (d, p, r['geo'], r['dims'], r['agree'], r['k'], r['agree_k1'], 100 * (r['null'] or 0), r['spec'], r['fail'], r['sec']))
    json.dump(rows, open(os.path.join(HERE, 'evaluate_last.json'), 'w'), ensure_ascii=False, indent=1)

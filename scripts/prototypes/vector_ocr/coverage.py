"""Что читается с листов изделий: векторность листа, спецификация (позиции, количества, массы), строка «Бетон кл. …» (класс и объём),
наличие «Ведомости расхода стали». Для оценки, какие недостающие данные расчёта можно взять с листа без нейросети.
Использование: coverage.py doc:page ...   (результат — в файл из переменной окружения VOCR_OUT)"""
import sys, os, re, json, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vector_ocr as vo, tables as tb, textcells as tc, train_font as tf
import pypdfium2 as pdfium

def num(s):
    s = re.sub(r'\s', '', s or '').replace(',', '.')
    try: return float(s)
    except ValueError: return None

def part_kind(name):
    n = name.lower()
    if 'закладн' in n: return 'embed'
    if n.startswith('труба'): return 'pipe'
    if 'петл' in n or n.startswith('петля'): return 'loop'
    return None

def cover(font, doc, page):
    path = tf.D + 'doc%02d.pdf' % doc; out = {'doc': doc, 'page': page}
    pg = pdfium.PdfDocument(path)[page - 1]; cnt = collections.Counter(o.type for o in pg.get_objects())
    out['vector'] = cnt[2] > 1000 and cnt[3] == 0
    if not out['vector']: return out
    segs = vo.segments(path, page); H, V = tb.frame_lines(segs); gl, Ls = tf.load_sheet(doc, page, minlen=1)
    boxes = tb.text_in_boxes(gl, Ls, font, H, V); sp = tb.parse_spec(boxes); text = ' '.join(' '.join(t) for t in boxes.values())
    out['spec'] = bool(sp and any(r.get('pos', '').strip().isdigit() for r in sp['rows']))
    out['steel_sheet'] = bool(re.search(r'едомость', text) and re.search(r'стали', text))
    parts = collections.Counter(); qty_ok = 0
    if sp:
        for r in sp['rows']:
            name = r.get('name', ''); kind = part_kind(name)
            if kind:
                parts[kind] += 1; qty_ok += bool(re.fullmatch(r'\d+', r.get('qty', '').strip()))
            m = re.match(r'^[БВ]етон', name)
            if m:
                cls = re.search(r'[ВB]\s?(\d+)', name); out['concrete_class'] = cls.group(0) if cls else None; out['concrete_volume'] = num(r.get('qty', ''))
    out['parts'] = dict(parts); out['parts_with_qty'] = qty_ok
    return out

if __name__ == '__main__':
    font = tc.Font(os.path.join(HERE, 'font_protos.json')); rows = []
    for a in sys.argv[1:]:
        d, p = map(int, a.split(':'))
        try: rows.append(cover(font, d, p))
        except Exception as e: rows.append({'doc': d, 'page': p, 'error': repr(e)[:120]})
    json.dump(rows, open(os.environ['VOCR_OUT'], 'w'), ensure_ascii=False)
    print(len(rows), 'листов')

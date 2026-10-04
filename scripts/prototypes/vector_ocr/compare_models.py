"""Сравнение прочитанного кодом (спецификация, размеры, марка) с готовыми моделями поставщика из каталога. Использование: compare_models.py doc:page ..."""
import sys, os, re, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import evaluate as ev, models_ref as mr, analyze, tables as tb, textcells as tc, train_font as tf, vector_ocr as vo

def to_float(s):
    s = re.sub(r'\s', '', s).replace(',', '.')
    try: return float(s)
    except ValueError: return None

def compare(doc, page, font):
    r = ev.evaluate(doc, page, font); sp = r.pop('spec_table', None); all_text = r.pop('all_text', '')
    ids = mr.list_models_for_page(doc, page); out = {'doc': doc, 'page': page, 'models': len(ids), 'read': {k: r[k] for k in ('dims', 'agree', 'k', 'fail')}}
    if not ids: return out
    segs, res, words, dims = ev.dims_of(ev.D + 'doc%02d.pdf' % doc, page)
    k = r['k']; agreed = {int(d[0]) for d in dims if analyze.agree(int(d[0]), d[4], k)[0] <= analyze.TOL}; allnums = {int(w['text']) for w in words if w['n'] >= 2 and not w['text'].startswith('0')}
    rows = sp['rows'] if sp else []
    names = [mr.norm(row.get('oboz', '') + ' ' + row.get('name', '')) for row in rows]; alltxt = mr.norm(all_text)
    res_models = []
    for mid in ids:
        ref = mr.reference_numbers(mid); item = {'id': mid, 'alias': ref['alias']}
        comps = [c['name'] for c in ref['components'] if not re.search(r'Итого', c['name'])]
        item['components'] = len(comps)
        item['comp_found'] = sum(1 for c in comps if any(mr.norm(c) in n or n and n in mr.norm(c) and len(n) > 8 for n in names))
        concrete = [row for row in rows if re.match(r'^[БВ]етон', row.get('name', ''))]
        if concrete and ref.get('concrete_class'):
            m = re.search(r'[ВB]\s?(\d+(?:[.,]\d)?)', concrete[0]['name']); item['class_read'] = m.group(0) if m else None
            item['class_ok'] = bool(m) and mr.norm(m.group(0)) == mr.norm(ref['concrete_class'])
        if concrete and ref.get('volume_m3') is not None:
            v = to_float(concrete[0].get('qty', '')); item['vol_read'] = v; item['vol_ok'] = v is not None and abs(v - ref['volume_m3']) < 0.006
        if ref.get('bounds'): item['bounds'] = ref['bounds']; item['bounds_in_geom'] = [b for b in ref['bounds'] if b in agreed]; item['bounds_in_read'] = [b for b in ref['bounds'] if b in allnums]
        item['alias_in_text'] = mr.norm(ref['alias'] or '') in alltxt if ref['alias'] else None
        res_models.append(item)
    out['cmp'] = res_models
    return out

if __name__ == '__main__':
    font = tc.Font(os.path.join(HERE, 'font_protos.json')); allr = []
    for a in sys.argv[1:]:
        d, p = map(int, a.split(':'))
        try: r = compare(d, p, font)
        except Exception as e: print(a, 'ERR', repr(e)); continue
        allr.append(r); print(json.dumps(r, ensure_ascii=False)[:900], flush=True)
    json.dump(allr, open(os.path.join(HERE, 'compare_last.json'), 'w'), ensure_ascii=False, indent=1)

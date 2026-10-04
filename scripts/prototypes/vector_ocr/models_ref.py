"""Эталонные цифры из каталога готовых моделей поставщика (app.calc.document_models) для листа PDF «docNN, страница P».
Каталог читается только на чтение из data/calc (переменная ZHBI_CALC_ASSETS_DIR задаётся здесь, данные не копируются)."""
import os, sys, re, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
os.environ.setdefault('ZHBI_CALC_ASSETS_DIR', '/Users/max/zhbi-tool/data/calc/assets')
sys.path.insert(0, ROOT)
from app.calc import document_models as dm

def norm(s):
    """Нормализация названий для сравнения: регистр, латиница↔кириллица, «х/×/x», З↔3 в марках, пробелы."""
    s = s.lower().replace('×', 'х').replace('x', 'х').replace('ё', 'е')
    for a, b in 'aа', 'cс', 'eе', 'oо', 'pр', 'tт', 'kк', 'bв', 'mм', 'hн':
        s = s.replace(a, b)
    s = re.sub(r'(?<![а-я])3д', 'зд', s)       # «3Д20» у поставщика = «ЗД20»
    return re.sub(r'[\s.,;:()]+', '', s)

_by_page = None
def by_page():
    global _by_page
    if _by_page is None:
        _by_page = collections.defaultdict(list)
        for k, v in dm.catalog().items():
            sr = v.get('source') or {}
            if sr.get('id') and sr.get('productPage'): _by_page[(int(sr['id'][3:]), int(sr['productPage']))].append(k)
    return _by_page

def list_models_for_page(doc, page):
    """id моделей, для которых лист docNN/page — чертёж изделия (source.productPage)."""
    return list(by_page().get((doc, page), []))

def bounds_dims(solid):
    """Габариты по bounds (мм), по убыванию."""
    lo, hi = solid['bounds']; return sorted((round(abs(h - l)) for l, h in zip(lo, hi)), reverse=True)

def reference_numbers(model_id):
    m = dm.model(model_id); sr = m.get('source') or {}; solid = m.get('solidModel')
    ref = {'id': model_id, 'mark': m.get('mark'), 'alias': m.get('alias'), 'family': m.get('family'), 'concrete_class': m.get('concreteClass'),
           'volume_m3': m.get('projectVolume'), 'steel_kg': m.get('projectSteel'), 'sheet': sr.get('sheet'), 'page': sr.get('productPage'),
           'components': [{'name': c['name'], 'sheet': c.get('sheet'), 'pdfPage': c.get('pdfPage')} for c in m.get('components') or []],
           'rebar_groups': [g.get('name') for g in m.get('groups') or []]}
    if solid:
        ref['bounds'] = bounds_dims(solid)
        dims = set(ref['bounds'])
        for p in solid.get('concreteParts', []):
            prof = p.get('profile')
            if prof:
                xs = [q[0] for q in prof]; ys = [q[1] for q in prof]
                dims.update({round(max(xs) - min(xs)), round(max(ys) - min(ys)), round(p.get('depth', 0))})
        ref['concrete_dims'] = sorted(d for d in dims if d > 0)
        ref['metal'] = [{'name': p['name'], 'group': p.get('group')} for p in solid.get('metalParts', [])]
        ref['solid_status'] = solid.get('status')
    return ref

if __name__ == '__main__':
    import json
    for a in sys.argv[1:]:
        d, p = map(int, a.split(':')); ids = list_models_for_page(d, p)
        print('doc%02d p%d: моделей %d' % (d, p, len(ids)))
        for i in ids[:3]:
            r = reference_numbers(i); print('  ', json.dumps({k: r[k] for k in ('id', 'mark', 'alias', 'concrete_class', 'volume_m3', 'steel_kg', 'bounds') if k in r}, ensure_ascii=False))
            print('    состав:', [c['name'] for c in r['components']][:6])

"""Verified drawing-family profile for GP1/GP2, axes 5–7 / Е–Ж.

Coordinates of sheet, shaft plan, and building are separate. Unsupported
geometry is rejected, never silently converted into panel bounding boxes.
"""
from collections import Counter
from hashlib import sha256
from pathlib import Path
import math
import re
import statistics
import unicodedata

import ezdxf
from shapely.geometry import Point, Polygon

TYPE = 'Панель облицовки шахты'
PROFILE = 'moskvich-gp1-gp2-v1'
LAYER = 'Плиты-опалубки'
MARK = re.compile(r'^ПП\d+(?:\.\d+)?[а-яё]*$', re.I)
LEVEL = re.compile(r'^[+−-]?\d{1,3}[,.]\d{3}$')


class DrawingError(ValueError):
    pass


def text_of(e):
    text = e.plain_text() if e.dxftype() == 'MTEXT' else e.dxf.text
    return unicodedata.normalize('NFKC', text).strip()


def _rectangle(e):
    if e.dxftype() != 'LWPOLYLINE' or not e.closed or len(e) != 4:
        raise DrawingError(f'{e.dxf.handle}: ожидается замкнутый прямоугольник из 4 вершин')
    if any(abs(p[4]) > 1e-9 for p in e.get_points()):
        raise DrawingError(f'{e.dxf.handle}: дуговой контур не поддержан профилем')
    if abs(e.dxf.elevation) > .01 or tuple(e.dxf.extrusion) != (0., 0., 1.):
        raise DrawingError(f'{e.dxf.handle}: ожидается плоская развертка WCS XY')
    points = [(float(x), float(y)) for x, y in e.get_points('xy')]
    if not all(math.isfinite(v) for p in points for v in p):
        raise DrawingError('Неконечные координаты')
    poly = Polygon(points)
    if not poly.is_valid or poly.area <= 1 or abs(poly.area-poly.envelope.area) > poly.length*.01:
        raise DrawingError(f'{e.dxf.handle}: профиль поддерживает только осевые прямоугольники')
    return {'handle': e.dxf.handle, 'points': points, 'bounds': list(poly.bounds), 'polygon': poly}


def _axes(msp):
    axes = {'numeric': {}, 'letter': {}}
    evidence = []
    # А2 is a hidden alternative label, NOT an additional building axis.
    for e in msp.query('INSERT'):
        labels = [a.dxf.text.strip() for a in e.attribs if a.dxf.tag.upper() == 'А1'
                  and not a.dxf.invisible]
        for label in labels:
            if label not in ('5', '7', 'Е', 'Ж'):
                continue
            kind, coord = ('numeric', e.dxf.insert.x) if label.isdigit() else ('letter', e.dxf.insert.y)
            if label in axes[kind] and abs(axes[kind][label]-coord) > .01:
                raise DrawingError(f'Ось {label} неоднозначна')
            axes[kind][label] = float(coord)
            evidence.append({'label': label, 'handle': e.dxf.handle, 'attribute': 'А1', 'coord': float(coord)})
    if set(axes['numeric']) != {'5', '7'} or set(axes['letter']) != {'Е', 'Ж'}:
        raise DrawingError('Не найдены четыре оси 5, 7, Е, Ж в атрибутах А1')
    # A verified metric control; INSUNITS of the supplied file is incorrect.
    for kind, a, b, span in [('numeric','5','7',9000), ('letter','Е','Ж',12000)]:
        if abs(axes[kind][b]-axes[kind][a]-span) > .1:
            raise DrawingError(f'Шаг {a}–{b} не равен {span} мм; требуется другой профиль масштаба')
    return axes, evidence


def _levels(msp, texts, view_left):
    levels = []
    leaders = []
    for e in msp.query('LWPOLYLINE[layer=="Размермой"]'):
        pts = list(e.get_points('xy'))
        if len(pts) != 3:
            continue
        a,b,c = pts
        if abs(a[0]-b[0]) < .01 and abs(b[1]-c[1]) < .01 and a[0] < view_left:
            leaders.append((e, a,b,c))
    for t in texts:
        if not LEVEL.fullmatch(t['text']) or t['xy'][0] >= view_left:
            continue
        z = float(t['text'].replace(',', '.').replace('−','-'))*1000
        candidates = [(abs(t['xy'][1]-b[1]), e, a) for e,a,b,c in leaders
                      if min(b[0],c[0])-400 <= t['xy'][0] <= max(b[0],c[0])+400]
        candidates.sort(key=lambda x: x[0])
        if not candidates or candidates[0][0] > 500:
            continue
        _,e,a = candidates[0]
        levels.append({'label': t['text'], 'z_mm': round(z,3), 'sheet_y': float(a[1]),
                       'text_handle': t['handle'], 'leader_handle': e.dxf.handle})
    good = [l for l in levels if l['z_mm'] >= 0]
    if len(good) < 4 or not {0,15000,25800,31300}.issubset({l['z_mm'] for l in good}):
        raise DrawingError('Не подтверждены отметки 0 / +15,000 / +25,800 / +31,300')
    zero = statistics.median(l['sheet_y']-l['z_mm'] for l in good)
    for l in levels:
        l['residual_mm'] = round(l['sheet_y']-zero-l['z_mm'],3)
    if any(abs(l['residual_mm']) > .1 for l in good):
        raise DrawingError('Отметки развертки противоречат масштабу 1:1')
    return zero, levels


def parse_drawing(path):
    path = Path(path)
    if path.suffix.lower() != '.dxf' or path.stat().st_size > 30*1024*1024:
        raise DrawingError('Ожидается DXF не более 30 МиБ')
    try:
        doc = ezdxf.readfile(path)
    except Exception as exc:
        raise DrawingError('Невозможно прочитать DXF') from exc
    msp = doc.modelspace()
    if len(msp) > 100000:
        raise DrawingError('Слишком много сущностей для этого профиля')
    texts = [{'handle': e.dxf.handle, 'text': text_of(e),
              'xy': [float(e.dxf.insert.x), float(e.dxf.insert.y)]}
             for e in msp.query('TEXT MTEXT')]
    titles = [t for t in texts if 'Развертка шахты подъемника ГП' in t['text']]
    if len(titles) != 2 or not all(any(s in t['text'] for t in titles) for s in ('ГП1','ГП2')):
        raise DrawingError('Этот профиль ожидает две развертки ГП1/ГП2')
    split_y = max(t['xy'][1] for t in titles)
    all_shapes = [_rectangle(e) for e in msp if e.dxf.layer == LAYER]
    plan = [p for p in all_shapes if p['bounds'][1] > split_y]
    panels = [p for p in all_shapes if p['bounds'][3] < split_y]
    if len(plan)+len(panels) != len(all_shapes) or not panels:
        raise DrawingError('Не удалось разделить план и развертки')
    axes, axis_evidence = _axes(msp)
    # Each wide panel provides the exact boundaries of one elevation strip.
    spans = sorted({(round(p['bounds'][0],2),round(p['bounds'][2],2)) for p in panels
                    if p['bounds'][2]-p['bounds'][0] > 1000})
    if len(spans) != 8:
        raise DrawingError(f'Ожидается 8 сторон разверток, найдено {len(spans)}')
    faces = []
    for i,(lo,hi) in enumerate(spans):
        label = 'АБВГДЕЖИ'[i]
        headings = [t for t in texts if t['text'] == label and lo < t['xy'][0] < hi
                    and max(p['bounds'][3] for p in panels) < t['xy'][1] < split_y]
        if len(headings) != 1 or abs(hi-lo-([5700,4050][i%2])) > .1:
            raise DrawingError(f'Не подтверждена сторона {label} и ее ширина')
        faces.append({'shaft': 'ГП1' if i<4 else 'ГП2', 'face': label, 'side_index': i%4,
                      'sheet_u0': lo, 'sheet_u1': hi, 'heading_handle': headings[0]['handle']})
    for p in panels:
        candidates = [f for f in faces if p['bounds'][0] >= f['sheet_u0']-.02
                      and p['bounds'][2] <= f['sheet_u1']+.02]
        if len(candidates) != 1:
            raise DrawingError(f"{p['handle']}: контур пересекает границы сторон")
        p['view'] = candidates[0]
    marks = [t for t in texts if MARK.fullmatch(t['text']) and t['xy'][1] < split_y]
    used = set()
    # First assign containment, then resolve external jamb annotations against
    # ONLY still-unlabelled panels. A text and a panel may be used once.
    for t in marks:
        candidates = [p for p in panels if p['polygon'].covers(Point(t['xy']))]
        if len(candidates) > 1:
            raise DrawingError(f"{t['handle']}: марка лежит в нескольких панелях")
        if candidates:
            p = candidates[0]
            if 'mark' in p:
                raise DrawingError(f"{p['handle']}: несколько марок в одном контуре")
            p.update(mark=t['text'], mark_handle=t['handle'], mark_method='inside', mark_distance_mm=0.)
            used.add(t['handle'])
    for t in marks:
        if t['handle'] in used:
            continue
        x,y = t['xy']
        candidates = sorted([(p['polygon'].distance(Point(x,y)),p) for p in panels
                    if 'mark' not in p and p['view']['sheet_u0']-.02 <= x <= p['view']['sheet_u1']+.02
                    and p['bounds'][1] <= y <= p['bounds'][3]], key=lambda a:a[0])
        if not candidates or candidates[0][0] > 1000 or (len(candidates)>1 and candidates[1][0]-candidates[0][0]<100):
            raise DrawingError(f"{t['handle']} {t['text']}: не удалось однозначно привязать внешнюю марку")
        distance,p = candidates[0]
        p.update(mark=t['text'], mark_handle=t['handle'], mark_method='external_unique',
                 mark_distance_mm=round(distance,3))
        used.add(t['handle'])
    if any('mark' not in p for p in panels) or len(used) != len(panels):
        raise DrawingError('Есть контуры без марки; импорт неполного результата запрещен')
    # Detect exact duplicates; touching panel edges are allowed.
    for i,p in enumerate(panels):
        for q in panels[i+1:]:
            if p['polygon'].intersection(q['polygon']).area > .1:
                raise DrawingError(f"Перекрытие панелей {p['handle']} / {q['handle']}")
    zero, levels = _levels(msp, texts, spans[0][0])
    warnings = []
    if doc.header.get('$INSUNITS') != 4:
        warnings.append({'code':'header_units', 'message':'INSUNITS не мм; масштаб 1 мм подтвержден осями 9000/12000 и четырьмя отметками.'})
    if any(abs(l['residual_mm']) > .1 for l in levels):
        warnings.append({'code':'level_conflict', 'message':'Отметка -0,800 не согласуется с геометрией (невязка 680 мм); Z рассчитан по 0/+15/+25,8/+31,3.'})
    result_panels = []
    for p in panels:
        f = p['view']; x0,y0,x1,y1 = p['bounds']
        u0,u1 = x0-f['sheet_u0'],x1-f['sheet_u0']
        z0,z1 = y0-zero,y1-zero
        identity = '|'.join([f['shaft'],f['face'],*[f'{v:.1f}' for v in (u0,u1,z0,z1)]])
        result_panels.append({k:v for k,v in p.items() if k not in ('polygon','view')} | {
            'physical_key': sha256(identity.encode()).hexdigest()[:24],
            'element_type': TYPE, 'shaft': f['shaft'], 'face': f['face'],
            'u0_mm':round(u0,3),'u1_mm':round(u1,3),'z_min_mm':round(z0,3),'z_max_mm':round(z1,3),
            'width_mm':round(x1-x0,3),'height_mm':round(y1-y0,3),
            'area_m2':round(p['polygon'].area/1e6,6)})
    return {'profile':PROFILE,'source_file':path.name,'source_sha256':sha256(path.read_bytes()).hexdigest(),
            'header_insunits':doc.header.get('$INSUNITS'),'unit_scale_mm':1.,
            'axes':axes,'axis_evidence':axis_evidence,'z_zero_sheet':zero,'levels':levels,
            'faces':faces,'plan_shapes':[{k:v for k,v in p.items() if k!='polygon'} for p in plan],
            'panels':result_panels,'warnings':warnings,
            'counts':{'source_contours':len(all_shapes),'panels':len(panels),'plan_contours':len(plan),
                      'marks':len(marks),'by_mark':dict(sorted(Counter(p['mark'] for p in panels).items())),
                      'by_face':dict(Counter(p['view']['face'] for p in panels)),
                      'by_method':dict(Counter(p['mark_method'] for p in panels))}}

"""Tekla СМ1 façade elevations. Paper coordinates are registered without scaling the model."""
from bisect import bisect_right
from collections import Counter, defaultdict
from hashlib import sha256
import json
from math import dist, hypot, isfinite
import re
from statistics import median
from shapely import affinity
from shapely.geometry import Polygon, box

from .parser import DrawingError

# (scope, reference axis, displayed horizontal direction). Checked against view titles,
# never the filename: a renamed drawing or a new revision uses the same import scope.
VIEWS = {
    'по оси 39 в осях г-р': ('facade-39', '39', 1),
    'по оси р в осях 39-1': ('facade-r', 'Р', -1),
    'по оси 1 в осях р-а': ('facade-1', '1', -1),
    'по оси а в осях 1-35': ('facade-a', 'А', 1),
    'в осях 35-39, а-г': ('facade-diagonal', '35–39, А–Г', 1),
}
SCALE = 100  # СМ1 elevations at 1:100. Checked against actual level arrows on each sheet.
SECTION_2_2_MM = (100, 150, 190)  # left to right on the supplied cross-section


def load_frame(conn, object_id):
    """Snapshot the supporting geometry so apply can detect changes after analyze."""
    return [dict(r) for r in conn.execute("""SELECT id,element_type,elevation_mm,height_mm,outline_json
        FROM elements WHERE object_id=? AND is_current=1 AND element_type IN ('Колонна','Ригель')
        AND outline_json IS NOT NULL ORDER BY id""", (object_id,))]


def station_shift(drawing, origin, direction, frame):
    """Register the view's columns to physical column footprints along the facade."""
    ox, oy = origin
    ux, uy = direction
    stations = set()
    for member in frame:
        if member['element_type'] != 'Колонна':
            continue
        center = Polygon(json.loads(member['outline_json'])).centroid
        if abs((center.x-ox)*uy-(center.y-oy)*ux) < 2000:
            stations.add(center.x*ux+center.y*uy)
    matches = []
    for column in sorted(set(drawing['columns'])):
        source = ox*ux+oy*uy+column*SCALE
        if stations:
            target = min(stations,key=lambda v:abs(v-source))
            if abs(target-source) < 1000:
                matches.append((target-source,target))
    if len(matches)<2:
        raise DrawingError('Для привязки вдоль фасада нужны две соответствующие колонны каркаса')
    shift = median(delta for delta,_ in matches)
    inliers = [(delta,target) for delta,target in matches if abs(delta-shift)<5]
    if len({round(target) for _,target in inliers})<2:
        raise DrawingError('Колонны развёртки не подтверждают единую привязку вдоль фасада')
    return median(delta for delta,_ in inliers)


def align_to_frame(placed, frame, offset_mm=0):
    """Translate one complete elevation to the outer supporting face, keeping it planar."""
    if not isfinite(offset_mm):
        raise DrawingError('Некорректный отступ фасада')
    panels = placed['panels']
    a, b = panels[0]['outline'][:2]
    length = dist(a, b)
    ux, uy = (b[0]-a[0])/length, (b[1]-a[1])/length
    nx, ny = uy, -ux
    baseline = a[0]*nx+a[1]*ny
    stations = [x*ux+y*uy for p in panels for x,y in p['outline'][:2]]
    lo, hi = min(stations), max(stations)
    top = max(p['elevation_mm']+p['height_mm'] for p in panels)
    candidates = []
    for member in frame:
        if member['elevation_mm'] is None or member['elevation_mm'] >= top:
            continue
        poly = Polygon(json.loads(member['outline_json']))
        if not poly.is_valid or poly.area <= 0:
            raise DrawingError('Некорректный контур элемента каркаса '+str(member['id']))
        local = affinity.affine_transform(poly, [ux,uy,nx,ny,0,-baseline])
        left, inner, right, outer = local.bounds
        # The СМ1 view is registered to its perimeter row. Exclude unrelated rows
        # while retaining the complete section of any crossing beam.
        if right <= lo or left >= hi or inner > 2000 or outer < -2000:
            continue
        clipped = local.intersection(box(lo,inner-1,hi,outer+1))
        if not clipped.is_empty and clipped.area > 0:
            candidates.append((clipped.bounds[3], member['id']))
    if not candidates:
        raise DrawingError('У фасада не найден опорный каркас для привязки внутренней грани')
    face = max(value for value, _ in candidates)
    shift = face+offset_mm
    for panel in panels:
        panel['outline'] = [[round(x+nx*shift,6),round(y+ny*shift,6)] for x,y in panel['outline']]
        panel['x'] = round(panel['x']+nx*shift,6)
        panel['y'] = round(panel['y']+ny*shift,6)
        axes = placed['target_axes']
        num = min(axes['numeric'],key=lambda k:abs(panel['x']-axes['numeric'][k]))
        let = min(axes['letter'],key=lambda k:abs(panel['y']-axes['letter'][k]))
        panel.update(nearest_axis_number=num,nearest_axis_letter=let,
                     offset_x_mm=round(panel['x']-axes['numeric'][num],3),
                     offset_y_mm=round(panel['y']-axes['letter'][let],3),
                     address=f"Фасад {panel['face']}, {num}/{let}, {panel['z']/1000:+.3f} м",
                     frame_offset_mm=offset_mm, registration_shift_mm=round(shift,6))
    placed['frame_registration'] = {'normal_xy':[nx,ny], 'shift_mm':shift,
        'offset_mm':offset_mm, 'support_ids':[id for value,id in candidates if abs(value-face)<.01]}
    placed['warnings'] = [{'code':'facade_placement', 'message':
        f'Внутренняя грань фасада привязана к наружной грани каркаса. Отступ наружу: {offset_mm:g} мм.'}]
    return placed


def _read(path, ezdwg):
    path = str(path)
    doc = ezdwg.read(path)
    layers = {v['handle']: k for k, v in doc.layers().items()}
    names = dict(ezdwg.raw.decode_block_header_names(path))
    headers = sorted(h for h, _, _, _, t, _ in ezdwg.raw.list_object_headers_with_type(path)
                     if t == 'BLOCK_HEADER')
    parts = defaultdict(list)
    for e in doc.modelspace().query('TEXT LINE CIRCLE'):
        layer = layers.get(e.dxf.get('layer_handle'), '')
        if layer not in {'0_UPB_VIEW_LABEL', '0_UPB_GRID', '0_UPB_WALL', '0_UPB_MARKS',
                         '0_UPB_COLUMN', '0_UPB_ALL'}:
            continue
        # Tekla's exploded export serializes each Part/Mark/GridLine/LevelMark
        # header followed by that object's model-space primitives.
        index = bisect_right(headers, e.handle) - 1
        if index >= 0:
            parts[layer, headers[index], names.get(headers[index], '')].append((e.dxftype, e.dxf))
    return parts


def _bounds(lines):
    pts = [p[k] for t, p in lines if t == 'LINE' for k in ('start', 'end')]
    if pts:
        return (min(p[0] for p in pts), min(p[1] for p in pts),
                max(p[0] for p in pts), max(p[1] for p in pts))


def _levels(groups):
    origins = []
    for items in groups:
        labels = [p['text'] for t, p in items if t == 'TEXT']
        if len(labels) != 1 or not re.fullmatch(r'[+−-]?\d+\.\d{3}', labels[0]):
            continue
        # Two diagonal strokes of the level symbol meet at its tip (the datum).
        tips = Counter()
        for t, p in items:
            if t == 'LINE':
                a, b = p['start'], p['end']
                if abs(abs(a[0]-b[0])-2) < .001 and abs(abs(a[1]-b[1])-2) < .001:
                    tips.update((round(q[0], 4), round(q[1], 4)) for q in (a, b))
        for (_, y), count in tips.items():
            if count == 2:
                z = float(labels[0].replace('−','-')) * 1000
                origins.append((z, z - y*SCALE))
    if len({z for z, _ in origins}) < 2 or max(v for _, v in origins)-min(v for _, v in origins) > 1:
        raise DrawingError('Отметки высоты не подтверждают масштаб развёртки 1:100')
    return median(v for _, v in origins)


def _match_marks(marks, walls):
    panels = []
    used = set()
    for label in marks:
        mark = label['text'].strip()
        if mark == '2Р':  # beam annotation on sheet 4
            continue
        if not re.fullmatch(r'(?:Пс(?:ур|у|р)?|ПО)-\d+', mark):
            raise DrawingError(f'Неизвестная марка на слое обозначений изделий: {mark}')
        x, y, _ = label['insert']
        height = label['height']
        width = len(mark) * height * .66
        cx, cy = x + width/2, y + height/2
        candidates = []
        for key, (left, low, right, high) in walls.items():
            if not (left <= x+width and x <= right and low <= cy <= high):
                continue
            gap = max(left-cx, cx-right, 0)
            distance = hypot(cx-(left+right)/2, cy-(low+high)/2)
            candidates.append((gap, distance, key))
        if not candidates:
            raise DrawingError(f'У марки {mark} нет соответствующего контура на развёртке')
        candidates.sort()
        gap, distance, key = candidates[0]
        if len(candidates)>1 and all(abs(a-b)<.001 for a,b in zip(
                (gap, distance), candidates[1][:2])):
            raise DrawingError(f'У марки {mark} несколько равнозначных контуров')
        if key in used:
            raise DrawingError(f'Две марки сопоставлены одной панели: {mark}')
        used.add(key)
        panels.append({'mark': mark, 'physical_key': key, 'bounds': walls[key]})
    if not panels:
        raise DrawingError('В развёртке нет маркированных фасадных панелей')
    return panels


def read_facade(path):
    try:
        import ezdwg
    except ImportError as exc:
        raise DrawingError('Для чтения DWG установите зависимости проекта из requirements.txt') from exc
    try:
        parts = _read(path, ezdwg)
    except (ValueError, RuntimeError, OSError, KeyError, IndexError) as exc:
        raise DrawingError('Не удалось прочитать геометрию DWG') from exc
    finally:
        ezdwg.clear_decode_caches()
    titles, marks, levels, columns = [], [], [], []
    grid, walls = {}, {}
    for (layer, _, name), items in parts.items():
        texts = [p for t, p in items if t == 'TEXT']
        if layer == '0_UPB_VIEW_LABEL':
            titles.extend(p['text'] for p in texts)
        elif layer == '0_UPB_MARKS':
            marks.extend(texts)
        elif layer == '0_UPB_GRID':
            circles = [p for t, p in items if t == 'CIRCLE']
            if len(circles) == len(texts) == 1:
                grid[texts[0]['text']] = circles[0]['center'][0]
        elif layer == '0_UPB_ALL':
            levels.append(items)
        elif layer in ('0_UPB_WALL', '0_UPB_COLUMN') and name.startswith('Part-'):
            b = _bounds(items)
            if b is None or b[2]-b[0] <= .5 or b[3]-b[1] <= .5:
                continue
            if layer == '0_UPB_WALL':
                key = name.split(' - ')[0]
                if key in walls:
                    raise DrawingError('Повтор идентификатора изделия Tekla в одном виде')
                walls[key] = b
            elif b[1] <= 1 and b[3] > 50:
                columns.append((b[0]+b[2])/2)
    if len(titles) != 1:
        raise DrawingError('Нужен один вид развёртки фасада Tekla СМ1')
    title = ' '.join(titles[0].lower().replace('ё','е').split())
    view = VIEWS.get(re.sub(r'\s*[-–]\s*', '-', title).removeprefix('развертка стеновых панелей '))
    if not view:
        raise DrawingError('Неизвестная развёртка фасада СМ1: '+titles[0])
    scope, face, sign = view
    panels = _match_marks(marks, walls)
    return {'scope': scope, 'face': face, 'sign': sign, 'grid': grid, 'columns': sorted(columns),
            'z_origin': _levels(levels), 'panels': panels, 'source_sha256': sha256(path.read_bytes()).hexdigest()}


def diagonal_supports(conn, object_id, axes):
    """Southernmost column on each intermediate grid line of the bevel."""
    centers = []
    for label in ('36', '37', '38'):
        if label not in axes['numeric'] or not {'А', 'Г'} <= axes['letter'].keys():
            raise DrawingError('Для косого фасада нужны оси 36–38 и А–Г')
        target = axes['numeric'][label]
        row = conn.execute("""SELECT x,y FROM elements WHERE object_id=? AND is_current=1
            AND element_type='Колонна' AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?
            ORDER BY y,x LIMIT 1""", (object_id, target-1500, target+1500,
            axes['letter']['А']-1500, axes['letter']['Г']+1500)).fetchone()
        if not row:
            raise DrawingError('Для привязки косого фасада нужна колонна на оси '+label)
        centers.append(list(row))
    return centers


def _frame(d, axes, supports):
    if d['scope'] == 'facade-diagonal':
        cols = d['columns']
        if len(cols) != 5 or len(supports) != 3:
            raise DrawingError('Не найдены пять колонн вида 35–39 для привязки косого фасада')
        a, b, c = supports
        length = dist(a, c)
        if not length or c[0] <= a[0] or c[1] <= a[1]:
            raise DrawingError('Направление колонн косого фасада не совпадает с развёрткой')
        ux, uy = (c[0]-a[0])/length, (c[1]-a[1])/length
        for pos, point in zip(cols[1:4], supports):
            step = (pos-cols[1])*SCALE
            if dist((a[0]+ux*step, a[1]+uy*step), point)>50:
                raise DrawingError('Расстояния между колоннами косого фасада не совпадают с моделью')
        return (a[0]-ux*cols[1]*SCALE, a[1]-uy*cols[1]*SCALE), (ux, uy)
    along_x = not d['face'].isdigit()
    along, across = ('numeric','letter') if along_x else ('letter','numeric')
    fixed = axes[across].get(d['face'])
    common = axes[along].keys() & d['grid'].keys()
    if fixed is None or len(common)<2:
        raise DrawingError(f"В сетке объекта нет опорных осей фасада {d['face']}")
    # The existing plan grid stores axis-label insertion points; their individual
    # offsets vary with label length. Use one rigid translation for the whole view.
    shifts = [axes[along][k] - d['sign']*SCALE*d['grid'][k] for k in common]
    shift = median(shifts)
    if max(abs(v-shift) for v in shifts)>350:
        raise DrawingError('Шаг осей фасада отличается от сетки объекта')
    if along_x:
        return (shift, fixed), (d['sign'], 0)
    return (fixed, shift), (0, d['sign'])


def place_facade(d, axes, supports, thickness, offset, *, frame=None):
    if thickness is None:
        thickness = sum(SECTION_2_2_MM)
    if not isfinite(thickness) or thickness <= 0:
        raise DrawingError('Толщина панели должна быть положительным числом')
    layers = list(SECTION_2_2_MM) if thickness == sum(SECTION_2_2_MM) else None
    if not isfinite(offset):
        raise DrawingError('Некорректный отступ фасада')
    (ox, oy), (ux, uy) = _frame(d, axes, supports)
    longitudinal = 0
    if frame is not None and d['scope'] != 'facade-diagonal':
        longitudinal = station_shift(d,(ox,oy),(ux,uy),frame)
        ox += ux*longitudinal
        oy += uy*longitudinal
    # Viewed from outside: positive depth goes outward, right of the view axis.
    def xy(station, depth):
        return [round(ox+ux*station+uy*depth, 3), round(oy+uy*station-ux*depth, 3)]
    panels = []
    for raw in d['panels']:
        left, low, right, high = raw['bounds']
        left, right = left*SCALE, right*SCALE
        z = round(low*SCALE + d['z_origin'], 3)
        height = round((high-low)*SCALE, 3)
        outer = offset + thickness
        x, y = xy((left+right)/2, (offset+outer)/2)
        num = min(axes['numeric'], key=lambda k: abs(x-axes['numeric'][k]))
        let = min(axes['letter'], key=lambda k: abs(y-axes['letter'][k]))
        panels.append({'physical_key':raw['physical_key'], 'mark':raw['mark'], 'face':d['face'],
            'width_mm':round(right-left, 3), 'height_mm':height, 'thickness_mm':thickness,
            'section_layers_mm':layers,
            'station_registration_mm':longitudinal,
            'x':x, 'y':y, 'z':z, 'elevation_mm':z,
            'outline':[xy(left,offset), xy(right,offset), xy(right,outer), xy(left,outer)],
            'nearest_axis_number':num, 'nearest_axis_letter':let, 'offset_x_mm':round(x-axes['numeric'][num],3),
            'offset_y_mm':round(y-axes['letter'][let],3), 'address':f"Фасад {d['face']}, {num}/{let}, {z/1000:+.3f} м"})
    reference = 'линии центров колонн 36–38' if supports else 'оси '+d['face']
    return {'scope':d['scope'], 'source_sha256':d['source_sha256'], 'target_axes':axes,
            'commit_ready':True, 'panels':panels, 'thickness_mm':thickness, 'section_layers_mm':layers,
            'counts':{'by_mark':dict(Counter(p['mark'] for p in panels))},
            'warnings':[{'code':'facade_placement', 'message':
                f'Панели показаны по габаритам изделий. Отступ внутренней грани от {reference} наружу: {offset:g} мм.'}]}

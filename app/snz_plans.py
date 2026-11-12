"""One A3 sheet per floor: complete work captures, status colours, nonoverlapping marks."""
import json
import math
from collections import defaultdict
from io import BytesIO
from pathlib import Path

from app.models import STATUS_LABELS_RU
from app.snz_policy import order_items


def outline(value):
    try:
        if isinstance(value, str):
            value = json.loads(value)
        result = [(float(p[0]), float(p[1])) for p in value or []]
        if len(result) >= 3 and all(math.isfinite(v) for p in result for v in p):
            return result
    except (ValueError, TypeError, IndexError, KeyError):
        pass
    return []


def points(item):
    result = outline(item.get('outline_json'))
    if result:
        return result
    x, y = float(item['x']), float(item['y'])
    return [(x-150, y-150), (x+150, y-150), (x+150, y+150), (x-150, y+150)]


def bounds(items):
    pts = [p for e in items for p in points(e)]
    return min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts)


def intersects(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def floor_title(floor, elevation=None):
    title = f"Этаж {floor if floor is not None else 'не задан'}"
    return title + (f", отм {elevation/1000:+.3f}" if elevation is not None else ', отметка пола не задана')


def column_levels(items):
    values = set()
    for item in items:
        if not str(item.get('element_type', '')).casefold().startswith('колонн'):
            continue
        value = item.get('elevation_mm')
        if isinstance(value, (int, float)) and math.isfinite(value):
            values.add(value)
    return sorted(values)


def plan_pages(order, context, zones=(), max_labels=None, floor_levels=()):
    """Saved work geometry, live statuses and full captures across all cranes.

    Legacy max_labels/floor_levels arguments remain accepted without splitting
    floors or substituting a manual level for the minimum column base.
    """
    from shapely.geometry import Polygon, box
    selected = order_items(order)
    current = {e['id']: e for e in context}
    active = {eid: {**e, 'current_status':
                   (e if order.get('closed_at') or e.get('closed') else current.get(eid, e)).get('current_status', 'planned')}
              for eid, e in selected.items()}
    by_id = {z['id']: z for z in zones}
    by_name = defaultdict(list)
    for zone in zones:
        by_name[zone['name']].append(zone)
    floors = defaultdict(dict)
    for eid, item in active.items():
        floors[item.get('floor')][eid] = item
    pages = []
    for floor, members in sorted(floors.items(), key=lambda kv: (kv[0] is None, kv[0] or 0)):
        backdrop = [e for e in context if e.get('floor') == floor and e.get('is_current', 1)]
        captures, regions, unknown = {}, [], []
        for item in members.values():
            zone = by_id.get(item.get('zone_zakhvatka_id'))
            if zone is None and len(by_name.get(item.get('zakhvatka'), [])) == 1:
                zone = by_name[item['zakhvatka']][0]
            if zone is None:
                unknown.append(item)
            else:
                captures[zone['id']] = zone
        for zone in captures.values():
            poly = outline(zone.get('outline_json'))
            if poly:
                shape = Polygon(poly)
                regions.append(shape if shape.is_valid else box(*shape.bounds))
            else:
                related = [e for e in [*backdrop, *members.values()]
                           if e.get('zone_zakhvatka_id') == zone['id']
                           or (not e.get('zone_zakhvatka_id') and e.get('zakhvatka') == zone['name'])]
                if related:
                    regions.append(box(*bounds(related)))
        for item in unknown:
            b = bounds([item])
            regions.append(box(b[0]-1000, b[1]-1000, b[2]+1000, b[3]+1000))

        def visible(item):
            if item.get('zone_zakhvatka_id') in captures:
                return True
            if not item.get('zone_zakhvatka_id') and any(item.get('zakhvatka') == z['name'] for z in captures.values()):
                return True
            shape = Polygon(points(item))
            if not shape.is_valid:
                shape = box(*shape.bounds)
            return any(region.intersects(shape) for region in regions)

        items = {e['id']: e for e in backdrop if visible(e)}
        items.update(members)
        geometry = [*items.values(), *({'outline_json': list(r.exterior.coords)} for r in regions if not r.is_empty)]
        names = [z['name'] for z in captures.values()]
        if unknown:
            names.append('Участок без назначенной захватки')
        levels = column_levels(backdrop) or column_levels(members.values())
        pages.append({'floor': floor, 'title': floor_title(floor, min(levels) if levels else None),
                      'zone': ', '.join(dict.fromkeys(names)), 'zones': list(captures.values()),
                      'items': items, 'active': members, 'bounds': bounds(geometry),
                      'sources': {e['source_file'] for e in items.values()}, 'column_levels': levels})
    return pages


def _fonts():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    fonts = Path(__file__).parent / 'fonts'
    for name, filename in [('SNZ', 'DejaVuSans.ttf'), ('SNZ-Bold', 'DejaVuSans-Bold.ttf')]:
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(fonts/filename)))


def _lines(text, width, font='SNZ', size=10):
    from reportlab.pdfbase import pdfmetrics
    result, line = [], ''
    for word in str(text).split():
        if line and pdfmetrics.stringWidth(line+' '+word, font, size) > width:
            result.append(line); line = ''
        while pdfmetrics.stringWidth(word, font, size) > width:
            n = max(1, int(len(word)*width/pdfmetrics.stringWidth(word, font, size)))
            result.append(word[:n]); word = word[n:]
        line = (line+' '+word).strip()
    return [*result, line] if line else result


class _LabelIndex:
    def __init__(self):
        self.cells = defaultdict(list)

    @staticmethod
    def keys(rect):
        for x in range(math.floor(rect[0]/64), math.floor(rect[2]/64)+1):
            for y in range(math.floor(rect[1]/64), math.floor(rect[3]/64)+1):
                yield x, y

    def overlaps(self, rect):
        return any(intersects(rect, other) for key in self.keys(rect) for other in self.cells[key])

    def add(self, rect):
        for key in self.keys(rect):
            self.cells[key].append(rect)


def place_labels(page, plot, xy, priorities):
    """Lay out every mark first; leaders are drawn beneath all label backgrounds."""
    from reportlab.pdfbase import pdfmetrics
    _fonts()
    left, bottom, width, height = plot
    members = sorted(page['items'].items(), key=lambda pair: (
        pair[0] not in page['active'], pair[1]['y'], pair[1]['x'], pair[0]))
    best = None
    for size in (9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6):
        index, labels, cursors = _LabelIndex(), [], {}
        for eid, item in members:
            priority = priorities.get(str(eid)) if eid in page['active'] else None
            text = ('ДОП - ' if item.get('outside_snz') else f'{priority} - ' if priority is not None else '') + str(item.get('mark') or f'ID {eid}')
            font = 'SNZ-Bold' if eid in page['active'] else 'SNZ'
            tw, th = pdfmetrics.stringWidth(text, font, size)+4, size*1.15+2.5
            b = bounds([item]); x, y = xy((b[0]+b[2])/2, (b[1]+b[3])/2)
            spot = None

            def fits(lx, ly):
                return (left <= lx <= left+width-tw and bottom <= ly <= bottom+height-th
                        and not index.overlaps((lx-.75, ly-.75, lx+tw+.75, ly+th+.75)))

            bx0, by0 = xy(b[0], b[1]); bx1, by1 = xy(b[2], b[3])
            offset = (abs(by1-by0)+th)/2+3
            initial = [0] if eid not in page['active'] or (tw+4 <= abs(bx1-bx0) and th+4 <= abs(by1-by0)) else [offset, -offset]
            for dy in [*initial, *[sign*n*(th+3) for n in range(1, 9) for sign in (1, -1)]]:
                for dx in (0, tw/2+5, -tw/2-5, tw+7, -tw-7, 2*tw+10, -2*tw-10, 3*tw+12, -3*tw-12):
                    lx, ly = x-tw/2+dx, y-th/2+dy
                    if fits(lx, ly):
                        spot = lx, ly; break
                if spot:
                    break
            if spot is None:
                for row in range(max(0, int((height-th)//(th+2)))+1):
                    ly, lx = bottom+row*(th+2), cursors.get(row, left)
                    while lx <= left+width-tw:
                        if fits(lx, ly):
                            spot = lx, ly; cursors[row] = lx+tw+2; break
                        lx += 4
                    if spot:
                        break
            if spot is None:
                break
            lx, ly = spot
            index.add((lx-.75, ly-.75, lx+tw+.75, ly+th+.75))
            labels.append({'id': eid, 'text': text, 'font': font, 'size': size,
                           'rect': (lx, ly, lx+tw, ly+th), 'anchor': (x, y), 'active': eid in page['active']})
        else:
            distances = [math.hypot((r['rect'][0]+r['rect'][2])/2-r['anchor'][0],
                                    (r['rect'][1]+r['rect'][3])/2-r['anchor'][1]) for r in labels]
            score = (sum(d > 40 for d in distances), sum(max(0, d-15) for d in distances))
            if best is None or score < best[0]:
                best = score, labels
            # Prefer a slightly smaller local mark over hundreds of long crossing leaders.
            if max(distances, default=0) <= 100 and score[0] <= max(2, len(labels)*.02) and sum(d > 15 for d in distances) <= max(3, len(labels)*.10):
                return labels
    if best is not None:
        return best[1]
    raise ValueError('На листе А3 недостаточно места для всех марок без перекрытия при читаемом кегле.')


def leader_segments(start, end, labels):
    """Clip leader lines around every text box instead of whitening the surroundings."""
    dx, dy = end[0]-start[0], end[1]-start[1]
    hidden = []
    for label in labels:
        r = label['rect']; rect = r[0]-1, r[1]-1, r[2]+1, r[3]+1
        low, high = 0., 1.
        for pos, delta, lower, upper in [(start[0], dx, rect[0], rect[2]), (start[1], dy, rect[1], rect[3])]:
            if abs(delta) < 1e-10:
                if not lower <= pos <= upper:
                    low, high = 1., 0.; break
            else:
                a, b = sorted(((lower-pos)/delta, (upper-pos)/delta))
                low, high = max(low, a), min(high, b)
        if low <= high:
            hidden.append((low, high))
    segments, cursor = [], 0.
    for low, high in sorted(hidden):
        if low > cursor:
            segments.append((cursor, low))
        cursor = max(cursor, high)
    if cursor < 1:
        segments.append((cursor, 1.))
    return [((start[0]+a*dx, start[1]+a*dy), (start[0]+b*dx, start[1]+b*dy))
            for a, b in segments if (b-a)*math.hypot(dx, dy) > .3]


def build_floor_plans(order, context, axes, zones=(), status_colors=None, floor_levels=()):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase import pdfmetrics
    _fonts()
    palette = status_colors or {}

    def color(status):
        try:
            return HexColor(palette.get(status) or '#9aa0a6')
        except (ValueError, TypeError):
            return HexColor('#9aa0a6')

    output = BytesIO(); pdf = canvas.Canvas(output, pagesize=landscape(A3))
    pdf.setTitle('СНЗ - поэтажные планы')
    pages = plan_pages(order, context, zones, floor_levels=floor_levels)
    priorities = order.get('item_priorities', {})
    if not pages:
        pdf.setFont('SNZ-Bold', 18); pdf.drawString(35, landscape(A3)[1]-45, 'СНЗ без работ после исправления состава')
        pdf.setFont('SNZ', 11); pdf.drawString(35, landscape(A3)[1]-70, 'Исходный состав сохранён в истории редакций СНЗ.')
        pdf.showPage()
    for number, page in enumerate(pages, 1):
        xmin, ymin, xmax, ymax = page['bounds']
        w, h = landscape(A3) if xmax-xmin >= ymax-ymin else A3
        pdf.setPageSize((w, h)); pdf.bookmarkPage(f'page-{number}')
        pdf.addOutlineEntry(page['title'], f'page-{number}')
        pdf.setFillColor(HexColor('#0F172A')); pdf.setFont('SNZ-Bold', 17)
        pdf.drawString(35, h-33, page['title'])
        subtitle = f"{order.get('object_name', '')} | {order['date']} | {order.get('report_title') or ('День' if order['shift']=='day' else 'Ночь')} | {order['crew']['name']}"
        y = h-52
        for text, font in [(subtitle, 'SNZ'), ('Захватки: '+page['zone'], 'SNZ-Bold')]:
            pdf.setFont(font, 10)
            for line in _lines(text, w-70, font):
                pdf.drawString(35, y, line); y -= 13
        left, bottom, width, height = 68, 110, w-136, y-30-110
        pad = 500; xmin -= pad; ymin -= pad; xmax += pad; ymax += pad
        scale = min(width/max(1, xmax-xmin), height/max(1, ymax-ymin))
        ox = left+(width-(xmax-xmin)*scale)/2; oy = bottom+(height-(ymax-ymin)*scale)/2

        def xy(x, y):
            return ox+(x-xmin)*scale, oy+(y-ymin)*scale

        pdf.setStrokeColor(HexColor('#CBD5E1')); pdf.setLineWidth(.55)
        used_axes = set()
        for axis in axes:
            key = axis['kind'], axis['coord'], str(axis['label'])
            if axis['source_file'] not in page['sources'] or key in used_axes:
                continue
            used_axes.add(key); coord = axis['coord']
            if axis['kind'] == 'numeric' and xmin <= coord <= xmax:
                x, _ = xy(coord, ymin); pdf.line(x, bottom, x, bottom+height)
                bubbles = [(x, bottom-18), (x, bottom+height+14)]
            elif axis['kind'] == 'letter' and ymin <= coord <= ymax:
                _, y = xy(xmin, coord); pdf.line(left, y, left+width, y)
                bubbles = [(left-20, y), (left+width+20, y)]
            else:
                continue
            for tx, ty in bubbles:
                label = str(axis['label']); radius = max(11, pdfmetrics.stringWidth(label, 'SNZ-Bold', 11)/2+4)
                pdf.setFillColor(HexColor('#FFFFFF')); pdf.circle(tx, ty, radius, fill=1, stroke=1)
                pdf.setFillColor(HexColor('#334155')); pdf.setFont('SNZ-Bold', 11); pdf.drawCentredString(tx, ty-4, label)
        for zone in page['zones']:
            poly = outline(zone.get('outline_json'))
            if not poly:
                continue
            pdf.saveState(); pdf.setStrokeColor(HexColor('#64748B')); pdf.setDash(5, 4); pdf.setLineWidth(.7)
            path = pdf.beginPath()
            for i, p in enumerate(poly):
                (path.moveTo if i == 0 else path.lineTo)(*xy(*p))
            path.close(); pdf.drawPath(path, fill=0, stroke=1); pdf.restoreState()
        for eid, item in sorted(page['items'].items(), key=lambda pair: pair[0] in page['active']):
            active = eid in page['active']
            pdf.saveState()
            pdf.setFillColor(color(item.get('current_status'))); pdf.setStrokeColor(HexColor('#0F172A'))
            pdf.setFillAlpha(1 if active else .3); pdf.setStrokeAlpha(1 if active else .3)
            pdf.setLineWidth(1.4 if active else .65)
            path = pdf.beginPath()
            for i, p in enumerate(points(item)):
                (path.moveTo if i == 0 else path.lineTo)(*xy(*p))
            path.close(); pdf.drawPath(path, fill=1, stroke=1); pdf.restoreState()
        labels = place_labels(page, (left, bottom, width, height), xy, priorities)
        pdf.setStrokeColor(HexColor('#475569')); pdf.setLineWidth(.45)
        for label in labels:
            lx, ly, rx, ry = label['rect']; x, y = label['anchor']
            if abs((lx+rx)/2-x) > 3 or abs((ly+ry)/2-y) > 3:
                for a, b in leader_segments((x, y), ((lx+rx)/2, (ly+ry)/2), labels):
                    pdf.line(*a, *b)
        for label in labels:
            lx, ly, rx, ry = label['rect']
            if label['active']:
                pdf.setFillColor(HexColor('#FFFFFF')); pdf.rect(lx, ly, rx-lx, ry-ly, fill=1, stroke=0)
            pdf.setFillColor(HexColor('#0F172A')); pdf.setFont(label['font'], label['size'])
            pdf.drawString(lx+2, ly+3, label['text'])
        pdf.setFont('SNZ', 8.5); pdf.setFillColor(HexColor('#334155'))
        caption = 'Изделия СНЗ: прозрачность 0%; окружение: 70%. Номер - очередь монтажа; ДОП - вне СНЗ.'
        if not page['column_levels']:
            caption += ' Отметка низа колонн этажа не задана.'
        if order.get('closed_at') or any(e.get('closed') for e in page['active'].values()):
            caption += ' Статусы закрытых СНЗ зафиксированы при закрытии.'
        for i, line in enumerate(_lines(caption, w-70, size=8.5)):
            pdf.drawString(35, 70-i*11, line)
        x, y = 35, 38
        for status in dict.fromkeys(e.get('current_status', 'planned') for e in page['items'].values()):
            text = STATUS_LABELS_RU.get(status, status); item_width = pdfmetrics.stringWidth(text, 'SNZ', 9)+35
            if x+item_width > w-35:
                x, y = 35, y-16
            pdf.setFillColor(color(status)); pdf.rect(x, y-2, 12, 10, fill=1, stroke=0)
            pdf.setFillColor(HexColor('#334155')); pdf.setFont('SNZ', 9); pdf.drawString(x+17, y, text); x += item_width
        pdf.drawRightString(w-35, 9, f'Лист {number} из {len(pages)} - А3'); pdf.showPage()
    pdf.save()
    return output.getvalue()

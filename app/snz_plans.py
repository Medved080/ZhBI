"""Readable vector floor plans, cropped to the work zones of a shift order."""
import json
import math
from collections import defaultdict
from io import BytesIO
from pathlib import Path

from app.models import STATUS_LABELS_RU
from app.snz_policy import order_items


def points(item):
    try:
        value = item.get('outline_json') or []
        if isinstance(value, str):
            value = json.loads(value)
        result = [(float(p[0]), float(p[1])) for p in value]
        if len(result) >= 3 and all(math.isfinite(v) for p in result for v in p):
            return result
    except (ValueError, TypeError, IndexError, KeyError):
        pass
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



def plan_pages(order, context, zones=(), max_labels=80, floor_levels=()):
    """Pure page layout: saved geometry is authoritative, live statuses are an overlay."""
    elevations = {r['floor']: r['elevation_mm'] for r in floor_levels}
    selected = order_items(order)
    current = {e['id']: e for e in context}
    active = {eid: {**e, 'current_status': (e if order.get('closed_at') or e.get('closed') else current.get(eid, e)).get('current_status', 'planned')}
              for eid, e in selected.items()}
    zone_by_id = {z['id']: z for z in zones}
    names = defaultdict(list)
    for z in zones:
        names[z['name']].append(z)
    groups = defaultdict(dict)
    for eid, e in active.items():
        zone = zone_by_id.get(e.get('zone_zakhvatka_id'))
        if zone is None and len(names.get(e.get('zakhvatka'), [])) == 1:
            zone = names[e['zakhvatka']][0]
        key = (e.get('floor'), e['source_file'], zone['id'] if zone else None, e.get('zakhvatka') or '')
        groups[key][eid] = e
    pages = []
    for (floor, source, zid, name), members in sorted(groups.items(), key=lambda kv:(kv[0][0] is None,kv[0][0] or 0,kv[0][1],kv[0][2] is None,kv[0][2] or 0,kv[0][3])):
        zone = zone_by_id.get(zid)
        backdrop = [e for e in context if e.get('floor') == floor and e['source_file'] == source and e.get('is_current', 1)]
        if zone:
            backdrop = [e for e in backdrop if e.get('zone_zakhvatka_id') == zid
                        or (not e.get('zone_zakhvatka_id') and e.get('zakhvatka') == name)]
        else:
            # An unassigned/retired zone cannot expand a page to the entire building.
            b = bounds(members.values()); region = (b[0]-1000, b[1]-1000, b[2]+1000, b[3]+1000)
            backdrop = [e for e in backdrop if intersects(bounds([e]), region)]
        visible = {e['id']: e for e in backdrop}; visible.update(members)
        b = bounds(visible.values())
        queue = [(b, visible, members, 0)]
        chunks = []
        while queue:
            region, items, chosen, depth = queue.pop(0)
            if len(items) <= max_labels or depth >= 12:
                chunks.append((region, items, chosen)); continue
            # Split along the longer axis; labels keep a fixed readable size on each sheet.
            axis = 0 if region[2]-region[0] >= region[3]-region[1] else 1
            centers = sorted(float(e['x' if axis == 0 else 'y']) for e in items.values())
            cut = centers[len(centers)//2]
            low = {eid: e for eid, e in items.items() if float(e['x' if axis == 0 else 'y']) < cut}
            high = {eid: e for eid, e in items.items() if eid not in low}
            if not low or not high:
                # Coincident items cannot be separated geometrically. Continue on separate sheets.
                ids = list(items)
                for offset in range(0, len(ids), max_labels):
                    part = {eid: items[eid] for eid in ids[offset:offset+max_labels]}
                    picked = {eid: e for eid, e in chosen.items() if eid in part}
                    if picked: chunks.append((bounds(part.values()), part, picked))
                continue
            for part in (low, high):
                picked = {eid: e for eid, e in chosen.items() if eid in part}
                if picked: queue.append((bounds(part.values()), part, picked, depth+1))
        for fragment, (region, items, chosen) in enumerate(chunks, 1):
            pages.append({'floor': floor, 'title': floor_title(floor, elevations.get(floor)),
                          'zone': name or 'Участок без назначенной захватки', 'items': items, 'active': chosen,
                          'bounds': region, 'source': source, 'fragment': fragment, 'fragments': len(chunks)})
    return pages


def build_floor_plans(order, context, axes, zones=(), status_colors=None, floor_levels=()):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib.colors import HexColor
    fonts = Path(__file__).parent / 'fonts'
    for name, filename in [('SNZ', 'DejaVuSans.ttf'), ('SNZ-Bold', 'DejaVuSans-Bold.ttf')]:
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(fonts/filename)))
    palette = status_colors or {}
    def color(status):
        try: return HexColor(palette.get(status) or '#9aa0a6')
        except (ValueError, TypeError): return HexColor('#9aa0a6')
    output = BytesIO(); w, h = landscape(A3)
    pdf = canvas.Canvas(output, pagesize=(w, h)); pdf.setTitle('СНЗ - поэтажные планы')
    pages = plan_pages(order, context, zones, floor_levels=floor_levels)
    priorities = order.get('item_priorities', {})
    if not pages:
        pdf.setFont('SNZ-Bold', 18); pdf.drawString(35, h-45, 'СНЗ без работ после исправления состава')
        pdf.setFont('SNZ', 11); pdf.drawString(35, h-70, 'Исходный состав сохранён в истории редакций СНЗ.')
        pdf.showPage()
    for index, page in enumerate(pages, 1):
        title = page['title']
        pdf.bookmarkPage(f'page-{index}'); pdf.addOutlineEntry(title+f" - {page['zone']} - {page['fragment']}", f'page-{index}')
        pdf.setFillColor(HexColor('#0F172A')); pdf.setFont('SNZ-Bold', 17); pdf.drawString(35, h-33, title)
        pdf.setFont('SNZ', 10)
        subtitle = f"{order.get('object_name', '')} | {order['date']} | {order.get('report_title') or ('День' if order['shift']=='day' else 'Ночь')} | {order['crew']['name']}"
        # Metadata wraps rather than shrinking the drawing's labels.
        def draw_text(text, x, y, width, font='SNZ', size=10):
            words = str(text).split(); line = ''; lines = []
            for word in words:
                if line and pdfmetrics.stringWidth(line+' '+word, font, size) > width:
                    lines.append(line); line = word
                else: line = (line+' '+word).strip()
            lines.append(line)
            pdf.setFont(font, size)
            for line in lines:
                pdf.drawString(x, y, line); y -= size+3
            return y
        meta_bottom = draw_text(subtitle, 35, h-52, w-70)
        zone_title = page['zone'] + (f" | Фрагмент {page['fragment']} из {page['fragments']}" if page['fragments'] > 1 else '')
        meta_bottom = draw_text(zone_title, 35, meta_bottom-2, w-70, 'SNZ-Bold', 10)
        left, bottom, width, height = 68, 98, w-136, meta_bottom-30-98
        xmin, ymin, xmax, ymax = page['bounds']
        pad = 500; xmin -= pad; ymin -= pad; xmax += pad; ymax += pad
        scale = min(width/max(1,xmax-xmin), height/max(1,ymax-ymin))
        ox = left+(width-(xmax-xmin)*scale)/2; oy = bottom+(height-(ymax-ymin)*scale)/2
        def xy(x, y): return ox+(x-xmin)*scale, oy+(y-ymin)*scale
        pdf.setStrokeColor(HexColor('#CBD5E1')); pdf.setLineWidth(.55)
        for axis in axes:
            if axis['source_file'] != page['source']: continue
            coord = axis['coord']
            if axis['kind'] == 'numeric' and xmin <= coord <= xmax:
                x, _ = xy(coord, ymin); pdf.line(x,bottom,x,bottom+height)
                bubbles = [(x,bottom-18), (x,bottom+height+14)]
            elif axis['kind'] == 'letter' and ymin <= coord <= ymax:
                _, y = xy(xmin,coord); pdf.line(left,y,left+width,y)
                bubbles = [(left-20,y), (left+width+20,y)]
            else: continue
            for tx, ty in bubbles:
                label = str(axis['label']); radius = max(11, pdfmetrics.stringWidth(label,'SNZ-Bold',11)/2+4)
                pdf.setFillColor(HexColor('#FFFFFF')); pdf.circle(tx,ty,radius,fill=1,stroke=1)
                pdf.setFillColor(HexColor('#334155')); pdf.setFont('SNZ-Bold',11); pdf.drawCentredString(tx,ty-4,label)
        for eid, e in page['items'].items():
            pdf.setFillColor(color(e.get('current_status'))); pdf.setStrokeColor(HexColor('#0F172A'))
            pdf.setLineWidth(1.6 if eid in page['active'] else .65)
            path = pdf.beginPath()
            for i, p in enumerate(points(e)):
                x,y = xy(*p)
                if i == 0: path.moveTo(x,y)
                else: path.lineTo(x,y)
            path.close(); pdf.drawPath(path,fill=1,stroke=1)
        placed = []
        # All marks on the shown portion remain legible, not just the assigned members.
        for eid,e in sorted(page['items'].items(),key=lambda pair: (pair[0] not in page['active'],pair[1]['y'],pair[1]['x'],pair[0])):
            priority = priorities.get(str(eid)) if eid in page['active'] else None
            label = ('ДОП - ' if e.get('outside_snz') else f'{priority} - ' if priority is not None else '') + str(e.get('mark') or f'ID {eid}')
            font = 'SNZ-Bold' if eid in page['active'] else 'SNZ'; size = 9.5
            tw = pdfmetrics.stringWidth(label,font,size)+7; th = 15
            x,y = xy(e['x'],e['y'])
            candidates = [(x-tw/2+dx,y-th/2+dy) for dy in [0,18,-18,36,-36,54,-54,72,-72,90,-90,108,-108]
                          for dx in [0,tw/2+8,-tw/2-8,tw+12,-tw-12]]
            spot = next(((max(left,lx),max(bottom,ly)) for lx,ly in candidates
                         if left <= lx <= left+width-tw and bottom <= ly <= bottom+height-th
                         and not any(intersects((lx-2,ly-2,lx+tw+2,ly+th+2),b) for b in placed)),None)
            if spot is None:
                # Use deterministic spare space; pages are limited to 80 labels.
                for row in range(int(height//17)):
                    for col in range(max(1,int(width//(tw+8)))):
                        lx,ly=left+col*(tw+8),bottom+row*17
                        if not any(intersects((lx-2,ly-2,lx+tw+2,ly+th+2),b) for b in placed):spot=(lx,ly);break
                    if spot:break
            if spot is None: raise ValueError('На листе недостаточно места для читаемых марок изделий.')
            lx,ly=spot;placed.append((lx-2,ly-2,lx+tw+2,ly+th+2))
            pdf.setStrokeColor(HexColor('#475569'));pdf.setLineWidth(.45)
            if abs(lx+tw/2-x)>3 or abs(ly+th/2-y)>3:pdf.line(x,y,lx+tw/2,ly+th/2)
            pdf.setFillColor(HexColor('#FFFFFF'));pdf.rect(lx,ly,tw,th,fill=1,stroke=0)
            pdf.setFillColor(HexColor('#0F172A'));pdf.setFont(font,size);pdf.drawString(lx+3.5,ly+4,label)
        pdf.setFont('SNZ',9);pdf.setFillColor(HexColor('#334155'))
        has_frozen=bool(order.get('closed_at')) or any(e.get('closed') for e in page['active'].values())
        caption='Статусы закрытых СНЗ зафиксированы при закрытии; остальные - на момент выгрузки.' if has_frozen else 'Цвет заливки - статус на момент выгрузки.'
        pdf.drawString(35,65,('Жирный контур - изделия отчёта; ДОП - вне СНЗ. ' if order.get('report_title') else 'Жирный контур и номер - изделия СНЗ. ')+caption)
        x,y=35,45
        for status in dict.fromkeys(e.get('current_status','planned') for e in page['items'].values()):
            label=STATUS_LABELS_RU.get(status,status); item_width=pdfmetrics.stringWidth(label,'SNZ',9)+35
            if x+item_width>w-35:x,y=35,y-17
            pdf.setFillColor(color(status));pdf.rect(x,y-2,12,10,fill=1,stroke=0)
            pdf.setFillColor(HexColor('#334155'));pdf.drawString(x+17,y,label);x+=item_width
        pdf.drawRightString(w-35,17,f'Лист {index} из {len(pages)}');pdf.showPage()
    pdf.save();return output.getvalue()

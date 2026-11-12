"""Fixed A3 mark sizes: in-contour text, short column callouts only."""
import heapq
import math


class LabelLayout(list):
    """Placed labels plus nonfatal omissions; source items remain untouched."""
    def __init__(self):
        super().__init__()
        self.warnings=[]


def mark_size(kind, short_side, long_side):
    """Points on paper, selected by physical type/section, never by page density."""
    kind = str(kind or '').casefold()
    if kind.startswith('колонн'):
        return 6.
    if kind.startswith('плит'):
        return 3.5
    if kind.startswith('ригел'):
        if long_side < 1250:
            return 1.2
        return 3. if short_side >= 500 else 2. if short_side >= 350 else 1.5
    return 3.5


def _offsets(limit, seed=0):
    values = {0., -limit, limit}
    values.update(sign * min(limit, n*.25) for n in range(1, math.ceil(limit/.25)+1) for sign in (-1, 1))
    return sorted(values, key=lambda x: ((x-seed)**2, x))


def _nearby(xs, ys, seedx=0, seedy=0):
    """Visit a potentially large centre grid lazily, nearest positions first."""
    def cost(i, j):
        return (xs[i]-seedx)**2 + (ys[j]-seedy)**2
    queue, seen = [(cost(0, 0), 0, 0)], {(0, 0)}
    while queue:
        _, i, j = heapq.heappop(queue)
        yield xs[i], ys[j]
        for ni, nj in ((i+1, j), (i, j+1)):
            if ni < len(xs) and nj < len(ys) and (ni, nj) not in seen:
                seen.add((ni, nj));heapq.heappush(queue, (cost(ni, nj), ni, nj))


def layout_labels(page, plot, xy, priorities, reserved=()):
    from shapely.geometry import Polygon, box
    from reportlab.pdfbase import pdfmetrics
    from app.snz_plans import _fonts, _LabelIndex, intersects, points
    _fonts()
    left, bottom, width, height = plot
    area = left+2, bottom-14, left+width-2, bottom+height+12
    entries, labels = {}, LabelLayout()
    index = _LabelIndex()
    for rect in reserved:
        index.add(rect)
    for eid, item in page['items'].items():
        physical = Polygon(points(item))
        if not physical.is_valid:
            physical = physical.buffer(0)
        if physical.is_empty:
            raise ValueError(f"Не задан контур изделия {item.get('mark') or eid}.")
        corners = list(physical.minimum_rotated_rectangle.exterior.coords)
        edges = [(math.dist(a, b), a, b) for a, b in zip(corners, corners[1:])]
        longest, a, b = max(edges, key=lambda e:e[0])
        shortest = min(e[0] for e in edges)
        angle = math.degrees(math.atan2(b[1]-a[1], b[0]-a[0]))
        angle = (angle+90) % 180 - 90
        if abs(angle+90)<.001:
            angle=90.
        # Axis-aligned rectangles use the same orientation as the preview.
        if abs(angle)<.001:
            angle=0.
        shape = Polygon([xy(*p) for p in physical.exterior.coords])
        center = shape.centroid
        if not shape.covers(center):
            center = shape.representative_point()
        active = eid in page['active']
        priority = priorities.get(str(eid)) if active else None
        text = ('ДОП - ' if item.get('outside_snz') else f'{priority} - ' if priority is not None else '') + str(item.get('mark') or f'ID {eid}')
        font = 'SNZ-Bold' if active else 'SNZ'
        size = mark_size(item.get('element_type'), shortest, longest)
        entries[eid] = {'id':eid, 'text':text, 'font':font, 'size':size, 'active':active,
                        'shape':shape, 'inside_shape':shape.buffer(.000001), 'anchor':(center.x,center.y), 'angle':angle,
                        'column':str(item.get('element_type','')).casefold().startswith('колонн'),
                        'tw':pdfmetrics.stringWidth(text,font,size)+.16, 'th':size+.08}

    def make(entry, x, y, angle, leader=False):
        tw, th = entry['tw'], entry['th']
        rad = math.radians(angle);c,s=math.cos(rad),math.sin(rad)
        corners = [(x+dx*c-dy*s,y+dx*s+dy*c) for dx,dy in [(-tw/2,-th/2),(tw/2,-th/2),(tw/2,th/2),(-tw/2,th/2)]]
        polygon=Polygon(corners)
        return {**{k:entry[k] for k in ('id','text','font','size','active','anchor','tw','th')},
                'x':x,'y':y,'angle':angle,'leader':leader,'rect':polygon.bounds,'polygon':polygon}

    def candidates(entry):
        shape=entry['shape'];b=shape.bounds;x,y=entry['anchor']
        for angle in (entry['angle'], (entry['angle']+90) % 180):
            original=make(entry,x,y,angle)
            r=original['rect'];hx=(r[2]-r[0])/2;hy=(r[3]-r[1])/2
            mx, my = min(x-b[0],b[2]-x)-hx, min(y-b[1],b[3]-y)-hy
            if mx < -.00001 or my < -.00001:
                continue
            mx,my=max(0,mx),max(0,my)
            # Give coincident short cantilevers room side by side.
            compact=max(b[2]-b[0],b[3]-b[1])<8
            seedx=min(mx,.5) if compact and abs(angle-90)<.01 else 0
            seedy=min(my,.5) if compact and abs(angle)<.01 else 0
            for dx,dy in _nearby(_offsets(mx,seedx),_offsets(my,seedy),seedx,seedy):
                label=make(entry,x+dx,y+dy,angle)
                if entry['inside_shape'].covers(label['polygon']):
                    yield label

    inside = sorted((e for e in entries.values() if not e['column']),
                    key=lambda e:(e['shape'].area,not e['active'],e['id']))
    failed=[]
    for entry in inside:
        for label in candidates(entry):
            if not index.overlaps(label['rect']):
                labels.append(label);index.add(label['rect']);break
        else:
            failed.append(entry)
    # A centred inner profile can block both ends of a larger coincident one.
    # Move that mark within its own outline; never reduce its fixed font size.
    for entry in failed:
        placed=False
        for label in candidates(entry):
            blockers=[l for l in labels if intersects(l['rect'],label['rect'])]
            if len(blockers)!=1 or any(intersects(label['rect'],r) for r in reserved):
                continue
            blocker=blockers[0]
            for moved in candidates(entries[blocker['id']]):
                if intersects(label['rect'],moved['rect']) or any(intersects(moved['rect'],r) for r in reserved):
                    continue
                if any(intersects(moved['rect'],l['rect']) for l in labels if l is not blocker):
                    continue
                labels[labels.index(blocker)]=moved;labels.append(label)
                placed=True;break
            if placed:
                break
        if not placed:
            labels.warnings.append(f"Марка «{entry['text']}» не поместилась внутри контура при размере {entry['size']:g} pt.")
    index=_LabelIndex()
    for rect in [*reserved,*(l['rect'] for l in labels)]:
        index.add(rect)
    column_area=box(*area)
    column_offsets=sorted((math.hypot(dx,dy),dx,dy) for dx in range(-40,41,2) for dy in range(-36,37,2))
    for entry in sorted((e for e in entries.values() if e['column']), key=lambda e:(e['anchor'][1],e['anchor'][0],e['id'])):
        x,y=entry['anchor'];keepout=entry['shape'].buffer(1)
        for _,dx,dy in column_offsets:
            label=make(entry,x+dx,y+dy,0,True)
            if not column_area.covers(label['polygon']) or keepout.intersects(label['polygon']):
                continue
            if not index.overlaps(label['rect']):
                labels.append(label);index.add(label['rect']);break
        else:
            labels.warnings.append(f"Для колонны «{entry['text']}» не нашлось места для короткой выноски.")
    return labels

"""Project independent SNZ items from the ends of current beams and their supports."""
import hashlib
import json
import math
import re
from collections import defaultdict

from shapely.errors import GEOSException
from shapely.geometry import Polygon

JOINT_TYPE = 'Узел ригель-колонна'
ABSENT = 'joint_absent'
REBAR = 'joint_rebar'
CONCRETE = 'joint_concrete'
REBAR_OP = 'joint_reinforcement'
CONCRETE_OP = 'joint_concreting'
CARD_ID = 'beam_column_joint'
STATUS_LABELS = {ABSENT: 'Отсутствует', REBAR: 'Армирование', CONCRETE: 'Бетонирование'}
END_TOLERANCE = 1000  # Same end-to-column tolerance as the 3D model, in mm.
COLUMN_STACK_TOLERANCE = 100


def joint_id(column, elevation):
    # Negative IDs are external to the elements table. ElementUID survives DXF
    # reimports; source and handle are unsuitable because a new drawing changes them.
    identity = column.get('element_uid') or column['id']
    key = f"{identity}:{elevation:.3f}".encode()
    # Keep the number exact in both JS and the 15-digit Excel export.
    return -1 - (int.from_bytes(hashlib.sha256(key).digest()[:8], 'big') >> 15)


def joint_status(facts, eid):
    if facts.get(f'e:{eid}:{CONCRETE_OP}', {}).get('completed'):
        return CONCRETE
    if facts.get(f'e:{eid}:{REBAR_OP}', {}).get('completed'):
        return REBAR
    return ABSENT


def plannable(element):
    return element['current_status'] in ('ready_for_installation', ABSENT, REBAR)


def joint_state(conn, object_id):
    row = conn.execute('SELECT revision,data_json FROM snz_state WHERE object_id=?', (object_id,)).fetchone()
    return (row['revision'], json.loads(row['data_json'])) if row else (0, {})


def joint_changes(state):
    changes = {a['element_id']: {'id': a['element_id'], 'planned_installation_date': a['date']}
               for a in state.get('assignments', []) if a['element_id'] < 0}
    facts = state.get('facts', {})
    for key in facts:
        if key.startswith('e:-') and key.endswith((':' + REBAR_OP, ':' + CONCRETE_OP)):
            eid = int(key.split(':')[1])
            changes.setdefault(eid, {'id': eid})
    for eid, item in changes.items():
        item['current_status'] = joint_status(facts, eid)
    return list(changes.values())


def _rectangle(element):
    try:
        points = element.get('outline') or json.loads(element.get('outline_json') or '[]')
        polygon = Polygon(points)
        rectangle = polygon.minimum_rotated_rectangle
        if rectangle.geom_type == 'Polygon' and rectangle.area > 0:
            return list(rectangle.exterior.coords)[:4]
    except (ValueError, TypeError, IndexError, GEOSException):
        pass
    return None


def _length(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _midpoint(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _cell(point):
    return tuple(math.floor(coord / END_TOLERANCE) for coord in point)


def _stance_key(element, flow, zones, floor):
    stance_id = element.get('zone_stance_id')
    stance = zones.get(stance_id, {})
    crane = zones.get(element.get('zone_crane_id'), {})
    order = flow.get((crane.get('name'), stance.get('name'), floor))
    number = stance.get('number')
    if number is None:
        match = re.search(r'\d+', stance.get('name') or '')
        number = int(match[0]) if match else math.inf
    return (not bool(stance), order if order and order > 0 else math.inf, number,
            not bool(element.get('zone_crane_id')), not bool(element.get('zone_zakhvatka_id')))


def build_joints(conn, object_id, elements, state=None):
    if not any(e['element_type'] == 'Ригель' and e.get('is_current', 1) for e in elements):
        return []
    cells = defaultdict(list)
    beams = []
    for element in elements:
        z = element.get('elevation_mm')
        kind = element['element_type']
        if z is None or not element.get('is_current', 1) or kind not in ('Колонна', 'Ригель'):
            continue
        rectangle = _rectangle(element)
        if not rectangle:
            continue
        if kind == 'Колонна':
            center = _midpoint(rectangle[0], rectangle[2])
            cells[_cell(center)].append((element, center, rectangle))
        else:
            a, b, c, d = rectangle
            if _length(a, b) < _length(b, c):
                a, b, c, d = b, c, d, a
            beams.append((element, _length(b, c), (_midpoint(a, d), _midpoint(b, c))))
    def nearby(point):
        x, y = _cell(point)
        return [col for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for col in cells.get((x + dx, y + dy), ())]

    connections = {}
    for beam, width, ends in beams:
        z = beam['elevation_mm']
        for end in ends:
            candidates = [col for col in nearby(end) if col[0]['elevation_mm'] < z
                          and _length(col[1], end) <= END_TOLERANCE]
            if not candidates:
                continue
            nearest = min(candidates, key=lambda col: (_length(col[1], end), col[0]['id']))
            stack = [col for col in nearby(nearest[1]) if _length(col[1], nearest[1]) <= COLUMN_STACK_TOLERANCE]
            support = min((col for col in stack if col[0]['elevation_mm'] < z),
                          key=lambda col: (-col[0]['elevation_mm'], _length(col[1], end), col[0]['id']))
            group = connections.setdefault((support[0]['id'], z), (support, stack, []))
            group[2].append((beam, width, end))

    if not connections:
        return []
    zones = {r['id']: dict(r) for r in conn.execute(
        'SELECT id,name,number FROM zones WHERE object_id=? AND is_current=1', (object_id,))}
    from app.schedule_calc import _flow
    flow = _flow(conn, object_id)
    if state is None:
        _, state = joint_state(conn, object_id)
    facts = state.get('facts', {})
    dates = {a['element_id']: a['date'] for a in state.get('assignments', [])}
    result = []
    seen_ids = set()
    for (_, z), (support, stack, connected) in sorted(connections.items()):
        column, center, rectangle = support
        eid = joint_id(column, z)
        if eid in seen_ids:
            raise ValueError('Повторяющийся идентификатор узла ригель-колонна')
        seen_ids.add(eid)
        beam = min((beam for beam, _, _ in connected),
                   key=lambda e: (_stance_key(e, flow, zones, e.get('floor')), e['id']))
        floor = beam.get('floor')
        # Transfer the analytics together from one neighbor. The beam level is
        # the joint's own level even if the column starts on a lower floor.
        donor = min((beam, column), key=lambda e: _stance_key(e, flow, zones, floor))
        outline = _gap_outline(rectangle, center, connected)
        joint = {key: donor.get(key) for key in (
            'zone_crane_id', 'zone_stance_id', 'zone_zakhvatka_id', 'zone_crane_status',
            'zone_stance_status', 'zone_zakhvatka_status', 'work_group_id', 'capture_assignment_mode')}
        for kind in ('crane', 'stance', 'zakhvatka'):
            joint[kind] = zones.get(joint[f'zone_{kind}_id'], {}).get('name')
        joint.update(id=eid, object_id=object_id, element_type=JOINT_TYPE, subtype='',
                     layer=JOINT_TYPE, mark=f"Узел · {column.get('address') or column['id']} · {z / 1000:+.3f}",
                     current_status=joint_status(facts, eid), elevation_mm=z, floor=floor,
                     x=center[0], y=center[1], outline=outline, outline_json=json.dumps(outline),
                     height_mm=max(width for _, width, _ in connected), is_current=1,
                     planned_installation_date=dates.get(eid), source_file=column['source_file'],
                     column_ids=sorted(col['id'] for col, _, _ in stack),
                     beam_ids=sorted({e['id'] for e, _, _ in connected}))
        for key in ('address', 'axis_number', 'axis_letter', 'axis_status'):
            joint[key] = column.get(key)
        result.append(joint)
    return result


def _gap_outline(rectangle, center, connected):
    """Extend the shaft's footprint up to the nearby beam end faces."""
    a, b, _, d = rectangle
    ab, ad = _length(a, b), _length(a, d)
    ux, uy = (b[0] - a[0]) / ab, (b[1] - a[1]) / ab
    vx, vy = (d[0] - a[0]) / ad, (d[1] - a[1]) / ad
    lo_u, hi_u, lo_v, hi_v = -ab / 2, ab / 2, -ad / 2, ad / 2
    for _, _, end in connected:
        dx, dy = end[0] - center[0], end[1] - center[1]
        u, v = dx * ux + dy * uy, dx * vx + dy * vy
        if abs(u) / ab >= abs(v) / ad:
            lo_u, hi_u = min(lo_u, u), max(hi_u, u)
        else:
            lo_v, hi_v = min(lo_v, v), max(hi_v, v)
    return [[center[0] + u * ux + v * vx, center[1] + u * uy + v * vy]
            for u, v in ((lo_u, lo_v), (hi_u, lo_v), (hi_u, hi_v), (lo_u, hi_v))]


def seed_joint_card(state):
    if state.get('joint_catalog_seeded'):
        return
    # Borrow the existing team's assignment when the standard operations have
    # been customized. A project can edit the new dictionary rows afterwards.
    operations = {op['id']: op for op in state['operations']}
    for key, source, name in ((REBAR_OP, 'rebar1', STATUS_LABELS[REBAR]),
                              (CONCRETE_OP, 'concrete1', STATUS_LABELS[CONCRETE])):
        if key not in operations:
            team = operations.get(source, {}).get('team', state['teams'][0]['id'])
            state['operations'].append(dict(id=key, name=name, team=team, scope='element'))
    if not any(card['element_type'] == JOINT_TYPE for card in state['cards']):
        state['cards'].append(dict(id=CARD_ID, name=JOINT_TYPE, element_type=JOINT_TYPE, subtype='',
                                   steps=[dict(operation_id=key, minutes=None, wait_after=0)
                                          for key in (REBAR_OP, CONCRETE_OP)]))
    state['joint_catalog_seeded'] = True

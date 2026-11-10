"""Contiguous montage positions within one date, shift and installation crew."""


def normalize_montage(state, locked=()):
    locked = set(locked)
    scopes = {}
    for assignment in state['assignments']:
        key = (assignment['date'], assignment['shift'], assignment['crew_id'])
        scopes.setdefault(key, []).append(assignment)
    for rows in scopes.values():
        # An issued assignment stays byte-for-byte unchanged. Its document has
        # its own immutable numbering; only editable plans are normalized here.
        if any(a['element_id'] in locked for a in rows):
            continue
        rows.sort(key=lambda a: a['priority'] if a['priority'] is not None else 10**9)
        for index, assignment in enumerate(rows, 1):
            assignment['priority'] = index


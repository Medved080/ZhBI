"""Copy to app/shaft_panels_scope.py and wire all three helpers as documented.

These helpers take the existing DB connection and never commit.
"""


def exclude_shaft_panels(conn,object_id,existing_rows):
    ids={r[0] for r in conn.execute('SELECT element_id FROM shaft_panel_geometry WHERE object_id=?',(object_id,))}
    return [r for r in existing_rows if r['id'] not in ids]


def assert_standard_match(conn,object_id,match):
    """Defense in depth immediately before element_sync.apply_import writes."""
    ids={r[0] for r in conn.execute('SELECT element_id FROM shaft_panel_geometry WHERE object_id=?',(object_id,))}
    touched={m.element_id for m in match.matched}|set(match.retired_ids)
    if ids&touched:
        raise ValueError('Обычный импорт DXF не может обновлять или исключать панели отдельной развертки')


def register_primary_drawing(conn,object_id,source_file):
    """Replacement body for element_sync._register_drawing, preserving overlays."""
    supplemental={r[0] for r in conn.execute('''SELECT DISTINCT e.source_file FROM elements e
        JOIN shaft_panel_geometry g ON g.element_id=e.id WHERE g.object_id=?''',(object_id,))}
    if source_file in supplemental:
        raise ValueError('Это источник панелей шахт; используйте отдельный импорт')
    for r in conn.execute('SELECT source_file FROM object_drawings WHERE object_id=?',(object_id,)).fetchall():
        if r[0] not in supplemental:
            conn.execute('UPDATE object_drawings SET is_current=0 WHERE object_id=? AND source_file=?',(object_id,r[0]))
    conn.execute('''INSERT INTO object_drawings (object_id,source_file,is_current,imported_at)
        VALUES (?,?,1,datetime('now')) ON CONFLICT(object_id,source_file) DO UPDATE SET
        is_current=1,imported_at=datetime('now')''',(object_id,source_file))


def current_drawing_sources(conn,object_id):
    """Use for object-wide selections; explicit historic file selection stays explicit."""
    return [r[0] for r in conn.execute('SELECT source_file FROM object_drawings WHERE object_id=? AND is_current=1 ORDER BY source_file',(object_id,))]

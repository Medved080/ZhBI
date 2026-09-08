"""Compatibility test on an in-memory copy of the anonymized service DB."""
import argparse
import json
from pathlib import Path
import sqlite3
from app.shaft_panels import parse_drawing,place_panels
from app.shaft_panels.storage import install_schema,load_target_axes,analyze,apply


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--db',type=Path,required=True);ap.add_argument('--object-id',type=int,required=True)
    ap.add_argument('--dxf',type=Path,required=True);ap.add_argument('--out',type=Path,required=True)
    args=ap.parse_args()
    if args.db.name=='zhbi.db':ap.error('Use an anonymized/test copy')
    src=sqlite3.connect(args.db.resolve().as_uri()+'?mode=ro',uri=True)
    conn=sqlite3.connect(':memory:');src.backup(conn);src.close()
    conn.row_factory=sqlite3.Row;conn.execute('PRAGMA foreign_keys=ON')
    before={r['id']:dict(r) for r in conn.execute('SELECT * FROM elements')}
    fk_before={tuple(r) for r in conn.execute('PRAGMA foreign_key_check')}
    install_schema(conn);conn.commit();axes,_=load_target_axes(conn,args.object_id)
    placed=place_panels(parse_drawing(args.dxf),axes,thickness_mm=60.)
    def commit():return apply(conn,analyze(conn,args.object_id,placed),placed,user_id=1,
                              acknowledged_warnings=[w['code'] for w in placed['warnings']])
    first=commit();second=commit()
    for row in conn.execute('SELECT * FROM elements'):
        if row['id'] in before:
            assert all(row[k]==v for k,v in before[row['id']].items()),'Existing element changed'
    fk_after={tuple(r) for r in conn.execute('PRAGMA foreign_key_check')}
    assert fk_after==fk_before,'New foreign key violations'
    assert first['new']==184 and second['new']==0 and second['unchanged']==184
    report={'source':'read-only anonymized SQLite -> in-memory backup',
            'existing_elements_unchanged':len(before),'first_import':first,'repeat_import':second,
            'existing_foreign_key_violations':len(fk_before),'new_foreign_key_violations':len(fk_after-fk_before),
            'thickness_60_mm':'synthetic test input only, not a product dimension'}
    args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False));conn.close()


if __name__=='__main__':main()

"""Read-only CLI: DXF -> JSON/CSV/SVG/HTML. Never writes to service DB."""
import argparse
import csv
import json
from pathlib import Path
import sqlite3
from .parser import parse_drawing
from .placement import place_panels
from .storage import load_target_axes
from .report import write_report


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('dxf',type=Path)
    ap.add_argument('--out',type=Path,required=True)
    axes=ap.add_mutually_exclusive_group()
    axes.add_argument('--axes-json',type=Path)
    axes.add_argument('--db-readonly',type=Path)
    ap.add_argument('--object-id',type=int)
    ap.add_argument('--grid-source')
    ap.add_argument('--thickness-mm',type=float)
    args=ap.parse_args()
    drawing=parse_drawing(args.dxf)
    target=drawing['axes']
    frame='Координаты плана DXF (без привязки к объекту)'
    if args.axes_json:
        target=json.loads(args.axes_json.read_text());frame='Координаты заданной сетки объекта'
    elif args.db_readonly:
        if args.object_id is None:
            ap.error('--db-readonly requires --object-id')
        # Never allow accidental inspection of the live DB from this kit.
        if args.db_readonly.name=='zhbi.db':
            ap.error('Используйте обезличенную/проверочную копию БД')
        conn=sqlite3.connect(args.db_readonly.resolve().as_uri()+'?mode=ro',uri=True)
        conn.row_factory=sqlite3.Row
        try:
            target,source=load_target_axes(conn,args.object_id,args.grid_source)
            frame=f'Сетка объекта #{args.object_id}: {source}'
        finally:
            conn.close()
    placed=place_panels(drawing,target,thickness_mm=args.thickness_mm)
    placed['coordinate_frame']=frame
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'panels.json').write_text(json.dumps(placed,ensure_ascii=False,indent=2),encoding='utf-8')
    fields=['handle','mark','element_type','shaft','face','width_mm','height_mm','area_m2','x','y','z',
            'thickness_mm','address','physical_key','mark_method','mark_distance_mm']
    with (args.out/'panels.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fields,extrasaction='ignore',delimiter=';');writer.writeheader();writer.writerows(placed['panels'])
    write_report(placed,args.out)
    print(json.dumps({'counts':placed['counts'],'registration':placed['registration'],
                      'commit_ready':placed['commit_ready'],'output':str(args.out.resolve())},ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()

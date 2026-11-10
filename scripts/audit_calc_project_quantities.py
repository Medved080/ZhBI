"""Read-only reconciliation of linked project elements and the supplied commercial XLSX."""
import argparse
import csv
import json
import sqlite3
import sys
from collections import defaultdict, Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.calc.export_reference import source_rows, title_marks
from app.calc.marks import normalize


def audit(database, output, project_name='Москвич'):
    conn=sqlite3.connect(f'file:{Path(database).resolve()}?mode=ro',uri=True)
    conn.row_factory=sqlite3.Row
    try:
        projects=conn.execute('SELECT id FROM projects WHERE name=?',(project_name,)).fetchall()
        if len(projects)!=1:
            raise ValueError('Нужен один однозначный проект: '+project_name)
        db, labels, totals=Counter(), {}, Counter()
        for row in conn.execute('SELECT e.element_type,e.mark,o.name FROM elements e JOIN objects o ON o.id=e.object_id WHERE o.project_id=? AND e.is_current=1',(projects[0]['id'],)):
            kind=row['element_type']
            if kind.startswith('Панель'): kind='Панель'
            key=(kind,normalize(row['mark'],True))
            db[key]+=1;labels[key]=row['mark'];totals[row['name']]+=1
    finally:
        conn.close()
    sources, combined, all_file_quantities=defaultdict(list), [], 0
    for row in source_rows():
        marks=title_marks(row['ttnName'])
        keys=list(dict.fromkeys((kind,normalize(mark,True)) for kind,mark in marks))
        qty=row['sourceQuantity']
        if isinstance(qty,(int,float)): all_file_quantities+=qty
        for kind,mark in marks: labels.setdefault((kind,normalize(mark,True)),mark)
        if len(keys)==1: sources[keys[0]].append(row)
        else: combined.append((keys,row))
    records=[];covered=set()
    def record(keys,rows):
        covered.update(keys)
        current=sum(db[key] for key in keys)
        quantities=[r['sourceQuantity'] for r in rows]
        complete=bool(rows) and all(isinstance(q,(int,float)) and int(q)==q for q in quantities)
        source=sum(quantities) if complete else None
        if not rows: status='Нет строки в файле'
        elif not complete: status='Нет полного количества в файле'
        elif not any(key in db for key in keys): status='Нет марки в актуальных элементах проекта'
        else: status='Совпадает' if source==current else 'Расхождение'
        records.append([keys[0][0] if keys else '', ' + '.join(labels[key] for key in keys), current, source,
                        current-source if complete else None, ', '.join(str(r['row']) for r in rows), status])
    for key,rows in sorted(sources.items()): record([key],rows)
    for keys,row in combined: record(keys,[row])
    for key in sorted(set(db)-covered): record([key],[])
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f,delimiter=';')
        writer.writerow(['Вид изделия','Марка изделия','Количество в проекте, шт.','Количество в файле, шт.','Разница проект - файл, шт.','Строки файла КП','Результат'])
        writer.writerows(records)
    # Independent totals also catch a source row that was silently dropped or counted twice.
    assert sum(r[2] for r in records)==sum(db.values()), 'Повторный учёт марки проекта в сверке'
    summary={'project':project_name,'projectTotal':sum(db.values()),'objects':dict(totals),'fileKnownTotal':all_file_quantities,
             'results':dict(Counter(r[-1] for r in records)),'rows':len(records),
             'differences':[r for r in records if r[-1]=='Расхождение'][:15]}
    output.with_suffix('.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database',required=True);p.add_argument('--output',required=True)
    args=p.parse_args();audit(args.database,args.output)

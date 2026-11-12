"""Daily issued plan/closed fact plus unallocated model installation, read-only."""
from datetime import datetime,timedelta
from io import BytesIO
from zoneinfo import ZoneInfo
from app.snz_policy import order_items
from app.snz_montage import status_montage,fact_rows
from app.snz_fact_registry import summarize
from app.snz_fact_store import records
from app.snz_registry import registry
from app.snz_closure import closure_projection


def collect(conn,object_id,state,day):
    from app.snz import _elements
    metadata=registry(conn,object_id,day,include_snapshots=True)
    statuses=status_montage(conn,object_id)
    facts=fact_rows(conn,object_id,state,statuses,day)
    totals=summarize(metadata['orders'],facts,statuses)
    montage={r['id']:r for r in totals['orders']}
    rows=[]
    for meta in metadata['orders']:
        row={**meta,'planned':meta['quantity'],'completed':None}
        if meta['closed_at'] and meta['id'] in montage:
            row['completed']=montage[meta['id']]['completed']
        rows.append(row)
    closed=records(state).get('closed',{})
    snapshots=[closure_projection(o,closed.get(str(o['id']))) for o in metadata['snapshots']]
    planned={eid for o in snapshots for eid in order_items(o)}
    # Explicit attribution wins over a raw timestamp, even if the user assigned
    # an already installed item to a different work date. Stale attributions
    # after rollback/reinstallation do not suppress the new model event.
    attributed=set()
    for batch in records(state)['extra'].values():
        for row in batch['items']:
            eid=row['element']['id'];status=statuses.get(eid,{})
            if status.get('completed_at') and status.get('history_id')==row['history_id']:
                attributed.add(eid)
    start=datetime.fromisoformat(day).replace(hour=8);end=start+timedelta(days=1)
    attributed_rows=[r for r in facts if r.get('extra') and r['id'] in attributed and any(ref['history_id']==statuses.get(r['id'],{}).get('history_id') for ref in r['extra'])]
    unallocated=[]
    for element in _elements(conn,object_id):
        eid=element['id'];status=statuses.get(eid,{})
        if not element.get('is_current',1) or eid in planned or eid in attributed or not status.get('completed_at'):
            continue
        when=datetime.fromisoformat(status['completed_at'])
        if when.tzinfo:
            when=when.astimezone(ZoneInfo('Europe/Moscow')).replace(tzinfo=None)
        if start<=when<end:
            unallocated.append({**element,'completed_at':when.isoformat(timespec='seconds'),
                                'shift':'day' if when<start+timedelta(hours=12) else 'night',
                                'unregistered_montage':True})
    unallocated.sort(key=lambda e:(e['completed_at'],e['id']))
    closed_count=sum(r['completed'] is not None for r in rows)
    return {'date':day,'daily_mode':True,'object_name':conn.execute('SELECT name FROM objects WHERE id=?',(object_id,)).fetchone()[0],
            'snapshots':snapshots,'unallocated':unallocated,'attributed_extra':attributed_rows,
            'registry':{'orders':rows,'planned':sum(r['planned'] for r in rows),
                        'completed':sum(r['completed'] or 0 for r in rows),'has_closed':bool(closed_count),
                        'unassigned_extra':totals['unassigned_extra']},
            'unique_planned':len(planned),'mode':'fact' if not rows and (unallocated or attributed_rows) else 'plan_fact' if closed_count else 'plan'}


def add_unallocated_sheet_block(ws,data):
    """A separate registry below document totals; never counts attributed extra twice."""
    from openpyxl.styles import Font,PatternFill,Alignment
    from openpyxl.worksheet.table import Table,TableStyleInfo
    ws.append(['Уникальных изделий плана, шт',None,None,None,None,data['unique_planned']])
    unique=ws.max_row;ws.merge_cells(start_row=unique,start_column=1,end_row=unique,end_column=5)
    ws.cell(unique,1).font=Font(name='Calibri',size=11);ws.cell(unique,6).font=Font(name='Calibri',size=11)
    ws.row_dimensions[unique].height=28
    ws.append([])
    row=ws.max_row+1
    ws.cell(row,1,f"Без СНЗ — монтаж, не отнесённый через «Доп. факт»: {len(data['unallocated'])} шт.")
    ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=7)
    ws.cell(row,1).font=Font(name='Calibri',size=13,bold=True,color='17365D');ws.row_dimensions[row].height=30
    ws.append(['№','Марка','Тип изделия','Этаж','Оси','Дата и время монтажа (МСК)','Количество, шт'])
    header=ws.max_row
    for number,item in enumerate(data['unallocated'],1):
        ws.append([number,item.get('mark') or f"ID {item['id']}",item['element_type'],item.get('floor'),item.get('address'),
                   datetime.fromisoformat(item['completed_at']),1])
    end=ws.max_row
    if data['unallocated']:
        table=Table(displayName='SNZUnallocatedMontage',ref=f'A{header}:G{end}')
        table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True);ws.add_table(table)
    ws.append(['Итого без СНЗ, шт',None,None,None,None,None,len(data['unallocated'])])
    total=ws.max_row;ws.merge_cells(start_row=total,start_column=1,end_row=total,end_column=6)
    for cells in ws.iter_rows(min_row=header,max_row=total):
        for c in cells:
            if isinstance(c.value,str):c.data_type='s'
            c.font=Font(name='Calibri',size=11)
            c.alignment=Alignment(vertical='center',wrap_text=True)
            if c.row in (header,total):
                c.fill=PatternFill('solid',fgColor='17365D');c.font=Font(name='Calibri',size=11,color='FFFFFF',bold=c.row==header)
        ws.row_dimensions[cells[0].row].height=42 if cells[0].row==header else 32
    for cells in ws.iter_rows(min_row=header+1,max_row=end):
        cells[5].number_format='dd.mm.yyyy hh:mm:ss';cells[6].number_format='#,##0'
        ws.row_dimensions[cells[0].row].height=max(32,15*max((len(str(cells[1].value or ''))+12)//13,(len(str(cells[2].value or ''))+9)//10,1))
    ws.print_area=f'A1:G{ws.max_row}'


def build_xlsx(data):
    from openpyxl import Workbook
    from app.snz_fact_registry import add_sheet
    from app.snz_daily_export import add_daily_details
    wb=Workbook();wb.remove(wb.active)
    ws=add_sheet(wb,data)
    add_unallocated_sheet_block(ws,data)
    add_daily_details(wb,data['snapshots'],datetime.fromisoformat(data['date']).date())
    output=BytesIO();wb.save(output);return output.getvalue()


def drawing_order(data):
    items={};priorities={};references={}
    for order in sorted(data['snapshots'],key=lambda o:(o['date'],o['shift']=='night',o['id'])):
        for eid,item in order_items(order).items():
            items[eid]={**item,'closed':bool(order.get('closed_at'))}
            priority=order.get('item_priorities',{}).get(str(eid))
            references.setdefault(str(eid),[]).append(f"{order['id']}/{priority}" if priority is not None else str(order['id']))
    priorities={eid:','.join(dict.fromkeys(values)) for eid,values in references.items()}
    for element in data['attributed_extra']:
        items[element['id']]={**element,'outside_snz':True}
    for element in data['unallocated']:
        items[element['id']]={**element,'outside_snz':True}
    return {'date':data['date'],'shift':'day','object_name':data['object_name'],
            'report_title':'Суточный факт вне СНЗ' if data['mode']=='fact' else 'Суточный план и факт' if data['mode']=='plan_fact' else 'Суточный план',
            'crew':{'name':'Все бригады','foreman':''},'tasks':[],'items':list(items.values()),'item_priorities':priorities,
            'priority_caption':'Номер - СНЗ/очередь монтажа; ДОП - отнесённый доп. факт; БЕЗ СНЗ - неотнесённый монтаж.',
            'empty_message':'За выбранную дату нет СНЗ и неотнесённого монтажа.',
            'empty_detail':'Выберите другую дату суточного отчёта.'}

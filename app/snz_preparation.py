"""Preparation is confirmed by its operations, independently of installation."""
import json
from app.snz_fact_store import records
from app.snz_policy import order_items


def order_facts(state, order_id):
    """A new preparation mark belongs to one issued document, while global
    facts still satisfy the scheduler's physical preparation dependencies."""
    facts=state['facts'].copy()
    for key,owner in records(state).get('preparation',{}).items():
        if owner['order_id']!=order_id and owner['completed_at']==facts.get(key,{}).get('completed_at'):
            facts[key]={'completed':False,'attributed_order_id':owner['order_id']}
    return facts


def item_fact(order, eid, facts, status=None):
    tasks=[t for t in order['tasks'] if eid in t['element_ids']]
    done=bool(tasks) and all(facts.get(t['key'],{}).get('completed') for t in tasks)
    times=[facts[t['key']].get('completed_at') for t in tasks if facts.get(t['key'],{}).get('completed_at')]
    return {'current_status':(status or {}).get('current_status'),
            'completed':done,'status_confirmed':done,'completed_at':max(times) if done and times else None}


def fact_rows(conn, object_id, state, day=None, shift=None, crew_id=None, open_only=False):
    store=records(state);result=[]
    for row in conn.execute('SELECT id,work_date,shift,crew_id,snapshot_json FROM snz_orders WHERE object_id=? ORDER BY work_date,shift,id',(object_id,)):
        if open_only and str(row['id']) in store.get('closed',{}):continue
        if day and row['work_date']!=day:continue
        if shift and row['shift']!=shift:continue
        if crew_id and row['crew_id']!=crew_id:continue
        order=json.loads(row['snapshot_json'])
        if order['crew'].get('kind')!='preparation':continue
        closure=store.get('closed',{}).get(str(row['id']))
        facts=closure['facts'] if closure else order_facts(state,row['id'])
        for eid,member in order_items(order).items():
            note_key=f"o:{row['id']}:e:{eid}"
            ref={'id':row['id'],'date':row['work_date'],'shift':row['shift'],'crew_id':row['crew_id'],
                 'crew':order['crew']['name'],'foreman':order['crew'].get('foreman',''),
                 'closed_at':closure['closed_at'] if closure else None,'note_key':note_key,
                 'note':store['notes'].get(note_key,{}).get('text','')}
            fact=item_fact(order,eid,facts,member)
            if closure:fact=closure['rows'].get(str(eid),fact)
            result.append({**member,**fact,'kind':'preparation','row_key':f"p:{row['id']}:{eid}",
                'closed':bool(closure),'orders':[ref],
                'tasks':[{'key':t['key'],'operation':t['operation'],'completed':bool(facts.get(t['key'],{}).get('completed')),
                          'completed_at':facts.get(t['key'],{}).get('completed_at'),
                          'attributed_order_id':facts.get(t['key'],{}).get('attributed_order_id')} for t in order['tasks'] if eid in t['element_ids']]})
    return result


def add_sheet(wb, rows):
    """Separate preparation details keep installation totals unambiguous."""
    from datetime import datetime
    from openpyxl.styles import Font,PatternFill,Alignment
    from openpyxl.worksheet.table import Table,TableStyleInfo
    from openpyxl.utils import get_column_letter
    ws=wb.create_sheet('Подготовка')
    ws.append(['№ СНЗ','Дата смены','Смена','Бригада','Прораб','ID изделия','Изделие','Тип','Этаж','Оси','Операция','Факт подготовки','Дата и время факта (МСК)','Примечание'])
    for row in rows:
        ref=row['orders'][0]
        for task in row['tasks']:
            ws.append([ref['id'],datetime.fromisoformat(ref['date']),'День' if ref['shift']=='day' else 'Ночь',ref['crew'],ref['foreman'],
                       row['id'],row.get('mark') or str(row['id']),row['element_type'],row.get('floor'),row.get('address'),task['operation'],
                       int(task['completed']),datetime.fromisoformat(task['completed_at']) if task['completed_at'] else None,ref['note']])
    if ws.max_row>1:
        table=Table(displayName='SNZPreparationFacts',ref=f'A1:N{ws.max_row}')
        table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True);ws.add_table(table)
    for cells in ws:
        ws.row_dimensions[cells[0].row].height=42
        for cell in cells:
            if isinstance(cell.value,str):cell.data_type='s'
            cell.font=Font(name='Calibri',size=11);cell.alignment=Alignment(vertical='center',wrap_text=True)
        if cells[0].row>1:
            cells[1].number_format='dd.mm.yyyy';cells[11].number_format='0%';cells[12].number_format='dd.mm.yyyy hh:mm:ss'
    for c in ws[1]:c.fill=PatternFill('solid',fgColor='17365D');c.font=Font(name='Calibri',size=11,bold=True,color='FFFFFF')
    for i,width in enumerate([12,16,12,36,28,14,23,25,10,22,36,20,26,55],1):ws.column_dimensions[get_column_letter(i)].width=width
    ws.freeze_panes='G2';ws.sheet_view.showGridLines=False
    ws.sheet_properties.pageSetUpPr.fitToPage=True;ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0;ws.print_title_rows='1:1'
    return ws

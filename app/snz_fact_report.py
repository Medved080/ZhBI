"""Daily montage plan/fact report from current issued revisions and status history."""
from datetime import datetime
from io import BytesIO
from zoneinfo import ZoneInfo
from app.models import STATUS_LABELS_RU
from app.snz_montage import fact_rows, status_montage


def report(conn, object_id, state, day, shift=None, crew_id=None):
    rows=fact_rows(conn,object_id,state,status_montage(conn,object_id),day,shift,crew_id)
    planned={r['id'] for r in rows if r['orders']}
    done={r['id'] for r in rows if r['status_confirmed']}
    extra={r['id'] for r in rows if not r['orders']}
    return {'date':day,'shift':shift,'crew_id':crew_id,
            'object_name':conn.execute('SELECT name FROM objects WHERE id=?',(object_id,)).fetchone()[0],
            'generated_at':datetime.now(ZoneInfo('Europe/Moscow')).replace(tzinfo=None).isoformat(timespec='seconds'),
            'items':rows,'totals':{'planned':len(planned),'completed_plan':len(planned&done),
                                  'uncompleted':len(planned-done),'extra':len(extra&done),
                                  'completed_total':len(done),'unique_items':len(rows)}}


def build_xlsx(data):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter
    wb=Workbook();ws=wb.active;ws.title='План и факт'
    title=f"Монтаж - план и факт за {data['date']} | {data['object_name']}"
    ws.append([title]);ws.merge_cells('A1:O1')
    ws.append(['Дата начала СНЗ. День и ночь: с 08:00 выбранной даты до 08:00 следующего дня. Факт открытых СНЗ - на момент выгрузки; закрытых - зафиксирован при закрытии.']);ws.merge_cells('A2:O2')
    t=data['totals']
    ws.append([f"План: {t['planned']} шт. | Выполнено по плану: {t['completed_plan']} | Без факта: {t['uncompleted']} | Доп. факт вне СНЗ: {t['extra']} | Всего смонтировано: {t['completed_total']}"]);ws.merge_cells('A3:O3')
    ws.append([f"Выгружено (МСК): {data['generated_at']} | Отбор по бригаде: {data['crew_id'] or 'все'} | Смена: { {'day':'День','night':'Ночь'}.get(data['shift'],'обе')}"]);ws.merge_cells('A4:O4')
    headers=['№','Изделие','Тип','ID изделия','Этаж','Оси','Основание','№ СНЗ','Смена','Бригада','Прораб','Статус','Факт монтажа','Дата и время монтажа (МСК)','Примечание / причина невыполнения']
    ws.append(headers)
    crews={}
    for index,row in enumerate(data['items'],1):
        refs=row['orders']+row.get('extra',[])
        notes=[]
        for ref in refs:
            if ref.get('note'):
                prefix=f"СНЗ № {ref['id']}: " if len(refs)>1 and ref.get('id') else ''
                notes.append(prefix+ref['note'])
            group=crews.setdefault(ref['crew_id'],{'name':ref['crew'],'foreman':ref.get('foreman',''),'plan':set(),'done':set(),'extra':set()})
            if row['orders']:group['plan'].add(row['id'])
            if row['status_confirmed']:
                group['done'].add(row['id'])
                if not row['orders']:group['extra'].add(row['id'])
        ws.append([index,row.get('mark') or str(row['id']),row['element_type'],row['id'],row.get('floor'),row.get('address'),
                   'СНЗ' if row['orders'] else 'Вне СНЗ',', '.join(str(r['id']) for r in row['orders']),
                   ', '.join(dict.fromkeys('День' if r['shift']=='day' else 'Ночь' for r in refs)),
                   ', '.join(dict.fromkeys(r['crew'] for r in refs)),', '.join(dict.fromkeys(r.get('foreman','') for r in refs)),
                   STATUS_LABELS_RU.get(row['current_status'],row['current_status']),1 if row['status_confirmed'] else 0,
                   datetime.fromisoformat(row['completed_at']) if row['completed_at'] else None,'\n'.join(notes)])
    if data['items']:
        table=Table(displayName='SNZDailyMontageFacts',ref=f'A5:O{ws.max_row}');table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True);ws.add_table(table)
    ws.freeze_panes='C6'
    for row in ws.iter_rows(min_row=6):row[12].number_format='0%';row[13].number_format='dd.mm.yyyy hh:mm:ss'
    summary=wb.create_sheet('Итоги по бригадам');summary.append(['Бригада','Прораб','План, шт','Выполнено по плану, шт','Без факта, шт','Доп. факт вне СНЗ, шт','Смонтировано всего, шт'])
    for group in crews.values():
        done=group['plan']&group['done']
        summary.append([group['name'],group['foreman'],len(group['plan']),len(done),len(group['plan']-done),len(group['extra']),len(group['done'])])
    if crews:
        table=Table(displayName='SNZDailyMontageCrews',ref=f'A1:G{summary.max_row}');table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True);summary.add_table(table)
    summary.append(['Итого уникальных изделий','',t['planned'],t['completed_plan'],t['uncompleted'],t['extra'],t['completed_total']])
    summary.freeze_panes='B2'
    for sheet,widths,header in [(ws,[7,23,25,14,10,23,14,15,18,34,25,22,17,25,55],5),(summary,[38,29,18,26,20,27,28],1)]:
        for row in sheet:
            sheet.row_dimensions[row[0].row].height=42 if row[0].row>header else 32
            if sheet is ws and row[0].row>header:
                note=str(row[14].value or '');lines=sum(max(1,(len(part)+49)//50) for part in note.split('\n'))
                sheet.row_dimensions[row[0].row].height=min(409,max(42,lines*15))
            for c in row:
                if isinstance(c.value,str):c.data_type='s'
                c.font=Font(name='Calibri',size=11);c.alignment=Alignment(vertical='center',wrap_text=True)
        for c in sheet[header]:c.font=Font(name='Calibri',size=11,bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='17365D')
        for i,width in enumerate(widths,1):sheet.column_dimensions[get_column_letter(i)].width=width
    ws['A1'].font=Font(name='Calibri',size=16,bold=True)
    output=BytesIO();wb.save(output);return output.getvalue()


def drawing_order(data):
    crews=list(dict.fromkeys(ref['crew'] for row in data['items'] for ref in (row['orders']+row.get('extra',[]))))
    names=', '.join(crews[:3])+(f' и ещё {len(crews)-3}' if len(crews)>3 else '')
    return {'date':data['date'],'shift':data['shift'] or 'day','object_name':data['object_name'],
            'report_title':'План и факт - '+({'day':'День','night':'Ночь'}.get(data['shift'],'обе смены')),
            'crew':{'name':names or 'Нет работ','foreman':''},
            'tasks':[],'items':[{**row,'outside_snz':not bool(row['orders'])} for row in data['items']],
            'item_priorities':{str(row['id']):i for i,row in enumerate(data['items'],1) if row['orders']}}

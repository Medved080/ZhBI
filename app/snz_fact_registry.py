"""Document-level montage plan/fact register, including scoped extra installation."""
from datetime import datetime


def summarize(orders, items, statuses, preparation_items=()):
    rows=[];by_id={};by_scope={};unassigned=set()
    for order in orders:
        row={**order,'planned':order['quantity'],'completed_ids':set()}
        rows.append(row);by_id[row['id']]=row
        by_scope[(row['work_date'],row['shift'],row['crew_id'])]=row
    for item in items:
        eid=item['id'];live=statuses.get(eid,{})
        for ref in item['orders']:
            row=by_id.get(ref['id'])
            if row is None or row.get('crew_kind')=='preparation':
                continue
            source=ref.get('frozen') if ref.get('closed_at') and ref.get('frozen') is not None else live
            confirmed=source.get('status_confirmed',source.get('current_status') in ('installed','accepted')) and not ref.get('montage_elsewhere')
            if confirmed:
                row['completed_ids'].add(eid)
        for ref in item.get('extra',[]):
            if not live.get('completed_at') or ref['history_id']!=live.get('history_id'):
                continue
            row=by_scope.get((ref['date'],ref['shift'],ref['crew_id']))
            if row is None:
                unassigned.add(eid)
            else:
                row['completed_ids'].add(eid)
    for item in preparation_items:
        if item['completed'] and item['orders'][0]['id'] in by_id:
            by_id[item['orders'][0]['id']]['completed_ids'].add(item['id'])
    for row in rows:
        row['completed']=len(row.pop('completed_ids'))
    return {'orders':rows,'planned':sum(r['planned'] for r in rows),
            'completed':sum(r['completed'] for r in rows),'unassigned_extra':len(unassigned)}


def add_sheet(wb, data):
    """Daily register in the user's layout; final headers precede Table."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter
    ws=wb.create_sheet('Реестр СНЗ',0)
    register=data['registry'];day=datetime.fromisoformat(data['date'])
    actual=not data.get('daily_mode') or register.get('has_closed',False)
    title=f"Реестр СНЗ: {'план и факт' if actual else 'план'} за {day.strftime('%d.%m.%Y')}" if data.get('daily_mode') else f"Реестр выданных СНЗ за {day.strftime('%d.%m.%Y')}"
    if data.get('mode')=='fact':title=f"Монтаж без СНЗ за {day.strftime('%d.%m.%Y')}"
    last_col='H' if actual else 'G'
    ws.append([title]);ws.merge_cells(f'A1:{last_col}1')
    ws.append(['Дата относится к началу смены. Ночь: 20:00 выбранной даты — 08:00 следующего дня.']);ws.merge_cells(f'A2:{last_col}2')
    ws.append([])
    headers=['№ СНЗ','Дата','Смена','Бригада','Прораб','Загрузка крана','Количество план, шт']
    if actual:headers.append('Количество факт, шт')
    ws.append(headers)
    for row in register['orders']:
        values=[row['id'],datetime.fromisoformat(row['work_date']),'День' if row['shift']=='day' else 'Ночь',
                row['crew_name'],row['foreman'] or 'Не назначен',row.get('crane_load'),row['planned']]
        if actual:values.append(row['completed'])
        ws.append(values)
    end=ws.max_row
    if register['orders']:
        table=Table(displayName='SNZDailyPlanFactRegister',ref=f'A4:{last_col}{end}')
        table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True)
        ws.add_table(table)
    total_values=['Итого по документам, шт',None,None,None,None,None,register['planned']]
    if actual:total_values.append(register['completed'])
    ws.append(total_values)
    total=ws.max_row;ws.merge_cells(start_row=total,start_column=1,end_row=total,end_column=5)
    if not register['orders']:
        ws.append(['За выбранную дату, смену и бригаду СНЗ не выдавались.']);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=8 if actual else 7)
    if register['unassigned_extra']:
        where='Подробности — во вкладке «Факт».' if data.get('daily_mode') else 'Показан на листе «План и факт».'
        ws.append([f"Доп. факт без выданного СНЗ: {register['unassigned_extra']} шт. {where} В итог по документам не включён."]);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=8 if actual else 7)
    explanation='Открытые СНЗ — только план; факт показан по закрытым СНЗ и включает доп. монтаж соответствующей даты, смены и бригады. Пустая ячейка факта означает: СНЗ не закрыт.' if data.get('daily_mode') else 'Факт монтажа включает выполненный план и доп. монтаж этой бригады и смены. Факт подготовки — изделия со всеми выполненными подготовительными операциями. Факт закрытых СНЗ зафиксирован при закрытии; доп. монтаж учитывается по отдельным записям.'
    ws.append([explanation]);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=8 if actual else 7)
    for row in ws:
        rn=row[0].row;ws.row_dimensions[rn].height=24 if rn>=5 else 32
        for cell in row:
            if isinstance(cell.value,str):cell.data_type='s'
            cell.font=Font(name='Calibri',size=11)
            cell.alignment=Alignment(vertical='center',wrap_text=True,horizontal='center' if cell.column in (1,2,3,6,7,8) else 'left')
            if 5<=rn<=end:
                cell.fill=PatternFill('solid',fgColor='DCE6F1' if (rn-5)%2==0 else 'FFFFFF')
                cell.border=Border(bottom=Side(style='hair',color='9CBCE2'))
            if rn in (4,total):
                cell.fill=PatternFill('solid',fgColor='17365D');cell.font=Font(name='Calibri',size=11,color='FFFFFF',bold=rn==4)
    ws['A1'].font=Font(name='Calibri',size=16,bold=True,color='17365D');ws['A1'].alignment=Alignment(vertical='center',horizontal='left')
    ws['A2'].alignment=Alignment(vertical='center',horizontal='left',wrap_text=True)
    ws.cell(total,1).alignment=Alignment(vertical='center',horizontal='left')
    ws.row_dimensions[3].height=10;ws.row_dimensions[4].height=42
    for rn in range(total+1,ws.max_row+1):
        ws.row_dimensions[rn].height=32;ws.cell(rn,1).alignment=Alignment(vertical='center',horizontal='left',wrap_text=True)
    for row in ws.iter_rows(min_row=5,max_row=end):
        row[1].number_format='dd.mm.yyyy'
        row[5].number_format='0%'
        row[6].number_format='#,##0'
        if actual:row[7].number_format='#,##0'
        # Long names must wrap instead of disappearing beyond the row height.
        ws.row_dimensions[row[0].row].height=max(24,15*max((len(str(row[3].value or ''))+46)//47,(len(str(row[4].value or ''))+27)//28,1))
    for i,width in enumerate([10,15,12,48,30,15,20,20],1):
        ws.column_dimensions[get_column_letter(i)].width=width
    for col in ((7,8) if actual else (7,)):ws.cell(total,col).number_format='#,##0'
    ws.freeze_panes='D5';ws.sheet_view.showGridLines=False
    ws.sheet_properties.pageSetUpPr.fitToPage=True
    ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0;ws.print_title_rows='1:4'
    ws.print_area=f'A1:{last_col}{ws.max_row}';wb.active=0
    return ws

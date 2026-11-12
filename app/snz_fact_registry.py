"""Document-level montage plan/fact register, including scoped extra installation."""
from datetime import datetime


def summarize(orders, items, statuses):
    rows=[];by_id={};by_scope={};unassigned=set()
    for order in orders:
        if order.get('crew_kind')=='preparation':
            continue
        row={**order,'planned':order['quantity'],'completed_ids':set()}
        rows.append(row);by_id[row['id']]=row
        by_scope[(row['work_date'],row['shift'],row['crew_id'])]=row
    for item in items:
        eid=item['id'];live=statuses.get(eid,{})
        for ref in item['orders']:
            row=by_id.get(ref['id'])
            if row is None:
                continue
            source=ref.get('frozen') if ref.get('closed_at') and ref.get('frozen') is not None else live
            confirmed=source.get('status_confirmed',source.get('current_status') in ('installed','accepted'))
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
    for row in rows:
        row['completed']=len(row.pop('completed_ids'))
    return {'orders':rows,'planned':sum(r['planned'] for r in rows),
            'completed':sum(r['completed'] for r in rows),'unassigned_extra':len(unassigned)}


def add_sheet(wb, data):
    """Seven-column register in the user's layout; final headers precede Table."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter
    ws=wb.create_sheet('Реестр СНЗ',0)
    register=data['registry'];day=datetime.fromisoformat(data['date'])
    ws.append([f"Реестр выданных СНЗ за {day.strftime('%d.%m.%Y')}"]);ws.merge_cells('A1:G1')
    ws.append(['Дата относится к началу смены. Ночь: 20:00 выбранной даты — 08:00 следующего дня.']);ws.merge_cells('A2:G2')
    ws.append([])
    ws.append(['№ СНЗ','Дата','Смена','Бригада','Прораб','Количество план, шт','Количество факт, шт'])
    for row in register['orders']:
        ws.append([row['id'],datetime.fromisoformat(row['work_date']),'День' if row['shift']=='day' else 'Ночь',
                   row['crew_name'],row['foreman'] or 'Не назначен',row['planned'],row['completed']])
    end=ws.max_row
    if register['orders']:
        table=Table(displayName='SNZDailyPlanFactRegister',ref=f'A4:G{end}')
        table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True)
        ws.add_table(table)
    ws.append(['Итого по документам, шт',None,None,None,None,register['planned'],register['completed']])
    total=ws.max_row;ws.merge_cells(start_row=total,start_column=1,end_row=total,end_column=5)
    if not register['orders']:
        ws.append(['За выбранную дату, смену и бригаду СНЗ не выдавались.']);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=7)
    if register['unassigned_extra']:
        ws.append([f"Доп. факт без выданного СНЗ: {register['unassigned_extra']} шт. Показан на листе «План и факт», в итог по документам не включён."]);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=7)
    ws.append(['Факт включает выполненный план и доп. монтаж этой бригады и смены. Выполненный план закрытых СНЗ зафиксирован при закрытии; доп. факт учитывается по отдельным записям.']);ws.merge_cells(start_row=ws.max_row,start_column=1,end_row=ws.max_row,end_column=7)
    for row in ws:
        rn=row[0].row;ws.row_dimensions[rn].height=24 if rn>=5 else 32
        for cell in row:
            if isinstance(cell.value,str):cell.data_type='s'
            cell.font=Font(name='Calibri',size=11)
            cell.alignment=Alignment(vertical='center',wrap_text=True,horizontal='center' if cell.column in (1,2,3,6,7) else 'left')
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
        row[5].number_format=row[6].number_format='#,##0'
        # Long names must wrap instead of disappearing beyond the row height.
        ws.row_dimensions[row[0].row].height=max(24,15*max((len(str(row[3].value or ''))+46)//47,(len(str(row[4].value or ''))+27)//28,1))
    for i,width in enumerate([10,15,12,48,30,20,20],1):
        ws.column_dimensions[get_column_letter(i)].width=width
    for col in (6,7):ws.cell(total,col).number_format='#,##0'
    ws.freeze_panes='D5';ws.sheet_view.showGridLines=False
    ws.sheet_properties.pageSetUpPr.fitToPage=True
    ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0;ws.print_title_rows='1:4'
    ws.print_area=f'A1:G{ws.max_row}';wb.active=0
    return ws

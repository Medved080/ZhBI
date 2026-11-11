"""Combine immutable issued workbooks into the four daily detail sheets."""
from copy import copy
from datetime import datetime
from io import BytesIO


def add_daily_details(wb, orders, day):
    from openpyxl import load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter
    from app.snz_export import build_xlsx
    sheets={name:wb.create_sheet(name) for name in ['СНЗ','Изделия','Загрузка звеньев','Предупреждения']}
    prefix=['№ СНЗ','Дата смены','Смена СНЗ','Бригада СНЗ','Прораб','Редакция']
    headers={
        'СНЗ':['№','Операция','Звено','Узел','ID изделий','Марки','Этажи','Адреса','Начало','Окончание','Минут в интервале','Норматив, мин','Остаток после смены, мин','Перенос'],
        'Изделия':['ID изделия','Тип элемента','Подтип','Марка','Отметка, мм','Этаж','Адрес по осям','Контрагент (справочно)','Захватка','Кран','Стоянка','Бригада','Очередность','Смена','Дата','Время монтажа','Перенос с'],
        'Предупреждения':['Предупреждение'],
    }
    for name,fields in headers.items():
        sheets[name].append(prefix+fields)
    gantt=sheets['Загрузка звеньев']
    gantt.append([f'Загрузка звеньев · реестр СНЗ за {day.strftime("%d.%m.%Y")}'])
    gantt.merge_cells('A1:BU1')
    cursor=3
    for order in orders:
        meta=[order['id'],datetime.fromisoformat(order['date']),'День' if order['shift']=='day' else 'Ночь',order['crew']['name'],order['crew'].get('foreman') or 'Не назначен',order.get('order_revision',1)]
        source=load_workbook(BytesIO(build_xlsx(order)))
        for name,start in [('СНЗ',4),('Изделия',2)]:
            target=sheets[name]
            for row in source[name].iter_rows(min_row=start):
                target.append(meta+[c.value for c in row])
                for cell,original in zip(list(target[target.max_row])[len(meta):],row):
                    cell.number_format=original.number_format
        for warning in order.get('warnings',[]) or ['Нет предупреждений']:
            sheets['Предупреждения'].append(meta+[warning])
        # Each document has its own day/night axis, including its actual dates.
        gantt.cell(cursor,1,f"СНЗ № {order['id']} · ред. {order.get('order_revision',1)} · {order['crew']['name']} · Прораб: {meta[4]} · {order['start'].replace('T',' ')} — {order['end'].replace('T',' ')}")
        gantt.merge_cells(start_row=cursor,start_column=1,end_row=cursor,end_column=73)
        gantt.row_dimensions[cursor].height=30
        offset=cursor
        original=source['Загрузка звеньев']
        for row in original:
            for cell in row:
                dest=gantt.cell(cell.row+offset,cell.column,cell.value)
                dest.font=copy(cell.font);dest.fill=copy(cell.fill);dest.border=copy(cell.border)
                dest.alignment=copy(cell.alignment);dest.protection=copy(cell.protection);dest.number_format=cell.number_format
                if cell.data_type=='s':dest.data_type='s'
            gantt.row_dimensions[row[0].row+offset].height=original.row_dimensions[row[0].row].height
        for merged in original.merged_cells.ranges:
            gantt.merge_cells(start_row=merged.min_row+offset,start_column=merged.min_col,end_row=merged.max_row+offset,end_column=merged.max_col)
        for key,dimension in original.column_dimensions.items():
            gantt.column_dimensions[key].width=dimension.width
        cursor+=original.max_row+3
        source.close()
    for name,fields in headers.items():
        sheet=sheets[name]
        if sheet.max_row>1:
            table=Table(displayName={'СНЗ':'DailySNZOperations','Изделия':'DailySNZItems','Предупреждения':'DailySNZWarnings'}[name],ref=f'A1:{get_column_letter(len(prefix)+len(fields))}{sheet.max_row}')
            table.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True)
            sheet.add_table(table)
        for row in sheet:
            sheet.row_dimensions[row[0].row].height=38
            for cell in row:
                cell.font=Font(name='Calibri',size=11)
                cell.alignment=Alignment(vertical='center',wrap_text=True)
            if row[0].row>1:row[1].number_format='dd.mm.yyyy'
        for cell in sheet[1]:
            cell.fill=PatternFill('solid',fgColor='17365D');cell.font=Font(name='Calibri',bold=True,color='FFFFFF',size=11)
        for index in range(1,len(prefix)+len(fields)+1):
            sheet.column_dimensions[get_column_letter(index)].width=24 if index not in [1,2,3,6] else 15
        if name=='Предупреждения':sheet.column_dimensions['G'].width=120;sheet.row_dimensions[1].height=32
        import math
        for row in sheet.iter_rows(min_row=2):
            sheet.row_dimensions[row[0].row].height=max(38,max((16*math.ceil(len(str(c.value or ''))/max(8,sheet.column_dimensions[c.column_letter].width-2))+8 for c in row),default=38))
        sheet.freeze_panes='G2';sheet.print_title_rows='1:1'
    gantt.freeze_panes='B3';gantt.print_title_rows='1:1'
    for sheet in sheets.values():
        for row in sheet:
            for cell in row:
                if isinstance(cell.value,str):cell.data_type='s'
        sheet.sheet_view.showGridLines=False
        sheet.sheet_properties.pageSetUpPr.fitToPage=True
        sheet.page_setup.orientation='landscape';sheet.page_setup.paperSize=sheet.PAPERSIZE_A3
        sheet.page_setup.fitToWidth=1;sheet.page_setup.fitToHeight=0

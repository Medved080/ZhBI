"""
Массовая правка «Учёта по блокам» через Excel (2026-09-11, живой запрос —
аналог app/element_bulk_edit.py для контура МФР).

Круг тот же, что у ЖБИ: выгрузить снимок -> правка в Excel -> загрузить
обратно -> сверка -> флажками отметить, что применять. Три отличия от
ЖБИ-модуля, объясняющие форму этого файла.

1. **Выгрузка — по ОДНОМУ объекту**, а не по всем сразу: контур МФР и так
   везде объектный (`work_progress`, как у прочих ручек `block_works.py`),
   и общесистемного порога `bulk_edit` здесь нет.

2. **Строка — ОДНА ЗР** (`block_works.id`, решение пользователя): именно
   пара блок×вид работы, а не строка факта и не строка справочника. Прогресс
   (H) и дата его фиксации (I) правятся ВМЕСТЕ — это не два независимых
   поля, а один факт-документ на дату (см. `_diff_percent`).

3. **Цвет заливки макета пользователя — это НЕ техническое требование к
   файлу** (сверено с тем, что build_export_workbook ЖБИ не красит ячейки
   вовсе): в реальной выгрузке заливки нет, состав редактируемых колонок
   просто ограничен списком COLUMNS ниже.

4. **Справочные колонки защищены НАСТОЯЩЕЙ защитой листа Excel** (живой
   запрос пользователя, 2026-09-11: «чтобы пользователь не мог случайно
   удалить или изменить UID»), а не только цветом/подписью в шапке. Без
   пароля — это защита от НЕВНИМАТЕЛЬНОСТИ (Excel не даст стереть/сдвинуть
   ячейку не глядя), а не от злого умысла: снять защиту одним кликом может
   кто угодно, и сервер при загрузке всё равно проверяет каждое значение
   сам (см. `analyze`/`_diff_row`) — тот же принцип, что у выпадающих
   списков в app/element_bulk_edit.py («список — удобство, проверка —
   обязанность»).

5. **Шапка и чередование строк — в цветах ЛИЧНОЙ гаммы пользователя**
   (`users.ui_theme`, живой запрос 2026-09-11), а не фиксированной
   раскраской: у сервиса семь гамм оформления (`SKINS` в
   app/static/app.js), и выгрузка не должна расходиться с тем, что человек
   выбрал себе на экране. `--color-primary` каждой гаммы продублирован
   здесь как `THEME_PRIMARY` — единственный практичный вариант: сама гамма
   в БД не хранит цвета, только id, а править семь готовых гамм в
   index.html не чаще, чем сам этот список (живой запрос 2026-08-02).
   Текст шапки — белый или тёмный по формуле яркости фона, а не по списку
   исключений («Неон» с его ярко-жёлтым акцентом иначе остался бы
   нечитаемым, а новая гамма — не почищенной под это правило вручную).
   Чередование строк — СВЕТЛЫЙ оттенок акцента (смешан с белым), не сам
   акцент: у тёмных гамм («Графит», «Индиго») акцент в интерфейсе тёмный
   специально ради тёмного фона страницы, а лист Excel — светлый документ,
   и тёмная плашка на нём была бы нечитаема обычным чёрным шрифтом ячейки.
"""

import io
from datetime import datetime
from typing import Optional

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Border, Font, PatternFill, Protection, Side
from openpyxl.utils import get_column_letter

from app import activity, block_works, work_fact
from app.element_fields import EXCEL_DATE_FORMAT, to_excel_date

SHEET_DATA = "Работы"

# Сетка (живой запрос 2026-09-11) — тонкая рамка у КАЖДОЙ ячейки таблицы,
# шапки и данных: без неё цветные полосы читаются как заливка произвольной
# формы, а не строки/колонки таблицы. Один объект на весь лист — Border
# неизменяем, плодить его на каждую ячейку смысла нет (тот же приём, что у
# *_fill ниже).
_GRID_SIDE = Side(style="thin", color="BFBFBF")
GRID_BORDER = Border(left=_GRID_SIDE, right=_GRID_SIDE, top=_GRID_SIDE, bottom=_GRID_SIDE)

# --color-primary каждой гаммы (app/static/index.html, :root[data-skin]) —
# см. п.5 в docstring модуля. "gos" — гамма по умолчанию (SKINS[0] в
# app/static/app.js), берётся и когда у пользователя ui_theme не задан.
THEME_PRIMARY = {
    "gos": "0D4CD3", "msu": "A31212", "graphite": "7AA2F7",
    "indigo": "8B9DFF", "neon": "FCEE0A", "emerald": "0E8A5F", "sand": "B4690E",
}
DEFAULT_THEME = "gos"

# Размер шрифта шапки — на 2 пункта больше основного текста (живой запрос
# 2026-09-11). BODY_FONT_SIZE явно продублирован, а не оставлен неявным
# дефолтом openpyxl (Calibri 11): дефолт нигде не гарантирован документами
# формата и может измениться в новой версии библиотеки, а связь «шапка на
# 2 больше» должна остаться видимой в коде, а не в совпадении с чужой
# константой.
BODY_FONT_SIZE = 11
HEADER_FONT_SIZE = BODY_FONT_SIZE + 2


def _hex_to_rgb(hex_color: str) -> tuple:
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))


def _mix_with_white(hex_color: str, доля: float) -> str:
    """Смешивает цвет с белым — `доля` (0..1) исходного цвета, остальное
    белый. Даёт светлый оттенок акцента для чередования строк вместо
    самого акцента (см. п.5 в docstring модуля)."""
    r, g, b = _hex_to_rgb(hex_color)
    смешать = lambda c: round(c * доля + 255 * (1 - доля))
    return f"{смешать(r):02X}{смешать(g):02X}{смешать(b):02X}"


def _readable_text_color(bg_hex: str) -> str:
    """Белый или тёмный текст по ВОСПРИНИМАЕМОЙ яркости фона — формулой, а
    не списком исключений «у этой гаммы текст тёмный»: седьмая гамма
    появилась 2026-08-02, восьмая может появиться и без правки этого файла."""
    r, g, b = _hex_to_rgb(bg_hex)
    яркость = (r * 299 + g * 587 + b * 114) / 1000
    return "1A1D21" if яркость > 150 else "FFFFFF"

KEY_COLUMN = "bw_id"

# Колонки листа «Работы»: (ключ, подпись, правимая ли). Порядок — как в
# макете пользователя (Массовая правка через Excel — МФР.xlsx), кроме двух
# отличий, оба — по решению пользователя: колонки «Чертёж»/«Handle в DXF»
# убраны (у ЗР МФР нет ни чертежа, ни DXF-геометрии), перед «Этаж» добавлена
# «Секция» (адресация блока — пара секция+этаж, а не только этаж).
COLUMNS = [
    (KEY_COLUMN, "UID (не менять)", False),
    ("object_name", "Объект", False),
    ("wbs2", "WBS, 2 уровень", False),
    ("wbs3", "WBS, 3 уровень", False),
    ("wbs4", "WBS, 4 уровень", False),
    ("wbs5", "WBS, 5 уровень", False),
    ("section_code", "Секция", False),
    ("level_floor", "Этаж", False),
    ("percent", "Прогресс выполнения", True),
    ("report_date", "Дата фиксации прогресса", True),
    ("elevation_mm", "Отметка, мм", False),
    ("fact_start", "Дата начала СМР, факт", False),
    ("fact_end", "Дата завершения СМР, факт", False),
    ("plan_start", "Дата начала СМР, базовый", True),
    ("plan_end", "Дата завершения СМР, базовый", True),
    ("forecast_start", "Дата начала СМР, актуализированный", True),
    ("forecast_end", "Дата завершения СМР, актуализированный", True),
]

_DATE_COLUMNS = {"report_date", "fact_start", "fact_end",
                 "plan_start", "plan_end", "forecast_start", "forecast_end"}

_WBS_KEYS = ("wbs2", "wbs3", "wbs4", "wbs5")

FIELD_LABELS = {k: l for k, l, _ in COLUMNS}


# ---------------------------------------------------------------- выборка

def _fact_dates(conn, object_id: int) -> dict:
    """(block_id, work_type_id) -> (дата первого факта >0%, дата первого
    факта =100%) — L/M макета. Одним запросом на объект: по строке на пару
    отдельным запросом это тот же N+1, который уже стоил ЖБИ-выгрузке
    N+1 (см. app/element_bulk_edit.py)."""
    rows = conn.execute(
        """
        SELECT r.block_id, i.work_type_id,
               MIN(CASE WHEN i.percent > 0 THEN r.report_date END) AS fact_start,
               MIN(CASE WHEN i.percent = 100 THEN r.report_date END) AS fact_end
        FROM work_fact_items i
        JOIN work_fact_reports r ON r.id = i.report_id
        WHERE r.object_id = ?
        GROUP BY r.block_id, i.work_type_id
        """,
        (object_id,),
    ).fetchall()
    return {(r["block_id"], r["work_type_id"]): (r["fact_start"], r["fact_end"]) for r in rows}


def _block_work_rows(conn, object_id: int) -> list:
    """Активные ЗР объекта (`retired_at IS NULL` — снятые в файл не
    попадают, править их массово нечем) с одним JOIN на путь WBS, блок,
    секцию, этаж и объект — без второго запроса на строку."""
    return conn.execute(
        """
        SELECT bw.*, wt.path AS wt_path,
               s.code AS section_code, s.sort_order AS section_sort,
               l.floor AS level_floor, l.elevation_mm AS elevation_mm, l.sort_order AS level_sort,
               o.name AS object_name
        FROM block_works bw
        JOIN work_types wt ON wt.id = bw.work_type_id
        JOIN blocks b ON b.id = bw.block_id
        JOIN object_sections s ON s.id = b.section_id
        JOIN object_levels l ON l.id = b.level_id
        JOIN objects o ON o.id = bw.object_id
        WHERE bw.object_id = ? AND bw.retired_at IS NULL
        ORDER BY s.sort_order, l.sort_order, wt.sort_order
        """,
        (object_id,),
    ).fetchall()


def _wbs_parts(path: str) -> list:
    parts = (path or "").split(" / ")[1:]  # уровень 1 в выгрузку не входит (макет пользователя)
    return (parts + [None] * len(_WBS_KEYS))[:len(_WBS_KEYS)]


def display_values(row, percent: "int | None", fact_dates: tuple) -> dict:
    """Значения одной строки по всем колонкам COLUMNS — общий источник для
    выгрузки в xlsx и (позже) для экрана подтверждения, тем же приёмом, что
    у ЖБИ (display_values в app/element_bulk_edit.py)."""
    wbs = dict(zip(_WBS_KEYS, _wbs_parts(row["wt_path"])))
    fact_start, fact_end = fact_dates
    values = {
        KEY_COLUMN: row["id"], "object_name": row["object_name"],
        "section_code": row["section_code"], "level_floor": row["level_floor"],
        "percent": percent, "report_date": None,
        "elevation_mm": row["elevation_mm"],
        "fact_start": fact_start, "fact_end": fact_end,
        "plan_start": row["plan_start"], "plan_end": row["plan_end"],
        "forecast_start": row["forecast_start"], "forecast_end": row["forecast_end"],
        **wbs,
    }
    return {key: values[key] for key, _, _ in COLUMNS}


def build_export_workbook(conn, object_id: int, ui_theme: Optional[str] = None) -> Workbook:
    """Снимок активных ЗР объекта на текущий момент. Без листов-справочников
    и выпадающих списков — в отличие от ЖБИ, правимые колонки здесь свободные
    (проценты и даты), выбирать не из чего.

    `ui_theme` — гамма оформления ТОГО, кто выгружает (`users.ui_theme`,
    см. п.5 в docstring модуля); неизвестная/пустая — гамма по умолчанию."""
    rows = _block_work_rows(conn, object_id)
    percents = work_fact.current_percents_by_block_work(conn, object_id)
    fact_dates = _fact_dates(conn, object_id)

    primary = THEME_PRIMARY.get(ui_theme, THEME_PRIMARY[DEFAULT_THEME])
    header_fill = PatternFill("solid", fgColor=primary)
    header_font = Font(bold=True, size=HEADER_FONT_SIZE, color=_readable_text_color(primary))
    # Два разных оттенка ОДНОЙ гаммы (живой запрос 2026-09-11), не два
    # смысла одним цветом: чередование строк — едва заметная подложка для
    # чтения (12% акцента), правимая ячейка — заметно ярче (28%), чтобы её
    # было видно СРАЗУ, независимо от чётности строки.
    stripe_fill = PatternFill("solid", fgColor=_mix_with_white(primary, 0.12))
    editable_fill = PatternFill("solid", fgColor=_mix_with_white(primary, 0.28))
    editable_cols = {i + 1 for i, (_, _, editable) in enumerate(COLUMNS) if editable}
    body_font = Font(size=BODY_FONT_SIZE)

    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_DATA
    ws.append([label for _, label, _ in COLUMNS])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}1"
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.border = GRID_BORDER

    столбцы_дат = [i + 1 for i, (key, _, _) in enumerate(COLUMNS) if key in _DATE_COLUMNS]
    for номер, row in enumerate(rows, start=2):
        values = display_values(row, percents.get(row["id"], 0),
                                fact_dates.get((row["block_id"], row["work_type_id"]), (None, None)))
        ws.append([to_excel_date(values[key]) if key in _DATE_COLUMNS else values[key]
                   for key, _, _ in COLUMNS])
        for i in столбцы_дат:
            ws.cell(row=номер, column=i).number_format = EXCEL_DATE_FORMAT
        # Чередование — по НОМЕРУ СТРОКИ листа, а не по индексу в rows: так
        # полосы не сбиваются, если состав строк когда-нибудь придёт не
        # подряд (сейчас подряд, но зависимость от порядка была бы хрупкой).
        # Правимые колонки — СВОЙ цвет во ВСЕХ строках, чётных и нечётных:
        # это не полоса чтения, а метка «сюда можно писать», ей чередование
        # только мешало бы (пропадала бы через строку).
        чётная = номер % 2 == 0
        for col_idx, cell in enumerate(ws[номер], start=1):
            cell.font = body_font
            cell.border = GRID_BORDER
            if col_idx in editable_cols:
                cell.fill = editable_fill
            elif чётная:
                cell.fill = stripe_fill

    _protect(ws, len(rows))
    _widen(ws)
    return wb


def _protect(ws, n_rows: int) -> None:
    """Защита листа (см. п.4 в docstring модуля): по умолчанию openpyxl
    держит ВСЕ ячейки заблокированными (`Protection(locked=True)`) — здесь
    явно СНИМАЕТСЯ блокировка только у столбцов с editable=True из COLUMNS,
    и включается защита листа. Без пароля — она держит от невнимательности
    (случайно стереть UID/дату факта), а не от того, кто нарочно снимет
    защиту одним кликом «Сервис → Снять защиту листа»."""
    editable_cols = [i + 1 for i, (_, _, editable) in enumerate(COLUMNS) if editable]
    for col in editable_cols:
        for row in range(2, n_rows + 2):
            ws.cell(row=row, column=col).protection = Protection(locked=False)
    ws.protection.sheet = True
    # Сортировка и автофильтр — разрешены явно (см. ws.auto_filter выше):
    # по умолчанию OOXML запрещает их вместе с редактированием, а листом
    # в сотни строк неудобно пользоваться без обоих.
    ws.protection.sort = False
    ws.protection.autoFilter = False


def _widen(ws) -> None:
    for i, column in enumerate(ws.iter_cols(), start=1):
        width = max((len(str(c.value)) for c in column if c.value is not None), default=10)
        ws.column_dimensions[get_column_letter(i)].width = min(max(width + 2, 10), 45)


# ---------------------------------------------------------------- разбор

def _read_sheet(file_bytes: bytes) -> list:
    """Строки листа «Работы» словарями по КЛЮЧАМ колонок — тот же приём,
    что у ЖБИ (см. app/element_bulk_edit.py::_read_sheet): сопоставление по
    подписи заголовка, а не по позиции, переживает вставку/скрытие колонок
    пользователем."""
    wb = load_workbook(io.BytesIO(file_bytes), data_only=True)
    if SHEET_DATA not in wb.sheetnames:
        raise ValueError(f"В файле нет листа «{SHEET_DATA}». "
                         f"Загружайте тот файл, который выгрузила система.")
    ws = wb[SHEET_DATA]
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise ValueError(f"Лист «{SHEET_DATA}» пуст")

    label_to_key = {label: key for key, label, _ in COLUMNS}
    index = {}
    for i, cell in enumerate(header):
        key = label_to_key.get(str(cell).strip() if cell is not None else "")
        if key:
            index[key] = i
    if KEY_COLUMN not in index:
        raise ValueError("В файле нет колонки «UID (не менять)» — без неё строки не с чем сопоставить.")

    out = []
    for n, raw in enumerate(rows, start=2):
        if all(v is None or (isinstance(v, str) and not v.strip()) for v in raw):
            continue
        out.append((n, {key: (raw[i] if i < len(raw) else None) for key, i in index.items()}))
    return out


def _parse_date_cell(raw, field_label: str) -> Optional[str]:
    """Ячейка даты -> 'ГГГГ-ММ-ДД' либо None. Принимает и настоящую дату
    Excel, и ISO-текст — тот же приём, что coerce_field у ЖБИ
    (app/element_fields.py), но без завязки на список полей elements."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, datetime):
        return raw.strftime("%Y-%m-%d")
    if hasattr(raw, "strftime"):
        return raw.strftime("%Y-%m-%d")
    text = str(raw).strip()
    try:
        datetime.strptime(text, "%Y-%m-%d")
        return text
    except ValueError:
        raise ValueError(f"«{field_label}»: ожидается дата, получено «{raw}»")


def _parse_percent_cell(raw) -> Optional[int]:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    try:
        percent = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"«Прогресс выполнения»: ожидается целое число 0..100, получено «{raw}»")
    if not (0 <= percent <= 100):
        raise ValueError(f"«Прогресс выполнения»: {percent} вне диапазона 0..100")
    return percent


def analyze(conn, object_id: int, file_bytes: bytes) -> dict:
    """Сверяет файл с базой. Ничего не пишет — применение отдельным вызовом
    (см. apply_changes), после того как пользователь отметил флажками, что
    применять."""
    parsed = _read_sheet(file_bytes)
    rows = _block_work_rows(conn, object_id)
    percents = work_fact.current_percents_by_block_work(conn, object_id)
    fact_dates = _fact_dates(conn, object_id)
    by_id = {r["id"]: r for r in rows}

    changes, rejected = [], []
    seen = set()
    for line_no, values in parsed:
        raw_uid = values.get(KEY_COLUMN)
        if raw_uid is None or (isinstance(raw_uid, str) and not raw_uid.strip()):
            rejected.append({"line": line_no, "reason": "Пустой UID — строку не с чем сопоставить"})
            continue
        try:
            bw_id = int(raw_uid)
        except (TypeError, ValueError):
            rejected.append({"line": line_no, "reason": f"UID «{raw_uid}» — не целое число"})
            continue
        if bw_id in seen:
            rejected.append({"line": line_no, "bw_id": bw_id,
                             "reason": "UID повторяется в файле — какую из строк применять, неизвестно"})
            continue
        seen.add(bw_id)
        row = by_id.get(bw_id)
        if row is None:
            rejected.append({"line": line_no, "bw_id": bw_id,
                             "reason": "Запланированная работа с таким UID не найдена среди активных на объекте"})
            continue
        item_changes, item_rejected = _diff_row(row, values, percents.get(bw_id, 0), line_no)
        changes.extend(item_changes)
        rejected.extend(item_rejected)

    touched = {c["bw_id"] for c in changes}
    rows_out = [
        {"bw_id": row["id"],
         "values": display_values(
             row, percents.get(row["id"], 0),
             fact_dates.get((row["block_id"], row["work_type_id"]), (None, None)))}
        for row in rows if row["id"] in touched
    ]
    return {
        "rows_read": len(parsed),
        "block_works_touched": len(touched),
        "columns": [{"key": k, "label": l, "editable": e} for k, l, e in COLUMNS],
        "block_works": rows_out,
        "changes": changes,
        "rejected": rejected,
    }


def _diff_row(row, values: dict, current_percent: int, line_no: int) -> tuple:
    changes, rejected = [], []

    def describe(field, was, now, **extra):
        return {
            "bw_id": row["id"], "line": line_no,
            "block_id": row["block_id"], "work_type_id": row["work_type_id"],
            "field": field, "field_label": FIELD_LABELS.get(field, field), "column": field,
            "was": was, "now": now, **extra,
        }

    # --- прогресс + дата фиксации: ОДИН факт-документ, не два независимых
    # поля (см. docstring модуля). Дата без изменения процента ничего не
    # значит и молча игнорируется — пересохранять то же значение факта не
    # событие.
    if "percent" in values:
        try:
            new_percent = _parse_percent_cell(values["percent"])
        except ValueError as exc:
            rejected.append({"line": line_no, "bw_id": row["id"], "reason": str(exc)})
            new_percent = None
        if new_percent is not None and new_percent != current_percent:
            try:
                report_date = _parse_date_cell(values.get("report_date"), "Дата фиксации прогресса")
            except ValueError as exc:
                rejected.append({"line": line_no, "bw_id": row["id"], "reason": str(exc)})
                report_date = None
            if report_date is None and values.get("report_date") is None:
                rejected.append({
                    "line": line_no, "bw_id": row["id"],
                    "reason": "Изменён «Прогресс выполнения», но не указана «Дата фиксации прогресса»",
                })
            elif report_date:
                changes.append(describe("percent", current_percent, new_percent, report_date=report_date))

    # --- сроки: обычный построчный диф, каждое изменившееся поле — своя запись
    for field, label in (("plan_start", "Дата начала СМР, базовый"),
                         ("plan_end", "Дата завершения СМР, базовый"),
                         ("forecast_start", "Дата начала СМР, актуализированный"),
                         ("forecast_end", "Дата завершения СМР, актуализированный")):
        if field not in values:
            continue
        try:
            new = _parse_date_cell(values[field], label)
        except ValueError as exc:
            rejected.append({"line": line_no, "bw_id": row["id"], "reason": str(exc)})
            continue
        if new != row[field]:
            changes.append(describe(field, row[field], new))

    return changes, rejected


# ---------------------------------------------------------------- запись

def apply_changes(conn, object_id: int, selections: list, user_id: int) -> dict:
    """Применяет ОТМЕЧЕННЫЕ пользователем изменения — ровно то, что вернул
    analyze, отфильтрованное флажками (файл заново не читается, тот же
    довод, что у ЖБИ: применить обязаны то, что показали на экране).

    Белый список полей — по составу COLUMNS с editable=True, а не по имени
    колонки `block_works` напрямую: без него через файл можно было бы
    записать произвольную колонку таблицы (тот же приём и то же основание,
    что у app/element_bulk_edit.py::apply_changes)."""
    разрешено = {k for k, _, editable in COLUMNS if editable}
    неизвестные = {str(sel.get("field")) for sel in selections} - разрешено
    if неизвестные:
        raise ValueError("Недопустимые поля для правки: " + ", ".join(sorted(неизвестные)))

    by_bw: dict = {}
    for sel in selections:
        by_bw.setdefault(int(sel["bw_id"]), []).append(sel)

    skipped = []
    затронуто = set()
    # (block_id, report_date) -> {work_type_id: percent} — несколько ЗР
    # одного блока с ОДНОЙ датой в файле уходят ОДНИМ документом факта;
    # разные даты — разными документами (решение пользователя).
    fact_groups: dict = {}

    for bw_id, items in by_bw.items():
        plan_kwargs = {}
        for sel in items:
            field = sel["field"]
            if field == "percent":
                block_id = sel.get("block_id")
                report_date = sel.get("report_date")
                work_type_id = sel.get("work_type_id")
                if not report_date or block_id is None or work_type_id is None:
                    skipped.append({"bw_id": bw_id, "reason": "Неполные данные фиксации прогресса"})
                    continue
                fact_groups.setdefault((block_id, report_date), {})[work_type_id] = sel["now"]
                затронуто.add(bw_id)
            elif field in ("plan_start", "plan_end", "forecast_start", "forecast_end"):
                plan_kwargs[field] = sel["now"]

        if plan_kwargs:
            try:
                block_works.update_block_work(conn, object_id, bw_id, user_id, **plan_kwargs)
                затронуто.add(bw_id)
            except work_fact.FactError as exc:
                skipped.append({"bw_id": bw_id, "reason": exc.message})

    отчётов = 0
    for (block_id, report_date), work_type_percents in fact_groups.items():
        try:
            work_fact.save_report(conn, object_id, user_id, block_id, None, report_date,
                                  work_type_percents)
            отчётов += 1
        except work_fact.FactError as exc:
            for wt_id in work_type_percents:
                skipped.append({"reason": f"Блок {block_id}, {report_date}: {exc.message}"})

    conn.commit()
    if затронуто:
        activity.log("block_bulk_edit", user_id=user_id,
                     entity_type="object", entity_id=object_id,
                     details={"block_works_updated": len(затронуто),
                              "fact_reports_created": отчётов, "source": "xlsx"})
    return {"block_works_updated": len(затронуто), "fact_reports_created": отчётов,
            "skipped": skipped}

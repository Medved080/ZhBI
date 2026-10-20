"""Проверка готового файла выгрузки калькуляций (XLSX) на то, из-за чего Excel «восстанавливает» книгу или заменяет лист пустым.

Excel строже, чем ExcelJS и openpyxl, которые такие файлы читают без замечаний: он ругается на порядок элементов внутри листа и на примечания длиннее
32 767 знаков. Выгрузка собирается в браузере, Excel на сервере нет, поэтому здесь — проверка по спецификации (ECMA-376, порядок элементов CT_Worksheet,
CT_SheetPr, CT_SheetView, CT_Row, CT_Cell, CT_Workbook), а не «открылось у меня».

Что проверяется:
  * каждая часть .xml разбирается как XML;
  * порядок и единственность дочерних элементов у worksheet, sheetPr, sheetViews/sheetView, row, c, workbook;
  * строки по возрастанию, ячейки в строке по возрастанию столбцов;
  * примечания и строки — не длиннее 32 767 знаков; формулы — не длиннее 8192;
  * имена листов: до 31 знака, без запрещённых знаков, без повторов;
  * оглавление (если первый лист «Оглавление»): каждая ссылка HYPERLINK ведёт на существующий лист, формулы стоимости — на существующие листы.
Запуск:  .venv312/bin/python scripts/verify_calc_xlsx.py "Калькуляция ЖБИ.xlsx" [ещё.xlsx …]   (код возврата 1 при любой ошибке)
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
WORKSHEET = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter",
             "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions",
             "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
             "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"]
MANY = {"conditionalFormatting"}
SHEET_PR = ["tabColor", "outlinePr", "pageSetUpPr"]
SHEET_VIEW = ["pane", "selection", "pivotSelection", "extLst"]
WORKBOOK = ["fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups", "externalReferences", "definedNames",
            "calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"]
CELL = ["f", "v", "is", "extLst"]
NOTE_LIMIT, STRING_LIMIT, FORMULA_LIMIT = 32767, 32767, 8192
BAD_SHEET_CHARS = set('\\/*?:[]')


def local(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def column_number(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    number = 0
    for ch in letters:
        number = number * 26 + ord(ch) - 64
    return number


def order_errors(parent, order, where, many=()):
    """Дочерние элементы родителя идут в порядке order, каждый не более одного раза (кроме many)."""
    errors, last, seen = [], -1, set()
    for child in parent:
        name = local(child.tag)
        if name not in order:
            errors.append("%s: неизвестный элемент <%s>" % (where, name)); continue
        index = order.index(name)
        if index < last:
            errors.append("%s: <%s> стоит после <%s>, по схеме — раньше (порядок: %s)" % (where, name, order[last], " → ".join(order)))
        if name in seen and name not in many:
            errors.append("%s: <%s> встречается больше одного раза" % (where, name))
        seen.add(name); last = max(last, index)
    return errors


def check_sheet(xml, where):
    errors = []
    root = ET.fromstring(xml)
    errors += order_errors(root, WORKSHEET, where, MANY)
    for child in root:
        name = local(child.tag)
        if name == "sheetPr":
            errors += order_errors(child, SHEET_PR, where + " / sheetPr")
        elif name == "sheetViews":
            for view in child:
                errors += order_errors(view, SHEET_VIEW, where + " / sheetView", many={"selection", "pivotSelection"})
        elif name == "sheetData":
            previous_row = 0
            for row in child:
                number = int(row.get("r"))
                if number <= previous_row:
                    errors.append("%s: строка %d идёт после строки %d" % (where, number, previous_row))
                previous_row = number
                previous_col = 0
                for cell in row:
                    col = column_number(cell.get("r"))
                    if col <= previous_col:
                        errors.append("%s: ячейка %s идёт не по порядку столбцов" % (where, cell.get("r")))
                    previous_col = col
                    errors += order_errors(cell, CELL, where + " / " + cell.get("r"))
                    formula = cell.find(NS + "f")
                    if formula is not None and len(formula.text or "") > FORMULA_LIMIT:
                        errors.append("%s: формула %s длиннее %d знаков" % (where, cell.get("r"), FORMULA_LIMIT))
    return errors


def check_book(path):
    errors, notes = [], []
    z = zipfile.ZipFile(path)
    bad = z.testzip()
    if bad:
        errors.append("zip: повреждена часть " + bad)
    names = z.namelist()
    workbook = ET.fromstring(z.read("xl/workbook.xml"))
    errors += order_errors(workbook, WORKBOOK, "workbook.xml")
    sheet_names = [s.get("name") for s in workbook.find(NS + "sheets")]
    lowered = [n.lower() for n in sheet_names]
    for n in sheet_names:
        if len(n) > 31 or BAD_SHEET_CHARS & set(n) or n.startswith("'") or n.endswith("'"):
            errors.append("имя листа «%s» недопустимо" % n)
    if len(set(lowered)) != len(lowered):
        errors.append("имена листов повторяются без учёта регистра")
    sheet_parts = sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=lambda n: int(re.search(r"(\d+)\.xml", n).group(1)))
    for part in sheet_parts:
        found = check_sheet(z.read(part), part)
        errors += found[:5] + (["%s: …и ещё %d замечаний" % (part, len(found) - 5)] if len(found) > 5 else [])
    over = longest = 0
    for name in names:
        if name.endswith(".xml") and name not in sheet_parts and name != "xl/workbook.xml":
            try:
                ET.fromstring(z.read(name))
            except ET.ParseError as error:
                errors.append("%s: не разбирается как XML (%s)" % (name, error))
        if re.fullmatch(r"xl/comments\d+\.xml", name):
            for comment in ET.fromstring(z.read(name)).iter(NS + "comment"):
                size = len("".join(t.text or "" for t in comment.iter(NS + "t")))
                longest = max(longest, size); over += size > NOTE_LIMIT
    if over:
        errors.append("примечаний длиннее %d знаков: %d (самое длинное %d)" % (NOTE_LIMIT, over, longest))
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si"):
            if len("".join(t.text or "" for t in si.iter(NS + "t"))) > STRING_LIMIT:
                errors.append("строка длиннее %d знаков в sharedStrings" % STRING_LIMIT); break
    if sheet_names and sheet_names[0] == "Оглавление":
        toc = z.read(sheet_parts[0]).decode("utf-8")
        known = {n.replace("'", "''") for n in sheet_names}
        links = re.findall(r"HYPERLINK\(&quot;#&apos;((?:(?!&apos;!).)+)&apos;!A1&quot;", toc)
        costs = re.findall(r"<f>&apos;((?:(?!&apos;!).)+)&apos;!G\d+</f>", toc)
        missing = {n for n in links + costs if n.replace("&apos;&apos;", "''") not in known}
        if missing:
            errors.append("оглавление: нет листа для %d ссылок, например «%s»" % (len(missing), sorted(missing)[0]))
        notes.append("оглавление: ссылок %d, формул стоимости %d" % (len(links), len(costs)))
    notes.insert(0, "листов %d, примечаний-максимум %d знаков" % (len(sheet_names), longest))
    return errors, notes


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    failed = False
    for path in sys.argv[1:]:
        problems, info = check_book(path)
        print(("FAIL " if problems else "ok   ") + path.split("/")[-1] + " — " + "; ".join(info))
        for line in problems:
            print("       " + line)
        failed = failed or bool(problems)
    sys.exit(1 if failed else 0)

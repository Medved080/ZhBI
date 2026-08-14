# -*- coding: utf-8 -*-
"""
Экспортёр модели Revit в пакет выгрузки для ЖБИ-трекера.

Запускается ВНУТРИ Revit — из pyRevit, RevitPythonShell или Python-узла
Dynamo — на ОТКРЫТОЙ ОТСОЕДИНЁННОЙ КОПИИ модели, не на центральном файле.
Наружу отдаёт один компактный файл `<модель>.zhbi.json.gz`: сотни мегабайт
.rvt превращаются в единицы мегабайт, которые можно переслать почтой.

Почему выгрузка, а не чтение .rvt на сервере: см. Docs/revit-import.md.
Коротко — .rvt распаковывается (это gzip-блоки), но связка «элемент → его
параметры → его геометрия» лежит в недокументированном двоичном формате,
меняющемся между версиями Revit. Revit API отдаёт то же самое надёжно.

Совместимость: код держится в рамках, понятных и IronPython 2.7 (движок
pyRevit/Dynamo по умолчанию для Revit 2022), и CPython 3 — без f-строк и
прочего синтаксиса, которого нет в 2.7.

Настройки — в блоке КОНФИГУРАЦИЯ ниже. Для первой ПРОБНОЙ выгрузки
поставьте MAX_ELEMENTS = 2000: она пройдёт за минуту и сразу покажет,
заполнены ли MCY_Секция и MCY_Этаж и берётся ли контур.
"""

from __future__ import unicode_literals

import collections
import gzip
import io
import json
import os
import re
import sys
import traceback
from datetime import datetime

from Autodesk.Revit.DB import (
    BuiltInCategory, BuiltInParameter, ElementId, ElementMulticategoryFilter,
    ExtrusionAnalyzer, FilteredElementCollector, GeometryInstance, Level,
    Options, Plane, Solid, StorageType, ViewDetailLevel, XYZ,
)

try:
    from System.Collections.Generic import List as NetList
except ImportError:
    NetList = None


# ============================ КОНФИГУРАЦИЯ ============================

# Ограничение для пробного прогона. None — выгружать всё.
MAX_ELEMENTS = None

# Считать контур в плане. Самая дорогая часть; для проверки состава
# параметров можно временно выключить.
WITH_GEOMETRY = True

# Куда класть результат. None — рядом с моделью, а если она не сохранена,
# то на рабочий стол.
OUTPUT_DIR = None

# Категории, которые вообще попадают в выгрузку. Инженерные разделы
# намеренно не включены — трекер их пока не ведёт (Docs/revit-import.md).
CATEGORIES = [
    BuiltInCategory.OST_StructuralColumns,
    BuiltInCategory.OST_StructuralFraming,
    BuiltInCategory.OST_StructuralFoundation,
    BuiltInCategory.OST_Floors,
    BuiltInCategory.OST_Walls,
    BuiltInCategory.OST_Columns,
    BuiltInCategory.OST_Stairs,
    BuiltInCategory.OST_Roofs,
    BuiltInCategory.OST_Ceilings,
    BuiltInCategory.OST_GenericModel,
]

# Именованные параметры, которые снимаем с каждого элемента. Список
# вычитан из самой модели КР (см. Docs/revit-import.md, «Адресация уже
# стандартизована заказчиком»): это общие параметры МСУ-1.
# Слева — как назвать поле в пакете, справа — имена-кандидаты в Revit
# (берётся первое найденное; сначала у экземпляра, потом у типа).
NAMED_PARAMS = [
    ("секция",        ["MCY_Секция", "МСУ_Секция"]),
    ("этаж",          ["MCY_Этаж", "МСУ_Этаж"]),
    ("корпус",        ["MCY_Корпус", "МСУ_Корпус"]),
    ("тип_этажа",     ["MCY_Тип этажа", "МСУ_Тип этажа"]),
    ("часть_здания",  ["MCY_Часть здания", "МСУ_Часть здания"]),
    ("раздел_модели", ["MCY_Раздел", "МСУ_Раздел"]),
    ("марка_конструкции", ["Мрк.МаркаКонструкции"]),
    ("марка_изделия",     ["Мрк.МаркаИзделия"]),
    ("бетон_w",       ["Мтрл.МаркаБетонаW"]),
    ("бетон_f",       ["Мтрл.МаркаБетонаF"]),
    ("id_1c",         ["ASML_1C_Id"]),
]

# Код раздела проекта. Если пусто — берётся из параметра MCY_Раздел
# сведений о проекте, иначе угадывается по имени файла. Это ОБЛАСТЬ, в
# границах которой сервер считает «элемент исчез из модели», поэтому
# значение печатается в сводке — проверьте его перед отправкой.
SECTION_CODE = ""

FEET_TO_MM = 304.8
SCHEMA_VERSION = 1
EXPORTER_VERSION = "1.0"

# ======================================================================


def get_document():
    """Документ из любого хоста: pyRevit, RevitPythonShell или Dynamo."""
    try:
        return __revit__.ActiveUIDocument.Document  # noqa: F821
    except NameError:
        pass
    try:
        from RevitServices.Persistence import DocumentManager
        return DocumentManager.Instance.CurrentDBDocument
    except ImportError:
        raise RuntimeError(
            "Не удалось получить документ Revit. Запустите скрипт из "
            "pyRevit, RevitPythonShell или Python-узла Dynamo."
        )


def doc_name(document):
    """Имя модели. У ОТСОЕДИНЁННОЙ и ещё не сохранённой копии PathName
    пустой — тогда берём Title (он есть всегда). Без этого и раздел не
    угадывается, и файл некуда положить."""
    path = ""
    try:
        path = document.PathName or ""
    except Exception:
        path = ""
    if path:
        return os.path.basename(path)
    try:
        return document.Title or "model"
    except Exception:
        return "model"


def mm(value):
    """Футы Revit -> миллиметры, с округлением до 0.1 мм: больше точности
    в пакете не нужно, а размер файла она увеличивает заметно."""
    return round(value * FEET_TO_MM, 1)


def param_value(param):
    """Значение параметра в виде, пригодном для JSON."""
    if param is None or not param.HasValue:
        return None
    st = param.StorageType
    if st == StorageType.String:
        return param.AsString()
    if st == StorageType.Integer:
        return param.AsInteger()
    if st == StorageType.Double:
        return param.AsDouble()
    if st == StorageType.ElementId:
        eid = param.AsElementId()
        return eid.IntegerValue if eid is not None else None
    return param.AsValueString()


def lookup(element, type_element, names):
    """Первый найденный параметр из списка кандидатов: сначала у
    экземпляра, потом у типа. Порядок важен — адресные параметры МСУ-1
    заводятся у экземпляра, а марки бетона обычно у типа."""
    for name in names:
        p = element.LookupParameter(name)
        value = param_value(p)
        if value not in (None, ""):
            return value
    if type_element is not None:
        for name in names:
            p = type_element.LookupParameter(name)
            value = param_value(p)
            if value not in (None, ""):
                return value
    return None


def builtin(element, bip):
    try:
        return param_value(element.get_Parameter(bip))
    except Exception:
        return None


def solids_of(element, options):
    """Все непустые солиды элемента, включая вложенные в экземпляры
    семейств (GeometryInstance): у большинства ЖБИ-элементов геометрия
    лежит именно там, а не прямо в GeometryElement."""
    result = []
    try:
        geometry = element.get_Geometry(options)
    except Exception:
        return result
    if geometry is None:
        return result

    stack = [geometry]
    while stack:
        current = stack.pop()
        for item in current:
            if isinstance(item, Solid):
                if item.Volume > 1e-6:
                    result.append(item)
            elif isinstance(item, GeometryInstance):
                try:
                    stack.append(item.GetInstanceGeometry())
                except Exception:
                    pass
    return result


def footprint(solid, transform):
    """Контур элемента в плане: проекция тела на горизонтальную плоскость.

    ExtrusionAnalyzer делает ровно это — отдаёт грань-основание
    выдавливания вдоль Z. Он честнее габаритного прямоугольника: у
    повёрнутых элементов и Г-образных пилонов bounding box сильно врёт, а
    трекер рисует контур один в один.
    """
    try:
        plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero)
        analyzer = ExtrusionAnalyzer.Create(solid, plane, XYZ.BasisZ)
        face = analyzer.GetExtrusionBase()
    except Exception:
        return None

    best = None
    try:
        loops = face.GetEdgesAsCurveLoops()
    except Exception:
        return None

    for loop in loops:
        points = []
        for curve in loop:
            # Tessellate разбивает и дуги: контур получается замкнутым
            # ломаным, как его и хранит трекер (outline_json).
            for point in curve.Tessellate():
                points.append(point)
        if len(points) < 3:
            continue
        if best is None or len(points) > len(best):
            best = points

    if not best:
        return None

    outline = []
    previous = None
    for point in best:
        shared = transform.OfPoint(point) if transform is not None else point
        pair = [mm(shared.X), mm(shared.Y)]
        if pair != previous:          # соседние совпадающие точки — мусор
            outline.append(pair)
        previous = pair
    if len(outline) > 1 and outline[0] == outline[-1]:
        outline.pop()
    return outline if len(outline) >= 3 else None


def bbox_outline(element, transform):
    """Запасной контур — габаритный прямоугольник. Хуже настоящего, но
    лучше пустоты: элемент без контура трекер не покажет вовсе."""
    try:
        box = element.get_BoundingBox(None)
    except Exception:
        return None
    if box is None:
        return None
    lo, hi = box.Min, box.Max
    corners = [XYZ(lo.X, lo.Y, lo.Z), XYZ(hi.X, lo.Y, lo.Z),
               XYZ(hi.X, hi.Y, lo.Z), XYZ(lo.X, hi.Y, lo.Z)]
    result = []
    for point in corners:
        shared = transform.OfPoint(point) if transform is not None else point
        result.append([mm(shared.X), mm(shared.Y)])
    return result


def level_name_of(document, element, cache):
    """Уровень элемента. У разных категорий он лежит в разных местах:
    у большинства — LevelId, у балок и перекрытий — в своих параметрах."""
    level_id = None
    try:
        level_id = element.LevelId
    except Exception:
        level_id = None
    if level_id is None or level_id == ElementId.InvalidElementId:
        for bip in (BuiltInParameter.FAMILY_LEVEL_PARAM,
                    BuiltInParameter.SCHEDULE_LEVEL_PARAM,
                    BuiltInParameter.LEVEL_PARAM,
                    BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM):
            try:
                p = element.get_Parameter(bip)
            except Exception:
                p = None
            if p is not None and p.HasValue:
                candidate = p.AsElementId()
                if candidate is not None and candidate != ElementId.InvalidElementId:
                    level_id = candidate
                    break
    if level_id is None or level_id == ElementId.InvalidElementId:
        return None
    key = level_id.IntegerValue
    if key not in cache:
        level = document.GetElement(level_id)
        cache[key] = level.Name if level is not None else None
    return cache[key]


def collect_levels(document):
    out = []
    for level in FilteredElementCollector(document).OfClass(Level):
        out.append({"имя": level.Name, "отметка": mm(level.Elevation)})
    out.sort(key=lambda item: item["отметка"])
    return out


def collect_grids(document, transform):
    """Сетка осей. В Revit это штатные Grid — в отличие от DXF, где оси
    приходилось угадывать по слоям."""
    out = []
    collector = FilteredElementCollector(document).OfCategory(
        BuiltInCategory.OST_Grids).WhereElementIsNotElementType()
    for grid in collector:
        try:
            curve = grid.Curve
            a, b = curve.GetEndPoint(0), curve.GetEndPoint(1)
        except Exception:
            continue
        if transform is not None:
            a, b = transform.OfPoint(a), transform.OfPoint(b)
        name = grid.Name or ""
        out.append({
            "имя": name,
            "тип": "цифровая" if re.match(r'^\s*\d', name) else "буквенная",
            "точки": [[mm(a.X), mm(a.Y)], [mm(b.X), mm(b.Y)]],
        })
    return out


def collect_rooms(document, transform):
    """Помещения — основа для квартир (виды работ в единице кв.эт/сек,
    см. Docs/block-accounting.md). В модели КР их обычно нет, в АР есть."""
    out = []
    try:
        collector = FilteredElementCollector(document).OfCategory(
            BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
    except Exception:
        return out
    for room in collector:
        try:
            area = room.Area
        except Exception:
            area = 0
        if not area:
            continue                      # неразмещённое помещение
        type_element = None
        out.append({
            "uid": room.UniqueId,
            "номер": builtin(room, BuiltInParameter.ROOM_NUMBER),
            "имя": builtin(room, BuiltInParameter.ROOM_NAME),
            "площадь": round(area * FEET_TO_MM * FEET_TO_MM / 1e6, 3),
            "уровень": level_name_of(document, room, {}),
            "секция": lookup(room, type_element, ["MCY_Секция", "МСУ_Секция"]),
            "этаж": lookup(room, type_element, ["MCY_Этаж", "МСУ_Этаж"]),
        })
    return out


def resolve_section_code(document):
    """Код раздела: явная настройка -> параметр сведений о проекте ->
    догадка по имени файла. Всегда печатается в сводке."""
    if SECTION_CODE:
        return SECTION_CODE, "задан в скрипте"
    try:
        info = document.ProjectInformation
        for name in ("MCY_Раздел", "МСУ_Раздел"):
            value = param_value(info.LookupParameter(name))
            if value:
                return value, "параметр сведений о проекте"
    except Exception:
        pass
    name = doc_name(document)
    found = re.search(r'_(КР|АР|ВК|ОВ\d?|СС|ЭОМ|ИТП|КЖ|АС|А)[_\.]', name)
    if found:
        return found.group(1), "угадан по имени файла"
    return "?", "НЕ ОПРЕДЕЛЁН — задайте SECTION_CODE вручную"


def output_path(document):
    base = doc_name(document)
    base = os.path.splitext(base)[0]
    folder = OUTPUT_DIR
    if not folder:
        folder = os.path.dirname(document.PathName or "")
    if not folder or not os.path.isdir(folder):
        folder = os.path.join(os.path.expanduser("~"), "Desktop")
    return os.path.join(folder, base + ".zhbi.json.gz")


def export():
    document = get_document()
    transform = None
    try:
        # Общие координаты: без них разделы не совместятся друг с другом.
        # Проверьте на первой выгрузке — сверьте координату известной оси.
        transform = document.ActiveProjectLocation.GetTotalTransform().Inverse
    except Exception:
        transform = None

    code, code_source = resolve_section_code(document)

    options = Options()
    options.DetailLevel = ViewDetailLevel.Coarse   # заметно быстрее Fine
    options.ComputeReferences = False
    options.IncludeNonVisibleObjects = False

    if NetList is not None:
        categories = NetList[BuiltInCategory](CATEGORIES)
    else:
        categories = CATEGORIES
    collector = (FilteredElementCollector(document)
                 .WherePasses(ElementMulticategoryFilter(categories))
                 .WhereElementIsNotElementType())

    level_cache = {}
    type_cache = {}
    elements = []
    stats = {"всего": 0, "с_контуром": 0, "контур_габаритом": 0,
             "без_геометрии": 0, "с_секцией": 0, "с_этажом": 0, "с_маркой": 0,
             "с_уровнем": 0}
    by_category = {}

    # Распределение ЗНАЧЕНИЙ адресных полей, а не только заполненность.
    # Выяснилось на спецификации заказчика (Docs/block-accounting.md):
    # MCY_Этаж содержит ТИП этажа («Типовой этаж» у 73% элементов), а не
    # номер, и значения приезжают в разных падежах и числах. Пока не видно
    # самих значений, «заполнено у 100%» вводит в заблуждение.
    values = {"секция": collections.Counter(), "этаж": collections.Counter(),
              "тип_этажа": collections.Counter(), "уровень": collections.Counter()}

    for element in collector:
        if MAX_ELEMENTS is not None and stats["всего"] >= MAX_ELEMENTS:
            break
        stats["всего"] += 1
        if stats["всего"] % 2000 == 0:
            print("  обработано %d..." % stats["всего"])

        try:
            type_id = element.GetTypeId()
            key = type_id.IntegerValue
            if key not in type_cache:
                type_cache[key] = document.GetElement(type_id)
            type_element = type_cache[key]

            category = element.Category.Name if element.Category else None
            by_category[category] = by_category.get(category, 0) + 1

            row = {
                "uid": element.UniqueId,
                "id": element.Id.IntegerValue,
                "категория": category,
                "семейство": None,
                "типоразмер": None,
                "уровень": level_name_of(document, element, level_cache),
                "рабочий_набор": None,
            }
            if type_element is not None:
                row["типоразмер"] = getattr(type_element, "Name", None)
                family = getattr(type_element, "FamilyName", None)
                row["семейство"] = family

            for field, names in NAMED_PARAMS:
                row[field] = lookup(element, type_element, names)

            row["марка"] = (row.get("марка_изделия")
                            or row.get("марка_конструкции")
                            or builtin(element, BuiltInParameter.ALL_MODEL_MARK))
            if row["марка"]:
                stats["с_маркой"] += 1
            if row.get("секция"):
                stats["с_секцией"] += 1
            if row.get("этаж"):
                stats["с_этажом"] += 1
            if row.get("уровень"):
                stats["с_уровнем"] += 1
            for field in values:
                values[field][row.get(field) or "<пусто>"] += 1

            try:
                row["рабочий_набор"] = builtin(
                    element, BuiltInParameter.ELEM_PARTITION_PARAM)
            except Exception:
                pass

            volume = builtin(element, BuiltInParameter.HOST_VOLUME_COMPUTED)
            if volume:
                row["объём"] = round(volume * (FEET_TO_MM ** 3) / 1e9, 4)
            area = builtin(element, BuiltInParameter.HOST_AREA_COMPUTED)
            if area:
                row["площадь"] = round(area * (FEET_TO_MM ** 2) / 1e6, 3)

            box = element.get_BoundingBox(None)
            if box is not None:
                lo = transform.OfPoint(box.Min) if transform else box.Min
                hi = transform.OfPoint(box.Max) if transform else box.Max
                row["отметка_низа"] = mm(min(lo.Z, hi.Z))
                row["высота"] = mm(abs(hi.Z - lo.Z))
                row["точка"] = [mm((lo.X + hi.X) / 2.0),
                                mm((lo.Y + hi.Y) / 2.0),
                                mm(min(lo.Z, hi.Z))]

            if WITH_GEOMETRY:
                outline = None
                solids = solids_of(element, options)
                if solids:
                    largest = max(solids, key=lambda s: s.Volume)
                    outline = footprint(largest, transform)
                if outline:
                    row["контур"] = outline
                    stats["с_контуром"] += 1
                else:
                    outline = bbox_outline(element, transform)
                    if outline:
                        row["контур"] = outline
                        row["контур_приблизительный"] = True
                        stats["контур_габаритом"] += 1
                    else:
                        stats["без_геометрии"] += 1

            elements.append(row)
        except Exception:
            stats["без_геометрии"] += 1
            continue

    package = {
        "формат": "zhbi-revit-package",
        "версия_схемы": SCHEMA_VERSION,
        "выгрузка": {
            "раздел": code,
            "модель": doc_name(document),
            "дата": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "экспортёр": EXPORTER_VERSION,
            "единицы": "мм",
            "координаты": "общие" if transform is not None else "внутренние",
            "неполная_выгрузка": MAX_ELEMENTS is not None,
        },
        "уровни": collect_levels(document),
        "оси": collect_grids(document, transform),
        "помещения": collect_rooms(document, transform),
        "элементы": elements,
    }

    path = output_path(document)
    payload = json.dumps(package, ensure_ascii=False).encode("utf-8")
    try:
        handle = gzip.GzipFile(path, "wb")
        try:
            handle.write(payload)
        finally:
            handle.close()
    except Exception:
        path = path[:-3]
        stream = io.open(path, "wb")
        try:
            stream.write(payload)
        finally:
            stream.close()

    # Отчёт собирается СТРОКАМИ, а не печатается сразу: в Python-узле
    # Dynamo окна вывода нет, и единственный надёжный способ его увидеть —
    # получить текстом (OUT) и файлом рядом с пакетом.
    report = []

    def say(line=""):
        report.append(line)
        try:
            print(line)
        except Exception:
            pass

    total = max(stats["всего"], 1)
    say("=" * 62)
    say("РАЗДЕЛ: %s  (%s)" % (code, code_source))
    say("Модель: %s" % package["выгрузка"]["модель"])
    say("Координаты: %s" % package["выгрузка"]["координаты"])
    say("Элементов выгружено: %d" % stats["всего"])
    if MAX_ELEMENTS is not None:
        say("  ВНИМАНИЕ: пробный прогон, MAX_ELEMENTS = %d" % MAX_ELEMENTS)
    say("Уровней: %d, осей: %d, помещений: %d"
        % (len(package["уровни"]), len(package["оси"]),
           len(package["помещения"])))
    say("-" * 62)
    say("MCY_Секция заполнена у  %d (%d%%)"
        % (stats["с_секцией"], stats["с_секцией"] * 100 // total))
    say("MCY_Этаж заполнен у     %d (%d%%)"
        % (stats["с_этажом"], stats["с_этажом"] * 100 // total))
    say("Марка есть у            %d (%d%%)"
        % (stats["с_маркой"], stats["с_маркой"] * 100 // total))
    say("Уровень (Level) есть у  %d (%d%%)"
        % (stats["с_уровнем"], stats["с_уровнем"] * 100 // total))
    if WITH_GEOMETRY:
        say("Контур настоящий:       %d" % stats["с_контуром"])
        say("Контур габаритом:       %d" % stats["контур_габаритом"])
        say("Без геометрии:          %d" % stats["без_геометрии"])
    for field in ("секция", "этаж", "тип_этажа", "уровень"):
        counter = values[field]
        say("-" * 62)
        say("ЗНАЧЕНИЯ «%s» — уникальных %d:" % (field, len(counter)))
        for value, count in counter.most_common(20):
            say("   %6d  %s" % (count, value))
    say("-" * 62)
    say("ПО КАТЕГОРИЯМ:")
    for name in sorted(by_category, key=lambda k: -by_category[k]):
        say("   %6d  %s" % (by_category[name], name))
    say("-" * 62)
    say("УРОВНИ МОДЕЛИ:")
    for level in package["уровни"]:
        say("   %10.1f мм  %s" % (level["отметка"], level["имя"]))
    say("-" * 62)
    say("Файл пакета: %s" % path)
    say("Размер: %.1f МБ" % (os.path.getsize(path) / 1048576.0))
    say("=" * 62)

    text = "\n".join(report)
    report_path = os.path.splitext(os.path.splitext(path)[0])[0] + ".отчёт.txt"
    try:
        stream = io.open(report_path, "w", encoding="utf-8")
        try:
            stream.write(text)
        finally:
            stream.close()
        say("Отчёт: %s" % report_path)
    except Exception:
        pass
    return text


# Вызов без защиты `if __name__ == "__main__"`: в Python-узле Dynamo имя
# модуля не гарантируется, и под защитой скрипт молча ничего бы не сделал.
try:
    OUT = export()
except Exception:
    OUT = "ОШИБКА выгрузки:\n" + traceback.format_exc()
    try:
        print(OUT)
    except Exception:
        pass

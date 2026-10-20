"""Слой «прочитано с листа»: объём и класс бетона, арматура изделий, которых нет в каталоге поставщика (assets/promka-readings.json).

Файл собирает scripts/build_calc_readings.py по листам изделий (data/calc/assets/sources/docNN.pdf; метод — scripts/prototypes/vector_ocr/) и
кладёт рядом с каталогом; он передаётся на серверы как остальные файлы каталога. Наложение консервативно: заполняются только пробелы —
нет проектного объёма, класс бетона «не указан», нет ресурсов; значения каталога поставщика не перезаписываются. У наложенных моделей
есть `readings` (что взято, лист, «не подтверждено человеком») и заметка в `notes`. Ручные правки изделия, как и раньше, главнее."""
import json
from pathlib import Path

SOURCE_FILE = "promka-readings.json"


def reviewed_page_matches(reading, source):
    """A reviewed assembly may survive a missing drawing, linked by its register page."""
    sheet = reading.get("sheet") or {}
    if source.get("id") != "doc%02d" % sheet.get("doc", 0):
        return False
    if sheet.get("drawingMissing"):
        return (source.get("pageVerified") is False
                and bool(sheet.get("page"))
                and bool(source.get("registerPage"))
                and sheet.get("registerPage") == source["registerPage"] == source.get("productPage"))
    page = sheet.get("drawingPage") or sheet.get("page")
    return bool(page) and page == source.get("productPage")


def resource_id(cls, diameter):
    """Код ресурса каталога: steel16A500C, steel3Vr1, steel12K7 (латиница, как в каталоге моделей)."""
    if cls.upper().startswith("ВР"):
        return "steel%dVr1" % diameter
    return "steel%d%s" % (diameter, cls.translate(str.maketrans("АСК", "ACK")))


def resource_name(cls, diameter):
    if cls.upper().startswith("ВР"):
        return "Проволока Ø%d Вр1" % diameter
    if cls == "К7":
        return "Канат К7 Ø%d" % diameter
    return "Арматура Ø%d %s" % (diameter, cls)


def rebar_of(reading):
    """Арматура из чтения: [(класс, диаметр, кг)] или None. Источник — ведомость расхода стали листа, если все её самопроверки сошлись
    (суммы по диаметрам = «Итого» класса, по классам = «Всего»); иначе сборка по узлам, если нераспознанный остаток не больше 3% массы."""
    rebar = reading.get("rebar") or {}
    sheet = rebar.get("fromSteelSheet") or []
    if sheet and all((rebar.get("steelSheetChecks") or {}).values()):
        return [tuple(x) for x in sheet], "ведомость расхода стали"
    assembly = rebar.get("fromAssembly") or []
    total = sum(x[2] for x in assembly)
    if total > 0 and rebar.get("unresolvedKg", 0) <= 0.03 * (total + rebar.get("unresolvedKg", 0)):
        return [tuple(x) for x in assembly], "сборка по каркасам и сеткам"
    return None, None


EMBEDDED_RESOURCES = {"embedded": ("embeddedParts", "Закладные детали"), "loop": ("loopParts", "Петли и петлевые выпуски")}


def embedded_verified(reading):
    """Сверка закладных и труб с итогом «закладные изделия» ведомости расхода стали листа (у ведомости он равен закладным деталям плюс трубам, петли в нём
    не считаются): True — сошлось в пределах 2%, False — нет, None — итога на листе нет (проверить нечем)."""
    embedded = reading.get("embedded") or {}
    if embedded.get("confirmedBy"): return True      # состав закладных подтверждён проектировщиками (в ведомости листа ошибка): сверка с итогом ведомости не нужна
    total = embedded.get("sheetTotalKg")
    if not total: return None
    mass = sum(item[2] * item[3] for item in embedded.get("items") or [] if item[0] in ("embedded", "pipe"))
    return abs(mass / total - 1) <= 0.02


def embedded_resources(reading, loops=True):
    """Закладные, трубы и петли из чтения: [ресурс]. Закладные и петли — по массе, т (цена за тонну); трубы — по типоразмеру, м (цена за метр, код каталога:
    pipe50 = 50×5, pipe68 = 68×1, остальные — pipeДДxТ). Позиция: [вид, название, масса единицы кг, количество шт., типоразмер трубы, длина трубы в позиции, м]:
    типоразмер и метры сборка (build_calc_readings.py) выставляет сама, у закладных и петель они пустые. loops=False — петли не добавляются (их масса уже в арматуре)."""
    mass = {"embedded": 0.0, "loop": 0.0}; pipes = {}
    for kind, name, unit_mass, qty, size, meters in ((list(i) + [None, None])[:6] for i in (reading.get("embedded") or {}).get("items") or []):
        if kind in mass:
            mass[kind] += unit_mass * qty
        elif kind == "pipe" and size and meters:
            pipes[size] = pipes.get(size, 0.0) + meters
    out = []
    for kind, (identifier, title) in EMBEDDED_RESOURCES.items():
        if mass[kind] > 0 and (loops or kind != "loop"):
            out.append({"id": identifier, "name": title, "unit": "т", "projectQty": round(mass[kind] / 1000, 5), "qty": round(mass[kind] / 1000, 5), "rate": "0"})
    for size, meters in sorted(pipes.items()):
        legacy = {"50x5": "pipe50", "68x1": "pipe68"}.get(size)
        out.append({"id": legacy or "pipe" + size, "name": "Труба " + size.replace("x", "×"), "unit": "м", "projectQty": round(meters, 3), "qty": round(meters, 3), "rate": "0"})
    return out


def without_readings(model):
    """Копия модели в состоянии ДО наложения чтений: объём, класс бетона и ресурсы, которые подставило чтение, возвращены в пробелы.
    Нужна там, где сравнивается сохранённое значение изделия с расчётом по каталогу поставщика (пометка ручных правок): значения, сохранённые до появления
    чтений, ручными правками не являются."""
    info = model.get("readings")
    if not info: return model
    copy = dict(model); applied = " ".join(info.get("applied") or [])
    if "объём" in applied: copy["projectVolume"] = None
    if "класс" in applied: copy["concreteClass"] = "Не указан"
    added = set(info.get("addedResources") or [])
    replaced = info.get("replacedResources") or []
    if added or replaced: copy["resources"] = [r for r in model.get("resources") or [] if r["id"] not in added] + [dict(r) for r in replaced]
    return copy


def apply_readings(models, directory):
    """Накладывает прочитанное на каталог (изменяет models). Возвращает число изменённых моделей."""
    path = Path(directory) / SOURCE_FILE
    if not path.exists():
        return 0
    data = json.loads(path.read_text())
    changed = 0
    from . import reinforcement
    # типичный расход арматуры по самим чтениям листов (они проходят самопроверки по суммам), по группе изделий: данные поставщика для эталона не годятся — у большинства
    # изделий типа они неполные (1КС: 36 кг/м³ при настоящих ~480), и медиана, посчитанная по ним, сама занижена и ошибку не видит
    references = (reinforcement.build_reading_references(models, data, rebar_of), {})
    for key, reading in data.items():
        model = models.get(key)
        if not model or "readings" in model:      # нет такой модели или чтение уже наложено
            continue
        applied = []
        if not model.get("projectVolume") and reading.get("volume"):
            model["projectVolume"] = reading["volume"]
            source = reading.get("volumeSource")      # спецификация / таблица плит / масса ÷ 2500 (где объём на листе не указан, а масса есть)
            applied.append("объём бетона" + (" (" + source + ")" if source and source != "спецификация" else ""))
        if model.get("concreteClass") in (None, "", "Не указан") and reading.get("concreteClass"):
            model["concreteClass"] = reading["concreteClass"]; applied.append("класс бетона")
        rods, source = rebar_of(reading)
        added, replaced = [], []
        steel_counts_loops = bool(model.get("resources"))      # арматура поставщика (ведомость) уже включает петли
        new_steel = [{"id": resource_id(c, d), "name": resource_name(c, d), "unit": "т", "projectQty": round(kg / 1000, 5), "qty": round(kg / 1000, 5), "rate": "0"}
                     for c, d, kg in sorted(rods or [])]
        is_steel = lambda r: r["id"].startswith(reinforcement.STEEL) and r["id"] != reinforcement.ESTIMATE_ID
        supplier_steel = [r for r in model.get("resources") or [] if is_steel(r)]
        # арматура поставщика вне допустимого расхода (кг/м³), а чтение листа — в допустимом: берём чтение (1Р9: у поставщика Ø12 990 кг вместо 9,9; проектировщики 2026-10-19: 286 кг/м³)
        replace = False
        if supplier_steel and new_steel:
            before = reinforcement.assess(model, references)
            after = reinforcement.assess({**model, "resources": new_steel}, references)
            replace = bool(before and before["status"] in ("low", "high") and after and after["status"] == "ok")
        if (not model.get("resources") or not supplier_steel or replace) and new_steel:
            if replace:
                replaced = [dict(r) for r in supplier_steel]
                model["resources"] = new_steel + [r for r in model["resources"] if not is_steel(r)]
                applied.append("арматура (%s; данные поставщика %s кг/м³ вне допустимого диапазона заменены чтением листа %s кг/м³)" % (source, before["value"], after["value"]))
            else:
                model["resources"] = new_steel + list(model.get("resources") or [])
                applied.append("арматура (" + source + ")")
            added += [r["id"] for r in new_steel]
            steel_counts_loops = source == "ведомость расхода стали" or bool((reading.get("rebar") or {}).get("assemblyIncludesLoops"))
        # закладные, трубы, петли: каждый вид добавляется, только если у модели нет ресурсов этого вида (у двух исходных колонн Excel трубы уже есть)
        present = {r["id"] for r in model.get("resources") or []}
        # закладные накладываются, только если не нарушена сверка с итогом ведомости листа (нет итога — принимаются как не подтверждённые)
        verified = embedded_verified(reading)
        extra = [] if verified is False else [r for r in embedded_resources(reading, loops=not steel_counts_loops)
                                              if not any(i.startswith("pipe" if r["id"].startswith("pipe") else r["id"]) for i in present)]
        if extra:
            model.setdefault("resources", []).extend(extra)
            added += [r["id"] for r in extra]
            applied.append("закладные, трубы, петли")
        # лист прочитан, а закладных, труб и петель на нём нет: «ничего не требуется» — это тоже результат, а не пробел
        checked = "embedded" in reading and verified is not False and (bool(extra) or bool(reading["embedded"].get("items")) or bool(reading.get("volume")))     # чтение старого формата (без раздела embedded) ничего не утверждает
        if applied or checked:
            sheet = reading.get("sheet") or {}
            model["readings"] = {"applied": applied, "sheet": sheet, "confirmed": False, "method": reading.get("method"), "addedResources": added, "embeddedChecked": checked, "embeddedVerified": verified,
                                 "embedded": (reading.get("embedded") or {}).get("items") or []}
            if replaced: model["readings"]["replacedResources"] = replaced
            if reading.get("concreteClassSource") and "класс бетона" in applied:
                model["readings"]["concreteClassSource"] = reading["concreteClassSource"]
        issues = model.get("issues") or []
        if checked: issues = [i for i in issues if i != "Не заданы закладные, трубы и прочие материалы"]      # состав прочитан с листа
        if any(x.startswith("арматура") for x in applied): issues = [i for i in issues if i != "Не разобраны ресурсные позиции стали"]
        model["issues"] = issues
        if applied:
            model.setdefault("notes", []).append("Прочитано с листа PDF автоматически и не подтверждено человеком (%s; альбом doc%02d, стр. %s). Сверить с чертежом." % (
                ", ".join(applied), sheet.get("doc", 0), sheet.get("page", "?")))
            if reading.get("concreteClassSource") and "класс бетона" in applied:
                evidence = reading["concreteClassSource"]
                model["notes"].append("Класс бетона %s: %s (%s, PDF-стр. %s)." % (
                    reading["concreteClass"], evidence["label"], evidence["sourceId"], evidence["pdfPage"]))
            changed += 1
    return changed

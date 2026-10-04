"""Слой «прочитано с листа»: объём и класс бетона, арматура изделий, которых нет в каталоге поставщика (assets/promka-readings.json).

Файл собирает scripts/build_calc_readings.py по листам изделий (data/calc/assets/sources/docNN.pdf; метод — scripts/prototypes/vector_ocr/) и
кладёт рядом с каталогом; он передаётся на серверы как остальные файлы каталога. Наложение консервативно: заполняются только пробелы —
нет проектного объёма, класс бетона «не указан», нет ресурсов; значения каталога поставщика не перезаписываются. У наложенных моделей
есть `readings` (что взято, лист, «не подтверждено человеком») и заметка в `notes`. Ручные правки изделия, как и раньше, главнее."""
import json
from pathlib import Path

SOURCE_FILE = "promka-readings.json"


def resource_id(cls, diameter):
    """Код ресурса каталога: steel16A500C, steel3Vr1 (латиница, как в каталоге моделей)."""
    if cls.upper().startswith("ВР"):
        return "steel%dVr1" % diameter
    return "steel%d%s" % (diameter, cls.translate(str.maketrans("АС", "AC")))


def resource_name(cls, diameter):
    return ("Проволока Ø%d Вр1" % diameter) if cls.upper().startswith("ВР") else "Арматура Ø%d %s" % (diameter, cls)


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


def embedded_resources(reading):
    """Закладные, трубы и петли из чтения: [ресурс]. Закладные и петли — по массе, т (цена за тонну); трубы — по типоразмеру, м (цена за метр, код каталога:
    pipe50 = 50×5, pipe68 = 68×1, остальные — pipeДДxТ). Позиция: [вид, название, масса единицы кг, количество шт., типоразмер трубы, длина трубы в позиции, м]:
    типоразмер и метры сборка (build_calc_readings.py) выставляет сама, у закладных и петель они пустые."""
    mass = {"embedded": 0.0, "loop": 0.0}; pipes = {}
    for kind, name, unit_mass, qty, size, meters in ((list(i) + [None, None])[:6] for i in (reading.get("embedded") or {}).get("items") or []):
        if kind in mass:
            mass[kind] += unit_mass * qty
        elif kind == "pipe" and size and meters:
            pipes[size] = pipes.get(size, 0.0) + meters
    out = []
    for kind, (identifier, title) in EMBEDDED_RESOURCES.items():
        if mass[kind] > 0:
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
    if added: copy["resources"] = [r for r in model.get("resources") or [] if r["id"] not in added]
    return copy


def apply_readings(models, directory):
    """Накладывает прочитанное на каталог (изменяет models). Возвращает число изменённых моделей."""
    path = Path(directory) / SOURCE_FILE
    if not path.exists():
        return 0
    data = json.loads(path.read_text())
    changed = 0
    for key, reading in data.items():
        model = models.get(key)
        if not model or "readings" in model:      # нет такой модели или чтение уже наложено
            continue
        applied = []
        if not model.get("projectVolume") and reading.get("volume"):
            model["projectVolume"] = reading["volume"]; applied.append("объём бетона")
        if model.get("concreteClass") in (None, "", "Не указан") and reading.get("concreteClass"):
            model["concreteClass"] = reading["concreteClass"]; applied.append("класс бетона")
        rods, source = rebar_of(reading)
        added = []
        if not model.get("resources") and rods:
            model["resources"] = [{"id": resource_id(c, d), "name": resource_name(c, d), "unit": "т", "projectQty": round(kg / 1000, 5), "qty": round(kg / 1000, 5), "rate": "0"}
                                  for c, d, kg in sorted(rods)]
            added += [r["id"] for r in model["resources"]]
            applied.append("арматура (" + source + ")")
        # закладные, трубы, петли: каждый вид добавляется, только если у модели нет ресурсов этого вида (у двух исходных колонн Excel трубы уже есть)
        present = {r["id"] for r in model.get("resources") or []}
        extra = [r for r in embedded_resources(reading) if not any(i.startswith("pipe" if r["id"].startswith("pipe") else r["id"]) for i in present)]
        if extra:
            model.setdefault("resources", []).extend(extra)
            added += [r["id"] for r in extra]
            applied.append("закладные, трубы, петли")
        # лист прочитан, а закладных, труб и петель на нём нет: «ничего не требуется» — это тоже результат, а не пробел
        checked = "embedded" in reading and (bool(extra) or bool(reading["embedded"].get("items")) or bool(reading.get("volume")))     # чтение старого формата (без раздела embedded) ничего не утверждает
        if applied or checked:
            sheet = reading.get("sheet") or {}
            model["readings"] = {"applied": applied, "sheet": sheet, "confirmed": False, "method": reading.get("method"), "addedResources": added, "embeddedChecked": checked,
                                 "embedded": (reading.get("embedded") or {}).get("items") or []}
        if applied:
            model.setdefault("notes", []).append("Прочитано с листа PDF автоматически и не подтверждено человеком (%s; альбом doc%02d, стр. %s). Сверить с чертежом." % (
                ", ".join(applied), sheet.get("doc", 0), sheet.get("page", "?")))
            changed += 1
    return changed

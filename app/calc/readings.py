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


def without_readings(model):
    """Копия модели в состоянии ДО наложения чтений: объём, класс бетона и ресурсы, которые подставило чтение, возвращены в пробелы.
    Нужна там, где сравнивается сохранённое значение изделия с расчётом по каталогу поставщика (пометка ручных правок): значения, сохранённые до появления
    чтений, ручными правками не являются."""
    info = model.get("readings")
    if not info: return model
    copy = dict(model); applied = " ".join(info.get("applied") or [])
    if "объём" in applied: copy["projectVolume"] = None
    if "класс" in applied: copy["concreteClass"] = "Не указан"
    if "арматура" in applied: copy["resources"] = []
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
        if not model:
            continue
        applied = []
        if not model.get("projectVolume") and reading.get("volume"):
            model["projectVolume"] = reading["volume"]; applied.append("объём бетона")
        if model.get("concreteClass") in (None, "", "Не указан") and reading.get("concreteClass"):
            model["concreteClass"] = reading["concreteClass"]; applied.append("класс бетона")
        rods, source = rebar_of(reading)
        if not model.get("resources") and rods:
            model["resources"] = [{"id": resource_id(c, d), "name": resource_name(c, d), "unit": "т", "projectQty": round(kg / 1000, 5), "qty": round(kg / 1000, 5), "rate": "0"}
                                  for c, d, kg in sorted(rods)]
            applied.append("арматура (" + source + ")")
        if applied:
            sheet = reading.get("sheet") or {}
            model["readings"] = {"applied": applied, "sheet": sheet, "confirmed": False, "method": reading.get("method")}
            model.setdefault("notes", []).append("Прочитано с листа PDF автоматически и не подтверждено человеком (%s; альбом doc%02d, стр. %s). Сверить с чертежом." % (
                ", ".join(applied), sheet.get("doc", 0), sheet.get("page", "?")))
            changed += 1
    return changed

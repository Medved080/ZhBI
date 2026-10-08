"""Сравнение до/после пересборки: уже принятые объём, класс, арматура и прочие ресурсы сохраняются.

Запуск: .venv312/bin/python scripts/verify_calc_readings_regression.py before.json after.json
Проверяет правила приёмки приложения, без базы данных и без изменения каталога.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.calc.readings import embedded_resources, embedded_verified, rebar_of


def accepted(reading):
    rods, _ = rebar_of(reading)
    embedded = reading.get("embedded")
    return {
        "volume": reading.get("volume"),
        "concreteClass": reading.get("concreteClass"),
        "rebar": sorted(rods) if rods else None,
        "embedded": embedded_resources(reading) if embedded is not None and embedded_verified(reading) is not False else None,
    }


def compare(before, after):
    errors = []
    counts = {field: 0 for field in ("volume", "concreteClass", "rebar", "embedded")}
    added = {field: [] for field in counts}
    for key in sorted(set(before) | set(after)):
        old = accepted(before.get(key) or {})
        new = accepted(after.get(key) or {})
        for field in counts:
            if old[field] is not None:
                counts[field] += 1
                if old[field] != new[field]: errors.append((key, field, old[field], new[field]))
            elif new[field] is not None:
                added[field].append(key)
    return errors, counts, added


if __name__ == "__main__":
    before, after = (json.loads(Path(path).read_text()) for path in sys.argv[1:3])
    errors, counts, added = compare(before, after)
    for key, field, old, new in errors:
        print("FAIL", key, field, old, "→", new)
    print("Проверено принятых результатов:", counts)
    print("Новых результатов:", {field: len(keys) for field, keys in added.items()})
    print("Изменений или потерь принятых результатов:", len(errors))
    sys.exit(bool(errors))

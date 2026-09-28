"""Привязка в режиме union на нижней отметке объекта (исправление 2026-09-28).

Ригель и плита «венчают» ярус снизу: их полоса (отметка, верх], и на самой
нижней отметке объекта полосы нет. Такие изделия, как и всё ниже нижней
отметки, прижимаются к нижнему ярусу — так было до явных верхних отметок
(6a5f2c7), и так снова. Если у какой-либо стоянки задана явная верхняя
отметка, прижатия нет (поведение сервера с 6a5f2c7 не меняется).
Запуск: PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:scripts .venv/bin/python scripts/test_stance_union_bottom_level.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from zone_binding import bind_element_to_zones  # noqa: E402
from zone_parser import ZoneRecord  # noqa: E402

SQUARE = [(0, 0), (10000, 0), (10000, 10000), (0, 10000)]


def zones(upper=None):
    return [
        ZoneRecord(handle="K", category="Кран", elevation_mm=None, outline=SQUARE, name="1"),
        ZoneRecord(handle="S0", category="Стоянка", elevation_mm=0, outline=SQUARE, name="1.1",
                   parent_zone_handle="K", parent_match_status="matched", upper_elevation_mm=upper),
        ZoneRecord(handle="S3", category="Стоянка", elevation_mm=3000, outline=SQUARE, name="1.2",
                   parent_zone_handle="K", parent_match_status="matched"),
    ]


def stance(element_type, elevation, records):
    result = bind_element_to_zones(element_type, 5000, 5000, None, elevation, records, stance_mode="union")
    return result["Стоянка"].zone_handle, result["Стоянка"].status


cases = [
    # тип, отметка, ожидаемая стоянка
    ("Ригель", 0, "S0"), ("Плита перекрытия", 0, "S0"), ("Ригель", -500, "S0"),
    ("Ригель", 3000, "S0"), ("Ригель", 4500, "S3"),
    ("Колонна", 0, "S0"), ("Колонна", -500, "S0"), ("Колонна", 3000, "S3"),
]
failures = []
for element_type, elevation, expected in cases:
    got = stance(element_type, elevation, zones())
    if got != (expected, "matched"):
        failures.append(f"{element_type} на {elevation}: ожидалось {expected}, получено {got}")
# Явная верхняя отметка: прижатия ниже нижнего уровня нет, но сама нижняя отметка у колонны — в полосе.
with_upper = zones(upper=3000)
for element_type, elevation, expected in [("Ригель", 0, None), ("Ригель", -500, None), ("Колонна", 0, "S0")]:
    got = stance(element_type, elevation, with_upper)
    if got[0] != expected:
        failures.append(f"явный верх, {element_type} на {elevation}: ожидалось {expected}, получено {got}")
if failures:
    print("FAIL\n" + "\n".join(failures))
    sys.exit(1)
print("stance union bottom level: 11 cases OK")

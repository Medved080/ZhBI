"""Привязка при перекрывающихся по высоте полосах разных стоянок (исправление 2026-09-28).

Явные верхние отметки делают полосы разных стоянок перекрывающимися: ярус
−400…15000 одной стоянки и 0…15000 другой. Пока они стоят в разных местах
плана, это не конфликт. До исправления сервер из всех стоянок в полосе
оставлял только ярус с наибольшей нижней отметкой и лишь потом проверял
контур — изделие в контуре стоянки «−400» терялось (на копии с рабочей базы
234 изделия без крана). Теперь в расчёт идут все стоянки, в полосу которых
попадает отметка; выбирает контур.
Запуск: PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:scripts .venv/bin/python scripts/test_stance_union_overlapping_bands.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from zone_binding import bind_element_to_zones  # noqa: E402
from zone_parser import ZoneRecord  # noqa: E402


def square(x0, size=10000):
    return [(x0, 0), (x0 + size, 0), (x0 + size, size), (x0, size)]


ZONES = [
    ZoneRecord(handle="K1", category="Кран", elevation_mm=None, outline=square(0, 30000), name="1"),
    ZoneRecord(handle="K2", category="Кран", elevation_mm=None, outline=square(0, 30000), name="2"),
    # Стоянка A крана 1: ярус −400…15000 в левой части плана.
    ZoneRecord(handle="A", category="Стоянка", elevation_mm=-400, outline=square(0), name="A",
               parent_zone_handle="K1", parent_match_status="matched", upper_elevation_mm=15000),
    # Стоянка B крана 2: ярус 0…15000 в правой части плана.
    ZoneRecord(handle="B", category="Стоянка", elevation_mm=0, outline=square(20000), name="B",
               parent_zone_handle="K2", parent_match_status="matched", upper_elevation_mm=15000),
    # Верхний ярус над обеими.
    ZoneRecord(handle="A2", category="Стоянка", elevation_mm=15000, outline=square(0), name="A2",
               parent_zone_handle="K1", parent_match_status="matched", upper_elevation_mm=25800),
]


def bind(element_type, x, elevation, outline=None):
    result = bind_element_to_zones(element_type, x, 5000, outline, elevation, ZONES, stance_mode="union")
    return result["Стоянка"].zone_handle, result["Кран"].zone_handle


plate = lambda x0: [(x0 + 1000, 1000), (x0 + 4000, 1000), (x0 + 4000, 4000), (x0 + 1000, 4000)]
cases = [
    (("Плита перекрытия", 5000, 15000, plate(0)), ("A", "K1")),   # венчает ярус A (−400, 15000]
    (("Колонна", 5000, 0), ("A", "K1")),                           # 0 в полосе A, изделие в контуре A
    (("Колонна", 5000, 8050), ("A", "K1")),
    (("Колонна", 25000, 8050), ("B", "K2")),                       # в контуре B
    (("Плита перекрытия", 25000, 15000, plate(20000)), ("B", "K2")),
    (("Колонна", 5000, 15000), ("A2", "K1")),                     # следующий ярус
    (("Колонна", 15000, 8050), (None, None)),                      # между стоянками — не размечено
]
failures = []
for args, expected in cases:
    got = bind(*args)
    if got != expected:
        failures.append(f"{args[0]} x={args[1]} на {args[2]}: ожидалось {expected}, получено {got}")
if failures:
    print("FAIL\n" + "\n".join(failures))
    sys.exit(1)
print(f"stance union overlapping bands: {len(cases)} cases OK")

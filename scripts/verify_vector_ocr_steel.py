"""Проверка правок сборки арматуры по листам (scripts/prototypes/vector_ocr/steel.py): буквы-цифры в длине и диаметре, количество, склеенное с длиной,
масса стержня серии без столбца массы, нечёткие марки «с/О/нуль», цифра «г» в массе. Синтетические строки, без чертежей.
Запуск: .venv312/bin/python scripts/verify_vector_ocr_steel.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototypes" / "vector_ocr"))
import steel  # noqa: E402

failed = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond: failed.append(label)


# --- буквы-цифры
check(steel.fix_digits("Ø 20 А500с ГОСТ 34028-2016, L=4А70").endswith("L=4570"), "«А» в длине — пятёрка")
check(steel.fix_digits("И 20 А500С ГОСТ 34028-2016, L=101У0").endswith("L=10160"), "«У» в длине — шестёрка")
check(steel.parse_rod(steel.fix_digits("И 2А А500с ГОСТ 34028-2016, L=4А70")) == ("А500С", 25), "«2А» в диаметре — Ø25")
check("А500С" in steel.fix_digits("Ø 8 А500С ГОСТ 34028-2016, L=1А40"), "класс «А500С» не трогается")
check(steel.num("г8,9О") == 28.9 and steel.num("О,г6") == 0.26, "«г» в массе — двойка")
# --- количество, склеенное с длиной; масса по геометрии
qty, mass = steel.row_qty_mass({"mark": "КР-1", "name": "Ø10 А500С ГОСТ 34028-2016, L=2810 2", "mass": "1,73"})
check(qty == 2 and mass == 1.73, "количество «2» отделено от «L=2810»")
qty, mass = steel.row_qty_mass({"name": "Ø 28 А500С ГОСТ 34028-2016, L=1 1375", "qty": "8", "mass": "54,98"})
check(qty == 8 and mass == 54.98, "длина «1 1375» с пробелом не принимается за количество")
qty, mass = steel.row_qty_mass({"mark": "401", "name": "Ø 12 А500С ГОСТ 34028-2016, L=2130", "qty": "10", "mass_item": "23,93"})
check(qty == 10 and abs(mass - 0.00617 * 12 * 12 * 2.13) < 1e-6, "масса стержня серии по геометрии: 0,00617·12²·2,13")
check(steel.row_qty_mass({"name": "Ø 12 А500С ГОСТ 34028-2016, L=2130", "qty": "10"})[1] is None, "вне таблицы серии массу по геометрии не выдумываем")
# --- нечёткие марки и сборка
check(steel.fuzzy_key("4с1") == steel.fuzzy_key("401") == steel.fuzzy_key("4С1"), "марки «4с1» и «401» совпадают")
check(steel.fuzzy_key("СН6.6-1") != steel.fuzzy_key("КН6.6-1"), "разные марки не склеиваются")

series = [  # лист серии: марка прочитана как «401», масса единицы не прочитана
    {"mark": "401", "pos": "1", "name": "Ø 12 А500С ГОСТ 34028-2016, L=2130", "qty": "10", "mass_item": "23,93"},
    {"mark": "401", "pos": "2", "name": "Ø 8 А500С ГОСТ 34028-2016, L=1590", "qty": "8", "mass_item": "23,93"},
]
parent = [{"pos": "1", "oboz": "ШИФР, л.1", "name": "Сетка 4с1", "qty": "2", "mass": "23,93"}]
pages = {(8, 10): parent, (8, 13): series}
asm = steel.RebarAssembler(lambda d, p: pages.get((d, p)), {8: 12}, pages=lambda d: [p for (dd, p) in pages if dd == d])
tree = asm.assemble(8, 10, None, None)
kg = sum(tree["rods"].values())
check(abs(kg - 2 * 23.93) < 0.5 and tree["unresolved"] == 0, "узел «Сетка 4с1» найден на листе серии под маркой «401» (%.1f кг)" % kg)
check(set(tree["rods"]) == {("А500С", 12), ("А500С", 8)}, "арматура по классам и диаметрам")

# одна строка без массы и с нечитаемой длиной: масса — остаток итога марки
series2 = [
    {"mark": "К1", "pos": "1", "name": "Ø 20 А500С ГОСТ 34028-2016, L=3000", "qty": "2", "mass_item": "30,0"},
    {"mark": "К1", "pos": "2", "name": "Ø 10 А500С ГОСТ 34028-2016, L= ··У0", "qty": "10", "mass_item": "30,0"},
]
rest = steel.RebarAssembler(lambda d, p: series2, {}).assemble(1, 1, "К1", 30.0)
check(abs(sum(rest["rods"].values()) - 30.0) < 0.01, "единственная строка без массы добирается остатком итога марки")

print("\nпровалено: %d" % len(failed))
sys.exit(1 if failed else 0)

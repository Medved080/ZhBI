"""Проверка правок сборки арматуры по листам (scripts/prototypes/vector_ocr/steel.py): буквы-цифры в длине и диаметре, количество, склеенное с длиной,
масса стержня серии без столбца массы, нечёткие марки «с/О/нуль», цифра «г» в массе. Синтетические строки, без чертежей.
Запуск: .venv312/bin/python scripts/verify_vector_ocr_steel.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototypes" / "vector_ocr"))
import steel  # noqa: E402
import tables  # noqa: E402

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

# --- короткие числовые ячейки и ссылки, полностью прочитанные буквами
original_digit = tables.cell_digit
tables.cell_digit = lambda gl, cell, thr=None: ({"five": "5", "zero": "0", "eight": "8"}[cell], 3.0)
ref = tables.resolve(tables.numeric_fix([], [("л", None, "unused"), (".", None, "unused"), ("в", None, "five"), ("й", None, "zero")]))
qty = tables.resolve(tables.numeric_fix([], [("е", None, "eight")], force=True, thr=tables.DIGIT_THR))
tables.cell_digit = original_digit
check(ref == "л.50" and steel.ref_numbers(ref) == [50], "«л.вй» перечитана классификатором цифр как «л.50»")
check(qty == "8", "одиночная «е» в числовой ячейке перечитана как 8")
tables.cell_digit = lambda gl, cell, thr=None: (cell, 3.0)
tokens = [[(ch, None, dg) for ch, dg in zip("И··", "025")],
          [(ch, None, ch) for ch in "А500С"], [(ch, None, dg) for ch, dg in zip("L=·У·0", "003730")]]
rod = " ".join(tables.resolve(t) for t in tables.rod_numeric_fix([], tokens))
tables.cell_digit = original_digit
check(rod == "Ø25 А500С L=3730", "диаметр и длина стержня перечитываются цифрами; класс остаётся текстом")

# --- одиночный лист узла: имя в штампе и безымянная строка итога
console = [{"pos": "1", "name": "Ø25 А500С ГОСТ 34028-2016 L=3360", "qty": "4", "mass": "12,95"},
           {"pos": "2", "name": "Ø10 А240 ГОСТ 34028-2016 L=3060", "qty": "29", "mass": "1,89"}, {"mass": "106,61"}]
parts = {(3, 119): [{"name": "консолей 6.6-1", "oboz": "л.49", "qty": "1", "mass": "106,61"}], (3, 72): console}
asm = steel.RebarAssembler(lambda d, p: parts.get((d, p)), {3: 10}, pages=lambda d: [72, 119],
                           marks=lambda d, p: ["К6.6-1"] if p == 72 else [])
check(asm.sheet_masses(3, 72) == {106.61}, "безымянная строка массы участвует в поиске узла")
check(asm.assemble(3, 119)["unresolved"] == 0, "консоль найдена вне окна по марке штампа и массе")
check(asm.find_by_mark(3, "К6.6-2", 106.61) is None and asm.find_by_mark(3, "К6.6-1", 179.01) is None,
      "чужая марка или масса не принимается при поиске по штампу")

# --- соседний лист изделия не должен повторно добавлять его трубы к узлу арматуры
parts = {(4, 113): [{"name": "Каркас КП1", "oboz": "л.41", "qty": "1", "mass": "10,00"},
                   {"name": "Труба 50х5 L=600", "qty": "2", "mass": "3,33"}],
         (4, 57): [{"name": "Каркас КП1", "oboz": "л.42", "qty": "1", "mass": "10,00"},
                   {"name": "Труба 50х5 L=600", "qty": "2", "mass": "3,33"}, {"name": "Бетон кл. В40", "qty": "3,40", "mass": "м3"}],
         (4, 58): [{"name": "Ø10 А500С ГОСТ 34028-2016 L=1620", "qty": "10", "mass": "1,00"}, {"name": "Масса", "qty": "10,00"}]}
asm = steel.RebarAssembler(lambda d, p: parts.get((d, p)), {4: 16})
tree = asm.assemble(4, 113)
check(tree["unresolved"] == 0 and list(tree["emb"].values()) == [2], "ошибочная ссылка на лист бетонного изделия не удваивает трубы")

# --- округление массы малой детали с 0,077 до 0,08; общий допуск 3% не меняется
rows = [{"mark": "СК1", "name": "Ø6 А240 ГОСТ 34028-2016 L=345", "qty": "1", "mass": "0.077", "mass_item": "0.08"}]
asm = steel.RebarAssembler(lambda d, p: rows, {})
tree = asm.assemble(15, 75, "СК1", 0.08)
check(tree["rods"] == {("А240", 6): 0.077} and asm.node_mass(tree, 0.08) == 0.08, "скоба: класс и диаметр сохранены, сверка учитывает округление итога до сотых")
rows[0]["mass"] = "0.070"
tree = steel.RebarAssembler(lambda d, p: rows, {}).assemble(15, 75, "СК1", 0.08)
check(steel.RebarAssembler.node_mass(tree, 0.08) == 0.07, "расхождение вне половины шага округления не скрывается")

print("\nпровалено: %d" % len(failed))
sys.exit(1 if failed else 0)

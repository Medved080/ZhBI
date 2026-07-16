"""
Генератор тестового DXF-файла для проверки скрипта parse_zhbi.py.

Слои и масштаб (миллиметры) специально подобраны так же, как в реальном
файле заказчика "Чертежи для WEB.dxf": колонны на слое "Колонны" как
блоки-вставки БЕЗ атрибутов, марки — через MULTILEADER на слое
"колонны мои" с расстоянием стрелка->колонна ~50мм. Плюс несколько
дополнительных кейсов, которых в реальном файле пока не встретилось,
но которые скрипт должен уметь обрабатывать:
  1. колонна с маркой прямо в атрибуте блока                -> source="attribute"
  2. колонна с пустым атрибутом + MULTILEADER                -> source="leader"
  3. колонна с пустым атрибутом + старый LEADER с MTEXT       -> source="leader"
  4. колонна без атрибута и без выноски рядом                 -> source="unresolved"

Плюс "отвлекающая" выноска далеко от всех колонн — проверяет, что скрипт
не подхватывает чужую выноску по ошибке (важно на реальном чертеже, где
колонн тысячи и они стоят частой сеткой).

Запуск:
    python scripts/generate_test_dxf.py
Результат:
    test_data/sample.dxf
"""

import ezdxf
from ezdxf.math import Vec2
from ezdxf.render.mleader import ConnectionSide

OUTPUT_PATH = "test_data/sample.dxf"

COLUMN_LAYER = "Колонны"
ANNOTATION_LAYER = "колонны мои"

# шаг сетки колонн и типичное смещение стрелки выноски — как в реальном файле (мм)
COLUMN_STEP = 6000.0
LEADER_OFFSET = 50.0


def make_block(doc, name: str, with_attdef: bool) -> None:
    if name in doc.blocks:
        return
    blk = doc.blocks.new(name=name)
    blk.add_lwpolyline([(-300, -300), (300, -300), (300, 300), (-300, 300)], close=True)
    if with_attdef:
        blk.add_attdef("MARK", (0, 450), dxfattribs={"height": 200})


def add_column(msp, doc, insert, mark: str, with_attdef: bool):
    block_name = "COLUMN_ATTR" if with_attdef else "COLUMN_PLAIN"
    make_block(doc, block_name, with_attdef)
    ins = msp.add_blockref(block_name, insert=insert, dxfattribs={"layer": COLUMN_LAYER})
    if with_attdef:
        ins.add_auto_attribs({"MARK": mark})
    return ins


def main():
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4  # миллиметры, как в реальном файле
    msp = doc.modelspace()

    # --- 1. Колонна с маркой прямо в атрибуте ---
    add_column(msp, doc, insert=(0, 0), mark="1КН1.1", with_attdef=True)

    # --- 2. Колонна без атрибута + MULTILEADER (основной сценарий реального файла) ---
    add_column(msp, doc, insert=(COLUMN_STEP, 0), mark="", with_attdef=False)
    ml_builder = msp.add_multileader_mtext(dxfattribs={"layer": ANNOTATION_LAYER})
    ml_builder.set_content("9КН3.2", style="Standard")
    ml_builder.add_leader_line(
        ConnectionSide.right, [Vec2(COLUMN_STEP + LEADER_OFFSET, LEADER_OFFSET)]
    )
    ml_builder.build(insert=Vec2(COLUMN_STEP + 1200, 1200))

    # --- 3. Колонна без атрибута + старый LEADER, текст на конце выноски ---
    add_column(msp, doc, insert=(2 * COLUMN_STEP, 0), mark="", with_attdef=False)
    msp.add_leader(
        vertices=[
            (2 * COLUMN_STEP + LEADER_OFFSET, LEADER_OFFSET),
            (2 * COLUMN_STEP + 1000, 1500),
            (2 * COLUMN_STEP + 1800, 1500),
        ],
        dxfattribs={"layer": ANNOTATION_LAYER},
    )
    msp.add_text(
        "5Р-2",
        dxfattribs={
            "layer": ANNOTATION_LAYER,
            "height": 200,
            "insert": (2 * COLUMN_STEP + 1900, 1450),
        },
    ).set_placement((2 * COLUMN_STEP + 1900, 1450))

    # --- 4. Колонна без атрибута и БЕЗ выноски рядом (unresolved) ---
    add_column(msp, doc, insert=(3 * COLUMN_STEP, 0), mark="", with_attdef=False)

    # --- Отвлекающая выноска далеко от всех колонн ---
    ml_decoy = msp.add_multileader_mtext(dxfattribs={"layer": ANNOTATION_LAYER})
    ml_decoy.set_content("ПОСТОРОННЯЯ-МАРКА", style="Standard")
    ml_decoy.add_leader_line(ConnectionSide.right, [Vec2(500_000, 500_000)])
    ml_decoy.build(insert=Vec2(505_000, 505_000))

    # --- Сущность на нецелевом слое — должна игнорироваться парсером ---
    make_block(doc, "COLUMN_ATTR", True)
    ins = msp.add_blockref(
        "COLUMN_ATTR", insert=(4 * COLUMN_STEP, 0), dxfattribs={"layer": "СЛУЖЕБНЫЙ_СЛОЙ"}
    )
    ins.add_auto_attribs({"MARK": "ИГНОРИРУЕТСЯ"})

    doc.saveas(OUTPUT_PATH)
    print(f"Тестовый DXF сохранён: {OUTPUT_PATH}")
    print("Элементы:")
    print("  (0,0)      Колонны  MARK='1КН1.1' (атрибут заполнен)")
    print("  (6000,0)   Колонны  MARK='' + MULTILEADER -> текст '9КН3.2'")
    print("  (12000,0)  Колонны  MARK='' + старый LEADER -> текст '5Р-2'")
    print("  (18000,0)  Колонны  MARK='' без выноски -> unresolved")
    print("  (24000,0)  СЛУЖЕБНЫЙ_СЛОЙ (не в LAYER_CONFIG, должен быть проигнорирован)")


if __name__ == "__main__":
    main()

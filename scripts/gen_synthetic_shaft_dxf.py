"""Синтетический DXF для профиля «Панели облицовки шахты» (moskvich-gp1-gp2-v1).

Зачем. Реальный чертёж (`Input/260908_ПП 5-7_Е-Ж.dxf`) недоступен в этой
сессии (запрещено читать `Input/`), а разбор (`app/shaft_panels/parser.py`)
— СТРОГИЙ профиль конкретного семейства чертежей: две развёртки ГП1/ГП2,
восемь сторон, план шахт, атрибуты осей, отметки. Файл собирает минимальную
геометрию, которая проходит все проверки профиля, но остаётся маленьким —
для быстрой живой браузерной проверки.

Геометрия сознательно синтетическая, не повторяет реальные размеры изделий
(кроме магических констант самого профиля — 9000/12000/5700/4050/300/4495 мм
и обязательных отметок 0/+15,000/+25,800/+31,300, без которых разбор в
принципе не пройдёт).

Запуск:
    .venv/bin/python scripts/gen_synthetic_shaft_dxf.py <выход.dxf> \
        [--variant ok|no_axes|missing_mark|overlap|bad_level]
"""
import argparse
from pathlib import Path

import ezdxf

LAYER_PANELS = 'Плиты-опалубки'
LAYER_LEVELS = 'Размермой'

# Координаты сторон развёртки на листе (ось X — вдоль стороны, ось Y — высота/Z).
# Ширины 5700/4050 чередуются, как того требует parser._axes/_rectangle через
# spans; порядок по возрастанию X — как profile сопоставляет буквы АБВГДЕЖИ.
FACES = [
    {'label': 'А', 'shaft': 'ГП1', 'x0': 0, 'width': 5700},
    {'label': 'Б', 'shaft': 'ГП1', 'x0': 5700, 'width': 4050},
    {'label': 'В', 'shaft': 'ГП1', 'x0': 9750, 'width': 5700},
    {'label': 'Г', 'shaft': 'ГП1', 'x0': 15450, 'width': 4050},
    {'label': 'Д', 'shaft': 'ГП2', 'x0': 20500, 'width': 5700},
    {'label': 'Е', 'shaft': 'ГП2', 'x0': 26200, 'width': 4050},
    {'label': 'Ж', 'shaft': 'ГП2', 'x0': 30250, 'width': 5700},
    {'label': 'И', 'shaft': 'ГП2', 'x0': 35950, 'width': 4050},
]
FACE_BY_LABEL = {f['label']: f for f in FACES}

# Ноль высот на листе: Z=0 соответствует Y=ZERO_SHEET_Y (как в _levels).
ZERO_SHEET_Y = 10000.0
Z_LOW0, Z_LOW1 = 0.0, 15000.0      # нижний ярус панелей каждой стороны
Z_HIGH0, Z_HIGH1 = 15000.0, 31300.0  # верхний ярус

# Обязательные отметки профиля (метка -> Z, мм). Ровно эти четыре должны
# подтвердиться выносками на слое LAYER_LEVELS слева от развёртки.
REQUIRED_LEVELS = [
    ('0,000', 0.0),
    ('+15,000', 15000.0),
    ('+25,800', 25800.0),
    ('+31,300', 31300.0),
]

# Заголовки разверток. split_y — максимум Y заголовков; план шахт должен
# полностью лежать выше него, все панели — полностью ниже.
SPLIT_Y = 43000.0
HEADING_Y = 41800.0  # между верхом самой высокой панели (41300) и SPLIT_Y

# Обычные (внутренние) марки нижнего/верхнего яруса по стороне. Стороны В/Д
# специально используют ОДИНАКОВЫЕ марки и Z — это одна физическая панель
# общей стенки, описанная дважды (см. parser._merge_shared_wall).
FACE_MARKS = {
    'А': ('ПП1', 'СПЕЦ'),       # верхний ярус стороны А — особый (см. ниже)
    'Б': ('ПП2', 'ПП2.1'),
    'В': ('ПП3', 'ПП3.1а'),
    'Г': ('ПП4', 'ПП4.1'),
    'Д': ('ПП3', 'ПП3.1а'),     # пара со стороной В
    'Е': ('ПП5', 'ПП5.1'),
    'Ж': ('ПП6', 'ПП6.1'),
    'И': ('ПП7', 'ПП7.1'),
}


def _rect(msp, x0, y0, x1, y1, layer=LAYER_PANELS):
    """Замкнутый осевой прямоугольник из 4 вершин — как того требует
    parser._rectangle (без дуг, без наклона, elevation=0, extrusion=+Z)."""
    pl = msp.add_lwpolyline(
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
        dxfattribs={'layer': layer},
    )
    pl.close(True)
    return pl


def _text(msp, s, x, y, layer='0', height=250.0):
    return msp.add_text(s, dxfattribs={'layer': layer, 'height': height, 'insert': (x, y, 0)})


def _axis_insert(msp, block_name, tag_value, x, y):
    ins = msp.add_blockref(block_name, insert=(x, y, 0))
    ins.add_attrib('А1', tag_value, insert=(x, y, 0))
    return ins


def _leader(msp, x_tip, y_level, x_shelf, layer=LAYER_LEVELS):
    """Выноска отметки — 3 точки: вертикальное плечо (a->b) + горизонтальная
    полка (b->c), как ищет parser._levels. Вертикальное плечо нулевой длины
    (a==b) — код проверяет только совпадение X, не длину отрезка."""
    pl = msp.add_lwpolyline([(x_tip, y_level), (x_tip, y_level), (x_shelf, y_level)],
                             dxfattribs={'layer': layer})
    return pl


def build(variant: str) -> ezdxf.document.Drawing:
    doc = ezdxf.new('R2010')
    doc.header['$INSUNITS'] = 1  # как в реальном файле: заголовок «дюймы», геометрия фактически в мм
    msp = doc.modelspace()

    # --- заголовки разверток -------------------------------------------------
    _text(msp, 'Развертка шахты подъемника ГП1', FACE_BY_LABEL['Б']['x0'], SPLIT_Y)
    _text(msp, 'Развертка шахты подъемника ГП2', FACE_BY_LABEL['Ж']['x0'], SPLIT_Y)

    # --- восемь сторон: буквы-заголовки + панели -----------------------------
    dropped_mark = variant == 'missing_mark'
    dropped_done = False
    for face in FACES:
        label, x0, width = face['label'], face['x0'], face['width']
        x1 = x0 + width
        # буква стороны — строго между низом заголовка и верхом самой высокой панели
        _text(msp, label, (x0 + x1) / 2, HEADING_Y)

        low_mark, high_mark = FACE_MARKS[label]
        y_low0, y_low1 = ZERO_SHEET_Y + Z_LOW0, ZERO_SHEET_Y + Z_LOW1
        y_high0, y_high1 = ZERO_SHEET_Y + Z_HIGH0, ZERO_SHEET_Y + Z_HIGH1

        # нижний ярус — на всю ширину стороны, марка внутри контура
        _rect(msp, x0, y_low0, x1, y_low1)
        if dropped_mark and label == 'Б' and not dropped_done:
            dropped_done = True  # контур без марки — намеренный дефект варианта missing_mark
        else:
            _text(msp, low_mark, (x0 + x1) / 2, (y_low0 + y_low1) / 2)

        if label == 'А':
            # верхний ярус стороны А — узкая (150 мм) панель с ВНЕШНЕЙ маркой:
            # марка не помещается внутри контура, текст рядом (profile.mark_method=external_unique)
            narrow_x1 = x0 + 150
            _rect(msp, x0, y_high0, narrow_x1, y_high1)
            _text(msp, 'ПП1н', narrow_x1 + 150, (y_high0 + y_high1) / 2)
            if variant == 'overlap':
                # два перекрывающихся контура в пустующей части стороны А —
                # каждый со своей однозначной маркой, чтобы отказ сработал
                # именно на проверке перекрытия, а не на многозначности марки
                _rect(msp, x0 + 1000, y_high0, x0 + 1700, y_high0 + 5000)
                _text(msp, 'ПП1.2', x0 + 1100, y_high0 + 2500)
                _rect(msp, x0 + 1500, y_high0, x0 + 2200, y_high0 + 5000)
                _text(msp, 'ПП1.3', x0 + 2100, y_high0 + 2500)
        else:
            # верхний ярус остальных сторон — на всю ширину, марка внутри
            _rect(msp, x0, y_high0, x1, y_high1)
            _text(msp, high_mark, (x0 + x1) / 2, (y_high0 + y_high1) / 2)

    # --- оси 5, 7, Е, Ж --------------------------------------------------------
    if variant != 'no_axes':
        blk = doc.blocks.new(name='ОСЬ')
        _axis_insert(msp, 'ОСЬ', '5', 1000.0, -8000.0)
        _axis_insert(msp, 'ОСЬ', '7', 10000.0, -8000.0)   # 10000-1000=9000
        _axis_insert(msp, 'ОСЬ', 'Е', -8000.0, 2000.0)
        _axis_insert(msp, 'ОСЬ', 'Ж', -8000.0, 14000.0)   # 14000-2000=12000

    # --- отметки: выноска + текст, слева от самой левой стороны (view_left=0) --
    for label, z in REQUIRED_LEVELS:
        sheet_y = ZERO_SHEET_Y + z
        if variant == 'bad_level' and label == '+25,800':
            sheet_y += 50.0  # выноска сдвинута на 50 мм — невязка масштаба
        _leader(msp, -800.0, sheet_y, -500.0)
        _text(msp, label, -900.0, ZERO_SHEET_Y + z, layer=LAYER_LEVELS)

    # --- план шахт: 3 продольные стенки 300×5680 + 4 поперечные 4495×300 -------
    # (полностью выше SPLIT_Y — отдельная область листа)
    for x0 in (0.0, 4350.0, 8700.0):
        _rect(msp, x0, 50010.0, x0 + 300.0, 55690.0)
    for x0 in (0.0, 4650.0):
        _rect(msp, x0, 49700.0, x0 + 4495.0, 50000.0)
        _rect(msp, x0, 55700.0, x0 + 4495.0, 56000.0)

    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('output', type=Path, help='путь к выходному .dxf')
    ap.add_argument('--variant', default='ok',
                     choices=['ok', 'no_axes', 'missing_mark', 'overlap', 'bad_level'])
    args = ap.parse_args()
    doc = build(args.variant)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(args.output)
    print(f'{args.output}: вариант={args.variant}, размер={args.output.stat().st_size} байт')


if __name__ == '__main__':
    main()

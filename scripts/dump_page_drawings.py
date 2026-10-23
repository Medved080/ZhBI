"""
Выгрузка векторной геометрии листа PDF для разбора потерянных окон.

Зачем. Окна ищутся на плане по слою фасадной заливки (`pdf_rooms.
_exterior_infill_segments`), и часть настоящих окон теряется (лоджии, окна
уникального размера, ложные срабатывания на колоннах). Чтобы чинить это на
данных, а не наугад, нужны сырые фигуры листа в тех же миллиметрах, что и
модель. Исходные PDF заказчика ассистенту недоступны (`.claude/settings.json`),
поэтому выгрузку запускает человек — в файл уходят ТОЛЬКО числа: слой, тип,
цвет, габарит в мм, число отрезков, первые точки контура. Текст листа
(подписи, штамп, реквизиты) не выгружается вовсе.

Запуск (из корня проекта):

    .venv312/bin/python scripts/dump_page_drawings.py <файл.pdf> <листы через запятую> <каталог вывода>

Например, типовой этаж башни (лист 10), первый этаж (5) и этаж 2 (6):

    .venv312/bin/python scripts/dump_page_drawings.py uploads/<файл>.pdf 5,6,10 /private/tmp/claude-501/-Users-max-zhbi-tool/66e60840-f66d-4ece-857b-b44f35bbd452/scratchpad/dump

На каждый лист получается `page_<N>.json.gz`. Фигуры вне охвата сетки осей листа
(легенда, рамка, чужие виды) отбрасываются — как и в самом разборе.
"""

import gzip
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fitz  # PyMuPDF

from app import pdf_rooms as R


def _round(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 3)
    return [round(float(c), 3) for c in v]


def dump_page(doc, page_number: int, canonical_grid: dict) -> dict:
    page = doc[page_number - 1]
    correction = R._page_shift_correction(page, canonical_grid)
    scale = R._page_scale(page)
    _polys, (shift_x, shift_y) = R._room_polygons(page, scale, correction)
    envelope = R._axis_envelope(page, correction)
    H = page.rect.height
    k = R.PT_TO_MM * scale

    def mm(x, y):
        return [round(x * k - shift_x, 1), round((H - y) * k - shift_y, 1)]

    margin = 3000
    drawings = []
    for d in page.get_cdrawings():
        r = d["rect"]
        x0, y0 = mm(r[0], r[3])   # низ-лево в мм (Y вверх)
        x1, y1 = mm(r[2], r[1])
        if envelope is not None:
            ex0, ex1, ey0, ey1 = envelope   # порядок как в `pdf_rooms._axis_envelope`
            if x1 < ex0 - margin or x0 > ex1 + margin or y1 < ey0 - margin or y0 > ey1 + margin:
                continue
        pts = [it[1] for it in d["items"] if it[0] == "l"][:16]
        drawings.append({
            "layer": d.get("layer"),
            "type": d["type"],
            "fill": _round(d.get("fill")),
            "color": _round(d.get("color")),
            "width": _round(d.get("width")),
            "box_mm": [x0, y0, x1, y1],
            "items": len(d["items"]),
            "kinds": "".join(sorted({it[0] for it in d["items"]})),
            "pts_mm": [mm(p.x, p.y) for p in pts],
        })
    return {
        "page": page_number,
        "scale": scale,
        "shift": [shift_x, shift_y],
        "envelope_mm": list(envelope) if envelope is not None else None,
        "drawings": drawings,
    }


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 1
    pdf_path, pages_arg, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    grid = R.extract_axis_grid(doc)
    for n in [int(p) for p in pages_arg.split(",") if p.strip()]:
        data = dump_page(doc, n, grid)
        path = out_dir / f"page_{n}.json.gz"
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        by_layer = Counter(d["layer"] for d in data["drawings"])
        print(f"лист {n}: фигур {len(data['drawings'])}, слоёв {len(by_layer)} → {path}")
        for layer, cnt in by_layer.most_common(12):
            print(f"    {cnt:6d}  {layer}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
Собирает одноразовый статический HTML-просмотрщик плана (SVG) поверх
результата пайплайна parse_zhbi.py + assign_axes.py — чтобы визуально
проверить корректность марок и адресации на реальном чертеже без
бэкенда/БД: чистый файл, открывается двойным кликом в браузере.

Сетку осей берёт из того же источника, что assign_axes.py (тот же DXF,
та же функция build_axis_grid) — чтобы линии осей на схеме гарантированно
совпадали с тем, по чему считался адрес в CSV.

Запуск:
    python scripts/render_plan.py "test_data/Чертежи для WEB-1.dxf" \\
        --csv output/elements_with_address.csv --out output/plan.html

Результат:
    output/plan.html — открыть в любом браузере (file://), сервер не нужен.
"""

import argparse
import csv
import json
import sys

import ezdxf

from assign_axes import build_axis_grid, AXIS_LAYER

# ---------------------------------------------------------------------------
# КОНФИГУРАЦИЯ
# ---------------------------------------------------------------------------

# Статусы адресации, которые считаем "в проекте" (чёрно-белый контур).
# Всё остальное (outside_axis_grid, no_axis_grid) — диагностический цвет.
IN_PROJECT_STATUSES = {"on_axis", "offset"}

DIAGNOSTIC_COLOR = "#d64545"  # временная раскраска для "нет данных по осям"
IN_PROJECT_STROKE = "#1a1a1a"
IN_PROJECT_FILL = "#ffffff"

# Фигура по типу элемента — сейчас в данных встречаются только колонны
# (точечные элементы), поэтому кружок. Когда появятся ригели/плиты, для
# новых типов можно добавить сюда свою фигуру.
TYPE_SHAPE = {
    "Колонна": "circle",
}
DEFAULT_SHAPE = "circle"


def read_elements(csv_path):
    rows = []
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            row["x"] = float(row["x"])
            row["y"] = float(row["y"])
            for key in ("offset_x_mm", "offset_y_mm"):
                try:
                    row[key] = float(row[key]) if row[key] not in (None, "") else None
                except ValueError:
                    row[key] = None
            rows.append(row)
    return rows


def estimate_marker_radius(points, bbox_diag, fraction=0.25):
    """
    Радиус маркера считаем от локальной плотности точек (медианное
    расстояние до ближайшего соседа), а НЕ от размера всего чертежа —
    в этих данных отдельные листы разнесены на сотни метров, и радиус,
    подобранный под общий bbox, микроскопичен там, где чертёж пустой, и
    наоборот слишком велик (кружки накладываются) в плотных кластерах
    колонн. Медиана по ближайшим соседям устойчива к этим редким разрывам.
    """
    n = len(points)
    if n < 2:
        return bbox_diag * 0.01

    nearest = []
    # n здесь ~1000-2000, O(n^2) перебор укладывается в доли секунды
    for i, (xi, yi) in enumerate(points):
        best = None
        for j, (xj, yj) in enumerate(points):
            if i == j:
                continue
            d2 = (xi - xj) ** 2 + (yi - yj) ** 2
            if best is None or d2 < best:
                best = d2
        if best is not None and best > 0:
            nearest.append(best ** 0.5)

    if not nearest:
        return bbox_diag * 0.01

    nearest.sort()
    median = nearest[len(nearest) // 2]
    return median * fraction


def compute_bbox(points, padding_ratio=0.05):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    width = max_x - min_x or 1.0
    height = max_y - min_y or 1.0
    pad_x = width * padding_ratio
    pad_y = height * padding_ratio
    return (min_x - pad_x, min_y - pad_y, max_x + pad_x, max_y + pad_y)


def axis_visual_bbox(grid):
    """
    Полный визуальный охват сетки осей С УЧЁТОМ подписей за её пределами
    (те же margin/label_offset, что использует build_axis_svg) — нужен,
    чтобы viewBox не обрезал подписи букв/номеров по краю.
    """
    if not grid.numeric_axes or not grid.letter_axes:
        return None
    num_vals = list(grid.numeric_axes.values())
    let_vals = list(grid.letter_axes.values())
    x_min, x_max = min(num_vals), max(num_vals)
    y_min, y_max = min(let_vals), max(let_vals)
    margin = max(x_max - x_min, y_max - y_min) * 0.03
    label_offset = margin * 1.8
    extra = margin + label_offset
    return (x_min - extra, x_max + extra, y_min - extra, y_max + extra)


def build_axis_svg(grid, marker_radius):
    """Линии и подписи осей, светло-серые, в пределах bbox самой сетки осей."""
    if not grid.numeric_axes or not grid.letter_axes:
        return ""

    num_vals = list(grid.numeric_axes.values())
    let_vals = list(grid.letter_axes.values())
    x_min, x_max = min(num_vals), max(num_vals)
    y_min, y_max = min(let_vals), max(let_vals)
    margin = max(x_max - x_min, y_max - y_min) * 0.03
    label_offset = margin * 1.8

    parts = ['<g class="axis-grid" stroke="#c4c4c4" fill="#9a9a9a">']

    for label, x in sorted(grid.numeric_axes.items(), key=lambda kv: kv[1]):
        y0, y1 = y_min - margin, y_max + margin
        parts.append(
            f'<line x1="{x}" y1="{y0}" x2="{x}" y2="{y1}" '
            f'vector-effect="non-scaling-stroke" stroke-width="1"/>'
        )
        for ly in (y0 - label_offset, y1 + label_offset):
            parts.append(_flipped_text(x, ly, label, marker_radius * 2.2, anchor="middle"))

    for label, y in sorted(grid.letter_axes.items(), key=lambda kv: kv[1]):
        x0, x1 = x_min - margin, x_max + margin
        parts.append(
            f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" '
            f'vector-effect="non-scaling-stroke" stroke-width="1"/>'
        )
        parts.append(_flipped_text(x0 - label_offset, y, label, marker_radius * 2.2, anchor="middle"))

    parts.append("</g>")
    return "\n".join(parts)


def _flipped_text(x, y, text, font_size, anchor="start", extra_attrs=""):
    """
    Текст внутри группы с transform="scale(1,-1)" рисуется вверх ногами —
    компенсируем локальным обратным флипом вокруг собственной точки (x, y).
    """
    safe = (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    return (
        f'<text transform="translate({x},{y}) scale(1,-1)" x="0" y="0" '
        f'text-anchor="{anchor}" font-size="{font_size:.1f}" {extra_attrs}>{safe}</text>'
    )


def build_elements_svg(rows, marker_radius):
    parts = ['<g class="elements">']
    for row in rows:
        status = row["status"]
        in_project = status in IN_PROJECT_STATUSES
        stroke = IN_PROJECT_STROKE if in_project else DIAGNOSTIC_COLOR
        fill = IN_PROJECT_FILL if in_project else DIAGNOSTIC_COLOR
        fill_opacity = "1" if in_project else "0.55"

        shape = TYPE_SHAPE.get(row["element_type"], DEFAULT_SHAPE)
        x, y = row["x"], row["y"]
        eid = row["id"]

        if shape == "circle":
            geom = (
                f'<circle cx="{x}" cy="{y}" r="{marker_radius}" '
                f'stroke="{stroke}" fill="{fill}" fill-opacity="{fill_opacity}" '
                f'stroke-width="1.4" vector-effect="non-scaling-stroke" '
                f'data-id="{eid}" class="element-shape"/>'
            )
        else:
            half = marker_radius
            geom = (
                f'<rect x="{x-half}" y="{y-half}" width="{half*2}" height="{half*2}" '
                f'stroke="{stroke}" fill="{fill}" fill-opacity="{fill_opacity}" '
                f'stroke-width="1.4" vector-effect="non-scaling-stroke" '
                f'data-id="{eid}" class="element-shape"/>'
            )

        mark = row.get("mark") or ""
        label = _flipped_text(
            x + marker_radius * 1.3, y, mark, marker_radius * 1.3,
            anchor="start", extra_attrs='class="mark-label"'
        )

        parts.append(f'<g data-id="{eid}" class="element-group">{geom}{label}</g>')

    parts.append("</g>")
    return "\n".join(parts)


def build_stats(rows):
    total = len(rows)
    by_source = {}
    by_status = {}
    for r in rows:
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    return total, by_source, by_status


HTML_TEMPLATE = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>Схема ЖБИ — план и адресация</title>
<style>
  :root {{
    color-scheme: light dark;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f4;
    color: #1a1a1a;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }}
  #stage {{
    flex: 1;
    position: relative;
    overflow: hidden;
    background: #ffffff;
    cursor: grab;
  }}
  #stage.dragging {{ cursor: grabbing; }}
  svg {{ width: 100%; height: 100%; display: block; }}
  .mark-label {{
    fill: #333;
    pointer-events: none;
    font-family: inherit;
  }}
  .element-shape {{ cursor: pointer; }}
  .element-shape:hover {{ stroke-width: 3; }}
  #sidebar {{
    width: 320px;
    flex-shrink: 0;
    background: #fafafa;
    border-left: 1px solid #ddd;
    padding: 16px;
    overflow-y: auto;
  }}
  #sidebar h2 {{ font-size: 15px; margin: 0 0 8px; }}
  #sidebar h3 {{ font-size: 13px; margin: 18px 0 6px; color: #555; }}
  .stat-line {{ display: flex; justify-content: space-between; font-size: 13px; padding: 2px 0; }}
  .legend-swatch {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }}
  #card {{ font-size: 13px; }}
  #card table {{ width: 100%; border-collapse: collapse; }}
  #card td {{ padding: 4px 2px; border-bottom: 1px solid #eee; vertical-align: top; }}
  #card td.k {{ color: #777; white-space: nowrap; padding-right: 8px; }}
  #placeholder {{ color: #999; font-size: 13px; }}
  label.toggle {{ font-size: 12px; display: flex; align-items: center; gap: 6px; margin-top: 8px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1e1e1e; color: #eee; }}
    #stage {{ background: #ffffff; }}
    #sidebar {{ background: #262626; border-color: #3a3a3a; }}
    #sidebar h3 {{ color: #aaa; }}
    #card td.k {{ color: #999; }}
    #card td {{ border-color: #3a3a3a; }}
  }}
</style>
</head>
<body>
<div id="stage">
  <svg id="svg-root" viewBox="{view_box}" preserveAspectRatio="xMidYMid meet">
    <g id="flip" transform="scale(1,-1)">
      {axis_svg}
      {elements_svg}
    </g>
  </svg>
</div>
<div id="sidebar">
  <h2>Схема ЖБИ — снимок данных</h2>
  <div class="stat-line"><span>Всего элементов</span><b>{total}</b></div>
  <h3>Марка (source)</h3>
  {source_stats}
  <h3>Адресация (status)</h3>
  {status_stats}
  <h3>Легенда</h3>
  <div class="stat-line"><span><span class="legend-swatch" style="background:{in_project_fill};border:1.5px solid {in_project_stroke}"></span>в проекте (on_axis / offset)</span></div>
  <div class="stat-line"><span><span class="legend-swatch" style="background:{diagnostic_color}"></span>нет данных по осям</span></div>
  <label class="toggle"><input type="checkbox" id="toggle-labels" checked/> показывать марки</label>
  <h3>Карточка элемента</h3>
  <div id="card"><div id="placeholder">Кликните по элементу на схеме</div></div>
</div>
<script>
  const DATA = {data_json};
  const byId = Object.fromEntries(DATA.map(r => [r.id, r]));

  const FIELD_LABELS = {{
    id: "ID (handle)",
    layer: "Слой",
    element_type: "Тип",
    mark: "Марка",
    source: "Источник марки",
    address: "Адрес по осям",
    status: "Статус адресации",
    axis_number: "Числовая ось",
    axis_letter: "Буквенная ось",
    nearest_axis_number: "Ближайшая числовая ось",
    nearest_axis_letter: "Ближайшая буквенная ось",
    offset_x_mm: "Смещение X, мм",
    offset_y_mm: "Смещение Y, мм",
    x: "X, мм",
    y: "Y, мм",
  }};
  const FIELD_ORDER = ["id","element_type","mark","source","address","status","axis_number","axis_letter","nearest_axis_number","nearest_axis_letter","offset_x_mm","offset_y_mm","x","y","layer"];

  document.getElementById("svg-root").addEventListener("click", (e) => {{
    const el = e.target.closest("[data-id]");
    if (!el) return;
    const row = byId[el.getAttribute("data-id")];
    if (!row) return;
    const card = document.getElementById("card");
    const rowsHtml = FIELD_ORDER.map(k => {{
      let v = row[k];
      if (v === null || v === undefined || v === "") v = "\\u2014";
      return `<tr><td class="k">${{FIELD_LABELS[k] || k}}</td><td>${{v}}</td></tr>`;
    }}).join("");
    card.innerHTML = `<table>${{rowsHtml}}</table>`;
  }});

  document.getElementById("toggle-labels").addEventListener("change", (e) => {{
    document.querySelectorAll(".mark-label").forEach(t => {{
      t.style.display = e.target.checked ? "" : "none";
    }});
  }});

  // --- Простой pan/zoom по viewBox колесом мыши и перетаскиванием ---
  const svg = document.getElementById("svg-root");
  const stage = document.getElementById("stage");
  let vb = svg.viewBox.baseVal;
  let view = {{x: vb.x, y: vb.y, w: vb.width, h: vb.height}};

  function applyView() {{
    svg.setAttribute("viewBox", `${{view.x}} ${{view.y}} ${{view.w}} ${{view.h}}`);
  }}

  stage.addEventListener("wheel", (e) => {{
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newW = view.w * factor;
    const newH = view.h * factor;
    view.x += (view.w - newW) * mx;
    view.y += (view.h - newH) * my;
    view.w = newW;
    view.h = newH;
    applyView();
  }}, {{passive: false}});

  let dragging = false, lastX = 0, lastY = 0;
  stage.addEventListener("mousedown", (e) => {{
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    stage.classList.add("dragging");
  }});
  window.addEventListener("mouseup", () => {{ dragging = false; stage.classList.remove("dragging"); }});
  window.addEventListener("mousemove", (e) => {{
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    const dx = (e.clientX - lastX) / rect.width * view.w;
    const dy = (e.clientY - lastY) / rect.height * view.h;
    view.x -= dx;
    view.y -= dy;
    lastX = e.clientX; lastY = e.clientY;
    applyView();
  }});
</script>
</body>
</html>
"""


def render_stats_html(counts, total):
    lines = []
    for key, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        pct = 100 * n / total if total else 0
        lines.append(f'<div class="stat-line"><span>{key}</span><b>{n} ({pct:.0f}%)</b></div>')
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dxf_path", help="Путь к DXF-файлу (источник сетки осей)")
    parser.add_argument("--csv", default="output/elements_with_address.csv", help="CSV от assign_axes.py")
    parser.add_argument("--out", default="output/plan.html", help="Путь к результирующему HTML")
    args = parser.parse_args()

    try:
        rows = read_elements(args.csv)
    except IOError:
        print(f"Не удалось открыть CSV: {args.csv}", file=sys.stderr)
        sys.exit(1)

    try:
        doc = ezdxf.readfile(args.dxf_path)
    except IOError:
        print(f"Не удалось открыть DXF: {args.dxf_path}", file=sys.stderr)
        sys.exit(1)

    grid = build_axis_grid(doc, AXIS_LAYER)

    points = [(r["x"], r["y"]) for r in rows]
    axis_bbox = axis_visual_bbox(grid)
    if axis_bbox:
        ax_min_x, ax_max_x, ax_min_y, ax_max_y = axis_bbox
        points += [(ax_min_x, ax_min_y), (ax_max_x, ax_max_y)]

    min_x, min_y, max_x, max_y = compute_bbox(points)
    width, height = max_x - min_x, max_y - min_y
    bbox_diag = (width ** 2 + height ** 2) ** 0.5
    element_points = [(r["x"], r["y"]) for r in rows]
    marker_radius = estimate_marker_radius(element_points, bbox_diag)

    view_box = f"{min_x} {-max_y} {width} {height}"

    axis_svg = build_axis_svg(grid, marker_radius)
    elements_svg = build_elements_svg(rows, marker_radius)

    total, by_source, by_status = build_stats(rows)

    html = HTML_TEMPLATE.format(
        view_box=view_box,
        axis_svg=axis_svg,
        elements_svg=elements_svg,
        total=total,
        source_stats=render_stats_html(by_source, total),
        status_stats=render_stats_html(by_status, total),
        in_project_fill=IN_PROJECT_FILL,
        in_project_stroke=IN_PROJECT_STROKE,
        diagnostic_color=DIAGNOSTIC_COLOR,
        data_json=json.dumps(rows, ensure_ascii=False),
    )

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Схема сохранена: {args.out}")
    print(f"Элементов: {total}, числовых осей: {len(grid.numeric_axes)}, буквенных осей: {len(grid.letter_axes)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пересборка схемы базы данных в формате draw.io (Docs/db-schema.drawio).

  python3 scripts/gen_db_schema_drawio.py

Зачем отдельный генератор, а не рисование руками: схема из трёх десятков
таблиц и двух сотен полей руками не переживает ни одной миграции — её
перестают обновлять на второй правке, и она начинает врать. Здесь же
достаточно дописать поле в описание и перезапустить.

ЧТО ЗДЕСЬ ИСТОЧНИК ЧЕГО. Описание (что за таблица, что значит каждое поле,
какие связи) лежит в `app/db_schema_doc.py` — ОДНОМ на весь проект: оттуда
же его берёт отчёт «Состояние БД» в интерфейсе администратора. Состав
таблиц, полей и внешних ключей берётся из РЕАЛЬНОЙ базы (`data/zhbi.db`
после всех миграций), но только для СВЕРКИ, не для генерации: назначения
полей из SQLite вытащить нельзя. Если описание и база разошлись, скрипт
НИЧЕГО НЕ ПИШЕТ, а печатает расхождения: после миграции нужно дописать
новое поле вместе с его назначением, иначе схема тихо устареет — ровно то,
ради чего генератор и заводился.

Здесь же остаётся РАСКЛАДКА (`COLUMNS`, дорожки связей, цвета линий) — она
относится к рисунку, а не к базе, и в интерфейсе не нужна.

  --db ПУТЬ      база для сверки (по умолчанию $ZHBI_DB_PATH или
                 data/zhbi.db; если файла нет — сверка пропускается)
  --out ПУТЬ     куда писать (по умолчанию Docs/db-schema.drawio)
  --force        собрать несмотря на расхождения со схемой БД
  --no-check     не сверяться с базой вовсе

Зависимостей нет, только стандартная библиотека. Проверить результат
можно экспортом самим draw.io (на Mac разработчика он установлен):

  /Applications/draw.io.app/Contents/MacOS/draw.io --export --format png \\
      --scale 0.5 --output /tmp/schema.png Docs/db-schema.drawio
"""

import html
import os
import sqlite3
import sys
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.environ.get("ZHBI_DB_PATH") or os.path.join(REPO, "data", "zhbi.db")
DEFAULT_OUT = os.path.join(REPO, "Docs", "db-schema.drawio")

# ------------------------------------------------------------------ геометрия
W = 520          # ширина таблицы
HEAD = 34        # высота заголовка
ROW = 24         # высота строки поля
COL_GAP = 260    # промежуток между колонками — в нём лежат «дорожки» связей
ROW_GAP = 90
Y0 = 120
X0 = 320         # отступ слева: в нём разворачиваются связи внутри первой колонки

# Описание таблиц, полей и связей — в app/db_schema_doc.py: тем же списком
# пользуется отчёт «Состояние БД» в интерфейсе (app/db_status.py), а два
# списка одного и того же разъехались бы на первой миграции. Модуль без
# зависимостей, поэтому скрипт по-прежнему запускается системным python3.
sys.path.insert(0, REPO)
from app.db_schema_doc import (  # noqa: E402
    TABLES, FKS, SOFT, BY_NAME,
    C_HIER, C_USER, C_ELEM, C_ZONE, C_CONTR, C_REF,
    S_HIER, S_USER, S_ELEM, S_ZONE, S_CONTR, S_REF,
    verify as verify_description,
)

COLUMNS = [
    ["users", "sessions", "user_access", "attachments", "activity_log", "status_colors",
     "element_shapes", "allowed_subtypes"],
    ["projects", "objects", "object_drawings", "label_visibility", "zone_colors",
     "app_settings", "report_notes"],
    ["elements", "status_history", "axis_lines"],
    ["zones", "zone_levels", "zone_edit_undo", "default_contracts", "mark_type_prefixes"],
    ["counterparties", "agreements", "specifications", "contracts", "contract_lines",
     "contract_incidents"],
]


# Цвет связи — по таблице, НА КОТОРУЮ она ссылается: все линии, ведущие в
# objects, одного цвета, в contracts — другого. Так пучок из десятка ссылок
# на один справочник читается как единое целое, а соседние пучки не путаются.
PARENT_COLOR = {
    "objects":           "#1a73c8",
    "projects":          "#0b7285",
    "users":             "#2f9e44",
    "elements":          "#e8590c",
    "contracts":         "#b54708",
    "zones":             "#7048e8",
    "zone_levels":       "#c026d3",
    "counterparties":    "#c2255c",
    "agreements":        "#9d174d",
    "specifications":    "#7c3aed",
    "object_drawings":   "#0e9f9f",
    "status_colors":     "#8d6e63",
    "allowed_subtypes":  "#5c6bc0",
    "element_shapes":    "#6d4c41",
    "label_visibility":  "#00838f",
    "default_contracts": "#946200",
    "contract_lines":    "#a16207",
    "mark_type_prefixes": "#78716c",
}

EDGE_BASE = ("edgeStyle=orthogonalEdgeStyle;rounded=1;arcSize=12;html=1;fontSize=10;"
             "jumpStyle=arc;jumpSize=10;labelBackgroundColor=#ffffff;")

LEGEND_ITEMS = [
    ("Иерархия: проекты и объекты", C_HIER, S_HIER),
    ("Пользователи, сессии, доступ", C_USER, S_USER),
    ("Элементы ЖБИ и история статусов", C_ELEM, S_ELEM),
    ("Зоны: захватка / кран / стоянка", C_ZONE, S_ZONE),
    ("Контрактация", C_CONTR, S_CONTR),
    ("Справочники, настройки, журнал", C_REF, S_REF),
]


def esc(s):
    return html.escape(str(s), quote=True)


def key_badge(k):
    """Пометка ключа перед именем поля: PK / FK / PK+FK / U."""
    if not k:
        return ""
    if k == "U":
        return '<font color="#7f0000">U&nbsp;</font>'
    return '<font color="#00527c"><b>%s</b>&nbsp;</font>' % k.replace(",", "+")


def build_xml(subtitle):
    """Собрать полный XML диаграммы. Возвращает строку."""
    missing = {n for col in COLUMNS for n in col} ^ set(BY_NAME)
    if missing:
        raise SystemExit("раскладка COLUMNS расходится со списком TABLES: %s"
                         % ", ".join(sorted(missing)))

    cells = []
    row_ids = {}    # (таблица, поле) -> id ячейки строки
    row_y = {}      # (таблица, поле) -> абсолютная Y середины строки
    col_x = []      # X каждой колонки
    table_col = {}  # таблица -> индекс колонки
    bottom = Y0     # нижняя граница самой длинной колонки — под ней идут «шины»

    # --------------------------------------------------------------- таблицы
    x = X0
    for ci, col in enumerate(COLUMNS):
        col_x.append(x)
        y = Y0
        for name in col:
            table_col[name] = ci
            tname, caption, fill, stroke, fields = BY_NAME[name]
            h = HEAD + ROW * len(fields)
            tid = "t_" + tname
            cells.append(
                '<mxCell id="%s" value="%s" style="shape=table;startSize=%d;container=1;'
                'collapsible=0;childLayout=tableLayout;fixedRows=1;rowLines=0;fontStyle=1;'
                'fontSize=13;align=center;resizeLast=1;html=1;fillColor=%s;strokeColor=%s;'
                'swimlaneFillColor=#ffffff;" vertex="1" parent="1">'
                '<mxGeometry x="%d" y="%d" width="%d" height="%d" as="geometry"/></mxCell>'
                % (tid, esc(caption), HEAD, fill, stroke, x, y, W, h)
            )
            for i, (fname, ftype, fkey, purpose) in enumerate(fields):
                rid = "%s_%s_%d" % (tid, fname, i)
                row_ids[(tname, fname)] = rid
                # абсолютная середина строки — нужна для ручной маршрутизации связей
                row_y[(tname, fname)] = y + HEAD + i * ROW + ROW // 2
                cells.append(
                    '<mxCell id="%s" value="" style="shape=tableRow;horizontal=0;startSize=0;'
                    'swimlaneHead=0;swimlaneBody=0;fillColor=none;collapsible=0;dropTarget=0;'
                    'points=[[0,0.5],[1,0.5]];portConstraint=eastwest;top=0;left=0;right=0;'
                    'bottom=0;strokeColor=%s;" vertex="1" parent="%s">'
                    '<mxGeometry y="%d" width="%d" height="%d" as="geometry"/></mxCell>'
                    % (rid, stroke, tid, HEAD + i * ROW, W, ROW)
                )
                # HTML-разметка подписи собирается сырой, а затем целиком
                # экранируется — это значение XML-атрибута, drawio разбирает
                # её обратно. Без экранирования файл просто не открывается.
                label = esc('%s<b>%s</b> <font color="#808080">%s</font> — %s'
                            % (key_badge(fkey), fname, ftype, purpose))
                cells.append(
                    '<mxCell id="%s_c" value="%s" style="shape=partialRectangle;connectable=0;'
                    'fillColor=none;align=left;verticalAlign=middle;strokeColor=none;'
                    'overflow=hidden;spacingLeft=8;spacingRight=8;html=1;fontSize=11;" '
                    'vertex="1" parent="%s"><mxGeometry width="%d" height="%d" as="geometry"/>'
                    '</mxCell>' % (rid, label, rid, W, ROW)
                )
            y += h + ROW_GAP
            bottom = max(bottom, y - ROW_GAP)
        x += W + COL_GAP

    # ----------------------------------------------------------------- связи
    # Счётчики «дорожек»: у каждой связи собственная вертикаль в промежутке
    # между колонками, иначе десяток ссылок на objects.id слился бы в одну
    # линию — их было бы не различить и не проследить.
    lanes = {}
    state = {"bus": 0, "label_slot": 0}

    def lane_x(side, ci):
        """X вертикального участка. side: 'L' — слева от колонки, 'R' — справа."""
        k = lanes.get((side, ci), 0)
        lanes[(side, ci)] = k + 1
        if side == "L":
            return col_x[ci] - 30 - k * 18
        return col_x[ci] + W + 30 + k * 18

    def edge_xml(eid, child, cf, parent, pf, label, soft):
        ccol, pcol = table_col[child], table_col[parent]
        cy, py = row_y[(child, cf)], row_y[(parent, pf)]
        color = PARENT_COLOR.get(parent, "#4d4d4d")

        if ccol == pcol:
            # Внутри одной колонки — разворот в промежутке слева от неё.
            side, exitp, entryp = "L", (0, 0.5), (0, 0.5)
        elif ccol < pcol:
            # Предок правее: подходим к нему слева.
            side, exitp, entryp = "L", (1, 0.5), (0, 0.5)
        else:
            # Предок левее: подходим справа.
            side, exitp, entryp = "R", (0, 0.5), (1, 0.5)
        lx = lane_x(side, pcol)

        if abs(ccol - pcol) >= 2:
            # Связь через две и более колонки: горизонтальный участок на
            # уровне строки прошёл бы ПОВЕРХ промежуточных таблиц и
            # перечеркнул их текст. Поэтому такие связи уходят вниз, идут по
            # своей «шине» под схемой и поднимаются к предку — по дороге не
            # задевая ни одной таблицы.
            cside = "R" if pcol > ccol else "L"
            cx = lane_x(cside, ccol)
            by = bottom + 70 + state["bus"] * 22
            state["bus"] += 1
            pts = [(cx, cy), (cx, by), (lx, by), (lx, py)]
        else:
            pts = [(lx, cy)]

        style = (EDGE_BASE + "strokeColor=%s;fontColor=%s;exitX=%s;exitY=%s;exitDx=0;"
                 "exitDy=0;entryX=%s;entryY=%s;entryDx=0;entryDy=0;"
                 % (color, color, exitp[0], exitp[1], entryp[0], entryp[1]))
        if soft:
            style += ("dashed=1;dashPattern=6 6;strokeWidth=1;startArrow=none;"
                      "endArrow=open;endFill=0;opacity=70;")
        else:
            style += "strokeWidth=1.6;startArrow=ERmany;startFill=0;endArrow=ERone;endFill=0;"
        points = "".join('<mxPoint x="%d" y="%d"/>' % p for p in pts)
        # Подписи сдвигаются вдоль линии по очереди: в пучке (три ссылки
        # elements на zones подряд) все они иначе встают в одну точку.
        shift = (-0.45, 0.0, 0.45, -0.22, 0.22)[state["label_slot"] % 5]
        state["label_slot"] += 1
        return (
            '<mxCell id="%s" value="%s" style="%s" edge="1" parent="1" source="%s" '
            'target="%s"><mxGeometry x="%.2f" relative="1" as="geometry">'
            '<Array as="points">%s</Array></mxGeometry></mxCell>'
            % (eid, esc(label), style, row_ids[(child, cf)], row_ids[(parent, pf)],
               shift, points)
        )

    for n, (child, cf, parent, pf, label) in enumerate(FKS, 1):
        cells.append(edge_xml("e%d" % n, child, cf, parent, pf, label, soft=False))
    for n, (child, cf, parent, pf, label) in enumerate(SOFT, 1):
        cells.append(edge_xml("s%d" % n, child, cf, parent, pf, label, soft=True))

    # -------------------------------------------------- заголовок и легенда
    cells.append(
        '<mxCell id="title" value="%s" style="text;html=1;fontSize=28;fontStyle=1;'
        'align=left;verticalAlign=middle;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="20" width="1600" height="50" as="geometry"/></mxCell>'
        % (esc("ЖБИ-трекер — схема базы данных (SQLite). " + subtitle), X0)
    )

    lx = x + 40
    cells.append(
        '<mxCell id="lg" value="Условные обозначения" style="rounded=0;whiteSpace=wrap;'
        'html=1;verticalAlign=top;fontStyle=1;fontSize=14;align=left;spacingLeft=10;'
        'spacingTop=6;fillColor=#ffffff;strokeColor=#666666;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="%d" width="440" height="%d" as="geometry"/></mxCell>'
        % (lx, Y0, 60 + 34 * len(LEGEND_ITEMS) + 300)
    )
    ly = Y0 + 44
    for i, (text, fill, stroke) in enumerate(LEGEND_ITEMS):
        cells.append(
            '<mxCell id="lgb%d" value="" style="rounded=0;html=1;fillColor=%s;'
            'strokeColor=%s;" vertex="1" parent="1"><mxGeometry x="%d" y="%d" width="26" '
            'height="20" as="geometry"/></mxCell>' % (i, fill, stroke, lx + 14, ly + i * 34)
        )
        cells.append(
            '<mxCell id="lgt%d" value="%s" style="text;html=1;align=left;'
            'verticalAlign=middle;fontSize=12;" vertex="1" parent="1">'
            '<mxGeometry x="%d" y="%d" width="360" height="20" as="geometry"/></mxCell>'
            % (i, esc(text), lx + 50, ly + i * 34)
        )
    cells.append(
        '<mxCell id="lgn" value="%s" style="text;html=1;whiteSpace=wrap;align=left;'
        'verticalAlign=top;fontSize=11;spacingLeft=4;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="%d" width="400" height="290" as="geometry"/></mxCell>'
        % (esc(
            "<b>PK</b> — первичный ключ, <b>FK</b> — внешний ключ, <b>U</b> — уникальность."
            "<br><br><b>Сплошная</b> линия — внешний ключ, подпись = поведение ON DELETE."
            "<br>«Гусиная лапка» — сторона «многие», одинарная черта — сторона «один»."
            "<br><b>Пунктир</b> — логическая связь по значению, без FK в схеме."
            "<br><br><b>Цвет линии</b> — таблица, НА КОТОРУЮ она ссылается: все ссылки "
            'на <font color="#1a73c8">objects</font> синие, на '
            '<font color="#2f9e44">users</font> зелёные, на '
            '<font color="#b54708">contracts</font> коричневые, на '
            '<font color="#7048e8">zones</font> фиолетовые.'
            "<br>Дуга-«мостик» на пересечении означает, что линии не связаны."
            "<br><br>У каждой связи своя вертикальная дорожка в промежутке между "
            "колонками. Связи через две и более колонки уходят вниз, на «шину» под "
            "схемой, и поднимаются к предку — чтобы не проходить поверх таблиц."
        ), lx + 14, ly + 34 * len(LEGEND_ITEMS) + 10)
    )

    return (
        '<mxfile host="app.diagrams.net" agent="scripts/gen_db_schema_drawio.py" '
        'version="24.0.0">\n'
        '  <diagram id="zhbi-db" name="ЖБИ — схема БД">\n'
        '    <mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" '
        'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        'pageWidth="1169" pageHeight="826" math="0" shadow="0">\n'
        '      <root>\n'
        '        <mxCell id="0"/>\n'
        '        <mxCell id="1" parent="0"/>\n'
        '        ' + '\n        '.join(cells) + '\n'
        '      </root>\n'
        '    </mxGraphModel>\n'
        '  </diagram>\n'
        '</mxfile>\n'
    )


def verify(db_path):
    """Сверить описание (app/db_schema_doc.py) с реальной схемой БД.

    Сама сверка живёт в модуле описания: тем же кодом сверяется отчёт
    «Состояние БД» в интерфейсе, и разойтись эти две проверки не должны.
    Здесь остаётся только открыть базу ТОЛЬКО НА ЧТЕНИЕ — скрипт запускают
    и на боевом файле, и он не имеет права его менять.
    """
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        return verify_description(con)
    finally:
        con.close()


def main():
    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    def opt(flag, default):
        return args[args.index(flag) + 1] if flag in args else default

    db_path = opt("--db", DEFAULT_DB)
    out_path = opt("--out", DEFAULT_OUT)

    checked = None
    if "--no-check" not in args:
        if not os.path.exists(db_path):
            print("! базы %s нет — сверка пропущена" % db_path)
        else:
            problems = verify(db_path)
            checked = db_path
            if problems:
                print("Схема БД и списки в скрипте разошлись (%d):" % len(problems))
                for p in problems:
                    print("  -", p)
                if "--force" not in args:
                    print("\nДопишите поля вместе с их назначением в TABLES/FKS "
                          "(%s) и запустите снова.\n"
                          "Собрать как есть: --force" % os.path.abspath(__file__))
                    return 1
                print("  (--force: собираю как есть)")
            else:
                print("Сверка с %s: расхождений нет" % db_path)

    subtitle = ("Сверено с %s, %s" % (os.path.basename(checked),
                                      date.today().strftime("%d.%m.%Y"))
                if checked else "Структура на %s" % date.today().strftime("%d.%m.%Y"))
    xml = build_xml(subtitle)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(xml)
    print("Записано: %s (таблиц %d, полей %d, связей %d + %d логических)"
          % (out_path, len(TABLES), sum(len(t[4]) for t in TABLES), len(FKS), len(SOFT)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

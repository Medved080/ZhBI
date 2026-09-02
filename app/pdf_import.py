"""
Оркестрация загрузки помещений из PDF — веб-обвязка над `app/pdf_rooms.py`
(разбор) и справочниками объекта (`app/blocks.py`).

Двухфазно, как импорт Revit (решение И3, `app/revit_import.py`): `analyze`
разбирает файл и считает сводку, ничего не пишет; `apply` применяет уже
посчитанное по токену.

Помещения пишутся в `revit_elements` — ту же таблицу, что и элементы
Revit, категорией `"Помещение"` и СВОИМ разделом `section_code = "PDF"`:
рабочее место «Модель МФР» рисует любую строку `revit_elements` с контуром
и высотой одинаково, отдельного рендера заводить не пришлось. Раздел
`"PDF"` — своя область списания (см. `app/revit_elements.py`, докстрока):
если у объекта позже появится настоящая выгрузка Revit (КР/АР), она не
тронет и не задвоит то, что загружено отсюда.

Секции/этажи объекта заводятся тем же путём, что и ручной ввод в «Учёт по
блокам» (`app/blocks.py`) — идемпотентно, без дублей при повторной
загрузке. Секция помещений — из `app/pdf_rooms.Room.section`: на этажах
с единственной секцией она известна из таблицы этажей, на общих
этажах 1-8 — по границе подписей осей «…с1»/«…с2» на самом чертеже
(замечено пользователем 2026-08-26). `app/revit_sections.fill_missing`
(геометрическое голосование по зонам) здесь не нужен вовсе.

Тем же подписям осей `apply()` находит применение второй раз — пишет
позиции осей (`object_grids`) и привязку `axis_from`/`axis_to` у секций
С01/С02 (`_apply_axis_grid`), иначе у объекта из PDF нет геометрии блока
и «Блоки» не рисуются в 3D (`app/block_geometry.py` возвращал бы «у
секции не заданы оси» — до этой версии так и было).

Каждое помещение несёт источник в `params_json` — имя PDF-файла и номер
листа (`build_rows`, докстрока): у элемента из PDF нет `revit_id`,
по которому можно найти исходник в чертеже.

Стены, перегородки и плиты перекрытия (`app/pdf_rooms.parse_walls_document`,
2026-08-26) пишутся туда же, категориями «Стены»/«Перегородки»/«Перекрытия»
(первая и третья — существующие категории Revit, готовый цвет в любой
палитре `app/revit_colors.py`; «Перегородки» — новая, добавлена туда же).
Материал — из ИМЕНИ слоя чертежа (`pdf_rooms._WALL_LAYERS`), не из цвета
легенды: слой определяет материал напрямую и однозначно. Идентичность —
как у помещений, порядковый индекс по этажу и категории, не устойчивый
ключ.
"""

import json
import threading
import uuid

from app import blocks as blocks_mod
from app import db as db_mod
from app import pdf_rooms
from app.blocks import BlockError

_PENDING = {}
_PENDING_LIMIT = 3

# Задачи разбора PDF в фоновом потоке (2026-08-31, прогресс-бар — сам
# разбор занимает ~30с, отдельный запрос столько не держат). Тот же приём
# ключ-значение в памяти, что и _PENDING, но недолгоживущий: запись нужна
# только на время «Разбираю…», после готовности результат уходит в
# _PENDING по своему токену, а сама задача остаётся в _JOBS лишь для того,
# чтобы клиент, опрашивающий её, увидел финальный статус разок-другой.
_JOBS = {}
_JOBS_LIMIT = 5


class PdfImportError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _floor_spec(floor: str) -> tuple:
    """floor-строка pdf_rooms.Room -> (номер этажа, вид, подпись)."""
    if floor == "подземный":
        return -1, "подземный", None
    if floor == "технический (секция 2)":
        return 25, "этаж", "Технический этаж (секция 2)"
    # Секция 1 заканчивается на 8-м этаже, а её технический этаж и кровля
    # (2026-09-01) физически стоят на отметках 25650 и 29400мм — они НЕ
    # могут разделить `key`/`sort_order` с этажами «9» и «10» секции 2 (те
    # же номера, но другие отметки: 25650 совпадает с «9» случайно, а
    # 28650 у «10» и 29400 здесь — уже нет; общий `key` склеил бы разные
    # отметки в одну запись и один из этажей остался бы с чужой высотой).
    # Свободные номера в хвосте, тем же приёмом, что и «технический
    # (секция 2)» — в списке этажей МФР эти два ляжут в самый конец (после
    # технического этажа секции 2), а не рядом с 8-м, это только порядок в
    # списке, не отметка (та берётся из `pdf_rooms.FLOOR_PLANS`, не из
    # этого номера).
    if floor == "технический (секция 1)":
        return 26, "этаж", "Технический этаж (секция 1)"
    if floor == "кровля (секция 1)":
        return 27, "этаж", "Кровля (секция 1)"
    # Выход на кровлю секции 2 — ярус только упрощённой загрузки по фасадам
    # (2026-09-02, `pdf_facade_import._PLAN_ROOF2_FLOOR`): в `FLOOR_PLANS`
    # его нет, детальный разбор лист 16 не читает (см. `_FACADE_ONLY_LEVELS`).
    if floor == "кровля (секция 2)":
        return 28, "этаж", "Кровля (секция 2)"
    return int(floor), "этаж", None


def _ensure_section(conn, object_id: int, code: str) -> int:
    row = conn.execute(
        "SELECT id FROM object_sections WHERE object_id = ? AND code = ?",
        (object_id, code)).fetchone()
    if row:
        return row["id"]
    try:
        created = blocks_mod.create_section(conn, object_id, code, trusted=True)
    except BlockError:
        row = conn.execute(
            "SELECT id FROM object_sections WHERE object_id = ? AND code = ?",
            (object_id, code)).fetchone()
        return row["id"]
    return created["id"]


def _ensure_level(conn, object_id: int, floor_label: str) -> tuple:
    """Возвращает (level_id, key). Отметка — из таблицы этажей чертежа
    (`pdf_rooms.FLOOR_PLANS`, z0): без неё блок не получает высоты
    (`app/block_geometry.block_box` — «отметке этажа верить нельзя»).
    Уже заведённую отметку не трогает — только дополняет пустую."""
    floor_no, kind, name = _floor_spec(floor_label)
    key = "этаж:%d" % floor_no
    z0, z1 = _floor_elevation(floor_label)
    # Высота этажа — из той же таблицы чертежа (`FLOOR_PLANS`/
    # `_FACADE_ONLY_LEVELS`), явно (`object_levels.height_mm`, 2026-09-02):
    # иначе блок считался бы «до следующего этажа секции», и техпространство
    # секции 1 (1,79м) выходило бы блоком в 3,75м. Уже заведённой высоты не
    # трогает — только дополняет пустую (тот же приём, что у отметки).
    height = z1 - z0 if z1 > z0 else None
    row = conn.execute(
        "SELECT id, elevation_mm, height_mm FROM object_levels WHERE object_id = ? AND key = ?",
        (object_id, key)).fetchone()
    if row:
        if row["elevation_mm"] is None or (row["height_mm"] is None and height):
            blocks_mod.update_level(
                conn, object_id, row["id"],
                elevation_mm=z0 if row["elevation_mm"] is None else None,
                height_mm=height if row["height_mm"] is None else None)
        return row["id"], key
    try:
        created = blocks_mod.create_level(conn, object_id, kind, floor=floor_no, name=name,
                                          elevation_mm=z0, height_mm=height)
    except BlockError:
        row = conn.execute(
            "SELECT id FROM object_levels WHERE object_id = ? AND key = ?",
            (object_id, key)).fetchone()
        return row["id"], key
    return created["id"], key


def _ensure_catalog(conn, object_id: int) -> tuple:
    """Секции и этажи объекта — идемпотентно. Возвращает (по_этажу,
    section_ids): по_этажу — {этаж-строка: (level_id, [section_id, ...])},
    section_ids — {"С01": id, "С02": id, "Паркинг": id}. Паркинг —
    отдельная секция подземного этажа (2026-08-31, прямое уточнение
    пользователя), не подсекция С01/С02."""
    section_ids = {
        code: _ensure_section(conn, object_id, code)
        for code in ("С01", "С02", pdf_rooms._PARKING_SECTION)
    }
    out = {}
    for plan in pdf_rooms.FLOOR_PLANS:
        level_id, _key = _ensure_level(conn, object_id, plan.floor)
        section_id_list = [section_ids[c] for c in plan.section_codes]
        out[plan.floor] = (level_id, section_id_list)
        for sid in section_id_list:
            try:
                blocks_mod.create_block(conn, object_id, sid, level_id)
            except BlockError:
                pass  # блок уже существует или конфликтует — не критично для импорта помещений
    return out, section_ids


# Ярусы, которых нет в `pdf_rooms.FLOOR_PLANS` (детальный разбор их не
# читает), но которые заводит упрощённая загрузка по фасадам — отметки по
# подписям фасадного листа: выход на кровлю секции 2 стоит на верхе
# техэтажа (+76,800), его кровля «Кровля 2 С2» +78,750, лифтовая головка
# выше до +79,800 (2026-09-02, живой запрос пользователя; Docs/backlog.md).
_FACADE_ONLY_LEVELS = {"кровля (секция 2)": (76800, 78750)}


def _floor_elevation(floor_label: str) -> tuple:
    for plan in pdf_rooms.FLOOR_PLANS:
        if plan.floor == floor_label:
            return plan.z0, plan.z1
    if floor_label in _FACADE_ONLY_LEVELS:
        return _FACADE_ONLY_LEVELS[floor_label]
    raise KeyError(floor_label)


def _source_params(filename: str, page: int) -> str:
    data = {"источник_pdf": filename, "страница": page} if filename else {"страница": page}
    return json.dumps(data, ensure_ascii=False)


def _level_name(floor_label: str) -> str:
    return "этаж %s" % floor_label if floor_label.lstrip("-").isdigit() else floor_label


# Категория -> префикс uid, чтобы стены/перегородки/плиты не задваивались
# с помещениями по индексу этажа (у "pdf:{этаж}:{индекс}" — префикса уже
# нет, это существующая схема помещений, менять её — переизобретать
# идентичность уже загруженных строк).
_WALL_UID_PREFIX = {"Стены": "стена", "Перегородки": "перегородка", "Окна": "окно"}


def build_wall_rows(walls: list, floors: dict, section_ids: dict, filename: str = None) -> list:
    """Стены, перегородки и окна `pdf_rooms.WallSegment` -> строки для
    revit_elements. Высота — во весь этаж (пол-потолок), как и у
    помещений: своей высоты на чертеже (виде сверху) не нашлось, но
    исходная высотная привязка честная (этаж, к которому относится
    сегмент), а не додуманная. Категория «Окна» — исключение: у нее ЕСТЬ
    своя высота/отступ (`w.z_offset_mm`/`w.z_height_mm`,
    `pdf_rooms._WINDOW_SILL_MM`/`_WINDOW_HEIGHT_MM`) — тоже приближение
    (типовые подоконник/высота), не измерение, но честнее, чем во весь
    этаж — окно во всю высоту читалось бы как витраж, а это не так."""
    rows = []
    for i, w in enumerate(walls):
        z0, z1 = _floor_elevation(w.floor)
        level_id, _section_id_list = floors[w.floor]
        if w.section:
            section_id, section_source = section_ids[w.section], "параметр"
        else:
            section_id, section_source = None, None
        outline = [[round(x, 1), round(y, 1)] for x, y in w.polygon_mm]
        if w.z_offset_mm is not None and w.z_height_mm is not None:
            elevation_mm, height_mm = z0 + w.z_offset_mm, w.z_height_mm
        else:
            elevation_mm, height_mm = z0, z1 - z0
        rows.append({
            "section_code": "PDF",
            "uid": "pdf:%s:%s:%d" % (_WALL_UID_PREFIX[w.category], w.floor, w.index),
            "revit_id": None,
            "category": w.category,
            "family": None,
            "type_name": w.material,
            "mark": None,
            "level_id": level_id,
            "level_name": _level_name(w.floor),
            "section_id": section_id,
            "section_source": section_source,
            "elevation_mm": elevation_mm,
            "height_mm": height_mm,
            "x": None, "y": None, "z": None,
            "outline_json": json.dumps(outline, ensure_ascii=False),
            "outline_approx": 0,
            "volume": None,
            "area": None,
            "workset": None,
            "params_json": json.dumps(
                ({"источник_pdf": filename} if filename else {})
                | {"страница": w.page, "материал": w.material,
                   "толщина_мм": w.thickness_mm}
                | ({"высота_и_отступ": "типовые, не измерены — в плане нет "
                    "вертикальной привязки"} if w.z_offset_mm is not None else {}),
                ensure_ascii=False),
        })
    return rows


def build_slab_rows(slabs: list, floors: dict, filename: str = None) -> list:
    """Плиты перекрытия `pdf_rooms.Slab` -> строки для revit_elements.
    Контур — приближение (объединение помещений и стен этажа, см.
    докстрока `Slab`), высота — фиксированная `_SLAB_THICKNESS_MM`,
    у основания этажа (`elevation_mm = z0 - толщина`)."""
    rows = []
    for s in slabs:
        z0, _z1 = _floor_elevation(s.floor)
        level_id, _section_id_list = floors[s.floor]
        outline = [[round(x, 1), round(y, 1)] for x, y in s.polygon_mm]
        rows.append({
            "section_code": "PDF",
            "uid": "pdf:плита:%s" % s.floor,
            "revit_id": None,
            "category": "Перекрытия",
            "family": None,
            "type_name": "Плита перекрытия (приближение контуром)",
            "mark": None,
            "level_id": level_id,
            "level_name": _level_name(s.floor),
            "section_id": None,
            "section_source": None,
            "elevation_mm": z0 - pdf_rooms._SLAB_THICKNESS_MM,
            "height_mm": pdf_rooms._SLAB_THICKNESS_MM,
            "x": None, "y": None, "z": None,
            "outline_json": json.dumps(outline, ensure_ascii=False),
            "outline_approx": 1,
            "volume": None,
            "area": None,
            "workset": None,
            "params_json": _source_params(filename, s.page),
        })
    return rows


def build_rows(rooms: list, floors: dict, section_ids: dict, filename: str = None) -> list:
    """Помещения pdf_rooms.Room -> строки для revit_elements.

    Секция берётся из `room.section` — на этажах с единственной возможной
    секцией это она (проставлено в `pdf_rooms.parse_document`), на общих
    этажах (1-8) — определена по границе подписей осей «…с1»/«…с2»
    (Docs/TZ.md §3а). `None` бывает только если на листе не нашлось подписей
    обеих секций сразу — тогда честно остаётся неопределённой, не гадаем.

    `params_json` несёт источник — имя PDF-файла и номер листа: у элемента
    из PDF нет `revit_id`, по которому можно найти исходник, а лист даже у
    одного и того же файла меняется от комплекта к комплекту."""
    rows = []
    for room in rooms:
        z0, z1 = _floor_elevation(room.floor)
        level_id, _section_id_list = floors[room.floor]
        if room.section:
            section_id, section_source = section_ids[room.section], "параметр"
        else:
            section_id, section_source = None, None
        outline = [[round(x, 1), round(y, 1)] for x, y in room.polygon_mm]
        rows.append({
            "section_code": "PDF",
            "uid": "pdf:%s:%d" % (room.floor, room.index),
            "revit_id": None,
            "category": "Помещение",
            "family": None,
            "type_name": None,
            "mark": None,
            "level_id": level_id,
            "level_name": _level_name(room.floor),
            "section_id": section_id,
            "section_source": section_source,
            "elevation_mm": z0,
            "height_mm": z1 - z0,
            "x": None, "y": None, "z": None,
            "outline_json": json.dumps(outline, ensure_ascii=False),
            "outline_approx": 0,
            "volume": None,
            "area": room.area_m2,
            "workset": None,
            "params_json": _source_params(filename, room.page),
        })
    return rows


def analyze(conn, object_id: int, data: bytes, filename: str = None,
            on_progress=None) -> dict:
    """Фаза 1: разбор файла и сверка. В БД не пишет ничего — даже
    справочники секций/этажей, они заводятся только в apply().

    `on_progress(этап, номер_листа, разобрано, всего)` — необязательный
    колбэк для прогресс-бара (2026-08-31, запрос пользователя «сколько ещё
    ждать»): вызывается после каждого уникального листа обеих тяжёлых
    стадий разбора (`pdf_rooms.parse_document`/`parse_walls_document`, см.
    их докстроки — почему по листам, а не по этажам, и почему
    `номер_листа` и `всего` разной природы — путать их в одном «N из M»
    нельзя, первая версия прогресс-бара так и делала и запутала
    пользователя). `extract_axis_grid` в колбэк не попадает — доли секунды
    на фоне ~30с двух стадий выше."""
    doc = pdf_rooms.load(data)

    def _rooms_progress(page_number, processed, total):
        if on_progress:
            on_progress("Разбираю помещения", page_number, processed, total)

    def _walls_progress(page_number, processed, total):
        if on_progress:
            on_progress("Разбираю стены и перекрытия", page_number, processed, total)

    rooms, room_warnings = pdf_rooms.parse_document(doc, on_progress=_rooms_progress)
    if not rooms:
        raise PdfImportError(422, "В файле не нашлось ни одного помещения — "
                             "проверьте, тот ли это комплект чертежей.")
    walls, slabs, wall_warnings = pdf_rooms.parse_walls_document(
        doc, rooms, on_progress=_walls_progress)
    axis_grid = pdf_rooms.extract_axis_grid(doc)
    parse_warnings = room_warnings + wall_warnings

    row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
    object_name = row["name"] if row else ""

    existing = {
        r["uid"] for r in conn.execute(
            "SELECT uid FROM revit_elements WHERE object_id = ? "
            "AND section_code = 'PDF' AND is_current = 1", (object_id,))
    }
    seen = {"pdf:%s:%d" % (room.floor, room.index) for room in rooms}
    seen |= {"pdf:%s:%s:%d" % (_WALL_UID_PREFIX[w.category], w.floor, w.index) for w in walls}
    seen |= {"pdf:плита:%s" % s.floor for s in slabs}
    retired_uids = sorted(existing - seen)
    new_count = len(seen - existing)
    unchanged_count = len(seen & existing)

    by_floor = {}
    for room in rooms:
        s = by_floor.setdefault(room.floor, {"помещений": 0, "с площадью": 0})
        s["помещений"] += 1
        if room.area_m2 is not None:
            s["с площадью"] += 1

    _windows_count = sum(1 for w in walls if w.category == "Окна")
    return {
        "object_id": object_id,
        "object_name": object_name,
        "total_rooms": len(rooms),
        "total_walls": len(walls) - _windows_count,
        "total_windows": _windows_count,
        "total_slabs": len(slabs),
        "new": new_count,
        "unchanged": unchanged_count,
        "retiring": len(retired_uids),
        "by_floor": by_floor,
        "warnings": parse_warnings,
        "_rooms": rooms,
        "_walls": walls,
        "_slabs": slabs,
        "_retired_uids": retired_uids,
        "_axis_grid": axis_grid,
        "filename": filename,
    }


_INSERT = (
    "INSERT INTO revit_elements (object_id, section_code, uid, revit_id, "
    "category, family, type_name, mark, level_id, level_name, section_id, "
    "section_source, elevation_mm, height_mm, x, y, z, outline_json, "
    "outline_approx, volume, area, workset, params_json, is_current) "
    "VALUES (:object_id, :section_code, :uid, :revit_id, :category, :family, "
    ":type_name, :mark, :level_id, :level_name, :section_id, :section_source, "
    ":elevation_mm, :height_mm, :x, :y, :z, :outline_json, :outline_approx, "
    ":volume, :area, :workset, :params_json, 1) "
    "ON CONFLICT (object_id, uid) DO UPDATE SET "
    "category=excluded.category, type_name=excluded.type_name, "
    "level_id=excluded.level_id, "
    "level_name=excluded.level_name, section_id=excluded.section_id, "
    "section_source=excluded.section_source, elevation_mm=excluded.elevation_mm, "
    "height_mm=excluded.height_mm, outline_json=excluded.outline_json, "
    "outline_approx=excluded.outline_approx, area=excluded.area, "
    "params_json=excluded.params_json, "
    "is_current=1, updated_at=datetime('now')"
)


def _section_bbox(rooms: list, code: str):
    """Охват (x0,x1,y0,y1) в мм всех помещений секции `code` с известной
    секцией — используется как пролёт оси, раз сама линия оси на чертеже
    не извлекается (см. докстрока `app/pdf_rooms.py`). `None`, если у
    секции ещё нет ни одного помещения с определённой секцией."""
    pts = [(x, y) for r in rooms if r.section == code for x, y in r.polygon_mm]
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), max(xs), min(ys), max(ys)


def _apply_axis_grid(conn, object_id: int, rooms: list, axis_grid: dict, section_ids: dict) -> None:
    """Пишет оси здания (`object_grids`) и привязку секций к ним
    (`object_sections.axis_from/axis_to`) по подписям осей чертежа —
    иначе у объекта из PDF нет геометрии блока и «Блоки» не рисуются
    в 3D (`app/block_geometry.py`). Позиция оси — реальная (из подписи на
    листе), пролёт — фактический охват помещений своей секции (не сама
    линия оси — она не извлекается, см. докстрока `app/pdf_rooms.py`);
    для параллелепипеда блока этого достаточно, для точного контура — нет.

    `axis_from`/`axis_to` секции — две КРАЙНИЕ пронумерованные (вертикальные)
    оси этой секции; если их меньше двух, привязка не выставляется — блок
    остаётся без геометрии, как и раньше (`block_box` вернёт причину)."""
    if not axis_grid:
        return
    bbox_by_code = {code: _section_bbox(rooms, code) for code in section_ids}
    vertical_by_code = {code: [] for code in section_ids}
    for label, (направление, coord) in axis_grid.items():
        m = pdf_rooms._AXIS_RE.match(label)
        if not m:
            continue
        code = "С0" + m.group(2)
        bbox = bbox_by_code.get(code)
        if bbox is None:
            continue
        x0, x1, y0, y1 = bbox
        if направление == "x":
            line = (coord, y0, coord, y1)
            vertical_by_code[code].append((coord, label))
        else:
            line = (x0, coord, x1, coord)
        conn.execute(
            "INSERT INTO object_grids (object_id, label, kind, x1, y1, x2, y2) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT (object_id, label) DO UPDATE SET "
            "kind=excluded.kind, x1=excluded.x1, y1=excluded.y1, "
            "x2=excluded.x2, y2=excluded.y2",
            (object_id, label, направление) + line,
        )
    sections_with_axes = 0
    for code, section_id in section_ids.items():
        verticals = sorted(vertical_by_code.get(code) or [])
        if len(verticals) < 2:
            continue
        blocks_mod._set_section_axes(conn, object_id, section_id,
                                     verticals[0][1], verticals[-1][1])
        sections_with_axes += 1
    return sections_with_axes


def apply(conn, object_id: int, analysis: dict) -> dict:
    """Фаза 2: заводит секции/этажи/блоки, пишет помещения, оси и привязку
    секций к ним, списывает пропавшие.

    `revit_sections.fill_missing` (доопределение секции геометрией по
    зонам голосованием) сюда НЕ подключается — секция помещения уже
    известна из `pdf_rooms` напрямую, по границе подписей осей «…с1»/
    «…с2» на самом чертеже (Docs/TZ.md §3а), а не подобрана статистически."""
    rooms = analysis["_rooms"]
    walls = analysis.get("_walls") or []
    slabs = analysis.get("_slabs") or []
    filename = analysis.get("filename")
    floors, section_ids = _ensure_catalog(conn, object_id)
    rows = build_rows(rooms, floors, section_ids, filename)
    rows += build_wall_rows(walls, floors, section_ids, filename)
    rows += build_slab_rows(slabs, floors, filename)
    for r in rows:
        r["object_id"] = object_id
    conn.executemany(_INSERT, rows)
    sections_with_axes = _apply_axis_grid(
        conn, object_id, rooms, analysis.get("_axis_grid") or {}, section_ids)

    retired = analysis["_retired_uids"]
    if retired:
        conn.executemany(
            "UPDATE revit_elements SET is_current = 0, updated_at = datetime('now') "
            "WHERE object_id = ? AND uid = ?",
            [(object_id, uid) for uid in retired],
        )

    conn.commit()
    # Плиты — на весь этаж, без секции по устройству (build_slab_rows),
    # это не «не определилась», а «не применимо» — не считаем их в сводке
    # про неизвестную секцию, иначе 26 плит выглядели бы как брак разбора.
    sectioned = [r for r in rows if r["category"] != "Перекрытия"]
    known_section = sum(1 for r in sectioned if r["section_id"] is not None)
    windows_count = sum(1 for w in walls if w.category == "Окна")
    return {
        "rooms_written": len(rooms),
        "walls_written": len(walls) - windows_count,
        "windows_written": windows_count,
        "slabs_written": len(slabs),
        "retired": len(retired),
        "with_known_section": known_section,
        "section_unknown": len(sectioned) - known_section,
        "sections_with_axes": sections_with_axes,
    }


def remember_pending(analysis: dict) -> str:
    token = uuid.uuid4().hex
    _PENDING[token] = analysis
    while len(_PENDING) > _PENDING_LIMIT:
        _PENDING.pop(next(iter(_PENDING)))
    return token


def get_pending(token: str) -> dict:
    analysis = _PENDING.get(token)
    if analysis is None:
        raise PdfImportError(410, "Результат разбора уже недоступен (сервер "
                             "перезапускался или разбор устарел). Загрузите файл заново.")
    return analysis


def forget_pending(token: str) -> None:
    _PENDING.pop(token, None)


def _run_analyze_job(job_id: str, object_id: int, data: bytes, filename: str) -> None:
    """Тело фонового потока — своё соединение с БД, своё целиком (не
    расшаривается с потоком запроса, см. прецедент `app/activity.py`,
    `_worker`/`_run`): `analyze()` только читает, но sqlite3-соединение
    из другого потока использовать нельзя (`check_same_thread`)."""
    job = _JOBS[job_id]

    def on_progress(stage, page_number, processed, total):
        job["stage"] = stage
        job["page_number"] = page_number
        job["page"] = processed
        job["total"] = total

    conn = db_mod.get_connection()
    try:
        analysis = analyze(conn, object_id, data, filename, on_progress=on_progress)
    except (PdfImportError, pdf_rooms.PdfRoomsError) as e:
        job["status"] = "error"
        job["error"] = e.message
        job["error_status"] = getattr(e, "status_code", 422)
        return
    except Exception as e:
        job["status"] = "error"
        job["error"] = "Внутренняя ошибка разбора: %s" % e
        job["error_status"] = 500
        return
    finally:
        conn.close()

    token = remember_pending(analysis)
    job["status"] = "done"
    job["result"] = {
        "token": token,
        "object_id": object_id,
        "object_name": analysis["object_name"],
        "total_rooms": analysis["total_rooms"],
        "total_walls": analysis["total_walls"],
        "total_windows": analysis["total_windows"],
        "total_slabs": analysis["total_slabs"],
        "new": analysis["new"],
        "unchanged": analysis["unchanged"],
        "retiring": analysis["retiring"],
        "by_floor": analysis["by_floor"],
        "warnings": analysis["warnings"],
    }


def start_analyze_job(object_id: int, data: bytes, filename: str = None) -> str:
    """Запускает разбор в фоновом потоке, возвращает идентификатор задачи
    немедленно — файл уже прочитан (`data`) вызывающим кодом ДО этого
    вызова, пока соединение и `UploadFile` ещё живы в потоке запроса."""
    job_id = uuid.uuid4().hex
    _JOBS[job_id] = {"status": "running", "stage": "Открываю файл",
                     "page_number": None, "page": 0, "total": 0}
    while len(_JOBS) > _JOBS_LIMIT:
        _JOBS.pop(next(iter(_JOBS)))
    threading.Thread(
        target=_run_analyze_job, args=(job_id, object_id, data, filename), daemon=True,
    ).start()
    return job_id


def get_job(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if job is None:
        raise PdfImportError(410, "Задача разбора не найдена (сервер "
                             "перезапускался или задача устарела). Загрузите файл заново.")
    return job

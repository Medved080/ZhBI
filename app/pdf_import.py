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
"""

import json
import uuid

from app import blocks as blocks_mod
from app import pdf_rooms
from app.blocks import BlockError

_PENDING = {}
_PENDING_LIMIT = 3


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
    return int(floor), "этаж", None


def _ensure_section(conn, object_id: int, code: str) -> int:
    row = conn.execute(
        "SELECT id FROM object_sections WHERE object_id = ? AND code = ?",
        (object_id, code)).fetchone()
    if row:
        return row["id"]
    try:
        created = blocks_mod.create_section(conn, object_id, code)
    except BlockError:
        row = conn.execute(
            "SELECT id FROM object_sections WHERE object_id = ? AND code = ?",
            (object_id, code)).fetchone()
        return row["id"]
    return created["id"]


def _ensure_level(conn, object_id: int, floor_label: str) -> tuple:
    """Возвращает (level_id, key)."""
    floor_no, kind, name = _floor_spec(floor_label)
    key = "этаж:%d" % floor_no
    row = conn.execute(
        "SELECT id FROM object_levels WHERE object_id = ? AND key = ?",
        (object_id, key)).fetchone()
    if row:
        return row["id"], key
    try:
        created = blocks_mod.create_level(conn, object_id, kind, floor=floor_no, name=name)
    except BlockError:
        row = conn.execute(
            "SELECT id FROM object_levels WHERE object_id = ? AND key = ?",
            (object_id, key)).fetchone()
        return row["id"], key
    return created["id"], key


def _ensure_catalog(conn, object_id: int) -> tuple:
    """Секции и этажи объекта — идемпотентно. Возвращает (по_этажу,
    section_ids): по_этажу — {этаж-строка: (level_id, [section_id, ...])},
    section_ids — {"С01": id, "С02": id}."""
    section_ids = {code: _ensure_section(conn, object_id, code) for code in ("С01", "С02")}
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


def _floor_elevation(floor_label: str) -> tuple:
    for plan in pdf_rooms.FLOOR_PLANS:
        if plan.floor == floor_label:
            return plan.z0, plan.z1
    raise KeyError(floor_label)


def build_rows(rooms: list, floors: dict, section_ids: dict) -> list:
    """Помещения pdf_rooms.Room -> строки для revit_elements.

    Секция берётся из `room.section` — на этажах с единственной возможной
    секцией это она (проставлено в `pdf_rooms.parse_document`), на общих
    этажах (1-8) — определена по границе подписей осей «…с1»/«…с2»
    (Docs/TZ.md §3а). `None` бывает только если на листе не нашлось подписей
    обеих секций сразу — тогда честно остаётся неопределённой, не гадаем."""
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
            "level_name": ("этаж %s" % room.floor if room.floor.lstrip("-").isdigit()
                          else room.floor),
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
            "params_json": None,
        })
    return rows


def analyze(conn, object_id: int, data: bytes) -> dict:
    """Фаза 1: разбор файла и сверка. В БД не пишет ничего — даже
    справочники секций/этажей, они заводятся только в apply()."""
    doc = pdf_rooms.load(data)
    rooms, parse_warnings = pdf_rooms.parse_document(doc)
    if not rooms:
        raise PdfImportError(422, "В файле не нашлось ни одного помещения — "
                             "проверьте, тот ли это комплект чертежей.")

    row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
    object_name = row["name"] if row else ""

    existing = {
        r["uid"] for r in conn.execute(
            "SELECT uid FROM revit_elements WHERE object_id = ? "
            "AND section_code = 'PDF' AND is_current = 1", (object_id,))
    }
    seen = {"pdf:%s:%d" % (room.floor, room.index) for room in rooms}
    retired_uids = sorted(existing - seen)
    new_count = len(seen - existing)
    unchanged_count = len(seen & existing)

    by_floor = {}
    for room in rooms:
        s = by_floor.setdefault(room.floor, {"помещений": 0, "с площадью": 0})
        s["помещений"] += 1
        if room.area_m2 is not None:
            s["с площадью"] += 1

    return {
        "object_id": object_id,
        "object_name": object_name,
        "total_rooms": len(rooms),
        "new": new_count,
        "unchanged": unchanged_count,
        "retiring": len(retired_uids),
        "by_floor": by_floor,
        "warnings": parse_warnings,
        "_rooms": rooms,
        "_retired_uids": retired_uids,
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
    "category=excluded.category, level_id=excluded.level_id, "
    "level_name=excluded.level_name, section_id=excluded.section_id, "
    "section_source=excluded.section_source, elevation_mm=excluded.elevation_mm, "
    "height_mm=excluded.height_mm, outline_json=excluded.outline_json, "
    "outline_approx=excluded.outline_approx, area=excluded.area, "
    "is_current=1, updated_at=datetime('now')"
)


def apply(conn, object_id: int, analysis: dict) -> dict:
    """Фаза 2: заводит секции/этажи/блоки, пишет помещения, списывает
    пропавшие.

    `revit_sections.fill_missing` (доопределение секции геометрией по
    зонам голосованием) сюда НЕ подключается — секция помещения уже
    известна из `pdf_rooms` напрямую, по границе подписей осей «…с1»/
    «…с2» на самом чертеже (Docs/TZ.md §3а), а не подобрана статистически."""
    rooms = analysis["_rooms"]
    floors, section_ids = _ensure_catalog(conn, object_id)
    rows = build_rows(rooms, floors, section_ids)
    for r in rows:
        r["object_id"] = object_id
    conn.executemany(_INSERT, rows)

    retired = analysis["_retired_uids"]
    if retired:
        conn.executemany(
            "UPDATE revit_elements SET is_current = 0, updated_at = datetime('now') "
            "WHERE object_id = ? AND uid = ?",
            [(object_id, uid) for uid in retired],
        )

    conn.commit()
    known_section = sum(1 for r in rows if r["section_id"] is not None)
    return {
        "rooms_written": len(rows),
        "retired": len(retired),
        "with_known_section": known_section,
        "section_unknown": len(rows) - known_section,
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

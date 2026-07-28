"""
Импорт графика МС Project ("Прогноз СМР.xlsx", см. Docs/backlog.md,
"Контрактация 2.0", п.5/6). Реальная структура образца: колонки
Тип и Подтип/Начало/Окончание/Кран/Захватка/Стоянка/Этаж — каждая строка
описывает блок работ для комбинации Кран+Стоянка+Этаж+Тип+Подтип. Всем
элементам, физически попадающим в этот блок, проставляются два новых
поля: project_delivery_date (из "Окончание" — по этой дате элемент должен
физически быть на площадке) и project_smr_start_date (из "Начало" —
начало СМР по этому блоку).

"Захватка" читается, но не участвует в сопоставлении (стоянка уже
однозначно определяет захватку в текущих данных — живое решение
пользователя).

"Тип и Подтип" — свободный текст ("Колонна нижняя", "Панелей лифтовой
шахты до отм. +15.000" — родительный падеж от "Панель"), не совпадает
буквально со словарём element_type/subtype — используется ЗАКРЫТЫЙ список
алиасов (TYPE_SUBTYPE_ALIASES), а не парсер общего вида: строка, которой
нет в списке, попадает в сводку как unmatched, не угадывается.

Кран/Стоянка сопоставляются элементу ЧЕРЕЗ его собственные
zone_crane_id/zone_stance_id (см. app/db.py) — зоны с одинаковым именем
повторяются в каждом source_file, сравнение "в лоб" по имени зоны было бы
неоднозначным без привязки к конкретному элементу.
"""

import io
import re
from datetime import date, datetime
from typing import Optional

from openpyxl import load_workbook

REQUIRED_HEADERS = ["Тип и Подтип", "Начало", "Окончание", "Кран", "Захватка", "Стоянка", "Этаж"]

# Полный список из образца "Прогноз СМР.xlsx" (18 уникальных строк) —
# элевационный суффикс "до отм. +X" у Панели намеренно ОТБРОШЕН при
# сопоставлении с подтипом: он избыточен с колонкой Этаж (проверено на
# примере — 3 строки на разных этажах с одним и тем же suffix-набором
# субтипа). Строка, которой здесь нет, попадает в unmatched_type_subtype
# сводки импорта — не гадаем.
TYPE_SUBTYPE_ALIASES: dict[str, tuple[str, str]] = {
    "Колонна нижняя": ("Колонна", "нижняя"),
    "Колонна верхняя": ("Колонна", "верхняя"),
    "Колонна средняя, нижний ярус": ("Колонна", "средняя нижний ярус"),
    "Колонна средняя, верхний ярус": ("Колонна", "средняя верхний ярус"),
    "Ригель периметральный": ("Ригель", "периметральный"),
    "Ригель на отм. +15.000": ("Ригель", "на отм. +15.000"),
    "Ригель на отм. +25.800": ("Ригель", "на отм. +25.800"),
    "Ригель на отм. +34.700": ("Ригель", "на отм. +34.700"),
    "Плита перекрытия на отм. +15.000": ("Плита перекрытия", "на отм. +15.000"),
    "Плита перекрытия на отм. +25.800": ("Плита перекрытия", "на отм. +25.800"),
    "Плита перекрытия на отм. +34.700": ("Плита перекрытия", "на отм. +34.700"),
    "Плита перекрытия на отм. +39.700": ("Плита перекрытия", "на отм. +39.700"),
    "Панелей лифтовой шахты до отм. +15.000": ("Панель", "ЛифтоваяШахта"),
    "Панелей лифтовой шахты до отм. +25.800": ("Панель", "ЛифтоваяШахта"),
    "Панелей лифтовой шахты до отм. +34.700": ("Панель", "ЛифтоваяШахта"),
    "Панелей шахты подъемника до отм. +15.000": ("Панель", "ШахтаПодъемника"),
    "Панелей шахты подъемника до отм. +25.800": ("Панель", "ШахтаПодъемника"),
    "Панелей шахты подъемника до отм. +34.700": ("Панель", "ШахтаПодъемника"),
}

_CRANE_NUMBER_RE = re.compile(r"(\d+)")
_TRAILING_NUMBER_RE = re.compile(r"(\d+)\s*$")


class ScheduleImportError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _normalize_type_subtype(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.strip())


def _extract_number(raw, pattern: re.Pattern) -> Optional[int]:
    if raw is None:
        return None
    m = pattern.search(str(raw).strip())
    return int(m.group(1)) if m else None


# В реальном образце "Начало"/"Окончание" — ТЕКСТ вида "Ср 01.07.26"
# (день недели + дата, двузначный год), не datetime-значение — так
# MS Project экспортирует даты задач по умолчанию. День недели —
# избыточная информация, отбрасывается регэкспом перед разбором.
_WEEKDAY_PREFIX_RE = re.compile(r"^[А-Яа-я]{2}\s+")


def _to_date_iso(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = _WEEKDAY_PREFIX_RE.sub("", str(value).strip())
    for fmt in ("%d.%m.%y", "%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_schedule_xlsx(content: bytes) -> dict:
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception:
        raise ScheduleImportError(422, "Файл повреждён или не является корректным .xlsx")

    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header = next(rows_iter)
    except StopIteration:
        raise ScheduleImportError(422, "Пустой файл")

    header = [str(h).strip() if h is not None else "" for h in header]
    missing = [h for h in REQUIRED_HEADERS if h not in header]
    if missing:
        raise ScheduleImportError(422, f"В файле нет обязательных колонок: {', '.join(missing)}")
    col = {name: idx for idx, name in enumerate(header)}

    def get(row, name):
        idx = col.get(name)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    parsed = []
    skipped_rows = []
    row_num = 1
    for row in rows_iter:
        row_num += 1
        type_subtype_raw = get(row, "Тип и Подтип")
        if type_subtype_raw is None or not str(type_subtype_raw).strip():
            continue  # пустая строка — пропуск, не ошибка (не конец таблицы, просто разделитель)

        normalized = _normalize_type_subtype(str(type_subtype_raw))
        element_type, subtype = TYPE_SUBTYPE_ALIASES.get(normalized, (None, None))

        start_date = _to_date_iso(get(row, "Начало"))
        end_date = _to_date_iso(get(row, "Окончание"))
        crane_number = _extract_number(get(row, "Кран"), _CRANE_NUMBER_RE)
        stance_number = _extract_number(get(row, "Стоянка"), _TRAILING_NUMBER_RE)
        floor_number = _extract_number(get(row, "Этаж"), _TRAILING_NUMBER_RE)

        problems = []
        if element_type is None:
            problems.append(f"тип/подтип «{normalized}» не распознан")
        if end_date is None:
            problems.append("не удалось разобрать дату «Окончание»")
        if crane_number is None:
            problems.append("не удалось разобрать номер крана")
        if stance_number is None:
            problems.append("не удалось разобрать номер стоянки")
        if floor_number is None:
            problems.append("не удалось разобрать номер этажа")

        if problems:
            skipped_rows.append(f"Строка {row_num}: {'; '.join(problems)}")
            continue

        parsed.append(
            {
                "row": row_num,
                "type_subtype_raw": normalized,
                "element_type": element_type,
                "subtype": subtype,
                "project_smr_start_date": start_date,
                "project_delivery_date": end_date,
                "crane_number": crane_number,
                "stance_number": stance_number,
                "floor": floor_number,
            }
        )

    return {"rows": parsed, "skipped_rows": skipped_rows}


def import_schedule(conn, parsed: dict) -> dict:
    rows = parsed["rows"]
    matched_elements_total = 0
    unmatched_blocks: list[str] = []
    touched_element_ids: set[int] = set()

    for row in rows:
        candidates = conn.execute(
            """
            SELECT e.id, zc.name AS crane_name, zs.name AS stance_name
            FROM elements e
            LEFT JOIN zones zc ON zc.id = e.zone_crane_id AND e.zone_crane_status = 'matched'
            LEFT JOIN zones zs ON zs.id = e.zone_stance_id AND e.zone_stance_status = 'matched'
            WHERE e.floor = ? AND e.element_type = ? AND e.subtype IS ?
            """,
            (row["floor"], row["element_type"], row["subtype"]),
        ).fetchall()

        matched_ids = [
            c["id"]
            for c in candidates
            if _extract_number(c["crane_name"], _CRANE_NUMBER_RE) == row["crane_number"]
            and _extract_number(c["stance_name"], _TRAILING_NUMBER_RE) == row["stance_number"]
        ]

        if not matched_ids:
            unmatched_blocks.append(
                f"Кран {row['crane_number']}/Стоянка {row['stance_number']}/Этаж {row['floor']}/"
                f"{row['type_subtype_raw']} — ни один элемент не найден"
            )
            continue

        conn.executemany(
            "UPDATE elements SET project_delivery_date = ?, project_smr_start_date = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            [(row["project_delivery_date"], row["project_smr_start_date"], eid) for eid in matched_ids],
        )
        matched_elements_total += len(matched_ids)
        touched_element_ids.update(matched_ids)

    conn.commit()

    return {
        "rows_processed": len(rows),
        "rows_skipped": len(parsed["skipped_rows"]),
        "skipped_rows": parsed["skipped_rows"][:50],
        "elements_updated": len(touched_element_ids),
        "unmatched_blocks": unmatched_blocks,
    }

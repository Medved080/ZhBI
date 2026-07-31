"""
Массовая правка ИСТОРИИ СТАТУСОВ через Excel (2026-08-01, живой запрос).

Второй режим той же формы, что и правка реквизитов
(app/element_bulk_edit.py): выгрузить -> поправить снаружи -> загрузить ->
отметить флажками, что применить. Отдаёт и принимает те же структуры
(columns/elements/changes/rejected), поэтому табличный экран подтверждения
переиспользуется целиком, без второй реализации.

**Форма выгрузки — МАТРИЦА, а не по строке на событие.** Колонка на каждый
статус, в ячейке — дата. Причина не в красоте: правило, которое просил
проверять пользователь («если более поздний статус пытаются загрузить
раньше предыдущего — ошибка»), в матрице выражается прямо (даты обязаны не
убывать вдоль жизненного цикла), а в списке событий его пришлось бы
восстанавливать группировкой. Плюс править сроки по элементу в одной
строке несравнимо удобнее, чем искать его события по всему файлу.

Матрица не умеет представить ПОВТОР статуса — а он бывает: откат на
«Запланирован» после инцидента создаёт вторую запись того же статуса. На
боевой базе таких элементов три из 9422. Они выгружаются (с датой ПОСЛЕДНЕЙ
записи каждого статуса) и помечаются в отдельной колонке, а при загрузке их
правки отклоняются: молча переписать одну из двух записей — значит solver
угадать за пользователя, какую именно.

**Пустая ячейка = не трогать, а НЕ удалить запись.** Та же логика, что у
контракта в правке реквизитов: удаление события — это отдельное осознанное
действие, а пустая ячейка в Excel слишком дёшева, её ставят случайно.

**Автоматически другие статусы не меняются** (прямое указание
пользователя): проставили дату «Отгружен» — меняется только она. Никаких
«раз отгружен, значит и произведён».
"""

import io
from typing import Optional

from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter

from app import activity
from app.contracts import recompute_status_and_actual_date, sync_element_contract
from app.history_import import normalize_changed_at
from app.models import STATUS_LABELS_RU, STATUS_ORDER

SHEET_DATA = "Статусы"
SHEET_STATUSES = "Справочник статусов"
SHEET_OBJECTS = "Объекты"
KEY_COLUMN = "element_uid"
LOCKED_COLUMN = "locked_reason"

# Порядок жизненного цикла — он же порядок колонок и он же основание для
# проверки последовательности. Один список, а не три: разойдясь, они дали бы
# проверку, не соответствующую тому, что человек видит в файле.
STATUS_KEYS = [s.value for s in STATUS_ORDER]
STATUS_TITLES = {s.value: STATUS_LABELS_RU[s] for s in STATUS_ORDER}

# Время суток для НОВОЙ записи. Полдень, а не полночь: записи, созданные
# импортом чертежа, несут реальное время, и событие в 00:00 того же дня
# оказалось бы раньше них (та же причина, что в массовой контрактации).
NEW_RECORD_TIME = "12:00:00"

_HEAD_COLUMNS = [
    (KEY_COLUMN, "UID (не менять)"),
    ("object_name", "Объект"),
    ("element_type", "Тип элемента"),
    ("subtype", "Подтип"),
    ("mark", "Марка"),
    ("address", "Адрес по осям"),
    ("current_status", "Текущий статус"),
]


def columns_spec() -> list:
    cols = [{"key": k, "label": l, "editable": False} for k, l in _HEAD_COLUMNS]
    cols += [{"key": k, "label": STATUS_TITLES[k], "editable": True} for k in STATUS_KEYS]
    cols.append({"key": LOCKED_COLUMN, "label": "Правка запрещена", "editable": False})
    return cols


def _load(conn) -> tuple[list, dict]:
    """Элементы и их история одним проходом. Два запроса, а не запрос истории
    на каждый элемент: на 9422 строках это тот же N+1, что уже стоил проекту
    2,7 секунды на другой форме."""
    rows = conn.execute(
        """
        SELECT e.id, e.element_uid, e.element_type, e.subtype, e.mark, e.address,
               e.current_status, o.name AS object_name
        FROM elements e LEFT JOIN objects o ON o.id = e.object_id
        WHERE e.is_current = 1 AND e.element_uid IS NOT NULL
        ORDER BY o.name, e.element_type, e.mark, e.id
        """
    ).fetchall()
    history: dict = {}
    for h in conn.execute(
        "SELECT element_id, status, changed_at, id FROM status_history ORDER BY changed_at, id"
    ):
        history.setdefault(h["element_id"], []).append(dict(h))
    return rows, history


def _element_state(row, records: list) -> dict:
    """Значения одной строки матрицы: даты по статусам + причина запрета
    правки, если статус повторяется."""
    by_status: dict = {}
    repeated = set()
    for rec in records:
        if rec["status"] in by_status:
            repeated.add(rec["status"])
        # ПОСЛЕДНЯЯ запись статуса (список уже отсортирован по дате)
        by_status[rec["status"]] = rec
    values = {key: row[key] for key, _ in _HEAD_COLUMNS}
    # Статус — ПОДПИСЬЮ, как в интерфейсе, а не кодом (живой запрос
    # 2026-08-01): человек, открывший файл, читает «Смонтирован», а не
    # «installed». Колонка справочная, обратно не разбирается, поэтому
    # достаточно подписи.
    values["current_status"] = STATUS_TITLES.get(row["current_status"], row["current_status"])
    for key in STATUS_KEYS:
        rec = by_status.get(key)
        values[key] = rec["changed_at"][:10] if rec else None
    values[LOCKED_COLUMN] = (
        "несколько записей статуса: " + ", ".join(STATUS_TITLES[s] for s in sorted(repeated))
        if repeated else None
    )
    return values


def build_status_workbook(conn) -> Workbook:
    rows, history = _load(conn)
    cols = columns_spec()
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_DATA
    ws.append([c["label"] for c in cols])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}1"
    for row in rows:
        values = _element_state(row, history.get(row["id"], []))
        ws.append([values[c["key"]] for c in cols])
    _widen(ws)

    # Справочные листы — как в режиме реквизитов (живой запрос 2026-08-01).
    # Правимые ячейки здесь ДАТЫ, выбирать из списка нечего, поэтому полезен
    # другой справочник: порядок жизненного цикла. Именно его проверяет
    # загрузка («более поздний статус не может быть раньше предыдущего»), и
    # без него правило приходится держать в голове.
    ws_s = wb.create_sheet(SHEET_STATUSES)
    ws_s.append(["№ в цикле", "Статус", "Колонка в листе «Статусы»"])
    for n, key in enumerate(STATUS_KEYS, start=1):
        ws_s.append([n, STATUS_TITLES[key], STATUS_TITLES[key]])
    ws_s.append([])
    ws_s.append(["Даты в листе «Статусы» не должны убывать сверху вниз по этому порядку."])
    ws_s.append(["Пустая ячейка означает «не трогать», а не «удалить запись»."])
    _widen(ws_s)

    ws_o = wb.create_sheet(SHEET_OBJECTS)
    ws_o.append(["Объект", "Описание"])
    for r in conn.execute("SELECT name, COALESCE(description,'') AS description FROM objects ORDER BY name"):
        ws_o.append([r["name"], r["description"]])
    _widen(ws_o)
    return wb


def _widen(ws) -> None:
    for i, column in enumerate(ws.iter_cols(), start=1):
        width = max((len(str(c.value)) for c in column if c.value is not None), default=10)
        ws.column_dimensions[get_column_letter(i)].width = min(max(width + 2, 12), 45)


def _read_sheet(file_bytes: bytes) -> list:
    wb = load_workbook(io.BytesIO(file_bytes), data_only=True)
    if SHEET_DATA not in wb.sheetnames:
        raise ValueError(f"В файле нет листа «{SHEET_DATA}». "
                         f"Загружайте тот файл, который выгрузила система в режиме «История статусов».")
    ws = wb[SHEET_DATA]
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise ValueError(f"Лист «{SHEET_DATA}» пуст")
    label_to_key = {c["label"]: c["key"] for c in columns_spec()}
    index = {}
    for i, cell in enumerate(header):
        key = label_to_key.get(str(cell).strip() if cell is not None else "")
        if key:
            index[key] = i
    if KEY_COLUMN not in index:
        raise ValueError("В файле нет колонки «UID (не менять)» — строки не с чем сопоставить.")
    out = []
    for n, raw in enumerate(rows, start=2):
        if all(v is None or (isinstance(v, str) and not v.strip()) for v in raw):
            continue
        out.append((n, {key: (raw[i] if i < len(raw) else None) for key, i in index.items()}))
    return out


def _sequence_error(dates: dict) -> Optional[str]:
    """Проверка порядка: даты не должны убывать вдоль жизненного цикла.

    Считается по ИТОГОВОМУ состоянию — то, что уже в базе, плюс то, что
    пришло файлом. Проверять только файл было бы дырой: «Смонтирован»
    раньше уже существующего «Отгружен» — ровно то нарушение, о котором
    просил сообщать, и в файле при этом одна строка.

    Пропуски допустимы: элемент мог не проходить «Контрактацию» явно.
    Сравниваются только заполненные статусы, в порядке цикла.
    """
    filled = [(k, dates[k]) for k in STATUS_KEYS if dates.get(k)]
    for i in range(1, len(filled)):
        (prev_key, prev_date), (key, date) = filled[i - 1], filled[i]
        if date < prev_date:
            return (f"«{STATUS_TITLES[key]}» ({date}) раньше, чем "
                    f"«{STATUS_TITLES[prev_key]}» ({prev_date}) — нарушен порядок статусов")
    return None


def analyze(conn, file_bytes: bytes) -> dict:
    parsed = _read_sheet(file_bytes)
    rows, history = _load(conn)
    by_uid = {r["element_uid"]: r for r in rows}

    changes, rejected, touched_values = [], [], {}
    seen = set()
    for line_no, values in parsed:
        uid = values.get(KEY_COLUMN)
        uid = str(uid).strip() if uid is not None else ""
        if not uid:
            rejected.append({"line": line_no, "reason": "Пустой UID — строку не с чем сопоставить"})
            continue
        if uid in seen:
            rejected.append({"line": line_no, "uid": uid,
                             "reason": "UID повторяется в файле — какую из строк применять, неизвестно"})
            continue
        seen.add(uid)
        row = by_uid.get(uid)
        if row is None:
            rejected.append({"line": line_no, "uid": uid,
                             "reason": "Элемент с таким UID не найден среди актуальных"})
            continue

        records = history.get(row["id"], [])
        current = _element_state(row, records)
        if current[LOCKED_COLUMN]:
            # Повтор статуса: какую из двух записей править — неизвестно, и
            # угадывать за пользователя нельзя.
            proposed_any = any(
                _coerce_date(values.get(k)) not in (None, current[k]) for k in STATUS_KEYS
                if k in values
            )
            if proposed_any:
                rejected.append({"line": line_no, "uid": uid,
                                 "reason": f"У элемента {current[LOCKED_COLUMN]}. Историю такого "
                                           f"элемента правьте в карточке элемента."})
            continue

        item, bad = [], None
        merged = {k: current[k] for k in STATUS_KEYS}
        for key in STATUS_KEYS:
            if key not in values:
                continue
            try:
                new = _coerce_date(values[key])
            except ValueError as exc:
                bad = str(exc)
                break
            if new is None or new == current[key]:
                continue   # пустая ячейка — не трогать, а не удалить
            merged[key] = new
            item.append((key, current[key], new))
        if bad:
            rejected.append({"line": line_no, "uid": uid, "reason": bad})
            continue
        if not item:
            continue

        err = _sequence_error(merged)
        if err:
            rejected.append({"line": line_no, "uid": uid, "reason": err})
            continue

        touched_values[row["id"]] = {"element_id": row["id"], "uid": uid, "values": current}
        for key, was, now in item:
            changes.append({
                "element_id": row["id"], "uid": uid, "line": line_no,
                "mark": row["mark"], "element_type": row["element_type"],
                "field": key, "column": key, "field_label": STATUS_TITLES[key],
                "was": was, "now": now,
                "is_new": was is None,
            })

    return {
        "rows_read": len(parsed),
        "elements_touched": len(touched_values),
        "columns": columns_spec(),
        "elements": list(touched_values.values()),
        "changes": changes,
        "rejected": rejected,
    }


def _coerce_date(raw) -> Optional[str]:
    """Ячейка -> 'ГГГГ-ММ-ДД'. Принимает и настоящую дату Excel, и текст:
    openpyxl отдаёт первое, если ячейка так отформатирована, и второе, если
    её набрали руками."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    stamp = normalize_changed_at(raw)
    if not stamp:
        raise ValueError(f"Не удалось разобрать дату «{raw}» — ожидается ГГГГ-ММ-ДД")
    return stamp[:10]


def apply_changes(conn, selections: list, user_name: str, user_id: Optional[int]) -> dict:
    """Применяет отмеченные правки дат статусов.

    Каждая правка — либо UPDATE даты существующей записи, либо INSERT новой.
    Время суток существующей записи СОХРАНЯЕТСЯ: пользователь правил дату, а
    не время, и обнулять его до полуночи значило бы менять порядок событий
    внутри дня без его ведома.

    Другие статусы не трогаются (прямое указание пользователя) — меняется
    ровно то, что отмечено.
    """
    by_element: dict = {}
    for sel in selections:
        by_element.setdefault(int(sel["element_id"]), []).append(sel)

    applied, inserted, updated, skipped = 0, 0, 0, []
    for element_id, items in by_element.items():
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            skipped.append({"element_id": element_id, "reason": "Элемент исчез между сверкой и применением"})
            continue
        touched = []
        for sel in items:
            status, date = sel["field"], sel.get("now")
            if not date:
                continue
            rec = conn.execute(
                "SELECT id, changed_at FROM status_history WHERE element_id = ? AND status = ? "
                "ORDER BY changed_at DESC, id DESC LIMIT 1",
                (element_id, status),
            ).fetchone()
            if rec is None:
                conn.execute(
                    "INSERT INTO status_history (element_id, status, changed_at, changed_by, "
                    "changed_by_user_id, comment) VALUES (?, ?, ?, ?, ?, ?)",
                    (element_id, status, f"{date} {NEW_RECORD_TIME}", user_name, user_id,
                     "Массовая правка истории через Excel"),
                )
                inserted += 1
            else:
                time_part = (rec["changed_at"][11:] or NEW_RECORD_TIME)
                conn.execute(
                    "UPDATE status_history SET changed_at = ? WHERE id = ?",
                    (f"{date} {time_part}", rec["id"]),
                )
                updated += 1
            touched.append(f"{STATUS_TITLES[status]}: {date}")

        if not touched:
            continue
        # Текущий статус и фактическая дата — производные от истории, их
        # обязательно пересчитать: правка дат меняет, какая запись самая
        # поздняя. Контракт следом — инвариант «Запланирован ⇒ контракт пуст».
        effective, _ = recompute_status_and_actual_date(conn, element_id)
        sync_element_contract(conn, element_id, effective)
        applied += 1
        activity.log(
            "status_bulk_edit", user_name=user_name, user_id=user_id,
            entity_type="element", entity_id=element_id,
            element_type=row["element_type"], subtype=row["subtype"], mark=row["mark"],
            new_value="; ".join(touched)[:500],
            details={"source": "xlsx", "effective_status": effective},
        )

    conn.commit()
    return {"elements_updated": applied, "records_inserted": inserted,
            "records_updated": updated, "skipped": skipped}

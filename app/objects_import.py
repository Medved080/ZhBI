"""
Импорт справочника объектов из Excel «Объекты на карте» (2026-09-08, живой
запрос: «Сделай механизм загрузки справочника объектов из этого файла по
той же схеме что и другие загрузки — распиши процесс по шагам с
обязательным подтверждением внесения изменений в уже внесённые в систему
объекты»).

Тот же двухшаговый механизм без серверного состояния, что у
app/element_bulk_edit.py («Семья B» из исследования архитектуры): analyze()
ничего не пишет и возвращает построчные расхождения, apply() получает
обратно ТЕ ЖЕ расхождения, отфильтрованные флажками, и заново файл не
читает — применяют ровно то, что видели на экране подтверждения.

Ключ сопоставления строки — НАИМЕНОВАНИЕ (решение пользователя 2026-09-07,
"По наименованию. На одном адресе может быть несколько объектов
(очередей)"): адрес не подходит, колонка «№» в файле не сплошная и явно
отклонена пользователем как ключ.

Проект для НОВОГО объекта — создаётся автоматически с тем же названием,
что и объект (решение пользователя 2026-09-08, «Один объект = один
проект»): в файле нет колонки «Проект», и объекты реестра — самостоятельные
площадки, а не корпуса одной стройки.

Фото/видео (колонка «Фото/Видео») — ссылка на ПАПКУ Яндекс.Диска, не на
файл; сохраняется как текст в objects.media_url, сервер её НЕ скачивает
(решение пользователя: «Ссылку сохраняем, фото — вручную») — фото
прикладывают вручную существующим механизмом вложений (см. Docs/TZ.md
§6.3.1д).

Статус (колонка «Статус ОС») маппится 1:1 на технический статус объекта:
файл использует свою шкалу «Активный/Завершен/Перспективный/Приостановлен»,
и она СМЭПЛЕНА на техническую (решение пользователя 2026-09-07, «Смэпить на
технический статус и дополнить статусами Перспективный и Архивный» +
уточнение «Пятый статус: „Приостановлен“ отдельно»). «Архивный» в файле не
встречается — это исключительно ручное действие после закрытия объекта.

Адрес из файла — текст без кода классификатора: колонка в файле не несёт
кода КЛАДР, а разложить строку по нему пытается ЭТОТ модуль сам
(`app.kladr.resolve_free_text_address`, 2026-09-08, живой запрос «при
загрузке из xls надо по возможности разложить по адресному
классификатору») — тот же уровень (населённый пункт → улица → дом), что
у интерактивного виджета, но автоматически и строго консервативно: только
точное совпадение имени, при малейшей неоднозначности — обычный текст, а
не подозрительная привязка. Если объект уже привязан к классификатору
(`address_code` заполнен), правка адреса из файла ИГНОРИРУЕТСЯ — иначе
строка потеряла бы связь с классификатором, а `address` и `address_code`
разошлись бы. Привязка по классификатору — ОДНО бундлированное изменение
(`kind: "address_link"`), а не набор независимых полей: применить «Адрес»,
но не «address_code», значило бы разорвать пару текст/код, которую вся
остальная система считает согласованной.

Широта/долгота в файле УЖЕ есть готовыми числами — геокодирование по адресу
(app/project_map.py) не требуется, они идут прямыми полями.
"""

import io
import json
from datetime import date, datetime
from typing import Optional

from openpyxl import load_workbook

from app import activity
from app.kladr import region_from_address, resolve_free_text_address

# --------------------------------------------------------------- колонки

# (внутренний ключ, подпись в файле). Сопоставление — по ПОДПИСИ, а не по
# порядку колонок: тот же приём, что у app/element_bulk_edit.py — человек
# вправе переставить или скрыть колонки, файл от этого не должен стать
# нечитаемым.
_COLUMN_LABELS = [
    ("name", "Наименование ОС"),
    ("address", "Адрес"),
    ("smu", "СМУ"),
    ("smu_director", "Директор СМУ"),
    ("responsible", "ДП / РП"),
    ("status_raw", "Статус ОС"),
    ("lat", "Широта"),
    ("lon", "Долгота"),
    ("media_url", "Фото/Видео"),
    ("smr_start_reported", "Старт СМР"),
]

KEY_COLUMN = "name"

FIELD_LABELS = {
    "address": "Адрес",
    "address_region": "Регион (по адресу)",
    "smu": "СМУ",
    "smu_director": "Директор СМУ",
    "responsible": "Ответственный (ДП/РП)",
    "status": "Статус",
    "lat": "Широта",
    "lon": "Долгота",
    "media_url": "Ссылка на фото/видео",
    "smr_start_reported": "Старт СМР",
}

# Поля, которые apply() разрешено записывать UPDATE'ом. Имя поля приходит из
# клиентского JSON и попадает в `SET {поле} = ...` — тот же класс риска, что
# у element_bulk_edit.apply_changes (см. его докстрок про белый список),
# закрывается тем же способом: только то, что реально есть в этом перечне.
_UPDATE_FIELDS = frozenset(FIELD_LABELS)

# Поля бандла "address_link" (см. _build_update) — своя, более узкая
# проверка: это данные, собранные resolve_free_text_address() внутри
# analyze(), а не то, что человек мог отметить построчно, но клиент к
# apply() приходит тем же JSON, и доверять ему нельзя так же, как любому
# другому телу запроса.
_ADDRESS_LINK_FIELDS = frozenset(
    {"address", "address_code", "address_source", "address_region", "address_parts", "postal_code"})

# «Статус ОС» в файле → технический статус объекта (CATALOG_STATUSES).
# «Архивный» сюда не входит: в файле заказчика его не бывает.
_STATUS_MAP = {
    "активный": "active",
    "перспективный": "perspective",
    "приостановлен": "suspended",
    "завершен": "completed",
    "завершён": "completed",
}


class ObjectsImportError(Exception):
    pass


# ------------------------------------------------------------- разбор ячеек

def _clean_text(raw) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _parse_status(raw) -> tuple:
    """(ключ_статуса | None, предупреждение | None). Пусто в файле — не
    предупреждение, это «не заполнено», а не «не распознано»."""
    text = _clean_text(raw)
    if text is None:
        return None, None
    key = _STATUS_MAP.get(text.lower())
    if key is None:
        return None, (
            "статус «%s» не распознан (ожидается: %s)"
            % (text, ", ".join(sorted(set(_STATUS_MAP)))))
    return key, None


def _parse_coord(raw) -> tuple:
    """(число | None, ошибка | None)."""
    if raw is None or raw == "":
        return None, None
    try:
        return round(float(raw), 6), None
    except (TypeError, ValueError):
        return None, "не число «%s»" % raw


_DATE_FORMATS = ("%d.%m.%Y", "%d.%m.%y")


def _parse_date_cell(raw) -> tuple:
    """(дата ГГГГ-ММ-ДД | None, ошибка | None). Ячейка Excel с типом
    даты приходит объектом datetime/date — тот же случай, что разбирает
    app/history_import.normalize_changed_at."""
    if raw is None:
        return None, None
    if isinstance(raw, datetime):
        return raw.date().isoformat(), None
    if isinstance(raw, date):
        return raw.isoformat(), None
    text = _clean_text(raw)
    if text is None:
        return None, None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat(), None
        except ValueError:
            continue
    return None, "не удалось разобрать дату «%s»" % text


# ------------------------------------------------------------- чтение файла

def _read_sheet(file_bytes: bytes) -> list:
    try:
        wb = load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    except Exception:
        raise ObjectsImportError("Файл повреждён или не является корректным .xlsx")
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise ObjectsImportError("Пустой файл")

    label_to_key = {label: key for key, label in _COLUMN_LABELS}
    index = {}
    for i, cell in enumerate(header):
        key = label_to_key.get(str(cell).strip() if cell is not None else "")
        if key:
            index[key] = i
    if KEY_COLUMN not in index:
        raise ObjectsImportError(
            "В файле нет колонки «Наименование ОС» — без неё строки не с чем сопоставить.")

    out = []
    for n, raw in enumerate(rows, start=2):
        if all(v is None or (isinstance(v, str) and not v.strip()) for v in raw):
            continue
        out.append((n, {key: (raw[i] if i < len(raw) else None) for key, i in index.items()}))
    return out


# ------------------------------------------------------------------ analyze

def analyze(conn, file_bytes: bytes) -> dict:
    """Сверяет файл со справочником. Ничего не пишет.

    Для строки, чьё наименование уже есть в базе, — построчные расхождения
    полей (как у element_bulk_edit). Для строки с новым наименованием —
    ОДНА запись "создать объект со следующими полями": разбивать создание
    на отдельные флажки по полю смысла не несёт, объект либо заводят, либо
    нет целиком.
    """
    parsed = _read_sheet(file_bytes)
    existing = {r["name"]: r for r in conn.execute("SELECT * FROM objects")}

    changes, rejected, warnings = [], [], []
    seen = set()
    for line_no, values in parsed:
        name = _clean_text(values.get(KEY_COLUMN))
        if not name:
            rejected.append({"line": line_no, "reason": "Пустое наименование — строку не с чем сопоставить"})
            continue
        if name in seen:
            rejected.append({"line": line_no, "name": name,
                             "reason": "Наименование повторяется в файле — какую из строк применять, неизвестно"})
            continue
        seen.add(name)

        row = existing.get(name)
        if row is None:
            change, row_warnings = _build_create(line_no, name, values)
            changes.append(change)
            warnings.extend(row_warnings)
        else:
            row_changes, row_warnings = _build_update(row, line_no, values)
            changes.extend(row_changes)
            warnings.extend(row_warnings)

    return {
        "rows_read": len(parsed),
        "objects_new": sum(1 for c in changes if c["kind"] == "create"),
        "objects_updated": len({c["object_id"] for c in changes if c["kind"] in ("update", "address_link")}),
        "changes": changes,
        "rejected": rejected,
        "warnings": warnings,
    }


def _build_create(line_no: int, name: str, values: dict) -> tuple:
    warnings = []
    fields = {}

    address = _clean_text(values.get("address"))
    if address:
        # Разложить по классификатору — чистая прибавка для НОВОГО объекта
        # (не UPDATE, ломать нечего): не вышло уверенно — тот же текст и
        # регион по нему офлайн, что и раньше.
        разложено = resolve_free_text_address(address)
        if разложено:
            fields["address"] = разложено["address"]
            fields["address_code"] = разложено["code"]
            fields["address_source"] = разложено["source"]
            fields["address_region"] = разложено["region"]
            fields["address_parts"] = json.dumps(разложено["parts"], ensure_ascii=False)
            if разложено.get("postal_code"):
                fields["postal_code"] = разложено["postal_code"]
        else:
            fields["address"] = address
            регион = region_from_address(address)
            if регион:
                fields["address_region"] = регион

    for key in ("smu", "smu_director", "responsible", "media_url"):
        v = _clean_text(values.get(key))
        if v is not None:
            fields[key] = v

    статус, предупреждение = _parse_status(values.get("status_raw"))
    if предупреждение:
        warnings.append({"line": line_no, "name": name, "reason": предупреждение + " — принят «В работе»"})
    fields["status"] = статус or "active"

    for key in ("lat", "lon"):
        значение, ошибка = _parse_coord(values.get(key))
        if ошибка:
            warnings.append({"line": line_no, "name": name,
                             "reason": "%s: %s — не заполнено" % (FIELD_LABELS[key], ошибка)})
        elif значение is not None:
            fields[key] = значение

    старт, ошибка_даты = _parse_date_cell(values.get("smr_start_reported"))
    if ошибка_даты:
        warnings.append({"line": line_no, "name": name, "reason": ошибка_даты})
    elif старт:
        fields["smr_start_reported"] = старт

    return {
        "kind": "create", "key": name, "object_id": None, "line": line_no,
        "field": "name", "field_label": "Новый объект", "was": None, "now": name,
        "fields": fields,
    }, warnings


def _build_update(row, line_no: int, values: dict) -> tuple:
    """Расхождения для УЖЕ существующего объекта.

    Пустая ячейка здесь значит «файл не несёт сведений об этом поле», а НЕ
    «очистить» — реестр заказчика заполнен построчно неровно (не все поля
    известны для каждого объекта), и это не тот же файл, что система сама
    выгрузила и ждёт обратно целиком (см. app/element_bulk_edit.py, где
    пустая ячейка — законная команда стереть значение). Затирать то, что уже
    внесено в систему, потому что в конкретной строке реестра поле не
    заполнили, значило бы терять данные тем сильнее, чем полнее справочник
    уже обжит руками."""
    changes, warnings = [], []
    name = row["name"]

    def describe(field, was, now):
        return {
            "kind": "update", "key": name, "object_id": row["id"], "line": line_no,
            "field": field, "field_label": FIELD_LABELS.get(field, field),
            "was": was, "now": now,
        }

    # Адрес — только у объекта, ещё НЕ привязанного к классификатору: иначе
    # правка из файла порвала бы связь address <-> address_code молча.
    новый_адрес = _clean_text(values.get("address"))
    if новый_адрес is not None:
        if row["address_code"]:
            if новый_адрес != (row["address"] or None):
                warnings.append({"line": line_no, "name": name,
                                 "reason": "Адрес привязан к классификатору — адрес из файла проигнорирован"})
        else:
            разложено = resolve_free_text_address(новый_адрес)
            if разложено and разложено["code"] != (row["address_code"] or None):
                # Один бундл, а не набор независимых полей: применить «Адрес»
                # без «address_code» значило бы разорвать пару, которую вся
                # остальная система (виджет, apply_object PATCH) считает
                # согласованной.
                поля_бандла = {
                    "address": разложено["address"],
                    "address_code": разложено["code"],
                    "address_source": разложено["source"],
                    "address_region": разложено["region"],
                    "address_parts": json.dumps(разложено["parts"], ensure_ascii=False),
                }
                if разложено.get("postal_code"):
                    поля_бандла["postal_code"] = разложено["postal_code"]
                changes.append({
                    "kind": "address_link", "key": name, "object_id": row["id"], "line": line_no,
                    "field": "address", "field_label": "Адрес (по классификатору)",
                    "was": row["address"], "now": разложено["address"],
                    "fields": поля_бандла,
                })
            elif not разложено and новый_адрес != (row["address"] or None):
                changes.append(describe("address", row["address"], новый_адрес))
                регион = region_from_address(новый_адрес)
                if регион and регион != row["address_region"]:
                    changes.append(describe("address_region", row["address_region"], регион))

    for key in ("smu", "smu_director", "responsible", "media_url"):
        новое = _clean_text(values.get(key))
        if новое is None:
            continue
        старое = row[key] if key in row.keys() else None
        if новое != старое:
            changes.append(describe(key, старое, новое))

    статус, предупреждение = _parse_status(values.get("status_raw"))
    if предупреждение:
        warnings.append({"line": line_no, "name": name, "reason": предупреждение})
    elif статус and статус != (row["status"] or "active"):
        changes.append(describe("status", row["status"] or "active", статус))

    for key in ("lat", "lon"):
        новое, ошибка = _parse_coord(values.get(key))
        if ошибка:
            warnings.append({"line": line_no, "name": name, "reason": "%s: %s" % (FIELD_LABELS[key], ошибка)})
            continue
        if новое is None:
            continue
        старое = row[key]
        старое_округл = round(старое, 6) if старое is not None else None
        if новое != старое_округл:
            changes.append(describe(key, старое, новое))

    новый_старт, ошибка_даты = _parse_date_cell(values.get("smr_start_reported"))
    if ошибка_даты:
        warnings.append({"line": line_no, "name": name, "reason": ошибка_даты})
    elif новый_старт is not None:
        старый_старт = row["smr_start_reported"] if "smr_start_reported" in row.keys() else None
        if новый_старт != старый_старт:
            changes.append(describe("smr_start_reported", старый_старт, новый_старт))

    return changes, warnings


# -------------------------------------------------------------------- apply

def _find_or_create_project(conn, admin, name: str, address: Optional[str]) -> int:
    """Проект для нового объекта — тот же по имени (решение пользователя
    «один объект = один проект»). Совпадение имени с уже существующим
    проектом — это ОН И ЕСТЬ, а не конфликт: переиспользуем."""
    найден = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
    if найден:
        return найден["id"]
    conn.execute(
        "INSERT INTO projects (name, status, address) VALUES (?, 'active', ?)",
        (name, address),
    )
    new_id = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()["id"]
    activity.log("project_create", user=admin, entity_type="project", entity_id=new_id,
                 new_value=name, details={"source": "xlsx", "авто": "под импортированный объект"})
    return new_id


def apply_changes(conn, selections: list, admin) -> dict:
    """Применяет ОТМЕЧЕННЫЕ пользователем изменения — то же, что вернул
    analyze(), отфильтрованное флажками. Файл заново не читается."""
    from app.main import _valid_status  # локальный импорт против цикла (main.py вызывает этот модуль)

    неизвестные = {str(sel.get("field")) for sel in selections
                   if sel.get("kind") == "update"} - _UPDATE_FIELDS
    if неизвестные:
        raise ValueError("Недопустимые поля для правки: " + ", ".join(sorted(неизвестные)))

    by_key: dict = {}
    for sel in selections:
        by_key.setdefault(sel.get("key"), []).append(sel)

    created, updated, skipped = 0, 0, []
    for key, items in by_key.items():
        creates = [s for s in items if s.get("kind") == "create"]
        updates = [s for s in items if s.get("kind") == "update"]
        address_links = [s for s in items if s.get("kind") == "address_link"]

        if creates:
            name = (key or "").strip()
            if not name:
                skipped.append({"reason": "Пустое наименование — пропущено"})
                continue
            if conn.execute("SELECT 1 FROM objects WHERE name = ?", (name,)).fetchone():
                skipped.append({"name": name,
                                "reason": "Объект с таким наименованием уже появился в базе — обновите сверку"})
                continue
            fields = dict(creates[0].get("fields") or {})
            статус = _valid_status(fields.pop("status", None))
            project_id = _find_or_create_project(conn, admin, name, fields.get("address"))
            колонки = ["name", "project_id", "status", "kind"] + list(fields.keys())
            значения = [name, project_id, статус, "zhbi"] + list(fields.values())
            conn.execute(
                "INSERT INTO objects (%s) VALUES (%s)" % (
                    ", ".join(колонки), ", ".join("?" * len(колонки))),
                значения,
            )
            new_id = conn.execute("SELECT id FROM objects WHERE name = ?", (name,)).fetchone()["id"]
            created += 1
            activity.log("object_import", user=admin, entity_type="object", entity_id=new_id,
                         old_value=None, new_value="создан импортом: %s" % name,
                         details={"source": "xlsx", "fields": {**fields, "status": статус}})
            continue

        if not updates and not address_links:
            continue
        row = conn.execute("SELECT * FROM objects WHERE name = ?", (key,)).fetchone()
        if row is None:
            skipped.append({"name": key, "reason": "Объект исчез между сверкой и применением"})
            continue

        затронут = False

        if address_links:
            поля_бандла = dict(address_links[0].get("fields") or {})
            неизвестные_подполя = set(поля_бандла) - _ADDRESS_LINK_FIELDS
            if неизвестные_подполя:
                raise ValueError("Недопустимые поля адреса: " + ", ".join(sorted(неизвестные_подполя)))
            if row["address_code"]:
                # Между сверкой и применением адрес уже кто-то привязал —
                # тот же случай, что и на сверке (см. _build_update), просто
                # обнаружился позже.
                skipped.append({"name": key,
                                "reason": "Адрес уже привязан к классификатору — пропущено"})
            else:
                conn.execute(
                    "UPDATE objects SET %s, updated_at = datetime('now') WHERE id = ?" % (
                        ", ".join("%s = ?" % f for f in поля_бандла)),
                    list(поля_бандла.values()) + [row["id"]],
                )
                затронут = True
                activity.log(
                    "object_import", user=admin, entity_type="object", entity_id=row["id"],
                    old_value="адрес: %s" % (row["address"] or "—"),
                    new_value="адрес по классификатору: %s" % поля_бандла.get("address"),
                    details={"source": "xlsx"},
                )
                # Дальнейшие правки (ниже) должны видеть уже привязанный
                # адрес — иначе, например, сравнение address_region пошло бы
                # по устаревшей строке.
                row = conn.execute("SELECT * FROM objects WHERE id = ?", (row["id"],)).fetchone()

        if updates:
            записать, описание = [], {}
            for sel in updates:
                field = sel["field"]
                new = sel.get("now")
                if field == "status":
                    new = _valid_status(new)
                elif field in ("lat", "lon") and new is not None:
                    new = round(float(new), 6)
                записать.append((field, new))
                описание[field] = (sel.get("was"), new)
            conn.execute(
                "UPDATE objects SET %s, updated_at = datetime('now') WHERE id = ?" % (
                    ", ".join("%s = ?" % f for f, _ in записать)),
                [v for _, v in записать] + [row["id"]],
            )
            затронут = True
            activity.log(
                "object_import", user=admin, entity_type="object", entity_id=row["id"],
                old_value="; ".join("%s: %s" % (f, w) for f, (w, _) in описание.items())[:500],
                new_value="; ".join("%s: %s" % (f, n) for f, (_, n) in описание.items())[:500],
                details={"source": "xlsx"},
            )

        if затронут:
            updated += 1

    conn.commit()
    return {"created": created, "updated": updated, "skipped": skipped}

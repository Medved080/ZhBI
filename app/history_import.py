"""
Импорт истории статусов из .xlsx (обратная операция к export.build_history_xlsx)
— переносит прогресс поставки/монтажа на другой сервер, где тот же чертёж уже
загружен (тот же source_file, те же dxf_handle). Тот же механизм используется
для аварийного восстановления статусов после потери БД (см. Docs/backlog.md,
2026-07-28) — по заранее сохранённой выгрузке "Статус на дату"
(export.build_snapshot_xlsx).

Сопоставление элементов — по (source_file, dxf_handle), как и при обычном
upsert элементов. Элементы, которых нет в целевой БД, пропускаются и
попадают в сводку как unmatched — заказчик должен сначала загрузить тот же
DXF на новом сервере.

Режим "replace" — существующая история сопоставленных элементов удаляется
перед импортом. Режим "merge" — история дополняется, но не создаёт дубли:
если у элемента уже есть запись с тем же статусом в ту же дату, строка из
файла пропускается (см. Docs/backlog.md п.3).

Принимает ДВА разных формата листа с одинаковой сутью строки "элемент
получил такой-то статус в такой-то момент": "История статусов"
(build_history_xlsx, колонка "Изменено", по записи на КАЖДОЕ событие) и
"Статус на дату" (build_snapshot_xlsx, колонка "Статус изменён", ОДНА
запись на элемент — его статус на момент выгрузки). Для восстановления
после потери БД это ничем не хуже: строка снимка становится единственной
записью истории элемента, current_status после импорта — то, что было в
снимке (см. import_history ниже).
"""

import io

from openpyxl import load_workbook

from app.contracting_import import parse_number_and_date
from app.contracts import (
    find_or_create_contract,
    recompute_element_contract_cache,
    recompute_status_and_actual_date,
)
from app.counterparties import (
    find_or_create_agreement,
    find_or_create_counterparty,
    find_or_create_specification,
)
from app.models import STATUS_LABELS_RU

STATUS_LABEL_TO_VALUE = {label: status.value for status, label in STATUS_LABELS_RU.items()}

REQUIRED_HEADERS = ["DXF handle", "Статус"]
CHANGED_AT_HEADER_CANDIDATES = ["Изменено", "Статус изменён"]

# Реквизиты контракта — три колонки, которые выгрузка отдаёт с 2026-07-29
# (см. app/export.py, CONTRACT_COLUMNS). На листе "История статусов" у тех
# же колонок есть суффикс "на момент изменения" — принимаем оба варианта,
# как уже сделано для даты изменения выше.
CONTRACT_HEADER_CANDIDATES = {
    "supplier": ["Поставщик", "Поставщик на момент изменения"],
    "agreement": ["Договор (номер и дата)", "Договор (номер и дата) на момент изменения"],
    "specification": ["Спецификация (номер и дата)", "Спецификация (номер и дата) на момент изменения"],
    # Старый формат выгрузки (до 2026-07-29) — одна склеенная колонка
    # "Контракт" вида "Контрагент/Договор № от .../Спецификация № от ...".
    # Разбирать её обратно не пытаемся: тема контракта в скобках и слэши
    # внутри номеров документов (реальный пример: "2/09.04-ПОСТ") делают
    # разбор неоднозначным. Такие файлы импортируются как раньше, без
    # реквизитов — об этом сообщается в сводке.
    "legacy": ["Контракт", "Контракт на момент изменения"],
}


class HistoryImportError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def parse_history_xlsx(content: bytes):
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception:
        raise HistoryImportError(422, "Файл повреждён или не является корректным .xlsx")

    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise HistoryImportError(422, "Пустой файл")

    header = [str(h).strip() if h is not None else "" for h in header]
    missing = [h for h in REQUIRED_HEADERS if h not in header]
    if missing:
        raise HistoryImportError(
            422, f"В файле нет обязательных колонок: {', '.join(missing)}"
        )
    changed_at_header = next((h for h in CHANGED_AT_HEADER_CANDIDATES if h in header), None)
    if changed_at_header is None:
        raise HistoryImportError(
            422,
            "В файле нет колонки с датой/временем статуса "
            f"({' или '.join(CHANGED_AT_HEADER_CANDIDATES)})",
        )
    col = {name: idx for idx, name in enumerate(header)}

    def get(row, name):
        idx = col.get(name)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    # Какие из колонок реквизитов реально есть в этом файле
    contract_headers = {
        key: next((h for h in candidates if h in header), None)
        for key, candidates in CONTRACT_HEADER_CANDIDATES.items()
    }
    has_contract_columns = all(contract_headers[k] for k in ("supplier", "agreement", "specification"))

    def text(row, header_name):
        if not header_name:
            return None
        value = get(row, header_name)
        if value is None:
            return None
        value = str(value).strip()
        return value or None

    parsed = []
    for row in rows:
        dxf_handle = get(row, "DXF handle")
        status_label = get(row, "Статус")
        changed_at = get(row, changed_at_header)
        if not dxf_handle or not status_label or not changed_at:
            continue
        status = STATUS_LABEL_TO_VALUE.get(str(status_label).strip())
        if status is None:
            continue
        parsed.append(
            {
                "dxf_handle": str(dxf_handle),
                "status": status,
                "changed_at": str(changed_at),
                "changed_by": get(row, "Кто изменил") or None,
                "comment": get(row, "Комментарий") or None,
                "supplier_raw": text(row, contract_headers["supplier"]) if has_contract_columns else None,
                "agreement_raw": text(row, contract_headers["agreement"]) if has_contract_columns else None,
                "specification_raw": text(row, contract_headers["specification"]) if has_contract_columns else None,
            }
        )

    return {
        "rows": parsed,
        "has_contract_columns": has_contract_columns,
        "has_legacy_contract_column": bool(contract_headers["legacy"]),
    }


def _resolve_contract_id(conn, row, cache, warnings, counterparty_by_lower):
    """Реквизиты строки → contract_id, с созданием недостающих звеньев
    цепочки Контрагент→Договор→Спецификация→Контракт (согласовано с
    пользователем: создавать на лету, а не отвергать строку).

    Переиспользует ровно те же find_or_create_*, что и импорт контрактации
    (app/contracting_import.py), и тот же parse_number_and_date — формат
    "НОМЕР от ДД.ММ.ГГГГ" разбирается одной и той же функцией, которой он
    и собирался при выгрузке (build_document_label, app/contracts.py).

    Кэш по тройке (поставщик, договор, спецификация) — в выгрузке тысячи
    строк на десяток контрактов, без него на каждую строку шли бы четыре
    SELECT.
    """
    supplier = row.get("supplier_raw")
    agreement_raw = row.get("agreement_raw")
    specification_raw = row.get("specification_raw")
    if not supplier or not agreement_raw or not specification_raw:
        return None  # обычная ситуация: у элемента просто нет контракта

    key = (supplier, agreement_raw, specification_raw)
    if key in cache:
        return cache[key]

    agreement_number, agreement_date, agr_warning = parse_number_and_date(agreement_raw)
    specification_number, specification_date, spec_warning = parse_number_and_date(specification_raw)
    if agr_warning:
        warnings.append(f"Договор «{agreement_raw}»: {agr_warning}")
    if spec_warning:
        warnings.append(f"Спецификация «{specification_raw}»: {spec_warning}")

    # Регистронезависимое сопоставление кириллицы — ТОЛЬКО на стороне
    # Python: SQLite без ICU не приводит кириллицу к одному регистру ни
    # через COLLATE NOCASE, ни через lower() (живой баг на марках
    # "15КС1.1"/"15кс1.1", см. Docs/backlog.md, "Контрактация 2.0").
    # find_or_create_counterparty сравнивает short_name точным SQL-равенством,
    # поэтому "Партнер" и "партнер" в отредактированном вручную файле
    # создали бы ДВУХ контрагентов. Сначала ищем сами, без учёта регистра.
    existing_id = counterparty_by_lower.get(supplier.lower())
    if existing_id is not None:
        counterparty_id = existing_id
    else:
        counterparty_id = find_or_create_counterparty(conn, full_name=supplier, short_name=supplier)
        counterparty_by_lower[supplier.lower()] = counterparty_id

    agreement_id = find_or_create_agreement(conn, counterparty_id, agreement_number, agreement_date)
    specification_id = find_or_create_specification(
        conn, agreement_id, specification_number, specification_date
    )
    contract_id = find_or_create_contract(conn, specification_id)
    cache[key] = contract_id
    return contract_id


def import_history(conn, source_file: str, rows: list, mode: str):
    if mode not in ("replace", "merge"):
        raise HistoryImportError(422, "mode должен быть 'replace' или 'merge'")

    handles = sorted({r["dxf_handle"] for r in rows})
    element_ids = {}
    for handle in handles:
        found = conn.execute(
            "SELECT id FROM elements WHERE source_file = ? AND dxf_handle = ?",
            (source_file, handle),
        ).fetchone()
        if found:
            element_ids[handle] = found["id"]

    unmatched_handles = [h for h in handles if h not in element_ids]

    if mode == "replace":
        matched_ids = list(element_ids.values())
        if matched_ids:
            placeholders = ",".join("?" * len(matched_ids))
            conn.execute(
                f"DELETE FROM status_history WHERE element_id IN ({placeholders})", matched_ids
            )

    inserted = skipped_duplicate = skipped_unmatched = 0
    touched_element_ids = set()

    # Реквизиты контракта из файла (см. _resolve_contract_id). Счётчик
    # контрактов ДО импорта — чтобы в сводке честно показать, сколько было
    # создано новых, а не сколько всего упомянуто.
    contract_cache: dict = {}
    contract_warnings: list = []
    contracts_before = conn.execute("SELECT COUNT(*) AS n FROM contracts").fetchone()["n"]
    counterparty_by_lower = {
        r["short_name"].lower(): r["id"]
        for r in conn.execute("SELECT id, short_name FROM counterparties").fetchall()
        if r["short_name"]
    }
    rows_with_contract = 0

    for row in rows:
        element_id = element_ids.get(row["dxf_handle"])
        if element_id is None:
            skipped_unmatched += 1
            continue

        date_part = row["changed_at"][:10]
        dup = conn.execute(
            "SELECT id FROM status_history WHERE element_id = ? AND status = ? "
            "AND substr(changed_at, 1, 10) = ?",
            (element_id, row["status"], date_part),
        ).fetchone()
        if dup:
            skipped_duplicate += 1
            continue

        contract_id = _resolve_contract_id(
            conn, row, contract_cache, contract_warnings, counterparty_by_lower
        )
        if contract_id is not None:
            rows_with_contract += 1

        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_at, changed_by, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (element_id, row["status"], row["changed_at"], row["changed_by"], row["comment"], contract_id),
        )
        inserted += 1
        touched_element_ids.add(element_id)

    # recompute_status_and_actual_date (app/contracts.py) — тот же
    # пересчёт, что после обычной смены статуса/отката: current_status
    # ПЛЮС actual_delivery_date (сбрасывается/выставляется по фактическому
    # статусу "Доставлено"), не только current_status в одиночку — иначе
    # актуальная дата поставки молча разошлась бы с восстановленным
    # статусом (см. Docs/backlog.md, 2026-07-28, восстановление статусов).
    for element_id in touched_element_ids:
        recompute_status_and_actual_date(conn, element_id)
        # elements.contract_id — такой же денормализованный кэш последней по
        # changed_at записи истории, как current_status; без этого вызова
        # привязка к контракту осталась бы только в status_history, а схема
        # и карточка элемента показывали бы прежний контракт.
        recompute_element_contract_cache(conn, element_id)

    conn.commit()

    contracts_after = conn.execute("SELECT COUNT(*) AS n FROM contracts").fetchone()["n"]

    return {
        "matched_elements": len(element_ids),
        "unmatched_elements": len(unmatched_handles),
        "unmatched_handles": unmatched_handles[:20],
        "inserted": inserted,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unmatched": skipped_unmatched,
        "rows_with_contract": rows_with_contract,
        "contracts_created": contracts_after - contracts_before,
        "contract_date_warnings": contract_warnings[:20],
    }

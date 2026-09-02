"""
Загрузка справочника видов работ (WBS) из xlsx (Docs/block-accounting.md §4).

Двухфазно, как импорт чертежа и пакетов Revit (решение И3): `analyze`
разбирает файл и считает расхождения, ничего не пишет; `apply` применяет
уже посчитанное по токену.

Формат листа: `Уровень WBS | Идентификатор операции | Название операции |
Единицы измерения | Кодификатор`. Четыре ловушки исходного файла заказчика
(проверено на реальном файле «WBS МФР типовой», см. документ):

  * у УЗЛА название лежит в колонке «Идентификатор операции», а у
    ОПЕРАЦИИ/ВЕХИ — в «Название операции». Колонка «Уровень WBS» несёт для
    узла НОМЕР УРОВНЯ, а для операции/вехи — слово `оп`/`веха` (тип строки,
    не глубина); операция/веха всегда становится ребёнком ПОСЛЕДНЕГО
    встреченного узла, а не следующего числового уровня;
  * «номер уровня» узла бывает в ДВУХ разных обозначениях, и файл
    выдерживает только одно из них целиком: путь по дереву («1», «1.2»,
    «2.1.3» — глубина считается по числу точек) или голое число абсолютной
    глубины («1», «2», «3», «4» — глубина это само число). В файле «WBS МФР
    типовой» — второй вариант: узел третьего уровня вложенности обозначен
    просто «3», а не «1.1.3». Перепутать критично: посчитать голое число
    точками — все узлы дерева, глубина которых не 1, схлопнутся в одну
    глубину и одноимённые категории из разных веток («Земляные работы»,
    «Металлоконструкции» и т.п.) склеятся по пути в один узел, затерев
    большую часть подчинённых операций. Формат определяется один раз на
    весь лист (`_uses_dotted_levels`): точка хоть где-то в колонке — путь по
    дереву, иначе — голое число;
  * кодификатор МОЖЕТ повторяться и МОЖЕТ отсутствовать — ключом записи
    служит ПУТЬ по дереву (имена всех предков + своё), он и только он
    уникален;
  * пустое название операции — дефект исходника, не повод падать: строка
    остаётся с пустым именем и отдельной строкой в предупреждениях.
"""

import io

from openpyxl import load_workbook

HEADERS = ("Уровень WBS", "Идентификатор операции", "Название операции",
          "Единицы измерения", "Кодификатор")

# Необязательная колонка: встречается не во всех файлах и не у всех строк
# файла, где есть (в «WBS МФР типовой» заполнена у 5 строк из 224) — но
# несёт содержательные пояснения («выбрать нужную технологию»), поэтому
# сохраняется, если колонка в файле есть, и просто не заполняется, если нет.
COL_NOTE = "Примечание"

ROW_NODE = "узел"
ROW_OP = "оп"
ROW_MILESTONE = "веха"

PATH_SEP = " / "

_PENDING = {}
_PENDING_LIMIT = 3


class WorkTypesError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _header_index(header_row) -> dict:
    values = [str(c.value).strip() if c.value is not None else "" for c in header_row]
    index = {}
    for name in HEADERS:
        if name not in values:
            raise WorkTypesError(
                422, "В файле нет колонки «%s». Ожидаются: %s"
                % (name, ", ".join(HEADERS)))
        index[name] = values.index(name)
    if COL_NOTE in values:
        index[COL_NOTE] = values.index(COL_NOTE)
    return index


def _uses_dotted_levels(sheet, idx) -> bool:
    """Определяет формат колонки «Уровень WBS» по всему листу разом: если
    хоть где-то встретилась точка («2.1.3») — это путь по дереву, и глубина
    везде считается по числу точек; если точек нет ни у одной строки (везде
    голые «1», «2», «3», «4») — число само и есть абсолютная глубина узла.
    Ловушка ровно на этом: у файла «WBS МФР типовой» узел на глубине 3
    обозначен просто «3», а не «1.1.3» — при счёте точек это дало бы
    глубину 1 всем узлам подряд и склеило разные ветки дерева в одну."""
    i = idx["Уровень WBS"]
    for row in sheet.iter_rows(min_row=2):
        v = row[i].value if i < len(row) else None
        cell = str(v).strip() if v is not None else ""
        if cell and cell.lower() not in (ROW_OP, ROW_MILESTONE) and "." in cell:
            return True
    return False


def parse_xlsx(data: bytes) -> tuple:
    """Разбор листа в плоский список строк дерева с уже посчитанным путём.

    Возвращает (rows, warnings). `rows` — список словарей: path, parent_path,
    row_kind, code, name, unit, note, sort_order.
    """
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        raise WorkTypesError(422, "Файл не открылся как xlsx: %s" % e)
    sheet = wb.worksheets[0]
    rows_iter = sheet.iter_rows()
    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise WorkTypesError(422, "Лист пуст.")
    idx = _header_index(header_row)
    dotted_levels = _uses_dotted_levels(sheet, idx)

    warnings = []
    result = []
    # Стек текущих узлов: [(глубина, путь, порядковый_номер)].
    stack = []
    sort_order = 0
    last_node_path = None

    for excel_row_no, row in enumerate(rows_iter, start=2):
        def cell(col):
            i = idx.get(col)
            if i is None:
                return ""   # необязательная колонка (COL_NOTE), в файле нет
            v = row[i].value if i < len(row) else None
            return str(v).strip() if v is not None else ""

        level_cell = cell("Уровень WBS")
        if not level_cell and not cell("Идентификатор операции") and not cell("Название операции"):
            continue  # пустая строка — не ошибка, просто пропуск

        code = cell("Кодификатор") or None
        unit = cell("Единицы измерения") or None
        note = cell(COL_NOTE) or None
        kind_word = level_cell.lower()

        if kind_word in (ROW_OP, ROW_MILESTONE):
            row_kind = ROW_OP if kind_word == ROW_OP else ROW_MILESTONE
            name = cell("Название операции")
            if not name:
                warnings.append(
                    "Строка %d: у %s нет названия (колонка «Название операции» пуста)"
                    % (excel_row_no, "операции" if row_kind == ROW_OP else "вехи"))
            if last_node_path is None:
                warnings.append(
                    "Строка %d: %s встретилась раньше первого узла, пропущена"
                    % (excel_row_no, row_kind))
                continue
            path = last_node_path + PATH_SEP + (name or "(без названия, строка %d)" % excel_row_no)
            sort_order += 1
            result.append({
                "path": path, "parent_path": last_node_path, "row_kind": row_kind,
                "code": code, "name": name, "unit": unit, "note": note, "sort_order": sort_order,
            })
            continue

        # Иначе — узел: «Уровень WBS» несёт номер уровня. Формат — либо путь
        # по дереву («1», «1.2», «2.1.3» — глубина по числу точек), либо
        # голое число абсолютной глубины («1», «2», «3», «4») — какой из
        # двух, решено один раз на весь лист в _uses_dotted_levels.
        if not level_cell:
            depth = None
        elif dotted_levels:
            depth = level_cell.count(".") + 1
        else:
            try:
                depth = int(level_cell)
            except ValueError:
                depth = None
        name = cell("Идентификатор операции")
        if not name:
            warnings.append(
                "Строка %d: у узла нет названия (колонка «Идентификатор "
                "операции» пуста), строка пропущена" % excel_row_no)
            continue
        if depth is None:
            warnings.append(
                "Строка %d: не удалось определить уровень узла «%s» (значение "
                "«%s» в колонке «Уровень WBS» не распознано), строка пропущена"
                % (excel_row_no, name, level_cell))
            continue

        while stack and stack[-1][0] >= depth:
            stack.pop()
        parent_path = stack[-1][1] if stack else None
        path = (parent_path + PATH_SEP + name) if parent_path else name
        sort_order += 1
        result.append({
            "path": path, "parent_path": parent_path, "row_kind": ROW_NODE,
            "code": code, "name": name, "unit": unit, "note": note, "sort_order": sort_order,
        })
        stack.append((depth, path))
        last_node_path = path

    seen_paths = {}
    for r in result:
        if r["path"] in seen_paths:
            warnings.append("Путь «%s» встретился дважды — вторая строка перезатёрла первую"
                            % r["path"])
        seen_paths[r["path"]] = r
    return list(seen_paths.values()), warnings


def _existing(conn, object_id: int) -> dict:
    return {
        row["path"]: dict(row)
        for row in conn.execute(
            "SELECT id, path, row_kind, code, name, unit, note, retired_at FROM work_types "
            "WHERE object_id = ?", (object_id,))
    }


def analyze(conn, object_id: int, data: bytes) -> dict:
    """Фаза 1. В БД не пишет ничего."""
    parsed, warnings = parse_xlsx(data)
    have = _existing(conn, object_id)

    parsed_paths = {r["path"] for r in parsed}
    new_rows = [r for r in parsed if r["path"] not in have]
    existing_active = [r for r in parsed if r["path"] in have and not have[r["path"]]["retired_at"]]
    reviving = [r for r in parsed if r["path"] in have and have[r["path"]]["retired_at"]]
    retiring = [p for p, row in have.items() if p not in parsed_paths and not row["retired_at"]]

    return {
        "object_id": object_id,
        "total_rows": len(parsed),
        "new": [{"путь": r["path"], "тип": r["row_kind"], "единица": r["unit"]}
                for r in new_rows],
        "reviving": [{"путь": r["path"]} for r in reviving],
        "retiring": sorted(retiring),
        "unchanged": len(existing_active) - len(reviving),
        "warnings": warnings,
        "_parsed": parsed,
    }


def apply(conn, object_id: int, analysis: dict) -> dict:
    """Фаза 2: применяет уже посчитанное. Сопоставление — ПО ПУТИ.
    Пропавшие пути помечаются `retired_at`, а не удаляются — иначе
    потерялась бы простановленная по ним история статусов."""
    parsed = analysis["_parsed"]
    have = _existing(conn, object_id)
    parsed_paths = {r["path"] for r in parsed}

    path_to_id = {p: row["id"] for p, row in have.items()}
    added = 0
    revived = 0
    for r in parsed:
        existing = have.get(r["path"])
        parent_id = path_to_id.get(r["parent_path"]) if r["parent_path"] else None
        if existing is None:
            cur = conn.execute(
                "INSERT INTO work_types (object_id, parent_id, path, row_kind, code, "
                "name, unit, note, sort_order, retired_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)",
                (object_id, parent_id, r["path"], r["row_kind"], r["code"],
                 r["name"], r["unit"], r["note"], r["sort_order"]),
            )
            path_to_id[r["path"]] = cur.lastrowid
            added += 1
        else:
            if existing["retired_at"]:
                revived += 1
            conn.execute(
                "UPDATE work_types SET parent_id = ?, code = ?, name = ?, unit = ?, note = ?, "
                "sort_order = ?, retired_at = NULL WHERE id = ?",
                (parent_id, r["code"], r["name"], r["unit"], r["note"], r["sort_order"], existing["id"]),
            )

    retired = 0
    for path, row in have.items():
        if path not in parsed_paths and not row["retired_at"]:
            conn.execute(
                "UPDATE work_types SET retired_at = datetime('now') WHERE id = ?",
                (row["id"],),
            )
            retired += 1

    conn.commit()
    return {"added": added, "revived": revived, "retired": retired, "total": len(parsed)}


def remember_pending(analysis: dict) -> str:
    import uuid
    token = uuid.uuid4().hex
    _PENDING[token] = analysis
    while len(_PENDING) > _PENDING_LIMIT:
        _PENDING.pop(next(iter(_PENDING)))
    return token


def get_pending(token: str) -> dict:
    analysis = _PENDING.get(token)
    if analysis is None:
        raise WorkTypesError(
            410, "Результат разбора уже недоступен (сервер перезапускался или "
            "разбор устарел). Загрузите файл заново.")
    return analysis


def forget_pending(token: str) -> None:
    _PENDING.pop(token, None)

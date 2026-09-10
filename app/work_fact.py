"""
Отбор операций «эт/сек»/«кв.эт/сек» для конкретного блока и отчёты о
фактическом выполнении (живой запрос пользователя, 2026-09-02) — надстройка
над контуром «Учёт по блокам» (Docs/block-accounting.md) поверх операций с
единицей из `work_progress.BLOCK_UNITS`. Для них План/В работе/Выполнено
больше не проставляется кликом-циклом в общей матрице (`work_progress.py`,
`ADDRESSABLE_UNITS`) — источник истины теперь процент отсюда. Для «сек» и
«компл» ничего не меняется, они по-прежнему живут в `work_progress`.

«кв.эт/сек» (квартира, 2026-09-04) добавлена в BLOCK_UNITS тем же
механизмом, что «эт/сек»: своей геометрии у квартиры в БД нет, а лежит она
внутри одного блока — процент вводится ОДНИМ числом на пару (блок,
операция), без деления по отдельным квартирам (задел на будущее, решение
пользователя).

Отбор операций на блоке — план блока, строки `block_works` («Запланированная
работа», ЗР — Docs/block-works-schedule-task.md, 2026-09-10). ЯВНЫЙ: у
блока, который не настраивали, строк нет вовсе, «выбрано всё по умолчанию»
не бывает — до 2026-09-10 было наоборот (`block_work_types` + отдельный
флаг `blocks.work_types_configured_at`, отсутствие настройки = «выбран весь
список»), это поведение снято тем же решением, что завело ЗР: у операции со
сроками неявного «всё» быть не может, срок ставится на конкретную строку.
ЗР — не только отбор: у строки `block_works` есть колонки под директивные и
актуализированные сроки рядом с парой (block_id, work_type_id) — правка и
показ этих сроков появляются позже, отдельным этапом задания.

Отчёт о фактическом выполнении — ДОКУМЕНТ на дату, а не строка в
неизменяемом журнале действий: пользователь явно попросил возможность
вернуться к любому прошлому отчёту и исправить зафиксированные в нём
цифры — аналог бумажного отчёта ответственного со стройки. Текущий процент
операции на блоке — значение из отчёта с МАКСИМАЛЬНОЙ `report_date` среди
тех, что её касаются; при равенстве дат — из отчёта с бóльшим id (записан
позже). Отдельный явный журнал действий (`app/activity_actions.py`) эти
отчёты не дублирует — это не тот жанр, документы сами себе журнал.

«Шахматка» (2026-09-02, переосмыслена 2026-09-04) — раньше красила все
блоки по ОДНОЙ выбранной операции; теперь ДОСКА = группа операций одного
кода «Трек планирования» (`planning_tracks`, коды «1»-«20» — заказчик
называет их шахматками с визуализацией на модели, лист `PlanningTrack`
исходного xlsx, `app/work_types_import.py`). Цвет/статус блока — среднее
арифметическое процентов ЕГО операций этого трека (`_status_from_percent`
от среднего), подпись на блоке — по строке на каждую такую операцию.
Единицы вне BLOCK_UNITS (сек/компл/шт/м2/м3/т/пог.м/опора), даже если у них
есть код трека 1-20 в файле (в реальном файле встречается — код 1
«Монолит» наполовину «м3», в некоторых кодах подмешан «компл»), в доску не
входят — остаются видны только в дереве «Виды работ» и старой матрице.
"""

from app import work_progress
from app.work_progress import (
    BLOCK_UNITS, STATUS_PLAN, STATUS_IN_PROGRESS, STATUS_DONE,
)

# «Динамика за период» с пустыми датами (живой запрос пользователя,
# 2026-09-10) — не «выключено», а «за весь период»: нижняя граница —
# заведомо раньше любого реального отчёта, верхняя, если не выбрана, —
# сегодня (см. block_progress_tree/blocks_fact_changes).
_DYNAMICS_MIN_DATE = "0001-01-01"


class FactError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _block_exists(conn, object_id: int, block_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM blocks WHERE id = ? AND object_id = ?", (block_id, object_id),
    ).fetchone() is not None


def _block_op_work_types(conn, object_id: int) -> list:
    """Активные «оп»-строки справочника с единицей из BLOCK_UNITS
    («эт/сек», «кв.эт/сек») — ровно то, из чего вообще может выбирать
    «Настройки» блока."""
    placeholders = ", ".join("?" for _ in BLOCK_UNITS)
    return [
        dict(row) for row in conn.execute(
            "SELECT id, path, code, name, planning_track_code, sort_order FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL AND row_kind = 'оп' "
            "AND unit IN (%s) ORDER BY sort_order" % placeholders,
            (object_id, *BLOCK_UNITS),
        )
    ]


def block_settings(conn, object_id: int, block_id: int) -> dict:
    """Список операций «эт/сек» для формы «Настройки»: все варианты плюс
    те, что сейчас в плане блока (`block_works`).

    Явность плана (2026-09-10, Docs/block-works-schedule-task.md §2.2) —
    у ЗР появились сроки, а неявному «всё» ставить срок некуда. Поэтому у
    ненастроенного блока `selected` теперь пуст, а не «весь список»: то
    старое поведение читало `blocks.work_types_configured_at`, это поле
    здесь и в трёх других местах модуля (`_op_included_percents`,
    `board_block_values` через него, `used_planning_tracks`) больше не
    читается вовсе (решение пользователя — «читать перестают»)."""
    if not _block_exists(conn, object_id, block_id):
        raise FactError(404, "Блок не найден.")
    options = _block_op_work_types(conn, object_id)
    selected = {
        r["work_type_id"] for r in conn.execute(
            "SELECT work_type_id FROM block_works WHERE block_id = ?", (block_id,))
    }
    return {
        # «Настроен» больше не отдельное состояние блока (см. docstring) —
        # производное: есть хотя бы одна ЗР. Единственный читатель этого
        # поля на фронте — счётчик «настроен отбор у N» в форме группы
        # (app/static/app.js), одиночная форма его не показывает.
        "configured": bool(selected),
        "options": [{"id": r["id"], "путь": r["path"], "код": r["code"]} for r in options],
        "selected": sorted(selected),
    }


def save_block_settings(conn, object_id: int, block_id: int, work_type_ids: list,
                        user_id: int) -> None:
    """Состав работ блока = создаёт/удаляет строки `block_works` (не
    удаляет-и-пересоздаёт весь набор разом, как раньше block_work_types):
    у ЗР теперь есть сроки и факт, и снос-с-нуля стёр бы их у операций,
    которые остались выбранными. Правило снятия операции с зафиксированным
    фактом/сроками — открытый вопрос (В7, Docs/block-works-schedule-task.md
    §11), пока ведёт себя как раньше (без предупреждения)."""
    if not _block_exists(conn, object_id, block_id):
        raise FactError(404, "Блок не найден.")
    valid_ids = {r["id"] for r in _block_op_work_types(conn, object_id)}
    chosen = valid_ids & set(work_type_ids)
    existing = {
        r["work_type_id"]: r["id"] for r in conn.execute(
            "SELECT id, work_type_id FROM block_works WHERE block_id = ?", (block_id,))
    }
    to_add = chosen - existing.keys()
    to_remove = [existing[wt_id] for wt_id in existing.keys() - chosen]
    conn.executemany(
        "INSERT INTO block_works (object_id, block_id, work_type_id, created_by, updated_by) "
        "VALUES (?, ?, ?, ?, ?)",
        [(object_id, block_id, wt_id, user_id, user_id) for wt_id in to_add],
    )
    if to_remove:
        conn.executemany(
            "DELETE FROM block_works WHERE id = ?", [(i,) for i in to_remove])
    conn.commit()


def blocks_settings(conn, object_id: int, block_ids: list) -> dict:
    """Отбор операций сразу для НЕСКОЛЬКИХ блоков (2026-09-05, живой запрос
    пользователя: выделить группу блоков и задать им один список). Список
    вариантов у них общий — он объектный, — а вот отмеченное различается,
    поэтому возвращаются ДВА множества: что стоит у ВСЕХ выделенных и что
    только у ЧАСТИ. Форма показывает первое галочкой, второе — промежуточным
    состоянием: сразу видно, где блоки расходятся (решение пользователя)."""
    if not block_ids:
        raise FactError(422, "Не выбран ни один блок.")
    наборы = []
    настроенных = 0
    for block_id in block_ids:
        свои = block_settings(conn, object_id, block_id)   # он же проверит блок
        наборы.append(set(свои["selected"]))
        if свои["configured"]:
            настроенных += 1
    у_всех = set.intersection(*наборы)
    у_любого = set.union(*наборы)
    return {
        "blocks": len(block_ids),
        "configured": настроенных,
        "options": [{"id": r["id"], "путь": r["path"], "код": r["code"]}
                    for r in _block_op_work_types(conn, object_id)],
        "selected_all": sorted(у_всех),
        "selected_some": sorted(у_любого - у_всех),
    }


def save_blocks_settings(conn, object_id: int, block_ids: list, work_type_ids: list,
                         user_id: int) -> int:
    """Один и тот же список операций — всем выделенным блокам разом. Каждый
    блок проверяется и пишется тем же save_block_settings, что и поодиночке:
    отдельной ветки хранения у группового применения нет, «группа» живёт
    только в интерфейсе."""
    if not block_ids:
        raise FactError(422, "Не выбран ни один блок.")
    for block_id in block_ids:
        save_block_settings(conn, object_id, block_id, work_type_ids, user_id)
    return len(block_ids)


def _current_percents(conn, block_id: int) -> dict:
    """work_type_id -> текущий процент: из отчёта с максимальной датой,
    при равенстве дат — записанного позже (бóльший id отчёта)."""
    rows = conn.execute(
        "SELECT i.work_type_id, i.percent FROM work_fact_items i "
        "JOIN work_fact_reports r ON r.id = i.report_id "
        "WHERE r.block_id = ? ORDER BY r.report_date ASC, r.id ASC", (block_id,),
    ).fetchall()
    result = {}
    for row in rows:
        result[row["work_type_id"]] = row["percent"]  # позже в сортировке — победил
    return result


def _status_from_percent(percent: int) -> str:
    if percent >= 100:
        return STATUS_DONE
    if percent > 0:
        return STATUS_IN_PROGRESS
    return STATUS_PLAN


def block_progress_tree(conn, object_id: int, block_id: int,
                        date_from: "str | None" = None, date_to: "str | None" = None) -> dict:
    """Дерево справочника, обрезанное до предков только выбранных для
    блока операций, с текущим процентом в листьях — для панели блока в
    «Модели МФР». `date_from`/`date_to` (живой запрос пользователя,
    «Динамика за период») — вместо текущего процента в лист кладутся ДВА
    значения на границы периода (percent_from/percent_to), источник тот же
    `_percents_as_of`, что у отчёта «Учёт по блокам: статусы»."""
    settings = block_settings(conn, object_id, block_id)
    selected_ids = set(settings["selected"])

    rows = [
        dict(row) for row in conn.execute(
            "SELECT id, parent_id, row_kind, code, name, unit, note, sort_order, "
            "planning_track_code FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL ORDER BY sort_order", (object_id,))
    ]
    by_id = {r["id"]: r for r in rows}
    keep = set()
    for wt_id in selected_ids:
        cur = wt_id
        while cur is not None and cur not in keep:
            keep.add(cur)
            cur = by_id.get(cur, {}).get("parent_id")

    # Присутствие ХОТЯ БЫ ОДНОГО параметра — сигнал «режим динамики», а не
    # его непустота: пустая строка (обе даты не выбраны, живой запрос
    # пользователя 2026-09-10 — «за весь период», не «выключено») всё равно
    # должна лечь в _DYNAMICS_MIN_DATE/сегодня, а не откатиться к обычному
    # текущему проценту. Обычный режим — параметры вовсе НЕ переданы (None).
    dynamics = date_from is not None or date_to is not None
    if dynamics:
        from datetime import date as _date
        resolved_from = date_from or _DYNAMICS_MIN_DATE
        resolved_to = date_to or _date.today().isoformat()
        percents_from = _percents_as_of(conn, block_id, resolved_from)
        percents_to = _percents_as_of(conn, block_id, resolved_to)
    else:
        percents = _current_percents(conn, block_id)

    nodes = {}
    roots = []
    for r in rows:
        if r["id"] not in keep:
            continue
        node = {
            "id": r["id"], "row_kind": r["row_kind"], "code": r["code"], "name": r["name"],
            "unit": r["unit"], "note": r["note"], "planning_track_code": r["planning_track_code"],
            "children": [],
        }
        if r["id"] in selected_ids:
            if dynamics:
                node["percent_from"] = percents_from.get(r["id"], 0)
                node["percent_to"] = percents_to.get(r["id"], 0)
                node["status_from"] = _status_from_percent(node["percent_from"])
                node["status_to"] = _status_from_percent(node["percent_to"])
            else:
                node["percent"] = percents.get(r["id"], 0)
                node["status"] = _status_from_percent(node["percent"])
        nodes[r["id"]] = node
        parent = nodes.get(r["parent_id"]) if r["parent_id"] else None
        (parent["children"] if parent else roots).append(node)

    return {"configured": settings["configured"], "tree": roots}


def block_summary(conn, object_id: int, block_id: int) -> dict:
    """Свод для простой карточки блока (Docs/TZ.md, «Геометрия блока») —
    тот же формат, что раньше отдавала work_progress.block_status_summary,
    источник теперь процент (2026-09-02: для «эт/сек» он — истина, старая
    матрица статусов их больше не адресует)."""
    settings = block_settings(conn, object_id, block_id)
    percents = _current_percents(conn, block_id)
    total = len(settings["selected"])
    done = в_работе = 0
    for wt_id in settings["selected"]:
        p = percents.get(wt_id, 0)
        if p >= 100:
            done += 1
        elif p > 0:
            в_работе += 1
    return {"всего": total, "план": total - done - в_работе,
            "в_работе": в_работе, "выполнено": done}


def all_planning_tracks(conn, object_id: int) -> list:
    """Весь справочник треков объекта (2026-09-04) — для вкладки «Виды
    работ», где нужны имена ВСЕХ кодов (включая «0»/«компл»/«Веха»), а не
    только досок «Шахматки». Числовые коды впереди по возрастанию,
    нечисловые — следом, по алфавиту."""
    rows = [
        dict(row) for row in conn.execute(
            "SELECT code, name, note FROM planning_tracks WHERE object_id = ?", (object_id,))
    ]

    def order_key(r):
        try:
            return (0, int(r["code"]))
        except (TypeError, ValueError):
            return (1, r["code"])
    rows.sort(key=order_key)
    return [{"код": r["code"], "название": r["name"], "примечание": r["note"]} for r in rows]


def used_planning_tracks(conn, object_id: int) -> list:
    """Доски «Шахматки» для пикера (2026-09-04, замена used_work_types):
    коды строго «1»-«20» (остальные вне визуализации на модели — см. модуль
    docstring), у которых есть хотя бы одна операция BLOCK_UNITS, реально
    входящая в план хотя бы одного блока (`block_works`).

    До 2026-09-10 здесь был отдельный случай «есть ненастроенный блок —
    значит используются вообще все операции»: у него по умолчанию был выбран
    весь список. Явность плана (§2.2 задания) этот случай убирает —
    неотнастроенный блок теперь просто ПУСТ, отдельно его больше не
    проверяют."""
    options = _block_op_work_types(conn, object_id)
    if not options:
        return []
    used_ids = {
        r["work_type_id"] for r in conn.execute(
            "SELECT DISTINCT work_type_id FROM block_works WHERE object_id = ?", (object_id,))
    }
    options = [o for o in options if o["id"] in used_ids]
    used_track_codes = {o["planning_track_code"] for o in options if o["planning_track_code"]}

    track_names = {
        r["code"]: r["name"] for r in conn.execute(
            "SELECT code, name FROM planning_tracks WHERE object_id = ?", (object_id,))
    }
    boards = []
    for code in used_track_codes:
        try:
            n = int(code)
        except (TypeError, ValueError):
            continue
        if not (1 <= n <= 20) or code not in track_names:
            continue
        boards.append({"код": code, "название": track_names[code], "_n": n})
    boards.sort(key=lambda b: b["_n"])
    for b in boards:
        del b["_n"]
    return boards


def _op_included_percents(conn, object_id: int, work_type_id: int) -> dict:
    """block_id -> процент, только для блоков, где эта операция входит в
    отбор (см. block_settings) — единица логики для board_block_values.

    Отбор — наличие строки `block_works` (2026-09-10): неявного «включено
    по умолчанию» у ненастроенного блока больше нет, `blocks.
    work_types_configured_at` здесь не читается (см. docstring
    block_settings)."""
    percents = {}
    for row in conn.execute(
        "SELECT i.percent, r.block_id FROM work_fact_items i "
        "JOIN work_fact_reports r ON r.id = i.report_id "
        "WHERE r.object_id = ? AND i.work_type_id = ? "
        "ORDER BY r.report_date ASC, r.id ASC", (object_id, work_type_id),
    ):
        percents[row["block_id"]] = row["percent"]  # позже в сортировке — победил

    result = {}
    for row in conn.execute(
        "SELECT block_id FROM block_works WHERE object_id = ? AND work_type_id = ?",
        (object_id, work_type_id),
    ):
        result[row["block_id"]] = percents.get(row["block_id"], 0)
    return result


def board_block_values(conn, object_id: int, track_code: str) -> dict:
    """block_id -> {status, percent, ops: [{id, name, percent, status}, …]}
    по ДОСКЕ «Шахматка» (2026-09-04, замена work_type_block_values) — группе
    операций одного кода трека планирования, входящих в BLOCK_UNITS. Блок
    без единой применимой операции доски в результат не попадает (фронт
    красит его «неприменимо»); у остальных percent/status блока — СРЕДНЕЕ по
    его операциям доски (решение пользователя), а не по какой-то одной."""
    placeholders = ", ".join("?" for _ in BLOCK_UNITS)
    ops = [
        dict(row) for row in conn.execute(
            "SELECT id, name FROM work_types WHERE object_id = ? AND retired_at IS NULL "
            "AND row_kind = 'оп' AND unit IN (%s) AND planning_track_code = ? "
            "ORDER BY sort_order" % placeholders,
            (object_id, *BLOCK_UNITS, track_code),
        )
    ]

    per_block = {}
    for op in ops:
        for block_id, percent in _op_included_percents(conn, object_id, op["id"]).items():
            per_block.setdefault(block_id, []).append({
                "id": op["id"], "name": op["name"], "percent": percent,
                "status": _status_from_percent(percent),
            })

    result = {}
    for block_id, op_list in per_block.items():
        avg = round(sum(o["percent"] for o in op_list) / len(op_list))
        result[block_id] = {"status": _status_from_percent(avg), "percent": avg, "ops": op_list}
    return result


def _user_label(last_name, first_name) -> str:
    return " ".join(p for p in (last_name, first_name) if p) or None


def list_reports(conn, object_id: int, block_id: int) -> list:
    rows = conn.execute(
        "SELECT r.id, r.report_date, r.created_at, r.updated_at, "
        "cu.last_name AS cu_last, cu.first_name AS cu_first, "
        "uu.last_name AS uu_last, uu.first_name AS uu_first "
        "FROM work_fact_reports r "
        "LEFT JOIN users cu ON cu.id = r.created_by "
        "LEFT JOIN users uu ON uu.id = r.updated_by "
        "WHERE r.object_id = ? AND r.block_id = ? ORDER BY r.report_date DESC, r.id DESC",
        (object_id, block_id),
    ).fetchall()
    return [{
        "id": r["id"], "report_date": r["report_date"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "created_by": _user_label(r["cu_last"], r["cu_first"]),
        "updated_by": _user_label(r["uu_last"], r["uu_first"]),
    } for r in rows]


def get_report(conn, object_id: int, block_id: int, report_id: int) -> dict:
    row = conn.execute(
        "SELECT id, report_date FROM work_fact_reports "
        "WHERE id = ? AND object_id = ? AND block_id = ?",
        (report_id, object_id, block_id),
    ).fetchone()
    if row is None:
        raise FactError(404, "Отчёт не найден.")
    items = {
        r["work_type_id"]: r["percent"] for r in conn.execute(
            "SELECT work_type_id, percent FROM work_fact_items WHERE report_id = ?",
            (report_id,))
    }
    return {"id": row["id"], "report_date": row["report_date"], "items": items}


def save_report(conn, object_id: int, user_id: int, block_id: int, report_id, report_date: str,
                items: dict) -> int:
    """items — {work_type_id: percent}, СТРОГО по операциям, выбранным для
    блока — сохраняется весь набор разом, форма всегда шлёт полный слепок."""
    if not report_date:
        raise FactError(422, "Не указана дата отчёта.")
    settings = block_settings(conn, object_id, block_id)
    selected_ids = set(settings["selected"])
    bad = set(items) - selected_ids
    if bad:
        raise FactError(422, "Операции вне отбора для этого блока: %s" % sorted(bad))
    for wt_id, percent in items.items():
        if not isinstance(percent, int) or not (0 <= percent <= 100):
            raise FactError(422, "Процент вне 0..100 у вида работ %s." % wt_id)

    if report_id is None:
        cur = conn.execute(
            "INSERT INTO work_fact_reports (object_id, block_id, report_date, created_by, "
            "updated_by) VALUES (?,?,?,?,?)",
            (object_id, block_id, report_date, user_id, user_id),
        )
        report_id = cur.lastrowid
    else:
        row = conn.execute(
            "SELECT id FROM work_fact_reports WHERE id = ? AND object_id = ? AND block_id = ?",
            (report_id, object_id, block_id),
        ).fetchone()
        if row is None:
            raise FactError(404, "Отчёт не найден.")
        conn.execute(
            "UPDATE work_fact_reports SET report_date = ?, updated_by = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (report_date, user_id, report_id),
        )
        conn.execute("DELETE FROM work_fact_items WHERE report_id = ?", (report_id,))
    # block_work_id — ссылка на ЗР рядом со «старым» work_type_id (этап 1,
    # см. _COLUMN_MIGRATIONS в app/db.py): для новых строк заполняется сразу
    # по тому же block_works, что уже проверил отбор выше (settings), без
    # лишнего запроса.
    bw_by_type = {
        r["work_type_id"]: r["id"] for r in conn.execute(
            "SELECT id, work_type_id FROM block_works WHERE block_id = ?", (block_id,))
    }
    conn.executemany(
        "INSERT INTO work_fact_items (report_id, work_type_id, percent, block_work_id) "
        "VALUES (?,?,?,?)",
        [(report_id, wt_id, percent, bw_by_type.get(wt_id))
         for wt_id, percent in items.items()],
    )
    conn.commit()
    return report_id


def _percents_as_of(conn, block_id: int, report_date: str) -> dict:
    """Тот же принцип, что `_current_percents`, но НА ДАТУ — последний
    отчёт блока с `report_date` не позже указанной, а не вообще самый
    свежий (нужно для отчёта «Отчёты → Учёт по блокам: статусы», где дату
    выбирают, а не всегда смотрят на сегодня)."""
    rows = conn.execute(
        "SELECT i.work_type_id, i.percent FROM work_fact_items i "
        "JOIN work_fact_reports r ON r.id = i.report_id "
        "WHERE r.block_id = ? AND r.report_date <= ? "
        "ORDER BY r.report_date ASC, r.id ASC", (block_id, report_date),
    ).fetchall()
    result = {}
    for row in rows:
        result[row["work_type_id"]] = row["percent"]  # позже в сортировке — победил
    return result


def op_fact_history(conn, object_id: int, block_id: int, work_type_id: int) -> list:
    """История значений факта ОДНОЙ операции на блоке — по всем отчётам, что
    её касаются (живой запрос пользователя: подсказка при наведении на
    полосу прогресса в панели блока — «перечисление дат, значений и
    пользователя»). Схема не хранит, кто менял именно эту строку внутри
    документа (только автора/редактора отчёта целиком, см. docstring
    модуля и `save_report`) — отсюда пользователь тут это создатель отчёта,
    а если отчёт правили позже, то правивший (то же правило, что у
    `list_reports`)."""
    rows = conn.execute(
        "SELECT r.report_date, i.percent, "
        "cu.last_name AS cu_last, cu.first_name AS cu_first, "
        "uu.last_name AS uu_last, uu.first_name AS uu_first "
        "FROM work_fact_items i "
        "JOIN work_fact_reports r ON r.id = i.report_id "
        "LEFT JOIN users cu ON cu.id = r.created_by "
        "LEFT JOIN users uu ON uu.id = r.updated_by "
        "WHERE r.object_id = ? AND r.block_id = ? AND i.work_type_id = ? "
        "ORDER BY r.report_date ASC, r.id ASC",
        (object_id, block_id, work_type_id),
    ).fetchall()
    return [{
        "дата": r["report_date"], "процент": r["percent"],
        "пользователь": _user_label(r["uu_last"], r["uu_first"]) or _user_label(r["cu_last"], r["cu_first"]),
    } for r in rows]


def blocks_fact_changes(conn, object_id: int, date_from: "str | None" = None,
                        date_to: "str | None" = None, track_code: "str | None" = None) -> list:
    """Блоки, у которых факт менялся внутри периода (живой запрос
    пользователя, «Динамика за период») — для подсветки на плане. Область
    сравнения зависит от активной доски «Шахматка» (решение пользователя):
    если она задана — сравниваются только операции ЭТОЙ доски, иначе — все
    операции, отобранные для блока (то же множество, что у
    `block_progress_tree`/`block_summary`). Отдельного лога для этого не
    нужно — `_percents_as_of` уже умеет отдать снимок на любую дату.
    Обе даты необязательны (2026-09-10, живой запрос) — «не выбрано» здесь
    значит «за весь период», а не «отбор снят», поэтому дыры заполняются
    сентинелом/сегодня, а не выходом без результата."""
    from datetime import date
    date_from = date_from or _DYNAMICS_MIN_DATE
    date_to = date_to or date.today().isoformat()
    track_ids = None
    if track_code:
        track_ids = {o["id"] for o in _block_op_work_types(conn, object_id)
                     if o["planning_track_code"] == track_code}
    block_ids = [r["id"] for r in conn.execute(
        "SELECT id FROM blocks WHERE object_id = ?", (object_id,))]
    changed = []
    for block_id in block_ids:
        selected = set(block_settings(conn, object_id, block_id)["selected"])
        relevant = (selected & track_ids) if track_ids is not None else selected
        if not relevant:
            continue
        percents_from = _percents_as_of(conn, block_id, date_from)
        percents_to = _percents_as_of(conn, block_id, date_to)
        if any(percents_from.get(i, 0) != percents_to.get(i, 0) for i in relevant):
            changed.append(block_id)
    return changed


def set_cell_percent(conn, user_id: int, object_id: int, block_id: int, work_type_id: int,
                     percent: int, report_date: str) -> dict:
    """Правка ОДНОЙ ячейки отчёта «Учёт по блокам: статусы» (2026-09-05,
    живой запрос пользователя: «в ячейках устанавливайте процент
    выполнения») — `save_report` принимает только полный слепок операций
    блока разом (форма панели блока и шлёт весь набор), а здесь правится
    одна операция. Слепок собирается на лету: состояние блока НА
    `report_date` (последний отчёт не позже неё, недостающим операциям —
    0) плюс правка этой одной — и уходит в `save_report` как обычно, то
    есть попадает в ТОТ ЖЕ отчёт-документ на эту дату (новый или уже
    существующий), а не в отдельный безымянный след."""
    settings = block_settings(conn, object_id, block_id)
    if work_type_id not in settings["selected"]:
        raise FactError(422, "Операция не выбрана для этого блока — сначала «Настройки».")
    items = _percents_as_of(conn, block_id, report_date)
    for wt_id in settings["selected"]:
        items.setdefault(wt_id, 0)
    items[work_type_id] = percent
    existing = conn.execute(
        "SELECT id FROM work_fact_reports WHERE object_id = ? AND block_id = ? AND report_date = ?",
        (object_id, block_id, report_date),
    ).fetchone()
    save_report(conn, object_id, user_id, block_id,
               existing["id"] if existing else None, report_date, items)
    return {"percent": percent, "status": _status_from_percent(percent)}


def status_report(conn, object_id: int, report_date: "str | None" = None) -> dict:
    """Экран «Отчёты → Учёт по блокам: статусы» (2026-09-05, живой запрос
    пользователя: перенос вкладки «Статусы» из «Учёта по блокам», с правкой
    процента прямо в ячейке) — то же дерево, что у `work_progress.matrix`
    (все виды работ, все единицы, те же колонки блоков/секций), но у
    операций из BLOCK_UNITS («эт/сек», «кв.эт/сек») в ячейке — процент и
    статус НА `report_date` (последний отчёт блока не позже неё), а не
    устаревший клик-цикл: общая матрица их больше не адресует (см.
    `work_progress.py`, docstring `ADDRESSABLE_UNITS`). У «сек»/«компл» —
    как и раньше, ТЕКУЩИЙ статус:
    для них истории по датам не существует вовсе, `work_progress` хранит
    только последнее значение. Пусто — сегодня (тот же приём, что у
    `report_analytics.build_analytics_report`); фактически применённая дата
    возвращается в ответе — форма подхватывает её в свой выбор даты."""
    from datetime import date
    report_date = report_date or date.today().isoformat()
    base = work_progress.matrix(conn, object_id)
    settings_cache, percents_cache = {}, {}

    def selected(block_id):
        if block_id not in settings_cache:
            settings_cache[block_id] = set(block_settings(conn, object_id, block_id)["selected"])
        return settings_cache[block_id]

    def percents(block_id):
        if block_id not in percents_cache:
            percents_cache[block_id] = _percents_as_of(conn, block_id, report_date)
        return percents_cache[block_id]

    def walk(nodes):
        for n in nodes:
            if n["row_kind"] != "узел" and n.get("unit") in BLOCK_UNITS:
                cells = {}
                for b in base["blocks"]:
                    if n["id"] in selected(b["id"]):
                        p = percents(b["id"]).get(n["id"], 0)
                        cells[b["id"]] = {"percent": p, "status": _status_from_percent(p)}
                n["cells"] = cells
                n["addressable"] = True
            walk(n["children"])
    walk(base["tree"])
    return {**base, "report_date": report_date}

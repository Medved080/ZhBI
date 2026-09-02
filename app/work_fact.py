"""
Отбор операций «эт/сек» для конкретного блока и отчёты о фактическом
выполнении (живой запрос пользователя, 2026-09-02) — надстройка над
контуром «Учёт по блокам» (Docs/block-accounting.md) поверх операций с
единицей «эт/сек» конкретно. Для них План/В работе/Выполнено больше не
проставляется кликом-циклом в общей матрице (`work_progress.py`,
`ADDRESSABLE_UNITS`) — источник истины теперь процент отсюда. Для «сек» и
«компл» ничего не меняется, они по-прежнему живут в `work_progress`.

Отбор операций на блоке (`block_work_types`) — ИСКЛЮЧЕНИЕ из общего
списка, а не отдельное состояние по умолчанию: пока блок не настраивали
(`blocks.work_types_configured_at IS NULL`), выбранным считается ВЕСЬ
список «эт/сек»-операций объекта — так вела себя матрица статусов раньше,
отбор её не меняет, пока форму «Настройки» не сохранили явно хоть раз (даже
если сохранённый список совпал с «всё»).

Отчёт о фактическом выполнении — ДОКУМЕНТ на дату, а не строка в
неизменяемом журнале действий: пользователь явно попросил возможность
вернуться к любому прошлому отчёту и исправить зафиксированные в нём
цифры — аналог бумажного отчёта ответственного со стройки. Текущий процент
операции на блоке — значение из отчёта с МАКСИМАЛЬНОЙ `report_date` среди
тех, что её касаются; при равенстве дат — из отчёта с бóльшим id (записан
позже). Отдельный явный журнал действий (`app/activity_actions.py`) эти
отчёты не дублирует — это не тот жанр, документы сами себе журнал.
"""

from app import work_progress
from app.work_progress import UNIT_BLOCK, STATUS_PLAN, STATUS_IN_PROGRESS, STATUS_DONE


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
    """Активные «оп»-строки справочника с единицей «эт/сек» — ровно то,
    из чего вообще может выбирать «Настройки» блока."""
    return [
        dict(row) for row in conn.execute(
            "SELECT id, path, code, name, sort_order FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL AND row_kind = 'оп' AND unit = ? "
            "ORDER BY sort_order", (object_id, UNIT_BLOCK),
        )
    ]


def block_settings(conn, object_id: int, block_id: int) -> dict:
    """Список операций «эт/сек» для формы «Настройки»: все варианты плюс
    те, что сейчас выбраны для блока (или «выбрано всё», если ещё не
    настраивали)."""
    row = conn.execute(
        "SELECT work_types_configured_at FROM blocks WHERE id = ? AND object_id = ?",
        (block_id, object_id),
    ).fetchone()
    if row is None:
        raise FactError(404, "Блок не найден.")
    options = _block_op_work_types(conn, object_id)
    if row["work_types_configured_at"] is None:
        selected = {r["id"] for r in options}
    else:
        selected = {
            r["work_type_id"] for r in conn.execute(
                "SELECT work_type_id FROM block_work_types WHERE block_id = ?", (block_id,))
        }
    return {
        "configured": row["work_types_configured_at"] is not None,
        "options": [{"id": r["id"], "путь": r["path"], "код": r["code"]} for r in options],
        "selected": sorted(selected),
    }


def save_block_settings(conn, object_id: int, block_id: int, work_type_ids: list) -> None:
    if not _block_exists(conn, object_id, block_id):
        raise FactError(404, "Блок не найден.")
    valid_ids = {r["id"] for r in _block_op_work_types(conn, object_id)}
    chosen = valid_ids & set(work_type_ids)
    conn.execute("DELETE FROM block_work_types WHERE block_id = ?", (block_id,))
    conn.executemany(
        "INSERT INTO block_work_types (block_id, work_type_id) VALUES (?, ?)",
        [(block_id, wt_id) for wt_id in chosen],
    )
    conn.execute(
        "UPDATE blocks SET work_types_configured_at = datetime('now') WHERE id = ?",
        (block_id,),
    )
    conn.commit()


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


def block_progress_tree(conn, object_id: int, block_id: int) -> dict:
    """Дерево справочника, обрезанное до предков только выбранных для
    блока операций, с текущим процентом в листьях — для панели блока в
    «Модели МФР»."""
    settings = block_settings(conn, object_id, block_id)
    selected_ids = set(settings["selected"])

    rows = [
        dict(row) for row in conn.execute(
            "SELECT id, parent_id, row_kind, code, name, unit, note, sort_order FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL ORDER BY sort_order", (object_id,))
    ]
    by_id = {r["id"]: r for r in rows}
    keep = set()
    for wt_id in selected_ids:
        cur = wt_id
        while cur is not None and cur not in keep:
            keep.add(cur)
            cur = by_id.get(cur, {}).get("parent_id")

    percents = _current_percents(conn, block_id)

    nodes = {}
    roots = []
    for r in rows:
        if r["id"] not in keep:
            continue
        node = {
            "id": r["id"], "row_kind": r["row_kind"], "code": r["code"], "name": r["name"],
            "unit": r["unit"], "note": r["note"], "children": [],
        }
        if r["id"] in selected_ids:
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


def used_work_types(conn, object_id: int) -> list:
    """Операции «эт/сек», реально применимые хотя бы к одному блоку объекта
    — список для выбора в «Шахматке» (живой запрос пользователя, 2026-09-02).
    Блок без явной настройки использует ВЕСЬ список (см. block_settings) —
    значит, при наличии хоть одного неотнастроенного блока используются
    вообще все операции «эт/сек», отдельно проверять нечего."""
    options = _block_op_work_types(conn, object_id)
    if not options:
        return []
    has_unconfigured = conn.execute(
        "SELECT 1 FROM blocks WHERE object_id = ? AND work_types_configured_at IS NULL",
        (object_id,),
    ).fetchone() is not None
    if not has_unconfigured:
        used_ids = {
            r["work_type_id"] for r in conn.execute(
                "SELECT DISTINCT bwt.work_type_id FROM block_work_types bwt "
                "JOIN blocks b ON b.id = bwt.block_id WHERE b.object_id = ?", (object_id,))
        }
        options = [o for o in options if o["id"] in used_ids]
    # Та же форма, что у block_settings()["options"] — фронт (workTypePathParts)
    # рассчитывает на ключ «путь», а не сырое «path» из _block_op_work_types.
    return [{"id": o["id"], "путь": o["path"], "код": o["code"]} for o in options]


def used_work_types_tree(conn, object_id: int) -> list:
    """То же самое (used_work_types), но деревом — обрезанным до предков
    используемых операций, как block_progress_tree. «Шахматка» выбирает
    операцию иерархическим списком (живой запрос пользователя, 2026-09-02),
    а не плоским: у одноимённых листьев из разных веток («Металлоконструкции»
    встречается дважды) в плоском списке не разобрать, какой из них какой."""
    used_ids = {o["id"] for o in used_work_types(conn, object_id)}
    if not used_ids:
        return []
    rows = [
        dict(row) for row in conn.execute(
            "SELECT id, parent_id, row_kind, name, path FROM work_types "
            "WHERE object_id = ? AND retired_at IS NULL ORDER BY sort_order", (object_id,))
    ]
    by_id = {r["id"]: r for r in rows}
    keep = set()
    for wt_id in used_ids:
        cur = wt_id
        while cur is not None and cur not in keep:
            keep.add(cur)
            cur = by_id.get(cur, {}).get("parent_id")

    nodes = {}
    roots = []
    for r in rows:
        if r["id"] not in keep:
            continue
        node = {"id": r["id"], "row_kind": r["row_kind"], "name": r["name"], "children": []}
        if r["id"] in used_ids:
            node["путь"] = r["path"]
        nodes[r["id"]] = node
        parent = nodes.get(r["parent_id"]) if r["parent_id"] else None
        (parent["children"] if parent else roots).append(node)
    return roots


def work_type_block_values(conn, object_id: int, work_type_id: int) -> dict:
    """block_id -> {percent, status} по ОДНОЙ операции для всех блоков
    объекта, где она входит в отбор — для раскраски «Шахматки». Блок, для
    которого операция вне отбора, в результат не попадает вовсе (фронт
    рисует его отдельным, «неприменимо», видом)."""
    wt = conn.execute(
        "SELECT id FROM work_types WHERE id = ? AND object_id = ? AND retired_at IS NULL "
        "AND row_kind = 'оп' AND unit = ?", (work_type_id, object_id, UNIT_BLOCK),
    ).fetchone()
    if wt is None:
        raise FactError(404, "Операция не найдена.")

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
        "SELECT b.id, CASE WHEN b.work_types_configured_at IS NULL THEN 1 "
        "WHEN bwt.work_type_id IS NOT NULL THEN 1 ELSE 0 END AS included "
        "FROM blocks b LEFT JOIN block_work_types bwt "
        "ON bwt.block_id = b.id AND bwt.work_type_id = ? "
        "WHERE b.object_id = ?", (work_type_id, object_id),
    ):
        if not row["included"]:
            continue
        percent = percents.get(row["id"], 0)
        result[row["id"]] = {"percent": percent, "status": _status_from_percent(percent)}
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
    conn.executemany(
        "INSERT INTO work_fact_items (report_id, work_type_id, percent) VALUES (?,?,?)",
        [(report_id, wt_id, percent) for wt_id, percent in items.items()],
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
    операций «эт/сек» в ячейке — процент и статус НА `report_date`
    (последний отчёт блока не позже неё), а не устаревший клик-цикл: общая
    матрица их больше не адресует (см. `work_progress.py`, docstring
    `ADDRESSABLE_UNITS`). У «сек»/«компл» — как и раньше, ТЕКУЩИЙ статус:
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
            if n["row_kind"] != "узел" and n.get("unit") == UNIT_BLOCK:
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

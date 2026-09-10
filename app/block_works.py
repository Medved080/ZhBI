"""
Запланированная работа по блоку (ЗР) — этап 2 задания
(Docs/block-works-schedule-task.md). Сроки и производные величины поверх
состава работ блока, который завела «Настройки» (`app/work_fact.py`,
таблица `block_works`, этап 1).

Разделение с `app/work_fact.py` — по границе задания: тот отвечает за
ДОКУМЕНТЫ факта (проценты на дату, история), этот — за ЗР как сущность:
сроки, версии актуализации, производные (статус/отклонение/признак сроков),
агрегаты по разделу дерева и по блоку целиком. Импорт — в ОДНУ сторону
(`block_works` читает `work_fact` за процентом), иначе вышел бы цикл:
`work_fact.block_progress_tree` строит дерево и проценты сам, а этот модуль
дополняет уже построенное дерево датами отдельным проходом
(`merge_dates_into_tree`), не заставляя `work_fact` знать о датах вовсе.

Даты в этой версии приходят ТОЛЬКО руками (карточка ЗР, групповая форма
«Сроки») — решение пользователя В4/В8: загрузка графика из xlsx и
пересчёт прогноза по факту в область этапа не входят, появятся отдельными
задачами, когда будет реальный файл заказчика.
"""

import sqlite3
from typing import Optional

from app import activity
from app.db import get_connection
# Приватное имя по месту объявления (`app/work_fact.py`), но статус по
# проценту — один и тот же расчёт что там, что здесь; вторая реализация
# разошлась бы при первой же правке порогов. Тот же приём, что у импорта
# `_shift_planned_before_first_event` в app/element_bulk_edit.py.
from app.work_fact import (
    FactError, _status_from_percent, list_reports_with_percent, item_edit_history,
)
# Тоже приватное имя по месту объявления (`app/schedule_versions.py`) — то
# же вычисление «разница в днях, устойчивая к пустой/битой дате», что у
# отклонения графика СМР ЖБИ; своя копия разошлась бы при первой же правке.
from app.schedule_versions import _days_between

router_prefix = "/objects/{object_id}/block-works"  # см. регистрацию маршрутов в app/main.py

# ---------------------------------------------------------------- признак сроков

DEADLINE_ON_TRACK = "on_track"
DEADLINE_BEHIND = "behind"
DEADLINE_OVERDUE = "overdue"
DEADLINE_NOT_STARTED = "not_started_on_time"
DEADLINE_NO_DATES = "no_dates"

DEADLINE_LABELS_RU = {
    DEADLINE_ON_TRACK: "в графике",
    DEADLINE_BEHIND: "отстаёт",
    DEADLINE_OVERDUE: "просрочена",
    DEADLINE_NOT_STARTED: "не начата в срок",
    DEADLINE_NO_DATES: "без сроков",
}
# Порядок — от самого тревожного к спокойному: используется и как приоритет
# классификации одной ЗР (см. _deadline_flag), и как порядок «худшего
# признака» при раскраске доски по срокам (этап 3, не в этом файле).
DEADLINE_ORDER = (DEADLINE_OVERDUE, DEADLINE_NOT_STARTED, DEADLINE_BEHIND,
                  DEADLINE_ON_TRACK, DEADLINE_NO_DATES)


def _deadline_flag(plan_start, plan_end, percent: int, today: str,
                   deviation_start, deviation_end) -> str:
    """Один признак на ЗР — приоритет от самого тревожного (Docs/
    block-works-schedule-task.md §4). «Просрочена» проверяется РАНЬШЕ «не
    начата в срок»: у операции с percent=0, чей plan_end уже прошёл,
    сработали бы оба условия разом — «просрочена» точнее описывает эту
    ЗР (дедлайн целиком упущен), «не начата в срок» — для более раннего
    предупреждения, когда plan_end ещё не наступил, а plan_start уже прошёл
    и работы нет."""
    if not plan_start and not plan_end:
        return DEADLINE_NO_DATES
    if plan_end and today > plan_end[:10] and percent < 100:
        return DEADLINE_OVERDUE
    if plan_start and today > plan_start[:10] and percent == 0:
        return DEADLINE_NOT_STARTED
    if (deviation_end is not None and deviation_end > 0) or \
       (deviation_start is not None and deviation_start > 0):
        return DEADLINE_BEHIND
    return DEADLINE_ON_TRACK


def _expected_percent(plan_start, plan_end, today: str) -> "int | None":
    """Ожидаемый процент на дату — линейно между plan_start и plan_end
    (§4). Нет обеих дат — сравнивать не с чем, None (не 0 — 0 читался бы
    как «должны были ещё не начать», а на деле «неизвестно»)."""
    if not plan_start or not plan_end:
        return None
    from datetime import date
    try:
        s = date.fromisoformat(plan_start[:10])
        e = date.fromisoformat(plan_end[:10])
        t = date.fromisoformat(today[:10])
    except (ValueError, TypeError):
        return None
    if e <= s:
        return 100 if t >= e else 0
    if t <= s:
        return 0
    if t >= e:
        return 100
    return round(100 * (t - s).days / (e - s).days)


def derive(zr: dict, percent: int, today: str) -> dict:
    """Производные величины ОДНОЙ ЗР (§4) — статус, отклонение по обеим
    датам, признак сроков, ожидаемый процент. Ничего не хранится, считается
    на лету из сырых полей `block_works` + текущего процента."""
    deviation_start = _days_between(zr.get("plan_start"), zr.get("forecast_start"))
    deviation_end = _days_between(zr.get("plan_end"), zr.get("forecast_end"))
    deadline = _deadline_flag(zr.get("plan_start"), zr.get("plan_end"), percent, today,
                              deviation_start, deviation_end)
    return {
        "plan_start": zr.get("plan_start"), "plan_end": zr.get("plan_end"),
        "forecast_start": zr.get("forecast_start"), "forecast_end": zr.get("forecast_end"),
        "forecast_at": zr.get("forecast_at"),
        "deviation_start": deviation_start, "deviation_end": deviation_end,
        "deadline": deadline, "deadline_label": DEADLINE_LABELS_RU[deadline],
        "expected_percent": _expected_percent(zr.get("plan_start"), zr.get("plan_end"), today),
        "status": _status_from_percent(percent), "percent": percent,
    }


# ---------------------------------------------------------------- дерево карточки блока

def _block_dates_by_work_type(conn: sqlite3.Connection, block_id: int) -> dict:
    return {
        r["work_type_id"]: dict(r) for r in conn.execute(
            "SELECT * FROM block_works WHERE block_id = ?", (block_id,))
    }


def _widen(agg: dict, key: str, value, extreme) -> None:
    if not value:
        return
    agg[key] = value if agg[key] is None else extreme(agg[key], value)


def _merge_node(node: dict, dates_by_wt: dict, today: str) -> tuple:
    """Мутирует ОДИН узел дерева `work_fact.block_progress_tree` — лист
    (операция) получает даты/отклонение/признак сроков из своей ЗР, раздел
    получает агрегат по потомкам (§4: план=min/max, прогноз=min/max,
    факт=среднее процентов, статус по порогам от среднего; ЗР без дат в
    min/max не участвуют). Возвращает (агрегат дат узла, список процентов
    его листьев) — вызывающий использует это для сборки агрегата ВЫШЕ."""
    agg = {"plan_start": None, "plan_end": None, "forecast_start": None, "forecast_end": None}
    if not node["children"]:
        if "percent" not in node:
            return agg, []
        zr = dates_by_wt.get(node["id"])
        if zr:
            d = derive(zr, node["percent"], today)
            node.update(d)
            node["block_work_id"] = zr["id"]
            for key, extreme in (("plan_start", min), ("plan_end", max),
                                 ("forecast_start", min), ("forecast_end", max)):
                _widen(agg, key, d[key], extreme)
        return agg, [node["percent"]]

    percents = []
    for child in node["children"]:
        child_agg, child_percents = _merge_node(child, dates_by_wt, today)
        for key, extreme in (("plan_start", min), ("plan_end", max),
                             ("forecast_start", min), ("forecast_end", max)):
            _widen(agg, key, child_agg[key], extreme)
        percents.extend(child_percents)
    node["plan_start"], node["plan_end"] = agg["plan_start"], agg["plan_end"]
    node["forecast_start"], node["forecast_end"] = agg["forecast_start"], agg["forecast_end"]
    node["percent"] = round(sum(percents) / len(percents)) if percents else None
    node["status"] = _status_from_percent(node["percent"]) if node["percent"] is not None else None
    return agg, percents


def merge_dates_into_tree(conn: sqlite3.Connection, block_id: int, tree_roots: list,
                          today: str) -> dict:
    """Точка входа: обходит корни дерева, уже построенного
    `work_fact.block_progress_tree` (percent/status в листьях), добавляет в
    каждый лист даты и признак сроков, в каждый раздел — агрегат по
    потомкам. Возвращает агрегат по ПЕРЕДАННЫМ корням целиком — им
    заполняется шапка карточки блока. Только для обычного режима (не
    «Динамика за период» — там в узлах percent_from/percent_to, а не
    percent, сроки туда не примешиваются)."""
    dates_by_wt = _block_dates_by_work_type(conn, block_id)
    agg = {"plan_start": None, "plan_end": None, "forecast_start": None, "forecast_end": None}
    percents = []
    for root in tree_roots:
        child_agg, child_percents = _merge_node(root, dates_by_wt, today)
        for key, extreme in (("plan_start", min), ("plan_end", max),
                             ("forecast_start", min), ("forecast_end", max)):
            _widen(agg, key, child_agg[key], extreme)
        percents.extend(child_percents)
    agg["percent"] = round(sum(percents) / len(percents)) if percents else None
    agg["status"] = _status_from_percent(agg["percent"]) if agg["percent"] is not None else None
    agg["zr_count"] = len(percents)
    return agg


def block_dates_summary(conn: sqlite3.Connection, object_id: int, block_id: int,
                        today: str) -> dict:
    """Тот же агрегат, что `merge_dates_into_tree`, но плоский — для
    простой карточки блока (`GET /blocks/{id}/card`), которой дерево не
    нужно вовсе."""
    from app.work_fact import _current_percents
    dates_by_wt = _block_dates_by_work_type(conn, block_id)
    percents_map = _current_percents(conn, block_id)
    agg = {"plan_start": None, "plan_end": None, "forecast_start": None, "forecast_end": None}
    percents = []
    for wt_id, zr in dates_by_wt.items():
        percent = percents_map.get(wt_id, 0)
        d = derive(zr, percent, today)
        for key, extreme in (("plan_start", min), ("plan_end", max),
                             ("forecast_start", min), ("forecast_end", max)):
            _widen(agg, key, d[key], extreme)
        percents.append(percent)
    agg["percent"] = round(sum(percents) / len(percents)) if percents else None
    agg["status"] = _status_from_percent(agg["percent"]) if agg["percent"] is not None else None
    agg["zr_count"] = len(percents)
    return agg


# ---------------------------------------------------------------- список / карточка ЗР

def _row_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "object_id": row["object_id"], "block_id": row["block_id"],
        "work_type_id": row["work_type_id"], "путь": row["wt_path"], "код": row["wt_code"],
        "название": row["wt_name"], "unit": row["wt_unit"],
        "track_code": row["planning_track_code"],
        "section_code": row["section_code"], "level_floor": row["level_floor"],
        "plan_start": row["plan_start"], "plan_end": row["plan_end"],
        "forecast_start": row["forecast_start"], "forecast_end": row["forecast_end"],
        "forecast_at": row["forecast_at"], "note": row["note"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "retired_at": row["retired_at"],
    }


def _list_rows(conn: sqlite3.Connection, object_id: int, block_ids: Optional[list],
               track_code: Optional[str], *, include_retired: bool = False) -> list:
    # retired_at IS NULL по умолчанию (В7, этап 4) — снятая «Настройками»
    # операция не должна попадать в активные списки/отчёты/доску, хотя
    # строка и сохранена ради истории. include_retired=True — только для
    # карточки ОДНОЙ ЗР по id (get_block_work): туда обязаны попадать и
    # снятые, историю по ним смотрят так же, как по активным.
    clauses = ["bw.object_id = ?"] if include_retired else ["bw.object_id = ?", "bw.retired_at IS NULL"]
    params: list = [object_id]
    if block_ids:
        clauses.append(f"bw.block_id IN ({','.join('?' * len(block_ids))})")
        params.extend(block_ids)
    if track_code:
        clauses.append("wt.planning_track_code = ?")
        params.append(track_code)
    return conn.execute(
        f"""
        SELECT bw.*, wt.path AS wt_path, wt.name AS wt_name, wt.unit AS wt_unit,
               wt.code AS wt_code, wt.planning_track_code, wt.sort_order AS wt_sort,
               s.code AS section_code, s.sort_order AS section_sort,
               l.floor AS level_floor, l.sort_order AS level_sort
        FROM block_works bw
        JOIN work_types wt ON wt.id = bw.work_type_id
        JOIN blocks b ON b.id = bw.block_id
        JOIN object_sections s ON s.id = b.section_id
        JOIN object_levels l ON l.id = b.level_id
        WHERE {' AND '.join(clauses)}
        ORDER BY s.sort_order, l.sort_order, wt.sort_order
        """,
        params,
    ).fetchall()


def list_block_works(conn: sqlite3.Connection, object_id: int, today: str, *,
                     block_ids: Optional[list] = None, track_code: Optional[str] = None,
                     status: Optional[list] = None, deadline: Optional[list] = None) -> list:
    """Список ЗР с производными — общий источник для карточки, будущих
    фильтров и отчётов (§5). `status`/`deadline` — отбор СПИСКАМИ значений,
    применяется уже к посчитанным производным (иначе пороги считались бы в
    SQL и разошлись бы с derive() при первой же правке)."""
    from app.work_fact import current_percents_by_block_work
    percents = current_percents_by_block_work(conn, object_id)
    out = []
    for row in _list_rows(conn, object_id, block_ids, track_code):
        d = _row_dict(row)
        percent = percents.get(row["id"], 0)
        d.update(derive(d, percent, today))
        if status and d["status"] not in status:
            continue
        if deadline and d["deadline"] not in deadline:
            continue
        out.append(d)
    return out


def active_counts(conn: sqlite3.Connection, object_id: int) -> dict:
    """block_id -> число активных ЗР (`retired_at IS NULL`), одним запросом
    на объект — для колонки счётчика в списке блоков вкладки
    «Запланированные работы» (живой запрос пользователя, 2026-09-10:
    «счётчики загружай агрегированно, без отдельного запроса на каждый
    блок»). Блок без единой строки просто отсутствует в результате —
    вызывающий код должен различать «0» (был в ответе `blocks`, но не в
    этом словаре) и «ещё не спрошено» сам, здесь только сырые числа."""
    return {
        r["block_id"]: r["n"] for r in conn.execute(
            "SELECT block_id, COUNT(*) AS n FROM block_works "
            "WHERE object_id = ? AND retired_at IS NULL GROUP BY block_id",
            (object_id,),
        )
    }


def get_block_work(conn: sqlite3.Connection, object_id: int, bw_id: int, today: str) -> dict:
    rows = _list_rows(conn, object_id, None, None, include_retired=True)
    row = next((r for r in rows if r["id"] == bw_id), None)
    if row is None:
        raise FactError(404, "Запланированная работа не найдена.")
    from app.work_fact import current_percents_by_block_work
    percent = current_percents_by_block_work(conn, object_id).get(bw_id, 0)
    d = _row_dict(row)
    d.update(derive(d, percent, today))

    def _user_label(uid):
        if not uid:
            return None
        u = conn.execute("SELECT last_name, first_name FROM users WHERE id = ?", (uid,)).fetchone()
        return " ".join(p for p in (u["last_name"], u["first_name"]) if p) if u else None

    d["created_by"] = _user_label(row["created_by"])
    d["updated_by"] = _user_label(row["updated_by"])
    d["forecast_by"] = _user_label(row["forecast_by"])
    d["versions"] = [
        {"id": v["id"], "forecast_start": v["forecast_start"], "forecast_end": v["forecast_end"],
         "created_at": v["created_at"], "created_by": _user_label(v["created_by"]),
         "note": v["note"]}
        for v in conn.execute(
            "SELECT * FROM block_work_forecasts WHERE block_work_id = ? "
            "ORDER BY created_at DESC, id DESC", (bw_id,))
    ]
    # Документы факта блока с процентом ИМЕННО этой операции в каждом —
    # интерактивный список карточки ЗР (живой запрос пользователя,
    # 2026-09-10): не только читается, но и правится/удаляется прямо
    # отсюда (правка — тот же «Факт» блока, открытый на нужном отчёте;
    # удаление — DELETE .../fact-reports/{id}).
    d["документы_факта"] = list_reports_with_percent(
        conn, object_id, row["block_id"], row["work_type_id"])
    # Построчная история правок (этап 4, В6) — отдельно от документов
    # факта выше: та один снимок на отчёт (дата → процент), эта — каждая
    # правка внутри уже сохранённого документа (было X% → стало Y%, в т.ч.
    # несколько за один день).
    d["история_правок"] = item_edit_history(conn, bw_id)
    return d


# ---------------------------------------------------------------- правка

def _log_plan_set(user_id, object_id, block_id, old, new) -> None:
    activity.log("block_work_plan_set", user_id=user_id, entity_type="object", entity_id=object_id,
                old_value=f"план: {old[0] or '—'}..{old[1] or '—'}",
                new_value=f"план: {new[0] or '—'}..{new[1] or '—'}",
                details={"block_id": block_id})


def _save_forecast_version(conn, bw_id, object_id, block_id, user_id, forecast_start,
                           forecast_end, note) -> None:
    conn.execute(
        "INSERT INTO block_work_forecasts (block_work_id, forecast_start, forecast_end, "
        "created_by, note) VALUES (?,?,?,?,?)",
        (bw_id, forecast_start, forecast_end, user_id, note),
    )
    conn.execute(
        "UPDATE block_works SET forecast_start = ?, forecast_end = ?, "
        "forecast_at = datetime('now'), forecast_by = ?, "
        "updated_at = datetime('now'), updated_by = ? WHERE id = ?",
        (forecast_start, forecast_end, user_id, user_id, bw_id),
    )
    activity.log("block_work_forecast_set", user_id=user_id, entity_type="object",
                entity_id=object_id,
                new_value=f"прогноз: {forecast_start or '—'}..{forecast_end or '—'}",
                details={"block_id": block_id, "block_work_id": bw_id})


_UNSET = object()


def update_block_work(conn: sqlite3.Connection, object_id: int, bw_id: int, user_id: int, *,
                      plan_start=_UNSET, plan_end=_UNSET, note=_UNSET,
                      forecast_start=_UNSET, forecast_end=_UNSET) -> dict:
    """PATCH карточки ЗР — правка директивных сроков (сразу, с журналом
    старое/новое — §3: «базовая дата... меняется только явной правкой»),
    примечания (тем же полем реквизитов, своего кода в журнале не заведено
    — не самостоятельное действие) и актуализированных сроков (НОВАЯ версия
    в block_work_forecasts, а не перезапись — §2.3, накопление, как у
    графика СМР ЖБИ)."""
    row = conn.execute(
        "SELECT * FROM block_works WHERE id = ? AND object_id = ?", (bw_id, object_id)
    ).fetchone()
    if row is None:
        raise FactError(404, "Запланированная работа не найдена.")

    plan_changed = plan_start is not _UNSET or plan_end is not _UNSET
    new_plan_start = row["plan_start"] if plan_start is _UNSET else plan_start
    new_plan_end = row["plan_end"] if plan_end is _UNSET else plan_end
    note_changed = note is not _UNSET and note != row["note"]
    new_note = row["note"] if note is _UNSET else note

    if plan_changed and (new_plan_start != row["plan_start"] or new_plan_end != row["plan_end"]):
        _log_plan_set(user_id, object_id, row["block_id"],
                     (row["plan_start"], row["plan_end"]), (new_plan_start, new_plan_end))
        conn.execute(
            "UPDATE block_works SET plan_start = ?, plan_end = ?, note = ?, "
            "updated_at = datetime('now'), updated_by = ? WHERE id = ?",
            (new_plan_start, new_plan_end, new_note, user_id, bw_id),
        )
    elif note_changed:
        conn.execute(
            "UPDATE block_works SET note = ?, updated_at = datetime('now'), updated_by = ? "
            "WHERE id = ?", (new_note, user_id, bw_id),
        )

    if forecast_start is not _UNSET or forecast_end is not _UNSET:
        new_fs = row["forecast_start"] if forecast_start is _UNSET else forecast_start
        new_fe = row["forecast_end"] if forecast_end is _UNSET else forecast_end
        if new_fs != row["forecast_start"] or new_fe != row["forecast_end"]:
            _save_forecast_version(conn, bw_id, object_id, row["block_id"], user_id,
                                   new_fs, new_fe, None)
    conn.commit()
    from datetime import date
    return get_block_work(conn, object_id, bw_id, date.today().isoformat())


def bulk_edit(conn: sqlite3.Connection, object_id: int, user_id: int, bw_ids: list, op: str, *,
             field: Optional[str] = None, days: Optional[int] = None) -> dict:
    """Групповая правка сроков — форма «Сроки» (§6.2):

    * `op="shift"` — сдвинуть `field` ("plan"/"forecast") на `days` дней у
      ВСЕХ переданных ЗР сразу; пустая дата сдвигу не подлежит (сдвигать
      нечего, не 0 + days).
    * `op="forecast_equals_plan"` — актуализированный срок = директивному,
      ТОЛЬКО у ещё не начатых (percent == 0, §6.2) — начатую работу «сроки
      подровнять под план» молча стирает уже идущий факт-прогноз, это не
      то же самое действие.

    Одна запись в журнале на весь вызов (`block_work_bulk_edit`), а не по
    записи на строку — список бывает в десятки ЗР, журнал ими не заводят
    (тот же приём, что у массовой правки статуса в других местах проекта).
    """
    if not bw_ids:
        raise FactError(422, "Не выбрана ни одна запланированная работа.")
    if op == "shift":
        if field not in ("plan", "forecast"):
            raise FactError(422, "Для сдвига укажите field: 'plan' или 'forecast'.")
        if not isinstance(days, int) or days == 0:
            raise FactError(422, "Укажите ненулевой сдвиг в днях.")
        затронуто = _bulk_shift(conn, object_id, user_id, bw_ids, field, days)
    elif op == "forecast_equals_plan":
        затронуто = _bulk_forecast_equals_plan(conn, object_id, user_id, bw_ids)
    else:
        raise FactError(422, "Неизвестная групповая операция «%s»." % op)
    conn.commit()
    activity.log("block_work_bulk_edit", user_id=user_id, entity_type="object",
                entity_id=object_id,
                details={"op": op, "field": field, "days": days,
                        "requested": len(bw_ids), "changed": затронуто})
    return {"requested": len(bw_ids), "changed": затронуто}


def _shift_date(value, days: int):
    if not value:
        return value
    from datetime import date, timedelta
    return (date.fromisoformat(value[:10]) + timedelta(days=days)).isoformat()


def _bulk_shift(conn, object_id, user_id, bw_ids, field, days) -> int:
    rows = conn.execute(
        f"SELECT * FROM block_works WHERE object_id = ? AND id IN "
        f"({','.join('?' * len(bw_ids))})", (object_id, *bw_ids),
    ).fetchall()
    затронуто = 0
    for row in rows:
        if field == "plan":
            new_start, new_end = _shift_date(row["plan_start"], days), _shift_date(row["plan_end"], days)
            if new_start == row["plan_start"] and new_end == row["plan_end"]:
                continue
            conn.execute(
                "UPDATE block_works SET plan_start = ?, plan_end = ?, "
                "updated_at = datetime('now'), updated_by = ? WHERE id = ?",
                (new_start, new_end, user_id, row["id"]),
            )
        else:
            new_start, new_end = _shift_date(row["forecast_start"], days), _shift_date(row["forecast_end"], days)
            if new_start == row["forecast_start"] and new_end == row["forecast_end"]:
                continue
            _save_forecast_version(conn, row["id"], object_id, row["block_id"], user_id,
                                   new_start, new_end, "групповой сдвиг на %+d дн." % days)
        затронуто += 1
    return затронуто


def board_block_deviation_by_track(conn: sqlite3.Connection, object_id: int, track_code: str,
                                   today: str) -> dict:
    """Обе сводки доски «Шахматка» разом — по выполнению (среднее
    процентов, как раньше отдавала `work_fact.board_block_values`) и по
    срокам (худший признак среди её операций на блоке, DEADLINE_ORDER) —
    §6.4 задания: «не дёргать сервер при переключении режима».

    Обёртка НАД `work_fact.board_block_values`, не самостоятельный запрос:
    список операций доски, их отбор на блок (`block_works`, но с точки
    зрения СОСТАВА, не сроков) и текущий процент по ним уже считает она —
    здесь только доклеиваются даты поверх готового ответа, тем же приёмом,
    что `merge_dates_into_tree` поверх дерева `block_progress_tree`."""
    from app import work_fact as _work_fact
    base = _work_fact.board_block_values(conn, object_id, track_code)
    dates_cache: dict = {}
    for block_id, entry in base.items():
        if block_id not in dates_cache:
            dates_cache[block_id] = _block_dates_by_work_type(conn, block_id)
        dates_by_wt = dates_cache[block_id]
        worst = None
        for op in entry["ops"]:
            zr = dates_by_wt.get(op["id"])
            d = derive(zr, op["percent"], today) if zr else None
            op["deviation_end"] = d["deviation_end"] if d else None
            op["deadline"] = d["deadline"] if d else DEADLINE_NO_DATES
            op["deadline_label"] = DEADLINE_LABELS_RU[op["deadline"]]
            if worst is None or DEADLINE_ORDER.index(op["deadline"]) < DEADLINE_ORDER.index(worst):
                worst = op["deadline"]
        entry["deadline"] = worst or DEADLINE_NO_DATES
        entry["deadline_label"] = DEADLINE_LABELS_RU[entry["deadline"]]
    return base


def status_report_with_deadlines(conn: sqlite3.Connection, object_id: int,
                                 report_date: "str | None", today: str) -> dict:
    """Отчёт «Учёт по блокам: статусы» (§6.5 задания, этап 5) — та же
    обёртка-поверх-готового, что у доски «Шахматки»: `work_fact.
    status_report` уже считает дерево и процент НА ДАТУ, здесь только
    доклеиваются план/прогноз/отклонение в ячейки BLOCK_UNITS, чтобы
    переключатель показа на фронте (процент/план/прогноз/отклонение) не
    ходил на сервер повторно. Правка ячейки (PUT .../work-progress-cell)
    по-прежнему работает только с процентом — эта надстройка его не трогает."""
    from app import work_fact as _work_fact
    from app.work_progress import BLOCK_UNITS
    report = _work_fact.status_report(conn, object_id, report_date)
    dates_cache: dict = {}

    def walk(nodes):
        for n in nodes:
            if n.get("unit") in BLOCK_UNITS and "cells" in n:
                for block_id, cell in n["cells"].items():
                    if block_id not in dates_cache:
                        dates_cache[block_id] = _block_dates_by_work_type(conn, block_id)
                    zr = dates_cache[block_id].get(n["id"])
                    if zr:
                        d = derive(zr, cell["percent"], today)
                        cell.update({k: d[k] for k in (
                            "plan_start", "plan_end", "forecast_start", "forecast_end",
                            "deviation_start", "deviation_end", "deadline", "deadline_label",
                            "expected_percent")})
                    else:
                        cell.update({
                            "plan_start": None, "plan_end": None, "forecast_start": None,
                            "forecast_end": None, "deviation_start": None, "deviation_end": None,
                            "deadline": DEADLINE_NO_DATES,
                            "deadline_label": DEADLINE_LABELS_RU[DEADLINE_NO_DATES],
                            "expected_percent": None,
                        })
            walk(n.get("children") or [])

    walk(report["tree"])
    return report


def _bulk_forecast_equals_plan(conn, object_id, user_id, bw_ids) -> int:
    from app.work_fact import current_percents_by_block_work
    percents = current_percents_by_block_work(conn, object_id)
    rows = conn.execute(
        f"SELECT * FROM block_works WHERE object_id = ? AND id IN "
        f"({','.join('?' * len(bw_ids))})", (object_id, *bw_ids),
    ).fetchall()
    затронуто = 0
    for row in rows:
        if percents.get(row["id"], 0) != 0:
            continue  # уже начата — не трогаем (см. docstring bulk_edit)
        if row["forecast_start"] == row["plan_start"] and row["forecast_end"] == row["plan_end"]:
            continue
        _save_forecast_version(conn, row["id"], object_id, row["block_id"], user_id,
                               row["plan_start"], row["plan_end"], "прогноз = план (групповая правка)")
        затронуто += 1
    return затронуто

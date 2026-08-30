"""
Версии графика СМР: базовый, актуализированные, отклонение (2026-08-14).

Зачем. До этой даты график жил двумя полями изделия
(`project_smr_start_date` / `project_delivery_date`), и загрузка нового
файла затирала предыдущий. У заказчика устроено иначе (совещание
2026-08-14, `Docs/requirements-2026-08-14.md`, блок E):

* **базовый** график — директивные даты, «когда это надо»; не меняется;
* **актуализированный** — пересчитывается снаружи раз в неделю и отвечает
  на другой вопрос: «насколько мы отстаём».

Отставание — это разница между ними, а последовательность актуализаций
показывает, как менялся прогноз («две недели назад обещали 1 февраля,
сейчас 15-е»). Поэтому версии НАКАПЛИВАЮТСЯ.

Что где хранится. Даты каждой версии — в `schedule_version_dates`. Поля
изделия остались источником правды для БАЗОВЫХ дат и никуда не уехали: на
них держатся фильтры, подписи, отчёты и аналитическая справка, и перенос их
в таблицу версий означал бы переписать половину системы ради истории
прогнозов. Базовая версия хранится ВДОБАВОК к полям — чтобы после ручной
правки поля было с чем сравнивать.

Отклонение считается ПО ОБЕИМ датам (решение пользователя 2026-08-14): и по
началу СМР (когда изделие должно быть на площадке), и по завершению
(монтаж). Знак — «плюс = позже базового», то есть отставание; минус —
опережение.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import assert_object_feature, is_system_admin
from app.auth import get_current_user
from app.db import get_connection

router = APIRouter(prefix="/schedule-versions", tags=["schedule"])

KIND_LABELS = {"baseline": "Базовый", "current": "Актуализированный"}


def _days_between(a: Optional[str], b: Optional[str]) -> Optional[int]:
    """Разница b − a в днях; None, если хоть одной даты нет или она битая.

    Битая дата здесь — не исключение: в версию попадает то, что разобрал
    импорт, а сравнение обязано пережить одну испорченную строку и посчитать
    остальные (тот же приём, что у _ru_date_short в app/reports.py)."""
    if not a or not b:
        return None
    from datetime import date
    try:
        return (date.fromisoformat(str(b)[:10]) - date.fromisoformat(str(a)[:10])).days
    except (ValueError, TypeError):
        return None


def list_versions(conn: sqlite3.Connection, object_id: int) -> list:
    rows = conn.execute(
        """
        SELECT v.id, v.kind, v.title, v.source_file, v.origin, v.loaded_at, v.note,
               u.last_name AS loaded_by_last, u.first_name AS loaded_by_first,
               (SELECT COUNT(*) FROM schedule_version_dates d WHERE d.version_id = v.id) AS elements
        FROM schedule_versions v
        LEFT JOIN users u ON u.id = v.loaded_by
        WHERE v.object_id = ?
        ORDER BY v.kind = 'baseline' DESC, v.loaded_at DESC, v.id DESC
        """,
        (object_id,),
    ).fetchall()
    out = []
    for r in rows:
        кто = " ".join(x for x in [r["loaded_by_last"], r["loaded_by_first"]] if x)
        out.append({
            "id": r["id"], "kind": r["kind"], "kind_label": KIND_LABELS.get(r["kind"], r["kind"]),
            "title": r["title"], "source_file": r["source_file"], "origin": r["origin"],
            "loaded_at": r["loaded_at"], "loaded_by": кто or None,
            "note": r["note"], "elements": r["elements"],
        })
    return out


def latest_current_id(conn: sqlite3.Connection, object_id: int) -> Optional[int]:
    """Последняя актуализация объекта — она и есть «текущий прогноз».

    Порядок — по времени загрузки, при равном времени по id: две версии,
    загруженные в одну секунду (перезалили файл), иначе менялись бы
    местами от запроса к запросу.
    """
    row = conn.execute(
        "SELECT id FROM schedule_versions WHERE object_id = ? AND kind = 'current' "
        "ORDER BY loaded_at DESC, id DESC LIMIT 1",
        (object_id,),
    ).fetchone()
    return row["id"] if row else None


# ---------------------------------------------- прогноз в отчётах (2026-08-30)
#
# «Требуемая дата поставки» в «Статусе комплектации» — это «Начало СМР
# (прогноз)» из АКТУАЛИЗИРОВАННОГО графика, а не поле изделия
# `project_smr_start_date` (живой запрос 2026-08-30). Поле хранит
# ДИРЕКТИВНЫЙ срок — то, что обещали изначально; к какому числу изделие
# реально нужно на площадке, говорит текущий прогноз, и снабжение работает
# по нему. На обезличенной копии директивная дата и прогноз расходятся у
# 9148 изделий из 9151 — то есть колонка меняла смысл целиком.
#
# Версия ищется по ОБЪЕКТУ ИЗДЕЛИЯ, а не одна на запрос: в отбор отчёта
# попадают изделия разных объектов, и у каждого своя последняя
# актуализация. Порядок выбора — тот же, что в latest_current_id (loaded_at,
# при равенстве id): иначе карточка изделия и отчёт показывали бы разные
# даты одного и того же изделия.
#
# Дублей джойн не даёт — ключ `schedule_version_dates` это (version_id,
# element_id), а версия здесь ровно одна. Алиасы фиксированы: `e` —
# elements, `f` — даты прогноза; так же они названы в обоих отчётах.
FORECAST_JOIN = """
        LEFT JOIN schedule_version_dates f
               ON f.element_id = e.id
              AND f.version_id = (SELECT v.id FROM schedule_versions v
                                  WHERE v.object_id = e.object_id AND v.kind = 'current'
                                  ORDER BY v.loaded_at DESC, v.id DESC LIMIT 1)
"""

# Само выражение с прогнозной датой начала СМР — чтобы отчёты не повторяли
# имя алиаса своими строками.
FORECAST_START = "f.smr_start_date"


def baseline_id(conn: sqlite3.Connection, object_id: int) -> Optional[int]:
    row = conn.execute(
        "SELECT id FROM schedule_versions WHERE object_id = ? AND kind = 'baseline'",
        (object_id,),
    ).fetchone()
    return row["id"] if row else None


def element_deviation(conn: sqlite3.Connection, element_id: int) -> Optional[dict]:
    """Прогноз и отклонение по ОДНОМУ изделию — для карточки изделия.

    База берётся из ПОЛЕЙ изделия, а не из базовой версии: поля — источник
    правды директивных дат, их правят руками, и карточка обязана показывать
    отклонение от того, что в ней же написано выше.
    """
    el = conn.execute(
        "SELECT object_id, project_smr_start_date, project_delivery_date FROM elements WHERE id = ?",
        (element_id,),
    ).fetchone()
    if el is None or el["object_id"] is None:
        return None
    version_id = latest_current_id(conn, el["object_id"])
    if version_id is None:
        return None
    d = conn.execute(
        "SELECT smr_start_date, smr_end_date FROM schedule_version_dates "
        "WHERE version_id = ? AND element_id = ?",
        (version_id, element_id),
    ).fetchone()
    if d is None:
        return None
    v = conn.execute(
        "SELECT title, loaded_at FROM schedule_versions WHERE id = ?", (version_id,)
    ).fetchone()
    return {
        "version_id": version_id,
        "version_title": v["title"] if v else None,
        "loaded_at": v["loaded_at"] if v else None,
        "forecast_start": d["smr_start_date"],
        "forecast_end": d["smr_end_date"],
        "base_start": el["project_smr_start_date"],
        "base_end": el["project_delivery_date"],
        "deviation_start": _days_between(el["project_smr_start_date"], d["smr_start_date"]),
        "deviation_end": _days_between(el["project_delivery_date"], d["smr_end_date"]),
    }


def deviation_summary(conn: sqlite3.Connection, object_id: int,
                      element_ids: Optional[list] = None,
                      version_id: Optional[int] = None) -> dict:
    """Сводка отклонения по объекту (или по переданному срезу изделий).

    element_ids — тот же приём, что у отчётов: критерии фильтра живут на
    клиенте, сервер получает готовый список id. None — весь объект.
    """
    version_id = version_id or latest_current_id(conn, object_id)
    if version_id is None:
        return {"version_id": None, "elements": 0, "start": None, "end": None, "by_zakhvatka": []}

    clauses = ["d.version_id = ?", "e.object_id = ?"]
    params = [version_id, object_id]
    if element_ids is not None:
        if not element_ids:
            clauses.append("1=0")
        else:
            clauses.append(f"e.id IN ({','.join('?' * len(element_ids))})")
            params.extend(element_ids)

    rows = conn.execute(
        f"""
        SELECT e.id, e.project_smr_start_date AS base_start, e.project_delivery_date AS base_end,
               d.smr_start_date AS f_start, d.smr_end_date AS f_end,
               z.name AS zakhvatka
        FROM schedule_version_dates d
        JOIN elements e ON e.id = d.element_id
        LEFT JOIN zones z ON z.id = e.zone_zakhvatka_id
        WHERE {' AND '.join(clauses)}
        """,
        params,
    ).fetchall()

    def свод(пары):
        значения = [v for v in пары if v is not None]
        if not значения:
            return None
        отстают = [v for v in значения if v > 0]
        return {
            "count": len(значения),
            "late": len(отстают),
            "avg": round(sum(значения) / len(значения), 1),
            "max": max(значения),
            "min": min(значения),
        }

    старт = [_days_between(r["base_start"], r["f_start"]) for r in rows]
    конец = [_days_between(r["base_end"], r["f_end"]) for r in rows]

    по_захваткам = {}
    for r in rows:
        имя = r["zakhvatka"] or "Захватка не определена"
        по_захваткам.setdefault(имя, []).append(_days_between(r["base_end"], r["f_end"]))

    from app.reports import natural_key
    захватки = [{"label": имя, "end": свод(значения)}
                for имя, значения in sorted(по_захваткам.items(), key=lambda kv: natural_key(kv[0]))]

    v = conn.execute("SELECT title, loaded_at FROM schedule_versions WHERE id = ?",
                     (version_id,)).fetchone()
    return {
        "version_id": version_id,
        "version_title": v["title"] if v else None,
        "loaded_at": v["loaded_at"] if v else None,
        "elements": len(rows),
        "start": свод(старт),
        "end": свод(конец),
        "by_zakhvatka": захватки,
    }


def forecast_gap(conn: sqlite3.Connection, object_id: int, version_id: int) -> dict:
    """Почему прогноз покрывает не все изделия — ФАКТИЧЕСКИ, а не по списку
    возможных причин (2026-08-14, живой запрос: «выводить только то, что
    реально влияет на график»).

    Каждое изделие, не попавшее в версию, относится ровно к одной причине:
    сначала «уже смонтировано» (при пересчёте от факта такие исключаются
    намеренно), затем «нет привязки к крану, стоянке или этажу» (расчёту
    негде их разместить), остальное — «прочее»: изделие заведено после
    расчёта либо не сопоставилось при загрузке файла.
    """
    rows = conn.execute(
        """
        SELECT e.current_status AS st,
               (e.zone_crane_status = 'matched' AND e.zone_stance_status = 'matched'
                AND e.floor IS NOT NULL) AS привязано
        FROM elements e
        WHERE e.object_id = ? AND e.is_current = 1
          AND e.id NOT IN (SELECT element_id FROM schedule_version_dates WHERE version_id = ?)
        """,
        (object_id, version_id),
    ).fetchall()
    итог = {"missing": len(rows), "installed": 0, "unbound": 0, "other": 0}
    for r in rows:
        if r["st"] == "installed":
            итог["installed"] += 1
        elif not r["привязано"]:
            итог["unbound"] += 1
        else:
            итог["other"] += 1
    return итог


def cumulative_forecast(conn: sqlite3.Connection, object_id: int,
                        version_id: Optional[int] = None) -> dict:
    """Даты последней актуализации по дням — для кривой прогноза на
    S-графике «Динамики». Считается ровно так же, как планы там: по дню
    события, а недельную группировку и накопление делает сам отчёт."""
    version_id = version_id or latest_current_id(conn, object_id)
    if version_id is None:
        return {"version_id": None, "start": [], "end": []}
    rows = conn.execute(
        "SELECT smr_start_date AS s, smr_end_date AS e FROM schedule_version_dates d "
        "JOIN elements el ON el.id = d.element_id "
        "WHERE d.version_id = ? AND el.object_id = ?",
        (version_id, object_id),
    ).fetchall()
    старт, конец = {}, {}
    for r in rows:
        if r["s"]:
            старт[r["s"][:10]] = старт.get(r["s"][:10], 0) + 1
        if r["e"]:
            конец[r["e"][:10]] = конец.get(r["e"][:10], 0) + 1
    return {
        "version_id": version_id,
        "start": sorted(старт.items()),
        "end": sorted(конец.items()),
        # Сколько изделий объекта вообще попало в версию. Меньше общего
        # числа — законное состояние (изделие без привязки к крану, стоянке
        # или этажу в расчёт не встаёт, смонтированные исключаются при
        # пересчёте от факта), но молчать об этом нельзя: накопительная
        # кривая тогда не дорастает до полного объёма, и это читается как
        # «монтаж прекратился» (живой репорт 2026-08-14).
        "elements": len(rows),
    }


# ------------------------------------------------- диаграмма Ганта (2026-08-22)
#
# «Визуализация» — четвёртая вкладка формы графика: та же последовательность
# работ, что раскладывает расчёт, но нарисованная во времени. Строка — узел
# группировки (кран → стоянка → этаж → тип → подтип), у неё ДВЕ полосы:
# директивные сроки и прогноз выбранной версии.
#
# Почему группировка именно такая: это ровно ключ фронта работ в расчёте
# (кран + стоянка + этаж) плюс вид работ (тип + подтип). Диаграмма и
# «Исходные данные расчёта» говорят об одних и тех же строках, и порядок
# строк берётся оттуда же — из потока и из порядка технологии, а не по
# алфавиту: иначе «последовательность этапов СМР» читалась бы как случайный
# список.
#
# План берётся из ПОЛЕЙ изделия, а не из базовой версии (решение
# пользователя 2026-08-22) — по той же причине, что и в карточке изделия
# (см. element_deviation): поля — источник правды директивных дат, их правят
# руками, и диаграмма обязана показывать то, что в системе сейчас.
GANTT_NO_CRANE = "Кран не определён"
GANTT_NO_STANCE = "Стоянка не определена"
GANTT_NO_FLOOR = "Этаж не определён"
GANTT_NO_TYPE = "Тип не указан"
# Четыре уровня, а не пять (2026-08-22, просьба пользователя): тип и подтип
# сведены в один — «Колонна нижняя», «Плита перекрытия на отм. +15.000». Это и
# есть вид работ: расчёт адресует темп и порядок ПАРОЙ тип+подтип, а не
# каждым по отдельности, и разводить их по двум уровням дерева значило бы
# показывать иерархию, которой в данных нет. Подпись собирает _item_label из
# app/reports.py — та же, что в отчётах, вторая её копия однажды разошлась бы.
GANTT_LEVELS = ("crane", "stance", "floor", "item")


def _gantt_span(node: dict, ps, pe, fs, fe) -> None:
    """Сроки узла — от самой ранней даты его изделий до самой поздней.

    Начало и конец накапливаются ПОРОЗНЬ по каждой из двух пар: у изделия
    может быть заполнена только одна дата из двух (импорт заполняет их
    независимо, см. 5.6), и требовать обе значило бы выкинуть строку,
    про которую кое-что известно.
    """
    for ключ, значение, крайний in (
        ("plan_start", ps, min), ("plan_end", pe, max),
        ("forecast_start", fs, min), ("forecast_end", fe, max),
    ):
        if not значение:
            continue
        текущее = node[ключ]
        node[ключ] = значение if текущее is None else крайний(текущее, значение)


def gantt_tree(conn: sqlite3.Connection, object_id: int,
               version_id: Optional[int] = None) -> dict:
    """Дерево узлов группировки с плановыми и прогнозными сроками."""
    from app.models import Status
    from app.reports import _item_label, natural_key
    from app.schedule_calc import _flow, _work_kinds

    version_id = version_id if version_id is not None else latest_current_id(conn, object_id)
    rows = conn.execute(
        """
        SELECT zc.name AS crane, zs.name AS stance, e.floor AS floor,
               e.element_type AS etype, e.subtype AS subtype, e.current_status AS st,
               e.project_smr_start_date AS ps, e.project_delivery_date AS pe,
               d.smr_start_date AS fs, d.smr_end_date AS fe
        FROM elements e
        LEFT JOIN zones zc ON zc.id = e.zone_crane_id AND e.zone_crane_status = 'matched'
        LEFT JOIN zones zs ON zs.id = e.zone_stance_id AND e.zone_stance_status = 'matched'
        LEFT JOIN schedule_version_dates d ON d.element_id = e.id AND d.version_id = ?
        WHERE e.object_id = ? AND e.is_current = 1
        """,
        (version_id if version_id is not None else -1, object_id),
    ).fetchall()

    поток = _flow(conn, object_id)          # (кран, стоянка, этаж) → номер фронта
    виды = _work_kinds(conn, object_id)     # (тип, подтип) → {"rate", "order"}
    ХВОСТ = 10 ** 6                         # то, чему порядок не задан, — в конец

    def новый(label: str, level: str, sort) -> dict:
        return {"label": label, "level": level, "sort": sort, "quantity": 0, "installed": 0,
                "plan_start": None, "plan_end": None,
                "forecast_start": None, "forecast_end": None, "children": {}}

    корень = новый("", "root", ())
    без_дат = 0
    без_прогноза = 0
    for r in rows:
        if not (r["ps"] or r["pe"] or r["fs"] or r["fe"]):
            # Изделие, у которого нет ни директивных дат, ни прогноза, рисовать
            # нечем. Молча пропасть оно не должно — сколько таких, диаграмма
            # пишет отдельной строкой под собой.
            без_дат += 1
            continue
        if version_id is not None and not (r["fs"] or r["fe"]):
            # Изделие есть на диаграмме (директивные даты у него есть), но
            # прогноза по нему нет: строка идёт с одной полосой из двух и без
            # отклонения. Причина законная — расчёт «от факта» исключает
            # смонтированное, а изделие без привязки к крану, стоянке и этажу
            # в него не встаёт вовсе, — но само по себе половинчатое дерево
            # читается как потерянные данные (та же беда, что у кривой
            # прогноза в «Динамике», см. forecast_gap).
            без_прогноза += 1
        смонтировано = 1 if r["st"] == Status.INSTALLED.value else 0
        кран = r["crane"] or GANTT_NO_CRANE
        стоянка = r["stance"] or GANTT_NO_STANCE
        этаж = r["floor"]
        фронт = поток.get((r["crane"], r["stance"], этаж))
        фронт = ХВОСТ if фронт is None else фронт
        порядок_вида = (виды.get((r["etype"], r["subtype"] or None)) or {}).get("order")
        порядок_вида = ХВОСТ if порядок_вида is None else порядок_вида

        путь = [
            (кран, "crane", (natural_key(кран),)),
            (стоянка, "stance", (фронт, natural_key(стоянка))),
            (f"{этаж} этаж" if этаж is not None else GANTT_NO_FLOOR, "floor",
             (фронт, ХВОСТ if этаж is None else этаж)),
        ]
        вид = _item_label(r["etype"] or GANTT_NO_TYPE, r["subtype"])
        путь.append((вид, "item", (порядок_вида, natural_key(вид))))

        узел = корень
        for label, level, sort in путь:
            узел = узел["children"].setdefault(label, новый(label, level, sort))
            # Порядок узла — МИНИМУМ по его изделиям, а не порядок первого
            # встреченного: у стоянки свой номер фронта на каждом этаже, у
            # типа — свой порядок технологии на каждом подтипе. Иначе место
            # строки в списке зависело бы от того, в каком порядке SQLite
            # вернул строки, и менялось бы само собой.
            if sort < узел["sort"]:
                узел["sort"] = sort
            узел["quantity"] += 1
            узел["installed"] += смонтировано
            _gantt_span(узел, r["ps"], r["pe"], r["fs"], r["fe"])
        _gantt_span(корень, r["ps"], r["pe"], r["fs"], r["fe"])
        корень["quantity"] += 1
        корень["installed"] += смонтировано

    счётчик = [0]

    def собрать(узел: dict) -> list:
        дети = sorted(узел["children"].values(), key=lambda n: n["sort"])
        готовые = []
        for д in дети:
            счётчик[0] += 1
            готовые.append({
                "id": счётчик[0], "label": д["label"], "level": д["level"],
                "quantity": д["quantity"],
                # Доля смонтированного — по изделиям САМОГО узла (у родителя в
                # неё входят изделия всех его детей). Округление до целых, но
                # ноль показывается, только когда не смонтировано ничего:
                # «0 %» при одном смонтированном изделии из тысячи — не то же
                # самое, что «не начинали», а на диаграмме читалось бы так.
                "installed": д["installed"],
                "fact_pct": round(100 * д["installed"] / д["quantity"]) if д["quantity"] else 0,
                "plan_start": д["plan_start"], "plan_end": д["plan_end"],
                "forecast_start": д["forecast_start"], "forecast_end": д["forecast_end"],
                "deviation_start": _days_between(д["plan_start"], д["forecast_start"]),
                "deviation_end": _days_between(д["plan_end"], д["forecast_end"]),
                "children": собрать(д),
            })
        return готовые

    узлы = собрать(корень)
    даты = [d for d in (корень["plan_start"], корень["plan_end"],
                        корень["forecast_start"], корень["forecast_end"]) if d]
    v = conn.execute("SELECT title, kind, loaded_at FROM schedule_versions WHERE id = ?",
                     (version_id,)).fetchone() if version_id is not None else None
    return {
        "version_id": version_id,
        "version_title": v["title"] if v else None,
        "version_kind": v["kind"] if v else None,
        "loaded_at": v["loaded_at"] if v else None,
        "nodes": узлы,
        "elements": корень["quantity"],
        "installed": корень["installed"],
        "undated": без_дат,
        "no_forecast": без_прогноза,
        "min_date": min(даты)[:10] if даты else None,
        "max_date": max(даты)[:10] if даты else None,
    }


# ---------------------------------------------------------------- эндпоинты

@router.get("")
def get_versions(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "schedule", "read")
        return {"versions": list_versions(conn, object_id),
                "baseline_id": baseline_id(conn, object_id),
                "current_id": latest_current_id(conn, object_id)}
    finally:
        conn.close()


@router.get("/gantt")
def get_gantt(object_id: int, version_id: Optional[int] = None,
              user: sqlite3.Row = Depends(get_current_user)):
    """Дерево для диаграммы Ганта. version_id не задан — текущий прогноз."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "schedule", "read")
        return gantt_tree(conn, object_id, version_id=version_id)
    finally:
        conn.close()


def _gantt_file(object_id: int, version_id: Optional[int], user, вид: str):
    """Диаграмма файлом. GET, а не POST: выгружается ВСЁ дерево объекта, и
    сужать его списком id (как это делают отчёты) незачем — тела запроса
    не нужно."""
    from urllib.parse import quote

    from fastapi import Response

    from app.schedule_gantt_export import build_gantt_pdf, build_gantt_xlsx

    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "schedule", "read")
        data = gantt_tree(conn, object_id, version_id=version_id)
        row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
        имя_объекта = row["name"] if row else "—"
    finally:
        conn.close()
    if вид == "xlsx":
        содержимое = build_gantt_xlsx(data, имя_объекта)
        имя = "График СМР — диаграмма Ганта.xlsx"
        тип = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        содержимое = build_gantt_pdf(data, имя_объекта)
        имя = "График СМР — диаграмма Ганта.pdf"
        тип = "application/pdf"
    return Response(
        content=содержимое, media_type=тип,
        headers={"Content-Disposition":
                 f"attachment; filename=\"gantt.{вид}\"; filename*=UTF-8''{quote(имя)}"},
    )


@router.get("/gantt.xlsx")
def get_gantt_xlsx(object_id: int, version_id: Optional[int] = None,
                   user: sqlite3.Row = Depends(get_current_user)):
    return _gantt_file(object_id, version_id, user, "xlsx")


@router.get("/gantt.pdf")
def get_gantt_pdf(object_id: int, version_id: Optional[int] = None,
                  user: sqlite3.Row = Depends(get_current_user)):
    return _gantt_file(object_id, version_id, user, "pdf")


@router.get("/deviation")
def get_deviation(object_id: int, version_id: Optional[int] = None,
                  user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "schedule", "read")
        return deviation_summary(conn, object_id, version_id=version_id)
    finally:
        conn.close()


class DeviationIn(BaseModel):
    object_id: int
    version_id: Optional[int] = None
    # Сужение текущим отбором схемы — тот же приём, что у отчётов: критерии
    # фильтра живут на клиенте, сервер получает готовый список id. POST, а
    # не GET, ровно поэтому: список бывает в тысячи элементов и в строку
    # запроса не помещается.
    element_ids: Optional[list] = None


@router.post("/deviation")
def post_deviation(body: DeviationIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        # Сводка отклонения живёт в панели «Статус» рядом с отчётами, поэтому
        # порог тут ЧТЕНИЕ раздела, а не право его настраивать.
        assert_object_feature(conn, user, body.object_id, "schedule", "read")
        return deviation_summary(conn, body.object_id, element_ids=body.element_ids,
                                 version_id=body.version_id)
    finally:
        conn.close()


@router.delete("/{version_id}")
def delete_version(version_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Удаление версии. Базовую удалить нельзя: на ней держится сравнение, и
    «отклонение неизвестно от чего» — не то состояние, в которое систему
    стоит уметь приводить одной кнопкой. Заменяется она повторной загрузкой
    базового графика (см. save_version)."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT object_id, kind, title FROM schedule_versions WHERE id = ?",
                           (version_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Версия графика не найдена")
        assert_object_feature(conn, user, row["object_id"], "schedule", "write")
        if row["kind"] == "baseline" and not is_system_admin(user):
            raise HTTPException(status_code=403,
                                detail="Базовую версию удаляет только администратор сервиса")
        conn.execute("DELETE FROM schedule_versions WHERE id = ?", (version_id,))
        conn.commit()
        activity.log("schedule_version_delete", user=user, entity_type="object",
                     entity_id=row["object_id"], old_value=row["title"] or f"версия #{version_id}")
        return {"ok": True}
    finally:
        conn.close()

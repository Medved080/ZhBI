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

from app import activity
from app.access import assert_object_access, is_system_admin
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
    }


# ---------------------------------------------------------------- эндпоинты

@router.get("")
def get_versions(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_access(conn, user, object_id, "view")
        return {"versions": list_versions(conn, object_id),
                "baseline_id": baseline_id(conn, object_id),
                "current_id": latest_current_id(conn, object_id)}
    finally:
        conn.close()


@router.get("/deviation")
def get_deviation(object_id: int, version_id: Optional[int] = None,
                  user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_access(conn, user, object_id, "view")
        return deviation_summary(conn, object_id, version_id=version_id)
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
        assert_object_access(conn, user, row["object_id"], "admin")
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

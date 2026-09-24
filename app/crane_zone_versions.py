"""Неизменяемые редакции крановых зон объекта и их временные границы.

Существующие ``zones``/``elements.zone_*`` остаются текущим быстрым снимком.
Этот модуль пока только создаёт исходную редакцию на первом обновлении и
отвечает на вопрос, какую редакцию разрешено использовать в отчёте. Новые
редакции публикуются отдельной атомарной операцией, а не правкой этой таблицы.
"""

import json
import sqlite3
from datetime import date, datetime
from zoneinfo import ZoneInfo


BUSINESS_TZ = ZoneInfo("Europe/Moscow")


def business_date() -> str:
    return datetime.now(BUSINESS_TZ).date().isoformat()


def has_versioning(conn: sqlite3.Connection, object_id: int) -> bool:
    """Есть исходный снимок: кран/стоянку уже нельзя менять мимо редакций."""
    return conn.execute(
        "SELECT 1 FROM crane_zone_versions WHERE object_id = ? LIMIT 1",
        (object_id,),
    ).fetchone() is not None


def snapshot_zones(conn: sqlite3.Connection, object_id: int) -> list[dict]:
    """Краны и ВСЕ их стоянки одной редакцией, включая ярусы и имена.

    Исторический снимок не зависит от дальнейших UPDATE/DELETE справочника.
    Захватки сознательно вне редакции: их изменение — отдельный процесс.
    """
    rows = conn.execute(
        "SELECT id, category, number, name, parent_zone_id, match_status, "
        "parent_match_status, source_file, dxf_handle FROM zones "
        "WHERE object_id = ? AND is_current = 1 AND category IN ('Кран', 'Стоянка') "
        "ORDER BY CASE category WHEN 'Кран' THEN 0 ELSE 1 END, parent_zone_id, number, id",
        (object_id,),
    ).fetchall()
    levels = {}
    for row in conn.execute(
        "SELECT l.zone_id, l.elevation_mm, l.outline_json, l.source_file, l.dxf_handle "
        "FROM zone_levels l JOIN zones z ON z.id = l.zone_id "
        "WHERE z.object_id = ? AND z.is_current = 1 AND z.category IN ('Кран', 'Стоянка') "
        "ORDER BY l.zone_id, l.elevation_mm, l.id",
        (object_id,),
    ):
        levels.setdefault(row["zone_id"], []).append({
            "elevation_mm": row["elevation_mm"],
            "outline": json.loads(row["outline_json"]),
            "source_file": row["source_file"],
            "dxf_handle": row["dxf_handle"],
        })
    return [{**dict(row), "levels": levels.get(row["id"], [])} for row in rows]


def snapshot_assignments(conn: sqlite3.Connection, object_id: int, version_id: int,
                         source: str = "legacy") -> int:
    """Полный снимок, включая непривязанные изделия и ярус по ОТМЕТКЕ.

    zone_levels.id нестабилен (ярусы пересоздаются при правке), поэтому id
    яруса в историческую редакцию не переносится.
    """
    cur = conn.execute(
        "INSERT INTO crane_zone_version_assignments "
        "(version_id, element_id, element_uid, crane_zone_id, crane_status, "
        "stance_zone_id, stance_status, stance_elevation_mm, source) "
        "SELECT ?, e.id, e.element_uid, e.zone_crane_id, e.zone_crane_status, "
        "e.zone_stance_id, e.zone_stance_status, l.elevation_mm, ? "
        "FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
        "WHERE e.object_id = ? AND e.is_current = 1",
        (version_id, source, object_id),
    )
    return cur.rowcount


def ensure_baselines(conn: sqlite3.Connection) -> str:
    """Идемпотентная обработка релиза: ничего в старых таблицах не меняет.

    Исходный снимок достоверен только с known_from. Он НЕ создаёт
    выдуманной даты корректировки и не должен разбивать старые отчёты.
    """
    created = assignments = 0
    known_from = business_date()
    for obj in conn.execute("SELECT id FROM objects WHERE kind = 'zhbi' ORDER BY id").fetchall():
        object_id = obj["id"]
        if conn.execute(
            "SELECT 1 FROM crane_zone_versions WHERE object_id = ? AND kind = 'baseline'",
            (object_id,),
        ).fetchone():
            continue
        snapshot = snapshot_zones(conn, object_id)
        cur = conn.execute(
            "INSERT INTO crane_zone_versions "
            "(object_id, revision_no, kind, effective_date, known_from, activated_at, zones_json, note) "
            "VALUES (?, 0, 'baseline', NULL, ?, datetime('now'), ?, ?)",
            (object_id, known_from, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
             "Исходное состояние при вводе версионности; прошлое до known_from не подтверждено"),
        )
        n = snapshot_assignments(conn, object_id, cur.lastrowid)
        conn.execute("UPDATE crane_zone_versions SET assignment_count = ? WHERE id = ?", (n, cur.lastrowid))
        created += 1
        assignments += n
    return f"исходных редакций: {created}; назначений ЖБИ: {assignments}"


def version_for_date(conn: sqlite3.Connection, object_id: int, as_of: str):
    """Редакция, действующая с начала календарного дня по Москве.

    До первого достоверного снимка результат неизвестен. Подставлять
    сегодняшнюю привязку в исторический отчёт было бы ложной историей.
    """
    date.fromisoformat(as_of)
    return conn.execute(
        "SELECT * FROM crane_zone_versions WHERE object_id = ? "
        "AND known_from <= ? AND (effective_date IS NULL OR effective_date <= ?) "
        "ORDER BY (effective_date IS NOT NULL) DESC, effective_date DESC, revision_no DESC LIMIT 1",
        (object_id, as_of, as_of),
    ).fetchone()


def period_corrections(conn: sqlite3.Connection, object_id: int,
                       date_from: str, date_to: str) -> list[dict]:
    """Корректировки ВНУТРИ включительного периода [с, по].

    Редакция с effective_date == date_from уже действует ВЕСЬ первый день,
    поэтому период однороден. Новая редакция в последний день — пересечение.
    Исходный снимок (NULL) корректировкой не считается.
    """
    start, end = date.fromisoformat(date_from), date.fromisoformat(date_to)
    if end < start:
        raise ValueError("Конец периода раньше начала")
    return [dict(row) for row in conn.execute(
        "SELECT id, revision_no, effective_date FROM crane_zone_versions "
        "WHERE object_id = ? AND kind <> 'baseline' "
        "AND effective_date > ? AND effective_date <= ? ORDER BY effective_date",
        (object_id, start.isoformat(), end.isoformat()),
    )]


def period_version(conn: sqlite3.Connection, object_id: int,
                   date_from: str, date_to: str):
    """Редакция для отчёта за период либо явный отказ с границами.

    Работает именно по дате действия корректировки, а не по времени её
    ввода оператором. Вызывающий код обязан обрабатывать ValueError и
    показывать даты разделения периода, а не скрытно использовать одну
    из версий.
    """
    changes = period_corrections(conn, object_id, date_from, date_to)
    if changes:
        dates = ", ".join(row["effective_date"] for row in changes)
        raise ValueError(
            f"Период пересекает изменение зон кранов и стоянок: {dates}. "
            "Разделите отчёт по указанным датам."
        )
    version = version_for_date(conn, object_id, date_from)
    if version is None:
        baseline = conn.execute(
            "SELECT known_from FROM crane_zone_versions "
            "WHERE object_id = ? AND kind = 'baseline'",
            (object_id,),
        ).fetchone()
        known = f" (с {baseline['known_from']})" if baseline is not None else ""
        raise ValueError(
            "Для начала периода нет достоверной редакции крановых зон: "
            f"исходный снимок создан позднее{known}. Историю до ввода версионности "
            "нельзя восстановить из текущих назначений."
        )
    return version

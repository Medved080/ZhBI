"""Черновик, публикация и активация цельной редакции крановых зон.

До подключения HTTP/UI этот модуль используется только на копии БД.
Все изменения текущих zones/elements совершаются одной транзакцией.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date

from app.crane_zone_editor import ZoneDraftError, preview_assignments, validate_zones
from app.crane_zone_versions import business_date, snapshot_zones
from app.zone_color_service import ensure_crane_colors


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _latest(conn: sqlite3.Connection, object_id: int):
    return conn.execute(
        "SELECT * FROM crane_zone_versions WHERE object_id = ? "
        "ORDER BY revision_no DESC LIMIT 1", (object_id,),
    ).fetchone()


def _draft(conn: sqlite3.Connection, object_id: int, draft_id: int):
    row = conn.execute(
        "SELECT * FROM crane_zone_drafts WHERE id = ? AND object_id = ?",
        (draft_id, object_id),
    ).fetchone()
    if row is None:
        raise ZoneDraftError("Черновик не найден на этом объекте")
    return row


def _assert_current_matches_version(conn: sqlite3.Connection, object_id: int, version) -> None:
    """Старые пути записи не вправе тихо обойти исторический снимок."""
    if snapshot_zones(conn, object_id) != json.loads(version["zones_json"]):
        raise ZoneDraftError(
            "Текущие зоны отличаются от последней редакции. "
            "Сначала устраните изменения, внесённые старым редактором или импортом."
        )
    saved = {
        row["element_id"]: row
        for row in conn.execute(
            "SELECT element_id, element_uid, crane_zone_id, crane_status, "
            "stance_zone_id, stance_status, stance_elevation_mm "
            "FROM crane_zone_version_assignments WHERE version_id = ?",
            (version["id"],),
        )
    }
    for row in conn.execute(
        "SELECT e.id, e.element_uid, e.zone_crane_id, e.zone_crane_status, "
        "e.zone_stance_id, e.zone_stance_status, l.elevation_mm "
        "FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
        "WHERE e.object_id = ? AND e.is_current = 1", (object_id,),
    ):
        old = saved.get(row["id"])
        if old is None:
            arrival = conn.execute(
                "SELECT 1 FROM crane_zone_import_arrivals WHERE object_id = ? AND element_id = ?",
                (object_id, row["id"]),
            ).fetchone()
            if arrival is not None and all(row[key] is None for key in (
                "zone_crane_id", "zone_crane_status", "zone_stance_id",
                "zone_stance_status", "elevation_mm",
            )):
                continue
            raise ZoneDraftError(
                f"Изделие {row['id']} отсутствует в редакции и не зарегистрировано "
                "как новое изделие без крановой зоны"
            )
        if (
            row["element_uid"], row["zone_crane_id"], row["zone_crane_status"],
            row["zone_stance_id"], row["zone_stance_status"], row["elevation_mm"]
        ) != (
            old["element_uid"], old["crane_zone_id"], old["crane_status"],
            old["stance_zone_id"], old["stance_status"], old["stance_elevation_mm"]
        ):
            raise ZoneDraftError(
                f"Привязка изделия {row['id']} изменилась вне редакции — нужна сверка"
            )
    # Снятые чертежом изделия остаются в историческом снимке, но больше не
    # участвуют в текущей редакции. Их нельзя удалять ради равенства счётчиков.


def register_import_membership(conn: sqlite3.Connection, object_id: int) -> int:
    """Зарегистрировать новые изделия отдельно, НЕ меняя опубликованные снимки.

    Вызывается внутри транзакции импорта изделий. Новое изделие остаётся
    без крановой зоны до публикации следующей редакции.
    """
    unexpected = conn.execute(
        "SELECT e.id FROM elements e WHERE e.object_id = ? AND e.is_current = 1 "
        "AND NOT EXISTS (SELECT 1 FROM crane_zone_version_assignments a "
        "JOIN crane_zone_versions v ON v.id = a.version_id "
        "WHERE v.object_id = ? AND a.element_id = e.id) "
        "AND NOT EXISTS (SELECT 1 FROM crane_zone_import_arrivals i "
        "WHERE i.object_id = ? AND i.element_id = e.id) "
        "AND (e.zone_crane_id IS NOT NULL OR e.zone_crane_status IS NOT NULL "
        "OR e.zone_stance_id IS NOT NULL OR e.zone_stance_status IS NOT NULL "
        "OR e.zone_stance_level_id IS NOT NULL) LIMIT 1",
        (object_id, object_id, object_id),
    ).fetchone()
    if unexpected is not None:
        raise ZoneDraftError(
            f"Новое изделие {unexpected['id']} получило крановую зону вне редакции"
        )
    cur = conn.execute(
        "INSERT INTO crane_zone_import_arrivals (object_id, element_id, first_seen_date) "
        "SELECT ?, e.id, ? FROM elements e WHERE e.object_id = ? AND e.is_current = 1 "
        "AND NOT EXISTS (SELECT 1 FROM crane_zone_version_assignments a "
        "JOIN crane_zone_versions v ON v.id = a.version_id "
        "WHERE v.object_id = ? AND a.element_id = e.id) "
        "AND NOT EXISTS (SELECT 1 FROM crane_zone_import_arrivals i "
        "WHERE i.object_id = ? AND i.element_id = e.id)",
        (object_id, business_date(), object_id, object_id, object_id),
    )
    return cur.rowcount


def create_draft(conn: sqlite3.Connection, object_id: int, user_id: int | None,
                 author_name: str | None) -> int:
    """Открыть редактирование только от активной последней редакции."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        base = _latest(conn, object_id)
        if base is None:
            raise ZoneDraftError("Для объекта ещё не создана исходная редакция")
        if base["activated_at"] is None:
            raise ZoneDraftError("Есть опубликованная будущая редакция; дождитесь её действия")
        _assert_current_matches_version(conn, object_id, base)
        current = snapshot_zones(conn, object_id)
        overrides = {
            str(row["element_id"]): {
                "crane_zone_id": row["crane_zone_id"],
                "stance_zone_id": row["stance_zone_id"],
            }
            for row in conn.execute(
                "SELECT element_id, crane_zone_id, stance_zone_id "
                "FROM crane_zone_version_assignments "
                "WHERE version_id = ? AND source = 'manual'", (base["id"],),
            )
        }
        cur = conn.execute(
            "INSERT INTO crane_zone_drafts "
            "(object_id, base_version_id, zones_json, overrides_json, created_by, author_name) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (object_id, base["id"], _json(current), _json(overrides), user_id, author_name),
        )
        conn.commit()
        return cur.lastrowid
    except Exception:
        conn.rollback()
        raise


def update_draft(conn: sqlite3.Connection, object_id: int, draft_id: int,
                 edit_token: int, zones: list[dict], overrides: dict, note: str) -> int:
    """Оптимистическая блокировка защищает от перезаписи другого оператора."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        draft = _draft(conn, object_id, draft_id)
        if draft["edit_token"] != edit_token:
            raise ZoneDraftError("Черновик изменён в другой вкладке; обновите его")
        base = conn.execute(
            "SELECT zones_json FROM crane_zone_versions WHERE id = ? AND object_id = ?",
            (draft["base_version_id"], object_id),
        ).fetchone()
        if base is None:
            raise ZoneDraftError("Исходная редакция черновика не найдена")
        validate_zones(zones, json.loads(base["zones_json"]))
        if not isinstance(overrides, dict) or len(overrides) > 100000:
            raise ZoneDraftError("Слишком много ручных назначений")
        if not isinstance(note, str) or len(note) > 2000:
            raise ZoneDraftError("Причина изменения не должна превышать 2000 знаков")
        # Здесь намеренно не прогоняем 10 тыс. изделий при каждом движении
        # контура. Полная проверка назначений — preview и publish.
        conn.execute(
            "UPDATE crane_zone_drafts SET zones_json = ?, overrides_json = ?, note = ?, "
            "updated_at = datetime('now'), edit_token = edit_token + 1 WHERE id = ?",
            (_json(zones), _json(overrides), note, draft_id),
        )
        conn.commit()
        return edit_token + 1
    except Exception:
        conn.rollback()
        raise


def preview_draft(conn: sqlite3.Connection, object_id: int, draft_id: int) -> dict:
    draft = _draft(conn, object_id, draft_id)
    base = _latest(conn, object_id)
    if base is None or base["id"] != draft["base_version_id"] or base["activated_at"] is None:
        raise ZoneDraftError("Основа черновика устарела — откройте новую редакцию")
    _assert_current_matches_version(conn, object_id, base)
    return preview_assignments(
        conn, object_id, json.loads(draft["zones_json"]), json.loads(base["zones_json"]),
        json.loads(draft["overrides_json"]),
    )


def _reserve_new_zones(conn: sqlite3.Connection, object_id: int,
                       zones: list[dict]) -> tuple[list[dict], dict[int, int]]:
    """Дать новым зонам стабильные реальные ID, оставаясь внутри транзакции."""
    mapping = {}
    for zone in zones:
        if zone["id"] < 0:
            first = zone["levels"][0]
            cur = conn.execute(
                "INSERT INTO zones (source_file, dxf_handle, category, elevation_mm, "
                "name, outline_json, match_status, parent_match_status, object_id, number, is_current) "
                "VALUES (?, ?, ?, ?, ?, ?, 'matched', ?, ?, ?, 0)",
                (f"manual-zone:{object_id}", uuid.uuid4().hex, zone["category"],
                 first["elevation_mm"], zone["name"], _json(first["outline"]),
                 "matched" if zone["category"] == "Стоянка" else "not_applicable",
                 object_id, zone["number"]),
            )
            mapping[zone["id"]] = cur.lastrowid
    result = []
    for zone in zones:
        resolved_id = mapping.get(zone["id"], zone["id"])
        parent_id = mapping.get(zone.get("parent_zone_id"), zone.get("parent_zone_id"))
        provenance = conn.execute(
            "SELECT source_file, dxf_handle FROM zones WHERE id = ? AND object_id = ?",
            (resolved_id, object_id),
        ).fetchone()
        resolved = {
            "id": resolved_id, "category": zone["category"], "number": zone["number"],
            "name": zone["name"], "parent_zone_id": parent_id,
            "match_status": zone.get("match_status") or "matched",
            "parent_match_status": zone.get("parent_match_status") or (
                "matched" if zone["category"] == "Стоянка" else "not_applicable"
            ),
            "source_file": provenance["source_file"], "dxf_handle": provenance["dxf_handle"],
        }
        if zone["id"] < 0:
            resolved["match_status"] = "matched"
            resolved["parent_match_status"] = (
                "matched" if zone["category"] == "Стоянка" else "not_applicable"
            )
        resolved["levels"] = sorted([
            {
                "elevation_mm": level["elevation_mm"], "outline": level["outline"],
                "source_file": level.get("source_file") or resolved["source_file"],
                "dxf_handle": level.get("dxf_handle") or resolved["dxf_handle"],
            }
            for level in zone["levels"]
        ], key=lambda item: (item["elevation_mm"] is not None,
                             item["elevation_mm"] if item["elevation_mm"] is not None else 0))
        result.append(resolved)
    result.sort(key=lambda z: (z["category"] != "Кран", z["parent_zone_id"] or 0,
                               z["number"], z["id"]))
    return result, mapping


def _apply_current(conn: sqlite3.Connection, object_id: int, version) -> None:
    """Материализовать уже опубликованную версию в старых рабочих таблицах."""
    zones = json.loads(version["zones_json"])
    previous = snapshot_zones(conn, object_id)
    _migrate_schedule_flow(conn, object_id, previous, zones)
    ensure_crane_colors(conn, object_id, zones, previous)
    expected = {zone["id"] for zone in zones}
    alive = {
        row["id"] for row in conn.execute(
            "SELECT id FROM zones WHERE object_id = ? AND is_current = 1 "
            "AND category IN ('Кран', 'Стоянка')", (object_id,),
        )
    }
    if not alive.issubset(expected):
        raise ZoneDraftError("Текущие зоны изменены вне редакции; активация остановлена")
    for zone in zones:
        first = zone["levels"][0]
        conn.execute(
            "UPDATE zones SET number = ?, name = ?, parent_zone_id = ?, "
            "parent_match_status = ?, elevation_mm = ?, outline_json = ?, is_current = 1 "
            "WHERE id = ? AND object_id = ?",
            (zone["number"], zone["name"], zone.get("parent_zone_id"),
             zone.get("parent_match_status"), first["elevation_mm"],
             _json(first["outline"]), zone["id"], object_id),
        )
        conn.execute("DELETE FROM zone_levels WHERE zone_id = ?", (zone["id"],))
        for level in zone["levels"]:
            conn.execute(
                "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
                "VALUES (?, ?, ?, ?, ?)",
                (zone["id"], level["elevation_mm"], _json(level["outline"]),
                 level.get("source_file") or zone.get("source_file"),
                 level.get("dxf_handle") or zone.get("dxf_handle")),
            )
    levels = {
        (row["zone_id"], row["elevation_mm"]): row["id"]
        for row in conn.execute(
            "SELECT l.id, l.zone_id, l.elevation_mm FROM zone_levels l "
            "JOIN zones z ON z.id = l.zone_id WHERE z.object_id = ? "
            "AND z.category = 'Стоянка'", (object_id,),
        )
    }
    assignments = conn.execute(
        "SELECT * FROM crane_zone_version_assignments WHERE version_id = ?",
        (version["id"],),
    ).fetchall()
    current_ids = {
        row["id"] for row in conn.execute(
            "SELECT id FROM elements WHERE object_id = ? AND is_current = 1", (object_id,),
        )
    }
    missing = current_ids - {row["element_id"] for row in assignments}
    if missing:
        valid_arrivals = {
            row["element_id"] for row in conn.execute(
                "SELECT i.element_id FROM crane_zone_import_arrivals i "
                "JOIN elements e ON e.id = i.element_id "
                "WHERE i.object_id = ? AND e.is_current = 1 "
                "AND e.zone_crane_id IS NULL AND e.zone_crane_status IS NULL "
                "AND e.zone_stance_id IS NULL AND e.zone_stance_status IS NULL "
                "AND e.zone_stance_level_id IS NULL", (object_id,),
            )
        }
        if not missing.issubset(valid_arrivals):
            raise ZoneDraftError(
                "Появились изделия без записи в редакции и без безопасной регистрации импорта"
            )
    for assignment in assignments:
        if assignment["element_id"] not in current_ids:
            continue
        level_id = None
        if assignment["stance_zone_id"] is not None:
            level_id = levels.get((assignment["stance_zone_id"], assignment["stance_elevation_mm"]))
            if level_id is None:
                raise ZoneDraftError(f"У стоянки изделия {assignment['element_id']} нет нужного яруса")
        conn.execute(
            "UPDATE elements SET zone_crane_id = ?, zone_crane_status = ?, "
            "zone_stance_id = ?, zone_stance_status = ?, zone_stance_level_id = ?, "
            "updated_at = datetime('now') WHERE id = ? AND object_id = ?",
            (assignment["crane_zone_id"], assignment["crane_status"],
             assignment["stance_zone_id"], assignment["stance_status"], level_id,
             assignment["element_id"], object_id),
        )
    conn.execute(
        "UPDATE crane_zone_versions SET activated_at = datetime('now') WHERE id = ?",
        (version["id"],),
    )


def _migrate_schedule_flow(conn: sqlite3.Connection, object_id: int,
                           previous: list[dict], incoming: list[dict]) -> None:
    """Сохранить очередь фронтов при переименовании/переносе стоянки.

    Ключ schedule_flow — текстовые имена, не ID. Замена имён делается в той
    же транзакции, что активация редакции; при неоднозначности вся операция
    откатывается, вместо молчаливой потери настроенного порядка.
    """
    old_by_id = {z["id"]: z for z in previous}
    new_by_id = {z["id"]: z for z in incoming}
    old_pairs = {}
    for stance in previous:
        if stance["category"] != "Стоянка":
            continue
        crane = old_by_id.get(stance["parent_zone_id"])
        if crane is None:
            continue
        old_pairs.setdefault((crane["name"], stance["name"]), []).append(stance["id"])
    rows = conn.execute(
        "SELECT id, crane_name, stance_name, floor, order_no FROM schedule_flow "
        "WHERE object_id = ?", (object_id,),
    ).fetchall()
    changes = []
    final_keys = set()
    for row in rows:
        old_pair = (row["crane_name"], row["stance_name"])
        matches = old_pairs.get(old_pair, [])
        if len(matches) > 1:
            raise ZoneDraftError(
                f"Поток графика неоднозначен для {old_pair[0]} · {old_pair[1]}"
            )
        new_pair = old_pair
        if matches:
            new_stance = new_by_id.get(matches[0])
            new_crane = new_by_id.get(new_stance["parent_zone_id"]) if new_stance else None
            if new_stance is None or new_crane is None:
                raise ZoneDraftError("Стоянка из потока графика отсутствует в новой редакции")
            new_pair = (new_crane["name"], new_stance["name"])
        key = (new_pair[0], new_pair[1], row["floor"])
        if key in final_keys:
            raise ZoneDraftError("После изменения зон строки потока графика совпадут")
        final_keys.add(key)
        if new_pair != old_pair:
            changes.append((row["id"], new_pair))
    for row_id, _ in changes:
        conn.execute(
            "UPDATE schedule_flow SET crane_name = ?, stance_name = ? WHERE id = ?",
            (f"__crane_zone_move_{row_id}__", f"__crane_zone_move_{row_id}__", row_id),
        )
    for row_id, pair in changes:
        conn.execute(
            "UPDATE schedule_flow SET crane_name = ?, stance_name = ? WHERE id = ?",
            (*pair, row_id),
        )


def publish_draft(conn: sqlite3.Connection, object_id: int, draft_id: int,
                  edit_token: int, effective_date: str, user_id: int | None,
                  author_name: str | None) -> dict:
    """Атомарно сохранить редакцию; применить сейчас либо в дату действия."""
    try:
        day = date.fromisoformat(effective_date)
    except ValueError as exc:
        raise ZoneDraftError("Неверная дата действия редакции") from exc
    if day < date.fromisoformat(business_date()):
        raise ZoneDraftError("Задняя дата пока запрещена: она изменит уже выданные отчёты")
    conn.execute("BEGIN IMMEDIATE")
    try:
        draft = _draft(conn, object_id, draft_id)
        if draft["edit_token"] != edit_token:
            raise ZoneDraftError("Черновик изменён; проверьте его перед публикацией")
        base = _latest(conn, object_id)
        if base is None or base["id"] != draft["base_version_id"]:
            raise ZoneDraftError("Основа черновика устарела — опубликована другая редакция")
        if base["activated_at"] is None:
            raise ZoneDraftError("На объекте уже ожидает применения будущая редакция")
        _assert_current_matches_version(conn, object_id, base)
        if base["effective_date"] and effective_date <= base["effective_date"]:
            raise ZoneDraftError("Дата действия должна быть позже предыдущей редакции")
        if not draft["note"] or not draft["note"].strip():
            raise ZoneDraftError("Укажите причину корректировки зон")
        zones = json.loads(draft["zones_json"])
        assignments = preview_assignments(
            conn, object_id, zones, json.loads(base["zones_json"]),
            json.loads(draft["overrides_json"]),
        )["assignments"]
        zones, mapping = _reserve_new_zones(conn, object_id, zones)
        cur = conn.execute(
            "INSERT INTO crane_zone_versions "
            "(object_id, revision_no, kind, effective_date, known_from, created_by, "
            "author_name, note, zones_json, assignment_count) "
            "VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)",
            (object_id, base["revision_no"] + 1, effective_date, business_date(),
             user_id, author_name, draft["note"].strip(), _json(zones), len(assignments)),
        )
        version_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO crane_zone_version_assignments "
            "(version_id, element_id, element_uid, crane_zone_id, crane_status, "
            "stance_zone_id, stance_status, stance_elevation_mm, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (version_id, a["element_id"], a["element_uid"],
                 mapping.get(a["crane_zone_id"], a["crane_zone_id"]), a["crane_status"],
                 mapping.get(a["stance_zone_id"], a["stance_zone_id"]),
                 a["stance_status"], a["stance_elevation_mm"], a["source"])
                for a in assignments
            ],
        )
        if day == date.fromisoformat(business_date()):
            _apply_current(conn, object_id, conn.execute(
                "SELECT * FROM crane_zone_versions WHERE id = ?", (version_id,),
            ).fetchone())
        conn.execute("DELETE FROM crane_zone_drafts WHERE id = ?", (draft_id,))
        conn.commit()
        return {"version_id": version_id, "revision_no": base["revision_no"] + 1,
                "effective_date": effective_date, "activated": day == date.fromisoformat(business_date()),
                "assignments": len(assignments)}
    except Exception:
        conn.rollback()
        raise


def activate_due(conn: sqlite3.Connection) -> list[int]:
    """Включить наступившие редакции при старте/смене суток; 1 объект = 1 TX."""
    due_ids = [row["id"] for row in conn.execute(
        "SELECT id FROM crane_zone_versions WHERE activated_at IS NULL "
        "AND effective_date <= ? ORDER BY effective_date, id", (business_date(),),
    )]
    activated = []
    for version_id in due_ids:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM crane_zone_versions WHERE id = ? AND activated_at IS NULL "
                "AND effective_date <= ?", (version_id, business_date()),
            ).fetchone()
            if row is not None:
                previous = conn.execute(
                    "SELECT * FROM crane_zone_versions WHERE object_id = ? "
                    "AND activated_at IS NOT NULL ORDER BY revision_no DESC LIMIT 1",
                    (row["object_id"],),
                ).fetchone()
                if previous is None:
                    raise ZoneDraftError("Нет текущей редакции для безопасной активации")
                _assert_current_matches_version(conn, row["object_id"], previous)
                _apply_current(conn, row["object_id"], row)
                activated.append(version_id)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return activated

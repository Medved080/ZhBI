"""Контуры стен объекта в абсолютных координатах P (мм) — источник данных
для автоматического совмещения фасада из FBX (Docs/fbx-auto-placement-
claude-prompt.md). Отдельный модуль от `object_geometry_bounds.py`: тот
даёт только габарит (для anchor центрирования), этому нужна САМА
геометрия — отрезки контуров стен с высотой, чтобы искать направления и
переносить/поворачивать фасад по реальной форме здания, а не по одному
прямоугольнику габарита.

Источник — ТОЛЬКО категория «Стены» (`revit_elements.category`): несущие
колонны/перегородки/окна/двери и «Обобщённые модели» дают либо шум
(мелкие вставки в проём), либо не образуют внешний контур здания
надёжно — задание прямо предупреждает не сравнивать все вершины подряд.
У объектов ЖБИ (без Revit-модели, только точечные изделия `elements`) для
такого совмещения фасада нет исходных данных вовсе — не тот тип учёта,
там просто нечего сопоставлять с объёмной моделью фасада.
"""
import hashlib
import json
import math
import sqlite3
from typing import Optional

MAX_SEGMENTS_PER_LEVEL = 300
MAX_LEVELS = 40
MAX_SEGMENTS_TOTAL = 8000
MIN_SEGMENT_LENGTH_MM = 10.0


def _edges_from_outline(outline_json: Optional[str]) -> list:
    if not outline_json:
        return []
    try:
        pts = json.loads(outline_json)
    except (ValueError, TypeError):
        return []
    if not isinstance(pts, list) or len(pts) < 2:
        return []
    edges = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple))
                and len(a) >= 2 and len(b) >= 2):
            continue
        try:
            x1, y1, x2, y2 = float(a[0]), float(a[1]), float(b[0]), float(b[1])
        except (TypeError, ValueError):
            continue
        if not all(v == v for v in (x1, y1, x2, y2)):  # NaN
            continue
        length = math.hypot(x2 - x1, y2 - y1)
        if length < MIN_SEGMENT_LENGTH_MM:
            continue
        edges.append((x1, y1, x2, y2, length))
    return edges


def get_wall_segments(conn: sqlite3.Connection, object_id: int) -> dict:
    """{'source': 'revit'|'none', 'segments': [...], 'segment_count_total': N,
    'source_revision': str}. Сегмент — {x1,y1,x2,y2,z0,z1} в мм, абсолютные
    P объекта (те же координаты, что x/y у revit_elements — см. живую
    проверку в этой же сессии, Docs/DECISIONS.md)."""
    rows = conn.execute(
        "SELECT outline_json, elevation_mm, height_mm, updated_at FROM revit_elements "
        "WHERE object_id = ? AND is_current = 1 AND category = 'Стены' "
        "AND elevation_mm IS NOT NULL AND height_mm IS NOT NULL AND height_mm > 0",
        (object_id,),
    ).fetchall()

    revision_parts = []
    # Группировка отметок с допуском 200мм (было 10мм — задание/аудит
    # Docs/fbx-partial-envelope-claude-prompt.md §1: два перекрытия одного
    # реального этажа на 163.6 и 163.7м оказывались РАЗНЫМИ уровнями,
    # искусственно дробя суммарный периметр этажа и портя отбор ниже).
    LEVEL_TOLERANCE_MM = 200.0
    by_level: dict = {}  # round(elevation_mm/200) -> list[(x1,y1,x2,y2,length,z0,z1)]
    total_before_cap = 0
    for r in rows:
        if r["updated_at"]:
            revision_parts.append(r["updated_at"])
        z0 = float(r["elevation_mm"])
        z1 = z0 + float(r["height_mm"])
        edges = _edges_from_outline(r["outline_json"])
        total_before_cap += len(edges)
        if not edges:
            continue
        level_key = round(z0 / LEVEL_TOLERANCE_MM)
        by_level.setdefault(level_key, []).extend(
            (x1, y1, x2, y2, length, z0, z1) for (x1, y1, x2, y2, length) in edges
        )

    source_revision = hashlib.sha256(
        json.dumps({"object_id": object_id, "n": len(rows),
                     "updates": sorted(set(revision_parts))[-50:]},
                    sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]

    if not by_level:
        return {"source": "none", "segments": [], "segment_count_total": 0,
                "source_revision": source_revision}

    # Не берём ВСЕ уровни разом (у высотки их может быть полсотни с лишним).
    # Раньше брали «топ-40 по суммарной длине стен» — это СИСТЕМАТИЧЕСКИ
    # отбрасывало уникальные широкие этажи (например, стилобат/нижнюю
    # часть с большим количеством помещений сразу) в пользу многочисленных
    # повторяющихся узких этажей типовой башни, у которых суммарная длина
    # стен больше просто из-за числа перегородок — подтверждено на
    # реальном объекте (Docs/fbx-partial-envelope-claude-prompt.md §1):
    # единственный широкий уровень 149.9м (36.4×54.5м) исчезал из выборки,
    # клиент получал только башню 17.6×54.5м, и совмещение по низкой части
    # было в принципе невозможно — ей нечего было сопоставлять.
    #
    # Теперь — РАЗНООБРАЗИЕ ПЛАНА: уровни делятся на MAX_LEVELS интервалов
    # по высоте (равномерно по всему диапазону здания), и внутри каждого
    # интервала берётся уровень с САМЫМ ШИРОКИМ контуром в плане (по
    # диагонали bbox), а не с наибольшей суммарной длиной стен — так
    # уникальный по форме этаж гарантированно представлен независимо от
    # того, сколько у него внутренних перегородок.
    def _level_plan_diagonal(edges):
        xs = [v for e in edges for v in (e[0], e[2])]
        ys = [v for e in edges for v in (e[1], e[3])]
        return math.hypot(max(xs) - min(xs), max(ys) - min(ys))

    level_items = sorted(by_level.items(), key=lambda kv: kv[0])  # по возрастанию отметки
    if len(level_items) <= MAX_LEVELS:
        levels_sorted = level_items
    else:
        min_key = level_items[0][0]
        max_key = level_items[-1][0]
        span = max(max_key - min_key, 1)
        buckets: dict = {}
        for key, edges in level_items:
            bucket_idx = min(MAX_LEVELS - 1, int((key - min_key) * MAX_LEVELS / (span + 1)))
            best = buckets.get(bucket_idx)
            diag = _level_plan_diagonal(edges)
            if best is None or diag > best[1]:
                buckets[bucket_idx] = (key, diag, edges)
        levels_sorted = [(key, edges) for key, _diag, edges in
                         sorted(buckets.values(), key=lambda v: v[0])]

    segments = []
    for _level_key, edges in levels_sorted:
        # На каждом уровне — самые длинные отрезки: они несут направление и
        # положение контура надёжнее, чем обрывки у проёмов/примыканий.
        edges_sorted = sorted(edges, key=lambda e: -e[4])[:MAX_SEGMENTS_PER_LEVEL]
        for (x1, y1, x2, y2, _length, z0, z1) in edges_sorted:
            segments.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "z0": z0, "z1": z1})

    if len(segments) > MAX_SEGMENTS_TOTAL:
        # Общий предохранитель поверх поуровневого — сортировка по длине
        # стороны не имеет смысла тут (уже сделана по уровням), просто
        # берём равномерно по списку, чтобы не потерять уровни целиком.
        stride = len(segments) / MAX_SEGMENTS_TOTAL
        segments = [segments[int(i * stride)] for i in range(MAX_SEGMENTS_TOTAL)]

    return {
        "source": "revit",
        "segments": segments,
        "segment_count_total": total_before_cap,
        "source_revision": source_revision,
    }

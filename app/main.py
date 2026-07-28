import json
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import Point
from shapely.strtree import STRtree

from app.auth import format_display_name, get_current_user, require_admin, require_editor
from app.auth import router as auth_router
from app.contracting_import import ContractingImportError, import_contracting, parse_contracting_xlsx
from app.contracts import (
    apply_status_change,
    build_contract_name,
    contract_line_warning,
    enrich_element_row,
    recompute_element_contract_cache,
    recompute_status_and_actual_date,
)
from app.contracts import router as contracts_router
from app.counterparties import router as counterparties_router
from app.db import DB_PATH, get_connection, init_db
from app.dxf_import import DxfProcessingError, UPLOADS_DIR, import_dxf_file, process_upload
from app.element_dates import set_planned_delivery_date, set_planned_delivery_dates_bulk
from app.export import build_history_xlsx, build_snapshot_xlsx
from app.history_import import HistoryImportError, import_history, parse_history_xlsx
from app.input_import import import_input_dxf, import_input_xlsx
from app.models import (
    SHAPES,
    STATUS_LABELS_RU,
    STATUS_ORDER,
    ZHBI_ELEMENT_TYPES,
    AllowedSubtypeIn,
    BulkPlannedDateUpdateIn,
    BulkPlannedDateUpdateResult,
    BulkStatusUpdateIn,
    BulkStatusUpdateResult,
    ElementPlannedDateIn,
    ElementPlannedDateUpdateResult,
    ElementShapeIn,
    Status,
    DxfImportResult,
    ElementDetailOut,
    ElementOut,
    PlanSelectionIn,
    StatusHistoryOut,
    StatusSummaryEntry,
    StatusUpdateIn,
    StatusUpdateResult,
    ZoneColorIn,
)
from app.pdf_export import build_schema_pdf
from app.schedule_import import ScheduleImportError, import_schedule, parse_schedule_xlsx
from app.settings import router as settings_router
from app.upload_limits import MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, read_upload_limited
from app.users import router as users_router

# Интерактивная документация (/docs, /redoc) и схема (/openapi.json)
# анонимному пользователю сети не нужны и раскрывают всю карту API —
# выключены по умолчанию (см. Docs/backlog.md, аудит безопасности),
# включаются явно для локальной разработки через ZHBI_ENABLE_DOCS=1.
_ENABLE_DOCS = os.environ.get("ZHBI_ENABLE_DOCS") == "1"
app = FastAPI(
    title="ЖБИ",
    docs_url="/docs" if _ENABLE_DOCS else None,
    redoc_url="/redoc" if _ENABLE_DOCS else None,
    openapi_url="/openapi.json" if _ENABLE_DOCS else None,
)
# Вся статика — локальная (см. CLAUDE.md, "3D-режим": Three.js вендорено,
# не CDN), инлайновых обработчиков событий (onclick=...) в разметке нет —
# только инлайновые style="..." (динамические цвета статусов/зон, см.
# app/static/app.js), поэтому style-src не может обойтись без
# 'unsafe-inline', а script-src — может (весь JS вынесен в
# /static/app.js специально ради этого, см. Docs/backlog.md).
#
# Единственное исключение — `<script type="importmap">` в <head>
# index.html (bare-специфайер "three" -> локальный vendor-файл, см. его
# собственный комментарий там же): CSP относит import map к обычным
# инлайновым скриптам, 'self' их не пускает. Вместо ослабления всей
# политики до 'unsafe-inline' — точечный sha256-хэш ИМЕННО этого блока
# (статический контент, не меняется в рантайме). ВАЖНО: при любом
# изменении текста import map (например, обновлении версии Three.js)
# хэш ниже нужно пересчитать — иначе 3D-режим молча перестанет
# резолвить "three" (ровно так это один раз и сломалось при выносе
# инлайнового JS в /static/app.js, см. Docs/backlog.md).
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'sha256-GGgqHO/YpgtINWBQBdyPoj2n6zSoZ9PEznPWfb/aFu4='; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = _CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # StaticFiles по умолчанию не выставляет Cache-Control — браузер сам
    # решает, когда перепроверять файл, и на практике часто показывает
    # старую копию app.js/index.html после правки на сервере (несколько
    # раз путало живую проверку в этой сессии, см. Docs/backlog.md —
    # помогала только жёсткая перезагрузка). no-cache (не no-store) —
    # браузер ОБЯЗАН на каждый запрос спросить сервер "не устарело ли"
    # (условный GET по ETag/Last-Modified, которые StaticFiles уже
    # проставляет сама) — не полный передекачивание при каждой загрузке,
    # но и не молчаливая раздача устаревшей копии из кэша.
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def limit_upload_size(request, call_next):
    """Быстрый отказ ДО чтения тела запроса, если клиент честно объявил
    Content-Length больше лимита (у браузерных multipart-форм так и
    есть всегда — см. app/upload_limits.py). Второй, более медленный
    барьер — copy_upload_limited/read_upload_limited на самих точках
    чтения файла, на случай запроса без Content-Length."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            too_big = int(content_length) > MAX_UPLOAD_BYTES
        except ValueError:
            too_big = False
        if too_big:
            return JSONResponse(
                {"detail": f"Файл слишком большой (максимум {MAX_UPLOAD_MB} МБ)"}, status_code=413
            )
    return await call_next(request)


app.include_router(auth_router)
app.include_router(users_router)
app.include_router(contracts_router)
app.include_router(counterparties_router)
app.include_router(settings_router)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Каталог "входных данных" — единственный источник истины для того, какие
# чертежи считаются актуальными (см. Docs/backlog.md). На каждом старте
# сервера перечитывается целиком: все .dxf из него (пере)обрабатываются,
# как если бы их только что загрузили через UI. Список файлов, доступных
# для выбора в интерфейсе (/source-files), ограничен тем, что РЕАЛЬНО
# лежит в этой папке прямо сейчас — данные ранее загруженных файлов, чьё
# имя больше не встречается в Input/ (удалили, переименовали), никуда не
# исчезают из БД, но перестают предлагаться к выбору.
INPUT_DIR = Path(__file__).resolve().parent.parent / "Input"


def _input_dir_filenames() -> set:
    if not INPUT_DIR.is_dir():
        return set()
    return {p.name for p in INPUT_DIR.glob("*.dxf")}


# Сам импорт при старте — app.input_import.import_input_dxf() (общая
# логика с scripts/rebuild_db.py и аварийным восстановлением ниже, см.
# _attempt_migration_recovery), _input_dir_filenames выше используется
# только для /source-files (список имён, не сам импорт).


SAME_FOOTPRINT_TOLERANCE_MM = 50.0  # см. docstring estimate_marker_radius


def estimate_marker_radius(points, bbox_diag, fraction=0.25):
    """Радиус маркера от медианного расстояния до ближайшего РАЗЛИЧНОГО
    соседа (см. render_plan.py).

    Многоярусные конструкции (колонна/ригель одного и того же следа на
    плане, но на разных отметках — на 2D-схеме это одна и та же точка
    (x, y)) дают координаты, совпадающие или почти совпадающие
    (миллиметровые расхождения из-за округления при разборе разных
    DXF-полилиний одного контура на разных ярусах). Если их не
    исключать, при росте числа ярусов доля таких "нулевых" соседей
    приближается к половине точек — медиана обрушивается почти до нуля,
    и маркеры/подписи становятся невидимыми на любом масштабе (см.
    Docs/backlog.md, "Подписи марок пропали на плотных многоярусных
    файлах"). Поэтому точки одного следа сначала схлопываются в одного
    представителя (решётка с ячейкой SAME_FOOTPRINT_TOLERANCE_MM —
    точной кластеризации для оценки шага между РАЗНЫМИ позициями не
    нужно, приближения достаточно), а медиана считается уже по ним.

    Реализовано через shapely.strtree.STRtree (O(n log n)), а не
    наивным перебором пар (O(n²)) — на плотном многоярусном файле
    (~5300 элементов) наивный вариант занимал ~4 секунды на каждый
    запрос /plan-data, STRtree — ~0.03 секунды.
    """
    n = len(points)
    if n < 2:
        return bbox_diag * 0.01

    seen = {}
    for x, y in points:
        key = (round(x / SAME_FOOTPRINT_TOLERANCE_MM), round(y / SAME_FOOTPRINT_TOLERANCE_MM))
        seen.setdefault(key, (x, y))
    distinct = list(seen.values())
    if len(distinct) < 2:
        return bbox_diag * 0.01

    shapely_points = [Point(x, y) for x, y in distinct]
    tree = STRtree(shapely_points)
    _, dist = tree.query_nearest(shapely_points, exclusive=True, all_matches=False, return_distance=True)
    if len(dist) == 0:
        return bbox_diag * 0.01
    nearest = sorted(dist)
    return nearest[len(nearest) // 2] * fraction


def _warn_users_without_password() -> None:
    """password_hash IS NULL = вход для этого аккаунта запрещён (см.
    app/auth.py verify_password) — это не "тихая" деградация, а рабочая
    учётка, которой прямо сейчас никто не может воспользоваться (в
    частности — свежесозданная БД с дефолтным admin, см. schema.sql).
    Громкий лог при каждом старте — чтобы это не потерялось молча."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT domain_login FROM users WHERE password_hash IS NULL ORDER BY domain_login"
        ).fetchall()
    finally:
        conn.close()
    if rows:
        logins = ", ".join(r["domain_login"] for r in rows)
        print(
            f"[startup] ВНИМАНИЕ: без пароля (вход запрещён, пока не задан): {logins}. "
            f"Задайте пароль через UI (если есть доступ хоть с одной учётки admin) "
            f"или scripts/reset_password.py <domain_login>."
        )


# ---------- аварийное самовосстановление БД при старте ----------
#
# РАЗОВЫЙ защитный механизм на конкретный известный инцидент: после
# деплоя "Контрактация 2.0" тестовый сервер падал в
# db._migrate_contracts_hierarchy ("no such table: contracts_old_v3"),
# точную причину на самом сервере установить не удалось (не было
# SSH-доступа в моменте, см. Docs/backlog.md, 2026-07-28) — а без
# доступа единственный способ поднять сервис снова был пуш в git
# (пайплайн коллеги пересобирает образ и перезапускает контейнер сам).
# Раз ручного вмешательства на сервере не было, добавлена эта функция,
# чтобы при следующем падении по ТОЙ ЖЕ причине сервис чинил себя сам.
#
# ВАЖНО, прочитать перед тем как трогать этот код снова: срабатывает
# ТОЛЬКО на sqlite3.OperationalError с текстом "no such table" — это
# сигнатура застрявшей/повреждённой миграции (переименованная-и-удалённая
# по ходу ALTER TABLE ... RENAME таблица вроде contracts_old_v3, на
# которую могла остаться ссылка внешнего ключа в другой таблице — см.
# Docs/backlog.md, 2026-07-28, "Второй раунд"). Первая версия этой
# функции проверяла УЗКИЙ признак (наличие contracts.supplier) и не
# сработала при повторном падении с ТЕМ ЖЕ текстом ошибки, потому что к
# этому моменту contracts уже был в новой форме — ломалась не сама
# contracts, а FK-ссылка на уже удалённую contracts_old_v3 в ДРУГОЙ
# таблице (elements/status_history/default_contracts). Если ошибка не
# подходит под эту сигнатуру, ничего не делается, чужая ошибка НЕ
# маскируется — падает как раньше. Пользователи (таблица users, включая пароли)
# переносятся в новую БД как есть; всё остальное (элементы, контракты,
# зоны, персональные настройки) — СБРАСЫВАЕТСЯ и грузится заново из
# Input/, тем же путём, что scripts/rebuild_db.py. Это осознанно
# приемлемо, ПОКА сервер на тестовом контуре без ценных данных (живое
# подтверждение пользователя). Если сервер стабилизируется — этот блок
# стоит УБРАТЬ, не оставлять постоянным механизмом: тихая пересборка БД
# при любой будущей (в т.ч. никак не связанной) ошибке миграции — риск
# потерять реальные данные без участия человека.
def _attempt_migration_recovery(exc: Exception) -> bool:
    if not DB_PATH.exists():
        return False
    if not isinstance(exc, sqlite3.OperationalError) or "no such table" not in str(exc):
        return False
    raw = sqlite3.connect(DB_PATH)
    try:
        users_rows = raw.execute("SELECT * FROM users").fetchall()
        users_cols = [d[0] for d in raw.execute("SELECT * FROM users LIMIT 0").description]
    finally:
        raw.close()

    print(
        f"[startup] АВАРИЙНОЕ ВОССТАНОВЛЕНИЕ: init_db() упал ({exc!r}), похоже на "
        f"застрявшую миграцию. Пересобираю БД заново, сохраняя {len(users_rows)} пользователей."
    )

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = DB_PATH.with_name(f"{DB_PATH.name}.bak-{stamp}")
    shutil.move(str(DB_PATH), str(backup_path))
    print(f"[startup] Старая база сохранена как {backup_path.name}.")
    for suffix in ("-journal", "-wal", "-shm"):
        stray = DB_PATH.with_name(DB_PATH.name + suffix)
        if stray.exists():
            stray.unlink()

    init_db()

    conn = get_connection()
    try:
        # Дефолтный admin, которого только что посеяла свежая схема
        # (schema.sql), иначе конфликтует по PRIMARY KEY с восстанавливаемой
        # строкой того же пользователя.
        conn.execute("DELETE FROM users")
        columns_sql = ", ".join(users_cols)
        placeholders = ", ".join("?" for _ in users_cols)
        conn.executemany(
            f"INSERT INTO users ({columns_sql}) VALUES ({placeholders})",
            [tuple(row) for row in users_rows],
        )
        conn.commit()
    finally:
        conn.close()
    print(f"[startup] Пользователи восстановлены ({len(users_rows)}).")

    import_input_dxf()
    import_input_xlsx()
    print("[startup] Аварийное восстановление завершено.")
    return True


@app.on_event("startup")
def on_startup():
    # Обычный старт импортирует ТОЛЬКО *.dxf из Input/, как и раньше —
    # xlsx (Контрактация/Прогноз СМР) на регулярный рестарт НЕ переигрывается
    # (это разовые ручные загрузки, источник истины — уже то, что в БД;
    # переимпорт xlsx нужен только при полной пересборке — см.
    # scripts/rebuild_db.py и _attempt_migration_recovery ниже).
    #
    # ВАЖНО: битая FK-ссылка на удалённую по ходу миграции таблицу (см.
    # _attempt_migration_recovery) на практике может НЕ проявиться внутри
    # самого init_db() (миграции-то уже отметились как выполненные и молча
    # возвращаются) — а вылезти позже, на первой же реальной операции с
    # затронутой таблицей: живой прогон показал падение именно в
    # import_input_dxf() → upsert_elements(), уже ПОСЛЕ успешного init_db().
    # Поэтому в try/except — весь обычный стартовый путь, не только init_db().
    try:
        init_db()
        _warn_users_without_password()
        import_input_dxf()
    except Exception as e:
        if not _attempt_migration_recovery(e):
            raise
        _warn_users_without_password()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/elements", response_model=list[ElementOut])
def list_elements(
    status: Optional[str] = Query(None, description="Фильтр по current_status"),
    element_type: Optional[str] = Query(None),
    source_file: Optional[str] = Query(None),
    mark: Optional[str] = Query(None, description="Подстрока в марке"),
    limit: int = Query(500, le=5000),
    offset: int = Query(0, ge=0),
    user: sqlite3.Row = Depends(get_current_user),
):
    conn = get_connection()
    try:
        clauses, params = [], []
        if status:
            clauses.append("current_status = ?")
            params.append(status)
        if element_type:
            clauses.append("element_type = ?")
            params.append(element_type)
        if source_file:
            clauses.append("source_file = ?")
            params.append(source_file)
        if mark:
            clauses.append("mark LIKE ?")
            params.append(f"%{mark}%")

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"SELECT * FROM elements {where} ORDER BY id LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.get("/elements/{element_id}", response_model=ElementDetailOut)
def get_element(element_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        history_rows = conn.execute(
            "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at",
            (element_id,),
        ).fetchall()
        data = dict(row)
        data["history"] = [dict(h) for h in history_rows]
        enrich_element_row(conn, data)
        return data
    finally:
        conn.close()


@app.patch("/elements/{element_id}/status", response_model=StatusUpdateResult)
def update_status(
    element_id: int, body: StatusUpdateIn, user: sqlite3.Row = Depends(require_editor)
):
    conn = get_connection()
    try:
        # contract_id для новой записи — явно выбранный в диалоге (даже null —
        # "без контракта" осознанно) или унаследованный от предыдущей записи
        # (см. Docs/backlog.md, третий раунд, п.2 и app/contracts.py).
        contract_explicit = "contract_id" in body.model_fields_set
        try:
            data = apply_status_change(
                conn, element_id, body.status.value, contract_explicit, body.contract_id,
                body.changed_at, body.comment, format_display_name(user), user["id"],
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        conn.commit()
        return data
    finally:
        conn.close()


@app.patch("/elements/bulk-status", response_model=BulkStatusUpdateResult)
def update_status_bulk(body: BulkStatusUpdateIn, user: sqlite3.Row = Depends(require_editor)):
    """Массовая смена статуса (выделение рамкой в 2D, см. Docs/backlog.md).
    Контракт для КАЖДОГО элемента — всегда явно выбран на фронте (в т.ч.
    "без контракта" — осознанный выбор, не пропуск поля), поэтому здесь
    contract_explicit=True безусловно, в отличие от одиночного PATCH
    выше, где явность определяется по model_fields_set. Один коммит после
    всего цикла — вся пачка применяется атомарно."""
    if not body.items:
        raise HTTPException(status_code=400, detail="Пустой список элементов")
    conn = get_connection()
    try:
        ids = [item.element_id for item in body.items]
        placeholders = ",".join("?" * len(ids))
        existing_ids = {
            r["id"] for r in conn.execute(f"SELECT id FROM elements WHERE id IN ({placeholders})", ids)
        }
        missing = [i for i in ids if i not in existing_ids]
        if missing:
            raise HTTPException(status_code=404, detail=f"Элементы не найдены: {missing}")

        updated = []
        for item in body.items:
            data = apply_status_change(
                conn, item.element_id, body.status.value, True, item.contract_id,
                body.changed_at, None, format_display_name(user), user["id"],
            )
            updated.append(data)
        conn.commit()
        return {"updated": updated}
    finally:
        conn.close()


@app.patch("/elements/{element_id}/planned-delivery-date", response_model=ElementPlannedDateUpdateResult)
def update_element_planned_delivery_date(
    element_id: int, body: ElementPlannedDateIn, user: sqlite3.Row = Depends(require_editor)
):
    """Плановая дата поставки — независимое действие, НЕ привязанное к
    смене статуса (партии убраны, см. Docs/backlog.md, "Контрактация
    2.0") — единая точка записи, см. app/element_dates.py (та же функция,
    которую зовёт и развёрнутая таблица контракта на фронте)."""
    conn = get_connection()
    try:
        data = set_planned_delivery_date(conn, element_id, body.planned_delivery_date)
        if data is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        conn.commit()
        return data
    finally:
        conn.close()


@app.patch("/elements/bulk-planned-delivery-date", response_model=BulkPlannedDateUpdateResult)
def update_element_planned_delivery_date_bulk(
    body: BulkPlannedDateUpdateIn, user: sqlite3.Row = Depends(require_editor)
):
    if not body.items:
        raise HTTPException(status_code=400, detail="Пустой список элементов")
    conn = get_connection()
    try:
        ids = [item.element_id for item in body.items]
        placeholders = ",".join("?" * len(ids))
        existing_ids = {
            r["id"] for r in conn.execute(f"SELECT id FROM elements WHERE id IN ({placeholders})", ids)
        }
        missing = [i for i in ids if i not in existing_ids]
        if missing:
            raise HTTPException(status_code=404, detail=f"Элементы не найдены: {missing}")

        updated = set_planned_delivery_dates_bulk(
            conn, [(item.element_id, item.planned_delivery_date) for item in body.items]
        )
        conn.commit()
        return {"updated": updated}
    finally:
        conn.close()


@app.delete("/elements/{element_id}/history/{history_id}", response_model=StatusUpdateResult)
def delete_history_entry(
    element_id: int, history_id: int, user: sqlite3.Row = Depends(require_editor)
):
    """См. Docs/backlog.md, третий раунд, п.3. current_status и кэш
    contract_id пересчитываются после удаления той же логикой, что и при
    обычном изменении статуса — работает даже если удаляют не последнюю по
    времени запись."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        entry = conn.execute(
            "SELECT id FROM status_history WHERE id = ? AND element_id = ?", (history_id, element_id)
        ).fetchone()
        if entry is None:
            raise HTTPException(status_code=404, detail="Запись истории не найдена")

        total = conn.execute(
            "SELECT COUNT(*) as n FROM status_history WHERE element_id = ?", (element_id,)
        ).fetchone()["n"]
        if total <= 1:
            raise HTTPException(status_code=400, detail="Нельзя удалить последнюю оставшуюся запись истории")

        conn.execute("DELETE FROM status_history WHERE id = ?", (history_id,))

        recompute_status_and_actual_date(conn, element_id)
        element_contract_id = recompute_element_contract_cache(conn, element_id)
        contract_warning = contract_line_warning(conn, element_contract_id, row["element_type"], row["mark"])
        conn.commit()

        updated_row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        history_rows = conn.execute(
            "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at",
            (element_id,),
        ).fetchall()
        data = dict(updated_row)
        data["history"] = [dict(h) for h in history_rows]
        data["contract_warning"] = contract_warning
        enrich_element_row(conn, data)
        return data
    finally:
        conn.close()


@app.post("/admin/reset-status-history")
def reset_status_history(user: sqlite3.Row = Depends(require_admin)):
    """Массовый сброс истории статусов ВСЕХ элементов — только для
    тестирования (живой запрос пользователя, см. Docs/backlog.md), НЕ
    ограничен одним чертежом/файлом. Каждый элемент возвращается в
    состояние "только что импортирован": одна запись истории 'planned',
    current_status='planned', контракт снят и фактическая дата поставки
    сброшена (тот же принцип, что при обычном откате на "Запланирован",
    apply_status_change/recompute_status_and_actual_date, app/contracts.py)
    — только прямым SQL по всей таблице разом, а не поэлементно через
    apply_status_change — на базе в тысячи элементов поэлементный цикл был
    бы заметно медленнее и не даёт тут никакой дополнительной пользы
    (каждый элемент всё равно приходит к одному и тому же состоянию).
    planned_delivery_date НЕ трогается — она не зависит от истории
    статусов (партии убраны, см. "Контрактация 2.0")."""
    conn = get_connection()
    try:
        n = conn.execute("SELECT COUNT(*) AS n FROM elements").fetchone()["n"]
        conn.execute("DELETE FROM status_history")
        conn.execute(
            "UPDATE elements SET current_status='planned', contract_id=NULL, "
            "actual_delivery_date=NULL, updated_at=datetime('now')"
        )
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, comment) "
            "SELECT id, 'planned', ?, ?, 'массовый сброс истории (тестирование)' FROM elements",
            (format_display_name(user), user["id"]),
        )
        conn.commit()
        return {"reset_count": n}
    finally:
        conn.close()


@app.get("/status-summary", response_model=list[StatusSummaryEntry])
def status_summary(
    source_file: Optional[str] = Query(None), user: sqlite3.Row = Depends(get_current_user)
):
    conn = get_connection()
    try:
        where = "WHERE source_file = ?" if source_file else ""
        params = (source_file,) if source_file else ()
        rows = conn.execute(
            f"SELECT current_status, COUNT(*) as n FROM elements {where} GROUP BY current_status",
            params,
        ).fetchall()
        counts = {r["current_status"]: r["n"] for r in rows}
        return [
            StatusSummaryEntry(status=s, label=STATUS_LABELS_RU[s], count=counts.get(s.value, 0))
            for s in STATUS_ORDER
        ]
    finally:
        conn.close()


@app.get("/source-files")
def list_source_files(user: sqlite3.Row = Depends(get_current_user)):
    """Только файлы, реально присутствующие в Input/ прямо сейчас (см.
    INPUT_DIR выше) — сканируется на каждый запрос (дёшево, файлов мало),
    чтобы файл, убранный из Input/ без перезапуска сервера, тоже сразу
    переставал предлагаться."""
    allowed = _input_dir_filenames()
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT source_file, COUNT(*) as n FROM elements GROUP BY source_file ORDER BY source_file"
        ).fetchall()
        return [{"source_file": r["source_file"], "count": r["n"]} for r in rows if r["source_file"] in allowed]
    finally:
        conn.close()


@app.get("/status-colors")
def get_status_colors(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT status, color FROM status_colors").fetchall()
        return {r["status"]: r["color"] for r in rows}
    finally:
        conn.close()


@app.put("/status-colors")
def set_status_colors(colors: dict[str, str], user: sqlite3.Row = Depends(require_admin)):
    valid = {s.value for s in Status}
    for status in colors:
        if status not in valid:
            raise HTTPException(status_code=422, detail=f"Неизвестный статус: {status}")
    conn = get_connection()
    try:
        for status, color in colors.items():
            conn.execute(
                "INSERT INTO status_colors (status, color) VALUES (?, ?) "
                "ON CONFLICT(status) DO UPDATE SET color = excluded.color",
                (status, color),
            )
        conn.commit()
        rows = conn.execute("SELECT status, color FROM status_colors").fetchall()
        return {r["status"]: r["color"] for r in rows}
    finally:
        conn.close()


@app.get("/label-visibility")
def get_label_visibility(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT element_type, visible FROM label_visibility").fetchall()
        return {r["element_type"]: bool(r["visible"]) for r in rows}
    finally:
        conn.close()


@app.put("/label-visibility")
def set_label_visibility(settings: dict[str, bool], user: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (element_type, visible) VALUES (?, ?) "
                "ON CONFLICT(element_type) DO UPDATE SET visible = excluded.visible",
                (element_type, int(visible)),
            )
        conn.commit()
        rows = conn.execute("SELECT element_type, visible FROM label_visibility").fetchall()
        return {r["element_type"]: bool(r["visible"]) for r in rows}
    finally:
        conn.close()


# Подпункт "Даты" (см. Docs/backlog.md) — тот же паттерн, что
# /label-visibility выше, отдельный столбец той же таблицы: управляет
# ТОЛЬКО допстрокой наклейки (код контрагента + плановая дата поставки),
# не самой видимостью марки.
@app.get("/label-dates-visibility")
def get_label_dates_visibility(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT element_type, dates_visible FROM label_visibility").fetchall()
        return {r["element_type"]: bool(r["dates_visible"]) for r in rows}
    finally:
        conn.close()


@app.put("/label-dates-visibility")
def set_label_dates_visibility(settings: dict[str, bool], user: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (element_type, dates_visible) VALUES (?, ?) "
                "ON CONFLICT(element_type) DO UPDATE SET dates_visible = excluded.dates_visible",
                (element_type, int(visible)),
            )
        conn.commit()
        rows = conn.execute("SELECT element_type, dates_visible FROM label_visibility").fetchall()
        return {r["element_type"]: bool(r["dates_visible"]) for r in rows}
    finally:
        conn.close()


@app.get("/layer-type-combinations")
def list_layer_type_combinations(user: sqlite3.Row = Depends(get_current_user)):
    """Для экрана настроек формы маркера (п.11 третьего раунда) — все
    встреченные пары (слой, тип элемента) с их текущей формой (по
    умолчанию 'outline' — "как в оригинале", если явно не назначено иное в
    element_shapes; см. Docs/backlog.md)."""
    conn = get_connection()
    try:
        combo_rows = conn.execute(
            "SELECT DISTINCT layer, element_type FROM elements ORDER BY layer, element_type"
        ).fetchall()
        shape_map = {
            (r["layer"], r["element_type"]): r["shape"]
            for r in conn.execute("SELECT layer, element_type, shape FROM element_shapes").fetchall()
        }
        return [
            {
                "layer": r["layer"], "element_type": r["element_type"],
                "shape": shape_map.get((r["layer"], r["element_type"]), "outline"),
            }
            for r in combo_rows
        ]
    finally:
        conn.close()


@app.put("/element-shapes")
def set_element_shapes(shapes: list[ElementShapeIn], user: sqlite3.Row = Depends(require_admin)):
    for s in shapes:
        if s.shape not in SHAPES:
            raise HTTPException(status_code=422, detail=f"Неизвестная форма: {s.shape}")
    conn = get_connection()
    try:
        for s in shapes:
            conn.execute(
                "INSERT INTO element_shapes (layer, element_type, shape) VALUES (?, ?, ?) "
                "ON CONFLICT(layer, element_type) DO UPDATE SET shape = excluded.shape",
                (s.layer, s.element_type, s.shape),
            )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok"}


@app.get("/zone-colors")
def list_zone_colors(user: sqlite3.Row = Depends(get_current_user)):
    """Для экрана настроек «Цвета зон» — цвет каждого крана по всем
    файлам, где он встречался (см. Docs/backlog.md, item 7). Стоянки
    отдельного цвета не имеют — наследуют цвет крана на отображении
    (см. plan_data), в этом списке не показываются."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT source_file, category, name, color FROM zone_colors "
            "WHERE category = 'Кран' ORDER BY source_file, name"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.put("/zone-colors")
def set_zone_colors(items: list[ZoneColorIn], user: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        for item in items:
            conn.execute(
                "INSERT INTO zone_colors (source_file, category, name, color) VALUES (?, 'Кран', ?, ?) "
                "ON CONFLICT(source_file, category, name) DO UPDATE SET color = excluded.color",
                (item.source_file, item.name, item.color),
            )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok"}


@app.get("/allowed-subtypes")
def get_allowed_subtypes(user: sqlite3.Row = Depends(get_current_user)):
    """Справочник допустимых подтипов по новому стандарту имён слоёв (см.
    Docs/backlog.md) — редактируется через "Настройки → Справочник
    подтипов", сознательно не зашит в код разбора (scripts/layer_naming.py)."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT element_type, subtype FROM allowed_subtypes ORDER BY element_type, subtype"
        ).fetchall()
        result = {t: [] for t in ZHBI_ELEMENT_TYPES}
        for r in rows:
            result.setdefault(r["element_type"], []).append(r["subtype"])
        return result
    finally:
        conn.close()


@app.post("/allowed-subtypes")
def add_allowed_subtype(body: AllowedSubtypeIn, user: sqlite3.Row = Depends(require_admin)):
    if body.element_type not in ZHBI_ELEMENT_TYPES:
        raise HTTPException(status_code=422, detail=f"Неизвестный тип элемента: {body.element_type}")
    if not body.subtype.strip():
        raise HTTPException(status_code=422, detail="Подтип не может быть пустым")
    conn = get_connection()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO allowed_subtypes (element_type, subtype) VALUES (?, ?)",
            (body.element_type, body.subtype.strip()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok"}


@app.delete("/allowed-subtypes/{element_type}/{subtype}")
def delete_allowed_subtype(element_type: str, subtype: str, user: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM allowed_subtypes WHERE element_type = ? AND subtype = ?", (element_type, subtype)
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok"}


@app.get("/axis-grid")
def axis_grid(source_file: str = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?",
            (source_file,),
        ).fetchall()
        numeric = {r["label"]: r["coord"] for r in rows if r["kind"] == "numeric"}
        letter = {r["label"]: r["coord"] for r in rows if r["kind"] == "letter"}
        return {"numeric": numeric, "letter": letter}
    finally:
        conn.close()


@app.get("/layers")
def list_layers(source_file: str = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    """Слои файла для выбора произвольного набора под источником (п.5 третьего раунда)."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT layer, COUNT(*) as n FROM elements WHERE source_file = ? GROUP BY layer ORDER BY layer",
            (source_file,),
        ).fetchall()
        return [{"layer": r["layer"], "count": r["n"]} for r in rows]
    finally:
        conn.close()


@app.post("/plan-data")
def plan_data(body: PlanSelectionIn, user: sqlite3.Row = Depends(get_current_user)):
    """
    Всё, что нужно интерактивной схеме одним запросом: элементы, сетка осей,
    радиус маркера, цвета. Принимает набор (файл, слои[]) — обычно один
    элемент (п.5: слои внутри одного файла), но поддерживает и несколько
    файлов сразу, совмещённых по координатам (п.13 третьего раунда). Выбор
    сеансовый (не сохраняется на сервере) — состояние живёт только в
    браузере (state.selection).
    """
    conn = get_connection()
    try:
        elements = []
        axis_rows_all = []
        zones = []
        for item in body.selection:
            # item.layers может быть: None ("все слои файла"), непустым
            # списком (конкретные слои) или ПУСТЫМ списком (пользователь
            # снял все галочки — ни одного элемента, но оси/зоны файла
            # остаются). "if item.layers:" здесь был бы багом: пустой
            # список — falsy в Python, и такая проверка неотличима от
            # None, из-за чего "снять все галочки" молча показывало ВСЕ
            # элементы вместо ни одного (см. Docs/backlog.md).
            if item.layers is None:
                q = "SELECT * FROM elements WHERE source_file = ? ORDER BY id"
                params = (item.source_file,)
                rows = conn.execute(q, params).fetchall()
            elif item.layers:
                placeholders = ",".join("?" * len(item.layers))
                q = f"SELECT * FROM elements WHERE source_file = ? AND layer IN ({placeholders}) ORDER BY id"
                params = (item.source_file, *item.layers)
                rows = conn.execute(q, params).fetchall()
            else:
                rows = []
            for r in rows:
                el = dict(r)
                raw_outline = el.pop("outline_json", None)
                el["outline"] = json.loads(raw_outline) if raw_outline else None
                elements.append(el)
            axis_rows_all.extend(
                conn.execute(
                    "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?", (item.source_file,)
                ).fetchall()
            )
            # Зоны не фильтруются набором выбранных слоёв (item.layers) —
            # захватка/кран/стоянка не являются "слоями элементов" в том же
            # смысле, показываются целиком для каждого выбранного файла.
            file_zones = []
            for r in conn.execute(
                "SELECT id, category, elevation_mm, name, outline_json, match_status, "
                "parent_zone_id, parent_match_status FROM zones WHERE source_file = ?",
                (item.source_file,),
            ).fetchall():
                z = dict(r)
                z["outline"] = json.loads(z.pop("outline_json"))
                file_zones.append(z)

            # Цвет — персонально на каждый КРАН (см. Docs/backlog.md, item 7),
            # стоянки наследуют цвет своего крана через parent_zone_id (связь
            # зона-к-зоне, см. scripts/zone_parser._link_stances_to_cranes).
            # Захватка не резолвится здесь вовсе (null) — фронтенд для неё
            # оставляет прежнюю единую CSS-раскраску по категории.
            crane_colors_by_name = {
                r["name"]: r["color"]
                for r in conn.execute(
                    "SELECT name, color FROM zone_colors WHERE source_file = ? AND category = 'Кран'",
                    (item.source_file,),
                ).fetchall()
            }
            crane_name_by_id = {z["id"]: z["name"] for z in file_zones if z["category"] == "Кран"}
            for z in file_zones:
                if z["category"] == "Кран":
                    z["color"] = crane_colors_by_name.get(z["name"])
                elif z["category"] == "Стоянка" and z["parent_match_status"] == "matched" and z["parent_zone_id"]:
                    crane_name = crane_name_by_id.get(z["parent_zone_id"])
                    z["color"] = crane_colors_by_name.get(crane_name) if crane_name else None
                else:
                    z["color"] = None
            zones.extend(file_zones)

        # Допстрока подписи марки на схеме (2D/3D, см. Docs/backlog.md,
        # "Контрактация 2.0") показывается для КАЖДОГО видимого элемента с
        # плановой датой/контрагентом — отдельный запрос под каждый
        # элемент был бы неприемлем при сотнях элементов, поэтому
        # обогащаем весь список одной лёгкой выборкой (contract_id ->
        # counterparty_code), не полными объектами контрактов.
        counterparty_code_by_contract_id = {
            r["id"]: r["code"]
            for r in conn.execute(
                """
                SELECT co.id AS id, c.code AS code
                FROM contracts co
                JOIN specifications s ON s.id = co.specification_id
                JOIN agreements a ON a.id = s.agreement_id
                JOIN counterparties c ON c.id = a.counterparty_id
                """
            ).fetchall()
        }
        for el in elements:
            el["counterparty_code"] = counterparty_code_by_contract_id.get(el.get("contract_id"))

        numeric_axes = {r["label"]: r["coord"] for r in axis_rows_all if r["kind"] == "numeric"}
        letter_axes = {r["label"]: r["coord"] for r in axis_rows_all if r["kind"] == "letter"}
        colors = {
            r["status"]: r["color"]
            for r in conn.execute("SELECT status, color FROM status_colors").fetchall()
        }
        label_visibility = {
            r["element_type"]: bool(r["visible"])
            for r in conn.execute("SELECT element_type, visible FROM label_visibility").fetchall()
        }
        label_dates_visibility = {
            r["element_type"]: bool(r["dates_visible"])
            for r in conn.execute("SELECT element_type, dates_visible FROM label_visibility").fetchall()
        }
        contract_rows = conn.execute(
            """
            SELECT co.id AS id, co.theme AS theme,
                   c.id AS counterparty_id, c.short_name AS counterparty_short_name, c.code AS counterparty_code,
                   a.id AS agreement_id, a.number AS agreement_number, a.agreement_date AS agreement_date,
                   s.id AS specification_id, s.number AS specification_number, s.specification_date AS specification_date
            FROM contracts co
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            JOIN counterparties c ON c.id = a.counterparty_id
            """
        ).fetchall()
        line_rows = conn.execute("SELECT contract_id, element_type FROM contract_lines").fetchall()
        types_by_contract = {}
        for lr in line_rows:
            types_by_contract.setdefault(lr["contract_id"], []).append(lr["element_type"])
        contracts = [
            {
                "id": r["id"],
                "name": build_contract_name(
                    r["counterparty_short_name"], r["agreement_number"], r["agreement_date"],
                    r["specification_number"], r["specification_date"], r["theme"],
                ),
                "theme": r["theme"],
                "counterparty_id": r["counterparty_id"],
                "counterparty_short_name": r["counterparty_short_name"],
                "counterparty_code": r["counterparty_code"],
                "agreement_id": r["agreement_id"], "agreement_number": r["agreement_number"],
                "agreement_date": r["agreement_date"],
                "specification_id": r["specification_id"], "specification_number": r["specification_number"],
                "specification_date": r["specification_date"],
                "element_types": types_by_contract.get(r["id"], []),
            }
            for r in contract_rows
        ]
        default_contracts = {
            r["element_type"]: r["contract_id"]
            for r in conn.execute("SELECT element_type, contract_id FROM default_contracts").fetchall()
        }
        shape_rows = conn.execute("SELECT layer, element_type, shape FROM element_shapes").fetchall()
        element_shapes = {f"{r['layer']} {r['element_type']}": r["shape"] for r in shape_rows}
    finally:
        conn.close()

    # Пустой elements — легитимный результат (пользователь снял все галочки
    # слоёв в файле, должны остаться только оси/зоны), не ошибка сама по
    # себе — ошибка, только если и показать вообще нечего (ни элементов,
    # ни сетки осей, см. Docs/backlog.md).
    if not elements and not (numeric_axes and letter_axes):
        raise HTTPException(status_code=404, detail="Нет элементов и осей для этой выборки")

    points = [(e["x"], e["y"]) for e in elements]
    if points:
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
    else:
        num_vals, let_vals = list(numeric_axes.values()), list(letter_axes.values())
        min_x, max_x = min(num_vals), max(num_vals)
        min_y, max_y = min(let_vals), max(let_vals)

    if numeric_axes and letter_axes:
        num_vals = list(numeric_axes.values())
        let_vals = list(letter_axes.values())
        margin = max(max(num_vals) - min(num_vals), max(let_vals) - min(let_vals)) * 0.03
        extra = margin * 2.8
        min_x = min(min_x, min(num_vals) - extra)
        max_x = max(max_x, max(num_vals) + extra)
        min_y = min(min_y, min(let_vals) - extra)
        max_y = max(max_y, max(let_vals) + extra)

    pad_x = (max_x - min_x) * 0.05 or 1.0
    pad_y = (max_y - min_y) * 0.05 or 1.0
    bbox = {
        "min_x": min_x - pad_x, "max_x": max_x + pad_x,
        "min_y": min_y - pad_y, "max_y": max_y + pad_y,
    }
    bbox_diag = ((bbox["max_x"] - bbox["min_x"]) ** 2 + (bbox["max_y"] - bbox["min_y"]) ** 2) ** 0.5
    marker_radius = estimate_marker_radius(points, bbox_diag)

    return {
        "elements": elements,
        "axis_grid": {"numeric": numeric_axes, "letter": letter_axes},
        "bbox": bbox,
        "marker_radius": marker_radius,
        "status_colors": colors,
        "status_order": [s.value for s in STATUS_ORDER],
        "status_labels": {s.value: STATUS_LABELS_RU[s] for s in STATUS_ORDER},
        "label_visibility": label_visibility,
        "label_dates_visibility": label_dates_visibility,
        "contracts": contracts,
        "default_contracts": default_contracts,
        "element_shapes": element_shapes,
        "zones": zones,
    }


@app.get("/export.xlsx")
def export_xlsx(
    source_file: Optional[str] = Query(None),
    mode: str = Query(..., pattern="^(snapshot|history)$"),
    date: Optional[str] = Query(None, description="Для mode=snapshot: статус на эту дату (YYYY-MM-DD)"),
    date_from: Optional[str] = Query(None, description="Для mode=history: начало периода (YYYY-MM-DD)"),
    date_to: Optional[str] = Query(None, description="Для mode=history: конец периода (YYYY-MM-DD)"),
    user: sqlite3.Row = Depends(get_current_user),
):
    conn = get_connection()
    try:
        if mode == "snapshot":
            content = build_snapshot_xlsx(conn, source_file, date)
            name = f"elements_snapshot{'_' + date if date else ''}.xlsx"
        else:
            content = build_history_xlsx(conn, source_file, date_from, date_to)
            name = "elements_history.xlsx"
    finally:
        conn.close()

    from urllib.parse import quote

    headers = {
        "Content-Disposition": f"attachment; filename=\"export.xlsx\"; filename*=UTF-8''{quote(name)}"
    }
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.get("/export.pdf")
def export_pdf(
    source_file: str = Query(...),
    date: Optional[str] = Query(None, description="Статусы актуальны на эту дату (YYYY-MM-DD); пусто — текущие"),
    user: sqlite3.Row = Depends(get_current_user),
):
    conn = get_connection()
    try:
        try:
            content = build_schema_pdf(conn, source_file, date, format_display_name(user))
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
    finally:
        conn.close()

    from urllib.parse import quote

    name = f"otchet_{source_file}{'_' + date if date else ''}.pdf".replace("/", "_")
    headers = {
        "Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(name)}"
    }
    return Response(content=content, media_type="application/pdf", headers=headers)


@app.post("/import-dxf", response_model=DxfImportResult)
def import_dxf(
    file: UploadFile = File(...),
    source_file: Optional[str] = Form(None),
    user: sqlite3.Row = Depends(require_editor),
):
    try:
        return import_dxf_file(file, source_file, UPLOADS_DIR)
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@app.post("/import-history-xlsx")
def import_history_xlsx(
    file: UploadFile = File(...),
    source_file: str = Form(...),
    mode: str = Form(...),
    admin: sqlite3.Row = Depends(require_admin),
):
    content = read_upload_limited(file.file)
    conn = get_connection()
    try:
        rows = parse_history_xlsx(content)
        return import_history(conn, source_file, rows, mode)
    except HistoryImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.post("/import-contracting-xlsx")
def import_contracting_xlsx(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_admin)):
    """Файл "Контрактация" (см. app/contracting_import.py, Docs/backlog.md,
    "Контрактация 2.0") — создаёт/находит Контрагентов/Договоры/
    Спецификации/Контракты и их позиции по (тип, марка)."""
    content = read_upload_limited(file.file)
    conn = get_connection()
    try:
        parsed = parse_contracting_xlsx(content)
        return import_contracting(conn, parsed)
    except ContractingImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.post("/import-schedule-xlsx")
def import_schedule_xlsx(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_admin)):
    """Файл графика MS Project (см. app/schedule_import.py, Docs/backlog.md,
    "Контрактация 2.0") — заполняет project_delivery_date/
    project_smr_start_date элементов по блоку Кран/Стоянка/Этаж/Тип/Подтип."""
    content = read_upload_limited(file.file)
    conn = get_connection()
    try:
        parsed = parse_schedule_xlsx(content)
        return import_schedule(conn, parsed)
    except ScheduleImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.get("/settings/export")
def export_settings(admin: sqlite3.Row = Depends(require_admin)):
    # Экспорт включает password_hash/password_salt — это осознанно (п.10 в
    # связке с п.3: перенос настроек на другой сервер без необходимости всем
    # заново задавать пароли). Файл предназначен только администратору,
    # обращаться с ним как с резервной копией БД.
    conn = get_connection()
    try:
        users = [dict(r) for r in conn.execute("SELECT * FROM users").fetchall()]
        for u in users:
            u.pop("id", None)
            u.pop("created_at", None)
            u.pop("updated_at", None)
        colors = {
            r["status"]: r["color"] for r in conn.execute("SELECT status, color FROM status_colors").fetchall()
        }
        label_visibility = {
            r["element_type"]: bool(r["visible"])
            for r in conn.execute("SELECT element_type, visible FROM label_visibility").fetchall()
        }
        label_dates_visibility = {
            r["element_type"]: bool(r["dates_visible"])
            for r in conn.execute("SELECT element_type, dates_visible FROM label_visibility").fetchall()
        }
    finally:
        conn.close()

    payload = {
        "users": users, "status_colors": colors, "label_visibility": label_visibility,
        "label_dates_visibility": label_dates_visibility,
    }

    from urllib.parse import quote
    headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + quote("zhbi_settings.json")}
    return Response(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers=headers,
    )


@app.post("/settings/import")
def import_settings(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_admin)):
    try:
        payload = json.loads(read_upload_limited(file.file))
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Файл повреждён или не является корректным JSON")

    conn = get_connection()
    try:
        users_upserted = 0
        for u in payload.get("users", []):
            existing = conn.execute(
                "SELECT id FROM users WHERE domain_login = ?", (u.get("domain_login"),)
            ).fetchone()
            fields = {
                "last_name": u.get("last_name", ""),
                "first_name": u.get("first_name", ""),
                "patronymic": u.get("patronymic"),
                "position": u.get("position"),
                "department": u.get("department"),
                "domain_login": u.get("domain_login"),
                "role": u.get("role", "view"),
                "password_hash": u.get("password_hash"),
                "password_salt": u.get("password_salt"),
            }
            if existing:
                conn.execute(
                    """
                    UPDATE users SET last_name=:last_name, first_name=:first_name,
                        patronymic=:patronymic, position=:position, department=:department,
                        role=:role, password_hash=:password_hash, password_salt=:password_salt,
                        updated_at=datetime('now')
                    WHERE domain_login=:domain_login
                    """,
                    fields,
                )
            else:
                conn.execute(
                    """
                    INSERT INTO users (last_name, first_name, patronymic, position, department,
                        domain_login, role, password_hash, password_salt)
                    VALUES (:last_name, :first_name, :patronymic, :position, :department,
                        :domain_login, :role, :password_hash, :password_salt)
                    """,
                    fields,
                )
            users_upserted += 1

        for status, color in payload.get("status_colors", {}).items():
            conn.execute(
                "INSERT INTO status_colors (status, color) VALUES (?, ?) "
                "ON CONFLICT(status) DO UPDATE SET color = excluded.color",
                (status, color),
            )

        for element_type, visible in payload.get("label_visibility", {}).items():
            conn.execute(
                "INSERT INTO label_visibility (element_type, visible) VALUES (?, ?) "
                "ON CONFLICT(element_type) DO UPDATE SET visible = excluded.visible",
                (element_type, int(visible)),
            )

        for element_type, visible in payload.get("label_dates_visibility", {}).items():
            conn.execute(
                "INSERT INTO label_visibility (element_type, dates_visible) VALUES (?, ?) "
                "ON CONFLICT(element_type) DO UPDATE SET dates_visible = excluded.dates_visible",
                (element_type, int(visible)),
            )

        conn.commit()
    finally:
        conn.close()

    return {
        "users_upserted": users_upserted,
        "status_colors": len(payload.get("status_colors", {})),
        "label_visibility": len(payload.get("label_visibility", {})),
        "label_dates_visibility": len(payload.get("label_dates_visibility", {})),
    }


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

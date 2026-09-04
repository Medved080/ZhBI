import hashlib
import io
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.background import BackgroundTask
from fastapi.staticfiles import StaticFiles
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

from app.auth import audit_display_name, format_display_name, get_current_user
from app.auth import router as auth_router
from app.attachments import counts_for as attachment_counts
from app.attachments import delete_for_entity as delete_attachments_for
from app.attachments import router as attachments_router
from app.changelog import CHANGELOG
from app.contracting_import import ContractingImportError, import_contracting, parse_contracting_xlsx
from urllib.parse import quote

from pydantic import BaseModel

from app import activity
from app import error_log
from app.activity_actions import (
    CATEGORY_DENIED, CATEGORY_ERROR, CATEGORY_ORDER, CATEGORY_TITLES,
)
from app.backups import (
    KIND_BEFORE_REBUILD, KIND_MANUAL, BackupError,
    adopt_legacy_backup, backup_before_import, create_backup, database_bytes,
    delete_backup, disk_state, list_backups, restore_backup,
)
from app.contracts import (
    apply_status_change,
    build_contract_name,
    contract_line_warning,
    enrich_element_row,
    adopt_contract_from_history,
    sync_element_contract,
    recompute_status_and_actual_date,
)
from app.contracts import router as contracts_router
from app.supplier_change import router as supplier_change_router
from app.counterparties import router as counterparties_router
from app.dict_delete import router as dict_delete_router
from app.marks import router as marks_router
from app import zone_recalc
from app.db import (
    DB_PATH,
    get_connection,
    init_db,
    object_source_file,
    projects_tree,
    visible_elements_clause,
)
from app.dxf_import import (
    DxfProcessingError, UPLOADS_DIR, analyze_drawing, apply_drawing, forget_pending,
    get_pending, import_dxf_file, parse_drawing, process_upload, remember_pending,
    save_uploaded_file,
)
from app import revit_colors, revit_import, revit_plan
from app import blocks as blocks_mod
from app import work_progress as work_progress_mod
from app import work_types_import
from app import work_fact
from app import pdf_facade_import
from app import pdf_import
from app import pdf_rooms
from app import import_reset
from app.features import KIND_LABELS, KIND_ZHBI, KINDS
from app.element_fields import (
    EDITABLE_FIELDS,
    FieldError,
    check_subtype,
    coerce_field,
    contract_mismatch,
    write_fields,
)
from app.element_bulk_edit import (
    analyze as analyze_bulk_edit,
    apply_changes as apply_bulk_edit,
    build_export_workbook,
    # Наименования контрактов для выпадашки справочника элементов: та же
    # цепочка Контрагент/Договор/Спецификация и та же build_contract_name,
    # что в выгрузке и в формах. Своя склейка здесь разошлась бы с ними.
    _contract_catalog as contract_catalog,
)
from app import contract_guard, contracting_bulk_edit, db_transfer, status_bulk_edit
from app.access import (
    accessible_object_ids,
    assert_object_access,
    assert_object_feature,
    has_feature,
    is_system_admin,
    object_roles,
    require_feature,
    require_service_feature,
    require_system_admin,
)
from app.element_sync import summary_for_log
from app.element_dates import set_planned_delivery_date, set_planned_delivery_dates_bulk
from app.export import build_history_xlsx, build_snapshot_xlsx
from app.history_import import HistoryImportError, import_history, parse_history_xlsx
from app.import_templates import build_sample, template_list
from app.input_import import import_input_dxf, import_input_xlsx, list_input_files
from app.reports import (
    build_dynamics_report, build_dynamics_report_pdf, build_dynamics_report_xlsx,
    build_status_report, build_status_report_pdf, build_status_report_xlsx,
    in_development_title,
)
from app.report_analytics import (
    TITLE as ANALYTICS_TITLE,
    build_analytics_report, build_analytics_report_pdf, build_analytics_report_xlsx,
)
from app.report_contracting import build_contracting_schedule
from app.report_completion import (
    build_completion_report, build_completion_report_pdf, build_completion_report_xlsx,
)
from app.report_delivery import (
    IN_DEVELOPMENT as DELIVERY_IN_DEVELOPMENT, build_delivery_cell_detail,
    build_delivery_schedule_pdf, build_delivery_schedule_report, build_delivery_schedule_xlsx,
)
from app.report_pivot import (
    VIEW_PIVOT, build_completion_pivot, build_completion_pivot_pdf,
    build_completion_pivot_xlsx, normalize_view,
)
from app.report_my_work import (
    FILE_LIMIT, NON_CHANGE_ACTIONS, SCREEN_LIMIT, action_title, build_my_work_pdf,
    build_my_work_report, build_my_work_xlsx, changed_element_ids, value_text,
)
from app.models import (
    RevitAnalyzeResult,
    RevitApplyIn,
    RevitImportResult,
    ProjectIn,
    ProjectOut,
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
    ExportRequestIn,
    Status,
    DxfAnalyzeResult,
    DxfApplyIn,
    DxfImportResult,
    ElementDetailOut,
    ElementOut,
    PlanSelectionIn,
    StatusHistoryOut,
    StatusSummaryEntry,
    StatusUpdateIn,
    StatusUpdateResult,
    ZoneColorIn,
    validate_color,
    ObjectOut,
    ObjectPatchIn,
    ZoneLevelIn,
    ZoneLevelOut,
    ZoneOut,
    ZonePatchIn,
)
from app.pdf_export import build_schema_pdf
from app.schedule_import import ScheduleImportError, import_schedule, parse_schedule_xlsx
from app.report_help import help_for as report_help_for
from app.schedule_calc import router as schedule_calc_router
from app.schedule_versions import element_deviation
from app.schedule_versions import router as schedule_versions_router
from app.admin_guide import router as admin_guide_router
from app.training import router as training_router
from app.db_status import router as db_status_router
from app.db_status import table_bytes as db_status_table_bytes
from app.fill_scope import router as fill_scope_router
from app.ldap_auth import router as ldap_router
from app.release_tasks import router as release_tasks_router
from app.rights_matrix import router as rights_matrix_router
from app.roles import router as roles_router
from app.settings import router as settings_router
from app.impersonation import ImpersonationMiddleware
from app.upload_limits import (
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_MB,
    MaxBodySizeMiddleware,
    read_upload_limited,
)
from app.users import router as users_router, sessions_router

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
    #
    # Сама СТРАНИЦА («/», app/static/index.html) сюда не попадала до
    # 2026-08-05, и это ловушка, а не мелочь: index.html отдаётся не
    # StaticFiles, а отдельным маршрутом serve_index, и под условие
    # «/static/» не подходил. Разметка меню, вкладок и форм живёт именно в
    # нём — то есть переименование пунктов меню могло сколько угодно долго
    # не доезжать до браузера при полностью обновлённом сервере (поймано
    # живьём в этот же день: сервер отдавал новые названия отчётов, а
    # вкладка показывала старые).
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    # Неуспешный ответ — в журнал (2026-08-20). Здесь ловится ХВОСТ: то, до
    # чего обработчики исключений ниже не доходят — отказ по размеру тела
    # (его отдаёт посредник снаружи роутера), ответ, собранный роутом
    # вручную. Уже записанное не дублируется: обработчик ставит на запрос
    # отметку (app/error_log.note_response).
    if response.status_code >= 400:
        error_log.note_response(request, response.status_code)
    return response


# Обработчики ошибок — ЕДИНСТВЕННОЕ место, где сбой попадает в журнал
# (2026-08-20, живой запрос «добавь сквозную регистрацию ошибок»). Раньше
# исключение уходило только трассировкой в лог uvicorn на сервере, а отказ
# по правам не оставлял следа вовсе.
#
# Ответ пользователю остаётся ПРЕЖНИМ: каждый обработчик отдаёт ровно то,
# что отдавал FastAPI по умолчанию (те же функции), и только попутно пишет
# событие. Иначе тексты ошибок в интерфейсе разъехались бы с привычными.
@app.exception_handler(StarletteHTTPException)
async def _log_http_exception(request: Request, exc: StarletteHTTPException):
    error_log.note_http_error(request, exc.status_code, str(exc.detail))
    return await http_exception_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def _log_validation_error(request: Request, exc: RequestValidationError):
    error_log.note_validation_error(request, str(exc.errors())[:500])
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(BackupError)
async def _backup_error(request: Request, exc: BackupError):
    """Копию базы снять не удалось — чаще всего кончилось место (507).

    Обработчик общий, а не try/except у каждого вызова: копия снимается
    перед КАЖДОЙ загрузкой данных из файла (2026-08-21, восемь точек), и
    восемь одинаковых обёрток разошлись бы при первой же правке. Текст
    BackupError уже написан для человека и говорит, что делать, — отдаём
    его как есть.

    Отказ здесь означает, что загрузка НЕ НАЧАЛАСЬ: копия снимается до
    первой записи. Это и есть требуемое поведение — данные важнее
    загрузки (см. шапку app/backups.py).
    """
    error_log.note_http_error(request, exc.status_code, exc.message)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(Exception)
async def _log_unhandled_exception(request: Request, exc: Exception):
    """Необработанное исключение. Трассировка в логе uvicorn остаётся:
    ServerErrorMiddleware пробрасывает исключение дальше уже ПОСЛЕ вызова
    этого обработчика, поэтому запись в журнал не отменяет привычного
    разбора по логам сервера."""
    error_log.note_exception(request, exc)
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})


# Лимит тела запроса — САМЫМ ВНЕШНИМ слоем (add_middleware ставит
# последний добавленный снаружи всех предыдущих), чтобы отсечь приём
# раньше, чем тело дойдёт до разбора multipart и до зависимостей
# авторизации. Реализация — в app/upload_limits.py, там же объяснено,
# почему это чистый ASGI-класс, а не @app.middleware.
app.add_middleware(MaxBodySizeMiddleware, max_bytes=MAX_UPLOAD_BYTES)

# Режим «Зайти под пользователем» (2026-08-05) — разбор заголовка и установка
# контекста запроса. ЧИСТЫЙ ASGI-класс, а не @app.middleware: тот работает
# через BaseHTTPMiddleware, где обработчик уходит в отдельную задачу, и
# полагаться на распространение contextvars вниз нельзя, а именно на нём
# держатся отметки в журнале и в истории статусов. Подробности — в
# app/impersonation.py. Запрос без заголовка не платит ничего.
app.add_middleware(ImpersonationMiddleware)

app.include_router(auth_router)
# ДО users_router: у того пути вида /users/{user_id}/…, и «access-matrix»
# не должен иметь ни единого шанса уехать в {user_id}.
app.include_router(rights_matrix_router)
app.include_router(roles_router)
app.include_router(release_tasks_router)
app.include_router(users_router)
app.include_router(sessions_router)
app.include_router(ldap_router)
app.include_router(admin_guide_router)
app.include_router(training_router)
app.include_router(db_status_router)
app.include_router(fill_scope_router)
app.include_router(contracts_router)
app.include_router(supplier_change_router)
app.include_router(schedule_versions_router)
app.include_router(schedule_calc_router)
app.include_router(counterparties_router)
app.include_router(marks_router)
app.include_router(dict_delete_router)
app.include_router(settings_router)
app.include_router(attachments_router)

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
# app/backups.py), _input_dir_filenames выше используется
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
    Громкий лог при каждом старте — чтобы это не потерялось молча.

    Доменные пользователи (auth_method='domain') сюда НЕ попадают: у них
    пароль сервиса пуст закономерно, вход им даёт контроллер домена (см.
    app/ldap_auth.py). Иначе предупреждение при каждом старте перечисляло бы
    исправно работающие учётные записи и быстро перестало бы читаться."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT domain_login FROM users WHERE password_hash IS NULL "
            "AND auth_method != 'domain' ORDER BY domain_login"
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
#
# Список ЗАВЕДОМО безобидных висячих внешних ключей. Сейчас пуст, и это
# осознанно: единственная запись, которая тут была
# (elements.batch_id -> batches, остаток убранных "Партий"), оказалась НЕ
# безобидной — с PRAGMA foreign_keys = ON на ней падала любая вставка в
# elements, то есть загрузка любого чертежа (см. Docs/backlog.md,
# 2026-07-30). Колонка снята миграцией _migrate_elements_drop_batch_id
# (app/db.py). Вывод на будущее: "ни одна операция её не использует" —
# утверждение, которое надо проверять записью, а не рассуждением; висячий
# FK безобиден только пока в таблицу никто не пишет.
_KNOWN_HARMLESS_DANGLING_FKS = set()


def _probe_schema_health() -> list:
    """Ищет внешние ключи, целевой таблицы которых в базе нет.

    ВНИМАНИЕ, дорого купленное правило: эта функция ТОЛЬКО СООБЩАЕТ и
    НИКОГДА не бросает исключений. Вызывать её нужно ВНЕ try/except вокруг
    прежний механизм аварийной пересборки БД (удалён 2026-07-29).

    Первая версия делала наоборот — бросала OperationalError("no such
    table: ...") прямо внутри того try, и 2026-07-29 это стоило пользователю
    всех статусов: детектор нашёл БЕЗОБИДНЫЙ остаток elements.batch_id ->
    batches (партии убраны ещё в "Контрактации 2.0", таблицы нет, колонка
    осталась), исключение поймал except, и БД была молча пересобрана
    заново — 231 смонтированный элемент превратился в "Запланирован".
    База уцелела только потому, что восстановление кладёт старую в .bak.

    Отсюда два урока, оба стоят того, чтобы их держать в голове:
      1. Детектор нельзя подключать к разрушительному действию. Сообщать и
         разрушать — разные полномочия.
      2. "Похоже на поломку" не равно "поломка". Условие срабатывания
         (OperationalError + подстрока "no such table") было настолько
         широким, что под него попал безобидный мусор схемы.

    Известные безобидные остатки перечислены явным списком
    (_KNOWN_HARMLESS_DANGLING_FKS) — молчать про НЕизвестные не станем, но
    и пугать известными незачем.

    Только читает: ни одной операции записи."""
    conn = get_connection()
    try:
        tables = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        dangling = []
        for table in sorted(tables):
            for fk in conn.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
                target = fk["table"]
                if target in tables:
                    continue
                entry = (table, fk["from"], target)
                if entry in _KNOWN_HARMLESS_DANGLING_FKS:
                    continue
                dangling.append(entry)
    finally:
        conn.close()
    for table, column, target in dangling:
        print(
            f"[startup] ВНИМАНИЕ: внешний ключ {table}.{column} ссылается на "
            f"несуществующую таблицу '{target}'. Операции записи в {table} будут "
            f"падать с 'no such table: {target}'. База НЕ пересобирается "
            f"автоматически — разберитесь вручную (scripts/rebuild_db.py, "
            f"предварительно сняв копию)."
        )
    return dangling


@app.on_event("startup")
def _warn_unknown_menu_features() -> None:
    """Сверить разделы, на которые ссылаются пункты меню, с реестром.

    Пункт меню гасится своим разделом (`data-feature` в разметке). Раздела с
    таким ключом может не оказаться вовсе — опечатка или переименование в
    app/features.py, — и тогда пункт пропадает У ВСЕХ, молча: `can()` для
    неизвестного ключа честно отвечает «нет доступа». Так 2026-08-14
    исчезли пять пунктов разом («Смена поставщика», цвета статусов, формы
    маркеров, подтипы, префиксы марок): разметка спрашивала разделы
    `supplier_change` и `dictionaries`, которых в реестре нет.

    Проверка на СТАРТЕ, а не тестом: тестов в проекте нет, а цена ошибки —
    невидимый пункт меню, который никто не свяжет с переименованием ключа.
    Только предупреждение в лог: пункт меню не повод не пускать сервер.
    """
    import re
    from app.features import FEATURES

    try:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    except OSError:
        return
    известные = {f.key for f in FEATURES}
    ключи = set()
    for значение in re.findall(r'data-feature="([^"]+)"', html):
        ключи.update(k.strip() for k in значение.split(",") if k.strip())
    неизвестные = sorted(ключи - известные)
    if неизвестные:
        print(f"[startup] ВНИМАНИЕ: пункты меню ссылаются на несуществующие разделы прав "
              f"({', '.join(неизвестные)}) — эти пункты не увидит НИКТО. "
              f"Проверьте data-feature в app/static/index.html и реестр app/features.py.")


@app.on_event("startup")
def on_startup():
    # Обычный старт НЕ импортирует ничего из Input/ (живой запрос
    # пользователя 2026-07-29: "убрать загрузку данных при старте системы,
    # данные загружаем только интерактивно").
    #
    # Почему это правильно, а не просто удобнее. Раньше здесь стоял
    # import_input_dxf(), то есть КАЖДЫЙ рестарт сервера переписывал
    # геометрию всех уже загруженных элементов заново. А рестарт — это не
    # редкое событие: его делает каждый деплой через CI/CD, каждый
    # `docker compose up`, каждое падение с автоперезапуском
    # (restart: unless-stopped). Побочный эффект: любой лишний запуск
    # сервера превращался в запись в боевые данные — в том числе случайный
    # второй экземпляр, поднятый рядом на другом порту.
    #
    # Импорт из Input/ теперь только по явной команде:
    # POST /admin/import-input (пункт меню "Загрузить из папки Input"),
    # плюс полная пересборка scripts/rebuild_db.py, где без него получилась
    # бы пустая база.
    #
    # АВАРИЙНОЕ САМОВОССТАНОВЛЕНИЕ УДАЛЕНО (2026-07-29, по требованию
    # пользователя). Раньше здесь стоял try/except, ловивший ошибку старта и
    # молча пересобиравший БД с нуля, сохраняя только users. Механизм вводился
    # как разовый под конкретный июльский инцидент и с самого начала был
    # помечен в CLAUDE.md как временный. За время жизни он дважды сработал
    # разрушительно, второй раз — в тот же день, когда добавили безобидный
    # детектор схемы (см. Docs/backlog.md, "ИНЦИДЕНТ"), и стёр 231
    # смонтированный элемент.
    #
    # Правильное поведение при непроходимой миграции — УПАСТЬ с понятной
    # ошибкой в логе. Упавший сервер чинит человек, у которого есть и копии
    # (см. app/backups.py), и scripts/rebuild_db.py. Молча пересобранная
    # база выглядит как работающий сервис, в котором просто исчезла работа
    # за несколько недель, — это несравнимо хуже отказа стартовать.
    # Копия базы ПЕРЕД первым стартом новой версии — до миграций схемы и до
    # обработок релиза (app/release_tasks.py). И то и другое применяется
    # автоматически, без человека, и единственная возможность вернуться —
    # копия, снятая ДО них. Ничего не делает, если версия та же (рестарт при
    # падении и `docker compose up` не должны забивать диск копиями).
    # Место — ПЕРЕД копией, а не после (2026-08-19, запрос пользователя).
    # Именно эта строка ниже упирается в кончившийся диск первой, и если она
    # упадёт, старт не состоится вовсе. Тогда в журнале контейнера должна
    # стоять внятная причина ВЫШЕ traceback'а, а не вместо него: человек
    # читает лог сверху вниз и до разбора стека доходит не всегда.
    место = disk_state()
    if место.get("message"):
        print(f"[startup] ВНИМАНИЕ: {место['message']}")

    from app import release_tasks
    копия = release_tasks.backup_before_update()
    if копия:
        print(f"[startup] перед обновлением снята копия базы: {копия['name']}")

    schema_changes = init_db()
    _warn_users_without_password()

    # Только СООБЩАЕТ о подозрительной схеме, никогда не бросает исключений
    # и ничего не пересобирает (см. её docstring).
    _probe_schema_health()

    _warn_unknown_menu_features()

    # Файлы от прежнего механизма аварийной пересборки (data/zhbi.db.bak-*)
    # — полноценные копии, просто лежат не в папке копий и без описания.
    # Забираем их под общий учёт, чтобы они были видны в списке
    # восстановления, а не потерялись рядом с базой.
    for legacy in sorted(DB_PATH.parent.glob(f"{DB_PATH.name}.bak-*")):
        adopted = adopt_legacy_backup(
            legacy, KIND_BEFORE_REBUILD,
            "копия от прежнего механизма аварийной пересборки БД (механизм удалён)",
        )
        if adopted:
            print(f"[startup] Прежняя копия {legacy.name} перенесена в data/backups/ как {adopted['name']}.")

    # Фоновый писатель журнала — после init_db(), чтобы таблица activity_log
    # точно существовала к моменту первой записи.
    activity.start_worker()

    # СИСТЕМНЫЕ события в журнал (живой репорт пользователя 2026-07-30: "не
    # вижу в журнале никаких событий, которые выполнялись при обновлении,
    # только интерактивные действия"). До этого журнал знал только про
    # действия людей, а самое важное для разбора инцидента — что сделал с
    # базой сам деплой — не попадало никуда, кроме stdout контейнера.
    #
    # source="system", user_name пустой: это не действие пользователя, и
    # приписывать его тому, кто случайно оказался админом, неправильно.
    version = CHANGELOG[0]["version"] if CHANGELOG else None
    activity.log("server_start", source="system", new_value=version)
    for change in schema_changes:
        activity.log("schema_migration", source="system", new_value=change)
    if schema_changes:
        print(f"[startup] структурных изменений схемы применено: {len(schema_changes)}")
    if копия:
        activity.log("backup_before_update", source="system", new_value=копия["name"])

    # Обработки релиза — то, что новая версия делает с уже накопленными
    # данными. Здесь, а не раньше: им нужны и мигрированная схема, и живой
    # писатель журнала. Упавшая обработка НЕ роняет старт (решение
    # пользователя 2026-08-04): сервис работает и предупреждает в «Что
    # нового», администратор повторяет её кнопкой, без подключения к серверу.
    выполнено = release_tasks.run_pending()
    if выполнено:
        print(f"[startup] обработок релиза выполнено: {len(выполнено)}")


# СТРАЖ РЕГИСТРАЦИИ СТАРТА (2026-08-17). Проверка стоит здесь, а не в тестах,
# потому что ловит ошибку, которая уже случилась и стоила трёх дней работы
# продуктового сервера.
#
# Что было. 2026-08-14 перед `def on_startup()` вставили новую функцию
# (`_warn_unknown_menu_features`), и она встала МЕЖДУ декоратором и телом —
# то есть забрала `@app.on_event("startup")` себе. Синтаксически безупречно,
# импорт проходит, сервис поднимается и отвечает. Не выполняется при этом
# ВЕСЬ старт: миграции схемы, обработки релиза, копия базы перед
# обновлением, запуск писателя журнала.
#
# Почему это не заметили. На машине разработчика базы уже мигрированы, и
# отсутствие миграции невидимо: всё работает. Отказ проявился только на
# сервере, где приехала новая версия — новых таблиц (`object_roles`,
# `role_features`, `schedule_versions`) в базе не завелось, и половина
# сервиса стала отвечать 500 «no such table», а обновление зависло на версии
# данных 0.51 при коде 0.53.
#
# Падать при импорте — намеренно жёстко: сервис, который поднялся без
# миграций, ХУЖЕ сервиса, который не поднялся. Первый три дня тихо портит
# картину и обнаруживается по чужим жалобам, второй виден сразу в CI и в
# журнале контейнера.
_НА_СТАРТЕ = {getattr(f, "__name__", "") for f in app.router.on_startup}
if "on_startup" not in _НА_СТАРТЕ:
    raise RuntimeError(
        "app.main.on_startup не зарегистрирован обработчиком старта: миграции схемы, "
        "обработки релиза и копия базы перед обновлением выполняться не будут. "
        "Проверьте, что @app.on_event(\"startup\") стоит НЕПОСРЕДСТВЕННО над "
        "`def on_startup()`, а не над функцией, вставленной перед ней. "
        f"Сейчас зарегистрированы: {sorted(_НА_СТАРТЕ)}"
    )


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------- «вышло обновление, перезагрузите страницу» ----------
# Задача (живой запрос 2026-08-10): после деплоя открытая вкладка продолжает
# работать СТАРЫМ фронтендом — index.html и app.js в ней те, что скачались
# при входе, — и человек об этом не знает. Расхождение не безобидное: старый
# фронт может слать поля, которых сервер уже не ждёт, и не показывать то,
# ради чего обновление и выкатывали.
#
# Отпечаток сборки считается ОДИН РАЗ при импорте модуля, то есть при старте
# процесса, — по mtime и размеру файлов фронтенда плюс номер верхней записи
# журнала версий. Почему так, а не по номеру версии: запись в журнал версий
# добавляется вручную и не на каждый деплой (её текст ещё и согласуется), а
# устаревает вкладка от ЛЮБОГО изменения фронтенда. Почему не по содержимому
# файлов: app.js — это 700+ КБ, считать хэш на каждый запрос ни к чему,
# а на старте достаточно и метаданных: новый образ — новые файлы.
def _compute_app_build() -> str:
    parts = [CHANGELOG[0]["version"] if CHANGELOG else "0"]
    static_dir = Path(__file__).resolve().parent / "static"
    for name in ("index.html", "app.js"):
        try:
            st = (static_dir / name).stat()
            parts.append(f"{name}:{int(st.st_mtime)}:{st.st_size}")
        except OSError:
            # Файла нет (теоретически — иная сборка образа): отпечаток всё
            # равно должен получиться, иначе сломается сам механизм.
            parts.append(f"{name}:?")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


APP_BUILD = _compute_app_build()


@app.get("/app-build")
def get_app_build(user: sqlite3.Row = Depends(get_current_user)):
    """Отпечаток сборки фронтенда — вкладка сверяет его со своим и, если он
    сменился, показывает полосу «вышло обновление». Требует входа, как и всё
    остальное; ответ — десяток байт, поэтому опрашивается тем же таймером,
    что и `/changes` (см. app.js, checkAppBuild)."""
    return {"build": APP_BUILD, "version": CHANGELOG[0]["version"] if CHANGELOG else None}


@app.get("/changelog")
def get_changelog(user: sqlite3.Row = Depends(get_current_user)):
    # Требует входа, как и весь остальной функционал (см. Docs/TZ.md) —
    # список релизов не публичный. Порядок — как в app/changelog.py (от
    # новой версии к старой), фронтенд ничего не сортирует сам.
    #
    # НЕПРОЧИТАННЫЕ ЗАПИСИ ПОМЕЧАЕТ СЕРВЕР (2026-08-17, живой запрос). До
    # этого клиент знал только «есть ли непрочитанное вообще» (признак
    # changelog_unseen в /me), и человек, вернувшийся после нескольких
    # обновлений, не понимал, докуда дочитал в прошлый раз.
    #
    # Считаем ПО ПОРЯДКУ СПИСКА, а не сравнением номеров: непрочитано всё,
    # что лежит ВЫШЕ подтверждённой версии. Это ровно смысл кнопки
    # «Ознакомился» — она записывает верхнюю версию журнала. Сравнивать
    # номера как строки нельзя вовсе: «0.9» лексикографически больше «0.53»,
    # хотя вышла раньше, и первый же двузначный номер перевернул бы порядок.
    #
    # Версия не найдена в списке (её удалили) или не подтверждалась ни разу
    # — непрочитано ВСЁ: показать лишнее не вредно, промолчать о новом —
    # вредно.
    подтверждена = (user["changelog_ack_version"]
                    if "changelog_ack_version" in user.keys() else None)
    номера = [e["version"] for e in CHANGELOG]
    граница = номера.index(подтверждена) if подтверждена in номера else len(CHANGELOG)
    return [{**запись, "unseen": i < граница} for i, запись in enumerate(CHANGELOG)]


@app.post("/changelog/ack")
def ack_changelog(user: sqlite3.Row = Depends(get_current_user)):
    """«Ознакомился» (2026-08-03, живой запрос). Записывает за пользователем
    номер САМОЙ СВЕЖЕЙ версии журнала, а не флажок «видел»: следующая запись
    обязана снова потребовать внимания, и хранение версии делает это само —
    сбрасывать признак всем разом вручную не нужно.

    Версию подставляет сервер, а не присылает клиент: иначе «ознакомился»
    можно было бы проставить для будущей версии и больше не увидеть журнал
    никогда. Отдельно от `/users/{id}/…` — действие всегда над СОБОЙ, чужое
    ознакомление никто не отмечает."""
    version = CHANGELOG[0]["version"] if CHANGELOG else None
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE users SET changelog_ack_version = ?, updated_at = datetime('now') WHERE id = ?",
            (version, user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    activity.log("user_changelog_ack", user=user, entity_type="user", entity_id=user["id"],
                 new_value=f"v{version}" if version else "")
    return {"acknowledged_version": version}


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
        clauses, params = [visible_elements_clause()], []
        доступ, доступ_params = _accessible_objects_clause(conn, user)
        clauses.append(доступ)
        params.extend(доступ_params)
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

        where = f"WHERE {' AND '.join(clauses)}"
        rows = conn.execute(
            f"SELECT * FROM elements {where} ORDER BY id LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _element_reference_labels(conn, data: dict) -> dict:
    """Названия зон/объекта и объём контура для формы элемента.

    Отдельная функция, а не расширение enrich_element_row: та зовётся на
    КАЖДУЮ строку /plan-data (9422 элемента), и четыре лишних запроса на
    строку там недопустимы. Здесь элемент один — стоимость неважна.
    """
    for id_field, name_field in (
        ("zone_zakhvatka_id", "zone_zakhvatka_name"),
        ("zone_crane_id", "zone_crane_name"),
        ("zone_stance_id", "zone_stance_name"),
    ):
        data[name_field] = None
        zone_id = data.get(id_field)
        if zone_id is not None:
            r = conn.execute("SELECT name FROM zones WHERE id = ?", (zone_id,)).fetchone()
            data[name_field] = r["name"] if r else None

    data["zone_stance_level_elevation_mm"] = None
    if data.get("zone_stance_level_id") is not None:
        r = conn.execute(
            "SELECT elevation_mm FROM zone_levels WHERE id = ?", (data["zone_stance_level_id"],)
        ).fetchone()
        data["zone_stance_level_elevation_mm"] = r["elevation_mm"] if r else None

    data["object_name"] = None
    if data.get("object_id") is not None:
        r = conn.execute("SELECT name FROM objects WHERE id = ?", (data["object_id"],)).fetchone()
        data["object_name"] = r["name"] if r else None

    data["outline_points"] = None
    raw = data.get("outline_json")
    if raw:
        try:
            data["outline_points"] = len(json.loads(raw))
        except (ValueError, TypeError):
            data["outline_points"] = None
    return data


@app.get("/elements/{element_id}", response_model=ElementDetailOut)
def get_element(element_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        # Карточка отдаёт элемент вместе со ВСЕЙ историей статусов (кто и
        # когда менял, с ФИО) и названием объекта — до аудита 2026-08-03
        # любому вошедшему по любому id (аудит безопасности).
        _guard_elements(conn, user, [element_id], "plan", "read")
        history_rows = conn.execute(
            "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at",
            (element_id,),
        ).fetchall()
        data = dict(row)
        data["history"] = [dict(h) for h in history_rows]
        enrich_element_row(conn, data)
        _element_reference_labels(conn, data)
        # Прогноз и отклонение — только в карточке (как и названия зон выше):
        # в /plan-data это лишний запрос на каждое из 9422 изделий, а нужен
        # он ровно там, где смотрят одно.
        data["schedule_forecast"] = element_deviation(conn, element_id)
        return data
    finally:
        conn.close()


@app.get("/elements/{element_id}/context")
def element_context(element_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Мини-карта изделия (2026-08-05, запрос пользователя): где оно стоит —
    оси, основание объекта, зоны и сам контур.

    Устроено по образцу /zones/{id}/geometry: контекст отдаётся ОДНИМ
    запросом и не опирается на то, что сейчас загружено в браузере — форма
    изделия открывается и из справочника, при любом выбранном чертеже, а то
    и вовсе без открытой схемы.

    Чего здесь НЕТ и почему: остальных 9421 изделий. Мини-карта должна
    открываться мгновенно, а не перерисовывать всю схему — вопрос, на
    который она отвечает, звучит «в каком месте стройки эта колонна», и
    соседние колонны на него не отвечают. Роль «где именно» играют оси и
    контуры зон: они же и есть та разметка, которой на площадке меряют.

    Основание объекта — контуры ЗАХВАТОК: они покрывают пятно застройки и
    уже лежат в базе полигонами. Считать пятно по контурам изделий значило
    бы прочитать девять тысяч контуров ради рамки картинки.
    """
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        _guard_elements(conn, user, [element_id], "plan", "read")

        axes = [
            {"kind": r["kind"], "label": r["label"], "coord": r["coord"]}
            for r in conn.execute(
                "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?",
                (row["source_file"],),
            )
        ]
        зоны = []
        for r in conn.execute(
            """
            SELECT z.id, z.category, z.name, l.elevation_mm, l.outline_json
            FROM zones z JOIN zone_levels l ON l.zone_id = z.id
            WHERE z.object_id = ? AND z.is_current = 1
            """,
            (row["object_id"],),
        ):
            зоны.append({
                "id": r["id"], "category": r["category"], "name": r["name"],
                "elevation_mm": r["elevation_mm"], "outline": json.loads(r["outline_json"]),
                # Своя зона рисуется ярче прочих — это ответ на «в какой
                # захватке стоит изделие», а не просто фон.
                "own": r["id"] in (row["zone_zakhvatka_id"], row["zone_crane_id"],
                                   row["zone_stance_id"]),
            })

        xs, ys = [], []
        for z in зоны:
            for point in z["outline"]:
                xs.append(point[0])
                ys.append(point[1])
        for axis in axes:
            (xs if axis["kind"] == "numeric" else ys).append(axis["coord"])
        xs.append(row["x"])
        ys.append(row["y"])
        bbox = [min(xs), min(ys), max(xs), max(ys)] if xs and ys else None

        return {
            "element": {
                "id": row["id"], "x": row["x"], "y": row["y"], "z": row["z"],
                "elevation_mm": row["elevation_mm"],
                "element_type": row["element_type"], "mark": row["mark"],
                "outline": json.loads(row["outline_json"]) if row["outline_json"] else None,
            },
            "bbox": bbox,
            "axes": axes,
            "zones": зоны,
        }
    finally:
        conn.close()


@app.get("/elements/{element_id}/activity")
def element_activity(element_id: int, limit: int = Query(200, le=1000),
                     user: sqlite3.Row = Depends(get_current_user)):
    """История изменений ОДНОГО изделия — все события журнала о нём (живой
    запрос 2026-08-03, блок в свойствах элемента).

    Доступ — по объекту изделия, а не по системной роли: журнал целиком
    (`GET /activity`) остаётся за администратором сервиса, но «что делали
    именно с этим изделием» нужно всякому, кому изделие вообще видно, —
    иначе прораб не может проверить собственную работу.

    Отдельным запросом, а не частью карточки: карточка открывается на каждый
    клик по схеме, а эти события нужны не всегда (см. кнопку «Показать» в
    интерфейсе).
    """
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM elements WHERE id = ?", (element_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        _guard_elements(conn, user, [element_id], "activity", "read")
        rows = conn.execute(
            "SELECT id, at, user_name, impersonator_name, action, old_value, new_value, "
            "request_id, details "
            "FROM activity_log WHERE entity_type = 'element' AND entity_id = ? "
            "AND source = 'server' AND action NOT IN ({}) "
            "ORDER BY at DESC, id DESC LIMIT ?".format(
                ",".join("?" * len(NON_CHANGE_ACTIONS))),
            [element_id] + sorted(NON_CHANGE_ACTIONS) + [limit],
        ).fetchall()
        return {
            "rows": [{
                "id": r["id"], "at": r["at"], "user_name": r["user_name"],
                # Режим «Зайти под пользователем»: в карточке изделия обязано
                # быть видно, что запись сделал администратор, а не сам
                # человек, — иначе спрос за неё пойдёт не с того.
                "impersonator_name": r["impersonator_name"],
                "action": r["action"], "action_title": action_title(r["action"]),
                "old_text": value_text(r["old_value"]), "new_text": value_text(r["new_value"]),
            } for r in rows],
            "total": len(rows),
            "truncated": len(rows) >= limit,
        }
    finally:
        conn.close()


@app.patch("/elements/{element_id}/status", response_model=StatusUpdateResult)
def update_status(
    element_id: int, body: StatusUpdateIn, user: sqlite3.Row = Depends(get_current_user)
):
    conn = get_connection()
    try:
        _guard_elements(conn, user, [element_id], "status", "write")
        # contract_id для новой записи — явно выбранный в диалоге (даже null —
        # "без контракта" осознанно) или унаследованный от предыдущей записи
        # (см. Docs/backlog.md, третий раунд, п.2 и app/contracts.py).
        contract_explicit = "contract_id" in body.model_fields_set
        try:
            data = apply_status_change(
                conn, element_id, body.status.value, contract_explicit, body.contract_id,
                body.changed_at, body.comment, audit_display_name(user), user["id"],
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        conn.commit()
        return data
    finally:
        conn.close()


@app.patch("/elements/bulk-status", response_model=BulkStatusUpdateResult)
def update_status_bulk(body: BulkStatusUpdateIn, user: sqlite3.Row = Depends(get_current_user)):
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
        _guard_elements(conn, user, ids, "status", "write")

        updated = []
        for item in body.items:
            data = apply_status_change(
                conn, item.element_id, body.status.value, True, item.contract_id,
                body.changed_at, None, audit_display_name(user), user["id"],
            )
            updated.append(data)
        conn.commit()
        return {"updated": updated}
    finally:
        conn.close()


class ElementCommentIn(BaseModel):
    comment: Optional[str] = None


class ElementContractIn(BaseModel):
    # None — снять контракт. Отдельного «не менять» здесь нет: запрос
    # существует ровно ради того, чтобы контракт поставить или снять.
    contract_id: Optional[int] = None


@app.patch("/elements/{element_id}/contract")
def set_element_contract(element_id: int, body: ElementContractIn,
                         user: sqlite3.Row = Depends(get_current_user)):
    """Назначить изделию контракт, НЕ трогая статус (2026-08-06, живой
    запрос).

    Зачем понадобилось. Контракт проставляется при уходе с «Запланирован» —
    и это единственный момент, когда система о нём спрашивала. Изделия,
    прошедшие этот переход до появления контрактов (или восстановленные
    импортом истории), остались с пустым контрактом и статусом дальше
    «Запланирован»: в остатки они не попадают, а вернуть их туда можно было
    только откатом статуса и повторным переводом — то есть враньём в
    истории ради заполнения реквизита.

    Инвариант «Запланирован ⇒ контракт пуст» держится здесь же, а не
    доверяется клиенту: запрос на запланированное изделие отклоняется.
    Порог прав — `user`, тот же, что у смены статуса: назначение контракта
    и есть часть той операции, просто выполненная отдельно.
    """
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, current_status, element_type, mark, contract_id FROM elements WHERE id = ?",
            (element_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        _guard_elements(conn, user, [element_id], "status", "write")
        if row["current_status"] == "planned":
            raise HTTPException(
                status_code=409,
                detail="У изделия в статусе «Запланирован» контракта быть не может — "
                       "он проставляется при переводе в следующий статус")
        if body.contract_id is not None:
            контракт = conn.execute(
                "SELECT id FROM contracts WHERE id = ?", (body.contract_id,)).fetchone()
            if контракт is None:
                raise HTTPException(status_code=404, detail="Контракт не найден")
            # Контракт обязан относиться к ТОМУ ЖЕ объекту, что и изделие.
            # Объект контракта не хранится, а выводится по цепочке
            # контракт → спецификация → договор (schema.sql) — проверяем по
            # ней. Без этой проверки перебором contract_id изделию своего
            # объекта можно было бы назначить контракт чужой стройки.
            объект_контракта = conn.execute(
                """
                SELECT a.object_id FROM contracts co
                JOIN specifications s ON s.id = co.specification_id
                JOIN agreements a ON a.id = s.agreement_id
                WHERE co.id = ?
                """,
                (body.contract_id,),
            ).fetchone()
            свой = conn.execute(
                "SELECT object_id FROM elements WHERE id = ?", (element_id,)).fetchone()
            if объект_контракта is None or объект_контракта["object_id"] != свой["object_id"]:
                raise HTTPException(
                    status_code=400,
                    detail="Контракт относится к другому объекту — назначить его этому "
                           "изделию нельзя")
            # Позиция под марку изделия и свободное количество по ней —
            # обязательны (2026-08-14, см. app/contract_guard.py). Этот путь
            # не проходит через apply_status_change, поэтому страж зовётся
            # здесь отдельно; без него карандаш в карточке оставался
            # единственной дверью, через которую привязку можно было
            # поставить мимо спецификации.
            contract_guard.assert_link_allowed(
                conn, body.contract_id, row["element_type"], row["mark"],
                element_id=element_id, current_contract_id=row["contract_id"],
                current_status=row["current_status"])
        sync_element_contract(conn, element_id, row["current_status"],
                              explicit=True, value=body.contract_id)
        conn.commit()
        обновлён = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        результат = enrich_element_row(conn, dict(обновлён))
    finally:
        conn.close()
    activity.log("element_contract_set", user=user, entity_type="element", entity_id=element_id,
                 element_type=row["element_type"], mark=row["mark"],
                 old_value=str(row["contract_id"] or "нет"),
                 new_value=str(body.contract_id or "нет"))
    return результат


@app.patch("/elements/{element_id}/comment")
def update_element_comment(
    element_id: int, body: ElementCommentIn, user: sqlite3.Row = Depends(get_current_user)
):
    """Произвольный комментарий к элементу (2026-08-02, живой запрос).

    ОТДЕЛЬНЫЙ эндпоинт, а не поле в PATCH /elements/{id}/fields: правка
    реквизитов требует роль `admin` на объекте (это правка того, что пришло
    из чертежа), а комментарий — заметка на полях, её оставляет тот же
    прораб, что меняет статус. Требование `admin` для строчки «отбит угол
    при разгрузке» означало бы, что её не напишет никто.

    В manual_fields комментарий не попадает: импорт чертежа его не трогает
    (в списке обновляемых колонок element_sync его нет), перезаписывать
    нечему — а лишняя пометка «правлено вручную» заставила бы согласовывать
    её при каждом переимпорте.
    """
    текст = (body.comment or "").strip() or None
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM elements WHERE id = ?", (element_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        _guard_elements(conn, user, [element_id], "comment", "write")
        conn.execute(
            "UPDATE elements SET comment = ?, updated_at = datetime('now') WHERE id = ?",
            (текст, element_id),
        )
        conn.commit()
    finally:
        conn.close()
    activity.log("element_comment", user=user, entity_type="element", entity_id=element_id,
                 new_value=(текст or "")[:200])
    return {"id": element_id, "comment": текст}


@app.patch("/elements/{element_id}/planned-delivery-date", response_model=ElementPlannedDateUpdateResult)
def update_element_planned_delivery_date(
    element_id: int, body: ElementPlannedDateIn, user: sqlite3.Row = Depends(get_current_user)
):
    """Плановая дата поставки — независимое действие, НЕ привязанное к
    смене статуса (партии убраны, см. Docs/backlog.md, "Контрактация
    2.0") — единая точка записи, см. app/element_dates.py (та же функция,
    которую зовёт и развёрнутая таблица контракта на фронте)."""
    conn = get_connection()
    try:
        _guard_elements(conn, user, [element_id], "planned_date", "write")
        data = set_planned_delivery_date(conn, element_id, body.planned_delivery_date, user)
        if data is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        conn.commit()
        return data
    finally:
        conn.close()


@app.patch("/elements/bulk-planned-delivery-date", response_model=BulkPlannedDateUpdateResult)
def update_element_planned_delivery_date_bulk(
    body: BulkPlannedDateUpdateIn, user: sqlite3.Row = Depends(get_current_user)
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
        _guard_elements(conn, user, ids, "planned_date", "write")

        updated = set_planned_delivery_dates_bulk(
            conn, [(item.element_id, item.planned_delivery_date) for item in body.items], user
        )
        conn.commit()
        return {"updated": updated}
    finally:
        conn.close()


@app.patch("/elements/{element_id}/history/{history_id}", response_model=StatusUpdateResult)
def update_history_entry(
    element_id: int, history_id: int, body: dict, admin: sqlite3.Row = Depends(get_current_user)
):
    """Правка ЗАПИСИ истории статусов: статус, дата/время применения, автор,
    комментарий (живой запрос: «у статуса нельзя исправить ни дату, ни
    пользователя»).

    Только админ: это правка аудита, а не обычная смена статуса.

    После правки `current_status` и `actual_delivery_date` пересчитываются той
    же `recompute_status_and_actual_date`, что и при обычной смене статуса и
    при удалении записи — эффективный статус элемента определяется САМОЙ
    ПОЗДНЕЙ по `changed_at` записью, поэтому правка даты может изменить его
    даже у не последней записи. Своей логики пересчёта здесь нет намеренно.
    """
    allowed = {"status", "changed_at", "changed_by", "comment"}
    unknown = set(body) - allowed
    if unknown:
        raise HTTPException(status_code=400, detail=f"Нельзя править: {', '.join(sorted(unknown))}")
    if not body:
        raise HTTPException(status_code=400, detail="Нечего сохранять")
    if "status" in body and body["status"] not in {s.value for s in STATUS_ORDER}:
        raise HTTPException(status_code=400, detail=f"Неизвестный статус «{body['status']}»")

    conn = get_connection()
    try:
        # Объект — из элемента, которому принадлежит запись истории.
        element = conn.execute("SELECT object_id FROM elements WHERE id = ?", (element_id,)).fetchone()
        if element is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        assert_object_feature(conn, admin, element["object_id"], "history", "write")
        entry = conn.execute(
            "SELECT * FROM status_history WHERE id = ? AND element_id = ?", (history_id, element_id)
        ).fetchone()
        if entry is None:
            raise HTTPException(status_code=404, detail="Запись истории не найдена")

        values = {}
        for field in allowed:
            if field not in body:
                continue
            raw = body[field]
            if field == "changed_at":
                if not raw:
                    raise HTTPException(status_code=400, detail="Дата записи истории не может быть пустой")
                # Приводим "ГГГГ-ММ-ДДTЧЧ:ММ" из <input type=datetime-local> к
                # тому же виду, в котором даты уже лежат в status_history.
                text = str(raw).replace("T", " ")
                if len(text) == 16:
                    text += ":00"
                values[field] = text
            else:
                values[field] = (str(raw).strip() or None) if raw is not None else None

        assignments = ", ".join(f"{f} = :{f}" for f in values)
        conn.execute(
            f"UPDATE status_history SET {assignments} WHERE id = :id",
            {**values, "id": history_id},
        )
        status, actual = recompute_status_and_actual_date(conn, element_id)
        # Контракт принимаем ИЗ записи: правка записи истории — единственный
        # путь сменить контракт, не меняя статус (см. adopt_contract_from_history).
        adopt_contract_from_history(conn, element_id, status)
        conn.commit()

        updated = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        history = conn.execute(
            "SELECT id, status, changed_at, changed_by, comment, contract_id FROM status_history "
            "WHERE element_id = ? ORDER BY changed_at DESC, id DESC",
            (element_id,),
        ).fetchall()
        result = enrich_element_row(conn, dict(updated))
        result["history"] = [dict(h) for h in history]
    finally:
        conn.close()

    activity.log(
        "history_edit", user=admin, entity_type="element", entity_id=element_id,
        element_type=result.get("element_type"), mark=result.get("mark"),
        old_value="; ".join(f"{f}: {entry[f]}" for f in values)[:500],
        new_value="; ".join(f"{f}: {v}" for f, v in values.items())[:500],
        details={"history_id": history_id, "effective_status": status, "actual_delivery_date": actual},
    )
    return result


@app.delete("/elements/{element_id}/history/{history_id}", response_model=StatusUpdateResult)
def delete_history_entry(
    element_id: int, history_id: int, user: sqlite3.Row = Depends(get_current_user)
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
        _guard_elements(conn, user, [element_id], "history", "write")
        entry = conn.execute(
            "SELECT id, status, changed_at FROM status_history WHERE id = ? AND element_id = ?",
            (history_id, element_id),
        ).fetchone()
        if entry is None:
            raise HTTPException(status_code=404, detail="Запись истории не найдена")

        total = conn.execute(
            "SELECT COUNT(*) as n FROM status_history WHERE element_id = ?", (element_id,)
        ).fetchone()["n"]
        if total <= 1:
            raise HTTPException(status_code=400, detail="Нельзя удалить последнюю оставшуюся запись истории")

        conn.execute("DELETE FROM status_history WHERE id = ?", (history_id,))

        effective_status, _ = recompute_status_and_actual_date(conn, element_id)
        # Удаление записи истории само по себе контракт не меняет — только
        # если элемент вернулся в «Запланирован» (там контракт обязан быть пуст).
        element_contract_id = sync_element_contract(conn, element_id, effective_status)
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
    finally:
        conn.close()

    # Журнал: удаление записи истории — такое же изменение истории статусов,
    # как её правка (history_edit рядом), и без этой записи оно оставалось
    # единственным способом изменить историю бесследно.
    activity.log(
        "history_delete", user=user, entity_type="element", entity_id=element_id,
        element_type=row["element_type"], subtype=row["subtype"], mark=row["mark"],
        # Статус — русской подписью: в журнале и в отчёте «Моя работа» эту
        # строку читает человек, а `delivered` ему ни о чём не говорит.
        old_value=f"{STATUS_LABELS_RU.get(entry['status'], entry['status'])} от {entry['changed_at']}",
        new_value=effective_status,
        details={"history_id": history_id},
    )
    return data


class ReportRequestIn(BaseModel):
    source_file: Optional[str] = None
    # Объект отчёта (этап D) — им выбираются карточка объекта и текстовые
    # блоки «на дату». Клиент присылает его явно; если не прислал, объект
    # выводится из чертежа (_report_object_id) — так же, как это делает
    # показ схемы.
    object_id: Optional[int] = None
    # Масштаб оси времени — только для «Графика контрактации и поставки»:
    # день/неделя/месяц/квартал. Это группировка колонок, а не пересчёт.
    scale: Optional[str] = None
    # Отчётная дата — для «Динамики» (ежедневный отчёт «на дату») и для
    # «Аналитической справки». Пусто = сегодня; сервер возвращает
    # фактически применённую дату.
    report_date: Optional[str] = None
    # Горизонт «ближайшего времени» в днях — только для «Аналитической
    # справки»: сколько вперёд считать этапы, под которые нужна
    # контрактация. Пусто = месяц (app/report_analytics.DEFAULT_HORIZON_DAYS).
    horizon_days: Optional[int] = None
    # Период графика «Динамики» — масштаб оси X, а не пересчёт (см.
    # build_dynamics_report). Пусто = весь срок проекта.
    week_from: Optional[str] = None
    week_to: Optional[str] = None
    # Что показывает график «Динамики» (2026-08-14): "delivery" — только
    # поставку (две кривые), "montage" — только монтаж (две кривые),
    # "both" — все четыре. Пусто = "both". Присылается и в выгрузки XLSX/PDF:
    # они обязаны показывать ровно то, что на экране.
    dyn_mode: Optional[str] = None
    # Список id — необязательное сужение отчёта текущим фильтром схемы. Тот
    # же приём, что у XLS-экспорта: критерии фильтра живут на клиенте, и
    # дублировать их на сервере значило бы держать две расходящиеся копии.
    element_ids: Optional[list[int]] = None
    # Вид «Статуса комплектации»: "list" — плоский перечень позиций,
    # "pivot" — сводная таблица по нему же (app/report_pivot.py). Это ОДИН
    # отчёт в двух видах, а не два отчёта: данные, права и галочка «учитывать
    # фильтр схемы» у них общие. Пусто = перечень.
    view: Optional[str] = None
    # Шкала дат сводной: "plan" / "fact" / "need" — одна на всю таблицу.
    # Названа не `scale`, потому что `scale` выше уже занят масштабом оси
    # «Графика контрактации»; два разных смысла в одном поле однажды
    # склеились бы молча.
    date_scale: Optional[str] = None
    # Для «Графика поставки»: период календаря, шаг оси и ПОРЯДОК уровней
    # группировки (его задаёт пользователь, см. app/report_delivery.py).
    # Сводная «Статуса комплектации» берёт отсюда же `step` и `group_by` —
    # это один и тот же вопрос «как разложить», а не два разных.
    # Пусто = сервер подставит свои значения и вернёт применённые.
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    step: Optional[str] = None
    group_by: Optional[list[str]] = None
    # Только для «Моей работы» (app/report_my_work.py). date_from/date_to выше
    # там означают МЕСТНЫЕ даты периода (они же идут в подпись отчёта), а
    # отбор ведётся по at_from/at_to — тем же границам, уже пересчитанным
    # клиентом в UTC: журнал хранит время в UTC, а календарь пользователь
    # выбирает по своим часам (тот же приём, что у `GET /activity`).
    at_from: Optional[str] = None
    at_to: Optional[str] = None
    # Чью работу показывать. Пусто = свою. Чужую видит администратор — см.
    # _my_work_scope: правило одно на отчёт и на фильтр «Изменения».
    user_ids: Optional[list[int]] = None
    # «Все пользователи» (живой запрос 2026-08-03) — отдельный флаг, а не
    # `user_ids = []` и не «пусто»: пустой список уже означает «свои», и
    # перегружать его третьим смыслом значило бы сделать разницу между
    # «я» и «все» опечаткой на одну скобку.
    all_users: bool = False
    # Смещение часов пользователя в минутах (`Date.getTimezoneOffset()`) —
    # нужно только выгрузкам: их собирает сервер, а время события в них
    # обязано читаться так же, как на экране.
    tz_offset_minutes: int = 0


def _report_object_id(conn, body: "ReportRequestIn"):
    """Объект отчёта: явно присланный клиентом либо выведенный из чертежа.
    None — отчёт не относится ни к одному объекту (файл не задан или не
    привязан); карточка объекта тогда пустая, см. build_dynamics_report."""
    if body.object_id is not None:
        return body.object_id
    return _object_for_source_file(conn, body.source_file) if body.source_file else None


def _guard_report(conn, user, body: "ReportRequestIn", key: str,
                  needs_source_file: bool = True) -> "ReportRequestIn":
    """Доступ к отчёту и ОБЛАСТЬ его данных (аудит безопасности 2026-08-03).

    `needs_source_file=False` (2026-09-05, «Учёт по блокам: статусы») — для
    отчёта, который выбирает данные ПО object_id напрямую (work_progress/
    work_fact), а не по source_file/element_ids, как остальные девять:
    объект МФР чертежа не имеет вовсе (это ЖБИ-понятие), и обязательное
    расширение object_id → source_file ниже роняло бы отчёт «нет
    актуального чертежа» на любом МФР-объекте.

    До этой правки все десять отчётов закрывались одним `get_current_user`,
    то есть любой вошедший строил отчёт по любому объекту, назвав чужой
    `object_id`. Хуже того, `build_status_report` при пустых `source_file` и
    `element_ids` не ставит НИКАКОГО ограничения — тело `{}` давало сводку
    по всей базе разом, вместе с выгрузкой в XLSX и PDF.

    Проверяется КАЖДЫЙ признак, который сузит выборку, а не первый
    попавшийся: `object_id`, `source_file` и `element_ids` приходят
    независимо, и назвать свой объект, а элементы попросить чужие — ровно то,
    что проверка «по первому непустому» пропустила бы.

    Отдельно важно: `object_id` сам по себе данные НЕ сужает — он выбирает
    только карточку объекта и текстовые блоки, а выборка идёт по
    `source_file`/`element_ids`. Поэтому при отсутствии `source_file` он
    здесь же переводится в актуальный чертёж объекта — иначе проверка прав
    прошла бы по своему объекту, а числа приехали бы по всем.

    Возвращается тело с проставленным `source_file` — вызывающий работает
    уже с суженным.
    """
    проверено = False
    if body.object_id is not None:
        assert_object_feature(conn, user, body.object_id, key, "read")
        проверено = True
    if body.source_file:
        _guard_source_file(conn, user, body.source_file, key, "read")
        проверено = True
    if body.element_ids:
        _guard_elements(conn, user, body.element_ids, key, "read")
        проверено = True

    if not проверено:
        # Ни объекта, ни чертежа, ни списка элементов. Для администратора
        # сервиса это законная сводка по всей системе — ему и так доступно
        # всё. Для остальных «по умолчанию всё» недопустимо: просить нужно
        # явно то, на что есть права.
        if not is_system_admin(user):
            raise HTTPException(
                status_code=400,
                detail="Укажите объект отчёта: без него отчёт охватил бы все объекты сразу",
            )
        return body

    if needs_source_file and not body.source_file and body.object_id is not None:
        try:
            return body.model_copy(update={"source_file": object_source_file(conn, body.object_id)})
        except LookupError:
            # У объекта нет актуального чертежа — отчёт строить не по чему.
            # Молча отдать «всю базу» здесь было бы худшим из вариантов.
            raise HTTPException(status_code=404, detail="У объекта нет актуального чертежа")
    return body


@app.post("/reports/status")
def report_status(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Статус монтажа» — данные для экрана. POST, а не GET: список id может
    быть в тысячи элементов и не помещается в строку запроса."""
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_status")
        return build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()


@app.post("/reports/dynamics")
def report_dynamics(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Ежедневный «Отчёт о динамике поставки и монтажа»."""
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_dynamics")
        return build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                     _report_object_id(conn, body), body.week_from, body.week_to,
                                     body.dyn_mode)
    finally:
        conn.close()


def _report_file_response(content: bytes, name: str, media_type: str) -> Response:
    return Response(
        content=content, media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename=\"report\"; filename*=UTF-8''{quote(name)}"},
    )


@app.post("/reports/dynamics.xlsx")
def report_dynamics_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_dynamics")
        report = build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                       _report_object_id(conn, body), body.week_from, body.week_to,
                                       body.dyn_mode)
    finally:
        conn.close()
    return _report_file_response(
        build_dynamics_report_xlsx(report), "Отчёт о динамике поставки и монтажа.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/dynamics.pdf")
def report_dynamics_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_dynamics")
        report = build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                       _report_object_id(conn, body), body.week_from, body.week_to,
                                       body.dyn_mode)
    finally:
        conn.close()
    return _report_file_response(build_dynamics_report_pdf(report), "Отчёт о динамике поставки и монтажа.pdf",
                                 "application/pdf")


@app.post("/reports/status.xlsx")
def report_status_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_status")
        report = build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()
    content = build_status_report_xlsx(report)
    name = "Статус монтажа.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"report.xlsx\"; filename*=UTF-8''{quote(name)}"},
    )


@app.post("/reports/status.pdf")
def report_status_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_status")
        report = build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()
    subtitle = f"Чертёж: {body.source_file}" if body.source_file else ""
    content = build_status_report_pdf(report, subtitle)
    name = "Статус монтажа.pdf"
    return Response(
        content=content, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(name)}"},
    )


def _completion(conn, user, body: "ReportRequestIn") -> dict:
    """Общая точка для экрана, XLSX и PDF «Статуса комплектации». Проверка
    доступа ЗДЕСЬ, а не в каждом из трёх роутов: три копии одной проверки —
    ровно та схема, при которой забытая четвёртая открывает отчёт целиком
    (аудит безопасности 2026-08-03).

    Вид (перечень или сводная) выбирается ЗДЕСЬ же: экран, Excel и PDF
    обязаны показывать одно и то же, и развести выбор по роутам значило бы
    получить сводную на экране и перечень в файле."""
    body = _guard_report(conn, user, body, "report_completion")
    # Объект — ещё одно сужение выборки, вдобавок к чертежу (живой запрос
    # 2026-08-30: «отчёт только по активному объекту»). Берётся тем же
    # способом, что у «Динамики»: явно присланный клиентом либо выведенный
    # из чертежа.
    object_id = _report_object_id(conn, body)
    if normalize_view(body.view) != VIEW_PIVOT:
        return build_completion_report(conn, body.source_file, body.element_ids, object_id)
    try:
        return build_completion_pivot(conn, body.source_file, body.element_ids,
                                      body.group_by, body.step, body.date_scale,
                                      object_id)
    except ValueError as exc:
        # Слишком много календарных колонок — это ошибка ЗАПРОСА, а не сбой:
        # отдаём 400 с текстом, который уже объясняет, что сделать.
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/reports/contracting-schedule")
def report_contracting_schedule(body: ReportRequestIn,
                                user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «График контрактации и поставки» (2026-08-06): насколько
    потребность стройки закрыта контрактами — по маркам и во времени.

    Масштаб оси времени приходит в `scale` (день/неделя/месяц/квартал) — это
    только группировка колонок, сами данные от него не зависят.
    """
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_contracting")
        object_id = _report_object_id(conn, body)
        if object_id is None:
            raise HTTPException(
                status_code=400,
                detail="Отчёт строится по объекту — выберите объект в тулбаре")
        # Доступ проверен _guard_report по source_file; объект берётся из
        # него же, поэтому чужой сюда не пройдёт.
        return build_contracting_schedule(conn, object_id, body.scale or "month")
    finally:
        conn.close()


def _analytics(conn, user, body: ReportRequestIn) -> dict:
    """Общая часть трёх эндпоинтов справки: проверка доступа, объект и
    расчёт. Экран, XLSX и PDF обязаны строиться из ОДНОГО результата.

    Фильтр схемы (`element_ids`) справка не учитывает намеренно (решение
    пользователя 2026-08-11): она отвечает на вопрос «что со стройкой», а не
    «что с тем, что я сейчас выделил». Проверку прав это не ослабляет —
    объект берётся из `_guard_report`, то есть из уже проверенного чертежа.
    """
    body = _guard_report(conn, user, body, "report_analytics")
    object_id = _report_object_id(conn, body)
    if object_id is None:
        raise HTTPException(status_code=400,
                            detail="Отчёт строится по объекту — выберите объект в тулбаре")
    return build_analytics_report(conn, object_id, body.report_date, body.horizon_days)


@app.post("/reports/analytics")
def report_analytics(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Аналитическая справка» (2026-08-11): контрактация под ближайшие
    этапы СМР и критический путь поставки."""
    conn = get_connection()
    try:
        return _analytics(conn, user, body)
    finally:
        conn.close()


@app.post("/reports/analytics.xlsx")
def report_analytics_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _analytics(conn, user, body)
    finally:
        conn.close()
    return _report_file_response(
        build_analytics_report_xlsx(report), f"{ANALYTICS_TITLE}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/analytics.pdf")
def report_analytics_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _analytics(conn, user, body)
    finally:
        conn.close()
    return _report_file_response(build_analytics_report_pdf(report), f"{ANALYTICS_TITLE}.pdf",
                                 "application/pdf")


@app.post("/reports/block-status")
def report_block_status(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Учёт по блокам: статусы» (2026-09-05, живой запрос
    пользователя) — бывшая вкладка «Статусы» «Учёта по блокам», перенесённая
    в «Отчёты»: у операций «эт/сек» в ячейке процент на выбранную дату,
    правится тут же (PUT /objects/{id}/blocks/{id}/work-progress-cell), а не
    устаревшим клик-циклом. Права — те же, что у «Учёта по блокам»
    (`work_progress`), отдельного раздела прав не заводится. Выгрузки
    XLSX/PDF не заведены — это редактируемый экран, а не статичная сводка."""
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "work_progress", needs_source_file=False)
        object_id = _report_object_id(conn, body)
        if object_id is None:
            raise HTTPException(status_code=400,
                                detail="Отчёт строится по объекту — выберите объект в тулбаре")
        return work_fact.status_report(conn, object_id, body.report_date)
    finally:
        conn.close()


@app.post("/reports/completion")
def report_completion(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Статус комплектации» в одном из двух видов (`view`): плоский
    перечень «кран · стоянка · изделие · контракт · три даты» с количеством
    либо сводная таблица по нему же — иерархия строк против календаря дат
    поставки (app/report_pivot.py)."""
    conn = get_connection()
    try:
        return _completion(conn, user, body)
    finally:
        conn.close()


@app.post("/reports/completion.xlsx")
def report_completion_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _completion(conn, user, body)
    finally:
        conn.close()
    if report.get("view") == VIEW_PIVOT:
        return _report_file_response(
            build_completion_pivot_xlsx(report), "Статус комплектации (сводная).xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    return _report_file_response(
        build_completion_report_xlsx(report), "Статус комплектации.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/completion.pdf")
def report_completion_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _completion(conn, user, body)
    finally:
        conn.close()
    subtitle = f"Чертёж: {body.source_file}" if body.source_file else ""
    if report.get("view") == VIEW_PIVOT:
        return _report_file_response(build_completion_pivot_pdf(report, subtitle),
                                     "Статус комплектации (сводная).pdf", "application/pdf")
    return _report_file_response(build_completion_report_pdf(report, subtitle),
                                 "Статус комплектации.pdf", "application/pdf")


def _delivery_schedule(conn, user, body: "ReportRequestIn") -> dict:
    """Общая точка для экрана, XLSX и PDF «Графика поставки». ValueError
    (слишком много календарных колонок) — это ошибка ЗАПРОСА, а не сбой:
    отдаём 400 с текстом, который уже объясняет, что сделать.

    Проверка доступа тоже ЗДЕСЬ, а не в каждом из трёх роутов: три копии
    одной проверки — это ровно та схема, при которой забытая четвёртая
    открывает отчёт целиком (аудит безопасности 2026-08-03)."""
    body = _guard_report(conn, user, body, "report_delivery")
    try:
        return build_delivery_schedule_report(
            conn, body.source_file, body.element_ids,
            body.date_from, body.date_to, body.step, body.group_by)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/reports/delivery-schedule")
def report_delivery_schedule(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «График поставки» — календарь потребности в поставке по дате
    начала СМР против фактической поставки."""
    conn = get_connection()
    try:
        return _delivery_schedule(conn, user, body)
    finally:
        conn.close()


class DeliveryCellIn(ReportRequestIn):
    """Адрес ячейки «Графика поставки» для подсказки при наведении.
    path — СЫРЫЕ значения уровней группировки (`gkey` узлов отчёта), по
    одному на каждый уровень group_by; column — ключ колонки календаря."""
    path: list = []
    column: Optional[str] = None


@app.post("/reports/delivery-schedule/cell")
def report_delivery_schedule_cell(body: DeliveryCellIn,
                                  user: sqlite3.Row = Depends(get_current_user)):
    """Разбор одной ячейки по маркам: чего не хватает и откуда это можно
    переставить. Отдельным запросом при наведении, а не в теле отчёта — на
    реальном файле это тысячи троек «строка × колонка × марка»."""
    conn = get_connection()
    try:
        body = _guard_report(conn, user, body, "report_delivery")
        return build_delivery_cell_detail(
            conn, body.source_file, body.element_ids, body.date_from, body.date_to,
            body.step, body.group_by, body.path, body.column)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        conn.close()


def _delivery_file_base() -> str:
    """Имя выгружаемого файла «Графика поставки» — с пометкой «(в разработке)»,
    пока признак стоит. Файл живёт дольше экрана и уходит из системы: пометка
    обязана быть видна и в имени, а не только внутри."""
    return in_development_title("График поставки", DELIVERY_IN_DEVELOPMENT)


@app.post("/reports/delivery-schedule.xlsx")
def report_delivery_schedule_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _delivery_schedule(conn, user, body)
    finally:
        conn.close()
    return _report_file_response(
        build_delivery_schedule_xlsx(report), f"{_delivery_file_base()}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/delivery-schedule.pdf")
def report_delivery_schedule_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _delivery_schedule(conn, user, body)
    finally:
        conn.close()
    return _report_file_response(build_delivery_schedule_pdf(report),
                                 f"{_delivery_file_base()}.pdf", "application/pdf")


# ==================== «Моя работа»: что человек изменил за период ====================
#
# Отдельная ветка доступа, не `_guard_report`. Тот отвечает на вопрос «чьи
# ИЗДЕЛИЯ показывать», а здесь вопрос другой — «чьи ДЕЙСТВИЯ показывать», и
# ответ на него не выводится ни из объекта, ни из списка элементов.

def _users_brief(conn, ids: list) -> list:
    if not ids:
        return []
    rows = conn.execute(
        f"SELECT id, last_name, first_name, patronymic FROM users "
        f"WHERE id IN ({','.join('?' * len(ids))})", ids
    ).fetchall()
    return [{"id": r["id"], "display_name": format_display_name(r)} for r in rows]


def _admin_object_ids(conn, user) -> set:
    """Объекты, где человеку позволено смотреть ЧУЖИЕ действия.

    Работать на объекте и наблюдать за коллегами — разные права: до
    2026-08-14 второе было привязано к роли «Полные права на объекте», а
    теперь это отдельный раздел «activity_others», и кому его дать, решает
    настройка ролей."""
    if is_system_admin(user):
        return {r["id"] for r in conn.execute("SELECT id FROM objects")}
    return {oid for oid in object_roles(conn, user)
            if has_feature(conn, user, "activity_others", "read", oid)}


def _my_work_scope(conn, viewer, user_ids: Optional[list], all_users: bool = False) -> tuple:
    """Кого показываем и в каких границах: (список id пользователей, объекты).

    Объекты = None означает «без ограничения», а не «ни одного» (та же
    развилка, что у `accessible_object_ids`).

    Правило одно на отчёт и на фильтр рабочей области:
      * свои действия человек видит целиком, по всем объектам — он их и
        совершил, скрывать от него нечего;
      * чужие действия видит администратор: системный — любые, администратор
        объекта — только те, что касаются изделий ЕГО объектов. Без этого
        ограничения «выбор пользователя» стал бы дырой: назвал чужой id и
        читаешь работу по стройке, к которой доступа нет.
    """
    свои = [viewer["id"]]
    if not all_users and (not user_ids or set(user_ids) == set(свои)):
        return свои, None
    # «Все пользователи» — это None в отборе (любой автор), а НЕ пустой
    # список: пустой означал бы «ни одного» (см. _where).
    кого = None if all_users else list(dict.fromkeys(user_ids))
    if is_system_admin(viewer):
        return кого, None
    объекты = _admin_object_ids(conn, viewer)
    if not объекты:
        raise HTTPException(
            status_code=403,
            detail="Чужие действия доступны администратору объекта — у вас нет объектов с такой ролью",
        )
    return кого, объекты


def _my_work(conn, user, body: ReportRequestIn, limit: int) -> dict:
    ids, объекты = _my_work_scope(conn, user, body.user_ids, body.all_users)
    return build_my_work_report(
        conn, at_from=body.at_from, at_to=body.at_to,
        date_from=body.date_from, date_to=body.date_to,
        # ids=None («все пользователи») — список имён в шапке пуст, и
        # period_subtitle подписывает период «все пользователи».
        user_ids=ids, object_ids=объекты, users=_users_brief(conn, ids or []), limit=limit,
    )


@app.post("/reports/my-work")
def report_my_work(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Моя работа» — что текущий пользователь изменил за период.
    Доступен ВСЕМ ролям: это отчёт человека о собственной работе, а не
    журнал наблюдения (тот остаётся за администратором сервиса)."""
    conn = get_connection()
    try:
        return _my_work(conn, user, body, SCREEN_LIMIT)
    finally:
        conn.close()


@app.post("/reports/my-work.xlsx")
def report_my_work_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _my_work(conn, user, body, FILE_LIMIT)
    finally:
        conn.close()
    return _report_file_response(
        build_my_work_xlsx(report, body.tz_offset_minutes), "Моя работа.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/my-work.pdf")
def report_my_work_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _my_work(conn, user, body, FILE_LIMIT)
    finally:
        conn.close()
    return _report_file_response(build_my_work_pdf(report, body.tz_offset_minutes),
                                 "Моя работа.pdf", "application/pdf")


class ChangedElementsIn(BaseModel):
    """Запрос фильтра «Изменения» рабочей области. Границы периода — те же
    UTC-метки, что у отчёта (клиент считает их из местного календаря)."""
    object_id: int
    at_from: Optional[str] = None
    at_to: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    # None = «все пользователи» (только администратору объекта), список =
    # конкретные. Своего id в списке достаточно, чтобы остаться в своём праве.
    user_ids: Optional[list[int]] = None


@app.post("/elements/changed")
def elements_changed(body: ChangedElementsIn, user: sqlite3.Row = Depends(get_current_user)):
    """Элементы объекта, чьи реквизиты или история статуса менялись за период.

    Возвращает ТОЛЬКО id: фильтр применяется на клиенте (там живут остальные
    критерии отбора, см. passesPlacementFilters), а тащить сюда весь элемент
    значило бы переслать вторую копию плана.

    «Все пользователи» и выбор чужих — по тому же правилу, что и в отчёте
    (_my_work_scope), но область здесь всегда одна: показываемый объект.
    """
    conn = get_connection()
    try:
        assert_object_feature(conn, user, body.object_id, "plan", "read")
        свои = [user["id"]]
        нужны_чужие = body.user_ids is None or set(body.user_ids) != set(свои)
        if нужны_чужие and not has_feature(conn, user, "activity_others", "read", body.object_id):
            raise HTTPException(
                status_code=403,
                detail="Изменения других пользователей видит тот, кому выдан раздел "
                       "«Журнал и „Моя работа“: действия других людей»",
            )
        ids = changed_element_ids(
            conn,
            at_from=body.at_from or (f"{body.date_from} 00:00:00.000" if body.date_from else None),
            at_to=body.at_to or (f"{body.date_to} 23:59:59.999" if body.date_to else None),
            # None здесь означает «любой пользователь» — законно только после
            # проверки выше; свой список подставляем сами, чтобы «только мои»
            # не зависело от того, что прислал клиент.
            user_ids=body.user_ids if нужны_чужие else свои,
            object_id=body.object_id,
        )
        return {"element_ids": ids, "count": len(ids)}
    finally:
        conn.close()


@app.get("/objects/{object_id}/activity-users")
def object_activity_users(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Кого можно выбрать в «Моей работе» и в фильтре «Изменения».

    Список — не `GET /users` (тот за системным администратором и отдаёт всех
    в системе): администратору объекта нужны те, кто на ЭТОМ объекте
    работает. Берём две группы и объединяем: у кого есть действующий грант на
    объект и кто уже наследил в журнале по его изделиям — второе важно,
    потому что грант могли и снять, а сделанная работа никуда не делась.
    """
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "activity", "read")
        админ = has_feature(conn, user, "activity_others", "read", object_id)
        if not админ:
            # Обычный пользователь выбирать не может — отдаём только его
            # самого, чтобы форме не приходилось знать про права отдельно.
            return {"users": _users_brief(conn, [user["id"]]), "can_choose": False}
        rows = conn.execute(
            """
            SELECT DISTINCT u.id AS id, u.last_name AS last_name, u.first_name AS first_name,
                   u.patronymic AS patronymic
            FROM users u
            WHERE u.id IN (
                    SELECT ua.user_id FROM user_access ua
                    JOIN objects o ON o.id = ?
                    WHERE ua.object_id = o.id
                       OR (ua.object_id IS NULL AND ua.project_id = o.project_id)
                       OR (ua.object_id IS NULL AND ua.project_id IS NULL)
                  )
               OR u.role = 'admin'
               OR u.id IN (
                    SELECT a.user_id FROM activity_log a
                    JOIN elements e ON e.id = a.entity_id AND a.entity_type = 'element'
                    WHERE e.object_id = ?
                  )
            ORDER BY u.last_name, u.first_name
            """,
            (object_id, object_id),
        ).fetchall()
        return {
            "users": [{"id": r["id"], "display_name": format_display_name(r)} for r in rows],
            "can_choose": True,
        }
    finally:
        conn.close()


class BackupCreateIn(BaseModel):
    comment: Optional[str] = None


@app.get("/admin/backups")
def admin_list_backups(admin: sqlite3.Row = Depends(require_service_feature("backups", "read"))):
    """Все резервные копии на диске, новые сверху — из этого списка
    выбирается точка, на которую восстанавливаться.

    Вместе со списком — свободное место (2026-08-19, запрос пользователя):
    это тот самый экран, где нажимают «Создать копию», и узнавать о нехватке
    места из отказа кнопки поздно.
    """
    return {"backups": list_backups(), "disk": disk_state()}


@app.get("/admin/disk-space")
def admin_disk_space(admin: sqlite3.Row = Depends(require_service_feature("backups", "read"))):
    """Свободное место отдельным запросом — для предупреждения при входе.

    Отдельный лёгкий эндпоинт, а не поле в /me/permissions: права спрашивает
    КАЖДЫЙ вход и каждое переключение объекта, а место интересно только тем,
    кто может с ним что-то сделать, и один раз за сеанс. Порог раздела тот
    же, что у копий: кому показаны копии, тому и место под них.
    """
    return disk_state()


@app.post("/admin/backups")
def admin_create_backup(body: BackupCreateIn, admin: sqlite3.Row = Depends(require_service_feature("backups", "write"))):
    """Копия по кнопке. Записывается, КЕМ создана — в отличие от служебных,
    которые система снимает сама перед разрушительными операциями."""
    meta = create_backup(
        kind=KIND_MANUAL,
        user_name=audit_display_name(admin),
        user_id=admin["id"],
        comment=body.comment,
    )
    activity.log("backup_create", user=admin, new_value=meta["name"], details={"comment": body.comment})
    return meta


@app.post("/admin/backups/{name}/restore")
def admin_restore_backup(name: str, admin: sqlite3.Row = Depends(require_service_feature("backups", "write"))):
    """Восстановление на выбранный момент. ПЕРЕД восстановлением всегда
    снимается служебная копия текущего состояния — если выбрали не ту точку,
    вернуться будет куда.

    После переноса данных прогоняется init_db(): копия может быть снята на
    более старой схеме, и без миграций приложение бы на ней не поднялось.
    """
    try:
        result = restore_backup(name, user_name=audit_display_name(admin), user_id=admin["id"])
    except BackupError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    init_db()
    activity.log(
        "backup_restore", user=admin, old_value=result["safety_backup"]["name"], new_value=name,
        details={"комментарий": "перед восстановлением снята служебная копия"},
    )
    return result


@app.delete("/admin/backups/{name}", status_code=204)
def admin_delete_backup(name: str, admin: sqlite3.Row = Depends(require_service_feature("backups", "write"))):
    try:
        delete_backup(name)
    except BackupError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    activity.log("backup_delete", user=admin, old_value=name)
    return Response(status_code=204)


@app.get("/admin/input-files")
def admin_input_files(user: sqlite3.Row = Depends(require_service_feature("import_input", "read"))):
    """Что сейчас лежит в Input/ — для диалога подтверждения перед импортом.
    Отдельным запросом, а не вместе с самим импортом: оператор должен
    увидеть список ДО того, как согласится перезаписать геометрию."""
    return list_input_files()


class ImportInputIn(BaseModel):
    # В какой объект грузится ВСЯ пачка (2026-08-21, запрос пользователя).
    # Необязателен ради старого клиента и первой в жизни установки, где
    # объекта ещё нет: тогда объект выводит сам импорт, как раньше.
    object_id: Optional[int] = None


@app.post("/admin/import-input")
def admin_import_input(body: Optional[ImportInputIn] = None,
                       user: sqlite3.Row = Depends(require_service_feature("import_input", "write"))):
    """Импорт всех файлов из папки Input/ на сервере — по явной команде из
    меню. Раньше это происходило само при каждом старте сервера, то есть на
    каждый деплой и каждый перезапуск контейнера (см. on_startup, где
    объяснено, почему так делать не следует).

    **Объект спрашивается в форме** (2026-08-21). До этого папка объект не
    принимала вовсе, и на базе с двумя зданиями пакетная загрузка перестала
    работать в принципе: чертёж уходил в отказ «в базе несколько объектов»,
    а график СМР — что хуже — грузился, сопоставляя строки по ВСЕЙ базе, то
    есть развозя даты по чужому дому. Один объект на всю пачку: папка — это
    способ положить на сервер тяжёлый чертёж, а не разложить стройку по
    зданиям.

    Порядок вызовов важен и совпадает с scripts/rebuild_db.py: сначала DXF
    (графику нужны уже привязанные к зонам элементы), затем xlsx. Файл
    контрактации из папки НЕ грузится (2026-08-12) и с появлением выбора
    объекта тоже: его объект выбирается ОТДЕЛЬНО, см.
    app/input_import.import_input_xlsx.

    Возвращает построчный отчёт обоих импортов — то же самое, что уходит в
    лог сервера, но оператор лог не читает.

    Импорт ПЕРЕЗАПИСЫВАЕТ геометрию уже загруженных элементов (upsert по
    (source_file, dxf_handle)); статусы и история живут в отдельных
    таблицах и не затрагиваются. Предупреждение об этом — в диалоге
    подтверждения на фронтенде."""
    object_id = body.object_id if body else None
    if object_id is not None:
        # Права на КОНКРЕТНОМ объекте, а не только доступ к разделу: раздел
        # общесервисный, а пишет загрузка в выбранное здание — та же
        # проверка, что у загрузки чертежа по одному файлу.
        conn = get_connection()
        try:
            assert_object_feature(conn, user, object_id, "drawings", "write")
        finally:
            conn.close()
    backup_before_import("папка Input", audit_display_name(user), user["id"])
    report = import_input_dxf(object_id)
    report += import_input_xlsx(object_id)
    # В журнал: до 2026-07-30 массовая загрузка из Input/ нигде не
    # фиксировалась, кроме stdout сервера, — а она перезаписывает геометрию
    # всех элементов и создаёт контракты (живой репорт пользователя о
    # незаписанных системных событиях).
    activity.log(
        "import_input", user=user, entity_type="object", entity_id=object_id,
        new_value=f"файлов обработано: {len(report)}",
        details={"report": report},
    )
    return {"report": report}


class ClientEventIn(BaseModel):
    action: str
    at: Optional[str] = None
    duration_ms: Optional[float] = None
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    request_id: Optional[str] = None
    details: Optional[dict] = None


class ClientEventsIn(BaseModel):
    events: list[ClientEventIn]


@app.post("/activity")
def post_activity(body: ClientEventsIn, user: sqlite3.Row = Depends(get_current_user)):
    """Пачка клиентских событий («нажал кнопку», «форма открылась»,
    «запись выполнена») — сервер о них знать не может, их измеряет сам
    браузер.

    ПАЧКОЙ, а не по событию: отдельный запрос на каждое нажатие исказил бы
    ровно то, что мы измеряем, — сетевой задержкой поверх времени отклика
    интерфейса.

    `duration_ms` клиент считает монотонным таймером (performance.now()), а
    НЕ разницей часов: часы на разных машинах прорабов расходятся на
    минуты, и сравнивать их абсолютные метки между компьютерами нельзя — а
    сравнение быстродействия разных машин и есть цель журнала. Поэтому
    метка `at` у клиентских событий — серверное время приёма, а истинная
    длительность приходит отдельным полем.

    Ограничение размера пачки — защита от того, чтобы одна вкладка не
    залила журнал: лишнее отбрасывается, но об этом пишется явная запись.
    """
    MAX_EVENTS = 200
    events = body.events[:MAX_EVENTS]
    for e in events:
        activity.log(
            e.action,
            source="client",
            user=user,
            entity_type=e.entity_type,
            entity_id=e.entity_id,
            duration_ms=e.duration_ms,
            request_id=e.request_id,
            details=e.details,
        )
    dropped = len(body.events) - len(events)
    if dropped:
        activity.log("client_batch_truncated", source="server", user=user, new_value=str(dropped))
    return {"accepted": len(events), "dropped": dropped}


# ---------- Журнал действий: отбор по любой колонке ----------
#
# Реестр колонок, по которым журнал отбирается (живой запрос 2026-08-20:
# «добавь возможность фильтрации по любой колонке журнала»). Ключ — имя
# колонки, оно же имя параметра запроса и атрибут поля в шапке таблицы:
# три списка одних и тех же колонок (сигнатура, SQL, разметка) разошлись бы
# на первой же новой колонке, поэтому список ровно один — этот.
#
# Вид отбора:
#   "eq"   — выпадашка с фактически встретившимися значениями (их немного:
#            источник, категория, действие, тип сущности);
#   "like" — подстрока (марка, значения «было/стало», ФИО, подробности:
#            значений тысячи, выпадашка по ним бесполезна);
#   "num"  — точное число (идентификатор сущности);
#   "min"  — «не меньше» (длительность: ищут «что тормозило дольше 500 мс»).
_ACT_FILTERS = {
    "source": "eq",
    "category": "eq",
    "action": "eq",
    "entity_type": "eq",
    "element_type": "eq",
    "subtype": "eq",
    "user_name": "like",
    "impersonator_name": "like",
    "mark": "like",
    "old_value": "like",
    "new_value": "like",
    "request_id": "like",
    "details": "like",
    "entity_id": "num",
    "user_id": "num",
    "duration_ms": "min",
}
# Колонки с выпадашкой — им сервер отдаёт наборы встретившихся значений.
_ACT_DROPDOWNS = tuple(k for k, kind in _ACT_FILTERS.items() if kind == "eq")
# Параметры запроса, которые отбором НЕ являются.
_ACT_RESERVED = {"date_from", "date_to", "text", "limit", "offset"}


@app.get("/activity")
def search_activity(
    request: Request,
    date_from: Optional[str] = Query(None, description="'ГГГГ-ММ-ДД' включительно"),
    date_to: Optional[str] = Query(None, description="'ГГГГ-ММ-ДД' включительно"),
    text: Optional[str] = Query(None, description="подстрока в марке/типе/подтипе/значениях"),
    limit: int = Query(200, le=2000),
    offset: int = Query(0, ge=0),
    admin: sqlite3.Row = Depends(require_service_feature("activity_log", "read")),
):
    """Поиск по журналу. Только админу: журнал показывает, кто что делал, —
    это не то, что должно быть доступно всем ролям.

    Отбор принимается ПРОИЗВОЛЬНЫМИ параметрами «колонка=значение» из
    реестра `_ACT_FILTERS` (тот же приём, что у справочника элементов), а не
    перечислением аргументов в сигнатуре: колонок в журнале полтора десятка,
    и держать их список в трёх местах — верный способ получить колонку, по
    которой «фильтр не работает». Неизвестный ключ — 400, а не молчаливый
    пропуск: опечатка иначе выглядела бы точно так же.

    Отдаёт страницу строк, общее число совпадений и наборы значений для
    выпадашек. Наборы считаются по тому же отбору, что и строки, но БЕЗ
    условия самой этой колонки — иначе, выбрав значение, пользователь терял
    бы возможность переключиться на другое.

    Свободный `text` остаётся сверх поколоночного отбора: он ищет сразу по
    марке, типу, значениям и ФИО, когда неизвестно, в какой колонке искомое.
    """
    # activity_log.at хранится в UTC (app/activity._now), а пользователь
    # выбирает границы по своему местному календарю — поэтому клиент
    # присылает уже пересчитанные в UTC ГРАНИЦЫ С ВРЕМЕНЕМ (см.
    # loadActivity, app.js). Строка без времени тоже принимается — тогда
    # трактуем её как раньше, целыми сутками: так продолжают работать
    # прямые вызовы эндпоинта (curl, внешние скрипты).
    filters = {}
    for key, value in request.query_params.items():
        if key in _ACT_RESERVED:
            continue
        if key not in _ACT_FILTERS:
            raise HTTPException(status_code=400, detail=f"Отбор по «{key}» не поддерживается")
        if value != "":
            filters[key] = value

    def clauses_for(skip: Optional[str] = None):
        parts, params = [], []
        if date_from:
            parts.append("at >= ?")
            params.append(date_from if " " in date_from else f"{date_from} 00:00:00.000")
        if date_to:
            parts.append("at <= ?")
            params.append(date_to if " " in date_to else f"{date_to} 23:59:59.999")
        for column, value in filters.items():
            if column == skip:
                continue
            kind = _ACT_FILTERS[column]
            if value == PLACEMENT_NONE_SENTINEL:
                # «Не заполнено» — тот же сентинел, что в справочнике
                # элементов: у журнала пустых значений много (у системных
                # событий нет ни пользователя, ни изделия), и отобрать
                # именно их — рабочий вопрос.
                parts.append(f"({column} IS NULL OR {column} = '')")
            elif kind == "eq":
                parts.append(f"{column} = ?")
                params.append(value)
            elif kind == "num":
                if not str(value).lstrip("-").isdigit():
                    raise HTTPException(status_code=400,
                                        detail=f"«{column}»: ожидается число, получено «{value}»")
                parts.append(f"{column} = ?")
                params.append(int(value))
            elif kind == "min":
                try:
                    порог = float(str(value).replace(",", "."))
                except ValueError:
                    raise HTTPException(status_code=400,
                                        detail=f"«{column}»: ожидается число, получено «{value}»")
                parts.append(f"{column} >= ?")
                params.append(порог)
            else:
                # Регистронезависимый поиск кириллицы SQLite без ICU не
                # умеет (см. Docs/TZ.md), поэтому сравниваем как есть — для
                # марок, кодов и значений этого достаточно: они хранятся в
                # том виде, в каком их ищут.
                parts.append(f"{column} LIKE ?")
                params.append(f"%{value}%")
        if text:
            like = f"%{text}%"
            parts.append("(mark LIKE ? OR element_type LIKE ? OR subtype LIKE ? "
                         "OR old_value LIKE ? OR new_value LIKE ? OR user_name LIKE ?)")
            params.extend([like] * 6)
        return (f"WHERE {' AND '.join(parts)}" if parts else ""), params

    conn = get_connection()
    try:
        where, params = clauses_for()
        total = conn.execute(f"SELECT COUNT(*) AS n FROM activity_log {where}", params).fetchone()["n"]
        rows = conn.execute(
            f"SELECT * FROM activity_log {where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()

        # Наборы значений для выпадашек — по ОТОБРАННЫМ строкам, одним
        # проходом на все колонки сразу: отдельный DISTINCT на каждую — это
        # шесть проходов по таблице, которая на одной массовой смене
        # статуса вырастает на 9422 строки. Колонке, по которой отбор уже
        # включён, набор считается своим запросом без её собственного
        # условия — иначе, выбрав значение, из него нельзя было бы выйти.
        наборы = {c: set() for c in _ACT_DROPDOWNS}
        сводка = ", ".join(_ACT_DROPDOWNS)
        for r in conn.execute(f"SELECT DISTINCT {сводка} FROM activity_log {where}", params):
            for i, column in enumerate(_ACT_DROPDOWNS):
                if r[i] not in (None, ""):
                    наборы[column].add(r[i])
        for column in filters:
            if column not in наборы:
                continue
            sub_where, sub_params = clauses_for(skip=column)
            наборы[column] = {
                r[0] for r in conn.execute(
                    f"SELECT DISTINCT {column} FROM activity_log {sub_where}", sub_params)
                if r[0] not in (None, "")
            }
        values = {c: sorted(v, key=str) for c, v in наборы.items()}
        # Список действий отдельным полем — прежний договор с клиентом
        # (выпадашка «Действие» в шапке формы) остаётся рабочим.
        actions = values["action"]
        return {
            "total": total,
            "rows": [dict(r) for r in rows],
            "actions": actions,
            "values": values,
            # Подписи — с сервера: реестр действий и категорий живёт в
            # app/activity_actions.py, и вторая его копия в браузере
            # разошлась бы с первой на очередном новом событии.
            "action_titles": {a: action_title(a) for a in actions},
            "category_titles": CATEGORY_TITLES,
            "category_order": CATEGORY_ORDER,
        }
    finally:
        conn.close()


@app.get("/activity/stats")
def activity_stats(
    admin: sqlite3.Row = Depends(require_service_feature("activity_log", "read")),
):
    """Сколько журнал накопил и сколько места занимает (живой запрос
    2026-08-20). Решение «пора чистить» принимают в самой форме журнала, а
    цифры для него лежали на другом экране («Состояние БД»), куда за одной
    величиной не пойдёшь.

    ОТДЕЛЬНЫМ запросом, а не полем в выдаче поиска: размер считает `dbstat`,
    который читает базу целиком (на журнале в 2,6 млн записей — около двух
    секунд), а поиск отрабатывает на каждую букву в поле отбора. Здесь же
    он вызывается дважды за сеанс работы с формой: при открытии и после
    очистки.

    Размер берётся ТОЙ ЖЕ функцией, что и экран «Состояние БД»
    (`db_status.table_bytes`) — второй способ мерить то же самое дал бы два
    разных числа на одном экране. Размер может быть неизвестен (сборка
    SQLite без dbstat) — тогда `bytes` пустой, и форма скажет об этом, а не
    покажет ноль.
    """
    conn = get_connection()
    try:
        # COUNT(*) и границы периода — по индексу, мгновенно даже на
        # миллионах строк (замерено: 0,02 с на 2,6 млн).
        всего = conn.execute("SELECT COUNT(*) AS n FROM activity_log").fetchone()["n"]
        края = conn.execute("SELECT MIN(at) AS mn, MAX(at) AS mx FROM activity_log").fetchone()
        ошибок = conn.execute(
            "SELECT COUNT(*) AS n FROM activity_log WHERE category IN (?, ?)",
            (CATEGORY_ERROR, CATEGORY_DENIED),
        ).fetchone()["n"]
        return {
            "rows": всего,
            "errors": ошибок,
            "bytes": db_status_table_bytes(conn, "activity_log"),
            "db_bytes": database_bytes(),
            "oldest": края["mn"],
            "newest": края["mx"],
        }
    finally:
        conn.close()


@app.post("/activity/cleanup")
def cleanup_activity(
    before: str = Query(..., description="Удалить записи СТРОГО РАНЬШЕ этой даты, 'ГГГГ-ММ-ДД'"),
    admin: sqlite3.Row = Depends(require_service_feature("activity_log", "write")),
):
    """Очистка журнала за период. Журнал растёт быстро (одна массовая смена
    статуса на реальном файле — это 9422 записи), поэтому механизм очистки
    нужен с самого начала, а не когда база распухнет.

    Граница СТРОГАЯ: удаляется всё раньше указанной даты, сам день
    остаётся. Так проще объяснить и труднее случайно снести сегодняшнее.
    Сам факт очистки тоже попадает в журнал — иначе исчезновение записей
    было бы неотличимо от того, что их и не было.
    """
    conn = get_connection()
    try:
        n = conn.execute("SELECT COUNT(*) AS n FROM activity_log WHERE at < ?", (f"{before} 00:00:00.000",)).fetchone()["n"]
        conn.execute("DELETE FROM activity_log WHERE at < ?", (f"{before} 00:00:00.000",))
        conn.commit()
    finally:
        conn.close()
    activity.log("activity_cleanup", user=admin, old_value=str(n), new_value=before)
    return {"deleted": n, "before": before}


@app.get("/changes")
def get_changes(
    source_file: str = Query(...),
    since: Optional[str] = Query(None, description="UTC 'ГГГГ-ММ-ДД ЧЧ:ММ:СС'; пусто — только метка времени"),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Что изменилось у элементов чертежа после момента `since` — для
    автоматического обновления схемы у остальных открытых вкладок
    (совместная работа, живой запрос 2026-07-29: «если несколько
    пользователей в системе и один что-то поменял, второй это не увидит до
    принудительного обновления страницы»).

    Опрос, а не постоянное соединение (SSE/WebSocket) — сознательно: в
    app/main.py роуты синхронные (`def`, не `async def`), их обслуживает
    пул потоков, и открытое соединение занимало бы поток НА КАЖДОГО
    подключённого пользователя. Пул невелик (десятки), десяток открытых
    вкладок исчерпал бы его и подвесил всё приложение целиком. Переписывать
    45 синхронных роутов на async ради этого несоразмерно.

    Отдаём только то, что реально меняется по ходу работы: статус, привязка
    к контракту и даты. Геометрия и привязка к зонам меняются лишь при
    переимпорте чертежа — их всё равно нельзя применить точечно, для этого
    есть обычная перезагрузка.

    `server_time` возвращается ВСЕГДА и служит меткой для следующего
    запроса — брать её с часов клиента нельзя: они расходятся с серверными,
    и при спешащих часах браузера часть изменений была бы пропущена
    навсегда. Ответ при отсутствии изменений — несколько байт, поэтому
    частый опрос дёшев (для сравнения: полная перезагрузка схемы на
    реальном файле — 1,65 МБ одних контуров).
    """
    conn = get_connection()
    try:
        # Без проверки это давало непрерывное НАБЛЮДЕНИЕ за чужой стройкой:
        # опрос раз в 15 секунд отдаёт поток смен статусов, контрактов и дат
        # в реальном времени (аудит безопасности 2026-08-03).
        _guard_source_file(conn, user, source_file, "plan", "read")
        server_time = conn.execute("SELECT datetime('now') AS t").fetchone()["t"]
        if not since:
            return {"server_time": server_time, "elements": []}
        # Сравнение НЕСТРОГОЕ (>=), и это не описка. `updated_at` и
        # `server_time` — оба `datetime('now')`, то есть с точностью до
        # СЕКУНДЫ. При строгом `>` правка, попавшая в ту же секунду, что и
        # предыдущий опрос, не возвращалась НИКОГДА: её метка равна границе,
        # а не больше её. Поймано живым прогоном 2026-07-29 — смена статуса
        # прошла, журнал её записал, а вторая вкладка не увидела.
        #
        # Плата за `>=` — строки пограничной секунды приходят повторно один
        # раз. Это безвредно: applyElementDelta на клиенте идемпотентна и при
        # совпадении значений не считает элемент изменённым (и не показывает
        # уведомление). Терять правки ради экономии одного повтора нельзя.
        rows = conn.execute(
            "SELECT id, current_status, contract_id, planned_delivery_date, "
            "actual_delivery_date, project_delivery_date, project_smr_start_date, updated_at "
            f"FROM elements WHERE source_file = ? AND updated_at >= ? "
            f"AND {visible_elements_clause()} ORDER BY updated_at",
            (source_file, since),
        ).fetchall()
        return {
            "server_time": server_time,
            "elements": [enrich_element_row(conn, dict(r)) for r in rows],
        }
    finally:
        conn.close()


@app.post("/admin/reset-status-history")
def reset_status_history(user: sqlite3.Row = Depends(require_service_feature("reset_history", "write"))):
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
            (audit_display_name(user), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    # Сводкой, БЕЗ события на каждое изделие — сознательно. Правило
    # поэлементной записи (импорты, пересчёт зон) существует, потому что там
    # затронуто ПОДМНОЖЕСТВО, которое иначе не восстановить. Здесь затронуты
    # ВСЕ изделия разом, и «изменено всё» исчерпывающе; девять тысяч
    # одинаковых строк в отчёте не добавили бы ничего, кроме объёма.
    activity.log("status_history_reset", user=user, new_value=str(n),
                 details={"сообщение": "удалена вся история статусов, все изделия возвращены "
                                       "в «Запланирован»"})
    return {"reset_count": n}


@app.get("/status-summary", response_model=list[StatusSummaryEntry])
def status_summary(
    object_id: Optional[int] = Query(None),
    source_file: Optional[str] = Query(None),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Разбивка по статусам. Всегда в пределах доступного пользователю.

    До 2026-08-03 сводка считалась по ВСЕМ объектам сразу, а чертёж
    выбирался параметром `source_file` без всякой проверки: любой вошедший
    (в том числе без единого гранта) получал раскладку по всей системе, а
    подставив чужой `source_file` — по конкретной чужой стройке. Тот же
    класс, что закрывал аудит: выборка, которая объект не спрашивает,
    отдавала все стройки, и объект принимался параметром там, где его
    надо выводить (найдено `scripts/audit_endpoints.py`).

    Три случая, и во всех объект проверяется, а не принимается на веру:
    объект назван явно — `assert_object_access`; назван чертёж — объект
    выводится ИЗ НЕГО (`_guard_source_file`); не назван никто — сводка по
    всем ДОСТУПНЫМ объектам. `accessible_object_ids` возвращает None =
    «все» (системный админ), и это не то же самое, что пустое множество =
    «ничего»: перепутав их, сводка показала бы админу нули.
    """
    conn = get_connection()
    try:
        where = f"WHERE {visible_elements_clause()}"
        params: list = []
        if object_id is not None:
            assert_object_feature(conn, user, object_id, "plan", "read")
            where += " AND object_id = ?"
            params.append(object_id)
        elif source_file:
            _guard_source_file(conn, user, source_file, "plan", "read")
            where += " AND source_file = ?"
            params.append(source_file)
        else:
            доступные = accessible_object_ids(conn, user)
            if доступные is not None:
                if not доступные:
                    return [
                        StatusSummaryEntry(status=s, label=STATUS_LABELS_RU[s], count=0)
                        for s in STATUS_ORDER
                    ]
                # Строки без объекта сюда не попадают намеренно: чьи они,
                # неизвестно, и видеть их может только системный админ —
                # у него `доступные is None`, и фильтр не добавляется вовсе.
                where += f" AND object_id IN ({','.join('?' * len(доступные))})"
                params.extend(sorted(доступные))
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
    """Файлы, реально присутствующие в Input/ прямо сейчас (см. INPUT_DIR
    выше) — сканируется на каждый запрос (дёшево, файлов мало), чтобы файл,
    убранный из Input/ без перезапуска сервера, тоже сразу переставал
    предлагаться.

    ПЛЮС актуальные чертежи объектов, где бы их файл ни лежал. Без этого
    чертёж, загруженный через интерфейс, не попадал в список вообще: загрузка
    кладёт файл в uploads/, а не в Input/, поэтому сразу после успешного
    импорта схема оказывалась пустой. Раньше это не было видно — обработчик
    загрузки падал раньше, чем доходил до обновления списка (см.
    Docs/backlog.md 2026-07-30, найдено живой проверкой). Актуальный чертёж
    объекта — то, что система считает единственно верным описанием объекта,
    и скрывать его из-за расположения файла неправильно."""
    allowed = _input_dir_filenames()
    conn = get_connection()
    allowed |= {
        r["source_file"]
        for r in conn.execute("SELECT source_file FROM object_drawings WHERE is_current = 1")
    }
    try:
        # Список чертежей — тоже карта системы: по нему подбирается
        # source_file для перебора в остальных эндпоинтах. Отдаём только
        # чертежи доступных объектов (аудит безопасности 2026-08-03).
        доступ, доступ_params = _accessible_objects_clause(conn, user)
        rows = conn.execute(
            f"SELECT source_file, COUNT(*) as n FROM elements "
            f"WHERE {visible_elements_clause()} AND {доступ} "
            f"GROUP BY source_file ORDER BY source_file",
            доступ_params,
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
def set_status_colors(colors: dict[str, str], user: sqlite3.Row = Depends(require_service_feature("dict_status_colors", "write"))):
    valid = {s.value for s in Status}
    for status in colors:
        if status not in valid:
            raise HTTPException(status_code=422, detail=f"Неизвестный статус: {status}")
    # Тело здесь — обычный dict, а не модель, поэтому валидатор поля из
    # models.py сам не отработает; зовём его явно (см. validate_color).
    try:
        colors = {s: validate_color(c, "Цвет статуса") for s, c in colors.items()}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    conn = get_connection()
    try:
        activity.log("status_colors", user=user,
                     new_value="; ".join(f"{k}: {v}" for k, v in colors.items())[:500])
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


# Видимость подписей — настройка ОБЪЕКТА (этап D): типы элементов на
# соседних стройках разные, и общая запись включала бы «Колонны» сразу
# везде. object_id обязателен, доступ — по объекту (чтение всем, у кого
# есть доступ; правка — админу объекта, не сервиса).
@app.get("/label-visibility")
def get_label_visibility(object_id: int = Query(...),
                         user: sqlite3.Row = Depends(require_feature("label_visibility", "read"))):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT element_type, visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: bool(r["visible"]) for r in rows}
    finally:
        conn.close()


@app.put("/label-visibility")
def set_label_visibility(settings: dict[str, bool], object_id: int = Query(...),
                         user: sqlite3.Row = Depends(require_feature("label_visibility", "write"))):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (object_id, element_type, visible) VALUES (?, ?, ?) "
                "ON CONFLICT(object_id, element_type) DO UPDATE SET visible = excluded.visible",
                (object_id, element_type, int(visible)),
            )
        conn.commit()
        activity.log("label_visibility", user=user, entity_type="object", entity_id=object_id,
                     new_value="; ".join(f"{k}: {'вкл' if v else 'выкл'}"
                                         for k, v in settings.items())[:500])
        rows = conn.execute(
            "SELECT element_type, visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: bool(r["visible"]) for r in rows}
    finally:
        conn.close()


# Подпункт "Даты" (см. Docs/backlog.md) — тот же паттерн, что
# /label-visibility выше, отдельный столбец той же таблицы: управляет
# ТОЛЬКО допстрокой наклейки (код контрагента + плановая дата поставки),
# не самой видимостью марки.
@app.get("/label-dates-visibility")
def get_label_dates_visibility(object_id: int = Query(...),
                               user: sqlite3.Row = Depends(require_feature("label_visibility", "read"))):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT element_type, dates_visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: bool(r["dates_visible"]) for r in rows}
    finally:
        conn.close()


@app.put("/label-dates-visibility")
def set_label_dates_visibility(settings: dict[str, bool], object_id: int = Query(...),
                               user: sqlite3.Row = Depends(require_feature("label_visibility", "write"))):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (object_id, element_type, dates_visible) VALUES (?, ?, ?) "
                "ON CONFLICT(object_id, element_type) DO UPDATE SET dates_visible = excluded.dates_visible",
                (object_id, element_type, int(visible)),
            )
        conn.commit()
        activity.log("label_dates_visibility", user=user, entity_type="object", entity_id=object_id,
                     new_value="; ".join(f"{k}: {'вкл' if v else 'выкл'}"
                                         for k, v in settings.items())[:500])
        rows = conn.execute(
            "SELECT element_type, dates_visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
        return {r["element_type"]: bool(r["dates_visible"]) for r in rows}
    finally:
        conn.close()


@app.get("/layer-type-combinations")
def list_layer_type_combinations(admin: sqlite3.Row = Depends(require_service_feature("dict_element_shapes", "read"))):
    """Для экрана настроек формы маркера (п.11 третьего раунда) — все
    встреченные пары (слой, тип элемента) с их текущей формой (по
    умолчанию 'outline' — "как в оригинале", если явно не назначено иное в
    element_shapes; см. Docs/backlog.md).

    Системному администратору, а не всякому вошедшему (аудит безопасности
    2026-08-03, второй проход). Отбирать пары по доступным объектам смысла
    нет: сама настройка `element_shapes` СИСТЕМНАЯ (ключ — слой и тип, без
    объекта), то есть экран целиком принадлежит ведению сервиса и в меню
    закрыт `admin-only`. А отдавал эндпоинт имена слоёв ВСЕХ чертежей — а в
    новом стандарте имя слоя несёт зону, отметку, этаж и роль, то есть
    состав чужой стройки."""
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
def set_element_shapes(shapes: list[ElementShapeIn], user: sqlite3.Row = Depends(require_service_feature("dict_element_shapes", "write"))):
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
        activity.log("element_shapes", user=user,
                     new_value="; ".join(f"{x.element_type}: {x.shape}" for x in shapes)[:500])
    finally:
        conn.close()
    return {"status": "ok"}


@app.get("/zone-colors")
def list_zone_colors(object_id: int = Query(...),
                     user: sqlite3.Row = Depends(require_feature("zone_colors", "read"))):
    """Для экрана настроек «Цвета зон» — цвет каждого крана ОБЪЕКТА (см.
    Docs/backlog.md, item 7). До этапа D ключом был файл, и список
    показывал один и тот же кран столько раз, сколько версий чертежа
    накопилось. Стоянки отдельного цвета не имеют — наследуют цвет крана
    на отображении (см. plan_data), в этом списке не показываются."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT category, name, color FROM zone_colors "
            "WHERE object_id = ? AND category = 'Кран' ORDER BY name",
            (object_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.put("/zone-colors")
def set_zone_colors(items: list[ZoneColorIn], object_id: int = Query(...),
                    user: sqlite3.Row = Depends(require_feature("zone_colors", "write"))):
    conn = get_connection()
    try:
        for item in items:
            conn.execute(
                "INSERT INTO zone_colors (object_id, category, name, color) VALUES (?, 'Кран', ?, ?) "
                "ON CONFLICT(object_id, category, name) DO UPDATE SET color = excluded.color",
                (object_id, item.name, item.color),
            )
        conn.commit()
    finally:
        conn.close()
    activity.log("zone_colors", user=user, entity_type="object", entity_id=object_id,
                 new_value="; ".join(f"{i.name}: {i.color}" for i in items)[:500])
    return {"status": "ok"}


_ZONE_ELEMENT_COLUMN = {
    "Захватка": "zone_zakhvatka_id",
    "Кран": "zone_crane_id",
    "Стоянка": "zone_stance_id",
}


@app.get("/zones", response_model=list[ZoneOut])
def list_zones(
    category: str = Query(..., description="Захватка | Кран | Стоянка"),
    include_retired: bool = Query(False, description="Показывать зоны, которых нет в актуальном чертеже"),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Справочник зон одной категории (этап 2). Доступно всем ролям только
    для чтения — как и остальные справочники-просмотры.

    Условие object_id IS NOT NULL оставлено страховкой: зоны устаревших
    версий чертежа, ради которых оно вводилось, удалены чисткой
    дообъектного наследия (2026-07-31, app/db._purge_legacy_elements)."""
    if category not in _ZONE_ELEMENT_COLUMN:
        raise HTTPException(status_code=400, detail="Неизвестная категория зоны")
    column = _ZONE_ELEMENT_COLUMN[category]
    conn = get_connection()
    try:
        # Справочник зон отдавал зоны ВСЕХ объектов сразу — отбор был только
        # «объект вообще задан» (аудит безопасности 2026-08-03). Показательно,
        # что операции ЗАПИСИ по тем же зонам объект проверяли: проверку
        # писали, но только для правки.
        доступ, доступ_params = _accessible_objects_clause(conn, user, "z.object_id")
        where = f"z.object_id IS NOT NULL AND {доступ} AND z.category = ?"
        params = [*доступ_params, category]
        if not include_retired:
            where += " AND z.is_current = 1"
        rows = conn.execute(
            f"SELECT z.*, p.name AS parent_name FROM zones z "
            f"LEFT JOIN zones p ON p.id = z.parent_zone_id "
            f"WHERE {where} ORDER BY p.number, z.number, z.name",
            params,
        ).fetchall()

        # Счётчики элементов — одним групповым запросом, а не по зоне:
        # на этой же ошибке (N+1 на полных сканах) окно массовой смены
        # статуса открывалось 2,7 с, см. Docs/backlog.md.
        counts = {
            r["zid"]: r["n"]
            for r in conn.execute(
                f"SELECT {column} AS zid, COUNT(*) AS n FROM elements "
                f"WHERE {column} IS NOT NULL AND {visible_elements_clause()} GROUP BY {column}"
            )
        }
        levels_by_zone = {}
        for r in conn.execute(
            "SELECT id, zone_id, elevation_mm, source_file, outline_json FROM zone_levels "
            "ORDER BY elevation_mm"
        ):
            levels_by_zone.setdefault(r["zone_id"], []).append(ZoneLevelOut(
                id=r["id"], elevation_mm=r["elevation_mm"],
                points=len(json.loads(r["outline_json"])) if r["outline_json"] else 0,
                source_file=r["source_file"],
            ))

        return [
            ZoneOut(
                id=r["id"], category=r["category"], number=r["number"], name=r["name"],
                parent_zone_id=r["parent_zone_id"], parent_name=r["parent_name"],
                is_current=bool(r["is_current"]), match_status=r["match_status"],
                levels=levels_by_zone.get(r["id"], []),
                elements=counts.get(r["id"], 0),
            )
            for r in rows
        ]
    finally:
        conn.close()


@app.get("/zones/{zone_id}/geometry")
def zone_geometry(zone_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Геометрия зоны плюс КОНТЕКСТ для предпросмотра (решение З13): габариты
    объекта, сетка осей, соседние зоны той же категории и полигоны
    крана-владельца.

    Отдаётся одним запросом и не опирается на то, что сейчас загружено в
    браузере: справочник может быть открыт при любом выбранном чертеже.
    Элементы (9422 меша) в контекст НЕ входят — предпросмотр должен
    открываться мгновенно, а не рисовать всю схему заново."""
    conn = get_connection()
    try:
        zone = conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()
        if zone is None or zone["object_id"] is None:
            raise HTTPException(status_code=404, detail="Зона справочника не найдена")
        # Объект берётся ИЗ САМОЙ ЗОНЫ, как у правки зоны (update_zone) —
        # принимать его параметром значило бы позволить назвать любой
        # доступный и прочитать чужую. До этой проверки перебор zone_id
        # отдавал геометрию зон любого объекта вместе с сеткой осей,
        # габаритами стройки, соседними зонами и полигонами крана-владельца:
        # правка зоны объект проверяла, а чтение геометрии — нет (аудит
        # безопасности 2026-08-03, второй проход; ровно та же асимметрия
        # «писать нельзя, читать можно», что нашлась у справочника зон).
        assert_object_feature(conn, user, zone["object_id"], "zones", "read")

        def levels_of(zid):
            return [
                {"id": r["id"], "elevation_mm": r["elevation_mm"],
                 "outline": json.loads(r["outline_json"])}
                for r in conn.execute(
                    "SELECT id, elevation_mm, outline_json FROM zone_levels WHERE zone_id = ? "
                    "ORDER BY elevation_mm", (zid,))
            ]

        levels = levels_of(zone_id)
        siblings = []
        for row in conn.execute(
            "SELECT z.id, z.name, l.elevation_mm, l.outline_json FROM zones z "
            "JOIN zone_levels l ON l.zone_id = z.id "
            "WHERE z.object_id = ? AND z.category = ? AND z.id <> ? AND z.is_current = 1",
            (zone["object_id"], zone["category"], zone_id),
        ):
            siblings.append({
                "id": row["id"], "name": row["name"], "elevation_mm": row["elevation_mm"],
                "outline": json.loads(row["outline_json"]),
            })
        parent = levels_of(zone["parent_zone_id"]) if zone["parent_zone_id"] else []

        axes = [
            {"kind": r["kind"], "label": r["label"], "coord": r["coord"]}
            for r in conn.execute(
                "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?",
                (zone["source_file"],),
            )
        ]
        # Габариты объекта — по всем полигонам зон и по сетке осей. Считать по
        # контурам элементов было бы точнее, но это чтение 9422 контуров ради
        # рамки предпросмотра.
        xs, ys = [], []
        for row in conn.execute(
            "SELECT l.outline_json FROM zone_levels l JOIN zones z ON z.id = l.zone_id "
            "WHERE z.object_id = ?", (zone["object_id"],),
        ):
            for point in json.loads(row["outline_json"]):
                xs.append(point[0])
                ys.append(point[1])
        for axis in axes:
            (xs if axis["kind"] == "numeric" else ys).append(axis["coord"])
        bbox = [min(xs), min(ys), max(xs), max(ys)] if xs and ys else None

        cranes = [
            {"id": r["id"], "number": r["number"], "name": r["name"]}
            for r in conn.execute(
                "SELECT id, number, name FROM zones WHERE object_id = ? AND category = 'Кран' "
                "AND is_current = 1 ORDER BY number", (zone["object_id"],))
        ]
        return {
            "zone": {
                "id": zone["id"], "category": zone["category"], "number": zone["number"],
                "name": zone["name"], "parent_zone_id": zone["parent_zone_id"],
            },
            "levels": levels,
            "context": {"bbox": bbox, "axes": axes, "siblings": siblings, "parent": parent},
            "cranes": cranes,
        }
    finally:
        conn.close()


def _validate_zone_edit(conn, zone: sqlite3.Row, body: ZonePatchIn) -> None:
    """Запрещающие проверки правки зоны (решение З14 — «ошибки запрещать»).

    Про стоянку отдельно: НЕ требуем, чтобы она целиком лежала внутри
    полигона своего крана. На реальном чертеже 260723 у 184 стоянок из 252
    часть вершин вне крана — это норма, а не ошибка (замер в Docs/backlog.md).
    Запрещаем только вырожденный случай «ни одной вершины внутри», которого
    в реальных данных нет ни одного.
    """
    if not body.levels:
        raise HTTPException(status_code=400, detail="У зоны должен быть хотя бы один ярус")

    seen_elevations = set()
    for index, level in enumerate(body.levels, 1):
        if len(level.outline) < 3:
            raise HTTPException(
                status_code=400,
                detail=f"Ярус {index}: полигон не может иметь меньше трёх точек",
            )
        polygon = Polygon([(p[0], p[1]) for p in level.outline])
        if not polygon.is_valid:
            raise HTTPException(
                status_code=400,
                detail=f"Ярус {index}: контур самопересекается — исправьте порядок точек",
            )
        if polygon.area <= 0:
            raise HTTPException(status_code=400, detail=f"Ярус {index}: нулевая площадь контура")
        if level.elevation_mm in seen_elevations:
            raise HTTPException(
                status_code=400,
                detail=f"Отметка {level.elevation_mm} встречается у двух ярусов одной зоны",
            )
        seen_elevations.add(level.elevation_mm)

    if body.number is not None:
        clash_params = [zone["object_id"], zone["category"], body.number, zone["id"]]
        clash_sql = ("SELECT 1 FROM zones WHERE object_id = ? AND category = ? AND number = ? "
                     "AND id <> ? AND is_current = 1")
        if zone["category"] == "Стоянка":
            # Номер стоянки уникален внутри своего крана, а не по объекту:
            # «Стоянка 1» есть у каждого из кранов (проверено на данных).
            clash_sql += " AND parent_zone_id IS ?"
            clash_params.append(body.parent_zone_id)
        if conn.execute(clash_sql, clash_params).fetchone():
            raise HTTPException(
                status_code=409,
                detail=f"Номер {body.number} уже занят другой зоной этой категории",
            )

    if zone["category"] == "Стоянка" and body.parent_zone_id:
        crane_levels = conn.execute(
            "SELECT outline_json FROM zone_levels WHERE zone_id = ?", (body.parent_zone_id,)
        ).fetchall()
        crane_polygons = [
            Polygon([(p[0], p[1]) for p in json.loads(r["outline_json"])])
            for r in crane_levels if r["outline_json"]
        ]
        if crane_polygons:
            for index, level in enumerate(body.levels, 1):
                points = [Point(p[0], p[1]) for p in level.outline]
                if not any(poly.covers(pt) for poly in crane_polygons for pt in points):
                    raise HTTPException(
                        status_code=400,
                        detail=(f"Ярус {index}: стоянка целиком вне зоны своего крана — "
                                f"проверьте координаты или выбранный кран"),
                    )


@app.patch("/zones/{zone_id}")
def update_zone(zone_id: int, body: ZonePatchIn, admin: sqlite3.Row = Depends(get_current_user)):
    """Правка зоны справочника: номер, наименование, кран-владелец и
    ГЕОМЕТРИЯ ярусов (решения З9, З13, З14).

    ВАЖНО: после правки геометрии привязка элементов к зонам становится
    устаревшей — она считалась по прежним полигонам. Автоматический пересчёт
    (решение З11) ещё не сделан, поэтому ответ содержит число элементов,
    привязка которых могла измениться, а форма показывает предупреждение.
    Молча делать вид, что всё согласовано, нельзя — это ровно тот класс
    тихого расхождения, из-за которого пересчёт и был затребован.
    """
    conn = get_connection()
    try:
        zone = conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()
        if zone is None:
            raise HTTPException(status_code=404, detail="Зона не найдена")
        if zone["object_id"] is None:
            raise HTTPException(
                status_code=400,
                detail="Это зона устаревшей версии чертежа, она не входит в справочник",
            )
        # Доступ проверяется ДО разбора тела: иначе на чужой зоне сначала
        # выдавались бы подробности о её содержимом («нужен хотя бы один
        # ярус»), и только потом отказ. Объект берётся из самой зоны —
        # принимать его параметром значило бы позволить назвать любой
        # доступный и править чужую зону.
        assert_object_feature(conn, admin, zone["object_id"], "zones", "write")
        _validate_zone_edit(conn, zone, body)

        before = {
            "number": zone["number"], "name": zone["name"],
            "parent_zone_id": zone["parent_zone_id"],
            "levels": [
                {"elevation_mm": r["elevation_mm"], "outline": json.loads(r["outline_json"])}
                for r in conn.execute(
                    "SELECT elevation_mm, outline_json FROM zone_levels WHERE zone_id = ? "
                    "ORDER BY elevation_mm", (zone_id,))
            ],
        }

        # Привязки снимаем ДО правки геометрии: DELETE ярусов ниже обнуляет
        # elements.zone_stance_level_id каскадом (ON DELETE SET NULL), и
        # снимок, сделанный после, записал бы NULL вместо настоящего яруса.
        bindings_pre_edit = zone_recalc.capture_bindings(conn, zone_id, zone["category"])

        conn.execute(
            "UPDATE zones SET number = ?, name = ?, parent_zone_id = ? WHERE id = ?",
            (body.number, body.name, body.parent_zone_id, zone_id),
        )
        # Ярусы переписываются целиком: их состав тоже правится (ярус можно
        # добавить или убрать), а сопоставлять «тот же ярус» по id было бы
        # ложной точностью — отметка и есть его идентичность внутри зоны.
        conn.execute("DELETE FROM zone_levels WHERE zone_id = ?", (zone_id,))
        for level in body.levels:
            conn.execute(
                "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
                "VALUES (?, ?, ?, ?, ?)",
                (zone_id, level.elevation_mm, json.dumps(level.outline),
                 zone["source_file"], zone["dxf_handle"]),
            )
        conn.commit()

        # Пересчёт привязки — автоматически и сразу (решение З11): правка
        # геометрии делает прежнюю привязку неверной, а расхождение не видно
        # на глаз, поэтому оставлять его «на потом» нельзя. Отказ возможен
        # ровно в одном случае — чертёж с одним ярусом стоянок, где привязка
        # считается «лесенкой» по сетке осей (см. can_recalculate).
        refusal = zone_recalc.can_recalculate(conn, zone["object_id"])
        # Метка операции — общая у события правки зоны и у поэлементных
        # событий пересчёта привязки.
        операция = activity.new_request_id()
        if refusal:
            recalc = {"changed": 0, "by_category": {}, "before": [], "refused": refusal}
        else:
            recalc = zone_recalc.recalculate(conn, zone["object_id"], admin, операция)
        undo_id = zone_recalc.save_undo(
            conn, zone_id, admin, before,
            zone_recalc.merge_bindings(bindings_pre_edit, recalc["before"]),
        )
    finally:
        conn.close()

    activity.log(
        "zone_edit", user=admin, entity_type="zone", entity_id=zone_id, request_id=операция,
        element_type=zone["category"], mark=body.name,
        old_value=json.dumps(before, ensure_ascii=False)[:2000],
        new_value=f"ярусов {len(body.levels)}, номер {body.number}",
        details={
            "recalculated_elements": recalc["changed"],
            "by_category": recalc["by_category"],
            "undo_id": undo_id,
            "recalc_refused": recalc.get("refused"),
        },
    )
    result = next(z for z in list_zones(zone["category"], True, admin) if z.id == zone_id)
    # Числа пересчёта прикладываем к ответу: форма показывает их сразу, не
    # отдельным запросом.
    payload = result.model_dump()
    payload["recalculated"] = recalc["changed"]
    payload["recalc_refused"] = recalc.get("refused")
    payload["can_undo"] = True
    return payload


@app.post("/zones/{zone_id}/undo")
def undo_zone_edit(zone_id: int, admin: sqlite3.Row = Depends(get_current_user)):
    """Откат последней правки зоны ЦЕЛИКОМ (решение З12): реквизиты, ярусы и
    привязки элементов, которые изменил пересчёт. Правка точки задевает
    цепочку последствий, и отменяться должна вся цепочка."""
    conn = get_connection()
    try:
        zone = conn.execute("SELECT object_id FROM zones WHERE id = ?", (zone_id,)).fetchone()
        if zone is None:
            raise HTTPException(status_code=404, detail="Зона не найдена")
        assert_object_feature(conn, admin, zone["object_id"], "zones", "write")
        result = zone_recalc.undo(conn, zone_id)
    finally:
        conn.close()
    if not result["restored"]:
        raise HTTPException(status_code=409, detail=result["reason"])
    activity.log(
        "zone_edit_undo", user=admin, entity_type="zone", entity_id=zone_id,
        new_value=f"ярусов {result['levels']}, привязок восстановлено {result['elements']}",
    )
    return result


# ---------- Справочник элементов (этап 3, решение Э1) ----------
#
# С 2026-08-04 (живой запрос «добавь все поля») в таблице ВСЕ реквизиты
# элемента, включая приходящие из JOIN'ов — объект, зоны, контрагент, ярус
# стоянки. Поэтому колонки описаны ОДНИМ реестром «ключ -> выражение SQL»:
# по этому же выражению колонка и отбирается, и сортируется, и собирает
# значения для выпадашки. Выражение, а не голое имя колонки: половина
# ключей — из присоединённых таблиц, а имя в SQL параметром не передать,
# оно склеивается в текст запроса. Реестр здесь заодно и белый список —
# без него отбор по произвольному ключу был бы SQL-инъекцией.
#
# Чего в реестре НЕТ намеренно: outline_json (геометрия, в таблицу не
# помещается и не читается человеком), is_current (в справочнике он всегда
# 1 — колонка-константа), manual_fields (список правленых полей, показан
# галочкой ✎ в форме элемента), *_id зон и контракта (вместо них — имена).
_EC_FROM = """
    FROM elements e
    LEFT JOIN objects o ON o.id = e.object_id
    LEFT JOIN zones zz ON zz.id = e.zone_zakhvatka_id
    LEFT JOIN zones zc ON zc.id = e.zone_crane_id
    LEFT JOIN zones zs ON zs.id = e.zone_stance_id
    LEFT JOIN zone_levels zl ON zl.id = e.zone_stance_level_id
    LEFT JOIN contracts co ON co.id = e.contract_id
    LEFT JOIN specifications sp ON sp.id = co.specification_id
    LEFT JOIN agreements ag ON ag.id = sp.agreement_id
    LEFT JOIN counterparties cp ON cp.id = ag.counterparty_id
    LEFT JOIN marks mk ON mk.id = e.mark_id
"""

_EC_SQL = {
    "id": "e.id",
    "object_name": "o.name",
    "element_type": "e.element_type",
    "subtype": "e.subtype",
    "mark": "e.mark",
    # Марка СПРАВОЧНИКОМ рядом с текстовой (2026-08-05): пока оба поля живут
    # вместе, справочник и его наполнение сверяют глазами именно здесь —
    # в списке, где видно сразу тысячи строк.
    "mark_ref": "mk.name",
    "mark_source": "e.mark_source",
    "elevation_mm": "e.elevation_mm",
    "floor": "e.floor",
    "address": "e.address",
    "current_status": "e.current_status",
    "planned_delivery_date": "e.planned_delivery_date",
    "actual_delivery_date": "e.actual_delivery_date",
    "project_smr_start_date": "e.project_smr_start_date",
    "project_delivery_date": "e.project_delivery_date",
    "contract_id": "e.contract_id",
    "counterparty": "cp.short_name",
    "comment": "e.comment",
    "zone_zakhvatka": "zz.name",
    "zone_zakhvatka_status": "e.zone_zakhvatka_status",
    "zone_crane": "zc.name",
    "zone_crane_status": "e.zone_crane_status",
    "zone_stance": "zs.name",
    "zone_stance_status": "e.zone_stance_status",
    "zone_stance_level_elevation_mm": "zl.elevation_mm",
    "axis_status": "e.axis_status",
    "axis_number": "e.axis_number",
    "axis_letter": "e.axis_letter",
    "nearest_axis_number": "e.nearest_axis_number",
    "nearest_axis_letter": "e.nearest_axis_letter",
    "offset_x_mm": "e.offset_x_mm",
    "offset_y_mm": "e.offset_y_mm",
    "x": "e.x",
    "y": "e.y",
    "z": "e.z",
    "layer": "e.layer",
    "source_file": "e.source_file",
    "dxf_handle": "e.dxf_handle",
    "element_uid": "e.element_uid",
    "created_at": "e.created_at",
    "updated_at": "e.updated_at",
}

# Колонки, отбираемые ВЫПАДАШКОЙ: у них ограниченный набор значений.
# Остальные ключи реестра отбираются подстрокой — у дат, координат, адреса
# и UID значений почти столько же, сколько строк, и список из 9000 пунктов
# бесполезен, а «2026-09» отбирает по месяцу.
_EC_DROPDOWN_COLUMNS = (
    "object_name", "element_type", "subtype", "mark", "mark_ref", "mark_source",
    "elevation_mm", "floor", "current_status", "contract_id", "counterparty",
    "zone_zakhvatka", "zone_zakhvatka_status", "zone_crane", "zone_crane_status",
    "zone_stance", "zone_stance_status", "zone_stance_level_elevation_mm",
    "axis_status", "axis_number", "axis_letter",
    "nearest_axis_number", "nearest_axis_letter", "layer", "source_file",
)

# Тот же сентинел «нет значения», что уже используют фильтры схемы на
# фронтенде (PLACEMENT_NONE в app/static/app.js): пустая строка в запросе
# означает «любое значение», а «не заполнено» надо уметь выбрать явно.
# Пара к нему — «заполнено» (живой запрос 2026-08-04): вопрос «где ещё не
# проставлена плановая дата» задаётся к ЛЮБОЙ колонке, поэтому оба сентинела
# принимаются вместо значения у всех ключей реестра, и у выпадашек, и у
# подстрочных. Пустая строка считается незаполненной наравне с NULL: в базе
# есть и то и другое, а для человека это одно и то же.
PLACEMENT_NONE_SENTINEL = "__none__"
FILLED_SENTINEL = "__filled__"

# Параметры запроса, которые НЕ являются отбором по колонке.
_EC_RESERVED = ("limit", "offset", "sort", "direction", "search")


def _ec_value_sort_key(value):
    """Порядок значений в выпадашке. Числа отдельной группой и по величине,
    остальное — как текст: в одной колонке (отметка, этаж) значения
    однородны, но общий ключ на все колонки не имеет права падать на
    смешанном наборе."""
    if isinstance(value, (int, float)):
        return (0, float(value), "")
    return (1, 0.0, str(value))


# Путь БЕЗ префикса /elements/: маршрут /elements/{element_id} объявлен
# раньше и перехватывал бы «catalog» как идентификатор элемента (422 на
# разборе int) — поймано первым же запросом.
@app.get("/element-catalog")
def elements_catalog(
    request: Request,
    limit: int = Query(200, le=2000),
    offset: int = Query(0, ge=0),
    sort: str = Query("id"),
    direction: str = Query("asc"),
    search: Optional[str] = Query(None, description="подстрока в марке или адресе"),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Табличный справочник элементов с отбором по колонкам и сортировкой.

    Отбор принимается ПРОИЗВОЛЬНЫМИ параметрами запроса «ключ=значение»
    (ключи — из реестра _EC_SQL), а не сорока именованными аргументами:
    после того как в таблицу вошли все поля элемента, перечислять их в
    сигнатуре значило бы держать третий список тех же колонок рядом с
    реестром и клиентом. Неизвестный ключ — 400, а не молчаливый пропуск:
    опечатка в имени поля иначе выглядела бы как «фильтр не работает».

    Отдаёт и страницу строк, и общее число совпадений, и наборы РАЗЛИЧНЫХ
    значений для выпадашек отбора. Значения считаются по тому же отбору, что
    и строки, но БЕЗ учёта фильтра самой этой колонки — иначе, выбрав
    значение, пользователь терял бы возможность переключиться на другое
    (та же логика «полный список значений всегда виден», что у фильтров
    схемы, см. Docs/backlog.md).
    """
    if sort not in _EC_SQL:
        raise HTTPException(status_code=400, detail=f"Сортировка по «{sort}» не поддерживается")
    order = "DESC" if str(direction).lower() == "desc" else "ASC"

    filters = {}
    for key, value in request.query_params.items():
        if key in _EC_RESERVED:
            continue
        if key not in _EC_SQL:
            raise HTTPException(status_code=400, detail=f"Отбор по «{key}» не поддерживается")
        # Пустая строка означает «любое», а не «пустое значение»: для
        # «не заполнено» есть отдельный сентинел.
        if value != "":
            filters[key] = value

    def clauses_for(skip: Optional[str] = None):
        # object_id IS NOT NULL оставлено как страховка, хотя элементов без
        # объекта после чистки дообъектного наследия (2026-07-31,
        # app/db._purge_legacy_elements) в базе нет и импорт создать их не
        # может: справочник допускает ручную правку, и строка, оставшаяся
        # без объекта из-за сбоя, не должна всплыть в чужом объекте.
        # _доступ вычисляется ниже, сразу после открытия соединения, и
        # попадает сюда замыканием: справочник не принимает объект
        # параметром, поэтому единственный способ не отдать чужие строки —
        # сузить выборку по доступным объектам (аудит безопасности
        # 2026-08-03; до него отбор был только по «объект вообще задан»,
        # то есть любой вошедший листал элементы всех строек разом).
        parts = ["e.object_id IS NOT NULL", "e.is_current = 1", _доступ]
        params = list(_доступ_params)
        for column, value in filters.items():
            if column == skip:
                continue
            expr = _EC_SQL[column]
            if value == PLACEMENT_NONE_SENTINEL:
                parts.append(f"({expr} IS NULL OR {expr} = '')")
            elif value == FILLED_SENTINEL:
                parts.append(f"({expr} IS NOT NULL AND {expr} <> '')")
            elif column in _EC_DROPDOWN_COLUMNS:
                parts.append(f"{expr} = ?")
                params.append(value)
            else:
                parts.append(f"{expr} LIKE ?")
                params.append(f"%{value}%")
        if search:
            parts.append("(e.mark LIKE ? OR e.address LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        return " AND ".join(parts), params

    conn = get_connection()
    try:
        _доступ, _доступ_params = _accessible_objects_clause(conn, user, "e.object_id")
        where, params = clauses_for()
        total = conn.execute(
            f"SELECT COUNT(*) AS n {_EC_FROM} WHERE {where}", params
        ).fetchone()["n"]
        rows = conn.execute(
            f"""
            SELECT e.*, o.name AS object_name,
                   zz.name AS zone_zakhvatka, zc.name AS zone_crane, zs.name AS zone_stance,
                   zl.elevation_mm AS zone_stance_level_elevation_mm,
                   cp.short_name AS counterparty, mk.name AS mark_ref
            {_EC_FROM} WHERE {where}
            ORDER BY {_EC_SQL[sort]} {order}, e.id {order} LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        ).fetchall()

        # Наборы значений для выпадашек. Колонок с выпадашкой два десятка, и
        # отдельный DISTINCT-запрос на каждую — это два десятка проходов по
        # девяти с половиной тысячам строк с девятью JOIN'ами на КАЖДУЮ
        # перерисовку таблицы. Вместо этого один проход по уже отобранным
        # строкам и раскладка значений по множествам в Python; свой запрос
        # нужен только колонкам, по которым отбор ВКЛЮЧЁН — им набор
        # считается без их собственного условия.
        наборы = {c: set() for c in _EC_DROPDOWN_COLUMNS}
        сводка = ", ".join(f"{_EC_SQL[c]} AS v{i}" for i, c in enumerate(_EC_DROPDOWN_COLUMNS))
        for r in conn.execute(f"SELECT {сводка} {_EC_FROM} WHERE {where}", params):
            for i, column in enumerate(_EC_DROPDOWN_COLUMNS):
                v = r[i]
                if v is not None and v != "":
                    наборы[column].add(v)
        for column in filters:
            if column not in наборы:
                continue
            sub_where, sub_params = clauses_for(skip=column)
            expr = _EC_SQL[column]
            наборы[column] = {
                r[0] for r in conn.execute(
                    f"SELECT DISTINCT {expr} {_EC_FROM} WHERE {sub_where}", sub_params)
                if r[0] is not None and r[0] != ""
            }
        values = {c: sorted(v, key=_ec_value_sort_key) for c, v in наборы.items()}

        # Наименования контрактов — только для тех, что реально встретились в
        # доступных строках: справочник контрактов целиком отдавать нельзя,
        # он объектный (аудит безопасности 2026-08-03, «проверять чтение так
        # же, как запись»).
        нужны = set(values["contract_id"]) | {
            r["contract_id"] for r in rows if r["contract_id"] is not None}
        contract_names = {c["id"]: c["name"] for c in contract_catalog(conn) if c["id"] in нужны}

        # Скрепка в строке — по одному запросу на СТРАНИЦУ, не на строку:
        # при 200 строках это была бы двухсотка запросов на каждую прокрутку.
        вложений = attachment_counts(conn, "element", [r["id"] for r in rows])
        строки = []
        for r in rows:
            d = enrich_element_row(conn, dict(r))
            # Геометрия контура в таблицу не выводится, а весит больше всей
            # остальной строки — 200 таких на страницу гоняли бы по сети
            # мегабайты ради колонки, которой нет.
            d.pop("outline_json", None)
            d["attachments"] = вложений.get(r["id"], 0)
            строки.append(d)
        return {"total": total, "rows": строки, "values": values,
                "contract_names": contract_names}
    finally:
        conn.close()


# Поля элемента, которые админ правит руками в справочнике (решение Э2).
# Статуса и фактической даты здесь НЕТ намеренно (решение Э3): у статуса своя
# история и рабочая дата, правка «поля статус» в таблице разъехалась бы с
# status_history; для него — обычный диалог смены статуса.
#
# Проектные даты СМР (project_smr_start_date/project_delivery_date) правятся
# здесь наравне с плановой (живой запрос): обычно их приносит импорт графика
# MS Project, но у блока «Кран+Стоянка+Этаж+Тип+Подтип», которого в графике
# нет, элемент остаётся без дат навсегда — руками это не поправить было ничем.
# Как и остальные поля отсюда, правленая дата попадает в manual_fields, то
# есть следующий импорт графика её НЕ перезапишет молча.
# Состав правимых полей и все проверки — в app/element_fields.py: с
# 2026-08-01 у них два потребителя (эта форма и массовая правка через
# Excel, app/element_bulk_edit.py), и разъехавшиеся правила дали бы
# «в форме нельзя, а через файл прошло».
_ELEMENT_EDITABLE_FIELDS = EDITABLE_FIELDS


@app.patch("/elements/{element_id}/fields")
def update_element_fields(
    element_id: int,
    body: dict,
    confirm_contract_mismatch: bool = Query(False),
    admin: sqlite3.Row = Depends(get_current_user),
):
    """Ручная правка полей элемента (решения Э2, Э4, Э5).

    Каждое правленое поле запоминается в elements.manual_fields — переимпорт
    чертежа его не перезаписывает, а показывает расхождение (иначе правка
    жила бы до первой загрузки нового чертежа и молча исчезала).

    Если после смены типа или марки элемент перестаёт соответствовать позиции
    своего контракта, правка отклоняется 409 с описанием — и применяется
    только при явном confirm_contract_mismatch (решение Э5: «предупреждать и
    согласовывать»).
    """
    unknown = set(body) - set(_ELEMENT_EDITABLE_FIELDS)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Эти поля не правятся здесь: {', '.join(sorted(unknown))}. "
                   f"Статус и фактическая дата меняются диалогом смены статуса.",
        )

    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Элемент не найден")
        # Объект выводится из самого элемента: отдельным параметром его
        # передавать нельзя — клиент назвал бы любой, к которому у него есть
        # доступ, и правил бы чужой элемент.
        assert_object_feature(conn, admin, row["object_id"], "element_fields", "write")

        values = {}
        for field, raw in body.items():
            try:
                values[field] = coerce_field(field, raw)
            except FieldError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

        new_type = values.get("element_type", row["element_type"])
        new_subtype = values.get("subtype", row["subtype"])
        if "element_type" in values or "subtype" in values:
            err = check_subtype(conn, new_type, new_subtype, row["object_id"])
            if err:
                raise HTTPException(status_code=400, detail=err)

        # Расхождение с позицией контракта — только если контракт назначен.
        # С 2026-08-14 это ЗАПРЕТ, а не согласовываемое предупреждение
        # (прежнее решение Э5 отменено пользователем): правка марки уводила
        # изделие из-под позиции контракта ровно так же, как привязка к
        # контракту без позиции, — с той разницей, что «согласовано» никто
        # потом не отличал от «не заметили». confirm_contract_mismatch
        # больше ничего не открывает; параметр оставлен, чтобы старый клиент
        # получал внятный отказ, а не 422 на неизвестный параметр.
        new_mark = values.get("mark", row["mark"])
        mismatch = None
        if "mark" in values or "element_type" in values:
            mismatch = contract_mismatch(conn, row["contract_id"], new_type, new_mark)
            if mismatch:
                raise HTTPException(
                    status_code=409,
                    detail=mismatch + ". Сначала снимите привязку к контракту "
                                      "или заведите в нём позицию под новую марку.")

        if not values:
            raise HTTPException(status_code=400, detail="Нечего сохранять")

        changed, manual = write_fields(conn, element_id, row, values)
        conn.commit()
        updated = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
        result = enrich_element_row(conn, dict(updated))
    finally:
        conn.close()

    if changed:
        activity.log(
            "element_edit", user=admin, entity_type="element", entity_id=element_id,
            element_type=result.get("element_type"), subtype=result.get("subtype"),
            mark=result.get("mark"),
            old_value="; ".join(f"{f}: {was}" for f, (was, _) in changed.items())[:500],
            new_value="; ".join(f"{f}: {now}" for f, (_, now) in changed.items())[:500],
            details={"contract_mismatch": mismatch, "manual_fields": manual},
        )
    result["manual_fields"] = manual
    result["contract_mismatch"] = mismatch
    return result


# Режим формы массовой правки: реквизиты элемента, история статусов или
# контрактация (позиции контрактов вместе с реквизитами их спецификаций,
# договоров и контрагентов, 2026-08-10). Один набор эндпоинтов на все, а не
# три параллельных: структуры ответа (columns/elements/changes/rejected)
# совпадают, и табличный экран подтверждения переиспользуется целиком.
# Массовая правка идёт по ВСЕМ объектам одним файлом (так её и просили),
# поэтому она пока за администратором сервиса. Отдать её «админу объекта»
# без отбора строк по доступным объектам значило бы выдать ему выгрузку
# всей базы и право править чужие элементы — отбор нужен в обоих модулях
# выгрузки (реквизиты и статусы) и вынесен в отдельную задачу.
_BULK_MODES = {"fields", "statuses", "contracting"}


def _check_bulk_mode(mode: str) -> str:
    if mode not in _BULK_MODES:
        raise HTTPException(status_code=400, detail=f"Неизвестный режим «{mode}»")
    return mode


class BulkEditExportIn(BaseModel):
    mode: str = "fields"
    # «Учитывать фильтр» — готовый список id, посчитанный КЛИЕНТОМ, ровно как
    # у /export.xlsx: фильтры схемы (passesPlacementFilters) целиком живут на
    # фронтенде, и второй их реализации на сервере быть не должно. Список на
    # тысячи значений не помещается в query string, поэтому выгрузка — POST.
    element_ids: Optional[list[int]] = None


@app.post("/elements/bulk-edit/export")
def bulk_edit_export(body: BulkEditExportIn, admin: sqlite3.Row = Depends(require_service_feature("bulk_edit", "read"))):
    """Снимок реквизитов элементов ОДНИМ файлом — для правки в Excel и
    обратной загрузки (см. app/element_bulk_edit.py). Без element_ids — все
    элементы всех объектов, с ними — только отобранные фильтром схемы.

    Уровень — «Чтение», а не «Изменение» (решение пользователя 2026-08-19):
    раздел и выгружает данные, и принимает их обратно, и делится по той же
    границе — выгрузка ничего не меняет, менять начинают /analyze и /apply
    ниже. Признак `io` у раздела в app/features.py.

    Оговорка при выдаче: файл содержит элементы ВСЕХ объектов — отбор по
    доступным ещё не сделан (хвост этапа C). То есть «Чтение» по этому
    разделу открывает и чужие объекты; в примечании раздела это сказано.
    """
    _check_bulk_mode(body.mode)
    ids = set(body.element_ids) if body.element_ids is not None else None
    if ids is not None and not ids:
        raise HTTPException(status_code=400,
                            detail="Фильтр схемы не пропускает ни одного элемента — выгружать нечего")
    conn = get_connection()
    try:
        if body.mode == "contracting":
            # Отбора по фильтру схемы у контрактации нет: строка файла — не
            # элемент, а позиция контракта (форма в этом режиме галочку и не
            # показывает). Пришедший список id молча игнорировать нельзя —
            # это выглядело бы как «выгрузили отобранное».
            wb = contracting_bulk_edit.build_contracting_workbook(conn)
        elif body.mode == "statuses":
            wb = status_bulk_edit.build_status_workbook(conn, ids)
        else:
            wb = build_export_workbook(conn, ids)
    finally:
        conn.close()
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    activity.log("element_bulk_export", user=admin, entity_type="element",
                 details={"mode": body.mode,
                          "filtered": None if ids is None else len(ids)})
    name = {"statuses": "zhbi_statuses", "contracting": "zhbi_contracting"}.get(
        body.mode, "zhbi_elements")
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}_{stamp}.xlsx"'},
    )


@app.post("/elements/bulk-edit/analyze")
def bulk_edit_analyze(file: UploadFile = File(...), mode: str = Form("fields"),
                      admin: sqlite3.Row = Depends(require_service_feature("bulk_edit", "write"))):
    """Сверяет загруженный файл с базой и возвращает список расхождений.
    НИЧЕГО НЕ ПИШЕТ — применение отдельным вызовом, после того как
    пользователь отметил флажками, что применять."""
    _check_bulk_mode(mode)
    payload = read_upload_limited(file.file)
    conn = get_connection()
    try:
        if mode == "contracting":
            return contracting_bulk_edit.analyze(conn, payload)
        if mode == "statuses":
            return status_bulk_edit.analyze(conn, payload)
        return analyze_bulk_edit(conn, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        conn.close()


class BulkEditApplyIn(BaseModel):
    # Ровно те строки, что вернул analyze, отфильтрованные флажками. Файл
    # заново НЕ читается: перечитывание между показом и применением
    # означало бы, что применить могли не то, что показали пользователю.
    changes: list[dict]
    # Дата статуса «Контрактация» для элементов, которым контракт назначают
    # из «Запланирован»: такая правка — событие, а не смена реквизита.
    contracting_date: Optional[str] = None
    mode: str = "fields"


@app.post("/elements/bulk-edit/apply")
def bulk_edit_apply(body: BulkEditApplyIn, admin: sqlite3.Row = Depends(require_service_feature("bulk_edit", "write"))):
    """Применяет отмеченные изменения."""
    if not body.changes:
        raise HTTPException(status_code=400, detail="Не отмечено ни одного изменения")
    _check_bulk_mode(body.mode)
    # Файл читается на фазе /analyze, пишет — эта: копия снимается здесь,
    # чтобы не плодить её на каждый просмотр расхождений.
    backup_before_import(f"массовая правка через Excel ({body.mode})",
                         audit_display_name(admin), admin["id"])
    conn = get_connection()
    try:
        if body.mode == "contracting":
            try:
                return contracting_bulk_edit.apply_changes(
                    conn, body.changes, audit_display_name(admin), admin["id"]
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        if body.mode == "statuses":
            try:
                return status_bulk_edit.apply_changes(
                    conn, body.changes, audit_display_name(admin), admin["id"]
                )
            except ValueError as exc:
                # Недопустимое имя поля в теле запроса — ошибка ЗАПРОСА (400),
                # а не сбой сервера (тот же белый список, что у реквизитов).
                raise HTTPException(status_code=400, detail=str(exc))
        stamp = None
        if body.contracting_date:
            try:
                datetime.strptime(body.contracting_date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="Дата статуса — в виде ГГГГ-ММ-ДД")
            # Полдень, а не полночь: запись «Запланирован» от импорта чертежа
            # несёт реальное время суток, и событие в 00:00 того же дня
            # оказалось бы РАНЬШЕ неё, то есть не подействовало бы.
            stamp = f"{body.contracting_date} 12:00:00"
        try:
            return apply_bulk_edit(
                conn, body.changes, audit_display_name(admin), admin["id"], stamp
            )
        except ValueError as exc:
            # Недопустимое имя поля в теле запроса — ошибка ЗАПРОСА (400),
            # а не сбой сервера: см. белый список в app/element_bulk_edit.py.
            raise HTTPException(status_code=400, detail=str(exc))
    finally:
        conn.close()


# ==================== ПЕРЕНОС БАЗЫ ЦЕЛИКОМ ====================
# Четвёртый раздел «Массовой правки через Excel» (2026-08-11, живой запрос).
# Три первых раздела переносят СРЕЗ и ДОПОЛНЯЮТ им базу приёмника — для
# «потестировать на реальных данных» это негодный инструмент: чужие данные
# ложатся поверх своих, ссылки рвутся. Здесь — полная ЗАМЕНА снимком.
# Почему снимок файлом, а не выгрузка по таблицам, и как решается
# расхождение схем — в шапке app/db_transfer.py.
#
# Эндпоинты живут рядом с bulk-edit намеренно: это один экран для человека,
# и разносить их по файлу означало бы искать половину логики в другом месте.


@app.post("/admin/db-transfer/export")
def db_transfer_export(admin: sqlite3.Row = Depends(require_service_feature("db_transfer", "write"))):
    """Снимок ВСЕЙ базы и вложений одним архивом — то, что увозят с боевого
    сервера. Только администратор сервиса: в файле вся база целиком,
    включая пользователей и журнал."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Собираем во временный файл, а не в память: база с вложениями — это
    # сотни мегабайт, и держать их в оперативной памяти процесса незачем.
    tmp = Path(tempfile.mkdtemp(prefix="zhbi_transfer_"))
    archive = tmp / f"zhbi_snapshot_{stamp}.zip"
    try:
        manifest = db_transfer.build_archive(archive, user_name=audit_display_name(admin))
    except OSError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Не удалось собрать снимок: {exc}")
    activity.log(
        "db_transfer_export", user=admin, new_value=archive.name,
        details={"версия кода": manifest.get("code_version"),
                 "таблиц": len(manifest.get("tables") or {}),
                 "файлов вложений": (manifest.get("uploads") or {}).get("files"),
                 "размер архива": manifest.get("archive_bytes")},
    )
    # Временная папка убирается ПОСЛЕ отдачи файла: BackgroundTask
    # выполняется, когда ответ уже ушёл клиенту.
    return FileResponse(
        archive, media_type="application/zip", filename=archive.name,
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )


@app.get("/admin/db-transfer/current")
def db_transfer_current(admin: sqlite3.Row = Depends(require_service_feature("db_transfer", "read"))):
    """Что сейчас в базе приёмника — левая колонка сверки «было/приедет».
    Отдельным запросом, до всякой загрузки: человек должен видеть, что
    именно он собирается потерять."""
    return db_transfer.describe_current()


@app.post("/admin/db-transfer/stage")
def db_transfer_stage(file: UploadFile = File(...),
                      admin: sqlite3.Row = Depends(require_service_feature("db_transfer", "write"))):
    """Принять снимок и СВЕРИТЬ его с текущей базой. Ничего не меняет:
    замена — отдельным вызовом, с кодовым словом."""
    payload = read_upload_limited(file.file)
    try:
        result = db_transfer.stage_archive(payload, user_name=audit_display_name(admin))
    except db_transfer.TransferError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    activity.log(
        "db_transfer_stage", user=admin, new_value=file.filename,
        details={"снимок снят": (result["snapshot"] or {}).get("created_at"),
                 "сервер-источник": (result["snapshot"] or {}).get("host"),
                 "предупреждений": len(result["warnings"])},
    )
    return result


class DbTransferApplyIn(BaseModel):
    token: str
    # Кодовое слово набирается руками (решение пользователя 2026-08-11).
    # Проверяется на СЕРВЕРЕ, а не только в форме: кнопка в браузере — это
    # удобство, а не защита.
    confirm: str


@app.post("/admin/db-transfer/apply")
def db_transfer_apply(body: DbTransferApplyIn,
                      admin: sqlite3.Row = Depends(require_service_feature("db_transfer", "write"))):
    """ПОЛНАЯ ЗАМЕНА базы и вложений содержимым снимка.

    Перед заменой всегда снимается служебная резервная копия (вид
    `auto_before_transfer`) — единственная нить назад к тому, что было на
    приёмнике.

    После переноса данных прогоняются миграции схемы и обработки релиза —
    ровно как при восстановлении из резервной копии: снимок приезжает с
    более старой версии, и без миграций приложение на нём не поднимется.

    Журнал действий пишется ДО замены (внутри записи о сверке) и после неё
    заново — сама запись «заменили» ложится уже в НОВУЮ базу, из старой она
    уехала вместе со всем остальным. Это не потеря: старая база целиком
    лежит в служебной копии.
    """
    from app import release_tasks

    try:
        result = db_transfer.apply_archive(
            body.token, body.confirm,
            user_name=audit_display_name(admin), user_id=admin["id"],
        )
    except db_transfer.TransferError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    schema_changes = init_db()
    выполнено = release_tasks.run_pending()
    result["schema_changes"] = schema_changes
    result["release_tasks"] = выполнено
    # Пользователь этой сессии в новой базе может не существовать вовсе,
    # поэтому пишем в журнал по имени, а не по ссылке на запись users.
    activity.log(
        "db_transfer_apply", user_name=audit_display_name(admin),
        new_value="база заменена снимком другого сервера",
        details={"служебная копия": result["safety_backup"]["name"],
                 "прежние вложения": result["uploads_moved_to"],
                 "миграций схемы": len(schema_changes),
                 "обработок релиза": len(выполнено)},
    )
    return result


class DbTransferForgetIn(BaseModel):
    token: str


@app.post("/admin/db-transfer/forget")
def db_transfer_forget(body: DbTransferForgetIn,
                       admin: sqlite3.Row = Depends(require_service_feature("db_transfer", "write"))):
    """Убрать загруженный снимок из очереди, не применяя. Архив — копия
    всей базы, и оставлять его на диске «на всякий случай» не надо."""
    db_transfer.forget_staged(body.token)
    return {"ok": True}


def _object_for_source_file(conn, source_file: str):
    """Объект, которому принадлежит чертёж. None — файл не привязан ни к
    одному объекту (наследие или ещё не импортированный)."""
    row = conn.execute(
        "SELECT object_id FROM object_drawings WHERE source_file = ? LIMIT 1", (source_file,)
    ).fetchone()
    return row["object_id"] if row else None


def _guard_source_file(conn, user, source_file: str, key: str, kind: str = "write") -> None:
    """Доступ к операции над чертежом — по объекту этого чертежа.

    Файл без объекта отдаётся только администратору сервиса: раздавать
    безобъектные данные «админам объектов» нельзя — неизвестно, чьи они.
    """
    object_id = _object_for_source_file(conn, source_file)
    if object_id is None:
        if not is_system_admin(user):
            raise HTTPException(
                status_code=403,
                detail=f"Чертёж «{source_file}» не привязан к объекту — операция доступна "
                       f"администратору сервиса",
            )
        return
    assert_object_feature(conn, user, object_id, key, kind)


def _guard_elements(conn, user, element_ids, key: str, kind: str = "write") -> None:
    """Доступ к правке элементов — по ОБЪЕКТАМ, которым они принадлежат.

    До 2026-08-02 эти операции (смена статуса, плановая дата, удаление
    записи истории) закрывала `require_editor`, то есть СИСТЕМНАЯ роль, и
    объект не проверялся вовсе. Замерено на живом сервере: пользователь с
    системной ролью `user` и БЕЗ единого гранта менял статус элемента
    чужого объекта (200), а прораб с грантом `user` НА объекте получал
    403 — то есть проверка была одновременно и дырой, и помехой. Пока
    объект в системе один, это не проявляется; проявится на втором.

    Проверяются ВСЕ объекты пачки, и запрос отклоняется ЦЕЛИКОМ, если хоть
    один чужой: иначе чужие элементы проехали бы под прикрытием своих (тот
    же принцип, что у смешанного запроса цветов зон в этапе C).

    Несуществующие id молча пропускаются — их обработчик отличает сам и
    отвечает 404. Смешивать «нет такого» с «не твоё» нельзя: 403 на
    опечатку в id заставляет искать несуществующую проблему с правами.

    Элемент без объекта (наследие) — только администратору сервиса: раздавать
    данные без владельца «админам объектов» нельзя, неизвестно, чьи они.
    """
    ids = list(element_ids)
    if not ids:
        return
    marks = ",".join("?" * len(ids))
    for row in conn.execute(
        f"SELECT DISTINCT object_id FROM elements WHERE id IN ({marks})", tuple(ids)
    ).fetchall():
        if row["object_id"] is None:
            if not is_system_admin(user):
                raise HTTPException(
                    status_code=403,
                    detail="Элемент не привязан к объекту — операция доступна "
                           "администратору сервиса",
                )
        else:
            assert_object_feature(conn, user, row["object_id"], key, kind)


def _accessible_objects_clause(conn, user, column: str = "object_id") -> tuple:
    """Условие «объект строки доступен этому пользователю» для СПИСОЧНЫХ
    выборок: (фрагмент SQL, параметры). Дополняет WHERE, а не заменяет.

    Нужно там, где эндпоинт не принимает объект параметром и раньше просто
    отдавал всё подряд (справочник элементов, список элементов). Для
    единичной сущности правильнее assert_object_access/_guard_elements —
    они дают внятный 403, а не молча пустой ответ.

    Системный администратор получает `1 = 1`: у него доступ ко всему, и
    подставлять ему список из сотен id незачем. Пустой набор превращается
    в `1 = 0`, а НЕ в отсутствие условия — разница между «доступно всё» и
    «не доступно ничего» здесь ровно та же ловушка, о которой предупреждает
    accessible_object_ids (аудит безопасности 2026-08-03).

    Элементы без объекта (наследие) не видит никто, кроме системного
    администратора: неизвестно, чьи они.

    `column` — чем в этой таблице выражен объект: `object_id` у элементов и
    зон, `id` у самой таблицы objects.
    """
    ids = accessible_object_ids(conn, user)
    if ids is None:
        return "1 = 1", []
    if not ids:
        return "1 = 0", []
    marks = ",".join("?" * len(ids))
    return f"{column} IN ({marks})", list(ids)


def _resolve_selection_item(conn, user, item):
    """Подставляет актуальный чертёж объекта, если клиент прислал object_id,
    и проверяет доступ к тому, что в итоге показывается.

    Точка перевода одна на весь показ схемы (этап B). Если пришло и то и
    другое — побеждает явный source_file: это форма «Версии чертежа
    объекта», где смысл как раз в том, чтобы посмотреть не актуальную
    версию.

    Проверка доступа тоже здесь и по той же причине, по которой здесь
    перевод: это единственное место, через которое проходит ЛЮБОЙ показ
    схемы. До аудита безопасности 2026-08-03 её не было вовсе — `/plan-data`
    закрывался одним `get_current_user`, и любой вошедший получал полный
    слепок чужой стройки (все элементы с геометрией, марками, статусами,
    контрактами и датами), просто назвав чужой `object_id`.

    Порядок: сначала ПРАВА на присланный object_id, только потом перевод в
    чертёж. Обратный порядок отвечал бы «у объекта #2 нет актуального
    чертежа» тому, кому этот объект вообще не положено видеть, — то есть
    подтверждал бы и существование объекта, и его состояние (поймано на
    живой проверке этой же правки)."""
    if item.object_id is not None:
        assert_object_feature(conn, user, item.object_id, "plan", "read")
    if not item.source_file and item.object_id is not None:
        try:
            item = item.model_copy(update={"source_file": object_source_file(conn, item.object_id)})
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    if item.source_file:
        # Явно присланный файл проверяется отдельно: он мог прийти и без
        # object_id (форма «Версии чертежа объекта»), и вместе с чужим.
        _guard_source_file(conn, user, item.source_file, "plan", "read")
    return item


@app.get("/projects", response_model=list[ProjectOut])
def list_projects(user: sqlite3.Row = Depends(get_current_user)):
    """Справочник проектов. Сроки СВОДЯТСЯ из объектов (решение П5), а не
    хранятся: раннее начало и позднее окончание СМР по элементам объектов
    проекта. Так они не могут разойтись с тем, что показывают объекты."""
    conn = get_connection()
    try:
        # Сроки и счётчики сводятся ТОЛЬКО по доступным объектам, а сам
        # проект показывается, лишь если доступен хоть один его объект: иначе
        # справочник раскрывал бы наименования, адреса и сроки всех строек
        # предприятия любому вошедшему (аудит безопасности 2026-08-03).
        доступ, доступ_params = _accessible_objects_clause(conn, user, "o.id")
        agg = {
            r["project_id"]: r
            for r in conn.execute(
                "SELECT o.project_id, COUNT(DISTINCT o.id) AS objects_count, "
                "       COUNT(e.id) AS elements_count, "
                "       MIN(e.project_smr_start_date) AS smr_start, "
                "       MAX(e.project_delivery_date) AS smr_end "
                "FROM objects o LEFT JOIN elements e ON e.object_id = o.id AND e.is_current = 1 "
                f"WHERE {доступ} "
                "GROUP BY o.project_id",
                доступ_params,
            )
        }
        видны_все = accessible_object_ids(conn, user) is None
        out = []
        for row in conn.execute("SELECT * FROM projects ORDER BY name"):
            a = agg.get(row["id"])
            if not видны_все and a is None:
                continue

            out.append(ProjectOut(
                id=row["id"], name=row["name"], address=row["address"],
                description=row["description"],
                objects_count=a["objects_count"] if a else 0,
                elements_count=a["elements_count"] if a else 0,
                smr_start=a["smr_start"] if a else None,
                smr_end=a["smr_end"] if a else None,
            ))
        return out
    finally:
        conn.close()


@app.post("/projects", response_model=ProjectOut)
def create_project(body: ProjectIn, admin: sqlite3.Row = Depends(require_service_feature("projects", "write"))):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Наименование проекта не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM projects WHERE name = ?", (name,)).fetchone():
            raise HTTPException(status_code=409, detail="Проект с таким наименованием уже есть")
        conn.execute("INSERT INTO projects (name, address, description) VALUES (?, ?, ?)",
                     (name, body.address, body.description))
        conn.commit()
        new_id = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()["id"]
    finally:
        conn.close()
    activity.log("project_create", user=admin, entity_type="project", entity_id=new_id, new_value=name)
    return next(p for p in list_projects(admin) if p.id == new_id)


@app.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, body: ProjectIn, admin: sqlite3.Row = Depends(require_service_feature("projects", "write"))):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Наименование проекта не может быть пустым")
    conn = get_connection()
    try:
        row = conn.execute("SELECT name FROM projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Проект не найден")
        if conn.execute("SELECT 1 FROM projects WHERE name = ? AND id <> ?", (name, project_id)).fetchone():
            raise HTTPException(status_code=409, detail="Проект с таким наименованием уже есть")
        conn.execute(
            "UPDATE projects SET name = ?, address = ?, description = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (name, body.address, body.description, project_id),
        )
        conn.commit()
        old = row["name"]
    finally:
        conn.close()
    activity.log("project_rename", user=admin, entity_type="project", entity_id=project_id,
                 old_value=old, new_value=name)
    return next(p for p in list_projects(admin) if p.id == project_id)


@app.delete("/projects/{project_id}")
def delete_project(project_id: int, admin: sqlite3.Row = Depends(require_service_feature("projects", "write"))):
    """Удалять можно только ПУСТОЙ проект. Проект с объектами удалить нельзя
    и каскадом сносить его объекты тем более: за объектом стоят элементы со
    статусами и историей, и «удалил проект — потерял стройку» это ровно тот
    класс необратимых действий, которого в системе быть не должно."""
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Проект не найден")
        n = conn.execute("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", (project_id,)).fetchone()["n"]
        if n:
            raise HTTPException(
                status_code=409,
                detail=f"В проекте {n} объект(ов) — сначала перенесите их в другой проект",
            )
        # Вложения — руками: внешнего ключа на три разные таблицы-владельца
        # не выразить (см. app/attachments.py), поэтому каскад держится тем,
        # что каждое место удаления владельца зовёт эту функцию.
        delete_attachments_for(conn, "project", project_id)
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
    finally:
        conn.close()
    activity.log("project_delete", user=admin, entity_type="project", entity_id=project_id)
    return {"deleted": project_id}


@app.get("/objects/{object_id}/drawings")
def list_object_drawings(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Версии чертежа объекта, новые сверху (этап B).

    Заменяет прежний список «какие файлы показать»: с этапа B на схеме
    всегда один объект, а выбирать можно только ВЕРСИЮ его чертежа — и это
    редкое действие «посмотреть, как было», а не повседневная настройка.

    Счётчик элементов на версию — по source_file, БЕЗ фильтра видимости:
    у неактуальных версий все элементы is_current=0, и с фильтром список
    показывал бы нули у всего, кроме текущей, что читается как «данные
    потерялись».
    """
    conn = get_connection()
    try:
        # Объект здесь приходит путём, а не query, поэтому зависимость
        # require_object_access не подходит (она читает query) — проверка
        # той же функцией внутри. Она же различает 404 и 403 (аудит
        # безопасности 2026-08-03: раньше проверялось только существование).
        assert_object_feature(conn, user, object_id, "drawings", "read")
        counts = {
            r["source_file"]: r["n"]
            for r in conn.execute(
                "SELECT source_file, COUNT(*) AS n FROM elements GROUP BY source_file"
            )
        }
        return [
            {"source_file": r["source_file"], "is_current": bool(r["is_current"]),
             "imported_at": r["imported_at"], "elements": counts.get(r["source_file"], 0)}
            for r in conn.execute(
                "SELECT source_file, is_current, imported_at FROM object_drawings "
                "WHERE object_id = ? ORDER BY is_current DESC, imported_at DESC",
                (object_id,),
            )
        ]
    finally:
        conn.close()


@app.get("/projects-tree")
def get_projects_tree(user: sqlite3.Row = Depends(get_current_user)):
    """Проекты со своими объектами — источник для переключателя в тулбаре
    (этап B). Доступно всем ролям: это навигация, а не правка.

    Отбор недоступных объектов — ЗДЕСЬ, в одном месте, а не в каждом из 22
    эндпоинтов (этап C).

    У каждого объекта отдаётся ещё и `role` — действующая роль
    пользователя ИМЕННО НА НЁМ. Интерфейс гасит по ней пункты меню:
    роль — свойство гранта, а не пользователя (решение П2), поэтому
    системная роль для этого не годится. Отдаётся тем же запросом, что и
    само дерево: это ровно тот момент, когда клиент узнаёт про объекты, и
    заводить ради роли отдельный эндпоинт значило бы разослать два запроса
    туда, где хватает одного.
    """
    conn = get_connection()
    try:
        роли = object_roles(conn, user)
        дерево = projects_tree(conn, accessible_object_ids(conn, user))
        for проект in дерево:
            for объект in проект["objects"]:
                # СПИСОК ролей, а не одна: с 2026-08-14 их может быть
                # несколько, и разрешения складываются.
                объект["roles"] = sorted(роли.get(объект["id"], set()))
        return {"projects": дерево,
                "last_object_id": user["last_object_id"] if "last_object_id" in user.keys() else None}
    finally:
        conn.close()


class LastObjectIn(BaseModel):
    object_id: Optional[int] = None


@app.put("/me/last-object")
def set_last_object(body: LastObjectIn, user: sqlite3.Row = Depends(get_current_user)):
    """Запоминает выбранный объект ЗА ПОЛЬЗОВАТЕЛЕМ, а не в localStorage:
    человек садится за другой компьютер и должен попасть туда же, где
    работал."""
    conn = get_connection()
    try:
        if body.object_id is not None:
            # Проверяется ДОСТУП, а не только существование: запоминать за
            # пользователем чужой объект незачем, а ответ «такого объекта
            # нет» против «есть, но не твой» — уже подсказка (аудит
            # безопасности 2026-08-03).
            #
            # Именно доступ к ОБЪЕКТУ, а не раздел «Схема»: на объекте МФР
            # схемы по чертежу нет вовсе (app/features.py), и проверка по
            # ней отвечала 403 на попытку запомнить такой объект — человек
            # каждый раз возвращался на чужое здание после перезагрузки.
            assert_object_access(conn, user, body.object_id)
        conn.execute("UPDATE users SET last_object_id = ? WHERE id = ?", (body.object_id, user["id"]))
        conn.commit()
        activity.log("last_object", user=user, entity_type="object", entity_id=body.object_id,
                     new_value=str(body.object_id))
    finally:
        conn.close()
    return {"last_object_id": body.object_id}


@app.get("/objects", response_model=list[ObjectOut])
def list_objects(user: sqlite3.Row = Depends(get_current_user)):
    """Объекты со счётчиками элементов. Доступно всем ролям (только чтение) —
    как и остальные справочники-просмотры."""
    conn = get_connection()
    try:
        projects = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM projects")}
        # Раньше отдавались ВСЕ объекты всем вошедшим — это и был готовый
        # «каталог целей» для перебора id в /plan-data и отчётах: имена,
        # адреса, счётчики и имена файлов чертежей (аудит безопасности
        # 2026-08-03). Отбор тот же, что у /projects-tree.
        доступ, доступ_params = _accessible_objects_clause(conn, user, "id")
        result = []
        for row in conn.execute(
            f"SELECT * FROM objects WHERE {доступ} ORDER BY id", доступ_params
        ):
            drawings = conn.execute(
                "SELECT source_file, is_current FROM object_drawings "
                "WHERE object_id = ? ORDER BY imported_at",
                (row["id"],),
            ).fetchall()
            counts = conn.execute(
                "SELECT SUM(is_current = 1) AS cur, SUM(is_current = 0) AS gone "
                "FROM elements WHERE object_id = ?",
                (row["id"],),
            ).fetchone()
            current = next((d["source_file"] for d in drawings if d["is_current"]), None)
            result.append(ObjectOut(
                id=row["id"], name=row["name"], description=row["description"],
                kind=(row["kind"] if "kind" in row.keys() and row["kind"] else KIND_ZHBI),
                address=row["address"] if "address" in row.keys() else None,
                project_id=row["project_id"] if "project_id" in row.keys() else None,
                project_name=projects.get(row["project_id"] if "project_id" in row.keys() else None),
                current_source_file=current,
                drawings=[d["source_file"] for d in drawings],
                elements_current=counts["cur"] or 0,
                elements_retired=counts["gone"] or 0,
            ))
        return result
    finally:
        conn.close()


def _valid_kind(value) -> str:
    """Тип объекта из запроса. Неизвестное значение — отказ, а не тихий
    'zhbi': опечатка в типе меняет СОСТАВ разделов объекта, и заметить её
    потом можно только по пропавшему меню."""
    if value in (None, ""):
        return KIND_ZHBI
    if value not in KINDS:
        raise HTTPException(
            status_code=400,
            detail="Тип объекта бывает %s" % ", ".join(
                "%s (%s)" % (k, KIND_LABELS[k]) for k in KINDS))
    return value


class ObjectCreateIn(BaseModel):
    name: str
    project_id: int
    address: Optional[str] = None
    description: Optional[str] = None
    # Тип объекта: 'zhbi' (по умолчанию) или 'mfr'. От него зависит
    # состав разделов — см. app/features.py.
    kind: Optional[str] = None


@app.post("/objects", response_model=ObjectOut)
def create_object(body: ObjectCreateIn, admin: sqlite3.Row = Depends(require_service_feature("projects", "write"))):
    """Завести объект ЗАРАНЕЕ, до загрузки чертежа.

    Раньше объект появлялся только сам, при первом импорте, и создание было
    намеренно не поддержано. С появлением проектов это перестало работать:
    новое здание надо сначала положить в нужный проект, а импорт выбирал
    объект за пользователя. Объект без чертежа — законное состояние: он
    показывается пустым, и чертёж в него загружают отдельно (форма
    «Загрузить чертёж» спрашивает, в какой объект).

    Проект обязателен: объект без проекта недостижим ни через один селектор
    и исчезает с глаз вместе со всеми своими элементами.
    """
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Наименование объекта не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM projects WHERE id = ?", (body.project_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Проект не найден")
        if conn.execute("SELECT 1 FROM objects WHERE name = ?", (name,)).fetchone():
            raise HTTPException(status_code=409, detail="Объект с таким наименованием уже есть")
        conn.execute(
            "INSERT INTO objects (name, address, description, project_id, kind) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, body.address, body.description, body.project_id,
             _valid_kind(body.kind)),
        )
        conn.commit()
        new_id = conn.execute("SELECT id FROM objects WHERE name = ?", (name,)).fetchone()["id"]
    finally:
        conn.close()
    activity.log("object_create", user=admin, entity_type="object", entity_id=new_id, new_value=name)
    return next(o for o in list_objects(admin) if o.id == new_id)


@app.patch("/objects/{object_id}", response_model=ObjectOut)
def update_object(object_id: int, body: ObjectPatchIn, admin: sqlite3.Row = Depends(require_service_feature("projects", "write"))):
    """Переименование объекта. Создание и удаление намеренно НЕ поддержаны:
    объект появляется сам при первом импорте чертежа, а удаление отвязало бы
    все элементы с их историей — операция, которую пользователь отдельно
    признал ненужной."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Наименование объекта не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        clash = conn.execute(
            "SELECT 1 FROM objects WHERE name = ? AND id <> ?", (name, object_id)
        ).fetchone()
        if clash:
            raise HTTPException(status_code=409, detail="Объект с таким наименованием уже есть")
        old = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()["name"]
        if body.project_id is not None:
            if conn.execute("SELECT 1 FROM projects WHERE id = ?", (body.project_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Проект не найден")
            conn.execute("UPDATE objects SET project_id = ? WHERE id = ?", (body.project_id, object_id))
        # Тип меняется, только если он ЯВНО прислан: форма, не знающая о
        # поле, не должна молча переводить объект в другой тип учёта.
        if body.kind is not None:
            conn.execute("UPDATE objects SET kind = ? WHERE id = ?",
                         (_valid_kind(body.kind), object_id))
        conn.execute(
            "UPDATE objects SET name = ?, address = ?, description = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (name, body.address, body.description, object_id),
        )
        conn.commit()
    finally:
        conn.close()
    activity.log(
        "object_rename", user=admin, entity_type="object", entity_id=object_id,
        old_value=old, new_value=name,
    )
    return next(o for o in list_objects(admin) if o.id == object_id)


def _subtypes_object(conn, object_id: Optional[int]) -> int:
    """Объект, чей справочник подтипов открыт. Справочник объектный с
    2026-08-21, и объект здесь ОБЯЗАТЕЛЕН: «подтипы вообще», без здания, —
    это ровно та общая куча отметок, от которой уходили. Пусто приходит
    только от старого клиента, не перезагрузившего страницу после
    обновления, — отвечаем внятно, а не пустым списком."""
    if object_id is None:
        raise HTTPException(
            status_code=400,
            detail="Справочник подтипов свой у каждого объекта — выберите объект в тулбаре")
    if conn.execute("SELECT id FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Объект не найден")
    return object_id


@app.get("/allowed-subtypes")
def get_allowed_subtypes(object_id: Optional[int] = None,
                         user: sqlite3.Row = Depends(get_current_user)):
    """Справочник подтипов ОДНОГО объекта по новому стандарту имён слоёв
    (см. Docs/backlog.md). Наполняется сам при загрузке чертежа
    (app/dxf_import.py), правится через «Действия → Справочники → Типы и
    подтипы элементов»; в код разбора сознательно не зашит
    (scripts/layer_naming.py принимает его параметром).

    У нового объекта справочник ПУСТ — это норма, а не сбой: подтипы
    появятся с первым же чертежом."""
    conn = get_connection()
    try:
        object_id = _subtypes_object(conn, object_id)
        rows = conn.execute(
            "SELECT element_type, subtype FROM allowed_subtypes WHERE object_id = ? "
            "ORDER BY element_type, subtype", (object_id,)
        ).fetchall()
        result = {t: [] for t in ZHBI_ELEMENT_TYPES}
        for r in rows:
            result.setdefault(r["element_type"], []).append(r["subtype"])
        return result
    finally:
        conn.close()


@app.post("/allowed-subtypes")
def add_allowed_subtype(body: AllowedSubtypeIn, user: sqlite3.Row = Depends(require_service_feature("dict_subtypes", "write"))):
    if body.element_type not in ZHBI_ELEMENT_TYPES:
        raise HTTPException(status_code=422, detail=f"Неизвестный тип элемента: {body.element_type}")
    if not body.subtype.strip():
        raise HTTPException(status_code=422, detail="Подтип не может быть пустым")
    conn = get_connection()
    try:
        object_id = _subtypes_object(conn, body.object_id)
        conn.execute(
            "INSERT OR IGNORE INTO allowed_subtypes (object_id, element_type, subtype) "
            "VALUES (?, ?, ?)",
            (object_id, body.element_type, body.subtype.strip()),
        )
        conn.commit()
    finally:
        conn.close()
    activity.log("subtype_add", user=user, element_type=body.element_type,
                 entity_type="object", entity_id=object_id,
                 new_value=body.subtype.strip())
    return {"status": "ok"}


@app.delete("/allowed-subtypes/{element_type}/{subtype}")
def delete_allowed_subtype(element_type: str, subtype: str, object_id: Optional[int] = None,
                           user: sqlite3.Row = Depends(require_service_feature("dict_subtypes", "write"))):
    conn = get_connection()
    try:
        object_id = _subtypes_object(conn, object_id)
        conn.execute(
            "DELETE FROM allowed_subtypes WHERE object_id = ? AND element_type = ? AND subtype = ?",
            (object_id, element_type, subtype)
        )
        conn.commit()
    finally:
        conn.close()
    activity.log("subtype_delete", user=user, element_type=element_type,
                 entity_type="object", entity_id=object_id, old_value=subtype)
    return {"status": "ok"}


@app.get("/axis-grid")
def axis_grid(source_file: str = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _guard_source_file(conn, user, source_file, "plan", "read")
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
        _guard_source_file(conn, user, source_file, "plan", "read")
        rows = conn.execute(
            f"SELECT layer, COUNT(*) as n FROM elements WHERE source_file = ? "
            f"AND {visible_elements_clause()} GROUP BY layer ORDER BY layer",
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
        # Объект показа (этап D): по нему читаются подписи, цвета зон и
        # контракты по умолчанию. Схема показывает ОДИН объект (этап B),
        # поэтому берётся объект ПЕРВОГО элемента выборки — второго быть не
        # должно. Файл может быть и не привязан к объекту (наследие) —
        # тогда объектных настроек нет и читать нечего.
        plan_object_id = None
        _current_files = {
            r["source_file"]
            for r in conn.execute("SELECT source_file FROM object_drawings WHERE is_current = 1")
        }
        for item in body.selection:
            # Этап B: клиент выбирает ОБЪЕКТ, файл выводит сервер. Явно
            # переданный source_file уважается — им пользуется форма
            # «Версии чертежа объекта», чтобы показать НЕ актуальную версию.
            item = _resolve_selection_item(conn, user, item)
            item_object_id = item.object_id or _object_for_source_file(conn, item.source_file)
            if plan_object_id is None:
                plan_object_id = item_object_id
            # Условие видимости (is_current = 1) прячет элементы, ИСЧЕЗНУВШИЕ
            # из актуального чертежа. При просмотре ПРОШЛОЙ версии оно
            # обессмысливает саму функцию: у элементов старой версии
            # is_current=0 поголовно, и схема выходила пустой (поймано живой
            # проверкой). Для явно запрошенной неактуальной версии фильтр
            # снимается — это режим «посмотреть, как было», только чтение.
            видимость = ("1 = 1" if item.source_file and item.source_file not in _current_files
                         else visible_elements_clause())
            # item.layers может быть: None ("все слои файла"), непустым
            # списком (конкретные слои) или ПУСТЫМ списком (пользователь
            # снял все галочки — ни одного элемента, но оси/зоны файла
            # остаются). "if item.layers:" здесь был бы багом: пустой
            # список — falsy в Python, и такая проверка неотличима от
            # None, из-за чего "снять все галочки" молча показывало ВСЕ
            # элементы вместо ни одного (см. Docs/backlog.md).
            if item.layers is None:
                q = f"SELECT * FROM elements WHERE source_file = ? AND {видимость} ORDER BY id"
                params = (item.source_file,)
                rows = conn.execute(q, params).fetchall()
            elif item.layers:
                placeholders = ",".join("?" * len(item.layers))
                q = (f"SELECT * FROM elements WHERE source_file = ? AND layer IN ({placeholders}) "
                     f"AND {видимость} ORDER BY id")
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
            #
            # Геометрия зоны с этапа 2 живёт в zone_levels — по одной строке
            # на ЯРУС внутри одной записи справочника (решение З7). Здесь
            # отдаётся по одному элементу списка на ярус, и `id` во всех
            # ярусах одной зоны ОДИНАКОВ — это id записи справочника, тот
            # самый, на который ссылаются elements.zone_*_id. Так фронтенд
            # (подписи, цвет крана, склейка стоянок в один пункт фильтра)
            # продолжает работать без переделки, а идентичность зоны стала
            # честной: раньше «Стоянка 01» на четырёх ярусах была четырьмя
            # разными зонами с разными id.
            #
            # Вторая половина запроса (зоны устаревших версий чертежа, что
            # остались строками старой формы с геометрией в
            # zones.outline_json) убрана 2026-07-31 вместе с самими такими
            # зонами — их удалила чистка дообъектного наследия
            # (app/db._purge_legacy_elements), и появиться заново они не
            # могут: импорт всегда заводит зону записью справочника.
            file_zones = []
            for r in conn.execute(
                "SELECT z.id, z.category, z.name, z.number, z.match_status, z.parent_zone_id, "
                "z.parent_match_status, l.id AS level_id, l.elevation_mm, l.outline_json "
                "FROM zones z JOIN zone_levels l ON l.zone_id = z.id "
                "WHERE l.source_file = ? AND z.is_current = 1",
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
            # Цвет крана ключуется ОБЪЕКТОМ (этап D), не файлом: при выдаче
            # новой версии чертежа настроенная раскраска раньше пропадала —
            # запись оставалась за старым именем файла.
            crane_colors_by_name = {
                r["name"]: r["color"]
                for r in conn.execute(
                    "SELECT name, color FROM zone_colors WHERE object_id = ? AND category = 'Кран'",
                    (item_object_id,),
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
        label_rows = conn.execute(
            "SELECT element_type, visible, dates_visible FROM label_visibility WHERE object_id = ?",
            (plan_object_id,),
        ).fetchall()
        label_visibility = {r["element_type"]: bool(r["visible"]) for r in label_rows}
        label_dates_visibility = {r["element_type"]: bool(r["dates_visible"]) for r in label_rows}
        # is_archived отдаётся, а сами архивные контракты НЕ отсеиваются
        # здесь (2026-08-10): подпись контракта резолвится по этому же
        # списку, и выброшенный архивный превратил бы историческую привязку
        # изделия в «контракт #17». Прячет их клиент — в дашборде АРМ, в
        # фильтрах и в списках выбора (см. app.js).
        contract_rows = conn.execute(
            """
            SELECT co.id AS id, co.theme AS theme, co.is_archived AS is_archived,
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
                "is_archived": bool(r["is_archived"]),
                "element_types": types_by_contract.get(r["id"], []),
            }
            for r in contract_rows
        ]
        default_contracts = {
            r["element_type"]: r["contract_id"]
            for r in conn.execute(
                "SELECT element_type, contract_id FROM default_contracts WHERE object_id = ?",
                (plan_object_id,),
            ).fetchall()
        }
        # «Законтрактовано» для АРМ комплектовщика (2026-08-10): позиции
        # контрактов ОБЪЕКТА, свёрнутые по тройке (контракт, тип элемента,
        # марка). Тип и марка — единственные свойства изделия, какие у
        # позиции контракта есть (ни крана, ни этажа, ни подтипа у неё нет);
        # контракт добавлен в ключ 2026-08-10 вместе с областью «Контракты»:
        # из этих же строк дашборд считает и «всего по контракту», и
        # «законтрактовано по марке» — второй выборки для этого не нужно.
        # Строк здесь столько же, сколько позиций у контрактов объекта
        # (сотни), — свёртка сделана ради устойчивого формата, а не
        # экономии.
        contract_line_totals = [
            {
                "contract_id": r["contract_id"], "element_type": r["element_type"],
                "mark": r["mark"], "quantity": r["quantity"],
            }
            for r in conn.execute(
                """
                SELECT cl.contract_id AS contract_id, cl.element_type AS element_type,
                       cl.mark AS mark, SUM(cl.quantity) AS quantity
                FROM contract_lines cl
                JOIN contracts co ON co.id = cl.contract_id
                JOIN specifications s ON s.id = co.specification_id
                JOIN agreements a ON a.id = s.agreement_id
                WHERE a.object_id IS ? AND co.is_archived = 0
                GROUP BY cl.contract_id, cl.element_type, cl.mark
                """,
                (plan_object_id,),
            ).fetchall()
        ]
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
        "contract_line_totals": contract_line_totals,
        "element_shapes": element_shapes,
        "zones": zones,
    }


@app.post("/export.xlsx")
def export_xlsx(body: ExportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    if body.mode not in ("snapshot", "history"):
        raise HTTPException(status_code=422, detail="mode должен быть 'snapshot' или 'history'")
    conn = get_connection()
    try:
        # Выгрузка чужого объекта одним файлом — то же по последствиям, что
        # и чтение через отчёт, а в режиме history сюда попадает вся
        # `status_history` с ФИО исполнителей (аудит безопасности 2026-08-03).
        if body.source_file:
            _guard_source_file(conn, user, body.source_file, "export", "read")
        elif body.element_ids:
            _guard_elements(conn, user, body.element_ids, "export", "read")
        elif not is_system_admin(user):
            raise HTTPException(
                status_code=400,
                detail="Укажите чертёж или набор элементов: иначе выгрузка охватила бы все объекты",
            )
        if body.mode == "snapshot":
            content = build_snapshot_xlsx(conn, body.source_file, body.date, body.element_ids)
            name = f"elements_snapshot{'_' + body.date if body.date else ''}.xlsx"
        else:
            content = build_history_xlsx(conn, body.source_file, body.date_from, body.date_to, body.element_ids)
            name = "elements_history.xlsx"
    finally:
        conn.close()


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
        _guard_source_file(conn, user, source_file, "export", "read")
        try:
            content = build_schema_pdf(conn, source_file, date, format_display_name(user),
                                       _object_for_source_file(conn, source_file))
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
    finally:
        conn.close()


    name = f"otchet_{source_file}{'_' + date if date else ''}.pdf".replace("/", "_")
    headers = {
        "Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(name)}"
    }
    return Response(content=content, media_type="application/pdf", headers=headers)


@app.post("/import-dxf", response_model=DxfImportResult)
def import_dxf(
    file: UploadFile = File(...),
    source_file: Optional[str] = Form(None),
    # ТОЛЬКО админ (решение пользователя 2026-07-29: "загрузка любых данных
    # доступна только администраторам"). Раньше здесь был require_editor,
    # то есть чертёж мог загрузить и прораб (роль user).
    #
    # Проверка именно здесь, на сервере, а не только скрытием пункта меню:
    # спрятанная кнопка — не защита, запрос к /import-dxf можно отправить
    # и без неё. Загрузка чертежа перезаписывает геометрию всех элементов
    # файла, то есть по последствиям это операция уровня админа.
    user: sqlite3.Row = Depends(require_service_feature("drawings", "write")),
):
    # Копию снимает сам process_upload — ПОСЛЕ разбора и сверки, до первой
    # записи (см. его docstring). Здесь её брать нельзя: этот путь
    # отказывает на «в базе несколько объектов», и копия оставалась бы от
    # загрузки, которая не произошла.
    try:
        result = import_dxf_file(file, source_file, UPLOADS_DIR)
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    except ValueError as e:
        # Объект не определился (element_sync.resolve_import_object). Это
        # отказ ЗАПРОСА, а не сбой сервера: до 2026-08-21 исключение уходило
        # наверх, и пользователь получал 500 «Внутренняя ошибка сервера» без
        # единой подсказки, что делать. У ЭТОГО эндпоинта параметра объекта
        # нет и не будет — он неинтерактивный, поэтому подсказка отправляет
        # в форму, где объект спрашивают.
        raise HTTPException(
            status_code=400,
            detail=f"{e} Загрузите чертёж формой «Действия → Обмен данными → "
                   f"Загрузить чертёж» — она выбирает объект первым шагом.")
    # Одношаговый путь (без диалога сверки) тоже журналируется — иначе в
    # журнале была бы видна только загрузка через новую двухфазную форму.
    activity.log(
        "import_dxf", user=user, entity_type="object", entity_id=result.object_id,
        new_value=result.source_file,
        details={
            "summary": (
                f"по handle {result.matched_by_handle}, по геометрии "
                f"{result.matched_by_geometry}, новых {result.inserted}, "
                f"исчезло {result.retired}"
            ),
            "one_shot": True,
        },
    )
    return result


@app.post("/import-dxf/analyze", response_model=DxfAnalyzeResult)
def analyze_dxf(
    file: UploadFile = File(...),
    source_file: Optional[str] = Form(None),
    # В КАКОЙ объект грузим. Пусто — прежнее поведение (сервер выбирает сам
    # по имени файла и истории загрузок): нужно, пока в системе один объект
    # и спрашивать не о чем.
    object_id: Optional[int] = Form(None),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Фаза 1 импорта (решение И3): что изменится, если применить чертёж.
    В БД к моменту ответа ничего не записано, кроме заведения самого
    Объекта на первой в жизни установке — сверять иначе было бы не с чем."""
    # Куда грузим — решает доступ. Если объект назван явно, нужна роль
    # администратора НА НЁМ; если не назван, объект выберет (или заведёт)
    # сервер, а заводить объекты может только администратор сервиса.
    conn = get_connection()
    try:
        if object_id is None:
            if not is_system_admin(user):
                raise HTTPException(
                    status_code=403,
                    detail="Выберите объект, в который загружается чертёж: заводить новые "
                           "объекты может только администратор сервиса",
                )
        else:
            assert_object_feature(conn, user, object_id, "drawings", "write")
    finally:
        conn.close()
    try:
        saved_path = save_uploaded_file(file, UPLOADS_DIR)
        name = source_file or saved_path.name
        # object_id уходит и в РАЗБОР: справочник подтипов принадлежит
        # объекту (2026-08-21), и разбирать имена слоёв надо по набору
        # ИМЕННО этого здания. Пусто — первая в жизни установка, где объекта
        # ещё нет: справочник тогда пуст, и все подтипы файла новые.
        parsed = parse_drawing(saved_path, name, object_id)
        analysis = analyze_drawing(parsed, object_id)
        token = remember_pending(parsed, analysis)
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return DxfAnalyzeResult(
        token=token,
        source_file=name,
        object_id=analysis["object_id"],
        object_name=analysis["object_name"],
        previous_source_file=analysis["previous_source_file"],
        counts=analysis["counts"],
        details=analysis["details"],
        detail_limit=analysis["detail_limit"],
        zones=analysis["zones"],
        axis_grid=analysis["axis_grid"],
        by_mark_source=analysis["by_mark_source"],
        by_axis_status=analysis["by_axis_status"],
    )


@app.post("/import-dxf/apply", response_model=DxfImportResult)
def apply_dxf(body: DxfApplyIn, user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 2: применяет уже показанную пользователю сводку."""
    try:
        parsed, analysis = get_pending(body.token)
        # Объект уже выбран на фазе анализа и лежит в токене — проверяем ЕГО,
        # а не то, что мог бы прислать клиент: иначе подменой токена чужой
        # чертёж применился бы в доступный объект.
        conn = get_connection()
        try:
            assert_object_feature(conn, user, analysis["object_id"], "drawings", "write")
        finally:
            conn.close()
        # Копия базы — здесь, на ФАЗЕ ПРИМЕНЕНИЯ, и после проверки доступа:
        # фаза анализа не пишет ничего, и снимать копию под каждый
        # «посмотреть, что изменится» значило бы забивать очередь копий
        # отменёнными загрузками.
        backup_before_import(
            f"чертёж {parsed.source_file} → {analysis['object_name']}",
            audit_display_name(user), user["id"])
        # Метка операции — общая у сводного события ниже и у поэлементных
        # событий внутри apply_import (изменившиеся изделия).
        операция = activity.new_request_id()
        result = apply_drawing(
            parsed, analysis,
            accept_mark_changes=body.accept_mark_changes,
            keep_mark_element_ids=body.keep_mark_element_ids,
            refill_manual_fields=body.refill_manual_fields,
            create_new_zone_ids=body.create_new_zone_ids,
            user=user, request_id=операция,
        )
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    forget_pending(body.token)

    counts = analysis["counts"]
    activity.log(
        "import_dxf",
        user=user,
        request_id=операция,
        entity_type="object",
        entity_id=result.object_id,
        old_value=analysis["previous_source_file"],
        new_value=result.source_file,
        details={
            "summary": summary_for_log(counts),
            "counts": counts,
            "accept_mark_changes": body.accept_mark_changes,
            "marks_kept": result.marks_kept,
            "manual_kept": result.manual_kept,
            "refilled_manual": {k: v for k, v in body.refill_manual_fields.items() if v},
            "new_zone_records": body.create_new_zone_ids,
        },
    )
    return result


@app.get("/revit-plan/filters")
def revit_plan_filters(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Что есть у объекта из модели: этажи, секции, разделы, категории."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        return revit_plan.filters(conn, object_id)
    finally:
        conn.close()


@app.get("/revit-plan/elements")
def revit_plan_elements(
    object_id: int,
    # Наборы, а не одиночные значения: отбор множественный (несколько
    # этажей, несколько категорий). Пустой набор = отбор снят.
    level_id: Optional[list[int]] = Query(None),
    section_id: Optional[list[int]] = Query(None),
    part: Optional[list[str]] = Query(None),
    category: Optional[list[str]] = Query(None),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Контуры модели для плана. Показ обычно по этажам: в объекте под
    тридцать тысяч элементов, и самый осмысленный разрез — этаж."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        return revit_plan.elements(conn, object_id, level_ids=level_id,
                                   section_ids=section_id, parts=part,
                                   categories=category)
    finally:
        conn.close()


@app.get("/revit-plan/colors")
def revit_plan_colors(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Цветовая схема объекта плюс перечень шаблонов."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        данные = revit_colors.scheme(conn, object_id)
    finally:
        conn.close()
    данные["presets"] = revit_colors.presets_for_client()
    данные["fallback"] = revit_colors.FALLBACK
    return данные


class RevitColorsIn(BaseModel):
    preset: str = "custom"
    colors: dict = {}
    opacity: dict = {}
    glow: dict = {}


@app.put("/revit-plan/colors")
def revit_plan_colors_save(object_id: int, body: RevitColorsIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "write")
        данные = revit_colors.save(conn, object_id, body.preset, body.colors,
                                   body.opacity, body.glow)
    finally:
        conn.close()
    activity.log("revit_colors", user=user, entity_type="object", entity_id=object_id,
                 new_value=данные["preset"], details={"цветов": len(данные["colors"])})
    return данные


@app.get("/revit-plan/element")
def revit_plan_element(object_id: int, element_id: int,
                       user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        data = revit_plan.card(conn, object_id, element_id)
    finally:
        conn.close()
    if data is None:
        raise HTTPException(status_code=404, detail="Элемент не найден")
    return data


@app.post("/import-revit/analyze", response_model=RevitAnalyzeResult)
def analyze_revit(
    files: list[UploadFile] = File(...),
    object_id: int = Form(...),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Фаза 1 загрузки пакетов Revit: что появится в справочниках объекта.

    Объект спрашивается ЯВНО, без догадок по имени файла: имена моделей у
    заказчика меняются между выдачами (Docs/revit-import.md, раздел 1), и
    угадывать по ним объект — верный способ загрузить чужое здание.
    """
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_import", "write")
        uploads = [(f.filename or "пакет", read_upload_limited(f.file)) for f in files]
        try:
            packages = revit_import.parse_uploads(uploads)
            analysis = revit_import.analyze(conn, object_id, packages)
        except revit_import.RevitProcessingError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()

    token = revit_import.remember_pending(packages, analysis)
    return RevitAnalyzeResult(
        token=token,
        object_id=object_id,
        object_name=analysis["object_name"],
        packages=analysis["packages"],
        known_sections=analysis["known_sections"],
        sections=analysis["sections"],
        levels={k: v for k, v in analysis["levels"].items()},
        # Только то, что показывает сводка. `retired_uids` намеренно не
        # отдаётся: на большой модели это список из тысяч строк, который
        # клиенту не нужен — списание считает сервер по токену.
        elements={k: v for k, v in analysis["elements"].items()
                  if k in ("counts", "preview", "by_section", "changes")},
        warnings=analysis["warnings"],
    )


@app.post("/import-revit/apply", response_model=RevitImportResult)
def apply_revit(body: RevitApplyIn, user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 2: применяет уже показанную сводку."""
    try:
        packages, analysis = revit_import.get_pending(body.token)
    except revit_import.RevitProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    object_id = analysis["object_id"]
    conn = get_connection()
    try:
        # Объект берётся ИЗ ТОКЕНА, а не от клиента: иначе подменой токена
        # чужой комплект применился бы в доступный объект.
        assert_object_feature(conn, user, object_id, "revit_import", "write")
    finally:
        conn.close()

    backup_before_import(
        "выгрузка Revit (%s) → %s"
        % (", ".join(p.section_code for p in packages), analysis["object_name"]),
        audit_display_name(user), user["id"])

    операция = activity.new_request_id()
    conn = get_connection()
    try:
        result = revit_import.apply(conn, object_id, packages, analysis)
    finally:
        conn.close()
    revit_import.forget_pending(body.token)

    activity.log(
        "import_revit",
        user=user,
        request_id=операция,
        entity_type="object",
        entity_id=object_id,
        new_value=", ".join(p.section_code for p in packages),
        details={
            "summary": revit_import.summary_for_log(analysis),
            "packages": analysis["packages"],
            "sections_added": result["sections_added"],
            "levels_added": result["levels_added"],
            "elements": result["elements"],
            "retired": result["retired"],
            "warnings": analysis["warnings"],
        },
    )
    return RevitImportResult(object_id=object_id, **result)


@app.post("/import-pdf/analyze/start")
def start_analyze_pdf(
    file: UploadFile = File(...),
    object_id: int = Form(...),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Фаза 1 загрузки помещений из PDF, шаг 1: запускает разбор в фоновом
    потоке (~30с на реальном комплекте) и сразу отдаёт идентификатор задачи
    — прогресс дальше опрашивается `/import-pdf/analyze/progress/{job_id}`
    (2026-08-31, запрос пользователя «сколько ещё ждать»). В БД не пишет
    ничего — даже справочники секций/этажей."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "pdf_import", "write")
        data = read_upload_limited(file.file)
    finally:
        conn.close()

    job_id = pdf_import.start_analyze_job(object_id, data, file.filename)
    return {"job_id": job_id}


@app.get("/import-pdf/analyze/progress/{job_id}")
def analyze_pdf_progress(job_id: str, user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 1, шаг 2: состояние фоновой задачи разбора. `status` —
    running/done/error; при `done` в `result` та же сводка, что раньше
    отдавал синхронный `/import-pdf/analyze` целиком. При `running`:
    `page_number` — номер листа PDF, который сейчас разбирается (может
    быть больше `total` — это номер в самом файле, не счётчик), `page`/
    `total` — счётчик и общее число УЖЕ уникальных листов, которые
    участвуют в разборе (страниц в файле обычно больше — легенды, разрезы,
    фасады в счётчик не входят, см. `pdf_rooms.parse_document`)."""
    try:
        job = pdf_import.get_job(job_id)
    except pdf_import.PdfImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    if job["status"] == "error":
        raise HTTPException(status_code=job.get("error_status", 422), detail=job["error"])
    if job["status"] == "done":
        return {"status": "done", "result": job["result"]}
    return {
        "status": "running",
        "stage": job["stage"],
        "page_number": job["page_number"],
        "page": job["page"],
        "total": job["total"],
    }


class PdfApplyIn(BaseModel):
    token: str


@app.post("/import-pdf/apply")
def apply_pdf(body: PdfApplyIn, user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 2: применяет уже показанную сводку."""
    try:
        analysis = pdf_import.get_pending(body.token)
    except pdf_import.PdfImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    object_id = analysis["object_id"]
    conn = get_connection()
    try:
        # Объект — из токена, не от клиента: та же причина, что у Revit.
        assert_object_feature(conn, user, object_id, "pdf_import", "write")
    finally:
        conn.close()

    backup_before_import(
        "помещения из PDF → %s" % analysis["object_name"],
        audit_display_name(user), user["id"])

    операция = activity.new_request_id()
    conn = get_connection()
    try:
        result = pdf_import.apply(conn, object_id, analysis)
    finally:
        conn.close()
    pdf_import.forget_pending(body.token)

    activity.log(
        "import_pdf",
        user=user,
        request_id=операция,
        entity_type="object",
        entity_id=object_id,
        new_value=str(analysis["total_rooms"]),
        details={
            "помещений": result["rooms_written"],
            "стен_и_перегородок": result["walls_written"],
            "окон": result["windows_written"],
            "плит": result["slabs_written"],
            "списано": result["retired"],
            "секция_известна": result["with_known_section"],
            "секция_не_определена": result["section_unknown"],
            "предупреждения": analysis["warnings"],
        },
    )
    return {"object_id": object_id, **result}


@app.post("/import-pdf-facade/analyze")
def analyze_pdf_facade(
    file: UploadFile = File(...),
    object_id: int = Form(...),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Упрощённая загрузка — «только фасады» (Docs/TZ.md §3а, Docs/
    backlog.md 2026-09-01): блоки (этаж×секция) напрямую из фасадных
    чертежей, без разбора помещений/стен. Синхронно — разбор занимает
    секунды (анализ растра четырёх фасадов), фонового потока/прогресса,
    в отличие от `/import-pdf/analyze/start`, не нужно."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "pdf_import", "write")
        data = read_upload_limited(file.file)
        try:
            analysis = pdf_facade_import.analyze(conn, object_id, data, file.filename)
        except (pdf_facade_import.PdfFacadeImportError, pdf_rooms.PdfRoomsError) as e:
            raise HTTPException(status_code=getattr(e, "status_code", 422), detail=e.message)
    finally:
        conn.close()

    token = pdf_facade_import.remember_pending(analysis)
    return {
        "token": token,
        "object_id": object_id,
        "object_name": analysis["object_name"],
        "total_blocks": analysis["total_blocks"],
        "total_floors": analysis["total_floors"],
        "by_floor": analysis["by_floor"],
    }


@app.post("/import-pdf-facade/apply")
def apply_pdf_facade(body: PdfApplyIn, user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 2 упрощённой загрузки — применяет уже показанную сводку."""
    try:
        analysis = pdf_facade_import.get_pending(body.token)
    except pdf_facade_import.PdfFacadeImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    object_id = analysis["object_id"]
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "pdf_import", "write")
    finally:
        conn.close()

    backup_before_import(
        "блоки из PDF по фасадам → %s" % analysis["object_name"],
        audit_display_name(user), user["id"])

    операция = activity.new_request_id()
    conn = get_connection()
    try:
        result = pdf_facade_import.apply(conn, object_id, analysis)
    finally:
        conn.close()
    pdf_facade_import.forget_pending(body.token)

    activity.log(
        "import_pdf_facade",
        user=user,
        request_id=операция,
        entity_type="object",
        entity_id=object_id,
        new_value=str(result["blocks_written"]),
        details={
            "блоков": result["blocks_written"],
            "секций": result["sections"],
            "этажей": result["floors"],
        },
    )
    return {"object_id": object_id, **result}


class ClearImportDataIn(BaseModel):
    source: str  # "revit" | "pdf" — экран, с которого вызвана очистка
    elements: bool = False
    structure: bool = False
    work: bool = False


@app.post("/objects/{object_id}/clear-import-data")
def clear_import_data(object_id: int, body: ClearImportDataIn,
                       user: sqlite3.Row = Depends(get_current_user)):
    """Отладочная очистка справочников объекта перед повторной загрузкой
    Revit/PDF (app/import_reset.py) — не двухфазная, применяется сразу:
    это инструмент отладки, а не рабочий импорт со сводкой."""
    if body.source not in ("revit", "pdf"):
        raise HTTPException(status_code=422, detail="source должен быть 'revit' или 'pdf'")
    if not (body.elements or body.structure or body.work):
        raise HTTPException(status_code=422, detail="Отметьте хотя бы одну группу для очистки")

    feature_key = "revit_import" if body.source == "revit" else "pdf_import"
    conn = get_connection()
    try:
        if body.elements:
            assert_object_feature(conn, user, object_id, feature_key, "write")
        if body.structure:
            assert_object_feature(conn, user, object_id, "blocks", "write")
        if body.work:
            assert_object_feature(conn, user, object_id, "blocks", "write")
            assert_object_feature(conn, user, object_id, "work_progress", "write")
        row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
        object_name = row["name"] if row else str(object_id)
    finally:
        conn.close()

    what = ", ".join(label for flag, label in (
        (body.elements, "элементы"), (body.structure, "секции/этажи"), (body.work, "виды работ"),
    ) if flag)
    backup_before_import(
        "очистка справочников (%s, %s) → %s" % (body.source, what, object_name),
        audit_display_name(user), user["id"])

    conn = get_connection()
    try:
        counts = import_reset.clear(
            conn, object_id,
            elements=body.elements, elements_source=body.source,
            structure=body.structure, work=body.work,
        )
    finally:
        conn.close()

    activity.log(
        "clear_import_data",
        user=user,
        entity_type="object",
        entity_id=object_id,
        details={"источник": body.source, "счётчики": counts},
    )
    return {"object_id": object_id, "counts": counts}


# ============== Учёт по блокам «этаж + секция» (Docs/block-accounting.md) ==============
#
# Второй контур учёта, независимый от сборного ЖБИ и от модели Revit
# (общий у контуров только объект). Секции/этажи заводятся здесь вручную —
# в те же таблицы, что заполняет `revit_catalog.apply` при импорте Revit,
# поэтому появившаяся позже Revit-выгрузка совместится с уже заведённым по
# коду секции / номеру этажа, а не задвоит справочник.


class BlockSectionIn(BaseModel):
    code: str
    name: Optional[str] = None


class BlockSectionRenameIn(BaseModel):
    name: str
    # Привязка к осям здания для геометрии блока (Docs/TZ.md, «Геометрия
    # блока») — обе пустые снимают привязку, см. blocks._set_section_axes.
    axis_from: Optional[str] = None
    axis_to: Optional[str] = None


@app.get("/objects/{object_id}/sections")
def list_block_sections(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        return blocks_mod.list_sections(conn, object_id)
    finally:
        conn.close()


@app.post("/objects/{object_id}/sections")
def create_block_section(object_id: int, body: BlockSectionIn,
                         user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            row = blocks_mod.create_section(conn, object_id, body.code, body.name)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_section_add", user=user, entity_type="object", entity_id=object_id,
                new_value=row["code"])
    return row


@app.patch("/objects/{object_id}/sections/{section_id}")
def rename_block_section(object_id: int, section_id: int, body: BlockSectionRenameIn,
                         user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            blocks_mod.update_section(conn, object_id, section_id, body.name,
                                      body.axis_from, body.axis_to)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    return {"ok": True}


@app.delete("/objects/{object_id}/sections/{section_id}")
def delete_block_section(object_id: int, section_id: int,
                         user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            blocks_mod.delete_section(conn, object_id, section_id)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_section_delete", user=user, entity_type="object", entity_id=object_id,
                old_value=str(section_id))
    return {"ok": True}


class BlockLevelIn(BaseModel):
    kind: str  # "этаж" | "подземный" | "кровля"
    floor: Optional[int] = None
    name: Optional[str] = None
    elevation_mm: Optional[float] = None
    section_codes: list[str] = []  # только для kind="кровля"


class BlockLevelEditIn(BaseModel):
    name: Optional[str] = None
    elevation_mm: Optional[float] = None
    height_mm: Optional[float] = None


@app.get("/objects/{object_id}/levels")
def list_block_levels(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        return blocks_mod.list_levels(conn, object_id)
    finally:
        conn.close()


@app.post("/objects/{object_id}/levels")
def create_block_level(object_id: int, body: BlockLevelIn,
                       user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            row = blocks_mod.create_level(conn, object_id, body.kind, body.floor, body.name,
                                          body.elevation_mm, body.section_codes)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_level_add", user=user, entity_type="object", entity_id=object_id,
                new_value=row["key"])
    return row


@app.patch("/objects/{object_id}/levels/{level_id}")
def edit_block_level(object_id: int, level_id: int, body: BlockLevelEditIn,
                     user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            blocks_mod.update_level(conn, object_id, level_id, body.name, body.elevation_mm,
                                    body.height_mm)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_level_edit", user=user, entity_type="object", entity_id=object_id,
                details={"level_id": level_id, "name": body.name,
                         "elevation_mm": body.elevation_mm, "height_mm": body.height_mm})
    return {"ok": True}


class BlockBoxIn(BaseModel):
    x0: float
    x1: float
    y0: float
    y1: float


class BlockBoxesIn(BaseModel):
    """Прямая геометрия блока — набор прямоугольников, мм в общей сетке
    осей объекта; пустой список — снова по осям секции. Форма всегда шлёт
    полный набор разом (Docs/block-accounting.md)."""
    boxes: List[BlockBoxIn]


@app.get("/objects/{object_id}/blocks/{block_id}/boxes")
def get_block_boxes(object_id: int, block_id: int,
                    user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        try:
            return blocks_mod.list_block_boxes(conn, object_id, block_id)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=404, detail=str(e))
    finally:
        conn.close()


@app.put("/objects/{object_id}/blocks/{block_id}/boxes")
def put_block_boxes(object_id: int, block_id: int, body: BlockBoxesIn,
                    user: sqlite3.Row = Depends(get_current_user)):
    """Экран «Учёт по блокам → Блоки»: геометрия блока руками — набором
    прямоугольников, поверх вычисленных по осям/загруженных из PDF
    (2026-09-05, живой запрос пользователя: один прямоугольник не выражает
    Г-образные/ступенчатые этажи)."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        boxes = [b.model_dump() for b in body.boxes]
        try:
            warnings = blocks_mod.set_block_boxes(conn, object_id, block_id, boxes)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_geometry_edit", user=user, entity_type="object", entity_id=object_id,
                details={"block_id": block_id, "прямоугольников": len(boxes)})
    return {"ok": True, "warnings": warnings}


@app.delete("/objects/{object_id}/levels/{level_id}")
def delete_block_level(object_id: int, level_id: int,
                       user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            blocks_mod.delete_level(conn, object_id, level_id)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_level_delete", user=user, entity_type="object", entity_id=object_id,
                old_value=str(level_id))
    return {"ok": True}


class BlockCreateIn(BaseModel):
    section_id: int
    level_id: int


@app.get("/objects/{object_id}/blocks")
def list_blocks_endpoint(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        return blocks_mod.list_blocks(conn, object_id)
    finally:
        conn.close()


@app.post("/objects/{object_id}/blocks")
def create_block_endpoint(object_id: int, body: BlockCreateIn,
                          user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            row = blocks_mod.create_block(conn, object_id, body.section_id, body.level_id)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_add", user=user, entity_type="object", entity_id=object_id,
                details={"section_id": body.section_id, "level_id": body.level_id})
    return row


@app.delete("/objects/{object_id}/blocks/{block_id}")
def delete_block_endpoint(object_id: int, block_id: int,
                          user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "write")
        try:
            blocks_mod.delete_block(conn, object_id, block_id)
        except blocks_mod.BlockError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        conn.close()
    activity.log("block_delete", user=user, entity_type="object", entity_id=object_id,
                old_value=str(block_id))
    return {"ok": True}


@app.get("/objects/{object_id}/blocks/geometry")
def blocks_geometry_endpoint(
    object_id: int,
    level_id: Optional[list[int]] = Query(None),
    section_id: Optional[list[int]] = Query(None),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Параллелепипеды блоков для слоя «Блоки» в «Модели МФР»
    (Docs/TZ.md, «Геометрия блока») — тем же языком отбора, что
    `/revit-plan/elements`."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        return revit_plan.blocks_geometry(conn, object_id, level_ids=level_id,
                                          section_ids=section_id)
    finally:
        conn.close()


@app.get("/objects/{object_id}/grids")
def object_grids_endpoint(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Сетка осей для слоя «Оси» в «Модели МФР» — тем же правом, что
    сами элементы: сетка не отдельная сущность доступа, а вспомогательный
    слой показа."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        return revit_plan.grids(conn, object_id)
    finally:
        conn.close()


@app.get("/objects/{object_id}/plan-images")
def plan_images_list_endpoint(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Слой «Планы» «Модели МФР» (2026-09-02, app/pdf_plan_images.py):
    у каких этажей есть картинка плана и куда её класть — охват в мм общей
    сетки, отметка этажа; сам PNG — отдельным запросом по `url` (в нём
    `v=id`, чтобы после повторной загрузки браузер не показал старую из
    кэша)."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        rows = conn.execute(
            "SELECT i.id, i.level_id, i.page, i.x0, i.x1, i.y0, i.y1, i.width_px, i.height_px, "
            "       l.elevation_mm, l.name AS level_name "
            "FROM level_plan_images i JOIN object_levels l ON l.id = i.level_id "
            "WHERE i.object_id = ? ORDER BY l.sort_order", (object_id,)).fetchall()
        return [{
            **{k: r[k] for k in ("level_id", "page", "x0", "x1", "y0", "y1",
                                 "width_px", "height_px", "elevation_mm", "level_name")},
            "url": f"/objects/{object_id}/plan-images/{r['level_id']}.png?v={r['id']}",
        } for r in rows]
    finally:
        conn.close()


@app.get("/objects/{object_id}/plan-images/{level_id}.png")
def plan_image_endpoint(object_id: int, level_id: int,
                        user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "revit_model", "read")
        row = conn.execute(
            "SELECT png FROM level_plan_images WHERE object_id = ? AND level_id = ?",
            (object_id, level_id)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="У этого этажа нет картинки плана")
    # Картинка меняется только повторной загрузкой, а в url тогда меняется
    # `v` — кэшировать можно смело.
    return Response(content=bytes(row["png"]), media_type="image/png",
                    headers={"Cache-Control": "private, max-age=86400"})


@app.get("/objects/{object_id}/blocks/{block_id}/card")
def block_card_endpoint(object_id: int, block_id: int,
                        user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "blocks", "read")
        card = revit_plan.block_card(conn, object_id, block_id)
        if card is None:
            raise HTTPException(status_code=404, detail="Блок не найден")
        card["статусы_работ"] = work_fact.block_summary(conn, object_id, block_id)
        return card
    finally:
        conn.close()


@app.post("/objects/{object_id}/work-types/analyze")
def analyze_work_types(object_id: int, file: UploadFile = File(...),
                       user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 1: разбор xlsx со справочником видов работ. В БД не пишет."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        data = read_upload_limited(file.file)
        try:
            analysis = work_types_import.analyze(conn, object_id, data)
        except work_types_import.WorkTypesError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    token = work_types_import.remember_pending(analysis)
    return {
        "token": token, "object_id": object_id, "total_rows": analysis["total_rows"],
        "new": analysis["new"], "reviving": analysis["reviving"],
        "retiring": analysis["retiring"], "unchanged": analysis["unchanged"],
        "warnings": analysis["warnings"],
    }


class WorkTypesApplyIn(BaseModel):
    token: str


@app.post("/objects/{object_id}/work-types/apply")
def apply_work_types(object_id: int, body: WorkTypesApplyIn,
                     user: sqlite3.Row = Depends(get_current_user)):
    """Фаза 2: применяет уже показанную сводку по токену."""
    try:
        analysis = work_types_import.get_pending(body.token)
    except work_types_import.WorkTypesError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    if analysis["object_id"] != object_id:
        raise HTTPException(status_code=409, detail="Токен относится к другому объекту.")

    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        result = work_types_import.apply(conn, object_id, analysis)
    finally:
        conn.close()
    work_types_import.forget_pending(body.token)
    activity.log("import_work_types", user=user, entity_type="object", entity_id=object_id,
                details=result)
    return result


@app.get("/objects/{object_id}/work-progress")
def get_work_progress(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        return work_progress_mod.matrix(conn, object_id)
    finally:
        conn.close()


class WorkProgressCellIn(BaseModel):
    work_type_id: int
    block_id: Optional[int] = None
    section_id: Optional[int] = None
    status: Optional[str] = None  # None = снять простановку («План»)


@app.put("/objects/{object_id}/work-progress/cell")
def set_work_progress_cell(object_id: int, body: WorkProgressCellIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            if body.status is None:
                work_progress_mod.clear_status(conn, object_id, body.work_type_id,
                                               body.block_id, body.section_id)
            else:
                work_progress_mod.set_status(conn, object_id, user["id"], body.work_type_id,
                                             body.block_id, body.section_id, body.status)
        except work_progress_mod.ProgressError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    activity.log("work_progress_set", user=user, entity_type="object", entity_id=object_id,
                new_value=body.status or "план",
                details={"work_type_id": body.work_type_id, "block_id": body.block_id,
                        "section_id": body.section_id})
    return {"ok": True}


# -------- Процент выполнения по блоку (app/work_fact.py, живой запрос
# пользователя 2026-09-02): отбор операций «эт/сек» для блока и отчёты о
# фактическом выполнении — панель блока в «Модели МФР», клик по блоку. --------

@app.get("/objects/{object_id}/blocks/{block_id}/work-types-settings")
def get_block_work_types_settings(object_id: int, block_id: int,
                                  user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        try:
            return work_fact.block_settings(conn, object_id, block_id)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


class BlockWorkTypesSettingsIn(BaseModel):
    work_type_ids: list[int]


@app.put("/objects/{object_id}/blocks/{block_id}/work-types-settings")
def set_block_work_types_settings(object_id: int, block_id: int, body: BlockWorkTypesSettingsIn,
                                  user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            work_fact.save_block_settings(conn, object_id, block_id, body.work_type_ids)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    activity.log("block_work_types_settings", user=user, entity_type="object", entity_id=object_id,
                details={"block_id": block_id, "count": len(body.work_type_ids)})
    return {"ok": True}


class BlockPercentCellIn(BaseModel):
    work_type_id: int
    percent: int
    report_date: str


@app.put("/objects/{object_id}/blocks/{block_id}/work-progress-cell")
def set_block_percent_cell(object_id: int, block_id: int, body: BlockPercentCellIn,
                           user: sqlite3.Row = Depends(get_current_user)):
    """Правка одной ячейки в отчёте «Учёт по блокам: статусы» (2026-09-05,
    живой запрос пользователя) — попадает в тот же отчёт-документ блока на
    `report_date`, что и «Факт» в панели блока, и потому НЕ пишет в общий
    журнал действий: это тот же механизм (`work_fact.save_report`), а у
    «Факт» уже есть свой аудит — `created_by`/`updated_by`/даты прямо на
    отчёте (Docs/block-accounting.md §8, «Отдельно от общего журнала
    действий» — вторая запись в activity_actions на то же изменение была бы
    задвоением, не новой информацией)."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            result = work_fact.set_cell_percent(conn, user["id"], object_id, block_id,
                                                body.work_type_id, body.percent, body.report_date)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    return result


@app.get("/objects/{object_id}/blocks/{block_id}/progress")
def get_block_progress(object_id: int, block_id: int,
                       user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        try:
            return work_fact.block_progress_tree(conn, object_id, block_id)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


# -------- «Шахматка» (2026-09-02, живой запрос пользователя): раскраска
# всех блоков плана по ОДНОЙ операции «эт/сек» разом — статус (цвет) и
# процент (подпись) на каждом блоке. Клик по блоку ведёт себя как раньше. --------

@app.get("/objects/{object_id}/blocks/work-types-in-use")
def get_blocks_work_types_in_use(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        return {"tree": work_fact.used_work_types_tree(conn, object_id)}
    finally:
        conn.close()


@app.get("/objects/{object_id}/blocks/work-type-progress")
def get_blocks_work_type_progress(object_id: int, work_type_id: int,
                                  user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        try:
            return work_fact.work_type_block_values(conn, object_id, work_type_id)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.get("/objects/{object_id}/blocks/{block_id}/fact-reports")
def list_block_fact_reports(object_id: int, block_id: int,
                            user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        return work_fact.list_reports(conn, object_id, block_id)
    finally:
        conn.close()


@app.get("/objects/{object_id}/blocks/{block_id}/fact-reports/{report_id}")
def get_block_fact_report(object_id: int, block_id: int, report_id: int,
                          user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "read")
        try:
            return work_fact.get_report(conn, object_id, block_id, report_id)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


class FactReportIn(BaseModel):
    report_date: str
    items: dict[int, int]   # work_type_id -> процент


@app.post("/objects/{object_id}/blocks/{block_id}/fact-reports")
def create_block_fact_report(object_id: int, block_id: int, body: FactReportIn,
                             user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            report_id = work_fact.save_report(conn, object_id, user["id"], block_id, None,
                                              body.report_date, body.items)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    return {"id": report_id}


@app.put("/objects/{object_id}/blocks/{block_id}/fact-reports/{report_id}")
def update_block_fact_report(object_id: int, block_id: int, report_id: int, body: FactReportIn,
                             user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, "work_progress", "write")
        try:
            work_fact.save_report(conn, object_id, user["id"], block_id, report_id,
                                  body.report_date, body.items)
        except work_fact.FactError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()
    return {"ok": True}


@app.post("/import-history-xlsx")
def import_history_xlsx(
    file: UploadFile = File(...),
    source_file: str = Form(...),
    mode: str = Form(...),
    admin: sqlite3.Row = Depends(get_current_user),
):
    content = read_upload_limited(file.file)
    backup_before_import(f"история статусов из {file.filename or 'файла'}",
                         audit_display_name(admin), admin["id"])
    conn = get_connection()
    # Соединение живёт до конца запроса и закрывается ОДИН раз, в finally
    # ниже. До 2026-08-12 здесь стоял отдельный `finally: conn.close()`
    # вокруг проверки доступа — и весь импорт истории падал 500
    # («Cannot operate on a closed database») на первом же обращении к БД:
    # закрытое соединение переиспользовалось следующей строкой. Поймано
    # живой проверкой формы.
    try:
        _guard_source_file(conn, admin, source_file, "import_history", "write")
        parsed = parse_history_xlsx(content)
        # Общая метка операции: сводное событие ниже и поэлементные события
        # внутри import_history связываются через неё (activity.new_request_id).
        операция = activity.new_request_id()
        summary = import_history(conn, source_file, parsed["rows"], mode, admin, операция)
        activity.log("import_history", user=admin, request_id=операция,
                     new_value=f"{file.filename or 'файл'}: записей {summary['inserted']}, "
                               f"исправлено {summary['updated']}, элементов "
                               f"{summary['matched_elements']}",
                     details={"режим": mode, "чертёж": source_file})
        # Что именно файл дал по реквизитам контракта — важно показать явно:
        # старая выгрузка (до 2026-07-29) несла одну склеенную колонку
        # "Контракт", разобрать её обратно нельзя, и импорт молча прошёл бы
        # без привязки к контрактам (см. CONTRACT_HEADER_CANDIDATES).
        summary["contract_columns"] = (
            "реквизиты импортированы" if parsed["has_contract_columns"]
            else ("старый формат — одна колонка «Контракт», реквизиты не импортированы"
                  if parsed["has_legacy_contract_column"] else "в файле нет колонок с реквизитами")
        )
        # Строки с нераспознанной датой отсеиваются при разборе (см.
        # normalize_changed_at) — показываем их отдельно от прочих пропусков:
        # это опечатка в файле, которую пользователь может исправить, а не
        # нормальная ситуация вроде «элемента нет в этом чертеже».
        summary["invalid_dates"] = parsed["invalid_dates"]
        summary["invalid_date_examples"] = parsed["invalid_date_examples"]
        return summary
    except HistoryImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.post("/import-contracting-xlsx")
def import_contracting_xlsx(file: UploadFile = File(...), object_id: int = Query(...),
                            admin: sqlite3.Row = Depends(require_service_feature("import_contracting", "write"))):
    """Файл "Контрактация" (см. app/contracting_import.py, Docs/backlog.md,
    "Контрактация 2.0") — создаёт/находит Контрагентов/Договоры/
    Спецификации/Контракты и их позиции по (тип, марка).

    object_id ОБЯЗАТЕЛЕН и выбирается человеком в форме (2026-08-12): объект
    контракта выводится по цепочке контракт → спецификация → договор, и без
    него загруженное не принадлежит ни одной стройке. Именно выбирается, а
    не берётся из текущего вида схемы: файл контрактации приходит от
    снабжения и вполне может относиться к соседнему зданию."""
    content = read_upload_limited(file.file)
    backup_before_import(f"контрактация из {file.filename or 'файла'}",
                         audit_display_name(admin), admin["id"])
    conn = get_connection()
    try:
        if conn.execute("SELECT id FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        parsed = parse_contracting_xlsx(content)
        итог = import_contracting(conn, parsed, object_id)
        activity.log("import_contracting", user=admin, entity_type="object", entity_id=object_id,
                     new_value=f"{file.filename or 'файл'}: "
                               + "; ".join(f"{k}: {v}" for k, v in итог.items()
                                           if isinstance(v, int))[:400],
                     details={k: v for k, v in итог.items() if isinstance(v, (int, str))})
        return итог
    except ContractingImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.post("/import-schedule-xlsx")
def import_schedule_xlsx(file: UploadFile = File(...),
                         object_id: Optional[int] = Form(None),
                         kind: str = Form("baseline"),
                         admin: sqlite3.Row = Depends(
                             require_service_feature("import_schedule", "write"))):
    """Файл графика MS Project (см. app/schedule_import.py) — сопоставляется
    с изделиями по блоку Захватка/Кран/Стоянка/Этаж/Вид работ.

    object_id и kind — с 2026-08-14 (совещание, блок E1). Объект выбирается
    в форме явно: без него сопоставление шло по всей базе и со вторым
    зданием развезло бы даты по чужому дому. kind — «базовый» (директивные
    даты, проставляются в изделия) или «актуализированный» (прогноз, живёт
    отдельной версией и полей изделия не трогает)."""
    content = read_upload_limited(file.file)
    backup_before_import(f"график MS Project из {file.filename or 'файла'}",
                         audit_display_name(admin), admin["id"])
    conn = get_connection()
    try:
        parsed = parse_schedule_xlsx(content)
        операция = activity.new_request_id()
        итог = import_schedule(conn, parsed, admin, операция, object_id=object_id,
                               kind=kind, source_file=file.filename)
        вид = "базовый" if итог["kind"] == "baseline" else "актуализированный"
        activity.log("import_schedule", user=admin, request_id=операция,
                     entity_type="object", entity_id=object_id,
                     new_value=f"{file.filename or 'файл'} ({вид}): строк {итог['rows_processed']}, "
                               f"изделий в версии {итог['elements_in_version']}, "
                               f"обновлено {итог['elements_updated']}")
        return итог
    except ScheduleImportError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    finally:
        conn.close()


@app.get("/report-help/{key}")
def get_report_help(key: str, user: sqlite3.Row = Depends(get_current_user)):
    """Справка по отчёту (2026-08-14): что показывает и по каким правилам
    считает. Под обычным входом: описание — не данные объекта, и прятать его
    от того, кому отчёт виден, не от чего."""
    return report_help_for(key)


@app.get("/import-templates")
def get_import_templates(user: sqlite3.Row = Depends(get_current_user)):
    """Описания форматов всех загружаемых файлов — одним запросом на все
    формы загрузки (их шесть, ходить из каждой отдельно незачем). Под
    обычным входом, не под require_admin: сами загрузки админские, но
    прораб может готовить файл, не имея права его загрузить."""
    return {"templates": template_list()}


@app.get("/import-templates/{key}/sample")
def get_import_template_sample(key: str, user: sqlite3.Row = Depends(get_current_user)):
    try:
        content, filename, media_type = build_sample(key)
    except KeyError:
        raise HTTPException(status_code=404, detail="Неизвестный шаблон")
    headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename)}
    return Response(content=content, media_type=media_type, headers=headers)


@app.get("/settings/export")
def export_settings(admin: sqlite3.Row = Depends(require_service_feature("settings_io", "read"))):
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
        # Видимость подписей — настройка ОБЪЕКТА (этап D), поэтому в файле
        # она разложена ПО ОБЪЕКТАМ. Ключ — ИМЯ объекта, а не id: файл
        # переносят на другой сервер, где id тот же ничего не значит, а имя
        # объекта — единственное, что человек может сопоставить глазами.
        label_visibility = {}
        label_dates_visibility = {}
        for r in conn.execute(
            "SELECT o.name AS object_name, lv.element_type, lv.visible, lv.dates_visible "
            "FROM label_visibility lv JOIN objects o ON o.id = lv.object_id "
            "ORDER BY o.name, lv.element_type"
        ).fetchall():
            label_visibility.setdefault(r["object_name"], {})[r["element_type"]] = bool(r["visible"])
            label_dates_visibility.setdefault(r["object_name"], {})[r["element_type"]] = \
                bool(r["dates_visible"])
    finally:
        conn.close()

    payload = {
        "users": users, "status_colors": colors, "label_visibility": label_visibility,
        "label_dates_visibility": label_dates_visibility,
    }

    headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + quote("zhbi_settings.json")}
    return Response(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers=headers,
    )


@app.post("/settings/import")
def import_settings(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_service_feature("settings_io", "write"))):
    try:
        payload = json.loads(read_upload_limited(file.file))
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Файл повреждён или не является корректным JSON")

    backup_before_import(f"настройки из {file.filename or 'файла'}",
                         audit_display_name(admin), admin["id"])
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
                # Способ входа переносится вместе с пользователем: файл
                # настроек нужен для переезда на другой сервер, а учётная
                # запись, приехавшая туда с 'local' вместо 'domain', ждала
                # бы пароля, которого у неё нет. Старый файл (до 2026-08-03)
                # этого поля не содержит — там 'local', как и было.
                "auth_method": "domain" if u.get("auth_method") == "domain" else "local",
            }
            if existing:
                conn.execute(
                    """
                    UPDATE users SET last_name=:last_name, first_name=:first_name,
                        patronymic=:patronymic, position=:position, department=:department,
                        role=:role, password_hash=:password_hash, password_salt=:password_salt,
                        auth_method=:auth_method, updated_at=datetime('now')
                    WHERE domain_login=:domain_login
                    """,
                    fields,
                )
            else:
                conn.execute(
                    """
                    INSERT INTO users (last_name, first_name, patronymic, position, department,
                        domain_login, role, password_hash, password_salt, auth_method)
                    VALUES (:last_name, :first_name, :patronymic, :position, :department,
                        :domain_login, :role, :password_hash, :password_salt, :auth_method)
                    """,
                    fields,
                )
            users_upserted += 1

        # Файл настроек — такой же непроверенный ввод, как и форма: его
        # приносят с другого сервера, и по дороге он редактируется руками.
        for status, color in payload.get("status_colors", {}).items():
            try:
                color = validate_color(color, "Цвет статуса")
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
            conn.execute(
                "INSERT INTO status_colors (status, color) VALUES (?, ?) "
                "ON CONFLICT(status) DO UPDATE SET color = excluded.color",
                (status, color),
            )

        # Видимость подписей — по объектам, ключ файла это ИМЯ объекта (см.
        # export_settings). Объект, которого на этом сервере нет, ПРОПУСКАЕТСЯ
        # и попадает в счётчик пропущенных: завести объект по одному имени из
        # файла настроек нельзя — у объекта есть проект, адрес и чертежи,
        # ничего этого в файле нет, а молча приписать настройки чужому объекту
        # хуже, чем не применить их вовсе.
        object_ids_by_name = {
            r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM objects")
        }
        applied = {"label_visibility": 0, "label_dates_visibility": 0}
        skipped_objects = set()

        for key, column in (("label_visibility", "visible"),
                            ("label_dates_visibility", "dates_visible")):
            for object_name, types in (payload.get(key) or {}).items():
                # Старый формат файла — {тип: bool} без объекта. Применить
                # его можно, только если объект на сервере ровно один:
                # иначе неизвестно, к какой стройке эти настройки относились.
                if isinstance(types, bool):
                    if len(object_ids_by_name) != 1:
                        skipped_objects.add("(файл старого формата, без объекта)")
                        continue
                    object_id, types = next(iter(object_ids_by_name.values())), {object_name: types}
                elif object_name in object_ids_by_name:
                    object_id = object_ids_by_name[object_name]
                else:
                    skipped_objects.add(object_name)
                    continue
                for element_type, visible in types.items():
                    conn.execute(
                        f"INSERT INTO label_visibility (object_id, element_type, {column}) "
                        f"VALUES (?, ?, ?) ON CONFLICT(object_id, element_type) "
                        f"DO UPDATE SET {column} = excluded.{column}",
                        (object_id, element_type, int(visible)),
                    )
                    applied[key] += 1

        conn.commit()
    finally:
        conn.close()

    итог = {
        "users_upserted": users_upserted,
        "status_colors": len(payload.get("status_colors", {})),
        "label_visibility": applied["label_visibility"],
        "label_dates_visibility": applied["label_dates_visibility"],
        "skipped_objects": sorted(skipped_objects),
    }
    activity.log("settings_import", user=admin,
                 new_value=f"{file.filename or 'файл'}: пользователей {users_upserted}, "
                           f"цветов статусов {итог['status_colors']}, "
                           f"видимость подписей {applied['label_visibility']}",
                 details=итог)
    return итог


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

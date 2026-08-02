import io
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
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

from app.auth import format_display_name, get_current_user
from app.auth import router as auth_router
from app.attachments import counts_for as attachment_counts
from app.attachments import delete_for_entity as delete_attachments_for
from app.attachments import router as attachments_router
from app.changelog import CHANGELOG
from app.contracting_import import ContractingImportError, import_contracting, parse_contracting_xlsx
from urllib.parse import quote

from pydantic import BaseModel

from app import activity
from app.backups import (
    KIND_BEFORE_REBUILD, KIND_MANUAL, BackupError,
    adopt_legacy_backup, create_backup, delete_backup, list_backups, restore_backup,
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
from app.counterparties import router as counterparties_router
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
)
from app import status_bulk_edit
from app.access import (
    accessible_object_ids,
    assert_object_access,
    is_system_admin,
    object_roles,
    require_object_access,
    require_object_admin,
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
)
from app.report_delivery import (
    build_delivery_cell_detail, build_delivery_schedule_pdf, build_delivery_schedule_report,
    build_delivery_schedule_xlsx,
)
from app.models import (
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
    ObjectOut,
    ObjectPatchIn,
    ZoneLevelIn,
    ZoneLevelOut,
    ZoneOut,
    ZonePatchIn,
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
    schema_changes = init_db()
    _warn_users_without_password()

    # Только СООБЩАЕТ о подозрительной схеме, никогда не бросает исключений
    # и ничего не пересобирает (см. её docstring).
    _probe_schema_health()

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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/changelog")
def get_changelog(user: sqlite3.Row = Depends(get_current_user)):
    # Требует входа, как и весь остальной функционал (см. Docs/TZ.md) —
    # список релизов не публичный. Порядок — как в app/changelog.py (от
    # новой версии к старой), фронтенд ничего не сортирует сам.
    return CHANGELOG


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
        history_rows = conn.execute(
            "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at",
            (element_id,),
        ).fetchall()
        data = dict(row)
        data["history"] = [dict(h) for h in history_rows]
        enrich_element_row(conn, data)
        _element_reference_labels(conn, data)
        return data
    finally:
        conn.close()


@app.patch("/elements/{element_id}/status", response_model=StatusUpdateResult)
def update_status(
    element_id: int, body: StatusUpdateIn, user: sqlite3.Row = Depends(get_current_user)
):
    conn = get_connection()
    try:
        _guard_elements(conn, user, [element_id])
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
        _guard_elements(conn, user, ids)

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


class ElementCommentIn(BaseModel):
    comment: Optional[str] = None


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
        _guard_elements(conn, user, [element_id])
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
        _guard_elements(conn, user, [element_id])
        data = set_planned_delivery_date(conn, element_id, body.planned_delivery_date)
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
        _guard_elements(conn, user, ids)

        updated = set_planned_delivery_dates_bulk(
            conn, [(item.element_id, item.planned_delivery_date) for item in body.items]
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
        assert_object_access(conn, admin, element["object_id"], "admin")
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
        _guard_elements(conn, user, [element_id])
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
        return data
    finally:
        conn.close()


class ReportRequestIn(BaseModel):
    source_file: Optional[str] = None
    # Объект отчёта (этап D) — им выбираются карточка объекта и текстовые
    # блоки «на дату». Клиент присылает его явно; если не прислал, объект
    # выводится из чертежа (_report_object_id) — так же, как это делает
    # показ схемы.
    object_id: Optional[int] = None
    # Отчётная дата — только для «Динамики» (ежедневный отчёт «на дату»).
    # Пусто = сегодня; сервер возвращает фактически применённую дату.
    report_date: Optional[str] = None
    # Список id — необязательное сужение отчёта текущим фильтром схемы. Тот
    # же приём, что у XLS-экспорта: критерии фильтра живут на клиенте, и
    # дублировать их на сервере значило бы держать две расходящиеся копии.
    element_ids: Optional[list[int]] = None
    # Только для «Графика поставки»: период календаря, шаг оси и ПОРЯДОК
    # уровней группировки (его задаёт пользователь, см. app/report_delivery.py).
    # Пусто = сервер подставит свои значения и вернёт применённые.
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    step: Optional[str] = None
    group_by: Optional[list[str]] = None


def _report_object_id(conn, body: "ReportRequestIn"):
    """Объект отчёта: явно присланный клиентом либо выведенный из чертежа.
    None — отчёт не относится ни к одному объекту (файл не задан или не
    привязан); карточка объекта тогда пустая, см. build_dynamics_report."""
    if body.object_id is not None:
        return body.object_id
    return _object_for_source_file(conn, body.source_file) if body.source_file else None


@app.post("/reports/status")
def report_status(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Отчёт «Статусы» — данные для экрана. POST, а не GET: список id может
    быть в тысячи элементов и не помещается в строку запроса."""
    conn = get_connection()
    try:
        return build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()


@app.post("/reports/dynamics")
def report_dynamics(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    """Ежедневный отчёт «Динамика монтажа и поставки ТМЦ»."""
    conn = get_connection()
    try:
        return build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                     _report_object_id(conn, body))
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
        report = build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                       _report_object_id(conn, body))
    finally:
        conn.close()
    return _report_file_response(
        build_dynamics_report_xlsx(report), "Динамика.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/dynamics.pdf")
def report_dynamics_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = build_dynamics_report(conn, body.source_file, body.report_date, body.element_ids,
                                       _report_object_id(conn, body))
    finally:
        conn.close()
    return _report_file_response(build_dynamics_report_pdf(report), "Динамика.pdf", "application/pdf")


@app.post("/reports/status.xlsx")
def report_status_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()
    content = build_status_report_xlsx(report)
    name = "Статусы.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"report.xlsx\"; filename*=UTF-8''{quote(name)}"},
    )


@app.post("/reports/status.pdf")
def report_status_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = build_status_report(conn, body.source_file, body.element_ids)
    finally:
        conn.close()
    subtitle = f"Чертёж: {body.source_file}" if body.source_file else ""
    content = build_status_report_pdf(report, subtitle)
    name = "Статусы.pdf"
    return Response(
        content=content, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(name)}"},
    )


def _delivery_schedule(conn, body: "ReportRequestIn") -> dict:
    """Общая точка для экрана, XLSX и PDF «Графика поставки». ValueError
    (слишком много календарных колонок) — это ошибка ЗАПРОСА, а не сбой:
    отдаём 400 с текстом, который уже объясняет, что сделать."""
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
        return _delivery_schedule(conn, body)
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
        return build_delivery_cell_detail(
            conn, body.source_file, body.element_ids, body.date_from, body.date_to,
            body.step, body.group_by, body.path, body.column)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        conn.close()


@app.post("/reports/delivery-schedule.xlsx")
def report_delivery_schedule_xlsx(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _delivery_schedule(conn, body)
    finally:
        conn.close()
    return _report_file_response(
        build_delivery_schedule_xlsx(report), "График поставки.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/reports/delivery-schedule.pdf")
def report_delivery_schedule_pdf(body: ReportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        report = _delivery_schedule(conn, body)
    finally:
        conn.close()
    return _report_file_response(build_delivery_schedule_pdf(report),
                                 "График поставки.pdf", "application/pdf")


class BackupCreateIn(BaseModel):
    comment: Optional[str] = None


@app.get("/admin/backups")
def admin_list_backups(admin: sqlite3.Row = Depends(require_system_admin)):
    """Все резервные копии на диске, новые сверху — из этого списка
    выбирается точка, на которую восстанавливаться."""
    return {"backups": list_backups()}


@app.post("/admin/backups")
def admin_create_backup(body: BackupCreateIn, admin: sqlite3.Row = Depends(require_system_admin)):
    """Копия по кнопке. Записывается, КЕМ создана — в отличие от служебных,
    которые система снимает сама перед разрушительными операциями."""
    meta = create_backup(
        kind=KIND_MANUAL,
        user_name=format_display_name(admin),
        user_id=admin["id"],
        comment=body.comment,
    )
    activity.log("backup_create", user=admin, new_value=meta["name"], details={"comment": body.comment})
    return meta


@app.post("/admin/backups/{name}/restore")
def admin_restore_backup(name: str, admin: sqlite3.Row = Depends(require_system_admin)):
    """Восстановление на выбранный момент. ПЕРЕД восстановлением всегда
    снимается служебная копия текущего состояния — если выбрали не ту точку,
    вернуться будет куда.

    После переноса данных прогоняется init_db(): копия может быть снята на
    более старой схеме, и без миграций приложение бы на ней не поднялось.
    """
    try:
        result = restore_backup(name, user_name=format_display_name(admin), user_id=admin["id"])
    except BackupError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    init_db()
    activity.log(
        "backup_restore", user=admin, old_value=result["safety_backup"]["name"], new_value=name,
        details={"комментарий": "перед восстановлением снята служебная копия"},
    )
    return result


@app.delete("/admin/backups/{name}", status_code=204)
def admin_delete_backup(name: str, admin: sqlite3.Row = Depends(require_system_admin)):
    try:
        delete_backup(name)
    except BackupError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    activity.log("backup_delete", user=admin, old_value=name)
    return Response(status_code=204)


@app.get("/admin/input-files")
def admin_input_files(user: sqlite3.Row = Depends(require_system_admin)):
    """Что сейчас лежит в Input/ — для диалога подтверждения перед импортом.
    Отдельным запросом, а не вместе с самим импортом: оператор должен
    увидеть список ДО того, как согласится перезаписать геометрию."""
    return list_input_files()


@app.post("/admin/import-input")
def admin_import_input(user: sqlite3.Row = Depends(require_system_admin)):
    """Импорт всех файлов из папки Input/ на сервере — по явной команде из
    меню. Раньше это происходило само при каждом старте сервера, то есть на
    каждый деплой и каждый перезапуск контейнера (см. on_startup, где
    объяснено, почему так делать не следует).

    Порядок вызовов важен и совпадает с scripts/rebuild_db.py: сначала DXF
    (контрактации нужны уже загруженные марки, графику — уже привязанные к
    зонам элементы), затем xlsx.

    Возвращает построчный отчёт обоих импортов — то же самое, что уходит в
    лог сервера, но оператор лог не читает.

    Импорт ПЕРЕЗАПИСЫВАЕТ геометрию уже загруженных элементов (upsert по
    (source_file, dxf_handle)); статусы и история живут в отдельных
    таблицах и не затрагиваются. Предупреждение об этом — в диалоге
    подтверждения на фронтенде."""
    report = import_input_dxf()
    report += import_input_xlsx()
    # В журнал: до 2026-07-30 массовая загрузка из Input/ нигде не
    # фиксировалась, кроме stdout сервера, — а она перезаписывает геометрию
    # всех элементов и создаёт контракты (живой репорт пользователя о
    # незаписанных системных событиях).
    activity.log(
        "import_input", user=user,
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


@app.get("/activity")
def search_activity(
    date_from: Optional[str] = Query(None, description="'ГГГГ-ММ-ДД' включительно"),
    date_to: Optional[str] = Query(None, description="'ГГГГ-ММ-ДД' включительно"),
    user_id: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    entity_id: Optional[int] = Query(None),
    text: Optional[str] = Query(None, description="подстрока в марке/типе/подтипе/значениях"),
    limit: int = Query(200, le=2000),
    offset: int = Query(0, ge=0),
    admin: sqlite3.Row = Depends(require_system_admin),
):
    """Поиск по журналу. Только админу: журнал показывает, кто что делал, —
    это не то, что должно быть доступно всем ролям.

    Отдаёт и общее число совпадений (для постраничного просмотра), и саму
    страницу. Поиск по подстроке идёт по снимкам марки/типа/подтипа и по
    значениям — то есть по тем полям, которые в журнале и ищут.
    """
    # activity_log.at хранится в UTC (app/activity._now), а пользователь
    # выбирает границы по своему местному календарю — поэтому клиент
    # присылает уже пересчитанные в UTC ГРАНИЦЫ С ВРЕМЕНЕМ (см.
    # loadActivity, app.js). Строка без времени тоже принимается — тогда
    # трактуем её как раньше, целыми сутками: так продолжают работать
    # прямые вызовы эндпоинта (curl, внешние скрипты).
    clauses, params = [], []
    if date_from:
        clauses.append("at >= ?")
        params.append(date_from if " " in date_from else f"{date_from} 00:00:00.000")
    if date_to:
        clauses.append("at <= ?")
        params.append(date_to if " " in date_to else f"{date_to} 23:59:59.999")
    if user_id is not None:
        clauses.append("user_id = ?")
        params.append(user_id)
    if action:
        clauses.append("action = ?")
        params.append(action)
    if entity_id is not None:
        clauses.append("entity_id = ?")
        params.append(entity_id)
    if text:
        # Регистронезависимый поиск кириллицы — на стороне SQL LIKE его не
        # получить (SQLite без ICU кириллицу не приводит, см. Docs/TZ.md),
        # поэтому сравниваем как есть; для марок/типов этого достаточно —
        # они и хранятся в том виде, в каком их ищут.
        like = f"%{text}%"
        clauses.append("(mark LIKE ? OR element_type LIKE ? OR subtype LIKE ? "
                       "OR old_value LIKE ? OR new_value LIKE ? OR user_name LIKE ?)")
        params.extend([like] * 6)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    conn = get_connection()
    try:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM activity_log {where}", params).fetchone()["n"]
        rows = conn.execute(
            f"SELECT * FROM activity_log {where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        actions = [r["action"] for r in conn.execute(
            "SELECT DISTINCT action FROM activity_log ORDER BY action").fetchall()]
        return {"total": total, "rows": [dict(r) for r in rows], "actions": actions}
    finally:
        conn.close()


@app.post("/activity/cleanup")
def cleanup_activity(
    before: str = Query(..., description="Удалить записи СТРОГО РАНЬШЕ этой даты, 'ГГГГ-ММ-ДД'"),
    admin: sqlite3.Row = Depends(require_system_admin),
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
def reset_status_history(user: sqlite3.Row = Depends(require_system_admin)):
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
        where = f"WHERE {visible_elements_clause()}"
        params = ()
        if source_file:
            where += " AND source_file = ?"
            params = (source_file,)
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
        rows = conn.execute(
            f"SELECT source_file, COUNT(*) as n FROM elements "
            f"WHERE {visible_elements_clause()} GROUP BY source_file ORDER BY source_file"
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
def set_status_colors(colors: dict[str, str], user: sqlite3.Row = Depends(require_system_admin)):
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


# Видимость подписей — настройка ОБЪЕКТА (этап D): типы элементов на
# соседних стройках разные, и общая запись включала бы «Колонны» сразу
# везде. object_id обязателен, доступ — по объекту (чтение всем, у кого
# есть доступ; правка — админу объекта, не сервиса).
@app.get("/label-visibility")
def get_label_visibility(object_id: int = Query(...),
                         user: sqlite3.Row = Depends(require_object_access)):
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
                         user: sqlite3.Row = Depends(require_object_admin)):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (object_id, element_type, visible) VALUES (?, ?, ?) "
                "ON CONFLICT(object_id, element_type) DO UPDATE SET visible = excluded.visible",
                (object_id, element_type, int(visible)),
            )
        conn.commit()
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
                               user: sqlite3.Row = Depends(require_object_access)):
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
                               user: sqlite3.Row = Depends(require_object_admin)):
    conn = get_connection()
    try:
        for element_type, visible in settings.items():
            conn.execute(
                "INSERT INTO label_visibility (object_id, element_type, dates_visible) VALUES (?, ?, ?) "
                "ON CONFLICT(object_id, element_type) DO UPDATE SET dates_visible = excluded.dates_visible",
                (object_id, element_type, int(visible)),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT element_type, dates_visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
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
def set_element_shapes(shapes: list[ElementShapeIn], user: sqlite3.Row = Depends(require_system_admin)):
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
def list_zone_colors(object_id: int = Query(...),
                     user: sqlite3.Row = Depends(require_object_access)):
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
                    user: sqlite3.Row = Depends(require_object_admin)):
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
        where = "z.object_id IS NOT NULL AND z.category = ?"
        params = [category]
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
        assert_object_access(conn, admin, zone["object_id"], "admin")
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
        if refusal:
            recalc = {"changed": 0, "by_category": {}, "before": [], "refused": refusal}
        else:
            recalc = zone_recalc.recalculate(conn, zone["object_id"])
        undo_id = zone_recalc.save_undo(
            conn, zone_id, admin, before,
            zone_recalc.merge_bindings(bindings_pre_edit, recalc["before"]),
        )
    finally:
        conn.close()

    activity.log(
        "zone_edit", user=admin, entity_type="zone", entity_id=zone_id,
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
        assert_object_access(conn, admin, zone["object_id"], "admin")
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


# Справочник элементов (этап 3, решение Э1). Колонки, по которым можно
# отбирать выпадающим списком: у них ограниченный набор значений. Даты и
# координаты сюда не входят — у них значений почти столько же, сколько строк,
# выпадашка была бы бесполезна (для них — сортировка и общий поиск).
_ELEMENT_FILTER_COLUMNS = ("element_type", "subtype", "mark", "elevation_mm", "floor", "current_status")

# Тот же сентинел «нет значения», что уже используют фильтры схемы на
# фронтенде (PLACEMENT_NONE в app/static/app.js): пустая строка в запросе
# означает «любое значение», а «пустое значение» надо уметь выбрать явно.
PLACEMENT_NONE_SENTINEL = "__none__"

# Колонки, отбираемые ПОДСТРОКОЙ, а не выпадашкой: у них значений почти
# столько же, сколько строк (адрес по осям, даты). Живой запрос — «добавь
# возможность фильтрации по всем колонкам»: выпадашка на 9000 разных значений
# бесполезна, а поиск по части значения работает и для даты («2026-09»).
_ELEMENT_TEXT_FILTER_COLUMNS = (
    "address", "planned_delivery_date", "actual_delivery_date",
    "project_delivery_date", "project_smr_start_date", "layer",
    "comment",
)

# Колонки, по которым разрешена сортировка. Белый список, а не подстановка
# имени из запроса в SQL: имя колонки нельзя передать параметром, оно
# склеивается в текст запроса — без списка это была бы SQL-инъекция.
_ELEMENT_SORT_COLUMNS = _ELEMENT_FILTER_COLUMNS + (
    "id", "address", "planned_delivery_date", "actual_delivery_date",
    "project_delivery_date", "project_smr_start_date", "layer", "comment",
)


# Путь БЕЗ префикса /elements/: маршрут /elements/{element_id} объявлен
# раньше и перехватывал бы «catalog» как идентификатор элемента (422 на
# разборе int) — поймано первым же запросом.
@app.get("/element-catalog")
def elements_catalog(
    limit: int = Query(200, le=2000),
    offset: int = Query(0, ge=0),
    sort: str = Query("id"),
    direction: str = Query("asc"),
    search: Optional[str] = Query(None, description="подстрока в марке или адресе"),
    element_type: Optional[str] = Query(None),
    subtype: Optional[str] = Query(None),
    mark: Optional[str] = Query(None),
    elevation_mm: Optional[str] = Query(None),
    floor: Optional[str] = Query(None),
    current_status: Optional[str] = Query(None),
    address: Optional[str] = Query(None),
    planned_delivery_date: Optional[str] = Query(None),
    actual_delivery_date: Optional[str] = Query(None),
    project_delivery_date: Optional[str] = Query(None),
    project_smr_start_date: Optional[str] = Query(None),
    layer: Optional[str] = Query(None),
    comment: Optional[str] = Query(None),
    user: sqlite3.Row = Depends(get_current_user),
):
    """Табличный справочник элементов с отбором по колонкам и сортировкой.

    Отдаёт и страницу строк, и общее число совпадений, и наборы РАЗЛИЧНЫХ
    значений для выпадашек отбора. Значения считаются по тому же отбору, что
    и строки, но БЕЗ учёта фильтра самой этой колонки — иначе, выбрав
    значение, пользователь терял бы возможность переключиться на другое
    (та же логика «полный список значений всегда виден», что у фильтров
    схемы, см. Docs/backlog.md).
    """
    if sort not in _ELEMENT_SORT_COLUMNS:
        raise HTTPException(status_code=400, detail=f"Сортировка по «{sort}» не поддерживается")
    order = "DESC" if str(direction).lower() == "desc" else "ASC"

    requested = {
        "element_type": element_type, "subtype": subtype, "mark": mark,
        "elevation_mm": elevation_mm, "floor": floor, "current_status": current_status,
    }
    # Пустая строка от выпадашки означает «любое», а не «пустое значение»;
    # для «пустое» есть отдельный сентинел (клиент присылает __none__).
    active = {k: v for k, v in requested.items() if v not in (None, "")}
    text_filters = {
        k: v for k, v in {
            "address": address, "planned_delivery_date": planned_delivery_date,
            "actual_delivery_date": actual_delivery_date,
            "project_delivery_date": project_delivery_date,
            "project_smr_start_date": project_smr_start_date, "layer": layer,
            "comment": comment,
        }.items() if v not in (None, "")
    }

    def clauses_for(skip: Optional[str] = None):
        # object_id IS NOT NULL оставлено как страховка, хотя элементов без
        # объекта после чистки дообъектного наследия (2026-07-31,
        # app/db._purge_legacy_elements) в базе нет и импорт создать их не
        # может: справочник допускает ручную правку, и строка, оставшаяся
        # без объекта из-за сбоя, не должна всплыть в чужом объекте.
        parts, params = ["object_id IS NOT NULL", "is_current = 1"], []
        for column, value in active.items():
            if column == skip:
                continue
            if value == PLACEMENT_NONE_SENTINEL:
                parts.append(f"{column} IS NULL")
            else:
                parts.append(f"{column} = ?")
                params.append(value)
        for column, value in text_filters.items():
            # Имя колонки — из закрытого списка, не из запроса: подставляется
            # в текст SQL, параметром его не передать.
            if column in _ELEMENT_TEXT_FILTER_COLUMNS:
                parts.append(f"{column} LIKE ?")
                params.append(f"%{value}%")
        if search:
            parts.append("(mark LIKE ? OR address LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        return " AND ".join(parts), params

    conn = get_connection()
    try:
        where, params = clauses_for()
        total = conn.execute(
            f"SELECT COUNT(*) AS n FROM elements WHERE {where}", params
        ).fetchone()["n"]
        rows = conn.execute(
            f"SELECT * FROM elements WHERE {where} "
            f"ORDER BY {sort} {order}, id {order} LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()

        values = {}
        for column in _ELEMENT_FILTER_COLUMNS:
            sub_where, sub_params = clauses_for(skip=column)
            values[column] = [
                (PLACEMENT_NONE_SENTINEL if r[column] is None else r[column])
                for r in conn.execute(
                    f"SELECT DISTINCT {column} FROM elements WHERE {sub_where} "
                    f"ORDER BY {column} IS NULL, {column}",
                    sub_params,
                )
            ]
        # Скрепка в строке — по одному запросу на СТРАНИЦУ, не на строку:
        # при 200 строках это была бы двухсотка запросов на каждую прокрутку.
        вложений = attachment_counts(conn, "element", [r["id"] for r in rows])
        строки = []
        for r in rows:
            d = enrich_element_row(conn, dict(r))
            d["attachments"] = вложений.get(r["id"], 0)
            строки.append(d)
        return {"total": total, "rows": строки, "values": values}
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
        assert_object_access(conn, admin, row["object_id"], "admin")

        values = {}
        for field, raw in body.items():
            try:
                values[field] = coerce_field(field, raw)
            except FieldError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

        new_type = values.get("element_type", row["element_type"])
        new_subtype = values.get("subtype", row["subtype"])
        if "element_type" in values or "subtype" in values:
            err = check_subtype(conn, new_type, new_subtype)
            if err:
                raise HTTPException(status_code=400, detail=err)

        # Расхождение с позицией контракта — только если контракт назначен.
        new_mark = values.get("mark", row["mark"])
        mismatch = None
        if "mark" in values or "element_type" in values:
            mismatch = contract_mismatch(conn, row["contract_id"], new_type, new_mark)
            if mismatch and not confirm_contract_mismatch:
                raise HTTPException(status_code=409, detail=mismatch)

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


# Режим формы массовой правки: реквизиты элемента или история статусов.
# Один набор эндпоинтов на оба, а не два параллельных: структуры ответа
# (columns/elements/changes/rejected) совпадают, и табличный экран
# подтверждения переиспользуется целиком.
# Массовая правка идёт по ВСЕМ объектам одним файлом (так её и просили),
# поэтому она пока за администратором сервиса. Отдать её «админу объекта»
# без отбора строк по доступным объектам значило бы выдать ему выгрузку
# всей базы и право править чужие элементы — отбор нужен в обоих модулях
# выгрузки (реквизиты и статусы) и вынесен в отдельную задачу.
_BULK_MODES = {"fields", "statuses"}


def _check_bulk_mode(mode: str) -> str:
    if mode not in _BULK_MODES:
        raise HTTPException(status_code=400, detail=f"Неизвестный режим «{mode}»")
    return mode


@app.get("/elements/bulk-edit/export")
def bulk_edit_export(mode: str = Query("fields"), admin: sqlite3.Row = Depends(require_system_admin)):
    """Снимок реквизитов всех элементов всех объектов ОДНИМ файлом — для
    правки в Excel и обратной загрузки (см. app/element_bulk_edit.py).

    Только admin, как и вся группа «Обмен данными»: файл содержит выгрузку
    всей базы элементов.
    """
    _check_bulk_mode(mode)
    conn = get_connection()
    try:
        wb = (status_bulk_edit.build_status_workbook(conn) if mode == "statuses"
              else build_export_workbook(conn))
    finally:
        conn.close()
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    activity.log("element_bulk_export", user=admin, entity_type="element",
                 details={"mode": mode})
    name = "zhbi_statuses" if mode == "statuses" else "zhbi_elements"
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}_{stamp}.xlsx"'},
    )


@app.post("/elements/bulk-edit/analyze")
def bulk_edit_analyze(file: UploadFile = File(...), mode: str = Form("fields"),
                      admin: sqlite3.Row = Depends(require_system_admin)):
    """Сверяет загруженный файл с базой и возвращает список расхождений.
    НИЧЕГО НЕ ПИШЕТ — применение отдельным вызовом, после того как
    пользователь отметил флажками, что применять."""
    _check_bulk_mode(mode)
    payload = read_upload_limited(file.file)
    conn = get_connection()
    try:
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
def bulk_edit_apply(body: BulkEditApplyIn, admin: sqlite3.Row = Depends(require_system_admin)):
    """Применяет отмеченные изменения."""
    if not body.changes:
        raise HTTPException(status_code=400, detail="Не отмечено ни одного изменения")
    _check_bulk_mode(body.mode)
    conn = get_connection()
    try:
        if body.mode == "statuses":
            return status_bulk_edit.apply_changes(
                conn, body.changes, format_display_name(admin), admin["id"]
            )
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
        return apply_bulk_edit(
            conn, body.changes, format_display_name(admin), admin["id"], stamp
        )
    finally:
        conn.close()


def _object_for_source_file(conn, source_file: str):
    """Объект, которому принадлежит чертёж. None — файл не привязан ни к
    одному объекту (наследие или ещё не импортированный)."""
    row = conn.execute(
        "SELECT object_id FROM object_drawings WHERE source_file = ? LIMIT 1", (source_file,)
    ).fetchone()
    return row["object_id"] if row else None


def _guard_source_file(conn, user, source_file: str, minimum: str = "admin") -> None:
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
    assert_object_access(conn, user, object_id, minimum)


def _guard_elements(conn, user, element_ids, minimum: str = "user") -> None:
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
            assert_object_access(conn, user, row["object_id"], minimum)


def _resolve_selection_item(conn, item):
    """Подставляет актуальный чертёж объекта, если клиент прислал object_id.

    Точка перевода одна на весь показ схемы (этап B). Если пришло и то и
    другое — побеждает явный source_file: это форма «Версии чертежа
    объекта», где смысл как раз в том, чтобы посмотреть не актуальную
    версию."""
    if item.source_file or item.object_id is None:
        return item
    try:
        return item.model_copy(update={"source_file": object_source_file(conn, item.object_id)})
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/projects", response_model=list[ProjectOut])
def list_projects(user: sqlite3.Row = Depends(get_current_user)):
    """Справочник проектов. Сроки СВОДЯТСЯ из объектов (решение П5), а не
    хранятся: раннее начало и позднее окончание СМР по элементам объектов
    проекта. Так они не могут разойтись с тем, что показывают объекты."""
    conn = get_connection()
    try:
        agg = {
            r["project_id"]: r
            for r in conn.execute(
                "SELECT o.project_id, COUNT(DISTINCT o.id) AS objects_count, "
                "       COUNT(e.id) AS elements_count, "
                "       MIN(e.project_smr_start_date) AS smr_start, "
                "       MAX(e.project_delivery_date) AS smr_end "
                "FROM objects o LEFT JOIN elements e ON e.object_id = o.id AND e.is_current = 1 "
                "GROUP BY o.project_id"
            )
        }
        out = []
        for row in conn.execute("SELECT * FROM projects ORDER BY name"):
            a = agg.get(row["id"])
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
def create_project(body: ProjectIn, admin: sqlite3.Row = Depends(require_system_admin)):
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
def update_project(project_id: int, body: ProjectIn, admin: sqlite3.Row = Depends(require_system_admin)):
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
def delete_project(project_id: int, admin: sqlite3.Row = Depends(require_system_admin)):
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
        if conn.execute("SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
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
                объект["role"] = роли.get(объект["id"])
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
            exists = conn.execute("SELECT 1 FROM objects WHERE id = ?", (body.object_id,)).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="Объект не найден")
        conn.execute("UPDATE users SET last_object_id = ? WHERE id = ?", (body.object_id, user["id"]))
        conn.commit()
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
        result = []
        for row in conn.execute("SELECT * FROM objects ORDER BY id"):
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


class ObjectCreateIn(BaseModel):
    name: str
    project_id: int
    address: Optional[str] = None
    description: Optional[str] = None


@app.post("/objects", response_model=ObjectOut)
def create_object(body: ObjectCreateIn, admin: sqlite3.Row = Depends(require_system_admin)):
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
            "INSERT INTO objects (name, address, description, project_id) VALUES (?, ?, ?, ?)",
            (name, body.address, body.description, body.project_id),
        )
        conn.commit()
        new_id = conn.execute("SELECT id FROM objects WHERE name = ?", (name,)).fetchone()["id"]
    finally:
        conn.close()
    activity.log("object_create", user=admin, entity_type="object", entity_id=new_id, new_value=name)
    return next(o for o in list_objects(admin) if o.id == new_id)


@app.patch("/objects/{object_id}", response_model=ObjectOut)
def update_object(object_id: int, body: ObjectPatchIn, admin: sqlite3.Row = Depends(require_system_admin)):
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
def add_allowed_subtype(body: AllowedSubtypeIn, user: sqlite3.Row = Depends(require_system_admin)):
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
def delete_allowed_subtype(element_type: str, subtype: str, user: sqlite3.Row = Depends(require_system_admin)):
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
            item = _resolve_selection_item(conn, item)
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
            for r in conn.execute(
                "SELECT element_type, contract_id FROM default_contracts WHERE object_id = ?",
                (plan_object_id,),
            ).fetchall()
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


@app.post("/export.xlsx")
def export_xlsx(body: ExportRequestIn, user: sqlite3.Row = Depends(get_current_user)):
    if body.mode not in ("snapshot", "history"):
        raise HTTPException(status_code=422, detail="mode должен быть 'snapshot' или 'history'")
    conn = get_connection()
    try:
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
    user: sqlite3.Row = Depends(require_system_admin),
):
    try:
        result = import_dxf_file(file, source_file, UPLOADS_DIR)
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
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
            assert_object_access(conn, user, object_id, "admin")
    finally:
        conn.close()
    try:
        saved_path = save_uploaded_file(file, UPLOADS_DIR)
        name = source_file or saved_path.name
        parsed = parse_drawing(saved_path, name)
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
            assert_object_access(conn, user, analysis["object_id"], "admin")
        finally:
            conn.close()
        result = apply_drawing(
            parsed, analysis,
            accept_mark_changes=body.accept_mark_changes,
            keep_mark_element_ids=body.keep_mark_element_ids,
            refill_manual_fields=body.refill_manual_fields,
            create_new_zone_ids=body.create_new_zone_ids,
        )
    except DxfProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    forget_pending(body.token)

    counts = analysis["counts"]
    activity.log(
        "import_dxf",
        user=user,
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


@app.post("/import-history-xlsx")
def import_history_xlsx(
    file: UploadFile = File(...),
    source_file: str = Form(...),
    mode: str = Form(...),
    admin: sqlite3.Row = Depends(get_current_user),
):
    content = read_upload_limited(file.file)
    conn = get_connection()
    try:
        _guard_source_file(conn, admin, source_file)
    finally:
        conn.close()
    try:
        parsed = parse_history_xlsx(content)
        summary = import_history(conn, source_file, parsed["rows"], mode)
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
def import_contracting_xlsx(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_system_admin)):
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
def import_schedule_xlsx(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_system_admin)):
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
def export_settings(admin: sqlite3.Row = Depends(require_system_admin)):
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
def import_settings(file: UploadFile = File(...), admin: sqlite3.Row = Depends(require_system_admin)):
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

    return {
        "users_upserted": users_upserted,
        "status_colors": len(payload.get("status_colors", {})),
        "label_visibility": applied["label_visibility"],
        "label_dates_visibility": applied["label_dates_visibility"],
        "skipped_objects": sorted(skipped_objects),
    }


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

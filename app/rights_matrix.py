"""
Что пользователю доступно и в каком объёме — «матрица прав» (живой запрос
2026-08-04).

Зачем отдельный модуль. Роль отвечает на вопрос «кто он», а администратор
спрашивает другое: «что этот человек сможет сделать на этой стройке».
Раньше ответ собирался в уме по четырём ролям и полутора сотням эндпоинтов,
и ошибиться в нём было проще, чем не ошибиться: `.admin-only` (ведение
СЕРВИСА) и `.object-admin-only` (операции ВНУТРИ объекта) уже путались в
интерфейсе, а аудит 2026-08-03 нашёл пять эндпоинтов правки, проверявших
системную роль и не проверявших объект вовсе.

Что здесь лежит. Перечень РАЗДЕЛОВ И ИНСТРУМЕНТОВ системы в тех словах, в
которых о них говорит заказчик, и для каждого — минимальная роль на чтение
и на изменение. Это НЕ вторая система прав: проверки по-прежнему живут в
эндпоинтах (app/access.py и guard-функции), а здесь — их читаемое описание.
Поэтому у каждой строки указаны `sources` — где именно эта проверка стоит:
при правке прав в коде видно, что нужно поправить и здесь.

Уровни требований:
    None       — такой операции у раздела нет вовсе (например, «изменение»
                 у отчёта): в матрице это всегда «Отсутствуют»;
    "view" | "user" | "contract" | "admin"
               — роль НА ОБЪЕКТЕ не ниже указанной (app/access.py,
                 OBJECT_ROLES — лестница, а не набор);
    "system"   — администратор сервиса, объект ни при чём.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.access import (
    OBJECT_ROLES,
    ROLE_LABELS,
    is_system_admin,
    object_role,
    require_system_admin,
)
from app.db import get_connection

router = APIRouter(tags=["rights"])

SYSTEM = "system"

# (ключ, раздел, название, чтение, изменение, примечание, источники проверки)
FEATURES = [
    # ---- Схема и изделия ----
    ("plan", "Схема объекта", "Схема, карточка изделия, фильтры, 3D",
     "view", None,
     "Схема только показывает данные — «изменение» относится к самим изделиям, строки ниже.",
     ["POST /plan-data", "GET /elements", "GET /axis-grid"]),
    ("status", "Схема объекта", "Статусы изделий: смена по одному и группой",
     "view", "user",
     "Сюда же откат статуса и выбор контракта при уходе с «Запланирован».",
     ["PATCH /elements/{id}/status", "PATCH /elements/bulk-status (_guard_elements «user»)"]),
    ("history", "Схема объекта", "История статусов: правка и удаление записей",
     "view", "user",
     None,
     ["PATCH /elements/{id}/history/{hid}", "DELETE /elements/{id}/history/{hid}"]),
    ("planned_date", "Схема объекта", "Плановая дата поставки изделия",
     "view", "user",
     None,
     ["PATCH /elements/{id}/planned-delivery-date", "PATCH /elements/bulk-planned-delivery-date"]),
    ("comment", "Схема объекта", "Комментарий к изделию",
     "view", "user",
     None,
     ["PATCH /elements/{id}/comment"]),
    ("attachments", "Схема объекта", "Вложения к изделию, объекту и проекту",
     "view", "user",
     "Удаление вложения требует полных прав на объекте.",
     ["GET/POST /attachments (_guard «view»/«user»)", "DELETE /attachments/{id} (_guard «admin»)"]),
    ("element_fields", "Схема объекта", "Реквизиты изделий: правка полей и справочник элементов",
     "view", "admin",
     "Правка того, что пришло из чертежа (марка, отметка, зоны, этаж), — операция уровня объекта.",
     ["PATCH /elements/{id}/fields"]),
    ("export", "Схема объекта", "Выгрузка схемы в XLSX и PDF",
     "view", None,
     None,
     ["POST /export.xlsx", "GET /export.pdf"]),

    # ---- Зоны и чертёж ----
    ("zones", "Зоны и чертёж", "Зоны: захватки, краны, стоянки",
     "view", "admin",
     "Сюда же пересчёт привязки изделий к зонам и вывод зон из работы.",
     ["GET /zones (assert_object_access «view»)", "PATCH/DELETE /zones/{id} («admin»)"]),
    ("zone_colors", "Зоны и чертёж", "Цвета зон",
     "view", "admin", None,
     ["GET /zone-colors (require_object_access)", "PUT /zone-colors (require_object_admin)"]),
    ("drawings", "Зоны и чертёж", "Чертежи: загрузка DXF и переимпорт версии",
     "view", "admin",
     "Переимпорт переписывает геометрию всего объекта — поэтому полные права на объекте.",
     ["GET /objects/{id}/drawings («view»)", "POST /import-dxf/analyze и /apply («admin»)"]),

    # ---- Контрактация ----
    ("contracts", "Контрактация", "Контракты и их позиции",
     "view", "contract", None,
     ["GET /contracts (по доступным объектам)", "POST/PATCH /contracts («contract»)"]),
    ("agreements", "Контрактация", "Договоры и спецификации",
     "view", "contract", None,
     ["POST/PATCH /agreements, /specifications («contract»)"]),
    ("counterparties", "Контрактация", "Справочник контрагентов",
     "view", "contract",
     "Справочник общесервисный: правка открыта тому, кто комплектовщик хотя бы на одном объекте "
     "(require_contracting), — договор заводится НА контрагента, и завести его иначе было бы некому.",
     ["GET /counterparties/full", "POST/PATCH /counterparties (require_contracting)"]),
    ("default_contracts", "Контрактация", "Контракт по умолчанию по типу изделия",
     "view", "contract", None,
     ["GET /contracts/default-map", "PUT /contracts/default-map"]),

    # ---- Отчёты ----
    ("reports", "Отчёты", "Отчёты: статусы, динамика, график поставки, комплектация, моя работа",
     "view", None,
     "Отчёт только читает данные; выгрузка в XLSX и PDF — та же операция чтения.",
     ["POST /reports/*"]),
    ("report_notes", "Отчёты", "Примечания к отчётам",
     "view", "admin", None,
     ["GET /report-notes (require_object_access)", "PUT/DELETE /report-notes (require_object_admin)"]),
    ("activity", "Отчёты", "Журнал действий по объекту",
     "view", None,
     "Чистка журнала — операция ведения сервиса, строка «Журнал действий» ниже.",
     ["GET /elements/{id}/activity", "GET /objects/{id}/activity-users"]),

    # ---- Настройки объекта ----
    ("label_visibility", "Настройки объекта", "Видимость подписей марок и дат по типам",
     "view", "admin", None,
     ["GET/PUT /label-visibility", "GET/PUT /label-dates-visibility"]),
    ("info_plate", "Настройки объекта", "Порог опоздания поставки",
     "view", "admin", None,
     ["GET/PUT /info-plate-settings"]),
    ("project_card", "Настройки объекта", "Карточка проекта и объекта",
     "view", "admin", None,
     ["GET /project-card (require_object_access)", "PUT /project-card (require_object_admin)"]),

    # ---- Загрузки файлами ----
    ("import_history", "Загрузка данных файлом", "Импорт истории статусов",
     "view", "admin", None,
     ["POST /import-history-xlsx (_guard_source_file «admin»)"]),
    ("bulk_edit", "Загрузка данных файлом", "Массовая правка реквизитов и истории через Excel",
     SYSTEM, SYSTEM,
     "Пока за администратором сервиса: отбор строк по доступным объектам ещё не сделан "
     "(хвост этапа C, см. CLAUDE.md).",
     ["POST /elements/bulk-edit/export|analyze|apply (require_system_admin)"]),
    ("import_contracting", "Загрузка данных файлом", "Импорт файла контрактации",
     SYSTEM, SYSTEM,
     "Заводит контрагентов, договоры и спецификации сразу по всему файлу — операция ведения сервиса.",
     ["POST /import-contracting-xlsx (require_system_admin)"]),
    ("import_schedule", "Загрузка данных файлом", "Импорт графика MS Project",
     SYSTEM, SYSTEM, None,
     ["POST /import-schedule-xlsx (require_system_admin)"]),

    # ---- Ведение сервиса ----
    ("users", "Ведение сервиса", "Пользователи, права и сеансы",
     SYSTEM, SYSTEM, None,
     ["GET/POST/PATCH /users*", "PUT /users/{id}/access"]),
    ("projects", "Ведение сервиса", "Проекты и объекты",
     "view", SYSTEM,
     "Видно те проекты и объекты, к которым есть доступ; заводить и править их может "
     "администратор сервиса.",
     ["GET /projects-tree", "POST/PATCH /projects, /objects (require_system_admin)"]),
    ("dictionaries", "Ведение сервиса", "Справочники: подтипы, префиксы марок, цвета статусов",
     "view", SYSTEM, None,
     ["PUT /status-colors", "POST/DELETE /subtypes, /mark-type-prefixes (require_system_admin)"]),
    ("backups", "Ведение сервиса", "Резервные копии и состояние БД",
     SYSTEM, SYSTEM, None,
     ["GET/POST /backups*", "GET /db-status*"]),
    ("activity_log", "Ведение сервиса", "Журнал действий сервиса и его очистка",
     SYSTEM, SYSTEM, None,
     ["GET /activity", "DELETE /activity (require_system_admin)"]),
    ("ldap", "Ведение сервиса", "Доменная авторизация",
     SYSTEM, SYSTEM, None,
     ["GET/PUT /ldap-settings (require_system_admin)"]),

    # ---- Своё ----
    ("own_settings", "Личные настройки", "Гамма, ракурс 3D, порог показа подписей, свой пароль",
     "self", "self",
     "Своё меняет каждый сам, независимо от роли; чужое — администратор сервиса.",
     ["PATCH /users/{id}/ui-theme, /view3d, /min-label-px, /set-password"]),
]

LEVELS = {"none": "Отсутствуют", "read": "Только чтение", "write": "Изменение"}


def _meets(role: Optional[str], required: Optional[str]) -> bool:
    """Роль на объекте не ниже требуемой. role=None — доступа к объекту нет."""
    if role is None or required is None:
        return False
    return OBJECT_ROLES.index(role) >= OBJECT_ROLES.index(required)


def feature_level(feature, *, system_admin: bool, role: Optional[str]) -> str:
    """Уровень доступа к одному разделу: none / read / write.

    Порядок проверок повторяет порядок в самих эндпоинтах: сначала
    администратор сервиса (он проходит всё в обход грантов, см.
    app/access.py), потом роль на объекте.
    """
    _, _, _, read_req, write_req, _, _ = feature
    if read_req == "self":  # своё — у каждого своё, роль ни при чём
        return "write"
    if system_admin:
        return "write" if write_req is not None else "read"
    if write_req == SYSTEM and read_req == SYSTEM:
        return "none"
    if write_req is not None and write_req != SYSTEM and _meets(role, write_req):
        return "write"
    if read_req == SYSTEM:
        return "none"
    if read_req is not None and _meets(role, read_req):
        return "read"
    return "none"


def rights_for(conn, user_row, object_id: Optional[int]) -> dict:
    """Матрица одного пользователя на одном объекте.

    object_id=None — объект не выбран (или у человека нет ни одного
    доступного): считаем по «доступа к объекту нет», и видно ровно то, что
    даёт системная роль.
    """
    system_admin = is_system_admin(user_row)
    role = object_role(conn, user_row, object_id) if object_id is not None else None
    rows = []
    for feature in FEATURES:
        key, section, title, read_req, write_req, note, sources = feature
        rows.append({
            "key": key, "section": section, "title": title, "note": note,
            "sources": sources,
            "level": feature_level(feature, system_admin=system_admin, role=role),
        })
    return {
        "user_id": user_row["id"],
        "object_id": object_id,
        "object_role": role,
        "object_role_label": ROLE_LABELS.get(role) if role else None,
        "system_admin": system_admin,
        "features": rows,
    }


@router.get("/users/{user_id}/rights-matrix")
def user_rights_matrix(
    user_id: int,
    object_id: Optional[int] = Query(None),
    admin: sqlite3.Row = Depends(require_system_admin),
):
    """«На что у человека есть права» — разделы системы против объёма прав.

    Считается ДЛЯ ОБЪЕКТА: роль — свойство гранта, а не пользователя, и
    один человек бывает прорабом на одном здании и наблюдателем на соседнем
    (app/access.py). Объект не передан — показываем картину «доступа к
    объекту нет», то есть ровно то, что даёт системная роль.
    """
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        if object_id is not None and conn.execute(
                "SELECT 1 FROM objects WHERE id = ?", (object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        return rights_for(conn, row, object_id)
    finally:
        conn.close()


@router.get("/users/access-matrix")
def access_matrix(admin: sqlite3.Row = Depends(require_system_admin)):
    """Гранты ВСЕХ пользователей разом — для групповой настройки прав.

    Отдельный эндпоинт, а не GET /users/{id}/access в цикле: у формы по
    вертикали список пользователей, и запрос на каждого означал бы столько
    же запросов на одно открытие. Сами пользователи здесь НЕ возвращаются —
    их клиент берёт обычным GET /users: правка системной роли отправляется
    полным телом (UserUpdateIn), и второй, урезанный список пользователей
    рядом с полным разъехался бы на первом же новом поле.

    Действующие роли (object_roles) тоже не считаются: форма правит ГРАНТЫ,
    а унаследованное показывает сама — тем же правилом «частный перекрывает
    общий», что и дерево в карточке пользователя.
    """
    conn = get_connection()
    try:
        grants = {}
        for r in conn.execute(
            "SELECT user_id, project_id, object_id, role FROM user_access"
        ).fetchall():
            grants.setdefault(str(r["user_id"]), []).append(
                {"project_id": r["project_id"], "object_id": r["object_id"], "role": r["role"]})
        return {"grants": grants, "role_labels": ROLE_LABELS}
    finally:
        conn.close()

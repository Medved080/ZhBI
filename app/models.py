import re
from enum import Enum
from typing import Optional

from pydantic import BaseModel, field_validator

# Цвет, приходящий от клиента. Проверяется на СЕРВЕРЕ, потому что попадает
# он в инлайновый `style="..."` на схеме и в карточке элемента, а `style-src`
# в CSP вынужденно держит 'unsafe-inline' (динамических цветов статусов и
# зон слишком много, чтобы выносить их в классы) — то есть CSP тут не
# подстрахует (аудит безопасности 2026-08-03).
#
# Цвет зоны пишет админ ОБЪЕКТА, а видят его все, включая администратора
# сервиса, — без этой проверки значение вида `#fff" onmouseover="...`
# выходило из атрибута и давало повышение привилегий «админ объекта →
# админ сервиса». На клиенте такая проверка уже была (`statusColor()` в
# app/static/app.js), но применялась не во всех местах вывода; правильное
# место для неё — вход, а не каждый из выводов.
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


def validate_color(value: str, field: str = "Цвет") -> str:
    if not isinstance(value, str) or not _COLOR_RE.match(value.strip()):
        raise ValueError(f"{field} должен быть в формате #RGB/#RRGGBB (получено: {value!r})")
    return value.strip()


class Status(str, Enum):
    PLANNED = "planned"  # запланирован
    CONTRACTING = "contracting"  # контрактация
    IN_PRODUCTION = "in_production"  # в производстве
    SHIPPED = "shipped"  # отгружен
    DELIVERED = "delivered"  # доставлен на площадку
    INSTALLED = "installed"  # смонтирован
    ACCEPTED = "accepted"  # принят


# Порядок статусов для сортировки/отображения на дашборде — сами переходы
# статуса в API пока не валидируются по порядку (можно откатить назад или
# пропустить шаг, включая пропуск "Контрактация" — см. Docs/backlog.md,
# третий раунд, п.1), это осознанное упрощение первой версии.
STATUS_ORDER = [
    Status.PLANNED,
    Status.CONTRACTING,
    Status.IN_PRODUCTION,
    Status.SHIPPED,
    Status.DELIVERED,
    Status.INSTALLED,
    Status.ACCEPTED,
]

STATUS_LABELS_RU = {
    Status.PLANNED: "Запланирован",
    Status.CONTRACTING: "Контрактация",
    Status.IN_PRODUCTION: "В производстве",
    Status.SHIPPED: "Отгружен",
    Status.DELIVERED: "Доставлен",
    Status.INSTALLED: "Смонтирован",
    Status.ACCEPTED: "Принят",
}


class ElementOut(BaseModel):
    # Поля, правленные РУКАМИ в справочнике элементов (этап 3, решение Э4).
    # Объявлены в модели явно: без этого pydantic срезал их из ответа, и
    # интерфейс не мог показать, что значение здесь «своё», а не из чертежа
    # (поймано живой проверкой — пометки не появлялись).
    manual_fields: Optional[list[str]] = None
    id: int
    source_file: str
    dxf_handle: str
    layer: str
    element_type: str
    mark: Optional[str]
    # Ссылка на запись справочника марок (2026-08-05). Объявлена ЯВНО по той
    # же причине, что и поля нового стандарта ниже: без объявления pydantic
    # срезал бы её из ответа, и форма элемента не могла бы показать, что
    # стоит в ссылке, — а пока текст и ссылка живут рядом, это единственное
    # место, где видно, что они разошлись.
    mark_id: Optional[int] = None
    mark_source: str
    x: float
    y: float
    z: float
    address: Optional[str]
    axis_status: str
    axis_number: Optional[str]
    axis_letter: Optional[str]
    nearest_axis_number: Optional[str]
    nearest_axis_letter: Optional[str]
    offset_x_mm: Optional[float]
    offset_y_mm: Optional[float]
    # Поля нового стандарта имён слоёв. Объявлены здесь ЯВНО: без этого
    # pydantic срезал их из ответа /elements/{id}, и форма правки показывала
    # подтип, отметку и этаж пустыми, хотя в таблице справочника (свой
    # эндпоинт, без модели) значения были — живой репорт со скриншотом.
    subtype: Optional[str] = None
    elevation_mm: Optional[int] = None
    floor: Optional[int] = None
    current_status: Status
    contract_id: Optional[int] = None
    # Денормализованный скаляр для допстроки подписи на схеме (см.
    # Docs/backlog.md) — вычисляется на сервере (JOIN по цепочке
    # contract->specification->agreement->counterparty), не хранится как
    # отдельная колонка elements. Ранее — contract_code (контракт нёс
    # свой code); "Контрактация 2.0" переносит короткий код на
    # counterparties.code.
    counterparty_code: Optional[str] = None
    # "Контрактация 2.0" (см. Docs/backlog.md) — четыре независимые шкалы
    # дат поставки. planned/actual — простые живые поля элемента (партии
    # убраны); project_* — заполняются импортом графика MS Project по
    # блоку Кран/Стоянка/Этаж/Тип/Подтип (app/schedule_import.py).
    planned_delivery_date: Optional[str] = None
    project_delivery_date: Optional[str] = None
    project_smr_start_date: Optional[str] = None
    actual_delivery_date: Optional[str] = None
    # Привязка к зонам и к объекту. Объявлены здесь по той же причине, что
    # subtype/elevation_mm/floor выше: pydantic срезает всё, чего нет в
    # модели, и форма элемента показывала бы пустые поля там, где в БД
    # значение есть. Форма правит их не напрямую (зоны считаются по
    # геометрии, см. app/zone_recalc.py) — но показать обязана.
    zone_zakhvatka_id: Optional[int] = None
    zone_zakhvatka_status: Optional[str] = None
    zone_crane_id: Optional[int] = None
    zone_crane_status: Optional[str] = None
    zone_stance_id: Optional[int] = None
    zone_stance_status: Optional[str] = None
    zone_stance_level_id: Optional[int] = None
    object_id: Optional[int] = None
    element_uid: Optional[str] = None
    is_current: Optional[int] = None
    # Произвольный комментарий (2026-08-02). Объявлен ЯВНО по той же
    # причине, что subtype/elevation_mm выше: pydantic срезает всё, чего
    # нет в модели, и карточка показывала бы пустое поле там, где в базе
    # текст есть.
    comment: Optional[str] = None
    created_at: str
    updated_at: str


class StatusHistoryOut(BaseModel):
    id: int
    status: Status
    changed_at: str
    changed_by: Optional[str]
    comment: Optional[str]
    contract_id: Optional[int] = None


class ElementDetailOut(ElementOut):
    history: list[StatusHistoryOut]
    # Названия того, на что элемент ссылается по id, — чтобы форма элемента
    # печатала «Кран 1», а не «#32345». Заполняются ТОЛЬКО в
    # GET /elements/{id} (см. _element_reference_labels в app/main.py): в
    # /plan-data те же названия у клиента уже есть в state.zones, и JOIN на
    # 9422 строки там был бы лишним. У остальных наследников
    # (StatusUpdateResult и др.) остаются None — это нормально, там их не
    # показывают.
    zone_zakhvatka_name: Optional[str] = None
    zone_crane_name: Optional[str] = None
    zone_stance_name: Optional[str] = None
    zone_stance_level_elevation_mm: Optional[int] = None
    object_name: Optional[str] = None
    # Контур — сам JSON наружу не отдаём (в форме от него толку нет, он
    # рисуется на схеме), но факт наличия геометрии и её объём показать надо.
    outline_points: Optional[int] = None
    # Прогноз по последней актуализации графика и отклонение от директивных
    # дат (2026-08-14, см. app/schedule_versions.py). None — актуализаций у
    # объекта ещё нет либо это изделие в них не попало.
    schedule_forecast: Optional[dict] = None


class ContractWarning(BaseModel):
    contract_id: int
    contract_name: str
    quantity: int
    fact: int
    damaged: int = 0


class StatusUpdateResult(ElementDetailOut):
    contract_warning: Optional[ContractWarning] = None


class StatusUpdateIn(BaseModel):
    status: Status
    comment: Optional[str] = None
    changed_at: Optional[str] = None  # "рабочая дата" из тулбара; пусто — сейчас (см. Docs/backlog.md п.8)
    # Явно выбранный контракт при уходе со статуса "Запланирован" (диалог
    # подтверждения в UI). Если не передан, но переход требует контракта,
    # значение наследуется от предыдущей записи истории — см. п.2 третьего
    # раунда и check_contract_after_status_change в app/contracts.py.
    contract_id: Optional[int] = None


class BulkStatusItem(BaseModel):
    element_id: int
    # null = "без контракта" — явный, осознанный выбор в таблице массовой
    # смены статуса (см. Docs/backlog.md), а не пропуск поля, поэтому в
    # отличие от StatusUpdateIn.contract_id тут нет отдельной "явности" —
    # эта пара всегда обязательна для КАЖДОГО элемента пачки.
    contract_id: Optional[int] = None


class BulkStatusUpdateIn(BaseModel):
    items: list[BulkStatusItem]
    status: Status
    changed_at: Optional[str] = None


class BulkStatusUpdateResult(BaseModel):
    updated: list[StatusUpdateResult]


class ElementPlannedDateIn(BaseModel):
    # null — явно снять плановую дату. Простое живое поле элемента (см.
    # app/element_dates.py) — НЕ версионируется по status_history, партии
    # убраны (см. Docs/backlog.md, "Контрактация 2.0").
    planned_delivery_date: Optional[str] = None


class ElementPlannedDateUpdateResult(ElementDetailOut):
    pass


class BulkPlannedDateItem(BaseModel):
    element_id: int
    planned_delivery_date: Optional[str] = None


class BulkPlannedDateUpdateIn(BaseModel):
    items: list[BulkPlannedDateItem]


class BulkPlannedDateUpdateResult(BaseModel):
    updated: list[ElementPlannedDateUpdateResult]


class StatusSummaryEntry(BaseModel):
    status: Status
    label: str
    count: int


class PlanSelectionItem(BaseModel):
    # source_file необязателен с этапа B (2026-08-01): единица показа —
    # ОБЪЕКТ, клиент присылает object_id, а актуальный чертёж выводит сервер
    # (app/db.object_source_file). Поле оставлено ради совместимости и ради
    # одного оставшегося сценария — показать КОНКРЕТНУЮ версию чертежа
    # объекта в форме «Версии чертежа».
    source_file: Optional[str] = None
    object_id: Optional[int] = None
    layers: Optional[list[str]] = None  # None — все слои файла


class PlanSelectionIn(BaseModel):
    selection: list[PlanSelectionItem]


class ExportRequestIn(BaseModel):
    # POST, а не GET+query — element_ids может нести тысячи id (экспорт с
    # учётом текущего фильтра на схеме, см. Docs/backlog.md), не влезает в
    # длину URL. Сами фильтры (passesPlacementFilters) целиком живут на
    # фронтенде — сюда приходит уже готовый список id, не критерии фильтра.
    mode: str  # "snapshot" | "history"
    source_file: Optional[str] = None
    date: Optional[str] = None  # для mode="snapshot"
    date_from: Optional[str] = None  # для mode="history"
    date_to: Optional[str] = None  # для mode="history"
    element_ids: Optional[list[int]] = None  # None — без ограничения (все элементы)


SHAPES = ("circle", "square", "triangle", "diamond", "hexagon", "outline")


class ElementShapeIn(BaseModel):
    layer: str
    element_type: str
    shape: str


# Дублирует layer_naming.ZHBI_TYPES (scripts/) — держим отдельной константой
# здесь, чтобы app/main.py не зависел от порядка попадания scripts/ в
# sys.path (см. app/dxf_import.py).
ZHBI_ELEMENT_TYPES = ("Колонна", "Ригель", "Панель", "Плита перекрытия")


class ZoneLevelOut(BaseModel):
    id: int
    elevation_mm: Optional[int] = None
    points: int  # число вершин контура — сам контур в списке не нужен
    source_file: Optional[str] = None


class ZoneOut(BaseModel):
    """Запись справочника зон (этап 2). Одна зона — произвольный набор
    ярусов-полигонов, см. Docs/TZ.md 3.0а."""
    id: int
    category: str
    number: Optional[int] = None
    name: Optional[str] = None
    parent_zone_id: Optional[int] = None
    parent_name: Optional[str] = None
    is_current: bool = True
    match_status: Optional[str] = None
    levels: list[ZoneLevelOut] = []
    elements: int = 0  # сколько элементов привязано к этой зоне


class ZoneLevelIn(BaseModel):
    id: Optional[int] = None  # None — новый ярус
    elevation_mm: Optional[int] = None
    outline: list[list[float]]


class ZonePatchIn(BaseModel):
    number: Optional[int] = None
    name: Optional[str] = None
    parent_zone_id: Optional[int] = None
    levels: list[ZoneLevelIn]


class ProjectIn(BaseModel):
    name: str
    address: Optional[str] = None
    description: Optional[str] = None


class ProjectOut(ProjectIn):
    id: int
    objects_count: int = 0
    elements_count: int = 0
    # Сроки проекта НЕ хранятся, а сводятся из сроков подчинённых объектов
    # (решение П5): раннее начало и позднее окончание СМР. Так они не могут
    # разойтись с объектами.
    smr_start: Optional[str] = None
    smr_end: Optional[str] = None


class ObjectOut(BaseModel):
    id: int
    name: str
    address: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    description: Optional[str] = None
    current_source_file: Optional[str] = None
    drawings: list[str] = []
    elements_current: int = 0
    elements_retired: int = 0


class ObjectPatchIn(BaseModel):
    name: str
    address: Optional[str] = None
    # Перенос объекта в другой проект. None означает «не менять» — иначе
    # форма, не приславшая поле, молча выкинула бы объект из проекта.
    project_id: Optional[int] = None
    description: Optional[str] = None


class AllowedSubtypeIn(BaseModel):
    element_type: str
    subtype: str
    # Объект, в чей справочник добавляем (2026-08-21): справочник подтипов
    # принадлежит зданию, а не системе. Optional только ради внятного
    # отказа на стороне сервера вместо 422 от валидатора — см.
    # main._subtypes_object.
    object_id: Optional[int] = None


class ZoneColorIn(BaseModel):
    # source_file убран на этапе D (2026-08-02): цвет крана принадлежит
    # ОБЪЕКТУ, объект приходит одним query-параметром на весь запрос.
    # Пока файл был в ключе, один и тот же кран красился заново на каждую
    # новую версию чертежа.
    name: str
    color: str

    @field_validator("color")
    @classmethod
    def _color_ok(cls, v: str) -> str:
        return validate_color(v, "Цвет зоны")


class ZoneImportSummary(BaseModel):
    total: int
    by_category: dict[str, int]
    needs_review: int  # зон, требующих проверки (нет названия или несколько кандидатов)
    element_bindings_needs_review: dict[str, int]  # по категориям — сколько ПРИВЯЗОК элементов needs_review


class DxfImportResult(BaseModel):
    source_file: str
    inserted: int
    updated: int
    total: int
    by_mark_source: dict[str, int]
    by_axis_status: dict[str, int]
    axis_grid: dict[str, int]
    zones: Optional[ZoneImportSummary] = None
    # Итоги сверки с прежней версией чертежа (см. app/element_sync.py). None
    # у путей импорта, которые сверку не делают — таких сейчас нет, но поле
    # необязательное, чтобы старые клиенты не падали на его отсутствии.
    object_id: Optional[int] = None
    retired: int = 0
    matched_by_handle: int = 0
    matched_by_geometry: int = 0
    marks_kept: int = 0
    # Сколько правленых руками полей сохранено (не перезаписано чертежом).
    manual_kept: int = 0


class DxfAnalyzeResult(BaseModel):
    """Первая фаза импорта (решение И3): что ИЗМЕНИТСЯ, если применить этот
    чертёж. Ни одной записи в БД к моменту ответа не сделано."""
    token: str
    source_file: str
    object_id: int
    object_name: str
    previous_source_file: Optional[str] = None
    counts: dict[str, int]
    details: dict[str, list[dict]]
    detail_limit: int
    zones: Optional[ZoneImportSummary] = None
    axis_grid: dict[str, int]
    by_mark_source: dict[str, int]
    by_axis_status: dict[str, int]


class DxfApplyIn(BaseModel):
    token: str
    # Решения по ПРАВЛЕННЫМ РУКАМИ полям (решение Э4): {id элемента: [поля,
    # которые перезаполнить из чертежа]}. Ключи приходят строками — таков
    # JSON. Чего здесь нет, то сохраняет ручное значение: поведение по
    # умолчанию — не терять правку человека.
    refill_manual_fields: dict[str, list[str]] = {}
    # Зоны, для которых пользователь выбрал «создать новую запись справочника»
    # вместо правки существующей (решение З1). Прежняя запись помечается
    # неактуальной. Чего здесь нет — обновляется как раньше.
    create_new_zone_ids: list[int] = []
    # Решение по смене марки (И4): по умолчанию принимаем, но пользователь
    # может оставить прежние марки — либо все разом, либо перечислением.
    accept_mark_changes: bool = True
    keep_mark_element_ids: list[int] = []


class RevitAnalyzeResult(BaseModel):
    """Первая фаза загрузки пакетов Revit: что появится в справочниках
    объекта. В БД к моменту ответа не записано ничего.

    Поля `sections`, `levels` и элементы списков приходят словарями с
    РУССКИМИ ключами — так их отдаёт app/revit_catalog, и так они попадают
    прямо в сводку интерфейса без переименований по дороге."""
    token: str
    object_id: int
    object_name: str
    packages: list[dict]
    known_sections: list[dict]
    sections: dict
    levels: dict
    elements: dict
    warnings: list[str]


class RevitApplyIn(BaseModel):
    token: str


class RevitImportResult(BaseModel):
    object_id: int
    sections_added: int
    levels_added: int
    aliases_added: int
    packages: int
    elements: int
    rooms: int
    retired: int
    flats: int

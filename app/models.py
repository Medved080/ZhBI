from enum import Enum
from typing import Optional

from pydantic import BaseModel


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
    id: int
    source_file: str
    dxf_handle: str
    layer: str
    element_type: str
    mark: Optional[str]
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
    source_file: str
    layers: Optional[list[str]] = None  # None — все слои файла


class PlanSelectionIn(BaseModel):
    selection: list[PlanSelectionItem]


SHAPES = ("circle", "square", "triangle", "diamond", "hexagon", "outline")


class ElementShapeIn(BaseModel):
    layer: str
    element_type: str
    shape: str


# Дублирует layer_naming.ZHBI_TYPES (scripts/) — держим отдельной константой
# здесь, чтобы app/main.py не зависел от порядка попадания scripts/ в
# sys.path (см. app/dxf_import.py).
ZHBI_ELEMENT_TYPES = ("Колонна", "Ригель", "Плита", "Панель", "Плита перекрытия")


class AllowedSubtypeIn(BaseModel):
    element_type: str
    subtype: str


class ZoneColorIn(BaseModel):
    source_file: str
    name: str
    color: str


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

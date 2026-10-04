from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, BeforeValidator, model_validator

Number = Annotated[Decimal, Field(ge=0, le=Decimal("1e12"), allow_inf_nan=False)]
OptionalNumber = Annotated[Number | None, BeforeValidator(lambda value: None if value == "" else value)]
Name = Annotated[str, Field(min_length=1, max_length=100)]
Code = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,80}$")]


class Geometry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    length: Annotated[Decimal, Field(ge=Decimal(".01"), le=100)]
    width: Annotated[Decimal, Field(ge=Decimal(".01"), le=20)]
    height: Annotated[Decimal, Field(ge=Decimal(".01"), le=20)]


class ProductInput(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    name: Name
    concreteClass: Annotated[str, Field(min_length=1, max_length=20)] = "В50"
    volume: Annotated[Decimal, Field(ge=0, le=Decimal("1e9"), allow_inf_nan=False)]
    weight: Number = Decimal(0)
    hours: Number = Decimal(0)
    concreteRate: Number = Decimal("7054.540983606557377049180327868852459016")
    otherMaterials: Number | None = None
    material: Number | None = None  # Accepted only for importing the existing browser version.
    geometry: Geometry | None = None
    volumeFromGeometry: bool = False
    source: Literal["manual", "excel", "project"] = "manual"
    documentModelId: Annotated[str, Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$")] | None = None

    @model_validator(mode="after")
    def parameters(self):
        self.name = self.name.strip()
        self.concreteClass = self.concreteClass.strip()
        if not self.name or not self.concreteClass:
            raise ValueError("Марка изделия и класс бетона обязательны")
        from .document_models import model
        document = model(self.documentModelId)
        if self.documentModelId and not document:
            raise ValueError("Изделие отсутствует в каталоге проектной документации")
        if self.volume == 0 and not (document and document.get("kind") == "registry" and document.get("projectVolume") is None):
            raise ValueError("Объём бетона должен быть больше нуля")
        if self.volumeFromGeometry:
            if self.documentModelId:
                raise ValueError("Для изделия по чертежу объём нельзя считать по прямоугольным габаритам")
            if not self.geometry:
                raise ValueError("Для расчёта объёма нужны габариты")
            self.volume = self.geometry.length * self.geometry.width * self.geometry.height
        if self.otherMaterials is None:
            self.otherMaterials = self.material - self.volume * self.concreteRate if self.material is not None else Decimal(0)
        if self.otherMaterials < 0:
            raise ValueError("Стоимость материалов меньше стоимости бетона")
        return self


class Override(BaseModel):
    model_config = ConfigDict(extra="forbid")
    qty: OptionalNumber = None
    rate: OptionalNumber = None
    amount: OptionalNumber = None


class ExtraLine(BaseModel):
    id: Code
    name: Name
    unit: Annotated[str, Field(min_length=1, max_length=20)] = "компл."
    qty: Number = Decimal(1)
    rate: Number = Decimal(0)
    detail: Annotated[str, Field(max_length=1000)] = "Пользовательская статья входит в базу прибыли."


class ProductSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product: ProductInput
    overrides: dict[Code, Override] = Field(default_factory=dict, max_length=1000)
    extra: list[ExtraLine] = Field(default_factory=list, max_length=1000)
    expectedVersion: int = Field(ge=0)
    requestId: UUID = Field(default_factory=uuid4)
    # Поля, которые пользователь задал вручную и которые поэтому не пересчитываются при смене норм и расценок.
    # None — не менять то, что уже сохранено; [] — вернуть все поля к расчёту по нормам и прайсу.
    manualFields: list[Literal["volume", "hours", "concreteRate", "otherMaterials"]] | None = None

    @model_validator(mode="after")
    def rows(self):
        codes = [row.id for row in self.extra]
        core = {"concrete", "rest", "labour", "soc", "energy", "overhead", "admin", "commercial", "profit", "delivery"}
        if self.product.documentModelId:
            from .document_models import model
            core |= {r["id"] for r in model(self.product.documentModelId)["resources"]}
        if len(set(codes)) != len(codes) or set(codes) & core:
            raise ValueError("Коды дополнительных строк должны быть уникальными")
        if set(self.overrides) - (core | set(codes)):
            raise ValueError("Корректировка относится к неизвестной строке")
        margin = self.overrides.get("profit")
        if margin and margin.qty is not None and margin.qty >= 100:
            raise ValueError("Маржа должна быть меньше 100%")
        return self


class ProfileSave(BaseModel):
    """Проценты начислений и НДС профиля расчёта (ставка труда и цена бетона живут в прайс-листе)."""
    model_config = ConfigDict(extra="forbid")
    expectedVersion: int = Field(ge=1)
    socialPercent: Annotated[Decimal, Field(ge=0, lt=100)]
    energyPercent: Annotated[Decimal, Field(ge=0, lt=1000)]
    overheadPercent: Annotated[Decimal, Field(ge=0, lt=1000)]
    adminPercent: Annotated[Decimal, Field(ge=0, lt=1000)]
    commercialPercent: Annotated[Decimal, Field(ge=0, lt=1000)]
    profitPercent: Annotated[Decimal, Field(ge=0, lt=100)]
    deliveryPercent: Annotated[Decimal, Field(ge=0, lt=1000)]
    vatPercent: Annotated[Decimal, Field(ge=0, lt=100)]


class Login(BaseModel):
    login: Annotated[str, Field(min_length=1, max_length=100)]
    password: Annotated[str, Field(min_length=1, max_length=256)]


class UserCreate(Login):
    displayName: Name
    role: Literal["admin", "editor", "viewer"] = "editor"
    @model_validator(mode="after")
    def password_strength(self):
        if len(self.password) < 12:
            raise ValueError("Пароль должен содержать минимум 12 символов")
        return self


class BrowserProduct(BaseModel):
    product: ProductInput
    overrides: dict[Code, Override] = Field(default_factory=dict)
    extra: list[ExtraLine] = Field(default_factory=list)
    legacyKey: str | None = Field(default=None, max_length=100)


class BrowserImport(BaseModel):
    browserId: UUID
    products: list[BrowserProduct] = Field(max_length=1000)

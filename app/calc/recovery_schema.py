"""Bounded, declarative drawing recovery. Model output is never executable code."""
from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


Coordinate = Annotated[float, Field(ge=-100000, le=100000)]
Point = tuple[Coordinate, Coordinate, Coordinate]
Point2 = tuple[Coordinate, Coordinate]
Evidence = Annotated[list[str], Field(min_length=1, max_length=30)]


class ConnectionConfig(StrictModel):
    provider: Literal['openai', 'ollama'] = 'ollama'
    baseUrl: str = Field(default='http://127.0.0.1:11434', max_length=500)
    model: str = Field(default='', max_length=200)
    timeoutSeconds: int = Field(default=180, ge=10, le=600)
    maxTokens: int = Field(default=16384, ge=512, le=32768)
    imageSide: int = Field(default=1400, ge=768, le=2000)
    useTiles: bool = True
    maxPages: int = Field(default=24, ge=1, le=60)
    repairAttempts: int = Field(default=1, ge=0, le=2)


class BatchCreate(StrictModel):
    requestId: UUID
    productIds: list[UUID] = Field(min_length=1, max_length=1008)
    additionalPages: list[int] = Field(default_factory=list, max_length=30)
    @model_validator(mode='after')
    def unique(self):
        if len(set(self.productIds)) != len(self.productIds):
            raise ValueError('Повторяющиеся изделия')
        if self.additionalPages and len(self.productIds) != 1:
            raise ValueError('Дополнительные страницы задаются для одного изделия')
        return self


class PublishRequest(StrictModel):
    expectedSha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    acknowledgePartial: Literal[True]


class Fact(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    subject: str = Field(min_length=1, max_length=200)
    property: str = Field(min_length=1, max_length=100)
    value: str | None = Field(max_length=500)
    unit: str = Field(default='', max_length=30)
    quote: str = Field(min_length=1, max_length=500)
    bbox: tuple[float, float, float, float] = Field(description='x,y,w,h, нормализованные координаты полного листа')
    @model_validator(mode='after')
    def valid_region(self):
        x,y,w,h=self.bbox
        if min(x,y)<0 or min(w,h)<=0 or x+w>1.001 or y+h>1.001:
            raise ValueError('Фрагмент выходит за страницу')
        return self


class PageReading(StrictModel):
    facts: list[Fact] = Field(max_length=300)
    unreadable: list[str] = Field(max_length=100)
    references: list[str] = Field(max_length=100)


class Component(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    expectedCount: int | None = Field(default=None, ge=0, le=10000)
    lengthMm: float | None = Field(default=None, gt=0, le=100000)
    evidence: Evidence


class Hole(StrictModel):
    type: Literal['circle', 'polygon']
    center: Point2 | None = None
    radius: float | None = Field(default=None, gt=0, le=10000)
    points: list[Point2] | None = Field(default=None, min_length=3, max_length=100)
    @model_validator(mode='after')
    def complete(self):
        if self.type=='circle' and (self.center is None or self.radius is None):
            raise ValueError('Нужны центр и радиус отверстия')
        if self.type=='polygon' and self.points is None:
            raise ValueError('Нужен контур отверстия')
        return self


class Volume(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    componentId: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    profile: list[Point2] = Field(min_length=3, max_length=100)
    origin: Point
    u: Point
    v: Point
    direction: Point
    depth: float = Field(gt=0, le=100000)
    holes: list[Hole] = Field(default_factory=list, max_length=200)
    evidence: Evidence
    certainty: Literal['confirmed','uncertain']


class BarSet(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    componentId: str = Field(min_length=1, max_length=80)
    group: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    position: str = Field(min_length=1, max_length=80)
    diameter: float = Field(gt=0, le=100)
    points: list[Point] = Field(min_length=2, max_length=200)
    count: int = Field(ge=1, le=5000)
    translation: Point
    allowOutside: bool = False
    evidence: Evidence
    certainty: Literal['confirmed','uncertain']


class SourceIssue(StrictModel):
    kind: Literal['drawing_conflict','placement_question','data_quality']
    description: str = Field(min_length=1, max_length=2000)
    recommendation: str = Field(min_length=1, max_length=1000)
    evidence: Evidence


class GeometryDraft(StrictModel):
    axes: Literal['X-length,Y-up,Z-width']
    components: list[Component] = Field(min_length=1, max_length=500)
    concrete: list[Volume] = Field(max_length=100)
    metal: list[Volume] = Field(max_length=500)
    bars: list[BarSet] = Field(max_length=500)
    issues: list[SourceIssue] = Field(max_length=200)
    pending: list[str] = Field(max_length=200)
    requestedSheets: list[str] = Field(max_length=100)

"""
Разбор пакета выгрузки из Revit и нормализация справочников.

Модуль намеренно ЧИСТЫЙ: ни БД, ни FastAPI, только структуры данных на
входе и выходе. Так его можно прогонять изолированным скриптом на реальных
выгрузках — методология проекта (см. CLAUDE.md, «Тесты»), и именно так он
и проверен: на КР (3693 элемента) и АР (25 131 элемент) объекта ЖУ30.

Пакет собирает `revit_export/zhbi_export.py`; формат описан в
`Docs/revit-import.md`. Здесь — приём: прочитать, проверить, привести
секции и уровни к общему виду.

Почему нормализация не «на всякий случай», а обязательная часть приёма —
замерено на двух реальных разделах ОДНОГО объекта:

  * секции в КР названы `С01`/`С02`, а в АР — `Секция 1`/`Секция 2`, плюс
    одно `С1`. Без сведения к общей форме справочник секций задвоился бы
    с первой же загрузки второго раздела;
  * в `MCY_Секция` попадает мусор: 89 элементов КР несут там «Автостоянка»
    и «автостоянка», то есть тип этажа вместо секции;
  * уровни одного этажа названы по-разному (`С01-02_8_этаж_основной_+22.950`
    в КР против `С01-02_8_этаж` в АР) И стоят на разных отметках —
    расхождение 1970 мм. Поэтому разделы сшиваются по НОМЕРУ ЭТАЖА из
    имени уровня, а не по отметке и не по имени целиком.
"""

import gzip
import json
import re
from dataclasses import dataclass, field
from typing import Optional

FORMAT_NAME = "zhbi-revit-package"
SUPPORTED_SCHEMA = 1

# Секция: `С01`, `С1`, `Секция 1`, `C01` (латинская C — частая опечатка).
_SECTION_RE = re.compile(
    r'^\s*(?:секция\s*|сек\.?\s*|[СC])\s*(\d{1,2})\s*$', re.IGNORECASE)

# Имя уровня: `С01-02_8_этаж`, `С01-С02_-1_подземный этаж`,
# `С01-02_21_этаж_основной_+61,951`.
_LEVEL_RE = re.compile(
    r'^(?P<sections>[СC]\d+(?:\s*-\s*[СC]?\d+)*)'
    r'_(?P<floor>-?\d+)_(?P<kind>[^_]+?)'
    r'(?:_основной_(?P<elev>[+\-][\d.,]+))?\s*$', re.IGNORECASE)

# Кровля: номера этажа нет, вместо него слово.
_ROOF_RE = re.compile(
    r'^(?P<sections>[СC]\d+(?:\s*-\s*[СC]?\d+)*)'
    r'_(?P<kind>крыша|кровля)'
    r'(?:_основной_(?P<elev>[+\-][\d.,]+))?\s*$', re.IGNORECASE)

# Диапазон секций в имени уровня: `С01-02`, `С01-С02`.
_SECTION_SPAN_RE = re.compile(r'[СC]?(\d+)', re.IGNORECASE)

KIND_ROOF = "кровля"
KIND_UNDERGROUND = "подземный"
KIND_FLOOR = "этаж"


class PackageError(Exception):
    """Пакет не подошёл — сообщение предназначено пользователю."""


def normalize_section(value) -> Optional[str]:
    """Секция к канонической форме `С01`. Возвращает None, если значение
    секцией не является — тогда оно попадёт в предупреждения приёма, а не
    молча создаст третью «секцию» с именем «Автостоянка»."""
    if value is None:
        return None
    found = _SECTION_RE.match(str(value))
    if not found:
        return None
    return "С%02d" % int(found.group(1))


def _sections_from_span(text: str) -> list:
    """`С01-02` и `С01-С02` -> ['С01', 'С02']. Уровень, общий для двух
    секций, — норма: перекрытие одно на обе."""
    return ["С%02d" % int(n) for n in _SECTION_SPAN_RE.findall(text)]


@dataclass
class Level:
    """Уровень модели. `floor` — номер этажа, ЕДИНСТВЕННОЕ, по чему
    сшиваются разделы между собой."""
    name: str
    elevation_mm: Optional[float]
    project_elevation_mm: Optional[float]
    floor: Optional[int]
    kind: str
    sections: list = field(default_factory=list)
    parsed: bool = True

    @property
    def key(self) -> str:
        """Ключ этажа для сшивки разделов. У кровли номера нет, поэтому
        ключом становится сама кровля вместе с секцией: у С01 и С02 крыши
        на разных отметках и это разные этажи."""
        if self.kind == KIND_ROOF:
            return "кровля:%s" % (",".join(self.sections) or "?")
        if self.floor is None:
            return "?:%s" % self.name
        return "этаж:%d" % self.floor


def parse_level_name(name: str) -> Level:
    """Разбор имени уровня. Не угадывает: то, что не подошло ни под один
    шаблон, помечается parsed=False и уезжает в предупреждения."""
    raw = (name or "").strip()

    roof = _ROOF_RE.match(raw)
    if roof:
        return Level(name=raw, elevation_mm=None, project_elevation_mm=None,
                     floor=None, kind=KIND_ROOF,
                     sections=_sections_from_span(roof.group("sections")))

    found = _LEVEL_RE.match(raw)
    if found:
        kind_text = found.group("kind").lower()
        kind = KIND_UNDERGROUND if "подзем" in kind_text else KIND_FLOOR
        return Level(name=raw, elevation_mm=None, project_elevation_mm=None,
                     floor=int(found.group("floor")), kind=kind,
                     sections=_sections_from_span(found.group("sections")))

    return Level(name=raw, elevation_mm=None, project_elevation_mm=None,
                 floor=None, kind=KIND_FLOOR, sections=[], parsed=False)


@dataclass
class Package:
    section_code: str          # раздел проекта: КР, АР — ОБЛАСТЬ списания
    model: str
    exported_at: str
    exporter: str
    units: str
    coordinates: str
    base_point: Optional[list]
    partial: bool
    levels: list = field(default_factory=list)     # list[Level]
    grids: list = field(default_factory=list)
    rooms: list = field(default_factory=list)
    elements: list = field(default_factory=list)
    warnings: list = field(default_factory=list)


def load(data: bytes) -> Package:
    """Пакет из байтов: gzip или простой JSON. Оба принимаются намеренно —
    на реальных машинах gzip в среде Dynamo не сработал ни разу и выгрузка
    ложилась несжатым .json (Docs/revit-import.md, раздел 11)."""
    if data[:2] == b"\x1f\x8b":
        try:
            data = gzip.decompress(data)
        except Exception:
            raise PackageError("Файл повреждён: не удалось распаковать gzip")
    try:
        raw = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise PackageError("Файл не является корректным JSON")
    return from_dict(raw)


def from_dict(raw: dict) -> Package:
    if not isinstance(raw, dict) or raw.get("формат") != FORMAT_NAME:
        raise PackageError(
            "Это не пакет выгрузки из Revit (ожидается поле «формат» = "
            "«%s»)" % FORMAT_NAME)
    schema = raw.get("версия_схемы")
    if schema != SUPPORTED_SCHEMA:
        raise PackageError(
            "Версия схемы пакета %s не поддерживается (нужна %d) — "
            "обновите экспортёр" % (schema, SUPPORTED_SCHEMA))

    head = raw.get("выгрузка") or {}
    code = (head.get("раздел") or "").strip()
    if not code or code == "?":
        raise PackageError(
            "В пакете не указан раздел проекта. Раздел задаёт область, "
            "внутри которой считается «элемент исчез из модели»; без него "
            "загрузка списала бы элементы других разделов.")

    package = Package(
        section_code=code,
        model=head.get("модель") or "",
        exported_at=head.get("дата") or "",
        exporter=head.get("экспортёр") or "",
        units=head.get("единицы") or "",
        coordinates=head.get("координаты") or "",
        base_point=head.get("база_проекта"),
        partial=bool(head.get("неполная_выгрузка")),
        grids=raw.get("оси") or [],
        rooms=raw.get("помещения") or [],
        elements=raw.get("элементы") or [],
    )

    for item in raw.get("уровни") or []:
        level = parse_level_name(item.get("имя"))
        level.elevation_mm = item.get("отметка")
        level.project_elevation_mm = item.get("отметка_проектная")
        package.levels.append(level)

    package.warnings = check(package)
    return package


def check(package: Package) -> list:
    """Проверки приёма. Возвращает список предупреждений — они ПОКАЗЫВАЮТСЯ
    пользователю до применения, а не роняют загрузку: почти всё найденное
    на реальных выгрузках было дефектами модели, с которыми всё равно
    приходится работать."""
    out = []

    if package.units and package.units != "мм":
        out.append("Единицы измерения в пакете — «%s», ожидаются миллиметры"
                   % package.units)
    if package.coordinates != "общие":
        out.append(
            "Пакет выгружен во ВНУТРЕННИХ координатах модели, а не в общих. "
            "Разделы одного объекта в таком виде не совместятся.")
    if package.partial:
        out.append(
            "Выгрузка НЕПОЛНАЯ (в экспортёре стоит ограничение MAX_ELEMENTS). "
            "Загружать её как актуальную нельзя: всё, что не попало в файл, "
            "будет списано как исчезнувшее из модели.")
    if not package.elements:
        out.append("В пакете нет ни одного элемента")

    unparsed = [lv.name for lv in package.levels if not lv.parsed]
    if unparsed:
        out.append("Не разобрано имён уровней: %d (%s)"
                   % (len(unparsed), ", ".join(unparsed[:3])))

    # Уровни-дубли по отметке: в АР нашлось 11 штук вида
    # `С01-02_21_этаж_основной_+61,951`, стоящих на отметках 2, 11 и 23
    # этажей. Это ошибка модели, и она должна быть ВИДНА.
    by_elevation = {}
    for level in package.levels:
        if level.elevation_mm is not None:
            by_elevation.setdefault(level.elevation_mm, []).append(level.name)
    collisions = {k: v for k, v in by_elevation.items() if len(v) > 1}
    if collisions:
        out.append("Уровней на совпадающих отметках: %d групп — вероятно, "
                   "лишние уровни в модели" % len(collisions))

    seen = set()
    duplicates = 0
    without_uid = 0
    without_outline = 0
    for element in package.elements:
        uid = element.get("uid")
        if not uid:
            without_uid += 1
        elif uid in seen:
            duplicates += 1
        else:
            seen.add(uid)
        if not element.get("контур"):
            without_outline += 1
    if without_uid:
        out.append("Элементов без идентификатора: %d" % without_uid)
    if duplicates:
        out.append("Повторяющихся идентификаторов: %d" % duplicates)
    if without_outline:
        out.append("Элементов без контура: %d — на схеме они не появятся"
                   % without_outline)

    return out


def sections_of(package: Package) -> dict:
    """Справочник секций из пакета: каноническое имя -> сколько элементов.

    Ключ `None` собирает всё, что секцией не является (мусор в
    `MCY_Секция`) и всё пустое: на реальных данных это 89 «Автостоянок» в
    КР и 4374 пустых в АР. Разделять их не нужно — обе группы означают
    одно: секцию придётся доопределять по уровню."""
    out = {}
    for element in package.elements:
        out.setdefault(normalize_section(element.get("секция")), 0)
        out[normalize_section(element.get("секция"))] += 1
    return out


def resolve_section(element: dict, level: Optional[Level]) -> tuple:
    """Секция элемента: сначала собственный параметр, потом уровень.

    Возвращает (секция, источник). Источник нужен сводке: «взято из
    уровня» — это не ошибка, но пользователь должен видеть, сколько таких.

    Порядок именно такой, потому что уровень бывает ОБЩИМ для двух секций
    (`С01-02_8_этаж`), и тогда он секцию не определяет вовсе.
    """
    own = normalize_section(element.get("секция"))
    if own:
        return own, "параметр"
    if level is not None and len(level.sections) == 1:
        return level.sections[0], "уровень"
    return None, "не определена"

"""
Разбор структурированных имён слоёв DWG/DXF по стандарту, зафиксированному
заказчиком (см. Docs/backlog.md, "Разбор структурированных имён слоёв
DWG/DXF..."). Стандарт менялся дважды; текущая (актуальная) грамматика:

    Слои ЖБИ:
        WEB_констр_<Тип>[_<Подтип>][_ОТМ<знак><высота_мм_5цифр>]_<Роль>
    Вспомогательные слои (зоны):
        WEB_тех_<Категория>[_ОТМ<знак><высота_мм_5цифр>]_<Роль>

Сравнение токенов (тип, категория, роль, подтип, буква знака отметки) —
БЕЗ учёта регистра (заказчик подтвердил: на реальных чертежах роль и
подтип приходят то капитализированными, то строчными). Возвращаемое
значение — всегда каноническая форма (см. ZHBI_TYPES/ZHBI_ROLES и алиасы
ниже), а не сырой регистр/написание из файла — так весь код ниже по
цепочке (группировка, БД, UI) не зависит от того, как именно был написан
конкретный слой в конкретном файле.

Старый вариант словаря зон ("доп" вместо "тех", "Захватка"/"Стоянка" в
единственном числе без указания "крана") заказчиком отменён окончательно
и в новых файлах больше не встретится — обратной совместимости под него
здесь сознательно нет (см. Docs/backlog.md).

Строгая валидация: любой слой с префиксом "WEB_", не подходящий ни под
один из двух паттернов, — не пропускается молча, а вызывает
LayerNameError с именем проблемного слоя и причиной. Это отдельный
стандарт от старого LAYER_CONFIG в parse_zhbi.py (файлы по самому
первому, дозаголовочному стандарту вроде "WEB_Колонна_нижняя" под эту
грамматику не подходят) — оба пути сосуществуют, см. parse_zhbi.py.
"""

import re
from dataclasses import dataclass
from typing import Optional

ZHBI_TYPES = {"Колонна", "Ригель", "Плита", "Панель"}
ZHBI_ROLES = {"Элемент", "Марка"}

# Внутреннее каноническое имя категории/роли зоны не меняется вслед за
# написанием в файле — меняется только то, что РАСПОЗНАЁТСЯ как эта
# категория/роль (см. _ZONE_CATEGORY_ALIASES/_ZONE_ROLE_ALIASES). Так БД,
# CSS-классы, zone_binding.ZONE_CATEGORIES и фронтенд не зависят от
# конкретной орфографии стандарта на момент импорта конкретного файла.
_ZONE_CATEGORY_ALIASES = {
    "захватка": "Захватка",
    "захватки": "Захватка",
    "кран": "Кран",
    "стоянка": "Стоянка",
    "стоянки крана": "Стоянка",
}
_ZONE_ROLE_ALIASES = {
    "зона": "Зона",
    "область": "Зона",
    "наименование": "Наименование",
}

# Категории зон, для которых отметка ОБЯЗАТЕЛЬНА (у каждой захватки/крана
# нет — они сквозные на всю высоту; у стоянки крана — обязательна, свой
# набор стоянок на каждом уровне).
ZONE_CATEGORIES_REQUIRING_ELEVATION = {"Стоянка"}

# "П"/"М" перед 5-значным числом, либо без буквы для нуля. re.IGNORECASE —
# сама буква ОТМ и знак (п/м) тоже могут прийти в любом регистре.
_ELEVATION_RE = re.compile(r"^ОТМ([ПМ]?)(\d{5})$", re.IGNORECASE)


class LayerNameError(ValueError):
    """Слой начинается на 'WEB_', но не подходит ни под один из двух
    паттернов стандарта — осознанно НЕ проглатывается молча (в отличие от
    старого LAYER_CONFIG, который просто игнорирует нераспознанные слои) —
    нужно сразу ловить отклонения от стандарта у проектировщиков."""

    def __init__(self, layer_name: str, reason: str):
        self.layer_name = layer_name
        self.reason = reason
        super().__init__(f"Слой {layer_name!r}: {reason}")


@dataclass
class ParsedLayerName:
    group: str  # "zhbi" | "zone"
    type_or_category: str  # ZHBI_TYPES для group="zhbi", каноническая категория зоны для "zone"
    subtype: Optional[str]  # только group="zhbi"
    elevation_mm: Optional[int]  # со знаком; None — отметки в имени нет
    role: str  # ZHBI_ROLES или "Зона"/"Наименование" в зависимости от group


def _ci_lookup(token: str, canonical_values) -> Optional[str]:
    """Ищет токен в наборе канонических значений без учёта регистра,
    возвращает каноническое написание (не то, что было в файле)."""
    lower = token.lower()
    for value in canonical_values:
        if value.lower() == lower:
            return value
    return None


def parse_elevation_token(token: str) -> Optional[int]:
    """'ОТМП15800' -> 15800, 'ОТММ02500' -> -2500, 'ОТМ00000' -> 0.
    None, если токен вообще не похож на отметку (не ошибка сама по себе —
    вызывающий код решает, было ли уместно здесь ожидать отметку)."""
    m = _ELEVATION_RE.match(token)
    if not m:
        return None
    sign_letter, digits = m.groups()
    value = int(digits)
    return -value if sign_letter.upper() == "М" else value


def parse_layer_name(name: str, allowed_subtypes: dict) -> Optional[ParsedLayerName]:
    """
    allowed_subtypes: {Тип: {допустимый_подтип, ...}} — справочник,
    передаётся снаружи (источник — таблица allowed_subtypes в БД плюс
    экран настроек, см. Docs/backlog.md), сюда не зашит ничего. Подтип из
    файла сравнивается со справочником без учёта регистра, возвращается
    написание из справочника.

    Возвращает None для слоёв без префикса "WEB_" — это не наш стандарт
    и не ошибка (на чертеже всегда есть служебные слои вроде "Defpoints",
    "0" и т.п., которые парсер просто не должен трогать).

    Кидает LayerNameError для слоёв С префиксом "WEB_", которые тем не
    менее не подходят ни под одну из двух грамматик — это и есть
    требуемая строгая валидация.
    """
    if not name.startswith("WEB_"):
        return None

    tokens = name.split("_")
    # tokens[0] == "WEB" всегда. tokens[1] — обязательный признак вида
    # слоя: "констр" (ЖБИ) или "тех" (служебный/зона).
    namespace = tokens[1].lower() if len(tokens) >= 2 else ""

    if namespace == "тех":
        return _parse_zone_layer(name, tokens)
    if namespace == "констр":
        return _parse_zhbi_layer(name, tokens, allowed_subtypes)
    raise LayerNameError(
        name,
        f"неизвестный второй токен {(tokens[1] if len(tokens) >= 2 else '')!r}, "
        f"ожидается 'констр' (слой ЖБИ) или 'тех' (служебный слой)",
    )


def _parse_zhbi_layer(name: str, tokens: list, allowed_subtypes: dict) -> ParsedLayerName:
    # WEB_констр_<Тип>[_<Подтип>][_ОТМ...]_<Роль> — минимум 4 токена (WEB, констр, Тип, Роль).
    if len(tokens) < 4:
        raise LayerNameError(name, "слишком мало частей для слоя ЖБИ (ожидается минимум WEB_констр_<Тип>_<Роль>)")

    type_token = tokens[2]
    role_token = tokens[-1]
    middle = tokens[3:-1]

    type_canonical = _ci_lookup(type_token, ZHBI_TYPES)
    if type_canonical is None:
        raise LayerNameError(
            name, f"неизвестный тип элемента {type_token!r}, ожидается один из {sorted(ZHBI_TYPES)}"
        )
    role_canonical = _ci_lookup(role_token, ZHBI_ROLES)
    if role_canonical is None:
        raise LayerNameError(
            name, f"неизвестная роль {role_token!r}, ожидается один из {sorted(ZHBI_ROLES)}"
        )
    if len(middle) > 2:
        raise LayerNameError(name, "слишком много частей между типом и ролью (ожидается максимум подтип + отметка)")

    subtype = None
    elevation_mm = None
    for token in middle:
        elev = parse_elevation_token(token)
        if elev is not None:
            if elevation_mm is not None:
                raise LayerNameError(name, "отметка (ОТМ...) указана в имени дважды")
            elevation_mm = elev
            continue
        if subtype is not None:
            raise LayerNameError(name, f"не удалось распознать часть имени {token!r} (не подтип и не отметка)")
        allowed = allowed_subtypes.get(type_canonical, set())
        subtype_canonical = _ci_lookup(token, allowed) if allowed else None
        if subtype_canonical is None:
            raise LayerNameError(
                name,
                f"неизвестный подтип {token!r} для типа {type_canonical!r} "
                f"(допустимые: {sorted(allowed) if allowed else 'справочник пуст'})",
            )
        subtype = subtype_canonical

    return ParsedLayerName(
        group="zhbi", type_or_category=type_canonical, subtype=subtype, elevation_mm=elevation_mm, role=role_canonical
    )


def _parse_zone_layer(name: str, tokens: list) -> ParsedLayerName:
    # WEB_тех_<Категория>[_ОТМ...]_<Роль> — минимум 4 токена (WEB, тех, Категория, Роль).
    if len(tokens) < 4:
        raise LayerNameError(
            name, "слишком мало частей для служебного слоя (ожидается минимум WEB_тех_<Категория>_<Роль>)"
        )

    category_token = tokens[2]
    role_token = tokens[-1]
    middle = tokens[3:-1]

    category_canonical = _ZONE_CATEGORY_ALIASES.get(category_token.lower())
    if category_canonical is None:
        raise LayerNameError(
            name,
            f"неизвестная категория {category_token!r}, ожидается один из "
            f"{sorted(set(_ZONE_CATEGORY_ALIASES.values()))}",
        )
    role_canonical = _ZONE_ROLE_ALIASES.get(role_token.lower())
    if role_canonical is None:
        raise LayerNameError(
            name, f"неизвестная роль {role_token!r}, ожидается один из {sorted(set(_ZONE_ROLE_ALIASES.values()))}"
        )
    if len(middle) > 1:
        raise LayerNameError(name, "слишком много частей между категорией и ролью (ожидается максимум отметка)")

    elevation_mm = None
    if middle:
        elevation_mm = parse_elevation_token(middle[0])
        if elevation_mm is None:
            raise LayerNameError(name, f"не удалось распознать часть имени {middle[0]!r} как отметку (ОТМ...)")

    if category_canonical in ZONE_CATEGORIES_REQUIRING_ELEVATION and elevation_mm is None:
        raise LayerNameError(name, f"для категории {category_canonical!r} отметка (ОТМ...) обязательна")
    if category_canonical not in ZONE_CATEGORIES_REQUIRING_ELEVATION and elevation_mm is not None:
        raise LayerNameError(
            name, f"для категории {category_canonical!r} отметка не указывается (зона сквозная, на всю высоту)"
        )

    return ParsedLayerName(
        group="zone", type_or_category=category_canonical, subtype=None, elevation_mm=elevation_mm, role=role_canonical
    )

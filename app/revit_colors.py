"""
Цветовая схема показа модели Revit: шаблоны и правка по категориям.

Цвет привязан к КАТЕГОРИИ Revit, а не к порядковому номеру в ответе. Так
было раньше — цвет брался по индексу категории в текущей выборке, — и
одна и та же стена меняла цвет при смене отбора: стоило отфильтровать
двери, как индексы съезжали. Категория — устойчивое имя, его и храним.

Схема — настройка ОБЪЕКТА (`app_settings`), а не пользователя: люди
смотрят на одно здание и обсуждают его словами «серое — стены», и своя
раскраска у каждого сделала бы такой разговор невозможным.
"""

import json

from app.settings import get_setting, set_setting

SETTING_KEY = "revit_colors"

# Цвет для категории, которой нет ни в одном шаблоне: у заказчика в модели
# встречаются и редкие категории, и терять их на схеме нельзя.
FALLBACK = "#c8c8c8"

# Прозрачность в ПРОЦЕНТАХ (0 — глухой, 100 — невидимый), по категориям.
# Заводски прозрачны окна: сквозь них видно, что внутри, а сами они на
# фасаде и так читаются рамой. Остальное глухое — прозрачная стена
# превращает разбор модели в разглядывание тумана.
DEFAULT_OPACITY = {"Окна": 70}

PRESETS = {
    "grey": {
        "title": "Оттенки серого",
        "hint": "Конструкции читаются по светлоте: чем несущее, тем темнее",
        "colors": {
            "Стены": "#d4d4d4",
            "Перекрытия": "#8a8a8a",
            "Двери": "#f7f7f7",
            "Окна": "#bcd8ea",
            "Фундамент несущей конструкции": "#6b6b6b",
            "Несущие колонны": "#b0b0b0",
            "Каркас несущий": "#9e9e9e",
            "Лестницы": "#c2c2c2",
            "Крыши": "#7d7d7d",
            "Потолки": "#e6e6e6",
            "Обобщенные модели": "#cfcfcf",
        },
        "opacity": dict(DEFAULT_OPACITY),
    },
    "pastel": {
        "title": "Пастельная",
        "hint": "Категории различаются цветом, а не светлотой",
        "colors": {
            "Стены": "#a9c6dd",
            "Перекрытия": "#e0cfa8",
            "Двери": "#c9b6dd",
            "Окна": "#a8d9c6",
            "Фундамент несущей конструкции": "#b6b9dd",
            "Несущие колонны": "#e0b9a8",
            "Каркас несущий": "#c9dda8",
            "Лестницы": "#ddaec9",
            "Крыши": "#b9d4e0",
            "Потолки": "#e6ddc0",
            "Обобщенные модели": "#d5d5d5",
        },
        "opacity": dict(DEFAULT_OPACITY),
    },
    "contrast": {
        "title": "Контрастная",
        "hint": "Для разбора состава модели: категории видно издалека",
        "colors": {
            "Стены": "#4a7fb5",
            "Перекрытия": "#b58b4a",
            "Двери": "#7a4ab5",
            "Окна": "#4ab58b",
            "Фундамент несущей конструкции": "#5a5a8a",
            "Несущие колонны": "#b54a6a",
            "Каркас несущий": "#8ab54a",
            "Лестницы": "#b5794a",
            "Крыши": "#4a9bb5",
            "Потолки": "#9b9b6a",
            "Обобщенные модели": "#8a8a8a",
        },
        "opacity": dict(DEFAULT_OPACITY),
    },
}

DEFAULT_PRESET = "grey"


def scheme(conn, object_id: int) -> dict:
    """Действующая схема объекта: имя шаблона и цвета по категориям.

    Хранится ЦЕЛИКОМ, а не «шаблон плюс отличия»: правки редки, а разбор
    того, что осталось от шаблона после трёх правок, стоил бы дороже
    десятка сохранённых строк.
    """
    raw = get_setting(conn, SETTING_KEY, object_id)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and isinstance(data.get("colors"), dict):
                return {"preset": data.get("preset") or "custom",
                        "colors": data["colors"],
                        "opacity": data.get("opacity") or {}}
        except (TypeError, ValueError):
            pass
    return {"preset": DEFAULT_PRESET,
            "colors": dict(PRESETS[DEFAULT_PRESET]["colors"]),
            "opacity": dict(PRESETS[DEFAULT_PRESET]["opacity"])}


def save(conn, object_id: int, preset: str, colors: dict, opacity: dict = None) -> dict:
    if preset in PRESETS and not colors:
        colors = dict(PRESETS[preset]["colors"])
        opacity = dict(PRESETS[preset]["opacity"])
    чистые = {}
    for имя, цвет in (colors or {}).items():
        цвет = str(цвет or "").strip()
        # Только #rrggbb: значение уезжает прямо в атрибут SVG и в
        # THREE.Color, и мусор оттуда выглядел бы как «пропали элементы».
        if len(цвет) == 7 and цвет[0] == "#":
            try:
                int(цвет[1:], 16)
            except ValueError:
                continue
            чистые[str(имя)[:100]] = цвет.lower()
    прозрачность = {}
    for имя, значение in (opacity or {}).items():
        try:
            число = int(значение)
        except (TypeError, ValueError):
            continue
        # Держим в 0..95: полностью невидимый элемент неотличим от
        # пропавшего, и объяснить это потом будет нечем.
        if число > 0:
            прозрачность[str(имя)[:100]] = max(0, min(95, число))
    data = {"preset": preset if preset in PRESETS else "custom",
            "colors": чистые, "opacity": прозрачность}
    set_setting(conn, SETTING_KEY, object_id, json.dumps(data, ensure_ascii=False))
    conn.commit()
    return data


def presets_for_client() -> list:
    return [{"key": k, "title": v["title"], "hint": v["hint"],
             "colors": v["colors"], "opacity": v["opacity"]}
            for k, v in PRESETS.items()]

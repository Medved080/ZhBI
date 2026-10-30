"""
Категории элементов модели МФР из PDF — по классификатору видов работ
(`app/work_classifier.py`, лист `Elements` файла WBS), запрос пользователя
2026-10-29.

Разбор PDF (`app/pdf_rooms.py`) мыслит своими категориями — «Стены монолит»,
«Стены блоки», «Стены кирпич», «Перекрытия»: на них завязаны слои чертежа и
правила разбора. В `revit_elements.category` же пишется имя из
классификатора, чтобы категория элемента модели совпадала с категорией
вида работ без ручного соответствия (`object_category_map`).

Деление кладки на наружную и внутреннюю — по признаку наружной: наружная —
простенки фасада (материал `pdf_rooms.EXTERIOR_MASONRY_MATERIAL`), всё
остальное из блоков и кирпича — внутренняя. Категории, которых в
классификаторе нет (перегородки, двери, окна, помещения), остаются как есть.
Новое соответствие — строка в `PDF_TO_CLASSIFIER`.
"""

from typing import Optional

CLS_WALL_MONOLITH = "Монолит стены"
CLS_SLAB_MONOLITH = "Монолит перекрытия"
CLS_MASONRY_OUTER = "Кладка наружная"
CLS_MASONRY_INNER = "Кладка внутренняя"

# Категории разбора PDF, из которых кладка делится на наружную/внутреннюю.
_MASONRY = ("Стены блоки", "Стены кирпич")

# Категория разбора PDF -> категория классификатора (без деления кладки).
PDF_TO_CLASSIFIER = {
    "Стены монолит": CLS_WALL_MONOLITH,
    "Перекрытия": CLS_SLAB_MONOLITH,
}

# Все имена классификатора, которые пишутся в PDF-модель, — для обработки
# релиза и для выбора «стен» в геометрии объекта.
PDF_CLASSIFIER_NAMES = (CLS_WALL_MONOLITH, CLS_SLAB_MONOLITH, CLS_MASONRY_OUTER, CLS_MASONRY_INNER)


def classifier_category(pdf_category: str, material: Optional[str], exterior_material: str) -> str:
    """Категория для `revit_elements.category` по категории разбора PDF и
    материалу. Нет в классификаторе — категория без изменений."""
    if pdf_category in _MASONRY:
        return CLS_MASONRY_OUTER if material == exterior_material else CLS_MASONRY_INNER
    return PDF_TO_CLASSIFIER.get(pdf_category, pdf_category)

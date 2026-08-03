"""
Правка реквизитов элемента — примитивы, общие для ОДИНОЧНОЙ правки
(PATCH /elements/{id}/fields, app/main.py) и МАССОВОЙ через Excel
(app/element_bulk_edit.py).

Вынесено сюда 2026-08-01, когда появился второй потребитель. До этого вся
проверка жила прямо в теле эндпоинта, и массовая правка неизбежно стала бы
её копией — а разъехавшиеся правила проверки это ровно тот класс
расхождений, который потом ловится только живым репортом («в форме нельзя,
а через файл прошло»).

Что здесь НЕ лежит и почему: контракт. Он тоже реквизит элемента (с
2026-08-01, см. app/contracts.py), но правится по своим правилам —
проставляется при уходе с «Запланирован», снимается только откатом
статуса. Эти правила живут в app/element_bulk_edit.py рядом с тем
единственным местом, где контракт можно править файлом.
"""

import json
from datetime import datetime
from typing import Optional

EDITABLE_FIELDS = (
    "element_type", "subtype", "mark", "elevation_mm", "floor", "address",
    "planned_delivery_date", "project_smr_start_date", "project_delivery_date",
)

INT_FIELDS = {"elevation_mm", "floor"}

# Даты хранятся текстом 'ГГГГ-ММ-ДД' и СРАВНИВАЮТСЯ КАК ТЕКСТ (отбор по
# диапазону в фильтрах, критерий опоздания, отчёты) — формат проверяем на
# входе, иначе одна строка «01.09.2026» тихо ломает сравнение.
DATE_FIELDS = {
    "planned_delivery_date", "project_smr_start_date", "project_delivery_date",
}

# Человеческие подписи — заголовки колонок в Excel и тексты в сводке
# расхождений. Здесь, а не на фронтенде: файл собирает сервер, и подпись в
# заголовке обязана совпадать с подписью в сводке, иначе пользователь не
# свяжет одно с другим.
FIELD_LABELS = {
    "element_type": "Тип элемента",
    "subtype": "Подтип",
    "mark": "Марка",
    "elevation_mm": "Отметка, мм",
    "floor": "Этаж",
    "address": "Адрес по осям",
    "planned_delivery_date": "Плановая дата поставки",
    "project_smr_start_date": "Дата начала СМР",
    "project_delivery_date": "Дата завершения СМР",
    "contract_id": "Контракт",
}


class FieldError(ValueError):
    """Ошибка проверки одного поля. Текст готов к показу пользователю —
    и в 400-ответе одиночной правки, и в колонке «отклонено» сводки
    массовой."""


def coerce_field(field: str, raw) -> Optional[object]:
    """Приводит значение из запроса или из ячейки Excel к тому, что лежит в
    БД. Пустая строка и None — это «очистить поле», а не ошибка.

    Дата принимается и как строка 'ГГГГ-ММ-ДД', и как datetime: openpyxl
    отдаёт настоящую дату, если ячейка отформатирована как дата, и текст,
    если пользователь набрал её руками. Не учитывать оба варианта — значит
    отклонять файл, который в Excel выглядит совершенно правильно.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if field in INT_FIELDS:
        # float отдельно: Excel возвращает 15800 как 15800.0
        if isinstance(raw, float) and raw.is_integer():
            return int(raw)
        try:
            return int(str(raw).strip())
        except (TypeError, ValueError):
            raise FieldError(f"«{FIELD_LABELS.get(field, field)}» должно быть целым числом, получено «{raw}»")
    if field in DATE_FIELDS:
        if isinstance(raw, datetime):
            return raw.strftime("%Y-%m-%d")
        if hasattr(raw, "strftime"):  # datetime.date
            return raw.strftime("%Y-%m-%d")
        text = str(raw).strip()
        try:
            datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            raise FieldError(
                f"«{FIELD_LABELS.get(field, field)}»: ожидается дата в виде ГГГГ-ММ-ДД, получено «{text}»"
            )
        return text
    return str(raw).strip()


def check_subtype(conn, element_type: Optional[str], subtype: Optional[str]) -> Optional[str]:
    """Проверяет пару тип+подтип по справочнику allowed_subtypes. Возвращает
    текст ошибки или None.

    Проверка именно ПАРЫ, а не подтипа в одиночку: текст подтипа намеренно
    переиспользуется между типами («на отм. +15.000» есть и у Ригеля, и у
    Плиты перекрытия), поэтому «такой подтип существует» ничего не значит.
    """
    if subtype is None:
        return None
    allowed = {
        r["subtype"] for r in conn.execute(
            "SELECT subtype FROM allowed_subtypes WHERE element_type = ?", (element_type,)
        )
    }
    if subtype in allowed:
        return None
    return (f"Подтип «{subtype}» не разрешён для типа «{element_type}». "
            f"Допустимые: {', '.join(sorted(allowed)) or 'нет'} "
            f"(правится в «Действия → Справочники → Подтипы»)")


def contract_mismatch(conn, contract_id, element_type, mark) -> Optional[str]:
    """Перестал ли элемент соответствовать позиции своего контракта после
    правки типа или марки. Возвращает текст предупреждения или None.

    Это НЕ запрет: позиция контракта может быть заведена позже или с другой
    маркой, и решение оставляет за собой человек (решение Э5 —
    «предупреждать и согласовывать»).
    """
    if not contract_id:
        return None
    line = conn.execute(
        "SELECT 1 FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark IS ?",
        (contract_id, element_type, mark),
    ).fetchone()
    if line is not None:
        return None
    return (f"После правки элемент не соответствует ни одной позиции своего "
            f"контракта (тип «{element_type}», марка «{mark or '—'}»)")


def write_fields(conn, element_id: int, row, values: dict) -> tuple[dict, list]:
    """Записывает поля и ведёт manual_fields. Возвращает (что изменилось,
    итоговый manual_fields).

    manual_fields — список полей, правленных РУКАМИ: переимпорт чертежа их
    не перезаписывает, а показывает расхождение (решение Э4). Без этого
    признака ручная правка жила бы до первой загрузки нового чертежа и молча
    исчезала.

    В manual_fields попадает только то, что РЕАЛЬНО изменилось: файл
    массовой правки содержит все колонки всех элементов, и запись «правлено
    руками» на каждое совпавшее значение пометила бы вручную всю базу с
    первой же загрузки — переимпорт чертежа после этого не обновил бы
    ничего.
    """
    # Имена полей попадают прямо в `SET {поле} = :поле`. Оба нынешних
    # вызывающих (одиночная правка в app/main.py и массовая в
    # app/element_bulk_edit.py) отбирают их по EDITABLE_FIELDS, но проверка
    # у КАЖДОГО своя — а именно на такой схеме аудит 2026-08-03 и нашёл
    # дыру: массовая правка сверку потеряла и позволяла записать любую
    # существующую колонку elements (object_id, current_status, is_current).
    # Поэтому здесь стоит последний барьер: он ничего не стоит и не даёт
    # третьему вызывающему открыть то же самое заново.
    # Ровно EDITABLE_FIELDS, без послаблений: `contract_id` массовая правка
    # отбирает ДО этого вызова и проводит через apply_status_change — прямая
    # запись контракта здесь обошла бы историю, снимок и проверку остатка.
    посторонние = set(values) - set(EDITABLE_FIELDS)
    if посторонние:
        raise ValueError("Недопустимые поля для правки: " + ", ".join(sorted(посторонние)))
    changed = {f: (row[f], v) for f, v in values.items() if row[f] != v}
    if not changed:
        return {}, sorted(set(json.loads(row["manual_fields"] or "[]")))
    manual = set(json.loads(row["manual_fields"] or "[]")) | set(changed)
    assignments = ", ".join(f"{f} = :{f}" for f in changed)
    conn.execute(
        f"UPDATE elements SET {assignments}, manual_fields = :manual_fields, "
        f"updated_at = datetime('now') WHERE id = :id",
        {**{f: v for f, (_, v) in changed.items()},
         "manual_fields": json.dumps(sorted(manual), ensure_ascii=False),
         "id": element_id},
    )
    return changed, sorted(manual)

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
import re
from datetime import datetime
from typing import Optional

from app import contract_guard

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


# ---------- как дата выглядит для человека (живой запрос 2026-08-03) ----------
#
# В БД даты лежат как 'ГГГГ-ММ-ДД' (и моменты как 'ГГГГ-ММ-ДД ЧЧ:ММ:СС') —
# так их СРАВНИВАЮТ как текст, менять хранение нельзя. Но наружу — на экран,
# в PDF и в Excel — дата обязана выглядеть по-русски.
#
# Для Excel это НЕ текст: в ячейку кладётся настоящая дата с числовым
# форматом. Иначе ломается обратный круг «выгрузил → поправил → загрузил»:
# импортёры принимают либо `date`/`datetime` от openpyxl, либо ISO-строку
# (coerce_field, normalize_activity_dates), а текст «01.10.2026» им не
# годится. Заодно в самом Excel такой столбец остаётся сортируемым и
# фильтруемым как дата, а не как строка.
EXCEL_DATE_FORMAT = "DD.MM.YYYY"
EXCEL_DATETIME_FORMAT = "DD.MM.YYYY HH:MM:SS"


def ru_date_text(value) -> str:
    """'2026-10-01' → '01.10.2026', '2026-10-01 14:30:00' → '01.10.2026 14:30:00'.
    Непохожее на дату возвращается как есть — функция зовётся и на свободном
    тексте (значения «было/стало» в журнале)."""
    if value is None:
        return ""
    text = str(value).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?", text)
    if not m:
        return text
    г, мес, д, время = m.groups()
    хвост = text[m.end():]
    return f"{д}.{мес}.{г}" + (f" {время}" if время else "") + хвост


def ru_dates_in_text(text) -> str:
    """То же, но внутри произвольной строки: «Плановая дата: 2026-10-01;
    Этаж: 2» → «Плановая дата: 01.10.2026; Этаж: 2». Нужна значениям
    «было/стало» журнала — там дата лежит вперемешку с другими полями."""
    if text is None:
        return ""
    return re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b",
                  lambda m: f"{m.group(3)}.{m.group(2)}.{m.group(1)}", str(text))


def to_excel_date(value):
    """Строка даты/момента → `date`/`datetime` для ячейки Excel. Всё
    остальное возвращается без изменений (в колонке может лежать пусто или
    неожиданный текст — ронять из-за этого выгрузку нельзя)."""
    if not isinstance(value, str) or not value.strip():
        return value
    text = value.strip()
    for формат, обрезка in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d", 10)):
        try:
            момент = datetime.strptime(text[:обрезка], формат)
        except ValueError:
            continue
        return момент if обрезка == 19 else момент.date()
    return value


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


def contract_mismatch(conn, contract_id, element_type, mark, element_id=None) -> Optional[str]:
    """Перестал ли элемент соответствовать позиции своего контракта после
    правки типа или марки. Возвращает текст отказа или None.

    С 2026-08-14 это ЗАПРЕТ, а не согласовываемое предупреждение (решение
    Э5 отменено пользователем) — сам текст возвращается по-прежнему, а
    решение «пускать или нет» принимают вызывающие: PATCH реквизитов
    изделия (app/main.py) и массовая правка через Excel
    (app/element_bulk_edit.py, там строка уходит в «пропущено»).

    Проверка отдана стражу (app/contract_guard.py) целиком: он же считает и
    свободное количество — смена марки на другую позицию того же контракта
    может упереться не в отсутствие позиции, а в её исчерпанность. И он же
    сравнивает марки без учёта регистра, иначе «15кс1.1» вместо «15КС1.1»
    читалось бы как «позиции нет» на ровном месте.
    """
    if not contract_id:
        return None
    проблема = contract_guard.link_problem(
        conn, contract_id, element_type, mark, element_id=element_id,
        # Текущая привязка НЕ передаётся намеренно: изделие уже привязано к
        # этому контракту, и «уже занимает место» освободило бы его от
        # проверки — а меняется как раз то, ПОД КАКУЮ позицию оно занимает
        # место.
    )
    if проблема is None:
        return None
    # Тип и марку не повторяем: страж называет их сам, и «после правки
    # (тип …, марка …) — в спецификации нет позиции под тип … марку …»
    # читалось бы как заикание.
    return f"Правка уводит изделие из-под позиции его контракта. {проблема}"


def resolve_mark_id(conn, object_id, element_type, mark, create: bool = True):
    """Запись справочника марок для пары (тип, марка) внутри объекта.

    Ссылка `elements.mark_id` ПРОИЗВОДНА от текста марки, а не наоборот
    (2026-08-05). Так решено, потому что текстовое `elements.mark` пока
    остаётся источником правды для фильтров, отчётов, экспорта и всех
    импортов: пока разложение по справочнику не сверено, снимать его нельзя.
    Значит, единственный способ не дать двум полям разойтись — выводить
    ссылку из текста в ОДНОМ месте, через которое проходит любая запись
    марки (`write_fields` ниже — и одиночная правка, и массовая через Excel;
    `element_sync` — переимпорт чертежа).

    `create=True`: марки, которой ещё нет, заводится запись. Справочник — это
    ровно множество марок, которые в данных есть; если новую марку не
    завести, у изделия останется пустая ссылка, и разойдётся ровно то, что
    эта функция и держит вместе. Опечатка при этом попадёт в справочник —
    и это правильно: её там видно (счётчик «Изделий: 1») и её можно свернуть
    удалением с заменой, а раньше она молча жила в тексте.
    """
    mark = (mark or "").strip()
    if not mark or object_id is None or not element_type:
        return None
    row = conn.execute(
        "SELECT id FROM marks WHERE object_id = ? AND element_type = ? AND name = ?",
        (object_id, element_type, mark),
    ).fetchone()
    if row:
        return row["id"]
    if not create:
        return None
    conn.execute(
        "INSERT INTO marks (object_id, element_type, name) VALUES (?, ?, ?)",
        (object_id, element_type, mark),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


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
    # В manual_fields попадает то, что правил ЧЕЛОВЕК, — а mark_id считается
    # по марке и типу и в этот список не входит: пометив его «правлено
    # руками», мы запретили бы переимпорту чертежа обновлять ссылку, которую
    # он же и обязан пересчитывать.
    manual = set(json.loads(row["manual_fields"] or "[]")) | set(changed)
    if "mark" in changed or "element_type" in changed:
        новая_ссылка = resolve_mark_id(
            conn, row["object_id"],
            changed["element_type"][1] if "element_type" in changed else row["element_type"],
            changed["mark"][1] if "mark" in changed else row["mark"],
        )
        if новая_ссылка != row["mark_id"]:
            changed["mark_id"] = (row["mark_id"], новая_ссылка)
    assignments = ", ".join(f"{f} = :{f}" for f in changed)
    conn.execute(
        f"UPDATE elements SET {assignments}, manual_fields = :manual_fields, "
        f"updated_at = datetime('now') WHERE id = :id",
        {**{f: v for f, (_, v) in changed.items()},
         "manual_fields": json.dumps(sorted(manual), ensure_ascii=False),
         "id": element_id},
    )
    return changed, sorted(manual)

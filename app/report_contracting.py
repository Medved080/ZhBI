"""
Отчёт «График контрактации и поставки» (живой запрос 2026-08-06).

Вопрос, на который он отвечает: **насколько потребность стройки в изделиях
закрыта контрактами — и когда**. Не «сколько привезли» (это «График
поставки») и не «чем закрыта конкретная стоянка» (это «Статус
комплектации»), а разрыв между тем, что нужно построить, и тем, что уже
выкуплено бумагой, — по маркам и во времени.

Четыре шкалы, из которых отчёт и состоит:

  **Потребность**   — сколько изделий этой марки есть в модели
      (`elements`, актуальные). Именно модель, а не позиции контрактов:
      потребность задаёт проект, а контракт — это ответ на неё. Если
      считать потребность по контрактам, дефицит перестаёт существовать по
      построению, и отчёт теряет смысл (решение пользователя 2026-08-06).
      Во времени раскладывается по `project_smr_start_date` — дате, к
      которой изделие обязано быть на площадке (та же трактовка, что в
      «Статусе комплектации»: `project_delivery_date` означает ЗАВЕРШЕНИЕ
      СМР и к поставке отношения не имеет).

  **Законтрактовано** — сумма количеств в позициях контрактов
      (`contract_lines.quantity`) по этой марке. То есть «выкуплено
      бумагой», независимо от того, каким изделиям контракт уже назначен.
      Во времени — по `specifications.specification_date`: своей даты у
      контракта нет и намеренно не будет (она избыточна, см. schema.sql),
      а дата договора относится к рамочному документу и подписывается
      сильно раньше, отчего график получился бы оптимистичнее правды
      (решение пользователя 2026-08-06).

  **Запланировано к поставке** — изделия с плановой датой
      (`planned_delivery_date`).

  **Факт** — изделия с фактической датой (`actual_delivery_date`).

Все четыре по горизонтали идут **накопительным итогом**: вопрос звучит «на
эту дату хватает или нет», а не «сколько пришло в эту неделю».

Разреженность. Марок на объекте бывает под тысячу, периодов при масштабе
«по дням» — сотни; плотная матрица на четыре шкалы это миллионы чисел на
каждое открытие отчёта. Поэтому сервер отдаёт ПРИРАЩЕНИЯ и только там, где
они есть (`deltas`: индекс периода → сколько добавилось), а накопление
делает клиент для тех строк, которые реально рисует. У большинства марок
приращений единицы.

Расшифровка по контрактации (контрагент → договор → спецификация →
контракт) считается только для «законтрактовано», «запланировано» и
«факта»: у потребности контракта нет по определению — она берётся из
модели, которая про контракты ничего не знает.
"""

import sqlite3
from datetime import date, datetime, timedelta
from typing import Optional

# Признак «в разработке» (2026-08-06, решение пользователя: доработка отчёта
# приостановлена). Доступ он не ограничивает — отчёт виден всем, кому был
# виден, просто с честной пометкой; см. app/reports.py, там же и текст
# приписки, уходящей в XLSX и PDF.
IN_DEVELOPMENT = True

SCALES = ("day", "week", "month", "quarter")

SCALE_LABELS = {
    "day": "по дням", "week": "по неделям", "month": "по месяцам", "quarter": "по кварталам",
}


def _parse(значение) -> Optional[date]:
    """Даты в базе лежат текстом 'ГГГГ-ММ-ДД' (и моменты с временем) и
    сравниваются как текст — см. Docs/DECISIONS.md. Здесь они нужны
    объектами, чтобы раскладывать по периодам."""
    if not значение:
        return None
    try:
        return datetime.strptime(str(значение)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _period_start(d: date, scale: str) -> date:
    if scale == "day":
        return d
    if scale == "week":
        return d - timedelta(days=d.weekday())   # понедельник
    if scale == "month":
        return d.replace(day=1)
    return d.replace(month=((d.month - 1) // 3) * 3 + 1, day=1)   # квартал


def _next_period(d: date, scale: str) -> date:
    if scale == "day":
        return d + timedelta(days=1)
    if scale == "week":
        return d + timedelta(days=7)
    месяцев = 1 if scale == "month" else 3
    год, месяц = d.year, d.month + месяцев
    год += (месяц - 1) // 12
    месяц = (месяц - 1) % 12 + 1
    return date(год, месяц, 1)


def _period_label(d: date, scale: str) -> str:
    if scale == "day":
        return d.strftime("%d.%m.%Y")
    if scale == "week":
        конец = d + timedelta(days=6)
        return f"{d.strftime('%d.%m')}–{конец.strftime('%d.%m.%Y')}"
    if scale == "month":
        return d.strftime("%m.%Y")
    return f"{(d.month - 1) // 3 + 1} кв. {d.year}"


def _build_periods(даты: list, scale: str) -> list:
    """Ось времени: от самой ранней даты до самой поздней СПЛОШЬ, без
    пропусков. Пропускать пустые периоды нельзя — накопительный график с
    дырами в оси врёт про темп: две соседние колонки могут отстоять на
    полгода, а выглядеть как соседние недели."""
    реальные = [d for d in даты if d]
    if not реальные:
        return []
    начало = _period_start(min(реальные), scale)
    конец = _period_start(max(реальные), scale)
    периоды, текущий = [], начало
    # Ограничение на всякий случай: при испорченных данных (дата 2999 года)
    # цикл по дням построил бы миллион колонок и подвесил и сервер, и
    # браузер. 1500 периодов — это четыре года по дням.
    while текущий <= конец and len(периоды) < 1500:
        периоды.append(текущий)
        текущий = _next_period(текущий, scale)
    return периоды


def _index_of(периоды: list, d: Optional[date], scale: str) -> Optional[int]:
    if d is None or not периоды:
        return None
    начало = _period_start(d, scale)
    # Дата вне оси (раньше первой колонки) относится к первой: иначе она
    # молча выпадает из накопления, и итог по графику не сходится с итогом
    # слева — расхождение, которое пользователь заметит первым же взглядом.
    if начало <= периоды[0]:
        return 0
    if начало >= периоды[-1]:
        return len(периоды) - 1
    # Периоды идут подряд, поэтому позиция ищется двоичным поиском.
    низ, верх = 0, len(периоды) - 1
    while низ < верх:
        середина = (низ + верх + 1) // 2
        if периоды[середина] <= начало:
            низ = середина
        else:
            верх = середина - 1
    return низ


def _add(куда: dict, индекс: Optional[int], сколько: int) -> None:
    if индекс is None or not сколько:
        return
    куда[индекс] = куда.get(индекс, 0) + сколько


def build_contracting_schedule(conn: sqlite3.Connection, object_id: int,
                               scale: str = "month") -> dict:
    """Данные отчёта. Считает СЕРВЕР — как и у остальных отчётов: экран и
    выгрузки берут результат одной функции и разойтись не могут."""
    if scale not in SCALES:
        scale = "month"

    изделия = conn.execute(
        """
        SELECT e.id, e.element_type, e.mark, e.contract_id,
               e.project_smr_start_date, e.planned_delivery_date, e.actual_delivery_date
        FROM elements e
        WHERE e.object_id = ? AND e.is_current = 1
          AND e.mark IS NOT NULL AND trim(e.mark) <> ''
        """,
        (object_id,),
    ).fetchall()

    # Позиции контрактов ЭТОГО объекта: объект контракта выводится по
    # цепочке контракт → спецификация → договор (своего поля у контракта
    # нет и не должно быть, см. schema.sql).
    позиции = conn.execute(
        """
        SELECT cl.element_type, cl.mark, cl.quantity,
               co.id AS contract_id, co.theme,
               s.id AS spec_id, s.number AS spec_number, s.specification_date,
               a.id AS agr_id, a.number AS agr_number, a.agreement_date,
               cp.id AS cp_id, cp.short_name AS cp_name
        FROM contract_lines cl
        JOIN contracts co ON co.id = cl.contract_id
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        JOIN counterparties cp ON cp.id = a.counterparty_id
        WHERE a.object_id = ? AND cl.mark IS NOT NULL AND trim(cl.mark) <> ''
        """,
        (object_id,),
    ).fetchall()

    все_даты = []
    for e in изделия:
        все_даты += [_parse(e["project_smr_start_date"]), _parse(e["planned_delivery_date"]),
                     _parse(e["actual_delivery_date"])]
    for p in позиции:
        все_даты.append(_parse(p["specification_date"]))
    периоды = _build_periods(все_даты, scale)

    def пустой_ряд():
        return {"need": {}, "contracted": {}, "planned": {}, "fact": {}}

    строки = {}          # (тип, марка) -> строка отчёта
    контракты = {}       # (тип, марка, contract_id) -> расшифровка

    def строка(тип, марка):
        ключ = (тип or "", марка)
        if ключ not in строки:
            строки[ключ] = {
                "element_type": тип, "mark": марка,
                "need": 0, "contracted": 0, "assigned": 0,
                "planned": 0, "fact": 0,
                "deltas": пустой_ряд(), "children": [],
            }
        return строки[ключ]

    def расшифровка(тип, марка, поз):
        ключ = (тип or "", марка, поз["contract_id"])
        if ключ not in контракты:
            контракты[ключ] = {
                "contract_id": поз["contract_id"],
                "counterparty": поз["cp_name"], "agreement": поз["agr_number"],
                "agreement_date": поз["agreement_date"],
                "specification": поз["spec_number"], "specification_date": поз["specification_date"],
                "theme": поз["theme"],
                "contracted": 0, "assigned": 0, "planned": 0, "fact": 0,
                "deltas": пустой_ряд(),
            }
        return контракты[ключ]

    for e in изделия:
        r = строка(e["element_type"], e["mark"])
        r["need"] += 1
        _add(r["deltas"]["need"], _index_of(периоды, _parse(e["project_smr_start_date"]), scale), 1)
        план = _parse(e["planned_delivery_date"])
        if план:
            r["planned"] += 1
            _add(r["deltas"]["planned"], _index_of(периоды, план, scale), 1)
        факт = _parse(e["actual_delivery_date"])
        if факт:
            r["fact"] += 1
            _add(r["deltas"]["fact"], _index_of(периоды, факт, scale), 1)
        if e["contract_id"]:
            r["assigned"] += 1

    for p in позиции:
        r = строка(p["element_type"], p["mark"])
        r["contracted"] += p["quantity"]
        индекс = _index_of(периоды, _parse(p["specification_date"]), scale)
        _add(r["deltas"]["contracted"], индекс, p["quantity"])
        ветка = расшифровка(p["element_type"], p["mark"], p)
        ветка["contracted"] += p["quantity"]
        _add(ветка["deltas"]["contracted"], индекс, p["quantity"])

    # План и факт по КОНТРАКТУ изделия — в расшифровку той же марки. Изделия
    # без контракта в расшифровку не попадают: они и есть незакрытая часть,
    # и приписывать их какому-либо контрагенту было бы враньём.
    for e in изделия:
        if not e["contract_id"]:
            continue
        ключ = (e["element_type"] or "", e["mark"], e["contract_id"])
        ветка = контракты.get(ключ)
        if ветка is None:
            continue   # у контракта нет позиции под эту марку — расхождение, оно видно в остатках
        ветка["assigned"] += 1
        план = _parse(e["planned_delivery_date"])
        if план:
            ветка["planned"] += 1
            _add(ветка["deltas"]["planned"], _index_of(периоды, план, scale), 1)
        факт = _parse(e["actual_delivery_date"])
        if факт:
            ветка["fact"] += 1
            _add(ветка["deltas"]["fact"], _index_of(периоды, факт, scale), 1)

    for (тип, марка, _cid), ветка in контракты.items():
        строки[(тип, марка)]["children"].append(ветка)
    for r in строки.values():
        # Порядок расшифровки — по цепочке документов, как её читает
        # человек: контрагент, потом договор, потом спецификация.
        r["children"].sort(key=lambda c: (c["counterparty"] or "", c["agreement"] or "",
                                          c["specification"] or ""))
        r["deficit"] = r["need"] - r["contracted"]

    итог = {
        "need": sum(r["need"] for r in строки.values()),
        "contracted": sum(r["contracted"] for r in строки.values()),
        "assigned": sum(r["assigned"] for r in строки.values()),
        "planned": sum(r["planned"] for r in строки.values()),
        "fact": sum(r["fact"] for r in строки.values()),
        "deltas": пустой_ряд(),
    }
    итог["deficit"] = итог["need"] - итог["contracted"]
    for r in строки.values():
        for шкала in ("need", "contracted", "planned", "fact"):
            for индекс, сколько in r["deltas"][шкала].items():
                _add(итог["deltas"][шкала], индекс, сколько)

    # Дефицитные — вперёд: отчёт открывают ради вопроса «где не хватает», и
    # искать эти марки в алфавитном списке из восьмисот строк значит не
    # получить ответа.
    порядок = sorted(строки.values(),
                     key=lambda r: (-max(r["deficit"], 0), r["element_type"] or "", r["mark"]))
    return {
        "in_development": IN_DEVELOPMENT,
        "object_id": object_id,
        "scale": scale,
        "scale_label": SCALE_LABELS[scale],
        "periods": [{"start": d.isoformat(), "label": _period_label(d, scale)} for d in периоды],
        "rows": порядок,
        "totals": итог,
    }

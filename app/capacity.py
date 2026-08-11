"""
Производительность завода — сколько изделий каждого типа контрагент
выпускает в КАЛЕНДАРНЫЙ день (решение пользователя 2026-08-11).

Зачем. «Аналитической справке» (app/report_analytics.py) нужно отвечать на
вопрос «успеет ли завод закрыть дефицит к началу СМР». Норматива «срок
изготовления, дней» у заказчика нет: он зависит от темпа конкретного
завода, а не от вида изделия. Поэтому вводится темп, а срок из него
считается — по очереди, а не умножением (см. report_analytics).

Два уровня и почему это не дублирование:

  `counterparty_capacity` — базовые цифры ЗАВОДА, одни и те же на все его
      контракты. Заводятся один раз в карточке контрагента.
  `contract_capacity`     — исключение на КОНКРЕТНЫЙ документ: этот договор
      идёт другим темпом. Пусто = берётся значение завода.

Пустое значение (строки нет вовсе) НЕ равно нулю: ноль означал бы «завод не
выпускает этот тип вовсе», а пусто — «норматива нет». В справке это
превращается в честное «сроки неизвестны» без вывода «успевает / не
успевает»; подставлять вместо неизвестного нуль или единицу значило бы
выдать выдумку за расчёт.

Модуль общий для трёх мест: карточка контрагента (app/counterparties.py),
форма контракта (app/contracts.py) и расчёт справки — чтобы правило
«контракт перебивает контрагента» было записано ровно один раз.
"""

from typing import Optional

from pydantic import BaseModel


class CapacityIn(BaseModel):
    element_type: str
    # Дробное намеренно: «10 изделий за два дня» — это 5, а «одно изделие в
    # три дня» — 0.33, и целое число тут врало бы в обе стороны.
    per_day: float
    # Пояснение к цифре («две формы, две смены») — только у контрагента: в
    # переопределении контракта важно само число, а причина живёт в теме
    # контракта и в его документах.
    comment: Optional[str] = None


def load_counterparty_capacity(conn, counterparty_id: int) -> list:
    rows = conn.execute(
        "SELECT element_type, per_day, comment FROM counterparty_capacity "
        "WHERE counterparty_id = ? ORDER BY element_type",
        (counterparty_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def load_contract_capacity(conn, contract_id: int) -> list:
    rows = conn.execute(
        "SELECT element_type, per_day FROM contract_capacity "
        "WHERE contract_id = ? ORDER BY element_type",
        (contract_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _clean(items: Optional[list]) -> list:
    """Строки без типа и с неположительным темпом отбрасываются молча: в
    форме это пустая строка таблицы, которую человек не заполнил, а не
    ошибка ввода. Нуль и отрицательное не проходят сюда сознательно —
    «нисколько в день» неотличимо от «неизвестно», а хранить два разных
    способа сказать «не знаю» значит однажды перепутать их в расчёте."""
    очищенные, встречены = [], set()
    for item in items or []:
        тип = (item.element_type or "").strip()
        if not тип or item.per_day is None or item.per_day <= 0:
            continue
        if тип in встречены:      # форма прислала один тип дважды — берём первый
            continue
        встречены.add(тип)
        очищенные.append((тип, float(item.per_day), (item.comment or "").strip() or None))
    return очищенные


def save_counterparty_capacity(conn, counterparty_id: int, items: Optional[list]) -> None:
    """Полная замена, как у строк контракта: таблица правится в форме
    целиком, и частичный патч по типу отличался бы от неё поведением при
    удалении строки. items=None — форма про производительность не
    присылала ничего (старый клиент, импорт): тогда не трогаем."""
    if items is None:
        return
    conn.execute("DELETE FROM counterparty_capacity WHERE counterparty_id = ?", (counterparty_id,))
    for тип, темп, комментарий in _clean(items):
        conn.execute(
            "INSERT INTO counterparty_capacity (counterparty_id, element_type, per_day, comment) "
            "VALUES (?, ?, ?, ?)",
            (counterparty_id, тип, темп, комментарий),
        )


def save_contract_capacity(conn, contract_id: int, items: Optional[list]) -> None:
    if items is None:
        return
    conn.execute("DELETE FROM contract_capacity WHERE contract_id = ?", (contract_id,))
    for тип, темп, _ in _clean(items):
        conn.execute(
            "INSERT INTO contract_capacity (contract_id, element_type, per_day) VALUES (?, ?, ?)",
            (contract_id, тип, темп),
        )


class CapacityBook:
    """Все нормативы разом — чтобы расчёт справки не ходил в базу на каждое
    изделие. Собирается одним заходом на объект.

    `for_contract` — темп, которым считается ЭТОТ контракт: своё
    переопределение, иначе значение завода, иначе None («сроки
    неизвестны»).

    `average` — среднее по типу для дефицита, у которого контракта ещё нет
    (решение пользователя 2026-08-11). Считается по заводам ЭТОГО объекта:
    у них есть действующие контракты на эту стройку, и именно они —
    реалистичные кандидаты. Средним по всему справочнику здесь было бы
    удобнее, но оно приплело бы заводы, которые сюда никогда не возили.
    Заводы без заполненного норматива в среднее не входят вовсе — иначе они
    тянули бы его к нулю, изображая незнание как медлительность.
    """

    def __init__(self, conn, object_id: Optional[int]):
        self.by_counterparty = {
            (r["counterparty_id"], r["element_type"]): r["per_day"]
            for r in conn.execute("SELECT counterparty_id, element_type, per_day FROM counterparty_capacity")
        }
        self.by_contract = {
            (r["contract_id"], r["element_type"]): r["per_day"]
            for r in conn.execute("SELECT contract_id, element_type, per_day FROM contract_capacity")
        }
        # Контракт → контрагент: цепочка контракт → спецификация → договор,
        # своего поля контрагента у контракта нет и не должно быть.
        self.counterparty_of_contract = {}
        self.counterparty_name = {}
        for r in conn.execute(
            """
            SELECT co.id AS contract_id, cp.id AS cp_id, cp.short_name AS cp_name
            FROM contracts co
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            JOIN counterparties cp ON cp.id = a.counterparty_id
            """
        ):
            self.counterparty_of_contract[r["contract_id"]] = r["cp_id"]
            self.counterparty_name[r["cp_id"]] = r["cp_name"]

        # Заводы объекта — по неархивным контрактам этой стройки.
        свои = set()
        if object_id is not None:
            свои = {
                r["cp_id"]
                for r in conn.execute(
                    """
                    SELECT DISTINCT cp.id AS cp_id
                    FROM contracts co
                    JOIN specifications s ON s.id = co.specification_id
                    JOIN agreements a ON a.id = s.agreement_id
                    JOIN counterparties cp ON cp.id = a.counterparty_id
                    WHERE a.object_id = ? AND co.is_archived = 0
                    """,
                    (object_id,),
                )
            }
        суммы: dict = {}
        for (cp_id, тип), темп in self.by_counterparty.items():
            if свои and cp_id not in свои:
                continue
            накопитель = суммы.setdefault(тип, [0.0, 0])
            накопитель[0] += темп
            накопитель[1] += 1
        self.average = {тип: сумма / сколько for тип, (сумма, сколько) in суммы.items() if сколько}

    def for_contract(self, contract_id: Optional[int], element_type: str) -> Optional[float]:
        if contract_id is None:
            return None
        свой = self.by_contract.get((contract_id, element_type))
        if свой:
            return свой
        cp_id = self.counterparty_of_contract.get(contract_id)
        return self.by_counterparty.get((cp_id, element_type)) if cp_id else None

    def counterparty_for_contract(self, contract_id: Optional[int]) -> Optional[str]:
        cp_id = self.counterparty_of_contract.get(contract_id) if contract_id else None
        return self.counterparty_name.get(cp_id) if cp_id else None

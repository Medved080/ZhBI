"""
Страж связи «изделие ↔ позиция контракта» (2026-08-14, живой запрос).

Правило одно: изделие может быть привязано к контракту ТОЛЬКО через
позицию его спецификации — позиция под пару (тип, марка) обязана
существовать, и привязанных изделий по ней не может быть больше
закупленного количества. Отсюда следуют два запрета, которые до сих пор
были только предупреждениями либо не проверялись вовсе:

  1. ПРИВЯЗКА. Нельзя привязать изделие к контракту, где нет позиции под
     его марку, и нельзя привязать больше, чем закуплено. Раньше это было
     разрешено сознательно («контрактация бывает неполной», решение
     2026-08-04) — правило отменено пользователем 2026-08-14: неучтённая
     привязка не видна ни в остатках, ни в отчётах, а количество по
     контракту переставало что-либо значить.
  2. ПРАВКА СПЕЦИФИКАЦИИ. Нельзя уменьшить количество ниже уже
     привязанного, удалить позицию, под которой висят изделия, и сменить
     у такой позиции марку или тип — то есть выдернуть из-под привязки её
     основание.

Почему одним модулем, а не проверкой в каждом месте: путей записи много
(смена статуса одиночная и массовая, карандаш в карточке, массовая правка
через Excel, замена поставщика, удаление записи справочника с переводом на
замену, три вида импорта), и правило, продублированное девять раз, девять
раз и разъедется. Здесь же лежит и формула остатка — та самая, что в
карточке контракта и в дашборде АРМ (план − факт − повреждённые).

СОПОСТАВЛЕНИЕ МАРОК РЕГИСТРОНЕЗАВИСИМОЕ и без крайних пробелов. Причина
та же, что у markKey в дашборде АРМ: марка позиции приходит из файла
контрактации, марка изделия — из чертежа, разными путями, и «15КС1.1»
против «15кс1.1» — известная задвоенность, которую ещё предстоит свернуть
(см. CLAUDE.md). Точное сравнение здесь означало бы ЗАПРЕТ на ровном
месте: позиция есть, а страж её не видит. SQLite без ICU кириллицу не
приводит к одному регистру ни COLLATE NOCASE, ни lower() — нормализация
только на стороне Python.

ДВА РЕЖИМА проверки, и это не дублирование:

  * ТОЧЕЧНЫЙ (link_problem/assert_link_allowed) — «можно ли привязать вот
    это изделие вот к этому контракту». Знает изделие, поэтому объясняет
    отказ по-человечески. Вызывается ДО записи.
  * СВЕРКА ДО/ПОСЛЕ (coverage_state + regressions) — для операций, где
    меняется не привязка, а сама спецификация или сразу многое (импорт,
    массовая правка контрактации, перевод изделий на замену при удалении
    записи справочника). Сравнивает состояние покрытия до и после и
    ругается ТОЛЬКО на то, что стало хуже.

Почему сверка именно «стало хуже», а не «всё чисто»: в накопленных данных
нарушения уже есть — их наплодили те самые пути, которые здесь
закрываются. Требование «после операции всё идеально» заблокировало бы
правку контракта, к которому и так привязано лишнее, то есть починку.
Запрещаем ухудшение, а разбор накопленного — отдельная работа
(scripts/check_contract_coverage.py показывает, что накопилось).
"""

import sqlite3
from typing import Optional

from fastapi import HTTPException


def norm(value: Optional[str]) -> str:
    """Ключ сравнения текста: без крайних пробелов, в нижнем регистре.
    Пустое и NULL — один и тот же ключ (у позиции контракта марка бывает
    не определена, у изделия тоже)."""
    return (value or "").strip().lower()


def line_key(element_type: Optional[str], mark: Optional[str]) -> tuple:
    return (norm(element_type), norm(mark))


def key_label(key: tuple, ячейка: Optional[dict] = None) -> str:
    """Подпись позиции для человека. Ключ нормализован (регистр сбит), и
    печатать его как есть — значит показывать «колонна «7кв3»» там, где в
    данных написано «Колонна «7Кв3»». Поэтому состояние покрытия помнит
    ИСХОДНОЕ написание (см. coverage_state), а ключ остаётся запасным
    вариантом."""
    if ячейка and ячейка.get("label"):
        return ячейка["label"]
    тип, марка = key
    return f"{тип or 'тип не определён'} «{марка or 'без марки'}»"


def _label(element_type: Optional[str], mark: Optional[str]) -> str:
    return f"{element_type or 'тип не определён'} «{mark or 'без марки'}»"


def coverage_state(conn: sqlite3.Connection, contract_id: Optional[int]) -> dict:
    """Покрытие контракта: ключ (тип, марка) -> {quantity, linked, damaged}.

    quantity — сумма количеств позиций контракта с этим ключом (позиций с
    одним ключом бывает несколько: уникальность в БД точная, а ключ здесь
    нормализованный);
    linked   — сколько изделий схемы привязано к контракту под этим ключом
               (статус «Запланирован» не в счёт — у него контракта не
               бывает, инвариант app/contracts.py);
    damaged  — списанные повреждёнными, по ТИПУ (марки у инцидента нет,
               см. ContractIncidentIn) — одно и то же число вычитается из
               каждой позиции этого типа, ровно как в карточке контракта.
    """
    if contract_id is None:
        return {}
    state: dict = {}

    def cell(key, element_type=None, mark=None):
        ячейка = state.setdefault(
            key, {"quantity": 0, "linked": 0, "damaged": 0, "label": None})
        # Написание — первое встреченное, и первой опрашивается СПЕЦИФИКАЦИЯ:
        # если марка в чертеже и в контракте набрана по-разному, в отказе
        # правильнее показать то написание, которое в документе.
        if ячейка["label"] is None and (element_type or mark):
            ячейка["label"] = _label(element_type, mark)
        return ячейка

    for r in conn.execute(
        "SELECT element_type, mark, quantity FROM contract_lines WHERE contract_id = ?",
        (contract_id,),
    ):
        cell(line_key(r["element_type"], r["mark"]),
             r["element_type"], r["mark"])["quantity"] += r["quantity"] or 0
    for r in conn.execute(
        "SELECT element_type, mark, COUNT(*) AS n FROM elements "
        "WHERE contract_id = ? AND current_status != 'planned' GROUP BY element_type, mark",
        (contract_id,),
    ):
        cell(line_key(r["element_type"], r["mark"]),
             r["element_type"], r["mark"])["linked"] += r["n"]
    повреждено: dict = {}
    for r in conn.execute(
        "SELECT element_type, COALESCE(SUM(quantity), 0) AS n FROM contract_incidents "
        "WHERE contract_id = ? GROUP BY element_type",
        (contract_id,),
    ):
        повреждено[norm(r["element_type"])] = r["n"]
    for key, ячейка in state.items():
        ячейка["damaged"] = повреждено.get(key[0], 0)
    return state


def _shortage(ячейка: dict) -> int:
    """Насколько привязано больше, чем закуплено (0 — всё в порядке).
    Формула остатка та же, что в карточке контракта: план − факт −
    повреждённые."""
    return max(0, ячейка["linked"] + ячейка["damaged"] - ячейка["quantity"])


def state_problems(state: dict) -> list:
    """Все нарушения покрытия в готовом состоянии — для диагностики
    (scripts/check_contract_coverage.py) и для сообщений об отказе."""
    проблемы = []
    for key, ячейка in sorted(state.items()):
        нехватка = _shortage(ячейка)
        if not нехватка:
            continue
        if ячейка["quantity"] == 0:
            проблемы.append(
                f"{key_label(key, ячейка)}: позиции в спецификации нет, а привязано изделий: "
                f"{ячейка['linked']}")
        else:
            хвост = f", списано повреждёнными {ячейка['damaged']}" if ячейка["damaged"] else ""
            проблемы.append(
                f"{key_label(key, ячейка)}: по спецификации {ячейка['quantity']}, "
                f"привязано {ячейка['linked']}{хвост} — превышение на {нехватка}")
    return проблемы


def regressions(before: dict, after: dict) -> list:
    """Что стало ХУЖЕ между двумя состояниями покрытия. Ключи, где
    нарушение было и не выросло, молчат — иначе операция чинить
    накопленное было бы нельзя (см. шапку модуля)."""
    проблемы = []
    for key in sorted(set(before) | set(after)):
        пусто = {"quantity": 0, "linked": 0, "damaged": 0, "label": None}
        было = _shortage(before.get(key, пусто))
        стало_ячейка = after.get(key, dict(пусто, label=before.get(key, пусто).get("label")))
        стало = _shortage(стало_ячейка)
        if стало <= было:
            continue
        if стало_ячейка["quantity"] == 0:
            проблемы.append(
                f"{key_label(key, стало_ячейка)}: позиции не остаётся, а привязано изделий: "
                f"{стало_ячейка['linked']}")
        else:
            проблемы.append(
                f"{key_label(key, стало_ячейка)}: остаётся по спецификации {стало_ячейка['quantity']}, "
                f"а привязано изделий {стало_ячейка['linked']}"
                + (f" и списано повреждёнными {стало_ячейка['damaged']}"
                   if стало_ячейка["damaged"] else ""))
    return проблемы


def link_problem(
    conn: sqlite3.Connection,
    contract_id: Optional[int],
    element_type: Optional[str],
    mark: Optional[str],
    element_id: Optional[int] = None,
    current_contract_id: Optional[int] = None,
    current_status: Optional[str] = None,
) -> Optional[str]:
    """Можно ли привязать ЭТО изделие к ЭТОМУ контракту. Текст отказа или
    None.

    Изделие, которое УЖЕ привязано к этому контракту и уже занимает своё
    место (статус не «Запланирован»), не проверяется вовсе: смена его
    статуса, даты или комментария ничего не ухудшает, а на накопленном
    превышении такая проверка заперла бы изделие намертво.

    Занятые места считаются по БД на момент вызова — поэтому массовая
    смена статуса, где apply_status_change идёт по элементам в одной
    транзакции, видит уже расписанные в этой же пачке места и на N+1-м
    изделии отказывает.
    """
    if contract_id is None:
        return None
    if current_contract_id == contract_id and current_status and current_status != "planned":
        return None

    key = line_key(element_type, mark)
    закуплено = 0
    for r in conn.execute(
        "SELECT element_type, mark, quantity FROM contract_lines WHERE contract_id = ?",
        (contract_id,),
    ):
        if line_key(r["element_type"], r["mark"]) == key:
            закуплено += r["quantity"] or 0
    if закуплено == 0:
        return (f"В спецификации контракта нет позиции под {_label(element_type, mark)} — "
                f"привязать изделие к этому контракту нельзя. Заведите позицию в "
                f"справочнике контрактов или выберите другой контракт.")

    занято = 0
    for r in conn.execute(
        "SELECT id, element_type, mark FROM elements "
        "WHERE contract_id = ? AND current_status != 'planned'",
        (contract_id,),
    ):
        if r["id"] == element_id:
            continue
        if line_key(r["element_type"], r["mark"]) == key:
            занято += 1
    повреждено = conn.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS n FROM contract_incidents "
        "WHERE contract_id = ? AND element_type IS ?",
        (contract_id, element_type),
    ).fetchone()["n"]
    if занято + повреждено + 1 > закуплено:
        хвост = f", списано повреждёнными {повреждено}" if повреждено else ""
        return (f"По позиции {_label(element_type, mark)} закуплено {закуплено}, уже привязано "
                f"{занято}{хвост} — свободного количества в контракте нет.")
    return None


def assert_link_allowed(conn, contract_id, element_type, mark, element_id=None,
                        current_contract_id=None, current_status=None,
                        приставка: str = "") -> None:
    """То же, что link_problem, но отказом-исключением — для роутов."""
    проблема = link_problem(conn, contract_id, element_type, mark, element_id,
                            current_contract_id, current_status)
    if проблема:
        raise HTTPException(status_code=409, detail=(приставка + проблема).strip())


def assert_no_regression(conn, contract_ids, before_states: dict, заголовок: str) -> None:
    """Сверка «до/после» для операций, меняющих спецификацию или сразу
    много привязок. before_states — то, что вернул coverage_state ДО
    изменений, по каждому затронутому контракту.

    Вызывается ПЕРЕД commit: исключение откатывает всю транзакцию, то есть
    операция не применяется частично.
    """
    проблемы = []
    for contract_id in contract_ids:
        новые = regressions(before_states.get(contract_id, {}),
                            coverage_state(conn, contract_id))
        проблемы.extend(новые)
    if проблемы:
        raise HTTPException(
            status_code=409,
            detail=(f"{заголовок} " + "; ".join(проблемы[:10])
                    + (f" (и ещё {len(проблемы) - 10})" if len(проблемы) > 10 else "")
                    + ". Сначала переназначьте изделия на другой контракт или снимите "
                      "с них привязку."),
        )

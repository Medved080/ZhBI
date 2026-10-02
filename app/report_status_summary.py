"""
«Статус монтажа», версия 2 — сводка плана/факта и темпов (2026-10-01, живой запрос).

Короткая таблица для правой панели вместо дерева статусов: левая часть — сколько изделий поставлено/смонтировано, сколько
должно было быть к сегодняшнему дню по плану и насколько отстаём; правая — требуемая/расчётная/прогнозная даты завершения СМР и
темпы монтажа. Определения согласованы с пользователем:

* **Факт-Поставка** — изделия в статусе «Доставлен» и выше; **Факт-Монтаж** — «Смонтирован» и «Принят».
* **План-Монтаж** — по БАЗОВОМУ графику: изделия с «Датой завершения СМР» не позже отчётной даты.
* **План-Поставка** — по базовому графику, с двухнедельным запасом: монтаж должен быть обеспечен изделиями за 2 недели, поэтому
  «требуемая дата поставки» = «Дата начала СМР» − 14 дней; считаются изделия, у которых она не позже отчётной даты
  (уточнение пользователя 2026-10-02; прежде считалась «Плановая дата поставки»).
* **Отставание от плана** = План − Факт, в % от плана; проценты Факта и Плана — от «Всего ЖБИ».
* **Требуемая дата** — максимальная дата базового графика (наибольшая «Дата завершения СМР»); **Расчётная дата** — максимальная
  дата актуализированного графика (наибольшее прогнозное окончание СМР последней актуализации, факт смонтированных не учитывается).
  Базовый график — поля изделия (источник правды директивных дат, их правят руками), как в карточке и «Отклонении от базового».
* **Требуемый темп** = (Всего − Смонтировано) / дней до требуемой даты; **Расчётный темп** — то же до расчётной даты;
  **Фактический темп** — смонтировано за последние 7 дней / 7; **Прогнозная дата** = отчётная дата + остаток / фактический темп.
* **Отставание, дней** = требуемая дата − расчётная (минус — отстаём); второе — требуемая − прогнозная.

Считается по изделиям отбора (как остальные блоки вкладки «Статус»): серверу приходит готовый список id.
"""

import math
from datetime import date, timedelta
from typing import Optional

from app.reports import visible_elements_clause
from app.schedule_versions import forecast_dates

# Откуда брать ПЛАН (2026-10-02, живой запрос): "baseline" — базовый график (поля изделия «Дата начала/завершения СМР»), "current" —
# последняя актуализация графика (там у смонтированных изделий вместо прогноза стоит факт, см. schedule_versions.forecast_dates).
PLAN_SOURCES = ("baseline", "current")
DEFAULT_PLAN_SOURCE = "baseline"


def normalize_plan_source(value) -> str:
    return value if value in PLAN_SOURCES else DEFAULT_PLAN_SOURCE


def plan_dates(conn, rows, object_id: Optional[int], source: Optional[str]) -> dict:
    """Плановые даты изделий: id -> (дата поставки, дата монтажа) как `date` (None — плана нет).

    Один источник правды для сводки «Статус монтажа» (версия 2) и отчёта «Динамика поставки и монтажа», чтобы их числа сходились.
    * Монтаж — «Дата завершения СМР»; поставка — «Дата начала СМР» минус 2 недели (монтаж должен быть обеспечен изделиями за 2 недели).
    * baseline — даты базового графика (поля изделия); current — даты последней актуализации. Смонтированные изделия в актуализацию
      не входят, у них там факт: дата поставки — фактическая БЕЗ сдвига на 2 недели (это уже не требование, а событие).
    `rows` — строки с полями id, ps (начало СМР базового графика), pe (завершение СМР базового графика).
    """
    source = normalize_plan_source(source)
    out = {}
    if source == "current":
        forecast = forecast_dates(conn, object_id)
        for r in rows:
            fs, fe, is_fact = forecast.get(r["id"], (None, None, False))
            start = _d(fs)
            delivery = start if (is_fact or start is None) else start - timedelta(days=DELIVERY_LEAD_DAYS)
            out[r["id"]] = (delivery, _d(fe))
    else:
        for r in rows:
            ps = _d(r["ps"])
            out[r["id"]] = (ps - timedelta(days=DELIVERY_LEAD_DAYS) if ps else None, _d(r["pe"]))
    return out


def plan_day_counts(conn, where: str, params: list, object_id: Optional[int], source: Optional[str]):
    """Для «Динамики»: ряды плана «по дням» — (монтаж, поставка), каждый список словарей {"d": ГГГГ-ММ-ДД, "n": число}."""
    rows = conn.execute(
        f"SELECT e.id, e.project_smr_start_date AS ps, e.project_delivery_date AS pe FROM elements e {where}", params).fetchall()
    montage, delivery = {}, {}
    for delivery_d, montage_d in plan_dates(conn, rows, object_id, source).values():
        if montage_d:
            montage[montage_d.isoformat()] = montage.get(montage_d.isoformat(), 0) + 1
        if delivery_d:
            delivery[delivery_d.isoformat()] = delivery.get(delivery_d.isoformat(), 0) + 1
    pack = lambda m: [{"d": d, "n": n} for d, n in sorted(m.items())]
    return pack(montage), pack(delivery)


DELIVERED_UP = ("delivered", "installed", "accepted")
DELIVERY_LEAD_DAYS = 14   # запас изделий для обеспечения монтажа
INSTALLED_UP = ("installed", "accepted")
TEMPO_WINDOW_DAYS = 7


def _d(value) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _share(n: int, of: int) -> Optional[int]:
    return round(100 * n / of) if of else None


def build_status_summary(conn, source_file: Optional[str], element_ids: Optional[list],
                         object_id: Optional[int], on_date: Optional[str] = None,
                         plan_source: Optional[str] = None) -> dict:
    today = _d(on_date) or date.today()
    clauses, params = [visible_elements_clause("e")], []
    if source_file:
        clauses.append("e.source_file = ?")
        params.append(source_file)
    if element_ids is not None:
        if not element_ids:
            clauses.append("1=0")
        else:
            clauses.append(f"e.id IN ({','.join('?' * len(element_ids))})")
            params.extend(element_ids)
    rows = conn.execute(
        f"SELECT e.id, e.current_status AS st, e.project_smr_start_date AS ps, e.project_delivery_date AS pe "
        f"FROM elements e WHERE {' AND '.join(clauses)}", params).fetchall()
    forecast = forecast_dates(conn, object_id)

    total = len(rows)
    fact_delivery = sum(1 for r in rows if r["st"] in DELIVERED_UP)
    fact_montage = sum(1 for r in rows if r["st"] in INSTALLED_UP)
    plan_delivery = montage_plan = 0
    required = calc = None
    installed_recent = 0
    window_start = today - timedelta(days=TEMPO_WINDOW_DAYS - 1)
    plan = plan_dates(conn, rows, object_id, plan_source)
    for r in rows:
        # План (откуда — plan_source): поставка — требуемая дата поставки, монтаж — «Дата завершения СМР»; не позже отчётной даты
        delivery_d, montage_d = plan[r["id"]]
        if delivery_d and delivery_d <= today:
            plan_delivery += 1
        if montage_d and montage_d <= today:
            montage_plan += 1
        # Требуемая дата — максимум БАЗОВОГО графика (от выбора источника плана не зависит)
        pe = _d(r["pe"])
        if pe and (required is None or pe > required):
            required = pe
        fs, fe, is_fact = forecast.get(r["id"], (None, None, False))
        fe_d = _d(fe)
        if fe_d:
            # расчётная дата — максимум актуализированного графика (у смонтированных вместо прогноза факт — он не в счёт)
            if not is_fact and (calc is None or fe_d > calc):
                calc = fe_d
            # последние 7 дней — по ФАКТУ монтажа (у смонтированных forecast_dates отдаёт именно его)
            if is_fact and window_start <= fe_d <= today:
                installed_recent += 1

    remaining = total - fact_montage

    def tempo_to(target: Optional[date]) -> Optional[int]:
        if target is None or target <= today or remaining <= 0:
            return None
        return round(remaining / (target - today).days)

    fact_tempo_raw = installed_recent / TEMPO_WINDOW_DAYS
    forecast_date = None
    if remaining <= 0:
        forecast_date = today
    elif fact_tempo_raw > 0:
        forecast_date = today + timedelta(days=math.ceil(remaining / fact_tempo_raw))

    def lag(plan: int, fact: int) -> dict:
        return {"n": plan - fact, "pct": _share(plan - fact, plan)}

    def days(a: Optional[date], b: Optional[date]) -> Optional[int]:
        return (a - b).days if a and b else None

    return {
        "on_date": today.isoformat(),
        "plan_source": normalize_plan_source(plan_source),
        "total": total,
        "remaining": remaining,
        "fact": {"delivery": {"n": fact_delivery, "pct": _share(fact_delivery, total)},
                 "montage": {"n": fact_montage, "pct": _share(fact_montage, total)}},
        "plan": {"delivery": {"n": plan_delivery, "pct": _share(plan_delivery, total)},
                 "montage": {"n": montage_plan, "pct": _share(montage_plan, total)}},
        "lag": {"delivery": lag(plan_delivery, fact_delivery), "montage": lag(montage_plan, fact_montage)},
        "required_date": required.isoformat() if required else None,
        "calc_date": calc.isoformat() if calc else None,
        "forecast_date": forecast_date.isoformat() if forecast_date else None,
        "required_tempo": tempo_to(required),
        "calc_tempo": tempo_to(calc),
        # менее 10 в сутки — с десятой долей, чтобы небольшой темп не округлялся в «0»
        "fact_tempo": (round(fact_tempo_raw) if fact_tempo_raw >= 10 else round(fact_tempo_raw, 1)),
        "lag_calc_days": days(required, calc),
        "lag_forecast_days": days(required, forecast_date),
    }

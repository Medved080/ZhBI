"""Стоимость моделей роутера red_mad_robot и расход помощника — для осознанного выбора модели.

Перенесено из проекта «Радар тендеров» (radar/rmr_pricing.py). Цены берутся из прайс-листа
(`app/rmr_prices.json`, собран `scripts/import_rmr_prices.py`): рубли за 1 млн токенов, наценка сервиса
уже включена, НДС — сверху. Баланса роутера по API нет, поэтому «биллинг» здесь — это ссылка на его
страницу и СВОЙ учёт: токены каждого вопроса берутся из ответа модели (если сервер их не прислал —
оцениваются по длине текста и помечаются), пишутся в журнал действий событием `ai_router_usage`
вместе со стоимостью по прайсу и пересчитываются в сводку. Это оценка, а не счёт роутера: кэш токенов
и курс на дату списания в ней не учитываются. Очистка журнала администратором стирает и этот учёт.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

from app import activity
from app.db import get_connection
from app.rmr_router import BILLING_URL

PRICE_FILE = Path(__file__).with_name("rmr_prices.json")
ACTION = "ai_router_usage"
# Типичный вопрос помощника: поиск по данным и ответ — несколько вызовов модели, суммарно столько токенов.
TYPICAL_INPUT, TYPICAL_OUTPUT = 12_000, 1_200
CALLS_PER_QUESTION = 3         # для оценки «до …»: план поиска, поиск, ответ


@lru_cache(maxsize=1)
def table() -> dict:
    try:
        return json.loads(PRICE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"models": []}


def _norm(name: str) -> str:
    name = (name or "").strip().lower()
    return name.split("/", 1)[1] if "/" in name else name


def lookup(model: str, long_context: bool = False) -> dict | None:
    """Строка прайса по имени модели: точное совпадение, затем без префикса провайдера.
    У моделей с порогом контекста («<200K» / «>200K») берётся обычный тариф, если не просят длинный."""
    rows = table()["models"]
    found = [m for m in rows if m["id"].lower() == (model or "").strip().lower()]
    if not found:
        found = [m for m in rows if _norm(m["id"]) == _norm(model)]
    if not found:
        return None
    longs = [m for m in found if ">" in (m["tier"] or "")]
    base = [m for m in found if m not in longs] or found
    return (longs or base)[0] if long_context else base[0]


def cost(row: dict | None, prompt_tokens: int, completion_tokens: int) -> float | None:
    """Рубли БЕЗ НДС за запрос по тарифу входа и выхода; кэш не учитывается (верхняя оценка)."""
    if not row or row.get("input") is None or row.get("output") is None:
        return None
    return prompt_tokens / 1e6 * row["input"] + completion_tokens / 1e6 * row["output"]


def record_usage(user, model: str, meter, *, kind: str = "вопрос помощника", request_id: str | None = None) -> None:
    """Записать расход токенов одного вопроса в журнал. Журнал не бросает исключений: учёт не должен ронять ответ."""
    if not meter or not meter.requests:
        return
    rub = cost(lookup(model), meter.prompt, meter.completion)
    activity.log(ACTION, user=user, new_value=model, request_id=request_id, details={
        "модель": model, "вид": kind, "токены вход": meter.prompt, "токены выход": meter.completion,
        "вызовов модели": meter.requests, "оценка по длине текста": meter.estimated,
        "стоимость без НДС, ₽": round(rub, 4) if rub is not None else None})


def _empty() -> dict:
    return {"requests": 0, "tokens_in": 0, "tokens_out": 0, "rub": 0.0, "unpriced": 0, "with_tokens": 0}


def _add(total: dict, tokens_in: int, tokens_out: int, rub) -> None:
    total["requests"] += 1
    total["with_tokens"] += 1 if tokens_in else 0
    total["tokens_in"] += tokens_in
    total["tokens_out"] += tokens_out
    if isinstance(rub, (int, float)):
        total["rub"] += float(rub)
    else:
        total["unpriced"] += 1


def usage_summary(days: int = 30) -> dict:
    """Расход помощника по журналу: сутки и период, по моделям."""
    now = datetime.utcnow()      # журнал хранит время сервера в UTC
    fmt = "%Y-%m-%d %H:%M:%S"
    conn = get_connection()
    try:
        rows = conn.execute("SELECT at, details FROM activity_log WHERE action=? AND at >= ? ORDER BY id",
                            (ACTION, (now - timedelta(days=days)).strftime(fmt))).fetchall()
    finally:
        conn.close()
    day_border = (now - timedelta(hours=24)).strftime(fmt)
    out = {"day": _empty(), "period": _empty(), "days": days}
    by_model: dict[str, dict] = {}
    for at, details in rows:
        try:
            d = json.loads(details or "{}")
        except ValueError:
            continue
        tokens_in, tokens_out = int(d.get("токены вход") or 0), int(d.get("токены выход") or 0)
        rub = d.get("стоимость без НДС, ₽")
        for key in ("period",) + (("day",) if at >= day_border else ()):
            _add(out[key], tokens_in, tokens_out, rub)
        _add(by_model.setdefault(d.get("модель") or "—", _empty()), tokens_in, tokens_out, rub)
    out["models"] = [{"model": m, **v} for m, v in sorted(by_model.items(), key=lambda x: -x[1]["requests"])]
    return out


def view(model: str, context_tokens: int) -> dict:
    """Всё для блока «Стоимость и биллинг» на странице настроек."""
    usage = usage_summary()
    # Типичный расход берём по факту, когда набралось хотя бы пять вопросов с токенами
    samples = usage["period"]["with_tokens"]
    measured = samples >= 5
    typ_in = round(usage["period"]["tokens_in"] / samples) if measured else TYPICAL_INPUT
    typ_out = round(usage["period"]["tokens_out"] / samples) if measured else TYPICAL_OUTPUT
    max_in, max_out = context_tokens * CALLS_PER_QUESTION, 4096 * CALLS_PER_QUESTION
    rows = []
    for m in table()["models"]:
        if ">" in (m["tier"] or ""):
            continue                       # тариф длинного контекста — вторым планом, в основную таблицу не выносим
        rows.append({**m, "per_question": cost(m, typ_in, typ_out), "per_question_max": cost(m, max_in, max_out)})
    current = lookup(model or "")
    return {"billing_url": BILLING_URL, "source": table().get("source"), "fx_date": table().get("fx_date"),
            "fx_rate": table().get("fx_rate"), "markup_percent": table().get("markup_percent"),
            "vat_percent": table().get("vat_percent"), "models": rows, "current": current["id"] if current else None,
            "assumptions": {"typical_in": typ_in, "typical_out": typ_out, "measured": measured,
                            "max_in": max_in, "max_out": max_out},
            "usage": usage}

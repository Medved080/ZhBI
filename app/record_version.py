"""Версия записи справочника контрактации — для «оптимистичной» проверки устаревших данных (V2, область комплектовщика).

Зачем. Правка контрагента, договора, спецификации и контракта в этих обработчиках — замена ВСЕЙ записи целиком (поля формы + нормативы,
позиции и инциденты). Два человека открыли одну запись, первый исправил телефон, второй — ИНН: без проверки второй сохранил бы свою форму
целиком и молча затёр правку первого. Здесь запись получает `version` — короткий отпечаток её СОДЕРЖИМОГО (а не времени: `updated_at`
хранится с точностью до секунды, две правки в одну секунду не различимы). Клиент присылает `expected_version` — то, что он видел; если у записи
к моменту сохранения другая версия, обработчик отвечает 409 `{"conflict": "stale_version"}` и ничего не меняет.

Совместимость. Поле необязательное: клиент, которому проверка не нужна (V1), его не присылает — поведение прежнее. Проверка выполняется ПОД
блокировкой записи (`app.db.begin_write`), поэтому между сверкой и записью никто вклиниться не может.

В отпечаток входит только то, что человек правит формой; производные величины (факт, остаток, число привязанных изделий) — нет: распределение
изделий на контракт — не правка документа и не должно делать открытую форму «устаревшей».
"""

import hashlib
import json
from typing import Optional

from fastapi import HTTPException

STALE_MESSAGE = ("Запись изменил другой пользователь после того, как вы её открыли — ничего не сохранено. "
                 "Обновите данные и повторите правку.")


def digest(payload) -> str:
    """Отпечаток произвольной JSON-совместимой структуры (устойчив к порядку ключей)."""
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _sorted(rows):
    """Порядок строк не значим; сортировка устойчива к None (в позициях марка бывает пустой) — по JSON-представлению строки."""
    return sorted(rows, key=lambda r: json.dumps(r, ensure_ascii=False, default=str))


def _num(v):
    """Числа сравниваются как числа: 5 и 5.0 — одно значение."""
    return None if v is None else float(v)


def counterparty_version(row, capacity: list) -> str:
    return digest({
        "full_name": row["full_name"], "short_name": row["short_name"], "inn": row["inn"], "kpp": row["kpp"],
        "ogrn": row["ogrn"], "legal_address": row["legal_address"], "contact_person": row["contact_person"],
        "contact_phone": row["contact_phone"], "code": row["code"],
        "capacity": _sorted([c["element_type"], _num(c["per_day"]), c.get("comment") or None] for c in capacity),
    })


def agreement_version(row) -> str:
    return digest({"counterparty_id": row["counterparty_id"], "number": row["number"],
                   "agreement_date": row["agreement_date"], "object_id": row["object_id"]})


def specification_version(row) -> str:
    return digest({"agreement_id": row["agreement_id"], "number": row["number"],
                   "specification_date": row["specification_date"]})


def contract_version(row, lines, incidents, capacity) -> str:
    """lines/incidents — строки БД (sqlite3.Row или dict), capacity — [{element_type, per_day}]."""
    return digest({
        "specification_id": row["specification_id"], "theme": row["theme"] or None, "is_archived": bool(row["is_archived"]),
        "lines": _sorted([r["element_type"], r["mark"], r["quantity"]] for r in lines),
        "incidents": _sorted([r["element_type"], r["quantity"], r["incident_date"], r["description"] or None] for r in incidents),
        "capacity": _sorted([c["element_type"], _num(c["per_day"])] for c in capacity),
    })


def assert_fresh(expected: Optional[str], actual: str, what: str = "") -> None:
    """Сверка присланной версии с текущей. expected=None — клиент проверку не запрашивал (V1)."""
    if expected is None:
        return
    if expected != actual:
        raise HTTPException(
            status_code=409,
            detail={"message": (what + " — " if what else "") + STALE_MESSAGE, "conflict": "stale_version"},
        )

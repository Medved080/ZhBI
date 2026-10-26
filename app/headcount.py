"""Учёт численности персонала по объектам — API (2026-10-09, Docs/headcount.md).

Что хранится. Сколько рабочих, ИТР и механизаторов подрядчик вывел на объект за день по виду работ (кодификатор). С 2026-10-12 число
разделено на «Рабочие» (`workers`; сюда относится всё, что исторически вносили как «количество») и «ИТР» (`itr`), с 2026-10-26 добавлены
«Механизаторы» (`mech`); «Итого» = рабочие + ИТР + механизаторы, в БД не хранится — считается в запросах и в ответах API (`total`).
Подрядчик объекта (с 2026-10-26) — ссылка на контрагента ЕДИНОГО справочника `counterparties`: название и ИНН показываются оттуда. Ключ записи — (объект, день,
подрядчик, вид работ): повторный ввод по ключу заменяет число, прежнее остаётся в `headcount_history`. Вносит менеджер проекта
(руководитель проекта) или начальник участка; право — раздел `headcount` (app/features.py).

Срок по приказу П-ОД-38 (приложение 1): данные за рабочий день — до 11:00 того же дня, за субботу и воскресенье — до 11:00
понедельника. Вносить можно и позже, без ограничений; такая запись получает `late = 1` при ПЕРВОМ внесении и подсвечивается.
Праздничные дни не учитываются: календаря нерабочих дней в системе нет. Время — московское: сервис живёт по UTC, а срок задан
местным временем.

Отчёт (`/headcount/report`) устроен так, чтобы показатели можно было складывать вверх по иерархии: «среднее за неделю» и «среднее
за месяц» — сумма человек-дней за окно, делённая на число дней окна, в которые в ВЫБОРКЕ есть хоть одна запись; делитель один на
всю выборку, поэтому среднее у родителя равно сумме средних у детей. (Допущение, в макете Power BI формула не раскрыта — сверить с
заказчиком.)
"""

import re
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import activity
from app.access import accessible_object_ids, assert_object_feature, has_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection

FEATURE_KEY = "headcount"
MSK = ZoneInfo("Europe/Moscow")
DEADLINE_TIME = time(11, 0)
MAX_WORKERS = 100_000
MAX_ROWS_PER_SAVE = 500
STAFF_TITLES = {"total": "Итого", "workers": "Рабочие", "itr": "ИТР", "mech": "Механизаторы"}
SOURCES = ("form", "import", "bot")

router = APIRouter(prefix="/objects/{object_id}/headcount", tags=["headcount"])
global_router = APIRouter(prefix="/headcount", tags=["headcount"])


# ------------------------------------------------------------------ время и срок

def now_msk() -> datetime:
    return datetime.now(MSK)


def deadline_for(work_date: date) -> datetime:
    """Срок внесения численности за день: рабочий день — 11:00 этого же дня; суббота и воскресенье — 11:00 понедельника."""
    due = work_date
    if due.weekday() == 5:
        due += timedelta(days=2)
    elif due.weekday() == 6:
        due += timedelta(days=1)
    return datetime.combine(due, DEADLINE_TIME, tzinfo=MSK)


def _db_time(value: Optional[str]) -> Optional[datetime]:
    """Момент из БД (`datetime('now')` — UTC без пояса, строка «ГГГГ-ММ-ДД ЧЧ:ММ:СС») → московское время."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("T", " ")).replace(tzinfo=timezone.utc).astimezone(MSK)
    except ValueError:
        return None


def _db_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def is_late(work_date: date, entered_at: datetime) -> bool:
    return entered_at > deadline_for(work_date)


def _parse_date(value: str, field: str = "Дата") -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field}: ожидается дата в формате ГГГГ-ММ-ДД")


# ------------------------------------------------------------------ ИНН и подрядчики

def clean_inn(value: Optional[str]) -> Optional[str]:
    """ИНН как внесён: без пробелов, пустое → None. Содержимое не проверяется — грузим как есть (решение 2026-10-09)."""
    value = "".join(str(value or "").split())
    return value or None


def inn_status(inn: Optional[str]) -> str:
    """ok — 10 цифр (юрлицо) или 12 (ИП, физлицо); none — ИНН не задан; unverified — «ИНН не проверен» (не цифры или другая длина)."""
    if not inn:
        return "none"
    if inn.isdigit() and len(inn) in (10, 12):
        return "ok"
    return "unverified"


def _clean_name(value: Optional[str]) -> Optional[str]:
    value = " ".join(str(value or "").split())
    return value or None


def _fold(value: Optional[str]) -> str:
    """Название для сравнения: без лишних пробелов и без учёта регистра (в Python — SQLite кириллицу к одному регистру не приводит)."""
    return " ".join(str(value or "").split()).lower()


# «Подрядчик глазами справочника» (2026-10-26, единый справочник): у связанного с контрагентом подрядчика название и ИНН берутся ИЗ общей
# таблицы counterparties — правка реквизитов в «Справочнике контрагентов» сразу видна в численности, отчётах и Excel. Запасные
# name_raw/inn_raw показываются только пока связи нет. Псевдонимы в запросах: c — headcount_contractors, cp — counterparties.
CTR_NAME = ("(CASE WHEN cp.id IS NOT NULL THEN COALESCE(NULLIF(TRIM(cp.short_name), ''), NULLIF(TRIM(cp.full_name), '')) "
            "ELSE c.name_raw END)")
CTR_INN = "(CASE WHEN cp.id IS NOT NULL THEN NULLIF(REPLACE(TRIM(cp.inn), ' ', ''), '') ELSE c.inn_raw END)"


def contractor_display(name: Optional[str], inn: Optional[str]) -> str:
    """Подпись подрядчика: «Название (ИНН …)»; без названия — «ИНН …». Название вида «ИНН 123», заведённое по одному ИНН, не дублируется."""
    name = _clean_name(name)
    if name and inn:
        return name if _fold(name) == _fold(f"ИНН {inn}") else f"{name} (ИНН {inn})"
    if inn:
        return f"ИНН {inn}"
    return name or ""


def find_counterparty_by_inn(conn: sqlite3.Connection, inn: Optional[str]) -> Optional[int]:
    """Контрагент по ИНН — только если он ОДИН: при двух с одним ИНН выбирать молча нельзя."""
    if not inn:
        return None
    rows = conn.execute("SELECT id FROM counterparties WHERE REPLACE(TRIM(COALESCE(inn, '')), ' ', '') = ?", (inn,)).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def find_counterparty_by_name(conn: sqlite3.Connection, name: Optional[str]) -> Optional[int]:
    """Контрагент по точному названию (краткому или полному, без учёта регистра) — только если он ОДИН."""
    needle = _fold(name)
    if not needle:
        return None
    found = [r["id"] for r in conn.execute("SELECT id, short_name, full_name FROM counterparties")
             if needle in (_fold(r["short_name"]), _fold(r["full_name"]))]
    return found[0] if len(found) == 1 else None


def insert_counterparty(conn: sqlite3.Connection, name: str, inn: Optional[str]) -> int:
    """Новый контрагент в общем справочнике: краткое и полное название — одно и то же (остальное дополнят в «Справочнике контрагентов»).
    Код для подписи на схеме выдаёт та же функция, что и у справочника. Журнал ведёт вызывающий."""
    from app.counterparties import find_or_create_counterparty
    return find_or_create_counterparty(conn, name, name, inn=inn)


def ensure_counterparty(conn: sqlite3.Connection, inn: Optional[str], name: Optional[str]) -> Optional[int]:
    """Контрагент общего справочника для подрядчика с ИНН и/или названием: найти или создать. ЕДИНАЯ функция для обработки обновления,
    загрузки из SharePoint и всего, что заводит подрядчиков без человека (решение 2026-10-26).

    Порядок: по ИНН (единственный); при двух контрагентах с одним ИНН — None (молча выбирать нельзя, и третьего не заводим); без ИНН —
    по точному названию, иначе новый. Новый получает краткое и полное название = название или «ИНН <номер>». Без ИНН и без названия — None.
    Вызывающий владеет транзакцией и журналом."""
    inn, name = clean_inn(inn), _clean_name(name)
    if inn:
        found = conn.execute("SELECT id FROM counterparties WHERE REPLACE(TRIM(COALESCE(inn, '')), ' ', '') = ?", (inn,)).fetchall()
        if len(found) > 1:
            return None
        if found:
            return found[0]["id"]
    elif name:
        found_id = find_counterparty_by_name(conn, name)
        if found_id is not None:
            return found_id
        if any(_fold(name) in (_fold(r["short_name"]), _fold(r["full_name"])) for r in conn.execute("SELECT short_name, full_name FROM counterparties")):
            return None   # несколько одноимённых — не выбираем
    else:
        return None
    return insert_counterparty(conn, name or f"ИНН {inn}", inn)


def _contractor_out(row: sqlite3.Row) -> dict:
    name, inn = row["ctr_name"], row["ctr_inn"]
    status = inn_status(inn)
    linked = row["counterparty_id"] is not None
    return {
        "id": row["id"], "object_id": row["object_id"], "name": name, "inn": inn,
        "counterparty_id": row["counterparty_id"], "counterparty_name": name if linked else None, "linked": linked,
        "display": contractor_display(name, inn), "inn_status": status,
        "inn_note": "ИНН не проверен" if status == "unverified" else None,
        "records": row["records"],
    }


_CONTRACTOR_SELECT = (
    f"SELECT c.*, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn, "
    "(SELECT COUNT(*) FROM headcount_records r WHERE r.contractor_id = c.id) AS records "
    "FROM headcount_contractors c LEFT JOIN counterparties cp ON cp.id = c.counterparty_id ")


def _contractor_row(conn, object_id: int, contractor_id: int) -> sqlite3.Row:
    row = conn.execute(_CONTRACTOR_SELECT + "WHERE c.id = ? AND c.object_id = ?", (contractor_id, object_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Подрядчик не найден на этом объекте")
    return row


class ContractorIn(BaseModel):
    """Подрядчик объекта — ссылка на контрагента общего справочника.
    `counterparty_id` — выбрать контрагента из справочника (название и ИНН подтянутся); `create_counterparty` + `name` (+ `inn`) — завести
    нового контрагента в общем справочнике и сразу добавить его на объект (нужно право на раздел «Справочник контрагентов»).
    Без того и другого подрядчика не добавить. `name`/`inn` без `create_counterparty` — только правка несвязанной (старой) записи."""
    name: Optional[str] = None
    inn: Optional[str] = None
    counterparty_id: Optional[int] = None
    create_counterparty: bool = False


NEED_COUNTERPARTY_RIGHT = ("Заводить контрагентов в общем справочнике может пользователь с правом на раздел «Справочник контрагентов» "
                           "(Контрактация). Обратитесь к такому пользователю: он добавит контрагента, и вы выберете его из списка.")


def _assert_can_create_counterparty(conn, user) -> None:
    """Серверная проверка права заводить контрагентов (клиенту не доверяем): то же право, что у `POST /counterparties`, — раздел
    `counterparties` на запись. Права на численность для этого мало и обхода нет."""
    if not has_feature(conn, user, "counterparties", "write"):
        raise HTTPException(status_code=403, detail=NEED_COUNTERPARTY_RIGHT)


def _pool_conflict(conn, object_id: int, counterparty_id: Optional[int], inn: Optional[str], name: Optional[str],
                   exclude_id: Optional[int] = None) -> Optional[sqlite3.Row]:
    """Запись пула объекта, с которой подрядчик совпадает: тот же контрагент; либо ещё не связанная запись с тем же ИНН (а без ИНН — с тем
    же названием, без учёта регистра)."""
    for r in conn.execute("SELECT id, counterparty_id, name_raw, inn_raw FROM headcount_contractors WHERE object_id = ?", (object_id,)):
        if r["id"] == exclude_id:
            continue
        if counterparty_id is not None and r["counterparty_id"] == counterparty_id:
            return r
        if r["counterparty_id"] is None:
            if inn and r["inn_raw"] == inn:
                return r
            if not inn and not r["inn_raw"] and name and r["name_raw"] and _fold(r["name_raw"]) == _fold(name):
                return r
    return None


@router.get("/contractors")
def list_contractors(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(_CONTRACTOR_SELECT + "WHERE c.object_id = ?", (object_id,)).fetchall()
        items = sorted((_contractor_out(r) for r in rows), key=lambda x: (x["display"] or "").lower())
        return {"contractors": items}
    finally:
        conn.close()


@router.get("/counterparty-search")
def search_counterparties(object_id: int, q: str = Query("", description="Часть названия или ИНН"),
                          limit: int = Query(30, ge=1, le=100), user: sqlite3.Row = Depends(get_current_user)):
    """Поиск по ОБЩЕМУ справочнику контрагентов для добавления подрядчика на объект: по ИНН или по названию (краткому и полному).
    Сначала точное совпадение ИНН, затем ИНН/название «с начала», затем «содержит». `added` — id подрядчика, если контрагент уже есть в
    списке объекта. `can_create` — можно ли пользователю завести нового контрагента (право на раздел «Справочник контрагентов»)."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        added = {r["counterparty_id"]: r["id"] for r in conn.execute(
            "SELECT id, counterparty_id FROM headcount_contractors WHERE object_id = ? AND counterparty_id IS NOT NULL", (object_id,))}
        needle, digits = _fold(q), "".join(str(q or "").split())
        scored = []
        for r in conn.execute("SELECT id, short_name, full_name, inn FROM counterparties"):
            name, full = _fold(r["short_name"]), _fold(r["full_name"])
            inn = "".join(str(r["inn"] or "").split())
            if not needle:
                rank = 4
            elif digits and inn and inn == digits:
                rank = 0
            elif (digits and inn.startswith(digits)) or name.startswith(needle) or full.startswith(needle):
                rank = 1
            elif needle in name or needle in full or (digits and digits in inn):
                rank = 2
            else:
                continue
            scored.append((rank, name, r["id"], r["short_name"], r["full_name"], inn))
        scored.sort(key=lambda t: (t[0], t[1], t[2]))
        items = [{"id": cid, "name": short, "full_name": full if _fold(full) != _fold(short) else None, "inn": inn or None,
                  "inn_status": inn_status(inn or None), "added": added.get(cid)} for _, _, cid, short, full, inn in scored[:limit]]
        return {"items": items, "total": len(scored), "can_create": has_feature(conn, user, "counterparties", "write")}
    finally:
        conn.close()


@router.post("/contractors")
def create_contractor(object_id: int, body: ContractorIn, user: sqlite3.Row = Depends(get_current_user)):
    """Добавить подрядчика на объект из общего справочника (`counterparty_id`) либо завести нового контрагента (`create_counterparty`)."""
    new_name, new_inn = _clean_name(body.name), clean_inn(body.inn)
    conn = get_connection()
    created_cp = None
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        if body.counterparty_id is None and not body.create_counterparty:
            raise HTTPException(status_code=400, detail="Выберите контрагента из общего справочника или заведите нового")
        if body.counterparty_id is None:
            _assert_can_create_counterparty(conn, user)
            if not new_name:
                raise HTTPException(status_code=400, detail="Укажите название нового контрагента")
        begin_write(conn)
        counterparty_id = body.counterparty_id
        if counterparty_id is None:
            if new_inn:
                same = conn.execute("SELECT id, short_name FROM counterparties WHERE REPLACE(TRIM(COALESCE(inn, '')), ' ', '') = ?", (new_inn,)).fetchall()
                if same:
                    raise HTTPException(status_code=409, detail=f"Контрагент с ИНН {new_inn} уже есть в справочнике: «{same[0]['short_name']}». Выберите его из списка")
            elif find_counterparty_by_name(conn, new_name) is not None or any(
                    _fold(new_name) in (_fold(r["short_name"]), _fold(r["full_name"])) for r in conn.execute("SELECT short_name, full_name FROM counterparties")):
                raise HTTPException(status_code=409, detail=f"Контрагент «{new_name}» уже есть в справочнике. Выберите его из списка")
            counterparty_id = created_cp = insert_counterparty(conn, new_name, new_inn)
        cp = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        if cp is None:
            raise HTTPException(status_code=404, detail="Контрагент не найден")
        name = _clean_name(cp["short_name"]) or _clean_name(cp["full_name"])
        inn = clean_inn(cp["inn"])
        clash = _pool_conflict(conn, object_id, counterparty_id, inn, name)
        if clash is not None and clash["counterparty_id"] == counterparty_id:
            raise HTTPException(status_code=409, detail=f"Подрядчик «{name}» уже есть в списке объекта")
        if clash is not None:
            # в пуле есть прежняя несвязанная запись с тем же ИНН / названием — это он и есть: связываем её, второй не заводим
            conn.execute("UPDATE headcount_contractors SET counterparty_id = ?, updated_at = datetime('now') WHERE id = ?", (counterparty_id, clash["id"]))
            contractor_id = clash["id"]
        else:
            try:
                cur = conn.execute("INSERT INTO headcount_contractors (object_id, counterparty_id, name_raw, inn_raw) VALUES (?, ?, ?, ?)",
                                   (object_id, counterparty_id, name, inn))
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="Подрядчик с таким ИНН уже есть в списке объекта")
            contractor_id = cur.lastrowid
        conn.commit()
        out = _contractor_out(_contractor_row(conn, object_id, contractor_id))
        cp_code = cp["code"]
    finally:
        conn.close()
    if created_cp is not None:
        activity.log("counterparty_create", user=user, entity_type="counterparty", entity_id=created_cp,
                     new_value=f"{out['name']} ({cp_code})", details={"источник": "численность: новый подрядчик объекта", "объект": object_id})
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, new_value=out["display"],
                 details={"действие": "добавлен", "подрядчик": out["id"], "контрагент": out["counterparty_id"],
                          "контрагент заведён": created_cp is not None})
    return out


@router.patch("/contractors/{contractor_id}")
def update_contractor(object_id: int, contractor_id: int, body: ContractorIn, user: sqlite3.Row = Depends(get_current_user)):
    """Заменить контрагента подрядчика (`counterparty_id`): записи численности остаются при подрядчике и переходят к новому контрагенту.
    Название и ИНН связанного подрядчика здесь НЕ правятся — они меняются в «Справочнике контрагентов». Для ещё несвязанной (старой) записи
    `name`/`inn` по-прежнему правят запасные значения, а связь подбирается по ИНН."""
    given = body.model_fields_set
    old_display = None
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = _contractor_row(conn, object_id, contractor_id)
        old_display = _contractor_out(row)["display"]
        raw = conn.execute("SELECT name_raw, inn_raw, counterparty_id FROM headcount_contractors WHERE id = ?", (contractor_id,)).fetchone()
        if "counterparty_id" in given:
            if body.counterparty_id is None:
                raise HTTPException(status_code=400, detail="Подрядчик объекта должен быть связан с контрагентом справочника — выберите другого контрагента")
            cp = conn.execute("SELECT id FROM counterparties WHERE id = ?", (body.counterparty_id,)).fetchone()
            if cp is None:
                raise HTTPException(status_code=404, detail="Контрагент не найден")
            clash = _pool_conflict(conn, object_id, body.counterparty_id, None, None, exclude_id=contractor_id)
            if clash is not None:
                raise HTTPException(status_code=409, detail="Этот контрагент уже есть в списке объекта")
            conn.execute("UPDATE headcount_contractors SET counterparty_id = ?, updated_at = datetime('now') WHERE id = ?", (body.counterparty_id, contractor_id))
        elif raw["counterparty_id"] is not None:
            raise HTTPException(status_code=400, detail="Название и ИНН подрядчика меняются в «Справочнике контрагентов» — здесь можно только заменить контрагента")
        else:
            name = _clean_name(body.name) if "name" in given else raw["name_raw"]
            inn = clean_inn(body.inn) if "inn" in given else raw["inn_raw"]
            if not name and not inn:
                raise HTTPException(status_code=400, detail="У подрядчика должно остаться название или ИНН")
            clash = _pool_conflict(conn, object_id, None, inn, name, exclude_id=contractor_id)
            if clash is not None:
                raise HTTPException(status_code=409, detail="Такой подрядчик уже есть в списке объекта")
            cp_id = find_counterparty_by_inn(conn, inn)
            conn.execute("UPDATE headcount_contractors SET counterparty_id = ?, name_raw = ?, inn_raw = ?, updated_at = datetime('now') WHERE id = ?",
                         (cp_id, name, inn, contractor_id))
        conn.commit()
        out = _contractor_out(_contractor_row(conn, object_id, contractor_id))
    finally:
        conn.close()
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, old_value=old_display, new_value=out["display"],
                 details={"действие": "изменён", "подрядчик": contractor_id, "контрагент": out["counterparty_id"]})
    return out


@router.delete("/contractors/{contractor_id}")
def delete_contractor(object_id: int, contractor_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = _contractor_row(conn, object_id, contractor_id)
        if row["records"]:
            raise HTTPException(
                status_code=409,
                detail=f"У подрядчика есть внесённая численность (записей: {row['records']}) — удалить его нельзя")
        if conn.execute("SELECT 1 FROM headcount_history WHERE contractor_id = ? LIMIT 1", (contractor_id,)).fetchone():
            # история переживает удаление записей, а при удалении подрядчика она ушла бы вместе с ним (каскад)
            raise HTTPException(status_code=409, detail="По подрядчику есть история численности — удалить его нельзя")
        conn.execute("DELETE FROM headcount_contractors WHERE id = ?", (contractor_id,))
        conn.commit()
        display = _contractor_out(row)["display"]
    finally:
        conn.close()
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, old_value=display,
                 details={"действие": "удалён", "подрядчик": contractor_id})
    return {"deleted": contractor_id}


# ------------------------------------------------------------------ кодификатор (чтение)

_LEAD_NUM = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?\s")


def codifier_sort_key(row) -> tuple:
    """Порядок кодификатора для показа: по номеру раздела и пункта из названия («1.», «16.1.1.»), а не по порядку строк файла и не по
    коду (код «320» — это раздел 23, номера и коды не совпадают). Без номера в названии — в конец, по коду."""
    m = _LEAD_NUM.match(row["name"] or "")
    return (0, tuple(int(x) for x in m.group(1).split(".")), row["code"]) if m else (1, (), row["code"])


def codifier_tree(rows: list) -> list:
    """Иерархия кодификатора ДО КОНЦА: уровень определяется номером в названии («12.2.3.3» — 4-й уровень; «12.» — 1-й). Родитель — позиция
    с самым длинным собственным префиксом номера из имеющихся (если промежуточной нет, позиция цепляется к ближайшей вышестоящей).
    Строка добавляет `parent_id`, `level` (1 — раздел), `has_children`; порядок — как у codifier_sort_key (родитель всегда перед потомками)."""
    ordered = sorted(rows, key=codifier_sort_key)
    paths, by_path = {}, {}
    for r in ordered:
        m = _LEAD_NUM.match(r["name"] or "")
        if m:
            path = tuple(int(x) for x in m.group(1).split("."))
            paths[r["id"]] = path
            by_path.setdefault(path, r["id"])
    level, out, parents = {}, [], set()
    for r in ordered:
        path, parent = paths.get(r["id"]), None
        if path:
            for n in range(len(path) - 1, 0, -1):
                if path[:n] in by_path and by_path[path[:n]] != r["id"]:
                    parent = by_path[path[:n]]
                    break
        level[r["id"]] = level[parent] + 1 if parent else 1
        if parent:
            parents.add(parent)
        out.append({**dict(r), "parent_id": parent, "level": level[r["id"]]})
    for r in out:
        r["has_children"] = r["id"] in parents
    return out


@router.get("/codifier")
def list_codifier(object_id: int, full: bool = False, user: sqlite3.Row = Depends(get_current_user)):
    """Виды работ кодификатора, по порядку номеров. Для выбора в форме (`full` не задан) — только действующие. `full=true` — справочник
    целиком для просмотра: добавляются выведенные из действия, дата вывода и число записей численности по каждому виду работ."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        if full:
            rows = conn.execute(
                "SELECT w.id, w.code, w.name, w.parent_name, w.section_name, w.unit, w.retired_at, "
                "(SELECT COUNT(*) FROM headcount_records r WHERE r.codifier_id = w.id) AS records FROM work_codifier w").fetchall()
        else:
            rows = conn.execute("SELECT id, code, name, parent_name, section_name, unit FROM work_codifier WHERE retired_at IS NULL").fetchall()
        return {"works": codifier_tree(rows)}
    finally:
        conn.close()


# ------------------------------------------------------------------ ввод и день

class RowIn(BaseModel):
    contractor_id: int
    codifier_id: int
    workers: int
    itr: Optional[int] = None   # не передан — у существующей записи остаётся прежним, у новой 0 (старый клиент про ИТР не знает)
    mech: Optional[int] = None   # «Механизаторы»: то же правило — None значит «не менять» (клиент без этого поля не затирает чужое)
    move_from: Optional[int] = None   # id внесённой записи, у которой в строке сменили подрядчика и/или вид работ (ключ записи): запись переезжает на новый ключ


class SaveIn(BaseModel):
    date: str
    rows: list[RowIn] = Field(min_length=1, max_length=MAX_ROWS_PER_SAVE)


def _user_name(row: sqlite3.Row, prefix: str) -> Optional[str]:
    last, first = row[f"{prefix}_last"], row[f"{prefix}_first"]
    return " ".join(p for p in (last, first) if p) or None


_RECORD_SELECT = (
    f"SELECT r.*, w.code AS work_code, w.name AS work_name, w.section_name, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn, "
    "ue.last_name AS ue_last, ue.first_name AS ue_first, uu.last_name AS uu_last, uu.first_name AS uu_first, "
    "(SELECT COUNT(*) FROM headcount_history h WHERE h.object_id = r.object_id AND h.work_date = r.work_date "
    " AND h.contractor_id = r.contractor_id AND h.codifier_id = r.codifier_id) AS changes "
    "FROM headcount_records r JOIN work_codifier w ON w.id = r.codifier_id "
    "JOIN headcount_contractors c ON c.id = r.contractor_id "
    "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
    "LEFT JOIN users ue ON ue.id = r.entered_by LEFT JOIN users uu ON uu.id = r.updated_by ")


def _record_out(row: sqlite3.Row) -> dict:
    work_date = date.fromisoformat(row["work_date"])
    entered = _db_time(row["entered_at"])
    overdue_minutes = None
    if row["late"] and entered:
        overdue_minutes = max(1, int((entered - deadline_for(work_date)).total_seconds() // 60))
    contractor = _contractor_out_from_parts(row["ctr_name"], row["ctr_inn"])
    return {
        "id": row["id"], "date": row["work_date"], "contractor_id": row["contractor_id"], "contractor": contractor["display"],
        "inn_status": contractor["inn_status"], "codifier_id": row["codifier_id"], "work_code": row["work_code"],
        "work_name": row["work_name"], "section": row["section_name"], "workers": row["workers"], "itr": row["itr"], "mech": row["mech"],
        "total": row["workers"] + row["itr"] + row["mech"], "late": bool(row["late"]), "overdue_minutes": overdue_minutes, "source": row["source"],
        "entered_at": row["entered_at"], "entered_by": _user_name(row, "ue"),
        "updated_at": row["updated_at"], "updated_by": _user_name(row, "uu"),
        "changes": max(0, row["changes"] - 1),   # первое внесение — тоже строка истории, «правок» меньше на одну
    }


def _contractor_out_from_parts(name, inn) -> dict:
    """Подпись и статус ИНН подрядчика по ЭФФЕКТИВНЫМ названию и ИНН (CTR_NAME / CTR_INN: из справочника контрагентов)."""
    return {"display": contractor_display(name, inn), "inn_status": inn_status(inn)}


def _day_payload(conn, object_id: int, work_date: date) -> dict:
    rows = conn.execute(
        _RECORD_SELECT + f"WHERE r.object_id = ? AND r.work_date = ? ORDER BY {CTR_NAME}, {CTR_INN}, w.code",
        (object_id, work_date.isoformat())).fetchall()
    items = [_record_out(r) for r in rows]
    due = deadline_for(work_date)
    last = conn.execute("SELECT MAX(work_date) FROM headcount_records WHERE object_id = ? AND work_date <= ?",
                        (object_id, now_msk().date().isoformat())).fetchone()[0]
    return {
        "date": work_date.isoformat(), "last_date": last, "deadline": due.isoformat(), "overdue_now": now_msk() > due,
        "rows": items, "total": sum(i["total"] for i in items),
        "total_workers": sum(i["workers"] for i in items), "total_itr": sum(i["itr"] for i in items),
        "total_mech": sum(i["mech"] for i in items),
    }


@router.get("/day")
def get_day(object_id: int, day: str = Query(..., alias="date", description="День, ГГГГ-ММ-ДД"),
            user: sqlite3.Row = Depends(get_current_user)):
    work_date = _parse_date(day)
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        return _day_payload(conn, object_id, work_date)
    finally:
        conn.close()


@router.put("/records")
def save_records(object_id: int, body: SaveIn, user: sqlite3.Row = Depends(get_current_user)):
    """Внести или заменить численность за день пакетом. Атомарно: либо сохраняются все строки, либо ни одной."""
    work_date = _parse_date(body.date)
    now = now_msk()
    if work_date > now.date():
        raise HTTPException(status_code=400, detail="Численность за будущую дату внести нельзя")
    seen = set()
    for row in body.rows:
        if (not 0 <= row.workers <= MAX_WORKERS or (row.itr is not None and not 0 <= row.itr <= MAX_WORKERS)
                or (row.mech is not None and not 0 <= row.mech <= MAX_WORKERS)):
            raise HTTPException(status_code=400, detail=f"Рабочие, ИТР и механизаторы — целые числа от 0 до {MAX_WORKERS}")
        key = (row.contractor_id, row.codifier_id)
        if key in seen:
            raise HTTPException(status_code=400, detail="Карточка содержит дубликат численности, сохранение невозможно")
        seen.add(key)
    iso = work_date.isoformat()
    late = 1 if is_late(work_date, now) else 0
    created = changed = unchanged = moved = 0
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        # Строки, у которых сменили подрядчика / вид работ (ключ записи): старые записи снимаются СРАЗУ ВСЕ (в истории — удаление на старом
        # ключе), потом строки вносятся как обычно, но с прежними «внесено когда/кем», просрочкой и источником. Так работает и обмен ключами
        # между двумя строками. Если на новом ключе уже есть другая запись — отказ, ничего не меняется.
        moved_meta = {}
        for row in body.rows:
            if row.move_from is None:
                continue
            rec = conn.execute("SELECT * FROM headcount_records WHERE id = ? AND object_id = ? AND work_date = ?", (row.move_from, object_id, iso)).fetchone()
            if rec is None:
                raise HTTPException(status_code=404, detail="Исправляемая запись не найдена (возможно, её уже удалили) — обновите страницу")
            if (rec["contractor_id"], rec["codifier_id"]) == (row.contractor_id, row.codifier_id):
                continue
            moved_meta[(row.contractor_id, row.codifier_id)] = rec
        stamp = _db_now()
        for rec in moved_meta.values():
            _history(conn, rec["id"], object_id, iso, rec["contractor_id"], rec["codifier_id"], rec["workers"], None, "form", stamp, user["id"],
                     old_itr=rec["itr"], new_itr=None, old_mech=rec["mech"], new_mech=None)
            conn.execute("DELETE FROM headcount_records WHERE id = ?", (rec["id"],))
        contractors = {r["id"] for r in conn.execute(
            "SELECT id FROM headcount_contractors WHERE object_id = ?", (object_id,))}
        works = {r["id"]: r["retired_at"] for r in conn.execute("SELECT id, retired_at FROM work_codifier")}
        for row in body.rows:
            if row.contractor_id not in contractors:
                raise HTTPException(status_code=400, detail="Подрядчик не относится к этому объекту")
            if row.codifier_id not in works:
                raise HTTPException(status_code=400, detail="Вид работ не найден в кодификаторе")
            current = conn.execute(
                "SELECT id, workers, itr, mech FROM headcount_records WHERE object_id = ? AND work_date = ? AND contractor_id = ? AND codifier_id = ?",
                (object_id, iso, row.contractor_id, row.codifier_id)).fetchone()
            meta = moved_meta.get((row.contractor_id, row.codifier_id))
            if meta is not None and current is not None:
                raise HTTPException(status_code=409, detail="После смены подрядчика или вида работ такая строка за день уже есть — выберите другую пару")
            new_itr = row.itr if row.itr is not None else (current["itr"] if current is not None else (meta["itr"] if meta is not None else 0))
            new_mech = row.mech if row.mech is not None else (current["mech"] if current is not None else (meta["mech"] if meta is not None else 0))
            if row.workers + new_itr + new_mech < 1:
                raise HTTPException(status_code=400, detail="Рабочие, ИТР и механизаторы вместе — не меньше 1: пустую строку не вносят (чтобы убрать запись, удалите её)")
            if current is None:
                if works[row.codifier_id]:
                    raise HTTPException(status_code=400, detail="Вид работ выведен из действия: новую численность по нему не вносят")
                cur = conn.execute(
                    "INSERT INTO headcount_records (object_id, work_date, contractor_id, codifier_id, workers, itr, mech, late, source, "
                    "entered_at, entered_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (object_id, iso, row.contractor_id, row.codifier_id, row.workers, new_itr, new_mech,
                     meta["late"] if meta is not None else late, "form" if meta is None else meta["source"],
                     meta["entered_at"] if meta is not None else stamp, meta["entered_by"] if meta is not None else user["id"], stamp, user["id"]))
                _history(conn, cur.lastrowid, object_id, iso, row.contractor_id, row.codifier_id, None, row.workers, "form", stamp, user["id"],
                         old_itr=None, new_itr=new_itr, old_mech=None, new_mech=new_mech)
                if meta is not None:
                    moved += 1
                else:
                    created += 1
            elif current["workers"] == row.workers and current["itr"] == new_itr and current["mech"] == new_mech:
                unchanged += 1
            else:
                conn.execute("UPDATE headcount_records SET workers = ?, itr = ?, mech = ?, updated_at = ?, updated_by = ?, source = 'form' WHERE id = ?",
                             (row.workers, new_itr, new_mech, stamp, user["id"], current["id"]))
                _history(conn, current["id"], object_id, iso, row.contractor_id, row.codifier_id, current["workers"], row.workers, "form", stamp,
                         user["id"], old_itr=current["itr"], new_itr=new_itr, old_mech=current["mech"], new_mech=new_mech)
                changed += 1
        conn.commit()
        payload = _day_payload(conn, object_id, work_date)
    finally:
        conn.close()
    if created or changed or moved:
        activity.log("headcount_set", user=user, entity_type="object", entity_id=object_id, new_value=iso,
                     details={"добавлено": created, "изменено": changed, "перенесено на другой ключ": moved, "без изменений": unchanged, "просрочено": bool(late)})
    return {"created": created, "changed": changed, "moved": moved, "unchanged": unchanged, "late": bool(late), **payload}


def _history(conn, record_id, object_id, iso, contractor_id, codifier_id, old, new, source, stamp, user_id, *, old_itr=None, new_itr=None,
             old_mech=None, new_mech=None) -> None:
    """Строка журнала: «Рабочие», «ИТР» и «Механизаторы» было/стало. NULL в паре — «было пусто» (создание) или «стало пусто» (удаление)."""
    conn.execute(
        "INSERT INTO headcount_history (record_id, object_id, work_date, contractor_id, codifier_id, old_workers, new_workers, "
        "old_itr, new_itr, old_mech, new_mech, source, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (record_id, object_id, iso, contractor_id, codifier_id, old, new, old_itr, new_itr, old_mech, new_mech, source, stamp, user_id))


def save_row_from_bot(object_id: int, work_date: date, contractor_id: int, codifier_id: int, workers: int, itr: int, mech: int = 0, *,
                      contact_name: str) -> dict:
    """Одна строка численности, пришедшая от бота eXpress (`app/express_dialog.py`). Те же правила, что у формы: ключ (объект, день,
    подрядчик, вид работ), замена числа с историей, просрочка по первому внесению, «вместе не меньше 1». Отличия: источник `bot`, а
    автора-пользователя нет (контакт бота не учётная запись) — в журнале действий он указан именем контакта. Ошибки правил — ValueError
    с русским текстом, который бот показывает человеку. Возвращает {"action": created|changed|unchanged, "late": …, "workers", "itr", "mech"}."""
    now = now_msk()
    if work_date > now.date():
        raise ValueError("Численность за будущую дату внести нельзя")
    if not (0 <= workers <= MAX_WORKERS and 0 <= itr <= MAX_WORKERS and 0 <= mech <= MAX_WORKERS):
        raise ValueError(f"Рабочие, ИТР и механизаторы — целые числа от 0 до {MAX_WORKERS}")
    if workers + itr + mech < 1:
        raise ValueError("Рабочие, ИТР и механизаторы вместе — не меньше 1: если людей не было, запись не вносят")
    iso = work_date.isoformat()
    conn = get_connection()
    try:
        begin_write(conn)
        if conn.execute("SELECT 1 FROM headcount_contractors WHERE id = ? AND object_id = ?", (contractor_id, object_id)).fetchone() is None:
            raise ValueError("Подрядчик не относится к этому объекту")
        work = conn.execute("SELECT retired_at FROM work_codifier WHERE id = ?", (codifier_id,)).fetchone()
        if work is None:
            raise ValueError("Вид работ не найден в кодификаторе")
        current = conn.execute(
            "SELECT id, workers, itr, mech FROM headcount_records WHERE object_id = ? AND work_date = ? AND contractor_id = ? AND codifier_id = ?",
            (object_id, iso, contractor_id, codifier_id)).fetchone()
        stamp = _db_now()
        late = 1 if is_late(work_date, now) else 0
        if current is None:
            if work["retired_at"]:
                raise ValueError("Вид работ выведен из действия: новую численность по нему не вносят")
            cur = conn.execute(
                "INSERT INTO headcount_records (object_id, work_date, contractor_id, codifier_id, workers, itr, mech, late, source, "
                "entered_at, entered_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bot', ?, NULL, ?, NULL)",
                (object_id, iso, contractor_id, codifier_id, workers, itr, mech, late, stamp, stamp))
            _history(conn, cur.lastrowid, object_id, iso, contractor_id, codifier_id, None, workers, "bot", stamp, None, old_itr=None, new_itr=itr,
                     old_mech=None, new_mech=mech)
            action = "created"
        elif current["workers"] == workers and current["itr"] == itr and current["mech"] == mech:
            action = "unchanged"
        else:
            conn.execute("UPDATE headcount_records SET workers = ?, itr = ?, mech = ?, updated_at = ?, updated_by = NULL, source = 'bot' WHERE id = ?",
                         (workers, itr, mech, stamp, current["id"]))
            _history(conn, current["id"], object_id, iso, contractor_id, codifier_id, current["workers"], workers, "bot", stamp, None,
                     old_itr=current["itr"], new_itr=itr, old_mech=current["mech"], new_mech=mech)
            action = "changed"
        conn.commit()
    finally:
        conn.close()
    if action != "unchanged":
        activity.log("headcount_set", user_name=contact_name, entity_type="object", entity_id=object_id, new_value=iso,
                     details={"источник": "бот eXpress", "добавлено": 1 if action == "created" else 0, "изменено": 1 if action == "changed" else 0,
                              "просрочено": bool(late), "рабочие": workers, "ИТР": itr, "механизаторы": mech})
    return {"action": action, "late": bool(late), "workers": workers, "itr": itr, "mech": mech}


@router.delete("/records/{record_id}")
def delete_record(object_id: int, record_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = conn.execute("SELECT * FROM headcount_records WHERE id = ? AND object_id = ?", (record_id, object_id)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Запись численности не найдена")
        _history(conn, record_id, object_id, row["work_date"], row["contractor_id"], row["codifier_id"], row["workers"], None, "form", _db_now(),
                 user["id"], old_itr=row["itr"], new_itr=None, old_mech=row["mech"], new_mech=None)
        conn.execute("DELETE FROM headcount_records WHERE id = ?", (record_id,))
        conn.commit()
    finally:
        conn.close()
    activity.log("headcount_delete", user=user, entity_type="object", entity_id=object_id, old_value=str(row["workers"] + row["itr"] + row["mech"]),
                 details={"рабочие": row["workers"], "ИТР": row["itr"], "механизаторы": row["mech"], "дата": row["work_date"], "подрядчик": row["contractor_id"], "вид работ": row["codifier_id"]})
    return {"deleted": record_id}


@router.get("/history")
def get_history(object_id: int, date_from: Optional[str] = None, date_to: Optional[str] = None,
                contractor_id: Optional[int] = None, codifier_id: Optional[int] = None,
                limit: int = Query(200, ge=1, le=1000), user: sqlite3.Row = Depends(get_current_user)):
    """Все значения по ключам, новые сверху: создание (было пусто), замены, удаления (стало пусто)."""
    where, params = ["h.object_id = ?"], [object_id]
    if date_from:
        where.append("h.work_date >= ?"); params.append(_parse_date(date_from, "Дата с").isoformat())
    if date_to:
        where.append("h.work_date <= ?"); params.append(_parse_date(date_to, "Дата по").isoformat())
    if contractor_id is not None:
        where.append("h.contractor_id = ?"); params.append(contractor_id)
    if codifier_id is not None:
        where.append("h.codifier_id = ?"); params.append(codifier_id)
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(
            f"SELECT h.*, w.code AS work_code, w.name AS work_name, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn, "
            "u.last_name AS u_last, u.first_name AS u_first "
            "FROM headcount_history h JOIN work_codifier w ON w.id = h.codifier_id "
            "JOIN headcount_contractors c ON c.id = h.contractor_id LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
            "LEFT JOIN users u ON u.id = h.changed_by WHERE " + " AND ".join(where) +
            " ORDER BY h.changed_at DESC, h.id DESC LIMIT ?", (*params, limit)).fetchall()
        return {"history": [{
            "id": r["id"], "date": r["work_date"], "contractor": _contractor_out_from_parts(r["ctr_name"], r["ctr_inn"])["display"],
            "work_code": r["work_code"], "work_name": r["work_name"], "old": r["old_workers"], "new": r["new_workers"],
            "old_itr": r["old_itr"], "new_itr": r["new_itr"], "old_mech": r["old_mech"], "new_mech": r["new_mech"],
            "old_total": None if r["old_workers"] is None else r["old_workers"] + (r["old_itr"] or 0) + (r["old_mech"] or 0),
            "new_total": None if r["new_workers"] is None else r["new_workers"] + (r["new_itr"] or 0) + (r["new_mech"] or 0),
            "source": r["source"], "changed_at": r["changed_at"], "changed_by": _user_name(r, "u"),
        } for r in rows]}
    finally:
        conn.close()


# ------------------------------------------------------------------ отчёт по факту

# уровень → (выражение ключа, выражение подписи). Подрядчики разных объектов с одним ИНН сводятся в одну строку.
# что суммировать в отчёте: «Итого» — рабочие + ИТР + механизаторы (по умолчанию), либо одно из слагаемых
STAFF_EXPR = {"total": "(r.workers + r.itr + r.mech)", "workers": "r.workers", "itr": "r.itr", "mech": "r.mech"}

_LEVELS = {
    "smu": ("COALESCE(CAST(o.smu_id AS TEXT), '')", "COALESCE(s.name, 'Без подразделения')"),
    "object": ("CAST(o.id AS TEXT)", "o.name"),
    "section": ("COALESCE(w.section_name, '')", "COALESCE(w.section_name, 'Без раздела')"),
    "work": ("CAST(w.id AS TEXT)", "w.name"),
    # Подрядчики разных объектов сводятся в одну строку по КОНТРАГЕНТУ справочника; несвязанные (старые) записи — по ИНН / названию.
    "contractor": (f"CASE WHEN cp.id IS NOT NULL THEN 'cp:' || cp.id ELSE COALESCE(c.inn_raw, 'name:' || c.name_raw) END",
                   f"COALESCE({CTR_NAME}, '') || CASE WHEN {CTR_INN} IS NOT NULL AND COALESCE({CTR_NAME}, '') <> 'ИНН ' || {CTR_INN} "
                   f"THEN ' (ИНН ' || {CTR_INN} || ')' ELSE '' END"),
}


def _readable_object_ids(conn, user, wanted: Optional[list]) -> list:
    """Объекты, по которым у человека есть чтение численности (из запрошенных, если заданы)."""
    allowed = accessible_object_ids(conn, user)
    if wanted is None:
        ids = [r["id"] for r in conn.execute("SELECT id FROM objects")] if allowed is None else sorted(allowed)
    else:
        ids = [i for i in wanted if allowed is None or i in allowed]
    return [i for i in ids if has_feature(conn, user, FEATURE_KEY, "read", i)]


@global_router.get("/report")
def report(levels: str = Query("object", description="Уровни через запятую из: smu, object, section, work, contractor"),
           as_of: Optional[str] = Query(None, description="Опорный день (по умолчанию — последний день с данными в выборке)"),
           date_from: Optional[str] = None, date_to: Optional[str] = None,
           object_ids: Optional[str] = Query(None, description="Объекты через запятую; по умолчанию все доступные"),
           smu_id: Optional[int] = None, section: Optional[str] = None, work_code: Optional[str] = Query(
               None, description="Код кодификатора или его начало (130 — весь раздел)"),
           contractor_inn: Optional[str] = None,
           staff: str = Query("total", description="Что считать: total — итого (рабочие + ИТР + механизаторы), workers — рабочие, itr — ИТР, mech — механизаторы"),
           user: sqlite3.Row = Depends(get_current_user)):
    """Факт численности: за опорный день, среднее за неделю (7 дней по опорный включительно), среднее за месяц опорного дня и, если заданы
    `date_from`/`date_to`, сумма человек-дней и среднее за период. Плана и отклонений нет (первый этап, решение 2026-10-09).
    Показатели складываются вверх по иерархии — см. докстроку модуля."""
    if staff not in STAFF_EXPR:
        raise HTTPException(status_code=400, detail="staff: total, workers, itr или mech")
    amount = STAFF_EXPR[staff]
    level_list = [x.strip() for x in levels.split(",") if x.strip()]
    if not level_list or any(x not in _LEVELS for x in level_list) or len(set(level_list)) != len(level_list):
        raise HTTPException(status_code=400, detail="levels: список без повторов из smu, object, section, work, contractor")
    ref = _parse_date(as_of, "Опорный день") if as_of else None   # не задан — последний день с данными в выборке (ниже)
    p_from = _parse_date(date_from, "Дата с") if date_from else None
    p_to = _parse_date(date_to, "Дата по") if date_to else None
    wanted = None
    if object_ids:
        try:
            wanted = [int(x) for x in object_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="object_ids: список чисел через запятую")
    conn = get_connection()
    try:
        ids = _readable_object_ids(conn, user, wanted)
        if not ids:
            return _empty_report(level_list, ref or now_msk().date() - timedelta(days=1))
        where, params = [f"r.object_id IN ({','.join('?' * len(ids))})"], list(ids)
        if smu_id is not None:
            where.append("o.smu_id = ?"); params.append(smu_id)
        if section:
            where.append("w.section_name = ?"); params.append(section)
        if work_code:
            where.append("w.code LIKE ? ESCAPE '\\'")
            params.append(work_code.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if contractor_inn:
            where.append(f"{CTR_INN} = ?"); params.append(clean_inn(contractor_inn))
        join = ("FROM headcount_records r JOIN objects o ON o.id = r.object_id LEFT JOIN smu_catalog s ON s.id = o.smu_id "
                "JOIN work_codifier w ON w.id = r.codifier_id JOIN headcount_contractors c ON c.id = r.contractor_id "
                "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE " + " AND ".join(where))

        if ref is None:
            last = conn.execute("SELECT MAX(r.work_date) " + join + " AND r.work_date <= ?", (*params, now_msk().date().isoformat())).fetchone()[0]
            ref = date.fromisoformat(last) if last else now_msk().date() - timedelta(days=1)
        week_from, month_from = ref - timedelta(days=6), ref.replace(day=1)

        def days(start: date, end: date) -> int:
            return conn.execute("SELECT COUNT(DISTINCT r.work_date) " + join + " AND r.work_date BETWEEN ? AND ?",
                                (*params, start.isoformat(), end.isoformat())).fetchone()[0]

        week_days, month_days = days(week_from, ref), days(month_from, ref)
        period_days = days(p_from, p_to) if p_from and p_to else 0
        keys = ", ".join(f"{_LEVELS[x][0]} AS k_{x}, {_LEVELS[x][1]} AS l_{x}" for x in level_list)
        group = ", ".join(f"k_{x}" for x in level_list)
        extra = ""
        if p_from and p_to:
            extra = f", COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN {amount} END), 0) AS period_sum"
        sql = (f"SELECT {keys}, COALESCE(SUM(CASE WHEN r.work_date = ? THEN {amount} END), 0) AS fact_day, "
               f"COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN {amount} END), 0) AS week_sum, "
               f"COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN {amount} END), 0) AS month_sum"
               f"{extra} {join} GROUP BY {group} ORDER BY {', '.join(f'l_{x}' for x in level_list)}")
        sql_params = [ref.isoformat(), week_from.isoformat(), ref.isoformat(), month_from.isoformat(), ref.isoformat()]
        if extra:
            sql_params += [p_from.isoformat(), p_to.isoformat()]
        rows = conn.execute(sql, (*sql_params, *params)).fetchall()

        out_rows = []
        for r in rows:
            if not (r["fact_day"] or r["week_sum"] or r["month_sum"] or (extra and r["period_sum"])):
                continue   # строка есть в группировке, а в окнах показателей пуста — не показываем
            item = {x: {"key": r[f"k_{x}"], "label": r[f"l_{x}"]} for x in level_list}
            item["fact_day"] = r["fact_day"]
            item["week_avg"] = round(r["week_sum"] / week_days, 3) if week_days else 0
            item["month_avg"] = round(r["month_sum"] / month_days, 3) if month_days else 0
            if extra:
                item["period_sum"] = r["period_sum"]
                item["period_avg"] = round(r["period_sum"] / period_days, 3) if period_days else 0
            out_rows.append(item)
        # итог — из СУММ, а не из округлённых строк: иначе он расходился бы с суммой показанных значений на десятые
        week_sum, month_sum = sum(r["week_sum"] for r in rows), sum(r["month_sum"] for r in rows)
        total = {"fact_day": sum(i["fact_day"] for i in out_rows),
                 "week_avg": round(week_sum / week_days, 3) if week_days else 0,
                 "month_avg": round(month_sum / month_days, 3) if month_days else 0}
        if extra:
            total["period_sum"] = sum(i["period_sum"] for i in out_rows)
            total["period_avg"] = round(total["period_sum"] / period_days, 3) if period_days else 0

        year_from = (p_from or ref.replace(month=1, day=1)).replace(day=1)
        month_rows = conn.execute(
            f"SELECT substr(r.work_date, 1, 7) AS m, SUM({amount}) AS s, COUNT(DISTINCT r.work_date) AS d " + join +
            " AND r.work_date >= ? AND r.work_date <= ? GROUP BY m ORDER BY m",
            (*params, year_from.isoformat(), (p_to or ref).isoformat())).fetchall()
        months = [{"month": m["m"], "avg": round(m["s"] / m["d"], 3) if m["d"] else 0, "days": m["d"]} for m in month_rows]
        return {"staff": staff, "levels": level_list, "as_of": ref.isoformat(), "week_from": week_from.isoformat(), "month_from": month_from.isoformat(),
                "week_days": week_days, "month_days": month_days, "period_days": period_days, "rows": out_rows,
                "total": total, "months": months,
                "objects": conn.execute("SELECT COUNT(DISTINCT r.object_id) " + join + " AND r.work_date <= ?", (*params, ref.isoformat())).fetchone()[0]}
    finally:
        conn.close()


LEVEL_TITLES = {"smu": "Подразделение", "object": "Объект", "section": "Раздел", "work": "Вид работ", "contractor": "Подрядчик"}


@global_router.get("/report.xlsx")
def report_xlsx(levels: str = Query("object"), as_of: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                object_ids: Optional[str] = None, smu_id: Optional[int] = None, section: Optional[str] = None, work_code: Optional[str] = None,
                contractor_inn: Optional[str] = None, staff: str = Query("total"), user: sqlite3.Row = Depends(get_current_user)):
    """Тот же отчёт, что `/headcount/report`, одним листом Excel: по строке на сочетание выбранных уровней, итог внизу. Права те же."""
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    d = report(levels=levels, as_of=as_of, date_from=date_from, date_to=date_to, object_ids=object_ids, smu_id=smu_id, section=section,
               work_code=work_code, contractor_inn=contractor_inn, staff=staff, user=user)
    day = date.fromisoformat(d["as_of"]).strftime("%d.%m.%Y")
    staff_note = "" if staff == "total" else f" ({STAFF_TITLES[staff]})"
    has_period = d["total"].get("period_sum") is not None
    heads = [LEVEL_TITLES[x] for x in d["levels"]] + [f"Факт на {day}{staff_note}", "Среднее за неделю", "Среднее за месяц"]
    if has_period:
        heads += ["Человек-дней за период", "Среднее за период"]
    wb = Workbook()
    ws = wb.active
    ws.title = "Численность"
    ws.append(heads)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="top")

    def numbers(src):
        out = [src["fact_day"], src["week_avg"], src["month_avg"]]
        return out + ([src["period_sum"], src["period_avg"]] if has_period else [])

    for row in d["rows"]:
        ws.append([row[x]["label"] for x in d["levels"]] + numbers(row))
    ws.append(["Итого"] + [None] * (len(d["levels"]) - 1) + numbers(d["total"]))
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    for i, title in enumerate(heads, start=1):
        ws.column_dimensions[get_column_letter(i)].width = 46 if i <= len(d["levels"]) else 18
    ws.freeze_panes = "A2"
    n = len(d["levels"])
    avg_cols = [n + 2, n + 3] + ([n + 5] if has_period else [])   # колонки «среднее»: один знак после запятой, как в интерфейсе
    for col in avg_cols:
        for row in ws.iter_rows(min_row=2, min_col=col, max_col=col):
            row[0].number_format = "0.0"
    buf = BytesIO()
    wb.save(buf)
    name = f"Численность{'' if staff == 'total' else '_' + STAFF_TITLES[staff]}_на_{day}.xlsx"
    from urllib.parse import quote
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename=\"headcount.xlsx\"; filename*=UTF-8''{quote(name)}"})


# ------------------------------------------------------------------ просмотр всех данных: записи и журнал изменений

EXPORT_ROW_LIMIT = 300_000   # предел выгрузки в Excel (лист Excel вмещает ~1 млн строк, но файл такого размера уже не открыть)
SOURCE_TITLES = {"form": "форма", "import": "загрузка из SharePoint", "bot": "бот"}


def _data_filters(conn, user, *, alias: str, object_ids: Optional[str], date_from: Optional[str], date_to: Optional[str],
                  contractor_q: Optional[str], work_code: Optional[str], source: Optional[str], late: bool = False):
    """Общие отбор и права для просмотра записей и журнала. Возвращает (WHERE-условия, параметры) или None, если читать нечего.
    Названия подрядчиков сравниваются В PYTHON: SQLite без ICU не приводит кириллицу к одному регистру (Docs/DECISIONS.md)."""
    wanted = None
    if object_ids:
        try:
            wanted = [int(x) for x in object_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="object_ids: список чисел через запятую")
    ids = _readable_object_ids(conn, user, wanted)
    if not ids:
        return None
    where, params = [f"{alias}.object_id IN ({','.join('?' * len(ids))})"], list(ids)
    if date_from:
        where.append(f"{alias}.work_date >= ?"); params.append(_parse_date(date_from, "Дата с").isoformat())
    if date_to:
        where.append(f"{alias}.work_date <= ?"); params.append(_parse_date(date_to, "Дата по").isoformat())
    if work_code:
        where.append(f"{alias}.codifier_id IN (SELECT id FROM work_codifier WHERE code LIKE ? ESCAPE '\\')")
        params.append(work_code.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    if source:
        if source not in SOURCES:
            raise HTTPException(status_code=400, detail="source: form, import или bot")
        where.append(f"{alias}.source = ?"); params.append(source)
    if late:
        where.append(f"{alias}.late = 1")
    if contractor_q and contractor_q.strip():
        needle = " ".join(contractor_q.split()).lower()
        rows = conn.execute(
            f"SELECT c.id, c.name_raw, c.inn_raw, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn FROM headcount_contractors c "
            f"LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE c.object_id IN ({','.join('?' * len(ids))})", ids).fetchall()
        match = [r["id"] for r in rows if needle in " ".join(f"{r['ctr_name'] or ''} {r['ctr_inn'] or ''} {r['name_raw'] or ''} {r['inn_raw'] or ''}".split()).lower()]
        if not match:
            return None
        where.append(f"{alias}.contractor_id IN ({','.join('?' * len(match))})"); params.extend(match)
    return where, params


_DATA_FROM = ("FROM headcount_records r JOIN objects o ON o.id = r.object_id JOIN work_codifier w ON w.id = r.codifier_id "
              "JOIN headcount_contractors c ON c.id = r.contractor_id LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
              "LEFT JOIN users ue ON ue.id = r.entered_by LEFT JOIN users uu ON uu.id = r.updated_by ")
_DATA_COLS = ("SELECT r.id, r.object_id, o.name AS object_name, r.work_date, r.workers, r.itr, r.mech, r.late, r.source, r.entered_at, r.updated_at, "
              f"w.code AS work_code, w.name AS work_name, w.section_name, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn, "
              "ue.last_name AS ue_last, ue.first_name AS ue_first, uu.last_name AS uu_last, uu.first_name AS uu_first, "
              "(SELECT COUNT(*) FROM headcount_history h WHERE h.object_id = r.object_id AND h.work_date = r.work_date "
              " AND h.contractor_id = r.contractor_id AND h.codifier_id = r.codifier_id) AS hist ")
_DATA_ORDER = f"ORDER BY r.work_date DESC, o.name, {CTR_NAME}, {CTR_INN}, w.code "


def _data_item(r) -> dict:
    parts = _contractor_out_from_parts(r["ctr_name"], r["ctr_inn"])
    overdue = None
    if r["late"]:
        entered = _db_time(r["entered_at"])
        if entered:
            overdue = max(1, int((entered - deadline_for(date.fromisoformat(r["work_date"]))).total_seconds() // 60))
    return {
        "id": r["id"], "object_id": r["object_id"], "object": r["object_name"], "date": r["work_date"], "contractor": parts["display"],
        "inn": r["ctr_inn"], "inn_status": parts["inn_status"], "section": r["section_name"], "work_code": r["work_code"],
        "work_name": r["work_name"], "workers": r["workers"], "itr": r["itr"], "mech": r["mech"],
        "total": r["workers"] + r["itr"] + r["mech"],
        "late": bool(r["late"]), "overdue_minutes": overdue,
        "source": r["source"], "entered_at": r["entered_at"], "entered_by": _user_name(r, "ue"), "updated_at": r["updated_at"],
        "updated_by": _user_name(r, "uu"), "changes": max(0, r["hist"] - 1),
    }


@global_router.get("/facets")
def facets(user: sqlite3.Row = Depends(get_current_user)):
    """Объекты, по которым в системе ЕСТЬ численность (и на чтение которых у человека есть право): для выбора в отчёте и в «Все данные».
    Список собран из фактических записей, а не из справочника объектов, — пустых объектов в нём нет."""
    conn = get_connection()
    try:
        ids = _readable_object_ids(conn, user, None)
        if not ids:
            return {"objects": []}
        rows = conn.execute(
            "SELECT r.object_id AS id, o.name, COUNT(*) AS records, MIN(r.work_date) AS date_from, MAX(r.work_date) AS date_to "
            f"FROM headcount_records r JOIN objects o ON o.id = r.object_id WHERE r.object_id IN ({','.join('?' * len(ids))}) "
            "GROUP BY r.object_id ORDER BY o.name", ids).fetchall()
        return {"objects": sorted((dict(r) for r in rows), key=lambda x: (x["name"] or "").lower())}
    finally:
        conn.close()


def _all_readable_total(conn, user) -> int:
    """Сколько записей численности видно человеку по ВСЕМ доступным объектам (подсказка, когда по выбранному объекту пусто)."""
    ids = _readable_object_ids(conn, user, None)
    if not ids:
        return 0
    return conn.execute(f"SELECT COUNT(*) FROM headcount_records WHERE object_id IN ({','.join('?' * len(ids))})", ids).fetchone()[0]


@global_router.get("/records")
def list_records(object_ids: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                 contractor_q: Optional[str] = None, work_code: Optional[str] = None, source: Optional[str] = None,
                 late: bool = False, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                 user: sqlite3.Row = Depends(get_current_user)):
    """ВСЕ внесённые и загруженные записи численности, новые сверху, с отбором и постраничным показом. Видны только объекты, на которые
    есть право чтения; `total` и `sum_workers` — по всему отбору, а не по странице."""
    conn = get_connection()
    try:
        flt = _data_filters(conn, user, alias="r", object_ids=object_ids, date_from=date_from, date_to=date_to,
                            contractor_q=contractor_q, work_code=work_code, source=source, late=late)
        if flt is None:
            return {"items": [], "total": 0, "sum_workers": 0, "sum_itr": 0, "sum_mech": 0, "sum_total": 0, "offset": offset, "limit": limit, "all_total": _all_readable_total(conn, user)}
        where, params = " AND ".join(flt[0]), flt[1]
        total, sum_w, sum_i, sum_m = conn.execute(
            f"SELECT COUNT(*), COALESCE(SUM(r.workers), 0), COALESCE(SUM(r.itr), 0), COALESCE(SUM(r.mech), 0) {_DATA_FROM} WHERE {where}", params).fetchone()
        rows = conn.execute(f"{_DATA_COLS}{_DATA_FROM} WHERE {where} {_DATA_ORDER} LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
        return {"items": [_data_item(r) for r in rows], "total": total, "sum_workers": sum_w, "sum_itr": sum_i, "sum_mech": sum_m, "sum_total": sum_w + sum_i + sum_m,
                "offset": offset, "limit": limit,
                "all_total": _all_readable_total(conn, user) if not total else total}
    finally:
        conn.close()


@global_router.get("/history-log")
def list_history_log(object_ids: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                     contractor_q: Optional[str] = None, work_code: Optional[str] = None, source: Optional[str] = None,
                     limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0), user: sqlite3.Row = Depends(get_current_user)):
    """Журнал ВСЕХ изменений численности (создания, замены, удаления), новые сверху. Отбор по дню численности (`work_date`)."""
    conn = get_connection()
    try:
        flt = _data_filters(conn, user, alias="h", object_ids=object_ids, date_from=date_from, date_to=date_to,
                            contractor_q=contractor_q, work_code=work_code, source=source)
        if flt is None:
            return {"items": [], "total": 0, "offset": offset, "limit": limit}
        where, params = " AND ".join(flt[0]), flt[1]
        frm = ("FROM headcount_history h JOIN objects o ON o.id = h.object_id JOIN work_codifier w ON w.id = h.codifier_id "
               "JOIN headcount_contractors c ON c.id = h.contractor_id LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
               "LEFT JOIN users u ON u.id = h.changed_by ")
        total = conn.execute(f"SELECT COUNT(*) {frm} WHERE {where}", params).fetchone()[0]
        rows = conn.execute(
            "SELECT h.id, h.object_id, o.name AS object_name, h.work_date, h.old_workers, h.new_workers, h.old_itr, h.new_itr, h.old_mech, h.new_mech, "
            f"h.source, h.changed_at, w.code AS work_code, w.name AS work_name, {CTR_NAME} AS ctr_name, {CTR_INN} AS ctr_inn, "
            f"u.last_name AS u_last, u.first_name AS u_first {frm} WHERE {where} ORDER BY h.changed_at DESC, h.id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset)).fetchall()
        return {"items": [{
            "id": r["id"], "object_id": r["object_id"], "object": r["object_name"], "date": r["work_date"],
            "contractor": _contractor_out_from_parts(r["ctr_name"], r["ctr_inn"])["display"],
            "work_code": r["work_code"], "work_name": r["work_name"], "old": r["old_workers"], "new": r["new_workers"],
            "old_itr": r["old_itr"], "new_itr": r["new_itr"], "old_mech": r["old_mech"], "new_mech": r["new_mech"],
            "source": r["source"], "changed_at": r["changed_at"], "changed_by": _user_name(r, "u")} for r in rows],
            "total": total, "offset": offset, "limit": limit}
    finally:
        conn.close()


def _xlsx_response(headers: list, rows, widths: list, name: str) -> Response:
    from io import BytesIO
    from urllib.parse import quote
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = "Данные"
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for row in rows:
        ws.append(row)
    for i, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    buf = BytesIO()
    wb.save(buf)
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename=\"headcount.xlsx\"; filename*=UTF-8''{quote(name)}"})


def _moment_xlsx(value: Optional[str]):
    d = _db_time(value)
    return d.replace(tzinfo=None) if d else None


@global_router.get("/records.xlsx")
def records_xlsx(object_ids: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                 contractor_q: Optional[str] = None, work_code: Optional[str] = None, source: Optional[str] = None,
                 late: bool = False, user: sqlite3.Row = Depends(get_current_user)):
    """Те же записи, что `/headcount/records`, в Excel (весь отбор, не страница)."""
    conn = get_connection()
    try:
        flt = _data_filters(conn, user, alias="r", object_ids=object_ids, date_from=date_from, date_to=date_to,
                            contractor_q=contractor_q, work_code=work_code, source=source, late=late)
        rows = [] if flt is None else conn.execute(
            f"{_DATA_COLS}{_DATA_FROM} WHERE {' AND '.join(flt[0])} {_DATA_ORDER} LIMIT {EXPORT_ROW_LIMIT}", flt[1]).fetchall()
    finally:
        conn.close()
    items = [_data_item(r) for r in rows]
    heads = ["Дата", "Объект", "Подрядчик", "ИНН", "Раздел", "Код вида работ", "Вид работ", "Рабочие", "ИТР", "Механизаторы", "Итого", "Просрочено",
             "Опоздание, мин", "Источник", "Внесено", "Кем внесено", "Изменено", "Кем изменено", "Правок"]
    body = [[date.fromisoformat(i["date"]), i["object"], i["contractor"], i["inn"], i["section"], i["work_code"], i["work_name"], i["workers"],
             i["itr"], i["mech"], i["total"], "да" if i["late"] else "", i["overdue_minutes"], SOURCE_TITLES.get(i["source"], i["source"]), _moment_xlsx(i["entered_at"]),
             i["entered_by"], _moment_xlsx(i["updated_at"]), i["updated_by"], i["changes"]] for i in items]
    resp = _xlsx_response(heads, body, [12, 34, 38, 14, 34, 14, 50, 10, 8, 13, 10, 11, 12, 22, 17, 24, 17, 24, 8], "Численность_записи.xlsx")
    return resp


@global_router.get("/history-log.xlsx")
def history_log_xlsx(object_ids: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                     contractor_q: Optional[str] = None, work_code: Optional[str] = None, source: Optional[str] = None,
                     user: sqlite3.Row = Depends(get_current_user)):
    data = list_history_log(object_ids=object_ids, date_from=date_from, date_to=date_to, contractor_q=contractor_q, work_code=work_code,
                            source=source, limit=500, offset=0, user=user)
    items = list(data["items"])
    offset = 500
    while len(items) < min(data["total"], EXPORT_ROW_LIMIT):
        more = list_history_log(object_ids=object_ids, date_from=date_from, date_to=date_to, contractor_q=contractor_q, work_code=work_code,
                                source=source, limit=500, offset=offset, user=user)["items"]
        if not more:
            break
        items.extend(more)
        offset += 500
    heads = ["Когда изменено", "Кто", "День численности", "Объект", "Подрядчик", "Код вида работ", "Вид работ", "Рабочие было", "Рабочие стало",
             "ИТР было", "ИТР стало", "Механизаторы было", "Механизаторы стало", "Источник"]
    body = [[_moment_xlsx(i["changed_at"]), i["changed_by"], date.fromisoformat(i["date"]), i["object"], i["contractor"], i["work_code"], i["work_name"],
             i["old"], i["new"] if i["new"] is not None else "удалено", i["old_itr"], i["new_itr"] if i["new_itr"] is not None else ("удалено" if i["new"] is None else None),
             i["old_mech"], i["new_mech"] if i["new_mech"] is not None else ("удалено" if i["new"] is None else None),
             SOURCE_TITLES.get(i["source"], i["source"])] for i in items]
    return _xlsx_response(heads, body, [17, 24, 14, 34, 38, 14, 50, 12, 13, 10, 11, 14, 15, 22], "Численность_журнал_изменений.xlsx")


def _empty_report(level_list: list, ref: date) -> dict:
    return {"staff": "total", "levels": level_list, "as_of": ref.isoformat(), "rows": [], "total": {"fact_day": 0, "week_avg": 0, "month_avg": 0},
            "months": [], "objects": 0}

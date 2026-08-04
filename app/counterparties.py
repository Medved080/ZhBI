"""
Контрагенты -> Договоры -> Спецификации — юридическая иерархия, к которой
привязывается Контракт (app/contracts.py, поле specification_id). Заменяет
старое свободнотекстовое contracts.supplier (см. Docs/backlog.md,
"Контрактация 2.0").

Плюс справочник mark_type_prefixes — эвристика "префикс марки -> тип
элемента", донастраиваемая администратором, используется импортом файла
контрактации (app/contracting_import.py) для позиций, чья марка ещё не
встречается ни у одного загруженного элемента.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.access import assert_object_access, require_contracting, require_system_admin
from app.auth import get_current_user
from app import activity
from app.db import get_connection

router = APIRouter(tags=["counterparties"])


class CounterpartyIn(BaseModel):
    full_name: str
    short_name: str
    inn: Optional[str] = None
    kpp: Optional[str] = None
    ogrn: Optional[str] = None
    legal_address: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    code: Optional[str] = None


class CounterpartyOut(CounterpartyIn):
    id: int


class AgreementIn(BaseModel):
    counterparty_id: int
    number: str
    agreement_date: Optional[str] = None
    # Объект, на который заключён договор (этап A). Необязателен в модели, но
    # ОБЯЗАТЕЛЕН при заведении нового (см. create_agreement): у накопленных
    # договоров он NULL, и правка такого договора без указания объекта не
    # должна падать валидацией — иначе проставить объект было бы нечем.
    object_id: Optional[int] = None


class AgreementOut(AgreementIn):
    id: int


class SpecificationIn(BaseModel):
    agreement_id: int
    number: str
    specification_date: Optional[str] = None


class SpecificationOut(SpecificationIn):
    id: int


class MarkTypePrefixIn(BaseModel):
    prefix: str
    element_type: str


# --- find-or-create — переиспользуются и роутером ниже, и импортёром
# файла контрактации (app/contracting_import.py). ---


def _generate_counterparty_code(conn, short_name: str) -> str:
    """Короткий код для допстроки подписи на схеме — по умолчанию первое
    слово краткого наименования, до 6 символов, верхний регистр; при
    коллизии добавляется числовой суффикс. Администратор может поменять
    вручную после создания (справочник Контрагенты)."""
    base = (short_name.split()[0] if short_name.split() else short_name).upper()[:6]
    base = base or "К"
    candidate = base
    n = 2
    existing = {r["code"] for r in conn.execute("SELECT code FROM counterparties WHERE code IS NOT NULL")}
    while candidate in existing:
        candidate = f"{base}{n}"
        n += 1
    return candidate


def find_or_create_counterparty(
    conn,
    full_name: str,
    short_name: str,
    inn: Optional[str] = None,
    kpp: Optional[str] = None,
    ogrn: Optional[str] = None,
    legal_address: Optional[str] = None,
    contact_person: Optional[str] = None,
    contact_phone: Optional[str] = None,
    code: Optional[str] = None,
) -> int:
    """Ключ поиска: по ИНН, если указан (устойчивее к разночтениям в
    названии), иначе — точное совпадение short_name."""
    if inn:
        row = conn.execute("SELECT id FROM counterparties WHERE inn = ?", (inn,)).fetchone()
        if row:
            return row["id"]
    else:
        row = conn.execute(
            "SELECT id FROM counterparties WHERE short_name = ?", (short_name,)
        ).fetchone()
        if row:
            return row["id"]

    resolved_code = code or _generate_counterparty_code(conn, short_name)
    conn.execute(
        "INSERT INTO counterparties "
        "(full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, code) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, resolved_code),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def find_or_create_agreement(conn, counterparty_id: int, number: str, agreement_date: Optional[str] = None) -> int:
    row = conn.execute(
        "SELECT id FROM agreements WHERE counterparty_id = ? AND number = ?", (counterparty_id, number)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT INTO agreements (counterparty_id, number, agreement_date) VALUES (?, ?, ?)",
        (counterparty_id, number, agreement_date),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def find_or_create_specification(conn, agreement_id: int, number: str, specification_date: Optional[str] = None) -> int:
    row = conn.execute(
        "SELECT id FROM specifications WHERE agreement_id = ? AND number = ?", (agreement_id, number)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT INTO specifications (agreement_id, number, specification_date) VALUES (?, ?, ?)",
        (agreement_id, number, specification_date),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


# --- Контрагенты ---


@router.get("/counterparties", response_model=list[CounterpartyOut])
def list_counterparties(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM counterparties ORDER BY short_name").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/counterparties/full")
def list_counterparties_full(user: sqlite3.Row = Depends(get_current_user)):
    """Вложенное дерево Контрагент -> Договоры -> Спецификации одним
    запросом — для каскадных селектов в форме контракта."""
    conn = get_connection()
    try:
        counterparties = [dict(r) for r in conn.execute("SELECT * FROM counterparties ORDER BY short_name")]
        # Тот же отбор по доступным объектам, что и у /agreements рядом
        # (аудит безопасности 2026-08-03 закрыл его там, но не здесь): это
        # дерево отдаёт РОВНО ТЕ ЖЕ договоры и спецификации, только все
        # сразу и без параметра — то есть было более коротким путём к тому,
        # что уже признали закрытым. Спецификации сужаются вслед за
        # договорами: своего объекта у них нет, он выводится по цепочке.
        доступ, доступ_params = _accessible_agreements_clause(conn, user)
        agreements = [dict(r) for r in conn.execute(
            f"SELECT * FROM agreements WHERE {доступ} ORDER BY number", доступ_params)]
        if agreements:
            marks = ",".join("?" * len(agreements))
            specifications = [dict(r) for r in conn.execute(
                f"SELECT * FROM specifications WHERE agreement_id IN ({marks}) ORDER BY number",
                [a["id"] for a in agreements])]
        else:
            specifications = []

        specs_by_agreement: dict[int, list] = {}
        for s in specifications:
            specs_by_agreement.setdefault(s["agreement_id"], []).append(s)
        agreements_by_counterparty: dict[int, list] = {}
        for a in agreements:
            a["specifications"] = specs_by_agreement.get(a["id"], [])
            agreements_by_counterparty.setdefault(a["counterparty_id"], []).append(a)
        for c in counterparties:
            c["agreements"] = agreements_by_counterparty.get(c["id"], [])
        return counterparties
    finally:
        conn.close()


# Контрагенты — справочник ОБЩЕСЕРВИСНЫЙ (одна и та же организация возит
# на несколько строек), поэтому объектной проверке зацепиться не за что:
# право ведёт роль «Комплектовщик» хотя бы на одном объекте
# (require_contracting, 2026-08-04). До этого справочник вёл только
# администратор сервиса, и комплектовщик упирался бы в него на первом же
# новом поставщике.
@router.post("/counterparties", response_model=CounterpartyOut)
def create_counterparty(body: CounterpartyIn, admin: sqlite3.Row = Depends(require_contracting)):
    conn = get_connection()
    try:
        code = body.code or _generate_counterparty_code(conn, body.short_name)
        conn.execute(
            "INSERT INTO counterparties "
            "(full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, code) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.full_name, body.short_name, body.inn, body.kpp, body.ogrn,
                body.legal_address, body.contact_person, body.contact_phone, code,
            ),
        )
        counterparty_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
        row = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        activity.log("counterparty_create", user=admin, entity_type="counterparty",
                     entity_id=counterparty_id, new_value=f"{body.short_name} ({code})")
        return dict(row)
    finally:
        conn.close()


@router.patch("/counterparties/{counterparty_id}", response_model=CounterpartyOut)
def update_counterparty(counterparty_id: int, body: CounterpartyIn, admin: sqlite3.Row = Depends(require_contracting)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Контрагент не найден")
        conn.execute(
            "UPDATE counterparties SET full_name=?, short_name=?, inn=?, kpp=?, ogrn=?, legal_address=?, "
            "contact_person=?, contact_phone=?, code=?, updated_at=datetime('now') WHERE id=?",
            (
                body.full_name, body.short_name, body.inn, body.kpp, body.ogrn,
                body.legal_address, body.contact_person, body.contact_phone, body.code, counterparty_id,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        activity.log("counterparty_update", user=admin, entity_type="counterparty",
                     entity_id=counterparty_id,
                     old_value=f"{existing['short_name']} ({existing['code']})",
                     new_value=f"{body.short_name} ({body.code})")
        return dict(row)
    finally:
        conn.close()


# --- Договоры ---


@router.get("/agreements", response_model=list[AgreementOut])
def list_agreements(counterparty_id: int = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        # Договор — сущность ОБЪЕКТНАЯ, и для правки это учитывалось
        # (_guard_agreement), а для чтения — нет: перебором counterparty_id
        # восстанавливалась вся договорная база предприятия (аудит
        # безопасности 2026-08-03).
        доступ, доступ_params = _accessible_agreements_clause(conn, user)
        rows = conn.execute(
            f"SELECT * FROM agreements WHERE counterparty_id = ? AND {доступ} ORDER BY number",
            (counterparty_id, *доступ_params),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _guard_specification_owner(conn, user, specification_id: int, minimum: str = "contract") -> None:
    """Доступ по ТЕКУЩЕМУ договору спецификации (а не по присланному).

    Порог правки — `contract`, а не `admin` (2026-08-04): спецификация это
    контрактный справочник, и ведёт его комплектовщик. Администратор
    объекта проходит тем же порогом — он в лестнице выше.
    """
    row = conn.execute(
        "SELECT a.object_id FROM specifications s "
        "JOIN agreements a ON a.id = s.agreement_id WHERE s.id = ?",
        (specification_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Спецификация не найдена")
    if row["object_id"] is None:
        if user["role"] != "admin":
            raise HTTPException(
                status_code=403,
                detail="Договор спецификации не привязан к объекту — правит администратор сервиса",
            )
        return
    assert_object_access(conn, user, row["object_id"], minimum)


def _accessible_agreements_clause(conn, user, column: str = "object_id") -> tuple:
    """Условие «договор относится к доступному объекту» для списков.
    Безобъектные договоры видит только администратор сервиса."""
    from app.access import accessible_object_ids
    ids = accessible_object_ids(conn, user)
    if ids is None:
        return "1 = 1", []
    if not ids:
        return "1 = 0", []
    marks = ",".join("?" * len(ids))
    return f"{column} IN ({marks})", list(ids)


def _guard_agreement(conn, user, agreement_id: int, minimum: str = "contract") -> None:
    """Доступ к договору — по объекту, на который он заключён
    (agreements.object_id, этап A).

    Если объект ещё не проставлен (договоры, заведённые до иерархии),
    правит только администратор сервиса: раздавать безобъектный договор
    «админам объектов» нельзя — неизвестно, чей он.

    Порог правки — `contract` (2026-08-04): договор это контрактный
    справочник, ведёт его комплектовщик, администратор объекта проходит
    тем же порогом.
    """
    row = conn.execute("SELECT object_id FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Договор не найден")
    if row["object_id"] is None:
        if user["role"] != "admin":
            raise HTTPException(
                status_code=403,
                detail="Договор не привязан к объекту — правит администратор сервиса",
            )
        return
    assert_object_access(conn, user, row["object_id"], minimum)


@router.post("/agreements", response_model=AgreementOut)
def create_agreement(body: AgreementIn, user: sqlite3.Row = Depends(get_current_user)):
    """Новый договор — ОБЯЗАТЕЛЬНО на объект (2026-08-03).

    Раньше объект не задавался вовсе («переедет в этап D»), и заводить
    договоры мог только администратор сервиса — иначе появился бы документ
    без владельца, доступный кому угодно. Плата за это выяснилась при
    аудите: у ВСЕХ накопленных договоров `object_id IS NULL`, а безобъектный
    договор по правилам доступа виден только администратору сервиса — то
    есть у администратора объекта каскад в форме контракта был пуст, и
    завести себе договор он не мог.

    Теперь объект указывается явно, а право заводить договор даёт роль
    не ниже `contract` НА ЭТОМ объекте. Объект приходит параметром здесь и
    только здесь — это единственное место, где он ещё не выведен из
    сущности, потому что сущности пока нет; проверка `assert_object_access`
    не даёт назвать чужой.
    """
    if body.object_id is None:
        raise HTTPException(
            status_code=400,
            detail="Укажите объект, на который заключён договор — без него договор "
                   "не виден ни в одном контракте объекта",
        )
    conn = get_connection()
    try:
        assert_object_access(conn, user, body.object_id, "contract")
        counterparty = conn.execute(
            "SELECT id FROM counterparties WHERE id = ?", (body.counterparty_id,)
        ).fetchone()
        if not counterparty:
            raise HTTPException(status_code=404, detail="Контрагент не найден")
        существующий = conn.execute(
            "SELECT id, object_id FROM agreements WHERE counterparty_id = ? AND number = ?",
            (body.counterparty_id, body.number),
        ).fetchone()
        if существующий:
            # find_or_create_agreement (её зовут импортёры) молча вернула бы
            # ЧУЖОЙ договор с тем же номером — а здесь человек нажал
            # «+ Договор» и вправе узнать, что номер занят, вместо того чтобы
            # получить в ответ документ другого объекта.
            raise HTTPException(
                status_code=400, detail="У этого контрагента уже есть договор с таким номером")
        conn.execute(
            "INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) "
            "VALUES (?, ?, ?, ?)",
            (body.counterparty_id, body.number, body.agreement_date, body.object_id),
        )
        agreement_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
        row = conn.execute("SELECT * FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        activity.log("agreement_create", user=user, entity_type="agreement", entity_id=agreement_id,
                     new_value=body.number, details={"object_id": body.object_id,
                                                     "counterparty_id": body.counterparty_id})
        return dict(row)
    finally:
        conn.close()


@router.patch("/agreements/{agreement_id}", response_model=AgreementOut)
def update_agreement(agreement_id: int, body: AgreementIn, admin: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    _guard_agreement(conn, admin, agreement_id)
    try:
        existing = conn.execute(
            "SELECT id, number, object_id FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Договор не найден")
        if body.object_id is None:
            raise HTTPException(
                status_code=400,
                detail="Укажите объект, на который заключён договор — без него договор "
                       "не виден ни в одном контракте объекта",
            )
        if body.object_id != existing["object_id"]:
            # Доступ проверяется и к НОВОМУ объекту: _guard_agreement выше
            # разрешил правку по СТАРОМУ, и без этой проверки комплектовщик
            # своего объекта перевесил бы договор на чужой.
            assert_object_access(conn, admin, body.object_id, "contract")
            # «Объект контракта = объект элемента» — инвариант схемы: объект
            # контракта не хранится, а выводится по цепочке
            # контракт → спецификация → договор. Значит, перевод договора на
            # другой объект молча уводит туда же все контракты, а вместе с
            # ними — законтрактованные изделия ЧУЖОЙ стройки. Пока такие
            # изделия есть, объект не меняем.
            занято = conn.execute(
                """
                SELECT COUNT(*) AS n FROM elements e
                JOIN contracts co ON co.id = e.contract_id
                JOIN specifications s ON s.id = co.specification_id
                WHERE s.agreement_id = ? AND e.object_id IS NOT ?
                """,
                (agreement_id, body.object_id),
            ).fetchone()["n"]
            if занято:
                raise HTTPException(
                    status_code=409,
                    detail=f"По контрактам этого договора уже законтрактовано изделий другого "
                           f"объекта: {занято}. Сменить объект договора нельзя — сначала снимите "
                           f"контракт с этих изделий.",
                )
        conn.execute(
            "UPDATE agreements SET counterparty_id=?, number=?, agreement_date=?, object_id=?, "
            "updated_at=datetime('now') WHERE id=?",
            (body.counterparty_id, body.number, body.agreement_date, body.object_id, agreement_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        activity.log("agreement_update", user=admin, entity_type="agreement", entity_id=agreement_id,
                     old_value=existing["number"], new_value=body.number,
                     details={"object_id": body.object_id,
                              "прежний объект": existing["object_id"]})
        return dict(row)
    finally:
        conn.close()


# --- Спецификации ---


@router.get("/specifications", response_model=list[SpecificationOut])
def list_specifications(agreement_id: int = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        # Спецификации принадлежат объекту через свой договор — проверяем
        # доступ к нему, а не отдаём по любому присланному agreement_id
        # (аудит безопасности 2026-08-03).
        _guard_agreement(conn, user, agreement_id, "view")
        rows = conn.execute(
            "SELECT * FROM specifications WHERE agreement_id = ? ORDER BY number", (agreement_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/specifications", response_model=SpecificationOut)
def create_specification(body: SpecificationIn, admin: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    _guard_agreement(conn, admin, body.agreement_id)
    try:
        agreement = conn.execute("SELECT id FROM agreements WHERE id = ?", (body.agreement_id,)).fetchone()
        if not agreement:
            raise HTTPException(status_code=404, detail="Договор не найден")
        try:
            specification_id = find_or_create_specification(
                conn, body.agreement_id, body.number, body.specification_date
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="У этого договора уже есть спецификация с таким номером")
        conn.commit()
        row = conn.execute("SELECT * FROM specifications WHERE id = ?", (specification_id,)).fetchone()
        activity.log("specification_create", user=admin, entity_type="specification",
                     entity_id=specification_id, new_value=body.number,
                     details={"agreement_id": body.agreement_id})
        return dict(row)
    finally:
        conn.close()


@router.patch("/specifications/{specification_id}", response_model=SpecificationOut)
def update_specification(specification_id: int, body: SpecificationIn, admin: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    # Сначала — чья спецификация правится, потом — куда её переносят. Без
    # первой проверки админ объекта А перевешивал чужую спецификацию на свой
    # договор (аудит безопасности 2026-08-03), тот же дефект, что был у
    # правки контракта.
    _guard_specification_owner(conn, admin, specification_id)
    _guard_agreement(conn, admin, body.agreement_id)
    try:
        existing = conn.execute(
            "SELECT id, number, agreement_id FROM specifications WHERE id = ?",
            (specification_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Спецификация не найдена")
        conn.execute(
            "UPDATE specifications SET agreement_id=?, number=?, specification_date=?, updated_at=datetime('now') WHERE id=?",
            (body.agreement_id, body.number, body.specification_date, specification_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM specifications WHERE id = ?", (specification_id,)).fetchone()
        activity.log("specification_update", user=admin, entity_type="specification",
                     entity_id=specification_id, old_value=existing["number"], new_value=body.number,
                     details={"agreement_id": body.agreement_id,
                              "прежний договор": existing["agreement_id"]})
        return dict(row)
    finally:
        conn.close()


# --- Справочник префиксов марок ---


@router.get("/mark-type-prefixes")
def list_mark_type_prefixes(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT prefix, element_type FROM mark_type_prefixes ORDER BY prefix").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/mark-type-prefixes")
def upsert_mark_type_prefix(body: MarkTypePrefixIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO mark_type_prefixes (prefix, element_type) VALUES (?, ?) "
            "ON CONFLICT(prefix) DO UPDATE SET element_type = excluded.element_type",
            (body.prefix, body.element_type),
        )
        conn.commit()
        activity.log("mark_prefix_set", user=admin, entity_type="mark_prefix",
                     old_value=body.prefix, new_value=body.element_type)
        return {"prefix": body.prefix, "element_type": body.element_type}
    finally:
        conn.close()


@router.delete("/mark-type-prefixes/{prefix}")
def delete_mark_type_prefix(prefix: str, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM mark_type_prefixes WHERE prefix = ?", (prefix,))
        conn.commit()
        activity.log("mark_prefix_delete", user=admin, entity_type="mark_prefix", old_value=prefix)
        return {"status": "ok"}
    finally:
        conn.close()

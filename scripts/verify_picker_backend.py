"""Проверка backend области «комплектовщик» (контрагенты, договоры, спецификации, контракты, документы замены поставщика и обмена привязками).

Что проверяется (вызов обработчиков в потоках на КОПИИ обезличенной БД, источник не меняется):

  1. Версия записи (app/record_version.py): есть в списках и ответах; правка с устаревшим `expected_version` — 409 `stale_version` и НИЧЕГО не
     изменено; без `expected_version` (V1) — как раньше; распределение изделий (факт) версию контракта не меняет.
  2. Гонка «две правки одной версии»: ровно одна проходит, вторая — 409 (не затирает).
  3. Уникальность: дубль спецификации — 400 (раньше молча возвращалась существующая), дубль договора при гонке — 400 без 500,
     повтор пары (тип, марка) в контракте — 400 и полный откат.
  4. Документы замены/обмена: создание, правка и удаление берут блокировку записи ПЕРВЫМ действием; гонка «правка/удаление ↔ проведение»
     не оставляет проведённый документ с чужим составом и не удаляет проведённый документ; проведение/отмена с устаревшей версией — 409, без изменений.
  5. Освобождение блокировки при отказе (права, нет сущности, устаревшая версия).

Запуск (только на копии обезличенной БД):  .venv/bin/python scripts/verify_picker_backend.py <копия_БД>
"""

import _guard_harness as H  # noqa: E402,I001  (первым: задаёт путь к БД)
from _guard_harness import call, db, fresh_db, other_writer_ok, race, released, user_row  # noqa: E402

import sys  # noqa: E402

import app.main as main  # noqa: E402
from app import contracts as contracts_mod  # noqa: E402
from app import counterparties as cp  # noqa: E402
from app import supplier_change as sc  # noqa: E402

MODS = [main, contracts_mod, sc, cp]
try:
    import app.allocation as allocation  # noqa: E402
    MODS.append(allocation)
except ImportError:
    allocation = None
H.track_connections(*MODS)

ADMIN = user_row()
NOBODY = user_row("role != 'admin'")

FAILS = []
CASES = 0


def ok(name, cond, detail=""):
    global CASES
    CASES += 1
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(f"{name}: {detail}")


def reset():
    fresh_db()
    c = db()
    c.execute("DELETE FROM user_access WHERE user_id = ?", (NOBODY["id"],))
    c.commit()
    c.close()
    H.TRACKED.clear()
    H.TRACE.clear()


def clean():
    """Соединения обработчиков закрыты, другой писатель свободен."""
    bad = released()
    if not other_writer_ok():
        bad.append("другой писатель не смог начать транзакцию")
    return bad


def fp(tables=("counterparties", "counterparty_capacity", "agreements", "specifications", "contracts", "contract_lines", "contract_incidents",
               "supplier_change_docs", "supplier_change_items", "supplier_change_history_moves", "elements", "status_history")):
    return H.checksum(tables)


def first_sql(conn_index):
    return next((s for i, s in H.TRACE if i == conn_index), "")


def stale_code(res):
    return res[0] == 409 and isinstance(res[1], dict) and res[1].get("conflict") == "stale_version"


def cp_body(**kw):
    d = dict(full_name="ООО «Тест»", short_name="Тест", inn=None, kpp=None, ogrn=None, legal_address=None, contact_person=None,
             contact_phone=None, code=None, capacity=[])
    d.update(kw)
    return cp.CounterpartyIn(**d)


def contract_in(cid, **kw):
    c = db()
    co = c.execute("SELECT * FROM contracts WHERE id = ?", (cid,)).fetchone()
    lines = [contracts_mod.ContractLineIn(element_type=r["element_type"], mark=r["mark"], quantity=r["quantity"])
             for r in c.execute("SELECT * FROM contract_lines WHERE contract_id = ? ORDER BY id", (cid,))]
    c.close()
    d = dict(specification_id=co["specification_id"], theme=co["theme"], is_archived=bool(co["is_archived"]), lines=lines, incidents=[], capacity=None)
    d.update(kw)
    return contracts_mod.ContractIn(**d)


def run():
    # ------------------------------------------------------------ 1. версии записей
    print("1. версия записи и проверка устаревших данных")
    reset()
    lst = cp.list_counterparties(ADMIN)
    ok("список контрагентов отдаёт version", all(r.get("version") for r in lst))
    c0 = lst[0]
    r = call(cp.update_counterparty, c0["id"], cp_body(full_name=c0["full_name"], short_name=c0["short_name"], code=c0["code"], expected_version=c0["version"], contact_phone="+7 000"), ADMIN)
    ok("правка с актуальной версией проходит", r[0] == "ok" and r[1]["contact_phone"] == "+7 000", str(r))
    new_v = r[1]["version"]
    ok("версия после правки сменилась", new_v != c0["version"])
    before = fp()
    r = call(cp.update_counterparty, c0["id"], cp_body(full_name=c0["full_name"], short_name=c0["short_name"], code=c0["code"], expected_version=c0["version"], contact_phone="+7 111"), ADMIN)
    ok("правка с устаревшей версией → 409 stale_version", stale_code(r), str(r))
    ok("…и НИЧЕГО не изменено", fp() == before)
    ok("…блокировка освобождена", not clean(), str(clean()))
    r = call(cp.update_counterparty, c0["id"], cp_body(full_name=c0["full_name"], short_name=c0["short_name"], code=c0["code"], contact_phone="+7 222"), ADMIN)
    ok("правка БЕЗ expected_version (как V1) проходит", r[0] == "ok" and r[1]["contact_phone"] == "+7 222", str(r))
    # (права на контрагентов проверяются зависимостью маршрута — при прямом вызове обработчика их нет; см. проверку по HTTP в браузерных сценариях)

    # договор / спецификация
    ag = call(cp.list_agreements, c0["id"], object_id=None, user=ADMIN)[1]
    if not ag:
        ag = call(cp.list_agreements, lst[1]["id"], object_id=None, user=ADMIN)[1]
    a0 = ag[0]
    ok("список договоров отдаёт version", all(x.get("version") for x in ag))
    body = lambda ver=None, num=None: cp.AgreementIn(counterparty_id=a0["counterparty_id"], number=num or a0["number"], agreement_date=a0["agreement_date"], object_id=a0["object_id"], expected_version=ver)
    if a0["object_id"] is None:
        c = db(); c.execute("UPDATE agreements SET object_id = 1 WHERE id = ?", (a0["id"],)); c.commit(); c.close()
        ag = call(cp.list_agreements, a0["counterparty_id"], object_id=None, user=ADMIN)[1]; a0 = next(x for x in ag if x["id"] == a0["id"])
    r1 = call(cp.update_agreement, a0["id"], body(a0["version"], a0["number"] + "-Б"), ADMIN)
    ok("договор: правка с актуальной версией", r1[0] == "ok", str(r1))
    before = fp()
    r2 = call(cp.update_agreement, a0["id"], body(a0["version"], a0["number"] + "-В"), ADMIN)
    ok("договор: устаревшая версия → 409, без изменений", stale_code(r2) and fp() == before, str(r2))
    specs = call(cp.list_specifications, a0["id"], ADMIN)[1]
    if specs:
        s0 = specs[0]
        sb = lambda ver=None, num=None: cp.SpecificationIn(agreement_id=a0["id"], number=num or s0["number"], specification_date=s0["specification_date"], expected_version=ver)
        ok("список спецификаций отдаёт version", all(x.get("version") for x in specs))
        r1 = call(cp.update_specification, s0["id"], sb(s0["version"], s0["number"] + "-Б"), ADMIN)
        ok("спецификация: правка с актуальной версией", r1[0] == "ok", str(r1))
        before = fp()
        r2 = call(cp.update_specification, s0["id"], sb(s0["version"], s0["number"] + "-В"), ADMIN)
        ok("спецификация: устаревшая версия → 409, без изменений", stale_code(r2) and fp() == before, str(r2))
        dup = call(cp.create_specification, cp.SpecificationIn(agreement_id=a0["id"], number=r1[1]["number"], specification_date=None), ADMIN)
        ok("спецификация: дубль номера → 400 (раньше молча возвращалась существующая)", dup[0] == 400, str(dup))

    # контракт
    pos, ids = H.find_position(db(), 4)
    cid = pos["contract_id"]
    H.make_room(db(), pos, 3)
    cl = call(contracts_mod.list_contracts, object_id=None, user=ADMIN)[1]
    k0 = next(x for x in cl if x.id == cid)
    ok("список контрактов отдаёт version", all(x.version for x in cl))
    r = call(contracts_mod.update_contract, cid, contract_in(cid, theme="тема-1", expected_version=k0.version), ADMIN)
    ok("контракт: правка с актуальной версией", r[0] == "ok" and r[1].theme == "тема-1", str(r))
    before = fp()
    r2 = call(contracts_mod.update_contract, cid, contract_in(cid, theme="тема-2", expected_version=k0.version), ADMIN)
    ok("контракт: устаревшая версия → 409, без изменений", stale_code(r2) and fp() == before, str(r2))
    ok("контракт: блокировка освобождена после 409", not clean(), str(clean()))
    # распределение (факт) версию НЕ меняет
    v_before = call(contracts_mod.list_contracts, object_id=None, user=ADMIN)[1]
    v_before = next(x for x in v_before if x.id == cid).version
    if allocation is not None:
        al = allocation.AllocationIn(object_id=1, element_type=pos["element_type"], mark=pos["mark"],
                                     items=[allocation.AllocationItem(element_id=ids[0], expected_status="planned")])
        ra = call(allocation.allocate, cid, al, ADMIN)
        v_after = next(x for x in call(contracts_mod.list_contracts, object_id=None, user=ADMIN)[1] if x.id == cid).version
        ok("распределение изделия (факт) не делает версию контракта устаревшей", ra[0] == "ok" and v_before == v_after, str(ra))
    # повтор пары (тип, марка)
    dupl = [contracts_mod.ContractLineIn(element_type="Колонна", mark="ТЕСТ-1", quantity=1), contracts_mod.ContractLineIn(element_type="Колонна", mark="ТЕСТ-1", quantity=2)]
    before = fp()
    r = call(contracts_mod.update_contract, cid, contract_in(cid, lines=dupl), ADMIN)
    ok("контракт: повтор (тип, марка) → 400 и полный откат", r[0] == 400 and fp() == before, str(r))
    r = call(contracts_mod.create_contract, contract_in(cid, lines=dupl), ADMIN)
    ok("контракт (создание): повтор (тип, марка) → 400 и полный откат", r[0] == 400 and fp() == before, str(r))
    ok("…блокировка освобождена", not clean(), str(clean()))

    # ------------------------------------------------------------ 2. гонки
    print("2. гонки")
    reset()
    lst = cp.list_counterparties(ADMIN)
    c0 = lst[0]
    ok_n = []
    for rnd in range(12):
        cur = call(cp.list_counterparties, ADMIN)[1]
        cur = next(x for x in cur if x["id"] == c0["id"])
        mk = lambda ph: cp_body(full_name=cur["full_name"], short_name=cur["short_name"], code=cur["code"], expected_version=cur["version"], contact_phone=ph)
        res = race([(cp.update_counterparty, c0["id"], mk(f"+7 {rnd}1"), ADMIN), (cp.update_counterparty, c0["id"], mk(f"+7 {rnd}2"), ADMIN)])
        codes = sorted(str(x[0]) for x in res)
        ok_n.append(codes == ["409", "ok"] and any(stale_code(x) for x in res))
    ok("две одновременные правки одной версии: ровно одна проходит, вторая 409 (12 раундов)", all(ok_n), str(ok_n))
    ok("…блокировка освобождена", not clean(), str(clean()))
    # дубль договора при гонке
    c = db()
    obj = c.execute("SELECT id FROM objects ORDER BY id LIMIT 1").fetchone()["id"]
    cpid = c.execute("SELECT id FROM counterparties ORDER BY id LIMIT 1").fetchone()["id"]
    c.close()
    res = race([(cp.create_agreement, cp.AgreementIn(counterparty_id=cpid, number="ГОНКА-1", agreement_date=None, object_id=obj), ADMIN)] * 2)
    codes = sorted(str(x[0]) for x in res)
    ok("две одновременные заявки «новый договор» с одним номером: одна создаёт, вторая 400 (не 500)", codes == ["400", "ok"], str(res))
    n = db().execute("SELECT COUNT(*) n FROM agreements WHERE counterparty_id = ? AND number = 'ГОНКА-1'", (cpid,)).fetchone()["n"]
    ok("…в БД ровно один договор", n == 1, str(n))

    # ------------------------------------------------------------ 3. документы
    print("3. документы замены поставщика и обмена привязками")
    reset()
    c = db()
    pos, ids = H.find_position(c, 4)
    a = pos["contract_id"]
    b = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements ag ON ag.id = s.agreement_id "
                  "WHERE ag.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (a,)).fetchone()["id"]
    # Количество — ПОВЕРХ уже привязанного на a/b под эту (тип, марка) факта, а не абсолютная тройка: в накопленных
    # данных копии на a/b уже может быть что-то привязано под ту же позицию, и абсолютное число тогда создавало бы
    # фиктивное превышение остатка ещё ДО теста (нашлось 2026-09-22 при добавлении стража в unpost_supplier_change —
    # с абсолютной тройкой «отмена проведения» из раздела 3 стабильно получала 409 на позиции с большим накопленным
    # фактом; те же 3 добавляемых изделия, но качество площадки СЧИТАЕТСЯ от факта, как в make_room других сценариев).
    for cid_, extra in ((a, 3), (b, 3)):
        fact = c.execute(
            "SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND element_type = ? AND mark = ? AND current_status != 'planned'",
            (cid_, pos["element_type"], pos["mark"])).fetchone()["n"]
        c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (cid_, pos["element_type"], pos["mark"]))
        c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)", (cid_, pos["element_type"], pos["mark"], fact + extra))
    for e in ids[:3]:
        c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (a, e))
        c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (e, a))
    c.commit()
    c.close()
    H.TRACKED.clear(); H.TRACE.clear()

    def sin(elems, ver=None, num=None):
        return sc.SupplierChangeIn(object_id=1, doc_date="2026-09-21", from_contract_id=a, to_contract_id=b, element_ids=elems, number=num, expected_version=ver)

    n0 = len(H.TRACKED)
    r = call(sc.create_supplier_change, sin(ids[:1]), ADMIN)
    ok("создание документа: ответ содержит version", r[0] == "ok" and r[1].get("version"), str(r))
    ok("создание: блокировка записи — первым SQL соединения", first_sql(n0).upper().startswith("BEGIN IMMEDIATE"), first_sql(n0))
    doc = r[1]
    n0 = len(H.TRACKED)
    r = call(sc.update_supplier_change, doc["id"], sin(ids[:2], doc["version"]), ADMIN)
    ok("правка черновика с актуальной версией", r[0] == "ok" and len(r[1]["items"]) == 2, str(r))
    ok("правка: блокировка записи — первым SQL соединения", first_sql(n0).upper().startswith("BEGIN IMMEDIATE"), first_sql(n0))
    before = fp()
    r2 = call(sc.update_supplier_change, doc["id"], sin(ids[:3], doc["version"]), ADMIN)   # версия уже устарела
    ok("правка черновика с устаревшей версией → 409, без изменений", stale_code(r2) and fp() == before, str(r2))
    doc = r[1]
    n0 = len(H.TRACKED)
    rd = call(sc.delete_supplier_change, 99999999, ADMIN)
    ok("удаление: нет документа → 404; блокировка — первым SQL и освобождена", rd[0] == 404 and first_sql(n0 + 0 if n0 < len(H.TRACKED) else 0).upper().startswith("BEGIN IMMEDIATE") and not clean(), str(rd))
    before = fp()
    r = call(sc.post_supplier_change, doc["id"], ADMIN, sc.DocActionIn(expected_version="0000000000000000"))
    ok("проведение с устаревшей версией → 409, без изменений", stale_code(r) and fp() == before, str(r))
    ok("…блокировка освобождена", not clean(), str(clean()))
    r = call(sc.post_supplier_change, doc["id"], NOBODY, sc.DocActionIn(expected_version=doc["version"]))
    ok("проведение без прав → 403, без изменений", r[0] == 403 and fp() == before, str(r))
    r = call(sc.post_supplier_change, doc["id"], ADMIN, sc.DocActionIn(expected_version=doc["version"]))
    ok("проведение актуальной версии проходит; ответ содержит version и состояние «проведён»", r[0] == "ok" and r[1]["status"] == "posted" and r[1].get("version"), str(r)[:200])
    posted = r[1]
    c = db()
    moved = c.execute("SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND id IN (%s)" % ",".join(map(str, ids[:2])), (b,)).fetchone()["n"]
    c.close()
    ok("после проведения изделия документа на новом контракте", moved == 2, str(moved))
    # правка/удаление проведённого
    r = call(sc.update_supplier_change, doc["id"], sin(ids[:1], posted["version"]), ADMIN)
    ok("правка проведённого документа → 409", r[0] == 409, str(r))
    r = call(sc.delete_supplier_change, doc["id"], ADMIN)
    ok("удаление проведённого документа → 409", r[0] == 409, str(r))
    before = fp()
    r = call(sc.unpost_supplier_change, doc["id"], ADMIN, sc.DocActionIn(expected_version="0000000000000000"))
    ok("отмена проведения с устаревшей версией → 409, без изменений", stale_code(r) and fp() == before, str(r))
    r = call(sc.unpost_supplier_change, doc["id"], ADMIN, sc.DocActionIn(expected_version=posted["version"]))
    c = db()
    back = c.execute("SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND id IN (%s)" % ",".join(map(str, ids[:2])), (a,)).fetchone()["n"]
    c.close()
    ok("отмена проведения актуальной версии возвращает изделия на прежний контракт", r[0] == "ok" and r[1]["status"] == "draft" and back == 2, str(r)[:200])

    # гонка «правка ↔ проведение»: проведённый документ не должен получить чужой состав
    bad = []
    for rnd in range(10):
        c = db()
        # состояние: черновик из 1 изделия (ids[2] на контракте a), затем правка на состав из ids[2] и ids[1] против проведения
        c.execute("DELETE FROM supplier_change_docs WHERE object_id = 1 AND number LIKE 'Г%'")
        c.execute("UPDATE elements SET contract_id = ? WHERE id IN (%s)" % ",".join(map(str, ids[:3])), (a,))
        c.commit(); c.close()
        d = call(sc.create_supplier_change, sin([ids[2]], num=f"Г{rnd}"), ADMIN)[1]
        res = race([(sc.update_supplier_change, d["id"], sin([ids[1], ids[2]], num=f"Г{rnd}"), ADMIN), (sc.post_supplier_change, d["id"], ADMIN)])
        c = db()
        row = c.execute("SELECT status FROM supplier_change_docs WHERE id = ?", (d["id"],)).fetchone()
        items = [r_["element_id"] for r_ in c.execute("SELECT element_id FROM supplier_change_items WHERE doc_id = ?", (d["id"],))]
        moved_ids = [r_["id"] for r_ in c.execute("SELECT id FROM elements WHERE contract_id = ? AND id IN (%s)" % ",".join(map(str, ids[:3])), (b,))]
        c.close()
        if row and row["status"] == "posted" and sorted(items) != sorted(moved_ids):
            bad.append((rnd, res, items, moved_ids))
        # приводим к исходному: отмена проведения, удаление
        if row and row["status"] == "posted":
            call(sc.unpost_supplier_change, d["id"], ADMIN)
    ok("гонка «правка ↔ проведение» (10 раундов): состав проведённого документа = то, что реально перенесено", not bad, str(bad[:1]))
    ok("…блокировка освобождена", not clean(), str(clean()))
    # гонка «удаление ↔ проведение»
    bad = []
    for rnd in range(10):
        c = db()
        c.execute("UPDATE elements SET contract_id = ? WHERE id IN (%s)" % ",".join(map(str, ids[:3])), (a,))
        c.commit(); c.close()
        d = call(sc.create_supplier_change, sin([ids[2]], num=f"У{rnd}"), ADMIN)[1]
        res = race([(sc.delete_supplier_change, d["id"], ADMIN), (sc.post_supplier_change, d["id"], ADMIN)])
        c = db()
        row = c.execute("SELECT status FROM supplier_change_docs WHERE id = ?", (d["id"],)).fetchone()
        mv = c.execute("SELECT contract_id FROM elements WHERE id = ?", (ids[2],)).fetchone()["contract_id"]
        c.close()
        # допустимо: (документ удалён И изделие не тронуто) или (документ проведён И изделие перенесено)
        good = (row is None and mv == a) or (row is not None and row["status"] == "posted" and mv == b)
        if not good:
            bad.append((rnd, res, dict(row) if row else None, mv))
        if row is not None and row["status"] == "posted":
            call(sc.unpost_supplier_change, d["id"], ADMIN)
    ok("гонка «удаление ↔ проведение» (10 раундов): либо удалён и не тронуто, либо проведён и перенесено", not bad, str(bad[:1]))
    ok("…блокировка освобождена", not clean(), str(clean()))
    # два проведения одного документа одновременно: ровно одно применяется, второе — 409 «уже проведён»; история не задваивается
    bad = []
    for rnd in range(8):
        c = db()
        c.execute("UPDATE elements SET contract_id = ? WHERE id IN (%s)" % ",".join(map(str, ids[:3])), (a,))
        c.commit(); c.close()
        d = call(sc.create_supplier_change, sin([ids[2]], num=f"П{rnd}"), ADMIN)[1]
        hist0 = db().execute("SELECT COUNT(*) n FROM status_history WHERE element_id = ?", (ids[2],)).fetchone()["n"]
        res = race([(sc.post_supplier_change, d["id"], ADMIN), (sc.post_supplier_change, d["id"], ADMIN)])
        hist1 = db().execute("SELECT COUNT(*) n FROM status_history WHERE element_id = ?", (ids[2],)).fetchone()["n"]
        codes = sorted(str(x[0]) for x in res)
        if codes != ["409", "ok"] or hist1 != hist0 + 1:
            bad.append((rnd, codes, hist0, hist1))
        call(sc.unpost_supplier_change, d["id"], ADMIN)
    ok("два одновременных проведения одного документа (8 раундов): одно ok, второе 409; запись истории одна", not bad, str(bad[:1]))
    # два одновременных «Отменить проведение»
    bad = []
    for rnd in range(6):
        c = db()
        c.execute("UPDATE elements SET contract_id = ? WHERE id = ?", (a, ids[2]))
        c.commit(); c.close()
        d = call(sc.create_supplier_change, sin([ids[2]], num=f"О{rnd}"), ADMIN)[1]
        call(sc.post_supplier_change, d["id"], ADMIN)
        res = race([(sc.unpost_supplier_change, d["id"], ADMIN), (sc.unpost_supplier_change, d["id"], ADMIN)])
        codes = sorted(str(x[0]) for x in res)
        cnow = db().execute("SELECT contract_id FROM elements WHERE id = ?", (ids[2],)).fetchone()["contract_id"]
        if codes != ["409", "ok"] or cnow != a:
            bad.append((rnd, codes, cnow))
    ok("два одновременных «Отменить проведение» (6 раундов): одно ok, второе 409; изделие на прежнем контракте", not bad, str(bad[:1]))
    ok("…блокировка освобождена", not clean(), str(clean()))
    # одновременные создания получают разные номера
    res = race([(sc.create_supplier_change, sin([ids[0]]), ADMIN)] * 3)
    nums = [r_[1]["number"] for r_ in res if r_[0] == "ok"]
    ok("три одновременных черновика: без ошибок и с разными номерами", len(nums) == 3 and len(set(nums)) == 3, str(res)[:300])


if __name__ == "__main__":
    run()
    print(f"\nпроверок: {CASES}; нарушений: {len(FAILS)}")
    sys.exit(1 if FAILS else 0)

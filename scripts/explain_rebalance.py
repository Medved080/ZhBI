# -*- coding: utf-8 -*-
"""Почему два изделия не сбалансировались: разбор по GUID (2026-10-09, живой вопрос: «соседние изделия в разных стоянках крана, одно уже
привезли — почему не сбалансировались?»).

Для каждого изделия показывает всё, от чего зависит балансировка поставки (app/supplier_change.py): входит ли оно в расчёт и если нет —
почему; контракт и марка (группа обмена — «контракт + марка», при общем пуле — только марка); плановая дата поставки; ТРЕБУЕМАЯ дата
(директивное начало СМР, при его отсутствии — начало СМР последней актуализации); просрочка. Для пары — одной ли они группы и дал бы ли
обмен датами выигрыш; затем — что реально решила балансировка по объекту (изделие в расчёте, с кем и на какую дату обменяно).

Работает на КОПИИ базы: указанный файл не изменяется (копия снимается средствами SQLite во временный каталог). Названия контрактов и
адреса печатаются — перед тем как вставлять вывод в чат, посмотрите, можно ли это делать с данными боевой базы.

  .venv312/bin/python scripts/explain_rebalance.py data/zhbi.anon.db <GUID1> [<GUID2> ...]
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src = os.path.abspath(sys.argv[1])
    guids = [g.strip().lower().replace("-", "") for g in sys.argv[2:]]
    tmp = tempfile.mkdtemp(prefix="rb_explain_")
    work = os.path.join(tmp, "copy.db")
    s, d = sqlite3.connect(src), sqlite3.connect(work)
    s.backup(d)
    s.close()
    d.close()
    os.environ["ZHBI_DB_PATH"] = work
    sys.path.insert(0, REPO)
    from app import supplier_change as sc
    from app.schedule_versions import need_start_dates

    conn = sqlite3.connect(work)
    conn.row_factory = sqlite3.Row

    def days(a, b):
        """b − a в днях (строки ГГГГ-ММ-ДД) или None."""
        if not a or not b:
            return None
        return (date.fromisoformat(str(b)[:10]) - date.fromisoformat(str(a)[:10])).days

    found = []
    for g in guids:
        e = conn.execute("SELECT * FROM elements WHERE REPLACE(LOWER(element_uid), '-', '') = ?", (g,)).fetchone()
        if e is None:
            print(f"\n=== {g}: изделие с таким GUID не найдено")
            continue
        found.append(e)
    need_cache: dict = {}
    infos = []
    for e in found:
        oid = e["object_id"]
        if oid not in need_cache:
            need_cache[oid] = need_start_dates(conn, oid)
        need = need_cache[oid].get(e["id"])
        cname = sc._contract_name(conn, e["contract_id"]) if e["contract_id"] else "—"
        archived = conn.execute("SELECT is_archived FROM contracts WHERE id = ?", (e["contract_id"],)).fetchone() if e["contract_id"] else None
        zones = conn.execute(
            "SELECT (SELECT name FROM zones WHERE id = ?) AS crane, (SELECT name FROM zones WHERE id = ?) AS stance", (e["zone_crane_id"], e["zone_stance_id"])).fetchone()
        consistent = e["id"] in sc._history_consistent_ids(conn, [e["id"]])
        reason = sc._rebalance_eligible(e, None, "")
        if reason is None and e["contract_id"] is None:
            reason = "у изделия нет контракта (в балансировку входят только изделия с контрактом)"
        if reason is None and archived and archived["is_archived"]:
            reason = "контракт изделия в архиве (в список выбора формы такие контракты не попадают)"
        if reason is None and not consistent:
            reason = "у изделия нет истории статусов или кэш статуса/даты факта расходится с историей (такие изделия в обмен не берутся)"
        print(f"\n=== {e['element_uid']}  (id {e['id']})")
        print(f"  изделие: {e['element_type']} / {e['mark']}; этаж {e['floor']}; адрес {e['address']}")
        print(f"  кран / стоянка: {zones['crane']} / {zones['stance']}")
        print(f"  статус: {e['current_status']}; фактическая поставка: {e['actual_delivery_date'] or '—'}")
        print(f"  контракт: {cname} (id {e['contract_id']})")
        print(f"  плановая поставка: {e['planned_delivery_date'] or '—'}; директивное начало СМР: {e['project_smr_start_date'] or '—'}; "
              f"ТРЕБУЕМАЯ дата: {need or '—'}")
        late = days(need, e["planned_delivery_date"])
        print(f"  просрочка плановой относительно требуемой: {('нет данных' if late is None else f'{late} дн.' if late > 0 else 'в срок (запас ' + str(-late) + ' дн.)')}")
        print(f"  входит в балансировку: {'ДА' if reason is None else 'НЕТ — ' + reason}")
        infos.append({"need": need, "late": late, "reason": reason, "row": e, "cname": cname, "id": e["id"]})

    if len(infos) >= 2:
        a, b = infos[0], infos[1]
        ea, eb = a["row"], b["row"]
        print("\n=== пара")
        same_obj = ea["object_id"] == eb["object_id"]
        print(f"  один объект: {'да' if same_obj else 'НЕТ — обмен возможен только внутри объекта'}")
        same_mark = (ea["mark"] or "").strip().lower() == (eb["mark"] or "").strip().lower()
        same_contract = ea["contract_id"] == eb["contract_id"]
        print(f"  одна марка: {'да' if same_mark else 'НЕТ — группа обмена строится по марке'} ({ea['mark']} / {eb['mark']})")
        print(f"  один контракт: {'да' if same_contract else 'НЕТ — без общего пула даты не переходят между контрактами'}")
        if a["need"] and b["need"] and ea["planned_delivery_date"] and eb["planned_delivery_date"]:
            before = (days(a["need"], ea["planned_delivery_date"]), days(b["need"], eb["planned_delivery_date"]))
            after = (days(a["need"], eb["planned_delivery_date"]), days(b["need"], ea["planned_delivery_date"]))
            pos = lambda v: max(v, 0)  # noqa: E731
            print(f"  просрочка сейчас: {before[0]} / {before[1]} дн.; после обмена датами: {after[0]} / {after[1]} дн.")
            gain = (pos(before[0]) + pos(before[1])) - (pos(after[0]) + pos(after[1]))
            print(f"  суммарная просрочка по паре: {pos(before[0]) + pos(before[1])} → {pos(after[0]) + pos(after[1])} дн. "
                  f"({'обмен выгоден' if gain > 0 else 'обмен НЕ даёт выигрыша — поэтому они и не обменены' if gain == 0 else 'обмен ухудшил бы'})")
        else:
            print("  у одного из изделий нет требуемой даты или плановой — выигрыш от обмена не вычислить; "
                  "изделие без требуемой даты срочности не имеет и может быть только источником ранней даты")
        if same_obj:
            oid = ea["object_id"]
            for pool in (False, True):
                plan = sc._rebalance_plan(conn, oid, None, "", None, pool)
                by = {i["element_id"]: i for i in plan["items"]}
                print(f"\n  расчёт по объекту ({'общий пул дат между контрактами' if pool else 'внутри контрактов'}), «все контракты × все марки»:")
                for x in (a, b):
                    i = by.get(x["id"])
                    if i is None:
                        print(f"    id {x['id']}: в расчёте НЕТ (не прошёл отбор или его группа не меняется: в группах без изменений строки не показываются)")
                    else:
                        print(f"    id {x['id']}: дата {i['plan_old']} → {i['plan_new']}; партнёр {i['partner_id'] or '—'}; "
                              f"просрочка {i['delay_old']} → {i['delay_new']}; в обмене: {'да' if i['pair_no'] else 'нет'}")
    conn.close()
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Диагностика подсказки «предстоит связать» (АРМ комплектовщика).

Зачем. В АРМ у выбранного (или развёрнутого) контракта с остатком на схеме
мерцают ещё не привязанные изделия подходящей марки. Если не мерцает ничего,
причина почти всегда в ДАННЫХ, а не в интерфейсе, и вариантов ровно три:

  1. у позиций контракта нет марки (импорт контрактации не смог её
     определить) — тогда подсказка работает по типу элемента;
  2. марка позиции не совпадает с маркой изделия по регистру/пробелам;
  3. изделий такой марки в модели нет вовсе.

Скрипт печатает по каждому контракту объекта: сколько позиций, сколько из
них без марки, сколько закуплено, сколько привязано, каков остаток и сколько
СВОБОДНЫХ изделий подошло бы под остаток. Названий контрагентов и договоров
в выводе нет — только id контракта, — чтобы вывод можно было переслать без
оглядки на реквизиты.

Запуск (по умолчанию — база из ZHBI_DB_PATH или data/zhbi.db):

    .venv/bin/python scripts/diag_pending_link.py
    .venv/bin/python scripts/diag_pending_link.py --object 1
"""

import argparse
import os
import sqlite3
import sys


def ключ_марки(значение):
    текст = (значение or "").strip().lower()
    return f"m:{текст}" if текст else None


def ключ_типа(значение):
    текст = (значение or "").strip().lower()
    return f"t:{текст}" if текст else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=os.environ.get("ZHBI_DB_PATH", "data/zhbi.db"))
    parser.add_argument("--object", type=int, default=None, help="id объекта; по умолчанию — все")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    объекты = conn.execute(
        "SELECT id, name FROM objects ORDER BY id"
        if args.object is None else
        "SELECT id, name FROM objects WHERE id = ? ORDER BY id",
        () if args.object is None else (args.object,),
    ).fetchall()
    if not объекты:
        print("Объектов не найдено", file=sys.stderr)
        return 1

    for об in объекты:
        # Изделия объекта — те же, что видит схема: актуальный чертёж объекта.
        элементы = conn.execute(
            """
            SELECT e.id, e.mark, e.element_type, e.contract_id
            FROM elements e
            JOIN object_drawings d ON d.source_file = e.source_file AND d.is_current = 1
            WHERE d.object_id = ? AND e.is_current = 1
            """,
            (об["id"],),
        ).fetchall()
        свободные = [e for e in элементы if e["contract_id"] is None]
        print(f"\n=== Объект #{об['id']} · изделий {len(элементы)}, из них без контракта {len(свободные)} ===")

        позиции = conn.execute(
            """
            SELECT cl.contract_id, cl.element_type, cl.mark, cl.quantity
            FROM contract_lines cl
            JOIN contracts co ON co.id = cl.contract_id
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            WHERE a.object_id IS ?
            """,
            (об["id"],),
        ).fetchall()
        if not позиции:
            print("  Позиций контрактов у этого объекта нет — мерцать нечему.")
            print("  Проверьте, привязаны ли договоры к объекту (безобъектные сюда не попадают).")
            continue

        свободные_по_ключу = {}
        for e in свободные:
            for k in (ключ_марки(e["mark"]), ключ_типа(e["element_type"])):
                if k:
                    свободные_по_ключу.setdefault(k, 0)
                    свободные_по_ключу[k] += 1

        по_контракту = {}
        for p in позиции:
            по_контракту.setdefault(p["contract_id"], []).append(p)

        print(f"  {'контракт':>9} {'позиций':>8} {'без марки':>10} {'всего':>7} "
              f"{'привязано':>10} {'остаток':>8} {'кандидатов':>11}")
        for cid, строки in sorted(по_контракту.items()):
            без_марки = sum(1 for p in строки if not (p["mark"] or "").strip())
            всего = sum(p["quantity"] or 0 for p in строки)
            привязано = sum(1 for e in элементы if e["contract_id"] == cid)
            ключи = {ключ_марки(p["mark"]) or ключ_типа(p["element_type"]) for p in строки}
            ключи.discard(None)
            кандидатов = sum(свободные_по_ключу.get(k, 0) for k in ключи)
            print(f"  {cid:>9} {len(строки):>8} {без_марки:>10} {всего:>7} "
                  f"{привязано:>10} {всего - привязано:>8} {кандидатов:>11}")

        # Итог по объекту: сколько марок позиций вообще находится в модели.
        марки_позиций = {ключ_марки(p["mark"]) for p in позиции} - {None}
        марки_изделий = {ключ_марки(e["mark"]) for e in элементы} - {None}
        точно = {(p["mark"] or "") for p in позиции if (p["mark"] or "") in
                 {(e["mark"] or "") for e in элементы}}
        print(f"  Марок в позициях: {len(марки_позиций)}; найдено среди изделий "
              f"без учёта регистра: {len(марки_позиций & марки_изделий)}; "
              f"при точном сравнении: {len(точно)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

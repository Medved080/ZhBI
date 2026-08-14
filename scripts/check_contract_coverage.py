"""Проверка: какие привязки изделий не покрыты спецификациями контрактов.

Что ищет — ровно то, что с 2026-08-14 запрещено заводить заново
(app/contract_guard.py):

  * изделие привязано к контракту, а позиции под его марку в спецификации
    нет вовсе;
  * по позиции привязано больше, чем закуплено (с учётом списанного
    повреждённым — формула остатка та же, что в карточке контракта).

Зачем отдельно от запретов. Запреты не дают СОЗДАТЬ новое нарушение, но
накопленное они не трогают: «после операции всё идеально» заблокировало бы
как раз починку. Этот скрипт показывает накопленное — сколько, у каких
контрактов и по каким маркам, — чтобы его можно было разобрать руками
(завести позицию, поправить количество или переназначить изделия).

НИЧЕГО НЕ МЕНЯЕТ: база открывается только на чтение, как и у
scripts/check_case_duplicates.py.

Правило «что считать покрытием» берётся из самого стража
(app/contract_guard.py), а не переписывается здесь: разойдясь, проверка
показывала бы не то, что запрещает система.

Запуск (база по умолчанию — из ZHBI_DB_PATH, как у сервера):

    .venv/bin/python scripts/check_contract_coverage.py
    ZHBI_DB_PATH=data/zhbi.anon.db .venv/bin/python scripts/check_contract_coverage.py
    .venv/bin/python scripts/check_contract_coverage.py путь/к/базе.db

Код возврата: 0 — нарушений нет, 1 — есть.
"""

import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.contract_guard import coverage_state, state_problems  # noqa: E402
from app.contracts import build_contract_name  # noqa: E402


def открыть(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def имя_контракта(conn, contract_id: int) -> str:
    r = conn.execute(
        """
        SELECT co.theme AS theme, co.is_archived AS is_archived,
               c.short_name AS counterparty, a.number AS agreement, a.agreement_date AS agreement_date,
               s.number AS specification, s.specification_date AS specification_date
        FROM contracts co
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        JOIN counterparties c ON c.id = a.counterparty_id
        WHERE co.id = ?
        """,
        (contract_id,),
    ).fetchone()
    if r is None:
        return f"контракт #{contract_id}"
    имя = build_contract_name(r["counterparty"], r["agreement"], r["agreement_date"],
                              r["specification"], r["specification_date"], r["theme"])
    return имя + (" [архивный]" if r["is_archived"] else "")


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZHBI_DB_PATH", "data/zhbi.db")
    if not Path(path).exists():
        print(f"База не найдена: {path}")
        return 2
    conn = открыть(path)
    try:
        всего = 0
        for r in conn.execute("SELECT id FROM contracts ORDER BY id"):
            проблемы = state_problems(coverage_state(conn, r["id"]))
            if not проблемы:
                continue
            всего += len(проблемы)
            print(f"\n{имя_контракта(conn, r['id'])} (№{r['id']})")
            for текст in проблемы:
                print(f"  — {текст}")
        # Изделия с контрактом, которого больше нет: сюда страж не смотрит
        # (покрытие считается по контракту), а разбирать это надо тем же
        # заходом — привязка есть, документа за ней нет.
        осиротевшие = conn.execute(
            "SELECT COUNT(*) AS n FROM elements e WHERE e.contract_id IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM contracts co WHERE co.id = e.contract_id)"
        ).fetchone()["n"]
        if осиротевшие:
            всего += 1
            print(f"\nИзделий с несуществующим контрактом: {осиротевшие}")
        print(f"\nВсего нарушений: {всего}" if всего
              else "\nНарушений нет: каждая привязка стоит на позиции спецификации.")
        return 1 if всего else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

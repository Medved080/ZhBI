"""Проверка: какие записи справочников различаются ТОЛЬКО регистром.

Зачем отдельно от свёртки. Свёртка (`_fold_case_duplicates`,
`app/release_tasks.py`) — необратимая операция: лишняя запись исчезает, а
ссылки переезжают на оставшуюся. Перед тем как её запускать — особенно
ПОВТОРНО, кнопкой в «Что нового», уже после первого прохода, — надо видеть,
что именно свернётся и почему. Этот скрипт НИЧЕГО НЕ МЕНЯЕТ: открывает базу
только на чтение и печатает группы задвоенных записей вместе с числом
ссылок на каждую и пометкой, какая из них останется.

Правило «что считать одним и тем же» берётся из самой обработки
(`_ключ_без_регистра`, `_выбрать_основную`), а не переписывается здесь:
разойдясь, проверка показывала бы не то, что потом произойдёт, — а именно
ради ответа на вопрос «что произойдёт» она и нужна.

Запуск (база по умолчанию — из ZHBI_DB_PATH, как у сервера):

    .venv/bin/python scripts/check_case_duplicates.py
    ZHBI_DB_PATH=data/zhbi.anon.db .venv/bin/python scripts/check_case_duplicates.py
    .venv/bin/python scripts/check_case_duplicates.py путь/к/базе.db

Код возврата: 0 — задвоенных нет, 1 — есть (годится для проверки перед
деплоем наравне со scripts/dry_run_migration.py).
"""

import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.release_tasks import _ключ_без_регистра, _выбрать_основную  # noqa: E402

# Что проверяем: имя, запрос, ключ «то же самое», вес (число ссылок),
# подпись записи. Состав и ключи — те же пять справочников и в том же
# порядке, что сворачивает обработка.
ПРОВЕРКИ = [
    (
        "Контрагенты",
        "SELECT id, short_name FROM counterparties",
        lambda r: _ключ_без_регистра(r["short_name"]),
        lambda conn, r: conn.execute(
            "SELECT COUNT(*) AS n FROM agreements WHERE counterparty_id = ?", (r["id"],)
        ).fetchone()["n"],
        lambda r: f"«{r['short_name']}»",
        "договоров",
    ),
    (
        "Договоры",
        "SELECT id, number, counterparty_id FROM agreements",
        lambda r: (r["counterparty_id"], _ключ_без_регистра(r["number"])),
        lambda conn, r: conn.execute(
            "SELECT COUNT(*) AS n FROM specifications WHERE agreement_id = ?", (r["id"],)
        ).fetchone()["n"],
        lambda r: f"договор «{r['number']}» (контрагент #{r['counterparty_id']})",
        "спецификаций",
    ),
    (
        "Спецификации",
        "SELECT id, number, agreement_id FROM specifications",
        lambda r: (r["agreement_id"], _ключ_без_регистра(r["number"])),
        lambda conn, r: conn.execute(
            "SELECT COUNT(*) AS n FROM contracts WHERE specification_id = ?", (r["id"],)
        ).fetchone()["n"],
        lambda r: f"спецификация «{r['number']}» (договор #{r['agreement_id']})",
        "контрактов",
    ),
    (
        "Марки",
        "SELECT * FROM marks",
        lambda r: (r["object_id"], r["element_type"], _ключ_без_регистра(r["name"])),
        lambda conn, r: conn.execute(
            "SELECT COUNT(*) AS n FROM elements WHERE mark_id = ?", (r["id"],)
        ).fetchone()["n"],
        lambda r: f"объект #{r['object_id']}, {r['element_type']} «{r['name']}»",
        "изделий",
    ),
    (
        "Подтипы",
        "SELECT rowid AS id, element_type, subtype FROM allowed_subtypes",
        lambda r: (r["element_type"], _ключ_без_регистра(r["subtype"])),
        lambda conn, r: conn.execute(
            "SELECT COUNT(*) AS n FROM elements WHERE element_type = ? AND subtype = ?",
            (r["element_type"], r["subtype"]),
        ).fetchone()["n"],
        lambda r: f"{r['element_type']} / «{r['subtype']}»",
        "изделий",
    ),
]


def проверить(conn) -> int:
    всего_групп = 0
    for имя, запрос, ключ, вес, подпись, чего in ПРОВЕРКИ:
        группы: dict = {}
        for r in conn.execute(запрос).fetchall():
            группы.setdefault(ключ(r), []).append(r)
        задвоенные = [записи for записи in группы.values() if len(записи) > 1]
        if not задвоенные:
            print(f"{имя}: задвоенных по регистру нет")
            continue
        всего_групп += len(задвоенные)
        print(f"{имя}: групп задвоенных — {len(задвоенные)}")
        for записи in задвоенные:
            основная, лишние = _выбрать_основную(записи, lambda r: вес(conn, r))
            print(f"  останется: {подпись(основная)} — {вес(conn, основная)} {чего}")
            for лишняя in лишние:
                print(f"    свернётся: {подпись(лишняя)} — {вес(conn, лишняя)} {чего}")
    return всего_групп


def main() -> int:
    путь = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZHBI_DB_PATH", "data/zhbi.db")
    if not Path(путь).exists():
        print(f"Базы нет: {путь}")
        return 2
    print(f"База: {путь}\n")
    # Только на чтение — проверка не должна уметь что-либо испортить даже
    # при опечатке в запросе.
    conn = sqlite3.connect(f"file:{путь}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        групп = проверить(conn)
    finally:
        conn.close()
    if групп:
        print(
            f"\nИтого групп задвоенных: {групп}. Свернуть — кнопкой обработки "
            f"«Свернуть записи справочников, различающиеся только регистром» "
            f"(«?» → закладка «Обновление»); она пишет в журнал каждую пару."
        )
        return 1
    print("\nЗадвоенных по регистру нет.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

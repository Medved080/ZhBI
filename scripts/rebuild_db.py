"""
Полная пересборка базы данных с нуля + повторная загрузка всех файлов из
Input/ — на случай, когда разбираться в причине падения БД дольше и рискованнее,
чем начать заново на тестовом контуре (см. Docs/backlog.md). Старую
data/zhbi.db не удаляет молча — сначала снимает полноценную резервную
копию в data/backups/ (app/backups.py), поэтому её видно в форме
«Действия → Обмен данными → Резервные копии» и можно вернуть оттуда же.

После пересборки users пуст, кроме дефолтного admin БЕЗ пароля (см.
schema.sql) — пароль обязательно задать сразу после (см.
scripts/reset_password.py), иначе войти будет некому.

Импортирует, в порядке зависимости:
  1. Все *.dxf из Input/ (чертежи — источник элементов/марок).
  2. Input/Контрактация*.xlsx (нужны уже загруженные марки для эвристики
     типа по префиксу, см. app/contracting_import.py).
  3. Input/Прогноз*.xlsx и Input/*СМР*.xlsx (график MS Project — нужны уже
     привязанные к зонам/этажу элементы, см. app/schedule_import.py).
Файл, не подошедший ни под один из xlsx-паттернов по имени, пропускается с
предупреждением — угадывать тип по содержимому не пытаемся (риск не той
таблицы у той же ошибки, что уже чинили в парсерах, см. Docs/backlog.md).

Запуск (внутри контейнера, где есть Input/ и data/ — см. docker-compose.yml):
    docker compose run --rm zhbi python3 scripts/rebuild_db.py [--yes]

--yes пропускает интерактивное подтверждение (для неинтерактивных вызовов —
без него по умолчанию, т.к. действие затрагивает ВСЮ базу разом).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.backups import KIND_BEFORE_REBUILD, create_backup  # noqa: E402
from app.db import DB_PATH, init_db  # noqa: E402
from app.input_import import import_input_dxf, import_input_xlsx  # noqa: E402


def _backup_existing_db() -> None:
    """Копия ПЕРЕД пересборкой — обязательна, без исключений (требование
    пользователя 2026-07-29: "не делай никаких операций с пересозданием БД
    без предварительного бэкапирования").

    Копия снимается штатным механизмом (app/backups.py), а не переименованием
    файла: так она попадает в общий список копий и её видно в форме
    восстановления вместе с остальными. Раньше здесь был shutil.move в
    `zhbi.db.bak-<дата>` — такой файл лежал рядом с базой, ниоткуда не был
    виден и легко терялся из внимания."""
    if not DB_PATH.exists():
        return
    meta = create_backup(
        kind=KIND_BEFORE_REBUILD,
        comment="автоматически перед полной пересборкой БД (scripts/rebuild_db.py)",
    )
    print(f"Копия текущей базы сохранена: data/backups/{meta['name']}")
    print(f"  внутри: {meta['stats']}")
    DB_PATH.unlink()
    # journal/wal/shm-артефакты от прерванной транзакции — не переносим,
    # свежая init_db() их не ждёт.
    for suffix in ("-journal", "-wal", "-shm"):
        stray = DB_PATH.with_name(DB_PATH.name + suffix)
        if stray.exists():
            stray.unlink()


def main() -> int:
    if "--yes" not in sys.argv:
        print("Это ПОЛНОСТЬЮ пересоберёт базу данных. Текущая НЕ будет потеряна — перед пересборкой")
        print("снимается резервная копия в data/backups/, восстановить можно из интерфейса.")
        print("Но ВСЕ данные — элементы, статусы, контракты, пользователи — станут недоступны приложению.")
        answer = input("Продолжить? Введите 'да' для подтверждения: ")
        if answer.strip().lower() != "да":
            print("Отменено.")
            return 1

    _backup_existing_db()
    init_db()
    print("Схема создана заново.")
    import_input_dxf()
    import_input_xlsx()
    print(
        "Готово. Пользователь admin создан БЕЗ пароля — задайте его сейчас:\n"
        "    python3 scripts/reset_password.py admin"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

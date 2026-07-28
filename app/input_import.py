"""
Импорт всех файлов из Input/ — общая логика для обычного старта сервера
(app/main.py — только *.dxf, как и раньше) и полной пересборки БД
(scripts/rebuild_db.py, а также аварийного самовосстановления в
app/main.py — *.dxf + *.xlsx). Вынесено в отдельный модуль без зависимости
от FastAPI, чтобы автономные скрипты не тянули за собой конструирование
всего приложения ради пары функций.
"""

from pathlib import Path

from app.db import get_connection
from app.dxf_import import DxfProcessingError, process_upload
from app.contracting_import import ContractingImportError, import_contracting, parse_contracting_xlsx
from app.schedule_import import ScheduleImportError, import_schedule, parse_schedule_xlsx

INPUT_DIR = Path(__file__).resolve().parent.parent / "Input"


def _real_files(pattern: str):
    # "~$..." — временные lock-файлы Office/LibreOffice, остаются в папке,
    # пока сам файл открыт в приложении на чьём-то компьютере — не настоящие
    # чертежи/таблицы.
    if not INPUT_DIR.is_dir():
        return []
    return sorted(p for p in INPUT_DIR.glob(pattern) if not p.name.startswith("~$"))


def import_input_dxf() -> None:
    paths = _real_files("*.dxf")
    if not paths:
        print("Input/: чертежей (*.dxf) не найдено.")
        return
    for path in paths:
        try:
            result = process_upload(path, path.name)
            print(f"Input/{path.name}: {result.total} элементов ({result.inserted} новых, {result.updated} обновлено)")
        except DxfProcessingError as e:
            # Один битый/не подходящий файл не должен блокировать импорт
            # остальных — см. Docs/backlog.md.
            print(f"Input/{path.name}: ОШИБКА обработки — {e.message}")


def import_input_xlsx() -> None:
    """Маршрутизация по имени файла ('контрактац' → app/contracting_import.py,
    'прогноз'/'смр' → app/schedule_import.py) — угадывать формат по
    содержимому не пытаемся, риск не той таблицы у той же ошибки, что уже
    чинили в парсерах (см. Docs/backlog.md). Вызывать ПОСЛЕ import_input_dxf()
    — контрактации нужны уже загруженные марки, графику — уже привязанные
    к зонам/этажу элементы."""
    xlsx_files = _real_files("*.xlsx")
    contracting = [p for p in xlsx_files if "контрактац" in p.stem.lower()]
    schedule = [p for p in xlsx_files if "прогноз" in p.stem.lower() or "смр" in p.stem.lower()]
    unrouted = [p for p in xlsx_files if p not in contracting and p not in schedule]

    for path in contracting:
        conn = get_connection()
        try:
            parsed = parse_contracting_xlsx(path.read_bytes())
            summary = import_contracting(conn, parsed)
            print(f"Input/{path.name}: контрактация — {summary}")
        except ContractingImportError as e:
            print(f"Input/{path.name}: ОШИБКА импорта контрактации — {e.message}")
        finally:
            conn.close()

    for path in schedule:
        conn = get_connection()
        try:
            parsed = parse_schedule_xlsx(path.read_bytes())
            summary = import_schedule(conn, parsed)
            print(f"Input/{path.name}: график СМР — {summary}")
        except ScheduleImportError as e:
            print(f"Input/{path.name}: ОШИБКА импорта графика — {e.message}")
        finally:
            conn.close()

    for path in unrouted:
        print(
            f"Input/{path.name}: пропущен — имя не похоже ни на 'Контрактация', ни на "
            f"'Прогноз'/'СМР', не угадываю тип файла по содержимому."
        )

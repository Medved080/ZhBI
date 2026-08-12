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
from app.schedule_import import ScheduleImportError, import_schedule, parse_schedule_xlsx

INPUT_DIR = Path(__file__).resolve().parent.parent / "Input"


def _real_files(pattern: str):
    # "~$..." — временные lock-файлы Office/LibreOffice, остаются в папке,
    # пока сам файл открыт в приложении на чьём-то компьютере — не настоящие
    # чертежи/таблицы.
    if not INPUT_DIR.is_dir():
        return []
    return sorted(p for p in INPUT_DIR.glob(pattern) if not p.name.startswith("~$"))


def list_input_files() -> dict:
    """Что лежит в Input/ прямо сейчас — для диалога подтверждения перед
    импортом (пользователь должен видеть, ЧТО именно сейчас загрузится и
    какая геометрия будет перезаписана), а не только для самого импорта."""
    return {
        "dxf": [p.name for p in _real_files("*.dxf")],
        "xlsx": [p.name for p in _real_files("*.xlsx")],
    }


def import_input_dxf() -> list:
    """Возвращает построчный отчёт (он же печатается в лог). Отчёт нужен
    ручному запуску из интерфейса — там результат надо показать в диалоге,
    а не только в логе сервера, куда оператор не заглядывает."""
    report = []

    def say(line):
        print(line)
        report.append(line)

    paths = _real_files("*.dxf")
    if not paths:
        say("Input/: чертежей (*.dxf) не найдено.")
        return report
    for path in paths:
        try:
            result = process_upload(path, path.name)
            # Итоги СВЕРКИ здесь важны так же, как числа вставок: этот путь
            # неинтерактивный (решение З3 — обновляем существующие записи без
            # вопросов), поэтому единственное место, где пользователь увидит
            # исчезнувшие элементы и смену марок, — этот отчёт.
            extra = []
            if result.retired:
                extra.append(f"исчезло {result.retired}")
            if result.matched_by_geometry:
                extra.append(f"сопоставлено по геометрии {result.matched_by_geometry}")
            tail = f", {', '.join(extra)}" if extra else ""
            say(
                f"Input/{path.name}: {result.total} элементов "
                f"({result.inserted} новых, {result.updated} обновлено{tail})"
            )
        except DxfProcessingError as e:
            # Один битый/не подходящий файл не должен блокировать импорт
            # остальных — см. Docs/backlog.md.
            say(f"Input/{path.name}: ОШИБКА обработки — {e.message}")
    return report


def import_input_xlsx() -> list:
    """Маршрутизация по имени файла ('прогноз'/'смр' →
    app/schedule_import.py) — угадывать формат по содержимому не пытаемся,
    риск не той таблицы у той же ошибки, что уже чинили в парсерах (см.
    Docs/backlog.md). Вызывать ПОСЛЕ import_input_dxf() — графику нужны уже
    привязанные к зонам/этажу элементы. Возвращает построчный отчёт, см.
    import_input_dxf.

    Контрактация из папки НЕ грузится (2026-08-12, решение пользователя):
    её импорт требует явного выбора ОБЪЕКТА, а у пакетной загрузки спросить
    некого — договоры уезжали в базу без объекта и не принадлежали никакой
    стройке (см. шапку app/contracting_import.py). Файл с таким именем
    остаётся в папке и попадает в отчёт с указанием, через какую форму его
    грузить."""
    report = []

    def say(line):
        print(line)
        report.append(line)

    xlsx_files = _real_files("*.xlsx")
    contracting = [p for p in xlsx_files if "контрактац" in p.stem.lower()]
    schedule = [p for p in xlsx_files if "прогноз" in p.stem.lower() or "смр" in p.stem.lower()]
    unrouted = [p for p in xlsx_files if p not in contracting and p not in schedule]

    for path in contracting:
        say(
            f"Input/{path.name}: контрактация из папки не загружается — нужен явный выбор "
            f"объекта. Загрузите файл формой «Действия → Обмен данными → Импорт "
            f"контрактации из XLS»."
        )

    for path in schedule:
        conn = get_connection()
        try:
            parsed = parse_schedule_xlsx(path.read_bytes())
            summary = import_schedule(conn, parsed)
            say(f"Input/{path.name}: график СМР — {summary}")
        except ScheduleImportError as e:
            say(f"Input/{path.name}: ОШИБКА импорта графика — {e.message}")
        finally:
            conn.close()

    for path in unrouted:
        say(
            f"Input/{path.name}: пропущен — имя не похоже ни на 'Контрактация', ни на "
            f"'Прогноз'/'СМР', не угадываю тип файла по содержимому."
        )
    return report

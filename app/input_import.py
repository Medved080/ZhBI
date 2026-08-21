"""
Импорт всех файлов из Input/ — общая логика для обычного старта сервера
(app/main.py — только *.dxf, как и раньше) и полной пересборки БД
(scripts/rebuild_db.py, а также аварийного самовосстановления в
app/main.py — *.dxf + *.xlsx). Вынесено в отдельный модуль без зависимости
от FastAPI, чтобы автономные скрипты не тянули за собой конструирование
всего приложения ради пары функций.
"""

from pathlib import Path
from typing import Optional

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


def import_input_dxf(object_id: Optional[int] = None) -> list:
    """Возвращает построчный отчёт (он же печатается в лог). Отчёт нужен
    ручному запуску из интерфейса — там результат надо показать в диалоге,
    а не только в логе сервера, куда оператор не заглядывает.

    object_id — объект, в который грузятся ВСЕ чертежи пачки (2026-08-21,
    запрос пользователя). Спрашивается в форме, как и у загрузки чертежа по
    одному файлу. Пусто — прежнее поведение: объект выводит сам импорт, и
    при нескольких объектах в базе он откажет (см. ValueError ниже).

    Один объект на всю пачку, а не по объекту на файл: папка — это способ
    положить на сервер ОДИН тяжёлый чертёж, а не разложить стройку по
    зданиям; выбирать объект каждому файлу в отдельности значило бы
    диалог со списком файлов вместо одной строки выбора.
    """
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
            result = process_upload(path, path.name, object_id)
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
        except ValueError as e:
            # Объект не определился (resolve_import_object): в базе их
            # несколько, а форма объект не назвала — так бывает у вызова из
            # старого клиента и из scripts/rebuild_db.py. Ловится ОТДЕЛЬНО
            # от DxfProcessingError и ЗДЕСЬ ЖЕ, внутри цикла: до 2026-08-21
            # оно уходило наверх, и весь пакетный импорт отвечал 500
            # «Внутренняя ошибка сервера», не обработав ни одного
            # оставшегося файла. Теперь это обычная строка отчёта, как любой
            # другой отказ по конкретному файлу.
            say(f"Input/{path.name}: НЕ ЗАГРУЖЕН — {e} "
                f"Выберите объект в форме «Загрузка из папки Input».")
    return report


def import_input_xlsx(object_id: Optional[int] = None) -> list:
    """Маршрутизация по имени файла ('прогноз'/'смр' →
    app/schedule_import.py) — угадывать формат по содержимому не пытаемся,
    риск не той таблицы у той же ошибки, что уже чинили в парсерах (см.
    Docs/backlog.md). Вызывать ПОСЛЕ import_input_dxf() — графику нужны уже
    привязанные к зонам/этажу элементы. Возвращает построчный отчёт, см.
    import_input_dxf.

    object_id — тот же объект, что и у чертежей пачки (2026-08-21). Графику
    он нужен не меньше: без объекта import_schedule сопоставляет строки по
    ВСЕЙ базе, и со вторым зданием даты молча уезжают в чужой дом.

    Контрактация из папки НЕ грузится (2026-08-12, решение пользователя) —
    и с появлением выбора объекта это НЕ изменилось. Причина у неё другая,
    чем была у графика: файл контрактации приходит от снабжения и вполне
    может относиться к соседнему зданию, поэтому объект у него выбирается
    ОТДЕЛЬНО от объекта чертежей, своей формой (см. шапку
    app/contracting_import.py). Один общий выбор на пачку тут только
    маскировал бы ошибку. Файл с таким именем остаётся в папке и попадает в
    отчёт с указанием, через какую форму его грузить."""
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
            # Без объекта import_schedule сопоставляет строки по ВСЕЙ базе
            # (см. его docstring): пока здание одно — работает, со вторым
            # даты молча уезжают в чужой дом. Объект теперь спрашивается
            # формой (2026-08-21); если его всё-таки нет — а это возможно у
            # старого клиента и у scripts/rebuild_db.py — отказываем по тому
            # же правилу, что и контрактация, вместо тихой порчи дат.
            if object_id is None and conn.execute(
                    "SELECT COUNT(*) AS n FROM objects").fetchone()["n"] > 1:
                say(
                    f"Input/{path.name}: график СМР не загружен — не указан объект, а в базе "
                    f"их несколько: сопоставление по всей базе развезло бы даты по чужому "
                    f"зданию. Выберите объект в форме загрузки из папки Input либо загрузите "
                    f"файл формой «Действия → Обмен данными → Импорт графика MS Project из XLS»."
                )
                continue
            parsed = parse_schedule_xlsx(path.read_bytes())
            # kind по умолчанию — «базовый» (директивные даты). Актуализация
            # прогноза из папки не грузится: её вид выбирают осознанно, и
            # выбор этот не про объект, а про смысл файла.
            summary = import_schedule(conn, parsed, object_id=object_id,
                                      source_file=path.name)
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

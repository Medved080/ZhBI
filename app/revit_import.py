"""
Оркестрация загрузки пакетов Revit через веб-интерфейс.

Двухфазно, как импорт чертежа (решение И3): `analyze` разбирает и считает
сводку, `apply` применяет уже посчитанное по токену. Между фазами разбор
не повторяется — на АР это 25 тысяч элементов и 25 МБ JSON.

Отличие от `app/dxf_import.py`: принимается СПИСОК пакетов. Комплект — то,
что загрузили за один заход; один пакет = один раздел проекта (КР, АР), и
раздел задаёт ОБЛАСТЬ, внутри которой потом будет считаться «элемент исчез
из модели». Поэтому два пакета одного раздела в одном комплекте — ошибка,
а не повод молча взять последний.

Сейчас применяются только СПРАВОЧНИКИ (секции, этажи, реестр пакетов).
Элементы — следующий шаг; пакет уже разобран и лежит в памяти, менять
здесь ничего не придётся.
"""

import uuid

from app import revit_catalog
from app.revit_package import Package, PackageError, load

# Разобранные, но не применённые комплекты. В памяти процесса, а не в БД —
# по той же причине, что и у чертежей (app/dxf_import.py): это состояние
# одного пользователя, живущее минуты. Ограничение по числу записей: каждый
# комплект держит десятки мегабайт распакованного JSON, и трёх достаточно.
_PENDING = {}
_PENDING_LIMIT = 3


class RevitProcessingError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def parse_uploads(uploads) -> list:
    """uploads — список (имя файла, байты). Возвращает список Package."""
    if not uploads:
        raise RevitProcessingError(400, "Не приложено ни одного пакета выгрузки")

    packages = []
    for filename, data in uploads:
        try:
            package = load(data)
        except PackageError as e:
            raise RevitProcessingError(422, "%s: %s" % (filename, e))
        packages.append(package)

    by_section = {}
    for package in packages:
        by_section.setdefault(package.section_code, []).append(package)
    doubled = sorted(code for code, items in by_section.items() if len(items) > 1)
    if doubled:
        raise RevitProcessingError(
            422,
            "В одном комплекте несколько пакетов одного раздела: %s. Раздел "
            "задаёт область, внутри которой считается «элемент исчез из "
            "модели», поэтому раздел в комплекте может быть только один."
            % ", ".join(doubled),
        )

    return packages


def analyze(conn, object_id: int, packages) -> dict:
    """Фаза 1. В БД не пишет ничего."""
    analysis = revit_catalog.analyze(conn, object_id, packages)

    row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
    analysis["object_name"] = row["name"] if row else ""

    # Ранее загруженные разделы этого объекта — чтобы пользователь видел,
    # что он обновляет, а что добавляет впервые.
    analysis["known_sections"] = [
        {"раздел": r["section_code"], "модель": r["model"],
         "дата": r["exported_at"], "элементов": r["elements_count"]}
        for r in conn.execute(
            "SELECT section_code, model, exported_at, elements_count "
            "FROM revit_packages WHERE object_id = ? AND is_current = 1 "
            "ORDER BY section_code", (object_id,))
    ]

    # Выгрузка СТАРЕЕ уже загруженной — почти всегда значит, что человек
    # перепутал файл. Не запрет, но предупреждение видное.
    current = {r["раздел"]: r["дата"] for r in analysis["known_sections"]}
    for package in packages:
        was = current.get(package.section_code)
        if was and package.exported_at and package.exported_at < was:
            analysis["warnings"].append(
                "%s: выгрузка от %s СТАРШЕ уже загруженной (%s) — проверьте файл"
                % (package.section_code, package.exported_at, was))

    return analysis


def apply(conn, object_id: int, packages, analysis: dict) -> dict:
    """Фаза 2. Пока применяет только справочники и реестр пакетов."""
    return revit_catalog.apply(conn, object_id, packages, analysis)


def remember_pending(packages, analysis: dict) -> str:
    token = uuid.uuid4().hex
    _PENDING[token] = (packages, analysis)
    while len(_PENDING) > _PENDING_LIMIT:
        _PENDING.pop(next(iter(_PENDING)))
    return token


def get_pending(token: str) -> tuple:
    pending = _PENDING.get(token)
    if pending is None:
        raise RevitProcessingError(
            410,
            "Результат разбора уже недоступен (сервер перезапускался или "
            "разбор устарел). Загрузите пакеты заново.",
        )
    return pending


def forget_pending(token: str) -> None:
    _PENDING.pop(token, None)


def summary_for_log(analysis: dict) -> str:
    """Короткая строка для журнала и лога — читается без раскрытия сводки."""
    sections = analysis["sections"]
    levels = analysis["levels"]
    return ("разделов %d, новых секций %d, новых этажей %d, предупреждений %d"
            % (len(analysis["packages"]), len(sections["new"]),
               len(levels["new"]), len(analysis["warnings"])))

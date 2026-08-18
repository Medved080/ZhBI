#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Страж неопределённых имён (2026-08-18).

Python не проверяет имена до исполнения: обращение к несуществующей
переменной живёт в коде молча и падает NameError только когда в эту ветку
кто-то зайдёт. Так и вышло 08-14: при переходе на матрицу разделов в теле
проверок доступа подставили `assert_object_feature(..., kind)`, а параметр
в сигнатуре остался прежним — `minimum`. Обе функции падали на ПЕРВОМ ЖЕ
вызове при любой роли, но заходили в них только из формы контрагента —
и четыре дня, включая выкладку на тестовый сервер, справочник контрагентов
просто не открывался (`Docs/backlog.md` 2026-08-18).

Скрипт ищет этот класс ошибки по AST — не регуляркой и не глазами: для
каждой области видимости собираются связанные имена (аргументы,
присваивания, импорты, `for`/`with`/`except`, `global`/`nonlocal`,
вложенные def/class), после чего каждое имя, читаемое в этой области и
не найденное ни в ней, ни в объемлющих, ни среди встроенных, выводится
как находка. Правила областей видимости соблюдаются: замыкание видит
локальные имена объемлющей функции, а метод класса — НЕ видит имён тела
класса (их полагается брать через `self`/имя класса). Декораторы,
значения по умолчанию и аннотации проверяются в ОБЪЕМЛЮЩЕЙ области, как
их и вычисляет Python.

Находка — всегда ошибка (код возврата 1): в отличие от «пока не написано»
у стражей покрытия, здесь каждая строка это отложенный NameError.

    .venv/bin/python scripts/check_undefined_names.py
    .venv/bin/python scripts/check_undefined_names.py app/counterparties.py
    .venv/bin/python scripts/check_undefined_names.py --staged

Без аргументов проверяются `app/` и `scripts/` целиком. `--staged` — только
питоновские файлы из индекса git и ИМЕННО их проиндексированное содержимое:
в этом режиме скрипт зовёт git-хук `pre-commit` (ставится
`scripts/install_git_hooks.py`), и коммит с находкой не проходит. Разовый
обход — `git commit --no-verify`.

Чего скрипт НЕ ловит (осознанно, чтобы не поднимать ложных тревог):
имена, заводимые в обход синтаксиса — `globals()[...]`, `exec`, `setattr`
на модуль, — и модули со звёздным импортом (`from x import *`): что
именно оттуда пришло, по исходнику не узнать, такие файлы пропускаются с
предупреждением.
"""

import ast
import builtins
import subprocess
import sys
from pathlib import Path

КОРЕНЬ = Path(__file__).resolve().parent.parent
ПО_УМОЛЧАНИЮ = ("app", "scripts")

ВСТРОЕННЫЕ = set(dir(builtins)) | {
    "__file__", "__name__", "__doc__", "__package__", "__spec__", "__loader__",
    "__builtins__", "__debug__", "__class__",  # __class__ доступен внутри методов
}

ФУНКЦИИ = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
ОБЛАСТИ = ФУНКЦИИ + (ast.ClassDef,)


def _тело(узел):
    тело = узел.body
    return тело if isinstance(тело, list) else [тело]


def _узлы_области(узел):
    """Узлы тела области, БЕЗ спуска в тела вложенных функций и классов.

    Сама вложенная функция/класс выдаётся (её ИМЯ связывается здесь), а её
    тело разбирается отдельным вызовом — уже со своей областью видимости.
    """
    for предложение in _тело(узел):
        стек = [предложение]
        while стек:
            n = стек.pop()
            yield n
            if isinstance(n, ОБЛАСТИ):
                continue
            стек.extend(ast.iter_child_nodes(n))


def связанные(узел):
    """Имена, которые область связывает: параметры, присваивания, импорты и пр."""
    имена = set()
    if isinstance(узел, ФУНКЦИИ):
        for a in ast.walk(узел.args):
            if isinstance(a, ast.arg):
                имена.add(a.arg)
    for n in _узлы_области(узел):
        if isinstance(n, ОБЛАСТИ):
            имена.add(getattr(n, "name", "<lambda>"))
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for псевдоним in n.names:
                имена.add((псевдоним.asname or псевдоним.name).split(".")[0])
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            имена.add(n.id)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            имена.update(n.names)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            имена.add(n.name)
    return имена


def _проверить_имя(n, область, путь, находки, где):
    if n.id not in область and n.id not in ВСТРОЕННЫЕ:
        находки.append((путь, n.lineno, где, n.id))


def _обвязка(узел):
    """Декораторы, значения по умолчанию и аннотации — они вычисляются в
    ОБЪЕМЛЮЩЕЙ области, а не внутри самой функции/класса."""
    части = list(getattr(узел, "decorator_list", []))
    if isinstance(узел, ФУНКЦИИ):
        аргументы = узел.args
        части += [d for d in аргументы.defaults if d is not None]
        части += [d for d in аргументы.kw_defaults if d is not None]
        части += [a.annotation for a in ast.walk(аргументы)
                  if isinstance(a, ast.arg) and a.annotation is not None]
        if getattr(узел, "returns", None) is not None:
            части.append(узел.returns)
    if isinstance(узел, ast.ClassDef):
        части += list(узел.bases) + [k.value for k in узел.keywords]
    return части


def обойти(узел, внешняя, путь, находки, где):
    """Проверяет одну область видимости и рекурсивно — вложенные в неё."""
    своя = внешняя | связанные(узел)
    # Тело класса видит объемлющую область, а вложенные в него функции —
    # НЕТ: имена, заведённые в теле класса, методу доступны только через
    # self/имя класса. Поэтому детям класса отдаётся область, в которой
    # объявлен САМ класс, без его собственных имён. У функции наоборот:
    # замыкание видит её локальные имена, это и есть замыкание.
    для_детей = внешняя if isinstance(узел, ast.ClassDef) else своя
    for n in _узлы_области(узел):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            _проверить_имя(n, своя, путь, находки, где)
        elif isinstance(n, ОБЛАСТИ):
            имя = getattr(n, "name", "<lambda>")
            внутри = f"{где}.{имя}" if где else имя
            # Декораторы и значения по умолчанию — наоборот, вычисляются
            # ЗДЕСЬ, в том числе в теле класса (`def m(self, y=поле)` —
            # рабочий код), поэтому им отдаётся `своя`.
            for часть in _обвязка(n):
                for m in ast.walk(часть):
                    if isinstance(m, ast.Name) and isinstance(m.ctx, ast.Load):
                        _проверить_имя(m, своя, путь, находки, где or "<модуль>")
            обойти(n, для_детей, путь, находки, внутри)


def звёздный_импорт(дерево) -> bool:
    return any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names)
               for n in ast.walk(дерево))


def показать(путь: Path) -> str:
    """Путь относительно корня репозитория, если файл в нём (короче читается),
    иначе — как передали: проверять можно и файл со стороны."""
    try:
        return str(путь.relative_to(КОРЕНЬ))
    except ValueError:
        return str(путь)


def файлы(аргументы):
    цели = [Path(a) for a in аргументы] if аргументы else [КОРЕНЬ / d for d in ПО_УМОЛЧАНИЮ]
    for цель in цели:
        цель = цель if цель.is_absolute() else (КОРЕНЬ / цель)
        if цель.is_dir():
            yield from sorted(цель.rglob("*.py"))
        elif цель.suffix == ".py":
            yield цель


def проверить_исходник(исходник: str, показать_как: str, находки: list) -> bool:
    """Разбирает и проверяет ОДИН исходник. False — файл пропущен (звёздный
    импорт). Текст отдельно от файла нужен хуку: он читает не рабочую копию,
    а проиндексированное содержимое (`git show :файл`)."""
    try:
        дерево = ast.parse(исходник, filename=показать_как)
    except SyntaxError as e:
        находки.append((показать_как, e.lineno or 0, "<разбор>", f"файл не разбирается: {e.msg}"))
        return True
    if звёздный_импорт(дерево):
        return False
    обойти(дерево, ВСТРОЕННЫЕ, показать_как, находки, "")
    return True


def проиндексированные():
    """Питоновские файлы в индексе git и их СОДЕРЖИМОЕ ИЗ ИНДЕКСА.

    Именно из индекса, а не из рабочей копии: коммитится проиндексированное,
    и при частичном `git add -p` рабочая копия может быть и лучше, и хуже
    того, что уедет в историю.
    """
    имена = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM", "-z", "--", "*.py"],
        cwd=КОРЕНЬ, capture_output=True, text=True, check=True,
    ).stdout.split("\0")
    for имя in filter(None, имена):
        исходник = subprocess.run(
            ["git", "show", f":{имя}"], cwd=КОРЕНЬ,
            capture_output=True, text=True, check=True,
        ).stdout
        yield имя, исходник


def main(аргументы) -> int:
    находки = []
    пропущено = []
    проверено = 0
    из_индекса = "--staged" in аргументы
    аргументы = [a for a in аргументы if a != "--staged"]

    if из_индекса:
        for имя, исходник in проиндексированные():
            if проверить_исходник(исходник, имя, находки):
                проверено += 1
            else:
                пропущено.append(КОРЕНЬ / имя)
        if not проверено and not пропущено:
            return 0            # питоновских файлов в коммите нет — молчим
        print(f"Проверено файлов в индексе: {проверено}")
    else:
        for путь in файлы(аргументы):
            if проверить_исходник(путь.read_text(encoding="utf-8"), показать(путь), находки):
                проверено += 1
            else:
                пропущено.append(путь)
        print(f"Проверено файлов: {проверено}")
    if пропущено:
        print(f"Пропущено из-за звёздного импорта: {len(пропущено)}")
        for путь in пропущено:
            print(f"  · {показать(путь)}")

    if not находки:
        print("\nНеопределённых имён не найдено.")
        return 0

    print(f"\nНЕОПРЕДЕЛЁННЫЕ ИМЕНА — {len(set(находки))}:")
    for путь, строка, где, имя in sorted(set(находки)):
        print(f"  ✗ {путь}:{строка}  в {где or '<модуль>'}: имя «{имя}» нигде не определено")
    print("\nКаждая строка — отложенный NameError: код упадёт, когда в эту ветку "
          "кто-нибудь зайдёт. Так и было с проверками доступа 08-14 "
          "(см. Docs/backlog.md 2026-08-18).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

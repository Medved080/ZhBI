#!/usr/bin/env python3
"""
Страж полноты реестра действий журнала (`app/activity_actions.py`).

Зачем. У каждого события журнала должна быть русская подпись и категория:
без них событие показывается голым кодом и выпадает из фильтра по
категории — то есть выглядит как «оно не пишется» (живой репорт
2026-08-06 про голые коды, вопрос 2026-08-20 про ошибки). Забыть строку в
реестре при добавлении нового действия проще всего, поэтому проверка
машинная и стоит в git-хуке pre-commit
(`scripts/install_git_hooks.py`).

Как ищет. Коды собираются ПО AST, а не регуляркой (стоячая инструкция
CLAUDE.md): вызовы `activity.log("код", ...)` в `app/` и `scripts/`,
включая тернарный выбор кода (`"release_task" if ok else
"release_task_failed"`). Два места кода не литеральны и разобраны
отдельно:

  * `app/auth.py::_log_login` — код приходит параметром, поэтому берутся
    строки из вызовов самой `_log_login`;
  * клиент (`app/static/app.js`) — коды из `logClientEvent`/`startTiming`.

Запуск: `.venv/bin/python scripts/check_activity_actions.py`
Код возврата 1 — есть коды без строки в реестре.
"""

import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.activity_actions import ACTIONS  # noqa: E402


def _literal_codes(node: ast.AST) -> list:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return _literal_codes(node.body) + _literal_codes(node.orelse)
    return []


def collect() -> dict:
    """код → где встретился (первое место, для сообщения об ошибке)."""
    found = {}
    for path in sorted(list((ROOT / "app").rglob("*.py")) + list((ROOT / "scripts").rglob("*.py"))):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue  # разбором синтаксиса занят другой страж
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            вызов_журнала = (
                isinstance(func, ast.Attribute) and func.attr == "log"
                and isinstance(func.value, ast.Name) and func.value.id == "activity"
            )
            вызов_входа = isinstance(func, ast.Name) and func.id == "_log_login"
            if not (вызов_журнала or вызов_входа) or not node.args:
                continue
            for code in _literal_codes(node.args[0]):
                found.setdefault(code, f"{path.relative_to(ROOT)}:{node.lineno}")

    js = (ROOT / "app" / "static" / "app.js").read_text(encoding="utf-8")
    for code in re.findall(r'(?:logClientEvent|startTiming)\(\s*"([^"]+)"', js):
        found.setdefault(code, "app/static/app.js")
    return found


def main() -> int:
    found = collect()
    пропущены = {code: where for code, where in found.items() if code not in ACTIONS}
    if пропущены:
        print("В app/activity_actions.py нет строки для действий журнала:")
        for code, where in sorted(пропущены.items()):
            print(f"  {code}   ← {where}")
        print("\nДобавьте: \"код\": (\"Русская подпись\", КАТЕГОРИЯ),")
        return 1
    print(f"Реестр действий журнала полон: {len(found)} кодов найдено в коде, "
          f"{len(ACTIONS)} описано.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

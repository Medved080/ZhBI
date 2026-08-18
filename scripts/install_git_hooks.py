#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Установка git-хуков проекта (2026-08-18).

Хуки живут в `.git/hooks`, а этот каталог git НЕ версионирует: у нового
клона (и у второй сессии в отдельном worktree) хуков не будет, пока их туда
не положат. Поэтому исходники хуков лежат в `scripts/git-hooks/` — в
репозитории, под ревью, — а этот скрипт раскладывает их по месту.

    .venv/bin/python scripts/install_git_hooks.py
    .venv/bin/python scripts/install_git_hooks.py --check   # только проверить

Что ставится:

  * `pre-commit` — страж неопределённых имён (`scripts/check_undefined_names.py
    --staged`): обращение к имени, которого нет, в коммит не проходит.

Копия, а не симлинк: симлинк из `.git` наружу переживает не всякий git-клиент
и не всякий worktree, а хук — вещь, которая должна работать молча и всегда.
Уже стоящий чужой хук НЕ затирается: скрипт скажет, что нашёл, и остановится
— решать, что с ним делать, человеку.
"""

import filecmp
import shutil
import subprocess
import sys
from pathlib import Path

КОРЕНЬ = Path(__file__).resolve().parent.parent
ИСТОЧНИК = КОРЕНЬ / "scripts" / "git-hooks"
ХУКИ = ("pre-commit",)


def каталог_хуков() -> Path:
    """Настоящий каталог хуков: в worktree `.git` — файл-указатель, а не
    каталог, поэтому спрашиваем сам git, а не собираем путь руками."""
    путь = subprocess.run(
        ["git", "rev-parse", "--git-path", "hooks"],
        cwd=КОРЕНЬ, capture_output=True, text=True, check=True,
    ).stdout.strip()
    каталог = Path(путь)
    return каталог if каталог.is_absolute() else (КОРЕНЬ / каталог)


def main(аргументы) -> int:
    только_проверить = "--check" in аргументы
    назначение = каталог_хуков()
    назначение.mkdir(parents=True, exist_ok=True)

    не_поставлено = []
    for имя in ХУКИ:
        откуда = ИСТОЧНИК / имя
        куда = назначение / имя
        if not откуда.exists():
            print(f"✗ нет исходника хука: {откуда.relative_to(КОРЕНЬ)}")
            не_поставлено.append(имя)
            continue

        if куда.exists() and filecmp.cmp(откуда, куда, shallow=False):
            print(f"· {имя}: уже стоит и совпадает")
            continue

        if куда.exists() and not только_проверить:
            наш = "check_undefined_names" in куда.read_text(encoding="utf-8", errors="replace")
            if not наш:
                print(f"✗ {имя}: на месте ЧУЖОЙ хук — не трогаю. Посмотрите {куда} "
                      f"и слейте руками с {откуда.relative_to(КОРЕНЬ)}")
                не_поставлено.append(имя)
                continue

        if только_проверить:
            print(f"✗ {имя}: не поставлен или устарел")
            не_поставлено.append(имя)
            continue

        shutil.copyfile(откуда, куда)
        куда.chmod(0o755)
        print(f"✓ {имя}: поставлен в {куда}")

    if не_поставлено:
        if только_проверить:
            print("\nПоставить: .venv/bin/python scripts/install_git_hooks.py")
        return 1
    print("\nХуки на месте. Разовый обход, когда действительно надо: "
          "git commit --no-verify")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

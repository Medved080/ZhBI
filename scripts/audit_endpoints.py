"""
Инвентаризация HTTP-эндпоинтов: что стоит на входе каждого и сужается ли
выборка по объекту.

Зачем скриптом, а не проходом глазами. Аудиты 2026-07-23 и 2026-08-03
были разовыми ручными проходами, и за сутки после второго в `app/main.py`
добавилось пять новых роутов. Ручной проход устаревает в день, когда
закончен; список, который пересобирается командой, — нет.

Почему AST, а не регулярка (обе ошибки уже совершены, см.
`Docs/backlog.md`): регулярка нашла 11 защищённых эндпоинтов из 54, а
первая AST-версия объявила десять защищённых отчётов незащищёнными —
искала имя функции, которого нет. Поэтому здесь:

  * проверки ищутся НЕ только в сигнатуре (`Depends(...)`), но и в теле,
    и ТРАНЗИТИВНО — `_guard_elements` не содержит слова
    «assert_object_access», она его вызывает;
  * скрипт сверяет сам себя (`--self-check` включён по умолчанию):
    число роутов, найденных разбором, сравнивается с числом строк-
    декораторов, найденных текстом. Разошлись — значит разбор что-то
    пропустил, и об этом сказано громко, а не молча занижен отчёт.

Запуск:
    .venv/bin/python scripts/audit_endpoints.py
    .venv/bin/python scripts/audit_endpoints.py --only «только вход»
    .venv/bin/python scripts/audit_endpoints.py --json

Код возврата 1 — найден роут без проверки входа, которого нет в списке
намеренно публичных. Годится как шаг CI.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}

# Зависимости, само присутствие которых доказывает «без входа нельзя».
AUTH_DEPS = {
    "get_current_user",
    "require_system_admin",
    # С 2026-08-14 проверка адресуется РАЗДЕЛОМ, а не именем роли: зависимость
    # собирается фабрикой прямо в сигнатуре — `Depends(require_feature("zones",
    # "write"))`. Без этих двух имён все переведённые роуты уехали бы в «без
    # проверки входа»: их прежние require_object_* больше не встречаются.
    "require_feature",
    "require_any_feature",
    "require_service_feature",
    "require_contracting",
}

# Проверки уровня «ведение сервиса»: доступ ко всем стройкам разом.
# Проверки без объекта: администратор сервиса либо роль не ниже порога ХОТЯ
# БЫ НА ОДНОМ доступном объекте (общесервисные разделы — контрагенты,
# пользователи, копии). Обе решают доступ ко всей стройке разом.
SYSTEM_ADMIN = {"require_system_admin", "is_system_admin", "require_service_feature",
                "require_contracting"}

# Всё, чем выборка сужается до объекта либо проверяется право на объект.
OBJECT_SCOPE = {
    "assert_object_access",
    "assert_object_feature",
    "has_object_access",
    "has_feature",
    "has_any_feature",
    "assert_object_any_feature",
    "feature_level_for",
    "accessible_object_ids",
    "object_role",
    "object_roles",
    "object_role_keys",
    "require_feature",
    "require_any_feature",
}

# Намеренно публичные адреса. Список короткий и явный: любое пополнение —
# осознанное решение, а не молчаливое исключение из отчёта.
PUBLIC_BY_DESIGN = {
    ("POST", "/login"),
    ("POST", "/logout"),
    ("GET", "/health"),
    ("GET", "/login-users"),  # под флагом ZHBI_PUBLIC_LOGIN_LIST, см. CLAUDE.md
    ("GET", "/"),
}

ВЕРДИКТ_ПУБЛИЧНЫЙ = "БЕЗ ПРОВЕРКИ ВХОДА"
ВЕРДИКТ_ОБЪЕКТ = "объект проверяется"
ВЕРДИКТ_СИСТЕМНЫЙ = "системный админ"
ВЕРДИКТ_ТОЛЬКО_ВХОД = "только вход"
ВЕРДИКТ_ПУБЛИЧНЫЙ_ОК = "публичный намеренно"


class Инвентарь:
    def __init__(self) -> None:
        # Имя функции → множество имён, которые она вызывает. Разрешение по
        # ИМЕНИ, а не по модулю: импорты в проекте прямые (`from app.access
        # import assert_object_access`), и одноимённых функций с разным
        # смыслом нет — проверено self-check'ом на дублирующиеся имена.
        self.вызовы: dict[str, set[str]] = {}
        self.определения: dict[str, list[str]] = {}
        self.роуты: list[dict] = []

    # ------------------------------------------------------------ разбор
    def разобрать_файл(self, путь: Path) -> None:
        дерево = ast.parse(путь.read_text(encoding="utf-8"), filename=str(путь))

        # Префикс роутера задаётся при создании (`APIRouter(prefix="/users")`),
        # без него отчёт печатает `/{user_id}/set-password` — адрес, которого
        # в сервисе нет, и найти его глазами в списке невозможно.
        префикс = ""
        for узел in дерево.body:
            if isinstance(узел, ast.Assign) and isinstance(узел.value, ast.Call):
                имя_фабрики = getattr(узел.value.func, "id", getattr(узел.value.func, "attr", ""))
                if имя_фабрики == "APIRouter":
                    for kw in узел.value.keywords:
                        if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                            префикс = kw.value.value

        # Проверки бывают не только `def`, но и результатом фабрики:
        # `require_object_access = _object_dependency("view")`. Без этой
        # ветки такие имена «не найдены в коде», и все закрытые ими роуты
        # уехали бы в «без проверки» — самопроверка ровно это и поймала.
        for узел in дерево.body:
            if isinstance(узел, ast.Assign) and isinstance(узел.value, ast.Call):
                for цель in узел.targets:
                    if isinstance(цель, ast.Name):
                        self.определения.setdefault(цель.id, []).append(путь.name)
                        self.вызовы.setdefault(цель.id, set()).update(
                            _вызванные_имена(узел.value)
                        )

        for узел in ast.walk(дерево):
            if isinstance(узел, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.определения.setdefault(узел.name, []).append(путь.name)
                self.вызовы.setdefault(узел.name, set()).update(_вызванные_имена(узел))
                маршрут = _маршрут_из_декораторов(узел)
                if маршрут:
                    метод, путь_url = маршрут
                    self.роуты.append(
                        {
                            "метод": метод,
                            "путь": (префикс + путь_url) or "/",
                            "модуль": путь.name,
                            "функция": узел.name,
                            "строка": узел.lineno,
                            "зависимости": sorted(_зависимости_сигнатуры(узел)),
                        }
                    )

    # ------------------------------------------------- транзитивный обход
    def достижимые(self, старт: set[str]) -> set[str]:
        """Все имена, до которых можно дойти по вызовам от точки входа.

        Именно здесь ломалась прошлая версия: проверка часто стоит не в
        обработчике, а в помощнике, которого он зовёт (`_guard`,
        `_guard_elements`, `_my_work_scope`).
        """
        видели: set[str] = set()
        очередь = list(старт)
        while очередь:
            имя = очередь.pop()
            if имя in видели:
                continue
            видели.add(имя)
            очередь.extend(self.вызовы.get(имя, ()))
        return видели

    def оценить(self) -> None:
        for роут in self.роуты:
            старт = {роут["функция"], *роут["зависимости"]}
            достижимо = self.достижимые(старт)
            есть_вход = bool(достижимо & AUTH_DEPS)
            есть_объект = bool(достижимо & OBJECT_SCOPE)
            есть_система = bool(достижимо & SYSTEM_ADMIN)

            if not есть_вход:
                вердикт = (
                    ВЕРДИКТ_ПУБЛИЧНЫЙ_ОК
                    if (роут["метод"], роут["путь"]) in PUBLIC_BY_DESIGN
                    else ВЕРДИКТ_ПУБЛИЧНЫЙ
                )
            elif есть_объект:
                вердикт = ВЕРДИКТ_ОБЪЕКТ
            elif есть_система:
                вердикт = ВЕРДИКТ_СИСТЕМНЫЙ
            else:
                вердикт = ВЕРДИКТ_ТОЛЬКО_ВХОД
            роут["вердикт"] = вердикт
            роут["проверки"] = sorted(достижимо & (AUTH_DEPS | OBJECT_SCOPE | SYSTEM_ADMIN))


def _вызванные_имена(узел: ast.AST) -> set[str]:
    имена: set[str] = set()
    for под in ast.walk(узел):
        if isinstance(под, ast.Call):
            цель = под.func
            if isinstance(цель, ast.Name):
                имена.add(цель.id)
            elif isinstance(цель, ast.Attribute):
                имена.add(цель.attr)
    return имена


def _маршрут_из_декораторов(узел) -> tuple[str, str] | None:
    """`@app.post("/login")` / `@router.get("/zones/{id}")` → ('POST', ...).

    Имя объекта (app/router/что угодно) намеренно не проверяется: роутеры
    в проекте называются по-разному, а привязка к именам — ровно тот
    способ, которым прошлая версия скрипта потеряла половину отчётов.
    """
    for дек in узел.decorator_list:
        if not isinstance(дек, ast.Call) or not isinstance(дек.func, ast.Attribute):
            continue
        if дек.func.attr not in HTTP_METHODS:
            continue
        if дек.args and isinstance(дек.args[0], ast.Constant) and isinstance(дек.args[0].value, str):
            return дек.func.attr.upper(), дек.args[0].value
    return None


def _зависимости_сигнатуры(узел) -> set[str]:
    """Имена X из `= Depends(X)` в аргументах обработчика."""
    имена: set[str] = set()
    аргументы = узел.args
    for значение in list(аргументы.defaults) + [d for d in аргументы.kw_defaults if d]:
        if (
            isinstance(значение, ast.Call)
            and isinstance(значение.func, ast.Name)
            and значение.func.id == "Depends"
            and значение.args
        ):
            цель = значение.args[0]
            if isinstance(цель, ast.Name):
                имена.add(цель.id)
            elif isinstance(цель, ast.Attribute):
                имена.add(цель.attr)
    return имена


def самопроверка(инв: Инвентарь, файлы: list[Path]) -> list[str]:
    """Сверка разбора с независимым способом счёта. Молчать нельзя."""
    претензии: list[str] = []

    образец = re.compile(r"^\s*@[\w.]+\.(" + "|".join(HTTP_METHODS) + r")\s*\(", re.M)
    текстом = sum(len(образец.findall(п.read_text(encoding="utf-8"))) for п in файлы)
    if текстом != len(инв.роуты):
        претензии.append(
            f"Разбор нашёл {len(инв.роуты)} роутов, текстовый счёт декораторов — {текстом}. "
            "Разбор что-то пропустил (или посчитал лишнее) — отчёту нельзя верить, "
            "пока расхождение не объяснено."
        )

    дубли = {и: ф for и, ф in инв.определения.items() if len(ф) > 1 and и in (AUTH_DEPS | OBJECT_SCOPE | SYSTEM_ADMIN)}
    if дубли:
        претензии.append(
            "Имена проверок определены больше одного раза — разрешение по имени "
            f"может врать: {дубли}"
        )

    ненайденные = (AUTH_DEPS | OBJECT_SCOPE | SYSTEM_ADMIN) - set(инв.определения)
    if ненайденные:
        претензии.append(
            f"Проверки из списка не найдены в коде вовсе: {sorted(ненайденные)}. "
            "Скорее всего переименованы — список в скрипте устарел, и роуты "
            "будут помечены незащищёнными без причины."
        )
    return претензии


def main() -> int:
    парсер = argparse.ArgumentParser(description=__doc__)
    парсер.add_argument("--json", action="store_true", help="машинный вывод")
    парсер.add_argument("--only", help="показать только один вердикт")
    парсер.add_argument("--no-self-check", action="store_true")
    аргументы = парсер.parse_args()

    файлы = sorted(APP_DIR.glob("*.py"))
    инв = Инвентарь()
    for путь in файлы:
        инв.разобрать_файл(путь)
    инв.оценить()

    претензии = [] if аргументы.no_self_check else самопроверка(инв, файлы)

    if аргументы.json:
        print(json.dumps({"routes": инв.роуты, "self_check": претензии},
                         ensure_ascii=False, indent=2))
    else:
        if претензии:
            print("САМОПРОВЕРКА НЕ ПРОЙДЕНА:")
            for п in претензии:
                print(f"  ! {п}")
            print()

        порядок = [ВЕРДИКТ_ПУБЛИЧНЫЙ, ВЕРДИКТ_ТОЛЬКО_ВХОД, ВЕРДИКТ_СИСТЕМНЫЙ,
                   ВЕРДИКТ_ОБЪЕКТ, ВЕРДИКТ_ПУБЛИЧНЫЙ_ОК]
        for вердикт in порядок:
            группа = [р for р in инв.роуты if р["вердикт"] == вердикт]
            if not группа or (аргументы.only and аргументы.only != вердикт):
                continue
            print(f"\n=== {вердикт} — {len(группа)} ===")
            for р in sorted(группа, key=lambda r: (r["модуль"], r["путь"])):
                проверки = ", ".join(р["проверки"]) or "—"
                print(f"  {р['метод']:6} {р['путь']:<46} {р['модуль']}:{р['строка']}")
                print(f"         {р['функция']}()  ←  {проверки}")

        print(f"\nВсего роутов: {len(инв.роуты)}")
        for вердикт in порядок:
            n = sum(1 for р in инв.роуты if р["вердикт"] == вердикт)
            if n:
                print(f"  {вердикт}: {n}")

    беззащитные = [р for р in инв.роуты if р["вердикт"] == ВЕРДИКТ_ПУБЛИЧНЫЙ]
    return 1 if (беззащитные or претензии) else 0


if __name__ == "__main__":
    raise SystemExit(main())

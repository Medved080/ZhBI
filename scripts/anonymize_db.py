"""
Обезличенная копия боевой БД для отладки и живой браузерной проверки.

Зачем: при работе над проектом с ассистентом (Claude Code) всё, что
попадает в контекст — содержимое файлов, вывод команд, скриншоты
интерфейса — уходит на сторонние серверы. Реквизиты заказчика
(контрагенты, номера договоров, ФИО, названия объектов, кадастровые
номера, имена файлов чертежей) при этом выносятся за корпоративный
контур. Скрипт делает копию БД, в которой таких реквизитов нет, а вся
рабочая нагрузка сохранена: геометрия, контуры, отметки, зоны, статусы,
история, количества, связи — то, на чём держится отладка.

Что СОХРАНЯЕТСЯ намеренно (и почему это осознанный остаточный риск):
  * координаты, контуры, отметки, сетка осей — без них не отлаживаются
    ни привязка к зонам, ни 3D, ни наклейки марок. Это, по сути, само
    здание: обезличивание реквизитов его не прячет;
  * марки изделий (`15КС1.1` и т.п.) — на их форме держатся
    `mark_type_prefixes`, `FLAT_MARK_TYPES` и разбор подтипов;
  * даты договоров/спецификаций и все даты поставки — на них держится
    вся отчётность и «График поставки».
Если этого недостаточно для режима коммерческой тайны — обезличенной
копии мало, работать надо на синтетике
(`scripts/generate_test_zones_dxf.py`).

Запуск:
    .venv/bin/python scripts/anonymize_db.py
    .venv/bin/python scripts/anonymize_db.py --source data/zhbi.db \
        --out data/zhbi.anon.db --map data/zhbi.anon.map.json

Скрипт НИКОГДА не печатает исходные значения — только количества и
подставленные псевдонимы: его собственный вывод тоже попадает в контекст
ассистента.
"""

# Аннотации откладываются: в venv проекта Python 3.9, где `str | None`
# в сигнатуре вычисляется на импорте и падает.
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Текст-заглушка для свободных комментариев. Одинаковой длины у всех —
# длина исходного комментария сама по себе ничего не выдаёт, а
# одинаковый текст сразу видно на экране как «здесь было скрыто».
COMMENT_PLACEHOLDER = "комментарий скрыт при обезличивании"

# Кадастровый номер — единственный формат, который встречается в
# свободных полях (карточка проекта) и который надо ловить отдельно:
# он не значение справочника, по списку подстановок его не найти.
CADASTRE_RE = re.compile(r"\b\d{2}:\d{2}:\d{6,7}:\d+\b")


class Mapping:
    """Копит соответствия «исходное значение → псевдоним».

    Нужен двум потребителям: файлу карты (остаётся у пользователя, в git
    не уходит) и финальной проверке на утечки — она ищет в готовой копии
    ровно те строки, которые мы обязались убрать.
    """

    def __init__(self) -> None:
        self.groups: dict[str, dict[str, str]] = {}

    def put(self, group: str, original, replacement: str) -> str:
        if original is None:
            return replacement
        original = str(original)
        if original.strip():
            self.groups.setdefault(group, {})[original] = replacement
        return replacement

    def all_pairs(self) -> list[tuple[str, str]]:
        """Все пары «исходное → псевдоним» разом, для точечной замены в
        свободном тексте (не в структурированных полях, а внутри строки —
        например, Revit-параметры, где заранее не угадать, какой именно
        ключ несёт название стройки). Тот же фильтр длины/совпадения, что
        у `needles()`; при коллизии оригинала между группами остаётся
        первый найденный псевдоним — для удаления утечки неважно, какой
        именно, лишь бы оригинал пропал из текста."""
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for pairs in self.groups.values():
            for original, replacement in pairs.items():
                if original == replacement or len(original.strip()) < 3:
                    continue
                if original in seen:
                    continue
                seen.add(original)
                out.append((original, replacement))
        return out

    def needles(self) -> list[tuple[str, str]]:
        """Пары «откуда значение → само значение» для проверки на утечки.

        Совпадения оригинала с псевдонимом отбрасываются: логин
        единственного администратора так и остаётся `admin`, и искать
        «admin» по всей базе — гарантированное ложное срабатывание на
        колонке ролей.
        """
        out: list[tuple[str, str]] = []
        for group, pairs in self.groups.items():
            for original, replacement in pairs.items():
                if original != replacement and len(original.strip()) >= 3:
                    out.append((group, original))
        return out

    def to_json(self) -> str:
        return json.dumps(self.groups, ensure_ascii=False, indent=2, sort_keys=True)


# Дата в JSON-настройках (контрольные сроки карточки объекта, даты вех).
# Такие листья НЕ затираются — см. _blank_json_strings.
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T].*)?$")


def _blank_json_strings(raw: str | None, placeholder: str = "скрыто") -> str | None:
    """Заменяет все строковые ЛИСТЬЯ в JSON, сохраняя структуру.

    Настройки хранятся JSON-ом в одной колонке (`app_settings.value`,
    `report_notes.key_events`): выбрасывать значение целиком нельзя —
    форма перестанет открываться, а структура ключей сама по себе не
    секрет.

    ДАТЫ при этом остаются как есть (2026-08-03). Раньше затирались и они:
    в карточке объекта `montage_deadline`, `delivery_deadline` и даты вех
    превращались в «скрыто», и отчёт «Динамика» на обезличенной копии падал
    с 500 — `date.fromisoformat('скрыто')`. Причём падал ЛЮБОЙ его вызов,
    то есть отладить отчёт на копии было нельзя вовсе. Секрета в контрольном
    сроке нет: даты поставок и монтажа в копии и так настоящие (см. CLAUDE.md
    — геометрия, отметки, марки и даты оставлены реальными намеренно),
    секретно название стройки, а не то, когда её сдают.
    """
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return placeholder

    def walk(node):
        if isinstance(node, str):
            if not node.strip() or _ISO_DATE.match(node.strip()):
                return node
            return placeholder
        if isinstance(node, list):
            return [walk(x) for x in node]
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        return node

    return json.dumps(walk(data), ensure_ascii=False)


def anonymize(conn: sqlite3.Connection, mapping: Mapping) -> dict[str, int]:
    stats: dict[str, int] = {}

    def count(table: str, n: int) -> None:
        stats[table] = n

    # ------------------------------------------------------------ люди
    # Пользователей обрабатываем первыми: их псевдонимы нужны дальше
    # в снимках ФИО (`status_history.changed_by`, `activity_log`,
    # `attachments.uploaded_by`, `report_notes.updated_by`), которые
    # хранятся текстом и по user_id не восстанавливаются.
    user_names: dict[int, str] = {}
    rows = conn.execute(
        "SELECT id, last_name, first_name, patronymic, position, department,"
        " domain_login, role FROM users ORDER BY id"
    ).fetchall()
    admin_taken = False
    for n, row in enumerate(rows, start=1):
        uid = row["id"]
        last = mapping.put("users.last_name", row["last_name"], f"Фамилия{n}")
        first = mapping.put("users.first_name", row["first_name"], f"Имя{n}")
        patronymic = (
            mapping.put("users.patronymic", row["patronymic"], f"Отчество{n}")
            if row["patronymic"]
            else None
        )
        if row["role"] == "admin" and not admin_taken:
            login, admin_taken = "admin", True
        else:
            login = f"user{n}"
        mapping.put("users.domain_login", row["domain_login"], login)
        if row["position"]:
            mapping.put("users.position", row["position"], "Должность")
        if row["department"]:
            mapping.put("users.department", row["department"], "Отдел")
        conn.execute(
            "UPDATE users SET last_name=?, first_name=?, patronymic=?,"
            " position=?, department=?, domain_login=?,"
            " password_hash=NULL, password_salt=NULL WHERE id=?",
            (
                last,
                first,
                patronymic,
                "Должность" if row["position"] else row["position"],
                "Отдел" if row["department"] else row["department"],
                login,
                uid,
            ),
        )
        # Снимок ФИО в истории пишется как «Фамилия И.О.» либо целиком —
        # держим обе формы, ниже подставляем по user_id, а остатки без
        # user_id заменяем общей заглушкой.
        user_names[uid] = f"{last} {first}"
    count("users", len(rows))

    # Сессии — это живые токены доступа. Обезличивать нечего, копия
    # должна начинаться с пустого списка сессий.
    stats["sessions (удалено)"] = conn.execute("DELETE FROM sessions").rowcount

    def scrub_person(table: str, column: str, id_column: str | None) -> int:
        """Снимок ФИО: по user_id — псевдоним владельца, иначе заглушка."""
        n = 0
        # `rowid` обязателен с явным псевдонимом: если у таблицы есть
        # INTEGER PRIMARY KEY, SQLite возвращает колонку под ЕГО именем
        # (`id`), и обращение по «rowid» падает.
        sql = f"SELECT rowid AS rid, {column}" + (f", {id_column}" if id_column else "")
        for row in conn.execute(f"{sql} FROM {table} WHERE {column} IS NOT NULL").fetchall():
            uid = row[id_column] if id_column else None
            replacement = user_names.get(uid, "Пользователь")
            mapping.put(f"{table}.{column}", row[column], replacement)
            conn.execute(f"UPDATE {table} SET {column}=? WHERE rowid=?", (replacement, row["rid"]))
            n += 1
        return n

    count(
        "status_history.changed_by",
        scrub_person("status_history", "changed_by", "changed_by_user_id"),
    )
    count("activity_log.user_name", scrub_person("activity_log", "user_name", "user_id"))
    count(
        "attachments.uploaded_by",
        scrub_person("attachments", "uploaded_by", "uploaded_by_user_id"),
    )
    count("report_notes.updated_by", scrub_person("report_notes", "updated_by", None))
    count(
        "activity_log.impersonator_name",
        scrub_person("activity_log", "impersonator_name", "impersonator_user_id"),
    )
    count(
        "supplier_change_docs.created_by",
        scrub_person("supplier_change_docs", "created_by", "created_by_user_id"),
    )
    count(
        "supplier_change_docs.posted_by",
        scrub_person("supplier_change_docs", "posted_by", "posted_by_user_id"),
    )

    # ----------------------------------------------- юридическая цепочка
    rows = conn.execute("SELECT * FROM counterparties ORDER BY id").fetchall()
    for n, row in enumerate(rows, start=1):
        # Пустое поле остаётся пустым: подставленный в NULL реквизит
        # выглядел бы как заполненный и сбивал бы отладку форм.
        fields = {
            "full_name": f"ООО «Контрагент-{n:02d}»",
            "short_name": f"Контрагент-{n:02d}",
            "code": f"КА{n:02d}",
            "inn": f"{7700000000 + n:010d}",
            "kpp": f"{770000000 + n:09d}",
            "ogrn": f"{1027700000000 + n:013d}",
            "legal_address": f"г. Город, ул. Тестовая, д. {n}",
            "contact_person": f"Контактное лицо {n}",
            "contact_phone": f"+7 900 000-00-{n:02d}",
        }
        values = {}
        for field, replacement in fields.items():
            if row[field]:
                values[field] = mapping.put(f"counterparties.{field}", row[field], replacement)
            else:
                values[field] = row[field]
        conn.execute(
            "UPDATE counterparties SET full_name=?, short_name=?, code=?, inn=?,"
            " kpp=?, ogrn=?, legal_address=?, contact_person=?, contact_phone=?"
            " WHERE id=?",
            (*[values[f] for f in fields], row["id"]),
        )
    count("counterparties", len(rows))

    for table, prefix in (("agreements", "Д"), ("specifications", "С")):
        rows = conn.execute(f"SELECT id, number FROM {table} ORDER BY id").fetchall()
        for n, row in enumerate(rows, start=1):
            number = mapping.put(f"{table}.number", row["number"], f"{prefix}-{n:03d}")
            conn.execute(f"UPDATE {table} SET number=? WHERE id=?", (number, row["id"]))
        count(table, len(rows))

    rows = conn.execute(
        "SELECT id, theme FROM contracts WHERE theme IS NOT NULL AND theme <> '' ORDER BY id"
    ).fetchall()
    for n, row in enumerate(rows, start=1):
        theme = mapping.put("contracts.theme", row["theme"], f"Тема поставки {n}")
        conn.execute("UPDATE contracts SET theme=? WHERE id=?", (theme, row["id"]))
    count("contracts.theme", len(rows))

    rows = conn.execute(
        "SELECT id, description FROM contract_incidents WHERE description IS NOT NULL"
    ).fetchall()
    for row in rows:
        mapping.put("contract_incidents.description", row["description"], COMMENT_PLACEHOLDER)
        conn.execute(
            "UPDATE contract_incidents SET description=? WHERE id=?",
            (COMMENT_PLACEHOLDER, row["id"]),
        )
    count("contract_incidents.description", len(rows))

    # ------------------------------------------------- проекты и объекты
    for table, prefix in (("projects", "Проект"), ("objects", "Объект")):
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
        columns = rows[0].keys() if rows else []
        for n, row in enumerate(rows, start=1):
            name = mapping.put(f"{table}.name", row["name"], f"{prefix}-{n}")
            sets, params = ["name=?"], [name]
            if "address" in columns and row["address"]:
                mapping.put(f"{table}.address", row["address"], f"г. Город, площадка {n}")
                sets.append("address=?")
                params.append(f"г. Город, площадка {n}")
            if "description" in columns and row["description"]:
                mapping.put(f"{table}.description", row["description"], "Описание скрыто")
                sets.append("description=?")
                params.append("Описание скрыто")
            params.append(row["id"])
            conn.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE id=?", params)
        count(table, len(rows))

    # ------------------------------------------------- имена файлов DXF
    # source_file — ключ связи между elements/zones/zone_levels/
    # axis_lines/object_drawings, менять его надо ВЕЗДЕ одинаково, иначе
    # схема рассыплется на несвязанные куски.
    files: set[str] = set()
    for table in ("elements", "zones", "zone_levels", "axis_lines", "object_drawings"):
        for row in conn.execute(
            f"SELECT DISTINCT source_file FROM {table} WHERE source_file IS NOT NULL"
        ):
            files.add(row["source_file"])
    for n, original in enumerate(sorted(files), start=1):
        replacement = f"Чертёж-{n}.dxf"
        mapping.put("source_file", original, replacement)
        for table in ("elements", "zones", "zone_levels", "axis_lines", "object_drawings"):
            conn.execute(
                f"UPDATE {table} SET source_file=? WHERE source_file=?", (replacement, original)
            )
    count("source_file (имён чертежей)", len(files))

    # ------------------------------------------- свободные комментарии
    for table in ("elements", "status_history"):
        n = conn.execute(
            f"UPDATE {table} SET comment=? WHERE comment IS NOT NULL AND comment <> ''",
            (COMMENT_PLACEHOLDER,),
        ).rowcount
        count(f"{table}.comment", n)

    rows = conn.execute("SELECT id, filename, description FROM attachments").fetchall()
    for row in rows:
        suffix = Path(row["filename"] or "").suffix
        replacement = f"файл-{row['id']}{suffix}"
        mapping.put("attachments.filename", row["filename"], replacement)
        if row["description"]:
            mapping.put("attachments.description", row["description"], COMMENT_PLACEHOLDER)
        conn.execute(
            "UPDATE attachments SET filename=?, description=? WHERE id=?",
            (replacement, COMMENT_PLACEHOLDER if row["description"] else None, row["id"]),
        )
    count("attachments", len(rows))

    # Журнал действий хранит снимки старого/нового значения и произвольный
    # JSON — туда попадает всё что угодно, разбирать по видам событий
    # ненадёжно, вычищаем целиком (сам факт и время события сохраняются).
    n = conn.execute(
        "UPDATE activity_log SET old_value=NULL, new_value=NULL, details=NULL"
        " WHERE old_value IS NOT NULL OR new_value IS NOT NULL OR details IS NOT NULL"
    ).rowcount
    count("activity_log (значения)", n)

    rows = conn.execute("SELECT id FROM report_notes").fetchall()
    conn.execute(
        "UPDATE report_notes SET key_events='[]', key_tasks='[]', open_questions='[]'"
    )
    count("report_notes (тексты)", len(rows))

    # ------------------------------------------------------- настройки
    # Карточка проекта содержит название стройки и кадастровые номера;
    # настройки доменного входа — адрес контроллера домена и base DN,
    # то есть топологию внутренней сети. Оба — по ключу, не по значению.
    rows = conn.execute("SELECT rowid AS rid, key, value FROM app_settings").fetchall()
    scrubbed = 0
    for row in rows:
        key = (row["key"] or "").lower()
        if row["value"] and ("card" in key or "ldap" in key or "domain" in key or "auth" in key):
            mapping.put(f"app_settings.{row['key']}", row["value"], "скрыто")
            conn.execute(
                "UPDATE app_settings SET value=? WHERE rowid=?",
                (_blank_json_strings(row["value"]), row["rid"]),
            )
            scrubbed += 1
    count("app_settings (скрыто значений)", scrubbed)

    # ------------------------------------------------- модель Revit / МФР
    # До 2026-08-31 эти четыре таблицы вообще не трогались — обнаружилось
    # только на реальных данных, когда собственная проверка на утечки
    # (`find_leaks`) отказалась принять готовую копию: имя модели
    # (`revit_packages.model`) и куски названия объекта проникали в
    # свободный текст `revit_elements`/`revit_rooms`/`object_flats`
    # (заказчик кладёт в Revit-модель произвольные параметры, ключ,
    # унёсший название стройки, заранее не угадать). Имя модели — тем же
    # приёмом, что имя чертежа (`source_file`) выше; свободный текст —
    # точечной заменой УЖЕ накопленных к этому месту псевдонимов (люди,
    # проекты/объекты, контрагенты, номера договоров, имена файлов) —
    # угадывать конкретный виновный ключ не нужно, достаточно вычистить
    # сами утёкшие значения, где бы они ни лежали.
    models: set[str] = set()
    for row in conn.execute(
        "SELECT DISTINCT model FROM revit_packages WHERE model IS NOT NULL AND model <> ''"
    ):
        models.add(row["model"])
    for n, original in enumerate(sorted(models), start=1):
        replacement = f"Модель-{n}.rvt"
        mapping.put("revit_packages.model", original, replacement)
        conn.execute("UPDATE revit_packages SET model=? WHERE model=?", (replacement, original))
    count("revit_packages.model", len(models))

    count(
        "revit_packages.exporter (скрыто)",
        conn.execute(
            "UPDATE revit_packages SET exporter='экспортёр скрыт'"
            " WHERE exporter IS NOT NULL AND exporter <> ''"
        ).rowcount,
    )

    pairs = mapping.all_pairs()
    if pairs:
        compiled = [
            (re.compile(r"\b" + re.escape(original) + r"\b"), replacement)
            for original, replacement in sorted(pairs, key=lambda p: len(p[0]), reverse=True)
        ]

        def scrub(value):
            if not value:
                return value, False
            new_value = value
            for pattern, replacement in compiled:
                new_value = pattern.sub(replacement, new_value)
            return new_value, new_value != value

        # params_json остаётся ПОДСТРОЧНОЙ заменой найденных значений (не
        # разбором JSON, как `_blank_json_strings` у настроек): состав
        # ключей заказчика меняется (см. `_EXTRA_PARAMS` в
        # `app/revit_elements.py`), большинство из них — марки и типы,
        # которые CLAUDE.md намеренно оставляет настоящими; вычищать нужно
        # ровно утёкшие значения, а не всё поле целиком. Ни один псевдоним
        # не несёт символа `"` — подстрока внутри JSON-строки заменяется
        # безопасно, структура не портится.
        for table, columns in (
            ("revit_elements", ("family", "type_name", "level_name", "workset", "params_json")),
            ("revit_rooms", ("number", "name", "plan_type", "level_name")),
            ("object_flats", ("plan_type",)),
            ("object_roles", ("name",)),
        ):
            n = 0
            for row in conn.execute(f"SELECT rowid AS rid, {', '.join(columns)} FROM {table}"):
                updates = {}
                for col in columns:
                    new_value, changed = scrub(row[col])
                    if changed:
                        updates[col] = new_value
                if updates:
                    conn.execute(
                        f"UPDATE {table} SET {', '.join(f'{c}=?' for c in updates)} WHERE rowid=?",
                        (*updates.values(), row["rid"]),
                    )
                    n += 1
            count(f"{table} (точечная замена)", n)

    # uid — не всегда чистый GUID (зависит от экспортёра заказчика), риск
    # точечной заменой испортить его непредсказуем; переписывается целиком
    # на синтетический, id остаётся уникальным сам по себе. Для отладки
    # содержательного смысла в исходном uid нет — это ключ upsert'а, не
    # то, что читает человек.
    for table in ("revit_elements", "revit_rooms"):
        n = conn.execute(f"UPDATE {table} SET uid = 'x' || id WHERE uid IS NOT NULL").rowcount
        count(f"{table}.uid", n)

    return stats


# Колонки с ФИКСИРОВАННЫМ системным словарём, не свободным текстом
# заказчика (`ZHBI_ELEMENT_TYPES` в `app/models.py` — четыре значения,
# одинаковые на любом развёртывании). Без исключения короткая «тема
# поставки», случайно совпавшая с одним словом словаря («Плита»), даёт
# ложное срабатывание на КАЖДОЙ таблице, где есть `element_type` — это
# не общий заказчиком реквизит, а термин самой предметной области.
_ENUM_COLUMNS = {"element_type"}


def find_leaks(conn: sqlite3.Connection, needles: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    """Сплошной поиск исходных значений во ВСЕХ текстовых колонках копии.

    Проверка, а не надежда: мест записи два десятка, и пропущенное
    всплывёт здесь. Дополнительно ловим кадастровые номера по формату —
    они не значение справочника, по списку подстановок их не найти.

    Совпадение ищется по границам слова: без этого номер договора
    «1/16.02-ПОСТ» ловился бы обрывком «16.02» внутри координат контура.
    Возвращает тройки (таблица, колонка, ОТКУДА значение) — сами
    значения наружу не отдаются, вывод скрипта тоже попадает в контекст.
    """
    compiled = [
        (group, re.compile(r"\b" + re.escape(value) + r"\b"))
        for group, value in sorted(needles, key=lambda p: len(p[1]), reverse=True)
    ]
    leaks: list[tuple[str, str, str]] = []
    tables = [
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not r["name"].startswith("sqlite_")
    ]
    for table in tables:
        columns = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")
                   if r["name"] not in _ENUM_COLUMNS]
        if not columns:
            continue
        for row in conn.execute(f"SELECT {', '.join(columns)} FROM {table}"):
            for column in columns:
                value = row[column]
                if not isinstance(value, str) or not value:
                    continue
                for group, pattern in compiled:
                    if pattern.search(value):
                        leaks.append((table, column, group))
                        break
                else:
                    if CADASTRE_RE.search(value):
                        leaks.append((table, column, "<кадастровый номер>"))
    return leaks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(REPO_ROOT / "data" / "zhbi.db"))
    parser.add_argument("--out", default=str(REPO_ROOT / "data" / "zhbi.anon.db"))
    parser.add_argument("--map", default=str(REPO_ROOT / "data" / "zhbi.anon.map.json"))
    parser.add_argument(
        "--no-verify", action="store_true", help="пропустить проверку на утечки (не рекомендуется)"
    )
    args = parser.parse_args()

    source, out, map_path = Path(args.source), Path(args.out), Path(args.map)
    if not source.exists():
        print(f"Нет исходной БД: {source}", file=sys.stderr)
        return 1
    if out.resolve() == source.resolve():
        print("Отказ: --out совпадает с --source, это перезаписало бы боевую БД.", file=sys.stderr)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    # Штатный снимок SQLite, а не копирование файла: с 2026-08-14 база в
    # режиме WAL, и последние транзакции лежат в отдельном файле `-wal` —
    # обычная копия взяла бы базу без них (тот же довод, что в
    # scripts/dry_run_migration.py и app/backups.py).
    if out.exists():
        out.unlink()
    _src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        _dst = sqlite3.connect(out)
        try:
            _src.backup(_dst)
        finally:
            _dst.close()
    finally:
        _src.close()

    mapping = Mapping()
    conn = sqlite3.connect(out)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        with conn:
            stats = anonymize(conn, mapping)
        conn.execute("VACUUM")

        print(f"Обезличенная копия: {out}")
        for name, n in stats.items():
            print(f"  {name}: {n}")

        if not args.no_verify:
            leaks = find_leaks(conn, mapping.needles())
            if leaks:
                print("\nПРОВЕРКА НЕ ПРОЙДЕНА — исходные значения остались:", file=sys.stderr)
                for table, column, group in sorted(set(leaks)):
                    print(f"  {table}.{column} ← значение из «{group}»", file=sys.stderr)
                print(
                    "Копия НЕ пригодна к использованию — не открывать её в сессии ассистента.",
                    file=sys.stderr,
                )
                return 2
            print("\nПроверка пройдена: исходных значений в копии не найдено.")
    finally:
        conn.close()

    map_path.write_text(mapping.to_json(), encoding="utf-8")
    print(f"Карта соответствий: {map_path} (в git не уходит, ассистенту не показывать)")
    print(
        "\nВход в копию закрыт (хэши паролей сняты). Задать пароль для живой проверки:\n"
        f"  ZHBI_DB_PATH={out} .venv/bin/python scripts/reset_password.py admin"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Импорт/экспорт настроек проекта — общая логика применения файла (используется и одношаговым
`POST /settings/import` V1, и двухшаговым `analyze`/`apply` V2, `app/main.py`).

Файл содержит хэши и соли паролей ВСЕХ пользователей (см. `export_settings` в `app/main.py`) — это не
«настройки», а копия учётных записей: импорт перезаписывает пользователей и их роли. V1 применяет файл
одним запросом без предпросмотра — так и остаётся, маршрут не меняется. V2 добавляет то, чего у V1 нет
(решение пользователя, Docs/v2-progress/exchange.md): сверку «что изменится» ДО применения (без раскрытия
самих хэшей — только факт «пароль будет заменён»), явное подтверждение на экране «файл = копия учётных
записей» и перечитывание сверки НЕПОСРЕДСТВЕННО перед применением — успели файл подменить или базу
изменить (другой администратор, другой импорт) — применение отказывает, а не подставляет устаревшее.

`apply_payload()` — ровно тот код, что раньше лежал прямо в `import_settings()`; вынесен сюда, чтобы
V1 и V2 не разошлись двумя копиями одной бизнес-логики. Поведение НЕ изменилось ни на шаг: то же
upsert по `domain_login`, тот же перенос `auth_method`, та же обработка `label_visibility` по имени
объекта со старым форматом файла (без объекта). Добавлена только блокировка записи первым действием
(`begin_write`, см. `Docs/backlog.md`/стоячая инструкция) — раньше запись шла без неё, и сбой посреди
цикла (например, невалидный цвет статуса на пятой из десяти строк) оставлял в БД уже применённые ранее
INSERT/UPDATE закоммиченными по отдельности (implicit-транзакция SQLite открывается первым DML и не
атомарна без явного BEGIN); теперь весь импорт — одна транзакция, как и у всех остальных загрузок обмена
данными.
"""

import hashlib
import json

from app.models import validate_color


class SettingsImportError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def parse_payload(raw: bytes) -> dict:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise SettingsImportError(422, "Файл повреждён или не является корректным JSON")
    if not isinstance(payload, dict):
        raise SettingsImportError(422, "Файл не похож на выгрузку настроек (ожидается объект JSON)")
    return payload


def _digest(raw: bytes, conn) -> str:
    """Хэш «файл + то состояние базы, с которым он сверялся» — ОДНИМ сравнением на apply() ловит и
    подменённый между сверкой и применением файл, и базу, изменившуюся за это время (другой
    администратор успел применить другой файл настроек или иначе поменял пользователя/цвет/подписи).
    Пароли/соли в хэш входят (как часть состояния, которое нельзя молча обойти), но сам хэш наружу
    (клиенту) не раскрывает их — это одностороннее необратимое сравнение, не список значений."""
    h = hashlib.sha256()
    h.update(raw)
    for row in conn.execute(
        "SELECT id, domain_login, last_name, first_name, patronymic, position, department, "
        "role, password_hash, password_salt, auth_method FROM users ORDER BY id"
    ):
        h.update("\x1f".join("" if v is None else str(v) for v in tuple(row)).encode("utf-8", "replace"))
    h.update(b"\x00colors\x00")
    for row in conn.execute("SELECT status, color FROM status_colors ORDER BY status"):
        h.update(f"{row['status']}={row['color']}".encode("utf-8", "replace"))
    h.update(b"\x00labels\x00")
    for row in conn.execute(
        "SELECT o.name AS object_name, lv.element_type, lv.visible, lv.dates_visible "
        "FROM label_visibility lv JOIN objects o ON o.id = lv.object_id "
        "ORDER BY o.name, lv.element_type"
    ):
        h.update(f"{row['object_name']}|{row['element_type']}|{row['visible']}|{row['dates_visible']}"
                 .encode("utf-8", "replace"))
    return h.hexdigest()


def analyze(conn, raw: bytes) -> dict:
    """Сверка ДО применения — ничего не пишет. Возвращает построчные расхождения (создание/правка
    пользователя — без хэшей и солей, только факт «пароль будет заменён»; изменённые цвета статусов;
    число правок видимости подписей и объекты файла, которых на этом сервере нет — они будут
    пропущены, как и при одношаговом импорте V1) и `digest` — сверить его же на `apply()`."""
    payload = parse_payload(raw)

    users_in = payload.get("users")
    if users_in is not None and not isinstance(users_in, list):
        raise SettingsImportError(422, "Поле «users» файла должно быть списком")
    existing_by_login = {r["domain_login"]: r for r in conn.execute("SELECT * FROM users")}
    users_diff = []
    for u in users_in or []:
        if not isinstance(u, dict):
            raise SettingsImportError(422, "Запись пользователя в файле — не объект")
        login = u.get("domain_login")
        if not login:
            continue  # как и apply_payload(): запись без логина не upsert'ится (WHERE domain_login=None ничего не найдёт и не создаст осмысленно)
        cur = existing_by_login.get(login)
        auth_method = "domain" if u.get("auth_method") == "domain" else "local"
        name = f"{u.get('last_name', '')} {u.get('first_name', '')}".strip() or login
        if cur is None:
            users_diff.append({
                "login": login, "kind": "create", "name": name,
                "role": u.get("role", "view"), "auth_method": auth_method,
                "password_set": bool(u.get("password_hash")),
            })
            continue
        changed = []
        if (cur["last_name"] or "", cur["first_name"] or "", cur["patronymic"], cur["position"], cur["department"]) != \
           (u.get("last_name", ""), u.get("first_name", ""), u.get("patronymic"), u.get("position"), u.get("department")):
            changed.append("реквизиты (ФИО, должность, подразделение)")
        if cur["role"] != u.get("role", "view"):
            changed.append(f"роль: «{cur['role']}» → «{u.get('role', 'view')}»")
        if cur["auth_method"] != auth_method:
            changed.append(f"способ входа: «{cur['auth_method']}» → «{auth_method}»")
        if u.get("password_hash") and u.get("password_hash") != cur["password_hash"]:
            changed.append("пароль будет заменён")
        if changed:
            users_diff.append({"login": login, "kind": "update", "name": name, "changes": changed})

    status_colors_in = payload.get("status_colors")
    if status_colors_in is not None and not isinstance(status_colors_in, dict):
        raise SettingsImportError(422, "Поле «status_colors» файла должно быть объектом")
    existing_colors = {r["status"]: r["color"] for r in conn.execute("SELECT status, color FROM status_colors")}
    colors_diff = []
    for status, color in (status_colors_in or {}).items():
        try:
            color = validate_color(color, f"Цвет статуса «{status}»")
        except ValueError as e:
            raise SettingsImportError(422, str(e))
        if existing_colors.get(status) != color:
            colors_diff.append({"status": status, "was": existing_colors.get(status), "now": color})

    object_names = {r["name"] for r in conn.execute("SELECT name FROM objects")}
    label_changes = 0
    skipped_objects = set()
    for key in ("label_visibility", "label_dates_visibility"):
        section = payload.get(key)
        if section is not None and not isinstance(section, dict):
            raise SettingsImportError(422, f"Поле «{key}» файла должно быть объектом")
        for object_name, types in (section or {}).items():
            if isinstance(types, bool):
                if len(object_names) != 1:
                    skipped_objects.add("(файл старого формата, без объекта — на сервере не ровно один объект)")
                else:
                    label_changes += 1
                continue
            if not isinstance(types, dict):
                raise SettingsImportError(422, f"Запись «{key}[{object_name}]» файла должна быть объектом")
            if object_name not in object_names:
                skipped_objects.add(object_name)
                continue
            label_changes += len(types)

    return {
        "users": users_diff,
        "status_colors": colors_diff,
        "label_visibility_changes": label_changes,
        "skipped_objects": sorted(skipped_objects),
        "total_users_in_file": len(users_in or []),
        "has_changes": bool(users_diff or colors_diff or label_changes),
        "digest": _digest(raw, conn),
    }


def apply_payload(conn, payload: dict) -> dict:
    """Применяет файл — тот же код, что раньше был инлайн в `import_settings()` (main.py). Писатель
    берёт блокировку записи ПЕРВЫМ действием (вызывающий код обязан звать `db.begin_write(conn)` до
    этого вызова) и коммитит один раз в конце — сбой посреди цикла не оставляет частичных правок."""
    users_upserted = 0
    for u in payload.get("users", []):
        existing = conn.execute(
            "SELECT id FROM users WHERE domain_login = ?", (u.get("domain_login"),)
        ).fetchone()
        fields = {
            "last_name": u.get("last_name", ""),
            "first_name": u.get("first_name", ""),
            "patronymic": u.get("patronymic"),
            "position": u.get("position"),
            "department": u.get("department"),
            "domain_login": u.get("domain_login"),
            "role": u.get("role", "view"),
            "password_hash": u.get("password_hash"),
            "password_salt": u.get("password_salt"),
            "auth_method": "domain" if u.get("auth_method") == "domain" else "local",
        }
        if existing:
            conn.execute(
                """
                UPDATE users SET last_name=:last_name, first_name=:first_name,
                    patronymic=:patronymic, position=:position, department=:department,
                    role=:role, password_hash=:password_hash, password_salt=:password_salt,
                    auth_method=:auth_method, updated_at=datetime('now')
                WHERE domain_login=:domain_login
                """,
                fields,
            )
        else:
            conn.execute(
                """
                INSERT INTO users (last_name, first_name, patronymic, position, department,
                    domain_login, role, password_hash, password_salt, auth_method)
                VALUES (:last_name, :first_name, :patronymic, :position, :department,
                    :domain_login, :role, :password_hash, :password_salt, :auth_method)
                """,
                fields,
            )
        users_upserted += 1

    for status, color in payload.get("status_colors", {}).items():
        color = validate_color(color, "Цвет статуса")
        conn.execute(
            "INSERT INTO status_colors (status, color) VALUES (?, ?) "
            "ON CONFLICT(status) DO UPDATE SET color = excluded.color",
            (status, color),
        )

    object_ids_by_name = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM objects")}
    applied = {"label_visibility": 0, "label_dates_visibility": 0}
    skipped_objects = set()
    for key, column in (("label_visibility", "visible"), ("label_dates_visibility", "dates_visible")):
        for object_name, types in (payload.get(key) or {}).items():
            if isinstance(types, bool):
                if len(object_ids_by_name) != 1:
                    skipped_objects.add("(файл старого формата, без объекта)")
                    continue
                object_id, types = next(iter(object_ids_by_name.values())), {object_name: types}
            elif object_name in object_ids_by_name:
                object_id = object_ids_by_name[object_name]
            else:
                skipped_objects.add(object_name)
                continue
            for element_type, visible in types.items():
                conn.execute(
                    f"INSERT INTO label_visibility (object_id, element_type, {column}) "
                    f"VALUES (?, ?, ?) ON CONFLICT(object_id, element_type) "
                    f"DO UPDATE SET {column} = excluded.{column}",
                    (object_id, element_type, int(visible)),
                )
                applied[key] += 1

    return {
        "users_upserted": users_upserted,
        "status_colors": len(payload.get("status_colors", {})),
        "label_visibility": applied["label_visibility"],
        "label_dates_visibility": applied["label_dates_visibility"],
        "skipped_objects": sorted(skipped_objects),
    }

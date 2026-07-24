"""
Восстановление/установка пароля пользователя в обход веб-API и любой
активной сессии — на случай, если пароль утрачен, а зайти в UI, чтобы
сменить его через "Настройки", уже не с чем (в частности, если так
оказался заблокирован последний admin). Требует доступа к файловой
системе сервера (тот же уровень доверия, что и прямой доступ к
data/zhbi.db) — это осознанно: единственная альтернатива была бы
восстановление по email/SMS, а инструмент внутренний и почтой
пользователей не заводит (см. Docs/backlog.md, аудит безопасности).

Работает и при остановленном, и при запущенном сервере (одна короткая
транзакция), но безопаснее сначала остановить сервер — БД без WAL (см.
CLAUDE.md), конкурентная запись не тестировалась целенаправленно.

Запуск:
    python3 scripts/reset_password.py <domain_login>
"""

import getpass
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password, validate_password_strength
from app.db import get_connection, init_db


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Использование: python3 {sys.argv[0]} <domain_login>", file=sys.stderr)
        return 1
    domain_login = sys.argv[1]

    init_db()
    conn = get_connection()
    try:
        user = conn.execute(
            "SELECT id, last_name, first_name, role FROM users WHERE domain_login = ?", (domain_login,)
        ).fetchone()
        if user is None:
            known = [r["domain_login"] for r in conn.execute("SELECT domain_login FROM users ORDER BY domain_login")]
            print(f"Пользователь с логином '{domain_login}' не найден.", file=sys.stderr)
            print("Известные логины: " + ", ".join(known), file=sys.stderr)
            return 1

        print(f"Пользователь: {user['last_name']} {user['first_name']} ({domain_login}), роль: {user['role']}")
        password = getpass.getpass("Новый пароль: ")
        confirm = getpass.getpass("Повторите пароль: ")
        if password != confirm:
            print("Пароли не совпадают.", file=sys.stderr)
            return 1

        try:
            validate_password_strength(password)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 1

        password_hash, password_salt = hash_password(password)
        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?",
            (password_hash, password_salt, user["id"]),
        )
        # Так же, как при смене пароля через UI (app/users.py set_password) —
        # старые сессии этого пользователя (в т.ч. те, из-за которых пароль
        # вообще потребовалось восстанавливать) больше не действительны.
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
        conn.commit()
    finally:
        conn.close()

    print(f"Пароль для '{domain_login}' обновлён, старые сессии этого пользователя завершены.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

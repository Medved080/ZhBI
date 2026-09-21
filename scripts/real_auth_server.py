"""Настоящий сервер этой ветки на ВРЕМЕННОЙ копии обезличенной БД — с НАСТОЯЩИМ входом по паролю.

Ничего не подменяется: запускается `app.main:app` со всеми обработчиками, авторизацией, сеансами и стражами.
Отличие от боевого запуска одно — путь к базе (временная копия, снятая штатным sqlite-backup) и тестовые пароли
у нескольких пользователей КОПИИ (записываются в копию через `app.auth.hash_password`, боевая база и настоящие
пароли не затрагиваются). Порты 8000/8010/8020 запрещены.

Запуск:  .venv/bin/python scripts/real_auth_server.py <база-источник> <порт> [каталог-копии]
Вход:    логины admin / user2 / user4, пароль печатается при старте (для копии, не для боевой базы).
"""
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

TEST_PASSWORD = "Test-Pass-1234!"
USERS = ("admin", "user2", "user3", "user4")          # admin, «user» с доступом, второй admin, «view»

src, port = Path(sys.argv[1]), int(sys.argv[2])
if port in (8000, 8010, 8020):
    sys.exit("порт занят под настоящие серверы пользователя")
work = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(tempfile.mkdtemp(prefix="zhbi_real_"))
work.mkdir(parents=True, exist_ok=True)
dst = work / "work.db"
if not dst.exists():
    s = sqlite3.connect(str(src)); d = sqlite3.connect(str(dst)); s.backup(d); d.close(); s.close()
os.environ["ZHBI_DB_PATH"] = str(dst)                 # ДО импорта приложения: путь читается при импорте app.db
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password  # noqa: E402

c = sqlite3.connect(str(dst))
for login in USERS:
    h, salt = hash_password(TEST_PASSWORD)
    c.execute("UPDATE users SET password_hash=?, password_salt=?, must_change_password=0, auth_method='local' WHERE domain_login=?", (h, salt, login))
c.commit(); c.close()

import uvicorn  # noqa: E402

print(f"настоящий сервер: http://127.0.0.1:{port}/v2  (копия БД: {dst}; логины {', '.join(USERS)}; пароль {TEST_PASSWORD})", flush=True)
uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")

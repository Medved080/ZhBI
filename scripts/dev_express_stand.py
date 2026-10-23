"""Стенд для живой проверки бота eXpress: сервер ЖБИ на обезличенной копии + макет сервера eXpress (CTS).

Настоящий CTS не вызывается. Макет слушает 127.0.0.1:MOCK_PORT (по умолчанию 8091): в экране «Бот eXpress → Подключение» вносят адрес
http://127.0.0.1:8091, идентификатор и ключ макета (scripts/express_cts_mock.py: BOT_ID, KEY). Что «отправил» бот — GET http://127.0.0.1:8091/_mock/messages.
Входящие сообщения контакта имитирует `scripts/express_say.py`.

Чтобы зайти в интерфейс, стенд задаёт пароль первому администратору КОПИИ базы (только если у него пароля нет): логин и пароль печатаются
в консоль стенда. Запуск — конфигурацией `zhbi-server-anon-express` из .claude/launch.json (порт PORT, по умолчанию 8031).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("ZHBI_DB_PATH", "data/zhbi.anon.db")
os.environ.setdefault("ZHBI_ALLOW_OLD_PYTHON", "1")      # тестовый стенд: запуск на любом Python

import uvicorn

import express_cts_mock
from app import db
from app.auth import hash_password

STAND_PASSWORD = "Stand-Express-2026!"

server, port = express_cts_mock.start(int(os.environ.get("MOCK_PORT") or 8091))
db.init_db()
conn = db.get_connection()
admin = conn.execute("SELECT id, domain_login, password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
if admin is not None:
    password_hash, salt = hash_password(STAND_PASSWORD)
    conn.execute("UPDATE users SET password_hash = ?, password_salt = ?, auth_method = 'local' WHERE id = ?", (password_hash, salt, admin["id"]))
    conn.commit()
    print(f"вход на стенд: логин {admin['domain_login']}, пароль {STAND_PASSWORD}", flush=True)
conn.close()
print(f"макет eXpress: http://127.0.0.1:{port}; бот {express_cts_mock.BOT_ID}; ключ {express_cts_mock.KEY}", flush=True)
uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.environ.get("PORT") or 8031))

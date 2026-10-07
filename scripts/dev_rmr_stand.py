"""Стенд для живой проверки настроек облачного роутера: сервер ЖБИ на обезличенной копии + макет роутера.

Настоящий роутер не вызывается: соединение с rmrrouter.redmadrobot.com подменяется на локальный макет
(`scripts/rmr_router_mock.py`). Адрес, привязка к хосту и проверка ключа работают тем же кодом, что в бою.
Ключ макета: sk-rmr-test-0123456789abcdef. Модели: openai/gpt-5-mini, anthropic/claude-haiku-4-5.
Запуск — конфигурацией `zhbi-server-anon-rmr` из .claude/launch.json (порт PORT, по умолчанию 8021).
"""
import http.client
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("ZHBI_DB_PATH", "data/zhbi.anon.db")

import uvicorn

import rmr_router_mock
from app import rmr_router

_server, _port = rmr_router_mock.start()
rmr_router.open_connection = lambda parsed, timeout: http.client.HTTPConnection("127.0.0.1", _port, timeout=timeout)
print(f"макет роутера: 127.0.0.1:{_port}; ключ {rmr_router_mock.KEY}", flush=True)
uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.environ.get("PORT") or 8021))

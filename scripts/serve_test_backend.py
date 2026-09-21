"""Тестовый сервер для проверки в браузере: настоящий backend этой ветки на ВРЕМЕННОЙ копии обезличенной БД, без входа.

Авторизация подменяется ТОЛЬКО в этом процессе и ТОЛЬКО на временной копии: по умолчанию работа идёт от администратора копии, а cookie
`test_user=<id>` (или заголовок `X-Test-User`) переключает пользователя копии — так в браузере проверяются два пользователя и недостаток прав.
Боевые данные и порты 8000/8010/8020 не затрагиваются. Запуск: .venv/bin/python scripts/serve_test_backend.py <копия_БД> <порт>
"""
import sys
import time

import _guard_harness as H

port = int(sys.argv[2])
p, server = H.start_http_server(port, default_admin=True)
print(f"тестовый сервер: http://127.0.0.1:{p}/v2 (копия БД: {H.WORK})", flush=True)
while True:
    time.sleep(3600)

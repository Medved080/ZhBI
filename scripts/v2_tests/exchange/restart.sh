#!/bin/bash
# Перезапуск проверочного сервера обмена данными на КОПИИ БД (порт V2_EX_PORT, по умолчанию 8150; 8000/8010/8020 запрещены).
# V2_EX_BASE — база-источник (обезличенная копия), V2_EX_WORK — рабочий каталог (там work.db).
PORT=${V2_EX_PORT:-8150}; WORK=${V2_EX_WORK:-/tmp/v2_exchange}
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
pkill -f "real_auth_server.py.*$PORT"; sleep 1
mkdir -p "$WORK/exchange_work"
(cd "$ROOT" && nohup .venv/bin/python scripts/real_auth_server.py "$V2_EX_BASE" "$PORT" "$WORK/exchange_work" > "$WORK/exchange_work/server$PORT.log" 2>&1 &)
for i in $(seq 1 30); do sleep 1; curl -s -o /dev/null "http://127.0.0.1:$PORT/v2" && break; done
curl -s -o /dev/null -w "server %{http_code}\n" "http://127.0.0.1:$PORT/v2"

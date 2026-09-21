#!/bin/bash
# Полный прогон проверок области «МФР / учёт по блокам» (V2) на КОПИИ обезличенной БД и НАСТОЯЩЕМ backend с настоящим входом.
# Использование: scripts/verify_mfr_all.sh <база-источник> [порт=8122] [рабочий-каталог]
# Порядок: HTTP (scripts/verify_mfr_ops.py, свой сервер на порту+1) → браузер A…H (scripts/verify_mfr_browser_*.mjs, один сервер на порту).
# Источник не меняется (штатный sqlite backup); порты 8000/8010/8020 запрещены.
set -u
SRC=$1; PORT=${2:-8122}; WORK=${3:-$(mktemp -d /tmp/mfr_all_XXXX)}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$PORT" in 8000|8010|8020) echo "порт запрещён"; exit 2;; esac
mkdir -p "$WORK/shots"; rm -f "$WORK/work.db"*
echo "== HTTP: scripts/verify_mfr_ops.py"; "$ROOT/.venv/bin/python" "$ROOT/scripts/verify_mfr_ops.py" "$SRC" $((PORT+1)) 2>&1 | grep -v "Warning\|warnings.warn" | tail -4
sqlite3 "$SRC" ".backup $WORK/work.db"
sqlite3 "$WORK/work.db" "insert or ignore into user_access(user_id,project_id,object_id,role) select id,NULL,4,'user' from users where domain_login='user2'; insert or ignore into user_access(user_id,project_id,object_id,role) select id,NULL,4,'view' from users where domain_login='user4';"
"$ROOT/.venv/bin/python" "$ROOT/scripts/real_auth_server.py" "$SRC" $PORT "$WORK" > "$WORK/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 60); do sleep 0.5; curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break; done
export MFR_BASE=http://127.0.0.1:$PORT MFR_DB="$WORK/work.db" MFR_SHOTS="$WORK/shots" MFR_TMP="$WORK"
RC=0
for s in a b c d e f g h; do
  echo "== браузер: scripts/verify_mfr_browser_$s.mjs"
  OUT=$(node "$ROOT/scripts/verify_mfr_browser_$s.mjs" 2>&1); CODE=$?
  echo "$OUT" | grep -E "FAIL|СБОЙ|: [0-9]+ ok /"
  # нет итоговой строки набора — сценарий упал до итога: показать хвост вывода
  echo "$OUT" | grep -qE ": [0-9]+ ok /" || { echo "  (нет итоговой строки; хвост вывода:)"; echo "$OUT" | tail -6; }
  [ $CODE -ne 0 ] && RC=1
done
kill $SRV 2>/dev/null
echo "итог: код возврата $RC (0 — всё зелёное)"; exit $RC

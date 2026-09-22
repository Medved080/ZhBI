#!/bin/bash
# Сквозная проверка интеграционной ветки V2: скрипты всех областей на СВЕЖЕЙ копии обезличенной БД и настоящем backend (вход по паролю).
# Использование: scripts/integration_run.sh <база-источник.db> [рабочий-каталог] [группы: A B C D E F G]   (по умолчанию все группы)
# Источник не меняется (штатный sqlite backup); порты 8000/8010/8020 не используются. Итог каждой группы — в конце её блока.
R=$(cd "$(dirname "$0")/.." && pwd)
B=$1; N=${2:-/tmp/zhbi_integration}; GROUPS_WANTED=${3:-A B C D E F G}
mkdir -p "$N"; cd "$R" || exit 2
kill_port() { for p in "$@"; do pid=$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pid" ] && kill $pid; done; sleep 1; }
wait_up() { for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:$1/v2 && return 0; sleep 1; done; return 1; }
want() { case " $GROUPS_WANTED " in *" $1 "*) return 0;; esac; return 1; }
sect() { echo; echo "######## $1"; }

if want A; then sect "A. backend по HTTP и вызовом обработчиков"
  for f in verify_allocation verify_element_ops verify_lock_release verify_writer_paths verify_activity_journal verify_picker_backend; do
    echo "== $f"; .venv/bin/python scripts/$f.py "$B" 2>&1 | tail -2
  done
  echo "== verify_contract_guard_concurrency (10 раундов)"; .venv/bin/python scripts/verify_contract_guard_concurrency.py "$B" --rounds 10 2>&1 | tail -3
fi
if want B; then sect "B. МФР (HTTP + браузер A…H)"
  bash scripts/verify_mfr_all.sh "$B" 8122 "$N/mfr_all" 2>&1 | tail -40
fi
if want C; then sect "C. администрирование: HTTP и браузер"
  kill_port 8141; rm -rf "$N/adm"; (nohup .venv/bin/python scripts/real_auth_server.py "$B" 8141 "$N/adm" > "$N/adm_srv.log" 2>&1 &); wait_up 8141
  .venv/bin/python scripts/verify_admin_backend.py 8141 "$N/adm" 2>&1 | tail -4
  kill_port 8141; rm -rf "$N/adm2"; (nohup .venv/bin/python scripts/real_auth_server.py "$B" 8141 "$N/adm2" > "$N/adm_srv2.log" 2>&1 &); wait_up 8141
  node scripts/verify_admin_ui.mjs 8141 "$N/adm2" 2>&1 | grep -v Experimental | tail -12
  kill_port 8141
fi
if want D; then sect "D. обмен данными: HTTP и браузер"
  kill_port 8150; rm -rf "$N/ex"; mkdir -p "$N/ex"; (nohup .venv/bin/python scripts/real_auth_server.py "$B" 8150 "$N/ex" > "$N/ex_srv.log" 2>&1 &); wait_up 8150
  .venv/bin/python scripts/verify_exchange.py 8150 "$N/ex/work.db" 2>&1 | tail -6
  kill_port 8150; rm -rf "$N/exw"; mkdir -p "$N/exw"
  V2_EX_BASE=$B V2_EX_WORK=$N/exw V2_EX_PORT=8150 bash scripts/v2_tests/exchange/restart.sh 2>&1 | tail -1
  for c in contracting bulk bulk2 imports imports2 drawing revit input export reports dyn rights layout; do
    echo "== chk_$c"; V2_EX_BASE=$B V2_EX_WORK=$N/exw V2_EX_PORT=8150 node scripts/v2_tests/exchange/chk_$c.mjs 2>&1 | grep -v Experimental | tail -3
  done
  kill_port 8150
fi
if want E; then sect "E. модель ЖБИ и распределение (браузер)"
  kill_port 8102; rm -rf "$N/db102"; (nohup .venv/bin/python scripts/real_auth_server.py "$B" 8102 "$N/db102" > "$N/srv102.log" 2>&1 &); wait_up 8102
  python3 scripts/prep_alloc_case.py "$N/db102/work.db" A,B > "$N/e2e102.json"
  node scripts/verify_alloc_browser.mjs 8102 "$N/db102/work.db" "$N/e2e102.json" 2>&1 | grep -v Experimental | tail -4
  node scripts/verify_model_ui.mjs 8102 "$N/db102" 2>&1 | grep -v Experimental | tail -5
  kill_port 8102
fi
if want F; then sect "F. комплектовщик (браузер, каждый набор поднимает свой сервер)"
  for f in cp1 cp2 cp3 docs contracts picker_ws layout; do
    echo "== picker_verify/$f"; node scripts/picker_verify/$f.mjs 2>&1 | grep -v Experimental | tail -3
  done
fi
if want G; then sect "G. стенд V2 (фейковый backend), реальный шлюз"
  node scripts/picker_verify/stand.mjs 8103 "ws,shell,gt,ua,a11y,lc,ap,rd,bw" 2>&1 | tail -12
  echo "== cp (шлюз открыт)"; node scripts/picker_verify/stand.mjs 8103 "cp" --gate all 2>&1 | tail -8
fi
echo; echo ALLDONE

#!/bin/bash
# Последовательный прогон всех браузерных проверок области «picker» (каждая поднимает свой сервер на копии БД и удаляет её по окончании).
# Запуск: bash scripts/picker_verify/run_all.sh <каталог-логов>     Итог — в <каталог-логов>/summary.txt
LOGS="${1:?каталог логов}"; mkdir -p "$LOGS"; cd "$(dirname "$0")/../.."; : > "$LOGS/summary.txt"
for s in docs cp1 cp2 cp3 contracts picker_ws layout; do
  node "scripts/picker_verify/$s.mjs" > "$LOGS/$s.log" 2>&1
  echo "$s: $(grep -E '^Итого' "$LOGS/$s.log" | tail -1)  (код $?)" >> "$LOGS/summary.txt"
  grep -E '^FAIL' "$LOGS/$s.log" | cut -c1-220 >> "$LOGS/summary.txt"
done
echo "готово" >> "$LOGS/summary.txt"

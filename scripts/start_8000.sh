#!/usr/bin/env bash
# Локальный запуск ЖБИ вместе с подсистемой «Калькулятор» на порту 8000 (боевая база data/zhbi.db, --reload, как раньше).
# Запускает ПОЛЬЗОВАТЕЛЬ (боевые данные). Первый запуск сам:
#   1) создаёт .venv312 (Python 3.12) и ставит зависимости, если его нет;
#   2) переносит данные калькулятора из CalcZhBI (одноразово, если data/calc ещё нет; источник только читается).
# Использование:  scripts/start_8000.sh [каталог-CalcZhBI]   (по умолчанию /Users/max/projects/CalcZhBI)
set -euo pipefail
cd "$(dirname "$0")/.."
LEGACY="${1:-/Users/max/projects/CalcZhBI}"
PY312="$(command -v python3.12 || true)"
if [ ! -x .venv312/bin/python ]; then
  [ -n "$PY312" ] || { echo "Нужен python3.12 (brew install python@3.12)"; exit 1; }
  "$PY312" -m venv .venv312
  .venv312/bin/pip install -q -r requirements.txt -r requirements-dev.txt
fi
if [ ! -f data/calc/calczhbi.sqlite3 ] && [ -f "$LEGACY/data/calczhbi.sqlite3" ]; then
  echo "Перенос данных калькулятора из $LEGACY …"
  .venv312/bin/python -m app.calc.manage import-legacy "$LEGACY"
fi
mkdir -p logs
exec .venv312/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port "${PORT:-8000}" 2>&1 | tee -a logs/uvicorn-8000.log

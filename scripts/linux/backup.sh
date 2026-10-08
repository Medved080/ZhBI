#!/usr/bin/env bash
set -euo pipefail
# Резервная копия базы данных ЖБИ с меткой даты/времени в имени файла.
# Запускается по SSH на сервере (или из cron) — см. Docs/DEPLOYMENT_LINUX.md,
# раздел 2.
#
# ГДЕ ИСКАТЬ БАЗУ. С переходом на GitLab CI/CD (2026-07-28) данные лежат по
# АБСОЛЮТНОМУ пути: docker-compose.yml монтирует /opt/zhbi/data в /app/data
# внутри контейнера. Прежняя версия скрипта считала путь ОТНОСИТЕЛЬНО своей
# папки (корень git-чекаута) — на сервере, где чекаута может не быть вовсе
# (образ приезжает из реестра, compose запускает раннер), она искала базу не
# там и падала с «сервер ни разу не запускался».
#
# Порядок поиска: явный ZHBI_DATA_DIR -> /opt/zhbi/data (сервер) -> data/
# рядом с репозиторием (машина разработчика). Первый существующий выигрывает,
# выбранный путь печатается — чтобы не гадать, что именно скопировано.

if [ -n "${ZHBI_DATA_DIR:-}" ]; then
    candidates=("$ZHBI_DATA_DIR")
else
    candidates=("/opt/zhbi/data" "$(cd "$(dirname "$0")/../.." && pwd)/data")
fi

data_dir=""
for dir in "${candidates[@]}"; do
    if [ -f "$dir/zhbi.db" ]; then
        data_dir="$dir"
        break
    fi
done

if [ -z "$data_dir" ]; then
    echo "[ОШИБКА] Не нашёл zhbi.db ни по одному из путей:"
    printf '  %s/zhbi.db\n' "${candidates[@]}"
    echo "Укажите папку данных явно: ZHBI_DATA_DIR=/путь/к/data bash $0"
    exit 1
fi

backup_dir="$data_dir/backups"
mkdir -p "$backup_dir"
stamp="$(date +%Y-%m-%d_%H-%M-%S)"
dest="$backup_dir/zhbi_$stamp.db"

# КОПИРУЕМ СРЕДСТВАМИ SQLITE, а не `cp` (2026-10-08). С 08-14 база работает в
# режиме WAL: свежие записи лежат в zhbi.db-wal и попадают в zhbi.db только при
# контрольной точке. Простой `cp zhbi.db` их не видит (копия «из прошлого») и,
# если застанет базу посреди контрольной точки, даёт неконсистентный файл —
# ровно то, от чего приложение само защищается в app/backups.py через
# Connection.backup(). Здесь тот же штатный онлайновый бэкап: согласован с
# транзакциями и работает при запущенном контейнере.
if command -v python3 >/dev/null 2>&1; then
    python3 - "$data_dir/zhbi.db" "$dest" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=60)
dst = sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
PY
elif command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$data_dir/zhbi.db" ".timeout 60000" ".backup '$dest'"
else
    echo "[ОШИБКА] Нужен python3 или sqlite3: простое копирование файла базы"
    echo "в режиме WAL даёт неполную копию, поэтому скрипт его не делает."
    exit 1
fi

# Копия должна открываться и быть целой — иначе о порче узнают при восстановлении.
check="$(python3 - "$dest" <<'PY' 2>/dev/null || true
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro&immutable=1" % sys.argv[1], uri=True)
print(c.execute("PRAGMA quick_check").fetchone()[0])
PY
)"
if [ -n "$check" ] && [ "$check" != "ok" ]; then
    echo "[ОШИБКА] Копия не прошла проверку целостности: $check"
    rm -f "$dest"
    exit 1
fi

echo "База: $data_dir/zhbi.db"
echo "Резервная копия сохранена:"
echo "  $dest"

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
cp "$data_dir/zhbi.db" "$dest"

echo "База: $data_dir/zhbi.db"
echo "Резервная копия сохранена:"
echo "  $dest"

#!/usr/bin/env bash
set -euo pipefail
# Резервная копия базы данных ЖБИ (data/zhbi.db) с меткой даты/времени
# в имени файла.

root="$(cd "$(dirname "$0")/../.." && pwd)"
db_path="$root/data/zhbi.db"
backup_dir="$root/data/backups"

if [ ! -f "$db_path" ]; then
    echo "[ОШИБКА] Не найден data/zhbi.db — сервер ни разу не запускался?"
    exit 1
fi

mkdir -p "$backup_dir"
stamp="$(date +%Y-%m-%d_%H-%M-%S)"
dest="$backup_dir/zhbi_$stamp.db"
cp "$db_path" "$dest"

echo "Резервная копия сохранена:"
echo "  $dest"

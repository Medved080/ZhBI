#!/usr/bin/env bash
set -euo pipefail
# Обновление ТЕСТОВОЙ установки — всегда до последних изменений в ветке
# main (git pull) + пересборка Docker-образа (на случай, если
# requirements.txt/Dockerfile изменились). Для ПРОДУКТОВОЙ установки
# используйте update-prod.sh (конкретный релиз, не "последнее что
# есть") — см. Docs/DEPLOYMENT_LINUX.md, раздел 3.
#
# Данные (data/, Input/, uploads/, .env) НЕ в git (см. .gitignore) —
# git pull их не трогает. Перед обновлением всё равно делаем резервную
# копию базы — дополнительная страховка, не заменяет git.

cd "$(dirname "$0")/../.."

if [ ! -d ".git" ]; then
    echo "[ОШИБКА] Это не git-репозиторий. Либо настройте git (см. Docs/DEPLOYMENT_LINUX.md),"
    echo "либо обновляйтесь копированием файлов (раздел 4 того же документа)."
    exit 1
fi

echo "Резервная копия базы данных..."
if [ -f "data/zhbi.db" ]; then
    "$(dirname "$0")/backup.sh"
fi

echo
echo "Загружаю обновления..."
git pull

echo
echo "Пересобираю образ и перезапускаю контейнер..."
docker compose build
docker compose up -d

echo
echo "Готово. Журнал: docker compose logs -f"

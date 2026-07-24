#!/usr/bin/env bash
set -euo pipefail
# Обновление ПРОДУКТОВОЙ установки — до конкретного релиза (тега), а
# НЕ до последних изменений в разработке (для этого — update-test.sh
# на тестовой установке). См. Docs/DEPLOYMENT_LINUX.md, раздел 3.
#
# После выполнения репозиторий окажется в состоянии "detached HEAD" —
# это нормально и ожидаемо для продуктовой установки: она закреплена
# за конкретной проверенной версией, а не "едет" вместе с main.

cd "$(dirname "$0")/../.."

if [ ! -d ".git" ]; then
    echo "[ОШИБКА] Это не git-репозиторий. Настройте git — см. Docs/DEPLOYMENT_LINUX.md."
    exit 1
fi

echo "Резервная копия базы данных..."
if [ -f "data/zhbi.db" ]; then
    "$(dirname "$0")/backup.sh"
fi

echo
echo "Загружаю список релизов..."
git fetch --tags

echo
echo "Доступные релизы (новые сверху):"
git tag --sort=-creatordate

echo
read -rp "Введите тег релиза для установки (точно как в списке выше): " RELEASE
if [ -z "$RELEASE" ]; then
    echo "Ничего не введено, отмена."
    exit 1
fi

git checkout "$RELEASE"

echo
echo "Пересобираю образ и перезапускаю контейнер..."
docker compose build
docker compose up -d

echo
echo "Продуктовая установка обновлена до релиза $RELEASE."
echo "Журнал: docker compose logs -f"

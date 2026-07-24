#!/usr/bin/env bash
set -euo pipefail
# Разовая установка Docker Engine + Compose plugin на Ubuntu Server.
# Запускать ОДИН РАЗ. См. Docs/DEPLOYMENT_LINUX.md, раздел 1.1.

if command -v docker >/dev/null 2>&1; then
    echo "Docker уже установлен ($(docker --version)), пропускаю установку."
else
    echo "Устанавливаю Docker Engine + Compose plugin..."
    sudo apt update
    sudo apt install -y ca-certificates curl gnupg
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt update
    sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

sudo systemctl enable --now docker

if ! groups "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    echo
    echo "Добавил $USER в группу docker — выйдите и зайдите в SSH-сессию заново"
    echo "(или выполните 'newgrp docker'), чтобы это подействовало без sudo."
fi

echo
echo "Готово. Дальше — см. Docs/DEPLOYMENT_LINUX.md, раздел 1.2/1.3."

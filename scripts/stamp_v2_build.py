"""Пишет метку сборки нового интерфейса `app/static/v2/build.json` (индикатор «сборка …» в шапке V2).

Метка описывает КОММИТ КОДА (HEAD на момент запуска), а сама попадает в следующий коммит («метка сборки»). Запускать
перед публикацией на 8000: `python3 scripts/stamp_v2_build.py && git add app/static/v2/build.json && git commit -m "Метка сборки V2"`.
"""
import json
import subprocess
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parents[1]
commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
dirty = bool(subprocess.run(["git", "status", "--porcelain", "--", "app", "scripts"], cwd=root, capture_output=True, text=True, check=True).stdout.strip())
data = {"commit": commit + ("+dirty" if dirty else ""), "built": datetime.now().strftime("%Y-%m-%d %H:%M")}
(root / "app/static/v2/build.json").write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
print(data)

"""Где калькулятор хранит свои данные. Вычисляется при импорте и не меняется."""
import os
from pathlib import Path

from app.db import DB_PATH

CODE_DIR = Path(__file__).resolve().parent
CALC_DIR = Path(os.environ.get("ZHBI_CALC_DIR") or DB_PATH.parent / "calc").resolve()
# Исходные альбомы, каталоги и модели. Не в git и не в образе: поставляются
# пакетом отправки (app/calc/sync.py) либо кладутся на сервер вручную.
ASSETS_DIR = Path(os.environ.get("ZHBI_CALC_ASSETS_DIR") or CALC_DIR / "assets").resolve()
WEB_DIR = CODE_DIR / "web"

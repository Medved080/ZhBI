"""Хранение файлов внешних 3D-моделей на диске: без FastAPI-зависимостей
(см. Docs/fbx-ground-implementation-task.md §3, §7). Порядок записи —
временный файл рядом с целевым каталогом → hash по потоку → atomic rename
→ вызывающий код коммитит транзакцию БД → при ошибке коммита компенсирующе
удаляет файл.
"""
import hashlib
import os
import uuid
from pathlib import Path

EXTERNAL_MODELS_DIR = Path(__file__).resolve().parent.parent / "uploads" / "external_models"
_CHUNK_SIZE = 1024 * 1024


class ExternalModelTooLarge(Exception):
    pass


def _ensure_dir() -> None:
    EXTERNAL_MODELS_DIR.mkdir(parents=True, exist_ok=True)


def write_stream_with_hash(file_obj, max_bytes: int) -> tuple[str, str, int]:
    """Пишет содержимое во временный файл в целевом каталоге, считает
    sha256 по тому же потоку. Возвращает (stored_name, sha256_hex, size).
    Финальное имя — UUID.fbx, назначается ЗДЕСЬ (сервер), не принимается
    от клиента. При превышении лимита временный файл удаляется, исключение
    поднимается наружу.
    """
    _ensure_dir()
    stored_name = f"{uuid.uuid4().hex}.fbx"
    tmp_path = EXTERNAL_MODELS_DIR / f".tmp-{uuid.uuid4().hex}"
    hasher = hashlib.sha256()
    total = 0
    try:
        with open(tmp_path, "wb") as out:
            while True:
                chunk = file_obj.read(_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ExternalModelTooLarge(f"Файл больше {max_bytes} байт")
                hasher.update(chunk)
                out.write(chunk)
        final_path = EXTERNAL_MODELS_DIR / stored_name
        os.replace(tmp_path, final_path)  # atomic rename в пределах каталога
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return stored_name, hasher.hexdigest(), total


def delete_file(stored_name: str) -> None:
    """Файла может не быть — не повод падать (см. app/attachments.py,
    тот же довод)."""
    try:
        (EXTERNAL_MODELS_DIR / stored_name).unlink()
    except OSError:
        pass


def read_bytes(stored_name: str) -> bytes:
    return (EXTERNAL_MODELS_DIR / stored_name).read_bytes()


def path_for(stored_name: str) -> Path:
    return EXTERNAL_MODELS_DIR / stored_name


def cleanup_orphan_temp_files(max_age_seconds: int = 24 * 3600) -> int:
    """Убирает temp-файлы (`.tmp-*`), заведомо брошенные — упавшие между
    записью и rename (§7: «безопасная уборка старых temp/orphan»). НЕ
    трогает файлы `*.fbx`: те, на которые нет строки в БД, находит и решает
    отдельная сверка с БД (см. cleanup_orphan_model_files), не эта функция,
    — здесь нет доступа к БД намеренно (модуль без FastAPI/БД-зависимостей).
    """
    if not EXTERNAL_MODELS_DIR.is_dir():
        return 0
    import time
    now = time.time()
    removed = 0
    for p in EXTERNAL_MODELS_DIR.glob(".tmp-*"):
        try:
            if now - p.stat().st_mtime > max_age_seconds:
                p.unlink()
                removed += 1
        except OSError:
            pass
    return removed


def cleanup_orphan_model_files(known_stored_names: set) -> int:
    """Удаляет `*.fbx` в каталоге, на которые нет строки в БД (§7: orphan
    между rename и commit транзакции). Список known_stored_names — с
    БД-стороны, эта функция только сверяет и чистит файлы."""
    if not EXTERNAL_MODELS_DIR.is_dir():
        return 0
    removed = 0
    for p in EXTERNAL_MODELS_DIR.glob("*.fbx"):
        if p.name not in known_stored_names:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed

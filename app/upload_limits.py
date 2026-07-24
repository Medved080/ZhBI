"""
Общий лимит размера загружаемых файлов (см. Docs/backlog.md, аудит
безопасности) — без него `/import-dxf`/`/import-history-xlsx`/
`/settings/import` были ограничены только доступной памятью/диском
процесса. Два независимых барьера:

1. `Content-Length` проверяется на уровне ASGI-middleware
   (`MaxUploadSizeMiddleware` в app/main.py) — для обычной браузерной
   формы загрузки этого достаточно: браузер всегда знает размер файла
   заранее и отправляет multipart/form-data с честным Content-Length,
   запрос отклоняется ДО того, как сервер прочитал хоть байт тела.
2. Функции этого модуля — второй барьер на случай chunked-передачи без
   Content-Length (не бывает у браузерных форм, но не гарантировано у
   произвольного HTTP-клиента): читают/копируют поток порциями и
   прерываются, не дожидаясь полной передачи гигантского файла.
"""

import os
from pathlib import Path

from fastapi import HTTPException

MAX_UPLOAD_MB = int(os.environ.get("ZHBI_MAX_UPLOAD_MB", "200"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
_CHUNK_SIZE = 1024 * 1024


def _too_large() -> HTTPException:
    return HTTPException(status_code=413, detail=f"Файл слишком большой (максимум {MAX_UPLOAD_MB} МБ)")


def read_upload_limited(file_obj) -> bytes:
    """Для случаев, где дальнейший код всё равно требует байты целиком
    (openpyxl, json.loads) — xlsx/json на порядки меньше DXF, держать
    их в памяти приемлемо."""
    chunks = []
    total = 0
    while True:
        chunk = file_obj.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise _too_large()
        chunks.append(chunk)
    return b"".join(chunks)


def copy_upload_limited(file_obj, dest: Path) -> None:
    """Для DXF — пишет сразу на диск потоком (не держит десятки МБ в
    памяти лишний раз), прерывает и удаляет частично записанный файл
    при превышении лимита."""
    total = 0
    with open(dest, "wb") as out:
        while True:
            chunk = file_obj.read(_CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise _too_large()
            out.write(chunk)

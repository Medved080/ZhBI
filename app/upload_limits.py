"""
Общий лимит размера загружаемых файлов (см. Docs/backlog.md, аудит
безопасности) — без него `/import-dxf`/`/import-history-xlsx`/
`/settings/import` были ограничены только доступной памятью/диском
процесса. Три барьера, каждый закрывает то, что пропускает предыдущий:

1. `Content-Length` — быстрый отказ до чтения тела вообще. Для обычной
   браузерной формы этого достаточно: браузер знает размер файла заранее
   и заголовок ставит честный.
2. `MaxBodySizeMiddleware` (ниже) — СЧИТАЕТ фактически принятые байты и
   обрывает приём. Нужен потому, что первый барьер обходится тривиально:
   запрос с `Transfer-Encoding: chunked` заголовка `Content-Length` не
   имеет вовсе, а мусор в нём (`Content-Length: abc`) прежняя проверка
   молча пропускала (`except ValueError: too_big = False`). Тело при этом
   принимается ДО того, как отработают зависимости авторизации FastAPI
   (порядок фиксирован фреймворком: `await request.form()` идёт раньше
   `solve_dependencies`), то есть неаутентифицированный клиент писал в
   `/tmp` контейнера сколько угодно и лишь потом получал 401.
3. Функции чтения ниже — последний рубеж уже внутри обработчика, на
   случай путей, куда middleware по какой-то причине не встроен.
"""

import os
from pathlib import Path

from fastapi import HTTPException

MAX_UPLOAD_MB = int(os.environ.get("ZHBI_MAX_UPLOAD_MB", "200"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
_CHUNK_SIZE = 1024 * 1024


def _too_large() -> HTTPException:
    return HTTPException(status_code=413, detail=f"Файл слишком большой (максимум {MAX_UPLOAD_MB} МБ)")


_ОТКАЗ = (
    b'{"detail":"' + f"Тело запроса больше {MAX_UPLOAD_MB} МБ".encode("utf-8") + b'"}'
)


class _BodyTooLarge(Exception):
    """Внутренний сигнал из обёртки receive — наружу не выходит."""


class MaxBodySizeMiddleware:
    """Жёсткий потолок на размер тела ЛЮБОГО запроса.

    Написан как «чистый» ASGI-middleware, а не через `@app.middleware`,
    намеренно: обёртка над `receive` — единственный способ считать
    фактически принятые байты. `BaseHTTPMiddleware` канал приёма не отдаёт,
    поэтому декоратором такую проверку не сделать, а без неё лимит
    обходится запросом без `Content-Length` (см. docstring модуля).

    Отклонение по заголовку оставлено первым шагом — оно дешевле: отвечает
    до чтения хотя бы одного байта.
    """

    def __init__(self, app, max_bytes: int = MAX_UPLOAD_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        for имя, значение in scope.get("headers") or []:
            if имя == b"content-length":
                try:
                    if int(значение) > self.max_bytes:
                        await self._отказать(send)
                        return
                except ValueError:
                    pass  # мусор в заголовке — просто считаем байты дальше
                break

        принято = 0
        ответ_начат = False

        async def receive_с_лимитом():
            nonlocal принято
            message = await receive()
            if message["type"] == "http.request":
                принято += len(message.get("body") or b"")
                if принято > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        async def send_с_отметкой(message):
            nonlocal ответ_начат
            if message["type"] == "http.response.start":
                ответ_начат = True
            await send(message)

        try:
            await self.app(scope, receive_с_лимитом, send_с_отметкой)
        except _BodyTooLarge:
            # Если ответ уже пошёл клиенту, подменить его нечем — но приём
            # тела прекращён, а это и было целью.
            if not ответ_начат:
                await self._отказать(send)

    async def _отказать(self, send):
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json; charset=utf-8"),
                        (b"content-length", str(len(_ОТКАЗ)).encode())],
        })
        await send({"type": "http.response.body", "body": _ОТКАЗ})


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

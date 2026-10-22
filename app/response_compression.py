"""
Сжатие ответов сервера (gzip), 2026-10-22.

Живой репорт: на корпоративном сервере схема (3D, она же — загрузка данных
объекта) строится больше 30 секунд при переходе из другого раздела и при смене
объекта. Сервер собирает `/plan-data` за 0,3 с, но ответ весит ~18 МБ JSON
(9,6 тыс. элементов с контурами), а контейнер запускается голым uvicorn —
перед ним нет nginx, а в самом приложении сжатия не было. По сети шли 18 МБ
«как есть»; в gzip тот же ответ — ~0,9 МБ. Тем же путём шли `app.js` (2,4 МБ)
и остальная статика.

Почему не голый `starlette.middleware.gzip.GZipMiddleware`: он сжимает ВСЁ,
что отдаёт приложение, включая PDF, FBX, архивы и картинки (процессор тратится
впустую, выигрыша нет), и не знает про диапазонные запросы: сжатый кусок
`206 Partial Content` ломает клиентов, читающих файл частями (карта, pmtiles).
Здесь сжимаются только текстовые типы, а запрос с `Range` проходит как есть.
"""

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Уровень 5: на 18 МБ JSON даёт почти тот же размер, что 9, но заметно быстрее
# (на одном ядре сервера уровень 9 сам стал бы задержкой при каждом открытии схемы).
COMPRESS_LEVEL = 5

# Меньше этого размера сжимать нет смысла: заголовки и накладные расходы
# съедают выигрыш.
MIN_SIZE = 1024

_COMPRESSIBLE_PREFIXES = ("text/",)
_COMPRESSIBLE_TYPES = (
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/manifest+json",
    "image/svg+xml",
)


def is_compressible(content_type: str) -> bool:
    """Текстовый тип, который в gzip заметно ужимается."""
    base = (content_type or "").split(";", 1)[0].strip().lower()
    if base.startswith(_COMPRESSIBLE_PREFIXES):
        return base != "text/event-stream"  # поток событий буферизовать нельзя
    return base in _COMPRESSIBLE_TYPES or base.endswith("+json") or base.endswith("+xml")


class _TextOnlyResponder(GZipResponder):
    """Тот же GZipResponder, но нетекстовые ответы пропускает без сжатия."""

    async def send_with_compression(self, message: Message) -> None:
        await super().send_with_compression(message)
        if message["type"] == "http.response.start" and not self.started:
            headers = Headers(raw=message["headers"])
            # Базовый класс уже посчитал флаг «исключён» только по event-stream;
            # дополняем его: всё, что не текст, остаётся как есть.
            if not is_compressible(headers.get("content-type", "")):
                self.content_type_is_excluded = True


class TextGZipMiddleware(GZipMiddleware):
    def __init__(self, app: ASGIApp, minimum_size: int = MIN_SIZE, compresslevel: int = COMPRESS_LEVEL) -> None:
        super().__init__(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        # Диапазонные запросы и клиенты без gzip — мимо сжатия.
        if "range" in headers or "gzip" not in headers.get("accept-encoding", ""):
            await self.app(scope, receive, send)
            return
        await _TextOnlyResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)(scope, receive, send)

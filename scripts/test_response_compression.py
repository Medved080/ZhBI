"""Повторная выдача кешированного ответа не должна портить gzip-заголовки."""

import asyncio
import gzip
import unittest

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.response_compression import TextGZipMiddleware


async def request(app, *, encoding="gzip", range_header=None):
    headers = [(b"accept-encoding", encoding.encode())]
    if range_header is not None:
        headers.append((b"range", range_header.encode()))
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/calc/api/workspace", "raw_path": b"/calc/api/workspace",
        "query_string": b"lite=1", "root_path": "", "headers": headers,
        "server": ("testserver", 80), "client": ("127.0.0.1", 1234),
    }
    messages = []
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Future()

    async def send(message):
        copied = dict(message)
        if "headers" in message:
            copied["headers"] = list(message["headers"])
        messages.append(copied)

    await app(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return dict(start["headers"]), body


class CachedResponseCompressionTest(unittest.IsolatedAsyncioTestCase):
    async def check_cached_response(self, *, streaming):
        # Размер между порогами общего gzip (1 КБ) и калькулятора (64 КБ).
        payload = b'{"data":"' + b"x" * 4000 + b'"}'
        cached = Response(payload, media_type="application/json", headers={"Vary": "Accept-Encoding"})
        original_headers = list(cached.raw_headers)

        async def endpoint(scope, receive, send):
            await cached(scope, receive, send)

        async def passthrough(request, call_next):
            return await call_next(request)

        inner = BaseHTTPMiddleware(endpoint, dispatch=passthrough) if streaming else endpoint
        app = TextGZipMiddleware(inner)
        for attempt in range(3):
            with self.subTest(attempt=attempt, streaming=streaming):
                headers, body = await request(app)
                self.assertEqual(headers[b"content-encoding"], b"gzip")
                self.assertEqual(gzip.decompress(body), payload)
                if b"content-length" in headers:
                    self.assertEqual(int(headers[b"content-length"]), len(body))
                self.assertEqual(cached.raw_headers, original_headers)
                self.assertEqual(cached.body, payload)

        # Клиенты без gzip и диапазонные запросы получают исходное тело.
        for options in ({"encoding": "identity"}, {"range_header": "bytes=0-99"}):
            headers, body = await request(app, **options)
            self.assertNotIn(b"content-encoding", headers)
            self.assertEqual(body, payload)
            self.assertEqual(int(headers[b"content-length"]), len(body))

    async def test_cached_response_repeated_requests(self):
        await self.check_cached_response(streaming=False)

    async def test_cached_response_through_security_middleware(self):
        await self.check_cached_response(streaming=True)

    async def test_precompressed_response_is_not_compressed_twice(self):
        payload = b'{"data":"' + b"x" * 70000 + b'"}'
        compressed = gzip.compress(payload, 5)
        cached = Response(compressed, media_type="application/json", headers={"Content-Encoding": "gzip"})
        original_headers = list(cached.raw_headers)

        async def endpoint(scope, receive, send):
            await cached(scope, receive, send)

        app = TextGZipMiddleware(endpoint)
        for _ in range(3):
            headers, body = await request(app)
            self.assertEqual(body, compressed)
            self.assertEqual(gzip.decompress(body), payload)
            self.assertEqual(int(headers[b"content-length"]), len(body))
            self.assertEqual(cached.raw_headers, original_headers)


if __name__ == "__main__":
    unittest.main()

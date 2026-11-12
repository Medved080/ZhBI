"""Request correlation and technical diagnostics shared by all subsystems."""
import contextvars
import json
import logging
import re
import time
import zlib
from urllib.parse import parse_qsl, urlencode

from starlette.requests import Request

from app import activity, error_log

request_context = contextvars.ContextVar("service_request", default=None)
_SECRET = re.compile(r"password|passwd|token|secret|authorization|cookie|api.?key|пароль", re.I)


def safe_text(value):
    text = str(value)
    text = re.sub(r'(?i)(bearer\s+)[\w.\-]+', r'\1[скрыто]', text)
    return re.sub(r'(?i)((?:password|passwd|token|secret|api[_-]?key|authorization|cookie)[\w-]*[\s\"\x27]*[:=][\s\"\x27]*)[^\s,;&\"\x27}]+',
                  r'\1[скрыто]', text)


def safe_query(query):
    return urlencode([(k, "[скрыто]" if _SECRET.search(k) else safe_text(v))
                      for k, v in parse_qsl(query, keep_blank_values=True)])


class ServiceEventsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        started = time.perf_counter()
        info = {"request_id": activity.new_request_id(), "path": scope["path"],
                "method": scope["method"], "started": started}
        scope.setdefault("state", {})["service_event"] = info
        token = request_context.set(info)
        status, body, content_type, encoding = 500, bytearray(), "", ""

        async def observed_send(message):
            nonlocal status, content_type, encoding
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers", []))
                content_type = dict(headers).get(b"content-type", b"").decode("latin1")
                encoding = dict(headers).get(b"content-encoding", b"").decode("latin1")
                headers = [(k, v) for k, v in headers if k.lower() != b"x-request-id"]
                headers.append((b"x-request-id", info["request_id"].encode()))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and status >= 400 and len(body) < 8192:
                body.extend(message.get("body", b"")[:8192 - len(body)])
            await send(message)

        try:
            await self.app(scope, receive, observed_send)
        except Exception as exc:
            # Runs before ServerErrorMiddleware, while impersonation context is alive.
            if not getattr(request.state, "error_logged", False):
                error_log.note_exception(request, exc)
            raise
        else:
            elapsed = round((time.perf_counter() - started) * 1000, 2)
            if status >= 400:
                detail = None
                if "application/json" in content_type:
                    try:
                        raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(bytes(body), 8192) if encoding == "gzip" else body
                        payload = json.loads(raw)
                        detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
                    except (ValueError, UnicodeDecodeError, zlib.error):
                        pass
                if not getattr(request.state, "error_logged", False):
                    error_log.note_http_error(request, status, str(detail or f"ответ {status} без подробностей"))
            elif self.should_log(info, elapsed):
                uid, name = error_log._user_for_log(request)
                activity.log("service_request", user_id=uid, user_name=name,
                             entity_type="request", duration_ms=elapsed,
                             details={"путь": info["path"], "метод": info["method"], "код": status,
                                      "уровень": "INFO",
                                      "подсистема": "calc" if info["path"].startswith("/calc/") else "service",
                                      "параметры": safe_query(request.url.query)})
        finally:
            request_context.reset(token)

    @staticmethod
    def should_log(info, elapsed):
        path = info["path"]
        if path.startswith(("/static/", "/activity", "/perf/")) or path in {
            "/health", "/app-build", "/changes", "/favicon.ico", "/calc/api/health", "/calc/api/sync/state"}:
            return False
        return (info["method"] not in {"GET", "HEAD", "OPTIONS"}
                or path.startswith("/calc/api/") or elapsed >= 1000)


class JournalHandler(logging.Handler):
    """Warnings and failures of background workers also reach the journal."""
    def emit(self, record):
        try:
            details = {"модуль": record.name, "уровень": record.levelname,
                       "сообщение": safe_text(record.getMessage()),
                       "подсистема": "calc" if record.name.startswith("app.calc") else "service"}
            details.update({k: safe_text(v) for k, v in getattr(record, "service_details", {}).items()})
            if record.exc_info:
                details["трассировка"] = safe_text(logging.Formatter().formatException(record.exc_info))[-24000:]
                details["тип ошибки"] = record.exc_info[0].__name__
            info = request_context.get()
            if info:
                details.update({"путь": info["path"], "метод": info["method"]})
            activity.log("service_diagnostic", source="system", entity_type="service",
                         category="error" if record.levelno >= logging.ERROR else "system", details=details)
        except Exception:
            self.handleError(record)


def install_logging():
    logger = logging.getLogger("app")
    if not any(isinstance(h, JournalHandler) for h in logger.handlers):
        logger.addHandler(JournalHandler(level=logging.WARNING))

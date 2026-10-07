"""Макет облачного роутера red_mad_robot для проверок без внешней сети.

Отвечает как настоящий роутер: HTTP/1.1 с keep-alive, SSE чанками, ключ в Authorization: Bearer, отказы 400/401/402/429
с текстом причины. Управляется маркерами в тексте последнего сообщения (`__429__`, `__no_schema__`, …) — см. do_POST.
Используется `scripts/verify_rmr_router.py` и стендом `scripts/dev_rmr_stand.py`.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = "sk-rmr-test-0123456789abcdef"
seen = []            # все запросы к макету: (метод, путь, заголовок Authorization, тело)
state = {"calls": 0}
USAGE = {"prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500}


class Router(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # keep-alive, как у настоящего роутера: тело ошибки читается после ответа

    def log_message(self, *args): pass

    def reply_json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        return self.headers.get("Authorization") == f"Bearer {KEY}"

    def do_GET(self):
        seen.append(("GET", self.path, self.headers.get("Authorization"), None))
        if not self.authorized():
            return self.reply_json(401, {"error": {"message": f"Incorrect API key provided: {self.headers.get('Authorization', '')[7:]}"}})
        if self.path == "/v1/models":
            return self.reply_json(200, {"data": [{"id": "openai/gpt-5-mini"}, {"id": "anthropic/claude-haiku-4-5"}, {"id": "vendor/not-in-price"}]})
        self.reply_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen.append(("POST", self.path, self.headers.get("Authorization"), data))
        if not self.authorized():
            return self.reply_json(401, {"error": {"message": f"Incorrect API key provided: {self.headers.get('Authorization', '')[7:]}"}})
        text = data["messages"][-1]["content"]
        fmt = (data.get("response_format") or {}).get("type")
        if "__402__" in text:
            return self.reply_json(402, {"error": {"message": "insufficient balance"}})
        if "__429__" in text:
            state["calls"] += 1
            if state["calls"] == 1:
                return self.reply_json(429, {"error": {"message": "rate limit"}})
        if "__no_schema__" in text and fmt == "json_schema":
            return self.reply_json(400, {"error": {"message": "Invalid parameter: response_format of type json_schema is not supported with this model"}})
        if "__completion_param__" in text and "max_tokens" in data:
            return self.reply_json(400, {"error": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}})
        if "__no_temperature__" in text and "temperature" in data:
            return self.reply_json(400, {"error": {"message": "Unsupported value: 'temperature' does not support 0 with this model."}})
        if "__overflow__" in text:
            return self.reply_json(400, {"error": {"message": "This model's maximum context length is 8192 tokens. However, your messages resulted in 12000 tokens."}})
        if "__redirect__" in text:
            self.send_response(302); self.send_header("Location", "http://evil.example/"); self.send_header("Content-Length", "0"); self.end_headers(); return
        answer = {"answer": "Ответ через роутер.", "sourceIds": []}
        content = json.dumps(answer, ensure_ascii=False)
        if "__fenced__" in text:
            content = "Вот результат:\n```json\n" + content + "\n```"
        finish = "stop"
        if "__thinking__" in text:
            content, finish = "", "length"
        # SSE как у настоящих роутеров: HTTP/1.1, Transfer-Encoding: chunked, соединение остаётся открытым
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
        def chunk(raw):
            self.wfile.write(f"{len(raw):x}\r\n".encode() + raw + b"\r\n"); self.wfile.flush()
        try:
            if "__slow__" in text:
                for _ in range(200):
                    chunk(("data: " + json.dumps({"choices": [{"delta": {"content": "x"}}]}) + "\n\n").encode()); time.sleep(.05)
                return
            pieces = [content[i:i + 12] for i in range(0, len(content), 12)] or [""]
            for piece in pieces:
                chunk(("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False) + "\n\n").encode())
            chunk(("data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": finish}]}) + "\n\n").encode())
            if "__no_usage__" not in text:
                chunk(("data: " + json.dumps({"choices": [], "usage": USAGE}) + "\n\n").encode())
            chunk(b"data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):      # обрыв клиентом при отмене — штатный, не шум в выводе
        pass


def start(port=0):
    """Запустить макет в фоновом потоке; вернуть (сервер, порт)."""
    server = QuietServer(("127.0.0.1", port), Router)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


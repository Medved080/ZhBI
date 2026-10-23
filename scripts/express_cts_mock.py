"""Макет сервера eXpress (CTS) для проверок и живого стенда бота: токен по подписи, прямое уведомление, поиск по e-mail.

Настоящий CTS не вызывается. Сообщения, «отправленные» ботом, копятся в SENT и отдаются по GET /_mock/messages (удобно смотреть в браузере
и в curl). Состояние для проверок: STATE["fail_chat"] — этот чат отвечает «chat_not_found»; STATE["down"] — сервер отвечает 503.
Ключ макета: KEY, идентификатор бота: BOT_ID. Подпись входящих запросов к боту — sign_jwt().
"""
import base64
import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

BOT_ID = "6a05574d-f544-54ee-a8c8-5c7240f143ae"
KEY = "test-secret-key-123"
TOKEN = "tok-" + "x" * 20
SENT = []                   # (chat_id, текст, кнопки)
STATE = {"fail_chat": None, "down": False}


def signature(bot_id, key):
    return hmac.new(key.encode("utf-8"), bot_id.encode("utf-8"), hashlib.sha256).hexdigest().upper()


def sign_jwt(claims=None, key=KEY, alg="HS256"):
    claims = claims or {"iss": BOT_ID, "aud": "host", "exp": time.time() + 60}
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    h, p = b({"alg": alg, "typ": "JWT"}), b(claims)
    sig = base64.urlsafe_b64encode(hmac.new(key.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{h}.{p}.{sig}"


class Cts(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(raw))); self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/_mock/messages":
            return self._send(200, [{"chat": c, "text": t, "buttons": [b["label"] for row in (bub or []) for b in row]} for c, t, bub in SENT])
        if STATE["down"]:
            return self._send(503, {"status": "error", "reason": "unavailable"})
        prefix = f"/api/v2/botx/bots/{BOT_ID}/token?signature="
        if self.path.startswith(prefix):
            if self.path[len(prefix):] == signature(BOT_ID, KEY):
                return self._send(200, {"status": "ok", "result": TOKEN})
            return self._send(401, {"status": "error", "reason": "bad signature"})
        self._send(404, {"status": "error", "reason": "nope"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._send(401, {"status": "error", "reason": "unauthorized"})
        if STATE["down"]:
            return self._send(503, {"status": "error", "reason": "unavailable"})
        if self.path == "/api/v4/botx/notifications/direct":
            chat = body["group_chat_id"]
            if chat == STATE["fail_chat"]:
                return self._send(404, {"status": "error", "reason": "chat_not_found"})
            SENT.append((chat, body["notification"]["body"], body["notification"].get("bubble")))
            return self._send(202, {"status": "ok", "result": {"sync_id": "s-1"}})
        if self.path == "/api/v3/botx/users/by_email":
            if body["emails"] == ["known@corp.ru"]:
                return self._send(200, {"status": "ok", "result": [{"user_huid": "11111111-1111-1111-1111-111111111111", "ad_login": "known", "ad_domain": "corp", "name": "Известный"}]})
            return self._send(200, {"status": "ok", "result": []})
        self._send(404, {"status": "error", "reason": "nope"})


def start(port=0):
    server = HTTPServer(("127.0.0.1", port), Cts)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_port

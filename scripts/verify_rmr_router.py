"""Сквозная проверка облачного роутера red_mad_robot для помощника: временная копия обезличенной БД и локальный
HTTP-макет роутера. Ни один запрос не уходит во внешнюю сеть и настоящему роутеру.

    .venv312/bin/python scripts/verify_rmr_router.py

Макет отвечает как облачный роутер: HTTP/1.1 с keep-alive, ключ в Authorization: Bearer, отказы 400/401/402/429 с
текстом причины. Соединение подменяется на локальное в одном месте (`rmr_router.open_connection`), адрес же остаётся
настоящим — поэтому проверка адреса, привязки к хосту и ключа идёт тем же кодом, что в бою.
"""
import http.client
import json
import os
import socket
import sqlite3
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
work = Path(tempfile.mkdtemp(prefix="zhbi-rmr-"))
print("Test workspace:", work)
source = ROOT / "data/zhbi.anon.db"
dest = work / "work.db"
a = sqlite3.connect(source); b = sqlite3.connect(dest); a.backup(b); a.close(); b.close()
os.environ.update(ZHBI_DB_PATH=str(dest), ZHBI_CALC_DIR=str(work / "calc"), ZHBI_CALC_ASSETS_DIR=str(work / "assets"), ZHBI_CALC_RECOVERY_WORKER="0")
os.environ.pop("ZHBI_RMR_API_KEY", None)
os.environ.pop("ZHBI_RMR_PROXY", None)
for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(name, None)
from app import backups
backups.BACKUP_DIR = work / "backups"
from app.auth import hash_password
conn = sqlite3.connect(dest)
h, salt = hash_password("Test-Pass-1234!")
conn.execute("UPDATE users SET password_hash=?,password_salt=?,must_change_password=0,auth_method='local' WHERE domain_login IN ('admin','user2','user4')", (h, salt)); conn.commit(); conn.close()

import rmr_router_mock as mock
from rmr_router_mock import KEY, seen, state
server, PORT = mock.start()

import http.cookiejar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
import uvicorn


class HttpResult:
    def __init__(self, response):
        self.status_code = response.code
        self.data = response.read()

    def json(self): return json.loads(self.data)


class TestClient:
    def __init__(self, app):
        self.app = app; self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar())); self.server = None; self.port = None

    def __enter__(self):
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); self.port = sock.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(self.app, log_level="error"))
        threading.Thread(target=lambda: self.server.run(sockets=[sock]), daemon=True).start()
        for _ in range(600):
            if self.server.started: return self
            time.sleep(.05)
        raise AssertionError("сервер не запущен")

    def request(self, method, path, json_body=None):
        data = None if json_body is None else json.dumps(json_body).encode()
        req = Request(f"http://127.0.0.1:{self.port}" + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try: r = self.opener.open(req, timeout=60)
        except HTTPError as error: r = error
        return HttpResult(r)

    def get(self, path): return self.request("GET", path)
    def post(self, path, json=None): return self.request("POST", path, json)
    def put(self, path, json=None): return self.request("PUT", path, json)
    def delete(self, path): return self.request("DELETE", path)
    def __exit__(self, *args):
        if self.server: self.server.should_exit = True


from app.main import app
from app import rmr_router, rmr_pricing
from app.calc import qwen_client

# Соединение с «роутером» уходит на локальный макет; адрес в настройках остаётся настоящим.
REAL_OPEN = rmr_router.open_connection
LOCAL_OPEN = lambda parsed, timeout: http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
rmr_router.open_connection = LOCAL_OPEN

checks = 0
def check(value, label):
    global checks
    assert value, label
    checks += 1


def login(client, name):
    r = client.post("/login", json={"domain_login": name, "password": "Test-Pass-1234!"})
    check(r.status_code == 200, "вход " + name)


def conn_cfg(**kw):
    base = dict(baseUrl=rmr_router.DEFAULT_URL, model="openai/gpt-5-mini", timeoutSeconds=30, maxTokens=512)
    base.update(kw)
    return rmr_router.RouterConnection(**base)


SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}, "sourceIds": {"type": "array", "items": {"type": "string"}}}, "required": ["answer", "sourceIds"], "additionalProperties": False}
def ask(marker, cfg=None, meter=None, **kw):
    return rmr_router.chat(cfg or conn_cfg(), [{"role": "system", "content": "s"}, {"role": "user", "content": marker}], SCHEMA, "construction_assistant", meter=meter, **kw)


def raises(fn, exc, label, contains=None):
    try:
        fn()
    except exc as error:
        check(contains is None or contains in str(error), f"{label}: текст «{contains}» в «{str(error)[:200]}»")
        return error
    raise AssertionError(label + ": исключения нет")


# ---------------------------------------------------------------- адрес
for good in (rmr_router.DEFAULT_URL, "https://rmrrouter.redmadrobot.com/", "https://rmrrouter.redmadrobot.com/v1/models", "https://eu.rmrrouter.redmadrobot.com/v1"):
    rmr_router.validate_url(good); checks += 1
for bad, hint in (("http://rmrrouter.redmadrobot.com/v1", "HTTPS"), ("https://192.168.1.10:1234/v1", "другого сервера"), ("https://evilrmrrouter.redmadrobot.com/", "другого сервера"),
                  ("https://rmrrouter.redmadrobot.com.evil.example/", "другого сервера"), ("https://user:pw@rmrrouter.redmadrobot.com/", "HTTPS"),
                  ("https://rmrrouter.redmadrobot.com/v1?x=1", "HTTPS"), ("https://rmrrouter.redmadrobot.com:8443/v1", "порт"), ("", "Не задан")):
    raises(lambda u=bad: rmr_router.validate_url(u), ValueError, "адрес " + bad, hint)
check(rmr_router.api_base("https://rmrrouter.redmadrobot.com/") == "https://rmrrouter.redmadrobot.com/v1", "корень без /v1 приводится к /v1")
check(rmr_router.api_base("https://rmrrouter.redmadrobot.com/v1/chat/completions") == "https://rmrrouter.redmadrobot.com/v1", "ссылка на маршрут приводится к корню API")
check(rmr_router.api_base("https://rmrrouter.redmadrobot.com/api/v1/models") == "https://rmrrouter.redmadrobot.com/v1", "LM-Studio-подобный /api/v1")

# ---------------------------------------------------------------- прокси (без внешней сети: поддельный прокси записывает CONNECT)
seen_connect = []
def fake_proxy():
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
    def serve():
        c, _ = srv.accept(); c.settimeout(5); data = b""
        while b"\r\n\r\n" not in data: data += c.recv(4096)
        seen_connect.append(data.decode())
        c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); c.close()
    threading.Thread(target=serve, daemon=True).start()
    return srv.getsockname()[1]
from urllib.parse import urlsplit
import base64
os.environ["ZHBI_RMR_PROXY"] = ""
check(rmr_router._proxy_url("rmrrouter.redmadrobot.com") is None, "пустой ZHBI_RMR_PROXY — напрямую")
os.environ["ZHBI_RMR_PROXY"] = f"http://proxy-user:p%40ss@127.0.0.1:{fake_proxy()}"
check(rmr_router._proxy_url("rmrrouter.redmadrobot.com").startswith("http://proxy-user"), "ZHBI_RMR_PROXY имеет приоритет")
c = REAL_OPEN(urlsplit(rmr_router.DEFAULT_URL), 5)
try:
    c.connect(); raise AssertionError("туннель через поддельный прокси не должен был открыться")
except OSError as error:
    check("502" in str(error), "отказ прокси виден как ошибка соединения")
check(seen_connect and seen_connect[0].startswith("CONNECT rmrrouter.redmadrobot.com:443 HTTP/1.1"), "прокси получил CONNECT на хост и порт роутера")
check("Proxy-Authorization: Basic " in seen_connect[0], "логин и пароль прокси переданы")
check(base64.b64decode(seen_connect[0].split("Proxy-Authorization: Basic ")[1].split("\r\n")[0]).decode() == "proxy-user:p@ss", "пароль прокси раскодирован из %40")
os.environ.pop("ZHBI_RMR_PROXY")
os.environ["HTTPS_PROXY"] = "http://corp-proxy.example:3128"; os.environ["NO_PROXY"] = "rmrrouter.redmadrobot.com"
check(rmr_router._proxy_url("rmrrouter.redmadrobot.com") is None, "NO_PROXY обходит прокси")
os.environ["NO_PROXY"] = ""
check(rmr_router._proxy_url("rmrrouter.redmadrobot.com") == "http://corp-proxy.example:3128", "HTTPS_PROXY из окружения учитывается")
os.environ.pop("HTTPS_PROXY"); os.environ.pop("NO_PROXY")

# ---------------------------------------------------------------- API настроек
with TestClient(app) as client:
    login(client, "user4")
    for path, method in (("/ai/router/config", "get"), ("/ai/router/billing", "get")):
        check(getattr(client, method)(path).status_code in (401, 403), f"обычному пользователю {path} закрыт")
    check(client.put("/ai/router/key", {"key": KEY}).status_code in (401, 403), "обычный пользователь не может задать ключ")

with TestClient(app) as client:
    login(client, "admin")
    cfg0 = client.get("/ai/router/config")
    check(cfg0.status_code == 200, "настройки читаются")
    c0 = cfg0.json()
    check(c0["enabled"] is False and c0["dataConsent"] is False and c0["key"] == {"configured": False, "source": None}, "по умолчанию роутер выключен, ключа нет")
    check(c0["baseUrl"] == rmr_router.DEFAULT_URL and "rmrrouter.redmadrobot.com" in c0["dataNotice"], "адрес по умолчанию и предупреждение о выходе данных")
    body = {k: c0[k] for k in ("enabled", "dataConsent", "baseUrl", "model", "timeoutSeconds", "jsonMode", "tokenParameter", "thinking")}
    def put(**kw):
        cur = client.get("/ai/router/config").json()
        return client.put("/ai/router/config", {**body, **kw, "expectedRevision": cur["revision"]})
    check(put(enabled=True, model="openai/gpt-5-mini").status_code == 422, "включить без подтверждения нельзя")
    check(put(enabled=True, dataConsent=True, model="openai/gpt-5-mini").status_code == 422, "включить без ключа нельзя")
    check(client.put("/ai/router/key", {"key": "short"}).status_code == 422, "слишком короткий ключ отвергается")
    check(client.put("/ai/router/key", {"key": "has space in key 123"}).status_code == 422, "ключ с пробелами отвергается")
    r = client.put("/ai/router/key", {"key": KEY})
    check(r.status_code == 200 and r.json()["key"] == {"configured": True, "source": "form"}, "ключ сохранён")
    check(KEY not in r.data.decode(), "ответ на сохранение ключа не содержит ключа")
    secrets_file = rmr_router.secret_path()
    check(secrets_file.exists() and stat.S_IMODE(secrets_file.stat().st_mode) == 0o600, "файл секретов с правами 0600")
    check(secrets_file.parent == dest.parent and KEY in secrets_file.read_text(), "ключ лежит рядом с файлом базы, не в ней")
    db = sqlite3.connect(dest)
    check(not any(KEY in str(v) for row in db.execute("SELECT value FROM app_settings") for v in row), "ключа нет в app_settings")
    db.close()
    check(KEY not in client.get("/ai/router/config").data.decode(), "чтение настроек не отдаёт ключ")
    check(put(enabled=True, dataConsent=True, model="").status_code == 422, "включить без модели нельзя")
    check(put(baseUrl="http://192.168.1.10:1234/v1").status_code == 422, "чужой адрес в поле отвергается")
    check("другого сервера" in put(baseUrl="https://example.com/v1").json()["detail"], "причина отказа названа")
    stale = client.get("/ai/router/config").json()["revision"]
    saved = put(dataConsent=True, model="openai/gpt-5-mini")
    check(saved.status_code == 200 and saved.json()["dataConsent"] is True, "подтверждение и модель сохраняются (роутер ещё выключен)")
    conflict = client.put("/ai/router/config", {**body, "dataConsent": True, "expectedRevision": stale})
    check(conflict.status_code == 409, "форма со старой версией получает 409")

    # список моделей и проверка
    r = client.post("/ai/router/models", {"baseUrl": rmr_router.DEFAULT_URL})
    check(r.status_code == 200 and [m["id"] for m in r.json()["models"]][0] == "openai/gpt-5-mini", "список моделей получен с ключом")
    check(any(s[0] == "GET" and s[2] == f"Bearer {KEY}" for s in seen), "список моделей запрошен с ключом")
    check(client.post("/ai/router/models", {"baseUrl": "https://example.com/v1"}).status_code == 422, "список моделей чужого адреса не запрашивается")
    n_before = len(seen)
    r = client.post("/ai/router/test", {})
    check(r.status_code == 200 and r.json()["ok"] and r.json()["modelListed"], f"проверка подключения прошла: {r.data[:200]}")
    check(r.json()["usage"]["prompt"] == 1200 and r.json()["costRub"] and r.json()["costRub"] > 0, "проверка посчитала токены и стоимость")
    check(len(seen) - n_before == 2, "проверка = список моделей + один ответ")
    # включение
    r = put(enabled=True, dataConsent=True, model="openai/gpt-5-mini")
    check(r.status_code == 200 and r.json()["enabled"], "роутер включён")

    # ---- помощник через роутер
    st = client.get("/assistant/status").json()
    check(st == {"enabled": True, "configured": True}, "статус помощника не раскрывает ни адрес, ни ключ, ни поставщика")
    seen.clear()
    start = client.post("/ai/dialog-test", {})
    check(start.status_code == 202, f"проверка диалога принята: {start.data[:200]}")
    job = start.json()
    for _ in range(300):
        job = client.get("/assistant/requests/" + job["id"]).json()
        if job["state"] != "running": break
        time.sleep(.1)
    check(job["state"] == "done" and job["answer"] == "Ответ через роутер.", f"ответ получен через роутер: {job}")
    check(job["provider"] == "red_mad_router" and job["model"] == "openai/gpt-5-mini", "в ответе указан поставщик и модель")
    posts = [s for s in seen if s[0] == "POST"]
    check(posts and all(s[2] == f"Bearer {KEY}" for s in posts), "каждый запрос к роутеру — с ключом")
    check("chat_template_kwargs" not in posts[0][3] and "reasoning_effort" not in posts[0][3], "параметры отключения рассуждений не отправляются при «Как у модели»")
    check(posts[0][3]["response_format"]["type"] == "json_schema" and posts[0][3]["stream_options"] == {"include_usage": True}, "формат по схеме и учёт токенов в потоке запрошены")
    check(any(x["label"] == "Подключаемся к облачному роутеру" for x in job["progress"]["steps"]), "в ходе работы названо облако")
    time.sleep(2.5)         # журнал пишется фоновым потоком пачками
    db = sqlite3.connect(dest)
    events = db.execute("SELECT details, user_name FROM activity_log WHERE action='ai_router_usage' ORDER BY id").fetchall()
    check(len(events) == 2, f"в журнале расход проверки и вопроса: {len(events)}")
    detail = json.loads(events[-1][0])
    check(detail["токены вход"] == 1200 and detail["токены выход"] == 300 and detail["модель"] == "openai/gpt-5-mini" and detail["стоимость без НДС, ₽"] > 0, f"расход записан со стоимостью: {detail}")
    check(not any(KEY in (r[0] or "") for r in db.execute("SELECT details FROM activity_log")), "ключа нет ни в одном событии журнала")
    kinds = {r[0] for r in db.execute("SELECT action FROM activity_log WHERE action LIKE 'ai_router%'")}
    check({"ai_router_settings", "ai_router_key", "ai_router_usage"} <= kinds, f"события журнала: {kinds}")
    db.close()
    bill = client.get("/ai/router/billing").json()
    check(bill["current"] == "openai/gpt-5-mini" and bill["usage"]["period"]["requests"] == 2 and bill["usage"]["period"]["tokens_in"] == 2400, f"сводка расхода: {bill['usage']['period']}")
    check(bill["usage"]["models"][0]["model"] == "openai/gpt-5-mini" and bill["usage"]["period"]["rub"] > 0, "расход по моделям с рублями")
    gpt = next(m for m in bill["models"] if m["id"] == "openai/gpt-5-mini")
    check(gpt["per_question"] > 0 and gpt["per_question_max"] > gpt["per_question"], "оценка стоимости вопроса и максимума")
    check(bill["billing_url"] == rmr_router.BILLING_URL and bill["vat_percent"] == 22, "ссылка на биллинг роутера и НДС")

    # ---- отзыв: роутер выключен — помощник возвращается к локальной модели (здесь она не настроена => отказ без обращения к роутеру)
    seen.clear()
    put(enabled=False)
    start = client.post("/ai/dialog-test", {})
    check(start.status_code == 422 and not any(s[0] == "POST" for s in seen), "выключенный роутер не получает вопросов")
    check(client.delete("/ai/router/key").json()["key"]["configured"] is False, "ключ удалён")
    check(not rmr_router.secret_path().read_text().count(KEY), "в файле секретов ключа больше нет")
    client.put("/ai/router/key", {"key": KEY})

# ---------------------------------------------------------------- клиент: подбор параметров, ошибки, учёт
rmr_router._learned.clear()
m = rmr_router.UsageMeter()
v = ask("обычный вопрос", meter=m)
check(v["answer"] == "Ответ через роутер." and m.as_dict() == {"prompt": 1200, "completion": 300, "requests": 1, "estimated": False}, "обычный ответ и токены из usage")
m = rmr_router.UsageMeter(); ask("__no_usage__ вопрос", meter=m)
check(m.estimated and m.prompt > 0 and m.completion > 0, "без usage расход оценивается по длине и помечается")

seen.clear(); rmr_router._learned.clear()
ask("__no_schema__ вопрос")
modes = [s[3].get("response_format", {}).get("type") for s in seen if s[0] == "POST"]
check(modes == ["json_schema", "json_object"], f"формат по схеме сменился на JSON-объект после отказа: {modes}")
seen.clear(); ask("__no_schema__ ещё вопрос")
check([s[3].get("response_format", {}).get("type") for s in seen if s[0] == "POST"] == ["json_object"], "найденный формат запомнен: повторного отказа нет")

seen.clear(); rmr_router._learned.clear()
ask("__completion_param__ вопрос")
posts = [s[3] for s in seen if s[0] == "POST"]
check("max_tokens" in posts[0] and "max_completion_tokens" in posts[1] and "max_tokens" not in posts[1], "параметр лимита сменился на max_completion_tokens")

seen.clear(); rmr_router._learned.clear()
ask("__no_temperature__ вопрос")
posts = [s[3] for s in seen if s[0] == "POST"]
check("temperature" in posts[0] and "temperature" not in posts[1], "температура снята после отказа модели")

seen.clear(); rmr_router._learned.clear(); state["calls"] = 0
naps = []
ask("__429__ вопрос", sleep=lambda s: naps.append(s))
check(len([s for s in seen if s[0] == "POST"]) == 2 and naps, "временный отказ 429 повторён после паузы")

check(ask("__fenced__ вопрос")["answer"] == "Ответ через роутер.", "ответ в ограде ```json с пояснением разобран")
err = raises(lambda: ask("__402__ вопрос"), qwen_client.InferenceError, "402", "баланс")
err = raises(lambda: ask("__overflow__ вопрос"), rmr_router.ContextOverflow, "переполнение")
check(err.n_ctx == 8192 and err.n_prompt == 12000, f"предел и размер запроса выделены из ответа облака: {err.n_ctx}/{err.n_prompt}")
err = raises(lambda: ask("__redirect__ вопрос"), qwen_client.InferenceError, "перенаправление", "перенаправляет")
err = raises(lambda: ask("__thinking__ вопрос"), qwen_client.InferenceTruncated, "лимит")
check(err.thinking, "пустой ответ при исчерпанном лимите распознан как рассуждение")

# ключ, повторённый сервером в тексте отказа, из сообщения убирается
os.environ.pop(rmr_router.ENV_KEY, None)
rmr_router.clear_key(); rmr_router.set_key("sk-rmr-WRONG-0123456789")
err = raises(lambda: ask("обычный"), qwen_client.InferenceError, "неверный ключ", "HTTP 401")
check("sk-rmr-WRONG-0123456789" not in str(err), "ключ из ответа сервера скрыт в сообщении")
err = raises(lambda: rmr_router.list_models(rmr_router.DEFAULT_URL), qwen_client.InferenceError, "список с неверным ключом", "не принял ключ")
check("sk-rmr-WRONG-0123456789" not in str(err), "ключ скрыт и в ошибке списка моделей")
rmr_router.clear_key()
raises(lambda: ask("обычный"), qwen_client.InferenceError, "без ключа", "Ключ роутера не задан")
os.environ[rmr_router.ENV_KEY] = KEY
check(rmr_router.key_state() == {"configured": True, "source": "env"} and ask("обычный")["answer"], "ключ из окружения сервера работает")
os.environ.pop(rmr_router.ENV_KEY)
rmr_router.set_key(KEY)

# через недоступный прокси: понятное объяснение, а не голое исключение сокета
rmr_router.open_connection = REAL_OPEN
os.environ["ZHBI_RMR_PROXY"] = f"http://127.0.0.1:{fake_proxy()}"
err = raises(lambda: ask("обычный"), qwen_client.InferenceError, "прокси отказал", "Роутер недоступен")
check("HTTPS_PROXY" in str(err) and "rmrrouter.redmadrobot.com:443" in str(err), "в ошибке подсказка про доступ и прокси для DevOps")
os.environ.pop("ZHBI_RMR_PROXY")
rmr_router.open_connection = LOCAL_OPEN

# отмена посреди потока прерывает чтение
t0 = time.time()
stop = {"now": False}; threading.Timer(.4, lambda: stop.update(now=True)).start()
raises(lambda: ask("__slow__ вопрос", cancel=lambda: stop["now"]), qwen_client.InferenceCancelled, "отмена")
check(time.time() - t0 < 5, "отмена не ждёт конца ответа")

# ---------------------------------------------------------------- локальный клиент не затронут
cfg_local = type("C", (), {"model": "m", "baseUrl": "https://rmrrouter.redmadrobot.com/v1", "provider": "openai"})()
raises(lambda: qwen_client.validate_endpoint(cfg_local, type("S", (), {"qwen_allowed_hosts": ()})()), ValueError, "локальный клиент по-прежнему отвергает внешний адрес", "внутренней сети")

print(f"OK: {checks} проверок")

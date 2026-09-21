"""Проверка выбора интерфейса на корневом адресе (ограниченный выпуск V2, 2026-09-21).

Запуск (сервер уже поднят, например на изолированной копии БД): python3 scripts/check_ui_routing.py http://127.0.0.1:8061
Требования: `/` — всегда V1, даже со старой cookie `ui_version=v2`; V2 — только явно (`/v2` или `/?ui=v2`); `/?ui=v1` — V1;
устаревшая cookie стирается. Только GET, только стандартная библиотека; определение версии — по заголовку страницы.
"""
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8061").rstrip("/")
fails = 0


def get(path, cookie=None):
    req = urllib.request.Request(BASE + path, headers={"Cookie": cookie} if cookie else {})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8"), r.headers.get_all("Set-Cookie") or []


def which(html):
    return "v2" if "новый интерфейс (предпросмотр)" in html.lower() or 'src="/static/v2/main.js"' in html else "v1"


def check(cond, label):
    global fails
    print(("  ok   " if cond else "  FAIL ") + label)
    fails += 0 if cond else 1


def erased(cookies):
    return any(c.lower().startswith("ui_version=") and ("max-age=0" in c.lower() or "expires=" in c.lower()) for c in cookies)


html, ck = get("/")
check(which(html) == "v1", "GET / без cookie — V1")
check(not ck, "без cookie ничего не выставляется и не стирается")
html, ck = get("/", "ui_version=v2")
check(which(html) == "v1", "старая cookie ui_version=v2 НЕ переводит в V2")
check(erased(ck), "устаревшая cookie стирается")
html, ck = get("/?ui=v2")
check(which(html) == "v2", "GET /?ui=v2 — V2 (явный выбор)")
check(not any(c.startswith("ui_version=v2") for c in ck), "выбор V2 не запоминается cookie")
html, _ = get("/v2")
check(which(html) == "v2", "GET /v2 — V2 (прямой адрес)")
html, ck = get("/?ui=v1", "ui_version=v2")
check(which(html) == "v1" and erased(ck), "GET /?ui=v1 — V1 и сброс cookie")
html, _ = get("/?ui=%D0%BC%D1%83%D1%81%D0%BE%D1%80")
check(which(html) == "v1", "неизвестное значение ui — V1")
sys.exit(1 if fails else 0)

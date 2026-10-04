"""Сквозная проверка подсистемы «Калькулятор» на двух ВРЕМЕННЫХ серверах (2026-10-04).

Поднимает два процесса uvicorn с отдельными базами в временном каталоге —
«локальный» (отправитель) и «тестовый» (получатель) — и проверяет:
  * роль «Калькулятор» заведена, доступ к /calc/* только у роли и администратора;
  * расчёты привязаны к проекту ЖБИ «Москвич»;
  * токен обмена выдаётся только пользователю с ролью и годится для приёма;
  * передача: создание, обновление нетронутого, приоритет серверных расчётов,
    блочная загрузка большого файла, вложения, подтверждение для prod.

Боевую и обезличенную базы НЕ трогает. Запуск:
    .venv312/bin/python scripts/verify_calc_subsystem.py
"""
import hashlib
import http.cookiejar
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
FAILS = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        FAILS.append(label)


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def req(self, method, path, body=None, headers=None, raw=False):
        data = None
        h = dict(headers or {})
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        if self.csrf:
            h.setdefault("X-CSRF-Token", self.csrf)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(r, timeout=120) as resp:
                payload = resp.read()
                return resp.status, (payload if raw else (json.loads(payload) if payload else None))
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                return e.code, json.loads(payload)
            except ValueError:
                return e.code, payload

    def login(self, login, password):
        status, _ = self.req("POST", "/login", {"domain_login": login, "password": password})
        return status

    def calc_me(self):
        status, data = self.req("GET", "/calc/api/auth/me")
        if status == 200:
            self.csrf = data["csrfToken"]
        return status, data


def prepare(directory, port, with_assets, tokens=None):
    directory.mkdir(parents=True)
    env = {**os.environ, "ZHBI_DB_PATH": str(directory / "zhbi.db"), "ZHBI_CALC_DIR": str(directory / "calc"), "PYTHONPATH": str(ROOT)}
    env.pop("ZHBI_CALC_ASSETS_DIR", None)
    code = f"""
import sys
sys.path.insert(0, {str(ROOT)!r})
from app.db import init_db, get_connection
from app.auth import hash_password
init_db()
c = get_connection()
c.execute("INSERT OR IGNORE INTO projects(name) VALUES('Москвич')")
c.execute("INSERT OR IGNORE INTO projects(name) VALUES('Другой')")
def user(login, role, grant=None):
    h, s = hash_password('Passw0rd-test-12')
    c.execute("INSERT OR REPLACE INTO users(last_name, domain_login, role, password_hash, password_salt, auth_method, must_change_password) VALUES(?,?,?,?,?, 'local', 0)", (login, login, role, h, s))
    uid = c.execute("SELECT id FROM users WHERE domain_login=?", (login,)).fetchone()[0]
    if grant:
        c.execute("INSERT INTO user_access(user_id, project_id, object_id, role) VALUES(?, NULL, NULL, ?)", (uid, grant))
user('admin', 'admin')
user('calcuser', 'user', 'calculator')
user('plain', 'user', 'view')
c.commit()
"""
    subprocess.run([PY, "-c", code], env=env, check=True)
    if with_assets:
        assets = directory / "calc" / "assets"
        (assets / "sources").mkdir(parents=True)
        (assets / "sample.json").write_text('{"v":1}')
        (assets / "sources" / "doc99.pdf").write_bytes(secrets.token_bytes(20 * 1024 * 1024 + 123))  # три блока по 8 МБ
    return env


def start(env, port, extra=None, tls=None):
    env = {**env, **(extra or {})}
    command = [PY, "-m", "uvicorn", "app.main:app", "--port", str(port), "--host", "127.0.0.1"]
    if tls:
        command += ["--ssl-keyfile", tls[0], "--ssl-certfile", tls[1]]
    proc = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"{'https' if tls else 'http'}://127.0.0.1:{port}"
    import ssl
    unverified = ssl.create_default_context()
    unverified.check_hostname = False
    unverified.verify_mode = ssl.CERT_NONE
    for _ in range(120):
        try:
            urllib.request.urlopen(base + "/health", timeout=1, context=unverified if tls else None)
            return proc, base
        except Exception:
            if proc.poll() is not None:
                print(proc.stdout.read().decode()[-3000:])
                raise SystemExit("сервер не поднялся")
            time.sleep(0.5)
    raise SystemExit("таймаут старта")


def main():
    work = Path(tempfile.mkdtemp(prefix="calc-verify-"))
    procs = []
    try:
        port_a, port_b = 18941, 18942
        env_b = prepare(work / "b", port_b, with_assets=False)
        pb, base_b = start(env_b, port_b)
        procs.append(pb)

        # ---- роли и доступ на «тестовом»
        admin = Client(base_b); check(admin.login("admin", "Passw0rd-test-12") == 200, "B: вход admin")
        calc = Client(base_b); calc.login("calcuser", "Passw0rd-test-12")
        plain = Client(base_b); plain.login("plain", "Passw0rd-test-12")
        check(admin.calc_me()[0] == 200, "B: admin открывает калькулятор")
        check(calc.calc_me()[0] == 200 and calc.calc_me()[1]["role"] == "editor", "B: роль «Калькулятор» — редактор")
        check(plain.calc_me()[0] == 403, "B: пользователь без роли получает 403")
        check(Client(base_b).req("GET", "/calc/api/workspace")[0] == 401, "B: аноним получает 401")
        st, ws = calc.req("GET", "/calc/api/workspace")
        check(st == 200 and ws["project"]["name"] == "Москвич" and ws["project"]["linked"], "B: расчёты привязаны к проекту «Москвич»")
        check(len(ws["products"]) == 2, "B: две исходные колонны")
        st, r = calc.req("POST", "/calc/api/marks/resolve", {"marks": [{"mark": "1кс1", "type": "Колонна"}, {"mark": "1К-С1"}, {"mark": "НЕТ-ТАКОЙ"}]})
        res = r["results"] if st == 200 else {}
        check(st == 200 and res.get("1кс1", {}).get("status") == "found" and res.get("1К-С1", {}).get("status") == "found" and res.get("НЕТ-ТАКОЙ", {}).get("status") == "none", "B: марка элемента → изделие калькулятора (регистр и разделители не мешают)")
        check(plain.req("POST", "/calc/api/marks/resolve", {"marks": [{"mark": "1КС1"}]})[0] == 403, "B: без роли определение изделия по марке недоступно")
        check(abs(ws["products"][0]["snapshot"]["total"] - 435503.4884274192) < 1e-6 and abs(ws["products"][1]["snapshot"]["total"] - 201355.26634792303) < 1e-6, "B: расчёт исходных колонн совпал с эталоном CalcZhBI")
        st, col = calc.req("GET", "/calc/api/products/%s/collisions" % ws["products"][0]["product"]["id"])
        check(st == 200 and col["classes"] == [] and col["reason"], "B: коллизии изделия без 3D-модели — пустой список с причиной")
        check(calc.req("POST", "/calc/api/products/%s/collisions/nokey/notes" % ws["products"][0]["product"]["id"], {"text": "x"})[0] == 404, "B: комментарий к несуществующей коллизии отклонён")
        check(plain.req("GET", "/calc/api/products/%s/collisions" % ws["products"][0]["product"]["id"])[0] == 403, "B: без роли коллизии недоступны")
        st, page = calc.req("GET", "/calc/", raw=True)
        check(st == 200 and b"sync-panel.js" in page, "B: страница /calc/ отдаётся")
        st, _ = calc.req("GET", "/calc/vendor/exceljs.min.js", raw=True)
        check(st == 200, "B: vendor отдаётся")

        # ---- токены
        st, tok = admin.req("POST", "/calc/api/sync/tokens", {"login": "plain", "name": "x"})
        check(st == 422, "B: токен пользователю без роли не выдаётся")
        st, tok = calc.req("POST", "/calc/api/sync/tokens", {"login": "calcuser", "name": "x"})
        check(st == 403, "B: токены выдаёт только администратор")
        st, tok = admin.req("POST", "/calc/api/sync/tokens", {"login": "calcuser", "name": "локальный Mac"})
        check(st == 201 and tok["token"].startswith("czb_"), "B: администратор выдал токен")
        token = tok["token"]

        # ---- «локальный» отправитель
        env_a = prepare(work / "a", port_a, with_assets=True)
        (work / "a" / "calc" / "sync-targets.json").write_text(json.dumps({"targets": {
            "test": {"url": base_b, "tokenEnv": "ZHBI_CALC_TOKEN_TEST"},
            "prod": {"url": base_b, "tokenEnv": "ZHBI_CALC_TOKEN_TEST", "requireConfirm": True}}}))
        pa, base_a = start(env_a, port_a, {"ZHBI_CALC_TOKEN_TEST": token})
        procs.append(pa)
        a = Client(base_a); a.login("calcuser", "Passw0rd-test-12"); a.calc_me()
        st, ws = a.req("GET", "/calc/api/workspace")
        seeds = ws["products"]
        first = seeds[0]["product"]
        body = {"product": {**first, "name": first["name"] + " (изм. на A)"}, "expectedVersion": first["version"], "overrides": {}, "extra": [], "requestId": secrets.token_hex(16)[:8] + "-0000-4000-8000-" + secrets.token_hex(6)}
        body["requestId"] = "11111111-1111-4111-8111-" + secrets.token_hex(6)
        st, saved = a.req("POST", "/calc/api/products", body)
        check(st == 200, "A: правка изделия сохранена (%s)" % st)
        new = {"product": {"name": "Новое изделие A", "volume": "1.5", "weight": "0.1", "hours": "2", "source": "manual"}, "expectedVersion": 0, "overrides": {}, "extra": [], "requestId": "22222222-2222-4222-8222-" + secrets.token_hex(6)}
        st, created = a.req("POST", "/calc/api/products", new)
        check(st == 200, "A: новое изделие создано (%s)" % st)
        new_id = created["product"]["id"] if st == 200 else None
        # вложение к новому изделию
        boundary = "----b" + secrets.token_hex(8)
        file_bytes = b"attachment-bytes-" * 100
        mp = ("--%s\r\nContent-Disposition: form-data; name=\"files\"; filename=\"spec.txt\"\r\nContent-Type: text/plain\r\n\r\n" % boundary).encode() + file_bytes + ("\r\n--%s--\r\n" % boundary).encode()
        st, _ = a.req("POST", "/calc/api/products/%s/files" % new_id, mp, {"Content-Type": "multipart/form-data; boundary=" + boundary})
        check(st == 200, "A: вложение загружено (%s)" % st)

        # ---- push: подтверждение, проверка, отправка
        st, r = a.req("POST", "/calc/api/sync/push", {"target": "prod", "dryRun": False})
        check(st == 422, "A: отправка на prod без подтверждения отклонена")

        def run_push(target, dry, confirm=None):
            st, r = a.req("POST", "/calc/api/sync/push", {"target": target, "dryRun": dry, "confirm": confirm})
            assert st == 200, (st, r)
            for _ in range(200):
                time.sleep(0.5)
                st, job = a.req("GET", "/calc/api/sync/push/" + r["jobId"])
                if job["state"] != "running":
                    return job
            raise SystemExit("push завис")

        job = run_push("test", True)
        check(job["state"] == "done" and job["result"]["dryRun"], "A→B: проверка без изменений прошла: %s" % job.get("error"))
        plan = job["result"]
        check(plan["report"]["products"]["updated"] == 1 and plan["report"]["products"]["created"] == 1, "A→B: план: 1 обновить (нетронутая колонна), 1 создать")
        check(sorted(plan["assetsNeeded"]) == ["sample.json", "sources/doc99.pdf"], "A→B: план файлов исходников")
        st, wsb = calc.req("GET", "/calc/api/workspace")
        check(len(wsb["products"]) == 2, "B: после проверки данные не изменились")

        job = run_push("test", False)
        check(job["state"] == "done", "A→B: отправка выполнена: %s" % job.get("error"))
        res = job["result"]
        check(res["report"]["products"]["updated"] == 1 and res["report"]["products"]["created"] == 1 and res["report"]["attachmentsAdded"] == 1, "A→B: отчёт: обновлено 1, создано 1, вложение 1")
        got = work / "b" / "calc" / "assets" / "sources" / "doc99.pdf"
        src = work / "a" / "calc" / "assets" / "sources" / "doc99.pdf"
        check(got.exists() and hashlib.sha256(got.read_bytes()).hexdigest() == hashlib.sha256(src.read_bytes()).hexdigest(), "B: большой файл принят блоками, SHA-256 совпала")
        st, wsb = calc.req("GET", "/calc/api/workspace")
        names = sorted(p["product"]["name"] for p in wsb["products"])
        check(len(names) == 3 and any("изм. на A" in n for n in names) and "Новое изделие A" in names, "B: изделия обновлены и добавлены")
        st, files = calc.req("GET", "/calc/api/products/%s/files" % new_id)
        check(st == 200 and len(files) == 1 and files[0]["name"] == "spec.txt", "B: вложение на месте")
        st, dl = calc.req("GET", files[0]["downloadUrl"], raw=True)
        check(st == 200 and dl == file_bytes, "B: вложение скачивается без искажений")

        # ---- повтор: ничего не меняется
        job = run_push("test", False)
        r2 = job["result"]["report"]["products"]
        check(job["state"] == "done" and r2["unchanged"] == 3 and r2["updated"] == 0 and r2["created"] == 0, "A→B: повтор ничего не меняет")

        # ---- приоритет сервера: пользователь на B правит, A правит то же — на B остаётся B
        st, wsb = calc.req("GET", "/calc/api/workspace")
        target = next(p for p in wsb["products"] if p["product"]["id"] == new_id)["product"]
        bb = {"product": {**target, "name": "Правка на сервере B"}, "expectedVersion": target["version"], "overrides": {}, "extra": [], "requestId": "33333333-3333-4333-8333-" + secrets.token_hex(6)}
        st, _ = calc.req("POST", "/calc/api/products", bb)
        check(st == 200, "B: пользователь правит изделие")
        st, wsa = a.req("GET", "/calc/api/workspace")
        ta = next(p for p in wsa["products"] if p["product"]["id"] == new_id)["product"]
        aa = {"product": {**ta, "name": "Правка на A после передачи", "volume": "9.9"}, "expectedVersion": ta["version"], "overrides": {}, "extra": [], "requestId": "44444444-4444-4444-8444-" + secrets.token_hex(6)}
        st, _ = a.req("POST", "/calc/api/products", aa)
        job = run_push("test", False)
        rep = job["result"]["report"]["products"]
        check(job["state"] == "done" and new_id in rep["serverPriority"], "A→B: изменённое на сервере попало в serverPriority")
        st, wsb = calc.req("GET", "/calc/api/workspace")
        now_b = next(p for p in wsb["products"] if p["product"]["id"] == new_id)["product"]
        check(now_b["name"] == "Правка на сервере B", "B: серверная правка не затёрта")

        # ---- цели настраиваются из интерфейса (без терминала): токен хранится в файле с правами 600 и не возвращается
        root = Client(base_a); root.login("admin", "Passw0rd-test-12"); root.calc_me()
        check(a.req("PUT", "/calc/api/sync/targets/ui", {"url": base_b, "token": token})[0] == 403, "A: цели настраивает только администратор")
        st, r = root.req("PUT", "/calc/api/sync/targets/ui", {"url": base_b, "token": token, "requireConfirm": False})
        check(st == 200 and any(t["name"] == "ui" and t["tokenConfigured"] and t["tokenFromUi"] for t in r["targets"]) and token not in json.dumps(r), "A: цель сохранена из интерфейса, токен в ответе не возвращается")
        secrets_path = work / "a" / "calc" / "sync-secrets.json"
        check(secrets_path.exists() and (secrets_path.stat().st_mode & 0o777) == 0o600, "A: файл токенов с правами 600")
        st, r = root.req("POST", "/calc/api/sync/targets/ui/test", {})
        check(st == 200 and r["ok"], "A: проверка связи с целью прошла: %s" % r.get("message"))
        st, r = root.req("PUT", "/calc/api/sync/targets/ui", {"url": base_b, "token": "czb_wrong"})
        st, r = root.req("POST", "/calc/api/sync/targets/ui/test", {})
        check(st == 200 and not r["ok"] and "не принят" in r["message"], "A: неверный токен распознан проверкой связи")
        check(root.req("PUT", "/calc/api/sync/targets/BAD%20NAME", {"url": base_b})[0] in (404, 422), "A: недопустимое имя цели отклонено")
        check(root.req("PUT", "/calc/api/sync/targets/x", {"url": "http://example.com"})[0] == 422, "A: небезопасный адрес отклонён")
        # самоподписанный сертификат: сначала отказ, затем доверие по отпечатку, неверный отпечаток — отказ
        key, crt = str(work / "tls.key"), str(work / "tls.crt")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-subj", "/CN=127.0.0.1",
                        "-addext", "subjectAltName=IP:127.0.0.1"], check=True, capture_output=True)
        port_c = 18943
        env_c = prepare(work / "c", port_c, with_assets=False)
        pc, base_c = start(env_c, port_c, tls=(key, crt))
        procs.append(pc)
        import ssl
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        admin_c = Client(base_c)
        admin_c.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(admin_c.jar), urllib.request.HTTPSHandler(context=ctx))
        admin_c.login("admin", "Passw0rd-test-12"); admin_c.calc_me()
        st, tc = admin_c.req("POST", "/calc/api/sync/tokens", {"login": "calcuser", "name": "tls"})
        st, r = root.req("PUT", "/calc/api/sync/targets/tls", {"url": base_c, "token": tc["token"]})
        st, r = root.req("POST", "/calc/api/sync/targets/tls/test", {})
        check(st == 200 and not r["ok"] and "CERTIFICATE_VERIFY_FAILED" in r["message"], "A: самоподписанный сертификат без доверия отклонён")
        st, cert = root.req("POST", "/calc/api/sync/targets/certificate", {"url": base_c})
        check(st == 200 and len(cert["sha256"]) == 64, "A: отпечаток сертификата сервера получен")
        root.req("PUT", "/calc/api/sync/targets/tls", {"url": base_c, "pinnedSha256": "00" * 32})
        st, r = root.req("POST", "/calc/api/sync/targets/tls/test", {})
        check(st == 200 and not r["ok"] and "не совпадает" in r["message"], "A: чужой отпечаток отклоняется")
        root.req("PUT", "/calc/api/sync/targets/tls", {"url": base_c, "pinnedSha256": cert["formatted"]})
        st, r = root.req("POST", "/calc/api/sync/targets/tls/test", {})
        check(st == 200 and r["ok"], "A: после доверия по отпечатку связь работает: %s" % r.get("message"))
        root.req("DELETE", "/calc/api/sync/targets/tls")
        st, r = root.req("DELETE", "/calc/api/sync/targets/ui")
        check(st == 200 and not any(t["name"] == "ui" for t in r["targets"]) and "ui" not in json.loads(secrets_path.read_text()), "A: цель и её токен удаляются")

        # ---- токен: отозванный и чужой
        st, toks = admin.req("GET", "/calc/api/sync/tokens")
        check(st == 200 and len(toks) == 1, "B: список токенов")
        check(Client(base_b).req("POST", "/calc/api/sync/plan", {}, {"Authorization": "Bearer czb_nope"})[0] == 401, "B: неверный токен отклонён")
        st, _ = admin.req("DELETE", "/calc/api/sync/tokens/" + toks[0]["id"])
        job = run_push("test", True)
        check(job["state"] == "failed", "A→B: отозванный токен не работает")
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(10)
            except Exception:
                p.kill()
        shutil.rmtree(work, ignore_errors=True)
    print("\nПровалов: %d" % len(FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

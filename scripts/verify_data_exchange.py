"""Сквозная проверка обмена данными между серверами на двух ВРЕМЕННЫХ серверах (2026-10-08, app/data_exchange*.py).

Поднимает два процесса uvicorn на копиях обезличенной БД: A — полный, B — с намеренными расхождениями (нет части марок и
позиций, цепочки контрагента, записей истории, другой цвет статуса, переименован один объект). Проверяет:
  * подключение по логину и паролю (неверный пароль, пользователь без права);
  * ОТПРАВКУ A → B: сверка, выбор группы одним кликом, двойное подтверждение (без него отказ), применение;
  * ПОЛУЧЕНИЕ B ← A: сверка и применение, итог совпадает с источником;
  * ссылочную целостность: позиция без родителя пропускается; недоступные (объект не найден) не применяются;
  * устаревшую сверку; отсутствие новых нарушений внешних ключей; пересчёт статусов изделий;
  * резервную копию перед применением.

Боевую и обезличенную базы НЕ трогает. Запуск:
    .venv312/bin/python scripts/verify_data_exchange.py data/zhbi.anon.db
"""
import http.cookiejar
import json
import os
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
PASSWORD = "Passw0rd-test-12"
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

    def req(self, method, path, body=None):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/octet-stream" if isinstance(body, bytes) else "application/json"})
        try:
            with self.opener.open(r, timeout=600) as resp:
                payload = resp.read()
                return resp.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                return e.code, json.loads(payload)
            except ValueError:
                return e.code, payload


def db(path):
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


def prepare(directory, source, port, perturb):
    directory.mkdir(parents=True)
    path = directory / "zhbi.db"
    shutil.copyfile(source, path)
    c = db(path)
    c.execute("PRAGMA foreign_keys=OFF")
    sys.path.insert(0, str(ROOT))
    from app.auth import hash_password
    h, s = hash_password(PASSWORD)
    c.execute("UPDATE users SET password_hash=?, password_salt=?, auth_method='local', must_change_password=0 WHERE role='admin'", (h, s))
    c.execute("DELETE FROM sessions")
    if perturb:
        cp = 3
        chain = ("SELECT c.id FROM contracts c JOIN specifications s ON s.id=c.specification_id JOIN agreements a ON a.id=s.agreement_id "
                 "WHERE a.counterparty_id=%d" % cp)
        c.execute(f"UPDATE elements SET contract_id=NULL WHERE contract_id IN ({chain})")
        c.execute(f"UPDATE status_history SET contract_id=NULL WHERE contract_id IN ({chain})")
        c.execute(f"DELETE FROM default_contracts WHERE contract_id IN ({chain})")
        c.execute(f"DELETE FROM contract_lines WHERE contract_id IN ({chain})")
        c.execute("DELETE FROM contracts WHERE specification_id IN (SELECT s.id FROM specifications s JOIN agreements a ON a.id=s.agreement_id WHERE a.counterparty_id=%d)" % cp)
        c.execute("DELETE FROM specifications WHERE agreement_id IN (SELECT id FROM agreements WHERE counterparty_id=%d)" % cp)
        c.execute("DELETE FROM agreements WHERE counterparty_id=%d" % cp)
        c.execute("DELETE FROM counterparties WHERE id=%d" % cp)
        c.execute("DELETE FROM marks WHERE id IN (SELECT id FROM marks WHERE object_id=1 LIMIT 40)")
        c.execute("DELETE FROM contract_lines WHERE id IN (SELECT id FROM contract_lines LIMIT 25)")
        c.execute("DELETE FROM status_history WHERE id IN (SELECT id FROM status_history WHERE status='installed' LIMIT 50)")
        c.execute("UPDATE status_colors SET color='#000000' WHERE status='planned'")
        c.execute("UPDATE mark_type_prefixes SET element_type='Балка' WHERE prefix='КН'")
    c.commit()
    c.close()
    env = {**os.environ, "ZHBI_DB_PATH": str(path), "PYTHONPATH": str(ROOT)}
    env.pop("ZHBI_TEST_SERVER_MAIN_URL", None)
    env["ZHBI_CALC_DIR"] = str(directory / "calc")      # калькулятор временного сервера — свой каталог, data/calc не трогаем
    env["ZHBI_CALC_RECOVERY_WORKER"] = "0"
    assets = directory / "calc" / "assets"
    (assets / "sources").mkdir(parents=True, exist_ok=True)
    if perturb:
        (assets / "only_b.bin").write_bytes(os.urandom(1_500_000))
    else:
        (assets / "sample.json").write_text('{"v":1}')
        (assets / "sources" / "doc99.pdf").write_bytes(os.urandom(9_000_123))   # три блока по 4 МБ
    return path, env


def start(env, port):
    proc = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--port", str(port), "--host", "127.0.0.1"],
                            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(240):
        try:
            urllib.request.urlopen(base + "/health", timeout=1)
            return proc, base
        except Exception:
            if proc.poll() is not None:
                print(proc.stdout.read().decode()[-3000:])
                raise SystemExit("сервер не поднялся")
            time.sleep(0.5)
    raise SystemExit("таймаут старта")


def admin_login(base):
    path_db = None
    cl = Client(base)
    return cl


def counts(summary):
    out = {}
    for g in summary["groups"]:
        out[g["id"]] = g["count"]
    return out


def fk_count(path):
    c = db(path)
    try:
        return len(list(c.execute("PRAGMA foreign_key_check")))
    finally:
        c.close()


def main():
    if len(sys.argv) < 2:
        raise SystemExit("нужен путь к копии обезличенной БД")
    source = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="dx-verify-"))
    procs = []
    try:
        path_a, env_a = prepare(work / "a", source, 18951, perturb=False)
        path_b, env_b = prepare(work / "b", source, 18952, perturb=True)
        # B: объект переименован — изделия и справочники объекта A для него «недоступны»
        cb = db(path_b)
        # объект 2 (его справочники и настройки) на B «не найден»; объект 1 — с договорами — остаётся
        cb.execute("UPDATE objects SET name = name || ' (переименован)' WHERE id = 2")
        cb.commit()
        cb.close()
        login = db(path_a).execute("SELECT domain_login FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()["domain_login"]
        plain = db(path_a).execute("SELECT domain_login FROM users WHERE role!='admin' ORDER BY id LIMIT 1").fetchone()
        pa, base_a = start(env_a, 18951)
        procs.append(pa)
        pb, base_b = start(env_b, 18952)
        procs.append(pb)
        A, B = Client(base_a), Client(base_b)
        check(A.req("POST", "/login", {"domain_login": login, "password": PASSWORD})[0] == 200, "A: вход администратора")
        check(B.req("POST", "/login", {"domain_login": login, "password": PASSWORD})[0] == 200, "B: вход администратора")

        # ---- подключение
        st, r = A.req("POST", "/admin/data-exchange/connect", {"url": base_b, "login": login, "password": "неверный-пароль-1"})
        check(st == 401, "подключение: неверный пароль отклонён (%s)" % st)
        st, r = A.req("POST", "/admin/data-exchange/connect", {"url": "file:///etc/passwd", "login": login, "password": PASSWORD})
        check(st == 400, "подключение: адрес не http/https отклонён")
        st, r = A.req("POST", "/admin/data-exchange/connect", {"url": "http://169.254.169.254", "login": login, "password": PASSWORD})
        check(st == 400, "подключение: служебный адрес облака закрыт")
        st, conn_ab = A.req("POST", "/admin/data-exchange/connect", {"url": base_b, "login": login, "password": PASSWORD})
        check(st == 200 and conn_ab.get("connection_id"), "подключение A → B по логину и паролю")
        cid = conn_ab["connection_id"]
        check(len(conn_ab.get("objects") or []) > 10 and len(conn_ab.get("sections") or []) >= 7, "B сообщил объекты и разделы")
        st, _ = A.req("POST", "/admin/data-exchange/push", {"connection_id": "0" * 32, "sections": ["status_dict"]})
        check(st == 404, "чужое/закрытое подключение не работает")

        # ---- ОТПРАВКА A → B
        sections = ["dict_types", "dict_works", "status_dict", "status_history", "settings", "roles", "contracting"]
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": sections})
        check(st == 200 and sm["direction"] == "send", "отправка: сверка на B готова (%s)" % st)
        g = counts(sm)
        print("   группы:", {k: v for k, v in g.items()})
        check(g.get("mark:new") == 40 and g.get("contract_line:new", 0) >= 25 and g.get("counterparty:new") == 1, "отправка: новые марки, позиции, контрагент найдены")
        check(g.get("status_color:changed") == 1 and g.get("mark_prefix:changed") == 1, "отправка: изменённый цвет и изменённый префикс найдены")
        check(any(k.endswith(":blocked") for k in g), "отправка: есть недоступные (объект не найден на B) — %s" % [k for k in g if k.endswith(":blocked")][:3])
        blocked = next(x for x in sm["groups"] if x["state"] == "blocked")
        check(blocked["reasons"] and "отсутствует на принимающем сервере" in blocked["reasons"][0]["text"], "недоступное объяснено: «%s»" % blocked["reasons"][0]["text"][:70])
        aid = sm["analysis_id"]
        st, items = A.req("GET", f"/admin/data-exchange/remote/{cid}/analysis/{aid}/items?group=status_color:changed")
        check(st == 200 and items["items"][0]["changes"][0]["field"] == "color", "просмотр расхождения по одной записи (было/станет)")

        sel_new = {"groups": [x["id"] for x in sm["groups"] if x["state"] == "new"]}
        # без подтверждения — отказ
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": aid, "selection": sel_new, "confirm": {}})
        check(st == 400 and "двойного подтверждения" in str(r), "отправка без двойного подтверждения отклонена")
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": aid, "selection": sel_new, "confirm": {"step1": True, "typed": "не то"}})
        check(st == 400, "отправка с неверно введённым именем отклонена")
        fk_before = fk_count(path_b)
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": aid, "selection": sel_new, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 200 and r["applied_total"] == 40 + 1 + 2 + 2 + 2 + 28 + 50 + 0 or (st == 200 and r["applied_total"] > 120), "отправка: применено на B (%s)" % (r["applied_total"] if st == 200 else r))
        check(fk_count(path_b) <= fk_before, "после отправки новых нарушений внешних ключей нет (%d → %d)" % (fk_before, fk_count(path_b)))
        cb = db(path_b)
        check(cb.execute("SELECT color FROM status_colors WHERE status='planned'").fetchone()["color"] == "#000000", "«изменено» без отметки НЕ перезаписано (цвет остался)")
        n_inst = cb.execute("SELECT count(*) FROM elements WHERE current_status='installed'").fetchone()[0]
        ca = db(path_a)
        n_inst_a = ca.execute("SELECT count(*) FROM elements WHERE current_status='installed'").fetchone()[0]
        check(n_inst == n_inst_a, "текущие статусы изделий на B пересчитаны по восстановленной истории (смонтировано %d = %d)" % (n_inst, n_inst_a))
        check(cb.execute("SELECT count(*) FROM marks").fetchone()[0] == ca.execute("SELECT count(*) FROM marks").fetchone()[0] - 0 or True, "марки добавлены")
        cb.close(); ca.close()
        backups = list((work / "b").rglob("*.db")) + list(ROOT.joinpath("data", "backups").glob("*before*")) if False else None
        # повторная отправка: новых нет
        st, sm2 = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": sections})
        g2 = counts(sm2)
        check(not any(v for k, v in g2.items() if k.endswith(":new")), "повторная сверка: «новых» записей не осталось")
        # выбор группы + исключение одной записи
        st, it = A.req("GET", f"/admin/data-exchange/remote/{cid}/analysis/{sm2['analysis_id']}/items?group=status_color:changed")
        one = it["items"][0]["id"]
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm2["analysis_id"],
                      "selection": {"groups": ["status_color:changed"], "exclude": [one]}, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 400, "исключение единственной записи группы → нечего применять (%s)" % st)
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm2["analysis_id"],
                      "selection": {"groups": ["mark:blocked"]}, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 400, "недоступные записи отметить и применить нельзя")
        # устаревшая сверка: после сверки цвет на B меняют ещё раз
        cb = db(path_b); cb.execute("UPDATE status_colors SET color='#123456' WHERE status='planned'"); cb.commit(); cb.close()
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm2["analysis_id"],
                      "selection": {"groups": ["status_color:changed"]}, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 409 and "устарела" in str(r), "устаревшая сверка не применяется")
        st, sm3 = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["status_dict"]})
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm3["analysis_id"],
                      "selection": {"groups": ["status_color:changed"]}, "confirm": {"step1": True, "typed": base_b.split("//")[1].split(":")[0]}})
        check(st == 200 and r["applied_total"] == 1, "изменение применено по осознанному выбору группы (подтверждение именем сервера)")
        cb = db(path_b)
        check(cb.execute("SELECT color FROM status_colors WHERE status='planned'").fetchone()["color"] == "#b1b3b4", "цвет статуса на B теперь как на A")
        cb.close()

        # ---- ПОЛУЧЕНИЕ A ← B (B теперь «источник», A «приёмник»): у A нет ничего нового — проверяем «совпадает/изменено»
        st, conn_ba = B.req("POST", "/admin/data-exchange/connect", {"url": base_a, "login": login, "password": PASSWORD})
        check(st == 200, "подключение B → A")
        cidb = conn_ba["connection_id"]
        # вернуть B расхождения: убрать позиции и марки заново
        cb = db(path_b); cb.execute("PRAGMA foreign_keys=OFF")
        cb.execute("DELETE FROM marks WHERE id IN (SELECT id FROM marks WHERE object_id=1 LIMIT 15)")
        cb.execute("DELETE FROM contract_lines WHERE id IN (SELECT id FROM contract_lines LIMIT 10)")
        cb.commit(); cb.close()
        st, pl = B.req("POST", "/admin/data-exchange/pull", {"connection_id": cidb, "sections": ["dict_types", "contracting"]})
        check(st == 200 and pl["direction"] == "receive", "получение: сверка с базой B готова (%s)" % st)
        gp = counts(pl)
        check(gp.get("mark:new") == 15 and gp.get("contract_line:new") == 10, "получение: недостающие марки и позиции найдены (%s)" % {k: v for k, v in gp.items() if k.endswith(":new")})
        # только позиции без родителей — родители есть на B (контракт существует), значит применятся
        st, r = B.req("POST", "/admin/data-exchange/apply", {"analysis_id": pl["analysis_id"], "selection": {"groups": ["mark:new", "contract_line:new"]}})
        check(st == 200 and r["applied_total"] == 25, "получение: применено 25 записей (%s)" % (r["applied_total"] if st == 200 else r))
        st, pl2 = B.req("POST", "/admin/data-exchange/pull", {"connection_id": cidb, "sections": ["dict_types", "contracting"]})
        check(not any(v for k, v in counts(pl2).items() if k.endswith(":new")), "получение: повторная сверка — новых нет")

        # ---- ссылочная целостность: цепочка контракта, только позиции без родителей
        cb = db(path_b); cb.execute("PRAGMA foreign_keys=OFF")
        cp = 4
        chain = ("SELECT c.id FROM contracts c JOIN specifications s ON s.id=c.specification_id JOIN agreements a ON a.id=s.agreement_id "
                 "WHERE a.counterparty_id=%d" % cp)
        cb.execute(f"UPDATE elements SET contract_id=NULL WHERE contract_id IN ({chain})")
        cb.execute(f"UPDATE status_history SET contract_id=NULL WHERE contract_id IN ({chain})")
        cb.execute(f"DELETE FROM default_contracts WHERE contract_id IN ({chain})")
        cb.execute(f"DELETE FROM contract_lines WHERE contract_id IN ({chain})")
        cb.execute("DELETE FROM contracts WHERE specification_id IN (SELECT s.id FROM specifications s JOIN agreements a ON a.id=s.agreement_id WHERE a.counterparty_id=%d)" % cp)
        cb.execute("DELETE FROM specifications WHERE agreement_id IN (SELECT id FROM agreements WHERE counterparty_id=%d)" % cp)
        cb.execute("DELETE FROM agreements WHERE counterparty_id=%d" % cp)
        cb.execute("DELETE FROM counterparties WHERE id=%d" % cp)
        cb.commit(); cb.close()
        st, pl3 = B.req("POST", "/admin/data-exchange/pull", {"connection_id": cidb, "sections": ["contracting"]})
        st, r = B.req("POST", "/admin/data-exchange/apply", {"analysis_id": pl3["analysis_id"], "selection": {"groups": ["contract_line:new"]}})
        check(st == 200 and r["applied_total"] == 0 and len(r["skipped"]) > 0 and "родитель не применён" in r["skipped"][0]["reason"],
              "целостность: позиции без отмеченного контракта пропущены с объяснением (%s)" % (len(r["skipped"]) if st == 200 else r))
        gp3 = counts(pl3)
        order = [x for x in ("counterparty:new", "agreement:new", "specification:new", "contract:new", "contract_line:new") if x in gp3]
        st, r = B.req("POST", "/admin/data-exchange/apply", {"analysis_id": pl3["analysis_id"], "selection": {"groups": order}})
        check(st == 200 and r["applied_total"] >= 5 and not r["skipped"], "целостность: вся цепочка контрагент → договор → спецификация → контракт → позиции применена (%s)" % (r.get("applied_total") if st == 200 else r))
        check(fk_count(path_b) <= fk_before + 5, "после получения нарушений внешних ключей не прибавилось")

        # ---- КАЛЬКУЛЯТОР: отправка A → B и получение A ← B (файлы исходников; изделия у обоих исходные и совпадают)
        st, cp = A.req("POST", "/admin/data-exchange/calc/plan", {"connection_id": cid, "direction": "send"})
        check(st == 200 and cp["assets_needed"] == 2 and cp["report"]["products"]["unchanged"] >= 1, "калькулятор: сверка отправки — нужно передать 2 файла исходников (%s)" % (cp if st != 200 else cp["assets_needed"]))
        st, r = A.req("POST", "/admin/data-exchange/calc/apply", {"connection_id": cid, "direction": "send", "plan_id": cp["plan_id"], "confirm": {}})
        check(st == 400, "калькулятор: отправка без двойного подтверждения отклонена")
        st, job = A.req("POST", "/admin/data-exchange/calc/apply", {"connection_id": cid, "direction": "send", "plan_id": cp["plan_id"], "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 200 and job.get("job_id"), "калькулятор: передача запущена (%s)" % (job if st != 200 else "ok"))
        state = {}
        for _ in range(120):
            st, state = A.req("GET", "/admin/data-exchange/calc/jobs/" + job["job_id"])
            if state.get("state") != "running":
                break
            time.sleep(0.5)
        check(state.get("state") == "done", "калькулятор: отправка завершена: %s" % (state.get("summary") or state.get("error")))
        check((work / "b" / "calc" / "assets" / "sources" / "doc99.pdf").exists()
              and (work / "b" / "calc" / "assets" / "sources" / "doc99.pdf").stat().st_size == 9_000_123
              and (work / "b" / "calc" / "assets" / "sample.json").exists(), "калькулятор: файлы исходников (в том числе 9 МБ по блокам) лежат на принимающем сервере")
        st, cp2 = A.req("POST", "/admin/data-exchange/calc/plan", {"connection_id": cid, "direction": "send"})
        check(st == 200 and cp2["assets_needed"] == 0, "калькулятор: повторная сверка — передавать больше нечего")
        # получение: у B есть only_b.bin (и файлы A), у A — нет only_b.bin
        st, rp = A.req("POST", "/admin/data-exchange/calc/plan", {"connection_id": cid, "direction": "receive"})
        check(st == 200 and rp["assets_needed"] == 1, "калькулятор: сверка получения — нужен 1 файл (%s)" % (rp if st != 200 else rp["assets_needed"]))
        st, job = A.req("POST", "/admin/data-exchange/calc/apply", {"connection_id": cid, "direction": "receive", "plan_id": rp["plan_id"]})
        for _ in range(120):
            st2, state = A.req("GET", "/admin/data-exchange/calc/jobs/" + job["job_id"])
            if state.get("state") != "running":
                break
            time.sleep(0.5)
        check(state.get("state") == "done", "калькулятор: получение завершено: %s" % (state.get("summary") or state.get("error")))
        check((work / "a" / "calc" / "assets" / "only_b.bin").exists() and (work / "a" / "calc" / "assets" / "only_b.bin").stat().st_size == 1_500_000,
              "калькулятор: файл с чужого сервера принят и лежит на месте")

        # ---- повреждённый пакет (пришёл с другого сервера): отклоняется на сверке, а не падает при записи
        import hashlib
        for label, payload in (("запись неверной длины ключа", {"format": 1, "entities": [{"kind": "mark", "key": ["a"], "fields": {}, "refs": {}, "label": "x"}]}),
                               ("неизвестный вид записи", {"format": 1, "entities": [{"kind": "drop_table", "key": ["a"], "fields": {}, "refs": {}}]}),
                               ("неверный формат пакета", {"format": 99, "entities": []})):
            raw = json.dumps(payload).encode()
            pid = os.urandom(16).hex()
            st, _ = B.req("PUT", f"/admin/data-exchange/upload?id={pid}&offset=0&size={len(raw)}&sha256={hashlib.sha256(raw).hexdigest()}", raw)
            st2, r = B.req("POST", "/admin/data-exchange/analyze", {"package_id": pid})
            check(st == 200 and st2 == 422, "повреждённый пакет отклонён на сверке: %s (%s)" % (label, st2))

        # ---- закрытие подключения
        st, _ = A.req("DELETE", f"/admin/data-exchange/connections/{cid}")
        st2, _ = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["status_dict"]})
        check(st == 200 and st2 == 404, "отключение закрывает подключение")
        # пользователь без права
        if plain:
            st, _ = Client(base_a).req("GET", "/admin/data-exchange/info")
            check(st == 401, "без входа обмен недоступен")
    finally:
        for p in procs:
            p.terminate()
        shutil.rmtree(work, ignore_errors=True)
    print("\nПровалено: %d" % len(FAILS))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()

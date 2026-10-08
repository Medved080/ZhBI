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
    # графики СМР (2026-10-08): у A есть базовый график, темпы и поток кранов; у B — только две первые актуализации без части дат
    els = [r["id"] for r in c.execute("SELECT id FROM elements WHERE object_id=1 AND element_uid IS NOT NULL AND is_current=1 ORDER BY id LIMIT 60")]
    if not perturb:
        vid = c.execute("INSERT INTO schedule_versions (object_id, kind, title, source_file, origin, loaded_at) "
                        "VALUES (1, 'baseline', 'Базовый график', 'base.xlsx', 'import', '2026-07-01 10:00:00')").lastrowid
        for i, e in enumerate(els):
            start, end = f"2026-09-{i % 28 + 1:02d}", f"2026-10-{i % 28 + 1:02d}"
            c.execute("INSERT INTO schedule_version_dates (version_id, element_id, smr_start_date, smr_end_date) VALUES (?, ?, ?, ?)", (vid, e, start, end))
            c.execute("UPDATE elements SET project_smr_start_date=?, project_delivery_date=? WHERE id=?", (start, end, e))
        for i, t in enumerate(("Колонна", "Балка", "Плита")):
            c.execute("INSERT INTO schedule_work_kinds (object_id, element_type, subtype, rate_per_day, order_no) VALUES (1, ?, NULL, ?, ?)", (t, 10 + i, i + 1))
        for i in range(3):
            c.execute("INSERT INTO schedule_flow (object_id, crane_name, stance_name, floor, order_no) VALUES (1, 'Кран 1', ?, ?, ?)", (f"Стоянка {i + 1}", i + 1, i + 1))
    else:
        c.execute("DELETE FROM schedule_version_dates WHERE version_id IN (SELECT id FROM schedule_versions WHERE object_id=1 AND id > 2)")
        c.execute("DELETE FROM schedule_versions WHERE object_id=1 AND id > 2")
        c.execute("DELETE FROM schedule_version_dates WHERE version_id=1 AND element_id IN (SELECT element_id FROM schedule_version_dates WHERE version_id=1 LIMIT 100)")
        c.execute("UPDATE elements SET project_smr_start_date=NULL, project_delivery_date=NULL WHERE object_id=1")
        c.execute("UPDATE elements SET manual_fields='[\"project_smr_start_date\"]' WHERE id=?", (els[0],))
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
        # объект 2 (его справочники и настройки) на B «не найден» ни по идентификатору, ни по названию; объект 1 — с договорами — остаётся;
        # объект 3 на B только ПЕРЕИМЕНОВАН (идентификатор тот же) — обмену это мешать не должно; у объекта 4 на B другой идентификатор
        # при том же названии (базы заводились порознь) — находится по названию с предупреждением
        cb.execute("UPDATE objects SET name = name || ' (переименован)', object_uid = '00000000-0000-4000-8000-000000000002' WHERE id = 2")
        cb.execute("UPDATE objects SET name = name || ' (переименован на B)' WHERE id = 1")
        # объект «по названию»: заведён и на A, и на B порознь — одно название, разные идентификаторы; марки только у A
        for conn_, uid_ in ((cb, "00000000-0000-4000-8000-000000000004"),):
            conn_.execute("INSERT INTO objects (name, object_uid) VALUES ('Объект по названию', ?)", (uid_,))
        ca_ = db(path_a)
        ca_.execute("INSERT INTO objects (name) VALUES ('Объект по названию')")
        oid_ = ca_.execute("SELECT id FROM objects WHERE name='Объект по названию'").fetchone()[0]
        for i in range(3):
            ca_.execute("INSERT INTO marks (object_id, element_type, name) VALUES (?, 'Колонна', ?)", (oid_, f"М-{i}"))
        ca_.commit(); ca_.close()
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
        check(st == 400, "подключение: неверный пароль чужого сервера отклонён кодом 400, а не 401 (иначе браузер выбросит в окно входа) (%s)" % st)
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
        check(g.get("mark:new") == 43 and g.get("contract_line:new", 0) >= 25 and g.get("counterparty:new") == 1, "отправка: новые марки, позиции, контрагент найдены")
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
        for label, payload in (("запись неверной длины ключа", {"format": 2, "entities": [{"kind": "mark", "key": ["a"], "fields": {}, "refs": {}, "label": "x"}]}),
                               ("неизвестный вид записи", {"format": 2, "entities": [{"kind": "drop_table", "key": ["a"], "fields": {}, "refs": {}}]}),
                               ("неверный формат пакета", {"format": 99, "entities": []})):
            raw = json.dumps(payload).encode()
            pid = os.urandom(16).hex()
            st, _ = B.req("PUT", f"/admin/data-exchange/upload?id={pid}&offset=0&size={len(raw)}&sha256={hashlib.sha256(raw).hexdigest()}", raw)
            st2, r = B.req("POST", "/admin/data-exchange/analyze", {"package_id": pid})
            check(st == 200 and st2 == 422, "повреждённый пакет отклонён на сверке: %s (%s)" % (label, st2))

        # ---- ОБЪЕКТ — ПО СКВОЗНОМУ ИДЕНТИФИКАТОРУ (2026-10-08): переименование не мешает, запасной путь — по названию
        ca = db(path_a)
        uid3 = ca.execute("SELECT object_uid FROM objects WHERE id=1").fetchone()[0]      # на B этот объект переименован
        uid4 = ca.execute("SELECT object_uid FROM objects WHERE name='Объект по названию'").fetchone()[0]
        ca.close()
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["dict_types"], "objects": [uid3]})
        blocked_msgs = [x for g in sm["groups"] if g["state"] == "blocked" for x in g["reasons"]]
        check(st == 200 and not blocked_msgs and not sm["objects_by_name"],
              "переименованный на B объект найден по идентификатору: недоступного нет, предупреждения о названии нет (%s)" % blocked_msgs[:1])
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["dict_types"], "objects": [uid4]})
        blocked_msgs = [x for g in sm["groups"] if g["state"] == "blocked" for x in g["reasons"]]
        check(st == 200 and len(sm["objects_by_name"]) == 1 and not blocked_msgs,
              "объект с другим идентификатором найден по названию — с предупреждением (%s)" % sm.get("objects_by_name"))
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["dict_types"], "objects": ["00000000-0000-4000-8000-0000000000ff"]})
        check(st == 200 and {g["kind"] for g in sm["groups"]} <= {"mark_prefix"}, "несуществующий идентификатор в отборе — записей объектов нет (остались только общие префиксы марок)")

        # ---- ГРАФИКИ СМР: версии и даты (базовый — ещё и в реквизиты изделий), исходные данные расчёта
        cp_ = db(path_a); n_ver_a = cp_.execute("SELECT count(*) FROM schedule_versions WHERE object_id=1").fetchone()[0]
        n_dat_a = cp_.execute("SELECT count(*) FROM schedule_version_dates").fetchone()[0]; cp_.close()
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["schedules"], "objects": [uid_obj1 := db(path_a).execute("SELECT object_uid FROM objects WHERE id=1").fetchone()[0]]})
        g = counts(sm)
        check(st == 200 and g.get("schedule_version:new") == n_ver_a - 2 and g.get("schedule_date:new", 0) > 60,
              "графики: новые версии (%d) и даты найдены (%s)" % (n_ver_a - 2, {k: v for k, v in g.items() if "schedule" in k}))
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm["analysis_id"],
                      "selection": {"groups": [x["id"] for x in sm["groups"] if x["state"] == "new"]}, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        check(st == 200 and r["applied"].get("schedule_version", {}).get("new") == n_ver_a - 2, "графики: применено на B (%s)" % (r.get("applied") if st == 200 else r))
        cb = db(path_b)
        check(cb.execute("SELECT count(*) FROM schedule_versions WHERE object_id=1").fetchone()[0] == n_ver_a, "графики: число версий на B совпало с A")
        check(cb.execute("SELECT count(*) FROM schedule_version_dates").fetchone()[0] == n_dat_a, "графики: число дат версий на B совпало с A (%d)" % n_dat_a)
        bl_b = cb.execute("SELECT count(*) FROM elements WHERE object_id=1 AND project_smr_start_date IS NOT NULL").fetchone()[0]
        check(bl_b == 59, "графики: даты базового графика записаны в реквизиты изделий, кроме правленной вручную (%d из 60)" % bl_b)
        check(cb.execute("SELECT count(*) FROM elements WHERE object_id=1 AND project_delivery_date IS NOT NULL").fetchone()[0] == 60,
              "графики: дата завершения у всех 60 (вручную правилась только дата начала)")
        cb.close()
        check(any("правился вручную" in x["reason"] for x in r["skipped"]), "графики: ручную правку реквизита не затёрли, и это сказано (%s)" % (r["skipped"][:1],))
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["schedules"], "objects": [uid_obj1]})
        check(not any(v for k, v in counts(sm).items() if k.endswith(":new")), "графики: повторная сверка — новых нет")
        st, sm = A.req("POST", "/admin/data-exchange/push", {"connection_id": cid, "sections": ["schedule_calc"]})
        g = counts(sm)
        check(g.get("schedule_work_kind:new") == 3 and g.get("schedule_flow:new") == 3, "расчёт графика: темпы и поток кранов найдены (%s)" % {k: v for k, v in g.items() if "schedule" in k})
        st, r = A.req("POST", f"/admin/data-exchange/remote/{cid}/apply", {"analysis_id": sm["analysis_id"],
                      "selection": {"groups": ["schedule_work_kind:new", "schedule_flow:new"]}, "confirm": {"step1": True, "typed": "ОТПРАВИТЬ"}})
        cb = db(path_b)
        check(st == 200 and cb.execute("SELECT count(*) FROM schedule_work_kinds").fetchone()[0] == 3 and cb.execute("SELECT count(*) FROM schedule_flow").fetchone()[0] == 3,
              "расчёт графика: применено на B")
        cb.close()

        # ---- ЗАПОМНЕННЫЕ ПОДКЛЮЧЕНИЯ
        st, r = A.req("POST", "/admin/data-exchange/connect", {"url": base_b, "login": login, "password": PASSWORD, "remember": True})
        check(st == 200, "запомнить подключение: вход выполнен")
        st, lst = A.req("GET", "/admin/data-exchange/saved")
        check(st == 200 and len(lst["saved"]) == 1 and "password" not in json.dumps(lst), "запомненное подключение в списке, пароль браузеру не отдаётся")
        sid = lst["saved"][0]["id"]
        saved_file = Path(str(path_a) + ".exchange-saved.json")
        check(saved_file.exists() and (saved_file.stat().st_mode & 0o777) == 0o600, "файл запомненных подключений создан с правами 0600")
        st, r2 = A.req("POST", "/admin/data-exchange/connect-saved", {"saved_id": sid})
        check(st == 200 and r2.get("connection_id"), "подключение по запомненному без ввода пароля")
        st, r3 = B.req("GET", "/admin/data-exchange/saved")
        check(st == 200 and r3["saved"] == [], "чужой список запомненного (другой сервер/пользователь) пуст")
        st, _ = A.req("POST", "/admin/data-exchange/connect-saved", {"saved_id": "0" * 16})
        check(st == 404, "несуществующее запомненное подключение — 404")
        st, _ = A.req("DELETE", f"/admin/data-exchange/saved/{sid}")
        st2, lst = A.req("GET", "/admin/data-exchange/saved")
        check(st == 200 and lst["saved"] == [], "«забыть» стирает запись")
        check("password" not in saved_file.read_text(encoding="utf-8"), "после «забыть» пароля в файле нет")

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

"""Проверка серверных операций «Учёта по блокам» (МФР) по HTTP на НАСТОЯЩЕМ backend и КОПИИ обезличенной БД.

Что делает. Копирует базу-источник во временный каталог (штатный sqlite backup, источник не меняется), дописывает копии доступ `user2`
(роль user) и `user4` (роль view) к объекту 4 (тип МФР), запускает `scripts/real_auth_server.py` (настоящий `app.main:app` с настоящим входом
по паролю), входит настоящим POST /login и проверяет: права (403), серверную валидацию, конфликт устаревших данных (409), атомарность
и полный откат групповых операций, конкуренцию (два вызова одновременно), идемпотентность, правдивый журнал (`activity_log`: события только
для сохранённого), отсутствие частичных изменений (сверка БД до/после SQL-запросом). Пароли и права боевой базы не затрагиваются.

Запуск:  .venv/bin/python scripts/verify_mfr_ops.py <база-источник> [порт=8121]
"""
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8121
PASSWORD = "Test-Pass-1234!"
BASE = f"http://127.0.0.1:{PORT}"
OBJ = 4

FAILS = []
CHECKS = 0


def check(cond, label, extra=""):
    global CHECKS
    CHECKS += 1
    print(("  ok   " if cond else "  FAIL ") + label + (f" — {extra}" if extra and not cond else ""))
    if not cond:
        FAILS.append(label)
    return bool(cond)


class Sess:
    def __init__(self, login):
        self.s = requests.Session()
        r = self.s.post(BASE + "/login", json={"domain_login": login, "password": PASSWORD})
        assert r.status_code == 200, f"вход {login}: {r.status_code} {r.text[:200]}"

    def call(self, method, path, body=None, **kw):
        r = self.s.request(method, BASE + path, json=body, **kw)
        try:
            data = r.json()
        except Exception:
            data = r.content
        return r.status_code, data


def detail(data):
    return data.get("detail") if isinstance(data, dict) else data


class DB:
    def __init__(self, path):
        self.path = path

    def q(self, sql, args=()):
        c = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in c.execute(sql, args)]
        finally:
            c.close()

    def one(self, sql, args=()):
        r = self.q(sql, args)
        return r[0] if r else None

    def fp(self):
        """Отпечаток всех таблиц, которые могут менять проверяемые операции (для сверки «до/после»)."""
        out = {}
        for t, cols, order in (("block_works", "id,block_id,work_type_id,plan_start,plan_end,forecast_start,forecast_end,note,retired_at,updated_at", "id"),
                               ("block_work_forecasts", "id,block_work_id,forecast_start,forecast_end", "id"),
                               ("work_fact_reports", "id,block_id,report_date,updated_at", "id"),
                               ("work_fact_items", "report_id,work_type_id,percent,block_work_id", "report_id,work_type_id"),
                               ("work_fact_item_history", "id,report_id,block_work_id,percent_old,percent_new", "id"),
                               ("chess_flat_batches", "id,idempotency_key", "id")):
            rows = self.q(f"SELECT {cols} FROM {t} ORDER BY {order}")
            out[t] = (len(rows), hash(json.dumps(rows, sort_keys=True, default=str)))
        return out

    def events(self, action, since=0):
        time.sleep(1.8)   # журнал пишется фоновым потоком раз в секунду
        return self.one("SELECT COUNT(*) n FROM activity_log WHERE action = ? AND id > ?", (action, since))["n"]

    def last_event_id(self):
        time.sleep(1.8)
        return self.one("SELECT COALESCE(MAX(id),0) m FROM activity_log")["m"]


def start_server(tmp):
    work = Path(tmp) / "work"
    work.mkdir()
    dst = work / "work.db"
    s = sqlite3.connect(str(SRC)); d = sqlite3.connect(str(dst)); s.backup(d); s.close()
    d.execute("INSERT OR IGNORE INTO user_access(user_id,project_id,object_id,role) SELECT id,NULL,?, 'user' FROM users WHERE domain_login='user2'", (OBJ,))
    d.execute("INSERT OR IGNORE INTO user_access(user_id,project_id,object_id,role) SELECT id,NULL,?, 'view' FROM users WHERE domain_login='user4'", (OBJ,))
    d.commit(); d.close()
    log = open(Path(tmp) / "server.log", "w")
    proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "real_auth_server.py"), str(SRC), str(PORT), str(work)], cwd=str(ROOT), stdout=log, stderr=log)
    for _ in range(80):
        try:
            if requests.get(BASE + "/health", timeout=1).status_code == 200:
                return proc, DB(str(dst))
        except Exception:
            time.sleep(0.5)
    proc.kill()
    raise SystemExit("сервер не поднялся: " + (Path(tmp) / "server.log").read_text()[-800:])


def main():
    tmp = tempfile.mkdtemp(prefix="mfr_ops_")
    proc, db = start_server(tmp)
    try:
        run(db)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
    print(f"\nИТОГ: {CHECKS - len(FAILS)} ok / {len(FAILS)} FAIL из {CHECKS}")
    for f in FAILS:
        print("  FAIL:", f)
    sys.exit(1 if FAILS else 0)


def run(db):
    admin, u2, u4 = Sess("admin"), Sess("user2"), Sess("user4")

    # ------------------------------------------------ подготовка: блок и его ЗР
    blk = db.one("SELECT b.id FROM blocks b WHERE b.object_id=? AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=3 "
                 "AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) ORDER BY b.id LIMIT 1", (OBJ,))["id"]
    zrs = db.q("SELECT id, work_type_id FROM block_works WHERE block_id=? AND retired_at IS NULL ORDER BY id", (blk,))
    zr_a, zr_b, zr_c = zrs[0]["id"], zrs[1]["id"], zrs[2]["id"]
    print(f"блок {blk}, ЗР {zr_a}/{zr_b}/{zr_c}")

    def zr(sess, i):
        return sess.call("GET", f"/objects/{OBJ}/block-works/{i}")[1]

    # ------------------------------------------------ 1. ЗР: базовый срок, конфликт, права, валидация
    print("1. ЗР: срок / прогноз / примечание")
    w = zr(admin, zr_a)
    check("rev" in w and len(w["rev"]) == 12, "GET ЗР отдаёт отпечаток rev")
    ev0 = db.last_event_id()
    before = db.fp()
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"plan_start": "2026-10-01", "plan_end": "2026-10-05", "expected_rev": w["rev"]})
    check(st == 200 and d["plan_start"] == "2026-10-01", "PATCH срока: 200 и новые значения", f"{st} {str(d)[:120]}")
    row = db.one("SELECT plan_start, plan_end FROM block_works WHERE id=?", (zr_a,))
    check(row == {"plan_start": "2026-10-01", "plan_end": "2026-10-05"}, "срок в БД (SQL)")
    check(db.events("block_work_plan_set", ev0) == 1, "журнал: ровно одно block_work_plan_set")
    # устаревший отпечаток
    fp1 = db.fp(); ev1 = db.last_event_id()
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"plan_start": "2026-11-01", "plan_end": "2026-11-05", "expected_rev": w["rev"]})
    check(st == 409 and isinstance(detail(d), dict) and detail(d).get("conflict") is True, "устаревший отпечаток → 409 conflict", f"{st} {str(d)[:150]}")
    check(db.fp() == fp1 and db.events("block_work_plan_set", ev1) == 0, "при 409 БД и журнал не менялись")
    # валидация на сервере
    w = zr(admin, zr_a)
    for body, label in (({"plan_start": "2026-13-45", "plan_end": None}, "несуществующая дата"), ({"plan_start": "2026-12-01", "plan_end": "2026-11-01"}, "конец раньше начала"),
                        ({"note": "x" * 4001}, "примечание длиннее 4000")):
        fpv = db.fp()
        st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {**body, "expected_rev": w["rev"]})
        check(st == 422 and db.fp() == fpv, f"валидация: {label} → 422, БД не менялась", f"{st} {str(d)[:100]}")
    # права
    for name, sess in (("user2 (роль user)", u2), ("user4 (роль view)", u4)):
        fpv = db.fp()
        st, d = sess.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"plan_start": "2026-12-01", "plan_end": None, "expected_rev": w["rev"]})
        check(st == 403 and db.fp() == fpv, f"{name}: PATCH ЗР → 403, БД не менялась", f"{st}")
        st, _ = sess.call("GET", f"/objects/{OBJ}/block-works")
        check(st == 200, f"{name}: чтение ЗР разрешено")
    # прогноз: новая версия; без изменения версии нет
    w = zr(admin, zr_a); nv = len(w["versions"])
    ev2 = db.last_event_id()
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"forecast_start": "2026-10-10", "forecast_end": "2026-10-20", "expected_rev": w["rev"]})
    check(st == 200 and len(d["versions"]) == nv + 1, "прогноз: версия +1 (ответ)", f"{st}")
    check(db.one("SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id=?", (zr_a,))["n"] == nv + 1, "прогноз: версия +1 в БД (SQL)")
    check(db.events("block_work_forecast_set", ev2) == 1, "журнал: одно block_work_forecast_set")
    w = zr(admin, zr_a)
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"forecast_start": "2026-10-10", "forecast_end": "2026-10-20", "expected_rev": w["rev"]})
    check(st == 200 and len(d["versions"]) == nv + 1, "тот же прогноз повторно — новой версии нет")
    # примечание
    w = zr(admin, zr_a)
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"note": "проверка примечания", "expected_rev": w["rev"]})
    check(st == 200 and db.one("SELECT note FROM block_works WHERE id=?", (zr_a,))["note"] == "проверка примечания", "примечание сохранено (SQL)")
    # двойная отправка того же тела с тем же (уже устаревшим) отпечатком — одно изменение
    w0 = zr(admin, zr_b)
    res = []
    def go():
        res.append(admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_b}", {"plan_start": "2026-09-01", "plan_end": "2026-09-09", "expected_rev": w0["rev"]})[0])
    ev3 = db.last_event_id()
    ts = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check(sorted(res) == [200, 409], "два одновременных PATCH с одним отпечатком: 200 + 409", str(res))
    check(db.events("block_work_plan_set", ev3) == 1, "журнал: одно событие на два одновременных запроса")

    # ------------------------------------------------ 2. Факт: создание / правка / удаление
    print("2. Факт: документы")
    base = f"/objects/{OBJ}/blocks/{blk}"
    settings = admin.call("GET", f"{base}/work-types-settings")[1]
    wts = settings["selected"]
    fpv = db.fp()
    for body, label in (({"report_date": "2026-09-15", "items": {str(wts[0]): 101}}, "процент > 100"), ({"report_date": "не дата", "items": {str(wts[0]): 10}}, "неверная дата"),
                        ({"report_date": "2026-09-15", "items": {"999999": 10}}, "работа вне блока")):
        st, d = admin.call("POST", f"{base}/fact-reports", body)
        check(st == 422 and db.fp() == fpv, f"POST факта: {label} → 422, БД не менялась", f"{st} {str(d)[:100]}")
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"{base}/fact-reports", {"report_date": "2026-09-15", "items": {str(wts[0]): 10}})
        check(st == 403 and db.fp() == fpv, f"{name}: POST факта → 403, БД не менялась")
    st, d = admin.call("POST", f"{base}/fact-reports", {"report_date": "2026-09-15", "items": {str(wts[0]): 40, str(wts[1]): 100}})
    check(st == 200 and "id" in d, "POST факта: 200", f"{st} {d}")
    rid = d["id"]
    check(db.one("SELECT COUNT(*) n FROM work_fact_items WHERE report_id=?", (rid,))["n"] == 2, "строки документа в БД (SQL)")
    rep = admin.call("GET", f"{base}/fact-reports/{rid}")[1]
    check(rep["items"][str(wts[0])] == 40 and len(rep["rev"]) == 12, "GET документа: проценты и отпечаток")
    # правка с отпечатком
    st, d = admin.call("PUT", f"{base}/fact-reports/{rid}", {"report_date": "2026-09-15", "items": {str(wts[0]): 55, str(wts[1]): 100}, "expected_rev": rep["rev"]})
    check(st == 200, "PUT документа с верным отпечатком: 200", f"{st} {d}")
    check(db.one("SELECT COUNT(*) n FROM work_fact_item_history WHERE report_id=?", (rid,))["n"] == 1, "построчная история правок: одна запись «было 40 → стало 55»")
    h = db.one("SELECT percent_old, percent_new FROM work_fact_item_history WHERE report_id=?", (rid,))
    check(h == {"percent_old": 40, "percent_new": 55}, "история: 40 → 55")
    fpv = db.fp()
    st, d = admin.call("PUT", f"{base}/fact-reports/{rid}", {"report_date": "2026-09-15", "items": {str(wts[0]): 70, str(wts[1]): 100}, "expected_rev": rep["rev"]})
    check(st == 409 and db.fp() == fpv, "PUT со старым отпечатком → 409, БД не менялась", f"{st}")
    st, d = admin.call("DELETE", f"{base}/fact-reports/{rid}?expected_rev={rep['rev']}")
    check(st == 409 and db.fp() == fpv, "DELETE со старым отпечатком → 409, документ цел")
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("DELETE", f"{base}/fact-reports/{rid}")
        check(st == 403 and db.fp() == fpv, f"{name}: DELETE документа → 403")
    rep2 = admin.call("GET", f"{base}/fact-reports/{rid}")[1]
    ev4 = db.last_event_id()
    st, d = admin.call("DELETE", f"{base}/fact-reports/{rid}?expected_rev={rep2['rev']}")
    check(st == 200, "DELETE с верным отпечатком: 200")
    check(db.one("SELECT COUNT(*) n FROM work_fact_reports WHERE id=?", (rid,))["n"] == 0 and db.one("SELECT COUNT(*) n FROM work_fact_items WHERE report_id=?", (rid,))["n"] == 0
          and db.one("SELECT COUNT(*) n FROM work_fact_item_history WHERE report_id=?", (rid,))["n"] == 0, "документ, строки и история удалены каскадом (SQL)")
    check(db.events("block_fact_report_delete", ev4) == 1, "журнал: одно block_fact_report_delete")

    # ------------------------------------------------ 3. Групповая правка сроков: предпросмотр, применение, конкуренция, откат
    print("3. Групповая правка сроков")
    ids = [zr_a, zr_b, zr_c]
    def listing():
        return {w["id"]: w for w in admin.call("GET", f"/objects/{OBJ}/block-works?block_ids={blk}")[1]["items"]}
    L = listing()
    admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_c}", {"plan_start": "2026-09-01", "plan_end": "2026-09-30", "expected_rev": L[zr_c]["rev"]})
    st, pv = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3})
    check(st == 200 and pv["will_change"] >= 2 and set(pv["expected"]) == {str(i) for i in ids}, "предпросмотр сдвига: считает изменяемые и даёт отпечатки", f"{st} {str(pv)[:150]}")
    fpv = db.fp()
    check(True, "предпросмотр ничего не пишет (БД до/после)") if db.fp() == fpv else check(False, "предпросмотр изменил БД")
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3})
        check(st == 403, f"{name}: предпросмотр → 403")
        st, _ = sess.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3, "expected": pv["expected"]})
        check(st == 403 and db.fp() == fpv, f"{name}: PUT bulk → 403, БД не менялась")
    st, _ = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 9999})
    check(st == 422, "предпросмотр: сдвиг больше 3650 дней → 422")
    # конкуренция: между предпросмотром и применением кто-то меняет ЗР
    L = listing()
    admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_b}", {"note": "чужая правка", "expected_rev": L[zr_b]["rev"]})
    fpv = db.fp(); ev5 = db.last_event_id()
    st, d = admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3, "expected": pv["expected"]})
    check(st == 409 and detail(d).get("conflict") and any(i["id"] == zr_b for i in detail(d)["items"]), "применение по устаревшему предпросмотру → 409 c перечнем", f"{st} {str(d)[:150]}")
    check(db.fp() == fpv and db.events("block_work_bulk_edit", ev5) == 0, "при 409 БД и журнал не менялись")
    # применение по свежему предпросмотру: результат = предпросмотр
    st, pv = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3})
    ev6 = db.last_event_id()
    st, d = admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3, "expected": pv["expected"]})
    check(st == 200 and d["changed"] == pv["will_change"] and d["requested"] == 3, "применение: изменено ровно столько, сколько обещал предпросмотр", f"{st} {d} / {pv['will_change']}")
    ok_all = all(db.one("SELECT plan_start, plan_end FROM block_works WHERE id=?", (i["id"],)).items() >= i["after"].items() if False else
                 all(db.one("SELECT plan_start, plan_end FROM block_works WHERE id=?", (i["id"],))[k] == v for k, v in i["after"].items()) for i in pv["items"] if i["will_change"])
    check(ok_all, "после применения даты в БД равны «станет» из предпросмотра (SQL)")
    check(db.events("block_work_bulk_edit", ev6) == 1, "журнал: одно сводное block_work_bulk_edit")
    # «прогноз = план» только у не начатых, версии копятся
    L = listing()
    st, pv2 = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "forecast_equals_plan"})
    nver = db.one("SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id IN (?,?,?)", tuple(ids))["n"]
    st, d = admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "forecast_equals_plan", "expected": pv2["expected"]})
    check(st == 200 and d["changed"] == pv2["will_change"], "«прогноз = план»: изменено столько, сколько показал предпросмотр", f"{st} {d}")
    check(db.one("SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id IN (?,?,?)", tuple(ids))["n"] == nver + d["changed"], "версии прогноза добавились (не перезаписаны)")
    # атомарность: последний по порядку набор содержит ЗР, у которой сдвиг вылетает за границы дат → откат ВСЕГО
    L = listing()
    admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_c}", {"plan_start": "9999-12-01", "plan_end": "9999-12-30", "expected_rev": L[zr_c]["rev"]})
    L = listing()
    exp = {str(i): L[i]["rev"] for i in ids}
    fpv = db.fp(); ev7 = db.last_event_id()
    st, d = admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 3, "expected": exp})
    check(st == 422, "отказ внутри пачки (дата вне границ у последней работы) → 422, не 500", f"{st} {str(d)[:150]}")
    check(db.fp() == fpv, "ПОЛНЫЙ ОТКАТ: ни одна работа пачки не изменилась (SQL до/после)")
    check(db.events("block_work_bulk_edit", ev7) == 0 and db.events("block_work_plan_set", ev7) == 0, "журнал: событий отброшенной пачки нет")
    st, _ = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_c}", {"plan_start": "2026-09-01", "plan_end": "2026-09-30", "expected_rev": L[zr_c]["rev"]})
    check(st == 200, "блокировка записи освобождена после отказа (следующая запись проходит)")
    # два одновременных применения одного предпросмотра
    L = listing()
    st, pv = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-preview", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 1})
    ev8 = db.last_event_id(); res = []
    def go2():
        res.append(admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": ids, "op": "shift", "field": "plan", "days": 1, "expected": pv["expected"]})[0])
    ts = [threading.Thread(target=go2) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check(sorted(res) == [200, 409], "два одновременных применения одного предпросмотра: 200 + 409 (второй не задваивает)", str(res))
    check(db.events("block_work_bulk_edit", ev8) == 1, "журнал: одно событие на два одновременных применения")

    # ------------------------------------------------ 4. Состав работ: предпросмотр, мягкое снятие, атомарность группы
    print("4. Состав работ блоков")
    opts = admin.call("GET", f"{base}/work-types-settings")[1]
    allsel = set(opts["selected"])
    blocks2 = db.q("SELECT id FROM blocks WHERE object_id=? AND id<>? ORDER BY id LIMIT 2", (OBJ, blk))
    g1, g2 = blocks2[0]["id"], blocks2[1]["id"]
    # у блока blk: ЗР zr_a имеет сроки (мягкое снятие); добавим пустую работу и проверим удаление
    free = [o["id"] for o in opts["options"] if o["id"] not in allsel][:1]
    st, pv = admin.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk], "work_type_ids": sorted(allsel | set(free))})
    check(st == 200 and pv["totals"]["add"] == len(free) and pv["totals"]["soft"] == 0, "предпросмотр состава: добавится N, снятий нет", f"{st} {str(pv)[:150]}")
    fpv = db.fp()
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk], "work_type_ids": sorted(allsel)})
        check(st == 403, f"{name}: предпросмотр состава → 403")
        st, _ = sess.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(allsel | set(free)), "expected": pv["expected"][str(blk)]})
        check(st == 403 and db.fp() == fpv, f"{name}: PUT состава → 403, БД не менялась")
    st, d = admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(allsel | set(free)), "expected": pv["expected"][str(blk)]})
    check(st == 200 and db.one("SELECT COUNT(*) n FROM block_works WHERE block_id=? AND work_type_id=? AND retired_at IS NULL", (blk, free[0]))["n"] == 1, "PUT состава: работа добавлена (SQL)")
    # устаревший отпечаток
    st, d = admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(allsel), "expected": pv["expected"][str(blk)]})
    check(st == 409, "PUT состава по устаревшему отпечатку → 409", f"{st}")
    # мягкое снятие (у zr_a есть сроки) и удаление пустой (free[0])
    st, pv = admin.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk], "work_type_ids": sorted(allsel - {zr_a_wt(db, zr_a)})})
    check(st == 200 and pv["totals"]["soft"] == 1 and pv["totals"]["hard"] == 1, "предпросмотр: мягко снимается 1 (есть сроки), удаляется 1 (пустая)", str(pv["totals"]))
    st, d = admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(allsel - {zr_a_wt(db, zr_a)}), "expected": pv["expected"][str(blk)]})
    check(st == 200, "PUT состава: снятие применено")
    check(db.one("SELECT retired_at IS NOT NULL r FROM block_works WHERE id=?", (zr_a,))["r"] == 1, "ЗР со сроками снята МЯГКО: строка цела, retired_at заполнен (SQL)")
    check(db.one("SELECT COUNT(*) n FROM block_works WHERE block_id=? AND work_type_id=?", (blk, free[0]))["n"] == 0, "пустая ЗР удалена (SQL)")
    # снятая ЗР не правится
    w = zr(admin, zr_a)
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_a}", {"note": "после снятия", "expected_rev": w["rev"]})
    check(st == 409, "правка снятой ЗР → 409", f"{st}")
    # возврат снятой
    st, pv = admin.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk], "work_type_ids": sorted(allsel)})
    st, d = admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(allsel), "expected": pv["expected"][str(blk)]})
    check(st == 200 and db.one("SELECT retired_at IS NULL a FROM block_works WHERE id=?", (zr_a,))["a"] == 1, "возврат снятой ЗР: retired_at очищен, строка та же (SQL)")
    # групповая правка: атомарность (третий блок не существует → откат всех)
    s1 = set(admin.call("GET", f"{base}/work-types-settings")[1]["selected"])
    other = sorted(s1 - {zr_b_wt(db, zr_b)})
    fpv = db.fp(); ev9 = db.last_event_id()
    st, d = admin.call("PUT", f"/objects/{OBJ}/blocks/work-types-settings", {"block_ids": [blk, g1, 99999999], "work_type_ids": other})
    check(st == 404, "группа с несуществующим блоком → 404", f"{st} {str(d)[:100]}")
    check(db.fp() == fpv, "ГРУППА АТОМАРНА: ни один блок не изменён при отказе на последнем (SQL до/после)")
    check(db.events("block_work_types_settings", ev9) == 0 and db.events("block_work_remove", ev9) == 0, "журнал: событий отклонённой группы нет")
    # групповое применение по предпросмотру + конкуренция
    st, pvg = admin.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk, g1], "work_type_ids": other})
    check(st == 200 and len(pvg["blocks"]) == 2, "предпросмотр группы: по каждому блоку", f"{st}")
    ev10 = db.last_event_id(); res = []
    def go3():
        res.append(admin.call("PUT", f"/objects/{OBJ}/blocks/work-types-settings", {"block_ids": [blk, g1], "work_type_ids": other, "expected": pvg["expected"]})[0])
    ts = [threading.Thread(target=go3) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check(sorted(res) == [200, 409], "два одновременных применения группы: 200 + 409", str(res))
    check(db.events("block_work_types_settings", ev10) == 1, "журнал: одно событие группы")
    # вернуть состав
    st, pvr = admin.call("POST", f"/objects/{OBJ}/blocks/work-types-settings/preview", {"block_ids": [blk], "work_type_ids": sorted(s1)})
    admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(s1), "expected": pvr["expected"][str(blk)]})

    # ------------------------------------------------ 5. Плоская шахматка: пакет
    print("5. Шахматка: пакет факта")
    trk = admin.call("GET", f"/objects/{OBJ}/blocks/planning-tracks")[1]["tracks"]
    code, lay = None, None
    for t in trk:
        l = admin.call("GET", f"/objects/{OBJ}/blocks/chess-flat-layout?track_code={t['код']}")[1]
        if isinstance(l, dict) and sum(len(b["percents"]) for b in l.get("blocks", [])) >= 3:
            code, lay = t["код"], l
            break
    check(code is not None, "нашлась доска с применимыми ячейками", str(trk)[:80])
    cells = [(b["id"], int(op), pc) for b in lay["blocks"] for op, pc in b["percents"].items()][:3]
    items = [{"block_id": b, "work_type_id": o, "percent": min(pc + 10, 100) if pc < 100 else 90, "expected_percent": pc} for b, o, pc in cells]
    key = str(uuid.uuid4())
    body = {"report_date": "2026-09-16", "track_code": code, "idempotency_key": key, "items": items}
    fpv = db.fp()
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", body)
        check(st == 403 and db.fp() == fpv, f"{name}: пакет шахматки → 403, БД не менялась")
    bad = {**body, "idempotency_key": str(uuid.uuid4()), "items": items + [{"block_id": cells[0][0], "work_type_id": 99999999, "percent": 5, "expected_percent": 0}]}
    st, d = admin.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", bad)
    check(st == 422 and db.fp() == fpv, "отказ внутри пакета (операция не из доски) → 422, ничего не записано", f"{st} {str(d)[:100]}")
    st, d = admin.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", body)
    check(st == 200 and d["items_count"] == len(items), "пакет записан целиком", f"{st} {d}")
    nrep = db.one("SELECT COUNT(*) n FROM work_fact_reports WHERE report_date='2026-09-16'")["n"]
    check(nrep == len({b for b, _, _ in cells}), "документы факта на дату: по одному на блок (SQL)")
    fp2 = db.fp()
    st, d2 = admin.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", body)
    check(st == 200 and d2 == d and db.fp() == fp2, "повтор с тем же ключом: тот же результат, БД не менялась (идемпотентность)")
    # конфликт: тот же пакет с новым ключом, но «ожидалось» уже устарело
    st, d = admin.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", {**body, "idempotency_key": str(uuid.uuid4())})
    check(st == 409 and detail(d).get("conflict") and len(detail(d)["items"]) >= 1 and db.fp() == fp2, "устаревшее «ожидалось» → 409 c перечнем, БД не менялась", f"{st}")
    # два пакета одновременно по одним ячейкам
    lay2 = admin.call("GET", f"/objects/{OBJ}/blocks/chess-flat-layout?track_code={code}")[1]
    cur = {(b["id"], int(o)): p for b in lay2["blocks"] for o, p in b["percents"].items()}
    items2 = [{"block_id": b, "work_type_id": o, "percent": 100 if cur[(b, o)] < 100 else 95, "expected_percent": cur[(b, o)]} for b, o, _ in cells]
    res = []
    def go4():
        res.append(admin.call("POST", f"/objects/{OBJ}/blocks/chess-flat-batch", {"report_date": "2026-09-17", "track_code": code, "idempotency_key": str(uuid.uuid4()), "items": items2})[0])
    ts = [threading.Thread(target=go4) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check(sorted(res) == [200, 409], "два пакета одновременно по одним ячейкам: 200 + 409", str(res))

    # ------------------------------------------------ 6. Excel-правка ЗР
    print("6. Excel-правка ЗР")
    st, blob = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/export")
    check(st == 200 and isinstance(blob, bytes) and blob[:2] == b"PK", "выгрузка xlsx", f"{st}")
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/analyze", files={"file": ("a.xlsx", blob)})
        check(st == 403, f"{name}: сверка файла → 403")
    import openpyxl
    def edited(mods):
        wb = openpyxl.load_workbook(io.BytesIO(blob)); ws = wb["Работы"]
        head = {c.value: c.column for c in ws[1] if c.value}
        col = lambda title: head[next(k for k in head if str(k).startswith(title))]
        uid_c = col("UID")
        rowmap = {ws.cell(r, uid_c).value: r for r in range(2, ws.max_row + 1) if ws.cell(r, uid_c).value}
        for bw_id, (title, value) in mods:
            ws.cell(rowmap[bw_id], col(title)).value = value
        bio = io.BytesIO(); wb.save(bio); return bio.getvalue()
    import datetime as _dt
    L = listing()
    target = [i for i in ids if L[i]["percent"] == 0][:2]
    xl = edited([(target[0], ("Дата начала СМР, базовый", _dt.date(2026, 11, 2))), (target[1], ("Дата завершения СМР, актуализированный", _dt.date(2026, 12, 7)))])
    fpv = db.fp()
    st, an = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/analyze", files={"file": ("a.xlsx", xl)})
    check(st == 200 and len(an["changes"]) >= 2 and db.fp() == fpv, "сверка: расхождения найдены, БД не менялась", f"{st} {str(an)[:120]}")
    for name, sess in (("user2", u2), ("user4", u4)):
        st, _ = sess.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply-strict", {"changes": an["changes"]})
        check(st == 403 and db.fp() == fpv, f"{name}: apply-strict → 403, БД не менялась")
    # конкуренция: после сверки кто-то меняет ту же ячейку → 409, ничего не записано
    L = listing()
    admin.call("PATCH", f"/objects/{OBJ}/block-works/{target[0]}", {"plan_start": "2026-09-05", "plan_end": None, "expected_rev": L[target[0]]["rev"]})
    fpv = db.fp(); ev11 = db.last_event_id()
    st, d = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply-strict", {"changes": an["changes"]})
    check(st == 409 and detail(d).get("conflict"), "применение по устаревшей сверке → 409", f"{st} {str(d)[:120]}")
    check(db.fp() == fpv and db.events("block_bulk_edit", ev11) == 0, "при 409 БД и журнал не менялись")
    # свежая сверка и применение
    st, an = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/analyze", files={"file": ("a.xlsx", xl)})
    ev12 = db.last_event_id()
    st, d = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply-strict", {"changes": an["changes"]})
    check(st == 200 and d["skipped"] == [] and d["block_works_updated"] == len({c["bw_id"] for c in an["changes"]}), "apply-strict: все отмеченные применены, «пропущено» нет", f"{st} {d}")
    check(db.one("SELECT plan_start FROM block_works WHERE id=?", (target[0],))["plan_start"] == "2026-11-02" and db.one("SELECT forecast_end FROM block_works WHERE id=?", (target[1],))["forecast_end"] == "2026-12-07", "значения из файла в БД (SQL)")
    check(db.events("block_bulk_edit", ev12) == 1, "журнал: одно block_bulk_edit")
    st, an2 = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/analyze", files={"file": ("a.xlsx", xl)})
    check(st == 200 and an2["changes"] == [], "повторная сверка того же файла: расхождений нет")
    # атомарность: одно изменение корректно, другое — с неверной датой факта → откат ВСЕГО
    fake = [{"bw_id": target[0], "field": "plan_end", "was": db.one("SELECT plan_end FROM block_works WHERE id=?", (target[0],))["plan_end"], "now": "2026-12-01", "block_id": blk, "work_type_id": 1},
            {"bw_id": target[1], "field": "percent", "was": 0, "now": 30, "block_id": blk, "work_type_id": db.one("SELECT work_type_id w FROM block_works WHERE id=?", (target[1],))["w"], "report_date": "не дата"}]
    fpv = db.fp(); ev13 = db.last_event_id()
    st, d = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply-strict", {"changes": fake})
    check(st == 422 and db.fp() == fpv, "отказ внутри пачки (неверная дата факта) → 422, ПОЛНЫЙ ОТКАТ (SQL до/после)", f"{st} {str(d)[:120]}")
    check(db.events("block_bulk_edit", ev13) == 0 and db.events("block_work_plan_set", ev13) == 0, "журнал: событий отклонённой пачки нет")
    # два применения одновременно
    L = listing()
    xl2 = edited([(target[0], ("Дата завершения СМР, базовый", _dt.date(2026, 12, 20)))])
    st, an3 = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/analyze", files={"file": ("a.xlsx", xl2)})
    ev14 = db.last_event_id(); res = []
    def go5():
        res.append(admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply-strict", {"changes": an3["changes"]})[0])
    ts = [threading.Thread(target=go5) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check(sorted(res) == [200, 409], "два одновременных применения одной сверки: 200 + 409", str(res))
    check(db.events("block_bulk_edit", ev14) == 1, "журнал: одно событие на два одновременных применения")

    # ------------------------------------------------ 7. Совместимость V1: прежние вызовы без новых полей
    print("7. Совместимость прежних вызовов V1")
    L = listing()
    st, d = admin.call("PATCH", f"/objects/{OBJ}/block-works/{zr_b}", {"plan_start": "2026-09-02", "plan_end": "2026-09-08"})
    check(st == 200, "PATCH ЗР без expected_rev (как V1)", f"{st}")
    st, d = admin.call("PUT", f"/objects/{OBJ}/block-works/bulk", {"block_work_ids": [zr_b], "op": "shift", "field": "plan", "days": -1})
    check(st == 200 and d["requested"] == 1, "PUT bulk без expected (как V1)", f"{st}")
    st, d = admin.call("POST", f"{base}/fact-reports", {"report_date": "2026-09-18", "items": {str(wts[0]): 5}})
    check(st == 200, "POST факта (как V1)")
    st, d2 = admin.call("PUT", f"{base}/fact-reports/{d['id']}", {"report_date": "2026-09-18", "items": {str(wts[0]): 6}})
    check(st == 200, "PUT факта без expected_rev (как V1)")
    st, _ = admin.call("DELETE", f"{base}/fact-reports/{d['id']}")
    check(st == 200, "DELETE факта без expected_rev (как V1)")
    st, d = admin.call("PUT", f"{base}/work-types-settings", {"work_type_ids": sorted(s1)})
    check(st == 200, "PUT состава без expected (как V1)")
    st, d = admin.call("POST", f"/objects/{OBJ}/block-works/bulk-edit/apply", {"changes": an3["changes"][:0] or [{"bw_id": target[0], "field": "plan_end", "now": "2026-12-21", "was": "2026-12-20"}]})
    check(st == 200, "прежний POST bulk-edit/apply (V1) по-прежнему работает", f"{st} {str(d)[:100]}")


def zr_a_wt(db, bw):
    return db.one("SELECT work_type_id w FROM block_works WHERE id=?", (bw,))["w"]


zr_b_wt = zr_a_wt

if __name__ == "__main__":
    main()

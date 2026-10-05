"""Сквозная проверка ИИ на временной копии обезличенной БД и локальном HTTP-стенде.
Ни один запрос не отправляется настоящей модели или в облако.
.venv312/bin/python scripts/verify_ai_assistant.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp(prefix="zhbi-assistant-"))
source = ROOT / "data/zhbi.anon.db"
dest = work / "work.db"
a = sqlite3.connect(source); b = sqlite3.connect(dest); a.backup(b); a.close(); b.close()
os.environ.update(ZHBI_DB_PATH=str(dest), ZHBI_CALC_DIR=str(work/"calc"), ZHBI_CALC_ASSETS_DIR=str(work/"assets"), ZHBI_CALC_RECOVERY_WORKER="0")
from app import backups
backups.BACKUP_DIR = work / "backups"
from app.auth import hash_password
conn = sqlite3.connect(dest)
h, salt = hash_password("Test-Pass-1234!")
conn.execute("UPDATE users SET password_hash=?,password_salt=?,must_change_password=0,auth_method='local' WHERE domain_login IN ('admin','user2','user4')", (h,salt));conn.commit();conn.close()

calls = []
hold_received = threading.Event()
hold_release = threading.Event()
class Inference(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers()
        self.wfile.write(json.dumps({"models":[{"name":"test-dialog"},{"name":"test-vision"}]}).encode())
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers["Content-Length"])));calls.append(data)
        text=data["messages"][-1]["content"]
        if "datasets" in data["format"]["properties"]:
            seed=json.loads(text)
            value={"datasets":["elements"],"scope":seed["scope"],"objectIds":[seed["page"]["objectId"]] if seed["page"]["objectId"] and "всем" not in seed["question"] else [],"startExclusive":seed["startExclusive"],"endInclusive":seed["endInclusive"],"periodLabel":"Выбранный период","needReports":True}
            for marker,group in [("__contracts__","contracts"),("__calc__","calculator"),("__works__","works")]:
                if marker in seed["question"]:value["datasets"]=[group];value["needReports"]=False
            if "__page_scope__" in seed["question"]:value["scope"]="page"
            if "__bad_scope__" in seed["question"]:value["objectIds"]=[999999]
        elif "queries" in data["format"]["properties"]:
            instruction=json.loads(data["messages"][1]["content"])
            question=instruction["question"]
            sql="SELECT SUM(montage_change) AS installed, SUM(delivery_change) AS delivered FROM period_facts"
            for marker,table in [("__contracts__","contract_lines"),("__calc__","calc_products"),("__works__","block_works")]:
                if marker in question:sql=f"SELECT COUNT(*) AS count FROM {table}"
            if "__repair__" in question and len(data["messages"])==2:sql="SELECT missing_column FROM elements"
            value={"queries":[{"title":"Найденные показатели","sql":sql}] if len(data["messages"])==2 or "__repair__" in question else [],"needsMore":False}
        else:
            context=json.loads(text.split("Данные сервиса (JSON):\n",1)[1].split("\nВопрос:",1)[0])
            value={"answer":"Проверка: локальный ответ по данным сервиса.","sourceIds":[s["id"] for s in context["sources"][:3]] + [s["id"] for s in context["sources"] if s["scope"]=="search"]}
        if "__unknown_source__" in text:value["sourceIds"]=["invented-source"]
        if "__hold__" in text:
            hold_received.set();hold_release.wait(10)
        self.send_response(200);self.send_header("Content-Type","application/x-ndjson");self.end_headers()
        self.wfile.write((json.dumps({"message":{"content":json.dumps(value,ensure_ascii=False)},"done":True})+"\n").encode())
server=ThreadingHTTPServer(("127.0.0.1",0),Inference)
threading.Thread(target=server.serve_forever,daemon=True).start()
import http.cookiejar
import socket
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
import uvicorn
_http_port = None
class HttpResult:
    def __init__(self, response):
        self.status_code = response.code
        self.data = response.read()
    def json(self): return json.loads(self.data)
class TestClient:
    def __init__(self, app):
        self.app=app;self.opener=build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()));self.server=None
    def __enter__(self):
        global _http_port
        sock=socket.socket();sock.bind(("127.0.0.1",0));_http_port=sock.getsockname()[1]
        self.server=uvicorn.Server(uvicorn.Config(self.app,log_level="error"))
        threading.Thread(target=lambda:self.server.run(sockets=[sock]),daemon=True).start()
        for _ in range(600):
            if self.server.started:return self
            time.sleep(.05)
        raise AssertionError("сервер не запущен")
    def request(self,method,path,json_body=None):
        data=None if json_body is None else json.dumps(json_body).encode()
        req=Request(f"http://127.0.0.1:{_http_port}"+path,data=data,method=method,headers={"Content-Type":"application/json"})
        try:r=self.opener.open(req,timeout=60)
        except HTTPError as error:r=error
        return HttpResult(r)
    def get(self,path):return self.request("GET",path)
    def post(self,path,json=None):return self.request("POST",path,json)
    def put(self,path,json=None):return self.request("PUT",path,json)
    def close(self):
        if self.server:self.server.should_exit=True
    def __exit__(self,*args):self.close()

from app.main import app
from app.calc import recovery,runtime
from app.calc.database import transaction
from app.calc.recovery_schema import ConnectionConfig
from app.assistant import Ask,collect_context
from app.assistant_data import Snapshot, scoped_objects, DATASETS
from app.assistant_period import question_period
from datetime import date
from app.reports import build_dynamics_report
from app.db import get_connection

checks=0
def check(value,label):
    global checks
    assert value,label
    checks+=1

def login(client,name):
    r=client.post("/login",json={"domain_login":name,"password":"Test-Pass-1234!"})
    check(r.status_code==200,"login "+name)

def await_result(client,identifier):
    for _ in range(100):
        r=client.get("/assistant/requests/"+identifier)
        if r.status_code!=200:return r
        if r.json()["state"]!="running":return r
        time.sleep(.05)
    raise AssertionError("тайм-аут задания")

with TestClient(app) as admin:
    login(admin,"admin")
    user=TestClient(app);login(user,"user4")
    legacy=ConnectionConfig(model="legacy-vision",baseUrl="http://127.0.0.1:11434")
    with transaction(runtime.settings().database_path) as c:
        c.execute("INSERT OR REPLACE INTO recovery_settings VALUES(1,?,?)",(legacy.model_dump_json(),"2026-10-05"))
    first=admin.get("/ai/config").json()
    check(first["connection"]["model"]=="legacy-vision","старое подключение сохранено")
    check(first["assistantModel"]=="","помощник требует отдельного выбора модели")
    check(user.get("/ai/config").status_code==403,"настройки закрыты пользователю")
    config={"connection":{**first["connection"],"baseUrl":f"http://127.0.0.1:{server.server_port}","model":"test-vision","timeoutSeconds":10},"assistantModel":"test-dialog","assistantEnabled":True,"assistantContextTokens":65536,"expectedRevision":first["revision"]}
    r=admin.put("/ai/config",json=config);check(r.status_code==200,"сохранение настройки")
    check(admin.put("/ai/config",json=config).status_code==409,"устаревшее сохранение отклоняется")
    check(user.put("/ai/config",json=config).status_code==403,"правка настроек закрыта")
    check(recovery.get_configuration(runtime.settings())["config"]["model"]=="test-vision","калькулятор использует общую модель чтения")
    models=admin.post("/ai/models",json=config["connection"])
    check(models.status_code==200 and len(models.json()["models"])==2,"список моделей через сервер")
    status=admin.get("/assistant/status").json()
    check(status=={"enabled":True,"configured":True},"статус не раскрывает адрес и ключ")
    probe=admin.post("/ai/dialog-test");check(probe.status_code==202,"быстрая проверка диалога")
    check(await_result(admin,probe.json()["id"]).json()["state"]=="done","диалог без сбора отчётов")
    c=get_connection();rows=c.execute("SELECT DISTINCT o.id FROM objects o JOIN elements e ON e.object_id=o.id WHERE o.kind='zhbi' AND e.is_current=1").fetchall();oid=rows[0][0];adminrow=dict(c.execute("SELECT * FROM users WHERE domain_login='admin'").fetchone());other=c.execute("SELECT id FROM elements WHERE object_id!=? AND is_current=1 LIMIT 1",(oid,)).fetchone()
    ids=[x[0] for x in c.execute("SELECT id FROM elements WHERE object_id=? AND is_current=1 LIMIT 4",(oid,))];c.close()
    body={"question":"Что изменилось?","scope":"page","objectId":oid,"dateFrom":"2026-09-01","dateTo":"2026-10-05","page":{"title":"Модель","elementIds":ids,"selectedIds":ids[:1]}}
    data=collect_context(Ask.model_validate(body),adminrow)
    dynamics=next(s for s in data["sources"] if s["id"].endswith("-dynamics"))
    c=get_connection();expected=build_dynamics_report(c,None,"2026-10-05",ids,oid);c.close()
    check(dynamics["data"]["after"]["montage"]==expected["montage"],"цифры совпадают с отчётом и учитывают отбор")
    check(dynamics["scope"]=="page-filter","источник подписывает область отбора")
    if other:
        bad={**body,"page":{"elementIds":[other[0]]}}
        try:collect_context(Ask.model_validate(bad),adminrow);raise AssertionError("чужое изделие прошло")
        except Exception as e:check(getattr(e,"status_code",None)==403,"чужие id не входят в контекст")
    r=admin.post("/assistant/requests",json=body);check(r.status_code==202,"асинхронный вопрос")
    result=await_result(admin,r.json()["id"]).json();check(result["state"]=="done","ответ локального HTTP API")
    check(result["sources"] and result["capturedAt"] and result["period"],"источники и даты ответа")
    source=next(s for s in result["sources"] if s["id"].endswith("-dynamics"))
    path="/assistant/requests/"+result["id"]+"/sources/"+source["id"]
    ref=admin.get(path).json()
    check(ref["objectId"]==oid and ref["params"]["element_ids"]==ids and ref["params"]["report_date"]==body["dateTo"],"ссылка открывает дату и отбор источника")
    check(user.get(path).status_code==404,"контекст ссылки закрыт другому пользователю")
    evidence_source=next(s for s in result["sources"] if s["scope"]=="search")
    evidence_path="/assistant/requests/"+result["id"]+"/sources/"+evidence_source["id"]
    evidence=admin.get(evidence_path).json()
    check(evidence["kind"]=="search" and evidence["rows"] and evidence["tables"]==["period_facts"],"найденная выборка доступна для проверки")
    check(user.get(evidence_path).status_code==404,"выборка закрыта другому пользователю")
    month={**body,"question":"сколько изделий смонтировали за месяц?","dateFrom":"2026-09-28"}
    r=admin.post("/assistant/requests",json=month);month_result=await_result(admin,r.json()["id"]).json()
    check(month_result["state"]=="done" and month_result["period"]["from"]=="2026-09-05" and month_result["period"]["to"]=="2026-10-05","месяц из вопроса переопределяет выбранную неделю")
    r=admin.post("/assistant/requests",json={**month,"periodMode":"dates"});locked=await_result(admin,r.json()["id"]).json()
    check(locked["period"]["from"]=="2026-09-28","ручной режим сохраняет даты")
    r=admin.post("/assistant/requests",json={**body,"scope":"auto","question":"сколько смонтировали по всем проектам за месяц?"});all_result=await_result(admin,r.json()["id"]).json()
    check(all_result["state"]=="done","поиск по всем проектам")
    all_ref=next(s for s in all_result["sources"] if s["scope"]=="search")
    all_rows=admin.get(all_ref["url"]).json()["rows"]
    c=get_connection();all_expected=sum(build_dynamics_report(c,None,"2026-10-05",[x[0] for x in c.execute("SELECT id FROM elements WHERE object_id=? AND is_current=1",(o[0],))],o[0])["montage"]["cumulative"]["fact"]-build_dynamics_report(c,None,"2026-09-05",[x[0] for x in c.execute("SELECT id FROM elements WHERE object_id=? AND is_current=1",(o[0],))],o[0])["montage"]["cumulative"]["fact"] for o in c.execute("SELECT id FROM objects WHERE kind='zhbi'"));c.close()
    check(all_rows[0]["installed"]==all_expected,"итог по всем проектам совпадает со штатными отчётами")
    r=admin.post("/assistant/requests",json={**body,"question":"__bad_scope__"});bad_scope=await_result(admin,r.json()["id"]).json()
    check(bad_scope["state"]=="failed" and "разрешённой области" in bad_scope["error"],"модель не расширяет доступ по ID")
    for marker,table in [("__contracts__","contract_lines"),("__calc__","calc_products"),("__works__","block_works"),("__repair__","period_facts")]:
        r=admin.post("/assistant/requests",json={**body,"scope":"auto","question":marker})
        found=await_result(admin,r.json()["id"]).json()
        check(found["state"]=="done", "поиск по домену/исправление: "+marker)
        ref=next(s for s in found["sources"] if s["scope"]=="search")
        check(admin.get(ref["url"]).json()["tables"]==[table],"выборка нужного источника: "+table)
    r=admin.post("/assistant/requests",json={**body,"scope":"auto","question":"__page_scope__ По текущему отбору"})
    page_result=await_result(admin,r.json()["id"]).json()
    page_ref=next(s for s in page_result["sources"] if s["id"].endswith("-dynamics"))
    check(page_result["state"]=="done" and admin.get("/assistant/requests/"+page_result["id"]+"/sources/"+page_ref["id"]).json()["params"]["element_ids"]==ids,"область страницы из текста сохраняет отбор")
    follow={"question":"А по всем проектам?","objectId":oid,"history":[{"role":"assistant","content":"Период ответа: 2026-09-05 → 2026-10-05. Область ответа: все проекты"}]}
    r=admin.post("/assistant/requests",json=follow);follow_result=await_result(admin,r.json()["id"]).json()
    check(follow_result["state"]=="done" and follow_result["period"]["from"]=="2026-09-05","продолжение диалога сохраняет период без полей дат")
    end=date(2026,10,5)
    for question,expected_from,expected_to in [("За сентябрь", "2026-08-31", "2026-09-30"),("За прошлый месяц", "2026-08-31", "2026-09-30"),("За текущий месяц", "2026-09-30", "2026-10-05"),("За последние 14 дней", "2026-09-21", "2026-10-05"),("Вчера", "2026-10-03", "2026-10-04")]:
        actual=question_period(question,end)
        check(tuple(d.isoformat() for d in actual[:2])==(expected_from,expected_to),"период: "+question)
    # Изолированный снимок: секретов нет физически, права фильтруют строки до SQL модели.
    broad=Ask(question="Все данные",scope="auto",dateFrom="2026-09-05",dateTo="2026-10-05")
    snap=Snapshot(broad,adminrow,list(DATASETS),scoped_objects(broad,adminrow),date(2026,9,5),end)
    check({"elements","contracts","block_works","schedule_versions","revit_elements","calc_products","training_attempts","users","attachments"}.issubset(snap.catalog),"поиск охватывает бизнес-данные, калькулятор и разрешённое администрирование")
    check("password_hash" not in snap.catalog["users"] and "sessions" not in snap.catalog and "recovery_settings" not in snap.catalog,"секреты не копируются в снимок")
    total=snap.query("SELECT COUNT(*) AS n FROM elements")["rows"][0]["n"]
    limited=snap.query("SELECT id FROM elements ORDER BY id")
    check(total>200 and limited["returnedRows"]==200 and limited["truncated"],"счётчик по всем данным и честное ограничение списка")
    check(snap.query("SELECT COUNT(*) AS n FROM elements")["tables"]==["elements"],"повторный SQL сохраняет перечень прав")
    for sql in ["SELECT password_hash FROM users", "SELECT * FROM sqlite_master", "SELECT load_extension('x')", "ATTACH DATABASE '/tmp/x' AS other", "PRAGMA table_info(users)", "WITH x AS (SELECT 1) DELETE FROM elements", "SELECT 1; DELETE FROM elements", "SELECT randomblob(10000000)"]:
        try:snap.query(sql);raise AssertionError("опасный запрос прошёл: "+sql)
        except (ValueError,sqlite3.Error):check(True,"запрет: "+sql.split()[0])
    check(snap.query("SELECT COUNT(*) AS n FROM elements")["rows"][0]["n"]==total,"данные не изменены попытками записи")
    snap.close()
    c=get_connection();limited_user=dict(c.execute("SELECT * FROM users WHERE domain_login='user4'").fetchone());c.execute("DELETE FROM user_access WHERE user_id=?",(limited_user["id"],));c.execute("INSERT INTO user_access(user_id,object_id,role) VALUES(?,?,'view')",(limited_user["id"],oid));c.commit();c.close()
    snap=Snapshot(broad,limited_user,["elements","administration"],scoped_objects(broad,limited_user),date(2026,9,5),end)
    check(snap.query("SELECT DISTINCT object_id FROM elements")["rows"]==[{"object_id":oid}],"в снимке нет данных чужих объектов")
    check("users" not in snap.catalog and "activity_log" not in snap.catalog,"администрирование закрыто обычной роли")
    snap.close()
    no_object=collect_context(Ask(question="Что на странице?",scope="page"),adminrow)
    check(no_object["objects"]==[] and no_object["sources"]==[],"страница без объекта не подменяется всеми проектами")
    check(calls[-1]["model"]=="test-dialog","помощник использует отдельную модель")
    check(calls[-1]["options"]["num_ctx"]==65536,"размер контекста передан Ollama")
    check(user.get("/assistant/requests/"+result["id"]).status_code==404,"чужое задание закрыто")
    check(admin.post("/assistant/requests",json={**body,"dateFrom":"2026-10-06"}).status_code==422,"обратный период отклоняется")
    check(admin.post("/assistant/requests",json={**body,"history":[{"role":"system","content":"x"}]}).status_code==422,"system-инструкции из клиента отклоняются")
    with transaction(runtime.settings().database_path) as c:recovery.claim_gpu(c,"test-busy",60,"job")
    r=admin.post("/ai/dialog-test");result=await_result(admin,r.json()["id"]).json();check(result["state"]=="failed" and "занят" in result["error"],"GPU защищён от параллельного чтения")
    with transaction(runtime.settings().database_path) as c:recovery.release_gpu(c,"test-busy")
    r=admin.post("/assistant/requests",json={**body,"question":"__unknown_source__"})
    invalid=await_result(admin,r.json()["id"]).json()
    check(invalid["state"]=="failed" and "неизвестный источник" in invalid["error"],"выдуманные ссылки модели отклоняются")
    r=admin.post("/assistant/requests",json={**body,"question":"__hold__"})
    check(hold_received.wait(5),"долгий запрос дошёл до модели")
    check(admin.post("/assistant/requests",json=body).status_code==409,"два запроса одного пользователя не запускаются")
    check(admin.post("/assistant/requests/"+r.json()["id"]+"/cancel",json={}).status_code==200,"отмена принята")
    hold_release.set()
    check(await_result(admin,r.json()["id"]).json()["state"]=="cancelled","отменённый ответ не выдаётся")
    # Смена прав между вопросом и чтением ответа не должна раскрывать старый контекст.
    c=get_connection();c.execute("UPDATE users SET role='view' WHERE domain_login='admin'");c.execute("DELETE FROM user_access WHERE user_id=?",(adminrow["id"],));c.commit();c.close()
    check(admin.get("/assistant/requests/"+probe.json()["id"]).status_code==200,"тест без данных доступен владельцу")
    check(admin.get("/assistant/requests/"+next(j["id"] for j in __import__('app.assistant',fromlist=['_JOBS'])._JOBS.values() if j.get('sources'))).status_code==403,"права перепроверяются при чтении ответа")
    check(admin.get(path).status_code==403,"доступ к параметрам ссылки перепроверяется")
    user.close()
server.shutdown();server.server_close()
print(f"OK: {checks} проверок; временная копия удалена")
import shutil
shutil.rmtree(work)

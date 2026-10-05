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
        context=json.loads(text.split("Данные сервиса (JSON):\n",1)[1].split("\nВопрос:",1)[0])
        value={"answer":"Проверка: локальный ответ по данным сервиса.","sourceIds":[s["id"] for s in context["sources"][:3]]}
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
print(f"OK: {checks} проверок; копия {work}")

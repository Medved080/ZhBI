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
print("Test workspace:", work)
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
reason_received = threading.Event()
reason_release = threading.Event()
class Inference(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers()
        self.wfile.write(json.dumps({"models":[{"name":"test-dialog"},{"name":"test-vision"}]}).encode())
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers["Content-Length"])));calls.append(data)
        text=data["messages"][-1]["content"]
        if "reasoning-regression" in text:
            openai="format" not in data
            if "-legacy400" in text and "chat_template_kwargs" in data:
                self.send_response(400);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(b'{"error":"Compatibility request rejected"}');return
            if "-unsupported" in text:
                key=next((k for k in ("reasoning_effort","chat_template_kwargs","think") if k in data),None)
                if key:
                    self.send_response(400);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(json.dumps({"error":"Unsupported parameter "+key}).encode());return
            limit=data.get("max_tokens") or data.get("options",{}).get("num_predict")
            exhausted="-retry" in text and limit<3000 or "-always" in text
            self.send_response(200);self.send_header("Content-Type","text/event-stream" if openai else "application/x-ndjson");self.end_headers()
            try:
                for _ in range(0 if "-legacy400" in text else 2000):
                    obj={"choices":[{"delta":{"reasoning_content":"x"}}]} if openai else {"message":{"thinking":"x"},"done":False}
                    self.wfile.write((("data: " if openai else "")+json.dumps(obj)+"\n\n").encode())
                if openai:
                    obj={"choices":[{"delta":{"content":"" if exhausted else '{"answer":"OK","sourceIds":[]}'},"finish_reason":"length" if exhausted else "stop"}]}
                else:
                    obj={"message":{"content":"" if exhausted else '{"answer":"OK","sourceIds":[]}'},"done":True,"done_reason":"length" if exhausted else "stop"}
                self.wfile.write((("data: " if openai else "")+json.dumps(obj)+"\n\n").encode())
            except (BrokenPipeError,ConnectionResetError):pass
            return
        if "overflow-regression" in text:
            openai="format" not in data
            failure=len(text)>2500
            http_error=failure and "-http" in text
            self.send_response(400 if http_error else 200);self.send_header("Content-Type","application/json" if http_error else "text/event-stream" if openai else "application/x-ndjson");self.end_headers()
            if failure:
                obj={"error":{"message":'request (15581 tokens) exceeds the available context size (8192 tokens), n_prompt_tokens:15581, n_ctx:8192'}}
            elif openai:
                obj={"choices":[{"delta":{"content":'{"answer":"OK","sourceIds":[]}'},"finish_reason":"stop"}]}
            else:
                obj={"message":{"content":'{"answer":"OK","sourceIds":[]}'},"done":True}
            prefix="data: " if openai and not http_error else ""
            self.wfile.write((prefix+json.dumps(obj)+"\n\n").encode());return
        if "datasets" in data["format"]["properties"]:
            seed=json.loads(text)
            value={"datasets":["elements"],"scope":seed["scope"],"objectIds":[seed["page"]["objectId"]] if seed["page"]["objectId"] and "всем" not in seed["question"] else [],"startExclusive":seed["startExclusive"],"endInclusive":seed["endInclusive"],"periodLabel":"Выбранный период","needReports":True}
            for marker,group in [("__contracts__","contracts"),("__calc__","calculator"),("__works__","works")]:
                if marker in seed["question"]:value["datasets"]=[group];value["needReports"]=False
            if "Сколько ригелей на первом этаже" in seed["question"] or "__large_rows__" in seed["question"] or "из них смонтировали" in seed["question"]:value["needReports"]=False
            if "__page_scope__" in seed["question"]:value["scope"]="page"
            if "__bad_scope__" in seed["question"]:value["objectIds"]=[999999]
        elif "queries" in data["format"]["properties"]:
            instruction=json.loads(data["messages"][1]["content"])
            question=instruction["question"]
            sql="SELECT SUM(montage_change) AS installed, SUM(delivery_change) AS delivered FROM period_facts"
            for marker,table in [("__contracts__","contract_lines"),("__calc__","calc_products"),("__works__","block_works")]:
                if marker in question:sql=f"SELECT COUNT(*) AS count FROM {table}"
            if "__repair__" in question and len(data["messages"])==2:sql="SELECT missing_column FROM elements"
            if "Сколько ригелей на первом этаже" in question:
                sql="SELECT COUNT(*) AS count FROM elements WHERE is_current=1 AND element_type='Ригель' AND floor=1"
            if "из них смонтировали" in question:
                assert any("ригелей на первом этаже" in m["content"] for m in instruction["history"])
                sql="SELECT COALESCE(SUM(montage_change),0) AS installed FROM element_facts WHERE element_type='Ригель' AND floor=1"
            if "__large_rows__" in question:sql="SELECT id, comment FROM elements ORDER BY id"
            value={"queries":[{"title":"Найденные показатели","sql":sql}] if len(data["messages"])==2 or "__repair__" in question else [],"needsMore":False}
            if "__huge_sql__" in question:
                value["queries"] = [{"title":"Общий монтаж за сентябрь (штатный факт)","sql":"SELECT SUM(montage_change) AS installed FROM period_facts /*"+"x"*5300+"*/"},
                                    {"title":"Монтаж по типам (серверный факт)","sql":"SELECT element_type, SUM(montage_change) AS installed FROM element_facts GROUP BY element_type /*"+"x"*5300+"*/"}]
        else:
            context=json.loads(text.split("Данные сервиса (JSON):\n",1)[1].split("\nВопрос:",1)[0])
            assert all("sql" not in s["data"] for s in context["sources"] if isinstance(s["data"],dict))
            value={"answer":"Проверка: локальный ответ по данным сервиса.","sourceIds":[s["id"] for s in context["sources"][:3]] + [s["id"] for s in context["sources"] if s["scope"]=="search"]}
            if context.get("sourceDiscussion"):
                assert "Общий монтаж за сентябрь" in json.dumps(context,ensure_ascii=False)
                assert all(s["id"].startswith("previous-") for s in context["sources"])
                value["answer"]="Это выборки данных сервиса. Общий итог и разбивка используют один серверный факт; различие методик не установлено."
        if "__unknown_source__" in text:value["sourceIds"]=["invented-source"]
        if "__hold__" in text:
            hold_received.set();hold_release.wait(10)
        self.send_response(200);self.send_header("Content-Type","application/x-ndjson");self.end_headers()
        if "queries" in data["format"]["properties"] and "__planner_thinking_retry__" in text and data["options"]["num_predict"]<=2048:
            for _ in range(2000):self.wfile.write((json.dumps({"message":{"thinking":"x"},"done":False})+"\n").encode())
            self.wfile.write((json.dumps({"message":{"content":""},"done":True,"done_reason":"length"})+"\n").encode());return
        if "__reasoning_hold__" in text:
            self.wfile.write((json.dumps({"message":{"thinking":"x"},"done":False})+"\n").encode());self.wfile.flush();reason_received.set();reason_release.wait(10)
        try:self.wfile.write((json.dumps({"message":{"content":json.dumps(value,ensure_ascii=False)},"done":True})+"\n").encode())
        except (BrokenPipeError,ConnectionResetError):pass
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

from app.assistant_llm import Dialogue
for provider,marker in [("ollama","overflow-regression"),("openai","overflow-regression-sse"),("openai","overflow-regression-http")]:
    cfg=ConnectionConfig(provider=provider,model="test-dialog",baseUrl=f"http://127.0.0.1:{server.server_port}",maxTokens=4096)
    retry_steps=[]
    dialogue=Dialogue(cfg,65536,lambda:False,lambda info:None,lambda *args,**kwargs:retry_steps.append(args))
    retry_messages=[{"role":"user","content":marker+" " + "данные "*1000}]
    def shrink_retry():
        if len(retry_messages[0]["content"])<=100:return False
        retry_messages[0]["content"]=retry_messages[0]["content"][:len(retry_messages[0]["content"])//2]
        return True
    answer=dialogue.call(retry_messages,{"type":"object","properties":{"answer":{"type":"string"},"sourceIds":{"type":"array","items":{"type":"string"}}},"required":["answer","sourceIds"]},"test_retry",shrink_retry)
    check(answer["answer"]=="OK" and retry_steps[0][0]=="compact","ошибка 15581/8192 приводит к успешному повтору: "+marker)
from app.calc import qwen_client
reasoning_schema={"type":"object","properties":{"answer":{"type":"string"},"sourceIds":{"type":"array","items":{"type":"string"}}},"required":["answer","sourceIds"]}
for provider in ("ollama","openai"):
    cfg=ConnectionConfig(provider=provider,model="google/gemma-4-31b-qat",baseUrl=f"http://127.0.0.1:{server.server_port}",maxTokens=4096)
    for marker in ("reasoning-regression", "reasoning-regression-retry", "reasoning-regression-unsupported"):
        info=[];steps=[];start_calls=len(calls)
        dialogue=Dialogue(cfg,8192,lambda:False,info.append,lambda *args,**kwargs:steps.append(args))
        value=dialogue.call([{"role":"user","content":marker}],reasoning_schema,"test_reasoning",lambda:False,max_tokens=2048)
        check(value["answer"]=="OK","Gemma: более 1537 фрагментов и полноценный JSON: "+provider+marker)
        check(any(p["state"]=="reasoning" and p["chars"]==0 for p in info),"поток рассуждения имеет отдельный статус")
        first=calls[start_calls]
        check(first.get("think") is False if provider=="ollama" else first["reasoning_effort"]=="none" and first["chat_template_kwargs"]["enable_thinking"] is False,"параметры отключения для диалоговой Gemma")
        if "-retry" in marker:
            last=calls[-1];output=last.get("max_tokens") or last["options"]["num_predict"]
            check(len(calls)-start_calls==2 and output==4096 and steps[0][0]=="reasoning_retry","один повтор с резервом результата в пределах 8K")
    steps=[];start_calls=len(calls)
    dialogue=Dialogue(cfg,8192,lambda:False,lambda info:None,lambda *args,**kwargs:steps.append(args))
    try:
        dialogue.call([{"role":"user","content":"reasoning-regression-always"}],reasoning_schema,"test_reasoning",lambda:False,max_tokens=2048)
        raise AssertionError("бесконечное рассуждение прошло")
    except qwen_client.InferenceError as error:
        check(len(calls)-start_calls==2 and "Thinking" in str(error),"повтор ограничен и объясняет настройку сервера")
    # Защитный режим существующего чтения чертежей остаётся прежним.
    start_calls=len(calls)
    try:
        qwen_client.chat(cfg.model_copy(update={"maxTokens":2048}),runtime.settings(),[{"role":"user","content":"reasoning-regression"}],reasoning_schema)
        raise AssertionError("старый защитный режим чтения потерян")
    except qwen_client.InferenceTruncated as error:
        check(error.thinking and calls[start_calls].get("think") is None and "reasoning_effort" not in calls[start_calls],"старый клиент чертежей сохраняет защиту и параметры")
legacy_start=len(calls)
legacy_cfg=ConnectionConfig(provider="openai",model="Qwen-test",baseUrl=f"http://127.0.0.1:{server.server_port}",maxTokens=2048)
value=qwen_client.chat(legacy_cfg,runtime.settings(),[{"role":"user","content":"reasoning-regression-legacy400"}],reasoning_schema)
check(value["answer"]=="OK" and len(calls)-legacy_start==2 and "chat_template_kwargs" not in calls[-1],"старый HTTP400 fallback чтения чертежей сохранён")
# Не сокращаем обязательные данные, когда можно уменьшить только резерв генерации.
fixed_messages=[{"role":"user","content":"reasoning-regression "+"d"*8800}]
cfg=ConnectionConfig(provider="ollama",model="test-dialog",baseUrl=f"http://127.0.0.1:{server.server_port}",maxTokens=4096)
fixed_steps=[]
value=Dialogue(cfg,8192,lambda:False,lambda info:None,lambda *args,**kwargs:fixed_steps.append(args)).call(fixed_messages,reasoning_schema,"fixed",lambda:False)
check(value["answer"]=="OK" and 512<=calls[-1]["options"]["num_predict"]<2000 and fixed_steps[0][0]=="compact","обязательные данные помещаются с меньшим резервом ответа")
calls.clear()

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
    result=await_result(admin,r.json()["id"]).json();check(result["state"]=="done","ответ локального HTTP API: "+str(result))
    check({"route","snapshot","plan","query","answer","validate"}.issubset({x["phase"] for x in result["progress"]["steps"]}), "подробные этапы и проверка ответа")
    check(result["elapsedSeconds"]>=0,"длительность обработки")
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
    r=admin.post("/assistant/requests",json={**body,"scope":"auto","question":"Сколько ригелей на первом этаже"})
    beams=await_result(admin,r.json()["id"]).json();check(beams["state"]=="done", "вопрос о ригелях без переполнения")
    beam_source=next(s for s in beams["sources"] if s["scope"]=="search")
    c=get_connection();beam_count=c.execute("SELECT COUNT(*) FROM elements WHERE object_id=? AND is_current=1 AND element_type='Ригель' AND floor=1",(oid,)).fetchone()[0];c.close()
    check(admin.get(beam_source["url"]).json()["rows"]==[{"count":beam_count}],"ригели первого этажа: точный счётчик, проверяемый источник")
    followup_body={**body,"scope":"auto","question":"Сколько из них смонтировали с 20 сентября?","history":[{"role":"user","content":"Сколько ригелей на первом этаже"},{"role":"assistant","content":f"На первом этаже {beam_count} ригелей. Период ответа: 2026-09-28 → 2026-10-05."}]}
    r=admin.post("/assistant/requests",json=followup_body)
    followup=await_result(admin,r.json()["id"]).json();check(followup["state"]=="done" and followup["period"]["from"]=="2026-09-19","продолжение диалога: 20 сентября включается")
    found_source=next(s for s in followup["sources"] if s["scope"]=="search")
    c=get_connection();beam_ids=[r[0] for r in c.execute("SELECT id FROM elements WHERE object_id=? AND is_current=1 AND element_type='Ригель' AND floor=1",(oid,))];expected_beams=build_dynamics_report(c,None,"2026-10-05",beam_ids,oid)["montage"]["cumulative"]["fact"]-build_dynamics_report(c,None,"2026-09-19",beam_ids,oid)["montage"]["cumulative"]["fact"];c.close()
    check(admin.get(found_source["url"]).json()["rows"]==[{"installed":expected_beams}],"монтаж именно обсуждавшихся ригелей совпадает со штатным отчётом")
    r=admin.post("/assistant/requests",json={**followup_body,"question":followup_body["question"]+" __planner_thinking_retry__"})
    planning_retry=await_result(admin,r.json()["id"]).json()
    check(planning_retry["state"]=="done" and any(x["phase"]=="reasoning_retry" for x in planning_retry["progress"]["steps"]),"полный диалог: повтор подготовки SELECT с сохранением истории и схемы в 8K")
    large_body={**body,"scope":"auto","question":"__large_rows__ по всем проектам","page":{"title":"Страница","text":"Контекст страницы. "*500},"history":[{"role":"user","content":"Описание. "*500},{"role":"assistant","content":"Предыдущий ответ. "*300}]}
    r=admin.post("/assistant/requests",json=large_body)
    large=await_result(admin,r.json()["id"]).json();check(large["state"]=="done","большой экран, история и список помещаются в контекст")
    large_source=next(s for s in large["sources"] if s["scope"]=="search")
    check(admin.get(large_source["url"]).json()["returnedRows"]==200,"в источнике сохранены все 200 строк несмотря на сокращение запроса к модели")
    r=admin.post("/assistant/requests",json={**body,"scope":"auto","question":"__huge_sql__ Сколько смонтировали за сентябрь с разбивкой по типам?"})
    huge=await_result(admin,r.json()["id"]).json()
    check(huge["state"]=="done","два SQL по 5300 знаков не переполняют итоговый ответ")
    searched=[s for s in huge["sources"] if s["scope"]=="search"]
    total_source=admin.get(searched[0]["url"]).json()
    breakdown_source=admin.get(searched[1]["url"]).json()
    sent_context=json.loads(calls[-1]["messages"][-1]["content"].split("Данные сервиса (JSON):\n",1)[1].split("\nВопрос:",1)[0])
    sent_breakdown=next(s["data"] for s in sent_context["sources"] if s["id"]==searched[1]["id"])
    check(sent_breakdown["aggregate"] and sent_breakdown["rows"]==breakdown_source["rows"],"агрегированная разбивка передаётся целиком, даже при сокращении контекста")
    check(sum(row["installed"] for row in breakdown_source["rows"])==total_source["rows"][0]["installed"],"общая сумма и разбивка по типам используют один серверный факт")
    from app.assistant import _JOBS
    preserved=_JOBS[huge["id"]]["evidence"][searched[0]["id"]]
    check(len(preserved["sql"])>5300,"исходный SQL сохранён для проверки, сокращено только представление модели")
    final_payload=calls[-1]["messages"][-1]["content"]
    check("x"*100 not in final_payload,"SQL не отправляется в финальное объяснение")
    previous_calls=len(calls)
    r=admin.post("/assistant/requests",json={**body,"question":"какие отчеты показывают разные данные?","previousRequestId":huge["id"],"history":[{"role":"assistant","content":huge["answer"]}]})
    discussion=await_result(admin,r.json()["id"]).json()
    check(discussion["state"]=="done" and len(calls)==previous_calls+1,"вопрос об источниках использует предыдущие выборки без нового поиска")
    check(discussion["capturedAt"]==huge["capturedAt"] and discussion["period"]==huge["period"],"обсуждение сохраняет дату снимка и период предыдущего ответа")
    old_ref=next(s for s in discussion["sources"] if s["scope"]=="search")
    check(admin.get(old_ref["url"]).json()["rows"]==total_source["rows"],"источник продолжения содержит те же числа")
    report_link=next(s for s in discussion["sources"] if s["scope"]!="search")
    check(report_link["url"].count("assistant_request=")==1,"ссылка предыдущего отчёта содержит только текущее задание")
    r=admin.post("/assistant/requests",json={**body,"question":"Откуда эти цифры?","previousRequestId":discussion["id"]})
    discussion_again=await_result(admin,r.json()["id"]).json()
    check(discussion_again["state"]=="done" and all(s["id"].startswith("previous-") and s["id"].count("previous-")==1 for s in discussion_again["sources"]),"повторное обсуждение не наращивает ID и сохраняет источники")
    check(user.post("/assistant/requests",json={**body,"previousRequestId":huge["id"]}).status_code==404,"чужой предыдущий ответ нельзя добавить в контекст")
    r=admin.post("/assistant/requests",json={**body,"previousRequestId":"expired-request"})
    expired=await_result(admin,r.json()["id"]).json()
    check(expired["state"]=="done" and any("Источники предыдущего" in warning for warning in expired["warnings"]),"истёкший предыдущий ответ не ломает новый поиск")
    for payload in calls:
        check(payload["options"]["num_ctx"]<=8192 and sum(len(m["content"]) for m in payload["messages"])/1.4+payload["options"]["num_predict"]+512+len(json.dumps(payload["format"],ensure_ascii=False,separators=(",",":")))/1.4<=8193, "каждый этап соблюдает бюджет включая ответ и схему")
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
    sums=snap.query("SELECT SUM(montage_change) AS installed, SUM(delivery_change) AS delivered FROM element_facts")["rows"][0]
    aggregate=snap.query("SELECT SUM(montage_change) AS installed, SUM(delivery_change) AS delivered FROM period_facts")["rows"][0]
    check(sums==aggregate,"поэлементный факт складывается в тот же общий итог монтажа и поставки")
    by_type=snap.query("SELECT element_type,SUM(montage_change) AS installed FROM element_facts GROUP BY element_type")["rows"]
    check(sum(row["installed"] for row in by_type)==aggregate["installed"],"разбивка включает все типы, в том числе пустой")
    check(snap.query("SELECT COUNT(*) AS n FROM element_facts WHERE montage_day IS NULL AND montage_change<>0")["rows"][0]["n"]==0,"недатированные факты не создают прирост")
    total=snap.query("SELECT COUNT(*) AS n FROM elements")["rows"][0]["n"]
    limited=snap.query("SELECT id FROM elements ORDER BY id")
    check(snap.query("SELECT element_type,SUM(montage_change) FROM element_facts GROUP BY element_type")["aggregate"] and not limited["aggregate"],"EXPLAIN отличает агрегат от детального списка")
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
    check(calls[-1]["options"]["num_ctx"]==8192,"безопасный контекст передан Ollama")
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
    waiting=admin.get("/assistant/requests/"+r.json()["id"]).json()
    check(waiting["state"]=="running" and waiting["progress"]["phase"]=="route" and waiting["progress"]["modelState"]=="connecting","статус ожидания модели доступен во время обработки")
    check(admin.post("/assistant/requests",json=body).status_code==409,"два запроса одного пользователя не запускаются")
    check(admin.post("/assistant/requests/"+r.json()["id"]+"/cancel",json={}).status_code==200,"отмена принята")
    hold_release.set()
    check(await_result(admin,r.json()["id"]).json()["state"]=="cancelled","отменённый ответ не выдаётся")
    r=admin.post("/assistant/requests",json={**body,"question":"__reasoning_hold__"})
    check(reason_received.wait(5),"поток рассуждения дошёл до модели")
    for _ in range(100):
        live=admin.get("/assistant/requests/"+r.json()["id"]).json()
        if live["progress"].get("modelState")=="reasoning":break
        time.sleep(.02)
    check(live["state"]=="running" and live["progress"]["modelState"]=="reasoning" and live["progress"]["reasoningChars"]==1 and live["progress"]["chars"]==0,"API показывает ожидание результата при рассуждении, без его текста")
    admin.post("/assistant/requests/"+r.json()["id"]+"/cancel",json={});reason_release.set()
    check(await_result(admin,r.json()["id"]).json()["state"]=="cancelled","рассуждающая модель прерывается пользователем")
    # Смена прав между вопросом и чтением ответа не должна раскрывать старый контекст.
    c=get_connection();c.execute("UPDATE users SET role='view' WHERE domain_login='admin'");c.execute("DELETE FROM user_access WHERE user_id=?",(adminrow["id"],));c.commit();c.close()
    check(admin.get("/assistant/requests/"+probe.json()["id"]).status_code==200,"тест без данных доступен владельцу")
    check(admin.get("/assistant/requests/"+next(j["id"] for j in __import__('app.assistant',fromlist=['_JOBS'])._JOBS.values() if j.get('sources'))).status_code==403,"права перепроверяются при чтении ответа")
    check(admin.get(path).status_code==403,"доступ к параметрам ссылки перепроверяется")
    check(admin.post("/assistant/requests",json={**body,"previousRequestId":huge["id"]}).status_code==403,"отозванные права проверяются перед обсуждением старых источников")
    user.close()
server.shutdown();server.server_close()
print(f"OK: {checks} проверок; временная копия удалена")
import shutil
shutil.rmtree(work)

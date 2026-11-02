"""Изолированная HTTP-проверка контура СМР. Только собственная синтетическая БД.

.venv312/bin/python scripts/verify_contracting_plan.py
Не читает существующие базы, env и секреты; не требует внешних библиотек тестирования.
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
work = Path(tempfile.mkdtemp(prefix="cp-verify-"))
os.environ["ZHBI_DB_PATH"] = str(work / "synthetic.db")
from app import db  # noqa: E402
from app.auth import get_current_user  # noqa: E402
from app.contracting_plan import router  # noqa: E402
from app import db_schema_doc  # noqa: E402
from fastapi import FastAPI  # noqa: E402
import uvicorn  # noqa: E402

db.init_db()
c = db.get_connection()
oid = c.execute("INSERT INTO objects(name) VALUES ('Синтетический объект СМР')").lastrowid
other = c.execute("INSERT INTO objects(name) VALUES ('Другой синтетический объект')").lastrowid
admin = c.execute("SELECT * FROM users WHERE domain_login='admin'").fetchone()
uid = c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Наблюдатель','cp-view','view')").lastrowid
c.execute("INSERT INTO user_access(user_id,object_id,role) VALUES (?,?,'view')", (uid, oid))
c.execute("INSERT INTO role_features(role_key,feature_key,level) VALUES ('view','contracting_plan','read')")
viewer = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
problems = [p for p in db_schema_doc.verify(c) if 'cp_' in p]
assert not problems, problems
assert not c.execute("PRAGMA foreign_key_check").fetchall()
c.commit(); c.close()
app = FastAPI(); app.include_router(router)
current = [admin]
app.dependency_overrides[get_current_user] = lambda: current[0]
sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port=sock.getsockname()[1]
server = uvicorn.Server(uvicorn.Config(app,log_level="error"))
thread=threading.Thread(target=server.run,kwargs={"sockets":[sock]},daemon=True);thread.start()
while not server.started: time.sleep(.02)
base=f"http://127.0.0.1:{port}/objects/{oid}/contracting-plan"
checks=[]
def check(label, ok):
    checks.append(ok); print(("PASS " if ok else "FAIL ")+label)
    if not ok: raise AssertionError(label)
def call(method,path,payload=None):
    req=Request(path,data=None if payload is None else json.dumps(payload).encode(),method=method,headers={"Content-Type":"application/json"})
    try:
        with urlopen(req) as r:return r.status,json.load(r)
    except HTTPError as e:return e.code,json.load(e)
status,data=call("GET",base)
check("пустой график / схема / FK",status==200 and data["revision"]==0)
def cmd(action,payload,expected=200,revision=None):
    global data
    old=data
    status,result=call("POST",base+"/commands",{"expected_revision":data["revision"] if revision is None else revision,"action":action,"payload":payload})
    check(action+f" → {expected}",status==expected)
    if expected==200:
        check("одна ревизия на успешную операцию",result["revision"]==old["revision"]+1)
        data=result
    else:
        _,fresh=call("GET",base)
        check("отказ не меняет ревизию и историю",fresh["revision"]==old["revision"] and len(fresh["history"])==len(old["history"]))
    return result

def latest(kind):return data[kind][-1]["id"]
try:
    cmd("delete_work",{"id":0},400)
    cmd("archive",{"id":0},400)
    cmd("save_rd",{"code":"РД-1","name":"Конструкции","responsible_id":admin["id"]}); rd=latest("rd")
    cmd("save_rd",{"code":"РД-1","name":"Дубль"},409)
    cmd("save_work",{"rd_id":rd,"title":"Монтаж","required_start":"2026-12-20"}); w1=latest("work")
    cmd("save_work",{"rd_id":rd,"title":"Отделка","required_start":"2026-12-25"}); w2=latest("work")
    cmd("save_rd",{"id":rd,"code":"РД-1","name":"Конструкции","responsible_id":admin["id"],"composition_confirmed":True})
    lot_payload={"code":"Л-1","title":"Корпус 1","pto_id":admin["id"],"required_start":"2026-12-20","vor_due":"2026-01-01"}
    cmd("save_lot",lot_payload); l1=latest("lot")
    cmd("save_lot",{**lot_payload,"code":"Л-2","title":"Корпус 2"});l2=latest("lot")
    cmd("upload",{"id":l1,"tz_id":1,"uploaded_date":"2026-01-03","upload_ref":"Синтетическая запись"},409)
    common={"scope":"Корпус 1","rd_planned":"2026-01-01","rd_agreed":"2026-01-02","rd_issued":"2026-01-03","rd_sufficient":True,"rd_scope":"РД по корпусу 1, только конкурс","rd_ref":"https://example.invalid/rd"}
    cmd("save_assignment",{**common,"lot_id":l1,"work_id":w1,"share":60});a1=latest("assignment")
    cmd("save_assignment",{**common,"lot_id":l2,"work_id":w1,"share":50},400)
    cmd("save_assignment",{**common,"lot_id":l2,"work_id":w1,"share":40,"scope":"Корпус 2"});a2=latest("assignment")
    cmd("save_assignment",{**common,"lot_id":l1,"work_id":w2,"share":100});a3=latest("assignment")
    check("M:N и полное распределение",all(w["allocated_share"]==100 for w in data["work"]))
    check("заданные сроки дают просрочку",data["lot"][0]["overdue"])
    doc={"lot_id":l1,"kind":"vor","number":"ВОР-1","document_date":"2026-01-04","reference":"https://example.invalid/vor","item_ids":[w1]}
    cmd("save_document",doc);v1=latest("document")
    cmd("save_assignment",{**common,"id":a1,"lot_id":l1,"work_id":w1,"share":60,"scope":"Другой корпус"},409)
    cmd("save_work",{"id":w1,"rd_id":rd,"title":"Другая работа","required_start":"2026-12-20"},409)
    cmd("save_document",{**doc,"number":"ВОР-2","item_ids":[w2]});v2=latest("document")
    cmd("save_document",{**doc,"lot_id":l2,"number":"Чужая ВОР","item_ids":[w2]},400)
    cmd("save_document",{**doc,"kind":"tz","number":"ТЗ-1","document_date":"2026-01-05","item_ids":[v1]});tz=latest("document")
    cmd("upload",{"id":l1,"tz_id":tz,"uploaded_date":"2026-01-06","upload_ref":"1С: запись"},409)
    cmd("save_document",{**doc,"id":tz,"kind":"tz","number":"ТЗ-1","document_date":"2026-01-05","item_ids":[v1,v2]})
    cmd("upload",{"id":l1,"tz_id":tz,"uploaded_date":"2099-01-01","upload_ref":"1С: запись"},400)
    cmd("upload",{"id":l1,"tz_id":tz,"uploaded_date":"2026-01-06","upload_ref":"   "},400)
    cmd("upload",{"id":l1,"tz_id":tz,"uploaded_date":"2026-01-06","upload_ref":"1С: синтетическая запись"})
    check("завершение фиксирует состав",data["lot"][0]["status"]=="completed" and bool(data["lot"][0]["completion_json"]))
    cmd("save_lot",{**lot_payload,"id":l1},409)
    cmd("delete_document",{"id":v1},409)
    cmd("save_work",{"rd_id":rd,"title":"Новая независимая работа","required_start":"2027-01-01"}); w3=latest("work")
    check("развитие РД не портит завершённый лот",data["lot"][0]["status"]=="completed" and not data["lot"][0]["blockers"] and not data["rd"][0]["composition_confirmed"])
    cmd("save_rd",{"id":rd,"code":"РД-1","name":"Конструкции","responsible_id":admin["id"],"composition_confirmed":True})
    cmd("archive",{"id":l1,"reason":"Завершённый исторический лот"})
    check("архив завершенного сохраняет занятые доли",data["work"][0]["allocated_share"]==100)
    cmd("save_assignment",{**common,"lot_id":l2,"work_id":w2,"share":100},400)
    cmd("restore",{"id":l1})
    cmd("reopen",{"id":l1},400)
    cmd("reopen",{"id":l1,"reason":"Уточнение документов"})
    check("история снятого факта содержит снимок",any('completion_json' in h["before_json"] for h in data["history"] if h["action"]=="reopen"))
    cmd("save_lot",{**lot_payload,"id":l1},revision=0,expected=409)
    cmd("archive",{"id":l2,"reason":"Смена границ"})
    check("архив незавершенного освобождает долю",data["work"][0]["allocated_share"]==60)
    current[0]=viewer
    status,read=call("GET",base);check("read-only видит график",status==200 and not read["can_write"])
    cmd("save_lot",{"code":"Нельзя","title":"Нельзя"},403)
    status,_=call("GET",f"http://127.0.0.1:{port}/objects/{other}/contracting-plan");check("изоляция другого объекта",status==403)
    current[0]=admin
    cmd("delete_work",{"id":999999},404)
    status,page=call("GET",base+"/history?before_id="+str(data["history"][0]["id"]))
    check("более ранняя страница истории",status==200 and page and all(h["id"]<data["history"][0]["id"] for h in page))
    c=db.get_connection()
    from app.dict_delete import build_plan
    plan=build_plan(c,"object",str(oid))
    check("история СМР явно держит удаление объекта","История графика" in json.dumps(plan,ensure_ascii=False))
    check("новые FK учтены в удалении",not any(x.get("handled")=="НЕ УЧТЕНО" and x["label"].startswith("cp_") for x in plan.get("tree",plan).get("checked",[])))
    check("конечная ссылочная целостность",not c.execute("PRAGMA foreign_key_check").fetchall());c.close()
    print(f"SUCCESS: {len(checks)} проверок; только синтетика {work}")
finally:
    server.should_exit=True;thread.join(5)

import os
import sqlite3, hashlib, json, sys
DB=os.environ.get("V2_EX_DB") or (os.environ.get("V2_EX_WORK","/tmp/v2_exchange")+"/exchange_work/work.db")
TABLES=["counterparties","agreements","specifications","contracts","contract_lines","elements","status_history","objects","projects","smu","individuals",
        "schedule_versions","mark_type_prefixes","status_colors","label_visibility","users","object_drawings"]
def snap(tables=TABLES, where=None):
    c=sqlite3.connect("file:"+DB+"?mode=ro",uri=True); c.row_factory=sqlite3.Row
    out={}
    for t in tables:
        try:
            rows=[tuple(r) for r in c.execute(f"SELECT * FROM {t} ORDER BY 1")]
        except Exception as e:
            continue
        h=hashlib.md5(repr(rows).encode()).hexdigest()[:12]
        out[t]=(len(rows),h)
    return out
def journal(action=None, since=None):
    c=sqlite3.connect("file:"+DB+"?mode=ro",uri=True); c.row_factory=sqlite3.Row
    q="SELECT id, at, action, entity_type, entity_id, new_value FROM activity_log"
    ps=[]; w=[]
    if action: w.append("action=?"); ps.append(action)
    if since: w.append("id>?"); ps.append(since)
    if w: q+=" WHERE "+" AND ".join(w)
    return [dict(r) for r in c.execute(q+" ORDER BY id DESC LIMIT 20", ps)]
def maxid():
    c=sqlite3.connect("file:"+DB+"?mode=ro",uri=True)
    return c.execute("select coalesce(max(id),0) from activity_log").fetchone()[0]
def diff(a,b):
    return {t:(a.get(t),b.get(t)) for t in b if a.get(t)!=b.get(t)}
if __name__=="__main__":
    print(json.dumps(snap(),ensure_ascii=False))

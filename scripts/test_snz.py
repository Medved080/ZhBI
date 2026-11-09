"""СНЗ: расчёт, конкуренция, неизменяемая выдача, факт и нативные экспорты.

Only a disposable synthetic database is used. No application database is read.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TMP = Path(tempfile.mkdtemp(prefix="snz_verify_"))
os.environ["ZHBI_DB_PATH"] = str(TMP / "synthetic.db")
from app.snz_core import build_schedule, default_state, previous_shift, work_windows, suggest_card


def element(eid, kind="Ригель", floor=1):
    x, y = (eid % 4) * 6000, (eid // 4) * 6000
    return {"id": eid, "element_uid": f"snz-{eid}", "mark": f"Р-{eid}", "element_type": kind, "subtype": "+15.000",
            "floor": floor, "elevation_mm": 15000, "address": f"{eid}/А-Б", "axis_number": str(eid), "axis_letter": "А-Б",
            "x": x, "y": y, "outline_json": json.dumps([[x,y],[x+4500,y],[x+4500,y+400],[x,y+400]]),
            "source_file": "СНЗ-проверка.dxf", "current_status": "ready_for_installation", "planned_installation_date": None,
            "zakhvatka": "Захватка 1", "crane": "Кран 1", "stance": "Стоянка 1", "counterparty": "Тестовый поставщик"}


def fixture(ids=(1,), steps=(("install", 60, 0),), day="2026-11-10", shift="day"):
    state = default_state()
    state["cards"][0]["steps"] = [{"operation_id": op, "minutes": minutes, "wait_after": wait} for op, minutes, wait in steps]
    state["assignments"] = [{"element_id": eid, "crew_id": "install1", "card_id": "base", "date": day, "shift": shift,
                              "priority": i + 1, "prep_priority": len(ids) - i} for i, eid in enumerate(ids)]
    return state, [element(eid) for eid in ids]


def schedule(state, elements, history=(), day="2026-11-10", shift="day", crew="install1"):
    result = build_schedule(state, elements, list(history), day, shift, crew)
    result["object_name"] = "Проверка СНЗ"
    return result


class SchedulerTests(unittest.TestCase):
    def test_card_mapping_axes_elevation_alias_and_ambiguity(self):
        s,es=fixture()
        c=deepcopy(s["cards"][0]);c.update(id="nine",element_type="Ригель",subtype="+15.800",elevation_mm=15800,axis_direction="letter")
        s["cards"].append(c)
        self.assertEqual(suggest_card(s,es[0]),"nine")
        twin=deepcopy(c);twin["id"]="ambiguous";s["cards"].append(twin)
        self.assertIsNone(suggest_card(s,es[0]))

    def test_windows_and_night_date(self):
        self.assertEqual(previous_shift("2026-11-10", "day"), ("2026-11-09", "night"))
        self.assertEqual(previous_shift("2026-11-10", "night"), ("2026-11-10", "day"))
        w = work_windows("2026-11-10", "night")
        self.assertEqual(w[1][0].isoformat(), "2026-11-11T01:00:00")
        self.assertEqual(sum(int((b-a).total_seconds()/60) for a,b in w), 620)

    def test_lunch_split_and_carry_40(self):
        s, es = fixture((1, 2), (("install", 600, 0),))
        s["cards"].append({"id":"short", "name":"60 минут", "element_type":"", "subtype":"", "steps":[{"operation_id":"install","minutes":60,"wait_after":0}]})
        s["assignments"][1]["card_id"] = "short"
        first = schedule(s, es)
        long, short = first["tasks"]
        self.assertEqual([(x["start"][11:],x["end"][11:]) for x in long["segments"]], [("08:20","13:00"),("14:00","19:20")])
        self.assertEqual(short["remaining_after"], 40)
        s["facts"][long["key"]] = {"completed":True,"completed_at":"2026-11-10T19:20"}
        next_order = schedule(s, es, [first], day="2026-11-10", shift="night")
        self.assertEqual(next_order["tasks"][0]["remaining_before"],40)
        self.assertEqual(next_order["tasks"][0]["segments"][0]["end"],"2026-11-10T21:00")

    def test_professions_work_in_parallel(self):
        s, es = fixture((1,2), (("install",60,0),("rebar1",120,0)))
        next(o for o in s["operations"] if o["id"]=="rebar1")["scope"]="element"
        result=schedule(s,es)
        install2=next(t for t in result["tasks"] if t["key"]=="e:2:install")
        rebar1=next(t for t in result["tasks"] if t["key"]=="e:1:rebar1")
        self.assertEqual(install2["segments"][0]["start"],rebar1["segments"][0]["start"])
        self.assertEqual(install2["segments"][0]["start"],"2026-11-10T09:20")
        for team in {t["team_id"] for t in result["tasks"]}:
            segments=sorted((x["start"],x["end"]) for t in result["tasks"] if t["team_id"]==team for x in t["segments"])
            self.assertTrue(all(a[1]<=b[0] for a,b in zip(segments,segments[1:])))

    def test_shared_group_barrier_three_and_four(self):
        for count in (3,4):
            with self.subTest(count=count):
                s,es=fixture(tuple(range(1,count+1)), (("install",30,0),("rebar1",40,0),("concrete1",20,0),("rebar2",30,0),("concrete2",20,0)))
                s["groups"]=[{"id":"cross","name":"Крест","element_ids":list(range(1,count+1))}]
                r=schedule(s,es)
                self.assertEqual(len(r["tasks"]),count+4)
                group=next(t for t in r["tasks"] if t["operation_id"]=="rebar1")
                end=max(t["segments"][-1]["end"] for t in r["tasks"] if t["operation_id"]=="install")
                self.assertGreaterEqual(group["segments"][0]["start"],end)
                self.assertEqual(len(group["element_ids"]),count)

    def test_mixed_beam_cards_require_explicit_group_norm(self):
        s,es=fixture((1,2,3),(("install",30,0),("rebar1",40,0)))
        other=deepcopy(s["cards"][0]);other["id"]="other";other["steps"][1]["minutes"]=75;s["cards"].append(other)
        s["assignments"][1]["card_id"]="other"
        s["groups"]=[{"id":"cross","name":"Крайний узел","element_ids":[1,2,3]}]
        self.assertEqual(len(schedule(s,es)["tasks"]),3)
        s["groups"][0]["card_id"]="base"
        group=next(t for t in schedule(s,es)["tasks"] if t["group_id"])
        self.assertEqual(group["norm_minutes"],40)

    def test_missing_group_and_norm_block_dependents(self):
        s,es=fixture((1,),(("install",30,0),("rebar1",40,0),("concrete1",20,0)))
        r=schedule(s,es)
        self.assertEqual([t["operation_id"] for t in r["tasks"]],["install"])
        s["cards"][0]["steps"][0]["minutes"]=None
        self.assertFalse(schedule(s,es)["tasks"])

    def test_technological_wait_runs_during_lunch(self):
        s,es=fixture((1,),(("install",250,120),("scaffold",10,0)))
        r=schedule(s,es)
        # End 12:30 + 120 calendar minutes = 14:30, not 15:30.
        self.assertEqual(r["tasks"][1]["segments"][0]["start"],"2026-11-10T14:30")

    def test_preparation_previous_shift_and_separate_order(self):
        s,es=fixture((1,2),(("prepare",30,0),("install",60,0)))
        r=schedule(s,es,day="2026-11-09",shift="night",crew="preparation")
        self.assertEqual([t["element_ids"] for t in r["tasks"]],[[2],[1]])
        self.assertEqual({t["operation_id"] for t in r["tasks"]},{"prepare"})

    def test_issued_norm_frozen_and_unfinished_full_cycle_repeats(self):
        s,es=fixture((1,),(("install",60,0),))
        first=schedule(s,es)
        s["cards"][0]["steps"][0]["minutes"]=10
        second=schedule(s,es,[first],day="2026-11-10",shift="night")
        self.assertEqual(second["tasks"][0]["norm_minutes"],60)
        self.assertEqual(second["tasks"][0]["remaining_before"],60)

    def test_completed_dependency_wait_across_midnight(self):
        s,es=fixture((1,),(("install",60,120),("scaffold",10,0)))
        s["facts"]["e:1:install"]={"completed":True,"completed_at":"2026-11-10T23:30"}
        r=schedule(s,es,shift="night")
        self.assertEqual(r["tasks"][0]["segments"][0]["start"],"2026-11-11T01:30")


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app import db
        cls.db=db
        db.init_db()
        c=db.get_connection()
        cls.object_id=c.execute("INSERT INTO objects(name) VALUES ('Проверка СНЗ')").lastrowid
        cls.other_id=c.execute("INSERT INTO objects(name) VALUES ('Другой объект СНЗ')").lastrowid
        cls.admin=c.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
        cls.ids=[]
        for n in range(1,5):
            e=element(n)
            eid=c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) "
                          "VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,'ready_for_installation')",
                          (e["source_file"],str(n),"snz",e["element_type"],e["mark"],e["x"],e["y"],cls.object_id,e["floor"],e["outline_json"])).lastrowid
            cls.ids.append(eid)
        c.commit();c.close()
        from app import snz
        cls.snz=snz

    def setUp(self):
        c=self.db.get_connection();c.execute("DELETE FROM snz_orders");c.execute("DELETE FROM snz_state");c.execute("UPDATE elements SET current_status='ready_for_installation',planned_installation_date=NULL WHERE object_id=?",(self.object_id,));c.commit();c.close()

    def save_fixture(self, grouped=False):
        s,_=fixture(tuple(self.ids),(("install",20,0),("rebar1",30,0)) if grouped else (("install",20,0),))
        if grouped:s["groups"]=[{"id":"cross","name":"Крест","element_ids":self.ids}]
        body=self.snz.StateIn(revision=0,**{k:v for k,v in s.items() if k!="facts"})
        self.snz.save_state(self.object_id,body,self.admin)
        return s

    def issue(self, revision=1, request_id="first"):
        current=self.snz.get_state(self.object_id,self.admin)["revision"]
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=current,date="2026-11-10",shift="day",crew_id="install1"),self.admin)
        return self.snz.issue(self.object_id,self.snz.IssueIn(revision=revision,date="2026-11-10",shift="day",crew_id="install1",request_id=request_id,expected_hash=plan["fingerprint"]),self.admin)

    def test_save_sync_conflict_and_schema(self):
        from fastapi import HTTPException
        from app.db_schema_doc import verify
        s=self.save_fixture()
        self.assertEqual(self.snz.get_state(self.object_id,self.admin)["revision"],1)
        c=self.db.get_connection()
        self.assertTrue(all(r[0]=="2026-11-10" for r in c.execute("SELECT planned_installation_date FROM elements WHERE object_id=?",(self.object_id,))))
        self.assertFalse([p for p in verify(c) if "snz_" in p]);c.close()
        with self.assertRaises(HTTPException) as e:
            self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in s.items() if k!="facts"}),self.admin)
        self.assertEqual(e.exception.status_code,409)

    def test_catalog_seed_marker_is_server_owned_and_notes_survive(self):
        from app.snz_catalogs import SEED_VERSION
        self.save_fixture()
        data=self.snz.get_state(self.object_id,self.admin)
        state=data["state"]
        state["catalog_seed"]=""
        card=next(c for c in state["cards"] if c["id"]=="ok_beam_12_25800")
        card["steps"][3]["minutes"]=57
        note=card["steps"][3]["source_note"]
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=data["revision"],**{k:v for k,v in state.items() if k!="facts"}),self.admin)
        saved=self.snz.get_state(self.object_id,self.admin)["state"]
        self.assertEqual(saved["catalog_seed"],SEED_VERSION)
        step=next(c for c in saved["cards"] if c["id"]==card["id"])["steps"][3]
        self.assertEqual((step["minutes"],step["source_note"]),(57,note))

    def test_issue_retry_scope_immutable_and_exports(self):
        from fastapi import HTTPException
        from openpyxl import load_workbook
        self.save_fixture(grouped=True)
        issued=self.issue()
        self.assertEqual(self.issue()["id"],issued["id"])
        with self.assertRaises(HTTPException) as e:self.issue(revision=2,request_id="another")
        self.assertEqual(e.exception.status_code,409)
        with self.assertRaises(HTTPException) as e:self.snz.read_order(self.other_id,issued["id"],self.admin)
        self.assertEqual(e.exception.status_code,404)
        original=self.snz.read_order(self.object_id,issued["id"],self.admin)
        d=self.snz.get_state(self.object_id,self.admin)
        d["state"]["cards"][0]["steps"][0]["minutes"]=99
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=d["revision"],**{k:v for k,v in d["state"].items() if k!="facts"}),self.admin)
        self.assertEqual(self.snz.read_order(self.object_id,issued["id"],self.admin)["tasks"],original["tasks"])
        out=ROOT/"outputs"/"snz-verification";out.mkdir(parents=True,exist_ok=True)
        xlsx=self.snz.export_xlsx(self.object_id,issued["id"],self.admin).body
        (out/"СНЗ.xlsx").write_bytes(xlsx)
        wb=load_workbook(BytesIO(xlsx))
        self.assertEqual(wb["СНЗ"]["L4"].value,20)
        self.assertEqual(len(wb["Изделия"].tables),1)
        gate=Path("/Users/max/.codex/scripts/validate_xlsx.py")
        self.assertTrue(gate.exists(),"Required native XLSX package gate is unavailable")
        subprocess.run([sys.executable,str(gate),str((out/"СНЗ.xlsx").resolve())],check=True,capture_output=True)
        pdf=self.snz.export_pdf(self.object_id,issued["id"],self.admin).body
        self.assertTrue(pdf.startswith(b"%PDF"));(out/"СНЗ.pdf").write_bytes(pdf)

    def test_binary_fact_and_all_operations_install_group(self):
        self.save_fixture(grouped=True)
        oid=self.issue()["id"]
        order=self.snz.read_order(self.object_id,oid,self.admin)
        rev=2
        for i,task in enumerate(order["tasks"]):
            result=self.snz.complete(self.object_id,self.snz.FactIn(revision=rev,task_key=task["key"]),self.admin)
            rev=result["revision"]
            if i<len(order["tasks"])-1:self.assertFalse(result["installed"])
        self.assertEqual(set(result["installed"]),set(self.ids))
        retry=self.snz.complete(self.object_id,self.snz.FactIn(revision=0,task_key=order["tasks"][-1]["key"]),self.admin)
        self.assertTrue(retry["already_completed"])
        c=self.db.get_connection();self.assertEqual(c.execute("SELECT COUNT(*) FROM elements WHERE object_id=? AND current_status='installed'",(self.object_id,)).fetchone()[0],4);c.close()

    def test_cross_object_and_read_only_rejected(self):
        from fastapi import HTTPException
        s=self.save_fixture()
        s["assignments"][0]["element_id"]=99999999
        with self.assertRaises(HTTPException) as e:self.snz.save_state(self.object_id,self.snz.StateIn(revision=1,**{k:v for k,v in s.items() if k!="facts"}),self.admin)
        self.assertEqual(e.exception.status_code,422)
        c=self.db.get_connection();uid=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Наблюдатель','snz-view','view')").lastrowid;c.commit();viewer=c.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone();c.close()
        with self.assertRaises(HTTPException) as e:self.snz.get_state(self.object_id,viewer)
        self.assertEqual(e.exception.status_code,403)

    def test_model_change_after_preview_rejected(self):
        from fastapi import HTTPException
        self.save_fixture()
        params={"revision":1,"date":"2026-11-10","shift":"day","crew_id":"install1"}
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        c=self.db.get_connection();c.execute("UPDATE elements SET mark='Изменено после расчёта' WHERE id=?",(self.ids[0],));c.commit();c.close()
        with self.assertRaises(HTTPException) as e:
            self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id="stale-model",expected_hash=plan["fingerprint"]),self.admin)
        self.assertEqual(e.exception.status_code,409)

    def test_concurrent_writers_and_issuers(self):
        from concurrent.futures import ThreadPoolExecutor
        from fastapi import HTTPException
        s=self.save_fixture()
        body=self.snz.StateIn(revision=1,**{k:v for k,v in s.items() if k!="facts"})
        def write(_):
            try:return self.snz.save_state(self.object_id,body,self.admin)["revision"]
            except HTTPException as e:return e.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sorted(pool.map(write,range(2))),[2,409])
        params={"revision":2,"date":"2026-11-10","shift":"day","crew_id":"install1"}
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        body=self.snz.IssueIn(**params,request_id="same-request",expected_hash=plan["fingerprint"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            result=list(pool.map(lambda _:self.snz.issue(self.object_id,body,self.admin),range(2)))
        self.assertEqual(result[0]["id"],result[1]["id"])


if __name__=="__main__":
    unittest.main(verbosity=2)

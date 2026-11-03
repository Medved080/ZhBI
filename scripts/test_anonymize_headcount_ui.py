"""Privacy regressions: only a new synthetic database; no user DB/map/files."""
import ast
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db
from scripts.anonymize_db import Mapping, _ENUM_VALUES, anonymize, find_leaks


class AnonymizeHeadcountUiTest(unittest.TestCase):
    def test_raw_contractors_and_codifier_scrubbed_and_ui_cache_reset(self):
        with tempfile.TemporaryDirectory(prefix="anon-regression-") as work:
            previous_path = db.DB_PATH
            conn = None
            try:
                db.DB_PATH = Path(work) / "synthetic.db"
                db.init_db()
                conn = db.get_connection()
                oid = conn.execute("INSERT INTO objects(name) VALUES ('Synthetic building')").lastrowid
                uid = conn.execute("SELECT id FROM users WHERE domain_login='admin'").fetchone()[0]
                conn.execute("UPDATE users SET position='PRIVATE-POSITION-ALPHA' WHERE id=?", (uid,))
                cp = conn.execute("INSERT INTO counterparties(full_name,short_name,inn) VALUES ('PRIVATE-CONTRACTOR-ALPHA','PRIVATE-SHORT-ALPHA','9900123456')").lastrowid
                agr = conn.execute("INSERT INTO agreements(counterparty_id,number) VALUES (?,'PRIVATE-AGR-ALPHA')", (cp,)).lastrowid
                spec = conn.execute("INSERT INTO specifications(agreement_id,number) VALUES (?,'PRIVATE-SPEC-ALPHA')", (agr,)).lastrowid
                conn.execute("INSERT INTO contracts(specification_id,theme) VALUES (?,'PRIVATE-THEME-ALPHA')", (spec,))
                contractor = conn.execute("INSERT INTO headcount_contractors(object_id,counterparty_id,name_raw,inn_raw) VALUES (?,?,'PRIVATE-CONTRACTOR-ALPHA','9900123456')", (oid,cp)).lastrowid
                conn.execute("INSERT INTO headcount_contractors(object_id,name_raw) VALUES (?,'PRIVATE-UNLINKED-ALPHA')", (oid,))
                conn.execute("INSERT INTO headcount_contractors(object_id,inn_raw) VALUES (?,'9900123457')", (oid,))
                codifier = conn.execute("INSERT INTO work_codifier(code,name,parent_name,section_name,unit,sort_order,created_at) VALUES ('SYNTH-1','Монтаж PRIVATE-POSITION-ALPHA PRIVATE-SPEC-ALPHA','Группа PRIVATE-SPEC-ALPHA','PRIVATE-POSITION-ALPHA','м3',7,'2026-11-01 00:00:00')").lastrowid
                conn.execute("INSERT INTO headcount_contractor_works(contractor_id,codifier_id) VALUES (?,?)", (contractor,codifier))
                record = conn.execute("INSERT INTO headcount_records(object_id,work_date,contractor_id,codifier_id,workers,itr,mech,source) VALUES (?,'2026-11-02',?,?,3,2,1,'import')", (oid,contractor,codifier)).lastrowid
                conn.execute("INSERT INTO headcount_history(record_id,object_id,work_date,contractor_id,codifier_id,new_workers,source) VALUES (?,?,'2026-11-02',?,?,3,'import')", (record,oid,contractor,codifier))
                ui = {"filter":{"theme":"PRIVATE-THEME-ALPHA","date":"2026-11-03","enabled":True,"ids":[contractor,codifier]},"expanded":False}
                conn.execute("INSERT INTO user_ui_state(user_id,scope,data) VALUES (?,'synthetic-form',?)", (uid,json.dumps(ui)))
                codifier_shape = tuple(conn.execute("SELECT id,code,unit,sort_order,created_at,updated_at,retired_at FROM work_codifier WHERE id=?", (codifier,)).fetchone())
                records = [tuple(r) for r in conn.execute("SELECT * FROM headcount_records")]
                history = [tuple(r) for r in conn.execute("SELECT * FROM headcount_history")]
                links = [tuple(r) for r in conn.execute("SELECT id,object_id,counterparty_id,is_archived FROM headcount_contractors")]
                conn.commit()
                mapping = Mapping()
                anonymize(conn,mapping)
                self.assertEqual(find_leaks(conn,mapping.needles()), [])
                self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(tuple(conn.execute("SELECT id,code,unit,sort_order,created_at,updated_at,retired_at FROM work_codifier WHERE id=?", (codifier,)).fetchone()),codifier_shape)
                self.assertEqual([tuple(r) for r in conn.execute("SELECT * FROM headcount_records")],records)
                self.assertEqual([tuple(r) for r in conn.execute("SELECT * FROM headcount_history")],history)
                self.assertEqual([tuple(r) for r in conn.execute("SELECT id,object_id,counterparty_id,is_archived FROM headcount_contractors")],links)
                text = " ".join(str(tuple(r)) for r in conn.execute("SELECT name_raw,inn_raw FROM headcount_contractors"))
                self.assertNotIn("PRIVATE-",text)
                self.assertNotIn("990012345",text)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM headcount_contractors WHERE name_raw IS NULL").fetchone()[0],1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM headcount_contractors WHERE inn_raw IS NULL").fetchone()[0],1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM user_ui_state").fetchone()[0],0)
                clean_work = conn.execute("SELECT name,parent_name,section_name FROM work_codifier").fetchone()
                self.assertTrue(clean_work["name"].startswith("Монтаж "))
                self.assertTrue(clean_work["parent_name"].startswith("Группа "))
                self.assertNotIn("PRIVATE-"," ".join(clean_work))
            finally:
                if conn is not None:
                    conn.close()
                db.DB_PATH = previous_path

    def test_scoped_source_enum_matches_producer(self):
        tree = ast.parse((Path(__file__).resolve().parents[1]/"app/headcount.py").read_text())
        sources = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="SOURCES" for t in n.targets))
        self.assertEqual(set(sources),{"form","import","bot"})
        for table in ("headcount_records","headcount_history"):
            self.assertEqual(_ENUM_VALUES[(table,"source")],set(sources))

    def test_unrecognized_sources_and_other_columns_are_still_scanned(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        try:
            conn.executescript("CREATE TABLE headcount_records(source TEXT); CREATE TABLE headcount_history(source TEXT); CREATE TABLE other_data(source TEXT);")
            needles = [("legacy actor",source) for source in ("form","import","bot")]
            for table in ("headcount_records","headcount_history"):
                conn.executemany(f"INSERT INTO {table} VALUES (?)",[(s,) for s in ("form","import","bot")])
            self.assertEqual(find_leaks(conn,needles),[])
            conn.execute("INSERT INTO headcount_records VALUES ('import-private')")
            conn.execute("INSERT INTO headcount_history VALUES ('PRIVATE-ORIGINAL')")
            conn.execute("INSERT INTO other_data VALUES ('import')")
            leaks = find_leaks(conn,needles+[("private source","PRIVATE-ORIGINAL")])
            self.assertIn(("headcount_records","source","legacy actor"),leaks)
            self.assertIn(("headcount_history","source","private source"),leaks)
            self.assertIn(("other_data","source","legacy actor"),leaks)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

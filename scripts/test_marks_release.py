"""Regression checks for marks catch-up and fail-closed deployment validation.

Only temporary synthetic databases are used. No service database is opened.
"""
import contextlib
import importlib.util
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import db, release_tasks as release

spec = importlib.util.spec_from_file_location("migration_gate", ROOT / "scripts/dry_run_migration.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class MarksReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="marks_release_")
        self.path = Path(self.tmp.name) / "source.db"
        self.db_patch = patch.object(db, "DB_PATH", self.path)
        self.db_patch.start()
        db.init_db()
        self.c = db.get_connection()
        self.obj = self.c.execute("INSERT INTO objects(name) VALUES ('Тестовый объект')").lastrowid
        self.other = self.c.execute("INSERT INTO objects(name) VALUES ('Другой тестовый объект')").lastrowid
        cp = self.c.execute("INSERT INTO counterparties(full_name,short_name) VALUES ('Тестовый поставщик','Тест')").lastrowid
        ag = self.c.execute("INSERT INTO agreements(counterparty_id,number,object_id) VALUES (?,'Тест',?)", (cp, self.obj)).lastrowid
        sp = self.c.execute("INSERT INTO specifications(agreement_id,number) VALUES (?,'Тест')", (ag,)).lastrowid
        self.contract = self.c.execute("INSERT INTO contracts(specification_id) VALUES (?)", (sp,)).lastrowid
        self.c.commit()

    def tearDown(self):
        self.c.close()
        self.db_patch.stop()
        self.tmp.cleanup()

    def add_element(self, mark, mark_id=None, obj=None):
        return self.c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,mark_id) "
                              "VALUES ('synthetic.dxf',?,'test','Ригель',?,'manual',0,0,'matched',?,?)",
                              (str(self.c.execute('SELECT COUNT(*) FROM elements').fetchone()[0]), mark, obj or self.obj, mark_id)).lastrowid

    def snapshot(self):
        return {name: [tuple(r) for r in self.c.execute(f"SELECT * FROM {name} ORDER BY id")]
                for name in ("marks", "elements", "contract_lines")}

    def test_repeat_preserves_rows_ids_manual_links_and_sequence(self):
        manual = self.c.execute("INSERT INTO marks(object_id,element_type,name) VALUES (?,'Ригель','Ручная запись')", (self.obj,)).lastrowid
        linked = self.add_element("Сохранить текст", manual)
        unlinked = self.add_element("Новое изделие")
        self.c.execute("INSERT INTO contract_lines(contract_id,element_type,mark,quantity) VALUES (?,'Ригель','Только в контракте',2)", (self.contract,))
        self.c.commit()
        release._fill_marks_catalog(self.c); self.c.commit()
        before = self.snapshot()
        seq = self.c.execute("SELECT seq FROM sqlite_sequence WHERE name='marks'").fetchone()[0]
        for _ in range(3):
            release._fill_marks_catalog(self.c); self.c.commit()
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(self.c.execute("SELECT seq FROM sqlite_sequence WHERE name='marks'").fetchone()[0], seq)
        self.assertEqual(self.c.execute("SELECT mark_id,mark FROM elements WHERE id=?", (linked,)).fetchone()[:], (manual,"Сохранить текст"))
        self.assertIsNotNone(self.c.execute("SELECT mark_id FROM elements WHERE id=?", (unlinked,)).fetchone()[0])

    def test_exact_scope_case_blank_and_unknown_type(self):
        self.add_element("Р-1")
        self.add_element("р-1")
        self.add_element("Р-1", obj=self.other)
        self.c.executemany("INSERT INTO contract_lines(contract_id,element_type,mark,quantity) VALUES (?,?,?,1)",
                           [(self.contract,None,"Без типа"),(self.contract,"Ригель",None),(self.contract,"Ригель","  ")])
        release._fill_marks_catalog(self.c); self.c.commit()
        rows = self.c.execute("SELECT object_id,name FROM marks ORDER BY id").fetchall()
        self.assertEqual({(r[0],r[1]) for r in rows}, {(self.obj,"Р-1"),(self.obj,"р-1"),(self.other,"Р-1")})

    def test_new_release_catches_late_contract_after_old_success(self):
        old = next(t for t in release.RELEASE_TASKS if t["name"]=="2026-08-05-marks-catalog")
        new = next(t for t in release.RELEASE_TASKS if t["name"]=="2026-11-09-marks-catalog-catchup")
        release._record(self.c, old, "ok", "Выполнено до позднего контракта", 0)
        self.c.execute("INSERT INTO contract_lines(contract_id,element_type,mark,quantity) VALUES (?,'Ригель','Поздняя марка',3)", (self.contract,))
        self.c.commit()
        with patch.object(release,"RELEASE_TASKS",[old,new]), patch.object(release,"backup_before_tasks",return_value=None), contextlib.redirect_stdout(io.StringIO()):
            first=release.run_pending()
            self.assertEqual([r["name"] for r in first],[new["name"]])
            self.assertEqual(first[0]["status"],"ok")
            self.assertEqual(release.run_pending(),[])
            before=self.snapshot()
            for _ in range(2):
                for task in (old,new): self.assertEqual(release.run_by_name(task["name"])["status"],"ok")
                self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM marks WHERE name='Поздняя марка'").fetchone()[0],1)

    def test_gate_detects_mark_content_changes_without_count_change(self):
        self.add_element("Исходная марка")
        release._fill_marks_catalog(self.c); self.c.commit()
        before=gate.content_digests(self.path)
        self.c.execute("UPDATE marks SET name='Другое написание'"); self.c.commit()
        self.assertNotEqual(gate.content_digests(self.path)["marks"],before["marks"])

    def test_gate_failure_returns_nonzero_and_preserves_source(self):
        before=self.path.read_bytes()
        result={"первый":[],"повторы":[{"name":"failure-fixture","status":"error","note":"Synthetic failure"}],
                "расхождения":[],"изменилось_содержание":[],"версия_совпала":True}
        with patch.object(db,"DB_PATH",Path(self.tmp.name)/"dry_run_work.db"), patch.object(gate,"прогон_обработок",return_value=result), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(gate.главное(str(self.path)),1)
        self.assertEqual(self.path.read_bytes(),before)


if __name__=="__main__":
    unittest.main(verbosity=2)

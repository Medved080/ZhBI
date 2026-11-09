"""User copying regression checks; only a fresh temporary database is used.

Run: .venv312/bin/python scripts/test_user_copy.py
"""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from app import access, auth, db, team_access, users


class UserCopyTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory(prefix="zhbi-user-copy-")
        self.addCleanup(work.cleanup)
        db_patch = patch.object(db, "DB_PATH", Path(work.name) / "test.db")
        db_patch.start()
        self.addCleanup(db_patch.stop)
        db.init_db()
        self.conn = db.get_connection()
        self.addCleanup(self.conn.close)
        self.admin = self.conn.execute("SELECT * FROM users WHERE domain_login='admin'").fetchone()
        self.actor = self.admin
        self.conn.executemany("INSERT INTO object_roles(key,name,rank) VALUES(?,?,101)", [
            ("copy_global", "Общий доступ"), ("copy_project", "Проект"),
            ("copy_object", "Объект"), ("copy_team", "Команда"),
        ])
        self.project = self.conn.execute("INSERT INTO projects(name) VALUES('Копирование')").lastrowid
        self.obj = self.conn.execute("INSERT INTO objects(name,project_id) VALUES('Корпус',?)", (self.project,)).lastrowid
        self.source = self.conn.execute(
            "INSERT INTO users(last_name,first_name,domain_login,role,password_hash,password_salt) "
            "VALUES('Образцов','Олег','copy.source','view','private-hash','private-salt')"
        ).lastrowid
        self.conn.executemany("INSERT INTO user_access(user_id,project_id,object_id,role) VALUES(?,?,?,?)", [
            (self.source, None, None, "copy_global"),
            (self.source, self.project, None, "copy_project"),
            (self.source, self.project, self.obj, "copy_object"),
            (self.source, self.project, self.obj, "copy_project"),
        ])
        self.conn.commit()
        self.app = FastAPI()
        self.app.include_router(users.router)
        self.app.dependency_overrides[auth.get_current_user] = lambda: self.actor
        logger = patch.object(users.activity, "log")
        self.log = logger.start()
        self.addCleanup(logger.stop)

    def post(self, **overrides):
        data = dict(last_name="Новый", first_name="Николай", domain_login="copy.new", role="user",
                    copy_from_user_id=self.source)
        data.update(overrides)
        payload = json.dumps(data).encode()

        async def request():
            messages = []
            async def receive():
                return {"type": "http.request", "body": payload, "more_body": False}
            async def send(message):
                messages.append(message)
            await self.app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                            "method": "POST", "scheme": "http", "path": "/users", "root_path": "",
                            "query_string": b"", "headers": [(b"content-type", b"application/json")],
                            "client": ("127.0.0.1", 1), "server": ("test", 80)}, receive, send)
            status = next(m["status"] for m in messages if m["type"] == "http.response.start")
            body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
            return status, json.loads(body)
        return asyncio.run(request())

    def grants(self, user_id):
        return {tuple(row) for row in self.conn.execute(
            "SELECT project_id,object_id,role FROM user_access WHERE user_id=?", (user_id,))}

    def test_copies_all_levels_roles_and_keeps_identity_secrets_and_source_separate(self):
        before = dict(self.conn.execute("SELECT * FROM users WHERE id=?", (self.source,)).fetchone())
        grants = self.grants(self.source)
        status, result = self.post(role="admin")  # the source's actual system role wins
        self.assertEqual(status, 200, result)
        self.assertEqual(result["role"], "view")
        self.assertNotEqual(result["id"], self.source)
        self.assertEqual(result["last_name"], "Новый")
        self.assertEqual(self.grants(result["id"]), grants)
        new = self.conn.execute("SELECT * FROM users WHERE id=?", (result["id"],)).fetchone()
        self.assertIsNone(new["password_hash"])
        self.assertIsNone(new["password_salt"])
        self.assertTrue(result["must_change_password"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM sessions WHERE user_id=?", (new["id"],)).fetchone()[0], 0)
        self.assertEqual(dict(self.conn.execute("SELECT * FROM users WHERE id=?", (self.source,)).fetchone()), before)
        self.assertEqual(self.grants(self.source), grants)
        self.assertEqual(access.object_role_keys(self.conn, new, self.obj),
                         access.object_role_keys(self.conn, before, self.obj))
        self.assertIn("copy.source", self.log.call_args.kwargs["new_value"])

    def test_team_rights_become_independent_and_survive_source_team_removal(self):
        person = self.conn.execute("INSERT INTO individuals(name) VALUES('Образцов О.')").lastrowid
        self.conn.execute("INSERT INTO individual_user_links VALUES(?,?)", (person, self.source))
        self.conn.execute("INSERT INTO team_role_access VALUES('gip','copy_team')")
        self.conn.execute("INSERT INTO object_team_members(object_id,role_key,individual_id) VALUES(?,'gip',?)", (self.obj, person))
        team_access.sync_all(self.conn)
        self.conn.commit()
        expected = self.grants(self.source)
        status, result = self.post()
        self.assertEqual(status, 200, result)
        self.assertEqual(self.grants(result["id"]), expected)
        self.assertFalse(team_access.derived_grant_ids(self.conn, result["id"]))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM individual_user_links WHERE user_id=?", (result["id"],)).fetchone()[0], 0)
        self.conn.execute("DELETE FROM object_team_members WHERE individual_id=?", (person,))
        team_access.sync_all(self.conn)
        self.conn.commit()
        self.assertNotIn((self.project, self.obj, "copy_team"), self.grants(self.source))
        self.assertEqual(self.grants(result["id"]), expected)

    def test_duplicate_login_missing_source_and_invalid_source_leave_no_partial_user(self):
        count = self.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        for body, expected in [({"domain_login": "COPY.SOURCE"}, 409),
                               ({"copy_from_user_id": 9999999}, 404), ({"copy_from_user_id": 0}, 422)]:
            with self.subTest(body=body):
                status, result = self.post(**body)
                self.assertEqual(status, expected, result)
                self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], count)
        self.log.assert_not_called()

    def test_grant_failure_rolls_back_new_user(self):
        self.conn.execute("CREATE TRIGGER fail_copy BEFORE INSERT ON user_access "
                          "WHEN NEW.user_id != %d BEGIN SELECT RAISE(ABORT,'copy failed'); END" % self.source)
        self.conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.post()
        self.assertIsNone(self.conn.execute("SELECT id FROM users WHERE domain_login='copy.new'").fetchone())
        self.log.assert_not_called()

    def test_admin_and_user_without_grants_copy_and_ordinary_creation(self):
        status, result = self.post(copy_from_user_id=self.admin["id"])
        self.assertEqual(status, 200, result)
        self.assertEqual(result["role"], "admin")
        self.conn.execute("DELETE FROM user_access WHERE user_id=?", (self.source,))
        self.conn.commit()
        status, result = self.post(domain_login="copy.empty")
        self.assertEqual(status, 200, result)
        self.assertEqual(self.grants(result["id"]), set())
        status, result = self.post(domain_login="ordinary.new", copy_from_user_id=None, role="user")
        self.assertEqual(status, 200, result)
        self.assertEqual(result["role"], "user")
        self.assertEqual(self.grants(result["id"]), set())

    def test_requires_user_management_write_permission(self):
        self.actor = self.conn.execute("SELECT * FROM users WHERE id=?", (self.source,)).fetchone()
        status, result = self.post()
        self.assertEqual(status, 403, result)
        self.assertIsNone(self.conn.execute("SELECT id FROM users WHERE domain_login='copy.new'").fetchone())


if __name__ == "__main__":
    unittest.main()

"""Temporary-password lifecycle on a fresh synthetic DB; no user data is read.

Run: .venv312/bin/python scripts/test_user_credentials.py
"""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import test_user_copy
from app import auth


class UserCredentialsTests(unittest.TestCase):
    setUp = test_user_copy.UserCopyTests.setUp
    post = test_user_copy.UserCopyTests.post
    grants = test_user_copy.UserCopyTests.grants

    def request(self, method, path, data=None):
        async def run():
            messages = []
            async def receive():
                return {"type": "http.request", "body": json.dumps(data or {}).encode(), "more_body": False}
            async def send(message):
                messages.append(message)
            await self.app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                            "method": method, "scheme": "http", "path": path, "root_path": "",
                            "query_string": b"", "headers": [(b"content-type", b"application/json")],
                            "client": ("127.0.0.1", 1), "server": ("test", 80)}, receive, send)
            start = next(m for m in messages if m["type"] == "http.response.start")
            body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
            return start["status"], json.loads(body), dict(start["headers"])
        return asyncio.run(run())

    def test_generator_meets_policy_and_avoids_ambiguous_characters(self):
        passwords = {auth.generate_password() for _ in range(200)}
        self.assertEqual(len(passwords), 200)
        for password in passwords:
            self.assertEqual(len(password), 12)
            self.assertFalse(set(password) & set("0O1lI5S"))
            auth.validate_password_strength(password)

    def test_create_copies_rights_and_returns_password_once_without_logging_it(self):
        status, result, headers = self.request("POST", "/users", {
            "last_name": "Новый", "domain_login": "generated.user", "role": "user",
            "copy_from_user_id": self.source, "generate_password": True, "must_change_password": False,
        })
        self.assertEqual(status, 200, result)
        self.assertEqual(headers[b"cache-control"], b"no-store")
        self.assertTrue(result["has_password"])
        self.assertTrue(result["must_change_password"])
        self.assertEqual(self.grants(result["id"]), self.grants(self.source))
        password = result["generated_password"]
        stored = self.conn.execute("SELECT * FROM users WHERE id=?", (result["id"],)).fetchone()
        self.assertTrue(auth.verify_password(password, stored["password_hash"], stored["password_salt"]))
        self.assertNotIn(password, str(dict(stored)))
        self.assertNotIn(password, str(self.log.call_args_list))
        status, listed, _ = self.request("GET", "/users")
        self.assertEqual(status, 200)
        self.assertNotIn(password, json.dumps(listed))
        self.assertTrue(all("generated_password" not in u for u in listed))

    def test_reset_invalidates_sessions_and_previous_password(self):
        self.conn.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES('old-session',?,datetime('now','+1 day'))", (self.source,))
        self.conn.commit()
        url = f"/users/{self.source}/generate-password"
        status, first, headers = self.request("POST", url)
        self.assertEqual(status, 200, first)
        self.assertEqual(headers[b"cache-control"], b"no-store")
        self.assertTrue(first["must_change_password"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM sessions WHERE user_id=?", (self.source,)).fetchone()[0], 0)
        status, second, _ = self.request("POST", url)
        self.assertEqual(status, 200, second)
        self.assertNotEqual(first["generated_password"], second["generated_password"])
        stored = self.conn.execute("SELECT * FROM users WHERE id=?", (self.source,)).fetchone()
        self.assertTrue(auth.verify_password(second["generated_password"], stored["password_hash"], stored["password_salt"]))
        self.assertFalse(auth.verify_password(first["generated_password"], stored["password_hash"], stored["password_salt"]))

    def test_generation_respects_permissions_domain_and_missing_user(self):
        self.actor = self.conn.execute("SELECT * FROM users WHERE id=?", (self.source,)).fetchone()
        status, result, _ = self.request("POST", f"/users/{self.source}/generate-password")
        self.assertEqual(status, 403, result)
        self.actor = self.admin
        self.conn.execute("UPDATE users SET auth_method='domain' WHERE id=?", (self.source,))
        self.conn.commit()
        status, result, _ = self.request("POST", f"/users/{self.source}/generate-password")
        self.assertEqual(status, 409, result)
        self.assertNotIn("generated_password", result)
        status, result, _ = self.request("POST", "/users/9999999/generate-password")
        self.assertEqual(status, 404, result)
        status, result = self.post(generate_password=True, auth_method="domain")
        self.assertEqual(status, 422, result)

    def test_failed_grant_copy_rolls_back_password_and_account(self):
        self.conn.execute("CREATE TRIGGER reject_copy BEFORE INSERT ON user_access "
                          "WHEN NEW.user_id != %d BEGIN SELECT RAISE(ABORT,'failed'); END" % self.source)
        self.conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.post(generate_password=True)
        self.assertIsNone(self.conn.execute("SELECT id FROM users WHERE domain_login='copy.new'").fetchone())


if __name__ == "__main__":
    unittest.main()

"""Регрессия входа без учёта регистра; только временная база."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Request, Response

from app import auth, db, ldap_auth, users


class LoginCaseTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="login-case-")
        self.addCleanup(temp.cleanup)
        db_patch = patch.object(db, "DB_PATH", Path(temp.name) / "test.db")
        db_patch.start()
        self.addCleanup(db_patch.stop)
        conn = db.get_connection()
        conn.execute("""CREATE TABLE users (
            id INTEGER PRIMARY KEY, domain_login TEXT UNIQUE, auth_method TEXT,
            password_hash TEXT, password_salt TEXT, role TEXT DEFAULT 'viewer',
            last_name TEXT DEFAULT '', first_name TEXT DEFAULT '',
            patronymic TEXT, position TEXT, department TEXT,
            must_change_password INTEGER DEFAULT 0)""")
        password_hash, salt = auth.hash_password("Secret-123")
        conn.executemany(
            "INSERT INTO users (domain_login, auth_method, password_hash, password_salt) VALUES (?, ?, ?, ?)",
            [(name, method, password_hash, salt) for name, method in
             [("Mixed.User", "local"), ("Иван.Петров", "local"), ("Domain.User", "domain")]],
        )
        conn.commit()
        conn.close()
        for target, kwargs in [
            ("_log_login", {}), ("create_session", {"return_value": "test-token"}),
            ("prune_expired_sessions", {"return_value": 0}),
            ("user_out", {"side_effect": dict}),
            ("_login_attempts", {"new": {}}),
        ]:
            mock_patch = patch.object(auth, target, **kwargs)
            mock_patch.start()
            self.addCleanup(mock_patch.stop)
        self.request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})

    def login(self, name, password="Secret-123"):
        response = Response()
        result = auth.login(auth.LoginRequest(domain_login=name, password=password), self.request, response)
        self.assertIn("zhbi_session=test-token", response.headers["set-cookie"])
        return result

    def test_latin_and_cyrillic_login_variants(self):
        for stored in ("Mixed.User", "Иван.Петров"):
            for entered in (stored, stored.lower(), stored.upper(), stored.swapcase()):
                with self.subTest(entered=entered):
                    self.assertEqual(self.login(entered)["domain_login"], stored)

    def test_password_remains_case_sensitive(self):
        with self.assertRaises(HTTPException) as error:
            self.login("MIXED.USER", "secret-123")
        self.assertEqual(error.exception.status_code, 401)
        auth.create_session.assert_not_called()

    def test_domain_receives_stored_login_and_original_password(self):
        with patch.object(ldap_auth, "authenticate") as authenticate:
            self.assertEqual(self.login("DOMAIN.USER")["domain_login"], "Domain.User")
            self.assertEqual(authenticate.call_args.args[1:], ("Domain.User", "Secret-123"))

    def test_variants_share_rate_limit(self):
        with patch.object(auth, "LOGIN_RATE_LIMIT_MAX_ATTEMPTS", 2):
            for name in ("MIXED.USER", "mixed.user"):
                with self.assertRaises(HTTPException) as error:
                    self.login(name, "wrong")
                self.assertEqual(error.exception.status_code, 401)
            with self.assertRaises(HTTPException) as error:
                self.login("Mixed.User")
            self.assertEqual(error.exception.status_code, 429)

    def test_success_clears_account_failures_across_variants(self):
        with self.assertRaises(HTTPException):
            self.login("MIXED.USER", "wrong")
        self.login("mixed.user")
        self.assertNotIn(("pair", "mixed.user", "127.0.0.1"), auth._login_attempts)
        self.assertNotIn(("login", "mixed.user"), auth._login_attempts)
        self.assertEqual(len(auth._login_attempts[("ip", "127.0.0.1")]), 1)

    def test_existing_collision_does_not_pick_an_account(self):
        conn = db.get_connection()
        conn.execute("INSERT INTO users (domain_login, auth_method) VALUES ('mixed.user', 'local')")
        conn.commit()
        conn.close()
        with self.assertRaises(HTTPException) as error:
            self.login("Mixed.User")
        self.assertEqual(error.exception.status_code, 401)
        auth.create_session.assert_not_called()

    def test_create_and_update_reject_case_only_duplicates(self):
        for name in ("MIXED.USER", "ИВАН.ПЕТРОВ"):
            with self.subTest(name=name):
                fields = dict(last_name="Тест", first_name="Тест", domain_login=name, role="admin")
                with self.assertRaises(HTTPException) as error:
                    users.create_user(users.UserCreateIn(**fields), admin={"id": 99})
                self.assertEqual(error.exception.status_code, 409)
                with self.assertRaises(HTTPException) as error:
                    users.update_user(3, users.UserUpdateIn(**fields), self.request, admin={"id": 99})
                self.assertEqual(error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()

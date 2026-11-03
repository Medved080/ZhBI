"""HTTP regression on a temporary SQLite backup of the anonymized database.

Run: .venv312/bin/python scripts/test_element_form.py /path/zhbi.anon.db
"""
import os
import sqlite3
import sys
import tempfile
import http.client
import socket
import threading
import time
import json
from pathlib import Path

source = Path(sys.argv[1]).resolve()
work = tempfile.TemporaryDirectory(prefix="zhbi-element-form-test-")
database = Path(work.name) / "test.db"
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(database) as dst:
    src.backup(dst)
os.environ["ZHBI_DB_PATH"] = str(database)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
import uvicorn
from app import activity
from app.auth import get_current_user
from app.element_form import router
from app.schedule_versions import element_deviation, forecast_dates, need_start_dates


def db():
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    return conn


with db() as conn:
    admin = conn.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
    viewer = conn.execute("SELECT * FROM users WHERE domain_login='user4'").fetchone()
    ids = [r[0] for r in conn.execute("SELECT id FROM elements WHERE object_id=1 AND is_current=1 ORDER BY id LIMIT 2")]
    eid, other = ids
    conn.execute("UPDATE elements SET current_status='ready_for_installation', contract_id=NULL WHERE id=?", (eid,))
    old_version = conn.execute("INSERT INTO schedule_versions(object_id,kind,title,loaded_at) VALUES(1,'current','QA old','2090-01-01')").lastrowid
    version = conn.execute("INSERT INTO schedule_versions(object_id,kind,title,loaded_at) VALUES(1,'current','QA latest','2090-01-02')").lastrowid
    for vid in (old_version, version):
        conn.executemany("INSERT INTO schedule_version_dates VALUES(?,?,?,?)", [(vid, eid, '2030-01-10', '2030-01-20'), (vid, other, '2030-02-10', '2030-02-20')])

app = FastAPI()
app.include_router(router, prefix="/element-ops")
current_user = admin
app.dependency_overrides[get_current_user] = lambda: current_user
activity.start_worker()
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
thread.start()
for _ in range(100):
    if server.started:
        break
    time.sleep(.05)
assert server.started


class Client:
    def request(self, method, path, payload=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None,
                     headers={"Content-Type": "application/json"})
        response = conn.getresponse()
        status, text = response.status, response.read().decode()
        conn.close()
        class Result:
            status_code = status
            def json(self):
                return json.loads(self.text)
        result = Result()
        result.text = text
        return result

    def get(self, path):
        return self.request("GET", path)

    def patch(self, path, json):
        return self.request("PATCH", path, json)


client = Client()
path = f"/element-ops/fields/{eid}"
checks = 0


def check(condition, message):
    global checks
    assert condition, message
    checks += 1


def snapshot():
    response = client.get(path)
    assert response.status_code == 200, response.text
    return response.json()


def save(changes, expected=None, status=200):
    response = client.patch(path, json={"changes": changes, "expected_revision": (expected or snapshot())["form_revision"]})
    check(response.status_code == status, response.text)
    return response.json()


before = snapshot()
saved = save({"project_smr_start_date": "2030-01-01", "project_delivery_date": "2030-01-30",
              "forecast_start": "2030-01-11", "forecast_end": "2030-01-21",
              "planned_delivery_date": "2030-01-09", "planned_installation_date": "2030-01-19"})
check(saved["forecast_start"] == "2030-01-11" and saved["planned_installation_date"] == "2030-01-19", "all date groups saved")
check("project_smr_start_date" in saved["manual_fields"] and "forecast_start" not in saved["manual_fields"], "manual flags remain element-only")
with db() as conn:
    check(tuple(conn.execute("SELECT smr_start_date,smr_end_date FROM schedule_version_dates WHERE version_id=? AND element_id=?", (old_version, eid)).fetchone()) == ('2030-01-10','2030-01-20'), "older version preserved")
    check(tuple(conn.execute("SELECT smr_start_date,smr_end_date FROM schedule_version_dates WHERE version_id=? AND element_id=?", (version, other)).fetchone()) == ('2030-02-10','2030-02-20'), "neighbor preserved")
    check(element_deviation(conn, eid)["forecast_start"] == "2030-01-11", "card uses saved date")
    check(forecast_dates(conn, 1)[eid][:2] == ('2030-01-11','2030-01-21') and need_start_dates(conn, 1)[eid] == '2030-01-11', "forecast and supply reports use saved dates")

save({"address": "must not persist", "forecast_start": "2030-02-30"}, status=400)
check(snapshot()["address"] == before["address"], "invalid date rolls back whole form")
save({"address": "must not persist", "forecast_start": "2031-01-01"}, status=400)
check(snapshot()["forecast_start"] == "2030-01-11", "reversed period refused")
save({"forecast_start": None})
check(snapshot()["forecast_end"] == "2030-01-21", "clearing one date preserves its pair")
save({"planned_installation_date": None})
check(snapshot()["planned_installation_date"] is None, "installation date can be cleared while ready")
save({"planned_installation_date": "2030-01-19"})
save({"forecast_start": "2030-01-11"}, expected=before, status=409)
stale = snapshot()
with db() as conn:
    conn.execute("UPDATE elements SET address='concurrent edit' WHERE id=?", (eid,))
save({"floor": 77}, expected=stale, status=409)
check(snapshot()["floor"] == before["floor"], "concurrent edit is not overwritten")
stale = snapshot()
with db() as conn:
    conn.execute("UPDATE schedule_version_dates SET smr_end_date='2030-01-22' WHERE version_id=? AND element_id=?", (version, eid))
save({"address": "must not persist"}, expected=stale, status=409)
stale = snapshot()
with db() as conn:
    new_version = conn.execute("INSERT INTO schedule_versions(object_id,kind,title,loaded_at) VALUES(1,'current','QA replacement','2090-01-03')").lastrowid
save({"address": "must not persist"}, expected=stale, status=409)
check(snapshot()["forecast_start"] is None, "missing record in latest version is empty")
save({"forecast_start": "2030-03-01"})
check(snapshot()["forecast_end"] is None, "add missing record without inventing the other date")
with db() as conn:
    conn.execute("UPDATE elements SET current_status='delivered' WHERE id=?", (eid,))
save({"address": "must not persist", "planned_installation_date": None}, status=409)
check(snapshot()["planned_installation_date"] == "2030-01-19" and snapshot()["address"] == "concurrent edit", "wrong status rolls back all fields")
save({"current_status": "installed"}, status=400)
current_user = viewer
check(client.get(path).status_code == 403, "form permission enforced")
check(client.patch(path, json={"changes":{"address":"forbidden"},"expected_revision":saved["form_revision"]}).status_code == 403, "write permission enforced")
current_user = admin
# A user with element-fields permission still needs schedule / planned-date rights.
from unittest.mock import patch
from app.element_form import assert_object_feature as real_assert
from fastapi import HTTPException


def deny_extra(conn, user, obj, feature, level):
    if feature in ("schedule", "planned_date"):
        raise HTTPException(403, "QA denied")
    return real_assert(conn, user, obj, feature, level)


with patch("app.element_form.assert_object_feature", deny_extra):
    save({"address": "must not persist", "forecast_end": "2030-03-03"}, status=403)
    save({"address": "must not persist", "planned_installation_date": None}, status=403)
check(snapshot()["address"] == "concurrent edit", "separate rights fail atomically")
with db() as conn:
    conn.execute("DELETE FROM schedule_versions WHERE object_id=1 AND kind='current'")
save({"forecast_end": "2030-04-01"})
check(snapshot()["schedule_version_id"] is not None and snapshot()["forecast_end"] == "2030-04-01", "first manual current version created")
activity.flush_for_tests()
with db() as conn:
    check(conn.execute("SELECT COUNT(*) FROM activity_log WHERE action='element_edit' AND entity_id=? AND details LIKE '%forecast_end%'", (eid,)).fetchone()[0] > 0, "date changes are audited")
print(f"OK: {checks} checks (temporary anonymized database)")
server.should_exit = True
thread.join(5)
work.cleanup()

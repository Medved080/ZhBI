"""Полностью синтетический стенд графика СМР с настоящим входом.

  .venv312/bin/python scripts/contracting_plan_test_server.py --port 8096
  node scripts/verify_contracting_plan_ui.mjs http://127.0.0.1:8096 10001

Новая временная БД при каждом запуске. Существующие базы/секреты не читаются.
Вход только на этом стенде: admin / Test-Pass-1234!
"""
import argparse
import os
import sys
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=8096)
args = parser.parse_args()
if args.port in (8000, 8010, 8020) or not 1024 < args.port < 65536:
    parser.error("Нужен отдельный тестовый порт; 8000/8010/8020 запрещены")
work = Path(tempfile.mkdtemp(prefix="cp-ui-synthetic-"))
os.environ["ZHBI_DB_PATH"] = str(work / "synthetic.db")
os.environ["ZHBI_CALC_DIR"] = str(work / "calc")
os.environ["ZHBI_CALC_ASSETS_DIR"] = str(work / "calc-assets")
os.environ["ZHBI_CALC_RECOVERY_WORKER"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app import backups  # noqa: E402
import uvicorn  # noqa: E402

backups.BACKUP_DIR = work / "backups"
db.init_db()
conn = db.get_connection()
try:
    password_hash, salt = hash_password("Test-Pass-1234!")
    conn.execute("UPDATE users SET password_hash=?,password_salt=?,must_change_password=0 WHERE domain_login='admin'", (password_hash, salt))
    conn.execute("INSERT INTO objects(id,name) VALUES (10001,'Синтетический объект СМР')")
    conn.execute("UPDATE users SET last_object_id=10001 WHERE domain_login='admin'")
    conn.commit()
finally:
    conn.close()
print(f"Синтетический стенд http://127.0.0.1:{args.port}/v2?object_id=10001#/contracting-plan; база {work}; admin / Test-Pass-1234!", flush=True)
uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, log_level="warning")

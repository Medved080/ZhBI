"""Проверка групповой очистки копий (app/backups.delete_backups, app/full_backup.delete_full_backups) на временной папке: частичный сбой, запрет стереть все копии,
недопустимые имена. Запуск:  .venv312/bin/python scripts/verify_backups_bulk.py"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("ZHBI_DB_PATH", str(Path(tempfile.mkdtemp(prefix="bulk-")) / "zhbi.db"))

from app import backups, full_backup  # noqa: E402

failed = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failed.append(label)


def raises(fn, status):
    try:
        fn()
    except backups.BackupError as e:
        return e.status_code == status
    return False


folder = Path(tempfile.mkdtemp(prefix="bulk-backups-"))
backups.BACKUP_DIR = folder
full_backup.FULL_DIR = folder / "full"
(folder / "full").mkdir()
for i in range(5):
    (folder / f"zhbi_{i}.db").write_bytes(b"x" * (100 + i)); (folder / f"zhbi_{i}.db.json").write_text("{}")
    (folder / "full" / f"full_{i}.zip").write_bytes(b"z" * (200 + i)); (folder / "full" / f"full_{i}.zip.json").write_text("{}")

r = backups.delete_backups(["zhbi_0.db", "zhbi_1.db", "нет_такой.db", "../evil.db"])
check(r["deleted"] == ["zhbi_0.db", "zhbi_1.db"] and len(r["failed"]) == 2, "удалены существующие, недопустимые и отсутствующие — в failed")
check(r["freed_bytes"] == 100 + 101, "освобождённое место посчитано (%s)" % r["freed_bytes"])
check(not (folder / "zhbi_0.db.json").exists() and (folder / "zhbi_2.db").exists(), "описание удаляется вместе с копией, остальные на месте")
check(raises(lambda: backups.delete_backups([f"zhbi_{i}.db" for i in (2, 3, 4)]), 409), "нельзя удалить все оставшиеся копии")
check(len(list(folder.glob("*.db"))) == 3, "после отказа ничего не удалено")
check(backups.delete_backups(["zhbi_2.db", "zhbi_2.db", "zhbi_3.db"])["deleted"] == ["zhbi_2.db", "zhbi_3.db"], "повторяющиеся имена учитываются один раз")
check(len(list(folder.glob("*.db"))) == 1, "осталась одна (самая свежая по выбору пользователя)")

r = full_backup.delete_full_backups(["full_0.zip", "full_1.zip", "full_9.zip"])
check(r["deleted"] == ["full_0.zip", "full_1.zip"] and r["failed"][0]["name"] == "full_9.zip", "полные копии: удалены существующие, отсутствующая — в failed")
check(raises(lambda: full_backup.delete_full_backups(["full_2.zip", "full_3.zip", "full_4.zip"]), 409), "полные копии: нельзя удалить все")
check(full_backup.delete_full_backups(["full_2.zip", "full_3.zip"])["freed_bytes"] == 202 + 203, "полные копии: освобождённое место")

print("\nпровалено: %d" % len(failed))
sys.exit(1 if failed else 0)

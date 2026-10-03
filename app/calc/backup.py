import hashlib
import json
import os
import re
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from .database import SCHEMA_VERSION, connect, dumps, now


def checksum(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            result.update(chunk)
    return result.hexdigest()


def create_backup(settings, output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError("Backup destination already exists")
    with tempfile.TemporaryDirectory(dir=settings.data_dir) as temporary:
        temporary = Path(temporary)
        source = connect(settings.database_path)
        destination = sqlite3.connect(temporary / "calczhbi.sqlite3")
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        conn = connect(temporary / "calczhbi.sqlite3")
        try:
            rows = conn.execute("SELECT storage_name,size,sha256 FROM project_files").fetchall()
            schema = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or conn.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Backup database failed integrity check")
        finally:
            conn.close()
        manifest = {"format": 1, "schema": schema, "createdAt": now(), "files": {"calczhbi.sqlite3": checksum(temporary / "calczhbi.sqlite3")}}
        partial = output.with_name(output.name + ".partial-" + os.urandom(8).hex())
        try:
            with zipfile.ZipFile(partial, "x", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(temporary / "calczhbi.sqlite3", "calczhbi.sqlite3")
                for row in rows:
                    if not re.fullmatch(r"[0-9a-f-]{36}\.bin", row["storage_name"]):
                        raise ValueError("Invalid file storage name")
                    path = settings.data_dir / "uploads" / row["storage_name"]
                    digest = checksum(path)
                    if digest != row["sha256"] or path.stat().st_size != row["size"]:
                        raise ValueError("Uploaded file checksum does not match the database")
                    name = "uploads/" + row["storage_name"]
                    manifest["files"][name] = digest
                    archive.write(path, name)
                archive.writestr("manifest.json", dumps(manifest))
            with partial.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(partial, output)
        finally:
            partial.unlink(missing_ok=True)
    return output


def restore_backup(archive_path, destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Restore requires a new destination directory; existing data is never overwritten")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        temporary = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or "manifest.json" not in names:
                raise ValueError("Invalid backup archive")
            if archive.getinfo("manifest.json").file_size > 10 * 1048576:
                raise ValueError("Backup manifest is too large")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("format") != 1 or type(manifest.get("schema")) is not int or not 1 <= manifest['schema'] <= SCHEMA_VERSION:
                raise ValueError("Unsupported backup format/schema")
            expected = manifest.get("files", {})
            if "calczhbi.sqlite3" not in expected or set(names) != set(expected) | {"manifest.json"}:
                raise ValueError("Backup file list does not match the manifest")
            if sum(info.file_size for info in archive.infolist()) > 100 * 1024**3:
                raise ValueError("Backup exceeds the restore limit")
            for name, digest in expected.items():
                if name != "calczhbi.sqlite3" and not re.fullmatch(r"uploads/[0-9a-f-]{36}\.bin", name):
                    raise ValueError("Unsafe backup path")
                path = temporary / name
                path.parent.mkdir(exist_ok=True)
                with archive.open(name) as source, path.open("xb") as target:
                    for chunk in iter(lambda: source.read(1048576), b""):
                        target.write(chunk)
                if checksum(path) != digest:
                    raise ValueError("Backup checksum verification failed")
        conn = connect(temporary / "calczhbi.sqlite3")
        try:
            if conn.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] != manifest['schema']:
                raise ValueError('Backup schema does not match its database')
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or conn.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Restored database failed integrity check")
            for row in conn.execute("SELECT storage_name,size,sha256 FROM project_files"):
                name = "uploads/" + row["storage_name"]
                if name not in expected or expected[name] != row["sha256"] or (temporary / name).stat().st_size != row["size"]:
                    raise ValueError("Restored uploads do not match database records")
            conn.execute("DELETE FROM sessions")
        finally:
            conn.close()
        (temporary / "uploads").mkdir(exist_ok=True)
        os.rename(temporary, destination)
    return destination

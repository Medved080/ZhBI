"""Служебные команды калькулятора (запускать при остановленном сервисе, где сказано).

    python -m app.calc.manage import-legacy /Users/max/projects/CalcZhBI [--no-assets]
    python -m app.calc.manage create-token <логин> "<название>"
    python -m app.calc.manage link-project
    python -m app.calc.manage backup <файл.zip>

Окружение то же, что у сервиса: ZHBI_DB_PATH (где база ЖБИ) и при необходимости
ZHBI_CALC_DIR / ZHBI_CALC_ASSETS_DIR.
"""
import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings
from .database import SCHEMA_VERSION, connect, initialize, transaction


def is_pristine(path):
    """База без пользовательской работы: только две исходные колонны, версия 1."""
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute("SELECT version FROM products").fetchall()
        files = conn.execute("SELECT COUNT(*) FROM project_files").fetchone()[0]
        return len(rows) <= 2 and all(r[0] == 1 for r in rows) and files == 0
    except sqlite3.DatabaseError:
        return False
    finally:
        conn.close()


def import_legacy(source_root, with_assets=True):
    """Переносит данные отдельного проекта CalcZhBI в подсистему. Источник не меняется."""
    cfg = Settings.embedded()
    source = Path(source_root).resolve()
    source_db = source / "data" / "calczhbi.sqlite3"
    if not source_db.is_file():
        raise SystemExit("Нет базы %s" % source_db)
    target = cfg.database_path
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if not is_pristine(target):
            raise SystemExit("В подсистеме уже есть пользовательские расчёты (%s): импорт ничего не перезаписывает" % target)
        aside = target.with_name(target.name + ".empty-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(target) + suffix)
            if p.exists():
                p.rename(Path(str(aside) + suffix))
        print("Пустая база отложена: %s" % aside)
    src = sqlite3.connect("file:%s?mode=ro" % source_db, uri=True)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    # Файлы вложений с проверкой контрольных сумм.
    uploads = cfg.data_dir / "uploads"
    uploads.mkdir(exist_ok=True)
    conn = connect(target)
    try:
        files = conn.execute("SELECT storage_name,size,sha256 FROM project_files").fetchall()
    finally:
        conn.close()
    import hashlib
    for row in files:
        origin = source / "data" / "uploads" / row["storage_name"]
        if not origin.is_file():
            raise SystemExit("Нет файла вложения %s" % origin)
        if hashlib.sha256(origin.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit("Контрольная сумма вложения не совпала: %s" % origin)
        shutil.copyfile(origin, uploads / row["storage_name"])
    initialize(cfg)  # миграция схемы до текущей; перед ней копию делает сервис, здесь база — только что снятая копия
    with transaction(target) as c:
        # Собственные учётные записи отдельного проекта не переносятся: вход общий с ЖБИ.
        for table in ("sessions", "login_attempts", "users"):
            c.execute("DELETE FROM %s" % table)
    assets_count = 0
    if with_assets:
        from .paths import ASSETS_DIR
        origin = source / "backend" / "assets"
        if origin.is_dir():
            for path in sorted(origin.rglob("*")):
                relative = path.relative_to(origin)
                if path.is_dir() or relative.parts[0] in {"recovery", "recovery.seed"} or any(p.startswith(".") for p in relative.parts):
                    continue
                destination = ASSETS_DIR / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists() or destination.stat().st_size != path.stat().st_size:
                    shutil.copyfile(path, destination)
                    assets_count += 1
    from .link import link_project
    info = link_project(cfg)
    print(json.dumps({"schema": SCHEMA_VERSION, "attachments": len(files), "assetsCopied": assets_count, "link": info}, ensure_ascii=False))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m app.calc.manage")
    sub = parser.add_subparsers(dest="cmd", required=True)
    legacy = sub.add_parser("import-legacy")
    legacy.add_argument("source")
    legacy.add_argument("--no-assets", action="store_true")
    token = sub.add_parser("create-token")
    token.add_argument("login")
    token.add_argument("name")
    sub.add_parser("link-project")
    backup = sub.add_parser("backup")
    backup.add_argument("output")
    args = parser.parse_args(argv)
    if args.cmd == "import-legacy":
        import_legacy(args.source, not args.no_assets)
    elif args.cmd == "create-token":
        from .sync_api import issue_token
        cfg = Settings.embedded()
        initialize(cfg)
        print(json.dumps(issue_token(cfg, args.login, args.name, "cli"), ensure_ascii=False))
    elif args.cmd == "link-project":
        from .link import link_project
        cfg = Settings.embedded()
        initialize(cfg)
        print(json.dumps(link_project(cfg), ensure_ascii=False))
    elif args.cmd == "backup":
        from .backup import create_backup
        create_backup(Settings.embedded(), args.output)
        print(args.output)


if __name__ == "__main__":
    sys.exit(main())

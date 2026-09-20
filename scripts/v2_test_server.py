"""Тестовый стенд V2: только статика, без БД, без входа, без приложения.

Отдаёт настоящие файлы интерфейса (`app/static` под `/static`) и тестовые
страницы (`scripts/v2_tests` под `/tests`). Бэкенд подменяет браузерный
модуль `scripts/v2_tests/fake-backend.js` (подмена fetch), поэтому ни рабочая
БД, ни `data/*.db`, ни `app.main` здесь не открываются и не импортируются.

Запуск:  python3 scripts/v2_test_server.py [порт] [--static КАТАЛОГ]   (порт по умолчанию 8031)
         --static — подставить другой каталог `app/static` (например, распакованный
         `git archive <коммит> app/static`), чтобы прогнать те же сценарии на старом коде.
Страницы: http://127.0.0.1:8031/tests/app.html   — V2 против фейкового бэкенда
          http://127.0.0.1:8031/tests/run.html   — автоматические сценарии
Слушает только 127.0.0.1.
"""
import json
import mimetypes
import re
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
MOUNTS = {
    "/static/": ROOT / "app" / "static",
    "/tests/": ROOT / "scripts" / "v2_tests",
}
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = unquote(urlsplit(path).path)
        for prefix, base in MOUNTS.items():
            if clean.startswith(prefix):
                target = (base / clean[len(prefix):]).resolve()
                # не выходим за пределы смонтированного каталога
                if base.resolve() in target.parents or target == base.resolve():
                    return str(target)
                return str(base / "__нет_такого_файла__")
        return str(ROOT / "__нет_такого_файла__")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if urlsplit(self.path).path in ("/", "/v2"):
            self.send_response(302)
            self.send_header("Location", "/tests/app.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        """POST /save-results?name=<имя>: сохранить результаты прогона (Docs/v2-acceptance-results/<имя>.json)
        вместе с версией кода — доказательство для матрицы приёмки. Только loopback, только этот путь."""
        parts = urlsplit(self.path)
        if parts.path != "/save-results":
            self.send_error(404)
            return
        name = re.sub(r"[^a-zA-Z0-9_-]", "", (parts.query.split("name=")[-1] if "name=" in parts.query else "results")) or "results"
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")

        def git(*a):
            return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout.strip()

        data["rev"] = git("rev-parse", "--short", "HEAD")
        data["tree_dirty"] = bool(git("status", "--porcelain", "--", "app/static/v2", "scripts/v2_tests"))
        data["ran_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        out_dir = ROOT / "Docs" / "v2-acceptance-results"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"saved": f"Docs/v2-acceptance-results/{name}.json", "rev": data["rev"], "tree_dirty": data["tree_dirty"]}).encode())

    def log_message(self, fmt, *args):  # тише: только ошибки
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--static" in args:
        i = args.index("--static")
        MOUNTS["/static/"] = Path(args[i + 1]).resolve()
        del args[i:i + 2]
    port = int(args[0]) if args else 8031
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Стенд V2 (без БД и без входа): http://127.0.0.1:{port}/tests/app.html", flush=True)
    server.serve_forever()

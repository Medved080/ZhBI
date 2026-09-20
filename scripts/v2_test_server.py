"""Тестовый стенд V2: только статика, без БД, без входа, без приложения.

Отдаёт настоящие файлы интерфейса (`app/static` под `/static`) и тестовые
страницы (`scripts/v2_tests` под `/tests`). Бэкенд подменяет браузерный
модуль `scripts/v2_tests/fake-backend.js` (подмена fetch), поэтому ни рабочая
БД, ни `data/*.db`, ни `app.main` здесь не открываются и не импортируются.

Запуск:  python3 scripts/v2_test_server.py [порт]        (по умолчанию 8031)
Страницы: http://127.0.0.1:8031/tests/app.html   — V2 против фейкового бэкенда
          http://127.0.0.1:8031/tests/run.html   — автоматические сценарии
Слушает только 127.0.0.1.
"""
import mimetypes
import sys
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

    def log_message(self, fmt, *args):  # тише: только ошибки
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8031
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Стенд V2 (без БД и без входа): http://127.0.0.1:{port}/tests/app.html", flush=True)
    server.serve_forever()

"""Обмен данными калькулятора между серверами в рамках «Обмена данными с другим сервером» (2026-10-08).

Тот же пакет и те же правила, что у отправки по токену (sync.py, sync_api.py): создаётся то, чего нет; существующее обновляется
только если принимающая сторона его не меняла; всё остальное пропускается с пометкой «приоритет принимающего сервера»; удаляется
ничего. Отличие — способ входа: здесь сеанс администратора другого сервера (логин и пароль вводятся при подключении), а не токен.

* ОТПРАВИТЬ: `plan_send` собирает пакет, передаёт его описание и получает «план» принимающей стороны (что создаст, обновит,
  пропустит, какие файлы нужны); `run_send` передаёт файлы и применяет пакет там (commit).
* ПОЛУЧИТЬ: `plan_receive` забирает пакет другого сервера и считает, что произойдёт у нас (dry run в откатываемой транзакции);
  `run_receive` скачивает недостающие файлы в очередь приёма и применяет пакет тем же `commit_package`, что и приём по токену.

Выбора «по записям» калькулятор не даёт: он передаётся целиком (решение пользователя 2026-10-04), поэтому в обмене это один
переключатель «включить калькулятор». Планы и ход фоновой передачи хранятся в памяти процесса.
"""
from __future__ import annotations

import threading
import time
import urllib.parse
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from . import runtime
from .database import connect
from .sync import Staging, SyncError, apply_package, needed
from .sync_api import RemoteError, calc_assets_dir, commit_package, finish_push, prepare_push, size_text

_PLANS: dict = {}
_JOBS: dict = {}
_LOCK = threading.Lock()
CHUNK = 4 * 1024 * 1024


class SessionRemote:
    """Клиент чужого калькулятора по СЕАНСУ (cookie + CSRF-токен подсистемы), с тем же интерфейсом, что у `sync_api.Remote`:
    `call(method, path, body, content_type, timeout)` и `chunk` — на нём работают `upload_file`, `prepare_push`, `finish_push`."""

    def __init__(self, session):
        self.rs = session
        self.base = session.base
        self.chunk = CHUNK
        self._csrf = None

    def csrf(self):
        if self._csrf is None:
            me = self.rs.call("GET", "/calc/api/auth/me", timeout=60)
            self._csrf = me["csrfToken"]
        return self._csrf

    def _convert(self, error):
        return RemoteError(error.status, error.detail if isinstance(error.detail, dict) else {"detail": str(error)})

    def call(self, method, path, body=None, content_type="application/json", timeout=300):
        headers = {} if method in ("GET", "HEAD") else {"X-CSRF-Token": self.csrf()}
        try:
            if isinstance(body, bytes):
                return self.rs.call(method, path, raw=body, timeout=timeout, headers=headers)
            return self.rs.call(method, path, body=body, timeout=timeout, headers=headers)
        except Exception as error:  # noqa: BLE001 — RemoteError клиента сеанса приводится к RemoteError подсистемы
            if hasattr(error, "status") and hasattr(error, "detail"):
                raise self._convert(error) from None
            raise

    def get_bytes(self, path, timeout=300):
        try:
            return self.rs.call_bytes(path, timeout=timeout)
        except Exception as error:  # noqa: BLE001
            if hasattr(error, "status") and hasattr(error, "detail"):
                raise self._convert(error) from None
            raise


def _guard():
    if not runtime.ready():
        raise HTTPException(503, "Подсистема «Калькулятор» на этом сервере не запущена (старая версия, не Python 3.12 или сбой запуска)")


def _summary(report, assets, blobs, sizes):
    total = sum(sizes.get(("asset", a), 0) for a in assets) + sum(sizes.get(("blob", b), 0) for b in blobs)
    return {"report": report, "assets_needed": len(assets), "blobs_needed": len(blobs), "size_bytes": total, "size_text": size_text(total) if total else "0 КБ"}


def plan(session, direction, user_id, connection_id):
    """Сверка калькулятора. Возвращает сводку и сохраняет план под `plan_id` для применения."""
    _guard()
    settings = runtime.settings()
    remote = SessionRemote(session)
    log = []
    if direction == "send":
        ctx = prepare_push(settings, remote, log.append)
        pk = ctx["package"]
        sizes = {("asset", a["path"]): a["size"] for a in pk["assets"]}
        sizes.update({("blob", b["sha256"]): b["size"] for b in pk["blobs"]})
        out = _summary(ctx["plan"]["report"], ctx["plan"]["assetsNeeded"], ctx["plan"]["blobsNeeded"], sizes)
    else:
        package = remote.call("GET", "/calc/api/sync/export", timeout=900)
        staging = Staging(Path(settings.data_dir) / "sync-staging")
        conn = connect(settings.database_path)
        try:
            conn.execute("BEGIN")
            try:
                report = apply_package(conn, package, str(user_id), dry_run=True)
                assets, blobs = needed(package, calc_assets_dir(), staging, conn)
            except SyncError as error:
                raise HTTPException(error.status, str(error))
            finally:
                conn.rollback()
        finally:
            conn.close()
        sizes = {("asset", a["path"]): a["size"] for a in package.get("assets", [])}
        sizes.update({("blob", b["sha256"]): b["size"] for b in package.get("blobs", [])})
        ctx = {"package": package, "assets": assets, "blobs": blobs}
        out = _summary(report, assets, blobs, sizes)
    plan_id = uuid4().hex
    with _LOCK:
        for k in [k for k, v in _PLANS.items() if time.time() - v["created"] > 6 * 3600]:
            _PLANS.pop(k, None)
        _PLANS[plan_id] = {"ctx": ctx, "direction": direction, "user_id": user_id, "connection_id": connection_id, "created": time.time()}
    out["plan_id"] = plan_id
    return out


def _result_text(result):
    products = (result.get("report") or {}).get("products") or {}
    skipped = len(products.get("serverPriority") or [])
    return "изделий создано %s, обновлено %s, без изменений %s%s; вложений добавлено %s" % (
        products.get("created", 0), products.get("updated", 0), products.get("unchanged", 0),
        (", пропущено (приоритет принимающего сервера) %d" % skipped) if skipped else "", (result.get("report") or {}).get("attachmentsAdded", 0))


def start(session, plan_id, direction, user_id):
    """Фоновая передача/приём по ранее сохранённому плану."""
    _guard()
    with _LOCK:
        pl = _PLANS.get(plan_id)
        if pl is None or pl["user_id"] != user_id or pl["direction"] != direction:
            raise HTTPException(404, "План калькулятора не найден — выполните сверку заново")
        if any(j["state"] == "running" for j in _JOBS.values()):
            raise HTTPException(409, "Передача калькулятора уже выполняется")
        job_id = uuid4().hex
        job = _JOBS[job_id] = {"id": job_id, "state": "running", "message": "Старт", "sent": 0, "total": 0, "log": [], "user_id": user_id}
    settings = runtime.settings()
    remote = SessionRemote(session)

    def note(text):
        job["log"].append(text)
        job["message"] = text

    def work():
        try:
            if direction == "send":
                result = finish_push(settings, remote, pl["ctx"], _Progress(job), note)
            else:
                result = _run_receive(settings, remote, pl["ctx"], job, note, user_id)
            job["summary"] = _result_text(result)
            job["state"] = "done"
        except Exception as error:  # noqa: BLE001
            job["state"], job["error"] = "failed", str(getattr(error, "detail", None) or error)
        finally:
            with _LOCK:
                _PLANS.pop(plan_id, None)

    threading.Thread(target=work, name="calc-exchange-" + direction, daemon=True).start()
    return job_id


class _Progress(dict):
    """`finish_push` пишет в job['progress'] = {sent, total}; здесь это превращается в плоские поля задачи."""

    def __init__(self, job):
        super().__init__()
        self.job = job

    def __setitem__(self, key, value):
        if key == "progress":
            self.job["sent"], self.job["total"] = value["sent"], value["total"]
        elif key == "result":
            self.job["result"] = value
        super().__setitem__(key, value)


def _run_receive(settings, remote, ctx, job, note, user_id):
    package = ctx["package"]
    staging = Staging(Path(settings.data_dir) / "sync-staging")
    uploads = Path(settings.data_dir) / "uploads"
    sizes = {a["path"]: (a["size"], a["sha256"]) for a in package.get("assets", [])}
    blob_sizes = {b["sha256"]: b["size"] for b in package.get("blobs", [])}
    total = sum(sizes[p][0] for p in ctx["assets"]) + sum(blob_sizes[s] for s in ctx["blobs"])
    job["total"] = total
    got = [0]

    def download(kind, key, size, sha):
        offset = 0
        if size == 0:
            staging.write_chunk(kind, key, sha, 0, 0, b"")
            return
        while offset < size:
            query = "/calc/api/sync/download?kind=%s&key=%s&offset=%d&length=%d" % (kind, urllib.parse.quote(key, safe=""), offset, CHUNK)
            data = remote.get_bytes(query, timeout=600)
            if not data:
                raise SyncError("Другой сервер не отдал файл %s" % key)
            staging.write_chunk(kind, key, sha, size, offset, data)
            offset += len(data)
            got[0] += len(data)
            job["sent"] = got[0]

    for sha in ctx["blobs"]:
        note("Вложение %s…" % sha[:12])
        download("blob", sha, blob_sizes[sha], sha)
    for path in ctx["assets"]:
        note("Файл исходников %s…" % path)
        download("asset", path, sizes[path][0], sizes[path][1])
    note("Применение…")
    result = commit_package(settings, staging, calc_assets_dir(), uploads, package, None, str(user_id))
    note("Готово")
    return result


def job_state(job_id, user_id):
    job = _JOBS.get(job_id)
    if job is None or job["user_id"] != user_id:
        raise HTTPException(404, "Задача не найдена")
    return {k: job.get(k) for k in ("id", "state", "message", "sent", "total", "summary", "error")}

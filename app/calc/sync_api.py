"""HTTP-слой обмена: приём пакета по токену роли «Калькулятор» и отправка на цели.

Приём (любой экземпляр):  plan → upload × N → commit.
Отправка (экземпляр с целями): POST /push — фоновая задача, ход читается опросом.

Связь с тестовым и боевым серверами возможна только из-под VPN: отправку
запускает человек со своей машины (см. Docs/calc-sync.md). Токены целей хранятся
в переменных окружения или файле с правами 600, в БД они не попадают.
"""
import hashlib
import json
import os
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.access import assert_feature, has_feature, is_system_admin
from app.auth import SESSION_COOKIE, get_current_user
from app.db import get_connection
from app.features import READ, WRITE

from . import auth, runtime
from .database import PROJECT_ID, audit, connect, dumps, now, transaction
from .sync import CHUNK, SyncError, Staging, apply_package, asset_manifest, collect_package, file_sha256, install_assets, needed

_COMMIT_LOCK = threading.Lock()


# ------------------------------------------------------------------ доступ
def _token_actor(settings, token):
    digest = hashlib.sha256(token.encode()).hexdigest()
    conn = connect(settings.database_path)
    try:
        row = conn.execute("SELECT * FROM sync_tokens WHERE token_hash=? AND revoked_at IS NULL", (digest,)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise HTTPException(401, "Токен обмена недействителен или отозван")
    zconn = get_connection()
    try:
        user = zconn.execute("SELECT * FROM users WHERE id=?", (int(row["user_id"]),)).fetchone()
        if user is None:
            raise HTTPException(401, "Пользователь токена удалён")
        if not has_feature(zconn, user, "calc_sync", WRITE):
            raise HTTPException(403, "У владельца токена нет права «Обмен данными калькулятора» (роль «Калькулятор»)")
    finally:
        zconn.close()
    with transaction(settings.database_path) as c:
        c.execute("UPDATE sync_tokens SET last_used_at=? WHERE id=?", (now(), row["id"]))
    return {"id": "token:%s" % row["id"], "login": user["domain_login"], "token": True, "admin": is_system_admin(user)}


def make_actor_dependency(settings, need):
    def dependency(request: Request):
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            return _token_actor(settings, header[7:].strip())
        user = get_current_user(request)
        conn = get_connection()
        try:
            assert_feature(conn, user, "calc_sync", need)
            admin = is_system_admin(user)
        finally:
            conn.close()
        if request.method not in {"GET", "HEAD"}:
            csrf = auth.csrf_for(request)
            if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), csrf):
                raise HTTPException(403, "Обновите страницу: токен защиты формы не совпадает")
        return {"id": str(user["id"]), "login": user["domain_login"], "token": False, "admin": admin}
    return dependency


# ------------------------------------------------------------------ цели отправки
TARGET_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,19}$")


class Target:
    def __init__(self, name, cfg, secret=None):
        self.name = name
        self.url = cfg["url"].rstrip("/")
        parts = urlsplit(self.url)
        local = parts.hostname in {"localhost", "127.0.0.1", "::1"}
        if parts.scheme != "https" and not (parts.scheme == "http" and local):
            raise ValueError("Цель %s: адрес должен быть https (http допустим только для localhost)" % name)
        self.token_env = cfg.get("tokenEnv")
        self.token_file = cfg.get("tokenFile")
        self.ca_file = cfg.get("caFile")
        self.secret = secret
        self.require_confirm = bool(cfg.get("requireConfirm", name == "prod"))

    def token(self):
        if self.secret:  # введён в окне «Передача на серверы» (data/calc/sync-secrets.json, права 600)
            return self.secret
        if self.token_env and os.environ.get(self.token_env):
            return os.environ[self.token_env].strip()
        if self.token_file:
            path = Path(self.token_file).expanduser()
            if path.is_file():
                if path.stat().st_mode & 0o077:
                    raise ValueError("Файл токена %s доступен другим пользователям: chmod 600" % path)
                return path.read_text().strip()
        return None

    def public(self):
        return {"name": self.name, "url": self.url, "requireConfirm": self.require_confirm, "tokenConfigured": bool(self._safe_token()),
                "caFile": self.ca_file, "tokenFromUi": bool(self.secret)}

    def _safe_token(self):
        try:
            return self.token()
        except ValueError:
            return None


def _targets_path(settings):
    return Path(settings.data_dir) / "sync-targets.json"


def _secrets_path(settings):
    return Path(settings.data_dir) / "sync-secrets.json"


def _read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _write_json(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=1)
    os.replace(temporary, path)
    os.chmod(path, mode)


def load_targets(settings):
    config = _read_json(_targets_path(settings))
    secrets_ = _read_json(_secrets_path(settings))
    return {name: Target(name, cfg, secrets_.get(name)) for name, cfg in config.get("targets", {}).items()}


def save_target(settings, name, url, token, require_confirm, ca_file):
    if not TARGET_NAME.match(name or ""):
        raise HTTPException(422, "Название цели: латиница, цифры, «-» и «_», до 20 знаков (например test, prod)")
    url = (url or "").strip()
    try:
        Target(name, {"url": url})
    except (ValueError, KeyError) as error:
        raise HTTPException(422, str(error) if isinstance(error, ValueError) else "Укажите адрес сервера") from None
    ca_file = (ca_file or "").strip() or None
    if ca_file and not Path(ca_file).expanduser().is_file():
        raise HTTPException(422, "Файл сертификата не найден: %s" % ca_file)
    config = _read_json(_targets_path(settings))
    previous = config.setdefault("targets", {}).get(name, {})
    entry = {k: v for k, v in previous.items() if k in {"tokenEnv", "tokenFile"}}
    entry.update({"url": url.rstrip("/"), "requireConfirm": bool(require_confirm), "caFile": ca_file})
    config["targets"][name] = entry
    _write_json(_targets_path(settings), config, 0o644)
    token = (token or "").strip()
    if token:
        if not token.startswith("czb_") or len(token) > 200 or not token.isascii():
            raise HTTPException(422, "Токен приёма начинается с «czb_»: скопируйте его целиком из окна «Токены приёма» на принимающем сервере")
        secrets_ = _read_json(_secrets_path(settings))
        secrets_[name] = token
        _write_json(_secrets_path(settings), secrets_, 0o600)


def delete_target(settings, name):
    config = _read_json(_targets_path(settings))
    if name not in config.get("targets", {}):
        raise HTTPException(404, "Цель не найдена")
    del config["targets"][name]
    _write_json(_targets_path(settings), config, 0o644)
    secrets_ = _read_json(_secrets_path(settings))
    if secrets_.pop(name, None) is not None:
        _write_json(_secrets_path(settings), secrets_, 0o600)


class Remote:
    """Минимальный HTTP-клиент удалённого сервера (urllib: без новых зависимостей)."""

    def __init__(self, target):
        token = target.token()
        if not token:
            raise ValueError("Токен цели «%s» не задан: переменная %s или tokenFile" % (target.name, target.token_env))
        self.base = target.url
        self.token = token
        self.context = ssl.create_default_context(cafile=target.ca_file) if target.ca_file else ssl.create_default_context()

    def call(self, method, path, body=None, content_type="application/json", timeout=300):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Authorization": "Bearer " + self.token, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=self.context) as response:
                return json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as error:
            raw = error.read().decode(errors="replace")
            try:
                detail = json.loads(raw)
            except ValueError:
                detail = {"detail": raw[:500]}
            raise RemoteError(error.code, detail) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            raise RemoteError(0, {"detail": "Нет связи с сервером (VPN включён?): %s" % getattr(error, "reason", error)}) from None


class RemoteError(Exception):
    def __init__(self, status, detail):
        super().__init__("%s: %s" % (status, detail.get("detail") if isinstance(detail, dict) else detail))
        self.status = status
        self.detail = detail


def upload_file(remote, kind, key, path, sha256, progress=None):
    size = Path(path).stat().st_size
    offset = 0
    with Path(path).open("rb") as stream:
        while True:
            stream.seek(offset)
            chunk = stream.read(CHUNK)
            if not chunk and size:
                break
            query = "/calc/api/sync/upload?kind=%s&key=%s&sha256=%s&size=%d&offset=%d" % (kind, urllib.request.quote(key, safe=""), sha256, size, offset)
            for attempt in range(4):
                try:
                    remote.call("PUT", query, chunk, "application/octet-stream", timeout=600)
                    break
                except RemoteError as error:
                    if error.status == 409 and isinstance(error.detail, dict) and "received" in error.detail:
                        offset = error.detail["received"]  # сервер уже принял больше: продолжаем с его позиции
                        stream.seek(offset)
                        chunk = None
                        break
                    if error.status in {0, 502, 503, 504} and attempt < 3:
                        time.sleep(2 ** attempt)
                        continue
                    raise
            if chunk is None:
                continue
            offset += len(chunk)
            if progress:
                progress(len(chunk))
            if offset >= size:
                break


JOBS = {}
_JOBS_LOCK = threading.Lock()


def run_push(settings, target, dry_run, job):
    def note(text):
        job["log"].append(text)
        job["message"] = text

    conn = connect(settings.database_path)
    try:
        from .document_models import ASSETS
        package = collect_package(conn, ASSETS, Path(settings.data_dir) / "uploads")
        blob_paths = {}
        for blob in package["blobs"]:
            row = conn.execute("SELECT storage_name FROM project_files WHERE sha256=? LIMIT 1", (blob["sha256"],)).fetchone()
            blob_paths[blob["sha256"]] = Path(settings.data_dir) / "uploads" / row["storage_name"]
    finally:
        conn.close()
    note("Пакет собран: изделий %d, файлов исходников %d, вложений %d" % (len(package["products"]), len(package["assets"]), len(package["blobs"])))
    remote = Remote(target)
    note("Согласование с сервером «%s»…" % target.name)
    plan = remote.call("POST", "/calc/api/sync/plan", package)
    job["plan"] = plan
    note("Нужно передать: файлов исходников %d, вложений %d" % (len(plan["assetsNeeded"]), len(plan["blobsNeeded"])))
    if dry_run:
        job["result"] = {"dryRun": True, **plan}
        return
    sizes = {a["path"]: a["size"] for a in package["assets"]}
    total = sum(sizes[p] for p in plan["assetsNeeded"]) + sum(next(b["size"] for b in package["blobs"] if b["sha256"] == s) for s in plan["blobsNeeded"])
    sent = [0]

    def progress(n):
        sent[0] += n
        job["progress"] = {"sent": sent[0], "total": total}

    job["progress"] = {"sent": 0, "total": total}
    for sha in plan["blobsNeeded"]:
        note("Вложение %s…" % sha[:12])
        upload_file(remote, "blob", sha, blob_paths[sha], sha, progress)
    from .document_models import ASSETS
    hashes = {a["path"]: a["sha256"] for a in package["assets"]}
    for relative in plan["assetsNeeded"]:
        note("Файл исходников %s…" % relative)
        upload_file(remote, "asset", relative, Path(ASSETS) / relative, hashes[relative], progress)
    note("Применение на сервере…")
    result = remote.call("POST", "/calc/api/sync/commit", package, timeout=900)
    job["result"] = result
    note("Готово")


def _log(settings, direction, target, actor, status, summary, started):
    with transaction(settings.database_path) as conn:
        conn.execute("INSERT INTO sync_log(direction,target,actor_id,started_at,finished_at,status,summary_json) VALUES(?,?,?,?,?,?,?)",
                     (direction, target, actor, started, now(), status, dumps(summary)))


# ------------------------------------------------------------------ маршруты
def build_sync_router(settings):
    router = APIRouter(prefix="/calc/api/sync", dependencies=[Depends(runtime.require_ready)])
    read = make_actor_dependency(settings, READ)
    write = make_actor_dependency(settings, WRITE)
    staging = Staging(Path(settings.data_dir) / "sync-staging")
    uploads = Path(settings.data_dir) / "uploads"

    def assets_dir():
        from .document_models import ASSETS
        return Path(ASSETS)

    def fail(error):
        return JSONResponse({"detail": str(error), **error.extra}, status_code=error.status)

    def blob_sources(package, conn):
        found = {}
        for blob in package.get("blobs", []):
            sha = blob["sha256"]
            if staging.received("blob", sha):
                found[sha] = staging.done("blob", sha)
                continue
            row = conn.execute("SELECT storage_name FROM project_files WHERE sha256=? LIMIT 1", (sha,)).fetchone()
            if row and (uploads / row["storage_name"]).is_file():
                found[sha] = uploads / row["storage_name"]
        return found

    @router.get("/state")
    def state(actor=Depends(read)):
        conn = connect(settings.database_path)
        try:
            log = [dict(r) for r in conn.execute("SELECT id,direction,target,actor_id,started_at,finished_at,status,summary_json FROM sync_log ORDER BY id DESC LIMIT 10")]
            project = conn.execute("SELECT zhbi_project_id,zhbi_project_name FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
        finally:
            conn.close()
        try:
            targets = [t.public() for t in load_targets(settings).values()]
            error = None
        except Exception as e:  # noqa: BLE001
            targets, error = [], "sync-targets.json: %s" % e
        return {"targets": targets, "targetsError": error, "log": log, "assetsPresent": assets_dir().is_dir() and any(assets_dir().iterdir()),
                "project": dict(project) if project else None, "canAdminister": actor["admin"]}

    @router.post("/plan")
    async def plan(request: Request, actor=Depends(write)):
        package = await request.json()
        conn = connect(settings.database_path)
        try:
            conn.execute("BEGIN")
            try:
                report = apply_package(conn, package, actor["id"], dry_run=True)
                assets, blobs = needed(package, assets_dir(), staging, conn)
            except SyncError as error:
                return fail(error)
            finally:
                conn.rollback()
        finally:
            conn.close()
        return {"report": report, "assetsNeeded": assets, "blobsNeeded": blobs}

    @router.put("/upload")
    async def upload(request: Request, kind: str, key: str, sha256: str, size: int, offset: int, actor=Depends(write)):
        data = await request.body()
        try:
            received = staging.write_chunk(kind, key, sha256, size, offset, data)
        except SyncError as error:
            return fail(error)
        return {"received": received, "complete": received == size}

    @router.post("/commit")
    async def commit(request: Request, actor=Depends(write)):
        package = await request.json()
        started = now()
        if not _COMMIT_LOCK.acquire(blocking=False):
            raise HTTPException(409, "На сервере уже выполняется другой приём пакета")
        try:
            conn = connect(settings.database_path)
            try:
                missing_assets, missing_blobs = needed(package, assets_dir(), staging, conn)
                if missing_assets or missing_blobs:
                    return JSONResponse({"detail": "Не все файлы переданы", "assetsNeeded": missing_assets, "blobsNeeded": missing_blobs}, status_code=409)
                sources = blob_sources(package, conn)
            finally:
                conn.close()
            try:
                with transaction(settings.database_path) as conn:
                    report = apply_package(conn, package, actor["id"], staged_blobs=sources, uploads_dir=uploads)
                    audit(conn, actor["id"], "sync.received", PROJECT_ID, {"products": {k: (len(v) if isinstance(v, list) else v) for k, v in report["products"].items()}})
                updated_assets = install_assets(assets_dir(), staging, package.get("assets", []))
            except SyncError as error:
                _log(settings, "receive", None, actor["id"], "error", {"error": str(error)}, started)
                return fail(error)
            if updated_assets:
                from .commercial_references import reference_catalog
                from .document_models import catalog
                catalog.cache_clear()
                from . import collisions
                collisions.clear_cache()
                reference_catalog.cache_clear()
                with transaction(settings.database_path) as conn:
                    from .discrepancies import sync_catalog_issues
                    from .norms import get_norms
                    sync_catalog_issues(conn)
                    try:
                        get_norms(conn)
                    except (FileNotFoundError, KeyError):
                        pass  # каталог моделей в пакете не пришёл: нормы заведутся при следующей отправке
            for sha in {b["sha256"] for b in package.get("blobs", [])}:
                staging.done("blob", sha).unlink(missing_ok=True)
            result = {"report": report, "assetsUpdated": updated_assets}
            _log(settings, "receive", None, actor["id"], "ok", result, started)
            return result
        finally:
            _COMMIT_LOCK.release()

    # -------- отправка
    @router.post("/push")
    def push(body: dict, actor=Depends(write)):
        try:
            targets = load_targets(settings)
        except Exception as error:  # noqa: BLE001
            raise HTTPException(500, "sync-targets.json: %s" % error)
        name = body.get("target")
        if name not in targets:
            raise HTTPException(404, "Цель не настроена")
        target = targets[name]
        dry = bool(body.get("dryRun", True))
        if not dry and target.require_confirm and body.get("confirm") != target.name:
            raise HTTPException(422, "Отправка на «%s» требует подтверждения: введите имя цели" % target.name)
        with _JOBS_LOCK:
            if any(j["state"] == "running" for j in JOBS.values()):
                raise HTTPException(409, "Отправка уже выполняется")
            job_id = str(uuid4())
            job = JOBS[job_id] = {"id": job_id, "target": name, "dryRun": dry, "state": "running", "message": "Старт", "log": [], "startedAt": now()}

        def work():
            try:
                run_push(settings, target, dry, job)
                job["state"] = "done"
                if not dry:
                    _log(settings, "send", name, actor["id"], "ok", job.get("result", {}), job["startedAt"])
            except Exception as error:  # noqa: BLE001
                job["state"] = "failed"
                job["error"] = str(error)
                _log(settings, "send", name, actor["id"], "error", {"error": str(error), "dryRun": dry}, job["startedAt"])
        threading.Thread(target=work, name="calc-sync-push", daemon=True).start()
        return {"jobId": job_id}

    @router.get("/push/{job_id}")
    def push_state(job_id: str, actor=Depends(read)):
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Задача не найдена")
        return job

    # -------- токены (только администратор сервиса)
    def admin_only(actor=Depends(write)):
        if actor["token"] or not actor["admin"]:
            raise HTTPException(403, "Токены выдаёт администратор сервиса")
        return actor

    @router.put("/targets/{name}")
    def put_target(name: str, body: dict, actor=Depends(admin_only)):
        save_target(settings, name, body.get("url"), body.get("token"), body.get("requireConfirm", name == "prod"), body.get("caFile"))
        with transaction(settings.database_path) as conn:
            audit(conn, actor["id"], "sync.target.saved", name, {"url": body.get("url")})
        return {"targets": [t.public() for t in load_targets(settings).values()]}

    @router.delete("/targets/{name}")
    def remove_target(name: str, actor=Depends(admin_only)):
        delete_target(settings, name)
        with transaction(settings.database_path) as conn:
            audit(conn, actor["id"], "sync.target.deleted", name)
        return {"targets": [t.public() for t in load_targets(settings).values()]}

    @router.post("/targets/{name}/test")
    def test_target(name: str, actor=Depends(admin_only)):
        """Проверка связи: адрес, VPN, сертификат, токен и право «Калькулятор» на принимающей стороне. Ничего не передаёт."""
        target = load_targets(settings).get(name)
        if target is None:
            raise HTTPException(404, "Цель не найдена")
        try:
            info = Remote(target).call("GET", "/calc/api/sync/state", timeout=20)
        except ValueError as error:
            return {"ok": False, "message": str(error)}
        except RemoteError as error:
            hints = {0: "Нет связи с сервером (включён ли VPN, верен ли адрес, доверяется ли сертификат?): ",
                     401: "Токен не принят принимающим сервером (неверный, отозван или принадлежит удалённому пользователю): ",
                     403: "У владельца токена нет права «Обмен данными калькулятора» (нужна роль «Калькулятор»): ",
                     404: "Подсистема «Калькулятор» на сервере не подключена (старая версия или не Python 3.12): ",
                     503: "Подсистема на сервере не запущена: "}
            return {"ok": False, "message": hints.get(error.status, "Ошибка %s: " % error.status) + str(error.detail.get("detail", "") if isinstance(error.detail, dict) else error.detail)}
        project = (info.get("project") or {}).get("zhbi_project_name")
        return {"ok": True, "message": "Связь есть. Проект на сервере: %s. Источники на сервере: %s." % (project or "не привязан", "есть" if info.get("assetsPresent") else "ещё не переданы")}

    @router.get("/tokens")
    def tokens(actor=Depends(admin_only)):
        conn = connect(settings.database_path)
        try:
            return [dict(r) for r in conn.execute("SELECT id,name,user_id,created_at,revoked_at,last_used_at FROM sync_tokens ORDER BY created_at DESC")]
        finally:
            conn.close()

    @router.post("/tokens", status_code=201)
    def create_token(body: dict, actor=Depends(admin_only)):
        return issue_token(settings, str(body.get("login", "")).strip(), str(body.get("name", "")).strip(), actor["id"])

    @router.delete("/tokens/{token_id}")
    def revoke_token(token_id: str, actor=Depends(admin_only)):
        with transaction(settings.database_path) as conn:
            n = conn.execute("UPDATE sync_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now(), token_id)).rowcount
            if not n:
                raise HTTPException(404, "Токен не найден")
            audit(conn, actor["id"], "sync.token.revoked", token_id)
        return {"ok": True}

    return router


def issue_token(settings, login, name, created_by):
    if not login or not name or len(name) > 80:
        raise HTTPException(422, "Нужны логин пользователя и название токена")
    zconn = get_connection()
    try:
        user = zconn.execute("SELECT * FROM users WHERE domain_login = ?", (login,)).fetchone()
        if user is None:
            raise HTTPException(404, "Пользователь не найден")
        if not has_feature(zconn, user, "calc_sync", WRITE):
            raise HTTPException(422, "У пользователя нет права «Обмен данными калькулятора»: выдайте ему роль «Калькулятор»")
        user_id = str(user["id"])
    finally:
        zconn.close()
    token = "czb_" + secrets.token_urlsafe(40)
    identifier = str(uuid4())
    with transaction(settings.database_path) as conn:
        conn.execute("INSERT INTO sync_tokens(id,name,user_id,token_hash,created_by,created_at) VALUES(?,?,?,?,?,?)",
                     (identifier, name, user_id, hashlib.sha256(token.encode()).hexdigest(), created_by, now()))
        audit(conn, created_by, "sync.token.created", identifier, {"login": login, "name": name})
    return {"id": identifier, "token": token, "note": "Токен показывается один раз; сохраните его в переменной окружения цели."}

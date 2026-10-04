"""Подробный ход обработки чертежей нейросетью: журнал событий задания и «живой» снимок текущего запроса.

Всё пишется в базу (а не в память процесса): обработчик может работать отдельным процессом (CLI), а страница читает состояние через API.
Журнал — recovery_events (до 600 записей на задание, старые удаляются), снимок — recovery_live (одна строка на задание, пишется не чаще
раза в секунду)."""
import json
import time

from .database import dumps, now, transaction

MAX_EVENTS = 600


class Trace:
    def __init__(self, settings, job, model="", url="", sheets_total=0):
        self.settings, self.job = settings, job
        self.started = time.time()
        self.state = {"job": job, "model": model, "url": url, "phase": "prepare", "phaseLabel": "Подготовка", "sheetIndex": 0, "sheetsTotal": sheets_total,
                      "sheetLabel": "", "factsTotal": 0, "requestsDone": 0, "startedAt": self.started, "request": None}
        self._written = 0.0

    # --- журнал
    def note(self, text, level="info", **data):
        try:
            with transaction(self.settings.database_path) as conn:
                conn.execute("INSERT INTO recovery_events(job_id,ts,level,text,data_json) VALUES(?,?,?,?,?)", (self.job, now(), level, text, dumps(data) if data else None))
                conn.execute("DELETE FROM recovery_events WHERE job_id=? AND id<=(SELECT id FROM recovery_events WHERE job_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)", (self.job, self.job, MAX_EVENTS))
        except Exception:  # noqa: BLE001 — журнал вспомогательный и не должен ронять обработку
            pass

    # --- снимок
    def update(self, force=False, **fields):
        self.state.update(fields)
        self.state["updatedAt"] = time.time()
        if not force and time.time() - self._written < 1.0:
            return
        self._written = time.time()
        try:
            with transaction(self.settings.database_path) as conn:
                conn.execute("INSERT INTO recovery_live VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
                             (self.job, dumps(self.state), now()))
        except Exception:  # noqa: BLE001
            pass

    def phase(self, phase, label, **fields):
        self.update(True, phase=phase, phaseLabel=label, **fields)

    # --- запрос к модели
    def request_start(self, kind, attempt, attempts, max_tokens, images, prompt_chars):
        self.state["request"] = {"kind": kind, "attempt": attempt, "attempts": attempts, "maxTokens": max_tokens, "images": images, "promptChars": prompt_chars,
                                 "state": "connecting", "startedAt": time.time(), "deltas": 0, "reasoningDeltas": 0, "chars": 0, "sinceLast": 0.0, "elapsed": 0.0}
        self.update(True)

    def progress(self, info):
        """Колбэк потокового чтения (qwen_client.chat): info = state/elapsed/sinceLast/deltas/reasoningDeltas/chars."""
        request = self.state.get("request")
        if request is None:
            return
        previous = request["state"]
        request.update(info)
        if info.get("state") == "generating" and "firstTokenAt" not in request:
            request["firstTokenAt"] = info.get("elapsed", 0)
        if info.get("state") != previous:
            labels = {"waiting_first_token": "запрос принят сервером нейросети, ждём первый токен (модель может загружаться в память)",
                      "generating": "модель отвечает"}
            if info["state"] in labels:
                self.note(labels[info["state"]] + " · %.0f с" % info.get("elapsed", 0), "info")
        self.update(info.get("state") != previous)

    def request_end(self, ok, summary):
        request = self.state.get("request") or {}
        self.state["requestsDone"] = self.state.get("requestsDone", 0) + 1
        self.state["lastRequest"] = {**{k: request.get(k) for k in ("kind", "elapsed", "deltas", "maxTokens")}, "ok": ok, "summary": summary}
        self.state["request"] = None
        self.update(True)

    def finish(self, text, level="info"):
        self.note(text, level)
        self.update(True, phase="done" if level != "error" else "failed", phaseLabel=text, request=None)


def snapshot(conn, job):
    row = conn.execute("SELECT snapshot_json,updated_at FROM recovery_live WHERE job_id=?", (str(job),)).fetchone()
    if not row:
        return None
    state = json.loads(row["snapshot_json"])
    state["serverNow"] = time.time()
    request = state.get("request")
    if request:  # свежесть вычисляется по времени чтения, а не записи: между записями прошло до секунды
        request["elapsed"] = max(request.get("elapsed", 0), state["serverNow"] - request["startedAt"])
    return state


def events(conn, job, after=0, limit=250):
    rows = conn.execute("SELECT id,ts,level,text,data_json FROM recovery_events WHERE job_id=? AND id>? ORDER BY id DESC LIMIT ?", (str(job), after, limit)).fetchall()
    return [{"id": r["id"], "ts": r["ts"], "level": r["level"], "text": r["text"], "data": json.loads(r["data_json"]) if r["data_json"] else None} for r in reversed(rows)]

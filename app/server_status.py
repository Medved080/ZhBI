"""Показатели сервера («Администрирование → Состояние сервера», 2026-10-20).

Что показывает: загрузку процессора, объём доступной оперативной памяти и свободное место на дисках той машины
(виртуального сервера), на которой работает сервис. Нужен администратору сервиса, у которого нет SSH-доступа с командами
`top`/`free`/`df`: вопрос «сервер тормозит — это процессор, память или кончился диск» должен решаться глазами, внутри сервиса.

**Только стандартная библиотека.** `psutil` не используется сознательно: это новый сторонний пакет в образе контейнера ради
трёх чисел, а сами числа на целевой ОС (Linux, образ `python:3.12-slim`) лежат в `/proc`. На машине разработчика (macOS) тех
же файлов нет — там память и процессор берутся из `sysctl`/`vm_stat`/`top`; это запасной путь для отладки, не целевой.

**Контейнер.** `/proc/stat` и `/proc/meminfo` внутри Docker показывают ВИРТУАЛЬНЫЙ СЕРВЕР целиком, а не контейнер, — это ровно то,
что спрашивали («показатели виртуального сервера, на котором размещён сервис»). Если у контейнера задан свой предел памяти
(cgroup), он показывается отдельной строкой: до него сервис упрётся раньше, чем в память машины.

**Загрузка процессора** считается как доля неидлового времени между двумя снимками `/proc/stat`. Снимок хранится в памяти
процесса: опрос раз в несколько секунд даёт среднее за это окно, а первый (или слишком близкий к предыдущему) делает короткую
выборку сам. История для графика копится в браузере — на сервере её нет, чтобы не заводить фоновый поток ради экрана, который
открывают раз в месяц.

Только чтение. Каждый опрос в журнал действий НЕ пишется (экран обновляется сам раз в несколько секунд — журнал бы
захлебнулся); в журнал попадает только открытие экрана (`server_status_open`, параметр `open=1`).
"""
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query

import app.activity as activity
import app.db as _db
from app.access import require_service_feature
from app.backups import BACKUP_DIR

router = APIRouter(tags=["server-status"])

# Пороги цвета: те же слова, что на экране копий («мало» / «критически мало»). Для процессора и памяти — доля занятого.
CPU_WARN, CPU_CRIT = 70.0, 90.0
MEM_WARN, MEM_CRIT = 80.0, 90.0       # доля ЗАНЯТОЙ памяти (без кэша: «доступно» = MemAvailable)
DISK_WARN_FREE, DISK_CRIT_FREE = 15.0, 5.0   # доля СВОБОДНОГО места тома

_LINUX = Path("/proc/stat").exists()
# Минимальное окно между двумя снимками процессора: короче — доля прыгает от шума округления тиков.
_MIN_WINDOW = 1.0
_QUICK_SAMPLE = 0.3

_lock = threading.Lock()
_last_cpu: Optional[tuple] = None     # (monotonic, total, idle)
_last_pct: Optional[float] = None


# ----------------------------------------------------------------- процессор

def _read_proc_stat() -> Optional[tuple]:
    """(всего тиков, тиков простоя) по строке `cpu` /proc/stat. idle+iowait — машина ничего не считает (iowait — ожидание диска)."""
    try:
        with open("/proc/stat", encoding="ascii") as f:
            first = f.readline().split()
    except OSError:
        return None
    if not first or first[0] != "cpu":
        return None
    vals = [int(x) for x in first[1:]]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    # guest и guest_nice уже входят в user и nice — в сумму их второй раз не берём
    total = sum(vals[:8])
    return total, idle


def _cpu_percent_linux() -> Optional[float]:
    """Загрузка процессора, %, за окно с прошлого опроса. None — не удалось прочитать /proc/stat."""
    global _last_cpu, _last_pct
    with _lock:
        now = time.monotonic()
        cur = _read_proc_stat()
        if cur is None:
            return None
        prev = _last_cpu
        if prev is None or now - prev[0] < _MIN_WINDOW:
            # Нет опорного снимка или он слишком свежий: берём короткую выборку сами (держа замок — параллельные опросы
            # не должны каждый спать свои 0.3 с и затирать друг другу опорную точку).
            if prev is None:
                time.sleep(_QUICK_SAMPLE)
                after = _read_proc_stat()
                if after is None:
                    return None
                prev, cur = (now, cur[0], cur[1]), after
                now = time.monotonic()
            else:
                return _last_pct
        d_total, d_idle = cur[0] - prev[1], cur[1] - prev[2]
        _last_cpu = (now, cur[0], cur[1])
        if d_total <= 0:
            return _last_pct
        _last_pct = round(max(0.0, min(100.0, 100.0 * (d_total - d_idle) / d_total)), 1)
        return _last_pct


def _cpu_percent_other() -> Optional[float]:
    """Запасной путь для отладки на macOS: строка `CPU usage` из `top -l 2` (первая выборка за всё время — берём вторую)."""
    try:
        out = subprocess.run(["top", "-l", "2", "-n", "0", "-s", "1"], capture_output=True, text=True, timeout=6).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.findall(r"CPU usage:.*?([\d.]+)% idle", out)
    return round(100.0 - float(m[-1]), 1) if m else None


# ----------------------------------------------------------------- память

def _memory_linux() -> Optional[dict]:
    """total/available по /proc/meminfo. `MemAvailable` — оценка ядра «сколько можно отдать без свопа», с учётом кэша."""
    info = {}
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                k, _, v = line.partition(":")
                parts = v.split()
                if parts:
                    info[k] = int(parts[0]) * 1024     # в файле килобайты
    except OSError:
        return None
    total = info.get("MemTotal")
    if not total:
        return None
    avail = info.get("MemAvailable")
    if avail is None:    # ядро старше 3.14: оценка по старинке
        avail = info.get("MemFree", 0) + info.get("Buffers", 0) + info.get("Cached", 0)
    return {"total": total, "available": min(avail, total),
            "swap_total": info.get("SwapTotal", 0), "swap_free": info.get("SwapFree", 0)}


def _memory_other() -> Optional[dict]:
    """Запасной путь для macOS: размер — sysctl hw.memsize, доступное — свободные + неактивные + «чистые» страницы vm_stat."""
    try:
        total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3).stdout.strip())
        vm = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    page = re.search(r"page size of (\d+) bytes", vm)
    page = int(page.group(1)) if page else 4096

    def pages(name):
        m = re.search(rf"{name}:\s+(\d+)\.", vm)
        return int(m.group(1)) if m else 0
    avail = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page
    return {"total": total, "available": min(avail, total), "swap_total": 0, "swap_free": 0}


def _read_int(path: str) -> Optional[int]:
    try:
        raw = Path(path).read_text(encoding="ascii").strip()
    except OSError:
        return None
    return int(raw) if raw.isdigit() else None


def _cgroup_memory() -> Optional[dict]:
    """Предел и расход памяти КОНТЕЙНЕРА (cgroup v2, затем v1). None — предела нет или он больше памяти машины."""
    limit = used = None
    raw = None
    try:
        raw = Path("/sys/fs/cgroup/memory.max").read_text(encoding="ascii").strip()
    except OSError:
        pass
    if raw is not None:
        limit = int(raw) if raw.isdigit() else None          # «max» — предела нет
        used = _read_int("/sys/fs/cgroup/memory.current")
    else:
        limit = _read_int("/sys/fs/cgroup/memory/memory.limit_in_bytes")
        used = _read_int("/sys/fs/cgroup/memory/memory.usage_in_bytes")
    if not limit or used is None:
        return None
    return {"limit": limit, "used": min(used, limit)}


# ----------------------------------------------------------------- диски

def _disks() -> list:
    """Тома, на которых лежат данные сервиса: база, копии, вложения и корень. Один том — одна строка (по `st_dev`)."""
    root = Path(__file__).resolve().parent.parent
    candidates = [("База данных", Path(_db.DB_PATH).parent), ("Копии", BACKUP_DIR),
                  ("Вложения", root / "uploads"), ("Система", Path(os.path.abspath(os.sep)))]
    out, seen = [], {}
    for label, path in candidates:
        # Папки может ещё не быть (ни одной загрузки) — меряем ближайшую существующую родительскую: том тот же.
        probe = path
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        try:
            dev = os.stat(probe).st_dev
            total, used, free = shutil.disk_usage(probe)
        except OSError:
            continue
        if dev in seen:
            seen[dev]["labels"].append(label)
            continue
        row = {"labels": [label], "path": str(probe), "total": total, "used": used, "free": free}
        seen[dev] = row
        out.append(row)
    for row in out:
        row["label"] = ", ".join(row.pop("labels"))
        row["free_percent"] = round(100.0 * row["free"] / row["total"], 1) if row["total"] else None
        row["level"] = _disk_level(row["free_percent"])
    return out


def _disk_level(free_percent: Optional[float]) -> str:
    if free_percent is None:
        return "unknown"
    if free_percent < DISK_CRIT_FREE:
        return "critical"
    if free_percent < DISK_WARN_FREE:
        return "warning"
    return "ok"


def _used_level(percent: Optional[float], warn: float, crit: float) -> str:
    if percent is None:
        return "unknown"
    return "critical" if percent >= crit else "warning" if percent >= warn else "ok"


# ----------------------------------------------------------------- сведения о машине

def _uptime_seconds() -> Optional[int]:
    try:
        return int(float(Path("/proc/uptime").read_text(encoding="ascii").split()[0]))
    except (OSError, ValueError, IndexError):
        return None


def _os_name() -> str:
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return f"{platform.system()} {platform.release()}".strip()


def collect() -> dict:
    """Один снимок показателей. Отдельно от маршрута — чтобы его можно было проверять без HTTP."""
    cpu = _cpu_percent_linux() if _LINUX else _cpu_percent_other()
    mem = (_memory_linux() if _LINUX else _memory_other())
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        load = None
    cores = os.cpu_count()

    memory = None
    if mem:
        used = mem["total"] - mem["available"]
        used_pct = round(100.0 * used / mem["total"], 1)
        memory = {"total_bytes": mem["total"], "available_bytes": mem["available"], "used_bytes": used,
                  "used_percent": used_pct, "level": _used_level(used_pct, MEM_WARN, MEM_CRIT),
                  "swap_total_bytes": mem["swap_total"], "swap_used_bytes": mem["swap_total"] - mem["swap_free"]}
        cg = _cgroup_memory() if _LINUX else None
        # Предел контейнера интересен, только если он ЖЁСТЧЕ памяти машины
        if cg and cg["limit"] < mem["total"]:
            pct = round(100.0 * cg["used"] / cg["limit"], 1)
            memory["container"] = {"limit_bytes": cg["limit"], "used_bytes": cg["used"], "used_percent": pct,
                                   "level": _used_level(pct, MEM_WARN, MEM_CRIT)}

    return {
        "time": time.time(),
        "host": {"name": platform.node(), "os": _os_name(), "uptime_seconds": _uptime_seconds(),
                 "python": platform.python_version()},
        "cpu": {"percent": cpu, "cores": cores, "load_average": load,
                "level": _used_level(cpu, CPU_WARN, CPU_CRIT),
                # Нагрузка выше числа ядер = очередь на процессор, даже когда мгновенная доля не пиковая
                "load_per_core": round(load[0] / cores, 2) if load and cores else None},
        "memory": memory,
        "disks": _disks(),
        "thresholds": {"cpu": [CPU_WARN, CPU_CRIT], "memory": [MEM_WARN, MEM_CRIT], "disk_free": [DISK_WARN_FREE, DISK_CRIT_FREE]},
        "source": "proc" if _LINUX else "fallback",
    }


@router.get("/admin/server-status")
def server_status(opened: int = Query(0, alias="open", description="1 — экран только что открыт (пишется в журнал один раз)"),
                  admin: sqlite3.Row = Depends(require_service_feature("server_status", "read"))):
    if opened:
        activity.log("server_status_open", user=admin, entity_type="server")
    return collect()

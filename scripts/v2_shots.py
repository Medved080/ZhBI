"""Снимки форм V2 в безголовом Chrome — на СТЕНДЕ (фейковые данные), не на реальном сервере.

Запуск: python3 scripts/v2_shots.py [--out КАТАЛОГ] [--sizes 1920x1080,1920x900,1366x768]
                                    [--scenes id,id,...] [--port 8031]
Требует запущенный стенд (`python3 scripts/v2_test_server.py`) и Google Chrome.
Ничего не открывает, кроме loopback-стенда; профиль Chrome — временный каталог.
Масштаб 100%, без zoom/transform: размер окна = размер viewport.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEFAULT_SIZES = ["1920x1080", "1920x900", "1366x768"]


def scene_ids(port):
    """Идентификаторы сцен — из scenes.js (простой разбор ключей SCENES)."""
    import re
    src = urllib.request.urlopen(f"http://127.0.0.1:{port}/tests/scenes.js", timeout=10).read().decode()
    ids = re.findall(r'^\s{2}"([a-z0-9-]+)": \{ title:', src, flags=re.M)
    try:
        cp = urllib.request.urlopen(f"http://127.0.0.1:{port}/tests/cp-scenes.js", timeout=10).read().decode()
        ids += re.findall(r'^\s{2}"([a-z0-9-]+)": \{ title:', cp, flags=re.M)
    except Exception:
        pass
    return ids


def shoot(port, scene, size, out_dir, profile):
    w, h = size.split("x")
    target = out_dir / f"{scene}_{size}.png"
    if target.exists():
        target.unlink()
    url = f"http://127.0.0.1:{port}/tests/app.html?scene={scene}"
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
           f"--user-data-dir={profile}", f"--window-size={w},{h}", "--virtual-time-budget=9000",
           f"--screenshot={target}", url]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        if target.exists() and target.stat().st_size > 0:
            time.sleep(0.7)  # файл дописан
            break
        time.sleep(0.3)
    try:
        os.killpg(proc.pid, 15)
    except ProcessLookupError:
        pass
    except PermissionError:  # в песочнице killpg запрещён — гасим сам процесс
        proc.terminate()
    proc.wait(timeout=10)
    return target.exists() and target.stat().st_size > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="v2-shots")
    ap.add_argument("--sizes", default=",".join(DEFAULT_SIZES))
    ap.add_argument("--scenes", default="")
    ap.add_argument("--port", type=int, default=8031)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scenes = [s for s in args.scenes.split(",") if s] or scene_ids(args.port)
    profile = tempfile.mkdtemp(prefix="v2-chrome-")
    failed = []
    try:
        for scene in scenes:
            for size in args.sizes.split(","):
                ok = shoot(args.port, scene, size, out, profile)
                print(("ok   " if ok else "FAIL ") + f"{scene} {size}", flush=True)
                if not ok:
                    failed.append((scene, size))
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    print(f"снимков: {len(scenes) * len(args.sizes.split(',')) - len(failed)}, ошибок: {len(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

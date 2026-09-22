"""Регрессия «Графика контрактации и поставки» без фильтра схемы: ответ сервера ДО и ПОСЛЕ правки
(`element_ids` в build_contracting_schedule) обязан совпасть побайтово.

Снимает ответы НАСТОЯЩЕГО сервера (scripts/real_auth_server.py, вход admin по паролю копии) на набор запросов
«объект × масштаб» без `element_ids` и с `element_ids: null` и пишет их в каталог: по файлу на запрос плюс
manifest.json (код ответа, размер, sha256). Сравнение двух снимков — режим compare.

  .venv/bin/python scripts/reports2_verify/contracting_regress.py dump http://127.0.0.1:8340 <каталог>
  .venv/bin/python scripts/reports2_verify/contracting_regress.py compare <каталог-до> <каталог-после>
"""
import hashlib
import json
import sys
from pathlib import Path

import requests

PASSWORD = "Test-Pass-1234!"
OBJECTS = (1, 2, 3)                     # 1 — 9580 изделий и 607 позиций контрактов, 2 — без контрактов, 3 — пустой
SCALES = ("day", "week", "month", "quarter", None, "bogus")


def dump(base: str, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    r = s.post(base + "/login", json={"domain_login": "admin", "password": PASSWORD})
    r.raise_for_status()
    manifest = {}
    for obj in OBJECTS:
        for scale in SCALES:
            for variant in ("absent", "null"):
                body = {"object_id": obj, "source_file": None}
                if scale is not None:
                    body["scale"] = scale
                if variant == "null":
                    body["element_ids"] = None
                key = f"o{obj}_{scale}_{variant}"
                resp = s.post(base + "/reports/contracting-schedule", json=body)
                (out / f"{key}.bin").write_bytes(resp.content)
                manifest[key] = {"status": resp.status_code, "size": len(resp.content),
                                 "sha256": hashlib.sha256(resp.content).hexdigest()}
                print(key, resp.status_code, len(resp.content))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    return 0


def compare(a: Path, b: Path) -> int:
    ma = json.loads((a / "manifest.json").read_text())
    mb = json.loads((b / "manifest.json").read_text())
    bad = 0
    for key in sorted(set(ma) | set(mb)):
        if ma.get(key) != mb.get(key):
            bad += 1
            print("РАЗЛИЧИЕ", key, ma.get(key), mb.get(key))
    print(f"сравнено ответов: {len(ma)}; совпали побайтово: {len(ma) - bad}; различий: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "dump":
        sys.exit(dump(sys.argv[2].rstrip("/"), Path(sys.argv[3])))
    sys.exit(compare(Path(sys.argv[2]), Path(sys.argv[3])))

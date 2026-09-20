"""Правка реестра экранов V2 (`app/static/v2/screens.json`) без ручного форматирования: файл хранится «один экран — одна строка».

    .venv/bin/python scripts/v2_screens_tool.py set ID [--status N] [--impl v1|read|module:X] [--checks ТЕКСТ] [--limits ТЕКСТ]
    .venv/bin/python scripts/v2_screens_tool.py list
Статус ставится только по фактически выполненным проверкам (правила приёмки, Docs/v2-interface-coverage.md)."""
import argparse
import json
import sys
from pathlib import Path

P = Path(__file__).resolve().parent.parent / "app" / "static" / "v2" / "screens.json"


def load():
    return json.loads(P.read_text(encoding="utf-8"))


def save(data):
    P.write_text('{\n "groups": ' + json.dumps(data["groups"], ensure_ascii=False) + ',\n "screens": [\n'
                 + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in data["screens"])
                 + '\n ],\n "ignore": ' + json.dumps(data.get("ignore", {}), ensure_ascii=False)
                 + (',\n "backlog": ' + json.dumps(data["backlog"], ensure_ascii=False) if data.get("backlog") else "") + "\n}\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("set")
    s.add_argument("id")
    s.add_argument("--status", type=int)
    s.add_argument("--impl")
    s.add_argument("--checks")
    s.add_argument("--limits")
    sub.add_parser("list")
    a = ap.parse_args()
    data = load()
    if a.cmd == "list":
        for x in data["screens"]:
            print(x["id"], x["status"], x["impl"], (x.get("checks") or "")[:60])
        return
    x = next((z for z in data["screens"] if z["id"] == a.id), None)
    if not x:
        sys.exit(f"нет экрана {a.id}")
    for k in ("status", "impl", "checks", "limits"):
        v = getattr(a, k)
        if v is not None:
            x[k] = v
    save(data)


if __name__ == "__main__":
    main()

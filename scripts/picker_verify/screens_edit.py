"""Правка screens.json с сохранением построчного формата файла (одна запись экрана — одна строка). Используется сценариями области picker."""
import json
import sys
from pathlib import Path

P = Path(__file__).resolve().parent.parent.parent / "app/static/v2/screens.json"


def load():
    return json.loads(P.read_text(encoding="utf-8"))


def dump(d):
    lines = ["{", ' "groups": ' + json.dumps(d["groups"], ensure_ascii=False) + ",", ' "screens": [']
    body = ["  " + json.dumps(s, ensure_ascii=False) for s in d["screens"]]
    lines.append(",\n".join(body))
    extra = [k for k in d if k not in ("groups", "screens")]
    lines.append(" ]" + ("," if extra else ""))
    for i, k in enumerate(extra):
        lines.append(f" {json.dumps(k)}: {json.dumps(d[k], ensure_ascii=False)}" + ("," if i < len(extra) - 1 else ""))
    lines.append("}")
    P.write_text("\n".join(lines) + "\n", encoding="utf-8")


def roundtrip_ok():
    raw = P.read_text(encoding="utf-8")
    d = load()
    dump(d)
    same = P.read_text(encoding="utf-8") == raw
    if not same:
        P.write_text(raw, encoding="utf-8")
    return same


if __name__ == "__main__":
    print("roundtrip:", roundtrip_ok())

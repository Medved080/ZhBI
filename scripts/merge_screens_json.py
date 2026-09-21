"""Трёхстороннее слияние `app/static/v2/screens.json` по экранам и полям (для слияния веток исполнителей: у каждого свои экраны, но правки
лежат в одном файле и текстовое слияние даёт ложные конфликты).

Запуск во время конфликтного слияния:  python3 scripts/merge_screens_json.py [--prefer ours|theirs]
Берёт три версии из git (`merge-base`, `HEAD`, `MERGE_HEAD`), сливает поэкранно и по полям: если поле меняла одна сторона — берётся её значение;
обе сторона изменили ОДНО поле по-разному — печатается конфликт и берётся `--prefer` (по умолчанию ours), решать надо человеку.
Формат файла сохраняется (по экрану на строку).
"""
import json
import subprocess
import sys

PATH = "app/static/v2/screens.json"


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout


def load(rev):
    return json.loads(git("show", f"{rev}:{PATH}"))


def main():
    prefer = "theirs" if "--prefer" in sys.argv and sys.argv[sys.argv.index("--prefer") + 1] == "theirs" else "ours"
    base_rev = git("merge-base", "HEAD", "MERGE_HEAD").strip()
    base, ours, theirs = load(base_rev), load("HEAD"), load("MERGE_HEAD")
    idx = lambda d: {s["id"]: s for s in d["screens"]}
    b, o, t = idx(base), idx(ours), idx(theirs)
    order = [s["id"] for s in ours["screens"]]
    for s in theirs["screens"]:                       # новые экраны второй стороны — после соседа из её порядка
        if s["id"] not in o and s["id"] not in b:
            prev = None
            for x in theirs["screens"]:
                if x["id"] == s["id"]:
                    break
                prev = x["id"]
            pos = order.index(prev) + 1 if prev in order else len(order)
            order.insert(pos, s["id"])
            o[s["id"]] = s
    conflicts = []
    out = []
    for sid in order:
        if sid in b and sid not in t:                 # удалён второй стороной
            if o.get(sid) == b[sid]:
                continue
        if sid not in o:
            continue
        if sid not in t or sid not in b:
            out.append(o[sid]); continue
        merged = {}
        keys = list(o[sid].keys()) + [k for k in t[sid].keys() if k not in o[sid]]
        for k in keys:
            bv, ov, tv = b[sid].get(k, "<нет>"), o[sid].get(k, "<нет>"), t[sid].get(k, "<нет>")
            if ov == tv:
                val = ov
            elif ov == bv:
                val = tv
            elif tv == bv:
                val = ov
            else:
                conflicts.append((sid, k, str(ov)[:90], str(tv)[:90]))
                val = ov if prefer == "ours" else tv
            if val != "<нет>":
                merged[k] = val
        out.append(merged)
    groups = {g["id"]: g for g in base["groups"]}
    grp = ours["groups"] + [g for g in theirs["groups"] if g["id"] not in {x["id"] for x in ours["groups"]}]
    ignore = {**theirs.get("ignore", {}), **ours.get("ignore", {})}
    text = "{\n \"groups\": " + json.dumps(grp, ensure_ascii=False) + ",\n \"screens\": [\n" \
        + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in out) + "\n ],\n \"ignore\": " + json.dumps(ignore, ensure_ascii=False) + "\n}\n"
    open(PATH, "w", encoding="utf-8").write(text)
    for c in conflicts:
        print("КОНФЛИКТ поля:", c)
    print(f"экранов: {len(out)}; конфликтов полей: {len(conflicts)}; предпочтение: {prefer}")


if __name__ == "__main__":
    main()

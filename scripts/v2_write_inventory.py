"""Инвентаризация ИЗМЕНЯЮЩИХ вызовов интерфейса V2 (для ограниченного выпуска).

Разбор — токенизатором из `scripts/inventory_v1_ui.py` (не регуляркой по тексту, правило проекта): по потоку токенов ищутся
вызовы `api.post/patch/put/delete/upload/readPost/download` и прямые `fetch(`, для каждого берётся текст первого аргумента.
Самопроверка: число найденных вызовов сверяется с независимым подсчётом «.метод(» в тех же токенах — расхождение роняет скрипт.

Запуск: python3 scripts/v2_write_inventory.py [--json]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inventory_v1_ui import tokenize, match_paren  # noqa: E402

V2 = Path(__file__).resolve().parent.parent / "app" / "static" / "v2"
METHODS = {"post": "POST", "patch": "PATCH", "put": "PUT", "delete": "DELETE", "upload": "POST(файл)",
           "readPost": "POST(чтение)", "download": "выгрузка"}


def first_arg(toks, open_i, close_i):
    """Текст первого аргумента вызова: токены до запятой верхнего уровня."""
    depth, out = 0, []
    for k in range(open_i + 1, close_i):
        kind, val, _ = toks[k]
        if kind == "p" and val in ("(", "[", "{"):
            depth += 1
        elif kind == "p" and val in (")", "]", "}"):
            depth -= 1
        elif kind == "p" and val == "," and depth == 0:
            break
        out.append(f"`{val}`" if kind == "tpl" else f'"{val}"' if kind == "str" else val)
    return "".join(out)


def scan(path):
    toks = tokenize(path.read_text(encoding="utf-8"))
    calls, dots = [], 0
    for i in range(1, len(toks) - 2):
        if toks[i][1] == "." and toks[i + 1][0] == "id" and toks[i + 1][1] in METHODS and toks[i + 2][1] == "(":
            dots += 1
            j = match_paren(toks, i + 2)
            calls.append({"file": path.name, "line": toks[i + 1][2], "method": METHODS[toks[i + 1][1]],
                          "recv": toks[i - 1][1], "arg": first_arg(toks, i + 2, j)})
        elif toks[i][0] == "id" and toks[i][1] == "fetch" and toks[i + 1][1] == "(" and toks[i - 1][1] != ".":
            j = match_paren(toks, i + 1)
            calls.append({"file": path.name, "line": toks[i][2], "method": "fetch", "recv": "", "arg": first_arg(toks, i + 1, j)})
    return calls, dots


def main():
    rows = []
    for p in sorted(V2.glob("*.js")):
        if p.name == "api.js":  # определения самих методов — не вызовы
            continue
        calls, dots = scan(p)
        if len([c for c in calls if c["method"] != "fetch"]) != dots:
            sys.exit(f"расхождение подсчёта в {p.name}")
        rows += calls
    if "--json" in sys.argv:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return
    # вызовы API — получатель `api`; прочие «.delete(» — это Map/Set/Object и в API не ходят
    api_calls = [r for r in rows if r["recv"] == "api" or r["method"] == "fetch"]
    other = [r for r in rows if r not in api_calls]
    for r in api_calls:
        print(f"{r['file']}:{r['line']}\t{r['method']}\t{r['arg']}")
    print(f"\nвызовов API: {len(api_calls)}; прочих «.метод(» (не API): {len(other)}", file=sys.stderr)
    for r in other:
        print(f"  не API: {r['file']}:{r['line']} {r['recv']}.{r['method']}({r['arg']})", file=sys.stderr)


if __name__ == "__main__":
    main()

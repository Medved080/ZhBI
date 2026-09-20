"""
Инвентаризация интерфейса V1: меню «Действия», модальные экраны, рабочие панели,
обработчики и вызываемые ими эндпоинты. Основа реестра охвата V2
(`Docs/v2-interface-coverage.md`).

Почему не регулярка (требование репозитория, `CLAUDE.md`, «Инвентаризация чего-либо по коду»):
  * разметка разбирается настоящим HTML-парсером (`html.parser`) с учётом вложенности — дерево
    меню, модалок и вкладок читается из структуры, а не из подсчёта строк;
  * JS разбирается ТОКЕНИЗАТОРОМ (строки, шаблоны, комментарии, регулярные литералы отличаются от
    кода) со сверкой скобок; обработчики и вызовы `api(...)` ищутся по токенам, а не по тексту;
  * скрипт сверяет сам себя (`--self-check`): число `id`, найденных разбором разметки, сравнивается с
    числом атрибутов `id="` в тексте; число токенов `getElementById` — с текстовым счётчиком.
    Разошлись — сказано громко, отчёт не занижается молча.

Запуск:
    .venv/bin/python scripts/inventory_v1_ui.py            # сводка
    .venv/bin/python scripts/inventory_v1_ui.py --json     # полный JSON в stdout
    .venv/bin/python scripts/inventory_v1_ui.py --write Docs/v2-interface-inventory.json
"""
import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "app" / "static" / "index.html"
JS = ROOT / "app" / "static" / "app.js"

VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


# ------------------------------------------------------------------ разметка
class Node:
    __slots__ = ("tag", "attrs", "children", "text", "parent", "line")

    def __init__(self, tag, attrs, parent, line):
        self.tag, self.attrs, self.children, self.text, self.parent, self.line = tag, attrs, [], [], parent, line

    def cls(self):
        return (self.attrs.get("class") or "").split()

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def own_text(self):
        return " ".join(" ".join(self.text).split())

    def all_text(self):
        out = [self.own_text()]
        for c in self.children:
            out.append(c.all_text())
        return " ".join(" ".join(out).split())


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {}, None, 0)
        self.cur = self.root
        self.id_count = 0

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), self.cur, self.getpos()[0])
        if "id" in node.attrs:
            self.id_count += 1
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        node = Node(tag, dict(attrs), self.cur, self.getpos()[0])
        if "id" in node.attrs:
            self.id_count += 1
        self.cur.children.append(node)

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if data.strip() and self.cur.tag not in ("script", "style"):
            self.cur.text.append(data.strip())


def parse_html():
    t = Tree()
    t.feed(HTML.read_text(encoding="utf-8"))
    return t


# ------------------------------------------------------------------ JS-токенизатор
PUNCT_REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^") | {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw"}


def tokenize(src):
    """Токены (kind, value, line). kind: id | str | tpl | num | p (пунктуация). Комментарии отбрасываются."""
    i, n, line = 0, len(src), 1
    toks = []
    prev = None

    def add(kind, val, ln):
        nonlocal prev
        toks.append((kind, val, ln))
        prev = (kind, val)

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
        elif c in " \t\r":
            i += 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            line += src.count("\n", i, j)
            i = j
        elif c in "\"'":
            j, ln = i + 1, line
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                if src[j] == "\n":
                    line += 1
                j += 1
            add("str", src[i + 1:j], ln)
            i = j + 1
        elif c == "`":
            j, ln, depth = i + 1, line, 0
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "\n":
                    line += 1
                if ch == "$" and j + 1 < n and src[j + 1] == "{":
                    depth += 1
                    j += 2
                    continue
                if ch == "}" and depth:
                    depth -= 1
                elif ch == "`" and not depth:
                    break
                j += 1
            add("tpl", src[i + 1:j], ln)
            i = j + 1
        elif c == "/" and (prev is None or prev[0] == "p" and prev[1] in PUNCT_REGEX_PREV or prev[0] == "id" and prev[1] in PUNCT_REGEX_PREV):
            j = i + 1
            in_class = False
            while j < n and (src[j] != "/" or in_class):
                if src[j] == "\\":
                    j += 1
                elif src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "\n":
                    break
                j += 1
            j += 1
            while j < n and (src[j].isalpha()):
                j += 1
            add("str", "<regex>", line)
            i = j
        elif c.isalpha() or c in "_$" or ord(c) > 127:
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$" or ord(src[j]) > 127):
                j += 1
            add("id", src[i:j], line)
            i = j
        elif c.isdigit():
            j = i
            while j < n and (src[j].isalnum() or src[j] in "._"):
                j += 1
            add("num", src[i:j], line)
            i = j
        else:
            two = src[i:i + 3] if src[i:i + 3] in ("...", "===", "!==", "=>") else src[i:i + 2] if src[i:i + 2] in ("=>", "==", "!=", "&&", "||", "??", "?.", "++", "--", "<=", ">=") else c
            add("p", two, line)
            i += len(two)
    return toks


def match_brace(toks, i):
    """i — индекс токена «{»; возвращает индекс парной «}»."""
    depth = 0
    for j in range(i, len(toks)):
        if toks[j][0] == "p":
            if toks[j][1] == "{":
                depth += 1
            elif toks[j][1] == "}":
                depth -= 1
                if depth == 0:
                    return j
    return len(toks) - 1


def match_paren(toks, i):
    depth = 0
    for j in range(i, len(toks)):
        if toks[j][0] == "p":
            if toks[j][1] == "(":
                depth += 1
            elif toks[j][1] == ")":
                depth -= 1
                if depth == 0:
                    return j
    return len(toks) - 1


def functions(toks):
    """{имя: (i_start, i_end)} для `function name(...) {` и `async function name(...) {` верхнего уровня файла."""
    out = {}
    for i, (k, v, ln) in enumerate(toks):
        if k == "id" and v == "function" and i + 1 < len(toks) and toks[i + 1][0] == "id":
            name = toks[i + 1][1]
            j = i + 2
            while j < len(toks) and not (toks[j][0] == "p" and toks[j][1] == "{"):
                j += 1
            if j < len(toks):
                out.setdefault(name, (j, match_brace(toks, j)))
    return out


def endpoints_in(toks, a, b, funcs, depth=1, seen=None):
    """Пути API, найденные в токенах [a, b]: строки/шаблоны, начинающиеся с «/» и идущие после api( / fetch( / apiUrl(;
    плюс (на один уровень вглубь) те же пути из вызываемых функций того же файла."""
    seen = seen if seen is not None else set()
    res = set()
    for i in range(a, b + 1):
        k, v, ln = toks[i]
        if k in ("str", "tpl") and v.startswith("/") and i >= 2 and toks[i - 1][1] == "(" and toks[i - 2][0] == "id" \
                and toks[i - 2][1] in ("api", "fetch", "apiUrl", "downloadFile", "apiForm", "apiJson", "download"):
            res.add(re.split(r"[?$`]", v)[0].rstrip("/") or "/")
        if depth and k == "id" and i + 1 <= b and toks[i + 1][1] == "(" and v in funcs and v not in seen:
            seen.add(v)
            fa, fb = funcs[v]
            res |= endpoints_in(toks, fa, fb, funcs, depth - 1, seen)
    return res


def handlers(toks, funcs):
    """{element_id: {'events': [...], 'line': N, 'calls': [...], 'api': [...]}} по цепочкам
    document.getElementById("x").addEventListener("click", ...) и const y = document.getElementById("x") ... y.addEventListener."""
    out = {}
    aliases = {}
    n = len(toks)
    for i in range(n - 6):
        # document.getElementById("id")
        if toks[i][1] == "getElementById" and toks[i + 1][1] == "(" and toks[i + 2][0] == "str" and toks[i + 3][1] == ")":
            eid = toks[i + 2][2 - 2 + 1] if False else toks[i + 2][1]
            # alias:  name = document.getElementById(...)   (i-1 '.', i-2 'document', i-3 '=', i-4 name)
            if i >= 4 and toks[i - 3][1] == "=" and toks[i - 4][0] == "id":
                aliases[toks[i - 4][1]] = eid
            if toks[i + 4][1] == "." and toks[i + 5][1] == "addEventListener" and toks[i + 6][1] == "(":
                register(out, toks, funcs, eid, i + 6)
    for i in range(n - 3):
        if toks[i][0] == "id" and toks[i][1] in aliases and toks[i + 1][1] == "." and toks[i + 2][1] == "addEventListener" and toks[i + 3][1] == "(":
            register(out, toks, funcs, aliases[toks[i][1]], i + 3)
    return out


def register(out, toks, funcs, eid, i_paren):
    j = match_paren(toks, i_paren)
    ev = toks[i_paren + 1][1] if toks[i_paren + 1][0] == "str" else "?"
    calls = []
    for k in range(i_paren + 1, j):
        if toks[k][0] == "id" and toks[k + 1][1] == "(" and toks[k][1] in funcs and toks[k][1] not in calls:
            calls.append(toks[k][1])
    api = endpoints_in(toks, i_paren, j, funcs)
    for c in calls[:3]:
        fa, fb = funcs[c]
        api |= endpoints_in(toks, fa, fb, funcs, depth=0)
    e = out.setdefault(eid, {"events": [], "line": toks[i_paren][2], "calls": [], "api": set()})
    if ev not in e["events"]:
        e["events"].append(ev)
    e["calls"] = list(dict.fromkeys(e["calls"] + calls))[:5]
    e["api"] |= api



# ------------------------------------------------------------------ структура экрана (для каркаса V2)
CANCEL_WORDS = {"отмена", "закрыть", "отменить", "×", "✕", "закрыть режим"}


def _kind_of(btn):
    c = btn.cls()
    if any("danger" in x for x in c):
        return "danger"
    if any("primary" in x for x in c):
        return "primary"
    return "secondary"


def _field_kind(inp):
    if inp.tag == "select":
        return "select"
    if inp.tag == "textarea":
        return "textarea"
    return inp.attrs.get("type") or "text"


def structure(root):
    """Упрощённая модель статической разметки экрана: список блоков в порядке появления. Динамическое
    содержимое (строки таблиц, варианты списков), которое V1 строит из JS, здесь не видно и НЕ выдумывается."""
    blocks = []
    seen_tabs = set()

    def own(n):
        return n.own_text()

    def label_for(n):
        # 1) <label> вокруг поля; 2) <label for=id>; 3) предыдущий брат-подпись; 4) placeholder/title
        p = n.parent
        if p is not None and p.tag == "label" and own(p):
            return own(p)
        if n.attrs.get("id"):
            for x in root.walk():
                if x.tag == "label" and x.attrs.get("for") == n.attrs["id"] and own(x):
                    return own(x)
        if p is not None:
            i = p.children.index(n)
            for prev in reversed(p.children[:i]):
                if prev.tag in ("span", "label", "small") and own(prev):
                    return own(prev)
                break
        return n.attrs.get("aria-label") or n.attrs.get("placeholder") or n.attrs.get("title") or ""

    def rec(n):
        for c in n.children:
            t = c.tag
            if t in ("script", "style", "svg", "img", "datalist", "option", "canvas"):
                continue
            if t in ("h1", "h2", "h3", "h4"):
                if own(c):
                    blocks.append({"t": "h", "l": int(t[1]), "text": own(c)[:80]})
                continue
            if t == "button":
                txt = c.all_text()[:60]
                is_tab = (any(k.startswith("data-") and (k.endswith("tab") or k.endswith("view")) for k in c.attrs)
                          or "tab-btn" in c.cls() or "view-mode-btn" in c.cls() or c.attrs.get("role") == "tab")
                if is_tab:
                    key = id(c.parent)
                    if key not in seen_tabs:
                        seen_tabs.add(key)
                        blocks.append({"t": "tabs", "items": [b.all_text()[:40] for b in c.parent.children if b.tag == "button"]})
                    continue
                if not txt or txt.lower() in CANCEL_WORDS:
                    continue
                blocks.append({"t": "btn", "text": txt, "kind": _kind_of(c), "id": c.attrs.get("id")})
                continue
            if t == "label":
                inner = next((x for x in c.walk() if x.tag in ("input", "select", "textarea")), None)
                txt = own(c)
                if inner is not None:
                    ty = _field_kind(inner)
                    if ty == "checkbox":
                        blocks.append({"t": "check", "text": txt[:120]})
                    elif ty == "radio":
                        blocks.append({"t": "radio", "text": txt[:120]})
                    elif ty in ("hidden", "file"):
                        blocks.append({"t": "field", "label": txt[:80] or "Файл", "kind": ty})
                    else:
                        blocks.append({"t": "field", "label": txt[:80], "kind": ty, "ph": (inner.attrs.get("placeholder") or "")[:60]})
                    # вложенные кнопки-спутники поля
                    continue
                if txt:
                    blocks.append({"t": "lbl", "text": txt[:140]})   # подпись без вложенного поля — свяжется со следующим полем ниже
                continue
            if t in ("input", "select", "textarea"):
                ty = _field_kind(c)
                if ty in ("hidden",):
                    continue
                if ty == "checkbox":
                    blocks.append({"t": "check", "text": label_for(c)[:120]})
                elif ty == "radio":
                    blocks.append({"t": "radio", "text": label_for(c)[:120]})
                else:
                    blocks.append({"t": "field", "label": label_for(c)[:80], "kind": ty, "ph": (c.attrs.get("placeholder") or "")[:60]})
                continue
            if t == "table":
                cols = [th.all_text()[:40] for th in c.walk() if th.tag == "th"]
                blocks.append({"t": "table", "cols": [x for x in cols if x] or None, "id": c.attrs.get("id")})
                continue
            if t in ("p", "small") or (t in ("div", "span") and any(k in ("hint-text", "u-note", "muted") for k in c.cls())):
                if own(c) and len(own(c)) > 8:
                    blocks.append({"t": "hint", "text": own(c)[:160]})
                if t == "p":
                    continue
            rec(c)

    rec(root)
    # подпись без поля: сливается со следующим полем, если у того нет своей подписи или она та же;
    # иначе остаётся подсказкой
    merged = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b["t"] == "lbl":
            nxt = blocks[i + 1] if i + 1 < len(blocks) else None
            if nxt and nxt["t"] == "field" and nxt["label"] in ("", b["text"]):
                nxt["label"] = b["text"]
                i += 1
                continue
            if nxt and nxt["t"] in ("check", "radio") and nxt["text"] in ("", b["text"]):
                i += 1
                continue
            merged.append({"t": "hint", "text": b["text"]})
        else:
            merged.append(b)
        i += 1
    blocks = merged
    # схлопываем подряд идущие одинаковые подсказки
    out = []
    for b in blocks:
        if out and out[-1] == b:
            continue
        out.append(b)
    return out


# ------------------------------------------------------------------ сборка
def menu_entries(tree):
    """Пункты меню «Действия»: путь групп, подпись, id, право (data-feature), вид права."""
    root = next((n for n in tree.root.walk() if n.attrs.get("id") == "settings-menu"), None)
    items = []

    def rec(node, path):
        for c in node.children:
            if c.tag == "button" and "submenu-trigger" in c.cls():
                continue
            if c.tag == "div" and "submenu" in c.cls():
                trig = next((x for x in c.children if x.tag == "button" and "submenu-trigger" in x.cls()), None)
                title = trig.own_text() if trig else "?"
                panel = next((x for x in c.children if "submenu-panel" in x.cls()), c)
                rec(panel, path + [title])
            elif c.tag == "button":
                items.append({"id": c.attrs.get("id"), "label": c.all_text(), "path": path, "feature": c.attrs.get("data-feature"),
                              "kind": c.attrs.get("data-feature-kind"), "in_dev": "menu-item-in-dev" in c.cls(),
                              "danger": "menu-item-danger" in c.cls(), "line": c.line})
            else:
                rec(c, path)
    if root:
        rec(root, [])
    return items


def modals(tree):
    res = []
    for n in tree.root.walk():
        if "modal-backdrop" in n.cls() and n.attrs.get("id"):
            title = next((x.own_text() for x in n.walk() if x.tag in ("h2", "h3") and x.own_text()), "")
            tabs = [t.own_text() for t in n.walk() if t.tag == "button" and any(k for k in t.attrs if k.startswith("data-") and k.endswith("tab"))]
            buttons = [{"id": b.attrs.get("id"), "text": b.all_text()[:60]} for b in n.walk() if b.tag == "button" and b.attrs.get("id")]
            inputs = sum(1 for x in n.walk() if x.tag in ("input", "select", "textarea"))
            tables = sum(1 for x in n.walk() if x.tag == "table")
            res.append({"id": n.attrs["id"], "title": title, "tabs": [t for t in tabs if t], "buttons": buttons, "inputs": inputs, "tables": tables, "line": n.line,
                        "structure": structure(n)})
    return res


def toolbar(tree):
    """Верхняя панель и правая боковая панель: кнопки и вкладки вне модалок."""
    res = []
    for n in tree.root.walk():
        if n.tag == "button" and n.attrs.get("id"):
            p, in_modal = n.parent, False
            while p is not None:
                if "modal-backdrop" in p.cls() or p.attrs.get("id") == "settings-menu":
                    in_modal = True
                    break
                p = p.parent
            if not in_modal:
                res.append({"id": n.attrs["id"], "text": n.all_text()[:50], "line": n.line})
    return res


# Крупные области основной страницы (рабочие места), не относящиеся к модальным окнам
REGION_IDS = ["sidebar", "picker-panel", "picker-metrics", "picker-contracts", "foreman-panel", "mfr-workspace",
              "chess-flat-overlay-root", "stage", "stage-3d", "statusbar", "ctx-menu", "workdate-box", "user-box"]


def regions(tree):
    res = {}
    for n in tree.root.walk():
        if n.attrs.get("id") in REGION_IDS and n.attrs["id"] not in res:
            res[n.attrs["id"]] = {"line": n.line, "structure": structure(n)}
    return res


def build():
    tree = parse_html()
    src = JS.read_text(encoding="utf-8")
    toks = tokenize(src)
    funcs = functions(toks)
    hs = handlers(toks, funcs)
    menu = menu_entries(tree)
    mods = modals(tree)
    tb = toolbar(tree)
    for it in menu:
        h = hs.get(it["id"])
        it["handler"] = {"line": h["line"], "calls": h["calls"], "api": sorted(h["api"])} if h else None
    for m in mods:
        m["closed_by"] = None
    # проверки самого себя
    checks = {
        "id_в_разметке_разбором": tree.id_count,
        "id_в_разметке_текстом": len(re.findall(r'\bid="', HTML.read_text(encoding="utf-8"))),
        "getElementById_токенами": sum(1 for i, t in enumerate(toks) if t[1] == "getElementById" and i + 1 < len(toks) and toks[i + 1][1] == "("),
        "getElementById_текстом": len(re.findall(r"getElementById\(", src)),
        "токенов": len(toks), "функций_верхнего_уровня": len(funcs), "обработчиков_по_id": len(hs),
    }
    return {"menu": menu, "modals": mods, "toolbar": tb, "regions": regions(tree), "checks": checks, "handlers_total": len(hs),
            "handlers": {k: {"calls": v["calls"], "api": sorted(v["api"]), "line": v["line"]} for k, v in hs.items()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write")
    ap.add_argument("--no-self-check", action="store_true")
    a = ap.parse_args()
    data = build()
    c = data["checks"]
    problems = []
    if not a.no_self_check:
        if c["id_в_разметке_разбором"] != c["id_в_разметке_текстом"]:
            problems.append(f"id в разметке: разбор {c['id_в_разметке_разбором']} ≠ текст {c['id_в_разметке_текстом']}")
        # токенизатор не должен видеть БОЛЬШЕ getElementById, чем есть в тексте, и терять не более 2% (вызовы в комментариях/строках)
        t, x = c["getElementById_токенами"], c["getElementById_текстом"]
        if t > x or t < x * 0.97:
            problems.append(f"getElementById: токены {t} vs текст {x}")
    if a.write:
        Path(a.write).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    if a.json:
        print(json.dumps(data, ensure_ascii=False, indent=1))
    else:
        print(f"пунктов меню: {len(data['menu'])}; модальных экранов: {len(data['modals'])}; кнопок вне модалок и меню: {len(data['toolbar'])}")
        print("проверки:", c)
    if problems:
        print("САМОПРОВЕРКА НЕ ПРОЙДЕНА:", "; ".join(problems), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

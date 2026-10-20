"""Связь «марка элемента ЖБИ → изделие калькулятора» (этап 2 Docs/calc-merge-design.md).

Автоматически связываются только однозначные совпадения; неоднозначные и
ненайденные возвращаются как есть — никто не должен попасть на чужое изделие.
Правила нормализации (одна функция на сервер и тесты):
  1. верхний регистр, пробелы и разделители `-./,_` убираются;
  2. латиница похожих букв → кириллица, `З` → `3` (OCR каталога путает);
  3. `КВ`/`К8` перед цифрой считаются одним (OCR читает «В» как «8»).
Изделие калькулятора сравнивается по названию без слова-типа («Колонна 3КН4.3» →
`3КН43`), по полному названию и по `alias` каталога.
"""
import re

from .document_models import catalog

_LOOKALIKE = str.maketrans({"A": "А", "B": "В", "C": "С", "E": "Е", "H": "Н", "K": "К", "M": "М", "O": "О", "P": "Р", "T": "Т", "X": "Х", "Y": "У", "З": "3"})
_DROP = re.compile(r"[\s\-./,_]+")
MAX_BATCH = 300


def normalize(value, strict=False):
    """strict сохраняет точки и запятые (КС1.1 ≠ КС11); нестрогий ключ — запасной."""
    text = (value or "").upper().replace(",", ".") if strict else (value or "").upper()
    text = (re.sub(r"[\s\-_/]+", "", text) if strict else _DROP.sub("", text)).translate(_LOOKALIKE)
    return re.sub(r"К[В8](?=\d)", "К8", text)


def _strip_type(name):
    parts = name.split()
    if len(parts) >= 2 and re.fullmatch(r"[А-Яа-яЁё]{4,}", parts[0]):
        return " ".join(parts[1:]), parts[0]
    return name, ""


def build_index(conn, strict=False):
    index = {}
    models = catalog()
    for row in conn.execute("SELECT id,name,document_model_id FROM products"):
        tail, kind = _strip_type(row["name"])
        keys = {normalize(tail, strict), normalize(row["name"], strict)}
        alias = (models.get(row["document_model_id"]) or {}).get("alias")
        if alias:
            keys.add(normalize(alias, strict))
        entry = {"id": row["id"], "name": row["name"], "kind": kind.casefold()}
        for key in keys:
            if key:
                index.setdefault(key, {})[row["id"]] = entry
    return index


def excluded_index():
    """Модели, исключённые из расчёта (поле excluded в каталоге): ключ марки → {alias, reason}; марка на схеме у них есть, изделия в калькуляторе нет и не будет."""
    index = {}
    for model in catalog().values():
        info = model.get("excluded")
        if not info:
            continue
        entry = {"alias": model.get("alias"), "reason": info.get("reason", ""), "label": info.get("label", "исключено из расчёта")}
        for key in {normalize(model.get("alias"), True), normalize(_strip_type(model.get("mark") or "")[0], True)}:
            if key:
                index[key] = entry
    return index


def resolve(conn, items):
    """items: [{mark, type?}] → {mark: {status: found|ambiguous|excluded|none, productId?, productName?, candidates?, reason?}}."""
    index, loose = build_index(conn, True), build_index(conn)
    skipped = excluded_index()
    result = {}
    for item in items:
        mark = (item.get("mark") or "").strip()
        if not mark or mark in result:
            continue
        candidates = list(index.get(normalize(mark, True), {}).values())
        if len(candidates) != 1:
            candidates = list(loose.get(normalize(mark), {}).values())
        if len(candidates) > 1 and item.get("type"):
            first = item["type"].split()[0].casefold()
            narrowed = [c for c in candidates if c["kind"] and (first.startswith(c["kind"][:5]) or c["kind"].startswith(first[:5]))]
            if len(narrowed) == 1:
                candidates = narrowed
        if len(candidates) == 1:
            result[mark] = {"status": "found", "productId": candidates[0]["id"], "productName": candidates[0]["name"]}
        elif candidates:
            result[mark] = {"status": "ambiguous", "candidates": [{"productId": c["id"], "productName": c["name"]} for c in candidates[:5]]}
        elif normalize(mark, True) in skipped:
            result[mark] = {"status": "excluded", **skipped[normalize(mark, True)]}
        else:
            result[mark] = {"status": "none"}
    return result

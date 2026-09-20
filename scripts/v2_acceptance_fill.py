"""Заполняет Docs/v2-release-acceptance.md результатами прогонов стенда.

Вход: Docs/v2-acceptance-results/*.json (их пишет стенд по ?save=<имя>, вместе с версией кода).
Правило статуса строки матрицы (столбец «Способ»):
  * есть L (живой сервер) — строка остаётся «не проверен», пока L не выполнен; результат H записывается в «Факт»;
  * только H/T — «пройден», если ВСЕ сопоставленные сценарии зелёные; «ошибка», если хоть один красный;
  * нет сопоставленного сценария — статус не меняется.
Запуск: python3 scripts/v2_acceptance_fill.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "Docs" / "v2-release-acceptance.md"
RES_DIR = ROOT / "Docs" / "v2-acceptance-results"

# строка матрицы -> сценарии стенда, которые её покрывают (если имя не совпадает с ID строки)
ALIASES = {
    "SH-12": ["PO-13"], "SH-20": ["SH-20"], "SH-07": ["SH-07", "SH-19"],
    "UA-U-10": ["UA-C-01"], "UA-K-03": ["UA-K-02"], "UA-K-04": ["UA-K-02"],
    "UA-C-03": ["UA-C-03"], "CP-L-09": ["CP-L-09"], "CP-P-03": ["CP-P-02"],
    "CP-A-06": ["CP-A-06", "CP-S-01"], "CP-S-02": ["CP-S-01"], "CP-S-03": ["CP-S-01", "CP-W-16"],
    "CP-K-02": ["CP-K-01"], "CP-W-06": ["CP-W-05"], "CP-W-17": ["CP-REG-10"],
    "CP-W-18": ["CP-REG-02", "CP-W-14"], "CP-REG-03": ["CP-REG-02", "CP-REG-06"],
    "X-ERR-01": ["UA-U-08", "UA-C-03", "UA-A-09", "PO-18", "PO-20", "CP-M-06", "CP-W-11"],
    "X-ERR-02": ["UA-U-08", "UA-C-03", "PO-20", "CP-M-06", "CP-W-11", "CP-W-15"],
    "X-KBD-04": ["UA-R-09", "PO-25", "CP-KBD-01", "CP-KBD-02"],
}
PREFIX_ALIASES = {"X-KBD-01": "A11Y-", "X-KBD-03": "A11Y-", "X-ERR-03": ""}
# визуальная сетка: форма -> сцены
VIS_FORMS = {
    "UA: список пользователей": ["ua-users"],
    "UA: карточка — Профиль": ["ua-card-profile"],
    "UA: карточка — Доступ к объектам (сводка и редактор области)": ["ua-card-access", "ua-card-access-editor"],
    "UA: карточка — Вход и безопасность": ["ua-card-security"],
    "UA: Роли (список + матрица)": ["ua-roles", "ua-roles-dirty"],
    "UA: Проверка доступа": ["ua-check"],
    "PO: дерево + карточка проекта": ["po-tree", "po-project-long"],
    "PO: карточка объекта (реквизиты, адрес, карта, вложения)": ["po-object", "po-object-long", "po-dirty-error"],
    "PO: новая запись": ["po-new"],
    "CP: список контрагентов": ["cp-list"],
    "CP: карточка (все вкладки)": ["cp-card-main", "cp-card-main-long", "cp-card-main-dirty", "cp-card-contracting", "cp-card-other"],
    "CP: рабочее пространство контракта (все вкладки)": ["cp-contract-lines", "cp-contract-expanded", "cp-contract-expanded-error", "cp-contract-incidents", "cp-contract-capacity", "cp-contract-long", "cp-contract-replacement"],
    "Диалоги (несохранённое, подтверждение, сообщение)": ["dialog-unsaved", "dialog-confirm-danger"],
    "Вход, смена пароля, «Нет доступных разделов»": ["login", "no-sections"],
}
SIZES = ["1920x1080", "1920x900", "1366x768"]


def load_results():
    merged, revs = {}, set()
    for f in sorted(RES_DIR.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        revs.add(d.get("rev", "?") + ("+" if d.get("tree_dirty") else ""))
        for r in d.get("results", []):
            merged[r["id"]] = {**r, "rev": d.get("rev", "?"), "file": f.name}
    return merged, revs


def find(merged, row_id):
    ids = ALIASES.get(row_id)
    if ids is None and row_id in PREFIX_ALIASES:
        ids = [i for i in merged if i.startswith(PREFIX_ALIASES[row_id])]
    if ids is None:
        ids = [i for i in merged if i == row_id or re.fullmatch(re.escape(row_id) + r"[a-z]", i)]
    return [merged[i] for i in ids if i in merged]


def main():
    merged, revs = load_results()
    lines = DOC.read_text(encoding="utf-8").split("\n")
    header = None
    counts = {"пройден": 0, "ошибка": 0, "не проверен": 0, "заблокирован": 0}
    for n, line in enumerate(lines):
        if line.startswith("| ID"):
            header = [c.strip() for c in line.strip("|").split("|")]
            continue
        if not line.startswith("| ") or header is None or set(line.replace("|", "").strip()) <= {"-", " "}:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != len(header):
            continue
        row = dict(zip(header, cells))
        rid = row["ID"]
        if "Способ" not in row or "Статус" not in row:
            continue
        found = find(merged, rid)
        method = row["Способ"]
        status = row["Статус"]
        if found:
            ok = all(r["status"] == "pass" for r in found)
            n_checks = sum(r.get("checks", 0) for r in found)
            rev = found[0]["rev"]
            fact = f"H: {'PASS' if ok else 'FAIL'} ({len(found)} сцен., {n_checks} проверок; ревизия {rev})"
            if not ok:
                fact += " — " + "; ".join((r["failed"] or [r.get("error") or ""])[0][:80] for r in found if r["status"] != "pass")
            proof = ", ".join(sorted({f"`{r['file']}`" for r in found}))
            if "L" in re.split(r"[+ ]", method):
                status = "ошибка" if not ok else "не проверен (H ✓, L ждёт входа)"
            else:
                status = "пройден" if ok else "ошибка"
            if "Факт" in row:
                row["Факт"] = fact
            if "Дока-во" in row:
                row["Дока-во"] = proof
            row["Статус"] = status
            lines[n] = "| " + " | ".join(row[h] for h in header) + " |"
        for k in counts:
            if row["Статус"].startswith(k):
                counts[k] += 1
    # визуальная сетка
    text = "\n".join(lines)
    for form, scenes in VIS_FORMS.items():
        cells = []
        for size in SIZES:
            ids = [f"VIS-{sc}-{size}" for sc in scenes]
            res = [merged[i] for i in ids if i in merged]
            if len(res) == len(ids):
                cells.append("H ✓ · L —" if all(r["status"] == "pass" for r in res) else "H ✗ · L —")
            else:
                cells.append("не проверен")
        pat = re.compile(r"^\| " + re.escape(form) + r" \| .* \| .* \| .* \|$", re.M)
        text = pat.sub(f"| {form} | {cells[0]} | {cells[1]} | {cells[2]} |", text)
    DOC.write_text(text, encoding="utf-8")
    print("ревизии результатов:", ", ".join(sorted(revs)) or "—", "| строки матрицы:", counts)


if __name__ == "__main__":
    main()

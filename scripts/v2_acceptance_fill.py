"""Заполняет Docs/v2-release-acceptance.md результатами прогонов стенда.

Вход: Docs/v2-acceptance-results/*.json (их пишет стенд по ?save=<имя>, вместе с версией кода).
Правило статуса строки матрицы (столбец «Способ»):
  * есть L (живой сервер) — строка остаётся «не проверен», пока L не выполнен; результат H записывается в «Факт»;
  * только H/T — «пройден», если ВСЕ сопоставленные сценарии зелёные; «ошибка», если хоть один красный;
  * нет сопоставленного сценария — статус не меняется.
  * есть живой результат Docs/v2-acceptance-results/live.json (шаги L1–L12 на реальном сервере): pass → «пройден»
    (при зелёном H), blocked → «заблокирован» (причина в «Факт»); L-строки без H (SH-13, SH-15, UA-C-08, UA-K-05, PO-23)
    берут статус из live.json.
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
    "CP-A-06": ["CP-A-06", "CP-S-01"], "CP-W-05": ["CP-W-05", "CP-W-05b"], "CP-S-02": ["CP-S-01"], "CP-S-03": ["CP-S-01", "CP-W-16"],
    "CP-K-02": ["CP-K-01"], "CP-W-06": ["CP-W-06", "CP-W-06b"], "CP-W-17": ["CP-REG-10"],
    "CP-W-18": ["CP-W-18", "CP-REG-02", "CP-W-14"], "CP-REG-03": ["CP-REG-02", "CP-REG-06"],
    "X-ERR-01": ["UA-U-08", "UA-C-03", "UA-A-09", "PO-18", "PO-20", "CP-M-06", "CP-W-11"],
    "X-ERR-02": ["UA-U-08", "UA-C-03", "PO-20", "CP-M-06", "CP-W-11", "CP-W-15"],
    "X-KBD-04": ["UA-R-09", "PO-25", "CP-KBD-01", "CP-KBD-02"],
    "UA-A-10": ["UA-C-10", "SH-05", "SH-06"], "PO-15": ["PO-05"],
    "CP-L-04": ["CP-M-02", "CP-M-03"], "CP-L-05": ["CP-M-04", "CP-A-02"], "CP-M-05": ["CP-M-04"],
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


def current_tree():
    import subprocess
    return subprocess.run(["git", "rev-parse", "HEAD:app/static"], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def load_live():
    """Живые результаты действительны только для той версии интерфейса, для которой сняты (хэш app/static)."""
    f = RES_DIR / "live.json"
    if not f.exists():
        return {"rows": {}}
    d = json.loads(f.read_text(encoding="utf-8"))
    if d.get("app_static_tree") != current_tree():
        print("ВНИМАНИЕ: live.json снят на другой версии app/static — живые результаты не засчитываются", d.get("app_static_tree"), "≠", current_tree())
        return {"rows": {}, "stale": True}
    return d


def load_results():
    merged, revs = {}, set()
    for f in sorted(RES_DIR.glob("*.json")):
        if f.name == "live.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("app_static_tree") != current_tree() or d.get("tree_dirty"):
            print(f"ВНИМАНИЕ: {f.name} снят на другой/не зафиксированной версии — стендовые результаты не засчитываются")
            continue
        revs.add(d.get("rev", "?"))
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
    live = load_live()
    live_rows = live.get("rows", {})
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
        # Статус пересчитывается ЗАНОВО из действительных результатов: устаревшее «пройден» не переживает смену версии кода.
        status = "не проверен"
        if "Факт" in row:
            row["Факт"] = "—"
        if "Дока-во" in row:
            row["Дока-во"] = "—"
        lv = live_rows.get(rid)
        needs_l = "L" in re.split(r"[+ ]", method)
        fact = None
        proof = None
        ok = None
        if found:
            ok = all(r["status"] == "pass" for r in found)
            n_checks = sum(r.get("checks", 0) for r in found)
            rev = found[0]["rev"]
            fact = f"H: {'PASS' if ok else 'FAIL'} ({len(found)} сцен., {n_checks} проверок; ревизия {rev})"
            if not ok:
                fact += " — " + "; ".join((r["failed"] or [r.get("error") or ""])[0][:80] for r in found if r["status"] != "pass")
            proof = ", ".join(sorted({f"`{r['file']}`" for r in found}))
        if found and not needs_l:
            status = "пройден" if ok else "ошибка"
        elif found and needs_l:
            if not ok:
                status = "ошибка"
            elif lv and lv["status"] == "pass":
                status = "пройден"
            elif lv and lv["status"] == "blocked":
                status = "заблокирован"
            elif lv and lv["status"] == "fail":
                status = "ошибка"
            else:
                status = "не проверен (H ✓, L не выполнен)"
        elif lv:  # строки только с L
            status = {"pass": "пройден", "fail": "ошибка"}.get(lv["status"], "заблокирован")
        if lv:
            fact = (fact + " · " if fact else "") + f"L: {lv['note']}"
            proof = (proof + ", " if proof else "") + "`live.json`"
        if True:
            if "Факт" in row and fact is not None:
                row["Факт"] = fact
            if "Дока-во" in row and proof is not None:
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
                l_ok = live_rows.get("X-VIS-*", {}).get("status") == "pass"
                cells.append(("H ✓" if all(r["status"] == "pass" for r in res) else "H ✗") + (" · L ✓" if l_ok else " · L —"))
            else:
                cells.append("не проверен")
        pat = re.compile(r"^\| " + re.escape(form) + r" \| .* \| .* \| .* \|$", re.M)
        text = pat.sub(f"| {form} | {cells[0]} | {cells[1]} | {cells[2]} |", text)
    # строка X-VIS-* (без столбцов «Факт»/«Дока-во»)
    vis_live = live_rows.get("X-VIS-*")
    if vis_live:
        vis_ids = [i for i in merged if i.startswith("VIS-")]
        vis_ok = bool(vis_ids) and all(merged[i]["status"] == "pass" for i in vis_ids)
        st = "пройден" if vis_ok and vis_live["status"] == "pass" else ("ошибка" if not vis_ok else "заблокирован")
        text = re.sub(r"^(\| X-VIS-\* \|.*\| H\+L \| )[^|]*(\|)$", lambda m: m.group(1) + st + " " + m.group(2), text, flags=re.M)
    DOC.write_text(text, encoding="utf-8")
    print("ревизии результатов:", ", ".join(sorted(revs)) or "—", "| строки матрицы:", counts)


if __name__ == "__main__":
    main()

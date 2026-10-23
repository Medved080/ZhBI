"""Сверка загрузчика производственной программы с эталоном прототипа (2026-10-23, Docs/pp-money.md).

    .venv/bin/python scripts/verify_pp_import.py <книга.xlsx> <эталон> [--dump данные.json]

<книга.xlsx> — выгрузка с листами «Ввод» и «Лист6» (в проект не входит: реквизиты заказчика).
<эталон> — результат прототипа: `data.js` (`window.PP_DATA = {...};`) или JSON `{money, schedule}`.

Сравнивается ПОЛНОСТЬЮ: каждая строка денег и сроков, поля и порядок. Значения в отчёт не выводятся (это данные заказчика) —
только счётчики и номера расходящихся строк с названиями полей. Код возврата 1, если есть расхождение.
`--dump` пишет разобранные данные в JSON — чтобы подать их на `scripts/verify_pp_core.mjs`.
"""

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.pp_import import parse_workbook  # noqa: E402

# Контрольные числа описания прототипа на файле 20.10.2026.
CONTROL = {"objects": 213, "merged_duplicates": 49, "schedule_rows": 8051, "money_rows": 5449}
CONTROL_REST_MLN = 442284


def load_reference(path: str) -> dict:
    text = Path(path).read_text(encoding="utf-8")
    marker = "window.PP_DATA = "
    if marker in text:
        text = text[text.index(marker) + len(marker):]
    obj, _ = json.JSONDecoder().raw_decode(text)
    return obj


def same(a, b) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return (math.isnan(a) and math.isnan(b)) or a == b
    return a == b


def compare(kind: str, got: list, want: list) -> int:
    bad = 0
    if len(got) != len(want):
        print(f"FAIL {kind}: строк {len(got)}, в эталоне {len(want)}")
        bad += 1
    for i, (g, w) in enumerate(zip(got, want)):
        fields = [k for k in sorted(set(g) | set(w)) if not same(g.get(k), w.get(k))]
        if fields:
            bad += 1
            if bad <= 10:
                print(f"FAIL {kind}[{i}]: расходятся поля {fields}")
    if not bad:
        print(f"OK   {kind}: {len(got)} строк совпали полностью")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("reference")
    ap.add_argument("--dump")
    a = ap.parse_args()
    res = parse_workbook(a.xlsx)
    ref = load_reference(a.reference)
    st = res["stats"]
    print("Статистика:", {k: (round(v) if k == "rest_total" else v) for k, v in st.items()})
    fails = compare("Сроки", res["schedule"], ref["schedule"]) + compare("Деньги", res["money"], ref["money"])
    for k, v in CONTROL.items():
        ok = st[k] == v
        print(("OK   " if ok else "FAIL ") + f"контроль {k} = {st[k]} (ожидалось {v})")
        fails += 0 if ok else 1
    mln = round(st["rest_total"] / 1e6)
    ok = mln == CONTROL_REST_MLN
    print(("OK   " if ok else "FAIL ") + f"контроль остатка = {mln} млн (ожидалось {CONTROL_REST_MLN})")
    fails += 0 if ok else 1
    if a.dump:
        Path(a.dump).write_text(json.dumps({"money": res["money"], "schedule": res["schedule"]}, ensure_ascii=False), encoding="utf-8")
        print("Данные записаны:", a.dump)
    print("ИТОГ:", "расхождений нет" if not fails else f"расхождений: {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

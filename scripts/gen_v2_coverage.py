"""
Реестр охвата интерфейса V2: сверка «что есть в V1» ↔ «где это в V2» и сборка документов.

Источники:
  * `scripts/inventory_v1_ui.py` — инвентаризация V1 разбором разметки и токенизатором JS
    (меню «Действия», 83 модальных экрана, кнопки панели, области рабочих мест, обработчики → API);
  * `app/static/v2/screens.json` — курируемый реестр экранов V2: группа, чем закрыты элементы V1, риск,
    статус (1–6), проверки и ограничения (правится руками, статус — только по фактически выполненным проверкам).

Выходы:
  * `app/static/v2/screen-structure.json` — структура экранов V1 для каркасов V2 (генерируется, руками не править);
  * `Docs/v2-interface-coverage.md` — реестр охвата (генерируется, руками не править — правится screens.json).

Сверка полноты (падает с кодом 1):
  * каждый пункт меню, модальный экран и кнопка панели V1 закреплены хотя бы за одним экраном V2
    (или явно перечислены в `ignore` с причиной) — «ничего не потеряно»;
  * каждый закреплённый идентификатор существует в V1 (нет опечаток и устаревших ссылок).

Запуск:
    .venv/bin/python scripts/gen_v2_coverage.py            # пересобрать оба файла и проверить полноту
    .venv/bin/python scripts/gen_v2_coverage.py --check    # только проверка, ничего не писать
"""
import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inventory_v1_ui as inv  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCREENS = ROOT / "app" / "static" / "v2" / "screens.json"
STRUCT = ROOT / "app" / "static" / "v2" / "screen-structure.json"
DOC = ROOT / "Docs" / "v2-interface-coverage.md"

STATUS = {
    1: "не начат",
    2: "визуально готов",
    3: "подключено чтение",
    4: "подключены операции, проверка не завершена",
    5: "рабочий и проверенный",
    6: "заблокирован внешней причиной",
}
RISK = {
    "read": "только чтение",
    "edit": "правка данных",
    "bulk": "массовые операции",
    "import": "импорт/загрузка",
    "admin": "администрирование, права",
    "destructive": "необратимое удаление",
}


def git(*args):
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()
    except Exception:
        return "?"


def load():
    data = json.loads(SCREENS.read_text(encoding="utf-8"))
    return data


def check(data, d):
    menu_ids = {m["id"] for m in d["menu"]}
    modal_ids = {m["id"] for m in d["modals"]}
    tb_ids = {t["id"] for t in d["toolbar"]}
    region_ids = set(d["regions"])
    claimed = {"menu": set(), "modals": set(), "toolbar": set(), "regions": set()}
    problems = []
    seen_ids = set()
    for s in data["screens"]:
        if s["id"] in seen_ids:
            problems.append(f"повтор идентификатора экрана: {s['id']}")
        seen_ids.add(s["id"])
        for kind, universe in (("menu", menu_ids), ("modals", modal_ids), ("toolbar", tb_ids)):
            for i in s["v1"].get(kind, []):
                if i not in universe:
                    problems.append(f"{s['id']}: {kind} «{i}» нет в V1")
                claimed[kind].add(i)
        for r in s.get("regions", []):
            if r not in region_ids:
                problems.append(f"{s['id']}: область «{r}» нет в V1")
            claimed["regions"].add(r)
        if s["status"] not in STATUS:
            problems.append(f"{s['id']}: неизвестный статус {s['status']}")
        if s["group"] not in {g["id"] for g in data["groups"]}:
            problems.append(f"{s['id']}: неизвестная группа {s['group']}")
    ignore = set(data.get("ignore", {}))
    for kind, universe in (("menu", menu_ids), ("modals", modal_ids), ("toolbar", tb_ids)):
        for i in sorted(universe - claimed[kind] - ignore):
            problems.append(f"НЕ ЗАКРЕПЛЁН за экраном V2: {kind} «{i}»")
    return problems, {k: sorted(region_ids - claimed["regions"]) if k == "regions" else [] for k in ("regions",)}


def menu_path(m):
    return "Действия › " + " › ".join(m["path"] + [m["label"]]) if m["path"] else "Действия › " + m["label"]


def build_structure(data, d):
    menu = {m["id"]: m for m in d["menu"]}
    modals = {m["id"]: m for m in d["modals"]}
    tbs = {t["id"]: t for t in d["toolbar"]}
    out = {}
    for s in data["screens"]:
        entry = {"menu": [], "modals": [], "regions": [], "api": [], "calls": []}
        feats = []
        for i in s["v1"]["menu"]:
            m = menu[i]
            entry["menu"].append({"id": i, "label": m["label"], "path": m["path"], "feature": m["feature"], "kind": m["kind"], "dev": m["in_dev"], "danger": m["danger"]})
            if m["feature"]:
                feats.append([m["feature"].split(","), m["kind"] or "write"])
        for i in s["v1"]["modals"]:
            mo = modals[i]
            entry["modals"].append({"id": i, "title": mo["title"], "tabs": mo["tabs"], "structure": mo["structure"]})
        for i in s.get("regions", []):
            entry["regions"].append({"id": i, "structure": d["regions"][i]["structure"]})
        ids = list(s["v1"]["menu"]) + list(s["v1"]["toolbar"])
        for i in ids:
            h = d["handlers"].get(i)
            if h:
                entry["api"] = sorted(set(entry["api"]) | set(h["api"]))
                entry["calls"] = list(dict.fromkeys(entry["calls"] + h["calls"]))[:6]
        entry["toolbar"] = [{"id": i, "text": tbs[i]["text"]} for i in s["v1"]["toolbar"]]
        entry["menu_features"] = feats
        out[s["id"]] = entry
    return out


def cell(x):
    return str(x).replace("|", "\\|").replace("\n", " ")


def build_doc(data, d, struct, problems):
    sc = data["screens"]
    by_group = {g["id"]: [s for s in sc if s["group"] == g["id"]] for g in data["groups"]}
    lines = []
    w = lines.append
    w("# Реестр охвата интерфейса V2")
    w("")
    w("> Файл **генерируется** скриптом `scripts/gen_v2_coverage.py` из инвентаризации V1 (`scripts/inventory_v1_ui.py`) и")
    w("> курируемого реестра `app/static/v2/screens.json`. Руками не править: правится `screens.json`, затем скрипт запускается заново.")
    w("")
    w(f"- Ветка: `{git('rev-parse', '--abbrev-ref', 'HEAD')}`, версия: `{git('rev-parse', '--short', 'HEAD')}` (на момент генерации), дата: {date.today().isoformat()}.")
    c = d["checks"]
    w(f"- Инвентаризация V1 (разбор разметки + токенизатор JS, а не регулярка): пунктов меню «Действия» — **{len(d['menu'])}**, модальных экранов — **{len(d['modals'])}**, "
      f"кнопок панели вне меню и модалок — **{len(d['toolbar'])}**, областей рабочих мест — **{len(d['regions'])}**, обработчиков по id — **{d['handlers_total']}**.")
    w(f"- Самопроверка инвентаризации: `id` в разметке разбором {c['id_в_разметке_разбором']} = текстом {c['id_в_разметке_текстом']}; `getElementById` токенами {c['getElementById_токенами']} = текстом {c['getElementById_текстом']}; "
      f"токенов JS {c['токенов']}, функций верхнего уровня {c['функций_верхнего_уровня']}.")
    if problems:
        w("- **СВЕРКА ПОЛНОТЫ НЕ ПРОЙДЕНА:**")
        for p in problems:
            w(f"  - {p}")
    else:
        w("- Сверка полноты пройдена: каждый пункт меню, модальный экран и кнопка панели V1 закреплены за экраном V2; закреплённых несуществующих идентификаторов нет.")
    w("")
    w("## Как читать")
    w("")
    w("Статусы реализации: " + "; ".join(f"**{k}** — {v}" for k, v in STATUS.items()) + ".")
    w("")
    w("«Переход в V1» (столбец **Переход**) — экран V2 существует и ведёт человека в нужную форму V1 с контекстом объекта; это обеспечивает **доступность**, но **не считается переносом**.")
    w("Статус «5» присваивается только при выполнении ВСЕХ критериев на актуальной версии (данные с настоящего backend, сохранения подтверждены повторным чтением, отмена не пишет, ошибка не уничтожает ввод, права, разрешения, отсутствие новых JS-ошибок, V1 работоспособен).")
    w("")
    # сводка
    w("## Сводка")
    w("")
    w("| Статус | Экранов |")
    w("| --- | --- |")
    for k, v in STATUS.items():
        w(f"| {k} — {v} | {sum(1 for s in sc if s['status'] == k)} |")
    w(f"| **Всего экранов V2** | **{len(sc)}** |")
    w("")
    vonly = [s for s in sc if s["impl"] == "v1"]
    w(f"Экранов, где операции доступны **только через переход в V1**: {len(vonly)} из {len(sc)}. Экранов с реальным чтением или операциями в V2: {len(sc) - len(vonly)}.")
    w("")
    w("| Группа | Экранов | Статусы (1/2/3/4/5/6) |")
    w("| --- | --- | --- |")
    for g in data["groups"]:
        ss = by_group[g["id"]]
        w(f"| {g['title']} | {len(ss)} | " + " / ".join(str(sum(1 for s in ss if s['status'] == k)) for k in STATUS) + " |")
    w("")
    for g in data["groups"]:
        ss = by_group[g["id"]]
        if not ss:
            continue
        w(f"## {g['title']}")
        w("")
        w("| Идентификатор | Экран | Путь в V1 | Путь в V2 | Модуль V1 → API | Права | Изменяющие операции, риск | Статус | Переход | Проверки | Ограничения |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for s in ss:
            st = struct[s["id"]]
            v1paths = []
            for m in st["menu"]:
                mm = next(x for x in d["menu"] if x["id"] == m["id"])
                v1paths.append(menu_path(mm))
            for t in st["toolbar"]:
                v1paths.append(f"Панель: «{t['text'] or t['id']}» (`{t['id']}`)")
            if not v1paths:
                v1paths = ["—"]
            feats = []
            for names, kind in st["menu_features"]:
                feats.append("/".join(names) + ":" + kind)
            feats += [f"{'/'.join(x[0])}:{x[1]}" for x in s.get("feature", [])]
            feats = list(dict.fromkeys(feats)) or ["без ограничения по разделам"]
            api = st["api"][:5]
            mod = ", ".join(f"`{c}`" for c in st["calls"][:3]) or "—"
            v2 = "модуль `" + s["impl"].split(":", 1)[1] + "`" if s["impl"].startswith("module:") else ("чтение из API" if s["impl"] == "read" else "каркас")
            modals = ", ".join(f"`{m['id']}`" for m in st["modals"])
            transition = "нет (перенесено)" if s["impl"].startswith("module:") else ("частично" if s["impl"] == "read" else "да")
            w("| " + " | ".join(cell(x) for x in [
                s["id"], s["title"] + (f" (модалки: {modals})" if modals else ""),
                "; ".join(v1paths), f"`#/{s['id']}` ({v2})",
                mod + (" → " + ", ".join(f"`{a}`" for a in api) if api else ""),
                ", ".join(feats), f"{RISK.get(s['risk'], s['risk'])}" + (f". {s['ops']}" if s.get("ops") else ""),
                f"{s['status']} — {STATUS[s['status']]}", transition,
                s.get("checks", "не проводились"), s.get("limits", "—")]) + " |")
        w("")
    w("## Области рабочих мест V1, не являющиеся модальными экранами")
    w("")
    w("Статическая разметка этих областей есть в `index.html`; большая часть содержимого строится JS динамически (списки, панели АРМ, контекстное меню) и в статической инвентаризации не видна — она описывается в карточке соответствующего экрана по фактическому поведению.")
    w("")
    w("| Область | Строка index.html | Блоков в статической разметке | Закреплена за экраном |")
    w("| --- | --- | --- | --- |")
    owner = {}
    for s in sc:
        for r in s.get("regions", []):
            owner.setdefault(r, []).append(s["id"])
    for rid, rv in d["regions"].items():
        w(f"| `{rid}` | {rv['line']} | {len(rv['structure'])} | {', '.join(owner.get(rid, [])) or '**не закреплена**'} |")
    w("")
    w("## Заблокировано внешней причиной (статус 6)")
    w("")
    blocked = [s for s in sc if s["status"] == 6]
    if blocked:
        for s in blocked:
            w(f"- `{s['id']}` — {s['title']}: {s.get('limits', '')}")
    else:
        w("Нет.")
    w("")
    w("## Backlog новых идей (НЕ реализуется в рамках задания)")
    w("")
    w("Функции, которых не было в V1 и в согласованных заданиях, сюда только записываются.")
    w("")
    for item in data.get("backlog", []):
        w(f"- {item}")
    if not data.get("backlog"):
        w("Пока пусто.")
    w("")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    d = inv.build()
    data = load()
    problems, _ = check(data, d)
    struct = build_structure(data, d)
    if not a.check:
        STRUCT.write_text(json.dumps(struct, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        DOC.write_text(build_doc(data, d, struct, problems), encoding="utf-8")
    print(f"экранов V2: {len(data['screens'])}; проблем: {len(problems)}")
    for p in problems:
        print("  -", p)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()

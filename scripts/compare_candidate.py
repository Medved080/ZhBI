"""Сравнение кандидата Qwen с эталонной моделью поставщика для того же изделия (замер точности чтения чертежей, 2026-10-04).

    .venv312/bin/python scripts/compare_candidate.py <экспорт задания Qwen.json> [<id эталонной модели>]

Экспорт — «Скачать результат и QA» в окне «Обработка изделий · Qwen» (`GET /calc/api/recovery/jobs/{id}/export`). Эталон берётся из
каталога калькулятора (assets), по умолчанию — модель задания. Сравниваются габариты, объём бетона, число и длины стержней по диаметрам,
состав металлических деталей по группам. Базу данных скрипт не открывает; нужен ZHBI_CALC_ASSETS_DIR/ZHBI_CALC_DIR как у сервиса."""
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.calc.document_models import model  # noqa: E402


def volume(solid):
    total = 0.0
    for part in solid.get("concreteParts") or []:
        pts = part.get("profile") or []
        if len(pts) < 3 or not isinstance(pts[0], list):
            continue
        area = abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2
        for hole in part.get("holes") or []:
            if hole.get("type") == "circle":
                area -= math.pi * hole["radius"] ** 2
            elif hole.get("points"):
                hp = hole["points"]
                area -= abs(sum(hp[i][0] * hp[(i + 1) % len(hp)][1] - hp[(i + 1) % len(hp)][0] * hp[i][1] for i in range(len(hp)))) / 2
        total += area * part["depth"]
    return total / 1e9


def bars(solid):
    count, length = Counter(), defaultdict(float)
    for group in solid.get("groups") or []:
        for path in group.get("paths") or []:
            pts = path.get("points") or []
            d = path.get("diameter")
            count[d] += 1
            length[d] += sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    return count, length


def metal(solid):
    return Counter((p.get("group") or "?") for p in solid.get("metalParts") or [])


def ratio(a, b):
    return 100.0 if a == b else (100 * min(a, b) / max(a, b) if a and b else 0.0)


def main():
    export = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cand = export["drawing"]["solidModel"]
    ref_id = sys.argv[2] if len(sys.argv) > 2 else export["drawing"].get("id", "").replace("candidate-", "")
    ref_entry = model(ref_id) if ref_id else None
    if not ref_entry or not ref_entry.get("solidModel"):
        raise SystemExit("Нет эталона: укажите id модели поставщика (второй аргумент)")
    ref = ref_entry["solidModel"]
    rows = []
    for axis, (rb, cb) in zip("XYZ", zip(zip(*ref["bounds"]), zip(*cand["bounds"]))):
        rows.append(("габарит %s, мм" % axis, rb[1] - rb[0], cb[1] - cb[0]))
    rows.append(("объём бетона, м³", volume(ref), volume(cand)))
    rc, rl = bars(ref)
    cc, cl = bars(cand)
    for d in sorted(set(rc) | set(cc), key=lambda x: (x is None, x)):
        rows.append(("стержни Ø%s, шт" % d, rc[d], cc[d]))
        rows.append(("стержни Ø%s, длина, м" % d, rl[d] / 1000, cl[d] / 1000))
    rm, cm = metal(ref), metal(cand)
    for g in sorted(set(rm) | set(cm)):
        rows.append(("металл «%s», шт" % g, rm[g], cm[g]))
    print("%-34s %12s %12s %8s" % ("показатель", "эталон", "кандидат", "совпало"))
    scores = []
    for name, a, b in rows:
        s = ratio(a, b)
        scores.append(s)
        print("%-34s %12.3f %12.3f %7.0f%%" % (name, a, b, s))
    print("\nсреднее совпадение: %.0f%%; точных (≥99%%): %d из %d" % (sum(scores) / len(scores), sum(1 for s in scores if s >= 99), len(scores)))
    print("замечаний кандидата: %d, не завершено: %d (эталон — замечаний %d)" % (len((export.get("draft") or {}).get("issues") or []), len((export.get("draft") or {}).get("pending") or []), len(ref.get("issues") or [])))


if __name__ == "__main__":
    main()

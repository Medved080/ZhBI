"""
Поиск в текстовом слое PDF-комплекта подписей, по которым можно определить
материал окон (ПВХ / тёплый алюминий / холодный алюминий) для категорий
классификатора видов работ (`Docs/TZ.md` §3в.2).

Печатает только строки с ключевыми словами и номер листа — без остального
текста чертежа. Запуск:  .venv/bin/python -I scripts/pdf_window_text_scan.py <файл.pdf>
"""

import re
import sys

import fitz

KEYWORDS = re.compile(
    r"пвх|pvc|алюм|\bal\b|витраж|остеклен|оконн|окон|заполнени|спк|профил|"
    r"тепл[ыо]й|холодн|\bОК[-\s]?\d|\bВТ[-\s]?\d|\bВ[-\s]?\d+\b",
    re.IGNORECASE)


def main(path: str) -> None:
    doc = fitz.open(path)
    for number, page in enumerate(doc, 1):
        seen = set()
        for line in page.get_text("text").splitlines():
            line = line.strip()
            if line and KEYWORDS.search(line) and line not in seen:
                seen.add(line)
                print("лист %d: %s" % (number, line[:160]))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

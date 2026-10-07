"""Прайс-лист роутера red_mad_robot (docx) -> app/rmr_prices.json.

    python scripts/import_rmr_prices.py "/путь/Прайс-лист_red_mad_router_RUB.docx"

Нужен только стандартный Python. Цены в файле — рубли РФ за 1 млн токенов БЕЗ НДС и с наценкой
сервиса (так они указаны в прайс-листе); курс, дата курса, наценка и ставка НДС читаются из
вводных абзацев документа. Прайс меняется — запустите скрипт заново и закоммитьте JSON.
"""
from __future__ import annotations

import html
import json
import re
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "app" / "rmr_prices.json"


def num(text: str):
    text = text.replace("\xa0", " ").replace(" ", "").replace(",", ".").strip()
    return None if text in ("", "—", "-") else float(text)


def kind(name: str) -> str:
    low = name.lower()
    if "embedding" in low:
        return "embedding"
    if any(w in low for w in ("image", "sora", "veo", "whisper")):
        return "media"
    if any(w in low for w in ("search-preview", "deep-research")):
        return "search"
    return "chat"


def parse(path: str) -> dict:
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8")
    cell = lambda c: html.unescape(" ".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", c))).strip()
    intro = " ".join(cell(p) for p in re.findall(r"<w:p[ >].*?</w:p>", re.sub(r"<w:tbl>.*?</w:tbl>", "", xml, flags=re.S), flags=re.S))
    rate = re.search(r"на (\d{2}\.\d{2}\.\d{4}) — ([\d,]+) рубл", intro)
    markup = re.search(r"наценку сервиса (\d+)%", intro)
    vat = re.search(r"НДС (\d+)%", intro)
    models = []
    for row in re.findall(r"<w:tr[ >].*?</w:tr>", xml, flags=re.S):
        cells = [cell(c) for c in re.findall(r"<w:tc>.*?</w:tc>", row, flags=re.S)]
        if len(cells) < 7 or not cells[0].isdigit():
            continue
        raw = re.sub(r"\s+", " ", cells[1]).strip()
        tier = re.search(r"\(([^)]*)\)", raw)
        base = re.sub(r"\s*\([^)]*\)", "", raw).strip()
        models.append({"id": base, "provider": cells[2], "tier": tier.group(1) if tier else "",
                       "input": num(cells[3]), "output": num(cells[4]), "cache_read": num(cells[5]),
                       "cache_write": num(cells[6]), "kind": kind(base)})
    return {"source": Path(path).name, "currency": "RUB", "unit": "за 1 млн токенов",
            "fx_date": rate.group(1) if rate else "", "fx_rate": num(rate.group(2)) if rate else None,
            "markup_percent": int(markup.group(1)) if markup else 15,
            "vat_percent": int(vat.group(1)) if vat else 22, "vat_included": False, "models": models}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    data = parse(sys.argv[1])
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(data['models'])} строк прайса -> {OUT}; курс {data['fx_rate']} на {data['fx_date']}")

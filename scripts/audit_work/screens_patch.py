"""Правка записей СВОИХ экранов в app/static/v2/screens.json (аудит «рабочие места и отчёты»): тот же формат файла,
что у scripts/v2_screens_tool.py (один экран — одна строка). Использование: python3 screens_patch.py <json-патч>,
где патч — {id: {поле: значение, ...}}; вложенные пути — через точку ("read.note"), null — удалить поле."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from v2_screens_tool import load, save  # noqa: E402

MINE = {"ws-mfr", "ws-picker", "report-status", "report-dynamics", "report-mywork", "report-analytics", "report-block-status",
        "report-block-schedule", "report-linear-track", "element-catalog"}


def set_path(obj, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        obj = obj[int(k)] if isinstance(obj, list) else obj.setdefault(k, {})
    last = keys[-1]
    if isinstance(obj, list):
        obj[int(last)] = value
    elif value is None:
        obj.pop(last, None)
    else:
        obj[last] = value


patch = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")) if len(sys.argv) > 1 else json.load(sys.stdin)
data = load()
for sid, fields in patch.items():
    if sid not in MINE:
        sys.exit(f"чужой экран: {sid}")
    scr = next(s for s in data["screens"] if s["id"] == sid)
    for path, value in fields.items():
        set_path(scr, path, value)
save(data)
print("изменено:", ", ".join(patch))

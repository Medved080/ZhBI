"""Проверка исправленного дефекта app/zone_sync.py (Docs/v2-progress/exchange.md, «Найденное, но не исправленное»):
повторная загрузка чертежа, где полигон зоны теряет подпись (опознание вне допуска), пыталась вставить новую
запись справочника с уже занятым dxf_handle -> необработанный IntegrityError -> 500. Исправление — ZoneSyncConflict
(app/zone_sync.py) ловится в app/dxf_import.py и превращается в понятный отказ 409, без изменения смысла зон.

Работает НАПРЯМУЮ с zone_sync.sync_zones() (минуя разбор DXF — ZoneRecord это обычный dataclass, датчик тот же,
что использует scripts/zone_parser.py), на ВРЕМЕННОЙ копии обезличенной БД. Ничего не пишет в исходные файлы.

Запуск:  .venv/bin/python scripts/verify_zone_sync_conflict.py [путь к обезличенной БД]
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "zhbi-tool" / "data" / "zhbi.anon.db"

FAILS = []
OK = 0


def check(cond, msg):
    global OK
    if cond:
        OK += 1
        print("  ok  ", msg)
    else:
        FAILS.append(msg)
        print("  FAIL", msg)


def main():
    if not SRC.is_file():
        sys.exit(f"не найдена обезличенная копия БД: {SRC}")
    with tempfile.TemporaryDirectory(prefix="zhbi_zonesync_") as tmp:
        dst = Path(tmp) / "work.db"
        shutil.copy(SRC, dst)
        os.environ["ZHBI_DB_PATH"] = str(dst)

        from app.db import get_connection
        from app import zone_sync
        from scripts.zone_parser import ZoneRecord

        conn = get_connection()
        OBJ = conn.execute("SELECT id FROM objects WHERE kind = 'zhbi' ORDER BY id LIMIT 1").fetchone()["id"]
        outline = [(0, 0), (1000, 0), (1000, 1000), (0, 1000)]
        FILE = "zonesync_conflict_test.dxf"

        # первая загрузка: подпись распознана, заводит запись справочника
        r1 = zone_sync.sync_zones(conn, OBJ, FILE, [
            ZoneRecord(handle="ZH_CONFLICT_TEST", category="Захватка", elevation_mm=None, outline=outline,
                      name="Захватка 01", match_status="matched"),
        ])
        check(len(r1) == 1, f"первая загрузка: запись справочника заведена ({r1})")
        row = conn.execute("SELECT id, name, number FROM zones WHERE dxf_handle = 'ZH_CONFLICT_TEST'").fetchone()
        check(row is not None and row["number"] == 1, f"первая загрузка: номер зоны распознан ({dict(row) if row else None})")
        zone_id_before = row["id"]

        # вторая загрузка ТОГО ЖЕ чертежа: тот же dxf_handle, подпись потеряна (вне допуска) -> name=None, номер не определяется
        raised = None
        try:
            zone_sync.sync_zones(conn, OBJ, FILE, [
                ZoneRecord(handle="ZH_CONFLICT_TEST", category="Захватка", elevation_mm=None, outline=outline,
                          name=None, match_status="unmatched"),
            ])
        except zone_sync.ZoneSyncConflict as e:
            raised = e
        except sqlite3.IntegrityError as e:
            check(False, f"НЕ ИСПРАВЛЕНО: необработанный IntegrityError вместо ZoneSyncConflict ({e})")
        check(raised is not None, f"вторая загрузка (подпись потеряна): ZoneSyncConflict вместо падения{' — ' + raised.message if raised else ''}")
        if raised:
            check("Захватка" in raised.message and "ZH_CONFLICT_TEST" in raised.message, "сообщение называет категорию и handle полигона")

        # состояние БД не повреждено: первая запись осталась как была, дубля/частичной вставки нет
        rows = conn.execute("SELECT id, name, number FROM zones WHERE dxf_handle = 'ZH_CONFLICT_TEST'").fetchall()
        check(len(rows) == 1 and rows[0]["id"] == zone_id_before and rows[0]["name"] == "Захватка 01",
              f"откат: осталась ровно первая запись без изменений ({[dict(r) for r in rows]})")
        levels = conn.execute("SELECT zone_id FROM zone_levels WHERE dxf_handle = 'ZH_CONFLICT_TEST'").fetchall()
        check(len(levels) == 1, f"откат: ровно один ярус (без дублей от неудавшейся второй загрузки, найдено {len(levels)})")

        # третья загрузка: подпись снова опознаётся как раньше — конфликта нет, обновляет ту же запись
        r3 = zone_sync.sync_zones(conn, OBJ, FILE, [
            ZoneRecord(handle="ZH_CONFLICT_TEST", category="Захватка", elevation_mm=None, outline=outline,
                      name="Захватка 01", match_status="matched"),
        ])
        check(list(r3.values())[0][0] == zone_id_before, "восстановленная подпись: та же запись справочника, без дублей")
        conn.close()

    print(f"\nПроверок пройдено: {OK}, не пройдено: {len(FAILS)}")
    for f in FAILS:
        print("  НЕ ПРОЙДЕНО:", f)
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()

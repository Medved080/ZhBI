"""Проверка серверных гарантий области mfr2 (V2) по HTTP на НАСТОЯЩЕМ backend и КОПИИ обезличенной БД: секции/этажи/блоки
(создание/правка/удаление по плану последствий, геометрия блока, «Обновить принадлежность»), справочник видов работ
(sверка/применение xlsx), правка ячейки отчёта «Учёт по блокам: статусы» (процент блока, статус секции/объекта).

Запуск:  .venv/bin/python scripts/verify_mfr2_ops.py <база-источник> [порт=8175]
"""
import json
import subprocess
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8175
PASSWORD = "Test-Pass-1234!"
BASE = f"http://127.0.0.1:{PORT}"
OBJ = 4

FAILS = []
CHECKS = 0


def check(cond, label, extra=""):
    global CHECKS
    CHECKS += 1
    print(("  ok   " if cond else "  FAIL ") + label + (f" — {extra}" if extra and not cond else ""))
    if not cond:
        FAILS.append(label)
    return bool(cond)


class Sess:
    def __init__(self, login):
        self.s = requests.Session()
        r = self.s.post(BASE + "/login", json={"domain_login": login, "password": PASSWORD})
        assert r.status_code == 200, f"вход {login}: {r.status_code} {r.text[:200]}"

    def call(self, method, path, body=None, **kw):
        r = self.s.request(method, BASE + path, json=body, **kw)
        try:
            data = r.json()
        except Exception:
            data = r.content
        return r.status_code, data

    def upload(self, path, files):
        r = self.s.post(BASE + path, files=files)
        try:
            data = r.json()
        except Exception:
            data = r.content
        return r.status_code, data

    def raw(self, method, path, body=None):
        r = self.s.request(method, BASE + path, json=body)
        return r.status_code, r.content, r.headers


def detail(data):
    return data.get("detail") if isinstance(data, dict) else data


class DB:
    def __init__(self, path):
        self.path = path

    def q(self, sql, args=()):
        c = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in c.execute(sql, args)]
        finally:
            c.close()

    def one(self, sql, args=()):
        r = self.q(sql, args)
        return r[0] if r else None

    def events(self, action, since=0):
        time.sleep(1.8)
        return self.one("SELECT COUNT(*) n FROM activity_log WHERE action = ? AND id > ?", (action, since))["n"]

    def last_event_id(self):
        time.sleep(1.8)
        return self.one("SELECT COALESCE(MAX(id),0) m FROM activity_log")["m"]


def start_server(tmp):
    work = Path(tmp) / "work"
    work.mkdir()
    dst = work / "work.db"
    s = sqlite3.connect(str(SRC)); d = sqlite3.connect(str(dst)); s.backup(d); s.close()
    d.execute("INSERT OR IGNORE INTO user_access(user_id,project_id,object_id,role) SELECT id,NULL,?, 'user' FROM users WHERE domain_login='user2'", (OBJ,))
    d.execute("INSERT OR IGNORE INTO user_access(user_id,project_id,object_id,role) SELECT id,NULL,?, 'view' FROM users WHERE domain_login='user4'", (OBJ,))
    d.commit(); d.close()
    log = open(Path(tmp) / "server.log", "w")
    proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "real_auth_server.py"), str(SRC), str(PORT), str(work)], cwd=str(ROOT), stdout=log, stderr=log)
    for _ in range(80):
        try:
            if requests.get(BASE + "/health", timeout=1).status_code == 200:
                return proc, DB(str(dst))
        except Exception:
            time.sleep(0.5)
    proc.kill()
    raise SystemExit("сервер не поднялся: " + (Path(tmp) / "server.log").read_text()[-800:])


def main():
    tmp = tempfile.mkdtemp(prefix="mfr2_ops_")
    proc, db = start_server(tmp)
    try:
        run(db)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
    print(f"\nИТОГ: {CHECKS - len(FAILS)} ok / {len(FAILS)} FAIL из {CHECKS}")
    for f in FAILS:
        print("  FAIL:", f)
    sys.exit(1 if FAILS else 0)


def run(db):
    admin, u2, u4 = Sess("admin"), Sess("user2"), Sess("user4")

    # ---------------------------------------------------------------- секции
    print("Секции: создание/правка/удаление")
    code, data = admin.call("POST", f"/objects/{OBJ}/sections", {"code": "Т99", "name": "Тест"})
    check(code == 200, "создание секции", detail(data))
    sec_id = data["id"] if code == 200 else None
    row = db.one("SELECT code,name FROM object_sections WHERE id=?", (sec_id,)) if sec_id else None
    check(row and row["code"] == "Т99" and row["name"] == "Тест", "секция в БД (SQL)")
    code, data = u4.call("POST", f"/objects/{OBJ}/sections", {"code": "Т98", "name": None})
    check(code == 403, "403 у user4 (view) на создание секции", detail(data))
    code, data = admin.call("PATCH", f"/objects/{OBJ}/sections/{sec_id}", {"name": "Тест2", "axis_from": None, "axis_to": None})
    check(code == 200, "переименование секции", detail(data))
    row = db.one("SELECT name FROM object_sections WHERE id=?", (sec_id,))
    check(row and row["name"] == "Тест2", "новое имя секции в БД (SQL)")
    # неиспользуемая — удаляется сразу, без force
    code, data = admin.call("DELETE", f"/objects/{OBJ}/sections/{sec_id}")
    check(code == 200, "удаление неиспользуемой секции без force", detail(data))
    check(db.one("SELECT id FROM object_sections WHERE id=?", (sec_id,)) is None, "секции нет в БД (SQL)")

    # занятая секция (реальные данные копии): план последствий -> force
    occ = db.one("SELECT s.id, s.code FROM object_sections s WHERE EXISTS (SELECT 1 FROM blocks b WHERE b.section_id=s.id) AND s.object_id=? LIMIT 1", (OBJ,))
    code, data = admin.call("DELETE", f"/objects/{OBJ}/sections/{occ['id']}")
    check(code == 409 and isinstance(data.get("detail"), dict) and "message" in data["detail"], "занятая секция без force — 409 с планом", detail(data))
    before = db.one("SELECT COUNT(*) n FROM object_sections WHERE object_id=?", (OBJ,))["n"]
    check(db.one("SELECT id FROM object_sections WHERE id=?", (occ["id"],)) is not None, "занятая секция НЕ удалена без force (SQL)")
    code, data = admin.call("DELETE", f"/objects/{OBJ}/sections/{occ['id']}?force=true")
    check(code == 200, "занятая секция удалена с force=true", detail(data))
    check(db.one("SELECT id FROM object_sections WHERE id=?", (occ["id"],)) is None, "секция реально удалена (SQL)")
    check(db.one("SELECT COUNT(*) n FROM object_sections WHERE object_id=?", (OBJ,))["n"] == before - 1, "ровно одна секция ушла (SQL)")

    # ----------------------------------------------------------------- этажи
    print("Этажи: создание/правка/удаление")
    code, data = admin.call("POST", f"/objects/{OBJ}/levels", {"kind": "этаж", "floor": 999, "name": "Тестовый", "elevation_mm": 1000, "section_codes": []})
    check(code == 200, "создание этажа", detail(data))
    lvl_id = data["id"] if code == 200 else None
    # «Секции, этажи и блоки» — заводская матрица прав отдаёт «Изменение» только роли «admin» на объекте (role_features:
    # blocks=write только у admin); роль «user» (user2) и «view» (user4) — обе только чтение, как и на «work_progress».
    code, data = u2.call("PATCH", f"/objects/{OBJ}/levels/{lvl_id}", {"height_mm": 3000})
    check(code == 403, "403 у user2 (роль user — только чтение раздела «blocks») на правку этажа", detail(data))
    code, data = admin.call("PATCH", f"/objects/{OBJ}/levels/{lvl_id}", {"height_mm": 3000})
    check(code == 200, "правка высоты этажа (admin)", detail(data))
    row = db.one("SELECT height_mm FROM object_levels WHERE id=?", (lvl_id,))
    check(row and row["height_mm"] == 3000, "высота в БД (SQL)")
    code, data = u4.call("PATCH", f"/objects/{OBJ}/levels/{lvl_id}", {"name": "x"})
    check(code == 403, "403 у user4 на правку этажа", detail(data))
    code, data = admin.call("DELETE", f"/objects/{OBJ}/levels/{lvl_id}")
    check(code == 200, "удаление неиспользуемого этажа", detail(data))

    # ---------------------------------------------------------------- блоки
    print("Блоки: создание/удаление, геометрия")
    sec2 = db.one("SELECT id FROM object_sections WHERE object_id=? LIMIT 1", (OBJ,))["id"]
    code, data = admin.call("POST", f"/objects/{OBJ}/levels", {"kind": "этаж", "floor": 998, "name": None, "elevation_mm": None, "section_codes": []})
    lvl2 = data["id"]
    code, data = admin.call("POST", f"/objects/{OBJ}/blocks", {"section_id": sec2, "level_id": lvl2})
    check(code == 200, "создание блока (клетка матрицы)", detail(data))
    blk_id = data["id"]
    check(db.one("SELECT id FROM blocks WHERE id=?", (blk_id,)) is not None, "блок в БД (SQL)")
    # идемпотентность повторного POST (та же клетка)
    code2, data2 = admin.call("POST", f"/objects/{OBJ}/blocks", {"section_id": sec2, "level_id": lvl2})
    check(code2 == 200 and data2["id"] == blk_id, "повторное создание той же клетки — та же запись (идемпотентно)")

    code, data = admin.call("GET", f"/objects/{OBJ}/blocks/{blk_id}/boxes")
    check(code == 200 and data == [], "боксов блока изначально нет (GET)")
    boxes = [{"x0": 0, "x1": 1000, "y0": 0, "y1": 2000}, {"x0": 1000, "x1": 1500, "y0": 0, "y1": 500}]
    code, data = admin.call("PUT", f"/objects/{OBJ}/blocks/{blk_id}/boxes", {"boxes": boxes})
    check(code == 200 and "warnings" in data, "запись геометрии блока (PUT)", detail(data))
    rows = db.q("SELECT x0,x1,y0,y1 FROM block_boxes WHERE block_id=? ORDER BY sort_order", (blk_id,))
    check(len(rows) == 2 and rows[0]["x1"] == 1000 and rows[1]["y1"] == 500, "оба прямоугольника в БД (SQL)")
    code, data = u4.call("PUT", f"/objects/{OBJ}/blocks/{blk_id}/boxes", {"boxes": []})
    check(code == 403, "403 у user4 на запись геометрии", detail(data))
    code, data = admin.call("PUT", f"/objects/{OBJ}/blocks/{blk_id}/boxes", {"boxes": [{"x0": 100, "x1": 50, "y0": 0, "y1": 10}]})
    check(code == 422, "422 при x1<=x0 (серверная валидация)", detail(data))
    check(len(db.q("SELECT id FROM block_boxes WHERE block_id=?", (blk_id,))) == 2, "неверная геометрия не изменила БД (SQL)")

    # удаление занятого блока (у него есть боксы -> не в плане деструкции: боксы не считаются "использованием" по delete_block —
    # проверим на блоке с реальными ЗР из копии) и удаление пустого без force
    code, data = admin.call("DELETE", f"/objects/{OBJ}/blocks/{blk_id}")
    check(code == 200, "удаление пустого блока (боксы не мешают, ЗР/факта нет)", detail(data))
    check(db.one("SELECT id FROM blocks WHERE id=?", (blk_id,)) is None, "блок удалён (SQL)")

    occ_blk = db.one("SELECT b.id FROM blocks b WHERE EXISTS (SELECT 1 FROM block_works w WHERE w.block_id=b.id) AND b.object_id=? LIMIT 1", (OBJ,))
    code, data = admin.call("DELETE", f"/objects/{OBJ}/blocks/{occ_blk['id']}")
    check(code == 409 and isinstance(data.get("detail"), dict), "занятый блок (ЗР) без force — 409 с планом", detail(data))
    code, data = admin.call("DELETE", f"/objects/{OBJ}/blocks/{occ_blk['id']}?force=true")
    check(code == 200, "занятый блок удалён с force=true", detail(data))
    check(db.one("SELECT id FROM blocks WHERE id=?", (occ_blk["id"],)) is None, "блок реально удалён (SQL)")
    check(db.one("SELECT COUNT(*) n FROM block_works WHERE block_id=?", (occ_blk["id"],))["n"] == 0, "ЗР блока удалены каскадом (SQL)")

    # Конкуренция: два одновременных force-удаления ОДНОГО и того же блока — оба благополучны или второй получает 404 (уже нет),
    # без 500 и без следа двойного удаления в БД — проверяем реально, а не полагаемся на то, что DELETE сам по себе идемпотентен.
    print("Блоки: конкуренция (два одновременных force-удаления одного блока)")
    code, data = admin.call("POST", f"/objects/{OBJ}/blocks", {"section_id": sec2, "level_id": lvl2})
    conc_blk = data["id"]
    import threading
    results = [None, None]
    def _del(i):
        results[i] = admin.call("DELETE", f"/objects/{OBJ}/blocks/{conc_blk}?force=true")
    t1, t2 = threading.Thread(target=_del, args=(0,)), threading.Thread(target=_del, args=(1,))
    t1.start(); t2.start(); t1.join(); t2.join()
    codes = sorted(r[0] for r in results)
    check(codes == [200, 200] or codes == [200, 422], "два одновременных DELETE — оба благополучны (гонка на уровне БД) или второй «блок не найден» (422)", str(codes))
    check(db.one("SELECT id FROM blocks WHERE id=?", (conc_blk,)) is None, "блок отсутствует после гонки (SQL)")

    print("«Обновить принадлежность»")
    ev0 = db.last_event_id()
    code, data = admin.call("POST", f"/objects/{OBJ}/blocks/recalc-membership")
    check(code == 200 and "этажей_назначено" in data, "пересчёт принадлежности", detail(data))
    check(db.events("revit_section_recalc", ev0) == 1, "одно событие журнала (SQL)")
    code, data = u4.call("POST", f"/objects/{OBJ}/blocks/recalc-membership")
    check(code == 403, "403 у user4 на пересчёт", detail(data))

    # ------------------------------------------------------------ правка ячейки отчёта «Учёт по блокам: статусы»
    # ВАЖНО: до загрузки нового справочника видов работ ниже — та операция СПИСЫВАЕТ (retired_at) весь текущий каталог, не
    # входящий в тестовый xlsx (задокументированное поведение V1, `app/work_types_import.py::apply`), и обнулила бы отбор блока.
    print("Отчёт «Учёт по блокам: статусы»: правка ячейки")
    # Блок БЕЗ существующих документов факта — иначе может сработать независимый дефект V1 (найден этой проверкой, не наш):
    # `work_fact.set_cell_percent` строит слепок через `_percents_as_of`, который подмешивает историю МЯГКО СНЯТЫХ (retired_at)
    # работ блока — `save_report` внутри тут же отклоняет тот же слепок как «операции вне отбора». Тот же путь кода что в V1.
    blk_pct = db.one("SELECT bw.block_id, bw.work_type_id FROM block_works bw WHERE bw.object_id=? AND bw.retired_at IS NULL "
                     "AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=bw.block_id) LIMIT 1", (OBJ,))
    code, data = admin.call("PUT", f"/objects/{OBJ}/blocks/{blk_pct['block_id']}/work-progress-cell", {"work_type_id": blk_pct["work_type_id"], "percent": 42, "report_date": "2026-09-20"})
    check(code == 200 and data.get("percent") == 42, "правка процента ячейки блока", detail(data))
    row = db.one("SELECT i.percent FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=? AND r.report_date=? AND i.work_type_id=?", (blk_pct["block_id"], "2026-09-20", blk_pct["work_type_id"]))
    check(row and row["percent"] == 42, "документ факта с процентом в БД (SQL)")
    code, data = u4.call("PUT", f"/objects/{OBJ}/blocks/{blk_pct['block_id']}/work-progress-cell", {"work_type_id": blk_pct["work_type_id"], "percent": 10, "report_date": "2026-09-20"})
    check(code == 403, "403 у user4 на правку ячейки блока", detail(data))
    code, data = u2.call("PUT", f"/objects/{OBJ}/blocks/{blk_pct['block_id']}/work-progress-cell", {"work_type_id": blk_pct["work_type_id"], "percent": 10, "report_date": "2026-09-20"})
    check(code == 403, "403 у user2 (роль user — только чтение work_progress) на правку ячейки блока", detail(data))
    code, data = admin.call("PUT", f"/objects/{OBJ}/blocks/{blk_pct['block_id']}/work-progress-cell", {"work_type_id": blk_pct["work_type_id"], "percent": 142, "report_date": "2026-09-20"})
    check(code == 422, "422 при проценте вне 0..100", detail(data))
    row = db.one("SELECT i.percent FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=? AND r.report_date=? AND i.work_type_id=?", (blk_pct["block_id"], "2026-09-20", blk_pct["work_type_id"]))
    check(row and row["percent"] == 42, "неверный процент не изменил БД (SQL, осталось 42)")

    sec_whole = db.one("SELECT id FROM work_types WHERE object_id=? AND unit='компл' AND retired_at IS NULL LIMIT 1", (OBJ,))
    check(sec_whole is not None, "в каталоге есть вид работ «компл» (объект целиком)")
    if sec_whole:
        code, data = admin.call("PUT", f"/objects/{OBJ}/work-progress/cell", {"work_type_id": sec_whole["id"], "block_id": None, "section_id": None, "status": "in_progress"})
        check(code == 200, "клик по ячейке «объект» (компл) — в работе", detail(data))
        row = db.one("SELECT status FROM work_progress WHERE work_type_id=? AND block_id IS NULL AND section_id IS NULL", (sec_whole["id"],))
        check(row and row["status"] == "in_progress", "статус в БД (SQL)")
        code, data = admin.call("PUT", f"/objects/{OBJ}/work-progress/cell", {"work_type_id": sec_whole["id"], "block_id": None, "section_id": None, "status": "done"})
        check(code == 200 and data == {"ok": True}, "клик дальше — выполнено", detail(data))
        code, data = admin.call("PUT", f"/objects/{OBJ}/work-progress/cell", {"work_type_id": sec_whole["id"], "block_id": None, "section_id": None, "status": None})
        check(code == 200, "клик дальше — снова план (снятие простановки)", detail(data))
        check(db.one("SELECT status FROM work_progress WHERE work_type_id=? AND block_id IS NULL AND section_id IS NULL", (sec_whole["id"],)) is None, "запись статуса снята из БД (SQL)")
        code, data = u4.call("PUT", f"/objects/{OBJ}/work-progress/cell", {"work_type_id": sec_whole["id"], "block_id": None, "section_id": None, "status": "done"})
        check(code == 403, "403 у user4 на клик по ячейке «объект»", detail(data))

    sec_col = db.one("SELECT id FROM work_types WHERE object_id=? AND unit='сек' AND retired_at IS NULL LIMIT 1", (OBJ,))
    section_any = db.one("SELECT id FROM object_sections WHERE object_id=? LIMIT 1", (OBJ,))
    if sec_col and section_any:
        code, data = admin.call("PUT", f"/objects/{OBJ}/work-progress/cell", {"work_type_id": sec_col["id"], "block_id": None, "section_id": section_any["id"], "status": "in_progress"})
        check(code == 200, "клик по ячейке «секция целиком» — в работе", detail(data))
        row = db.one("SELECT status FROM work_progress WHERE work_type_id=? AND block_id IS NULL AND section_id=?", (sec_col["id"], section_any["id"]))
        check(row and row["status"] == "in_progress", "статус секции в БД (SQL)")

    # ------------------------------------------------------------ бланк обхода плоской шахматки: выгрузка PDF/XLSX
    # ДО загрузки нового справочника видов работ ниже — та операция сбрасывает и `planning_tracks` (треки не из файла
    # удаляются вместе со справочником), а без досок бланку обхода нечего показывать.
    print("Бланк обхода: выгрузка PDF/XLSX (содержимое, размер листа)")
    tracks = admin.call("GET", f"/objects/{OBJ}/blocks/planning-tracks")[1]["tracks"]
    track = next((t for t in tracks if t["код"] != "0"), tracks[0]) if tracks else None
    if track:
        lay = admin.call("GET", f"/objects/{OBJ}/blocks/chess-flat-layout?track_code={track['код']}")[1]
        sections = lay["sections"][:2]
        levels = lay["levels"][:3]
        blocks = lay["blocks"]

        def block_at(sec_id, lvl_id):
            return next((b for b in blocks if b["section_id"] == sec_id and b["level_id"] == lvl_id), None)
        rows = []
        for lvl in levels:
            row_ops = []
            for op in lay["ops"]:
                cells, applicable = [], False
                for s in sections:
                    b = block_at(s["id"], lvl["id"])
                    if b and str(op["id"]) in b["percents"]:
                        cells.append(b["percents"][str(op["id"])]); applicable = True
                    else:
                        cells.append(None)
                if applicable:
                    row_ops.append({"name": op["name"], "cells": cells})
            rows.append({"floor": str(lvl.get("floor") if lvl.get("floor") is not None else lvl["name"])[:12], "ops": row_ops})
        body = {"board": track["название"], "object_name": lay["object_name"], "range_label": "проверка mfr2",
                "snapshot_at": "22.09.2026", "date": "20.09.2026", "format": "A4",
                "sections": [s["code"] for s in sections], "rows": rows}
        code, content, headers = admin.raw("POST", f"/objects/{OBJ}/blocks/chess-flat-export.pdf", body)
        check(code == 200 and headers.get("content-type") == "application/pdf", "выгрузка PDF: 200, content-type", str(code))
        try:
            import fitz
            doc = fitz.open(stream=content, filetype="pdf")
            page = doc[0]
            mm = (page.rect.width / 72 * 25.4, page.rect.height / 72 * 25.4)
            check(abs(mm[0] - 210) < 2 and abs(mm[1] - 297) < 2, "PDF: размер первой страницы ≈ A4 (210×297мм)", str(mm))
            text = "".join(p.get_text() for p in doc)
            check(track["название"] in text and sections[0]["code"] in text, "PDF: название доски и код секции есть в тексте")
            doc.close()
        except ImportError:
            check(False, "PyMuPDF (fitz) недоступен — содержимое PDF не проверено")
        body["format"] = "A3"
        code, content, headers = admin.raw("POST", f"/objects/{OBJ}/blocks/chess-flat-export.pdf", body)
        try:
            import fitz
            doc = fitz.open(stream=content, filetype="pdf")
            mm = (doc[0].rect.width / 72 * 25.4, doc[0].rect.height / 72 * 25.4)
            check(abs(mm[0] - 297) < 2 and abs(mm[1] - 420) < 2, "PDF: формат A3 меняет размер страницы (297×420мм)", str(mm))
            doc.close()
        except ImportError:
            pass
        body["format"] = "A4"
        code, content, headers = admin.raw("POST", f"/objects/{OBJ}/blocks/chess-flat-export.xlsx", body)
        check(code == 200 and headers.get("content-type", "").startswith("application/vnd.openxmlformats"), "выгрузка XLSX: 200, content-type", str(code))
        import openpyxl
        from io import BytesIO
        wb = openpyxl.load_workbook(BytesIO(content))
        ws = wb.active
        text_all = " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)
        check(track["название"] in text_all and sections[0]["code"] in text_all, "XLSX: название доски и код секции есть в содержимом")
        code2, _, _ = u4.raw("POST", f"/objects/{OBJ}/blocks/chess-flat-export.pdf", body)
        check(code2 == 200, "выгрузка доступна на чтение user4 (как в V1 — «read»)", str(code2))
    else:
        check(False, "нет ни одной доски «Шахматка» для проверки выгрузки — пропущено")

    # ---------------------------------------------------------------- справочник видов работ (последним — списывает каталог)
    print("Справочник видов работ: сверка и применение xlsx")
    import openpyxl
    from io import BytesIO
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "WBS"
    ws.append(["Уровень WBS", "Идентификатор операции", "Название операции", "Единицы измерения", "Кодификатор", "Примечание", "Трек планирования"])
    ws.append(["1", "Т-узел", "", "", "", "", ""])
    ws.append(["оп", "T-999", "Тестовая операция mfr2", "шт", "T999", "", ""])
    buf = BytesIO(); wb.save(buf); buf.seek(0)
    code, data = admin.upload(f"/objects/{OBJ}/work-types/analyze", {"file": ("wbs.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    check(code == 200 and "token" in data, "сверка xlsx (анализ, ничего не пишет)", detail(data))
    fp_before = db.one("SELECT COUNT(*) n FROM work_types WHERE object_id=? AND retired_at IS NULL", (OBJ,))["n"]
    before_wt = db.one("SELECT COUNT(*) n FROM work_types WHERE object_id=?", (OBJ,))["n"]
    check(db.one("SELECT COUNT(*) n FROM work_types WHERE object_id=? AND retired_at IS NULL", (OBJ,))["n"] == fp_before, "анализ не изменил БД (SQL, до/после совпало)")
    token = data["token"]
    code2, _ = u4.call("POST", f"/objects/{OBJ}/work-types/apply", {"token": token})
    check(code2 == 403, "403 у user4 на применение", detail(_))
    code, data = admin.call("POST", f"/objects/{OBJ}/work-types/apply", {"token": token})
    check(code == 200 and data["added"] >= 1, "применение по токену", detail(data))
    after_wt = db.one("SELECT COUNT(*) n FROM work_types WHERE object_id=?", (OBJ,))["n"]
    check(after_wt > before_wt, "новые виды работ в БД (SQL)")
    check(db.one("SELECT COUNT(*) n FROM work_types WHERE object_id=? AND retired_at IS NULL", (OBJ,))["n"] < fp_before, "прежний каталог, не входивший в файл, списан (retired_at, SQL) — так же, как в V1")
    code, data = admin.call("POST", f"/objects/{OBJ}/work-types/apply", {"token": token})
    check(code == 410, "повтор токена отклонён (уже применён)", detail(data))


if __name__ == "__main__":
    main()

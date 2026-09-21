import warnings, sys, io, json, sqlite3, datetime
warnings.filterwarnings("ignore")
import requests, openpyxl
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from h import BASE, PW
import dbsnap
kind, out, tag = sys.argv[1], sys.argv[2], sys.argv[3]
s = requests.Session(); s.post(BASE+"/login", json={"domain_login":"admin","password":PW})
c = sqlite3.connect("file:"+dbsnap.DB+"?mode=ro", uri=True)
ids = [r[0] for r in c.execute("select id from elements where object_id=2 and is_current=1 order by id desc limit 4")]
res = {"ids": ids}
if kind == "fields":
    r = s.post(BASE+"/elements/bulk-edit/export", json={"mode":"fields","element_ids":ids})
    wb = openpyxl.load_workbook(io.BytesIO(r.content)); ws = wb["Элементы"]; h = [x.value for x in ws[1]]
    uid_col = 1
    res["uid1"] = ws.cell(row=2, column=1).value; res["uid2"] = ws.cell(row=3, column=1).value; res["uid3"] = ws.cell(row=4, column=1).value
    ws.cell(row=2, column=h.index("Комментарий")+1).value = f"браузер {tag}"
    ws.cell(row=3, column=h.index("Комментарий")+1).value = f"браузер два {tag}"
    ws.cell(row=4, column=h.index("Этаж")+1).value = 300 + int(tag) % 600
    res["floor"] = 300 + int(tag) % 600
    wb.save(out)
elif kind == "statuses":
    r = s.post(BASE+"/elements/bulk-edit/export", json={"mode":"statuses","element_ids":ids})
    wb = openpyxl.load_workbook(io.BytesIO(r.content)); ws = wb["История статусов"]; h = [x.value for x in ws[1]]
    ws.cell(row=2, column=h.index("Комментарий")+1).value = f"история {tag}"
    wb.save(out)
elif kind == "contracting":
    r = s.post(BASE+"/elements/bulk-edit/export", json={"mode":"contracting"})
    wb = openpyxl.load_workbook(io.BytesIO(r.content)); ws = wb["Контрактация"]; h = [x.value for x in ws[1]]
    row = next(i for i in range(2, ws.max_row+1) if "V2-001" in str(ws.cell(row=i, column=h.index("Контракт (справочно)")+1).value))
    ws.cell(row=row, column=h.index("Тема контракта")+1).value = f"тема {tag}"
    wb.save(out)
if kind == "assign":
    cand = c.execute("select id, mark from elements where object_id=2 and is_current=1 and current_status='planned' and contract_id is null and mark in ('Кв5','Кв6') order by id limit 1").fetchone()
    res["id"], res["mark"] = cand[0], cand[1]
    r = s.post(BASE+"/elements/bulk-edit/export", json={"mode":"fields","element_ids":[cand[0]]})
    wb = openpyxl.load_workbook(io.BytesIO(r.content)); ws = wb["Элементы"]; h = [x.value for x in ws[1]]
    names = [x.value for x in wb["Контракты"]["A"][1:] if x.value]
    ws.cell(row=2, column=h.index("Контракт")+1).value = next(n for n in names if "V2-001" in str(n))
    wb.save(out)
print(json.dumps(res))

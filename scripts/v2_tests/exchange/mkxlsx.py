import sys, json, warnings
warnings.filterwarnings("ignore")
import openpyxl
name, header, rows, title = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4]
wb = openpyxl.Workbook(); ws = wb.active; ws.title = title; ws.append(header)
for r in rows: ws.append(r)
wb.save(name)

"""Procurement regression tests. Synthetic in-memory XLSX; no real DB access.

Run .venv312/bin/python scripts/test_procurement.py
Optional --fixture /tmp/file.xlsx produces the browser test's synthetic upload.
"""
import copy
import io
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import unittest
from zipfile import ZipFile
from xml.etree.ElementTree import Element, SubElement, tostring

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.procurement import SHEETS, parse_xlsx, build_report, validate_allocations, distribute_cents
from app.procurement_api import import_snapshot


def sample():
    req = lambda n,item,qty,unit="шт",cancel="Нет": [f"ЗВП {n} от 01.01.2026",n,"01.01.2026 10:00:00","Тестовый склад",item,unit,qty,"Тестовая категория",cancel]
    order = lambda parent,item,qty,amount,unit="шт",cancel="Нет": ["Заказ поставщику P1 от 02.01.2026 10:00:00","P1","02.01.2026 10:00:00",item,"Категория","Тестовый поставщик",unit,qty,amount,parent,cancel]
    pay = lambda n,amount,ref="Заказ поставщику P1 от 02.01.2026 10:00:00",num="P1": [f"ЗРДС {n}",ref,amount,"02.01.2026 10:00:00",num,"Тестовый поставщик","Тестовый менеджер"]
    return {"ЗВП":[SHEETS["ЗВП"],req("R1","Исходный материал",10),req("R2","Труба",20),req("R1","Отменённый материал",5,cancel="Да")],
            "ЗП":[SHEETS["ЗП"],order("R1","Замена материала",4,400),order("R2","Труба",10,600),order("R1","Отменённый заказ",100,9000,cancel="Да")],
            "Оплаты ЗРДС":[SHEETS["Оплаты ЗРДС"],pay("A",200),pay("B",300),pay("C",70,"Заказ X", "X")]}


def xlsx_bytes(rows):
    """Minimal native OOXML fixture, with real relationships and typed numbers."""
    buf=io.BytesIO()
    ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    with ZipFile(buf,"w") as z:
        types=Element("Types",xmlns="http://schemas.openxmlformats.org/package/2006/content-types")
        SubElement(types,"Default",Extension="rels",ContentType="application/vnd.openxmlformats-package.relationships+xml")
        SubElement(types,"Default",Extension="xml",ContentType="application/xml")
        SubElement(types,"Override",PartName="/xl/workbook.xml",ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
        wb=Element("workbook",xmlns=ns, attrib={"xmlns:r":"http://schemas.openxmlformats.org/officeDocument/2006/relationships"})
        sheets=SubElement(wb,"sheets")
        rels=Element("Relationships",xmlns="http://schemas.openxmlformats.org/package/2006/relationships")
        for i,(name,data) in enumerate(rows.items(),1):
            SubElement(sheets,"sheet",name=name,sheetId=str(i),attrib={"r:id":f"rId{i}"})
            SubElement(rels,"Relationship",Id=f"rId{i}",Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",Target=f"worksheets/sheet{i}.xml")
            SubElement(types,"Override",PartName=f"/xl/worksheets/sheet{i}.xml",ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")
            ws=Element("worksheet",xmlns=ns); content=SubElement(ws,"sheetData")
            for rn,values in enumerate(data,1):
                r=SubElement(content,"row",r=str(rn))
                for cn,v in enumerate(values,1):
                    col=""; n=cn
                    while n: n,k=divmod(n-1,26); col=chr(65+k)+col
                    cell=SubElement(r,"c",r=f"{col}{rn}")
                    if isinstance(v,(float,int)): SubElement(cell,"v").text=str(v)
                    elif v is not None:
                        cell.set("t","inlineStr");SubElement(SubElement(cell,"is"),"t").text=str(v)
            z.writestr(f"xl/worksheets/sheet{i}.xml",tostring(ws))
        z.writestr("[Content_Types].xml",tostring(types));z.writestr("xl/workbook.xml",tostring(wb));z.writestr("xl/_rels/workbook.xml.rels",tostring(rels))
        z.writestr("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    return buf.getvalue()


class ProcurementTests(unittest.TestCase):
    def setUp(self): self.data=parse_xlsx(xlsx_bytes(sample()))

    def replacement(self):
        o=self.data["orders"][0];r=self.data["requests"][0]
        a=validate_allocations(self.data,o["id"],[dict(request_line_id=r["id"],order_qty=4,request_qty=8)])
        return o,r,a

    def test_split_order_two_requests_partial_payments_and_cancelled(self):
        o,r,a=self.replacement(); result=build_report(self.data,{o["id"]:a})
        first,second,cancel=result["requests"]
        self.assertEqual((first["ordered_qty"],first["paid_qty"],first["paid_cents"]),(8,4,20000))
        self.assertEqual((second["ordered_qty"],second["paid_qty"],second["paid_cents"]),(10,5,30000))
        self.assertEqual(first["remaining_qty"],2);self.assertEqual(first["replacements"],1)
        s=result["summary"]
        self.assertEqual((s["ordered_cents"],s["paid_cents"],s["unpaid_cents"],s["orphan_payment_cents"]),(100000,50000,50000,7000))
        self.assertEqual(sum(r["paid_cents"] for r in result["requests"]),50000)
        self.assertEqual(cancel["status"],"cancelled")

    def test_unmatched_not_fuzzy_matched_and_empty_override(self):
        result=build_report(self.data)
        self.assertEqual(result["requests"][0]["ordered_qty"],0)
        self.assertEqual(result["summary"]["unmapped_orders"],1)
        exact=self.data["orders"][1]["id"]
        self.assertEqual(build_report(self.data,{exact:[]})["requests"][1]["ordered_qty"],0)

    def test_invalid_mapping_and_overallocation(self):
        o,r,a=self.replacement()
        for wrong in ([dict(request_line_id=self.data["requests"][1]["id"],order_qty=4,request_qty=8)],
                      [dict(request_line_id=r["id"],order_qty=5,request_qty=8)],
                      [dict(request_line_id=r["id"],order_qty=4,request_qty=0)],a+a):
            with self.assertRaises(ValueError): validate_allocations(self.data,o["id"],wrong)

    def test_one_order_item_split_between_two_original_items(self):
        extra=copy.deepcopy(self.data["requests"][0]);extra.update(id="another-line",item="Другой материал",unit="м",qty=8)
        self.data["requests"].append(extra)
        o,r,a=self.replacement();a[0].update(order_qty=2,request_qty=4)
        a.append(dict(request_line_id=extra["id"],order_qty=2,request_qty=8))
        clean=validate_allocations(self.data,o["id"],a)
        result=build_report(self.data,{o["id"]:clean})
        self.assertEqual(result["requests"][0]["paid_qty"],2)
        self.assertEqual(result["requests"][-1]["paid_qty"],4)
        self.assertEqual(sum(l["paid_cents"] for l in result["orders"][0]["links"]),20000)

    def test_overpayment_quantity_cap_and_excess(self):
        o,r,a=self.replacement();a[0]["request_qty"]=12
        self.data["payments"][0]["amount_cents"]=120000
        result=build_report(self.data,{o["id"]:a})
        self.assertEqual(result["requests"][0]["paid_qty"],12)
        self.assertEqual(result["requests"][0]["excess_qty"],2)
        self.assertEqual(result["summary"]["overpaid_cents"],50000)

    def test_zero_value_order_does_not_claim_paid_quantity(self):
        for o in self.data["orders"]: o["amount_cents"]=0
        result=build_report(self.data)
        self.assertIsNone(result["requests"][1]["paid_qty"])
        self.assertEqual(result["summary"]["zero_value_paid_cents"],50000)

    def test_duplicate_rows_preserved_and_flagged(self):
        rows=sample(); rows["ЗВП"].append(rows["ЗВП"][1]); rows["Оплаты ЗРДС"].append(rows["Оплаты ЗРДС"][1])
        data=parse_xlsx(xlsx_bytes(rows))
        self.assertEqual(data["requests"][0]["qty"],20)
        self.assertEqual(len(data["payments"]),4)
        self.assertEqual(len(data["warnings"]),2)

    def test_bad_inputs_and_cancelled_placeholder(self):
        for field,value in ((7,-1),(8,"abc"),(2,"not-a-date"),(10,"")):
            rows=sample();rows["ЗП"][1][field]=value
            with self.assertRaises(ValueError):parse_xlsx(xlsx_bytes(rows))
        rows=sample();rows["ЗП"][3][8]="<0>"
        self.assertEqual(build_report(parse_xlsx(xlsx_bytes(rows)))["summary"]["ordered_cents"],100000)
        rows["ЗП"][1][8]="<0>"
        with self.assertRaises(ValueError):parse_xlsx(xlsx_bytes(rows))

    def test_document_collision_rejected_before_aggregation(self):
        rows=sample();dup=copy.deepcopy(rows["ЗП"][1]);dup[2]="03.01.2026 10:00:00";rows["ЗП"].append(dup)
        with self.assertRaises(ValueError):parse_xlsx(xlsx_bytes(rows))

    def test_payment_does_not_match_same_number_in_different_year(self):
        self.data["payments"][0].update(order_ref="Другой документ",order_date="2025-01-02T10:00:00")
        result=build_report(self.data)
        self.assertEqual(result["summary"]["paid_cents"],30000)

    def test_cent_rounding_reconciles(self):
        for n in (1,2,7,99,100000): self.assertEqual(sum(distribute_cents(n,[1,1,1])),n)
        self.assertEqual(distribute_cents(1,[1,1,1]),[1,0,0])

    def test_snapshot_idempotence_history_and_mapping_carry(self):
        c=sqlite3.connect(":memory:");c.row_factory=sqlite3.Row
        c.execute("CREATE TABLE users(id INTEGER PRIMARY KEY)"); c.execute("INSERT INTO users VALUES(1)")
        schema=(Path(__file__).resolve().parent.parent/"app/schema.sql").read_text()
        for sql in re.findall(r"CREATE TABLE IF NOT EXISTS procurement_[\s\S]*?;",schema): c.execute(sql)
        first=import_snapshot(c,self.data,"synthetic.xlsx",1)
        o,r,a=self.replacement()
        c.execute("INSERT INTO procurement_allocations(snapshot_id,order_line_id,allocations_json,updated_by) VALUES(?,?,?,1)",(first["id"],o["id"],json.dumps(a)))
        again=import_snapshot(c,self.data,"renamed.xlsx",1)
        self.assertTrue(again["unchanged"]);self.assertEqual(first["id"],again["id"])
        new=copy.deepcopy(self.data);new["sha256"]="new-file";new["payments"][0]["amount_cents"]+=1
        next_=import_snapshot(c,new,"next.xlsx",1);self.assertEqual(next_["carried_mappings"],1)
        new["sha256"]="changed-qty";new["orders"][0]["qty"]+=1
        third=import_snapshot(c,new,"third.xlsx",1);self.assertEqual(third["carried_mappings"],0)
        self.assertEqual(c.execute("SELECT count(*) FROM procurement_snapshots").fetchone()[0],3)
        self.assertEqual(c.execute("SELECT count(*) FROM procurement_allocations WHERE snapshot_id=?",(first["id"],)).fetchone()[0],1)
        c.close()


if __name__ == "__main__":
    if len(sys.argv)>1 and sys.argv[1]=="--fixture":
        Path(sys.argv[2]).write_bytes(xlsx_bytes(sample()))
    else: unittest.main()

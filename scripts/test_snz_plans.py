"""Synthetic PDF plans: work-zone crop, saved geometry, status colors and readable labels."""
import sys
import json
import unittest
from copy import deepcopy
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.snz_plans import plan_pages, floor_title, build_floor_plans


def fixture(count=8):
    es=[]
    for i in range(count):
        x,y=(i%10)*6000,(i//10)*4500
        es.append(dict(id=i+1,x=x+2000,y=y+1000,floor=2,source_file='Учебный.dxf',
                       mark=f'П-{i+1}',element_type='Плита перекрытия',elevation_mm=15800,
                       outline_json=json.dumps([[x,y],[x+5000,y],[x+5000,y+2000],[x,y+2000]]),
                       current_status=['installed','ready_for_installation','delivered'][i%3],zone_zakhvatka_id=1,zakhvatka='Захватка А'))
    remote={**es[0],'id':1001,'x':1000000,'y':1000000,'zone_zakhvatka_id':2,'zakhvatka':'Другая захватка','mark':'НЕ ПОКАЗЫВАТЬ'}
    remote['outline_json']=json.dumps([[1000000,1000000],[1005000,1000000],[1005000,1002000]])
    order=dict(date='2026-11-10',shift='day',object_name='Учебный объект',crew={'name':'Монтажная бригада','foreman':'Учебный прораб'},tasks=[],items=deepcopy(es),item_priorities={str(e['id']):i+1 for i,e in enumerate(es)})
    axes=[dict(source_file='Учебный.dxf',kind='numeric',coord=x*6000,label=str(x+1)) for x in range(12)]
    axes += [dict(source_file='Учебный.dxf',kind='letter',coord=y*4500,label='АБВГДЕЖИКЛ'[y]) for y in range(10)]
    zones=[{'id':1,'name':'Захватка А'},{'id':2,'name':'Другая захватка'}]
    return order,es+[remote],axes,zones


class PlanTests(unittest.TestCase):
    def test_only_work_zones_and_nearby_axes(self):
        order,context,axes,zones=fixture()
        pages=plan_pages(order,context,zones, floor_levels=[{"floor":2,"elevation_mm":15800}])
        self.assertEqual(len(pages),1)
        self.assertNotIn(1001,pages[0]['items'])
        self.assertLess(pages[0]['bounds'][2],1000000)
        self.assertEqual(pages[0]['title'],'Этаж 2, отм +15.800')

    def test_unknown_zone_never_expands_to_remote_geometry(self):
        order,context,axes,zones=fixture()
        for e in order['items']:e.pop('zone_zakhvatka_id');e['zakhvatka']=''
        self.assertNotIn(1001,plan_pages(order,context,zones)[0]['items'])

    def test_saved_geometry_live_status_no_mutation(self):
        order,context,axes,zones=fixture();before=deepcopy(order)
        context[0]['x']=9000;context[0]['current_status']='accepted'
        page=plan_pages(order,context,zones)[0]
        self.assertEqual(page['active'][1]['x'],before['items'][0]['x'])
        self.assertEqual(page['active'][1]['current_status'],'accepted')
        self.assertEqual(order,before)

    def test_dense_zone_splits_without_losing_items(self):
        order,context,axes,zones=fixture(160)
        pages=plan_pages(order,context,zones, floor_levels=[{"floor":2,"elevation_mm":15800}])
        self.assertGreater(len(pages),1)
        self.assertEqual({eid for p in pages for eid in p['active']},set(range(1,161)))
        self.assertTrue(all(len(p['items'])<=80 for p in pages))

    def test_ambiguous_floor_not_guessed(self):
        _,context,_,_=fixture();context[1]['elevation_mm']=16800
        self.assertIn('не задана',plan_pages(fixture()[0],context,fixture()[3])[0]['title'])
        self.assertIn('не задана',floor_title(2))

    def test_pdf_text_fonts_and_status_legend(self):
        import fitz
        out=Path(__file__).resolve().parents[1]/'outputs/snz-fact-report';out.mkdir(parents=True,exist_ok=True)
        for count in (8,160):
            order,context,axes,zones=fixture(count)
            pdf=build_floor_plans(order,context,axes,zones,{'installed':'#00FF66','ready_for_installation':'#00BBDD','delivered':'#8855CC'},[{'floor':2,'elevation_mm':15800}])
            (out/f'plans-{count}.pdf').write_bytes(pdf)
            doc=fitz.open(stream=pdf,filetype='pdf');text='\n'.join(p.get_text() for p in doc)
            self.assertIn('Этаж 2, отм +15.800',text);self.assertNotIn('НЕ ПОКАЗЫВАТЬ',text)
            for e in order['items']:self.assertIn(e['mark'],text)
            self.assertIn('Смонтирован',text);self.assertIn('Готов к монтажу',text);self.assertIn('Доставлен',text)
            marks=[s for p in doc for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans'] if 'П-' in s['text']]
            self.assertTrue(all(s['size']>=9.4 for s in marks))
            doc[0].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).save(out/f'plans-{count}-1.png')


if __name__=='__main__':unittest.main(verbosity=2)

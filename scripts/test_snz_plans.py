"""A3 floor plans: complete captures, one sheet per floor and collision-free marks."""
import sys
import json
import re
import unittest
from copy import deepcopy
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.snz_plans import plan_pages, build_floor_plans, floor_title, leader_segments

PALETTE = {'installed':'#00FF66', 'ready_for_installation':'#00BBDD', 'delivered':'#8855CC'}


def fixture(count=8, all_active=False):
    items = []
    height = max(18000, math_ceil(count, 12)*3000+1000)
    for i in range(count):
        x, y = (i % 12)*6000, (i//12)*3000
        zid = 1 if i % 12 < 6 else 2
        items.append(dict(id=i+1,x=x+2500,y=y+1100,floor=2,source_file='Учебный.dxf',mark=f'П-{i+1}',
                          element_type='Плита перекрытия',elevation_mm=16800,crane='Соседний кран' if i%2 else 'Кран СНЗ',
                          outline_json=json.dumps([[x,y],[x+5000,y],[x+5000,y+2200],[x,y+2200]]),
                          current_status=['installed','ready_for_installation','delivered'][i%3],
                          zone_zakhvatka_id=zid,zakhvatka='Захватка А' if zid==1 else 'Захватка Б'))
    columns = []
    for i, x in enumerate([500,36500]):
        columns.append(dict(id=9001+i,x=x,y=500,floor=2,source_file='Учебный.dxf',mark=f'К-{i+1}',
                            element_type='Колонна',elevation_mm=15800+i*500,current_status='installed',
                            zone_zakhvatka_id=i+1,zakhvatka='Захватка А' if i==0 else 'Захватка Б',
                            outline_json=json.dumps([[x-200,300],[x+200,300],[x+200,700],[x-200,700]])))
    remote={**items[0],'id':10001,'x':1000000,'y':1000000,'zone_zakhvatka_id':3,'zakhvatka':'Удалённая захватка','mark':'ДАЛЬНИЙ-10001',
            'outline_json':json.dumps([[1000000,1000000],[1005000,1000000],[1005000,1002000],[1000000,1002000]])}
    chosen = items if all_active else [items[0],items[-1]]
    order=dict(date='2026-11-10',shift='day',object_name='Учебный объект',crew={'name':'Монтажная бригада','foreman':'Учебный прораб'},
               tasks=[],items=deepcopy(chosen),item_priorities={str(e['id']):i+1 for i,e in enumerate(chosen)})
    axes=[dict(source_file='Учебный.dxf',kind='numeric',coord=x*6000,label=str(x+1)) for x in range(13)]
    axes += [dict(source_file='Учебный.dxf',kind='letter',coord=y*6000,label=f'А{y+1}') for y in range(math_ceil(height,6000)+1)]
    zones=[{'id':zid,'name':name,'outline_json':json.dumps([[x,0],[x+36000,0],[x+36000,height],[x,height]])}
           for zid,name,x in [(1,'Захватка А',0),(2,'Захватка Б',36000)]]
    zones.append({'id':3,'name':'Удалённая захватка','outline_json':remote['outline_json']})
    return order,items+columns+[remote],axes,zones


def math_ceil(a,b):
    return (a+b-1)//b


def pdf_labels(page):
    return [{'text':word[4],'bbox':word[:4]} for word in page.get_text('words') if re.fullmatch(r'[ПК]-\d+',word[4])]


class PlanTests(unittest.TestCase):
    def test_saved_capture_name_and_level_contour(self):
        order,context,axes,zones=fixture()
        prior_name=zones[0]['name']
        saved_outline=json.loads(zones[0]['outline_json'])
        zones[0]={**zones[0],'name':'Новое имя','outline_json':'',
                  'levels':[{'outline':saved_outline,'elevation_mm':0,'upper_elevation_mm':20000}]}
        page,=plan_pages(order,context,zones)
        self.assertIn(prior_name,page['zone'])
        self.assertNotIn('Новое имя',page['zone'])
        self.assertTrue(page['zones'][0]['levels'])

    def test_leaders_leave_label_text_clear(self):
        segments=leader_segments((0,5),(100,5),[{'rect':(20,0,40,10)},{'rect':(60,0,80,10)}])
        self.assertEqual(segments,[((0.,5.),(19.,5.)),((41.,5.),(59.,5.)),((81.,5.),(100.,5.))])

    def test_full_two_captures_and_neighbour_cranes_on_one_floor(self):
        order,context,axes,zones=fixture()
        page,=plan_pages(order,context,zones)
        self.assertEqual(set(page['items']),{e['id'] for e in context if e['id']!=10001})
        self.assertEqual({z['id'] for z in page['zones']},{1,2})
        self.assertGreaterEqual(page['bounds'][2],72000)
        self.assertGreaterEqual(page['bounds'][3],18000)
        self.assertIn('Соседний кран',{e.get('crane') for e in page['items'].values()})
        self.assertNotIn(10001,page['items'])

    def test_geometry_in_capture_included_even_when_assigned_to_other_zone(self):
        order,context,axes,zones=fixture()
        context[1]['zone_zakhvatka_id']=3;context[1]['zakhvatka']='Пересечение'
        self.assertIn(context[1]['id'],plan_pages(order,context,zones)[0]['items'])

    def test_minimum_column_base_instead_of_manual_or_slab_level(self):
        order,context,axes,zones=fixture()
        retired={**context[-3],'id':9999,'elevation_mm':-1000,'is_current':0}
        page,=plan_pages(order,context+[retired],zones,floor_levels=[{'floor':2,'elevation_mm':99999}])
        self.assertEqual(page['title'],'Этаж 2, отм +15.800')
        self.assertEqual(page['column_levels'],[15800,16300])

    def test_missing_columns_explicit_and_manual_level_not_substituted(self):
        order,context,axes,zones=fixture()
        context=[e for e in context if e['element_type']!='Колонна']
        self.assertIn('не задана',plan_pages(order,context,zones,floor_levels=[{'floor':2,'elevation_mm':15800}])[0]['title'])
        self.assertIn('не задана',floor_title(2))

    def test_missing_zone_stays_local(self):
        order,context,axes,zones=fixture()
        for e in order['items']:e.pop('zone_zakhvatka_id');e['zakhvatka']=''
        self.assertNotIn(10001,plan_pages(order,context,zones)[0]['items'])

    def test_legacy_capture_without_outline_includes_all_members(self):
        order,context,axes,zones=fixture()
        for zone in zones:zone.pop('outline_json')
        self.assertEqual(len(plan_pages(order,context,zones)[0]['items']),len(context)-1)

    def test_saved_geometry_and_status_rules_no_mutation(self):
        order,context,axes,zones=fixture();before=deepcopy(order)
        context[0]['x']=900000;context[0]['current_status']='accepted'
        context[0]['outline_json']=json.dumps([[900000,0],[901000,0],[901000,200],[900000,200]])
        page,=plan_pages(order,context,zones)
        self.assertEqual(page['active'][1]['x'],before['items'][0]['x'])
        self.assertEqual(page['active'][1]['current_status'],'accepted')
        self.assertEqual(page['active'][1]['outline_json'],before['items'][0]['outline_json'])
        self.assertEqual(order,before)
        order['closed_at']='2026-11-11T08:00:00'
        self.assertEqual(plan_pages(order,context,zones)[0]['active'][1]['current_status'],before['items'][0]['current_status'])

    def test_dense_floor_never_splits(self):
        order,context,axes,zones=fixture(768,True)
        pages=plan_pages(order,context,zones,max_labels=80)
        self.assertEqual(len(pages),1)
        self.assertEqual(set(pages[0]['active']),set(range(1,769)))

    def test_multiple_sources_stay_on_same_floor_sheet(self):
        order,context,axes,zones=fixture()
        order['items'][-1]['source_file']='Другая часть.dxf';context[3]['source_file']='Другая часть.dxf'
        page,=plan_pages(order,context,zones)
        self.assertEqual(page['sources'],{'Учебный.dxf','Другая часть.dxf'})

    def assert_pdf(self,order,context,axes,zones,name):
        import fitz
        from reportlab.lib.pagesizes import A3
        pdf=build_floor_plans(order,context,axes,zones,PALETTE,[{'floor':2,'elevation_mm':99999}])
        out=Path(__file__).resolve().parents[1]/'output/pdf';out.mkdir(parents=True,exist_ok=True)
        (out/name).write_bytes(pdf)
        doc=fitz.open(stream=pdf,filetype='pdf');pages=plan_pages(order,context,zones)
        self.assertEqual(len(doc),len(pages))
        for number,(page,expected) in enumerate(zip(doc,pages),1):
            self.assertAlmostEqual(min(page.rect.width,page.rect.height),min(A3),places=2)
            self.assertAlmostEqual(max(page.rect.width,page.rect.height),max(A3),places=2)
            text=page.get_text();self.assertIn(expected['title'],text);self.assertNotIn('ДАЛЬНИЙ-10001',text)
            labels=pdf_labels(page);self.assertEqual(len(labels),len(expected['items']))
            spans=[s for b in page.get_text('dict')['blocks'] if 'lines' in b for line in b['lines'] for s in line['spans'] if re.search(r'[ПК]-\d+',s['text'])]
            self.assertTrue(all(abs(s['size']-(6 if 'К-' in s['text'] else 3.5))<.01 for s in spans))
            for item in expected['items'].values():
                self.assertTrue(any(s['text']==item['mark'] or s['text'].endswith(' - '+item['mark']) for s in labels),item['mark'])
            for i,a in enumerate(labels):
                self.assertTrue(page.rect.contains(fitz.Rect(a['bbox'])))
                for b in labels[i+1:]:
                    intersection=fitz.Rect(a['bbox'])&fitz.Rect(b['bbox'])
                    self.assertLessEqual(max(0,intersection.width)*max(0,intersection.height),.05,(a['text'],b['text']))
            drawings=page.get_drawings()
            active=[d for d in drawings if d['type']=='fs' and abs(d['width']-1.4)<.01]
            context_paths=[d for d in drawings if d['type']=='fs' and abs(d['width']-.65)<.01]
            self.assertEqual(len(active),len(expected['active']))
            self.assertEqual(len(context_paths),len(expected['items'])-len(expected['active']))
            for d in active:self.assertAlmostEqual(d['fill_opacity'],1);self.assertAlmostEqual(d['stroke_opacity'],1)
            for d in context_paths:self.assertAlmostEqual(d['fill_opacity'],.3,places=5);self.assertAlmostEqual(d['stroke_opacity'],.3,places=5)
            page.get_pixmap(matrix=fitz.Matrix(1.3,1.3)).save(out/f'{Path(name).stem}-{number}.png')
        self.assertEqual([r[1] for r in doc.get_toc()],[p['title'] for p in pages])
        return doc

    def test_pdf_all_marks_opacity_and_a3(self):
        order,context,axes,zones=fixture()
        doc=self.assert_pdf(order,context,axes,zones,'snz-complete-captures.pdf')
        for label in ['Смонтирован','Готов к монтажу','Доставлен']:self.assertIn(label,doc[0].get_text())

    def test_dense_pdf_all_marks_nonoverlapping_one_a3(self):
        self.assert_pdf(*fixture(768),'snz-dense-floor.pdf')

    def test_multiple_floors_exactly_one_a3_each(self):
        order,context,axes,zones=fixture()
        extra=[]
        for e in context[:4]+[context[-3]]:
            extra.append({**e,'id':e['id']+20000,'floor':3,'mark':'П-'+str(e['id']+20000) if e['element_type']!='Колонна' else 'К-3','elevation_mm':26800})
        context.extend(extra);order['items'].extend(deepcopy(extra[:2]))
        doc=self.assert_pdf(order,context,axes,zones,'snz-two-floors.pdf')
        self.assertEqual(len(doc),2);self.assertIn('Этаж 3, отм +26.800',doc[1].get_text())


if __name__=='__main__':unittest.main(verbosity=2)

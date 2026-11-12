"""In-contour marks, fixed paper sizes and column-only callouts."""
import sys,json,math,unittest
from pathlib import Path
from copy import deepcopy
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.snz_plans import place_labels,points,intersects
from app.snz_plan_labels import mark_size
from shapely.geometry import Polygon


def item(eid,kind,mark,cx,cy,w,h,angle=0):
    c,s=math.cos(math.radians(angle)),math.sin(math.radians(angle))
    outline=[(cx+x*c-y*s,cy+x*s+y*c) for x,y in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)]]
    return dict(id=eid,element_type=kind,mark=mark,x=cx,y=cy,outline_json=json.dumps(outline))


class FixedLabelTests(unittest.TestCase):
    def layout(self,items,active=(),reserved=()):
        page={'items':{e['id']:e for e in items},'active':{e['id']:e for e in items if e['id'] in active}}
        original=deepcopy(page);xy=lambda x,y:(80+x*.006445,80+y*.006445)
        labels=place_labels(page,(30,30,700,700),xy,{str(eid):i+1 for i,eid in enumerate(active)},reserved)
        self.assertEqual(original,page);self.assertEqual(len(labels),len(items))
        for label in labels:
            if not label['leader']:
                source=next(e for e in items if e['id']==label['id'])
                self.assertTrue(Polygon([xy(*p) for p in points(source)]).buffer(.000001).covers(label['polygon']))
            for other in labels:
                if other is not label:self.assertFalse(intersects(label['rect'],other['rect']))
            self.assertFalse(any(intersects(label['rect'],r) for r in reserved))
        return labels

    def test_fixed_sizes_do_not_depend_on_page_density(self):
        self.assertEqual(mark_size('Плита перекрытия',1200,9000),3.5)
        self.assertEqual(mark_size('Колонна',600,600),6)
        self.assertEqual([mark_size('Ригель',w,9000) for w in (600,400,300)],[3,2,1.5])
        plate=item(1,'Плита перекрытия','П-1',6000,6000,9000,1200)
        alone=self.layout([plate])[0]
        full=self.layout([plate]+[item(n,'Плита перекрытия',f'П-{n}',6000,(n+6)*1400,9000,1200) for n in range(2,60)])
        self.assertEqual(alone['size'],next(l['size'] for l in full if l['id']==1))

    def test_vertical_and_rotated_beams_stay_inside(self):
        rows=[item(1,'Ригель','Р-1',3000,6000,600,9000),item(2,'Ригель','Р-2',16000,6000,9000,600,35)]
        labels=self.layout(rows)
        self.assertTrue(any(abs(l['angle'])>1 for l in labels))
        self.assertTrue(all(not l['leader'] for l in labels))

    def test_nested_short_profiles_keep_both_marks(self):
        rows=[item(1,'Ригель','4Рк1',3000,6000,400,630),item(2,'Ригель','2Рк1',3000,6000,600,630)]
        labels=self.layout(rows)
        self.assertEqual({l['text'] for l in labels},{'2Рк1','4Рк1'})
        self.assertEqual({l['size'] for l in labels},{1.2})

    def test_coincident_columns_are_separate_short_callouts(self):
        rows=[item(1,'Колонна','К-1',9000,9000,600,600),item(2,'Колонна','К-2',9000,9000,300,600),
              item(3,'Плита перекрытия','П-1',15000,9000,9000,1200)]
        labels=self.layout(rows,active=(3,),reserved=((110,120,130,130),))
        self.assertEqual(sum(l['leader'] for l in labels),2)
        for l in labels:
            if l['leader']:self.assertLessEqual(math.dist((l['x'],l['y']),l['anchor']),54)

    def test_unfittable_mark_does_not_abort_or_remove_geometry(self):
        from app.snz_plans import build_floor_plans
        import fitz
        bad=item(1,'Плита перекрытия','Очень-длинная-марка'*20,1000,1000,500,100)
        page={'items':{1:bad},'active':{1:bad}}
        layout=place_labels(page,(30,30,700,700),lambda x,y:(80+x*.006445,80+y*.006445),{})
        self.assertEqual(len(layout),0);self.assertEqual(len(layout.warnings),1)
        bad.update(floor=1,source_file='test.dxf',current_status='installed')
        order={'date':'2026-11-12','shift':'day','crew':{'name':'Test'},'items':[bad],'tasks':[]}
        pdf=build_floor_plans(order,[bad],[])
        document=fitz.open(stream=pdf,filetype='pdf')
        self.assertEqual(len(document),1)
        self.assertIn('Не размещено подписей: 1',document[0].get_text())
        self.assertEqual(sum(d['type']=='fs' and abs(d['width']-1.4)<.01 for d in document[0].get_drawings()),1)


if __name__=='__main__':unittest.main(verbosity=2)

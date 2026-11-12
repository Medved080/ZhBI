#!/usr/bin/env python3
"""Own-sheet partial solids for Р8/Р9/Р10/Р10.1 (doc09 PDF78–85).

No shared assets or earlier packages are changed. Each source assembly and its
sections/spec were visually reviewed. K7 is explicitly present in all four own
specifications; only its confirmed retained central straight segments are shown.
Unresolved mesh/weld/loop placement remains pending rather than copied from Р4.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
import build_calc_slab_models as geom
import import_calc_rebar_models as steel_gate
from shapely.geometry import Polygon,box

ROOT=geom.ROOT;ASSETS=geom.CATALOG_DIR
SUPPLY='codex-next-rigels-long-20261111'
SOURCE_SHA='ba7abb43c562fd8476c3cab0a50c78656d6d6421f592776fba0e990e77f29d02'
CONFIGS=[
 {'alias':'Р8','page':78,'sec':79,'L':3630,'volume':.390,'ordinaryD':20,'ordinaryL':3590,'ordinaryKg':8.85,'cage':'К8','upperD':12,'upperL':3620,'lowerL':3610,'upperKg':3.21,'lowerKg':3.21,'cageKg':8.34,'A':2550,'kQty':4,'kL':4280,'kKg':3.11,'kTotal':12.43,'stirrups':21,'lowerMesh':'СР8','lowerQty':1,'lowerKgMesh':13.53,'lowerPage':111,'upperMesh':'СВ8','upperQty':1,'upperKgMesh':8.95,'upperPage':114,'loop':'П3','loopKg':.59},
 {'alias':'Р9','page':80,'sec':81,'L':4130,'volume':.450,'ordinaryD':20,'ordinaryL':4090,'ordinaryKg':10.09,'cage':'К9','upperD':12,'upperL':4120,'lowerL':4110,'upperKg':3.66,'lowerKg':3.65,'cageKg':9.23,'A':3050,'kQty':4,'kL':4780,'kKg':3.47,'kTotal':13.88,'stirrups':24,'lowerMesh':'СР9','lowerQty':1,'lowerKgMesh':15.58,'lowerPage':111,'upperMesh':'СВ9','upperQty':1,'upperKgMesh':10.27,'upperPage':114,'loop':'П4','loopKg':.85},
 {'alias':'Р10','page':82,'sec':83,'L':4950,'volume':.550,'ordinaryD':25,'ordinaryL':4910,'ordinaryKg':18.92,'cage':'К10','upperD':12,'upperL':4940,'lowerL':4930,'upperKg':4.39,'lowerKg':4.38,'cageKg':10.68,'A':3870,'kQty':4,'kL':5600,'kKg':4.07,'kTotal':16.26,'stirrups':30,'lowerMesh':'СР10','lowerQty':2,'lowerKgMesh':9.92,'lowerPage':110,'upperMesh':'СВ10','upperQty':2,'upperKgMesh':6.48,'upperPage':113,'loop':'П4','loopKg':.85},
 {'alias':'Р10.1','page':84,'sec':85,'L':4950,'volume':.550,'ordinaryD':25,'ordinaryL':4910,'ordinaryKg':18.92,'cage':'К10.1','upperD':14,'upperL':4940,'lowerL':4930,'upperKg':5.97,'lowerKg':4.38,'cageKg':12.27,'A':3870,'kQty':6,'kL':5600,'kKg':4.07,'kTotal':24.39,'stirrups':30,'lowerMesh':'СР10','lowerQty':2,'lowerKgMesh':9.92,'lowerPage':110,'upperMesh':'СВ10','upperQty':2,'upperKgMesh':6.48,'upperPage':113,'loop':'П4','loopKg':.85},
]

def dump(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def digest(v):return hashlib.sha256(dump(v).encode()).hexdigest()
def path(pid,points,d,position,projectL,pages,**extra):
    return {'id':pid,'points':points,'diameter':d,'position':str(position),'material':'A500C','projectLength':projectL,'sourcePages':pages,**extra}
def group(gid,name,position,qty,pages,paths,**extra):
    return {'id':gid,'name':name,'shortLabel':name,'designation':name,'position':str(position),'quantity':qty,'unit':'шт','material':'A500C','sourcePages':pages,'paths':paths,**extra}
def kg(g):return sum(steel_gate.path_mass(p,g) for p in g['paths'])
def mass_check(cid,label,groups,ids,spec,pages,partial=False,tolerance=1):
    value=sum(kg(g) for g in groups if g['id'] in ids);delta=(value/spec-1)*100
    return {'check':cid,'result':'warn' if partial or abs(delta)>tolerance else 'pass','groupIds':ids,'modelKg':round(value,6),'specKg':spec,
       'deviationPercent':round(delta,4),'tolerancePercent':tolerance,'partialCoverage':partial,'sourcePages':pages,
       'detail':f'{label}: по фактическим осям {value:.5f} кг, по собственной спецификации {spec:.5f} кг; {delta:+.3f}%. '+('Неполный показ, пропущенные участки не компенсированы длиной/диаметром.' if partial else 'Размеры не подгонялись к округлённой табличной массе.')}
def cov(pos,name,q,n,status='modeled',reason='',parent='product'):
    d={'position':str(pos),'designation':name,'parent':parent,'quantity':q,'modeledQuantity':n,'status':status}
    if reason:d['reason']=reason
    return d


def build_one(entry,c):
    page,sec,L=c['page'],c['sec'],c['L'];pages=[page,sec]
    pocket=Polygon([(0,0),(400,0),(400,300),(300,300),(300,55),(100,55),(100,300),(0,300)])
    parts=[geom.extrusion_part('Левое корыто500×200, дно55',pocket,[0,0,0],[0,0,1],[0,1,0],[1,0,0],500,pages),
           geom.extrusion_part('Средняя часть400×300',box(0,0,400,300),[500,0,0],[0,0,1],[0,1,0],[1,0,0],L-1000,pages),
           geom.extrusion_part('Правое корыто500×200, дно55',pocket,[L-500,0,0],[0,0,1],[0,1,0],[1,0,0],500,pages)]
    ordinary=[path(f'pos7-{i}',[[20,60,z],[L-20,60,z]],c['ordinaryD'],7,c['ordinaryL'],pages) for i,z in enumerate([50,350],1)]
    groups=[group('ordinary-longitudinal',f'Поз.7 Ø{c["ordinaryD"]} A500C L{c["ordinaryL"]}',7,2,pages,ordinary)]
    # Own cage117: common top datum280; end280−25=255, mid280−50=230.
    # Thus the upper-bar drop is25, with380/125 horizontal transitions.
    # Main own section2-2 dimension40 locates the longitudinal cage axes.
    uppers=[];lowers=[]
    for i,z in enumerate([40,360],1):
        uppers.append(path(f'cage-upper-{i}',[[10,255,z],[390,255,z],[515,230,z],[L-515,230,z],[L-390,255,z],[L-10,255,z]],c['upperD'],6,c['upperL'],pages+[117],component=c['cage'],detailPosition='1',instance=str(i)))
        lowers.append(path(f'cage-lower-{i}',[[10,180,z],[L-10,180,z]],12,6,c['lowerL'],pages+[117],component=c['cage'],detailPosition='2',instance=str(i)))
    groups.append(group('cage-upper',f'{c["cage"]}×2: верхние продольные стержни',6,2,pages+[117],uppers))
    groups.append(group('cage-lower',f'{c["cage"]}×2: нижние продольные стержни',6,2,pages+[117],lowers))
    cage_top_datum=20+260
    assert cage_top_datum==280 and cage_top_datum-25==255 and cage_top_datum-50==230==300-70
    assert all([p[1] for p in bar['points']]==[255,255,230,230,255,255] for bar in uppers)
    assert c['lowerL']==L-20 and 55+400+75+c['A']+75+400+55==c['lowerL']
    strands=[];yz=[(77,125),(77,200),(77,275)]+([(122,200)] if c['kQty']==4 else [(122,125),(122,200),(122,275)])
    coefficient=c['kKg']/(c['kL']/1000)
    for i,(y,z) in enumerate(yz,1):
        strands.append(path(f'k7-{i}',[[500,y,z],[L-500,y,z]],12.5,8,c['kL'],pages,
           material='К7-12,5-1770',wireCountPerStrand=7,kgPerM=coefficient,openStart=True,openEnd=True,finalPocketBendsModeled=False,
           lengthBasis='Подтверждённый центральный прямой участок; Lспецификации — заготовка с неотображёнными концами'))
    groups.append(group('prestressing','К7-12,5-1770: подтверждённые центральные участки',8,c['kQty'],pages,strands,material='К7-12,5-1770',wireCountPerStrand=7,kgPerM=coefficient,
       linearMassBasis=f'{c["kKg"]} кг / ({c["kL"]} мм /1000), по округлённой массе и длине заготовки собственной спецификации'))
    bounds=geom._bounds_of(parts);actual=[bounds[1][i]-bounds[0][i] for i in range(3)];expected=[L,300,400]
    v=sum(geom.part_volume(p) for p in parts)/1e9;analytic=(L*400*300-2*500*200*245)/1e9
    assert actual==expected and abs(v-analytic)<1e-12
    checks=[
       {'check':'signed-dimensions','result':'pass','expected':expected,'actual':actual,'units':'mm','sourcePages':pages,
        'detail':f'Собственный фасад PDF{page}: L{L}, H300; план1–1: B400, 100+200+100; два корытаL500, дно55. Габариты реальной геометрии совпадают.'},
       geom._volume_check(parts,c['volume'],f'doc09 PDF{sec}, лист{sec-11}: бетонВ35 {c["volume"]:.3f}м³',tolerance=.01),
       {'check':'independent-concrete-volume','result':'pass','modelM3':v,'analyticM3':analytic,
        'detail':f'({L}×400×300−2×500×200×245)/10^9={analytic:.6f}м³; геометрия не подгонялась к округлённой спецификации.'},
       *geom._structure_checks(parts),
       {'check':'cage-own-dimension-chain','result':'pass','sourcePages':pages+[117],
        'detail':f'{c["cage"]}: собственная строка L{c["lowerL"]},A{c["A"]},B75; 55+400+75+{c["A"]}+75+400+55={c["lowerL"]}. Нижние прямые: оси z40/360,y180 по2–2/3–3 и детали117. Верхние: общий datum280, концы280−25=255, середина280−50=230; собственное3–3подтверждает300−70=230; поперечины и сварная посадка также pending.'},
       mass_check('pos7-mass-vs-own-spec','Поз.7,2прямых стержня',groups,['ordinary-longitudinal'],2*c['ordinaryKg'],pages),
       {'check':'cage-upper-common-datum-regression','result':'pass','sourcePages':pages+[117],'detail':'Размер50 в детали117 начинается от верха поперечинy280, как и размер25. Поэтому конец255, середина230, перепад25. Независимо собственное3–3:300−70=230. Проверены реальные координаты обоих верхних путей.',
        'expected':{'datumY':280,'endY':255,'midY':230,'drop':25,'section33Y':230},'actual':{'datumY':cage_top_datum,'endY':uppers[0]['points'][0][1],'midY':uppers[0]['points'][2][1],'drop':uppers[0]['points'][0][1]-uppers[0]['points'][2][1],'section33Y':300-70},'units':'mm'},
       mass_check('cage-upper-mass-vs-detail','Каркасы,2верхних продольных',groups,['cage-upper'],2*c['upperKg'],pages+[117]),
       mass_check('cage-lower-mass-vs-detail','Каркасы,2нижних продольных',groups,['cage-lower'],2*c['lowerKg'],pages+[117]),
       mass_check('cage-partial-mass-vs-own-spec','Неполные каркасы:4продольных,24поперечины pending',groups,['cage-upper','cage-lower'],2*c['cageKg'],pages+[117],partial=True),
       mass_check('k7-retained-vs-blank-mass','К7: только центральные прямые участки против массы полных заготовок',groups,['prestressing'],c['kQty']*c['kKg'],pages,partial=True),
       mass_check('k7-vs-steel-schedule','К7: центральные прямые участки против собственной ведомости стали',groups,['prestressing'],c['kTotal'],pages,partial=True),
       {'check':'steel-envelope-and-endpoints','result':'pass','sourcePages':pages,
        'detail':'Все показанные осевые точки конечны и в габаритах бетона. Поз.7: x20…L−20,y60,z50/350; продольные каркасов: x10…L−10,z40/360, низy180, верх255→230→255; К7 толькоx500…L−500. Это не проверка сварных коллизий/производственной посадки.'},
       {'check':'cage-bend-radius-and-crossbar-layer','result':'warn','sourcePages':pages+[117],
        'detail':'Верхние продольные построены по правильной общей базе280:280−25=255,280−50=230; радиусы малых перегибов не размерены, показана размерная ломаная без придуманного радиуса. Ось поперечин/сварные смещения25/40 не выбраны, все24поперечины pending.'},
    ]
    coverage=[cov(1,'С1',2,0,'pending','Нет однозначно подтверждённой полной осевой посадки гибов/сварных слоёв; не перенесена с Р4'),
       cov(2,c['loop'],2,0,'pending','Монтажные петли: окончательная ориентация крюков/база радиусов требует сверки'),
       cov(3,'Хм1',c['stirrups'],0,'pending','Свободные окончания, нахлёст160 и база радиусовR30 требуют отдельного восстановления'),
       cov(4,c['lowerMesh'],c['lowerQty'],0,'pending','Собственная спецификация известна; пространственная посадка/нахлёст и гибы не восстановлены'),
       cov(5,c['upperMesh'],c['upperQty'],0,'pending','Собственная спецификация известна; пространственная посадка/нахлёст и гибы не восстановлены'),
       {**cov(6,c['cage'],2,0,'partial','Полных каркасов0: показаны4продольных стержня для2частичных сборок по собственному листу117;24поперечины, сварные слои и малые радиусы верхних перегибов pending'),'partialAssemblyQuantity':2,'modeledLongitudinalBars':4,'pendingCrossbars':24},
       cov('6.1',f'Ø{c["upperD"]} L{c["upperL"]}',2,2,'partial','Размерная ось подтверждена: datum280,концы255,середина230; малые радиусы не заданы, показана размерная ломаная',parent=c['cage']+'×2'),
       cov('6.2',f'Ø12 L{c["lowerL"]}',2,2,parent=c['cage']+'×2'),
       cov('6.3','Ø10 L260',24,0,'pending','Ось сварного слоя относительно25/40 не подтверждена, условный сдвиг не выбран',parent=c['cage']+'×2'),
       cov(7,f'Ø{c["ordinaryD"]} L{c["ordinaryL"]}',2,2),
       {**cov(8,'К7-12,5-1770',c['kQty'],0,'partial','Полных канатов готового изделия0: представлены только центральные прямыеx500…L−500; концы/загибы и припуски заготовок не построены'),'partialItemQuantity':c['kQty'],'modeledRetainedLengthPerItemMm':L-1000,'specBlankLengthPerItemMm':c['kL']},
       cov('embedded','Закладные пластины/детали',0,0,'not-applicable','В собственной спецификации поз.1–8 закладных металлических деталей нет'),
    ]
    solid={'id':entry['id'],'sourceId':'doc09','alias':entry['alias'],'supplyId':SUPPLY,'format':'project-solids-mm-v1','status':'partial','modelType':'beam',
       'elementType':'железобетонный ригель с торцевыми корытами и К7 по собственной спецификации','concreteParts':parts,'metalParts':[],'groups':groups,'bounds':bounds,
       'coordinateSystem':'мм; x — длина, y — вверх, z — ширина','coordinateOrigin':'левый торецx0; низy0; левая грань разрезаz0',
       'evidence':[{'pdfPage':page,'sheet':str(page-11),'subject':f'Собственный {c["alias"]}: фасад,план1–1,схема армирования',
           'checks':[f'длина{L},сечение400×300,корыта500×200,дно55','торцевые отступы обычных продольных20','примечания требуют загнуть К7 в корытах; траектория не размерена']},
          {'pdfPage':sec,'sheet':str(sec-11),'subject':f'Собственные разрезы2–2/3–3,видА и спецификация {c["alias"]}',
           'checks':[f'бетон{c["volume"]:.3f}м³',f'поз.7:Ø{c["ordinaryD"]} L{c["ordinaryL"]}×2,осиy60,z50/350',f'К7×{c["kQty"]},Lзаготовки{c["kL"]},массаед.{c["kKg"]}; собственные уровни77/122 и z125/200/275',
                     f'две{c["cage"]},собственная ссылка на лист106 PDF117; нижниеосиy180,z40/360; верх:255→230→255; независимаябаза300−70=230совпадаетс280−50','в спецификации нет закладных пластин/деталей']},
          {'pdfPage':117,'sheet':'106','subject':f'Собственная строка{c["cage"]}: продольные стержни и размеры',
           'checks':[f'L{c["lowerL"]},A{c["A"]},B75; верхняяпоз.1Ø{c["upperD"]}L{c["upperL"]}; нижняяпоз.2Ø12L{c["lowerL"]};поперечиныпоз.3Ø10L260×12',
                     'в детали верх380|125*,размер50отобщейбазы280:концы280−25=255,центр280−50=230,перепад25. Собственное3–3:300−70=230; нижняяось180=255−75']},],
       'pending':[{'id':'strand-pocket-bends','kind':'not-modeled','sourcePages':pages,'description':'Все4/6канатов этого изделия проходят в корытах; включены только центральные подтверждённые прямые участки. Загибы внутри двух корыт500, радиусы, направления и окончания не размерены; заготовочные припуски не удлиняют модель.'},
          {'id':'meshes-stirrups-loops','kind':'not-modeled','sourcePages':pages+[108,c['lowerPage'],c['upperPage']],
           'description':f'С1×2,{c["loop"]}×2,Хм1×{c["stirrups"]},{c["lowerMesh"]}×{c["lowerQty"]},{c["upperMesh"]}×{c["upperQty"]} пока не построены: изгибы, сварная посадка, положение окончаний и нахлёсты требуют отдельной сверки.'},
          {'id':'cage-crossbars-and-welds','kind':'not-modeled','sourcePages':pages+[117],'description':'Каркасы:4продольных построены по собственным осям. Малые радиусы верхних перегибов не заданы, в модели размерная ломаная.24поперечиныØ10L260 не включены: ось сварного слоя по25/40 не подтверждена. Сварные швы/выборки и физические коллизии не восстановлены.'}],
       'assumptions':['Бетон построен непосредственно по собственному фасаду/плану/разрезам; округлённый объём спецификации не использован для подгонки размеров.',
          'Прямые поз.7 и продольные каркасов размещены по собственным размерным осям; z40/360 не заменены произвольными слоями41/359. Сварные детали, для которых глубина неоднозначна, пропущены.',
          'К7 имеет эффективный коэффициент массы из собственных массы/длины заготовки, а не площадь сплошного кругаØ12.5. Показанные отрезки короче заготовки; недостающие загибы/обрезки не моделируются.',
          'Верхние стержни каркасов заданы размерной ломаной: концы255,середина230. Оба размера25и50 отсчитаны от общего верха поперечин280; собственное3–3независимо даёт300−70=230. Радиусы малых перегибов не придуманы; производственная форма гибов не подтверждена.'],
       'notes':['Бетон с двумя корытами, обычные прямые поз.7, четыре продольных каркасов и центральные прямые К7 по собственным листам. Остальные позиции и окончания явно pending.','К7 присутствует по собственной спецификации. Закладных деталей в поз.1–8 нет; сталь другой марки не переносилась.','Проектные данные, ресурсы, массы и калькуляция не изменялись; производственная посадка и допуск в производство не подтверждены.'],
       'readinessDescription':'Восстановлены бетон с двумя корытами, два обычных прямых стержня, четыре продольных каркасов и центральные прямые К7. Полных каркасов0: поперечины, малые радиусы верхних перегибов, сетки, Хм1, монтажные петли и загибы К7 остаются pending.','supersedesSketch':True}
    allpaths=[p for g in groups for p in g['paths']]
    assert all(all(math.isfinite(v) for v in q) and 0<=q[0]<=L and 0<=q[1]<=300 and 0<=q[2]<=400 for p in allpaths for q in p['points'])
    qa={'alias':c['alias'],'status':'partial','checks':checks,'componentCoverage':coverage,
       'massScope':{'model':'Фактическая длина только показанных осевых путей','strandCoefficient':'own rounded unit mass / own blank length; K7 solid-circle area is not used'},
       'counts':{'concreteParts':len(parts),'metalParts':0,'groups':len(groups),'paths':len(allpaths),'checks':len(checks),'warnings':sum(q['result']=='warn' for q in checks),'failures':sum(q['result']=='fail' for q in checks)}}
    steel_gate.steel_totals(solid);steel_gate.verify_mass_scopes(solid,qa)
    return solid,qa


def build():
    assert hashlib.sha256((ASSETS/'sources/doc09.pdf').read_bytes()).hexdigest()==SOURCE_SHA
    catalog=json.loads((ASSETS/'promka-models.json').read_text());catalog.update(json.loads((ASSETS/'promka-register.json').read_text()))
    existing=json.loads((ASSETS/'promka-solid-models.json').read_text());supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text())
    by_alias={v.get('alias'):v for v in catalog.values()};models={};qas={}
    for c in CONFIGS:
        e=by_alias[c['alias']];key=e['id'];assert not e.get('excluded') and not e.get('groups')
        assert e['source']['productPage']==c['page'] and e['source']['id']=='doc09'
        assert key not in existing or existing[key].get('supplyId')==SUPPLY,'Existing solid must not be replaced'
        m,q=build_one(e,c);models[key]=m;qas[key]=q
    sys.path.insert(0,str(ROOT));from app.calc.source_policy import SourcePolicy
    policy=SourcePolicy(ASSETS)
    for m in models.values():policy.reading(m,'doc09')
    for q in qas.values():policy.reading(q,'doc09')
    sha=digest(models);old=supplies.get(SUPPLY,{})
    captured=old.get('capturedAt') if old.get('modelsSha256')==sha else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={'label':'Codex · Р8/Р9/Р10/Р10.1 по собственным листам','snapshot':'20261111-next-rigels-long','modelsSha256':sha,'modelCount':len(models),'capturedAt':captured,
       'qa':{'modelsSha256':sha,'tool':'scripts/build_calc_next_rigels_long.py','covers':['собственные габариты/корыта и объём бетона','обычные продольные и продольные каркасов: собственные диаметры/количества/размещения','К7: собственное число и подтверждённые центральные прямые участки с эффективной линейной массой','покомпонентные массы всех созданных paths через groupIds','SourcePolicy всех ссылок'],
             'doesNotCover':['поперечины каркасов, сетки С1/СР/СВ, Хм1, монтажные петли','радиусы/траектории загибов К7 и припуски заготовок','сварные слои, малые радиусы продольных каркаса и отсутствие коллизий','производственная посадка и допуск в производство'],'models':qas},
       'report':'4новых ригеля Р8/Р9/Р10/Р10.1: собственный бетон с корытами, обычные прямые поз.7, четыре продольных каркасов и центральные прямые К7. Остальные компоненты и концы не выдуманы, явно pending. Общие калькуляционные данные не менялись.'}
    return {'models':models,'supplies':{SUPPLY:delivery}}


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,default=ROOT/'tmp/next-rigels/long.json');args=ap.parse_args()
    p=build()
    if args.output.exists():
        prior=json.loads(args.output.read_text()).get('supplies',{}).get(SUPPLY,{})
        if prior.get('modelsSha256')==p['supplies'][SUPPLY]['modelsSha256']:
            p['supplies'][SUPPLY]['capturedAt']=prior['capturedAt']
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(dump(p))
    for k,m in p['models'].items():print(m['alias'],p['supplies'][SUPPLY]['qa']['models'][k]['counts'])
    print(args.output)
if __name__=='__main__':main()

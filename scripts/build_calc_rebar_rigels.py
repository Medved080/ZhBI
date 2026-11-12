#!/usr/bin/env python3
"""Upgrade ten reviewed doc09 concrete models, writing a separate SHA-guarded package.

Own sheets PDF13–20,22–23, common details PDF48, cages PDF50, meshes PDF53/55
were visually reviewed. Curved common detail paths are reconstructed from their
own dimensions, including the tapered 1П2/1П3 and tangent R35 bends of1С1.
Missing tails/bends and unresolved welding placement are explicitly partial.
"""
import copy
import argparse
import datetime
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.calc.source_policy import SourcePolicy

ASSETS = ROOT/'data/calc/assets'
SUPPLY_ID = 'codex-rebar-rigels-20261111-v2'
OUT = ROOT/'tmp/rebar-models/rigels-v2.json'

# alias, own PDF, cage, lower rod diameter, mesh suffix, stirrup count,
# strand blank length and rounded unit mass from own spec, extra straight bars.
ROWS = [
 ('1Р1',13,'1',12,'1',30,5650,4.10,None),
 ('1Р2',14,'2',12,'2',30,5700,4.14,None),
 ('1Р2.1',15,'2',12,'2',30,5700,4.14,(20,5010,12.36)),
 ('1Р3',16,'3',12,'3',32,5800,4.21,None),
 ('1Р3.1',17,'3',12,'3',32,5800,4.21,(20,5110,12.60)),
 ('1Р4',18,'4',12,'4',32,5850,4.25,None),
 ('1Р4.1',19,'4.1',14,'4.1',34,5850,4.25,None),
 ('1Р5',20,'5',12,'5',34,6050,4.39,None),
 ('1Р6',22,'6',12,'6',34,6100,4.43,None),
 ('1Р6.1',23,'6',12,'6.1',36,6100,4.43,None),
]
# PDF50: actual L of cage, central A, end B, cage mass per own spec.
CAGES = {'1':(4980,3890,90,14.22),'2':(5030,3970,75,14.35),
         '3':(5130,4080,70,14.59),'4':(5180,4090,90,14.72),
         '4.1':(5180,4130,70,16.38),'5':(5380,4300,85,15.21),
         '6':(5430,4360,80,15.33)}
# PDF53/55: mesh length, upper A1/A2, explicit pitch/count segments, bars/mesh,
# upper and lower spec mass. Lower A1 is upper+20, A2 is upper-20.
MESHES = {
 '1':(2150,65,235,[(90,1),(100,7),(150,2),(160,1),(200,3)],15,5.47,8.93),
 '2':(2175,65,235,[(90,1),(100,6),(135,1),(150,3),(200,3)],15,5.48,8.95),
 '3':(2225,45,235,[(95,1),(100,8),(150,3),(200,3)],16,5.82,9.46),
 '4':(2250,65,235,[(90,1),(100,7),(110,1),(150,3),(200,3)],16,5.83,9.49),
 '4.1':(2250,50,210,[(90,1),(100,7),(150,8)],17,6.15,9.95),
 '5':(2350,65,235,[(90,1),(100,8),(110,1),(150,3),(200,3)],17,6.18,10.04),
 '6':(2375,60,235,[(80,1),(100,8),(150,4),(200,3)],17,6.19,10.06),
 '6.1':(2375,60,210,[(95,1),(100,7),(110,1),(150,8)],18,6.51,10.53),
}
# Own assembly chains, from first span stirrup to last (not cage rods).
STIRRUPS = {
 '1Р1':(540,[(100,8),(150,2),(160,1),(200,7),(160,1),(150,2),(100,8)]),
 '1Р2':(540,[(100,7),(135,1),(150,3),(200,7),(150,3),(135,1),(100,7)]),
 '1Р2.1':(540,[(100,7),(135,1),(150,3),(200,7),(150,3),(135,1),(100,7)]),
 '1Р3':(525,[(100,9),(150,3),(200,7),(150,3),(100,9)]),
 '1Р3.1':(525,[(100,9),(150,3),(200,7),(150,3),(100,9)]),
 '1Р4':(540,[(100,8),(110,1),(150,3),(200,7),(150,3),(110,1),(100,8)]),
 '1Р4.1':(525,[(100,8),(150,17),(100,8)]),
 '1Р5':(540,[(100,9),(110,1),(150,3),(200,7),(150,3),(110,1),(100,9)]),
 '1Р6':(525,[(100,9),(150,4),(200,7),(150,4),(100,9)]),
 '1Р6.1':(540,[(100,8),(110,1),(150,17),(110,1),(100,8)]),
}
# Own steel schedules: К7, Вр-I5, А24012, A500C8/10/12/14/16/20 and total kg.
SCHEDULES = {
 '1Р1':(24.60,5.30,1.68,3.94,62.06,8.84,0,15.76,0,122.18),
 '1Р2':(24.84,5.36,1.68,3.94,62.06,8.94,0,15.92,0,122.74),
 '1Р2.1':(24.84,5.36,1.68,3.94,62.06,8.94,0,15.92,24.72,147.46),
 '1Р3':(25.26,5.50,1.68,3.94,65.44,9.10,0,16.22,0,127.14),
 '1Р3.1':(25.26,5.50,1.68,3.94,65.44,9.10,0,16.22,25.20,152.34),
 '1Р4':(25.50,5.54,1.68,3.94,65.44,9.20,0,16.38,0,127.68),
 '1Р4.1':(25.50,5.54,1.68,3.94,68.84,0,12.52,16.38,0,134.40),
 '1Р5':(26.34,5.78,1.68,3.94,68.84,9.56,0,17.02,0,133.16),
 '1Р6':(26.58,5.86,1.68,3.94,68.84,9.64,0,17.18,0,133.72),
 '1Р6.1':(26.58,5.86,1.68,3.94,72.24,9.64,0,17.18,0,137.12),
}


def dump(v):
    return json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def sha(v):
    return hashlib.sha256(dump(v).encode()).hexdigest()


def length(p):
    return sum(math.dist(a,b) for a,b in zip(p['points'],p['points'][1:]))


def mass(p):
    coefficient = p.get('kgPerM', math.pi*p['diameter']**2/4*0.00785)
    return length(p)/1000*coefficient


def path(pid,points,diameter,material,position,detail,blank,pages,**extra):
    return dict(id=pid,points=points,diameter=diameter,material=material,
                position=str(position),detailPosition=str(detail),projectLength=blank,
                sourcePages=pages,**extra)


def pitches(start,segments):
    out=[start]
    for pitch,count in segments:
        for _ in range(count):out.append(out[-1]+pitch)
    return out


def arc2(center,r,start,end,n=48):
    return [[center[0]+r*math.cos(start+(end-start)*i/n),
             center[1]+r*math.sin(start+(end-start)*i/n)] for i in range(n+1)]


def loop_1p(x,diameter,position,pages,pid):
    # PDF48: shared 1П2/1П3 drawing, height350, R35 top, base50,
    # bottom hooks R30/60 and free ends40. No scaling of a foreign loop.
    left=arc2([x-30,60],30,math.pi,2*math.pi)
    right=arc2([x-30,60],30,0,-math.pi)
    top=arc2([150,345],35,math.pi,0)
    pts=[[x-60,100,125]]+[[xx,yy,125] for xx,yy in left]
    pts += [[x,yy,zz] for zz,yy in top]
    pts += [[xx,yy,175] for xx,yy in right]+[[x-60,100,175]]
    return path(pid,pts,diameter,'А240',position,5,950,pages,placementVerified=False,
                radiusDimensionBasis='R35 и R30 приняты по оси; окончательную базу радиуса подтвердить',
                shapeDescription='1П2/1П3: верх70 по R35, сужение до50 между ветвями у нижних крюков; H350')


def end_bent_profile():
    # PDF48 view A: exact top110, lower250, heights205+275 and R35.
    # Tangent from (95,300) to left bend circle centered(60,60), R35;
    # not a fillet of a sharp theoretical corner (which wrongly loses20mm width).
    theta=math.atan2(240,35)+math.acos(35/math.hypot(240,35))
    left=arc2([60,60],35,theta,1.5*math.pi)
    right=[[300-z,y] for z,y in reversed(left)]
    return [[95,505],[95,300]]+left+right+[[205,300],[205,505]]


def round_rectangle_profile():
    # Main dimensioned contour only, 110×445 R30; omitted tails remain pending.
    zy=[]
    for c,a,b in [([125,85],math.pi,1.5*math.pi),([175,85],1.5*math.pi,2*math.pi),
                  ([175,470],0,.5*math.pi),([125,470],.5*math.pi,math.pi)]:
        zy+=arc2(c,30,a,b)
    return zy+[zy[0]]


def mesh_profile(upper):
    if upper:
        return [[25,130]]+arc2([55,250],30,math.pi,.5*math.pi)+arc2([245,250],30,.5*math.pi,0)+[[275,130]]
    return [[25,290]]+arc2([55,55],30,math.pi,1.5*math.pi)+arc2([245,55],30,1.5*math.pi,2*math.pi)+[[275,290]]


def transformed(template,pid,fn,position,pages,blank=None):
    p=copy.deepcopy(template)
    p.update(id=pid,points=[[round(t,5) for t in fn(v)] for v in p['points']],
             position=str(position),sourcePages=pages,placementVerified=False)
    if blank is not None:p['projectLength']=blank
    return p


def group(gid,name,position,quantity,paths,pages,reason):
    return {'id':gid,'name':name,'position':str(position),'quantity':quantity,
            'unit':'шт.','paths':paths,'sourcePages':pages,'status':'partial' if reason else 'modeled',
            'placementDescription':reason or 'По собственным размерным цепям.'}


def component_check(g,spec):
    actual=sum(mass(p) for p in g['paths']);dev=(actual/spec-1)*100
    return {'check':'mass-vs-spec','result':'warn' if g['status']=='partial' or abs(dev)>3 else 'pass',
            'component':g['name'],'position':g['position'],'modelKg':round(actual,6),
            'groupIds':[g['id']],'metalPartIndices':[],
            'specKg':spec,'deviationPercent':round(dev,4),
            'detail':f"{g['name']}: осевые пути {actual:.3f} кг / спецификация {spec:.3f} кг ({dev:+.2f}%). "+g['placementDescription'],
            'scope':'actual rendered path lengths; K7 uses own-spec kg/m, others 7850 kg/m³'}


def build(base_path=None,replacement_base=None):
    live=json.loads((ASSETS/'promka-solid-models.json').read_text())
    replacement_raw=copy.deepcopy(live)
    replacement_source=Path(replacement_base) if replacement_base else OUT.with_name(OUT.stem+'-replacement-base.json')
    if replacement_source.is_file():
        replacement_raw.update(json.loads(replacement_source.read_text()))
    elif replacement_base:
        raise FileNotFoundError(replacement_source)
    if base_path:
        live.update(json.loads(Path(base_path).read_text()))
    supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text())
    register=json.loads((ASSETS/'promka-register.json').read_text())
    by_alias={v['alias']:v for v in register.values()}
    policy=SourcePolicy(ASSETS)
    models,replaces,qas={},{},{}
    for alias,page,cage_suffix,lower_d,mesh_suffix,st_count,blank_k,k_unit,extra in ROWS:
        entry=by_alias[alias];key=entry['id'];old=live[key];solid=copy.deepcopy(old)
        assert not old['groups'] and not old['metalParts'] and old['sourceId']=='doc09'
        assert entry['source']['productPage']==page
        L=old['bounds'][1][0];pages=[page,48];groups=[];specs=[]
        # Straight retained prestress segments: four side strands flush with ends;
        # two central strands only between pocket inner faces, not invented bends.
        kp=8 if extra else 7
        strands=[]
        for iy,y in enumerate([77,122]):
            for iz,z in enumerate([75,150,225]):
                x0,x1=(500,L-500) if z==150 else (0,L)
                strands.append(path(f'k7-{iy}-{iz}',[[x0,y,z],[x1,y,z]],12.5,'К7-12,5-1770',kp,kp,blank_k,[page],
                                    kgPerM=k_unit/(blank_k/1000),finalPocketBendsModeled=False if z==150 else None,
                                    openStart=z==150,openEnd=z==150))
        g=group('prestressing','К7-12,5-1770',kp,6,strands,[page],
                'Показаны прямые участки после обрезки; загибы двух центральных канатов в корытах не размерены и не выдуманы. Масса заготовок и масса показанных участков различаются.')
        g['kgPerM']=k_unit/(blank_k/1000);groups.append(g);specs.append(6*k_unit)
        # Identical named own-detail 1С1: 5 Ø10 and 6 Ø8 per mesh, two ends.
        end=[]
        profile=end_bent_profile()
        template_left=[path(f'end-base-{i}',[[40+100*i,y,z] for z,y in profile],10,'А500С',1,1,1200,pages,placementVerified=False) for i in range(5)]
        # Welded Ø8 positions at50/150 along each sloping leg, plus bottom85.
        theta=math.atan2(240,35)+math.acos(35/math.hypot(240,35))
        tangent=[60+35*math.cos(theta),60+35*math.sin(theta)]
        slope_length=math.dist([95,300],tangent)
        wire_yz=[]
        for side in [0,1]:
            for d in [50,150]:
                z=95+(tangent[0]-95)*d/slope_length
                y=300+(tangent[1]-300)*d/slope_length
                # Keep a disclosed nominal welded-layer offset; not a fabrication claim.
                z+=9
                wire_yz.append((y,z if side==0 else 300-z))
        wire_yz += [(34,107.5),(34,192.5)]
        for i,(y,z) in enumerate(wire_yz):template_left.append(path(f'end-wire-{i}',[[20,y,z],[850,y,z]],8,'А500С',1,2,830,pages,placementVerified=False))
        for side in [0,1]:
            for i,p in enumerate(template_left):
                end.append(transformed(p,f'end-{side}-{i}',lambda v,side=side:[v[0] if side==0 else L-v[0],v[1],v[2]],1,pages))
        groups.append(group('end-mesh','1С1',1,2,end,pages,
                            'Собственная 1С1 PDF48: 5Ø10 L1200 + 6Ø8 L830 в каждой. Гнутый профиль по виду А; точные сварные слои и осевые базы промежуточных гибов требуют проверки.'))
        specs.append(2*5.67)
        # Own cage dimensions, no longitudinal scaling of foreign bars.
        cl,A,B,cm=CAGES[cage_suffix];assert cl==L-20
        assert 55+400+B+A+B+400+55==cl
        cp=[]
        cage_x=[55+100*i for i in range(5)]+[455+B,455+B+A]+[455+2*B+A+100*i for i in range(5)]
        assert len(cage_x)==12 and cage_x[-1]==cl-55
        for side,z in [(0,30),(1,270)]:
            sign=1 if side==0 else -1
            top=[[10,255,z+sign*13],[510,255,z+sign*13],[660,230,z+sign*13],
                 [L-660,230,z+sign*13],[L-510,255,z+sign*13],[L-10,255,z+sign*13]]
            cp.append(path(f'cage-{side}-1',top,16,'А500С',3,1,L-10,[page,50],placementVerified=False))
            cp.append(path(f'cage-{side}-2',[[10,180,z+sign*(5+lower_d/2)],[L-10,180,z+sign*(5+lower_d/2)]],lower_d,'А500С',3,2,cl,[page,50],placementVerified=False))
            for i,x in enumerate(cage_x):cp.append(path(f'cage-{side}-3-{i}',[[10+x,20,z],[10+x,280,z]],10,'А500С',3,3,260,[page,50],placementVerified=False))
        groups.append(group('flat-cages','1К'+cage_suffix,3,2,cp,[page,50],
                            'Размеры собственного каркаса PDF50, 12 поперечных стержней каждого каркаса. Продольные стержни привязаны к проекции сечения; сварные слои и осевые радиусы гиба верхнего стержня требуют проверки.'))
        specs.append(2*cm)
        # Span stirrup intrinsic profile is same 1Хм1; its missing tails remain open.
        first,segments=STIRRUPS[alias];xs=pitches(first,segments)
        assert len(xs)==st_count and xs[-1]==L-first
        st=[]
        for i,x in enumerate(xs):st.append(path(f'stirrup-{i}',[[x,y,z] for z,y in round_rectangle_profile()],10,'А500С',4,6,1470,pages,placementVerified=False,openStart=True,openEnd=True))
        groups.append(group('span-stirrups','1Хм1',4,st_count,st,pages,
                            'Количество и все шаги — собственная размерная цепь. Показан основной контур PDF48; свободные окончания и пространственное направление нахлёста160 не определены и не достроены.'))
        specs.append(st_count*.91)
        # Each own mesh has its own full pitch/count chain. 330 is the dimensioned
        # nominal overlap in assembly, also required by note as minimum330.
        ml,a1,a2,segs,ncross,um,lm=MESHES[mesh_suffix]
        assert a1+sum(s*n for s,n in segs)+a2==ml
        start=(L-(2*ml-330))/2
        assert start==515
        for upper,gid,pos,sm in [(True,'span-upper',5,um),(False,'span-lower',6,lm)]:
            yz_wires=[(272.5,80),(272.5,220)] if upper else [(250,32.5),(140,32.5),(250,267.5),(140,267.5),(32.5,62.5),(32.5,237.5)]
            pp=[]
            for side,xstart in [(0,start),(1,L-start-ml)]:
                cross_x=pitches(a1 if upper else a1+20,segs)
                assert len(cross_x)==ncross
                assert abs(cross_x[-1]+(a2 if upper else a2-20)-ml)<1e-8
                for i,x in enumerate(cross_x):
                    xnew=xstart+x
                    pp.append(path(f'{gid}-{side}-cross-{i}',[[xnew,y,z] for z,y in mesh_profile(upper)],10,'А500С',pos,2,520 if upper else 750,[page,53 if upper else 55],placementVerified=False))
                for i,yz in enumerate(yz_wires):
                    pp.append(path(f'{gid}-{side}-wire-{i}',[[xstart,*yz],[xstart+ml,*yz]],5,'Вр-I',pos,1,ml,[page,53 if upper else 55],placementVerified=False))
            groups.append(group(gid,('1СВ' if upper else '1СР')+mesh_suffix,pos,2,pp,[page,53 if upper else 55],
                                'Собственные количество, длина и шаги PDF'+('53' if upper else '55')+'. Размер330 в сборке принят как номинальный нахлёст (примечание требует не менее330). Точное взаимное положение сварных слоёв требует проверки.'))
            specs.append(2*sm)
        # 1П3 identical own detail; axis at own signed600 (620 for1Р4).
        loop_x=620 if alias=='1Р4' else 600
        lp=[]
        for side in [0,1]:
            p=loop_1p(loop_x,12,2,pages,f'lifting-{side}')
            if side:p['points']=[[L-x,y,z] for x,y,z in p['points']]
            lp.append(p)
        groups.append(group('lifting-loops','1П3',2,2,lp,pages,
                            'Собственная 1П3 PDF48 Ø12 L950; выпуск80 и позиции600 от торцов (1Р4:620) по сборке. База радиуса R35 и глубинная ориентация нижних крюков остаются вопросом проверки.'))
        specs.append(2*.84)
        if extra:
            d,bl,unit=extra;assert L-bl==40
            ep=[path(f'ordinary-{i}',[[20,50,z],[L-20,50,z]],d,'А500С',7,7,bl,[page]) for i,z in enumerate([50,250])]
            groups.append(group('ordinary-longitudinal',f'Ø{d} А500С',7,2,ep,[page],''));specs.append(2*unit)
        # The own specs have no embedded/anchor plate position. Do not invent them.
        solid.update(supplyId=SUPPLY_ID,groups=groups,status='partial',
            readinessDescription='Представлены все позиции стали; геометрия частична: канаты, сетки, каркасы и петли по собственным листам. Загибы канатов, окончания хомутов и часть сварных привязок остаются неполными; закладных пластин в спецификации нет.')
        solid['pending']=[g['name']+': '+g['placementDescription'] for g in groups if g['status']=='partial']
        solid['pending'].append('1С1: нижняя размерная цепь80+85+80 даёт245, а общий размер250. Сохранена подтверждённая пара85 симметрично оси, внешние отступы82.5 условны до уточнения цепи; это не подтверждённые80.')
        solid['pending'].append('Общая проверка коллизий и защитных слоёв всей арматурной сборки не завершена; модель не является производственной.')
        solid['pending'].append('1Хм1: отсутствующие окончания дают около28.3% недобора массы группы относительно заготовок; это основная неполнота обычной арматуры. ВидВпослесгиба и веер PDF48 не задают однозначный пространственный путь этих ветвей.')
        if alias=='1Р4':
            solid['pending'].append('Петли1П3 у1Р4 привязаны на620мм отторцов по собственной схеме армирования; соседний вид1-1 даёт600мм. Разночтение20мм не разрешено автоматически; нужна проверка проектировщика.')
        solid['notes']=[n for n in solid.get('notes',[]) if 'Индивидуальное бетонное тело' not in n]+[
            'Арматура добавлена по собственному листу и именованным деталям; бетон и исходные расчётные показатели не изменены.',
            'Закладных стальных пластин, анкеров закладных и труб в собственной спецификации нет. Монтажные петли 1П3 показаны как арматурные петли, не как закладные пластины.']
        solid['assumptions']+=['Именованные 1С1, 1Хм1, 1П3 и поперечные профили сеток построены заново по размерным цепям PDF48/53/55; плоские каркасы и шаги сеток пересчитаны по собственной строке. Сталь другой марки не масштабировалась.',
                                '1С1 построена касательной к R35 с фактической шириной250, верхом110 и высотой205+275; 1П3 имеет сужение70→50 по общему виду1П2/1П3, а не параллельные ветви соседней1П4. Глубинные сварные посадки обозначены непроверенными; отсутствующие окончания не добавлены.']
        solid['evidence'] += [
            {'pdfPage':page,'sheet':entry['source']['sheet'],'subject':'Собственная спецификация стали и схема армирования '+alias,
             'checks':['все позиции стали','количества','диаметры','координаты канатов77/122 и75/150/225','шаги хомутов','ведомость по диаметрам','нет закладных пластин']},
            {'pdfPage':48,'sheet':'37','subject':'Именованные общие детали 1С1, 1Хм1, 1П3','checks':['диаметры','длины заготовок','число стержней','гнутые профили']},
            {'pdfPage':50,'sheet':'39','subject':'Собственные 1К'+cage_suffix,'checks':['L/A/B','диаметры и12 поперечных стержней']},
            {'pdfPage':53,'sheet':'42','subject':'Собственная 1СВ'+mesh_suffix,'checks':['L/A1/A2 и цепь шагов','диаметры','число стержней']},
            {'pdfPage':55,'sheet':'44','subject':'Собственная 1СР'+mesh_suffix,'checks':['L/A1/A2 и цепь шагов','диаметры','число стержней']},
        ]
        for g in groups:
            policy.page('doc09',page)
            for pg in g['sourcePages']:policy.page('doc09',pg)
        assert all(solid[k]==old[k] for k in ['id','alias','sourceId','bounds','concreteParts','metalParts'])
        # Original concrete QA is carried unchanged; honest mass coverage warnings
        # distinguish the rendered finished portions from blank procurement mass.
        qa=copy.deepcopy(supplies[old['supplyId']]['qa']['models'][key]);checks=qa['checks']
        checks.extend(component_check(g,spec) for g,spec in zip(groups,specs))
        expected_details={
            'prestressing':{str(kp):(6,blank_k)},
            'end-mesh':{'1':(10,1200),'2':(12,830)},
            'flat-cages':{'1':(2,L-10),'2':(2,cl),'3':(24,260)},
            'span-stirrups':{'6':(st_count,1470)},
            'span-upper':{'1':(4,ml),'2':(2*ncross,520)},
            'span-lower':{'1':(12,ml),'2':(2*ncross,750)},
            'lifting-loops':{'5':(2,950)},
        }
        if extra:expected_details['ordinary-longitudinal']={'7':(2,extra[1])}
        for g in groups:
            actual_details=defaultdict(list)
            for p in g['paths']:actual_details[str(p['detailPosition'])].append(p)
            expected=expected_details[g['id']]
            assert set(actual_details)==set(expected)
            for det,(count,blank) in expected.items():
                pieces=actual_details[det]
                assert len(pieces)==count and all(p['projectLength']==blank for p in pieces)
                rendered=sum(length(p) for p in pieces)
                checks.append({'check':'detail-quantity-and-length','result':'pass' if all(len(p['points'])==2 for p in pieces) and abs(rendered-count*blank)<1e-6 else 'warn',
                               'component':g['name'],'detailPosition':det,'expectedQuantity':count,'actualQuantity':len(pieces),
                               'specLengthMm':blank,'specTotalLengthMm':count*blank,'modelTotalLengthMm':round(rendered,5),
                               'detail':f"{g['name']} деталь{det}: {len(pieces)}/{count} физических стержней; показанная длина {rendered:.2f} мм / заготовки {count*blank} мм. Окончания и радиусные базы не подгонялись к массе."})
        coverage=[]
        for g in sorted(groups,key=lambda g:int(g['position'])):
            coverage.append({'position':g['position'],'component':g['name'],'quantity':g['quantity'],
                             'modeledQuantity':g['quantity'],'status':g['status'],
                             'reason':g['placementDescription'],'pathCount':len(g['paths'])})
        coverage.append({'position':'embedded-parts','component':'Закладные пластины и анкеры','quantity':0,'modeledQuantity':0,'status':'modeled',
                         'reason':'В собственной спецификации этих позиций нет; монтажная 1П3 учтена отдельно.'})
        paths=[p for g in groups for p in g['paths']]
        ids=[p['id'] for p in paths];assert len(ids)==len(set(ids))
        keys=[dump(p['points']) for p in paths];assert len(keys)==len(set(keys))
        assert all(p['diameter']>0 and all(math.isfinite(x) for v in p['points'] for x in v) and length(p)>0 for p in paths)
        all_points=[v for p in paths for v in p['points']]
        assert all(-1e-6<=v[0]<=L+1e-6 and -1e-6<=v[1]<=505+1e-6 and -1e-6<=v[2]<=300+1e-6 for v in all_points)
        # Diagnose exposed/open portions instead of enforcing concrete containment
        # on intentional upper loops/stirrups and mesh releases.
        checks.append({'check':'finite-unique-steel-paths','result':'pass','detail':f'{len(paths)} конечных непустых путей, уникальные id и геометрия; материалы и страницы указаны.'})
        checks.append({'check':'steel-coordinate-envelope','result':'pass','detail':'Каждая осевая точка: 0≤x≤L, 0≤z≤300, 0≤y≤505; верхние выпуски1С1/1Хм1 и петель намеренно выше бетона. Это проверка координат, не коллизий/защитного слоя.'})
        lower=next(g for g in groups if g['id']=='span-lower')
        bottom_wires=[p for p in lower['paths'] if p['diameter']==5 and abs(p['points'][0][1]-32.5)<1e-6]
        bottom_z=sorted({p['points'][0][2] for p in bottom_wires})
        assert len(bottom_wires)==4 and bottom_z==[62.5,237.5]
        upper=next(g for g in groups if g['id']=='span-upper')
        upper_z=sorted({p['points'][0][2] for p in upper['paths'] if p['diameter']==5})
        assert upper_z==[80,220]
        end_bottom=sorted({p['points'][0][2] for p in end if p['diameter']==8 and abs(p['points'][0][1]-34)<1e-6})
        assert end_bottom==[107.5,192.5]
        checks.append({'check':'signed-mesh-wire-spacing-regression','result':'pass',
                       'sourcePages':lower['sourcePages']+upper['sourcePages']+[48],
                       'expected':{'lowerBottomPairMm':175,'upperPairMm':140,'endBottomPairMm':85},
                       'actual':{'lowerBottomPairMm':bottom_z[1]-bottom_z[0],'upperPairMm':upper_z[1]-upper_z[0],'endBottomPairMm':end_bottom[1]-end_bottom[0]},
                       'detail':'Независимая регрессия подписей PDF55/56 (нижняя175), PDF53/54 (верхняя140), PDF48 (1С1 нижняя85). Исправлена ошибочная прежняя нижняя пара75: теперь z62.5/237.5, а не112.5/187.5. Остальные размеры не подгонялись.'})
        checks.append({'check':'concrete-immutable','result':'pass','detail':'Бетон, bounds, id, alias, sourceId и metalParts совпадают с исходной raw моделью.'})
        assembly_divisors={'prestressing':1,'end-mesh':11,'flat-cages':14,'span-stirrups':1,
                           'span-upper':ncross+2,'span-lower':ncross+6,'lifting-loops':1,'ordinary-longitudinal':1}
        actual_quantities={g['position']:len(g['paths'])/assembly_divisors[g['id']] for g in groups}
        expected_quantities={g['position']:g['quantity'] for g in groups}
        assert actual_quantities==expected_quantities
        checks.append({'check':'spec-quantities','result':'pass','detail':'Количество сборочных единиц независимо выведено из фактического числа физических стержней каждой детали; недостающие окончания отмечены partial.','expected':expected_quantities,'actual':actual_quantities})
        checks.append({'check':'placement-and-source-scope','result':'warn','detail':'Проверены габаритные координаты и размерные шаги; сварные глубинные слои, радиусные базы и коллизии остаются в pending. Неполные окончания не объявлены проверенными.'})
        schedule=SCHEDULES[alias];assert abs(sum(schedule[:-1])-schedule[-1])<1e-8
        bins=defaultdict(float)
        def mat(p):
            m=p['material']
            return 'К7' if 'К7' in m else 'Вр-I' if m in ['Вр-I','Вр1'] else 'А240' if m in ['A240','А240'] else 'А500С'
        for p in paths:bins[(mat(p),p['diameter'])]+=mass(p)
        labels=[('К7',12.5),('Вр-I',5),('А240',12),('А500С',8),('А500С',10),('А500С',12),('А500С',14),('А500С',16),('А500С',20)]
        for label,spec in zip(labels,schedule[:-1]):
            if not spec:assert bins[label]==0;continue
            actual=bins[label];dev=(actual/spec-1)*100
            checks.append({'check':'diameter-mass-vs-steel-schedule','result':'warn','material':label[0],'diameter':label[1],
                           'modelKg':round(actual,6),'specKg':spec,'deviationPercent':round(dev,4),
                           'detail':f'{label}: показанные пути {actual:.3f} кг / ведомость заготовок {spec:.3f} кг ({dev:+.2f}%). Срезка канатов, отсутствующие окончания и непроверенные сварные привязки не скрыты.'})
        total=sum(mass(p) for p in paths)
        checks.append({'check':'total-rendered-steel-vs-schedule','result':'warn','modelKg':round(total,6),'specKg':schedule[-1],
                       'groupIds':[g['id'] for g in groups],'metalPartIndices':[],
                       'deviationPercent':round((total/schedule[-1]-1)*100,4),
                       'detail':f'Показано {total:.3f} кг против ведомости {schedule[-1]:.3f} кг; несовпадение включает отсутствующие окончания хомутов и заготовочные припуски К7. Не является проверкой полного расхода стали.'})
        qa['componentCoverage']=coverage
        qa['counts']={'concreteParts':len(solid['concreteParts']),'metalParts':len(solid['metalParts']),'groups':len(groups),'paths':len(paths),
                      'checks':len(checks),'warnings':sum(c['result']=='warn' for c in checks),'failures':sum(c['result']=='fail' for c in checks)}
        qa['massScope']={'model':'длина фактически показанных осевых путей','spec':'заготовочные ведомости; К7 включает припуск до обрезки','strandCoefficient':'unit mass / own-spec blank length, not solid-circle area'}
        assert not qa['counts']['failures']
        models[key]=solid;replaces[key]=sha(replacement_raw[key]);qas[key]=qa
    digest=sha(models)
    supply={'label':'Codex · арматура10 ригелей1Р по собственным листам','snapshot':'20261111-rebar-rigels',
            'modelCount':len(models),'modelsSha256':digest,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'qa':{'modelsSha256':digest,'tool':'scripts/build_calc_rebar_rigels.py','models':qas,
                  'covers':['собственные количества и диаметры','размерные шаги','масса показанных путей по компонентам и диаметрам','К7 по коэффициенту собственной спецификации','неизменность бетона'],
                  'doesNotCover':['неразмеренные загибы канатов','окончания хомутов','производственные сварные посадки','полная проверка коллизий и защитных слоёв']},
            'report':'10 ригелей1Р: канаты, 1С1, собственные плоские каркасы, верхние/нижние сетки, 1Хм1 и 1П3. Дополнительные прямые Ø20 у1Р2.1/1Р3.1. Все позиции представлены, неполные детали и привязки явно partial. Закладных пластин в спецификациях нет.'}
    installed=supplies.get(SUPPLY_ID)
    if installed and installed.get('modelsSha256')==digest:
        supply['capturedAt']=installed['capturedAt']
    elif OUT.exists():
        prior=json.loads(OUT.read_text()).get('supplies',{}).get(SUPPLY_ID)
        if prior and prior.get('modelsSha256')==digest:supply['capturedAt']=prior['capturedAt']
    return {'models':models,'supplies':{SUPPLY_ID:supply},'replaces':replaces}


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--base',type=Path,help='Raw model mapping saved before upgrading; enables replay after import')
    ap.add_argument('--replacement-base',type=Path,help='Raw replacement snapshot; defaults to the saved matching v2-replacement-base.json when present')
    args=ap.parse_args()
    package=build(args.base,args.replacement_base);OUT.parent.mkdir(exist_ok=True,parents=True);OUT.write_text(dump(package))
    for key,m in package['models'].items():
        q=package['supplies'][SUPPLY_ID]['qa']['models'][key]
        last=q['checks'][-1]
        print(m['alias'],len(m['groups']),'groups',q['counts']['paths'],'paths',last['detail'])
    print(OUT)

#!/usr/bin/env python3
"""Six new drawing-based doc09 R beams, concrete and disclosed partial steel.

Visually reviewed: own PDF60–65, P1/C1/Xm1 PDF108, C2–C4 PDF109,
CP3 PDF110, CB3 PDF113 and named cages PDF116. No live assets are written.
All dimensions below come from these own sheets, not aliases or old models.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'scripts'))
from app.calc.source_policy import SourcePolicy
import build_calc_slab_models as geom

ASSETS=geom.ASSETS
SUPPLY='codex-next-rigels-small-20261111'
OUT=ROOT/'tmp/next-rigels/small.json'
ROWS=[
 # own alias/page/L/volume, mesh/cage, cage long diameter, loop station, ordinary bars.
 ('Рк1',60,430,.031,'С2','Кк1',12,140,20,390,2,.96),
 ('Р1',61,570,.040,'С3','К1',12,150,20,530,2,1.31),
 ('Р1.1',62,570,.040,'С3','К1.1',16,150,20,530,2,1.31),
 ('Р2',63,1070,.076,'С4','К2',12,250,22,1030,2,3.07),
 ('Р2.1',64,1070,.076,'С4','К2.1',16,250,22,1030,2,3.07),
 ('Р3',65,1670,.150,'С1','К3',12,400,20,1630,3,4.02),
]
MESHES={
 'С2':{'n':5,'flat':390,'xs':[40,125,215,305,390],'bentPos':'1','wirePos':'2','page':109,'kg':4.96},
 'С3':{'n':6,'flat':530,'xs':[40,135,235,335,435,530],'bentPos':'3','wirePos':'4','page':109,'kg':6.10},
 'С4':{'n':11,'flat':1030,'xs':[40,135,235,335,435,535,635,735,835,935,1030],'bentPos':'3','wirePos':'4','page':109,'kg':11.33},
 'С1':{'n':5,'flat':830,'xs':[40,140,240,340,440],'bentPos':'1','wirePos':'2','page':108,'kg':6.01},
}
CAGES={
 'Кк1':{'L':410,'xs':[15,75,155,255,335,395],'longPos':'1','crossPos':'2','kg':1.69},
 'К1':{'L':550,'xs':[15,75,175,275,375,475,535],'longPos':'3','crossPos':'4','kg':2.10},
 'К1.1':{'L':550,'xs':[15,75,175,275,375,475,535],'longPos':'3','crossPos':'4','kg':2.86},
 'К2':{'L':1050,'xs':[15]+[75+100*i for i in range(10)]+[1035],'longPos':'5','crossPos':'6','kg':3.78},
 'К2.1':{'L':1050,'xs':[15]+[75+100*i for i in range(10)]+[1035],'longPos':'5','crossPos':'6','kg':5.23},
 'К3':{'L':1650,'xs':[55,155,255,355,455,530,1120,1195,1295,1395,1495,1595],'longPos':'7','crossPos':'9','kg':4.86},
}
# Own schedule bins, not inferred from rounded component masses.
SCHEDULE={
 'Рк1':{('A240',8):.64,('A500C',8):.92,('A500C',10):5.96,('A500C',12):1.46,('A500C',20):1.92},
 'Р1':{('A240',8):.64,('A500C',8):1.26,('A500C',10):7.09,('A500C',12):1.96,('A500C',20):2.61},
 'Р1.1':{('A240',8):.64,('A500C',8):1.26,('A500C',10):7.09,('A500C',16):3.48,('A500C',20):2.61},
 'Р2':{('A240',8):.64,('A500C',8):2.44,('A500C',10):12.73,('A500C',12):3.72,('A500C',22):6.15},
 'Р2.1':{('A240',8):.64,('A500C',8):2.44,('A500C',10):12.73,('A500C',16):6.62,('A500C',22):6.15},
 'Р3':{('A240',8):.64,('Vr1',5):.79,('A500C',8):3.94,('A500C',10):23.97,('A500C',12):5.88,('A500C',20):12.06},
}


def dump(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False)
def sha(v):return hashlib.sha256(dump(v).encode()).hexdigest()
def plen(p):return sum(math.dist(a,b) for a,b in zip(p['points'],p['points'][1:]))
def mass(p):return math.pi*p['diameter']**2/4*plen(p)*7850/1e9


def arc(c,r,a,b,n=64):
    return [[c[0]+r*math.cos(a+(b-a)*i/n),c[1]+r*math.sin(a+(b-a)*i/n)] for i in range(n+1)]


def mesh_end_profile():
    # New 400-wide family: actual350 lower width,210 upper,220+260 height,R30.
    # Circle at55/55 touches y25 and z25; tangent from z95/y285.
    theta=math.atan2(230,40)+math.acos(30/math.hypot(230,40))
    left=arc([55,55],30,theta,1.5*math.pi)
    return [[95,505],[95,285]]+left+[[400-z,y] for z,y in reversed(left)]+[[305,285],[305,505]]


def p1_loop(x,z):
    # Own P1 is planar XY (not previous 1П3),H300,topR35,hooksR25,
    # legs70 apart,side hooks50,free tails30; upper release80.
    pts=[[x-85,135,z]]
    pts += [[xx,yy,z] for xx,yy in arc([x-60,105],25,math.pi,2*math.pi)]
    pts += [[xx,yy,z] for xx,yy in arc([x,345],35,math.pi,0)]
    pts += [[xx,yy,z] for xx,yy in arc([x+60,105],25,math.pi,2*math.pi)]
    pts += [[x+85,135,z]]
    return pts


def round_rect(z0,z1,y0,y1,r):
    pts=[]
    for c,a,b in [([z0+r,y0+r],math.pi,1.5*math.pi),([z1-r,y0+r],1.5*math.pi,2*math.pi),
                  ([z1-r,y1-r],0,.5*math.pi),([z0+r,y1-r],.5*math.pi,math.pi)]:pts+=arc(c,r,a,b)
    return pts+[pts[0]]


def u_profile(upper):
    # Own CB3/CP3: width350; CB top275,H150; CP bottom25,H265.
    if upper:return [[25,125]]+arc([55,245],30,math.pi,.5*math.pi)+arc([345,245],30,.5*math.pi,0)+[[375,125]]
    return [[25,290]]+arc([55,55],30,math.pi,1.5*math.pi)+arc([345,55],30,1.5*math.pi,2*math.pi)+[[375,290]]


def path(pid,pts,d,material,pos,detail,blank,pages):
    return {'id':pid,'points':[[round(t,7) for t in p] for p in pts],'diameter':d,'material':material,
            'position':str(pos),'detailPosition':str(detail),'projectLength':blank,'sourcePages':pages}


def group(gid,name,pos,q,paths,pages,reason):
    return {'id':gid,'name':name,'position':str(pos),'quantity':q,'unit':'шт.','paths':paths,
            'sourcePages':pages,'status':'partial' if reason else 'modeled','placementDescription':reason}


def part(pid,profile,x0,x1,page):
    return {'id':pid,'name':pid,'type':'extrusion','profile':profile,'holes':[],'depth':x1-x0,
            'origin':[x0,0,0],'u':[0,0,1],'v':[0,1,0],'direction':[1,0,0],'sourcePages':[page]}


def mass_check(name,paths,spec,pages,gids,partial=False):
    model=sum(map(mass,paths));dev=(model/spec-1)*100
    return {'check':'mass-vs-spec','result':'warn' if partial or abs(dev)>2 else 'pass','component':name,
            'modelKg':round(model,7),'specKg':spec,'deviationPercent':round(dev,5),'groupIds':gids,'metalPartIndices':[],
            'sourcePages':pages,'detail':f'{name}: показанные осевые пути {model:.5f}кг / собственная спецификация {spec:.5f}кг ({dev:+.3f}%). '+
            ('Геометрия/посадка частичны, недостающее и неразмеренное указано в pending; размеры не подгонялись.' if partial else 'Номинальная геометрия; табличные массы округлены, размеры не подгонялись.')}


def build():
    live=json.loads((ASSETS/'promka-solid-models.json').read_text())
    register=json.loads((ASSETS/'promka-register.json').read_text())
    by_alias={v['alias']:v for v in register.values() if v['source']['id']=='doc09'}
    policy=SourcePolicy(ASSETS);models,qas={},{}
    trough=[[0,0],[400,0],[400,300],[300,300],[300,55],[100,55],[100,300],[0,300]]
    rectangle=[[0,0],[400,0],[400,300],[0,300]]
    for alias,page,L,volume,mesh,cage,cd,loopx,od,ol,oq,om in ROWS:
        entry=by_alias[alias];key=entry['id'];assert not entry.get('groups')
        assert key not in live or live[key].get('supplyId')==SUPPLY, 'Existing solid must not be replaced'
        assert entry['source']['productPage']==page and not entry.get('excluded')
        assert entry.get('projectVolume')==volume
        parts=([part('бетон-U',trough,0,L,page)] if alias!='Р3' else
               [part('левое-корыто',trough,0,500,page),part('средняя-часть',rectangle,500,L-500,page),part('правое-корыто',trough,L-500,L,page)])
        groups=[];group_specs=[];ms=MESHES[mesh];num_mesh=2 if alias=='Р3' else 1
        # Source mesh transverse bars follow each own signed chain.
        ep=[];profile=mesh_end_profile()
        theta=math.atan2(230,40)+math.acos(30/math.hypot(230,40));tangent=[55+30*math.cos(theta),55+30*math.sin(theta)]
        distance=math.dist([95,285],tangent);wires=[]
        for side in [0,1]:
            for along in [40,140]:
                z=95+(tangent[0]-95)*along/distance+9
                y=285+(tangent[1]-285)*along/distance
                wires.append([y,z if side==0 else 400-z])
        wires += [[34,125],[34,275]]
        for side in range(num_mesh):
            for i,x in enumerate(ms['xs']):
                at=x if side==0 else L-x
                ep.append(path(f'mesh-{side}-bent-{i}',[[at,y,z] for z,y in profile],10,'A500C',1,ms['bentPos'],1310,[page,ms['page']]))
            for i,(y,z) in enumerate(wires):
                a,b=(20,20+ms['flat']) if side==0 else (L-20-ms['flat'],L-20)
                ep.append(path(f'mesh-{side}-wire-{i}',[[a,y,z],[b,y,z]],8,'A500C',1,ms['wirePos'],ms['flat'],[page,ms['page']]))
        groups.append(group('end-mesh',mesh,1,num_mesh,ep,[page,ms['page']],
                            'Собственная сетка: гнутые Ø10 L1310, шесть Ø8; профиль350/210,220+260,R30,нижняя пара150. Сварной порядок/радиусная база не утверждены; сварные смещения показаны номинально.'))
        group_specs.append(num_mesh*ms['kg'])
        # P1 positions are explicitly55 from front/back faces and loopx from ends.
        lp=[path(f'loop-{i}',p1_loop(x,z),8,'A240',2,4,810,[page,108]) for i,(x,z) in enumerate([(loopx,55),(L-loopx,345)])]
        groups.append(group('lifting-loops','П1',2,2,lp,[page,108],
                            'Собственная П1 PDF108: H300,R35,нижние R25,70 между ветвями,50/50 крюки,хвосты30; выпуск80. Радиус принят по оси, производственную базуR и швы подтвердить.'))
        group_specs.append(.64)
        # Each cage is constructed from its own detail row, not scaled.
        cs=CAGES[cage];cp=[];cpos=6 if alias=='Р3' else 3
        for side,z in [(0,25),(1,375)]:
            if alias=='Р3':
                long_z=40 if side==0 else 360  # Own PDF65 section3–3 signed40.
                # PDF116 dimension50 is measured from rung top280, not from255.
                # Therefore middle230=end255−25; own section3–3 confirms300−70.
                top=[[10,255,long_z],[390,255,long_z],[515,230,long_z],
                     [L-515,230,long_z],[L-390,255,long_z],[L-10,255,long_z]]
                cp.append(path(f'cage-{side}-top',top,12,'A500C',cpos,7,1660,[page,116]))
                cp.append(path(f'cage-{side}-lower',[[10,180,long_z],[L-10,180,long_z]],12,'A500C',cpos,8,1650,[page,116]))
            else:
                for j,y in enumerate([255,180]):
                    cp.append(path(f'cage-{side}-long-{j}',[[10,y,z],[L-10,y,z]],cd,'A500C',cpos,cs['longPos'],cs['L'],[page,116]))
            for j,xx in enumerate(cs['xs']):cp.append(path(f'cage-{side}-cross-{j}',[[10+xx,20,z],[10+xx,280,z]],10,'A500C',cpos,cs['crossPos'],260,[page,116]))
        groups.append(group('flat-cages',cage,cpos,2,cp,[page,116],
                            'Собственные длины и цепи PDF116; поперечины y20…280,верхний продольный на концах255=280−25,нижний180=255−75. Физические пересечения в сварных узлах и защитные слои не утверждены.'+
                            (' У К3 продольные z40/360 по явно подписанной40 собственного3–3;поперечиныz25/375поотдельной25. Верхний в середине230=280−50 совпадает с own3–3:300−70;не205. Прямые380/125*,неразмеренные радиусы не добавлены. Ownspec ссылается на КЖ.И2-1.1, но в настоящем альбоме есть одноимённый К3 с совпадающей массой4.86.' if alias=='Р3' else
                             ' В собственном2–2 подписана плоскость поперечинz25/375,но отдельный глубинный размер круглых продольных не дан. Они оставлены в той же номинальной плоской проекции,без выдуманных5+rсдвигов;физическая глубинная посадка продольных остаётсяpending. Размер40изР3 сюда не переносился.')))
        group_specs.append(2*cs['kg'])
        op=[];opos=7 if alias=='Р3' else 4
        locations=[(50,50),(50,350)]+([(75,200)] if oq==3 else [])
        assert ol==L-40 and len(locations)==oq
        for i,(y,z) in enumerate(locations):op.append(path(f'ordinary-{i}',[[20,y,z],[L-20,y,z]],od,'A500C',opos,opos,ol,[page]))
        groups.append(group('ordinary-longitudinal',f'Ø{od} A500C',opos,oq,op,[page],''));group_specs.append(oq*om)
        if alias=='Р3':
            xs=[555,660,780,895,1030,1130]
            st=[path(f'xm1-{i}',[[x,y,z] for z,y in round_rect(95,305,55,500,30)],10,'A500C',3,3,1770,[page,108]) for i,x in enumerate(xs)]
            for p in st:p.update(openStart=True,openEnd=True)
            groups.append(group('span-stirrups','Хм1',3,6,st,[page,108],
                                'Собственные шесть позиций по цепи40+400+115/105/120/115/135/100/100+400+40. Основной контур210×445 R30; свободные окончания/нахлёст160 не определены пространственно и не выдуманы.'))
            group_specs.append(6*1.09)
            for upper,gid,name,pos,blank,spec in [(False,'span-lower','СР3',4,860,3.77),(True,'span-upper','СВ3',5,630,2.53)]:
                ref=113 if upper else 110
                xlocal=[55,155,275,365,485,585] if upper else [40,140,260,380,500,600]
                pp=[path(f'{gid}-cross-{i}',[[515+x,y,z] for z,y in u_profile(upper)],10,'A500C',pos,1,blank,[page,ref]) for i,x in enumerate(xlocal)]
                yz=([[267.5,80],[267.5,320]] if upper else [[250,32.5],[150,32.5],[250,367.5],[150,367.5],[32.5,70],[32.5,330]])
                pp += [path(f'{gid}-wire-{i}',[[515,y,z],[1155,y,z]],5,'Vr1',pos,2,640,[page,ref]) for i,(y,z) in enumerate(yz)]
                groups.append(group(gid,name,pos,1,pp,[page,ref],
                                    'Собственная сетка L640 по собственным шагам, размещена в среднем670 с номинальными крайними15; сварные смещения/порядок слоёв требуют проверки. '+
                                    ('СВ3: верхнийU350×150,осьверхаy275,парапроволок240.' if upper else 'СР3: нижнийU350×265,парапроволок260,боковаяпара100; не175/75 из другого семейства.')))
                group_specs.append(spec)
        # Independent geometry checks, not self-declared completion.
        bounds=geom._bounds_of(parts);assert bounds==[[0,0,0],[L,300,400]]
        analytic=(L*400*300-(L if alias!='Р3' else 1000)*200*245)/1e9
        actual=sum(geom.part_volume(p) for p in parts)/1e9;assert abs(actual-analytic)<1e-12
        checks=[geom._volume_check(parts,volume,f'doc09 PDF{page}, own concrete spec',tolerance=.02),*geom._structure_checks(parts),
                {'check':'signed-dimensions','result':'pass','expected':[L,300,400],'actual':[bounds[1][i]-bounds[0][i] for i in range(3)],
                 'sourcePages':[page],'detail':'Собственные габариты L×300×400;200 внутри корыта,100+200+100;дно55. У Р3 два корыта по500,у остальных корыто сквозное по длине.'},
                {'check':'independent-volume-formula','result':'pass','modelM3':round(actual,8),'analyticM3':round(analytic,8),
                 'detail':'L×400×300−длинакорыт×200×245; тождество проверено по фактическим экструзиям.','sourcePages':[page]},
                {'check':'named-parts-and-own-quantity','result':'pass','sourcePages':[page],
                 'detail':'Обозначения и количества сборочных единиц прочитаны в собственной спецификации; К7 и закладных пластин в этих шести спецификациях нет.'}]
        for g,spec in zip(groups,group_specs):checks.append(mass_check(g['name'],g['paths'],spec,g['sourcePages'],[g['id']],partial=g['status']=='partial'))
        bins=defaultdict(float)
        for g in groups:
            for p in g['paths']:bins[(p['material'],p['diameter'])]+=mass(p)
        assert set(bins)==set(SCHEDULE[alias])
        for (material,d),spec in SCHEDULE[alias].items():
            allg=[g['id'] for g in groups if any(p['material']==material and p['diameter']==d for p in g['paths'])]
            calc=bins[(material,d)]
            checks.append({'check':'diameter-mass-vs-own-schedule','result':'warn','material':material,'diameter':d,
                           'materialFilter':material,'diameterFilter':d,'groupIds':allg,'metalPartIndices':[],
                           'modelKg':round(calc,7),'specKg':spec,'deviationPercent':round((calc/spec-1)*100,5),'sourcePages':[page],
                           'detail':'Масса фактических путей данного материала/диаметра; полный производственный баланс не заявлен, см.pending.'})
        allpaths=[p for g in groups for p in g['paths']]
        assert len({p['id'] for p in allpaths})==len(allpaths)
        canonical=lambda p:min(dump(p['points']),dump(p['points'][::-1]))
        assert len({canonical(p) for p in allpaths})==len(allpaths)
        assert all(p['diameter']>0 and plen(p)>0 and all(math.isfinite(v) for q in p['points'] for v in q) for p in allpaths)
        assert all(-1e-6<=q[0]<=L+1e-6 and 0<=q[1]<=505+1e-6 and 0<=q[2]<=400+1e-6 for p in allpaths for q in p['points'])
        checks.append({'check':'paths-finite-unique-and-envelope','result':'pass','detail':f'{len(allpaths)} непустых конечных уникальных физических путей (включая проверку reversed duplicates),внутри0…L/0…505/0…400; верхние выпуски намеренны.'})
        expected_details={
            'end-mesh':{ms['bentPos']:(num_mesh*ms['n'],1310),ms['wirePos']:(num_mesh*6,ms['flat'])},
            'lifting-loops':{'4':(2,810)},
            'flat-cages':({cs['longPos']:(4,cs['L']),cs['crossPos']:(2*len(cs['xs']),260)} if alias!='Р3'
                          else {'7':(2,1660),'8':(2,1650),'9':(24,260)}),
            'ordinary-longitudinal':{str(opos):(oq,ol)},
        }
        if alias=='Р3':expected_details.update({'span-stirrups':{'3':(6,1770)},'span-lower':{'1':(6,860),'2':(6,640)},'span-upper':{'1':(6,630),'2':(2,640)}})
        actual_assemblies={}
        for g in groups:
            detail_paths=defaultdict(list)
            for p in g['paths']:detail_paths[p['detailPosition']].append(p)
            assert set(detail_paths)==set(expected_details[g['id']])
            for d,(n,stock) in expected_details[g['id']].items():
                pieces=detail_paths[d]
                assert len(pieces)==n and all(p['projectLength']==stock for p in pieces)
                rendered=sum(map(plen,pieces))
                checks.append({'check':'detail-count-and-rendered-length','result':'pass' if abs(rendered-n*stock)<1e-6 else 'warn',
                               'component':g['name'],'detailPosition':d,'expectedQuantity':n,'actualQuantity':len(pieces),
                               'blankLengthMm':stock,'blankTotalLengthMm':n*stock,'renderedTotalLengthMm':round(rendered,7),
                               'sourcePages':g['sourcePages'],'detail':'Фактическое число физических прутков сверено со своей строкой; длина осевой геометрии отдельно от заготовочной. Радиусы и отсутствующие окончания не подгонялись.'})
            divisor={'end-mesh':ms['n']+6,'lifting-loops':1,'flat-cages':len(cs['xs'])+2,
                     'ordinary-longitudinal':1,'span-stirrups':1,'span-lower':12,'span-upper':8}[g['id']]
            actual_assemblies[g['position']]=len(g['paths'])/divisor
        expected_assemblies={g['position']:g['quantity'] for g in groups}
        assert actual_assemblies==expected_assemblies
        checks.append({'check':'physical-assembly-counts-vs-own-spec','result':'pass','expected':expected_assemblies,'actual':actual_assemblies,
                       'sourcePages':[page],'detail':'Число сборочных единиц независимо получено из фактического числа прутков каждой собственной детали.'})
        loop_stations=[]
        for p in lp:
            pts=p['points'];assert max(v[1] for v in pts)==380 and min(v[1] for v in pts)==80
            assert len({v[2] for v in pts})==1
            loop_stations.append([(min(v[0] for v in pts)+max(v[0] for v in pts))/2,pts[0][2]])
        assert loop_stations==[[loopx,55],[L-loopx,345]]
        checks.append({'check':'signed-p1-shape-and-stations','result':'pass','sourcePages':[page,108],
                       'expected':{'H':300,'release':80,'stations':[[loopx,55],[L-loopx,345]]},
                       'actual':{'H':max(v[1] for v in lp[0]['points'])-min(v[1] for v in lp[0]['points']),
                                 'release':max(v[1] for v in lp[0]['points'])-300,'stations':loop_stations},
                       'detail':'П1: фактические H300 и выпуск80; станции по собственному1–1,55 от боковых граней. Это своя П1,не1П3 прежней серии.'})
        nominal_positions=[[[20,y,z],[L-20,y,z]] for y,z in locations]
        assert [p['points'] for p in op]==nominal_positions
        checks.append({'check':'signed-straight-bar-positions','result':'pass','expected':nominal_positions,'actual':[p['points'] for p in op],
                       'sourcePages':[page],'detail':'Собственные прямые прутки: отступ20 с обоих торцов; два крайних y50/z50,350; у Р3 третий y75/z200.'})
        cage_rung_z=sorted({v[2] for p in cp if '-cross-' in p['id'] for v in p['points']})
        cage_long_z=sorted({v[2] for p in cp if '-cross-' not in p['id'] for v in p['points']})
        cage_top=next(p for p in cp if p['id']=='cage-0-top') if alias=='Р3' else next(p for p in cp if p['id']=='cage-0-long-0')
        assert cage_rung_z==[25,375] and cage_top['points'][0][1]==255
        assert cage_long_z==([40,360] if alias=='Р3' else [25,375])
        middle_y=cage_top['points'][2][1] if alias=='Р3' else cage_top['points'][0][1]
        assert middle_y==(230 if alias=='Р3' else 255)
        checks.append({'check':'signed-cage-height-bases','result':'pass','sourcePages':[page,116],
                       'expected':{'rungTopY':280,'upperEndY':255,'upperMiddleY':230 if alias=='Р3' else 255,'lowerLongY':180},
                       'actual':{'rungTopY':max(v[1] for p in cp if '-cross-' in p['id'] for v in p['points']),
                                 'upperEndY':cage_top['points'][0][1],'upperMiddleY':middle_y,
                                 'lowerLongY':next(p for p in cp if p['id'] in ['cage-0-lower','cage-0-long-1'])['points'][0][1]},
                       'detail':'PDF116:25 и50 отсчитываются от верхнего конца поперечин280;дляК3 среднийверх230 подтверждён собственным300−70. Этотcheck проверяет высоты,не неразмеренные сварные смещения.'})
        if alias=='Р3':
            checks.append({'check':'signed-k3-longitudinal-depth-regression','result':'pass','sourcePages':[65,116],
                           'expected':{'longitudinalZ':[40,360],'rungZ':[25,375],'longitudinalPieces':4},
                           'actual':{'longitudinalZ':cage_long_z,'rungZ':cage_rung_z,'longitudinalPieces':sum('-cross-' not in p['id'] for p in cp)},
                           'detail':'Собственное3–3 PDF65:40отбетоннойбоковойграничётко относитсяккруглымпродольнымпоз6;отдельная25относитсякпоперечинам. Нельзяназначатьобоимвидам25.'})
        # Spacings measured from actual wires; different families have different signed pairs.
        endbottom=sorted({p['points'][0][2] for p in ep if p['diameter']==8 and abs(p['points'][0][1]-34)<1e-6})
        assert endbottom==[125,275]
        checks.append({'check':'signed-wire-spacing-regression','result':'pass','sourcePages':[ms['page']],
                       'expected':{'endBottomPairMm':150},'actual':{'endBottomPairMm':endbottom[1]-endbottom[0]},'detail':'С2/С3/С4/С1: собственная нижняя пара150,не175/75 предыдущего семейства.'})
        if alias=='Р3':
            lower=next(g for g in groups if g['id']=='span-lower');upper=next(g for g in groups if g['id']=='span-upper')
            loww=[p for p in lower['paths'] if p['diameter']==5];upw=[p for p in upper['paths'] if p['diameter']==5]
            lz=sorted({p['points'][0][2] for p in loww if p['points'][0][1]==32.5});uz=sorted({p['points'][0][2] for p in upw});sy=sorted({p['points'][0][1] for p in loww if p['points'][0][1]!=32.5})
            assert lz[1]-lz[0]==260 and uz[1]-uz[0]==240 and sy[1]-sy[0]==100
            checks.append({'check':'own-cp3-cb3-wire-spacing-regression','result':'pass','sourcePages':[110,113],
                           'expected':[260,240,100],'actual':[lz[1]-lz[0],uz[1]-uz[0],sy[1]-sy[0]],'detail':'Из фактических путей:СР3нижняя260,СВ3верхняя240,СР3боковая100.'})
        total=sum(map(mass,allpaths));spec=sum(SCHEDULE[alias].values())
        checks.append(mass_check('Вся показанная сталь / собственная ведомость',allpaths,spec,[page],[g['id'] for g in groups],partial=True))
        pending=[g['name']+': '+g['placementDescription'] for g in groups if g['status']=='partial']
        pending += ['Сварные швы, фактический порядок сварных слоёв и полная проверка защитных слоёв/коллизий не завершены. Модель не является производственной.']
        solid={'id':key,'sourceId':'doc09','alias':alias,'supplyId':SUPPLY,'format':'project-solids-mm-v1','status':'partial',
               'modelType':'drawing-based-concrete-and-partial-rebar','elementType':'Ригель с корытом','concreteParts':parts,'metalParts':[],
               'groups':groups,'bounds':bounds,'coordinateSystem':'мм; x — длина,y — вверх,z — ширина400','coordinateOrigin':'левый бетонный торец0;низ0;левая боковая грань0',
               'evidence':[{'pdfPage':page,'sheet':entry['source']['sheet'],'subject':alias+': собственные фасады/разрезы/схема и ведомости',
                            'checks':['L/H/B и корыто200/дно55','собственные позиции/количества стали','геометрия по подписанным цепям','материалы по спецификации,К7/закладных нет'],
                            'volumeFormulaMm3':f'{L}*400*300-{L if alias!="Р3" else 1000}*200*245','volumeM3':actual},
                           {'pdfPage':ms['page'],'sheet':str(ms['page']-11),'subject':mesh+': собственные состав/размеры','checks':['Ø10 L1310','Ø8 по своей длине','профиль210/350,220+260,R30,нижняяпара150']},
                           {'pdfPage':108,'sheet':'97','subject':'П1: собственный полный гнутый профиль','checks':['Ø8 A240,L810','H300,70междуветвями,R35/R25,50/50/30']},
                           {'pdfPage':116,'sheet':'105','subject':cage+': собственная строка каркаса','checks':['состав/диаметры','длины','собственная цепь поперечин','номинальные сварные слои']}],
               'pending':pending,'assumptions':['Номинальные осевые радиусы использованы по размерным видам; длины и диаметры не подгонялись к табличным массам.',
                                              'Бетон и сталь построены по собственным листам. Сварные слои отражают номинальную проекцию; производство/коллизии не объявлены проверенными.'],
               'issues':[],'notes':['Индивидуальные U-контур и частичная арматура по собственным чертежам; проектные количества,ресурсы,массы,ставки и калькуляция не изменены.',
                                  'Закладных пластин/анкеров и преднапряжённых канатов в собственной спецификации нет. Монтажные П1 показаны отдельно как арматурные петли.'],
               'readinessDescription':'Бетонное тело с корытом и все позиции стали представлены по своим листам; геометрия и сварные посадки частичны,см.pending.','supersedesSketch':True}
        if alias=='Р3':solid['evidence'] += [{'pdfPage':110,'sheet':'99','subject':'СР3: собственные L640/шаги/профиль','checks':['6Ø10 L860+6Ø5 L640','нижняяпара260,боковая100']},
                                                          {'pdfPage':113,'sheet':'102','subject':'СВ3: собственные L640/шаги/профиль','checks':['6Ø10 L630+2Ø5 L640','верхняяпара240,верхy275']}]
        coverage=[{'position':g['position'],'component':g['name'],'quantity':g['quantity'],'modeledQuantity':g['quantity'],
                   'status':g['status'],'reason':g['placementDescription'] or 'Прямые стержни по собственной длине/координатам.','pathCount':len(g['paths'])} for g in sorted(groups,key=lambda g:int(g['position']))]
        coverage.append({'position':'embedded','component':'Закладные пластины/анкеры','quantity':0,'modeledQuantity':0,'status':'not-applicable','reason':'В собственной спецификации этих позиций нет.'})
        qa={'alias':alias,'status':'partial','checks':checks,'componentCoverage':coverage,
            'counts':{'concreteParts':len(parts),'metalParts':0,'groups':len(groups),'paths':len(allpaths),'checks':len(checks),
                      'warnings':sum(c['result']=='warn' for c in checks),'failures':sum(c['result']=='fail' for c in checks)}}
        assert qa['counts']['failures']==0
        policy.model({**entry,'solidModel':solid});policy.reading(qa,'doc09')
        if key in live:
            assert live[key]==solid, f'Installed model diverged: {alias}'
        models[key]=solid;qas[key]=qa
    digest=sha(models);prior={}
    if OUT.exists():prior=json.loads(OUT.read_text()).get('supplies',{}).get(SUPPLY,{})
    supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text());installed=supplies.get(SUPPLY,{})
    if installed.get('modelsSha256')==digest:prior=installed
    captured=prior['capturedAt'] if prior.get('modelsSha256')==digest else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={'label':'Codex · малые ригелиР1–Р3 иРк1','snapshot':'20261111-next-rigels-small','modelsSha256':digest,'modelCount':len(models),'capturedAt':captured,
              'qa':{'modelsSha256':digest,'tool':'scripts/build_calc_next_rigels_small.py','models':qas,
                    'covers':['собственные размеры и U-бетон','спецификации/номинальная геометрия стали','все металлические пути в независимых массовых скоупах','подписанные пары проволок и собственные шаги'],
                    'doesNotCover':['производственные радиусные базы/сварные слои','отсутствующие хвосты Хм1 уР3','полная проверка коллизий/защитных слоёв']},
              'report':'Рк1,Р1,Р1.1,Р2,Р2.1,Р3: индивидуальный бетон с корытом/торцевыми корытами; собственные сетки,каркасы,П1 и прямые стержни. Все partial. К7 и закладных по этим собственным спецификациям нет.'}
    return {'models':models,'supplies':{SUPPLY:delivery}}


if __name__=='__main__':
    package=build();OUT.parent.mkdir(parents=True,exist_ok=True);OUT.write_text(dump(package))
    delivery=package['supplies'][SUPPLY]
    for key,m in package['models'].items():print(m['alias'],delivery['qa']['models'][key]['counts'])
    print(OUT)

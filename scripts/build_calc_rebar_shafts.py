#!/usr/bin/env python3
"""Add source-based partial reinforcement to nine live shaft panels, in an isolated package.

Concrete/bounds/identity are copied unchanged. Sources were visually reviewed:
doc13 own product+block sheets, cage details105/106, embedded details109,
and nodes110. No catalog, quantities, rates, or shared assets are edited.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab
from shapely.geometry import box

ROOT=slab.ROOT
ASSETS=slab.CATALOG_DIR
SUPPLY='codex-rebar-shafts-20261111'
SOURCE_SHA='31ad9d83f2d1a1933007804ffe05925b177a074ca93b25a6c0a72795eea08992'
# Own page, block page, block height, cage designation, A, N200,
# additional end interval B, transverse bars/cage, unit mass, horizontal8
# count, first horizontal8 y from block bottom, full block mass, MN4 positions.
CONFIGS=[
 {'alias':'ШЛ16.1','page':62,'block':63,'L':2470,'cage':'К-3','detail':116,'A':35,'N':12,'B':0,'rungs':13,'kg':3.95,'n8':22,'y8':225,'blockKg':75.60,'mn4':[(0,1175),(1530,1175)],'loop':'П2','pg':'ПГ2','steel':{6:.48,8:23.4,10:31.76,12:11.68}},
 {'alias':'ШЛ27','page':88,'block':89,'L':2810,'cage':'КР-1','detail':117,'A':35,'N':13,'B':140,'rungs':15,'kg':4.51,'n8':24,'y8':305,'blockKg':86.90,'mn4':[(345,0),(1185,0)],'loop':'П3','pg':'ПГ3','steel':{6:.36,8:26.1,10:35.96,12:11.68}},
 {'alias':'ШЛ28','page':92,'block':93,'L':1970,'cage':'КР-2','detail':117,'A':35,'N':9,'B':100,'rungs':11,'kg':3.19,'n8':16,'y8':285,'blockKg':63.98,'mn4':[],'loop':'П2','pg':'ПГ2','steel':{6:.36,8:18.1,10:25.56,12:11.68}},
 {'alias':'ШЛ29','page':94,'block':95,'L':2880,'cage':'КР-3','detail':117,'A':40,'N':14,'B':0,'rungs':15,'kg':4.61,'n8':26,'y8':240,'blockKg':89.20,'mn4':[],'loop':'П3','pg':'ПГ3','steel':{6:.36,8:27.4,10:36.76,12:11.68}},
 {'alias':'ШЛ3О','page':98,'block':99,'L':2420,'cage':'КР-4','detail':117,'A':35,'N':11,'B':150,'rungs':13,'kg':3.89,'n8':20,'y8':310,'blockKg':73.58,'mn4':[],'loop':'П2','pg':'ПГ2','steel':{6:.36,8:22.1,10:31.16,12:11.68}},
 {'alias':'ШЛ31','page':100,'block':101,'L':2870,'cage':'КР-5','detail':117,'A':35,'N':14,'B':0,'rungs':15,'kg':4.59,'n8':26,'y8':None,'blockKg':89.00,'mn4':[],'loop':'П3','pg':'ПГ3','steel':{6:.36,8:27.4,10:36.56,12:11.68}},
 {'alias':'ШЛ7','page':28,'block':29,'L':2470,'cage':'К-3','detail':116,'A':35,'N':12,'B':0,'rungs':13,'kg':3.95,'n8':22,'y8':225,'blockKg':111.04,'mn4':[],'mn3xs':[285,2045],'loop':'П4','pg':'ПГ3','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{14:7.88,18:7.24},'steel':{6:.48,8:34.08,10:43.92,12:17.44}},
 {'alias':'ШЛ19','page':70,'block':71,'L':1970,'cage':'КР-2','detail':117,'A':35,'N':9,'B':100,'rungs':11,'kg':3.19,'n8':16,'y8':285,'blockKg':92.14,'mn4':[],'mn3xs':[390,1940],'loop':'П3','pg':'ПГ3','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{14:7.88,16:4.92},'steel':{6:.36,8:26.30,10:35.24,12:17.44}},
 {'alias':'ШЛ23','page':80,'block':81,'L':2420,'cage':'КР-4','detail':117,'A':35,'N':11,'B':150,'rungs':13,'kg':3.89,'n8':20,'y8':310,'blockKg':108.14,'mn4':[],'mn3xs':[390,1940],'loop':'П4','pg':'ПГ3','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{14:7.88,18:7.24},'steel':{6:.36,8:32.14,10:43.08,12:17.44}},
]

def dumps(o): return json.dumps(o,ensure_ascii=False,separators=(',',':'))
def sha(o): return hashlib.sha256(dumps(o).encode()).hexdigest()
def length(p): return sum(math.dist(a,b) for a,b in zip(p['points'],p['points'][1:]))
def kg_path(p): return math.pi*p['diameter']**2/4*length(p)*7850/1e9

def path(pid,d,a,b,position,pages,material='A500C',**kwargs):
    return {'id':pid,'diameter':d,'points':[a,b],'position':position,'material':material,
            'sourcePages':pages,'projectLength':round(math.dist(a,b),3),**kwargs}

def group(gid,name,designation,quantity,pages,paths,kind='cage',**kwargs):
    return {'id':gid,'name':name,'shortLabel':designation,'designation':designation,
            'sheet':str(pages[-1]-11),'quantity':quantity,'unit':'шт','kind':kind,
            'material':'A500C','sourcePages':pages,'paths':paths,**kwargs}

def plate(name,x,y,z,w,h,depth,pages,axis='z'):
    if axis=='y':
        p=slab.extrusion_part(name,box(x,z,x+w,z+h),[0,y,0],[1,0,0],[0,0,1],[0,1,0],depth,pages)
    else:
        p=slab.extrusion_part(name,box(x,y,x+w,y+h),[0,0,z],[1,0,0],[0,1,0],[0,0,1],depth,pages)
    p['material']='C245';p['densityKgM3']=7850
    return p

def mass_check(check,what,model,spec,pages,tolerance=.02,partial=False):
    delta=(model-spec)/spec*100
    return {'check':check,'result':'warn' if partial or abs(delta)>tolerance*100 else 'pass',
            'detail':f'{what}: модель {model:.4f} кг; ведомость {spec:.4f} кг, отклонение {delta:+.2f}%; '+('покрытие частичное, не подгонялось.' if partial else ('разница от округления табличных масс; размеры не подгонялись.' if abs(delta)<=tolerance*100 else 'размеры не подгонялись; превышение допуска требует уточнения исходной ведомости.')),
            'modelKg':round(model,5),'specKg':spec,'deviationPercent':round(delta,3),'tolerancePercent':tolerance*100,'partialCoverage':partial,'sourcePages':pages}

def coverage(pos,name,qty,modeled,status='modeled',reason='',parent='product'):
    out={'position':pos,'designation':name,'parent':parent,'quantity':qty,'modeledQuantity':modeled,'status':status}
    if reason:out['reason']=reason
    return out

def build_model(old,c,oldqa):
    m=copy.deepcopy(old);W,H,T=m['bounds'][1];L=c['L']; assert W in [1680,2480] and T==200 and H==L+30
    BW=W-30; intervals=int((BW-250)/200); nc=intervals+3; k1modeled=c.get('k1modeled',True)
    pg,blk,detail=c['page'],c['block'],c['detail'];sources=[pg,blk,detail]
    # Block1650×L×170 starts15 from each concrete face. Front chain:
    # 25 |100| 200×7 |100|25 => ten cage planes. Each ladder is170 wide;
    # C25 leaves the two longitudinal axes120 apart. No unshown weld offset.
    xs=[40]+[140+200*k for k in range(intervals+1)]+[W-40]
    rungs=[c['A']+200*k for k in range(c['N']+1)]
    if c['B']:rungs.append(rungs[-1]+c['B'])
    assert len(xs)==nc and len(rungs)==c['rungs'] and rungs[-1]==L-c['A']
    cage_paths=[]
    for i,x in enumerate(xs,1):
        for side,z in enumerate([40,160],1):
            cage_paths.append(path(f'cage:{i}:long:{side}',10,[x,15,z],[x,15+L,z],f'АБ поз.1 {c["cage"]}, дет.1',sources,instance=str(i)))
        for j,y in enumerate(rungs,1):
            cage_paths.append(path(f'cage:{i}:rung:{j}',8,[x,15+y,15],[x,15+y,185],f'АБ поз.1 {c["cage"]}, дет.2',sources,instance=str(i)))
    groups=[group('ab-cages',f'АБ: {nc} лестничных каркасов {c["cage"]}',c['cage'],nc,sources,cage_paths,position='1')]
    # K1 short ladders: own facade shows their ends at the two inner cage
    # stations and level60 below block top. Detail105 supplies L550/H170/C40.
    k1paths=[]
    for i,x0 in enumerate(([140,BW-660] if k1modeled else []),1):
        for side,z in enumerate([55,145],1):
            k1paths.append(path(f'k1:{i}:long:{side}',10,[x0,15+L-60,z],[x0+550,15+L-60,z],'АБ поз.2 К-1, дет.1',[pg,blk,116],instance=str(i)))
        for j,dx in enumerate([25+100*k for k in range(6)],1):
            k1paths.append(path(f'k1:{i}:rung:{j}',6,[x0+dx,15+L-60,15],[x0+dx,15+L-60,185],'АБ поз.2 К-1, дет.2',[pg,blk,116],instance=str(i)))
    if k1modeled: groups.append(group('ab-k1','АБ поз.2: два коротких горизонтальных каркаса К-1','К-1',2,[pg,blk,116],k1paths,position='2'))
    # Block position4: paired Ø12 at25,125 from top and bottom.
    ps12=[path(f'ab:4:{j}:{side}',12,[15,15+y,z],[W-15,15+y,z],f'АБ поз.4 Ø12 L{BW:g}',[pg,blk])
          for j,y in enumerate([25,125,L-125,L-25],1) for side,z in enumerate([40,160],1)]
    groups.append(group('ab-pos4',f'АБ поз.4: восемь прямых Ø12 L{BW:g}',f'Ø12 L{BW:g}',8,[pg,blk],ps12,kind='bar',position='4'))
    ps8=[]
    if c['y8'] is not None:
        ys=[c['y8']+200*k for k in range(c['n8']//2)]
        assert L-ys[-1] == (245 if c['alias'] in ['ШЛ16.1','ШЛ7'] else c['y8'])
        ps8=[path(f'ab:3:{j}:{side}',8,[15,15+y,z],[W-15,15+y,z],f'АБ поз.3 Ø8 L{BW:g}',[pg,blk])
             for j,y in enumerate(ys,1) for side,z in enumerate([40,160],1)]
        groups.append(group('ab-pos3',f'АБ поз.3: прямые Ø8 L{BW:g}',f'Ø8 L{BW:g}',len(ps8),[pg,blk],ps8,kind='bar',position='3'))
    metals=[];anchors1=[]
    # MN1: top plates are exactly in the already-modelled top seats.
    # Own front facade + nodeБ: x0..250 and1430..1680, yH−10..H.
    # Detail109: four anchors Ø12 L340, two rows50 apart from plate edges.
    for i,x0 in enumerate([0,W-250],1):
        metals.append(plate(f'МН1 #{i}: дет.1 −10×200 L250',x0,H-10,0,250,200,10,[pg,120,121],axis='y'))
        for j,(xx,zz) in enumerate([(50,50),(200,50),(50,150),(200,150)],1):
            anchors1.append(path(f'mn1:{i}:anchor:{j}',12,[x0+xx,H-10,zz],[x0+xx,H-350,zz],'МН1 дет.2 Ø12 L340',[pg,120,121],component='МН1',instance=str(i)))
    groups.append(group('mn1-anchors','МН1: восемь анкеров Ø12 L340','МН1',2,[pg,120,121],anchors1,kind='embedded',position='2'))
    anchors4=[];mn4plates=[]
    # MN4 own product16.1 pos3: side squares; product27 pos4: bottom squares.
    # Detail109 and nodeД: 20+160+20 across the200 concrete thickness;
    # two10 plates, clear140, four straight150 anchors with grid90×50.
    for i,(x0,y0) in enumerate(c['mn4'],1):
        for side,z0 in enumerate([20,170],1):
            mn4plates.append(plate(f'МН4 #{i}: дет.8 пластина{side} −10×150 L150',x0,y0,z0,150,150,10,[pg,120,121]))
        for j,(dx,dy) in enumerate([(30,50),(120,50),(30,100),(120,100)],1):
            anchors4.append(path(f'mn4:{i}:anchor:{j}',12,[x0+dx,y0+dy,25],[x0+dx,y0+dy,175],'МН4 дет.9 Ø12 L150',[pg,120,121],component='МН4',instance=str(i)))
    if anchors4:
        metals+=mn4plates
        groups.append(group('mn4-anchors','МН4: восемь анкеров Ø12 L150','МН4',2,[pg,120,121],anchors4,kind='embedded',position='3' if c['alias']=='ШЛ16.1' else '4'))
    anchors3=[];mn3plates=[];mn3indices=[]
    if c['alias']!='ШЛ27':
        for i,x0 in enumerate(c.get('mn3xs',[345,1185]),1):
            mn3indices.append(len(metals)+len(mn3plates))
            mn3plates.append(plate(f'МН3 #{i}: дет.6 −10×150 L150',x0,0,110,150,150,10,[pg,120,121]))
        metals+=mn3plates
    m['groups']=groups;m['metalParts']=metals;m['supplyId']=SUPPLY;m['status']='partial'
    # Old concrete and its known omitted local recesses are deliberately retained.
    m['pending']=[
       {'id':'local-concrete-recesses','kind':'not-modeled','sourcePages':[pg,121],
        'description':'Бетонное тело и bounds сохранены без изменения. Местные ниши/фаски МН2/МН3/МН4 по-прежнему не восстановлены: в модели эти места заполнены бетоном. Добавленные МН4 пересекаются с этим условно оставленным бетоном; вырезы необходимо восстановить отдельной задачей.'},
       {'id':'ab-loops','kind':'not-modeled','sourcePages':[pg,blk,118,119],
        'description':f'АБ поз.5 {c["loop"]}×2 и поз.6 {c["pg"]}×4 не включены: детали просмотрены, но осевые радиусы, ориентация пространственной петли и сопряжения требуют отдельной сверки. Внешний вид не заменён условными U-образными прутками.'},
       {'id':'other-embedded','kind':'not-modeled','sourcePages':[pg,120,121],
        'description':('Боковые МН2×2 не включены: не завершена сверка ориентации и сопряжения анкеров с нишей.' if c['alias']!='ШЛ16.1' else 'МН2 в собственной спецификации нет. МН1/МН4 имеют пластины и анкеры; у МН3 включены только пластины, анкеры остаются pending из-за конфликта двух размерных видов.')},
       {'id':'weld-layer-offsets-and-trimming','kind':'placement-question','sourcePages':[blk,detail],
        'description':'Лестницы и поперечные прутки показаны по размеренным номинальным осям фасада/разрезов. Смещение осей прутков на сварных пересечениях и порядок слоёв листом не заданы; физические взаимные пересечения в узлах не устранены выдуманным сдвигом. Примечание2 блока требует обрезать арматуру у закладных по месту; эти неразмеренные обрезки не выполнены.'},
    ]
    if c['y8'] is None:
        m['pending'].append({'id':'ab31-pos3-chain-conflict','kind':'source-conflict','sourcePages':[blk],
          'description':'АБ31 поз.3 Ø8 L1650×26 не построены: на листе90 размерная цепь «200×12=2390» арифметически неверна (должно2400), а длина блока2870 и крайние цепи25+100+115 дают2390. Ни шаг, ни габариты не подгонялись.'})
    if not k1modeled: m['pending'].append({'id':'k1-placement','kind':'not-modeled','sourcePages':[blk,116],'description':'К-1×2 на широком блоке пока не включены: необходимо уточнить положение по собственным проекциям; размер550 не переносился в неподтверждённые координаты.'})
    if k1modeled: m['pending'].append({'id':'k1-mass-source-conflict','kind':'source-conflict','sourcePages':[blk,116],
       'description':'К-1 построен по собственному листу105: L550, H170, C40, 2Ø10 L550 и6Ø6 L170. Деталь даёт0,92кг, большинство спецификаций блоков0,86кг; геометрическая масса0,9047кг. Противоречие массы не устранено изменением размеров/состава.'})
    if mn3plates:
        m['pending'].append({'id':'mn3-height-source-conflict','kind':'source-conflict','sourcePages':[120],
          'description':'МН3: подробный фасад даёт горизонтальную ось анкера на150+40=190мм, низ20 и вертикальный участок130. Видб одновременно подписывает высоту210мм. Анкеры НЕ построены: два размерных вида противоречат друг другу, базаR40 также требует сверки. Включены только подтверждённые пластины150×150×10 по узлуГ. Требуется уточнение.'})
    m['assumptions'] += [
       f'Арматурный блок размещён с отступом15 от граней бетона по собственным разрезам. {nc} каркасов: x40,140,340,…{W-140:g},{W-40:g}; продольные оси z40/160, поперечины z15…185. Сварные слои и обрезки по месту ещё не восстановлены.',
       ('К-1 восстановлен по своему подробному листу105, но масса0,86/0,92кг конфликтует между блоком и деталью.' if k1modeled else 'К-1 пока не включён: положение не подтверждено для этого широкого блока.')+' П/ПГ'+(', МН2' if c['alias']!='ШЛ16.1' else '')+' и неразмеренные сварные сдвиги остаются pending; добавленная арматура не заявлена полной.',
       ('МН3: собственный фасад из шахты показывает доступную нишу; в узлеГ это правая сторона разреза4–4. Поэтому при z0=доступная грань глубина110, пластинаz110…120. Анкеры не построены из-за конфликта190/210между двумя видами и базыR40; ни одно толкование не выбрано.' if mn3plates else 'МН3 в собственной спецификации этой марки нет.'),
       'МН1: пластины в верхних посадках, анкеры вниз340 от нижней поверхности пластины. '+('МН4: пластиныz20…30 и170…180, чистыйпросвет140; анкерыL150 поосямz25…175 входятвпластиныпо5мм. Геометриянеявляетсядетальюпровара/выборок; массоваяведомостьсчитаетсяотдельно. ' if anchors4 else '')+'Сварные швы не моделировались; производственная посадка не подтверждена.',
    ]
    m['notes']=[
       f'Добавлены {nc} основных лестничных каркасов'+(', два короткихК1' if k1modeled else '')+', прямые стержни Ø12'+(' и Ø8' if ps8 else '')+', МН1'+(' и МН4' if anchors4 else '')+(' и МН3' if anchors3 else '')+' с пластинами и анкерами по собственным исходным листам.',
       'Основной бетонный контур сохранён; локальные ниши закладных не восстановлены. Монтажные петли'+(', К1' if not k1modeled else '')+(', МН2' if c['alias']!='ШЛ16.1' else '')+(', анкерыМН3 из-за конфликта190/210' if mn3plates else '')+', сварные смещения и обрезки по месту остаются pending.'+(' МассаК1 конфликтует между блоком и деталью.' if k1modeled else '')+' Это частичная геометрия; производственная посадка и допуск в производство не подтверждены.',
       'Исходные калькуляционные количества, массы, ресурсы и цены не изменялись.'
    ]
    m['readinessDescription']=m['notes'][0]+' '+m['notes'][1]
    m['evidence'] += [
       {'pdfPage':blk,'sheet':str(blk-11),'subject':f'Собственный арматурный блок {c["alias"]}: фасад,1–1/2–2, спецификация',
        'checks':[f'блок{BW:g}×{L}×170, отступ15 от бетона; 25|100|200×{intervals}|100|25 по ширине',
                  f'{c["cage"]}×{nc}; прямыеØ12 L{BW:g}×8; Ø8 L{BW:g}×{c["n8"]}',
                  'поз.4 на25/125 от обоих торцов; поз.3 по собственной размерной цепи, кроме явно конфликтующей АБ31',
                  f'собственная ссылка каркаса на лист{detail-11}; К-1 на105; петли на107/108']},
       {'pdfPage':detail,'sheet':str(detail-11),'subject':f'{c["cage"]}: размеры и состав',
        'checks':[f'L{L}, H170, C25; дваØ10 длиной{L}; Ø8 L170×{c["rungs"]} на каркас',
                  f'A{c["A"]}, шаг200×{c["N"]}'+(f', остатокB{c["B"]}' if c['B'] else '')]},
       {'pdfPage':120,'sheet':'109','subject':'МН1 и МН4: собственные пластины и анкеры',
        'checks':['МН1: −10×200 L250×1 + Ø12 L340×4, масса5,13 кг',
                  'МН4: −10×150 L150×2 + Ø12 L150×4, наружная160, чистая140, масса4,06 кг',
                  'С245 пластины; А500С анкеры; ориентация сверена по собственному фасаду и узлам110']},
    ]
    if k1modeled: m['evidence'].append({'pdfPage':116,'sheet':'105','subject':'К-1: собственная подробная геометрия, два положения по фасаду блока',
        'checks':['L550,H170,C40,A25,S100×5:2Ø10 L550+6Ø6 L170',f'положение на собственном блоке PDF{blk}: yбл=L−60, xбл125…675 и975…1525, концы совпадают с внутренними вертикальными каркасами']})
    if mn3plates:
        m['evidence'].append({'pdfPage':120,'sheet':'109','subject':'МН3: подтверждённые пластины; анкеры не включены из-за конфликта двух видов',
          'checks':['пластина150×150×10; анкеры по спецификации дваØ12 L475: на фасаде130,20,R40 и плечи320/70/320, но базаR40 и спорная высота не выбраны',
                    'собственный фасад изшахты показывает доступную нишуМН3; в узлеГ это правая сторона разреза4–4. Приz0=доступная грань глубина110: пластинаz110…120, размер90 идёт от противоположной грани до её лицевой плоскости',
                    'ось верхнего луча фасада150+40=190; видб210 конфликтует; анкеры не построены, ни одно толкование не принято']})
    # Preserve all prior concrete QA, then add independent steel/placement checks.
    checks=copy.deepcopy(oldqa['checks'])
    checks += [
       {'check':'immutable-concrete-and-identity','result':'pass','detail':'concreteParts, bounds, id, sourceId, alias совпадают с глубоким снимком исходной live модели; SHA старой модели записан в replaces'},
       {'check':'cage-dimensions-and-counts','result':'pass','detail':f'{c["cage"]}:{nc} каркасов,{2*nc} длинныхØ10 L{L}; {nc*c["rungs"]} поперечинØ8 L170; H170, C25, A{c["A"]}, S200, дополнительныйB{c["B"]}',
        'sourcePages':sources,'quantity':nc,'longBars':2*nc,'rungs':nc*c['rungs']},
       {**mass_check('cage-mass-vs-detail',c['cage']+f'×{nc}',sum(map(kg_path,cage_paths)),nc*c['kg'],[blk,detail]),'groupIds':['ab-cages']},
       {**mass_check('straight12-mass-vs-block','АБ поз.4 Ø12×8',sum(map(kg_path,ps12)),8*c.get('kg12',1.46),[blk]),'groupIds':['ab-pos4']},
       {'check':'weld-offsets-and-recesses','result':'warn','detail':'Оси и размещение заданы по размеренным проекциям; сварные микросдвиги, обрезки по месту и исходные локальные бетонные ниши pending. Это не проверка отсутствия коллизий.'},
    ]
    k1kg=sum(map(kg_path,k1paths))
    if k1modeled: checks.append({**mass_check('k1-mass-vs-detail','К-1×2, полный состав',k1kg,2*.92,[blk,116]),'groupIds':['ab-k1']})
    if k1modeled and c['alias']!='ШЛ16.1':
        checks.append({**mass_check('k1-mass-vs-block-conflict','К-1×2 против спецификации блока',k1kg,2*.86,[blk,116]),'groupIds':['ab-k1']})
    if mn3plates:
        mn3kg=sum(slab.part_volume(p)*7850/1e9 for p in mn3plates)+sum(map(kg_path,anchors3))
        checks.append({**mass_check('mn3-mass-vs-spec','МН3×2, только2пластины без анкеров',mn3kg,2*2.61,[pg,120,121],tolerance=.01,partial=True),'groupIds':[],'metalPartIndices':mn3indices})
        checks.append({**mass_check('mn3-plates-mass-vs-detail','МН3 дет.6,2пластины150×150×10',mn3kg,2*1.77,[pg,120,121],tolerance=.005),'metalPartIndices':mn3indices})
        checks.append({'check':'mn3-plate-placement','result':'pass','sourcePages':[pg,120,121],'detail':'Собственный фасад изшахты показывает доступную нишуМН3; в узлеГ это праваясторона4–4. Приz0=доступная грань глубина110, пластинаz110…120; альтернативная сторона не выбиралась без фасада.'})
        checks.append({'check':'mn3-height-source-conflict','result':'warn','sourcePages':[120,121],
                       'detail':'Фасад детали:ось луча190; видб210. Анкеры не построены; ни одно спорное толкование не принято. Пластина подтверждена узломГ90+110.'})
    if ps8:checks.append({**mass_check('straight8-mass-vs-block','АБ поз.3 Ø8×'+str(len(ps8)),sum(map(kg_path,ps8)),len(ps8)*c.get('kg8',.65),[blk]),'groupIds':['ab-pos3']})
    else:checks.append({'check':'ab31-straight8-chain','result':'warn','detail':'Поз.3 оставлена pending:200×12=2390 против арифметических2400; координаты не угаданы.','sourcePages':[blk]})
    mn1metals=metals[:2]
    mn1kg=sum(slab.part_volume(p)*7850/1e9 for p in mn1metals)+sum(map(kg_path,anchors1))
    checks.append({**mass_check('mn1-mass-vs-spec','МН1×2, пластины+8анкеров',mn1kg,2*5.13,[pg,120,121],tolerance=.005),'groupIds':['mn1-anchors'],'metalPartIndices':[0,1]})
    if anchors4:
        mn4kg=sum(slab.part_volume(p)*7850/1e9 for p in mn4plates)+sum(map(kg_path,anchors4))
        checks.append({**mass_check('mn4-mass-vs-spec','МН4×2,4пластины+8анкеров',mn4kg,2*4.06,[pg,120,121],tolerance=.005),'groupIds':['mn4-anchors'],'metalPartIndices':list(range(2,6))})
    checks.append({'check':'embedded-placement','result':'pass','detail':'МН1: собственные верхние250×200 посадки, пластины yH−10…H, анкеры340 вниз; '+('МН4 боковые поз.3: x0…150/1530…1680, y1175…1325, пластины z20…30/170…180. Анкеры150 при чистомпросвете140 входятвпластиныпо5мм; провар/выборки не моделировались.' if c['alias']=='ШЛ16.1' else ('МН4 нижние поз.4: x345…495/1185…1335, y0…150, пластины z20…30/170…180. Анкеры150 при чистомпросвете140 входятвпластиныпо5мм; провар/выборки не моделировались.' if anchors4 else 'Остальные закладные pending.')),
                   'sourcePages':[pg,120,121]})
    allpaths=[p for g in groups for p in g['paths']]
    assert all(len(p['points'])>=2 and p['diameter']>0 and all(math.isfinite(v) for q in p['points'] for v in q) for p in allpaths)
    assert all(0<=q[0]<=W and 0<=q[1]<=H and 0<=q[2]<=T for p in allpaths for q in p['points'])
    checks.append({'check':'finite-paths-and-envelope','result':'pass','detail':f'{len(allpaths)} осевых путей конечны, имеют ненулевую длину; контрольные точки внутри габаритов исходного бетона. Ниши и взаимные пересечения этим не проверяются.'})
    # Full-diameter balances are deliberately partial where omitted components occur.
    abgroups=[g for g in groups if g['id'].startswith('ab-')]
    for dia,spec in c['steel'].items():
        calc=sum(kg_path(p) for g in abgroups for p in g['paths'] if p['diameter']==dia)
        ispartial=(dia==8 and not ps8) or (dia in [6,10] and not k1modeled)
        checks.append({**mass_check(f'block-diameter-{dia}-vs-schedule',f'Блок A500C Ø{dia}',calc,spec,[pg,blk,detail],partial=ispartial),'groupIds':[g['id'] for g in abgroups],'diameterFilter':dia,'materialFilter':'A500C'})
    a240=c.get('a240',({12:4.84,14:3.44} if c['loop']=='П2' else {14:7.88,16:4.92}))
    for dia,spec in a240.items():
        checks.append(mass_check(f'block-a240-diameter-{dia}-vs-schedule',f'Блок A240 Ø{dia} (петли pending)',0,spec,[pg,blk,118,119],partial=True))
    abkg=sum(kg_path(p) for g in abgroups for p in g['paths'])
    checks.append({**mass_check('block-total-mass-vs-schedule','Неполный блок: покрытие позиций см. componentCoverage',abkg,c['blockKg'],[pg,blk],partial=True),'groupIds':[g['id'] for g in abgroups]})
    cov=[coverage('1','АБ'+c['alias'][2:],1,1,'partial','Монтажные П/ПГ и сварные смещения не восстановлены; массаК1 конфликтует между листами; АБ31 также без поз.3'),
         coverage('1',c['cage'],nc,nc,parent='АБ'),
         coverage('1.1','Ø10 L'+str(L),2*nc,2*nc,parent=c['cage']+f'×{nc}'),
         coverage('1.2','Ø8 L170',nc*c['rungs'],nc*c['rungs'],parent=c['cage']+f'×{nc}'),
         coverage('2','К-1',2,2 if k1modeled else 0,'partial' if k1modeled else 'pending','Размеры/состав и положения восстановлены; конфликт массы0,86/0,92кг, сварные смещения pending' if k1modeled else 'Положение на широком блоке пока не подтверждено',parent='АБ'),
         coverage('2.1','К1 Ø10 L550',4,4 if k1modeled else 0,'modeled' if k1modeled else 'pending','' if k1modeled else 'К1 pending',parent='К1×2'),
         coverage('2.2','К1 Ø6 L170',12,12 if k1modeled else 0,'modeled' if k1modeled else 'pending','' if k1modeled else 'К1 pending',parent='К1×2'),
         coverage('3',f'Ø8 L{BW:g}',c['n8'],len(ps8),'modeled' if ps8 else 'pending','' if ps8 else 'АБ31 конфликт200×12=2390',parent='АБ'),
         coverage('4',f'Ø12 L{BW:g}',8,8,parent='АБ'),
         coverage('5',c['loop'],2,0,'pending','Осевые радиусы/размещение и направление загибов требуют сверки',parent='АБ'),
         coverage('6',c['pg'],4,0,'pending','Пространственная форма и направление требуют сверки',parent='АБ'),
         coverage('2','МН1',2,2),coverage('2.1','МН1 пластина−10×200 L250',2,2,parent='МН1×2'),coverage('2.2','МН1 Ø12 L340',8,8,parent='МН1×2')]
    if anchors4:
        cov.extend([coverage('3' if c['alias']=='ШЛ16.1' else '4','МН4',2,2),coverage('8','МН4 пластина−10×150 L150',4,4,parent='МН4×2'),coverage('9','МН4 Ø12 L150',8,8,parent='МН4×2')])
    if c['alias']!='ШЛ16.1':cov.append(coverage('3','МН2',2,0,'pending','Не подтверждена ориентация относительно толщины и сопряжение анкеров с нишей'))
    if mn3plates:cov.extend([coverage('4','МН3',2,2,'partial','Включены только пластины; анкеры не построены из-за конфликта190/210между двумя размерными видами'),coverage('6','МН3 пластина−10×150 L150',2,2,parent='МН3×2'),coverage('7','МН3 Ø12 L475',4,0,'pending','Конфликт190/210между двумя размерными видами и базаR40; ни одно толкование не выбрано',parent='МН3×2')])
    qa={'alias':m['alias'],'status':'partial','checks':checks,'componentCoverage':cov,
        'counts':{'concreteParts':len(m['concreteParts']),'metalParts':len(metals),'groups':len(groups),'paths':len(allpaths),'checks':len(checks),'warnings':sum(v['result']=='warn' for v in checks),'failures':sum(v['result']=='fail' for v in checks)}}
    for key in ['concreteParts','bounds','id','sourceId','alias']:assert dumps(m[key])==dumps(old[key])
    return m,qa

def build(base=None):
    assert hashlib.sha256((ASSETS/'sources/doc13.pdf').read_bytes()).hexdigest()==SOURCE_SHA
    live=json.loads((ASSETS/'promka-solid-models.json').read_text()) if base is None else json.loads(base.read_text())
    supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text())
    byalias={v.get('alias'):v for v in live.values()}
    models,qas,replaces={},{},{}
    for c in CONFIGS:
        old=byalias[c['alias']];assert old['sourceId']=='doc13'
        assert old['supplyId']=='codex-quick-shafts-20261111','Expected original quick concrete model; supply already changed'
        oldqa=supplies[old['supplyId']]['qa']['models'][old['id']]
        m,q=build_model(old,c,oldqa);models[m['id']]=m;qas[m['id']]=q;replaces[m['id']]=sha(old)
    sys.path.insert(0,str(ROOT))
    from app.calc.source_policy import SourcePolicy
    policy=SourcePolicy(ASSETS)
    for model in models.values():policy.reading(model,'doc13')
    for q in qas.values():policy.reading(q,'doc13')
    digest=sha(models)
    prior=supplies.get(SUPPLY,{})
    captured_at=prior.get('capturedAt') if prior.get('modelsSha256')==digest else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={'label':'Codex · частичная арматура и закладные девяти ШЛ','snapshot':'20261111-rebar-shafts','modelsSha256':digest,'modelCount':len(models),'capturedAt':captured_at,
      'qa':{'modelsSha256':digest,'tool':'scripts/build_calc_rebar_shafts.py','covers':['неизменность исходного бетона/габаритов','состав и размеры основных лестниц и прямых стержней по собственным блокам','МН1 и МН4 пластины/анкеры, размещение по собственным фасадам и узлам','покомпонентное покрытие, длины и массы по ведомостям'],
            'doesNotCover':['монтажные петли П/ПГ, конфликт массыК1','МН2, конфликт высотыМН3 и локальные бетонные ниши','сварные сдвиги, обрезки по месту и отсутствие коллизий','полная производственная геометрия'],'models':qas},
      'report':'ШЛ7/16.1/19/23/27/28/29/ШЛ3О/31: 10или14 основных лестниц на изделие, прямыеØ12, прямыеØ8 кроме конфликтующей АБ31, К1, МН1 пластины+анкеры; ШЛ16.1 и27 также МН4, в восьми изделиях подтверждённые пластиныМН3 без спорных анкеров. Все остаются partial; бетон сохранён дословно.'}
    return {'models':models,'supplies':{SUPPLY:delivery},'replaces':replaces}

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,default=ROOT/'tmp/rebar-models/shafts.json');ap.add_argument('--base',type=Path)
    args=ap.parse_args();p=build(args.base)
    assert all(q['counts']['failures']==0 for q in p['supplies'][SUPPLY]['qa']['models'].values())
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(dumps(p))
    for k,m in p['models'].items():print(m['alias'],p['supplies'][SUPPLY]['qa']['models'][k]['counts'])
    print(args.output)

if __name__=='__main__':main()

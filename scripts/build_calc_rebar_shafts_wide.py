#!/usr/bin/env python3
"""Add only the complete, own-spec-confirmed МН1 component to ШЛ11/ШЛ15.

Own doc13 PDF42/58, detail PDF120 and nodeБ PDF121 were visually reviewed.
No AB geometry or other embedded detail is guessed. Live assets are read only.
"""
import argparse
import copy
import datetime
import json
import math
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
import build_calc_rebar_shafts as common

ROOT=common.ROOT
ASSETS=common.ASSETS
SUPPLY='codex-rebar-shafts-wide-20261111'
OUT=ROOT/'tmp/rebar-models/shafts-wide.json'
CONFIG=[('ШЛ11',42,4000,43,214.89,4,24.92,239.81),
        ('ШЛ15',58,2500,59,136.51,2,20.20,156.71)]


def build(base=None):
    live=json.loads((ASSETS/'promka-solid-models.json').read_text())
    if base:live.update(json.loads(Path(base).read_text()))
    supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text())
    registry=json.loads((ASSETS/'promka-register.json').read_text())
    by_alias={m['alias']:m for m in live.values()}
    models,replaces,qas={},{},{}
    sys.path.insert(0,str(ROOT))
    from app.calc.source_policy import SourcePolicy
    policy=SourcePolicy(ASSETS)
    for alias,pg,H,block,abkg,mn2q,embeddedkg,productkg in CONFIG:
        old=by_alias[alias];key=old['id'];m=copy.deepcopy(old)
        assert old['sourceId']=='doc13' and old['bounds']==[[0,0,0],[3050,H,200]]
        assert not old['groups'] and not old['metalParts']
        assert registry[key]['source']['productPage']==pg
        pages=[pg,120,121];metals=[];anchors=[]
        for instance,x0 in enumerate([0,2800],1):
            metals.append(common.plate(f'МН1 #{instance}: −10×200 L250',x0,H-10,0,250,200,10,pages,axis='y'))
            for j,(dx,z) in enumerate([(50,50),(200,50),(50,150),(200,150)],1):
                anchors.append(common.path(f'mn1-{instance}-anchor-{j}',12,[x0+dx,H-10,z],[x0+dx,H-350,z],
                                           'МН1 поз.2 Ø12 L340',pages,material='A500C',component='МН1',instance=str(instance)))
        groups=[common.group('mn1-anchors','МН1: восемь прямых анкеров Ø12 L340','МН1',2,pages,anchors,kind='embedded',position='2')]
        m.update(groups=groups,metalParts=metals,supplyId=SUPPLY,status='partial')
        m['pending']=[
            {'id':'ab-entirely-pending','kind':'not-modeled','sourcePages':[pg,block],
             'description':f'Весь собственный арматурный блок АБ{alias[2:]} (1шт, {abkg}кг), его каркасы, прямые стержни, петли и выпуски остаются непостроенными. Добавление МН1 не означает восстановления АБ.'},
            {'id':'other-embedded','kind':'not-modeled','sourcePages':pages,
             'description':f'Собственная поз.3 МН2×{mn2q} и поз.4 МН3×2 остаются непостроенными. Геометрия и анкеры этих деталей не заменены условными пластинами.'},
            {'id':'local-concrete-niches','kind':'not-modeled','sourcePages':[pg,121],
             'description':'Исходный бетон сохранён дословно. В нём есть подтверждённые верхние посадки МН1 250×200×10; местные ниши/фаски МН2/МН3 остаются заполненными бетоном как ранее. УзелВ145+15=160 не заменяет собственную толщину панели200.'},
            {'id':'welds-and-ab-intersections','kind':'not-modeled','sourcePages':pages,
             'description':'Сварные швы анкеров с пластиной и детали провара не моделировались. Проверка взаимного положения МН1 с пока отсутствующим АБ не выполнена; производственный допуск не подтверждён.'},
        ]
        m['notes'] += ['Добавлен только полный простой компонент МН1×2: две пластины250×200×10 C245 и восемь прямых анкеровØ12 L340 A500C по собственной спецификации.',
                       'Весь арматурный блок и прочие закладные остаются pending. Исходные объёмы, массы, ресурсы, ставки и бетон не менялись.']
        m['readinessDescription']='Восстановлены МН1×2 с пластинами и всеми8 анкерами. Арматурный блок, монтажные петли и прочие закладные не восстановлены; модель частичная.'
        m['assumptions'] += ['МН1: собственные крайние верхние посадки x0…250 и2800…3050; пластина yH−10…H на всю толщину200. Анкеры идут от нижней поверхности пластины340 вниз, оси x50/200 относительно пластины иz50/150 по листу109.',
                             'Восстановлена номинальная геометрия пластины и прямых анкеров, без выдуманных сварных валиков. Монтажные петли не включены и не выдаются за закладные пластины.']
        m['evidence'] += [
            {'pdfPage':pg,'sheet':str(pg-11),'subject':alias+': собственная позиция2 МН1×2 и собственные верхние посадки',
             'checks':['МН1×2 по5.13кг','ширина3050','крайние посадки250мм','ссылка на лист109 и узлы110']},
            {'pdfPage':120,'sheet':'109','subject':'МН1: собственные пластина и четыре прямых анкера',
             'checks':['C245 −10×200 L250,1шт,3.93кг','A500C Ø12 L340,4шт по0.30кг','оси50/200 и50/150','общая масса5.13кг']},
            {'pdfPage':121,'sheet':'110','subject':'УзелБ МН1: верхняя горизонтальная пластина в посадке',
             'checks':['длина250,ширина200,заглубление10','нижняя поверхность пластиныH−10','анкеры по своей детали109']},
        ]
        oldqa=supplies[old['supplyId']]['qa']['models'][key]
        checks=copy.deepcopy(oldqa['checks'])
        platekg=sum(common.slab.part_volume(p)*7850/1e9 for p in metals)
        anchorkg=sum(map(common.kg_path,anchors));total=platekg+anchorkg
        checks += [
            {'check':'mn1-signed-counts-and-lengths','result':'pass','sourcePages':pages,
             'expected':{'assemblies':2,'plates':2,'anchors':8,'anchorLengthMm':340},
             'actual':{'assemblies':len(anchors)//4,'plates':len(metals),'anchors':len(anchors),'anchorLengthMm':common.length(anchors[0])},
             'detail':'Количество фактически созданных частей и длина каждого из8 прямых анкеров сверены с собственной поз.2 и деталью109.'},
            {**common.mass_check('mn1-plates-mass-vs-spec','МН1: две пластины250×200×10',platekg,2*3.93,pages,tolerance=.005),'groupIds':[],'metalPartIndices':[0,1]},
            {**common.mass_check('mn1-anchors-mass-vs-spec','МН1: восемь анкеровØ12 L340',anchorkg,8*.30,pages,tolerance=.01),'groupIds':['mn1-anchors'],'metalPartIndices':[]},
            {**common.mass_check('mn1-full-component-mass-vs-spec','МН1×2, полный компонент',total,2*5.13,pages,tolerance=.005),'groupIds':['mn1-anchors'],'metalPartIndices':[0,1]},
            {**common.mass_check('embedded-partial-mass-vs-own-schedule','Покрытие всей ведомости закладных (толькоМН1)',total,embeddedkg,[pg],partial=True),'groupIds':['mn1-anchors'],'metalPartIndices':[0,1]},
            {'check':'mn1-placement','result':'pass','sourcePages':pages,
             'detail':f'Собственные посадки x0…250/2800…3050,z0…200,y{H-10}…{H};8анкеров y{H-10}…{H-350},сетка50/200×50/150.'},
            {'check':'concrete-and-identity-immutable','result':'pass','detail':'concreteParts,bounds,id,sourceId,alias сохранены дословно; SHA исходной raw модели записан в replaces.'},
            {'check':'unmodeled-ab-and-other-embedded','result':'warn','sourcePages':[pg,block],
             'detail':f'Из общей стали{productkg}кг показана толькоМН1 {total:.5f}кг. АБ{abkg}кг,МН2×{mn2q}иМН3×2 полностьюpending. Этот баланс не заявлен полным.'},
        ]
        assert len(anchors)==8 and all(abs(common.length(p)-340)<1e-8 for p in anchors)
        assert len({common.dumps(p['points']) for p in anchors})==8
        assert all(0<=v[0]<=3050 and 0<=v[1]<=H and 0<=v[2]<=200 for p in anchors for v in p['points'])
        assert all(m[k]==old[k] for k in ['concreteParts','bounds','id','sourceId','alias'])
        cov=[common.coverage('1','АБ'+alias[2:],1,0,'pending','Полный блок с петлями/выпусками не восстановлен'),
             common.coverage('2','МН1',2,2),common.coverage('2.1','МН1: пластина250×200×10',2,2,parent='МН1×2'),
             common.coverage('2.2','МН1: Ø12 L340',8,8,parent='МН1×2'),
             common.coverage('3','МН2',mn2q,0,'pending','Не восстановлена геометрия/ориентация и сопряжение с собственной нишей'),
             common.coverage('4','МН3',2,0,'pending','Не восстановлены анкеры/пластина и сопряжение с собственной нишей')]
        qa={'alias':alias,'status':'partial','checks':checks,'componentCoverage':cov,
            'counts':{'concreteParts':len(m['concreteParts']),'metalParts':2,'groups':1,'paths':8,'checks':len(checks),
                      'warnings':sum(c['result']=='warn' for c in checks),'failures':sum(c['result']=='fail' for c in checks)}}
        policy.model({**registry[key],'solidModel':m});policy.reading(qa,'doc13')
        assert qa['counts']['failures']==0
        models[key]=m;replaces[key]=common.sha(old);qas[key]=qa
    digest=common.sha(models);prior=supplies.get(SUPPLY,{})
    if prior.get('modelsSha256')!=digest and OUT.exists():prior=json.loads(OUT.read_text()).get('supplies',{}).get(SUPPLY,{})
    captured=prior['capturedAt'] if prior.get('modelsSha256')==digest else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={'label':'Codex · МН1 двух широких ШЛ','snapshot':'20261111-rebar-shafts-wide','modelsSha256':digest,
              'modelCount':2,'capturedAt':captured,'qa':{'modelsSha256':digest,'tool':'scripts/build_calc_rebar_shafts_wide.py',
              'covers':['МН1×2 целиком по собственной спецификации','размеры/размещения пластин и анкеров','количества и независимые массы','неизменность бетона'],
              'doesNotCover':['весь АБ, петли и выпуски','МН2/МН3 и их местные ниши','сварные швы и пересечения с АБ','допуск в производство'],'models':qas},
              'report':'ШЛ11/ШЛ15: толькополныйМН1×2 на каждомизделии,2пластины250×200×10и8анкеровØ12 L340. Всеостальныепозициисталиpending;бетонсохранён.'}
    return {'models':models,'supplies':{SUPPLY:delivery},'replaces':replaces}


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--base',type=Path);args=ap.parse_args()
    package=build(args.base);OUT.parent.mkdir(parents=True,exist_ok=True);OUT.write_text(common.dumps(package))
    print(OUT,'2 models; 4 plates;16 anchors')

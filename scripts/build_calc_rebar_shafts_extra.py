#!/usr/bin/env python3
"""Four further shaft-panel upgrades from their own reviewed doc13 sheets.

The finalized nine-panel package and generator remain unchanged. This uses their
read-only build_model helper with independently reviewed product/block constants.
Concrete, bounds and identity are copied unchanged from raw live/base models.
"""
import argparse
import copy
import datetime
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
import build_calc_rebar_shafts as core

ROOT=core.ROOT
ASSETS=core.ASSETS
SUPPLY='codex-rebar-shafts-extra-20261111'
CONFIGS=[
 {'alias':'ШЛ3','page':18,'block':19,'L':3970,'cage':'К-5','detail':116,'A':35,'N':19,'B':100,'rungs':21,'kg':6.37,'n8':36,'y8':285,'actualY8':245,'topY8':325,'blockKg':171.58,'mn4':[],'mn3xs':[285,2045],'loop':'П6','pg':'ПГ5','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{18:15.72,22:12.48},'steel':{6:.48,8:55.50,10:69.96,12:17.44}},
 {'alias':'ШЛ21','page':74,'block':75,'L':2880,'cage':'КР-3','detail':117,'A':40,'N':14,'B':0,'rungs':15,'kg':4.61,'n8':26,'y8':240,'actualY8':240,'topY8':240,'blockKg':128.82,'mn4':[],'mn3xs':[390,1940],'loop':'П5','pg':'ПГ4','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{16:10.28,20:9.62},'steel':{6:.36,8:39.92,10:51.20,12:17.44}},
 {'alias':'ШЛ25','page':84,'block':85,'L':2870,'cage':'КР-5','detail':117,'A':35,'N':14,'B':0,'rungs':15,'kg':4.59,'n8':26,'y8':235,'actualY8':235,'topY8':235,'blockKg':128.54,'mn4':[],'mn3xs':[390,1940],'loop':'П5','pg':'ПГ4','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{16:10.28,20:9.62},'steel':{6:.36,8:39.92,10:51.20,12:17.44}},
 {'alias':'ШЛ17','page':64,'block':65,'L':2810,'cage':'КР-1','detail':117,'A':35,'N':13,'B':140,'rungs':15,'kg':4.51,'n8':24,'y8':305,'actualY8':305,'topY8':305,'blockKg':123.10,'mn4':[(390,0),(1940,0)],'mn3xs':[390,1940],'loop':'П4','pg':'ПГ4','k1modeled':False,'kg8':.97,'kg12':2.18,'a240':{16:10.28,18:7.24},'steel':{6:.36,8:37.98,10:49.80,12:17.44}},
]


def assemble(old,c,oldqa):
    # Core's regular-grid builder is read-only. All final positions of pos3
    # are replaced below from this product's own signed chain. In AB3 the
    # chain is asymmetric245+3400+325, unlike regular-grid AB21 and AB25.
    m,qa=core.build_model(old,c,oldqa)
    m['supplyId']=SUPPLY
    if c['alias']=='ШЛ17':
        # Own product64 has MN4 at position4 and NO MN3. Remove the
        # generic helper's MN3-only additions; retain correctly placed MN4.
        m['metalParts']=[p for p in m['metalParts'] if not p['name'].startswith('МН3')]
        m['pending']=[p for p in m['pending'] if p.get('id')!='mn3-height-source-conflict']
        m['assumptions']=[a for a in m['assumptions'] if not a.startswith('МН3:')]
        m['evidence']=[e for e in m['evidence'] if not e.get('subject','').startswith('МН3:')]
        qa['checks']=[a for a in qa['checks'] if not a['check'].startswith('mn3-')]
        qa['componentCoverage']=[a for a in qa['componentCoverage'] if not a['designation'].startswith('МН3')]
        for a in qa['checks']:
            if a['check']=='embedded-placement':
                a['detail']='МН1: собственные верхние250×200 посадки. МН4: собственный PDF64 поз.4 и узелД; x390…540 и1940…2090, y0…150; пластиныz20…30/170…180, анкерыL150междуz25…175. Просвет140, входвпластиныпо5; провар/выборки и производственнаяпосадка не подтверждены.'
        m['evidence'].append({'pdfPage':64,'sheet':'53','subject':'МН4 нижние позиции по собственному фасаду ШЛ17',
            'checks':['спецификация:поз.4 МН4×2; МН3 в этой марке нет','нижняя размерная цепь390+150+1400+150+390=2480; x390…540/1940…2090,y0…150',
                      'узелД110 и детальМН4лист109: пластиныz20…30/170…180; четыре анкераL150на каждую деталь по z25…175; сварные выборки не моделировались']})
        m['notes']=['Добавлены14основных лестничных каркасов КР1, прямые Ø8/Ø12 L2450, МН1 и нижниеМН4 с пластинами и анкерами по собственным листам.',
          'Бетон и bounds сохранены; локальные ниши не восстановлены. К1, монтажныеП4/ПГ4, боковыеМН2, сварные смещения и обрезки по месту pending. МН3 в этой спецификации нет. Производственная посадка не подтверждена.']
        m['readinessDescription']=' '.join(m['notes'])
    bars=next(g for g in m['groups'] if g['id']=='ab-pos3')['paths']
    ys=[15+c['actualY8']+200*k for k in range(c['n8']//2)]
    assert c['L']-(ys[-1]-15)==c['topY8']
    assert len(bars)==len(ys)*2
    for j,y in enumerate(ys):
        for side,z in enumerate([40,160]):
            bars[j*2+side]['points']=[[15,y,z],[2465,y,z]]
    evidence={'pdfPage':c['block'],'sheet':str(c['block']-11),
      'subject':'Собственная размерная цепь прямых Ø8, без переноса с соседней марки',
      'checks':[f'низ блока→первая ось: {c["actualY8"]}мм; {c["n8"]//2-1} интервалов×200; последняя ось→верх блока: {c["topY8"]}мм',
                f'{c["actualY8"]}+200×{c["n8"]//2-1}+{c["topY8"]}={c["L"]}; {len(ys)} рядов на каждой стороне, всего{len(bars)}Ø8 L2450',
                'начало блока на15 выше низа бетона; x15…2465; z40/160 по собственным разрезам']}
    m['evidence'].append(evidence)
    m['assumptions'].append(f'Прямые Ø8 этой марки размещены по собственной цепи: {c["actualY8"]}+200×{c["n8"]//2-1}+{c["topY8"]}={c["L"]}. Для АБ3 крайние отступы несимметричны245/325; положение не подгонялось к симметрии.')
    qa['checks'].append({'check':'own-straight8-position-chain','result':'pass','sourcePages':[c['page'],c['block']],
      'detail':f'Подписанная цепь блока {c["actualY8"]}+200×{len(ys)-1}+{c["topY8"]}={c["L"]}; проверены реальные координаты всех{len(bars)} путей Ø8.',
      'expected':ys,'actual':[bars[j*2]['points'][0][1] for j in range(len(ys))],'units':'mm'})
    if c['alias']!='ШЛ17': qa['checks'].append({'check':'mn3-plates-only','result':'pass','sourcePages':[c['page'],120,121],
      'detail':'МН3: включены только две пластины150×150×10 по доступной нише собственного фасада и узлуГ; анкеры не выбраны из противоречивых190/210/R40.'})
    for line in qa['componentCoverage']:
        if line['parent']=='product' and line['position']=='1':
            line['reason']='Монтажные П/ПГ, короткие К1 и сварные смещения не восстановлены. Состав показан частично; неполные позиции перечислены отдельно.'
    assert not any(g['id'] in ['ab-k1','mn3-anchors'] for g in m['groups'])
    for key in ['concreteParts','bounds','id','sourceId','alias']:assert core.dumps(m[key])==core.dumps(old[key])
    qa['counts']['metalParts']=len(m['metalParts'])
    qa['counts']['checks']=len(qa['checks'])
    qa['counts']['warnings']=sum(v['result']=='warn' for v in qa['checks'])
    qa['counts']['failures']=sum(v['result']=='fail' for v in qa['checks'])
    return m,qa


def build(base=None):
    assert hashlib.sha256((ASSETS/'sources/doc13.pdf').read_bytes()).hexdigest()==core.SOURCE_SHA
    live=json.loads((ASSETS/'promka-solid-models.json').read_text()) if base is None else json.loads(base.read_text())
    supplies=json.loads((ASSETS/'promka-solid-supplies.json').read_text())
    by_alias={v.get('alias'):v for v in live.values()}
    models,qas,replaces={}, {}, {}
    for c in CONFIGS:
        old=by_alias[c['alias']]
        assert old['supplyId']=='codex-quick-shafts-20261111'
        qold=supplies[old['supplyId']]['qa']['models'][old['id']]
        m,q=assemble(copy.deepcopy(old),c,qold)
        models[m['id']]=m;qas[m['id']]=q;replaces[m['id']]=core.sha(old)
    sys.path.insert(0,str(ROOT))
    from app.calc.source_policy import SourcePolicy
    policy=SourcePolicy(ASSETS)
    for model in models.values():policy.reading(model,'doc13')
    for q in qas.values():policy.reading(q,'doc13')
    digest=core.sha(models);prior=supplies.get(SUPPLY,{})
    captured_at=prior.get('capturedAt') if prior.get('modelsSha256')==digest else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={'label':'Codex · частичная арматура и закладные ШЛ3/17/21/25','snapshot':'20261111-rebar-shafts-extra','modelsSha256':digest,'modelCount':len(models),'capturedAt':captured_at,
      'qa':{'modelsSha256':digest,'tool':'scripts/build_calc_rebar_shafts_extra.py',
            'covers':['неизменность исходного бетона/габаритов/идентичности','собственные блоки:14лестниц на изделие и прямые Ø8/Ø12 L2450','собственные положения МН1, полные пластины и анкеры МН1','только подтверждённые пластины МН3, анкеры оставлены pending','массы/размеры/количества, собственные асимметричные цепи'],
            'doesNotCover':['К1, монтажные петли и МН2','анкеры МН3: конфликт190/210 и базаR40','локальные бетонные ниши/фаски, сварные сдвиги и обрезки по месту','полная производственная геометрия и отсутствие коллизий'],'models':qas},
      'report':'ШЛ3/17/21/25:14основных лестничных каркасов на изделие, прямые Ø8/Ø12 L2450, МН1 пластины+анкеры, подтверждённые пластиныМН3 вШЛ3/21/25; вШЛ17 нижниеМН4 с пластинами и анкерами без МН3. Собственная АБ3 цепьØ8:245+3400+325. К1, петли, МН2 и спорные анкерыМН3 pending. Бетон сохранён дословно.'}
    return {'models':models,'supplies':{SUPPLY:delivery},'replaces':replaces}


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,default=ROOT/'tmp/rebar-models/shafts-extra.json');ap.add_argument('--base',type=Path)
    args=ap.parse_args();p=build(args.base)
    assert all(q['counts']['failures']==0 for q in p['supplies'][SUPPLY]['qa']['models'].values())
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(core.dumps(p))
    for k,m in p['models'].items():print(m['alias'],p['supplies'][SUPPLY]['qa']['models'][k]['counts'])
    print(args.output)

if __name__=='__main__':main()

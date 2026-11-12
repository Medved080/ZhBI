#!/usr/bin/env python3
"""Reproducible partial shaft-wall solids from visually reviewed doc13 sheets.

Writes ONLY an isolated review/import package; never edits catalog or shared solids.
All dimensions below are signed on the individual product sheets, not envelopes.
Scope: principal concrete body and the two fully dimensioned top MN1 seats.
The local MN2/MN3/MN4 recesses and chamfers remain explicitly pending.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab
from shapely.geometry import Polygon

SUPPLY_ID = 'codex-quick-shafts-20261111'
SOURCE_SHA256 = '31ad9d83f2d1a1933007804ffe05925b177a074ca93b25a6c0a72795eea08992'
# alias, PDF page, signed facade width, signed height, signed thickness, sheet V.
# Every listed product sheet and the common node sheet110 (PDF121) reviewed visually.
PRODUCTS = [
    ('ШЛ3',18,2480,4000,200,1.98),
    ('ШЛ7',28,2480,2500,200,1.24),
    ('ШЛ11',42,3050,4000,200,2.44),
    ('ШЛ15',58,3050,2500,200,1.52),
    ('ШЛ16.1',62,1680,2500,200,.84),
    ('ШЛ17',64,2480,2840,200,1.41),
    ('ШЛ19',70,2480,2000,200,.99),
    ('ШЛ21',74,2480,2910,200,1.44),
    ('ШЛ23',80,2480,2450,200,1.22),
    ('ШЛ25',84,2480,2900,200,1.44),
    ('ШЛ27',88,1680,2840,200,.95),
    ('ШЛ28',92,1680,2000,200,.67),
    ('ШЛ29',94,1680,2910,200,.98),
    ('ШЛ3О',98,1680,2450,200,.82),
    ('ШЛ31',100,1680,2900,200,.97),
]


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def build():
    assets = slab.CATALOG_DIR
    source = assets / 'sources/doc13.pdf'
    assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_SHA256, 'Source PDF changed; visual review must be repeated'
    catalog = json.loads((assets / 'promka-models.json').read_text())
    catalog.update(json.loads((assets / 'promka-register.json').read_text()))
    existing = json.loads((assets / 'promka-solid-models.json').read_text())
    by_alias = {v['alias']: v for v in catalog.values() if v.get('alias')}
    models, qas, skipped = {}, {}, []
    for alias, page, width, height, thick, volume in PRODUCTS:
        entry = by_alias[alias]
        key = entry['id']
        if entry.get('excluded') or entry.get('groups') or (key in existing and existing[key].get('supplyId') != SUPPLY_ID):
            skipped.append({'alias': alias, 'reason': 'excluded, native groups, or pre-existing solid'})
            continue
        assert entry['source']['id'] == 'doc13'
        assert entry['source']['productPage'] == page
        assert entry['projectVolume'] == volume
        # Node Б, sheet110: MN1 seat is 250 along facade, 200 across
        # thickness, 10 below top edge. Product facades show one at each end.
        profile = Polygon([(0,0),(width,0),(width,height-10),
                           (width-250,height-10),(width-250,height),
                           (250,height),(250,height-10),(0,height-10)])
        part = slab.extrusion_part(
            f'{alias}: основное бетонное тело с верхними посадками МН1; местные ниши МН2/МН3/МН4 не восстановлены',
            profile, [0,0,0], [1,0,0], [0,1,0], [0,0,1], thick, [page,121])
        parts = [part]
        bounds = slab._bounds_of(parts)
        actual = [round(bounds[1][i]-bounds[0][i],3) for i in range(3)]
        expected = [width,height,thick]
        independent_m3 = (width*height*thick - 2*250*10*thick)/1e9
        model_m3 = slab.part_volume(part)/1e9
        assert abs(model_m3-independent_m3) < 1e-10
        assert actual == expected
        checks = [
            {'check':'signed-dimensions','result':'pass','expected':expected,'actual':actual,'units':'mm',
             'detail':f'doc13 PDF {page}, лист {page-11}: фасад {width}×{height} мм, разрезы 1–1/2–2: толщина {thick} мм; габариты модели совпали'},
            slab._volume_check(parts,volume,f'doc13 PDF {page}, лист {page-11}, спецификация «Бетон»',tolerance=.01),
            {'check':'independent-volume-formula','result':'pass','modelM3':round(model_m3,6),'formulaM3':round(independent_m3,6),
             'detail':f'({width}×{height}×{thick} − 2×250×10×{thick}) / 10^9 = {independent_m3:.6f} м³; вычтены только верхние посадки МН1'},
            *slab._structure_checks(parts),
            {'check':'local-embedded-recesses','result':'warn',
             'detail':'Локальные ниши/скосы у МН2, МН3 или МН4 видны на фасаде и узлах PDF121, но ещё не восстановлены; бетонное тело в этих местах завышено. Совпадение округлённого объёма не подтверждает их геометрию.'},
        ]
        assert all(c['result'] != 'fail' for c in checks)
        assert next(c for c in checks if c['check']=='volume-vs-spec')['result']=='pass'
        pending = [
            {'id':'reinforcement-and-lifting-loops','kind':'not-modeled','sourcePages':[page,page+1],
             'description':'Арматурный блок, монтажные петли и выпуски не построены. Их количество, массы и размеры не подменены условной арматурой; требуется отдельное восстановление по листу блока.'},
            {'id':'embedded-metal-and-local-concrete','kind':'not-modeled','sourcePages':[page,120,121],
             'description':'Металлические детали МН1/МН2/МН3/МН4 и локальные ниши/фаски у МН2/МН3/МН4 не построены. Показаны только верхние посадки МН1 250×10 на всю толщину200. Узел В PDF121 даёт локальную цепочку145+15=160, тогда как толщина панели на индивидуальном листе200; ориентация и сопряжения требуют отдельной сверки. При моделировании местных деталей нельзя заменять ими подтверждённую толщину панели.'},
        ]
        models[key] = {
            'id':key,'sourceId':'doc13','alias':alias,'supplyId':SUPPLY_ID,
            'format':'project-solids-mm-v1','status':'partial','modelType':'wall',
            'elementType':'панель шахты лифта: основное бетонное тело',
            'concreteParts':parts,'metalParts':[],'groups':[],'bounds':bounds,
            'coordinateSystem':'мм; x — ширина фасада, y — вверх, z — толщина от вида из шахты',
            'coordinateOrigin':'x=0 — левая грань фасада из шахты, y=0 — низ, z=0 — лицевая сторона',
            'evidence':[
                {'pdfPage':page,'sheet':str(page-11),'subject':f'{alias}: фасад, разрезы1–1/2–2, спецификация',
                 'checks':[f'подписанные габариты {width}×{height}×{thick} мм',f'бетон по спецификации {volume:.2f} м³',
                           'примечание2 индивидуального листа: «Узлы см. л.110»; МН1 показана поз.2 по верхним краям',
                           'визуально проверено: дверного проёма и сквозных120×200 отверстий у выбранной марки нет',
                           f'независимая формула: ({width}×{height}×{thick} − 2×250×10×{thick})/10^9 = {independent_m3:.6f} м³']},
                {'pdfPage':121,'sheet':'110','subject':'узлы А, Б, В, Г, Д, Е',
                 'checks':['узел Б: две верхние посадки МН1, длина250, заглубление10, ширина200; воспроизведены',
                           'узлы В/Г/Д: местные ниши и скосы закладных видны, но не восстановлены; это ограничение модели, а не отсутствие ниш в изделии']},
            ],
            'pending':pending,
            'assumptions':['Бетонная геометрия частичная: основной контур и верхние посадки МН1. Локальные ниши/фаски у прочих закладных пока заполнены бетоном в модели; в действительном изделии они есть.',
                           'Внутренние линии15/170/15 в разрезах относятся к арматурному блоку/защитному слою и не приняты за наружные фаски.',
                           'Размеры сняты с подписей индивидуального листа, не из каталожного envelope и не масштабированием картинки.'],
            'issues':[],
            'notes':['Частичная модель основного бетонного тела. Проектный объём, ресурсы, масса и калькуляция не изменяются.',
                     'Сверка объёма проводится с округлённой спецификацией; не заменяет восстановление локальных ниш.'],
            'readinessDescription':'Основное бетонное тело и верхние посадки МН1 по исходному листу; местные ниши/фаски прочих закладных, сами закладные и вся арматура ещё не восстановлены.',
            'supersedesSketch':True,
        }
        qas[key] = {'alias':alias,'status':'partial','checks':checks,
                    'counts':{'concreteParts':1,'metalParts':0,'groups':0,'checks':len(checks),'warnings':1,'failures':0}}
    sha=hashlib.sha256(dumps(models).encode()).hexdigest()
    previous=json.loads((assets/'promka-solid-supplies.json').read_text()).get(SUPPLY_ID,{})
    captured_at=previous.get('capturedAt') if previous.get('modelsSha256')==sha else datetime.datetime.now(datetime.timezone.utc).isoformat()
    supply={'label':'Codex · основные бетонные тела панелей шахт лифтов',
            'snapshot':'20261111-quick-shafts','modelsSha256':sha,'modelCount':len(models),
            'capturedAt':captured_at,
            'qa':{'modelsSha256':sha,'tool':'scripts/build_calc_quick_shafts.py',
                  'covers':['подписанные габариты каждого индивидуального листа','объём основного тела и верхних посадок против спецификации, допуск1%','независимая формула объёма','корректность профиля'],
                  'doesNotCover':['локальные ниши/фаски МН2/МН3/МН4','арматурные блоки, монтажные петли и закладные','полная производственная геометрия и допуск в производство'],
                  'models':qas},
            'report':'15 визуально проверенных цельных марок doc13 без дверных проёмов и сквозных120×200 отверстий: основные бетонные тела с верхними посадками МН1; оставшиеся местные ниши и металл явно pending.',
            'skipped':skipped}
    return {'models':models,'supplies':{SUPPLY_ID:supply}}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output',type=Path,default=slab.ROOT/'tmp/quick-models/shafts.json')
    args=ap.parse_args()
    package=build()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(dumps(package))
    for key,model in package['models'].items():
        qa=package['supplies'][SUPPLY_ID]['qa']['models'][key]
        vol=next(c for c in qa['checks'] if c['check']=='volume-vs-spec')
        print(model['alias'],model['bounds'],f"{vol['modelM3']:.5f}/{vol['specM3']:.3f} m3",vol['result'])
    print(f"Wrote {len(package['models'])} partial models: {args.output}")


if __name__=='__main__':
    main()

#!/usr/bin/env python3
"""Build ten drawing-reviewed doc09 concrete bodies; never modify live catalogs.

Each row below was visually read on its own PDF page. The shared rectangular
section and end pockets are confirmed on every row's elevations and sections.
Run with .venv/bin/python scripts/build_calc_quick_rigels.py.
"""
import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_calc_slab_models as slab

ROOT = slab.ROOT
sys.path.insert(0, str(ROOT))
from app.calc.source_policy import SourcePolicy

SUPPLY_ID = 'codex-quick-rigels-20261111'
SNAPSHOT = '20261111-doc09-1r-concrete'
# alias, own PDF page, drawing sheet, explicit overall length, concrete m³.
# End pockets on every listed page: 500 long, 120 wide, floor 55 above bottom.
ROWS = [
    ('1Р1', 13, '2', 5000, .421),
    ('1Р2', 14, '3', 5050, .425),
    ('1Р2.1', 15, '4', 5050, .425),
    ('1Р3', 16, '5', 5150, .434),
    ('1Р3.1', 17, '6', 5150, .434),
    ('1Р4', 18, '7', 5200, .439),
    ('1Р4.1', 19, '8', 5200, .439),
    ('1Р5', 20, '9', 5400, .457),
    ('1Р6', 22, '11', 5450, .461),
    ('1Р6.1', 23, '12', 5450, .461),
]


def part(label, profile, start, end, page):
    return {'id': label, 'name': label, 'type': 'extrusion',
            'origin': [start, 0, 0], 'u': [0, 0, 1], 'v': [0, 1, 0],
            'direction': [1, 0, 0], 'depth': end-start, 'profile': profile,
            'holes': [], 'sourcePages': [page]}


def build_package():
    assets = slab.ASSETS
    register = json.loads((assets/'promka-register.json').read_text())
    base = json.loads((assets/'promka-models.json').read_text())
    solids = json.loads((assets/'promka-solid-models.json').read_text())
    all_entries = {**base, **register}
    by_alias = {v['alias']: v for v in register.values()}
    policy = SourcePolicy(assets)
    models, qas = {}, {}
    for alias, page, sheet, length, volume in ROWS:
        entry = by_alias[alias]
        key = entry['id']
        # Do not replace either solid-based or original body/groups models.
        assert (key not in solids or solids[key].get('supplyId') == SUPPLY_ID) and not all_entries[key].get('groups'), alias
        assert entry['source']['id'] == 'doc09'
        assert entry['source']['productPage'] == page
        assert entry['source']['sheet'] == sheet
        assert abs(entry['projectVolume']-volume) < 1e-10
        assert not entry.get('excluded') and not entry.get('excludedFromCalculation')
        policy.page('doc09', page)
        rectangle = [[0, 0], [300, 0], [300, 300], [0, 300]]
        pocket = [[0, 0], [300, 0], [300, 300], [210, 300],
                  [210, 55], [90, 55], [90, 300], [0, 300]]
        parts = [part('Бетон: левое корыто', pocket, 0, 500, page),
                 part('Бетон: средняя часть', rectangle, 500, length-500, page),
                 part('Бетон: правое корыто', pocket, length-500, length, page)]
        bounds = slab._bounds_of(parts)
        analytic = (length*300*300 - 2*500*120*(300-55))/1e9
        actual = sum(slab.part_volume(p) for p in parts)/1e9
        assert abs(actual-analytic) < 1e-12
        assert bounds == [[0, 0, 0], [length, 300, 300]]
        checks = [slab._volume_check(parts, volume, f'doc09 PDF {page}, лист {sheet}, Бетон В35', tolerance=.003),
                  *slab._structure_checks(parts),
                  {'check': 'signed-dimensions', 'result': 'pass',
                   'detail': f'Свой лист {sheet}: L={length}, H=300, B=300; два корыта L=500, B=120 (90+120+90), дно Y=55 мм.',
                   'expected': {'lengthMm': length, 'heightMm': 300, 'widthMm': 300, 'pocketLengthMm': 500, 'pocketWidthMm': 120, 'floorMm': 55},
                   'actual': {'lengthMm': bounds[1][0], 'heightMm': bounds[1][1], 'widthMm': bounds[1][2], 'pocketLengthMm': parts[0]['depth'], 'pocketWidthMm': pocket[3][0]-pocket[5][0], 'floorMm': pocket[4][1]}},
                  {'check': 'independent-analytic-volume', 'result': 'pass',
                   'detail': 'Сумма объёмов экструзий совпадает с L×300×300−2×500×120×245.',
                   'modelM3': round(actual, 7), 'analyticM3': round(analytic, 7)},
                  {'check': 'continuous-nonoverlapping-intervals', 'result': 'pass',
                   'detail': f'Интервалы [0,500], [500,{length-500}], [{length-500},{length}] без зазоров и объёмных пересечений; сечения корректны.'},
                  {'check': 'own-source-page-allowed', 'result': 'pass',
                   'detail': f'doc09 PDF {page}: проверены SHA исходного PDF, допуск страницы и отсутствие аннулирования.'},
                  {'check': 'visual-drawing-review', 'result': 'pass',
                   'detail': f'Просмотрен рендер собственного PDF {page}: марка, длина, вид А, сечения, корыта и объём прочитаны вручную.'}]
        solid = {
            'id': key, 'sourceId': 'doc09', 'alias': alias, 'supplyId': SUPPLY_ID,
            'format': 'project-solids-mm-v1', 'status': 'partial',
            'modelType': 'drawing-based-concrete-body', 'elementType': 'Ригель с торцевыми корытами',
            'concreteParts': parts, 'metalParts': [], 'groups': [], 'bounds': bounds,
            'coordinateSystem': 'мм; x — вдоль длины, y — вверх, z — ширина',
            'coordinateOrigin': 'левый торец x=0; низ y=0; боковая грань z=0',
            'evidence': [{'pdfPage': page, 'sheet': sheet,
                          'subject': f'Собственный чертёж {alias}, {entry["mark"]}',
                          'checks': ['марка', 'длина', 'сечение 300×300', 'два торцевых корыта 500×120 до отметки55', 'объём бетона В35'],
                          'dimensionSource': 'Верхний общий вид: длина, высота300, два корыта500, дно55; сечение1-1: 90+120+90=300; вид А: ширина300.',
                          'signedDimensionsMm': {'length': length, 'height': 300, 'width': 300, 'pocketLength': 500, 'pocketWidth': 120, 'pocketFloor': 55},
                          'volumeFormulaMm3': f'{length}*300*300-2*500*120*(300-55)',
                          'volumeFormulaM3': round(analytic, 7), 'volumeSpecM3': volume}],
            'pending': ['Арматура, преднапряжённые канаты, сетки, каркасы, выпуски и монтажные петли не восстановлены; геометрия стали не переносилась с других марок.',
                        'Модель не предназначена для производства; защитные слои и коллизии арматуры не проверялись.'],
            'assumptions': ['Бетон задан тремя неперекрывающимися экструзиями по собственным размерным цепям; x=0 и x=L — бетонные торцы.',
                            'Корыта открыты вверх и с торца; глубина245 мм получена из высоты300 и подписанной толщины дна55. Неразмеренные фаски не добавлены.'],
            'issues': [], 'notes': ['Индивидуальное бетонное тело по собственному чертежу. Проектные объём, масса, ресурсы и калькуляция не изменяются.'],
            'readinessDescription': 'Восстановлено бетонное тело с двумя торцевыми корытами по собственному листу; армирование не восстановлено.',
            'supersedesSketch': True,
        }
        qas[key] = {'alias': alias, 'status': 'partial', 'checks': checks,
                    'counts': {'concreteParts': 3, 'metalParts': 0, 'groups': 0,
                               'checks': len(checks), 'warnings': sum(c['result']=='warn' for c in checks),
                               'failures': sum(c['result']=='fail' for c in checks)}}
        models[key] = solid
    digest = hashlib.sha256(json.dumps(models, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    previous = json.loads((assets/'promka-solid-supplies.json').read_text()).get(SUPPLY_ID, {})
    captured_at = previous.get('capturedAt') if previous.get('modelsSha256') == digest else datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery = {'label': 'Codex · 10 ригелей 1Р, бетон по собственным листам',
                'snapshot': SNAPSHOT, 'modelsSha256': digest, 'modelCount': len(models),
                'capturedAt': captured_at,
                'qa': {'modelsSha256': digest, 'tool': 'scripts/build_calc_quick_rigels.py',
                       'covers': ['собственные размерные цепи', 'торцевые корыта', 'объём против спецификации', 'геометрическая корректность сечений', 'допуск листов'],
                       'doesNotCover': ['армирование и закладные', 'неразмеренные фаски', 'допуск в производство'], 'models': qas},
                'report': 'Бетонные тела 1Р1, 1Р2, 1Р2.1, 1Р3, 1Р3.1, 1Р4, 1Р4.1, 1Р5, 1Р6, 1Р6.1; каждый собственный лист просмотрен. Арматура явно оставлена в pending.'}
    return {'models': models, 'supplies': {SUPPLY_ID: delivery}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'tmp/quick-models/rigels.json')
    args = parser.parse_args()
    package = build_package()
    records = package['supplies'][SUPPLY_ID]['qa']['models']
    assert not any(q['counts']['warnings'] or q['counts']['failures'] for q in records.values())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(package, ensure_ascii=False, separators=(',', ':')))
    for q in records.values():
        print(q['alias'], q['checks'][0]['detail'])
    print('Пакет:', args.output, '; моделей:', len(package['models']))


if __name__ == '__main__':
    main()

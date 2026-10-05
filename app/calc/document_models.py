import json
import re
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from .paths import ASSETS_DIR
ASSETS = ASSETS_DIR
RECOVERY_ASSETS = ASSETS / 'recovery'


def configure_recovery_assets(directory):
    global RECOVERY_ASSETS
    RECOVERY_ASSETS = Path(directory)


SOURCE_FILES = ("promka-models.json", "promka-register.json", "promka-sketches.json", "promka-solid-models.json", "promka-solid-supplies.json", "promka-readings.json")
_seen = None


def refresh():
    """Каталог держится в памяти процесса; если файл каталога или чтений заменили (положили вручную, а не приёмом пакета, который сбрасывает кеш сам),
    без перезапуска сервер показывал бы старое. Вызывается на каждом обращении к рабочей области: сравнивает времена изменения файлов — это дёшево."""
    global _seen
    import os
    def mtime(name):
        try: return os.stat(ASSETS / name).st_mtime_ns
        except OSError: return 0
    signature = tuple(mtime(name) for name in SOURCE_FILES)
    if _seen is not None and signature != _seen:
        catalog.cache_clear()
    _seen = signature


@lru_cache
def catalog():
    base = ASSETS / "promka-models.json"
    if not base.exists():
        return {}  # источники ещё не поставлены на сервер (пакет отправки, app/calc/sync.py)
    result = json.loads(base.read_text())
    register = ASSETS / "promka-register.json"
    if register.exists():
        result.update(json.loads(register.read_text()))
    sketches=ASSETS/'promka-sketches.json'
    if sketches.exists():
        for key,sketch in json.loads(sketches.read_text()).items():
            if key in result:result[key]['preview3d']=sketch
    solids = ASSETS / 'promka-solid-models.json'
    supplies = ASSETS / 'promka-solid-supplies.json'
    if solids.exists() and supplies.exists():
        deliveries = json.loads(supplies.read_text())
        by_source = {'doc01':'claude-columns', 'doc04':'codex-upper-columns', 'doc05':'codex-abk-columns'}
        for key, solid in json.loads(solids.read_text()).items():
            if key not in result: continue
            if any(isinstance(p, dict) for p in solid.get('pending', [])):
                solid['pendingRecords'] = solid['pending']
                solid['pending'] = [p.get('description', str(p)) if isinstance(p, dict) else p
                                    for p in solid['pending']]
            worker = solid.get('supplyId') or by_source[solid['sourceId']]
            delivery = deliveries[worker]
            qa = delivery['qa']; records = qa.get('marks') or qa.get('results') or qa.get('models')
            solid['qa'] = records.get(key) or records[solid['alias']]
            solid['qaScope'] = {k:v for k,v in qa.items() if k not in {'marks','results','models','visualReview'}}
            solid['deliveryIssues'] = delivery.get('issues', {}).get('marks', {}).get(solid['alias'], {}).get('issues', [])
            solid['delivery'] = {'snapshot':delivery['snapshot'], 'modelsSha256':delivery['modelsSha256'],
                                 'worker':worker}
            result[key]['solidModel'] = solid
            if solid.get('supplyId') == 'codex-abk-rigels':
                # The drawing-based assembly replaces this mark's old envelope.
                result[key].pop('preview3d', None)
            limitations = qa.get('limitations') or qa.get('limits') or qa.get('doesNotCover') or []
            if isinstance(limitations, str): limitations = [limitations]
            result[key]['notes'] = [note for note in result[key].get('notes', [])
                                    if not note.startswith('3D-геометрия и пространственное расположение арматуры для этой марки ещё не восстановлены.')] + [
                'Индивидуальная 3D-модель с арматурой из поставки '+delivery['snapshot']+'. Статус: частичная. Геометрия не пересчитывает калькуляцию.',
                *solid.get('notes', []),
                *[p.get('description', str(p)) if isinstance(p, dict) else p
                  for p in solid.get('pending', [])], *limitations]
    from .readings import apply_readings
    apply_readings(result, ASSETS)    # прочитанное с листов — только в пробелы каталога (readings.py)
    return result


def model(identifier):
    if identifier and re.fullmatch(r'qwen-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', identifier):
        path=RECOVERY_ASSETS/(identifier+'.json')
        if not path.exists(): return None
        revision=json.loads(path.read_text())
        base=catalog().get(revision['baseModelId'])
        if not base or revision['id']!=identifier: return None
        entry={**base,'id':identifier,'recoveryBaseModelId':revision['baseModelId'],'solidModel':revision['solidModel'],
               'modelCompleteness':{'status':'partial'},
               'notes':[*base.get('notes',[]),*revision['solidModel']['pending']]}
        entry.pop('preview3d',None)
        return entry
    return catalog().get(identifier)


def model_readiness(entry):
    """Completion is declared after review, never inferred from a bounding box."""
    preview = entry.get('preview3d') or {}
    declared = entry.get('modelCompleteness') or {}
    if declared.get('status') == 'complete' and not declared.get('pending'):
        return {'status': 'complete', 'label': 'Полная модель',
                'description': 'Контур и состав армирования восстановлены. Упрощения и вопросы проверки указаны в исходных данных; это не допуск в производство.'}
    if entry.get('solidModel') or entry.get('groups') or preview.get('reinforcementGroups'):
        return {'status': 'partial', 'label': 'Частичная модель',
                'description': 'Армирование восстановлено частично. До завершения всех деталей модель не отмечается как полная.'}
    if preview:
        return {'status': 'envelope', 'label': 'Габаритная схема',
                'description': 'Есть внешний эскиз; полный конструктив и армирование ещё не восстановлены.'}
    return {'status': 'missing', 'label': 'Модель не построена',
            'description': 'Нет индивидуальной проектной 3D-модели.'}


def model_summary(identifier):
    entry = model(identifier)
    if not entry:
        return None
    result={**{k: v for k, v in entry.items() if k not in {"groups", "bodyPolygon", "channels", "pipes", "solidModel"}},
            "groups": [{k: v for k, v in g.items() if k != "paths"} for g in entry["groups"]]}
    if entry.get('solidModel'):
        solid = entry['solidModel']
        result['solidModel'] = {k:solid[k] for k in ['format','status','bounds','evidence','pending','delivery']}
        result['solidModel']['groups'] = [{k:v for k,v in g.items() if k != 'paths'} for g in solid['groups']]
        result['solidModel']['metalPartCount'] = len(solid.get('metalParts', []))
        result['solidModel']['qaCounts'] = solid['qa'].get('counts', {})
        vertices = []
        for part in solid['concreteParts']:
            if part['type'] == 'mesh': vertices.extend(part['vertices'])
            else:
                for x,y in part['profile']:
                    for depth in [0,part['depth']]:
                        vertices.append([part['origin'][i]+part['u'][i]*x+part['v'][i]*y+part['direction'][i]*depth for i in range(3)])
        result['solidModel']['concreteDimensions'] = [max(p[i] for p in vertices)-min(p[i] for p in vertices) for i in range(3)]
    result['modelReadiness'] = model_readiness(entry)
    if result.get('preview3d'):
        result['preview3d']={**result['preview3d'],'reinforcementGroups':[{k:v for k,v in g.items() if k!='paths'} for g in result['preview3d'].get('reinforcementGroups',[])]}
    return result


def resource_cost(identifier):
    entry = model(identifier)
    return sum((Decimal(str(r["qty"])) * Decimal(r["rate"]) for r in entry["resources"]), Decimal(0)) if entry else Decimal(0)

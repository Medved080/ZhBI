"""Evidence-backed source issues and a report covering products in the DB."""
import hashlib
import json
from collections import Counter
from .database import PROJECT_ID, audit, dumps, now
from .document_models import ASSETS

KIND_NAMES = {'drawing_conflict': 'Противоречие чертежей',
              'placement_question': 'Вопрос размещения',
              'data_quality': 'Неполные данные'}


def sync_catalog_issues(conn, path=None):
    path = path or ASSETS/'promka-discrepancies.json'
    if not path.exists(): return
    for issue in json.loads(path.read_text()):
        for model_id in issue['modelIds']:
            identifier = issue['id']+'@'+model_id
            detail = {k:v for k,v in issue.items() if k != 'modelIds'}
            digest = hashlib.sha256(dumps(detail).encode()).hexdigest()
            existing = conn.execute('SELECT content_hash,version FROM model_discrepancies WHERE id=?',(identifier,)).fetchone()
            if existing and existing['content_hash'] == digest: continue
            version = existing['version']+1 if existing else 1
            timestamp = now()
            values = (identifier,model_id,issue['id'],issue['kind'],issue['severity'],issue['title'],issue['description'],issue['recommendation'],dumps(issue['sources']),issue.get('status','open'),digest,version,timestamp,timestamp)
            conn.execute('''INSERT INTO model_discrepancies
                (id,model_id,issue_key,kind,severity,title,description,recommendation,sources_json,status,content_hash,version,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                kind=excluded.kind,severity=excluded.severity,title=excluded.title,
                description=excluded.description,recommendation=excluded.recommendation,
                sources_json=excluded.sources_json,status=excluded.status,content_hash=excluded.content_hash,
                version=excluded.version,updated_at=excluded.updated_at''',values)
            conn.execute('INSERT INTO discrepancy_versions(discrepancy_id,version,detail_json,created_at) VALUES(?,?,?,?)',(identifier,version,dumps(detail),timestamp))
            audit(conn,'system','discrepancy.source-recorded',identifier,{'version':version,'modelId':model_id})


def for_model(conn, model_id):
    if not model_id: return []
    result = []
    for row in conn.execute('SELECT * FROM model_discrepancies WHERE model_id=? ORDER BY created_at,id',(model_id,)):
        sources = [{**source,'url':f"/calc/api/document-source/{source['sourceId']}#page={source['pdfPage']}"} for source in json.loads(row['sources_json'])]
        result.append({'id':row['id'],'issueKey':row['issue_key'],'kind':row['kind'],'kindLabel':KIND_NAMES[row['kind']],
                       'severity':row['severity'],'title':row['title'],'description':row['description'],
                       'recommendation':row['recommendation'],'sources':sources,'status':row['status'],
                       'version':row['version'],'recordedAt':row['created_at'],'updatedAt':row['updated_at']})
    return result


def quality_issues(product):
    doc = product.get('documentModel')
    if not doc: return []
    source = doc['source']; source_id = source.get('id','promka-columns')
    sources = [{'sourceId':source_id,'pdfPage':source['productPage'],'label':'Лист изделия' if source.get('pageVerified',True) else 'Ведомость',
                'url':f"/calc/api/document-source/{source_id}#page={source['productPage']}"}]
    checks = []
    if doc.get('projectVolume') is None: checks.append(('volume','Проектный объём бетона не подтверждён','Сверить объём по спецификации; нулевое значение не означает отсутствие бетона.'))
    if doc.get('projectSteel') is None: checks.append(('steel','Общий расход стали не распознан','Проверить ведомость расхода стали; масса не должна определяться по объёму модели.'))
    if source.get('pageVerified') is False: checks.append(('sheet','Актуальный лист изделия не установлен','Уточнить действующий лист и изменение документации.'))
    if doc.get('kind') == 'registry':
        if not doc.get('resources'): checks.append(('resources','Ресурсные позиции стали не разобраны','Расшифровать спецификации каркасов и деталей.'))
        elif any(float(r['rate']) == 0 for r in doc['resources']): checks.append(('rates','Цена части ресурсов не задана','Заполнить производственные цены; 0 в расчёте не является подтверждённой ценой.'))
        if product['hours'] == 0: checks.append(('labour','Трудоёмкость не задана','Назначить подтверждённую норму производства.'))
        checks.append(('norms','Применимость норм этой группе не подтверждена','Нормы выведены из двух исходных колонн; проверить их применимость к этой марке.'))
    return [{'id':product['id']+':'+key,'issueKey':'quality-'+key,'kind':'data_quality','kindLabel':KIND_NAMES['data_quality'],
             'severity':'warning','title':title,'description':description,'recommendation':description,'sources':sources,
             'status':'open','recordedAt':None,'origin':'current-data-check'} for key,title,description in checks]


def project_report(conn):
    from .repository import get_product
    products, issues = [], []
    for row in conn.execute('SELECT id FROM products WHERE project_id=? ORDER BY created_at,id',(PROJECT_ID,)).fetchall():
        product = get_product(conn,row['id'])['product']; doc = product.get('documentModel') or {}
        readiness = doc.get('modelReadiness') or {'status':'missing','label':'Модель не построена'}
        problems = product.get('discrepancies',[]); quality = product['dataIssues']
        entry = {'id':product['id'],'name':product['name'],'alias':doc.get('alias',product['name']),
                 'family':doc.get('family','Колонны' if doc else 'Прочие изделия'),'modelId':product.get('documentModelId'),
                 'album':doc.get('source',{}).get('title','Без альбома'),'sourceId':doc.get('source',{}).get('id','promka-columns' if doc else ''),
                 'sourceRevision':doc.get('source',{}).get('revision',''),'productPage':doc.get('source',{}).get('productPage'),
                 'modelStatus':readiness['status'],'modelLabel':readiness['label'],'productVersion':product['version'],
                 'discrepancyCount':sum(p['status']=='open' and p['kind']!='data_quality' for p in problems),
                 'dataIssueCount':len(quality)+sum(p['kind']=='data_quality' and p['status']=='open' for p in problems),
                 'pendingModel':doc.get('solidModel',{}).get('pending',doc.get('preview3d',{}).get('pendingReinforcement',[])),
                 'limitations':doc.get('notes',[])}
        products.append(entry)
        for issue in problems+quality: issues.append({**issue,'productId':entry['id'],'productName':entry['name'],'alias':entry['alias'],
                                                    'family':entry['family'],'album':entry['album'],'sourceRevision':entry['sourceRevision']})
    counts = Counter(p['modelStatus'] for p in products)
    return {'project':{'id':PROJECT_ID,'name':'Промышленный корпус'},'generatedAt':now(),'products':products,'issues':issues,
            'summary':{'products':len(products),'fullModels':counts['complete'],'partialModels':counts['partial'],
                       'envelopes':counts['envelope'],'missingModels':counts['missing'],
                       'discrepancies':sum(i['kind']!='data_quality' and i['status']=='open' for i in issues),
                       'dataIssues':sum(i['kind']=='data_quality' and i['status']=='open' for i in issues),
                       'productsWithDiscrepancies':sum(p['discrepancyCount']>0 for p in products)},
            'limitation':'Отчёт включает все изделия текущей базы, независимо от фильтра и флажков выгрузки. Отсутствие зарегистрированных противоречий не означает, что все чертежи проверены. Неполные данные перечислены отдельно.'}

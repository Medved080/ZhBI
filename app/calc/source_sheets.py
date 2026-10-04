"""Source-linked original sheets. Render only pages associated with this product."""
import json
from pathlib import Path
from threading import Lock
from uuid import uuid4
from fastapi import HTTPException
from .document_models import ASSETS, model

_RENDER_LOCK=Lock()  # PDFium's native library is not thread safe.


def source_info(source_id):
    sources=json.loads((ASSETS/'promka-sources.json').read_text())
    if source_id=='promka-columns':
        return {**sources['doc02'],'path':ASSETS/'promka-source.pdf'}
    source=sources.get(source_id)
    if not source:raise HTTPException(404,'Исходный альбом не найден')
    return {**source,'path':ASSETS/'sources'/source['storageName']}


def sheets_for(conn,product_id,recovery=False):
    """recovery=True — комплект для чтения чертежей нейросетью: только листы самого изделия (изделие, каркас, группы, связанные виды),
    без листов-оснований готовой модели поставщика (их сотни) и без листов замечаний."""
    row=conn.execute('SELECT name,document_model_id FROM products WHERE id=?',(str(product_id),)).fetchone()
    if not row:raise HTTPException(404,'Изделие не найдено')
    from .recovery import effective_model_id
    doc=model(effective_model_id(conn,product_id,row['document_model_id']))
    if not doc:return {'productName':row['name'],'sheets':[],'unresolved':[],'note':'Для изделия пока не назначены исходные проектные листы. Прикрепите документацию в разделе «Файлы и основания».'}
    source=doc['source'];source_id=source.get('id','promka-columns');info=source_info(source_id)
    sheets={};unresolved=[]
    def add(page,title,kind,sheet=None,linked_source=None):
        sid=linked_source or source_id
        try: linked_info=source_info(sid) if sid!=source_id else info
        except HTTPException:
            unresolved.append(title);return
        if not isinstance(page,int) or not 1<=page<=linked_info['pages']:
            unresolved.append(title);return
        key=f'{sid}-p{page}'
        if key in sheets:
            if title not in sheets[key]['titles']:sheets[key]['titles'].append(title)
            return
        sheets[key]={'id':key,'sourceId':sid,'pdfPage':page,'sheet':sheet,'kind':kind,'titles':[title],'filename':linked_info['filename'],'albumUrl':f'/calc/api/document-source/{sid}#page={page}','imageUrl':f'/calc/api/products/{product_id}/source-sheets/{key}/image'}
    verified=source.get('pageVerified',True)
    if verified:add(source['productPage'],'Изделие '+doc.get('alias',row['name']),'product',source.get('sheet'))
    else:unresolved.append('Актуальный чертёж изделия: связь с листом требует проверки')
    for evidence in ([] if recovery else doc.get('solidModel', {}).get('evidence', [])):
        add(evidence['pdfPage'], evidence.get('subject', 'Основание 3D-модели'), 'component', evidence.get('sheet'))
    associated=ASSETS/'promka-associated-sheets.json'
    related=json.loads(associated.read_text()).get(doc.get('recoveryBaseModelId',doc['id']),[]) if associated.exists() else []
    for page in related:
        if page!=source['productPage']:add(page,'Связанный вид, сечения или спецификация','view')
    mounting=ASSETS/'promka-mounting-links.json'
    for linked in (json.loads(mounting.read_text()).get(doc['id'],[]) if mounting.exists() and not recovery else []):
        add(linked['pdfPage'],linked['title'],'mounting',linked.get('sheet'),linked_source=linked['sourceId'])
    if doc.get('kind')=='registry':
        if source_id=='doc10':
            add(7,'Общие сечения пустотных плит · лист 1','view',1)
            add(8,'Общие сечения и армирование плит · лист 2','view',2)
        for c in doc['components']:
            if c.get('pdfPage'):add(c['pdfPage'],c['name'],'component',c.get('sheet'))
            elif source_id=='doc14' and c.get('sheet')==6:add(12,c['name'],'component',6)
            elif c.get('sheet'):unresolved.append(c['name']+' · лист '+str(c['sheet']))
        add(source['registerPage'],'Ведомость изделий','register')
    else:
        add(source['cagePage'],'Пространственный каркас '+doc['cage'],'component')
        for g in doc['groups']:add(g['sheet']+15,g['name'],'component',g['sheet'])
    # A cited issue page is an associated source too, even when it is not in the cage specification.
    # Image access still requires a stored relation and authenticated product access.
    from .discrepancies import for_model
    for issue in ([] if recovery else for_model(conn,doc['id'])):
        for cited in issue['sources']:
            add(cited['pdfPage'],'Лист замечаний · PDF стр. '+str(cited['pdfPage']),
                'issue',linked_source=cited['sourceId'])
    note='Оригинальные листы проектной документации. Проверьте марку и изменение в штампе перед использованием.'
    if not verified:note='Актуальный лист изделия не подтверждён; открыта ведомость. Требуется уточнение документации.'
    return {'productName':row['name'],'sheets':list(sheets.values()),'unresolved':unresolved,'note':note}


def preview_path(settings,sheet):
    info=source_info(sheet['sourceId']);page_number=sheet['pdfPage']
    folder=settings.data_dir/'source-previews';folder.mkdir(parents=True,exist_ok=True)
    target=folder/(info['sha256']+f'-p{page_number}-3200.png')
    if target.exists():return target
    with _RENDER_LOCK:
        if target.exists():return target
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(info['path']) as document:
            page=document[page_number-1]
            try:
                scale=3200/max(page.get_size())
                bitmap=page.render(scale=scale)
                try:
                    image=bitmap.to_pil();temp=folder/(uuid4().hex+'.tmp')
                    try:image.save(temp,format='PNG');temp.replace(target)
                    finally:temp.unlink(missing_ok=True);image.close()
                finally:bitmap.close()
            finally:page.close()
    return target

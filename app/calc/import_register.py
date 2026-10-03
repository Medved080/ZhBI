from decimal import Decimal
from uuid import uuid4,uuid5,NAMESPACE_URL
from .database import audit,transaction
from .document_models import catalog,resource_cost
from .repository import save_product
from .schemas import ProductSave


def import_register(settings):
    """Insert source-linked KZhI assemblies once; existing calculations stay untouched."""
    from .norms import get_norms,parameters_for
    imported=[]
    with transaction(settings.database_path) as conn:
        norms=get_norms(conn)
        for doc in catalog().values():
            if doc.get('kind')!='registry':continue
            if doc['source']['id']=='doc02' and doc['alias'] in {'1КС1','2КС3'}:
                continue
            identifier=str(uuid5(NAMESPACE_URL,'calczhbi:promka:'+doc['source']['id']+':'+doc['alias']))
            if conn.execute('SELECT 1 FROM products WHERE id=? OR document_model_id=?',(identifier,doc['id'])).fetchone():continue
            name=('Колонна ' if doc['family']=='Колонны' else 'Ригель ' if doc['family']=='Ригели' else 'Плита ' if doc['family']=='Плиты' else 'Балка ' if doc['family']=='Лестничные балки' else 'Панель ' if not doc['alias'].startswith(('ПГП','ПШЛ')) else 'Плита ')+doc['alias']
            values=parameters_for(doc,norms)
            body=ProductSave.model_validate({'product':{'id':identifier,'name':name,'concreteClass':doc['concreteClass'],'volume':values['volume'],'weight':(doc['projectSteel'] or 0)/1000,'hours':values['hours'],'concreteRate':values['concreteRate'],'otherMaterials':values['otherMaterials'],'source':'project','documentModelId':doc['id']},'expectedVersion':0,'requestId':str(uuid4())})
            result=save_product(conn,body,'system',baseline_resources=values['resources'],norms_version=norms['version'],labour_rate=values['labourRate'])
            audit(conn,'system','project.registry.imported',identifier,{'source':doc['source'],'requiresReview':True})
            imported.append({'name':name,'id':identifier,'source':doc['source']['id']})
    return imported

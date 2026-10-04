from decimal import Decimal,ROUND_CEILING,ROUND_HALF_UP
import json
from copy import deepcopy
from uuid import uuid4
from pydantic import BaseModel,Field,model_validator
from .database import PROFILE,audit,dumps,now
from .document_models import catalog

D=lambda value:Decimal(str(value))


def initial_norms():
    models=catalog();a=models['1KS1-r1'];b=models['2KS3-r1']
    resources={}
    for ra,rb in zip(a['resources'],b['resources']):
        project=D(ra['projectQty'])+D(rb['projectQty']);production=D(ra['qty'])+D(rb['qty'])
        resources[ra['id']]={'name':ra['name'] if ra['id']!='mainsteel' else 'Продольная арматура А600С','unit':ra['unit'],'factor':str(production/project),'rate':ra['rate'],'projectTotal':str(project),'productionTotal':str(production)}
    return {'concreteFactor':str((D('5.7')+D('4.59'))/(D('5.53')+D('4.46'))),'hoursPerM3':str((D('20.645856')+D('19.432224'))/(D('5.7')+D('4.59'))),'labourRate':PROFILE['labourRate'],'concreteRate':PROFILE['defaultConcreteRate'],'resources':resources,'basis':[
      {'name':'Колонна 1КС1','projectVolume':'5.53','productionVolume':'5.7','hours':'20.645856','hoursPerM3':str(D('20.645856')/D('5.7'))},
      {'name':'Колонна 2КС3','projectVolume':'4.46','productionVolume':'4.59','hours':'19.432224','hoursPerM3':str(D('19.432224')/D('4.59'))}],
      'method':'Средневзвешенные нормы: сумма производственного расхода / сумма проектного расхода; труд — сумма часов / сумма производственного объёма бетона. Округления исходного Excel входят в коэффициенты.',
      'limitation':'Основание — только две колонны. Применение к другим группам является предварительной оценкой до утверждения технологом.'}


def get_norms(conn):
    row=conn.execute("SELECT * FROM production_norms WHERE id='msu-1-columns'").fetchone()
    if not row:
        params=initial_norms();conn.execute('INSERT INTO production_norms VALUES(?,?,?,?,?)',('msu-1-columns',1,dumps(params),now(),'system'))
        return {'version':1,'parameters':params}
    return {'version':row['version'],'parameters':json.loads(row['parameters_json']),'updatedAt':row['updated_at']}


class ResourceNorm(BaseModel):
    factor: Decimal=Field(ge=1,le=10,allow_inf_nan=False)


class NormsSave(BaseModel):
    """Нормы расхода и труда. Цены (бетон, труд, материалы) — в прайс-листе сервиса (prices.py), не здесь."""
    expectedVersion:int=Field(ge=1)
    concreteFactor:Decimal=Field(ge=1,le=3,allow_inf_nan=False)
    hoursPerM3:Decimal=Field(ge=0,le=1000,allow_inf_nan=False)
    resources:dict[str,ResourceNorm]


def update_norms(conn,body,actor):
    from fastapi import HTTPException
    current=get_norms(conn)
    if current['version']!=body.expectedVersion:raise HTTPException(409,'Нормы изменены другим пользователем. Обновите раздел.')
    params=deepcopy(current['parameters'])
    if set(body.resources)!=set(params['resources']):raise HTTPException(422,'Изменился состав нормативных ресурсов')
    for key in ['concreteFactor','hoursPerM3','labourRate','concreteRate']:params[key]=str(getattr(body,key))
    for key,value in body.resources.items():params['resources'][key].update(factor=str(value.factor),rate=str(value.rate))
    version=current['version']+1
    conn.execute("UPDATE production_norms SET version=?,parameters_json=?,updated_at=?,actor_id=? WHERE id='msu-1-columns'",(version,dumps(params),now(),actor))
    audit(conn,actor,'norms.updated','msu-1-columns',{'version':version,'before':current['parameters'],'after':params})
    return {'version':version,'parameters':params}


def match_resource(resource,params):
    name=resource['name'];diameter=__import__('re').search(r'Ø(\d+)',name)
    if not diameter:return None
    d=int(diameter.group(1));key=None
    if 'Вр' in name:key='wire'
    elif 'А600С' in name:key='mainsteel'
    elif d==8 and 'А500С' in name:key='steel8'
    elif d==10 and 'А240' in name:key='steel10a240'
    elif d==10 and 'А500С' in name:key='steel10a500'
    elif d==25 and 'А240' in name:key='steel25a240'
    elif d==25 and 'А500С' in name:key='steel25a500'
    return params['resources'].get(key) if key else None


def parameters_for(doc,norms,prices,volume=None,concrete_class=None,concrete_price=None):
    """Расчётные параметры изделия из каталога: объём, труд, цена бетона, ресурсы и стоимость материалов.
    norms — get_norms(); prices — параметры прайса (prices.get_prices()['parameters']); volume — объём, если он задан вручную
    (иначе проектный × коэффициент норм); concrete_class — класс бетона изделия (иначе из каталога);
    concrete_price — цена бетона, если она задана вручную (иначе из прайса по классу)."""
    from .prices import concrete_rate,material_rate
    p=norms['parameters'];project=D(doc['projectVolume'] or 0)
    if volume is None:
        volume=(project*D(p['concreteFactor'])).quantize(D('.01'),rounding=ROUND_HALF_UP) if project else D(0)
    hours=volume*D(p['hoursPerM3']);resources=[]
    for r in doc['resources']:
        norm=match_resource(r,p);qty=D(r['projectQty'])*(D(norm['factor']) if norm else D(1))
        if norm:qty=qty.quantize(D('.001'),rounding=ROUND_CEILING)
        resources.append({**r,'qty':str(qty),'rate':str(material_rate(prices,r['id'],r['rate']))})
    cost=sum((D(r['qty'])*D(r['rate']) for r in resources),D(0))
    # В исходном Excel есть припуск 1% на прочие материалы — та же расчётная база.
    rate=D(concrete_price) if concrete_price is not None else concrete_rate(prices,concrete_class or doc.get('concreteClass'));allowance=(volume*rate+cost)*D('.01')
    return {'volume':volume,'hours':hours,'concreteRate':rate,'otherMaterials':cost+allowance,'resources':resources,'labourRate':prices['labour']['rate']}


def apply_norms(conn,actor):
    """Оставлено для совместимости: изделия из КЖИ считаются от текущих норм и расценок на лету (repository.get_product),
    массового пересохранения больше нет."""
    norms=get_norms(conn)
    audit(conn,actor,'norms.applied','msu-1-columns',{'version':norms['version'],'products':0,'dynamic':True})
    return {'version':norms['version'],'products':0}

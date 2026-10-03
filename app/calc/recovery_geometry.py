"""Deterministic millimetre compiler and independent numerical candidate checks.

Checks describe detected geometry; they do not certify source interpretation.
"""
import math
from collections import Counter
from .recovery_schema import GeometryDraft


def sub(a,b): return tuple(x-y for x,y in zip(a,b))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def norm(a): return math.sqrt(dot(a,a))
def distance(a,b): return norm(sub(a,b))


def point_segment(p,a,b):
    delta=sub(b,a); length=dot(delta,delta)
    t=max(0,min(1,dot(sub(p,a),delta)/length)) if length else 0
    return distance(p,tuple(a[i]+t*delta[i] for i in range(len(a))))


def segment_distance(p1,q1,p2,q2):
    # Closest points on two finite segments, including parallel/degenerate cases.
    d1,d2,r=sub(q1,p1),sub(q2,p2),sub(p1,p2)
    a,e,f=dot(d1,d1),dot(d2,d2),dot(d2,r)
    if a<1e-12: return point_segment(p1,p2,q2)
    if e<1e-12: return point_segment(p2,p1,q1)
    b,c=dot(d1,d2),dot(d1,r); denom=a*e-b*b
    s=max(0,min(1,(b*f-c*e)/denom)) if denom>1e-12 else 0
    t=(b*s+f)/e
    if t<0: t=0;s=max(0,min(1,-c/a))
    elif t>1: t=1;s=max(0,min(1,(b-c)/a))
    return distance(tuple(p1[i]+d1[i]*s for i in range(3)),tuple(p2[i]+d2[i]*t for i in range(3)))


def inside(p,polygon):
    x,y=p; hit=False
    for a,b in zip(polygon,polygon[1:]+polygon[:1]):
        if point_segment(p,a,b)<1e-7: return True
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]: hit=not hit
    return hit


def polygon_valid(p):
    area=sum(a[0]*b[1]-a[1]*b[0] for a,b in zip(p,p[1:]+p[:1]))
    if abs(area)<1e-6 or any(distance(a,b)<1e-6 for a,b in zip(p,p[1:]+p[:1])): return False
    def orient(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    for i in range(len(p)):
        a,b=p[i],p[(i+1)%len(p)]
        for j in range(i+2,len(p)):
            if (j+1)%len(p)==i: continue
            c,d=p[j],p[(j+1)%len(p)]
            if orient(a,b,c)*orient(a,b,d)<0 and orient(c,d,a)*orient(c,d,b)<0: return False
    return True


def cover(p,part,radius):
    relative=sub(p,part['origin'])
    x,y,z=(dot(relative,part[k]) for k in ['u','v','direction'])
    profile=part['profile']; point=(x,y)
    boundary=min(point_segment(point,a,b) for a,b in zip(profile,profile[1:]+profile[:1]))
    result=min(z,part['depth']-z,boundary if inside(point,profile) else -boundary)-radius
    for hole in part['holes']:
        if hole['type']=='circle': clearance=distance(point,hole['center'])-hole['radius']-radius
        else:
            polygon=hole['points']; d=min(point_segment(point,a,b) for a,b in zip(polygon,polygon[1:]+polygon[:1]))
            clearance=(-d if inside(point,polygon) else d)-radius
        result=min(result,clearance)
    return result


def compile_draft(draft: GeometryDraft, bundle, readings, job_id):
    facts={f['id']:{**f,'sourceId':page['sourceId'],'pdfPage':page['pdfPage']} for page in readings for f in page['facts']}
    findings=[];errors=[];counts=Counter();parts=[];metals=[];groups={};bars=[]
    def sources(evidence):
        return [dict(sourceId=facts[e]['sourceId'],pdfPage=facts[e]['pdfPage'],bbox=facts[e]['bbox']) for e in evidence if e in facts]
    def problem(description,evidence=(),kind='placement_question',blocking=False):
        target=errors if blocking else findings
        target.append({'kind':kind,'description':description,'recommendation':'Сверить указанный состав и положение по исходным видам/сечениям. Не исправлять сдвигом без проектного основания.',
                       'sources':sources(evidence),'severity':'blocking' if blocking else 'warning'})
    def evidence_valid(evidence):
        return all(e in facts and facts[e]['value'] is not None for e in evidence)
    components={c.id:c for c in draft.components}
    identifiers=[c.id for c in draft.components]
    if len(set(identifiers))!=len(identifiers): problem('Повторяются идентификаторы спецификации',kind='data_quality',blocking=True)
    operation_ids=[x.id for x in [*draft.concrete,*draft.metal,*draft.bars]]
    if len(set(operation_ids))!=len(operation_ids): problem('Повторяются идентификаторы геометрии',kind='data_quality',blocking=True)
    for c in components.values():
        if not evidence_valid(c.evidence): problem(c.name+': нет распознанного основания спецификации',c.evidence,'data_quality',True)
    for item,is_metal in [(v,False) for v in draft.concrete]+[(v,True) for v in draft.metal]:
        if item.componentId not in components or not evidence_valid(item.evidence):
            problem(item.name+': неизвестная позиция или основание',item.evidence,'data_quality',True);continue
        if item.certainty=='uncertain': problem(item.name+': положение не подтверждено, объём не построен',item.evidence);continue
        basis=[item.u,item.v,item.direction]
        if any(abs(norm(axis)-1)>1e-5 for axis in basis) or any(abs(dot(basis[i],basis[j]))>1e-5 for i in range(3) for j in range(i)):
            problem(item.name+': базис должен быть ортонормированным',item.evidence,'data_quality',True);continue
        if not polygon_valid(item.profile): problem(item.name+': вырожденный/пересекающийся контур',item.evidence,'data_quality',True);continue
        hole_errors=False
        for hole in item.holes:
            hp=hole.points if hole.type=='polygon' else [
                (hole.center[0]+hole.radius*math.cos(t*math.pi/16),hole.center[1]+hole.radius*math.sin(t*math.pi/16)) for t in range(32)]
            if (hole.type=='polygon' and not polygon_valid(hp)) or not all(inside(p,item.profile) for p in hp): hole_errors=True
        if hole_errors: problem(item.name+': отверстие выходит за контур или вырождено',item.evidence,'data_quality',True);continue
        part={'type':'extrusion',**item.model_dump(exclude={'certainty','evidence','id'})}
        part['holes']=[h.model_dump(exclude_none=True) for h in item.holes]
        part['groupId']='metal-'+item.componentId
        (metals if is_metal else parts).append(part);counts[item.componentId]+=1
    if sum(b.count for b in draft.bars)>5000: problem('Более 5000 стержней в одном задании; разделите сборку',kind='data_quality',blocking=True)
    else:
        for item in draft.bars:
            if item.componentId not in components or not evidence_valid(item.evidence):
                problem(item.name+': неизвестная позиция или основание',item.evidence,'data_quality',True);continue
            if item.certainty=='uncertain': problem(item.name+': положение не подтверждено, стержни не построены',item.evidence);continue
            if any(distance(a,b)<1e-6 for a,b in zip(item.points,item.points[1:])):
                problem(item.name+': нулевой участок стержня',item.evidence,'data_quality',True);continue
            if item.count>1 and norm(item.translation)<1e-6:
                problem(item.name+': повторные стержни совпадают в пространстве',item.evidence,'data_quality',True);continue
            group=groups.setdefault(item.group,{'id':item.group,'name':item.name,'quantity':0,'unit':'шт','sheet':','.join(str(s['pdfPage']) for s in sources(item.evidence)),'paths':[]})
            length=sum(distance(a,b) for a,b in zip(item.points,item.points[1:]))
            spec=components[item.componentId]
            if spec.lengthMm and abs(length-spec.lengthMm)>max(5,.02*spec.lengthMm):
                problem(f'{item.name}: осевая длина {length:.1f} мм, спецификация {spec.lengthMm:g} мм. Учесть гибы/упрощения и проверить форму.',item.evidence)
            for n in range(item.count):
                points=[[p[i]+n*item.translation[i] for i in range(3)] for p in item.points]
                if any(abs(v)>100000 for p in points for v in p):
                    problem(item.name+': координаты массива за пределами 100 м',item.evidence,'data_quality',True);break
                path={'diameter':item.diameter,'points':points,'position':item.position,'componentId':item.componentId,'evidence':item.evidence}
                group['paths'].append(path);group['quantity']+=1;counts[item.componentId]+=1
                bars.append((path,item))
    if not parts: problem('Нет подтверждённого бетонного контура; габарит из каталога не подставлен',kind='data_quality',blocking=True)
    coverage=[]
    for c in components.values():
        actual=counts[c.id]
        coverage.append({'id':c.id,'name':c.name,'expected':c.expectedCount,'modeled':actual,'sources':sources(c.evidence)})
        if c.expectedCount is None: problem(c.name+': количество по спецификации не подтверждено',c.evidence,'data_quality')
        elif actual!=c.expectedCount: problem(f'{c.name}: показано {actual}, по спецификации {c.expectedCount}',c.evidence,'data_quality')
    outside=0;minimum_cover=None;sample_budget=100000;sampled=0
    for path,item in bars:
        bad=False
        for a,b in zip(path['points'],path['points'][1:]):
            samples=min(32,max(2,math.ceil(distance(a,b)/100)))
            for n in range(samples+1):
                if sampled>=sample_budget: break
                sampled+=1;p=[a[i]+(b[i]-a[i])*n/samples for i in range(3)]
                clearance=max((cover(p,part,path['diameter']/2) for part in parts),default=-math.inf)
                if math.isfinite(clearance): minimum_cover=clearance if minimum_cover is None else min(minimum_cover,clearance)
                if clearance<-.1: bad=True
        if bad and not item.allowOutside:
            outside+=1
            if outside<=30: problem(item.name+' поз. '+item.position+': обнаружен выход из бетона или пересечение пустоты',item.evidence)
        elif bad: problem(item.name+': выпуск/выступ требует проверки проектного основания',item.evidence)
    if sampled>=sample_budget: problem('Достигнут предел выборки защитных слоёв; проверка неполна',kind='data_quality')
    # Broad phase by X intervals; exact finite-segment distances in the narrow phase.
    boxes=[]
    for i,(path,item) in enumerate(bars):
        r=path['diameter']/2
        boxes.append(([min(p[k] for p in path['points'])-r for k in range(3)],[max(p[k] for p in path['points'])+r for k in range(3)],i))
    boxes.sort(key=lambda b:b[0][0]);active=[];contact_count=0;examples=[];comparisons=0;limited=False
    for lo,hi,index in boxes:
        active=[b for b in active if b[1][0]>=lo[0]]
        for old_lo,old_hi,other in active:
            if any(old_hi[k]<lo[k] or hi[k]<old_lo[k] for k in [1,2]): continue
            left,li=bars[index];right,ri=bars[other]
            threshold=(left['diameter']+right['diameter'])/2
            closest=math.inf
            for a,b in zip(left['points'],left['points'][1:]):
                for c,d in zip(right['points'],right['points'][1:]):
                    comparisons+=1
                    if comparisons>250000: limited=True;break
                    closest=min(closest,segment_distance(a,b,c,d))
                if limited: break
            if limited: break
            if closest<threshold-.1:
                contact_count+=1
                if len(examples)<30: examples.append({'left':index,'right':other,'positions':[li.position,ri.position],'penetrationMm':round(threshold-closest,3),'sources':sources(li.evidence+ri.evidence)})
        if limited: break
        active.append((lo,hi,index))
    if contact_count: problem(f'Обнаружено {contact_count} пар стержней с проникновением; допустимость сварных/контактных узлов не определена автоматически')
    if limited: problem('Достигнут предел проверки пар стержней; пространственная проверка неполна',kind='data_quality')
    for issue in draft.issues:
        if not evidence_valid(issue.evidence): problem('Замечание не имеет подтверждённой ссылки: '+issue.description,issue.evidence,'data_quality',True)
        else:
            # A machine claim of a source contradiction still needs independent confirmation.
            findings.append({'kind':issue.kind,'description':'Наблюдение Qwen, требует сверки: '+issue.description,
                             'recommendation':issue.recommendation,'sources':sources(issue.evidence),'severity':'warning'})
    for text in draft.pending+draft.requestedSheets+bundle.get('unresolved',[]): problem(text,kind='data_quality')
    vertices=[]
    for part in parts+metals:
        for x,y in part['profile']:
            for z in [0,part['depth']]: vertices.append([part['origin'][i]+part['u'][i]*x+part['v'][i]*y+part['direction'][i]*z for i in range(3)])
    for path,item in bars:
        for p in path['points']:
            vertices.extend([[v-path['diameter']/2 for v in p],[v+path['diameter']/2 for v in p]])
    bounds=[[min((p[k] for p in vertices),default=0) for k in range(3)],[max((p[k] for p in vertices),default=1) for k in range(3)]]
    pending=['Восстановлено локальной моделью. Требуется независимая сверка чтения чертежей и пространственной сборки.',
             'Проверки не охватывают все сопряжения металлических объёмов; гибы представлены полилиниями.',
             *draft.pending,*draft.requestedSheets,*bundle.get('unresolved',[])]
    candidate={'id':job_id,'alias':bundle['alias'],'sourceId':bundle['sourceId'],'format':'project-solids-mm-v1','status':'partial',
               'bounds':bounds,'concreteParts':parts,'metalParts':metals,'groups':list(groups.values()),'pending':pending,
               'evidence':[{'pdfPage':p['pdfPage'],'sourceId':p['sourceId'],'subject':', '.join(p['titles'])} for p in bundle['sheets']],
               'notes':['Проектные расходы и калькуляция сохранены; геометрия их не пересчитывает.']}
    qa={'publishable':not errors,'implementationErrors':errors,'findings':findings,'specCoverage':coverage,
        'outsideBars':outside,'minimumSampledCoverMm':minimum_cover,'steelPairContacts':contact_count,'contactExamples':examples,
        'checksLimited':limited or sampled>=sample_budget,'counts':{'concreteParts':len(parts),'metalParts':len(metals),'bars':len(bars)},
        'scope':'Численный контроль кандидата, без удостоверения чтения источников. Защитные слои проверены выборкой; контакты металла требуют отдельной сверки.'}
    return candidate,qa

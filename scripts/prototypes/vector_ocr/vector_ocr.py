"""Прототип: чтение векторного листа КЖИ без нейросети. Страница → штрихи → символы (кластеры связных штрихов) → распознавание цифр
по эталонам шрифта CAD (любой поворот 0/90/270) → слова-числа."""
import json, math, collections, sys
import numpy as np
from PIL import Image, ImageDraw
import pypdfium2 as pdfium, pypdfium2.raw as raw, ctypes
import os
HERE=os.path.dirname(os.path.abspath(__file__))
def segments(path,pageno):
    """Штрихи страницы в ЭКРАННЫХ координатах (с учётом /Rotate и смещения MediaBox): так текст на всех листах идёт слева направо."""
    page=pdfium.PdfDocument(path)[pageno-1]; segs=[]
    mx0,my0,mx1,my1=page.get_mediabox(); W0,H0=mx1-mx0,my1-my0; rotation=page.get_rotation()
    def disp(X,Y):
        X-=mx0;Y-=my0
        if rotation==90: return Y,W0-X
        if rotation==180: return W0-X,H0-Y
        if rotation==270: return H0-Y,X
        return X,Y
    for pi,o in enumerate(page.get_objects()):
        if o.type!=2: continue
        m=o.get_matrix(); a,b,c,d,e,f=m.a,m.b,m.c,m.d,m.e,m.f
        cur=start=None
        for i in range(raw.FPDFPath_CountSegments(o.raw)):
            sg=raw.FPDFPath_GetPathSegment(o.raw,i); x=ctypes.c_float();y=ctypes.c_float(); raw.FPDFPathSegment_GetPoint(sg,x,y)
            t=raw.FPDFPathSegment_GetType(sg); cl=raw.FPDFPathSegment_GetClose(sg)
            X,Y=disp(a*x.value+c*y.value+e,b*x.value+d*y.value+f)
            if t==2: cur=start=(X,Y)
            elif t==0 and cur is not None: segs.append((cur[0],cur[1],X,Y,pi)); cur=(X,Y)
            if cl and cur is not None and start is not None and cur!=start: segs.append((cur[0],cur[1],start[0],start[1],pi)); cur=start
    return segs
def components(segs,maxlen=40,tol=0.3):
    parent=list(range(len(segs)))
    def find(i):
        while parent[i]!=i: parent[i]=parent[parent[i]]; i=parent[i]
        return i
    cell=collections.defaultdict(list)
    ok=[i for i,s in enumerate(segs) if math.hypot(s[2]-s[0],s[3]-s[1])<=maxlen]
    for i in ok:
        s=segs[i]
        for (x,y) in ((s[0],s[1]),(s[2],s[3])):
            k=(round(x/tol),round(y/tol))
            for dx in (-1,0,1):
                for dy in (-1,0,1):
                    for j in cell.get((k[0]+dx,k[1]+dy),()):
                        a,b=find(i),find(j)
                        if a!=b: parent[a]=b
            cell[k].append(i)
    comp=collections.defaultdict(list)
    for i in ok: comp[find(i)].append(i)
    return comp
def raster(lines,H=20,W=14):
    xs=[p for l in lines for p in (l[0],l[2])]; ys=[p for l in lines for p in (l[1],l[3])]
    x0,y0,x1,y1=min(xs),min(ys),max(xs),max(ys); h=max(y1-y0,1e-6); s=(H-3)/h
    img=Image.new('L',(W*4,H*4),0); dr=ImageDraw.Draw(img)
    for a in lines: dr.line([((a[0]-x0)*s+1.5)*4,((y1-a[1])*s+1.5)*4,((a[2]-x0)*s+1.5)*4,((y1-a[3])*s+1.5)*4],fill=255,width=5)
    return np.array(img.resize((W,H),Image.LANCZOS)).astype(int)
def rot(lines,deg):
    c,s=math.cos(math.radians(deg)),math.sin(math.radians(deg))
    return [(a[0]*c-a[1]*s,a[0]*s+a[1]*c,a[2]*c-a[3]*s,a[2]*s+a[3]*c) for a in lines]
def load_protos():
    """Эталоны цифр: основной набор (гарнитура альбомов doc01…) и дополнительный (digit_protos_alt.json — вторая гарнитура, например doc14); классификатор ищет по обоим."""
    out={}
    for name in ('digit_protos.json','digit_protos_alt.json'):
        path=os.path.join(HERE,name)
        if os.path.exists(path):
            for ch,pl in json.load(open(path)).items(): out.setdefault(ch,[]).extend(np.array(p) for p in pl)
    return out
PROTOS=load_protos()
def classify(lines):
    best=(1e9,None,0)
    for rt in (0,90,270):
        r=raster(rot(lines,rt) if rt else lines)
        for ch,pl in PROTOS.items():
            for p in pl:
                d=np.abs(p-r).mean()
                if d<best[0]: best=(d,ch,rt)
    return best
def classify_all(lines):
    out={}
    for rt in (0,90,270):
        r=raster(rot(lines,rt) if rt else lines); best=(1e9,None)
        for ch,pl in PROTOS.items():
            for p in pl:
                d=np.abs(p-r).mean()
                if d<best[0]: best=(d,ch)
        out[rt]=best
    return out
def read_digits(segs,thr=17,ambiguity=3.0):
    """Символ может подходить сразу нескольким поворотам (1, 0, 8 повёрнутые на ±90° почти одинаковы): храним кандидатов, поворот
    слова решается при сборке слов."""
    comp=components(segs); out=[]
    for c,idx in comp.items():
        xs=[segs[i][0] for i in idx]+[segs[i][2] for i in idx]; ys=[segs[i][1] for i in idx]+[segs[i][3] for i in idx]
        x0,y0,x1,y1=min(xs),min(ys),max(xs),max(ys); w,h=x1-x0,y1-y0
        if not (2<=max(w,h)<=16 and min(w,h)<=14): continue
        allc=classify_all([segs[i][:4] for i in idx]); best=min(v[0] for v in allc.values())
        if best>=thr: continue
        top=min(allc,key=lambda k:allc[k][0])
        # «1» — наклонная палочка: её форма слабо различает повороты, поэтому для неё допустимы все повороты с приемлемой схожестью
        wide=allc[top][1]=='1'
        cands={rt:v for rt,v in allc.items() if v[0]<thr and (wide or v[0]<=best+ambiguity)}
        out.append({'bb':(x0,y0,x1,y1),'cands':cands,'d':best})
    return out
def chain_words(res):
    def info(r,rt):
        x0,y0,x1,y1=r['bb']; size=(y1-y0) if rt==0 else (x1-x0)
        return size,((x0+x1)/2 if rt==0 else (y0+y1)/2),(y0 if rt==0 else (x1 if rt==270 else x0))
    words=[];taken=set()
    # порядок поворотов: сначала те, где больше однозначных символов
    uniq=collections.Counter(next(iter(r['cands'])) for r in res if len(r['cands'])==1)
    for rt in sorted((0,90,270),key=lambda t:-uniq[t]):
        gs=[(info(r,rt),k) for k,r in enumerate(res) if rt in r['cands'] and k not in taken]; assigned=[False]*len(gs)
        order=sorted(range(len(gs)),key=lambda i:(gs[i][0][1] if rt!=90 else -gs[i][0][1]))
        for i in order:
            if assigned[i]: continue
            chain=[i];assigned[i]=True;cur=i
            while True:
                (sz,al,pp),_=gs[cur];nxt=None;bd=1e9
                for j in range(len(gs)):
                    if assigned[j]: continue
                    (sz2,al2,pp2),_=gs[j]; step=(al2-al) if rt in (0,270) else (al-al2)
                    if step>0 and abs(pp2-pp)<=1.3 and 0.75<=sz2/sz<=1.33 and step<=1.7*max(sz,sz2) and step<bd: nxt=j;bd=step
                if nxt is None: break
                chain.append(nxt);assigned[nxt]=True;cur=nxt
            ks=[gs[k][1] for k in chain]
            text=''.join(res[k]['cands'][rt][1] for k in ks)
            if len(ks)>=2 and set(text)<={'1'}: continue   # штриховка/засечки, а не число
            xs=[res[k]['bb'][0] for k in ks]+[res[k]['bb'][2] for k in ks]; ys=[res[k]['bb'][1] for k in ks]+[res[k]['bb'][3] for k in ks]
            if len(ks)>=2: taken.update(ks)
            words.append({'text':text,'rot':rt,'bb':(min(xs),min(ys),max(xs),max(ys)),'n':len(ks),'size':gs[chain[0]][0][0]})
    return words


STD=[1,2,2.5,4,5,10,15,20,25,40,50,75,100]
def measure(segs,words):
    """Для каждого числа-слова: засечки размерной линии слева/справа от него → интервал в pt → сверка со стандартным масштабом вида
    (допуск ±0,8 pt). Возвращает [(текст, масштаб, согласовано)]."""
    H=[];V=[];T=[]
    for x0,y0,x1,y1,pi in segs:
        L=math.hypot(x1-x0,y1-y0)
        if 3<=L<=10 and abs(abs(x1-x0)-abs(y1-y0))<0.22*L: T.append(((x0+x1)/2,(y0+y1)/2,L))
        if L<6: continue
        if abs(y1-y0)<0.05: H.append((min(x0,x1),max(x0,x1),y0))
        elif abs(x1-x0)<0.05: V.append((min(y0,y1),max(y0,y1),x0))
    def merge(items):
        items.sort(key=lambda t:(round(t[2],1),t[0]));out=[]
        for a in items:
            if out and abs(out[-1][2]-a[2])<0.06 and a[0]<=out[-1][1]+0.2: out[-1]=(out[-1][0],max(out[-1][1],a[1]),a[2])
            else: out.append(a)
        return out
    H=merge(H);V=merge(V)
    out=[]
    for w in words:
        if w['n']<2 or w['text'].startswith('0'): continue
        v=int(w['text']); x0,y0,x1,y1=w['bb']; cx,cy=(x0+x1)/2,(y0+y1)/2; best=None
        if w['rot']==0:
            for a,b,y in H:
                if a-0.5<=cx<=b+0.5 and (0.3<=y0-y<=6 or 0.3<=y-y1<=6):
                    ts=sorted(t[0] for t in T if abs(t[1]-y)<0.6 and a-1.5<=t[0]<=b+1.5)
                    left=[t for t in ts if t<=x0+0.5]; right=[t for t in ts if t>=x1-0.5]
                    if left and right and (best is None or (b-a)>best[1]): best=(min(right)-max(left),b-a)
        else:
            for a,b,x in V:
                if a-0.5<=cy<=b+0.5 and (0.3<=abs(x-x0)<=6 or 0.3<=abs(x-x1)<=6):
                    ts=sorted(t[1] for t in T if abs(t[0]-x)<0.6 and a-1.5<=t[1]<=b+1.5)
                    lo=[t for t in ts if t<=y0+0.5]; hi=[t for t in ts if t>=y1-0.5]
                    if lo and hi and (best is None or (b-a)>best[1]): best=(min(hi)-max(lo),b-a)
        if best and best[0]>0.5:
            err,scale=min((abs(best[0]-v/(s*0.3528)),s) for s in STD)
            out.append((w['text'],scale,err<=0.8,v/(best[0]*0.3528),best[0],w['bb']))
    return out

if __name__=='__main__':
    import collections
    segs=segments(sys.argv[1],int(sys.argv[2])); res=read_digits(segs); words=chain_words(res); dims=measure(segs,words)
    ok=[d for d in dims if d[2]]
    print('штрихов %d, цифр %d, чисел-слов %d'%(len(segs),len(res),sum(1 for w in words if w['n']>=2)))
    print('размеров с измеренной размерной линией: %d, согласованы с геометрией: %d'%(len(dims),len(ok)))
    print('масштабы видов:',dict(collections.Counter(d[1] for d in ok)))
    print('значения:',sorted(collections.Counter(d[0] for d in ok).items(),key=lambda t:-t[1]))

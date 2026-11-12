#!/usr/bin/env python3
"""Isolated new models of Р5/Р5.1/Р5.2/Р6/Р7 from own doc09 sheets.

Concrete with end troughs, two straight ordinary bars, documented retained
straight K7 portions, two explicitly referenced П3 lifting loops, and four
own-detail longitudinal bars of К5/К6/К7. Other
own-spec components remain pending; no foreign mesh/cage is substituted.
Shared assets and previous model packages are never written.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import Polygon, box
import build_calc_slab_models as slab
import import_calc_rebar_models as steel_gate

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "data/calc/assets"
SUPPLY_ID = "codex-next-rigels-medium-20261111"
SOURCE_SHA = "ba7abb43c562fd8476c3cab0a50c78656d6d6421f592776fba0e990e77f29d02"
# Own product/spec PDF, length, own concrete volume, own ordinary bars,
# K7 count/blank/unit mass, stirrup count, lower/upper mesh own spec masses,
# explicitly named mesh/cage suffix and actual detail pages.
SPECS = {
    "Р5":   (68,69,2340,.230,20,2300,5.67,3,2990,2.17,12,7.57,5.06,"5",110,113,6.05),
    "Р5.1": (70,71,2340,.230,20,2300,5.67,4,2990,2.17,12,7.57,5.06,"5",110,113,6.05),
    "Р5.2": (72,73,2340,.230,25,2300,8.86,4,2990,2.17,12,7.57,5.06,"5",110,113,6.05),
    "Р6":   (74,75,2840,.290,20,2800,6.91,4,3490,2.53,14,9.09,5.99,"6",111,114,6.94),
    "Р7":   (76,77,3230,.340,20,3190,7.87,4,3880,2.82,18,11.57,7.66,"7",111,114,7.63),
}
# Explicit named rows of PDF116: cageL,A,B,top blank/top kg,lower kg.
CAGE_LONG = {"5":(2320,1260,75,2330,2.07,2.06),
             "6":(2820,1760,75,2830,2.51,2.50),
             "7":(3210,2150,75,3220,2.86,2.85)}


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(dump(value).encode()).hexdigest()


def arc(center, radius, start, end):
    angles = [start + (end-start)*i/48 for i in range(49)]
    lo, hi = sorted((start,end))
    angles += [a for a in (0, math.pi/2, math.pi, 3*math.pi/2, 2*math.pi) if lo < a < hi]
    angles = sorted(set(angles), reverse=end < start)
    return [[center[0]+radius*math.cos(a), center[1]+radius*math.sin(a)] for a in angles]


def path(pid, points, diameter, material, position, pages, **extra):
    return {"id":pid, "points":[[round(x,5) for x in p] for p in points],
            "diameter":diameter, "material":material, "position":str(position),
            "sourcePages":pages, **extra}


def group(gid, name, position, count, pages, paths, **extra):
    return {"id":gid, "name":name, "designation":name, "shortLabel":name,
            "position":str(position), "quantity":count, "unit":"шт", "kind":"bar",
            "sourcePages":pages, "paths":paths, **extra}


def length(p):
    return sum(math.dist(a,b) for a,b in zip(p["points"],p["points"][1:]))


def mass(g):
    return sum(steel_gate.path_mass(p,g) for p in g["paths"])


def mass_check(g, spec, source, partial=False, tolerance=1):
    actual = mass(g)
    delta = (actual/spec-1)*100
    return {"check":"mass-vs-spec", "component":g["name"],
            "result":"warn" if partial or abs(delta)>tolerance else "pass",
            "groupIds":[g["id"]], "metalPartIndices":[],
            "modelKg":round(actual,6), "specKg":spec,
            "deviationPercent":round(delta,4), "tolerancePercent":tolerance,
            "partialCoverage":partial,
            "detail":f"{g['name']}: фактические оси {actual:.5f}кг; собственная спецификация {spec:.5f}кг ({source}); {delta:+.3f}%. "
                     + ("Концы в корытах не показаны, поэтому масса показанных прямых частей меньше массы заготовок; удлинение для совпадения не выполнялось." if partial else "Плотность обычной стали7850кг/м³; длины/радиусы не подгонялись ради массы.")}


def cover(position, designation, qty, modeled, status, pages, reason=""):
    row = {"position":str(position), "designation":designation, "quantity":qty,
           "modeledQuantity":modeled, "status":status, "sourcePages":pages}
    if reason:
        row["reason"] = reason
    return row


def concrete(length_mm, pages):
    # Both orthogonal own views: W400,H300,L; trough500×200 from each end,
    # centered z100…300 and open upwards to y55.
    full = box(0,0,400,300)
    trough = Polygon([(0,0),(400,0),(400,300),(300,300),(300,55),(100,55),(100,300),(0,300)])
    parts = slab.section_extrusions("Бетон: левое корыто500×200, дно55",trough,0,500,pages)
    parts += slab.section_extrusions("Бетон: средняя полнотелая часть400×300",full,500,length_mm-500,pages)
    parts += slab.section_extrusions("Бетон: правое корыто500×200, дно55",trough,length_mm-500,length_mm,pages)
    return parts


def lifting_loop(x, pages, pid, mirror=False):
    # Own П3 PDF108, not1П3/P4: Ø10,L960,front80,R40,overall height350;
    # side viewБ has R30 and free ends40. Radius axes remain disclosed partial.
    left = arc([x-30,60],30,math.pi,2*math.pi)
    right = arc([x-30,60],30,0,-math.pi)
    top = arc([200,340],40,math.pi,0)
    pts = [[x-60,100,160]] + [[xx,yy,160] for xx,yy in left]
    pts += [[x,yy,zz] for zz,yy in top]
    pts += [[xx,yy,240] for xx,yy in right] + [[x-60,100,240]]
    if mirror:
        pts = [[2*x-xx,yy,zz] for xx,yy,zz in pts]
    return path(pid,pts,10,"А240",2,pages,projectLength=960,
                placementVerified=False, radiusDimensionBasis="R40/R30 приняты по оси, база требует подтверждения", component="П3")


def build():
    register = json.loads((ASSETS/"promka-register.json").read_text())
    catalog_models = json.loads((ASSETS/"promka-models.json").read_text())
    existing = json.loads((ASSETS/"promka-solid-models.json").read_text())
    existing_supplies = json.loads((ASSETS/"promka-solid-supplies.json").read_text())
    assert hashlib.sha256((ASSETS/"sources/doc09.pdf").read_bytes()).hexdigest()==SOURCE_SHA
    entries = {e["alias"]:e for e in register.values()}
    models,qas = {},{}
    for alias,spec in SPECS.items():
        pg,sp,L,vol,diam,barlen,barunit,nk,blank,ku,nst,lowerkg,upperkg,suffix,lowerpage,upperpage,cagekg = spec
        entry = entries[alias]
        key = entry["id"]
        assert entry["source"]["id"]=="doc09" and entry["source"]["productPage"]==pg
        assert not entry.get("excluded") and not entry.get("excludedFromCalculation")
        assert not entry.get("groups") and not catalog_models.get(key,{}).get("groups")
        assert key not in existing or existing[key].get("supplyId")==SUPPLY_ID, f"Existing unrelated solid: {alias}"
        own = [pg,sp]
        parts = concrete(L,own)
        ordinary = group("ordinary-longitudinal",f"Поз.7:2×Ø{diam}А500С L{barlen}",7,2,own,
                         [path(f"ordinary-{i}",[[20,60,z],[L-20,60,z]],diam,"А500С",7,own,projectLength=barlen)
                          for i,z in enumerate((50,350),1)])
        strand_positions = [(77,125),(77,200),(77,275)] + ([(122,200)] if nk==4 else [])
        linear = ku/(blank/1000)
        strands = group("prestressing",f"Поз.8:К7−12,5−1770,{nk}шт",8,nk,own,
                        [path(f"k7-{i}",[[500,y,z],[L-500,y,z]],12.5,"К7-12,5-1770",8,own,
                              projectLength=blank, kgPerM=linear, wireCountPerStrand=7,
                              openStart=True,openEnd=True,finalPocketBendsModeled=False,
                              lengthBasis="Показан прямой участок между внутренними границами корыт; L спецификации — заготовка")
                         for i,(y,z) in enumerate(strand_positions,1)],
                        kgPerM=linear,wireCountPerStrand=7)
        loop_x = [700,L-700]
        loops = group("lifting-loops","Поз.2:П3,Ø10А240 L960",2,2,[pg,sp,108],
                      [lifting_loop(x,[pg,sp,108],f"p3-{i}",mirror=i==2) for i,x in enumerate(loop_x,1)])
        groups = [ordinary,strands,loops]
        cage_l,cage_a,cage_b,top_blank,top_unit,lower_unit = CAGE_LONG[suffix]
        assert cage_l==L-20 and 55+400+cage_b+cage_a+cage_b+400+55==cage_l
        cp = [pg,sp,116]
        upper_xy = [[10,255],[390,255],[515,230],[L-515,230],[L-390,255],[L-10,255]]
        cage_upper = group("cage-upper-longitudinals",f"Поз.6:К{suffix},дет.7,2верхнихØ12",6,2,cp,
                           [path(f"cage-upper-{i}",[[x,y,z] for x,y in upper_xy],12,"А500С",6,cp,
                                 detailPosition="7",projectLength=top_blank,bendRadiiModeled=False,
                                 placementVerified=False) for i,z in enumerate((40,360),1)])
        cage_lower = group("cage-lower-longitudinals",f"Поз.6:К{suffix},дет.8,2нижнихØ12",6,2,cp,
                           [path(f"cage-lower-{i}",[[10,180,z],[L-10,180,z]],12,"А500С",6,cp,
                                 detailPosition="8",projectLength=cage_l) for i,z in enumerate((40,360),1)])
        groups += [cage_upper,cage_lower]
        bounds = slab._bounds_of(parts)
        checks = [slab._volume_check(parts,vol,f"doc09 PDF{sp}, собственная спецификация",tolerance=.01),
                  *slab._structure_checks(parts)]
        expected = [L,300,400]
        actual = [bounds[1][i]-bounds[0][i] for i in range(3)]
        checks.append({"check":"signed-dimensions","result":"pass" if expected==actual else "fail",
                       "expected":expected,"actual":actual,"sourcePages":own,
                       "detail":f"Собственные подписанные L{L},H300,W400; два корыта500×200 с дном55. V={L}×400×300−2×500×200×(300−55)={sum(slab.part_volume(p) for p in parts)/1e9:.5f}м³."})
        checks.append({"check":"signed-trough-dimensions","result":"pass","sourcePages":own,
                       "expected":{"endLengthMm":500,"widthMm":200,"floorMm":55,"zMm":[100,300]},
                       "actual":{"endLengthMm":parts[0]["depth"],"widthMm":200,"floorMm":55,"zMm":[100,300]},
                       "detail":"Фасад500от обоих торцов, вид1-1 цепочка100+200+100 по ширине400, собственный фасад подписывает дно55. Сквозных отверстий и иных вырезов на собственных видах нет."})
        checks.append(mass_check(ordinary,2*barunit,f"PDF{sp},поз.7"))
        checks.append(mass_check(strands,nk*ku,f"PDF{sp},поз.8,Lзаготовки{blank}",partial=True))
        checks.append(mass_check(loops,2*.59,"PDF108:П3,Ø10А240 L960; собственная поз.2×2",tolerance=1))
        checks.append(mass_check(cage_upper,2*top_unit,f"собственныеК{suffix},PDF116:дет.7,Ø12L{top_blank},по{top_unit:g}кг"))
        checks.append(mass_check(cage_lower,2*lower_unit,f"собственныеК{suffix},PDF116:дет.8,Ø12L{cage_l},по{lower_unit:g}кг"))
        cage_expected = {"upperQuantity":2,"lowerQuantity":2,"diameterMm":12,"zMm":[40,360],
                         "upperProfileXYMm":upper_xy,"lowerYMm":180,"lowerLengthMm":cage_l,
                         "rungTopDatumMm":280,"upperEndBelowDatumMm":25,"upperMiddleBelowDatumMm":50,
                         "upperDropMm":25,"endStraightMm":380,"inclinedProjectionMm":125}
        actual_profile = [[p[0],p[1]] for p in cage_upper["paths"][0]["points"]]
        cage_actual = {"upperQuantity":len(cage_upper["paths"]),"lowerQuantity":len(cage_lower["paths"]),
                       "diameterMm":cage_upper["paths"][0]["diameter"],
                       "zMm":sorted({p["points"][0][2] for p in cage_upper["paths"]+cage_lower["paths"]}),
                       "upperProfileXYMm":actual_profile,"lowerYMm":cage_lower["paths"][0]["points"][0][1],
                       "lowerLengthMm":length(cage_lower["paths"][0]),"rungTopDatumMm":280,
                       "upperEndBelowDatumMm":280-actual_profile[0][1],
                       "upperMiddleBelowDatumMm":280-actual_profile[2][1],
                       "upperDropMm":actual_profile[0][1]-actual_profile[2][1],
                       "endStraightMm":actual_profile[1][0]-actual_profile[0][0],
                       "inclinedProjectionMm":actual_profile[2][0]-actual_profile[1][0]}
        checks.append({"check":"own-cage-longitudinal-datums-and-placement","result":"pass" if cage_expected==cage_actual else "fail",
                       "expected":cage_expected,"actual":cage_actual,"sourcePages":cp,
                       "groupIds":[cage_upper["id"],cage_lower["id"]],
                       "detail":f"СобственныеК{suffix}:только4продольныхØ12. В деталиPDF116 размер50 от верха поперечины280, поэтому середина230=280−50; концы255=280−25; низ180=255−75. Собственное3-3 подтверждает230=300−70 и глубины40/360;380/125*от торцов. Размер50 НЕ является перепадом верхнего стержня, перепад25."})
        checks.append({"check":"cage-upper-unassigned-bend-radii","result":"warn","sourcePages":cp,
                       "detail":f"К{suffix} дет.7:показаны подписанные прямые/наклонные осевые отрезки380/125*,без выдуманного радиуса гиба. Длина оси{length(cage_upper['paths'][0]):.5f}мм против собственной заготовки{top_blank}мм; радиусы/сварная деталировка остаютсяpending, масса не подгонялась."})
        expected_bar = {"quantity":2,"diameterMm":diam,"lengthMm":barlen,"xMm":[20,L-20],"yMm":60,"zMm":[50,350]}
        actual_bar = {"quantity":len(ordinary["paths"]),"diameterMm":diam,"lengthMm":length(ordinary["paths"][0]),
                      "xMm":sorted({p[0] for q in ordinary["paths"] for p in q["points"]}),
                      "yMm":ordinary["paths"][0]["points"][0][1],"zMm":sorted({q["points"][0][2] for q in ordinary["paths"]})}
        checks.append({"check":"signed-ordinary-bar-placement","result":"pass" if expected_bar==actual_bar else "fail",
                       "expected":expected_bar,"actual":actual_bar,"sourcePages":own,"groupIds":[ordinary["id"]],
                       "detail":"Собственные сечения2-2/3-3:поз.7 по2стержня, осиz50/350, y60; по собственной длинеL−40 торцевые отступы20."})
        actual_strands = [(q["points"][0][1],q["points"][0][2]) for q in strands["paths"]]
        checks.append({"check":"own-k7-count-and-cross-section","result":"pass" if actual_strands==strand_positions else "fail",
                       "expected":{"quantity":nk,"diameterMm":12.5,"yzMm":strand_positions,"retainedXMm":[500,L-500]},
                       "actual":{"quantity":len(strands["paths"]),"diameterMm":12.5,"yzMm":actual_strands,"retainedXMm":[500,L-500]},
                       "sourcePages":own,"groupIds":[strands["id"]],
                       "detail":"Собственная поз.8 прямо задаёт К7−12,5−1770. Нижние3оси:z125/200/275,y77; у4канатов добавлена осьz200,y122 (ещё45выше). В корытах все канаты требуют загиба; непоказанные траектории не добавлялись."})
        actual_crowns = [next(p[0] for p in q["points"] if p[1]==max(v[1] for v in q["points"])) for q in loops["paths"]]
        checks.append({"check":"own-p3-count-and-placement","result":"pass" if actual_crowns==loop_x else "fail",
                       "expected":{"quantity":2,"diameterMm":10,"crownXMm":loop_x},
                       "actual":{"quantity":len(loops["paths"]),"diameterMm":loops["paths"][0]["diameter"],"crownXMm":actual_crowns},
                       "sourcePages":[pg,sp,108],"groupIds":[loops["id"]],
                       "detail":"Подтверждены только собственные количество2,диаметрØ10А240 и продольные станции700/L−700 дляП3 по схеме армирования. Осевая интерпретация габаритов/радиусов и разворот крюков этойpass-проверкой не подтверждаются; см.отдельныйwarn."})
        checks.append({"check":"p3-radius-axis-and-hook-plane","result":"warn","sourcePages":[pg,sp,108],
                       "nominalAxisGeometry":{"heightMm":max(p[1] for p in loops["paths"][0]["points"])-min(p[1] for p in loops["paths"][0]["points"]),
                                              "frontWidthMm":max(p[2] for p in loops["paths"][0]["points"])-min(p[2] for p in loops["paths"][0]["points"]),
                                              "topRadiusMm":40,"lowerRadiusMm":30,
                                              "crownYMm":max(p[1] for q in loops["paths"] for p in q["points"]),
                                              "lowerHookPlane":"номинально x-y, зеркально торцам"},
                       "detail":"У П3 размерыR40/R30 и350/80 читаются, но размерная база наружная/осевая не помечена однозначно. Построенная осевая интерпретация и разворот нижних крюков — частичная геометрия; совпадение массы не считается подтверждением производственной посадки."})
        component_coverage = [
            cover(1,"С1",2,0,"pending",[pg,sp,108],"Именованная собственная С1:5Ø10 L1310+6Ø8 L830 на сетку, нижняя пара150, верх210, общаяширина350; пространственные сварные слои/привязка у торца ещё не восстановлены. Чужая1С1 не применялась."),
            cover(2,"П3",2,2,"partial",[pg,sp,108],"Количество, собственный контур и позиции700от торцов показаны; R40/R30 приняты по оси, база радиусов и пространственный разворот нижних крюков требуют проверки."),
            cover(3,"Хм1",nst,0,"pending",[pg,sp,108],"Собственные количество и цепь известны; контур210×445,R30,L1770. Не восстановлены пространственные окончания/нахлёст160; условный замкнутый хомут не подставлен."),
            cover(4,"СР"+suffix,1,0,"pending",[pg,sp,lowerpage],f"Именованная собственная нижняя сетка,1шт,{lowerkg:g}кг. Деталь просмотрена:нижняя парапроволок260,боковойшаг100; точная привязка начала и сварных слоёв не подтверждена, геометрия не скопирована с1СР."),
            cover(5,"СВ"+suffix,1,0,"pending",[pg,sp,upperpage],f"Именованная собственная верхняя сетка,1шт,{upperkg:g}кг; парапроволок240. Начало сетки/сварные слои не восстановлены; чужая1СВ не применялась."),
            cover(6,"К"+suffix,2,2,"partial",[pg,sp,116],f"У каждого из двух собственныхК{suffix} показаны только верхний/нижнийØ12 по подписанным осям40/360 и255→230/180. Поперечины12Ø10L260 на каждый каркас и сварные сдвиги не показаны; радиусы верхнего стержня не придуманы."),
            cover("6.7",f"К{suffix} дет.7:Ø12А500С L{top_blank}",2,2,"partial",cp,"Подписанные прямые и наклонные отрезки показаны; неразмеренные радиусы гибов не придуманы."),
            cover("6.8",f"К{suffix} дет.8:Ø12А500С L{cage_l}",2,2,"modeled",cp),
            cover("6.9",f"К{suffix} дет.9:Ø10А500С L260",24,0,"pending",cp,"24поперечины (12на каждый каркас) и их сварные сдвиги остаются непоказанными; чужие слои/посадка не подставлялись."),
            cover(7,f"Ø{diam}А500С L{barlen}",2,2,"modeled",own),
            cover(8,f"К7−12,5−1770 L{blank}",nk,nk,"partial",own,"Показаны только собственные прямые части между корытами; загибы и выступающие/срезаемые концы не размерены и не придуманы."),
            cover("metal","Отдельные закладные пластины/анкеры",0,0,"modeled",[sp],"Отдельных закладных пластин, анкеров закладных и труб в собственной спецификации нет. П3 — арматурная монтажная петля.")]
        pending = [{"id":f"position-{c['position']}","kind":"not-modeled" if c["modeledQuantity"]==0 else "placement-question",
                    "sourcePages":c["sourcePages"],"description":f"Поз.{c['position']} {c['designation']}: {c['reason']}"}
                   for c in component_coverage if c["status"] in ("pending","partial")]
        solid = {"id":key,"sourceId":"doc09","alias":alias,"supplyId":SUPPLY_ID,"format":"project-solids-mm-v1",
                 "status":"partial","modelType":"own-dimensioned-trough-rigel-selected-steel","elementType":"ригель с торцевыми корытами",
                 "coordinateSystem":"мм; x — длина, y — вверх, z — ширина400",
                 "coordinateOrigin":"x0 — левый бетонный торец, y0 — низ, z0 — левая грань сечения2-2",
                 "concreteParts":parts,"bounds":bounds,"groups":groups,"metalParts":[],"supersedesSketch":True,
                 "evidence":[{"pdfPage":pg,"sheet":str(pg-11),"subject":f"Собственные виды и схема армирования {alias}",
                              "checks":[f"Габариты{L}×300×400,корытá500×200,дно55", "Именованные собственные позиции,2петлиП3,поз.7 и8 по проекциям и размерным цепям"]},
                             {"pdfPage":sp,"sheet":str(sp-11),"subject":f"Собственная спецификация и сечения2-2/3-3 {alias}",
                              "checks":[f"Бетон{vol:g}м³;поз.7:2×Ø{diam}L{barlen};поз.8:{nk}К7−12,5L{blank}","Расположение поз.7:z50/350,y60;К7:z125/200/275,y77;при4канатах ещёz200,y122"]},
                             {"pdfPage":116,"sheet":"105","subject":f"Собственные именованныеК{suffix}:выбраны только дет.7/8 продольныеØ12",
                              "checks":[f"2дет.7L{top_blank},по{top_unit:g}кг;2дет.8L{cage_l},по{lower_unit:g}кг", "Датум верха поперечин280:верх255/230,низ180;поперечинынепоказаны", "Собственные2-2/3-3:глубины40/360;концевые380,наклонные125* без выдуманногоR"]},
                             {"pdfPage":108,"sheet":"97","subject":"ИменованныеС1/Хм1/П3 — детали нового семействаР,не1Р",
                              "checks":["П3:Ø10А240L960,2петли по собственной позиции2;H350,R40/R30,междуветвями80,свободные40", "С1/Хм1 не заимствованы из1Р:С1нижняяпара150,Хм1ширина210 — полностьюpending"]}],
                 "sourcePolicy":{"mode":"own-product-and-explicit-named-component-references","sourceId":"doc09","sha256":SOURCE_SHA,
                                 "productPages":own,"componentPages":[108,116],"restriction":"Моделируются собственные поз.2,7,8 и4продольныхКпоз.6; С1/СР/СВ/поперечиныК/Хм1 не заменяются профилями другого семейства."},
                 "pending":pending,"assumptions":[{"id":"cage-upper-reference-bends","affects":[cage_upper["id"]],
                                                      "text":"ВерхниеК показаны по подписанным380/125*,датумам280−25=255 и280−50=230; радиус гиба не задан и не придуман. ПоперечиныК и сварные сдвиги остаютсяpending."},
                                                     {"id":"p3-axis-radius-and-hook-direction","affects":["lifting-loops"],
                                                      "text":"R40/R30 П3 приняты по оси, нижние крюки в плоскостях x-y зеркально торцам по видуБ. Окончательная база радиусов и пространственная посадка крюков требуют проверки. Геометрическая длина/масса не подгонялась."},
                                                     {"id":"concrete-detail-limit","affects":["concrete"],
                                                      "text":"Бетон по собственным размеренным ортогональным видам, с обоими открытыми корытами. Неразмеренные мелкие фаски/скругления не придуманы; модель не задаёт производственные допуски."}],
                 "issues":[],"notes":["Новая частичная модель по собственным листам: бетон с реальными корытами,2прямых поз.7,прямые участкиК7,2П3 и4продольныхØ12 собственногоК.",
                                       "СеткиС1/СР/СВ,поперечиныК иХм1 ожидают восстановления; концыК7,радиусы верхнихК и радиусы/посадкаП3 не объявлены полностью подтверждёнными. Проектные объём,массы и расчётные ресурсы не изменяются."],
                 "readinessDescription":"Бетон и собственные прямые стержни подтверждены; показаны прямые частиК7,2монтажныеП3 и4продольных собственногоК по осям40/360 и255→230/180. ПоперечиныК и остальная сталь по позициям остаютсяpending. Производственная готовность не заявляется."}
        paths = [p for g in groups for p in g["paths"]]
        checks.append({"check":"nonzero-finite-steel-paths","result":"pass" if all(length(p)>0 for p in paths) else "fail",
                       "detail":f"{len(paths)} путей, каждый положительной длины; фактические массы всех групп покрыты независимыми scope-проверками."})
        qa = {"alias":alias,"status":"partial","checks":checks,"componentCoverage":component_coverage,
              "counts":{"concreteParts":len(parts),"metalParts":0,"groups":len(groups),"paths":len(paths),"checks":len(checks),
                        "warnings":sum(c["result"]=="warn" for c in checks),"failures":sum(c["result"]=="fail" for c in checks)}}
        assert not qa["counts"]["failures"],(alias,checks)
        assert checks[0]["result"]=="pass",(alias,checks[0])
        steel_gate.verify_mass_scopes(solid,qa)
        steel_gate.steel_totals(solid)
        if key in existing:
            assert existing[key]==solid, f"Installed model diverged:{alias}"
        models[key],qas[key]=solid,qa
    sha=digest(models)
    old=existing_supplies.get(SUPPLY_ID,{})
    output_path=ROOT/"tmp/next-rigels/medium.json"
    prior_output=json.loads(output_path.read_text()).get("supplies",{}).get(SUPPLY_ID,{}) if output_path.exists() else {}
    if old.get("modelsSha256")==sha:
        captured=old["capturedAt"]
    elif prior_output.get("modelsSha256")==sha:
        captured=prior_output["capturedAt"]
    else:
        captured=datetime.datetime.now(datetime.timezone.utc).isoformat()
    delivery={"label":"Codex · Р5–Р7:бетон,прямые стержни,К7 иП3","snapshot":"20261111-next-rigels-medium",
              "modelsSha256":sha,"modelCount":len(models),"capturedAt":captured,
              "qa":{"modelsSha256":sha,"tool":"scripts/build_calc_next_rigels_medium.py","models":qas,
                    "covers":["собственные виды/корытá/габариты и объём", "собственные диаметры/количества/размещение поз.7 иК7", "4продольных собственногоК,датумы280−25/280−50 и глубины40/360", "собственныеП3 вместо другого профиля", "массовый scope каждого фактического пути", "остаток каждой позиции вcomponentCoverage"],
                    "doesNotCover":["сетки,поперечиныК иХм1", "загибыК7,радиусы верхнихК и окончательные радиусы/посадкаП3", "производственная готовность"]},
              "report":"5новых моделейР5/Р5.1/Р5.2/Р6/Р7. Бетон с обоими корытами,собственнаяпоз.7,К7 только между корытами,2монтажныеП3 и4продольных собственногоК5/6/7 по осям40/360 и255→230/180. ПоперечиныК,сетки иХм1pending,металлическихзакладныхвсобственныхspecнет."}
    return {"models":models,"supplies":{SUPPLY_ID:delivery}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=ROOT/"tmp/next-rigels/medium.json")
    args=parser.parse_args();package=build();args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(dump(package))
    for qa in package["supplies"][SUPPLY_ID]["qa"]["models"].values():
        print(qa["alias"],qa["counts"],[(c["component"],c["modelKg"],c["specKg"],c["result"]) for c in qa["checks"] if c["check"]=="mass-vs-spec"])
    print("Wrote",args.output)


if __name__=="__main__":
    main()

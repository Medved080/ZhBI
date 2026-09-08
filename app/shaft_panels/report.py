"""Self-contained, offline, interactive recognition evidence. No external JS."""
from html import escape
import json
from pathlib import Path

COLORS=['#116b8a','#477bbb','#26887b','#78964d','#a75549','#b48243','#874f91','#bc6885']


def elevation_svg(data):
    panels=data['panels'];xs=[v for p in panels for v in (p['bounds'][0],p['bounds'][2])]
    ys=[v for p in panels for v in (p['bounds'][1],p['bounds'][3])]
    left,right,bottom,top=min(xs),max(xs),min(ys),max(ys)
    # Число панелей на этой картинке — уже СХЛОПНУТОЕ (см.
    # _merge_shared_wall в parser.py, живой запрос 2026-09-08): сторона Д
    # (ГП2) сюда не попадает вовсе, её панели — те же, что у стороны В
    # (ГП1), просто на другой развёртке.
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left-600} {-top-1400} {right-left+1200} {top-bottom+2400}" role="img" aria-label="{len(panels)} панелей на развертках">']
    for face in data['faces']:
        x=(face['sheet_u0']+face['sheet_u1'])/2
        parts.append(f'<text x="{x}" y="{-top-400}" text-anchor="middle" font-size="650">{face["shaft"]} / {face["face"]}</text>')
    for p in panels:
        x0,y0,x1,y1=p['bounds'];color=COLORS['АБВГДЕЖИ'.index(p['face'])]
        title=escape(f"{p['handle']} · {p['mark']} · {p['shaft']}/{p['face']} · {p['width_mm']} × {p['height_mm']} мм")
        parts.append(f'<g data-key="{p["physical_key"]}" tabindex="0"><title>{title}</title><rect x="{x0}" y="{-y1}" width="{x1-x0}" height="{y1-y0}" fill="{color}" fill-opacity=".25" stroke="{color}" stroke-width="20"/>')
        if x1-x0>700:
            parts.append(f'<text x="{(x0+x1)/2}" y="{-(y0+y1)/2}" text-anchor="middle" dominant-baseline="central" font-size="280">{escape(p["mark"])}</text>')
        parts.append('</g>')
    parts.append('</svg>')
    return ''.join(parts)


def model_svg(data):
    pts=[v for p in data['panels'] for v in p['front_xyz_mm']]
    cx=sum(p[0] for p in pts)/len(pts);cy=sum(p[1] for p in pts)/len(pts)
    def project(p):
        x,y,z=p[0]-cx,p[1]-cy,p[2]
        return ((x-y)*.866, (x+y)*.5-z)
    proj=[project(p) for p in pts];lo=min(p[0] for p in proj);hi=max(p[0] for p in proj)
    bottom=min(p[1] for p in proj);top=max(p[1] for p in proj)
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{lo-500} {bottom-500} {hi-lo+1000} {top-bottom+1000}" role="img" aria-label="Лицевые поверхности панелей шахт в модели">']
    for p in sorted(data['panels'],key=lambda p:sum(v[0]+v[1] for v in p['front_xyz_mm'])):
        points=' '.join(f'{x},{y}' for x,y in map(project,p['front_xyz_mm']))
        color=COLORS['АБВГДЕЖИ'.index(p['face'])]
        parts.append(f'<polygon data-key="{p["physical_key"]}" tabindex="0" points="{points}" fill="{color}" fill-opacity=".3" stroke="{color}" stroke-width="14"><title>{escape(p["mark"]+" · "+p["address"])}</title></polygon>')
    parts.append('</svg>');return ''.join(parts)


def write_report(data,folder):
    folder=Path(folder);ev=elevation_svg(data);model=model_svg(data)
    (folder/'recognized.svg').write_text(ev,encoding='utf-8')
    (folder/'model.svg').write_text(model,encoding='utf-8')
    warnings=''.join(f'<li>{escape(w["message"])}</li>' for w in data['warnings'])
    records=''.join(f'<tr data-key="{p["physical_key"]}"><td>{escape(p["handle"])}</td><td>{escape(p["mark"])}</td><td>{p["shaft"]}/{p["face"]}</td><td>{p["width_mm"]:g} × {p["height_mm"]:g}</td><td>{p["z"]/1000:+.3f}</td></tr>' for p in data['panels'])
    payload=json.dumps(data['panels'],ensure_ascii=False).replace('<','\\u003c')
    page='''<!doctype html><html lang="ru"><meta charset="utf-8"><title>Панели шахт — проверка DXF</title>
<style>body{font:15px system-ui;margin:28px;background:#f4f6f8;color:#203247}h1{font-size:28px}h2{font-size:18px}small{color:#536478}.grid{display:grid;grid-template-columns:2fr 1fr;gap:18px}.card{background:white;border:1px solid #dce3e9;border-radius:12px;padding:16px}svg{width:100%;max-height:740px}svg [data-key]{cursor:pointer}svg .selected{stroke:#eb6900;stroke-width:70;fill-opacity:.9}g.selected rect{stroke:#eb6900;stroke-width:70}table{border-collapse:collapse;width:100%}td,th{padding:7px;border-bottom:1px solid #e3e8ed;text-align:left}tr[data-key]{cursor:pointer}tr.selected{background:#ffdfaf}.scroll{overflow:auto;max-height:390px}input{padding:9px;font:inherit;width:250px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace}li{margin:6px 0}@media(max-width:800px){.grid{grid-template-columns:1fr}body{margin:10px}}</style>
<h1>Панели облицовки лифтовых шахт</h1><p>ГП1 + ГП2 · PANEL_COUNT изделий · MARK_COUNT марок · оси 5–7 / Е–Ж</p>
<small>FRAME · Нажмите на панель или строку таблицы: соответствующий элемент выделится на обоих видах. Справа показаны поверхности без выдуманной толщины.</small>
<div class="grid"><section class="card"><h2>Распознанные развертки</h2>ELEVATION</section><section class="card"><h2>Расположение на шахтах</h2>MODEL</section></div>
<div class="grid" style="margin-top:18px"><section class="card"><h2>Поштучная ведомость</h2><input id="filter" placeholder="Марка, сторона или handle"><div class="scroll"><table><thead><tr><th>Handle</th><th>Марка</th><th>Сторона</th><th>Ш × В, мм</th><th>Z низа, м</th></tr></thead><tbody>ROWS</tbody></table></div></section><section class="card"><h2>Выбранная панель</h2><pre id="detail">Выберите панель</pre></section></div>
<section class="card" style="margin-top:18px"><h2>Замечания и границы точности</h2><ul>WARNINGS</ul><p>А–И — стороны шахт. Координационные оси здания извлечены из атрибутов А1 блоков INSERT. Контуры плана (13) не посчитаны вторично. Объем, масса и этаж не выведены из неподтвержденных данных.</p></section>
<script>const panels=PAYLOAD;const lookup=new Map(panels.map(p=>[p.physical_key,p]));function select(k){document.querySelectorAll('[data-key]').forEach(n=>n.classList.toggle('selected',n.dataset.key===k));const p=lookup.get(k);document.getElementById('detail').textContent=JSON.stringify({марка:p.mark,шахта:p.shaft,сторона:p.face,адрес:p.address,ширина_мм:p.width_mm,высота_мм:p.height_mm,толщина_мм:p.thickness_mm,площадь_м2:p.area_m2,источник_контура:p.handle,источник_марки:p.mark_handle,способ:p.mark_method,расстояние_марки_мм:p.mark_distance_mm,лицевая_поверхность_XYZ:p.front_xyz_mm},null,2)}document.querySelectorAll('[data-key]').forEach(n=>{n.addEventListener('click',()=>select(n.dataset.key));n.addEventListener('keydown',e=>{if(e.key==='Enter')select(n.dataset.key)})});document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(q))});select(panels[0].physical_key);</script></html>'''
    page=page.replace('PANEL_COUNT',str(len(data['panels']))).replace('MARK_COUNT',str(len(data['counts']['by_mark'])))
    page=page.replace('FRAME',escape(data.get('coordinate_frame','Сетка объекта'))).replace('ELEVATION',ev).replace('MODEL',model).replace('ROWS',records).replace('WARNINGS',warnings).replace('PAYLOAD',payload)
    (folder/'report.html').write_text(page,encoding='utf-8')

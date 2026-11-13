import { esc } from './screen-view.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const titleRule = (r) => `${r.element_type === '*' ? 'Все типы' : r.element_type} / ${r.subtype === '*' ? 'Все подтипы' : r.subtype || 'Без подтипа'}`;

export function mountWorkGroups(host, { api, objectId, canEdit, initialIds = [], onSaved = () => {} }) {
  let dead = false, busy = false, data = null, elements = [], editing = null, templateMode = false;
  let selectedGroup = '', selected = new Set(initialIds), draft = null, drawing = false, preview = null, action = null;
  let message = '', history = null, view = null, rect = null, drag = null;
  host.classList.add('wg-root');
  if (!document.getElementById('wg-style')) {
    const style = document.createElement('style'); style.id = 'wg-style';
    style.textContent = `.wg-root{min-width:0}.wg-root .wg-bar{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:12px 0}.wg-root label{display:flex;flex-direction:column;gap:5px}.wg-root input,.wg-root select,.wg-root .v2-btn{height:38px;font:inherit;line-height:1.2;padding:6px 9px;box-sizing:border-box;max-width:100%}.wg-root input:not([type=number]){width:320px}.wg-root input[type=number]{width:160px}.wg-root select{min-width:190px}.wg-root table{border-collapse:collapse;width:100%;margin:14px 0}.wg-root th,.wg-root td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid var(--line,#ccc)}.wg-root .wg-map{width:100%;height:520px;border:1px solid #999;background:#f4f6f8;touch-action:none}.wg-root .wg-panel{border:1px solid var(--line,#aaa);border-radius:8px;padding:16px;margin:14px 0}.wg-root .wg-actions{display:flex;gap:8px;flex-wrap:wrap}.wg-root .wg-rules{display:grid;gap:8px}.wg-root .wg-rule{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}.wg-root .wg-note{white-space:pre-wrap}.wg-dialog{position:fixed;inset:3vh 3vw;max-width:1500px;max-height:94vh;width:auto;height:auto;box-sizing:border-box;padding:20px;overflow:auto;border:1px solid #aaa;border-radius:10px;background:var(--surface,#fff);color:var(--text,#222)}.wg-dialog::backdrop{background:#0007}.wg-root .wg-status:empty{display:none}.wg-root button:disabled{opacity:.5}.wg-root .wg-table-wrap{overflow:auto}`;
    document.head.append(style);
  }
  const $ = (q) => host.querySelector(q);
  const groupName = (id) => data?.groups.find(g => g.id === Number(id))?.name || '—';
  const btn = (id, text, disabled = false) => `<button type="button" class="v2-btn" data-wg="${id}" ${disabled || busy ? 'disabled' : ''}>${text}</button>`;
  const visible = () => elements.filter(e => !selectedGroup || e.work_group_id === Number(selectedGroup));

  async function run(fn) {
    if (busy || dead) return;
    busy = true; message = '';
    host.querySelectorAll('button,input,select').forEach(e => { e.disabled = true; });
    try { await fn(); } catch (e) { message = e.message || String(e); }
    finally { busy = false; if (!dead) render(); }
  }
  async function load() {
    const result = await api.get(`/work-groups/${objectId}`);
    if (dead) return;
    data = result;
    let model;
    try {
      model = await (api.readPost || api.post)('/plan-data', { selection: [{ object_id: objectId }] });
    } catch (error) {
      if (error.status === 404 && data.groups.every(g => !g.elements)) model = {elements:[]};
      else throw error;
    }
    if (dead) return;
    elements = model.elements || [];
    if (selectedGroup && !data.groups.some(g => g.id === Number(selectedGroup))) selectedGroup = '';
    if (!view) {
      const xs = elements.map(e => e.x), ys = elements.map(e => e.y);
      const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 10000;
      const minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 10000;
      view = [minX - 2000, -maxY - 2000, Math.max(maxX-minX+4000, 10000), Math.max(maxY-minY+4000, 10000)];
    }
  }
  function invalidate() { preview = null; action = null; }
  async function prepare(payload) {
    invalidate();
    const result = await api.post(`/work-groups/${objectId}/action`, { ...payload, preview: true });
    if (dead) return;
    preview = result; action = payload;
  }
  async function apply() {
    if (!preview || preview.conflicts?.length) return;
    await api.post(`/work-groups/${objectId}/action`, { ...action, expected_hash: preview.expected_hash });
    invalidate(); editing = null; draft = null; drawing = false; history = null;
    await load(); onSaved(); message = 'Изменения применены';
  }
  function groupOptions(value) {
    return data.groups.map(g => `<option value="${g.id}" ${Number(value) === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  }
  function options(values, value) {
    return values.map(([v,t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('');
  }
  function renderEditor() {
    if (!editing) return '';
    return `<section class="wg-panel"><h3>${templateMode ? 'Общий шаблон ЖБИ' : 'Группы объекта'}</h3>
      ${editing.map((g,i) => `<div class="wg-panel" data-group-index="${i}"><div class="wg-bar"><label>Название<input data-name="${i}" value="${esc(g.name)}" maxlength="150"></label>${g.key !== 'zhbi' ? btn(`remove-group-${i}`, 'Удалить группу') : ''}</div>
      <div class="wg-rules">${g.rules.map((r,j) => {
        const types = [['*','Все типы'], ...(templateMode ? data.template_types || data.types : data.types).map(t => [t,t])];
        if (!types.some(([t]) => t === r.element_type)) types.push([r.element_type,r.element_type]);
        const catalog = templateMode ? data.template_subtypes || data.subtypes : data.subtypes;
        const subtypeValues = r.element_type === '*' ? [...new Set(Object.values(catalog).flat())] : catalog[r.element_type] || [];
        const subs = [['*','Все подтипы'],['','Без подтипа'], ...subtypeValues.filter(Boolean).map(s => [s,s])];
        if (!subs.some(([s]) => s === r.subtype)) subs.push([r.subtype,r.subtype]);
        return `<div class="wg-rule"><label>Тип<select data-type="${i}:${j}">${options(types,r.element_type)}</select></label><label>Подтип<select data-subtype="${i}:${j}">${options(subs,r.subtype)}</select></label>${btn(`remove-rule-${i}-${j}`,'Убрать',g.key==='zhbi' && r.element_type==='*' && r.subtype==='*')}</div>`;
      }).join('')}</div><div class="wg-bar">${btn(`add-rule-${i}`,'Добавить тип и подтип')}</div></div>`).join('')}
      <div class="wg-actions">${btn('add-group','Добавить группу')}${btn('save-groups',templateMode ? 'Сохранить шаблон' : 'Предпросмотр изменений')}${btn('cancel-edit','Закрыть')}</div></section>`;
  }
  function renderDraft() {
    if (!draft) return '';
    const level = draft.levels?.[0] || {elevation_mm:draft.lower,upper_elevation_mm:draft.upper};
    return `<section class="wg-panel"><h3>${draft.id ? 'Изменить захватку' : 'Новая захватка'}</h3><div class="wg-bar">
      <label>Группа<select id="wg-draft-group" ${draft.id ? 'disabled' : ''}>${groupOptions(draft.work_group_id)}</select></label>
      <label>Название<input id="wg-draft-name" value="${esc(draft.name || '')}" maxlength="150"></label>
      <label>Номер<input id="wg-draft-number" type="number" step="1" value="${draft.number ?? ''}"></label>
      <label>Этаж<input id="wg-draft-floor" type="number" step="1" value="${draft.capture_floor ?? ''}"></label>
      <label>Нижняя отметка, мм<input id="wg-draft-low" type="number" value="${level.elevation_mm ?? ''}"></label>
      <label>Верхняя отметка, мм<input id="wg-draft-high" type="number" value="${level.upper_elevation_mm ?? ''}"></label>
      ${draft.id ? `<label>Состояние<select id="wg-draft-current"><option value="1" ${draft.is_current ? 'selected' : ''}>Действующая</option><option value="0" ${!draft.is_current ? 'selected' : ''}>Архивная</option></select></label>` : ''}</div>
      <p>${drawing ? 'Нажимайте на плане, чтобы добавить вершины. Для завершения нажмите «Завершить контур».' : draft.levels.length ? `В контуре ${draft.levels[0].outline.length} вершин` : 'Без контура — изделия назначаются выделением в модели.'} ${draft.levels.length > 1 ? 'В захватке несколько ярусов. Перерисовка заменит их одним контуром.' : ''}</p>
      <p class="v2-muted">Пустые границы — вся высота. Нижняя отметка включается, верхняя относится к следующему диапазону.</p>
      <div class="wg-actions">${btn('draw',drawing ? 'Завершить контур' : 'Нарисовать контур')}${btn('undo-point','Убрать вершину',!drawing)}${btn('clear-contour','Убрать контур')}${btn('preview-zone','Предпросмотр сохранения',drawing)}${btn('cancel-zone','Закрыть')}</div></section>`;
  }
  function renderPreview() {
    if (!preview) return '';
    if (preview.conflicts?.length) return `<section class="wg-panel"><h3>Изменения шаблона и объекта</h3>${preview.conflicts.map(c => `<label>${esc(c.local?.name || c.template?.name || c.key)}<select data-choice="${esc(c.key)}"><option value="">Выберите вариант</option><option value="local">Сохранить настройки объекта</option><option value="template">Применить шаблон</option></select></label><p>Объект — ${esc(c.local?.rules.map(titleRule).join(', ') || 'группа удалена')}. Шаблон — ${esc(c.template?.rules.map(titleRule).join(', ') || 'группа удалена')}.</p>`).join('')}${btn('resolve','Пересчитать предпросмотр')}</section>`;
    return `<section class="wg-panel" role="status"><h3>Предпросмотр</h3><p>Изменятся назначения ${preview.changed} изделий. Затронуто ручных назначений ${preview.manual_affected}.</p>
      <ul>${preview.summary.map(s => `<li>${esc(groupName(s.group_id))} — ${esc({matched:'Назначена захватка',unmatched:'Без захватки',needs_review:'Требует проверки',not_applicable:'Отметка не определена'}[s.status] || s.status)} — ${s.count}</li>`).join('')}</ul>
      <details><summary>Изделия и назначения</summary><div class="wg-table-wrap"><table><thead><tr><th>ID</th><th>Прежняя захватка</th><th>Новая захватка</th></tr></thead><tbody>${preview.changes.slice(0,300).map(c => `<tr><td>${c.id}</td><td>${esc(data.zones.find(z=>z.id===c.before.zone_zakhvatka_id)?.name || 'Без захватки')}</td><td>${esc(data.zones.find(z=>z.id===c.after.zone_zakhvatka_id)?.name || (c.after.zone_zakhvatka_id ? action.zone?.name || 'Новая захватка' : 'Без захватки'))}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="wg-actions">${btn('apply','Применить')}${btn('cancel-preview','Отменить')}</div></section>`;
  }
  function render() {
    if (dead) return;
    if (!data || !view) { host.innerHTML = `<p role="status">${esc(message || 'Загрузка групп работ…')}</p>${btn('reload','Повторить')}`; wire(); return; }
    host.innerHTML = `<p class="wg-status wg-note" role="status">${esc(message || '')}</p>
      <div class="wg-bar">${btn('reload','Обновить')}${canEdit ? btn('edit-groups','Настроить группы объекта')+btn('template-apply','Применить общий шаблон') : ''}${data.can_edit_template ? btn('edit-template','Настроить общий шаблон') : ''}${btn('history','История назначений')}</div>
      <div class="wg-table-wrap"><table><thead><tr><th>Группа работ</th><th>Типы и подтипы</th><th>Изделий</th><th>Без захватки</th><th>Захваток</th></tr></thead><tbody>${data.groups.map(g=>`<tr><td><button type="button" class="v2-link" data-wg="show-group-${g.id}">${esc(g.name)}</button></td><td>${esc(g.rules.map(titleRule).join(', '))}</td><td>${g.elements}</td><td>${g.unassigned}</td><td>${g.captures}</td></tr>`).join('')}</tbody></table></div>
      <p class="v2-muted">Шаблон объекта ${data.applied_revision}. Текущая версия общего шаблона ${data.template.revision}.</p>
      ${renderEditor()}
      <div class="wg-bar"><label>Группа работ<select id="wg-group"><option value="">Все группы</option>${groupOptions(selectedGroup)}</select></label><label>Назначить захватку<select id="wg-target"><option value="">Выберите захватку</option>${data.zones.filter(z=>z.is_current && (!selectedGroup || z.work_group_id===Number(selectedGroup))).map(z=>`<option value="${z.id}">${esc(groupName(z.work_group_id)+' / '+z.name)}</option>`).join('')}</select></label>
        ${canEdit ? btn('new-zone','Создать захватку')+btn('assign',`Назначить выделенным (${selected.size})`,!selected.size)+btn('auto','Вернуть назначение по контуру',!selected.size) : ''}${btn('clear-selection','Снять выделение',!selected.size)}${btn('fit','Вписать')}</div>
      ${renderDraft()}
      <p class="v2-muted">Щелчок — выделение изделия. Shift и протяжка — выделение рамкой. Колесо — масштаб. Протяжка по фону — перемещение плана.</p>
      <svg class="wg-map" role="img" aria-label="План изделий и захваток" viewBox="${(view || [0,0,10000,10000]).join(' ')}"></svg>
      <div class="wg-table-wrap"><table><thead><tr><th>Группа</th><th>Захватка</th><th>Контур</th><th>Состояние</th><th></th></tr></thead><tbody>${data.zones.filter(z=>!selectedGroup || z.work_group_id===Number(selectedGroup)).map(z=>`<tr><td>${esc(groupName(z.work_group_id))}</td><td>${esc(z.name)}</td><td>${z.levels.length ? z.levels.length+' ярус(а)' : 'Ручное назначение'}</td><td>${z.is_current ? 'Действующая' : 'Архивная'}</td><td>${canEdit ? btn('zone-'+z.id,'Изменить') : ''}</td></tr>`).join('')}</tbody></table></div>
      ${renderPreview()}
      ${history ? `<details open><summary>История назначений</summary><div class="wg-table-wrap"><table><thead><tr><th>Время</th><th>Изделие</th><th>Изменение</th><th>Автор</th><th></th></tr></thead><tbody>${history.map(h=>`<tr><td>${esc(h.created_at)}</td><td>${h.element_id ?? 'Захватка'}</td><td>${esc(h.action)}<details><summary>Подробности</summary><pre>${esc(h.before_json)}\n→\n${esc(h.after_json)}</pre></details></td><td>${esc(h.actor || '')}</td><td>${canEdit && h.element_id ? btn('restore-'+h.id,'Восстановить назначение') : canEdit && h.action==='zone' && !h.undone ? btn('undo-zone-'+h.id,'Отменить правку контура') : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`;
    wire(); drawMap();
  }
  function syncDraft() {
    if (!draft) return;
    draft.name = $('#wg-draft-name').value;
    draft.work_group_id = Number($('#wg-draft-group').value);
    const number = (id) => $(id).value === '' ? null : Number($(id).value);
    draft.number = number('#wg-draft-number'); draft.capture_floor = number('#wg-draft-floor');
    if ($('#wg-draft-current')) draft.is_current = Number($('#wg-draft-current').value);
    draft.lower = number('#wg-draft-low'); draft.upper = number('#wg-draft-high');
    if (draft.levels[0]) { draft.levels[0].elevation_mm = draft.lower; draft.levels[0].upper_elevation_mm = draft.upper; }
  }
  function wire() {
    host.querySelectorAll('[data-wg]').forEach(b=>b.addEventListener('click',()=>run(async()=>{
      const id=b.dataset.wg;
      if (id.startsWith('show-group-')) { syncDraft(); selectedGroup=id.slice(11); selected.clear(); invalidate(); }
      else if (id==='reload') { invalidate(); await load(); }
      else if(id==='edit-groups' || id==='edit-template') { invalidate(); templateMode=id==='edit-template'; editing=copy(templateMode ? data.template.groups : data.groups).map(({key,name,rules})=>({key,name,rules})); }
      else if(id==='cancel-edit') editing=null;
      else if(id==='add-group') editing.push({key:crypto.randomUUID(),name:'',rules:[{element_type:'*',subtype:'*'}]});
      else if(id.startsWith('remove-group-')) { editing.splice(Number(id.split('-').at(-1)),1); invalidate(); }
      else if(id.startsWith('add-rule-')) { editing[Number(id.split('-').at(-1))].rules.push({element_type:'*',subtype:'*'}); invalidate(); }
      else if(id.startsWith('remove-rule-')) { const parts=id.split('-'); editing[Number(parts[2])].rules.splice(Number(parts[3]),1); invalidate(); }
      else if(id==='save-groups') {
        if(templateMode) { data.template=await api.put('/work-groups/template',{revision:data.template.revision,groups:editing}); editing=null; message='Общий шаблон сохранён. На действующем объекте примените его отдельно.'; }
        else await prepare({action:'groups',groups:editing});
      }
      else if(id==='template-apply') await prepare({action:'template_apply'});
      else if(id==='resolve') {
        const choices={}; host.querySelectorAll('[data-choice]').forEach(e=>{ choices[e.dataset.choice]=e.value; });
        await prepare({action:'template_apply',choices});
      }
      else if(id==='apply') await apply();
      else if(id==='cancel-preview') invalidate();
      else if(id==='new-zone') { invalidate(); draft={name:'',work_group_id:Number(selectedGroup)||data.groups[0].id,levels:[],is_current:1}; drawing=false; }
      else if(id.startsWith('zone-')) { invalidate(); draft=copy(data.zones.find(z=>z.id===Number(id.slice(5)))); drawing=false; }
      else if(id==='cancel-zone') { invalidate(); draft=null; drawing=false; }
      else if(id==='draw') {
        syncDraft(); invalidate();
        if(!drawing) { draft.levels=[{outline:[],elevation_mm:draft.lower ?? null,upper_elevation_mm:draft.upper ?? null}]; drawing=true; }
        else if(draft.levels[0].outline.length>=3) drawing=false;
        else message='Добавьте минимум три вершины';
      }
      else if(id==='undo-point') { draft.levels[0].outline.pop(); invalidate(); }
      else if(id==='clear-contour') { syncDraft(); draft.levels=[]; drawing=false; invalidate(); }
      else if(id==='preview-zone') { syncDraft(); await prepare({action:'zone',zone:draft}); }
      else if(id==='assign') { const target=Number($('#wg-target').value); if(!target) throw Error('Выберите захватку'); const z=data.zones.find(z=>z.id===target); const ids=elements.filter(e=>selected.has(e.id)&&e.work_group_id===z.work_group_id).map(e=>e.id); if(!ids.length) throw Error('В выделении нет изделий группы выбранной захватки'); await prepare({action:'assign',zone_id:target,element_ids:ids}); message=`К назначению выбрано ${ids.length} из ${selected.size} выделенных изделий`; }
      else if(id==='auto') await prepare({action:'auto',element_ids:[...selected]});
      else if(id==='clear-selection') { selected.clear(); invalidate(); }
      else if(id==='history') history=await api.get(`/work-groups/${objectId}/history`);
      else if(id.startsWith('undo-zone-')) await prepare({action:'undo_zone',history_id:Number(id.slice(10))});
      else if(id.startsWith('restore-')) await prepare({action:'restore',history_id:Number(id.slice(8))});
      else if(id==='fit') { view=null; await load(); }
    })));
    $('#wg-group')?.addEventListener('change',e=>{ syncDraft(); selectedGroup=e.target.value; selected=new Set([...selected].filter(id=>visible().some(e=>e.id===id))); invalidate(); render(); });
    host.querySelectorAll('[data-name]').forEach(e=>e.addEventListener('input',()=>{ editing[Number(e.dataset.name)].name=e.value; invalidate(); }));
    for (const attr of ['type','subtype']) host.querySelectorAll(`[data-${attr}]`).forEach(e=>e.addEventListener('change',()=>{
      const [i,j]=e.dataset[attr].split(':').map(Number); editing[i].rules[j][attr==='type'?'element_type':'subtype']=e.value; invalidate(); render();
    }));
    host.querySelectorAll('[id^="wg-draft-"]').forEach(e=>e.addEventListener('input',()=>{ syncDraft(); invalidate(); }));
  }
  function drawMap() {
    const svg=$('.wg-map'); if(!svg) return;
    const pointText=points=>points.map(p=>`${p[0]},${-p[1]}`).join(' ');
    const width=view[2]/1100;
    const zones=data.zones.filter(z=>z.is_current && (!selectedGroup || z.work_group_id===Number(selectedGroup)));
    svg.innerHTML=`<g stroke-width="${width}">${zones.flatMap(z=>z.levels.map(l=>`<polygon points="${pointText(l.outline)}" fill="#e9be4a22" stroke="#b17700" pointer-events="none"/>`)).join('')}
      ${visible().map(e=>e.outline?.length ? `<polygon data-element="${e.id}" points="${pointText(e.outline)}" fill="${selected.has(e.id)?'#dc5d26':'#607d8b'}" stroke="${selected.has(e.id)?'#ab2800':'#ffffff'}"><title>${esc(e.mark || e.id)} · ${esc(groupName(e.work_group_id))}</title></polygon>` : `<circle data-element="${e.id}" cx="${e.x}" cy="${-e.y}" r="${width*3}" fill="${selected.has(e.id)?'#dc5d26':'#607d8b'}"/>`).join('')}
      ${draft?.levels.map(l=>`<polyline points="${pointText(l.outline)}" fill="#29a0d322" stroke="#0079b1" stroke-width="${width*2}" pointer-events="none"/>`).join('') || ''}</g>`;
    const world=e=>{ const p=svg.createSVGPoint(); p.x=e.clientX;p.y=e.clientY;const q=p.matrixTransform(svg.getScreenCTM().inverse());return [q.x,-q.y]; };
    svg.onpointerdown = e=>{
      if(busy) return;
      if(drawing) { syncDraft(); draft.levels[0].outline.push(world(e)); invalidate(); drawMap();return; }
      drag={start:world(e),client:[e.clientX,e.clientY],view:[...view],id:Number(e.target.closest('[data-element]')?.dataset.element)||null,box:e.shiftKey};
      svg.setPointerCapture(e.pointerId);
    };
    svg.onpointermove = e=>{
      if(!drag) return;
      if(drag.box) { const p=world(e); rect=[drag.start,p]; }
      else if(!drag.id) { const dx=(e.clientX-drag.client[0])*view[2]/svg.clientWidth,dy=(e.clientY-drag.client[1])*view[3]/svg.clientHeight;view=[drag.view[0]-dx,drag.view[1]-dy,view[2],view[3]];svg.setAttribute('viewBox',(view || [0,0,10000,10000]).join(' ')); }
    };
    svg.onpointerup = e=>{
      if(!drag) return;
      if(drag.box && rect) { const [[x1,y1],[x2,y2]]=rect;for(const el of visible()) if(el.x>=Math.min(x1,x2)&&el.x<=Math.max(x1,x2)&&el.y>=Math.min(y1,y2)&&el.y<=Math.max(y1,y2)) selected.add(el.id); }
      else if(drag.id) selected.has(drag.id) ? selected.delete(drag.id) : selected.add(drag.id);
      drag=null;rect=null; syncDraft();invalidate();render();
    };
    svg.onwheel = e=>{e.preventDefault();const f=e.deltaY>0?1.2:1/1.2;const p=world(e);view=[p[0]-(p[0]-view[0])*f,-p[1]-(-p[1]-view[1])*f,view[2]*f,view[3]*f];svg.setAttribute('viewBox',(view || [0,0,10000,10000]).join(' '));};
  }
  void run(load);
  return { destroy(){ dead=true; host.replaceChildren(); }, guardLeave(){ return Promise.resolve(!editing && !draft && !preview || window.confirm('Закрыть несохранённые изменения групп и захваток?')); } };
}

export function openWorkGroups({ api, objectId, canEdit, initialIds, onSaved }) {
  const dialog=document.createElement('dialog'); dialog.className='wg-dialog';
  dialog.innerHTML='<button type="button" class="v2-btn" data-close>Закрыть</button><div data-content></div>';
  document.body.append(dialog);
  const module=mountWorkGroups(dialog.querySelector('[data-content]'),{api,objectId,canEdit,initialIds,onSaved});
  const close=async()=>{ if(await module.guardLeave()){ module.destroy();dialog.close();dialog.remove(); } };
  dialog.querySelector('[data-close]').addEventListener('click',close);
  dialog.addEventListener('cancel',e=>{e.preventDefault();void close();});
  dialog.showModal();
}

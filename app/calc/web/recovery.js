(()=>{
 const api=window.CalcZhBIAPI,escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const dialog=document.createElement('dialog');dialog.id='pc-recovery-dialog';dialog.setAttribute('aria-labelledby','pc-recovery-title');
 dialog.innerHTML=`<div class="pc-recovery-heading"><div><h2 id="pc-recovery-title">Обработка изделий · локальный Qwen</h2><p>Результаты сохраняются отдельно до подключения частичной модели.</p></div><button type="button" data-recovery-close aria-label="Закрыть обработку">×</button></div>
 <div id="pc-recovery-status" role="status" aria-live="polite"></div><div class="pc-recovery-layout">
 <aside><details id="pc-recovery-connection" open><summary>Подключение к серверу</summary><form id="pc-recovery-config">
 <label>API<select name="provider"><option value="openai">OpenAI-совместимый (vLLM, LM Studio)</option><option value="ollama">Ollama</option></select></label>
 <label>Адрес API<input name="baseUrl" type="url" required maxlength="500" placeholder="LM Studio: http://192.168.87.220:1234/v1 · Ollama: http://192.168.1.10:11434"></label>
 <label>Название модели<select id="pc-recovery-model-select" hidden aria-label="Модель с сервера нейросети"></select><input name="model" list="pc-recovery-models" required maxlength="200" placeholder="Название установленного Qwen"><datalist id="pc-recovery-models"></datalist></label><div class="pc-context" id="pc-recovery-models-note" role="status"></div>
 <div class="pc-recovery-actions"><button type="button" id="pc-recovery-list-models">Обновить список моделей</button></div>
 <details><summary>Параметры обработки</summary>
 <label>Ожидание ответа, секунд<input name="timeoutSeconds" type="number" min="10" max="600" required></label>
 <label>Лимит ответа, токенов<input name="maxTokens" type="number" min="512" max="16384" required></label>
 <label>Сторона изображения, пикселей<input name="imageSide" type="number" min="768" max="2000" required></label>
 <label>Листов на изделие, максимум<input name="maxPages" type="number" min="1" max="60" required></label>
 <label>Попыток исправления<input name="repairAttempts" type="number" min="0" max="2" required></label>
 <label class="pc-recovery-check"><input name="useTiles" type="checkbox"> Читать увеличенные фрагменты</label></details>
 <div class="pc-recovery-actions"><button type="submit">Сохранить</button><button type="button" id="pc-recovery-test">Проверить изображение</button></div></form><p id="pc-recovery-probe"></p></details>
 <section><h3>Новая партия</h3><label>Изделия<select id="pc-recovery-scope"><option value="active">Текущее изделие</option><option value="selected">Выбранные флажками</option><option value="visible">Показанные в списке</option><option value="remaining">Все без полной модели</option></select></label>
 <p id="pc-recovery-selection"></p><label id="pc-recovery-extra-label">Дополнительные физические PDF-страницы<input id="pc-recovery-extra" placeholder="Например: 12, 13, 18" inputmode="numeric"></label>
 <p class="pc-recovery-muted">Связанные виды, детали и спецификации включаются автоматически. Дополнительные страницы относятся к альбому текущего изделия.</p>
 <button type="button" id="pc-recovery-start">Запустить обработку</button><p id="pc-recovery-worker"></p></section></aside>
 <section class="pc-recovery-work"><div class="pc-recovery-queue-tools"><label>Партия<select id="pc-recovery-batch"><option value="">Все партии</option></select></label><button type="button" id="pc-recovery-refresh">Обновить</button><span id="pc-recovery-batch-controls"></span></div>
 <div id="pc-recovery-running" class="pc-recovery-running" role="status" aria-live="polite" hidden></div><div id="pc-recovery-jobs"></div><div class="pc-recovery-actions"><button type="button" id="pc-recovery-prev">←</button><span id="pc-recovery-page"></span><button type="button" id="pc-recovery-next">→</button></div>
 <section id="pc-recovery-detail" hidden></section></section></div>`;
 document.getElementById('precast-concept').append(dialog);
 const q=s=>dialog.querySelector(s),form=q('#pc-recovery-config');let timer=null,detailTimer=null,detailState=null,autoOpened=false,batch='',offset=0,total=0,detailId=null,connection=null,refreshing=false,pendingLaunch=null;
 const states={queued:'В очереди',running:'Обработка',review:'На просмотре',failed:'Ошибка',cancelled:'Отменено',published:'Подключена частично'};
 function stageLabel(stage){if(stage.startsWith('reading:')){const [,source,page]=stage.split(':');return 'Чтение · '+source+' · PDF '+page.slice(1);}if(stage.startsWith('repair:'))return 'Исправление · попытка '+stage.split(':')[1];return {prepare:'Подготовка листов',reading:'Чтение листов',assembly:'Сборка',checking:'Численная проверка',review:'Просмотр результата',published:'Подключена'}[stage]||stage;}
 function status(text,kind='info'){const host=q('#pc-recovery-status'),value=kind===true?'error':kind===false?'info':kind;host.textContent=text;host.dataset.kind=value;host.dataset.error=String(value==='error');}
 function selection(){return window.CalcZhBIRecoveryUI?.selection(q('#pc-recovery-scope').value)||[];}
 function updateSelection(){const selected=selection();q('#pc-recovery-selection').textContent=selected.length===1?selected[0].name:`Изделий: ${selected.length}`;q('#pc-recovery-extra-label').hidden=q('#pc-recovery-scope').value!=='active';q('#pc-recovery-start').disabled=!selected.length||api.user?.role==='viewer'||!connection?.probe?.ok;}
 function configPayload(){const result={};for(const name of ['provider','baseUrl','model'])result[name]=form.elements[name].value.trim();for(const name of ['timeoutSeconds','maxTokens','imageSide','maxPages','repairAttempts'])result[name]=Number(form.elements[name].value);result.useTiles=form.elements.useTiles.checked;return result;}
 async function loadConfig(){
  connection=await api.request('/calc/api/recovery/config');for(const [key,value] of Object.entries(connection.config)){if(form.elements[key]){if(key==='useTiles')form.elements[key].checked=value;else form.elements[key].value=value;}}
  const admin=api.user?.role==='admin';for(const el of form.elements)el.disabled=!admin;
  if(admin)scheduleModels();
  q('#pc-recovery-test').disabled=!admin;
  q('#pc-recovery-probe').textContent=connection.probe?.ok?'Изображения и JSON проверены · '+connection.probe.model:'Перед запуском нужен успешный тест чтения изображения.';
  updateSelection();
  q('#pc-recovery-worker').textContent=connection.workerEnabled?'Фоновая очередь включена · один запрос к GPU за раз.':'Встроенная очередь отключена. Запустите обработчик на сервере.';
 }
 async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
   const response=await api.request('/calc/api/recovery/jobs?offset='+offset+(batch?'&batchId='+encodeURIComponent(batch):''));total=response.total;
   const selected=q('#pc-recovery-batch');selected.innerHTML='<option value="">Все партии</option>'+response.batches.map(b=>`<option value="${escape(b.id)}">${escape(new Date(b.created_at).toLocaleString('ru-RU'))} · ${b.finished}/${b.total} · ${escape({running:'работает',paused:'пауза',cancelled:'отмена'}[b.state])}</option>`).join('');selected.value=batch;
   const current=response.batches.find(b=>b.id===batch),writer=api.user?.role!=='viewer';
   q('#pc-recovery-batch-controls').innerHTML=current&&current.state!=='cancelled'&&writer?`<button type="button" data-batch-action="${current.state==='paused'?'resume':'pause'}">${current.state==='paused'?'Продолжить':'Пауза'}</button><button type="button" data-batch-action="cancel">Отменить партию</button>`:'';
   q('#pc-recovery-jobs').innerHTML=response.jobs.length?`<table class="pc-recovery-table"><thead><tr><th>Изделие</th><th>Состояние</th><th>Этап</th><th></th></tr></thead><tbody>${response.jobs.map(j=>`<tr><td>${escape(j.productName)}</td><td>${escape(j.batchState==='paused'&&j.state==='queued'?'Пауза':states[j.state])}</td><td>${escape(stageLabel(j.stage))}${j.state==='running'?`<div class="pc-live-compact">${liveCompact(j.live)}</div>`:''}${j.error?`<div class="pc-recovery-error">${escape(j.error)}</div>`:''}</td><td><button type="button" data-job="${escape(j.id)}">Открыть</button></td></tr>`).join('')}</tbody></table>`:'<p>Заданий пока нет. Настройте подключение и выберите изделия.</p>';
   const running=response.jobs.find(j=>j.state==='running'),banner=q('#pc-recovery-running');
   if(running){banner.hidden=false;const l=running.live;banner.innerHTML=`<strong>Идёт обработка: ${escape(running.productName)}</strong> — ${escape(l?.phaseLabel||'запуск')}${l?.request?` · запрос ${escape(l.request.kind)}: ${escape(reqStates[l.request.state]||l.request.state)}, ${dur(l.request.elapsed)}`:''}`;
    if(!autoOpened&&!detailId){autoOpened=true;void openJob(running.id);}}
   else{banner.hidden=true;banner.textContent='';}
   q('#pc-recovery-page').textContent=total?`${offset+1}–${Math.min(offset+100,total)} из ${total}`:'0 заданий';q('#pc-recovery-prev').disabled=offset===0;q('#pc-recovery-next').disabled=offset+100>=total;
  }finally{refreshing=false;}
 }
 function sourceLinks(sources,job){return (sources||[]).map(s=>`<button type="button" class="pc-recovery-source" data-source-job="${escape(job)}" data-source-id="${escape(s.sourceId)}" data-source-page="${s.pdfPage}" ${s.bbox?`data-source-bbox="${escape(s.bbox.join(','))}"`: ''}>${escape(s.sourceId)} · PDF ${s.pdfPage}</button>`).join(' ');}

 // ---- подробный ход обработки (данные: recovery_live/recovery_events, API /jobs и /jobs/{id})
 const dur=s=>{s=Math.max(0,Math.round(s||0));const m=Math.floor(s/60);return m?`${m} мин ${String(s%60).padStart(2,'0')} с`:`${s} с`;};
 const reqStates={connecting:'соединение с сервером нейросети',waiting_first_token:'запрос принят, ждём первый токен (модель может загружаться в память)',generating:'модель отвечает'};
 const levelMark={info:'•',ok:'✓',warn:'⚠',error:'✗'};
 function progressFraction(l){
  const n=Math.max(1,l.sheetsTotal||1),steps=n+2;
  if(l.phase==='prepare')return 0.02;
  if(l.phase==='reading')return Math.min(.98,((l.sheetIndex||1)-1+Math.min(.9,(l.request?.deltas||0)/Math.max(1,l.request?.maxTokens||8192)*8))/steps);
  if(l.phase==='assembly')return n/steps+.5/steps;
  if(l.phase==='checking')return (n+1)/steps;
  return l.phase==='done'?1:0;
 }
 function liveCompact(l){
  if(!l)return '<div class="pc-live-line">Запуск…</div>';
  const rq=l.request,percent=Math.round(progressFraction(l)*100);
  const now=l.serverNow||Date.now()/1000;
  let text=l.phaseLabel||'Обработка';
  if(rq)text+=` · запрос «${rq.kind}»: ${reqStates[rq.state]||rq.state}, ${dur(rq.elapsed)}`+(rq.state==='generating'?`, ~${rq.tokens||rq.deltas||0} токенов`:'');
  return `<div class="pc-live-bar" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div><div class="pc-live-line">${escape(text)}</div>`;
 }
 function liveCard(j){
  const l=j.live;if(!l)return j.state==='queued'?'<p class="pc-live-line">Задание в очереди: ждёт освобождения нейросети.</p>':'';
  const rq=l.request,percent=Math.round(progressFraction(l)*100),total=dur((l.serverNow||0)-(l.startedAt||0));
  const rows=[['Модель',l.model],['Всего прошло',total],['Листов',`${l.sheetIndex||0} из ${l.sheetsTotal||0}`+(l.sheetLabel?` · ${l.sheetLabel}`:'')],['Запросов к модели выполнено',l.requestsDone||0],['Фактов прочитано',l.factsTotal||0]];
  let request='<p class="pc-live-line">Сейчас запрос к модели не идёт (подготовка или обработка результата на сервере).</p>';
  if(rq){
   const tokens=rq.tokens||rq.deltas||0,speed=rq.state==='generating'&&rq.elapsed>0?(tokens/Math.max(1,rq.elapsed-(rq.firstTokenAt||0))).toFixed(1):null;
   const share=Math.min(100,Math.round(tokens/Math.max(1,rq.maxTokens)*100));
   request=`<div class="pc-live-request" data-state="${escape(rq.state)}"><strong>Запрос: ${escape(rq.kind)}</strong> · попытка ${rq.attempt} из ${rq.attempts}
    <dl><dt>Состояние</dt><dd>${escape(reqStates[rq.state]||rq.state)}</dd><dt>Идёт</dt><dd>${dur(rq.elapsed)}</dd>
    <dt>Изображений в запросе</dt><dd>${rq.images}</dd><dt>Лимит ответа</dt><dd>${rq.maxTokens} токенов</dd>
    ${rq.state==='generating'?`<dt>Получено</dt><dd>~${tokens} токенов (${share}% лимита)${speed?` · ${speed} ток/с`:''}</dd>`:''}
    ${rq.reasoningDeltas?`<dt>Рассуждение модели</dt><dd>${rq.reasoningDeltas} фрагментов (счёт в лимите ответа)</dd>`:''}
    <dt>Нет новых данных</dt><dd${rq.sinceLast>45?' class="pc-live-warn"':''}>${dur(rq.sinceLast)}</dd></dl>
    ${rq.state==='generating'?`<div class="pc-live-bar"><i style="width:${share}%"></i></div>`:''}
    ${rq.state!=='generating'?'<p class="pc-recovery-muted">Если ответа нет дольше «Тайм-аута», запрос повторится автоматически (до трёх попыток).</p>':''}</div>`;
  }
  const last=l.lastRequest?`<p class="pc-recovery-muted">Предыдущий запрос: ${escape(l.lastRequest.kind||'')} — ${l.lastRequest.ok?'успешно':'не удался'}${l.lastRequest.summary?', '+escape(l.lastRequest.summary):''}.</p>`:'';
  return `<div class="pc-live-card"><div class="pc-live-title">${escape(l.phaseLabel||'Обработка')}</div><div class="pc-live-bar" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div>
   <dl class="pc-live-facts">${rows.map(([k,v])=>`<dt>${k}</dt><dd>${escape(v)}</dd>`).join('')}</dl>${request}${last}</div>`;
 }
 function logHtml(events){
  return events.length?events.map(e=>`<li data-level="${escape(e.level)}"><time>${escape(new Date(e.ts).toLocaleTimeString('ru-RU'))}</time><span class="pc-log-mark">${levelMark[e.level]||'•'}</span><span>${escape(e.text)}</span></li>`).join(''):'<li class="pc-recovery-muted">Записей пока нет.</li>';
 }
 function paintLive(j){
  const card=q('#pc-recovery-live'),log=q('#pc-recovery-log');if(!card||!log)return;
  card.innerHTML=['running','queued'].includes(j.state)?liveCard(j):'';
  const box=log.parentElement,atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-24;log.innerHTML=logHtml(j.events||[]);if(atEnd)box.scrollTop=box.scrollHeight;
 }
 async function pollDetail(id){
  clearTimeout(detailTimer);if(detailId!==id||!dialog.open)return;
  try{const j=await api.request('/calc/api/recovery/jobs/'+id);if(detailId!==id)return;paintLive(j);
   if(['running','queued'].includes(j.state)){detailTimer=setTimeout(()=>void pollDetail(id),1500);}
   else if(detailState!==j.state){detailState=j.state;await openJob(id,{keepPolling:false});}
  }catch(error){detailTimer=setTimeout(()=>void pollDetail(id),4000);}
 }
 async function openJob(id,{keepPolling=true}={}){
  detailId=id;const host=q('#pc-recovery-detail');host.hidden=false;if(!host.dataset.job||host.dataset.job!==id)host.textContent='Загружаю результат…';host.dataset.job=id;
  const j=await api.request('/calc/api/recovery/jobs/'+id);if(detailId!==id)return;detailState=j.state;
  const qa=j.qaDetail,writer=api.user?.role!=='viewer',admin=api.user?.role==='admin';
  host.innerHTML=`<h3>${escape(j.productName)} · ${escape(states[j.state])}</h3><section id="pc-recovery-live" class="pc-live"></section><p>${escape(j.error||qa?.scope||'Результат появится после обработки листов.')}</p><div class="pc-recovery-actions">${j.candidate_sha?`<button type="button" data-preview="${id}">Посмотреть 3D-кандидат</button><a href="/calc/api/recovery/jobs/${id}/export" download>Скачать результат и QA</a>`:''}${writer&&['failed','review'].includes(j.state)&&j.batchState!=='cancelled'?`<select id="pc-recovery-retry-stage"><option value="continue">Продолжить с сохранённых этапов</option><option value="assembly">Повторить сборку</option><option value="reading">Повторить чтение и сборку</option></select><button type="button" data-retry="${id}">Повторить</button>`:''}</div>
  ${qa?`<p>Бетонных частей: ${qa.counts.concreteParts} · металлических: ${qa.counts.metalParts} · стержней: ${qa.counts.bars}. Обнаружено контактов: ${qa.steelPairContacts}. Выходов из бетона: ${qa.outsideBars}.</p>
  ${qa.checksLimited?'<p class="pc-recovery-error">Численная проверка ограничена объёмом выборки.</p>':''}
  <details open><summary>Ошибки и замечания (${qa.implementationErrors.length+qa.findings.length})</summary><ul>${[...qa.implementationErrors,...qa.findings].map(f=>`<li>${escape(f.description)} ${sourceLinks(f.sources,id)}<div class="pc-recovery-muted">${escape(f.recommendation)}</div></li>`).join('')}</ul></details>
  <details><summary>Состав по спецификации</summary><table class="pc-recovery-table"><thead><tr><th>Позиция</th><th>По источнику</th><th>Построено</th><th>Основания</th></tr></thead><tbody>${qa.specCoverage.map(c=>`<tr><td>${escape(c.name)}</td><td>${c.expected??'Неизвестно'}</td><td>${c.modeled}</td><td>${sourceLinks(c.sources,id)}</td></tr>`).join('')}</tbody></table></details>
  <details><summary>Прочитанные факты и исходные листы</summary>${qa.readings.map(p=>`<h4>${sourceLinks([p],id)}</h4><ul>${p.facts.map(f=>`<li>${escape(f.subject)} · ${escape(f.property)}: ${escape(f.value??'неизвестно')} ${escape(f.unit)}<div class="pc-recovery-muted">${escape(f.quote)} ${sourceLinks([{...p,bbox:f.bbox}],id)}</div></li>`).join('')}</ul>`).join('')}</details>`:''}
  ${admin&&j.state==='review'&&qa?.publishable?`<div class="pc-recovery-publish"><label class="pc-recovery-check"><input id="pc-recovery-ack" type="checkbox"> Подключить как частичную модель с открытыми замечаниями. Полнота и проектная точность требуют проверки.</label><button type="button" data-publish="${id}" data-sha="${escape(j.candidate_sha)}" disabled>Подключить частичную версию</button></div>`:''}
  <details><summary>Этапы и комплект исходников</summary><p>${escape(j.steps.map(s=>s.key).join(' → '))}</p><ul>${(j.input.sheets||[]).map(s=>`<li>${sourceLinks([s],id)} · ${escape(s.titles.join(', '))}</li>`).join('')}</ul></details><details class="pc-recovery-logbox" open><summary>Журнал выполнения (${(j.events||[]).length})</summary><div class="pc-recovery-logscroll"><ol id="pc-recovery-log" class="pc-recovery-log"></ol></div></details><figure id="pc-recovery-evidence" hidden></figure>`;
  paintLive(j);if(keepPolling&&['running','queued'].includes(j.state))detailTimer=setTimeout(()=>void pollDetail(id),1500);
 }
 async function act(button,operation){button.disabled=true;try{await operation();}catch(error){status(error.message,true);}finally{if(button.isConnected)button.disabled=false;}}
 document.getElementById('pc-recovery-open').addEventListener('click',async()=>{if(!window.CalcZhBIRecoveryUI)return;dialog.showModal();status('');updateSelection();try{await loadConfig();await refresh();}catch(error){status(error.message,true);}clearInterval(timer);autoOpened=false;timer=setInterval(()=>{if(dialog.open&&!document.hidden)void refresh().catch(error=>status(error.message,true));},2000);});
 dialog.addEventListener('close',()=>{clearInterval(timer);timer=null;clearTimeout(detailTimer);});
 form.addEventListener('submit',event=>{event.preventDefault();void act(form.querySelector('[type=submit]'),async()=>{await api.request('/calc/api/recovery/config',{method:'PUT',body:JSON.stringify(configPayload())});await loadConfig();status('Подключение сохранено. Проверьте чтение изображения.');});});
 // Список моделей подгружается сам: при открытии формы, смене типа API и адреса. Сервер нейросети может быть виден только backend,
 // поэтому запрос идёт через сервер. Не получили список — остаётся ручной ввод названия.
 const modelSelect=q('#pc-recovery-model-select'),modelNote=q('#pc-recovery-models-note');let modelsTimer=0,modelsSerial=0;
 function showModels(models){
  const usable=models.filter(m=>m.vision||!/embed/i.test(m.id)).sort((x,y)=>Number(!!y.vision)-Number(!!x.vision)||x.id.localeCompare(y.id));
  const current=form.elements.model.value.trim();
  q('#pc-recovery-models').replaceChildren(...usable.map(m=>{const o=document.createElement('option');o.value=m.id;return o;}));
  const options=usable.map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.id+(m.vision?' · с изображениями':m.vision===false?'':'');return o;});
  const manual=document.createElement('option');manual.value='';manual.textContent='— выберите модель —';
  const typed=document.createElement('option');typed.value='__manual__';typed.textContent='Ввести название вручную…';
  modelSelect.replaceChildren(manual,...options,typed);
  modelSelect.value=usable.some(m=>m.id===current)?current:'';
  modelSelect.hidden=false;form.elements.model.hidden=true;
  const vision=usable.filter(m=>m.vision);
  modelNote.textContent='Моделей на сервере: '+usable.length+(vision.length?' (с изображениями: '+vision.length+'). Для чертежей нужна модель с изображениями.':'.');
 }
 function showManualModel(note){modelSelect.hidden=true;form.elements.model.hidden=false;modelNote.textContent=note||'';}
 async function refreshModels({manual=false}={}){
  if(api.user?.role!=='admin'||!form.elements.baseUrl.value.trim()||!form.elements.baseUrl.validity.valid){return;}
  const serial=++modelsSerial;modelNote.textContent='Запрашиваю список моделей у сервера нейросети…';
  try{const result=await api.request('/calc/api/recovery/models',{method:'POST',body:JSON.stringify(configPayload())});if(serial!==modelsSerial)return;showModels(result.models);if(manual)status('Список моделей обновлён.');}
  catch(error){if(serial!==modelsSerial)return;showManualModel('Список моделей не получен ('+error.message+'). Введите название модели вручную.');}
 }
 function scheduleModels(){clearTimeout(modelsTimer);modelsTimer=setTimeout(()=>void refreshModels(),700);}
 modelSelect.addEventListener('change',()=>{if(modelSelect.value==='__manual__'){showManualModel('');form.elements.model.focus();return;}form.elements.model.value=modelSelect.value;});
 form.elements.baseUrl.addEventListener('change',scheduleModels);form.elements.provider.addEventListener('change',scheduleModels);
 q('#pc-recovery-list-models').addEventListener('click',event=>void act(event.currentTarget,()=>refreshModels({manual:true})));
 q('#pc-recovery-test').addEventListener('click',event=>void act(event.currentTarget,async()=>{
  if(!form.reportValidity())return;
  await api.request('/calc/api/recovery/config',{method:'PUT',body:JSON.stringify(configPayload())});
  // Проверка идёт в фоне на сервере (крупная модель грузится в память долго, прокси оборвал бы обычный запрос): здесь опрос состояния.
  status('Проверка запущена…','busy');
  let state=await api.request('/calc/api/recovery/connection-test',{method:'POST'});
  while(state.state==='running'&&dialog.open){
   status(`Идёт проверка модели «${state.model}»: ${state.elapsedSeconds} с из ${state.timeout} с. Крупная модель может загружаться в память сервера нейросети — это нормально, ждите.`,'busy');
   await new Promise(resolve=>setTimeout(resolve,1500));state=await api.request('/calc/api/recovery/connection-test');
  }
  if(state.state==='done'){await loadConfig();status('✓ Проверка пройдена. '+state.result.note,'ok');}
  else if(state.state==='failed')status('✗ Проверка не пройдена: '+state.error,'error');
 }));
 q('#pc-recovery-scope').addEventListener('change',updateSelection);
 q('#pc-recovery-start').addEventListener('click',event=>void act(event.currentTarget,async()=>{
  const ids=selection().map(p=>p.id);let pages=[];const text=q('#pc-recovery-extra').value.trim();
  if(q('#pc-recovery-scope').value==='active'&&text){if(!/^\d+(?:\s*[,;]\s*\d+)*$/.test(text))throw new Error('Введите физические страницы через запятую');pages=[...new Set(text.split(/[,;]/).map(Number))];}
  await window.CalcZhBIFlushSaves();const chosen={productIds:ids,additionalPages:pages};if(!pendingLaunch||JSON.stringify(pendingLaunch.chosen)!==JSON.stringify(chosen))pendingLaunch={chosen,requestId:crypto.randomUUID()};const result=await api.request('/calc/api/recovery/batches',{method:'POST',body:JSON.stringify({...chosen,requestId:pendingLaunch.requestId})});pendingLaunch=null;batch=result.id;offset=0;status('Создана партия. Изделий: '+(result.count??ids.length)+'.');await refresh();
 }));
 q('#pc-recovery-batch').addEventListener('change',event=>{batch=event.target.value;offset=0;void refresh().catch(error=>status(error.message,true));});
 q('#pc-recovery-refresh').addEventListener('click',()=>void refresh().then(()=>detailId&&openJob(detailId)).catch(error=>status(error.message,true)));
 for(const [selector,delta] of [['#pc-recovery-prev',-100],['#pc-recovery-next',100]])q(selector).addEventListener('click',()=>{offset=Math.max(0,offset+delta);void refresh().catch(error=>status(error.message,true));});
 dialog.addEventListener('change',event=>{if(event.target.id==='pc-recovery-ack')q('[data-publish]').disabled=!event.target.checked;});
 dialog.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-recovery-close')){dialog.close();return;}
  if(b.dataset.job)void openJob(b.dataset.job).catch(error=>status(error.message,true));
  if(b.dataset.batchAction)void act(b,async()=>{await api.request('/calc/api/recovery/batches/'+batch+'/'+b.dataset.batchAction,{method:'POST'});await refresh();status('Состояние партии обновлено.');});
  if(b.dataset.retry)void act(b,async()=>{await api.request('/calc/api/recovery/jobs/'+b.dataset.retry+'/retry',{method:'POST',body:JSON.stringify({stage:q('#pc-recovery-retry-stage').value})});await refresh();await openJob(b.dataset.retry);status('Задание возвращено в очередь.');});
  if(b.dataset.preview)void act(b,async()=>{const result=await api.request('/calc/api/recovery/jobs/'+b.dataset.preview+'/candidate');await window.CalcZhBIRecoveryUI.preview(result);dialog.close();});
  if(b.dataset.publish)void act(b,async()=>{if(!q('#pc-recovery-ack').checked)return;await window.CalcZhBIFlushSaves();const result=await api.request('/calc/api/recovery/jobs/'+b.dataset.publish+'/publish',{method:'POST',body:JSON.stringify({expectedSha256:b.dataset.sha,acknowledgePartial:true})});await window.CalcZhBIRecoveryUI.published(result);await refresh();await openJob(b.dataset.publish);status('Подключена новая частичная редакция. Калькуляции сохранены.');});
  if(b.dataset.sourceJob)void act(b,async()=>{const host=q('#pc-recovery-evidence');host.hidden=false;host.replaceChildren();const caption=document.createElement('figcaption');caption.textContent=b.textContent;const img=document.createElement('img');img.alt='Исходный лист '+b.textContent;img.src='/calc/api/recovery/jobs/'+b.dataset.sourceJob+'/sources/'+encodeURIComponent(b.dataset.sourceId)+'/'+b.dataset.sourcePage+'/image';const frame=document.createElement('div');frame.className='pc-recovery-image-frame';frame.append(img);if(b.dataset.sourceBbox){const [x,y,w,h]=b.dataset.sourceBbox.split(',').map(Number);const box=document.createElement('span');box.className='pc-recovery-image-region';Object.assign(box.style,{left:100*x+'%',top:100*y+'%',width:100*w+'%',height:100*h+'%'});box.setAttribute('aria-label','Фрагмент, указанный Qwen');frame.append(box);}host.append(caption,frame);host.scrollIntoView({block:'nearest'});});
 });
})();

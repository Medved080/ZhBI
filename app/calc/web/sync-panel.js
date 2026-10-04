(()=>{
 const api=window.CalcZhBIAPI,button=document.getElementById('pc-sync-open');
 if(!button)return;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let dialog=null,poll=null,state=null,editing=null;
 const size=n=>n>=1048576?(n/1048576).toFixed(1)+' МБ':Math.ceil(n/1024)+' КБ';
 // Кнопка видна тем, у кого есть раздел «Обмен данными калькулятора».
 api.ready().then(async()=>{try{await api.request('/calc/api/sync/state');button.hidden=false;}catch{button.hidden=true;}}).catch(()=>{});
 function summary(result){
  if(!result)return '';const r=result.report||result.plan?.report||result,p=r.products||{},n=r.norms||{},c=r.collisions;
  const part=(label,b)=>b?`<li>${label}: создано ${b.created}, обновлено ${b.updated}, без изменений ${b.unchanged}${b.serverPriority?.length?`, <strong>оставлено серверное: ${b.serverPriority.length}</strong>`:''}${b.senderOlder?.length?`, у отправителя старее: ${b.senderOlder.length}`:''}</li>`:'';
  return `<ul>${part('Изделия',p)}${part('Нормы',n)}${part('Профиль расчёта',r.profiles)}${r.attachmentsAdded!=null?`<li>Добавлено вложений: ${r.attachmentsAdded}</li>`:''}${c?`<li>Коллизии: комментариев добавлено ${c.notesAdded}, статусов ${c.statesAdded}</li>`:''}${result.assetsUpdated?`<li>Обновлено файлов исходников: ${result.assetsUpdated.length}</li>`:''}${result.assetsNeeded?`<li>К передаче: файлов исходников ${result.assetsNeeded.length}, вложений ${result.blobsNeeded.length}</li>`:''}</ul>`;
 }
 function formHtml(){
  const t=editing.existing||{name:editing.name||'',url:'',requireConfirm:editing.name==='prod',caFile:null,tokenConfigured:false};
  return `<form id="pc-sync-target-form" class="pc-sync-form">
   <h3>${editing.existing?'Цель «'+esc(t.name)+'»':'Новая цель'}</h3>
   <label>Название <input name="name" value="${esc(t.name)}" ${editing.existing?'readonly':''} required pattern="[a-z0-9][a-z0-9_\\-]{0,19}" placeholder="test или prod"></label>
   <label>Адрес сервера <input name="url" value="${esc(t.url)}" required placeholder="https://адрес-сервера"></label>
   <label>Токен приёма <input name="token" type="password" autocomplete="off" placeholder="${t.tokenConfigured?'задан — оставьте пустым, чтобы не менять':'czb_… (из окна «Токены приёма» на том сервере)'}"></label>
   <label class="pc-sync-check"><input name="requireConfirm" type="checkbox" ${t.requireConfirm?'checked':''}> Подтверждать отправку вводом имени цели (для боевого сервера)</label>
   <div class="pc-sync-cert"><input type="hidden" name="pin" value="${esc(t.pinnedSha256||'')}"><span id="pc-sync-cert-state">Сертификат: ${t.pinnedSha256?'доверенный отпечаток '+esc(t.pinnedSha256.slice(0,16))+'…':'проверяется системным хранилищем'}</span> <button type="button" data-cert-fetch>Доверять сертификату этого сервера…</button>${t.pinnedSha256?' <button type="button" data-cert-clear>Убрать доверие</button>':''}<div class="pc-context">Нужно, если сервер использует самоподписанный или корпоративный сертификат и проверка связи пишет «CERTIFICATE_VERIFY_FAILED».</div></div>
   <details><summary>Корпоративный сертификат (если сервер ему не доверяет)</summary><label>Путь к файлу .pem на этом компьютере <input name="caFile" value="${esc(t.caFile||'')}" placeholder="/путь/к/корпоративный-ca.pem"></label></details>
   <div class="pc-sync-actions"><button type="submit">Сохранить</button>${editing.existing?'<button type="button" data-target-test>Проверить связь</button><button type="button" data-target-delete>Удалить</button>':''}<button type="button" data-target-cancel>Отмена</button></div>
   <div class="pc-context" id="pc-sync-form-msg" role="status" aria-live="polite"></div>
  </form>`;
 }
 async function render(){
  const body=dialog.querySelector('.pc-sync-body');
  try{state=await api.request('/calc/api/sync/state');}catch(e){body.textContent=e.message;return;}
  const admin=state.canAdminister;
  const targets=state.targets.map(t=>`<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.url)}</td><td>${t.tokenConfigured?'токен задан':'<em>токен не задан</em>'}</td><td><button data-dry="${esc(t.name)}" ${t.tokenConfigured?'':'disabled'}>Проверить данные</button> <button data-send="${esc(t.name)}" data-confirm="${t.requireConfirm}" ${t.tokenConfigured?'':'disabled'}>Отправить</button>${admin?` <button data-edit="${esc(t.name)}">Настроить</button>`:''}</td></tr>`).join('');
  const log=state.log.map(l=>`<tr><td>${esc(l.finished_at||l.started_at)}</td><td>${l.direction==='send'?'отправка':'приём'}${l.target?' → '+esc(l.target):''}</td><td>${esc(l.status)}</td></tr>`).join('');
  body.innerHTML=`<p class="pc-context">Проект ЖБИ: <strong>${esc(state.project?.zhbi_project_name||'не привязан')}</strong>. Источники (PDF, каталоги) на этом сервере: ${state.assetsPresent?'есть':'<strong>нет</strong>'}. Связь с тестовым и боевым серверами — только из-под VPN. При повторной отправке расчёты, изменённые на принимающем сервере, не перезаписываются.</p>
   ${state.targetsError?`<p class="pc-error">${esc(state.targetsError)}</p>`:''}
   ${targets?`<table class="pc-sync-table"><tbody>${targets}</tbody></table>`:'<p>Серверы для передачи ещё не подключены.</p>'}
   ${admin?`<div class="pc-sync-actions"><button data-add="test">+ Тестовый сервер</button><button data-add="prod">+ Боевой сервер</button><button data-add="">+ Другой</button></div>
    <details class="pc-sync-help"><summary>Как подключить сервер</summary><ol><li>Зайдите в ЖБИ на принимающем сервере под администратором → «Калькулятор» → «Передача на серверы» → «Токены приёма», укажите логин пользователя с ролью «Калькулятор» и нажмите «Выдать токен».</li><li>Скопируйте токен (он показывается один раз) и вставьте его здесь в поле «Токен приёма».</li><li>Нажмите «Проверить связь», затем «Проверить данные» и «Отправить».</li></ol></details>`:'<p class="pc-context">Подключать серверы может администратор.</p>'}
   <div id="pc-sync-form-host">${editing?formHtml():''}</div>
   <div id="pc-sync-progress" class="pc-context" role="status" aria-live="polite"></div><div id="pc-sync-result"></div>
   ${admin?`<details><summary>Токены приёма (выдать токен для другого компьютера)</summary><form id="pc-sync-token-form"><input name="login" placeholder="Логин пользователя с ролью «Калькулятор»" required> <input name="name" placeholder="Название токена" required> <button type="submit">Выдать токен</button></form><div id="pc-sync-token-out" class="pc-context"></div></details>`:''}
   <details><summary>Журнал обмена</summary><table class="pc-sync-table"><tbody>${log||'<tr><td>Пока пусто</td></tr>'}</tbody></table></details>`;
  body.querySelectorAll('[data-dry]').forEach(b=>b.addEventListener('click',()=>start(b.dataset.dry,true)));
  body.querySelectorAll('[data-send]').forEach(b=>b.addEventListener('click',()=>{let confirm;if(b.dataset.confirm==='true'){confirm=window.prompt(`Отправка на «${b.dataset.send}». Для подтверждения введите имя цели: ${b.dataset.send}`);if(confirm!==b.dataset.send)return;}start(b.dataset.send,false,confirm);}));
  body.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>{editing={existing:state.targets.find(t=>t.name===b.dataset.edit)};void render();}));
  body.querySelectorAll('[data-add]').forEach(b=>b.addEventListener('click',()=>{editing={name:b.dataset.add};void render();}));
  const form=body.querySelector('#pc-sync-target-form');
  if(form){
   const msg=form.querySelector('#pc-sync-form-msg');
   form.addEventListener('submit',async event=>{event.preventDefault();const f=form.elements;msg.textContent='Сохранение…';
    try{await api.request('/calc/api/sync/targets/'+encodeURIComponent(f.name.value.trim()),{method:'PUT',body:JSON.stringify({url:f.url.value.trim(),token:f.token.value.trim(),requireConfirm:f.requireConfirm.checked,caFile:f.caFile.value.trim(),pinnedSha256:f.pin.value})});editing=null;await render();dialog.querySelector('#pc-sync-progress').textContent='Сохранено. Нажмите «Проверить связь» в настройках цели, чтобы убедиться, что токен и VPN в порядке.';}
    catch(e){msg.textContent=e.message;}});
   form.querySelector('[data-cert-fetch]').addEventListener('click',async()=>{
    const f=form.elements;if(!f.url.value.trim()){msg.textContent='Сначала укажите адрес сервера.';return;}
    msg.textContent='Запрашиваю сертификат сервера…';
    try{const c=await api.request('/calc/api/sync/targets/certificate',{method:'POST',body:JSON.stringify({url:f.url.value.trim()})});
     if(!window.confirm('Сервер предъявил сертификат с отпечатком SHA-256:\n\n'+c.formatted+'\n\nСверьте его с отпечатком на самом сервере (у администратора) и подтвердите. С этого момента передача будет идти только на сервер с этим сертификатом.\n\nДоверять?')){msg.textContent='Доверие не выдано.';return;}
     f.pin.value=c.sha256;form.requestSubmit();
    }catch(e){msg.textContent=e.message;}});
   form.querySelector('[data-cert-clear]')?.addEventListener('click',()=>{form.elements.pin.value='';form.requestSubmit();});
   form.querySelector('[data-target-cancel]').addEventListener('click',()=>{editing=null;void render();});
   form.querySelector('[data-target-test]')?.addEventListener('click',async()=>{msg.textContent='Проверка связи…';try{const r=await api.request('/calc/api/sync/targets/'+encodeURIComponent(editing.existing.name)+'/test',{method:'POST',body:'{}'});msg.textContent=(r.ok?'✓ ':'✗ ')+r.message+(!r.ok&&/CERTIFICATE_VERIFY_FAILED/.test(r.message)?' — нажмите «Доверять сертификату этого сервера…» ниже.':'');}catch(e){msg.textContent=e.message;}});
   form.querySelector('[data-target-delete]')?.addEventListener('click',async()=>{if(!window.confirm('Удалить цель «'+editing.existing.name+'» и сохранённый токен?'))return;try{await api.request('/calc/api/sync/targets/'+encodeURIComponent(editing.existing.name),{method:'DELETE'});editing=null;await render();}catch(e){msg.textContent=e.message;}});
  }
  const tokenForm=body.querySelector('#pc-sync-token-form');
  if(tokenForm)tokenForm.addEventListener('submit',async event=>{event.preventDefault();const out=body.querySelector('#pc-sync-token-out');try{const r=await api.request('/calc/api/sync/tokens',{method:'POST',body:JSON.stringify({login:tokenForm.elements.login.value.trim(),name:tokenForm.elements.name.value.trim()})});out.innerHTML=`Токен (показан один раз): <code>${esc(r.token)}</code>`;}catch(e){out.textContent=e.message;}});
 }
 async function start(target,dryRun,confirm){
  const progress=dialog.querySelector('#pc-sync-progress'),result=dialog.querySelector('#pc-sync-result');result.textContent='';
  try{const {jobId}=await api.request('/calc/api/sync/push',{method:'POST',body:JSON.stringify({target,dryRun,confirm})});
   clearInterval(poll);poll=setInterval(async()=>{try{const job=await api.request('/calc/api/sync/push/'+jobId);
    progress.textContent=job.message+(job.progress?` · ${size(job.progress.sent)} из ${size(job.progress.total)}`:'');
    if(job.state!=='running'){clearInterval(poll);if(job.state==='failed')progress.textContent='Ошибка: '+job.error;else{progress.textContent=dryRun?'Проверка завершена: на сервере ничего не изменено.':'Отправка завершена.';result.innerHTML=summary(job.result);}}
   }catch(e){clearInterval(poll);progress.textContent=e.message;}},1000);
  }catch(e){progress.textContent=e.message;}
 }
 button.addEventListener('click',()=>{
  if(!dialog){dialog=document.createElement('dialog');dialog.id='pc-sync-dialog';dialog.innerHTML='<div class="pc-results-heading"><h2>Передача на серверы</h2><button type="button" aria-label="Закрыть" data-close>×</button></div><div class="pc-sync-body">Загрузка…</div>';dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>clearInterval(poll));document.body.append(dialog);}
  editing=null;dialog.showModal();void render();
 });
})();

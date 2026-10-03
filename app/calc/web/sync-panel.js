(()=>{
 const api=window.CalcZhBIAPI,button=document.getElementById('pc-sync-open');
 if(!button)return;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let dialog=null,poll=null;
 const size=n=>n>=1048576?(n/1048576).toFixed(1)+' МБ':Math.ceil(n/1024)+' КБ';
 // Кнопка видна тем, у кого есть раздел «Обмен данными калькулятора».
 api.ready().then(async user=>{try{await api.request('/calc/api/sync/state');button.hidden=false;}catch{button.hidden=true;}}).catch(()=>{});
 function summary(result){
  if(!result)return '';const r=result.report||result.plan?.report||result,p=r.products||{},n=r.norms||{};
  const part=(label,b)=>b?`<li>${label}: создано ${b.created}, обновлено ${b.updated}, без изменений ${b.unchanged}${b.serverPriority?.length?`, <strong>оставлено серверное: ${b.serverPriority.length}</strong>`:''}${b.senderOlder?.length?`, у отправителя старее: ${b.senderOlder.length}`:''}</li>`:'';
  return `<ul>${part('Изделия',p)}${part('Нормы',n)}${part('Профиль расчёта',r.profiles)}${r.attachmentsAdded!=null?`<li>Добавлено вложений: ${r.attachmentsAdded}</li>`:''}${result.assetsUpdated?`<li>Обновлено файлов исходников: ${result.assetsUpdated.length}</li>`:''}${result.assetsNeeded?`<li>К передаче: файлов исходников ${result.assetsNeeded.length}, вложений ${result.blobsNeeded.length}</li>`:''}</ul>`;
 }
 async function render(){
  const body=dialog.querySelector('.pc-sync-body');let state;
  try{state=await api.request('/calc/api/sync/state');}catch(e){body.textContent=e.message;return;}
  const targets=state.targets.map(t=>`<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.url)}</td><td>${t.tokenConfigured?'токен задан':'<em>токен не задан</em>'}</td><td><button data-dry="${esc(t.name)}" ${t.tokenConfigured?'':'disabled'}>Проверить</button> <button data-send="${esc(t.name)}" data-confirm="${t.requireConfirm}" ${t.tokenConfigured?'':'disabled'}>Отправить</button></td></tr>`).join('');
  const log=state.log.map(l=>`<tr><td>${esc(l.finished_at||l.started_at)}</td><td>${l.direction==='send'?'отправка':'приём'}${l.target?' → '+esc(l.target):''}</td><td>${esc(l.status)}</td></tr>`).join('');
  body.innerHTML=`<p class="pc-context">Проект ЖБИ: <strong>${esc(state.project?.zhbi_project_name||'не привязан')}</strong>. Источники (PDF, каталоги) на этом сервере: ${state.assetsPresent?'есть':'<strong>нет</strong>'}. Связь с тестовым и боевым серверами — только из-под VPN. При повторной отправке расчёты, изменённые на принимающем сервере, не перезаписываются.</p>
   ${state.targetsError?`<p class="pc-error">${esc(state.targetsError)}</p>`:''}
   ${targets?`<table class="pc-sync-table"><tbody>${targets}</tbody></table>`:'<p>Цели не настроены: создайте <code>data/calc/sync-targets.json</code> (см. Docs/calc-sync.md).</p>'}
   <div id="pc-sync-progress" class="pc-context" role="status" aria-live="polite"></div><div id="pc-sync-result"></div>
   ${state.canAdminister?`<details><summary>Токены приёма (для администратора)</summary><form id="pc-sync-token-form"><input name="login" placeholder="Логин пользователя с ролью «Калькулятор»" required> <input name="name" placeholder="Название токена" required> <button type="submit">Выдать токен</button></form><div id="pc-sync-token-out" class="pc-context"></div></details>`:''}
   <details><summary>Журнал обмена</summary><table class="pc-sync-table"><tbody>${log||'<tr><td>Пока пусто</td></tr>'}</tbody></table></details>`;
  body.querySelectorAll('[data-dry]').forEach(b=>b.addEventListener('click',()=>start(b.dataset.dry,true)));
  body.querySelectorAll('[data-send]').forEach(b=>b.addEventListener('click',()=>{let confirm;if(b.dataset.confirm==='true'){confirm=window.prompt(`Отправка на «${b.dataset.send}». Для подтверждения введите имя цели: ${b.dataset.send}`);if(confirm!==b.dataset.send)return;}start(b.dataset.send,false,confirm);}));
  const form=body.querySelector('#pc-sync-token-form');
  if(form)form.addEventListener('submit',async event=>{event.preventDefault();const out=body.querySelector('#pc-sync-token-out');try{const r=await api.request('/calc/api/sync/tokens',{method:'POST',body:JSON.stringify({login:form.elements.login.value.trim(),name:form.elements.name.value.trim()})});out.innerHTML=`Токен (показан один раз): <code>${esc(r.token)}</code>`;}catch(e){out.textContent=e.message;}});
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
  dialog.showModal();void render();
 });
})();

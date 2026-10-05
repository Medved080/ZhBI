// Общий помощник V1/V2/Калькулятора. История живёт в памяти этой вкладки.
const displayDate = value => String(value || "").split("-").reverse().join(".");
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export async function aiRequest(path, body, method = body === undefined ? "GET" : "POST") {
  const headers = {"Content-Type":"application/json"};
  try { const token = sessionStorage.getItem("zhbi_impersonate"); if (token) headers["X-Impersonate-Token"] = token; } catch {}
  const r = await fetch(path, {method, headers, credentials:"same-origin", body:body === undefined ? undefined : JSON.stringify(body)});
  let data; try { data = await r.json(); } catch { throw new Error(`Сервер вернул ответ ${r.status}`); }
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Проверьте параметры запроса (${r.status})`);
  return data;
}
function css() {
  if (document.querySelector("link[data-assistant-css]")) return;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/static/assistant.css"; link.dataset.assistantCss = "1"; document.head.append(link);
}
export function pageSnapshot(host) {
  if (!host) return {text:"", filters:""};
  const filters = [...host.querySelectorAll("input,select")].filter(e => !["password","hidden","file"].includes(e.type) && e.getClientRects().length && !e.closest("[data-assistant], [data-ai-settings]"));
  const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let text="",node;
  while((node=walker.nextNode())&&text.length<12000){const p=node.parentElement;
    if(p&&!p.closest("[data-assistant],script,style,input,textarea,select")&&p.getClientRects().length)text+=node.textContent.trim()+" ";
  }
  return {text:text.slice(0,12000), filters:filters.map(e => {
    const label = e.getAttribute("aria-label") || e.closest("label")?.innerText || e.name || e.id;
    const value = ["checkbox","radio"].includes(e.type) ? (e.checked ? "да" : "нет") : e.tagName === "SELECT" ? e.selectedOptions[0]?.textContent : e.value;
    return `${label}: ${value}`;
  }).join("; ").slice(0,3000)};
}
export function mountAssistant({getContext}) {
  if (document.querySelector("[data-assistant]")) return;
  css();
  const host=document.createElement("div");host.dataset.assistant="1";
  host.innerHTML=`<button type="button" class="ai-launch" aria-controls="ai-panel" aria-expanded="false">✦ ИИ-помощник</button>
    <section id="ai-panel" class="ai-panel" aria-label="ИИ-помощник" hidden>
      <header class="ai-heading"><div><strong>Помощник по строительству</strong><small>Локальная модель · данные сервиса</small></div><button type="button" data-ai-close aria-label="Свернуть помощника">×</button></header>
      <div class="ai-context" id="ai-context"></div>
      <form id="ai-form"><div class="ai-controls"><label>Область<select name="scope"><option value="page">Текущая страница</option><option value="object">Текущий объект</option><option value="project">Проект</option><option value="portfolio">Все доступные проекты</option></select></label><label id="ai-project-label" hidden>Проект<select name="project"></select></label></div>
      <div class="ai-controls"><label>Сравнить с<input name="from" type="date" required></label><label>На дату<input name="to" type="date" required></label></div>
      <div class="ai-messages" id="ai-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="ai-suggestions"><button type="button" data-question="Что изменилось за выбранный период?">Что изменилось?</button><button type="button" data-question="Где есть отставание от плана и что это подтверждает?">Отставание</button><button type="button" data-question="Какие позиции не обеспечены контрактами?">Дефицит</button></div>
      <label class="ai-question-label">Вопрос<textarea name="question" maxlength="4000" rows="3" required placeholder="Например: как изменились поставка и монтаж по проекту?"></textarea></label>
      <div class="ai-actions"><button type="submit" class="ai-send" title="Задать вопрос локальному помощнику">Отправить</button><button type="button" data-ai-stop hidden>Остановить</button><button type="button" data-ai-clear>Новый диалог</button></div>
      <p class="ai-status" id="ai-status" role="status"></p></form>
    </section>`;
  document.body.append(host);
  const $=s=>host.querySelector(s), form=$("#ai-form"), panel=$("#ai-panel"), launch=$(".ai-launch"), messages=$("#ai-messages"), status=$("#ai-status");
  let history=[], busy=false, requestId=null, generation=0, contextKey="", contextTimer;
  const iso=d=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  const now=new Date();form.elements.to.value=iso(now);form.elements.from.value=iso(new Date(now.getTime()-7*86400000));
  const say=t=>{status.textContent=t;};
  function controls() { for(const e of form.elements) if(e.name!=="question")e.disabled=busy;$("[data-ai-stop]").disabled=false;$("[data-ai-stop]").hidden=!busy;$(".ai-send").hidden=busy; }
  function append(role,text,result) {
    const item=document.createElement("article");item.className=`ai-message ai-message-${role}`;
    const name=document.createElement("strong");name.textContent=role==="user"?"Вы":"Помощник";
    const body=document.createElement("div");body.className="ai-answer";body.textContent=text;item.append(name,body);
    if(result){
      const stamp=document.createElement("small");stamp.textContent=`Данные: ${new Date(result.capturedAt).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})} МСК · ${displayDate(result.period.from)} → ${displayDate(result.period.to)} · ${result.model}`;item.append(stamp);
      for(const source of result.sources||[]){const a=document.createElement("a");a.textContent=`${source.title} · ${source.objectName}${source.scope==="page-filter"?" · отбор страницы":""}`;a.href=source.url;item.append(a);}
      for(const warning of result.warnings||[]){const p=document.createElement("small");p.className="ai-warning";p.textContent=warning;item.append(p);}
    }
    messages.append(item);messages.scrollTop=messages.scrollHeight;
  }
  async function stop() { const id=requestId;if(id){try{await aiRequest(`/assistant/requests/${id}/cancel`,{});}catch(e){say(e.message);}} }
  function reset(note="") { history=[];messages.replaceChildren();say(note); }
  function syncContext() {
    const ctx=getContext(), projects=ctx.projects||[], selected=form.elements.project.value;
    form.elements.scope.querySelector('[value="object"]').disabled=!ctx.objectId;
    form.elements.scope.querySelector('[value="project"]').disabled=!projects.length;
    if((form.elements.scope.value==="object"&&!ctx.objectId)||(form.elements.scope.value==="project"&&!projects.length))form.elements.scope.value="page";
    const selection=JSON.stringify([ctx.page?.filters,ctx.page?.selectedIds,ctx.page?.elementIds?.length,ctx.page?.elementIds?.reduce((h,id)=>(h*31+id)|0,0)]);
    const key=JSON.stringify([ctx.userId,ctx.objectId,ctx.page?.title,form.elements.scope.value,selected,form.elements.from.value,form.elements.to.value,selection]);
    if(contextKey&&key!==contextKey){generation++;void stop();busy=false;requestId=null;controls();reset("Область или период изменились — начат новый диалог.");}
    contextKey=key;
    $("#ai-context").textContent=ctx.label||ctx.page?.title||"Текущая страница";
    $("#ai-project-label").hidden=form.elements.scope.value!=="project";
    const signature=JSON.stringify(projects.map(p=>[p.id,p.name]));
    if(form.elements.project.dataset.signature!==signature){form.elements.project.innerHTML=projects.map(p=>`<option value="${Number(p.id)}">${esc(p.name)}</option>`).join("");form.elements.project.dataset.signature=signature;form.elements.project.value=selected||String(ctx.projectId||projects[0]?.id||"");contextKey=JSON.stringify([ctx.userId,ctx.objectId,ctx.page?.title,form.elements.scope.value,form.elements.project.value,form.elements.from.value,form.elements.to.value,selection]);}
    return ctx;
  }
  function close() {clearInterval(contextTimer);contextTimer=null;panel.hidden=true;launch.hidden=false;launch.setAttribute("aria-expanded","false");launch.focus();}
  async function open() {
    const dialog=[...document.querySelectorAll("dialog[open]")].at(-1);
    if(dialog&&host.parentElement!==dialog){dialog.append(host);dialog.addEventListener("close",()=>{if(host.isConnected)document.body.append(host);},{once:true});}
    panel.hidden=false;launch.hidden=true;launch.setAttribute("aria-expanded","true");syncContext();form.elements.question.focus();if(!contextTimer)contextTimer=setInterval(()=>syncContext(),1000);
    try{const config=await aiRequest("/assistant/status");if(!config.enabled||!config.configured)say("Модель помощника выбирается в «Администрирование → Интеграция с ИИ».");}catch(e){say(e.message);}
  }
  launch.addEventListener("click",open);
  window.addEventListener("zhbi:assistant-open",open);
  $("[data-ai-close]").addEventListener("click",close);
  panel.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();close();}if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();form.requestSubmit();}});
  for(const name of ["scope","project","from","to"])form.elements[name].addEventListener("change",syncContext);
  $("[data-ai-stop]").addEventListener("click",async()=>{await stop();say("Останавливаем запрос…");});
  $("[data-ai-clear]").addEventListener("click",()=>reset());
  host.querySelectorAll("[data-question]").forEach(b=>b.addEventListener("click",()=>{form.elements.question.value=b.dataset.question;form.elements.question.focus();}));
  form.addEventListener("submit",async e=>{
    e.preventDefault();if(busy)return;if(!form.reportValidity())return;
    const ctx=syncContext(),question=form.elements.question.value.trim();if(!question)return;
    if(form.elements.from.value>form.elements.to.value){say("Начало периода позже окончания.");return;}
    const body={question,scope:form.elements.scope.value,objectId:ctx.objectId||null,projectId:Number(form.elements.project.value)||ctx.projectId||null,dateFrom:form.elements.from.value,dateTo:form.elements.to.value,page:ctx.page||{},history:history.slice(-8)};
    const my=++generation;busy=true;controls();append("user",question);say("Подготавливаем данные и ждём локальную модель…");
    try{
      let result=await aiRequest("/assistant/requests",body);const id=result.id;
      if(my!==generation){void aiRequest(`/assistant/requests/${id}/cancel`,{}).catch(()=>{});return;}
      requestId=id;
      while(result.state==="running"){
        await new Promise(resolve=>setTimeout(resolve,1500));if(my!==generation)return;
        result=await aiRequest(`/assistant/requests/${id}`);
      }
      if(my!==generation)return;
      if(result.state!=="done")throw new Error(result.error||"Запрос остановлен");
      append("assistant",result.answer,result);history.push({role:"user",content:question.slice(0,6000)},{role:"assistant",content:result.answer.slice(0,6000)});history=history.slice(-8);if(form.elements.question.value.trim()===question)form.elements.question.value="";say("");
    }catch(error){if(my===generation)say(error.message);}
    finally{if(my===generation){busy=false;requestId=null;controls();}}
  });
  return {destroy(){generation++;void stop();clearInterval(contextTimer);window.removeEventListener("zhbi:assistant-open",open);host.remove();}};
}
// V2 монтирует помощника из оболочки после входа. Вложенные сцены используют кнопку родителя.
if(!document.getElementById("v2-root") && window.parent===window){
  let instance=null,bootGeneration=0;
  const boot = async () => {
    const version=++bootGeneration;
    try {
      const user=await aiRequest("/me");
      if(version!==bootGeneration||instance)return;
      instance=mountAssistant({getContext:()=>{
    const ctx=window.ZhbiAssistantContext?.()||window.CalcZhBIAssistantContext?.()||{};
    const visible=[...document.querySelectorAll("dialog[open], .backdrop")].filter(e=>e.getClientRects().length).at(-1);
    const body=visible||document.getElementById("precast-concept")||document.getElementById("app-root")||document.querySelector("main")||document.body;
    const snapshot=pageSnapshot(body);
    const page={title:ctx.title||document.title,...snapshot,...ctx.page};
    if(ctx.page?.text)page.text=(snapshot.text+"\n"+ctx.page.text).slice(0,12000);
    return {...ctx,userId:ctx.userId||user.id,page,label:ctx.label||ctx.title||document.title};
      }});
    }catch{}
  };
  boot();window.addEventListener("zhbi:assistant-ready",()=>{instance?.destroy();instance=null;void boot();});
  window.addEventListener("zhbi:assistant-logout",()=>{bootGeneration++;instance?.destroy();instance=null;});
}

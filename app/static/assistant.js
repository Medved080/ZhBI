// Общий помощник V1/V2/Калькулятора. История живёт в памяти этой вкладки.
const columnLabel = key => ({installed:"Смонтировано, шт.",delivered:"Поставлено, шт.",montage_change:"Монтаж за период, шт.",delivery_change:"Поставка за период, шт.",name:"Наименование",mark:"Марка",element_type:"Тип изделия",floor:"Этаж",quantity:"Количество",count:"Количество записей",current_status:"Статус",object_id:"Объект (ID)",id:"ID"}[key] || key);
const displayDate = value => String(value || "").split("-").reverse().join(".");
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
  host.innerHTML=`<button type="button" class="ai-launch" aria-controls="ai-panel" aria-expanded="false" title="Задать вопрос ИИ по данным сервиса">✦ ИИ</button>
    <section id="ai-panel" class="ai-panel" aria-label="ИИ-помощник" hidden>
      <header class="ai-heading"><div><strong>Помощник по строительству</strong><small>Локальная модель · данные сервиса</small></div><button type="button" data-ai-close aria-label="Свернуть помощника">×</button></header>
      <div class="ai-context" id="ai-context"></div>
      <form id="ai-form">
      <div class="ai-messages" id="ai-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="ai-suggestions"><button type="button" data-question="Что изменилось за последнюю неделю?">Что изменилось?</button><button type="button" data-question="Где есть отставание от плана и что это подтверждает?">Отставание</button><button type="button" data-question="Какие позиции не обеспечены контрактами?">Дефицит</button></div>
      <label class="ai-question-label">Вопрос<textarea name="question" maxlength="4000" rows="3" required placeholder="Например: сколько смонтировали по всем проектам за сентябрь?"></textarea></label>
      <div class="ai-actions"><button type="submit" class="ai-send" title="Задать вопрос локальному помощнику">Отправить</button><button type="button" data-ai-stop hidden>Остановить</button><button type="button" data-ai-clear>Новый диалог</button></div>
      <ol class="ai-progress" id="ai-progress" hidden aria-label="Этапы обработки"></ol>
      <p class="ai-status" id="ai-status" role="status"></p></form>
    </section>`;
  document.body.append(host);
  // верхним панелям — место под кнопку (assistant.css); размер и положение кнопки подгоняются под верхнюю панель своего интерфейса
  document.documentElement.classList.add("has-ai-launch");
  document.documentElement.dataset.aiHost = document.getElementById("v2-root") ? "v2" : document.getElementById("precast-concept") ? "calc" : "v1";
  const $=s=>host.querySelector(s), form=$("#ai-form"), panel=$("#ai-panel"), launch=$(".ai-launch"), messages=$("#ai-messages"), status=$("#ai-status");
  let lastResultId=null, history=[], busy=false, requestId=null, generation=0, contextKey="", contextTimer;
  const evidenceDialogs=new Set();
  async function showEvidence(source) {
    try {
      const data=await aiRequest(source.url);
      const box=document.createElement("dialog");box.dataset.assistant="evidence";box.className="ai-evidence";
      const title=document.createElement("strong");title.textContent=data.title;box.append(title);
      const note=document.createElement("p");note.textContent=`Получено строк: ${data.returnedRows}${data.truncated?" · показана часть списка":""}. Данные на ${new Date(data.capturedAt).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})} МСК.`;box.append(note);
      if(data.rows?.length){const table=document.createElement("table"),head=document.createElement("tr"),cols=Object.keys(data.rows[0]);for(const col of cols){const cell=document.createElement("th");cell.textContent=columnLabel(col);head.append(cell);}table.append(head);for(const row of data.rows){const tr=document.createElement("tr");for(const col of cols){const td=document.createElement("td");td.textContent=String(row[col]??"—");tr.append(td);}table.append(tr);}box.append(table);}else{const empty=document.createElement("p");empty.textContent="Подходящих строк в этой выборке нет.";box.append(empty);}
      const close=document.createElement("button");close.type="button";close.textContent="Закрыть";close.addEventListener("click",()=>box.close());box.append(close);box.addEventListener("close",()=>{evidenceDialogs.delete(box);box.remove();},{once:true});evidenceDialogs.add(box);
      const parent=host.closest("dialog[open]")||document.body;parent.append(box);box.showModal();
    } catch(error) {say(error.message);}
  }
  const steps=$("#ai-progress");
  const say=t=>{status.textContent=t;};
  function showProgress(result) {
    const p=result.progress;if(!p)return;
    steps.hidden=false;steps.replaceChildren();
    for(const step of [...(p.steps||[]),p]){
      const li=document.createElement("li");li.textContent=step.label;li.className=step===p?"ai-step-current":`ai-step-${step.state||"done"}`;steps.append(li);
    }
    steps.scrollTop=steps.scrollHeight;
    const state={connecting:"Соединяемся с сервером модели",waiting_first_token:"Ждём первые данные от модели",reasoning:"Модель рассуждает; результат ещё не получен",generating:"Получаем данные от модели"}[p.modelState]||"";
    say([`${Math.floor(result.elapsedSeconds||0)} с`,state,p.chars?`получено ${p.chars} знаков`:p.reasoningChars?`рассуждение: ${p.reasoningChars} знаков`:""].filter(Boolean).join(" · "));
  }
  function controls() { for(const e of form.elements) if(e.name!=="question")e.disabled=busy;$("[data-ai-stop]").disabled=false;$("[data-ai-stop]").hidden=!busy;$(".ai-send").hidden=busy; }
  function append(role,text,result) {
    const item=document.createElement("article");item.className=`ai-message ai-message-${role}`;
    const name=document.createElement("strong");name.textContent=role==="user"?"Вы":"Помощник";
    const body=document.createElement("div");body.className="ai-answer";body.textContent=text;item.append(name,body);
    if(result){
      const stamp=document.createElement("small");stamp.textContent=`Данные: ${new Date(result.capturedAt).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})} МСК${result.area?` · ${result.area}`:""} · ${displayDate(result.period.from)} → ${displayDate(result.period.to)}${result.period.label?` · ${result.period.label}`:""} · ${result.model}${result.provider==="red_mad_router"?" (облачный роутер)":""}`;item.append(stamp);
      for(const source of result.sources||[]){const a=document.createElement("a");a.textContent=`${source.title} · ${source.objectName}${source.scope==="page-filter"?" · отбор страницы":""}`;a.href=source.url;if(source.scope==="search")a.addEventListener("click",e=>{e.preventDefault();void showEvidence(source);});item.append(a);}
      for(const warning of result.warnings||[]){const p=document.createElement("small");p.className="ai-warning";p.textContent=warning;item.append(p);}
    }
    messages.append(item);messages.scrollTop=messages.scrollHeight;
  }
  async function stop() { const id=requestId;if(id){try{await aiRequest(`/assistant/requests/${id}/cancel`,{});}catch(e){say(e.message);}} }
  function reset(note="") { for(const dialog of evidenceDialogs)dialog.close();lastResultId=null;history=[];messages.replaceChildren();steps.hidden=true;steps.replaceChildren();say(note); }
  function syncContext() {
    const ctx=getContext();
    const selection=JSON.stringify([ctx.page?.filters,ctx.page?.selectedIds,ctx.page?.elementIds?.length,ctx.page?.elementIds?.reduce((h,id)=>(h*31+id)|0,0)]);
    const key=JSON.stringify([ctx.userId,ctx.objectId,ctx.page?.title,selection]);
    if(contextKey&&key!==contextKey){generation++;void stop();busy=false;requestId=null;controls();reset("Страница или отбор изменились — начат новый диалог.");}
    contextKey=key;
    $("#ai-context").textContent=ctx.label||ctx.page?.title||"Текущая страница";
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
  $("[data-ai-stop]").addEventListener("click",async()=>{await stop();say("Останавливаем запрос…");});
  $("[data-ai-clear]").addEventListener("click",()=>reset());
  host.querySelectorAll("[data-question]").forEach(b=>b.addEventListener("click",()=>{form.elements.question.value=b.dataset.question;form.elements.question.focus();}));
  form.addEventListener("submit",async e=>{
    e.preventDefault();if(busy)return;if(!form.reportValidity())return;
    const ctx=syncContext(),question=form.elements.question.value.trim();if(!question)return;
    const body={question,previousRequestId:lastResultId,objectId:ctx.objectId||null,projectId:ctx.projectId||null,page:ctx.page||{},history:history.slice(-8)};
    const my=++generation;busy=true;controls();append("user",question);steps.hidden=true;steps.replaceChildren();say("Отправляем вопрос…");
    try{
      let result=await aiRequest("/assistant/requests",body);const id=result.id;
      if(my!==generation){void aiRequest(`/assistant/requests/${id}/cancel`,{}).catch(()=>{});return;}
      requestId=id;
      if(form.elements.question.value.trim()===question)form.elements.question.value="";
      while(result.state==="running"){
        showProgress(result);
        await new Promise(resolve=>setTimeout(resolve,1500));if(my!==generation)return;
        result=await aiRequest(`/assistant/requests/${id}`);
      }
      if(my!==generation)return;
      if(result.state!=="done"){showProgress(result);throw new Error(result.error||"Запрос остановлен");}
      lastResultId=result.id;append("assistant",result.answer,result);history.push({role:"user",content:question.slice(0,6000)},{role:"assistant",content:(result.answer.slice(0,5400)+`\nПериод ответа: ${result.period.from} → ${result.period.to}. Область ответа: ${result.area||"доступные данные сервиса"}`).slice(0,6000)});history=history.slice(-8);steps.hidden=true;say("");
    }catch(error){if(my===generation)say(error.message);}
    finally{if(my===generation){busy=false;requestId=null;controls();}}
  });
  return {destroy(){for(const dialog of evidenceDialogs)dialog.close();generation++;void stop();clearInterval(contextTimer);window.removeEventListener("zhbi:assistant-open",open);document.documentElement.classList.remove("has-ai-launch");delete document.documentElement.dataset.aiHost;host.remove();}};
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
    const visible=[...document.querySelectorAll("dialog[open], .backdrop")].filter(e=>e.getClientRects().length&&!e.matches("[data-assistant]")).at(-1);
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

import {frame,errText} from "./admin-common.js";
import {esc} from "./screen-view.js";
import {aiRequest} from "../assistant.js";
export function mountAiSettings(el, {screen,groupTitle,api}) {
  const body=frame(el,screen,groupTitle);body.dataset.aiSettings="1";
  let config=null,dead=false,busy=false,dirty=false,timer;
  body.innerHTML=`<p role="status" id="ai-settings-status">Загрузка…</p><form id="ai-settings-form" hidden>
    <section class="v2-result"><h3>Сервер локального ИИ</h3><p class="v2-muted">Одно подключение для помощника и чтения чертежей. Адрес доступен с сервера ЖБИ; 127.0.0.1 означает сам сервер ЖБИ.</p>
    <div class="v2-inline"><label class="v2-field">Тип API<select name="provider"><option value="openai">OpenAI-совместимый (LM Studio, vLLM)</option><option value="ollama">Ollama</option></select></label>
    <label class="v2-field">Адрес API<input name="baseUrl" type="url" required maxlength="500" placeholder="http://192.168.1.10:1234/v1"></label></div>
    <p id="ai-key-note" class="v2-muted"></p><button type="button" class="v2-btn" data-ai-models>Получить список моделей</button><datalist id="ai-model-list"></datalist></section>
    <section class="v2-result"><h3>Модель помощника</h3><label class="v2-role-check"><input name="assistantEnabled" type="checkbox"><span>Помощник включён</span></label><label class="v2-field">Модель для диалога<input name="assistantModel" maxlength="200" list="ai-model-list" placeholder="Название установленной модели"></label><p class="v2-muted">Можно выбрать отдельную текстовую модель или ту же модель, что читает чертежи. Если две модели не помещаются в память, переключение между ними потребует загрузки.</p><label class="v2-field">Контекст диалога, токенов<input name="assistantContextTokens" type="number" min="8192" max="65536" required></label><p class="v2-muted">Это верхняя граница. Помощник использует компактные запросы с бюджетом до 8192 токенов, сохраняя доступ к данным через поиск. Контекст загруженной модели настраивается на её сервере.</p><button type="button" class="v2-btn" data-ai-test>Проверить диалог</button></section>
    <section class="v2-result"><h3>Модель чтения чертежей</h3><label class="v2-field">Модель с поддержкой изображений<input name="model" maxlength="200" list="ai-model-list"></label>
    <details><summary>Параметры обработки</summary><div class="v2-inline">${[["timeoutSeconds","Ожидание ответа, с",10,600],["maxTokens","Лимит ответа, токенов",512,32768],["imageSide","Сторона изображения, px",768,2000],["maxPages","Листов на изделие",1,60],["repairAttempts","Попыток исправления",0,2]].map(([name,label,min,max])=>`<label class="v2-field">${label}<input name="${name}" type="number" min="${min}" max="${max}" required></label>`).join("")}</div><label class="v2-role-check"><input name="useTiles" type="checkbox"><span>Читать увеличенные фрагменты</span></label></details>
    <p class="v2-muted" id="ai-drawing-note"></p><button type="button" class="v2-btn" data-ai-drawing>Проверить чтение изображения</button></section>
    <div class="v2-bar"><button type="submit" class="v2-btn v2-primary">Сохранить настройки</button><button type="button" class="v2-btn" data-ai-reload>Обновить настройки</button></div></form>`;
  const form=body.querySelector("form"),note=body.querySelector("#ai-settings-status");
  const say=t=>{if(!dead)note.textContent=t;};
  const lock=()=>{for(const e of form.elements)e.disabled=busy;};
  function fill(data){config=data;for(const [k,v] of Object.entries({...data.connection,assistantModel:data.assistantModel,assistantEnabled:data.assistantEnabled,assistantContextTokens:data.assistantContextTokens})){const e=form.elements[k];if(e)e.type==="checkbox"?e.checked=v:e.value=v;}form.hidden=false;dirty=false;body.querySelector("#ai-key-note").textContent=data.apiKeyConfigured?"Ключ API задан на сервере.":"Ключ API на сервере не задан; используется подключение без ключа.";body.querySelector("#ai-drawing-note").textContent=data.drawingProbe?.ok?"Чтение изображений и JSON проверено: "+data.drawingProbe.model:"Перед обработкой изделий выполните проверку изображения.";}
  async function load(){try{const d=await api.get("/ai/config");if(dead)return;fill(d);say("");}catch(e){say(errText(e));}}
  function connection(){const c={};for(const k of ["provider","baseUrl","model"])c[k]=form.elements[k].value.trim();for(const k of ["timeoutSeconds","maxTokens","imageSide","maxPages","repairAttempts"])c[k]=Number(form.elements[k].value);c.useTiles=form.elements.useTiles.checked;return c;}
  async function save(){if(!form.reportValidity())return false;const result=await api.put("/ai/config",{connection:connection(),assistantModel:form.elements.assistantModel.value.trim(),assistantEnabled:form.elements.assistantEnabled.checked,assistantContextTokens:Number(form.elements.assistantContextTokens.value),expectedRevision:config.revision});if(dead)return false;fill(result);return true;}
  async function act(fn){if(busy)return;if(!form.hidden&&!form.reportValidity())return;busy=true;lock();try{await fn();}catch(e){say(errText(e));}finally{busy=false;if(!dead)lock();}}
  form.addEventListener("input",()=>{dirty=true;});form.addEventListener("change",()=>{dirty=true;});
  form.addEventListener("submit",e=>{e.preventDefault();void act(async()=>{if(await save())say("Настройки сохранены.");});});
  body.querySelector("[data-ai-reload]").addEventListener("click",()=>{if(!dirty||confirm("Заменить введённые настройки сохранёнными?"))void act(load);});
  body.querySelector("[data-ai-models]").addEventListener("click",()=>void act(async()=>{say("Запрашиваем модели…");const d=await api.post("/ai/models",connection());if(dead)return;body.querySelector("#ai-model-list").innerHTML=d.models.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}${m.vision?" · поддерживает изображения":""}</option>`).join("");say(`Доступно моделей: ${d.models.length}. Выберите их в полях ниже.`);}));
  body.querySelector("[data-ai-drawing]").addEventListener("click",()=>void act(async()=>{
    if(!(await save()))return;say("Проверяем чтение изображения…");let s=await api.post("/ai/drawing-test",{});
    while(s.state==="running"&&!dead){await new Promise(r=>{timer=setTimeout(r,1500);});s=await api.get("/ai/drawing-test");say(`Идёт проверка изображения: ${s.elapsedSeconds||0} с. Модель может загружаться в память.`);}
    if(dead)return;if(s.state!=="done")throw new Error(s.error||"Проверка не завершена");await load();say("Чтение изображения проверено. "+s.result.note);
  }));
  body.querySelector("[data-ai-test]").addEventListener("click",()=>void act(async()=>{
    if(!(await save()))return;say("Проверяем диалог…");let s=await aiRequest("/ai/dialog-test",{});
    while(s.state==="running"&&!dead){await new Promise(r=>{timer=setTimeout(r,1500);});s=await aiRequest(`/assistant/requests/${s.id}`);}
    if(dead)return;if(s.state!=="done")throw new Error(s.error||"Проверка не завершена");say("Диалог проверен: "+s.answer);
  }));
  load();return{hasUnsavedChanges:()=>dirty,guardLeave:async()=>!busy&&(!dirty||confirm("Уйти без сохранения настроек ИИ?")),destroy(){dead=true;clearTimeout(timer);}};
}

// «Администрирование → Интеграция с ИИ» (V2). Страница — три последовательных шага (сервер → модель помощника → чтение чертежей) и необязательный
// облачный роутер. У каждой проверки результат стоит рядом с её кнопкой (раньше он писался в строку вверху страницы, которую при прокрутке не видно),
// панель сохранения закреплена внизу. Данные и запросы те же, что и раньше: /ai/config, /ai/models, /ai/drawing-test, /ai/dialog-test.
import { frame, errText } from "./admin-common.js";
import { esc } from "./screen-view.js";
import { aiRequest } from "../assistant.js";

const DRAWING_FIELDS = [["timeoutSeconds", "Ожидание ответа, с", 10, 600], ["maxTokens", "Лимит ответа, токенов", 512, 32768], ["imageSide", "Сторона изображения, px", 768, 2000],
  ["maxPages", "Листов на изделие", 1, 60], ["repairAttempts", "Попыток исправления", 0, 2]];

function ensureCss() {
  if (document.querySelector("link[data-ai-settings-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/ai-settings.css"; l.setAttribute("data-ai-settings-css", "1");
  document.head.appendChild(l);
}

export function mountAiSettings(el, { screen, groupTitle, api }) {
  ensureCss();
  const body = frame(el, screen, groupTitle);
  body.dataset.aiSettings = "1";
  let config = null, dead = false, busy = false, dirty = false, timer;
  body.innerHTML = `<div class="aip">
    <p class="aip-banner" id="ai-settings-status" role="status">Загрузка…</p>
    <form id="ai-settings-form" hidden>
      <ol class="aip-steps">
        <li class="aip-card wide">
          <div class="aip-head"><span class="aip-num">1</span><h3>Сервер локального ИИ</h3></div>
          <p class="aip-hint">Одно подключение для помощника и чтения чертежей. Адрес должен быть доступен с сервера ЖБИ; 127.0.0.1 означает сам сервер ЖБИ.</p>
          <div class="aip-row">
            <label class="v2-field">Тип API<select name="provider"><option value="openai">OpenAI-совместимый (LM Studio, vLLM)</option><option value="ollama">Ollama</option></select></label>
            <label class="v2-field grow">Адрес API<input name="baseUrl" type="url" required maxlength="500" placeholder="http://192.168.1.10:1234/v1"></label>
          </div>
          <div class="aip-check">
            <button type="button" class="v2-btn" data-ai-models>Получить список моделей</button>
            <div class="aip-result" id="ai-models-result" data-state="idle">Список моделей не запрашивался. Он подставится в поля выбора модели ниже.</div>
          </div>
          <p class="aip-hint" id="ai-key-note"></p>
          <datalist id="ai-model-list"></datalist>
        </li>
        <li class="aip-card">
          <div class="aip-head"><span class="aip-num">2</span><h3>Модель помощника</h3><label class="aip-switch"><input name="assistantEnabled" type="checkbox"><span>Включён</span></label></div>
          <p class="aip-hint" id="ai-router-active" hidden></p>
          <div class="aip-row">
            <label class="v2-field grow">Модель для диалога<input name="assistantModel" maxlength="200" list="ai-model-list" placeholder="Название установленной модели"></label>
            <label class="v2-field num">Контекст, токенов<input name="assistantContextTokens" type="number" min="8192" max="65536" required></label>
          </div>
          <details class="aip-more"><summary>Пояснения</summary>
            <p class="aip-hint">Можно выбрать отдельную текстовую модель или ту же, что читает чертежи. Если две модели не помещаются в память, переключение между ними потребует загрузки.</p>
            <p class="aip-hint">Контекст — верхняя граница. Помощник использует компактные запросы с бюджетом до 8192 токенов и получает данные через поиск. Контекст загруженной модели настраивается на её сервере.</p></details>
          <div class="aip-check">
            <button type="button" class="v2-btn" data-ai-test>Проверить диалог</button>
            <div class="aip-result" id="ai-test-result" data-state="idle">Проверка не выполнялась. Перед ней настройки сохраняются, помощнику задаётся короткий вопрос.</div>
          </div>
        </li>
        <li class="aip-card">
          <div class="aip-head"><span class="aip-num">3</span><h3>Чтение чертежей</h3></div>
          <div class="aip-row"><label class="v2-field grow">Модель с поддержкой изображений<input name="model" maxlength="200" list="ai-model-list" placeholder="Название установленной модели"></label></div>
          <details class="aip-more"><summary>Параметры обработки</summary>
            <div class="aip-grid">${DRAWING_FIELDS.map(([name, label, min, max]) => `<label class="v2-field">${label}<input name="${name}" type="number" min="${min}" max="${max}" required></label>`).join("")}
              <label class="aip-switch span"><input name="useTiles" type="checkbox"><span>Читать увеличенные фрагменты</span></label></div></details>
          <div class="aip-check">
            <button type="button" class="v2-btn" data-ai-drawing>Проверить чтение изображения</button>
            <div class="aip-result" id="ai-drawing-note" data-state="idle"></div>
          </div>
        </li>
      </ol>
      <div class="aip-savebar">
        <span class="aip-dirty" id="ai-dirty" role="status" aria-live="polite"></span>
        <button type="button" class="v2-btn" data-ai-reload hidden>Отменить изменения</button>
        <button type="submit" class="v2-btn v2-primary">Сохранить настройки</button>
      </div>
    </form>
    <details class="aip-card aip-optional" id="ai-router-card"><summary><span class="aip-num">4</span>Облачный роутер red_mad_robot <small>необязательно, настраивается и сохраняется отдельно</small></summary><div id="ai-router-host"></div></details>
  </div>`;
  const $ = (s) => body.querySelector(s);
  const form = $("form"), banner = $("#ai-settings-status"), dirtyEl = $("#ai-dirty");
  const say = (t, kind = "") => { if (dead) return; banner.textContent = t; banner.className = `aip-banner ${kind}`; };
  const result = (id, state, html) => { const n = $(id); if (n && !dead) { n.dataset.state = state; n.innerHTML = html; } };
  const paintDirty = () => {
    dirtyEl.textContent = dirty ? "Есть несохранённые изменения" : dirtyEl.dataset.saved || "";
    dirtyEl.classList.toggle("on", dirty);
    $("[data-ai-reload]").hidden = !dirty;
  };

  // Облачный роутер red_mad_robot — отдельный модуль со своими настройками, ключом и ревизией (app/rmr_api.py).
  let routerCtl = null, routerOn = false;
  import("./router-settings.js").then((m) => {
    if (dead) return;
    routerCtl = m.mountRouterSettings($("#ai-router-host"), { api, onState: (c) => {
      const e = $("#ai-router-active");
      routerOn = !!c.enabled;
      e.hidden = !c.enabled;
      e.textContent = c.enabled ? "Сейчас помощник отвечает через облачный роутер red_mad_robot (шаг 4). Поле «Модель для диалога» относится к локальной модели и не используется." : "";
      if (c.enabled) $("#ai-router-card").open = true;
    } });
  }).catch((e) => say(errText(e), "bad"));

  const lock = () => { for (const e of form.elements) e.disabled = busy; };
  function fill(data) {
    config = data;
    for (const [k, v] of Object.entries({ ...data.connection, assistantModel: data.assistantModel, assistantEnabled: data.assistantEnabled, assistantContextTokens: data.assistantContextTokens })) {
      const e = form.elements[k];
      if (e) e.type === "checkbox" ? (e.checked = v) : (e.value = v);
    }
    form.hidden = false; dirty = false; paintDirty();
    $("#ai-key-note").textContent = data.apiKeyConfigured ? "Ключ API локального сервера задан на сервере." : "Ключ API локального сервера не задан: используется подключение без ключа.";
    const probe = data.drawingProbe;
    if (probe?.ok) result("#ai-drawing-note", "ok", `<b>Чтение изображений и JSON проверено</b> на модели ${esc(probe.model)}.`);
    else result("#ai-drawing-note", "idle", "Проверка не выполнялась. Без неё обработка изделий недоступна.");
  }
  async function load() { try { const d = await api.get("/ai/config"); if (dead) return; fill(d); say(""); } catch (e) { say(errText(e), "bad"); } }
  function connection() {
    const c = {};
    for (const k of ["provider", "baseUrl", "model"]) c[k] = form.elements[k].value.trim();
    for (const k of ["timeoutSeconds", "maxTokens", "imageSide", "maxPages", "repairAttempts"]) c[k] = Number(form.elements[k].value);
    c.useTiles = form.elements.useTiles.checked;
    return c;
  }
  async function save() {
    if (!form.reportValidity()) return false;
    const r = await api.put("/ai/config", { connection: connection(), assistantModel: form.elements.assistantModel.value.trim(), assistantEnabled: form.elements.assistantEnabled.checked,
      assistantContextTokens: Number(form.elements.assistantContextTokens.value), expectedRevision: config.revision });
    if (dead) return false;
    const probe = $("#ai-drawing-note").dataset.state;                       // fill() сбрасывает итог проверки чтения чертежей по данным сервера
    fill(r);
    if (probe === "ok" && !r.drawingProbe?.ok) result("#ai-drawing-note", "idle", "Настройки изменились: проверку чтения изображения нужно повторить.");
    return true;
  }
  const savedNote = () => { dirtyEl.dataset.saved = `Сохранено в ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`; paintDirty(); };
  async function act(fn) {
    if (busy) return;
    if (!form.hidden && !form.reportValidity()) return;
    busy = true; lock();
    try { await fn(); } catch (e) { say(errText(e), "bad"); } finally { busy = false; if (!dead) lock(); }
  }
  // Проверки: сохраняют форму (проверять нужно то, что на экране), показывают ход и итог рядом с кнопкой
  const poll = async (first, next, onTick) => {
    let s = await first();
    while (s.state === "running" && !dead) { await new Promise((r) => { timer = setTimeout(r, 1500); }); s = await next(s); onTick(s); }
    return s;
  };

  form.addEventListener("input", () => { dirty = true; paintDirty(); });
  form.addEventListener("change", () => { dirty = true; paintDirty(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); void act(async () => { if (await save()) { savedNote(); say("Настройки сохранены.", "ok"); } }); });
  $("[data-ai-reload]").addEventListener("click", () => { if (confirm("Заменить введённые настройки сохранёнными?")) void act(load); });

  $("[data-ai-models]").addEventListener("click", () => void act(async () => {
    result("#ai-models-result", "run", "Запрашиваем список моделей…");
    try {
      const d = await api.post("/ai/models", connection());
      if (dead) return;
      $("#ai-model-list").innerHTML = d.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.vision ? " · поддерживает изображения" : ""}</option>`).join("");
      const vision = d.models.filter((m) => m.vision).length;
      result("#ai-models-result", d.models.length ? "ok" : "bad", d.models.length
        ? `<b>Сервер отвечает.</b> Доступно моделей: ${d.models.length}${vision ? `, с чтением изображений: ${vision}` : ""}. Выберите их в шагах 2 и 3 — подсказки появятся при вводе.`
        : "<b>Сервер ответил, но моделей не вернул.</b> Загрузите модель на сервере ИИ и повторите.");
    } catch (e) { result("#ai-models-result", "bad", `<b>Сервер не ответил.</b> ${esc(errText(e))}<span class="aip-quote">Проверьте тип API, адрес и что сервер ИИ доступен с сервера ЖБИ.</span>`); }
  }));

  $("[data-ai-test]").addEventListener("click", () => void act(async () => {
    // Очевидные причины отказа называем сразу, без обращения к серверу: сервер ответил бы общим «Помощник не настроен»
    if (!form.elements.assistantEnabled.checked) { result("#ai-test-result", "bad", "<b>Помощник выключен.</b> Включите переключатель «Включён» в шаге 2 и повторите проверку."); return; }
    if (!routerOn && !form.elements.assistantModel.value.trim()) { result("#ai-test-result", "bad", "<b>Не указана модель для диалога.</b> Выберите её в шаге 2 (список моделей запрашивается кнопкой в шаге 1)."); return; }
    result("#ai-test-result", "run", "Сохраняем настройки и задаём помощнику вопрос…");
    try {
      if (!(await save())) { result("#ai-test-result", "bad", "<b>Не проверено.</b> Заполните обязательные поля."); return; }
      savedNote();
      result("#ai-test-result", "run", "Помощнику задан вопрос, ждём ответ… Модель может загружаться в память.");
      const s = await poll(() => aiRequest("/ai/dialog-test", {}), (prev) => aiRequest(`/assistant/requests/${prev.id}`),
        (cur) => result("#ai-test-result", "run", `Ждём ответ модели: ${cur.elapsedSeconds || 0} с. Модель может загружаться в память.`));
      if (dead) return;
      if (s.state !== "done") throw new Error(s.error || "Помощник не ответил");
      const who = s.provider === "local" ? "Локальная модель" : "Облачный роутер";
      result("#ai-test-result", "ok", `<b>Диалог работает.</b> ${who} ${esc(s.model || "")} ответила за ${esc(String(s.elapsedSeconds ?? "—"))} с.<span class="aip-quote">«${esc(s.answer || "")}»</span>`);
    } catch (e) {
      result("#ai-test-result", "bad", `<b>Диалог не работает.</b> ${esc(errText(e))}<span class="aip-quote">Проверьте шаг 1 (адрес и доступность сервера) и что модель из поля «Модель для диалога» загружена на сервере ИИ.</span>`);
    }
  }));

  $("[data-ai-drawing]").addEventListener("click", () => void act(async () => {
    result("#ai-drawing-note", "run", "Сохраняем настройки и отправляем тестовое изображение…");
    try {
      if (!(await save())) { result("#ai-drawing-note", "bad", "<b>Не проверено.</b> Заполните обязательные поля."); return; }
      savedNote();
      const s = await poll(() => api.post("/ai/drawing-test", {}), () => api.get("/ai/drawing-test"),
        (cur) => result("#ai-drawing-note", "run", `Идёт проверка изображения: ${cur.elapsedSeconds || 0} с. Модель может загружаться в память.`));
      if (dead) return;
      if (s.state !== "done") throw new Error(s.error || "Проверка не завершена");
      await load();
      result("#ai-drawing-note", "ok", `<b>Чтение изображения работает.</b> ${esc(s.result.note || "")}`);
    } catch (e) {
      result("#ai-drawing-note", "bad", `<b>Чтение изображения не работает.</b> ${esc(errText(e))}<span class="aip-quote">Нужна модель с поддержкой изображений; проверьте её имя и шаг 1.</span>`);
    }
  }));

  load();
  return {
    hasUnsavedChanges: () => dirty || !!routerCtl?.hasUnsavedChanges(),
    guardLeave: async () => !busy && (!(dirty || routerCtl?.hasUnsavedChanges()) || confirm("Уйти без сохранения настроек ИИ?")),
    destroy() { dead = true; clearTimeout(timer); routerCtl?.destroy(); },
  };
}

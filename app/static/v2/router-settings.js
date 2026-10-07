// Облачный роутер red_mad_robot для ИИ-помощника: настройки, ключ, модели, проверка и блок «Стоимость и биллинг».
// Подключается из ai-settings.js отдельным модулем. Интерфейс блока стоимости перенесён из проекта «Радар тендеров».
// Ключ вводится сюда и обратно не показывается: сервер отдаёт только «задан / не задан» и источник.
import { errText } from "./admin-common.js";
import { esc } from "./screen-view.js";

const FIELDS = [["timeoutSeconds", "Ожидание ответа, с", 10, 600]];
const MODES = [["json_schema", "JSON по схеме (рекомендуется)"], ["json_object", "JSON-объект"], ["none", "Без формата"]];

export function mountRouterSettings(host, { api, onState = () => {} }) {
  let config = null, billing = null, dead = false, busy = false, dirty = false;
  host.innerHTML = `<section class="v2-result v2-rmr">
    <h3>Облачный роутер red_mad_robot</h3>
    <p class="v2-muted">Вместо локальной модели помощник может отвечать через облачный роутер: один ключ — модели разных поставщиков. Чтение чертежей Калькулятора остаётся на локальной модели.</p>
    <div class="v2-rmr-warn" role="note" data-rmr-notice></div>
    <form data-rmr-form hidden>
      <label class="v2-role-check"><input name="dataConsent" type="checkbox"><span>Подтверждаю: вопросы и выдержки данных сервиса уходят во внешнюю сеть, использование согласовано со службой ИБ.</span></label>
      <label class="v2-role-check"><input name="enabled" type="checkbox"><span>Помощник отвечает через роутер (вместо локальной модели)</span></label>
      <label class="v2-field">Адрес роутера<input name="baseUrl" type="url" required maxlength="500"></label>
      <p class="v2-muted">Менять адрес не нужно: допустим только узел rmrrouter.redmadrobot.com, запись без /v1 сервис приводит сам.</p>
      <div class="v2-inline"><label class="v2-field">Ключ роутера<input name="key" type="password" autocomplete="new-password" maxlength="400" placeholder="Вставьте персональный ключ"></label>
        <button type="button" class="v2-btn" data-rmr-key-save>Сохранить ключ</button><button type="button" class="v2-btn" data-rmr-key-clear>Удалить ключ</button></div>
      <p class="v2-muted" data-rmr-key-note></p>
      <label class="v2-field">Модель<input name="model" maxlength="200" list="rmr-model-list" placeholder="Точное имя, например openai/gpt-5-mini"></label><datalist id="rmr-model-list"></datalist>
      <div class="v2-inline"><button type="button" class="v2-btn" data-rmr-models>Получить список моделей</button><button type="button" class="v2-btn" data-rmr-test>Проверить подключение</button></div>
      <details><summary>Параметры обращения</summary><div class="v2-inline">
        ${FIELDS.map(([n, l, lo, hi]) => `<label class="v2-field">${l}<input name="${n}" type="number" min="${lo}" max="${hi}" required></label>`).join("")}
        <label class="v2-field">Формат ответа<select name="jsonMode">${MODES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
        <label class="v2-field">Параметр лимита<select name="tokenParameter"><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <label class="v2-field">Рассуждения<select name="thinking"><option value="auto">Как у модели</option><option value="off">Отключать</option></select></label></div>
        <p class="v2-muted">Несовместимость формата и параметра лимита сервис подбирает сам по ответу роутера; здесь задаётся то, с чего он начинает. «Отключать» снижает расход у рассуждающих моделей, но поддерживают его не все.</p></details>
      <div class="v2-bar"><button type="submit" class="v2-btn v2-primary">Сохранить настройки роутера</button></div>
    </form>
    <p role="status" data-rmr-status>Загрузка…</p>
    <details class="v2-rmr-bill" data-rmr-bill><summary>Стоимость и биллинг</summary>
      <p class="v2-muted" data-rmr-current></p>
      <div class="v2-inline"><input type="search" data-rmr-filter placeholder="Найти модель или поставщика…" autocomplete="off" aria-label="Фильтр моделей">
        <label class="v2-role-check"><input type="checkbox" data-rmr-chat checked><span>только текстовые</span></label>
        <label class="v2-role-check"><input type="checkbox" data-rmr-vat><span>с НДС</span></label></div>
      <div class="v2-rmr-wrap"><table class="v2-table v2-rmr-tbl"><thead><tr><th>Модель</th><th>Поставщик</th><th class="num">Вход, ₽</th><th class="num">Выход, ₽</th><th class="num">≈ за вопрос, ₽</th></tr></thead><tbody data-rmr-rows></tbody></table></div>
      <p class="v2-muted" data-rmr-note></p>
      <div data-rmr-usage></div>
    </details></section>`;
  const $ = (s) => host.querySelector(s);
  const form = $("[data-rmr-form]"), note = $("[data-rmr-status]");
  const say = (t) => { if (!dead) note.textContent = t; };
  const lock = () => { for (const e of [...form.elements, ...host.querySelectorAll("button")]) e.disabled = busy; if (!busy) sync(); };
  const num = (v, d) => (v == null ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const vat = () => ($("[data-rmr-vat]").checked ? 1 + ((billing && billing.vat_percent) || 22) / 100 : 1);
  const money = (v, d = 2) => (v == null ? "—" : num(v * vat(), d));
  const tok = (n) => (n >= 1e6 ? `${num(n / 1e6, 2)} млн` : n >= 1e3 ? `${num(n / 1e3, 1)} тыс.` : String(n));

  // «Помощник отвечает через роутер» имеет смысл только с подтверждённой передачей данных.
  function sync() {
    form.elements.enabled.disabled = busy || !form.elements.dataConsent.checked;
    if (!form.elements.dataConsent.checked) form.elements.enabled.checked = false;
  }
  function keyNote() {
    const k = config && config.key;
    $("[data-rmr-key-note]").textContent = !k || !k.configured ? "Ключ не задан. Получить ключ и пополнить баланс — на странице роутера."
      : k.source === "env" ? "Ключ задан в окружении сервера (ZHBI_RMR_API_KEY). Ввод в форме его заменит." : "Ключ сохранён на сервере в отдельном файле и обратно не показывается.";
    $("[data-rmr-key-clear]").hidden = !(k && k.source === "form");
  }
  function fill(data) {
    config = data;
    for (const [k, v] of Object.entries(data)) {
      const e = form.elements[k];
      if (!e || k === "key") continue;
      e.type === "checkbox" ? (e.checked = v) : (e.value = v);
    }
    $("[data-rmr-notice]").textContent = data.dataNotice;
    form.hidden = false; dirty = false; keyNote(); sync(); onState(data);
  }
  function values() {
    const v = { expectedRevision: config.revision };
    for (const k of ["enabled", "dataConsent"]) v[k] = form.elements[k].checked;
    for (const k of ["baseUrl", "model", "jsonMode", "tokenParameter", "thinking"]) v[k] = form.elements[k].value.trim();
    v.timeoutSeconds = Number(form.elements.timeoutSeconds.value);
    return v;
  }
  async function load() { try { fill(await api.get("/ai/router/config")); if (!dead) say(""); } catch (e) { say(errText(e)); } }
  async function save() {
    if (!form.reportValidity()) return false;
    const result = await api.put("/ai/router/config", values());
    if (dead) return false;
    fill(result); void loadBilling();
    return true;
  }
  async function act(fn) {
    if (busy) return;
    busy = true; lock();
    try { await fn(); } catch (e) { say(errText(e)); } finally { busy = false; if (!dead) lock(); }
  }

  // ---- блок «Стоимость и биллинг» ----
  function usageTable() {
    const u = billing.usage, f = vat();
    const row = (title, x, bold) => `<tr${bold ? ' class="v2-rmr-total"' : ""}><td>${title}</td><td class="num">${x.requests}</td><td class="num">${x.tokens_in.toLocaleString("ru-RU")}</td><td class="num">${x.tokens_out.toLocaleString("ru-RU")}</td>
      <td class="num">${x.unpriced >= x.requests && x.requests ? "нет в прайсе" : (x.unpriced && x.unpriced < x.requests ? '<sup title="по части вопросов цену определить нельзя: модели нет в прайсе">*</sup> ' : "") + num(x.rub * f, 2)}</td></tr>`;
    $("[data-rmr-usage]").innerHTML = `<p class="v2-muted">Баланс и пополнение — на странице роутера: <a href="${esc(billing.billing_url)}" target="_blank" rel="noopener noreferrer">${esc(billing.billing_url)} ↗</a>. Расход ниже — наша оценка по журналу, а не счёт роутера.</p>
      <div class="v2-rmr-wrap"><table class="v2-table v2-rmr-tbl"><thead><tr><th>Расход помощника</th><th class="num">Вопросов</th><th class="num">Токены вход</th><th class="num">Токены выход</th><th class="num">Стоимость, ₽ ${f > 1 ? "с НДС" : "без НДС"}</th></tr></thead><tbody>
      ${row("Последние 24 часа", u.day, true)}${row(`За ${u.days} дней`, u.period, true)}${u.models.map((m) => row(esc(m.model), m)).join("")}</tbody></table></div>`;
  }
  function currentLine() {
    const cur = billing && billing.models.find((m) => m.id === billing.current), box = $("[data-rmr-current]");
    if (!billing) { box.textContent = ""; return; }
    if (!form.elements.model.value.trim()) { box.textContent = "Выберите модель — здесь появится её тариф."; return; }
    if (!cur) { box.textContent = "Выбранной модели нет в прайс-листе: стоимость вопросов не определить, расход ниже покажет только токены."; return; }
    box.innerHTML = `Тариф <b>${esc(cur.id)}</b>: вход ${money(cur.input)} ₽, выход ${money(cur.output)} ₽ за 1 млн токенов${cur.cache_read != null ? `, чтение кэша ${money(cur.cache_read)} ₽` : ""} · ≈ <b>${money(cur.per_question, 3)} ₽ за вопрос</b> (до ${money(cur.per_question_max, 2)} ₽ при заполненном контексте).`;
  }
  function rows() {
    if (!billing) return;
    const q = $("[data-rmr-filter]").value.trim().toLowerCase(), chat = $("[data-rmr-chat]").checked, cur = form.elements.model.value.trim().toLowerCase();
    const list = billing.models.filter((m) => (!chat || m.kind === "chat") && (!q || `${m.id} ${m.provider}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.per_question ?? 1e9) - (b.per_question ?? 1e9));
    $("[data-rmr-rows]").innerHTML = list.map((m) => `<tr data-model="${esc(m.id)}" class="${m.id.toLowerCase() === cur ? "v2-rmr-cur" : ""}" tabindex="0"><td><b>${esc(m.id)}</b>${m.tier ? ` <small>${esc(m.tier)}</small>` : ""}</td><td>${esc(m.provider)}</td><td class="num">${money(m.input)}</td><td class="num">${money(m.output)}</td><td class="num">${money(m.per_question, 3)}</td></tr>`).join("")
      || '<tr><td colspan="5" class="v2-muted">Ничего не найдено</td></tr>';
    const a = billing.assumptions;
    $("[data-rmr-note]").innerHTML = `Цены из прайс-листа red_mad_robot, рубли за 1 млн токенов, наценка сервиса ${billing.markup_percent}% включена, ${$("[data-rmr-vat]").checked ? `НДС ${billing.vat_percent}% добавлен` : `НДС ${billing.vat_percent}% сверху (галочка «с НДС»)`}; курс ЦБ ${num(billing.fx_rate, 4)} на ${esc(billing.fx_date)}.
      «За вопрос» — оценка: ${tok(a.typical_in)} входных и ${tok(a.typical_out)} выходных токенов${a.measured ? " (среднее по вашим вопросам)" : " (типичный вопрос)"}; максимум — ${tok(a.max_in)} вх. при заполненном контексте. Клик по строке выбирает модель (затем сохраните настройки роутера).`;
  }
  async function loadBilling() {
    try { billing = await api.get("/ai/router/billing"); } catch (e) { $("[data-rmr-current]").textContent = errText(e); return; }
    if (dead) return;
    currentLine(); rows(); usageTable();
  }

  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("change", () => { dirty = true; sync(); });
  form.elements.model.addEventListener("input", () => { currentLine(); rows(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); void act(async () => { if (await save()) say("Настройки роутера сохранены."); }); });
  $("[data-rmr-key-save]").addEventListener("click", () => void act(async () => {
    const input = form.elements.key, key = input.value.trim();
    if (!key) { say("Вставьте ключ в поле."); return; }
    const r = await api.put("/ai/router/key", { key });
    input.value = ""; config = { ...config, key: r.key }; keyNote(); say("Ключ сохранён.");
  }));
  $("[data-rmr-key-clear]").addEventListener("click", () => void act(async () => {
    if (!confirm("Удалить сохранённый ключ роутера? Помощник через роутер перестанет отвечать, пока не будет задан новый.")) return;
    const r = await api.delete("/ai/router/key");
    config = { ...config, key: r.key }; keyNote(); say("Ключ удалён.");
  }));
  $("[data-rmr-models]").addEventListener("click", () => void act(async () => {
    say("Запрашиваем модели…");
    const d = await api.post("/ai/router/models", { baseUrl: form.elements.baseUrl.value.trim() });
    if (dead) return;
    $("#rmr-model-list").innerHTML = d.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
    say(`Доступно моделей: ${d.models.length}. Выберите модель в поле «Модель».`);
  }));
  $("[data-rmr-test]").addEventListener("click", () => void act(async () => {
    if (!(await save())) return;
    say("Проверяем подключение…");
    const r = await api.post("/ai/router/test", {});
    if (dead) return;
    void loadBilling();
    say(`Подключение работает: моделей на роутере ${r.models}, ответ за ${r.latencySeconds} с, ${r.usage.prompt + r.usage.completion} токенов${r.costRub != null ? `, ≈ ${num(r.costRub * vat(), 3)} ₽` : ""}.${r.modelListed ? "" : " Модели нет в списке роутера — проверьте имя."}`);
  }));
  $("[data-rmr-bill]").addEventListener("toggle", (e) => { if (e.target.open && !billing) void loadBilling(); });
  for (const s of ["[data-rmr-filter]", "[data-rmr-chat]", "[data-rmr-vat]"]) $(s).addEventListener("input", () => { rows(); currentLine(); if (billing) usageTable(); });
  const pick = (e) => { const tr = e.target.closest("tr[data-model]"); if (!tr) return; form.elements.model.value = tr.dataset.model; dirty = true; currentLine(); rows(); };
  $("[data-rmr-rows]").addEventListener("click", pick);
  $("[data-rmr-rows]").addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e); });

  load();
  return {
    hasUnsavedChanges: () => dirty,
    destroy() { dead = true; },
  };
}

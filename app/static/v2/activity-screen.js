import { esc } from "./screen-view.js";
import { errText } from "./admin-common.js";

const FIELDS = [
  ["category", "Категория", "eq"], ["subsystem", "Подсистема", "eq"],
  ["path", "Путь запроса"], ["status", "HTTP-статус", "number"],
  ["method", "HTTP-метод", "eq"], ["request_id", "Номер запроса / операции"],
  ["source", "Источник", "eq"], ["action", "Действие", "eq"],
  ["user_name", "Пользователь"], ["level", "Уровень", "eq"],
  ["logger", "Модуль"], ["exception_type", "Тип ошибки"],
  ["duration_ms", "Длительность от, мс", "number"], ["details", "Текст подробностей"],
  ["entity_type", "Тип сущности", "eq"], ["entity_id", "ID сущности", "number"],
  ["element_type", "Тип изделия", "eq"], ["subtype", "Подтип", "eq"],
  ["mark", "Марка"], ["old_value", "Было"], ["new_value", "Стало"],
  ["impersonator_name", "Выполнил администратор"], ["user_id", "ID пользователя", "number"],
  ["id", "ID события", "number"],
];
const SOURCES = { server: "Сервер", client: "Браузер", system: "Система" };
const localTime = (v) => {
  if (!v) return "";
  const d = new Date(String(v).replace(" ", "T") + "Z");
  return Number.isNaN(+d) ? v : d.toLocaleString("ru-RU", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  });
};
const utcBound = (v, end) => {
  const d = new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return d.toISOString().replace("T", " ").replace("Z", "");
};
function detailsOf(row) {
  try { return JSON.parse(row.details || "{}"); } catch { return { подробности: row.details }; }
}

export function mountActivityJournal(el, { api }) {
  let dead = false, seq = 0, offset = 0, total = 0, data = {}, applied = new URLSearchParams();
  el.innerHTML = `<div class="v2-container v2-container--wide v2-screen">
    <h2>Журнал действий и технических событий</h2>
    <p class="v2-muted">Ошибки запросов, предупреждения фоновых задач и изменения данных. Раскройте событие, чтобы увидеть причину и трассировку. Номер запроса связывает события одной операции.</p>
    <form id="aj-form">
      <div class="v2-bar"><label class="v2-field">С даты<input type="date" name="date_from"></label>
      <label class="v2-field">По дату<input type="date" name="date_to"></label>
      <label class="v2-field" style="flex:1">Поиск по всем полям<input name="text" type="search" placeholder="Причина ошибки, марка, номер запроса…"></label></div>
      <div class="v2-bar" role="group" aria-label="Быстрый отбор">
        <button type="button" class="v2-btn" data-preset="error">Ошибки</button>
        <button type="button" class="v2-btn" data-preset="calc">Калькулятор</button>
        <button type="button" class="v2-btn" data-preset="system">Системные события</button>
        <button type="button" class="v2-btn" id="aj-reset">Сбросить фильтры</button></div>
      <div class="aj-filters" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        ${FIELDS.slice(0, 6).map(fieldHtml).join("")}</div>
      <details style="margin:12px 0"><summary>Дополнительные поля событий</summary>
        <div class="aj-filters" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px">
          ${FIELDS.slice(6).map(fieldHtml).join("")}
          <label class="v2-field">Имя поля в подробностях<input name="detail_key" placeholder="Например: сообщение"></label>
          <label class="v2-field">Значение поля содержит<input name="detail_value"></label>
        </div></details>
      <div class="v2-bar" style="align-items:flex-end"><button class="v2-btn v2-primary" type="submit">Применить фильтры</button>
        <label class="v2-field">На странице<select name="limit"><option>50</option><option selected>100</option><option>200</option></select></label></div>
    </form>
    <p id="aj-status" role="status" aria-live="polite"></p>
    <div class="v2-bar"><button type="button" class="v2-btn" id="aj-prev">← Назад</button><span id="aj-page"></span><button type="button" class="v2-btn" id="aj-next">Вперёд →</button></div>
    <div id="aj-results" aria-busy="true"></div>
  </div>`;
  const $ = (s) => el.querySelector(s), form = $("#aj-form");
  function fieldHtml([key, title, kind]) {
    return `<label class="v2-field">${esc(title)}${kind === "eq"
      ? `<select name="${key}"><option value="">Любое</option></select>`
      : `<input name="${key}" type="${kind === "number" ? "number" : "text"}" ${kind === "number" ? `min="0" step="${key === "duration_ms" ? "any" : "1"}"` : ""}>`}</label>`;
  }
  function collect() {
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (String(v).trim()) q.set(k, String(v).trim());
    for (const key of ["date_from", "date_to"]) if (q.has(key)) q.set(key, utcBound(q.get(key), key === "date_to"));
    return q;
  }
  function label(key, v) {
    return (key === "action" ? data.action_titles?.[v] : key === "category" ? data.category_titles?.[v] : key === "source" ? SOURCES[v]
      : key === "subsystem" ? { calc: "Калькулятор", service: "Сервис ЖБИ" }[v] : null) || v;
  }
  function updateOptions() {
    for (const [key, , kind] of FIELDS) if (kind === "eq") {
      const select = form.elements.namedItem(key), current = select.value;
      const values = [...new Set([...(data.values?.[key] || []), ...(current && current !== "__none__" ? [current] : [])])];
      select.innerHTML = `<option value="">Любое</option><option value="__none__">Не заполнено</option>`
        + values.map(v => `<option value="${esc(v)}">${esc(label(key, v))}</option>`).join("");
      select.value = current;
    }
  }
  function paintRows() {
    $("#aj-results").innerHTML = !data.rows?.length ? '<p class="v2-muted">Событий не найдено.</p>' :
      `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${["Время", "Категория", "Пользователь / источник", "Действие", "Запрос", "HTTP", "мс", "Номер запроса", "Подробности"].map(t => `<th>${t}</th>`).join("")}</tr></thead><tbody>` + data.rows.map((r, index) => {
        const d = detailsOf(r);
        const cells = [localTime(r.at), label("category", r.category), r.user_name || SOURCES[r.source] || r.source,
          label("action", r.action), [r.method, r.path].filter(Boolean).join(" "), r.status ?? "", r.duration_ms ?? "", r.request_id || ""];
        return `<tr>${cells.map(c => `<td>${esc(String(c ?? ""))}</td>`).join("")}<td>
          <details><summary>${esc(String(d?.сообщение || r.new_value || r.mark || `Событие №${r.id}`).slice(0, 200))}</summary>
          ${r.request_id ? `<button type="button" class="v2-btn" data-related="${index}">Все события запроса</button>` : ""}
          <pre style="white-space:pre-wrap;overflow-wrap:anywhere;min-width:300px;max-width:760px">${esc(JSON.stringify({ ...r, details: d }, null, 2))}</pre>
          </details></td></tr>`;
      }).join("") + "</tbody></table></div>";
  }
  async function load() {
    const mine = ++seq, q = new URLSearchParams(applied);
    q.set("offset", offset);
    $("#aj-status").textContent = "Читаем журнал…";
    $("#aj-results").setAttribute("aria-busy", "true");
    $("#aj-prev").disabled = $("#aj-next").disabled = true;
    try {
      const result = await api.get(`/activity?${q}`);
      if (dead || mine !== seq) return;
      data = result; total = data.total;
      updateOptions(); paintRows();
      $("#aj-status").textContent = `Найдено событий: ${total.toLocaleString("ru-RU")}`;
      $("#aj-page").textContent = total ? `${offset + 1}–${offset + data.rows.length} из ${total.toLocaleString("ru-RU")}` : "0";
      $("#aj-prev").disabled = offset === 0;
      $("#aj-next").disabled = offset + data.rows.length >= total;
    } catch (e) {
      if (!dead && mine === seq) {
        $("#aj-status").textContent = `Не удалось прочитать журнал: ${errText(e)}`;
        $("#aj-results").innerHTML = "";
        $("#aj-page").textContent = "";
      }
    } finally { if (!dead && mine === seq) $("#aj-results").setAttribute("aria-busy", "false"); }
  }
  function apply() { offset = 0; applied = collect(); load(); }
  form.addEventListener("submit", e => { e.preventDefault(); apply(); });
  $("#aj-reset").addEventListener("click", () => { form.reset(); apply(); });
  el.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => {
    form.reset();
    const key = b.dataset.preset === "calc" ? "subsystem" : "category";
    const v = b.dataset.preset;
    const select = form.elements.namedItem(key);
    if (![...select.options].some(o => o.value === v)) select.add(new Option(v === "calc" ? "Калькулятор" : v === "error" ? "Ошибка" : "Система", v));
    select.value = v; apply();
  }));
  $("#aj-prev").addEventListener("click", () => { offset = Math.max(0, offset - Number(applied.get("limit") || 100)); load(); });
  $("#aj-next").addEventListener("click", () => { offset += Number(applied.get("limit") || 100); load(); });
  $("#aj-results").addEventListener("click", e => {
    const button = e.target.closest("[data-related]");
    if (!button) return;
    const r = data.rows[Number(button.dataset.related)];
    form.reset(); form.elements.namedItem("request_id").value = r.request_id; apply();
  });
  applied = collect(); load();
  return { hasUnsavedChanges: () => false, destroy() { dead = true; seq++; } };
}

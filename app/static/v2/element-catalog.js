// «Элементы» — табличный справочник изделий всех доступных объектов (перенос V1: app.js renderElementCatalog, renderEcDetail,
// openElementForm; форма `element-catalog-backdrop`). Что человек делает в V1 и что здесь то же:
//   • поиск по марке или адресу, «Сбросить отбор», служебные поля за галочкой (оси, координаты, слой, файл, UID, даты записи);
//   • сортировка щелчком по заголовку (▲/▼), отбор по каждой колонке: выпадающий список значений или подстрока, у любой
//     колонки — «Заполнено / Не заполнено»; страницы по 200 строк; статус с цветом, скрепка у изделий с вложениями;
//   • щелчок по строке — карточка изделия со статусами; двойной щелчок — форма реквизитов (при праве «Элементы: изменение»).
// Карточка — ТА ЖЕ, что у изделия на схеме рабочего места «Модель» (element-ops.js): смена статуса с предпросмотром последствий,
// правка и удаление записей истории, форма реквизитов, контракт, плановая дата, комментарий, вложения. Права — по объекту
// изделия (GET /me/permissions?object_id=…), как V1 считает их по объекту. Вся запись — через api.js и шлюз записи
// (write-gate.js: те же разрешённые маршруты /element-ops/*, /elements/{id}/fields, /elements/{id}/history/…).
// Кадра со схемой здесь нет: «Показать на схеме» открывает «Модель» с этим изделием (locate-handoff.js).
import { esc } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { ApiError } from "./api.js";
import { createElementOps } from "./element-ops.js";
import { requestLocate } from "./locate-handoff.js";

(() => {
  if (document.querySelector("link[data-ec-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/element-catalog.css"; l.setAttribute("data-ec-css", "1");
  document.head.appendChild(l);
})();

const PAGE = 200;
const FILLED = "__filled__", NONE = "__none__";            // сентинелы сервера (app/main.py: FILLED_SENTINEL, PLACEMENT_NONE_SENTINEL)
const STATE_KEY = "v2.elementCatalog";                     // отбор/страница/строка переживают переход на схему и «Назад»
const STATUSES = ["planned", "contracting", "in_production", "shipped", "delivered", "installed", "accepted"];
const STATUS_RU = { planned: "Запланирован", contracting: "Контрактация", in_production: "В производстве", shipped: "Отгружен", delivered: "Доставлен", installed: "Смонтирован", accepted: "Принят" };
const ZONE_STATUS_RU = { matched: "привязан", unmatched: "не определено", needs_review: "требует проверки", not_applicable: "неприменимо" };
const ATTACH = "📎";

// Колонки — тот же состав и порядок, что EC_COLUMNS в V1 (ключи обязаны совпадать с реестром _EC_SQL на сервере: чужой ключ — 400).
// filter — выпадающий список значений, text — подстрока; extra — служебные поля (за галочкой).
const COLUMNS = [
  { key: "object_name", label: "Объект", filter: true }, { key: "element_type", label: "Тип", filter: true }, { key: "subtype", label: "Подтип", filter: true },
  { key: "mark", label: "Марка", filter: true }, { key: "mark_ref", label: "Марка (справочник)", filter: true }, { key: "elevation_mm", label: "Отметка", filter: true },
  { key: "floor", label: "Этаж", filter: true }, { key: "address", label: "Адрес по осям", text: true }, { key: "current_status", label: "Статус", filter: true },
  { key: "planned_delivery_date", label: "План. поставка", text: true }, { key: "actual_delivery_date", label: "Факт. поставка", text: true },
  { key: "project_smr_start_date", label: "Начало СМР", text: true }, { key: "project_delivery_date", label: "Завершение СМР", text: true },
  { key: "contract_id", label: "Контракт", filter: true }, { key: "counterparty", label: "Контрагент", filter: true },
  { key: "zone_zakhvatka", label: "Захватка", filter: true }, { key: "zone_crane", label: "Кран", filter: true }, { key: "zone_stance", label: "Стоянка", filter: true },
  { key: "comment", label: "Комментарий", text: true }, { key: "attachments", label: ATTACH, icon: true },
  { key: "zone_zakhvatka_status", label: "Привязка к захватке", filter: true, extra: true }, { key: "zone_crane_status", label: "Привязка к крану", filter: true, extra: true },
  { key: "zone_stance_status", label: "Привязка к стоянке", filter: true, extra: true }, { key: "zone_stance_level_elevation_mm", label: "Ярус стоянки, мм", filter: true, extra: true },
  { key: "axis_status", label: "Адресация", filter: true, extra: true }, { key: "axis_number", label: "Ось цифровая", filter: true, extra: true },
  { key: "axis_letter", label: "Ось буквенная", filter: true, extra: true }, { key: "nearest_axis_number", label: "Ближайшая цифровая", filter: true, extra: true },
  { key: "nearest_axis_letter", label: "Ближайшая буквенная", filter: true, extra: true }, { key: "offset_x_mm", label: "Смещение X, мм", text: true, extra: true },
  { key: "offset_y_mm", label: "Смещение Y, мм", text: true, extra: true }, { key: "x", label: "X", text: true, extra: true }, { key: "y", label: "Y", text: true, extra: true },
  { key: "z", label: "Z", text: true, extra: true }, { key: "mark_source", label: "Источник марки", filter: true, extra: true }, { key: "layer", label: "Слой DXF", filter: true, extra: true },
  { key: "source_file", label: "Чертёж", filter: true, extra: true }, { key: "dxf_handle", label: "Handle в DXF", text: true, extra: true },
  { key: "element_uid", label: "UID", text: true, extra: true }, { key: "id", label: "№ в базе", text: true, extra: true },
  { key: "created_at", label: "Заведён", text: true, extra: true }, { key: "updated_at", label: "Изменён", text: true, extra: true },
];

const dateRu = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? ""); };
const momentRu = (v) => {
  const s = String(v ?? ""); if (!s) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};
const errText = (e) => (e instanceof ApiError ? (typeof e.detail === "string" ? e.detail : `Ошибка ${e.status}`) : String(e?.message || e));

function loadSaved() {
  try { const s = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null"); if (s && typeof s === "object") return s; } catch (e) { /* по умолчанию */ }
  return null;
}

export function mountElementCatalog(el, { screen, objectId, api, groupTitle, go, switchObject, hasObject }) {
  el.className = "v2-page";
  const saved = loadSaved();
  const S = { sort: "id", direction: "asc", offset: 0, filters: {}, search: "", extra: false, active: null, ...(saved || {}) };
  const D = { rows: [], total: 0, values: {}, contractNames: {}, loading: false, error: "", seq: 0 };
  const card = { id: null, el: null, detail: null, error: "", seq: 0, rightsObj: null };
  let colors = {}, contracts = null, dead = false, textTimer = null, searchTimer = null;
  const save = () => { try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ sort: S.sort, direction: S.direction, offset: S.offset, filters: S.filters, search: S.search, extra: S.extra, active: S.active })); } catch (e) { /* не критично */ } };
  const stLabel = (k) => STATUS_RU[k] || k || "—";
  const stColor = (k) => (/^#[0-9a-fA-F]{3,8}$/.test(colors[k] || "") ? colors[k] : "#9aa0a6");
  const valueLabel = (key, v) => {
    if (v === null || v === undefined || v === "") return "—";
    if (key === "current_status") return stLabel(v);
    if (key === "contract_id") return D.contractNames[v] || `контракт #${v}`;
    if (key.endsWith("_status")) return ZONE_STATUS_RU[v] || v;
    if (key === "created_at" || key === "updated_at") return momentRu(v);
    if (key.endsWith("_date")) return dateRu(v) || "—";
    if (typeof v === "number" && !Number.isInteger(v)) return String(Math.round(v * 10) / 10);   // координаты DXF — до десятой доли мм
    return String(v);
  };
  const visible = () => COLUMNS.filter((c) => S.extra || !c.extra);

  // ------------------------------------------------------------ карточка изделия (та же, что на схеме: element-ops.js)
  // Сцены нет: «выбранное изделие» — строка справочника + GET /elements/{id}; после записи перечитываются и карточка, и страница.
  const ops = createElementOps({
    api, groupOps: false,
    send: (cmd, args) => onOpsCommand(cmd, args),
    getScene: () => ({ selected: card.el, selectedId: card.id, statusOrder: STATUSES, multi: null, loaded: true, loading: false, total: 1 }),
    getObjectId: () => card.el?.object_id ?? objectId,
    statusLabel: stLabel, statusColor: stColor,
    repaint: () => paintCard(),
    reloadDetail: (id) => { if (id === card.id) loadCard(id, { keepForms: true }); },
    isDead: () => dead,
    getDetail: () => card.detail,
  });
  function onOpsCommand(cmd, args) {
    if (cmd === "getContracts") {
      const obj = card.el?.object_id ?? objectId;
      loadContracts().then((items) => ops.setContracts(obj, items)).catch(() => ops.setContracts(obj, []));
    } else if (cmd === "applyElements" || cmd === "patchComment" || cmd === "refreshElement" || cmd === "reload") {
      // запись прошла (или сверяется): перечитать страницу справочника и карточку — число/статусы строк могли измениться
      clearTimeout(onOpsCommand.t);
      onOpsCommand.t = setTimeout(() => { if (!dead) { loadRows(); if (card.id) loadCard(card.id, { keepForms: true }); } }, 150);
    }
    // select/locate/clearSelection — команды сцены; здесь сцены нет, выбор держит сам справочник
  }
  async function loadContracts() {
    if (contracts) return contracts;
    const list = await api.get("/contracts");
    contracts = (list || []).map((c) => ({ id: c.id, name: c.name, theme: c.theme, specification_id: c.specification_id, specification_number: c.specification_number, specification_date: c.specification_date,
      agreement_id: c.agreement_id, agreement_number: c.agreement_number, agreement_date: c.agreement_date, counterparty_id: c.counterparty_id, counterparty_short_name: c.counterparty_short_name,
      counterparty_code: c.counterparty_code, is_archived: !!c.is_archived }));
    return contracts;
  }
  // Поля карточки — в той форме, в какой их отдаёт кадр со схемой (embed-bridge.js: elementInfo)
  function cardElement(d, row) {
    const c = d.contract_id ? (contracts || []).find((x) => x.id === d.contract_id) : null;
    return { id: d.id, element_type: d.element_type, subtype: d.subtype, mark: d.mark, address: d.address, layer: d.layer, current_status: d.current_status, floor: d.floor,
      elevation_mm: d.elevation_mm, source_file: d.source_file, planned_delivery_date: d.planned_delivery_date, actual_delivery_date: d.actual_delivery_date,
      project_smr_start_date: d.project_smr_start_date, project_delivery_date: d.project_delivery_date, contract_id: d.contract_id, comment: d.comment, x: d.x, y: d.y, object_id: d.object_id,
      contractName: c?.name || (d.contract_id ? D.contractNames[d.contract_id] || row?.contract_name || null : null),
      supplier: c?.counterparty_short_name || (row && row.contract_id === d.contract_id ? row.counterparty : null) || null,
      zones: { zakhvatka: d.zone_zakhvatka_name || null, crane: d.zone_crane_name || null, stance: d.zone_stance_name || null } };
  }
  async function loadRights(obj) {
    if (card.rightsObj === obj) return;
    card.rightsObj = obj;
    try { const r = await api.get(`/me/permissions?object_id=${obj}`); if (!dead && card.rightsObj === obj) ops.setRights(r); }
    catch (e) { if (!dead && card.rightsObj === obj) ops.rightsFailed(); }
  }
  async function loadCard(id, { keepForms = false, openForm = false } = {}) {
    const seq = ++card.seq;
    if (!keepForms && card.id !== id) { card.detail = null; card.el = null; }
    card.id = id; card.error = "";
    paintCard();
    try {
      const d = await api.get(`/elements/${id}`);
      if (dead || seq !== card.seq) return;
      if (d.contract_id) await loadContracts().catch(() => null);
      if (dead || seq !== card.seq) return;
      card.detail = d; card.el = cardElement(d, D.rows.find((r) => r.id === id));
      await loadRights(d.object_id);
    } catch (e) {
      if (dead || seq !== card.seq) return;
      card.error = errText(e);
    }
    paintCard();
    if (openForm && card.el) el.querySelector('#ec-card [data-eo="ef-open"]')?.click();
  }

  // ------------------------------------------------------------ разметка
  el.innerHTML = `<div class="v2-container v2-screen v2-container--wide ec-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}</div>
    <div class="v2-bar ec-bar">
      <label class="v2-wire-field ec-search"><span>Поиск по марке или адресу</span><input type="search" id="ec-search" placeholder="например, 8Кв1 или 12/Б" value="${esc(S.search)}"></label>
      <button type="button" class="v2-btn" id="ec-reset">Сбросить отбор</button>
      <label class="v2-wire-check"><input type="checkbox" id="ec-extra" ${S.extra ? "checked" : ""}> Показывать служебные поля: оси, координаты, слой и файл чертежа, UID, даты записи</label>
    </div>
    <p class="v2-muted" id="ec-summary" role="status" aria-live="polite"></p>
    <div class="ec-split">
      <div class="ec-table-wrap" id="ec-table-wrap"><table class="v2-read-tbl ec-table" id="ec-table"></table></div>
      <aside class="ec-card" id="ec-card" aria-label="Карточка изделия"></aside>
    </div>
    <div class="v2-bar ec-pager"><button type="button" class="v2-btn" id="ec-prev">← Назад</button><span class="v2-muted" id="ec-page"></span><button type="button" class="v2-btn" id="ec-next">Вперёд →</button></div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  function paintCard() {
    if (dead) return;
    const box = $("#ec-card");
    const keep = box.scrollTop;
    const restore = ops.captureFocus(box);
    if (!card.id) box.innerHTML = `<div class="ws-pad"><p class="v2-muted">Щёлкните строку, чтобы увидеть статусы изделия. Двойной щелчок открывает форму изделия с правкой реквизитов (при праве «Элементы: изменение»).</p></div>`;
    else if (!card.el) box.innerHTML = card.error ? `<div class="ws-pad"><p class="v2-muted" role="alert">Не удалось загрузить изделие: ${esc(card.error)}</p></div>` : `<div class="ws-pad"><p class="v2-muted" role="status">Загрузка…</p></div>`;
    else box.innerHTML = ops.bannerHtml() + ops.cardHtml(card.el, { detail: card.detail, detailError: card.error });
    box.scrollTop = keep;
    box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.act === "locate") locate();
      else if (b.dataset.act === "clear-all") { S.active = null; save(); card.id = null; card.el = null; card.detail = null; paintRows(); paintCard(); }
    }));
    if (card.el) ops.bind(box);
    restore();
  }
  // «Показать на схеме» (V1: locateElementOnPlan из справочника) — рабочее место «Модель» выделяет изделие и наводит кадр
  async function locate() {
    const e = card.el; if (!e) return;
    const obj = e.object_id;
    if (obj !== objectId) {
      if (hasObject && !hasObject(obj)) return;
      if (!switchObject || !(await switchObject(obj))) return;
    }
    requestLocate({ objectId: obj, elementId: e.id });
    if (go) go("ws-model"); else location.hash = "#/ws-model";
  }

  function fillOptions(sel) {
    return [["", "— все —"], [FILLED, "Заполнено"], [NONE, "Не заполнено"]].map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");
  }
  function paintRows() {
    if (dead) return;
    const cols = visible();
    const head = cols.map((c) => {
      if (c.icon) return `<th class="ec-attach" title="Вложения" aria-label="Вложения">${c.label}</th>`;
      const arrow = S.sort === c.key ? (S.direction === "asc" ? " ▲" : " ▼") : "";
      return `<th><button type="button" class="ec-sort" data-sort="${c.key}" aria-label="Сортировать: ${esc(c.label)}">${esc(c.label)}${arrow}</button></th>`;
    }).join("");
    const filterRow = cols.map((c) => {
      if (c.icon) return `<td class="ec-attach"></td>`;
      const cur = S.filters[c.key] || "";
      const sent = cur === FILLED || cur === NONE ? cur : "";
      if (c.text) return `<td><select data-fill="${c.key}" aria-label="Заполненность: ${esc(c.label)}">${fillOptions(sent)}</select><input type="text" data-textfilter="${c.key}" placeholder="часть значения" aria-label="Отбор подстрокой: ${esc(c.label)}" ${sent ? "disabled" : ""} value="${esc(sent ? "" : cur)}"></td>`;
      const opts = fillOptions(sent) + (D.values[c.key] || []).map((v) => `<option value="${esc(String(v))}" ${String(v) === cur ? "selected" : ""}>${esc(valueLabel(c.key, v))}</option>`).join("");
      return `<td><select data-filter="${c.key}" aria-label="Отбор: ${esc(c.label)}">${opts}</select></td>`;
    }).join("");
    const body = D.rows.map((r) => `<tr data-id="${r.id}" class="${r.id === S.active ? "ec-active" : ""}" tabindex="0">${cols.map((c) => {
      if (c.icon) return `<td class="ec-attach" title="${r.attachments ? `вложений: ${r.attachments}` : ""}">${r.attachments ? ATTACH : ""}</td>`;
      if (c.key === "current_status") return `<td class="ec-nowrap"><span class="v2-swatch" style="background:${esc(stColor(r.current_status))}" aria-hidden="true"></span> ${esc(stLabel(r.current_status))}</td>`;
      if (c.key === "comment") return `<td class="ec-comment" title="${esc(r.comment || "")}">${esc(valueLabel(c.key, r[c.key]))}</td>`;
      return `<td>${esc(valueLabel(c.key, r[c.key]))}</td>`;
    }).join("")}</tr>`).join("");
    $("#ec-table").innerHTML = `<thead><tr>${head}</tr><tr class="ec-filters">${filterRow}</tr></thead><tbody>${body}</tbody>`;
    const from = D.total ? S.offset + 1 : 0, to = Math.min(S.offset + D.rows.length, D.total);
    $("#ec-summary").textContent = D.loading ? "Загрузка…" : D.error ? `Ошибка: ${D.error}` : `Найдено ${D.total}, показаны ${from}–${to}.`;
    $("#ec-page").textContent = `${from}–${to} из ${D.total}`;
    $("#ec-prev").disabled = S.offset === 0 || D.loading;
    $("#ec-next").disabled = to >= D.total || D.loading;
    bindRows();
  }
  function bindRows() {
    const t = $("#ec-table");
    t.querySelectorAll(".ec-sort").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      if (S.sort === k) S.direction = S.direction === "asc" ? "desc" : "asc"; else { S.sort = k; S.direction = "asc"; }
      S.offset = 0; loadRows();
    }));
    t.querySelectorAll("select[data-filter], select[data-fill]").forEach((s) => s.addEventListener("change", () => {
      S.filters[s.dataset.filter || s.dataset.fill] = s.value; S.offset = 0; loadRows();
    }));
    t.querySelectorAll("input[data-textfilter]").forEach((i) => i.addEventListener("input", () => {
      clearTimeout(textTimer);
      const k = i.dataset.textfilter, v = i.value.trim();
      // с задержкой: перерисовка перестраивает шапку, и без неё поле теряло бы фокус на каждой букве (как V1)
      textTimer = setTimeout(() => { S.filters[k] = v; S.offset = 0; loadRows().then(() => { const again = el.querySelector(`input[data-textfilter="${k}"]`); if (again) { again.focus(); again.setSelectionRange(v.length, v.length); } }); }, 400);
    }));
    t.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
      const id = Number(tr.dataset.id);
      const pick = (openForm) => {
        S.active = id; save();
        t.querySelectorAll("tbody tr").forEach((x) => x.classList.toggle("ec-active", x === tr));
        if (card.id !== id || openForm) loadCard(id, { openForm });
      };
      tr.addEventListener("click", () => pick(false));
      tr.addEventListener("dblclick", () => pick(true));   // двойной щелчок — форма реквизитов (как в V1)
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e.shiftKey); });
    });
  }

  async function loadRows() {
    const seq = ++D.seq;
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(S.offset), sort: S.sort, direction: S.direction });
    if (S.search) p.set("search", S.search);
    for (const [k, v] of Object.entries(S.filters)) if (v && (S.extra || !COLUMNS.find((c) => c.key === k)?.extra)) p.set(k, v);
    D.loading = true; D.error = ""; save();
    $("#ec-summary").textContent = "Загрузка…";
    try {
      const d = await api.get(`/element-catalog?${p.toString()}`);
      if (dead || seq !== D.seq) return;
      Object.assign(D, { rows: d.rows || [], total: d.total || 0, values: d.values || {}, contractNames: d.contract_names || {}, loading: false });
    } catch (e) {
      if (dead || seq !== D.seq) return;
      Object.assign(D, { loading: false, error: errText(e) });
    }
    paintRows();
  }

  $("#ec-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { S.search = v; S.offset = 0; loadRows(); }, 350);
  });
  $("#ec-reset").addEventListener("click", () => { S.filters = {}; S.search = ""; S.offset = 0; $("#ec-search").value = ""; loadRows(); });
  // Служебные колонки: снимая галочку, сбрасываем их отбор и сортировку — иначе таблица осталась бы отобранной по невидимой колонке (как V1)
  $("#ec-extra").addEventListener("change", (e) => {
    S.extra = e.target.checked;
    if (!S.extra) {
      COLUMNS.filter((c) => c.extra).forEach((c) => { delete S.filters[c.key]; });
      if (COLUMNS.some((c) => c.extra && c.key === S.sort)) { S.sort = "id"; S.direction = "asc"; }
    }
    S.offset = 0; loadRows();
  });
  $("#ec-prev").addEventListener("click", () => { S.offset = Math.max(0, S.offset - PAGE); loadRows(); });
  $("#ec-next").addEventListener("click", () => { S.offset += PAGE; loadRows(); });

  api.get("/status-colors").then((c) => { colors = c || {}; if (!dead) { paintRows(); paintCard(); } }).catch(() => { /* нейтральный серый */ });
  paintCard();
  loadRows().then(() => { if (S.active && !dead) loadCard(S.active); });

  return {
    hasUnsavedChanges: () => ops.hasUnsaved(),
    guardLeave: () => ops.guardLeave(),
    destroy() { dead = true; clearTimeout(textTimer); clearTimeout(searchTimer); clearTimeout(onOpsCommand.t); },
  };
}

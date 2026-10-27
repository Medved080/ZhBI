// Универсальный классификатор видов работ: три окна (Docs/TZ.md, «Классификатор видов
// работ»). Один модуль на V1 и V2 — свои стили под префиксом `wcl-` и свои кнопки, чтобы не
// зависеть от классов того или другого интерфейса; цвета берутся из переменных темы обоих.
//
// Зависимости передаются ЯВНО (глобалей у модуля нет): `api(path, opts)` — функция интерфейса,
// как у V1 (`fetch`-опции, разбор JSON, ошибка с текстом сервера). Права и текущий объект тоже
// приходят параметрами.
//
//   openWorkClassifier({ api, canWrite, container })   — справочник целиком, загрузка из xlsx;
//                                                         с `container` рисуется на странице (V2), без окна
//   openWorkStructurePicker({ api, objectId, canWrite, onSaved })  — набор позиций объекта
//   openCategoryMap({ api, objectId, canWrite, onSaved })          — категории модели объекта

const CSS = `
.wcl-backdrop { position: fixed; inset: 0; background: rgba(15,20,30,.45); z-index: 9000;
  display: flex; align-items: center; justify-content: center; }
.wcl-modal { --wcl-bg: var(--color-surface, var(--bg, #fff)); --wcl-bg2: var(--color-surface-2, var(--surface, #f7f8fa));
  --wcl-text: var(--color-text, var(--ink, #1a1d21)); --wcl-muted: var(--color-text-muted, var(--muted, #6b7280));
  --wcl-line: var(--color-border, var(--line, #dde1e6)); --wcl-accent: var(--color-primary, var(--accent, #1353d6));
  background: var(--wcl-bg); color: var(--wcl-text); border: 1px solid var(--wcl-line); border-radius: 12px;
  width: min(1100px, 96vw); height: min(780px, 92vh); display: flex; flex-direction: column;
  box-shadow: 0 12px 32px rgba(20,30,50,.25); font: 14px/1.4 system-ui, sans-serif; }
.wcl-modal.wcl-narrow { width: min(860px, 96vw); }
.wcl-modal.wcl-inline { width: 100%; height: calc(100vh - 190px); min-height: 480px; box-shadow: none; }
.wcl-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px 6px; }
.wcl-head h2 { margin: 0; font-size: 20px; flex: 1 1 auto; }
.wcl-hint { color: var(--wcl-muted); padding: 0 18px 8px; margin: 0; font-size: 13px; }
.wcl-bar { display: flex; align-items: center; gap: 8px; padding: 6px 18px 10px; flex-wrap: wrap; }
.wcl-bar > * { box-sizing: border-box; height: 32px; }
.wcl-bar input[type=search] { flex: 1 1 220px; min-width: 160px; padding: 0 10px; border: 1px solid var(--wcl-line);
  border-radius: 8px; background: var(--wcl-bg); color: inherit; }
.wcl-bar .wcl-grow { flex: 1 1 auto; }
.wcl-count { color: var(--wcl-muted); font-size: 13px; display: flex; align-items: center; }
.wcl-btn { padding: 0 14px; border-radius: 8px; border: 1px solid var(--wcl-line); background: var(--wcl-bg2);
  color: inherit; cursor: pointer; font: inherit; display: inline-flex; align-items: center; }
.wcl-btn:hover { border-color: var(--wcl-accent); }
.wcl-btn.wcl-primary { background: var(--wcl-accent); border-color: var(--wcl-accent); color: #fff; }
.wcl-btn[disabled] { opacity: .5; cursor: default; }
.wcl-body { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0 18px; border: 1px solid var(--wcl-line);
  border-radius: 8px; }
.wcl-foot { display: flex; align-items: center; gap: 8px; padding: 10px 18px 14px; }
.wcl-foot .wcl-status { flex: 1 1 auto; color: var(--wcl-muted); font-size: 13px; }
.wcl-foot .wcl-status.wcl-err { color: #c0392b; }
.wcl-table { width: 100%; border-collapse: collapse; }
.wcl-table th { position: sticky; top: 0; background: var(--wcl-bg2); text-align: left; padding: 6px 8px;
  font-weight: 600; font-size: 12px; color: var(--wcl-muted); border-bottom: 1px solid var(--wcl-line); z-index: 1; }
.wcl-table td { padding: 4px 8px; border-bottom: 1px solid var(--wcl-line); vertical-align: middle; }
.wcl-table tr.wcl-node td { background: var(--wcl-bg2); font-weight: 600; }
.wcl-toggle { width: 20px; height: 20px; border: 0; background: none; cursor: pointer; color: var(--wcl-muted);
  padding: 0; margin-right: 4px; vertical-align: middle; }
.wcl-toggle.wcl-empty { cursor: default; visibility: hidden; }
.wcl-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; margin: 1px 4px 1px 0;
  border-radius: 10px; background: color-mix(in srgb, var(--wcl-accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--wcl-accent) 35%, transparent); font-size: 12px; }
.wcl-chip button { border: 0; background: none; cursor: pointer; color: inherit; padding: 0; font-size: 13px; line-height: 1; }
.wcl-chip.wcl-off { background: none; border-color: var(--wcl-line); color: var(--wcl-muted); cursor: pointer; }
.wcl-chip.wcl-on { cursor: pointer; }
.wcl-edit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wcl-edit input { height: 28px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--wcl-line);
  border-radius: 6px; background: var(--wcl-bg); color: inherit; min-width: 160px; }
.wcl-iconbtn { border: 0; background: none; cursor: pointer; color: var(--wcl-muted); font-size: 14px; padding: 2px 4px; }
.wcl-iconbtn:hover { color: var(--wcl-accent); }
.wcl-summary { padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.wcl-summary .wcl-warn { color: #b9770e; }
.wcl-summary table { border-collapse: collapse; }
.wcl-summary td, .wcl-summary th { padding: 3px 12px 3px 0; text-align: left; font-size: 13px; }
.wcl-legend { display: flex; gap: 16px; flex-wrap: wrap; padding: 0 18px 8px; font-size: 12px; color: var(--wcl-muted); }
.wcl-legend i { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: -3px; margin-right: 5px;
  border: 1px solid var(--wcl-line); background: #9db4d8; }
.wcl-legend i.wcl-l1 { opacity: .25; }
.wcl-legend i.wcl-l2 { opacity: .75; border: 2px solid #39ff14; }
.wcl-cats { border-top: 1px solid var(--wcl-line); margin: 8px 18px 0; padding-top: 6px; font-size: 13px; }
.wcl-cats summary { cursor: pointer; color: var(--wcl-muted); }
`;

function ensureStyle() {
  if (document.getElementById("wcl-style")) return;
  const s = document.createElement("style");
  s.id = "wcl-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Окно: затемнение + карточка. Закрытие — кнопкой, Esc и щелчком мимо.
function makeModal(title, { narrow = false, container = null } = {}) {
  ensureStyle();
  const back = document.createElement("div");
  if (container) {
    // На странице (экран V2): без затемнения, заголовка и кнопки «Закрыть» — они у самой страницы.
    container.innerHTML = "";
    back.className = "wcl-inline-host";
    back.innerHTML = `<div class="wcl-modal wcl-inline"><div data-slot></div></div>`;
    container.appendChild(back);
    const slot = back.querySelector("[data-slot]");
    slot.style.cssText = "display:flex;flex-direction:column;flex:1 1 auto;min-height:0";
    return { back, slot, close() {} };
  }
  back.className = "wcl-backdrop";
  back.innerHTML = `<div class="wcl-modal${narrow ? " wcl-narrow" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="wcl-head"><h2>${esc(title)}</h2><button type="button" class="wcl-btn" data-close>Закрыть</button></div>
    <div data-slot></div></div>`;
  document.body.appendChild(back);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { document.removeEventListener("keydown", onKey); back.remove(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  back.querySelector("[data-close]").addEventListener("click", close);
  const slot = back.querySelector("[data-slot]");
  // Содержимое окна — колонкой на всю высоту карточки.
  slot.style.cssText = "display:flex;flex-direction:column;flex:1 1 auto;min-height:0";
  back.querySelector(".wcl-modal").appendChild(slot);
  return { back, slot, close };
}

// ------------------------------------------------------------------ дерево

function indexRows(rows) {
  const kids = new Map();
  const byId = new Map();
  for (const r of rows) {
    byId.set(r.id, r);
    const k = r.parent_id ?? 0;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }
  return { kids, byId };
}

function leafIdsUnder(idx, id, out = []) {
  const r = idx.byId.get(id);
  if (r && r.row_kind !== "узел") { out.push(id); return out; }
  for (const c of idx.kids.get(id) || []) leafIdsUnder(idx, c.id, out);
  return out;
}

// Видимые строки с учётом раскрытия и поиска: при поиске показываются совпавшие позиции и
// все их предки, раскрытие игнорируется.
function visibleRows(idx, expanded, query) {
  const q = query.trim().toLocaleLowerCase("ru");
  let keep = null;
  if (q) {
    keep = new Set();
    for (const r of idx.byId.values()) {
      const hay = `${r.name} ${r.code || ""} ${(r.categories || []).map((c) => c.name).join(" ")}`.toLocaleLowerCase("ru");
      if (!hay.includes(q)) continue;
      for (let cur = r; cur; cur = idx.byId.get(cur.parent_id)) keep.add(cur.id);
    }
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const r of idx.kids.get(parent) || []) {
      if (keep && !keep.has(r.id)) continue;
      out.push({ r, depth });
      if (r.row_kind === "узел" && (keep || expanded.has(r.id))) walk(r.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

function nameCell(r, depth, expanded, hasKids, query) {
  const open = !!query || expanded.has(r.id);
  const tg = r.row_kind === "узел" && hasKids
    ? `<button type="button" class="wcl-toggle" data-toggle="${r.id}" aria-label="${open ? "Свернуть" : "Развернуть"}">${open ? "▾" : "▸"}</button>`
    : `<button type="button" class="wcl-toggle wcl-empty" tabindex="-1"></button>`;
  const tag = r.row_kind === "веха" ? ' <span style="color:var(--wcl-muted);font-size:12px">веха</span>' : "";
  return `<td style="padding-left:${8 + depth * 18}px">${tg}${esc(r.name || "(без названия)")}${tag}</td>`;
}

function chips(list) {
  return (list || []).map((c) => `<span class="wcl-chip">${esc(c.name)}</span>`).join("") || '<span style="color:var(--wcl-muted)">—</span>';
}

// ---------------------------------------------------------- 1. справочник целиком

export async function openWorkClassifier({ api, canWrite, container = null }) {
  const m = makeModal("Классификатор видов работ", { container });
  m.slot.innerHTML = `
    <p class="wcl-hint">Один на все объекты. Из него объект набирает позиции в свою структуру работ.
      К операции привязывается любое число категорий элементов — по ним элементы модели
      окрашиваются состоянием работы в блоке.</p>
    <div class="wcl-bar">
      ${canWrite ? '<button type="button" class="wcl-btn wcl-primary" data-import>Загрузить из xlsx…</button>' : ""}
      <input type="file" accept=".xlsx" hidden data-file>
      <input type="search" placeholder="Поиск по названию, коду, категории" data-search aria-label="Поиск">
      <button type="button" class="wcl-btn" data-expand>Развернуть всё</button>
      <button type="button" class="wcl-btn" data-collapse>Свернуть всё</button>
    </div>
    <div class="wcl-body" data-body><div class="wcl-summary">Загрузка…</div></div>
    <details class="wcl-cats" data-cats><summary>Категории элементов</summary><div data-cats-list></div></details>
    <div class="wcl-foot"><span class="wcl-status" data-status></span></div>`;
  const q = (s) => m.slot.querySelector(s);
  const body = q("[data-body]"), status = q("[data-status]");
  const st = { data: null, idx: null, expanded: new Set(), query: "", editing: null, pending: null };
  const setStatus = (t, err = false) => { status.textContent = t || ""; status.classList.toggle("wcl-err", err); };

  async function reload() {
    st.data = await api("/work-classifier");
    st.idx = indexRows(st.data.rows);
    render();
    renderCategories();
  }

  function render() {
    if (!st.data.rows.length) {
      body.innerHTML = `<div class="wcl-summary">Классификатор пока пуст.${canWrite ? " Загрузите xlsx кнопкой выше." : ""}</div>`;
      return;
    }
    const rows = visibleRows(st.idx, st.expanded, st.query);
    const trs = rows.map(({ r, depth }) => {
      const hasKids = (st.idx.kids.get(r.id) || []).length > 0;
      let cats;
      if (r.row_kind === "узел") cats = "";
      else if (st.editing && st.editing.id === r.id) {
        cats = `<div class="wcl-edit">${st.editing.names.map((n, i) =>
          `<span class="wcl-chip">${esc(n)}<button type="button" data-chip-del="${i}" aria-label="Убрать">×</button></span>`).join("")}
          <input list="wcl-cat-list" data-cat-input placeholder="Категория, Enter" maxlength="120">
          <button type="button" class="wcl-btn" data-cat-save>Сохранить</button>
          <button type="button" class="wcl-btn" data-cat-cancel>Отмена</button></div>`;
      } else {
        cats = chips(r.categories) + (canWrite
          ? ` <button type="button" class="wcl-iconbtn" data-cat-edit="${r.id}" title="Категории элементов" aria-label="Категории элементов">✎</button>` : "");
      }
      return `<tr class="${r.row_kind === "узел" ? "wcl-node" : ""}">${nameCell(r, depth, st.expanded, hasKids, st.query)}
        <td>${esc(r.code || "")}</td><td>${esc(r.unit || "")}</td><td>${esc(st.data.tracks[r.planning_track_code] || r.planning_track_code || "")}</td>
        <td>${cats}</td></tr>`;
    }).join("");
    body.innerHTML = `<datalist id="wcl-cat-list">${st.data.categories.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist>
      <table class="wcl-table"><thead><tr><th>Вид работ</th><th>Код</th><th>Ед.</th><th>Трек</th><th>Категории элементов</th></tr></thead>
      <tbody>${trs || '<tr><td colspan="5" style="padding:14px;color:var(--wcl-muted)">Ничего не найдено</td></tr>'}</tbody></table>`;
    const inp = body.querySelector("[data-cat-input]");
    if (inp) inp.focus();
    const ops = st.data.rows.filter((r) => r.row_kind !== "узел").length;
    setStatus(`Позиций: ${ops}, категорий элементов: ${st.data.categories.length}`);
  }

  function renderCategories() {
    q("[data-cats-list]").innerHTML = st.data.categories.length
      ? st.data.categories.map((c) => `<span class="wcl-chip">${esc(c.name)} · ${c.works}${canWrite
        ? `<button type="button" data-cat-drop="${c.id}" title="Удалить категорию" aria-label="Удалить категорию ${esc(c.name)}">×</button>` : ""}</span>`).join("")
      : '<span style="color:var(--wcl-muted)">Категорий пока нет</span>';
  }

  m.slot.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.toggle) {
      const id = Number(t.dataset.toggle);
      st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id);
      render();
    } else if (t.hasAttribute("data-expand")) {
      for (const r of st.data.rows) if (r.row_kind === "узел") st.expanded.add(r.id);
      render();
    } else if (t.hasAttribute("data-collapse")) { st.expanded.clear(); render(); }
    else if (t.dataset.catEdit) {
      const r = st.idx.byId.get(Number(t.dataset.catEdit));
      st.editing = { id: r.id, names: (r.categories || []).map((c) => c.name) };
      render();
    } else if (t.dataset.chipDel !== undefined) {
      st.editing.names.splice(Number(t.dataset.chipDel), 1);
      render();
    } else if (t.hasAttribute("data-cat-cancel")) { st.editing = null; render(); }
    else if (t.hasAttribute("data-cat-save")) await saveEditing();
    else if (t.dataset.catDrop) {
      const c = st.data.categories.find((x) => x.id === Number(t.dataset.catDrop));
      if (!confirm(`Удалить категорию «${c.name}»? Она снимется со всех видов работ и из сопоставлений объектов.`)) return;
      try { await api(`/work-classifier/categories/${c.id}`, { method: "DELETE" }); await reload(); }
      catch (err) { setStatus(err.message, true); }
    } else if (t.hasAttribute("data-import")) q("[data-file]").click();
  });

  function addTyped(inp) {
    const v = inp.value.trim();
    if (v && !st.editing.names.some((n) => n.toLocaleLowerCase("ru") === v.toLocaleLowerCase("ru"))) st.editing.names.push(v);
    inp.value = "";
  }
  m.slot.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-cat-input]") && e.key === "Enter") { e.preventDefault(); addTyped(e.target); render(); }
  });
  async function saveEditing() {
    const inp = body.querySelector("[data-cat-input]");
    if (inp && inp.value.trim()) addTyped(inp);
    try {
      await api(`/work-classifier/${st.editing.id}/categories`, jsonOpts("PUT", { names: st.editing.names }));
      st.editing = null;
      await reload();
    } catch (err) { setStatus(err.message, true); }
  }
  q("[data-search]").addEventListener("input", (e) => { st.query = e.target.value; render(); });

  // ---- загрузка xlsx: разбор (ничего не пишет) → сводка → применение
  q("[data-file]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setStatus("Разбор файла…");
    const form = new FormData();
    form.append("file", file);
    try {
      st.pending = await api("/work-classifier/analyze", { method: "POST", body: form });
      showSummary();
    } catch (err) { setStatus(err.message, true); }
  });

  function showSummary() {
    const p = st.pending;
    const warn = (p.warnings || []).length
      ? `<div class="wcl-warn"><b>Предупреждения (${p.warnings.length})</b>${p.warnings.slice(0, 30).map((w) => `<div>• ${esc(w)}</div>`).join("")}</div>` : "";
    const cats = (p.categories || []).length
      ? `<table><thead><tr><th>Категория элементов</th><th></th><th>Операций</th></tr></thead><tbody>${p.categories.map((c) =>
        `<tr><td>${esc(c["категория"])}</td><td>${c["новая"] ? "новая" : ""}</td><td>${c["операций"]}</td></tr>`).join("")}</tbody></table>`
      : '<div style="color:var(--wcl-muted)">Листа «Elements» в файле нет — категории не меняются.</div>';
    body.innerHTML = `<div class="wcl-summary">${warn}
      <div>Строк в файле: <b>${p.total_rows}</b> · новых: <b>${p.new.length}</b> · вернутся из списанных: <b>${p.reviving.length}</b> ·
        без изменений: <b>${p.unchanged}</b></div>
      <div>Пропали из файла (будут списаны, на объектах они сохранятся): <b>${p.retiring.length}</b></div>
      <div>Треков планирования: <b>${(p.tracks || []).length}</b></div>
      <div><b>Категории элементов.</b> Загрузка только ДОБАВЛЯЕТ привязки к операциям; снять привязку можно только вручную.</div>${cats}
      <div class="wcl-edit"><button type="button" class="wcl-btn wcl-primary" data-apply>Применить</button>
        <button type="button" class="wcl-btn" data-apply-cancel>Отмена</button></div></div>`;
    setStatus("Разбор готов. Ничего не записано — проверьте сводку.");
    body.querySelector("[data-apply]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api("/work-classifier/apply", jsonOpts("POST", { token: st.pending.token }));
        st.pending = null;
        await reload();
        setStatus(`Готово: добавлено ${r.added}, возвращено ${r.revived}, списано ${r.retired}; категорий ${r.categories}, `
          + `привязок ${r.links}; позиций объектов связано с классификатором: ${r.linked_positions}.`);
      } catch (err) { ev.target.disabled = false; setStatus(err.message, true); }
    });
    body.querySelector("[data-apply-cancel]").addEventListener("click", () => { st.pending = null; render(); });
  }

  try { await reload(); } catch (err) { body.innerHTML = `<div class="wcl-summary">${esc(err.message)}</div>`; }
}

// ----------------------------------------------- 2. набор позиций в структуру объекта

export async function openWorkStructurePicker({ api, objectId, canWrite, onSaved }) {
  const m = makeModal("Структура работ объекта: набор из классификатора");
  m.slot.innerHTML = `
    <p class="wcl-hint">Отметьте позиции классификатора, которые есть на этом объекте. Раздел отмечается целиком
      одним щелчком. Позиции, добавленные на объект своим файлом и отсутствующие в классификаторе, не затрагиваются.</p>
    <div class="wcl-bar">
      <input type="search" placeholder="Поиск по названию, коду, категории" data-search aria-label="Поиск">
      <button type="button" class="wcl-btn" data-expand>Развернуть всё</button>
      <button type="button" class="wcl-btn" data-collapse>Свернуть всё</button>
      <span class="wcl-count" data-count></span>
    </div>
    <div class="wcl-body" data-body><div class="wcl-summary">Загрузка…</div></div>
    <div class="wcl-foot"><span class="wcl-status" data-status></span>
      ${canWrite ? '<button type="button" class="wcl-btn wcl-primary" data-save>Сохранить</button>' : ""}</div>`;
  const q = (s) => m.slot.querySelector(s);
  const body = q("[data-body]"), status = q("[data-status]");
  const st = { data: null, idx: null, expanded: new Set(), query: "", selected: new Set(), confirm: null };
  const setStatus = (t, err = false) => { status.textContent = t || ""; status.classList.toggle("wcl-err", err); };

  function nodeState(r) {
    const leaves = leafIdsUnder(st.idx, r.id);
    const n = leaves.filter((i) => st.selected.has(i)).length;
    return { n, total: leaves.length, all: n === leaves.length && n > 0, some: n > 0 && n < leaves.length };
  }

  function render() {
    const rows = visibleRows(st.idx, st.expanded, st.query);
    const trs = rows.map(({ r, depth }) => {
      const hasKids = (st.idx.kids.get(r.id) || []).length > 0;
      const s = r.row_kind === "узел" ? nodeState(r) : { all: st.selected.has(r.id), some: false, n: 0, total: 0 };
      const cb = `<input type="checkbox" data-pick="${r.id}" ${s.all ? "checked" : ""} ${s.some ? 'data-some="1"' : ""} ${canWrite ? "" : "disabled"}
        aria-label="${esc(r.name)}">`;
      const nm = nameCell(r, depth, st.expanded, hasKids, st.query).replace("</td>", "</td>");
      return `<tr class="${r.row_kind === "узел" ? "wcl-node" : ""}"><td style="width:28px;text-align:center">${cb}</td>${nm}
        <td>${esc(r.code || "")}</td><td>${esc(r.unit || "")}</td><td>${chips(r.categories)}</td></tr>`;
    }).join("");
    body.innerHTML = `<table class="wcl-table"><thead><tr><th></th><th>Вид работ</th><th>Код</th><th>Ед.</th><th>Категории элементов</th></tr></thead>
      <tbody>${trs || '<tr><td colspan="5" style="padding:14px;color:var(--wcl-muted)">Ничего не найдено</td></tr>'}</tbody></table>`;
    body.querySelectorAll("[data-some]").forEach((c) => { c.indeterminate = true; });
    const total = st.data.rows.filter((r) => r.row_kind !== "узел").length;
    q("[data-count]").textContent = `Выбрано ${st.selected.size} из ${total}`;
  }

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (t) { const id = Number(t.dataset.toggle); st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id); render(); }
  });
  body.addEventListener("change", (e) => {
    const c = e.target.closest("[data-pick]");
    if (!c || !canWrite) return;
    const r = st.idx.byId.get(Number(c.dataset.pick));
    const leaves = leafIdsUnder(st.idx, r.id);
    // Раздел при поиске переключает только видимые под ним позиции, иначе «отметить найденное»
    // отметило бы и всё, что поиск скрыл.
    const scope = st.query ? leaves.filter((i) => visibleSet().has(i)) : leaves;
    for (const i of scope) c.checked ? st.selected.add(i) : st.selected.delete(i);
    st.confirm = null;
    render();
  });
  function visibleSet() {
    return new Set(visibleRows(st.idx, st.expanded, st.query).map(({ r }) => r.id));
  }
  q("[data-search]").addEventListener("input", (e) => { st.query = e.target.value; render(); });
  m.slot.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-expand")) { for (const r of st.data.rows) if (r.row_kind === "узел") st.expanded.add(r.id); render(); }
    else if (t.hasAttribute("data-collapse")) { st.expanded.clear(); render(); }
    else if (t.hasAttribute("data-save")) await save(t);
    else if (t.hasAttribute("data-confirm-yes")) await commit(t);
    else if (t.hasAttribute("data-confirm-no")) { st.confirm = null; restoreFoot(); }
  });

  function restoreFoot() {
    q(".wcl-foot").innerHTML = `<span class="wcl-status" data-status></span><button type="button" class="wcl-btn wcl-primary" data-save>Сохранить</button>`;
    status.textContent = "";
  }

  // Сохранение в два шага: сначала сводка изменений (ничего не пишет), затем запись.
  async function save(btn) {
    btn.disabled = true;
    try {
      const ids = [...st.selected];
      const pv = await api(`/objects/${objectId}/work-structure/preview`, jsonOpts("POST", { ids }));
      if (!pv.adding && !pv.removing) { setStatus("Изменений нет."); btn.disabled = false; return; }
      st.confirm = ids;
      const parts = [];
      if (pv.adding) parts.push(`добавится позиций: ${pv.adding}`);
      if (pv.removing) parts.push(`уйдёт из структуры: ${pv.removing}` + (pv.removing_in_use
        ? ` (из них стоят в плане блоков или объекта: ${pv.removing_in_use}; проценты и сроки сохранятся)` : ""));
      q(".wcl-foot").innerHTML = `<span class="wcl-status" data-status>${esc(parts.join("; "))}. Применить?</span>
        <button type="button" class="wcl-btn" data-confirm-no>Назад</button>
        <button type="button" class="wcl-btn wcl-primary" data-confirm-yes>Применить</button>`;
    } catch (err) { setStatus(err.message, true); btn.disabled = false; }
  }
  async function commit(btn) {
    btn.disabled = true;
    try {
      const r = await api(`/objects/${objectId}/work-structure`, jsonOpts("PUT", { ids: st.confirm }));
      if (onSaved) await onSaved(r);
      m.close();
    } catch (err) {
      btn.disabled = false;
      q(".wcl-status").textContent = err.message;
      q(".wcl-status").classList.add("wcl-err");
    }
  }

  try {
    st.data = await api(`/objects/${objectId}/work-structure`);
    st.idx = indexRows(st.data.rows);
    st.selected = new Set(st.data.selected);
    if (!st.data.rows.length) {
      body.innerHTML = '<div class="wcl-summary">Классификатор пуст. Загрузите его в «Справочники → Классификатор видов работ».</div>';
      return;
    }
    render();
    if (st.data.own_positions) setStatus(`Своих позиций объекта вне классификатора: ${st.data.own_positions} — не затрагиваются.`);
  } catch (err) { body.innerHTML = `<div class="wcl-summary">${esc(err.message)}</div>`; }
}

// ------------------------------------- 3. сопоставление категорий с моделью объекта

export async function openCategoryMap({ api, objectId, canWrite, onSaved }) {
  const m = makeModal("Категории элементов: соответствие модели объекта", { narrow: true });
  m.slot.innerHTML = `
    <p class="wcl-hint">Для каждой категории классификатора отметьте категории модели этого объекта, к которым она относится.
      Элементы выбранных категорий будут окрашиваться состоянием работы в блоке.</p>
    <div class="wcl-legend"><span><i class="wcl-l1"></i>работа не начата — прозрачность 75%</span>
      <span><i class="wcl-l2"></i>работа идёт — прозрачность 25% и зелёные рёбра</span><span><i></i>завершена или работы нет — как обычно</span></div>
    <div class="wcl-body" data-body><div class="wcl-summary">Загрузка…</div></div>
    <div class="wcl-foot"><span class="wcl-status" data-status></span>
      ${canWrite ? '<button type="button" class="wcl-btn wcl-primary" data-save>Сохранить</button>' : ""}</div>`;
  const q = (s) => m.slot.querySelector(s);
  const body = q("[data-body]"), status = q("[data-status]");
  const setStatus = (t, err = false) => { status.textContent = t || ""; status.classList.toggle("wcl-err", err); };
  let data, map;

  function render() {
    if (!data.categories.length) {
      body.innerHTML = '<div class="wcl-summary">У набранных на объект видов работ нет категорий элементов. Привяжите их в «Справочники → Классификатор видов работ» '
        + 'и наберите соответствующие позиции в структуру работ объекта.</div>';
      return;
    }
    if (!data.model_categories.length) {
      body.innerHTML = '<div class="wcl-summary">В модели объекта нет элементов: загрузите выгрузку Revit или PDF.</div>';
      return;
    }
    body.innerHTML = `<table class="wcl-table"><thead><tr><th>Категория классификатора</th><th>Категории модели объекта</th></tr></thead><tbody>${
      data.categories.map((c) => `<tr><td style="width:36%">${esc(c.name)}<div style="color:var(--wcl-muted);font-size:12px">видов работ на объекте: ${c.works}</div></td>
        <td>${data.model_categories.map((mc) => {
          const on = (map[c.id] || []).includes(mc.name);
          return `<span class="wcl-chip ${on ? "wcl-on" : "wcl-off"}" role="button" tabindex="0" aria-pressed="${on}"
            data-cat="${c.id}" data-model="${esc(mc.name)}">${on ? "✓ " : ""}${esc(mc.name)} · ${mc.n}</span>`;
        }).join("")}</td></tr>`).join("")}</tbody></table>`;
  }

  function flip(chip) {
    if (!canWrite || !chip) return;
    const id = Number(chip.dataset.cat), name = chip.dataset.model;
    const cur = map[id] || (map[id] = []);
    const i = cur.indexOf(name);
    i >= 0 ? cur.splice(i, 1) : cur.push(name);
    render();
  }
  body.addEventListener("click", (e) => flip(e.target.closest("[data-cat]")));
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(e.target.closest("[data-cat]")); } });
  m.slot.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-save]");
    if (!t) return;
    t.disabled = true;
    try {
      const r = await api(`/objects/${objectId}/category-map`, jsonOpts("PUT", { map }));
      if (onSaved) await onSaved(r);
      m.close();
    } catch (err) { t.disabled = false; setStatus(err.message, true); }
  });

  try {
    data = await api(`/objects/${objectId}/category-map`);
    map = Object.fromEntries(Object.entries(data.map).map(([k, v]) => [k, [...v]]));
    render();
  } catch (err) { body.innerHTML = `<div class="wcl-summary">${esc(err.message)}</div>`; }
}

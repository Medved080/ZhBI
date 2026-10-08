// «Обмен данными с другим сервером» (2026-10-08): один модуль на V1 и V2. Серверная часть — app/data_exchange.py и
// app/data_exchange_api.py (сверка по естественным ключам, ссылочная целостность, копия базы перед применением).
//
// Поток: 1 подключение (адрес, логин и пароль администратора ДРУГОГО сервера) → 2 направление и разделы → 3 сверка
// (что будет добавлено / изменено / недоступно; отмечается группой одним щелчком или по записи) → 4 применение.
// Получение — одно подтверждение; ОТПРАВКА — двойное: сводка, затем ввод слова «ОТПРАВИТЬ» или имени сервера.
//
// Зависимости передаются явно (глобалей у ES-модуля нет): `request(method, path, body)` — запрос к ЭТОМУ серверу, возвращает
// разобранный JSON и бросает ошибку с понятным текстом (V1 — свой fetch-обёртка, V2 — api.js со шлюзом записи).
const ITEMS_PAGE = 300;
const CONFIRM_WORD = "ОТПРАВИТЬ";
const LS_KEY = "zhbi.serverExchange.last";
const STATE_TITLES = { new: "будет добавлено", changed: "изменено", blocked: "недоступно" };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");
const val = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

const CSS = `
.sx { --sx-line: var(--line, var(--color-border, #d9dee6)); --sx-bg: var(--bg, var(--color-surface, #fff)); --sx-surface: var(--surface, var(--color-surface-2, #f4f6f9));
  --sx-ink: var(--ink, var(--color-text, #222)); --sx-muted: var(--muted, var(--color-text-muted, #6b7280)); --sx-accent: var(--accent, var(--color-primary, #1f4fd8));
  --sx-accent-ink: var(--accent-ink, var(--color-on-primary, #fff)); --sx-soft: var(--sel, var(--color-accent-soft, #e8eefc)); --sx-bad: var(--bad, var(--color-danger, #b3261e));
  --sx-good: var(--good, #2e7d32); --sx-warn: #b45309; color: var(--sx-ink); font-size: 14px; }
.sx * { box-sizing: border-box; }
.sx-intro { color: var(--sx-muted); margin: 0 0 12px; }
.sx-card { border: 1px solid var(--sx-line); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: var(--sx-bg); }
.sx-card.sx-current { border-color: var(--sx-accent); box-shadow: 0 0 0 1px var(--sx-accent); }
.sx-card.sx-pending { opacity: .55; pointer-events: none; }
.sx-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.sx-num { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--sx-accent); color: var(--sx-accent-ink); font-size: 12px; font-weight: 700; flex: none; }
.sx-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 8px; }
.sx-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--sx-muted); min-width: 0; }
.sx-field input[type=text], .sx-field input[type=password], .sx-field input[type=url] { padding: 8px 10px; border: 1px solid var(--sx-line); border-radius: 8px; background: var(--sx-bg); color: var(--sx-ink); font: inherit; min-width: 14rem; }
.sx-btn { padding: 9px 16px; border: 1px solid transparent; border-radius: 10px; background: var(--sx-soft); color: var(--sx-accent); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
.sx-btn:hover:not(:disabled) { border-color: var(--sx-accent); }
.sx-btn:disabled { opacity: .5; cursor: default; }
.sx-btn-primary { background: var(--sx-accent); color: var(--sx-accent-ink); }
.sx-btn-danger { background: var(--sx-bad); color: #fff; }
.sx-btn-link { border: 0; background: none; color: var(--sx-accent); padding: 0 4px; cursor: pointer; font: inherit; }
.sx-muted { color: var(--sx-muted); }
.sx-hint { font-size: 12px; color: var(--sx-muted); margin: 4px 0 0; }
.sx-badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; background: var(--sx-bad); }
.sx-badge.sx-test { background: #d9480f; }
.sx-status { margin: 8px 0; padding: 8px 12px; border-left: 4px solid var(--sx-accent); background: var(--sx-surface); border-radius: 6px; font-size: 13px; overflow-wrap: anywhere; }
.sx-status.sx-bad { border-color: var(--sx-bad); color: var(--sx-bad); }
.sx-status.sx-ok { border-color: var(--sx-good); }
.sx-conn { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.sx-seg { display: inline-flex; border: 1px solid var(--sx-line); border-radius: 8px; overflow: hidden; }
.sx-seg button { border: 0; border-right: 1px solid var(--sx-line); background: var(--sx-bg); padding: 8px 14px; font: inherit; color: var(--sx-ink); cursor: pointer; }
.sx-seg button:last-child { border-right: 0; }
.sx-seg button[aria-pressed=true] { background: var(--sx-accent); color: var(--sx-accent-ink); }
.sx-sections { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 6px 14px; margin: 8px 0; }
.sx-check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.sx-check span small { display: block; color: var(--sx-muted); font-size: 12px; }
.sx-objects { max-height: 9rem; overflow: auto; border: 1px solid var(--sx-line); border-radius: 8px; padding: 6px 10px; margin: 6px 0; columns: 2 14rem; }
.sx-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sx-table th { text-align: left; font-weight: 500; color: var(--sx-muted); padding: 6px 8px; border-bottom: 1px solid var(--sx-line); white-space: nowrap; }
.sx-table td { padding: 6px 8px; border-bottom: 1px solid var(--sx-line); vertical-align: top; }
.sx-table td.sx-num-cell { white-space: nowrap; }
.sx-sec-row td { background: var(--sx-surface); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--sx-muted); }
.sx-cell { display: inline-flex; align-items: center; gap: 6px; }
.sx-cell button.sx-count { border: 0; background: none; font: inherit; font-weight: 600; color: var(--sx-accent); cursor: pointer; padding: 0 2px; text-decoration: underline dotted; }
.sx-cell.sx-blocked button.sx-count { color: var(--sx-bad); }
.sx-reasons { font-size: 12px; color: var(--sx-bad); margin-top: 2px; }
.sx-items { margin: 4px 0 8px 8px; border: 1px solid var(--sx-line); border-radius: 8px; max-height: 22rem; overflow: auto; }
.sx-item { display: flex; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--sx-line); align-items: flex-start; font-size: 13px; }
.sx-item:last-child { border-bottom: 0; }
.sx-item .sx-diff { font-size: 12px; color: var(--sx-muted); }
.sx-item .sx-diff b { color: var(--sx-ink); font-weight: 600; }
.sx-item .sx-prob { font-size: 12px; color: var(--sx-bad); }
.sx-item .sx-warn { font-size: 12px; color: var(--sx-warn); }
.sx-foot { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-top: 10px; position: sticky; bottom: 0; background: var(--sx-bg); padding: 10px 0 2px; border-top: 1px solid var(--sx-line); }
.sx-confirm { border: 2px solid var(--sx-bad); border-radius: 10px; padding: 12px 14px; margin: 10px 0; background: var(--sx-surface); }
.sx-confirm h4 { margin: 0 0 8px; font-size: 15px; }
.sx-progress { height: 8px; border-radius: 6px; background: var(--sx-surface); overflow: hidden; margin: 8px 0; }
.sx-progress > i { display: block; height: 100%; background: var(--sx-accent); transition: width .3s; }
.sx-facts { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 6px 0; font-size: 13px; }
.sx-facts dt { color: var(--sx-muted); } .sx-facts dd { margin: 0; font-weight: 600; }
.sx-calc dl { margin: 6px 0; }
`;

function ensureStyle() {
  if (document.getElementById("sx-style")) return;
  const s = document.createElement("style");
  s.id = "sx-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const errText = (e) => (e && (typeof e.detail === "string" ? e.detail : e.message)) || String(e);

export function mountServerExchange(el, { request, canWrite = true }) {
  ensureStyle();
  let dead = false, busy = false;
  const st = {
    conn: null, dir: "receive", sections: new Set(), objects: new Set(), analysis: null, calc: null,
    sel: { groups: new Set(), include: new Set(), exclude: new Set() }, itemGroup: new Map(),
    open: new Map(), result: null, confirm: 0, typed: "", status: null, job: null,
  };
  let remembered = {};
  try { remembered = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { remembered = {}; }

  el.classList.add("sx");
  el.innerHTML = `<p class="sx-intro">Обмен выбранными разделами между этим и другим сервером (тестовым или рабочим): справочники, статусы, документы контрактации, настройки,
    данные калькулятора. Сначала показывается СВЕРКА — что будет добавлено, изменено, чего нельзя принять и почему; применяется только отмеченное. Ничего не удаляется,
    существующее по умолчанию не перезаписывается, ссылки между записями проверяются. Перед применением принимающий сервер сохраняет копию базы.</p>
    <div id="sx-status"></div><div id="sx-c1"></div><div id="sx-c2"></div><div id="sx-c3"></div>`;
  const $ = (s) => el.querySelector(s);

  const setStatus = (text, kind = "") => {
    st.status = text ? { text, kind } : null;
    $("#sx-status").innerHTML = text ? `<div class="sx-status ${kind ? "sx-" + kind : ""}" role="status" aria-live="polite">${esc(text)}</div>` : "";
  };
  const run = async (label, fn) => {
    if (busy) return;
    busy = true; setStatus(label, ""); renderAll();
    try { return await fn(); } catch (e) { if (!dead) setStatus(errText(e), "bad"); }
    finally { busy = false; if (!dead) renderAll(); }
  };

  // ------------------------------------------------------------------ шаг 1: подключение
  function renderConnect() {
    const c = st.conn;
    const box = $("#sx-c1");
    if (!canWrite) { box.innerHTML = `<div class="sx-card"><p class="sx-muted">Обмен данными доступен администратору сервиса.</p></div>`; return; }
    if (c) {
      const srv = c.server || {};
      const test = srv.role === "test";
      box.innerHTML = `<div class="sx-card"><h4 class="sx-title"><span class="sx-num">1</span>Подключение</h4>
        <div class="sx-conn"><span>Подключено: <b>${esc(c.host)}</b> (${esc(c.url)}) · пользователь <b>${esc(c.login)}</b></span>
          <span class="sx-badge ${test ? "sx-test" : ""}">${test ? "ТЕСТОВЫЙ СЕРВЕР" : "РАБОЧИЙ / НЕ ТЕСТОВЫЙ СЕРВЕР"}</span>
          <span class="sx-muted">версия обработок: ${esc(srv.release || "—")}</span>
          <button type="button" class="sx-btn" data-act="disconnect" ${busy ? "disabled" : ""}>Отключиться</button></div>
        <p class="sx-hint">Пароль нигде не сохраняется; подключение закрывается через 30 минут без действий.</p></div>`;
      return;
    }
    box.innerHTML = `<div class="sx-card sx-current"><h4 class="sx-title"><span class="sx-num">1</span>Подключиться к другому серверу</h4>
      <form id="sx-form" autocomplete="off"><div class="sx-row">
        <label class="sx-field">Адрес сервера<input type="text" name="url" required placeholder="https://сервер или http://сервер:порт" value="${esc(remembered.url || "")}" list="sx-urls"></label>
        <label class="sx-field">Логин администратора<input type="text" name="login" required value="${esc(remembered.login || "")}" autocomplete="off"></label>
        <label class="sx-field">Пароль<input type="password" name="password" required autocomplete="new-password"></label>
        <button type="submit" class="sx-btn sx-btn-primary" ${busy ? "disabled" : ""}>Подключиться</button></div>
        <label class="sx-check"><input type="checkbox" name="insecure"><span>Не проверять сертификат (только для внутреннего сервера с самоподписанным сертификатом)</span></label></form>
      <p class="sx-hint">Нужна учётная запись администратора сервиса на том сервере. Связь с корпоративными серверами возможна только из-под VPN.</p></div>`;
  }

  // ------------------------------------------------------------------ шаг 2: направление и разделы
  function sectionList() {
    const base = (st.conn && st.conn.sections) || [];
    return [...base, { key: "calc", title: "Калькулятор", hint: "Изделия калькулятора, нормы, исходники и вложения (приоритет у данных принимающего сервера)." }];
  }
  function renderChoose() {
    const box = $("#sx-c2");
    if (!st.conn) { box.innerHTML = `<div class="sx-card sx-pending"><h4 class="sx-title"><span class="sx-num">2</span>Что обменивать</h4></div>`; return; }
    const objs = st.dir === "send" ? (st.localObjects || []) : (st.conn.objects || []);
    const current = !st.analysis && !st.result;
    box.innerHTML = `<div class="sx-card ${current ? "sx-current" : ""}"><h4 class="sx-title"><span class="sx-num">2</span>Что и в какую сторону обменивать</h4>
      <div class="sx-row"><div class="sx-seg" role="group" aria-label="Направление">
        <button type="button" data-dir="receive" aria-pressed="${st.dir === "receive"}">⬇ Получить с ${esc(st.conn.host)} на этот сервер</button>
        <button type="button" data-dir="send" aria-pressed="${st.dir === "send"}">⬆ Отправить с этого сервера на ${esc(st.conn.host)}</button></div></div>
      <div class="sx-sections">${sectionList().map((s) => `<label class="sx-check"><input type="checkbox" data-section="${esc(s.key)}" ${st.sections.has(s.key) ? "checked" : ""}>
        <span>${esc(s.title)}<small>${esc(s.hint || "")}</small></span></label>`).join("")}</div>
      <details><summary class="sx-muted">Только для некоторых объектов${st.objects.size ? ` (выбрано ${st.objects.size})` : " (по умолчанию все)"}</summary>
        <div class="sx-objects">${objs.map((o) => `<label class="sx-check"><input type="checkbox" data-object="${esc(o)}" ${st.objects.has(o) ? "checked" : ""}><span>${esc(o)}</span></label>`).join("") || '<span class="sx-muted">нет объектов</span>'}</div>
        <p class="sx-hint">Отбор применяется к записям, привязанным к объекту; общие настройки сервера при отборе не передаются. Объекты сопоставляются по названию.</p></details>
      <div class="sx-row" style="margin-top:8px"><button type="button" class="sx-btn sx-btn-primary" data-act="analyze" ${busy || !st.sections.size ? "disabled" : ""}>Сверить</button>
        <span class="sx-hint">Сверка ничего не меняет — только показывает расхождения.</span></div></div>`;
  }

  // ------------------------------------------------------------------ шаг 3: сверка
  const groupCount = (g) => g.count;
  function selectedTotal() {
    if (!st.analysis) return 0;
    let n = 0;
    const groups = new Map(st.analysis.groups.map((g) => [g.id, g]));
    for (const id of st.sel.groups) { const g = groups.get(id); if (g && g.state !== "blocked") n += groupCount(g); }
    for (const id of st.sel.exclude) { if (st.sel.groups.has(st.itemGroup.get(id))) n -= 1; }
    for (const id of st.sel.include) { if (!st.sel.groups.has(st.itemGroup.get(id))) n += 1; }
    return Math.max(0, n);
  }
  function applySelectionDefault() {
    st.sel = { groups: new Set(), include: new Set(), exclude: new Set() };
    for (const g of st.analysis.groups) if (g.state === "new") st.sel.groups.add(g.id);
  }
  const selectionBody = () => ({ groups: [...st.sel.groups], include: [...st.sel.include], exclude: [...st.sel.exclude] });
  const itemsPath = (gid, offset) => {
    const a = st.analysis;
    return st.dir === "send" && st.conn
      ? `/admin/data-exchange/remote/${st.conn.connection_id}/analysis/${a.analysis_id}/items?group=${encodeURIComponent(gid)}&offset=${offset}&limit=${ITEMS_PAGE}`
      : `/admin/data-exchange/analysis/${a.analysis_id}/items?group=${encodeURIComponent(gid)}&offset=${offset}&limit=${ITEMS_PAGE}`;
  };
  const changeText = (c) => `<b>${esc(c.field)}</b>: ${esc(val(c.was))} → ${esc(val(c.now))}`;

  function groupCell(g, kindGroups) {
    if (!g) return `<span class="sx-muted">—</span>`;
    const isOpen = st.open.has(g.id);
    const cb = g.state === "blocked" ? "" : `<input type="checkbox" data-group="${esc(g.id)}" ${st.sel.groups.has(g.id) ? "checked" : ""} aria-label="Отметить группу: ${esc(g.title)} — ${STATE_TITLES[g.state]}">`;
    return `<span class="sx-cell ${g.state === "blocked" ? "sx-blocked" : ""}">${cb}<button type="button" class="sx-count" data-open="${esc(g.id)}" aria-expanded="${isOpen}">${fmt(g.count)}</button></span>`
      + (g.state === "blocked" && g.reasons.length ? `<div class="sx-reasons">${g.reasons.map((r) => `${esc(r.text)} (${fmt(r.count)})`).join("<br>")}</div>` : "");
  }
  function itemsPanel(gid) {
    const o = st.open.get(gid);
    if (!o) return "";
    const rows = o.items.map((it) => {
      const selectable = it.state !== "blocked";
      const on = selectable && ((st.sel.groups.has(gid) && !st.sel.exclude.has(it.id)) || st.sel.include.has(it.id));
      const diffs = (it.changes || []).map(changeText).join("; ");
      return `<div class="sx-item">${selectable ? `<input type="checkbox" data-item="${esc(it.id)}" data-igroup="${esc(gid)}" ${on ? "checked" : ""}>` : '<span style="width:13px"></span>'}
        <div><div>${esc(it.label)}</div>${diffs ? `<div class="sx-diff">${diffs}</div>` : ""}
        ${(it.problems || []).map((p) => `<div class="sx-prob">✕ ${esc(p)}</div>`).join("")}${(it.warnings || []).map((p) => `<div class="sx-warn">⚠ ${esc(p)}</div>`).join("")}</div></div>`;
    }).join("");
    const more = o.items.length < o.total ? `<div class="sx-item"><button type="button" class="sx-btn-link" data-more="${esc(gid)}">Показать ещё (${fmt(o.total - o.items.length)})…</button></div>` : "";
    return `<tr class="sx-itemsrow"><td colspan="5"><div class="sx-items">${rows || '<div class="sx-item sx-muted">Загрузка…</div>'}${more}</div></td></tr>`;
  }
  function renderResult() {
    const box = $("#sx-c3");
    if (st.job) { box.innerHTML = jobHtml(); return; }
    if (st.result) { box.innerHTML = resultHtml(); return; }
    const a = st.analysis;
    if (!a) { box.innerHTML = `<div class="sx-card sx-pending"><h4 class="sx-title"><span class="sx-num">3</span>Сверка и применение</h4></div>`; return; }
    const kinds = a.kinds || [];
    const byKind = new Map();
    for (const g of a.groups) { if (!byKind.has(g.kind)) byKind.set(g.kind, {}); byKind.get(g.kind)[g.state] = g; }
    const secTitle = new Map((st.conn.sections || []).map((s) => [s.key, s.title]));
    let lastSec = null, rows = "";
    for (const k of kinds) {
      const sec = (a.groups.find((g) => g.kind === k.kind) || {}).section || (a.sectionOf || {})[k.kind];
      const gs = byKind.get(k.kind) || {};
      if (sec && sec !== lastSec) { rows += `<tr class="sx-sec-row"><td colspan="5">${esc(secTitle.get(sec) || sec)}</td></tr>`; lastSec = sec; }
      rows += `<tr><td>${esc(k.title)}</td><td class="sx-num-cell">${groupCell(gs.new)}</td><td class="sx-num-cell">${groupCell(gs.changed)}</td><td>${groupCell(gs.blocked)}</td><td class="sx-muted">${fmt((a.same || {})[k.kind])}</td></tr>`;
      for (const s of ["new", "changed", "blocked"]) if (gs[s] && st.open.has(gs[s].id)) rows += itemsPanel(gs[s].id);
    }
    const n = selectedTotal();
    const host = st.conn.host;
    const sending = st.dir === "send";
    const calcHtml = st.calc ? calcCardHtml() : "";
    box.innerHTML = `<div class="sx-card sx-current"><h4 class="sx-title"><span class="sx-num">3</span>Сверка: ${sending ? "что будет отправлено на" : "что будет получено с"} ${esc(host)}</h4>
      <p class="sx-hint">«Будет добавлено» отмечено по умолчанию, «изменено» (запись есть, но отличается) — нет: отметьте группу целиком одним щелчком или раскройте число и отметьте записи. «Недоступно» применить нельзя — в списке сказано почему.</p>
      <div class="sx-row"><button type="button" class="sx-btn" data-act="sel-new">Отметить все новые</button><button type="button" class="sx-btn" data-act="sel-all">Отметить всё доступное</button>
        <button type="button" class="sx-btn" data-act="sel-none">Снять всё</button></div>
      ${rows ? `<table class="sx-table"><thead><tr><th>Что</th><th>Будет добавлено</th><th>Изменено</th><th>Недоступно</th><th>Совпадает</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="sx-muted">Расхождений нет: выбранные разделы совпадают.</p>`}
      ${calcHtml}
      <div class="sx-foot"><span id="sx-selected">Отмечено записей: <b>${fmt(n)}</b>${st.calc && st.calc.include ? " + калькулятор" : ""}</span>
        <span><button type="button" class="sx-btn" data-act="reset">Начать заново</button>
        <button type="button" class="sx-btn sx-btn-primary" data-act="${sending ? "send-start" : "receive-start"}" ${busy || (!n && !(st.calc && st.calc.include)) ? "disabled" : ""}>${sending ? `Отправить отмеченное на ${esc(host)}…` : "Получить отмеченное"}</button></span></div>
      ${st.confirm ? confirmHtml(n) : ""}</div>`;
  }

  function calcCardHtml() {
    const c = st.calc;
    const r = c.report || {};
    const line = (t, b) => (b ? `<dt>${t}</dt><dd>создано ${b.created}, обновлено ${b.updated}, без изменений ${b.unchanged}${(b.serverPriority || []).length ? `, пропущено (приоритет принимающего сервера) ${b.serverPriority.length}` : ""}</dd>` : "");
    return `<div class="sx-card sx-calc" style="margin-top:10px"><label class="sx-check"><input type="checkbox" data-calc ${c.include ? "checked" : ""}><span><b>Калькулятор</b><small>Передаётся целиком; существующее на принимающем сервере не затирается (его правки в приоритете), ничего не удаляется.</small></span></label>
      <dl class="sx-facts">${line("Профили расчёта", r.profiles)}${line("Нормы", r.norms)}${line("Цены", r.prices)}${line("Изделия", r.products)}
        <dt>Файлы исходников</dt><dd>нужно передать ${fmt(c.assets_needed)}</dd><dt>Вложения</dt><dd>нужно передать ${fmt(c.blobs_needed)}</dd>
        <dt>Объём передачи</dt><dd>${esc(c.size_text || "—")}</dd></dl></div>`;
  }

  function confirmHtml(n) {
    const sending = st.dir === "send";
    const host = st.conn.host, test = (st.conn.server || {}).role === "test";
    const what = `${fmt(n)} записей${st.calc && st.calc.include ? " и данные калькулятора" : ""}`;
    if (!sending) {
      return `<div class="sx-confirm"><h4>Применить к ЭТОЙ базе ${esc(what)}?</h4><p>Данные получены с <b>${esc(host)}</b>. Перед применением этот сервер сохранит копию базы; записи, у которых не хватает родителя, будут пропущены с объяснением, при нарушении целостности применение откатится целиком.</p>
        <button type="button" class="sx-btn sx-btn-primary" data-act="receive-apply" ${busy ? "disabled" : ""}>Применить</button> <button type="button" class="sx-btn" data-act="confirm-cancel">Отмена</button></div>`;
    }
    if (st.confirm === 1) {
      return `<div class="sx-confirm"><h4>Подтверждение 1 из 2: отправка на другой сервер</h4>
        <dl class="sx-facts"><dt>Куда</dt><dd>${esc(st.conn.url)} <span class="sx-badge ${test ? "sx-test" : ""}">${test ? "тестовый" : "РАБОЧИЙ / НЕ ТЕСТОВЫЙ"}</span></dd><dt>Что</dt><dd>${esc(what)}</dd>
        <dt>Как</dt><dd>только отмеченное; ничего не удаляется; существующее не отмеченное не перезаписывается</dd></dl>
        ${test ? "" : `<p style="color:var(--sx-bad);font-weight:600">⚠ Принимающий сервер не помечен как тестовый — это может быть рабочая база.</p>`}
        <button type="button" class="sx-btn sx-btn-primary" data-act="confirm-next">Продолжить →</button> <button type="button" class="sx-btn" data-act="confirm-cancel">Отмена</button></div>`;
    }
    const need = host;
    const ok = [CONFIRM_WORD.toLowerCase(), need.toLowerCase()].includes(st.typed.trim().toLowerCase());
    return `<div class="sx-confirm"><h4>Подтверждение 2 из 2: введите «${CONFIRM_WORD}» или имя сервера «${esc(need)}»</h4>
      <p>Данные будут записаны в базу сервера <b>${esc(host)}</b>. Откатить можно только из копии базы, которую сервер снимет перед применением.</p>
      <div class="sx-row"><input type="text" id="sx-typed" autocomplete="off" value="${esc(st.typed)}" style="padding:8px 10px;border:1px solid var(--sx-line);border-radius:8px;font:inherit;font-weight:700;letter-spacing:.1em">
        <button type="button" class="sx-btn sx-btn-danger" data-act="send-apply" ${ok && !busy ? "" : "disabled"}>Отправить</button>
        <button type="button" class="sx-btn" data-act="confirm-back">← Назад</button> <button type="button" class="sx-btn" data-act="confirm-cancel">Отмена</button></div></div>`;
  }

  function jobHtml() {
    const j = st.job;
    const pct = j.total ? Math.min(100, Math.round(100 * j.sent / j.total)) : (j.state === "done" ? 100 : 0);
    return `<div class="sx-card sx-current"><h4 class="sx-title"><span class="sx-num">3</span>Калькулятор: ${j.state === "failed" ? "ошибка" : "передача"}</h4>
      <p>${esc(j.message || "")}</p><div class="sx-progress"><i style="width:${pct}%"></i></div>
      ${j.state === "failed" ? `<div class="sx-status sx-bad">${esc(j.error || "Ошибка")}</div>` : ""}</div>`;
  }

  function resultHtml() {
    const r = st.result;
    const sum = Object.entries(r.applied || {}).map(([k, v]) => `<dt>${esc((st.kindTitles || {})[k] || k)}</dt><dd>добавлено ${v.new}, изменено ${v.changed}</dd>`).join("");
    const skipped = r.skipped || [];
    return `<div class="sx-card sx-current"><h4 class="sx-title"><span class="sx-num">3</span>Готово</h4>
      <div class="sx-status sx-ok">Применено записей: <b>${fmt(r.applied_total)}</b>${r.elements_recomputed ? `; пересчитан статус у ${fmt(r.elements_recomputed)} изделий` : ""}${skipped.length ? `; пропущено: <b>${skipped.length}</b>` : ""}.</div>
      ${sum ? `<dl class="sx-facts">${sum}</dl>` : ""}
      ${r.calc ? `<div class="sx-status">Калькулятор: ${esc(r.calc)}</div>` : ""}
      ${skipped.length ? `<details open><summary><b>Пропущено (${skipped.length})</b> — родитель не применён или не отмечен</summary><div class="sx-items">${skipped.slice(0, 200).map((s) => `<div class="sx-item"><div>${esc(s.label)}<div class="sx-prob">${esc(s.reason)}</div></div></div>`).join("")}</div></details>` : ""}
      <div class="sx-row" style="margin-top:8px"><button type="button" class="sx-btn sx-btn-primary" data-act="reset">Новый обмен</button></div></div>`;
  }

  function renderAll() { if (dead) return; renderConnect(); renderChoose(); renderResult(); }

  // ------------------------------------------------------------------ действия
  async function connect(form) {
    const fd = new FormData(form);
    const body = { url: String(fd.get("url") || "").trim(), login: String(fd.get("login") || "").trim(), password: String(fd.get("password") || ""), insecure_tls: !!fd.get("insecure") };
    await run("Подключаемся…", async () => {
      const c = await request("POST", "/admin/data-exchange/connect", body);
      st.conn = c;
      try { localStorage.setItem(LS_KEY, JSON.stringify({ url: body.url, login: body.login })); } catch (e) { /* без запоминания */ }
      try { st.localObjects = (await request("GET", "/admin/data-exchange/info")).objects || []; } catch (e) { st.localObjects = []; }
      setStatus(`Подключено к ${c.host}.`, "ok");
    });
  }
  async function disconnect() {
    await run("Отключаемся…", async () => {
      if (st.conn) await request("DELETE", `/admin/data-exchange/connections/${st.conn.connection_id}`);
      resetAll(); setStatus("Отключено.", "");
    });
  }
  function resetAll() { st.conn = null; resetFlow(); }
  function resetFlow() {
    st.analysis = null; st.calc = null; st.result = null; st.confirm = 0; st.typed = ""; st.open = new Map(); st.itemGroup = new Map(); st.job = null;
    st.sel = { groups: new Set(), include: new Set(), exclude: new Set() };
  }
  async function analyze() {
    const sections = [...st.sections].filter((s) => s !== "calc");
    const withCalc = st.sections.has("calc");
    await run("Сверяем…", async () => {
      resetFlow();
      const body = { connection_id: st.conn.connection_id, sections, objects: st.objects.size ? [...st.objects] : null };
      let a = null;
      if (sections.length) a = await request("POST", st.dir === "send" ? "/admin/data-exchange/push" : "/admin/data-exchange/pull", body);
      else a = { analysis_id: null, groups: [], kinds: [], same: {}, direction: st.dir };
      if (withCalc) {
        st.calc = await request("POST", "/admin/data-exchange/calc/plan", { connection_id: st.conn.connection_id, direction: st.dir });
        st.calc.include = true;
      }
      st.analysis = a;
      st.kindTitles = Object.fromEntries((a.kinds || []).map((k) => [k.kind, k.title]));
      applySelectionDefault();
      const total = a.groups.reduce((s, g) => s + (g.state !== "same" ? g.count : 0), 0);
      setStatus(total || st.calc ? `Сверка готова: расхождений ${fmt(total)}${st.calc ? ", калькулятор" : ""}.` : "Сверка готова: выбранные разделы совпадают.", "ok");
    });
  }
  async function openGroup(gid) {
    if (st.open.has(gid)) { st.open.delete(gid); renderAll(); return; }
    st.open.set(gid, { items: [], total: 0 });
    renderAll();
    await loadItems(gid, 0);
  }
  async function loadItems(gid, offset) {
    try {
      const page = await request("GET", itemsPath(gid, offset));
      const o = st.open.get(gid); if (!o) return;
      o.items = offset ? o.items.concat(page.items) : page.items; o.total = page.total;
      for (const it of page.items) st.itemGroup.set(it.id, gid);
      renderAll();
    } catch (e) { setStatus(errText(e), "bad"); }
  }
  const pollJob = async (path) => {
    for (;;) {
      if (dead) return null;
      const j = await request("GET", path);
      st.job = j; renderResult();
      if (j.state === "done" || j.state === "failed") return j;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  async function receiveApply() {
    await run("Применяем…", async () => {
      let res = { applied: {}, applied_total: 0, skipped: [] };
      if (st.analysis.analysis_id && selectedTotal()) res = await request("POST", "/admin/data-exchange/apply", { analysis_id: st.analysis.analysis_id, selection: selectionBody() });
      if (st.calc && st.calc.include) {
        const j = await request("POST", "/admin/data-exchange/calc/apply", { connection_id: st.conn.connection_id, direction: "receive", plan_id: st.calc.plan_id });
        const done = await pollJob(`/admin/data-exchange/calc/jobs/${j.job_id}`);
        st.job = null;
        if (done && done.state === "failed") throw new Error("Калькулятор: " + (done.error || "ошибка"));
        res.calc = done ? done.summary : "";
      }
      st.result = res; st.confirm = 0; setStatus("Готово.", "ok");
    });
  }
  async function sendApply() {
    await run("Отправляем…", async () => {
      const confirm = { step1: true, typed: st.typed.trim() };
      let res = { applied: {}, applied_total: 0, skipped: [] };
      if (st.analysis.analysis_id && selectedTotal()) {
        res = await request("POST", `/admin/data-exchange/remote/${st.conn.connection_id}/apply`, { analysis_id: st.analysis.analysis_id, selection: selectionBody(), confirm });
      }
      if (st.calc && st.calc.include) {
        const j = await request("POST", "/admin/data-exchange/calc/apply", { connection_id: st.conn.connection_id, direction: "send", plan_id: st.calc.plan_id, confirm });
        const done = await pollJob(`/admin/data-exchange/calc/jobs/${j.job_id}`);
        st.job = null;
        if (done && done.state === "failed") throw new Error("Калькулятор: " + (done.error || "ошибка"));
        res.calc = done ? done.summary : "";
      }
      st.result = res; st.confirm = 0; st.typed = ""; setStatus("Отправлено и применено на другом сервере.", "ok");
    });
  }

  // ------------------------------------------------------------------ события (один обработчик на постоянный контейнер)
  el.addEventListener("submit", (e) => { if (e.target.id === "sx-form") { e.preventDefault(); connect(e.target); } });
  el.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t || busy) return;
    if (t.dataset.dir) { if (st.dir !== t.dataset.dir) { st.dir = t.dataset.dir; st.objects = new Set(); resetFlow(); renderAll(); } return; }
    if (t.dataset.open) { openGroup(t.dataset.open); return; }
    if (t.dataset.more) { const o = st.open.get(t.dataset.more); if (o) loadItems(t.dataset.more, o.items.length); return; }
    const act = t.dataset.act;
    if (act === "disconnect") disconnect();
    else if (act === "analyze") analyze();
    else if (act === "reset") { resetFlow(); setStatus(""); renderAll(); }
    else if (act === "sel-new") { applySelectionDefault(); renderAll(); }
    else if (act === "sel-all") { st.sel = { groups: new Set(st.analysis.groups.filter((g) => g.state !== "blocked").map((g) => g.id)), include: new Set(), exclude: new Set() }; renderAll(); }
    else if (act === "sel-none") { st.sel = { groups: new Set(), include: new Set(), exclude: new Set() }; if (st.calc) st.calc.include = false; renderAll(); }
    else if (act === "receive-start") { st.confirm = 1; renderAll(); }
    else if (act === "send-start") { st.confirm = 1; st.typed = ""; renderAll(); }
    else if (act === "confirm-next") { st.confirm = 2; renderAll(); setTimeout(() => $("#sx-typed")?.focus(), 0); }
    else if (act === "confirm-back") { st.confirm = 1; renderAll(); }
    else if (act === "confirm-cancel") { st.confirm = 0; st.typed = ""; renderAll(); }
    else if (act === "receive-apply") receiveApply();
    else if (act === "send-apply") sendApply();
  });
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.section !== undefined) { if (t.checked) st.sections.add(t.dataset.section); else st.sections.delete(t.dataset.section); renderChoose(); return; }
    if (t.dataset.object !== undefined) { if (t.checked) st.objects.add(t.dataset.object); else st.objects.delete(t.dataset.object); renderChoose(); return; }
    if (t.dataset.calc !== undefined) { st.calc.include = t.checked; renderResult(); return; }
    if (t.dataset.group) {
      if (t.checked) st.sel.groups.add(t.dataset.group); else st.sel.groups.delete(t.dataset.group);
      // отметка группы целиком отменяет частные исключения/включения по ней
      for (const [id, g] of st.itemGroup) if (g === t.dataset.group) { st.sel.include.delete(id); st.sel.exclude.delete(id); }
      renderAll(); return;
    }
    if (t.dataset.item) {
      const gid = t.dataset.igroup, id = t.dataset.item;
      if (st.sel.groups.has(gid)) { if (t.checked) st.sel.exclude.delete(id); else st.sel.exclude.add(id); }
      else if (t.checked) st.sel.include.add(id); else st.sel.include.delete(id);
      const n = $("#sx-selected"); if (n) n.innerHTML = `Отмечено записей: <b>${fmt(selectedTotal())}</b>${st.calc && st.calc.include ? " + калькулятор" : ""}`;
      const btn = el.querySelector('[data-act="send-start"],[data-act="receive-start"]'); if (btn) btn.disabled = busy || (!selectedTotal() && !(st.calc && st.calc.include));
    }
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "sx-typed") {
      st.typed = e.target.value;
      const ok = [CONFIRM_WORD.toLowerCase(), (st.conn?.host || "").toLowerCase()].includes(st.typed.trim().toLowerCase());
      const b = el.querySelector('[data-act="send-apply"]'); if (b) b.disabled = !ok || busy;
    }
  });

  // уже есть подключения (страница обновлена, а сеанс на сервере жив)
  (async () => {
    try {
      const r = await request("GET", "/admin/data-exchange/connections");
      if (!dead && r.connections && r.connections.length && !st.conn) { st.conn = r.connections[0]; try { st.localObjects = (await request("GET", "/admin/data-exchange/info")).objects || []; } catch (e) { st.localObjects = []; } }
    } catch (e) { /* нет права или нет сервера — форма подключения покажет */ }
    renderAll();
  })();
  renderAll();
  return {
    hasUnsavedChanges: () => !!st.analysis && !st.result,
    destroy() { dead = true; },
  };
}

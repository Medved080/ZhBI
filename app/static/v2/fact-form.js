// «Факт»: документы фактического выполнения работ блока (на дату) — создание, исправление, удаление, построчный аудит.
// Те же API и права, что у V1 (`/objects/{id}/blocks/{block}/fact-reports`, раздел `work_progress`, «Изменение»).
// Барьеры безопасности данных:
//  * запись только по праву «Учёт по блокам: изменение» (без права форма только читает); каждая операция — отдельная строка шлюза;
//  * правка и удаление уходят с отпечатком документа (`expected_rev`): если документ изменили после открытия — сервер отвечает 409
//    и ничего не меняет, ввод остаётся в форме, версию сервера можно загрузить явно;
//  * двойной клик — один запрос (кнопки и поля блокируются на время записи);
//  * неизвестный исход (обрыв, 5xx) — БЕЗ автоповтора: результат сверяется чтением, человеку говорится, что видит сервер;
//  * успех — только после ответа сервера и повторного чтения документа; удаление необратимо и идёт по подтверждению с последствиями.
import { esc, errText, fmtDate, fmtMoment, todayIso, isRealDate, isPercent, settle, isConflict, conflictText, OUTCOME_TEXT } from "./mfr-common.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";
import { workTypePathParts } from "./mfr-tree.js";

export function mountFactForm(host, { api, objectId, blockId, blockLabel = "", reportId = null, date = null, highlight = [], canWrite, onChanged, onClose }) {
  const base = `/objects/${objectId}/blocks/${blockId}`;
  const hl = new Set(highlight || []);
  let dead = false, busy = false, seq = 0;
  const st = { options: [], reports: [], works: [], cur: null, draft: null, status: "", statusKind: "", loadError: "", audit: new Map(), conflict: false };
  const snapshot = (c) => ({ date: c.date, items: { ...c.items } });
  const eqItems = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
  const dirty = () => !!st.cur && !!st.draft && (st.draft.date !== st.cur.date || !eqItems(st.draft.items, st.cur.items));
  const setStatus = (t, kind = "") => { st.status = t; st.statusKind = kind; const n = host.querySelector("#ff-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };

  async function loadAll(open) {
    const my = ++seq;
    try {
      const [settings, reports, works] = await Promise.all([
        api.get(`${base}/work-types-settings`), api.get(`${base}/fact-reports`), api.get(`/objects/${objectId}/block-works?block_ids=${blockId}`)]);
      if (dead || my !== seq) return;
      const selected = new Set(settings.selected);
      st.options = settings.options.filter((o) => selected.has(o.id));
      st.reports = reports; st.works = works.items || []; st.loadError = "";
    } catch (e) { if (dead || my !== seq) return; st.loadError = errText(e); paint(); return; }
    if (open !== false) { if (reportId && st.reports.some((r) => r.id === reportId)) await openReport(reportId); else await newReport(date); }
    else paint();
  }

  async function currentPercents() {
    // предзаполнение нового документа ТЕКУЩИМИ процентами (как в V1): за день обычно меняется немногое
    const out = {};
    try {
      const tree = await api.get(`${base}/progress`);
      (function walk(nodes) { for (const n of nodes || []) { if (n.percent !== undefined) out[n.id] = n.percent; walk(n.children); } })(tree.tree);
    } catch (e) { /* без предзаполнения — нули */ }
    return out;
  }

  async function newReport(d) {
    const pct = await currentPercents();
    if (dead) return;
    const items = {}; for (const o of st.options) items[o.id] = pct[o.id] || 0;
    st.cur = { id: null, rev: null, date: d || todayIso(), items }; st.draft = snapshot(st.cur); st.conflict = false;
    setStatusQuiet(""); paint();
  }
  const setStatusQuiet = (t) => { st.status = t; st.statusKind = ""; };

  async function openReport(id) {
    try {
      const r = await api.get(`${base}/fact-reports/${id}`);
      if (dead) return;
      const items = {}; for (const o of st.options) items[o.id] = r.items?.[o.id] ?? 0;
      st.cur = { id: r.id, rev: r.rev, date: r.report_date, items, raw: r.items || {} };
      st.draft = snapshot(st.cur); st.conflict = false; setStatusQuiet("");
    } catch (e) { setStatus(`Не удалось открыть документ: ${errText(e)}`, "bad"); return; }
    paint();
  }

  async function switchTo(fn) {
    if (busy) return;
    if (dirty()) {
      const c = await showUnsavedDialog("В документе факта есть несохранённые правки. Что сделать?");
      if (c === "cancel") return;
      if (c === "save") { await save(); if (dirty()) return; }
    }
    await fn();
  }

  function paint() {
    if (dead) return;
    if (st.loadError && !st.options.length && !st.cur) {
      host.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить факт блока.</strong> ${esc(st.loadError)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="ff-retry">Повторить</button></div></div>`;
      host.querySelector("#ff-retry").addEventListener("click", () => loadAll());
      return;
    }
    if (!st.cur) { host.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    const dis = canWrite && !busy ? "" : "disabled";
    const rows = st.options.length ? st.options.map((o) => {
      const { name, crumb } = workTypePathParts(o["путь"]);
      const v = st.draft.items[o.id];
      const match = hl.has(o.id);
      const open = st.audit.has(o.id);
      return `<div class="mfr-fact-row${match ? " match" : ""}" data-wt="${o.id}">
        <div class="mfr-fact-name">${match ? `<span class="mfr-fact-mark" title="Совпадает с отбором">✓ отбор</span> ` : ""}${crumb ? `<span class="v2-muted">${esc(crumb)} / </span>` : ""}${esc(name)}</div>
        <input type="range" min="0" max="100" value="${v}" data-slider ${dis} aria-label="Процент: ${esc(name)}">
        <input type="number" min="0" max="100" step="1" value="${v}" data-number ${dis} aria-label="Процент числом: ${esc(name)}">
        <button type="button" class="v2-btn mfr-mini" data-audit="${o.id}" aria-expanded="${open}">История</button>
        ${open ? `<div class="mfr-fact-audit" data-audit-box="${o.id}">${auditHtml(o.id)}</div>` : ""}</div>`;
    }).join("") : `<p class="v2-muted">Для этого блока не выбрано ни одной работы — сначала «Состав работ».</p>`;
    host.innerHTML = `<div class="mfr-fact">
      <aside class="mfr-fact-list" aria-label="Документы факта блока">
        <div class="v2-bar"><strong>Документы</strong>${canWrite ? `<button type="button" class="v2-btn" id="ff-new" ${busy ? "disabled" : ""}>Новый</button>` : ""}</div>
        <div class="mfr-fact-reports">${st.reports.length ? st.reports.map((r) => `<button type="button" class="mfr-fact-rep${r.id === st.cur.id ? " on" : ""}" data-rep="${r.id}" ${busy ? "disabled" : ""}>
          <b>${esc(fmtDate(r.report_date))}</b><span class="v2-muted">${esc(r.created_by || "")}${r.updated_by && r.updated_by !== r.created_by ? ` · правил: ${esc(r.updated_by)}` : ""}</span></button>`).join("") : `<p class="v2-muted">Отчётов ещё нет.</p>`}</div>
      </aside>
      <section class="mfr-fact-main">
        <p class="v2-muted">${esc(blockLabel)} · ${st.cur.id ? `документ от ${esc(fmtDate(st.cur.date))}` : "новый документ"}${canWrite ? "" : " · только просмотр (нет права на изменение)"}</p>
        <div class="v2-bar"><label class="v2-wire-field"><span>Дата отчёта</span><input type="date" id="ff-date" value="${esc(st.draft.date)}" ${dis}></label>
          ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="ff-save" ${dirty() && !busy ? "" : "disabled"}>Сохранить</button>` : ""}
          ${canWrite && st.cur.id ? `<button type="button" class="v2-btn v2-danger" id="ff-del" ${busy ? "disabled" : ""}>Удалить документ</button>` : ""}</div>
        <div class="mfr-fact-rows">${rows}</div>
        <p id="ff-status" class="mfr-status ${esc(st.statusKind)}" role="status" aria-live="polite">${esc(st.status)}</p>
        ${st.conflict ? `<button type="button" class="v2-btn" id="ff-reload">Загрузить версию сервера (правки будут сброшены)</button>` : ""}
      </section></div>`;
    bind();
  }

  function auditHtml(wtId) {
    const a = st.audit.get(wtId);
    if (!a || a.loading) return `<span class="v2-muted">Загрузка истории…</span>`;
    if (a.error) return `<span class="v2-muted">${esc(a.error)}</span>`;
    const hist = a.history.length ? `<table class="v2-read-tbl mfr-audit-tbl"><thead><tr><th>Дата отчёта</th><th class="num">%</th><th>Кто</th></tr></thead><tbody>${a.history.map((h) => `<tr><td>${esc(fmtDate(h["дата"]))}</td><td class="num">${esc(h["процент"])}</td><td>${esc(h["пользователь"] || "")}</td></tr>`).join("")}</tbody></table>` : `<span class="v2-muted">Значений фактa по этой работе ещё не было.</span>`;
    const edits = a.edits.length ? `<div class="mfr-audit-edits"><strong>Правки внутри документов</strong>${a.edits.map((h) => `<div>${esc(fmtMoment(h["момент"]))}: ${esc(h["было"])}% → ${esc(h["стало"])}%${h["пользователь"] ? ` · ${esc(h["пользователь"])}` : ""}</div>`).join("")}</div>` : "";
    return hist + edits;
  }
  async function toggleAudit(wtId) {
    if (st.audit.has(wtId)) { st.audit.delete(wtId); paint(); return; }
    const a = { loading: true, history: [], edits: [] }; st.audit.set(wtId, a); paint();
    try {
      const h = await api.get(`${base}/work-types/${wtId}/fact-history`); a.history = h.history || [];
      const bw = st.works.find((w) => w.work_type_id === wtId);
      if (bw) { const d = await api.get(`/objects/${objectId}/block-works/${bw.id}`); a.edits = d["история_правок"] || []; }
      a.loading = false;
    } catch (e) { a.loading = false; a.error = errText(e); }
    if (!dead && st.audit.get(wtId) === a) paint();
  }

  function bind() {
    host.querySelector("#ff-retry")?.addEventListener("click", () => loadAll());
    host.querySelectorAll("[data-rep]").forEach((b) => b.addEventListener("click", () => { const id = Number(b.dataset.rep); if (id !== st.cur?.id) switchTo(() => openReport(id)); }));
    host.querySelector("#ff-new")?.addEventListener("click", () => switchTo(() => newReport(null)));
    host.querySelector("#ff-date")?.addEventListener("input", (e) => { st.draft.date = e.target.value; syncSave(); });
    host.querySelectorAll(".mfr-fact-row").forEach((row) => {
      const id = Number(row.dataset.wt);
      const sl = row.querySelector("[data-slider]"), nu = row.querySelector("[data-number]");
      const set = (v) => { const n = Math.max(0, Math.min(100, Math.round(Number(v)) || 0)); st.draft.items[id] = n; sl.value = n; nu.value = n; syncSave(); };
      sl.addEventListener("input", () => set(sl.value));
      nu.addEventListener("input", () => { if (nu.value === "") return; set(nu.value); });
      nu.addEventListener("change", () => set(nu.value));
    });
    host.querySelectorAll("[data-audit]").forEach((b) => b.addEventListener("click", () => toggleAudit(Number(b.dataset.audit))));
    host.querySelector("#ff-save")?.addEventListener("click", save);
    host.querySelector("#ff-del")?.addEventListener("click", remove);
    host.querySelector("#ff-reload")?.addEventListener("click", async () => { if (st.cur.id) await openReport(st.cur.id); else await newReport(null); });
  }
  const syncSave = () => { const b = host.querySelector("#ff-save"); if (b) b.disabled = busy || !dirty(); };
  const lock = (v) => { busy = v; host.querySelectorAll("button, input").forEach((c) => { if (v) c.disabled = true; }); if (!v) paint(); };

  function problems() {
    const out = [];
    if (!isRealDate(st.draft.date)) out.push("укажите существующую дату отчёта");
    for (const [id, v] of Object.entries(st.draft.items)) if (!isPercent(v)) out.push(`процент вне 0..100 у работы ${id}`);
    return out;
  }

  async function save() {
    if (busy || !canWrite || !dirty()) return;
    const bad = problems();
    if (bad.length) { setStatus(`Сохранить нельзя: ${bad.join("; ")}.`, "bad"); return; }
    const isNew = !st.cur.id;
    const body = { report_date: st.draft.date, items: { ...st.draft.items } };
    if (!isNew) body.expected_rev = st.cur.rev;
    const before = new Set(st.reports.map((r) => r.id));
    lock(true); setStatus("Сохранение…");
    let savedId = st.cur.id;
    const res = await settle(async () => {
      const r = isNew ? await api.post(`${base}/fact-reports`, body) : await api.put(`${base}/fact-reports/${st.cur.id}`, body);
      if (isNew) savedId = r.id;
      return r;
    }, async () => {
      // неизвестный исход: сверка чтением (автоповтора нет)
      if (isNew) {
        const list = await api.get(`${base}/fact-reports`);
        const fresh = list.filter((r) => !before.has(r.id));
        for (const r of fresh) { const d = await api.get(`${base}/fact-reports/${r.id}`); if (d.report_date === body.report_date && eqItems(normItems(d.items), body.items)) { savedId = r.id; return "applied"; } }
        return "not_applied";
      }
      const d = await api.get(`${base}/fact-reports/${st.cur.id}`);
      if (d.report_date === body.report_date && eqItems(normItems(d.items), body.items)) return "applied";
      return d.rev === st.cur.rev ? "not_applied" : "unknown";
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      try {
        const list = await api.get(`${base}/fact-reports`); st.reports = list;
        await openReport(savedId);
        setStatus(res.outcome === "confirmed" ? OUTCOME_TEXT.confirmed : "Сохранено и подтверждено чтением.", "ok");
      } catch (e) { setStatus("Сохранено, но перечитать не удалось — закройте и откройте форму заново.", "bad"); paint(); }
      onChanged?.();
      return;
    }
    if (res.outcome === "conflict") { st.conflict = true; paint(); setStatus(`${conflictText(res.error, "документ")} Ваш ввод сохранён в форме.`, "bad"); return; }
    paint();
    setStatus(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
    if (res.outcome === "unknown" || res.outcome === "not_applied") { try { st.reports = await api.get(`${base}/fact-reports`); paint(); setStatus(OUTCOME_TEXT[res.outcome], "bad"); } catch (e) { /* остаёмся с сообщением */ } }
  }
  const normItems = (raw) => { const o = {}; for (const opt of st.options) o[opt.id] = raw?.[opt.id] ?? 0; return o; };

  async function remove() {
    if (busy || !canWrite || !st.cur.id) return;
    const n = st.options.length;
    const ok = await showConfirmDialog(`Удалить документ факта целиком?\n\nДата: ${fmtDate(st.cur.date)}\nБлок: ${blockLabel}\nРабот в документе: ${Object.keys(st.cur.raw || {}).length || n}\n\nДействие необратимо: вместе с документом удаляется история его правок.`,
      { confirmLabel: "Удалить документ", danger: true, multiline: true });
    if (!ok) return;
    const id = st.cur.id, rev = st.cur.rev;
    lock(true); setStatus("Удаление…");
    const res = await settle(() => api.delete(`${base}/fact-reports/${id}?expected_rev=${encodeURIComponent(rev)}`), async () => {
      try { await api.get(`${base}/fact-reports/${id}`); return "not_applied"; } catch (e) { return e?.status === 404 ? "applied" : "unknown"; }
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      try { st.reports = await api.get(`${base}/fact-reports`); } catch (e) { /* список обновится при следующем открытии */ }
      await newReport(null);
      setStatus(res.outcome === "confirmed" ? "Ответ не получен, но сервер подтвердил: документ удалён." : "Документ удалён (подтверждено чтением списка).", "ok");
      onChanged?.();
      return;
    }
    if (res.outcome === "conflict") { st.conflict = true; paint(); setStatus(`${conflictText(res.error, "документ")} Документ не удалён.`, "bad"); return; }
    paint();
    setStatus(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
  }

  paint(); loadAll();
  return {
    dirty, busy: () => busy,
    async guard() {
      if (busy) return false;
      if (!dirty()) return true;
      const c = await showUnsavedDialog("В документе факта есть несохранённые правки. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; host.innerHTML = ""; },
  };
}

// «Журнал факта» в V2: документы фактического выполнения работ по блокам ВСЕГО объекта с отбором по секциям, этажам, видам работ и периоду;
// открытие и исправление документа (форма «Факт»), создание нового, удаление (необратимо, по подтверждению с последствиями).
// Те же API и права, что у V1 (`/objects/{id}/fact-journal`, раздел `work_progress`); запись — только через шлюз `write-gate.js`.
import { anyModalDirty, guardModals, closeAllModals, esc, errText, fmtDate, fmtMoment, canAccounting, todayIso, isRealDate, settle, conflictText, OUTCOME_TEXT } from "./mfr-common.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog } from "./dialogs.js";
import { mountWorkTypeTree } from "./mfr-tree.js";
import { openFactDialog } from "./mfr-dialogs.js";
import { openModal } from "./mfr-common.js";

export function mountFactJournalScreen(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page v2-app mfr-scr";
  const canWrite = canAccounting(rights, "write");
  let dead = false, seq = 0, tree = null;
  const st = { sections: [], levels: [], types: [], blocks: [], secSel: new Set(), lvlSel: new Set(), typeSel: new Set(), from: "", to: "", items: [], loading: true, baseLoading: true, error: "", baseError: "", msg: "", msgKind: "" };

  // отбор из «Учёта по блокам» (кнопка «В журнал факта») — разовая передача через sessionStorage
  try {
    const raw = sessionStorage.getItem("v2.factJournal.preset");
    if (raw) { sessionStorage.removeItem("v2.factJournal.preset"); const p = JSON.parse(raw); if (p.objectId === objectId) { st.secSel = new Set(p.sections || []); st.lvlSel = new Set(p.levels || []); } }
  } catch (e) { /* без переданного отбора */ }

  el.innerHTML = `
    <div class="mfr-head">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}
        <span class="mfr-cap ${canWrite ? "on" : ""}">${canWrite ? "можно: создать, исправить, удалить документ" : "только просмотр"}</span>
        <a class="v2-link mfr-tab-link" href="#/blocks">← Учёт по блокам</a></div>
    </div>
    <div class="mfr-body" id="fj-body"></div>`;
  const $ = (s) => el.querySelector(s);

  async function loadBase() {
    const my = ++seq;
    st.loading = true; st.baseLoading = true; st.baseError = ""; paint();
    try {
      const [sections, levels, types, blocks] = await Promise.all([api.get(`/objects/${objectId}/sections`), api.get(`/objects/${objectId}/levels`), api.get(`/objects/${objectId}/block-work-types`), api.get(`/objects/${objectId}/blocks`)]);
      if (dead || my !== seq) return;
      st.sections = sections; st.levels = levels; st.types = types.options || []; st.blocks = blocks;
    } catch (e) { if (dead || my !== seq) return; st.baseError = errText(e); st.loading = false; st.baseLoading = false; paint(); return; }
    st.baseLoading = false; paint(); await load();
  }
  const params = () => {
    const p = new URLSearchParams();
    st.secSel.forEach((id) => p.append("section_id", id)); st.lvlSel.forEach((id) => p.append("level_id", id)); st.typeSel.forEach((id) => p.append("work_type_id", id));
    if (st.from) p.append("date_from", st.from); if (st.to) p.append("date_to", st.to);
    return p.toString();
  };
  async function load() {
    const my = ++seq;
    st.loading = true; st.error = ""; paintTable();
    try { const d = await api.get(`/objects/${objectId}/fact-journal?${params()}`); if (dead || my !== seq) return; st.items = d.items || []; }
    catch (e) { if (dead || my !== seq) return; st.error = errText(e); st.items = []; }
    st.loading = false; paintTable();
  }
  const active = () => !!(st.secSel.size || st.lvlSel.size || st.typeSel.size || st.from || st.to);
  const setMsg = (t, kind = "") => { st.msg = t; st.msgKind = kind; const n = $("#fj-msg"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };

  function paint() {
    if (dead) return;
    const body = $("#fj-body");
    if (st.baseError) { body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить журнал.</strong> ${esc(st.baseError)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="fj-retry">Повторить</button></div></div>`; $("#fj-retry").addEventListener("click", loadBase); return; }
    if (st.baseLoading) { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    body.innerHTML = `<div class="mfr-two">
      <aside class="mfr-left mfr-fj-filters" aria-label="Отбор документов">
        <div class="v2-bar"><strong>Отбор</strong><button type="button" class="v2-btn" id="fj-reset" ${active() ? "" : "disabled"}>Сбросить</button></div>
        <div class="mfr-scroll">
          <h4>Секции</h4><div class="mfr-checks">${st.sections.length ? st.sections.map((s) => `<label class="mfr-chk"><input type="checkbox" data-sec="${s.id}" ${st.secSel.has(s.id) ? "checked" : ""}> ${esc(s.code)}</label>`).join("") : `<span class="v2-muted">Секций нет.</span>`}</div>
          <h4>Этажи</h4><div class="mfr-checks">${st.levels.length ? st.levels.map((l) => `<label class="mfr-chk"><input type="checkbox" data-lvl="${l.id}" ${st.lvlSel.has(l.id) ? "checked" : ""}> ${esc(l.name || l.key)}</label>`).join("") : `<span class="v2-muted">Этажей нет.</span>`}</div>
          <h4>Период</h4><div class="v2-wire-row"><label class="v2-wire-field"><span>С</span><input type="date" id="fj-from" value="${esc(st.from)}"></label><label class="v2-wire-field"><span>По</span><input type="date" id="fj-to" value="${esc(st.to)}"></label></div>
          <h4>Виды работ</h4><div id="fj-tree"></div>
        </div>
      </aside>
      <section class="mfr-right" aria-label="Документы факта">
        <div class="mfr-works-head"><div><h3>Документы</h3><span class="v2-muted" id="fj-count"></span> <span class="v2-muted" id="fj-active"></span></div>
          <div class="mfr-actions">${canWrite ? `<button type="button" class="v2-btn v2-primary" id="fj-new">Новый отчёт</button>` : ""}<button type="button" class="v2-btn" id="fj-refresh">Обновить</button></div></div>
        <p id="fj-msg" class="mfr-status ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>
        <div class="mfr-scroll mfr-tblwrap" id="fj-tbl"></div></section></div>`;
    tree = mountWorkTypeTree($("#fj-tree"), st.types, st.typeSel, { onChange: () => { st.typeSel = new Set(tree.selected()); load(); paintReset(); } });
    el.querySelectorAll("[data-sec]").forEach((c) => c.addEventListener("change", () => { const id = Number(c.dataset.sec); c.checked ? st.secSel.add(id) : st.secSel.delete(id); load(); paintReset(); }));
    el.querySelectorAll("[data-lvl]").forEach((c) => c.addEventListener("change", () => { const id = Number(c.dataset.lvl); c.checked ? st.lvlSel.add(id) : st.lvlSel.delete(id); load(); paintReset(); }));
    $("#fj-from").addEventListener("change", (e) => { st.from = e.target.value; load(); paintReset(); });
    $("#fj-to").addEventListener("change", (e) => { st.to = e.target.value; load(); paintReset(); });
    $("#fj-reset").addEventListener("click", () => { st.secSel.clear(); st.lvlSel.clear(); st.typeSel.clear(); st.from = ""; st.to = ""; paint(); load(); });
    $("#fj-refresh").addEventListener("click", load);
    $("#fj-new")?.addEventListener("click", newReport);
    paintTable();
  }
  const paintReset = () => { const b = $("#fj-reset"); if (b) b.disabled = !active(); };

  function paintTable() {
    const box = $("#fj-tbl");
    if (!box) return;
    const parts = [];
    if (st.secSel.size) parts.push(`секций: ${st.secSel.size}`); if (st.lvlSel.size) parts.push(`этажей: ${st.lvlSel.size}`); if (st.typeSel.size) parts.push(`видов работ: ${st.typeSel.size}`);
    if (st.from || st.to) parts.push(`период: ${st.from ? fmtDate(st.from) : "…"}–${st.to ? fmtDate(st.to) : "…"}`);
    $("#fj-active").textContent = parts.length ? `· отбор: ${parts.join(", ")}` : "· отбора нет";
    $("#fj-count").textContent = st.loading ? "загрузка…" : `документов: ${st.items.length}`;
    if (st.loading) { box.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (st.error) { box.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить документы.</strong> ${esc(st.error)} <button type="button" class="v2-btn" id="fj-retry2">Повторить</button></div>`; $("#fj-retry2").addEventListener("click", load); return; }
    if (!st.items.length) { box.innerHTML = `<p class="v2-muted">${active() ? "По выбранным условиям отчёты не найдены." : "Отчётов ещё нет."}</p>`; return; }
    box.innerHTML = `<table class="v2-read-tbl mfr-tbl"><thead><tr><th>Дата</th><th>Секция</th><th>Этаж / блок</th><th class="num">Работ</th><th>Автор</th><th>Изменено</th>${canWrite ? "<th></th>" : ""}</tr></thead>
      <tbody>${st.items.map((it) => `<tr data-rep="${it.id}" data-blk="${it.block_id}" tabindex="0" class="mfr-row" aria-label="Открыть документ факта от ${esc(fmtDate(it.report_date))}">
        <td>${esc(fmtDate(it.report_date))}</td><td>${esc(it.section_code || "")}</td><td>${esc(it.level_name || "")}</td><td class="num">${esc(it.ops_count)}</td><td>${esc(it.created_by || "")}</td>
        <td>${it.updated_at && it.updated_at !== it.created_at ? `${esc(fmtMoment(it.updated_at))}${it.updated_by ? " · " + esc(it.updated_by) : ""}` : "—"}</td>
        ${canWrite ? `<td><button type="button" class="v2-btn v2-danger mfr-mini" data-del="${it.id}">Удалить</button></td>` : ""}</tr>`).join("")}</tbody></table>`;
    const openRow = (tr) => {
      const it = st.items.find((x) => x.id === Number(tr.dataset.rep)); if (!it) return;
      openFactDialog({ api, objectId, blockId: it.block_id, blockLabel: `${it.section_code} · ${it.level_name}`, reportId: it.id, highlight: [...st.typeSel], canWrite, onChanged: load, onClosed: load });
    };
    box.querySelectorAll("tr[data-rep]").forEach((tr) => { tr.addEventListener("click", () => openRow(tr)); tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(tr); } }); });
    box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); removeRow(Number(b.dataset.del), b); }));
  }

  // «Новый отчёт»: сначала явно блок (секция + этаж) и дата, затем форма «Факт»
  function newReport() {
    const m = openModal({ title: "Новый отчёт факта", onRequestClose: () => true });
    m.body.innerHTML = `<div class="mfr-newrep"><label class="v2-wire-field"><span>Секция</span><select id="nr-sec">${st.sections.map((s) => `<option value="${s.id}">${esc(s.code)}</option>`).join("")}</select></label>
      <label class="v2-wire-field"><span>Этаж</span><select id="nr-lvl">${st.levels.map((l) => `<option value="${l.id}">${esc(l.name || l.key)}</option>`).join("")}</select></label>
      <label class="v2-wire-field"><span>Дата отчёта</span><input type="date" id="nr-date" value="${todayIso()}"></label>
      <p id="nr-hint" class="mfr-status bad" role="alert"></p>
      <div class="v2-bar mfr-actions"><button type="button" class="v2-btn v2-primary" id="nr-go">Продолжить</button><button type="button" class="v2-btn" id="nr-cancel">Отмена</button></div></div>`;
    m.body.querySelector("#nr-cancel").addEventListener("click", () => m.close());
    m.body.querySelector("#nr-go").addEventListener("click", () => {
      const sec = Number(m.body.querySelector("#nr-sec").value), lvl = Number(m.body.querySelector("#nr-lvl").value), date = m.body.querySelector("#nr-date").value;
      const hint = m.body.querySelector("#nr-hint");
      if (!isRealDate(date)) { hint.textContent = "Укажите существующую дату отчёта"; return; }
      const b = st.blocks.find((x) => x.section_id === sec && x.level_id === lvl);
      if (!b) { hint.textContent = "У этой пары секция/этаж ещё нет блока — заведите его на вкладке «Блоки» текущего интерфейса."; return; }
      m.close();
      openFactDialog({ api, objectId, blockId: b.id, blockLabel: `${b.section_code} · ${b.level_name || b.floor + " этаж"}`, date, highlight: [...st.typeSel], canWrite, onChanged: load, onClosed: load });
    });
  }

  // Удаление документа из строки журнала: свежий документ читается ДО подтверждения (в нём отпечаток и число работ), удаление уходит с отпечатком
  async function removeRow(id, btn) {
    const it = st.items.find((x) => x.id === id); if (!it) return;
    btn.disabled = true; setMsg("Проверяем документ…");
    const base = `/objects/${objectId}/blocks/${it.block_id}/fact-reports/${id}`;
    let doc;
    try { doc = await api.get(base); } catch (e) { setMsg(`Не удалось прочитать документ: ${errText(e)}`, "bad"); btn.disabled = false; return; }
    const ok = await showConfirmDialog(`Удалить отчёт блока целиком?\n\nДата: ${fmtDate(doc.report_date)}\nСекция: ${it.section_code || "—"}, этаж: ${it.level_name || "—"}\nРабот в документе: ${Object.keys(doc.items || {}).length}\n\nЭто удалит весь документ блока вместе с историей его правок. Действие необратимо.`,
      { confirmLabel: "Удалить документ", danger: true, multiline: true });
    if (!ok) { btn.disabled = false; setMsg(""); return; }
    setMsg("Удаление…");
    const res = await settle(() => api.delete(`${base}?expected_rev=${encodeURIComponent(doc.rev)}`), async () => { try { await api.get(base); return "not_applied"; } catch (e) { return e?.status === 404 ? "applied" : "unknown"; } });
    if (dead) return;
    if (res.ok) { setMsg(res.outcome === "confirmed" ? "Ответ не получен, но сервер подтвердил: документ удалён." : "Документ удалён (подтверждено чтением журнала).", "ok"); await load(); return; }
    btn.disabled = false;
    if (res.outcome === "conflict") setMsg(`${conflictText(res.error, "документ")} Документ не удалён.`, "bad");
    else setMsg(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
  }

  loadBase();
  return { hasUnsavedChanges: () => anyModalDirty(), guardLeave: () => guardModals(), destroy() { dead = true; closeAllModals(); } };
}

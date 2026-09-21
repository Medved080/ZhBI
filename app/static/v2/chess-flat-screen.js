// «Плоская шахматка» в V2: развёртка здания по этажам и секциям для доски (группы видов работ одного трека планирования) — просмотр
// процентов и МАССОВЫЙ ввод факта по нескольким блокам за один раз. Те же API и права, что у V1
// (`/objects/{id}/blocks/chess-flat-layout`, `/blocks/chess-flat-batch`, раздел `work_progress`).
// Барьеры безопасности данных (запись — пакет целиком):
//  * введённое копится в черновике; запись — только после окна проверки: что было → что станет, по каждому блоку, дата документов;
//  * пакет уходит ОДНИМ запросом и фиксируется сервером целиком (одна транзакция, блокировка записи первым действием);
//  * каждая строка несёт `expected_percent` — то, что видел человек: если кто-то другой изменил факт, сервер отвечает 409 с перечнем
//    и НЕ пишет ни одной строки; экран перечитывает данные, введённое остаётся, показ расхождений — в окне проверки;
//  * ключ идемпотентности: повтор того же пакета (потерянный ответ) не создаёт вторую запись;
//  * двойной клик — один запрос; неизвестный исход (обрыв, 5xx) — без автоповтора, сверка чтением: записано или нет;
//  * без права «Учёт по блокам: изменение» экран только показывает проценты (полей ввода нет).
// Печать бланка обхода (A4/A3) остаётся в текущем интерфейсе.
import { esc, errText, fmtDate, canAccounting, todayIso, isRealDate, openModal, settle, isConflict, conflictItems, OUTCOME_TEXT } from "./mfr-common.js";
import { STATUS_LABEL, v1Href } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

const RANGE_SIZE = 3;
const fmtFloor = (n) => (String(n).startsWith("-") ? "−" + String(n).slice(1) : String(n));
const uuid = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);
const pctColor = (p) => (p >= 100 ? "var(--good)" : p > 0 ? "#e8a33d" : "var(--line)");

function shortLevelDescriptor(l) {
  const m = l.name && l.name.match(/\(([^)]*)\)\s*$/);
  if (!m) return null;
  const last = m[1].split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : null;
}
const shortLevelName = (l) => shortLevelDescriptor(l) || (l.floor != null ? `${fmtFloor(l.floor)} этаж` : String(l.name || "").slice(0, 20));

// Уровни с одинаковым номером этажа сводятся в одну строку матрицы (как в V1)
function mergeLevels(levels) {
  const groups = []; let cur = null;
  for (const l of levels) {
    if (cur && l.floor != null && cur.floor === l.floor) cur.levels.push(l); else { cur = { floor: l.floor, levels: [l] }; groups.push(cur); }
  }
  return groups.map((g) => {
    const ordered = g.levels.slice().sort((a, b) => (shortLevelDescriptor(a) ? 0 : 1) - (shortLevelDescriptor(b) ? 0 : 1));
    return { id: ordered.map((l) => l.id).join("-"), floor: g.floor, name: ordered.map(shortLevelName).join(" / "), ids: ordered.map((l) => l.id) };
  });
}

export function mountChessFlatScreen(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page v2-app mfr-scr";
  const canWrite = canAccounting(rights, "write");
  let dead = false, seq = 0, busy = false;
  const st = { tracks: [], trackCode: null, layout: null, rows: [], ranges: [], rangeIdx: 0, date: todayIso(), draft: new Map(), loading: true, error: "", msg: "", msgKind: "", review: null };

  el.innerHTML = `
    <div class="mfr-head">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2><span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span>
        <span class="mfr-cap ${canWrite ? "on" : ""}">${canWrite ? "можно: пакетный ввод факта" : "только просмотр"}</span>
        <a class="v2-link mfr-tab-link" href="${esc(v1Href({ ...screen, ws: "mfr" }, structure, objectId))}" title="Печать бланка обхода А4/А3 — в текущем интерфейсе">Бланк обхода (печать) — в текущем интерфейсе</a></div>
      <div class="v2-bar mfr-cf-bar">
        <label class="v2-wire-field"><span>Доска (вид работ)</span><select id="cf-track"></select></label>
        <label class="v2-wire-field"><span>Дата факта</span><input type="date" id="cf-date" value="${esc(st.date)}" ${canWrite ? "" : "disabled"}></label>
        <span class="v2-muted" id="cf-obj"></span><span class="mfr-spacer"></span>
        <span class="v2-muted" id="cf-count"></span>
        ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="cf-review" disabled>Проверить и записать</button><button type="button" class="v2-btn" id="cf-clear" disabled>Очистить ввод</button>` : ""}
        <button type="button" class="v2-btn" id="cf-refresh">Обновить</button></div>
      <p id="cf-msg" class="mfr-status" role="status" aria-live="polite"></p>
    </div>
    <div class="mfr-body" id="cf-body"></div>`;
  const $ = (s) => el.querySelector(s);
  const setMsg = (t, kind = "") => { st.msg = t; st.msgKind = kind; const n = $("#cf-msg"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };

  // ------------------------------------------------------------------ данные
  async function loadTracks() {
    try { st.tracks = (await api.get(`/objects/${objectId}/blocks/planning-tracks`)).tracks || []; } catch (e) { st.tracks = []; st.error = errText(e); }
    if (!st.trackCode || !st.tracks.some((t) => t["код"] === st.trackCode)) st.trackCode = st.tracks.length ? st.tracks[0]["код"] : null;
    $("#cf-track").innerHTML = st.tracks.length ? st.tracks.map((t) => `<option value="${esc(t["код"])}" ${t["код"] === st.trackCode ? "selected" : ""}>${esc(t["название"])}</option>`).join("") : `<option value="">— нет досок —</option>`;
  }
  async function loadLayout(silent = false, keepRange = false) {
    const my = ++seq;
    if (!st.trackCode) { st.layout = null; st.loading = false; paint(); return; }
    if (!silent) { st.loading = true; st.error = ""; paint(); }
    try {
      const d = await api.get(`/objects/${objectId}/blocks/chess-flat-layout?track_code=${encodeURIComponent(st.trackCode)}`);
      if (dead || my !== seq) return;
      st.layout = d; st.rows = mergeLevels(d.levels);
      st.ranges = []; for (let i = 0; i < st.rows.length; i += RANGE_SIZE) st.ranges.push({ rows: st.rows.slice(i, i + RANGE_SIZE) });
      if (st.rows.length > RANGE_SIZE) st.ranges.push({ rows: st.rows, all: true });
      if (!keepRange) st.rangeIdx = bestRange();
      else if (st.rangeIdx >= st.ranges.length) st.rangeIdx = 0;
      st.error = "";
    } catch (e) { if (dead || my !== seq) return; if (!silent) { st.layout = null; } st.error = errText(e); }
    st.loading = false; paint();
  }
  function bestRange() {
    let best = 0, score = -1;
    st.ranges.forEach((r, i) => {
      if (r.all) return;
      const ids = new Set(r.rows.flatMap((x) => x.ids));
      const s = st.layout.blocks.filter((b) => ids.has(b.level_id)).reduce((a, b) => a + Object.keys(b.percents).length, 0);
      if (s > score) { score = s; best = i; }
    });
    return best;
  }
  const blockAt = (secId, row) => { for (const id of row.ids) { const b = st.layout.blocks.find((x) => x.section_id === secId && x.level_id === id); if (b) return b; } return null; };
  const dk = (blockId, opId) => `${blockId}|${opId}`;
  const validPct = (v) => /^\d{1,3}$/.test(v) && Number(v) <= 100;
  const rangeTitle = (r) => (r.all ? "Все этажи" : r.rows.length === 1 ? r.rows[0].name : `${r.rows[0].name} … ${r.rows[r.rows.length - 1].name}`);

  // ------------------------------------------------------------------ отрисовка
  function paint() {
    if (dead) return;
    const body = $("#cf-body");
    $("#cf-obj").textContent = st.layout?.object_name || "";
    syncBar();
    if (st.loading) { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (!st.tracks.length) { body.innerHTML = `<div class="mfr-empty"><h3>Досок нет</h3><p class="v2-muted">${st.error ? esc(st.error) : "Досок «Шахматка», запланированных хотя бы для одного блока, ещё нет: работы блоков заводятся на экране «Учёт по блокам»."}</p></div>`; return; }
    if (!st.layout) { body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="cf-retry">Повторить</button></div></div>`; $("#cf-retry").addEventListener("click", () => loadLayout()); return; }
    const L = st.layout, r = st.ranges[st.rangeIdx] || st.ranges[0];
    if (!r) { body.innerHTML = `<p class="v2-muted">У объекта нет этажей.</p>`; return; }
    const secIds = new Set(); for (const b of L.blocks) if (r.rows.some((x) => x.ids.includes(b.level_id))) secIds.add(b.section_id);
    const secs = L.sections.filter((s) => secIds.has(s.id));
    body.innerHTML = `<div class="mfr-cf">
      <nav class="mfr-cf-nav" aria-label="Диапазон этажей">${st.ranges.map((x, i) => `<button type="button" class="v2-btn${i === st.rangeIdx ? " on" : ""}" data-r="${i}" aria-pressed="${i === st.rangeIdx}">${esc(rangeTitle(x))}</button>`).join("")}</nav>
      <div class="mfr-scroll mfr-cf-grid-wrap"><div class="mfr-cf-grid" style="--cols:${Math.max(secs.length, 1)}">
        <div class="mfr-cf-corner"></div>${secs.map((s) => `<div class="mfr-cf-sec">${esc(s.code)}</div>`).join("")}
        ${r.rows.map((row) => `<div class="mfr-cf-lvl"><b>${esc(row.name)}</b></div>${secs.map((s) => cell(blockAt(s.id, row), s, row)).join("")}`).join("")}
      </div>${secs.length ? "" : `<p class="v2-muted">В этих этажах нет блоков.</p>`}</div></div>`;
    body.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => { st.rangeIdx = Number(b.dataset.r); paint(); }));
    body.querySelectorAll("input[data-b]").forEach((i) => {
      i.addEventListener("input", () => {
        const k = dk(i.dataset.b, i.dataset.o), cur = curPct(Number(i.dataset.b), Number(i.dataset.o));
        const v = i.value.trim();
        if (v === "" || (validPct(v) && Number(v) === cur)) st.draft.delete(k); else st.draft.set(k, v);
        i.classList.toggle("changed", st.draft.has(k) && validPct(v)); i.classList.toggle("bad", v !== "" && !validPct(v));
        syncBar();
      });
    });
  }
  const curPct = (blockId, opId) => { const b = st.layout.blocks.find((x) => x.id === blockId); return Number(b?.percents?.[String(opId)] ?? 0); };
  function cell(b, sec, row) {
    if (!b) return `<div class="mfr-cf-cell none"><span class="v2-muted">нет блока</span></div>`;
    const ops = st.layout.ops.filter((o) => String(o.id) in b.percents);
    if (!ops.length) return `<div class="mfr-cf-cell none"><span class="v2-muted">доска не применяется</span></div>`;
    const avg = Math.round(ops.reduce((a, o) => a + b.percents[String(o.id)], 0) / ops.length);
    return `<div class="mfr-cf-cell" style="--pc:${pctColor(avg)}"><div class="mfr-cf-cell-h"><span>${esc(sec.code)} · ${esc(row.name)}</span><b>${avg}%</b></div>
      ${ops.map((o) => { const k = dk(b.id, o.id), d = st.draft.get(k); return `<label class="mfr-cf-op"><span title="${esc(o.name)}">${esc(o.name)}</span><em>${b.percents[String(o.id)]}%</em>
        ${canWrite ? `<input type="text" inputmode="numeric" maxlength="3" data-b="${b.id}" data-o="${o.id}" value="${esc(d ?? "")}" placeholder="→" class="${d != null ? (validPct(d) ? "changed" : "bad") : ""}" aria-label="Новый процент: ${esc(o.name)}, ${esc(sec.code)} ${esc(row.name)}">` : ""}</label>`; }).join("")}</div>`;
  }
  function syncBar() {
    const n = st.draft.size;
    const bad = [...st.draft.values()].some((v) => !validPct(v));
    const rv = $("#cf-review"), cl = $("#cf-clear");
    if (rv) rv.disabled = busy || !n || bad || !isRealDate(st.date) || !st.layout;
    if (cl) cl.disabled = busy || !n;
    const c = $("#cf-count"); if (c) c.textContent = n ? `введено значений: ${n}${bad ? " (есть неверные)" : ""}` : "";
    const t = $("#cf-track"), d = $("#cf-date"); if (t) t.disabled = busy; if (d) d.disabled = busy || !canWrite;
  }

  // ------------------------------------------------------------------ запись пакета: окно проверки
  function items() {
    const out = [];
    for (const [k, v] of st.draft) {
      const [bId, oId] = k.split("|").map(Number);
      const b = st.layout.blocks.find((x) => x.id === bId); if (!b) continue;
      const sec = st.layout.sections.find((s) => s.id === b.section_id), lv = st.rows.find((r) => r.ids.includes(b.level_id));
      out.push({ block_id: bId, work_type_id: oId, percent: Number(v), expected_percent: curPct(bId, oId), label: `${sec?.code || ""} · ${lv?.name || ""}`, op: st.layout.ops.find((o) => o.id === oId)?.name || String(oId) });
    }
    return out;
  }
  let modal = null;
  function openReview(conflicts = []) {
    if (!st.layout || busy) return;
    const its = items();
    if (!its.length) return;
    st.review = { items: its, key: uuid(), conflicts };
    modal?.close(); modal = null;
    modal = openModal({ title: "Проверка перед записью", wide: true, onRequestClose: async () => !busy });
    const done = modal.close;
    modal.close = () => { modal = null; done(); st.review = null; };
    paintReview();
  }
  function paintReview() {
    if (!modal || !st.review) return;
    const rv = st.review, conf = new Set(rv.conflicts.map((c) => `${c.block_id}|${c.work_type_id}`));
    const blocks = new Map();
    for (const i of rv.items) { if (!blocks.has(i.block_id)) blocks.set(i.block_id, { label: i.label, rows: [] }); blocks.get(i.block_id).rows.push(i); }
    modal.body.innerHTML = `<div class="mfr-review">
      ${rv.conflicts.length ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Данные изменились после вашего ввода.</strong> Ничего не записано. Значений, изменённых другим пользователем: ${rv.conflicts.length} — выделены ниже, «было» обновлено с сервера. Проверьте и запишите снова.</div>` : ""}
      <p>Дата документов: <b>${esc(fmtDate(st.date))}</b> · значений: <b>${rv.items.length}</b> · блоков: <b>${blocks.size}</b>. Пакет записывается целиком: при отказе не изменится ни один блок.</p>
      <div class="mfr-scroll mfr-review-list"><table class="v2-read-tbl"><thead><tr><th>Блок</th><th>Работа</th><th class="num">Было</th><th class="num">Станет</th></tr></thead><tbody>
        ${[...blocks.values()].map((g) => g.rows.map((i, n) => `<tr class="${conf.has(`${i.block_id}|${i.work_type_id}`) ? "mfr-conf" : ""}"><td>${n === 0 ? esc(g.label) : ""}</td><td>${esc(i.op)}</td><td class="num">${i.expected_percent}%</td><td class="num"><b>${i.percent}%</b></td></tr>`).join("")).join("")}</tbody></table></div>
      <p id="rv-status" class="mfr-status ${esc(st.reviewKind || "")}" role="status" aria-live="polite">${esc(st.reviewMsg || "")}</p>
      <div class="v2-bar mfr-actions"><button type="button" class="v2-btn v2-primary" id="rv-go" ${busy ? "disabled" : ""}>Записать</button><button type="button" class="v2-btn" id="rv-cancel" ${busy ? "disabled" : ""}>Вернуться к вводу</button></div></div>`;
    modal.body.querySelector("#rv-cancel").addEventListener("click", () => modal?.close());
    modal.body.querySelector("#rv-go").addEventListener("click", commit);
  }
  const rvStatus = (t, kind = "") => { st.reviewMsg = t; st.reviewKind = kind; const n = modal?.body.querySelector("#rv-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };

  async function commit() {
    if (busy || !st.review || !canWrite) return;
    const rv = st.review;
    busy = true; rvStatus("Запись пакета…"); modal?.body.querySelectorAll("button").forEach((b) => { b.disabled = true; }); syncBar();
    const body = { report_date: st.date, track_code: st.trackCode, idempotency_key: rv.key, items: rv.items.map((i) => ({ block_id: i.block_id, work_type_id: i.work_type_id, percent: i.percent, expected_percent: i.expected_percent })) };
    const res = await settle(() => api.post(`/objects/${objectId}/blocks/chess-flat-batch`, body), async () => {
      // неизвестный исход: сверка чтением — записано ли всё (автоповтора нет; при повторе вручную ключ тот же и повторная запись безопасна)
      const d = await api.get(`/objects/${objectId}/blocks/chess-flat-layout?track_code=${encodeURIComponent(st.trackCode)}`);
      const cur = (bId, oId) => Number(d.blocks.find((b) => b.id === bId)?.percents?.[String(oId)] ?? 0);
      const done = rv.items.filter((i) => cur(i.block_id, i.work_type_id) === i.percent).length;
      if (done === rv.items.length) return "applied";
      return rv.items.every((i) => cur(i.block_id, i.work_type_id) === i.expected_percent) ? "not_applied" : "unknown";
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      for (const i of rv.items) st.draft.delete(dk(i.block_id, i.work_type_id));
      modal?.close();
      await loadLayout(true, true);
      const n = res.data?.items_count ?? rv.items.length, k = res.data?.blocks_count ?? "";
      setMsg(res.outcome === "confirmed" ? `Ответ не получен, но сервер подтвердил: записано ${rv.items.length} значений на ${fmtDate(st.date)}.` : `Записано: ${n} знач.${k !== "" ? ` · блоков: ${k}` : ""} на ${fmtDate(st.date)} (подтверждено повторным чтением).`, "ok");
      return;
    }
    if (res.outcome === "conflict") {
      const conflicts = conflictItems(res.error);
      await loadLayout(true, true);
      st.review = null;
      openReview(conflicts);            // «было» подставлено свежее; введённое сохранено, новый ключ (пакет другой)
      return;
    }
    modal?.body.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    rvStatus(res.outcome === "rejected" ? errText(res.error) : `${OUTCOME_TEXT[res.outcome]}${res.outcome === "not_applied" ? "" : " Повторная запись безопасна: ключ пакета прежний."}`, "bad");
    syncBar();
  }

  // ------------------------------------------------------------------ управление
  $("#cf-track").addEventListener("change", async (e) => {
    if (st.draft.size && !(await guard())) { e.target.value = st.trackCode; return; }
    st.draft.clear(); st.trackCode = e.target.value || null; loadLayout();
  });
  $("#cf-date").addEventListener("change", (e) => { st.date = e.target.value; syncBar(); });
  $("#cf-refresh").addEventListener("click", async () => { if (st.draft.size && !(await guard())) return; st.draft.clear(); loadLayout(true, true); });
  $("#cf-review")?.addEventListener("click", () => openReview());
  $("#cf-clear")?.addEventListener("click", () => { st.draft.clear(); paint(); });
  async function guard() {
    if (!st.draft.size) return true;
    const c = await showUnsavedDialog(`Введено значений: ${st.draft.size}, они не записаны. Что сделать?`);
    if (c === "discard") return true;
    if (c === "save") openReview();
    return false;
  }

  (async () => { await loadTracks(); await loadLayout(); })();
  return {
    hasUnsavedChanges: () => st.draft.size > 0,
    guardLeave: guard,
    destroy() { dead = true; modal?.close(); },
  };
}

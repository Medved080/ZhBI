// «Сеансы»: свои входы в систему — список и завершение (одного или всех, кроме текущего). Те же API, что у V1
// (`app/auth.py`: `/me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/close-others`).
// Безопасность: текущий сеанс здесь НЕ завершается (это «Выйти»); каждое завершение — с подтверждением, где названы сеанс
// или число сеансов; результат подтверждается повторным чтением; неизвестный исход не повторяется автоматически.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showConfirmDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";
import { formatCell } from "./read-screen.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const when = (v) => formatCell({ key: "v", fmt: "datetime" }, { v }, {});

export function mountSessionsEdit(el, { screen, structure, objectId, api, groupTitle, rights, user }) {
  const canEnd = checkWrite("DELETE", "/me/sessions/x").allowed; // политика ограниченного выпуска (write-gate.js)
  // «Сеансы пользователей» (все входы сервиса) — только тем, у кого есть право на раздел «Сеансы пользователей»; сервер проверяет то же самое.
  const sessFeature = rights?.features?.sessions;
  const canSeeAll = !!rights?.system_admin || sessFeature === "read" || sessFeature === "write";
  const canEndAll = (!!rights?.system_admin || sessFeature === "write") && checkWrite("DELETE", "/sessions/x").allowed;
  el.className = "v2-page";
  let dead = false, busy = false, seq = 0;
  const st = { data: null, error: "" };
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Ваши сеансы.</strong> Можно завершить чужой вход (например, на другом компьютере). Текущий сеанс завершается кнопкой «Выйти».${canSeeAll ? " Ниже — сеансы всех пользователей." : " Сеансы других пользователей видит и завершает администратор."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ss-body"></div><p id="ss-status" class="v2-muted" role="status" aria-live="polite"></p>
      ${canSeeAll ? `<h3 style="margin-top:24px">Сеансы всех пользователей</h3><div id="ss-all"></div><p id="ss-all-status" class="v2-muted" role="status" aria-live="polite"></p>` : ""}
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#ss-status"); if (n) n.textContent = t; };
  const others = () => (st.data?.sessions || []).filter((s) => !s.current);

  function paint() {
    if (dead) return;
    const body = $("#ss-body");
    if (!st.data) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить сеансы.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="ss-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#ss-retry")?.addEventListener("click", load);
      return;
    }
    const rows = st.data.sessions || [];
    body.innerHTML = `<div class="v2-bar"><span class="v2-muted">Сеансов: ${rows.length}${st.data.idle_hours ? ` · простой более ${esc(st.data.idle_hours)} ч завершает сеанс, срок жизни — ${esc(st.data.ttl_days)} дн.` : ""}</span>
      <button type="button" class="v2-btn" id="ss-refresh">Обновить</button>
      ${canEnd ? `<button type="button" class="v2-btn v2-danger" id="ss-close-others" ${others().length ? "" : "disabled"}>Завершить все, кроме текущего (${others().length})</button>` : `<span class="v2-muted">Завершение сеансов в экспериментальном интерфейсе отключено — выполняйте его в текущем интерфейсе.</span>`}</div>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Начат</th><th>Последняя активность</th><th>Действует до</th><th>IP</th><th>Браузер</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(when(r.created_at))}</td><td>${esc(when(r.last_seen_at))}</td><td>${esc(when(r.expires_at))}</td><td>${esc(r.ip || "")}</td><td>${esc(String(r.user_agent || "").slice(0, 80))}</td>
        <td>${r.current ? `<span class="v2-chip v2-chip-ok">этот сеанс</span>` : (canEnd ? `<button type="button" class="v2-btn" data-end="${esc(r.id)}" aria-label="Завершить сеанс с IP ${esc(r.ip || "")}">Завершить</button>` : "")}</td></tr>`).join("")}</tbody></table></div>`;
    lock();
  }
  const lock = () => el.querySelectorAll("#ss-body button").forEach((b) => { if (busy) b.disabled = true; else if (b.id === "ss-close-others") b.disabled = !others().length; else b.disabled = false; });

  async function load() {
    const my = ++seq;
    try {
      const data = await api.get("/me/sessions");
      if (dead || my !== seq) return false;
      st.data = data; st.error = ""; paint(); return true;
    } catch (e) {
      if (dead || my !== seq) return false;
      if (!st.data) { st.error = errText(e); paint(); } else setStatus(`Список не обновился: ${errText(e)}`);
      return false;
    }
  }
  async function write(fn) { if (busy) return; busy = true; lock(); try { await fn(); } finally { busy = false; lock(); } }

  async function endOne(id) {
    const s = st.data.sessions.find((x) => x.id === id);
    if (!s || s.current) return;
    if (!(await showConfirmDialog(`Завершить сеанс с IP ${s.ip || "?"}, начатый ${when(s.created_at)}? Там придётся войти заново.`, { confirmLabel: "Завершить", danger: true }))) return;
    await write(async () => {
      setStatus("Завершение…");
      try { await api.delete(`/me/sessions/${encodeURIComponent(id)}`); }
      catch (e) {
        if (e instanceof ApiError && e.status === 404) { /* уже завершён — цель достигнута */ }
        else if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && !st.data.sessions.some((x) => x.id === id) ? "Сеанс завершён, хотя ответ не дошёл." : `Неизвестно, завершён ли сеанс (${errText(e)}). Проверьте список.`); return; }
        else { setStatus(errText(e)); return; }
      }
      const ok = await load();
      setStatus(ok && !st.data.sessions.some((x) => x.id === id) ? "Сеанс завершён." : ok ? "Сервер вернул сеанс после завершения — проверьте." : "Завершено, но список обновить не удалось — нажмите «Обновить».");
    });
  }
  async function endOthers() {
    const n = others().length;
    if (!n) return;
    if (!(await showConfirmDialog(`Завершить все остальные сеансы (${n})? Текущий останется. На других устройствах придётся войти заново.`, { confirmLabel: `Завершить (${n})`, danger: true }))) return;
    await write(async () => {
      setStatus("Завершение…");
      try { const r = await api.post("/me/sessions/close-others", {}); const ok = await load(); setStatus(ok ? `Завершено сеансов: ${r?.closed ?? "?"}. Осталось: ${st.data.sessions.length}.` : `Завершено сеансов: ${r?.closed ?? "?"}, но список обновить не удалось — нажмите «Обновить».`); }
      catch (e) {
        if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && !others().length ? "Остальные сеансы завершены, хотя ответ не дошёл." : `Неизвестно, завершены ли сеансы (${errText(e)}). Проверьте список.`); }
        else setStatus(errText(e));
      }
    });
  }
  // ---------- все сеансы сервиса (администратор): GET /sessions, DELETE /sessions/{id}, POST /sessions/close-others ----------
  const all = { data: null, error: "", q: "", busy: false, seq: 0 };
  const setAllStatus = (t) => { const n = $("#ss-all-status"); if (n) n.textContent = t; };
  const allOthers = () => (all.data?.sessions || []).filter((s) => !s.current);
  function paintAll() {
    if (dead || !canSeeAll) return;
    const box = $("#ss-all");
    if (!all.data) {
      box.innerHTML = all.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить сеансы.</strong> ${esc(all.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ss-all-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      return;
    }
    const q = all.q.trim().toLowerCase();
    const rows = (all.data.sessions || []).filter((r) => !q || `${r.user} ${r.domain_login} ${r.ip || ""}`.toLowerCase().includes(q));
    box.innerHTML = `<div class="v2-bar"><input type="search" id="ss-all-search" class="v2-search" placeholder="Поиск по пользователю или IP" aria-label="Поиск по пользователю или IP" value="${esc(all.q)}">
      <span class="v2-muted">Сеансов: ${rows.length} из ${all.data.sessions.length}</span><button type="button" class="v2-btn" id="ss-all-refresh">Обновить</button>
      ${canEndAll ? `<button type="button" class="v2-btn v2-danger" id="ss-all-close-others" ${allOthers().length && !all.busy ? "" : "disabled"}>Завершить все, кроме моего (${allOthers().length})</button>` : ""}</div>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Пользователь</th><th>Начат</th><th>Последняя активность</th><th>IP</th><th>Браузер</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(r.user)}<div class="v2-muted">${esc(r.domain_login)}${r.impersonated_by ? ` · режим «от имени», открыл ${esc(r.impersonated_by)}` : ""}</div></td><td>${esc(when(r.created_at))}</td><td>${esc(when(r.last_seen_at))}</td><td>${esc(r.ip || "")}</td><td>${esc(String(r.user_agent || "").slice(0, 60))}</td>
        <td>${r.current ? `<span class="v2-chip v2-chip-ok">этот сеанс</span>` : (canEndAll ? `<button type="button" class="v2-btn" data-aend="${esc(r.id)}" ${all.busy ? "disabled" : ""} aria-label="Завершить сеанс ${esc(r.user)}">Завершить</button>` : "")}</td></tr>`).join("")}</tbody></table></div>`;
    const search = $("#ss-all-search");
    search.addEventListener("input", (e) => { const pos = e.target.selectionStart; all.q = e.target.value; paintAll(); const s2 = $("#ss-all-search"); s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (x) { /* type=search */ } });
  }
  async function loadAll() {
    if (!canSeeAll) return false;
    const my = ++all.seq;
    try {
      const data = await api.get("/sessions");
      if (dead || my !== all.seq) return false;
      all.data = data; all.error = ""; paintAll(); return true;
    } catch (e) {
      if (dead || my !== all.seq) return false;
      if (!all.data) { all.error = errText(e); paintAll(); } else setAllStatus(`Список не обновился: ${errText(e)}`);
      return false;
    }
  }
  async function allWrite(fn, okText, verify) {
    if (all.busy) return;
    all.busy = true; paintAll(); setAllStatus("Завершение…");
    try { const r = await fn(); setAllStatus(typeof okText === "function" ? okText(r) : okText); }
    catch (e) {
      if (e instanceof ApiError && e.status === 404) setAllStatus("Уже завершён — список обновлён.");
      else if (unknownOutcome(e)) { all.busy = false; const ok = await loadAll(); setAllStatus(ok && verify() ? "Операция выполнена, хотя ответ не дошёл." : `Неизвестно, выполнена ли операция (${errText(e)}). Проверьте список.`); return; }
      else { all.busy = false; paintAll(); setAllStatus(errText(e)); return; }
    }
    all.busy = false;
    const ok = await loadAll();
    if (!ok) setAllStatus(`${$("#ss-all-status")?.textContent || ""} Список обновить не удалось — нажмите «Обновить».`);
  }
  async function endAny(id) {
    const s = all.data.sessions.find((x) => x.id === id);
    if (!s || s.current) return;
    if (!(await showConfirmDialog(`Завершить сеанс пользователя «${s.user}» с IP ${s.ip || "?"}, начатый ${when(s.created_at)}? Ему придётся войти заново.`, { confirmLabel: "Завершить", danger: true }))) return;
    await allWrite(() => api.delete(`/sessions/${encodeURIComponent(id)}`), "Сеанс завершён.", () => !all.data.sessions.some((x) => x.id === id));
  }
  async function endAllOthers() {
    const n = allOthers().length;
    if (!n) return;
    if (!(await showConfirmDialog(`Завершить ВСЕ сеансы всех пользователей, кроме вашего текущего (${n})? Все войдут заново. Так поступают при подозрении на компрометацию.`, { confirmLabel: `Завершить (${n})`, danger: true }))) return;
    await allWrite(() => api.post("/sessions/close-others", {}), (r) => `Завершено сеансов: ${r?.closed ?? "?"}.`, () => !allOthers().length);
  }
  $("#ss-all")?.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || all.busy) return;
    if (b.id === "ss-all-refresh" || b.id === "ss-all-retry") loadAll();
    else if (b.id === "ss-all-close-others") endAllOthers();
    else if (b.dataset.aend) endAny(b.dataset.aend);
  });

  el.addEventListener("click", (e) => {
    const b = e.target.closest("#ss-body button");
    if (!b || busy) return;
    if (b.id === "ss-refresh") load();
    else if (b.id === "ss-close-others") endOthers();
    else if (b.dataset.end) endOne(b.dataset.end);
  });
  load();
  loadAll();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

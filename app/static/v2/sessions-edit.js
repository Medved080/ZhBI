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

export function mountSessionsEdit(el, { screen, structure, objectId, api, groupTitle }) {
  const canEnd = checkWrite("DELETE", "/me/sessions/x").allowed; // политика ограниченного выпуска (write-gate.js)
  el.className = "v2-page";
  let dead = false, busy = false, seq = 0;
  const st = { data: null, error: "" };
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Ваши сеансы.</strong> Можно завершить чужой вход (например, на другом компьютере). Текущий сеанс завершается кнопкой «Выйти», а сеансы других пользователей — в текущем интерфейсе.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ss-body"></div><p id="ss-status" class="v2-muted" role="status" aria-live="polite"></p>
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
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || busy) return;
    if (b.id === "ss-refresh") load();
    else if (b.id === "ss-close-others") endOthers();
    else if (b.dataset.end) endOne(b.dataset.end);
  });
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

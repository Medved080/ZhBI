// V2: окно «Что нового» по кнопке «?» в шапке — как в V1 (app/static/app.js: openChangelog): закладки «Журнал версий» и «Обновление»,
// отметка «Ознакомился», переход в справку. Данные те же: GET /changelog, GET /release-status, POST /changelog/ack.
//
// Размер окна ЗАДАН (ширина и высота), а не следует за содержимым: у журнала версий и у состояния обновления высота разная, и окно
// «прыгало» при переключении закладок. Прокручивается только область под закладками; шапка и подвал на месте.
import { showConfirmDialog } from "./dialogs.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => (e && (e.detail || e.message)) || "ошибка";
const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? ""); };
const TASK_STATUS = { ok: "выполнена", error: "ошибка", failed: "ошибка", pending: "ожидает", skipped: "пропущена" };

let open = null;   // окно уже открыто — второе не открываем

// ctx: { api, user (changelog_unseen снимается после «Ознакомился»), go(screenId) для «Справка», canRunTasks, onAck() }
export async function openWhatsNew(ctx) {
  if (open) { open.focus(); return; }
  const { api, user, go, canRunTasks = false, onAck } = ctx;
  const prev = document.activeElement;
  const back = document.createElement("div");
  back.className = "v2-dialog-backdrop";
  back.innerHTML = `<div class="v2-dialog v2-wn" role="dialog" aria-modal="true" aria-label="Что нового" tabindex="-1">
    <div class="v2-wn-head"><h3>Что нового</h3>
      <div class="v2-wn-tabs" role="tablist">
        <button type="button" role="tab" data-tab="news" aria-selected="true">Журнал версий</button>
        <button type="button" role="tab" data-tab="release" aria-selected="false">Обновление<span class="v2-wn-badge" id="wn-badge" hidden></span></button>
      </div></div>
    <div class="v2-wn-body">
      <div data-panel="news" id="wn-news"><p class="v2-muted">Загрузка…</p></div>
      <div data-panel="release" id="wn-release" hidden></div>
    </div>
    <div class="v2-wn-foot">
      <button type="button" class="v2-wn-btn2" id="wn-help">Справка</button>
      <button type="button" class="v2-wn-btn2" id="wn-close">Закрыть</button>
      <button type="button" class="v2-wn-btn2 primary" id="wn-ack" style="visibility:${user?.changelog_unseen ? "visible" : "hidden"}">Ознакомился</button>
    </div></div>`;
  document.body.appendChild(back);
  const box = back.querySelector(".v2-wn");
  const $ = (s) => back.querySelector(s);
  open = box;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    back.remove(); open = null;
    if (prev && document.contains(prev) && prev.focus) prev.focus();
  };
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  $("#wn-close").addEventListener("click", close);
  $("#wn-help").addEventListener("click", () => { close(); go?.("training"); });
  back.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    back.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    back.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    $(".v2-wn-body").scrollTop = 0;
  }));
  box.focus();

  $("#wn-ack").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.post("/changelog/ack", {});
      if (user) user.changelog_unseen = false;
      onAck?.();
      close();
    } catch (err) { e.currentTarget.disabled = false; $("#wn-news").insertAdjacentHTML("afterbegin", `<p class="v2-note">Не удалось отметить ознакомление: ${esc(errText(err))}</p>`); }
  });

  // ---- журнал версий: непрочитанное помечает сервер (поле unseen)
  try {
    const list = await api.get("/changelog");
    $("#wn-news").innerHTML = `<div class="v2-wn-list">` + list.map((e) => `<section class="v2-wn-entry${e.unseen ? " unseen" : ""}">
      <div class="v2-wn-eyebrow">${e.unseen ? `<span class="v2-wn-new">Новое</span>` : ""}<b>v${esc(e.version)}</b><span class="v2-muted">${esc(e.date)}</span></div>
      <h4>${esc(e.title)}</h4><ul>${(e.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`).join("") + `</div>` || `<p class="v2-muted">Записей нет.</p>`;
  } catch (err) { $("#wn-news").innerHTML = `<p class="v2-note">Не удалось загрузить: ${esc(errText(err))}</p>`; }

  // ---- состояние обновления: всем — версии и итог, администратору — ещё и обработки
  let busy = false;
  async function loadRelease() {
    const host = $("#wn-release");
    if (!host) return;
    try {
      const d = await api.get("/release-status");
      if (!document.contains(host)) return;
      const versions = `Версия сервиса <b>${esc(d.code_version || "—")}</b> · данные обновлены до <b>${esc(d.db_version || "—")}</b>`;
      const line = d.complete ? `<p class="v2-wn-line ok">${versions} · обновление завершено</p>`
        : `<p class="v2-wn-line bad">${versions} · обновление НЕ завершено${d.failed ? ` · с ошибкой: ${d.failed}` : ""}${d.pending ? ` · ожидают выполнения: ${d.pending}` : ""}</p>`;
      const tasks = (d.tasks || []).map((t) => `<div class="v2-wn-task"><span class="v2-wn-task-title"><span class="v2-wn-when">${[t.version ? `v${esc(t.version)}` : "", t.date ? ruDate(t.date) : ""].filter(Boolean).join(" · ")}</span>
          ${esc(t.title)}${t.kind === "cleanup" ? " · уборка" : ""}</span><span class="v2-wn-st ${esc(t.status)}">${esc(TASK_STATUS[t.status] || t.status)}</span>
          <span>${canRunTasks && t.status !== "ok" ? `<button type="button" class="v2-wn-btn2" data-run="${esc(t.name)}">${t.kind === "cleanup" ? "Выполнить уборку" : t.status === "error" || t.status === "failed" ? "Повторить" : "Выполнить"}</button>` : ""}</span>
          ${t.why ? `<span class="v2-wn-sub">${esc(t.why)}</span>` : ""}${t.note ? `<span class="v2-wn-note">${esc(t.note)}</span>` : ""}</div>`).join("");
      host.innerHTML = line + (tasks ? `<div class="v2-wn-list">${tasks}</div>` : "") + `<p class="v2-muted" id="wn-task-status" role="status" aria-live="polite"></p>`;
      const badge = $("#wn-badge"); if (badge) badge.hidden = !!d.complete;
    } catch (err) { host.innerHTML = `<p class="v2-muted">Состояние обновления недоступно: ${esc(errText(err))}</p>`; }
  }
  $("#wn-release").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-run]");
    if (!b || busy) return;
    if (!(await showConfirmDialog(`Запустить обработку «${b.dataset.run}»? Перед запуском будет снята резервная копия базы.`, { confirmLabel: "Запустить" }))) return;
    busy = true; b.disabled = true;
    const say = (t) => { const n = $("#wn-task-status"); if (n) n.textContent = t; };
    say("Выполняется…");
    try { const r = await api.post(`/release-tasks/${encodeURIComponent(b.dataset.run)}/run`, {}); await loadRelease(); say(`Готово: ${r?.note || r?.status || "выполнено"}.`); }
    catch (err) { await loadRelease(); say(`Не удалось: ${errText(err)}`); }
    busy = false;
  });
  loadRelease();
}

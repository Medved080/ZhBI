// «Памятка администратора»: справочный документ (`GET /admin-guide`, чтение) с копированием команд в буфер и
// скачиванием текстом (`GET /admin-guide.md`). Текст подставлен сервером под ЭТОТ сервер (путь к базе, имя
// контейнера, порт) — здесь только показ и то же копирование, что в V1.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

// navigator.clipboard требует защищённого контекста (HTTPS или localhost); сервис в локальной сети обычно
// работает по обычному HTTP — тот же запасной путь, что в V1 (скрытое поле + execCommand).
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* падаем в запасной путь */ }
  const field = document.createElement("textarea");
  field.value = text; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.top = "-1000px";
  document.body.appendChild(field); field.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  document.body.removeChild(field);
  return ok;
}

export function mountAdminGuideView(el, { screen, structure, objectId, api, groupTitle }) {
  el.className = "v2-page";
  let dead = false;
  const st = { data: null, error: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Просмотр в новом интерфейсе.</strong> Текст подставлен под этот сервер; команды копируются в буфер обмена.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}<button type="button" class="v2-btn" id="ag-download">Скачать .md</button></div></div>
      <div id="ag-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  function paint() {
    if (dead) return;
    const box = $("#ag-body");
    if (!st.data) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить памятку.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ag-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#ag-retry")?.addEventListener("click", load);
      return;
    }
    const d = st.data;
    box.innerHTML = `<h3 class="v2-report-h">Этот сервер</h3>
      <dl class="v2-facts">${d.facts.map((f) => `<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl>
      ${d.sections.map((sec) => `<section class="v2-result"><h3>${esc(sec.title)}</h3><p class="v2-muted">${esc(sec.intro)}</p>
        ${sec.items.map((it) => `<div class="v2-card" style="margin-bottom:8px">
          <div class="v2-inline" style="justify-content:space-between"><strong>${esc(it.title)}</strong><span class="v2-muted">${esc(it.where)}</span></div>
          <p class="v2-muted">${esc(it.note)}</p>
          ${it.command ? `<div class="v2-inline"><code class="v2-cmd" data-cmd style="flex:1;white-space:pre-wrap;word-break:break-all">${esc(it.command)}</code>
            <button type="button" class="v2-btn" data-copy>Копировать</button></div>` : ""}
        </div>`).join("")}</section>`).join("")}`;
    box.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", async () => {
      const cmd = btn.previousElementSibling?.textContent || "";
      const ok = await copyText(cmd);
      const was = btn.textContent;
      btn.textContent = ok ? "Скопировано" : "Не вышло — выделите вручную";
      setTimeout(() => { if (!dead) btn.textContent = was; }, 2000);
    }));
  }

  async function load() {
    try { st.data = await api.get("/admin-guide"); st.error = ""; }
    catch (e) { if (!dead) { st.data = null; st.error = errText(e); } }
    paint();
  }
  $("#ag-download").addEventListener("click", async () => {
    try {
      const res = await fetch("/admin-guide.md", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "Памятка администратора ЖБИ.md";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { /* второстепенно — кнопку можно нажать ещё раз */ }
  });

  paint();
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

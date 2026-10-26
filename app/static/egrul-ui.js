// Реквизиты контрагента по ИНН из ЕГРЮЛ ФНС — общий кусок интерфейса V1 и V2 (сервер: app/egrul.py).
//
//   lookupRequisites(get, inn)            → { found, requisites }  (get — функция GET-запроса оболочки)
//   openBulkFill({ get, post, onDone })   → окно массового дозаполнения контрагентов-заглушек «ИНН <номер>»: сначала предпросмотр
//                                           по пачкам, запись — только после нажатия «Записать».
// Зависимости передаются явно (у ES-модуля нет глобалей); стили встроены — окно выглядит одинаково в обоих интерфейсах.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => (e && (e.detail || e.message)) || "Не удалось выполнить запрос";
const CHUNK = 10;

export async function lookupRequisites(get, inn) {
  return get(`/egrul/lookup?inn=${encodeURIComponent(String(inn || "").replace(/\s/g, ""))}`);
}

const STYLE = `
.eg-back { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 5000; display: flex; align-items: center; justify-content: center; }
.eg-box { background: var(--bg, #fff); color: var(--fg, inherit); border-radius: 10px; padding: 16px 18px; width: min(900px, 94vw); max-height: 88vh; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
.eg-box h3 { margin: 0; }
.eg-scroll { overflow: auto; border: 1px solid rgba(128,128,128,.3); border-radius: 6px; min-height: 80px; }
.eg-tbl { border-collapse: collapse; width: 100%; font-size: 0.8125rem; }
.eg-tbl th, .eg-tbl td { padding: 4px 8px; border-bottom: 1px solid rgba(128,128,128,.2); text-align: left; }
.eg-tbl th { position: sticky; top: 0; background: var(--surface, #eef2f7); }
.eg-muted { opacity: .75; font-size: 0.8125rem; }
.eg-bad { color: #b3261e; }
.eg-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
`;

export function openBulkFill({ get, post, onDone }) {
  if (!document.getElementById("eg-style")) {
    const st = document.createElement("style");
    st.id = "eg-style"; st.textContent = STYLE; document.head.appendChild(st);
  }
  const back = document.createElement("div");
  back.className = "eg-back";
  back.innerHTML = `<div class="eg-box" role="dialog" aria-modal="true" aria-label="Дозаполнение контрагентов из ЕГРЮЛ">
    <h3>Дозаполнить контрагентов из ЕГРЮЛ</h3>
    <p class="eg-muted" id="eg-info">Загрузка списка…</p>
    <div class="eg-scroll"><table class="eg-tbl"><thead><tr><th>ИНН</th><th>Сейчас</th><th>Из ЕГРЮЛ</th><th>Итог</th></tr></thead><tbody id="eg-rows"></tbody></table></div>
    <div class="eg-actions"><button type="button" class="btn btn-secondary v2-btn" id="eg-close">Закрыть</button>
      <button type="button" class="btn btn-secondary v2-btn" id="eg-check" disabled>Проверить в ЕГРЮЛ</button>
      <button type="button" class="btn btn-primary v2-btn v2-primary" id="eg-apply" disabled>Записать найденное</button></div></div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  let items = [], rows = new Map(), busy = false, changed = false;
  const close = () => { back.remove(); if (changed && onDone) onDone(); };
  $("#eg-close").addEventListener("click", () => { if (!busy) close(); });

  const paint = () => {
    $("#eg-rows").innerHTML = items.map((it) => {
      const r = rows.get(it.id);
      const cur = esc(it.short_name);
      let prop = "", res = "";
      if (r) {
        if (r.status === "ok" || r.status === "applied") {
          prop = esc(r.proposed.short_name || "—") + (r.proposed.kpp ? ` · КПП ${esc(r.proposed.kpp)}` : "") + (r.proposed.ogrn ? ` · ОГРН ${esc(r.proposed.ogrn)}` : "") + (r.terminated ? " · деятельность прекращена" : "");
          res = r.status === "applied" ? "записано" : (Object.keys(r.proposed).length ? "будет записано" : "нечего менять");
        } else res = `<span class="eg-bad">${esc(r.message || r.status)}</span>`;
      }
      return `<tr><td>${esc(it.inn)}</td><td>${cur}</td><td>${prop}</td><td>${res}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="eg-muted">Заглушек нет</td></tr>`;
    const writable = [...rows.values()].filter((r) => r.status === "ok" && Object.keys(r.proposed).length);
    $("#eg-apply").disabled = busy || !writable.length;
    $("#eg-apply").textContent = `Записать найденное${writable.length ? ` (${writable.length})` : ""}`;
    $("#eg-check").disabled = busy || !items.length;
  };

  async function run(ids, apply, label) {
    busy = true; paint();
    for (let i = 0; i < ids.length; i += CHUNK) {
      $("#eg-info").textContent = `${label}: ${Math.min(i + CHUNK, ids.length)} из ${ids.length}…`;
      let res;
      try { res = await post("/egrul/fill", { ids: ids.slice(i, i + CHUNK), apply }); }
      catch (e) { $("#eg-info").innerHTML = `<span class="eg-bad">${esc(errText(e))}</span>`; busy = false; paint(); return false; }
      for (const r of res.items) rows.set(r.id, r);
      if (apply) changed = true;
      paint();
      if (res.items.some((r) => r.status === "error")) { /* сервер сам прерывает пачку при недоступности ФНС; остальное доберётся повторным нажатием */ }
    }
    busy = false; paint();
    return true;
  }

  $("#eg-check").addEventListener("click", async () => {
    rows = new Map();
    if (await run(items.map((i) => i.id), false, "Проверка")) {
      const n = [...rows.values()].filter((r) => r.status === "ok").length;
      $("#eg-info").textContent = `Найдено в ЕГРЮЛ: ${n} из ${items.length}. Проверьте таблицу и нажмите «Записать найденное».`;
    }
  });
  $("#eg-apply").addEventListener("click", async () => {
    const ids = [...rows.values()].filter((r) => r.status === "ok" && Object.keys(r.proposed).length).map((r) => r.id);
    if (await run(ids, true, "Запись")) $("#eg-info").textContent = `Записано: ${ids.length}.`;
  });

  get("/egrul/placeholders").then((r) => {
    items = r.items || [];
    $("#eg-info").textContent = items.length
      ? `Контрагентов-заглушек «ИНН <номер>»: ${items.length}. «Проверить в ЕГРЮЛ» покажет, что будет подставлено; записывается только после подтверждения. Проверка идёт пачками и занимает около секунды на запись.`
      : "Заглушек «ИНН <номер>» нет — дозаполнять нечего.";
    paint();
  }).catch((e) => { $("#eg-info").innerHTML = `<span class="eg-bad">${esc(errText(e))}</span>`; });
  return { close };
}

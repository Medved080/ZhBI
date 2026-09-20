// Формы выгрузки: «Экспорт в XLS» (история за период или статус на дату) и «Экспорт в PDF» (схема на дату).
// Те же API, что у V1 (`POST /export.xlsx`, `GET /export.pdf`); это чтение — файл показывает данные чертежа объекта.
// Безопасность данных: выгрузка идёт ТОЛЬКО по чертежу выбранного объекта; без чертежа кнопка недоступна (сервер для
// администратора без `source_file` выгрузил бы ВСЕ объекты сразу — поэтому пустой чертёж на клиенте не отправляется).
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { isRealDate } from "./card-edit.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

export function mountExportForm(el, { screen, structure, objectId, api, groupTitle, object }) {
  const kind = screen.export.kind; // "xlsx" | "pdf"
  el.className = "v2-page";
  const source = object?.source_file || null;
  let dead = false, busy = false;
  const st = { mode: "history", from: "", to: "", date: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Выгрузка в новом интерфейсе.</strong> ${kind === "pdf" ? "Отчёт со всей схемой (авто-масштаб), легендой статусов и местом для подписи." : "Файл строится по чертежу выбранного объекта; отбор фильтром схемы — в текущем интерфейсе."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <p id="ex-source" class="v2-muted">${source ? `Чертёж объекта: <strong>${esc(source)}</strong>` : ""}</p>
      ${!objectId ? `<p class="v2-muted">Выберите объект в шапке — выгрузка относится к объекту.</p>`
        : !source ? `<div class="v2-callout v2-callout-bad" role="alert">У объекта нет загруженного чертежа — выгрузка недоступна (без чертежа она охватила бы другие объекты).</div>`
        : `<form id="ex-form" autocomplete="off">
        ${kind === "xlsx" ? `<fieldset class="v2-fieldset"><legend>Что выгрузить</legend>
          <label class="v2-wire-check"><input type="radio" name="ex-mode" value="history" checked> История изменений за период</label>
          <label class="v2-wire-check"><input type="radio" name="ex-mode" value="snapshot"> Актуальный статус на дату</label></fieldset>
          <div class="v2-wire-row" id="ex-history">
            <label class="v2-wire-field"><span>с</span><input type="date" id="ex-from"></label>
            <label class="v2-wire-field"><span>по</span><input type="date" id="ex-to"></label></div>
          <div class="v2-wire-row" id="ex-snapshot" hidden><label class="v2-wire-field"><span>на дату (пусто — текущий статус)</span><input type="date" id="ex-date"></label></div>`
          : `<div class="v2-wire-row"><label class="v2-wire-field"><span>Статусы актуальны на дату (пусто — текущие)</span><input type="date" id="ex-date"></label></div>`}
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="ex-go">Скачать</button></div></form>`}
      <p id="ex-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#ex-status"); if (n) n.textContent = t; };

  function validate() {
    const bad = [];
    const chk = (v, label) => { if (v && !isRealDate(v)) bad.push(`«${label}» — не существующая дата`); };
    if (kind === "xlsx" && st.mode === "history") { chk(st.from, "с"); chk(st.to, "по"); if (st.from && st.to && st.from > st.to) bad.push("Начало периода позже конца"); }
    else chk(st.date, "на дату");
    return bad;
  }

  async function go() {
    if (busy || !source) return;
    const bad = validate();
    if (bad.length) { setStatus(`Выгрузить нельзя: ${bad.join("; ")}.`); return; }
    busy = true; $("#ex-go").disabled = true; setStatus("Формируется файл…");
    try {
      let blob, name;
      if (kind === "xlsx") {
        const body = { mode: st.mode, source_file: source };
        if (st.mode === "history") { if (st.from) body.date_from = st.from; if (st.to) body.date_to = st.to; } else if (st.date) body.date = st.date;
        blob = await api.download("/export.xlsx", body);
        name = st.mode === "snapshot" ? `elements_snapshot${st.date ? "_" + st.date : ""}.xlsx` : "elements_history.xlsx";
      } else {
        const q = new URLSearchParams({ source_file: source }); if (st.date) q.set("date", st.date);
        blob = await api.download(`/export.pdf?${q}`, null, { method: "GET" });
        name = `otchet_${source}${st.date ? "_" + st.date : ""}.pdf`.replaceAll("/", "_");
      }
      if (dead) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Файл «${name}» сформирован (${Math.max(1, Math.round(blob.size / 1024))} КБ).`);
    } catch (err) {
      if (!dead) setStatus(`Не удалось выгрузить: ${errText(err)}`);
    } finally { busy = false; if (!dead) $("#ex-go")?.removeAttribute("disabled"); }
  }

  $("#ex-form")?.addEventListener("submit", (e) => { e.preventDefault(); go(); });
  $("#ex-form")?.addEventListener("input", (e) => {
    if (e.target.name === "ex-mode") { st.mode = e.target.value; $("#ex-history").hidden = st.mode !== "history"; $("#ex-snapshot").hidden = st.mode !== "snapshot"; }
    else if (e.target.id === "ex-from") st.from = e.target.value;
    else if (e.target.id === "ex-to") st.to = e.target.value;
    else if (e.target.id === "ex-date") st.date = e.target.value;
  });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

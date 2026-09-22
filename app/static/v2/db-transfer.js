// «Перенос базы целиком» — четвёртый раздел «Массовой правки через Excel» V1 (см. app/db_transfer.py):
// не правка построчно, а ПОЛНАЯ ЗАМЕНА текущей базы и вложений снимком другого сервера. Три шага, как в V1:
// выгрузить снимок (`POST /admin/db-transfer/export`, файл), принять и сверить чужой снимок
// (`POST /admin/db-transfer/stage`, ничего не меняет), применить с кодовым словом
// (`POST /admin/db-transfer/apply` — правильность слова проверяет СЕРВЕР). Плюс отмена очереди
// (`POST /admin/db-transfer/forget`) и текущее состояние базы приёмника отдельным запросом
// (`GET /admin/db-transfer/current`) — показывается сразу при открытии экрана, до всякой загрузки.
//
// Барьер: замена ВСЕГДА снимает служебную резервную копию текущего состояния до применения (делает сервер);
// кнопка применения недоступна, пока не набрано кодовое слово; загруженный снимок убирается из очереди при
// уходе с экрана, если его не применили (тот же файл — копия всей базы, оставлять на диске «на всякий случай»
// незачем); неизвестный исход применения не повторяется — состояние перечитывается через /admin/db-status,
// а сессия текущего входа проверяется отдельно (новая база может не знать о ней вовсе).
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { askTyped } from "./admin-common.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("ru-RU"));
const fmtSize = (n) => { const v = Number(n); if (!Number.isFinite(v)) return "—"; if (v >= 1 << 30) return `${(v / (1 << 30)).toFixed(1)} ГБ`; if (v >= 1 << 20) return `${(v / (1 << 20)).toFixed(1)} МБ`; if (v >= 1 << 10) return `${Math.round(v / (1 << 10))} КБ`; return `${v} Б`; };

export function mountDbTransfer(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.db_transfer === "write";
  let dead = false, busy = false;
  const st = { current: null, currentError: "", token: null, stage: null, file: null, confirmWord: "", status: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout v2-callout-bad" role="note"><strong>Необратимо через интерфейс.</strong> Замена стирает ВСЮ текущую базу и вложения содержимым снимка. Перед заменой сервер ВСЕГДА снимает служебную резервную копию текущего состояния — вернуться можно только через неё.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      ${canWrite ? `<section class="v2-result"><h3>1. Выгрузить снимок этой базы</h3>
        <p class="v2-muted">Снимок — файл базы целиком плюс папка вложений, одним архивом. Перенесите файл на сервер-приёмник и загрузите его там в этом же разделе.</p>
        <button type="button" class="v2-btn" id="dt-export">Выгрузить снимок базы</button>
        <p class="v2-muted" id="dt-export-status" role="status" aria-live="polite"></p></section>

        <section class="v2-result"><h3>Сейчас в этой базе</h3><div id="dt-current"></div></section>

        <section class="v2-result"><h3>2. Принять снимок и сверить</h3>
        <div class="v2-inline"><input type="file" id="dt-file" accept=".zip" aria-label="Файл снимка (.zip)">
          <button type="button" class="v2-btn" id="dt-stage">Сверить с базой</button></div>
        <div id="dt-compare"></div>
        <div id="dt-warnings"></div></section>

        <section class="v2-result"><h3>3. Заменить базу целиком</h3>
        <div class="v2-inline"><label class="v2-field">Для подтверждения введите кодовое слово<input type="text" id="dt-confirm" autocomplete="off" disabled style="width:150px;font-weight:700;letter-spacing:.15em"></label>
          <button type="button" class="v2-btn v2-danger" id="dt-apply" disabled>Заменить базу целиком</button></div></section>` : `<p class="v2-muted">Раздел доступен администратору сервиса.</p>`}
      <p class="v2-muted" id="dt-status" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { st.status = t; const n = $("#dt-status"); if (n) n.textContent = t; };
  const lock = () => { el.querySelectorAll("section button, section input").forEach((c) => { c.disabled = busy; }); if (!busy) { $("#dt-confirm").disabled = !st.token; $("#dt-apply").disabled = !st.token || !st.confirmWord.trim(); } };

  async function loadCurrent() {
    try { st.current = await api.get("/admin/db-transfer/current"); st.currentError = ""; }
    catch (e) { st.current = null; st.currentError = errText(e); }
    paintCurrent();
  }
  function paintCurrent() {
    const box = $("#dt-current");
    if (!box) return;
    if (!st.current) { box.innerHTML = st.currentError ? `<p class="v2-muted">Не удалось получить состояние: ${esc(st.currentError)}</p>` : `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    const c = st.current;
    box.innerHTML = `<p class="v2-muted">Сервер «${esc(c.host)}», версия сервиса ${esc(c.code_version || "—")}, версия базы ${esc(c.db_version || "—")}, размер файла ${esc(fmtSize(c.db_bytes))}, вложений: ${fmtNum((c.uploads || {}).files)} (${esc(fmtSize((c.uploads || {}).bytes))}).</p>`;
  }

  $("#dt-export")?.addEventListener("click", async () => {
    if (busy) return;
    busy = true; lock(); const s = $("#dt-export-status"); s.textContent = "Собираем снимок: копия базы и папка вложений. Это может занять до нескольких минут — не закрывайте вкладку…";
    try {
      const { blob, filename } = await api.fetchFile("/admin/db-transfer/export", { method: "POST" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename || "zhbi_snapshot.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      s.textContent = `Снимок выгружен (${fmtSize(blob.size)}).`;
    } catch (e) { s.textContent = `Не удалось выгрузить снимок: ${errText(e)}`; }
    busy = false; lock();
  });

  $("#dt-file")?.addEventListener("change", (e) => { st.file = e.target.files[0] || null; });

  $("#dt-stage")?.addEventListener("click", async () => {
    if (busy) return;
    if (!st.file) { setStatus("Сначала выберите файл снимка (.zip)."); return; }
    busy = true; lock(); setStatus(`Проверяем снимок (${fmtSize(st.file.size)}) и сверяем с текущей базой…`);
    const fd = new FormData(); fd.append("file", st.file);
    try {
      const data = await api.upload("/admin/db-transfer/stage", fd);
      st.token = data.token; st.stage = data;
      paintCompare();
      $("#dt-confirm").value = ""; st.confirmWord = "";
      setStatus(`Снимок проверен и готов к применению. Сверьте числа и, если это действительно тот снимок, введите кодовое слово ниже. Ничего ещё не изменено.`);
    } catch (e) { st.token = null; st.stage = null; setStatus(`Снимок не принят: ${errText(e)}`); }
    busy = false; lock();
  });

  function paintCompare() {
    const d = st.stage;
    if (!d) { $("#dt-compare").innerHTML = ""; $("#dt-warnings").innerHTML = ""; return; }
    const cur = d.current || {}, snap = d.snapshot || {};
    const rows = [
      ["Сервер", cur.host || "—", snap.host || "—"],
      ["Версия сервиса", cur.code_version || "—", snap.code_version || "—"],
      ["Версия базы", cur.db_version || "—", snap.db_version || "—"],
      ["Снимок снят", "—", (snap.created_at || "—") + (snap.created_by ? `, ${snap.created_by}` : "")],
      ["Размер базы", fmtSize(cur.db_bytes), fmtSize(snap.db_bytes)],
      ["Файлов вложений", fmtNum((cur.uploads || {}).files), fmtNum((snap.uploads || {}).files)],
    ];
    const tableNames = [...new Set([...Object.keys(cur.tables || {}), ...Object.keys(snap.tables || {})])].sort();
    for (const name of tableNames) {
      const a = (cur.tables || {})[name], b = (snap.tables || {})[name];
      rows.push([name, fmtNum(a), fmtNum(b), a !== b]);
    }
    $("#dt-compare").innerHTML = `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Что</th><th>Сейчас в базе (будет стёрто)</th><th>Приедет из снимка</th></tr></thead><tbody>
      ${rows.map(([label, a, b, diff]) => `<tr${diff ? ' style="font-weight:600"' : ""}><td>${esc(label)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}
    </tbody></table></div>`;
    $("#dt-warnings").innerHTML = (d.warnings || []).map((w) => `<div class="v2-callout v2-callout-bad" role="alert">${esc(w)}</div>`).join("");
  }

  $("#dt-confirm")?.addEventListener("input", (e) => { st.confirmWord = e.target.value; lock(); });

  $("#dt-apply")?.addEventListener("click", async () => {
    if (busy || !st.token || !st.confirmWord.trim()) return;
    if (!(await askTyped(
      "Заменить базу этого сервера снимком ЦЕЛИКОМ?\n\nВсе изделия, история, контракты, пользователи, настройки и вложения будут стёрты и заменены содержимым снимка. Вернуться можно будет только из служебной резервной копии, которую сервис снимет прямо сейчас.",
      "ЗАМЕНИТЬ", { confirmLabel: "Заменить базу", inputLabel: "Ещё раз подтвердите словом" }))) return;
    busy = true; lock(); setStatus("Снимаем резервную копию и заменяем базу. Не закрывайте вкладку…");
    try {
      const data = await api.post("/admin/db-transfer/apply", { token: st.token, confirm: st.confirmWord.trim() });
      st.token = null; st.stage = null; st.file = null; $("#dt-file").value = "";
      const cur = data.current || {};
      setStatus(`База заменена. Копия прежнего состояния: ${data.safety_backup?.name}. Миграций схемы: ${(data.schema_changes || []).length}, обработок обновления: ${(data.release_tasks || []).length}. Сейчас в базе изделий: ${fmtNum((cur.tables || {}).elements)}. Страница перезагрузится — входить нужно будет учётной записью С ТОГО сервера.`);
      setTimeout(() => location.reload(), 6000);
    } catch (e) { setStatus(`Замена не выполнена: ${errText(e)}`); busy = false; lock(); return; }
  });

  loadCurrent();
  lock();
  return {
    hasUnsavedChanges: () => false,
    async guardLeave() {
      if (st.token && !busy) { try { await api.post("/admin/db-transfer/forget", { token: st.token }); } catch (e) { /* снимок останется в очереди — второстепенно */ } st.token = null; }
      return !busy;
    },
    destroy() { dead = true; },
  };
}

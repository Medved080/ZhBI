// «Адресный классификатор КЛАДР» — та же многошаговая обработка, что в V1 (address-backdrop): человек кладёт
// распакованные файлы на диск сервера (или загружает архив/DBF отсюда), отмечает регионы и запускает загрузку;
// она идёт в фоновом потоке сервера (регион уровня области — миллионы строк, минуты работы), прогресс —
// отдельным опросом. Скачивание архива с сайта ФНС — тот же фоновый поток с параметром «скачать».
//
// Барьер: один активный фоновый поток на сервер (второй запуск получает 409 «Загрузка уже идёт» — сервер уже
// это проверяет), опрос прогресса останавливается сам при уходе с экрана (clearInterval в destroy), кнопка
// «Загрузить отмеченные» недоступна без выбранного региона, отметка «Показывать дома» передаётся в оба места
// (скачивание распаковывает файл домов, загрузка — использует его), сообщение о неизвестном исходе не
// показывается — фоновая задача имеет собственное состояние на сервере (running/done/error), которое всегда
// можно перечитать, повторный опрос не создаёт вторую задачу.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const fmtSize = (n) => { const v = Number(n); if (!Number.isFinite(v)) return "—"; return `${(v / 1048576).toFixed(1)} МБ`; };

export function mountAddressClassifier(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.address_load === "write";
  let dead = false, busy = false, pollTimer = null;
  const st = { data: null, error: "", regions: null, regionsError: "", houses: true, loadHouses: true, file: null, status: "", progress: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Загрузка классификатора в новом интерфейсе." : "Просмотр состояния."}</strong>
        Подсказки по адресу открыты любому вошедшему и не раскрывают ничего о стройках предприятия; загрузка классификатора пишет сотни мегабайт на диск сервера и занимает минуты.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ac-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  function paint() {
    if (dead) return;
    const box = $("#ac-body");
    if (!st.data) { box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить состояние.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ac-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`; $("#ac-retry")?.addEventListener("click", load); return; }
    const d = st.data;
    const job = d.job;
    box.innerHTML = `
      <section class="v2-result"><h3>Состояние</h3>
        <p class="v2-muted">Каталог файлов на сервере: <code>${esc(d.dir)}/</code>. Объектов в базе классификатора: ${Number(d.objects_total).toLocaleString("ru-RU")}. Размер базы классификатора: ${esc(fmtSize(d.db_size))}. Распаковщик 7z ${d.has_7z ? "есть" : "не найден на сервере — распакуйте архив на своём компьютере и загрузите файлы .DBF по одному"}.</p>
        ${d.loaded.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Регион</th><th class="num">Нас. пунктов</th><th class="num">Улиц</th><th class="num">Домов</th><th>Загружен</th></tr></thead><tbody>
          ${d.loaded.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${Number(r.objects).toLocaleString("ru-RU")}</td><td class="num">${Number(r.streets).toLocaleString("ru-RU")}</td><td class="num">${Number(r.houses).toLocaleString("ru-RU")}</td><td>${esc(r.loaded_at || "")}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="v2-muted">Пока не загружен ни один регион — подсказки по адресу не работают, адрес вводится вручную.</p>`}
      </section>
      <section class="v2-result"><h3>Файлы в каталоге</h3>
        ${d.files.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Файл</th><th class="num">Размер</th><th>Изменён</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
          ${d.files.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${esc(fmtSize(f.size))}</td><td>${esc(f.modified)}</td>
            ${canWrite ? `<td>${f.kind === "archive" ? `<button type="button" class="v2-btn" data-unpack="${esc(f.name)}" ${busy ? "disabled" : ""}>Распаковать</button>` : ""}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>` : `<p class="v2-muted">Папка пуста — положите сюда распакованные файлы классификатора или загрузите их ниже.</p>`}
        ${canWrite ? `<div class="v2-inline" style="margin-top:8px">
          <input type="file" id="ac-file" accept=".7z,.zip,.dbf" aria-label="Файл классификатора" ${busy ? "disabled" : ""}>
          <button type="button" class="v2-btn" id="ac-upload" ${busy ? "disabled" : ""}>Загрузить файл</button>
          <label class="v2-role-check" title="Дома нужны для проверки номера и уточнения индекса"><input type="checkbox" id="ac-houses" ${st.houses ? "checked" : ""} ${busy ? "disabled" : ""}><span>С домами (архив распакуется дольше)</span></label>
          <button type="button" class="v2-btn" id="ac-fetch" ${busy || (job && job.state === "running") ? "disabled" : ""}>Скачать классификатор с сайта ФНС</button>
        </div>` : ""}
      </section>
      ${canWrite ? `<section class="v2-result"><h3>Регионы в файле</h3><div id="ac-regions"></div>
        <div class="v2-inline" style="margin-top:8px"><label class="v2-role-check" title="Дома нужны для проверки номера и уточнения индекса"><input type="checkbox" id="ac-load-houses" ${st.loadHouses ? "checked" : ""} ${busy ? "disabled" : ""}><span>Загружать дома в базу (точнее почтовый индекс)</span></label>
          <button type="button" class="v2-btn v2-primary" id="ac-load" disabled>Загрузить отмеченные</button></div></section>` : ""}
      <p class="v2-muted" id="ac-progress" role="status" aria-live="polite">${esc(st.progress || (job && job.state === "running" ? progressText(job) : ""))}</p>
      <p class="v2-muted" id="ac-status" role="status" aria-live="polite">${esc(st.status || "")}</p>`;
    if (canWrite) {
      box.querySelectorAll("[data-unpack]").forEach((b) => b.addEventListener("click", () => unpack(b.dataset.unpack)));
      $("#ac-file").addEventListener("change", (e) => { st.file = e.target.files[0] || null; });
      $("#ac-upload").addEventListener("click", upload);
      // Два независимых флага, как в V1: «С домами» — распаковка и скачивание архива; «Загружать дома в базу» — загрузка регионов
      $("#ac-houses").addEventListener("change", (e) => { st.houses = e.target.checked; });
      $("#ac-load-houses").addEventListener("change", (e) => { st.loadHouses = e.target.checked; });
      $("#ac-fetch").addEventListener("click", fetchFromFns);
      $("#ac-load").addEventListener("click", runLoad);
      paintRegions();
      loadRegions();
    }
    if (job && job.state === "running") startPolling(); else stopPolling();
  }

  function progressText(job) {
    if (!job) return "";
    const share = job.total ? ` ${Math.round(((job.done || 0) * 100) / job.total)} %` : job.done ? ` ${(job.done / 1048576).toFixed(0)} МБ` : "";
    return `${job.stage}${share}…`;
  }

  function setStatus(t) { st.status = t; const n = $("#ac-status"); if (n) n.textContent = t; }
  function lockAll() { el.querySelectorAll("button, input").forEach((c) => { c.disabled = busy; }); }

  async function load() {
    try { st.data = await api.get("/address/status"); st.error = ""; } catch (e) { st.data = null; st.error = errText(e); }
    paint();
  }

  async function loadRegions() {
    const box = $("#ac-regions");
    if (!box) return;
    box.innerHTML = `<p class="v2-muted">Читаем файл…</p>`;
    try {
      const r = await api.get("/address/regions-in-file");
      if (dead) return;
      st.regions = r.regions; st.regionsError = "";
    } catch (e) { if (dead) return; st.regions = null; st.regionsError = errText(e); }
    paintRegions();
  }
  function paintRegions() {
    const box = $("#ac-regions");
    if (!box) return;
    if (!st.regions) { box.innerHTML = st.regionsError ? `<p class="v2-muted">Не удалось прочитать файл: ${esc(st.regionsError)}</p>` : `<p class="v2-muted">Читаем файл…</p>`; return; }
    if (!st.regions.length) { box.innerHTML = `<p class="v2-muted">В папке нет KLADR.DBF — положите распакованные файлы или загрузите архив выше.</p>`; return; }
    const loadedCodes = new Set((st.data?.loaded || []).map((r) => r.code));
    box.innerHTML = st.regions.map((x) => `<label class="v2-role-check" style="display:block"><input type="checkbox" value="${esc(x.code)}" data-region ${loadedCodes.has(x.code) ? "checked" : ""} ${busy ? "disabled" : ""}><span>${esc(x.name)} <span class="v2-muted">(${Number(x.objects).toLocaleString("ru-RU")})</span></span></label>`).join("");
    box.querySelectorAll("[data-region]").forEach((c) => c.addEventListener("change", syncLoadBtn));
    syncLoadBtn();
  }
  function syncLoadBtn() { const b = $("#ac-load"); if (b) b.disabled = busy || !el.querySelectorAll("[data-region]:checked").length; }

  async function unpack(name) {
    if (busy) return;
    busy = true; lockAll(); setStatus("Распаковка…");
    try { await api.post(`/address/unpack?name=${encodeURIComponent(name)}&houses=${st.houses}`); await load(); setStatus("Распаковано."); }
    catch (e) { setStatus(errText(e)); }
    busy = false; if (!dead) lockAll();
  }

  async function upload() {
    if (busy || !st.file) { setStatus("Выберите файл классификатора."); return; }
    busy = true; lockAll(); setStatus(`Загружаем «${st.file.name}» (${fmtSize(st.file.size)})…`);
    const fd = new FormData(); fd.append("file", st.file);
    try {
      await api.upload("/address/upload", fd);
      const isArchive = /\.(7z|zip)$/i.test(st.file.name);
      st.file = null; $("#ac-file").value = "";
      if (isArchive) {
        // Тот же фоновый поток, что «Скачать с сайта ФНС», но БЕЗ скачивания: распаковывает уже загруженный файл.
        const job = await api.post(`/address/fetch?houses=${st.houses}&download=false`);
        setStatus("Готово: файл распаковывается в фоне — следите за прогрессом ниже.");
        await load();
        void job;
      } else {
        await load();
        setStatus("Файл загружен.");
      }
    } catch (e) { setStatus(errText(e)); }
    busy = false; if (!dead) lockAll();
  }

  async function fetchFromFns() {
    if (busy) return;
    busy = true; lockAll(); setStatus("");
    try { await api.post(`/address/fetch?houses=${st.houses}&download=true`); await load(); setStatus("Загрузка с сайта ФНС начата — следите за прогрессом ниже."); }
    catch (e) { setStatus(errText(e)); }
    busy = false; if (!dead) lockAll();
  }

  async function runLoad() {
    if (busy) return;
    const codes = [...el.querySelectorAll("[data-region]:checked")].map((c) => c.value);
    if (!codes.length) { setStatus("Отметьте хотя бы один регион."); return; }
    busy = true; lockAll(); setStatus("");
    try { await api.post("/address/load", { regions: codes, houses: st.loadHouses }); setStatus("Загрузка начата — следите за прогрессом ниже."); startPolling(); }
    catch (e) { setStatus(errText(e)); busy = false; if (!dead) lockAll(); }
  }

  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function setProgress(t) { st.progress = t; const n = $("#ac-progress"); if (n) n.textContent = t; }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const { job } = await api.get("/address/load-status");
        if (!job) { stopPolling(); setProgress(""); return; }
        if (job.state === "running") { setProgress(progressText(job)); }
        else if (job.state === "done") {
          stopPolling(); busy = false;
          const r = job.result || {};
          setProgress("");
          setStatus(r.objects != null ? `Готово: населённых пунктов ${r.objects || 0}, улиц ${r.streets || 0}, домов ${r.houses || 0}.` : `Готово: ${(r.files || []).join(", ")}.`);
          await load();
        } else if (job.state === "error") { stopPolling(); busy = false; setProgress(""); setStatus(`Ошибка: ${job.error || ""}`); if (!dead) lockAll(); }
      } catch (e) { /* сбой опроса — сеть восстановится, следующий тик попробует снова */ }
    }, 900);
  }

  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; stopPolling(); } };
}

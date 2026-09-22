// V2: «График СМР» — версии (просмотр, удаление), исходные данные расчёта (виды работ, поток; разбор файла обработки
// заказчика в форму), расчёт (предпросмотр без записи → подтверждение записывает новую версию) и диаграмма Ганта
// (просмотр, выгрузка XLSX/PDF). Backend: app/schedule_calc.py, app/schedule_versions.py — те же эндпоинты, что у V1.
//
// Расчёт — ДВА шага одной операции: POST /schedule-calc с save:false считает и возвращает сводку, НИЧЕГО не записывая;
// человек видит фронты/предупреждения и подтверждает — второй POST с save:true и отпечатком исходных данных, который
// видел человек (`expected_inputs_version`, app/schedule_calc.py). Если темп или поток поправил кто-то другой между
// предпросмотром и подтверждением — сервер отвечает 409, ничего не записав; форма пересчитывает предпросмотр заново.
// Неизвестный исход (обрыв связи) не повторяется — состояние перечитывается с сервера (список версий).
//
// Исходные данные (PUT /schedule-calc/inputs) и контракт по умолчанию правятся тем же приёмом: отпечаток записи,
// которую видел человек (`expected_version`), сверяется под блокировкой записи — конфликт вместо тихой перезаписи.
import { showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const ruMoment = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : ruDate(v); };
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const unknownText = "Ответ сервера не получен — исход неизвестен. Ничего не отправлено повторно.";

const TABS = [["gantt", "Визуализация"], ["versions", "Версии"], ["inputs", "Исходные данные расчёта"], ["calc", "Расчёт"]];
const GANTT_LEVELS = [[1, "Краны"], [2, "Стоянки"], [3, "Этажи"], [4, "Тип + подтип"]];
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function mountSchedule(container, { screen, objectId, api, rights, groupTitle }) {
  let dead = false;
  const canWrite = !!rights?.system_admin || (rights?.features || {}).schedule === "write";
  const isAdmin = !!rights?.system_admin;

  const S = {
    tab: "gantt",
    versions: { loaded: false, error: "", items: [], baselineId: null, currentId: null },
    inputs: { loaded: false, error: "", workKinds: [], flow: [], version: null, status: "" },
    calc: { startDate: today(), skipInstalled: true, busy: false, preview: null, status: "", error: "" },
    gantt: { loaded: false, error: "", data: null, versionId: null, collapsed: new Set(), depth: 4, pxPerDay: null, status: "" },
    parseStatus: "",
  };

  container.className = "v2-page v2-app";
  container.innerHTML = `<div class="v2-page-head"><div class="v2-container"><h2>${esc(screen.title)}</h2></div></div>
    <div id="sc-body" class="v2-scroll"><div id="sc-inner" class="v2-container"></div></div>`;
  const inner = container.querySelector("#sc-inner");

  // ------------------------------------------------------------ версии
  async function loadVersions() {
    S.versions.error = "";
    try {
      const d = await api.get(`/schedule-versions?object_id=${objectId}`);
      S.versions.items = d.versions; S.versions.baselineId = d.baseline_id; S.versions.currentId = d.current_id;
      S.versions.loaded = true;
    } catch (err) { S.versions.error = err?.detail || "Не удалось загрузить версии графика"; }
  }
  async function deleteVersion(v) {
    if (v.kind === "baseline" && !isAdmin) { await showInfoDialog("Базовую версию удаляет только администратор сервиса."); return; }
    if (!(await showConfirmDialog(`Удалить версию «${v.title || v.kind_label}»? Даты изделий (директивные поля) при этом не меняются.`, { confirmLabel: "Удалить", danger: true }))) return;
    try {
      await api.delete(`/schedule-versions/${v.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        await loadVersions();
        await showInfoDialog(S.versions.items.some((x) => x.id === v.id) ? `${unknownText} Версия на месте — удаление не применилось.` : `${unknownText} Версии больше нет в списке — удаление, похоже, применилось.`);
      } else { await showInfoDialog(err?.detail || "Не удалось удалить версию"); }
      paint(); return;
    }
    S.gantt.loaded = false; S.gantt.data = null;   // диаграмма могла строиться по удалённой версии
    await loadVersions();
    paint();
  }
  function versionsHtml() {
    const v = S.versions;
    if (v.error && !v.loaded) return `<p class="v2-note">${esc(v.error)} <button type="button" class="v2-btn" data-a="retry-v">Повторить</button></p>`;
    if (!v.loaded) return `<p class="v2-muted">Загрузка…</p>`;
    if (!v.items.length) return `<p class="v2-note">Версий графика ещё нет. Базовый график загружается через «Обмен данными → Импорт графика MS Project из XLS», актуализированный — там же или расчётом на вкладке «Расчёт».</p>`;
    return `<table class="v2-table"><thead><tr><th>Вид</th><th>Название</th><th>Изделий</th><th>Откуда</th><th>Загружена</th><th>Кто</th><th></th></tr></thead><tbody>
      ${v.items.map((r) => `<tr><td>${esc(r.kind_label)}</td><td>${esc(r.title || "—")}${r.id === v.currentId ? ` <span class="v2-muted">· текущий прогноз</span>` : ""}</td>
        <td>${r.elements}</td><td>${r.origin === "calc" ? "расчёт системы" : esc(r.source_file || "файл")}</td>
        <td>${esc(ruMoment(r.loaded_at))}</td><td>${esc(r.loaded_by || "—")}</td>
        <td>${canWrite ? `<button type="button" class="v2-btn" data-del-v="${r.id}">Удалить</button>` : ""}</td></tr>`).join("")}
      </tbody></table>`;
  }

  // ------------------------------------------------------------ исходные данные
  async function loadInputs() {
    S.inputs.error = "";
    try {
      const d = await api.get(`/schedule-calc/inputs?object_id=${objectId}`);
      S.inputs.workKinds = d.work_kinds; S.inputs.flow = d.flow; S.inputs.version = d.version; S.inputs.loaded = true;
    } catch (err) { S.inputs.error = err?.detail || "Не удалось загрузить исходные данные"; }
  }
  function autofillFlow() {
    const num = (s) => { const m = /(\d+)\s*$/.exec(String(s)); return m ? Number(m[1]) : 0; };
    const byCrane = new Map();
    for (const r of S.inputs.flow) { if (!byCrane.has(r.crane_name)) byCrane.set(r.crane_name, []); byCrane.get(r.crane_name).push(r); }
    for (const rows of byCrane.values()) { rows.sort((a, b) => num(a.stance_name) - num(b.stance_name) || a.floor - b.floor); rows.forEach((r, i) => { r.order_no = i + 1; }); }
    S.inputs.status = "Поток заполнен по номерам стоянок и этажей — проверьте и сохраните.";
    paint();
  }
  async function saveInputs() {
    S.inputs.status = "Сохранение…"; paint();
    const body = {
      object_id: objectId,
      work_kinds: S.inputs.workKinds.map((r) => ({ element_type: r.element_type, subtype: r.subtype, rate_per_day: r.rate_per_day, order_no: r.order_no })),
      flow: S.inputs.flow.map((r) => ({ crane_name: r.crane_name, stance_name: r.stance_name, floor: r.floor, order_no: r.order_no })),
      expected_version: S.inputs.version,
    };
    try {
      const d = await api.put("/schedule-calc/inputs", body);
      S.inputs.version = d.version;
      S.inputs.status = `Сохранено: видов работ ${d.work_kinds}, фронтов ${d.flow}.`;
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        const before = S.inputs.version;
        await loadInputs();
        S.inputs.status = `${unknownText} ${S.inputs.version === before ? "Отпечаток данных не изменился — сохранение, похоже, не применилось." : "Отпечаток данных изменился — сохранение, похоже, применилось."} Проверьте таблицы.`;
      } else if (err instanceof ApiError && err.status === 409) {
        S.inputs.status = `${err.detail} Данные будут перечитаны — правки, сделанные здесь, будут потеряны.`;
        await loadInputs();
      } else { S.inputs.status = err?.detail || "Не удалось сохранить"; }
    }
    paint();
  }
  async function parseFile(file) {
    S.parseStatus = "Чтение файла…"; paint();
    const fd = new FormData(); fd.append("file", file); fd.append("object_id", String(objectId));
    try {
      const d = await api.upload("/schedule-calc/inputs/parse", fd);
      const kindKey = (r) => `${r.element_type} ${r.subtype || ""}`;
      const byKind = new Map(S.inputs.workKinds.map((r) => [kindKey(r), r]));
      let upd = 0, add = 0;
      for (const r of d.work_kinds) {
        const own = byKind.get(kindKey(r));
        if (own) { if (r.rate_per_day !== null) own.rate_per_day = r.rate_per_day; if (r.order_no !== null) own.order_no = r.order_no; upd++; }
        else { S.inputs.workKinds.push({ ...r, quantity: 0, in_model: false }); add++; }
      }
      const flowKey = (r) => `${r.crane_name} ${r.stance_name} ${r.floor}`;
      const byFlow = new Map(S.inputs.flow.map((r) => [flowKey(r), r]));
      let fl = 0, flNew = 0;
      for (const r of d.flow) {
        const own = byFlow.get(flowKey(r));
        if (own) { own.order_no = r.order_no; fl++; } else { S.inputs.flow.push({ ...r, quantity: 0, in_model: false }); flNew++; }
      }
      S.parseStatus = `Прочитано: ${d.sheets.join(", ")}. Видов работ обновлено ${upd}${add ? `, добавлено ${add}` : ""}; фронтов потока ${fl}${flNew ? `, добавлено ${flNew}` : ""}. Проверьте значения и нажмите «Сохранить исходные данные».${d.warnings.length ? ` ${d.warnings.join(" ")}` : ""}`;
    } catch (err) { S.parseStatus = err?.detail || "Не удалось прочитать файл"; }
    paint();
  }
  function inputsHtml() {
    const d = S.inputs;
    if (d.error && !d.loaded) return `<p class="v2-note">${esc(d.error)} <button type="button" class="v2-btn" data-a="retry-i">Повторить</button></p>`;
    if (!d.loaded) return `<p class="v2-muted">Загрузка…</p>`;
    const flag = (r) => r.in_model ? "" : ` <span class="v2-muted">· нет в модели</span>`;
    return `
      <p class="v2-muted">Темп монтажа — изделий в сутки на один кран; порядок — очередь видов работ внутри одного этажа стоянки; поток — очередь фронтов у крана.</p>
      ${canWrite ? `<div class="v2-inline" style="margin:10px 0"><input type="file" id="sc-parse-file" accept=".xlsx" aria-label="Файл обработки .xlsx"/><button type="button" class="v2-btn" data-a="parse">Прочитать файл</button><span class="v2-muted">${esc(S.parseStatus)}</span></div>` : ""}
      <h4>Виды работ: темп и порядок</h4>
      <table class="v2-table"><thead><tr><th>Тип</th><th>Подтип</th><th>Изделий</th><th>Темп, шт/сутки</th><th>Порядок</th></tr></thead><tbody>
        ${d.workKinds.map((r, i) => `<tr><td>${esc(r.element_type)}${flag(r)}</td><td>${esc(r.subtype || "—")}</td><td>${r.quantity}</td>
          <td><input type="number" step="0.1" min="0" style="width:80px" data-kind="${i}" data-field="rate_per_day" value="${r.rate_per_day ?? ""}" ${canWrite ? "" : "disabled"}/></td>
          <td><input type="number" step="1" min="0" style="width:70px" data-kind="${i}" data-field="order_no" value="${r.order_no ?? ""}" ${canWrite ? "" : "disabled"}/></td></tr>`).join("")}
      </tbody></table>
      <h4 style="margin-top:16px">Поток: очередь фронтов крана</h4>
      ${canWrite ? `<button type="button" class="v2-btn" data-a="autofill-flow" style="margin-bottom:8px">Заполнить поток по модели</button>` : ""}
      <table class="v2-table"><thead><tr><th>Кран</th><th>Стоянка</th><th>Этаж</th><th>Изделий</th><th>Порядок</th></tr></thead><tbody>
        ${d.flow.map((r, i) => `<tr><td>${esc(r.crane_name)}${flag(r)}</td><td>${esc(r.stance_name)}</td><td>${r.floor}</td><td>${r.quantity}</td>
          <td><input type="number" step="1" min="0" style="width:70px" data-flow="${i}" data-field="order_no" value="${r.order_no ?? ""}" ${canWrite ? "" : "disabled"}/></td></tr>`).join("")}
      </tbody></table>
      ${canWrite ? `<div class="v2-inline" style="margin-top:12px"><button type="button" class="v2-btn v2-primary" data-a="save-inputs">Сохранить исходные данные</button><span class="v2-muted">${esc(d.status)}</span></div>` : ""}`;
  }

  // ------------------------------------------------------------ расчёт
  async function runPreview() {
    if (!S.calc.startDate) { S.calc.error = "Укажите дату начала работ"; paint(); return; }
    S.calc.busy = true; S.calc.error = ""; S.calc.status = "Расчёт…"; S.calc.preview = null; paint();
    try {
      const d = await api.post("/schedule-calc", { object_id: objectId, start_date: S.calc.startDate, skip_installed: S.calc.skipInstalled, save: false });
      S.calc.preview = d; S.calc.status = "";
    } catch (err) { S.calc.error = err?.detail || "Не удалось посчитать"; }
    S.calc.busy = false; paint();
  }
  async function confirmCalc() {
    const p = S.calc.preview; if (!p || S.calc.busy) return;
    S.calc.busy = true; S.calc.error = ""; paint();
    try {
      const d = await api.post("/schedule-calc", {
        object_id: objectId, start_date: S.calc.startDate, skip_installed: S.calc.skipInstalled, save: true,
        expected_inputs_version: p.inputs_version, note: `Расчёт системы от ${S.calc.startDate}`,
      });
      S.calc.status = `Готово: фронтов ${d.fronts}, изделий ${d.elements}, сроки с ${ruDate(d.first_date)} по ${ruDate(d.last_date)}.${d.warnings.length ? ` ${d.warnings.join(" ")}` : ""}`;
      S.calc.preview = null;
      S.gantt.loaded = false; S.gantt.data = null;
      await loadVersions();
      S.tab = "versions";
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        const before = (S.versions.items[0] && S.versions.items[0].id) || null;
        await loadVersions();
        const появилась = S.versions.items[0] && S.versions.items[0].id !== before && S.versions.items[0].kind === "current";
        S.calc.error = `${unknownText} ${появилась ? "В списке версий появилась новая — похоже, расчёт сохранился." : "Новой версии в списке нет — похоже, расчёт не сохранился."} Проверьте вкладку «Версии».`;
      } else if (err instanceof ApiError && err.status === 409) {
        // Сообщение должно быть видно до того, как runPreview() его сотрёт (он сразу чистит error) — пауза даёт кадру отрисоваться.
        S.calc.error = `${err.detail} Пересчитываю по текущим исходным данным — проверьте сводку и подтвердите ещё раз.`;
        S.calc.busy = false; paint();
        await new Promise((resolve) => setTimeout(resolve, 700));
        await runPreview();
        return;
      } else { S.calc.error = err?.detail || "Не удалось сохранить расчёт"; }
    }
    S.calc.busy = false; paint();
  }
  function calcHtml() {
    const c = S.calc;
    const label = c.skipInstalled ? "Считать остаток с даты" : "Дата начала работ";
    const hint = c.skipInstalled
      ? "Смонтированные изделия из объёма исключаются, а всё оставшееся раскладывается вперёд с этого дня."
      : "Весь объём считается заново, с нуля: каждый кран начинает свою очередь фронтов с этого дня.";
    return `
      <p class="v2-muted">Считает даты по исходным данным и количествам из модели: длительность работы = количество / темп, фронты идут в порядке потока встык, краны работают параллельно, календарь семидневный. Результат — предпросмотр без записи; версия создаётся только после подтверждения.</p>
      ${canWrite ? `
      <div class="v2-inline" style="margin:10px 0"><label class="v2-field" style="width:auto"><span>${esc(label)}</span><input type="date" id="sc-calc-date" value="${esc(c.startDate)}"/></label>
        <label class="v2-inline"><input type="checkbox" id="sc-calc-skip" ${c.skipInstalled ? "checked" : ""}/> считать от факта</label>
        <button type="button" class="v2-btn v2-primary" data-a="calc-run" ${c.busy ? "disabled" : ""}>Рассчитать</button></div>
      <p class="v2-muted">${esc(hint)}</p>
      ${c.error ? `<p class="v2-auth-error" role="alert">${esc(c.error)}</p>` : ""}
      ${c.preview ? `<div class="v2-callout"><strong>Предпросмотр</strong>
          <p>Фронтов: ${c.preview.fronts}. Изделий: ${c.preview.elements}. Сроки: ${ruDate(c.preview.first_date)} — ${ruDate(c.preview.last_date)}.</p>
          ${c.preview.warnings.length ? `<p class="v2-muted">${c.preview.warnings.map(esc).join("<br>")}</p>` : ""}
          <div class="v2-callout-actions"><button type="button" class="v2-btn v2-primary" data-a="calc-confirm" ${c.busy ? "disabled" : ""}>${c.busy ? "Сохранение…" : "Подтвердить и сохранить версию"}</button>
            <button type="button" class="v2-btn" data-a="calc-cancel" ${c.busy ? "disabled" : ""}>Отменить</button></div></div>` : ""}
      ${c.status ? `<p class="v2-muted">${esc(c.status)}</p>` : ""}` : `<p class="v2-note">Нет прав на расчёт графика.</p>`}`;
  }

  // ------------------------------------------------------------ диаграмма Ганта
  async function loadGantt() {
    S.gantt.error = "";
    try {
      const q = `/schedule-versions/gantt?object_id=${objectId}` + (S.gantt.versionId ? `&version_id=${S.gantt.versionId}` : "");
      const d = await api.get(q);
      S.gantt.data = d; S.gantt.versionId = d.version_id; S.gantt.collapsed = new Set(); S.gantt.depth = 4; S.gantt.loaded = true;
    } catch (err) { S.gantt.error = err?.detail || "Не удалось построить диаграмму"; }
  }
  function applyDepth(depth) {
    if (!S.gantt.data) return;
    S.gantt.depth = depth; S.gantt.collapsed = new Set();
    const walk = (nodes, level) => { for (const n of nodes) { if (n.children.length && level + 1 >= depth) S.gantt.collapsed.add(n.id); walk(n.children, level + 1); } };
    walk(S.gantt.data.nodes, 0);
  }
  function flatRows() {
    const out = [];
    const walk = (nodes, level) => { for (const n of nodes) { out.push({ n, level }); if (n.children.length && !S.gantt.collapsed.has(n.id)) walk(n.children, level + 1); } };
    if (S.gantt.data) walk(S.gantt.data.nodes, 0);
    return out;
  }
  const dayNum = (iso) => Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 86400000;
  async function downloadGantt(kind) {
    S.gantt.status = `Готовим ${kind.toUpperCase()}…`; paint();
    try {
      const blob = await api.download(`/schedule-versions/gantt.${kind}?object_id=${objectId}${S.gantt.versionId ? `&version_id=${S.gantt.versionId}` : ""}`, undefined, { method: "GET" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `График СМР — диаграмма Ганта.${kind}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      S.gantt.status = "";
    } catch (err) { S.gantt.status = `Не удалось выгрузить ${kind.toUpperCase()}: ${err?.detail || err?.message || ""}`; }
    paint();
  }
  function ganttHtml() {
    const g = S.gantt;
    if (g.error && !g.loaded) return `<p class="v2-note">${esc(g.error)} <button type="button" class="v2-btn" data-a="retry-g">Повторить</button></p>`;
    if (!g.loaded) return `<p class="v2-muted">Загрузка…</p>`;
    const d = g.data;
    const versions = S.versions.items;
    const versionSelect = versions.length
      ? `<select id="sc-gantt-version" aria-label="Версия прогноза">${versions.map((v) => `<option value="${v.id}" ${v.id === g.versionId ? "selected" : ""}>${esc(v.kind_label)}: ${esc(v.title || "без названия")}${S.versions.currentId === v.id ? " · текущий прогноз" : ""}</option>`).join("")}</select>`
      : `<span class="v2-muted">версий графика нет</span>`;
    const head = `<div class="v2-inline" style="margin:8px 0 12px;justify-content:space-between">
        <div class="v2-inline">${versionSelect}
          <div class="v2-seg" role="group" aria-label="Уровень группировки">${GANTT_LEVELS.map(([depth, label]) => `<button type="button" data-gantt-level="${depth}" aria-pressed="${depth === g.depth}">${esc(label)}</button>`).join("")}</div>
        </div>
        <div class="v2-inline"><button type="button" class="v2-btn" data-a="gantt-out">крупнее</button><button type="button" class="v2-btn" data-a="gantt-in">мельче</button>
          <button type="button" class="v2-btn" data-a="gantt-xlsx">Выгрузить в XLSX</button><button type="button" class="v2-btn" data-a="gantt-pdf">Выгрузить в PDF</button></div>
      </div>`;
    if (!d.nodes.length) return head + `<p class="v2-note">Рисовать нечего: ни у одного изделия объекта нет ни директивных дат СМР, ни прогноза.</p>`;

    const first = new Date(d.min_date + "T00:00:00Z"), last = new Date(d.max_date + "T00:00:00Z");
    const from = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / 86400000;
    const to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1) / 86400000;
    const totalDays = Math.max(1, to - from);
    const NAME_W = 300;
    const trackAvail = Math.max(360, 900);
    const px = g.pxPerDay || (trackAvail / totalDays);
    const trackW = Math.max(360, Math.round(totalDays * px));
    const X = (iso) => Math.round((dayNum(iso) - from) * px);
    const months = [];
    for (let t = from; t < to;) { const dt = new Date(t * 86400000); months.push({ x: Math.round((t - from) * px), label: `${MONTHS[dt.getUTCMonth()]} ${String(dt.getUTCFullYear()).slice(2)}` }); t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / 86400000; }
    const now = new Date(); const xToday = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000 - from) * px);

    const rows = flatRows();
    const devCell = (n) => { const dev = n.deviation_end; if (dev === null || dev === undefined) return ""; const cls = dev > 0 ? "v2-bad-text" : dev < 0 ? "v2-ok" : "v2-muted"; return `<span class="${cls}">${dev > 0 ? `+${dev}` : dev < 0 ? `−${Math.abs(dev)}` : "0"}</span>`; };
    const factLabel = (n) => !n.installed ? "" : n.fact_pct >= 1 ? `${n.fact_pct} %` : "<1 %";
    const rowsHtml = rows.map(({ n, level }) => {
      const expanded = !g.collapsed.has(n.id);
      const tw = n.children.length ? `<button type="button" class="v2-gantt-tw" data-gantt-toggle="${n.id}">${expanded ? "▾" : "▸"}</button>` : `<span class="v2-gantt-tw"></span>`;
      const bars = [];
      const barSpan = (cls, a, b) => { const s = a || b, e = b || a; if (!s) return null; const x = X(s); const w = Math.max(2, X(e) - x); bars.push(`<div class="v2-gantt-bar v2-gantt-${cls} v2-gantt-lvl-${n.level}" style="left:${x}px;width:${w}px"></div>`); return x + w; };
      barSpan("plan", n.plan_start, n.plan_end);
      const fcEnd = barSpan("fc", n.forecast_start, n.forecast_end);
      const fact = factLabel(n);
      const pctHtml = fact && fcEnd !== null ? `<div class="v2-gantt-pct" style="left:${Math.min(fcEnd + 4, trackW - 30)}px">${fact}</div>` : "";
      const title = `${n.label} · изделий ${n.quantity}${n.installed ? `, смонтировано ${n.installed} (${factLabel(n) || "0 %"})` : ", не смонтировано ничего"}`;
      return `<div class="v2-gantt-row" title="${esc(title)}">
        <div class="v2-gantt-name" style="padding-left:${level * 14}px">${tw}<span class="v2-gantt-txt">${esc(n.label)}</span><span class="v2-muted">${n.quantity}</span>${devCell(n)}</div>
        <div class="v2-gantt-track" style="width:${trackW}px">${bars.join("")}${pctHtml}</div></div>`;
    }).join("");

    const undated = d.undated ? ` Не показано ${d.undated} ${plural(d.undated, "изделие", "изделия", "изделий")}: у них нет ни директивных дат СМР, ни прогноза.` : "";
    const noForecast = d.no_forecast ? ` У ${d.no_forecast} ${plural(d.no_forecast, "изделия", "изделий", "изделий")} в этой версии нет прогноза — их строки идут только с плановой полосой.` : "";
    const status = (d.version_id ? `Прогноз: «${d.version_title || "без названия"}», загружен ${ruMoment(d.loaded_at)}. ` : "Версий графика нет — показаны только директивные сроки. ")
      + `На диаграмме ${d.elements} ${plural(d.elements, "изделие", "изделия", "изделий")}, сроки с ${ruDate(d.min_date)} по ${ruDate(d.max_date)}.` + undated + noForecast;

    return head + `<div class="v2-gantt-wrap" style="--gname:${NAME_W}px">
        <div class="v2-gantt-scale" style="width:${trackW}px">${months.map((m) => `<div class="v2-gantt-mon" style="left:${m.x}px">${esc(m.label)}</div>`).join("")}${xToday >= 0 && xToday <= trackW ? `<div class="v2-gantt-today" style="left:${xToday}px"></div>` : ""}</div>
        <div class="v2-gantt-body">${rowsHtml}</div>
      </div>
      <p class="v2-muted" style="margin-top:8px">${esc(status)}</p>
      ${g.status ? `<p class="v2-muted">${esc(g.status)}</p>` : ""}`;
  }

  // ------------------------------------------------------------ рендер и события
  function paint() {
    if (dead) return;
    const body = S.tab === "versions" ? versionsHtml() : S.tab === "inputs" ? inputsHtml() : S.tab === "calc" ? calcHtml() : ganttHtml();
    inner.innerHTML = `<div class="v2-read-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" class="v2-read-tab" data-sc-tab="${k}" aria-selected="${k === S.tab}">${esc(t)}</button>`).join("")}</div>
      <div>${body}</div>`;
    bind();
  }
  function bind() {
    inner.querySelectorAll("[data-sc-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.scTab)));
    inner.querySelector('[data-a="retry-v"]')?.addEventListener("click", async () => { await loadVersions(); paint(); });
    inner.querySelector('[data-a="retry-i"]')?.addEventListener("click", async () => { await loadInputs(); paint(); });
    inner.querySelector('[data-a="retry-g"]')?.addEventListener("click", async () => { await loadGantt(); paint(); });
    inner.querySelectorAll("[data-del-v]").forEach((b) => b.addEventListener("click", () => deleteVersion(S.versions.items.find((x) => String(x.id) === b.dataset.delV))));
    // исходные данные
    inner.querySelectorAll("#sc-inner input[data-kind]").forEach((inp) => inp.addEventListener("change", (e) => { S.inputs.workKinds[Number(e.target.dataset.kind)][e.target.dataset.field] = e.target.value === "" ? null : Number(e.target.value); }));
    inner.querySelectorAll("#sc-inner input[data-flow]").forEach((inp) => inp.addEventListener("change", (e) => { S.inputs.flow[Number(e.target.dataset.flow)][e.target.dataset.field] = e.target.value === "" ? null : Number(e.target.value); }));
    inner.querySelector('[data-a="autofill-flow"]')?.addEventListener("click", autofillFlow);
    inner.querySelector('[data-a="save-inputs"]')?.addEventListener("click", saveInputs);
    inner.querySelector('[data-a="parse"]')?.addEventListener("click", () => { const f = inner.querySelector("#sc-parse-file")?.files?.[0]; if (!f) { S.parseStatus = "Сначала выберите файл .xlsx"; paint(); return; } parseFile(f); });
    // расчёт
    inner.querySelector("#sc-calc-date")?.addEventListener("change", (e) => { S.calc.startDate = e.target.value; });
    inner.querySelector("#sc-calc-skip")?.addEventListener("change", (e) => { S.calc.skipInstalled = e.target.checked; paint(); });
    inner.querySelector('[data-a="calc-run"]')?.addEventListener("click", runPreview);
    inner.querySelector('[data-a="calc-confirm"]')?.addEventListener("click", confirmCalc);
    inner.querySelector('[data-a="calc-cancel"]')?.addEventListener("click", () => { S.calc.preview = null; paint(); });
    // диаграмма
    inner.querySelector("#sc-gantt-version")?.addEventListener("change", (e) => { S.gantt.versionId = e.target.value ? Number(e.target.value) : null; S.gantt.loaded = false; loadGantt().then(paint); });
    inner.querySelectorAll("[data-gantt-level]").forEach((b) => b.addEventListener("click", () => { applyDepth(Number(b.dataset.ganttLevel)); paint(); }));
    inner.querySelectorAll("[data-gantt-toggle]").forEach((b) => b.addEventListener("click", () => { const id = Number(b.dataset.ganttToggle); if (S.gantt.collapsed.has(id)) S.gantt.collapsed.delete(id); else S.gantt.collapsed.add(id); paint(); }));
    inner.querySelector('[data-a="gantt-out"]')?.addEventListener("click", () => { S.gantt.pxPerDay = Math.min(40, (S.gantt.pxPerDay || 900 / totalDaysOf(S.gantt.data)) * 1.6); paint(); });
    inner.querySelector('[data-a="gantt-in"]')?.addEventListener("click", () => { const fit = 900 / totalDaysOf(S.gantt.data); const nv = (S.gantt.pxPerDay || fit) / 1.6; S.gantt.pxPerDay = nv <= fit ? null : nv; paint(); });
    inner.querySelector('[data-a="gantt-xlsx"]')?.addEventListener("click", () => downloadGantt("xlsx"));
    inner.querySelector('[data-a="gantt-pdf"]')?.addEventListener("click", () => downloadGantt("pdf"));
  }
  function totalDaysOf(d) {
    if (!d || !d.min_date) return 180;
    const first = new Date(d.min_date + "T00:00:00Z"), last = new Date(d.max_date + "T00:00:00Z");
    const from = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / 86400000;
    const to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1) / 86400000;
    return Math.max(1, to - from);
  }
  async function switchTab(k) {
    S.tab = k; paint();
    if (k === "versions" && !S.versions.loaded) { await loadVersions(); paint(); }
    if (k === "inputs" && !S.inputs.loaded) { await loadInputs(); paint(); }
    if (k === "gantt" && !S.gantt.loaded) { if (!S.versions.loaded) await loadVersions(); await loadGantt(); paint(); }
  }

  (async () => {
    inner.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
    await loadVersions();
    await loadGantt();
    if (dead) return;
    paint();
  })();

  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    destroy() { dead = true; },
  };
}

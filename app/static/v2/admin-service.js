// Служебные экраны области «администрирование» (impl: "admin:<имя>"): сброс истории статусов, резервные копии, доменная авторизация,
// подложка карты, очистка журнала, обработки данных при обновлении. Каждый экран:
//  * опасная операция — предпросмотр последствий с сервера, подтверждение вводом слова/названия, одна серверная операция;
//  * пока идёт запись, элементы управления заблокированы (второй клик ничего не отправляет);
//  * неизвестный исход (обрыв связи, 5xx) НЕ повторяется автоматически — состояние читается с сервера и говорится по факту;
//  * успех показывается только после ответа сервера и повторного чтения.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { frame, errText, askTyped } from "./admin-common.js";
import { checkWrite } from "./write-gate.js";
import { mountReadScreen } from "./read-screen.js";

const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const fmtNum = (n) => Number(n || 0).toLocaleString("ru-RU");
// Склонение числительного (как в app.js: 1 запись, 2 записи, 5 записей).
const plural = (n, one, few, many) => { const с = Math.abs(n) % 100, е = с % 10; if (с > 10 && с < 20) return many; if (е > 1 && е < 5) return few; return е === 1 ? one : many; };
const fmtSize = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} ГБ` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : b >= 1024 ? `${Math.round(b / 1024)} КБ` : `${b || 0} Б`);
const can = (rights, key, kind) => !!rights?.system_admin || (kind === "read" ? ["read", "write"].includes(rights?.features?.[key]) : rights?.features?.[key] === "write");

// ================================================================== Очистить историю статусов
export function mountResetHistory(el, { screen, groupTitle, api, rights }) {
  const body = frame(el, screen, groupTitle);
  const canBackup = can(rights, "backups", "write") && checkWrite("POST", "/admin/backups", { comment: "x" }).allowed;
  let dead = false, busy = false, pv = null;
  body.innerHTML = `
    <div class="v2-callout v2-callout-bad" role="note"><strong>Необратимая операция.</strong> Удаляет историю статусов у ВСЕХ элементов во ВСЕХ чертежах и объектах и возвращает их в «Запланирован»
      (контракт и фактическая дата поставки снимаются). Через интерфейс отменить нельзя — только восстановлением резервной копии. Нужна для тестирования.</div>
    <div id="rh-preview"><p class="v2-muted" role="status">Считаем, что будет затронуто…</p></div>
    <label class="v2-role-check"><input type="checkbox" id="rh-backup" ${canBackup ? "checked" : "disabled"}><span>Сначала снять резервную копию (рекомендуется)${canBackup ? "" : " — недоступно: нет права на резервные копии"}</span></label>
    <div class="v2-inline" style="margin-top:12px"><button type="button" class="v2-btn" id="rh-refresh">Обновить предпросмотр</button>
      <button type="button" class="v2-btn v2-danger" id="rh-run" disabled>Сбросить историю статусов…</button></div>
    <p class="v2-muted" id="rh-status" role="status" aria-live="polite"></p>`;
  const $ = (s) => body.querySelector(s);
  const setStatus = (t) => { const n = $("#rh-status"); if (n) n.textContent = t; };
  const lock = () => { body.querySelectorAll("button, input").forEach((c) => { if (c.id === "rh-run") c.disabled = busy || !pv; else if (c.id === "rh-backup") c.disabled = busy || !canBackup; else c.disabled = busy; }); };
  function paint() {
    if (dead) return;
    const box = $("#rh-preview");
    if (!pv) return;
    box.innerHTML = `<div class="v2-callout" role="note"><strong>Будет затронуто:</strong> изделий — ${fmtNum(pv.elements)}; записей истории будет удалено — ${fmtNum(pv.history_rows)};
      изделий не в статусе «Запланирован» — ${fmtNum(pv.not_planned)}; с привязкой к контракту — ${fmtNum(pv.with_contract)}; с фактической датой поставки — ${fmtNum(pv.with_actual_date)}.</div>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Объект</th><th class="num">Изделий</th><th class="num">Не «Запланирован»</th><th class="num">С контрактом</th></tr></thead><tbody>
      ${pv.by_object.map((o) => `<tr><td>${esc(o.object)}</td><td class="num">${fmtNum(o.elements)}</td><td class="num">${fmtNum(o.not_planned)}</td><td class="num">${fmtNum(o.with_contract)}</td></tr>`).join("")}</tbody></table></div>`;
    lock();
  }
  async function loadPreview() {
    try { pv = await api.get("/admin/reset-status-history/preview"); paint(); return true; }
    catch (e) { if (!dead) { $("#rh-preview").innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось получить предпросмотр.</strong> ${esc(errText(e))}</div>`; } return false; }
  }
  async function run() {
    if (busy) return;
    busy = true; lock(); setStatus("Обновляем предпросмотр…");
    try {
      if (!(await loadPreview())) return;
      const wantBackup = $("#rh-backup").checked && canBackup;
      const msg = `Сбросить историю статусов ВСЕХ элементов?\n\nЗатронуто изделий: ${fmtNum(pv.elements)}; записей истории будет удалено: ${fmtNum(pv.history_rows)}; изделий вернётся в «Запланирован» из других статусов: ${fmtNum(pv.not_planned)}; контрактов будет снято у изделий: ${fmtNum(pv.with_contract)}.\n\n`
        + (wantBackup ? "Перед сбросом будет снята резервная копия." : "Резервная копия снята НЕ будет — вернуть данные будет нечем.");
      busy = false; lock();
      if (!(await askTyped(msg, "СБРОСИТЬ", { confirmLabel: "Сбросить историю", inputLabel: "Для подтверждения введите слово" }))) { setStatus(""); return; }
      busy = true; lock();
      let backupName = "";
      if (wantBackup) {
        setStatus("Снимаем резервную копию…");
        try { backupName = (await api.post("/admin/backups", { comment: "перед сбросом истории статусов (новый интерфейс)" })).name; }
        catch (e) { setStatus(`Копию снять не удалось — сброс НЕ выполнялся: ${errText(e)}`); return; }
      }
      setStatus("Сбрасываем историю…");
      const before = pv;
      try {
        const r = await api.post(`/admin/reset-status-history?expected_history=${before.history_rows}`, {});
        await loadPreview();
        setStatus(`Готово: сброшено изделий — ${fmtNum(r?.reset_count)}.${backupName ? ` Резервная копия: ${backupName}.` : ""}`);
      } catch (e) {
        if (unknownOutcome(e)) {
          // Исход неизвестен: повторно не отправляем; читаем состояние и говорим по факту.
          const ok = await loadPreview();
          const done = ok && pv.not_planned === 0 && pv.with_contract === 0 && pv.history_rows === pv.elements;
          setStatus(done ? "Сервер выполнил сброс, хотя ответ не дошёл." : ok ? `Сброс не подтверждён (${errText(e)}). Состояние на сервере прежнее — можно повторить.` : `Неизвестно, выполнен ли сброс (${errText(e)}). Проверьте предпросмотр после восстановления связи.`);
        } else { setStatus(errText(e) + (backupName ? ` Резервная копия ${backupName} снята.` : "")); if (e instanceof ApiError && e.status === 409) await loadPreview(); }
      }
    } finally { busy = false; lock(); }
  }
  $("#rh-refresh").addEventListener("click", async () => { if (busy) return; busy = true; lock(); setStatus(""); await loadPreview(); busy = false; lock(); });
  $("#rh-run").addEventListener("click", run);
  loadPreview();
  return { hasUnsavedChanges: () => false, guardLeave: async () => !busy, destroy() { dead = true; } };
}

// ================================================================== Резервные копии
const KEY_TABLES = [["elements", "Изделия"], ["status_history", "История статусов"], ["users", "Пользователи"], ["objects", "Объекты"], ["projects", "Проекты"], ["contracts", "Контракты"], ["activity_log", "Журнал действий"]];
export function mountBackups(el, { screen, groupTitle, api, rights }) {
  const body = frame(el, screen, groupTitle);
  const canWrite = can(rights, "backups", "write") && checkWrite("POST", "/admin/backups", { comment: "x" }).allowed;
  let dead = false, busy = false, seq = 0;
  const st = { data: null, error: "", q: "", comment: "" };
  body.innerHTML = `
    <div class="v2-callout" role="note"><strong>Копии базы данных.</strong> Служебные копии система снимает сама перед обновлением и разрушительными операциями. ${canWrite ? "Здесь можно снять копию вручную, восстановить базу из копии (перед этим снимается служебная копия текущего состояния) или удалить копию." : "У вас есть только просмотр."}</div>
    <div id="bk-disk" class="v2-muted"></div>
    ${canWrite ? `<form id="bk-form" class="v2-bar" autocomplete="off"><input id="bk-comment" class="v2-search" placeholder="Комментарий к копии (необязательно)" maxlength="200" aria-label="Комментарий к копии"><button type="submit" class="v2-btn v2-primary" id="bk-create">Создать копию</button></form>` : ""}
    <div class="v2-bar"><input type="search" id="bk-search" class="v2-search" placeholder="Поиск по названию, автору, комментарию" aria-label="Поиск"><span class="v2-muted" id="bk-count" role="status" aria-live="polite"></span><button type="button" class="v2-btn" id="bk-refresh">Обновить</button></div>
    <p class="v2-muted" id="bk-status" role="status" aria-live="polite"></p><div id="bk-body"></div>`;
  const $ = (s) => body.querySelector(s);
  const setStatus = (t) => { const n = $("#bk-status"); if (n) n.textContent = t; };
  const lock = () => body.querySelectorAll("#bk-body button, #bk-create, #bk-refresh, #bk-comment").forEach((c) => { c.disabled = busy || (c.id === "bk-create" && !st.data); });   // до загрузки списка «Создать» выключена
  function paint() {
    if (dead) return;
    const box = $("#bk-body");
    if (!st.data) { box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить список копий.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="bk-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`; $("#bk-retry")?.addEventListener("click", load); return; }
    const d = st.data.disk || {};
    $("#bk-disk").textContent = d.known ? `Свободно на диске сервера: ${fmtSize(d.free_bytes)}${d.database_bytes ? ` · размер базы: ${fmtSize(d.database_bytes)}` : ""}.` : "";
    const q = st.q.trim().toLowerCase();
    const rows = st.data.backups.filter((b) => !q || `${b.name} ${b.user_name || ""} ${b.comment || ""} ${b.kind_label || ""}`.toLowerCase().includes(q));
    $("#bk-count").textContent = `Копий: ${rows.length} из ${st.data.backups.length}`;
    box.innerHTML = rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Создана (UTC)</th><th>Вид</th><th>Кто</th><th>Комментарий</th><th class="num">Размер</th><th>Имя</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
      ${rows.map((b) => `<tr><td>${esc(b.created_at)}</td><td>${esc(b.kind_label)}</td><td>${esc(b.user_name || "")}</td><td>${esc(b.comment || "")}</td><td class="num">${esc(fmtSize(b.size_bytes))}</td><td>${esc(b.name)}</td>
        ${canWrite ? `<td><button type="button" class="v2-btn" data-restore="${esc(b.name)}" aria-label="Восстановить из ${esc(b.name)}">Восстановить…</button> <button type="button" class="v2-btn v2-danger" data-del="${esc(b.name)}" aria-label="Удалить ${esc(b.name)}">Удалить…</button></td>` : ""}</tr>`).join("")}</tbody></table></div>` : `<p class="v2-muted">${q ? "Ничего не найдено." : "Копий нет."}</p>`;
    lock();
  }
  async function load() {
    const my = ++seq;
    try { const d = await api.get("/admin/backups"); if (dead || my !== seq) return false; st.data = d; st.error = ""; paint(); return true; }
    catch (e) { if (dead || my !== seq) return false; if (!st.data) { st.error = errText(e); paint(); } else setStatus(`Список не обновился: ${errText(e)}`); return false; }
  }
  async function write(fn) { if (busy) return; busy = true; lock(); try { await fn(); } finally { busy = false; lock(); } }

  async function create() {
    const comment = ($("#bk-comment").value || "").trim() || null;
    const known = new Set(st.data?.backups.map((b) => b.name) || []);
    await write(async () => {
      setStatus("Создаём копию (может занять минуту)…");
      try {
        const m = await api.post("/admin/backups", { comment });
        $("#bk-comment").value = "";
        const ok = await load();
        setStatus(ok ? `Копия создана: ${m.name} (${fmtSize(m.size_bytes)}).` : `Копия создана: ${m.name}, но список обновить не удалось — нажмите «Обновить».`);
      } catch (e) {
        if (unknownOutcome(e)) { const ok = await load(); const fresh = ok && st.data.backups.find((b) => !known.has(b.name) && b.kind === "manual"); setStatus(fresh ? `Сервер создал копию ${fresh.name}, хотя ответ не дошёл.` : ok ? `Копия не создана (${errText(e)}).` : `Неизвестно, создана ли копия (${errText(e)}). Обновите список.`); }
        else setStatus(errText(e));   // 507 (нет места) и др.: введённый комментарий остаётся
      }
    });
  }
  async function del(name) {
    const b = st.data.backups.find((x) => x.name === name);
    if (!b) return;
    if (!(await showConfirmDialog(`Удалить копию «${name}» (${fmtSize(b.size_bytes)}, ${b.created_at})? Восстановить её будет нечем.`, { confirmLabel: "Удалить", danger: true }))) return;
    await write(async () => {
      setStatus("Удаляем…");
      try { await api.delete(`/admin/backups/${encodeURIComponent(name)}`); const ok = await load(); setStatus(ok ? `Копия удалена: ${name}.` : `Копия удалена: ${name}, но список обновить не удалось.`); }
      catch (e) {
        if (e instanceof ApiError && e.status === 404) { await load(); setStatus("Копии уже нет — список обновлён."); }
        else if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && !st.data.backups.some((x) => x.name === name) ? "Сервер удалил копию, хотя ответ не дошёл." : `Неизвестно, удалена ли копия (${errText(e)}). Проверьте список.`); }
        else setStatus(errText(e));
      }
    });
  }
  async function restore(name) {
    const b = st.data.backups.find((x) => x.name === name);
    if (!b) return;
    // Предпросмотр последствий: что в базе сейчас и что будет в копии (по ключевым таблицам).
    let now = {};
    try { (await api.get("/admin/db-status")).tables.forEach((t) => { now[t.name] = t.rows; }); } catch (e) { /* без сравнения: скажем об этом */ }
    const cmp = KEY_TABLES.map(([t, l]) => `• ${l}: сейчас ${now[t] != null ? fmtNum(now[t]) : "?"} → в копии ${b.stats?.[t] != null ? fmtNum(b.stats[t]) : "?"}`).join("\n");
    const msg = `Восстановить базу из копии «${name}» (${b.created_at} UTC, ${b.kind_label})?\n\nВСЯ база будет заменена содержимым копии: всё, что появилось после ${b.created_at}, будет потеряно (пользователи, доступы, данные, сеансы).\nПеред восстановлением система снимет служебную копию текущего состояния.\n\n${cmp}`;
    if (!(await askTyped(msg, "ВОССТАНОВИТЬ", { confirmLabel: "Восстановить", inputLabel: "Для подтверждения введите слово" }))) return;
    await write(async () => {
      setStatus("Восстанавливаем базу… не закрывайте страницу.");
      try {
        const r = await api.post(`/admin/backups/${encodeURIComponent(name)}/restore`, {});
        let sessionAlive = true;
        try { await api.get("/me"); } catch (e) { sessionAlive = !(e instanceof ApiError && e.status === 401); }
        const ok = sessionAlive && (await load());
        setStatus(`Восстановлено из «${name}». Служебная копия текущего состояния: ${r.safety_backup?.name}. ${sessionAlive ? (ok ? "" : "Список обновить не удалось.") : "Ваш сеанс в восстановленной базе не найден — войдите заново (обновите страницу)."}`);
        if (!sessionAlive) setTimeout(() => location.reload(), 2500);
      } catch (e) {
        if (unknownOutcome(e)) setStatus(`Неизвестно, выполнено ли восстановление (${errText(e)}). Ничего не повторено автоматически: обновите страницу и проверьте данные и список копий.`);
        else setStatus(errText(e));
      }
    });
  }
  $("#bk-form")?.addEventListener("submit", (e) => { e.preventDefault(); if (!busy && st.data) create(); });
  $("#bk-search").addEventListener("input", (e) => { st.q = e.target.value; paint(); });
  $("#bk-refresh").addEventListener("click", () => { if (!busy) load(); });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || busy) return;
    if (b.dataset.restore) restore(b.dataset.restore); else if (b.dataset.del) del(b.dataset.del);
  });
  lock();
  load();
  return { hasUnsavedChanges: () => !!($("#bk-comment")?.value || "").trim(), guardLeave: async () => !busy, destroy() { dead = true; } };
}

// ================================================================== Доменная авторизация (LDAP)
export function mountLdap(el, { screen, groupTitle, api, rights }) {
  const body = frame(el, screen, groupTitle);
  const canWrite = can(rights, "ldap", "write") && checkWrite("PUT", "/ldap-settings", { enabled: false }).allowed;
  let dead = false, busy = false, base = null, info = null;
  body.innerHTML = `<p class="v2-muted" id="ld-load" role="status">Загрузка…</p><div id="ld-body" hidden></div>`;
  const $ = (s) => body.querySelector(s);
  const FIELDS = ["enabled", "host", "port", "use_ssl", "start_tls", "verify_certificate", "login_template", "timeout_seconds", "base_dn"];
  const val = () => ({
    enabled: $("#ld-enabled").checked, host: $("#ld-host").value.trim(), port: Number($("#ld-port").value) || 389, use_ssl: $("#ld-ssl").checked, start_tls: $("#ld-tls").checked,
    verify_certificate: $("#ld-verify").checked, login_template: $("#ld-template").value.trim(), timeout_seconds: Number($("#ld-timeout").value) || 5, base_dn: $("#ld-basedn").value.trim(),
  });
  const same = (a, b) => FIELDS.every((k) => a[k] === b[k]);
  const dirty = () => !!base && !!$("#ld-host") && !same(val(), base);
  const setStatus = (t) => { const n = $("#ld-status"); if (n) n.textContent = t; };
  function fill(cfg) {
    $("#ld-enabled").checked = !!cfg.enabled; $("#ld-host").value = cfg.host || ""; $("#ld-port").value = cfg.port || 389; $("#ld-ssl").checked = !!cfg.use_ssl; $("#ld-tls").checked = !!cfg.start_tls;
    $("#ld-verify").checked = cfg.verify_certificate !== false; $("#ld-template").value = cfg.login_template || ""; $("#ld-timeout").value = cfg.timeout_seconds || 5; $("#ld-basedn").value = cfg.base_dn || "";
  }
  function build() {
    const dis = canWrite ? "" : "disabled";
    $("#ld-body").innerHTML = `
      <div class="v2-callout" role="note"><strong>Вход по доменной учётной записи.</strong> Когда включено, пользователи с доменным способом входа проверяются в каталоге домена (LDAP); пароль домена сервис не хранит.
        Служебной учётной записи у сервиса нет намеренно. ${canWrite ? "" : "У вас только просмотр."}</div>
      <p class="v2-muted" id="ld-info"></p>
      <div class="v2-fields">
        <label class="v2-role-check v2-span"><input type="checkbox" id="ld-enabled" ${dis}><span>Доменная авторизация включена</span></label>
        <label class="v2-field">Сервер<input id="ld-host" ${dis} placeholder="dc.example.local"></label>
        <label class="v2-field">Порт<input id="ld-port" type="number" min="1" max="65535" ${dis}></label>
        <label class="v2-role-check"><input type="checkbox" id="ld-ssl" ${dis}><span>SSL (LDAPS)</span></label>
        <label class="v2-role-check"><input type="checkbox" id="ld-tls" ${dis}><span>STARTTLS</span></label>
        <label class="v2-role-check"><input type="checkbox" id="ld-verify" ${dis}><span>Проверять сертификат сервера</span></label>
        <label class="v2-field v2-span">Шаблон входа<input id="ld-template" ${dis} placeholder="{login}@example.local"></label>
        <label class="v2-field">Таймаут, сек<input id="ld-timeout" type="number" min="1" max="60" ${dis}></label>
        <label class="v2-field">Базовый DN (для поиска людей)<input id="ld-basedn" ${dis} placeholder="DC=example,DC=local"></label>
      </div>
      <div class="v2-auth-error" id="ld-error" role="alert"></div>
      <div class="v2-inline">${canWrite ? `<button type="button" class="v2-btn v2-primary" id="ld-save" disabled>Сохранить</button><button type="button" class="v2-btn" id="ld-cancel" disabled>Отменить</button>` : ""}<button type="button" class="v2-btn" id="ld-reload">Перечитать</button></div>
      <p class="v2-muted" id="ld-status" role="status" aria-live="polite"></p>
      <div class="v2-result"><h4>Проверка соединения</h4>
        <p class="v2-muted">Пробная привязка ТЕКУЩИМИ значениями формы (сохранять не обязательно). Логин и пароль вводите вы; они уходят только на проверку и нигде не сохраняются.</p>
        <div class="v2-fields"><label class="v2-field">Доменный логин<input id="ld-test-login" autocomplete="off"></label><label class="v2-field">Пароль<input id="ld-test-pass" type="password" autocomplete="new-password"></label></div>
        <div class="v2-inline"><button type="button" class="v2-btn" id="ld-test">Проверить</button></div><p id="ld-test-result" role="status" aria-live="polite"></p></div>`;
    $("#ld-info").textContent = `Пользователей с доменным входом: ${info.domain_users}.${info.library_available ? "" : ` На сервере нет библиотеки ldap3 (${info.library_error || "—"}) — нужен новый образ приложения.`}`;
    fill(base);
    const refresh = () => { const d = dirty(); const s = $("#ld-save"), c = $("#ld-cancel"); if (s) { s.disabled = busy || !d; c.disabled = busy || !d; } setStatus(d ? "Есть несохранённые изменения" : ""); };
    $("#ld-body").addEventListener("input", refresh); $("#ld-body").addEventListener("change", refresh);
    $("#ld-cancel")?.addEventListener("click", () => { fill(base); $("#ld-error").textContent = ""; refresh(); });
    $("#ld-reload").addEventListener("click", async () => {
      if (busy) return;
      if (dirty() && !(await showConfirmDialog("Перечитать настройки? Несохранённые правки будут отброшены.", { confirmLabel: "Перечитать" }))) return;
      await load(true);
    });
    $("#ld-save")?.addEventListener("click", save);
    $("#ld-test").addEventListener("click", test);
  }
  async function load(rebuild) {
    try {
      const d = await api.get("/ldap-settings");
      if (dead) return false;
      base = d.config; info = d; $("#ld-load").hidden = true; $("#ld-body").hidden = false;
      if (rebuild || !$("#ld-host")) build(); else { fill(base); }
      return true;
    } catch (e) {
      if (dead) return false;
      if (!base) $("#ld-load").innerHTML = `<span class="v2-auth-error" role="alert">Не удалось загрузить настройки: ${esc(errText(e))}</span> <button type="button" class="v2-btn" id="ld-retry">Повторить</button>`;
      $("#ld-retry")?.addEventListener("click", () => load(true));
      return false;
    }
  }
  const lockAll = (v) => { busy = v; body.querySelectorAll("button, input").forEach((c) => { c.disabled = v; }); if (!v) { const d = dirty(); const s = $("#ld-save"), c = $("#ld-cancel"); if (s) { s.disabled = !d; c.disabled = !d; } } };
  async function save() {
    if (busy) return;
    $("#ld-error").textContent = "";
    const want = val();
    // Настройку могли изменить, пока форма была открыта: сверяем с сервером и НЕ перезаписываем молча (запись целиком).
    lockAll(true); setStatus("Сохраняем…");
    try {
      let fresh;
      try { fresh = (await api.get("/ldap-settings")).config; } catch (e) { $("#ld-error").textContent = `Не удалось проверить актуальность настроек: ${errText(e)}`; return; }
      if (!same(fresh, base)) { $("#ld-error").textContent = "Настройки уже изменил кто-то другой, пока форма была открыта. Ничего не сохранено — нажмите «Перечитать» и повторите правку."; return; }
      if (base.enabled && !want.enabled && info.domain_users > 0) {
        lockAll(false);
        if (!(await showConfirmDialog(`Выключить доменную авторизацию? Пользователи с доменным входом (${info.domain_users}) останутся без возможности войти, пока вы не переведёте их на пароль сервиса.`, { confirmLabel: "Выключить", danger: true }))) return;
        lockAll(true);
      }
      try {
        const r = await api.put("/ldap-settings", want);
        const ok = await load(true);
        setStatus(`Настройки сохранены.${r?.warning ? ` ${r.warning}` : ""}${ok ? "" : " Обновить форму не удалось."}`);
      } catch (e) {
        if (unknownOutcome(e)) {
          const ok = await load(false);
          setStatus(ok && same(base, want) ? "Сервер сохранил настройки, хотя ответ не дошёл." : `Неизвестно, сохранены ли настройки (${errText(e)}). Ничего не повторено автоматически.`);
        } else $("#ld-error").textContent = errText(e);   // 422: неверное значение — ввод остаётся
      }
    } finally { lockAll(false); }
  }
  async function test() {
    if (busy) return;
    const login = $("#ld-test-login").value.trim(), password = $("#ld-test-pass").value, out = $("#ld-test-result");
    if (!login || !password) { out.textContent = "Введите доменный логин и пароль для пробной привязки"; return; }
    lockAll(true); out.textContent = "Проверяю…";
    try {
      const r = await api.post("/ldap-settings/test", { login, password, config: val() });
      out.textContent = `${r.ok ? "✓ " : "✕ "}${r.detail}${r.ok || !r.bind_name ? "" : ` (домену отправлялось: ${r.bind_name})`}`;
    } catch (e) { out.textContent = errText(e); }
    finally { $("#ld-test-pass").value = ""; lockAll(false); }
  }
  load(true);
  return { hasUnsavedChanges: dirty, async guardLeave() { return !dirty() || (await showConfirmDialog("В настройках доменной авторизации есть несохранённые изменения. Уйти без сохранения?", { confirmLabel: "Уйти" })); }, destroy() { dead = true; } };
}

// ================================================================== Карта: подложка и источник
export function mountMapAdmin(el, { screen, groupTitle, api, rights }) {
  const body = frame(el, screen, groupTitle);
  const canWrite = can(rights, "map", "write") && checkWrite("PUT", "/map/online-tiles", { enabled: true }).allowed;
  let dead = false, busy = false, cfg = null;
  body.innerHTML = `<div id="mp-body"><p class="v2-muted" role="status">Загрузка…</p></div><p class="v2-muted" id="mp-status" role="status" aria-live="polite"></p>`;
  const $ = (s) => body.querySelector(s);
  const setStatus = (t) => { const n = $("#mp-status"); if (n) n.textContent = t; };
  function paint() {
    if (dead) return;
    if (!cfg) return;
    $("#mp-body").innerHTML = `
      <div class="v2-callout" role="note"><strong>Подложка карты проектов.</strong> Онлайн-подложка берёт плитки из интернета (браузеры пользователей ходят наружу); без неё карта работает только с файлом PMTiles на сервере. ${canWrite ? "" : "У вас только просмотр."}</div>
      <label class="v2-role-check"><input type="checkbox" id="mp-online" ${cfg.online ? "checked" : ""} ${canWrite && !busy ? "" : "disabled"}><span>Подложка из интернета (${esc(cfg.online_url || "адрес показывается, когда включена")})</span></label>
      <h4 style="margin-top:16px">Файлы подложки на сервере</h4>
      ${cfg.basemaps.length ? `<table class="v2-read-tbl"><thead><tr><th>Файл</th><th class="num">Размер</th><th>Состояние</th></tr></thead><tbody>${cfg.basemaps.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${esc(fmtSize(b.size))}</td><td>${b.problem ? `<span class="v2-chip">${esc(b.problem)}</span>` : "исправен"}</td></tr>`).join("")}</tbody></table>` : `<p class="v2-note">Файлов подложки на сервере нет.</p>`}
      ${canWrite ? `<div class="v2-inline" style="margin-top:12px"><input type="file" id="mp-file" accept=".pmtiles" aria-label="Файл подложки PMTiles" ${busy ? "disabled" : ""}><button type="button" class="v2-btn" id="mp-upload" ${busy ? "disabled" : ""}>Загрузить файл подложки</button></div>` : ""}`;
  }
  async function load() {
    try { cfg = await api.get("/map/config"); paint(); return true; }
    catch (e) { if (!dead && !cfg) $("#mp-body").innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить настройки карты.</strong> ${esc(errText(e))}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="mp-retry">Повторить</button></div></div>`; $("#mp-retry")?.addEventListener("click", load); return false; }
  }
  body.addEventListener("change", async (e) => {
    if (e.target.id !== "mp-online" || busy) return;
    const want = e.target.checked;
    if (!(await showConfirmDialog(want ? "Включить подложку из интернета? Браузеры пользователей начнут запрашивать плитки карты с внешнего адреса; страница перезагрузится." : "Выключить подложку из интернета? Карта будет работать только с файлом на сервере; страница перезагрузится.", { confirmLabel: want ? "Включить" : "Выключить" }))) { e.target.checked = !want; return; }
    busy = true; paint(); setStatus("Сохраняем…");
    try {
      await api.put("/map/online-tiles", { enabled: want });
      setStatus(want ? "Подложка включена. Страница перезагрузится." : "Подложка выключена. Страница перезагрузится.");
      setTimeout(() => location.reload(), 900);   // политика безопасности страницы обновляется только перезагрузкой
    } catch (err) {
      if (unknownOutcome(err)) { const ok = await load(); setStatus(ok && cfg.online === want ? "Сервер применил настройку, хотя ответ не дошёл. Обновите страницу." : `Неизвестно, применена ли настройка (${errText(err)}).`); }
      else { setStatus(errText(err)); await load(); }
    }
    busy = false; paint();
  });
  body.addEventListener("click", async (e) => {
    if (e.target.id !== "mp-upload" || busy) return;
    const f = $("#mp-file").files[0];
    if (!f) { setStatus("Выберите файл подложки (.pmtiles)."); return; }
    busy = true; paint(); setStatus(`Загрузка «${f.name}» (${fmtSize(f.size)})…`);
    const fd = new FormData(); fd.append("file", f);
    try { const r = await api.upload("/map/tiles/upload", fd); await load(); setStatus(`Подложка «${r.name}» загружена (${fmtSize(r.size)}).`); }
    catch (err) {
      if (unknownOutcome(err)) { const ok = await load(); setStatus(ok && cfg.basemaps.some((b) => b.name === f.name && !b.problem) ? `Сервер принял файл «${f.name}», хотя ответ не дошёл.` : `Неизвестно, загружен ли файл (${errText(err)}). Проверьте список.`); }
      else setStatus(errText(err));   // 400: не PMTiles — на сервере файл не остаётся
    }
    busy = false; paint();
  });
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => !busy, destroy() { dead = true; } };
}

// ================================================================== Журнал действий + очистка
export function mountActivity(el, ctx) {
  const { screen, groupTitle, api, rights } = ctx;
  const canClean = can(rights, "activity_log", "write") && checkWrite("POST", "/activity/cleanup", {}).allowed;
  el.className = "v2-page";
  el.innerHTML = `<div class="v2-container v2-screen" style="margin-bottom:0;padding-bottom:0"><p class="v2-muted" id="ac-stats" role="status" aria-live="polite">Считаю объём журнала…</p></div>
    <div id="ac-read"></div>${canClean ? `<div class="v2-container v2-screen" style="margin-top:0"><section class="v2-result" id="ac-clean"></section></div>` : ""}`;
  const readModule = mountReadScreen(el.querySelector("#ac-read"), { ...ctx, screen: { ...screen, impl: "read" } });
  let busy = false, dead = false;
  (async () => {
    const box = el.querySelector("#ac-stats");
    try {
      const s = await api.get("/activity/stats");
      if (dead || !box) return;
      const parts = [`В журнале ${fmtNum(s.rows)} ${plural(s.rows, "запись", "записи", "записей")}`];
      parts.push(s.bytes == null ? "объём таблицы неизвестен (сборка SQLite без dbstat)" : `${fmtSize(s.bytes)} с индексами из ${fmtSize(s.db_bytes)} базы`);
      if (s.errors) parts.push(`ошибок и отказов: ${fmtNum(s.errors)}`);
      if (s.oldest) parts.push(`самая ранняя запись — ${String(s.oldest).slice(0, 10)}`);
      box.textContent = parts.join(" · ");
      box.title = "Очистка убирает записи, но файл базы сам по себе не уменьшается: освободившееся место SQLite отдаёт под новые записи. Полностью вернуть его диску можно только сжатием базы (VACUUM).";
    } catch (e) { if (!dead && box) box.textContent = `Не удалось узнать объём журнала: ${errText(e)}`; }
  })();
  const host = el.querySelector("#ac-clean");
  if (host) {
    host.innerHTML = `<h3>Очистка журнала</h3>
      <p class="v2-muted">Удаляет записи журнала СТРОГО РАНЬШЕ выбранной даты (сам день остаётся). Сам факт очистки записывается в журнал. Необратимо — только восстановлением резервной копии.</p>
      <div class="v2-inline"><label class="v2-field">Удалить записи раньше<input type="date" id="ac-date"></label><button type="button" class="v2-btn" id="ac-count" disabled>Посчитать</button><button type="button" class="v2-btn v2-danger" id="ac-run" disabled>Очистить…</button></div>
      <p class="v2-muted" id="ac-status" role="status" aria-live="polite"></p>`;
    const $ = (s) => host.querySelector(s);
    const setStatus = (t) => { $("#ac-status").textContent = t; };
    let counted = null;   // {date, n}
    const lock = () => { $("#ac-date").disabled = busy; $("#ac-count").disabled = busy || !$("#ac-date").value; $("#ac-run").disabled = busy || !counted || counted.date !== $("#ac-date").value || !counted.n; };
    const dayBefore = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
    const countBefore = async (date) => (await api.get(`/activity?date_to=${dayBefore(date)}&limit=1`)).total;
    $("#ac-date").addEventListener("input", () => { counted = null; setStatus(""); lock(); });
    $("#ac-count").addEventListener("click", async () => {
      const date = $("#ac-date").value;
      if (!date || busy) return;
      busy = true; lock(); setStatus("Считаем…");
      try { const n = await countBefore(date); counted = { date, n }; setStatus(n ? `Будет удалено записей: ${fmtNum(n)} (раньше ${date}).` : `Раньше ${date} записей нет — удалять нечего.`); }
      catch (e) { setStatus(errText(e)); }
      busy = false; lock();
    });
    $("#ac-run").addEventListener("click", async () => {
      if (busy || !counted) return;
      const { date, n } = counted;
      if (!(await askTyped(`Удалить из журнала действий записи раньше ${date}?\n\nБудет удалено записей: ${fmtNum(n)}. Это необратимо.`, date, { confirmLabel: "Очистить журнал", inputLabel: "Для подтверждения введите дату" }))) return;
      busy = true; lock(); setStatus("Очищаем…");
      try {
        const r = await api.post(`/activity/cleanup?before=${encodeURIComponent(date)}`, {});
        counted = null;
        setStatus(`Удалено записей: ${fmtNum(r?.deleted)} (раньше ${date}). Сам факт очистки записан в журнал.`);
      } catch (e) {
        if (unknownOutcome(e)) { let left = null; try { left = await countBefore(date); } catch (x) { /* нет связи */ } setStatus(left === 0 ? "Сервер очистил журнал, хотя ответ не дошёл." : left != null ? `Очистка не подтверждена (${errText(e)}); записей раньше даты осталось: ${fmtNum(left)}.` : `Неизвестно, выполнена ли очистка (${errText(e)}).`); }
        else setStatus(errText(e));
      }
      busy = false; lock();
    });
  }
  return { hasUnsavedChanges: () => !!readModule?.hasUnsavedChanges?.(), guardLeave: async () => !busy, destroy() { dead = true; readModule?.destroy?.(); } };
}

// ================================================================== Что нового: обработки данных (для администратора)
export function mountChangelogTasks(el, ctx) {
  const { screen, groupTitle, api, rights } = ctx;
  const canRun = can(rights, "release_tasks", "write") && checkWrite("POST", "/release-tasks/x/run", {}).allowed;
  el.className = "v2-page";
  el.innerHTML = `<div id="cl-read"></div>${rights?.system_admin || rights?.features?.release_tasks ? `<div class="v2-container v2-screen"><section class="v2-result" id="cl-tasks"></section></div>` : ""}`;
  const readModule = mountReadScreen(el.querySelector("#cl-read"), { ...ctx, screen: { ...screen, impl: "read" } });
  const host = el.querySelector("#cl-tasks");
  let busy = false, dead = false;
  const RU = { ok: "выполнена", failed: "не удалась", pending: "ожидает", skipped: "пропущена" };
  async function load() {
    try {
      const d = await api.get("/release-status");
      if (dead || !host) return;
      host.innerHTML = `<h3>Обработки данных при обновлении</h3>
        <p class="v2-muted">Версия кода ${esc(d.code_version)}, версия базы ${esc(d.db_version)}. ${d.complete ? "Все обработки выполнены." : `Не выполнено: ${d.failed + d.pending}.`} Перед повторным запуском система снимает резервную копию.</p>
        ${d.tasks?.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Версия</th><th>Обработка</th><th>Состояние</th><th>Итог</th>${canRun ? "<th></th>" : ""}</tr></thead><tbody>
        ${d.tasks.map((t) => `<tr><td>${esc(t.version)}</td><td>${esc(t.title)}<div class="v2-muted">${esc(t.why || "")}</div></td><td>${esc(RU[t.status] || t.status)}</td><td>${esc(t.note || "")}${t.applied_at ? `<div class="v2-muted">${esc(t.applied_at)}, попыток: ${esc(t.attempts)}</div>` : ""}</td>
          ${canRun ? `<td>${t.status !== "ok" || t.kind === "cleanup" ? `<button type="button" class="v2-btn" data-run="${esc(t.name)}" ${busy ? "disabled" : ""}>${t.kind === "cleanup" ? "Выполнить уборку…" : "Повторить…"}</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : ""}
        <p class="v2-muted" id="cl-task-status" role="status" aria-live="polite"></p>`;
    } catch (e) { if (host && !dead) host.innerHTML = `<p class="v2-muted">Список обработок недоступен: ${esc(errText(e))}</p>`; }
  }
  host?.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-run]");
    if (!b || busy) return;
    const name = b.dataset.run;
    if (!(await showConfirmDialog(`Запустить обработку «${name}»? Перед запуском будет снята резервная копия базы.`, { confirmLabel: "Запустить" }))) return;
    busy = true; host.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    const say = (t) => { const n = host.querySelector("#cl-task-status"); if (n) n.textContent = t; };
    say("Запускаем…");
    try { const r = await api.post(`/release-tasks/${encodeURIComponent(name)}/run`, {}); busy = false; await load(); say(`Готово: ${r?.note || r?.status || "выполнено"}.`); }
    catch (err) { busy = false; if (unknownOutcome(err)) { await load(); say(`Неизвестно, выполнена ли обработка (${errText(err)}). Состояние перечитано.`); } else { await load(); say(errText(err)); } }
    busy = false;
  });
  load();
  return { hasUnsavedChanges: () => !!readModule?.hasUnsavedChanges?.(), guardLeave: async () => !busy, destroy() { dead = true; readModule?.destroy?.(); } };
}

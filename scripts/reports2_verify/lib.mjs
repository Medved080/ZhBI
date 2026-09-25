// Общие функции проверок области «reports2» («Статус комплектации» — сводная таблица в V2; «График контрактации и
// поставки» — фильтр схемы на сервере и в V2). Сервер, копия БД, вход и учёт результатов — те же, что у «charts»
// (scripts/charts_verify/lib.mjs: настоящий app.main:app на ВРЕМЕННОЙ копии обезличенной БД, настоящий вход).
// Порты области — 8340–8349.
export * from "../charts_verify/lib.mjs";
import { sleep, PASS } from "../charts_verify/lib.mjs";

// Вход по HTTP (для проверок сервера без браузера): cookie сеанса из ответа POST /login.
export async function httpLogin(base, user) {
  const r = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: PASS }) });
  if (!r.ok) throw new Error(`вход ${user}: ${r.status}`);
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get("set-cookie")]).map((c) => String(c).split(";")[0]).join("; ");
  return {
    async post(path, body) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
      return { status: res.status, json, text, type: res.headers.get("content-type") };
    },
  };
}

// Настоящий ввод с клавиатуры одного символа (keyDown/keyUp): закрытый <select> в фокусе выбирает вариант по
// первой букве — так выбирается значение без программной подмены (в безголовом Chrome на macOS стрелки у закрытого
// списка значение не меняют, а всплывающий список недоступен для событий мыши).
// Только keyDown с text (он сам порождает keypress) и keyUp: добавочное событие "char" давало ВТОРОЕ нажатие той же буквы,
// и перебор вариантов на одну букву («По дням»/«По неделям»…) перескакивал через один.
export async function typeChar(b, ch) {
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
}

// Выбрать вариант <select> настроек отчёта V2: НАСТОЯЩИЙ щелчок мышью по подписи поля (активация <label> ставит фокус
// в его список, не раскрывая всплывающее меню) и ввод первой буквы варианта.
export async function chooseByLabel(b, fieldLabel, firstLetter) {
  const r = await b.eval(`(()=>{const l=[...document.querySelectorAll('.v2-report-controls label.v2-wire-field')].find(x=>x.querySelector('span')?.textContent.trim()===${JSON.stringify(fieldLabel)}); if(!l) return null; l.scrollIntoView({block:'center'}); const s=l.querySelector('span').getBoundingClientRect(); return {x:s.x+s.width/2,y:s.y+s.height/2};})()`);
  if (!r) throw new Error(`нет поля «${fieldLabel}»`);
  await b.click(r.x, r.y);
  await sleep(120);
  const focused = await b.eval(`document.activeElement?.tagName === 'SELECT'`);
  if (!focused) throw new Error(`щелчок по подписи «${fieldLabel}» не поставил фокус в список`);
  // несколько букв подряд — поиск по началу подписи («По н» → «По неделям»), как при наборе человеком
  for (const ch of firstLetter) await typeChar(b, ch);
  await sleep(150);
}

// Щелчок НАСТОЯЩЕЙ мышью по элементу (с прокруткой в видимую часть его области).
export async function clickEl(b, jsExpr) {
  const r = await b.eval(`(()=>{const e=${jsExpr}; if(!e) return null; e.scrollIntoView({block:'center',inline:'nearest'}); const q=e.getBoundingClientRect(); return {x:q.x+q.width/2,y:q.y+q.height/2};})()`);
  if (!r) throw new Error("нет элемента: " + jsExpr.slice(0, 120));
  await sleep(80);
  await b.click(r.x, r.y);
}

// Тело ответа запроса, пойманного браузером (DevTools Network.getResponseBody) — числа, которые реально получил экран.
// Заголовки ответа приходят раньше тела — пока тело не догружено, DevTools отвечает ошибкой, поэтому повтор с паузой.
export async function responseJson(b, req) {
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await b.send("Network.getResponseBody", { requestId: req.id });
      return JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body);
    } catch (e) { last = e; await sleep(250); }
  }
  throw last;
}

// Дождаться завершения запроса к адресу (по регулярному выражению), начиная с позиции from в журнале запросов.
export async function waitReq(b, re, from = 0, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = b.requests.slice(from).find((x) => re.test(x.url) && x.status !== undefined);
    if (r) return r;
    if (Date.now() - t0 > timeout) throw new Error("не дождались запроса " + re);
    await sleep(100);
  }
}

// ---- отбор фильтром схемы: одно и то же значение «Статус» снимается в V2 и в V1 НАСТОЯЩИМ щелчком ----

// V2: рабочее место «Модель» → вкладка «Фильтры» → снять первое значение группы «Статус». Возвращает подпись значения
// и снимок отбора (sessionStorage v2.schemeFilterSnapshot), который затем читают отчёты.
export async function v2ExcludeFirstStatus(b, openScreen) {
  await openScreen(b, "ws-model", `document.querySelector('#ws-panel-body')`);
  await b.waitFor(`(document.querySelector('#ws-status')?.textContent||'').includes('Показано')`, 30000);
  await sleep(400);
  await clickEl(b, `[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()==='Фильтры')`);
  await b.waitFor(`!!document.querySelector('input[data-key="status"]')`, 15000);
  await sleep(300);
  const label = await b.eval(`document.querySelector('input[data-key="status"]').closest('label').querySelector('span').textContent.trim()`);
  await clickEl(b, `document.querySelector('input[data-key="status"]')`);
  await b.waitFor(`(()=>{const s=JSON.parse(sessionStorage.getItem('v2.schemeFilterSnapshot')||'null'); return s && s.excluded > 0;})()`, 20000);
  const snap = await b.eval(`JSON.parse(sessionStorage.getItem('v2.schemeFilterSnapshot'))`);
  return { label, snap };
}

// V1 (`/`): вкладка «Фильтры» → группа «Статус» (раскрыть, если свёрнута) → снять значение с той же подписью.
// V1 при входе показывает «Что нового», пока пользователь не нажал «Ознакомился» (с новыми записями журнала — снова):
// окно перекрывает страницу, и щелчки проверки уходят в его подложку. Закрываем НАСТОЯЩИМ щелчком по «Закрыть» —
// как человек; «Ознакомился» не нажимаем, чтобы проверка не писала в базу.
export async function v1CloseChangelog(b) {
  await sleep(300);
  if (await b.eval(`!!document.getElementById('changelog-backdrop')?.classList.contains('open')`)) {
    await clickEl(b, `document.getElementById('changelog-close')`);
    await b.waitFor(`!document.getElementById('changelog-backdrop').classList.contains('open')`, 5000);
  }
}

export async function v1ExcludeStatus(b, label) {
  await clickEl(b, `document.querySelector('.tab-btn[data-tab="filters"]')`);
  await b.waitFor(`!!document.querySelector('#placement-filters .filter-group[data-filter-key="status"]')`, 15000);
  const open = await b.eval(`document.querySelector('#placement-filters .filter-group[data-filter-key="status"] .filter-group-body')?.classList.contains('open')`);
  if (!open) await clickEl(b, `document.querySelector('#placement-filters .filter-group[data-filter-key="status"] .filter-expand-btn')`);
  await sleep(200);
  const find = `[...document.querySelectorAll('#placement-filters .filter-group[data-filter-key="status"] .filter-group-body label.toggle')].find(l=>l.textContent.trim()===${JSON.stringify(label)})?.querySelector('input')`;
  if (!(await b.eval(`!!${find}`))) throw new Error(`в V1 нет значения фильтра «${label}»`);
  await clickEl(b, find);
  await sleep(500);
  return b.eval(`state.elements.filter(passesPlacementFilters).map(e=>e.id)`);
}

// V1: открыть форму отчётов на нужном отчёте (пункт меню лежит в свёрнутом бургер-меню — щелчок программный; это
// чтение ОБРАЗЦА в V1, а не проверяемая операция V2) и дождаться ответа сервера.
export async function v1OpenReport(b, key) {
  await b.eval(`document.getElementById("menu-report-${key}").click()`);
  await b.waitFor(`typeof reportData !== "undefined" && !!reportData && currentReport === ${JSON.stringify(key.replace(/-/g, "_"))} && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  await sleep(300);
}

// Выбрать в списке значение, у которого подпись начинается с той же буквы, что и у соседних («По дням», «По неделям»…):
// каждая буква с клавиатуры переходит к СЛЕДУЮЩЕМУ варианту на эту букву (как у человека); после каждого выбора
// отчёт перестраивается (список пересоздаётся), поэтому фокус ставится заново щелчком по подписи.
export async function chooseValue(b, fieldLabel, letter, value, readyExpr, max = 6) {
  for (let i = 0; i < max; i++) {
    const cur = await b.eval(`[...document.querySelectorAll('.v2-report-controls label.v2-wire-field')].find(x=>x.querySelector('span')?.textContent.trim()===${JSON.stringify(fieldLabel)})?.querySelector('select')?.value`);
    if (cur === value) return i;
    await chooseByLabel(b, fieldLabel, letter);
    await b.waitFor(readyExpr, 30000);
    await sleep(200);
  }
  throw new Error(`не удалось выбрать ${value} в «${fieldLabel}»`);
}

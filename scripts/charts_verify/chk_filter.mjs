// Проверка «Учитывать текущий фильтр схемы» (charts, 2026-09-22): рабочее место «Модель» кладёт снимок
// отбора (scheme-filter-snapshot.js, embed-bridge.js getFilteredIds) при каждом изменении фильтра; отчёты
// («Статус монтажа», «Статус комплектации» — включена по умолчанию) читают его и сужают запрос, показывая
// пользователю, чей это отбор и когда сделан; снимок ЧУЖОГО объекта не применяется — галочка недоступна с
// объяснением. Настоящий backend (копия обезличенной БД), настоящий вход формой V2, настоящие события мыши
// (scripts/cdp.mjs). Запуск: node scripts/charts_verify/chk_filter.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen, setObject } from "../verify_mfr_lib.mjs";

const PORT = 8272;
const S = await startServer(PORT, `${SP}/charts_filter`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_filter_shots` });

  // ---- шаг 1: рабочее место «Модель», объект 1 — сузить фильтр по статусу ----
  await openScreen(b, "ws-model", `document.querySelector('#ws-panel-body')`);
  await b.waitFor(`(document.querySelector('#ws-panel-body')?.innerText||'').length > 10`, 20000);
  // ждём НАСТОЯЩУЮ загрузку схемы (сцена доложила total>0), а не просто наличие панели — до этого фильтр по
  // объекту пуст (сцена в кадре ещё тянет DXF-элементы), ровно тот ранний момент, который workspace.js теперь
  // сознательно пропускает (см. правку onMessage: снимок не пишется, пока !sc.loaded).
  await b.waitFor(`(document.querySelector('#ws-status')?.textContent||'').includes('Показано')`, 20000);
  await sleep(400);
  // открыть вкладку «Фильтры» (группа «Статус» раскрыта по умолчанию — openGroups в workspace.js)
  await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()==='Фильтры')?.click()`);
  await b.waitFor(`!!document.querySelector('input[data-key="status"]')`, 15000);
  await sleep(300);
  const cbRect = await b.eval(`(()=>{const cb=document.querySelector('input[data-key="status"]'); if(!cb) return null; cb.scrollIntoView({block:'center'}); const r=cb.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  check("нашли чекбокс значения фильтра «Статус» для снятия", !!cbRect, JSON.stringify(cbRect));
  if (cbRect) {
    await b.click(cbRect.x, cbRect.y);
    await sleep(700);
    const snap = await b.eval(`JSON.parse(sessionStorage.getItem('v2.schemeFilterSnapshot')||'null')`);
    check("снимок фильтра появился в sessionStorage после снятия значения", !!snap && snap.objectId === 1 && Array.isArray(snap.elementIds), JSON.stringify(snap && { objectId: snap.objectId, n: snap.elementIds.length, shown: snap.shown, total: snap.total }));
    check("снимок УЖЕ сузился (elementIds меньше total)", snap && snap.elementIds.length < snap.total, snap ? `${snap.elementIds.length} из ${snap.total}` : "");
    global.__snapCount = snap?.elementIds?.length;
    global.__snapTotal = snap?.total;
  }

  // ---- шаг 2: отчёт «Статус комплектации» — схема включена по умолчанию (schemeFilterDefault) ----
  await openScreen(b, "report-completion", `document.querySelector('#rd-use-filter')`);
  await sleep(500);
  const cbState = await b.eval(`(()=>{const c=document.getElementById('rd-use-filter'); return c ? { checked: c.checked, disabled: c.disabled, note: document.getElementById('rd-filter-note')?.textContent } : null;})()`);
  check("«Статус комплектации»: галочка «Учитывать текущий фильтр схемы» включена по умолчанию и доступна", !!cbState && cbState.checked && !cbState.disabled, JSON.stringify(cbState));
  check("рядом с галочкой видно, чей это отбор (текст с «Модель» и временем)", !!cbState?.note && /Модель/.test(cbState.note), cbState?.note);
  const rowsFiltered = await b.eval(`document.querySelector('#rd-report')?.textContent.match(/Позиций: (\\d+)/)?.[1] || null`);
  console.log("строк с фильтром:", rowsFiltered, "снимок:", global.__snapCount, "из", global.__snapTotal);

  // снимаем галочку — строк должно стать БОЛЬШЕ (весь объект); отчёт на 9580 строк дольше считается и рисуется —
  // ждём, что панель точно перерисовалась (счётчик загрузки ушёл), а не фиксированную паузу.
  const readCount = async () => { await b.waitFor(`!(document.querySelector('#rd-body')?.textContent||'').includes('Загрузка…')`, 20000); await sleep(250); return b.eval(`document.querySelector('#rd-report')?.textContent.match(/Позиций: ([\\d\\s]+)/)?.[1]?.replace(/\\s/g,'') || null`); };
  await b.eval(`document.getElementById('rd-use-filter').click()`);
  const rowsAll = await readCount();
  check("без галочки строк БОЛЬШЕ (отчёт по всему объекту)", Number(rowsAll) > Number(rowsFiltered), `с фильтром ${rowsFiltered}, без ${rowsAll}`);

  // снова включаем — тот же (уменьшенный) результат
  await b.eval(`document.getElementById('rd-use-filter').click()`);
  const rowsFiltered2 = await readCount();
  check("повторное включение возвращает тот же суженный результат", rowsFiltered2 === rowsFiltered, `было ${rowsFiltered}, стало ${rowsFiltered2}`);

  // ---- шаг 3: выгрузка XLSX тоже учитывает отбор (тот же reportBody, что у экрана) ----
  const dlBefore = b.requests.length;
  await b.eval(`document.querySelector('[data-export="xlsx"]')?.click()`);
  await sleep(600);
  const dlReq = b.requests.slice(dlBefore).find((r) => /\/reports\/completion\.xlsx/.test(r.url));
  let dlHasIds = false;
  try { dlHasIds = Array.isArray(JSON.parse(dlReq?.body || "{}").element_ids); } catch { /* */ }
  check("выгрузка XLSX уходит с тем же element_ids, что и экран", dlHasIds, JSON.stringify(dlReq?.body?.slice(0, 200)));

  // ---- шаг 4: «Статус монтажа» — галочка ЕСТЬ, но по умолчанию ВЫКЛЮЧЕНА (без schemeFilterDefault) ----
  await openScreen(b, "report-status", `document.querySelector('#rd-use-filter')`);
  await sleep(400);
  const stState = await b.eval(`(()=>{const c=document.getElementById('rd-use-filter'); return c ? {checked:c.checked, disabled:c.disabled} : null;})()`);
  check("«Статус монтажа»: галочка есть, но по умолчанию не включена", !!stState && !stState.checked && !stState.disabled, JSON.stringify(stState));

  // ---- шаг 5: отчёты БЕЗ фильтра схемы (аналитическая справка) — галочки нет вовсе ----
  await openScreen(b, "report-analytics", `document.querySelector('.v2-tiles')`);
  await sleep(400);
  check("«Аналитическая справка»: галочки фильтра схемы нет (как в V1 — noFilter)", !(await b.eval(`!!document.getElementById('rd-use-filter')`)));

  // ---- шаг 6: снимок ЧУЖОГО объекта не применяется ----
  await openScreen(b, "report-completion", `document.querySelector('#rd-use-filter')`);
  await sleep(400);
  await setObject(b, 2);
  await sleep(600);
  const mismatch = await b.eval(`(()=>{const c=document.getElementById('rd-use-filter'); return c ? { checked: c.checked, disabled: c.disabled, note: document.getElementById('rd-filter-note')?.textContent } : null;})()`);
  check("снимок для объекта 1 не применяется к объекту 2: галочка снята и недоступна", !!mismatch && !mismatch.checked && mismatch.disabled, JSON.stringify(mismatch));
  check("рядом написано, что отбор относится к другому объекту", /друго/i.test(mismatch?.note || ""), mismatch?.note);
  // на СЕРВЕР при этом не улетел element_ids объекта 1 (нет утечки между объектами)
  const reqBefore3 = b.requests.length;
  await b.eval(`document.getElementById('rd-refresh')?.click()`);
  await sleep(500);
  const lastReportReq = b.requests.slice(reqBefore3).find((r) => /\/reports\/completion$/.test(r.url));
  let leaked = false;
  try { leaked = !!JSON.parse(lastReportReq?.body || "{}").element_ids; } catch { /* */ }
  check("нет утечки element_ids чужого объекта в запрос", !leaked, JSON.stringify(lastReportReq?.body));

  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
  await b.shot(`${SP}/charts_filter_shots/filter.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);

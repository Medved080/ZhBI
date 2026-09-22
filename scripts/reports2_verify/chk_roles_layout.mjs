// Ограниченная роль и раскладка: user4 (роль «просмотр» на проекте 1) в «Статусе комплектации» (сводная) и «Графике
// контрактации и поставки» (с фильтром схемы) — отчёты читаются, лишних действий на экране нет, сервер отвечает 403 на
// объект вне доступа. Раскладка обоих экранов на 1920×1080 и 1366×768: страница целиком не прокручивается, таблица —
// в своей области прокрутки. Настоящий backend (копия обезличенной БД), настоящий вход формой V2, настоящие щелчки.
// Запуск: node scripts/reports2_verify/chk_roles_layout.mjs
import { startServer, stopServer, check, summary, sleep, SP, chooseByLabel, clickEl, responseJson, waitReq, v2ExcludeFirstStatus } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8345;
const S = await startServer(PORT, `${SP}/r2_roles`);
const SHOTS = `${SP}/r2_roles_shots`;
const body = (r) => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };
// кнопки и поля рабочей области экрана (без шапки приложения и левой навигации)
const actions = (b) => b.eval(`[...document.querySelectorAll('.v2-screen button, .v2-screen a.v2-btn, .v2-screen input[type=checkbox]')].filter(x=>x.offsetParent).map(x=>x.tagName==='INPUT' ? (x.closest('label')?.textContent.trim()||x.dataset.groupToggle||'checkbox') : x.textContent.trim())`);
const metrics = (b) => b.eval(`(()=>{const d=document.scrollingElement; const w=document.querySelector('#rd-report .v2-ds-wrap'); const r=w?.getBoundingClientRect(); return {sh:d.scrollHeight, ih:innerHeight, sw:d.scrollWidth, iw:innerWidth, wrap: w ? {top: Math.round(r.top), h: Math.round(r.height), scrollH: w.scrollHeight, ownScroll: w.scrollHeight > w.clientHeight} : null};})()`);
const noScroll = (m) => m.sh <= m.ih + 2 && m.sw <= m.iw + 2;

let b;
try {
  b = await session({ base: S.base, user: "user4", objectId: 1, shots: SHOTS });
  // ---- «Статус комплектации», сводная, под user4 ----
  await openScreen(b, "report-completion", `/Позиций/.test(document.querySelector('#rd-report')?.textContent||'')`);
  let from = b.requests.length;
  await chooseByLabel(b, "Вид", "С");
  let req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  check("user4: сводная строится (чтение разрешено) — 200", req.status === 200);
  const allowed = new Set(["Обновить", "Открыть в текущем интерфейсе →", "Печать", "Выгрузить в XLSX", "Выгрузить в PDF", "Справка", "◀", "▶", "Учитывать текущий фильтр схемы", "Завод", "Договор", "Спецификация", "Тип", "Подтип", "Марка", "Статус", "Кран", "Стоянка"]);
  let acts = await actions(b);
  const treeToggles = await b.eval(`document.querySelectorAll('#rd-report .v2-tree-toggle').length`);
  const extra = acts.filter((a) => !allowed.has(a) && !/^[▸▾]$/.test(a) && a !== "");
  check("user4, сводная: на экране только чтение/выгрузка/печать/справка/настройки вида — лишних действий нет", extra.length === 0, extra.length ? `лишнее: ${extra.join(" | ")}` : `действий ${acts.length} (+${treeToggles} кнопок свёртки)`);
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-export="xlsx"]')`);
  req = await waitReq(b, /\/reports\/completion\.xlsx$/, from);
  check("user4: выгрузка XLSX сводной — 200 (право чтения отчёта)", req.status === 200 && body(req).view === "pivot");
  const deny = await b.eval(`(async()=>{const r=await fetch('/reports/completion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:3,view:'pivot'})}); const r2=await fetch('/reports/contracting-schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:3})}); return [r.status, r2.status];})()`);
  check("user4: объект вне доступа (проект 2) — сервер отвечает 403 обоим отчётам", deny[0] === 403 && deny[1] === 403, JSON.stringify(deny));

  // ---- «График контрактации» с фильтром схемы под user4 ----
  const { snap } = await v2ExcludeFirstStatus(b, openScreen);
  await openScreen(b, "report-contracting", `!!document.querySelector('#rd-report table.v2-cs-tbl')`);
  from = b.requests.length;
  await clickEl(b, `document.getElementById('rd-use-filter')`);
  req = await waitReq(b, /\/reports\/contracting-schedule$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cs-tbl') && document.getElementById('rd-use-filter').checked`, 30000);
  const d = await responseJson(b, req);
  check("user4: «График контрактации» с отбором — 200, сужен (element_filter)", req.status === 200 && d.element_filter?.elements > 0 && (body(req).element_ids || []).length === snap.elementIds.length, JSON.stringify(d.element_filter));
  acts = await actions(b);
  const allowedCs = new Set(["Обновить", "Открыть в текущем интерфейсе →", "Печать", "Справка", "Учитывать текущий фильтр схемы", "Только марки с дефицитом", "Показать ещё"]);
  const extraCs = acts.filter((a) => !allowedCs.has(a) && !/^[▸▾]/.test(a));
  check("user4, «График контрактации»: лишних действий нет", extraCs.length === 0, extraCs.length ? `лишнее: ${extraCs.slice(0, 5).join(" | ")}` : `действий ${acts.length}`);

  // ---- раскладка ----
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await b.viewport(w, h);
    await sleep(400);
    let m = await metrics(b);
    check(`${w}×${h} «График контрактации» (с отбором): страница не прокручивается целиком, таблица — в своей области`, noScroll(m) && m.wrap?.ownScroll, JSON.stringify(m));
    await b.shot(`${SHOTS}/contracting-${w}.png`);
    await openScreen(b, "report-completion", `!!document.querySelector('#rd-report table.v2-cmp-pivot')`);
    await sleep(400);
    m = await metrics(b);
    check(`${w}×${h} «Статус комплектации», сводная: страница не прокручивается целиком, таблица — в своей области`, noScroll(m) && m.wrap?.ownScroll, JSON.stringify(m));
    await b.shot(`${SHOTS}/pivot-${w}.png`);
    await openScreen(b, "report-contracting", `!!document.querySelector('#rd-report table.v2-cs-tbl')`);
  }
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);

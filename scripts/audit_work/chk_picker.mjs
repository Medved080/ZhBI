// Аудит «рабочие места и отчёты»: АРМ комплектовщика V2 — пробелы против V1, закрытые в этой ветке: вкладка «Статус» (сводка по срезу),
// «сбросить» у каждого блока среза, контракты среза сверху с чертой «нет в текущем срезе», групповые операции после выбора рамкой
// (настоящее Shift+перетаскивание на схеме) и «Распределение по марке» в смене статуса по строкам; неполная роль. Настоящий backend на
// копии БД, настоящий вход формой V2, настоящие события мыши. Запуск: node scripts/audit_work/chk_picker.mjs (порт 8376)
import { startServer, stopServer, check, summary, sleep, SP, session, openScreen, tap, choose, exec, sql, sql1, writes } from "./lib.mjs";

const PORT = 8376;
const S = await startServer(PORT, `${SP}/aw_picker`, {
  setup(db) {
    // неполная роль в КОПИИ: «просмотр» видит АРМ комплектовщика, но без права статусов и плановых дат
    exec(db, `INSERT OR REPLACE INTO role_features (role_key, feature_key, level) VALUES ('view', 'workspace_picker', 'read'); DELETE FROM role_features WHERE role_key='view' AND feature_key IN ('status','planned_date');`);
  },
});
const F = `document.querySelector('iframe.ws-frame')`;
const panel = (b) => b.eval(`document.querySelector('#ws-panel-body')?.innerText || ''`);
const tab = async (b, k) => { await tap(b, `.ws-tabs button[data-tab="${k}"]`); await sleep(500); };
// настоящий щелчок по кнопке верхнего (последнего открытого) окна
async function clickTop(b, sel) {
  const r = await b.eval(`(()=>{const d=[...document.querySelectorAll('.eo-dialog')].at(-1); const x=d?.querySelector(${JSON.stringify(sel)}); if(!x) return null; x.scrollIntoView({block:'center'}); const q=x.getBoundingClientRect(); return {x:q.x+q.width/2,y:q.y+q.height/2}; })()`);
  if (!r) throw new Error("нет элемента в окне: " + sel);
  await sleep(150); await b.click(r.x, r.y);
}
let b;
try {
  b = await session(S.base, "admin", { objectId: 1 });
  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs')`);
  await b.waitFor(`/В срезе: [1-9]/.test(document.querySelector('#ws-panel-body')?.innerText || '') && !!document.querySelector('input[data-pk="elementType"]')`, 120000);
  await sleep(1500);
  const tabs = await b.eval(`[...document.querySelectorAll('.ws-tabs button')].map(x=>x.textContent)`);
  check("вкладки АРМ: есть «Статус» (как правая панель V1)", tabs.includes("Статус"), tabs.join(","));
  const base0 = Number(((await panel(b)).match(/В срезе: ([\d\s ]+) из/) || [])[1]?.replace(/\D/g, ""));
  // Отчёты V1/V2 строятся по основному актуальному чертежу объекта; схема
  // дополнительно показывает панели шахт из второго файла (9580 против 9422).
  const primary = sql1(S.db, `SELECT source_file FROM object_drawings WHERE object_id=1 AND is_current=1 AND source_file NOT IN (SELECT DISTINCT e.source_file FROM elements e JOIN shaft_panel_geometry g ON g.element_id=e.id WHERE g.object_id=1) ORDER BY imported_at ASC LIMIT 1`);
  const primarySql = String(primary).replace(/'/g, "''");
  const reportTotal = sql1(S.db, `SELECT COUNT(*) FROM elements WHERE object_id=1 AND is_current=1 AND source_file='${primarySql}'`);
  await tab(b, "status");
  await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .v2-read-tbl')`, 60000);
  const st0 = Number(((await panel(b)).match(/Всего изделий: ([\d\s ]+)/) || [])[1]?.replace(/\D/g, ""));
  check("«Статус»: итог мини-отчёта = SQL основного чертежа, разница со схемой пояснена",
    st0 === reportTotal && (base0 === st0 || (await panel(b)).includes(`Отчёты учитывают ${st0.toLocaleString("ru-RU")} изделий актуального чертежа`)),
    `${st0} / SQL ${reportTotal} / на схеме ${base0}`);

  // «сбросить» у блока среза — настоящим щелчком по флажку значения и по ссылке
  await tab(b, "pick");
  const firstType = await b.eval(`document.querySelector('input[data-pk="elementType"]')?.closest('label')?.querySelector('span')?.textContent`);
  await tap(b, 'input[data-pk="elementType"]');
  await b.waitFor(`!!document.querySelector('[data-pk-clear="elementType"]')`, 20000);
  const typeN = sql1(S.db, `SELECT COUNT(*) FROM elements WHERE object_id=1 AND is_current=1 AND element_type=${JSON.stringify(firstType).replace(/"/g, "'")}`);
  const base1 = Number(((await panel(b)).match(/В срезе: ([\d\s ]+) из/) || [])[1]?.replace(/\D/g, ""));
  check(`отбор «Тип = ${firstType}»: в срезе = SQL, у блока появилась ссылка «сбросить (1)»`, base1 === typeN && /сбросить \(1\)/.test(await b.eval(`document.querySelector('[data-pk-clear="elementType"]').textContent`)), `${base1} / SQL ${typeN}`);
  await tab(b, "status");
  await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .v2-read-tbl')`, 60000);
  const st1 = Number(((await panel(b)).match(/Всего изделий: ([\d\s ]+)/) || [])[1]?.replace(/\D/g, ""));
  const stSql = sql1(S.db, `SELECT COUNT(*) FROM elements WHERE object_id=1 AND is_current=1 AND source_file='${primarySql}' AND element_type=${JSON.stringify(firstType).replace(/"/g, "'")}`);
  check("«Статус» следует за срезом (сумма = изделиям типа по SQL)", st1 === stSql, `${st1} / ${stSql}`);
  // контракты: сначала контрагенты среза, черта, затем остальные (приглушённые)
  await tab(b, "contracts");
  const order = await b.eval(`(()=>{const out=[]; for (const n of document.querySelectorAll('#ws-panel-body .ws-fbody > *')) { if (n.classList.contains('ws-sep')) out.push('SEP'); else if (n.classList.contains('ws-cgroup')) out.push(n.classList.contains('ws-dim') ? 'out' : 'in'); } return out.join(','); })()`);
  const okOrder = /^(in,)*in(,SEP(,out)+)?(,in)?$/.test(order.replace(/,in$/, "")) || /^(in,)+SEP,(out,?)+/.test(order);
  check("контракты: контрагенты среза сверху, черта «нет в текущем срезе», ниже — остальные", okOrder && (!order.includes("out") || order.includes("SEP")), order.slice(0, 200));
  await tab(b, "pick");
  await tap(b, '[data-pk-clear="elementType"]');
  await b.waitFor(`!document.querySelector('[data-pk-clear="elementType"]')`, 20000);
  const base2 = Number(((await panel(b)).match(/В срезе: ([\d\s ]+) из/) || [])[1]?.replace(/\D/g, ""));
  check("«сбросить» у блока снимает только его выбор (срез снова полный)", base2 === base0, `${base2} / ${base0}`);

  // выбор рамкой (настоящее Shift+перетаскивание по схеме) → групповые операции во вкладке «Свойства»
  await tab(b, "props");
  const fr = await b.eval(`(()=>{const r=${F}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  await b.drag(fr.x + fr.w * 0.30, fr.y + fr.h * 0.45, fr.x + fr.w * 0.40, fr.y + fr.h * 0.55, { shift: true }); await sleep(1500);
  const grp = await panel(b);
  const nSel = Number((grp.match(/Выбрано элементов: (\d+)/) || [])[1] || 0);
  check("рамка на схеме АРМ выбирает группу (Shift+перетаскивание)", nSel > 1, `выбрано ${nSel}`);
  check("групповые операции в АРМ доступны (как панель группового выделения V1), подсказка про Ctrl — верная для АРМ", (await b.eval(`!!document.querySelector('#ws-panel-body [data-eo="rows-status"]')`)) && /убрать из выбранного рамкой/.test(grp), grp.slice(0, 200));
  const ids = await b.eval(`[...${F}.contentDocument.querySelectorAll('.element-shape.multi-selected')].map(s=>Number(s.dataset.id))`);
  check("подсветка выбранных на схеме = числу в панели", ids.length === nSel, `${ids.length}/${nSel}`);

  // смена статуса по строкам с «Распределением по марке»
  await tap(b, '#ws-panel-body [data-eo="rows-status"]');
  await b.waitFor(`document.querySelector('.eo-dialog #eor-status')`, 15000);
  const statuses = sql(S.db, `SELECT id, current_status, contract_id, mark, element_type FROM elements WHERE id IN (${ids.join(",")})`);
  const target = statuses.some((r) => r.current_status === "planned") ? "contracting" : "in_production";
  await choose(b, ".eo-dialog #eor-status", target);
  await b.waitFor(`document.querySelector('.eo-dialog .eo-bymark') || document.querySelector('.eo-dialog tbody')`, 10000);
  const rowsN = await b.eval(`document.querySelectorAll('.eo-dialog tbody tr').length`);
  const changing = statuses.filter((r) => r.current_status !== target);
  const initialCount = (await b.eval(`document.querySelector('.eo-dialog')?.innerText || ''`)).match(/Изменится:\s*([\d\s]+)\s+из\s*([\d\s]+)/);
  const initialChanging = Number(initialCount?.[1]?.replace(/\D/g, ""));
  check("по строкам: видны все выбранные; к изменению сначала только изделия с другим статусом (SQL)",
    rowsN === statuses.length && initialChanging === changing.length, `${rowsN} строк / ${statuses.length} выбрано / ${initialChanging} изменится / ${changing.length} SQL`);
  // распределить по марке: у каждой позиции — сначала первый доступный контракт, если его нет — «без контракта»
  let guard = 0;
  while ((await b.eval(`!!document.querySelector('.eo-dialog [data-eor-m]:not([disabled])')`)) && guard++ < 40) {
    await tap(b, ".eo-dialog [data-eor-m]:not([disabled])");
    await b.waitFor(`document.querySelectorAll('.eo-dialog').length === 2`, 15000);
    const pick = await b.eval(`(()=>{const d=[...document.querySelectorAll('.eo-dialog')].at(-1); const x=d.querySelector('.eo-crow[data-c]:not([disabled]):not([data-c="none"])'); return x ? x.dataset.c : 'none'; })()`);
    await clickTop(b, `.eo-crow[data-c="${pick}"]`);
    await b.waitFor(`document.querySelectorAll('.eo-dialog').length === 1`, 10000);
    await sleep(600);
    // позиция без остатка: «Распределено X из Y» — остальным «без контракта»
    if (await b.eval(`!!document.querySelector('.eo-dialog [data-eor-m]:not([disabled])') && /из \\d+ — по позиции/.test(document.querySelector('.eo-dialog .eo-bymark [role=status]')?.textContent || '')`)) {
      await tap(b, ".eo-dialog [data-eor-m]:not([disabled])");
      await b.waitFor(`document.querySelectorAll('.eo-dialog').length === 2`, 15000);
      await clickTop(b, '.eo-crow[data-c="none"]');
      await b.waitFor(`document.querySelectorAll('.eo-dialog').length === 1`, 10000); await sleep(400);
    }
  }
  const note = await b.eval(`document.querySelector('.eo-dialog .eo-bymark [role=status]')?.textContent || ''`);
  check("«Распределение по марке»: у всех строк контракт выбран (кнопки «Распределить…» погасли)", !(await b.eval(`!!document.querySelector('.eo-dialog [data-eor-m]:not([disabled])')`)) && /Распределено/.test(note), note);
  const plan = await b.eval(`[...document.querySelectorAll('.eo-dialog tbody tr')].map(tr=>tr.querySelector('[data-eor-c]')?.textContent.trim())`);
  n0: {
    const n = b.requests.length;
    await tap(b, '.eo-dialog [data-eor="preview"]');
    await b.waitFor(`document.querySelector('.eo-dialog [data-eor="apply"]') || document.querySelector('.eo-dialog .ws-err')`, 30000);
    await tap(b, '.eo-dialog [data-eor="apply"]');
    try { await b.waitFor(`document.querySelector('.v2-dialog [data-choice="confirm"]')`, 3000); await tap(b, '.v2-dialog [data-choice="confirm"]'); } catch { /* */ }
    await b.waitFor(`!document.querySelector('.eo-dialog')`, 30000);
    await sleep(1500);
    const after = sql(S.db, `SELECT id, current_status FROM elements WHERE id IN (${changing.map((r) => r.id).join(",") || 0})`);
    check("применение: SQL — у всех строк новый статус", after.length === changing.length && after.every((r) => r.current_status === target), JSON.stringify(after.slice(0, 5)));
    const w = writes(b, n).filter((r) => !/\/plan-data$/.test(r.url)).map((r) => new URL(r.url).pathname);
    check("применение: запросы — предпросмотр и одна запись", w.length >= 2 && w.every((p) => /element-rows|element-ops/.test(p)), w.join(","));
  }
  check("исключений JavaScript нет (admin)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close(); b = null;

  // неполная роль: АРМ открыт, групповые изменения недоступны, сервер отказывает; 1366×768 без прокрутки страницы
  b = await session(S.base, "user4", { objectId: 1, width: 1366, height: 768 });
  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs')`);
  await b.waitFor(`/В срезе: [1-9]/.test(document.querySelector('#ws-panel-body')?.innerText || '')`, 120000);
  await sleep(1500);
  const lay = await b.eval(`({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight })`);
  check("user4 1366×768: АРМ без прокрутки страницы", lay.w <= lay.iw + 1 && lay.h <= lay.ih + 1, JSON.stringify(lay));
  await tab(b, "props");
  const fr2 = await b.eval(`(()=>{const r=${F}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  await b.drag(fr2.x + fr2.w * 0.30, fr2.y + fr2.h * 0.45, fr2.x + fr2.w * 0.40, fr2.y + fr2.h * 0.55, { shift: true }); await sleep(1500);
  const ro = await panel(b);
  check("user4 (без статусов и плановых дат): групповые изменения недоступны, объяснение показано", /Групповые изменения недоступны/.test(ro) && !(await b.eval(`!!document.querySelector('#ws-panel-body [data-eo="rows-status"]')`)), ro.slice(0, 200));
  const st403 = await b.eval(`fetch('/element-ops/status-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'preview',object_id:1,status:'installed',items:[{element_id:${ids[0] || 1},expected_status:'planned',expected_contract_id:null}]})}).then(r=>r.status)`);
  check("user4: групповая смена статуса отклонена сервером (403)", st403 === 403, String(st403));
  check("исключений JavaScript нет (user4)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("АРМ комплектовщика V2") ? 1 : 0);

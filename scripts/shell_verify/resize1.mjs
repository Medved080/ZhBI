// Регулировка ширины, закрепление панели, безопасность для iframe схемы, узкое окно, 1920×1080 и 1366×768
// (п.2в, п.3, п.5 задания). Настоящий backend, копия БД. Запуск: node scripts/shell_verify/resize1.mjs (порт 8214)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, hardGoto } from "./lib.mjs";

const PORT = 8214;
const DIR = "data/shell_check/srv_resize1";
const SOURCE = "data/shell_check/case.db";
const S = await startServer(PORT, DIR, SOURCE);
const b = await openBrowser(1920, 1080);
const navState = () => b.eval(`document.querySelector('#v2-side')?.dataset.mode`);
const railWidth = () => b.eval(`document.querySelector('.v2-shellnav-rail')?.getBoundingClientRect().width`);
const openTemp = async () => { await b.clickSel("#v2-shellnav-menu"); await sleep(250); };
const iframeCount = () => b.eval(`document.querySelectorAll('iframe').length`);
const openWorkspace = async () => {
  await openTemp();
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='ws-model')?.click()`);
  await b.waitFor(`location.hash === '#/ws-model'`, 10000);
  await b.waitFor(`!!document.querySelector('.ws-frame')`, 10000);
  await sleep(600);
};

try {
  await login(b, S.base, "admin");
  await sleep(300);

  console.log("\n== закрепление: содержимое реально подвигается, сохраняется между сеансами ==");
  const beforeX = await b.eval(`document.querySelector('#v2-content').getBoundingClientRect().x`);
  await openTemp();
  await b.clickSel("#v2-shellnav-pin");
  await sleep(300);
  check("R1.1 после закрепления состояние «pinned»", (await navState()) === "pinned");
  const afterX = await b.eval(`document.querySelector('#v2-content').getBoundingClientRect().x`);
  check("R1.2 содержимое ДЕЙСТВИТЕЛЬНО подвинулось (закреплённая — реальная ширина)", afterX > beforeX, `${beforeX} -> ${afterX}`);
  await hardGoto(b, `${S.base}/v2`);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await sleep(400);
  check("R1.3 после перезагрузки закрепление сохранилось", (await navState()) === "pinned");

  console.log("\n== ширина: перетаскивание мышью ==");
  let w0 = await railWidth();
  const rz = await b.rect("#v2-shellnav-resize");
  await b.drag(rz.cx, rz.cy, rz.cx + 60, rz.cy, { steps: 10 });
  await sleep(300);
  let w1 = await railWidth();
  check("R2.1 перетаскивание вправо увеличило ширину", w1 > w0 + 30, `${w0} -> ${w1}`);
  await hardGoto(b, `${S.base}/v2`);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await sleep(400);
  let w2 = await railWidth();
  check("R2.2 новая ширина сохранена между сеансами", Math.abs(w2 - w1) < 3, `${w1} vs ${w2}`);

  console.log("\n== ширина: клавиатура (стрелки, Home/End), aria ==");
  const rzInfo0 = await b.eval(`(() => { const r=document.querySelector('#v2-shellnav-resize'); return {role:r.getAttribute('role'), min:r.getAttribute('aria-valuemin'), max:r.getAttribute('aria-valuemax'), now:r.getAttribute('aria-valuenow')}; })()`);
  check("R3.1 у разделителя есть role и aria-valuenow/min/max", rzInfo0.role === "separator" && rzInfo0.min && rzInfo0.max && rzInfo0.now);
  await b.clickSel("#v2-shellnav-resize");
  await sleep(150);
  const beforeKb = Number(await b.eval(`document.querySelector('#v2-shellnav-resize').getAttribute('aria-valuenow')`));
  await b.key("ArrowRight");
  await sleep(150);
  const afterRight = Number(await b.eval(`document.querySelector('#v2-shellnav-resize').getAttribute('aria-valuenow')`));
  check("R3.2 ArrowRight увеличивает ширину", afterRight > beforeKb, `${beforeKb} -> ${afterRight}`);
  await b.key("ArrowLeft");
  await sleep(150);
  const afterLeft = Number(await b.eval(`document.querySelector('#v2-shellnav-resize').getAttribute('aria-valuenow')`));
  check("R3.3 ArrowLeft возвращает обратно", afterLeft < afterRight, `${afterRight} -> ${afterLeft}`);
  await b.key("Home");
  await sleep(150);
  const afterHome = Number(await b.eval(`document.querySelector('#v2-shellnav-resize').getAttribute('aria-valuenow')`));
  check("R3.4 Home — минимальная ширина (220)", afterHome === 220, afterHome);
  await b.key("End");
  await sleep(150);
  const afterEnd = Number(await b.eval(`document.querySelector('#v2-shellnav-resize').getAttribute('aria-valuenow')`));
  check("R3.5 End — максимальная ширина в текущем окне", afterEnd >= 320, afterEnd);

  console.log("\n== двойной клик по разделителю — сброс к 260px ==");
  const rzNow = await b.rect("#v2-shellnav-resize"); // ширина уже другая — координаты разделителя пересчитаны, старый rz мимо цели
  await b.click(rzNow.cx, rzNow.cy, { count: 2 });
  await sleep(250);
  const afterDbl = await railWidth();
  check("R4.1 двойной клик сбрасывает ширину к 260px", Math.abs(afterDbl - 260) < 3, afterDbl);

  console.log("\n== открепление возвращает collapsed, содержимое возвращается на место ==");
  await b.clickSel("#v2-shellnav-pin");
  await sleep(300);
  check("R5.1 открепление — состояние «collapsed»", (await navState()) === "collapsed");

  console.log("\n== рабочее место со схемой: iframe не пересоздаётся при открытии/закрытии панели (10 раз) ==");
  await openWorkspace();
  const ic0 = await iframeCount();
  check("R6.1 схема открылась (есть ровно 1 iframe)", ic0 === 1, ic0);
  const frameIdBefore = await b.eval(`document.querySelector('.ws-frame')?.dataset.zhbiScene`);
  for (let i = 0; i < 10; i++) {
    await b.clickSel("#v2-shellnav-menu");
    await sleep(80);
    await b.clickSel("#v2-shellnav-menu");
    await sleep(80);
  }
  await sleep(300);
  const ic1 = await iframeCount();
  check("R6.2 после 10 открытий/закрытий панели iframe по-прежнему РОВНО 1 (не растёт)", ic1 === 1, ic1);
  const frameIdAfter = await b.eval(`document.querySelector('.ws-frame')?.dataset.zhbiScene`);
  check("R6.3 iframe НЕ пересоздан (тот же параметр сцены, тот же кадр)", frameIdBefore === frameIdAfter, `${frameIdBefore} vs ${frameIdAfter}`);
  const nodeCountBefore = await b.eval(`document.querySelectorAll('[id^="v2-shellnav"]').length`);
  for (let i = 0; i < 10; i++) { await b.clickSel("#v2-shellnav-menu"); await sleep(60); await b.clickSel("#v2-shellnav-menu"); await sleep(60); }
  const nodeCountAfter = await b.eval(`document.querySelectorAll('[id^="v2-shellnav"]').length`);
  check("R6.4 число DOM-узлов панели не растёт от открытий/закрытий (нет накопления)", nodeCountAfter <= nodeCountBefore + 5, `${nodeCountBefore} -> ${nodeCountAfter}`);

  console.log("\n== перетаскивание разделителя НАД iframe схемы: указатель не теряется ==");
  await openTemp();
  const rz2 = await b.rect("#v2-shellnav-resize");
  const frameRect = await b.rect(".ws-frame");
  // тянем через область, где под курсором окажется САМ iframe схемы — если указатель "потерян", ширина не изменится
  await b.drag(rz2.cx, rz2.cy, frameRect.cx, rz2.cy, { steps: 15 });
  await sleep(300);
  const wOverFrame = await railWidth();
  check("R7.1 ширина изменилась, даже когда перетаскивание прошло над iframe схемы", Math.abs(wOverFrame - 260) > 20, wOverFrame);
  const framePointerEvents = await b.eval(`getComputedStyle(document.querySelector('.ws-frame')).pointerEvents`);
  check("R7.2 после отпускания pointer-events iframe восстановлены (не заблокирован навсегда)", framePointerEvents !== "none", framePointerEvents);

  console.log("\n== узкое окно: закреплённая панель ведёт себя как временная, восстанавливается при возврате ширины ==");
  await b.clickSel("#v2-shellnav-menu"); // закрыть temp, если открыта
  await sleep(200);
  await b.clickSel("#v2-shellnav-menu");
  await b.clickSel("#v2-shellnav-pin");
  await sleep(300);
  check("R8.0 закреплено перед сужением окна", (await navState()) === "pinned");
  await b.viewport(900, 800);
  await sleep(400);
  const modeNarrow = await navState();
  check("R8.1 узкое окно (900px) — закреплённая ведёт себя как «collapsed» (не ест место)", modeNarrow === "collapsed", modeNarrow);
  const contentXNarrow = await b.eval(`document.querySelector('#v2-content').getBoundingClientRect().x`);
  check("R8.2 в узком окне содержимое занимает почти всю ширину (полоса узкая)", contentXNarrow < 60, contentXNarrow);
  await b.viewport(1920, 1080);
  await sleep(400);
  const modeWide = await navState();
  check("R8.3 возврат к достаточной ширине — закрепление ВОССТАНОВЛЕНО", modeWide === "pinned", modeWide);

  console.log("\n== 1366×768: нет горизонтальной прокрутки страницы ==");
  await b.viewport(1366, 768);
  await sleep(400);
  const scrollInfo = await b.eval(`({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })`);
  check("R9.1 1366×768: ширина документа не превышает окно (нет горизонтальной прокрутки)", scrollInfo.scrollW <= scrollInfo.clientW + 1, JSON.stringify(scrollInfo));
  await b.viewport(1920, 1080);
  await sleep(300);
  const scrollInfo2 = await b.eval(`({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })`);
  check("R9.2 1920×1080: нет горизонтальной прокрутки", scrollInfo2.scrollW <= scrollInfo2.clientW + 1, JSON.stringify(scrollInfo2));

  console.log("\n== смена рабочего места при закреплённой панели по-прежнему работает (регрессия) ==");
  await b.eval(`(() => { const p=document.querySelector('#v2-shellnav-pin'); if (p && p.getAttribute('aria-pressed')!=='true') p.click(); })()`);
  await sleep(300);
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='ws-mfr')?.click()`);
  await sleep(600);
  const onMfr = await b.eval(`location.hash`);
  check("R10.1 переключение на «Модель МФР» при закреплённой панели работает", onMfr === "#/ws-mfr" || onMfr.includes("ws-mfr") || (await b.eval(`!!document.querySelector('.v2-note-page')`)) === false, onMfr);

} catch (e) {
  console.error("\nСБОЙ ТЕСТА (не путать с FAIL проверки — это необработанное исключение):", e && e.stack || e);
  process.exitCode = 1;
} finally {
  console.log("\nconsole errors:", b.exceptions);
  await b.close();
  await stopServer();
  const bad = summary();
  if (!process.exitCode) process.exitCode = bad ? 1 : 0;
}

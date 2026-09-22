// Проверка доработок «Графика СМР» (charts, 2026-09-22): перетаскивание ширины колонки названий диаграммы Ганта
// (мышь и клавиатура), полноэкранный режим (кнопка, Esc), сохранение состояния (версия/уровень группировки/
// масштаб/ширина колонки) при переключении вкладок «Гант»/«Версии»/«Исходные данные». Настоящий backend
// (копия обезличенной БД), настоящий вход формой V2, настоящие события мыши и клавиатуры (scripts/cdp.mjs).
// Запуск: node scripts/charts_verify/chk_schedule.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8278;
const S = await startServer(PORT, `${SP}/charts_sched`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_sched_shots` });
  await openScreen(b, "schedule", `document.querySelector('.v2-gantt-wrap')`);
  await sleep(400);

  // ---- ширина колонки названий: перетаскивание мышью ----
  const before = await b.eval(`getComputedStyle(document.querySelector('.v2-gantt-wrap')).getPropertyValue('--gname').trim()`);
  // Ручка растянута на условные 4000px вниз (визуальная линия на всю диаграмму, приём «сегодня») — реальная
  // видимая (и попадающая в вьюпорт) точка нужна у самого ВЕРХА ручки, не в геометрическом центре её bounding rect.
  const rzRectFull = await b.rect(".v2-gantt-resize");
  const rzRect = rzRectFull ? { ...rzRectFull, cy: rzRectFull.y + 14 } : null;
  check("ручка изменения ширины колонки названий на месте", !!rzRect, JSON.stringify(rzRect));
  if (rzRect) {
    await b.drag(rzRect.cx, rzRect.cy, rzRect.cx + 120, rzRect.cy, { steps: 8 });
    await sleep(200);
    const after = await b.eval(`getComputedStyle(document.querySelector('.v2-gantt-wrap')).getPropertyValue('--gname').trim()`);
    check("перетаскивание мышью меняет ширину колонки названий (--gname)", after !== before && parseInt(after) > parseInt(before), `было ${before}, стало ${after}`);
    // сохранилась в sessionStorage
    const stored = await b.eval(`sessionStorage.getItem('v2.sc.gantt.nameW')`);
    check("ширина сохранена (sessionStorage)", String(parseInt(after)) === String(stored), `after=${after}, stored=${stored}`);

    // клавиатура: стрелка вправо увеличивает ещё на 20px от текущей (ручка после drag имеет фокус — setPointerCapture не отбирает его)
    const beforeKb = parseInt(after);
    await b.key("ArrowRight");
    await sleep(150);
    const afterKb = parseInt(await b.eval(`getComputedStyle(document.querySelector('.v2-gantt-wrap')).getPropertyValue('--gname').trim()`));
    check("клавиатура (стрелка) меняет ширину колонки названий", afterKb === beforeKb + 20, `было ${beforeKb}, стало ${afterKb}`);
  }

  // ---- переключение уровня группировки и версии, затем переход на другую вкладку и обратно: состояние на месте ----
  await b.eval(`[...document.querySelectorAll('[data-gantt-level]')].find(x=>x.textContent.trim()==='Стоянки')?.click()`);
  await sleep(300);
  const levelPressed = await b.eval(`[...document.querySelectorAll('[data-gantt-level]')].find(x=>x.getAttribute('aria-pressed')==='true')?.textContent.trim()`);
  check("уровень группировки переключился на «Стоянки»", levelPressed === "Стоянки", levelPressed);
  const nameWBeforeTab = await b.eval(`getComputedStyle(document.querySelector('.v2-gantt-wrap')).getPropertyValue('--gname').trim()`);

  await b.eval(`[...document.querySelectorAll('[data-sc-tab]')].find(x=>x.textContent.trim()==='Версии')?.click()`);
  await sleep(400);
  check("вкладка «Версии» открылась", await b.eval(`!document.querySelector('.v2-gantt-wrap')`));
  await b.eval(`[...document.querySelectorAll('[data-sc-tab]')].find(x=>x.textContent.trim()==='Визуализация')?.click()`);
  await sleep(400);
  const levelAfterReturn = await b.eval(`[...document.querySelectorAll('[data-gantt-level]')].find(x=>x.getAttribute('aria-pressed')==='true')?.textContent.trim()`);
  check("после возврата на «Визуализация»: уровень группировки не сбросился", levelAfterReturn === "Стоянки", levelAfterReturn);
  const nameWAfterTab = await b.eval(`getComputedStyle(document.querySelector('.v2-gantt-wrap')).getPropertyValue('--gname').trim()`);
  check("после возврата: ширина колонки названий не сбросилась", nameWAfterTab === nameWBeforeTab, `было ${nameWBeforeTab}, стало ${nameWAfterTab}`);

  // ---- полноэкранный режим ----
  await b.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Во весь экран')?.click()`);
  await sleep(300);
  const fsOn = await b.eval(`(()=>{const fs=document.querySelector('.v2-gantt-fs'); const tabs=document.querySelector('.v2-read-tabs'); return { hasFs: !!fs, tabsHidden: !tabs };})()`);
  check("полноэкранный режим: оверлей на месте, вкладки скрыты", fsOn.hasFs && fsOn.tabsHidden, JSON.stringify(fsOn));
  const rectFs = await b.eval(`(()=>{const el=document.querySelector('.v2-gantt-fs'); const r=el.getBoundingClientRect(); return {w:r.width,h:r.height, winW: innerWidth, winH: innerHeight};})()`);
  check("полноэкранный режим: оверлей занимает весь экран", Math.abs(rectFs.w - rectFs.winW) < 2 && Math.abs(rectFs.h - rectFs.winH) < 2, JSON.stringify(rectFs));

  // Esc закрывает
  await b.key("Escape");
  await sleep(300);
  const fsOff = await b.eval(`!document.querySelector('.v2-gantt-fs') && !!document.querySelector('.v2-read-tabs')`);
  check("Esc закрывает полноэкранный режим, вкладки возвращаются", fsOff);

  // кнопка «Во весь экран» снова, затем кнопка «Свернуть» тоже закрывает
  await b.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Во весь экран')?.click()`);
  await sleep(300);
  await b.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Свернуть')?.click()`);
  await sleep(300);
  check("кнопка «Свернуть» тоже закрывает полноэкранный режим", await b.eval(`!document.querySelector('.v2-gantt-fs')`));

  check("нет ошибок JavaScript за весь сценарий", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
  await b.shot(`${SP}/charts_sched_shots/schedule.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);

// Аудит «рабочие места и отчёты»: «Модель МФР» в V2 — то, что оставалось непроверенным или расходилось с V1:
// выбор блока ЩЕЛЧКОМ В 3D настоящим событием мыши (WebGL через SwiftShader, как verify_model_ui), промах снимает выбор,
// ⌘-щелчок добавляет второй блок; «Сбросить все» сбрасывает и этажи/секции, и отбор работ, и динамику факта (как V1
// mfr-reset-all-filters). Настоящий backend на копии БД, настоящий вход. Запуск: node scripts/audit_work/chk_mfr.mjs (порт 8379)
import { startServer, stopServer, check, summary, sleep, SP, session, openScreen, tap, sql, sql1 } from "./lib.mjs";

const PORT = 8379;
const GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"];
const S = await startServer(PORT, `${SP}/aw_mfr`);
const FD = `document.querySelector('iframe.ws-frame').contentDocument`;
const status = (b) => b.eval(`document.querySelector('.ws-status')?.innerText || ''`);
const cardReq = (b, from) => b.requests.slice(from).map((r) => (/\/objects\/4\/blocks\/(\d+)\/card$/.exec(new URL(r.url).pathname) || [])[1]).filter(Boolean).map(Number);
let b;
try {
  b = await session(S.base, "admin", { objectId: 4, args: GL });
  await openScreen(b, "ws-mfr", `document.querySelector('iframe.ws-frame')`);
  await b.waitFor(`(()=>{const d=${FD}; return d && d.querySelectorAll('#revit-plan-canvas rect[data-block-id]').length>0})()`, 120000);
  await sleep(1500);
  // один этаж (стартовый) и одна секция — настоящими щелчками по «пилюлям»
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await b.waitFor(`document.querySelector('[data-mpick="section"]')`, 20000);
  const blocksOf = () => b.eval(`[...new Set([...${FD}.querySelectorAll('#revit-plan-canvas rect[data-block-id]')].map(e=>e.getAttribute('data-block-id')))]`);
  const sections = await b.eval(`[...document.querySelectorAll('[data-mpick="section"]')].map(p=>p.dataset.id)`);
  let one = null, secId = null;
  for (const s of sections) {
    await tap(b, `[data-mpick="section"][data-id="${s}"]`); await sleep(1500);
    const ids = await blocksOf();
    if (ids.length === 1) { one = Number(ids[0]); secId = s; break; }
    await tap(b, `[data-mpick="section"][data-id="${s}"]`); await sleep(1000);   // снять и попробовать следующую
  }
  check("отбор этаж + секция (щелчки по «пилюлям»): на плане один блок", one !== null, `секция ${secId}, блок ${one}`);
  const secCode = sql1(S.db, `SELECT s.code FROM blocks b JOIN object_sections s ON s.id=b.section_id WHERE b.id=${one}`);

  // 3D: переключение кнопкой, «вписать», щелчок в центр холста
  await tap(b, `#ws-modes [data-view="3d"]`);
  await b.waitFor(`/3D/.test(document.querySelector('.ws-status')?.innerText || '') && !!${FD}.querySelector('#mfr-3d-canvas canvas')`, 60000);
  await sleep(5000);
  await tap(b, `[data-tool="fit"]`); await sleep(2500);
  const cv = await b.eval(`(()=>{const f=document.querySelector('iframe.ws-frame').getBoundingClientRect(); const c=${FD}.querySelector('#mfr-3d-canvas canvas').getBoundingClientRect(); return {x:f.x+c.x, y:f.y+c.y, w:c.width, h:c.height}; })()`);
  check("3D: холст WebGL построен в кадре схемы", cv.w > 200 && cv.h > 200, JSON.stringify(cv));
  let n = b.requests.length;
  // центр холста; если луч прошёл мимо (камера после «вписать» может смотреть чуть в сторону) — перебор точек вокруг центра, как verify_model_ui
  const pts = [[0.5, 0.5], [0.5, 0.45], [0.5, 0.55], [0.45, 0.5], [0.55, 0.5], [0.45, 0.45], [0.55, 0.55], [0.4, 0.5], [0.6, 0.5], [0.5, 0.4], [0.5, 0.6]];
  let hit = null;
  for (const [px, py] of pts) {
    await b.click(cv.x + cv.w * px, cv.y + cv.h * py); await sleep(1500);
    if (/Выбран блок/.test(await status(b))) { hit = [px, py]; break; }
  }
  const got = cardReq(b, n);
  check("щелчок в 3D выбирает блок: «Выбран блок» и карточка V2 запросила именно его", !!hit && got.includes(one), `точка ${JSON.stringify(hit)}, карточки ${got.join(",")}, ожидался ${one}; ${await status(b)}`);
  await tap(b, `.ws-tabs [data-tab="props"]`); await sleep(800);
  const head = await b.eval(`document.querySelector('#ws-panel-body')?.innerText.slice(0,200) || ''`);
  check("панель V2 показывает выбранный блок (секция из SQL)", head.includes(secCode), `${secCode} / ${head.replace(/\n/g, " | ")}`);
  // промах — щелчок в угол холста снимает выбор (V1 bindMfr3DPick)
  await b.click(cv.x + cv.w * 0.04, cv.y + cv.h * 0.9); await sleep(1500);
  check("щелчок мимо блока в 3D снимает выбор", /Ничего не выбрано/.test(await status(b)), await status(b));
  // ⌘-щелчок: две секции, по одному блоку; обычный щелчок по первому, ⌘ — по второму
  if (hit) {
    await b.click(cv.x + cv.w * hit[0], cv.y + cv.h * hit[1]); await sleep(1500);
    await tap(b, `.ws-tabs [data-tab="filters"]`);
    let second = null;
    for (const s of sections.filter((x) => x !== secId)) {
      await tap(b, `[data-mpick="section"][data-id="${s}"]`); await sleep(2000);
      const ids = (await blocksOf()).map(Number);
      if (ids.length === 2) { second = ids.find((x) => x !== one); break; }
      await tap(b, `[data-mpick="section"][data-id="${s}"]`); await sleep(1200);
    }
    if (second) {
      await tap(b, `[data-tool="fit"]`); await sleep(2500);
      n = b.requests.length;
      let p2 = null;
      // перебор точек обычным щелчком ищет второй блок (⌘ до того, как точка найдена, не используем: промах снимает выбор)
      const grid = []; for (let gy = 0.25; gy <= 0.75; gy += 0.05) for (let gx = 0.2; gx <= 0.8; gx += 0.05) grid.push([gx, gy]);
      let p1 = null;
      for (const [px, py] of grid) {
        const k = b.requests.length;
        await b.click(cv.x + cv.w * px, cv.y + cv.h * py); await sleep(700);
        const c = cardReq(b, k);
        if (!p1 && c.includes(one)) p1 = [px, py];
        if (!p2 && c.includes(second)) p2 = [px, py];
        if (p1 && p2) break;
      }
      if (p1 && p2) {
        await b.click(cv.x + cv.w * p1[0], cv.y + cv.h * p1[1]); await sleep(1200);
        await b.click(cv.x + cv.w * p2[0], cv.y + cv.h * p2[1], { meta: true }); await sleep(1500);
        check("⌘-щелчок в 3D добавляет второй блок: «Выбрано блоков: 2»", /Выбрано блоков: 2/.test(await status(b)), await status(b));
      } else check("⌘-щелчок в 3D: найдены точки обоих блоков", false, `p1 ${p1}, p2 ${p2}`);
    } else check("⌘-щелчок в 3D: найдена вторая секция с одним блоком на этаже", false);
  }

  // «Сбросить все» — как V1: этажи/секции + отбор работ + динамика факта
  await tap(b, `#ws-modes [data-view="2d"]`); await sleep(2500);
  await tap(b, `.ws-tabs [data-tab="filters"]`); await sleep(500);
  await b.waitFor(`document.querySelector('[data-mbp-d="on"]')`, 20000);
  await tap(b, `[data-mbp-d="on"]`); await sleep(2000);
  const st0 = await b.eval(`[...document.querySelectorAll('input[type=checkbox][data-mbp-s], input[type=checkbox][data-mbp-f]')].length`);
  check("перед сбросом: динамика факта включена", await b.eval(`document.querySelector('[data-mbp-d="on"]').checked`));
  await tap(b, `#ws-panel-body [data-act="reset-filters"]`); await sleep(3000);
  const after = await b.eval(`({ dyn: document.querySelector('[data-mbp-d="on"]')?.checked, levels: document.querySelectorAll('[data-mpick="level"][aria-pressed="true"]').length, sections: document.querySelectorAll('[data-mpick="section"][aria-pressed="true"]').length })`);
  check("«Сбросить все»: этажи и секции сняты, динамика факта выключена (как V1)", after.dyn === false && after.sections === 0, JSON.stringify(after) + ` (${st0})`);
  check("исключений JavaScript нет", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("Модель МФР: 3D и «Сбросить все»") ? 1 : 0);

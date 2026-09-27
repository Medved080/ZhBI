// Проверка рабочего места на изолированной обезличенной копии БД.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, check, summary } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-zone-editor-ux-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  const start = Date.now();
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle') && !!document.querySelector('#cz-canvas')", 20000);
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.renderedOutlines) > 9000", 3000);
  const tabMs = Date.now() - start;
  console.log(`Вкладка стоянок с контурами изделий: ${tabMs} мс`);
  check("Рабочая область занимает большую часть высоты", await browser.eval("document.querySelector('.cz-body').getBoundingClientRect().height > innerHeight * .56"));
  check("Верхние информационные строки скрыты", await browser.eval("getComputedStyle(document.querySelector('.v2-screen-head')).display === 'none' && getComputedStyle(document.querySelector('.ze-context')).display === 'none'"));
  check("Все краны сначала свернуты", await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].every(b => b.getAttribute('aria-expanded') === 'false') && ![...document.querySelectorAll('.cz-crane-stands')].some(e => e.getClientRects().length)"));
  check("Добавление находится над списком, инструкция в подсказке", await browser.eval("document.querySelector('#cz-add-stand').getBoundingClientRect().bottom <= document.querySelector('.cz-crane-toggle').getBoundingClientRect().top && document.querySelector('#cz-add-stand').dataset.tooltip.includes('Выберите кран') && !document.querySelector('.cz-tree-intro')"));
  await tap(browser, '.cz-crane-toggle');
  check("Кран раскрывает стоянки", await browser.eval("document.querySelector('.cz-crane-toggle').getAttribute('aria-expanded') === 'true' && !!document.querySelector('.cz-crane-stands .cz-stand')?.getClientRects().length"));
  await tap(browser, '.cz-crane-toggle');
  check("Кран снова сворачивается", await browser.eval("document.querySelector('.cz-crane-toggle').getAttribute('aria-expanded') === 'false'"));
  for (let i = 0; i < 6; i++) await tap(browser, '#cz-zoom-out');
  check("2D уменьшается до 50%", await browser.eval("document.querySelector('#cz-zoom-value').textContent === '50%' && document.querySelector('#cz-zoom-out').disabled"));
  const canvas = await browser.rect('#cz-canvas');
  await browser.wheel(canvas.cx, canvas.cy, -100);
  check("Колесо увеличивает заметно, но плавно", await browser.eval("Number.parseInt(document.querySelector('#cz-zoom-value').textContent, 10) >= 55 && Number.parseInt(document.querySelector('#cz-zoom-value').textContent, 10) <= 60"));
  const switchStart = Date.now();
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 20000);
  const switchMs = Date.now() - switchStart;
  console.log(`Первый переход 2D → 3D: ${switchMs} мс`);
  check("3D-холст доступен при переключении", switchMs < 3000);
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions'", 30000);
  console.log(`3D-изделия готовы: ${Date.now() - switchStart} мс от переключения`);
  for (let i = 0; i < 9; i++) await tap(browser, '#cz-zoom-out');
  check("3D уменьшается до 50%", await browser.eval("document.querySelector('#cz-zoom-value').textContent === '50%' && document.querySelector('#cz-zoom-out').disabled"));
  await tap(browser, '#cz-fit');
  const view = await browser.rect('#cz-3d canvas');
  await browser.drag(view.x + view.w * .84, view.y + view.h * .7, view.x + view.w * .84, view.y + view.h * .18, { steps: 20 });
  const polar = await browser.eval("document.querySelector('#cz-3d').dataset.cameraPolarDeg");
  check("3D-камера поворачивается ниже горизонта", Number(polar) > 90, `угол ${polar}°`);
  if (process.env.ZONES_SHOTS) {
    mkdirSync(process.env.ZONES_SHOTS, { recursive: true });
    await browser.shot(join(process.env.ZONES_SHOTS, 'stance-3d-below-1366.png'));
    await tap(browser, '#cz-view-2d');
    await browser.shot(join(process.env.ZONES_SHOTS, 'stance-2d-1366.png'));
  }
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.map(e => e.message).join("; "));
  if (summary("Эргономика редактора зон")) process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
}

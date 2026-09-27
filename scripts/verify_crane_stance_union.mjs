// Live browser checks on an isolated anonymous database copy, never on port 8000.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, startServer, stopServer, session, openScreen, tap, check, summary, sql1 } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-stance-browser-"));
const shots = join(ROOT, "output", "crane-stance-union");
mkdirSync(shots, { recursive: true });
let browser;
try {
  const { base, db } = await startServer(8378, work);
  check("Временная БД стартует без чужих черновиков", sql1(db, "SELECT count(*) FROM crane_zone_drafts") === 0);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Захватка]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-canvas')");
  check("Кран показан как справочник без редактируемых ярусов", await browser.eval(
    "document.querySelector('.cz-prop-head span')?.textContent === 'Кран' && !document.querySelector('#cz-elevation')"));
  check("Вкладка крана предлагает уровни объекта", await browser.eval("document.querySelector('#cz-crane-level')?.options.length > 1"));
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("!!document.querySelector('#cz-3d[data-zone-bands]')", 30000);
  const bandsOn = await browser.eval("JSON.parse(document.querySelector('#cz-3d').dataset.zoneBands)");
  check("Объёмы кранов построены из стоянок", bandsOn.length > 0 && bandsOn.every((band) => band.stanceId));
  await tap(browser, "#cz-show-elements");
  await browser.waitFor("!!document.querySelector('#cz-3d[data-zone-bands]')", 30000);
  const bandsOff = await browser.eval("JSON.parse(document.querySelector('#cz-3d').dataset.zoneBands)");
  check("Скрытие изделий не меняет верх полос", JSON.stringify(bandsOn) === JSON.stringify(bandsOff));
  await browser.shot(join(shots, "editor-3d-1366.png"));
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-add-stand')");
  const craneIds = await browser.eval("[...document.querySelectorAll('.cz-tree-item:not(.cz-stand)')].map((el) => el.dataset.zoneId)");
  await tap(browser, `.cz-tree-item[data-zone-id="${craneIds[1]}"]`);
  await tap(browser, "#cz-add-stand");
  await browser.sleep(1500);
  const state = await browser.eval("({status:document.querySelector('#cz-status')?.textContent, selected:document.querySelector('.cz-prop-head strong')?.textContent, parent:document.querySelector('#cz-parent')?.value, saveDisabled:document.querySelector('#cz-save')?.disabled})");
  check("Создание стоянки начинает черновик", sql1(db, "SELECT count(*) FROM crane_zone_drafts WHERE object_id=1") === 1);
  check("Новая стоянка создаётся рядом с выбранным краном", state.parent === craneIds[1] && state.saveDisabled === false);
  check("Нет ошибок JavaScript в 3D редакторе", browser.exceptions.length === 0);
  await browser.close(); browser = null;
  browser = await session(base, "admin", { objectId: 2, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Захватка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-new')");
  await tap(browser, "#cz-new");
  await browser.waitFor("!!document.querySelector('.cz-exception-item')", 15000);
  const exceptionCount = await browser.eval("document.querySelector('.cz-exceptions')?.textContent.match(/Исключения назначений\\s*·\\s*(\\d+)/)?.[1]");
  check("Исключения переноса видны в черновике", Number(exceptionCount) === 4115);
  await browser.shot(join(shots, "exceptions-1366.png"));
  await tap(browser, "#cz-preview");
  await browser.waitFor("document.querySelector('#cz-preview-result')?.textContent.includes('исключений переноса: 4115')", 30000);
  check("Предпросмотр показывает точные назначения и исключения", await browser.eval(
    "document.querySelector('#cz-preview-result')?.textContent.includes('Изделий: 4926') && !document.querySelector('.cz-tree-item b')?.textContent.includes('≈')"));
  await tap(browser, "[data-remove-exception]");
  check("Исключение снимается явно только в черновике", await browser.eval(
    "document.querySelector('.cz-exceptions')?.textContent.includes('Исключения назначений · 4114')"));
  check("Снятие исключения не меняет опубликованные назначения", sql1(db,
    "SELECT count(*) FROM crane_zone_version_assignments a JOIN crane_zone_versions v ON v.id=a.version_id WHERE v.object_id=2 AND v.kind='conversion' AND a.source='conversion'") === 4115);
  check("Нет ошибок JavaScript в списке исключений", browser.exceptions.length === 0);
  await browser.close(); browser = null;
  browser = await session(base, "admin", { objectId: 1, width: 1920, height: 1080 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Захватка]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.shot(join(shots, "editor-2d-1920.png"));
  check("Редактор помещается на 1920×1080", await browser.eval(
    "document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1"));
  check("Нет ошибок JavaScript на широком экране", browser.exceptions.length === 0);
  await browser.close(); browser = null;
  if (summary("Объединение стоянок в браузере")) process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
}

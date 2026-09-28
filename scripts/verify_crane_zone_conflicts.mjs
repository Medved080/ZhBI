// Красная штриховка конфликтов стоянок в редакторе (2D) на временной копии обезличенной БД. Во временной копии
// левая граница стоянки 22766 крана 22762 (отметка 0) сдвинута внутрь соседней 22765 — гарантированный конфликт
// разных стоянок; исходная база не меняется. Публикации нет.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, exec, check, summary, sleep } from "./audit_work/lib.mjs";

const setup = { setup: (db) => exec(db, "PRAGMA foreign_keys = ON; DELETE FROM crane_zone_drafts;" +
  " UPDATE zone_levels SET outline_json = replace(outline_json, '43466.93175881448', '40000') WHERE zone_id = 22766;" +
  " UPDATE crane_zone_versions SET zones_json = replace(zones_json, '43466.93175881448', '40000');") };
const work = mkdtempSync(join(tmpdir(), "crane-zone-conflicts-"));
let browser;
try {
  const { base } = await startServer(8378, work, setup);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-show-conflicts') && Number(document.querySelector('#cz-canvas')?.dataset.renderedOutlines) > 0", 30000);
  const data = (key) => browser.eval(`Number(document.querySelector('#cz-canvas').dataset.${key})`);
  check("Штриховка по умолчанию выключена", await browser.eval("!document.querySelector('#cz-show-conflicts').checked") && await data("hatchedConflicts") === 0);
  const craneConflicts = await data("conflicts");
  check("Счётчик показывает конфликты текущей схемы и выделен красным", craneConflicts > 0 &&
    await browser.eval(`document.querySelector('#cz-conflict-count').textContent === '${craneConflicts}' && document.querySelector('#cz-conflict-count').classList.contains('cz-conflict-count-bad')`),
    `на схеме ${craneConflicts}, в объекте ${await data("objectConflicts")}`);
  await tap(browser, "#cz-show-conflicts"); await sleep(200);
  check("Галочка включает штриховку всех конфликтов схемы", await data("hatchedConflicts") === craneConflicts);
  const red = await browser.eval(`(() => {
    const c = document.querySelector('#cz-canvas'), ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; })()`);
  check("На холсте есть красные пиксели штриховки", red > 50, `${red} пикселей`);
  if (process.env.CONFLICT_SHOT) await browser.shot(process.env.CONFLICT_SHOT);
  await tap(browser, "#cz-show-conflicts"); await sleep(200);
  check("Повторный щелчок убирает штриховку", await data("hatchedConflicts") === 0);
  await tap(browser, "#cz-show-conflicts"); await sleep(200);
  // Ярус стоянки 22766 (отметка 0): видны конфликты только его высотной полосы.
  await tap(browser, ".cz-crane-toggle");
  await tap(browser, '.cz-tree-item.cz-stand[data-zone-id="22766"]');
  await browser.waitFor("document.querySelector('.cz-tree-item.cz-stand[data-zone-id=\"22766\"]')?.classList.contains('active')", 10000);
  await sleep(300);
  const stanceConflicts = await data("conflicts");
  check("При выборе яруса стоянки остаются конфликты его полосы, штриховка сохраняется",
    stanceConflicts >= 1 && stanceConflicts <= craneConflicts && await data("hatchedConflicts") === stanceConflicts,
    `${craneConflicts} → ${stanceConflicts}`);
  const t = Date.now();
  for (let i = 0; i < 10; i++) await browser.eval("document.querySelector('#cz-zoom-in').click()");
  check("Перерисовка со штриховкой не тормозит", Date.now() - t < 3000, `${Date.now() - t} мс на 10 шагов масштаба`);
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
  check("В 3D галочка на месте, но недоступна: штриховка только в 2D", await browser.eval("document.querySelector('#cz-show-conflicts')?.disabled === true"));
  await tap(browser, "#cz-view-2d");
  await browser.waitFor("!!document.querySelector('#cz-show-conflicts') && !!document.querySelector('#cz-canvas')?.dataset.hatchedConflicts", 10000).catch(() => {});
  check("После возврата в 2D штриховка остаётся включённой", await browser.eval("document.querySelector('#cz-show-conflicts').checked") && await data("hatchedConflicts") > 0,
    await browser.eval("JSON.stringify({checked: document.querySelector('#cz-show-conflicts')?.checked, ds: {...document.querySelector('#cz-canvas')?.dataset}})"));
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
process.exitCode = summary("Конфликты зон") ? 1 : 0;

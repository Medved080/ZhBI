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
  check("Мелкие наложения отмечены кружками", await data("markedConflicts") > 0, `${await data("markedConflicts")} кружков`);
  // Список пар при наведении на число: на схеме и в других кранах/ярусах, с числами как у счётчика.
  const objectConflicts = await data("objectConflicts");
  const countRect = await browser.rect("#cz-conflict-count");
  await browser.eval("document.querySelector('#cz-conflict-count').dispatchEvent(new MouseEvent('mouseenter'))");
  await browser.waitFor("!document.querySelector('#cz-conflict-list').hidden", 3000);
  const list = JSON.parse(await browser.eval(`JSON.stringify({
    heads: [...document.querySelectorAll('#cz-conflict-list h4')].map((h) => h.textContent),
    rows: document.querySelectorAll('#cz-conflict-list .cz-conflict-row').length,
    first: document.querySelector('#cz-conflict-list .cz-conflict-row')?.textContent,
    box: (() => { const r = document.querySelector('#cz-conflict-list').getBoundingClientRect(); return { top: r.top, right: r.right, w: r.width }; })() })`));
  check("Список показывает пары на схеме и в других кранах и ярусах",
    list.heads[0] === `На текущей схеме — ${craneConflicts}` && list.heads[1] === `Другие краны и ярусы — ${objectConflicts - craneConflicts}` &&
    list.rows === Math.min(craneConflicts, 40) + Math.min(objectConflicts - craneConflicts, 40), JSON.stringify(list));
  check("В строке пары — краны, стоянки, отметки и площадь", /Кран .* · Стоянка .*↔.*полоса \+\d+….*(м²|мм²)/.test(list.first || ""), list.first);
  check("Список раскрывается под числом", list.box.top >= countRect.y + countRect.h && list.box.top - (countRect.y + countRect.h) < 20, JSON.stringify(list.box));
  await browser.eval("document.querySelector('#cz-conflict-count').dispatchEvent(new MouseEvent('mouseleave'))");
  await sleep(500);
  check("Без закрепления список скрывается, когда мышь уходит", await browser.eval("document.querySelector('#cz-conflict-list').hidden"));
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
  await tap(browser, "#cz-conflict-count");
  await browser.waitFor("!document.querySelector('#cz-conflict-list').hidden", 3000);
  if (process.env.LIST_SHOT) await browser.shot(process.env.LIST_SHOT);
  // Переход к паре из другого крана или яруса.
  const target = JSON.parse(await browser.eval(`(() => {
    const heads = [...document.querySelectorAll('#cz-conflict-list h4')];
    let node = heads[1]?.nextElementSibling; while (node && !node.matches('.cz-conflict-row')) node = node.nextElementSibling;
    return JSON.stringify({ text: node?.textContent || null, index: node?.dataset.conflict ?? null });
  })()`));
  // Настоящий щелчок мыши по строке: курсор уходит с числа, как у пользователя.
  await tap(browser, `.cz-conflict-row[data-conflict="${target.index}"]`);
  await sleep(600);
  if (process.env.PAIR_SHOT) await browser.shot(process.env.PAIR_SHOT);
  check("Переход к паре не прокручивает страницу", await browser.eval("document.scrollingElement.scrollTop === 0 && document.querySelector('.v2-page')?.scrollTop === 0"));
  check("Щелчок по паре открывает её стоянку со штриховкой", target.text && await browser.eval("document.querySelector('#cz-conflict-list').hidden") &&
    await browser.eval("!!document.querySelector('.cz-tree-item.cz-stand.active') && document.querySelector('#cz-show-conflicts').checked") &&
    await data("hatchedConflicts") > 0 && await browser.eval(`(() => { const a = document.querySelector('.cz-tree-item.cz-stand.active').getBoundingClientRect(), t = document.querySelector('.cz-tree').getBoundingClientRect(); return a.top >= t.top && a.bottom <= t.bottom; })()`), `${target.text} → на схеме ${await data("conflicts")}; ` + await browser.eval("JSON.stringify({hidden: document.querySelector('#cz-conflict-list').hidden, active: document.querySelector('.cz-tree-item.cz-stand.active')?.textContent, checked: document.querySelector('#cz-show-conflicts').checked, hatched: document.querySelector('#cz-canvas').dataset.hatchedConflicts})"));
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

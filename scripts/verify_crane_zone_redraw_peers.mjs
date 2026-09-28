// Ручная отрисовка контура: вокруг редактируемой стоянки обведены все стоянки, в которые заходить нельзя (любые
// краны, пересекающиеся высотные полосы). Временная копия обезличенной БД без черновиков; публикации нет.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, exec, sql, check, summary, sleep } from "./audit_work/lib.mjs";
import { peerLevels } from "../app/static/v2/zone-overlap.js";

const STANCE = 22766;
const work = mkdtempSync(join(tmpdir(), "crane-redraw-peers-"));
let browser;
try {
  const { base, db } = await startServer(8378, work, { setup: (path) => exec(path, "PRAGMA foreign_keys = ON; DELETE FROM crane_zone_drafts;") });
  // Ожидание — тем же расчётом по данным базы: стоянки объекта с ярусами.
  const rows = sql(db, "SELECT z.id, z.parent_zone_id, z.name, l.elevation_mm, l.upper_elevation_mm, l.outline_json FROM zones z " +
    "JOIN zone_levels l ON l.zone_id = z.id WHERE z.object_id = 1 AND z.is_current = 1 AND z.category = 'Стоянка' AND l.is_reference = 0 ORDER BY l.id");
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id, category: "Стоянка", parent_zone_id: r.parent_zone_id, name: r.name, levels: [] });
    byId.get(r.id).levels.push({ elevation_mm: r.elevation_mm, upper_elevation_mm: r.upper_elevation_mm, outline: JSON.parse(r.outline_json) });
  }
  const zones = [...byId.values()], target = byId.get(STANCE);
  const expected = peerLevels(zones, target, target.levels[0].elevation_mm);
  const otherCranes = new Set(expected.map(({ other }) => other.parent_zone_id).filter((id) => id !== target.parent_zone_id));

  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  await tap(browser, "#cz-new");
  await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value", 30000);
  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${target.parent_zone_id}"]`);
  await tap(browser, `.cz-stand[data-zone-id="${STANCE}"]`);
  await browser.waitFor("!!document.querySelector('#cz-redraw-polygon')", 10000);
  check("Вне рисования соседние контуры не обводятся", await browser.eval("document.querySelector('#cz-canvas').dataset.drawPeers") === "0");
  await tap(browser, "#cz-redraw-polygon");
  await browser.waitFor("!!document.querySelector('.cz-draw-guide')", 10000);
  await sleep(300);
  const drawn = Number(await browser.eval("document.querySelector('#cz-canvas').dataset.drawPeers"));
  check("При рисовании обведены все стоянки, куда нельзя заходить", expected.length > 0 && drawn === expected.length,
    `обведено ${drawn}, ожидалось ${expected.length}, из них других кранов: ${otherCranes.size ? [...otherCranes].join(", ") : "нет"}`);
  check("Среди обведённых есть стоянки других кранов", otherCranes.size > 0);
  check("Подсказка объясняет красный пунктир", await browser.eval("document.querySelector('.cz-draw-guide-text').textContent.includes('Красным пунктиром')"));
  if (process.env.PEERS_SHOT) await browser.shot(process.env.PEERS_SHOT);
  await tap(browser, "#cz-draw-cancel");
  await sleep(300);
  check("После отмены обводка исчезает", await browser.eval("!document.querySelector('.cz-draw-guide') && document.querySelector('#cz-canvas').dataset.drawPeers === '0'"));
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
process.exitCode = summary("Соседние контуры при рисовании") ? 1 : 0;

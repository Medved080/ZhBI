// Снятие публикации редакции зон кнопкой редактора (2026-09-28) на временной копии обезличенной БД: редакция №2
// публикуется через API (стоянка 22766 уменьшена вдвое), затем снимается в интерфейсе. Исходная база не меняется.
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, exec, sql, sql1, check, summary, sleep } from "./audit_work/lib.mjs";

const STANCE = 22766;
const work = mkdtempSync(join(tmpdir(), "crane-zone-withdraw-"));
const assignments = (db) => JSON.stringify(sql(db, "SELECT e.id, e.zone_crane_id, e.zone_crane_status, e.zone_stance_id, " +
  "e.zone_stance_status, l.elevation_mm FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id " +
  "WHERE e.object_id = 1 AND e.is_current = 1 ORDER BY e.id"));
let browser;
try {
  const { base, db } = await startServer(8378, work, { setup: (path) => exec(path, "PRAGMA foreign_keys = ON; DELETE FROM crane_zone_drafts;") });
  const before = assignments(db);
  const previous = sql(db, "SELECT id, revision_no FROM crane_zone_versions WHERE object_id = 1 ORDER BY revision_no DESC LIMIT 1")[0];
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  // Публикация пересчитывает ~10 тыс. изделий дольше таймаута одного вызова DevTools — результат ждём опросом.
  await browser.eval(`window.__pub = null; (async () => {
    const prefix = "/objects/1/crane-zone-versions";
    const call = async (method, url, body) => { const r = await fetch(url, { method, credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error(method + " " + url + ": " + await r.text()); return r.json(); };
    const created = await call("POST", prefix + "/drafts", {});
    const draft = await call("GET", prefix + "/drafts/" + created.draft_id);
    const stance = draft.zones.find((z) => z.id === ${STANCE});
    for (const level of stance.levels) {
      const xs = level.outline.map((p) => p[0]), x0 = Math.min(...xs), x1 = Math.max(...xs), mid = (x0 + x1) / 2;
      level.outline = level.outline.map(([x, y]) => [x === x1 ? mid : x, y]);
    }
    const patched = await call("PATCH", prefix + "/drafts/" + draft.id, { edit_token: draft.edit_token, zones: draft.zones,
      overrides: draft.overrides, note: "Стоянка уменьшена для проверки снятия" });
    await call("POST", prefix + "/drafts/" + draft.id + "/preview", {});
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
    return JSON.stringify(await call("POST", prefix + "/drafts/" + draft.id + "/publish", { edit_token: patched.edit_token, effective_date: today }));
  })().then((v) => { window.__pub = v; }, (e) => { window.__pub = "ERR " + e.message; }); true`);
  const raw = await browser.waitFor("window.__pub", 180000);
  if (String(raw).startsWith("ERR")) throw new Error(raw);
  const published = JSON.parse(raw);
  check("Редакция опубликована и действует", published.activated && published.revision_no === previous.revision_no + 1,
    `№${published.revision_no}`);
  const changedByPublish = assignments(db) !== before;
  check("Публикация изменила назначения изделий", changedByPublish);

  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-restore')", 30000);
  check("На действующей схеме кнопка снимает последнюю публикацию",
    await browser.eval(`document.querySelector('#cz-restore').textContent === 'Снять публикацию №${published.revision_no}'`));
  await tap(browser, "#cz-restore");
  await browser.waitFor("!!document.querySelector('.v2-dialog [data-choice=confirm]')", 5000);
  check("Подтверждение объясняет последствия", await browser.eval(
    "(t => t.includes('станет черновиком') && t.includes('резервная копия') && t.includes('Отчёты'))(document.querySelector('.v2-dialog').textContent)"));
  await tap(browser, ".v2-dialog [data-choice=confirm]");
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Снято:')", 120000)
    .catch(async (e) => { throw new Error(`${e.message}; строка состояния: ${await browser.eval("document.querySelector('#cz-feedback')?.textContent")}`); });
  const feedback = await browser.eval("document.querySelector('#cz-feedback').textContent");
  check("Сообщение о результате", /изменено назначений изделий: [1-9]/.test(feedback), feedback);
  check("Назначения изделий вернулись к прежней редакции", assignments(db) === before);
  check("Снятой редакции больше нет", sql1(db, `SELECT COUNT(*) FROM crane_zone_versions WHERE object_id = 1 AND revision_no = ${published.revision_no}`) === 0);
  const draft = sql(db, "SELECT id, base_version_id, note FROM crane_zone_drafts WHERE object_id = 1")[0];
  check("Снятая редакция стала черновиком на основе прежней", draft && draft.base_version_id === previous.id &&
    draft.note === "Стоянка уменьшена для проверки снятия");
  check("Черновик открыт в редакторе для доработки", await browser.eval(`document.querySelector('#cz-draft-select')?.value === '${draft?.id}'`)
    && await browser.eval("!document.querySelector('#cz-draft-select option:checked')?.textContent.includes('устарел')"));
  check("Действие записано в журнал", sql1(db, "SELECT COUNT(*) FROM activity_log WHERE action = 'crane_zone_version_withdraw'") === 1);
  check("Перед снятием сделана резервная копия", existsSync(join(work, "backups")) &&
    readdirSync(join(work, "backups")).some((name) => name.endsWith(".db")));
  // Служебную редакцию (перенос на новую модель) снять нельзя: для исходной №0 кнопки нет.
  await browser.eval("document.querySelector('#cz-draft-select').value = ''; document.querySelector('#cz-draft-select').dispatchEvent(new Event('change'))");
  await sleep(800);
  const baseline = sql1(db, "SELECT id FROM crane_zone_versions WHERE object_id = 1 AND kind = 'baseline'");
  await browser.eval(`document.querySelector('#cz-version-select').value = '${baseline}'; document.querySelector('#cz-version-select').dispatchEvent(new Event('change'))`);
  await browser.waitFor(`document.querySelector('#cz-version-select')?.value === '${baseline}'`, 15000);
  check("К исходной редакции через служебную вернуться нельзя", await browser.eval("!document.querySelector('#cz-restore')"));
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
process.exitCode = summary("Снятие публикации") ? 1 : 0;

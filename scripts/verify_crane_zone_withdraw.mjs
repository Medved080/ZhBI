// Откат редакции зон кнопкой «Откат редакции» (2026-09-28) на временной копии обезличенной БД: редакция №2
// публикуется через API (стоянка 22766 уменьшена вдвое), затем снимается в интерфейсе. Исходная база не меняется.
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, exec, sql, sql1, check, summary, sleep, reload } from "./audit_work/lib.mjs";

const STANCE = 22766;
const work = mkdtempSync(join(tmpdir(), "crane-zone-withdraw-"));
const assignments = (db) => JSON.stringify(sql(db, "SELECT e.id, e.zone_crane_id, e.zone_crane_status, e.zone_stance_id, " +
  "e.zone_stance_status, l.elevation_mm FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id " +
  "WHERE e.object_id = 1 AND e.is_current = 1 ORDER BY e.id"));
let browser;
try {
  const { base, db } = await startServer(8378, work, { setup: (path) => exec(path, "PRAGMA foreign_keys = ON; DELETE FROM crane_zone_drafts;") });
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  // Сценарий начинается с объекта, где последняя редакция — служебная: если в копии уже есть опубликованные
  // (копия с рабочей базы), объект сначала откатывается к переносу на новую модель, черновики отката убираются.
  const conversion = sql(db, "SELECT id FROM crane_zone_versions WHERE object_id = 1 AND kind = 'conversion'")[0];
  const top = sql(db, "SELECT id, kind FROM crane_zone_versions WHERE object_id = 1 ORDER BY revision_no DESC LIMIT 1")[0];
  if (conversion && top.kind !== "conversion") {
    await browser.eval(`window.__prep = null; fetch("/objects/1/crane-zone-versions/${conversion.id}/restore", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ latest_version_id: ${top.id} }) })
      .then(async (r) => { window.__prep = r.ok ? "ok" : "ERR " + await r.text(); }); true`);
    const prep = await browser.waitFor("window.__prep", 180000);
    if (prep !== "ok") throw new Error(prep);
    exec(db, "DELETE FROM crane_zone_drafts");
  }
  const withdrawsBefore = sql1(db, "SELECT COUNT(*) FROM activity_log WHERE action = 'crane_zone_version_withdraw'");
  const before = assignments(db);
  const previous = sql(db, "SELECT id, revision_no FROM crane_zone_versions WHERE object_id = 1 ORDER BY revision_no DESC LIMIT 1")[0];
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
  await browser.waitFor("!!document.querySelector('#cz-rollback')", 30000);
  check("Кнопка «Откат редакции» доступна", await browser.eval("document.querySelector('#cz-rollback').textContent === 'Откат редакции' && !document.querySelector('#cz-rollback').disabled"));
  await tap(browser, "#cz-rollback");
  await browser.waitFor("!!document.querySelector('.cz-rollback-dialog')", 5000);
  const dialog = JSON.parse(await browser.eval(`JSON.stringify({
    rows: [...document.querySelectorAll('.cz-rollback-row')].map((row) => ({ text: row.textContent.replace(/\\s+/g, ' ').trim(), disabled: row.querySelector('input').disabled, checked: row.querySelector('input').checked })),
    effect: document.querySelector('.cz-rollback-effect').textContent, confirm: document.querySelector('.cz-rollback-dialog [data-choice=confirm]').textContent })`));
  const versionCount = sql1(db, "SELECT COUNT(*) FROM crane_zone_versions WHERE object_id = 1");
  check("В окне все редакции, последняя и служебные недоступны", dialog.rows.length === versionCount &&
    dialog.rows[0].disabled && dialog.rows[0].text.includes("последняя редакция") &&
    dialog.rows.at(-1).disabled && dialog.rows.at(-1).text.includes("служебная"), JSON.stringify(dialog.rows));
  check("По умолчанию выбрана предыдущая редакция", dialog.rows[1].checked && dialog.confirm === `Откатить к №${previous.revision_no}`, dialog.confirm);
  check("Окно объясняет последствия", dialog.effect.includes(`Станут черновиками: №${published.revision_no}`) &&
    dialog.effect.includes(`вернутся к редакции №${previous.revision_no}`) && dialog.effect.includes("резервная копия"), dialog.effect);
  if (process.env.ROLLBACK_SHOT) await browser.shot(process.env.ROLLBACK_SHOT);
  await tap(browser, ".cz-rollback-dialog [data-choice=confirm]");
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Откат выполнен')", 120000)
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
  check("Действие записано в журнал", sql1(db, "SELECT COUNT(*) FROM activity_log WHERE action = 'crane_zone_version_withdraw'") === withdrawsBefore + 1);
  check("Перед откатом сделана резервная копия", existsSync(join(work, "backups")) &&
    readdirSync(join(work, "backups")).some((name) => name.endsWith(".db")));
  check("Списки редакций подписаны", await browser.eval("[...document.querySelectorAll('.cz-select-label > span')].map((e) => e.textContent).join('|') === 'Просмотр редакции|Черновик'")
    && await browser.eval(`document.querySelector('#cz-version-select option[value=""]').textContent === 'Действующая (№${previous.revision_no})'`));
  // Будущая редакция: черновик из снятой публикуется на завтра — в истории «вступит в силу», в окне «не изменятся».
  const tomorrow = await browser.eval("new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })");
  await browser.eval(`window.__pub = null; (async () => {
    const prefix = "/objects/1/crane-zone-versions";
    const d = await (await fetch(prefix + "/drafts/${draft?.id}", { credentials: "same-origin" })).json();
    await fetch(prefix + "/drafts/${draft?.id}/preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    const r = await fetch(prefix + "/drafts/${draft?.id}/publish", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token: d.edit_token, effective_date: "${tomorrow}" }) });
    return r.ok ? "ok" : "ERR " + await r.text();
  })().then((v) => { window.__pub = v; }, (e) => { window.__pub = "ERR " + e.message; }); true`);
  const future = await browser.waitFor("window.__pub", 180000);
  if (future !== "ok") throw new Error(future);
  const before2 = assignments(db);
  await reload(browser);
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-rollback')", 30000);
  check("В истории будущая редакция подписана «вступит в силу»", await browser.eval(`[...document.querySelectorAll('#cz-version-select option')].some((o) => o.textContent.includes('вступит в силу ${tomorrow}'))`));
  await tap(browser, "#cz-rollback");
  await browser.waitFor("!!document.querySelector('.cz-rollback-dialog')", 5000);
  check("Для будущей редакции окно говорит, что назначения не изменятся", await browser.eval("document.querySelector('.cz-rollback-effect').textContent.includes('не изменятся')"));
  await browser.key("Escape");
  await sleep(300);
  check("Escape закрывает окно без изменений", await browser.eval("!document.querySelector('.cz-rollback-dialog')") && assignments(db) === before2 &&
    sql1(db, "SELECT COUNT(*) FROM crane_zone_versions WHERE object_id = 1 AND activated_at IS NULL") === 1);
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
process.exitCode = summary("Снятие публикации") ? 1 : 0;

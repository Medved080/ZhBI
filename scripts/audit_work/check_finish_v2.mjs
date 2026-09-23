// Проверка палитр, выгрузки по снимку схемы и возврата периода «Моей работы».
// Запуск на отдельном сервере scripts/real_auth_server.py с копией обезличенной БД:
//   AUDIT_BASE=http://127.0.0.1:8371 AUDIT_DB=/private/tmp/.../work.db node scripts/audit_work/check_finish_v2.mjs
import { session, openScreen, sleep, check, summary, sql, setObject } from "./lib.mjs";

const base = process.env.AUDIT_BASE;
const db = process.env.AUDIT_DB;
if (!base || !db) throw new Error("Укажите AUDIT_BASE и AUDIT_DB тестового сервера");
const b = await session(base, "admin", { objectId: 1 });
try {
  await openScreen(b, "appearance", `document.querySelector('[data-skin=gos]')`);
  const before = await b.eval(`document.querySelector('.v2-skin[aria-pressed=true]')?.dataset.skin`);
  const palettes = [
    ["gos", "#0d4cd3", "light"], ["msu", "#a31212", "light"],
    ["graphite", "#7aa2f7", "dark"], ["indigo", "#8b9dff", "dark"],
    ["neon", "#fcee0a", "dark"], ["emerald", "#0e8a5f", "light"],
    ["sand", "#b4690e", "light"],
  ];
  for (const [skin, accent, scheme] of palettes) {
    await b.clickSel(`.v2-skin[data-skin="${skin}"]`);
    await b.waitFor(`document.documentElement.dataset.skin==='${skin}'`, 10000);
    const actual = await b.eval(`({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), scheme: document.documentElement.style.colorScheme })`);
    check(`палитра ${skin} применена к оболочке`, actual.accent.toLowerCase() === accent, JSON.stringify(actual));
    check(`палитра ${skin}: цветовая схема ${scheme}`, actual.scheme === scheme, actual.scheme);
  }
  await b.clickSel(`.v2-skin[data-skin="${before}"]`);
  await b.waitFor(`document.documentElement.dataset.skin==='${before}'`, 10000);
  if (process.env.AUDIT_SHOT) await b.shot(process.env.AUDIT_SHOT);

  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  for (const [key, value] of [["date_from", "2026-08-11"], ["date_to", "2026-08-12"]]) {
    await b.eval(`(()=>{const x=document.querySelector('input[data-param="${key}"]');x.value='${value}';x.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(500);
  }
  await b.waitFor(`document.querySelector('#rd-report p[role=status]')`, 15000);
  await openScreen(b, "ws-model", `document.querySelector('.ws-workspace') || document.querySelector('.ws-frame')`, 30000);
  await openScreen(b, "report-mywork", `document.querySelector('input[data-param=date_from]')`, 30000);
  const period = await b.eval(`({from:document.querySelector('input[data-param=date_from]').value,to:document.querySelector('input[data-param=date_to]').value})`);
  check("период «Моей работы» восстановлен после ухода на схему", period.from === "2026-08-11" && period.to === "2026-08-12", JSON.stringify(period));
  await setObject(b, 2);
  await openScreen(b, "report-mywork", `document.querySelector('input[data-param=date_from]')`, 30000);
  const otherPeriod = await b.eval(`document.querySelector('input[data-param=date_from]').value`);
  check("период другого объекта не подмешивается", otherPeriod !== "2026-08-11", otherPeriod);
  await setObject(b, 1);

  const ids = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 LIMIT 2").map((r) => r.id);
  await b.eval(`sessionStorage.setItem('v2.schemeFilterSnapshot',JSON.stringify({objectId:1,ws:'model',elementIds:${JSON.stringify(ids)},shown:2,total:9422,excluded:9420,capturedAt:Date.now()}))`);
  await openScreen(b, "bulk-edit", `document.querySelector('#bk-scope')`, 30000);
  const scope = await b.eval(`({filter:!!document.querySelector('input[name=bk-scope][value=filter]'),disabled:document.querySelector('input[name=bk-scope][value=filter]')?.disabled})`);
  check("массовая выгрузка предлагает снимок схемы текущего объекта", scope.filter && !scope.disabled, JSON.stringify(scope));
  await b.clickSel('input[name="bk-scope"][value="filter"]');
  const n = b.requests.length;
  await b.clickSel("#bk-export");
  await b.waitFor(`document.querySelector('#bk-status')?.textContent.includes('выгружен')`, 30000);
  const sent = b.requests.slice(n).find((r) => r.url.endsWith('/elements/bulk-edit/export'));
  const body = sent?.body ? JSON.parse(sent.body) : null;
  check("сервер получил ровно два id снимка, без другого объекта", sent?.status === 200 && JSON.stringify(body?.element_ids) === JSON.stringify(ids) && body.object_id == null, JSON.stringify({ status: sent?.status, body }));
  await setObject(b, 2);
  await openScreen(b, "bulk-edit", `document.querySelector('#bk-scope')`, 30000);
  check("снимок схемы чужого объекта недоступен", await b.eval(`document.querySelector('input[name=bk-scope][value=filter]')?.disabled === true`));
  check("ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
} finally {
  await b.close();
}
process.exit(summary());

// Группировка «Графика поставки» V2: запрос отчёта и выгрузки, общий выбор V1/V2.
// DELIVERY_BASE=http://127.0.0.1:8371 node scripts/verify_delivery_groups_v2.mjs
import { session, openScreen, sleep } from "./audit_work/lib.mjs";

const base = process.env.DELIVERY_BASE;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Укажите DELIVERY_BASE обезличенного стенда");
const results = [];
const check = (name, yes, detail = "") => { results.push(!!yes); console.log(`${yes ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const b = await session(base, "admin", { objectId: 1 });
const bodyOf = (suffix) => {
  const r = b.requests.filter((x) => x.url.endsWith(suffix)).at(-1);
  return r?.body ? JSON.parse(r.body) : null;
};
try {
  await openScreen(b, "report-delivery", `document.querySelector('#rd-report')`, 60000);
  await b.waitFor(`!!document.querySelector('[data-groups=group_by]')`, 30000);
  check("семь уровней группировки и три уровня по умолчанию", await b.eval(`document.querySelectorAll('[data-group-toggle]').length===7 && [...document.querySelectorAll('[data-group-toggle]:checked')].map(x=>x.dataset.groupToggle).join(',')==='counterparty,contract,type'`));
  check("первый запрос отчёта использует группировку V1", JSON.stringify(bodyOf('/reports/delivery-schedule')?.group_by) === JSON.stringify(['counterparty','contract','type']));
  await b.clickSel('[data-group-toggle=zakhvatka]');
  await b.waitFor(`(document.querySelector('#rd-report')?.textContent||'').length>20`, 30000);
  await sleep(350);
  check("включённый уровень ушёл в запрос", JSON.stringify(bodyOf('/reports/delivery-schedule')?.group_by) === JSON.stringify(['counterparty','contract','zakhvatka','type']));
  await b.clickSel('[data-group-move=zakhvatka][data-dir="-1"]');
  await sleep(450);
  const expected = ['counterparty','zakhvatka','contract','type'];
  check("перестановка изменила порядок уровней в запросе", JSON.stringify(bodyOf('/reports/delivery-schedule')?.group_by) === JSON.stringify(expected));
  const stored = await b.eval(`JSON.parse(localStorage.getItem('zhbi_delivery_groups')).filter(x=>x.on).map(x=>x.key)`);
  check("выбор V2 сохранён под тем же ключом, что у V1", JSON.stringify(stored) === JSON.stringify(expected));
  await b.clickSel('[data-export=xlsx]');
  await b.waitFor(`document.querySelector('#rd-export-status')?.textContent.includes('сформирован')`, 60000);
  check("XLSX получил те же уровни", JSON.stringify(bodyOf('/reports/delivery-schedule.xlsx')?.group_by) === JSON.stringify(expected));
  await b.clickSel('[data-export=pdf]');
  await b.waitFor(`document.querySelector('#rd-export-status')?.textContent.includes('.pdf') && document.querySelector('#rd-export-status')?.textContent.includes('сформирован')`, 60000);
  check("PDF получил те же уровни", JSON.stringify(bodyOf('/reports/delivery-schedule.pdf')?.group_by) === JSON.stringify(expected));
  check("ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join('; '));
} finally { await b.close(); }
const bad = results.filter((x) => !x).length;
console.log(`Итого: ${results.length - bad} PASS / ${bad} FAIL`);
process.exitCode = bad ? 1 : 0;

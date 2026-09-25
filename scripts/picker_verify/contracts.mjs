// Раздел «Контракты» V2: список, поиск, «Открыть» (карточка контрагента → контракт), «Добавить контракт» (контрагент → договор → спецификация → форма),
// сохранение нового контракта (один запрос, SQL, журнал), права. Настоящий backend на копии БД. Запуск: node scripts/picker_verify/contracts.mjs (порт 8139)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, SP, hardGoto, typeInto } from "./lib.mjs";
import { prepareCp, text, clickBtn, activity, maxActivityId, writeReqs, clickSelScrolled, selectValue, sql, sql1 } from "./common.mjs";

const S = await startServer(8139, `${SP}/picker_contracts`, { setup: prepareCp });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const one = (q) => Number(sql1(db, q));
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
try {
  await login(b, base, "admin");
  await go("#/contracts");
  await b.waitFor(`document.querySelectorAll('#cl-inner tbody tr').length>0`, 15000);
  const total = one("SELECT COUNT(*) FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id WHERE a.object_id=1 AND co.is_archived=0");
  const rows0 = await b.eval(`document.querySelectorAll('#cl-inner [data-open]').length`);
  check("K0.1 список контрактов: строк столько же, сколько действующих контрактов выбранного объекта в БД", rows0 === total, `${rows0} / ${total}`);
  check("K0.2 в навигации нет метки «V1» у раздела «Контракты»", !(await b.eval(`document.querySelector('[data-section="contracts"]')?.innerText.includes('V1')`)));
  await b.clickSel("[data-q]"); await b.type("QA-нов");
  await sleep(400);
  const nS = await b.eval(`document.querySelectorAll('#cl-inner tbody tr').length`);
  check("K0.3 поиск «QA-нов» (по контрагенту и теме): список сужен, контракт «QA-новый» в нём", nS >= 1 && nS < total && (await text(b, "#cl-inner")).includes("QA-новый"), String(nS));
  await b.clickSel("[data-q]", { count: 3 }); await b.type("QA-новый (тема");
  await b.eval(`(()=>{const q=document.querySelector('[data-q]');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await b.clickSel("[data-q]"); await b.type("QA-новый");
  await sleep(300);
  await b.eval(`[...document.querySelectorAll('#cl-inner tbody tr')].find(r=>r.children[3].innerText.trim()==='QA-новый')?.querySelector('[data-open]')?.scrollIntoView({block:'center'})`);
  await b.eval(`(()=>{const r=[...document.querySelectorAll('#cl-inner tbody tr')].find(r=>r.children[3].innerText.trim()==='QA-новый');const e=r.querySelector('[data-open]');const t=e.getBoundingClientRect();window.__pt={x:t.x+t.width/2,y:t.y+t.height/2}})()`);
  const pt = await b.eval("window.__pt"); await b.click(pt.x, pt.y);
  await b.waitFor(`!!document.querySelector('#ctr-theme')`, 20000);
  check("K1.1 «Открыть»: рабочее пространство контракта в карточке контрагента QA-Новый", (await b.eval(`document.querySelector('#ctr-theme').value`)) === "QA-новый" && (await text(b, "#ctr-inner")).includes("Привязано"));
  check("K1.2 переход ничего не записал", writeReqs(b, 0).filter((w) => w.method !== "POST" || !/\/login$/.test(w.path)).length === 0);

  // добавить контракт
  await go("#/contracts");
  await b.waitFor(`document.querySelectorAll('#cl-inner tbody tr').length>0`, 15000);
  await clickBtn(b, "Добавить контракт");
  await b.waitFor(`document.querySelector('[data-add="cp"]') && document.querySelector('[data-add="cp"]').options.length>2`, 15000);
  const cpNew = one("SELECT id FROM counterparties WHERE short_name='QA-Новый'");
  await selectValue(b, '[data-add="cp"]', cpNew);
  await b.waitFor(`!document.querySelector('[data-add="agreement"]').disabled`);
  await selectValue(b, '[data-add="agreement"]', one("SELECT id FROM agreements WHERE number='QA-Д2'"));
  await b.waitFor(`!document.querySelector('[data-add="spec"]').disabled`);
  await selectValue(b, '[data-add="spec"]', one("SELECT id FROM specifications WHERE number='QA-С2'"));
  await clickBtn(b, "Создать контракт");
  await b.waitFor(`!!document.querySelector('#ctr-theme')`, 20000);
  check("K2.1 «Добавить контракт»: открыта форма нового контракта под выбранной спецификацией (QA-Новый / QA-Д2 / QA-С2)", (await text(b, "#ctr-breadcrumb")).includes("QA-Новый") && (await text(b, "#ctr-breadcrumb")).includes("QA-Д2") && (await text(b, "#ctr-breadcrumb")).includes("QA-С2"), await text(b, "#ctr-breadcrumb"));
  await typeInto(b, "#ctr-theme", "QA-из-списка");
  await typeInto(b, '[data-line-type$="|0"]', "Ригель"); await typeInto(b, '[data-line-mark$="|0"]', "2Р19.2");
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("4");
  const a0 = maxActivityId(db);
  const mark = b.requests.length;
  await b.clickSel("#ctr-save");
  await b.waitFor(`!!document.querySelector('[data-ctr-tab="expanded"]') && !document.querySelector('[data-ctr-tab="expanded"]').disabled`, 15000);
  const w = writeReqs(b, mark);
  check("K2.2 сохранение: один POST /contracts; SQL: контракт «QA-из-списка» с позицией 2Р19.2 × 4", w.length === 1 && w[0].path === "/contracts" && one("SELECT COUNT(*) FROM contracts WHERE theme='QA-из-списка'") === 1 && one("SELECT quantity FROM contract_lines WHERE contract_id=(SELECT id FROM contracts WHERE theme='QA-из-списка') AND mark='2Р19.2'") === 4);
  check("K2.3 журнал: contract_create ровно одно", (await activity(db, `id>${a0}`)).filter((x) => x.action === "contract_create").length === 1);
  await go("#/contracts");
  await b.waitFor(`document.querySelectorAll('#cl-inner tbody tr').length>0`, 15000);
  check("K2.4 после перезагрузки новый контракт есть в списке", (await text(b, "#cl-inner")).includes("QA-из-списка"));

  // права
  await b.close();
  const b2 = await openBrowser(1920, 1080);
  try {
    await login(b2, base, "user2");
    await b2.goto(`${base}/v2#/contracts`, 1500);
    await b2.waitFor(`document.querySelectorAll('#cl-inner tbody tr').length>0`, 20000);
    check("K3.1 роль «Комплектовщик»: список открывается, «Добавить контракт» доступна", await b2.eval(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Добавить контракт'&&!x.disabled)`));
  } finally { await b2.close(); }
  const b3 = await openBrowser(1920, 1080);
  try {
    await login(b3, base, "user4");
    await b3.goto(`${base}/v2#/contracts`, 1500);
    await sleep(1000);
    check("K3.2 роль view: раздел «Контракты» скрыт, адрес ведёт на начальную страницу", await b3.eval(`!document.querySelector('[data-section="contracts"]') && !document.querySelector('#cl-inner')`));
  } finally { await b3.close(); }
  console.log("\nисключения браузера:", b.exceptions.length);
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_contracts_fail.png`); } catch { /* */ }
} finally {
  try { await b.close(); } catch { /* */ }
  await stopServer();
}
process.exit(summary() ? 1 : 0);

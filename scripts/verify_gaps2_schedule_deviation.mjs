// Проверка пункта 3 задания gaps2: кнопка «Отклонение графика» на вкладке «Версии» экрана «График СМР» (app/static/v2/schedule.js),
// зовёт GET-по-смыслу POST /schedule-versions/deviation через api.readPost() (не через шлюз записи — операция ничего не пишет).
import { launch } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:8250";
const objectId = Number(process.argv[3] || 4);
const PASSWORD = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await launch({ width: 1600, height: 1000 });
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type("admin");
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  await b.eval(`(()=>{const s=document.querySelector('#v2-object'); s.value=String(${objectId}); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(600);
  await b.eval(`location.hash='#/schedule'`);
  await b.waitFor(`location.hash==='#/schedule'`, 10000);
  await sleep(1500);
  const tabFound = await b.eval(`!!document.querySelector('[data-sc-tab="versions"]')`);
  console.log("вкладка «Версии» найдена:", tabFound);
  await b.eval(`document.querySelector('[data-sc-tab="versions"]').click()`);
  await sleep(500);
  const btnFound = await b.eval(`!!document.querySelector('[data-a="dev-toggle"]')`);
  console.log("кнопка «Отклонение» найдена:", btnFound);
  if (!btnFound) { console.log("ПРОВАЛ: кнопка не отрисована"); await b.close(); process.exit(1); }
  await b.eval(`document.querySelector('[data-a="dev-toggle"]').click()`);
  await sleep(1200);
  const reqs = b.requests.filter((r) => r.url.includes("/schedule-versions/deviation"));
  console.log("запросов к /schedule-versions/deviation:", reqs.length, reqs.map((r) => `${r.method} ${r.status}`));
  const bodyText = await b.eval(`document.querySelector('.v2-callout')?.innerText || ""`);
  console.log("текст панели:", JSON.stringify(bodyText.slice(0, 300)));
  const errText = await b.eval(`document.querySelector('.v2-note')?.innerText || ""`);
  console.log("текст ошибки (если есть):", JSON.stringify(errText));
  // повторный клик — «Скрыть», данные не должны запрашиваться снова (кэш)
  await b.eval(`document.querySelector('[data-a="dev-toggle"]').click()`);
  await sleep(300);
  await b.eval(`document.querySelector('[data-a="dev-toggle"]').click()`);
  await sleep(500);
  const reqs2 = b.requests.filter((r) => r.url.includes("/schedule-versions/deviation"));
  console.log("запросов к /schedule-versions/deviation после повторного открытия:", reqs2.length, "(ожидание: столько же — кэш не сбрасывался)");
  const ok = reqs.length === 1 && reqs[0].status === 200 && /Начало СМР|Версий графика ещё нет/.test(bodyText);
  console.log(ok ? "ИТОГ: РАБОТАЕТ" : "ИТОГ: НЕ подтверждено");
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });

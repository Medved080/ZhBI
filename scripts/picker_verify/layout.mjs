// Раскладка экранов области «picker» без прокрутки всей страницы (1920×1080 и 1366×768): АРМ комплектовщика (все вкладки с развёрнутыми списками),
// документы контрактации (список и форма), контрагенты (список, карточка, контракт), контракты. Настоящий backend на копии БД. node scripts/picker_verify/layout.mjs (порт 8133)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, SP, hardGoto } from "./lib.mjs";
import { prepareCp, text, clickBtn, clickSelScrolled, selectValue, sql, sql1 } from "./common.mjs";

const S = await startServer(8133, `${SP}/picker_layout`, { setup: prepareCp });
const base = S.base;
const one = (q) => Number(sql1(S.db, q));
const b = await openBrowser(1920, 1080);
const metrics = () => b.eval(`(()=>{const d=document.scrollingElement;const over=[...document.querySelectorAll('.v2-scroll,.ws-panel-body')].filter(e=>e.scrollHeight>e.clientHeight+1).length;return {sh:d.scrollHeight,ih:innerHeight,sw:d.scrollWidth,iw:innerWidth,inner:over}})()`);
const noScroll = (m) => m.sh <= m.ih + 2 && m.sw <= m.iw + 2;
try {
  await login(b, base, "admin");
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await b.viewport(w, h);
    const tag = `${w}×${h}`;
    await hardGoto(b, `${base}/v2#/ws-picker`, 1500);
    await b.waitFor(`(document.querySelector('#ws-panel-body')?.innerText||'').includes('В срезе')`, 90000);
    await sleep(1000);
    for (const t of ["Отбор", "Показатели", "Контракты", "Распределение"]) {
      await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()===${JSON.stringify(t)})?.click()`); await sleep(500);
      if (t === "Контракты") { await b.eval(`document.querySelector('[data-pk-exp]')?.click()`); await sleep(300); }
      const m = await metrics();
      check(`L1 ${tag} АРМ комплектовщика, вкладка «${t}»: страница не прокручивается, горизонтального переполнения нет`, noScroll(m), JSON.stringify(m));
    }
    await hardGoto(b, `${base}/v2#/supplier-change`, 1500);
    await b.waitFor(`document.querySelectorAll('#sd-inner tbody tr').length>0`, 15000);
    check(`L2 ${tag} документы контрактации, список`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await clickBtn(b, "Новый обмен привязками"); await b.waitFor(`!!document.querySelector('[data-f="from"]')`);
    check(`L3 ${tag} документы контрактации, форма документа (длинная — прокрутка внутри области)`, noScroll(await metrics()) && (await metrics()).inner >= 0, JSON.stringify(await metrics()));
    await hardGoto(b, `${base}/v2#/counterparties`, 1200); await b.waitFor(`!!document.querySelector('#cp-add')`, 15000);
    check(`L4 ${tag} контрагенты, список`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await b.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes('QA-Новый'))?.click()`); await b.waitFor(`!!document.querySelector('#cpf-short')`);
    await b.eval(`document.querySelector('[data-tab="contracting"]').click()`); await sleep(1200);
    check(`L5 ${tag} контрагенты, карточка «Контрактация»`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await b.eval(`(()=>{for(const sel of ['[data-agreement]','[data-spec]','[data-contract]']){const d=document.querySelector(sel);if(d&&!d.open)d.querySelector('summary').click()}})()`);
    await sleep(300);
    await b.eval(`document.querySelector('[data-c-open]')?.click()`); await b.waitFor(`!!document.querySelector('#ctr-theme')`, 15000);
    check(`L6 ${tag} контракт: рабочее пространство, «Сохранить» видна без прокрутки страницы`, noScroll(await metrics()) && (await b.eval(`(()=>{const e=document.querySelector('#ctr-foot-actions');if(!e)return false;const r=e.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()`)), JSON.stringify(await metrics()));
    await hardGoto(b, `${base}/v2#/contracts`, 1200); await b.waitFor(`document.querySelectorAll('#cl-inner tbody tr').length>0`, 15000);
    check(`L7 ${tag} контракты, список`, noScroll(await metrics()), JSON.stringify(await metrics()));
  }
  check("L8 ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_layout_fail.png`); } catch { /* */ }
} finally { await b.close(); await stopServer(); }
process.exit(summary() ? 1 : 0);

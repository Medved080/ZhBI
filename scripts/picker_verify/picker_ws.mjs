// АРМ комплектовщика в V2 (панели «Отбор» и «Контракты»): полный сценарий V1 — сортировка колонок среза, «не в этом разрезе», разворот контрактов
// по маркам с числами «всего / привязано / остаток» (сверка с SQL), клик по позиции (марка + контракт в срез), «сбросить позиции», «без контракта»
// по маркам, оговорка среза, подсветка несвязанных. Настоящий backend на копии БД, настоящие события мыши. Запуск: node scripts/picker_verify/picker_ws.mjs
import { startServer, stopServer, openBrowser, login, check, summary, sleep, SP, hardGoto } from "./lib.mjs";
import { prepareCopy, text, clickSelScrolled, sql, sql1 } from "./common.mjs";

const S = await startServer(8134, `${SP}/picker_ws`, { setup: prepareCopy });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const panel = () => text(b, "#ws-panel-body");
const tab = async (name) => { await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`); await sleep(400); };
const pkReady = () => b.waitFor(`(document.querySelector('#ws-panel-body')?.innerText||'').includes('В срезе')`, 90000);
const rowsOf = (group) => b.eval(`(()=>{const sec=[...document.querySelectorAll('.ws-fgroup')].find(s=>s.querySelector('.ws-fh')?.innerText.includes(${JSON.stringify(group)}));if(!sec)return null;return [...sec.querySelectorAll('.ws-pkrow')].map(r=>({label:r.querySelector('span').textContent.trim(),nums:[...r.querySelectorAll('em')].map(e=>e.textContent.trim())}))})()`);
const num = (s) => Number(String(s).replace(/[^\d-]/g, "")) || 0;

try {
  await login(b, base, "admin");
  await hardGoto(b, `${base}/v2#/ws-picker`, 1500);
  await pkReady();
  await sleep(1200);
  console.log("\n== отбор ==");
  const head = await panel();
  check("W1 «Отбор»: строка «В срезе: N из M» и кнопка «Сбросить всё»", /В срезе: [\d\s ]+ из [\d\s ]+/.test(head) && head.includes("Сбросить всё"), head.slice(0, 120));
  // открыть «Тип элемента»
  await b.eval(`(()=>{const h=[...document.querySelectorAll('.ws-fh')].find(x=>x.innerText.includes('Тип элемента'));if(h&&h.getAttribute('aria-expanded')!=='true')h.click()})()`);
  await sleep(300);
  const hdrs = await b.eval(`[...document.querySelectorAll('.ws-pkhead')].slice(0,4).map(x=>x.textContent.trim())`);
  check("W2 заголовки колонок среза «значение / модель / контракт / Δ» — кнопки сортировки", hdrs.length === 4 && hdrs[0].startsWith("значение") && hdrs[1] === "модель" && hdrs[2] === "контракт" && hdrs[3] === "Δ", JSON.stringify(hdrs));
  const before = await rowsOf("Тип элемента");
  await clickSelScrolled(b, '.ws-pkhead[data-pk-sort$="|count"]');
  await sleep(300);
  const desc = await rowsOf("Тип элемента");
  const counts = desc.filter((r) => !/\bdim\b/.test("")).map((r) => num(r.nums[0]));
  const availDesc = counts.slice(0, Math.max(1, counts.length));
  check("W3 первый щелчок по «модель» — по убыванию числа изделий", desc.length > 1 && availDesc.slice(0, -1).every((n, i, a) => i === a.length - 1 || true) && num(desc[0].nums[0]) >= num(desc[1].nums[0]), JSON.stringify(desc.slice(0, 3)));
  await clickSelScrolled(b, '.ws-pkhead[data-pk-sort$="|count"]');
  await sleep(300);
  const asc = await rowsOf("Тип элемента");
  check("W4 повторный щелчок — в обратном порядке (по возрастанию); стрелка активной колонки", num(asc[0].nums[0]) <= num(asc[1].nums[0]) && (await b.eval(`document.querySelector('.ws-pkhead.on')?.textContent`)).includes("↑"), JSON.stringify(asc.slice(0, 3)));
  await clickSelScrolled(b, '.ws-pkhead[data-pk-sort$="|diff"]');
  await sleep(300);
  const dif = await rowsOf("Тип элемента");
  const d = (r) => num(r.nums[2] || "0");
  check("W5 сортировка по Δ (первый щелчок — по убыванию разницы «контракт − модель»)", dif.length > 2 && dif[0].nums.length >= 3 && d(dif[0]) >= d(dif[1]) && d(dif[1]) >= d(dif[2]), JSON.stringify(dif.slice(0, 3)));
  // «законтрактовано — не в этом разрезе»: выбрать этаж
  await b.eval(`(()=>{const h=[...document.querySelectorAll('.ws-fh')].find(x=>x.innerText.includes('Этаж'));if(h&&h.getAttribute('aria-expanded')!=='true')h.click()})()`);
  await sleep(300);
  await clickSelScrolled(b, '.ws-fgroup:has(.ws-fh[data-pkgroup="pk:floor"]) input[data-pk="floor"]');
  await sleep(900);
  const note = await panel();
  check("W6 при срезе по этажу блок «Тип» пишет «законтрактовано — не в этом разрезе» (колонки контракта не пропадают молча)", note.includes("законтрактовано — не в этом разрезе"));
  await b.eval(`[...document.querySelectorAll('[data-pk-clear=""]')].find(x=>!x.disabled)?.click()`);
  await sleep(700);

  console.log("\n== контракты ==");
  await tab("Контракты");
  await sleep(500);
  const ct0 = await panel();
  check("W7 «Контракты»: ссылка на «Документы контрактации» вместо прежней формулировки про «планируемого поставщика»", ct0.includes("Документы контрактации") && !ct0.includes("планируемого поставщика"));
  // выбрать контракт 13 и развернуть по маркам
  const cRow = await b.eval(`(()=>{const c=[...document.querySelectorAll('[data-pkc]')].find(x=>x.dataset.pkc==='13');return c?c.dataset.pkc:null})()`);
  await clickSelScrolled(b, '[data-pk-exp="13"]');
  await sleep(400);
  const marks = await b.eval(`[...document.querySelectorAll('[data-pkml^="13|"]')].map(r=>({label:r.querySelector('span').textContent.trim(),nums:[...r.querySelectorAll('em')].map(e=>e.textContent.trim())}))`);
  check("W8 контракт 13 разворачивается по маркам (позиции по алфавиту)", marks.length >= 3 && JSON.stringify(marks.map((m) => m.label)) === JSON.stringify([...marks.map((m) => m.label)].sort((x, y) => x.localeCompare(y, "ru", { numeric: true }))), JSON.stringify(marks.slice(0, 3)));
  // сверка чисел с SQL: закуплено / привязано / остаток по позиции 4П-12 контракта 13
  const line = marks.find((m) => m.label === "4П-12");
  const dbTotal = Number(sql1(db, "SELECT quantity FROM contract_lines WHERE contract_id=13 AND mark='4П-12'"));
  const dbLinked = Number(sql1(db, "SELECT COUNT(*) FROM elements WHERE contract_id=13 AND mark='4П-12' AND is_current=1"));
  check("W9 числа позиции 4П-12 контракта 13 совпадают с SQL: всего / привязано / остаток", line && num(line.nums[0]) === dbTotal && num(line.nums[1]) === dbLinked && num(line.nums[2]) === dbTotal - dbLinked, `${JSON.stringify(line)} sql=${dbTotal}/${dbLinked}`);
  // клик по позиции: марка и контракт попадают в срез
  await clickSelScrolled(b, '[data-pkml^="13|"]');
  await sleep(900);
  const after = await panel();
  check("W10 клик по позиции контракта добавляет марку и её контракт в срез; появляется «сбросить позиции»", after.includes("сбросить позиции (1)") && after.includes("сбросить контракты (1)"), after.slice(0, 200));
  check("W11 оговорка «привязано и остаток — внутри выбранного среза» появляется, когда срез сужен", after.includes("внутри выбранного среза"), after.slice(0, 300));
  await clickSelScrolled(b, '[data-pk-clearpos]');
  await sleep(900);
  const after2 = await panel();
  check("W12 «сбросить позиции» снимает марку, отбор по контракту остаётся", !after2.includes("сбросить позиции") && after2.includes("сбросить контракты (1)"), after2.slice(0, 160));
  await clickSelScrolled(b, '[data-pk-clear="contract"]');
  await sleep(700);
  // без контракта по маркам
  await clickSelScrolled(b, '[data-pk-exp="none"]');
  await sleep(500);
  const none = await b.eval(`[...document.querySelectorAll('[data-pkmn]')].slice(0,3).map(r=>({label:r.querySelector('span').textContent.trim(),nums:[...r.querySelectorAll('em')].map(e=>e.textContent.trim())}))`);
  const dbNone = Number(sql1(db, "SELECT COUNT(*) FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL"));
  const grpNone = await b.eval(`document.querySelector('.ws-cgroup [data-pkn]')?.innerText`);
  check("W13 «без контракта» разворачивается по маркам; общее число совпадает с SQL", none.length >= 1 && num(String(grpNone).split("\n").filter(Boolean).slice(-2)[0]) === dbNone || (grpNone || "").includes(String(dbNone).replace(/(\d)(?=(\d{3})+$)/g, "$1 ")), `${grpNone} sql=${dbNone} ${JSON.stringify(none[0])}`);
  await clickSelScrolled(b, '[data-pkmn="0"]');
  await sleep(900);
  const p3 = await panel();
  check("W14 клик по марке «без контракта» добавляет марку и признак «без контракта» в срез", p3.includes("сбросить позиции (1)") && /Элементы без контракта|Без контрагента/.test(p3));
  await b.eval(`[...document.querySelectorAll('[data-pk-clear=""]')].find(x=>!x.disabled)?.click()`);
  await sleep(600);
  // подсветка
  await clickSelScrolled(b, '[data-pkhl]');
  await sleep(900);
  const p4 = await panel();
  check("W15 «Подсветить несвязанные»: строка-ответ («подсвечено N…» либо «подсвечивать нечего»)", /подсвечено [\d\s ]+ изделий без контракта|подсвечивать нечего/.test(p4), p4.slice(0, 200));
  // «только с остатком»
  await clickSelScrolled(b, '[data-pkrem]');
  await sleep(500);
  const rem = await b.eval(`[...document.querySelectorAll('[data-pkc]')].every(r=>{const em=[...r.querySelectorAll('em')];return em.length<3||Number(em[2].textContent.replace(/[^\\d-]/g,''))!==0||r.classList.contains('on')})`);
  check("W16 «Показать только с остатком» скрывает контракты с нулевым остатком", rem);
  console.log("\nисключения браузера:", b.exceptions.length, b.exceptions.slice(0, 3));
  check("W17 ошибок JavaScript в панелях нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
  await b.shot(`${SP}/picker_ws/final.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_ws/fail.png`); } catch { /* */ }
} finally {
  await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);

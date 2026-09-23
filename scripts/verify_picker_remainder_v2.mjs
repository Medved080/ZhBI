// «Только с остатком» в АРМ: непривязанные изделия не являются контрактом с остатком.
// PICKER_BASE=http://127.0.0.1:8371 node scripts/verify_picker_remainder_v2.mjs
import { session, openScreen, tap, sleep } from "./audit_work/lib.mjs";

const base = process.env.PICKER_BASE;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Укажите PICKER_BASE обезличенного стенда");
const checks = [];
const check = (name, pass) => { checks.push(!!pass); console.log(`${pass ? "PASS" : "FAIL"} ${name}`); };
const b = await session(base, "admin", { objectId: 1 });
try {
  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs')`, 60000);
  await b.waitFor(`!!document.querySelector('.ws-tabs button[data-tab=contracts]')`, 60000);
  await tap(b, '.ws-tabs button[data-tab=contracts]');
  await b.waitFor(`!!document.querySelector('[data-pkrem]') && !!document.querySelector('[data-pkn]')`, 60000);
  check("изделия без контракта видны при полном списке", await b.eval(`!!document.querySelector('[data-pkn]')`));
  await tap(b, '[data-pkrem]');
  await b.waitFor(`!document.querySelector('[data-pkn]')`, 10000);
  check("«только с остатком» скрывает строку без контракта", await b.eval(`!document.querySelector('[data-pkn]')`));
  await tap(b, '[data-pkrem]');
  await b.waitFor(`!!document.querySelector('[data-pkn]')`, 10000);
  await tap(b, '[data-pkn]');
  await b.waitFor(`document.querySelector('[data-pkn]')?.getAttribute('aria-pressed')==='true'`, 10000);
  await tap(b, '[data-pkrem]');
  await sleep(200);
  check("выбранная строка остаётся видна, чтобы снять отбор", await b.eval(`document.querySelector('[data-pkn]')?.getAttribute('aria-pressed')==='true'`));
  check("ошибок JavaScript нет", b.exceptions.length === 0);
} finally { await b.close(); }
const bad = checks.filter((x) => !x).length;
console.log(`Итого: ${checks.length - bad} PASS / ${bad} FAIL`);
process.exitCode = bad ? 1 : 0;

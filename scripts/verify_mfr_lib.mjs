// Общая часть браузерных проверок области «МФР / учёт по блокам» (scripts/verify_mfr_*.mjs): вход НАСТОЯЩЕЙ формой V2 под нужным
// пользователем копии БД, выбор объекта в шапке, переход на экран, ожидания, снимки. Только scripts/cdp.mjs (настоящие события мыши/клавиатуры).
import { launch } from "./cdp.mjs";
import { mkdirSync } from "node:fs";

export const PASSWORD = process.env.MFR_PASSWORD || "Test-Pass-1234!";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function session({ base, user = "admin", objectId = 4, width = 1920, height = 1080, shots = null } = {}) {
  if (shots) mkdirSync(shots, { recursive: true });
  const b = await launch({ width, height });
  b.base = base; b.shots = shots;
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type(user);
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object') || document.querySelector('.v2-note-page')`, 20000);
  await setObject(b, objectId);
  return b;
}

export async function setObject(b, objectId) {
  const ok = await b.eval(`(()=>{const s=document.querySelector('#v2-object'); if(!s) return false; if (s.value===String(${objectId})) return true; if(![...s.options].some(o=>o.value==='${objectId}')) return false; s.value='${objectId}'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(600);
  return ok;
}

export async function openScreen(b, id, waitExpr) {
  await b.eval(`location.hash='#/${id}'`);
  await b.waitFor(`location.hash==='#/${id}'`);
  if (waitExpr) await b.waitFor(waitExpr, 20000);
  await sleep(300);
}

export const shot = async (b, name) => { if (b.shots) await b.shot(`${b.shots}/${name}.png`); };
export const txt = (b, sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
export const exists = (b, sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);

// простой накопитель результатов проверок
export function checker(title) {
  const rows = [];
  const ok = (cond, label, extra = "") => { rows.push({ ok: !!cond, label, extra }); console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`); return !!cond; };
  return { ok, rows, done() { const bad = rows.filter((r) => !r.ok); console.log(`${title}: ${rows.length - bad.length} ok / ${bad.length} FAIL`); return bad.length; } };
}

// щелчок настоящим событием мыши по элементу, предварительно прокрутив его в видимую область своей панели
export async function tap(b, sel, o) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center',inline:'nearest'})`);
  await sleep(120);
  await b.clickSel(sel, o);
}

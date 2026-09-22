// Общие функции проверок аудита «рабочие места и отчёты» (Docs/v2-progress/audit-work.md). Настоящий backend на ВРЕМЕННОЙ копии
// обезличенной БД (scripts/real_auth_server.py), настоящий вход формой V2, настоящие события мыши и клавиатуры (scripts/cdp.mjs).
// Порты 8370–8379. Уже запущенный сервер можно подставить переменной AUDIT_BASE (тогда копией БД управляет тот, кто его поднял).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const SP = process.env.AUDIT_SP || "/private/tmp/claude-501/-Users-max-zhbi-tool/788b45dd-b72e-49d3-ba64-2491a0ac0e5a/scratchpad";
export const BASE_DB = `${ROOT}/data/zhbi.anon.db`;
export const PASS = "Test-Pass-1234!";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 400) : ""}`);
  return !!ok;
}
export function summary(title = "Итого") {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${title}: ${results.length - bad.length} PASS / ${bad.length} FAIL из ${results.length}`);
  return bad.length;
}

let srv = null, lastDir = null;
// Поднять настоящий сервер на свежей копии БД (или взять уже поднятый — AUDIT_BASE + AUDIT_DB)
// setup(dbPath) — подготовка ДАННЫХ КОПИИ до старта (SQL в копии; боевая база и источник не затрагиваются)
export async function startServer(port, dir, { setup = null } = {}) {
  if (process.env.AUDIT_BASE) return { base: process.env.AUDIT_BASE, db: process.env.AUDIT_DB, external: true };
  if (port < 8370 || port > 8379) throw new Error("порты аудита — 8370–8379");
  await stopServer();
  lastDir = dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (setup) { execFileSync("sqlite3", [BASE_DB, `.backup '${dir}/work.db'`]); setup(`${dir}/work.db`); }
  const log = `${dir}/server.log`;
  srv = spawn(`${ROOT}/.venv/bin/python`, [`${ROOT}/scripts/real_auth_server.py`, BASE_DB, String(port), dir], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", (d) => { out += d; }); srv.stderr.on("data", (d) => { out += d; writeFileSync(log, out); });
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { db: `${dir}/work.db`, base: `http://127.0.0.1:${port}`, log }; } catch { /* ждём */ }
  }
  throw new Error("сервер не поднялся: " + out.slice(-500));
}
export async function stopServer() {
  if (srv) { try { srv.kill("SIGTERM"); } catch { /* уже остановлен */ } await sleep(600); try { srv.kill("SIGKILL"); } catch { /* */ } srv = null; }
  if (lastDir && !process.env.KEEP) { rmSync(lastDir, { recursive: true, force: true }); lastDir = null; }
}

export function sql(db, q) {
  const out = execFileSync("sqlite3", ["-json", db, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}
export const sql1 = (db, q) => { const r = sql(db, q); return r.length ? Object.values(r[0])[0] : null; };
export function exec(db, q) { execFileSync("sqlite3", [db, q]); }

// Браузер + вход НАСТОЯЩЕЙ формой V2; objectId — выбор объекта в шапке
export async function session(base, user = "admin", { objectId = 1, width = 1920, height = 1080, args = [] } = {}) {
  const b = await launch({ width, height, args });
  await b.goto(`${base}/v2`, 500);
  await b.waitFor(`!!document.querySelector('#v2-login-user') || !!document.querySelector('.v2-head')`, 20000);
  if (await b.eval(`!!document.querySelector('#v2-login-user')`)) {
    await b.clickSel("#v2-login-user"); await b.type(user);
    await b.clickSel("#v2-login-pass"); await b.type(PASS);
    await b.key("Enter");
  }
  await b.waitFor(`document.querySelector('#v2-object') || document.querySelector('.v2-note-page')`, 30000);
  if (objectId != null) await setObject(b, objectId);
  return b;
}
export async function setObject(b, objectId) {
  const ok = await b.eval(`(()=>{const s=document.querySelector('#v2-object'); if(!s) return false; if (s.value===String(${objectId})) return true; if(![...s.options].some(o=>o.value==='${objectId}')) return false; s.value='${objectId}'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(700);
  return ok;
}
export async function openScreen(b, id, waitExpr, timeout = 30000) {
  await b.eval(`location.hash='#/${id}'`);
  await b.waitFor(`location.hash==='#/${id}'`);
  if (waitExpr) await b.waitFor(waitExpr, timeout);
  await sleep(300);
}
// Щелчок настоящим событием по элементу, предварительно прокрутив его в видимую область
export async function tap(b, sel, o) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center',inline:'nearest'})`);
  await sleep(150);
  await b.clickSel(sel, o);
}
// Выбор значения в <select> с клавиатуры (фокус щелчком → стрелки нельзя надёжно; ставим значение и шлём change — как при выборе мышью)
export async function choose(b, sel, value) {
  await tap(b, sel);
  await b.eval(`(()=>{const s=document.querySelector(${JSON.stringify(sel)}); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(200);
}
export const writes = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET" && r.method !== "OPTIONS" && !/\/activity$/.test(r.url) && !/\/reports\//.test(r.url));
// Настоящая перезагрузка страницы (goto на тот же адрес с #… — переход внутри документа, страница НЕ перезагружается)
export async function reload(b) {
  b.send("Page.reload", { ignoreCache: true }).catch(() => {});
  await sleep(800);
  // несохранённый ввод на странице — браузер спросит «Покинуть страницу?»: отвечаем «да» (ввод и так проверяется отдельно)
  try { await b.send("Page.handleJavaScriptDialog", { accept: true }, 3000); } catch { /* диалога не было */ }
  await sleep(500);
  await b.waitFor(`document.readyState === 'complete'`, 30000);
  await sleep(500);
}
export const noPageScroll = (b) => b.eval(`document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1`);

// Вход в V1 в ТОЙ ЖЕ сессии (cookie общий) — для сверки чисел V2 с V1 на одном сервере
export async function openV1(b, base, objectId) {
  await b.goto(`${base}/`, 1500);
  await b.waitFor(`typeof state !== 'undefined' && state.objectId != null`, 30000);
  if (objectId != null) {
    await b.eval(`(async()=>{ if (state.objectId !== ${objectId}) await switchObject(${objectId}); })()`);
    await sleep(1500);
  }
}

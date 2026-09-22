// Вспомогательные функции для проверки оболочки V2 (задача «shell») на НАСТОЯЩЕМ backend, временная копия БД,
// настоящий вход формой, настоящие события мыши/клавиатуры (scripts/cdp.mjs). Тот же приём, что у
// scripts/picker_verify/lib.mjs (переиспользовать нельзя — там BASE_DB зашита константой на чужой сценарий),
// здесь — свой набор с источником БД, подготовленным prep_shell_case.py (≥300 объектов, 3 с данными).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const PASS = "Test-Pass-1234!";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return !!ok;
}
export function summary() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - bad.length} PASS / ${bad.length} FAIL из ${results.length}`);
  return bad.length;
}

let srv = null, lastDir = null;
/** sourceDb — уже подготовленная копия (prep_shell_case.py); real_auth_server.py сам снимает штатную копию
 * «перед стартом» sourceDb → dir/work.db (backup средствами sqlite, не наш rm/cp). */
export async function startServer(port, dir, sourceDb) {
  await stopServer();
  lastDir = dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const log = `${dir}/server.log`;
  srv = spawn(`${ROOT}/.venv/bin/python`, [`${ROOT}/scripts/real_auth_server.py`, sourceDb, String(port), dir], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  srv.stdout.on("data", (d) => { out += d; writeFileSync(log, out); });
  srv.stderr.on("data", (d) => { out += d; writeFileSync(log, out); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    if (out.includes("настоящий сервер:")) break;
    if (srv.exitCode !== null) throw new Error(`сервер не поднялся, лог:\n${out}`);
  }
  if (!out.includes("настоящий сервер:")) throw new Error(`сервер не ответил вовремя, лог:\n${out}`);
  return { base, dir, db: `${dir}/work.db` };
}
export async function stopServer() {
  if (srv) { try { srv.kill("SIGTERM"); } catch { /* уже остановлен */ } await sleep(400); try { srv.kill("SIGKILL"); } catch { /* */ } srv = null; }
  if (lastDir && !process.env.KEEP) { rmSync(lastDir, { recursive: true, force: true }); lastDir = null; }
}

export function sql(db, q) {
  const out = execFileSync("sqlite3", ["-json", db, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}
export const sql1 = (db, q) => { const r = sql(db, q); return r.length ? Object.values(r[0])[0] : null; };
export function exec(db, q) { execFileSync("sqlite3", [db, q]); }

export async function openBrowser(w = 1920, h = 1080) { return launch({ width: w, height: h }); }
export async function login(b, base, user) {
  await b.goto(`${base}/v2`, 500);
  await b.waitFor(`!!document.querySelector('#v2-login-user') || !!document.querySelector('.v2-head')`, 20000);
  if (await b.eval(`!!document.querySelector('#v2-login-user')`)) {
    await b.clickSel("#v2-login-user"); await b.type(user);
    await b.clickSel("#v2-login-pass"); await b.type(PASS);
    await b.key("Enter");
    await b.waitFor(`!!document.querySelector('.v2-head')`, 30000);
  }
  await sleep(400);
}
export const writes = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET" && r.method !== "OPTIONS" && !/\/activity$/.test(r.url));
export const path = (u) => new URL(u).pathname + new URL(u).search;

export async function typeInto(b, sel, text) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`);
  await b.clickSel(sel, { count: 3 });
  await b.key("a", { meta: true });
  if (text === "") { await b.key("Backspace"); return; }
  await b.type(text);
}

// Переход с полной перезагрузкой (проверка «состояние восстанавливается после перезагрузки»): подтверждает
// возможный диалог beforeunload протоколом (это НЕ проверка сторожа несохранённых данных — тот проверяется
// отдельно, реальным кликом «Остаться»/«Не сохранять»).
export async function hardGoto(b, url, wait = 1200) {
  b.send("Page.navigate", { url: "about:blank" }).catch(() => {});
  await sleep(400);
  try { await b.send("Page.handleJavaScriptDialog", { accept: true }); } catch { /* диалога не было */ }
  await sleep(200);
  await b.goto(url, wait);
}

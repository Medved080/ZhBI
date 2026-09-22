// Общие функции проверок области «charts» (графики отчётов, отбор фильтром схемы, график СМР — колонка/полный экран).
// Настоящий backend на ВРЕМЕННОЙ копии обезличенной БД (scripts/real_auth_server.py), настоящий вход формой V2,
// настоящие события мыши и клавиатуры (scripts/cdp.mjs). Порты 8270–8279. Копия — во временном каталоге сценария,
// в git не входит.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const SP = "/private/tmp/claude-501/-Users-max-zhbi-tool/788b45dd-b72e-49d3-ba64-2491a0ac0e5a/scratchpad";
export const BASE_DB = `${ROOT}/data/zhbi.anon.db`;
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
export async function startServer(port, dir, { fresh = true, setup = null } = {}) {
  await stopServer();
  lastDir = dir;
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = `${dir}/work.db`;
  if (setup && !existsSync(dbPath)) {
    execFileSync("sqlite3", [BASE_DB, `.backup '${dbPath}'`]);
    setup(dbPath);
  }
  const log = `${dir}/server.log`;
  srv = spawn(`${ROOT}/.venv/bin/python`, [`${ROOT}/scripts/real_auth_server.py`, BASE_DB, String(port), dir], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", (d) => { out += d; }); srv.stderr.on("data", (d) => { out += d; writeFileSync(log, out); });
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { db: dbPath, base: `http://127.0.0.1:${port}`, log }; } catch { /* ждём */ }
  }
  throw new Error("сервер не поднялся: " + out.slice(-500));
}
export async function stopServer() {
  if (srv) { try { srv.kill("SIGTERM"); } catch { /* уже остановлен */ } await sleep(500); try { srv.kill("SIGKILL"); } catch { /* */ } srv = null; }
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

export async function hardGoto(b, url, wait = 1200) {
  b.send("Page.navigate", { url: "about:blank" }).catch(() => {});
  await sleep(500);
  try { await b.send("Page.handleJavaScriptDialog", { accept: true }); } catch { /* диалога не было */ }
  await sleep(300);
  await b.goto(url, wait);
}

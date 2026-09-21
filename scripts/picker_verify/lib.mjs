// Общие функции проверок области «picker» (комплектовщик, контрагенты, договоры, спецификации, контракты, документы замены поставщика).
// Настоящий backend на ВРЕМЕННОЙ копии обезличенной БД (scripts/real_auth_server.py), настоящий вход формой V2, настоящие события мыши и клавиатуры
// (scripts/cdp.mjs), сверка БД до/после прямым SQL по копии. Порты 8130–8139. Копия и логи — в каталоге сценария, в git не входят.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const SP = "/private/tmp/claude-501/-Users-max-zhbi-tool/fb1df937-b060-4b0c-8d96-fc3a39879326/scratchpad";
export const BASE_DB = `${SP}/guard_base.db`;
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

// ---- сервер на временной копии ----
let srv = null;
export async function startServer(port, dir, { fresh = true, setup = null } = {}) {
  await stopServer();
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = `${dir}/work.db`;
  if (setup && !existsSync(dbPath)) {
    // подготовка копии (роли/права) — ДО запуска приложения: прямой SQL по КОПИИ
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
}

// ---- SQL по копии ----
export function sql(db, q) {
  const out = execFileSync("sqlite3", ["-json", db, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}
export const sql1 = (db, q) => { const r = sql(db, q); return r.length ? Object.values(r[0])[0] : null; };
export function exec(db, q) { execFileSync("sqlite3", [db, q]); }

// Отпечаток таблиц (число строк + хэш содержимого) — для «нет побочных изменений»
export function fingerprint(db, tables) {
  const fp = {};
  for (const t of tables) {
    const cols = sql(db, `PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => !["updated_at"].includes(c));
    const expr = cols.map((c) => `COALESCE(CAST("${c}" AS TEXT),'~')`).join("||'|'||");
    const rows = sql(db, `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(${expr})),0) AS len, COALESCE(SUM(UNICODE(SUBSTR(${expr},1,1))*7 + LENGTH(${expr})*13),0) AS h FROM ${t}`);
    fp[t] = JSON.stringify(rows[0]);
  }
  return fp;
}
export function diffFp(a, b) { return Object.keys(a).filter((t) => a[t] !== b[t]); }

// ---- браузер и вход ----
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
export async function logout(b, base) { await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`).catch(() => {}); }
// Запросы, ушедшие на сервер (метод + путь), по накопленному журналу браузера
export const writes = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET" && r.method !== "OPTIONS" && !/\/activity$/.test(r.url));
export const path = (u) => new URL(u).pathname + new URL(u).search;
// Клик по кнопке с текстом внутри области (реальное событие мыши по центру)
export async function clickText(b, text, scope = "document") {
  const r = await b.eval(`(()=>{const s=${scope};const els=[...s.querySelectorAll('button,a,summary,[role=button],label')].filter(e=>e.offsetParent&&e.textContent.trim().replace(/\\s+/g,' ')===${JSON.stringify(text)}||false);const e=els[0];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!r) throw new Error("нет кнопки «" + text + "»");
  await b.click(r.x, r.y);
}
// Ввод текста в поле по селектору: реальный щелчок, выделить всё, набрать
export async function typeInto(b, sel, text) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`);
  await b.clickSel(sel, { count: 3 });
  await b.key("a", { meta: true });
  if (text === "") { await b.key("Backspace"); return; }
  await b.type(text);
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.dispatchEvent(new Event('change',{bubbles:true}))`);
}

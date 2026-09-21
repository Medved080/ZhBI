// Общие функции проверок области «admin» на НАСТОЯЩЕМ сервере с настоящим входом (scripts/real_auth_server.py, копия обезличенной БД).
// Браузер — scripts/cdp.mjs (настоящие события мыши и клавиатуры). Никаких подмен авторизации: вход формой V2 или POST /login.
//
//   import { session, sql, http, ok, summary } from "./verify_admin_lib.mjs";
import { launch } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

export const PASSWORD = "Test-Pass-1234!"; // пароль ТЕСТОВЫХ пользователей копии (печатается при старте real_auth_server.py)
export const results = [];

export function ok(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  return !!cond;
}
export function summary() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\nИТОГО: ${results.length - bad.length} из ${results.length}` + (bad.length ? `; провалы: ${bad.map((b) => b.name).join(" | ")}` : ""));
  return bad.length;
}

/** SQL к КОПИИ БД (только чтение из скрипта проверки; запись — только точечная подготовка на копии). */
export function sql(db, query) {
  const out = execFileSync("sqlite3", ["-json", db, query], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
  return out ? JSON.parse(out) : [];
}
export function sqlExec(db, query) { execFileSync("sqlite3", [db, query], { encoding: "utf8" }); }

/** HTTP от имени вошедшего пользователя (настоящий POST /login, cookie сохраняется). */
export async function http(base, login, password = PASSWORD) {
  const jar = {};
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar.c ? { Cookie: jar.c } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) jar.c = sc.map((x) => x.split(";")[0]).join("; ");
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  const r = await call("POST", "/login", { domain_login: login, password });
  if (r.status !== 200) throw new Error(`вход ${login}: ${r.status} ${JSON.stringify(r.data)}`);
  return { call, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: (p) => call("DELETE", p), me: r.data, jar };
}

/** Сеанс браузера: запуск, вход настоящей формой V2. */
export async function session(base, login, { width = 1920, height = 1080, password = PASSWORD, shotDir } = {}) {
  const b = await launch({ width, height });
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  await b.goto(base + "/v2", 600);
  await b.waitFor("!!document.querySelector('#v2-login-user')");
  await b.clickSel("#v2-login-user"); await b.type(login);
  await b.clickSel("#v2-login-pass"); await b.type(password);
  await b.clickSel("#v2-login-form button[type=submit]");
  await b.waitFor("!!document.querySelector('#v2-side') || !!document.querySelector('#v2-pwd-form')", 20000);
  return b;
}
export const text = (b, sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
export const exists = (b, sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
export async function openSection(b, id) {
  await b.eval(`location.hash='#/${id}'`);
  await b.sleep(500);
}
export const writes = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET");

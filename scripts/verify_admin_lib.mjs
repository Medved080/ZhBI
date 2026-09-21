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
  // Проверки других разделов могут завершить сеансы этого клиента (например, «завершить все, кроме моего»): один раз входим заново настоящим POST /login.
  const relogin = async (method, path, body) => {
    let res = await call(method, path, body);
    if (res.status === 401 && path !== "/login") { const l = await call("POST", "/login", { domain_login: login, password }); if (l.status === 200) res = await call(method, path, body); }
    return res;
  };
  return { raw: call, call: relogin, get: (p) => relogin("GET", p), post: (p, b) => relogin("POST", p, b ?? {}), put: (p, b) => relogin("PUT", p, b), patch: (p, b) => relogin("PATCH", p, b), del: (p) => relogin("DELETE", p), me: r.data, jar };
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
  await b.waitFor("!!document.querySelector('#v2-side') || !!document.querySelector('#pw-form')", 20000);
  return b;
}
export const text = (b, sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
export const exists = (b, sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
export async function openSection(b, id) {
  await b.eval(`location.hash='#/${id}'`);
  await b.sleep(500);
}
export const writes = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET");

/** Заполнить поле настоящим вводом: тройной щелчок выделяет содержимое, затем вставка текста (события input). */
export async function fill(b, sel, value) {
  await b.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`);
  await b.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
  const r = await b.rect(sel);
  await b.click(r.cx, r.cy, { count: 3 });
  if (value === "") { await b.key("Backspace"); return; }
  await b.type(value);
}
/** Щелчок по кнопке/ссылке с точным текстом внутри контейнера (настоящее событие мыши в центре элемента). */
export async function clickText(b, text, scope = "body") {
  const pos = await b.eval(`(()=>{const root=document.querySelector(${JSON.stringify(scope)})||document.body;const els=[...root.querySelectorAll('button,a,[role=button]')].filter(e=>e.offsetParent!==null&&!e.disabled&&(e.innerText||'').trim()===${JSON.stringify(text)});const e=els[0];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!pos) throw new Error(`нет кнопки «${text}»`);
  await b.click(pos.x, pos.y);
}
export const visibleText = (b) => b.eval("document.body.innerText");

/** Щелчок по элементу (селектор): сначала прокрутить в видимую область, затем настоящее событие мыши в его центре. */
export async function click(b, sel, opts) {
  await b.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`);
  await b.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
  await b.sleep(60);
  const r = await b.rect(sel);
  await b.click(r.cx, r.cy, opts);
}

/** Настоящая перезагрузка страницы (тот же адрес, тот же сеанс): проверяет, что результат операции живёт на сервере, а не в памяти вкладки. */
export async function reload(b, wait = 900) {
  await b.send("Page.reload", {});
  await b.sleep(400);
  for (let i = 0; i < 100; i++) { try { if ((await b.eval("document.readyState")) === "complete") break; } catch (e) { /* страница ещё грузится */ } await b.sleep(100); }
  await b.sleep(wait);
}

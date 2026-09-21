import { launch } from "../../cdp.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const BASE = `http://127.0.0.1:${process.env.V2_EX_PORT || 8150}`;
// Рабочий каталог проверок: копия БД сервера, файлы, скриншоты (V2_EX_WORK); сервер — scripts/real_auth_server.py на порту V2_EX_PORT (по умолчанию 8150)
export const SP = process.env.V2_EX_WORK || "/tmp/v2_exchange";
const HELP = dirname(fileURLToPath(import.meta.url));   // каталог вспомогательных python-скриптов (рядом)
export const ROOT = resolve(HELP, "../../..");
export const EX = SP + "/ex";   // файлы проверок (создаются сценариями и вспомогательными скриптами)
export async function open(user = "admin", { width = 1920, height = 1080 } = {}) {
  const b = await launch({ width, height });
  await b.goto(BASE + "/v2");
  await b.eval(`fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({domain_login:${JSON.stringify(user)},password:"Test-Pass-1234!"})}).then(r=>r.status)`);
  await b.goto(BASE + "/v2");
  await b.waitFor(`document.querySelector('#v2-side button[data-section]')`, 20000);
  return b;
}
export async function screen(b, id) {
  await b.eval(`location.hash = "#/${id}"`);
  await b.waitFor(`document.querySelector('#v2-content h2') && document.title.includes(${JSON.stringify(id)}) || document.querySelector('#v2-content h2')`, 10000);
  await b.sleep(400);
}
// выбрать файл в <input type=file> настоящим протоколом DevTools
export async function setFile(b, selector, path) {
  const doc = await b.send("DOM.getDocument", { depth: -1 });
  const q = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) throw new Error("нет поля " + selector);
  await b.send("DOM.setFileInputFiles", { files: [path], nodeId: q.nodeId });
  await b.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event("change",{bubbles:true}))`);
}
export const text = (b, sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||""`);
import { execFileSync } from "node:child_process";
const PY = process.env.V2_EX_PY || resolve(ROOT, ".venv/bin/python");
export const dbq = (...a) => execFileSync(PY, ["-W", "ignore", HELP + "/dbq.py", ...a], { encoding: "utf8" }).trim();
export const snap = () => JSON.parse(dbq("snap"));
export const sql = (q) => JSON.parse(dbq("sql", q));
export const maxid = () => Number(dbq("maxid"));
export const journal = (action, since) => JSON.parse(dbq("journal", action || "-", String(since ?? 0)));
export const changed = (a, b) => Object.keys(b).filter((t) => JSON.stringify(a[t]) !== JSON.stringify(b[t]));
let OKN = 0; export const FAILS = [];
export function chk(cond, msg) { if (cond) { OKN++; console.log("  ok  ", msg); } else { FAILS.push(msg); console.log("  FAIL", msg); } }
export const summary = () => { console.log(`\nПроверок пройдено: ${OKN}, не пройдено: ${FAILS.length}`); FAILS.forEach((f) => console.log("  НЕ ПРОЙДЕНО:", f)); };
export const posts = (b, sub) => b.requests.filter((r) => r.method === "POST" && r.url.includes(sub));
// настоящая перезагрузка страницы (goto на тот же адрес с другим #хешем документ не перезагружает)
export async function reload(b, hash) {
  // страница с несохранённой сверкой честно спрашивает «Уйти?» (beforeunload) — в проверке подтверждаем уход
  const nav = b.goto(BASE + "/?ui=v1"); // уходим с /v2, затем открываем нужный экран заново
  for (let i = 0; i < 8; i++) { await b.sleep(200); try { await b.send("Page.handleJavaScriptDialog", { accept: true }); } catch {} }
  await nav;
  await b.goto(BASE + "/v2" + (hash || ""));
  await b.waitFor(`document.querySelector('#v2-side button[data-section]')`, 20000);
  await b.sleep(500);
}
export function mkxlsx(name, header, rows, title = "Лист1") {
  execFileSync(PY, ["-W", "ignore", HELP + "/mkxlsx.py", EX + "/" + name, JSON.stringify(header), JSON.stringify(rows), title]);
  return EX + "/" + name;
}
export const TAG = String(Date.now()).slice(-6);
export const CONTRACT_HEAD = ["Покупатель", "Поставщик", "Договор поставки", "Спецификация", "Наименование товара", "Кол-во"];
export function mkbulk(kind, out, tag = TAG) {
  return JSON.parse(execFileSync(PY, ["-W", "ignore", HELP + "/mkbulk.py", kind, EX + "/" + out, tag], { encoding: "utf8" }).trim().split("\n").pop());
}
// щелчок по элементу с прокруткой в видимую область (панель страницы прокручивается внутри)
export async function clk(b, sel) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:"center"})`);
  await b.sleep(120);
  await b.clickSel(sel);
}

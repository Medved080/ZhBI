// Общие функции проверок аудита «настройки/справочники/служебные» (feature/v2-audit-set) — поверх verify_admin_lib.mjs.
// Настоящий сервер (scripts/real_auth_server.py, копия обезличенной БД), настоящий вход, настоящие события мыши/клавиатуры (cdp.mjs).
//   node scripts/audit_set/<проверка>.mjs <путь к копии БД> <порт>
export * from "../verify_admin_lib.mjs";
import { http, summary, PASSWORD } from "../verify_admin_lib.mjs";
import { launch } from "../cdp.mjs";

// Программный WebGL (swiftshader) — для 3D (сцена V1 в кадре, предпросмотр зоны): без него безголовый Chrome WebGL не даёт.
export const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
/** Вход настоящей формой V2 (как session() в verify_admin_lib.mjs) + программный WebGL. */
async function baseSession(base, login, { width = 1920, height = 1080, password = PASSWORD } = {}) {
  const b = await launch({ width, height, args: GL_ARGS });
  await b.goto(base + "/v2", 600);
  await b.waitFor("!!document.querySelector('#v2-login-user')");
  await b.clickSel("#v2-login-user"); await b.type(login);
  await b.clickSel("#v2-login-pass"); await b.type(password);
  await b.clickSel("#v2-login-form button[type=submit]");
  await b.waitFor("!!document.querySelector('#v2-side') || !!document.querySelector('#pw-form')", 20000);
  return b;
}

// Все запущенные браузеры закрываются и при падении проверки — иначе безголовый Chrome остаётся сиротой.
const open = new Set();
export async function session(...a) {
  const b = await baseSession(...a);
  const close = b.close.bind(b);
  b.close = async () => { open.delete(b); await close(); };
  open.add(b);
  return b;
}
const bailHooks = [];
/** Действие при падении проверки (возврат исходных значений в КОПИИ БД, чтобы следующий прогон начинался с того же состояния). */
export const onBail = (fn) => bailHooks.push(fn);
async function bail(e) {
  console.log("СБОЙ ПРОВЕРКИ: " + (e?.stack || e));
  let n = 0;
  for (const b of [...open]) {
    try { if (process.env.AUDIT_SHOTS) await b.shot(`${process.env.AUDIT_SHOTS}/bail-${n++}.png`); console.log("   страница: " + String(await b.eval("location.hash + ' | ' + document.body.innerText.slice(0, 400)")).replace(/\n/g, " ")); } catch (x) { /* страница недоступна */ }
    try { await b.close(); } catch (x) { /* уже закрыт */ }
  }
  for (const fn of bailHooks) { try { await fn(); } catch (x) { console.log("   возврат не удался: " + x); } }
  summary();
  process.exit(2);
}
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

export const DB = process.argv[2];
export const PORT = Number(process.argv[3] || 8360);
export const BASE = `http://127.0.0.1:${PORT}`;
export const SHOTS = process.env.AUDIT_SHOTS || "";

/** Выбрать объект в шапке V2 (скрытый совместимый select, тот же путь changeObject, что и у окна выбора объекта). */
export async function setObject(b, id) {
  await b.waitFor("!!document.querySelector('#v2-object')");
  await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value=${JSON.stringify(String(id))};s.dispatchEvent(new Event('change'))})()`);
  await b.sleep(900);
}

/** Выражение В ГЛОБАЛЬНОЙ области кадра сцены рабочего места V2 (iframe из srcdoc, тот же origin; видны let/const app.js).
 *  Через DevTools: документ кадра → объект в его основном мире → Runtime.callFunctionOn (CSP страницы запрещает eval из кода). */
export async function frameEval(b, expr) {
  const { root } = await b.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await b.send("DOM.querySelector", { nodeId: root.nodeId, selector: "iframe.ws-frame" });
  if (!nodeId) return null;
  const { node } = await b.send("DOM.describeNode", { nodeId, depth: 1, pierce: true });
  const doc = node.contentDocument;
  if (!doc) return null;
  const { object } = await b.send("DOM.resolveNode", { backendNodeId: doc.backendNodeId });
  const r = await b.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: `function(){ return (${expr}); }`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

/** Дождаться, пока сцена в кадре загрузит данные (снимок моста: loaded). */
export async function waitScene(b, timeout = 60000) {
  await b.waitFor(`(()=>{const f=document.querySelector('iframe.ws-frame');return !!(f&&f.style.visibility==='visible')})()`, timeout, 300);
  await b.sleep(800);
}

/** Горизонтальная прокрутка страницы/контейнера раздела (переполнение вёрстки). */
export const overflowX = (b) => b.eval(`(()=>{const d=document.documentElement;const c=document.querySelector('#v2-content')||document.body;return Math.max(d.scrollWidth-d.clientWidth, c.scrollWidth-c.clientWidth)})()`);

/** HTTP-клиенты разных ролей (настоящий POST /login). */
export const as = (login) => http(BASE, login);

/** Разнообразие пикселей области экрана (настоящий снимок страницы через DevTools, разбор PNG в самой странице):
 *  число различных цветов (грубо квантованных) — WebGL-холст без preserveDrawingBuffer toDataURL не читается. */
export async function regionColors(b, sel) {
  const r = await b.rect(sel);
  if (!r) return 0;
  const shot = await b.send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  return b.eval(`new Promise((res)=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);const d=x.getImageData(0,0,c.width,c.height).data;const s=new Set();for(let k=0;k<d.length;k+=16)s.add((d[k]>>4)<<8|(d[k+1]>>4)<<4|(d[k+2]>>4));res(s.size)};i.onerror=()=>res(-1);i.src='data:image/png;base64,${shot.data}'})`);
}

/** Дождаться конца записи оболочки V2 (пока идёт запись, переход между разделами отклоняется — main.js, syncPending). */
export async function idle(b, timeout = 30000) {
  await b.waitFor(`!((document.getElementById('v2-nav-note')||{}).textContent||'').includes('Идёт сохранение')`, timeout, 150);
  await b.sleep(150);
}
/** Переход в раздел после конца записи + проверка, что переход состоялся. */
export async function go(b, id) {
  await idle(b);
  await b.eval(`location.hash='#/${id}'`);
  await b.waitFor(`location.hash==='#/${id}'`, 5000).catch(() => {});
  await b.sleep(600);
}

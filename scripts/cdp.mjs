// Управление безголовым Chrome по протоколу DevTools с НАСТОЯЩИМИ событиями мыши и клавиатуры
// (Input.dispatchMouseEvent / dispatchKeyEvent) — для проверки жестов: щелчок, рамка, колесо, перетаскивание.
// Не зависит от npm-пакетов (WebSocket встроен в Node ≥ 22). Профиль браузера — временный.
//
//   import { launch } from "./cdp.mjs";
//   const b = await launch({ width: 1920, height: 1080 });
//   await b.goto("http://127.0.0.1:8090/v2"); await b.click(100, 200); await b.drag(x1, y1, x2, y2, { shift: true });
//   const v = await b.eval("document.title"); await b.shot("/tmp/a.png"); await b.close();
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1920, height = 1080, dpr = 1, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cdp-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${dir}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank", ...args], { stdio: "ignore" });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error("Chrome не запустился"); }
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WebSocket DevTools")); });
  let id = 0;
  const pending = new Map();
  const consoleLog = [], exceptions = [], requests = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") consoleLog.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === "Network.requestWillBeSent") requests.push({ id: m.params.requestId, method: m.params.request.method, url: m.params.request.url, body: m.params.request.postData });
    else if (m.method === "Network.responseReceived") { const r = requests.find((x) => x.id === m.params.requestId); if (r) r.status = m.params.response.status; }
    else if (m.method === "Network.loadingFailed") { const r = requests.find((x) => x.id === m.params.requestId); if (r) r.status = 0; }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  const mods = (o) => (o?.shift ? 8 : 0) | (o?.ctrl ? 2 : 0) | (o?.alt ? 1 : 0) | (o?.meta ? 4 : 0);
  const api = {
    consoleLog, exceptions, requests, send,
    async goto(url, wait = 400) { await send("Page.navigate", { url }); for (let i = 0; i < 100; i++) { await sleep(100); if ((await api.eval("document.readyState")) === "complete") break; } await sleep(wait); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 15000, every = 150) {
      const t0 = Date.now();
      for (;;) { let v; try { v = await api.eval(expr); } catch { v = false; } if (v) return v; if (Date.now() - t0 > timeout) throw new Error("ожидание истекло: " + expr.slice(0, 120)); await sleep(every); }
    },
    async rect(sel) { return api.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`); },
    async move(x, y, o) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: mods(o), button: "none" }); },
    async click(x, y, o = {}) {
      await api.move(x, y, o);
      for (let n = 1; n <= (o.count || 1); n++) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: n, modifiers: mods(o) });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: n, modifiers: mods(o) });
      }
    },
    async clickSel(sel, o) { const r = await api.rect(sel); if (!r) throw new Error("нет элемента " + sel); await api.click(r.cx, r.cy, o); },
    async drag(x1, y1, x2, y2, o = {}) {
      const steps = o.steps || 12;
      await api.move(x1, y1, o);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1, modifiers: mods(o) });
      for (let i = 1; i <= steps; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: "left", buttons: 1, modifiers: mods(o) });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1, modifiers: mods(o) });
    },
    async wheel(x, y, dy, o) { await api.move(x, y, o); await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, modifiers: mods(o) }); },
    async type(text) { await send("Input.insertText", { text }); },
    async key(key, o = {}) {
      const code = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }[key];
      const base = { key, windowsVirtualKeyCode: code, modifiers: mods(o), ...(key === "Enter" ? { text: "\r" } : {}) };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base }); await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async viewport(w, h) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false }); },
    async offline(on) { await send("Network.emulateNetworkConditions", { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
    async shot(path) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path, Buffer.from(r.data, "base64")); return path; },
    sleep,
    async close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); await sleep(200); try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
  return api;
}

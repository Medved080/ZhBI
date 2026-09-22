// Общие функции проверок области «reports2» («Статус комплектации» — сводная таблица в V2; «График контрактации и
// поставки» — фильтр схемы на сервере и в V2). Сервер, копия БД, вход и учёт результатов — те же, что у «charts»
// (scripts/charts_verify/lib.mjs: настоящий app.main:app на ВРЕМЕННОЙ копии обезличенной БД, настоящий вход).
// Порты области — 8340–8349.
export * from "../charts_verify/lib.mjs";
import { sleep, PASS } from "../charts_verify/lib.mjs";

// Вход по HTTP (для проверок сервера без браузера): cookie сеанса из ответа POST /login.
export async function httpLogin(base, user) {
  const r = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: PASS }) });
  if (!r.ok) throw new Error(`вход ${user}: ${r.status}`);
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get("set-cookie")]).map((c) => String(c).split(";")[0]).join("; ");
  return {
    async post(path, body) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
      return { status: res.status, json, text, type: res.headers.get("content-type") };
    },
  };
}

// Настоящий ввод с клавиатуры одного символа (keyDown/char/keyUp): закрытый <select> в фокусе выбирает вариант по
// первой букве — так выбирается значение без программной подмены (в безголовом Chrome на macOS стрелки у закрытого
// списка значение не меняют, а всплывающий список недоступен для событий мыши).
export async function typeChar(b, ch) {
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
  await b.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
}

// Выбрать вариант <select> настроек отчёта V2: НАСТОЯЩИЙ щелчок мышью по подписи поля (активация <label> ставит фокус
// в его список, не раскрывая всплывающее меню) и ввод первой буквы варианта.
export async function chooseByLabel(b, fieldLabel, firstLetter) {
  const r = await b.eval(`(()=>{const l=[...document.querySelectorAll('.v2-report-controls label.v2-wire-field')].find(x=>x.querySelector('span')?.textContent.trim()===${JSON.stringify(fieldLabel)}); if(!l) return null; l.scrollIntoView({block:'center'}); const s=l.querySelector('span').getBoundingClientRect(); return {x:s.x+s.width/2,y:s.y+s.height/2};})()`);
  if (!r) throw new Error(`нет поля «${fieldLabel}»`);
  await b.click(r.x, r.y);
  await sleep(120);
  const focused = await b.eval(`document.activeElement?.tagName === 'SELECT'`);
  if (!focused) throw new Error(`щелчок по подписи «${fieldLabel}» не поставил фокус в список`);
  await typeChar(b, firstLetter);
  await sleep(150);
}

// Щелчок НАСТОЯЩЕЙ мышью по элементу (с прокруткой в видимую часть его области).
export async function clickEl(b, jsExpr) {
  const r = await b.eval(`(()=>{const e=${jsExpr}; if(!e) return null; e.scrollIntoView({block:'center',inline:'nearest'}); const q=e.getBoundingClientRect(); return {x:q.x+q.width/2,y:q.y+q.height/2};})()`);
  if (!r) throw new Error("нет элемента: " + jsExpr.slice(0, 120));
  await sleep(80);
  await b.click(r.x, r.y);
}

// Тело ответа запроса, пойманного браузером (DevTools Network.getResponseBody) — числа, которые реально получил экран.
// Заголовки ответа приходят раньше тела — пока тело не догружено, DevTools отвечает ошибкой, поэтому повтор с паузой.
export async function responseJson(b, req) {
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await b.send("Network.getResponseBody", { requestId: req.id });
      return JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body);
    } catch (e) { last = e; await sleep(250); }
  }
  throw last;
}

// Дождаться завершения запроса к адресу (по регулярному выражению), начиная с позиции from в журнале запросов.
export async function waitReq(b, re, from = 0, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = b.requests.slice(from).find((x) => re.test(x.url) && x.status !== undefined);
    if (r) return r;
    if (Date.now() - t0 > timeout) throw new Error("не дождались запроса " + re);
    await sleep(100);
  }
}

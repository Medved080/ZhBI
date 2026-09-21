// Помощники сценариев стенда V2. Каждый сценарий получает СВОЙ iframe с
// настоящим V2 и своим фейковым бэкендом — состояние модулей (main.js,
// api.js, dialogs.js) между сценариями не течёт.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 4000, step = 20, what = "условие" } = {}) {
  const t0 = performance.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`Не дождались: ${what} (${timeout} мс)`);
    await sleep(step);
  }
}

const createdApps = [];

export async function openApp({ perm, session, w = 1366, h = 768, query = "", home = false } = {}) {
  const q = new URLSearchParams(query);
  // sessionStorage общее у всех iframe одного источника: выбранный в шапке объект и свёрнутые группы навигации из
  // предыдущего сценария не должны влиять на следующий
  try { sessionStorage.removeItem("v2.objectId"); sessionStorage.removeItem("v2.navCollapsed"); } catch (e) { /* нет доступа — не страшно */ }
  if (perm) q.set("perm", perm);
  if (session === false) q.set("session", "0");
  // Загрузка стенда — инфраструктура, не продукт: при редком зависании страницы
  // (нагрузка на машину) — один повтор с чистым iframe, а не ложный провал сценария.
  let iframe = null;
  for (let attempt = 1; ; attempt++) {
    iframe = document.createElement("iframe");
    iframe.style.cssText = `width:${w}px;height:${h}px;border:1px solid #bbb;background:#fff`;
    iframe.src = `/tests/app.html?${q}`;
    document.getElementById("frames").append(iframe);
    try {
      await waitFor(() => iframe.contentDocument?.documentElement?.dataset.harness === "ready", { what: "загрузка стенда", timeout: 20000 });
      break;
    } catch (e) {
      iframe.remove();
      if (attempt >= 2) throw e;
    }
  }
  // Сценарии выгрузки файлов создают ссылку с атрибутом download и «кликают» её: без подмены браузер РЕАЛЬНО сохранил бы
  // файл в «Загрузки» (macOS спрашивает разрешение на каждое сохранение). Подменяем click() у ссылок с download на запись
  // в win.__downloads — сам вызов и имя файла остаются проверяемыми, на диск ничего не пишется.
  try {
    const w = iframe.contentWindow;
    const origClick = w.HTMLAnchorElement.prototype.click;
    w.__downloads = [];
    w.HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute("download")) { w.__downloads.push({ name: this.download, href: this.href }); return; }
      return origClick.call(this);
    };
  } catch (e) { /* iframe чужого источника не бывает; но сценарий не должен падать из-за подмены */ }
  const app = makeApp(iframe.contentWindow, iframe.contentDocument, iframe.contentWindow.__fake, iframe);
  // Любая необработанная ошибка страницы во время сценария — провал сценария.
  app.errors = iframe.contentWindow.__errors; // собирает boot.js с начала загрузки
  createdApps.push(app);
  // Оболочка полного интерфейса открывается на начальной странице. Сценарии трёх перенесённых разделов написаны в
  // расчёте на «открыт первый доступный раздел» (как было до полного интерфейса) — воспроизводим это явным кликом
  // по навигации. Сценарии самой оболочки просят `home: true` и работают с начальной страницей.
  if (!home && session !== false) {
    try {
      await waitFor(() => app.$(".v2-shellnav, .v2-note-page, input[type=password]"), { what: "оболочка", timeout: 8000 });
      const first = ["users-access", "projects-objects", "counterparties"].map((k) => app.$(`.v2-shellnav [data-section="${k}"]`)).find(Boolean);
      if (first) {
        first.click();
        await waitFor(() => first.getAttribute("aria-pressed") === "true" || app.$(`.v2-shellnav [data-section="${first.dataset.section}"]`)?.getAttribute("aria-pressed") === "true", { what: "первый раздел открыт", timeout: 8000 });
      }
    } catch (e) { /* сценарий сам сообщит о том, чего не дождался */ }
  }
  return app;
}

// Помощники поверх ЛЮБОГО окна со стендом: iframe сценария или сама страница
// (сцены для снимков, boot.js ?scene=).
export function makeApp(win, doc, ctl, iframe = null) {
  const app = {
    win, doc, ctl, iframe,
    $: (sel, root = doc) => root.querySelector(sel),
    $$: (sel, root = doc) => [...root.querySelectorAll(sel)],
    // Элемент по видимому тексту (подстрока, без учёта пробелов по краям)
    byText(sel, text, root = doc) {
      return [...root.querySelectorAll(sel)].find((el) => el.textContent.replace(/\s+/g, " ").trim().includes(text)) || null;
    },
    visible(el) { return !!el && !el.hidden && el.getClientRects().length > 0; },
    // Настоящий клик пользователя не срабатывает на заблокированном элементе —
    // возвращаем false, чтобы сценарий мог утверждать «клик невозможен».
    click(el) {
      if (!el) throw new Error("click: элемента нет");
      if (el.disabled) return false;
      el.click();
      return true;
    },
    async settle(ms = 30) { await sleep(ms); },
    waitFor: (fn, opts) => waitFor(fn, opts),
    // Ввод «с клавиатуры»: по символу, keydown → input → keyup, вставка в
    // позицию каретки/выделения; после КАЖДОГО символа возвращается фокус
    // элемента — так виден дефект «поле пересоздали и оно потеряло фокус».
    async type(el, text, { clear = false } = {}) {
      el.focus();
      if (clear) { el.value = ""; el.dispatchEvent(new win.Event("input", { bubbles: true })); }
      const lost = [];
      for (const ch of text) {
        if (doc.activeElement !== el) { lost.push(ch); el.focus?.(); }
        el.dispatchEvent(new win.KeyboardEvent("keydown", { key: ch, bubbles: true }));
        const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + ch + el.value.slice(end);
        try { el.setSelectionRange(start + 1, start + 1); } catch (e) { /* type=date и т.п. */ }
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        el.dispatchEvent(new win.KeyboardEvent("keyup", { key: ch, bubbles: true }));
        await sleep(0);
      }
      return { lostFocusAt: lost, stillFocused: doc.activeElement === el };
    },
    // Backspace n раз от текущей каретки (с проверкой, что поле сохранило фокус).
    async backspace(el, n = 1) {
      el.focus();
      const lost = [];
      for (let i = 0; i < n; i++) {
        if (doc.activeElement !== el) { lost.push(i); el.focus?.(); }
        el.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
        const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
        const from = start === end ? Math.max(0, start - 1) : start;
        el.value = el.value.slice(0, from) + el.value.slice(end);
        try { el.setSelectionRange(from, from); } catch (e) { /* не текстовое поле */ }
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        await sleep(0);
      }
      return { lostFocusAt: lost, stillFocused: doc.activeElement === el };
    },
    select(el, start, end = start) { el.focus(); el.setSelectionRange(start, end); },
    setValue(el, value, evt = "change") {
      el.value = value;
      el.dispatchEvent(new win.Event(evt === "change" ? "input" : evt, { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    key(el, key, opts = {}) {
      el.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
      el.dispatchEvent(new win.KeyboardEvent("keyup", { key, bubbles: true, ...opts }));
    },
    dialog() { return doc.querySelector(".v2-dialog"); },
    async answerDialog(label) {
      const d = await waitFor(() => doc.querySelector(".v2-dialog"), { what: "диалог" });
      const b = [...d.querySelectorAll("button")].find((x) => x.textContent.trim() === label);
      if (!b) throw new Error(`В диалоге нет кнопки «${label}»: ${[...d.querySelectorAll("button")].map((x) => x.textContent.trim())}`);
      b.click();
      await sleep(20);
    },
    close() { iframe?.remove(); },
  };
  return app;
}

export class T {
  constructor() { this.checks = []; }
  ok(cond, msg) { this.checks.push({ ok: !!cond, msg }); return !!cond; }
  eq(a, b, msg) { const ok = JSON.stringify(a) === JSON.stringify(b); this.checks.push({ ok, msg: ok ? msg : `${msg} — ожидали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}` }); return ok; }
  has(text, sub, msg) { const ok = String(text).includes(sub); this.checks.push({ ok, msg: ok ? msg : `${msg} — нет «${sub}» в «${String(text).slice(0, 160)}»` }); return ok; }
  notHas(text, sub, msg) { const ok = !String(text).includes(sub); this.checks.push({ ok, msg: ok ? msg : `${msg} — найдено «${sub}»` }); return ok; }
}

export async function runTests(tests, { onResult } = {}) {
  const results = [];
  for (const test of tests) {
    const t = new T();
    const r = { id: test.id, title: test.title, status: "pass", checks: t.checks, error: null };
    createdApps.length = 0;
    try { await test.run(t); } catch (e) { r.status = "fail"; r.error = String(e && e.stack || e); }
    // страховка: необработанные ошибки страницы (кроме заведомо ожидаемых сценарием)
    const expected = test.allowErrors || [];
    for (const a of createdApps) {
      const bad = (a.errors || []).filter((m) => !expected.some((x) => m.includes(x)));
      if (bad.length) t.ok(false, `необработанные ошибки страницы: ${[...new Set(bad)].slice(0, 3).join(" | ")}`);
    }
    // Учёт ВСЕХ изменяющих запросов, которые интерфейс реально отправил за прогон: по нему сверяется политика ограниченного
    // выпуска (`scripts/check_write_policy_coverage.mjs`) — путь операции в политике не должен расходиться с настоящим.
    for (const a of createdApps) for (const e of (a.ctl?.log || [])) {
      if (e.method !== "GET" && !/^\/reports\//.test(e.path)) (window.__writeSeen ||= new Map()).set(`${e.method} ${e.path.split("?")[0]}`, JSON.stringify(e.body ?? null));
    }
    if (t.checks.some((c) => !c.ok)) r.status = "fail";
    if (!t.checks.length && !r.error) { r.status = "fail"; r.error = "сценарий не сделал ни одной проверки"; }
    results.push(r);
    onResult?.(r);
    document.getElementById("frames").innerHTML = ""; // изоляция: следующий сценарий с чистого листа
  }
  return results;
}

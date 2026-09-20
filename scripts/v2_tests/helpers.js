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

export async function openApp({ perm, session, w = 1366, h = 768, query = "" } = {}) {
  const q = new URLSearchParams(query);
  if (perm) q.set("perm", perm);
  if (session === false) q.set("session", "0");
  const iframe = document.createElement("iframe");
  iframe.style.cssText = `width:${w}px;height:${h}px;border:1px solid #bbb;background:#fff`;
  iframe.src = `/tests/app.html?${q}`;
  document.getElementById("frames").append(iframe);
  await waitFor(() => iframe.contentDocument?.documentElement?.dataset.harness === "ready", { what: "загрузка стенда", timeout: 8000 });
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  const ctl = win.__fake;
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
    close() { iframe.remove(); },
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
    try { await test.run(t); } catch (e) { r.status = "fail"; r.error = String(e && e.stack || e); }
    if (t.checks.some((c) => !c.ok)) r.status = "fail";
    if (!t.checks.length && !r.error) { r.status = "fail"; r.error = "сценарий не сделал ни одной проверки"; }
    results.push(r);
    onResult?.(r);
    document.getElementById("frames").innerHTML = ""; // изоляция: следующий сценарий с чистого листа
  }
  return results;
}

// Хранитель фокуса для разделов V2, которые перерисовывают области через
// innerHTML: узел с фокусом уничтожается, фокус падает на <body>, и
// клавиатурному пользователю приходится заново идти Tab с начала страницы.
// Здесь фокус возвращается на ЭКВИВАЛЕНТНЫЙ новый узел (тот же id или тот же
// набор data-атрибутов) вместе с положением каретки. Один экземпляр на общий
// контейнер раздела (#v2-content); при смене раздела вызывается reset().

const cssEscape = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));

function describe(el) {
  if (!el || el.nodeType !== 1) return null;
  let selector = null;
  if (el.id) selector = `#${cssEscape(el.id)}`;
  else {
    const data = [...el.attributes].filter((a) => a.name.startsWith("data-"));
    if (data.length) selector = el.tagName.toLowerCase() + data.map((a) => `[${a.name}="${cssEscape(a.value)}"]`).join("");
  }
  if (!selector) return null;
  let start = null, end = null;
  try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { /* не текстовое поле */ }
  return { selector, start, end };
}

export function keepFocus(root) {
  let last = null;     // описание последнего элемента с фокусом внутри root
  let lastEl = null;

  function onFocusIn(e) {
    last = describe(e.target);
    lastEl = last ? e.target : null;
  }
  function onFocusOut() {
    // Фокус ушёл, а сам элемент жив и не в фокусе — пользователь перешёл
    // сознательно (клик мимо, Tab дальше): восстанавливать нечего. Если же
    // узел уничтожен перерисовкой — описание сохраняется.
    queueMicrotask(() => {
      if (lastEl && lastEl.isConnected && document.activeElement !== lastEl) { last = null; lastEl = null; }
    });
  }
  // Не везде focusin приходит (окно без фокуса ОС, программный focus()) —
  // поэтому активный элемент запоминается и на действиях пользователя.
  function remember() {
    const el = document.activeElement;
    if (el && el !== document.body && root.contains(el)) { const d = describe(el); if (d) { last = d; lastEl = el; } }
  }
  const REMEMBER_EVENTS = ["click", "keydown", "input", "change"];
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  REMEMBER_EVENTS.forEach((n) => root.addEventListener(n, remember, true));

  const observer = new MutationObserver(() => {
    if (!last || !lastEl || lastEl.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return; // фокус уже куда-то передан (диалог, другое поле)
    const next = root.querySelector(last.selector);
    if (!next || next === lastEl || next.disabled) return;
    next.focus({ preventScroll: true });
    if (last.start != null) { try { next.setSelectionRange(last.start, last.end); } catch (e) { /* type=date и т.п. */ } }
    lastEl = next;
  });
  observer.observe(root, { childList: true, subtree: true });

  return {
    reset() { last = null; lastEl = null; },
    stop() {
      observer.disconnect();
      root.removeEventListener("focusin", onFocusIn); root.removeEventListener("focusout", onFocusOut);
      REMEMBER_EVENTS.forEach((n) => root.removeEventListener(n, remember, true));
    },
  };
}

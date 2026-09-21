// «Сообщения за сеанс»: лента сообщений, которые интерфейс показывал в областях состояния (`role="status"`, `aria-live`) с момента загрузки страницы,
// новые сверху (время и текст). Аналог ленты строки состояния V1. Собирается на КЛИЕНТЕ (MutationObserver) и живёт только до перезагрузки вкладки:
// это не журнал действий сервера, на сервер ничего не отправляется.
const MAX = 300;
const entries = [];
const lastText = new WeakMap();
let started = false;

function record(el) {
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || lastText.get(el) === text) return;
  lastText.set(el, text);
  if (el.closest("[data-statuslog-skip]")) return;
  entries.unshift({ at: new Date(), text: text.slice(0, 500) });
  if (entries.length > MAX) entries.length = MAX;
}

/** Запускается один раз при загрузке оболочки. */
export function startStatusLog() {
  if (started) return;
  started = true;
  const obs = new MutationObserver((muts) => {
    const seen = new Set();
    for (const m of muts) {
      const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const el = node?.closest?.('[role="status"], [aria-live]');
      if (el && !seen.has(el)) { seen.add(el); record(el); }
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });
}

export function statusEntries() { return entries; }
export function clearStatusEntries() { entries.length = 0; }

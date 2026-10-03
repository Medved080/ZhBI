// Переход с элемента схемы (2D и 3D) на страницу изделия в «Калькуляторе» по марке (2026-10-04).
// Определение изделия — на сервере (POST /calc/api/marks/resolve, app/calc/marks.py); у человека без
// раздела прав `calc` сервер отвечает 401/403, и кнопка не показывается вовсе.
(() => {
  const cache = new Map();
  let denied = false;
  function resolve(mark, type) {
    if (denied || !mark) return Promise.resolve(null);
    const key = mark + "\u0001" + (type || "");
    if (!cache.has(key)) {
      cache.set(key, fetch("/calc/api/marks/resolve", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marks: [{ mark, type: type || null }] }),
      }).then(async (r) => {
        if (r.status === 401 || r.status === 403 || r.status === 404) { denied = true; return null; }
        if (!r.ok) { cache.delete(key); return null; }   // 503 и сбои сети — повторим при следующем показе
        return (await r.json()).results[mark] || null;
      }).catch(() => { cache.delete(key); return null; }));
    }
    return cache.get(key);
  }
  // Вкладка калькулятора переиспользуется по имени окна: следующий переход меняет только #product.
  // В новом интерфейсе (V2) калькулятор — экран оболочки #/calc (v2/calc-embed.js подхватывает изделие из sessionStorage),
  // в прежнем (V1) — отдельная страница /calc/ в переиспользуемой вкладке.
  function open(productId) {
    if (document.getElementById("v2-root")) {
      try { sessionStorage.setItem("zhbi_calc_product", productId); } catch (e) { /* ignore */ }
      location.hash = "#/calc";
      return;
    }
    window.open("/calc/?ui=v1#product=" + encodeURIComponent(productId), "zhbi-calc");
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Разметка по ответу resolve; кнопки несут data-calc-open — навешивает bind().
  function html(res) {
    if (!res) return "";
    if (res.status === "found") return `<button type="button" class="btn btn-sm btn-secondary" data-calc-open="${esc(res.productId)}" title="Страница изделия в калькуляторе">Открыть в калькуляторе · ${esc(res.productName)}</button>`;
    if (res.status === "ambiguous") return `<div class="hint-text">В калькуляторе несколько похожих изделий:</div>` + res.candidates.map((c) => `<button type="button" class="btn btn-sm btn-secondary" data-calc-open="${esc(c.productId)}">${esc(c.productName)}</button>`).join(" ");
    return `<span class="hint-text">Изделия нет в калькуляторе</span>`;
  }
  function bind(root) { root.querySelectorAll("[data-calc-open]").forEach((b) => b.addEventListener("click", () => open(b.dataset.calcOpen))); }
  window.ZhbiCalcLink = { resolve, open, html, bind };
})();

// Экран «Калькулятор» интерфейса V2 (2026-10-04): страница подсистемы /calc/ внутри оболочки V2.
// Приём тот же, что у схемы (workspace.js, fetchScenePage): сервер запрещает показывать свои страницы в чужих кадрах
// (X-Frame-Options/frame-ancestors), поэтому кадр строится из srcdoc — он наследует origin и CSP оболочки. Оформление
// калькулятора берёт токены и гамму пользователя из тех же значений, что и V2 (app/calc/web/theme.css).
// Право доступа — раздел `calc` (сервер отвечает 403, и экран покажет причину).

const KEY = "zhbi_calc_product";

// Переход из карточки элемента на схеме: ставит изделие и открывает экран (см. static/calc-link.js).
export function rememberCalcProduct(id) {
  try { sessionStorage.setItem(KEY, id); } catch (e) { /* без хранилища откроется последнее изделие */ }
}

export function mountCalcEmbed(el, { screen }) {
  el.className = "v2-page v2-calc";
  let dead = false, frame = null;
  el.innerHTML = `<p class="v2-muted" role="status" style="padding:16px">Загрузка калькулятора…</p>`;
  (async () => {
    try {
      const r = await fetch("/calc/", { credentials: "same-origin", cache: "no-cache" });
      if (r.status === 403) throw new Error("нет доступа: нужна роль «Калькулятор»");
      if (r.status === 503) throw new Error("подсистема не запущена, см. журнал сервера");
      if (!r.ok) throw new Error(`страница недоступна (${r.status})`);
      const t = await r.text();
      if (!/id="precast-concept"/.test(t)) throw new Error("сервер вернул не страницу калькулятора");
      if (dead) return;
      let product = "";
      try { product = sessionStorage.getItem(KEY) || ""; sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      frame = document.createElement("iframe");
      frame.className = "v2-calc-frame";
      frame.title = screen?.title || "Калькулятор";
      frame.setAttribute("allow", "fullscreen");
      frame.dataset.calcEmbed = "v2";
      if (product) frame.dataset.calcProduct = product;
      // Адреса ресурсов делаются абсолютными: предзагрузчик браузера читает srcdoc до <base> и иначе запрашивает /theme.css
      // и т.п. от корня (лишние 404 в журнале ошибок сервера).
      frame.srcdoc = t.replace(/(\s(?:src|href)=")(?![a-z]+:|\/|#)/gi, "$1/calc/").replace(/<head>/i, '<head><base href="/calc/">');
      el.innerHTML = "";
      el.append(frame);
    } catch (e) {
      if (!dead) el.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert" style="margin:16px">Не удалось открыть калькулятор: ${String(e.message || e).replace(/[<>&]/g, "")}</div>`;
    }
  })();
  return {
    hasUnsavedChanges: () => false,
    // Автосохранение калькулятора досылается до ухода с экрана.
    guardLeave: async () => { try { await frame?.contentWindow?.CalcZhBIFlushSaves?.(); } catch (e) { /* уходим в любом случае */ } return true; },
    destroy() { dead = true; frame?.remove(); frame = null; },
  };
}

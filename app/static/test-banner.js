// Яркая полоса «тестовый сервер» сверху страницы (2026-09-30). Один файл на V1 и V2.
// Показывается, только если сервер ответил test_server=true (см. /api/server-banner).
(function () {
  fetch("/api/server-banner", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (info) {
      if (!info || !info.test_server) return;
      // В кадре (схема рабочего места V2 — страница V1 в iframe, встроенный калькулятор) плашка уже есть у оболочки: вторая не нужна
      if (window.parent !== window) return;
      var HEIGHT = 34;
      var style = document.createElement("style");
      style.textContent =
        "#test-server-banner{position:fixed;top:0;left:0;right:0;height:" + HEIGHT + "px;z-index:10;" +
        "display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px;box-sizing:border-box;" +
        "background:#d9480f;color:#fff;font:600 14px/1.2 system-ui,sans-serif;text-align:center;" +
        "box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden}" +
        "#test-server-banner a{color:#fff;text-decoration:underline}" +
        "html.has-test-banner{--test-banner-h:" + HEIGHT + "px}" +
        "html.has-test-banner body{position:absolute;top:" + HEIGHT + "px;left:0;right:0;bottom:0;height:auto;min-height:0}" +
        // Полноэкранные слои (модалки, диалоги, Гант) — position:fixed от края окна, а не от смещённого body:
        // без сдвига плашка лежала бы поверх их верхней части и закрывала кнопки. Плашка ниже них по z-index,
        // а слои начинаются под ней.
        "html.has-test-banner .modal-backdrop,html.has-test-banner .mfr-modal-back,html.has-test-banner .v2-dialog-backdrop,html.has-test-banner .v2-gantt-fs{top:" + HEIGHT + "px}" +
        "html.has-test-banner #app-root,html.has-test-banner #v2-root{height:100% !important}";
      document.head.appendChild(style);
      var bar = document.createElement("div");
      bar.id = "test-server-banner";
      bar.setAttribute("role", "alert");
      bar.appendChild(document.createTextNode("⚠ ТЕСТОВЫЙ СЕРВЕР. Рабочий сервер — по другому адресу: "));
      var a = document.createElement("a");
      a.href = info.main_url;
      a.textContent = info.main_url;
      bar.appendChild(a);
      document.documentElement.classList.add("has-test-banner");
      document.body.insertBefore(bar, document.body.firstChild);
    })
    .catch(function () {});
})();

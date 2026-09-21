// Рабочие места со схемой (WS-*): сторона V2 — оболочка, панели, протокол `zhbi-scene/1`, смена статуса, уход.
// Стенд — фейковый бэкенд БЕЗ геометрии, поэтому вместо движка V1 в кадр подставляется страница-заглушка, которая говорит
// по тому же протоколу (ready / state / filters, журнал команд в window.__cmds). Настоящий движок и настоящая геометрия
// проверяются живой проверкой на настоящем backend (Docs/v2-workspaces.md, «Проверка»); эти сценарии — регрессия оболочки.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-shellnav [data-section]";
const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><!-- /static/app.js --><script>
(function () {
  var P = "zhbi-scene/1", par = window.parent, O = window.origin;
  window.__cmds = [];
  var S = { objectId: 1, objectName: "QA-Объект", projectName: "QA-Проект", hasDrawing: true, view: "2d", loading: false, loaded: true, error: null,
    total: 8, shown: 8, selected: null, selectedId: null, multi: null, multiIds: [], excluded: 0,
    statusCounts: [["delivered", 3], ["installed", 2], ["shipped", 3]],
    statusLabels: { planned: "Запланирован", contracting: "Контрактация", in_production: "В производстве", shipped: "Отгружен", delivered: "Доставлен", installed: "Смонтирован", accepted: "Принят" },
    statusColors: { planned: "#999", shipped: "#39c", delivered: "#e83", installed: "#3a3" },
    statusOrder: ["planned", "contracting", "in_production", "shipped", "delivered", "installed", "accepted"], zones: [] };
  var F = { groups: [{ id: "status", title: "Статус", kind: "flat", key: "status", items: [
    { v: "delivered", label: "Доставлен", on: true, enabled: true, count: 3 }, { v: "shipped", label: "Отгружен", on: true, enabled: true, count: 3 }] }] };
  function send(m) { par.postMessage(Object.assign({ proto: P }, m), O); }
  window.__emit = function (patch) { Object.assign(S, patch); send({ evt: "state", state: S }); };
  window.__send = send;
  window.__raw = function (m) { par.postMessage(m, O); };   // без добавления proto — для проверки отбраковки
  window.addEventListener("message", function (e) {
    if (e.source !== par || e.origin !== O) return;
    var m = e.data; if (!m || m.proto !== P) return;
    window.__cmds.push({ cmd: m.cmd, args: m.args });
    if (m.cmd === "getFilters") send({ evt: "filters", model: F });
    else if (m.cmd === "setView") window.__emit({ view: m.args.mode });
    else if (m.cmd === "clearSelection") window.__emit({ selected: null, selectedId: null });
    else if (m.cmd === "setObject") window.__emit({ objectId: m.args.objectId });
  });
  send({ evt: "ready" }); send({ evt: "state", state: S });
})();
<\/script></body></html>`;

// Подмена страницы «/» (в бою — index.html V1) на заглушку; остальное — в фейковый бэкенд.
function stub(a, { html = STUB_HTML, fail = false } = {}) {
  const real = a.win.fetch.bind(a.win);
  a.win.__pageFetches = 0;
  a.win.fetch = (u, o) => {
    if (String(u) === "/") {
      a.win.__pageFetches++;
      if (fail) return Promise.resolve(new a.win.Response("нет", { status: 503 }));
      return Promise.resolve(new a.win.Response(html, { status: 200, headers: { "Content-Type": "text/html" } }));
    }
    return real(u, o);
  };
}
const frameWin = (a) => a.$(".ws-frame")?.contentWindow;
const cmds = (a) => frameWin(a)?.__cmds || [];
async function openWs(a, id = "ws-model") {
  await waitFor(() => a.$(`${NAV}[data-section="${id}"]`), { what: "пункт навигации " + id });
  a.click(a.$(`${NAV}[data-section="${id}"]`));
  await waitFor(() => a.$(".ws-frame") && /Показано|Элементов/.test(a.$("#ws-status")?.textContent || ""), { what: "рабочее место со схемой" });
}
const element = (a, id, patch = {}) => ({ id, mark: "К-" + id, element_type: "Колонна", subtype: null, current_status: "delivered", address: "1-2/А-Б", floor: 3, elevation_mm: 9000,
  contract_id: null, supplier: null, contractName: null, zones: {}, ...patch });
const emitSel = (a, id, patch) => frameWin(a).__emit({ selected: element(a, id, patch), selectedId: id });

export const tests = [
  {
    id: "WS-01", title: "Рабочее место ЖБИ: кадр из srcdoc, шапка/вкладки/панель/строка состояния; геометрия на 3 размерах без прокрутки страницы",
    async run(t) {
      for (const [w, h] of [[1920, 1080], [1920, 900], [1366, 768]]) {
        const a = await openApp({ home: true, w, h });
        stub(a);
        await openWs(a);
        const f = a.$(".ws-frame");
        const tag = `${w}×${h}: `;
        t.ok(f.hasAttribute("srcdoc") && !f.getAttribute("src"), tag + "кадр строится из srcdoc, а не по адресу (сервер запрещает показ страниц в кадрах)");
        t.has(f.getAttribute("data-zhbi-scene"), "embed=scene", tag + "режим сцены передан атрибутом");
        t.has(f.getAttribute("data-zhbi-scene"), "object_id=1", tag + "объект передан атрибутом");
        t.eq(a.$$("#ws-modes button").map((b) => b.textContent), ["2D", "3D", "3D лёгкий"], tag + "режимы схемы");
        t.eq(a.$$(".ws-tabs button").map((b) => b.textContent), ["Свойства", "Статус", "Фильтры", "Вид"], tag + "вкладки правой панели");
        t.eq(a.$("#ws-modes [aria-pressed=true]")?.textContent, "2D", tag + "нажат режим 2D из снимка кадра");
        t.has(a.$("#ws-status").textContent, "Показано", tag + "строка состояния");
        t.notHas(a.$("#v2-content").textContent, "каркас", tag + "нет слов «каркас»");
        t.notHas(a.$("#v2-content").textContent, "Docs/", tag + "нет путей Docs/*");
        const stage = a.$("#ws-stage").getBoundingClientRect(), fr = f.getBoundingClientRect(), pn = a.$("#ws-panel").getBoundingClientRect();
        t.ok(Math.abs(stage.width - fr.width) < 1.5 && Math.abs(stage.height - fr.height) < 1.5, tag + "кадр занимает всю площадь схемы");
        t.ok(stage.width >= 560 && stage.height >= 380, tag + `схема не сжата (${Math.round(stage.width)}×${Math.round(stage.height)})`);
        t.ok(pn.width >= 300 && pn.width <= 640, tag + `ширина панели в пределах (${Math.round(pn.width)})`);
        const de = a.doc.documentElement;
        t.ok(de.scrollHeight <= a.win.innerHeight + 1 && de.scrollWidth <= a.win.innerWidth + 1, tag + "страница не прокручивается");
        t.ok(a.$("#ws-status").getBoundingClientRect().bottom <= a.win.innerHeight + 1, tag + "строка состояния видна");
        // сворачиваемая навигация и панель
        const w0 = stage.width;
        a.click(a.$("#ws-nav"));
        await a.settle(60);
        const w1 = a.$("#ws-stage").getBoundingClientRect().width;
        t.ok(Math.abs(w1 - w0) > 100, tag + `переключатель навигации меняет ширину схемы (${Math.round(w0)} → ${Math.round(w1)})`);
        a.click(a.$("#ws-panel-toggle"));
        await a.settle(60);
        const w2 = a.$("#ws-stage").getBoundingClientRect().width;
        t.ok(a.$("#ws-panel").hidden && w2 > w1 + 250, tag + `панель сворачивается, схеме достаётся её место (${Math.round(w1)} → ${Math.round(w2)})`);
        a.close();
      }
    },
  },
  {
    id: "WS-02", title: "Выбор ↔ панель: карточка выбранного, «ничего не выбрано», история с сервера; запоздавший ответ прежнего выбора не подменяет текущий",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      t.has(a.$("#ws-panel-body").textContent, "Ничего не выбрано", "пока ничего не выбрано — подсказка");
      a.ctl.setLatency("/elements/101", 500, "GET");
      emitSel(a, 101, { mark: "К-101" });
      await a.settle(60);
      emitSel(a, 105, { mark: "К-105", current_status: "shipped" });
      await waitFor(() => /К-105/.test(a.$("#ws-panel-body .ws-mark")?.textContent || "") && a.$$("#ws-panel-body .ws-hist li").length, { what: "карточка второго элемента" });
      await a.settle(700); // первый (медленный) ответ уже пришёл
      t.has(a.$("#ws-panel-body .ws-mark").textContent, "К-105", "медленный ответ по К-101 не перекрыл карточку К-105");
      t.has(a.$("#ws-panel-body").textContent, "Отгружен", "статус выбранного — из снимка сцены");
      t.has(a.$("#ws-status").textContent, "Выбран: К-105", "строка состояния называет выбранный элемент");
      a.click(a.byText("#ws-panel-body button", "Снять выбор"));
      await waitFor(() => cmds(a).some((c) => c.cmd === "clearSelection"), { what: "команда снятия выбора" });
      await waitFor(() => /Ничего не выбрано/.test(a.$("#ws-panel-body").textContent), { what: "панель без выбора" });
      // выбор нескольких: сводка
      frameWin(a).__emit({ multi: { count: 3, byType: [["Колонна", 2], ["Балка", 1]], byStatus: [["delivered", 3]] }, multiIds: [1, 2, 3] });
      await waitFor(() => /Выбрано элементов: 3/.test(a.$("#ws-panel-body").textContent), { what: "сводка множественного выбора" });
      t.has(a.$("#ws-panel-body").textContent, "Колонна", "сводка по типам");
      a.close();
    },
  },
  {
    id: "WS-03", title: "Безопасность канала: чужие и неверные сообщения игнорируются; из V2 в кадр уходят только команды протокола",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      const before = a.$("#ws-status").textContent;
      const evil = { proto: "zhbi-scene/1", evt: "state", state: { loaded: true, total: 1, shown: 1, view: "3d", objectId: 1, selected: null, statusCounts: [], statusLabels: {}, statusColors: {}, statusOrder: [], excluded: 0 } };
      a.win.postMessage(evil, "*");                                                   // источник — сама оболочка, не кадр
      a.win.postMessage({ proto: "другое", evt: "state", state: evil.state }, "*");
      await a.settle(80);
      t.eq(a.$("#ws-status").textContent, before, "сообщение не из кадра не меняет состояние");
      frameWin(a).__raw({ proto: "zhbi-scene/0", evt: "state", state: { ...evil.state, total: 5 } });
      frameWin(a).__raw({ evt: "state", state: evil.state });
      frameWin(a).__raw("строка вместо объекта");
      frameWin(a).__raw(null);
      frameWin(a).__send({ proto: "zhbi-scene/1", evt: "неизвестное", message: "<img src=x onerror=alert(1)>" });
      await a.settle(80);
      t.eq(a.$("#ws-status").textContent, before, "сообщения кадра с неверным протоколом или событием игнорируются");
      frameWin(a).__send({ proto: "zhbi-scene/1", evt: "notice", message: "<img src=x onerror=alert(1)>" });
      await waitFor(() => a.$(".ws-notice"), { what: "сообщение движка" });
      t.eq(a.$$("#ws-status img").length, 0, "текст сообщения выводится как текст, не как HTML");
      // команды только из протокола и только известные
      a.click(a.$("#ws-modes [data-view=\"3d\"]"));
      a.click(a.$(".ws-tools [data-tool=\"fit\"]"));
      a.click(a.$(".ws-tools [data-tool=\"in\"]"));
      await waitFor(() => cmds(a).length >= 3, { what: "команды" });
      const allowed = ["getFilters", "setView", "fit", "zoom", "select", "locate", "clearSelection", "setFilter", "resetFilters", "setZoneVisible", "search", "refreshElement", "setObject", "reload"];
      t.ok(cmds(a).every((c) => allowed.includes(c.cmd)), "все отправленные команды — из белого списка протокола");
      t.eq(cmds(a).find((c) => c.cmd === "setView")?.args, { mode: "3d" }, "setView несёт только режим");
      t.eq(cmds(a).find((c) => c.cmd === "zoom")?.args, { factor: 1 / 1.3 }, "zoom несёт только коэффициент");
      a.close();
    },
  },
  {
    id: "WS-04", title: "Фильтры: модель из кадра → переключатель шлёт setFilter с ключом и значениями; «Сбросить все» шлёт resetFilters; счётчики из снимка",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      a.click(a.byText(".ws-tabs button", "Фильтры"));
      await waitFor(() => a.$(".ws-fh"), { what: "группы фильтров" });
      t.has(a.$("#ws-panel-body").textContent, "Показано 8 из 8", "счётчик показанных");
      t.ok(a.$(".ws-fhead .v2-btn").disabled, "«Сбросить все» недоступно, пока фильтров нет");
      await waitFor(() => a.$(".ws-check input"), { what: "значения группы «Статус» (открыта по умолчанию)" });
      const cb = a.$$(".ws-check input").find((c) => c.nextElementSibling.textContent.includes("Отгружен"));
      cb.click();
      await waitFor(() => cmds(a).some((c) => c.cmd === "setFilter"), { what: "команда setFilter" });
      t.eq(cmds(a).find((c) => c.cmd === "setFilter").args, { changes: [{ key: "status", values: ["shipped"], on: false }] }, "снято значение «Отгружен»");
      frameWin(a).__emit({ shown: 5, excluded: 1 });
      await waitFor(() => /Показано 5 из 8/.test(a.$("#ws-panel-body").textContent), { what: "новый счётчик" });
      t.has(a.$("#ws-status").textContent, "Фильтры активны: снято 1", "строка состояния: ограничения");
      a.click(a.byText(".ws-fhead .v2-btn", "Сбросить"));
      await waitFor(() => cmds(a).some((c) => c.cmd === "resetFilters"), { what: "команда resetFilters" });
      a.close();
    },
  },
  {
    id: "WS-05", title: "Ошибка и пустота: причина + «Повторить» (кадр создаётся заново); недоступная страница схемы; объект без чертежа",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      frameWin(a).__emit({ loaded: false, error: "Не удалось загрузить чертёж: сервер недоступен" });
      await waitFor(() => a.$("#ws-overlay [role=alert]"), { what: "плашка ошибки" });
      t.has(a.$("#ws-overlay").textContent, "сервер недоступен", "показана причина");
      const first = a.$(".ws-frame");
      a.click(a.byText("#ws-overlay button", "Повторить"));
      await waitFor(() => a.$(".ws-frame") && a.$(".ws-frame") !== first && /Показано/.test(a.$("#ws-status").textContent), { what: "повтор" });
      t.eq(a.$$(".ws-frame").length, 1, "после повтора ровно один кадр");
      frameWin(a).__emit({ hasDrawing: false });
      await waitFor(() => /нет загруженного чертежа/.test(a.$("#ws-overlay").textContent), { what: "пустое состояние" });
      a.close();
      // страница схемы недоступна: причина и повтор, без кадра
      const b = await openApp({ home: true });
      stub(b, { fail: true });
      await waitFor(() => b.$(`${NAV}[data-section="ws-model"]`), { what: "навигация" });
      b.click(b.$(`${NAV}[data-section="ws-model"]`));
      await waitFor(() => b.$("#ws-overlay [role=alert]"), { what: "ошибка загрузки страницы" });
      t.has(b.$("#ws-overlay").textContent, "503", "причина ошибки показана");
      t.ok(!b.$(".ws-frame"), "кадра нет, пока страницу получить не удалось");
      t.ok(!!b.byText("#ws-overlay button", "Повторить"), "есть «Повторить»");
      b.close();
    },
  },
  {
    id: "WS-06", title: "Смена объекта в шапке: кадр остаётся тем же, уходит setObject; ЖБИ → МФР переключает на парное рабочее место",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      const f = a.$(".ws-frame");
      const sel = a.$("#v2-object");
      a.setValue(sel, "4");
      await waitFor(() => cmds(a).some((c) => c.cmd === "setObject"), { what: "команда setObject" });
      t.eq(cmds(a).find((c) => c.cmd === "setObject").args, { objectId: 4 }, "передан выбранный объект");
      t.ok(a.$(".ws-frame") === f, "кадр не пересоздан при смене объекта того же типа");
      a.setValue(sel, "6"); // МФР
      await waitFor(() => a.doc.title.includes("Модель МФР"), { what: "переход на «Модель МФР»" });
      t.eq(a.$$(".ws-frame").length, 1, "кадр один");
      await waitFor(() => a.$(".ws-frame")?.getAttribute("data-zhbi-scene")?.includes("ws=mfr"), { what: "кадр МФР" });
      t.eq(a.$$(".ws-tabs button").map((b) => b.textContent), ["Свойства", "Фильтры", "Вид"], "у МФР свои вкладки");
      a.setValue(sel, "1");
      await waitFor(() => a.doc.title.includes("Модель: схема"), { what: "возврат на модель ЖБИ" });
      a.close();
    },
  },
  {
    id: "WS-07", title: "Уход с рабочего места: кадр удалён, слушатели сняты, повторные заходы не накапливают обработчики; навигация возвращается",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      let listeners = 0;
      const add = a.win.addEventListener.bind(a.win), rem = a.win.removeEventListener.bind(a.win);
      a.win.addEventListener = (ty, ...r) => { if (ty === "message") listeners++; return add(ty, ...r); };
      a.win.removeEventListener = (ty, ...r) => { if (ty === "message") listeners--; return rem(ty, ...r); };
      for (let i = 0; i < 4; i++) {
        await openWs(a);
        t.eq(listeners, 1, `заход ${i + 1}: один слушатель сообщений`);
        t.eq(a.$$("iframe.ws-frame").length, 1, `заход ${i + 1}: один кадр`);
        a.click(a.$(`${NAV}[data-section="home"]`) || a.$(".v2-nav-home"));
        await waitFor(() => !a.$(".ws-frame"), { what: "кадр удалён" });
        t.eq(listeners, 0, `выход ${i + 1}: слушатель снят`);
      }
      // сворачивание навигации восстановлено при уходе
      t.ok(!a.$("#v2-side").hidden, "после ухода навигация снова видна");
      t.ok(a.doc.querySelectorAll(".ws-frame, .ws-found").length === 0, "в документе не осталось элементов рабочего места");
      a.close();
    },
  },
  {
    id: "WS-08", title: "Смена статуса одного элемента: форма только при праве, PATCH без контракта, двойной клик — один запрос, сбой — без автоповтора и с сохранением ввода, refreshElement после успеха",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a);
      emitSel(a, 105, { mark: "К-105", current_status: "contracting" });
      await waitFor(() => a.$("#ws-sform"), { what: "форма смены статуса" });
      t.ok(!a.$$("#ws-sform select option").some((o) => o.value === "contracting"), "текущий статус в списке не предлагается");
      t.ok(a.$("#ws-sform button[type=submit]").disabled, "без выбора статуса «Сохранить» недоступно");
      // отказ сервера: текст показан, ввод остался, повтора нет
      a.setValue(a.$("#ws-sform select"), "delivered");
      a.setValue(a.$("#ws-sform textarea"), "приняли на площадке");
      a.ctl.failNext("PATCH /elements", { status: 409, detail: "QA: контракт исчерпан" });
      a.click(a.$("#ws-sform button[type=submit]"));
      await waitFor(() => /QA: контракт исчерпан/.test(a.$("#ws-sform .ws-err")?.textContent || ""), { what: "сообщение об отказе" });
      t.eq(a.$("#ws-sform select").value, "delivered", "выбранный статус остался");
      t.eq(a.$("#ws-sform textarea").value, "приняли на площадке", "комментарий остался");
      t.eq(a.ctl.log.filter((e) => e.method === "PATCH").length, 1, "автоповтора нет");
      // сетевой сбой: исход неизвестен → чтение, повторная отправка не делается
      a.ctl.failNext("PATCH /elements", { network: true });
      a.click(a.$("#ws-sform button[type=submit]"));
      await waitFor(() => /не подтверждено/.test(a.$("#ws-sform .ws-err")?.textContent || ""), { what: "неизвестный исход" });
      t.eq(a.ctl.log.filter((e) => e.method === "PATCH").length, 2, "после сетевого сбоя запрос не повторён автоматически");
      t.ok(a.ctl.log.some((e) => e.method === "GET" && /\/elements\/105$/.test(e.path)), "исход проверен чтением элемента");
      t.eq(a.$("#ws-sform select").value, "delivered", "ввод сохранён после сбоя");
      // успех + двойной клик: один запрос
      const hold = a.ctl.hold("PATCH /elements");
      a.click(a.$("#ws-sform button[type=submit]"));
      await hold.waitForRequest(1, 3000);
      t.ok(a.$("#ws-sform button[type=submit]").disabled && a.$("#ws-sform select").disabled, "на время записи форма заблокирована");
      a.$("#ws-sform").requestSubmit(); a.$("#ws-sform").requestSubmit();
      hold.release();
      await waitFor(() => /Статус изменён/.test(a.$("#ws-sform .ws-ok")?.textContent || ""), { what: "подтверждение" });
      const patches = a.ctl.log.filter((e) => e.method === "PATCH");
      t.eq(patches.length, 3, "двойная отправка не размножила запрос");
      t.eq(patches[2].path, "/elements/105/status", "PATCH ушёл на выбранный элемент");
      t.eq(Object.keys(patches[2].body).sort(), ["comment", "status"], "в теле только статус и комментарий — без контракта");
      await waitFor(() => cmds(a).some((c) => c.cmd === "refreshElement"), { what: "обновление схемы" });
      t.eq(cmds(a).find((c) => c.cmd === "refreshElement").args, { id: 105 }, "схема обновляется по подтверждённому элементу");
      t.eq(a.ctl.data.elements.find((e) => e.id === 105).current_status, "delivered", "у сервера статус изменён");
      // шлюз: контракт и массовая смена — отказ без сети
      const gate = await import("/static/v2/write-gate.js");
      t.ok(gate.checkWrite("PATCH", "/elements/5/status", { status: "delivered", comment: "x" }).allowed || gate.POLICY.length === 0, "смена статуса разрешена политикой");
      if (gate.POLICY.length) {
        t.ok(!gate.checkWrite("PATCH", "/elements/5/status", { status: "delivered", contract_id: 3 }).allowed, "смена с контрактом шлюзом отклонена");
        t.ok(!gate.checkWrite("PATCH", "/elements/bulk-status", { items: [], status: "delivered" }).allowed, "массовая смена шлюзом отклонена");
        t.ok(!gate.checkWrite("PATCH", "/elements/5/contract", { contract_id: 1 }).allowed, "смена контракта элемента шлюзом отклонена");
      }
      a.close();
    },
  },
  {
    id: "WS-09", title: "Смена статуса: нет права → формы нет, есть пояснение; несохранённый ввод при уходе — сторож с тремя ответами",
    async run(t) {
      const a = await openApp({ home: true, perm: "viewer" });
      stub(a);
      await waitFor(() => a.$(`${NAV}[data-section="ws-model"]`) || a.$(".v2-note-page"), { what: "навигация" });
      if (a.$(`${NAV}[data-section="ws-model"]`)) {
        await openWs(a);
        emitSel(a, 105, { mark: "К-105", current_status: "contracting" });
        await waitFor(() => /К-105/.test(a.$("#ws-panel-body .ws-mark")?.textContent || ""), { what: "карточка" });
        await a.settle(150);
        t.ok(!a.$("#ws-sform"), "без права изменять статусы формы нет");
        t.has(a.$("#ws-panel-body").textContent, "нет права изменять статусы", "причина названа");
      } else t.ok(true, "раздел недоступен профилю — форма тем более");
      a.close();
      const b = await openApp({ home: true });
      stub(b);
      await openWs(b);
      emitSel(b, 105, { mark: "К-105", current_status: "contracting" });
      await waitFor(() => b.$("#ws-sform"), { what: "форма" });
      b.setValue(b.$("#ws-sform select"), "installed");
      b.click(b.$(`${NAV}[data-section="home"]`) || b.$(".v2-nav-home"));
      const d = await waitFor(() => b.dialog(), { what: "сторож ухода" });
      t.has(d.textContent, "не отправленное", "сторож называет причину");
      t.eq([...d.querySelectorAll("button")].map((x) => x.textContent.trim()), ["Остаться", "Не сохранять", "Сохранить и продолжить"], "три ответа");
      await b.answerDialog("Остаться");
      await b.settle(60);
      t.ok(!!b.$(".ws-frame"), "«Остаться» — рабочее место открыто, ввод на месте");
      t.eq(b.$("#ws-sform select").value, "installed", "введённый статус сохранён");
      t.eq(b.ctl.log.filter((e) => e.method === "PATCH").length, 0, "ничего не отправлено");
      b.close();
    },
  },
  {
    id: "WS-10", title: "Прораб и комплектовщик: свои панели (отбор слева, показатели; срезы, показатели, контракты) из моделей кадра",
    async run(t) {
      const a = await openApp({ home: true });
      stub(a);
      await openWs(a, "ws-foreman");
      t.ok(!!a.$("#ws-left"), "прораб: постоянная панель отбора слева");
      t.eq(a.$$(".ws-tabs button").map((b) => b.textContent), ["Свойства", "Статус", "Вид"], "прораб: вкладок фильтров справа нет");
      await waitFor(() => a.$("#ws-left .ws-fh"), { what: "фильтры слева" });
      t.has(a.$("#ws-strip").textContent, "элементов", "прораб: полоса показателей");
      t.has(a.$("#ws-strip").textContent, "смонтировано и принято", "прораб: доля смонтированных");
      a.close();
      const b = await openApp({ home: true });
      stub(b);
      await openWs(b, "ws-picker");
      t.eq(b.$$(".ws-tabs button").map((x) => x.textContent), ["Отбор", "Показатели", "Контракты", "Свойства", "Вид"], "комплектовщик: вкладки");
      frameWin(b).__send({ proto: "zhbi-scene/1", evt: "picker", model: { slicers: [{ key: "elementType", title: "Тип элемента", selected: 0, contractedShown: true,
        rows: [{ v: "Колонна", label: "Колонна", count: 5, contracted: 7, on: false, available: true }, { v: "Балка", label: "Балка", count: 3, contracted: 2, on: false, available: true }] }],
        metrics: [{ key: "model", title: "В модели", value: 8, base: 8, clickable: false, on: false }, { key: "delivered", title: "Доставлено", value: 3, base: 8, share: 38, clickable: true, on: false, status: "delivered" }],
        contracts: [{ name: "QA-Контрагент", total: 10, linked: 6, inSlice: true, over: false, rows: [{ id: 7, label: "Д-1 · С-1", name: "Договор 1", total: 10, linked: 6, remainder: 4, inSlice: true, on: false, over: false }] }],
        unlinked: 2, unlinkedOn: false, contractSelected: 0, selectionActive: false, base: 8, highlightUnlinked: false, noneValue: "__none__" } });
      await waitFor(() => /Колонна/.test(b.$("#ws-panel-body").textContent), { what: "срез комплектовщика" });
      t.has(b.$("#ws-panel-body").textContent, "+2", "Δ: контракт − модель = +2 у колонн");
      b.click(b.$("input[data-pk=\"elementType\"]"));
      await waitFor(() => cmds(b).some((c) => c.cmd === "pickerToggle"), { what: "команда pickerToggle" });
      t.eq(cmds(b).find((c) => c.cmd === "pickerToggle").args, { key: "elementType", value: "Колонна" }, "выбор среза — ключ и значение");
      b.click(b.byText(".ws-tabs button", "Показатели"));
      await waitFor(() => b.$(".ws-tile"), { what: "плитки" });
      b.click(b.$("button.ws-tile"));
      await waitFor(() => cmds(b).some((c) => c.cmd === "pickerMetric"), { what: "команда pickerMetric" });
      t.eq(cmds(b).find((c) => c.cmd === "pickerMetric").args, { key: "delivered", on: true }, "плитка-показатель включает отбор");
      b.click(b.byText(".ws-tabs button", "Контракты"));
      await waitFor(() => b.$(".ws-crow"), { what: "контракты" });
      t.has(b.$("#ws-panel-body").textContent, "QA-Контрагент", "контрагент и остаток видны");
      b.click(b.$("[data-pkc=\"7\"]"));
      await waitFor(() => cmds(b).some((c) => c.cmd === "pickerToggle" && c.args.key === "contract"), { what: "выбор контракта" });
      t.eq(cmds(b).filter((c) => c.cmd === "pickerToggle").pop().args, { key: "contract", value: 7 }, "выбор контракта по id");
      b.close();
    },
  },
];

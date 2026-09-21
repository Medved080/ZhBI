// Рабочие места со схемой (WS-*): сторона V2 — оболочка, панели, протокол `zhbi-scene/1`, смена статуса, уход.
// Стенд — фейковый бэкенд БЕЗ геометрии, поэтому вместо движка V1 в кадр подставляется страница-заглушка, которая говорит
// по тому же протоколу (ready / state / filters, журнал команд в window.__cmds). Настоящий движок и настоящая геометрия
// проверяются живой проверкой на настоящем backend (Docs/v2-workspaces.md, «Проверка»); эти сценарии — регрессия оболочки.
import { openApp, waitFor, gateIsReal } from "/tests/helpers.js";

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
    else if (m.cmd === "clearSelection") window.__emit({ selected: null, selectedId: null, multiItems: [] });
    else if (m.cmd === "setObject") window.__emit({ objectId: m.args.objectId });
    else if (m.cmd === "pickerCandidates") send({ evt: "candidates", elementType: m.args.elementType, mark: m.args.mark, items: window.__cands || [] });
    else if (m.cmd === "pickerSelectIds") window.__emit({ multiItems: m.args.ids.map(function (id) { return { id: id, mark: "QA-Z1", element_type: "QA-Тип", current_status: "planned", contract_id: null }; }) });
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
      t.ok(!a.$$("#ws-sform select option").some((o) => o.value === "planned"), "«Запланирован» не предлагается: возврат на него снимает контракт");
      t.has(a.$("#ws-sform").textContent, "Возврат в «Запланирован» снимает контракт", "об этом сказано в форме");
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
      t.eq(b.$$(".ws-tabs button").map((x) => x.textContent), ["Отбор", "Показатели", "Контракты", "Распределение", "Свойства", "Вид"], "комплектовщик: вкладки");
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
  {
    id: "WS-11", title: "Комплектовщик: поставщик → контракт → марка → изделия (смешанные статусы) → подтверждение → одна серверная операция → остатки и схема из ответа",
    async run(t) {
      const a = await openApp({ home: true });
      // данные: контракт 1 объекта 1, позиция «QA-Тип · QA-Z1» на 4 шт.; без контракта: 4 «Запланирован», 1 «Отгружен», 1 «Доставлен»
      const d = a.ctl.data;
      const c1 = d.contracts.find((c) => c.id === 1);
      c1.lines.push({ id: 9901, element_type: "QA-Тип", mark: "QA-Z1", quantity: 4 });
      const st0 = [[901, "planned"], [902, "planned"], [903, "planned"], [904, "planned"], [905, "shipped"], [906, "delivered"]];
      for (const [id, st] of st0) {
        d.elements.push({ id, object_id: 1, contract_id: null, element_type: "QA-Тип", mark: "QA-Z1", current_status: st, project_delivery_date: null, project_smr_start_date: null, planned_delivery_date: null, actual_delivery_date: null, updated_at: "2026-09-12 09:00:00" });
      }
      const before = JSON.stringify(d.elements.filter((e) => e.id < 900));
      const list = await (await a.win.fetch("/contracts")).json();
      const cont = list.find((c) => c.id === 1);
      stub(a);
      await openWs(a, "ws-picker");
      frameWin(a).__cands = st0.map(([id, st]) => [id, st, null]);
      frameWin(a).__send({ proto: "zhbi-scene/1", evt: "picker", model: { slicers: [], metrics: [], contracts: [{ name: cont.counterparty_short_name, total: 0, linked: 0, inSlice: true, over: false,
        rows: [{ id: 1, label: "Д · С", name: cont.name, total: 0, linked: 0, remainder: 0, inSlice: true, on: false, over: false }] }], unlinked: 0, unlinkedOn: false, contractSelected: 0, selectionActive: false, base: 8, highlightUnlinked: false, noneValue: "__none__" } });
      await waitFor(() => a.byText(".ws-tabs button", "Распределение"), { what: "вкладка «Распределение»" });
      a.click(a.byText(".ws-tabs button", "Распределение"));
      await waitFor(() => a.$("select[data-al=supplier]"), { what: "шаг 1: поставщик" });
      t.eq(a.$$("select[data-al=supplier] option").map((o) => o.textContent).slice(1), [cont.counterparty_short_name], "в списке — поставщики контрактов объекта");
      a.setValue(a.$("select[data-al=supplier]"), cont.counterparty_short_name);
      await waitFor(() => a.$("[data-al-c]"), { what: "шаг 2: контракты" });
      t.has(a.$("#ws-panel-body").textContent, "всего, шт.", "у чисел подписи и единицы");
      a.click(a.$("[data-al-c=\"1\"]"));
      await waitFor(() => a.byText("[data-al-l]", "QA-Z1"), { what: "шаг 3: марки" });
      const lineBtn = a.byText("[data-al-l]", "QA-Z1");
      t.eq(lineBtn.querySelectorAll("em").length, 3, "у позиции три числа: всего, распределено, доступно");
      t.eq(lineBtn.querySelectorAll("em")[2].textContent.trim(), "4", "доступно = 4 (с сервера)");
      a.click(lineBtn);
      await waitFor(() => cmds(a).some((c) => c.cmd === "pickerCandidates"), { what: "запрос кандидатов" });
      t.eq(cmds(a).find((c) => c.cmd === "pickerCandidates").args, { elementType: "QA-Тип", mark: "QA-Z1" }, "кандидаты запрошены по типу и марке позиции");
      await waitFor(() => /«Запланирован» — 4 /.test(a.$("#ws-panel-body").textContent), { what: "число кандидатов" });
      t.has(a.$("#ws-panel-body").textContent, "Изделий этой позиции без контракта: 6", "кандидаты — изделия позиции без контракта (любой статус)");
      t.has(a.$("#ws-panel-body").textContent, "в других статусах — 2 (статус сохранится, назначится контракт)", "прочие статусы входят в распределение и сохраняются");
      a.click(a.byText("[data-al=pick]", "Выбрать"));
      await waitFor(() => cmds(a).some((c) => c.cmd === "pickerSelectIds"), { what: "выбор на схеме" });
      t.eq(cmds(a).find((c) => c.cmd === "pickerSelectIds").args, { ids: [901, 902, 903, 904] }, "«Выбрать» берёт не больше остатка (4 из 6), запланированные первыми");
      // смешанная пачка: 2 «Запланирован» + 1 «Отгружен»
      const mixed = [{ id: 901, current_status: "planned" }, { id: 902, current_status: "planned" }, { id: 905, current_status: "shipped" }]
        .map((x) => ({ ...x, mark: "QA-Z1", element_type: "QA-Тип", contract_id: null }));
      frameWin(a).__emit({ multiItems: mixed });
      await waitFor(() => /Выделено: 3; подходят: 3/.test(a.$("#ws-panel-body").textContent), { what: "итог по смешанной пачке" });
      t.has(a.$("#ws-panel-body").textContent, "«Запланирован» → «Контрактация»: 2 шт.; остальные сохраняются: 1 шт.", "показано, что изменится в статусах");
      t.has(a.$("#ws-panel-body").textContent, "4 → 1 шт.", "показано: было доступно → станет");
      // превышение остатка и чужая позиция: интерфейс не даёт отправить
      frameWin(a).__emit({ multiItems: [901, 902, 903, 904, 905].map((id) => ({ id, mark: "QA-Z1", element_type: "QA-Тип", current_status: id === 905 ? "shipped" : "planned", contract_id: null })) });
      await waitFor(() => /больше доступного остатка/.test(a.$("#ws-panel-body").textContent), { what: "предупреждение о превышении" });
      t.ok(a.$("[data-al=submit]").disabled, "сверх остатка кнопка «Распределить» недоступна");
      frameWin(a).__emit({ multiItems: [
        { id: 901, mark: "QA-Z1", element_type: "QA-Тип", current_status: "planned", contract_id: null },
        { id: 902, mark: "QA-Z1", element_type: "QA-Тип", current_status: "contracting", contract_id: 2 },
        { id: 101, mark: "QA-К1", element_type: "Колонна", current_status: "delivered", contract_id: 1 }] });
      await waitFor(() => /другой позиции/.test(a.$("#ws-panel-body").textContent), { what: "причины исключения" });
      t.has(a.$("#ws-panel-body").textContent, "уже с контрактом", "изделие с контрактом не распределяется");
      t.ok(a.$("[data-al=submit]").disabled, "смешанное выделение: пачка не отправляется (выбор молча не сужается)");
      a.click(a.byText("[data-al=keep]", "Оставить только подходящие (1)"));
      await waitFor(() => cmds(a).filter((c) => c.cmd === "pickerSelectIds").length >= 2, { what: "явное сужение выделения" });
      t.eq(cmds(a).filter((c) => c.cmd === "pickerSelectIds").pop().args, { ids: [901] }, "сужение — только по явной команде человека");
      // Разрешено ли распределение ТЕКУЩИМ шлюзом: выключено — проверяем отказ на экране, включено — весь сценарий записи (с настоящим шлюзом или без него)
      const gate = await import("/static/v2/write-gate.js");
      const allowedByGate = gate.POLICY.length === 0 || gate.checkWrite("POST", "/contracts/1/allocations", { object_id: 1, element_type: "x", mark: null, items: [{ element_id: 1, expected_status: "planned" }] }).allowed;
      if (!allowedByGate) {
        frameWin(a).__emit({ multiItems: mixed });
        await waitFor(() => /Выделено: 3; подходят: 3/.test(a.$("#ws-panel-body").textContent), { what: "пачка" });
        t.ok(a.$("[data-al=submit]").disabled, "шлюз: «Распределить» недоступно");
        t.has(a.$("#ws-panel-body .ws-warnbox").textContent, "отключено", "причина названа");
        t.has(a.$("#ws-panel-body .ws-warnbox a").getAttribute("href"), "ui=v1&object_id=1&ws=picker", "ссылка в V1 несёт объект и рабочее место");
        t.eq(a.ctl.log.filter((e) => e.method === "POST" && /allocations/.test(e.path)).length, 0, "ничего не отправлено");
        a.close();
        return;
      }
      // ---- запись (стенд с разрешающим шлюзом)
      frameWin(a).__emit({ multiItems: mixed });
      await waitFor(() => /Выделено: 3; подходят: 3/.test(a.$("#ws-panel-body").textContent) && !a.$("[data-al=submit]").disabled, { what: "кнопка распределения" });
      const posts = () => a.ctl.log.filter((e) => e.method === "POST" && /allocations/.test(e.path));
      // 1) расхождение: изделие получило контракт у другого пользователя после открытия формы → конфликт, ничего не применено
      d.elements.find((e) => e.id === 902).contract_id = 2; d.elements.find((e) => e.id === 902).current_status = "contracting";
      a.click(a.$("[data-al=submit]"));
      const dlg = await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(dlg.textContent, "QA-Z1", "в подтверждении — марка"); t.has(dlg.textContent, "Изделий: 3 шт.", "количество");
      t.has(dlg.textContent, cont.counterparty_short_name, "поставщик"); t.has(dlg.textContent, cont.name, "контракт");
      t.has(dlg.textContent, "«Запланирован» → «Контрактация» — 2 шт.; остальные сохраняются — 1 шт.", "статусы");
      await a.answerDialog("Распределить");
      await waitFor(() => /уже получили контракт/.test(a.$("#ws-panel-body .ws-err")?.textContent || ""), { what: "конфликт" });
      t.eq(d.elements.filter((e) => [901, 905].includes(e.id)).map((e) => [e.current_status, e.contract_id]), [["planned", null], ["shipped", null]], "при конфликте подходящая часть НЕ применена молча");
      t.eq(d.elements.find((e) => e.id === 902).contract_id, 2, "контракт другого пользователя не перезаписан");
      await waitFor(() => cmds(a).some((c) => c.cmd === "reload"), { what: "перечитывание схемы после конфликта" });
      // вернуть состояние и выделить заново
      d.elements.find((e) => e.id === 902).contract_id = null; d.elements.find((e) => e.id === 902).current_status = "planned";
      frameWin(a).__emit({ multiItems: mixed });
      await waitFor(() => /подходят: 3/.test(a.$("#ws-panel-body").textContent) && !a.$("[data-al=submit]").disabled, { what: "новое выделение" });
      // 2) потеря ответа ДО commit (сеть): исход проверяется чтением, повтор не отправляется
      a.ctl.failNext("POST /contracts", { network: true });
      a.click(a.$("[data-al=submit]")); await a.answerDialog("Распределить");
      await waitFor(() => /не подтверждено/.test(a.$("#ws-panel-body .ws-err")?.textContent || ""), { what: "неизвестный исход" });
      t.eq(posts().length, 2, "после потери ответа запрос не повторён автоматически (1 конфликт + 1 сбой)");
      t.ok(a.ctl.log.some((e) => e.method === "GET" && /\/elements\/901$/.test(e.path)) && a.ctl.log.some((e) => e.method === "GET" && /\/elements\/905$/.test(e.path)), "исход проверен чтением первого и последнего изделия");
      // 3) успех + двойной клик: одна запись
      const hold = a.ctl.hold("POST /contracts");
      a.click(a.$("[data-al=submit]")); await a.answerDialog("Распределить");
      await hold.waitForRequest(1, 3000);
      t.ok(a.$("[data-al=submit]").disabled && a.$("select[data-al=supplier]").disabled, "на время записи всё заблокировано");
      a.click(a.$("[data-al=submit]"));
      hold.release();
      await waitFor(() => /Распределено: 3 шт\./.test(a.$("#ws-panel-body .ws-ok")?.textContent || ""), { what: "подтверждение результата" });
      t.eq(posts().length, 3, "двойной клик не размножил запрос");
      t.eq(posts()[2].body, { object_id: 1, element_type: "QA-Тип", mark: "QA-Z1", items: [{ element_id: 901, expected_status: "planned" }, { element_id: 902, expected_status: "planned" }, { element_id: 905, expected_status: "shipped" }] },
        "тело: одна пачка с ожидаемым статусом каждого изделия");
      t.eq(d.elements.filter((e) => [901, 902, 905].includes(e.id)).map((e) => [e.current_status, e.contract_id]), [["contracting", 1], ["contracting", 1], ["shipped", 1]], "у сервера: «Запланирован» → «Контрактация», «Отгружен» сохранён, контракт у всех");
      t.eq(JSON.stringify(d.elements.filter((e) => e.id < 900)), before, "прочие изделия не изменены");
      t.eq(d.elements.filter((e) => [903, 904, 906].includes(e.id)).map((e) => e.contract_id), [null, null, null], "невыбранные изделия позиции не тронуты");
      await waitFor(() => cmds(a).some((c) => c.cmd === "applyElements"), { what: "обновление схемы" });
      t.eq(cmds(a).find((c) => c.cmd === "applyElements").args.items.map((i) => [i.id, i.current_status, i.contract_id]), [[901, "contracting", 1], [902, "contracting", 1], [905, "shipped", 1]], "схема получает то, что вернул сервер");
      t.has(a.$("#ws-panel-body .ws-ok").textContent, "Остаток по позиции: 1 шт.", "остаток — из ответа сервера");
      await waitFor(() => a.byText("[data-al-l]", "QA-Z1")?.querySelectorAll("em")[1]?.textContent.trim() === "3", { what: "остатки перечитаны" });
      t.eq(a.byText("[data-al-l]", "QA-Z1").querySelectorAll("em")[2].textContent.trim(), "1", "доступно 1 (перечитано с сервера)");
      t.ok(cmds(a).some((c) => c.cmd === "clearSelection"), "выделение снято");
      // 4) потеря ответа ПОСЛЕ commit: запись состоялась, ответ потерян → сверка с сервером, повторной записи нет
      frameWin(a).__emit({ multiItems: [{ id: 903, mark: "QA-Z1", element_type: "QA-Тип", current_status: "planned", contract_id: null }] });
      await waitFor(() => /подходят: 1/.test(a.$("#ws-panel-body").textContent) && !a.$("[data-al=submit]").disabled, { what: "выделение одного" });
      const realFetch = a.win.fetch;
      a.win.fetch = async (u, o) => { const r = await realFetch(u, o); if (o && o.method === "POST" && /allocations/.test(String(u))) throw new TypeError("network lost"); return r; };
      a.click(a.$("[data-al=submit]")); await a.answerDialog("Распределить");
      await waitFor(() => /сервер подтвердил: распределение применено/.test(a.$("#ws-panel-body .ws-ok")?.textContent || ""), { what: "сверка после потери ответа" });
      a.win.fetch = realFetch;
      t.eq(posts().length, 4, "после потери ответа запись не повторялась");
      t.eq(d.elements.find((e) => e.id === 903).contract_id, 1, "изделие распределено ровно один раз");
      a.close();
    },
  },
  {
    id: "WS-12", title: "Распределение (серверные правила на фейковом бэкенде): всё или ничего, остаток, повтор, устаревшее выделение, чужой объект/контракт, права",
    async run(t) {
      const a = await openApp({ home: true });
      const d = a.ctl.data;
      d.contracts.find((c) => c.id === 1).lines.push({ id: 9902, element_type: "QA-Тип", mark: "QA-Z2", quantity: 2 });
      for (const id of [911, 912, 913]) d.elements.push({ id, object_id: 1, contract_id: null, element_type: "QA-Тип", mark: "QA-Z2", current_status: "planned", project_delivery_date: null, project_smr_start_date: null, planned_delivery_date: null, actual_delivery_date: null, updated_at: "2026-09-12 09:00:00" });
      const call = async (cid, ids, extra = {}) => { const r = await a.win.fetch(`/contracts/${cid}/allocations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object_id: 1, element_type: "QA-Тип", mark: "QA-Z2", items: ids.map((id) => ({ element_id: id, expected_status: "planned" })), ...extra }) }); return [r.status, await r.json()]; };
      const over = await call(1, [911, 912, 913]);
      t.eq(over[0], 409, "3 изделия при остатке 2 — отказ сервера");
      t.eq(d.elements.filter((e) => [911, 912, 913].includes(e.id)).map((e) => [e.current_status, e.contract_id]), [["planned", null], ["planned", null], ["planned", null]], "пачка не применена частично (всё или ничего)");
      const dup = await call(1, [911, 911]);
      t.eq(dup[0], 400, "дубли идентификаторов — 400, без изменений");
      const foreign = await call(2, [911]);
      t.ok(foreign[0] === 409 || foreign[0] === 400, "контракт без позиции под марку или другого объекта — отказ");
      const ok = await call(1, [911, 912]);
      t.eq(ok[0], 200, "ровно по остатку — принято");
      t.eq(ok[1].position.remaining, 0, "остаток в ответе — 0");
      const again = await call(1, [911, 912]);
      t.ok(again[0] === 200 && again[1].already_applied === true && again[1].applied.length === 0, "повторная отправка — already_applied, без повторной записи");
      t.eq(d.elements.find((e) => e.id === 911).history_rows.length, 2, "история не задвоена (исходная + «Контрактация»)");
      const last = await call(1, [913]);
      t.eq(last[0], 409, "остаток исчерпан — следующая привязка отклонена");
      d.elements.find((e) => e.id === 913).current_status = "shipped";
      const stale = await call(1, [913]);
      t.eq(stale[0], 409, "изменившийся статус — конфликт, а не подгонка");
      a.close();
    },
  },
];

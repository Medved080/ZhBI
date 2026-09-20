// Экраны «только чтение» полного интерфейса (RD-*): справочники, списки, журналы. Стенд — фейковый бэкенд
// с формой ответов настоящего backend (проверка на настоящем backend — отдельно, живой приёмкой).
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const body = (a) => a.$("#rd-body");
const loaded = (a) => body(a) && !/Загрузка/.test(body(a).textContent);

async function readScreens() {
  const reg = await (await fetch("/static/v2/screens.json", { cache: "no-cache" })).json();
  return reg.screens.filter((s) => s.impl === "read");
}
async function openScreen(a, id) {
  const title = (await readScreens()).find((s) => s.id === id).title;
  await waitFor(() => a.$(`${NAV}[data-section="${id}"]`), { what: `навигация: ${id}` });
  a.click(a.$(`${NAV}[data-section="${id}"]`));
  // заголовок нового экрана — иначе можно принять за «загруженный» предыдущий экран
  await waitFor(() => a.$(".v2-screen h2")?.textContent.trim() === title && loaded(a), { what: `загрузка экрана ${id}` });
}

export const tests = [
  {
    id: "RD-01", title: "Каждый экран чтения открывается из навигации и показывает присланные данные; ошибок и записей нет",
    async run(t) {
      const a = await openApp({ home: true });
      const screens = await readScreens();
      t.ok(screens.length >= 20, `экранов чтения в реестре: ${screens.length}`);
      await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
      const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
      const check = async (s) => {
        await waitFor(() => a.$(`${NAV}[data-section="${s.id}"]`), { what: `в навигации есть ${s.id}` });
        a.click(a.$(`${NAV}[data-section="${s.id}"]`));
        await waitFor(() => loaded(a) && a.$(".v2-screen h2")?.textContent.trim() === s.title, { what: `экран ${s.id}` });
        t.ok(!a.$(".v2-callout-bad"), `${s.id}: нет ошибки загрузки`);
        const shown = a.$$("#rd-body tbody tr").length + a.$$("#rd-body dt").length;
        t.ok(shown > 0 || /нет|пуст|Записей нет|не найден/i.test(body(a).textContent), `${s.id}: показаны строки/поля или явное «пусто» (${shown})`);
        t.ok(a.$(`a[data-v1-link]`), `${s.id}: есть переход в текущий интерфейс`);
      };
      // экраны учёта по блокам есть только у объекта МФР: сначала всё, что доступно на исходном объекте, затем — на МФР
      const later = [];
      for (const s of screens) { if (a.$(`${NAV}[data-section="${s.id}"]`)) await check(s); else later.push(s); }
      t.ok(later.length === 0 || !!mfr, "для экранов, скрытых на исходном объекте, в стенде есть объект МФР");
      if (later.length && mfr) {
        a.setValue(a.$("#v2-object"), String(mfr.id));
        await waitFor(() => a.$(`${NAV}[data-section="${later[0].id}"]`), { what: "экраны МФР доступны после смены объекта" });
        for (const s of later) await check(s);
      }
      // отчёты запрашиваются POST-ом, но это чтение: разрешён только /reports/*
      const writes = a.ctl.log.filter((e) => e.method !== "GET" && !(e.method === "POST" && /^\/reports\/[a-z0-9-]+$/.test(e.path)));
      t.eq(writes.map((e) => `${e.method} ${e.path}`), [], "во время просмотра не отправлено ни одного изменяющего запроса (кроме чтения отчётов)");
      t.eq(a.errors?.length || 0, 0, "нет необработанных JS-ошибок");
    },
  },
  {
    id: "RD-02", title: "Данные совпадают с присланными: формы маркеров, вкладки зон",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "marker-shapes");
      const shown = a.$$("#rd-body tbody tr").map((tr) => `${tr.children[0].textContent.trim()}→${tr.children[1].textContent.trim()}`);
      t.eq(shown, ["QA_слой_1→Колонна", "QA_слой_2→Плита перекрытия", "QA_слой_3→Ригель"], "сочетания слой→тип совпадают с ответом сервера");
      t.has(a.$("#rd-count").textContent, "Записей: 3", "счётчик записей");
      await openScreen(a, "zones");
      t.eq(a.$$(".v2-read-tab").map((b) => b.textContent.trim()), ["Захватки", "Зоны кранов", "Стоянки кранов"], "три вкладки зон");
      t.eq(a.$$("#rd-body tbody tr").length, 2, "захватки: две зоны");
      a.click(a.$$(".v2-read-tab")[1]);
      await waitFor(() => loaded(a) && a.$$("#rd-body tbody tr").length === 1, { what: "краны" });
      a.click(a.$$(".v2-read-tab")[2]);
      await waitFor(() => loaded(a) && /Зон категории «Стоянка» нет/.test(body(a).textContent), { what: "пусто у стоянок" });
      t.eq(a.$$(".v2-read-tab").map((b) => b.getAttribute("aria-selected")), ["false", "false", "true"], "выбрана третья вкладка");
    },
  },
  {
    id: "RD-03", title: "Ошибка загрузки: текст сервера и «Повторить»; поиск сохраняется; после успеха таблица",
    async run(t) {
      const a = await openApp({ home: true });
      a.ctl.failNext("GET /layer-type-combinations", { status: 500, detail: "База недоступна (QA)" });
      await waitFor(() => a.$(`${NAV}[data-section="marker-shapes"]`), { what: "навигация" });
      a.click(a.$(`${NAV}[data-section="marker-shapes"]`));
      await waitFor(() => a.$(".v2-callout-bad"), { what: "сообщение об ошибке" });
      t.has(a.$(".v2-callout-bad").textContent, "База недоступна (QA)", "показан текст ошибки сервера");
      t.ok(!a.$("#rd-body tbody"), "таблицы нет, ложных данных нет");
      a.click(a.$("#rd-retry"));
      await waitFor(() => a.$$("#rd-body tbody tr").length > 0, { what: "повтор загрузил данные" });
      t.ok(!a.$(".v2-callout-bad"), "после успешного повтора ошибки нет");
      t.eq(a.ctl.count("GET", "/layer-type-combinations"), 2, "ровно два запроса: неудачный и повторный");
    },
  },
  {
    id: "RD-04", title: "Пусто и «ничего не найдено» — разные сообщения; поиск фильтрует и считает",
    async run(t) {
      const a = await openApp({ home: true });
      a.ctl.data.settings.layerCombos = [];
      await openScreen(a, "marker-shapes");
      t.has(body(a).textContent, "Сочетаний нет.", "пустой справочник назван пустым");
      a.ctl.data.settings.layerCombos = [{ layer: "АЛ", element_type: "Альфа-тип", shape: "outline" }, { layer: "БТ", element_type: "Бета-тип", shape: "outline" }];
      a.click(a.$("#rd-refresh"));
      await waitFor(() => a.$$("#rd-body tbody tr").length === 2, { what: "обновление подхватило записи" });
      await a.type(a.$("#rd-search"), "альфа");
      await a.settle(60);
      t.eq(a.$$("#rd-body tbody tr").length, 1, "поиск оставил одну строку");
      t.has(a.$("#rd-count").textContent, "Найдено 1 из 2", "счётчик поиска");
      await a.type(a.$("#rd-search"), "яяя", { clear: true });
      await a.settle(60);
      t.has(body(a).textContent, "Ничего не найдено по запросу «яяя»", "сообщение «ничего не найдено»");
    },
  },
  {
    id: "RD-05", title: "Запоздавший ответ прежней вкладки не подменяет таблицу текущей",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "zones");
      const hold = a.ctl.hold("GET /zones");
      a.click(a.$$(".v2-read-tab")[1]); // краны — запрос удержан
      await a.settle(60);
      a.click(a.$$(".v2-read-tab")[2]); // стоянки — тоже удержан
      await a.settle(60);
      hold.release();
      await waitFor(() => a.$$(".v2-read-tab")[2].getAttribute("aria-selected") === "true" && loaded(a), { what: "ответы пришли" });
      await a.settle(120);
      t.has(body(a).textContent, "Зон категории «Стоянка» нет.", "видна таблица стоянок, а не кранов");
      t.eq(a.$$("#rd-body tbody tr").length, 0, "строк кранов на экране нет");
      hold.dispose?.();
    },
  },
  {
    id: "RD-06", title: "Повторные клики «Обновить» — один запрос; кнопка недоступна, пока идёт загрузка",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "marker-shapes");
      const before = a.ctl.count("GET", "/layer-type-combinations");
      const hold = a.ctl.hold("GET /layer-type-combinations");
      a.click(a.$("#rd-refresh"));
      await a.settle(40);
      t.eq(a.click(a.$("#rd-refresh")), false, "повторный клик невозможен: кнопка заблокирована");
      t.eq(a.click(a.$("#rd-refresh")), false, "и третий тоже");
      hold.release();
      await waitFor(() => loaded(a) && !a.$("#rd-refresh").disabled, { what: "загрузка завершена" });
      t.eq(a.ctl.count("GET", "/layer-type-combinations") - before, 1, "ушёл ровно один запрос");
      hold.dispose?.();
    },
  },
  {
    id: "RD-07", title: "Экран объекта: запрос с id выбранного объекта; смена объекта в шапке перезагружает экран",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "schedule");
      const sel = a.$("#v2-object");
      const first = Number(sel.value);
      const reqFirst = a.ctl.log.filter((e) => e.path.startsWith("/schedule-versions"));
      t.ok(reqFirst.some((e) => e.path.includes(`object_id=${first}`)), "запрос ушёл с id выбранного объекта");
      const other = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== first);
      a.setValue(sel, String(other));
      await waitFor(() => a.ctl.log.some((e) => e.path.startsWith("/schedule-versions") && e.path.includes(`object_id=${other}`)), { what: "перезагрузка под другим объектом" });
      await waitFor(() => loaded(a), { what: "данные нового объекта" });
      t.has(a.$("#rd-body").textContent, "QA-график", "показаны данные объекта");
      // объект запомнен на время сеанса вкладки и НЕ записан на сервер
      t.eq(a.ctl.log.filter((e) => e.method === "PUT").length, 0, "выбор объекта не записывается на сервер");
    },
  },
  {
    id: "RD-08", title: "Постраничный журнал: первая страница, «Дальше»/«Назад», поиск на сервере",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "activity");
      t.eq(a.$$("#rd-body tbody tr").length, 100, "первая страница — 100 строк");
      t.has(a.$("#rd-count").textContent, "250", "общее число записей из ответа");
      t.ok(a.$("#rd-prev").disabled, "«Назад» недоступна на первой странице");
      a.click(a.$("#rd-next"));
      await waitFor(() => a.ctl.log.some((e) => e.path.includes("offset=100")) && loaded(a), { what: "вторая страница" });
      t.ok(a.$$("#rd-body tbody tr")[0].textContent.includes("М-150"), "на второй странице строки 101–200");
      a.click(a.$("#rd-prev"));
      await waitFor(() => a.$$("#rd-body tbody tr")[0]?.textContent.includes("М-250"), { what: "возврат на первую" });
      await a.type(a.$("#rd-search"), "М-25");
      await waitFor(() => a.ctl.log.some((e) => e.path.includes("text=")), { what: "поиск ушёл на сервер", timeout: 3000 });
      await waitFor(() => loaded(a) && a.$$("#rd-body tbody tr").length > 0 && a.$$("#rd-body tbody tr").length < 100, { what: "результат поиска" });
      t.has(a.$("#rd-count").textContent, "Найдено на сервере", "счётчик говорит, что поиск серверный");
      // при вводе «М-25» поиск один (после паузы), а не по запросу на букву
      t.ok(a.ctl.log.filter((e) => e.path.includes("text=")).length <= 2, "запросов поиска немного (пауза после ввода)");
    },
  },
  {
    id: "RD-09", title: "Права: экраны, требующие ролей, скрыты пользователю без прав; экраны без ограничений видны",
    async run(t) {
      const a = await openApp({ perm: "none", home: true });
      await waitFor(() => a.$$(NAV).length >= 1, { what: "навигация" });
      const keys = a.$$(NAV).map((b) => b.dataset.section);
      for (const k of ["backups", "ldap", "activity", "db-status"]) t.ok(!keys.includes(k), `${k}: административный экран скрыт без прав`);
      t.ok(keys.includes("changelog") || keys.includes("statuslog"), "экраны без ограничений по разделам доступны");
    },
  },
  {
    id: "RD-10", title: "Отчёт «Статус монтажа»: дерево — значения и итог из ответа, сворачивание узлов, чтение не блокирует переходы",
    async run(t) {
      const a = await openApp({ home: true });
      const hold = a.ctl.hold("POST /reports/status");
      await waitFor(() => a.$(`${NAV}[data-section="report-status"]`), { what: "навигация" });
      a.click(a.$(`${NAV}[data-section="report-status"]`));
      await waitFor(() => a.ctl.log.some((e) => e.path === "/reports/status"), { what: "запрос отчёта ушёл" });
      t.eq(a.$("#v2-nav-note").textContent, "", "чтение отчёта POST-ом не показывает «идёт сохранение»");
      t.ok(!a.$(`${NAV}[data-section="home"]`).disabled, "переходы не заблокированы во время чтения отчёта");
      const req = a.ctl.log.find((e) => e.path === "/reports/status");
      t.ok(req.body.object_id > 0, "запрос отчёта с id выбранного объекта");
      hold.release();
      await waitFor(() => a.$$("#rd-body tbody tr").length > 0, { what: "дерево отчёта" });
      const text = () => body(a).textContent.replace(/\s+/g, " ");
      t.has(text(), "Захватка 1", "первая захватка видна");
      t.has(text(), "Колонна нижняя", "первая захватка развёрнута (как в V1)");
      t.ok(!text().includes("2 этаж"), "вторая захватка свёрнута");
      const toggle = a.$$(".v2-tree-toggle").find((b) => b.dataset.path === "Захватка 2");
      a.click(toggle);
      await waitFor(() => text().includes("2 этаж"), { what: "вторая захватка развёрнута" });
      t.eq([...a.$$("tr.lvl-total")[0].children].map((td) => td.textContent.trim()), ["В проекте", "11", "6", "4", "2", "22"], "итоговая строка совпадает с ответом");
      hold.dispose?.();
    },
  },
  {
    id: "RD-11", title: "Отчёт «Статус комплектации»: страницы по 200, поиск на клиенте, предупреждение сервера показано",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "report-completion");
      await waitFor(() => a.$$("#rd-body tbody tr").length > 0, { what: "перечень" });
      t.eq(a.$$("#rd-body tbody tr").length, 200, "первая страница — 200 строк");
      t.has(body(a).textContent, "QA-предупреждение о требуемой дате", "предупреждение сервера показано");
      t.has(body(a).textContent, "Позиций: 450", "общее число позиций");
      t.ok(!body(a).textContent.includes("GUID"), "служебная колонка GUID не показывается");
      a.click(a.$("[data-page=next]"));
      await waitFor(() => a.$$("#rd-body tbody tr")[0]?.textContent.includes("К-201"), { what: "вторая страница" });
      await a.type(a.$("#rd-search"), "К-45");
      await waitFor(() => /Найдено \d+ из 450/.test(body(a).textContent), { what: "поиск" });
      t.ok(a.$$("#rd-body tbody tr").length < 200, "поиск сузил перечень");
      t.eq(a.ctl.count("POST", "/reports/completion"), 1, "поиск по перечню без нового запроса к серверу");
    },
  },
  {
    id: "RD-12", title: "Аналитическая справка: смена горизонта перезапрашивает отчёт с новым параметром; ошибка отчёта — понятное сообщение",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "report-analytics");
      await waitFor(() => a.$("select[data-param=horizon_days]"), { what: "элементы управления" });
      t.has(body(a).textContent, "QA-вывод", "вывод справки показан");
      a.setValue(a.$("select[data-param=horizon_days]"), "14");
      await waitFor(() => a.ctl.log.filter((e) => e.path === "/reports/analytics").length === 2, { what: "второй запрос" });
      t.eq(a.ctl.log.filter((e) => e.path === "/reports/analytics")[1].body.horizon_days, 14, "в запросе новый горизонт");
      await waitFor(() => body(a).textContent.includes("горизонт до 2026-10-14".replace("2026-10-14", "14.10.2026")) || body(a).textContent.includes("14.10.2026"), { what: "справка пересчитана" });
      a.ctl.failNext("POST /reports/analytics", { status: 500, detail: "Сбой расчёта (QA)" });
      a.setValue(a.$("select[data-param=horizon_days]"), "30");
      await waitFor(() => a.$(".v2-callout-bad"), { what: "сообщение об ошибке отчёта" });
      t.has(a.$(".v2-callout-bad").textContent, "Сбой расчёта (QA)", "показан текст ошибки");
    },
  },
  {
    id: "RD-13", title: "«Моя работа»: период по умолчанию — сегодня, границы дня в UTC уходят в запрос, смена периода перезапрашивает",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "report-mywork");
      await waitFor(() => a.$$("#rd-body tbody tr").length === 3, { what: "события" });
      const req = a.ctl.log.filter((e) => e.path === "/reports/my-work")[0].body;
      const now = new Date(); const p = (n) => String(n).padStart(2, "0");
      const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      t.eq([req.date_from, req.date_to], [today, today], "период по умолчанию — сегодня (местная дата)");
      t.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.000$/.test(req.at_from) && /\.999$/.test(req.at_to), "границы суток в UTC с миллисекундами, как в V1");
      t.eq([req.all_users, req.user_ids], [false, null], "запрос только по себе");
      t.has(body(a).textContent, "Событий: 3", "счётчик событий из ответа");
      a.setValue(a.$("input[data-param=date_from]"), "2026-09-01");
      await waitFor(() => a.ctl.log.filter((e) => e.path === "/reports/my-work").length === 2, { what: "перезапрос" });
      t.eq(a.ctl.log.filter((e) => e.path === "/reports/my-work")[1].body.date_from, "2026-09-01", "новая начальная дата в запросе");
    },
  },
  {
    id: "RD-14", title: "«Учёт по блокам: статусы»: матрица операция × блок — шапка секций, проценты из ответа, «Показать все» добавляет операции без данных; смена даты перезапрашивает",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
      const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
      a.setValue(a.$("#v2-object"), String(mfr.id));
      await openScreen(a, "report-block-status");
      await waitFor(() => a.$(".v2-matrix"), { what: "матрица" });
      t.eq(a.$$(".v2-matrix thead tr:first-child th").map((th) => th.textContent.trim()).slice(3), ["С01", "С02"], "в шапке — секции");
      t.eq(a.$$(".v2-matrix thead tr:first-child th")[3].getAttribute("colspan"), "2", "секция С01 занимает два столбца (два этажа)");
      const bodyRows = () => a.$$(".v2-matrix tbody tr").map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      t.eq(bodyRows().map((r) => r[0]), ["180-02-02", "130-01-01"], "по умолчанию только операции с данными");
      t.eq(bodyRows()[0].slice(3), ["40", "0", ""], "проценты по блокам из ответа");
      t.eq(bodyRows()[1][2], "план", "ячейка «объект» показывает статус словами");
      a.click(a.$("#bs-all"));
      await waitFor(() => bodyRows().length === 3, { what: "все операции" });
      a.setValue(a.$("input[data-param=report_date]"), "2026-09-01");
      await waitFor(() => a.ctl.log.filter((e) => e.path === "/reports/block-status").length === 2, { what: "перезапрос с датой" });
      t.eq(a.ctl.log.filter((e) => e.path === "/reports/block-status")[1].body.report_date, "2026-09-01", "новая дата в запросе");
    },
  },
  {
    id: "RD-15", title: "Выгрузка отчёта в файл: тот же запрос, что у отчёта на экране; файл формируется; сбой — сообщение; не считается записью; у «Линейного трека» только XLSX",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "report-status");
      await waitFor(() => a.$("[data-export=xlsx]"), { what: "кнопки выгрузки" });
      t.eq(a.$$("[data-export]").map((b) => b.dataset.export), ["xlsx", "pdf"], "у «Статуса монтажа» XLSX и PDF");
      const made = [];
      const orig = a.win.URL.createObjectURL.bind(a.win.URL);
      a.win.URL.createObjectURL = (blob) => { made.push(blob); return orig(blob); };
      const hold = a.ctl.hold("POST /reports/status.xlsx");
      a.click(a.$("[data-export=xlsx]"));
      await hold.waitForRequest(1, 3000);
      t.ok(a.$("[data-export=xlsx]").disabled && a.$("[data-export=pdf]").disabled, "на время выгрузки кнопки заблокированы");
      t.eq(a.click(a.$("[data-export=xlsx]")), false, "второй клик невозможен");
      t.eq(a.$("#v2-nav-note").textContent, "", "выгрузка отчёта не «идёт сохранение»");
      hold.release();
      await waitFor(() => /сформирован/.test(a.$("#rd-export-status").textContent), { what: "файл сформирован" });
      const view = a.ctl.log.find((e) => e.path === "/reports/status");
      const exp = a.ctl.log.filter((e) => e.path === "/reports/status.xlsx");
      t.eq(exp.length, 1, "один запрос выгрузки");
      t.eq(exp[0].body, view.body, "тело выгрузки = тело отчёта на экране");
      t.eq(made.length, 1, "создан один файл для скачивания");
      t.ok(made[0].size > 0, "файл не пустой");
      hold.dispose?.();
      a.ctl.failNext("POST /reports/status.pdf", { status: 500, detail: "Сбой выгрузки (QA)" });
      a.click(a.$("[data-export=pdf]"));
      await waitFor(() => /Не удалось выгрузить/.test(a.$("#rd-export-status").textContent), { what: "сообщение о сбое" });
      t.has(a.$("#rd-export-status").textContent, "Сбой выгрузки (QA)", "показан текст ошибки сервера");
      t.ok(!a.$("[data-export=pdf]").disabled, "после сбоя выгрузку можно повторить");
      const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
      a.setValue(a.$("#v2-object"), String(mfr.id));
      await openScreen(a, "report-linear-track");
      await waitFor(() => a.$("[data-export]"), { what: "кнопки выгрузки трека" });
      t.eq(a.$$("[data-export]").map((b) => b.dataset.export), ["xlsx"], "у «Линейного трека» только XLSX");
    },
  },
];

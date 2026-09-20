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
      for (const s of screens) {
        await waitFor(() => a.$(`${NAV}[data-section="${s.id}"]`), { what: `в навигации есть ${s.id}` });
        a.click(a.$(`${NAV}[data-section="${s.id}"]`));
        await waitFor(() => loaded(a) && a.$(".v2-screen h2")?.textContent.trim() === s.title, { what: `экран ${s.id}` });
        t.ok(!a.$(".v2-callout-bad"), `${s.id}: нет ошибки загрузки`);
        const shown = a.$$("#rd-body tbody tr").length + a.$$("#rd-body dt").length;
        t.ok(shown > 0 || /нет|пуст|Записей нет|не найден/i.test(body(a).textContent), `${s.id}: показаны строки/поля или явное «пусто» (${shown})`);
        t.ok(a.$(`a[data-v1-link]`), `${s.id}: есть переход в текущий интерфейс`);
      }
      const writes = a.ctl.log.filter((e) => e.method !== "GET");
      t.eq(writes.map((e) => `${e.method} ${e.path}`), [], "во время просмотра не отправлено ни одного изменяющего запроса");
      t.eq(a.errors?.length || 0, 0, "нет необработанных JS-ошибок");
    },
  },
  {
    id: "RD-02", title: "Данные совпадают с присланными: СМУ, контракты, вкладки зон",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "dict-smu");
      const shown = a.$$("#rd-body tbody tr").map((tr) => tr.children[1].textContent.trim()).sort();
      const expected = a.ctl.data.smu.map((r) => r.name).sort();
      t.eq(shown, expected, "названия СМУ совпадают с ответом сервера");
      t.has(a.$("#rd-count").textContent, `Записей: ${expected.length}`, "счётчик записей");
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
      a.ctl.failNext("GET /smu", { status: 500, detail: "База недоступна (QA)" });
      await waitFor(() => a.$(`${NAV}[data-section="dict-smu"]`), { what: "навигация" });
      a.click(a.$(`${NAV}[data-section="dict-smu"]`));
      await waitFor(() => a.$(".v2-callout-bad"), { what: "сообщение об ошибке" });
      t.has(a.$(".v2-callout-bad").textContent, "База недоступна (QA)", "показан текст ошибки сервера");
      t.ok(!a.$("#rd-body tbody"), "таблицы нет, ложных данных нет");
      a.click(a.$("#rd-retry"));
      await waitFor(() => a.$$("#rd-body tbody tr").length > 0, { what: "повтор загрузил данные" });
      t.ok(!a.$(".v2-callout-bad"), "после успешного повтора ошибки нет");
      t.eq(a.ctl.count("GET", "/smu"), 2, "ровно два запроса: неудачный и повторный");
    },
  },
  {
    id: "RD-04", title: "Пусто и «ничего не найдено» — разные сообщения; поиск фильтрует и считает",
    async run(t) {
      const a = await openApp({ home: true });
      a.ctl.data.smu.length = 0;
      await openScreen(a, "dict-smu");
      t.has(body(a).textContent, "Справочник СМУ пуст.", "пустой справочник назван пустым");
      a.ctl.data.smu.push({ id: 1, name: "СМУ-Альфа" }, { id: 2, name: "СМУ-Бета" });
      a.click(a.$("#rd-refresh"));
      await waitFor(() => a.$$("#rd-body tbody tr").length === 2, { what: "обновление подхватило записи" });
      await a.type(a.$("#rd-search"), "альф");
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
      await openScreen(a, "dict-smu");
      const before = a.ctl.count("GET", "/smu");
      const hold = a.ctl.hold("GET /smu");
      a.click(a.$("#rd-refresh"));
      await a.settle(40);
      t.eq(a.click(a.$("#rd-refresh")), false, "повторный клик невозможен: кнопка заблокирована");
      t.eq(a.click(a.$("#rd-refresh")), false, "и третий тоже");
      hold.release();
      await waitFor(() => loaded(a) && !a.$("#rd-refresh").disabled, { what: "загрузка завершена" });
      t.eq(a.ctl.count("GET", "/smu") - before, 1, "ушёл ровно один запрос");
      hold.dispose?.();
    },
  },
  {
    id: "RD-07", title: "Экран объекта: запрос с id выбранного объекта; смена объекта в шапке перезагружает экран",
    async run(t) {
      const a = await openApp({ home: true });
      await openScreen(a, "late-threshold");
      const sel = a.$("#v2-object");
      const first = Number(sel.value);
      const reqFirst = a.ctl.log.filter((e) => e.path.startsWith("/settings/info-plate"));
      t.ok(reqFirst.some((e) => e.path.includes(`object_id=${first}`)), "запрос ушёл с id выбранного объекта");
      const other = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== first);
      a.setValue(sel, String(other));
      await waitFor(() => a.ctl.log.some((e) => e.path.startsWith("/settings/info-plate") && e.path.includes(`object_id=${other}`)), { what: "перезагрузка под другим объектом" });
      await waitFor(() => loaded(a), { what: "данные нового объекта" });
      t.has(a.$("#rd-body").textContent, "Порог опоздания поставки", "показаны данные объекта");
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
];

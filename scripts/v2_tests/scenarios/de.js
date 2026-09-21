// Редактор простого справочника (СМУ, физлица): DE-*. Стенд — фейковый бэкенд; на настоящем backend — живая приёмка.
import { openApp, waitFor, gateIsReal } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const listLoaded = (a) => a.$("#de-body tbody") || /пуст|Записей нет/.test(a.$("#de-body")?.textContent || "");
const names = (a) => a.$$("#de-body tbody tr").map((tr) => tr.children[1].textContent.trim());
async function open(a, id = "dict-smu") {
  await waitFor(() => a.$(`${NAV}[data-section="${id}"]`), { what: `навигация ${id}` });
  a.click(a.$(`${NAV}[data-section="${id}"]`));
  await waitFor(() => a.$("#de-add-input") && a.$("#de-body tbody"), { what: `экран ${id}` });
}
const writes = (a) => a.ctl.log.filter((e) => e.method !== "GET");

export const tests = [
  {
    id: "DE-01", title: "Добавление: тело запроса обрезано, список перечитан, ввод очищен, статус из ответа сервера",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const getsBefore = a.ctl.count("GET", "/smu");
      await a.type(a.$("#de-add-input"), "  СМУ-Новое  ");
      a.click(a.$("#de-add-btn"));
      await waitFor(() => names(a).includes("СМУ-Новое"), { what: "запись в списке" });
      const post = a.ctl.log.find((e) => e.method === "POST" && e.path === "/smu");
      t.eq(post.body, { name: "СМУ-Новое" }, "в запросе название без лишних пробелов");
      t.eq(a.$("#de-add-input").value, "", "поле ввода очищено после успеха");
      t.has(a.$("#de-status").textContent, "Добавлено: «СМУ-Новое»", "статус подтверждён ответом сервера");
      t.ok(a.ctl.count("GET", "/smu") > getsBefore, "после записи справочник перечитан");
      t.eq(writes(a).length, 1, "ушёл ровно один изменяющий запрос");
    },
  },
  {
    id: "DE-02", title: "Дубликат (409): текст сервера, ввод остаётся, список не менялся",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const existing = names(a)[0];
      const before = names(a).length;
      await a.type(a.$("#de-add-input"), existing);
      a.click(a.$("#de-add-btn"));
      await waitFor(() => /уже есть/.test(a.$("#de-status").textContent), { what: "сообщение о дубле" });
      t.eq(a.$("#de-add-input").value, existing, "введённый текст не потерян");
      t.eq(names(a).length, before, "список не изменился");
      t.eq(a.doc.activeElement?.id, "de-add-input", "фокус вернулся в поле");
    },
  },
  {
    id: "DE-03", title: "Повторный сабмит во время записи: один запрос; управление заблокировано; конфликтующие действия невозможны",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#de-add-input"), "СМУ-Один");
      const hold = a.ctl.hold("POST /smu");
      a.click(a.$("#de-add-btn"));
      await waitFor(() => a.$("#de-add-btn").disabled, { what: "кнопка заблокирована" });
      t.eq(a.click(a.$("#de-add-btn")), false, "второй клик невозможен");
      a.$("#de-add").dispatchEvent(new a.win.Event("submit", { cancelable: true, bubbles: true }));
      t.ok([...a.$$("#de-body button")].every((b) => b.disabled), "кнопки строк заблокированы на время записи");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => names(a).includes("СМУ-Один"), { what: "запись создана" });
      t.eq(a.ctl.log.filter((e) => e.method === "POST" && e.path === "/smu").length, 1, "ровно один POST");
      hold.dispose?.();
    },
  },
  {
    id: "DE-04", title: "Переименование: id из строки, Enter сохраняет, отмена ничего не пишет, пустое имя отклоняется",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const row = a.ctl.data.smu[0];
      const tr = () => a.$(`#de-body tr[data-id="${row.id}"]`);
      a.click(tr().querySelector('[data-act="rename"]'));
      await waitFor(() => a.$("#de-edit-input"), { what: "поле правки" });
      await a.type(a.$("#de-edit-input"), "Х", { clear: false });
      a.click(tr().querySelector('[data-act="cancel"]'));
      await a.settle(60);
      t.eq(writes(a).length, 0, "отмена ничего не записала");
      t.ok(names(a).includes(row.name), "имя прежнее");
      a.click(tr().querySelector('[data-act="rename"]'));
      await waitFor(() => a.$("#de-edit-input"), { what: "поле правки" });
      await a.type(a.$("#de-edit-input"), "СМУ-Переименованное", { clear: true });
      a.key(a.$("#de-edit-input"), "Enter");
      await waitFor(() => names(a).includes("СМУ-Переименованное"), { what: "новое имя в списке" });
      const patch = a.ctl.log.find((e) => e.method === "PATCH");
      t.eq(patch.path, `/smu/${row.id}`, "PATCH ушёл на id строки, в которой начали правку");
      t.eq(patch.body, { name: "СМУ-Переименованное" }, "в теле только название");
      t.has(a.$("#de-status").textContent, "Переименовано: «СМУ-Переименованное»", "статус подтверждён ответом сервера");
      a.click(tr().querySelector('[data-act="rename"]'));
      await waitFor(() => a.$("#de-edit-input"), { what: "поле правки" });
      await a.type(a.$("#de-edit-input"), "   ", { clear: true });
      a.key(a.$("#de-edit-input"), "Enter");
      await waitFor(() => /не может быть пустым/.test(a.$("#de-status").textContent), { what: "отказ пустого имени" });
      t.eq(a.ctl.log.filter((e) => e.method === "PATCH").length, 1, "пустое имя на сервер не отправлено");
    },
  },
  {
    id: "DE-05", title: "Несохранённый ввод: «Остаться» / «Не сохранять» / «Сохранить и продолжить»",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#de-add-input"), "СМУ-Черновик");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => a.dialog(), { what: "диалог несохранённого" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#de-add-input"), "остались на экране справочника");
      t.eq(a.$("#de-add-input").value, "СМУ-Черновик", "ввод сохранён");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.$(".v2-card"), { what: "ушли на начальную страницу" });
      t.eq(a.ctl.log.filter((e) => e.method === "POST" && e.path === "/smu").length, 1, "«Сохранить» отправило запись один раз");
      t.ok(a.ctl.data.smu.some((r) => r.name === "СМУ-Черновик"), "запись создана");
      await open(a);
      await a.type(a.$("#de-add-input"), "СМУ-Отброшено");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$(".v2-card"), { what: "ушли" });
      t.ok(!a.ctl.data.smu.some((r) => r.name === "СМУ-Отброшено"), "отброшенный ввод не записан");
    },
  },
  {
    id: "DE-06", title: "Обрыв связи при добавлении: без автоповтора, без ложного успеха, ввод остаётся",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#de-add-input"), "СМУ-Сеть");
      a.ctl.failNext("POST /smu", { network: true });
      a.click(a.$("#de-add-btn"));
      await waitFor(() => /не создана|Неизвестно/.test(a.$("#de-status").textContent), { what: "сообщение о неудаче" });
      t.eq(a.ctl.log.filter((e) => e.method === "POST" && e.path === "/smu").length, 1, "запрос не повторялся автоматически");
      t.ok(!/Добавлено/.test(a.$("#de-status").textContent), "ложного успеха нет");
      t.eq(a.$("#de-add-input").value, "СМУ-Сеть", "введённое осталось в поле");
      t.ok(!names(a).includes("СМУ-Сеть"), "записи в списке нет");
    },
  },
  {
    id: "DE-07", title: "Удаление неиспользуемой записи: план → подтверждение → запрос с id → список перечитан; отказ ничего не пишет",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const row = a.ctl.data.smu[1];
      a.click(a.$(`#de-body tr[data-id="${row.id}"] [data-act="delete"]`));
      await waitFor(() => a.dialog(), { what: "подтверждение удаления" });
      t.has(a.dialog().textContent, row.name, "в подтверждении названа удаляемая запись");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(a.ctl.log.filter((e) => e.method === "POST").length, 0, "отказ ничего не удалил");
      t.ok(a.ctl.log.some((e) => e.path === `/dictionaries/smu/${row.id}/delete-plan`), "план последствий запрошен с сервера");
      a.click(a.$(`#de-body tr[data-id="${row.id}"] [data-act="delete"]`));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !names(a).includes(row.name), { what: "запись исчезла" });
      const del = a.ctl.log.find((e) => e.method === "POST" && e.path.endsWith("/delete"));
      t.eq(del.path, `/dictionaries/smu/${row.id}/delete`, "удаление — по id строки");
      t.eq(del.body, { replacements: {}, mode: "replace" }, "тело удаления без замен");
      t.has(a.$("#de-status").textContent, `Удалено: «${row.name}»`, "статус подтверждён");
    },
  },
  {
    id: "DE-08", title: "Запись, на которую ссылаются объекты, здесь не удаляется: объяснение и переход в V1, запросов на удаление нет",
    async run(t) {
      const a = await openApp({ home: true });
      a.ctl.data.smu[0].usedBy = 2;
      await open(a);
      const row = a.ctl.data.smu[0];
      a.click(a.$(`#de-body tr[data-id="${row.id}"] [data-act="delete"]`));
      await waitFor(() => a.dialog(), { what: "объяснение" });
      t.has(a.dialog().textContent, "используется", "сказано, что запись используется");
      t.has(a.dialog().textContent, "в текущем интерфейсе", "указан путь: удаление с заменой — в текущем интерфейсе");
      await a.answerDialog("Понятно");
      t.eq(a.ctl.log.filter((e) => e.method === "POST").length, 0, "запроса на удаление нет");
      t.ok(names(a).includes(row.name), "запись на месте");
      t.ok(a.$("a[data-v1-link]"), "переход в текущий интерфейс доступен");
    },
  },
  {
    id: "DE-09", title: "Без права изменения: справочник виден, кнопок добавления/правки/удаления нет",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object")?.options.length > 1, { what: "выбор объекта" });
      // роль с правом только читать справочник СМУ; права пересчитываются при смене объекта в шапке
      a.ctl.setPermissions({ system_admin: false, features: { dict_smu: "read" } });
      const sel = a.$("#v2-object");
      const other = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value));
      a.setValue(sel, String(other));
      await waitFor(() => a.$(`${NAV}[data-section="dict-smu"]`), { what: "экран доступен на чтение" });
      a.click(a.$(`${NAV}[data-section="dict-smu"]`));
      await waitFor(() => a.$("#de-body tbody"), { what: "список" });
      t.ok(!a.$("#de-add"), "формы добавления нет");
      t.eq(a.$$('#de-body [data-act]').length, 0, "кнопок правки и удаления нет");
      t.has(a.$(".v2-callout").textContent, "нет права", "сказано, почему");
    },
  },
  {
    id: "DE-10", title: "Физлица: добавление и удаление идут по своим API (вид individual)",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a, "dict-individuals");
      await a.type(a.$("#de-add-input"), "Иванов И.И.");
      a.click(a.$("#de-add-btn"));
      await waitFor(() => names(a).includes("Иванов И.И."), { what: "запись" });
      t.ok(a.ctl.log.some((e) => e.method === "POST" && e.path === "/individuals"), "POST /individuals");
      const row = a.ctl.data.individuals.find((r) => r.name === "Иванов И.И.");
      a.click(a.$(`#de-body tr[data-id="${row.id}"] [data-act="delete"]`));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !names(a).includes("Иванов И.И."), { what: "запись исчезла" });
      t.ok(a.ctl.log.some((e) => e.path === `/dictionaries/individual/${row.id}/delete`), "удаление по виду individual");
    },
  },
  {
    id: "DE-11", title: "Переименование в уже существующее имя (409): текст сервера, правка остаётся открытой, запись не менялась",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const [r0, r1] = a.ctl.data.smu;
      a.click(a.$(`#de-body tr[data-id="${r0.id}"] [data-act="rename"]`));
      await waitFor(() => a.$("#de-edit-input"), { what: "поле правки" });
      await a.type(a.$("#de-edit-input"), r1.name, { clear: true });
      a.click(a.$('[data-act="save"]'));
      await waitFor(() => /уже есть/.test(a.$("#de-status").textContent), { what: "отказ по дублю" });
      t.ok(a.$("#de-edit-input"), "поле правки осталось открытым");
      t.eq(a.$("#de-edit-input").value, r1.name, "введённое не потеряно");
      t.eq(a.ctl.data.smu.find((r) => r.id === r0.id).name, r0.name, "на сервере имя прежнее");
    },
  },
  {
    id: "DE-12", title: "Запись удалили в другом месте: переименование и удаление (404) — список обновляется, понятное сообщение, без ложного успеха",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const row = a.ctl.data.smu[0];
      a.click(a.$(`#de-body tr[data-id="${row.id}"] [data-act="rename"]`));
      await waitFor(() => a.$("#de-edit-input"), { what: "поле правки" });
      await a.type(a.$("#de-edit-input"), "Новое имя", { clear: true });
      a.ctl.data.smu.splice(a.ctl.data.smu.indexOf(row), 1); // кто-то удалил запись
      a.click(a.$('[data-act="save"]'));
      await waitFor(() => /уже удалена/.test(a.$("#de-status").textContent), { what: "сообщение об удалении" });
      t.ok(!a.$$("#de-body tbody tr").some((tr) => tr.dataset.id === String(row.id)), "удалённой записи в списке нет");
      t.ok(!/Переименовано/.test(a.$("#de-status").textContent), "ложного успеха нет");
      const row2 = a.ctl.data.smu[0];
      a.click(a.$(`#de-body tr[data-id="${row2.id}"] [data-act="delete"]`));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      a.ctl.data.smu.splice(a.ctl.data.smu.indexOf(row2), 1); // и эту тоже удалили, пока подтверждали
      await a.answerDialog("Удалить");
      await waitFor(() => /уже удалена/.test(a.$("#de-status").textContent), { what: "удаление уже удалённой" });
      t.ok(!a.$$("#de-body tbody tr").some((tr) => tr.dataset.id === String(row2.id)), "список обновлён");
    },
  },
];

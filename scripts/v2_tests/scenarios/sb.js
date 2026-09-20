// «Типы и подтипы элементов»: подтипы объекта — добавить/удалить неиспользуемый (SB-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const posts = (a) => a.ctl.log.filter((e) => e.method === "POST" && !e.path.startsWith("/reports"));
const subs = (a, type) => a.$$(`#sb-body section[data-type="${type}"] .v2-card-list li span`).map((s) => s.textContent.trim());
const input = (a, type) => a.$(`[data-add-input="${type}"]`);
const addBtn = (a, type) => a.$(`[data-add="${type}"]`);
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="subtypes"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="subtypes"]`));
  await waitFor(() => a.$('#sb-body section[data-type="Колонна"]'), { what: "подтипы" });
}

export const tests = [
  {
    id: "SB-01", title: "Добавление подтипа: тело запроса с объектом из шапки и обрезанным названием, список перечитан, статус после чтения",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const oid = Number(a.$("#v2-object").value);
      t.eq(subs(a, "Колонна"), ["верхняя", "нижняя"], "подтипы из ответа сервера");
      await a.type(input(a, "Ригель"), "  периметральный  ");
      a.click(addBtn(a, "Ригель"));
      await waitFor(() => subs(a, "Ригель").includes("периметральный"), { what: "подтип в списке" });
      t.eq(posts(a)[0].body, { object_id: oid, element_type: "Ригель", subtype: "периметральный" }, "тело запроса");
      t.has(a.$("#sb-status").textContent, "Добавлено: «периметральный»", "статус после чтения");
      t.eq(input(a, "Ригель").value, "", "поле очищено");
      t.eq(posts(a).length, 1, "один изменяющий запрос");
    },
  },
  {
    id: "SB-02", title: "Пустой подтип и повтор существующего (без учёта регистра) на сервер не отправляются",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(addBtn(a, "Колонна"));
      await a.settle(60);
      t.has(a.$("#sb-status").textContent, "Введите название", "пустой ввод отклонён");
      await a.type(input(a, "Колонна"), "ВЕРХНЯЯ");
      a.click(addBtn(a, "Колонна"));
      await a.settle(60);
      t.has(a.$("#sb-status").textContent, "уже есть", "повтор отклонён");
      t.eq(posts(a).length, 0, "запросов записи нет");
      t.eq(input(a, "Колонна").value, "ВЕРХНЯЯ", "ввод остался");
    },
  },
  {
    id: "SB-03", title: "Удаление неиспользуемого подтипа: план по ключу объект|тип|подтип → подтверждение → запрос; отказ ничего не удаляет",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const oid = Number(a.$("#v2-object").value);
      const key = encodeURIComponent(`${oid}|Колонна|нижняя`);
      a.click(a.$('[data-del="нижняя"][data-type="Колонна"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(a.dialog().textContent, "«нижняя»", "названа удаляемая запись");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(posts(a).length, 0, "отказ ничего не удалил");
      t.ok(a.ctl.log.some((e) => e.path === `/dictionaries/subtype/${key}/delete-plan`), "план последствий запрошен");
      a.click(a.$('[data-del="нижняя"][data-type="Колонна"]'));
      await a.answerDialog("Удалить");
      await waitFor(() => !subs(a, "Колонна").includes("нижняя"), { what: "подтип исчез" });
      t.eq(posts(a)[0].path, `/dictionaries/subtype/${key}/delete`, "удаление по ключу");
      t.eq(posts(a)[0].body, { replacements: {}, mode: "replace" }, "без замен");
    },
  },
  {
    id: "SB-04", title: "Подтип с изделиями здесь не удаляется: объяснение, запросов на удаление нет",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object"), { what: "оболочка" });
      const oid = Number(a.$("#v2-object").value);
      (a.ctl.data.settings.subtypeUse ||= {})[`${oid}|Колонна|верхняя`] = 5;
      await open(a);
      a.click(a.$('[data-del="верхняя"][data-type="Колонна"]'));
      await waitFor(() => a.dialog(), { what: "объяснение" });
      t.has(a.dialog().textContent, "используется", "сказано, что подтип используется");
      t.has(a.dialog().textContent, "в текущем интерфейсе", "путь — удаление с заменой в V1");
      await a.answerDialog("Понятно");
      t.eq(posts(a).length, 0, "запросов на удаление нет");
      t.ok(subs(a, "Колонна").includes("верхняя"), "подтип на месте");
    },
  },
  {
    id: "SB-05", title: "Несохранённый ввод: «Остаться» / «Не сохранять» / «Сохранить и продолжить»; смена объекта проходит тот же сторож",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const A = Number(a.$("#v2-object").value);
      await a.type(input(a, "Ригель"), "черновик");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Остаться");
      t.eq(input(a, "Ригель").value, "черновик", "ввод остался");
      const sel = a.$("#v2-object");
      const B = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== A);
      a.setValue(sel, String(B));
      await waitFor(() => a.dialog(), { what: "диалог при смене объекта" });
      await a.answerDialog("Остаться");
      t.eq(Number(a.$("#v2-object").value), A, "выбор в шапке вернулся");
      a.setValue(sel, String(B));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.log.some((e) => e.method === "GET" && e.path === `/allowed-subtypes?object_id=${B}`), { what: "экран под новым объектом" });
      t.eq(posts(a)[0].body.object_id, A, "записан ПРЕЖНИЙ объект");
      t.eq(posts(a).length, 1, "один запрос");
    },
  },
  {
    id: "SB-06", title: "Сбой сервера: без автоповтора, ввод остаётся; двойной клик — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(input(a, "Панель"), "ШахтаQA");
      a.ctl.failNext("POST /allowed-subtypes", { status: 500, detail: "Сбой (QA)" });
      a.click(addBtn(a, "Панель"));
      await waitFor(() => /не добавлен|Неизвестно/.test(a.$("#sb-status").textContent), { what: "сообщение о сбое" });
      t.eq(posts(a).length, 1, "запрос не повторялся автоматически");
      t.eq(input(a, "Панель").value, "ШахтаQA", "ввод остался");
      const hold = a.ctl.hold("POST /allowed-subtypes");
      a.click(addBtn(a, "Панель"));
      await hold.waitForRequest(1, 3000);
      t.eq(a.click(addBtn(a, "Панель")), false, "второй клик невозможен");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => subs(a, "Панель").includes("ШахтаQA"), { what: "подтип добавлен" });
      t.eq(posts(a).length, 2, "два POST: неудачный и повторный вручную");
      hold.dispose?.();
    },
  },
];

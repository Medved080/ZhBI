// Редактор «Префиксы марок»: PE-*. Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const rows = (a) => a.$$("#pe-body tbody tr").map((tr) => `${tr.children[0].textContent.trim()}→${tr.children[1].textContent.trim()}`);
const posts = (a) => a.ctl.log.filter((e) => e.method === "POST");
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="mark-prefixes"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="mark-prefixes"]`));
  await waitFor(() => a.$("#pe-prefix") && a.$("#pe-body tbody") && a.$("#pe-type")?.options.length > 0, { what: "экран префиксов" });
}

export const tests = [
  {
    id: "PE-01", title: "Добавление нового префикса: тело запроса с обрезанным префиксом и выбранным типом, список перечитан, статус из ответа",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      t.eq(rows(a), ["КН→Колонна", "ПП→Плита перекрытия", "РГ→Ригель"], "список из ответа сервера");
      await a.type(a.$("#pe-prefix"), "  ЛС  ");
      a.setValue(a.$("#pe-type"), "Ригель");
      a.click(a.$("#pe-add-btn"));
      await waitFor(() => rows(a).includes("ЛС→Ригель"), { what: "запись в списке" });
      t.eq(posts(a)[0].body, { prefix: "ЛС", element_type: "Ригель" }, "в запросе префикс без пробелов и выбранный тип");
      t.has(a.$("#pe-status").textContent, "Добавлено: ЛС → Ригель", "статус из ответа сервера");
      t.eq(a.$("#pe-prefix").value, "", "поле ввода очищено");
      t.eq(posts(a).length, 1, "один изменяющий запрос");
    },
  },
  {
    id: "PE-02", title: "Существующий префикс: замена типа только после подтверждения; отказ ничего не пишет; тот же тип — без запроса",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#pe-prefix"), "КН");
      a.setValue(a.$("#pe-type"), "Ригель");
      a.click(a.$("#pe-add-btn"));
      await waitFor(() => a.dialog(), { what: "подтверждение замены" });
      t.has(a.dialog().textContent, "уже задан для типа «Колонна»", "в подтверждении названы прежний тип");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(posts(a).length, 0, "отказ ничего не записал");
      t.ok(rows(a).includes("КН→Колонна"), "прежний тип на месте");
      a.click(a.$("#pe-add-btn"));
      await a.answerDialog("Заменить");
      await waitFor(() => rows(a).includes("КН→Ригель"), { what: "тип заменён" });
      t.has(a.$("#pe-status").textContent, "Изменено: КН → Ригель", "статус говорит «Изменено»");
      a.setValue(a.$("#pe-type"), "Ригель");
      await a.type(a.$("#pe-prefix"), "КН", { clear: true });
      a.click(a.$("#pe-add-btn"));
      await a.settle(80);
      t.eq(posts(a).length, 1, "тот же тип — второго запроса нет");
      t.has(a.$("#pe-status").textContent, "уже задан", "сказано, что менять нечего");
    },
  },
  {
    id: "PE-03", title: "Удаление: план последствий → подтверждение → запрос по ключу → список перечитан; отказ ничего не удаляет",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('#pe-body [data-act="delete"][data-prefix="ПП"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение удаления" });
      t.has(a.dialog().textContent, "ПП → Плита перекрытия", "названа удаляемая запись");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(posts(a).length, 0, "отказ ничего не удалил");
      t.ok(a.ctl.log.some((e) => e.path === `/dictionaries/mark_prefix/${encodeURIComponent("ПП")}/delete-plan`), "план последствий запрошен");
      a.click(a.$('#pe-body [data-act="delete"][data-prefix="ПП"]'));
      await a.answerDialog("Удалить");
      await waitFor(() => !rows(a).some((r) => r.startsWith("ПП→")), { what: "запись исчезла" });
      const del = posts(a)[0];
      t.eq(del.path, `/dictionaries/mark_prefix/${encodeURIComponent("ПП")}/delete`, "удаление по ключу-префиксу");
      t.eq(del.body, { replacements: {}, mode: "replace" }, "без замен");
    },
  },
  {
    id: "PE-04", title: "Пустой префикс не отправляется; сбой сервера — без автоповтора, ввод остаётся; двойной сабмит — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$("#pe-add-btn"));
      await a.settle(60);
      t.has(a.$("#pe-status").textContent, "Введите префикс", "сообщение о пустом префиксе");
      t.eq(posts(a).length, 0, "пустой префикс на сервер не ушёл");
      await a.type(a.$("#pe-prefix"), "ЗЗ");
      a.ctl.failNext("POST /mark-type-prefixes", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("#pe-add-btn"));
      await waitFor(() => /не сохранена|Неизвестно/.test(a.$("#pe-status").textContent), { what: "сообщение о сбое" });
      t.eq(posts(a).length, 1, "запрос не повторялся автоматически");
      t.eq(a.$("#pe-prefix").value, "ЗЗ", "введённое осталось");
      const hold = a.ctl.hold("POST /mark-type-prefixes");
      a.click(a.$("#pe-add-btn"));
      await waitFor(() => a.$("#pe-add-btn").disabled, { what: "блокировка" });
      t.eq(a.click(a.$("#pe-add-btn")), false, "второй клик невозможен");
      hold.release();
      await waitFor(() => rows(a).includes("ЗЗ→Колонна"), { what: "запись создана" });
      t.eq(posts(a).length, 2, "всего два POST: неудачный и повторный вручную");
      hold.dispose?.();
    },
  },
  {
    id: "PE-05", title: "Несохранённый ввод: «Остаться» / «Не сохранять» / «Сохранить и продолжить»; «Изменить тип» подставляет префикс в форму",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('#pe-body [data-act="edit"][data-prefix="РГ"]'));
      t.eq(a.$("#pe-prefix").value, "РГ", "«Изменить тип» подставила префикс");
      t.eq(a.$("#pe-type").value, "Ригель", "и его текущий тип");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#pe-prefix"), "остались на экране");
      await a.type(a.$("#pe-prefix"), "НОВ", { clear: true });
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$(".v2-card"), { what: "ушли" });
      t.eq(posts(a).length, 0, "«Не сохранять» ничего не записало");
      await open(a);
      await a.type(a.$("#pe-prefix"), "СОХ");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.$(".v2-card"), { what: "ушли после сохранения" });
      t.ok(a.ctl.data.settings.markPrefixes.some((r) => r.prefix === "СОХ"), "«Сохранить» создало запись");
    },
  },
];

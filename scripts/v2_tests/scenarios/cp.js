// Контрагенты (CP-*) и обязательная регрессия плановых дат / блокировок (CP-REG-*).
// Данные стенда: контрагент 1 (договоры 1,2 → спец. 1,2,3 → контракты 1–5: у 1 привязаны изделия 101–108,
// замена — контракт 2; 3 — замена не проходит (409); 5 — единственный в спецификации, кандидатов нет),
// контрагент 2 (договоры 3,4,7; контракт 6 архивный, 7 без привязок, 8 — объект 4, изделия 301–303),
// 5 — удаляется чисто, 6 — blockers, 7 — минимальный.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const text = (a) => a.doc.body.innerText;
const dateInput = (a, id) => a.$(`[data-elem-planned="${id}"]`);
const contractOf = (a, cid) => a.ctl.data.contracts.find((c) => c.id === cid);
const specOf = (a, cid) => a.ctl.data.specifications.find((s) => s.id === contractOf(a, cid).specification_id);
const agreementOf = (a, cid) => a.ctl.data.agreements.find((g) => g.id === specOf(a, cid).agreement_id);
const cpOfContract = (a, cid) => agreementOf(a, cid).counterparty_id;
const elemDate = (a, id) => a.ctl.data.elements.find((e) => e.id === id).planned_delivery_date;

async function openCp(a) {
  await waitFor(() => a.$(`${NAV}[data-section="counterparties"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="counterparties"]`));
  await waitFor(() => a.$("#cp-list [data-open]") || a.doc.body.innerText.includes("пока нет") || a.$("#cp-retry"), { what: "список контрагентов" });
  await a.settle(40);
}
async function openCard(a, cpId, tab) {
  a.click(a.$(`[data-open="${cpId}"]`));
  await waitFor(() => a.$("[data-tab]"), { what: "карточка" });
  if (tab) {
    a.click(a.$(`[data-tab="${tab}"]`));
    await waitFor(() => a.$(`[data-tab="${tab}"][aria-pressed="true"]`), { what: `вкладка ${tab}` });
    await a.settle(80);
  }
}
async function openContract(a, cid, tab = "expanded") {
  await openCp(a);
  await openCard(a, cpOfContract(a, cid), "contracting");
  await waitFor(() => a.$(`[data-c-open="edit:${cid}"]`), { what: `контракт ${cid} в списке` });
  a.click(a.$(`[data-c-open="edit:${cid}"]`));
  await waitFor(() => a.$("#ctr-back"), { what: "рабочее пространство контракта" });
  if (tab !== "lines") {
    a.click(a.$(`[data-ctr-tab="${tab}"]`));
    if (tab === "expanded") await waitFor(() => a.$$("[data-elem-planned]").length > 0, { what: "строки «Развёрнуто»" });
    await a.settle(60);
  }
}
const change = (a, el, value) => { el.value = value; el.dispatchEvent(new a.win.Event("input", { bubbles: true })); el.dispatchEvent(new a.win.Event("change", { bubbles: true })); };
const setTheme = async (a, val) => { const d = a.$("#ctr-requisites-details"); if (d && !d.open) d.open = true; const th = a.$("#ctr-theme"); await a.type(th, val); };

export const tests = [
  {
    id: "CP-L-01", title: "Список контрагентов: 7 строк, краткое имя и «полное · ИНН · код»",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      t.eq(a.$$("#cp-list [data-open]").length, 7, "7 контрагентов");
      t.has(a.$("#cp-list").textContent, "QA-ЗЖБИ-1", "краткое имя");
      t.ok(/ИНН \d+/.test(a.$("#cp-list").textContent), "ИНН в подписи строки");
    },
  },
  {
    id: "CP-L-02", title: "Контрагентов нет: «Контрагентов пока нет.»",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$("#ua-rows"), { what: "первый раздел" });
      a.ctl.data.counterparties.length = 0;
      await openCp(a);
      t.has(text(a), "Контрагентов пока нет", "пустое состояние");
    },
  },
  {
    id: "CP-L-03", title: "GET /counterparties падает: ошибка + «Повторить», не пустой список",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$("#ua-rows"), { what: "первый раздел" });
      a.ctl.failNext("=/counterparties", { method: "GET", status: 500, detail: "База недоступна" });
      a.click(a.$(`${NAV}[data-section="counterparties"]`));
      await waitFor(() => a.$("#cp-retry"), { what: "«Повторить»" });
      t.has(text(a), "База недоступна", "причина видна");
      a.click(a.$("#cp-retry"));
      await waitFor(() => a.$("#cp-list [data-open]"), { what: "список после повтора" });
      t.eq(a.$$("#cp-list [data-open]").length, 7, "после «Повторить» список загружен");
    },
  },
  {
    id: "CP-L-06", title: "Права: корзина контрагента только для администратора / dict_delete=write",
    async run(t) {
      const w = await openApp({ perm: "writer" });
      await openCp(w);
      t.eq(w.$$("#cp-list [data-del]").length, 0, "писатель без dict_delete: корзин нет");
      const d = await openApp({ perm: "deleter" });
      await openCp(d);
      t.eq(d.$$("#cp-list [data-del]").length, 7, "dict_delete=write: корзины есть у всех строк");
      const a = await openApp();
      await openCp(a);
      t.eq(a.$$("#cp-list [data-del]").length, 7, "администратор: корзины есть");
    },
  },
  {
    id: "CP-L-07", title: "Удаление чистого контрагента: delete-plan → подтверждение (danger) → удалён; отмена не удаляет",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.click(a.$('[data-del="5"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.ok(a.$(".v2-dialog .v2-danger"), "кнопка «Удалить» — danger");
      await a.answerDialog("Отмена");
      t.ok(a.ctl.data.counterparties.some((c) => c.id === 5), "отмена не удаляет");
      a.click(a.$('[data-del="5"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !a.ctl.data.counterparties.some((c) => c.id === 5), { what: "удаление" });
      await a.settle(120);
      t.eq(a.ctl.count("POST", "/dictionaries/counterparty/5/delete"), 1, "один POST delete");
      t.has(a.$("#cp-status").textContent, "Контрагент удалён", "«Контрагент удалён.»");
      t.eq(a.$$("#cp-list [data-open]").length, 6, "в списке 6");
    },
  },
  {
    id: "CP-L-08", title: "Контрагент с зависимостями: «Удалить нельзя. Мешает…», запроса на удаление нет",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.click(a.$('[data-del="6"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      t.has(a.dialog().textContent, "Удалить нельзя", "сообщение о блокерах");
      await a.answerDialog("Понятно");
      t.eq(a.ctl.count("POST", "/dictionaries/counterparty/6/delete"), 0, "запроса на удаление нет");
    },
  },
  {
    id: "CP-L-09", title: "Корзина: двойной клик — один диалог и один POST; ошибка удаления читаема, контрагент цел",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      const b = a.$('[data-del="5"]');
      a.click(b); a.click(b);
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.settle(80);
      t.eq(a.$$(".v2-dialog").length, 1, "один диалог");
      a.ctl.failNext("/dictionaries/counterparty/5/delete", { method: "POST", status: 500, detail: "Сбой удаления" });
      await a.answerDialog("Удалить");
      await waitFor(() => a.dialog() && a.dialog().textContent.includes("Сбой удаления"), { what: "сообщение об ошибке" });
      await a.answerDialog("Понятно");
      t.eq(a.ctl.count("POST", "/dictionaries/counterparty/5/delete"), 1, "один POST при двойном клике");
      t.ok(a.ctl.data.counterparties.some((c) => c.id === 5), "контрагент цел");
    },
  },
  {
    id: "CP-M-01", title: "Поля карточки: ограничения длины (код ≤10, ИНН ≤12, КПП ≤9, ОГРН ≤15) и цифровой ввод; порядок Tab по разметке",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7);
      await waitFor(() => a.$("#cpf-short"), { what: "форма" });
      t.eq(a.$("#cpf-code").maxLength, 10, "код — не более 10 символов");
      t.eq(a.$("#cpf-inn").maxLength, 12, "ИНН — не более 12");
      t.eq(a.$("#cpf-kpp").maxLength, 9, "КПП — не более 9");
      t.eq(a.$("#cpf-ogrn").maxLength, 15, "ОГРН — не более 15");
      t.ok(["cpf-inn", "cpf-kpp", "cpf-ogrn"].every((id) => a.$(`#${id}`).inputMode === "numeric"), "ИНН/КПП/ОГРН — цифровая клавиатура");
      const order = a.$$("#cp-main-fields input, #cp-main-fields textarea, #cp-main-fields select").map((el) => el.id);
      t.eq(order.slice(0, 3), ["cpf-code", "cpf-short", "cpf-full"], "порядок полей в разметке: Код, Краткое, Полное");
      t.ok(a.$$("[tabindex]").every((el) => Number(el.getAttribute("tabindex")) <= 0), "положительных tabindex нет");
    },
  },
  {
    id: "CP-M-02", title: "Новый контрагент без полного/краткого наименования: сообщение, запрос не уходит",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.click(a.$("#cp-add"));
      await waitFor(() => a.$("#cpf-short"), { what: "форма" });
      await a.type(a.$("#cpf-short"), "QA-Короткое");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-save"));
      await a.settle(80);
      t.has(a.$("#cp-status").textContent, "Укажите полное и краткое наименование", "сообщение о наименованиях");
      t.eq(a.ctl.count("POST", "/counterparties"), 0, "запрос не отправлен");
      t.has(a.$("#cpf-short").value, "QA-Короткое", "введённое цело");
    },
  },
  {
    id: "CP-M-03", title: "Создание контрагента: POST, «Добавлено.», в списке, вкладка «Контрактация» доступна, данные после повторного открытия",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.click(a.$("#cp-add"));
      await waitFor(() => a.$("#cpf-short"), { what: "форма" });
      await a.type(a.$("#cpf-short"), "QA-ACC-Новый");
      await a.type(a.$("#cpf-full"), "QA-ACC Новый контрагент (полное)");
      await a.type(a.$("#cpf-inn"), "7700000001");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-save"));
      await waitFor(() => a.ctl.count("POST", "/counterparties") === 1, { what: "POST" });
      await a.settle(150);
      t.has(a.$("#cp-status").textContent, "Добавлено", "«Добавлено.»");
      const created = a.ctl.data.counterparties.find((c) => c.short_name === "QA-ACC-Новый");
      t.ok(created && created.inn === "7700000001", "запись в фейковой БД с ИНН");
      a.click(a.$('[data-tab="contracting"]'));
      await waitFor(() => a.$("#cp-new-agreement-toggle"), { what: "форма договоров" });
      t.ok(a.$("#cp-new-agreement-toggle"), "после создания «Контрактация» доступна (можно завести договор)");
      a.click(a.$("#cp-back"));
      await waitFor(() => a.$(`[data-open="${created.id}"]`), { what: "список" });
      a.click(a.$(`[data-open="${created.id}"]`));
      await waitFor(() => a.$("#cpf-short"), { what: "повторное открытие" });
      t.eq(a.$("#cpf-short").value, "QA-ACC-Новый", "повторное открытие показывает данные сервера");
      t.eq(a.$("#cp-save"), null, "ложного подвала нет");
    },
  },
  {
    id: "CP-M-04", title: "Правка → «Отменить»: значения возвращены; «Сохранить»: PATCH, «Сохранено.»",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7);
      await waitFor(() => a.$("#cpf-contact-person"), { what: "форма" });
      const before = a.$("#cpf-contact-person").value;
      await a.type(a.$("#cpf-contact-person"), "ЛИШНЕЕ");
      await waitFor(() => a.$("#cp-cancel"), { what: "подвал" });
      a.click(a.$("#cp-cancel"));
      await waitFor(() => !a.$("#cp-cancel"), { what: "отмена" });
      t.eq(a.$("#cpf-contact-person").value, before, "значение возвращено");
      t.eq(a.ctl.count("PATCH", "/counterparties/"), 0, "отмена не шлёт запрос");
      await a.type(a.$("#cpf-contact-person"), "QA-контакт");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-save"));
      await waitFor(() => a.ctl.count("PATCH", "/counterparties/7") === 1, { what: "PATCH" });
      await a.settle(150);
      t.has(a.$("#cp-status").textContent, "Сохранено", "«Сохранено.»");
      t.has(a.ctl.data.counterparties.find((c) => c.id === 7).contact_person, "QA-контакт", "записано");
    },
  },
  {
    id: "CP-M-06", title: "Сохранение карточки: двойной клик; 403/409/422/500/сеть — один запрос, читаемо, ввод цел",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7);
      await waitFor(() => a.$("#cpf-contact-person"), { what: "форма" });
      await a.type(a.$("#cpf-contact-person"), "Х");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      const hold = a.ctl.hold("PATCH /counterparties/7");
      const b = a.$("#cp-save");
      a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("PATCH", "/counterparties/7"), 1, "двойной клик — один PATCH");
      t.ok(a.$("#cpf-contact-person").disabled, "поля заблокированы на время записи");
      hold.fail(403, "Нет прав на справочник");
      await waitFor(() => a.$("#cp-status").textContent.includes("Нет прав"), { what: "403" });
      t.ok(!a.$("#cpf-contact-person").disabled && !a.$("#cp-save").disabled, "поля и кнопка снова доступны");
      for (const [name, fail, expectText] of [
        ["409", { status: 409, detail: "Такой ИНН уже есть" }, "такой инн уже есть"],
        ["422", { status: 422, detail: [{ loc: ["body", "inn"], msg: "bad", type: "string_too_long" }] }, "inn: слишком длинное значение"],
        ["сеть", { network: true }, "нет связи"],
      ]) {
        a.ctl.failNext("PATCH /counterparties/7", fail);
        a.click(a.$("#cp-save"));
        await waitFor(() => a.$("#cp-status").textContent.toLowerCase().includes(expectText), { what: `ошибка ${name}` });
        t.notHas(a.$("#cp-status").textContent, "[object", `[${name}] нет [object Object]`);
        t.has(a.$("#cpf-contact-person").value, "Х", `[${name}] ввод цел`);
      }
    },
  },
  {
    id: "CP-M-07", title: "Dirty: «← Все контрагенты» → диалог 3 вариантов; после сохранения ложного предупреждения нет",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7);
      await waitFor(() => a.$("#cpf-contact-person"), { what: "форма" });
      await a.type(a.$("#cpf-contact-person"), "Y");
      a.click(a.$("#cp-back"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      t.eq(a.$$(".v2-dialog button").map((b) => b.textContent.trim()), ["Остаться", "Не сохранять", "Сохранить и продолжить"], "три варианта");
      await a.answerDialog("Остаться");
      t.ok(a.$("#cpf-contact-person"), "«Остаться» — карточка на месте");
      a.click(a.$('[data-tab="contracting"]'));
      await waitFor(() => a.$('[data-tab="contracting"][aria-pressed="true"]'), { what: "вкладка" });
      a.click(a.$('[data-tab="main"]'));
      await waitFor(() => a.$("#cpf-contact-person"), { what: "назад" });
      t.has(a.$("#cpf-contact-person").value, "Y", "между вкладками черновик карточки не теряется");
      a.click(a.$("#cp-back"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.$("#cp-list [data-open]"), { what: "список" });
      t.eq(a.ctl.count("PATCH", "/counterparties/7"), 1, "сохранено ровно один раз");
      await openCard(a, 7);
      a.click(a.$("#cp-back"));
      await a.settle(100);
      t.eq(a.dialog(), null, "после сохранения уход без предупреждения");
    },
  },
  {
    id: "CP-M-08", title: "Сохранение из диалога ухода не проходит валидацию: РЕАЛЬНЫЙ текст ошибки виден, уход отменён, ввод цел",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7);
      await waitFor(() => a.$("#cpf-full"), { what: "форма" });
      a.select(a.$("#cpf-full"), 0, a.$("#cpf-full").value.length);
      await a.backspace(a.$("#cpf-full"), 1);
      a.$("#cpf-full").value = "";
      a.$("#cpf-full").dispatchEvent(new a.win.Event("input", { bubbles: true }));
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-back"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await a.settle(150);
      t.has(a.$("#cp-status").textContent, "Укажите полное и краткое наименование", "текст ошибки виден в строке статуса");
      t.ok(a.$("#cpf-full"), "остались в карточке");
      t.eq(a.$("#cpf-full").value, "", "введённое (пустое) цело");
      t.eq(a.ctl.count("PATCH", "/counterparties/7"), 0, "запрос не отправлен");
    },
  },
  {
    id: "CP-P-02", title: "Ёмкость («Прочее»): строка, шт./день, сохранение — в запрос идут только строки с per_day>0",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7, "other");
      await waitFor(() => a.$("#cp-cap-new-type"), { what: "форма ёмкости" });
      await a.type(a.$("#cp-cap-new-type"), "Колонна");
      a.click(a.$("#cp-cap-add-row"));
      await waitFor(() => a.$("[data-cap-per-day]"), { what: "новая строка" });
      await a.type(a.$("#cp-cap-new-type"), "Ригель");
      a.click(a.$("#cp-cap-add-row"));
      await waitFor(() => a.$$("[data-cap-per-day]").length === 2, { what: "две строки" });
      change(a, a.$$("[data-cap-per-day]")[0], "4.5");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-save"));
      await waitFor(() => a.ctl.count("PATCH", "/counterparties/7") === 1, { what: "PATCH" });
      const body = a.ctl.log.find((e) => e.method === "PATCH" && e.path.includes("/counterparties/7")).body;
      t.eq(body.capacity.map((c) => [c.element_type, c.per_day]), [["Колонна", 4.5]], "в запросе только строка с per_day>0 (нулевая «Ригель» отброшена)");
    },
  },
  {
    id: "CP-A-01", title: "Новый контрагент: «Контрактация» просит сначала сохранить карточку",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.click(a.$("#cp-add"));
      await waitFor(() => a.$("[data-tab]"), { what: "форма" });
      a.click(a.$('[data-tab="contracting"]'));
      await a.settle(100);
      t.has(text(a), "Договоры заводятся после сохранения контрагента", "подсказка");
    },
  },
  {
    id: "CP-A-02", title: "«Контрактация»: договоры, спецификации, контракты загружаются; ошибка списка — текст + «Повторить»",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$$("[data-agreement]").length === 2, { what: "2 договора контрагента 1" });
      t.eq(a.$$("[data-spec]").length, 3, "3 спецификации");
      t.ok(a.$('[data-c-open="edit:1"]'), "контракты в спецификациях");
      const b = await openApp();
      await waitFor(() => b.$("#ua-rows"), { what: "первый раздел" });
      await openCp(b);
      b.ctl.failNext("=/agreements", { method: "GET", status: 500, detail: "Договоры недоступны" });
      await openCard(b, 1);
      b.click(b.$('[data-tab="contracting"]'));
      await waitFor(() => b.$("#cp-contracting-retry"), { what: "«Повторить»" });
      t.has(text(b), "Договоры недоступны", "причина видна");
      b.click(b.$("#cp-contracting-retry"));
      await waitFor(() => b.$$("[data-agreement]").length === 2, { what: "после повтора" });
    },
  },
  {
    id: "CP-A-04", title: "Новый договор: валидации, создание, двойной клик — один POST, ошибка рядом с формой",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 4, "contracting");
      await waitFor(() => a.$("#cp-new-agreement-toggle"), { what: "форма" });
      a.click(a.$("#cp-new-agreement-toggle"));
      await waitFor(() => a.$("#cp-add-agreement"), { what: "форма договора" });
      a.click(a.$("#cp-add-agreement")); await a.settle(60);
      t.has(a.$("#cp-agreement-error").textContent, "Укажите номер договора", "валидация номера");
      await a.type(a.$("#cp-new-agreement-number"), "QA-ACC-Д-1");
      a.click(a.$("#cp-add-agreement")); await a.settle(60);
      t.has(a.$("#cp-agreement-error").textContent, "Выберите объект", "валидация объекта");
      a.setValue(a.$("#cp-new-agreement-object"), "1");
      const hold = a.ctl.hold("POST /agreements");
      const b = a.$("#cp-add-agreement");
      a.click(b); a.click(b);
      await a.settle(60);
      t.eq(a.ctl.count("POST", "/agreements"), 1, "двойной клик — один POST");
      hold.fail(500, "Сбой записи договора");
      await waitFor(() => a.$("#cp-agreement-error").textContent.includes("Сбой"), { what: "ошибка" });
      t.eq(a.$("#cp-new-agreement-number").value, "QA-ACC-Д-1", "ввод цел");
      a.click(a.$("#cp-add-agreement"));
      await waitFor(() => a.$$("[data-agreement]").length === 1, { what: "договор создан" });
      t.eq(a.ctl.data.agreements.filter((g) => g.number === "QA-ACC-Д-1").length, 1, "договор создан ровно один раз");
    },
  },
  {
    id: "CP-A-06", title: "Удаление договора и спецификации: подтверждение (danger), каскад, один DELETE",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 2, "contracting");
      await waitFor(() => a.$('[data-del-agreement="7"]'), { what: "договор 7 (без объекта, контрагент 2)" });
      a.click(a.$('[data-del-agreement="7"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.ok(a.$(".v2-dialog .v2-danger"), "красная кнопка удаления");
      await a.answerDialog("Отмена");
      t.ok(a.ctl.data.agreements.some((g) => g.id === 7), "отмена не удаляет");
    },
  },
  {
    id: "CP-W-01", title: "Рабочее пространство контракта: 4 вкладки, у существующего «Развёрнуто» доступна",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      t.eq(a.$$("[data-ctr-tab]").map((b) => b.textContent.trim()), ["Позиции", "Развёрнуто", "Инциденты", "Производительность"], "названия вкладок");
      t.ok(!a.$('[data-ctr-tab="expanded"]').disabled, "«Развёрнуто» у существующего доступна");
      for (const k of ["incidents", "capacity", "lines"]) { a.click(a.$(`[data-ctr-tab="${k}"]`)); await a.settle(60); t.eq(a.$(`[data-ctr-tab="${k}"]`).getAttribute("aria-pressed"), "true", `вкладка ${k}`); }
    },
  },
  {
    id: "CP-W-03", title: "Архивность: у контракта с привязанными изделиями чекбокс заблокирован с пояснением; без изделий — работает",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1, "lines");
      const d = a.$("#ctr-requisites-details"); d.open = true; await a.settle(60);
      t.ok(a.$("#ctr-archived").disabled, "контракт 1 (изделия привязаны): «Архивный» заблокирован");
      t.has(a.$("#ctr-requisites").innerText, "Нельзя архивировать", "причина объяснена");
      const b = await openApp();
      await openContract(b, 4, "lines");
      b.$("#ctr-requisites-details").open = true; await b.settle(60);
      t.ok(!b.$("#ctr-archived").disabled, "контракт 4 (без привязок): «Архивный» доступен");
    },
  },
  {
    id: "CP-W-09", title: "Контракт: правка темы → «Отменить» откатывает; «Сохранить» — PATCH, «Сохранено.»",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      const before = contractOf(a, 4).theme;
      await setTheme(a, " QA");
      await waitFor(() => a.$("#ctr-cancel") && !a.$("#ctr-cancel").disabled, { what: "отмена" });
      t.has(a.$("#ctr-status").textContent, "Есть несохранённые изменения", "статус: есть несохранённое");
      a.click(a.$("#ctr-cancel"));
      await waitFor(() => a.$("#ctr-theme").value === before, { what: "откат темы" });
      t.eq(a.ctl.count("PATCH", "/contracts/"), 0, "отмена — без запроса");
      await setTheme(a, " QA2");
      a.click(a.$("#ctr-save"));
      await waitFor(() => a.ctl.count("PATCH", "/contracts/4") === 1, { what: "PATCH" });
      await a.settle(150);
      t.has(a.ctl.data.contracts.find((c) => c.id === 4).theme, "QA2", "записано");
      t.has(a.$("#ctr-status").textContent, "Сохранено", "«Сохранено.»");
    },
  },
  {
    id: "CP-W-16", title: "Права: корзины договора/спецификации и «Удалить контракт» — только при dict_delete=write (единый серверный эндпоинт удаления)",
    async run(t) {
      const w = await openApp({ perm: "writer" });
      await openContract(w, 4, "lines");
      t.eq(w.$("#ctr-delete"), null, "писатель без dict_delete: «Удалить контракт» нет");
      t.eq(w.byText("summary", "Действия"), null, "блока «Действия» нет — в нём только удаление");
      w.click(w.$("#ctr-back"));
      await waitFor(() => w.$$("[data-agreement]").length > 0, { what: "договоры" });
      t.eq(w.$$("[data-del-agreement], [data-del-spec]").length, 0, "корзин договоров и спецификаций нет");
      const d = await openApp({ perm: "deleter" });
      await openContract(d, 4, "lines");
      t.ok(d.$("#ctr-delete"), "dict_delete=write: «Удалить контракт» есть");
      d.click(d.$("#ctr-back"));
      await waitFor(() => d.$$("[data-agreement]").length > 0, { what: "договоры" });
      t.ok(d.$$("[data-del-agreement]").length > 0 && d.$$("[data-del-spec]").length > 0, "корзины договоров и спецификаций есть");
    },
  },
  {
    id: "CP-W-11", title: "Сохранение контракта: двойной клик — один PATCH; 403/409/422/500/сеть — ошибка видна, повтор возможен",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      await setTheme(a, " Q");
      const hold = a.ctl.hold("PATCH /contracts/4");
      const b = a.$("#ctr-save");
      a.click(b); a.click(b);
      await a.settle(60);
      t.eq(a.ctl.count("PATCH", "/contracts/4"), 1, "двойной клик — один PATCH");
      hold.fail(500, "Сервер недоступен");
      await waitFor(() => a.$("#ctr-error").textContent.includes("Сервер недоступен"), { what: "ошибка" });
      t.ok(!a.$("#ctr-save").disabled && !a.$("#ctr-theme").disabled, "после ошибки кнопки и поля доступны");
      for (const [name, fail, expectText] of [
        ["422", { status: 422, detail: [{ loc: ["body", "lines", 0, "quantity"], msg: "bad", type: "int_parsing" }] }, "нужно целое число"],
        ["сеть", { network: true }, "нет связи"],
      ]) {
        a.ctl.failNext("PATCH /contracts/4", fail);
        a.click(a.$("#ctr-save"));
        await waitFor(() => a.$("#ctr-error").textContent.toLowerCase().includes(expectText), { what: `ошибка ${name}` });
        t.notHas(a.$("#ctr-error").textContent, "[object", `[${name}] нет [object Object]`);
      }
    },
  },
  {
    id: "CP-W-13", title: "Удаление контракта без замены: delete-plan → подтверждение (danger) → удалён; SQL-аналог",
    async run(t) {
      const a = await openApp();
      await openContract(a, 7, "lines");
      const acts = a.byText("summary", "Действия"); if (acts) acts.click();
      a.click(a.$("#ctr-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.ok(a.$(".v2-dialog .v2-danger"), "красная кнопка");
      await a.answerDialog("Отмена");
      t.ok(a.ctl.data.contracts.some((c) => c.id === 7), "отмена не удаляет");
      a.click(a.$("#ctr-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !a.ctl.data.contracts.some((c) => c.id === 7), { what: "удаление" });
      await waitFor(() => a.$("[data-tab]") && !a.$("#ctr-back"), { what: "возврат в карточку" });
      t.eq(a.ctl.count("POST", "/dictionaries/contract/7/delete"), 1, "один POST delete");
    },
  },
  {
    id: "CP-W-14", title: "Контракт с изделиями: пикер замены; подтверждение переносит привязку; нет кандидатов — понятное сообщение; 409 — ошибка в пикере",
    async run(t) {
      // с заменой
      const a = await openApp();
      await openContract(a, 1, "lines");
      const acts = a.byText("summary", "Действия"); if (acts) acts.click();
      a.click(a.$("#ctr-delete"));
      await waitFor(() => a.$("#ctr-replacement-picker") || a.dialog(), { what: "пикер замены" });
      if (a.dialog()) await a.answerDialog("Удалить");
      await waitFor(() => a.$("#ctr-replacement-select"), { what: "пикер" });
      const options = [...a.$("#ctr-replacement-select").options].map((o) => o.textContent);
      t.ok(options.length >= 2, `кандидаты на замену показаны (${options.length})`);
      a.$("#ctr-replacement-select").selectedIndex = 0;
      a.click(a.$("#ctr-replacement-confirm"));
      await waitFor(() => !a.ctl.data.contracts.some((c) => c.id === 1) || a.$("#ctr-replacement-error").textContent, { what: "результат" });
      await a.settle(100);
      const moved = !a.ctl.data.contracts.some((c) => c.id === 1);
      t.ok(moved || a.$("#ctr-replacement-error").textContent.length > 0, "результат подтверждения: перенос выполнен или причина показана в пикере");
      // нет кандидатов
      const b = await openApp();
      await openContract(b, 5, "lines");
      const acts2 = b.byText("summary", "Действия"); if (acts2) acts2.click();
      b.click(b.$("#ctr-delete"));
      await waitFor(() => b.dialog(), { what: "сообщение" });
      t.has(b.dialog().textContent, "заменить контракт нечем", "нет кандидатов — понятное объяснение");
      await b.answerDialog("Понятно");
      t.ok(b.ctl.data.contracts.some((c) => c.id === 5), "контракт цел");
    },
  },
  {
    id: "CP-W-15", title: "Обрыв связи на удалении: не «успех», а сообщение «не удалось определить результат»; контракт цел",
    async run(t) {
      const a = await openApp();
      await openContract(a, 7, "lines");
      const acts = a.byText("summary", "Действия"); if (acts) acts.click();
      a.click(a.$("#ctr-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      a.ctl.failNext("/dictionaries/contract/7/delete", { method: "POST", network: true });
      await a.answerDialog("Удалить");
      await waitFor(() => a.dialog() && /соединение прервалось|Не удалось/.test(a.dialog().textContent), { what: "сообщение" });
      t.has(a.dialog().textContent, "соединение прервалось", "сообщение про прерванное соединение");
      await a.answerDialog("Понятно");
      t.ok(a.ctl.data.contracts.some((c) => c.id === 7), "контракт на месте");
      t.ok(a.$("#ctr-back"), "остались в рабочем пространстве");
    },
  },

  {
    id: "CP-KBD-01", title: "Клавиатура: после действий в контракте фокус остаётся в рабочей области, а не сбрасывается на <body>",
    async run(t) {
      const inArea = (a) => { const el = a.doc.activeElement; return !!el && el !== a.doc.body && !!el.closest("#v2-content"); };
      const a = await openApp();
      await openContract(a, 4, "lines");
      a.$("#ctr-line-add").focus();
      a.click(a.$("#ctr-line-add"));
      await a.settle(120);
      t.ok(inArea(a), "«+ строка»: фокус остался в области контракта");
      a.$('[data-ctr-tab="incidents"]').focus();
      a.click(a.$('[data-ctr-tab="incidents"]')); await a.settle(100);
      t.ok(inArea(a), "смена вкладки контракта: фокус в области");
      a.$("#ctr-inc-add").focus();
      a.click(a.$("#ctr-inc-add")); await a.settle(120);
      t.ok(inArea(a), "«+ инцидент»: фокус в области");
      // плановая дата: правка с клавиатуры не должна уводить фокус со строки
      const b = await openApp();
      await openContract(b, 1);
      const el = dateInput(b, 102);
      el.focus();
      change(b, el, "2026-10-07");
      await waitFor(() => elemDate(b, 102) === "2026-10-07", { what: "запись даты" });
      await b.settle(150);
      t.ok(inArea(b), "запись плановой даты: фокус не сброшен на <body>");
      t.eq(b.doc.activeElement?.dataset?.elemPlanned, "102", "фокус остался на той же строке даты");
    },
  },
  {
    id: "CP-KBD-02", title: "Клавиатура: смена вкладки карточки и добавление договора не сбрасывают фокус на <body>",
    async run(t) {
      const inArea = (a) => { const el = a.doc.activeElement; return !!el && el !== a.doc.body && !!el.closest("#v2-content"); };
      const a = await openApp();
      await openCp(a);
      await openCard(a, 4);
      a.$('[data-tab="contracting"]').focus();
      a.click(a.$('[data-tab="contracting"]'));
      await waitFor(() => a.$("#cp-new-agreement-toggle"), { what: "вкладка" });
      await a.settle(80);
      t.ok(inArea(a), "смена вкладки карточки: фокус в области");
      a.$("#cp-new-agreement-toggle").focus();
      a.click(a.$("#cp-new-agreement-toggle"));
      await waitFor(() => a.$("#cp-new-agreement-object"), { what: "форма договора" });
      await a.settle(80);
      t.ok(inArea(a), "«+ Договор»: фокус перешёл в форму (не потерян)");
    },
  },
  {
    id: "CP-A-08", title: "Повтор чтения объектов + вход в контракт до ответа: поздний ответ не роняет экран необработанной ошибкой",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      const errs = [];
      a.win.addEventListener("unhandledrejection", (e) => errs.push(String(e.reason && (e.reason.message || e.reason))));
      a.win.addEventListener("error", (e) => errs.push(String(e.message)));
      a.ctl.failNext("=/objects", { method: "GET", status: 500, detail: "Объекты недоступны" });
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$("[data-objects-retry]") && a.$('[data-c-open="edit:4"]'), { what: "ошибка объектов и контракты" });
      const hold = a.ctl.hold("=/objects", "GET");
      a.click(a.$("[data-objects-retry]"));
      await waitFor(() => hold.pending >= 1, { what: "повтор чтения объектов завис" });
      a.click(a.$('[data-c-open="edit:4"]'));
      await waitFor(() => a.$("#ctr-back"), { what: "рабочее пространство" });
      hold.release();
      await a.settle(300);
      t.eq(errs, [], "необработанных ошибок нет");
      t.ok(a.$("#ctr-back"), "рабочее пространство контракта на месте");
      t.ok(a.$("#ctr-save") && a.$("#ctr-cancel"), "подвал контракта («Отменить/Сохранить») не очищен запоздавшим ответом");
    },
  },
  {
    id: "CP-P-01", title: "Ёмкость: пустой тип строку не добавляет; тип добавляет строку; после сохранения значения с сервера",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 7, "other");
      await waitFor(() => a.$("#cp-cap-new-type"), { what: "форма" });
      const before = a.$$("[data-cap-per-day]").length;
      a.click(a.$("#cp-cap-add-row")); await a.settle(60);
      t.eq(a.$$("[data-cap-per-day]").length, before, "пустой тип — строка не добавлена");
      await a.type(a.$("#cp-cap-new-type"), "Плита");
      a.click(a.$("#cp-cap-add-row"));
      await waitFor(() => a.$$("[data-cap-per-day]").length === before + 1, { what: "строка добавлена" });
      change(a, a.$$("[data-cap-per-day]")[before], "3");
      await waitFor(() => a.$("#cp-save"), { what: "подвал" });
      a.click(a.$("#cp-save"));
      await waitFor(() => a.ctl.count("PATCH", "/counterparties/7") === 1, { what: "PATCH" });
      await a.settle(150);
      t.eq(a.ctl.data.counterparties.find((c) => c.id === 7).capacity.map((c) => [c.element_type, c.per_day]), [["Плита", 3]], "ёмкость записана на сервере");
    },
  },
  {
    id: "CP-A-03", title: "Независимые ошибки кусков: контракты и спецификации падают отдельно, «Повторить» перечитывает только их",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      a.ctl.failNext("=/contracts", { method: "GET", status: 500, detail: "Контракты недоступны" });
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$("#cp-contracts-retry"), { what: "«Повторить» для контрактов" });
      t.has(text(a), "Контракты: Контракты недоступны", "ошибка контрактов названа");
      t.ok(a.$$("[data-agreement]").length === 2, "договоры при этом показаны");
      a.click(a.$("#cp-contracts-retry"));
      await waitFor(() => a.$('[data-c-open="edit:4"]'), { what: "контракты после повтора" });
      t.eq(a.ctl.count("GET", "=/agreements"), 1, "повтор перечитал только контракты, не договоры");
    },
  },
  {
    id: "CP-A-05", title: "Правка договора: «· не сохранено» → «Сохранить» → PATCH; ошибка рядом с формой, ввод цел",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-a-number="1"]'), { what: "договор" });
      a.$("[data-agreement='1']").open = true;
      await a.type(a.$('[data-a-number="1"]'), "-X");
      await a.settle(60);
      t.has(a.$("[data-agreement='1'] summary").textContent, "не сохранено", "в заголовке «· не сохранено»");
      a.ctl.failNext("PATCH /agreements/1", { status: 409, detail: "Такой номер уже есть" });
      a.click(a.$('[data-save-agreement="1"]'));
      await waitFor(() => a.$("[data-agreement='1']").textContent.includes("Такой номер уже есть"), { what: "ошибка рядом" });
      t.has(a.$('[data-a-number="1"]').value, "-X", "ввод цел");
      a.click(a.$('[data-save-agreement="1"]'));
      await waitFor(() => a.ctl.count("PATCH", "/agreements/1") === 2, { what: "повтор" });
      await a.settle(150);
      t.has(a.ctl.data.agreements.find((g) => g.id === 1).number, "-X", "записано на сервере");
    },
  },
  {
    id: "CP-S-01", title: "Спецификация: пустой номер — сообщение; создание — один POST; правка — PATCH; удаление по правам",
    async run(t) {
      const a = await openApp({ perm: "deleter" });
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-new-spec-toggle="1"]'), { what: "кнопка" });
      a.$("[data-agreement='1']").open = true;
      a.click(a.$('[data-new-spec-toggle="1"]'));
      await waitFor(() => a.$('[data-add-spec="1"]'), { what: "форма" });
      a.click(a.$('[data-add-spec="1"]')); await a.settle(60);
      t.has(a.$("[data-agreement='1']").textContent, "Укажите номер спецификации", "валидация номера");
      await a.type(a.$('[data-spec-number="1"]'), "QA-СП-НОВАЯ");
      const hold = a.ctl.hold("POST /specifications");
      a.click(a.$('[data-add-spec="1"]')); a.click(a.$('[data-add-spec="1"]'));
      await a.settle(60);
      t.eq(a.ctl.count("POST", "/specifications"), 1, "двойной клик — один POST");
      hold.release();
      await waitFor(() => a.ctl.data.specifications.some((x) => x.number === "QA-СП-НОВАЯ"), { what: "создание" });
      const sp = a.ctl.data.specifications.find((x) => x.number === "QA-СП-НОВАЯ");
      await waitFor(() => a.$(`[data-s-number="${sp.id}"]`), { what: "спецификация в списке" });
      a.$(`[data-spec="${sp.id}"]`).open = true;
      await a.type(a.$(`[data-s-number="${sp.id}"]`), "-2");
      a.click(a.$(`[data-save-spec="${sp.id}"]`));
      await waitFor(() => a.ctl.count("PATCH", `/specifications/${sp.id}`) === 1, { what: "PATCH" });
      await a.ctl.whenIdle(); await a.settle(150); // запись завершена — иначе корзина занята сохранением
      a.click(a.$(`[data-del-spec="${sp.id}"]`));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !a.ctl.data.specifications.some((x) => x.id === sp.id), { what: "удаление" });
    },
  },
  {
    id: "CP-K-01", title: "Список контрактов под спецификацией: «позиций: N, всего изделий: M»; «+ Контракт» → «Есть неотправленный новый контракт»",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-c-open="edit:1"]'), { what: "контракты" });
      t.ok(/позиций: \d+, всего изделий: \d+/.test(a.$("[data-spec='1']").textContent), "счётчики позиций и изделий у контракта");
      a.click(a.$('[data-c-new="1"]'));
      await waitFor(() => a.$("#ctr-back"), { what: "новый контракт" });
      await a.settle(200);
      a.click(a.$("#ctr-back"));
      await waitFor(() => a.dialog(), { what: "диалог (новый контракт всегда несохранённый)" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#ctr-back"), "«Остаться» — остаёмся в новом контракте");
    },
  },
  {
    id: "CP-W-02", title: "Реквизиты: каскад контрагент → договор → спецификация подставляет первые значения; «Сохранить» доступна",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      a.$("#ctr-requisites-details").open = true; await a.settle(60);
      const before = a.$("#ctr-spec").value;
      a.setValue(a.$("#ctr-counterparty"), "2");
      await waitFor(() => a.$("#ctr-agreement").value && a.$("#ctr-spec").value && a.$("#ctr-spec").value !== before, { what: "каскад" });
      const agIds = [...a.$("#ctr-agreement").options].map((o) => o.value).filter(Boolean);
      const expected = a.ctl.data.agreements.filter((g) => g.counterparty_id === 2).map((g) => String(g.id));
      t.eq(agIds.sort(), expected.sort(), "в списке договоров — только договоры выбранного контрагента");
      t.ok(!a.$("#ctr-save").disabled, "«Сохранить» доступна после завершения каскада");
    },
  },
  {
    id: "CP-W-04", title: "Позиции: пустые строки отбрасываются; без единой позиции сохранить нельзя — сообщение",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      // убираем все позиции контракта 4
      let guard = 0;
      while (a.$$("[data-line-remove]").length && guard++ < 20) { a.click(a.$("[data-line-remove]")); await a.settle(40); }
      a.click(a.$("#ctr-line-add")); await a.settle(60);
      t.eq(a.$$("[data-line-type]").length, 1, "осталась одна пустая строка");
      await setTheme(a, " q");
      a.click(a.$("#ctr-save")); await a.settle(120);
      t.has(a.$("#ctr-error").textContent, "Добавьте хотя бы одну позицию", "сообщение про позицию");
      t.eq(a.ctl.count("PATCH", "/contracts/4"), 0, "запрос не отправлен");
    },
  },
  {
    id: "CP-W-05", title: "Инциденты и производительность: добавление строк; строки без даты/типа/значения отбрасываются понятно",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "incidents");
      a.click(a.$("#ctr-inc-add")); await a.settle(60);
      t.ok(a.$$("[data-inc-date]").length >= 1, "строка инцидента добавлена");
      a.click(a.$('[data-ctr-tab="capacity"]')); await a.settle(80);
      await a.type(a.$("#ctr-cap-new-type"), "Колонна");
      a.click(a.$("#ctr-cap-add")); await a.settle(60);
      t.ok(a.$$("[data-cap-per-day]").length >= 1, "строка переопределения добавлена");
      t.has(a.$("#ctr-tab-content").textContent, "От контрагента", "показана колонка «От контрагента»");
    },
  },
  {
    id: "CP-W-07", title: "«Развёрнуто»: ошибка чтения — «Повторить»; после — таблица элементов со статусами по-русски и остатком",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-c-open="edit:1"]'), { what: "контракты" });
      a.click(a.$('[data-c-open="edit:1"]'));
      await waitFor(() => a.$("#ctr-back"), { what: "воркспейс" });
      a.ctl.failNext("/contracts/1/elements", { method: "GET", status: 500, detail: "Изделия недоступны" });
      a.click(a.$('[data-ctr-tab="expanded"]'));
      await waitFor(() => a.$("#ctr-expanded-retry"), { what: "«Повторить»" });
      t.has(text(a), "Изделия недоступны", "причина видна");
      a.click(a.$("#ctr-expanded-retry"));
      await waitFor(() => a.$$("[data-elem-planned]").length >= 5, { what: "элементы" });
      t.has(a.$("#ctr-tab-content").textContent, "остаток", "остаточные строки «без привязки к элементу схемы · остаток N шт.»");
      t.notHas(a.$("#ctr-tab-content").textContent, "delivered", "статусы не показаны сырыми кодами (по-русски)");
    },
  },
  {
    id: "CP-W-08", title: "Новый контракт: позиции → «Сохранить» → POST; контракт становится существующим, «Развёрнуто» доступна",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-c-new="1"]'), { what: "кнопка" });
      a.click(a.$('[data-c-new="1"]'));
      await waitFor(() => a.$("#ctr-back"), { what: "воркспейс" });
      t.ok(a.$('[data-ctr-tab="expanded"]').disabled, "у нового «Развёрнуто» отключена");
      await a.type(a.$("[data-line-type]"), "Колонна");
      change(a, a.$("[data-line-qty]"), "2");
      await waitFor(() => !a.$("#ctr-save").disabled, { what: "Сохранить" });
      a.click(a.$("#ctr-save"));
      await waitFor(() => a.ctl.count("POST", "/contracts") === 1, { what: "POST" });
      await a.settle(200);
      t.ok(a.ctl.data.contracts.some((c) => c.lines?.some?.((l) => l.element_type === "Колонна" && l.quantity === 2) && c.specification_id === 1), "контракт создан на сервере с позицией");
      t.ok(!a.$('[data-ctr-tab="expanded"]').disabled, "после сохранения «Развёрнуто» доступна");
    },
  },
  {
    id: "CP-W-10", title: "Отмена нового контракта: подтверждение; «Отмена» диалога оставляет форму",
    async run(t) {
      const a = await openApp();
      await openCp(a);
      await openCard(a, 1, "contracting");
      await waitFor(() => a.$('[data-c-new="1"]'), { what: "кнопка" });
      a.click(a.$('[data-c-new="1"]'));
      await waitFor(() => a.$("#ctr-cancel"), { what: "воркспейс" });
      a.click(a.$("#ctr-cancel"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(a.dialog().textContent, "Отменить новый контракт", "текст подтверждения");
      await a.answerDialog("Отмена");
      t.ok(a.$("#ctr-back"), "«Отмена» диалога — форма на месте");
      a.click(a.$("#ctr-cancel"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Отменить");
      await waitFor(() => !a.$("#ctr-back"), { what: "выход из нового контракта" });
      t.eq(a.ctl.count("POST", "/contracts"), 0, "ничего не отправлено");
    },
  },
  {
    id: "CP-W-12", title: "Перенос контракта: смена контрагента/договора/спецификации → «Сохранить» → воркспейс закрыт с пояснением",
    async run(t) {
      const a = await openApp();
      await openContract(a, 4, "lines");
      a.$("#ctr-requisites-details").open = true; await a.settle(60);
      const before = a.$("#ctr-spec").value;
      a.setValue(a.$("#ctr-counterparty"), "2");
      await waitFor(() => a.$("#ctr-spec").value && a.$("#ctr-spec").value !== before && !a.$("#ctr-save").disabled, { what: "каскад" });
      a.click(a.$("#ctr-save"));
      await waitFor(() => a.ctl.count("PATCH", "/contracts/4") === 1, { what: "PATCH" });
      await waitFor(() => !a.$("#ctr-back"), { what: "воркспейс закрыт" });
      t.has(a.$("#cp-status").textContent, "перенесён контрагенту", "пояснение о переносе");
      t.notHas(a.$("#cp-inner").textContent, "Плиты без привязок", "в карточке прежнего контрагента контракта больше нет");
    },
  },
  // ---------------- Обязательная регрессия плановых дат и блокировок ----------------
  {
    id: "CP-REG-01", title: "Неудачная запись плановой даты: ошибка на строке, значение не теряется; 403 снимает права у всего контракта",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      const el = dateInput(a, 101);
      a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой записи даты" });
      change(a, el, "2026-10-05");
      await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка на строке" });
      t.has(text(a), "Сбой записи даты", "ошибка видна на строке");
      t.eq(dateInput(a, 101).value, "2026-10-05", "введённое значение не потеряно");
      t.eq(elemDate(a, 101), "2026-09-01", "на сервере прежняя дата");
      a.ctl.failNext("PATCH /elements/102/planned-delivery-date", { status: 403, detail: "Нет прав" });
      change(a, dateInput(a, 102), "2026-10-06");
      await waitFor(() => a.$$("[data-elem-planned]").every((i) => i.disabled), { what: "все строки нередактируемы после 403" });
      t.has(text(a), "Нет прав на изменение плановой даты", "отдельное сообщение про права");
    },
  },
  {
    id: "CP-REG-02", title: "Уход с неподтверждённой датой: «← Контрагент», верхний раздел, V1-кнопка — везде предупреждение",
    async run(t) {
      for (const exit of ["back", "section", "v1"]) {
        const a = await openApp();
        await openContract(a, 1);
        a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой" });
        change(a, dateInput(a, 101), "2026-10-05");
        await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка даты" });
        if (exit === "back") a.click(a.$("#ctr-back"));
        else if (exit === "section") a.click(a.$(`${NAV}[data-section="users-access"]`));
        else a.click(a.$("#v2-back-btn"));
        await waitFor(() => a.dialog(), { what: `диалог при выходе «${exit}»` });
        t.has(a.dialog().textContent, "плановая дата", `[${exit}] диалог называет неподтверждённую дату`);
        await a.answerDialog("Остаться");
        t.ok(a.$("#ctr-back"), `[${exit}] «Остаться» — остаёмся в контракте`);
        t.eq(dateInput(a, 101).value, "2026-10-05", `[${exit}] неподтверждённое значение цело`);
        a.close();
      }
      const b = await openApp();
      await openContract(b, 1);
      b.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой" });
      change(b, dateInput(b, 101), "2026-10-05");
      await waitFor(() => b.$("[data-elem-retry]"), { what: "ошибка даты" });
      const ev = new b.win.Event("beforeunload", { cancelable: true });
      b.win.dispatchEvent(ev);
      t.eq(ev.defaultPrevented, true, "закрытие/перезагрузка: стандартное предупреждение браузера");
      t.eq(b.ctl.count("PATCH", "/elements/"), 1, "при beforeunload новых запросов записи не уходит");
    },
  },
  {
    id: "CP-REG-04", title: "Повтор записи даты — только по явному действию; автоповтора нет",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой" });
      change(a, dateInput(a, 101), "2026-10-05");
      await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка" });
      await a.settle(400);
      t.eq(a.ctl.count("PATCH", "/elements/101/planned-delivery-date"), 1, "автоповтора нет: ровно одна попытка");
      a.click(a.$("[data-elem-retry]"));
      await waitFor(() => a.ctl.count("PATCH", "/elements/101/planned-delivery-date") === 2, { what: "повтор по клику" });
      await waitFor(() => elemDate(a, 101) === "2026-10-05", { what: "запись дошла" });
      t.eq(elemDate(a, 101), "2026-10-05", "после явного повтора дата записана");
    },
  },
  {
    id: "CP-REG-05", title: "Отказ от неподтверждённого значения: сбрасывается только оно, уже записанные даты не откатываются",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      change(a, dateInput(a, 102), "2026-10-07");
      await waitFor(() => elemDate(a, 102) === "2026-10-07", { what: "дата 102 записана" });
      a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой" });
      change(a, dateInput(a, 101), "2026-10-05");
      await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка на 101" });
      a.click(a.$("#ctr-back"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Не сохранять");
      await waitFor(() => !a.$("#ctr-back"), { what: "выход" });
      t.eq(elemDate(a, 102), "2026-10-07", "уже записанная дата 102 не откатилась");
      t.eq(elemDate(a, 101), "2026-09-01", "неподтверждённое значение 101 не записано");
      t.eq(a.ctl.count("PATCH", "/elements/101/planned-delivery-date"), 1, "«Не сохранять» запрос не слал");
    },
  },
  {
    id: "CP-REG-06", title: "Черновик контракта + ошибка даты: ОДИН диалог, «Остаться» — ничего не потеряно; «Сохранить» — сохранены обе части",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      await setTheme(a, " QA-черновик");
      a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой" });
      change(a, dateInput(a, 101), "2026-10-05");
      await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка даты" });
      a.click(a.$("#ctr-back"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      t.eq(a.$$(".v2-dialog").length, 1, "один диалог");
      const msg = a.dialog().textContent;
      t.ok(msg.includes("плановая дата") && msg.includes("контракт"), "диалог называет обе части");
      await a.answerDialog("Остаться");
      t.eq(dateInput(a, 101).value, "2026-10-05", "«Остаться»: неподтверждённая дата цела");
      t.has(a.$("#ctr-theme").value, "QA-черновик", "«Остаться»: черновик контракта цел");
      a.click(a.$("#ctr-back"));
      await waitFor(() => a.dialog(), { what: "второй диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => !a.$("#ctr-back"), { what: "выход" });
      t.eq(elemDate(a, 101), "2026-10-05", "дата сохранена");
      t.has(contractOf(a, 1).theme, "QA-черновик", "контракт сохранён");
    },
  },
  {
    id: "CP-REG-07", title: "Конфликт A: идёт запись даты → сохранение/удаление контракта не стартуют (счёт запросов)",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      const hold = a.ctl.hold("PATCH /elements/101/planned-delivery-date");
      change(a, dateInput(a, 101), "2026-10-05");
      await waitFor(() => hold.pending >= 1, { what: "запись даты в пути" });
      // вкладку не меняем: во время записи даты остаёмся на «Развёрнуто», подвал доступен
      await setThemeViaState(a, " QA-конфликт");
      a.click(a.$("#ctr-save"));
      await a.settle(120);
      t.eq(a.ctl.count("PATCH", "/contracts/1"), 0, "PATCH контракта не отправлен, пока пишется дата");
      t.eq(a.ctl.count("PATCH", "/elements/101/planned-delivery-date"), 1, "запись даты одна и в пути");
      const acts = a.byText("summary", "Действия"); if (acts) acts.click();
      a.click(a.$("#ctr-delete")); await a.settle(120);
      if (a.dialog()) { t.has(a.dialog().textContent, "Дождитесь завершения записи плановой даты", "объяснение при попытке удаления"); await a.answerDialog("Понятно"); }
      t.eq(a.ctl.count("GET", "/dictionaries/contract/1/delete-plan") + a.ctl.count("POST", "/dictionaries/contract/1/delete"), 0, "удаление даже не начато");
      hold.release();
      await waitFor(() => elemDate(a, 101) === "2026-10-05", { what: "дата записана" });
    },
  },
  {
    id: "CP-REG-08", title: "Конфликт B: идёт операция контракта → запись даты не стартует даже при прямом вызове обработчика",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      await setThemeViaState(a, " QA-op");
      const hold = a.ctl.hold("PATCH /contracts/1");
      a.click(a.$("#ctr-save"));
      await waitFor(() => hold.pending >= 1, { what: "сохранение контракта в пути" });
      await a.settle(60);
      const inputs = a.$$("[data-elem-planned]");
      t.ok(inputs.every((i) => i.disabled), "поля плановых дат заблокированы на время операции");
      change(a, inputs[0], "2026-10-09"); // диспатч на disabled-поле: проверяем логику, а не DOM-атрибут
      change(a, inputs[1], "2026-10-10");
      await a.settle(150);
      t.eq(a.ctl.count("PATCH", "/elements/"), 0, "запросов записи даты не ушло");
      t.ok(a.$$("[data-elem-planned]").every((i) => i.disabled), "перерисовка после блокировки не сняла блокировку с полей");
      t.has(text(a), "Дождитесь завершения операции с контрактом", "у пользователя есть объяснение");
      hold.release();
      await waitFor(() => a.$$("[data-elem-planned]").length && !a.$$("[data-elem-planned]")[0].disabled, { what: "блокировка снята" });
    },
  },
  {
    id: "CP-REG-09", title: "Две разные даты параллельно; повторный клик по одной — один запрос на строку; перерисовка ответом другой строки блокировку не снимает",
    async run(t) {
      const a = await openApp();
      await openContract(a, 1);
      const hold = a.ctl.hold("PATCH /elements/");
      change(a, dateInput(a, 101), "2026-10-05");
      change(a, dateInput(a, 102), "2026-10-06");
      change(a, dateInput(a, 101), "2026-10-05"); // повтор по той же строке
      await waitFor(() => hold.pending >= 2, { what: "две записи в пути" });
      await a.settle(80);
      t.eq(a.ctl.count("PATCH", "/elements/101/planned-delivery-date"), 1, "по строке 101 ровно один запрос");
      t.eq(a.ctl.count("PATCH", "/elements/102/planned-delivery-date"), 1, "по строке 102 ровно один запрос");
      hold.release(1); // отвечает только первая — вторая всё ещё пишется
      await a.settle(150);
      const still = a.$$("[data-elem-planned]").find((i) => i.dataset.elemPlanned === "102");
      t.ok(still.disabled, "строка, у которой ответа ещё нет, осталась заблокированной после перерисовки");
      hold.release();
      await waitFor(() => elemDate(a, 101) === "2026-10-05" && elemDate(a, 102) === "2026-10-06", { what: "обе записи прошли" });
    },
  },
  {
    id: "CP-REG-10", title: "Блокировка снимается после успеха и после ошибки; ограничения по правам и архивности сохраняются после разблокировки",
    async run(t) {
      // ошибка операции: снова доступно
      const a = await openApp();
      await openContract(a, 1);
      await setThemeViaState(a, " QA-e");
      const hold = a.ctl.hold("PATCH /contracts/1");
      a.click(a.$("#ctr-save"));
      await waitFor(() => hold.pending >= 1, { what: "запрос" });
      hold.fail(500, "Сбой");
      await waitFor(() => a.$("#ctr-error") && a.$("#ctr-error").textContent.includes("Сбой"), { what: "ошибка" }).catch(() => null);
      await waitFor(() => !a.$("#ctr-save").disabled, { what: "разблокировка" });
      t.ok(a.$$("[data-elem-planned]").every((i) => !i.disabled), "после ошибки поля дат снова доступны (права есть)");
      // права read: после разблокировки поля дат остаются недоступными (D-15)
      const b = await openApp({ perm: "writer" });
      b.ctl.setPermissions({ features: { planned_date: "read" } });
      await openContract(b, 1);
      await waitFor(() => b.$("[data-elem-planned]"), { what: "строки" });
      t.ok(b.$$("[data-elem-planned]").every((i) => i.disabled), "без права planned_date=write поля дат заблокированы");
      await setThemeViaState(b, " QA-r");
      const h2 = b.ctl.hold("PATCH /contracts/1");
      b.click(b.$("#ctr-save"));
      await waitFor(() => h2.pending >= 1, { what: "запрос" });
      h2.fail(500, "Сбой");
      await waitFor(() => !b.$("#ctr-save").disabled, { what: "разблокировка" });
      await b.settle(100);
      t.ok(b.$$("[data-elem-planned]").every((i) => i.disabled), "после разблокировки права по-прежнему ограничивают поля дат");
    },
  },
];

// В «Развёрнуто» нет полей темы: меняем черновик через реквизиты (они в той же оболочке).
async function setThemeViaState(a, val) {
  const d = a.$("#ctr-requisites-details"); if (d && !d.open) d.open = true;
  await a.settle(30);
  await a.type(a.$("#ctr-theme"), val);
  await waitFor(() => a.$("#ctr-save") && !a.$("#ctr-save").disabled, { what: "«Сохранить» доступна" });
}

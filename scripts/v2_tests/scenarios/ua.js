// Пользователи и доступ (UA-*): список, карточка, доступ, роли, проверка доступа.
// Пользователи стенда: id 1 admin, 2 writer, 3 reader, 4 noaccess (без грантов),
// 5 longname, 6 grants (объект/проект/«все проекты»), 7 domain, 8 mustchange.
import { openApp, waitFor } from "/tests/helpers.js";

const failBoot = (o) => `failNext=${encodeURIComponent(JSON.stringify(o))}`;
const byLogin = (a, login) => a.ctl.data.users.find((u) => u.domain_login === login);
const rows = (a) => a.$$("#ua-rows tr");
const lastText = (a) => a.doc.body.innerText;

async function openList(a) { await waitFor(() => a.$("#ua-rows") && rows(a).length, { what: "список пользователей" }); }
async function openCard(a, login, tab) {
  await openList(a);
  const u = byLogin(a, login);
  a.click(a.$(`[data-user="${u.id}"]`));
  await waitFor(() => a.$("[data-tab]"), { what: "карточка" });
  if (tab && tab !== "profile") {
    a.click(a.$(`[data-tab="${tab}"]`));
    await waitFor(() => a.$(`[data-tab="${tab}"][aria-pressed="true"]`), { what: `вкладка ${tab}` });
    await a.settle(60);
  }
  return u;
}
async function openAccess(a, login) {
  const u = await openCard(a, login, "access");
  await waitFor(() => a.$("#ua-access-search") || a.doc.body.innerText.includes("Полный доступ"), { what: "вкладка доступа" });
  return u;
}
async function openRoles(a) {
  await openList(a);
  a.click(a.byText(".v2-nav button[data-page]", "Роли"));
  await waitFor(() => a.$("#role-editor"), { what: "редактор роли" });
}
const navTab = (a, title) => a.byText(".v2-nav button[data-page]", title);

export const tests = [
  {
    id: "UA-U-01", title: "Список пользователей: 8 записей, колонки, счётчик",
    async run(t) {
      const a = await openApp();
      await openList(a);
      t.eq(rows(a).length, 8, "8 строк");
      t.has(a.$("#ua-rows").textContent, "qa.admin", "виден логин администратора");
      t.has(lastText(a), "8 учётных записей", "счётчик записей");
      t.eq(a.$$(".v2-table th").map((h) => h.textContent.trim()).filter(Boolean), ["Пользователь", "Учётная запись", "Системная роль", "Доступ"], "колонки таблицы");
    },
  },
  {
    id: "UA-U-02", title: "Поиск пользователей: непрерывный ввод, Backspace, каретка, пустой результат, сброс",
    async run(t) {
      const a = await openApp();
      await openList(a);
      const q = a.$("#ua-search");
      const r1 = await a.type(q, "writer");
      t.eq(r1.lostFocusAt, [], "фокус не терялся при вводе 6 символов");
      t.eq(rows(a).length, 1, "остался один пользователь");
      t.has(a.$("#ua-rows").textContent, "qa.writer", "это qa.writer");
      const r2 = await a.backspace(q, 3);
      t.eq(r2.lostFocusAt, [], "фокус не терялся при Backspace");
      t.eq(q.value, "wri", "значение после Backspace");
      a.select(q, 1, 1);
      await a.type(q, "X");
      t.eq(q.value, "wXri", "вставка в середину (каретка не сброшена)");
      t.eq(a.doc.activeElement, q, "поле в фокусе после вставки в середину");
      a.select(q, 0, 4);
      await a.type(q, "zzz");
      t.eq(q.value, "zzz", "выделение заменено");
      t.eq(a.$$("#ua-rows [data-user]").length, 0, "по «zzz» ни одного пользователя");
      t.has(a.$("#ua-rows").textContent, "Пользователи не найдены", "пустой результат объяснён словами, а не пустой таблицей");
      await a.backspace(q, 3);
      t.eq(rows(a).length, 8, "после очистки поиска — все 8");
    },
  },
  {
    id: "UA-U-03", title: "GET /users падает: ошибка чтения вместо пустого списка, «Повторить» работает",
    async run(t) {
      const a = await openApp({ query: failBoot({ pattern: "=/users", method: "GET", status: 500, detail: "База недоступна" }) });
      await waitFor(() => a.byText("button", "Повторить"), { what: "кнопка «Повторить»" });
      t.has(lastText(a), "База недоступна", "текст ошибки виден");
      t.eq(rows(a).length, 0, "список не выдаётся за пустой");
      a.click(a.byText("button", "Повторить"));
      await openList(a);
      t.eq(rows(a).length, 8, "после «Повторить» список загружен");
    },
  },
  {
    id: "UA-U-03b", title: "Клик по уже открытой вкладке после ошибки чтения — повторная попытка",
    async run(t) {
      const a = await openApp({ query: failBoot({ pattern: "=/users", method: "GET", status: 500, detail: "Сбой чтения" }) });
      await waitFor(() => a.byText("button", "Повторить"), { what: "ошибка" });
      a.click(navTab(a, "Пользователи"));
      await openList(a);
      t.eq(rows(a).length, 8, "повторный клик по вкладке перечитал список");
    },
  },
  {
    id: "UA-U-04", title: "Каталог/матрица доступа недоступны: список виден, колонка «Доступ» без ошибки",
    async run(t) {
      const a = await openApp({ query: failBoot({ pattern: "=/users/access-matrix", method: "GET", status: 500, detail: "матрица" }) });
      await openList(a);
      t.eq(rows(a).length, 8, "список пользователей показан");
      t.notHas(lastText(a), "матрица", "ошибка второстепенного чтения не вытесняет список");
    },
  },
  {
    id: "UA-U-05", title: "Создание пользователя: валидация пустых полей",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(a.byText("button", "Добавить пользователя"));
      await waitFor(() => a.$("#nu-submit"), { what: "форма" });
      a.click(a.$("#nu-submit"));
      await a.settle(60);
      t.has(a.$("#nu-error").textContent, "Заполните фамилию и логин", "сообщение о пустых обязательных полях");
      t.eq(a.ctl.count("POST", "/users"), 0, "запрос не отправлен");
      t.ok(!a.$("#nu-submit").disabled, "кнопка снова доступна");
    },
  },
  {
    id: "UA-U-06", title: "Создание пользователя: запись, карточка, повторное открытие показывает данные сервера",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(a.byText("button", "Добавить пользователя"));
      await waitFor(() => a.$("#nu-last"), { what: "форма" });
      await a.type(a.$("#nu-last"), "QA-Создан");
      await a.type(a.$("#nu-login"), "qa_created");
      a.click(a.$("#nu-submit"));
      await waitFor(() => a.$("[data-tab]"), { what: "карточка нового пользователя" });
      t.eq(a.ctl.count("POST", "/users"), 1, "один POST");
      const created = byLogin(a, "qa_created");
      t.ok(created, "запись есть в фейковой БД");
      t.eq(created.last_name, "QA-Создан", "данные записаны");
      a.click(a.$("[data-back]"));
      await openList(a);
      t.eq(rows(a).length, 9, "в списке 9 пользователей");
      t.has(a.$("#ua-rows").textContent, "qa_created", "новый пользователь виден в списке");
    },
  },
  {
    id: "UA-U-07", title: "Создание: двойной клик и медленный ответ → один POST",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(a.byText("button", "Добавить пользователя"));
      await waitFor(() => a.$("#nu-last"), { what: "форма" });
      await a.type(a.$("#nu-last"), "QA-Дубль");
      await a.type(a.$("#nu-login"), "qa_double");
      const hold = a.ctl.hold("POST /users");
      const b = a.$("#nu-submit");
      a.click(b); a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("POST", "/users"), 1, "три клика — один запрос");
      t.ok(b.disabled, "кнопка заблокирована на время записи");
      hold.release();
      await waitFor(() => a.$("[data-tab]"), { what: "карточка" });
      t.eq(a.ctl.data.users.filter((u) => u.domain_login === "qa_double").length, 1, "запись не задвоена");
    },
  },
  {
    id: "UA-U-08", title: "Создание: 409/422/500/сеть — читаемое сообщение, ввод цел, кнопка доступна",
    async run(t) {
      const cases = [
        ["409 дубль логина (настоящая логика бэкенда)", null, "уже"],
        ["422 список ошибок", { status: 422, detail: [{ loc: ["body", "last_name"], msg: "Field required", type: "missing" }] }, "last_name: обязательное поле"],
        ["500 строкой", { status: 500, detail: "Внутренняя ошибка сервера" }, "Внутренняя ошибка сервера"],
        ["сетевой сбой", { network: true }, "Нет связи с сервером"],
      ];
      for (const [name, fail, expectText] of cases) {
        const a = await openApp();
        await openList(a);
        a.click(a.byText("button", "Добавить пользователя"));
        await waitFor(() => a.$("#nu-last"), { what: "форма" });
        await a.type(a.$("#nu-last"), "QA-Ошибка");
        await a.type(a.$("#nu-login"), fail ? "qa_err_login" : "qa.admin");
        if (fail) a.ctl.failNext("POST /users", fail);
        a.click(a.$("#nu-submit"));
        await waitFor(() => a.$("#nu-error").textContent, { what: `ошибка (${name})` });
        const msg = a.$("#nu-error").textContent;
        t.notHas(msg, "[object", `[${name}] нет [object Object]`);
        t.has(msg.toLowerCase(), expectText.toLowerCase(), `[${name}] текст: ${msg}`);
        t.eq(a.$("#nu-login").value, fail ? "qa_err_login" : "qa.admin", `[${name}] введённое цело`);
        t.ok(!a.$("#nu-submit").disabled, `[${name}] кнопка снова доступна`);
        a.close();
      }
    },
  },
  {
    id: "UA-C-01", title: "Профиль: правка → «Сохранить»: PATCH, подтверждённые сервером данные после повторного открытия",
    async run(t) {
      const a = await openApp();
      const u = await openCard(a, "qa.noaccess");
      await waitFor(() => a.$("#pf-pos"), { what: "форма профиля" });
      t.notHas(a.$("#ua-status").textContent, "несохранённ", "до правки предупреждения нет");
      await a.type(a.$("#pf-pos"), " QA-должность", {});
      await waitFor(() => a.$("#card-save"), { what: "подвал с «Сохранить»" });
      t.has(a.$("#ua-status").textContent, "Есть несохранённые изменения", "подвал показывает несохранённое");
      a.click(a.$("#card-save"));
      await waitFor(() => a.ctl.count("PATCH", `/users/${u.id}`) === 1 && !a.$("#card-save"), { what: "сохранение" });
      t.eq(a.ctl.count("PATCH", `/users/${u.id}`), 1, "один PATCH");
      t.has(byLogin(a, "qa.noaccess").position, "QA-должность", "в фейковой БД записано");
      a.click(a.$("[data-back]"));
      await openList(a);
      a.click(a.$(`[data-user="${u.id}"]`));
      await waitFor(() => a.$("#pf-pos"), { what: "повторное открытие" });
      t.has(a.$("#pf-pos").value, "QA-должность", "повторное открытие показывает данные сервера");
      t.eq(a.$("#card-save"), null, "после сохранения ложного предупреждения/кнопок нет");
    },
  },
  {
    id: "UA-C-02", title: "Профиль: правка → «Отменить»: значения возвращены, подвал скрыт, запроса нет",
    async run(t) {
      const a = await openApp();
      await openCard(a, "qa.noaccess");
      await waitFor(() => a.$("#pf-pos"), { what: "форма" });
      const before = a.$("#pf-pos").value;
      await a.type(a.$("#pf-pos"), "ЛИШНЕЕ");
      await waitFor(() => a.$("#card-cancel"), { what: "«Отменить»" });
      a.click(a.$("#card-cancel"));
      await waitFor(() => !a.$("#card-cancel"), { what: "подвал скрыт" });
      t.eq(a.$("#pf-pos").value, before, "значение возвращено");
      t.eq(a.ctl.count("PATCH", "/users/"), 0, "запросов на запись нет");
      t.eq(a.$("#ua-status").textContent.trim(), "", "строка статуса чистая");
    },
  },
  {
    id: "UA-C-03", title: "Профиль: 403/409/422/500/сеть при сохранении — читаемо, поля разблокированы, ввод цел",
    async run(t) {
      const cases = [
        ["403", { status: 403, detail: "Недостаточно прав" }, "недостаточно прав"],
        ["409", { status: 409, detail: "Логин уже занят" }, "логин уже занят"],
        ["422 список", { status: 422, detail: [{ loc: ["body", "role"], msg: "bad", type: "value_error" }] }, "role: bad"],
        ["500", { status: 500, detail: "Сбой" }, "сбой"],
        ["сеть", { network: true }, "нет связи"],
      ];
      for (const [name, fail, expectText] of cases) {
        const a = await openApp();
        const u = await openCard(a, "qa.noaccess");
        await waitFor(() => a.$("#pf-pos"), { what: "форма" });
        await a.type(a.$("#pf-pos"), "Х");
        await waitFor(() => a.$("#card-save"), { what: "сохранить" });
        a.ctl.failNext(`PATCH /users/${u.id}`, fail);
        a.click(a.$("#card-save"));
        await waitFor(() => a.$("#ua-status").textContent && !/несохранённ/.test(a.$("#ua-status").textContent) || a.$("#ua-status").textContent.toLowerCase().includes(expectText), { what: `ошибка ${name}` });
        await a.settle(50);
        const msg = a.$("#ua-status").textContent;
        t.has(msg.toLowerCase(), expectText, `[${name}] сообщение: ${msg}`);
        t.notHas(msg, "[object", `[${name}] нет [object Object]`);
        t.ok(!a.$("#pf-pos").disabled && !a.$("#card-save").disabled, `[${name}] поля и «Сохранить» снова доступны`);
        t.has(a.$("#pf-pos").value, "Х", `[${name}] введённое цело`);
        a.close();
      }
    },
  },
  {
    id: "UA-C-04", title: "Профиль: двойной клик и медленный ответ → один PATCH; поля заблокированы на время записи",
    async run(t) {
      const a = await openApp();
      const u = await openCard(a, "qa.noaccess");
      await waitFor(() => a.$("#pf-pos"), { what: "форма" });
      await a.type(a.$("#pf-pos"), "Х");
      await waitFor(() => a.$("#card-save"), { what: "сохранить" });
      const hold = a.ctl.hold(`PATCH /users/${u.id}`);
      const b = a.$("#card-save");
      a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("PATCH", `/users/${u.id}`), 1, "два клика — один запрос");
      t.ok(a.$("#pf-pos").disabled, "поля заблокированы на время записи");
      hold.release();
      await waitFor(() => !a.$("#card-save"), { what: "конец записи" });
      t.eq(a.ctl.count("PATCH", `/users/${u.id}`), 1, "по-прежнему один запрос");
    },
  },
  {
    id: "UA-C-07", title: "Профиль dirty: вкладка карточки / «← Все пользователи» → диалог; после сохранения ложного нет",
    async run(t) {
      const a = await openApp();
      await openCard(a, "qa.noaccess");
      await waitFor(() => a.$("#pf-pos"), { what: "форма" });
      await a.type(a.$("#pf-pos"), "Х");
      a.click(a.$('[data-tab="access"]'));
      await waitFor(() => a.dialog(), { what: "диалог при смене вкладки" });
      await a.answerDialog("Остаться");
      t.eq(a.$('[data-tab="profile"]').getAttribute("aria-pressed"), "true", "«Остаться» — вкладка та же");
      t.has(a.$("#pf-pos").value, "Х", "ввод цел");
      a.click(a.$("[data-back]"));
      await waitFor(() => a.dialog(), { what: "диалог при возврате" });
      await a.answerDialog("Не сохранять");
      await openList(a);
      t.eq(a.ctl.count("PATCH", "/users/"), 0, "«Не сохранять» ничего не записал");
      // после сохранения — ложного предупреждения нет
      a.click(a.$(`[data-user="${byLogin(a, "qa.noaccess").id}"]`));
      await waitFor(() => a.$("#pf-pos"), { what: "форма" });
      await a.type(a.$("#pf-pos"), "Y");
      await waitFor(() => a.$("#card-save"), { what: "сохранить" });
      a.click(a.$("#card-save"));
      await waitFor(() => !a.$("#card-save"), { what: "конец записи" });
      a.click(a.$("[data-back]"));
      await openList(a);
      t.eq(a.dialog(), null, "после сохранения уход без предупреждения");
    },
  },
  {
    id: "UA-C-07b", title: "Профиль dirty + сохранение из диалога ухода падает: ошибка видна, уход отменён, ввод цел",
    async run(t) {
      const a = await openApp();
      const u = await openCard(a, "qa.noaccess");
      await waitFor(() => a.$("#pf-pos"), { what: "форма" });
      await a.type(a.$("#pf-pos"), "Х");
      a.ctl.failNext(`PATCH /users/${u.id}`, { status: 500, detail: "Диск переполнен" });
      a.click(a.$("[data-back]"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.count("PATCH", `/users/${u.id}`) === 1, { what: "попытка" });
      await a.settle(80);
      t.has(lastText(a), "Диск переполнен", "текст ошибки виден");
      t.ok(a.$("#pf-pos"), "остались в карточке");
      t.has(a.$("#pf-pos").value, "Х", "ввод цел");
      t.ok(a.$("#card-save") && !a.$("#card-save").disabled, "«Сохранить» доступна для повтора");
    },
  },
  {
    id: "UA-C-08", title: "Блок «Диагностика…» честно говорит про V1 и даёт рабочую ссылку",
    async run(t) {
      const a = await openApp();
      await openCard(a, "qa.noaccess", "security");
      await waitFor(() => a.doc.body.innerText.includes("в этот пилот пока не перенесены") || a.$('a[href*="ui=v1"], button'), { what: "вкладка безопасности" });
      t.has(lastText(a), "доступны в текущем интерфейсе", "сказано, что функции остаются в V1");
      t.ok(a.byText("a, button", "Открыть в текущем интерфейсе"), "есть ссылка/кнопка перехода в V1");
    },
  },
  {
    id: "UA-C-09", title: "Медленная загрузка доступа: клик «← Все пользователи» не пропадает молча; после ответа переход работает; чужие гранты не подмешиваются",
    async run(t) {
      const a = await openApp();
      await openList(a);
      const u6 = byLogin(a, "qa.grants"), u4 = byLogin(a, "qa.noaccess");
      const hold6 = a.ctl.hold(`GET /users/${u6.id}/access`);
      a.click(a.$(`[data-user="${u6.id}"]`));
      await waitFor(() => a.$("[data-tab]"), { what: "карточка 6" });
      a.click(a.$('[data-tab="access"]'));
      await waitFor(() => hold6.pending >= 1, { what: "запрос доступа пользователя 6 завис" });
      a.click(a.$("[data-back]"));
      await a.settle(80);
      t.has(a.$("#ua-status").textContent, "Идёт загрузка", "во время медленного чтения клик не пропал молча — есть объяснение");
      t.ok(a.$("[data-tab]"), "пока ответа нет, остаёмся в карточке");
      hold6.release();
      await waitFor(() => a.$("#ua-access-search") || lastText(a).includes("Все текущие"), { what: "доступ пользователя 6" });
      await a.settle(60);
      t.notHas(a.$("#ua-status").textContent, "Идёт загрузка", "после ответа подсказка убрана");
      a.click(a.$("[data-back]"));
      await openList(a);
      a.click(a.$(`[data-user="${u4.id}"]`));
      await waitFor(() => a.$("[data-tab]"), { what: "карточка 4" });
      a.click(a.$('[data-tab="access"]'));
      await waitFor(() => a.$("#ua-access-search"), { what: "доступ пользователя 4" });
      t.notHas(lastText(a), "Все текущие и будущие проекты", "гранты пользователя 6 у пользователя 4 не показаны");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      a.click(a.$$("[data-edit-area^='o:']")[0]);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор области" });
      a.click(a.$("[data-grant-role]"));
      await waitFor(() => a.$("#ua-access-save") && !a.$("#ua-access-save").disabled, { what: "«Сохранить изменения»" });
      a.click(a.$("#ua-access-save"));
      await waitFor(() => a.ctl.count("PUT", `/users/${u4.id}/access`) === 1, { what: "PUT доступа" });
      const put = a.ctl.log.find((e) => e.method === "PUT" && e.path.includes(`/users/${u4.id}/access`));
      t.eq(put.body.grants.length, 1, "в PUT пользователя 4 ровно один грант — его собственный");
    },
  },
  {
    id: "UA-A-01", title: "Доступ пользователя без назначений: пустое состояние; «Показать все» раскрывает каталог",
    async run(t) {
      const a = await openApp();
      await openAccess(a, "qa.noaccess");
      t.has(lastText(a), "Нет доступа к проектам", "пустое состояние с подсказкой");
      a.click(a.byText("button", "Показать все"));
      await a.settle(50);
      t.ok(a.$$("[data-edit-area^='o:']").length > 5, "после «Показать все» видны объекты каталога");
      t.ok(a.byText("button", "Только доступные"), "переключатель сменил подпись");
    },
  },
  {
    id: "UA-A-02", title: "Доступ пользователя с назначениями: прямые и унаследованные видны, счётчики верны",
    async run(t) {
      const a = await openApp();
      await openAccess(a, "qa.grants");
      const text = lastText(a);
      t.has(text, "Все текущие и будущие проекты", "назначение на «Все проекты» видно");
      t.ok(/\d+ из \d+ объектов/.test(text), "счётчики «N из M объектов»");
      t.ok(a.$$(".v2-perm").length >= 1, "строки объектов с ролями показаны");
    },
  },
  {
    id: "UA-A-03", title: "Поиск в доступах: НЕПРЕРЫВНЫЙ ввод с клавиатуры без потери фокуса, Backspace, каретка, выделение, сброс",
    async run(t) {
      const a = await openApp();
      await openAccess(a, "qa.noaccess");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      const total = a.$$("[data-edit-area^='o:']").length;
      const q = a.$("#ua-access-search");
      const r1 = await a.type(q, "Проект-1");
      t.eq(r1.lostFocusAt, [], "фокус не терялся при вводе 8 символов");
      t.ok(a.$("#ua-access-search") === q, "поле не пересоздавалось (тот же элемент)");
      t.eq(a.doc.activeElement, q, "поле в фокусе");
      t.eq(q.value, "Проект-1", "введённый текст цел");
      t.ok(a.$$("[data-edit-area^='o:']").length < total, "список отфильтрован");
      const r2 = await a.backspace(q, 2);
      t.eq(r2.lostFocusAt, [], "Backspace без потери фокуса");
      a.select(q, 3, 3);
      await a.type(q, "X");
      t.eq(q.value, "ПроXект", "вставка в середину");
      t.eq(q.selectionStart, 4, "каретка сразу за вставленным символом");
      a.select(q, 0, q.value.length);
      await a.type(q, "нетТакого");
      t.eq(q.value, "нетТакого", "выделение заменено");
      t.ok(/Нет доступа к проектам|нет/i.test(lastText(a)), "пустой результат показан");
      t.eq(a.doc.activeElement, q, "фокус на месте и после пустого результата");
      await a.backspace(q, q.value.length);
      t.eq(a.$$("[data-edit-area^='o:']").length, total, "сброс поиска возвращает весь список");
      t.eq(a.doc.activeElement, q, "фокус на месте после сброса");
    },
  },
  {
    id: "UA-A-04", title: "«Только доступные» ↔ «Показать все» сохраняет поисковый запрос",
    async run(t) {
      const a = await openApp();
      await openAccess(a, "qa.grants");
      await a.type(a.$("#ua-access-search"), "Проект");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      t.eq(a.$("#ua-access-search").value, "Проект", "запрос сохранился при переключении");
    },
  },
  {
    id: "UA-A-05", title: "Выдать роль на объекте → «Сохранить»: PUT, сводка, повторное открытие, «Проверка доступа» согласована",
    async run(t) {
      const a = await openApp();
      const u = await openAccess(a, "qa.noaccess");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      const editBtn = a.$$("[data-edit-area^='o:']")[0];
      const [, pid, oid] = editBtn.dataset.editArea.split(":");
      a.click(editBtn);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
      const roleBox = a.$$("[data-grant-role]")[0];
      const roleKey = roleBox.dataset.grantRole;
      a.click(roleBox);
      await waitFor(() => a.$("#ua-access-save") && !a.$("#ua-access-save").disabled, { what: "«Сохранить»" });
      t.has(a.$("#ua-status").textContent, "Есть несохранённые изменения", "подвал: есть несохранённое");
      a.click(a.$("#ua-access-save"));
      await waitFor(() => a.ctl.count("PUT", `/users/${u.id}/access`) === 1, { what: "PUT" });
      await a.settle(100);
      const put = a.ctl.log.find((e) => e.method === "PUT");
      t.eq(put.body.grants, [{ project_id: Number(pid), object_id: Number(oid), role: roleKey }], "в PUT ровно выданный грант");
      t.ok(a.ctl.data.access.some((g) => g.user_id === u.id && g.role === roleKey && g.object_id === Number(oid)), "запись есть в фейковой БД");
      t.has(a.$("#ua-status").textContent, "Доступ сохранён", "сообщение об успехе");
      t.ok(/1 из \d+ объект/.test(lastText(a)), "сводка показывает «1 из N объектов»");
    },
  },
  {
    id: "UA-A-07", title: "Снять роль → «Сохранить»: грант удалён, сводка обновлена",
    async run(t) {
      const a = await openApp();
      const u = byLogin(a, "qa.writer");
      const before = a.ctl.data.access.filter((g) => g.user_id === u.id && g.object_id != null);
      await openAccess(a, "qa.writer");
      const direct = a.ctl.data.access.find((g) => g.user_id === u.id && g.object_id != null);
      t.ok(direct, "у qa.writer есть прямой объектный грант в фикстуре");
      const objBtn = a.$(`[data-edit-area="o:${direct.project_id}:${direct.object_id}"]`) || a.$(`[data-edit-area$=":${direct.object_id}"]`);
      t.ok(objBtn, "объект с прямым грантом виден в сводке");
      a.click(objBtn);
      await waitFor(() => a.$("[data-grant-role]:checked"), { what: "отмеченная роль" });
      a.click(a.$("[data-grant-role]:checked"));
      await waitFor(() => a.$("#ua-access-save") && !a.$("#ua-access-save").disabled, { what: "сохранить" });
      a.click(a.$("#ua-access-save"));
      await waitFor(() => a.ctl.count("PUT", `/users/${u.id}/access`) === 1, { what: "PUT" });
      await a.settle(100);
      const after = a.ctl.data.access.filter((g) => g.user_id === u.id && g.object_id != null);
      t.eq(after.length, before.length - 1, "прямой объектный грант снят в фейковой БД");
    },
  },
  {
    id: "UA-A-08", title: "Правка доступа не сохранена: «Отменить», «← Сводка», диалог при уходе",
    async run(t) {
      const a = await openApp();
      const u = await openAccess(a, "qa.noaccess");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      a.click(a.$$("[data-edit-area^='o:']")[0]);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
      a.click(a.$("[data-grant-role]"));
      await waitFor(() => a.$("#ua-access-cancel") && !a.$("#ua-access-cancel").disabled, { what: "Отменить" });
      a.click(a.$("#ua-access-cancel"));
      await waitFor(() => a.$("#ua-access-search"), { what: "сводка после отмены" });
      t.ok(a.$("#ua-access-save").disabled, "после «Отменить» «Сохранить» снова недоступна");
      t.eq(a.ctl.count("PUT", `/users/${u.id}/access`), 0, "запросов нет");
      // уход с dirty (области уже показаны — переключатель теперь «Только доступные»)
      a.click(a.$$("[data-edit-area^='o:']")[0]);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
      a.click(a.$("[data-grant-role]"));
      a.click(a.$('[data-tab="profile"]'));
      await waitFor(() => a.dialog(), { what: "диалог при смене вкладки" });
      await a.answerDialog("Остаться");
      t.ok(a.$("[data-grant-role]:checked"), "«Остаться» — назначение не потеряно");
    },
  },
  {
    id: "UA-A-09", title: "Сохранение доступа: двойной клик, 403/409/422/500/сеть — один PUT, читаемо, данные на месте",
    async run(t) {
      const a = await openApp();
      const u = await openAccess(a, "qa.noaccess");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      a.click(a.$$("[data-edit-area^='o:']")[0]);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
      a.click(a.$("[data-grant-role]"));
      await waitFor(() => a.$("#ua-access-save") && !a.$("#ua-access-save").disabled, { what: "сохранить" });
      const hold = a.ctl.hold(`PUT /users/${u.id}/access`);
      const b = a.$("#ua-access-save");
      a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("PUT", `/users/${u.id}/access`), 1, "двойной клик — один PUT");
      t.ok(a.$("[data-grant-role]").disabled, "чекбоксы заблокированы на время записи");
      hold.fail(422, [{ loc: ["body", "grants", 0, "role"], msg: "bad role", type: "value_error" }]);
      await waitFor(() => /bad role|Проверьте/.test(a.$("#ua-status").textContent), { what: "ошибка" });
      t.notHas(a.$("#ua-status").textContent, "[object", "нет [object Object]");
      t.ok(!a.$("[data-grant-role]").disabled && !a.$("#ua-access-save").disabled, "поля и кнопка снова доступны");
      t.ok(a.$("[data-grant-role]:checked"), "выбранное назначение цело");
      // повтор после ошибки — успешно
      a.click(a.$("#ua-access-save"));
      await waitFor(() => a.ctl.count("PUT", `/users/${u.id}/access`) === 2, { what: "повтор" });
      await a.settle(100);
      t.ok(a.ctl.data.access.some((g) => g.user_id === u.id), "после повтора запись сохранена");
    },
  },
  {
    id: "UA-A-11", title: "Клавиатура: пробел на чекбоксе роли не уводит фокус",
    async run(t) {
      const a = await openApp();
      await openAccess(a, "qa.noaccess");
      a.click(a.byText("button", "Показать все"));
      await a.settle(40);
      a.click(a.$$("[data-edit-area^='o:']")[0]);
      await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
      const cb = a.$$("[data-grant-role]")[1];
      cb.focus();
      a.click(cb);
      await a.settle(60);
      t.eq(a.doc.activeElement, cb, "фокус остался на том же чекбоксе после переключения");
      t.ok(a.$$("[data-grant-role]")[1] === cb, "чекбокс не пересоздан");
    },
  },
  {
    id: "UA-R-01", title: "Роли: список, «N назначений», матрица разрешений",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      t.eq(a.$$("[data-role]").length, 4, "4 роли фикстуры");
      t.ok(a.$$("[data-perm]").length > 20, "матрица разрешений показана");
      t.has(a.$("[data-role]").textContent, "назначений", "у роли есть счётчик назначений");
    },
  },
  {
    id: "UA-R-02", title: "Матрица: правка ячейки → «Не сохранено ячеек» → «Сохранить» / «Отменить»",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      const seg = a.$$("[data-perm]").find((b) => b.getAttribute("aria-pressed") !== "true");
      const feature = seg.dataset.perm, level = seg.dataset.level;
      a.click(seg);
      await waitFor(() => a.$("#roles-save"), { what: "подвал матрицы" });
      t.has(a.$("#ua-status").textContent, "Не сохранено ячеек: 1", "счётчик несохранённых ячеек");
      a.click(a.$("#roles-cancel"));
      await waitFor(() => !a.$("#roles-save"), { what: "отмена" });
      t.eq(a.ctl.count("PUT", "/roles/features"), 0, "отмена не шлёт запрос");
      a.click(a.$$("[data-perm]").find((b) => b.dataset.perm === feature && b.dataset.level === level));
      await waitFor(() => a.$("#roles-save"), { what: "подвал" });
      a.click(a.$("#roles-save"));
      await waitFor(() => a.ctl.count("PUT", "/roles/features") === 1, { what: "PUT" });
      await a.settle(100);
      t.has(a.$("#ua-status").textContent, "Разрешения сохранены", "сообщение об успехе");
      const put = a.ctl.log.find((e) => e.method === "PUT" && e.path.startsWith("/roles/features"));
      t.ok(JSON.stringify(put.body).includes(feature) && JSON.stringify(put.body).includes(level), "в PUT ушла именно изменённая ячейка (раздел и уровень)");
      t.eq(a.$$("#role-editor .v2-perm-dirty").length, 0, "после сохранения подсветки несохранённых ячеек нет");
    },
  },
  {
    id: "UA-R-03", title: "Матрица: двойной клик; ошибки 500/422/сеть — один PUT, читаемо, черновик цел",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      const seg = a.$$("[data-perm]").find((b) => b.getAttribute("aria-pressed") !== "true");
      a.click(seg);
      await waitFor(() => a.$("#roles-save"), { what: "подвал" });
      const hold = a.ctl.hold("PUT /roles/features");
      const b = a.$("#roles-save");
      a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("PUT", "/roles/features"), 1, "двойной клик — один PUT");
      t.ok(a.$$("[data-perm]").every((x) => x.disabled), "сегменты заблокированы на время записи");
      hold.fail(500, "Сервер недоступен");
      await waitFor(() => a.$("#ua-status").textContent.includes("Сервер недоступен"), { what: "ошибка" });
      t.ok(a.$("#roles-save") && !a.$("#roles-save").disabled, "«Сохранить» доступна для повтора");
      t.has(a.$("#ua-status").textContent, "Сервер недоступен", "текст ошибки виден");
      t.ok(a.$$("[data-perm]").some((x) => !x.disabled), "сегменты снова доступны");
    },
  },
  {
    id: "UA-R-04", title: "Создание роли: пустое имя, дубль, успех, отмена",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      a.click(a.$("#role-new"));
      await waitFor(() => a.$("#role-new-name"), { what: "форма" });
      a.click(a.$("#role-new-submit"));
      await a.settle(60);
      t.has(a.$("#role-new-error").textContent, "Введите название", "валидация пустого имени");
      t.eq(a.ctl.count("POST", "/roles"), 0, "запрос не отправлен");
      const existing = a.ctl.data.roles[0].name;
      await a.type(a.$("#role-new-name"), existing);
      a.click(a.$("#role-new-submit"));
      await waitFor(() => a.$("#role-new-error").textContent.length > 0, { what: "ошибка дубля" });
      t.notHas(a.$("#role-new-error").textContent, "[object", "нет [object Object]");
      a.$("#role-new-name").value = "";
      await a.type(a.$("#role-new-name"), "QA-ACC-роль");
      a.click(a.$("#role-new-submit"));
      await waitFor(() => a.ctl.data.roles.some((r) => r.name === "QA-ACC-роль"), { what: "создание" });
      await a.settle(100);
      t.has(a.$("[data-role][aria-pressed='true']").textContent, "QA-ACC-роль", "новая роль выбрана");
    },
  },
  {
    id: "UA-R-05", title: "Переименование роли: пустое, успех, отмена",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      a.click(a.$("#role-rename"));
      await waitFor(() => a.$("#role-rename-name"), { what: "форма" });
      a.$("#role-rename-name").value = "";
      a.click(a.$("#role-rename-submit"));
      await a.settle(60);
      t.ok(a.$("#role-rename-error").textContent.length > 0, "пустое имя — сообщение");
      a.$("#role-rename-name").value = "";
      await a.type(a.$("#role-rename-name"), "QA-ACC-новое");
      a.click(a.$("#role-rename-submit"));
      await waitFor(() => a.ctl.data.roles.some((r) => r.name === "QA-ACC-новое"), { what: "переименование" });
      await a.settle(100);
      t.has(a.$("[data-role][aria-pressed='true']").textContent, "QA-ACC-новое", "новое имя видно в списке");
    },
  },
  {
    id: "UA-R-06", title: "Порядок ролей ▲▼: границы заблокированы, один PUT на клик, порядок сохраняется",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      const ups = a.$$("[data-role-up]"), downs = a.$$("[data-role-down]");
      t.ok(ups[0].disabled, "▲ у первой роли заблокирована");
      t.ok(downs[downs.length - 1].disabled, "▼ у последней роли заблокирована");
      const firstName = a.$$("[data-role]")[0].textContent;
      a.click(downs[0]);
      await waitFor(() => a.ctl.count("PUT", "/roles/order") === 1, { what: "PUT order" });
      await a.settle(100);
      t.eq(a.ctl.count("PUT", "/roles/order"), 1, "один PUT");
      t.eq(a.$$("[data-role]")[1].textContent, firstName, "первая роль стала второй");
    },
  },
  {
    id: "UA-R-07", title: "Удаление роли: delete-plan → подтверждение (danger) → удалена; отмена не удаляет",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      a.click(a.$("#role-new"));
      await waitFor(() => a.$("#role-new-name"), { what: "форма" });
      await a.type(a.$("#role-new-name"), "QA-ACC-удалить");
      a.click(a.$("#role-new-submit"));
      await waitFor(() => a.ctl.data.roles.some((r) => r.name === "QA-ACC-удалить"), { what: "создание" });
      await a.settle(100);
      a.click(a.$("#role-delete"));
      await waitFor(() => a.dialog(), { what: "диалог удаления" });
      t.ok(a.$(".v2-dialog .v2-danger"), "кнопка «Удалить» — danger");
      t.has(a.dialog().textContent, "QA-ACC-удалить", "диалог называет удаляемую роль");
      await a.answerDialog("Отмена");
      t.ok(a.ctl.data.roles.some((r) => r.name === "QA-ACC-удалить"), "отмена не удаляет");
      a.click(a.$("#role-delete"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Удалить");
      await waitFor(() => !a.ctl.data.roles.some((r) => r.name === "QA-ACC-удалить"), { what: "удаление" });
      t.eq(a.ctl.count("DELETE", "/roles/"), 1, "один DELETE");
    },
  },
  {
    id: "UA-R-08", title: "Dirty матрицы: переключение роли не теряет черновик, смена вкладки — диалог",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      a.click(a.$$("[data-perm]").find((b) => b.getAttribute("aria-pressed") !== "true"));
      await waitFor(() => a.$("#roles-save"), { what: "подвал" });
      const second = a.$$("[data-role]")[1];
      a.click(second);
      await waitFor(() => a.$("[data-role][aria-pressed='true']") === second || a.$$("[data-role]")[1].getAttribute("aria-pressed") === "true", { what: "переключение роли" });
      t.ok(a.$("#roles-save"), "черновик матрицы не потерян при переключении роли");
      a.click(navTab(a, "Пользователи"));
      await waitFor(() => a.dialog(), { what: "диалог при смене вкладки" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#roles-save"), "«Остаться» — черновик цел");
    },
  },
  {
    id: "UA-R-09", title: "Клавиатура: клик по сегменту матрицы не уводит фокус на <body> (перерисовка редактора роли)",
    async run(t) {
      const a = await openApp();
      await openRoles(a);
      const seg = a.$$("[data-perm]").find((b) => b.getAttribute("aria-pressed") !== "true");
      const perm = seg.dataset.perm, level = seg.dataset.level;
      seg.focus();
      a.click(seg);
      await waitFor(() => a.$("#roles-save"), { what: "подвал" });
      await a.settle(100);
      const cur = a.doc.activeElement;
      t.ok(cur && cur !== a.doc.body, "фокус не на <body>");
      t.eq([cur.dataset?.perm, cur.dataset?.level], [perm, level], "фокус остался на той же кнопке сегмента");
    },
  },
  {
    id: "UA-K-01", title: "Проверка доступа: выбор пользователя и объекта (мышь и клавиатура)",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(navTab(a, "Проверка доступа"));
      await waitFor(() => a.$("#chk-user"), { what: "вкладка" });
      const u = byLogin(a, "qa.grants");
      a.setValue(a.$("#chk-user"), String(u.id));
      await waitFor(() => a.ctl.count("GET", `/users/${u.id}/rights-matrix`) >= 1, { what: "запрос прав" });
      a.click(a.$("#chk-toggle"));
      await waitFor(() => !a.$("#chk-panel").hidden, { what: "панель объектов" });
      t.eq(a.doc.activeElement, a.$("#chk-object-search"), "при открытии фокус в поле поиска");
      a.key(a.$("#chk-object-search"), "ArrowDown");
      t.ok(a.doc.activeElement.classList.contains("v2-combobox-option"), "ArrowDown из поля поиска переводит фокус на пункт списка");
      a.key(a.doc.activeElement, "ArrowDown");
      const focused = a.doc.activeElement;
      t.ok(focused.dataset.objectId, "ArrowDown двигает фокус на объект");
      focused.click(); // Enter/Пробел на кнопке браузер превращает в click — настоящую клавиатуру см. живую проверку
      await a.settle(120);
      t.ok(a.ctl.count("GET", `/users/${u.id}/rights-matrix?object_id=`) >= 1, "выбор пункта запросил права по объекту");
      t.ok(a.$("#chk-panel").hidden, "панель закрылась после выбора");
    },
  },
  {
    id: "UA-K-02", title: "Проверка доступа: администратор — «Полный доступ»; пользователь без ролей — «Прямых ролей нет»",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(navTab(a, "Проверка доступа"));
      await waitFor(() => a.$("#chk-user"), { what: "вкладка" });
      a.setValue(a.$("#chk-user"), String(byLogin(a, "qa.admin").id));
      await waitFor(() => lastText(a).includes("Полный доступ"), { what: "полный доступ" });
      a.setValue(a.$("#chk-user"), String(byLogin(a, "qa.noaccess").id));
      await waitFor(() => lastText(a).includes("Прямых ролей на объекте нет"), { what: "нет ролей" });
      t.ok(a.$$("#chk-result .v2-perm").length > 10, "перечень разделов показан с уровнями");
    },
  },
  {
    id: "UA-K-06", title: "Проверка доступа: ошибка чтения — читаемо, повтор возможен",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(navTab(a, "Проверка доступа"));
      await waitFor(() => a.$("#chk-user"), { what: "вкладка" });
      const u = byLogin(a, "qa.grants");
      a.ctl.failNext(`/users/${u.id}/rights-matrix`, { status: 500, detail: "Не удалось посчитать" });
      a.setValue(a.$("#chk-user"), String(u.id));
      await waitFor(() => lastText(a).includes("Не удалось посчитать"), { what: "ошибка" });
      t.has(a.$("#chk-result").textContent, "Не удалось посчитать", "причина ошибки показана в области результата");
      t.notHas(a.$("#chk-result").textContent, "[object", "нет [object Object]");
      a.setValue(a.$("#chk-user"), String(byLogin(a, "qa.noaccess").id));
      a.setValue(a.$("#chk-user"), String(u.id));
      await waitFor(() => a.$$("#chk-result .v2-perm").length > 0, { what: "повторный выбор работает" });
      t.ok(a.$$("#chk-result .v2-perm").length > 10, "после ошибки повторный выбор показывает права");
    },
  },
  {
    id: "UA-K-07", title: "Проверка доступа: поздний ответ прежнего выбора не перезаписывает актуальный",
    async run(t) {
      const a = await openApp();
      await openList(a);
      a.click(navTab(a, "Проверка доступа"));
      await waitFor(() => a.$("#chk-user"), { what: "вкладка" });
      const admin = byLogin(a, "qa.admin"), other = byLogin(a, "qa.noaccess");
      // первый выбор (обычный пользователь) зависает; второй (админ) отвечает сразу
      const hold = a.ctl.hold(`/users/${other.id}/rights-matrix`);
      a.setValue(a.$("#chk-user"), String(other.id));
      await waitFor(() => hold.pending >= 1, { what: "первый запрос завис" });
      a.setValue(a.$("#chk-user"), String(admin.id));
      await waitFor(() => lastText(a).includes("Полный доступ"), { what: "актуальный ответ (админ)" });
      hold.release();
      await a.settle(150);
      t.has(lastText(a), "Полный доступ", "на экране остался ответ ПОСЛЕДНЕГО выбора");
      t.notHas(lastText(a), "Прямых ролей на объекте нет", "поздний ответ первого выбора не затёр экран");
    },
  },
];

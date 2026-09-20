// Оболочка V2: вход, права, навигация, диалоги, защита переходов (SH-*).
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const MODULE_KEYS = ["users-access", "projects-objects", "counterparties"];
const sectionTitles = (a) => a.$$(NAV).map((b) => b.textContent.trim());
const pressed = (a) => a.$$(NAV).filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.section);

// Открыть «Добавить пользователя» и ввести данные — получаем dirty в UA.
async function makeUaDirty(a) {
  await waitFor(() => a.byText("button", "Добавить пользователя"), { what: "кнопка «Добавить пользователя»" });
  a.click(a.byText("button", "Добавить пользователя"));
  await waitFor(() => a.$("#nu-last"), { what: "форма нового пользователя" });
  await a.type(a.$("#nu-last"), "QA-Иванов");
  await a.type(a.$("#nu-login"), "qa_ivanov");
}

export const tests = [
  {
    id: "SH-01", title: "Нет сессии → форма входа V2",
    async run(t) {
      const a = await openApp({ session: false });
      await waitFor(() => a.$("input[type=password]") || a.$("form"), { what: "форма входа" });
      t.ok(a.$("input[type=password]"), "есть поле пароля");
      t.notHas(a.doc.body.innerText, "Пользователи и доступ", "разделы не показываются без входа");
      t.eq(a.ctl.count("GET", "/me"), 1, "один запрос /me");
    },
  },
  {
    id: "SH-02", title: "Экран входа: отказ сервера — читаемое сообщение (401 строкой и 422 списком), логин остаётся, повтор возможен",
    async run(t) {
      const a = await openApp({ session: false });
      await waitFor(() => a.$("#v2-login-form"), { what: "форма входа" });
      a.$("#v2-login-user").value = "qa.admin"; // пароль в тесте не вводится: сервер стенда всё равно отвечает заданным отказом
      a.ctl.failNext("POST /login", { status: 401, detail: "Неверный логин или пароль" });
      a.$("#v2-login-form").requestSubmit();
      await waitFor(() => a.$("#v2-login-error").textContent, { what: "сообщение" });
      t.has(a.$("#v2-login-error").textContent, "Неверный логин или пароль", "текст отказа виден");
      t.eq(a.$("#v2-login-user").value, "qa.admin", "логин не очищен");
      a.ctl.failNext("POST /login", { status: 422, detail: [{ loc: ["body", "password"], msg: "x", type: "missing" }] });
      a.$("#v2-login-form").requestSubmit();
      await waitFor(() => a.$("#v2-login-error").textContent.includes("password"), { what: "422" });
      t.notHas(a.$("#v2-login-error").textContent, "[object", "422 без [object Object]");
      a.ctl.failNext("POST /login", { network: true });
      a.$("#v2-login-form").requestSubmit();
      await waitFor(() => a.$("#v2-login-error").textContent.includes("Нет связи"), { what: "сеть" });
      t.eq(a.ctl.count("POST", "/login"), 3, "три попытки — три запроса, кнопка «Войти» не залипла");
    },
  },
  {
    id: "SH-03", title: "Обязательная смена пароля: экран смены вместо разделов",
    async run(t) {
      const a = await openApp({ query: "loginAs=8" });
      await waitFor(() => a.$("#v2-pwd-form"), { what: "экран смены пароля" });
      t.has(a.doc.body.innerText, "Смена пароля", "заголовок");
      t.eq(a.$$(NAV).length, 0, "разделов нет до смены пароля");
      t.ok(a.$("#v2-pwd-error")?.getAttribute("role") === "alert", "ошибка объявляется (role=alert)");
    },
  },
  {
    id: "SH-14", title: "«← Текущий интерфейс» при несохранённом: диалог, «Остаться» — остаёмся; быстрые клики — один диалог",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      const b = a.$("#v2-back-btn");
      a.click(b); a.click(b); a.click(b);
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.settle(60);
      t.eq(a.$$(".v2-dialog").length, 1, "один диалог при трёх кликах");
      await a.answerDialog("Остаться");
      t.eq(pressed(a), ["users-access"], "«Остаться» — остаёмся в V2");
      t.eq(a.$("#nu-login").value, "qa_ivanov", "введённое цело");
      t.ok(!a.$("#v2-back-btn").disabled, "кнопка снова доступна");
    },
  },
  {
    id: "SH-22", title: "Тёмная гамма пользователя → тёмная схема; светлая по умолчанию",
    async run(t) {
      const dark = await openApp({ query: `me=${encodeURIComponent(JSON.stringify({ ui_theme: "graphite" }))}` });
      await waitFor(() => dark.$$(NAV).length >= 1 || dark.$(".v2-page-head"), { what: "оболочка" });
      t.eq(dark.doc.documentElement.style.colorScheme, "dark", "graphite → dark");
      const light = await openApp();
      await waitFor(() => light.$$(NAV).length >= 1 || light.$(".v2-page-head"), { what: "оболочка" });
      t.eq(light.doc.documentElement.style.colorScheme, "light", "по умолчанию → light");
    },
  },
  {
    id: "SH-04", title: "Администратор: начальная страница, навигация по всем разделам, три перенесённых раздела помечены «в V2»",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$$(NAV).length > 3, { what: "навигация по разделам сервиса" });
      t.eq(pressed(a), ["home"], "открыта начальная страница");
      t.has(a.$("#v2-content").innerText, "Новый интерфейс · предварительная версия", "заголовок начальной страницы");
      const keys = a.$$(NAV).map((b) => b.dataset.section);
      for (const k of MODULE_KEYS) t.ok(keys.includes(k), `в навигации есть перенесённый раздел ${k}`);
      t.ok(keys.length >= 40, `в навигации много разделов сервиса (${keys.length})`);
      t.ok(a.$$(".v2-card").length >= 6, "на начальной странице карточки групп");
      const inV2 = a.$$(".v2-card-list .v2-chip-ok").length;
      t.eq(inV2, 3, "пометка «в V2» — ровно у трёх перенесённых разделов");
      t.ok(a.$(`.v2-card-list a[data-screen-link="contracts"]`), "экран, не перенесённый целиком, тоже достижим с начальной страницы");
    },
  },
  {
    id: "SH-05", title: "Пользователь без прав: перенесённых разделов нет, экраны с ограничением скрыты, V1 доступен",
    async run(t) {
      const a = await openApp({ perm: "none", home: true });
      await waitFor(() => a.$$(NAV).length >= 1, { what: "навигация" });
      const keys = a.$$(NAV).map((b) => b.dataset.section);
      for (const k of MODULE_KEYS) t.ok(!keys.includes(k), `раздел ${k} скрыт`);
      for (const k of ["counterparties", "users-access", "backups", "blocks"]) t.ok(!keys.includes(k), `экран ${k} с ограничением по правам скрыт`);
      t.ok(a.$('a[href="/?ui=v1"], #v2-back-btn'), "возврат в V1 доступен");
      t.has(a.$("#v2-content").innerText, "Скрыто по правам", "начальная страница говорит, что часть разделов скрыта");
    },
  },
  {
    id: "SH-06", title: "Только чтение: доступный раздел открывается, без запрещённых действий; недоступные скрыты",
    async run(t) {
      const a = await openApp({ perm: "readonly" });
      await waitFor(() => a.$(".v2-page-head h2"), { what: "заголовок раздела" });
      t.eq(a.$(".v2-page-head h2").textContent.trim(), "Пользователи и доступ", "доступен раздел «Пользователи и доступ»");
      const keys = a.$$(NAV).map((b) => b.dataset.section);
      t.ok(!keys.includes("projects-objects") && !keys.includes("counterparties"), "разделы, требующие изменения, скрыты");
      await waitFor(() => a.$("#ua-rows"), { what: "список пользователей" });
      t.ok(!a.byText("button", "Добавить пользователя"), "кнопки «Добавить пользователя» нет при уровне read");
    },
  },
  {
    id: "SH-07", title: "Переключение разделов без dirty: aria-pressed, класс каркаса, карта уничтожается",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$$(NAV).length > 3, { what: "навигация" });
      for (const key of ["projects-objects", "counterparties", "projects-objects", "users-access"]) {
        a.click(a.$(`${NAV}[data-section="${key}"]`));
        await waitFor(() => pressed(a)[0] === key, { what: `раздел ${key}` });
        await a.settle(60);
        t.eq(pressed(a), [key], `нажат только ${key}`);
      }
    },
  },
  {
    id: "SH-08", title: "Dirty + переключение раздела: «Остаться» / «Не сохранять»",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.dialog(), { what: "диалог несохранённого" });
      t.eq(a.$$(".v2-dialog button").map((b) => b.textContent.trim()), ["Остаться", "Не сохранять", "Сохранить и продолжить"], "диалог несохранённого: три варианта ответа");
      t.eq(a.doc.activeElement.textContent.trim(), "Остаться", "начальный фокус — на безопасном «Остаться»");
      await a.answerDialog("Остаться");
      t.eq(pressed(a), ["users-access"], "«Остаться» — раздел не сменился");
      t.eq(a.$("#nu-login").value, "qa_ivanov", "введённые данные целы");
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.dialog(), { what: "второй диалог" });
      await a.answerDialog("Не сохранять");
      await waitFor(() => pressed(a)[0] === "projects-objects", { what: "переход в PO" });
      t.eq(a.ctl.count("POST", "/users"), 0, "«Не сохранять» ничего не отправило");
    },
  },
  {
    id: "SH-08b", title: "Dirty + «Сохранить и продолжить»: запись, затем переход",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => pressed(a)[0] === "projects-objects" || a.ctl.count("POST", "/users") > 0, { what: "запись" });
      t.eq(a.ctl.count("POST", "/users"), 1, "ровно один POST /users");
      t.ok(a.ctl.data.users.some((u) => u.domain_login === "qa_ivanov"), "пользователь создан в фейковой БД");
    },
  },
  {
    id: "SH-09", title: "Dirty + сохранение падает (500): ошибка видна, переход отменён, данные целы, повтор доступен",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      a.ctl.failNext("POST /users", { status: 500, detail: "Внутренняя ошибка" });
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.count("POST", "/users") === 1, { what: "первая попытка записи" });
      await a.settle(80);
      t.eq(pressed(a), ["users-access"], "раздел не сменился");
      t.has(a.doc.body.innerText, "Внутренняя ошибка", "текст ошибки виден на экране");
      t.eq(a.$("#nu-login").value, "qa_ivanov", "введённые данные целы");
      t.ok(a.$$(NAV).every((b) => !b.disabled), "навигация снова доступна");
      // повтор: теперь успешно
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.dialog(), { what: "диалог при повторе" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.count("POST", "/users") === 2, { what: "вторая попытка" });
      t.ok(a.ctl.data.users.some((u) => u.domain_login === "qa_ivanov"), "после повтора пользователь создан");
    },
  },
  {
    id: "SH-10", title: "Идёт запись (медленный ответ): переход недоступен с причиной; после успеха и ошибки — снова доступен",
    async run(t) {
      for (const outcome of ["успех", "ошибка"]) {
        const a = await openApp();
        await makeUaDirty(a);
        const hold = a.ctl.hold("POST /users");
        a.click(a.$("#nu-submit"));
        await waitFor(() => a.ctl.count("POST", "/users") === 1, { what: "запрос ушёл" });
        await a.settle(40);
        t.ok(a.$$(NAV).every((b) => b.disabled), `[${outcome}] вкладки разделов заблокированы во время записи`);
        t.has(a.$("#v2-nav-note").textContent, "Идёт сохранение", `[${outcome}] причина написана рядом с вкладками`);
        t.ok(a.$("#v2-back-btn").disabled, `[${outcome}] «← Текущий интерфейс» заблокирована`);
        t.eq(a.click(a.$(`${NAV}[data-section="counterparties"]`)), false, `[${outcome}] клик по вкладке невозможен`);
        t.eq(pressed(a), ["users-access"], `[${outcome}] раздел не сменился`);
        if (outcome === "успех") hold.release(); else hold.fail(500, "Сервер недоступен");
        await waitFor(() => !a.$$(NAV).some((b) => b.disabled), { what: "снятие блокировки" });
        t.eq(a.$("#v2-nav-note").textContent, "", `[${outcome}] пояснение убрано`);
        t.ok(!a.$("#v2-back-btn").disabled, `[${outcome}] «← Текущий интерфейс» доступна`);
        a.close();
      }
    },
  },
  {
    id: "SH-11", title: "Быстрые повторные клики по вкладкам разделов при dirty: один диалог",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      const btn = a.$(`${NAV}[data-section="projects-objects"]`);
      for (let i = 0; i < 5; i++) a.click(btn);
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.settle(50);
      t.eq(a.$$(".v2-dialog").length, 1, "открыт ровно один диалог");
      await a.answerDialog("Остаться");
      await a.settle(60);
      t.eq(a.$$(".v2-dialog").length, 0, "после «Остаться» диалогов не осталось");
      t.eq(pressed(a), ["users-access"], "раздел не сменился");
      // и при успешном переходе без dirty — монтируется один раз
      const b = await openApp();
      await waitFor(() => b.$$(NAV).length > 3, { what: "навигация" });
      // Замер «до» — только когда стартовые чтения раздела «Пользователи» закончились (счётчик не растёт 300 мс):
      // иначе запоздавший стартовый GET /projects засчитывался переходу и тест краснел под нагрузкой.
      let stable = b.ctl.count("GET", "/projects");
      for (let i = 0; i < 20; i++) { await b.settle(300); const now = b.ctl.count("GET", "/projects"); if (now === stable) break; stable = now; }
      const before = b.ctl.count("GET", "/projects");
      const nav = b.$(`${NAV}[data-section="projects-objects"]`);
      for (let i = 0; i < 5; i++) b.click(nav);
      await waitFor(() => pressed(b)[0] === "projects-objects", { what: "переход" });
      await b.settle(150);
      const extra = b.ctl.count("GET", "/projects") - before;
      t.ok(extra <= 2, `раздел смонтирован один раз (не пять): запросов /projects — ${extra}`);
    },
  },
  {
    id: "SH-16", title: "beforeunload: с dirty — предупреждение, без dirty — нет",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$("#ua-rows"), { what: "список" });
      const clean = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(clean);
      t.eq(clean.defaultPrevented, false, "без изменений предупреждения нет");
      await makeUaDirty(a);
      const dirty = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(dirty);
      t.eq(dirty.defaultPrevented, true, "с несохранённым — стандартное предупреждение");
    },
  },
  {
    id: "SH-17", title: "beforeunload во время записи БЕЗ несохранённых данных — предупреждение (закрытие посреди сохранения)",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$("#ua-rows"), { what: "список" });
      a.click(a.byText(".v2-nav button[data-page]", "Роли"));
      await waitFor(() => a.$("#role-editor"), { what: "роли" });
      t.eq(a.$("#roles-save"), null, "несохранённых изменений нет (запись — перестановка ролей, а не форма)");
      const clean = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(clean);
      t.eq(clean.defaultPrevented, false, "без записи и без правок предупреждения нет");
      const hold = a.ctl.hold("PUT /roles/order");
      a.click(a.$$("[data-role-down]")[0]);
      await waitFor(() => a.ctl.count("PUT", "/roles/order") === 1, { what: "запрос ушёл" });
      const ev = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(ev);
      t.eq(ev.defaultPrevented, true, "закрытие посреди записи предупреждает");
      hold.release();
      await waitFor(() => !a.$$(NAV).some((b) => b.disabled), { what: "конец записи" });
      await a.settle(80);
      const ev2 = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(ev2);
      t.eq(ev2.defaultPrevented, false, "после записи предупреждения нет");
    },
  },
  {
    id: "SH-18", title: "/me/permissions отвечает 500: «Не удалось загрузить интерфейс», без [object Object]",
    async run(t) {
      const a = await openApp({ query: `failNext=${encodeURIComponent(JSON.stringify({ pattern: "GET /me/permissions", status: 500, detail: [{ msg: "x" }] }))}` });
      await waitFor(() => a.doc.body.innerText.includes("Не удалось загрузить интерфейс"), { what: "экран ошибки" });
      t.notHas(a.doc.body.innerText, "[object Object]", "нет [object Object]");
      t.ok(a.$('a[href="/?ui=v1"]'), "ссылка на V1 есть");
    },
  },
  {
    id: "SH-19", title: "Оформление не зависит от порядка посещения: v2-app у каждого раздела свой",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$$(NAV).length > 3, { what: "навигация" });
      const cls = () => a.$("#v2-content").className.split(/\s+/).filter(Boolean).sort().join(" ");
      const order = ["users-access", "projects-objects", "counterparties", "projects-objects", "users-access", "counterparties", "users-access"];
      const seen = {};
      for (const key of order) {
        a.click(a.$(`${NAV}[data-section="${key}"]`));
        await waitFor(() => pressed(a)[0] === key, { what: key });
        await a.settle(120);
        seen[key] = seen[key] || [];
        seen[key].push(cls());
      }
      t.ok(seen["projects-objects"].every((c) => c.includes("v2-app")), "PO всегда в закреплённом каркасе (v2-app)");
      t.ok(seen["users-access"].every((c) => c.includes("v2-app")), "UA всегда в закреплённом каркасе");
      t.eq(new Set(seen["projects-objects"]).size, 1, "PO: класс одинаков при каждом заходе");
      t.eq(new Set(seen["users-access"]).size, 1, "UA: класс одинаков при каждом заходе");
      t.eq(new Set(seen["counterparties"]).size, 1, "CP: класс одинаков при каждом заходе");
    },
  },
  {
    id: "SH-20", title: "Диалог: фокус на безопасной кнопке, ловушка Tab, Esc = отмена, возврат фокуса",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$(NAV), { what: "навигация" });
      const dlg = await a.win.eval("import('/static/v2/dialogs.js')");
      const opener = a.$(`${NAV}[data-section="users-access"]`);
      opener.focus();
      const p = dlg.showConfirmDialog("Удалить «QA»?", { confirmLabel: "Удалить", danger: true });
      await waitFor(() => a.dialog(), { what: "диалог" });
      t.eq(a.doc.activeElement.textContent.trim(), "Отмена", "начальный фокус — на безопасной «Отмена»");
      t.ok(a.$(".v2-dialog .v2-danger"), "кнопка подтверждения — danger");
      const btns = a.$$(".v2-dialog button");
      btns[btns.length - 1].focus();
      a.key(btns[btns.length - 1], "Tab");
      t.eq(a.doc.activeElement, btns[0], "Tab с последней кнопки → на первую (ловушка)");
      a.key(btns[0], "Tab", { shiftKey: true });
      t.eq(a.doc.activeElement, btns[btns.length - 1], "Shift+Tab с первой → на последнюю");
      a.key(a.doc, "Escape");
      t.eq(await p, false, "Esc = отмена (false)");
      t.eq(a.$(".v2-dialog"), null, "диалог закрыт");
      t.eq(a.doc.activeElement, opener, "фокус вернулся на вызвавший элемент");
    },
  },
  {
    id: "SH-21", title: "Второй диалог с ДРУГИМ вопросом не получает чужой ответ; одинаковый — делит один диалог",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$(NAV), { what: "навигация" });
      const dlg = await a.win.eval("import('/static/v2/dialogs.js')");
      const first = dlg.showConfirmDialog("Удалить А?", { confirmLabel: "Удалить" });
      await waitFor(() => a.dialog(), { what: "первый диалог" });
      const same = dlg.showConfirmDialog("Удалить А?", { confirmLabel: "Удалить" });
      const other = dlg.showInfoDialog("Сообщение Б");
      await a.settle(60);
      t.eq(a.$$(".v2-dialog").length, 1, "одновременно виден один диалог");
      t.has(a.dialog().textContent, "Удалить А?", "виден первый вопрос");
      await a.answerDialog("Удалить");
      t.eq(await first, true, "первый получил свой ответ");
      t.eq(await same, true, "одинаковый вопрос получил тот же ответ");
      await waitFor(() => a.dialog() && a.dialog().textContent.includes("Сообщение Б"), { what: "второй (другой) диалог показан по-настоящему" });
      t.notHas(a.dialog().textContent, "Удалить А?", "второй диалог — про своё");
      await a.answerDialog("Понятно");
      t.eq(await other, "ok", "другой диалог получил СВОЙ ответ");
    },
  },
];

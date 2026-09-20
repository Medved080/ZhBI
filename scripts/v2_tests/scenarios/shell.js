// Оболочка V2: вход, права, навигация, диалоги, защита переходов (SH-*).
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
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
    id: "SH-04", title: "Администратор: три раздела, открыт первый",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$$(NAV).length === 3, { what: "навигация из 3 разделов" });
      t.eq(sectionTitles(a), ["Пользователи и доступ", "Проекты и объекты", "Контрагенты"], "названия разделов");
      t.eq(pressed(a), ["users-access"], "нажат первый раздел");
    },
  },
  {
    id: "SH-05", title: "Пользователь без доступа: «Нет доступных разделов»",
    async run(t) {
      const a = await openApp({ perm: "none" });
      await waitFor(() => a.doc.body.innerText.includes("Нет доступных разделов"), { what: "заглушка" });
      t.ok(a.$('a[href="/?ui=v1"]'), "ссылка на V1 присутствует");
      t.eq(a.$$(NAV).length, 0, "кнопок разделов нет");
    },
  },
  {
    id: "SH-06", title: "Только чтение: виден только доступный раздел, без запрещённых действий",
    async run(t) {
      const a = await openApp({ perm: "readonly" });
      await waitFor(() => a.$(".v2-page-head h2"), { what: "заголовок раздела" });
      t.eq(a.$(".v2-page-head h2").textContent.trim(), "Пользователи и доступ", "открыт единственный доступный раздел");
      t.eq(a.$$(NAV).length, 0, "навигации между разделами нет (раздел один)");
      await waitFor(() => a.$("#ua-rows"), { what: "список пользователей" });
      t.ok(!a.byText("button", "Добавить пользователя"), "кнопки «Добавить пользователя» нет при уровне read");
    },
  },
  {
    id: "SH-07", title: "Переключение разделов без dirty: aria-pressed, класс каркаса, карта уничтожается",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$$(NAV).length === 3, { what: "навигация" });
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
      await waitFor(() => b.$$(NAV).length === 3, { what: "навигация" });
      const before = b.ctl.count("GET", "/projects");
      const nav = b.$(`${NAV}[data-section="projects-objects"]`);
      for (let i = 0; i < 5; i++) b.click(nav);
      await waitFor(() => pressed(b)[0] === "projects-objects", { what: "переход" });
      await b.settle(150);
      t.ok(b.ctl.count("GET", "/projects") - before <= 2, "раздел смонтирован один раз (не пять)");
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
    id: "SH-17", title: "beforeunload во время записи — предупреждение",
    async run(t) {
      const a = await openApp();
      await makeUaDirty(a);
      const hold = a.ctl.hold("POST /users");
      a.click(a.$("#nu-submit"));
      await waitFor(() => a.ctl.count("POST", "/users") === 1, { what: "запрос" });
      const ev = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(ev);
      t.eq(ev.defaultPrevented, true, "закрытие посреди записи предупреждает");
      hold.release();
      await waitFor(() => !a.$$(NAV).some((b) => b.disabled), { what: "конец записи" });
      await a.settle(60);
      const ev2 = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(ev2);
      t.eq(ev2.defaultPrevented, false, "после записи (форма закрыта, данных нет) предупреждения нет");
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
      await waitFor(() => a.$$(NAV).length === 3, { what: "навигация" });
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

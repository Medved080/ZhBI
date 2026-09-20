// Редактор числовой настройки объекта («Порог опоздания поставки»): SE-*. Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const puts = (a) => a.ctl.log.filter((e) => e.method === "PUT" && e.path.startsWith("/settings/info-plate"));
const otherObject = (a) => { const sel = a.$("#v2-object"); return [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value)); };
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="late-threshold"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="late-threshold"]`));
  await waitFor(() => a.$("#se-input") && a.$("#se-input").value !== "", { what: "значение настройки" });
}

export const tests = [
  {
    id: "SE-01", title: "Загрузка значения, правка, сохранение: запрос с id выбранного объекта, повторное чтение подтверждает значение",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const oid = Number(a.$("#v2-object").value);
      t.eq(a.$("#se-input").value, "3", "показано значение сервера");
      t.ok(a.$("#se-save").disabled, "«Сохранить» недоступна, пока правки нет");
      await a.type(a.$("#se-input"), "7", { clear: true });
      t.ok(!a.$("#se-save").disabled, "«Сохранить» доступна после правки");
      a.click(a.$("#se-save"));
      await waitFor(() => /подтверждено чтением: 7/.test(a.$("#se-status").textContent), { what: "подтверждение чтением" });
      const put = puts(a)[0];
      t.eq(put.path, `/settings/info-plate?object_id=${oid}`, "PUT для объекта из шапки");
      t.eq(put.body, { late_threshold_days: 7 }, "в теле только число дней");
      t.eq(a.ctl.data.settings.lateThreshold[oid], 7, "сервер хранит новое значение");
      t.ok(a.$("#se-save").disabled, "после сохранения правки нет");
      t.eq(puts(a).length, 1, "ровно один PUT");
    },
  },
  {
    id: "SE-02", title: "Некорректный ввод (отрицательное, дробное, пусто) на сервер не уходит; ввод остаётся",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      for (const bad of ["-1", "2.5", ""]) {
        a.setValue(a.$("#se-input"), bad);
        a.$("#se-form").dispatchEvent(new a.win.Event("submit", { cancelable: true, bubbles: true }));
        await a.settle(40);
        t.has(a.$("#se-status").textContent, "целое число не меньше нуля", `«${bad}»: сообщение о некорректном значении`);
        t.eq(a.$("#se-input").value, bad, `«${bad}»: ввод не стёрт`);
      }
      t.eq(puts(a).length, 0, "ни одного запроса записи");
    },
  },
  {
    id: "SE-03", title: "Сбой сервера: без автоповтора, введённое остаётся, ложного успеха нет",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#se-input"), "9", { clear: true });
      a.ctl.failNext("PUT /settings/info-plate", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("#se-save"));
      await waitFor(() => /не изменено|Неизвестно/.test(a.$("#se-status").textContent), { what: "сообщение о сбое" });
      t.eq(puts(a).length, 1, "запись не повторялась автоматически");
      t.ok(!/Сохранено/.test(a.$("#se-status").textContent), "ложного успеха нет");
      t.eq(a.$("#se-input").value, "9", "введённое осталось в поле");
      t.ok(!a.$("#se-save").disabled, "можно повторить вручную");
    },
  },
  {
    id: "SE-04", title: "Двойной клик «Сохранить»: один запрос, управление заблокировано на время записи",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await a.type(a.$("#se-input"), "5", { clear: true });
      const hold = a.ctl.hold("PUT /settings/info-plate");
      a.click(a.$("#se-save"));
      await waitFor(() => a.$("#se-save").disabled && a.$("#se-input").disabled, { what: "блокировка на время записи" });
      t.eq(a.click(a.$("#se-save")), false, "второй клик невозможен");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => /Сохранено/.test(a.$("#se-status").textContent), { what: "сохранено" });
      t.eq(puts(a).length, 1, "ровно один PUT");
      hold.dispose?.();
    },
  },
  {
    id: "SE-05", title: "Смена объекта в шапке при несохранённой правке: «Остаться» возвращает выбор; «Не сохранять»; «Сохранить» — запись ТОГО объекта",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const A = Number(a.$("#v2-object").value);
      const B = otherObject(a);
      await a.type(a.$("#se-input"), "11", { clear: true });
      a.setValue(a.$("#v2-object"), String(B));
      await waitFor(() => a.dialog(), { what: "диалог несохранённого" });
      await a.answerDialog("Остаться");
      t.eq(Number(a.$("#v2-object").value), A, "выбор в шапке вернулся к прежнему объекту");
      t.eq(a.$("#se-input").value, "11", "правка сохранена");
      a.setValue(a.$("#v2-object"), String(B));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.log.some((e) => e.path.startsWith("/settings/info-plate") && e.method === "GET" && e.path.includes(`object_id=${B}`)), { what: "экран перезагружен под новым объектом" });
      const put = puts(a)[0];
      t.eq(put.path, `/settings/info-plate?object_id=${A}`, "записан ПРЕЖНИЙ объект (тот, где правили), а не новый");
      t.eq(puts(a).length, 1, "один PUT");
      // теперь правка на B и «Не сохранять»
      await waitFor(() => a.$("#se-input")?.value === "3", { what: "значение нового объекта" });
      await a.type(a.$("#se-input"), "20", { clear: true });
      a.setValue(a.$("#v2-object"), String(A));
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$("#se-input")?.value === "11", { what: "значение прежнего объекта" });
      t.eq(puts(a).length, 1, "«Не сохранять» ничего не записало");
      t.eq(a.ctl.data.settings.lateThreshold[B], undefined, "у объекта B значение не менялось");
    },
  },
  {
    id: "SE-06", title: "Права как в V1: пункт виден только при праве изменения; при праве чтения экран скрыт и по прямой ссылке ведёт на начальную страницу",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object")?.options.length > 1, { what: "выбор объекта" });
      t.ok(a.$(`${NAV}[data-section="late-threshold"]`), "у администратора экран есть");
      a.ctl.setPermissions({ system_admin: false, features: { info_plate: "read" } });
      a.setValue(a.$("#v2-object"), String(otherObject(a)));
      await waitFor(() => !a.$(`${NAV}[data-section="late-threshold"]`), { what: "экран скрыт при праве чтения" });
      a.win.location.hash = "#/late-threshold";
      await a.settle(200);
      t.ok(a.$(".v2-card") || !a.$("#se-input"), "по прямой ссылке настройка не открывается");
      a.ctl.setPermissions({ system_admin: false, features: { info_plate: "write" } });
      a.setValue(a.$("#v2-object"), String(Number(a.$("#v2-object").value) === 1 ? 2 : 1));
      await waitFor(() => a.$(`${NAV}[data-section="late-threshold"]`), { what: "экран доступен при праве изменения" });
    },
  },
];

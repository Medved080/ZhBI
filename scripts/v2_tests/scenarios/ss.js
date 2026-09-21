// «Сеансы»: свои входы — список и завершение (SS-*). Стенд — фейковый бэкенд.
import { openApp, waitFor, gateIsReal } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const rowsOf = (a) => a.$$("#ss-body tbody tr").map((tr) => tr.dataset.id);
const dels = (a) => a.ctl.log.filter((e) => e.method === "DELETE" && e.path.startsWith("/me/sessions"));
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="sessions"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="sessions"]`));
  await waitFor(() => a.$("#ss-body tbody tr"), { what: "список сеансов" });
}

export const tests = [
  {
    id: "SS-01", title: "Список сеансов: у текущего нет кнопки «Завершить» (это «Выйти»), у чужих есть; счётчик на кнопке «завершить все»",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a);
      t.eq(rowsOf(a), ["cur000000001", "oth000000002", "oth000000003"], "три сеанса из ответа сервера");
      t.ok(!a.$('tr[data-id="cur000000001"] [data-end]'), "у текущего сеанса кнопки завершения нет");
      t.has(a.$('tr[data-id="cur000000001"]').textContent, "этот сеанс", "текущий помечен");
      t.eq(a.$$("[data-end]").length, 2, "кнопки — у двух чужих");
      t.has(a.$("#ss-close-others").textContent, "(2)", "число других сеансов на кнопке");
    },
  },
  {
    id: "SS-02", title: "Завершение одного сеанса: подтверждение с IP; отказ ничего не удаляет; согласие — DELETE по id, список перечитан",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('[data-end="oth000000002"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(a.dialog().textContent, "10.0.0.5", "в подтверждении назван IP сеанса");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(dels(a).length, 0, "отказ ничего не завершил");
      a.click(a.$('[data-end="oth000000002"]'));
      await a.answerDialog("Завершить");
      await waitFor(() => !rowsOf(a).includes("oth000000002"), { what: "сеанс исчез" });
      t.eq(dels(a).map((e) => e.path), ["/me/sessions/oth000000002"], "DELETE ровно этого сеанса");
      t.eq(rowsOf(a), ["cur000000001", "oth000000003"], "остальные на месте");
      t.has(a.$("#ss-status").textContent, "Сеанс завершён", "статус после повторного чтения");
    },
  },
  {
    id: "SS-03", title: "Завершить все, кроме текущего: число в подтверждении, POST, остаётся только текущий; кнопка недоступна",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$("#ss-close-others"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(a.dialog().textContent, "(2)", "в подтверждении число сеансов");
      await a.answerDialog("Отмена");
      t.eq(a.ctl.log.filter((e) => e.method === "POST" && e.path === "/me/sessions/close-others").length, 0, "отказ ничего не завершил");
      a.click(a.$("#ss-close-others"));
      await a.answerDialog("Завершить (2)");
      await waitFor(() => rowsOf(a).length === 1, { what: "остался один сеанс" });
      t.eq(rowsOf(a), ["cur000000001"], "остался текущий");
      t.ok(a.$("#ss-close-others").disabled, "кнопка недоступна, других сеансов нет");
      t.has(a.$("#ss-status").textContent, "Завершено сеансов: 2", "результат из ответа сервера");
    },
  },
  {
    id: "SS-04", title: "Сеанс уже завершён (404) — цель достигнута, список обновлён; сбой сервера — без автоповтора и без ложного успеха; двойной клик — один запрос",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('[data-end="oth000000002"]'));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      a.ctl.data.settings.sessions = a.ctl.data.settings.sessions.filter((x) => x.id !== "oth000000002"); // кто-то уже завершил
      await a.answerDialog("Завершить");
      await waitFor(() => !rowsOf(a).includes("oth000000002"), { what: "список обновлён" });
      t.has(a.$("#ss-status").textContent, "Сеанс завершён", "404 не показан как ошибка");
      a.ctl.failNext("DELETE /me/sessions", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$('[data-end="oth000000003"]'));
      await a.answerDialog("Завершить");
      await waitFor(() => /Неизвестно|завершён, хотя/.test(a.$("#ss-status").textContent) || dels(a).length >= 2, { what: "исход сбоя" });
      await a.settle(100);
      t.eq(dels(a).length, 2, "запрос завершения не повторялся автоматически");
      t.ok(rowsOf(a).includes("oth000000003"), "сеанс остался в списке — ложного успеха нет");
      const hold = a.ctl.hold("DELETE /me/sessions");
      a.click(a.$('[data-end="oth000000003"]'));
      await a.answerDialog("Завершить");
      await hold.waitForRequest(1, 3000);
      t.ok(a.$("#ss-close-others").disabled && [...a.$$("[data-end]")].every((b) => b.disabled), "на время записи всё заблокировано");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => !rowsOf(a).includes("oth000000003"), { what: "завершён" });
      t.eq(dels(a).length, 3, "ровно один запрос на попытку");
      hold.dispose?.();
    },
  },
];

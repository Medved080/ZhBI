// «Цвет подписей марок»: личный цвет (LC-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const patches = (a) => a.ctl.log.filter((e) => e.method === "PATCH" && e.path.includes("/label-color"));
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="label-color"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="label-color"]`));
  await waitFor(() => a.$("#lc-color"), { what: "экран цвета подписей" });
}
const setColor = (a, v) => { a.setValue(a.$("#lc-color"), v); };

export const tests = [
  {
    id: "LC-01", title: "Цвет подписей: по умолчанию #222222; выбор → PATCH себе с одним полем, повторное чтение /me подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      t.eq(a.$("#lc-color").value, "#222222", "по умолчанию цвет V1");
      t.ok(a.$("#lc-save").disabled, "без правки «Сохранить» недоступна");
      const meId = a.ctl.data.users.find((u) => u.domain_login === "qa.admin").id;
      setColor(a, "#AABB33");
      await waitFor(() => !a.$("#lc-save").disabled, { what: "правка" });
      a.click(a.$("#lc-save"));
      await waitFor(() => /подтверждён чтением/.test(a.$("#lc-status").textContent), { what: "подтверждение" });
      const p = patches(a)[0];
      t.eq(p.path, `/users/${meId}/label-color`, "PATCH — своему пользователю");
      t.eq(p.body, { label_color: "#aabb33" }, "в теле только цвет (нижний регистр)");
      t.ok(a.$("#lc-save").disabled, "после сохранения правки нет");
      t.eq(a.ctl.data.users.find((u) => u.id === meId).label_color, "#aabb33", "у сервера записан цвет");
    },
  },
  {
    id: "LC-02", title: "Сброс на умолчание шлёт null; отмена правки ничего не пишет; двойной клик — один запрос; сбой — введённое остаётся, автоповтора нет",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, "#123456");
      a.click(a.$("#lc-revert"));
      await waitFor(() => a.$("#lc-save").disabled, { what: "правка отменена" });
      t.eq(a.$("#lc-color").value, "#222222", "цвет вернулся");
      t.eq(patches(a).length, 0, "отмена ничего не записала");
      setColor(a, "#123456");
      a.ctl.failNext("PATCH /users", { status: 422, detail: "Цвет подписей QA-отказ" });
      a.click(a.$("#lc-save"));
      await waitFor(() => /Не удалось сохранить/.test(a.$("#lc-status").textContent), { what: "сообщение о сбое" });
      t.has(a.$("#lc-status").textContent, "QA-отказ", "текст ошибки показан");
      t.eq(a.$("#lc-color").value, "#123456", "введённое осталось");
      t.eq(patches(a).length, 1, "без автоповтора");
      const hold = a.ctl.hold("PATCH /users");
      a.click(a.$("#lc-save"));
      await hold.waitForRequest(1, 3000);
      a.click(a.$("#lc-save")); a.click(a.$("#lc-reset"));
      t.ok(a.$("#lc-save").disabled && a.$("#lc-reset").disabled && a.$("#lc-color").disabled, "на время записи всё заблокировано");
      hold.release();
      await waitFor(() => /подтверждён чтением/.test(a.$("#lc-status").textContent), { what: "сохранено" });
      t.eq(patches(a).length, 2, "второй PATCH один — двойной клик не размножил запрос");
      a.click(a.$("#lc-reset"));
      await waitFor(() => /Сброшено/.test(a.$("#lc-status").textContent), { what: "сброс" });
      t.eq(patches(a)[2].body, { label_color: null }, "сброс — null");
      t.eq(a.$("#lc-color").value, "#222222", "снова цвет по умолчанию");
    },
  },
  {
    id: "LC-03", title: "Сервер 5xx с записью: исход не повторяется, проверяется чтением; несохранённое — под сторожем",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, "#0a0b0c");
      a.ctl.failNext("PATCH /users", { status: 503, detail: "Недоступно (QA)" });
      a.click(a.$("#lc-save"));
      await waitFor(() => /не подтверждено/.test(a.$("#lc-status").textContent), { what: "не подтверждено" });
      t.eq(patches(a).length, 1, "повторной записи нет");
      t.eq(a.$("#lc-color").value, "#0a0b0c", "введённое сохранено на экране");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => a.dialog(), { what: "сторож несохранённого" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#lc-color"), "остались на экране");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Не сохранять");
      await waitFor(() => !a.$("#lc-color"), { what: "ушли с экрана" });
      t.eq(patches(a).length, 1, "«Не сохранять» ничего не записало");
    },
  },
  {
    id: "LC-04", title: "Права как в V1: без права записи в «Пользователи» экран скрыт; с правом записи — доступен",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object")?.options.length > 1, { what: "выбор объекта" });
      t.ok(a.$(`${NAV}[data-section="label-color"]`), "у администратора экран есть");
      const other = () => String(Number(a.$("#v2-object").value) === 1 ? 2 : 1);
      a.ctl.setPermissions({ system_admin: false, features: { users: "read" } });
      a.setValue(a.$("#v2-object"), other());
      await waitFor(() => !a.$(`${NAV}[data-section="label-color"]`), { what: "экран скрыт при праве чтения" });
      a.ctl.setPermissions({ system_admin: false, features: { users: "write" } });
      a.setValue(a.$("#v2-object"), other());
      await waitFor(() => a.$(`${NAV}[data-section="label-color"]`), { what: "экран доступен при праве записи" });
    },
  },
  {
    id: "LC-05", title: "Значение #RGB, допустимое для сервера: поле показывает его верно (#ffaa00, не чёрным), экран не «грязный»",
    async run(t) {
      const a = await openApp({ home: true, query: "me=" + encodeURIComponent(JSON.stringify({ label_color: "#fa0" })) });
      await open(a);
      t.eq(a.$("#lc-color").value, "#ffaa00", "#fa0 показано как #ffaa00");
      t.ok(a.$("#lc-save").disabled, "без правки «Сохранить» недоступна");
      t.eq(patches(a).length, 0, "ничего не записано");
    },
  },
  {
    id: "LC-06", title: "Запись прошла, перечитать не удалось: экран не считается несохранённым, запись не повторяется",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, "#123456");
      a.ctl.failNext("GET /me", { status: 500, detail: "Чтение недоступно (QA)" });
      a.click(a.$("#lc-save"));
      await waitFor(() => /перечитать не удалось/.test(a.$("#lc-status").textContent), { what: "сбой чтения" });
      t.ok(a.$("#lc-save").disabled, "запись прошла — экран не считается несохранённым");
      t.eq(a.ctl.data.users.find((u) => u.domain_login === "qa.admin").label_color, "#123456", "сервер цвет сохранил");
      t.eq(patches(a).length, 1, "запись не повторялась");
    },
  },
];

// «Внешний вид»: личная цветовая гамма (AP-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const patches = (a) => a.ctl.log.filter((e) => e.method === "PATCH" && e.path.includes("/ui-theme"));
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="appearance"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="appearance"]`));
  await waitFor(() => a.$$("[data-skin]").length === 7, { what: "семь гамм" });
}

export const tests = [
  {
    id: "AP-01", title: "Гамма: семь вариантов, выбрана текущая; выбор → PATCH себе, повторное чтение /me подтверждает, отметка переезжает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      t.eq(a.$$("[data-skin]").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.skin), ["gos"], "по умолчанию выбран «Базовый»");
      const meId = a.ctl.data.users.find((u) => u.domain_login === "qa.admin").id;
      a.click(a.$('[data-skin="graphite"]'));
      await waitFor(() => /сохранена и подтверждена чтением/.test(a.$("#ap-status").textContent), { what: "подтверждение" });
      const p = patches(a)[0];
      t.eq(p.path, `/users/${meId}/ui-theme`, "PATCH — своему пользователю");
      t.eq(p.body, { ui_theme: "graphite" }, "в теле только гамма");
      t.eq(a.$$("[data-skin]").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.skin), ["graphite"], "выбор переехал");
      t.eq(a.win.document.documentElement.style.colorScheme, "dark", "тёмная гамма — тёмная схема V2");
      a.click(a.$('[data-skin="sand"]'));
      await waitFor(() => a.$('[data-skin="sand"][aria-pressed="true"]'), { what: "светлая гамма" });
      t.eq(a.win.document.documentElement.style.colorScheme, "light", "светлая гамма — светлая схема");
    },
  },
  {
    id: "AP-02", title: "Повторный клик по выбранной гамме ничего не пишет; сбой сервера — сообщение и прежний выбор; двойной клик — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('[data-skin="gos"]'));
      await a.settle(60);
      t.eq(patches(a).length, 0, "выбранная гамма не пишется повторно");
      a.ctl.failNext("PATCH /users", { status: 422, detail: "Отказ (QA)" });
      a.click(a.$('[data-skin="neon"]'));
      await waitFor(() => /Не удалось сохранить/.test(a.$("#ap-status").textContent), { what: "сообщение об отказе" });
      t.has(a.$("#ap-status").textContent, "Отказ (QA)", "показан текст ошибки");
      t.ok(a.$('[data-skin="gos"][aria-pressed="true"]'), "выбор остался прежним — ложного успеха нет");
      t.eq(patches(a).length, 1, "запись не повторялась автоматически");
      const hold = a.ctl.hold("PATCH /users");
      a.click(a.$('[data-skin="emerald"]'));
      await hold.waitForRequest(1, 3000);
      t.ok([...a.$$("[data-skin]")].every((b) => b.disabled), "на время записи выбор заблокирован");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => a.$('[data-skin="emerald"][aria-pressed="true"]'), { what: "выбрана" });
      t.eq(patches(a).length, 2, "два PATCH: неудачный и повторный вручную");
      hold.dispose?.();
    },
  },
  {
    id: "AP-03", title: "Неизвестный исход: 5xx на записи → проверка чтением без повтора; сбой чтения после успешной записи — не «сбой сохранения», гамма применена",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.ctl.failNext("PATCH /users", { status: 503, detail: "Недоступно (QA)" });
      a.click(a.$('[data-skin="indigo"]'));
      await waitFor(() => /не подтверждено/i.test(a.$("#ap-status").textContent), { what: "не подтверждено" });
      t.eq(patches(a).length, 1, "5xx не повторён автоматически");
      t.ok(a.$('[data-skin="gos"][aria-pressed="true"]'), "выбор прежний — сервер гамму не записал");
      a.ctl.failNext("GET /me", { status: 500, detail: "Чтение недоступно (QA)" });
      a.click(a.$('[data-skin="msu"]'));
      await waitFor(() => /перечитать не удалось/.test(a.$("#ap-status").textContent), { what: "сбой чтения" });
      t.ok(!/Не удалось сохранить/.test(a.$("#ap-status").textContent), "сбой чтения не выдаётся за сбой записи");
      t.eq(patches(a).length, 2, "запись выполнена один раз");
      t.eq(a.ctl.data.users.find((u) => u.domain_login === "qa.admin").ui_theme, "msu", "сервер гамму сохранил");
    },
  },
];

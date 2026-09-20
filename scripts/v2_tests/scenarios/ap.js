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
      a.ctl.failNext("PATCH /users", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$('[data-skin="neon"]'));
      await waitFor(() => /Не удалось сохранить/.test(a.$("#ap-status").textContent), { what: "сообщение о сбое" });
      t.has(a.$("#ap-status").textContent, "Сбой (QA)", "показан текст ошибки");
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
];

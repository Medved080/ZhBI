// «Права пользователей»: сводка доступа, только чтение (AV-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const writes = (a) => a.ctl.log.filter((e) => e.method !== "GET" && e.method !== "HEAD");
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="access-matrix"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="access-matrix"]`));
  await waitFor(() => a.$$("#av-body tbody tr").length > 0, { what: "таблица сводки" });
}

export const tests = [
  {
    id: "AV-01", title: "Сводка: все пользователи, системная роль и выданный доступ по уровням; только GET, записей нет",
    async run(t) {
      const a = await openApp({ home: true });
      const before = a.ctl.log.length;
      await open(a);
      const users = a.ctl.data.users.length;
      t.eq(a.$$("#av-body tbody tr").length, users, "строка на каждого пользователя");
      t.has(a.$("#av-count").textContent, `Пользователей: ${users} из ${users}`, "счётчик");
      const granted = a.ctl.data.access[0];
      const uid = granted.user_id;
      const row = [...a.$$("#av-body tbody tr")].find((r) => r.textContent.includes(a.ctl.data.users.find((u) => u.id === uid).last_name));
      t.ok(row && /Проект|Объект|Все проекты/.test(row.textContent), "у пользователя с грантом показан уровень доступа");
      t.ok(a.$$("#av-body tbody tr").some((r) => /не задан/.test(r.textContent)), "у пользователей без доступа — «не задан»");
      const paths = a.ctl.log.slice(before).map((e) => `${e.method} ${e.path}`);
      for (const p of ["GET /users", "GET /users/access-matrix", "GET /projects", "GET /projects-tree"]) t.ok(paths.includes(p), `запрошено: ${p}`);
      t.eq(writes(a).length, 0, "ни одной записи");
    },
  },
  {
    id: "AV-02", title: "Поиск и «только без доступа» — на клиенте, без запросов; ошибка загрузки → сообщение и «Повторить»",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const total = a.$$("#av-body tbody tr").length;
      const n = a.ctl.log.length;
      a.setValue(a.$("#av-search"), "zzzz-нет-такого");
      await waitFor(() => /Нет пользователей/.test(a.$("#av-body").textContent), { what: "пустой результат" });
      a.setValue(a.$("#av-search"), "");
      await waitFor(() => a.$$("#av-body tbody tr").length === total, { what: "все строки" });
      a.click(a.$("#av-none"));
      await waitFor(() => a.$$("#av-body tbody tr").length < total, { what: "фильтр «без доступа»" });
      t.ok(a.$$("#av-body tbody tr").every((r) => /не задан/.test(r.textContent)), "остались только без доступа");
      t.eq(a.ctl.log.length, n, "фильтры не делают запросов");
      a.ctl.failNext("GET /users/access-matrix", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("#av-refresh"));
      await waitFor(() => a.$("#av-retry"), { what: "сообщение об ошибке" });
      t.has(a.$("#av-body").textContent, "Сбой (QA)", "текст ошибки показан");
      a.click(a.$("#av-retry"));
      await waitFor(() => a.$$("#av-body tbody tr").length > 0, { what: "повтор" });
      t.eq(writes(a).length, 0, "записей нет");
    },
  },
  {
    id: "AV-03", title: "Права: экран виден только при праве чтения «Пользователи»",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object")?.options.length > 1, { what: "выбор объекта" });
      t.ok(a.$(`${NAV}[data-section="access-matrix"]`), "у администратора экран есть");
      a.ctl.setPermissions({ system_admin: false, features: { users: "none" } });
      a.setValue(a.$("#v2-object"), String(Number(a.$("#v2-object").value) === 1 ? 2 : 1));
      await waitFor(() => !a.$(`${NAV}[data-section="access-matrix"]`), { what: "экран скрыт без права" });
      a.ctl.setPermissions({ system_admin: false, features: { users: "read" } });
      a.setValue(a.$("#v2-object"), String(Number(a.$("#v2-object").value) === 1 ? 2 : 1));
      await waitFor(() => a.$(`${NAV}[data-section="access-matrix"]`), { what: "экран виден при праве чтения" });
    },
  },
];

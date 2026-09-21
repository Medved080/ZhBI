// «Что нового»: личная отметка «Ознакомился» (CL-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const acks = (a) => a.ctl.log.filter((e) => e.method === "POST" && e.path === "/changelog/ack");
async function open(a, unseen) {
  if (unseen) a.ctl.data.settings.changelogAck = null; // ни одной подтверждённой версии — непрочитано всё
  await waitFor(() => a.$(`${NAV}[data-section="changelog"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="changelog"]`));
  await waitFor(() => a.$$("#rd-body tbody tr").length > 0, { what: "таблица журнала" });
}

export const tests = [
  {
    id: "CL-01", title: "Есть непрочитанные: кнопка со счётчиком; клик → один POST без тела, успех после повторного чтения, кнопка исчезает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, true);
      t.eq(a.$$("#rd-body tbody tr").length, 2, "две записи журнала");
      t.has(a.$("#rd-ack").textContent, "Ознакомился (2)", "кнопка со счётчиком непрочитанных");
      a.click(a.$("#rd-ack"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#rd-ack-status")?.textContent || ""), { what: "подтверждение" });
      t.eq(acks(a).length, 1, "один POST");
      t.eq(acks(a)[0].body, {}, "тело пустое — версию подставляет сервер");
      t.ok(!a.$("#rd-ack"), "кнопка исчезла — непрочитанных нет");
      t.eq(a.ctl.data.settings.changelogAck, "9.99", "у сервера подтверждена верхняя версия");
    },
  },
  {
    id: "CL-02", title: "Все прочитано — кнопки нет; двойной клик — один запрос; 4xx — сообщение; 5xx без записи — не повторяется, «не подтверждено»",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, false);
      t.ok(!a.$("#rd-ack"), "прочитано всё — кнопки нет");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => !a.$("#rd-body"), { what: "ушли" });
      a.ctl.data.settings.changelogAck = null;
      a.click(a.$(`${NAV}[data-section="changelog"]`));
      await waitFor(() => a.$("#rd-ack"), { what: "кнопка" });
      a.ctl.failNext("POST /changelog/ack", { status: 422, detail: "Отказ (QA)" });
      a.click(a.$("#rd-ack"));
      await waitFor(() => /Не удалось отметить/.test(a.$("#rd-ack-status").textContent), { what: "сообщение" });
      t.has(a.$("#rd-ack-status").textContent, "Отказ (QA)", "текст ошибки показан");
      t.ok(a.$("#rd-ack"), "кнопка осталась");
      a.ctl.failNext("POST /changelog/ack", { status: 503, detail: "Недоступно (QA)" });
      a.click(a.$("#rd-ack"));
      await waitFor(() => /не подтверждена/.test(a.$("#rd-ack-status")?.textContent || ""), { what: "не подтверждено" });
      t.eq(acks(a).length, 2, "5xx не повторён автоматически");
      const hold = a.ctl.hold("POST /changelog/ack");
      a.click(a.$("#rd-ack"));
      await hold.waitForRequest(1, 3000);
      a.click(a.$("#rd-ack"));
      t.ok(a.$("#rd-ack").disabled, "на время запроса кнопка заблокирована");
      hold.release();
      await waitFor(() => !a.$("#rd-ack"), { what: "отмечено" });
      t.eq(acks(a).length, 3, "двойной клик дал один запрос");
    },
  },
  {
    id: "CL-03", title: "Поиск без совпадений: кнопка «Ознакомился» остаётся рабочей; сообщение об отметке не переживает обновление",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, true);
      await a.type(a.$("#rd-search"), "нет-такого-слова");
      await waitFor(() => /Ничего не найдено/.test(a.$("#rd-body").textContent), { what: "пустой результат поиска" });
      t.ok(a.$("#rd-ack"), "кнопка видна при пустом результате поиска");
      a.click(a.$("#rd-ack"));
      await waitFor(() => acks(a).length === 1, { what: "запрос отметки" });
      await waitFor(() => /подтверждено чтением/.test(a.$("#rd-ack-status")?.textContent || ""), { what: "подтверждение" });
      a.ctl.data.settings.changelogAck = null; // вышла новая версия
      a.click(a.$("#rd-refresh"));
      await waitFor(() => a.$("#rd-ack"), { what: "снова есть непрочитанные" });
      t.eq(a.$("#rd-ack-status").textContent.trim(), "", "старое «подтверждено» рядом с новой кнопкой не остаётся");
    },
  },
];

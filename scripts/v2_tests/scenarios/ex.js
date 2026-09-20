// Выгрузка файлов схемы: «Экспорт в XLS» и «Экспорт в PDF» (EX-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const spyBlobs = (a) => { const made = []; const orig = a.win.URL.createObjectURL.bind(a.win.URL); a.win.URL.createObjectURL = (b) => { made.push(b); return orig(b); }; return made; };
async function open(a, id) {
  await waitFor(() => a.$(`${NAV}[data-section="${id}"]`), { what: `навигация ${id}` });
  a.click(a.$(`${NAV}[data-section="${id}"]`));
  await waitFor(() => a.$("#ex-form") || a.$(".v2-callout-bad") || /Выберите объект/.test(a.$("#v2-content").textContent), { what: `экран ${id}` });
}
const objSource = (a) => a.ctl.data.objects.find((o) => o.id === Number(a.$("#v2-object").value)).drawings.find((d) => d.is_current)?.source_file;

export const tests = [
  {
    id: "EX-01", title: "XLS «история»: запрос по чертежу выбранного объекта с датами периода, файл формируется",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, "export-xls");
      const src = objSource(a);
      t.has(a.$("#ex-source").textContent, src, "показан чертёж объекта");
      const made = spyBlobs(a);
      a.setValue(a.$("#ex-from"), "2026-08-01");
      a.setValue(a.$("#ex-to"), "2026-08-31");
      a.click(a.$("#ex-go"));
      await waitFor(() => /сформирован/.test(a.$("#ex-status").textContent), { what: "файл сформирован" });
      const req = a.ctl.log.find((e) => e.path === "/export.xlsx");
      t.eq(req.body, { mode: "history", source_file: src, date_from: "2026-08-01", date_to: "2026-08-31" }, "тело запроса: режим, чертёж, период");
      t.eq(made.length, 1, "создан один файл");
      t.ok(made[0].size > 0, "файл не пустой");
      t.eq(a.win.__downloads.map((d) => d.name), ["elements_history.xlsx"], "скачивание запрошено с понятным именем (на диск в тесте ничего не пишется)");
      t.eq(a.$("#v2-nav-note").textContent, "", "выгрузка не считается записью");
    },
  },
  {
    id: "EX-02", title: "XLS «на дату»: режим snapshot, дата в запросе только если задана; периодные поля скрыты",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, "export-xls");
      a.setValue(a.$("[name=ex-mode][value=snapshot]"), "snapshot");
      a.$("[name=ex-mode][value=snapshot]").checked = true;
      a.$("[name=ex-mode][value=snapshot]").dispatchEvent(new a.win.Event("input", { bubbles: true }));
      await waitFor(() => !a.$("#ex-snapshot").hidden && a.$("#ex-history").hidden, { what: "поле даты" });
      a.click(a.$("#ex-go"));
      await waitFor(() => a.ctl.log.some((e) => e.path === "/export.xlsx"), { what: "запрос" });
      t.eq(Object.keys(a.ctl.log.find((e) => e.path === "/export.xlsx").body).sort(), ["mode", "source_file"], "без даты — в теле нет date (текущий статус)");
      await waitFor(() => /сформирован/.test(a.$("#ex-status").textContent), { what: "файл" });
      a.setValue(a.$("#ex-date"), "2026-09-01");
      a.click(a.$("#ex-go"));
      await waitFor(() => a.ctl.log.filter((e) => e.path === "/export.xlsx").length === 2, { what: "второй запрос" });
      t.eq(a.ctl.log.filter((e) => e.path === "/export.xlsx")[1].body.date, "2026-09-01", "дата ушла в запрос");
    },
  },
  {
    id: "EX-03", title: "Некорректный период (начало позже конца, несуществующая дата) не отправляется",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, "export-xls");
      a.setValue(a.$("#ex-from"), "2026-09-10");
      a.setValue(a.$("#ex-to"), "2026-09-01");
      a.click(a.$("#ex-go"));
      await a.settle(80);
      t.has(a.$("#ex-status").textContent, "Начало периода позже конца", "сообщение о периоде");
      t.eq(a.ctl.log.filter((e) => e.path === "/export.xlsx").length, 0, "запроса нет");
    },
  },
  {
    id: "EX-04", title: "PDF: GET по чертежу с датой; сбой сервера — сообщение, повтор возможен; двойной клик — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, "export-pdf");
      const src = objSource(a);
      a.setValue(a.$("#ex-date"), "2026-09-05");
      a.ctl.failNext("GET /export.pdf", { status: 500, detail: "Сбой PDF (QA)" });
      a.click(a.$("#ex-go"));
      await waitFor(() => /Не удалось выгрузить/.test(a.$("#ex-status").textContent), { what: "сообщение о сбое" });
      t.has(a.$("#ex-status").textContent, "Сбой PDF (QA)", "показан текст ошибки");
      t.ok(!a.$("#ex-go").disabled, "повтор возможен");
      const hold = a.ctl.hold("GET /export.pdf");
      const made = spyBlobs(a);
      a.click(a.$("#ex-go"));
      await hold.waitForRequest(1, 3000);
      t.eq(a.click(a.$("#ex-go")), false, "второй клик невозможен");
      hold.release();
      await waitFor(() => /сформирован/.test(a.$("#ex-status").textContent), { what: "файл" });
      const gets = a.ctl.log.filter((e) => e.method === "GET" && e.path.startsWith("/export.pdf"));
      t.eq(gets.length, 2, "два запроса: неудачный и повторный");
      t.has(gets[1].path, `source_file=${encodeURIComponent(src)}`, "чертёж объекта в запросе");
      t.has(gets[1].path, "date=2026-09-05", "дата в запросе");
      t.eq(made.length, 1, "один файл");
      hold.dispose?.();
    },
  },
  {
    id: "EX-05", title: "Объект без чертежа: выгрузка недоступна, запросов нет (сервер для администратора выгрузил бы все объекты)",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
      const noDrawing = a.ctl.data.objects.find((o) => (o.kind || "zhbi") === "zhbi" && !(o.drawings || []).some((d) => d.is_current) && o.status !== "archived");
      t.ok(!!noDrawing, "в стенде есть объект ЖБИ без чертежа");
      a.setValue(a.$("#v2-object"), String(noDrawing.id));
      await a.settle(300);
      await waitFor(() => Number(a.$("#v2-object").value) === noDrawing.id && a.$(`${NAV}[data-section="export-xls"]`), { what: "экран доступен" });
      a.click(a.$(`${NAV}[data-section="export-xls"]`));
      await waitFor(() => a.$(".v2-callout-bad"), { what: "сообщение об отсутствии чертежа" });
      t.has(a.$(".v2-callout-bad").textContent, "нет загруженного чертежа", "причина названа");
      t.ok(!a.$("#ex-form"), "формы выгрузки нет");
      t.eq(a.ctl.log.filter((e) => e.path.startsWith("/export")).length, 0, "запросов выгрузки нет");
    },
  },
];

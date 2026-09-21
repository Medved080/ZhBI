// Запланированные работы объекта МФР: правка сроков и примечания (BW-*). Стенд — фейковый бэкенд.
import { openApp, waitFor, gateIsReal } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const patches = (a) => a.ctl.log.filter((e) => e.method === "PATCH" && e.path.includes("/block-works/"));
const work = (a, id) => a.ctl.data.settings.blockWorks[Number(a.$("#v2-object").value)].find((w) => w.id === id);
async function open(a) {
  await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
  const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
  a.setValue(a.$("#v2-object"), String(mfr.id));
  await waitFor(() => a.$(`${NAV}[data-section="blocks"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="blocks"]`));
  await waitFor(() => a.$$(".v2-read-tab").length === 3, { what: "вкладки учёта по блокам" });
  a.click(a.$$(".v2-read-tab")[1]);
  await waitFor(() => a.$("[data-row-edit]"), { what: "таблица работ с кнопкой «Сроки»" });
}
async function openWork(a, id) {
  a.click(a.$(`[data-row-edit="${id}"]`));
  await waitFor(() => a.$("[data-f=plan_start]") && a.$("#bw-status"), { what: `карточка работы ${id}` });
}

export const tests = [
  {
    id: "BW-01", title: "Базовый срок: PATCH только с двумя полями группы (не стирает прогноз и примечание), повторное чтение подтверждает, список обновляется",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      t.eq(a.$("[data-f=plan_start]").value, "2026-09-01", "показан текущий срок");
      t.ok(a.$("[data-save=plan]").disabled, "«Сохранить» недоступна, пока правки нет");
      a.setValue(a.$("[data-f=plan_end]"), "2026-09-25");
      await waitFor(() => !a.$("[data-save=plan]").disabled, { what: "кнопка сохранения" });
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "подтверждение" });
      const p = patches(a)[0];
      t.eq(Object.keys(p.body).sort(), ["plan_end", "plan_start"], "в теле только поля базового срока");
      t.eq(p.body, { plan_start: "2026-09-01", plan_end: "2026-09-25" }, "значения");
      t.ok(/\/block-works\/1$/.test(p.path), "PATCH ушёл на id открытой работы");
      t.eq(work(a, 1).plan_end, "2026-09-25", "сервер хранит новый срок");
      await waitFor(() => a.$("#rd-body").textContent.includes("25.09.2026"), { what: "таблица обновилась" });
      t.eq(patches(a).length, 1, "один изменяющий запрос");
    },
  },
  {
    id: "BW-02", title: "Очистка даты — явный null; прогноз — отдельная группа; примечание не трогает сроки",
    async run(t) {
      if (await gateIsReal()) { t.ok(true, "в режиме выпуска эта операция отключена политикой — поведение проверяется набором GT"); return; }
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      a.setValue(a.$("[data-f=plan_start]"), "");
      a.setValue(a.$("[data-f=plan_end]"), "");
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "очищено" });
      t.eq(patches(a)[0].body, { plan_start: null, plan_end: null }, "очистка — null у обеих дат");
      a.setValue(a.$("[data-f=forecast_start]"), "2026-10-01");
      a.setValue(a.$("[data-f=forecast_end]"), "2026-10-10");
      a.click(a.$("[data-save=forecast]"));
      await waitFor(() => patches(a).length === 2 && /Прогноз: сохранено/.test(a.$("#bw-status").textContent), { what: "прогноз" });
      t.eq(patches(a)[1].body, { forecast_start: "2026-10-01", forecast_end: "2026-10-10" }, "прогноз — только его поля");
      await a.type(a.$("[data-f=note]"), "Заметка QA");
      a.click(a.$("[data-save=note]"));
      await waitFor(() => patches(a).length === 3 && /Примечание: сохранено/.test(a.$("#bw-status").textContent), { what: "примечание" });
      t.eq(patches(a)[2].body, { note: "Заметка QA" }, "примечание — только оно");
      t.eq(work(a, 1).plan_start, null, "базовый срок остался очищенным");
    },
  },
  {
    id: "BW-03", title: "Некорректные даты (конец раньше начала) не отправляются; ввод остаётся",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      a.setValue(a.$("[data-f=plan_end]"), "2026-08-01");
      a.click(a.$("[data-save=plan]"));
      await a.settle(80);
      t.has(a.$("#bw-status").textContent, "конец раньше начала", "сообщение о периоде");
      t.eq(patches(a).length, 0, "запросов записи нет");
      t.eq(a.$("[data-f=plan_end]").value, "2026-08-01", "ввод остался");
    },
  },
  {
    id: "BW-04", title: "Работу изменили после открытия: подтверждение перезаписи; отказ ничего не пишет; согласие — запись",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      a.setValue(a.$("[data-f=plan_end]"), "2026-09-30");
      const w = work(a, 1); w.plan_end = "2026-09-22"; w.updated_at = "2026-09-21 09:00:00"; // другой пользователь сохранил
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => a.dialog(), { what: "подтверждение перезаписи" });
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(patches(a).length, 0, "отказ ничего не записал");
      t.eq(work(a, 1).plan_end, "2026-09-22", "чужая правка на месте");
      a.click(a.$("[data-save=plan]"));
      await a.answerDialog("Записать");
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "записано" });
      t.eq(work(a, 1).plan_end, "2026-09-30", "правка человека записана");
    },
  },
  {
    id: "BW-05", title: "Несохранённая правка: сторож при закрытии карточки, смене вкладки и смене объекта; сбой без автоповтора; двойной клик — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 2);
      a.setValue(a.$("[data-f=plan_start]"), "2026-11-01");
      a.click(a.$("#bw-close"));
      await waitFor(() => a.dialog(), { what: "диалог при закрытии" });
      await a.answerDialog("Остаться");
      t.eq(a.$("[data-f=plan_start]").value, "2026-11-01", "правка осталась");
      a.click(a.$$(".v2-read-tab")[0]);
      await waitFor(() => a.dialog(), { what: "диалог при смене вкладки" });
      await a.answerDialog("Остаться");
      const sel = a.$("#v2-object");
      const B = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value));
      a.setValue(sel, String(B));
      await waitFor(() => a.dialog(), { what: "диалог при смене объекта" });
      await a.answerDialog("Остаться");
      t.eq(patches(a).length, 0, "ничего не записано");
      a.setValue(a.$("[data-f=plan_end]"), "2026-11-05");
      a.ctl.failNext("PATCH /objects", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /не подтверждены|Неизвестно/.test(a.$("#bw-status").textContent), { what: "сообщение о сбое" });
      t.eq(patches(a).length, 1, "запись не повторялась автоматически");
      t.eq(a.$("[data-f=plan_end]").value, "2026-11-05", "ввод остался");
      const hold = a.ctl.hold("PATCH /objects");
      a.click(a.$("[data-save=plan]"));
      await hold.waitForRequest(1, 3000);
      t.eq(a.click(a.$("[data-save=plan]")), false, "второй клик невозможен");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "сохранено" });
      t.eq(patches(a).length, 2, "два PATCH: неудачный и повторный вручную");
      hold.dispose?.();
    },
  },
];

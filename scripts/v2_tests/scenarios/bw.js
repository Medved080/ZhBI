// Запланированные работы объекта МФР: правка сроков, прогноза и примечания (BW-*). Стенд — фейковый бэкенд, интерфейс — «Учёт по блокам» (V2).
// Изменения относительно прежней версии набора: работа выбирается щелчком по блоку слева и по строке справа (карточка — окно); в теле PATCH
// всегда есть отпечаток работы `expected_rev` (конкуренцию проверяет сервер, а не браузер); прогноз и примечание разрешены шлюзом.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const patches = (a) => a.ctl.log.filter((e) => e.method === "PATCH" && e.path.includes("/block-works/"));
const work = (a, id) => a.ctl.data.settings.blockWorks[Number(a.$("#v2-object").value)].find((w) => w.id === id);
async function open(a, blockId = 11) {
  await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
  const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
  a.setValue(a.$("#v2-object"), String(mfr.id));
  await waitFor(() => a.$(`${NAV}[data-section="blocks"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="blocks"]`));
  await waitFor(() => a.$$(".mfr-blk").length >= 3, { what: "блоки объекта" });
  a.click(a.$(`.mfr-blk[data-b="${blockId}"]`));
  await waitFor(() => a.$("tr[data-bw]"), { what: "таблица работ выбранного блока" });
}
async function openWork(a, id) {
  a.click(a.$(`tr[data-bw="${id}"]`));
  await waitFor(() => a.$("[data-f=plan_start]") && a.$("#bw-status") && a.$("[data-f=plan_start]").value !== undefined, { what: `карточка работы ${id}` });
  await waitFor(() => !a.$("[data-f=plan_start]").closest(".v2-card").textContent.includes("Загрузка работы"), { what: "работа загружена" });
}

export const tests = [
  {
    id: "BW-01", title: "Базовый срок: PATCH только с двумя полями группы и отпечатком работы (не стирает прогноз и примечание), повторное чтение подтверждает, список обновляется",
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
      t.eq(Object.keys(p.body).sort(), ["expected_rev", "plan_end", "plan_start"], "в теле поля базового срока и отпечаток работы");
      t.eq({ plan_start: p.body.plan_start, plan_end: p.body.plan_end }, { plan_start: "2026-09-01", plan_end: "2026-09-25" }, "значения");
      t.ok(typeof p.body.expected_rev === "string" && p.body.expected_rev.length > 3, "отпечаток передан");
      t.ok(/\/block-works\/1$/.test(p.path), "PATCH ушёл на id открытой работы");
      t.eq(work(a, 1).plan_end, "2026-09-25", "сервер хранит новый срок");
      await waitFor(() => a.$("#bs-tbl").textContent.includes("01.09–25.09"), { what: "таблица обновилась" });
      t.eq(patches(a).length, 1, "один изменяющий запрос");
    },
  },
  {
    id: "BW-02", title: "Очистка даты — явный null; прогноз — отдельная группа (новая версия, по подтверждению); примечание не трогает сроки",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      a.setValue(a.$("[data-f=plan_start]"), "");
      a.setValue(a.$("[data-f=plan_end]"), "");
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "очищено" });
      t.eq({ plan_start: patches(a)[0].body.plan_start, plan_end: patches(a)[0].body.plan_end }, { plan_start: null, plan_end: null }, "очистка — null у обеих дат");
      a.setValue(a.$("[data-f=forecast_start]"), "2026-10-01");
      a.setValue(a.$("[data-f=forecast_end]"), "2026-10-10");
      a.click(a.$("[data-save=forecast]"));
      await waitFor(() => a.dialog(), { what: "подтверждение: версия прогноза не отменяется" });
      t.has(a.dialog().textContent, "не отменяются", "в подтверждении сказано, что версии копятся и не отменяются");
      await a.answerDialog("Сохранить версию");
      await waitFor(() => patches(a).length === 2 && /Прогноз: сохранено/.test(a.$("#bw-status").textContent), { what: "прогноз" });
      t.eq(Object.keys(patches(a)[1].body).sort(), ["expected_rev", "forecast_end", "forecast_start"], "прогноз — только его поля и отпечаток");
      t.eq(work(a, 1).versions.length, 1, "версия прогноза записана (одна)");
      await a.type(a.$("[data-f=note]"), "Заметка QA");
      a.click(a.$("[data-save=note]"));
      await waitFor(() => patches(a).length === 3 && /Примечание: сохранено/.test(a.$("#bw-status").textContent), { what: "примечание" });
      t.eq(Object.keys(patches(a)[2].body).sort(), ["expected_rev", "note"], "примечание — только оно и отпечаток");
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
    id: "BW-04", title: "Работу изменили после открытия: сервер отвечает 409, ничего не записано, ввод цел; версию сервера можно загрузить и записать заново",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      await openWork(a, 1);
      a.setValue(a.$("[data-f=plan_end]"), "2026-09-30");
      const w = work(a, 1); w.plan_end = "2026-09-22"; w.updated_at = "2026-09-21 09:00:00"; // другой пользователь сохранил
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /изменили после того/.test(a.$("#bw-status").textContent), { what: "сообщение о конфликте" });
      t.eq(patches(a).length, 1, "запрос ушёл ровно один раз");
      t.eq(work(a, 1).plan_end, "2026-09-22", "чужая правка на месте (сервер ничего не изменил)");
      t.eq(a.$("[data-f=plan_end]").value, "2026-09-30", "ввод человека остался в поле");
      t.ok(a.$("#bw-reload"), "предложена загрузка версии сервера");
      a.click(a.$("#bw-reload"));
      await waitFor(() => a.$("[data-f=plan_end]") && a.$("[data-f=plan_end]").value === "2026-09-22", { what: "актуальные значения загружены" });
      a.setValue(a.$("[data-f=plan_end]"), "2026-09-30");
      await waitFor(() => !a.$("[data-save=plan]").disabled, { what: "кнопка" });
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#bw-status").textContent), { what: "записано" });
      t.eq(work(a, 1).plan_end, "2026-09-30", "правка человека записана после загрузки актуального");
    },
  },
  {
    id: "BW-05", title: "Несохранённая правка: сторож при закрытии карточки и смене объекта; сбой без автоповтора; двойной клик — один запрос",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, 12);
      await openWork(a, 2);
      a.setValue(a.$("[data-f=plan_start]"), "2026-11-01");
      a.click(a.$("#bw-close"));
      await waitFor(() => a.dialog(), { what: "диалог при закрытии" });
      await a.answerDialog("Остаться");
      t.eq(a.$("[data-f=plan_start]").value, "2026-11-01", "правка осталась");
      const sel = a.$("#v2-object");
      const B = [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value));
      a.setValue(sel, String(B));
      await waitFor(() => a.dialog(), { what: "диалог при смене объекта" });
      await a.answerDialog("Остаться");
      t.eq(patches(a).length, 0, "ничего не записано");
      a.setValue(a.$("[data-f=plan_end]"), "2026-11-05");
      a.ctl.failNext("PATCH /objects", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("[data-save=plan]"));
      await waitFor(() => /на сервере не найдено|исход неизвестен/.test(a.$("#bw-status").textContent), { what: "сообщение о сбое" });
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

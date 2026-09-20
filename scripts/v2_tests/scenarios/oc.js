// Объектные карточки: «Карточка объекта» (PC-*) и «События, задачи, вопросы» (RN-*). Стенд — фейковый бэкенд,
// PUT карточки там заменяет её целиком (как у настоящего backend) — потеря нетронутых списков была бы видна.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const otherObject = (a) => { const sel = a.$("#v2-object"); return [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value)); };
const puts = (a, p) => a.ctl.log.filter((e) => e.method === "PUT" && e.path.startsWith(p));
const status = (a) => a.$("#ce-status").textContent;

async function openCard(a) {
  await waitFor(() => a.$(`${NAV}[data-section="project-card"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="project-card"]`));
  await waitFor(() => a.$("#pc-title"), { what: "форма карточки" });
}
async function openNotes(a) {
  await waitFor(() => a.$(`${NAV}[data-section="report-notes"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="report-notes"]`));
  await waitFor(() => a.$("#rn-form") || a.$("#rn-new"), { what: "заметки" });
}
const card = (a) => a.ctl.data.settings.projectCards[Number(a.$("#v2-object").value)];

export const tests = [
  {
    id: "PC-01", title: "Карточка: правка наименования и вехи → PUT с ЦЕЛОЙ карточкой (нетронутые списки не обнулены), id объекта из шапки, повторное чтение подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await openCard(a);
      const oid = Number(a.$("#v2-object").value);
      t.eq(a.$("#pc-title").value, "QA-карточка", "показано наименование с сервера");
      t.eq(a.$("#pc-montage").value, "2026-12-30", "показан срок монтажа");
      t.ok(a.$("#pc-save").disabled, "«Сохранить» недоступна, пока правки нет");
      await a.type(a.$("#pc-title"), "  Новое имя  ", { clear: true });
      a.click(a.$("#pc-add"));
      await waitFor(() => a.$$("[data-ms=label]").length === 2, { what: "новая строка вехи" });
      await a.type(a.$$("[data-ms=label]")[1], "Веха-2");
      a.setValue(a.$$("[data-ms=date]")[1], "2026-10-05");
      a.click(a.$("#pc-save"));
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "подтверждение" });
      const put = puts(a, "/settings/project-card")[0];
      t.eq(put.path, `/settings/project-card?object_id=${oid}`, "объект из шапки");
      t.eq(put.body.title, "Новое имя", "наименование без лишних пробелов");
      t.eq(put.body.milestones, [{ label: "QA-веха", date: "2026-09-13" }, { label: "Веха-2", date: "2026-10-05" }], "вехи: прежняя и новая");
      t.eq([put.body.key_events, put.body.key_tasks], [["событие-карточки"], ["задача-карточки"]], "нетронутые списки ушли в теле — не обнулены");
      t.eq(card(a).key_events, ["событие-карточки"], "на сервере списки целы");
      t.eq(puts(a, "/settings/project-card").length, 1, "ровно один PUT");
      t.ok(a.$("#pc-save").disabled, "после сохранения правки нет");
    },
  },
  {
    id: "PC-02", title: "Карточка: веха без даты не отправляется, сообщение называет веху; ввод остаётся; удаление вехи и сохранение сохраняют лишние поля остальных вех",
    async run(t) {
      const a = await openApp({ home: true });
      const oid = 1;
      await openCard(a);
      const real = Number(a.$("#v2-object").value);
      a.ctl.data.settings.projectCards = { ...(a.ctl.data.settings.projectCards || {}), [real]: { title: "T", montage_deadline: null, delivery_deadline: null, milestones: [{ label: "А", date: "2026-01-01", note: "лишнее" }, { label: "Б", date: "2026-02-02" }], key_events: [], key_tasks: [], open_questions: [] } };
      a.click(a.$("#pc-refresh"));
      await waitFor(() => a.$$("[data-ms=label]").length === 2, { what: "две вехи" });
      a.setValue(a.$$("[data-ms=date]")[1], "");
      await waitFor(() => !a.$("#pc-save").disabled, { what: "есть правка" });
      a.click(a.$("#pc-save"));
      await a.settle(80);
      t.has(status(a), "Веха 2 «Б»", "сообщение называет веху");
      t.eq(puts(a, "/settings/project-card").length, 0, "запись не отправлена");
      a.click(a.$('[data-ms-del="1"]'));
      await waitFor(() => a.$$("[data-ms=label]").length === 1, { what: "веха удалена из формы" });
      a.click(a.$("#pc-save"));
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "сохранено" });
      t.eq(puts(a, "/settings/project-card")[0].body.milestones, [{ label: "А", date: "2026-01-01", note: "лишнее" }], "у оставшейся вехи сохранено неизвестное серверу поле");
      t.ok(oid === 1, "sanity");
    },
  },
  {
    id: "PC-03", title: "Карточку изменили после открытия: подтверждение перезаписи; отказ ничего не пишет; согласие пишет правки поверх",
    async run(t) {
      const a = await openApp({ home: true });
      await openCard(a);
      await a.type(a.$("#pc-title"), "Моя правка", { clear: true });
      card(a).title = "Чужая правка"; // другой пользователь сохранил, пока мы вводили
      a.click(a.$("#pc-save"));
      await waitFor(() => a.dialog(), { what: "подтверждение перезаписи" });
      t.has(a.dialog().textContent, "изменили после того", "сказано, что карточку изменили");
      await a.answerDialog("Отмена");
      await a.settle(80);
      t.eq(puts(a, "/settings/project-card").length, 0, "отказ ничего не записал");
      t.eq(card(a).title, "Чужая правка", "чужая правка на месте");
      t.eq(a.$("#pc-title").value, "Моя правка", "введённое не потеряно");
      a.click(a.$("#pc-save"));
      await a.answerDialog("Перезаписать");
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "перезаписано" });
      t.eq(card(a).title, "Моя правка", "правка человека записана");
    },
  },
  {
    id: "PC-04", title: "Сбой сервера при записи: без автоповтора, введённое остаётся; двойной клик — один PUT",
    async run(t) {
      const a = await openApp({ home: true });
      await openCard(a);
      await a.type(a.$("#pc-title"), "Сбойная", { clear: true });
      a.ctl.failNext("PUT /settings/project-card", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("#pc-save"));
      await waitFor(() => /не подтверждены|Неизвестно/.test(status(a)), { what: "сообщение о сбое" });
      t.eq(puts(a, "/settings/project-card").length, 1, "запись не повторялась автоматически");
      t.ok(!/Сохранено/.test(status(a)), "ложного успеха нет");
      t.eq(a.$("#pc-title").value, "Сбойная", "введённое осталось");
      const hold = a.ctl.hold("PUT /settings/project-card");
      a.click(a.$("#pc-save"));
      await waitFor(() => a.$("#pc-save").disabled && a.$("#pc-title").disabled, { what: "блокировка на время записи" });
      await hold.waitForRequest(1, 3000); // запрос записи дошёл до «сервера» (перед ним идёт проверочное чтение)
      t.eq(a.click(a.$("#pc-save")), false, "второй клик невозможен");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "сохранено" });
      t.eq(puts(a, "/settings/project-card").length, 2, "всего два PUT: неудачный и повторный вручную");
      hold.dispose?.();
    },
  },
  {
    id: "PC-05", title: "Смена объекта при несохранённой правке карточки: «Остаться» / «Сохранить» (запись ТОГО объекта) / «Не сохранять»",
    async run(t) {
      const a = await openApp({ home: true });
      await openCard(a);
      const A = Number(a.$("#v2-object").value), B = otherObject(a);
      await a.type(a.$("#pc-title"), "Для A", { clear: true });
      a.setValue(a.$("#v2-object"), String(B));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Остаться");
      t.eq(Number(a.$("#v2-object").value), A, "выбор в шапке вернулся");
      t.eq(a.$("#pc-title").value, "Для A", "правка сохранена");
      a.setValue(a.$("#v2-object"), String(B));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.log.some((e) => e.method === "GET" && e.path === `/settings/project-card?object_id=${B}`), { what: "экран под новым объектом" });
      t.eq(puts(a, "/settings/project-card")[0].path, `/settings/project-card?object_id=${A}`, "записан ПРЕЖНИЙ объект");
      await waitFor(() => a.$("#pc-title")?.value === "QA-карточка", { what: "карточка нового объекта" });
      await a.type(a.$("#pc-title"), "Для B", { clear: true });
      a.setValue(a.$("#v2-object"), String(A));
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$("#pc-title")?.value === "Для A", { what: "карточка прежнего объекта" });
      t.eq(puts(a, "/settings/project-card").length, 1, "«Не сохранять» ничего не записало");
    },
  },
  {
    id: "RN-01", title: "Заметки: список редакций, открытие, правка → PUT с очищенными строками (пустые отброшены), повторное чтение подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await openNotes(a);
      t.eq(a.$$("[data-rev]").map((b) => b.dataset.rev), ["2026-07-30"], "редакция из ответа сервера");
      a.click(a.$('[data-rev="2026-07-30"]'));
      await waitFor(() => a.$("[data-nf=events]")?.value === "событие", { what: "форма редакции" });
      t.ok(a.$("#rn-date").disabled, "дата существующей редакции не меняется");
      await a.type(a.$("[data-nf=tasks]"), "  задача 1  \n\n  задача 2 \n");
      a.click(a.$("#rn-save"));
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "подтверждение" });
      const put = puts(a, "/settings/report-notes")[0];
      t.eq(put.body, { effective_date: "2026-07-30", key_events: ["событие"], key_tasks: ["задача 1", "задача 2"], open_questions: [] }, "тело: строки очищены, пустые отброшены, остальные списки целы");
      t.eq(puts(a, "/settings/report-notes").length, 1, "один PUT");
    },
  },
  {
    id: "RN-02", title: "Новая редакция: пустая/несуществующая дата не отправляется; занятая дата не перезаписывается; свободная создаётся",
    async run(t) {
      const a = await openApp({ home: true });
      await openNotes(a);
      a.click(a.$("#rn-new"));
      await waitFor(() => !a.$("#rn-date").disabled, { what: "форма новой редакции" });
      await a.type(a.$("[data-nf=events]"), "Начало");
      a.click(a.$("#rn-save"));
      await a.settle(60);
      t.has(status(a), "существующую дату", "пустая дата отклонена");
      a.setValue(a.$("#rn-date"), "2026-07-30");
      a.click(a.$("#rn-save"));
      await a.settle(80);
      t.has(status(a), "уже есть", "занятая дата не перезаписывается молча");
      t.eq(puts(a, "/settings/report-notes").length, 0, "запросов записи нет");
      a.setValue(a.$("#rn-date"), "2026-08-15");
      a.click(a.$("#rn-save"));
      await waitFor(() => /подтверждено чтением/.test(status(a)), { what: "создана" });
      t.eq(a.$$("[data-rev]").map((b) => b.dataset.rev), ["2026-08-15", "2026-07-30"], "новая редакция в списке (по убыванию даты)");
      t.eq(puts(a, "/settings/report-notes")[0].body.effective_date, "2026-08-15", "в запросе выбранная дата");
    },
  },
  {
    id: "RN-03", title: "Удаление редакции: содержимое в подтверждении, отказ не удаляет, согласие — DELETE по дате и объекту, список перечитан",
    async run(t) {
      const a = await openApp({ home: true });
      await openNotes(a);
      const oid = Number(a.$("#v2-object").value);
      a.click(a.$('[data-rev="2026-07-30"]'));
      await waitFor(() => a.$("#rn-delete"), { what: "кнопка удаления" });
      a.click(a.$("#rn-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.has(a.dialog().textContent, "1 событий", "в подтверждении — состав редакции");
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(a.ctl.log.filter((e) => e.method === "DELETE").length, 0, "отказ ничего не удалил");
      a.click(a.$("#rn-delete"));
      await a.answerDialog("Удалить");
      await waitFor(() => !a.$$("[data-rev]").length && /удалена/.test(status(a)), { what: "редакция удалена" });
      const del = a.ctl.log.find((e) => e.method === "DELETE");
      t.eq(del.path, `/settings/report-notes/2026-07-30?object_id=${oid}`, "DELETE по дате редакции и объекту из шапки");
    },
  },
  {
    id: "RN-04", title: "Редакцию изменили после открытия: подтверждение перезаписи; отказ ничего не пишет",
    async run(t) {
      const a = await openApp({ home: true });
      await openNotes(a);
      const oid = Number(a.$("#v2-object").value);
      a.click(a.$('[data-rev="2026-07-30"]'));
      await waitFor(() => a.$("[data-nf=events]"), { what: "форма" });
      await a.type(a.$("[data-nf=events]"), "\nмоё");
      a.ctl.data.settings.reportNotes[oid][0].updated_at = "2026-09-21 09:59:59"; // другой пользователь сохранил
      a.click(a.$("#rn-save"));
      await waitFor(() => a.dialog(), { what: "подтверждение перезаписи" });
      await a.answerDialog("Отмена");
      await a.settle(60);
      t.eq(puts(a, "/settings/report-notes").length, 0, "отказ ничего не записал");
      t.has(a.$("[data-nf=events]").value, "моё", "введённое не потеряно");
    },
  },
  {
    id: "RN-05", title: "Переход на другую редакцию при несохранённой правке: «Остаться» / «Не сохранять» / «Сохранить и продолжить»",
    async run(t) {
      const a = await openApp({ home: true });
      await openNotes(a);
      a.click(a.$("#rn-new"));
      await waitFor(() => !a.$("#rn-date").disabled, { what: "форма новой редакции" });
      a.setValue(a.$("#rn-date"), "2026-09-01");
      await a.type(a.$("[data-nf=questions]"), "Вопрос?");
      a.click(a.$('[data-rev="2026-07-30"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Остаться");
      t.eq(a.$("[data-nf=questions]").value, "Вопрос?", "введённое осталось");
      a.click(a.$('[data-rev="2026-07-30"]'));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.$$("[data-rev]").length === 2 && a.$('[data-rev="2026-07-30"][aria-pressed="true"]'), { what: "сохранено и переключено" });
      t.eq(puts(a, "/settings/report-notes")[0].body.effective_date, "2026-09-01", "«Сохранить» создало редакцию на введённую дату");
      a.click(a.$("#rn-new"));
      await waitFor(() => !a.$("#rn-date").disabled, { what: "новая форма" });
      await a.type(a.$("[data-nf=events]"), "черновик");
      a.click(a.$('[data-rev="2026-09-01"]'));
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$('[data-rev="2026-09-01"][aria-pressed="true"]'), { what: "переключено" });
      t.eq(puts(a, "/settings/report-notes").length, 1, "«Не сохранять» ничего не записало");
    },
  },
];

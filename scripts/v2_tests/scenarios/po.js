// Проекты и объекты (PO-*). Данные стенда: проекты 1–14, объекты 1–20.
//   объект 1 — «тяжёлый» (blockers у delete-plan), 1 вложение; объект 3 — 3 вложения и превью;
//   объект 20 и проект 9/14 — удаляются чисто; проект 10 и объект 16 — очень длинные названия.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const failBoot = (o) => `failNext=${encodeURIComponent(JSON.stringify(o))}`;
const text = (a) => a.doc.body.innerText;

async function openPo(a, opts = {}) {
  await waitFor(() => a.$$(NAV).length >= 1 || a.$(".v2-page-head"), { what: "оболочка" });
  if (a.$(`${NAV}[data-section="projects-objects"]`)) a.click(a.$(`${NAV}[data-section="projects-objects"]`));
  await waitFor(() => a.$("#po-tree") && (a.$("[data-project]") || opts.allowEmpty), { what: "дерево проектов" });
  await a.settle(40);
}
const projectOf = (a, objectId) => a.ctl.data.objects.find((o) => o.id === objectId).project_id;
async function selectObject(a, id) {
  if (!a.$(`[data-object="${id}"]`)) {
    a.click(a.$(`[data-project="${projectOf(a, id)}"]`));
    await waitFor(() => a.$(`[data-object="${id}"]`), { what: `объект ${id} в дереве` });
  }
  a.click(a.$(`[data-object="${id}"]`));
  await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === a.ctl.data.objects.find((o) => o.id === id).name, { what: `карточка объекта ${id}` });
  await a.settle(40);
}
async function selectProject(a, id) {
  a.click(a.$(`[data-project="${id}"]`));
  await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === a.ctl.data.projects.find((p) => p.id === id).name, { what: `карточка проекта ${id}` });
  await a.settle(40);
}
const dirty = async (a, sel = "#pf-description", add = " правка") => { await a.type(a.$(sel), add); await waitFor(() => a.$("#po-save"), { what: "подвал с «Сохранить»" }); };
const fileList = (a, name = "qa-acc.txt", body = "синтетика") => {
  const dt = new a.win.DataTransfer();
  dt.items.add(new a.win.File([body], name, { type: "text/plain" }));
  return dt.files;
};

export const tests = [
  {
    id: "PO-01", title: "Загрузка: дерево проектов со счётчиками, форма-подсказка",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      t.ok(a.$$("[data-project]").length >= 8, "проекты показаны (фильтр «В работе»)");
      t.ok(/\d+ · \d+/.test(a.$("[data-project]").textContent), "счётчики «объектов · изделий»");
      t.has(text(a), "Выберите проект или объект слева", "форма без выбора — подсказка");
      t.ok(a.$(".v2-app") || a.$("#v2-content").classList.contains("v2-app"), "каркас закреплённого подвала (v2-app)");
    },
  },
  {
    id: "PO-02", title: "Чтение падает: явная ошибка + «Повторить», не пустое дерево",
    async run(t) {
      const a = await openApp();
      await waitFor(() => a.$(`${NAV}[data-section="projects-objects"]`) && a.$("#ua-rows"), { what: "навигация и первый раздел" });
      a.ctl.failNext("=/projects", { method: "GET", status: 500, detail: "База недоступна" });
      a.click(a.$(`${NAV}[data-section="projects-objects"]`));
      await waitFor(() => a.$("#po-retry"), { what: "«Повторить»" });
      t.has(text(a), "База недоступна", "причина видна");
      t.eq(a.$$("[data-project]").length, 0, "дерево не выдаётся за пустое");
      a.click(a.$("#po-retry"));
      await waitFor(() => a.$("[data-project]"), { what: "дерево после повтора" });
      t.ok(a.$$("[data-project]").length > 5, "после «Повторить» дерево загружено");
    },
  },
  {
    id: "PO-03", title: "Дерево: раскрытие, выбор проекта и объекта, карточка соответствует выбранному",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectProject(a, 1);
      t.ok(a.$('[data-object="1"]'), "проект раскрыт — видны его объекты");
      await selectObject(a, 3);
      t.eq(a.$("#pf-name").value, a.ctl.data.objects.find((o) => o.id === 3).name, "карточка объекта 3");
      t.ok(a.$("#po-open-v1"), "у объекта есть «Открыть в V1»");
      await selectProject(a, 1);
      t.notHas(a.$("#po-form").innerText, "Открыть в V1", "у проекта «Открыть в V1» нет");
    },
  },
  {
    id: "PO-04", title: "Поиск и фильтры: непрерывный ввод, статус «Все», пустой результат, сброс",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      const total = a.$$("[data-project]").length;
      const q = a.$("#po-search");
      const r = await a.type(q, "Проект");
      t.eq(r.lostFocusAt, [], "фокус не терялся при вводе");
      await a.settle(250);
      t.eq(a.doc.activeElement, q, "поле поиска в фокусе после дебаунса");
      a.select(q, 0, q.value.length);
      await a.type(q, "нетТакого");
      await a.settle(250);
      t.has(text(a), "Ничего не найдено", "пустой результат объяснён");
      t.eq(a.doc.activeElement, q, "фокус на месте после пустого результата");
      a.select(q, 0, q.value.length);
      await a.backspace(q, 1);
      await a.settle(250);
      t.eq(a.$$("[data-project]").length, total, "сброс поиска возвращает список");
      const st = a.$("#po-status-filter");
      a.setValue(st, "");
      await a.settle(60);
      t.ok(a.$$("[data-project]").length >= total, "статус «Все» показывает не меньше проектов");
      a.setValue(st, "archived");
      await a.settle(60);
      t.ok(a.$$("[data-project]").length < a.ctl.data.projects.length, "фильтр по статусу сужает список");
      // СМУ / ответственный / комбинации: в дереве остаются ТОЛЬКО проекты с подошедшими объектами и сами эти объекты
      a.setValue(st, "");
      const objs = a.ctl.data.objects;
      const ids = (list) => list.map((x) => String(x.id)).sort();
      const shown = (sel) => a.$$(sel).map((el) => el.dataset.project || el.dataset.object).sort();
      const smuId = objs.find((o) => o.smu_id != null).smu_id;
      a.setValue(a.$("#po-smu-filter"), String(smuId));
      await a.settle(80);
      const bySmu = objs.filter((o) => o.smu_id === smuId);
      t.eq(shown("[data-object]"), ids(bySmu), "СМУ: показаны ровно объекты этого СМУ");
      t.eq(shown("[data-project]"), [...new Set(bySmu.map((o) => String(o.project_id)))].sort(), "СМУ: проекты без таких объектов из дерева ушли");
      const respId = bySmu.find((o) => o.responsible_id != null).responsible_id;
      a.setValue(a.$("#po-responsible-filter"), String(respId));
      await a.settle(80);
      const both = bySmu.filter((o) => o.responsible_id === respId);
      t.eq(shown("[data-object]"), ids(both), "СМУ + ответственный: пересечение");
      t.eq(shown("[data-project]"), [...new Set(both.map((o) => String(o.project_id)))].sort(), "СМУ + ответственный: проекты пересечения");
      // сочетание, которому не отвечает ни один объект: понятный пустой результат, а не «данных нет»
      let empty = null;
      for (const s1 of new Set(objs.map((o) => o.smu_id).filter((v) => v != null))) {
        for (const r1 of new Set(objs.map((o) => o.responsible_id).filter((v) => v != null))) {
          if (!objs.some((o) => o.smu_id === s1 && o.responsible_id === r1)) { empty = [s1, r1]; break; }
        }
        if (empty) break;
      }
      t.ok(empty, "в данных стенда есть сочетание СМУ и ответственного без объектов");
      a.setValue(a.$("#po-smu-filter"), String(empty[0]));
      a.setValue(a.$("#po-responsible-filter"), String(empty[1]));
      await a.settle(80);
      t.eq(a.$$("[data-project]").length, 0, "пустое сочетание: проектов нет");
      t.has(a.$("#po-tree").textContent, "Ничего не найдено", "пустое сочетание: «Ничего не найдено»");
      t.notHas(a.$("#po-tree").textContent, "заведите проект", "пустой результат фильтра не выдаётся за отсутствие данных");
      a.setValue(a.$("#po-smu-filter"), "");
      a.setValue(a.$("#po-responsible-filter"), "");
      await a.settle(80);
      t.eq(a.$$("[data-project]").length >= total, true, "сброс фильтров возвращает дерево");
    },
  },
  {
    id: "PO-05", title: "Новый проект: без наименования сохранить нельзя (сообщение, запрос не уходит)",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      a.click(a.$("#po-add-project"));
      await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === "", { what: "пустая форма" });
      t.has(a.$("#po-form h3").textContent, "Новый проект", "заголовок «Новый проект»");
      t.has(a.$("#po-form").innerText, "Вложения станут доступны после первого сохранения", "подсказка про вложения");
      await dirty(a, "#pf-description", "только описание");
      a.click(a.$("#po-save"));
      await a.settle(80);
      t.has(a.$("#po-status").textContent, "Укажите наименование", "сообщение о пустом наименовании");
      t.eq(a.ctl.count("POST", "/projects"), 0, "запрос не отправлен");
      t.ok(!a.$("#po-save").disabled && !a.$("#pf-name").disabled, "кнопка и поля снова доступны");
    },
  },
  {
    id: "PO-06", title: "Новый проект: сохранение → дерево, «Добавлено.», данные после повторного открытия",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      a.click(a.$("#po-add-project"));
      await waitFor(() => a.$("#pf-name"), { what: "форма" });
      await a.type(a.$("#pf-name"), "QA-ACC-проект");
      await waitFor(() => a.$("#po-save"), { what: "подвал" });
      a.click(a.$("#po-save"));
      await waitFor(() => a.ctl.data.projects.some((p) => p.name === "QA-ACC-проект"), { what: "запись" });
      await a.settle(150);
      t.eq(a.ctl.count("POST", "/projects"), 1, "один POST");
      t.has(a.$("#po-status").textContent, "Добавлено", "«Добавлено.»");
      const created = a.ctl.data.projects.find((p) => p.name === "QA-ACC-проект");
      t.ok(a.$(`[data-project="${created.id}"]`), "проект появился в дереве");
      a.click(a.$(`[data-project="1"]`));
      await waitFor(() => a.$("#pf-name").value !== "QA-ACC-проект", { what: "другая запись" });
      a.click(a.$(`[data-project="${created.id}"]`));
      await waitFor(() => a.$("#pf-name").value === "QA-ACC-проект", { what: "повторное открытие" });
      t.eq(a.$("#po-save"), null, "после сохранения ложных кнопок нет");
      t.ok(a.$("#po-attachments"), "у сохранённого проекта блок вложений есть");
    },
  },
  {
    id: "PO-07", title: "Новый объект: проект по умолчанию из выбранного, справочники, сохранение",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectProject(a, 1);
      if (a.$$("[data-object]").length) { a.click(a.$('[data-project="1"]')); await a.settle(80); } // проект свёрнут — самый неудобный случай
      t.eq(a.$$("[data-object]").length, 0, "проект свёрнут");
      a.click(a.$("#po-add-object"));
      await waitFor(() => a.$("#pf-project") && a.$("#pf-name").value === "", { what: "форма нового объекта" });
      t.has(a.$("#po-form h3").textContent, "Новый объект", "заголовок");
      t.eq(a.$("#pf-project").value, "1", "проект по умолчанию — выбранный (1)");
      await a.type(a.$("#pf-name"), "QA-ACC-объект");
      const smuOpt = [...a.$("#pf-smu").options].find((o) => o.value);
      a.setValue(a.$("#pf-smu"), smuOpt.value);
      await waitFor(() => a.$("#po-save"), { what: "подвал" });
      a.click(a.$("#po-save"));
      await waitFor(() => a.ctl.count("POST", "/objects") === 1, { what: "POST /objects" });
      await a.settle(150);
      const body = a.ctl.log.find((e) => e.method === "POST" && e.path.startsWith("/objects")).body;
      t.eq(body.project_id, 1, "в запросе project_id=1");
      t.eq(String(body.smu_id), smuOpt.value, "в запросе выбранное СМУ");
      t.ok(a.ctl.data.objects.some((o) => o.name === "QA-ACC-объект"), "объект создан в фейковой БД");
      t.has(a.$("#po-status").textContent, "Добавлено", "«Добавлено.»");
      const created = a.ctl.data.objects.find((o) => o.name === "QA-ACC-объект");
      await waitFor(() => a.$(`[data-object="${created.id}"]`), { what: "новый объект в дереве" });
      t.ok(a.$(`[data-object="${created.id}"]`).classList.contains("v2-tree-selected"), "новый объект в дереве и выбран (родительский проект раскрыт)");
    },
  },
  {
    id: "PO-08", title: "Правка → «Отменить»: значения возвращены, подвал скрыт, запросов нет",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      const before = a.$("#pf-name").value;
      await dirty(a, "#pf-name", "ЛИШНЕЕ");
      a.click(a.$("#po-cancel"));
      await waitFor(() => !a.$("#po-cancel"), { what: "подвал скрыт" });
      t.eq(a.$("#pf-name").value, before, "наименование возвращено");
      t.eq(a.ctl.count("PATCH", "/objects/"), 0, "запросов нет");
      t.eq(a.$("#po-status").textContent.trim(), "", "статус чистый");
    },
  },
  {
    id: "PO-09", title: "Правка → «Сохранить»: PATCH, «Сохранено.», данные сервера после повторного открытия",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      await dirty(a, "#pf-description", " QA-правка");
      a.click(a.$("#po-save"));
      await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 1, { what: "PATCH" });
      await a.settle(150);
      t.has(a.$("#po-status").textContent, "Сохранено", "«Сохранено.»");
      t.has(a.ctl.data.objects.find((o) => o.id === 1).description, "QA-правка", "записано в фейковую БД");
      await selectObject(a, 3);
      await selectObject(a, 1);
      t.has(a.$("#pf-description").value, "QA-правка", "повторное открытие показывает данные сервера");
      t.eq(a.$("#po-save"), null, "ложных кнопок нет");
    },
  },
  {
    id: "PO-10", title: "Адрес и координаты: ручной ввод, координаты помечают форму изменённой, «Определить заново»",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      t.ok(a.$("#po-address input"), "поле адреса присутствует (классификатор не загружен — ручной ввод)");
      t.ok(a.$("#po-coords-refresh"), "«Определить заново» есть");
      a.setValue(a.$("#pf-lat"), "55.123456");
      await waitFor(() => a.$("#po-save"), { what: "подвал после правки широты" });
      t.ok(a.$("#po-save"), "правка координат делает форму «грязной»");
      t.has(a.$("#po-coords-status").textContent, "вручную", "статус координат: указаны вручную");
    },
  },
  {
    id: "PO-11", title: "Удаление: чистый объект / с блокерами / отмена / двойной клик / ошибка",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      // блокеры
      await selectObject(a, 1);
      a.click(a.$("#po-delete"));
      await waitFor(() => a.dialog(), { what: "диалог блокеров" });
      t.has(a.dialog().textContent, "Удалить нельзя", "«Удалить нельзя. Мешает…»");
      await a.answerDialog("Понятно");
      t.eq(a.ctl.count("POST", "/dictionaries/object/1/delete"), 0, "с блокерами запроса на удаление нет");
      // чистый: отмена
      await selectObject(a, 20);
      a.click(a.$("#po-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      t.ok(a.$(".v2-dialog .v2-danger"), "«Удалить» — danger-кнопка");
      await a.answerDialog("Отмена");
      t.ok(a.ctl.data.objects.some((o) => o.id === 20), "отмена не удаляет");
      // чистый: успех
      a.click(a.$("#po-delete"));
      await waitFor(() => a.dialog(), { what: "подтверждение" });
      await a.answerDialog("Удалить");
      await waitFor(() => !a.ctl.data.objects.some((o) => o.id === 20), { what: "удаление" });
      await a.settle(150);
      t.eq(a.ctl.count("POST", "/dictionaries/object/20/delete"), 1, "один POST delete");
      t.has(a.$("#po-status").textContent, "удалён", "«Объект удалён.»");
      t.has(text(a), "Выберите проект или объект слева", "выбор сброшен");
    },
  },
  {
    id: "PO-11b", title: "Удаление: двойной клик по «Удалить» — один диалог и один POST; ошибка 500 — читаемо, поля доступны",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectProject(a, 9);
      const del = a.$("#po-delete");
      a.click(del); a.click(del);
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.settle(60);
      t.eq(a.$$(".v2-dialog").length, 1, "один диалог");
      a.ctl.failNext("/dictionaries/project/9/delete", { status: 500, detail: "Сбой удаления" });
      await a.answerDialog("Удалить");
      await waitFor(() => a.ctl.count("POST", "/dictionaries/project/9/delete") >= 1, { what: "запрос" });
      await a.settle(150);
      t.eq(a.ctl.count("POST", "/dictionaries/project/9/delete"), 1, "один POST при двойном клике");
      t.has(a.$("#po-status").textContent, "Сбой удаления", "ошибка видна");
      t.ok(a.ctl.data.projects.some((p) => p.id === 9), "проект не удалён");
      t.ok(!a.$("#pf-name").disabled, "поля снова доступны");
    },
  },
  {
    id: "PO-12", title: "Вложения: загрузка синтетического файла, скачивание, превью, удаление",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 3);
      await waitFor(() => a.$$(".v2-attach-row").length === 3, { what: "3 вложения объекта" });
      const input = a.$("#po-attach-file");
      input.files = fileList(a);
      a.click(a.$("#po-attach-add"));
      await waitFor(() => a.$$(".v2-attach-row").length === 4, { what: "4 вложения после загрузки" });
      t.eq(a.ctl.count("POST", "/attachments"), 1, "один POST /attachments");
      t.ok(a.ctl.data.attachments.some((x) => x.filename === "qa-acc.txt"), "файл в фейковой БД");
      // превью: у объекта 3 оно уже назначено — снимаем, затем назначаем снова
      t.ok(a.$("[data-avatar-unset]"), "у объекта 3 превью назначено (★)");
      a.click(a.$("[data-avatar-unset]"));
      await waitFor(() => a.ctl.count("PUT", "/objects/3/avatar") === 1, { what: "PUT avatar (снять)" });
      await waitFor(() => a.$("[data-avatar-set]") && !a.$("[data-avatar-unset]"), { what: "превью снято" });
      a.click(a.$("[data-avatar-set]"));
      await waitFor(() => a.ctl.count("PUT", "/objects/3/avatar") === 2, { what: "PUT avatar (назначить)" });
      await waitFor(() => a.$("[data-avatar-unset]"), { what: "превью назначено" });
      // удаление загруженного
      const rowsBefore = a.$$(".v2-attach-row").length;
      const row = a.$$(".v2-attach-row").find((r) => r.textContent.includes("qa-acc.txt"));
      a.click(row.querySelector("[data-del]"));
      await waitFor(() => a.dialog(), { what: "подтверждение удаления вложения" });
      t.ok(a.$(".v2-dialog .v2-danger"), "подтверждение с danger-кнопкой");
      await a.answerDialog("Удалить");
      await waitFor(() => a.$$(".v2-attach-row").length === rowsBefore - 1, { what: "вложение удалено" });
      t.ok(!a.ctl.data.attachments.some((x) => x.filename === "qa-acc.txt"), "удалено в фейковой БД");
    },
  },
  {
    id: "PO-13", title: "Загрузка вложения идёт медленно: переходы заблокированы с причиной, после — снова доступны",
    async run(t) {
      for (const outcome of ["успех", "ошибка"]) {
        const a = await openApp();
        await openPo(a);
        await selectObject(a, 1);
        await waitFor(() => a.$("#po-attach-file"), { what: "форма загрузки" });
        a.$("#po-attach-file").files = fileList(a, "slow.txt");
        const hold = a.ctl.hold("POST /attachments");
        a.click(a.$("#po-attach-add"));
        await waitFor(() => a.ctl.count("POST", "/attachments") === 1, { what: "запрос ушёл" });
        await a.settle(40);
        t.ok(a.$$(NAV).every((b) => b.disabled), `[${outcome}] вкладки разделов заблокированы`);
        t.has(a.$("#v2-nav-note").textContent, "Идёт сохранение", `[${outcome}] причина видна`);
        t.ok(a.$("#v2-back-btn").disabled, `[${outcome}] «← Текущий интерфейс» заблокирована`);
        a.click(a.$('[data-object="2"], [data-object="3"]') || a.$("[data-project]"));
        await a.settle(60);
        t.eq(a.$("#pf-name").value, a.ctl.data.objects.find((o) => o.id === 1).name, `[${outcome}] выбор записи во время закачки не сработал`);
        if (outcome === "успех") hold.release(); else hold.fail(413, "Файл слишком большой");
        await waitFor(() => !a.$$(NAV).some((b) => b.disabled), { what: "конец записи" });
        await a.settle(60);
        if (outcome === "ошибка") t.has(a.$("#po-attach-status").textContent, "Файл слишком большой", "ошибка загрузки показана текстом");
        t.ok(!a.$("#v2-back-btn").disabled, `[${outcome}] навигация восстановлена`);
        a.close();
      }
    },
  },
  {
    id: "PO-14", title: "Удаление вложения: пока открыт диалог, вторые корзины заблокированы; отмена возвращает; один DELETE",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 3);
      await waitFor(() => a.$$("[data-del]").length >= 2, { what: "корзины" });
      const trashes = a.$$("[data-del]");
      a.click(trashes[0]);
      await waitFor(() => a.dialog(), { what: "диалог" });
      t.ok(a.$$("[data-del]").every((b) => b.disabled), "на время диалога все корзины заблокированы");
      a.click(trashes[1]);
      await a.settle(50);
      t.eq(a.$$(".v2-dialog").length, 1, "второй диалог не открылся");
      await a.answerDialog("Отмена");
      t.ok(a.$$("[data-del]").every((b) => !b.disabled), "после отмены корзины снова доступны");
      t.eq(a.ctl.count("DELETE", "/attachments/"), 0, "отмена ничего не удалила");
      a.click(a.$$("[data-del]")[0]);
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Удалить");
      await waitFor(() => a.ctl.count("DELETE", "/attachments/") === 1, { what: "DELETE" });
      t.eq(a.ctl.count("DELETE", "/attachments/"), 1, "ровно один DELETE");
    },
  },
  {
    id: "PO-16", title: "Права: «Удалить» только при dictDelete=write; вложения проекта — только админ сервиса",
    async run(t) {
      const w = await openApp({ perm: "writer" });
      await openPo(w);
      await selectObject(w, 20);
      t.eq(w.$("#po-delete"), null, "писатель без dict_delete: «Удалить» не показывается");
      await selectProject(w, 1);
      await waitFor(() => w.$("#po-attachments") && !w.$("#po-attachments").textContent.includes("Загрузка"), { what: "вложения проекта" });
      t.eq(w.$("#po-attach-file"), null, "вложения проекта: загрузки у не-админа нет");
      t.eq(w.$$("[data-del]").length, 0, "вложения проекта: корзин у не-админа нет");
      const d = await openApp({ perm: "deleter" });
      await openPo(d);
      await selectObject(d, 20);
      t.ok(d.$("#po-delete"), "dict_delete=write: «Удалить» есть");
    },
  },
  {
    id: "PO-17", title: "Dirty: смена записи → диалог; «Остаться» / «Не сохранять» / «Сохранить и продолжить»; нет ложного после сохранения",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      await dirty(a, "#pf-description", " X");
      a.click(a.$('[data-object="2"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Остаться");
      t.eq(a.$("#pf-name").value, a.ctl.data.objects.find((o) => o.id === 1).name, "«Остаться» — запись та же");
      t.has(a.$("#pf-description").value, " X", "ввод цел");
      a.click(a.$('[data-object="2"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.$("#pf-name").value === a.ctl.data.objects.find((o) => o.id === 2).name, { what: "переход на объект 2" });
      t.eq(a.ctl.count("PATCH", "/objects/1"), 1, "сохранено ровно один раз");
      a.click(a.$('[data-object="1"]'));
      await a.settle(100);
      t.eq(a.dialog(), null, "после сохранения ухода без предупреждения");
      await dirty(a, "#pf-description", " Y");
      a.click(a.$('[data-object="2"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$("#pf-name").value === a.ctl.data.objects.find((o) => o.id === 2).name, { what: "переход" });
      t.eq(a.ctl.count("PATCH", "/objects/1"), 1, "«Не сохранять» ничего не записал");
    },
  },
  {
    id: "PO-18", title: "Dirty + сохранение из диалога ухода падает: ошибка видна СРАЗУ, переход отменён, данные целы, повтор доступен",
    async run(t) {
      for (const [name, fail, expectText] of [
        ["500", { status: 500, detail: "Диск переполнен" }, "диск переполнен"],
        ["409", { status: 409, detail: "Имя уже занято" }, "имя уже занято"],
        ["422 список", { status: 422, detail: [{ loc: ["body", "name"], msg: "x", type: "missing" }] }, "name: обязательное поле"],
      ]) {
        const a = await openApp();
        await openPo(a);
        await selectObject(a, 1);
        await dirty(a, "#pf-description", "Z");
        a.ctl.failNext("PATCH /objects/1", fail);
        a.click(a.$('[data-object="2"]'));
        await waitFor(() => a.dialog(), { what: "диалог" });
        await a.answerDialog("Сохранить и продолжить");
        await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 1, { what: "попытка сохранения" });
        await a.settle(100);
        t.has(a.$("#po-status").textContent.toLowerCase(), expectText, `[${name}] ошибка видна в строке статуса сразу`);
        t.notHas(a.$("#po-status").textContent, "[object", `[${name}] нет [object Object]`);
        t.eq(a.$("#pf-name").value, a.ctl.data.objects.find((o) => o.id === 1).name, `[${name}] переход отменён`);
        t.has(a.$("#pf-description").value, "Z", `[${name}] введённые данные целы`);
        t.ok(a.$("#po-save") && !a.$("#po-save").disabled, `[${name}] «Сохранить» доступна для повтора`);
        a.click(a.$("#po-save"));
        await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 2, { what: "повтор" });
        await a.settle(120);
        t.has(a.ctl.data.objects.find((o) => o.id === 1).description, "Z", `[${name}] повтор сохранил данные`);
        a.close();
      }
    },
  },
  {
    id: "PO-19", title: "«Не сохранять» и «Остаться»: строка статуса не залипает на «Есть несохранённые изменения»",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      await dirty(a, "#pf-description", " X");
      t.has(a.$("#po-status").textContent, "Есть несохранённые изменения", "во время правки статус показан");
      a.click(a.$('[data-object="2"]'));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Не сохранять");
      await waitFor(() => a.$("#pf-name").value === a.ctl.data.objects.find((o) => o.id === 2).name, { what: "переход" });
      await a.settle(80);
      t.notHas(a.$("#po-status").textContent, "несохранённ", "после «Не сохранять» статус не залип");
      t.eq(a.$("#po-save"), null, "подвал пуст");
    },
  },
  {
    id: "PO-20", title: "Сохранение: двойной клик, 403/409/422/500/сеть — один PATCH, читаемо, нет ложного «Сохранено.»",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      await dirty(a, "#pf-description", " Q");
      const hold = a.ctl.hold("PATCH /objects/1");
      const b = a.$("#po-save");
      a.click(b); a.click(b);
      await a.settle(50);
      t.eq(a.ctl.count("PATCH", "/objects/1"), 1, "двойной клик — один запрос");
      t.ok(a.$("#pf-name").disabled, "поля заблокированы на время записи");
      hold.fail(403, "Нет прав на объект");
      await waitFor(() => a.$("#po-status").textContent.includes("Нет прав"), { what: "ошибка 403" });
      t.notHas(a.$("#po-status").textContent, "Сохранено", "нет ложного «Сохранено.»");
      t.ok(!a.$("#pf-name").disabled && !a.$("#po-save").disabled, "поля и «Сохранить» снова доступны");
      for (const [name, fail, expectText] of [
        ["409", { status: 409, detail: "Конфликт версий" }, "конфликт версий"],
        ["422", { status: 422, detail: [{ loc: ["body", "lat"], msg: "x", type: "float_parsing" }] }, "lat: нужно число"],
        ["сеть", { network: true }, "нет связи"],
      ]) {
        a.ctl.failNext("PATCH /objects/1", fail);
        a.click(a.$("#po-save"));
        await waitFor(() => a.$("#po-status").textContent.toLowerCase().includes(expectText), { what: `ошибка ${name}` });
        t.notHas(a.$("#po-status").textContent, "[object", `[${name}] нет [object Object]`);
        t.ok(!a.$("#po-save").disabled, `[${name}] кнопка доступна`);
      }
      a.click(a.$("#po-save"));
      await waitFor(() => a.$("#po-status").textContent.includes("Сохранено"), { what: "успех после повторов" });
    },
  },
  {
    id: "PO-26", title: "Сохранение объекта: форма СРАЗУ показывает подтверждённое сервером (обрезанные пробелы), dirty снят, повторное открытие то же; ввод, внесённый во время запроса, не затирается",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      const orig = a.ctl.data.objects.find((o) => o.id === 1).name;
      a.setValue(a.$("#pf-name"), `   ${orig} (правка)   `);
      a.setValue(a.$("#pf-description"), "  описание с пробелами  ");
      await waitFor(() => a.$("#po-save"), { what: "подвал" });
      a.click(a.$("#po-save"));
      await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 1, { what: "PATCH" });
      await waitFor(() => !a.$("#po-save"), { what: "подвал снят" });
      await a.settle(80);
      const entry = a.ctl.log.find((e) => e.method === "PATCH" && e.path.includes("/objects/1"));
      t.eq([entry.response.name, entry.response.description], [`${orig} (правка)`, "описание с пробелами"], "1) ответ сервера: пробелы по краям убраны");
      t.eq([a.$("#pf-name").value, a.$("#pf-description").value], [`${orig} (правка)`, "описание с пробелами"], "2) форма сразу показывает подтверждённое сервером");
      t.has(a.$("#po-status").textContent, "Сохранено", "3) есть подтверждение");
      t.notHas(a.$("#po-status").textContent, "несохранённые", "4) статус не «есть несохранённые изменения»");
      const unload = new a.win.Event("beforeunload", { cancelable: true });
      a.win.dispatchEvent(unload);
      t.ok(!unload.defaultPrevented, "4) страж закрытия страницы не видит несохранённого");
      a.click(a.$("[data-object=\"2\"]") || a.$$("[data-object]").find((el) => el.dataset.object !== "1"));
      await a.settle(150);
      t.ok(!a.dialog(), "4) при смене записи ложного предупреждения нет");
      await selectObject(a, 1);
      t.eq([a.$("#pf-name").value, a.$("#pf-description").value], [`${orig} (правка)`, "описание с пробелами"], "5) после повторного открытия те же значения");
      // более новый ввод во время запроса
      a.setValue(a.$("#pf-description"), "первое значение");
      await waitFor(() => a.$("#po-save"), { what: "подвал" });
      const hold = a.ctl.hold("PATCH /objects/1");
      a.click(a.$("#po-save"));
      await a.settle(60);
      const d = a.$("#pf-description"); d.disabled = false;
      a.setValue(d, "написано во время запроса");
      hold.release();
      await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 2, { what: "второй PATCH" });
      await a.settle(200);
      t.eq(a.ctl.data.objects.find((o) => o.id === 1).description, "первое значение", "6) сервер подтвердил отправленное");
      t.eq(a.$("#pf-description").value, "написано во время запроса", "6) более новый ввод не затёрт");
      t.ok(a.$("#po-save"), "6) «Сохранить» на месте — введённое ещё не сохранено");
      t.has(a.$("#po-status").textContent, "несохранённые", "6) статус честно говорит, что есть несохранённое");
      a.click(a.$("#po-save"));
      await waitFor(() => a.ctl.count("PATCH", "/objects/1") === 3 && !a.$("#po-save"), { what: "третий PATCH" });
      await a.settle(80);
      t.eq(a.ctl.data.objects.find((o) => o.id === 1).description, "написано во время запроса", "6) новое значение сохранено следующим запросом");
    },
  },
  {
    id: "PO-27", title: "Несохранённое — это различие с записью: вернули значение руками (текст, список, координата) — подвал, статус и сторож ухода сняты",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      const obj = a.ctl.data.objects.find((o) => o.id === 1);
      const unload = () => { const e = new a.win.Event("beforeunload", { cancelable: true }); a.win.dispatchEvent(e); return e.defaultPrevented; };
      t.ok(!unload(), "до правки предупреждения нет");
      a.setValue(a.$("#pf-name"), obj.name + "!");
      await waitFor(() => a.$("#po-save"), { what: "подвал после правки" });
      t.ok(unload(), "после правки сторож закрытия страницы включён");
      a.setValue(a.$("#pf-name"), obj.name);
      await a.settle(60);
      t.ok(!a.$("#po-save"), "значение возвращено — «Сохранить» ушла из подвала");
      t.notHas(a.$("#po-status").textContent, "несохранённые", "статус не «есть несохранённые изменения»");
      t.ok(!unload(), "значение возвращено — сторож закрытия страницы снят");
      // список: другое значение и обратно (select даёт строку, запись хранит число)
      const other = a.$$("#pf-smu option").map((o) => o.value).find((v) => v && v !== String(obj.smu_id ?? ""));
      a.setValue(a.$("#pf-smu"), other);
      await waitFor(() => a.$("#po-save"), { what: "подвал после смены СМУ" });
      a.setValue(a.$("#pf-smu"), String(obj.smu_id ?? ""));
      await a.settle(60);
      t.ok(!a.$("#po-save") && !unload(), "СМУ возвращено — несохранённого нет");
      // координата: тот же текст, что в записи
      a.setValue(a.$("#pf-lat"), String(obj.lat));
      await a.settle(60);
      t.ok(!a.$("#po-save") && !unload(), "координата набрана тем же значением — несохранённого нет");
      // уход на другую запись — без диалога
      a.click(a.$$("[data-object]").find((el) => el.dataset.object !== "1"));
      await a.settle(150);
      t.ok(!a.dialog(), "смена записи — ложного диалога нет");
    },
  },
  {
    id: "PO-21", title: "Запись прошла, обновление списков упало: «Сохранено, но обновить данные не удалось» + «Повторить обновление»",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      await selectObject(a, 1);
      await dirty(a, "#pf-description", "R");
      a.ctl.failNext("=/projects", { method: "GET", status: 500, detail: "Обновление недоступно" });
      a.click(a.$("#po-save"));
      await waitFor(() => a.$("#po-status").textContent.includes("обновить данные не удалось"), { what: "сообщение" });
      t.ok(a.$("#po-status-retry"), "кнопка «Повторить обновление»");
      t.has(a.$("#pf-description").value, "R", "форма показывает подтверждённое сервером значение");
      a.click(a.$("#po-status-retry"));
      await waitFor(() => !a.$("#po-status-retry"), { what: "повторное обновление" });
      t.notHas(a.$("#po-status").textContent, "не удалось", "после успешного повтора предупреждения нет");
    },
  },
  {
    id: "PO-22", title: "Поздний ответ вложений прежней записи не портит карточку текущей",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      const hold = a.ctl.hold("GET /attachments?entity_type=object&entity_id=3");
      await selectObject(a, 3);
      await waitFor(() => hold.pending >= 1, { what: "запрос вложений объекта 3 завис" });
      await selectObject(a, 1);
      await waitFor(() => a.$$(".v2-attach-row").length === 1, { what: "вложения объекта 1" });
      hold.release();
      await a.settle(200);
      t.eq(a.$$(".v2-attach-row").length, 1, "у объекта 1 остался его единственный файл, а не 3 от объекта 3");
      t.eq(a.$("#pf-name").value, a.ctl.data.objects.find((o) => o.id === 1).name, "карточка объекта 1 цела");
    },
  },
  {
    id: "PO-25", title: "Клавиатура: выбор узла дерева оставляет фокус на этом узле после перерисовки формы",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      const node = a.$('[data-project="2"]');
      node.focus();
      a.click(node);
      await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === a.ctl.data.projects.find((p) => p.id === 2).name, { what: "карточка" });
      await a.settle(150);
      t.eq(a.doc.activeElement?.dataset?.project, "2", "фокус остался на выбранном узле дерева (data-project=2)");
    },
  },
  {
    id: "PO-24", title: "Длинные названия и адреса не ломают форму и не создают горизонтальную прокрутку",
    async run(t) {
      const a = await openApp();
      await openPo(a);
      a.click(a.$("#po-status-filter"));
      a.setValue(a.$("#po-status-filter"), "");
      await a.settle(60);
      const long = a.ctl.data.projects.find((p) => p.id === 10);
      a.click(a.$(`[data-project="${long.id}"]`));
      await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === long.name, { what: "длинный проект" });
      await a.settle(80);
      const de = a.doc.documentElement;
      t.ok(de.scrollWidth <= de.clientWidth + 1, `нет горизонтальной прокрутки страницы (${de.scrollWidth} ≤ ${de.clientWidth})`);
      const form = a.$("#po-form");
      t.ok(form.scrollWidth <= form.clientWidth + 1, `форма не шире своей области (${form.scrollWidth} ≤ ${form.clientWidth})`);
      const tree = a.$("#po-tree");
      t.ok(tree.scrollWidth <= tree.clientWidth + 1, `дерево не шире своей области (${tree.scrollWidth} ≤ ${tree.clientWidth})`);
    },
  },
];

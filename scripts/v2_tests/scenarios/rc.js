// «Цвета модели МФР»: схема объекта целиком (RC-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const puts = (a) => a.ctl.log.filter((e) => e.method === "PUT" && e.path.startsWith("/revit-plan/colors"));
const mfrId = (a) => a.ctl.data.objects.find((o) => o.kind === "mfr").id;
async function open(a) {
  await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
  a.setValue(a.$("#v2-object"), String(mfrId(a)));
  await waitFor(() => a.$(`${NAV}[data-section="mfr-colors"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="mfr-colors"]`));
  await waitFor(() => a.$$("input[data-cat]").length === 5, { what: "пять категорий объекта" });
}
const setColor = (a, cat, v) => a.setValue(a.$(`input[data-cat="${cat}"]`), v);
const setRange = (a, kind, cat, v) => a.setValue(a.$(`input[data-${kind}="${cat}"]`), String(v));
const saved = (a) => a.ctl.data.settings.revitColors?.[mfrId(a)];

export const tests = [
  {
    id: "RC-01", title: "Схема: категории объекта, значения с сервера; правка цвета → PUT целой схемы (шаблон становится «custom»), объект из шапки, повторное чтение подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      t.eq(a.$('input[data-cat="Стены"]').value, "#d4d4d4", "цвет стен — из схемы объекта");
      t.eq(a.$('input[data-cat="Помещение"]').value, "#c8c8c8", "у категории без цвета — запасной");
      t.eq(a.$('input[data-opacity="Окна"]').value, "90", "прозрачность окон — из схемы");
      t.ok(a.$("#rc-save").disabled, "без правки «Сохранить» недоступна");
      setColor(a, "Стены", "#AA0000");
      await waitFor(() => !a.$("#rc-save").disabled, { what: "правка" });
      a.click(a.$("#rc-save"));
      await waitFor(() => /подтверждена чтением/.test(a.$("#rc-status").textContent), { what: "подтверждение" });
      const p = puts(a)[0];
      t.eq(p.path, `/revit-plan/colors?object_id=${mfrId(a)}`, "запись — по объекту из шапки");
      t.eq(p.body.preset, "custom", "правка делает схему своей");
      t.eq(p.body.colors["Стены"], "#AA0000".toLowerCase(), "цвет стен — нижним регистром");
      t.eq(Object.keys(p.body.colors).length, 12, "в схеме остались все 12 цветов, а не только изменённый");
      t.eq(p.body.opacity, { Окна: 90 }, "прозрачность окон не потеряна");
      t.eq(saved(a).colors["Стены"], "#aa0000", "у сервера записан цвет");
      t.ok(a.$("#rc-save").disabled, "после сохранения правки нет");
    },
  },
  {
    id: "RC-02", title: "Прозрачность и свечение: ползунки пишутся вместе с цветами; ноль не хранится, но подтверждается сверкой по правилам сервера",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setRange(a, "opacity", "Стены", 40);
      setRange(a, "glow", "Окна", 0);
      await waitFor(() => !a.$("#rc-save").disabled, { what: "правка" });
      t.eq(a.$('input[data-opacity="Стены"]').nextElementSibling.textContent, "40%", "подпись процента обновилась");
      a.click(a.$("#rc-save"));
      await waitFor(() => /подтверждена чтением/.test(a.$("#rc-status").textContent), { what: "подтверждение" });
      t.eq(saved(a).opacity.Стены, 40, "прозрачность стен сохранена");
      t.eq(saved(a).opacity.Окна, 90, "прозрачность окон не потеряна");
      t.eq(saved(a).glow, {}, "нулевое свечение не хранится");
      t.eq(a.$('input[data-glow="Окна"]').value, "0", "ползунок показывает записанное");
    },
  },
  {
    id: "RC-03", title: "Шаблон: применяется к черновику с предупреждением, заменяет схему целиком только при сохранении; отмена возвращает сохранённое",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.click(a.$('[data-preset="pastel"]'));
      await waitFor(() => /заменена шаблоном/.test(a.$("#rc-status").textContent), { what: "предупреждение о замене" });
      t.eq(a.$('input[data-cat="Стены"]').value, "#a9c6dd", "цвета шаблона в черновике");
      t.eq(puts(a).length, 0, "применение шаблона ничего не записало");
      a.click(a.$("#rc-revert"));
      await waitFor(() => a.$('input[data-cat="Стены"]').value === "#d4d4d4", { what: "возврат к сохранённому" });
      a.click(a.$('[data-preset="contrast"]'));
      await waitFor(() => !a.$("#rc-save").disabled, { what: "черновик" });
      a.click(a.$("#rc-save"));
      await waitFor(() => /подтверждена чтением/.test(a.$("#rc-status").textContent), { what: "подтверждение" });
      t.eq(puts(a)[0].body.preset, "contrast", "записан шаблон");
      t.eq(saved(a).preset, "contrast", "у сервера шаблон, не «custom»");
    },
  },
  {
    id: "RC-04", title: "Один запрос при двойном клике; сбой 4xx — введённое остаётся, без автоповтора; 5xx — проверка чтением, не повтор",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, "Стены", "#111111");
      a.ctl.failNext("PUT /revit-plan", { status: 422, detail: "Схема QA-отказ" });
      a.click(a.$("#rc-save"));
      await waitFor(() => /Не удалось сохранить/.test(a.$("#rc-status").textContent), { what: "сообщение" });
      t.has(a.$("#rc-status").textContent, "QA-отказ", "текст ошибки показан");
      t.eq(a.$('input[data-cat="Стены"]').value, "#111111", "введённое осталось");
      t.eq(puts(a).length, 1, "без автоповтора");
      a.ctl.failNext("PUT /revit-plan", { status: 503, detail: "Недоступно (QA)" });
      a.click(a.$("#rc-save"));
      await waitFor(() => /не подтверждено/.test(a.$("#rc-status").textContent), { what: "не подтверждено" });
      t.eq(puts(a).length, 2, "5xx не повторён");
      t.eq(a.$('input[data-cat="Стены"]').value, "#111111", "введённое сохранено на экране");
      const hold = a.ctl.hold("PUT /revit-plan");
      a.click(a.$("#rc-save"));
      await hold.waitForRequest(1, 3000);
      a.click(a.$("#rc-save")); a.click(a.$('[data-preset="pastel"]'));
      t.ok(a.$("#rc-save").disabled && a.$('input[data-cat="Стены"]').disabled, "на время записи всё заблокировано");
      hold.release();
      await waitFor(() => /подтверждена чтением/.test(a.$("#rc-status").textContent), { what: "сохранено" });
      t.eq(puts(a).length, 3, "двойной клик дал один запрос");
    },
  },
  {
    id: "RC-05", title: "Чужая правка после открытия: перезапись только по подтверждению; «Отмена» ничего не пишет; сторож при смене объекта",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, "Стены", "#222222");
      a.ctl.data.settings.revitColors = { [mfrId(a)]: { preset: "custom", colors: { Стены: "#999999" }, opacity: {}, glow: {} } };
      a.click(a.$("#rc-save"));
      await waitFor(() => a.dialog(), { what: "диалог о чужой правке" });
      await a.answerDialog("Отмена");
      await waitFor(() => /Сохранение отменено/.test(a.$("#rc-status").textContent), { what: "отказ" });
      t.eq(puts(a).length, 0, "без подтверждения ничего не записано");
      t.eq(saved(a).colors["Стены"], "#999999", "чужая схема на месте");
      a.click(a.$("#rc-save"));
      await waitFor(() => a.dialog(), { what: "диалог" });
      await a.answerDialog("Перезаписать");
      await waitFor(() => /подтверждена чтением/.test(a.$("#rc-status").textContent), { what: "записано" });
      t.eq(saved(a).colors["Стены"], "#222222", "записана наша версия");
      setColor(a, "Стены", "#333333");
      const other = a.ctl.data.objects.find((o) => o.kind !== "mfr" && o.id !== mfrId(a));
      a.setValue(a.$("#v2-object"), String(other.id));
      await waitFor(() => a.dialog(), { what: "сторож несохранённого" });
      await a.answerDialog("Остаться");
      t.eq(Number(a.$("#v2-object").value), mfrId(a), "выбор в шапке вернулся");
      t.eq(a.$('input[data-cat="Стены"]').value, "#333333", "правка на месте");
    },
  },
  {
    id: "RC-06", title: "Права как в V1: экран есть только на объекте МФР и при праве записи в «Модель Revit»",
    async run(t) {
      const a = await openApp({ home: true });
      await waitFor(() => a.$("#v2-object") && a.$$(NAV).length > 3, { what: "оболочка" });
      const jbi = a.ctl.data.objects.find((o) => o.kind !== "mfr" && o.status !== "completed")?.id;
      t.ok(!a.$(`${NAV}[data-section="mfr-colors"]`), "на объекте ЖБИ экран скрыт");
      a.setValue(a.$("#v2-object"), String(mfrId(a)));
      await waitFor(() => a.$(`${NAV}[data-section="mfr-colors"]`), { what: "на объекте МФР экран есть" });
      a.ctl.setPermissions({ system_admin: false, features: { revit_model: "read" } });
      a.setValue(a.$("#v2-object"), String(jbi));
      await waitFor(() => Number(a.$("#v2-object").value) === jbi, { what: "смена объекта" });
      a.setValue(a.$("#v2-object"), String(mfrId(a)));
      await waitFor(() => Number(a.$("#v2-object").value) === mfrId(a), { what: "возврат на МФР" });
      await a.settle(300);
      t.ok(!a.$(`${NAV}[data-section="mfr-colors"]`), "при праве чтения экран скрыт");
      a.ctl.setPermissions({ system_admin: false, features: { revit_model: "write" } });
      a.setValue(a.$("#v2-object"), String(jbi));
      await waitFor(() => Number(a.$("#v2-object").value) === jbi, { what: "смена объекта" });
      a.setValue(a.$("#v2-object"), String(mfrId(a)));
      await waitFor(() => a.$(`${NAV}[data-section="mfr-colors"]`), { what: "при праве записи экран есть" });
    },
  },
];

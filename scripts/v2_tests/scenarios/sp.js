// «Форма маркеров»: форма по паре (слой, тип) (SP-*). Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const puts = (a) => a.ctl.log.filter((e) => e.method === "PUT" && e.path === "/element-shapes");
const shapeOf = (a, layer) => a.ctl.data.settings.layerCombos.find((r) => r.layer === layer).shape;
async function open(a) {
  await waitFor(() => a.$(`${NAV}[data-section="marker-shapes"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="marker-shapes"]`));
  await waitFor(() => a.$$("#se2-body select").length === 3, { what: "три пары" });
}
const sel = (a, i) => a.$$("#se2-body select")[i];

export const tests = [
  {
    id: "SP-01", title: "Правка одной пары → PUT только изменённой (не все три), пара определяется строкой, повторное чтение подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      t.eq(a.$$("#se2-body select").map((s) => s.value), ["outline", "outline", "outline"], "по умолчанию «контур»");
      t.ok(a.$("#se2-save").disabled, "без правки «Сохранить» недоступна");
      a.setValue(sel(a, 1), "hexagon");
      await waitFor(() => !a.$("#se2-save").disabled, { what: "правка" });
      t.has(a.$("#se2-body").textContent, "изменено", "строка помечена «изменено»");
      a.click(a.$("#se2-save"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#se2-status").textContent), { what: "подтверждение" });
      t.eq(puts(a).length, 1, "один PUT");
      t.eq(puts(a)[0].body, [{ layer: "QA_слой_2", element_type: "Плита перекрытия", shape: "hexagon" }], "в теле только изменённая пара, с её слоем и типом");
      t.eq(shapeOf(a, "QA_слой_2"), "hexagon", "у сервера записана форма");
      t.eq(shapeOf(a, "QA_слой_1"), "outline", "соседняя пара не тронута");
      t.ok(a.$("#se2-save").disabled, "после сохранения правки нет");
    },
  },
  {
    id: "SP-02", title: "Поиск не теряет правку; отмена возвращает сохранённое и ничего не пишет; несколько пар — один PUT",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.setValue(sel(a, 0), "circle");
      await a.type(a.$("#se2-search"), "ригель");
      await waitFor(() => a.$$("#se2-body select").length === 1, { what: "поиск" });
      a.setValue(a.$("#se2-search"), "");
      await waitFor(() => a.$$("#se2-body select").length === 3, { what: "поиск сброшен" });
      t.eq(sel(a, 0).value, "circle", "правка пережила поиск");
      a.click(a.$("#se2-revert"));
      await waitFor(() => a.$("#se2-save").disabled, { what: "правка отменена" });
      t.eq(sel(a, 0).value, "outline", "форма вернулась");
      t.eq(puts(a).length, 0, "отмена ничего не записала");
      a.setValue(sel(a, 0), "circle"); a.setValue(sel(a, 2), "diamond");
      await waitFor(() => /Сохранить \(2\)/.test(a.$("#se2-save").textContent), { what: "две правки" });
      a.click(a.$("#se2-save"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#se2-status").textContent), { what: "подтверждение" });
      t.eq(puts(a).length, 1, "один PUT на две пары");
      t.eq(puts(a)[0].body.map((x) => `${x.layer}:${x.shape}`), ["QA_слой_1:circle", "QA_слой_3:diamond"], "обе пары с верными слоями");
    },
  },
  {
    id: "SP-03", title: "Один запрос при двойном клике; 4xx — введённое остаётся, без автоповтора; 5xx — проверка чтением, не повтор",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.setValue(sel(a, 0), "square");
      a.ctl.failNext("PUT /element-shapes", { status: 422, detail: "Форма QA-отказ" });
      a.click(a.$("#se2-save"));
      await waitFor(() => /Не удалось сохранить/.test(a.$("#se2-status").textContent), { what: "сообщение" });
      t.has(a.$("#se2-status").textContent, "QA-отказ", "текст ошибки показан");
      t.eq(sel(a, 0).value, "square", "введённое осталось");
      t.eq(puts(a).length, 1, "без автоповтора");
      a.ctl.failNext("PUT /element-shapes", { status: 503, detail: "Недоступно (QA)" });
      a.click(a.$("#se2-save"));
      await waitFor(() => /не подтверждены/.test(a.$("#se2-status").textContent), { what: "не подтверждено" });
      t.eq(puts(a).length, 2, "5xx не повторён");
      t.eq(sel(a, 0).value, "square", "введённое сохранено на экране");
      const hold = a.ctl.hold("PUT /element-shapes");
      a.click(a.$("#se2-save"));
      await hold.waitForRequest(1, 3000);
      a.click(a.$("#se2-save"));
      t.ok(a.$("#se2-save").disabled && sel(a, 1).disabled, "на время записи всё заблокировано");
      hold.release();
      await waitFor(() => /подтверждено чтением/.test(a.$("#se2-status").textContent), { what: "сохранено" });
      t.eq(puts(a).length, 3, "двойной клик дал один запрос");
    },
  },
  {
    id: "SP-04", title: "Сторож несохранённого при уходе с экрана; права как в V1 (запись в «Форма маркеров»)",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      a.setValue(sel(a, 0), "triangle");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await waitFor(() => a.dialog(), { what: "сторож" });
      await a.answerDialog("Остаться");
      t.ok(a.$("#se2-body select"), "остались на экране");
      a.click(a.$(`${NAV}[data-section="home"]`));
      await a.answerDialog("Не сохранять");
      await waitFor(() => !a.$("#se2-body"), { what: "ушли" });
      t.eq(puts(a).length, 0, "«Не сохранять» ничего не записало");
      await waitFor(() => a.$("#v2-object")?.options.length > 1, { what: "выбор объекта" });
      a.ctl.setPermissions({ system_admin: false, features: { dict_element_shapes: "read" } });
      a.setValue(a.$("#v2-object"), String(Number(a.$("#v2-object").value) === 1 ? 2 : 1));
      await waitFor(() => !a.$(`${NAV}[data-section="marker-shapes"]`), { what: "экран скрыт при праве чтения" });
      a.ctl.setPermissions({ system_admin: false, features: { dict_element_shapes: "write" } });
      a.setValue(a.$("#v2-object"), String(Number(a.$("#v2-object").value) === 1 ? 2 : 1));
      await waitFor(() => a.$(`${NAV}[data-section="marker-shapes"]`), { what: "экран виден при праве записи" });
    },
  },
];

// Редактор цветов («Цвета зон» объекта, «Цвета статусов»): CE-*. Стенд — фейковый бэкенд.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const puts = (a, p) => a.ctl.log.filter((e) => e.method === "PUT" && e.path.startsWith(p));
const inputs = (a) => a.$$("#ce-body input[type=color]");
const otherObject = (a) => { const sel = a.$("#v2-object"); return [...sel.options].map((o) => Number(o.value)).find((v) => v && v !== Number(sel.value)); };
async function open(a, id = "zone-colors") {
  await waitFor(() => a.$(`${NAV}[data-section="${id}"]`), { what: `навигация ${id}` });
  a.click(a.$(`${NAV}[data-section="${id}"]`));
  await waitFor(() => inputs(a).length > 0, { what: `экран ${id}` });
}
const setColor = (a, i, v) => a.setValue(inputs(a)[i], v);

export const tests = [
  {
    id: "CE-01", title: "Цвета зон: правка одной строки → PUT только с изменённой строкой и id объекта из шапки; повторное чтение подтверждает",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const oid = Number(a.$("#v2-object").value);
      t.eq(inputs(a).length, 2, "два крана из ответа сервера");
      t.ok(a.$("#ce-save").disabled, "«Сохранить» недоступна, пока правки нет");
      setColor(a, 0, "#112233");
      await waitFor(() => !a.$("#ce-save").disabled, { what: "кнопка сохранения" });
      t.has(a.$("#ce-body").textContent, "изменено", "изменённая строка помечена");
      t.has(a.$("#ce-save").textContent, "(1)", "на кнопке число изменённых строк");
      a.click(a.$("#ce-save"));
      await waitFor(() => /подтверждено чтением: 1/.test(a.$("#ce-status").textContent), { what: "подтверждение чтением" });
      const put = puts(a, "/zone-colors")[0];
      t.eq(put.path, `/zone-colors?object_id=${oid}`, "объект из шапки");
      t.eq(put.body, [{ name: "Кран 1", color: "#112233" }], "в теле только изменённая строка");
      t.eq(a.ctl.data.settings.zoneColors[oid].find((r) => r.name === "Кран 1").color, "#112233", "сервер хранит новый цвет");
      t.eq(a.ctl.data.settings.zoneColors[oid].find((r) => r.name === "Кран 2").color, "#1f8a4c", "второй кран не тронут");
      t.eq(puts(a, "/zone-colors").length, 1, "ровно один PUT");
    },
  },
  {
    id: "CE-02", title: "Цвета статусов: тело — объект только с изменёнными статусами",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a, "status-colors");
      setColor(a, 0, "#010203");
      setColor(a, 2, "#040506");
      await waitFor(() => /\(2\)/.test(a.$("#ce-save").textContent), { what: "две правки" });
      a.click(a.$("#ce-save"));
      await waitFor(() => /подтверждено чтением: 2/.test(a.$("#ce-status").textContent), { what: "подтверждение" });
      const body = puts(a, "/status-colors")[0].body;
      t.eq(Object.keys(body).length, 2, "в теле два статуса из трёх");
      t.eq(Object.values(body).sort(), ["#010203", "#040506"], "значения — введённые цвета");
    },
  },
  {
    id: "CE-03", title: "Сбой сервера: без автоповтора, правка остаётся, ложного успеха нет; повтор вручную проходит",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, 1, "#778899");
      a.ctl.failNext("PUT /zone-colors", { status: 500, detail: "Сбой (QA)" });
      a.click(a.$("#ce-save"));
      await waitFor(() => /не подтверждены|Неизвестно/.test(a.$("#ce-status").textContent), { what: "сообщение о сбое" });
      t.eq(puts(a, "/zone-colors").length, 1, "запись не повторялась автоматически");
      t.ok(!/Сохранено/.test(a.$("#ce-status").textContent), "ложного успеха нет");
      t.eq(inputs(a)[1].value, "#778899", "выбранный цвет остался");
      t.ok(!a.$("#ce-save").disabled, "можно повторить вручную");
      a.click(a.$("#ce-save"));
      await waitFor(() => /подтверждено чтением/.test(a.$("#ce-status").textContent), { what: "повтор" });
    },
  },
  {
    id: "CE-04", title: "Двойной клик «Сохранить»: один запрос; на время записи всё заблокировано",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      setColor(a, 0, "#0a0b0c");
      const hold = a.ctl.hold("PUT /zone-colors");
      a.click(a.$("#ce-save"));
      await waitFor(() => a.$("#ce-save").disabled && inputs(a).every((i) => i.disabled), { what: "блокировка" });
      t.eq(a.click(a.$("#ce-save")), false, "второй клик невозможен");
      t.ok(a.$("#v2-back-btn").disabled, "переход в V1 заблокирован, пока идёт запись");
      hold.release();
      await waitFor(() => /подтверждено чтением/.test(a.$("#ce-status").textContent), { what: "сохранено" });
      t.eq(puts(a, "/zone-colors").length, 1, "ровно один PUT");
      hold.dispose?.();
    },
  },
  {
    id: "CE-05", title: "Отмена правки ничего не пишет; смена объекта при несохранённой правке: «Остаться» / «Сохранить» (запись ТОГО объекта) / «Не сохранять»",
    async run(t) {
      const a = await openApp({ home: true });
      await open(a);
      const A = Number(a.$("#v2-object").value);
      const B = otherObject(a);
      setColor(a, 0, "#abcdef");
      a.click(a.$("#ce-revert"));
      await waitFor(() => a.$("#ce-save").disabled, { what: "правка отменена" });
      t.eq(inputs(a)[0].value, "#c0392b", "цвет вернулся к сохранённому");
      t.eq(puts(a, "/zone-colors").length, 0, "отмена ничего не записала");
      setColor(a, 0, "#abcdef");
      a.setValue(a.$("#v2-object"), String(B));
      await waitFor(() => a.dialog(), { what: "диалог несохранённого" });
      await a.answerDialog("Остаться");
      t.eq(Number(a.$("#v2-object").value), A, "выбор в шапке вернулся");
      t.eq(inputs(a)[0].value, "#abcdef", "правка сохранена");
      a.setValue(a.$("#v2-object"), String(B));
      await a.answerDialog("Сохранить и продолжить");
      await waitFor(() => a.ctl.log.some((e) => e.method === "GET" && e.path === `/zone-colors?object_id=${B}`), { what: "экран под новым объектом" });
      t.eq(puts(a, "/zone-colors")[0].path, `/zone-colors?object_id=${A}`, "записан ПРЕЖНИЙ объект");
      await waitFor(() => inputs(a).length === 2 && !a.$("#ce-body").textContent.includes("изменено"), { what: "данные нового объекта" });
      setColor(a, 1, "#fedcba");
      a.setValue(a.$("#v2-object"), String(A));
      await a.answerDialog("Не сохранять");
      await waitFor(() => inputs(a)[0]?.value === "#abcdef", { what: "данные прежнего объекта" });
      t.eq(puts(a, "/zone-colors").length, 1, "«Не сохранять» ничего не записало");
    },
  },
];

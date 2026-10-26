// Проверка выравнивания элементов в строках интерфейса (обязательно перед тем, как сказать «готово» про любую правку вёрстки).
//
// Как пользоваться: вставить ТЕЛО файла в javascript_tool Браузера на странице, которую правили (раскрыв нужные закладки и формы), и вызвать
//     alignAudit(document.querySelector("#нужный-блок") || document.body)
// Вернёт список «строк», где соседние элементы одной линии стоят не на одной оси: по центру (align-items: center), по нижнему краю (flex-end) или
// по верхнему (flex-start) — в зависимости от того, как задан контейнер. Пустой список = выравнивание в порядке. Дополнительно ОБЯЗАТЕЛЬНО посмотреть
// скриншот на 2560×1440 и на 1440×900: инструмент не видит подпись, стоящую над полем там, где остальные стоят слева.
function alignAudit(root, tolerance = 2.5) {
  const bad = [];
  // Подпись-обёртка (<label>) с полем внутри сравнивается ПО САМОМУ ПОЛЮ: подпись над полем сдвигает поле ниже соседней кнопки, хотя рамки обёрток стоят ровно.
  // Флажок и переключатель внутри подписи не сравниваются сами (у них свой отступ под первую строку текста): сравнивается вся подпись целиком.
  const probe = (k) => {
    if (!k.matches("label")) return k;
    const control = k.querySelector("select, input:not([type=hidden]), textarea, button");
    return control && !["checkbox", "radio"].includes(control.type) ? control : k;
  };
  [root, ...root.querySelectorAll("*")].forEach((c) => {
    const cs = getComputedStyle(c);
    if (!["flex", "inline-flex"].includes(cs.display) || cs.flexDirection.startsWith("column")) return;
    const kids = [...c.children].filter((k) => getComputedStyle(k).display !== "none" && k.getBoundingClientRect().height > 0);
    const lines = [];
    kids.forEach((k) => {
      const r = k.getBoundingClientRect();
      let l = lines.find((L) => r.top < L.bottom - 2 && r.bottom > L.top + 2);
      if (!l) { l = { top: r.top, bottom: r.bottom, items: [] }; lines.push(l); }
      l.items.push(k); l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom);
    });
    lines.forEach((L) => {
      if (L.items.length < 2) return;
      const mode = cs.alignItems;
      const vals = L.items.map((k) => { const r = probe(k).getBoundingClientRect(); return mode === "flex-end" ? r.bottom : mode === "flex-start" || mode === "normal" || mode === "stretch" ? r.top : r.top + r.height / 2; });
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread > tolerance) bad.push({ container: `${c.tagName}.${String(c.className).slice(0, 40)}`, alignItems: mode, spread: Math.round(spread * 10) / 10,
        items: L.items.map((k) => `${k.tagName}:${(k.innerText || k.id || "").slice(0, 16).replace(/\n/g, " ")}`) });
    });
  });
  return bad;
}

// АРМ комплектовщика: панели отбора (срезы «модель / контракт / Δ») и контрактов (остатки, разворот по маркам) — полный сценарий V1
// (app/static/app.js: renderPickerBlock, pickerSortRows, renderPickerContracts, buildContractMarkRows, buildNoContractMarkRows).
//
// Числа считает движок V1 в кадре (embed-bridge.js: pickerModel — теми же функциями pickerElementPasses / pickerContractedFor / позициями
// contractLineTotals), эта панель только показывает модель и посылает команды выбора; своей копии отбора не ведёт.
//
// Что здесь сверх прежней панели V2 (перенесено из V1):
//  * заголовки колонок среза («значение», «модель», «контракт», «Δ») сортируют блок; первый щелчок по числовой колонке — по убыванию, повторный —
//    в обратном порядке; черта «нет в текущем срезе» делит два вопроса, поэтому сортируется КАЖДАЯ половина отдельно;
//  * блоки «Тип» и «Марка»: где «законтрактовано» бывает, но при суженном срезе недоступно, — прямо написано «не в этом разрезе», а не молча пропадают колонки;
//  * контракт разворачивается по маркам: закуплено / привязано / остаток по каждой позиции (по алфавиту); красным — привязки мимо спецификации
//    и сверх количества; клик по позиции добавляет марку и её контракт в срез; «без контракта» разворачивается по маркам так же;
//  * две ссылки сброса: «сбросить контракты» и «сбросить позиции» (марки и типы, выбранные кликами по позициям);
//  * оговорка «привязано и остаток — внутри выбранного среза», строка-ответ подсветки несвязанных («подсвечено N» / «подсвечивать нечего»).
const CONTRACTED_KEYS = new Set(["elementType", "mark"]);          // блоки, где у строки бывают числа контракта
const ROWS_LIMIT = 150;

export function createPickerPanels({ esc, nf, send, ui, getPk, loadingHtml, sw }) {
  const sort = new Map();                 // ключ блока -> {col: "label"|"count"|"contracted"|"diff", dir: 1|-1}
  const expanded = new Set();             // id контрактов и «none» — развёрнуты по маркам
  const remCls = (n) => (n > 0 ? "ws-pos" : n < 0 ? "ws-neg" : "");
  const arrow = (key, col) => { const s = sort.get(key); const on = (s ? s.col : "label") === col; return on ? (s && s.dir === -1 ? " ↓" : " ↑") : ""; };
  const head = (key, col, text, extra = "") => `<button type="button" class="ws-pkhead${(sort.get(key)?.col ?? "label") === col ? " on" : ""}${extra}" data-pk-sort="${esc(key)}|${col}" title="Сортировать по колонке «${esc(text)}»">${esc(text)}${arrow(key, col)}</button>`;

  // Порядок строк одной половины блока: по подписи (как прислал движок — числовые значения как числа) либо по числу колонки
  function sortRows(rows, key) {
    const s = sort.get(key);
    if (!s || s.col === "label") return s && s.dir === -1 ? rows.slice().reverse() : rows;
    const num = (r) => (s.col === "diff" ? (r.contracted ?? 0) - r.count : Number(r[s.col]) || 0);
    return rows.slice().sort((a, b) => (num(a) - num(b)) * s.dir || String(a.label).localeCompare(String(b.label), "ru", { numeric: true }));
  }

  function pickHtml() {
    const pk = getPk();
    if (!pk) return loadingHtml();
    const headRow = `<div class="ws-fhead"><span>В срезе: ${nf(pk.base)} из ${nf(ui.total())}</span><button type="button" class="v2-btn" data-pk-clear="" ${pk.selectionActive || pk.contractSelected ? "" : "disabled"}>Сбросить всё</button></div>`;
    return headRow + pk.slicers.map((g) => {
      const id = `pk:${g.key}`;
      const open = ui.openGroups.has(id) || (g.selected > 0 && !ui.closedGroups.has(id));
      const q = (ui.groupSearch.get(id) || "").toLowerCase();
      const rows = g.rows.filter((r) => !q || r.label.toLowerCase().includes(q));
      const avail = sortRows(rows.filter((r) => r.available), g.key), other = sortRows(rows.filter((r) => !r.available), g.key);
      const shown = [...avail, ...other].slice(0, ROWS_LIMIT);
      const rowHtml = (r) => `<label class="ws-check ws-pkrow${r.available ? "" : " ws-dim"}"><input type="checkbox" data-pk="${esc(g.key)}" data-v="${esc(JSON.stringify(r.v))}" ${r.on ? "checked" : ""}> <span>${esc(r.label)}</span><em>${nf(r.count)}</em>${g.contractedShown ? `<em class="ws-pkc">${nf(r.contracted)}</em><em class="${remCls(r.contracted - r.count)}">${r.contracted - r.count > 0 ? "+" : ""}${nf(r.contracted - r.count)}</em>` : ""}</label>`;
      let list = "", sepDone = false;
      for (const [i, r] of shown.entries()) {
        if (!sepDone && i >= avail.length && other.length && avail.length) { list += `<div class="ws-sep">нет в текущем срезе</div>`; sepDone = true; }
        list += rowHtml(r);
      }
      const notInSlice = CONTRACTED_KEYS.has(g.key) && !g.contractedShown
        ? `<p class="v2-muted ws-fnote" title="У позиции контракта есть только тип элемента и марка: по подтипу, крану, стоянке, этажу и показателю она не делится">законтрактовано — не в этом разрезе${pk.metricsSelected ? (pk.metricsSelected > 1 ? " (выбраны показатели)" : " (выбран показатель)") : ""}</p>` : "";
      const body = !open ? "" : `<div class="ws-fbody">
        ${g.rows.length > 12 ? `<input type="search" class="ws-fsearch" data-search="${esc(id)}" placeholder="Найти…" value="${esc(ui.groupSearch.get(id) || "")}" aria-label="Найти в срезе «${esc(g.title)}»">` : ""}
        ${notInSlice}
        <div class="ws-pkcols"><span>${head(g.key, "label", "значение")}</span><em>${head(g.key, "count", "модель")}</em>${g.contractedShown ? `<em class="ws-pkc">${head(g.key, "contracted", "контракт")}</em><em>${head(g.key, "diff", "Δ")}</em>` : ""}</div>
        ${list || `<p class="v2-muted">Нет значений</p>`}
        ${rows.length > shown.length ? `<p class="v2-muted ws-fnote">Показаны первые ${ROWS_LIMIT} из ${rows.length}. Уточните поиск.</p>` : ""}</div>`;
      return `<section class="ws-fgroup"><button type="button" class="ws-fh" data-pkgroup="${esc(id)}" aria-expanded="${open}"><span>${open ? "▾" : "▸"} ${esc(g.title)}</span>${g.selected ? `<b class="ws-badge">выбрано: ${g.selected}</b>` : ""}</button>${body}</section>`;
    }).join("");
  }

  // Позиции контракта по маркам (разворот)
  function markRowsHtml(c) {
    if (!c.lines.length) return `<p class="v2-muted ws-fnote" style="padding-left:30px">позиций нет</p>`;
    return c.lines.map((l, i) => {
      const title = l.orphan ? `Марки «${l.label}» нет в спецификации контракта, а изделий на него привязано: ${l.linked}. Заведите позицию в спецификации либо переназначьте изделия`
        : l.remainder < 0 ? `Привязано больше, чем закуплено: по спецификации ${l.total}, привязано ${l.linked}`
        : l.remainder > 0 ? `Нераспределённых позиций: ${l.remainder} — непривязанные изделия этой марки подсвечиваются на схеме («Подсветить несвязанные»)` : l.label;
      return `<button type="button" class="ws-crow ws-mrow${l.on ? " on" : ""}${l.over ? " over" : ""}" data-pkml="${c.id}|${i}" aria-pressed="${l.on}" title="${esc(title)}"><span>${esc(l.label)}</span><em>${l.orphan ? "—" : nf(l.total)}</em><em>${nf(l.linked)}</em><em class="${l.orphan ? "" : remCls(l.remainder)}">${l.orphan ? "—" : nf(l.remainder)}</em></button>`;
    }).join("");
  }

  function contractsHtml() {
    const pk = getPk();
    if (!pk) return loadingHtml();
    const onlyRem = ui.onlyRemainder();
    // Замена поставщика и обмен привязками — документы ПЕРЕПРИВЯЗКИ контракта (не «смена планируемого поставщика»: такой сущности в модели данных нет)
    const docs = `<p class="v2-muted ws-fnote ws-pad">Перепривязка контракта у уже привязанных изделий (замена поставщика, обмен привязками) оформляется документом: <a href="#/supplier-change">Документы контрактации</a>. Изделия без контракта привязывает вкладка «Распределение».</p>`;
    const groups = pk.contracts.map((g) => ({ ...g, rows: onlyRem ? g.rows.filter((r) => r.on || r.remainder !== 0) : g.rows })).filter((g) => g.rows.length);
    const tools = `<div class="ws-pad ws-pk-tools"><button type="button" class="v2-btn" data-pkhl="1" aria-pressed="${pk.highlightUnlinked}" title="Показать на схеме изделия без контракта: при выбранном (или развёрнутом) контракте — только те, чью марку он ещё не добрал; иначе — все несвязанные изделия среза">${pk.highlightUnlinked ? "Подсветка несвязанных включена" : "Подсветить несвязанные"}</button>
      <button type="button" class="v2-btn" data-pkrem="1" aria-pressed="${onlyRem}" title="Скрыть контракты, у которых остаток (всего минус привязано) равен нулю — закупать по ним больше нечего">${onlyRem ? "Показаны только с остатком" : "Показать только с остатком"}</button>
      ${pk.contractSelected ? `<button type="button" class="v2-link-btn" data-pk-clear="contract" title="Снять отбор по контрактам">сбросить контракты (${pk.contractSelected})</button>` : ""}
      ${pk.positionSelected ? `<button type="button" class="v2-link-btn" data-pk-clearpos="1" title="Снять выбор марок и типов, сделанный кликами по позициям контрактов; отбор по самим контрактам останется">сбросить позиции (${pk.positionSelected})</button>` : ""}</div>`;
    const notes = (pk.narrowed ? `<p class="v2-muted ws-fnote ws-pad" title="«Всего» — число из позиций контракта, оно от среза не зависит. «Привязано» считается по изделиям, прошедшим остальные срезы, поэтому и остаток относится к срезу, а не ко всему объекту">«привязано» и «остаток» — внутри выбранного среза</p>` : "")
      + (pk.highlightUnlinked ? `<p class="v2-muted ws-fnote ws-pad" role="status">${pk.highlightCount ? `подсвечено ${nf(pk.highlightCount)} изделий без контракта` : "подсвечивать нечего: несвязанных изделий в этом срезе нет"}</p>` : "");
    if (!groups.length && !pk.unlinked && !pk.unlinkedOn) return docs + tools + notes + `<p class="v2-muted ws-pad">${pk.contracts.length ? "Нет контрактов с остатком." : "У объекта нет контрактов."}</p>`;
    const cols = `<div class="ws-pkcols ws-pkcols-c"><span></span><em>всего</em><em>привязано</em><em>остаток</em></div>`;
    const exp = (id, open) => `<button type="button" class="ws-cex" data-pk-exp="${id}" aria-expanded="${open}" title="${open ? "Свернуть позиции" : "Показать позиции по маркам"}">${open ? "▾" : "▸"}</button>`;
    let html = docs + tools + notes + `<div class="ws-fbody">${cols}`;
    for (const g of groups) {
      const ids = g.rows.map((r) => r.id), all = ids.length && g.rows.every((r) => r.on);
      html += `<div class="ws-cgroup${g.inSlice ? "" : " ws-dim"}"><button type="button" class="ws-crow ws-chead${all ? " on" : ""}${g.over ? " over" : ""}" data-pkgrp="${ids.join(",")}" data-on="${all ? 0 : 1}" title="${g.over ? "У контрактов контрагента есть привязки мимо спецификации или сверх количества" : "Выбрать все контракты контрагента"}"><span>${esc(g.name)}</span><em>${nf(g.total)}</em><em>${nf(g.linked)}</em><em class="${remCls(g.total - g.linked)}">${nf(g.total - g.linked)}</em></button>`;
      for (const r of g.rows) {
        const open = expanded.has(r.id);
        html += `<div class="ws-crowline">${exp(r.id, open)}<button type="button" class="ws-crow ws-cnest${r.on ? " on" : ""}${r.inSlice ? "" : " ws-dim"}${r.over ? " over" : ""}" data-pkc="${r.id}" aria-pressed="${r.on}" title="${esc(r.over ? r.name + "\nЕсть привязки мимо спецификации или сверх количества — разверните позиции, красные строки" : r.name)}"><span>${esc(r.label)}</span><em>${nf(r.total)}</em><em>${nf(r.linked)}</em><em class="${remCls(r.remainder)}">${nf(r.remainder)}</em></button></div>${open ? markRowsHtml(r) : ""}`;
      }
      html += `</div>`;
    }
    if (pk.unlinked || pk.unlinkedOn) {
      const open = expanded.has("none");
      html += `<div class="ws-cgroup"><button type="button" class="ws-crow ws-chead${pk.unlinkedOn ? " on" : ""}" data-pkn="1" aria-pressed="${pk.unlinkedOn}"><span>— Без контрагента —</span><em>—</em><em>${nf(pk.unlinked)}</em><em>—</em></button>
        <div class="ws-crowline">${exp("none", open)}<button type="button" class="ws-crow ws-cnest${pk.unlinkedOn ? " on" : ""}" data-pkn="1" aria-pressed="${pk.unlinkedOn}"><span>— без контракта —</span><em>—</em><em>${nf(pk.unlinked)}</em><em>—</em></button></div>
        ${open ? (pk.noneMarks.length ? pk.noneMarks.map((m, i) => `<button type="button" class="ws-crow ws-mrow${m.on ? " on" : ""}" data-pkmn="${i}" aria-pressed="${m.on}"><span>${esc(m.label)}</span><em>—</em><em>${nf(m.n)}</em><em>—</em></button>`).join("") : `<p class="v2-muted ws-fnote" style="padding-left:30px">в срезе нет изделий без контракта</p>`) : ""}</div>`;
    }
    return html + `</div>`;
  }

  // Привязка событий новых элементов; прежние (data-pk, data-pkc, data-pkgrp, data-pkn, data-pkhl, data-pkrem, data-pk-clear) вешает workspace.js
  function bind(body) {
    const pk = getPk();
    body.querySelectorAll("[data-pk-sort]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      const [key, col] = b.dataset.pkSort.split("|");
      const cur = sort.get(key);
      if (cur && cur.col === col) cur.dir = -cur.dir; else sort.set(key, { col, dir: col === "label" ? 1 : -1 });
      ui.repaint();
    }));
    body.querySelectorAll("[data-pk-exp]").forEach((b) => b.addEventListener("click", () => {
      const raw = b.dataset.pkExp, id = raw === "none" ? "none" : Number(raw);
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      ui.repaint();
    }));
    body.querySelectorAll("[data-pk-clearpos]").forEach((b) => b.addEventListener("click", () => { send("pickerClear", { key: "mark" }); send("pickerClear", { key: "elementType" }); }));
    // Клик по позиции контракта = «покажи изделия ЭТОЙ марки В ЭТОМ контракте»: в срез добавляются марка (или тип у позиции без марки) и сам контракт
    body.querySelectorAll("[data-pkml]").forEach((b) => b.addEventListener("click", () => {
      if (!pk) return;
      const [cid, i] = b.dataset.pkml.split("|").map(Number);
      const c = pk.contracts.flatMap((g) => g.rows).find((r) => r.id === cid), l = c?.lines[i];
      if (!l) return;
      const key = l.mark ? "mark" : (l.type ? "elementType" : null);
      if (!key) return;
      send("pickerToggle", { key, value: l.mark || l.type });
      if (!l.on) send("pickerSet", { key: "contract", values: [cid], on: true });
    }));
    body.querySelectorAll("[data-pkmn]").forEach((b) => b.addEventListener("click", () => {
      const m = pk?.noneMarks[Number(b.dataset.pkmn)];
      if (!m) return;
      const key = m.mark ? "mark" : (m.type ? "elementType" : null);
      if (!key) return;
      send("pickerToggle", { key, value: m.mark || m.type });
      if (!m.on) send("pickerSet", { key: "contract", values: [pk.noneValue], on: true });
    }));
  }

  return { pickHtml, contractsHtml, bind, sortState: sort, expanded };
}

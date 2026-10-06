// Выпадающий список с колонками (2026-10-06, запрос пользователя: в выборе контракта и марки балансировки поставки «количество изделий
// к балансировке табулируй вправо, чтобы цифры были как бы в колонках»). Родной <select> колонок не умеет — его выпадающий список рисует сама
// ОС, и выровнять в нём цифры можно только пробелами, которые «плывут» в пропорциональном шрифте.
//
// Подключается К УЖЕ СУЩЕСТВУЮЩЕМУ <select> (общий для нового и текущего интерфейсов): select остаётся источником правды — прячется, его
// <option>/<optgroup> читаются, выбор пишется обратно в select.value и сопровождается событием `change`, поэтому весь прежний код форм,
// слушающий select, работает без правок. Колонки задаются атрибутами:
//   select[data-cs-heads="К балансировке, изд.|Просрочено"]  — заголовки числовых колонок (через «|»);
//   option[data-main="Д-003 от …"]                            — основной текст строки (без чисел);
//   option[data-c="326|32"]                                   — значения числовых колонок (через «|»), выравниваются вправо.
// <optgroup label="…"> — подзаголовки групп (контрагент). Строка без data-main/data-c (например «— выберите —») показывается как есть.
// Список рисуется поверх страницы (position: fixed), поэтому не обрезается рамками окон и прокруткой.

const STYLE_ID = "zhbi-column-select-style";
const CSS = `
.zcs-wrap{display:block;position:relative;min-width:0}
.zcs-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;text-align:left;cursor:pointer;
  font:inherit;color:var(--ink,var(--color-text,inherit));background:var(--bg,var(--color-surface,#fff));
  border:1px solid color-mix(in srgb, var(--ink, var(--color-text, #302d29)) 42%, var(--bg, var(--color-surface, #fff)));border-radius:7px;padding:8px 10px;min-height:36px}
.zcs-btn:hover:not(:disabled){border-color:var(--accent,var(--color-primary,#0d4cd3))}
.zcs-btn:disabled{opacity:.6;cursor:default}
.zcs-btn span.zcs-cur{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zcs-btn .zcs-caret{flex:none;color:var(--muted,var(--color-text-muted,#6b7683));font-size:11px}
.zcs-pop{position:fixed;z-index:19500;box-sizing:border-box;max-height:min(60vh,420px);overflow:auto;background:var(--bg,var(--color-surface,#fff));
  color:var(--ink,var(--color-text,inherit));border:1px solid var(--line,var(--color-border,#c9d1dc));border-radius:10px;box-shadow:0 8px 28px rgb(0 0 0/.22);padding:4px 0}
.zcs-row{display:grid;align-items:baseline;column-gap:14px;padding:7px 12px;cursor:pointer;font-size:13px;line-height:1.3}
.zcs-row:hover,.zcs-row.zcs-active{background:var(--sel,var(--color-surface-2,#eef2f9))}
.zcs-row[aria-selected="true"]{font-weight:600;box-shadow:inset 3px 0 0 var(--accent,var(--color-primary,#0d4cd3))}
.zcs-row.zcs-off{opacity:.5;cursor:default}
.zcs-main{min-width:0;overflow-wrap:anywhere}
.zcs-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.zcs-head{position:sticky;top:0;background:var(--bg,var(--color-surface,#fff));font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  color:var(--muted,var(--color-text-muted,#6b7683));cursor:default;border-bottom:1px solid var(--line,var(--color-border,#dde3ec));z-index:1}
.zcs-head .zcs-num{white-space:normal;line-height:1.2}
.zcs-head:hover{background:var(--bg,var(--color-surface,#fff))}
.zcs-group{padding:8px 12px 3px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,var(--color-text-muted,#6b7683))}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

const parts = (v) => (v ? String(v).split("|") : []);
let openPop = null;   // одновременно открыт один список

function closePop(focusBtn) {
  if (!openPop) return;
  const { pop, btn, cleanup } = openPop;
  openPop = null;
  cleanup();
  pop.remove();
  btn.setAttribute("aria-expanded", "false");
  if (focusBtn) btn.focus();
}

export function attachColumnSelect(select) {
  if (!select || select._zcs) return select?._zcs;
  ensureStyle();
  const heads = parts(select.dataset.csHeads);
  const wrap = document.createElement("div");
  wrap.className = "zcs-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zcs-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = `<span class="zcs-cur"></span><span class="zcs-caret" aria-hidden="true">▾</span>`;
  wrap.append(btn);
  select.insertAdjacentElement("afterend", wrap);
  select.style.display = "none";

  // В закрытой кнопке — только основной текст (числа видны в списке и в подсказке): длинная подпись с числами в поле не помещается
  const full = () => select.options[select.selectedIndex]?.textContent || "";
  const label = () => select.options[select.selectedIndex]?.dataset.main || full();
  const sync = () => {
    btn.querySelector(".zcs-cur").textContent = label();
    btn.disabled = select.disabled;
    btn.title = full();
    const id = select.getAttribute("aria-label"); if (id) btn.setAttribute("aria-label", id);
  };
  sync();
  // select меняют извне (код форм перезаполняет options, выставляет value/disabled) — кнопка следует за ним
  const mo = new MutationObserver(sync);
  mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  select.addEventListener("change", sync);

  function rowsOf() {
    const rows = [];
    for (const ch of select.children) {
      if (ch.tagName === "OPTGROUP") {
        rows.push({ group: ch.label });
        for (const o of ch.children) rows.push({ opt: o });
      } else if (ch.tagName === "OPTION") rows.push({ opt: ch });
    }
    return rows;
  }

  function open() {
    if (select.disabled) return;
    closePop(false);
    const pop = document.createElement("div");
    pop.className = "zcs-pop";
    pop.setAttribute("role", "listbox");
    const numCols = heads.length;
    // Ширина числовых колонок ФИКСИРОВАНА и общая для всех строк: строка — своя сетка, и с `auto` каждая подгоняла бы колонки под свои числа.
    const grid = `minmax(0,1fr)${" 112px".repeat(numCols)}`;
    if (numCols) {
      const h = document.createElement("div");
      h.className = "zcs-row zcs-head";
      h.style.gridTemplateColumns = grid;
      h.innerHTML = `<span class="zcs-main"></span>${heads.map((t) => `<span class="zcs-num">${t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`).join("")}`;
      pop.append(h);
    }
    const items = [];
    for (const r of rowsOf()) {
      if (r.group !== undefined) {
        const g = document.createElement("div");
        g.className = "zcs-group";
        g.textContent = r.group;
        pop.append(g);
        continue;
      }
      const o = r.opt;
      const row = document.createElement("div");
      row.className = "zcs-row" + (o.disabled ? " zcs-off" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(o.value === select.value));
      row.style.gridTemplateColumns = grid;
      const nums = parts(o.dataset.c);
      const main = document.createElement("span");
      main.className = "zcs-main";
      main.textContent = o.dataset.main || o.textContent;
      row.append(main);
      for (let i = 0; i < numCols; i++) {
        const n = document.createElement("span");
        n.className = "zcs-num";
        n.textContent = nums[i] ?? "";
        row.append(n);
      }
      if (!o.disabled) {
        row.addEventListener("click", () => { choose(o.value); });
        items.push({ row, value: o.value });
      }
      pop.append(row);
    }
    document.body.append(pop);
    // положение: под кнопкой, ширина — по содержимому, но не уже кнопки и не шире экрана; не помещается справа — сдвигаем влево
    const place = () => {
      const b = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const width = Math.min(Math.max(b.width, 640), vw - 24);
      pop.style.width = width + "px";
      pop.style.left = Math.max(12, Math.min(b.left, vw - width - 12)) + "px";
      const below = vh - b.bottom - 12, above = b.top - 12;
      pop.style.top = pop.style.bottom = "";
      if (below >= 200 || below >= above) { pop.style.top = b.bottom + 4 + "px"; pop.style.maxHeight = Math.min(420, below) + "px"; }
      else { pop.style.bottom = vh - b.top + 4 + "px"; pop.style.maxHeight = Math.min(420, above) + "px"; }
    };
    place();

    let cur = Math.max(0, items.findIndex((i) => i.value === select.value));
    const mark = () => {
      items.forEach((i, k) => i.row.classList.toggle("zcs-active", k === cur));
      items[cur]?.row.scrollIntoView({ block: "nearest" });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePop(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(items.length - 1, cur + 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); mark(); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (items[cur]) choose(items[cur].value); }
      else if (e.key === "Tab") closePop(false);
    };
    const onDoc = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closePop(false); };
    // Прокрутка САМОГО списка его не закрывает (раньше закрывала: capture-слушатель ловил и её); прокрутка страницы или окна под ним
    // двигает список вслед за полем, а если поле ушло с экрана — закрывает
    const onScroll = (e) => {
      if (pop.contains(e.target)) return;
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > document.documentElement.clientHeight) closePop(false); else place();
    };
    const onMove = () => closePop(false);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onScroll, true);
    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onScroll, true);
    };
    openPop = { pop, btn, cleanup };
    btn.setAttribute("aria-expanded", "true");
    mark();
  }

  function choose(value) {
    closePop(true);
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  }

  btn.addEventListener("click", () => (openPop && openPop.btn === btn ? closePop(true) : open()));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
  });

  const api = {
    destroy() {
      if (openPop && openPop.btn === btn) closePop(false);
      mo.disconnect();
      select.removeEventListener("change", sync);
      wrap.remove();
      select.style.display = "";
      delete select._zcs;
    },
  };
  select._zcs = api;
  return api;
}

/** Закрыть открытый список колонок (форма перерисовалась под ним). */
export function closeColumnSelectPopup() { closePop(false); }

/** Снять колонки: вернуть родной select (форма сменила вид документа). */
export function detachColumnSelect(select) {
  select?._zcs?.destroy();
}

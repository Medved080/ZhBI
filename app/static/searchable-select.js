// Выпадающий список с поиском по набранному тексту — надстройка над обычным <select> (2026-10-26).
//
// Нужен там, где вариантов сотни (физлица для ролей проектной команды): листать «select» по алфавиту неудобно, а ФИО ищут по
// кусочку. Исходный <select> остаётся в разметке (скрытый) и остаётся единственным источником значения: форма продолжает читать
// его `value` и слушать его `input`/`change`, ничего в её коде менять не нужно. Выбор пункта пишет значение в select и
// отправляет оба события.
//
// Подключается одной строкой после того, как форма навесила свои обработчики: enhanceSearchableSelect(select).
// Один модуль на V1 (ленивый import() из app.js) и V2 — своя копия логики поиска не нужна.

const STYLE_ID = "ss-style";
const CSS = `
.ss-wrap { position: relative; display: block; min-width: 0; }
.ss-input { width: 100%; box-sizing: border-box; font: inherit; }
.ss-list { position: absolute; z-index: 1000; left: 0; right: 0; top: 100%; margin: 2px 0 0; padding: 2px 0; list-style: none;
  max-height: 260px; overflow: auto; background: var(--surface, #fff); color: var(--fg, inherit);
  border: 1px solid var(--border, #c8ccd0); border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.18); }
.ss-item { padding: 5px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-item[aria-selected="true"] { background: var(--accent-soft, #e3f1ea); }
.ss-item.ss-active { background: var(--accent, #1f7a52); color: #fff; }
.ss-empty { padding: 6px 10px; color: var(--muted, #6b7075); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

// «ё» и «е» в поиске равны, регистр не важен — так ищут люди, а не так лежит в справочнике.
const fold = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");

const MAX_SHOWN = 80;

export function enhanceSearchableSelect(select) {
  if (!select || select.dataset.ssDone) return null;
  select.dataset.ssDone = "1";
  ensureStyle();

  const options = () => [...select.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
  const labelOf = () => (select.selectedOptions[0]?.textContent || "").trim();

  const wrap = document.createElement("div");
  wrap.className = "ss-wrap";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ss-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  const aria = select.getAttribute("aria-label") || select.closest("label")?.textContent?.trim();
  if (aria) input.setAttribute("aria-label", aria);
  input.disabled = select.disabled;
  input.value = labelOf();
  input.placeholder = "Начните вводить ФИО";
  const list = document.createElement("ul");
  list.className = "ss-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  select.style.display = "none";
  select.after(wrap);
  wrap.append(input, list);

  let shown = [];
  let active = -1;
  let open = false;

  function paint(query) {
    const q = fold(query).trim();
    const all = options();
    // Пустое значение («— не назначен —») всегда первым: иначе снять назначение было бы нечем.
    const empty = all.filter((o) => o.value === "");
    const rest = all.filter((o) => o.value !== "" && (!q || fold(o.label).includes(q)));
    shown = [...empty, ...rest.slice(0, MAX_SHOWN)];
    list.innerHTML = "";
    shown.forEach((o, i) => {
      const li = document.createElement("li");
      li.className = "ss-item";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(o.value === select.value));
      li.textContent = o.label || "—";
      li.title = o.label;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    if (rest.length > MAX_SHOWN) {
      const more = document.createElement("li");
      more.className = "ss-empty";
      more.textContent = `Показаны первые ${MAX_SHOWN} из ${rest.length} — уточните запрос`;
      list.appendChild(more);
    } else if (!rest.length && q) {
      const none = document.createElement("li");
      none.className = "ss-empty";
      none.textContent = "Никого не найдено";
      list.appendChild(none);
    }
    setActive(q ? (rest.length ? empty.length : 0) : Math.max(0, shown.findIndex((o) => o.value === select.value)));
  }

  function setActive(i) {
    active = i;
    [...list.querySelectorAll(".ss-item")].forEach((li, k) => li.classList.toggle("ss-active", k === i));
    list.querySelectorAll(".ss-item")[i]?.scrollIntoView({ block: "nearest" });
  }

  function show(query) {
    paint(query);
    list.hidden = false;
    open = true;
    input.setAttribute("aria-expanded", "true");
  }

  function hide() {
    list.hidden = true;
    open = false;
    input.setAttribute("aria-expanded", "false");
    input.value = labelOf();   // недовведённый текст не остаётся в поле: показано всегда то, что реально выбрано
  }

  function choose(i) {
    const o = shown[i];
    if (!o) return;
    const changed = select.value !== o.value;
    select.value = o.value;
    hide();
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  input.addEventListener("focus", () => { input.select(); show(""); });
  input.addEventListener("click", () => { if (!open) { input.select(); show(""); } });
  input.addEventListener("input", () => show(input.value));
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { show(""); return; }
      const n = shown.length;
      if (n) setActive((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      if (open) { e.preventDefault(); choose(active); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); hide(); }
    }
  });

  return { input, refresh: () => { input.value = labelOf(); input.disabled = select.disabled; } };
}

// Удобство для форм: превратить все выпадающие списки, подходящие под селектор, внутри контейнера.
export function enhanceAll(root, selector) {
  root.querySelectorAll(selector).forEach((s) => enhanceSearchableSelect(s));
}

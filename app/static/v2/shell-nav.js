// Левая навигация оболочки V2 (2026-09-22, задача «shell»): три состояния (свёрнута/временно открыта/закреплена),
// регулировка ширины, поиск по всем доступным разделам, группы с сохранённым раскрытием. Экраны и группы — из
// реестра (registry.js), доступность — screenAllowed(); сам модуль ничего не знает про права и монтирование
// экранов, только показывает список и зовёт onOpen(key) при выборе пункта.
//
// Состояния и раскладка (см. Docs/v2-progress/shell.md §2-3 — обоснование выбора):
//  A. «collapsed» — узкая полоса ВСЕГДА участвует в раскладке (flex, фиксированная ширина NAV_COLLAPSED_WIDTH).
//  B. «temp»      — та же полоса продолжает резервировать место (раскладка НЕ меняется, схема НЕ пересчитывается
//                   лишний раз), а сама панель раскрывается АБСОЛЮТНЫМ позиционированием поверх содержимого.
//  C. «pinned»     — полоса меняет реальную ширину на ширину панели: содержимое подвинулось по-настоящему.
// И B, и C рисуются ОДНИМ и тем же деревом разметки (полное меню), различаются только `data-mode` на обёртке —
// это даёт бесплатное «не пересоздавать» при переключении между ними (просто меняется CSS, не содержимое).
import { svgIcon, pinFilledSvg } from "./icons.js";
import { hasExchangeOp } from "./exchange.js";
import { hasAdminScreen } from "./admin-screens.js";

// Стиль модуля — отдельным файлом (styles.css общий, правит параллельно другой исполнитель — не трогаем).
(() => {
  if (document.querySelector("link[data-shellnav-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/shell-nav.css"; l.setAttribute("data-shellnav-css", "1");
  document.head.appendChild(l);
})();

export const NAV_WIDTH_MIN = 220;
export const NAV_WIDTH_MAX = 380;
export const NAV_WIDTH_DEFAULT = 260;
export const NAV_COLLAPSED_WIDTH = 50;
// Ниже этой ширины окна закрепление не держит реальное место в раскладке (иначе схеме/таблицам с содержимым
// достаётся неприлично мало места) — сохранённое предпочтение «закреплена» никуда не девается, просто временно
// ведёт себя как «временно открыта» (совпадает с п.2в задания: «сохранённое предпочтение закрепления не стирай»).
const NARROW_WINDOW_PX = 980;
// Содержимому должно оставаться хоть сколько-то места даже при очень узком окне — сверх 220..380
// диапазон ширины панели дополнительно поджимается под текущее окно (без изменения СОХРАНЁННОГО предпочтения).
const CONTENT_RESERVE_PX = 420;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// «Экран реально открывается в V1» — то же самое правило, каким main.js выбирает mountScreenView (единственная
// ветка её большого if/else в openSection без своего монтирования в V2): экран не входит ни в один из специальных
// impl'ов ниже, ИЛИ входит, но без обязательного сопутствующего поля (несколько экранов в screens.json делят
// один impl, например "read", но реально открываются в V2, только когда при них есть свой блок конфигурации —
// `target.read`/`target.card`/`target.export`/… — экран «в разработке» без такого блока по факту попадает в
// тот же mountScreenView, несмотря на общий с рабочими "read"-экранами impl; проверено живьём — без сверки
// этих полей «График поставки (в разработке)» ошибочно считался бы перенесённым). Дублирует условие mountHome()
// (screen-view.js, там попроще — без сверки сопутствующих полей) — оба места размечают один и тот же список
// экранов одинаковым смыслом; разъехаться с openSection этот список может, только если появится НОВЫЙ impl без
// пары «своя ветка в openSection» + «своя строка здесь» — искать по этому комментарию.
export function screenOpensInV1(s) {
  if (s.impl.startsWith("module:")) return false;
  if (hasAdminScreen(s.adminExtra || s.impl)) return false; // ТА ЖЕ функция, что использует openSection — не приближение
  if (["workspace", "supplier-docs", "contracts-list", "schedule", "access-view"].includes(s.impl)) return false;
  if (s.impl === "export-form") return !s.export;
  if (s.impl === "exchange") return !hasExchangeOp(s.exchange); // ТА ЖЕ функция, что использует openSection
  if (s.impl === "dict-edit") return !s.edit;
  if (s.impl === "card-edit") return !s.card;
  if (s.impl === "notes-edit") return !s.notes;
  if (s.impl === "prefix-edit") return !s.prefix;
  if (s.impl === "color-edit") return !s.color;
  if (s.impl === "setting-edit") return !s.setting;
  if (s.impl === "revit-colors-edit") return !s.revit;
  if (s.impl === "shape-edit") return !s.shape;
  if (s.impl === "subtypes-edit") return !s.subtypes;
  if (s.impl.endsWith("-edit")) return false; // zones-edit/visibility-edit/fill-scope-edit/sessions-edit/…, blocks-edit/fact-journal-edit/… (МФР) — без сопутствующего поля, своё монтирование безусловно
  if (["db-transfer", "address-classifier"].includes(s.impl)) return false;
  if (s.impl === "read") return !s.read;
  if (["db-status-view", "admin-guide-view"].includes(s.impl)) return false;
  return true;
}

/** Значок пункта «Рабочие места» — по ws/impl, с нейтральным умолчанием (icons.js сам подставит "group"). */
function workIconName(s) {
  if (s.impl === "read" && s.id === "map") return "map";
  if (s.impl.endsWith("-edit") && s.id === "chess-flat") return "grid";
  if (s.ws === "model") return s.id === "element-ops" ? "checklist" : "cube";
  if (s.ws === "mfr") return "layers";
  if (s.ws === "picker") return "checklist";
  if (s.ws === "foreman") return "hardhat";
  return "group";
}

export function mountShellNav(el, {
  registry, allowedScreen, prefsStore, getCurrentKey, onOpen,
}) {
  el.id = el.id || "v2-side";
  el.classList.add("v2-shellnav");
  el.setAttribute("aria-label", "Разделы");

  let tempOpen = false;      // сеансовое — не переживает перезагрузку (в отличие от закрепления)
  let searchText = "";       // сеансовое
  let busy = false;          // идёт запись — переходы временно недоступны (см. main.js::syncPending)
  let dragging = false;
  // Кнопка, открывшая временную панель (её id, НЕ ссылка на DOM-узел — render() пересобирает всю разметку
  // целиком через innerHTML, и узел, на который открытие сослалось бы напрямую, к моменту закрытия уже удалён
  // из документа; .focus() на отсоединённом узле — молчаливый no-op, фокус остаётся неопределённым). Фокус
  // возвращается на неё же при закрытии.
  let lastTriggerId = "v2-shellnav-menu";

  function effectiveMaxWidth() {
    return Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, window.innerWidth - CONTENT_RESERVE_PX));
  }
  function narrow() { return window.innerWidth < NARROW_WINDOW_PX; }
  function mode() {
    if (tempOpen) return "temp";
    if (prefsStore.get().navPinned && !narrow()) return "pinned";
    return "collapsed";
  }
  function displayWidth() {
    return Math.min(prefsStore.get().navWidth, effectiveMaxWidth());
  }

  // ---- группы: «work» — короткий несворачиваемый блок сверху; «admin»/«settings»/«help» — визуально отделённый
  // нижний кластер; остальные — обычные сворачиваемые группы. Экран без совпадения ни в одном из списков
  // (гипотетически, если появится новая группа в screens.json) попадает в middle — безопасное умолчание.
  const BOTTOM_GROUPS = new Set(["admin", "settings", "help"]);
  function isGroupOpen(groupId, hasCurrent) {
    const state = prefsStore.get().navGroupState;
    if (Object.prototype.hasOwnProperty.call(state, groupId)) return state[groupId];
    return hasCurrent; // не тронуто пользователем — по умолчанию раскрыта ТОЛЬКО группа текущего экрана
  }

  function itemHtml(s, currentKey) {
    const active = s.id === currentKey;
    const v1 = screenOpensInV1(s);
    const hint = v1 ? ` <span class="v2-shellnav-hint" aria-hidden="true">↗</span>` : "";
    const title = v1 ? `${esc(s.title)} — откроется в текущем интерфейсе` : esc(s.title);
    return `<button type="button" class="v2-shellnav-item" data-section="${esc(s.id)}" aria-pressed="${active}" title="${title}">
      <span class="v2-shellnav-item-label">${esc(s.title)}</span>${hint}
    </button>`;
  }

  // ---- порядок и избранное пунктов ВНУТРИ группы (личная настройка, 2026-09-22, задача «пункт 4»). СВОИ данные
  // (`v2-shell-prefs`: item_order/favorites) — НЕ путать с `menuPrefs` V1 (панель «Действия», другой столбец, другой
  // формат). Порядок неполный — заведомо ЗАДАЁТ последовательность только известных ей пунктов (см. app/users.py:
  // set_v2_shell_prefs); пункты, которых в сохранённом порядке нет (новые в этой версии), остаются на исходном
  // месте — перед переставленными (тот же смысл, что у applyMenuPrefs() в V1, реализация своя).
  function applyOrder(items, order) {
    if (!order || !order.length) return items;
    const byId = new Map(items.map((s) => [s.id, s]));
    const known = order.filter((id) => byId.has(id));
    const listed = new Set(known);
    const rest = items.filter((s) => !listed.has(s.id));
    return [...rest, ...known.map((id) => byId.get(id))];
  }
  function groupItemsOf(groupId) {
    return registry.screens.filter((s) => s.group === groupId && allowedScreen(s));
  }
  // Избранные — отдельным блоком СВЕРХУ списка группы (п.4 задания); relative-порядок внутри каждого из двух
  // блоков (избранное/остальное) берётся из ОДНОГО общего `order` — блоки лишь РАЗДВИГАЮТ уже упорядоченный список.
  function splitFavorites(items) {
    const favSet = new Set(prefsStore.get().favorites);
    return { favs: items.filter((s) => favSet.has(s.id)), rest: items.filter((s) => !favSet.has(s.id)) };
  }
  function favBtnHtml(s) {
    const fav = prefsStore.isFavorite(s.id);
    return `<button type="button" class="v2-shellnav-fav" data-fav="${esc(s.id)}" aria-pressed="${fav}"
      title="${fav ? "Убрать из избранного" : "Добавить в избранное"}"
      aria-label="${fav ? `Убрать «${esc(s.title)}» из избранного` : `Добавить «${esc(s.title)}» в избранное`}">${fav ? "★" : "☆"}</button>`;
  }
  function moveBtnsHtml(groupId, s, isFirst, isLast) {
    return `<button type="button" class="v2-shellnav-move-btn" data-move="up" data-group="${esc(groupId)}" data-item="${esc(s.id)}"
        ${isFirst ? "disabled" : ""} title="Выше" aria-label="Переместить «${esc(s.title)}» выше">▲</button>
      <button type="button" class="v2-shellnav-move-btn" data-move="down" data-group="${esc(groupId)}" data-item="${esc(s.id)}"
        ${isLast ? "disabled" : ""} title="Ниже" aria-label="Переместить «${esc(s.title)}» ниже">▼</button>`;
  }
  // Строка пункта + инструменты (звёздочка, стрелки) — ОТДЕЛЬНЫЕ кнопки рядом с кнопкой перехода (не внутри нее:
  // кнопка в кнопке недопустима в HTML и ломает доступность). Только вне поиска — во время поиска список неполный
  // и переставлять/закреплять по нему было бы непонятно (см. render()).
  function itemRowHtml(s, currentKey, groupId, isFirst, isLast) {
    return `<div class="v2-shellnav-row">${itemHtml(s, currentKey)}<span class="v2-shellnav-tools">${favBtnHtml(s)}${moveBtnsHtml(groupId, s, isFirst, isLast)}</span></div>`;
  }
  function moveItem(groupId, itemId, dir) {
    const ordered = applyOrder(groupItemsOf(groupId), prefsStore.getItemOrder(groupId));
    const { favs, rest } = splitFavorites(ordered);
    const favSet = new Set(prefsStore.get().favorites);
    const arr = favSet.has(itemId) ? favs : rest;
    const idx = arr.findIndex((s) => s.id === itemId);
    const swapWith = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapWith < 0 || swapWith >= arr.length) return;
    [arr[idx], arr[swapWith]] = [arr[swapWith], arr[idx]];
    const newFull = favSet.has(itemId) ? [...arr, ...rest] : [...favs, ...arr];
    prefsStore.setItemOrder(groupId, newFull.map((s) => s.id));
  }

  function render() {
    const q = searchText.trim().toLowerCase();
    const currentKey = getCurrentKey();
    const allScreens = registry.screens.filter((s) => s.group !== "home" && allowedScreen(s));
    const byGroup = new Map();
    for (const s of allScreens) { if (!byGroup.has(s.group)) byGroup.set(s.group, []); byGroup.get(s.group).push(s); }
    const workItems = byGroup.get("work") || [];
    const middleGroups = registry.groups.filter((g) => g.id !== "home" && g.id !== "work" && !BOTTOM_GROUPS.has(g.id) && byGroup.has(g.id));
    const bottomGroups = registry.groups.filter((g) => BOTTOM_GROUPS.has(g.id) && byGroup.has(g.id));

    // ---- поиск: если запрос совпал с НАЗВАНИЕМ группы — показываем группу целиком (человек ищет область, а не
    // конкретный пункт); иначе — только пункты, чьё название совпало. Раскрытие групп при этом НЕ перезаписывается
    // (см. isGroupOpen выше): решение «раскрыть на время поиска» временное, из сохранённого состояния не читается
    // и в него не пишется.
    function visibleItems(items, groupTitle) {
      if (!q) return items;
      if (groupTitle.toLowerCase().includes(q)) return items;
      return items.filter((s) => s.title.toLowerCase().includes(q));
    }
    const workVisible = visibleItems(workItems, registry.groups.find((g) => g.id === "work")?.title || "");
    const anyMatch = !!(workVisible.length || middleGroups.some((g) => visibleItems(byGroup.get(g.id), g.title).length)
      || bottomGroups.some((g) => visibleItems(byGroup.get(g.id), g.title).length));

    const groupHtml = (g) => {
      // Порядок и избранное — только ВНЕ поиска: список результатов поиска и так неполный, переставлять его
      // по личной настройке было бы непонятно, а звёздочка/стрелки среди случайных совпадений — лишний шум.
      const ordered = q ? byGroup.get(g.id) : applyOrder(byGroup.get(g.id), prefsStore.getItemOrder(g.id));
      const items = visibleItems(ordered, g.title);
      if (q && !items.length) return "";
      const hasCurrent = byGroup.get(g.id).some((s) => s.id === currentKey);
      const open = !!q || isGroupOpen(g.id, hasCurrent);
      let body;
      if (q) {
        body = items.map((s) => itemHtml(s, currentKey)).join("");
      } else {
        const { favs, rest } = splitFavorites(items);
        const favBlock = favs.length ? `<div class="v2-shellnav-fav-block">${favs.map((s, i) => itemRowHtml(s, currentKey, g.id, i === 0, i === favs.length - 1)).join("")}</div>` : "";
        body = favBlock + rest.map((s, i) => itemRowHtml(s, currentKey, g.id, i === 0, i === rest.length - 1)).join("");
      }
      return `<div class="v2-shellnav-group">
        <button type="button" class="v2-shellnav-group-head" data-group="${esc(g.id)}" aria-expanded="${open}">
          <span class="v2-shellnav-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>${esc(g.title)}
        </button>
        ${open ? `<div class="v2-shellnav-group-body">${body}</div>` : ""}
      </div>`;
    };

    // ---- полное меню (общее для «temp» и «pinned»)
    const panel = `
      <div class="v2-shellnav-panelhead">
        <input type="search" id="v2-shellnav-search" class="v2-search v2-shellnav-search" placeholder="Найти раздел"
               aria-label="Найти раздел" value="${esc(searchText)}">
        <button type="button" class="v2-shellnav-pin" id="v2-shellnav-pin" aria-pressed="${prefsStore.get().navPinned}"
                title="${prefsStore.get().navPinned ? "Открепить панель" : "Закрепить панель слева"}">
          ${prefsStore.get().navPinned ? pinFilledSvg({ size: 15 }) : svgIcon("pin", { size: 15 })}
        </button>
      </div>
      <div class="v2-shellnav-scroll">
        <button type="button" class="v2-shellnav-item v2-shellnav-home" data-section="home" aria-pressed="${currentKey === "home"}">${svgIcon("home", { size: 15 })}<span class="v2-shellnav-item-label">Начало</span></button>
        ${workVisible.length ? `<div class="v2-shellnav-static-head">Рабочие места</div><div class="v2-shellnav-work">${workVisible.map((s) => itemHtml(s, currentKey)).join("")}</div>` : ""}
        ${middleGroups.map(groupHtml).join("")}
        ${bottomGroups.length ? `<div class="v2-shellnav-divider" role="separator"></div>${bottomGroups.map(groupHtml).join("")}` : ""}
        ${q && !anyMatch ? `<p class="v2-muted v2-shellnav-empty">Ничего не найдено по запросу.</p>` : ""}
      </div>`;

    // ---- свёрнутая полоса: меню, поиск, «Начало» и значки рабочих мест — НЕ все пункты (п.2а задания)
    const strip = `
      <button type="button" class="v2-shellnav-icon-btn" id="v2-shellnav-menu" data-tooltip="Меню разделов" aria-label="Открыть меню разделов" aria-expanded="${mode() !== "collapsed"}">${svgIcon("menu")}</button>
      <button type="button" class="v2-shellnav-icon-btn" id="v2-shellnav-search-btn" data-tooltip="Найти раздел" aria-label="Найти раздел">${svgIcon("search")}</button>
      <div class="v2-shellnav-divider" role="separator"></div>
      <button type="button" class="v2-shellnav-icon-btn" data-section="home" data-tooltip="Начало" aria-label="Начало" aria-pressed="${currentKey === "home"}">${svgIcon("home")}</button>
      ${workItems.map((s) => `<button type="button" class="v2-shellnav-icon-btn" data-section="${esc(s.id)}" data-tooltip="${esc(s.title)}" aria-label="${esc(s.title)}" aria-pressed="${s.id === currentKey}">${svgIcon(workIconName(s))}</button>`).join("")}`;

    const m = mode();
    const w = displayWidth();
    el.dataset.mode = m;
    el.style.setProperty("--shellnav-w", w + "px");
    el.innerHTML = `
      <div class="v2-shellnav-strip">${strip}</div>
      <div class="v2-shellnav-rail" role="region" aria-label="Разделы — полный список">${panel}</div>
      <div class="v2-shellnav-resize" id="v2-shellnav-resize" role="separator" aria-orientation="vertical"
           aria-label="Ширина левой панели" tabindex="0"
           aria-valuenow="${w}" aria-valuemin="${NAV_WIDTH_MIN}" aria-valuemax="${effectiveMaxWidth()}" ${m === "collapsed" ? "hidden" : ""}></div>`;
    bind();
  }

  // ---- закрытие временной панели: клик вне, Escape, успешный переход. Фокус — на кнопку «Меню», её открывшую
  // (или на текущую кнопку триггера, если панель открыта иначе — например, из значка рабочего места на полосе).
  function closeTemp(returnFocus = true) {
    if (!tempOpen) return;
    tempOpen = false;
    render();
    if (returnFocus) el.querySelector(`#${lastTriggerId}`)?.focus();
  }
  function openTemp(focusSearch, triggerId) {
    lastTriggerId = triggerId || "v2-shellnav-menu";
    tempOpen = true;
    render();
    if (focusSearch) el.querySelector("#v2-shellnav-search")?.focus();
  }

  function onOutsideClick(e) {
    if (!tempOpen) return;
    if (el.contains(e.target)) return;
    closeTemp(false); // клик вне — фокус пользователь и так уводит сам, дёргать его незачем
  }
  function onDocKeydown(e) {
    if (e.key === "Escape" && tempOpen) { e.preventDefault(); closeTemp(); }
  }
  document.addEventListener("pointerdown", onOutsideClick, true);
  document.addEventListener("keydown", onDocKeydown, true);

  async function activate(key, btn) {
    if (busy) return;
    const wasTemp = tempOpen;
    const ok = await onOpen(key);
    if (ok && wasTemp) closeTemp(false);
    else render(); // aria-pressed на кнопках должен отразить фактический итог, даже если переход отменён
  }

  function bind() {
    el.querySelector("#v2-shellnav-menu")?.addEventListener("click", () => {
      if (mode() === "pinned") return; // уже закреплена — сворачивать нечего, кнопка не должна прятать панель
      if (tempOpen) closeTemp(); else openTemp(false, "v2-shellnav-menu");
    });
    el.querySelector("#v2-shellnav-search-btn")?.addEventListener("click", () => {
      if (mode() === "pinned") { el.querySelector("#v2-shellnav-search")?.focus(); return; }
      openTemp(true, "v2-shellnav-search-btn");
    });
    el.querySelectorAll("[data-section]").forEach((b) => b.addEventListener("click", (e) => activate(b.dataset.section, e.currentTarget)));
    el.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.group;
      // Явный клик пользователя — инвертируем то, что СЕЙЧАС нарисовано (открыта/закрыта), а не пересчитываем
      // расчётное умолчание заново: до этого клика группа могла быть раскрыта именно по умолчанию (текущий
      // экран внутри неё), а не по сохранённой настройке — после клика её состояние становится явным в любом случае.
      const open = b.getAttribute("aria-expanded") === "true";
      prefsStore.setGroupOpen(id, !open);
      render();
      el.querySelector(`[data-group="${id}"]`)?.focus();
    }));
    el.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.fav;
      prefsStore.toggleFavorite(id);
      render();
      // Тот же приём, что у поиска/разделителя ширины ниже: render() пересобирает разметку через innerHTML,
      // старый узел кнопки отсоединяется — фокус возвращаем на СВЕЖИЙ узел того же пункта, иначе повторное
      // Tab-перемещение звёздочками подряд требовало бы каждый раз заново перетабляться от начала списка.
      el.querySelector(`[data-fav="${CSS.escape(id)}"]`)?.focus();
    }));
    el.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const { group, item, move } = b.dataset;
      moveItem(group, item, move);
      render();
      // Кнопка того же направления могла стать disabled (пункт дошёл до края своего блока) — в этом случае
      // фокус уходит на противоположную стрелку ТОГО ЖЕ пункта (она гарантированно осталась включённой, если
      // в блоке больше одного пункта), а не теряется молча.
      let btn = el.querySelector(`[data-move="${move}"][data-group="${CSS.escape(group)}"][data-item="${CSS.escape(item)}"]`);
      if (!btn || btn.disabled) btn = el.querySelector(`[data-move="${move === "up" ? "down" : "up"}"][data-group="${CSS.escape(group)}"][data-item="${CSS.escape(item)}"]`);
      btn?.focus();
    }));
    const search = el.querySelector("#v2-shellnav-search");
    if (search) {
      search.addEventListener("input", () => {
        searchText = search.value;
        const pos = search.selectionStart;
        render();
        const s2 = el.querySelector("#v2-shellnav-search");
        if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } }
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (searchText) { searchText = ""; render(); el.querySelector("#v2-shellnav-search")?.focus(); }
          else closeTemp();
        }
      });
    }
    el.querySelector("#v2-shellnav-pin")?.addEventListener("click", () => {
      const now = !prefsStore.get().navPinned;
      prefsStore.setNavPinned(now);
      if (now) tempOpen = false; // закрепление уже держит панель открытой — временный флаг больше не нужен
      render();
    });
    bindResize();
  }

  // ---- ширина: перетаскивание (мышь) и клавиатура (стрелки/Home/End), двойной клик — сброс к 260px. Тот же
  // приём, что у правой панели рабочего места (workspace.js::rz) — pointer capture + iframe.pointerEvents="none"
  // на время драга: указатель не должен теряться, если курсор окажется над кадром схемы В1.
  function bindResize() {
    const rz = el.querySelector("#v2-shellnav-resize");
    if (!rz) return;
    function applyLiveWidth(px) {
      const w = Math.max(NAV_WIDTH_MIN, Math.min(effectiveMaxWidth(), Math.round(px)));
      el.style.setProperty("--shellnav-w", w + "px");
      rz.setAttribute("aria-valuenow", String(w));
      return w;
    }
    function setFrames(disabled) {
      document.querySelectorAll(".ws-frame").forEach((f) => { f.style.pointerEvents = disabled ? "none" : ""; });
    }
    rz.addEventListener("pointerdown", (e) => {
      if (mode() === "collapsed") return;
      e.preventDefault();
      // preventDefault() выше нужен, чтобы драг не выделял текст страницы и не запускал нативный DnD — побочный
      // эффект: браузер обычно фокусирует элемент на mousedown/pointerdown САМ, но раз действие по умолчанию
      // отменено, этого не происходит (стандартное поведение, не баг браузера) — без явного focus() стрелки
      // клавиатурой не работали бы сразу после перетаскивания мышью, только после отдельного Tab (найдено
      // проверкой: R3.2-R3.4 в scripts/shell_verify/resize1.mjs).
      rz.focus();
      dragging = true;
      rz.setPointerCapture(e.pointerId);
      setFrames(true);
      document.body.classList.add("v2-noselect");
      const railLeft = () => el.getBoundingClientRect().left;
      const move = (ev) => applyLiveWidth(ev.clientX - railLeft());
      const up = () => {
        dragging = false;
        rz.removeEventListener("pointermove", move);
        rz.removeEventListener("pointerup", up);
        rz.removeEventListener("pointercancel", up);
        setFrames(false);
        document.body.classList.remove("v2-noselect");
        prefsStore.setNavWidth(Number(rz.getAttribute("aria-valuenow")) || NAV_WIDTH_DEFAULT);
      };
      rz.addEventListener("pointermove", move);
      rz.addEventListener("pointerup", up);
      rz.addEventListener("pointercancel", up);
    });
    // render() пересобирает всю разметку через innerHTML — новый узел разделителя рождается БЕЗ фокуса, хотя
    // старый им обладал; без явного возврата фокуса работала бы только ПЕРВАЯ стрелка (та же ловушка, что и с
    // lastTriggerId выше, и то же решение, что уже применено к полю поиска: перерисовать → перефокусировать
    // СВЕЖИЙ узел по id). Без этого клавиатурная регулировка ширины после первого нажатия переставала отвечать.
    function afterResize() { render(); el.querySelector("#v2-shellnav-resize")?.focus(); }
    rz.addEventListener("keydown", (e) => {
      const cur = prefsStore.get().navWidth;
      if (e.key === "ArrowLeft") { e.preventDefault(); prefsStore.setNavWidth(cur - 20); afterResize(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); prefsStore.setNavWidth(cur + 20); afterResize(); }
      else if (e.key === "Home") { e.preventDefault(); prefsStore.setNavWidth(NAV_WIDTH_MIN); afterResize(); }
      else if (e.key === "End") { e.preventDefault(); prefsStore.setNavWidth(effectiveMaxWidth()); afterResize(); }
    });
    rz.addEventListener("dblclick", () => { prefsStore.setNavWidth(NAV_WIDTH_DEFAULT); afterResize(); });
  }

  function onWinResize() {
    if (dragging) return; // во время своего же драга шире событие resize окна не приходит, но проверка не лишняя
    render();
  }
  window.addEventListener("resize", onWinResize);

  render();

  return {
    /** Перерисовать после внешнего изменения: сменился текущий экран (переход завершился) или доступные экраны
     * (сменился объект в шапке — allowedScreen считает права по нему заново). */
    render,
    setBusy(v) {
      busy = !!v;
      el.querySelectorAll("button, input").forEach((n) => { n.disabled = busy; });
      const rz = el.querySelector("#v2-shellnav-resize");
      if (rz) rz.tabIndex = busy ? -1 : 0;
    },
    destroy() {
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("pointerdown", onOutsideClick, true);
      document.removeEventListener("keydown", onDocKeydown, true);
    },
  };
}

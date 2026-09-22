// Экран «Карта проектов» (V2, задание «map», 2026-09-22) — настоящая интерактивная карта вместо таблицы
// координат (impl был "read"): метки, кластеризация, попап объекта, поиск/отбор, переход к рабочему месту.
//
// Переиспользует ГОТОВЫЙ модуль V1 целиком (app/static/map.js, 482 строки) — он уже спроектирован для
// повторного использования через инъекцию зависимостей (export function init(зависимости)), тем же приёмом,
// что и projects-objects.js для мини-карты формы объекта. Здесь НЕ повторяется ни строчки его бизнес-логики
// (кластеризация, цвет по доле смонтированного, всплывашка, геокодирование) — только своя разметка вокруг
// (список слева, отбор, легенда) в языке рабочих мест V2 (общие ws-* классы styles.css, тот же приём, что у
// workspace.js) и свои колбэки клика по точке.
//
// Подложка и геокодирование — ТОТ ЖЕ выключатель `/map/config`/«Карта из интернета», что и в V1: здесь
// ничего нового не включается и не может быть включено (сам модуль карты решает, идти ли наружу).
//
// Клик по точке/строке списка открывает попап map.js (карточка-сводка: превью, проект, объект, статус,
// описание, число изделий, доля смонтированного, сроки СМР — ровно то же, что видит V1 на том же backend).
// Его кнопка ведёт не на форму «Свойства объекта» (в V2 раздел «Проекты и объекты» открыт не всем ролям,
// а карта — SCOPE_SERVICE и видна всем), а меняет текущий объект и переводит на его рабочее место — ТОЙ ЖЕ
// функцией changeObject, что и кнопка выбора объекта в шапке (main.js), ради согласованности интерфейса.
//
// Ресурсы: у браузера считанные десятки WebGL-контекстов (правило проекта, CLAUDE.md) — карта уничтожается
// в destroy() (карта.remove()), а не просто теряет DOM-узел. Пока экран открыт, ResizeObserver на .ws-stage
// зовёт карта.resize() при каждом изменении его размера (сворачивание/раскрытие левой навигации, перетаскивание
// ручки между списком и картой) — БЕЗ пересоздания карты, тем же принципом, что и у сцены рабочих мест
// (app/static/app.js: ResizeObserver на #stage, а не событие resize окна).
import { esc } from "./screen-view.js";

(() => {
  if (document.querySelector('link[data-mp-css]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/map-screen.css"; l.setAttribute("data-mp-css", "1");
  document.head.appendChild(l);
})();

const STATUS_LABELS = {
  perspective: "Перспективный", active: "В работе", suspended: "Приостановлен",
  completed: "Завершён", archived: "Архивный",
};
// Тот же светофор по стадии, что и .v2-status-dot[data-dot] (styles.css) — но нужен ещё и СТРОКОЙ цвета:
// всплывашку строит map.js, ему нужен именно колбэк statusColor(status) -> "#rrggbb", а не CSS-класс.
const STATUS_COLORS = {
  active: "#2F9E44", perspective: "#4C6EF5", suspended: "#F08C00",
  completed: "#1971C2", archived: "#868E96",
};
// Цвет заливки точки по доле смонтированного — та же шкала, что в приватной цветПоДоле() внутри map.js
// (серое → оранжевое → жёлтое → зелёное): своей копии логики нет, только текст легенды рядом с картой.
const PERCENT_SCALE = [
  ["#9e9e9e", "нет данных / не начато"],
  ["#ef6c00", "начато"],
  ["#f9a825", "30–59 %"],
  ["#7cb342", "60–99 %"],
  ["#2e7d32", "100 %"],
];
function percentColor(percent) {
  if (percent === null || percent === undefined) return "#9e9e9e";
  if (percent >= 100) return "#2e7d32";
  if (percent >= 60) return "#7cb342";
  if (percent >= 30) return "#f9a825";
  if (percent > 0) return "#ef6c00";
  return "#9e9e9e";
}

// Объект какого учёта показать в каком рабочем месте — та же развилка, что и в main.js (переключение
// объекта между парными рабочими местами ЖБИ/МФР): чужой ws на «не применимо» openSection сам уводит на
// начальную страницу, поэтому проверять права здесь ещё раз не нужно.
function wsScreenIdFor(kind) { return kind === "mfr" ? "ws-mfr" : "ws-model"; }

// Сам МОДУЛЬ (файл) грузится один раз на вкладку — MapLibre весит под мегабайт, тянуть её на каждое
// монтирование незачем, тот же приём, что у projects-objects.js. А вот init(deps) внутри map.js держит
// ОБЩУЮ на всю страницу переменную (module-level `deps`), не свою на каждого вызывающего: «Проекты и
// объекты» дёргают тот же импорт СВОИМ независимым кэшем и передают туда только `api` (им хватает для
// мини-карты пина). Если положиться на «вызвать init() один раз», порядок «сначала карта, потом справочник»
// молча стёр бы отсюда escapeHtml/statusColor/statusLabel, и всплывашка при следующем открытии карты упала
// бы с TypeError — поэтому init() с ПОЛНЫМ набором зовётся заново при КАЖДОМ построении карты (build() ниже),
// а не один раз при первой загрузке модуля: дёшево, и последний позвавший всегда выигрывает свой же заход.
let mapModulePromise = null;
let currentSwitchObject = null;   // (id) => Promise<boolean> — последнего смонтированного экрана
let currentNotify = null;         // (text) => void — статус-строка последнего смонтированного экрана
function loadMapModule() {
  if (!mapModulePromise) mapModulePromise = import("/static/map.js");
  return mapModulePromise;
}
function initMapModule(m, api) {
  m.init({
    api: (path) => api.get(path),
    escapeHtml: esc,
    // Не вызывается текущей версией map.js (проверено чтением исходника) — заведено на случай, если
    // модуль начнёт им пользоваться: тогда сообщение уйдёт в статус-строку экрана, а не потеряется.
    showToast: (text) => currentNotify?.(text),
    switchObject: (id) => currentSwitchObject?.(id),
    statusColor: (s) => STATUS_COLORS[s || "active"] || STATUS_COLORS.active,
    statusLabel: (s) => STATUS_LABELS[s || "active"] || s || "",
  });
}

function readNum(key, d) { try { const v = Number(sessionStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : d; } catch (e) { return d; } }
function writeSess(key, v) { try { sessionStorage.setItem(key, String(v)); } catch (e) { /* хранилище недоступно — не критично */ } }

export function mountMapScreen(el, { screen, objectId, api, go, switchObject }) {
  el.className = "v2-page v2-app v2-ws";
  let dead = false;
  let panelW = readNum("v2.map.panelW", 300);
  const state = {
    query: "", status: "", tracked: "",
    // Данные map.js (m.объекты) — полный список для построения бокового списка и отбора; сюда же кладутся
    // счётчики «без координат» и подсказка о подложке из onEmptyCoords (задаётся ПОСЛЕ возврата из
    // renderProjectMap — колбэк вызывается изнутри, до присвоения результата переменной).
    withoutCoords: 0, withoutCoordsList: [],
    hasBasemap: false, basemapProblem: null,
  };
  let projectMap = null;   // результат renderProjectMap (карта, объекты, показатьВсе, фильтровать, навести)
  let resizeObserver = null;

  el.innerHTML = `
    <div class="ws-top">
      <div class="ws-title"><strong>${esc(screen.title)}</strong></div>
      <div class="ws-search"><input type="search" id="mp-q" placeholder="Найти объект: название, проект, адрес"
        aria-label="Найти объект на карте" autocomplete="off"></div>
      <select id="mp-status-filter" aria-label="Отбор по статусу объекта" title="Отбор по статусу объекта"></select>
      <select id="mp-tracked" aria-label="Отбор по признаку загрузки модели" title="Отбор по признаку загрузки модели">
        <option value="">Все объекты</option>
        <option value="yes">Ведётся учёт (модель загружена)</option>
        <option value="no">Только в справочнике (без модели)</option>
      </select>
      <span class="ws-spacer"></span>
      <button type="button" class="ws-ibtn" id="mp-fit">Показать все</button>
      <button type="button" class="ws-ibtn" id="mp-current">Мой объект</button>
    </div>
    <div class="ws-main">
      <aside class="ws-panel" id="mp-panel" aria-label="Объекты на карте" style="width:${panelW}px">
        <div class="ws-panel-body" id="mp-list"></div>
      </aside>
      <div class="ws-resize" id="mp-resize" role="separator" aria-orientation="vertical"
        aria-label="Ширина списка объектов" tabindex="0"></div>
      <div class="ws-stage" id="mp-stage">
        <div class="mp-legend" id="mp-legend" aria-label="Легенда карты" hidden></div>
        <div class="ws-overlay" id="mp-overlay" role="status" aria-live="polite"></div>
      </div>
    </div>
    <div class="ws-status" id="mp-status" role="status" aria-live="polite"></div>`;

  const $ = (s) => el.querySelector(s);
  const stage = $("#mp-stage");
  const panel = $("#mp-panel");
  const overlay = $("#mp-overlay");
  const statusLine = $("#mp-status");

  currentNotify = (text) => { statusLine.textContent = text || ""; };

  function paintOverlay(html) { overlay.innerHTML = html; }
  paintOverlay(`<div class="ws-msg ws-msg-load"><span class="ws-spin" aria-hidden="true"></span> Загрузка карты…</div>`);

  // ---- ширина списка слева: мышью и стрелками, тем же приёмом, что у правой панели рабочего места
  // (workspace.js), но растёт влево→вправо (список первый, а не последний).
  function setW(w) {
    panelW = Math.max(200, Math.min(480, Math.round(w)));
    panel.style.width = panelW + "px";
    writeSess("v2.map.panelW", panelW);
  }
  const rz = $("#mp-resize");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId);
    const move = (ev) => setW(ev.clientX - el.getBoundingClientRect().left);
    const up = () => { rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); };
    rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up);
  });
  rz.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { setW(panelW + 20); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { setW(panelW - 20); e.preventDefault(); }
  });

  // ---- отбор: тот же список статусов, что и в V1 (все пять, не только встреченные — согласованность
  // с оригиналом), цвет прямо на тексте пункта (нативный <select> не умеет кружок внутри <option>).
  const statusSelect = $("#mp-status-filter");
  statusSelect.innerHTML = `<option value="">Все статусы</option>` + Object.entries(STATUS_LABELS)
    .map(([k, label]) => `<option value="${k}" style="color:${STATUS_COLORS[k]};font-weight:600">${esc(label)}</option>`).join("");

  function visibleObjects() {
    if (!projectMap) return [];
    const q = state.query.trim().toLowerCase();
    return projectMap.объекты.filter((o) => {
      if (state.status && (o.status || "active") !== state.status) return false;
      if (state.tracked === "yes" && !(o.elements > 0)) return false;
      if (state.tracked === "no" && o.elements > 0) return false;
      if (q) {
        const text = [o.name, o.project_name, o.address].filter(Boolean).join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }

  function renderLegend() {
    const legend = $("#mp-legend");
    legend.hidden = false;
    legend.innerHTML = `
      <div class="mp-legend-title">Заливка точки — доля смонтированного</div>
      ${PERCENT_SCALE.map(([c, l]) => `<div class="mp-legend-row"><span class="mp-legend-swatch" style="background:${c}"></span>${esc(l)}</div>`).join("")}
      <div class="mp-legend-title">Кружок у названия — стадия объекта</div>
      ${Object.entries(STATUS_LABELS).map(([k, l]) => `<div class="mp-legend-row"><span class="mp-legend-swatch" style="background:${STATUS_COLORS[k]}"></span>${esc(l)}</div>`).join("")}`;
  }

  function renderList() {
    const listEl = $("#mp-list");
    const visible = visibleObjects();
    const filterActive = !!(state.query || state.status || state.tracked);
    if (!visible.length) {
      listEl.innerHTML = `<p class="mp-side-empty">${filterActive ? "Ничего не найдено." : "Объектов с координатами нет."}</p>`;
    } else {
      let curProject = null;
      const rows = [];
      for (const o of visible) {
        if (o.project_name !== curProject) { curProject = o.project_name; rows.push(`<div class="mp-proj">${esc(curProject || "")}</div>`); }
        const pct = o.percent === null || o.percent === undefined ? "" : `${o.percent} %`;
        rows.push(`<button type="button" class="mp-side-item" data-goto="${o.id}" aria-current="${o.id === objectId}">
          <span class="v2-status-dot" data-dot="${esc(o.status || "active")}" aria-hidden="true"></span>
          <span class="mp-side-name">${esc(o.name)}${o.address ? `<span class="mp-side-addr">${esc(o.address)}</span>` : ""}</span>
          ${o.elements ? `<span class="mp-side-pct-dot" style="background:${percentColor(o.percent)}"></span><span class="mp-side-pct">${pct}</span>` : ""}
        </button>`);
      }
      listEl.innerHTML = rows.join("");
      listEl.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => {
        projectMap?.навести(Number(b.dataset.goto));
      }));
    }
    // «Без координат» — отдельным списком, а не молчаливым числом (задание): имена приходят из
    // without_coords_list (app/project_map.py), тем же откликом /map/objects, что и сами точки.
    const q = state.query.trim().toLowerCase();
    const missing = state.withoutCoordsList.filter((o) => !q
      || [o.name, o.project_name].filter(Boolean).join(" ").toLowerCase().includes(q));
    const wrap = document.createElement("details");
    if (state.withoutCoordsList.length) {
      wrap.className = "mp-nocoords";
      wrap.innerHTML = `<summary>Без координат: ${state.withoutCoordsList.length}${missing.length !== state.withoutCoordsList.length ? ` (показано ${missing.length})` : ""}</summary>
        <ul>${missing.map((o) => `<li>${esc(o.name)}${o.project_name ? ` <span>· ${esc(o.project_name)}</span>` : ""}</li>`).join("") || `<li><span>По отбору ничего нет.</span></li>`}</ul>`;
      listEl.after(wrap);
    }
  }

  function renderStatusLine() {
    const parts = [`Объектов на карте: ${projectMap ? projectMap.объекты.length : 0}.`];
    if (state.withoutCoords) parts.push(`Без координат: ${state.withoutCoords} — список слева под картой.`);
    if (state.basemapProblem) parts.push(state.basemapProblem + " Объекты показаны на пустом фоне.");
    else if (!state.hasBasemap) parts.push("Подложка не загружена: объекты показаны на пустом фоне. Настраивается в текущем интерфейсе («Действия → Администрирование → Карта: подложка и источник»).");
    statusLine.textContent = parts.join(" ");
  }

  // ---- клик по точке/строке ведёт на переход к рабочему месту объекта, а не на форму свойств: раздел
  // «Проекты и объекты» доступен не всем ролям («projects»: write), карта — всем («map»: read). Тот же
  // changeObject, что и у кнопки выбора объекта в шапке (main.js) — тем и согласован с остальным интерфейсом.
  async function onOpenObject(id) {
    const rec = projectMap?.объекты.find((o) => o.id === id);
    // switchObject (main.js: changeObject) — та же функция, что у кнопки выбора объекта в шапке. Она САМА, как
    // побочный эффект, уже перерисовывает ТЕКУЩИЙ экран (этот самый, «карта») под новый объект: раз он не
    // рабочее место, main.js форсирует его remount — а значит, к этому моменту ЭТОТ экземпляр экрана уже
    // уничтожен (destroy() отработал, dead === true). Это ожидаемо и не повод не переходить дальше: go() не
    // обращается ни к чему из состояния этого экземпляра, только к main.js — переход должен случиться в любом
    // случае (иначе кнопка «Свойства объекта» молча ничего не делала бы после первого клика).
    const ok = await switchObject(id);
    if (!ok) return;   // отказ («остаться на месте», например — есть несохранённые данные на другом экране)
    await go(wsScreenIdFor(rec?.kind));
  }

  async function build() {
    try {
      const m = await loadMapModule();
      if (dead) return;
      currentSwitchObject = switchObject;
      initMapModule(m, api);
      const result = await m.renderProjectMap(stage, {
        onOpenObject,
        onEmptyCoords: (without, total, hasBasemap, basemapProblem) => {
          state.withoutCoords = without;
          state.hasBasemap = hasBasemap;
          state.basemapProblem = basemapProblem;
        },
      });
      if (dead) { try { result.карта.remove(); } catch (e) { /* контекст уже мог быть потерян */ } return; }
      projectMap = result;
      // Имена объектов без координат — из СЫРОГО ответа /map/objects (renderProjectMap его не отдаёт целиком,
      // только объекты С координатами); запрашивается тем же путём ещё раз — GET дешёвый и уже закэширован
      // браузером на уровне HTTP в пределах этого же захода на экран не будет, но это одиночный лёгкий запрос,
      // а не тяжёлая точка входа. Отказ этого запроса не должен ронять уже построенную карту.
      try {
        const raw = await api.get("/map/objects");
        if (dead) return;
        state.withoutCoordsList = raw.without_coords_list || [];
      } catch (e) { /* список имён вторичен — счётчик и карта уже показаны */ }
      paintOverlay("");
      renderLegend();
      renderList();
      renderStatusLine();
      resizeObserver = new ResizeObserver(() => projectMap?.карта.resize());
      resizeObserver.observe(stage);
    } catch (e) {
      if (dead) return;
      paintOverlay(`<div class="ws-msg ws-msg-bad" role="alert"><strong>Карту не удалось построить.</strong>
        <p>${esc(e?.message || "неизвестная ошибка")}</p>
        <p class="v2-muted" style="font-size:12px">Возможно, в этом браузере или на этом рабочем месте недоступен WebGL.</p>
        <button type="button" class="v2-btn v2-primary" data-act="retry">Повторить</button></div>`);
      overlay.querySelector('[data-act="retry"]')?.addEventListener("click", () => {
        paintOverlay(`<div class="ws-msg ws-msg-load"><span class="ws-spin" aria-hidden="true"></span> Загрузка карты…</div>`);
        build();
      });
    }
  }
  build();

  $("#mp-q").addEventListener("input", (e) => {
    clearTimeout(el._searchTimer);
    const value = e.target.value;
    el._searchTimer = setTimeout(() => { state.query = value; renderList(); if (projectMap) projectMap.фильтровать(visibleObjects()); }, 150);
  });
  statusSelect.addEventListener("change", (e) => { state.status = e.target.value; renderList(); projectMap?.фильтровать(visibleObjects()); });
  $("#mp-tracked").addEventListener("change", (e) => { state.tracked = e.target.value; renderList(); projectMap?.фильтровать(visibleObjects()); });
  $("#mp-fit").addEventListener("click", () => projectMap?.показатьВсе());
  $("#mp-current").addEventListener("click", () => {
    if (!projectMap) return;
    if (!objectId) { statusLine.textContent = "Текущий объект не выбран."; return; }
    const rec = projectMap.объекты.find((o) => o.id === objectId);
    if (!rec) { statusLine.textContent = "Текущий объект не показан на карте: у него нет координат."; return; }
    projectMap.навести(objectId);
  });

  function destroy() {
    dead = true;
    if (currentSwitchObject === switchObject) currentSwitchObject = null;
    currentNotify = null;
    resizeObserver?.disconnect();
    if (projectMap) { try { projectMap.карта.remove(); } catch (e) { /* контекст уже мог быть потерян */ } projectMap = null; }
  }

  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy };
}

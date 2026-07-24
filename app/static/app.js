const SVG_NS = "http://www.w3.org/2000/svg";
const IN_PROJECT_STROKE = "#1a1a1a";
// Единый дефолт цвета подписей марок (2D fill / 3D canvas text) — заменяет
// два ранее несогласованных значения (#333 в 2D, #222 в 3D). Персонально
// переопределяется через state.currentUser.label_color, см. Docs/backlog.md.
const DEFAULT_LABEL_COLOR = "#222222";
function currentLabelColor() {
  return (state.currentUser && state.currentUser.label_color) || DEFAULT_LABEL_COLOR;
}
const NO_AXIS_DASH = "4 3"; // пунктир у элементов без данных по осям (outside_axis_grid / no_axis_grid)
const MAX_MARKER_PX = 18;    // предел радиуса маркера на экране (п.11, удвоено по п.6 второго раунда)
const MAX_LABEL_FONT_PX = 24; // предел размера шрифта подписи марки на экране (п.5, удвоено по п.6 второго раунда)
// Раньше только верхний предел — на мелком масштабе (весь чертёж на
// экране) baseFont в мировых мм даёт на экране доли пикселя, подпись
// физически нечитаема. Нижний предел держит подпись читаемой на любом
// зуме за счёт того же трюка, что и верхний — экранный размер в px,
// переведённый в мировые единицы под текущий pxPerUnit (см.
// Docs/backlog.md, 2026-07-22).
const MIN_LABEL_FONT_PX = 14;
const MAX_AXIS_FONT_PX = 13; // предел размера шрифта подписи оси на экране (п.1 второго раунда)
const MAX_ZONE_FONT_PX = 20; // предел размера шрифта названия зоны на экране — та же логика, что у MAX_LABEL_FONT_PX/MAX_AXIS_FONT_PX (см. Docs/backlog.md)
const WORKDATE_KEY = "zhbi_workdate";

let state = {
  currentUser: null,
  sourceFile: null, // "основной" файл для одно-файловых операций (экспорт, импорт истории) — последний включённый в выборке
  knownFiles: [], // [{source_file, count}] — из /source-files
  selection: new Map(), // source_file -> Set(layer) | null (null = все слои файла); сеансовый выбор, не сохраняется (п.13)
  elements: [],
  byId: new Map(),
  shapeById: new Map(),
  labelById: new Map(),
  subLabelById: new Map(), // id -> <text> допстроки (партия), только у элементов, где она сейчас видна — см. elementSubLabelText
  labelGroupById: new Map(), // id -> <g> в labels-layer, обёртка над label(+subLabel) ОДНОГО элемента — см. renderElements/applyPlacementFilters
  batchCache: new Map(), // batch.id -> BatchOut, ленивая подгрузка (карточка элемента, диалоги назначения) — см. Docs/backlog.md
  labelOffsetById: new Map(), // id -> {dx, dy, anchor} в единицах базового радиуса — направление подписи, выбранное один раз при разводке коллизий
  selectedId: null,
  // Групповое выделение рамкой (Shift+перетаскивание, см. Docs/backlog.md,
  // "Групповая смена статуса") — параллельно одиночному selectedId
  // (карточка в сайдбаре), не заменяет его. Своя подсветка на схеме
  // (styleShape, класс .multi-selected) и своя плавающая панель.
  multiSelectedIds: new Set(),
  statusColors: {},
  statusOrder: [],
  statusLabels: {},
  labelVisibility: {},
  contracts: [],
  defaultContracts: {},
  elementShapes: {}, // "layer element_type" -> имя формы
  zones: [], // [{id, category, elevation_mm, name, outline, match_status}]
  // По умолчанию выключены (быстродействие на больших файлах — заказчик
  // сам включает нужные из "Настройки", см. Docs/backlog.md) — сеансовое
  // состояние, не персистится, при каждой перезагрузке снова выключены.
  // "Стоянка" сюда больше не входит — у неё своя, более гранулярная
  // видимость (см. stanceZoneVisible ниже, запрошено явно — иерархия
  // кран→стоянки, конкретная стоянка на всех её ярусах).
  zoneVisibility: { "Захватка": false, "Кран": false },
  // Видимость КОНКРЕТНОЙ стоянки (все её ярусы разом) — opt-in множество
  // логических ключей (см. stanceLogicalKey), а не excludedSet, как у
  // фильтров: по умолчанию ничего не видно (та же логика быстродействия,
  // что и у zoneVisibility), пользователь явно включает нужную стоянку
  // через иерархию Кран→Стоянки в "Отображение зон" (см.
  // renderStanceZoneToggles, Docs/backlog.md).
  stanceZoneVisible: new Set(),
  zoneLabelEls: [], // [{el, baseFontSize}] — для предела размера шрифта при зуме (см. renderZones/updateSizesForZoom)
  // Фильтр по размещению (сайдбар → Фильтры) — для каждой категории Set
  // ИСКЛЮЧЁННЫХ значений (пусто = категория не фильтрует ничего). См.
  // renderPlacementFilters/applyPlacementFilters, Docs/backlog.md.
  placementFilters: {
    zakhvatka: new Set(), crane: new Set(), stance: new Set(), elevation: new Set(),
    elementType: new Set(), subtype: new Set(), mark: new Set(), status: new Set(),
    supplier: new Set(), contract: new Set(),
  },
  // Какие родители иерархических групп фильтра сейчас развёрнуты — чисто
  // UI-состояние навигации, но хранится в state (не в DOM), иначе
  // разворот сбрасывался бы при каждой полной перерисовке фильтров
  // (onPlacementFilterChange пересобирает DOM заново на любой клик).
  // subtype — состояние разворота 3-го уровня (Марка) под каждым подтипом
  // в группе "Тип элемента / Подтип / Марка", ключ — значение подтипа.
  placementGroupsExpanded: { crane: new Set(), elementType: new Set(), subtype: new Set(), supplier: new Set(), stanceZone: new Set() },
  // Какие ВЕРХНЕУРОВНЕВЫЕ группы фильтра сейчас свёрнуты — та же природа,
  // что placementGroupsExpanded выше (сеансовое UI-состояние, не сброс на
  // каждой перерисовке). По умолчанию свёрнуто всё, кроме "Статус" — самого
  // ходового фильтра (см. Docs/backlog.md, разбор UX: список фильтров
  // разросся настолько, что до "Статус" нужно было проскроллить и Захватку,
  // и Кран/Стоянку, и Отметку).
  topFilterCollapsed: new Set(["zakhvatka", "craneStance", "craneStanceNone", "elevation", "elementType", "supplier", "noContract"]),
  baseMarkerRadius: 1,
  view: null,
  initialView: null, // вид "вся схема целиком" — для сброса зума (п.12) и индикатора 100%
  axisNumeric: [], // [{label, x, elTop, elBottom}] отсортировано по x
  axisLetter: [],  // [{label, y, el}] отсортировано по y
  // 3D-режим схемы (см. Docs/backlog.md) — Three.js, подключается лениво
  // при первом включении кнопкой "3D". scene/camera/renderer/controls
  // создаются один раз (init3DScene), дальше только пересобираются меши
  // (build3DScene) при смене данных.
  view3d: {
    active: false,
    scene: null, camera: null, renderer: null, controls: null,
    raycaster: null, mouse: null,
    meshById: new Map(),
    zoneMeshById: new Map(), // zone.id -> THREE.Mesh (захватка/кран/стоянка)
    zoneLabelSpriteById: new Map(), // zone.id -> THREE.Sprite (подпись Кран/Стоянка в основании объёма)
    siteBaseMesh: null, // едва заметная подложка границ всего проекта — см. build3DSiteBaseMesh
    labelSpriteById: new Map(), // element.id -> THREE.Sprite (постоянная подпись марки)
    edgeMaterial: null, // общий LineMaterial на ВСЕ рёбра силуэта — см. init3DScene
    materialByStatus: new Map(), // статус -> общий MeshStandardMaterial всех НЕвыбранных элементов этого статуса
    highlightMaterial: null, // единственный материал ВЫБРАННОГО элемента (пересвечивается под его цвет статуса)
    animationFrameId: null,
  },
};

// Экранирование для мест, где текст из БД/DXF/пользовательского ввода
// (не хардкод) подставляется в innerHTML шаблонным литералом — иначе
// сохранённый XSS (см. Docs/backlog.md, "Исправления по безопасности").
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function el(tag, attrs = {}, ns = SVG_NS) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

let onUnauthorized = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error("Не авторизован");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = (body && body.detail) ? body.detail : `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ==================== ТОСТЫ ====================
function showToast(message, kind = "warning") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 7000);
}

function maybeWarnContract(result) {
  if (result && result.contract_warning) {
    const w = result.contract_warning;
    const damagedPart = w.damaged ? `, повреждено ${w.damaged}` : "";
    showToast(`Превышение по контракту «${w.contract_name}»: законтрактовано ${w.quantity}, отмечено на схеме ${w.fact}${damagedPart}.`);
  }
}

function maybeWarnBatch(result) {
  if (result && result.batch_warning) {
    const w = result.batch_warning;
    showToast(`Превышение по партии «${w.batch_label}»: запланировано ${w.quantity}, назначено ${w.fact}.`);
  }
}

// ==================== АУТЕНТИФИКАЦИЯ ====================

function showLoginScreen() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-root").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");
}

function applyRolePermissions() {
  const role = state.currentUser.role;
  const canEdit = role === "admin" || role === "user";
  document.getElementById("btn-upload").style.display = canEdit ? "" : "none";
  // Меню "Настройки" теперь видно всем ролям — в нём же живёт самообслуживание
  // смены пароля (п.10 третьего раунда). Admin-специфичные пункты скрываются
  // адресно по классу .admin-only, а не всё меню целиком.
  document.querySelectorAll("#settings-menu .admin-only").forEach(elm => {
    elm.style.display = role === "admin" ? "" : "none";
  });
}

async function checkAuth() {
  try {
    const user = await api("/me");
    state.currentUser = user;
    document.getElementById("user-name").textContent = user.display_name;
    applyRolePermissions();
    applyLabelColor();
    showApp();
    return true;
  } catch (e) {
    showLoginScreen();
    return false;
  }
}

onUnauthorized = () => { state.currentUser = null; showLoginScreen(); };

document.getElementById("login-submit").addEventListener("click", async () => {
  const domain_login = document.getElementById("login-domain").value;
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain_login, password }),
    });
    document.getElementById("login-password").value = "";
    await bootApp();
  } catch (e) {
    errorEl.textContent = e.message;
  }
});
document.getElementById("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-submit").click();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  state.currentUser = null;
  showLoginScreen();
});

// ---------- смена собственного пароля ----------
const changePasswordBackdrop = document.getElementById("change-password-backdrop");
document.getElementById("menu-change-password").addEventListener("click", () => {
  document.getElementById("settings-menu").classList.remove("open");
  document.getElementById("change-password-value").value = "";
  document.getElementById("change-password-error").textContent = "";
  changePasswordBackdrop.classList.add("open");
});
document.getElementById("change-password-cancel").addEventListener("click", () => changePasswordBackdrop.classList.remove("open"));
document.getElementById("change-password-save").addEventListener("click", async () => {
  const password = document.getElementById("change-password-value").value;
  try {
    await api(`/users/${state.currentUser.id}/set-password`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    changePasswordBackdrop.classList.remove("open");
  } catch (e) {
    document.getElementById("change-password-error").textContent = e.message;
  }
});

// ---------- цвет подписей марок — персональная настройка (см.
// Docs/backlog.md, "Партия — учёт по маркам"), тот же паттерн
// самообслуживания, что у смены пароля выше ----------
function applyLabelColor() {
  document.documentElement.style.setProperty("--mark-label-color", currentLabelColor());
}

const labelColorBackdrop = document.getElementById("label-color-backdrop");
document.getElementById("menu-label-color").addEventListener("click", () => {
  document.getElementById("settings-menu").classList.remove("open");
  document.getElementById("label-color-value").value = currentLabelColor();
  document.getElementById("label-color-error").textContent = "";
  labelColorBackdrop.classList.add("open");
});
document.getElementById("label-color-cancel").addEventListener("click", () => labelColorBackdrop.classList.remove("open"));

async function saveLabelColor(color) {
  try {
    const updated = await api(`/users/${state.currentUser.id}/label-color`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label_color: color }),
    });
    state.currentUser.label_color = updated.label_color;
    applyLabelColor();
    // 3D-спрайты — canvas-текстура, "запекается" один раз при создании,
    // на CSS-переменную не реагирует (в отличие от 2D) — нужен пересбор,
    // чтобы взять новый цвет немедленно, а не после следующей перезагрузки
    // данных (build3DScene() уже дёшево вызывать по факту, см. loadPlan()).
    if (state.view3d.active) build3DScene();
    labelColorBackdrop.classList.remove("open");
  } catch (e) {
    document.getElementById("label-color-error").textContent = e.message;
  }
}
document.getElementById("label-color-save").addEventListener("click", () => {
  saveLabelColor(document.getElementById("label-color-value").value);
});
document.getElementById("label-color-reset").addEventListener("click", () => saveLabelColor(null));

// ==================== РАБОЧАЯ ДАТА (п.8) ====================
const workdateInput = document.getElementById("workdate-input");
const workdateBox = document.getElementById("workdate-box");

// "datetime-local" в местном времени браузера — переиспользуется и
// тулбаром ("Сейчас"), и дефолтом в диалоге смены статуса (см.
// Docs/backlog.md, "явно показывать дату и время...").
function nowAsDatetimeLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// "datetime-local" отдаёт "YYYY-MM-DDTHH:MM" — серверу нужно "YYYY-MM-DD HH:MM:SS".
// Пустое значение -> null (сервер сам подставит текущий момент, datetime('now')).
function datetimeLocalToServer(value) {
  if (!value) return null;
  return value.replace("T", " ") + ":00";
}

// Баннер на всю ширину, независимый от прокрутки тулбара — единственный
// прежний индикатор (#workdate-box.active) мог уехать за пределы экрана
// вместе с остальным хвостом тулбара (см. Docs/backlog.md), и активный
// режим "задним числом" становился незаметен.
const workdateBanner = document.getElementById("workdate-banner");
function updateWorkdateStyle() {
  const active = !!workdateInput.value;
  workdateBox.classList.toggle("active", active);
  workdateBanner.classList.toggle("hidden", !active);
  if (active) {
    document.getElementById("workdate-banner-value").textContent = workdateInput.value.replace("T", " ");
  }
}
document.getElementById("workdate-banner-clear").addEventListener("click", () => {
  workdateInput.value = "";
  localStorage.removeItem(WORKDATE_KEY);
  updateWorkdateStyle();
});
workdateInput.value = localStorage.getItem(WORKDATE_KEY) || "";
updateWorkdateStyle();
workdateInput.addEventListener("change", () => {
  localStorage.setItem(WORKDATE_KEY, workdateInput.value);
  updateWorkdateStyle();
});
document.getElementById("workdate-reset").addEventListener("click", () => {
  // Явно ЗАПОЛНЯЕТ поле текущими датой/временем (не очищает) — по прямому
  // указанию заказчика ("должна устанавливать дату и время текущими
  // значениями"), предыдущий вариант с очисткой+вспышкой был неверным
  // прочтением исходной жалобы.
  const localValue = nowAsDatetimeLocal();
  workdateInput.value = localValue;
  localStorage.setItem(WORKDATE_KEY, localValue);
  updateWorkdateStyle();
});
// Именно ОЧИСТКА (не заполнение "сейчас") — отдельная кнопка от "Сейчас"
// выше: пустое поле означает "рабочая дата неактивна", сервер всегда
// использует свой текущий момент на запись, а не замороженное клиентом
// значение (см. Docs/backlog.md — стик рабочей даты в localStorage был
// причиной, почему смена статуса "не срабатывала" визуально).
document.getElementById("workdate-clear").addEventListener("click", () => {
  workdateInput.value = "";
  localStorage.removeItem(WORKDATE_KEY);
  updateWorkdateStyle();
});

function currentChangedAt() {
  return datetimeLocalToServer(workdateInput.value);
}

// ==================== ВЫБОР ФАЙЛОВ И СЛОЁВ (п.5, п.13 третьего раунда) ====================
// state.selection: source_file -> Set(layer) | null (все слои). Сеансовый выбор — не
// сохраняется ни на сервере, ни в localStorage, сбрасывается на дефолт при каждой перезагрузке
// страницы (согласовано явно — см. обсуждение бэклога).

async function loadSourceFiles() {
  state.knownFiles = await api("/source-files");
  if (state.knownFiles.length && state.selection.size === 0) {
    const first = state.knownFiles[0].source_file;
    state.selection.set(first, null);
    state.sourceFile = first;
  }
  updateFileSelectSummary();
}

function updateFileSelectSummary() {
  const summary = document.getElementById("file-select-summary");
  const n = state.selection.size;
  let text;
  if (n === 0) text = "не выбрано";
  else if (n === 1) text = Array.from(state.selection.keys())[0];
  else text = `${n} файла`;
  summary.textContent = text;
  // title — на всю кнопку, не только на span: полезно и в развёрнутом виде
  // при длинном имени файла (обрезается ellipsis, см. CSS), и особенно в
  // свёрнутом (остаётся только иконка — без title вообще не узнать, какой
  // чертёж выбран, см. ниже toolbar-collapsible).
  document.getElementById("btn-file-select").title = `Чертёж: ${text}`;
}

// ---------- сворачиваемый выбор чертежа/слоёв (по горизонтали) ----------
// Явный запрос: помимо остального тулбара, этот конкретный контрол должен
// уметь схлопываться сам — до значка, без текста — чтобы экономить место,
// а не просто участвовать в общей горизонтальной прокрутке #toolbar-scroll.
const FILE_SELECT_COLLAPSE_KEY = "zhbi_file_select_collapsed";
const fileSelectDropdown = document.getElementById("file-select-dropdown");
const fileSelectCollapseBtn = document.getElementById("file-select-collapse-btn");
function setFileSelectCollapsed(collapsed) {
  fileSelectDropdown.classList.toggle("collapsed", collapsed);
  fileSelectCollapseBtn.textContent = collapsed ? "›" : "‹";
  fileSelectCollapseBtn.title = collapsed ? "Развернуть выбор чертежа" : "Свернуть выбор чертежа";
  localStorage.setItem(FILE_SELECT_COLLAPSE_KEY, collapsed ? "1" : "0");
}
setFileSelectCollapsed(localStorage.getItem(FILE_SELECT_COLLAPSE_KEY) === "1");
fileSelectCollapseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setFileSelectCollapsed(!fileSelectDropdown.classList.contains("collapsed"));
});

const layersCache = new Map(); // source_file -> [{layer, count}], кэш на сеанс

async function getLayersFor(sourceFile) {
  if (!layersCache.has(sourceFile)) {
    layersCache.set(sourceFile, await api(`/layers?source_file=${encodeURIComponent(sourceFile)}`));
  }
  return layersCache.get(sourceFile);
}

async function renderLayerCheckboxes(sourceFile, container) {
  const layers = await getLayersFor(sourceFile);
  const selectedSet = state.selection.get(sourceFile); // null = все
  container.innerHTML = layers.map(l => {
    const checked = selectedSet === null || selectedSet === undefined || selectedSet.has(l.layer);
    return `<label class="checkbox"><input type="checkbox" data-layer="${escapeHtml(l.layer)}" ${checked ? "checked" : ""}/> ${escapeHtml(l.layer)} (${l.count})</label>`;
  }).join("");
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener("change", async () => {
      const all = Array.from(container.querySelectorAll('input[type=checkbox]'));
      const checkedLayers = all.filter(c => c.checked).map(c => c.dataset.layer);
      if (checkedLayers.length === all.length) state.selection.set(sourceFile, null);
      else state.selection.set(sourceFile, new Set(checkedLayers));
      await loadPlan();
    });
  });
}

async function renderFileSelectMenu() {
  const container = document.getElementById("file-select-list");
  container.innerHTML = "";
  for (const f of state.knownFiles) {
    const included = state.selection.has(f.source_file);
    const row = document.createElement("div");
    row.className = "file-select-row";
    row.innerHTML = `
      <label class="checkbox">
        <input type="checkbox" data-file="${escapeHtml(f.source_file)}" ${included ? "checked" : ""}/>
        ${escapeHtml(f.source_file)} (${f.count})
      </label>
      <div class="layer-list" style="display:${included ? "block" : "none"};"></div>
    `;
    container.appendChild(row);
    const layerList = row.querySelector(".layer-list");
    const fileCheckbox = row.querySelector('input[data-file]');
    fileCheckbox.addEventListener("change", async (e) => {
      if (e.target.checked) {
        state.selection.set(f.source_file, null);
        state.sourceFile = f.source_file; // последний включённый файл — "основной" для экспорта/импорта истории
        layerList.style.display = "block";
        await renderLayerCheckboxes(f.source_file, layerList);
      } else {
        state.selection.delete(f.source_file);
        layerList.style.display = "none";
        if (state.sourceFile === f.source_file) {
          const remaining = Array.from(state.selection.keys());
          state.sourceFile = remaining.length ? remaining[remaining.length - 1] : null;
        }
      }
      updateFileSelectSummary();
      // false — не preserveView: смена СОСТАВА ФАЙЛОВ (в отличие от смены
      // слоёв внутри уже выбранного файла, см. renderLayerCheckboxes) меняет
      // сам охват схемы (у каждого файла своя сетка осей), и если оставить
      // старый вид как есть, подписи осей — они пинятся к краям ТЕКУЩЕГО
      // viewBox (updateAxisLabelSizing) — окажутся привязаны к границам
      // уже неактуального охвата, визуально "плывя" к центру. Рефит и на
      // включении, и на выключении файла — гарантия, что подписи всегда
      // ровно по краю, независимо от порядка кликов (см. Docs/backlog.md).
      await loadPlan(false);
    });
    if (included) await renderLayerCheckboxes(f.source_file, layerList);
  }
}

// ---------- вкладки сайдбара: Свойства / Фильтры ----------
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${name}`));
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("btn-file-select").addEventListener("click", async (e) => {
  e.stopPropagation();
  const menu = document.getElementById("file-select-menu");
  const willOpen = !menu.classList.contains("open");
  if (willOpen) {
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.left = rect.left + "px";
    menu.style.top = (rect.bottom + 6) + "px";
    await renderFileSelectMenu();
  }
  menu.classList.toggle("open");
});
document.getElementById("file-select-done").addEventListener("click", () => {
  document.getElementById("file-select-menu").classList.remove("open");
});
document.addEventListener("click", (e) => {
  const menu = document.getElementById("file-select-menu");
  if (!menu.contains(e.target) && e.target.id !== "btn-file-select") menu.classList.remove("open");
});

// ==================== РЕНДЕР СХЕМЫ ====================

function flippedText(x, y, text, fontSize, anchor, extraAttrs = {}) {
  const g = el("text", {
    transform: `translate(${x},${y}) scale(1,-1)`,
    x: 0, y: 0, "text-anchor": anchor, "font-size": fontSize.toFixed(2),
    ...extraAttrs,
  });
  g.textContent = text;
  return g;
}

// ---------- зоны (захватка/кран/стоянка) — см. Docs/backlog.md,
// "Разбор структурированных имён слоёв DWG/DXF..." ----------
function renderZones() {
  const layer = document.getElementById("zones-layer");
  layer.innerHTML = "";
  state.zoneLabelEls = []; // {el, baseFontSize} — для предела размера при зуме, см. updateSizesForZoom
  if (!state.zones.length) return;

  // Базовый (немасштабированный экраном) размер шрифта подписи зоны — сам
  // по себе он в мировых координатах, поэтому растёт при зуме, как и всё
  // остальное на схеме через viewBox; фактический предел на экране
  // накладывается в updateSizesForZoom() (MAX_ZONE_FONT_PX), той же логикой,
  // что и у подписей марок/осей — п.5 бэклога "проверь, что на названия
  // зон распространяются общие правила по максимальному размеру текста".
  const xs = state.zones.flatMap(z => z.outline.map(p => p[0]));
  const baseFontSize = xs.length ? (Math.max(...xs) - Math.min(...xs)) * 0.01 : 100;

  for (const zone of state.zones) {
    // "Стоянка" — своя, более гранулярная видимость (конкретная стоянка
    // конкретного крана, opt-in), не общий тумблер категории — см.
    // state.stanceZoneVisible/renderStanceZoneToggles, Docs/backlog.md.
    if (zone.category === "Стоянка") {
      if (!state.stanceZoneVisible.has(stanceLogicalKey(zone.id))) continue;
    } else if (state.zoneVisibility[zone.category] === false) continue;
    const points = zone.outline.map(p => `${p[0]},${p[1]}`).join(" ");
    const unresolved = zone.match_status !== "matched";
    const poly = el("polygon", {
      points, class: `zone-${zone.category}${unresolved ? " zone-unresolved" : ""}`,
      "stroke-width": 2, "vector-effect": "non-scaling-stroke",
    });
    // Индивидуальный цвет крана (и унаследованный его стоянками) —
    // переопределяет цвет CSS-класса категории через ИНЛАЙН-СТИЛЬ, а не
    // атрибут fill/stroke — обычный SVG-атрибут fill="..." всегда
    // проигрывает CSS-правилу класса (.zone-Кран { fill: ... }),
    // независимо от порядка в DOM, это и было причиной, что все краны
    // красились в один и тот же цвет вопреки настройке (см.
    // Docs/backlog.md). У Захватки color всегда null — остаётся единая
    // раскраска по категории из CSS.
    if (zone.color) {
      poly.style.fill = zone.color;
      poly.style.stroke = zone.color;
    }
    layer.appendChild(poly);

    // Подпись — по центроиду полигона, внутри контура зоны (запрошено
    // явно, см. Docs/backlog.md, item 5 — разворот предыдущего решения,
    // когда подпись специально выносили НАД верхним краем, чтобы не
    // перекрывалась с марками элементов внутри зоны; с появлением
    // индивидуального цвета на каждый кран, см. item 7, заказчик счёл,
    // что читается нормально и внутри).
    const cx = zone.outline.reduce((s, p) => s + p[0], 0) / zone.outline.length;
    const cy = zone.outline.reduce((s, p) => s + p[1], 0) / zone.outline.length;
    const label = zoneDisplayName(zone);
    const text = flippedText(cx, cy, label, baseFontSize, "middle", { class: `zone-${zone.category}` });
    if (zone.color) text.style.fill = zone.color;
    layer.appendChild(text);
    state.zoneLabelEls.push({ el: text, baseFontSize, cx, cy, text: label });
  }
  updateSizesForZoom(); // сразу применить предел размера шрифта под текущий зум
}

function renderZoneToggles() {
  const box = document.getElementById("zone-toggles");
  box.innerHTML = "";
  const categories = ["Захватка", "Кран"]; // "Стоянка" — отдельная иерархия, см. renderStanceZoneToggles
  const present = new Set(state.zones.map(z => z.category));
  if (!present.size) { box.innerHTML = '<div style="color:var(--color-text-muted)">нет данных</div>'; return; }
  for (const category of categories) {
    if (!present.has(category)) continue;
    const label = document.createElement("label");
    label.className = "toggle";
    const checked = state.zoneVisibility[category] !== false;
    label.innerHTML = `<input type="checkbox" data-category="${escapeHtml(category)}" ${checked ? "checked" : ""}/> ${escapeHtml(category)}`;
    label.querySelector("input").addEventListener("change", (e) => {
      state.zoneVisibility[category] = e.target.checked;
      renderZones();
      apply3DZoneVisibility(); // тот же тумблер действует и на 3D-сцену, если она уже построена
    });
    box.appendChild(label);
  }
}

// Видимость стоянок — иерархия Кран → его Стоянки (не плоский тумблер
// категории, как у Захватки/Крана) — заказчик явно попросил возможность
// включить на схеме ОДНУ конкретную стоянку конкретного крана, на всех
// её ярусах разом, а не всю категорию "Стоянка" целиком (см.
// Docs/backlog.md). Ключ узла — тот же stanceLogicalKey, что и в фильтре
// "Кран / Стоянка крана" — одна логическая стоянка = одна строка,
// физические ярусные зоны под ней не показываются отдельно. Клик по
// крану — ставит/снимает разом все его стоянки (обычный чекбокс-каскад,
// как у buildHierarchicalFilterGroup, но здесь ОТДЕЛЬНАЯ реализация:
// там семантика "исключённые" (по умолчанию всё включено), здесь —
// "включённые" (по умолчанию ничего не видно, см. state.stanceZoneVisible) —
// смешивать эти две семантики в одной функции рискованнее, чем
// продублировать небольшой объём вёрстки.
function renderStanceZoneToggles() {
  const box = document.getElementById("stance-zone-toggles");
  box.innerHTML = "";
  const stanceKeys = Array.from(new Set(
    state.zones.filter(z => z.category === "Стоянка").map(z => stanceLogicalKey(z.id))
  ));
  if (!stanceKeys.length) return; // нет стоянок в текущей выборке — секции вообще не показываем

  const stancesByCrane = new Map();
  for (const key of stanceKeys) {
    const craneId = craneIdForStanceId(key);
    if (!stancesByCrane.has(craneId)) stancesByCrane.set(craneId, []);
    stancesByCrane.get(craneId).push(key);
  }
  const craneLabel = cv => cv === PLACEMENT_NONE ? "Кран не определён" : zoneNameById(cv);
  const craneHeadings = Array.from(stancesByCrane.keys()).sort(placementComparator(craneLabel));
  for (const h of craneHeadings) stancesByCrane.get(h).sort(placementComparator(stanceNameForLogicalKey));

  const heading = document.createElement("h5");
  heading.style.cssText = "margin:10px 0 4px; font-size:11px; font-weight:600; color:var(--color-text-muted);";
  heading.textContent = "Стоянки по кранам";
  box.appendChild(heading);

  for (const craneId of craneHeadings) {
    const children = stancesByCrane.get(craneId);

    const pRow = document.createElement("div");
    pRow.className = "filter-parent-row";

    const childrenBox = document.createElement("div");
    childrenBox.className = "filter-children";
    const isOpen = state.placementGroupsExpanded.stanceZone.has(craneId);
    if (isOpen) childrenBox.classList.add("open");

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "filter-expand-btn";
    expandBtn.textContent = isOpen ? "▾" : "▸";
    expandBtn.title = isOpen ? "Свернуть" : "Развернуть";
    expandBtn.addEventListener("click", () => {
      const open = childrenBox.classList.toggle("open");
      expandBtn.textContent = open ? "▾" : "▸";
      expandBtn.title = open ? "Свернуть" : "Развернуть";
      if (open) state.placementGroupsExpanded.stanceZone.add(craneId); else state.placementGroupsExpanded.stanceZone.delete(craneId);
    });
    pRow.appendChild(expandBtn);

    const pLabel = document.createElement("label");
    pLabel.className = "toggle filter-parent";
    const pInput = document.createElement("input");
    pInput.type = "checkbox";
    const refreshParentState = () => {
      const allOn = children.every(k => state.stanceZoneVisible.has(k));
      const someOn = children.some(k => state.stanceZoneVisible.has(k));
      pInput.checked = allOn;
      pInput.indeterminate = someOn && !allOn;
    };
    refreshParentState();
    pLabel.appendChild(pInput);
    pLabel.appendChild(document.createTextNode(" " + craneLabel(craneId)));
    pRow.appendChild(pLabel);
    box.appendChild(pRow);
    box.appendChild(childrenBox);

    const childInputs = [];
    for (const key of children) {
      const cRow = document.createElement("div");
      cRow.className = "filter-parent-row";
      const spacer = document.createElement("span");
      spacer.className = "filter-expand-spacer";
      cRow.appendChild(spacer);

      const cLabel = document.createElement("label");
      cLabel.className = "toggle filter-child";
      const cInput = document.createElement("input");
      cInput.type = "checkbox";
      cInput.checked = state.stanceZoneVisible.has(key);
      cInput.addEventListener("change", () => {
        if (cInput.checked) state.stanceZoneVisible.add(key); else state.stanceZoneVisible.delete(key);
        refreshParentState();
        renderZones();
        apply3DZoneVisibility();
      });
      cLabel.appendChild(cInput);
      cLabel.appendChild(document.createTextNode(" " + stanceNameForLogicalKey(key)));
      cRow.appendChild(cLabel);
      childrenBox.appendChild(cRow);
      childInputs.push(cInput);
    }

    pInput.addEventListener("change", () => {
      for (const key of children) {
        if (pInput.checked) state.stanceZoneVisible.add(key); else state.stanceZoneVisible.delete(key);
      }
      childInputs.forEach(inp => { inp.checked = pInput.checked; });
      pInput.indeterminate = false;
      renderZones();
      apply3DZoneVisibility();
    });
  }
}

// ---------- фильтр по размещению (сайдбар → Фильтры) — Захватка/Кран+
// Стоянка (иерархически)/Отметка/Тип элемента+Подтип (иерархически)/
// Статус. Значения — только те, что реально встречаются у элементов
// текущей выборки (не жёстко зашитый список). Комбинация категорий — И,
// значения внутри категории — ИЛИ (элемент проходит, если хоть одно из
// включённых значений совпадает; для иерархических категорий "родитель" и
// "потомок" — по-прежнему ДВЕ независимые категории/excludedSet, клик по
// родителю просто синхронизирует чекбоксы потомков — см. buildHierarchical
// FilterGroup — так проще и даёт корректный результат без слияния булевой
// семантики). Каскад (см. distinctValuesFor): список значений КАЖДОЙ
// категории считается по элементам, прошедшим фильтры ВСЕХ ОСТАЛЬНЫХ
// категорий — выбор в одном фильтре сужает варианты в других. Применяется
// на клиенте — скрытием уже отрисованных <g> элементов, без обращения к
// серверу (см. Docs/backlog.md). ----------
const PLACEMENT_NONE = "__none__"; // сентинел «нет данных/не применимо»
const PLACEMENT_ZONE_CATEGORY = { zakhvatka: "Захватка", crane: "Кран", stance: "Стоянка" };

// Значение фильтра — id зоны, НЕ имя. Имена зон не уникальны глобально:
// каждый кран нумерует свои стоянки заново (у каждого крана есть своя
// "Стоянка 1"), поэтому сравнение/группировка по имени схлопывала разные
// физические зоны в один пункт фильтра — реальный баг, см. Docs/backlog.md.
// id у элемента (zone_crane_id и т.п.) уже есть готовый, резолвить зону
// целиком незачем — имя нужно только для подписи чекбокса (см. zoneNameById).
function zoneFilterValue(element, idField, statusField) {
  return element[statusField] === "matched" ? element[idField] : PLACEMENT_NONE;
}

function zoneNameById(zoneId) {
  const zone = state.zones.find(z => z.id === zoneId);
  return zone ? (zone.name || `зона #${zone.id}`) : `зона #${zoneId}`;
}

// Отображаемое имя ОДНОЙ ФИЗИЧЕСКОЙ зоны (для рендера на схеме — 2D/3D),
// НЕ то же самое, что stanceLogicalKey/stanceNameForLogicalKey выше (те
// про ОДИН пункт фильтра на все ярусы сразу). У "Стоянки" добавляем
// отметку яруса — заказчик подтвердил явно (см. Docs/backlog.md): с
// появлением нескольких физических записей на один номер стоянки (по
// одной на ярус) без отметки на плане не различить, какая подпись к
// какому ярусу относится, а на плоском 2D-плане подписи разных ярусов
// одной стоянки могут оказаться совсем рядом.
function zoneDisplayName(zone) {
  const base = zone.name || (zone.match_status === "unmatched" ? "название не найдено" : "требует проверки");
  if (zone.category === "Стоянка" && zone.elevation_mm != null) return `${base} +${zone.elevation_mm}`;
  return base;
}

// Логический ключ стоянки — (кран, имя), НЕ id конкретной зоны. С
// появлением реальных полигонов стоянки на каждом ярусе колонн (см.
// Docs/backlog.md, 260722) одна и та же "Стоянка 1" крана — это уже НЕ
// одна зона, а несколько записей zones (свой dxf_handle и id на КАЖДОМ
// ярусе). Фильтр по сырому zone.id (как раньше — см. комментарий у
// zoneFilterValue) в этой ситуации показал бы "Стоянка 1" 4 раза
// отдельными пунктами и включал бы элементы только одного яруса за раз
// — заказчик явно попросил ровно ОДИН пункт на (кран, стоянка),
// охватывающий элементы со ВСЕХ её ярусов. Имя всё ещё не уникально
// ГЛОБАЛЬНО (см. тот же комментарий про "Стоянка 1" у каждого крана
// заново) — поэтому ключ обязательно включает id родительского крана,
// не одно только имя. Зоны без определённого крана/имени — резервный
// путь "zone:<id>", как раньше (одна зона = один пункт фильтра).
function stanceLogicalKey(zoneId) {
  const zone = state.zones.find(z => z.id === zoneId);
  if (!zone) return `zone:${zoneId}`;
  if (zone.parent_zone_id != null && zone.name) return `stance:${zone.parent_zone_id}:${zone.name}`;
  return `zone:${zone.id}`;
}

function stanceNameForLogicalKey(key) {
  if (typeof key === "string" && key.startsWith("zone:")) return zoneNameById(Number(key.slice(5)));
  const zone = state.zones.find(z => z.category === "Стоянка" && stanceLogicalKey(z.id) === key);
  return zone ? (zone.name || `зона #${zone.id}`) : String(key);
}

// "Стоянка крана" — это не точка, а рабочая зона крана в конкретной
// позиции (см. Docs/backlog.md) — элемент может физически находиться в
// зоне работы крана, но не в контуре ни одной конкретной стоянки внутри
// неё. Такой элемент — это НЕ "непонятно какой кран", кран у него как
// раз известен (zone_crane_status="matched") — поэтому вместо общего
// PLACEMENT_NONE используем псевдо-значение, привязанное к конкретному
// крану (`no-stance:<id крана>`), чтобы оно корректно легло дочерним
// пунктом ИМЕННО под этот кран в иерархии фильтра, а не потерялось в
// одном общем пункте вне всех кранов. Настоящий PLACEMENT_NONE остаётся
// только когда и кран тоже не определён (крайне редкий случай).
const NO_STANCE_PREFIX = "no-stance:";
function noStanceValueForCrane(craneId) { return `${NO_STANCE_PREFIX}${craneId}`; }
function isNoStanceValue(v) { return typeof v === "string" && v.startsWith(NO_STANCE_PREFIX); }
function craneIdFromNoStanceValue(v) { return Number(v.slice(NO_STANCE_PREFIX.length)); }

function stanceFilterValue(element) {
  if (element.zone_stance_status === "matched") return stanceLogicalKey(element.zone_stance_id);
  if (element.zone_crane_status === "matched") return noStanceValueForCrane(element.zone_crane_id);
  return PLACEMENT_NONE;
}

function elevationFilterValue(element) {
  return (element.elevation_mm === null || element.elevation_mm === undefined) ? PLACEMENT_NONE : element.elevation_mm;
}

// Ключ подтипа в фильтре — составной (тип элемента + текст подтипа), а не
// голый текст подтипа: разные типы могут буквально совпадать текстом
// подтипа — например, "на отм. +15.000" одновременно у Ригеля и у Плиты
// перекрытия (общий приём именования в справочнике allowed_subtypes, см.
// Docs/TZ.md §3.7). Раньше фильтр по подтипу сравнивал голый текст —
// снятие галочки с "Ригель" каскадом снимало все его подтипы, а раз
// проверка на попадание в исключённые шла по тексту без учёта типа, это
// заодно скрывало элементы "Плита перекрытия" с тем же текстом подтипа
// (живой репорт пользователя 2026-07-24: "при снятии галочки с ригелей
// исчезают плиты перекрытий", см. Docs/backlog.md). Тот же приём
// составного ключа, что уже применён для стоянок (stanceLogicalKey) —
// и уже (независимо) применён для этой же пары тип/подтип в диалоге
// партии, см. `${type} ${subtype}` в buildBatchDialogMaps ниже.
const SUBTYPE_KEY_SEP = "::";
function subtypeLogicalKey(elementType, subtype) {
  return `${elementType}${SUBTYPE_KEY_SEP}${subtype}`;
}
function subtypeTextForLogicalKey(key) {
  const idx = key.indexOf(SUBTYPE_KEY_SEP);
  return idx === -1 ? key : key.slice(idx + SUBTYPE_KEY_SEP.length);
}
function subtypeElementTypeForLogicalKey(key) {
  const idx = key.indexOf(SUBTYPE_KEY_SEP);
  return idx === -1 ? PLACEMENT_NONE : key.slice(0, idx);
}
// Типы, у которых текст подтипа — это фактически отметка ("на отм.
// +15.000" и т.п., см. allowed_subtypes/Docs/TZ.md §3.7) — избыточно
// показывать промежуточный уровень "Подтип" в дереве фильтра, когда для
// этого уже есть отдельный фильтр "Отметка (высота)" (живой репорт
// пользователя 2026-07-24: "группировка по отметке внутри Плиты
// перекрытия/Ригеля не нужна"). Для этих типов марки — ПРЯМЫЕ дети типа
// в дереве (Тип → Марка), без промежуточного уровня подтипа; фильтрация
// по отметке продолжает работать как раньше, независимо, через
// elevationFilterValue — просто в дереве ей больше не задваивают
// подтип. У Колонны подтип — смысловое название яруса ("нижняя"/
// "верхняя"), не голая отметка, поэтому её не трогаем.
const FLAT_MARK_TYPES = new Set(["Плита перекрытия", "Ригель"]);

function subtypeFilterValue(element) {
  // Для FLAT_MARK_TYPES "слот подтипа" в дереве фильтра занимает МАРКА
  // (см. комментарий выше) — тот же составной ключ (тип+текст), только
  // текст — марка, а не подтип.
  if (FLAT_MARK_TYPES.has(element.element_type)) {
    return element.mark ? subtypeLogicalKey(element.element_type, element.mark) : PLACEMENT_NONE;
  }
  return element.subtype ? subtypeLogicalKey(element.element_type, element.subtype) : PLACEMENT_NONE;
}

function markFilterValue(element) {
  return element.mark || PLACEMENT_NONE;
}

// Поставщик/Контракт — та же иерархическая пара, что Кран/Стоянка и
// Тип/Подтип, только источник значений не зоны, а state.contracts (см.
// Docs/backlog.md, "Групповая смена статуса"). element.contract_id —
// уже готовый денормализованный кэш (см. app/contracts.py), резолвить
// контракт целиком нужно только для подписи (поставщик контракта).
function contractIdFilterValue(element) {
  return element.contract_id || PLACEMENT_NONE;
}
function supplierFilterValue(element) {
  if (!element.contract_id) return PLACEMENT_NONE;
  const c = state.contracts.find(c => c.id === element.contract_id);
  return c ? c.supplier : PLACEMENT_NONE;
}

// Единый список определений категорий — используется и для проверки
// "проходит ли элемент фильтр", и для расчёта доступности значений.
const PLACEMENT_FILTER_DEFS = [
  { key: "zakhvatka", valueFn: e => zoneFilterValue(e, "zone_zakhvatka_id", "zone_zakhvatka_status") },
  { key: "crane", valueFn: e => zoneFilterValue(e, "zone_crane_id", "zone_crane_status") },
  { key: "stance", valueFn: stanceFilterValue },
  { key: "elevation", valueFn: elevationFilterValue },
  { key: "elementType", valueFn: e => e.element_type },
  { key: "subtype", valueFn: subtypeFilterValue },
  { key: "mark", valueFn: markFilterValue },
  { key: "status", valueFn: e => e.current_status },
  { key: "supplier", valueFn: supplierFilterValue },
  { key: "contract", valueFn: contractIdFilterValue },
];

function passesPlacementFilters(element) {
  for (const def of PLACEMENT_FILTER_DEFS) {
    if (state.placementFilters[def.key].has(def.valueFn(element))) return false;
  }
  return true;
}

// Пары категорий, связанные UI-каскадом родитель→потомок (клик по крану
// ставит/снимает его стоянки, клик по типу — его подтипы, см.
// buildHierarchicalFilterGroup). При проверке доступности ОДНОЙ из пары
// нужно игнорировать фильтр ОБЕИХ — иначе получается самоблокирующийся
// цикл: снятие галочки с "Колонна" каскадом исключает все подтипы
// колонны, а потом доступность самой "Колонна" считается по "остальным"
// фильтрам, включая только что исключённые её же подтипы — "Колонна"
// навсегда остаётся недоступной для повторного включения. См.
// Docs/backlog.md.
const PLACEMENT_CASCADE_GROUPS = [["elementType", "subtype", "mark"], ["crane", "stance"], ["supplier", "contract"]];

function cascadeGroupFor(key) {
  return PLACEMENT_CASCADE_GROUPS.find(g => g.includes(key)) || [key];
}

function elementPassesExceptKeys(element, exceptKeys) {
  for (const def of PLACEMENT_FILTER_DEFS) {
    if (exceptKeys.includes(def.key)) continue;
    if (state.placementFilters[def.key].has(def.valueFn(element))) return false;
  }
  return true;
}

// ПОЛНЫЙ список значений категории — НЕ зависит ни от одного текущего
// фильтра (ни своего, ни чужих), поэтому пункт списка никогда не
// пропадает из формы (см. Docs/backlog.md: "не убирай с формы отборы,
// которые становятся неактуальными... а делай их недоступными" — было
// найдено 2 реальных бага от прежнего поведения, когда список СУЖАЛСЯ:
// (1) снятие галочки с "Колонна" убирало саму "Колонна" из списка —
// её нельзя было вернуть без полного сброса фильтров, потому что
// каскад по подтипам исключал все элементы этого типа ещё и из
// подсчёта "остальных" фильтров; (2) стоянки крана пропадали из
// иерархии целиком, если сам кран оказывался исключён в фильтре "Кран"
// — тот же механизм). Для зон (Захватка/Кран/Стоянка) список
// дополнительно объединяется с id зон из state.zones — иначе зона без
// НИ ОДНОГО привязанного элемента (например, пустая стоянка) вообще не
// попала бы в список, хотя видна на схеме.
function allValuesFor(key) {
  const def = PLACEMENT_FILTER_DEFS.find(d => d.key === key);
  const set = new Set();
  const category = PLACEMENT_ZONE_CATEGORY[key];
  if (category) {
    for (const z of state.zones) {
      if (z.category !== category) continue;
      // "Стоянка" — логический ключ (кран, имя), не id зоны — иначе
      // пустая стоянка (без элементов) без этого добавления пропала бы
      // из списка отдельно на КАЖДОМ ярусе, дублируя пункт, см.
      // stanceLogicalKey.
      set.add(key === "stance" ? stanceLogicalKey(z.id) : z.id);
    }
  }
  // Контракт/поставщик без ни одного привязанного элемента — тот же приём,
  // что и у зон выше (см. комментарий): всё равно должен быть в списке
  // фильтра, а не появляться только после того, как элементы к нему
  // привязали.
  if (key === "contract") { for (const c of state.contracts) set.add(c.id); }
  if (key === "supplier") { for (const c of state.contracts) set.add(c.supplier); }
  for (const e of state.elements) set.add(def.valueFn(e));
  return set;
}

// Доступно ли значение ПРЯМО СЕЙЧАС — есть ли хоть один элемент с этим
// значением, проходящий все ОСТАЛЬНЫЕ активные фильтры (саму категорию
// key не проверяем — иначе включение/выключение самого значения влияло
// бы на его же доступность). Используется только для disabled/серого
// вида чекбокса — сам чекбокс из формы никогда не убирается (см.
// allValuesFor выше).
function isValueEnabled(key, value) {
  const def = PLACEMENT_FILTER_DEFS.find(d => d.key === key);
  const exceptKeys = cascadeGroupFor(key);
  for (const e of state.elements) {
    if (def.valueFn(e) !== value) continue;
    if (elementPassesExceptKeys(e, exceptKeys)) return true;
  }
  return false;
}

// Только 2D: id элементов, чья подпись должна быть видна — самый верхний
// по отметке элемент среди ПРОШЕДШИХ ТЕКУЩИЙ ФИЛЬТР в каждой точке плана
// (x,y). Без этого, после переноса подписей в общий слой поверх всех
// фигур (см. renderElements), была видна подпись элемента, чья фигура на
// самом деле скрыта под фигурой более верхнего яруса (или выключена
// фильтром вовсе) — непонятно, какой маркой подписана видимая фигура.
// Заказчик подтвердил именно такое правило (см. Docs/backlog.md). В 3D
// эта проблема не стоит — ярусы там разнесены по высоте и видны
// одновременно без взаимного перекрытия, там подписи показываются как
// раньше, для всех элементов.
//
// Группировка — по РЕАЛЬНОЙ близости (см. SAME_POINT_TOLERANCE_MM ниже),
// не по точному совпадению координат. Раньше округляли до 0.1мм — гасило
// только погрешность float, но НЕ реальное расхождение геометрии одной и
// той же конструктивной точки между ярусами: на живых данных колонна/
// ригель/плита одной оси на разных отметках регулярно приходят из DXF со
// смещением в десятки, иногда сотни мм (разная геометрия яруса, разный
// способ простановки вставки) — с допуском 0.1мм такие пары попадали в
// РАЗНЫЕ группы и обе марки показывались одновременно, впритык друг к
// другу (см. Docs/backlog.md, живой разбор — "марки задвоились"). Порог
// подобран по факту на реальном файле: ближайшие ДЕЙСТВИТЕЛЬНО разные
// объекты одного яруса никогда не находятся ближе ~550мм друг к другу, а
// расхождение одной и той же точки между ярусами наблюдалось до ~450мм —
// 400мм безопасно между ними.
const SAME_POINT_TOLERANCE_MM = 400;

function topVisibleLabelIds() {
  const bucketSize = SAME_POINT_TOLERANCE_MM * 2;
  const buckets = new Map();
  const bucketKey = (x, y) => `${Math.floor(x / bucketSize)}:${Math.floor(y / bucketSize)}`;

  // Группа — не по одному округлённому ключу, а "любой другой элемент в
  // пределах допуска" (одиночная связка, см. ниже) — иначе два элемента,
  // чьи координаты честно отличаются на 5мм, но лежат по разные стороны
  // границы бакета, снова ложно попали бы в разные группы.
  function findGroup(x, y) {
    const bx = Math.floor(x / bucketSize), by = Math.floor(y / bucketSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${bx + dx}:${by + dy}`);
        if (!arr) continue;
        for (const group of arr) {
          if (Math.hypot(group.x - x, group.y - y) <= SAME_POINT_TOLERANCE_MM) return group;
        }
      }
    }
    return null;
  }

  const groups = [];
  for (const e of state.elements) {
    let group = findGroup(e.x, e.y);
    if (!group) {
      group = { x: e.x, y: e.y, members: [] };
      const key = bucketKey(e.x, e.y);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(group);
      groups.push(group);
    }
    group.members.push(e);
  }

  const ids = new Set();
  for (const group of groups) {
    if (group.members.length === 1) { ids.add(group.members[0].id); continue; } // обычный случай — считать нечего
    let best = null;
    for (const e of group.members) {
      if (!passesPlacementFilters(e)) continue;
      if (!best || (e.elevation_mm ?? -Infinity) > (best.elevation_mm ?? -Infinity)) best = e;
    }
    if (best) ids.add(best.id);
  }
  return ids;
}

// Скрывает/показывает уже отрисованные элементы по текущим фильтрам —
// без перерисовки схемы. Фигура и подпись — РАЗНЫЕ узлы в РАЗНЫХ слоях
// (см. renderElements) — скрывать нужно каждый в отдельности, а не общий
// shape.parentElement: после переноса подписей в единый #labels-layer
// им родитель ФИГУРЫ стал общим на ВСЕ элементы (сам #elements-layer) —
// скрытие через него гасило схему целиком, как только хоть один элемент
// не проходил фильтр (последний элемент цикла решал итоговое состояние
// общего слоя) — реальный баг, живая проверка, см. Docs/backlog.md.
// state.labelGroupById — обёртка на подпись(+допстроку) ОДНОГО элемента.
function applyPlacementFilters() {
  const topVisible = topVisibleLabelIds(); // только 2D, см. комментарий там же
  for (const element of state.elements) {
    const passes = passesPlacementFilters(element);
    const shape = state.shapeById.get(element.id);
    if (shape) shape.style.display = passes ? "" : "none";
    const labelGroup = state.labelGroupById.get(element.id);
    if (labelGroup) labelGroup.style.display = (passes && topVisible.has(element.id)) ? "" : "none";
    // Тот же фильтр — и на 3D-меш, если сцена уже построена (см. "3D-режим схемы").
    // 3D-подпись НЕ ограничена topVisible — там ярусы не перекрывают друг
    // друга визуально, каждый виден на своей высоте одновременно.
    const mesh = state.view3d.meshById.get(element.id);
    if (mesh) mesh.visible = passes;
    const sprite = state.view3d.labelSpriteById.get(element.id);
    if (sprite) sprite.visible = passes && state.labelVisibility[element.element_type] !== false;
  }
}

// Что происходит после ЛЮБОГО изменения в фильтре по размещению: заново
// показать/скрыть элементы на схеме, пересчитать легенду статусов (см.
// renderLegend — теперь тоже считает по отфильтрованным элементам,
// Docs/backlog.md), и заново отрисовать сами фильтры — список значений
// (allValuesFor) не меняется, но доступность (isValueEnabled/disabled) в
// ДРУГИХ категориях могла измениться. Состояние (excludedSet) не в DOM, а
// в state.placementFilters, поэтому полная перерисовка чекбоксов не
// теряет отметки пользователя.
function onPlacementFilterChange() {
  applyPlacementFilters();
  renderLegend();
  renderPlacementFilters();
}

function placementNoneLabel(kind) {
  if (kind === "elevation") return "— без отметки —";
  if (kind === "subtype") return "— без подтипа —";
  if (kind === "mark") return "— без марки —";
  if (kind === "supplier") return "— без поставщика —";
  if (kind === "contract") return "— без контракта —";
  return "— не определено —";
}

// compareRaw — сравнивать значения как есть (a - b), а не по подписи.
// Годится ТОЛЬКО для категорий, где сама величина осмысленна как число
// (Отметка, мм) — для зональных категорий (Кран/Стоянка/Захватка)
// значение теперь id зоны (см. zoneFilterValue), а id — это внутренний
// идентификатор БД без смыслового порядка, сортировать его как число
// было бы неправильно, нужно сравнивать по РЕЗОЛВЛЕННОМУ имени.
function placementComparator(labelFor, { compareRaw = false } = {}) {
  // "Служебные" псевдо-значения (нет данных / нет конкретной стоянки) —
  // всегда в конце списка, после реальных значений.
  const isTrailing = v => v === PLACEMENT_NONE || isNoStanceValue(v);
  return (a, b) => {
    if (isTrailing(a) && !isTrailing(b)) return 1;
    if (isTrailing(b) && !isTrailing(a)) return -1;
    if (compareRaw && typeof a === "number" && typeof b === "number") return a - b;
    // numeric:true — естественная сортировка чисел внутри строки
    // ("Стоянка 2" перед "Стоянка 10"), а не лексикографическая
    // ("Стоянка 10" перед "Стоянка 2").
    return String(labelFor(a)).localeCompare(String(labelFor(b)), "ru", { numeric: true });
  };
}

// key — стабильный идентификатор ВЕРХНЕУРОВНЕВОЙ группы для
// state.topFilterCollapsed (см. комментарий там же). Список категорий
// разросся (Захватка/Кран-Стоянка/Отметка/Тип-Подтип-Марка/Статус/
// Поставщик-Контракт + 2 редких "не определено") — сворачиваемость нужна
// каждой, иначе поиск нужного фильтра — это скролл через все остальные
// (см. Docs/backlog.md, разбор UX).
function filterGroupShell(title, key) {
  const wrap = document.createElement("div");
  wrap.className = "filter-group";
  if (key) wrap.dataset.filterKey = key;
  const header = document.createElement("div");
  header.className = "filter-group-header";

  const collapsed = key ? state.topFilterCollapsed.has(key) : false;
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "filter-expand-btn";
  toggleBtn.textContent = collapsed ? "▸" : "▾";
  toggleBtn.title = collapsed ? "Развернуть" : "Свернуть";
  header.appendChild(toggleBtn);

  const titleEl = document.createElement("span");
  titleEl.textContent = title;
  header.appendChild(titleEl);
  const btnAll = document.createElement("button");
  btnAll.type = "button"; btnAll.className = "link-btn"; btnAll.textContent = "все";
  const btnNone = document.createElement("button");
  btnNone.type = "button"; btnNone.className = "link-btn"; btnNone.textContent = "ничего";
  header.appendChild(btnAll);
  header.appendChild(btnNone);
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "filter-group-body";
  if (!collapsed) body.classList.add("open");
  wrap.appendChild(body);
  // Ссылка на кнопку — читается напрямую (не через DOM-поиск) поиском по
  // марке ниже (applyMarkSearchFilter), которому при совпадении нужно
  // раскрыть и саму верхнеуровневую группу, а не только вложенные уровни.
  body._toggleBtn = toggleBtn;

  toggleBtn.addEventListener("click", () => {
    const open = body.classList.toggle("open");
    toggleBtn.textContent = open ? "▾" : "▸";
    toggleBtn.title = open ? "Свернуть" : "Развернуть";
    if (key) { if (open) state.topFilterCollapsed.delete(key); else state.topFilterCollapsed.add(key); }
  });

  return { wrap, body, btnAll, btnNone };
}

// Отмечает чекбокс как временно недоступный (0 элементов проходит
// остальные фильтры при этом значении) — checked-состояние и сам пункт
// формы при этом не трогаются, см. Docs/backlog.md ("не убирай с формы
// отборы... а делай их недоступными").
function applyEnabledState(input, label, enabled) {
  input.disabled = !enabled;
  label.classList.toggle("filter-disabled", !enabled);
}

// Плоская группа (Захватка/Отметка/Статус) — просто список чекбоксов.
// isEnabledFn(value) — влияет только на disabled/серый вид, не на состав
// списка (values — уже ПОЛНЫЙ список, см. allValuesFor).
function buildFilterGroup(title, key, values, excludedSet, labelFor, isEnabledFn, onChange, sortOptions) {
  const { wrap, body, btnAll, btnNone } = filterGroupShell(title, key);
  const sorted = Array.from(values).sort(placementComparator(labelFor, sortOptions));

  const checkboxes = [];
  for (const v of sorted) {
    const label = document.createElement("label");
    label.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !excludedSet.has(v);
    applyEnabledState(input, label, isEnabledFn(v));
    input.addEventListener("change", () => {
      if (input.checked) excludedSet.delete(v); else excludedSet.add(v);
      onChange();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + labelFor(v)));
    body.appendChild(label);
    checkboxes.push(input);
  }

  btnAll.addEventListener("click", () => {
    excludedSet.clear();
    checkboxes.forEach(cb => { cb.checked = true; });
    onChange();
  });
  btnNone.addEventListener("click", () => {
    sorted.forEach(v => excludedSet.add(v));
    checkboxes.forEach(cb => { cb.checked = false; });
    onChange();
  });

  return wrap;
}

// Иерархическая группа (Кран→Стоянка крана, Тип элемента→Подтип, Тип
// элемента→Подтип→Марка) — родитель и его потомки остаются НЕЗАВИСИМЫМИ
// excludedSet (см. комментарий над PLACEMENT_FILTER_DEFS), клик по
// родителю ставит/снимает всех его потомков разом (item 3/8,
// Docs/backlog.md). parentIsEnabledFn/childIsEnabledFn — отдельные
// функции доступности, категории-то разные. Дочерние чекбоксы каждого
// родителя свёрнуты по умолчанию (только родитель виден — "по умолчанию
// выбирается вся группа крана") и разворачиваются по клику на стрелку
// рядом с родителем, если у него вообще есть дети (см. Docs/backlog.md).
// Родительский чекбокс работает как раньше (каскад на всех потомков)
// независимо от того, развёрнута группа сейчас или нет.
//
// grandchildConfig (опционально) — 3-й уровень (сейчас единственный
// случай: Марка под Подтипом, см. "Раунд из 3 пунктов", 2026-07-17):
// { childrenForChild(cv), excludedSet, labelFor(gv), isEnabledFn(gv), expandedSet }.
// Остальные 2 вызова (Кран/Стоянка, Поставщик/Контракт) НЕ передают этот
// параметр и работают ровно как раньше — весь код ниже под
// `if (grandchildConfig)` для них не выполняется.
function buildHierarchicalFilterGroup(
  title, key, parents, parentExcludedSet, parentLabelFor, parentIsEnabledFn,
  childrenForParent, childExcludedSet, childLabelFor, childIsEnabledFn, onChange, expandedSet,
  grandchildConfig
) {
  const { wrap, body, btnAll, btnNone } = filterGroupShell(title, key);
  const parentCheckboxes = [];
  const allChildCheckboxes = [];
  const allGrandchildCheckboxes = [];

  for (const pv of parents) {
    const children = childrenForParent(pv);

    const pRow = document.createElement("div");
    pRow.className = "filter-parent-row";

    const childrenBox = document.createElement("div");
    childrenBox.className = "filter-children";
    const isOpen = expandedSet.has(pv);
    if (isOpen) childrenBox.classList.add("open");

    let expandBtn = null;
    if (children.length) {
      expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "filter-expand-btn";
      expandBtn.textContent = isOpen ? "▾" : "▸";
      expandBtn.title = isOpen ? "Свернуть" : "Развернуть";
      expandBtn.addEventListener("click", () => {
        const open = childrenBox.classList.toggle("open");
        expandBtn.textContent = open ? "▾" : "▸";
        expandBtn.title = open ? "Свернуть" : "Развернуть";
        if (open) expandedSet.add(pv); else expandedSet.delete(pv);
      });
      pRow.appendChild(expandBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "filter-expand-spacer";
      pRow.appendChild(spacer);
    }

    const pLabel = document.createElement("label");
    pLabel.className = "toggle filter-parent";
    const pInput = document.createElement("input");
    pInput.type = "checkbox";
    pInput.checked = !parentExcludedSet.has(pv);
    applyEnabledState(pInput, pLabel, parentIsEnabledFn(pv));
    pLabel.appendChild(pInput);
    pLabel.appendChild(document.createTextNode(" " + parentLabelFor(pv)));
    pRow.appendChild(pLabel);
    body.appendChild(pRow);
    parentCheckboxes.push(pInput);

    const childEntries = [];
    for (const cv of children) {
      const grandchildren = grandchildConfig ? (grandchildConfig.childrenForChild(cv) || []) : [];

      const cRow = document.createElement("div");
      cRow.className = "filter-parent-row";

      const grandchildBox = document.createElement("div");
      grandchildBox.className = "filter-children";
      const gOpen = grandchildren.length && grandchildConfig.expandedSet.has(cv);
      if (gOpen) grandchildBox.classList.add("open");

      if (grandchildren.length) {
        const gExpandBtn = document.createElement("button");
        gExpandBtn.type = "button";
        gExpandBtn.className = "filter-expand-btn";
        gExpandBtn.textContent = gOpen ? "▾" : "▸";
        gExpandBtn.title = gOpen ? "Свернуть" : "Развернуть";
        gExpandBtn.addEventListener("click", () => {
          const open = grandchildBox.classList.toggle("open");
          gExpandBtn.textContent = open ? "▾" : "▸";
          gExpandBtn.title = open ? "Свернуть" : "Развернуть";
          if (open) grandchildConfig.expandedSet.add(cv); else grandchildConfig.expandedSet.delete(cv);
        });
        cRow.appendChild(gExpandBtn);
      } else if (grandchildConfig) {
        const spacer = document.createElement("span");
        spacer.className = "filter-expand-spacer";
        cRow.appendChild(spacer);
      }

      const cLabel = document.createElement("label");
      cLabel.className = "toggle filter-child";
      const cInput = document.createElement("input");
      cInput.type = "checkbox";
      cInput.checked = !childExcludedSet.has(cv);
      applyEnabledState(cInput, cLabel, childIsEnabledFn(cv));

      const grandchildEntries = [];
      cInput.addEventListener("change", () => {
        if (cInput.checked) {
          childExcludedSet.delete(cv);
          // Включили конкретный подтип (или стоянку), а сам родитель
          // сейчас выключен — включаем и его (иначе элемент всё равно не
          // пройдёт фильтр, см. Docs/backlog.md), но остальных детей
          // родителя не трогаем — только прямой клик по родителю
          // каскадно ставит/снимает всех потомков разом (см. обработчик
          // pInput ниже).
          parentExcludedSet.delete(pv);
        } else {
          childExcludedSet.add(cv);
        }
        // Каскад вниз, на марки этого подтипа — симметрично тому, как
        // клик по типу (см. pInput ниже) каскадом трогает все подтипы.
        if (grandchildConfig) {
          grandchildren.forEach(gv => {
            if (cInput.checked) grandchildConfig.excludedSet.delete(gv); else grandchildConfig.excludedSet.add(gv);
          });
          grandchildEntries.forEach(({ input }) => { input.checked = cInput.checked; });
        }
        onChange();
      });
      cLabel.appendChild(cInput);
      cLabel.appendChild(document.createTextNode(" " + childLabelFor(cv)));
      cRow.appendChild(cLabel);
      childrenBox.appendChild(cRow);
      childEntries.push({ input: cInput, value: cv });
      allChildCheckboxes.push({ input: cInput, value: cv });

      if (grandchildConfig) {
        for (const gv of grandchildren) {
          const gLabel = document.createElement("label");
          gLabel.className = "toggle filter-grandchild";
          const gInput = document.createElement("input");
          gInput.type = "checkbox";
          gInput.checked = !grandchildConfig.excludedSet.has(gv);
          applyEnabledState(gInput, gLabel, grandchildConfig.isEnabledFn(gv));
          gInput.addEventListener("change", () => {
            if (gInput.checked) {
              grandchildConfig.excludedSet.delete(gv);
              // Марке нужно снятие исключения сразу на ОБА уровня вверх
              // (подтип И тип) — иначе элемент всё равно не пройдёт
              // фильтр: passesPlacementFilters — это AND по всем
              // категориям одновременно, а не только по своей.
              childExcludedSet.delete(cv);
              parentExcludedSet.delete(pv);
            } else {
              grandchildConfig.excludedSet.add(gv);
            }
            onChange();
          });
          gLabel.appendChild(gInput);
          gLabel.appendChild(document.createTextNode(" " + grandchildConfig.labelFor(gv)));
          grandchildBox.appendChild(gLabel);
          grandchildEntries.push({ input: gInput, value: gv });
          allGrandchildCheckboxes.push({ input: gInput, value: gv });
        }
        childrenBox.appendChild(grandchildBox);
      }
    }
    body.appendChild(childrenBox);

    pInput.addEventListener("change", () => {
      if (pInput.checked) parentExcludedSet.delete(pv); else parentExcludedSet.add(pv);
      childEntries.forEach(({ value }) => {
        if (pInput.checked) childExcludedSet.delete(value); else childExcludedSet.add(value);
      });
      // Каскад на все марки всех подтипов этого типа — тем же приёмом.
      if (grandchildConfig) {
        for (const cv2 of children) {
          const gvs = grandchildConfig.childrenForChild(cv2) || [];
          gvs.forEach(gv => {
            if (pInput.checked) grandchildConfig.excludedSet.delete(gv); else grandchildConfig.excludedSet.add(gv);
          });
        }
      }
      onChange();
    });
  }

  btnAll.addEventListener("click", () => {
    parentExcludedSet.clear();
    childExcludedSet.clear();
    if (grandchildConfig) grandchildConfig.excludedSet.clear();
    parentCheckboxes.forEach(cb => { cb.checked = true; });
    allChildCheckboxes.forEach(({ input }) => { input.checked = true; });
    allGrandchildCheckboxes.forEach(({ input }) => { input.checked = true; });
    onChange();
  });
  btnNone.addEventListener("click", () => {
    parents.forEach(pv => parentExcludedSet.add(pv));
    allChildCheckboxes.forEach(({ value }) => childExcludedSet.add(value));
    if (grandchildConfig) allGrandchildCheckboxes.forEach(({ value }) => grandchildConfig.excludedSet.add(value));
    parentCheckboxes.forEach(cb => { cb.checked = false; });
    allChildCheckboxes.forEach(({ input }) => { input.checked = false; });
    allGrandchildCheckboxes.forEach(({ input }) => { input.checked = false; });
    onChange();
  });

  return wrap;
}

// К id какого крана относится значение категории "stance" — три случая:
// (1) псевдо-значение "нет конкретной стоянки, но кран известен"
// (noStanceValueForCrane) — id крана уже зашит в самом значении, брать
// неоткуда больше; (2) настоящая зона-стоянка — id крана берём из связи
// между зонами, вычисленной при разборе файла (parent_zone_id, см.
// zone_parser._link_stances_to_cranes, Docs/backlog.md) — это связь
// МЕЖДУ ЗОНАМИ (стоянка физически внутри рабочей зоны крана), отдельная
// от того, к какому крану привязан сам ЭЛЕМЕНТ; (3) ни кран, ни стоянка
// не определены (PLACEMENT_NONE) — не относится ни к какому крану.
// Принимает и возвращает id крана (число). Значение категории "stance" —
// логический ключ `stance:<craneId>:<имя>` (см. stanceLogicalKey) — id
// крана уже зашит в самом ключе, резолвить зону не нужно; резервный
// формат `zone:<id>` (стоянка без определённого крана/имени) по-прежнему
// требует поиска зоны.
function craneIdForStanceId(stanceId) {
  if (stanceId === PLACEMENT_NONE) return PLACEMENT_NONE;
  if (isNoStanceValue(stanceId)) return craneIdFromNoStanceValue(stanceId);
  if (typeof stanceId === "string" && stanceId.startsWith("stance:")) {
    const craneId = Number(stanceId.slice("stance:".length).split(":")[0]);
    return Number.isFinite(craneId) ? craneId : PLACEMENT_NONE;
  }
  if (typeof stanceId === "string" && stanceId.startsWith("zone:")) {
    const stanceZone = state.zones.find(z => z.id === Number(stanceId.slice("zone:".length)));
    if (!stanceZone || stanceZone.parent_match_status !== "matched" || stanceZone.parent_zone_id == null) return PLACEMENT_NONE;
    return stanceZone.parent_zone_id;
  }
  return PLACEMENT_NONE;
}

function renderPlacementFilters() {
  const container = document.getElementById("placement-filters");
  container.innerHTML = "";
  if (!state.elements.length) {
    container.innerHTML = '<div style="color:var(--color-text-muted)">нет данных</div>';
    return;
  }

  const zoneLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("zone") : zoneNameById(v);
  // Стоянки — отдельная подпись: помимо реальных зон и PLACEMENT_NONE,
  // тут ещё бывает псевдо-значение "нет конкретной стоянки, но кран
  // известен" (см. stanceFilterValue) — показываем явным текстом, а не
  // пытаемся резолвить как обычную зону по id (там нечего резолвить).
  const stanceLabelFor = v => {
    if (v === PLACEMENT_NONE) return placementNoneLabel("zone");
    if (isNoStanceValue(v)) return "вне стоянок";
    return stanceNameForLogicalKey(v);
  };
  const elevationLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("elevation") : `${v} мм`;
  const subtypeLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("subtype") : subtypeTextForLogicalKey(v);
  const markLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("mark") : v;
  const statusLabelFor = v => state.statusLabels[v] || v;
  const enabledFor = key => v => isValueEnabled(key, v);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn btn-sm btn-secondary";
  resetBtn.style.cssText = "margin-bottom:14px; width:100%;";
  resetBtn.textContent = "Сбросить все фильтры";
  resetBtn.addEventListener("click", () => {
    for (const key of Object.keys(state.placementFilters)) state.placementFilters[key].clear();
    onPlacementFilterChange();
  });
  container.appendChild(resetBtn);

  container.appendChild(buildFilterGroup(
    "Захватка", "zakhvatka", allValuesFor("zakhvatka"), state.placementFilters.zakhvatka, zoneLabelFor, enabledFor("zakhvatka"), onPlacementFilterChange
  ));

  // Кран / Стоянка крана — иерархически (item 3). Заголовки — объединение
  // ПОЛНОГО списка кранов и стоянок (allValuesFor — не сужается фильтрами,
  // см. комментарий над allValuesFor) — стоянка всегда под своим краном,
  // независимо от того, что сейчас включено/выключено в других фильтрах.
  //
  // "Стоянка крана" — не точка, а рабочая зона крана в конкретной позиции
  // (заказчик уточнил, см. Docs/backlog.md) — элемент вполне может быть в
  // зоне работы крана, но не в контуре ни одной конкретной стоянки внутри
  // неё. Такой элемент получает псевдо-значение "нет конкретной стоянки,
  // но кран известен" (см. stanceFilterValue/noStanceValueForCrane) —
  // корректно ложится ДОЧЕРНИМ пунктом под СВОЙ кран, а не в общий пункт
  // вне иерархии (это и было исходным багом). Настоящий PLACEMENT_NONE
  // теперь остаётся только для действительно редкого случая — когда и
  // кран у элемента, и стоянка не определены; такие элементы, а также
  // зоны-стоянки без крана-хозяина (недочёт в самом чертеже,
  // craneIdForStanceId вернёт для них PLACEMENT_NONE), собираются под
  // настоящим заголовком "Кран: не определено".
  const craneValues = allValuesFor("crane");
  const stanceValues = allValuesFor("stance");
  const stancesByCrane = new Map();
  for (const sv of stanceValues) {
    if (sv === PLACEMENT_NONE) continue; // ни кран, ни стоянка — отдельным пунктом ниже
    const cv = craneIdForStanceId(sv); // no-stance:X → id этого крана; реальная зона → её кран или PLACEMENT_NONE
    if (!stancesByCrane.has(cv)) stancesByCrane.set(cv, []);
    stancesByCrane.get(cv).push(sv);
  }
  const craneHeadings = Array.from(new Set([...craneValues, ...stancesByCrane.keys()])).sort(placementComparator(zoneLabelFor));
  for (const h of craneHeadings) stancesByCrane.get(h)?.sort(placementComparator(stanceLabelFor));
  container.appendChild(buildHierarchicalFilterGroup(
    "Кран / Стоянка крана", "craneStance", craneHeadings, state.placementFilters.crane, zoneLabelFor, enabledFor("crane"),
    cv => stancesByCrane.get(cv) || [], state.placementFilters.stance, stanceLabelFor, enabledFor("stance"),
    onPlacementFilterChange, state.placementGroupsExpanded.crane
  ));

  // Ни кран, ни стоянка не определены вовсе — редкий случай (для
  // большинства файлов пусто и пункт не показывается).
  if (stanceValues.has(PLACEMENT_NONE)) {
    container.appendChild(buildFilterGroup(
      "Кран и стоянка — не определены", "craneStanceNone", new Set([PLACEMENT_NONE]), state.placementFilters.stance,
      () => "ни кран, ни стоянка не определены", enabledFor("stance"), onPlacementFilterChange
    ));
  }

  container.appendChild(buildFilterGroup(
    "Отметка (высота)", "elevation", allValuesFor("elevation"), state.placementFilters.elevation, elevationLabelFor, enabledFor("elevation"), onPlacementFilterChange, { compareRaw: true }
  ));

  // Тип элемента / Подтип / Марка — иерархически, 3 уровня (item 8 +
  // "Раунд из 3 пунктов", 2026-07-17, п.1). Марка — прямой список без
  // поиска (заказчик выбрал этот вариант — некоторые подтипы содержат
  // 300+ уникальных марок, длинные плоские списки ожидаемы и приняты).
  const typeValues = allValuesFor("elementType");
  // Ключ подтипа теперь составной (тип+текст, см. subtypeLogicalKey) —
  // у него ровно ОДИН тип-владелец, зашитый в сам ключ, парсить его из
  // state.elements больше не нужно (раньше был отдельный
  // typesForSubtypeValue-скан — источник бага с общим текстом подтипа
  // у разных типов, см. комментарий у subtypeLogicalKey).
  const subtypeValues = allValuesFor("subtype");
  const subtypesByType = new Map();
  for (const sv of subtypeValues) {
    const t = subtypeElementTypeForLogicalKey(sv);
    if (!subtypesByType.has(t)) subtypesByType.set(t, []);
    subtypesByType.get(t).push(sv);
  }
  const typeHeadings = Array.from(new Set([...typeValues, ...subtypesByType.keys()])).sort(placementComparator(v => v));
  for (const h of typeHeadings) subtypesByType.get(h)?.sort(placementComparator(subtypeLabelFor));

  // Марки группируются по составному ключу подтипа (тип уже зашит в него,
  // см. subtypeLogicalKey выше) — коллизия одинакового текста подтипа у
  // разных типов больше не путает и марки (раньше это было отдельно
  // отмечено как принятый компромисс — теперь снято тем же fix'ом).
  const marksBySubtype = new Map();
  for (const e of state.elements) {
    const sv = subtypeFilterValue(e);
    const mv = markFilterValue(e);
    if (!marksBySubtype.has(sv)) marksBySubtype.set(sv, new Set());
    marksBySubtype.get(sv).add(mv);
  }
  for (const [sv, set] of marksBySubtype) {
    marksBySubtype.set(sv, Array.from(set).sort(placementComparator(markLabelFor)));
  }

  container.appendChild(buildHierarchicalFilterGroup(
    "Тип элемента / Подтип / Марка", "elementType", typeHeadings, state.placementFilters.elementType, v => v, enabledFor("elementType"),
    t => subtypesByType.get(t) || [], state.placementFilters.subtype, subtypeLabelFor, enabledFor("subtype"),
    onPlacementFilterChange, state.placementGroupsExpanded.elementType,
    {
      // FLAT_MARK_TYPES (Плита перекрытия/Ригель) — "подтип" в дереве уже
      // и есть марка (см. subtypeFilterValue), дальше вглубь идти некуда —
      // без этой проверки марка задваивалась бы сама под собой третьим
      // уровнем.
      childrenForChild: sv => (FLAT_MARK_TYPES.has(subtypeElementTypeForLogicalKey(sv)) ? [] : (marksBySubtype.get(sv) || [])),
      excludedSet: state.placementFilters.mark,
      labelFor: markLabelFor,
      isEnabledFn: enabledFor("mark"),
      expandedSet: state.placementGroupsExpanded.subtype,
    }
  ));

  container.appendChild(buildFilterGroup(
    "Статус", "status", allValuesFor("status"), state.placementFilters.status, statusLabelFor, enabledFor("status"), onPlacementFilterChange
  ));

  // Поставщик / Контракт — иерархически, тем же приёмом, что Кран/Стоянка
  // и Тип/Подтип (см. Docs/backlog.md, "Групповая смена статуса"), но
  // источник значений — не элементы/зоны, а сам справочник контрактов
  // (state.contracts) — поставщик и контракт без ни одного элемента
  // всё равно должны быть в списке (см. allValuesFor).
  const supplierLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("supplier") : v;
  const contractLabelFor = v => {
    if (v === PLACEMENT_NONE) return placementNoneLabel("contract");
    const c = state.contracts.find(c => c.id === v);
    return c ? c.name : `контракт #${v}`;
  };
  const supplierValues = allValuesFor("supplier");
  const contractValues = allValuesFor("contract");
  const contractsBySupplier = new Map();
  for (const cv of contractValues) {
    if (cv === PLACEMENT_NONE) continue; // элементы без контракта — отдельным пунктом ниже, не под поставщиком
    const c = state.contracts.find(c => c.id === cv);
    const sv = c ? c.supplier : PLACEMENT_NONE;
    if (!contractsBySupplier.has(sv)) contractsBySupplier.set(sv, []);
    contractsBySupplier.get(sv).push(cv);
  }
  const supplierHeadings = Array.from(new Set([...supplierValues, ...contractsBySupplier.keys()])).sort(placementComparator(supplierLabelFor));
  for (const h of supplierHeadings) contractsBySupplier.get(h)?.sort(placementComparator(contractLabelFor));
  container.appendChild(buildHierarchicalFilterGroup(
    "Поставщик / Контракт", "supplier", supplierHeadings, state.placementFilters.supplier, supplierLabelFor, enabledFor("supplier"),
    sv => contractsBySupplier.get(sv) || [], state.placementFilters.contract, contractLabelFor, enabledFor("contract"),
    onPlacementFilterChange, state.placementGroupsExpanded.supplier
  ));

  // Ни поставщик, ни контракт не определены вовсе (у элемента нет
  // contract_id) — отдельным пунктом вне иерархии, по аналогии с "Кран и
  // стоянка — не определены" выше.
  if (contractValues.has(PLACEMENT_NONE)) {
    container.appendChild(buildFilterGroup(
      "Без контракта", "noContract", new Set([PLACEMENT_NONE]), state.placementFilters.contract,
      () => "элементы без контракта", enabledFor("contract"), onPlacementFilterChange
    ));
  }

  applyMarkSearchFilter();
}

// ---------- поиск по марке (см. Docs/backlog.md, разбор UX) ----------
// Живёт СНАРУЖИ #placement-filters (см. index.html) — renderPlacementFilters
// перестраивает контейнер целиком на каждое изменение фильтра, инпут вне
// него переживает перерисовку без потери введённого текста/фокуса.
// Фильтрует только уровень "Марка" в группе "Тип элемента / Подтип / Марка"
// (там и был затык — у некоторых подтипов 300+ марок плоским списком,
// заказчик в своё время сознательно отказался от поиска, но список
// разросся ещё сильнее с тех пор, см. Docs/backlog.md) — совпавшие строки
// раскрывают цепочку родителей (тип → подтип → сама верхнеуровневая группа),
// чтобы результат сразу был виден, а не спрятан за свёрнутыми уровнями.
const markSearchInput = document.getElementById("mark-search-input");
function applyMarkSearchFilter() {
  const q = markSearchInput.value.trim().toLowerCase();
  const group = document.querySelector('#placement-filters .filter-group[data-filter-key="elementType"]');
  if (!group) return;
  const body = group.querySelector(".filter-group-body");
  group.querySelectorAll(".toggle.filter-grandchild").forEach(label => {
    const match = !q || label.textContent.toLowerCase().includes(q);
    label.style.display = match ? "" : "none";
    if (!q || !match) return;
    // Раскрыть цепочку родителей — grandchildBox (марки) → childrenBox
    // (подтипы) → сама группа целиком, иначе совпадение спрятано за
    // свёрнутым уровнем (см. CSS .filter-children/.filter-group-body).
    let node = label.closest(".filter-children");
    while (node) {
      node.classList.add("open");
      const prevBtn = node.previousElementSibling && node.previousElementSibling.querySelector
        ? node.previousElementSibling.querySelector(".filter-expand-btn") : null;
      if (prevBtn) { prevBtn.textContent = "▾"; prevBtn.title = "Свернуть"; }
      node = node.parentElement ? node.parentElement.closest(".filter-children") : null;
    }
    if (body && !body.classList.contains("open")) {
      body.classList.add("open");
      if (body._toggleBtn) { body._toggleBtn.textContent = "▾"; body._toggleBtn.title = "Свернуть"; }
    }
  });
}
markSearchInput.addEventListener("input", applyMarkSearchFilter);

function renderAxisGrid(data) {
  const layer = document.getElementById("axis-layer");
  layer.innerHTML = "";
  state.axisNumeric = [];
  state.axisLetter = [];
  const { numeric, letter } = data.axis_grid;
  const numKeys = Object.keys(numeric), letKeys = Object.keys(letter);
  if (!numKeys.length || !letKeys.length) return;

  const numVals = Object.values(numeric), letVals = Object.values(letter);
  const xMin = Math.min(...numVals), xMax = Math.max(...numVals);
  const yMin = Math.min(...letVals), yMax = Math.max(...letVals);
  const margin = Math.max(xMax - xMin, yMax - yMin) * 0.03;
  const labelOffset = margin * 1.8;
  const fontSize = data.marker_radius * 2.2;

  const g = el("g", { stroke: "#c4c4c4", fill: "#9a9a9a" });

  const numEntries = Object.entries(numeric).sort((a, b) => a[1] - b[1]);
  for (const [label, x] of numEntries) {
    const y0 = yMin - margin, y1 = yMax + margin;
    g.appendChild(el("line", { x1: x, y1: y0, x2: x, y2: y1, "vector-effect": "non-scaling-stroke", "stroke-width": 1 }));
    const elTop = flippedText(x, y0 - labelOffset, label, fontSize, "middle");
    const elBottom = flippedText(x, y1 + labelOffset, label, fontSize, "middle");
    g.appendChild(elTop);
    g.appendChild(elBottom);
    state.axisNumeric.push({ label, x, elTop, elBottom });
  }
  const letEntries = Object.entries(letter).sort((a, b) => a[1] - b[1]);
  for (const [label, y] of letEntries) {
    const x0 = xMin - margin, x1 = xMax + margin;
    g.appendChild(el("line", { x1: x0, y1: y, x2: x1, y2: y, "vector-effect": "non-scaling-stroke", "stroke-width": 1 }));
    const elText = flippedText(x0 - labelOffset, y, label, fontSize, "middle");
    g.appendChild(elText);
    state.axisLetter.push({ label, y, el: elText });
  }
  layer.appendChild(g);
}

function colorFor(status) {
  return state.statusColors[status] || "#999999";
}

// ---------- форма маркера по (слой, тип элемента) — п.11 третьего раунда,
// "как в оригинале" (outline) — реальный контур вытянутых элементов вместо
// условного маркера фиксированного размера (см. Docs/backlog.md). ----------
const SHAPE_TAGS = { circle: "circle", square: "rect", triangle: "polygon", diamond: "polygon", hexagon: "polygon", outline: "polygon" };

function shapeKeyFor(layer, elementType) { return `${layer} ${elementType}`; }
// По умолчанию — "как в оригинале" (реальный контур из DXF), а не условный
// маркер: см. Docs/backlog.md. Переопределяется в "Настройки → Форма
// маркеров" (element_shapes в БД), настройка сохраняется на сервере.
function shapeNameFor(element) { return state.elementShapes[shapeKeyFor(element.layer, element.element_type)] || "outline"; }

// Форма "outline" нарисуема только если у элемента реально есть сохранённый
// контур (только у элементов из LWPOLYLINE — см. app/main.py /plan-data).
// Если назначена "outline", но контура нет (например, колонна из
// INSERT-блока), молча откатываемся на круг — не оставляем элемент без
// маркера вообще.
function effectiveShapeNameFor(element) {
  const assigned = shapeNameFor(element);
  if (assigned === "outline" && (!element.outline || element.outline.length < 3)) return "circle";
  return assigned;
}

function polygonPoints(cx, cy, r, sides, rotate) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotate + i * (2 * Math.PI / sides);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

function shapeGeometryAttrs(shapeName, cx, cy, r, outline) {
  switch (shapeName) {
    case "square": return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
    case "triangle": return { points: polygonPoints(cx, cy, r, 3, -Math.PI / 2) };
    case "diamond": return { points: polygonPoints(cx, cy, r, 4, -Math.PI / 4) };
    case "hexagon": return { points: polygonPoints(cx, cy, r, 6, 0) };
    // Контур уже в мировых координатах (как оси/сетка) — рисуется как есть,
    // без привязки к cx/cy/r условного маркера.
    case "outline": return { points: outline.map(p => `${p[0]},${p[1]}`).join(" ") };
    default: return { cx, cy, r };
  }
}

function updateShapeGeometry(node, shapeName, cx, cy, r, outline) {
  const attrs = shapeGeometryAttrs(shapeName, cx, cy, r, outline);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
}

function styleShape(shape, element) {
  const selected = state.selectedId === element.id;
  shape.setAttribute("fill", colorFor(element.current_status));
  shape.setAttribute("fill-opacity", "1");
  shape.classList.toggle("selected", selected);
  shape.classList.toggle("multi-selected", state.multiSelectedIds.has(element.id));
  if (!selected) {
    shape.setAttribute("stroke", IN_PROJECT_STROKE);
    if (element.axis_status === "outside_axis_grid" || element.axis_status === "no_axis_grid") {
      shape.setAttribute("stroke-dasharray", NO_AXIS_DASH);
    } else {
      shape.removeAttribute("stroke-dasharray");
    }
  } else {
    shape.removeAttribute("stroke-dasharray");
  }
  update3DElementAppearance(element, selected);
}

// Тот же цвет статуса и та же подсветка выбора, что и у 2D-фигуры (см.
// styleShape выше) — переносим на 3D-меш, если сцена уже построена
// ("3D-режим схемы", Docs/backlog.md). Не пересобирает геометрию, только
// материал — дёшево, можно дёргать на каждую смену статуса/выбора.
function update3DElementAppearance(element, selected) {
  const mesh = state.view3d.meshById.get(element.id);
  if (!mesh) return;
  // Материал теперь общий на статус, не свой на элемент (см.
  // getStatusMeshMaterial) — при смене статуса/выбора элемент ПЕРЕКЛЮЧАЕТСЯ
  // на нужный общий материал, а не перекрашивает свой собственный (иначе
  // перекрасило бы ВСЕ элементы, делящие тот же материал).
  mesh.material = selected ? getHighlightMeshMaterial(element.current_status) : getStatusMeshMaterial(element.current_status);
  // Рёбра — фиксированный чёрный (EDGE_COLOR), не статусный цвет — не
  // пересчитываются при смене статуса.
}

// ---------- допстрока подписи (партия), см. Docs/backlog.md, "Партия —
// учёт по маркам" — вторая, более мелкая строка под маркой, если элемент
// в процессе поставки (Контрактация/В производстве/Отгружен) уже
// назначен на партию. Пропадает, когда элемент физически на площадке
// (Доставлен и далее) — плановая дата поставки партии там уже неактуальна. ----------
const BATCH_SUBLABEL_STATUSES = new Set(["contracting", "in_production", "shipped"]);
const SUBLABEL_FONT_SCALE = 0.75; // мельче основной подписи — вторична по значимости
const SUBLABEL_GAP_SCALE = 1.5; // множитель font-size — вертикальный зазор между строками
// Запас вокруг бокса подписи марки при проверке пересечений (и при
// начальном выборе позиции в computeLabelOffsets, и при перерасчёте
// видимости на каждый зум в updateLabelCollisionVisibility). Задумывался
// как небольшая защита от того, что два по-настоящему разных бокса
// примыкают друг к другу без единого пикселя зазора — но на реальных
// данных типовой шаг между соседними (честно РАЗНЫМИ) плитами в ряду —
// всего ~1200мм, а MIN_LABEL_FONT_PX-пол держит effectiveFont довольно
// крупным (сотни мм в мировых единицах) вплоть до очень сильного зума;
// добавка 0.35 к обеим сторонам бокса делала итоговую высоту бокса БОЛЬШЕ
// этого шага — из-за чего почти весь ряд честно разных подписей гасил
// друг друга и не появлялся даже на большом масштабе (живой разбор,
// Docs/backlog.md — "надписи не появляются"). 0.08 — компромисс: чуть
// расталкивает подписи, но не настолько, чтобы систематически ломать
// типовой шаг между соседними элементами.
const LABEL_GAP_MARGIN_SCALE = 0.08;

function elementSubLabelText(element) {
  if (!element.batch_id || !BATCH_SUBLABEL_STATUSES.has(element.current_status)) return null;
  if (!element.batch_planned_date) return null; // партия не резолвилась — не показываем мусор
  return element.contract_code ? `${element.contract_code}. ${element.batch_planned_date}` : element.batch_planned_date;
}

// Точечное обновление допстроки ОДНОГО элемента после смены статуса/
// партии — без полного renderElements(). Создаёт/обновляет/удаляет DOM-
// узел по необходимости; если элемент сейчас не отрисован на схеме
// (скрыт фильтром через display:none у родителя — сама подпись при этом
// всё равно существует в DOM) или вовсе не отрисован (другой файл/слои),
// state.labelById не найдёт узел — тихо выходим.
function updateElementSubLabel(element) {
  const label = state.labelById.get(element.id);
  if (label && state.view) {
    const subText = elementSubLabelText(element);
    let subLabel = state.subLabelById.get(element.id);
    if (!subText) {
      if (subLabel) {
        subLabel.remove();
        state.subLabelById.delete(element.id);
      }
    } else {
      const { effectiveR, effectiveFont } = computeEffectiveMarkerSizing();
      const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
      const x = element.x + cand.dx * effectiveR;
      const y = element.y + cand.dy * effectiveR - effectiveFont * SUBLABEL_GAP_SCALE;
      if (!subLabel) {
        subLabel = flippedText(x, y, subText, effectiveFont * SUBLABEL_FONT_SCALE, cand.anchor, {
          class: "mark-sublabel", "data-type": element.element_type,
        });
        if (state.labelVisibility[element.element_type] === false) subLabel.style.display = "none";
        label.parentNode.appendChild(subLabel);
        state.subLabelById.set(element.id, subLabel);
      } else {
        subLabel.textContent = subText;
        subLabel.setAttribute("transform", `translate(${x},${y}) scale(1,-1)`);
        subLabel.setAttribute("font-size", (effectiveFont * SUBLABEL_FONT_SCALE).toFixed(2));
      }
    }
  }
  rebuild3DLabelSprite(element); // независимо от 2D — своя ветка на v3.scene ? null внутри
}

// ---------- разводка накладывающихся подписей марок ----------
const LABEL_CANDIDATES = [
  { dx: 1.3, dy: 0, anchor: "start" },
  { dx: 1.0, dy: 1.2, anchor: "start" },
  { dx: 1.0, dy: -1.2, anchor: "start" },
  { dx: 0, dy: 1.4, anchor: "middle" },
  { dx: 0, dy: -1.4, anchor: "middle" },
  { dx: -1.3, dy: 0, anchor: "end" },
];

function computeLabelOffsets(elements, baseRadius) {
  const fontSize = baseRadius * 1.3;
  const charW = fontSize * 0.62;
  const bucketSize = Math.max(fontSize * 6, baseRadius * 10);
  const buckets = new Map();
  const offsets = new Map();

  function bucketKey(x, y) { return `${Math.floor(x / bucketSize)},${Math.floor(y / bucketSize)}`; }
  function nearbyBoxes(x, y) {
    const bx = Math.floor(x / bucketSize), by = Math.floor(y / bucketSize);
    const result = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (arr) result.push(...arr);
      }
    }
    return result;
  }
  function overlaps(a, b) { return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY; }
  function boxFor(element, cand) {
    const cx = element.x + cand.dx * baseRadius;
    const cy = element.y + cand.dy * baseRadius;
    const w = ((element.mark || "").length || 1) * charW;
    const h = fontSize * 1.2;
    let minX, maxX;
    if (cand.anchor === "start") { minX = cx; maxX = cx + w; }
    else if (cand.anchor === "end") { minX = cx - w; maxX = cx; }
    else { minX = cx - w / 2; maxX = cx + w / 2; }
    // Небольшой запас со всех сторон — без него две ДЕЙСТВИТЕЛЬНО разные,
    // не пересекающиеся по боксу подписи могли вплотную примыкать друг к
    // другу без единого пикселя зазора, читаясь как одна слипшаяся строка
    // (см. LABEL_GAP_MARGIN_SCALE ниже, тот же приём в updateLabelCollisionVisibility).
    const margin = fontSize * LABEL_GAP_MARGIN_SCALE;
    return { minX: minX - margin, maxX: maxX + margin, minY: cy - h / 2 - margin, maxY: cy + h / 2 + margin };
  }

  for (const element of elements) {
    if (!element.mark) { offsets.set(element.id, LABEL_CANDIDATES[0]); continue; }
    let chosen = LABEL_CANDIDATES[0];
    let chosenBox = boxFor(element, chosen);
    for (const cand of LABEL_CANDIDATES) {
      const box = boxFor(element, cand);
      const near = nearbyBoxes(element.x, element.y);
      if (!near.some(b => overlaps(b, box))) { chosen = cand; chosenBox = box; break; }
    }
    offsets.set(element.id, chosen);
    const key = bucketKey(element.x, element.y);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(chosenBox);
  }
  return offsets;
}

function renderElements(data) {
  const layer = document.getElementById("elements-layer");
  // Подписи — в ОТДЕЛЬНОМ слое поверх ВСЕХ фигур (не внутри одной группы
  // "фигура+подпись на элемент"), а не в одном слое вперемешку с фигурами.
  // Многоярусные конструкции (колонна/ригель одной и той же (x,y), разные
  // отметки — см. estimate_marker_radius) в 2D рисуются друг на друге в
  // одной точке; при старой схеме подпись НИЖНЕГО яруса (раньше в DOM =
  // раньше по z-порядку в SVG) оказывалась ПОД непрозрачной фигурой
  // верхнего яруса и была невидима НАВСЕГДА, даже когда включена в
  // настройках — подпись реально существовала в DOM, просто её нечем было
  // увидеть. Один общий слой подписей поверх слоя фигур убирает этот класс
  // перекрытия целиком — но открывает ДРУГУЮ проблему: теперь видны
  // подписи ВСЕХ ярусов сразу, даже тех, чья фигура сейчас реально скрыта
  // под фигурой более верхнего яруса (или выключена фильтром) — непонятно,
  // какой маркой на самом деле подписана видимая фигура. Заказчик
  // подтвердил: подпись должна быть только у самого верхнего ПРОШЕДШЕГО
  // ФИЛЬТР яруса в каждой точке плана (см. topVisibleLabelIds ниже,
  // применяется в applyPlacementFilters) — коллизии САМИХ подписей друг с
  // другом (несколько НЕ перекрывающихся по (x,y) элементов рядом на
  // экране) по-прежнему решает updateLabelCollisionVisibility (см.
  // Docs/backlog.md).
  const labelsLayer = document.getElementById("labels-layer");
  layer.innerHTML = "";
  labelsLayer.innerHTML = "";
  state.byId.clear();
  state.shapeById.clear();
  state.labelById.clear();
  state.subLabelById.clear();
  state.labelGroupById.clear();

  const r = data.marker_radius;
  state.labelOffsetById = computeLabelOffsets(data.elements, r);

  // Сортировка по отметке (по возрастанию) — фигура ВЕРХНЕГО яруса
  // рисуется ПОСЛЕДНЕЙ = визуально поверх фигур более ранних ярусов той
  // же точки плана (многоярусные конструкции, одна и та же (x,y) — см.
  // комментарий про labels-layer выше). Иначе видимый на экране цвет
  // статуса и подпись (см. topVisibleLabelIds — тоже "самый верхний
  // ярус, прошедший фильтр") могли бы относиться к РАЗНЫМ ярусам, не
  // совпадая — заказчик подтвердил, что подпись должна принадлежать
  // именно видимой фигуре (см. Docs/backlog.md).
  const sortedElements = [...data.elements].sort(
    (a, b) => (a.elevation_mm ?? -Infinity) - (b.elevation_mm ?? -Infinity)
  );

  for (const element of sortedElements) {
    state.byId.set(element.id, element);

    const shapeName = effectiveShapeNameFor(element);
    const shape = el(SHAPE_TAGS[shapeName] || "circle", {
      ...shapeGeometryAttrs(shapeName, element.x, element.y, r, element.outline),
      "stroke-width": 1.4, "vector-effect": "non-scaling-stroke",
      "data-id": element.id, "data-shape": shapeName, class: "element-shape",
    });
    styleShape(shape, element);
    layer.appendChild(shape);
    state.shapeById.set(element.id, shape);

    // Подпись(+допстрока) — в СВОЕЙ маленькой группе внутри labelsLayer, а
    // не сама по себе — applyPlacementFilters скрывает элемент целиком
    // (фигуру и подпись) по фильтру размещения, и нужен узел на КАЖДЫЙ
    // элемент отдельно, а не общий labelsLayer на все сразу (иначе один
    // непрошедший фильтр элемент прятал бы подписи ВСЕХ остальных — см.
    // Docs/backlog.md). Видимость самой подписи внутри группы (тип
    // подписи включён/выключен, коллизия с соседней подписью) — своя,
    // независимая от фильтра, см. ниже.
    const labelGroup = el("g");
    labelsLayer.appendChild(labelGroup);
    state.labelGroupById.set(element.id, labelGroup);

    const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
    const label = flippedText(
      element.x + cand.dx * r, element.y + cand.dy * r, element.mark || "", r * 1.3, cand.anchor,
      { class: "mark-label", "data-type": element.element_type }
    );
    if (state.labelVisibility[element.element_type] === false) label.style.display = "none";
    labelGroup.appendChild(label);
    state.labelById.set(element.id, label);

    const subText = elementSubLabelText(element);
    if (subText) {
      const subLabel = flippedText(
        element.x + cand.dx * r, element.y + cand.dy * r, subText, r * 1.3 * SUBLABEL_FONT_SCALE, cand.anchor,
        { class: "mark-sublabel", "data-type": element.element_type }
      );
      if (state.labelVisibility[element.element_type] === false) subLabel.style.display = "none";
      labelGroup.appendChild(subLabel);
      state.subLabelById.set(element.id, subLabel);
    }
  }

  updateSizesForZoom();
  applyPlacementFilters(); // новые фигуры/подписи ещё не скрыты по текущему фильтру — применить сразу
}

// Статусы x типы элементов — сколько элементов каждого типа сейчас в
// каждом статусе (не зависит от фильтров отображения на схеме, см.
// applyPlacementFilters — легенда всегда показывает полный набор
// выбранных файлов/слоёв, а не то, что видно на экране прямо сейчас).
function renderLegend() {
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  // Легенда считается по элементам, прошедшим текущий фильтр по
  // размещению (сайдбар → Фильтры) — сознательно ОТЛИЧИЕ от прежнего
  // поведения (было: полная выборка файлов/слоёв, без учёта фильтра) —
  // запрошено явно, см. Docs/backlog.md, item 10.
  const visible = state.elements.filter(passesPlacementFilters);
  if (!visible.length) {
    legend.innerHTML = '<div style="color:var(--color-text-muted)">нет данных</div>';
    return;
  }

  const types = Array.from(new Set(visible.map(e => e.element_type))).sort((a, b) => a.localeCompare(b, "ru"));
  const counts = {}; // status -> type -> n
  for (const status of state.statusOrder) counts[status] = {};
  for (const e of visible) {
    const byType = counts[e.current_status];
    if (!byType) continue; // неизвестный статус — не должно случаться, но не падаем
    byType[e.element_type] = (byType[e.element_type] || 0) + 1;
  }

  const wrap = document.createElement("div");
  wrap.className = "legend-table-wrap";
  const table = document.createElement("table");
  table.className = "legend-table";

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const t of types) {
    const th = document.createElement("th");
    th.textContent = t;
    headRow.appendChild(th);
  }
  const thTotal = document.createElement("th");
  thTotal.textContent = "Всего";
  headRow.appendChild(thTotal);
  table.appendChild(headRow);

  const colTotals = types.map(() => 0);
  let grandTotal = 0;
  for (const status of state.statusOrder) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.className = "legend-label";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colorFor(status);
    tdLabel.appendChild(swatch);
    tdLabel.appendChild(document.createTextNode(state.statusLabels[status]));
    tr.appendChild(tdLabel);

    let rowTotal = 0;
    types.forEach((t, i) => {
      const n = counts[status][t] || 0;
      rowTotal += n;
      colTotals[i] += n;
      const td = document.createElement("td");
      td.textContent = n || "";
      tr.appendChild(td);
    });
    const tdRowTotal = document.createElement("td");
    tdRowTotal.textContent = rowTotal;
    tdRowTotal.style.fontWeight = "600";
    tr.appendChild(tdRowTotal);
    grandTotal += rowTotal;
    table.appendChild(tr);
  }

  const totalRow = document.createElement("tr");
  totalRow.className = "legend-total-row";
  const tdTotalLabel = document.createElement("td");
  tdTotalLabel.textContent = "Итого";
  totalRow.appendChild(tdTotalLabel);
  colTotals.forEach(n => {
    const td = document.createElement("td");
    td.textContent = n;
    totalRow.appendChild(td);
  });
  const tdGrand = document.createElement("td");
  tdGrand.textContent = grandTotal;
  totalRow.appendChild(tdGrand);
  table.appendChild(totalRow);

  wrap.appendChild(table);
  legend.appendChild(wrap);
  // Признак "есть куда скроллить" (правый выцветающий край, см. CSS) —
  // таблица растёт вширь с числом типов элементов и раньше молча
  // обрезалась шириной сайдбара без всякого намёка на это (см.
  // Docs/backlog.md, разбор UX). rAF — даём браузеру посчитать layout
  // перед сравнением scrollWidth/clientWidth.
  requestAnimationFrame(() => {
    wrap.classList.toggle("scrollable", wrap.scrollWidth > wrap.clientWidth + 1);
  });
}

// ---------- сворачиваемая легенда (см. Docs/backlog.md, разбор UX) ----------
// Легенда и карточка выбранного элемента жили в одной вкладке "Свойства" —
// после клика по элементу приходилось всегда скроллить мимо легенды, чтобы
// увидеть карточку. Ручной тумблер + автосворачивание один раз при первом
// выборе элемента за сеанс (дальше — не мешаем ручному выбору пользователя).
const LEGEND_COLLAPSE_KEY = "zhbi_legend_collapsed";
let legendAutoCollapseDone = false;
function setLegendCollapsed(collapsed) {
  document.getElementById("legend").classList.toggle("collapsed", collapsed);
  document.getElementById("legend-toggle-btn").textContent = collapsed ? "▸" : "▾";
  localStorage.setItem(LEGEND_COLLAPSE_KEY, collapsed ? "1" : "0");
}
setLegendCollapsed(localStorage.getItem(LEGEND_COLLAPSE_KEY) === "1");
document.getElementById("legend-toggle-btn").addEventListener("click", () => {
  legendAutoCollapseDone = true; // ручное действие — больше не трогаем автоматикой
  setLegendCollapsed(!document.getElementById("legend").classList.contains("collapsed"));
});

function renderLabelToggles() {
  const box = document.getElementById("label-toggles");
  box.innerHTML = "";
  const types = Object.keys(state.labelVisibility);
  if (!types.length) {
    box.innerHTML = '<div style="color:var(--color-text-muted)">нет данных</div>';
    return;
  }
  for (const type of types) {
    const label = document.createElement("label");
    label.className = "toggle";
    const checked = state.labelVisibility[type] !== false;
    label.innerHTML = `<input type="checkbox" data-type="${escapeHtml(type)}" ${checked ? "checked" : ""}/> ${escapeHtml(type)}`;
    label.querySelector("input").addEventListener("change", (e) => {
      state.labelVisibility[type] = e.target.checked;
      if (!e.target.checked) {
        // Скрыть — можно форсировать сразу: updateLabelCollisionVisibility
        // ниже пропускает выключенные типы целиком (см. её же проверку
        // state.labelVisibility[...] === false) и не тронет их display,
        // так что снятие галочки нужно применить явно и немедленно.
        document.querySelectorAll(`.mark-label[data-type="${type}"], .mark-sublabel[data-type="${type}"]`).forEach(t => {
          t.style.display = "none";
        });
      } else {
        // Показать — НЕ форсировать display:"" напрямую на все подписи
        // этого типа разом: это включало ВСЕ марки без прореживания по
        // коллизиям (даже там, где их физически некуда уместить) — на
        // плотных участках подписи наползали друг на друга сплошной стеной
        // (см. Docs/backlog.md, живой разбор). Пересчитываем видимость тем
        // же алгоритмом, что и обычный зум/пан — ровно как если бы
        // прокрутили колесо мыши на текущем месте.
        updateSizesForZoom();
      }
      apply3DLabelVisibility();
    });
    box.appendChild(label);
  }
}

// Вынесено из updateSizesForZoom — переиспользуется точечным
// updateElementSubLabel (не гонять полный цикл по всем элементам ради
// одной допстроки после смены статуса/партии одного элемента).
function computeEffectiveMarkerSizing() {
  const stage = document.getElementById("stage");
  const pxPerUnitX = stage.clientWidth / state.view.w;
  const pxPerUnitY = stage.clientHeight / state.view.h;
  const pxPerUnit = Math.min(pxPerUnitX, pxPerUnitY) || 1;
  const baseR = state.baseMarkerRadius;
  const effectiveR = Math.min(baseR, MAX_MARKER_PX / pxPerUnit);
  const baseFont = baseR * 1.3;
  const effectiveFont = Math.max(Math.min(baseFont, MAX_LABEL_FONT_PX / pxPerUnit), MIN_LABEL_FONT_PX / pxPerUnit);
  return { pxPerUnit, effectiveR, effectiveFont };
}

// ---------- предел размера маркеров/подписей + прореживание подписей осей при zoom ----------
function updateSizesForZoom() {
  if (!state.view) return;
  const { pxPerUnit, effectiveR, effectiveFont } = computeEffectiveMarkerSizing();

  for (const element of state.elements) {
    const shape = state.shapeById.get(element.id);
    if (shape) {
      const shapeName = shape.dataset.shape || "circle";
      // "outline" — реальный контур в мировых координатах, уже корректно
      // масштабируется вместе со всем слоем через viewBox SVG (как сетка
      // осей) — пересчитывать геометрию на каждый zoom не нужно, в отличие
      // от условных маркеров с экранным пределом размера.
      if (shapeName !== "outline") updateShapeGeometry(shape, shapeName, element.x, element.y, effectiveR);
    }

    const label = state.labelById.get(element.id);
    if (!label) continue;
    const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
    const x = element.x + cand.dx * effectiveR;
    const y = element.y + cand.dy * effectiveR;
    label.setAttribute("transform", `translate(${x},${y}) scale(1,-1)`);
    label.setAttribute("font-size", effectiveFont.toFixed(2));

    const subLabel = state.subLabelById.get(element.id);
    if (subLabel) {
      const subFont = effectiveFont * SUBLABEL_FONT_SCALE;
      // Меньшая мировая Y — ниже на экране (viewBox.y = -max_y даёт
      // "мировой Y вверх = экранный верх", см. Docs/backlog.md).
      const subY = y - effectiveFont * SUBLABEL_GAP_SCALE;
      subLabel.setAttribute("transform", `translate(${x},${subY}) scale(1,-1)`);
      subLabel.setAttribute("font-size", subFont.toFixed(2));
    }
  }

  const effectiveZoneFont = MAX_ZONE_FONT_PX / pxPerUnit;
  for (const { el: labelEl, baseFontSize } of state.zoneLabelEls) {
    labelEl.setAttribute("font-size", Math.min(baseFontSize, effectiveZoneFont).toFixed(2));
  }
  updateZoneLabelCollisionVisibility(effectiveZoneFont);

  updateAxisLabelSizing(pxPerUnit);
  updateLabelCollisionVisibility(effectiveR, effectiveFont);
  updateScrollbars();
  updateZoomIndicator(pxPerUnit);
}

// ---------- скрыть подписи марок, которые пересекаются при текущем масштабе, показать
// обратно по мере приближения (п.4 третьего раунда — тот же паттерн, что у подписей осей).
// effectiveFont уменьшается в мировых единицах по мере зума — при приближении боксы
// подписей "сжимаются" относительно неизменного мирового расстояния между элементами,
// поэтому часть подписей естественно открывается без отдельной логики "показывать больше". ----------
const LABEL_COLLISION_BUCKET_MIN = 1e-6;

function updateLabelCollisionVisibility(effectiveR, effectiveFont) {
  const charW = effectiveFont * 0.62;
  const bucketSize = Math.max(effectiveFont * 6, effectiveR * 10, LABEL_COLLISION_BUCKET_MIN);
  const buckets = new Map();

  function bucketKey(x, y) { return `${Math.floor(x / bucketSize)},${Math.floor(y / bucketSize)}`; }
  function nearbyBoxes(x, y) {
    const bx = Math.floor(x / bucketSize), by = Math.floor(y / bucketSize);
    const result = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (arr) result.push(...arr);
      }
    }
    return result;
  }
  function overlaps(a, b) { return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY; }

  for (const element of state.elements) {
    const label = state.labelById.get(element.id);
    if (!label || !element.mark) continue;
    if (state.labelVisibility[element.element_type] === false) continue; // уже скрыто настройкой типа — не занимает место в сетке
    // labelGroup скрыт целиком — либо элемент не проходит фильтр
    // размещения, либо (см. topVisibleLabelIds) это НЕ верхний ярус в
    // своей точке плана. Раньше такие элементы всё равно участвовали в
    // расчёте коллизий и, будучи "не пересекающимися" сами по себе,
    // занимали место в сетке — блокируя показ ДЕЙСТВИТЕЛЬНО видимого
    // соседа, который проверялся позже и ложно считался пересекающимся с
    // фантомным боксом невидимого элемента. Раньше это было почти
    // незаметно (таких скрытых элементов было мало), но после того как
    // дедупликация по ярусам стала находить реальные дубли по всему
    // чертежу, доля таких "фантомов" выросла — и они массово гасили
    // честные соседние подписи (живой разбор, Docs/backlog.md —
    // "надписи не появляются", участок у оси 33/1).
    const labelGroup = state.labelGroupById.get(element.id);
    if (labelGroup && labelGroup.style.display === "none") continue;

    const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
    const cx = element.x + cand.dx * effectiveR;
    const cy = element.y + cand.dy * effectiveR;
    const w = (element.mark.length || 1) * charW;
    const h = effectiveFont * 1.2;
    let minX, maxX;
    if (cand.anchor === "start") { minX = cx; maxX = cx + w; }
    else if (cand.anchor === "end") { minX = cx - w; maxX = cx; }
    else { minX = cx - w / 2; maxX = cx + w / 2; }
    // Тот же запас, что в computeLabelOffsets (см. LABEL_GAP_MARGIN_SCALE) —
    // здесь пересчитывается на каждый зум, должен остаться согласованным.
    const margin = effectiveFont * LABEL_GAP_MARGIN_SCALE;
    const box = { minX: minX - margin, maxX: maxX + margin, minY: cy - h / 2 - margin, maxY: cy + h / 2 + margin };

    const collides = nearbyBoxes(element.x, element.y).some(b => overlaps(b, box));
    label.style.display = collides ? "none" : "";
    // Допстрока (партия) не участвует в отдельном расчёте коллизий —
    // видимость просто наследуется от основной строки (см. Docs/backlog.md,
    // "Партия — учёт по маркам") — простое решение для первой итерации,
    // как уже применялось к 3D-подписям в прошлом раунде.
    const subLabel = state.subLabelById.get(element.id);
    if (subLabel) subLabel.style.display = collides ? "none" : "";
    if (!collides) {
      const key = bucketKey(element.x, element.y);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(box);
    }
  }
}

// ---------- то же самое, но для подписей ЗОН (Захватка/Кран/Стоянка) —
// заказчик отдельно попросил проконтролировать, чтобы названия стоянок
// РАЗНЫХ ярусов не накладывались на плоском 2D-плане (несколько физических
// записей на одну стоянку теперь могут оказаться совсем рядом, см.
// zoneDisplayName/Docs/backlog.md). Тот же bucket-приём, что и у подписей
// марок выше — не переиспользую напрямую (там жёстко завязано на
// state.elements/effectiveR), но алгоритм идентичен. cx/cy/text
// зафиксированы один раз в renderZones (позиция зоны не меняется при
// зуме, в отличие от effectiveFont). ----------
function updateZoneLabelCollisionVisibility(effectiveZoneFont) {
  const bucketSize = Math.max(effectiveZoneFont * 6, LABEL_COLLISION_BUCKET_MIN);
  const buckets = new Map();

  function bucketKey(x, y) { return `${Math.floor(x / bucketSize)},${Math.floor(y / bucketSize)}`; }
  function nearbyBoxes(x, y) {
    const bx = Math.floor(x / bucketSize), by = Math.floor(y / bucketSize);
    const result = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (arr) result.push(...arr);
      }
    }
    return result;
  }
  function overlaps(a, b) { return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY; }

  for (const entry of state.zoneLabelEls) {
    const { el: labelEl, cx, cy, text, baseFontSize } = entry;
    const renderedFont = Math.min(baseFontSize, effectiveZoneFont);
    const w = (text.length || 1) * renderedFont * 0.62;
    const h = renderedFont * 1.2;
    const box = { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
    const collides = nearbyBoxes(cx, cy).some(b => overlaps(b, box));
    labelEl.style.display = collides ? "none" : "";
    if (!collides) {
      const key = bucketKey(cx, cy);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(box);
    }
  }
}

// ---------- подписи осей: закреплены на границах видимой области + прореживание при коллизии
// (п.1 второго раунда — предел размера; п.5 третьего раунда — закрепление на границах экрана,
// как замороженные заголовки строки/столбца в таблице, а не только предел размера). ----------
function updateAxisLabelSizing(pxPerUnit) {
  const v = state.view;
  // Видимая в данный момент область в мировых координатах (см. setView/loadPlan:
  // viewBox.y = -max_y, поэтому мировой Y восстанавливается обратным знаком).
  const visMinX = v.x, visMaxX = v.x + v.w;
  const visMinY = -(v.y + v.h), visMaxY = -v.y;
  const insetWorld = (MAX_AXIS_FONT_PX * 1.6) / pxPerUnit; // постоянный отступ от края экрана в px, вне зависимости от zoom
  const axisFont = MAX_AXIS_FONT_PX / pxPerUnit;
  const neededPx = MAX_AXIS_FONT_PX * 2.2; // приблизительная ширина, нужная подписи, чтобы не слипаться с соседней

  function thin(entries, coordKey, visMin, visMax, applyFn) {
    entries.forEach(e => applyFn(e, false));
    const visible = entries.filter(e => e[coordKey] >= visMin && e[coordKey] <= visMax);
    if (!visible.length) return;
    if (visible.length === 1) { applyFn(visible[0], true); return; }
    let minGap = Infinity;
    for (let i = 1; i < visible.length; i++) {
      minGap = Math.min(minGap, visible[i][coordKey] - visible[i - 1][coordKey]);
    }
    const gapPx = minGap * pxPerUnit;
    const step = gapPx > 0 ? Math.max(1, Math.ceil(neededPx / gapPx)) : visible.length;
    visible.forEach((e, i) => applyFn(e, i % step === 0));
  }

  thin(state.axisNumeric, "x", visMinX, visMaxX, (e, visible) => {
    e.elTop.style.display = visible ? "" : "none";
    e.elBottom.style.display = visible ? "" : "none";
    if (visible) {
      e.elTop.setAttribute("transform", `translate(${e.x},${visMaxY - insetWorld}) scale(1,-1)`);
      e.elTop.setAttribute("font-size", axisFont.toFixed(2));
      e.elBottom.setAttribute("transform", `translate(${e.x},${visMinY + insetWorld}) scale(1,-1)`);
      e.elBottom.setAttribute("font-size", axisFont.toFixed(2));
    }
  });
  thin(state.axisLetter, "y", visMinY, visMaxY, (e, visible) => {
    e.el.style.display = visible ? "" : "none";
    if (visible) {
      e.el.setAttribute("transform", `translate(${visMinX + insetWorld},${e.y}) scale(1,-1)`);
      e.el.setAttribute("font-size", axisFont.toFixed(2));
    }
  });
}

function setView(v) {
  state.view = v;
  document.getElementById("svg-root").setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  updateSizesForZoom();
}

// preserveView=true (по умолчанию) — не трогать текущий масштаб/пан при
// перезагрузке данных (смена состава слоёв/файлов, сохранение настроек и
// т.п. не должны "дёргать" схему). preserveView=false — пересчитать вид
// "по всей схеме" заново: нужно только при первой загрузке приложения и
// после загрузки СОВСЕМ ДРУГОГО чертежа (другие координаты/масштаб).
// Пустой выбор (сняты все галочки файлов) — не "нечего делать", а явное
// состояние "показывать нечего": рабочая область и карточка должны
// реально очиститься, а не оставлять последний отрисованный чертёж на
// экране (см. Docs/backlog.md).
function clearWorkspace() {
  document.getElementById("axis-layer").innerHTML = "";
  document.getElementById("zones-layer").innerHTML = "";
  document.getElementById("elements-layer").innerHTML = "";
  document.getElementById("labels-layer").innerHTML = "";
  state.elements = [];
  state.zones = [];
  state.zoneLabelEls = [];
  state.byId.clear();
  state.shapeById.clear();
  state.labelById.clear();
  state.subLabelById.clear();
  state.labelGroupById.clear();
  state.labelOffsetById.clear();
  state.selectedId = null;
  state.axisNumeric = [];
  state.axisLetter = [];
  state.view = null;
  state.initialView = null;
  for (const key of Object.keys(state.placementFilters)) state.placementFilters[key].clear();
  for (const key of Object.keys(state.placementGroupsExpanded)) state.placementGroupsExpanded[key].clear();
  state.stanceZoneVisible.clear();
  renderLegend();
  renderLabelToggles();
  renderZoneToggles();
  renderStanceZoneToggles();
  renderPlacementFilters();
  showPlaceholderCard();
  updateScrollbars();
  updateZoomIndicator();
  if (state.view3d.active) build3DScene(); // очистит сцену (state.elements сейчас пуст)
}

async function loadPlan(preserveView = true) {
  if (!state.selection.size) { clearWorkspace(); return; }
  const selection = Array.from(state.selection.entries()).map(([source_file, layers]) => ({
    source_file, layers: layers ? Array.from(layers) : null,
  }));
  const data = await api("/plan-data", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selection }),
  });
  state.elements = data.elements;
  state.statusColors = data.status_colors;
  state.statusOrder = data.status_order;
  state.statusLabels = data.status_labels;
  state.labelVisibility = data.label_visibility;
  state.contracts = data.contracts || [];
  state.defaultContracts = data.default_contracts || {};
  state.elementShapes = data.element_shapes || {};
  state.zones = data.zones || [];
  state.baseMarkerRadius = data.marker_radius;
  state.selectedId = null;

  renderAxisGrid(data);
  renderZones();
  renderElements(data);
  renderLegend();
  renderLabelToggles();
  renderZoneToggles();
  renderStanceZoneToggles();
  renderPlacementFilters();
  applyPlacementFilters();
  showPlaceholderCard();

  const b = data.bbox;
  state.initialView = { x: b.min_x, y: -b.max_y, w: b.max_x - b.min_x, h: b.max_y - b.min_y };
  if (preserveView && state.view) {
    // Масштаб/пан не трогаем — но размеры маркеров/подписей/зон под
    // текущий (неизменившийся) viewBox уже пересчитаны внутри renderElements()
    // выше через updateSizesForZoom(), обновлять здесь нечего ещё раз.
  } else {
    setView({ ...state.initialView });
  }
  // 3D — только если пользователь уже включал 3D в этом сеансе (ленивая
  // пересборка, см. "3D-режим схемы", Docs/backlog.md); иначе соберётся
  // сама при первом включении кнопкой.
  if (state.view3d.active) build3DScene();
}

// ==================== КАРТОЧКА ЭЛЕМЕНТА (сгруппирована по темам, п.11) ====================

const FIELD_LABELS = {
  id: "ID", dxf_handle: "DXF handle", layer: "Слой", element_type: "Тип",
  mark: "Марка", mark_source: "Источник марки", address: "Адрес по осям",
  axis_status: "Статус адресации", axis_number: "Числовая ось", axis_letter: "Буквенная ось",
  nearest_axis_number: "Ближайшая числовая ось", nearest_axis_letter: "Ближайшая буквенная ось",
  offset_x_mm: "Смещение X, мм", offset_y_mm: "Смещение Y, мм", x: "X, мм", y: "Y, мм",
  current_status: "Текущий статус", subtype: "Подтип", elevation_mm: "Отметка, мм",
};

// Разбор по важности для повседневной работы (см. Docs/backlog.md,
// разбор UX карточки): "Идентификатор/Адрес по осям/Координаты" — это
// внутренняя технотека DXF-разбора (id, сырое имя слоя, смещения от
// ближайшей оси и т.п.), нужная в основном при разборе проблемного
// импорта, не бригадиру на площадке каждый день. Раньше шла ПЕРЕД
// статусом/маркой в самом начале карточки — теперь убрана в
// сворачиваемый (по умолчанию закрыт) блок ниже, "Тип/Марка/Статус"
// показывается сразу, крупно, без прокрутки (см. showCard).
const TECHNICAL_FIELD_GROUPS = [
  { title: "Идентификатор", fields: ["id", "dxf_handle", "layer", "mark_source"] },
  { title: "Адрес по осям", fields: ["address", "axis_status", "axis_number", "axis_letter", "nearest_axis_number", "nearest_axis_letter", "offset_x_mm", "offset_y_mm"] },
  { title: "Координаты", fields: ["x", "y", "elevation_mm"] },
];

function fieldRowsHtml(element, fields) {
  return fields.map(k => {
    let v = element[k];
    if (k === "current_status") v = state.statusLabels[v] || v;
    // Координаты приходят сырым float из БД (десятки знаков после запятой,
    // напр. 139158.6789437191) — выглядит как баг, а не как данные;
    // для отображения округляем до мм, полная точность остаётся в
    // API/экспорте, тут не нужна.
    if ((k === "x" || k === "y") && typeof v === "number") v = Math.round(v);
    if (v === null || v === undefined || v === "") v = "—";
    return `<tr><td class="k">${escapeHtml(FIELD_LABELS[k] || k)}</td><td>${escapeHtml(v)}</td></tr>`;
  }).join("");
}

function showPlaceholderCard() {
  document.getElementById("card").innerHTML = '<div id="placeholder">Кликните по элементу на схеме</div>';
}

function contractLabelText(element) {
  // Контракт — только для чтения (п.7 третьего раунда): показывается по
  // текущему кэшу elements.contract_id, который всегда зеркалит contract_id
  // самой последней записи истории. Меняется только через диалог
  // подтверждения при смене статуса (openStatusContractDialog), не напрямую.
  if (!element.contract_id) return "—";
  const c = state.contracts.find(c => c.id === element.contract_id);
  return c ? `${escapeHtml(c.name)} (${escapeHtml(c.supplier)})` : `#${element.contract_id}`;
}

// Партия — внутри блока "Контракт" (по просьбе), не отдельным блоком.
// Кликабельна только для admin (партии, как и контракты, редактируются
// только им) — клик открывает ту же форму редактирования, что и модалка
// "Партии контракта" (openBatchEdit), см. Docs/backlog.md. Асинхронно —
// как и история статусов ниже — сама карточка уже отрисована синхронно
// с плейсхолдером ("Партия: загрузка…"/"Партия: —").
async function renderCardBatchLabel(element) {
  const box = document.getElementById("card-batch-label");
  if (!box || !element.batch_id) return;
  try {
    let batch = state.batchCache.get(element.batch_id);
    if (!batch) {
      batch = await api(`/batches/${element.batch_id}`);
      state.batchCache.set(element.batch_id, batch);
    }
    // Пока грузили — карточка могла перерисоваться для другого элемента.
    if (state.selectedId !== element.id) return;
    const freshBox = document.getElementById("card-batch-label");
    if (!freshBox) return;
    freshBox.textContent = "Партия: ";
    if (state.currentUser.role === "admin") {
      const link = document.createElement("a");
      link.href = "#";
      link.className = "card-batch-link";
      link.textContent = batch.label;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openBatchEdit(batch);
      });
      freshBox.appendChild(link);
    } else {
      freshBox.appendChild(document.createTextNode(batch.label));
    }
  } catch (e) {
    const freshBox = document.getElementById("card-batch-label");
    if (freshBox) freshBox.textContent = "Партия: ошибка загрузки";
  }
}

// ---------- привязка к зонам (захватка/кран/стоянка) — только для элементов
// нового стандарта имён слоёв, у старых zone_*_status всегда null ----------
const ZONE_STATUS_LABELS_RU = { unmatched: "не определено", needs_review: "требует проверки", not_applicable: "неприменимо" };
// Дефолты — ровно те же значения, что в CSS для #zones-layer polygon/text
// (см. index.html) — используются, только когда у зоны нет ИНДИВИДУАЛЬНОГО
// цвета (zone.color null, всегда так у Захватки — общая раскраска по
// категории, см. Docs/backlog.md). У Крана/Стоянки цвет обычно уже задан
// сервером (Стоянка наследует цвет своего крана), но дефолт на случай null
// не помешает.
const ZONE_CATEGORY_DEFAULT_COLOR = { "Захватка": "#1353d6", "Кран": "#c0392b", "Стоянка": "#7c3aed" };

// Значение — тем же цветом, что и сама зона на схеме (см. Docs/backlog.md,
// обсуждение UX: "стоит ли зоны в карточке элемента выделить тем же
// цветом") — раньше карточка просто печатала название зоны обычным
// текстом, никак не связывая его визуально с цветными зонами на плане.
function zoneBindingHtml(element, idField, statusField, category) {
  const status = element[statusField];
  if (status !== "matched") {
    return escapeHtml(ZONE_STATUS_LABELS_RU[status] || status);
  }
  const zone = state.zones.find(z => z.id === element[idField]);
  const name = zone ? (zone.name || `зона #${zone.id} (без названия)`) : `#${element[idField]}`;
  const color = (zone && zone.color) || ZONE_CATEGORY_DEFAULT_COLOR[category] || "#999999";
  return `<span class="swatch" style="background:${color}"></span><span style="color:${color}; font-weight:600;">${escapeHtml(name)}</span>`;
}

async function showCard(element) {
  const card = document.getElementById("card");
  const canEdit = state.currentUser.role === "admin" || state.currentUser.role === "user";
  const technicalHtml = TECHNICAL_FIELD_GROUPS.map(g => `
    <div class="card-block"><h4>${g.title}</h4><table>${fieldRowsHtml(element, g.fields)}</table></div>
  `).join("");
  const hasZoneData = element.zone_zakhvatka_status || element.zone_crane_status || element.zone_stance_status;
  const zonesBlockHtml = hasZoneData ? `
    <div class="card-block"><h4>Зоны</h4><table>
      <tr><td class="k">Захватка</td><td>${zoneBindingHtml(element, "zone_zakhvatka_id", "zone_zakhvatka_status", "Захватка")}</td></tr>
      <tr><td class="k">Кран</td><td>${zoneBindingHtml(element, "zone_crane_id", "zone_crane_status", "Кран")}</td></tr>
      <tr><td class="k">Стоянка</td><td>${zoneBindingHtml(element, "zone_stance_id", "zone_stance_status", "Стоянка")}</td></tr>
    </table></div>
  ` : "";
  // Основное — марка/тип/статус — сразу видно, без прокрутки мимо
  // технических полей (см. TECHNICAL_FIELD_GROUPS выше). Кнопки действий
  // тут же — раньше сменить статус/партию можно было только повторным
  // правым кликом по фигуре на схеме, отдельно от чтения карточки (см.
  // Docs/backlog.md, разбор UX) — теперь то же самое меню статуса и тот же
  // диалог партии, но без возврата на схему.
  // Тип элемента — тем же шрифтом/начертанием, что и марка (см.
  // Docs/backlog.md, разбор UX) — раньше был мелким серым служебным
  // текстом рядом с крупной жирной маркой, хотя тип для бригадира не
  // менее важен для идентификации элемента на схеме, чем сама марка.
  // Подтип остаётся мелким/приглушённым — это уточняющая деталь, не
  // основной идентификатор.
  const typeSubtypeHtml = element.subtype
    ? `${escapeHtml(element.element_type)} <span class="card-subtype">· ${escapeHtml(element.subtype)}</span>`
    : escapeHtml(element.element_type);
  card.innerHTML = `
    <div class="card-block card-primary">
      <div class="card-primary-row">
        <div class="card-primary-type">${typeSubtypeHtml}</div>
        <div class="card-primary-mark">${escapeHtml(element.mark || "—")}</div>
      </div>
      <div class="card-status-row">
        <span class="swatch" style="background:${colorFor(element.current_status)}"></span>
        <span class="card-status-label">${escapeHtml(state.statusLabels[element.current_status] || element.current_status)}</span>
      </div>
      ${canEdit ? `
        <div class="card-actions">
          <button type="button" class="btn btn-sm btn-secondary" id="card-change-status-btn">Изменить статус…</button>
          <button type="button" class="btn btn-sm btn-secondary" id="card-batch-btn">${element.batch_id ? "Изменить партию…" : "Выбрать партию…"}</button>
        </div>
      ` : ""}
    </div>
    <div class="card-block"><h4>Контракт</h4>
      <div>${contractLabelText(element)}</div>
      <div id="card-batch-label" class="hint-text">${element.batch_id ? "Партия: загрузка…" : "Партия: —"}</div>
    </div>
    ${zonesBlockHtml}
    <details class="card-technical">
      <summary>Технические данные</summary>
      ${technicalHtml}
    </details>
    <h3 style="margin-bottom:4px;">История статусов</h3><div id="history-box">Загрузка…</div>
  `;
  renderCardBatchLabel(element);

  if (canEdit) {
    document.getElementById("card-change-status-btn").addEventListener("click", (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      openCtxMenu(element, rect.left, rect.bottom + 4);
    });
    document.getElementById("card-batch-btn").addEventListener("click", () => {
      if (!element.contract_id) {
        showToast("У элемента нет контракта — сначала укажите его при смене статуса.");
        return;
      }
      openBatchAssignDialog(element);
    });
  }

  try {
    const detail = await api(`/elements/${element.id}`);
    const historyBox = document.getElementById("history-box");
    if (!historyBox) return;
    if (!detail.history.length) { historyBox.textContent = "нет записей"; return; }
    const rowsHtml = detail.history.slice().reverse().map(h => `
      <tr>
        <td>${escapeHtml(h.changed_at)}</td><td>${escapeHtml(state.statusLabels[h.status] || h.status)}</td><td>${escapeHtml(h.changed_by || "—")}</td>
        <td>${canEdit ? `<button class="hist-del" data-hist-id="${h.id}" title="Удалить запись">✕</button>` : ""}</td>
      </tr>
    `).join("");
    historyBox.innerHTML = `<table id="history-table"><tr><th>Когда</th><th>Статус</th><th>Кто</th><th></th></tr>${rowsHtml}</table>`;
    if (canEdit) {
      historyBox.querySelectorAll(".hist-del").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Удалить эту запись истории статусов?")) return;
          try {
            const updated = await api(`/elements/${element.id}/history/${btn.dataset.histId}`, { method: "DELETE" });
            Object.assign(element, updated);
            state.byId.set(element.id, element);
            styleShape(state.shapeById.get(element.id), element);
            renderLegend();
            await showCard(element);
          } catch (e) {
            alert("Не удалось удалить запись: " + e.message);
          }
        });
      });
    }
  } catch (e) {
    const historyBox = document.getElementById("history-box");
    if (historyBox) historyBox.textContent = "не удалось загрузить историю";
  }
}

function selectElement(element) {
  const prevId = state.selectedId;
  state.selectedId = element.id;
  if (prevId !== null && prevId !== element.id) {
    const prevEl = state.byId.get(prevId);
    const prevShape = state.shapeById.get(prevId);
    if (prevEl && prevShape) styleShape(prevShape, prevEl);
  }
  styleShape(state.shapeById.get(element.id), element);
  showCard(element);
  switchTab("properties");
  if (!legendAutoCollapseDone) {
    legendAutoCollapseDone = true;
    setLegendCollapsed(true);
  }
}

function clearSelection() {
  if (state.selectedId === null) return;
  const prevEl = state.byId.get(state.selectedId);
  const prevShape = state.shapeById.get(state.selectedId);
  state.selectedId = null;
  if (prevEl && prevShape) styleShape(prevShape, prevEl);
  showPlaceholderCard();
}

// ---------- контекстное меню статуса — по ПКМ/двойному клику (п.3 второго раунда) ----------
const ctxMenu = document.getElementById("ctx-menu");

function openCtxMenu(element, clientX, clientY) {
  if (state.currentUser.role === "view") return;
  ctxMenu.innerHTML = "";
  const title = document.createElement("div");
  title.className = "ctx-title";
  title.textContent = `${element.mark || element.id} — сменить статус`;
  ctxMenu.appendChild(title);

  for (const status of state.statusOrder) {
    const item = document.createElement("div");
    item.className = "ctx-item" + (status === element.current_status ? " current" : "");
    item.innerHTML = `<span class="swatch" style="background:${colorFor(status)}"></span>${escapeHtml(state.statusLabels[status])}`;
    item.addEventListener("click", () => applyStatus(element, status));
    ctxMenu.appendChild(item);
  }

  // Партия — независимое действие (не привязано к смене статуса, в
  // отличие от контракта), но доступно из ТОГО ЖЕ меню — единый
  // список действий над элементом, см. Docs/backlog.md. ВСЕГДА в меню
  // (не пропадает условно) — как и остальные фильтры/действия в этом
  // приложении, "полный список всегда виден + недоступен (disabled),
  // не сужается"; недоступен, только если у элемента ещё нет контракта
  // (партия — его дочерняя сущность), с явной подсказкой почему.
  const sep = document.createElement("div");
  sep.className = "ctx-title";
  sep.textContent = "Партия";
  ctxMenu.appendChild(sep);
  const batchItem = document.createElement("div");
  const hasContract = !!element.contract_id;
  batchItem.className = "ctx-item" + (hasContract ? "" : " disabled");
  batchItem.textContent = element.batch_id ? "Изменить партию…" : "Выбрать партию…";
  if (!hasContract) batchItem.title = "У элемента нет контракта — сначала укажите контракт";
  batchItem.addEventListener("click", () => {
    if (!hasContract) return;
    closeCtxMenu();
    openBatchAssignDialog(element);
  });
  ctxMenu.appendChild(batchItem);

  ctxMenu.style.left = Math.min(clientX, window.innerWidth - 240) + "px";
  ctxMenu.style.top = Math.min(clientY, window.innerHeight - 260) + "px";
  ctxMenu.style.display = "block";
}

function closeCtxMenu() { ctxMenu.style.display = "none"; }

// ---------- подтверждение контракта при уходе со статуса "Запланирован" (п.4 третьего раунда) ----------
const statusContractBackdrop = document.getElementById("status-contract-backdrop");
let pendingStatusChange = null;

// Диалог смены статуса теперь открывается ВСЕГДА (не только при уходе
// с "Запланирован") — заказчик явно попросил всегда видеть и иметь
// возможность поменять дату/время применения статуса, см.
// Docs/backlog.md. Секция контракта/партии внутри диалога показывается
// только когда это актуально (уход с "Запланирован") — остальным
// переходам контракт не нужен (наследуется от предыдущей записи).
async function applyStatus(element, status) {
  closeCtxMenu();
  openStatusDialog(element, status);
}

function openStatusDialog(element, status) {
  pendingStatusChange = { element, status };
  document.getElementById("sc-status-label").textContent = state.statusLabels[status] || status;

  // Дата/время — по умолчанию рабочая дата, если она сейчас активна в
  // тулбаре, иначе текущий момент; в любом случае можно поменять прямо
  // здесь, не трогая сам тулбар (одноразовое значение для этого действия).
  document.getElementById("sc-datetime").value = workdateInput.value || nowAsDatetimeLocal();

  const showContract = element.current_status === "planned" && status !== "planned";
  document.getElementById("sc-contract-section").style.display = showContract ? "" : "none";
  if (showContract) {
    const preselect = element.contract_id || state.defaultContracts[element.element_type] || "";
    const matching = state.contracts.filter(c => c.element_types.includes(element.element_type));
    const options = ['<option value="">— без контракта —</option>'].concat(
      matching.map(c => `<option value="${c.id}" ${String(c.id) === String(preselect) ? "selected" : ""}>${escapeHtml(c.name)} (${escapeHtml(c.supplier)})</option>`)
    );
    document.getElementById("sc-contract-select").innerHTML = options.join("");
    refreshStatusDialogBatchSelect();
  }
  statusContractBackdrop.classList.add("open");
}
document.getElementById("sc-cancel").addEventListener("click", () => {
  pendingStatusChange = null;
  statusContractBackdrop.classList.remove("open");
});
document.getElementById("sc-datetime-clear").addEventListener("click", () => {
  document.getElementById("sc-datetime").value = "";
});

// Партию можно указать СРАЗУ в том же диалоге, что и контракт — не
// отдельным действием после (см. Docs/backlog.md): список партий
// зависит от ВЫБРАННОГО в этом же диалоге контракта (не обязательно
// текущего у элемента), поэтому пересчитывается при каждой смене
// контракта в селекте, а не только один раз при открытии.
document.getElementById("sc-contract-select").addEventListener("change", () => refreshStatusDialogBatchSelect());

async function refreshStatusDialogBatchSelect() {
  const select = document.getElementById("sc-batch-select");
  const element = pendingStatusChange ? pendingStatusChange.element : null;
  const contractValue = document.getElementById("sc-contract-select").value;
  select.innerHTML = '<option value="">— без партии —</option>';
  select.disabled = true;
  if (!element || !contractValue) return;
  try {
    const batches = await api(`/batches?contract_id=${contractValue}`);
    const matching = batches.filter(b => b.lines.some(l => batchLineMatches(l, element)));
    if (!matching.length) return;
    const options = ['<option value="">— без партии —</option>'].concat(
      matching.map(b => `<option value="${b.id}" ${String(b.id) === String(element.batch_id) ? "selected" : ""}>${escapeHtml(b.label)}</option>`)
    );
    select.innerHTML = options.join("");
    select.disabled = false;
  } catch (e) {
    // тихо — партия необязательна в этом диалоге, не блокируем смену статуса/контракта
  }
}

document.getElementById("sc-confirm").addEventListener("click", async () => {
  if (!pendingStatusChange) return;
  const showContract = document.getElementById("sc-contract-section").style.display !== "none";
  const contractId = showContract
    ? (document.getElementById("sc-contract-select").value ? Number(document.getElementById("sc-contract-select").value) : null)
    : undefined;
  const batchValue = showContract ? document.getElementById("sc-batch-select").value : "";
  const batchId = batchValue ? Number(batchValue) : null;
  const explicitChangedAt = datetimeLocalToServer(document.getElementById("sc-datetime").value);
  const { element, status } = pendingStatusChange;
  pendingStatusChange = null;
  statusContractBackdrop.classList.remove("open");
  await doApplyStatus(element, status, contractId, batchId, explicitChangedAt);
});

async function doApplyStatus(element, status, explicitContractId, explicitBatchId, explicitChangedAt) {
  try {
    const body = { status };
    // explicitChangedAt приходит из диалога смены статуса (см.
    // openStatusDialog) — всегда явно задан пользователем на момент
    // подтверждения (по умолчанию рабочая дата или текущий момент, но
    // могла быть изменена/очищена прямо в диалоге), не тот же самый
    // currentChangedAt() из тулбара.
    if (explicitChangedAt) body.changed_at = explicitChangedAt;
    // explicitContractId !== undefined значит поле реально выбрано в диалоге
    // (даже null — "без контракта") — бэкенд различает "поле было в теле
    // запроса" от "поля не было" через model_fields_set (см. app/main.py).
    if (explicitContractId !== undefined) body.contract_id = explicitContractId;
    const updated = await api(`/elements/${element.id}/status`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    Object.assign(element, updated);
    state.byId.set(element.id, element);
    styleShape(state.shapeById.get(element.id), element);
    updateElementSubLabel(element); // статус мог войти/выйти из диапазона, где допстрока видна
    renderLegend();
    showCard(element);

    // Партия — сразу вместе со статусом/контрактом, если указана в том же
    // диалоге (см. Docs/backlog.md, "давай отменим ограничение..."). Отдельный
    // запрос ПОСЛЕ смены статуса, не тот же PATCH — партии требуется уже
    // сохранённый contract_id, который к этому моменту гарантированно
    // применён (apply_status_change уже отработал выше).
    if (explicitBatchId) {
      try {
        const batchUpdated = await api(`/elements/${element.id}/batch`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch_id: explicitBatchId }),
        });
        Object.assign(element, batchUpdated);
        state.byId.set(element.id, element);
        updateElementSubLabel(element);
        showCard(element);
        maybeWarnBatch(batchUpdated);
      } catch (e) {
        alert("Статус изменён, но не удалось назначить партию: " + e.message);
      }
    }
    maybeWarnContract(updated);
  } catch (e) {
    alert("Не удалось изменить статус: " + e.message);
  }
}

// ---------- назначение партии одному элементу (независимо от статуса,
// см. Docs/backlog.md, "Партия — учёт по маркам") ----------
const batchAssignBackdrop = document.getElementById("batch-assign-backdrop");
let pendingBatchAssign = null;

function batchLineMatches(line, element) {
  return line.element_type === element.element_type
    && (line.subtype || null) === (element.subtype || null)
    && (line.mark || null) === (element.mark || null);
}

async function openBatchAssignDialog(element) {
  pendingBatchAssign = element;
  document.getElementById("batch-assign-error").textContent = "";
  const select = document.getElementById("ba-batch-select");
  select.innerHTML = "";
  try {
    const batches = await api(`/batches?contract_id=${element.contract_id}`);
    // Клиентский фильтр — только партии, где есть строка под марку этого
    // элемента (сервер всё равно перепроверит при подтверждении — это
    // только для UX, не граница безопасности).
    const matching = batches.filter(b => b.lines.some(l => batchLineMatches(l, element)));
    const options = ['<option value="">— без партии —</option>'].concat(
      matching.map(b => `<option value="${b.id}" ${String(b.id) === String(element.batch_id) ? "selected" : ""}>${escapeHtml(b.label)}</option>`)
    );
    select.innerHTML = options.join("");
    if (!matching.length) {
      document.getElementById("batch-assign-error").textContent = "Нет партий с подходящей строкой для этой марки";
    }
  } catch (e) {
    document.getElementById("batch-assign-error").textContent = e.message;
  }
  batchAssignBackdrop.classList.add("open");
}
document.getElementById("ba-cancel").addEventListener("click", () => {
  pendingBatchAssign = null;
  batchAssignBackdrop.classList.remove("open");
});
document.getElementById("ba-confirm").addEventListener("click", async () => {
  if (!pendingBatchAssign) return;
  const value = document.getElementById("ba-batch-select").value;
  const batchId = value ? Number(value) : null;
  const element = pendingBatchAssign;
  try {
    const updated = await api(`/elements/${element.id}/batch`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch_id: batchId }),
    });
    Object.assign(element, updated);
    state.byId.set(element.id, element);
    pendingBatchAssign = null;
    batchAssignBackdrop.classList.remove("open");
    showCard(element);
    updateElementSubLabel(element);
    maybeWarnBatch(updated);
  } catch (e) {
    document.getElementById("batch-assign-error").textContent = e.message;
  }
});

// ---------- массовая смена статуса выделенной рамкой группы (см. Docs/backlog.md) ----------
function hexToRgba(hex, alpha) {
  const h = (hex || "#999999").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function bulkContractOptionsForType(elementType) {
  return state.contracts.filter(c => c.element_types.includes(elementType));
}

function updateBulkStatusTitle() {
  document.getElementById("bulk-status-title").textContent = `Массовая смена статуса (${state.multiSelectedIds.size} элементов)`;
}

// Кнопка "Применить" заблокирована, пока хоть у одной строки контракт не
// выбран ("— выберите —", value="") — "без контракта" (value="none") это
// ОСМЫСЛЕННЫЙ выбор и валидацию проходит, см. Docs/backlog.md.
function updateBulkStatusValidation() {
  const selects = document.querySelectorAll("#bulk-status-tbody .bulk-row-contract");
  const emptyCount = Array.from(selects).filter(s => s.value === "").length;
  document.getElementById("bulk-status-apply").disabled = emptyCount > 0 || selects.length === 0;
  document.getElementById("bulk-status-error").textContent = emptyCount > 0 ? `Не указан контракт у ${emptyCount} элемент(ов)` : "";
  updateBulkContractWarning();
}

// Снимок остатков строк контрактов (quantity-fact), берётся один раз при
// открытии модалки (GET /contracts, включает quantity/fact/remaining —
// в отличие от state.contracts из /plan-data, где этих полей нет). Не
// блокирует применение — только предупреждает, см. Docs/backlog.md,
// "Проверка остатка контракта при групповой установке".
let bulkContractLines = [];

// Пересчитывается при КАЖДОМ изменении (выбор контракта в строке или
// "Заполнить пустые") — по каждой связке (контракт, тип элемента) в
// текущей пачке считает, сколько элементов НОВО получат этот контракт
// (те, у кого он уже был — не в счёт, они уже учтены в fact), сравнивает
// с остатком строки контракта. Приближённо (не учитывает переход
// планового статуса туда-обратно) — предупреждение неблокирующее.
function updateBulkContractWarning() {
  const warnEl = document.getElementById("bulk-status-contract-warning");
  if (!bulkContractLines.length) { warnEl.textContent = ""; return; }

  const requested = new Map(); // contractId -> Map(elementType -> count)
  const already = new Map();
  const bump = (map, contractId, type) => {
    if (!map.has(contractId)) map.set(contractId, new Map());
    const inner = map.get(contractId);
    inner.set(type, (inner.get(type) || 0) + 1);
  };
  document.querySelectorAll("#bulk-status-tbody tr").forEach(tr => {
    const raw = tr.querySelector(".bulk-row-contract").value;
    if (!raw || raw === "none") return;
    const contractId = Number(raw);
    const element = state.byId.get(Number(tr.dataset.elementId));
    if (!element) return;
    bump(requested, contractId, element.element_type);
    if (element.contract_id === contractId) bump(already, contractId, element.element_type);
  });

  const problems = [];
  for (const [contractId, types] of requested) {
    for (const [elementType, count] of types) {
      const newlyRequested = count - (already.get(contractId)?.get(elementType) || 0);
      if (newlyRequested <= 0) continue;
      const line = bulkContractLines.find(l => l.contract_id === contractId && l.element_type === elementType);
      if (!line || newlyRequested <= line.remaining) continue;
      problems.push(`«${line.contract_name}» / ${elementType}: запрошено ${newlyRequested}, доступно ${line.remaining}`);
    }
  }
  warnEl.textContent = problems.length ? `Превышение остатка контракта — ${problems.join("; ")}` : "";
}

function renderBulkStatusTable() {
  const tbody = document.getElementById("bulk-status-tbody");
  tbody.innerHTML = "";
  for (const id of Array.from(state.multiSelectedIds)) {
    const element = state.byId.get(id);
    if (!element) continue;
    const tr = document.createElement("tr");
    tr.dataset.elementId = element.id;

    const idTd = document.createElement("td"); idTd.textContent = element.id;
    const markTd = document.createElement("td"); markTd.textContent = element.mark || "—";
    const typeTd = document.createElement("td"); typeTd.textContent = element.element_type;

    const statusTd = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "bulk-status-status-cell";
    const color = colorFor(element.current_status);
    badge.style.background = hexToRgba(color, 0.18);
    badge.style.color = color;
    badge.style.border = `1px solid ${color}`;
    badge.textContent = state.statusLabels[element.current_status] || element.current_status;
    statusTd.appendChild(badge);

    const contractTd = document.createElement("td");
    const select = document.createElement("select");
    select.className = "bulk-row-contract";
    const preselect = element.contract_id || state.defaultContracts[element.element_type] || "";
    const matching = bulkContractOptionsForType(element.element_type);
    const options = ['<option value="">— выберите —</option>', '<option value="none">без контракта</option>'].concat(
      matching.map(c => `<option value="${c.id}" ${String(c.id) === String(preselect) ? "selected" : ""}>${escapeHtml(c.name)} (${escapeHtml(c.supplier)})</option>`)
    );
    select.innerHTML = options.join("");
    select.addEventListener("change", updateBulkStatusValidation);
    contractTd.appendChild(select);

    const removeTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "bulk-row-remove";
    removeBtn.title = "Убрать из выборки — если рамка захватила лишнее";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      state.multiSelectedIds.delete(element.id);
      styleShape(state.shapeById.get(element.id), element);
      tr.remove();
      updateMultiSelectionPanel();
      updateBulkStatusTitle();
      updateBulkStatusValidation();
      if (state.multiSelectedIds.size === 0) bulkStatusBackdrop.classList.remove("open");
    });
    removeTd.appendChild(removeBtn);

    tr.append(idTd, markTd, typeTd, statusTd, contractTd, removeTd);
    tbody.appendChild(tr);
  }
  updateBulkStatusTitle();
  updateBulkStatusValidation();
}

const bulkStatusBackdrop = document.getElementById("bulk-status-backdrop");

async function openBulkStatusModal() {
  if (state.multiSelectedIds.size === 0) return;
  document.getElementById("bulk-status-select").innerHTML =
    state.statusOrder.map(s => `<option value="${s}">${escapeHtml(state.statusLabels[s])}</option>`).join("");
  document.getElementById("bulk-fill-contract-select").innerHTML = ['<option value="">— выберите контракт —</option>'].concat(
    state.contracts.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.supplier)}) — ${escapeHtml(c.element_types.join(", "))}</option>`)
  ).join("");
  try {
    const contracts = await api("/contracts");
    bulkContractLines = contracts.flatMap(c => c.lines.map(l => ({
      contract_id: c.id, contract_name: c.name, element_type: l.element_type, remaining: l.remaining,
    })));
  } catch (e) {
    bulkContractLines = []; // проверка остатка просто не покажет предупреждений — не блокирует открытие модалки
  }
  renderBulkStatusTable();
  bulkStatusBackdrop.classList.add("open");
}

document.getElementById("bulk-status-cancel").addEventListener("click", () => bulkStatusBackdrop.classList.remove("open"));

// Заполняет контрактом из шапки только строки, у которых контракт ещё не
// выбран ("— выберите —"), и только если этот контракт подходит типу
// элемента строки — иначе строка пропускается (не перезаписываем то, что
// уже выбрано/подходит другому типу), см. Docs/backlog.md.
document.getElementById("bulk-fill-contract-apply").addEventListener("click", () => {
  const value = document.getElementById("bulk-fill-contract-select").value;
  if (!value) return;
  let filled = 0, skipped = 0;
  document.querySelectorAll("#bulk-status-tbody tr").forEach(tr => {
    const select = tr.querySelector(".bulk-row-contract");
    if (select.value !== "") return;
    const optionExists = Array.from(select.options).some(o => o.value === value);
    if (optionExists) { select.value = value; filled++; } else { skipped++; }
  });
  updateBulkStatusValidation();
  showToast(`Заполнено ${filled}${skipped ? `, пропущено ${skipped} (тип не подходит)` : ""}`, "info");
});

document.getElementById("bulk-status-apply").addEventListener("click", async () => {
  const status = document.getElementById("bulk-status-select").value;
  const items = [];
  document.querySelectorAll("#bulk-status-tbody tr").forEach(tr => {
    const raw = tr.querySelector(".bulk-row-contract").value;
    if (raw === "") return; // кнопка и так заблокирована, подстраховка
    items.push({ element_id: Number(tr.dataset.elementId), contract_id: raw === "none" ? null : Number(raw) });
  });
  if (!items.length) return;
  try {
    const body = { items, status };
    const changedAt = currentChangedAt();
    if (changedAt) body.changed_at = changedAt;
    const result = await api("/elements/bulk-status", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    for (const updated of result.updated) {
      const existing = state.byId.get(updated.id);
      if (existing) {
        Object.assign(existing, updated);
        styleShape(state.shapeById.get(updated.id), existing);
        updateElementSubLabel(existing);
      }
    }
    renderLegend();
    bulkStatusBackdrop.classList.remove("open");
    clearMultiSelection();
    showToast(`Статус изменён у ${result.updated.length} элементов`, "success");
  } catch (e) {
    document.getElementById("bulk-status-error").textContent = "Не удалось изменить статус: " + e.message;
  }
});

// ---------- массовое назначение партии (см. Docs/backlog.md, "Партия —
// учёт по маркам") — отдельное действие от массовой смены статуса, тем
// же приёмом (таблица выбранных элементов, select на строку) ----------
const bulkBatchBackdrop = document.getElementById("bulk-batch-backdrop");
let bulkBatchesByContract = new Map(); // contract_id -> [BatchOut] — снимок на момент открытия модалки

async function openBulkBatchModal() {
  if (state.multiSelectedIds.size === 0) return;
  const contractIds = new Set(
    Array.from(state.multiSelectedIds)
      .map(id => state.byId.get(id))
      .filter(e => e && e.contract_id)
      .map(e => e.contract_id)
  );
  bulkBatchesByContract = new Map();
  await Promise.all(Array.from(contractIds).map(async cid => {
    try {
      bulkBatchesByContract.set(cid, await api(`/batches?contract_id=${cid}`));
    } catch (e) {
      bulkBatchesByContract.set(cid, []);
    }
  }));
  document.getElementById("bulk-batch-error").textContent = "";
  renderBulkBatchTable();
  bulkBatchBackdrop.classList.add("open");
}

function renderBulkBatchTable() {
  const tbody = document.getElementById("bulk-batch-tbody");
  tbody.innerHTML = "";
  for (const id of Array.from(state.multiSelectedIds)) {
    const element = state.byId.get(id);
    if (!element) continue;
    const tr = document.createElement("tr");
    tr.dataset.elementId = element.id;

    const idTd = document.createElement("td"); idTd.textContent = element.id;
    const markTd = document.createElement("td"); markTd.textContent = element.mark || "—";
    const typeTd = document.createElement("td"); typeTd.textContent = element.element_type;
    const contractTd = document.createElement("td");
    const contract = state.contracts.find(c => c.id === element.contract_id);
    contractTd.textContent = contract ? `${contract.name} (${contract.supplier})` : "—";

    const batchTd = document.createElement("td");
    const select = document.createElement("select");
    select.className = "bulk-row-batch";
    if (!element.contract_id) {
      select.disabled = true;
      const opt = document.createElement("option");
      opt.textContent = "нет контракта";
      select.appendChild(opt);
    } else {
      const batches = bulkBatchesByContract.get(element.contract_id) || [];
      const matching = batches.filter(b => b.lines.some(l => batchLineMatches(l, element)));
      if (!matching.length) {
        select.disabled = true;
        const opt = document.createElement("option");
        opt.textContent = "нет подходящих партий";
        select.appendChild(opt);
      } else {
        const options = ['<option value="">— без партии —</option>'].concat(
          matching.map(b => `<option value="${b.id}" ${String(b.id) === String(element.batch_id) ? "selected" : ""}>${escapeHtml(b.label)}</option>`)
        );
        select.innerHTML = options.join("");
      }
    }
    batchTd.appendChild(select);

    const removeTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "bulk-row-remove";
    removeBtn.title = "Убрать из выборки";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      state.multiSelectedIds.delete(element.id);
      styleShape(state.shapeById.get(element.id), element);
      tr.remove();
      updateMultiSelectionPanel();
      if (state.multiSelectedIds.size === 0) bulkBatchBackdrop.classList.remove("open");
    });
    removeTd.appendChild(removeBtn);

    tr.append(idTd, markTd, typeTd, contractTd, batchTd, removeTd);
    tbody.appendChild(tr);
  }
}

document.getElementById("bulk-batch-cancel").addEventListener("click", () => bulkBatchBackdrop.classList.remove("open"));

document.getElementById("bulk-batch-apply").addEventListener("click", async () => {
  const items = [];
  let skipped = 0;
  document.querySelectorAll("#bulk-batch-tbody tr").forEach(tr => {
    const select = tr.querySelector(".bulk-row-batch");
    if (select.disabled) { skipped++; return; }
    items.push({ element_id: Number(tr.dataset.elementId), batch_id: select.value ? Number(select.value) : null });
  });
  if (!items.length) {
    document.getElementById("bulk-batch-error").textContent = "Нет элементов с подходящей партией для назначения";
    return;
  }
  try {
    const result = await api("/elements/bulk-batch", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
    });
    const warnings = [];
    for (const updated of result.updated) {
      const existing = state.byId.get(updated.id);
      if (existing) {
        Object.assign(existing, updated);
        updateElementSubLabel(existing);
      }
      if (updated.batch_warning) warnings.push(updated.batch_warning);
    }
    bulkBatchBackdrop.classList.remove("open");
    clearMultiSelection();
    showToast(`Партия назначена у ${result.updated.length} элементов${skipped ? `, пропущено ${skipped} (нет контракта/подходящей партии)` : ""}`, "success");
    warnings.forEach(w => showToast(`Превышение по партии «${w.batch_label}»: запланировано ${w.quantity}, назначено ${w.fact}.`));
  } catch (e) {
    document.getElementById("bulk-batch-error").textContent = "Не удалось назначить партию: " + e.message;
  }
});
document.getElementById("multi-select-batch-btn").addEventListener("click", openBulkBatchModal);

const svgRoot = document.getElementById("svg-root");
svgRoot.addEventListener("click", (e) => {
  if (dragMoved) return; // не выбираем элемент сразу после перетаскивания схемы
  const shape = e.target.closest(".element-shape");
  if (!shape) { closeCtxMenu(); clearSelection(); clearMultiSelection(); return; }
  const element = state.byId.get(Number(shape.getAttribute("data-id")));
  if (!element) return;
  selectElement(element);
});
svgRoot.addEventListener("dblclick", (e) => {
  const shape = e.target.closest(".element-shape");
  if (!shape) return;
  const element = state.byId.get(Number(shape.getAttribute("data-id")));
  if (!element) return;
  selectElement(element);
  openCtxMenu(element, e.clientX, e.clientY);
});
svgRoot.addEventListener("contextmenu", (e) => {
  const shape = e.target.closest(".element-shape");
  if (!shape) return;
  e.preventDefault();
  const element = state.byId.get(Number(shape.getAttribute("data-id")));
  if (!element) return;
  selectElement(element);
  openCtxMenu(element, e.clientX, e.clientY);
});
document.addEventListener("click", (e) => {
  // #card-change-status-btn (карточка элемента, см. showCard) тоже вызывает
  // openCtxMenu — без этого исключения тот же самый клик, всплыв до
  // document, немедленно закрывал бы только что открытое меню (пойман
  // живым браузером при первой проверке).
  if (!ctxMenu.contains(e.target) && !e.target.closest(".element-shape") && e.target.id !== "card-change-status-btn") closeCtxMenu();
});

// ==================== PAN/ZOOM ====================
const stageEl = document.getElementById("stage");

stageEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!state.view) return;
  const rect = stageEl.getBoundingClientRect();
  const mx = (e.clientX - rect.left) / rect.width;
  const my = (e.clientY - rect.top) / rect.height;
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  const v = state.view;
  const newW = v.w * factor, newH = v.h * factor;
  setView({ x: v.x + (v.w - newW) * mx, y: v.y + (v.h - newH) * my, w: newW, h: newH });
}, { passive: false });

// Порог в пикселях перед тем, как считать движение мыши перетаскиванием — без него
// обычное реальное дрожание мыши между mousedown/mouseup (1-2px) уже трактовалось как
// намеренный pan, и схема слегка "дёргалась" при простом клике по элементу (п.6 третьего раунда).
const DRAG_THRESHOLD_PX = 4;
let dragging = false, dragMoved = false, startX = 0, startY = 0, lastX = 0, lastY = 0;
// Shift+перетаскивание — рамка группового выделения вместо панорамирования
// (см. Docs/backlog.md, "Групповая смена статуса"). Обычное перетаскивание
// без Shift — как раньше, панорамирование.
let rubberBandActive = false, rbCurX = 0, rbCurY = 0;
const rubberBandEl = document.getElementById("rubber-band");

stageEl.addEventListener("mousedown", (e) => {
  dragging = true; dragMoved = false;
  rubberBandActive = e.shiftKey;
  startX = lastX = rbCurX = e.clientX; startY = lastY = rbCurY = e.clientY;
});
window.addEventListener("mouseup", () => {
  if (dragging && rubberBandActive && dragMoved) finishRubberBand();
  dragging = false;
  rubberBandActive = false;
  stageEl.classList.remove("dragging");
  rubberBandEl.style.display = "none";
});
window.addEventListener("mousemove", (e) => {
  if (!dragging || !state.view) return;
  if (!dragMoved) {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
    dragMoved = true;
    if (!rubberBandActive) stageEl.classList.add("dragging");
  }
  if (rubberBandActive) {
    rbCurX = e.clientX; rbCurY = e.clientY;
    updateRubberBandRect(startX, startY, rbCurX, rbCurY);
    return;
  }
  const rect = stageEl.getBoundingClientRect();
  const v = state.view;
  const dx = (e.clientX - lastX) / rect.width * v.w;
  const dy = (e.clientY - lastY) / rect.height * v.h;
  setView({ x: v.x - dx, y: v.y - dy, w: v.w, h: v.h });
  lastX = e.clientX; lastY = e.clientY;
});

function updateRubberBandRect(x1, y1, x2, y2) {
  const rect = stageEl.getBoundingClientRect();
  rubberBandEl.style.display = "block";
  rubberBandEl.style.left = (Math.min(x1, x2) - rect.left) + "px";
  rubberBandEl.style.top = (Math.min(y1, y2) - rect.top) + "px";
  rubberBandEl.style.width = Math.abs(x2 - x1) + "px";
  rubberBandEl.style.height = Math.abs(y2 - y1) + "px";
}

// Экран -> мировые координаты прямоугольника выделения. viewBox сам по
// себе — стандартное SVG-пространство (Y вниз), но всё содержимое схемы
// нарисовано внутри <g id="flip" transform="scale(1,-1)"> реальными
// мировыми координатами БЕЗ инверсии (см. renderElements) — видимую
// ориентацию "Y вверх" даёт именно этот flip. Поэтому world.Y = -viewBox.Y,
// а не прямое соответствие, как у X.
function screenRectToWorldBBox(sx1, sy1, sx2, sy2) {
  const rect = stageEl.getBoundingClientRect();
  const v = state.view;
  const vx1 = v.x + (Math.min(sx1, sx2) - rect.left) / rect.width * v.w;
  const vx2 = v.x + (Math.max(sx1, sx2) - rect.left) / rect.width * v.w;
  const vy1 = v.y + (Math.min(sy1, sy2) - rect.top) / rect.height * v.h;
  const vy2 = v.y + (Math.max(sy1, sy2) - rect.top) / rect.height * v.h;
  return { minX: vx1, maxX: vx2, minY: -vy2, maxY: -vy1 };
}

function finishRubberBand() {
  const box = screenRectToWorldBBox(startX, startY, rbCurX, rbCurY);
  // Накопительное выделение (см. Docs/backlog.md) — новая рамка ДОБАВЛЯЕТ
  // захваченные элементы к уже выделенным, никогда не снимает выделение с
  // того, что было выбрано раньше; "✕" на плавающей панели — единственный
  // способ сбросить всё и начать заново.
  const ids = new Set(state.multiSelectedIds);
  for (const element of state.elements) {
    if (!passesPlacementFilters(element)) continue; // выделяем только то, что сейчас реально видно
    if (element.x >= box.minX && element.x <= box.maxX && element.y >= box.minY && element.y <= box.maxY) {
      ids.add(element.id);
    }
  }
  setMultiSelection(ids);
}

// ---------- групповое выделение (плавающая панель + подсветка, см. Docs/backlog.md) ----------
function setMultiSelection(idsSet) {
  const prev = state.multiSelectedIds;
  state.multiSelectedIds = idsSet;
  const touched = new Set([...prev, ...idsSet]);
  for (const id of touched) {
    const element = state.byId.get(id);
    const shape = state.shapeById.get(id);
    if (element && shape) styleShape(shape, element);
  }
  updateMultiSelectionPanel();
}

function clearMultiSelection() {
  if (state.multiSelectedIds.size === 0) return;
  setMultiSelection(new Set());
}

function updateMultiSelectionPanel() {
  const panel = document.getElementById("multi-select-panel");
  const n = state.multiSelectedIds.size;
  if (n === 0) { panel.style.display = "none"; return; }
  panel.style.display = "flex";
  document.getElementById("multi-select-count").textContent = `Выделено: ${n}`;
  const hasContract = Array.from(state.multiSelectedIds).some(id => state.byId.get(id)?.contract_id);
  const batchBtn = document.getElementById("multi-select-batch-btn");
  batchBtn.disabled = !hasContract;
  batchBtn.title = hasContract ? "" : "Ни у одного выбранного элемента нет контракта";
}

document.getElementById("multi-select-clear").addEventListener("click", clearMultiSelection);
document.getElementById("multi-select-status-btn").addEventListener("click", openBulkStatusModal);

// ==================== ИНДИКАТОР ЗУМА + СБРОС (п.12 третьего раунда) ====================
function updateZoomIndicator(pxPerUnit) {
  const valueEl = document.getElementById("zoom-value");
  if (!state.initialView || !state.view) { valueEl.textContent = "—"; return; }
  const initPxPerUnitX = stageEl.clientWidth / state.initialView.w;
  const initPxPerUnitY = stageEl.clientHeight / state.initialView.h;
  const initPxPerUnit = Math.min(initPxPerUnitX, initPxPerUnitY) || 1;
  valueEl.textContent = `${Math.round((pxPerUnit / initPxPerUnit) * 100)}%`;
}
document.getElementById("zoom-reset").addEventListener("click", () => {
  if (state.initialView) setView({ ...state.initialView });
});
document.getElementById("zoom-reset-3d").addEventListener("click", () => {
  if (state.view3d.camera) fit3DCameraToData();
});

// ==================== ПОЛОСЫ ПРОКРУТКИ РАБОЧЕЙ ОБЛАСТИ (п.10 третьего раунда) ====================
// Кастомные, не нативные — вид управляется через viewBox SVG (pan/zoom), обычный
// overflow-скролл тут не применим. Ползунок отражает текущий видовой прямоугольник
// (state.view) относительно "всей схемы целиком" (state.initialView).
function updateScrollbars() {
  const vThumb = document.getElementById("vscroll-thumb");
  const hThumb = document.getElementById("hscroll-thumb");
  const vTrack = document.getElementById("vscroll");
  const hTrack = document.getElementById("hscroll");
  if (!state.view || !state.initialView) { vThumb.style.display = "none"; hThumb.style.display = "none"; return; }
  const full = state.initialView, v = state.view;

  const trackH = vTrack.clientHeight;
  const hFrac = Math.min(1, v.h / full.h);
  let topFrac = full.h > 0 ? (v.y - full.y) / full.h : 0;
  topFrac = Math.max(0, Math.min(1 - hFrac, topFrac));
  vThumb.style.display = hFrac >= 0.999 ? "none" : "block";
  vThumb.style.top = (topFrac * trackH) + "px";
  vThumb.style.height = Math.max(20, hFrac * trackH) + "px";

  const trackW = hTrack.clientWidth;
  const wFrac = Math.min(1, v.w / full.w);
  let leftFrac = full.w > 0 ? (v.x - full.x) / full.w : 0;
  leftFrac = Math.max(0, Math.min(1 - wFrac, leftFrac));
  hThumb.style.display = wFrac >= 0.999 ? "none" : "block";
  hThumb.style.left = (leftFrac * trackW) + "px";
  hThumb.style.width = Math.max(20, wFrac * trackW) + "px";
}

function setupScrollbar(thumbId, trackId, axis) {
  const thumb = document.getElementById(thumbId);
  const track = document.getElementById(trackId);
  let draggingThumb = false, startClient = 0, startCoord = 0;

  thumb.addEventListener("mousedown", (e) => {
    e.stopPropagation(); e.preventDefault(); // не даём этому же mousedown запустить pan схемы (см. #stage выше)
    draggingThumb = true;
    thumb.classList.add("dragging");
    startClient = axis === "v" ? e.clientY : e.clientX;
    startCoord = axis === "v" ? state.view.y : state.view.x;
  });
  window.addEventListener("mousemove", (e) => {
    if (!draggingThumb || !state.view || !state.initialView) return;
    const full = state.initialView, v = state.view;
    if (axis === "v") {
      if (v.h >= full.h) return;
      const deltaWorld = ((e.clientY - startClient) / track.clientHeight) * full.h;
      const newY = Math.max(full.y, Math.min(full.y + full.h - v.h, startCoord + deltaWorld));
      setView({ x: v.x, y: newY, w: v.w, h: v.h });
    } else {
      if (v.w >= full.w) return;
      const deltaWorld = ((e.clientX - startClient) / track.clientWidth) * full.w;
      const newX = Math.max(full.x, Math.min(full.x + full.w - v.w, startCoord + deltaWorld));
      setView({ x: newX, y: v.y, w: v.w, h: v.h });
    }
  });
  window.addEventListener("mouseup", () => { if (draggingThumb) { draggingThumb = false; thumb.classList.remove("dragging"); } });

  track.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (e.target === thumb || !state.view || !state.initialView) return;
    const full = state.initialView, v = state.view;
    const rect = track.getBoundingClientRect();
    if (axis === "v") {
      if (v.h >= full.h) return;
      const frac = (e.clientY - rect.top) / rect.height;
      const newY = Math.max(full.y, Math.min(full.y + full.h - v.h, full.y + frac * full.h - v.h / 2));
      setView({ x: v.x, y: newY, w: v.w, h: v.h });
    } else {
      if (v.w >= full.w) return;
      const frac = (e.clientX - rect.left) / rect.width;
      const newX = Math.max(full.x, Math.min(full.x + full.w - v.w, full.x + frac * full.w - v.w / 2));
      setView({ x: newX, y: v.y, w: v.w, h: v.h });
    }
  });
}
setupScrollbar("vscroll-thumb", "vscroll", "v");
setupScrollbar("hscroll-thumb", "hscroll", "h");

// ==================== ИЗМЕНЯЕМАЯ ШИРИНА САЙДБАРА (п.10 второго раунда) ====================
const SIDEBAR_WIDTH_KEY = "zhbi_sidebar_width";
const sidebarEl = document.getElementById("sidebar");
const resizeHandle = document.getElementById("resize-handle");

const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
if (savedWidth) sidebarEl.style.width = savedWidth + "px";

let resizingSidebar = false;
resizeHandle.addEventListener("mousedown", (e) => {
  resizingSidebar = true;
  resizeHandle.classList.add("dragging");
  e.preventDefault();
});
window.addEventListener("mouseup", () => {
  if (resizingSidebar) { resizingSidebar = false; resizeHandle.classList.remove("dragging"); }
});
window.addEventListener("mousemove", (e) => {
  if (!resizingSidebar) return;
  const width = Math.min(600, Math.max(220, window.innerWidth - e.clientX));
  sidebarEl.style.width = width + "px";
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
});

// ==================== Esc ЗАКРЫВАЕТ ЛЮБУЮ ОТКРЫТУЮ ФОРМУ (п.5 второго раунда) ====================
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-backdrop.open").forEach(m => m.classList.remove("open"));
  closeCtxMenu();
  document.getElementById("settings-menu").classList.remove("open");
});

// ==================== МЕНЮ "НАСТРОЙКИ" ====================
const settingsMenu = document.getElementById("settings-menu");
document.getElementById("btn-settings-menu").addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = !settingsMenu.classList.contains("open");
  if (willOpen) {
    // position: fixed + координаты в JS (не CSS-якорь top/right родителя) — иначе
    // меню обрезается overflow-y:hidden тулбара (баг: "меню открывается под схемой").
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 260;
    settingsMenu.style.left = Math.min(rect.left, window.innerWidth - menuWidth - 8) + "px";
    settingsMenu.style.top = (rect.bottom + 6) + "px";
  }
  settingsMenu.classList.toggle("open");
});
document.addEventListener("click", () => settingsMenu.classList.remove("open"));

// ---------- цвета статусов ----------
const settingsBackdrop = document.getElementById("settings-backdrop");
document.getElementById("menu-colors").addEventListener("click", () => {
  const rows = document.getElementById("settings-rows");
  rows.innerHTML = "";
  for (const status of state.statusOrder) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(state.statusLabels[status])}</span>
      <input type="color" data-status="${status}" value="${colorFor(status)}"/>`;
    rows.appendChild(row);
  }
  settingsBackdrop.classList.add("open");
});
document.getElementById("settings-cancel").addEventListener("click", () => settingsBackdrop.classList.remove("open"));
document.getElementById("settings-save").addEventListener("click", async () => {
  const inputs = document.querySelectorAll("#settings-rows input[type=color]");
  const colors = {};
  inputs.forEach(inp => { colors[inp.dataset.status] = inp.value; });
  const saved = await api("/status-colors", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(colors),
  });
  state.statusColors = saved;
  for (const element of state.elements) styleShape(state.shapeById.get(element.id), element);
  renderLegend();
  // 3D-материалы теперь общие на статус, кэшированные в state.view3d.
  // materialByStatus (см. getStatusMeshMaterial) — сами по себе не
  // подхватят новый цвет статуса, нужно перекрасить их в месте.
  for (const [status, material] of state.view3d.materialByStatus) material.color.set(colorFor(status));
  settingsBackdrop.classList.remove("open");
});

// ---------- форма маркеров по (слой, тип элемента) — п.11 третьего раунда ----------
const shapesBackdrop = document.getElementById("shapes-backdrop");
const SHAPE_OPTIONS = ["circle", "square", "triangle", "diamond", "hexagon", "outline"];
const SHAPE_LABELS_RU = {
  circle: "круг", square: "квадрат", triangle: "треугольник", diamond: "ромб", hexagon: "шестиугольник",
  outline: "как в оригинале (контур)",
};

document.getElementById("menu-shapes").addEventListener("click", async () => {
  const combos = await api("/layer-type-combinations");
  const rows = document.getElementById("shapes-rows");
  rows.innerHTML = combos.length
    ? combos.map(c => `
        <div class="row">
          <span>${c.layer} / ${c.element_type}</span>
          <select data-layer="${c.layer}" data-type="${c.element_type}">
            ${SHAPE_OPTIONS.map(s => `<option value="${s}" ${s === c.shape ? "selected" : ""}>${SHAPE_LABELS_RU[s]}</option>`).join("")}
          </select>
        </div>
      `).join("")
    : '<div class="hint-text">нет данных — загрузите чертёж</div>';
  shapesBackdrop.classList.add("open");
});
document.getElementById("shapes-cancel").addEventListener("click", () => shapesBackdrop.classList.remove("open"));
document.getElementById("shapes-save").addEventListener("click", async () => {
  const selects = document.querySelectorAll("#shapes-rows select");
  const payload = Array.from(selects).map(s => ({ layer: s.dataset.layer, element_type: s.dataset.type, shape: s.value }));
  await api("/element-shapes", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  shapesBackdrop.classList.remove("open");
  await loadPlan();
});

// ---------- цвета зон по крану (item 7, Docs/backlog.md) — DOM строится
// через createElement/textContent, не innerHTML: имя крана приходит из
// текста на чертеже (MULTILEADER), не доверенная строка. ----------
const zoneColorsBackdrop = document.getElementById("zone-colors-backdrop");
document.getElementById("menu-zone-colors").addEventListener("click", async () => {
  const items = await api("/zone-colors");
  const rows = document.getElementById("zone-colors-rows");
  rows.innerHTML = "";
  if (!items.length) {
    rows.innerHTML = '<div class="hint-text">нет данных — загрузите чертёж с кранами</div>';
  } else {
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "row";
      const span = document.createElement("span");
      span.textContent = `${item.name} (${item.source_file})`;
      const input = document.createElement("input");
      input.type = "color";
      input.value = item.color;
      input.dataset.sourceFile = item.source_file;
      input.dataset.name = item.name;
      row.appendChild(span);
      row.appendChild(input);
      rows.appendChild(row);
    }
  }
  zoneColorsBackdrop.classList.add("open");
});
document.getElementById("zone-colors-cancel").addEventListener("click", () => zoneColorsBackdrop.classList.remove("open"));
document.getElementById("zone-colors-save").addEventListener("click", async () => {
  const inputs = document.querySelectorAll("#zone-colors-rows input[type=color]");
  const payload = Array.from(inputs).map(inp => ({
    source_file: inp.dataset.sourceFile, name: inp.dataset.name, color: inp.value,
  }));
  await api("/zone-colors", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  zoneColorsBackdrop.classList.remove("open");
  await loadPlan();
});

// ---------- справочник подтипов (новый стандарт имён слоёв) ----------
const subtypesBackdrop = document.getElementById("subtypes-backdrop");

async function renderSubtypesModal() {
  const data = await api("/allowed-subtypes"); // {element_type: [subtype, ...]}
  const box = document.getElementById("subtypes-rows");
  box.innerHTML = "";
  for (const [elementType, subtypes] of Object.entries(data)) {
    const row = document.createElement("div");
    row.className = "subtype-row";
    const chipsHtml = subtypes.length
      ? subtypes.map(s => `<span class="subtype-chip">${escapeHtml(s)}<button type="button" data-remove="${escapeHtml(s)}">✕</button></span>`).join("")
      : '<span class="hint-text">нет подтипов</span>';
    row.innerHTML = `
      <h4>${escapeHtml(elementType)}</h4>
      <div class="subtype-chips">${chipsHtml}</div>
      <div class="subtype-add-row">
        <input type="text" placeholder="новый подтип" data-add-input/>
        <button class="btn btn-sm btn-secondary" data-add-btn>Добавить</button>
      </div>
    `;
    row.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await api(`/allowed-subtypes/${encodeURIComponent(elementType)}/${encodeURIComponent(btn.dataset.remove)}`, { method: "DELETE" });
        await renderSubtypesModal();
      });
    });
    const input = row.querySelector("[data-add-input]");
    const addBtn = row.querySelector("[data-add-btn]");
    const submitAdd = async () => {
      const subtype = input.value.trim();
      if (!subtype) return;
      await api("/allowed-subtypes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ element_type: elementType, subtype }),
      });
      await renderSubtypesModal();
    };
    addBtn.addEventListener("click", submitAdd);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });
    box.appendChild(row);
  }
}

document.getElementById("menu-subtypes").addEventListener("click", async () => {
  subtypesBackdrop.classList.add("open");
  await renderSubtypesModal();
});
document.getElementById("subtypes-close").addEventListener("click", () => subtypesBackdrop.classList.remove("open"));

// ---------- пользователи ----------
const usersBackdrop = document.getElementById("users-backdrop");
const userEditBackdrop = document.getElementById("user-edit-backdrop");
const userPasswordBackdrop = document.getElementById("user-password-backdrop");
const ROLE_LABELS = { admin: "Администратор", user: "Пользователь", view: "Просмотр" };
let editingUserId = null;
let passwordTargetUserId = null;

async function renderUsersTable() {
  const users = await api("/users");
  const table = document.getElementById("users-table");
  const rowsHtml = users.map(u => `
    <tr>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${escapeHtml(u.position || "—")}</td>
      <td>${escapeHtml(u.department || "—")}</td>
      <td>${escapeHtml(u.domain_login)}</td>
      <td>${ROLE_LABELS[u.role] || u.role}</td>
      <td>${u.has_password ? "задан" : "пустой"}</td>
      <td>
        <button class="btn btn-sm btn-secondary" data-edit="${u.id}">Изменить</button>
        <button class="btn btn-sm btn-secondary" data-pwd="${u.id}">Пароль</button>
      </td>
    </tr>
  `).join("");
  table.innerHTML = `<tr><th>ФИО</th><th>Должность</th><th>Подразделение</th><th>Логин</th><th>Роль</th><th>Пароль</th><th></th></tr>${rowsHtml}`;
  table.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => openUserEdit(users.find(u => u.id === Number(btn.dataset.edit)))));
  table.querySelectorAll("[data-pwd]").forEach(btn => btn.addEventListener("click", () => openUserPassword(Number(btn.dataset.pwd))));
}

document.getElementById("menu-users").addEventListener("click", async () => {
  usersBackdrop.classList.add("open");
  await renderUsersTable();
});
document.getElementById("users-close").addEventListener("click", () => usersBackdrop.classList.remove("open"));

function openUserEdit(user) {
  editingUserId = user ? user.id : null;
  document.getElementById("user-edit-title").textContent = user ? "Изменить пользователя" : "Новый пользователь";
  document.getElementById("ue-last-name").value = user ? user.last_name : "";
  document.getElementById("ue-first-name").value = user ? user.first_name : "";
  document.getElementById("ue-patronymic").value = user && user.patronymic ? user.patronymic : "";
  document.getElementById("ue-position").value = user && user.position ? user.position : "";
  document.getElementById("ue-department").value = user && user.department ? user.department : "";
  document.getElementById("ue-domain-login").value = user ? user.domain_login : "";
  document.getElementById("ue-role").value = user ? user.role : "user";
  document.getElementById("user-edit-error").textContent = "";
  userEditBackdrop.classList.add("open");
}
document.getElementById("users-add").addEventListener("click", () => openUserEdit(null));
document.getElementById("user-edit-cancel").addEventListener("click", () => userEditBackdrop.classList.remove("open"));
document.getElementById("user-edit-save").addEventListener("click", async () => {
  const body = {
    last_name: document.getElementById("ue-last-name").value.trim(),
    first_name: document.getElementById("ue-first-name").value.trim(),
    patronymic: document.getElementById("ue-patronymic").value.trim() || null,
    position: document.getElementById("ue-position").value.trim() || null,
    department: document.getElementById("ue-department").value.trim() || null,
    domain_login: document.getElementById("ue-domain-login").value.trim(),
    role: document.getElementById("ue-role").value,
  };
  try {
    if (editingUserId) {
      await api(`/users/${editingUserId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await api("/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    userEditBackdrop.classList.remove("open");
    await renderUsersTable();
  } catch (e) {
    document.getElementById("user-edit-error").textContent = e.message;
  }
});

function openUserPassword(userId) {
  passwordTargetUserId = userId;
  document.getElementById("up-password-value").value = "";
  document.getElementById("user-password-error").textContent = "";
  userPasswordBackdrop.classList.add("open");
}
document.getElementById("user-password-cancel").addEventListener("click", () => userPasswordBackdrop.classList.remove("open"));
document.getElementById("user-password-save").addEventListener("click", async () => {
  try {
    await api(`/users/${passwordTargetUserId}/set-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("up-password-value").value }),
    });
    userPasswordBackdrop.classList.remove("open");
    await renderUsersTable();
  } catch (e) {
    document.getElementById("user-password-error").textContent = e.message;
  }
});

// ---------- контракты (п.9 второго раунда) ----------
const contractsBackdrop = document.getElementById("contracts-backdrop");
const contractEditBackdrop = document.getElementById("contract-edit-backdrop");
let editingContractId = null;

async function renderContractsList() {
  const contracts = await api("/contracts");
  const box = document.getElementById("contracts-list");
  box.innerHTML = "";
  if (!contracts.length) { box.innerHTML = '<div class="hint-text">нет контрактов</div>'; return contracts; }
  for (const c of contracts) {
    const block = document.createElement("div");
    block.className = "contract-block";
    const linesHtml = c.lines.length
      ? c.lines.map(l => `
          <tr class="${l.exceeded ? "exceeded" : ""}">
            <td>${escapeHtml(l.element_type)}</td><td>${l.quantity}</td><td>${l.fact}</td><td>${l.damaged}</td><td>${l.remaining}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="5" class="hint-text">нет строк</td></tr>';
    block.innerHTML = `
      <div class="contract-block-header">
        <b>${escapeHtml(c.name)} (${escapeHtml(c.supplier)})</b>
        <button class="btn btn-sm btn-secondary" data-edit-contract="${c.id}">Изменить</button>
        <button class="btn btn-sm btn-secondary" data-batches-contract="${c.id}">Партии</button>
      </div>
      <table class="contract-lines-table">
        <tr><th>Тип элемента</th><th>План</th><th>Факт</th><th>Повреждено</th><th>Остаток</th></tr>
        ${linesHtml}
      </table>
    `;
    box.appendChild(block);
    block.querySelector("[data-edit-contract]").addEventListener("click", () => openContractEdit(c));
    block.querySelector("[data-batches-contract]").addEventListener("click", () => openBatchesModal(c));
  }
  return contracts;
}

async function renderDefaultContracts(contracts) {
  const box = document.getElementById("default-contracts-rows");
  const defaultMap = await api("/contracts/default-map");
  const types = Object.keys(state.labelVisibility);
  box.innerHTML = "";
  if (!types.length) { box.innerHTML = '<div class="hint-text">нет типов элементов</div>'; return; }
  for (const type of types) {
    const row = document.createElement("div");
    row.className = "default-contract-row";
    const matching = contracts.filter(c => c.lines.some(l => l.element_type === type));
    const options = ['<option value="">— не задан —</option>'].concat(
      matching.map(c => `<option value="${c.id}" ${defaultMap[type] === c.id ? "selected" : ""}>${escapeHtml(c.name)} (${escapeHtml(c.supplier)})</option>`)
    );
    row.innerHTML = `<span>${escapeHtml(type)}</span><select data-type="${escapeHtml(type)}">${options.join("")}</select>`;
    row.querySelector("select").addEventListener("change", async (e) => {
      const value = e.target.value ? Number(e.target.value) : null;
      await api("/contracts/default-map", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [type]: value }),
      });
    });
    box.appendChild(row);
  }
}

document.getElementById("menu-contracts").addEventListener("click", async () => {
  contractsBackdrop.classList.add("open");
  const contracts = await renderContractsList();
  await renderDefaultContracts(contracts);
});
document.getElementById("contracts-close").addEventListener("click", () => contractsBackdrop.classList.remove("open"));

// ---------- редактирование контракта: динамический список строк тип+количество (п.8 третьего раунда) ----------
function addContractLineRow(elementType, quantity) {
  const container = document.getElementById("ce-lines");
  const row = document.createElement("div");
  row.className = "ce-line-row";
  row.innerHTML = `
    <input type="text" class="ce-line-type" list="ce-known-types" placeholder="тип элемента" value="${escapeHtml(elementType || "")}"/>
    <input type="number" class="ce-line-qty" min="0" placeholder="кол-во" value="${quantity != null ? quantity : ""}"/>
    <button class="btn btn-sm btn-secondary ce-line-remove" type="button">✕</button>
  `;
  row.querySelector(".ce-line-remove").addEventListener("click", () => row.remove());
  container.appendChild(row);
}
document.getElementById("ce-add-line").addEventListener("click", () => addContractLineRow());

// ---------- редактирование контракта: инциденты повреждений (см. Docs/backlog.md,
// "Учёт повреждённых элементов...") — через createElement/.value, БЕЗ innerHTML
// с шаблонными литералами (в отличие от addContractLineRow выше — известный,
// отдельно задокументированный техдолг, не трогаем существующий код, но новый
// пишем сразу безопасно) ----------
function addContractIncidentRow(elementType, quantity, incidentDate, description) {
  const container = document.getElementById("ce-incidents");
  const row = document.createElement("div");
  row.className = "ce-incident-row";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "ce-incident-date";
  dateInput.value = incidentDate ? incidentDate.slice(0, 10) : "";

  const typeInput = document.createElement("input");
  typeInput.type = "text";
  typeInput.className = "ce-incident-type";
  typeInput.setAttribute("list", "ce-known-types");
  typeInput.placeholder = "тип элемента";
  typeInput.value = elementType || "";

  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.min = "0";
  qtyInput.className = "ce-incident-qty";
  qtyInput.placeholder = "кол-во";
  qtyInput.value = quantity != null ? quantity : "";

  const descInput = document.createElement("input");
  descInput.type = "text";
  descInput.className = "ce-incident-desc";
  descInput.placeholder = "описание";
  descInput.value = description || "";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn btn-sm btn-secondary ce-incident-remove";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(dateInput, typeInput, qtyInput, descInput, removeBtn);
  container.appendChild(row);
}
document.getElementById("ce-add-incident").addEventListener("click", () => addContractIncidentRow());

function openContractEdit(contract) {
  editingContractId = contract ? contract.id : null;
  document.getElementById("contract-edit-title").textContent = contract ? "Изменить контракт" : "Новый контракт";
  document.getElementById("ce-name").value = contract ? contract.name : "";
  document.getElementById("ce-supplier").value = contract ? contract.supplier : "";
  document.getElementById("ce-contract-date").value = contract && contract.contract_date ? contract.contract_date.slice(0, 10) : "";
  document.getElementById("ce-code").value = contract && contract.code ? contract.code : "";
  // Известные типы элементов после загрузки файла — подсказка в поле
  // "тип элемента" строки контракта (datalist, не строгий список —
  // ввести что-то нестандартное по-прежнему можно), см. Docs/backlog.md.
  document.getElementById("ce-known-types").innerHTML =
    Object.keys(state.labelVisibility).map(t => `<option value="${t}"></option>`).join("");
  document.getElementById("ce-lines").innerHTML = "";
  if (contract && contract.lines.length) {
    for (const l of contract.lines) addContractLineRow(l.element_type, l.quantity);
  } else {
    addContractLineRow();
  }
  // Инциденты — без принудительной пустой строки по умолчанию (в отличие
  // от строк плана выше): ноль инцидентов — обычный, ожидаемый случай.
  document.getElementById("ce-incidents").innerHTML = "";
  if (contract && contract.incidents) {
    for (const inc of contract.incidents) {
      addContractIncidentRow(inc.element_type, inc.quantity, inc.incident_date, inc.description);
    }
  }
  document.getElementById("contract-edit-error").textContent = "";
  contractEditBackdrop.classList.add("open");
}
document.getElementById("contracts-add").addEventListener("click", () => openContractEdit(null));
document.getElementById("contract-edit-cancel").addEventListener("click", () => contractEditBackdrop.classList.remove("open"));
document.getElementById("contract-edit-save").addEventListener("click", async () => {
  const lines = Array.from(document.querySelectorAll("#ce-lines .ce-line-row")).map(row => ({
    element_type: row.querySelector(".ce-line-type").value.trim(),
    quantity: Number(row.querySelector(".ce-line-qty").value || 0),
  })).filter(l => l.element_type);
  const incidents = Array.from(document.querySelectorAll("#ce-incidents .ce-incident-row")).map(row => ({
    element_type: row.querySelector(".ce-incident-type").value.trim(),
    quantity: Number(row.querySelector(".ce-incident-qty").value || 0),
    incident_date: row.querySelector(".ce-incident-date").value,
    description: row.querySelector(".ce-incident-desc").value.trim() || null,
  })).filter(inc => inc.element_type && inc.incident_date);
  const body = {
    name: document.getElementById("ce-name").value.trim(),
    supplier: document.getElementById("ce-supplier").value.trim(),
    contract_date: document.getElementById("ce-contract-date").value || null,
    code: document.getElementById("ce-code").value.trim() || null,
    lines,
    incidents,
  };
  try {
    if (editingContractId) {
      await api(`/contracts/${editingContractId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await api("/contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    contractEditBackdrop.classList.remove("open");
    const contracts = await renderContractsList();
    await renderDefaultContracts(contracts);
    await loadPlan(); // обновить список контрактов в state для карточки элемента
  } catch (e) {
    document.getElementById("contract-edit-error").textContent = e.message;
  }
});

// ---------- Партии контракта (см. Docs/backlog.md, "Партия — учёт по маркам") ----------
const batchesBackdrop = document.getElementById("batches-backdrop");
const batchEditBackdrop = document.getElementById("batch-edit-backdrop");
let batchesContractId = null; // контракт, чьи партии сейчас показаны в #batches-backdrop
let editingBatchId = null;
let editingBatchContractId = null; // контракт редактируемой партии (нужен для POST и для решения, перерисовывать ли список)

// Тип -> подтипы -> марки, построено сканированием state.elements — тот же
// приём, что renderPlacementFilters использует для subtypesByType/
// marksBySubtype (сайдбар "Фильтры"), не расшаренный код, тот же принцип.
// Нужен для каскадного выбора тип/подтип/марка в строке партии — 3
// <select>, не текст+datalist (как у строк контракта): здесь нужно ТОЧНОЕ
// совпадение для проверки при назначении, опечатка в свободном тексте
// сломала бы контроль.
function buildTypeSubtypeMarkMaps() {
  const subtypesByType = new Map(); // type -> Set(subtype-or-"")
  const marksBySubtype = new Map(); // `${type} ${subtype}` -> Set(mark-or-"")
  for (const e of state.elements) {
    const type = e.element_type;
    const subtype = e.subtype || "";
    const mark = e.mark || "";
    if (!subtypesByType.has(type)) subtypesByType.set(type, new Set());
    subtypesByType.get(type).add(subtype);
    const key = `${type} ${subtype}`;
    if (!marksBySubtype.has(key)) marksBySubtype.set(key, new Set());
    marksBySubtype.get(key).add(mark);
  }
  return { subtypesByType, marksBySubtype };
}

async function openBatchesModal(contract) {
  batchesContractId = contract.id;
  document.getElementById("batches-title").textContent = `Партии контракта «${contract.name}»`;
  await renderBatchesList();
  batchesBackdrop.classList.add("open");
}

async function renderBatchesList() {
  const box = document.getElementById("batches-list");
  box.innerHTML = "";
  const batches = await api(`/batches?contract_id=${batchesContractId}`);
  if (!batches.length) { box.innerHTML = '<div class="hint-text">нет партий</div>'; return; }
  for (const b of batches) {
    const block = document.createElement("div");
    block.className = "contract-block";
    const linesHtml = b.lines.length
      ? b.lines.map(l => `
          <tr class="${l.exceeded ? "exceeded" : ""}">
            <td>${escapeHtml(l.element_type)}</td><td>${escapeHtml(l.subtype || "—")}</td><td>${escapeHtml(l.mark || "—")}</td>
            <td>${l.quantity}</td><td>${l.fact}</td><td>${l.remaining}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="6" class="hint-text">нет строк</td></tr>';
    block.innerHTML = `
      <div class="contract-block-header">
        <b>${escapeHtml(b.label)}</b>
        <button class="btn btn-sm btn-secondary" data-edit-batch="${b.id}">Изменить</button>
        <button class="btn btn-sm btn-secondary" data-delete-batch="${b.id}">Удалить</button>
      </div>
      <table class="contract-lines-table">
        <tr><th>Тип</th><th>Подтип</th><th>Марка</th><th>План</th><th>Факт</th><th>Остаток</th></tr>
        ${linesHtml}
      </table>
    `;
    box.appendChild(block);
    block.querySelector("[data-edit-batch]").addEventListener("click", () => openBatchEdit(b));
    block.querySelector("[data-delete-batch]").addEventListener("click", async () => {
      if (!confirm(`Удалить партию «${b.label}»?`)) return;
      await api(`/batches/${b.id}`, { method: "DELETE" });
      await renderBatchesList();
      await loadPlan(); // элементы, привязанные к ней, потеряли batch_id
    });
  }
}
document.getElementById("batches-add").addEventListener("click", () => openBatchEdit(null, batchesContractId));
document.getElementById("batches-close").addEventListener("click", () => batchesBackdrop.classList.remove("open"));

// contractId нужен только при СОЗДАНИИ новой партии (batch=null) — у уже
// существующей партии контракт уже известен (batch.contract_id), не
// меняется. Вызывается и из списка партий контракта, и из карточки
// элемента (см. showCard) — единая точка редактирования партии.
function openBatchEdit(batch, contractId) {
  editingBatchId = batch ? batch.id : null;
  editingBatchContractId = batch ? batch.contract_id : contractId;
  document.getElementById("batch-edit-title").textContent = batch ? "Изменить партию" : "Новая партия";
  document.getElementById("be-date").value = batch && batch.planned_date ? batch.planned_date.slice(0, 10) : "";
  document.getElementById("be-lines").innerHTML = "";
  const maps = buildTypeSubtypeMarkMaps();
  if (batch && batch.lines.length) {
    for (const l of batch.lines) addBatchLineRow(maps, l.element_type, l.subtype, l.mark, l.quantity);
  } else {
    addBatchLineRow(maps);
  }
  document.getElementById("batch-edit-error").textContent = "";
  batchEditBackdrop.classList.add("open");
}
document.getElementById("batch-edit-cancel").addEventListener("click", () => batchEditBackdrop.classList.remove("open"));
document.getElementById("be-add-line").addEventListener("click", () => addBatchLineRow(buildTypeSubtypeMarkMaps()));

function fillTypeSelect(select, types, selected) {
  select.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = "— выберите тип —"; opt0.disabled = true;
  if (!selected) opt0.selected = true;
  select.appendChild(opt0);
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    if (t === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

// "" — легитимное значение (элемент без подтипа/марки), а не "ничего не
// выбрано" — плейсхолдер здесь не нужен, в отличие от типа выше.
function fillSubMarkSelect(select, values, selected, emptyLabel) {
  select.innerHTML = "";
  const sorted = Array.from(values).sort();
  if (!sorted.length) sorted.push("");
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v || emptyLabel;
    if (v === (selected || "")) opt.selected = true;
    select.appendChild(opt);
  }
}

function addBatchLineRow(maps, elementType, subtype, mark, quantity) {
  const container = document.getElementById("be-lines");
  const row = document.createElement("div");
  row.className = "ce-line-row be-line-row";

  const typeSelect = document.createElement("select");
  typeSelect.className = "be-line-type";
  const subtypeSelect = document.createElement("select");
  subtypeSelect.className = "be-line-subtype";
  const markSelect = document.createElement("select");
  markSelect.className = "be-line-mark";
  const qtyInput = document.createElement("input");
  qtyInput.type = "number"; qtyInput.min = "0"; qtyInput.className = "be-line-qty"; qtyInput.placeholder = "кол-во";
  qtyInput.value = quantity != null ? quantity : "";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button"; removeBtn.className = "btn btn-sm btn-secondary be-line-remove"; removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => row.remove());

  function refreshSubtypes(selectedSubtype, selectedMark) {
    const type = typeSelect.value;
    const subtypes = type && maps.subtypesByType.has(type) ? maps.subtypesByType.get(type) : new Set();
    fillSubMarkSelect(subtypeSelect, subtypes, selectedSubtype, "— без подтипа —");
    refreshMarks(selectedMark);
  }
  function refreshMarks(selectedMark) {
    const type = typeSelect.value;
    const key = `${type} ${subtypeSelect.value}`;
    const marks = type && maps.marksBySubtype.has(key) ? maps.marksBySubtype.get(key) : new Set();
    fillSubMarkSelect(markSelect, marks, selectedMark, "— без марки —");
  }

  const types = Array.from(maps.subtypesByType.keys()).sort();
  fillTypeSelect(typeSelect, types, elementType);
  typeSelect.addEventListener("change", () => refreshSubtypes());
  subtypeSelect.addEventListener("change", () => refreshMarks());
  refreshSubtypes(subtype || "", mark || "");

  row.append(typeSelect, subtypeSelect, markSelect, qtyInput, removeBtn);
  container.appendChild(row);
}

document.getElementById("batch-edit-save").addEventListener("click", async () => {
  const lines = Array.from(document.querySelectorAll("#be-lines .be-line-row")).map(row => ({
    element_type: row.querySelector(".be-line-type").value,
    subtype: row.querySelector(".be-line-subtype").value || null,
    mark: row.querySelector(".be-line-mark").value || null,
    quantity: Number(row.querySelector(".be-line-qty").value || 0),
  })).filter(l => l.element_type);
  const plannedDate = document.getElementById("be-date").value;
  if (!plannedDate) {
    document.getElementById("batch-edit-error").textContent = "Укажите плановую дату поставки";
    return;
  }
  const body = { planned_date: plannedDate, lines };
  try {
    if (editingBatchId) {
      await api(`/batches/${editingBatchId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await api("/batches", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, contract_id: editingBatchContractId }),
      });
    }
    batchEditBackdrop.classList.remove("open");
    if (batchesContractId === editingBatchContractId) await renderBatchesList();
    await loadPlan(); // допстрока подписи на схеме и карточка элемента подхватывают изменение сразу
  } catch (e) {
    document.getElementById("batch-edit-error").textContent = e.message;
  }
});

// ---------- экспорт/импорт настроек проекта ----------
const settingsIoBackdrop = document.getElementById("settings-io-backdrop");
document.getElementById("menu-settings-io").addEventListener("click", () => {
  document.getElementById("settings-io-file").value = "";
  document.getElementById("settings-io-status").textContent = "";
  settingsIoBackdrop.classList.add("open");
});
document.getElementById("settings-io-close").addEventListener("click", () => settingsIoBackdrop.classList.remove("open"));
document.getElementById("settings-io-export").addEventListener("click", () => {
  window.location.href = "/settings/export";
});
document.getElementById("settings-io-import").addEventListener("click", async () => {
  const file = document.getElementById("settings-io-file").files[0];
  const statusEl = document.getElementById("settings-io-status");
  if (!file) { statusEl.textContent = "Сначала выберите файл .json"; statusEl.style.color = "var(--color-danger)"; return; }

  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/settings/import", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      statusEl.textContent = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      statusEl.style.color = "var(--color-danger)";
      return;
    }
    statusEl.textContent = `Готово: пользователей ${body.users_upserted}, цветов ${body.status_colors}, настроек подписей ${body.label_visibility}.`;
    statusEl.style.color = "var(--color-text-muted)";
    await loadPlan();
  } catch (e) {
    statusEl.textContent = "Не удалось связаться с сервером: " + e.message;
    statusEl.style.color = "var(--color-danger)";
  }
});

// ---------- импорт истории статусов из XLS ----------
const historyImportBackdrop = document.getElementById("history-import-backdrop");
const historyImportFile = document.getElementById("history-import-file");
const historyImportSubmit = document.getElementById("history-import-submit");

function setHistoryImportStatus(text, isError) {
  const elm = document.getElementById("history-import-status");
  elm.textContent = text;
  elm.style.color = isError ? "var(--color-danger)" : "var(--color-text-muted)";
}

document.getElementById("menu-history-import").addEventListener("click", () => {
  historyImportFile.value = "";
  setHistoryImportStatus("", false);
  document.getElementById("history-import-source").textContent = state.sourceFile || "(источник не выбран)";
  historyImportBackdrop.classList.add("open");
});
document.getElementById("history-import-cancel").addEventListener("click", () => historyImportBackdrop.classList.remove("open"));

historyImportSubmit.addEventListener("click", async () => {
  const file = historyImportFile.files[0];
  if (!file) { setHistoryImportStatus("Сначала выберите файл .xlsx", true); return; }
  if (!state.sourceFile) { setHistoryImportStatus("Сначала выберите источник (чертёж) в тулбаре", true); return; }

  const mode = document.querySelector('input[name="history-import-mode"]:checked').value;
  historyImportSubmit.disabled = true;
  setHistoryImportStatus("Импорт истории…", false);

  const formData = new FormData();
  formData.append("file", file);
  formData.append("source_file", state.sourceFile);
  formData.append("mode", mode);

  try {
    const res = await fetch("/import-history-xlsx", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setHistoryImportStatus((body && body.detail) ? body.detail : `Ошибка ${res.status}`, true);
      return;
    }
    let msg = `Готово: сопоставлено элементов ${body.matched_elements}, добавлено записей ${body.inserted}, ` +
      `пропущено дублей ${body.skipped_duplicate}, не найдено в этой БД ${body.unmatched_elements}.`;
    if (body.unmatched_handles.length) msg += ` Примеры handle без совпадения: ${body.unmatched_handles.join(", ")}.`;
    setHistoryImportStatus(msg, false);
    await loadPlan();
  } catch (e) {
    setHistoryImportStatus("Не удалось связаться с сервером: " + e.message, true);
  } finally {
    historyImportSubmit.disabled = false;
  }
});

// ---------- экспорт XLS ----------
const exportBackdrop = document.getElementById("export-backdrop");
document.getElementById("btn-export").addEventListener("click", () => exportBackdrop.classList.add("open"));
document.getElementById("export-cancel").addEventListener("click", () => exportBackdrop.classList.remove("open"));
document.querySelectorAll('input[name="export-mode"]').forEach(r => r.addEventListener("change", () => {
  const mode = document.querySelector('input[name="export-mode"]:checked').value;
  document.getElementById("export-history-fields").style.display = mode === "history" ? "flex" : "none";
  document.getElementById("export-snapshot-fields").style.display = mode === "snapshot" ? "flex" : "none";
}));
document.getElementById("export-download").addEventListener("click", () => {
  const mode = document.querySelector('input[name="export-mode"]:checked').value;
  const params = new URLSearchParams({ mode, source_file: state.sourceFile });
  if (mode === "history") {
    const from = document.getElementById("export-date-from").value;
    const to = document.getElementById("export-date-to").value;
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
  } else {
    const date = document.getElementById("export-date").value;
    if (date) params.set("date", date);
  }
  window.location.href = `/export.xlsx?${params.toString()}`;
  exportBackdrop.classList.remove("open");
});

// ---------- экспорт в PDF ----------
const exportPdfBackdrop = document.getElementById("export-pdf-backdrop");
document.getElementById("btn-export-pdf").addEventListener("click", () => {
  document.getElementById("export-pdf-date").value = "";
  exportPdfBackdrop.classList.add("open");
});
document.getElementById("export-pdf-cancel").addEventListener("click", () => exportPdfBackdrop.classList.remove("open"));
document.getElementById("export-pdf-download").addEventListener("click", () => {
  const params = new URLSearchParams({ source_file: state.sourceFile });
  const date = document.getElementById("export-pdf-date").value;
  if (date) params.set("date", date);
  window.location.href = `/export.pdf?${params.toString()}`;
  exportPdfBackdrop.classList.remove("open");
});

// ==================== ЗАГРУЗКА ЧЕРТЕЖА ====================
const uploadBackdrop = document.getElementById("upload-backdrop");
const uploadFileInput = document.getElementById("upload-file-input");
const uploadStatus = document.getElementById("upload-status");
const uploadSubmit = document.getElementById("upload-submit");

function setUploadStatus(text, isError) {
  uploadStatus.textContent = text;
  uploadStatus.style.color = isError ? "var(--color-danger)" : "var(--color-text-muted)";
}

document.getElementById("btn-upload").addEventListener("click", () => {
  uploadFileInput.value = "";
  setUploadStatus("", false);
  uploadSubmit.disabled = false;
  uploadFileInput.disabled = false;
  uploadBackdrop.classList.add("open");
});
document.getElementById("upload-cancel").addEventListener("click", () => uploadBackdrop.classList.remove("open"));

uploadSubmit.addEventListener("click", async () => {
  const file = uploadFileInput.files[0];
  if (!file) { setUploadStatus("Сначала выберите файл .dxf", true); return; }

  uploadSubmit.disabled = true;
  uploadFileInput.disabled = true;
  setUploadStatus("Обработка чертежа… это может занять до минуты для больших файлов.", false);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/import-dxf", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const detail = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      setUploadStatus(detail, true);
      uploadSubmit.disabled = false;
      uploadFileInput.disabled = false;
      return;
    }

    const marks = Object.entries(body.by_mark_source).map(([k, v]) => `${k}: ${v}`).join(", ");
    const axes = Object.entries(body.by_axis_status).map(([k, v]) => `${k}: ${v}`).join(", ");
    setUploadStatus(
      `Готово: ${body.total} элементов (новых: ${body.inserted}, обновлено: ${body.updated}). ` +
      `Марки — ${marks}. Адресация — ${axes}. Оси: ${body.axis_grid.numeric} числовых, ${body.axis_grid.letter} буквенных.`,
      false
    );

    layersCache.delete(body.source_file);
    await loadSourceFiles();
    state.selection = new Map([[body.source_file, null]]);
    state.sourceFile = body.source_file;
    updateFileSelectSummary();
    await loadPlan(false); // новый/другой чертёж — координаты другие, старый масштаб бессмысленен

    setTimeout(() => uploadBackdrop.classList.remove("open"), 1200);
  } catch (e) {
    setUploadStatus("Не удалось связаться с сервером: " + e.message, true);
  } finally {
    uploadSubmit.disabled = false;
    uploadFileInput.disabled = false;
  }
});

// ==================== 3D-РЕЖИМ СХЕМЫ (Three.js, см. Docs/backlog.md) ====================
// Библиотека — локально (app/static/vendor/three/, не CDN), подключается
// ЛЕНИВО через динамический import() при первом включении кнопкой "3D",
// а не на каждой загрузке страницы (~700 КБ, нужен не всем). Клики по
// элементам, карточка, контекстное меню статуса, фильтр по размещению —
// переиспользуют ровно те же функции, что и 2D (selectElement/
// openCtxMenu/passesPlacementFilters/styleShape), никакой отдельной
// копии этой логики здесь нет — 3D-код отвечает только за геометрию и
// рендер.

let THREE = null;
let OrbitControls = null;
let LineSegments2 = null;
let LineSegmentsGeometry = null;
let LineMaterial = null;

async function ensureThreeLoaded() {
  if (THREE) return;
  THREE = await import("three");
  ({ OrbitControls } = await import("/static/vendor/three/OrbitControls.js"));
  // "Толстые" линии рёбер силуэта — обычный THREE.LineBasicMaterial.linewidth
  // не работает в большинстве браузеров (WebGL1/ANGLE клэмпит к 1px, см.
  // Docs/backlog.md). Line2/LineMaterial/LineSegmentsGeometry — тот же
  // вендоренный Three.js 0.160.0 (examples/jsm/lines/), заданная толщина
  // реально работает (шейдер строит линию как полосу треугольников,
  // ширина в пикселях экрана через resolution). Вендоринг подтверждён
  // пользователем явно 2026-07-24 (см. Docs/backlog.md).
  ({ LineSegments2 } = await import("/static/vendor/three/examples/jsm/lines/LineSegments2.js"));
  ({ LineSegmentsGeometry } = await import("/static/vendor/three/examples/jsm/lines/LineSegmentsGeometry.js"));
  ({ LineMaterial } = await import("/static/vendor/three/examples/jsm/lines/LineMaterial.js"));
}

// ---------- высота элемента в 3D ----------

// Список уникальных отметок (мм) именно у КОЛОНН (не у всех элементов) —
// это и есть "ярусы" в смысле высоты колонны: следующий уровень для
// колонны должен быть следующим этажом колонн, а не отметкой случайно
// подвернувшегося ригеля на промежуточной высоте (например, ригель-
// парапет на +5000 между этажами колонн 0 и +15800 — если бы уровни
// считались по всем элементам, колонна с отметки 0 получила бы высоту
// всего 5000мм вместо реальных 15800). Заказчик подтвердил правило
// "высота колонны — до следующего уровня" именно в смысле этажей
// колонн, см. Docs/backlog.md.
function computeColumnLevels() {
  const set = new Set();
  for (const e of state.elements) {
    if (e.element_type === "Колонна" && e.elevation_mm !== null && e.elevation_mm !== undefined) set.add(e.elevation_mm);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// Площадь и периметр контура по формуле шнурков — устойчиво к повороту
// элемента на плане, в отличие от габаритного прямоугольника (bounding
// box), который на повёрнутом прямоугольнике завышает обе стороны.
// Контур ригеля/плиты/панели считаем прямоугольником (или близко к
// нему): тогда из площади S и полупериметра P=(a+b) обе стороны —
// корни уравнения a*b=S, a+b=P. Возвращаем МЕНЬШИЙ корень — это и есть
// ширина сечения (заказчик подтвердил: сечение квадратное, высота
// экструзии = эта ширина, см. Docs/backlog.md).
function crossSectionWidth(outline) {
  if (!outline || outline.length < 3) return null;
  let area2 = 0, perimeter = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % n];
    area2 += x1 * y2 - x2 * y1;
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  const area = Math.abs(area2) / 2;
  if (area === 0) return null;
  const halfPerimeter = perimeter / 2;
  const disc = halfPerimeter * halfPerimeter - 4 * area;
  if (disc < 0) return Math.sqrt(area); // не должно случаться для прямоугольника — запасной вариант
  const width = (halfPerimeter - Math.sqrt(disc)) / 2;
  return width > 0 ? width : Math.sqrt(area);
}

const DEFAULT_EXTRUSION_HEIGHT = 3000; // мм — запасной вариант, если высоту иначе не определить

// Фиксированная толщина плиты перекрытия (заказчик подтвердил, см.
// Docs/backlog.md, "Новый файл — плиты перекрытия") — весь тип "Плита
// перекрытия" целиком, а не только конкретный подтип/отметка; НЕ
// распространяется на тип "Плита" (генерик, отдельный от "Плита
// перекрытия", пока не встречался в реальных данных) — тот при появлении
// продолжит считаться по допущению "квадратное сечение" ниже.
const FLOOR_SLAB_THICKNESS_MM = 300;

// Верхняя отметка, до которой должен доходить САМЫЙ ВЕРХНИЙ ярус колонн —
// отметка ближайшей ПЛИТЫ ПЕРЕКРЫТИЯ выше него, если такая есть (напр.
// локальная кровля техпомещения без своего яруса колонн — см. новый файл
// 260720, Docs/backlog.md, "Новый файл 260720"), иначе запасной вариант,
// как и раньше — высота последнего межъярусного шага.
function computeTopColumnCeiling(levels) {
  if (!levels.length) return null;
  const topLevel = levels[levels.length - 1];
  let ceiling = null;
  for (const e of state.elements) {
    if (e.element_type === "Плита перекрытия" && e.elevation_mm != null && e.elevation_mm > topLevel) {
      if (ceiling === null || e.elevation_mm < ceiling) ceiling = e.elevation_mm;
    }
  }
  if (ceiling !== null) return ceiling;
  const lastGap = levels.length > 1 ? topLevel - levels[levels.length - 2] : DEFAULT_EXTRUSION_HEIGHT;
  return topLevel + lastGap;
}

// - Колонна — от своей отметки до следующего яруса; для самого верхнего
//   яруса — до ближайшей плиты перекрытия выше (см. computeTopColumnCeiling),
//   а если такой нет — запасной вариант, высота предыдущего яруса (или
//   дефолт, если ярус всего один).
// - Плита перекрытия — фиксированная толщина (см. FLOOR_SLAB_THICKNESS_MM).
// - Ригель/Плита/Панель — квадратное сечение, высота = ширина контура.
function elementExtrusionHeight(element, levels) {
  if (element.element_type === "Колонна") {
    const idx = levels.indexOf(element.elevation_mm);
    if (idx !== -1 && idx < levels.length - 1) return levels[idx + 1] - levels[idx];
    if (idx === levels.length - 1) {
      const ceiling = computeTopColumnCeiling(levels);
      if (ceiling !== null) return ceiling - element.elevation_mm;
    }
    if (idx > 0) return levels[idx] - levels[idx - 1];
    return DEFAULT_EXTRUSION_HEIGHT;
  }
  if (element.element_type === "Плита перекрытия") {
    return FLOOR_SLAB_THICKNESS_MM;
  }
  return crossSectionWidth(element.outline) || DEFAULT_EXTRUSION_HEIGHT;
}

// ---------- построение сцены ----------

// Цвет ребра силуэта в 3D — ВСЕГДА чёрный, не зависит от статуса/цвета
// грани (было — темнее заливки в 3 раза, живой репорт пользователя
// 2026-07-24: даже потемневший статусный цвет на фоне полутонов серой
// схемы недостаточно контрастен, попросил "все грани делаем чёрными").
const EDGE_COLOR = 0x000000;

// Толщина ребра силуэта в 3D — В ПИКСЕЛЯХ ЭКРАНА (LineMaterial по
// умолчанию worldUnits:false — ширина не "в мм мира", а в пикселях
// вьюпорта, не меняется с зумом камеры). Живой репорт пользователя
// 2026-07-24: 1px (обычный GL LineSegments) практически не видно; 4px
// (чёрный) хорошо видно, но пользователь попросил чуть тоньше — 2px
// чёрным на серой схеме уже достаточно контрастно (в отличие от 2px
// затемнённым статусным цветом, которого не хватало).
const EDGE_LINE_WIDTH_PX = 2;

// Общий материал грани НА СТАТУС (не на элемент) — раньше был свой
// экземпляр MeshStandardMaterial на КАЖДЫЙ элемент (~9400 на реальном
// файле), той же природы проблема, что уже чинили для рёбер (см.
// edgeMaterial выше): тысячи разных материалов ломают сортировку
// рендера по материалу, WebGL вынужден переключать состояние на каждый
// элемент отдельно при вращении/зуме — заметно тормозит на живых данных
// (живой репорт пользователя, см. Docs/backlog.md). Статусов — фиксированный
// небольшой набор (см. state.statusOrder), а не по одному на элемент.
function getStatusMeshMaterial(status) {
  const v3 = state.view3d;
  let material = v3.materialByStatus.get(status);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: colorFor(status),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    v3.materialByStatus.set(status, material);
  }
  return material;
}

// Подсветка выбранного элемента (emissive) — материал статуса теперь
// общий на много элементов, менять его emissive/color в месте (как
// раньше) подсветило бы ВСЕ элементы этого статуса разом. Выбранный
// элемент — всегда только один, поэтому один переиспользуемый материал
// (не на статус — эксклюзивно на "текущий выбранный"), перекрашиваемый
// под цвет статуса конкретного элемента при каждом выборе.
function getHighlightMeshMaterial(status) {
  const v3 = state.view3d;
  if (!v3.highlightMaterial) {
    v3.highlightMaterial = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
      emissive: 0x333333,
    });
  }
  v3.highlightMaterial.color.set(colorFor(status));
  return v3.highlightMaterial;
}

function build3DMeshForElement(element, levels) {
  if (!element.outline || element.outline.length < 3) return null; // нечего экструдировать
  const height = elementExtrusionHeight(element, levels);
  // Shape строится в локальной плоскости XY, shapeY = мировой Y как есть
  // (БЕЗ инверсии — см. Docs/backlog.md, "3D — зеркальность"). После
  // поворота geometry.rotateX(-90°) локальная (x,y,z) -> мировая (x,z,-y):
  // локальная ось экструзии (z: 0..height) становится мировой "вверх"
  // (Y), а мировая Z = -мировая Y элемента. Это НЕ ошибка и не "зеркалит"
  // план — это единственный способ у право-ориентированной (как и везде
  // в Three.js/WebGL) системы координат с Y-вверх корректно, без
  // зеркальности, показать план, лежащий в исходных данных в плоскости
  // X-Y (Y-вверх на бумаге), если смотреть на сцену сверху так же, как
  // смотрят на 2D-чертёж (X вправо, "северное" +Y дальше от зрителя).
  // Была допущена обратная ошибка (плюс вместо минуса) — из-за нее план
  // в 3D действительно зеркалился по одной из осей при взгляде сверху.
  //
  // Контур строится НАПРЯМУЮ из element.outline, без офсетов/отступов
  // в плане и по высоте (было — см. Docs/backlog.md, живые репорты
  // пользователя 2026-07-24: "клин" на торце вытянутого ригеля,
  // "короб в коробе" на короткой марке — обе проблемы были в приёме с
  // раздутым/утопленным контуром, не в самой геометрии). Заказчик явно
  // потребовал: "3D объект должен точно соответствовать своей геометрии
  // и координатам из входящих данных" — экструзия РОВНО от elevation_mm
  // до elevation_mm+height, без запасов.
  const points = element.outline.map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(points);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  // DoubleSide — смена знака выше меняет и порядок обхода контура
  // (winding), а с ним и направление нормалей граней; чтобы это не
  // привело к отбраковке "невидимых" граней (backface culling у
  // MeshStandardMaterial по умолчанию), рисуем обе стороны.
  //
  // polygonOffset — ребро (LineSegments2 ниже) лежит РОВНО на поверхности
  // грани (та же геометрия, никакого зазора между ними больше нет — см.
  // выше, "точно соответствовать геометрии из входных данных"), у обоих
  // одинаковая глубина в буфере — без явного сдвига это чистый z-fighting,
  // и грань (закрашивает МНОГО пикселей) выигрывает у линии (закрашивает
  // мало) почти всегда, из-за чего ребро не видно вообще, живой репорт
  // пользователя 2026-07-24. Стандартное решение — сдвинуть саму грань
  // чуть "дальше от камеры" в буфере глубины (не физически, только в
  // сравнении глубин), чтобы линия поверх нее гарантированно проходила
  // тест глубины. factor/units=4 (не стандартные 1/1) — модель в мм на
  // весь масштаб здания, обычной величины смещения на реальных данных не
  // хватило (тот же живой репорт); см. также logarithmicDepthBuffer в
  // init3DScene — тот же класс проблемы (точность буфера глубины на
  // большом разбросе near/far), другая причина. Сам материал — общий на
  // статус (getStatusMeshMaterial), не свой на каждый элемент — см. её
  // комментарий.
  const material = getStatusMeshMaterial(element.current_status);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, element.elevation_mm || 0, 0);
  mesh.userData.elementId = element.id;

  // Рёбра силуэта — THREE.EdgesGeometry (не приём с раздутым дублирующим
  // мешом, который использовался раньше и приводил к артефактам на
  // стыках/вытянутых контурах, см. выше) даёт только настоящие рёбра
  // силуэта (сама отбрасывает "швы" между компланарными треугольниками —
  // например, диагонали триангуляции крышки контура), но её позиции
  // скармливаются НЕ обычному THREE.LineSegments (тонкая 1px GL-линия,
  // не работает в большинстве браузеров — см. историю в Docs/TZ.md §6.7),
  // а LineSegments2/LineSegmentsGeometry — те же вершины, только
  // рендерятся полосой треугольников заданной ширины В ПИКСЕЛЯХ экрана,
  // реально видна в любом браузере. Материал — ОБЩИЙ на все элементы
  // (`state.view3d.edgeMaterial`, см. init3DScene) — свой на каждый
  // элемент был не нужен уже тогда, когда цвет ребра стал фиксированным
  // (EDGE_COLOR), но тормозил рендер (см. init3DScene). Вендоринг
  // подтверждён пользователем явно (см. Docs/backlog.md, 2026-07-24).
  const edgesGeometry = new THREE.EdgesGeometry(geometry);
  const lineGeometry = new LineSegmentsGeometry();
  lineGeometry.setPositions(edgesGeometry.attributes.position.array);
  edgesGeometry.dispose(); // нужна была только чтобы получить позиции рёбер
  const edges = new LineSegments2(lineGeometry, state.view3d.edgeMaterial);
  edges.userData.elementId = element.id; // клик по ребру тоже должен выделять элемент
  mesh.add(edges);
  mesh.userData.edges = edges;

  return mesh;
}

// Мировая высота подписи в 3D — раньше фиксированная величина
// (baseMarkerRadius*3, ~75мм на реальном файле) НЕЗАВИСИМО от размера
// самого элемента — марка выглядела еле заметной точкой на метровых
// плитах перекрытия и полноразмерных колоннах (живой скриншот, см.
// Docs/backlog.md, 2026-07-23). Теперь — доля от СОБСТВЕННОЙ ширины
// сечения элемента (`crossSectionWidth` — та же устойчивая к повороту
// геометрия, что уже даёт высоту экструзии Ригелю/Панели, не бьётся
// заново). Заказчик подтвердил явно для плит перекрытия ("высота букв
// чуть меньше ширины плиты") — тем же приёмом распространено на все
// типы ("на колоннах тоже крупнее"), а не только на Плиту перекрытия,
// иначе получились бы два разных правила без причины. Нижний предел —
// не даёт подписи выродиться в точку на аномально узком контуре.
const LABEL_3D_WIDTH_FRACTION = 0.8;
const MIN_LABEL_3D_WORLD_MM = 150;

function label3DWorldHeight(element) {
  const width = crossSectionWidth(element.outline);
  return Math.max((width || 0) * LABEL_3D_WIDTH_FRACTION, MIN_LABEL_3D_WORLD_MM);
}

// Постоянная подпись марки в 3D (см. Docs/backlog.md, "Раунд из 3
// пунктов", 2026-07-17, п.3) — THREE.Sprite с canvas-текстурой: билборд
// к камере автоматический (не нужно ничего обновлять per-frame в
// animate3D()), в отличие от плоскости/TextGeometry. Провендорено только
// ядро Three.js (Sprite/SpriteMaterial — его часть) — CSS2DRenderer/
// TextGeometry НЕ провендорены, а по правилу проекта новый сторонний код
// требует отдельного подтверждения (см. CLAUDE.md), поэтому выбран путь
// без нового вендоринга.
function build3DLabelSprite(element, topY) {
  if (!element.mark) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 48; // размер текстуры холста — не экранный размер, см. sprite.scale ниже
  const subFontPx = fontPx * SUBLABEL_FONT_SCALE;
  const subText = elementSubLabelText(element);
  const paddingX = 8, paddingY = 8, lineGap = 4;

  ctx.font = `${fontPx}px sans-serif`;
  const markWidth = ctx.measureText(element.mark).width;
  let subWidth = 0;
  if (subText) {
    ctx.font = `${subFontPx}px sans-serif`;
    subWidth = ctx.measureText(subText).width;
  }
  canvas.width = Math.ceil(Math.max(markWidth, subWidth)) + paddingX * 2;
  canvas.height = Math.ceil(fontPx + (subText ? lineGap + subFontPx : 0)) + paddingY * 2;

  // Полупрозрачная белая подложка — контраст на любом цвете элемента под
  // спрайтом (буквально то, что запрошено, см. Docs/backlog.md; в canvas,
  // в отличие от 2D SVG, это простая безопасная операция).
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = currentLabelColor();
  ctx.textBaseline = "middle";
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillText(element.mark, paddingX, paddingY + fontPx / 2);
  if (subText) {
    ctx.font = `${subFontPx}px sans-serif`;
    ctx.fillStyle = "#555";
    ctx.fillText(subText, paddingX, paddingY + fontPx + lineGap + subFontPx / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true });
  const sprite = new THREE.Sprite(material);
  // Масштаб в мировых единицах (мм) — от собственного размера элемента
  // (см. label3DWorldHeight выше), не от глобального baseMarkerRadius.
  // worldPerPx — отношение мировых единиц к пикселю холста, зафиксировано
  // по ОДНОСТРОЧНОЙ высоте (как было раньше), чтобы марка визуально не
  // меняла размер при появлении/исчезновении второй строки — просто
  // спрайт становится выше/ниже.
  const referenceCanvasHeight = fontPx + paddingY * 2;
  const worldPerPx = label3DWorldHeight(element) / referenceCanvasHeight;
  const worldHeight = canvas.height * worldPerPx;
  sprite.scale.set(canvas.width * worldPerPx, worldHeight, 1);
  // world.X=dxf.x, world.Y=высота, world.Z=-dxf.y (см. build3DMeshForElement
  // выше) — подпись чуть выше верхней грани элемента.
  sprite.position.set(element.x, topY + worldHeight * 0.6, -element.y);
  sprite.userData.elementId = element.id;
  return sprite;
}

// Нижний и верхний уровень здания (мм) — по ярусам КОЛОНН (см.
// computeColumnLevels): низ — самый нижний ярус, верх — до ближайшей
// плиты перекрытия выше верхнего яруса колонн, если есть, иначе тот же
// запасной вариант, что и у самой верхней колонны в
// elementExtrusionHeight (см. computeTopColumnCeiling, Docs/backlog.md).
// Используется для захватки — "объём во всю высоту здания".
function computeBuildingHeightRange() {
  const levels = computeColumnLevels();
  if (!levels.length) return { bottom: 0, top: DEFAULT_EXTRUSION_HEIGHT };
  const bottom = levels[0];
  const top = computeTopColumnCeiling(levels);
  return { bottom, top };
}

// Цвет по категории — запасной вариант, если у зоны нет своего color
// (Захватка своих цветов не имеет вовсе, см. 6.6 ТЗ; те же оттенки, что
// и у 2D-подложки, см. CSS .zone-Захватка/.zone-Кран/.zone-Стоянка).
const ZONE_CATEGORY_COLOR_3D = { "Захватка": 0x1353d6, "Кран": 0xc0392b, "Стоянка": 0x7c3aed };

// Отсортированный список РЕАЛЬНО нарисованных ярусов стоянок (разные
// elevation_mm среди зон категории "Стоянка") — источник истины для
// объёмной стоянки ниже, тот же приём, что computeColumnLevels() для
// колонн. Если ярус только один (старые файлы — см. Docs/backlog.md,
// 260722) — объёмный режим не включается, см. build3DZoneMesh.
function stanceTierElevations() {
  return Array.from(new Set(
    state.zones.filter(z => z.category === "Стоянка" && z.elevation_mm != null).map(z => z.elevation_mm)
  )).sort((a, b) => a - b);
}

// Видимость меша ЗОНЫ — Захватка/Кран по общему тумблеру категории
// (state.zoneVisibility), Стоянка — по своей гранулярной opt-in
// видимости конкретной (кран, стоянка) (state.stanceZoneVisible, см.
// renderStanceZoneToggles).
function zoneMeshVisible(zone) {
  if (zone.category === "Стоянка") return state.stanceZoneVisible.has(stanceLogicalKey(zone.id));
  return state.zoneVisibility[zone.category] !== false;
}

// Захватка и Кран — объём НА ВСЮ ВЫСОТУ здания (заказчик подтвердил
// про Кран отдельно: "тебе дан на схеме контур основания, вертикально
// — до самой верхней точки здания", см. Docs/backlog.md), сильно
// полупрозрачный, чтобы элементы внутри оставались хорошо видны.
// Стоянка — ЕСЛИ в файле несколько РЕАЛЬНО нарисованных ярусов стоянок
// (см. stanceTierElevations), тоже объём: от СВОЕЙ отметки до ближайшей
// стоянки ЭТОГО же крана/номера следующим ярусом выше (заказчик
// подтвердил, см. Docs/backlog.md, 260722 — "объёмная фигура из
// параллелепипедов, поставленных друг на друга") — каждая ярусная зона
// даёт свой параллелепипед, вместе они и образуют башню. Если ярус
// стоянок в файле всего один (старые файлы) — прежнее поведение: плоский
// полигон на Y=10 (не мерцает поверх сетки/пола). depthWrite:false —
// иначе несколько полупрозрачных зон, перекрывающих друг друга
// (например, захватка и кран на одном участке плана), давали бы
// артефакты сортировки глубины.
function build3DZoneMesh(zone, heightRange, stanceTiers) {
  if (!zone.outline || zone.outline.length < 3) return null;
  // Без инверсии Y — та же поправка, что и у элементов (см.
  // build3DMeshForElement, Docs/backlog.md "3D — зеркальность").
  const points = zone.outline.map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(points);

  let geometry, positionY, opacity;
  if (zone.category === "Захватка" || zone.category === "Кран") {
    geometry = new THREE.ExtrudeGeometry(shape, { depth: heightRange.top - heightRange.bottom, bevelEnabled: false, steps: 1 });
    geometry.rotateX(-Math.PI / 2);
    positionY = heightRange.bottom;
    opacity = 0.07; // как у 2D-подложки (fill-opacity:.07) — элементы внутри не теряются
  } else if (zone.category === "Стоянка" && stanceTiers.length > 1 && zone.elevation_mm != null) {
    const idx = stanceTiers.indexOf(zone.elevation_mm);
    const top = idx !== -1 && idx < stanceTiers.length - 1 ? stanceTiers[idx + 1] : heightRange.top;
    const height = Math.max(top - zone.elevation_mm, 1);
    geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
    geometry.rotateX(-Math.PI / 2);
    positionY = zone.elevation_mm;
    opacity = 0.15; // объём крупнее прежнего плоского маркера — темнее 0.35 не терять элементы внутри
  } else {
    geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    positionY = 10; // небольшой отступ от 0 — не мерцает поверх сетки/пола
    opacity = 0.35;
  }

  const color = zone.color ? Number(("0x" + zone.color.replace("#", ""))) : ZONE_CATEGORY_COLOR_3D[zone.category] || 0x999999;
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, positionY, 0);
  mesh.visible = zoneMeshVisible(zone);
  return mesh;
}

// Текстовая марка Крана/Стоянки в ОСНОВАНИИ её объёма (заказчик запросил
// явно, см. Docs/backlog.md) — тот же приём canvas-текстуры/спрайта, что
// и постоянная подпись элемента (build3DLabelSprite), но проще (одна
// строка, без допстроки/партии). Захватка — БЕЗ подписи (не запрошено,
// вся площадь и так подписана в 2D). Мировой размер — ФИКСИРОВАННЫЙ, не
// пропорциональный собственному размеру зоны (как у элементов, см.
// label3DWorldHeight) — зоны отличаются по площади на порядки (от пары
// метров до сотни), пропорциональный размер там был бы то точкой, то
// гигантской стеной текста.
const ZONE_LABEL_3D_WORLD_HEIGHT = 2000;

function build3DZoneLabelSprite(zone, baseY) {
  if (!zone.outline || zone.outline.length < 3) return null;
  const cx = zone.outline.reduce((s, p) => s + p[0], 0) / zone.outline.length;
  const cy = zone.outline.reduce((s, p) => s + p[1], 0) / zone.outline.length;
  const text = zoneDisplayName(zone);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 48;
  const paddingX = 10, paddingY = 8;
  ctx.font = `${fontPx}px sans-serif`;
  canvas.width = Math.ceil(ctx.measureText(text).width) + paddingX * 2;
  canvas.height = fontPx + paddingY * 2;

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = zone.color || `#${(ZONE_CATEGORY_COLOR_3D[zone.category] || 0x333333).toString(16).padStart(6, "0")}`;
  ctx.textBaseline = "middle";
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillText(text, paddingX, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true });
  const sprite = new THREE.Sprite(material);
  const worldPerPx = ZONE_LABEL_3D_WORLD_HEIGHT / canvas.height;
  sprite.scale.set(canvas.width * worldPerPx, ZONE_LABEL_3D_WORLD_HEIGHT, 1);
  // world.X=dxf.x, world.Z=-dxf.y — та же поправка, что и у элементов
  // (см. build3DMeshForElement, Docs/backlog.md "3D — зеркальность").
  sprite.position.set(cx, baseY + ZONE_LABEL_3D_WORLD_HEIGHT * 0.6, -cy);
  sprite.userData.zoneId = zone.id;
  return sprite;
}

// Видимость 3D-зон по тумблерам "Отображение зон" — без пересборки
// геометрии (см. renderZoneToggles/renderStanceZoneToggles). Подпись
// (zoneLabelSpriteById) следует той же видимости, что и объём зоны.
function apply3DZoneVisibility() {
  for (const [zoneId, mesh] of state.view3d.zoneMeshById) {
    const zone = state.zones.find(z => z.id === zoneId);
    if (zone) mesh.visible = zoneMeshVisible(zone);
  }
  for (const [zoneId, sprite] of state.view3d.zoneLabelSpriteById) {
    const zone = state.zones.find(z => z.id === zoneId);
    if (zone) sprite.visible = zoneMeshVisible(zone);
  }
}

// Видимость постоянных 3D-подписей марок — переиспользует ТОТ ЖЕ
// state.labelVisibility, что и 2D (не заводим отдельное состояние), тем
// же приёмом, что apply3DZoneVisibility выше для зон. Учитывает и
// текущие фильтры (элемент, скрытый фильтром, не должен показывать
// подпись), см. также applyPlacementFilters.
function apply3DLabelVisibility() {
  for (const [id, sprite] of state.view3d.labelSpriteById) {
    const element = state.byId.get(id);
    if (!element) continue;
    sprite.visible = passesPlacementFilters(element) && state.labelVisibility[element.element_type] !== false;
  }
}

// Точечная пересборка ОДНОГО 3D-спрайта после смены статуса/партии —
// холст-текстура запекается один раз при создании, точечно её не
// перерисовать, проще пересоздать сам спрайт (тот же приём, что для 2D
// делает updateElementSubLabel, только здесь весь спрайт, не только
// вторая строка). Ничего не делает, если 3D ни разу не открывали в этом
// сеансе (v3.scene ещё null — сцена просто не построена).
function rebuild3DLabelSprite(element) {
  const v3 = state.view3d;
  if (!v3.scene) return;
  const old = v3.labelSpriteById.get(element.id);
  if (old) {
    v3.scene.remove(old);
    old.material.map.dispose();
    old.material.dispose();
    v3.labelSpriteById.delete(element.id);
  }
  const levels = computeColumnLevels();
  const topY = (element.elevation_mm || 0) + elementExtrusionHeight(element, levels);
  const sprite = build3DLabelSprite(element, topY);
  if (!sprite) return;
  sprite.visible = passesPlacementFilters(element) && state.labelVisibility[element.element_type] !== false;
  v3.scene.add(sprite);
  v3.labelSpriteById.set(element.id, sprite);
}

// Едва заметная подложка ГРАНИЦ ВСЕГО ПРОЕКТА — прямоугольник по охвату
// ВСЕХ загруженных элементов (state.elements целиком, не то, что сейчас
// проходит фильтры/включено в "Отображение зон") — заказчик запросил
// явно (см. Docs/backlog.md): ориентир на плане, даже когда фильтрами
// или настройками отображения скрыто вообще всё остальное (элементы,
// зоны). Плоская, чуть НИЖЕ нулевой отметки (не совпадает по глубине с
// гранью элементов на elevation_mm=0 — иначе z-fighting).
function build3DSiteBaseMesh() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of state.elements) {
    const pts = e.outline && e.outline.length ? e.outline : [[e.x, e.y]];
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) return null;

  const geometry = new THREE.PlaneGeometry(maxX - minX, maxY - minY);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color: 0x808080, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // world.X=dxf.x, world.Z=-dxf.y — та же поправка, что и у элементов
  // (см. build3DMeshForElement, Docs/backlog.md "3D — зеркальность").
  mesh.position.set((minX + maxX) / 2, -5, -(minY + maxY) / 2);
  return mesh;
}

function build3DScene() {
  const v3 = state.view3d;
  if (!v3.scene) return;
  if (v3.siteBaseMesh) {
    v3.scene.remove(v3.siteBaseMesh);
    v3.siteBaseMesh.geometry.dispose();
    v3.siteBaseMesh.material.dispose();
    v3.siteBaseMesh = null;
  }
  for (const mesh of v3.meshById.values()) {
    v3.scene.remove(mesh);
    mesh.geometry.dispose();
    // НЕ mesh.material.dispose() — материал теперь ОБЩИЙ на статус
    // (state.view3d.materialByStatus/highlightMaterial, см.
    // getStatusMeshMaterial), живёт всю сессию 3D-режима, не
    // пересоздаётся на каждую перестройку сцены.
    //
    // Рёбра силуэта — дочерний LineSegments (см. build3DMeshForElement),
    // своя geometry (родительский dispose() выше её не трогает) — но
    // НЕ материал: он теперь ОБЩИЙ на все элементы (state.view3d.
    // edgeMaterial), живёт всю сессию 3D-режима, не пересоздаётся на
    // каждую перестройку сцены.
    if (mesh.userData.edges) {
      mesh.userData.edges.geometry.dispose();
    }
  }
  v3.meshById.clear();
  for (const mesh of v3.zoneMeshById.values()) {
    v3.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  v3.zoneMeshById.clear();
  for (const sprite of v3.zoneLabelSpriteById.values()) {
    v3.scene.remove(sprite);
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  v3.zoneLabelSpriteById.clear();
  for (const sprite of v3.labelSpriteById.values()) {
    v3.scene.remove(sprite);
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  v3.labelSpriteById.clear();

  const levels = computeColumnLevels();
  for (const element of state.elements) {
    const mesh = build3DMeshForElement(element, levels);
    if (!mesh) continue;
    const passes = passesPlacementFilters(element);
    mesh.visible = passes;
    // Материал теперь общий на статус (см. getStatusMeshMaterial) — менять
    // его emissive прямо здесь подсветило бы ВСЕ элементы этого статуса
    // разом; выбранный элемент получает отдельный, эксклюзивно свой
    // highlight-материал (см. getHighlightMeshMaterial).
    if (state.selectedId === element.id) mesh.material = getHighlightMeshMaterial(element.current_status);
    v3.scene.add(mesh);
    v3.meshById.set(element.id, mesh);

    const topY = (element.elevation_mm || 0) + elementExtrusionHeight(element, levels);
    const sprite = build3DLabelSprite(element, topY);
    if (sprite) {
      sprite.visible = passes && state.labelVisibility[element.element_type] !== false;
      v3.scene.add(sprite);
      v3.labelSpriteById.set(element.id, sprite);
    }
  }

  const heightRange = computeBuildingHeightRange();
  const stanceTiers = stanceTierElevations();
  for (const zone of state.zones) {
    const mesh = build3DZoneMesh(zone, heightRange, stanceTiers);
    if (!mesh) continue;
    v3.scene.add(mesh);
    v3.zoneMeshById.set(zone.id, mesh);

    if (zone.category === "Кран" || zone.category === "Стоянка") {
      const baseY = zone.category === "Кран" ? heightRange.bottom : (zone.elevation_mm ?? heightRange.bottom);
      const labelSprite = build3DZoneLabelSprite(zone, baseY);
      if (labelSprite) {
        labelSprite.visible = mesh.visible;
        v3.scene.add(labelSprite);
        v3.zoneLabelSpriteById.set(zone.id, labelSprite);
      }
    }
  }

  // Всегда видима, без учёта фильтров/тумблеров зон — см. build3DSiteBaseMesh.
  v3.siteBaseMesh = build3DSiteBaseMesh();
  if (v3.siteBaseMesh) v3.scene.add(v3.siteBaseMesh);

  fit3DCameraToData();
}

// ---------- сцена, камера, свет, управление ----------

function init3DScene() {
  const v3 = state.view3d;
  if (v3.scene) return; // однократно — дальше только build3DScene() пересобирает меши
  const container = document.getElementById("stage-3d");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeceff3);

  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / Math.max(container.clientHeight, 1), 10, 5_000_000);

  // logarithmicDepthBuffer — модель измеряется в мм (десятки-сотни тысяч
  // единиц), а камера должна видеть и деталь в упор, и всё здание целиком
  // (near/far в fit3DCameraToData считаются от габарита данных, разброс
  // на реальных файлах — 4-5 порядков) — обычный (линейный после
  // перспективного деления) буфер глубины на такой разброс имеет очень
  // грубую точность вдали от камеры, что усугубляет z-fighting ребра с
  // гранью (см. polygonOffset в build3DMeshForElement) на среднем и
  // дальнем плане. Вендоренный LineMaterial уже поддерживает логарифмический
  // буфер "из коробки" (штатный чанк `logdepthbuf_*` в шейдере, тот же,
  // что использует весь остальной Three.js).
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  // devicePixelRatio на Retina/HiDPI мониторах — обычно 2 — линейно
  // умножает объём работы фрагментного шейдера КАЖДЫЙ кадр (в 4 раза
  // больше пикселей физического буфера, чем на 1x). На сцене с ~9000+
  // элементов заметно сказывается на плавности вращения/зума (живой
  // репорт пользователя, см. Docs/backlog.md). 1.5 — компромисс: заметно
  // дешевле полного 2x, картинка всё ещё существенно чётче, чем при 1x.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x505050, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // Дефолт библиотеки (zoomSpeed=1) рассчитан на "стандартный" масштаб
  // сцены — у нас мировые координаты в мм, десятки-сотни тысяч единиц.
  // OrbitControls.getZoomScale() нормализует шаг зума через
  // event.deltaY/(100*devicePixelRatio) — трекпад Mac шлёт много событий
  // с очень маленьким deltaY (плавная инерциальная прокрутка), из-за чего
  // с дефолтной чувствительностью один "тик" меняет масштаб на доли
  // процента — приблизить/отдалить требует очень долгой прокрутки. Не
  // зависит от масштаба сцены как такового, но субъективно ощущается
  // именно на такой крупной модели. Ускоряем множителем, не трогая саму
  // библиотеку.
  controls.zoomSpeed = 4;
  controls.addEventListener("change", updateZoomIndicator3D);

  // Один общий материал на ВСЕ рёбра всех элементов — раньше был свой
  // экземпляр LineMaterial на каждый элемент (нужен был свой цвет
  // статуса), но с переходом на фиксированный чёрный цвет (см.
  // EDGE_COLOR) все рёбра рисуются ОДНИМ и тем же материалом — тысячи
  // отдельных материалов (на реальном файле ~9000+ элементов) заставляли
  // WebGL постоянно переключать состояние рендера между гранью и каждым
  // ребром — заметно тормозило вращение/зум на живых данных, см.
  // Docs/backlog.md. Общий материал сортируется Three.js рядом при
  // рендере — намного меньше переключений состояния.
  const resolution = new THREE.Vector2();
  renderer.getSize(resolution);
  v3.edgeMaterial = new LineMaterial({ color: EDGE_COLOR, linewidth: EDGE_LINE_WIDTH_PX, resolution });

  v3.scene = scene;
  v3.camera = camera;
  v3.renderer = renderer;
  v3.controls = controls;
  v3.raycaster = new THREE.Raycaster();
  v3.mouse = new THREE.Vector2();

  renderer.domElement.addEventListener("click", on3DClick);
  renderer.domElement.addEventListener("dblclick", on3DContextMenu);
  renderer.domElement.addEventListener("contextmenu", on3DContextMenu);
  renderer.domElement.addEventListener("mousemove", on3DMouseMove);
  renderer.domElement.addEventListener("mouseleave", hide3DTooltip);
  window.addEventListener("resize", on3DResize);
}

// Вписывает камеру по охвату текущих данных — как "вся схема целиком" у
// 2D (state.initialView), но для 3D: центр по X/Y плана и по среднему
// уровню высот, камера отведена по диагонали на расстояние, пропорциональное
// охвату плана.
function fit3DCameraToData() {
  const v3 = state.view3d;
  if (!v3.camera || !state.elements.length) return;
  const xs = state.elements.map(e => e.x);
  const ys = state.elements.map(e => e.y);
  const zs = state.elements.map(e => e.elevation_mm || 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  // world.Z = -мировая Y элемента (см. build3DMeshForElement) — центр
  // по Z берём с тем же знаком, иначе камера целилась бы не в центр
  // модели, а в его зеркальное отражение.
  const cx = (minX + maxX) / 2, cz = -(minY + maxY) / 2, cy = (minZ + maxZ) / 2;
  const size = Math.max(maxX - minX, maxY - minY, 2000);

  v3.controls.target.set(cx, cy, cz);
  v3.camera.position.set(cx + size * 0.6, cy + size * 0.6, cz + size * 0.6);
  v3.camera.near = Math.max(size / 1000, 1);
  v3.camera.far = size * 20;
  v3.camera.updateProjectionMatrix();
  v3.controls.update();
  // Точка отсчёта для индикатора зума 3D (см. updateZoomIndicator3D ниже) —
  // "100%" всегда означает именно ЭТОТ, только что установленный обзор
  // всей схемы целиком, тот же смысл, что у state.initialView в 2D.
  v3.homeDistance = v3.camera.position.distanceTo(v3.controls.target);
  updateZoomIndicator3D();
}

// ---------- индикатор зума + сброс в 3D (см. Docs/backlog.md, разбор UX —
// в 2D индикатор с кнопкой сброса уже был, в 3D их не было вовсе). Прямого
// аналога "масштаба" в перспективной камере нет — используем расстояние
// камеры до цели орбиты относительно расстояния на "домашнем" виде
// (fit3DCameraToData), тот же смысл, что и у 2D (100% = вся схема целиком,
// ближе камера — процент выше). ----------
function updateZoomIndicator3D() {
  const v3 = state.view3d;
  const valueEl = document.getElementById("zoom-value-3d");
  if (!valueEl) return;
  if (!v3.camera || !v3.controls || !v3.homeDistance) { valueEl.textContent = "—"; return; }
  const currentDistance = v3.camera.position.distanceTo(v3.controls.target);
  if (!currentDistance) { valueEl.textContent = "—"; return; }
  valueEl.textContent = `${Math.round((v3.homeDistance / currentDistance) * 100)}%`;
}

function on3DResize() {
  const v3 = state.view3d;
  if (!v3.active || !v3.renderer) return;
  const container = document.getElementById("stage-3d");
  const w = container.clientWidth, h = Math.max(container.clientHeight, 1);
  v3.camera.aspect = w / h;
  v3.camera.updateProjectionMatrix();
  v3.renderer.setSize(w, h);
  // LineMaterial (рёбра силуэта) считает толщину линии в пикселях экрана
  // через uniform resolution — при изменении размера вьюпорта её нужно
  // пересчитать; материал теперь ОДИН общий на все элементы (см.
  // init3DScene), поэтому одна строка вместо обхода всех мешей.
  if (v3.edgeMaterial) v3.edgeMaterial.resolution.set(w, h);
}

function animate3D() {
  const v3 = state.view3d;
  if (!v3.active) return;
  v3.controls.update();
  v3.renderer.render(v3.scene, v3.camera);
  v3.animationFrameId = requestAnimationFrame(animate3D);
}

// ---------- клики — та же интерактивность, что у 2D (selectElement/openCtxMenu) ----------

let threeDragging = false; // аналог dragMoved у 2D — не выбирать элемент сразу после вращения камеры

function pick3DElementAt(clientX, clientY) {
  const v3 = state.view3d;
  const rect = v3.renderer.domElement.getBoundingClientRect();
  v3.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  v3.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  v3.raycaster.setFromCamera(v3.mouse, v3.camera);
  const visibleMeshes = Array.from(v3.meshById.values()).filter(m => m.visible);
  const intersects = v3.raycaster.intersectObjects(visibleMeshes);
  if (!intersects.length) return null;
  return state.byId.get(intersects[0].object.userData.elementId) || null;
}

function on3DClick(e) {
  if (threeDragging) return;
  hide3DTooltip();
  const element = pick3DElementAt(e.clientX, e.clientY);
  if (!element) { closeCtxMenu(); clearSelection(); return; }
  selectElement(element);
}

function on3DContextMenu(e) {
  e.preventDefault();
  hide3DTooltip();
  const element = pick3DElementAt(e.clientX, e.clientY);
  if (!element) return;
  selectElement(element);
  openCtxMenu(element, e.clientX, e.clientY);
}

// ---------- подсказка при наведении — появляется, если курсор задержался
// на одном элементе дольше 1с (не сразу, чтобы не мельтешить при вращении) ----------

let hover3DTimer = null;
let hover3DElementId = null;

function hide3DTooltip() {
  clearTimeout(hover3DTimer);
  hover3DTimer = null;
  hover3DElementId = null;
  const tip = document.getElementById("tooltip-3d");
  if (tip) tip.style.display = "none";
}

function position3DTooltip(clientX, clientY) {
  const tip = document.getElementById("tooltip-3d");
  const stage = document.getElementById("stage-3d");
  const rect = stage.getBoundingClientRect();
  const offset = 14;
  let left = clientX - rect.left + offset;
  let top = clientY - rect.top + offset;
  if (left + tip.offsetWidth > rect.width) left = clientX - rect.left - tip.offsetWidth - offset;
  if (top + tip.offsetHeight > rect.height) top = clientY - rect.top - tip.offsetHeight - offset;
  tip.style.left = Math.max(0, left) + "px";
  tip.style.top = Math.max(0, top) + "px";
}

function show3DTooltip(element, clientX, clientY) {
  const tip = document.getElementById("tooltip-3d");
  tip.textContent = "";
  const rows = [
    ["Тип", element.element_type],
    ["Подтип", element.subtype],
    ["Марка", element.mark],
    ["ID", element.id],
    ["Адрес", element.address],
    ["Отметка", (element.elevation_mm === null || element.elevation_mm === undefined) ? null : element.elevation_mm + " мм"],
  ];
  for (const [label, value] of rows) {
    const line = document.createElement("div");
    line.textContent = label + ": " + ((value === null || value === undefined || value === "") ? "—" : value);
    tip.appendChild(line);
  }
  tip.style.display = "block";
  position3DTooltip(clientX, clientY);
}

function on3DMouseMove(e) {
  if (threeDragging) { hide3DTooltip(); return; }
  const element = pick3DElementAt(e.clientX, e.clientY);
  const elementId = element ? element.id : null;

  if (elementId !== hover3DElementId) {
    hide3DTooltip();
    hover3DElementId = elementId;
    if (elementId !== null) {
      const cx = e.clientX, cy = e.clientY;
      hover3DTimer = setTimeout(() => {
        if (hover3DElementId === elementId) show3DTooltip(element, cx, cy);
      }, 1000);
    }
    return;
  }
  if (elementId !== null) position3DTooltip(e.clientX, e.clientY);
}

// ---------- переключатель 2D/3D — сегментированный, оба режима видны
// одновременно, активный подсвечен (не залипающая кнопка-тумблер) ----------

const btnView2D = document.getElementById("btn-view-2d");
const btnView3D = document.getElementById("btn-view-3d");

async function setViewMode(mode) {
  const v3 = state.view3d;
  const stage2d = document.getElementById("stage");
  const stage3d = document.getElementById("stage-3d");
  if ((mode === "3d") === v3.active) return; // уже в этом режиме

  if (mode === "2d") {
    v3.active = false;
    if (v3.animationFrameId) cancelAnimationFrame(v3.animationFrameId);
    hide3DTooltip();
    stage3d.style.display = "none";
    stage2d.style.display = "";
    btnView2D.classList.add("active");
    btnView3D.classList.remove("active");
    return;
  }

  btnView3D.disabled = true;
  try {
    await ensureThreeLoaded();
  } catch (e) {
    showToast("Не удалось загрузить 3D: " + e.message, "warning");
    btnView3D.disabled = false;
    return;
  }

  stage2d.style.display = "none";
  stage3d.style.display = "block";
  const hint = document.getElementById("stage-3d-hint");
  if (hint) hint.style.display = "none";

  init3DScene();
  build3DScene();
  v3.active = true;
  btnView2D.classList.remove("active");
  btnView3D.classList.add("active");
  btnView3D.disabled = false;
  on3DResize();
  animate3D();
}

btnView2D.addEventListener("click", () => {
  setViewMode("2d").catch(e => showToast("Ошибка: " + e.message, "warning"));
});
btnView3D.addEventListener("click", () => {
  setViewMode("3d").catch(e => showToast("Ошибка 3D: " + e.message, "warning"));
});
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#stage-3d")) threeDragging = false;
});
document.addEventListener("pointermove", (e) => {
  if (e.buttons && e.target.closest("#stage-3d")) threeDragging = true;
});

// ==================== СТАРТ ====================
async function bootApp() {
  const ok = await checkAuth();
  if (!ok) return;
  await loadSourceFiles();
  await loadPlan(false); // первая загрузка — вписать схему целиком
}

bootApp();

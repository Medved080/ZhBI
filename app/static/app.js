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
  subLabelById: new Map(), // id -> <text> допстроки (плановая дата + код контрагента), только у элементов, где она сейчас видна — см. elementSubLabelText
  stickerById: new Map(), // id -> <g class="mark-sticker"> — марка(+допстрока) как "наклейка" на контуре элемента, см. computeStickerLayout/buildStickerGroup. Элементы БЕЗ пригодного контура остаются на labelById/subLabelById (запасной вариант).
  labelGroupById: new Map(), // id -> <g> в labels-layer, обёртка над label+subLabel ИЛИ sticker ОДНОГО элемента — см. renderElements/applyPlacementFilters
  labelOffsetById: new Map(), // id -> {dx, dy, anchor} в единицах базового радиуса — направление подписи, выбранное один раз при разводке коллизий
  // Порог опоздания поставки (дней) — серверная настройка (app/settings.py),
  // загружается один раз при старте; используется для красного/зелёного
  // цвета допстроки марки (см. elementSubLabelText) и всплывающей
  // подсказки (computeTooltipDateRows). Раньше была ещё и отдельная
  // инфо-плашка на схеме — убрана целиком (живая жалоба пользователя на
  // быстродействие на файлах с тысячами элементов, см. Docs/backlog.md).
  lateThresholdDays: 0,
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
  labelDatesVisibility: {},
  changelog: null, // кэш GET /changelog на время сеанса, см. btn-changelog
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
  // Режим слабого компьютера (см. LOW_SPEC_KEY ниже по файлу). Читается из
  // localStorage ЗДЕСЬ, а не в обработчике переключателя: init3DScene может
  // сработать раньше, чем отрисуется сайдбар, и должен уже знать нужную
  // плотность пикселей. Ключ здесь литералом, а не константой: state
  // объявляется в начале файла, до её объявления (temporal dead zone). При
  // смене ключа поправить ОБА места.
  lowSpec: localStorage.getItem("zhbi_low_spec") === "1",
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
    zakhvatka: new Set(), crane: new Set(), stance: new Set(), elevation: new Set(), floor: new Set(),
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
  topFilterCollapsed: new Set(["zakhvatka", "craneStance", "craneStanceNone", "elevation", "floor", "elementType", "supplier", "noContract"]),
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
    labelSpriteById: new Map(), // element.id -> THREE.Sprite (постоянная подпись марки, запасной вариант)
    markDecalById: new Map(), // element.id -> THREE.Group (наклейка марки на грани — см. build3DMarkDecal)
    edgeMaterial: null, // общий LineMaterial на ВСЕ рёбра силуэта — см. init3DScene
    materialByStatus: new Map(), // статус -> общий MeshStandardMaterial всех НЕвыбранных элементов этого статуса
    highlightMaterial: null, // единственный материал ВЫБРАННОГО элемента (пересвечивается под его цвет статуса)
    animationFrameId: null, // заказанный кадр рендера по требованию (см. requestRender3D)
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

// ==================== АУТЕНТИФИКАЦИЯ ====================

// ---------- экран входа: выбор пользователя из списка + показ пароля
// (живой запрос пользователя 2026-07-29 — ручной ввод логина оказался
// источником неудачных входов: логин в БД мог отличаться от того, что
// человек помнит, а форма показывала только "неверный логин или пароль",
// не различая, что именно не сошлось). Список отдаёт GET /login-users,
// он же может быть отключён флагом на сервере (ZHBI_PUBLIC_LOGIN_LIST=0,
// см. app/auth.py) — тогда эндпоинт вернёт 404, и мы молча остаёмся на
// обычном текстовом поле, как было раньше. ----------

// Какое поле логина сейчас показано — из него и берётся значение при
// отправке формы (см. обработчик login-submit).
let loginUsersLoaded = false;

async function loadLoginUsers() {
  // Флаг ставится ДО await, а не после: showLoginScreen() вызывается больше
  // одного раза подряд (неудачная проверка сессии при старте + переход на
  // экран входа), и с проверкой после await оба вызова успевали проскочить —
  // в сети было видно два одинаковых GET /login-users.
  if (loginUsersLoaded) return;
  loginUsersLoaded = true;
  const list = document.getElementById("login-users-list");
  const input = document.getElementById("login-domain");
  if (!list || !input) return; // старая разметка из кэша — см. комментарий у loginPasswordToggle
  try {
    const res = await fetch("/login-users");
    if (!res.ok) return; // 404 = список отключён; поле работает как обычный ввод
    const users = await res.json();
    if (!users.length) return;
    // value — то, что подставится в поле (сам логин); label — то, что видно
    // в подсказке. ФИО показываем именно в label, чтобы в поле после выбора
    // оказался чистый логин, а не "Фамилия (логин)".
    list.innerHTML = users
      .map(u => `<option value="${escapeHtml(u.domain_login)}" label="${escapeHtml(u.display_name)}"></option>`)
      .join("");
    // Пользователь в системе ровно один — подставляем сразу, выбирать не из
    // чего. Не трогаем, если в поле уже что-то есть (мог подставить браузер).
    if (!input.value && users.length === 1) input.value = users[0].domain_login;
  } catch (e) {
    // Сеть недоступна — поле остаётся обычным вводом, вход всё равно возможен
  }
}

// Логин всегда берётся из ТЕКСТОВОГО поля — оно единственный источник
// истины. Выпадающий список только подставляет в него значение (см.
// loadLoginUsers), поэтому пользователь может как выбрать из списка, так и
// вписать логин руками или дать браузеру подставить сохранённую пару
// логин/пароль.
function currentLoginValue() {
  return document.getElementById("login-domain").value;
}

// Проверка на null здесь ОБЯЗАТЕЛЬНА, в отличие от остальных подобных
// подписок в этом файле. app.js и index.html — два отдельных запроса, и
// браузер вполне может взять один из кэша, а другой свежим (Cache-Control:
// no-cache даёт условный GET, но не гарантирует одновременность). Со СТАРОЙ
// разметкой и НОВЫМ скриптом этой кнопки в DOM ещё нет, и обращение к
// .addEventListener у null бросило бы исключение на верхнем уровне модуля —
// а это значит, что ВЕСЬ остальной app.js ниже по файлу не выполнится,
// включая обработчик кнопки "Войти". Внешне это выглядит как "нажимаю Войти,
// и ничего не происходит" — то есть ровно как отказ входа, хотя пароль
// правильный. Ради одной необязательной кнопки такой риск недопустим.
const loginPasswordToggle = document.getElementById("login-password-toggle");
if (loginPasswordToggle) {
  loginPasswordToggle.addEventListener("click", () => {
    const input = document.getElementById("login-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    loginPasswordToggle.classList.toggle("active", show);
    loginPasswordToggle.title = show ? "Скрыть пароль" : "Показать пароль";
    loginPasswordToggle.setAttribute("aria-label", loginPasswordToggle.title);
    input.focus();
  });
}

function showLoginScreen() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-root").classList.add("hidden");
  loadLoginUsers();
  // Пароль всегда возвращаем в скрытый вид: экран входа показывается и
  // при обычном выходе, и при истечении сессии — оставлять чужой пароль
  // открытым на экране нельзя.
  const pwd = document.getElementById("login-password");
  const btn = document.getElementById("login-password-toggle");
  if (pwd) pwd.type = "password";
  if (btn) {
    btn.classList.remove("active");
    btn.title = "Показать пароль";
    btn.setAttribute("aria-label", btn.title);
  }
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");
}

function applyRolePermissions() {
  const role = state.currentUser.role;
  // Загрузка чертежа больше НЕ управляется отдельно по canEdit: с
  // 2026-07-29 «загрузка любых данных доступна только администраторам»,
  // поэтому пункт помечен обычным admin-only в разметке и скрывается
  // общим правилом ниже. На сервере то же — /import-dxf под require_admin.
  // Меню "Настройки" теперь видно всем ролям — в нём же живёт самообслуживание
  // смены пароля (п.10 третьего раунда). Admin-специфичные пункты скрываются
  // адресно по классу .admin-only, а не всё меню целиком.
  document.querySelectorAll("#settings-menu .admin-only").forEach(elm => {
    elm.style.display = role === "admin" ? "" : "none";
  });
  // Группа без единого видимого пункта не должна оставаться заголовком,
  // раскрывающим пустую панель. Считаем ПОСЛЕ применения ролей выше и по
  // фактической видимости, а не по классам: у "Обмен данными" видимость
  // смешанная (загрузка чертежа доступна прорабу, остальное — только
  // админу), и жёстко прописать её классом на группе нельзя.
  document.querySelectorAll("#settings-menu .submenu").forEach(group => {
    const видимые = [...group.querySelectorAll(".submenu-panel button")]
      .filter(b => b.style.display !== "none");
    group.style.display = видимые.length ? "" : "none";
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
  const domain_login = currentLoginValue();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    // Намеренно НЕ через api(): та перехватывает 401 раньше, чем прочитает
    // тело ответа, и подменяет причину общим "Не авторизован" (это
    // осознанно — для ЛЮБОГО другого запроса 401 означает "сессия
    // истекла", и там нужен именно переход на экран входа). Но на самом
    // ВХОДЕ 401 — это "неверный логин или пароль", и подмена сообщения
    // делала диагноз невозможным: пользователь видел "Не авторизован" и не
    // мог понять, ошибся он паролем, логином, или дело в сессии (живой
    // репорт: "не принимает мой пароль", 2026-07-29). Здесь показываем то,
    // что реально ответил сервер: "Неверный логин или пароль" (401) либо
    // "Слишком много попыток входа, попробуйте позже" (429, срабатывает
    // после 5 неудач за 5 минут и отклоняет даже ПРАВИЛЬНЫЙ пароль, пока
    // окно не истечёт, — см. app/auth.py).
    const res = await fetch("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain_login, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.detail) ? body.detail : `${res.status} ${res.statusText}`);
    }
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
  const summary = document.getElementById("file-select-summary-line");
  if (!summary) return;
  const n = state.selection.size;
  let text;
  if (n === 0) text = "не выбрано";
  else if (n === 1) text = Array.from(state.selection.keys())[0];
  else text = `${n} файла`;
  summary.textContent = `Сейчас на схеме: ${text}`;
}

// Выбор чертежа/слоёв живёт в форме "Чертежи" (пункт меню "Загрузить
// чертёж"), а не в тулбаре — см. комментарий в index.html. Прежний
// сворачиваемый контрол тулбара и его состояние в localStorage удалены
// вместе с самим контролом.

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

// ---------- вкладки сайдбара: Свойства / Статус / Фильтры / Вид ----------
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${name}`));
  // Отчёты панели «Статус» пока она скрыта не считаются (запрос не дешёвый) —
  // догоняем при переходе на неё, см. scheduleSidebarReports.
  if (name === "status" && sideReportsDirty) loadSidebarReports();
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
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

// ---------- подложка подписей МАРКИ (не зон/осей) — "как в 3D": тёмный
// текст на светлой подложке-плашке, а не светлый контур вокруг тёмных
// букв (живой репорт пользователя 2026-07-24; та же заливка/прозрачность,
// что уже подтверждена для 3D-спрайтов, см. build3DLabelSprite). Оценка
// текстового бокса — БЕЗ getBBox() (форсирует layout — дорого при
// тысячах элементов на каждый тик зума, см. updateSizesForZoom, её же
// O(n) без throttle отмечен в Docs/backlog.md); та же оценка ширины
// символа (0.62×fontSize), что уже использует updateLabelCollisionVisibility
// — согласована с уже посчитанными коллизионными боксами. ----------
const LABEL_BG_CHAR_WIDTH_RATIO = 0.62;
const LABEL_BG_PAD_X_SCALE = 0.25; // доля fontSize, с каждой стороны текста
const LABEL_BG_ABOVE_BASELINE = 0.78; // доля fontSize выше базовой линии
const LABEL_BG_BELOW_BASELINE = 0.28; // доля fontSize ниже базовой линии

function updateLabelBgRect(bg, text, fontSize, anchor, x, y) {
  const textWidth = (text.length || 1) * fontSize * LABEL_BG_CHAR_WIDTH_RATIO;
  const padX = fontSize * LABEL_BG_PAD_X_SCALE;
  const w = textWidth + padX * 2;
  const h = fontSize * (LABEL_BG_ABOVE_BASELINE + LABEL_BG_BELOW_BASELINE);
  let rectX;
  if (anchor === "middle") rectX = -w / 2;
  else if (anchor === "end") rectX = -textWidth - padX;
  else rectX = -padX; // "start" (по умолчанию)
  const rectY = -fontSize * LABEL_BG_ABOVE_BASELINE;
  bg.setAttribute("transform", `translate(${x},${y}) scale(1,-1)`);
  bg.setAttribute("x", rectX.toFixed(2));
  bg.setAttribute("y", rectY.toFixed(2));
  bg.setAttribute("width", w.toFixed(2));
  bg.setAttribute("height", h.toFixed(2));
  bg.setAttribute("rx", (fontSize * 0.15).toFixed(2));
}

// <text> подписи марки -> её <rect>-подложка — чтобы прятать/показывать
// подложку СИНХРОННО с текстом везде, где меняется display (мест
// несколько — фильтр видимости по типу, коллизии соседних подписей, см.
// setLabelDisplay ниже) — WeakMap по самому DOM-узлу текста, без
// отдельной Map по elementId в каждом месте.
const labelBgByText = new WeakMap();

function setLabelDisplay(textEl, value) {
  textEl.style.display = value;
  const bg = labelBgByText.get(textEl);
  if (bg) bg.style.display = value;
}

// Создаёт <rect>-подложку + <text> подписи марки, вставляет ОБА в parent
// (подложка — ПЕРЕД текстом, чтобы текст всегда рисовался поверх неё).
function appendMarkLabel(parent, x, y, text, fontSize, anchor, extraAttrs) {
  const bg = el("rect", { class: `${extraAttrs.class}-bg`, "data-type": extraAttrs["data-type"] });
  updateLabelBgRect(bg, text, fontSize, anchor, x, y);
  parent.appendChild(bg);
  const textEl = flippedText(x, y, text, fontSize, anchor, extraAttrs);
  parent.appendChild(textEl);
  labelBgByText.set(textEl, bg);
  return textEl;
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

// Этаж — из суффикса "_этаж N" в имени слоя нового стандарта (см.
// scripts/layer_naming.py, Docs/backlog.md, "Свойство 'этаж'"). Плоский
// фильтр, та же природа, что и "Отметка (высота)" — не иерархический,
// PLACEMENT_NONE для элементов, чьи слои этот суффикс не проставляют.
function floorFilterValue(element) {
  return (element.floor === null || element.floor === undefined) ? PLACEMENT_NONE : element.floor;
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
// составного ключа, что уже применён для стоянок (stanceLogicalKey).
const SUBTYPE_KEY_SEP = "::";
function subtypeLogicalKey(elementType, subtype) {
  return `${elementType}${SUBTYPE_KEY_SEP}${subtype}`;
}
function subtypeTextForLogicalKey(key) {
  const idx = key.indexOf(SUBTYPE_KEY_SEP);
  return idx === -1 ? key : key.slice(idx + SUBTYPE_KEY_SEP.length);
}
// Раньше (до 2026-07-28) сюда входили "Плита перекрытия" и "Ригель" —
// предполагалось, что у этих типов текст подтипа ВСЕГДА фактически
// отметка ("на отм. +15.000" и т.п.), поэтому уровень "Подтип" в дереве
// фильтра скрывался целиком, марки шли прямыми детьми типа (Тип → Марка).
// Живой репорт пользователя — предположение оказалось неверным: у Ригеля
// появился подтип "периметральный" (справочник подтипов, allowed_subtypes)
// — это не отметка, а самостоятельная смысловая категория, как "нижняя"/
// "верхняя" у Колонны, но с флаттингом её было невозможно отфильтровать
// отдельно от обычных ригелей (она пряталась среди марок). Множество
// снова пустое — уровень "Подтип" в дереве теперь одинаково показывается
// для ВСЕХ типов элементов (elevationFilterValue/"Отметка (высота)"
// рядом продолжает работать независимо, для быстрого отбора по высоте
// без захода в дерево).
const FLAT_MARK_TYPES = new Set([]);

function subtypeFilterValue(element) {
  // Для FLAT_MARK_TYPES "слот подтипа" в дереве фильтра занимает МАРКА
  // (см. комментарий выше) — тот же составной ключ (тип+текст), только
  // текст — марка, а не подтип. ВСЕГДА составной ключ, даже когда
  // подтипа/марки нет (тогда текстовая часть — сам PLACEMENT_NONE) — не
  // голый сентинел: иначе "нет подтипа" у РАЗНЫХ типов схлопывалось бы в
  // один и тот же ключ "__none__", и marksBySubtype (ниже) смешивал бы
  // марки одного типа в группу "без подтипа" другого — та же природа
  // бага, что уже чинили для типа-заголовка (subtypesByType), только
  // уровнем глубже (живой репорт пользователя, см. Docs/backlog.md).
  if (FLAT_MARK_TYPES.has(element.element_type)) {
    return subtypeLogicalKey(element.element_type, element.mark || PLACEMENT_NONE);
  }
  return subtypeLogicalKey(element.element_type, element.subtype || PLACEMENT_NONE);
}

function markFilterValue(element) {
  return element.mark || PLACEMENT_NONE;
}

// Контрагент/Контракт — та же иерархическая пара, что Кран/Стоянка и
// Тип/Подтип, только источник значений не зоны, а state.contracts (см.
// Docs/backlog.md, "Контрактация 2.0" — контракт теперь ссылается на
// Контрагента через цепочку Спецификация->Договор->Контрагент, а не
// хранит свободнотекстового "поставщика"). element.contract_id — уже
// готовый денормализованный кэш (см. app/contracts.py), резолвить
// контракт целиком нужно только для подписи.
function contractIdFilterValue(element) {
  return element.contract_id || PLACEMENT_NONE;
}
function supplierFilterValue(element) {
  if (!element.contract_id) return PLACEMENT_NONE;
  const c = state.contracts.find(c => c.id === element.contract_id);
  return c ? c.counterparty_short_name : PLACEMENT_NONE;
}

// Единый список определений категорий — используется и для проверки
// "проходит ли элемент фильтр", и для расчёта доступности значений.
const PLACEMENT_FILTER_DEFS = [
  { key: "zakhvatka", valueFn: e => zoneFilterValue(e, "zone_zakhvatka_id", "zone_zakhvatka_status") },
  { key: "crane", valueFn: e => zoneFilterValue(e, "zone_crane_id", "zone_crane_status") },
  { key: "stance", valueFn: stanceFilterValue },
  { key: "elevation", valueFn: elevationFilterValue },
  { key: "floor", valueFn: floorFilterValue },
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
  if (key === "supplier") { for (const c of state.contracts) set.add(c.counterparty_short_name); }
  // Статус — список ЗАКРЫТЫЙ и известен заранее (STATUS_ORDER на сервере,
  // приходит в state.statusOrder), поэтому берём его целиком, а не только
  // те статусы, что уже встретились у элементов. Тот же приём, что для
  // зон/контрактов выше, и та же причина: пока по чертежу никто ничего не
  // отгрузил, "Отгружен"/"Доставлен"/"Смонтирован" отсутствовали в фильтре
  // вовсе — оператор не мог заранее снять/поставить по ним галочку, а
  // список пунктов ещё и менялся по мере работы (живой запрос
  // пользователя). Легенда статусов рядом всегда показывала все семь.
  if (key === "status") { for (const s of state.statusOrder) set.add(s); }
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
// rebuild3D=false — не пересобирать 3D-сцену: вызывающая сторона сделает
// это сама следом (loadPlan строит сцену один раз в конце). Без этого
// признака загрузка данных в 3D-режиме пересобирала сцену ДВАЖДЫ — один
// раз отсюда, второй из loadPlan.
function applyPlacementFilters(rebuild3D = true) {
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
  }
  // 3D не прячет отфильтрованное, а ПЕРЕСОБИРАЕТ сцену без него (живой
  // запрос 2026-07-29). Раньше здесь переключалась видимость уже готовых
  // мешей: они оставались в сцене, занимали память и перебирались
  // рендерером каждый кадр. Пересборка дороже одного переключения
  // видимости, но дальше — вращение, зум, развороты наклеек — идёт по
  // реально нужным элементам, а не по всем.
  // Ракурс камеры сохраняем: сброс на общий вид при каждой галочке фильтра
  // сделал бы работу невозможной.
  if (rebuild3D && state.view3d.active) build3DScene(true);
  else requestRender3D();
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
  if (kind === "floor") return "— без этажа —";
  if (kind === "subtype") return "— без подтипа —";
  if (kind === "mark") return "— без марки —";
  if (kind === "supplier") return "— без контрагента —";
  if (kind === "contract") return "— без контракта —";
  return "— не определено —";
}

// compareRaw — сравнивать значения как есть (a - b), а не по подписи.
// Годится ТОЛЬКО для категорий, где сама величина осмысленна как число
// (Отметка, мм) — для зональных категорий (Кран/Стоянка/Захватка)
// значение теперь id зоны (см. zoneFilterValue), а id — это внутренний
// идентификатор БД без смыслового порядка, сортировать его как число
// было бы неправильно, нужно сравнивать по РЕЗОЛВЛЕННОМУ имени.
function placementComparator(labelFor, { compareRaw = false, order = null } = {}) {
  // "Служебные" псевдо-значения (нет данных / нет конкретной стоянки) —
  // всегда в конце списка, после реальных значений.
  const isTrailing = v => v === PLACEMENT_NONE || isNoStanceValue(v);
  return (a, b) => {
    if (isTrailing(a) && !isTrailing(b)) return 1;
    if (isTrailing(b) && !isTrailing(a)) return -1;
    // order — заранее заданный порядок значений (сейчас единственный
    // случай: статусы, state.statusOrder). Алфавит по русской подписи для
    // них бессмысленен ("В производстве" впереди "Запланирован"), нужен
    // жизненный цикл, тот же порядок, что у легенды и у выпадающего списка
    // в диалоге смены статуса. Значение вне списка (теоретически — новый
    // статус с сервера, ещё не в statusOrder) уходит в конец, а не теряется.
    if (order) {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia !== ib) return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    }
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
      // Передаём и родителя (pv) — childrenForChild не может надёжно
      // восстановить его из cv одним лишь разбором строки: составной
      // ключ подтипа несёт тип-владельца, но "нет подтипа"/"нет марки"
      // — это один и тот же сентинел PLACEMENT_NONE у ЛЮБОГО типа, из
      // него тип не восстановить (был баг — см. Docs/backlog.md).
      const grandchildren = grandchildConfig ? (grandchildConfig.childrenForChild(cv, pv) || []) : [];

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
  const floorLabelFor = v => v === PLACEMENT_NONE ? placementNoneLabel("floor") : `Этаж ${v}`;
  // v теперь ВСЕГДА составной ключ (см. subtypeFilterValue) — сравниваем
  // с PLACEMENT_NONE текстовую часть после разбора, не весь ключ целиком.
  const subtypeLabelFor = v => {
    const text = subtypeTextForLogicalKey(v);
    return text === PLACEMENT_NONE ? placementNoneLabel("subtype") : text;
  };
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

  // Этаж — из суффикса "_этаж N" в имени слоя (см. floorFilterValue,
  // Docs/backlog.md, "Свойство 'этаж'"); плоский список, тот же приём,
  // что и у "Отметка (высота)" рядом (compareRaw — сортировать как
  // числа, не по подписи).
  container.appendChild(buildFilterGroup(
    "Этаж", "floor", allValuesFor("floor"), state.placementFilters.floor, floorLabelFor, enabledFor("floor"), onPlacementFilterChange, { compareRaw: true }
  ));

  container.appendChild(buildFilterGroup(
    "Отметка (высота)", "elevation", allValuesFor("elevation"), state.placementFilters.elevation, elevationLabelFor, enabledFor("elevation"), onPlacementFilterChange, { compareRaw: true }
  ));

  // Тип элемента / Подтип / Марка — иерархически, 3 уровня (item 8 +
  // "Раунд из 3 пунктов", 2026-07-17, п.1). Марка — прямой список без
  // поиска (заказчик выбрал этот вариант — некоторые подтипы содержат
  // 300+ уникальных марок, длинные плоские списки ожидаемы и приняты).
  const typeValues = allValuesFor("elementType");
  // Строим по ЭЛЕМЕНТАМ (тот же приём, что marksBySubtype ниже), не по
  // уже обезличенному множеству значений подтипа: составной ключ подтипа
  // несёт тип-владельца только когда подтип РЕАЛЬНО есть (см.
  // subtypeLogicalKey) — а "нет подтипа"/"нет марки" для ЛЮБОГО типа
  // схлопывается в один и тот же голый сентинел PLACEMENT_NONE
  // (subtypeFilterValue), из которого тип обратно не восстановить.
  // Раньше (парсинг строки значения через subtypeElementTypeForLogicalKey)
  // это давало отдельный фантомный заголовок "__none__" в дереве —
  // подтипы/марки без значения у ЛЮБОГО типа складывались в один общий
  // узел вместо своего настоящего типа, да ещё и с "сырым" именем
  // сентинела на экране (живой репорт пользователя, см. Docs/backlog.md).
  const subtypesByType = new Map();
  for (const e of state.elements) {
    if (!subtypesByType.has(e.element_type)) subtypesByType.set(e.element_type, new Set());
    subtypesByType.get(e.element_type).add(subtypeFilterValue(e));
  }
  const typeHeadings = Array.from(new Set([...typeValues, ...subtypesByType.keys()])).sort(placementComparator(v => v));
  for (const h of typeHeadings) {
    const arr = Array.from(subtypesByType.get(h) || []);
    arr.sort(placementComparator(subtypeLabelFor));
    subtypesByType.set(h, arr);
  }

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
      // уровнем. Проверяем РЕАЛЬНОГО родителя (pv, передан из
      // buildHierarchicalFilterGroup), а не пытаемся угадать тип по sv —
      // для "нет подтипа"/"нет марки" (голый PLACEMENT_NONE) это
      // невозможно сделать надёжно, см. комментарий у subtypesByType.
      childrenForChild: (sv, pv) => (FLAT_MARK_TYPES.has(pv) ? [] : (marksBySubtype.get(sv) || [])),
      excludedSet: state.placementFilters.mark,
      labelFor: markLabelFor,
      isEnabledFn: enabledFor("mark"),
      expandedSet: state.placementGroupsExpanded.subtype,
    }
  ));

  container.appendChild(buildFilterGroup(
    "Статус", "status", allValuesFor("status"), state.placementFilters.status, statusLabelFor, enabledFor("status"), onPlacementFilterChange,
    { order: state.statusOrder }
  ));

  // Контрагент / Контракт — иерархически, тем же приёмом, что Кран/Стоянка
  // и Тип/Подтип (см. Docs/backlog.md, "Контрактация 2.0"), но источник
  // значений — не элементы/зоны, а сам справочник контрактов
  // (state.contracts) — контрагент и контракт без ни одного элемента
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
    if (cv === PLACEMENT_NONE) continue; // элементы без контракта — отдельным пунктом ниже, не под контрагентом
    const c = state.contracts.find(c => c.id === cv);
    const sv = c ? c.counterparty_short_name : PLACEMENT_NONE;
    if (!contractsBySupplier.has(sv)) contractsBySupplier.set(sv, []);
    contractsBySupplier.get(sv).push(cv);
  }
  const supplierHeadings = Array.from(new Set([...supplierValues, ...contractsBySupplier.keys()])).sort(placementComparator(supplierLabelFor));
  for (const h of supplierHeadings) contractsBySupplier.get(h)?.sort(placementComparator(contractLabelFor));
  container.appendChild(buildHierarchicalFilterGroup(
    "Контрагент / Контракт", "supplier", supplierHeadings, state.placementFilters.supplier, supplierLabelFor, enabledFor("supplier"),
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
  requestRender3D();
}

// ---------- допстрока подписи (плановая дата поставки + код контрагента),
// см. Docs/backlog.md, "Контрактация 2.0" — вторая, более мелкая строка
// под маркой. В отличие от прежней версии (партия) — НЕ зависит от
// статуса элемента, показывается всегда, когда есть хотя бы одно из
// значений (менеджеры смотрят плановую дату и на площадке, не только до
// поставки). ----------
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

// Даты с сервера — ISO "YYYY-MM-DD" (planned/project) или полный
// datetime "YYYY-MM-DD HH:MM:SS" (actual, из status_history.changed_at).
// Единый формат отображения везде в интерфейсе — "ДД.ММ.ГГГГ" (живой
// запрос пользователя), без времени даже у фактической даты — точность
// до дня достаточна для сравнения с началом СМР/плановой.
function formatDateRu(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : dateStr;
}

// Допстрока (код контрагента + плановая дата) — только если для ТИПА
// элемента включён подпункт "Даты" (Настройки → Вид → Подписи,
// state.labelDatesVisibility, дефолт true — см. Docs/backlog.md). Единая
// точка гейтинга — все потребители (2D-наклейка, 3D-наклейка/спрайт)
// вызывают только эту функцию, отдельно флаг нигде больше не проверяется.
function elementSubLabelText(element) {
  if (state.labelDatesVisibility[element.element_type] === false) return null;
  if (!element.planned_delivery_date && !element.counterparty_code) return null;
  if (element.counterparty_code && element.planned_delivery_date) {
    return `${element.counterparty_code}. ${formatDateRu(element.planned_delivery_date)}`;
  }
  return element.counterparty_code || formatDateRu(element.planned_delivery_date);
}

// Класс допстроки (2D <text class="mark-sublabel ...">) — красный при
// опоздании плановой/фактической даты против начала СМР, зелёный, если
// опоздания нет и начало СМР вообще задано (иначе — нейтральный цвет
// по умолчанию, сравнивать не с чем). Живой запрос пользователя — замена
// убранной отдельной инфо-плашки (см. Docs/backlog.md), та же логика
// опоздания (computeDeliveryLateStatus), просто раскрашивает уже
// существующую подпись вместо отдельного DOM-узла на элемент.
function deliveryClass(element) {
  const info = computeDeliveryLateStatus(element, state.lateThresholdDays);
  if (!info) return "";
  return (info.planLate || info.actualLate) ? "delivery-late" : "delivery-ok";
}
function subLabelClass(element) {
  const cls = deliveryClass(element);
  return cls ? `mark-sublabel ${cls}` : "mark-sublabel";
}

// Цвет допстроки в HEX — та же градация ok/late/нейтральный, что и
// subLabelClass (CSS-класс для 2D), нужен там, где красится canvas
// (3D-наклейка/плавающая табличка), не DOM-класс.
function deliveryColorHex(element) {
  const info = computeDeliveryLateStatus(element, state.lateThresholdDays);
  if (!info) return "#555";
  return (info.planLate || info.actualLate) ? "#c0392b" : "#2f7d3c";
}

// ---------- подпись марки как "наклейка" на контуре элемента (живой
// запрос пользователя: "размер подписей не должен уменьшаться при
// масштабировании, должна быть как наклейка на элементе во всю его
// ширину") — та же идея, что уже реализована для 3D (build3DMarkDecal):
// размер ШРИФТА в МИРОВЫХ единицах, привязанный к реальной ширине
// контура элемента, а не к экранным пикселям (см. computeEffectiveMarkerSizing
// — тот, старый подход, оставлен только как ЗАПАСНОЙ вариант для
// элементов без пригодного контура, см. ниже). Марка и допстрока (код
// контрагента + плановая дата) — ОДНА группа с ОДНОЙ подложкой, не два
// независимых блока (живой репорт: "надпись вышла не вместе с подписью
// элемента, а отдельно от него" — раньше объединялись только позицией,
// не общим визуальным блоком). Т.к. размер завязан на геометрию
// элемента, а не на текущий зум — обновляется ТОЛЬКО при пересборке
// схемы/смене статуса или плановой даты, НЕ на каждый тик зума (в
// отличие от старого запасного варианта) — дополнительный выигрыш в
// быстродействии на больших файлах. ----------
const STICKER_CHAR_WIDTH_RATIO = 0.62; // та же оценка, что и везде (LABEL_BG_CHAR_WIDTH_RATIO/DECAL_CHAR_WIDTH_RATIO)
const STICKER_FIT_MARGIN = 0.92; // небольшой запас от самого края контура

// Считает геометрию наклейки (центр/угол/размер шрифта) из РЕАЛЬНОГО
// контура элемента — null, если контура нет/меньше 3 точек, или марки
// нет вовсе (тогда вызывающий код использует старый запасной вариант).
// Марка и допстрока — ОДНА строка (живой запрос пользователя: "должна
// быть в одну строку с маркой", раньше пробовали в 2 строки — при
// длинной допстроке блок по высоте вылезал за короткую сторону контура,
// "надписи выходят за границы элемента"), поэтому высота ВСЕГДА ровно
// одна строка — не может вылезти за dims.width НИ ПРИ КАКОЙ длине
// текста, только ширина ограничена через maxFontByLength (fontSize
// уменьшается для длинного текста, а не блок растёт по высоте). Тот же
// приём, что 3D-наклейка, перенесённый на 2D без изменений в математике
// (footprintDimensions/footprintLongAxisAngle/footprintCentroid уже
// написаны для 3D, ниже по файлу, но не содержат ничего 3D-специфичного
// — чистая геометрия по outline, переиспользуется как есть).
function computeStickerLayout(element) {
  if (!element.outline || element.outline.length < 3 || !element.mark) return null;
  const dims = footprintDimensions(element.outline);
  if (!dims || !(dims.width > 0) || !(dims.length > 0)) return null;
  const subText = elementSubLabelText(element);
  const lineUnit = LABEL_BG_ABOVE_BASELINE + LABEL_BG_BELOW_BASELINE;
  let fontSize = dims.width / lineUnit;
  const combinedLen = element.mark.length + (subText ? subText.length + 1 : 0); // +1 — разделяющий пробел
  // Живой баг (Docs/backlog.md): формула считала только ширину ТЕКСТА, не
  // всей рамки — реальная ширина рамки ещё + LABEL_BG_PAD_X_SCALE*2*fontSize
  // отступов, из-за чего у почти квадратных элементов (колонны — короткая
  // сторона контура) рамка вылезала за контур даже с запасом
  // STICKER_FIT_MARGIN=0.92 (текст умещался, отступы — нет). Отступы
  // включены в знаменатель — вся рамка (текст+отступы) теперь гарантированно
  // укладывается в dims.length*STICKER_FIT_MARGIN.
  const maxFontByLength = (dims.length * STICKER_FIT_MARGIN) / (combinedLen * STICKER_CHAR_WIDTH_RATIO + LABEL_BG_PAD_X_SCALE * 2);
  fontSize = Math.min(fontSize, maxFontByLength);
  if (!(fontSize > 0)) return null;
  const [cx, cy] = footprintCentroid(element.outline);
  // Знак — НЕ минус: см. живую проверку в Docs/backlog.md, вывод из
  // композиции transform (translate·rotate·scale(1,-1)) на группе против
  // одиночного scale(1,-1) у контура элемента — тот же угол, без инверсии.
  const angleDeg = footprintLongAxisAngle(element.outline) * 180 / Math.PI;
  return { cx, cy, angleDeg, fontSize, subText, combinedLen };
}

// Строит/пересобирает наклейку ОДНОГО элемента внутри его labelGroup —
// вызывается один раз при первой отрисовке (renderElements) и заново
// целиком при смене статуса/плановой даты (updateElementSubLabel) —
// пересобрать дешевле, чем точечно патчить. Марка и допстрока — ОДНА
// строка, ДВА <tspan> внутри ОДНОГО <text> (не два отдельных <text>) —
// text-anchor="middle" на родителе центрирует их как единый текстовый
// прогон (tspan без своего x продолжает текущий "chunk"), допстрока
// просто красится своим классом поверх унаследованного цвета марки.
function buildOrRebuildSticker(labelGroup, element) {
  const old = state.stickerById.get(element.id);
  if (old) old.remove();
  const layout = computeStickerLayout(element);
  if (!layout) { state.stickerById.delete(element.id); return null; }

  const group = el("g", {
    class: "mark-sticker",
    "data-type": element.element_type,
    transform: `translate(${layout.cx},${layout.cy}) rotate(${layout.angleDeg.toFixed(2)}) scale(1,-1)`,
  });

  const boxWidth = layout.combinedLen * layout.fontSize * STICKER_CHAR_WIDTH_RATIO + layout.fontSize * LABEL_BG_PAD_X_SCALE * 2;
  const boxHeight = layout.fontSize * (LABEL_BG_ABOVE_BASELINE + LABEL_BG_BELOW_BASELINE);
  // Базовая линия текста — НЕ визуальный центр буквы: выше неё
  // ABOVE_BASELINE=0.78·fontSize, ниже — BELOW_BASELINE=0.28·fontSize
  // (несимметрично). При y=0 центр рамки (=центроид контура) совпадал бы
  // с базовой линией, а не с центром буквы — буква визуально "плыла"
  // вверх относительно контура (живой скриншот: снизу подписи — отступ,
  // сверху — заходит на соседний элемент). Сдвигаем базовую линию вниз
  // на разницу половин, чтобы центр буквы, а не базовая линия, совпадал
  // с центром контура.
  const baselineY = layout.fontSize * (LABEL_BG_ABOVE_BASELINE - LABEL_BG_BELOW_BASELINE) / 2;

  const rect = el("rect", {
    class: "mark-sticker-bg",
    x: (-boxWidth / 2).toFixed(2), y: (-boxHeight / 2).toFixed(2),
    width: boxWidth.toFixed(2), height: boxHeight.toFixed(2), rx: (layout.fontSize * 0.12).toFixed(2),
  });
  group.appendChild(rect);

  const textEl = el("text", {
    class: "mark-sticker-mark", x: 0, y: baselineY.toFixed(2), "text-anchor": "middle", "font-size": layout.fontSize.toFixed(2),
  });
  const markTspan = el("tspan", {});
  markTspan.textContent = layout.subText ? element.mark + " " : element.mark;
  textEl.appendChild(markTspan);
  if (layout.subText) {
    const subCls = deliveryClass(element);
    const subTspan = el("tspan", { class: subCls ? `mark-sticker-sub ${subCls}` : "mark-sticker-sub" });
    subTspan.textContent = layout.subText;
    textEl.appendChild(subTspan);
  }
  group.appendChild(textEl);

  labelGroup.appendChild(group);
  state.stickerById.set(element.id, group);
  return group;
}

// После смены порога опоздания в Настройках — перекрасить уже
// отрисованные допстроки (только те, что реально сейчас существуют,
// state.subLabelById, не все state.elements — дёшево).
function refreshSubLabelDeliveryColors() {
  for (const [id, subLabel] of state.subLabelById) {
    const element = state.byId.get(id);
    if (element) subLabel.setAttribute("class", subLabelClass(element));
  }
  const stickerIdsWithDates = [];
  for (const [id, sticker] of state.stickerById) {
    const element = state.byId.get(id);
    if (!element) continue;
    const subEl = sticker.querySelector(".mark-sticker-sub");
    if (subEl) {
      const cls = deliveryClass(element);
      subEl.setAttribute("class", cls ? `mark-sticker-sub ${cls}` : "mark-sticker-sub");
      stickerIdsWithDates.push(id);
    }
  }
  if (state.view3d.active) {
    for (const id of [...state.subLabelById.keys(), ...stickerIdsWithDates]) {
      const element = state.byId.get(id);
      if (element) rebuild3DLabelSprite(element);
    }
  }
}

// ---------- сравнение плановой/фактической даты поставки с началом СМР
// (project_smr_start_date, из графика MS Project, см.
// app/schedule_import.py) — общая точка, которой пользуются допстрока
// марки (subLabelClass), всплывающая подсказка (computeTooltipDateRows) и
// карточка элемента. К началу СМР изделия должны быть на площадке (живой
// запрос пользователя) — "late", если плановая ИЛИ фактическая дата
// превышает начало СМР больше чем на threshold дней (Настройки → Порог
// опоздания поставки); иначе "ok". Если начало СМР не задано — сравнивать
// не с чем, null. Раньше сравнивали с датой завершения СМР
// (project_delivery_date) — изменено на начало СМР, т.к. критично именно
// наличие изделий на площадке к НАЧАЛУ работ, а не к их завершению. ----------
function diffDaysFromDate(dateStr, baseDateStr) {
  const a = new Date(dateStr.slice(0, 10));
  const b = new Date(baseDateStr.slice(0, 10));
  return Math.round((a - b) / 86400000);
}

function computeDeliveryLateStatus(element, thresholdDays) {
  if (!element.project_smr_start_date) return null;
  const deltaPlan = element.planned_delivery_date
    ? diffDaysFromDate(element.planned_delivery_date, element.project_smr_start_date) : null;
  const deltaActual = element.actual_delivery_date
    ? diffDaysFromDate(element.actual_delivery_date, element.project_smr_start_date) : null;
  const planLate = deltaPlan !== null && deltaPlan > thresholdDays;
  const actualLate = deltaActual !== null && deltaActual > thresholdDays;
  return {
    status: (planLate || actualLate) ? "late" : "ok",
    planLate, actualLate, deltaPlan, deltaActual,
  };
}

// Строки для всплывающей подсказки (2D и 3D) — дата+дни опоздания,
// цвет строки (cls) — "ok"/"late"/"neutral", тем же критерием, что и
// computeDeliveryLateStatus.
function computeTooltipDateRows(element) {
  const info = computeDeliveryLateStatus(element, state.lateThresholdDays);
  if (!info) return null;
  const planLateText = info.planLate ? ` (опоздание ${info.deltaPlan} дн.)` : "";
  const actualLateText = info.actualLate ? ` (опоздание ${info.deltaActual} дн.)` : "";
  const plannedDatePart = element.planned_delivery_date ? formatDateRu(element.planned_delivery_date) : "—";
  const plannedText = element.counterparty_code ? `${plannedDatePart} · ${element.counterparty_code}` : plannedDatePart;
  return [
    { cls: "neutral", text: `Начало СМР: ${formatDateRu(element.project_smr_start_date)}` },
    { cls: info.planLate ? "late" : "ok", text: `Плановая: ${plannedText}${planLateText}` },
    {
      cls: info.actualLate ? "late" : (element.actual_delivery_date ? "ok" : "neutral"),
      text: `Фактическая: ${element.actual_delivery_date ? formatDateRu(element.actual_delivery_date) : "—"}${actualLateText}`,
    },
  ];
}

// Точечное обновление допстроки ОДНОГО элемента после смены статуса/
// партии — без полного renderElements(). Создаёт/обновляет/удаляет DOM-
// узел по необходимости; если элемент сейчас не отрисован на схеме
// (скрыт фильтром через display:none у родителя — сама подпись при этом
// всё равно существует в DOM) или вовсе не отрисован (другой файл/слои),
// state.labelById не найдёт узел — тихо выходим.
function updateElementSubLabel(element) {
  const labelGroup = state.labelGroupById.get(element.id);
  if (labelGroup) {
    if (state.stickerById.has(element.id)) {
      // Наклейка — цельная группа, точечно менять нечего (текст/размер/
      // цвет допстроки все зависят от одного и того же пересчёта), проще
      // пересобрать целиком — узлов немного (rect + 1-2 text).
      const sticker = buildOrRebuildSticker(labelGroup, element);
      if (sticker && state.labelVisibility[element.element_type] === false) sticker.style.display = "none";
    } else {
      const label = state.labelById.get(element.id);
      if (label && state.view) {
        const subText = elementSubLabelText(element);
        let subLabel = state.subLabelById.get(element.id);
        if (!subText) {
          if (subLabel) {
            const bg = labelBgByText.get(subLabel);
            if (bg) bg.remove();
            subLabel.remove();
            state.subLabelById.delete(element.id);
          }
        } else {
          const { effectiveR, effectiveFont } = computeEffectiveMarkerSizing();
          const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
          const x = element.x + cand.dx * effectiveR;
          const y = element.y + cand.dy * effectiveR - effectiveFont * SUBLABEL_GAP_SCALE;
          const fontSize = effectiveFont * SUBLABEL_FONT_SCALE;
          if (!subLabel) {
            subLabel = appendMarkLabel(label.parentNode, x, y, subText, fontSize, cand.anchor, {
              class: subLabelClass(element), "data-type": element.element_type,
            });
            if (state.labelVisibility[element.element_type] === false) setLabelDisplay(subLabel, "none");
            state.subLabelById.set(element.id, subLabel);
          } else {
            subLabel.textContent = subText;
            subLabel.setAttribute("transform", `translate(${x},${y}) scale(1,-1)`);
            subLabel.setAttribute("font-size", fontSize.toFixed(2));
            subLabel.setAttribute("class", subLabelClass(element));
            const bg = labelBgByText.get(subLabel);
            if (bg) updateLabelBgRect(bg, subText, fontSize, cand.anchor, x, y);
          }
        }
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
  state.stickerById.clear();
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

    // "Наклейка" на реальном контуре — основной путь (см.
    // computeStickerLayout/buildOrRebuildSticker); только если контура
    // нет/меньше 3 точек или марки вовсе нет — старый запасной вариант
    // (экранный размер шрифта + разводка коллизий по офсету от центра).
    const sticker = buildOrRebuildSticker(labelGroup, element);
    if (sticker) {
      if (state.labelVisibility[element.element_type] === false) sticker.style.display = "none";
    } else {
      const cand = state.labelOffsetById.get(element.id) || LABEL_CANDIDATES[0];
      const label = appendMarkLabel(
        labelGroup, element.x + cand.dx * r, element.y + cand.dy * r, element.mark || "", r * 1.3, cand.anchor,
        { class: "mark-label", "data-type": element.element_type }
      );
      if (state.labelVisibility[element.element_type] === false) setLabelDisplay(label, "none");
      state.labelById.set(element.id, label);

      const subText = elementSubLabelText(element);
      if (subText) {
        const subLabel = appendMarkLabel(
          labelGroup, element.x + cand.dx * r, element.y + cand.dy * r, subText, r * 1.3 * SUBLABEL_FONT_SCALE, cand.anchor,
          { class: subLabelClass(element), "data-type": element.element_type }
        );
        if (state.labelVisibility[element.element_type] === false) setLabelDisplay(subLabel, "none");
        state.subLabelById.set(element.id, subLabel);
      }
    }
  }

  updateSizesForZoom();
  applyPlacementFilters(false); // 3D пересоберёт loadPlan следом — не делать этого дважды
}

// Статусы x типы элементов — сколько элементов каждого типа сейчас в
// каждом статусе (не зависит от фильтров отображения на схеме, см.
// applyPlacementFilters — легенда всегда показывает полный набор
// выбранных файлов/слоёв, а не то, что видно на экране прямо сейчас).
function renderLegend() {
  // У легенды и у отчётов вкладки «Статус» одни и те же исходные данные —
  // один и тот же повод пересчитаться (см. scheduleSidebarReports).
  scheduleSidebarReports();
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
// Тумблер остался с тех времён, когда легенда и карточка элемента жили в
// одной вкладке "Свойства" и легенда мешала добраться до карточки. С
// переездом легенды на отдельную вкладку "Статус" (2026-07-30) вместе с
// двумя отчётами тумблер стал нужен для другого: свернуть матрицу
// статусов и оставить на панели сразу оба отчёта. Автосворачивание при
// первом выборе элемента убрано — карточка больше не под легендой.
const LEGEND_COLLAPSE_KEY = "zhbi_legend_collapsed";
function setLegendCollapsed(collapsed) {
  document.getElementById("legend").classList.toggle("collapsed", collapsed);
  document.getElementById("legend-toggle-btn").textContent = collapsed ? "▸" : "▾";
  localStorage.setItem(LEGEND_COLLAPSE_KEY, collapsed ? "1" : "0");
}
setLegendCollapsed(localStorage.getItem(LEGEND_COLLAPSE_KEY) === "1");
document.getElementById("legend-toggle-btn").addEventListener("click", () => {
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
    const row = document.createElement("div");
    row.className = "label-toggle-row";

    const label = document.createElement("label");
    label.className = "toggle";
    const checked = state.labelVisibility[type] !== false;
    label.innerHTML = `<input type="checkbox" data-type="${escapeHtml(type)}" ${checked ? "checked" : ""}/> ${escapeHtml(type)}`;

    // Подпункт "Даты" (живой запрос пользователя) — код контрагента +
    // плановая дата в допстроке наклейки. Создан ЗДЕСЬ (до обработчика
    // основного чекбокса выше), не после, потому что обработчику нужна
    // ссылка на него для каскада — см. ниже. Сессионное состояние, как и
    // основной чекбокс (не сохраняется на сервер этим переключателем —
    // только через "Настройки → Экспорт/импорт настроек", см. app/main.py).
    const datesLabel = document.createElement("label");
    datesLabel.className = "toggle toggle-sub";
    const datesChecked = state.labelDatesVisibility[type] !== false;
    datesLabel.innerHTML = `<input type="checkbox" data-dates-type="${escapeHtml(type)}" ${datesChecked ? "checked" : ""} ${checked ? "" : "disabled"}/> Даты`;
    const datesInput = datesLabel.querySelector("input");

    label.querySelector("input").addEventListener("change", (e) => {
      const isChecked = e.target.checked;
      state.labelVisibility[type] = isChecked;

      // "Даты" зависит от видимости типа — иерархия, как и везде в
      // фильтрах (родитель ставит/снимает потомков разом, живой запрос
      // пользователя, 2026-07-28): выключение марки выключает и её даты,
      // включение марки снова включает и даты. Пока тип включён, "Даты"
      // по-прежнему можно выключить отдельно (марка без дат) — это НЕ
      // каскад в обратную сторону, датчик потомка не трогает родителя.
      state.labelDatesVisibility[type] = isChecked;
      datesInput.checked = isChecked;
      datesInput.disabled = !isChecked;

      if (!isChecked) {
        // Скрыть — можно форсировать сразу: updateLabelCollisionVisibility
        // ниже пропускает выключенные типы целиком (см. её же проверку
        // state.labelVisibility[...] === false) и не тронет их display,
        // так что снятие галочки нужно применить явно и немедленно.
        // Содержимое наклеек пересобирать не нужно — они просто скрыты,
        // а не удалены, и заново соберутся при следующем включении типа.
        document.querySelectorAll(
          `.mark-label[data-type="${type}"], .mark-sublabel[data-type="${type}"], `
          + `.mark-label-bg[data-type="${type}"], .mark-sublabel-bg[data-type="${type}"], `
          + `.mark-sticker[data-type="${type}"]`
        ).forEach(t => {
          t.style.display = "none";
        });
      } else {
        // Показать — НЕ форсировать display:"" напрямую на ЗАПАСНЫЕ (не
        // "наклейка") подписи этого типа разом: это включало ВСЕ марки без
        // прореживания по коллизиям (даже там, где их физически некуда
        // уместить) — на плотных участках подписи наползали друг на друга
        // сплошной стеной (см. Docs/backlog.md, живой разбор).
        // Пересчитываем видимость тем же алгоритмом, что и обычный зум/пан.
        updateSizesForZoom();
        // "Наклейки" (мark-sticker) в прореживании выше не участвуют — но
        // раз "Даты" только что каскадом вернулись к "включено", у уже
        // существующих наклеек могло не быть допстроки в разметке (если
        // "Даты" выключали отдельно ДО того, как выключили сам тип) —
        // простого display:"" недостаточно, пересобираем содержимое через
        // тот же updateElementSubLabel, что и обработчик "Даты" ниже (он
        // сам корректно проставит display по текущему state.labelVisibility).
        for (const element of state.elements) {
          if (element.element_type === type) updateElementSubLabel(element);
        }
      }
      apply3DLabelVisibility();
    });
    row.appendChild(label);

    datesInput.addEventListener("change", (e) => {
      state.labelDatesVisibility[type] = e.target.checked;
      for (const element of state.elements) {
        if (element.element_type === type) updateElementSubLabel(element);
      }
    });
    row.appendChild(datesLabel);

    box.appendChild(row);
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
    const labelBg = labelBgByText.get(label);
    if (labelBg) updateLabelBgRect(labelBg, label.textContent, effectiveFont, cand.anchor, x, y);

    const subLabel = state.subLabelById.get(element.id);
    if (subLabel) {
      const subFont = effectiveFont * SUBLABEL_FONT_SCALE;
      // Меньшая мировая Y — ниже на экране (viewBox.y = -max_y даёт
      // "мировой Y вверх = экранный верх", см. Docs/backlog.md).
      const subY = y - effectiveFont * SUBLABEL_GAP_SCALE;
      subLabel.setAttribute("transform", `translate(${x},${subY}) scale(1,-1)`);
      subLabel.setAttribute("font-size", subFont.toFixed(2));
      const subBg = labelBgByText.get(subLabel);
      if (subBg) updateLabelBgRect(subBg, subLabel.textContent, subFont, cand.anchor, x, subY);
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
    setLabelDisplay(label, collides ? "none" : "");
    // Допстрока (партия) не участвует в отдельном расчёте коллизий —
    // видимость просто наследуется от основной строки (см. Docs/backlog.md,
    // "Партия — учёт по маркам") — простое решение для первой итерации,
    // как уже применялось к 3D-подписям в прошлом раунде.
    const subLabel = state.subLabelById.get(element.id);
    if (subLabel) setLabelDisplay(subLabel, collides ? "none" : "");
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
  state.stickerById.clear();
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

// ==================== ЖУРНАЛ: клиентские тайминги ====================
//
// Живой запрос 2026-07-29: «По работе системы важно точное время. Нажал на
// кнопку — время, открылась форма — время. Нажал Записать — время, запись
// выполнена, форма закрыта — время. Потом мы сможем анализировать как
// отличается быстродействие на разных компьютерах».
//
// Сервер о нажатиях не знает — эти события измеряет только браузер.
// Копим их и отправляем ПАЧКОЙ раз в ACTIVITY_FLUSH_MS: отдельный запрос на
// каждое нажатие добавил бы к измеряемому времени сетевую задержку, то есть
// исказил бы ровно то, что мы меряем.
//
// Длительности считаются performance.now() — монотонным таймером, который не
// зависит от системных часов. Абсолютные метки браузера сравнивать между
// машинами нельзя: часы прорабских ноутбуков расходятся на минуты, а цель
// журнала — именно сравнение машин между собой.
const ACTIVITY_FLUSH_MS = 10000;
let activityQueue = [];
let activityRequestSeq = 0;

function newRequestId() {
  // Связывает несколько событий одной операции (нажал -> открылось ->
  // записал -> закрылось), чтобы в журнале их можно было собрать вместе.
  return `${Date.now().toString(36)}-${(++activityRequestSeq).toString(36)}`;
}

function logClientEvent(action, opts = {}) {
  activityQueue.push({
    action,
    duration_ms: opts.durationMs,
    entity_type: opts.entityType,
    entity_id: opts.entityId,
    request_id: opts.requestId,
    details: opts.details,
  });
  // Пачка не должна расти без предела, если сеть недоступна: держим только
  // последние — старые тайминги ценности уже не имеют.
  if (activityQueue.length > 400) activityQueue = activityQueue.slice(-200);
}

// Замер отрезка операции: вернуть функцию, которая по вызову запишет
// событие с уже посчитанной длительностью.
function startTiming(action, opts = {}) {
  const t0 = performance.now();
  return (extra = {}) => logClientEvent(action, {
    ...opts, ...extra, durationMs: Math.round((performance.now() - t0) * 10) / 10,
  });
}

async function flushActivity() {
  if (!activityQueue.length || !state.currentUser) return;
  const events = activityQueue;
  activityQueue = [];
  try {
    await api("/activity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch (e) {
    // Не теряем безвозвратно — вернём в начало очереди и попробуем позже.
    activityQueue = events.concat(activityQueue);
  }
}
setInterval(flushActivity, ACTIVITY_FLUSH_MS);
// Вкладку закрывают — успеть отправить накопленное.
window.addEventListener("pagehide", () => {
  if (!activityQueue.length) return;
  const body = JSON.stringify({ events: activityQueue });
  activityQueue = [];
  // sendBeacon переживает закрытие вкладки, обычный fetch — нет.
  if (navigator.sendBeacon) navigator.sendBeacon("/activity", new Blob([body], { type: "application/json" }));
});

// ==================== СОВМЕСТНАЯ РАБОТА: автообновление ====================
//
// Живой запрос 2026-07-29: «если несколько пользователей в системе и один
// что-то поменял, то второй это не увидит до принудительного обновления
// страницы».
//
// Опрос раз в POLL_INTERVAL_MS + кнопка «⟳» в тулбаре. Почему опрос, а не
// постоянное соединение — см. комментарий у GET /changes (app/main.py):
// роуты синхронные, открытое соединение занимало бы поток на каждого
// пользователя. Ответ при отсутствии изменений — несколько байт.
//
// Метка времени берётся ИЗ ОТВЕТА СЕРВЕРА (server_time), никогда с часов
// браузера: они расходятся между машинами, и при спешащих часах часть
// чужих правок была бы пропущена навсегда.
const POLL_INTERVAL_MS = 15000;
let pollTimer = null;
let lastServerTime = null;
let pollInFlight = false;

// Поля, которые приходят в дельте. Геометрия/зоны сюда не входят — они
// меняются только переимпортом чертежа и точечно не применяются.
const DELTA_FIELDS = [
  "current_status", "contract_id", "counterparty_code",
  "planned_delivery_date", "actual_delivery_date",
  "project_delivery_date", "project_smr_start_date",
];

function applyElementDelta(fresh) {
  const element = state.byId.get(fresh.id);
  if (!element) return false; // элемента нет в текущей выборке слоёв — не наше дело
  let changed = false;
  for (const field of DELTA_FIELDS) {
    if (field in fresh && element[field] !== fresh[field]) {
      element[field] = fresh[field];
      changed = true;
    }
  }
  if (!changed) return false;
  // Точечное обновление вида: заливка/подсветка 2D и 3D + допстрока с
  // датами. Полная перерисовка схемы (renderElements) здесь была бы
  // расточительна — на реальном файле это тысячи узлов SVG.
  styleShape(state.shapeById.get(element.id), element);
  updateElementSubLabel(element);
  return true;
}

async function pollChanges(manual = false) {
  if (pollInFlight) return 0;
  if (!state.sourceFile || !state.currentUser) return 0;
  pollInFlight = true;
  try {
    const params = new URLSearchParams({ source_file: state.sourceFile });
    if (lastServerTime) params.set("since", lastServerTime);
    const data = await api(`/changes?${params.toString()}`);
    const previousMark = lastServerTime;
    lastServerTime = data.server_time;
    // Самый первый запрос только запоминает метку: без неё сервер вернул
    // бы всю историю изменений с начала времён, а показывать «изменилось
    // 9422 элемента» сразу после открытия страницы бессмысленно.
    if (!previousMark) return 0;

    let applied = 0;
    for (const fresh of data.elements) if (applyElementDelta(fresh)) applied++;
    if (applied) {
      renderLegend();          // счётчики по статусам в сайдбаре
      applyPlacementFilters(); // элемент мог перестать проходить фильтр по статусу
      if (state.selectedId && state.byId.has(state.selectedId)) {
        showCard(state.byId.get(state.selectedId)); // открытая карточка тоже устарела
      }
      showToast(`Обновлено элементов: ${applied} — изменения других пользователей`, "info");
    } else if (manual) {
      showToast("Новых изменений нет", "info");
    }
    return applied;
  } catch (e) {
    // Молча: сеть моргнула — следующий тик попробует снова. Шуметь
    // всплывашкой раз в 15 секунд недопустимо.
    if (manual) showToast("Не удалось обновить: " + e.message, "warning");
    return 0;
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // Вкладка в фоне — не опрашиваем: пользователь всё равно не смотрит, а
    // вернувшись, получит свежие данные обработчиком visibilitychange ниже.
    if (document.hidden) return;
    pollChanges();
  }, POLL_INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollChanges();
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  btn.classList.add("spinning");
  try {
    await pollChanges(true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
});

async function loadPlan(preserveView = true) {
  if (!state.selection.size) { clearWorkspace(); return; }
  const selection = Array.from(state.selection.entries()).map(([source_file, layers]) => ({
    source_file, layers: layers ? Array.from(layers) : null,
  }));
  const data = await api("/plan-data", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selection }),
  });
  // Данные только что загружены целиком — предыдущая метка опроса больше не
  // нужна и была бы вредна: сервер прислал бы как "изменения" всё, что
  // произошло до этой загрузки, и пользователь увидел бы всплывашку
  // "обновлено N элементов" сразу после открытия чертежа. Следующий тик
  // опроса просто возьмёт новую метку у сервера (см. pollChanges).
  lastServerTime = null;
  state.elements = data.elements;
  state.statusColors = data.status_colors;
  state.statusOrder = data.status_order;
  state.statusLabels = data.status_labels;
  state.labelVisibility = data.label_visibility;
  state.labelDatesVisibility = data.label_dates_visibility || {};
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
  applyPlacementFilters(false); // 3D-сцена собирается ниже, одним разом
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
  current_status: "Текущий статус", subtype: "Подтип", elevation_mm: "Отметка, мм", floor: "Этаж",
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
  { title: "Координаты", fields: ["x", "y", "elevation_mm", "floor"] },
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

// Контрагент/Договор/Спецификация — только для чтения (см. Docs/backlog.md,
// "Контрактация 2.0"): показывается по текущему кэшу elements.contract_id,
// который всегда зеркалит contract_id самой последней записи истории.
// Меняется только через диалог подтверждения при смене статуса
// (openStatusContractDialog), не напрямую. state.contracts (из /plan-data)
// уже несёт всю цепочку — резолвить контракт целиком нужно только для
// подписи, отдельного запроса на элемент не требуется.
function contractDetailsHtml(element) {
  if (!element.contract_id) return `<div class="hint-text">Контракт не назначен</div>`;
  const c = state.contracts.find(c => c.id === element.contract_id);
  if (!c) return `<div class="hint-text">#${element.contract_id}</div>`;
  const counterpartyText = c.counterparty_code
    ? `${escapeHtml(c.counterparty_short_name)} <span class="hint-text">(${escapeHtml(c.counterparty_code)})</span>`
    : escapeHtml(c.counterparty_short_name);
  const agreementText = c.agreement_date ? `${escapeHtml(c.agreement_number)} от ${formatDateRu(c.agreement_date)}` : escapeHtml(c.agreement_number);
  const specText = c.specification_date ? `${escapeHtml(c.specification_number)} от ${formatDateRu(c.specification_date)}` : escapeHtml(c.specification_number);
  return `
    <table>
      <tr><td class="k">Контрагент</td><td>${counterpartyText}</td></tr>
      <tr><td class="k">Договор</td><td>${agreementText}</td></tr>
      <tr><td class="k">Спецификация</td><td>${specText}</td></tr>
    </table>
  `;
}

// Плановая/дата завершения СМР/фактическая даты поставки (см.
// Docs/backlog.md, "Контрактация 2.0") — три независимые шкалы: плановая
// проставляется менеджером вручную (card-planned-date-btn, task
// openPlannedDateDialog), завершение СМР и начало СМР — импортом графика
// MS Project (app/schedule_import.py), фактическая — автоматически по
// моменту перехода в статус "Доставлено" (recompute_status_and_actual_date,
// app/contracts.py), read-only.
function deliveryDatesHtml(element) {
  // Подсветка — тот же критерий "позже начала СМР", что и у допстрока
  // марки/подсказки (см. computeDeliveryLateStatus), но здесь без порога в
  // днях (Настройки → порог влияет только на цвет допстроки/подсказки, в
  // карточке — сравнение простое: "Подсвечиваем если Плановая дата или
  // Фактическая позже Начала СМР" — к началу СМР изделия должны быть на
  // площадке, живой запрос пользователя).
  const smrStartDate = element.project_smr_start_date;
  const plannedLate = !!(smrStartDate && element.planned_delivery_date && element.planned_delivery_date > smrStartDate);
  const actualLate = !!(smrStartDate && element.actual_delivery_date && element.actual_delivery_date.slice(0, 10) > smrStartDate);
  const plannedDatePart = element.planned_delivery_date ? formatDateRu(element.planned_delivery_date) : "—";
  const plannedText = element.counterparty_code
    ? `${plannedDatePart} <span class="hint-text">· ${escapeHtml(element.counterparty_code)}</span>`
    : plannedDatePart;
  return `
    <table>
      <tr><td class="k">Начало СМР</td><td>${smrStartDate ? formatDateRu(smrStartDate) : "—"}</td></tr>
      <tr class="${plannedLate ? "date-row-late" : ""}"><td class="k">Плановая дата</td><td>${plannedText}</td></tr>
      <tr class="${actualLate ? "date-row-late" : ""}"><td class="k">Фактическая дата</td><td>${element.actual_delivery_date ? formatDateRu(element.actual_delivery_date) : "—"}</td></tr>
      <tr><td class="k">Дата завершения СМР</td><td>${element.project_delivery_date ? formatDateRu(element.project_delivery_date) : "—"}</td></tr>
    </table>
  `;
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
          <button type="button" class="btn btn-sm btn-secondary" id="card-planned-date-btn">${element.planned_delivery_date ? "Изменить плановую дату…" : "Задать плановую дату…"}</button>
        </div>
      ` : ""}
    </div>
    <div class="card-block"><h4>Контрактация</h4>
      ${contractDetailsHtml(element)}
    </div>
    <div class="card-block"><h4>Даты поставки</h4>
      ${deliveryDatesHtml(element)}
    </div>
    ${zonesBlockHtml}
    <details class="card-technical">
      <summary>Технические данные</summary>
      ${technicalHtml}
    </details>
    <h3 style="margin-bottom:4px;">История статусов</h3><div id="history-box">Загрузка…</div>
  `;

  if (canEdit) {
    document.getElementById("card-change-status-btn").addEventListener("click", (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      openCtxMenu(element, rect.left, rect.bottom + 4);
    });
    document.getElementById("card-planned-date-btn").addEventListener("click", () => {
      openPlannedDateDialog(element);
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

  // Плановая дата поставки — независимое действие (не привязано к смене
  // статуса), но доступно из ТОГО ЖЕ меню — единый список действий над
  // элементом, см. Docs/backlog.md, "Контрактация 2.0". В отличие от
  // прежней "Партии" — НЕ завязана на наличие контракта у элемента
  // (простое живое поле elements.planned_delivery_date), поэтому пункт
  // всегда активен.
  const sep = document.createElement("div");
  sep.className = "ctx-title";
  sep.textContent = "Плановая дата поставки";
  ctxMenu.appendChild(sep);
  const plannedDateItem = document.createElement("div");
  plannedDateItem.className = "ctx-item";
  plannedDateItem.textContent = element.planned_delivery_date ? "Изменить плановую дату…" : "Задать плановую дату…";
  plannedDateItem.addEventListener("click", () => {
    closeCtxMenu();
    openPlannedDateDialog(element);
  });
  ctxMenu.appendChild(plannedDateItem);

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
      matching.map(c => `<option value="${c.id}" ${String(c.id) === String(preselect) ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    );
    document.getElementById("sc-contract-select").innerHTML = options.join("");
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

document.getElementById("sc-confirm").addEventListener("click", async () => {
  if (!pendingStatusChange) return;
  const showContract = document.getElementById("sc-contract-section").style.display !== "none";
  const contractId = showContract
    ? (document.getElementById("sc-contract-select").value ? Number(document.getElementById("sc-contract-select").value) : null)
    : undefined;
  const explicitChangedAt = datetimeLocalToServer(document.getElementById("sc-datetime").value);
  const { element, status } = pendingStatusChange;
  pendingStatusChange = null;
  statusContractBackdrop.classList.remove("open");
  await doApplyStatus(element, status, contractId, explicitChangedAt);
});

async function doApplyStatus(element, status, explicitContractId, explicitChangedAt) {
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
    maybeWarnContract(updated);
  } catch (e) {
    alert("Не удалось изменить статус: " + e.message);
  }
}

// ---------- назначение плановой даты поставки одному элементу
// (независимо от статуса, см. Docs/backlog.md, "Контрактация 2.0") ----------
const plannedDateBackdrop = document.getElementById("planned-date-backdrop");
let pendingPlannedDateElement = null;

function openPlannedDateDialog(element) {
  pendingPlannedDateElement = element;
  document.getElementById("planned-date-error").textContent = "";
  document.getElementById("pd-date").value = element.planned_delivery_date || "";
  plannedDateBackdrop.classList.add("open");
}
document.getElementById("pd-cancel").addEventListener("click", () => {
  pendingPlannedDateElement = null;
  plannedDateBackdrop.classList.remove("open");
});
document.getElementById("pd-clear").addEventListener("click", () => {
  document.getElementById("pd-date").value = "";
});
document.getElementById("pd-confirm").addEventListener("click", async () => {
  if (!pendingPlannedDateElement) return;
  const value = document.getElementById("pd-date").value || null;
  const element = pendingPlannedDateElement;
  try {
    const updated = await api(`/elements/${element.id}/planned-delivery-date`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planned_delivery_date: value }),
    });
    Object.assign(element, updated);
    state.byId.set(element.id, element);
    pendingPlannedDateElement = null;
    plannedDateBackdrop.classList.remove("open");
    showCard(element);
    updateElementSubLabel(element);
  } catch (e) {
    document.getElementById("planned-date-error").textContent = e.message;
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
      matching.map(c => `<option value="${c.id}" ${String(c.id) === String(preselect) ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
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

// Окно НЕ ждёт /contracts (живой репорт "долго открывается"): остатки по
// строкам контрактов нужны только для НЕблокирующего предупреждения об
// овербукинге, а сам диалог полностью работоспособен без них. Раньше здесь
// стоял `await api("/contracts")` ПЕРЕД показом модалки — на реальных
// данных это 2,7 секунды пустого ожидания (см. Docs/backlog.md; сам
// эндпоинт с тех пор ускорен до единиц миллисекунд, но ждать его показ
// окна всё равно не должен — при росте числа контрактов всё вернулось бы).
// Открываем сразу, остатки подтягиваем следом и пересчитываем
// предупреждение, когда придут.
//
// bulkContractRequestId — защита от гонки: пользователь успевает закрыть
// окно и открыть его с ДРУГОЙ выборкой раньше, чем вернётся предыдущий
// запрос; ответ, устаревший к моменту прихода, молча отбрасывается.
let bulkContractRequestId = 0;

// Разметка таймингов операции «массовая смена статуса» — та же операция,
// на которую пользователь жаловался («долго открывается»), поэтому именно
// её и меряем целиком: нажатие -> форма открылась -> запись -> форма
// закрылась. Все четыре события связаны одним request_id.
let bulkStatusRequestId = null;

function openBulkStatusModal() {
  if (state.multiSelectedIds.size === 0) return;
  bulkStatusRequestId = newRequestId();
  const opened = startTiming("bulk_status_form_open", {
    requestId: bulkStatusRequestId,
    details: { элементов: state.multiSelectedIds.size },
  });
  logClientEvent("bulk_status_button_click", { requestId: bulkStatusRequestId });
  document.getElementById("bulk-status-select").innerHTML =
    state.statusOrder.map(s => `<option value="${s}">${escapeHtml(state.statusLabels[s])}</option>`).join("");
  // Перечисление типов элементов контракта убрано из подписи (живой запрос
  // пользователя) — остаётся только само наименование
  // "Контрагент/Договор № от ДАТА/Спецификация № от ДАТА (Тема)",
  // как оно выглядит во всех остальных местах интерфейса.
  document.getElementById("bulk-fill-contract-select").innerHTML = ['<option value="">— выберите контракт —</option>'].concat(
    state.contracts.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
  ).join("");

  bulkContractLines = []; // от прошлого открытия — до прихода свежих остатков предупреждений не показываем
  renderBulkStatusTable();
  bulkStatusBackdrop.classList.add("open");
  opened(); // форма на экране — засекаем, сколько заняло от нажатия

  const requestId = ++bulkContractRequestId;
  api("/contracts").then(contracts => {
    if (requestId !== bulkContractRequestId) return; // окно успели переоткрыть — ответ устарел
    bulkContractLines = contracts.flatMap(c => c.lines.map(l => ({
      contract_id: c.id, contract_name: c.name, element_type: l.element_type, remaining: l.remaining,
    })));
    updateBulkContractWarning(); // остатки пришли — пересчитать предупреждение по уже заполненной таблице
  }).catch(() => {
    // Проверка остатка просто не покажет предупреждений — она неблокирующая
    // и никогда не была условием работы диалога.
  });
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
  const saved = startTiming("bulk_status_save", {
    requestId: bulkStatusRequestId, details: { элементов: items.length, статус: status },
  });
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
    // Замер закрывается ЗДЕСЬ, а не сразу после ответа сервера: пользователя
    // интересует момент, когда форма ушла с экрана и можно работать дальше,
    // а не когда пришёл ответ — между ними ещё перерисовка схемы и легенды.
    saved({ details: { элементов: result.updated.length, статус: status, итог: "успех" } });
  } catch (e) {
    document.getElementById("bulk-status-error").textContent = "Не удалось изменить статус: " + e.message;
    saved({ details: { итог: "ошибка", сообщение: String(e.message) } });
  }
});

// ---------- массовое назначение плановой даты поставки (см.
// Docs/backlog.md, "Контрактация 2.0") — отдельное действие от массовой
// смены статуса, тем же приёмом (таблица выбранных элементов, поле на
// строку) ----------
const bulkPlannedDateBackdrop = document.getElementById("bulk-planned-date-backdrop");

function openBulkPlannedDateModal() {
  if (state.multiSelectedIds.size === 0) return;
  document.getElementById("bulk-planned-date-error").textContent = "";
  renderBulkPlannedDateTable();
  bulkPlannedDateBackdrop.classList.add("open");
}

function renderBulkPlannedDateTable() {
  const tbody = document.getElementById("bulk-planned-date-tbody");
  tbody.innerHTML = "";
  for (const id of Array.from(state.multiSelectedIds)) {
    const element = state.byId.get(id);
    if (!element) continue;
    const tr = document.createElement("tr");
    tr.dataset.elementId = element.id;

    const idTd = document.createElement("td"); idTd.textContent = element.id;
    const markTd = document.createElement("td"); markTd.textContent = element.mark || "—";
    const typeTd = document.createElement("td"); typeTd.textContent = element.element_type;

    const dateTd = document.createElement("td");
    const input = document.createElement("input");
    input.type = "date";
    input.className = "bulk-row-planned-date";
    input.value = element.planned_delivery_date || "";
    dateTd.appendChild(input);

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
      if (state.multiSelectedIds.size === 0) bulkPlannedDateBackdrop.classList.remove("open");
    });
    removeTd.appendChild(removeBtn);

    tr.append(idTd, markTd, typeTd, dateTd, removeTd);
    tbody.appendChild(tr);
  }
}

document.getElementById("bulk-planned-date-cancel").addEventListener("click", () => bulkPlannedDateBackdrop.classList.remove("open"));

// "Заполнить одной датой" — тот же приём удобства, что уже был у
// "bulk-fill-contract" в массовой смене статуса: заполняет ТОЛЬКО пустые
// поля, не перезаписывает уже введённые построчно значения.
document.getElementById("bulk-fill-planned-date-apply").addEventListener("click", () => {
  const value = document.getElementById("bulk-fill-planned-date").value;
  if (!value) return;
  let filled = 0;
  document.querySelectorAll("#bulk-planned-date-tbody .bulk-row-planned-date").forEach(input => {
    if (input.value) return;
    input.value = value;
    filled++;
  });
  showToast(`Заполнено ${filled}`, "info");
});

document.getElementById("bulk-planned-date-apply").addEventListener("click", async () => {
  const items = [];
  document.querySelectorAll("#bulk-planned-date-tbody tr").forEach(tr => {
    const input = tr.querySelector(".bulk-row-planned-date");
    items.push({ element_id: Number(tr.dataset.elementId), planned_delivery_date: input.value || null });
  });
  if (!items.length) return;
  try {
    const result = await api("/elements/bulk-planned-delivery-date", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
    });
    for (const updated of result.updated) {
      const existing = state.byId.get(updated.id);
      if (existing) {
        Object.assign(existing, updated);
        updateElementSubLabel(existing);
      }
    }
    bulkPlannedDateBackdrop.classList.remove("open");
    clearMultiSelection();
    showToast(`Плановая дата поставки изменена у ${result.updated.length} элементов`, "success");
  } catch (e) {
    document.getElementById("bulk-planned-date-error").textContent = "Не удалось изменить плановую дату: " + e.message;
  }
});
document.getElementById("multi-select-planned-date-btn").addEventListener("click", openBulkPlannedDateModal);

const svgRoot = document.getElementById("svg-root");
svgRoot.addEventListener("click", (e) => {
  if (dragMoved) return; // не выбираем элемент сразу после перетаскивания схемы
  const shape = e.target.closest(".element-shape");
  if (!shape) { closeCtxMenu(); clearSelection(); clearMultiSelection(); return; }
  const element = state.byId.get(Number(shape.getAttribute("data-id")));
  if (!element) return;
  // Ctrl/Cmd+клик по элементу, УЖЕ входящему в групповое выделение (рамка,
  // см. finishRubberBand) — убирает именно его из группы, не трогая
  // остальных и не открывая карточку (живой запрос пользователя, см.
  // Docs/backlog.md). Вне группового выделения (или по элементу, которого
  // в нём нет) Ctrl+клик не даёт ничего особого — обычный selectElement.
  if ((e.ctrlKey || e.metaKey) && state.multiSelectedIds.has(element.id)) {
    const ids = new Set(state.multiSelectedIds);
    ids.delete(element.id);
    setMultiSelection(ids);
    return;
  }
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
  // Shift+перетаскивание иначе запускает нативное выделение ТЕКСТА
  // браузера (подписи осей — SVG <text>, текст сайдбара) — рамка рисуется
  // поверх, но пользователь одновременно видит подсвеченный синим текст
  // интерфейса под ней (живой репорт пользователя, см. Docs/backlog.md).
  // preventDefault на mousedown — стандартный приём, отменяет привязку
  // нативного выделения к этой точке на весь последующий драг;
  // .rubber-band-active на body — подстраховка (user-select:none) на
  // случай браузеров, которые всё равно выделяют текст при перетаскивании
  // курсора за пределы исходного элемента.
  if (rubberBandActive) {
    e.preventDefault();
    document.body.classList.add("rubber-band-active");
  }
});
window.addEventListener("mouseup", () => {
  if (dragging && rubberBandActive && dragMoved) finishRubberBand();
  dragging = false;
  rubberBandActive = false;
  stageEl.classList.remove("dragging");
  rubberBandEl.style.display = "none";
  document.body.classList.remove("rubber-band-active");
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
  // Тот же корень, что и у рамки выделения (см. screenToWorld): прежний
  // пересчёт "пиксели -> мировые единицы" через rect.width/v.w игнорировал
  // вписывание viewBox по preserveAspectRatio и потому был неверен ровно на
  // ту же долю — схема ехала за курсором чуть медленнее (на контейнере
  // 2260x1200 — на ~4%). Берём реальный масштаб из матрицы преобразования:
  // ctm.a — сколько ЭКРАННЫХ пикселей приходится на одну мировую единицу по
  // X (по Y это ctm.d, со знаком минус из-за flip — поэтому abs).
  const v = state.view;
  const ctm = document.getElementById("flip").getScreenCTM();
  if (!ctm) return;
  const dx = (e.clientX - lastX) / ctm.a;
  const dy = (e.clientY - lastY) / Math.abs(ctm.d);
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

// Экран -> мировые координаты. Считается СОБСТВЕННЫМ преобразованием SVG
// (getScreenCTM группы #flip), а не вручную по viewBox и размеру
// контейнера.
//
// Почему не вручную: у <svg> стоит preserveAspectRatio="xMidYMid meet"
// (см. index.html) — то есть viewBox ВПИСЫВАЕТСЯ в контейнер целиком и
// центрируется, добавляя поля с двух сторон, если пропорции не совпадают.
// А совпадают они практически никогда: state.initialView берётся строго по
// габаритам данных (для файла 260723 аспект 1.741), контейнер — какой
// получится из размера окна и ширины сайдбара. Прежняя формула
// (`v.x + (sx - rect.left) / rect.width * v.w`) считала, будто viewBox
// растянут на весь контейнер ровно, и давала ошибку, НУЛЕВУЮ в центре и
// максимальную у краёв: на контейнере 2260x1200 это ±8233 мм (79 px) —
// рамка выделения "съезжала" внутрь с обеих сторон, элементы у её левого
// и правого края не попадали в выделение, приходилось захватывать пустую
// область с запасом (живой репорт пользователя, см. Docs/backlog.md).
//
// getScreenCTM берётся с группы #flip, а не с <svg>: тогда преобразование
// сразу включает и вписывание viewBox, и `transform="scale(1,-1)"` этой
// группы (содержимое схемы нарисовано реальными мировыми координатами БЕЗ
// инверсии, видимую ориентацию "Y вверх" даёт именно flip) — ручной
// поправки world.Y = -viewBox.Y больше не требуется, как и вообще какой-
// либо своей математики: любой будущий CSS-transform или padding у
// контейнера учтётся сам.
function screenToWorld(sx, sy) {
  const ctm = document.getElementById("flip").getScreenCTM();
  if (!ctm) return null; // схема скрыта (включён 3D) — преобразования не существует
  const p = new DOMPoint(sx, sy).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function screenRectToWorldBBox(sx1, sy1, sx2, sy2) {
  const a = screenToWorld(sx1, sy1);
  const b = screenToWorld(sx2, sy2);
  if (!a || !b) return null;
  // min/max, а не "первая точка — левый верхний угол": рамку тянут в любую
  // сторону, а по Y порядок вдобавок переворачивает flip.
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
  };
}

// Точка "где физически находится элемент" для попадания в рамку — центр
// его РЕАЛЬНОГО контура (footprintCentroid — тот же приём, что уже
// используется для наклеек марок/привязки конца ригеля к колонне), а не
// element.x/element.y: это позиция ВЫНОСКИ/лидера марки, которая часто
// заметно смещена от самой фигуры (источник марки "leader") — из-за
// этого элементы, чья фигура визуально целиком внутри рамки, не
// попадали в выделение, если их выноска оказывалась снаружи (живой
// репорт пользователя, см. Docs/backlog.md). Для элементов без контура
// (INSERT-блоки старого конвейера) — запасной вариант, x/y как раньше.
function rubberBandTestPoint(element) {
  if (element.outline && element.outline.length >= 3) {
    return footprintCentroid(element.outline);
  }
  return [element.x, element.y];
}

function finishRubberBand() {
  const box = screenRectToWorldBBox(startX, startY, rbCurX, rbCurY);
  if (!box) return;
  // Накопительное выделение (см. Docs/backlog.md) — новая рамка ДОБАВЛЯЕТ
  // захваченные элементы к уже выделенным, никогда не снимает выделение с
  // того, что было выбрано раньше; "✕" на плавающей панели — единственный
  // способ сбросить всё и начать заново.
  const ids = new Set(state.multiSelectedIds);
  for (const element of state.elements) {
    if (!passesPlacementFilters(element)) continue; // выделяем только то, что сейчас реально видно
    const [px, py] = rubberBandTestPoint(element);
    if (px >= box.minX && px <= box.maxX && py >= box.minY && py <= box.maxY) {
      ids.add(element.id);
    }
  }
  setMultiSelection(ids);
}

// ---------- всплывающая подсказка при наведении (2D) — те же даты/статус
// опоздания, что на инфо-плашке (см. computeTooltipDateRows), плюс
// количество дней опоздания в тексте. Задержка и приём (таймер + "тот же
// элемент под курсором") — тот же паттерн, что уже был у 3D-подсказки
// (см. hover3DTimer/show3DTooltip ниже). ----------
let hover2DTimer = null;
let hover2DElementId = null;

function hide2DTooltip() {
  clearTimeout(hover2DTimer);
  hover2DTimer = null;
  hover2DElementId = null;
  const tip = document.getElementById("tooltip-2d");
  if (tip) tip.style.display = "none";
}

function position2DTooltip(clientX, clientY) {
  const tip = document.getElementById("tooltip-2d");
  const rect = stageEl.getBoundingClientRect();
  const offset = 14;
  let left = clientX - rect.left + offset;
  let top = clientY - rect.top + offset;
  if (left + tip.offsetWidth > rect.width) left = clientX - rect.left - tip.offsetWidth - offset;
  if (top + tip.offsetHeight > rect.height) top = clientY - rect.top - tip.offsetHeight - offset;
  tip.style.left = Math.max(0, left) + "px";
  tip.style.top = Math.max(0, top) + "px";
}

function show2DTooltip(element, clientX, clientY) {
  const tip = document.getElementById("tooltip-2d");
  tip.textContent = "";
  const title = document.createElement("div");
  title.className = "t2d-title";
  title.textContent = element.mark || element.element_type || `Элемент #${element.id}`;
  tip.appendChild(title);
  const basicRows = [
    ["Тип", element.element_type],
    ["Подтип", element.subtype],
    ["Отметка", (element.elevation_mm === null || element.elevation_mm === undefined) ? null : element.elevation_mm + " мм"],
  ];
  for (const [label, value] of basicRows) {
    const line = document.createElement("div");
    line.textContent = label + ": " + ((value === null || value === undefined || value === "") ? "—" : value);
    tip.appendChild(line);
  }
  const dateRows = computeTooltipDateRows(element);
  if (dateRows) {
    for (const row of dateRows) {
      const line = document.createElement("div");
      line.className = "t2d-row " + row.cls;
      line.textContent = row.text;
      tip.appendChild(line);
    }
  } else {
    const line = document.createElement("div");
    line.className = "t2d-row neutral";
    line.textContent = "Начало СМР не задано";
    tip.appendChild(line);
  }
  tip.style.display = "block";
  position2DTooltip(clientX, clientY);
}

function on2DMouseMove(e) {
  // Во время панорамирования/рамки выделения подсказка мешает и правдой
  // не является (курсор летит по схеме, а не "стоит" на элементе).
  if (dragging && dragMoved) { hide2DTooltip(); return; }
  const shape = e.target.closest(".element-shape");
  const elementId = shape ? Number(shape.getAttribute("data-id")) : null;
  if (elementId !== hover2DElementId) {
    hide2DTooltip();
    hover2DElementId = elementId;
    if (elementId !== null) {
      const element = state.byId.get(elementId);
      const cx = e.clientX, cy = e.clientY;
      hover2DTimer = setTimeout(() => {
        if (hover2DElementId === elementId && element) show2DTooltip(element, cx, cy);
      }, 1000);
    }
    return;
  }
  if (elementId !== null) position2DTooltip(e.clientX, e.clientY);
}

svgRoot.addEventListener("mousemove", on2DMouseMove);
svgRoot.addEventListener("mouseleave", hide2DTooltip);

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

// ==================== Esc ЗАКРЫВАЕТ ВЕРХНЮЮ ОТКРЫТУЮ ФОРМУ ====================
// Раньше Esc закрывал ВСЕ открытые модалки разом — если из списка
// (контракты/контрагенты) была открыта форма элемента (изменить
// контракт/контрагента), Esc закрывал и форму, и список одним нажатием.
// Живой запрос пользователя: первый Esc должен закрывать только форму,
// список — оставаться открытым для дальнейшей работы; второй Esc
// закрывает уже список. Вложенные модалки (форма поверх списка) везде
// в разметке объявлены ПОСЛЕ своего родительского списка (см.
// contracts-backdrop/contract-edit-backdrop,
// counterparties-backdrop/counterparty-edit-backdrop) — последняя среди
// открытых в DOM-порядке и есть верхняя по стеку, закрывать её одну.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const openModals = document.querySelectorAll(".modal-backdrop.open");
  if (openModals.length) {
    openModals[openModals.length - 1].classList.remove("open");
    return;
  }
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
  if (!settingsMenu.classList.contains("open")) closeAllSubmenus();
});
document.addEventListener("click", () => {
  settingsMenu.classList.remove("open");
  closeAllSubmenus();
});

// ---------- подменю (живой запрос 2026-07-29: группы в виде подменю, а не
// сплошного списка) ----------
function closeAllSubmenus() {
  settingsMenu.querySelectorAll(".submenu.open").forEach(el => el.classList.remove("open"));
}

function openSubmenu(submenu) {
  if (submenu.classList.contains("open")) return;
  closeAllSubmenus(); // одновременно раскрыта всегда одна группа
  submenu.classList.add("open");
  // Панель по умолчанию уходит влево (кнопка "Действия" у правого края).
  // Если слева места не хватает — например, окно узкое или меню оказалось
  // ближе к левому краю — разворачиваем вправо. Проверяем ПОСЛЕ показа:
  // у скрытого элемента ширина нулевая, и решение было бы неверным.
  const panel = submenu.querySelector(".submenu-panel");
  if (!panel) return;
  panel.classList.remove("submenu-panel-right");
  const rect = panel.getBoundingClientRect();
  if (rect.left < 4) panel.classList.add("submenu-panel-right");
}

settingsMenu.querySelectorAll(".submenu").forEach(submenu => {
  const trigger = submenu.querySelector(".submenu-trigger");
  // Клик по заголовку группы НЕ должен закрывать всё меню (документный
  // обработчик выше), поэтому stopPropagation. Клик — основной способ:
  // он работает и на сенсорном экране, и при неточном наведении.
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (submenu.classList.contains("open")) submenu.classList.remove("open");
    else openSubmenu(submenu);
  });
  // Наведение — привычное поведение настольного меню: провёл мышью по
  // группам, увидел содержимое каждой, ничего не нажимая.
  submenu.addEventListener("mouseenter", () => openSubmenu(submenu));
});

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
  requestRender3D(); // перекраска материала сама по себе кадр не рисует
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

// ==================== СПРАВОЧНИК ОБЪЕКТОВ ====================
// Объект — то, к чему привязана идентичность элементов (см. Docs/TZ.md).
// Форма минимальная: показать, чем объект сейчас описан (актуальный чертёж,
// сколько элементов актуальны и сколько исчезли из чертежа), и дать
// переименовать — автоматически заведённый объект называется "Объект 1".
const objectsBackdrop = document.getElementById("objects-backdrop");

async function renderObjectsModal() {
  const box = document.getElementById("objects-rows");
  const statusBox = document.getElementById("objects-status");
  statusBox.textContent = "";
  const objects = await api("/objects");
  if (!objects.length) {
    box.innerHTML = `<p class="hint-text">Объектов пока нет — объект появится при первой загрузке чертежа.</p>`;
    return;
  }
  box.innerHTML = objects.map(o => `
    <div style="padding:10px 0; border-bottom:1px solid var(--color-border)">
      <div class="subtype-add-row">
        <input type="text" data-object-id="${o.id}" class="object-name" value="${escapeHtml(o.name)}"/>
        ${(state.currentUser && state.currentUser.role === "admin") ? `<button class="btn btn-sm btn-secondary" data-save-object="${o.id}">Сохранить</button>` : ""}
      </div>
      <div class="hint-text" style="margin-top:6px">
        Актуальный чертёж: ${escapeHtml(o.current_source_file || "—")}.
        Элементов: ${o.elements_current}${o.elements_retired ? `, исчезли из чертежа: ${o.elements_retired}` : ""}.
        ${o.drawings.length > 1 ? `Загружалось версий: ${o.drawings.length}.` : ""}
      </div>
    </div>`).join("");

  box.querySelectorAll("[data-save-object]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-save-object");
      const input = box.querySelector(`input.object-name[data-object-id="${id}"]`);
      try {
        await api(`/objects/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: input.value }),
        });
        // Перерисовка ПЕРЕД сообщением, а не после: renderObjectsModal
        // первым делом очищает эту же строку состояния, и в обратном порядке
        // подтверждение гасло бы сразу после появления.
        await renderObjectsModal();
        statusBox.style.color = "var(--color-text-muted)";
        statusBox.textContent = "Сохранено.";
      } catch (e) {
        statusBox.style.color = "var(--color-danger)";
        statusBox.textContent = e.message || "Не удалось сохранить";
      }
    });
  });
}

document.getElementById("menu-objects").addEventListener("click", async () => {
  objectsBackdrop.classList.add("open");
  await renderObjectsModal();
});
document.getElementById("objects-close").addEventListener("click", () => objectsBackdrop.classList.remove("open"));

// ==================== СПРАВОЧНИК ЭЛЕМЕНТОВ (этап 3, решение Э1) ====================
// Таблица всех элементов объекта с отбором по колонкам и сортировкой.
// Постранично: 9422 строки одним куском браузер отрисует, но прокрутка по
// такой таблице станет вязкой, а смысла в ней нет — работают с отобранным
// подмножеством.
const elementCatalogBackdrop = document.getElementById("element-catalog-backdrop");
const EC_PAGE_SIZE = 200;

// Колонки: ключ, подпись, отбирается ли выпадашкой. Порядок — как читают:
// сначала «что это», потом «где», потом даты.
const EC_COLUMNS = [
  { key: "element_type", label: "Тип", filter: true },
  { key: "subtype", label: "Подтип", filter: true },
  { key: "mark", label: "Марка", filter: true },
  { key: "elevation_mm", label: "Отметка", filter: true },
  { key: "floor", label: "Этаж", filter: true },
  { key: "address", label: "Адрес по осям", filter: false },
  { key: "current_status", label: "Статус", filter: true },
  { key: "planned_delivery_date", label: "План. поставка", filter: false },
  { key: "actual_delivery_date", label: "Факт. поставка", filter: false },
  { key: "project_smr_start_date", label: "Начало СМР", filter: false },
];

const ecState = { sort: "id", direction: "asc", offset: 0, filters: {}, search: "" };

function ecCellText(row, key) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  if (key === "current_status") return state.statusLabels[value] || value;
  if (key.endsWith("_date")) return formatDateRu(value) || "—";
  return String(value);
}

function ecFilterLabel(column, value) {
  if (value === PLACEMENT_NONE) return "— не задано —";
  if (column === "current_status") return state.statusLabels[value] || value;
  return String(value);
}

async function renderElementCatalog() {
  const params = new URLSearchParams({
    limit: EC_PAGE_SIZE, offset: ecState.offset,
    sort: ecState.sort, direction: ecState.direction,
  });
  if (ecState.search) params.set("search", ecState.search);
  for (const [k, v] of Object.entries(ecState.filters)) if (v) params.set(k, v);

  const table = document.getElementById("ec-table");
  const summary = document.getElementById("ec-summary");
  summary.textContent = "Загрузка…";
  let data;
  try {
    data = await api(`/element-catalog?${params.toString()}`);
  } catch (e) {
    summary.textContent = "Ошибка: " + e.message;
    return;
  }

  const head = EC_COLUMNS.map(col => {
    const arrow = ecState.sort === col.key ? (ecState.direction === "asc" ? " ▲" : " ▼") : "";
    return `<th style="text-align:left; white-space:nowrap">
      <button type="button" class="ec-sort" data-sort="${col.key}"
        style="background:none; border:none; padding:0; font:inherit; font-weight:600; cursor:pointer">
        ${escapeHtml(col.label)}${arrow}</button></th>`;
  }).join("");

  const filterRow = EC_COLUMNS.map(col => {
    if (!col.filter) return "<td></td>";
    const options = ['<option value="">— все —</option>'].concat(
      (data.values[col.key] || []).map(v =>
        `<option value="${escapeHtml(String(v))}"${String(v) === ecState.filters[col.key] ? " selected" : ""}>` +
        `${escapeHtml(ecFilterLabel(col.key, v))}</option>`)
    ).join("");
    return `<td><select data-filter="${col.key}" style="width:100%; font-size:11px">${options}</select></td>`;
  }).join("");

  table.innerHTML = `<thead><tr>${head}</tr><tr>${filterRow}</tr></thead>
    <tbody>${data.rows.map(row => `<tr data-element-id="${row.id}" style="cursor:pointer"
      ${row.id === ecActiveElementId ? 'class="ec-row-active"' : ""}>
      ${EC_COLUMNS.map(col => `<td>${escapeHtml(ecCellText(row, col.key))}</td>`).join("")}
    </tr>`).join("")}</tbody>`;

  table.querySelectorAll("tbody tr[data-element-id]").forEach(tr => {
    tr.addEventListener("click", () => {
      ecActiveElementId = Number(tr.getAttribute("data-element-id"));
      table.querySelectorAll("tbody tr").forEach(x => x.classList.remove("ec-row-active"));
      tr.classList.add("ec-row-active");
      renderEcDetail();
    });
  });

  table.querySelectorAll(".ec-sort").forEach(btn => btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-sort");
    if (ecState.sort === key) {
      ecState.direction = ecState.direction === "asc" ? "desc" : "asc";
    } else {
      ecState.sort = key;
      ecState.direction = "asc";
    }
    ecState.offset = 0;
    renderElementCatalog();
  }));
  table.querySelectorAll("select[data-filter]").forEach(sel => sel.addEventListener("change", () => {
    ecState.filters[sel.getAttribute("data-filter")] = sel.value;
    ecState.offset = 0;
    renderElementCatalog();
  }));

  const from = data.total ? ecState.offset + 1 : 0;
  const to = Math.min(ecState.offset + data.rows.length, data.total);
  summary.textContent = `Найдено ${data.total}, показаны ${from}–${to}.`;
  document.getElementById("ec-page").textContent = `${from}–${to} из ${data.total}`;
  document.getElementById("ec-prev").disabled = ecState.offset === 0;
  document.getElementById("ec-next").disabled = to >= data.total;
}

// ---------- Статусы активного элемента под таблицей (живой запрос) ----------
// Правка статуса идёт ТЕМ ЖЕ диалогом, что и со схемы (openStatusDialog):
// там уже живут выбор даты применения, выбор контракта при первом уходе с
// «Запланирован» и предупреждение об овербукинге. Вторая точка входа в смену
// статуса не должна означать вторую реализацию правил.
let ecActiveElementId = null;

async function renderEcDetail() {
  const box = document.getElementById("ec-detail");
  if (!ecActiveElementId) {
    box.innerHTML = `<p class="hint-text">Щёлкните строку выше, чтобы увидеть статусы элемента.</p>`;
    return;
  }
  box.innerHTML = `<p class="hint-text">Загрузка…</p>`;
  let element;
  try {
    element = await api(`/elements/${ecActiveElementId}`);
  } catch (e) {
    box.innerHTML = `<p class="hint-text" style="color:var(--color-danger)">${escapeHtml(e.message)}</p>`;
    return;
  }
  const admin = !!(state.currentUser && state.currentUser.role === "admin");
  const statusOptions = state.statusOrder
    .map(st => `<option value="${st}"${st === element.current_status ? " selected" : ""}>` +
               `${escapeHtml(state.statusLabels[st] || st)}</option>`).join("");

  box.innerHTML = `
    <div class="subtype-add-row" style="align-items:flex-end; margin-bottom:8px">
      <div><b>${escapeHtml(element.element_type)} ${escapeHtml(element.mark || "без марки")}</b>
        <span class="hint-text">— ${escapeHtml(element.address || "адрес не определён")},
        текущий статус: ${escapeHtml(state.statusLabels[element.current_status] || element.current_status)}</span></div>
      <span class="spacer"></span>
      ${admin ? `<select id="ec-status-select" style="font-size:12px">${statusOptions}</select>
        <button class="btn btn-sm btn-primary" id="ec-status-apply">Изменить статус…</button>` : ""}
    </div>
    <table style="width:100%; font-size:12px">
      <thead><tr>
        <th style="text-align:left">Дата</th><th style="text-align:left">Статус</th>
        <th style="text-align:left">Кто изменил</th><th style="text-align:left">Комментарий</th>
        ${admin ? "<th></th>" : ""}
      </tr></thead>
      <tbody>${(element.history || []).map(h => `<tr>
        <td>${escapeHtml(h.changed_at || "")}</td>
        <td>${escapeHtml(state.statusLabels[h.status] || h.status)}</td>
        <td>${escapeHtml(h.changed_by || "—")}</td>
        <td>${escapeHtml(h.comment || "")}</td>
        ${admin ? `<td><button class="btn btn-sm btn-secondary" data-del-history="${h.id}"
          title="Удалить запись истории">✕</button></td>` : ""}
      </tr>`).join("")}</tbody>
    </table>`;

  if (!admin) return;
  document.getElementById("ec-status-apply").addEventListener("click", () => {
    const status = document.getElementById("ec-status-select").value;
    // Диалог сам применит смену и обновит схему; справочник перечитываем
    // после закрытия — статус элемента и его история изменились.
    openStatusDialog(element, status);
    const backdrop = document.getElementById("status-contract-backdrop");
    const observer = new MutationObserver(() => {
      if (!backdrop.classList.contains("open")) {
        observer.disconnect();
        renderEcDetail();
        renderElementCatalog();
      }
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ["class"] });
  });
  box.querySelectorAll("[data-del-history]").forEach(btn => btn.addEventListener("click", async () => {
    const historyId = btn.getAttribute("data-del-history");
    if (!confirm("Удалить эту запись истории? Текущий статус элемента будет пересчитан по остальным записям.")) return;
    try {
      await api(`/elements/${ecActiveElementId}/history/${historyId}`, { method: "DELETE" });
      await renderEcDetail();
      await renderElementCatalog();
      if (state.sourceFile) await loadPlan(true);
    } catch (e) {
      showToast("Не удалось удалить запись: " + e.message, "warning");
    }
  }));
}

document.getElementById("menu-element-catalog").addEventListener("click", () => {
  elementCatalogBackdrop.classList.add("open");
  renderElementCatalog();
});
document.getElementById("ec-close").addEventListener("click", () => elementCatalogBackdrop.classList.remove("open"));
document.getElementById("ec-prev").addEventListener("click", () => {
  ecState.offset = Math.max(ecState.offset - EC_PAGE_SIZE, 0);
  renderElementCatalog();
});
document.getElementById("ec-next").addEventListener("click", () => {
  ecState.offset += EC_PAGE_SIZE;
  renderElementCatalog();
});
document.getElementById("ec-reset").addEventListener("click", () => {
  ecState.filters = {};
  ecState.search = "";
  ecState.offset = 0;
  document.getElementById("ec-search").value = "";
  renderElementCatalog();
});
// Поиск по вводу с задержкой: запрос на каждую букву при 9422 строках
// означал бы десяток лишних полных отборов подряд.
let ecSearchTimer = null;
document.getElementById("ec-search").addEventListener("input", e => {
  clearTimeout(ecSearchTimer);
  const value = e.target.value.trim();
  ecSearchTimer = setTimeout(() => {
    ecState.search = value;
    ecState.offset = 0;
    renderElementCatalog();
  }, 350);
});

// ==================== СПРАВОЧНИКИ ЗОН (этап 2) ====================
// Физически это одна таблица с полем категории (решение З15), но
// пользователь видит три справочника — захватки, зоны кранов, стоянки
// кранов, — поэтому и пунктов меню три, а форма одна.
const zonesBackdrop = document.getElementById("zones-backdrop");
const ZONE_CATEGORY_TITLES = {
  "Захватка": ["Захватки", "Захватка — самостоятельное деление объекта; принадлежность элемента определяется вхождением в область."],
  "Кран": ["Зоны кранов", "Зона работы крана. Стоянки крана подчинены зоне и ссылаются на неё."],
  "Стоянка": ["Стоянки крана", "Рабочая зона крана в конкретной позиции. Номер уникален внутри своего крана, ярусы — набор полигонов по отметкам."],
};
let zonesCategory = "Захватка";

// Склонение числительного: 1 точка, 2–4 точки, 5+ точек. Обычное правило
// русского языка, вынесено отдельно — контуры на реальных чертежах бывают и
// четырёхугольные, и многоугольные, и «4 точек» в интерфейсе читается как
// недоделка.
function pointsWord(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "точек";
  if (mod10 === 1) return "точка";
  if (mod10 >= 2 && mod10 <= 4) return "точки";
  return "точек";
}

function zoneLevelsText(levels) {
  if (!levels.length) return "нет ярусов";
  return levels.map(l =>
    `${l.elevation_mm === null || l.elevation_mm === undefined ? "без отметки" : `+${l.elevation_mm}`}` +
    ` (${l.points} ${pointsWord(l.points)})`).join(", ");
}

async function renderZonesModal() {
  const [title, hint] = ZONE_CATEGORY_TITLES[zonesCategory];
  document.getElementById("zones-title").textContent = title;
  document.getElementById("zones-hint").textContent =
    hint + (canEditZones() ? " Щёлкните строку, чтобы поправить номер, кран и координаты точек." : "");
  const box = document.getElementById("zones-rows");
  document.getElementById("zones-undo").style.display =
    (lastZoneEdit && canEditZones()) ? "" : "none";
  box.innerHTML = `<p class="hint-text">Загрузка…</p>`;
  const retired = document.getElementById("zones-include-retired").checked;
  try {
    const zones = await api(`/zones?category=${encodeURIComponent(zonesCategory)}&include_retired=${retired}`);
    if (!zones.length) {
      box.innerHTML = `<p class="hint-text">Зон этой категории нет. Они появляются при загрузке чертежа.</p>`;
      return;
    }
    box.innerHTML = `<table style="width:100%; font-size:12px">
      <thead><tr>
        <th style="text-align:left">№</th>
        <th style="text-align:left">Наименование</th>
        ${zonesCategory === "Стоянка" ? '<th style="text-align:left">Кран</th>' : ""}
        <th style="text-align:left">Ярусы</th>
        <th style="text-align:right">Элементов</th>
      </tr></thead>
      <tbody>${zones.map(z => `<tr data-zone-id="${z.id}"${z.is_current ? "" : ' class="hint-text"'}
        ${canEditZones() ? 'style="cursor:pointer"' : ""}>
        <td>${z.number === null || z.number === undefined ? "—" : z.number}</td>
        <td>${escapeHtml(z.name || "без наименования")}${z.is_current ? "" : " (нет в чертеже)"}</td>
        ${zonesCategory === "Стоянка" ? `<td>${escapeHtml(z.parent_name || "не определён")}</td>` : ""}
        <td>${escapeHtml(zoneLevelsText(z.levels))}</td>
        <td style="text-align:right">${z.elements}</td>
      </tr>`).join("")}</tbody></table>`;
    if (canEditZones()) {
      box.querySelectorAll("tr[data-zone-id]").forEach(tr => {
        tr.addEventListener("click", () => openZoneEditor(Number(tr.getAttribute("data-zone-id"))));
      });
    }
  } catch (e) {
    box.innerHTML = `<p class="hint-text" style="color:var(--color-danger)">${escapeHtml(e.message)}</p>`;
  }
}

// Правка зон — только админ (решение З16). Просмотр справочника доступен всем
// ролям, поэтому строка кликабельна не у всех.
function canEditZones() {
  return !!(state.currentUser && state.currentUser.role === "admin");
}

// ---------- Форма правки зоны: точки + предпросмотр (решения З13, З14) ----------
// Состояние правки держим в объекте, а не читаем каждый раз из DOM: точки
// пересчитываются в предпросмотр на каждый ввод, и разбирать десятки полей
// заново на каждое нажатие клавиши незачем.
let zoneEdit = null; // {zone, levels: [{id, elevation_mm, outline}], context, cranes}
// Последняя правка зоны в этом сеансе — по ней работает кнопка «Отменить
// последнюю правку» в справочнике. Снимки правок хранит сервер, поэтому откат
// возможен и позже; кнопка просто не знает, что отменять, пока в этом сеансе
// ничего не правили.
let lastZoneEdit = null;

const zoneEditBackdrop = document.getElementById("zone-edit-backdrop");

async function openZoneEditor(zoneId) {
  const data = await api(`/zones/${zoneId}/geometry`);
  zoneEdit = {
    zone: data.zone,
    // Координаты — в ЦЕЛЫХ миллиметрах. Из DXF они приходят с дробным
    // хвостом (6718.578588724135), и править такое в поле невозможно:
    // пользователь не глазомерит доли миллиметра, а на стройплощадке они
    // не значат ничего. Округление применяется при сохранении вместе с
    // остальной правкой — это осознанная нормализация, а не потеря данных.
    levels: data.levels.map(l => ({
      id: l.id, elevation_mm: l.elevation_mm,
      outline: l.outline.map(p => [Math.round(p[0]), Math.round(p[1])]),
    })),
    context: data.context,
    cranes: data.cranes,
    active: { level: 0, point: null },
  };
  document.getElementById("zone-edit-title").textContent =
    `${data.zone.category} ${data.zone.name ? "— " + data.zone.name : ""}`;
  document.getElementById("zone-edit-number").value = data.zone.number ?? "";
  document.getElementById("zone-edit-name").value = data.zone.name ?? "";
  const craneBox = document.getElementById("zone-edit-crane-box");
  const craneSel = document.getElementById("zone-edit-crane");
  if (data.zone.category === "Стоянка") {
    craneBox.style.display = "";
    craneSel.innerHTML = ['<option value="">не определён</option>'].concat(
      data.cranes.map(c => `<option value="${c.id}">${escapeHtml(c.name || ("Кран " + c.number))}</option>`)
    ).join("");
    craneSel.value = data.zone.parent_zone_id ? String(data.zone.parent_zone_id) : "";
  } else {
    craneBox.style.display = "none";
  }
  document.getElementById("zone-edit-status").textContent = "";
  renderZoneLevels();
  // Камера 3D-предпросмотра выставляется заново на каждое открытие формы —
  // зона другая, прежний ракурс к ней отношения не имеет.
  zonePreview3d.framed = false;
  await setZonePreviewMode("2d");
  renderZonePreview();
  zoneEditBackdrop.classList.add("open");
}

function renderZoneLevels() {
  const box = document.getElementById("zone-edit-levels");
  box.innerHTML = zoneEdit.levels.map((level, li) => `
    <div style="border:1px solid var(--color-border); border-radius:6px; padding:8px; margin-bottom:8px">
      <div class="subtype-add-row" style="align-items:center">
        <label class="field" style="margin:0">Отметка, мм</label>
        <input type="number" data-elev="${li}" value="${level.elevation_mm ?? ""}" style="width:110px"/>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-secondary" data-del-level="${li}"
          ${zoneEdit.levels.length === 1 ? "disabled" : ""}>Удалить ярус</button>
      </div>
      <table style="width:100%; font-size:12px; margin-top:6px">
        <thead><tr><th style="width:28px"></th><th style="text-align:left">X, мм</th><th style="text-align:left">Y, мм</th><th></th></tr></thead>
        <tbody>${level.outline.map((p, pi) => `<tr>
          <td class="hint-text">${pi + 1}</td>
          <td><input type="number" step="1" data-pt="${li}:${pi}:0" value="${p[0]}" style="width:100%"/></td>
          <td><input type="number" step="1" data-pt="${li}:${pi}:1" value="${p[1]}" style="width:100%"/></td>
          <td><button class="btn btn-sm btn-secondary" data-del-pt="${li}:${pi}"
                ${level.outline.length <= 3 ? "disabled" : ""}>✕</button></td>
        </tr>`).join("")}</tbody>
      </table>
      <button class="btn btn-sm btn-secondary" data-add-pt="${li}" style="margin-top:6px">+ Точка</button>
    </div>`).join("");

  box.querySelectorAll("input[data-pt]").forEach(input => {
    const [li, pi, axis] = input.getAttribute("data-pt").split(":").map(Number);
    // input, а не change: предпросмотр должен двигаться вместе с вводом —
    // ровно это пользователь и просил видеть.
    input.addEventListener("input", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      zoneEdit.levels[li].outline[pi][axis] = value;
      zoneEdit.active = { level: li, point: pi };
      renderZonePreview();
    });
    input.addEventListener("focus", () => {
      zoneEdit.active = { level: li, point: pi };
      renderZonePreview();
    });
  });
  box.querySelectorAll("input[data-elev]").forEach(input => {
    input.addEventListener("input", () => {
      const li = Number(input.getAttribute("data-elev"));
      zoneEdit.levels[li].elevation_mm = input.value === "" ? null : Number(input.value);
    });
  });
  box.querySelectorAll("[data-del-pt]").forEach(btn => btn.addEventListener("click", () => {
    const [li, pi] = btn.getAttribute("data-del-pt").split(":").map(Number);
    zoneEdit.levels[li].outline.splice(pi, 1);
    renderZoneLevels(); renderZonePreview();
  }));
  box.querySelectorAll("[data-add-pt]").forEach(btn => btn.addEventListener("click", () => {
    const li = Number(btn.getAttribute("data-add-pt"));
    const outline = zoneEdit.levels[li].outline;
    const last = outline[outline.length - 1], first = outline[0];
    // Новая точка — в середине замыкающего ребра: любое другое место
    // (например, копия последней) даёт нулевую площадь и самопересечение.
    outline.push([(last[0] + first[0]) / 2, (last[1] + first[1]) / 2]);
    renderZoneLevels(); renderZonePreview();
  }));
  box.querySelectorAll("[data-del-level]").forEach(btn => btn.addEventListener("click", () => {
    zoneEdit.levels.splice(Number(btn.getAttribute("data-del-level")), 1);
    renderZoneLevels(); renderZonePreview();
  }));
}

document.getElementById("zone-edit-add-level").addEventListener("click", () => {
  const source = zoneEdit.levels[zoneEdit.levels.length - 1];
  zoneEdit.levels.push({
    id: null,
    elevation_mm: source ? (source.elevation_mm ?? 0) + 1000 : 0,
    outline: source ? source.outline.map(p => [p[0], p[1]]) : [[0, 0], [1000, 0], [1000, 1000]],
  });
  renderZoneLevels(); renderZonePreview();
});

// Предпросмотр: габариты объекта, сетка осей, соседние зоны той же категории
// (заметно блёкло), полигоны крана-владельца, правимые ярусы. Элементы схемы
// не рисуются — предпросмотр должен открываться мгновенно.
function renderZonePreview() {
  const svg = document.getElementById("zone-edit-preview");
  const bbox = zoneEdit.context.bbox;
  if (!bbox) { svg.innerHTML = ""; return; }
  // Габариты пересчитываем с учётом правимых точек: их можно увести за
  // пределы исходной рамки, и зона не должна уезжать за край картинки.
  let [minX, minY, maxX, maxY] = bbox;
  for (const level of zoneEdit.levels) {
    for (const p of level.outline) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.03;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const W = 400, H = 300;
  const scale = Math.min(W / (maxX - minX), H / (maxY - minY));
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  // Y инвертируется: в чертеже ось вверх, в SVG вниз (тот же приём, что у
  // основной схемы — см. группу #flip).
  const sx = x => offX + (x - minX) * scale;
  const sy = y => H - offY - (y - minY) * scale;
  const poly = (outline, attrs) =>
    `<polygon points="${outline.map(p => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")}" ${attrs}/>`;

  const parts = [`<rect x="0" y="0" width="${W}" height="${H}" fill="none"/>`];
  for (const axis of zoneEdit.context.axes) {
    parts.push(axis.kind === "numeric"
      ? `<line x1="${sx(axis.coord).toFixed(1)}" y1="0" x2="${sx(axis.coord).toFixed(1)}" y2="${H}" stroke="var(--color-border)" stroke-width="0.5" opacity="0.5"/>`
      : `<line x1="0" y1="${sy(axis.coord).toFixed(1)}" x2="${W}" y2="${sy(axis.coord).toFixed(1)}" stroke="var(--color-border)" stroke-width="0.5" opacity="0.5"/>`);
  }
  for (const sib of zoneEdit.context.siblings) {
    parts.push(poly(sib.outline, 'fill="#888" fill-opacity="0.05" stroke="#888" stroke-opacity="0.25" stroke-width="0.7"'));
  }
  for (const level of zoneEdit.context.parent) {
    parts.push(poly(level.outline, 'fill="none" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="4 3"'));
  }
  zoneEdit.levels.forEach((level, li) => {
    const activeLevel = li === zoneEdit.active.level;
    parts.push(poly(level.outline,
      `fill="#2471a3" fill-opacity="${activeLevel ? 0.22 : 0.08}" stroke="#2471a3" ` +
      `stroke-opacity="${activeLevel ? 1 : 0.4}" stroke-width="${activeLevel ? 1.6 : 1}"`));
    if (activeLevel) {
      // Центр фигуры — чтобы номера точек ушли НАРУЖУ от контура и не легли
      // на саму границу.
      const cxCentre = level.outline.reduce((a, q) => a + sx(q[0]), 0) / level.outline.length;
      const cyCentre = level.outline.reduce((a, q) => a + sy(q[1]), 0) / level.outline.length;
      level.outline.forEach((p, pi) => {
        const current = pi === zoneEdit.active.point;
        const cx = sx(p[0]), cy = sy(p[1]);
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${current ? 4 : 2.5}" ` +
          `fill="${current ? "#d68910" : "#2471a3"}"/>`);
        // Номер точки — тот же, что в таблице слева (нумерация с 1): без него
        // непонятно, какую строку таблицы двигать, чтобы поехала нужная вершина.
        const dx = cx - cxCentre, dy = cy - cyCentre;
        const len = Math.hypot(dx, dy) || 1;
        parts.push(`<text x="${(cx + (dx / len) * 9).toFixed(1)}" y="${(cy + (dy / len) * 9 + 3).toFixed(1)}" ` +
          `text-anchor="middle" font-size="9" fill="${current ? "#d68910" : "#2471a3"}" ` +
          `font-weight="${current ? "700" : "400"}">${pi + 1}</text>`);
      });
    }
  });
  svg.innerHTML = parts.join("");
  const level = zoneEdit.levels[zoneEdit.active.level];
  document.getElementById("zone-edit-preview-hint").textContent =
    `Ярус ${zoneEdit.active.level + 1}` +
    (level && level.elevation_mm !== null && level.elevation_mm !== undefined ? ` (отм. +${level.elevation_mm})` : " (без отметки)") +
    `. Пунктиром — кран-владелец, бледным — соседние зоны той же категории. Координаты — в целых мм.`;
  // 3D-предпросмотр живёт от тех же данных: если он сейчас открыт, правка
  // точки должна двигать и объём, а не только плоский контур.
  if (zonePreviewMode === "3d") rebuildZonePreview3d();
}

// ---------- 3D-предпросмотр зоны (решение З13: «предпросмотр в 2D/3D по
// выбору пользователя») ----------
// Своя маленькая сцена, а не переиспользование основной: та держит ~9400
// мешей элементов, и показывать её в модалке ради одной зоны бессмысленно.
// Кадр рисуется ТОЛЬКО по требованию (как и в основной сцене — см.
// requestRender3D, Docs/backlog.md): бесконечный requestAnimationFrame жёг
// батарею на полном простое.
const zonePreview3d = {
  renderer: null, scene: null, camera: null, controls: null, group: null, frame: null,
};

function zonePreviewRequestFrame() {
  if (!zonePreview3d.renderer || zonePreview3d.frame !== null) return;
  zonePreview3d.frame = requestAnimationFrame(() => {
    zonePreview3d.frame = null;
    zonePreview3d.renderer.render(zonePreview3d.scene, zonePreview3d.camera);
  });
}

async function ensureZonePreview3d() {
  await ensureThreeLoaded();
  if (zonePreview3d.renderer) return;
  const host = document.getElementById("zone-edit-preview3d");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(400, 300);
  renderer.setClearColor(0xf4f6f8, 1);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 400 / 300, 100, 5_000_000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; // иначе камера едет и после отпускания мыши, а кадр рисуется по требованию
  controls.addEventListener("change", zonePreviewRequestFrame);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(1, 2, 1);
  scene.add(dir);
  Object.assign(zonePreview3d, { renderer, scene, camera, controls, group: null });
}

// Координаты: world.X = dxf.x, world.Z = -dxf.y — ТОТ ЖЕ порядок, что в
// основной сцене (на знаке Z там однажды уже поймали зеркальность, см.
// Docs/backlog.md). Высота — реальные отметки ярусов в мм.
function zonePreviewShape(outline) {
  return new THREE.Shape(outline.map(p => new THREE.Vector2(p[0], p[1])));
}

// Зазор между соприкасающимися плоскостями предпросмотра, мм. У соседних
// ярусов верх одного и низ другого — одна и та же плоскость, и без зазора
// они борются в буфере глубины (мерцание полосами при вращении). 60 мм на
// модели в десятки метров глазом не видны.
const PREVIEW_PLANE_GAP_MM = 60;

// Подпись-номер точки в 3D: спрайт с канвасом, как постоянные подписи марок
// в основной сцене (build3DLabelSprite) — отдельной инфраструктуры для
// текста в WebGL нет. Размер задаётся в мировых мм, чтобы номер не «плавал»
// относительно зоны при зуме.
function zonePreviewNumberSprite(text, active, screenSize) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = active ? "#d68910" : "#2471a3";
  ctx.beginPath();
  ctx.arc(32, 32, active ? 30 : 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${active ? 34 : 28}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
    // sizeAttenuation:false — размер в ЭКРАННЫХ единицах, не в мировых мм.
    // Первая версия задавала размер от габарита зоны (стоянка ~37 м), но
    // камера кадрирует весь объект (~227 м), и номера выходили нечитаемо
    // мелкими. Постоянный экранный размер — то же решение, что у минимального
    // кегля подписи марки в 2D (MIN_LABEL_FONT_PX).
    sizeAttenuation: false,
  }));
  sprite.scale.set(screenSize, screenSize, 1);
  return sprite;
}

function rebuildZonePreview3d() {
  if (!zonePreview3d.renderer || !zoneEdit) return;
  const { scene } = zonePreview3d;
  if (zonePreview3d.group) {
    scene.remove(zonePreview3d.group);
    zonePreview3d.group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }
  const group = new THREE.Group();
  // План строится в ЛОКАЛЬНЫХ XY (x = dxf.x, y = dxf.y), высота — по
  // локальному Z. Поворот на -90° вокруг X переводит локальный +Z в мировой
  // «вверх», а локальный +Y — в мировой -Z, то есть world.Z = -dxf.y ровно
  // как в основной сцене. Дополнительного зеркалирования НЕ НУЖНО: раньше
  // здесь стоял group.scale.z = -1 в расчёте на разворот плана, а он на
  // самом деле инвертировал ВЫСОТУ — ярусы уходили вниз, и объём выглядел
  // перевёрнутым (живой репорт со скриншотом).
  group.rotation.x = -Math.PI / 2;

  const bbox = zoneEdit.context.bbox;
  if (bbox) {
    // Подложка габаритов объекта — чтобы было видно, где зона относительно
    // всего проекта (это и есть смысл предпросмотра).
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(bbox[2] - bbox[0], bbox[3] - bbox[1]),
      new THREE.MeshBasicMaterial({
        color: 0x8899aa, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
        // Подложка уходит НИЖЕ нуля и дополнительно сдвинута в буфере
        // глубины: иначе она совпадает плоскость-в-плоскость с основанием
        // зоны на отметке 0, и при вращении основание мерцало полосами
        // (второй живой репорт по этому предпросмотру).
        polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4,
      }),
    );
    plate.position.set((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, -PREVIEW_PLANE_GAP_MM);
    group.add(plate);
  }

  // Соседние зоны — КОНТУРАМИ, а не заливками. Заливок здесь под 250, все
  // прозрачные и лежат почти на одной высоте: сортировка прозрачных
  // поверхностей на каждом кадре меняла порядок, и при вращении заливка
  // мерцала полосами (живой репорт со скриншотом). Контуры этой проблемы не
  // имеют вовсе, а как контекст читаются даже лучше — видно границы, а не
  // мутное пятно.
  for (const sib of zoneEdit.context.siblings) {
    group.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        // + зазор: на отметке 0 контур иначе лежит ровно в плоскости
        // подложки габаритов и тоже мерцает.
        sib.outline.map(p => new THREE.Vector3(p[0], p[1], (sib.elevation_mm || 0) + PREVIEW_PLANE_GAP_MM))),
      new THREE.LineBasicMaterial({ color: 0x99a3ad, transparent: true, opacity: 0.5 }),
    ));
  }
  for (const level of zoneEdit.context.parent) {
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        level.outline.map(p => new THREE.Vector3(p[0], p[1], (level.elevation_mm || 0) + 10))),
      new THREE.LineBasicMaterial({ color: 0xc0392b }),
    );
    group.add(line);
  }

  // Правимая зона — объёмом: от отметки яруса до следующего по высоте, у
  // верхнего — условная высота яруса. Так видно именно «объёмную область», о
  // которой и шла речь в задаче, а не плоский контур.
  const elevations = zoneEdit.levels
    .map(l => (l.elevation_mm === null || l.elevation_mm === undefined ? 0 : l.elevation_mm))
    .sort((a, b) => a - b);
  const fallbackHeight = Math.max(
    3000, elevations.length > 1 ? (elevations[elevations.length - 1] - elevations[0]) / elevations.length : 3000);
  zoneEdit.levels.forEach((level, li) => {
    const base = level.elevation_mm === null || level.elevation_mm === undefined ? 0 : level.elevation_mm;
    const above = elevations.find(e => e > base);
    const height = Math.max((above === undefined ? base + fallbackHeight : above) - base, 200);
    const active = li === zoneEdit.active.level;
    const mesh = new THREE.Mesh(
      // Высота на зазор меньше: верх этого яруса иначе совпадает с низом
      // следующего плоскость-в-плоскость, и стык мерцает при вращении.
      new THREE.ExtrudeGeometry(zonePreviewShape(level.outline),
        { depth: Math.max(height - PREVIEW_PLANE_GAP_MM, 100), bevelEnabled: false, steps: 1 }),
      new THREE.MeshStandardMaterial({
        color: active ? 0x2471a3 : 0x7fa8c9, transparent: true,
        opacity: active ? 0.45 : 0.18, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    mesh.position.z = base;
    group.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: active ? 0x1b4f72 : 0x9fb8cd }),
    );
    edges.position.z = base;
    group.add(edges);

    // Номера точек — только у АКТИВНОГО яруса (на всех сразу это каша из
    // сотен подписей), нумерация совпадает с таблицей слева, текущая
    // правимая точка выделена цветом и размером, как в 2D.
    if (active) {
      // Доля высоты вьюпорта. Канвас предпросмотра всего 300 px высотой,
      // поэтому 3,5% (первая версия) давали ~10 px — цифру не разобрать.
      const screenSize = 0.062;
      level.outline.forEach((p, pi) => {
        const current = pi === zoneEdit.active.point;
        const sprite = zonePreviewNumberSprite(
          String(pi + 1), current, current ? screenSize * 1.45 : screenSize);
        sprite.position.set(p[0], p[1], base + Math.max(height - PREVIEW_PLANE_GAP_MM, 100));
        group.add(sprite);
      });
    }
  });

  scene.add(group);
  zonePreview3d.group = group;

  // Камера ставится один раз на открытие формы — дальше пользователь крутит
  // сам, и переставлять её на каждую правку точки было бы дёрганьем.
  if (!zonePreview3d.framed) {
    const cx = bbox ? (bbox[0] + bbox[2]) / 2 : 0;
    const cy = bbox ? (bbox[1] + bbox[3]) / 2 : 0;
    const span = bbox ? Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) : 100000;
    zonePreview3d.controls.target.set(cx, 0, -cy);
    zonePreview3d.camera.position.set(cx - span * 0.55, span * 0.55, -cy + span * 0.75);
    zonePreview3d.controls.update();
    zonePreview3d.framed = true;
  }
  zonePreviewRequestFrame();
}

async function setZonePreviewMode(mode) {
  const is3d = mode === "3d";
  document.getElementById("zone-edit-preview").style.display = is3d ? "none" : "";
  document.getElementById("zone-edit-preview3d").style.display = is3d ? "" : "none";
  document.getElementById("zone-preview-2d").className = `btn btn-sm ${is3d ? "btn-secondary" : "btn-primary"}`;
  document.getElementById("zone-preview-3d").className = `btn btn-sm ${is3d ? "btn-primary" : "btn-secondary"}`;
  zonePreviewMode = mode;
  if (is3d) {
    await ensureZonePreview3d();
    rebuildZonePreview3d();
  }
}

let zonePreviewMode = "2d";
document.getElementById("zone-preview-2d").addEventListener("click", () => setZonePreviewMode("2d"));
document.getElementById("zone-preview-3d").addEventListener("click", () => setZonePreviewMode("3d"));

document.getElementById("zone-edit-cancel").addEventListener("click", () => {
  zoneEditBackdrop.classList.remove("open");
  zoneEdit = null;
});

document.getElementById("zone-edit-save").addEventListener("click", async () => {
  if (!zoneEdit) return;
  const statusBox = document.getElementById("zone-edit-status");
  statusBox.textContent = "Сохранение…";
  statusBox.style.color = "var(--color-text-muted)";
  const numberRaw = document.getElementById("zone-edit-number").value;
  const craneRaw = document.getElementById("zone-edit-crane").value;
  try {
    const res = await api(`/zones/${zoneEdit.zone.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: numberRaw === "" ? null : Number(numberRaw),
        name: document.getElementById("zone-edit-name").value || null,
        parent_zone_id: zoneEdit.zone.category === "Стоянка" && craneRaw ? Number(craneRaw) : null,
        levels: zoneEdit.levels.map(l => ({
          id: l.id, elevation_mm: l.elevation_mm, outline: l.outline,
        })),
      }),
    });
    zoneEditBackdrop.classList.remove("open");
    zoneEdit = null;
    // Пересчёт привязки выполняется сразу при сохранении (решение З11).
    // Сообщаем ЧИСЛО затронутых элементов: правка одной точки может увести
    // сотни элементов в другую зону, и это надо видеть.
    lastZoneEdit = { zoneId: res.id, recalculated: res.recalculated || 0 };
    if (res.recalc_refused) {
      showToast(`Зона сохранена, но привязка не пересчитана: ${res.recalc_refused}`, "warning");
    } else {
      showToast(
        `Зона сохранена. Пересчитана привязка ${res.recalculated} ` +
        `${res.recalculated === 1 ? "элемента" : "элементов"}. Правку можно отменить в справочнике.`,
        "info"
      );
    }
    await renderZonesModal();
    if (state.sourceFile) await loadPlan(true);
  } catch (e) {
    statusBox.style.color = "var(--color-danger)";
    statusBox.textContent = e.message || "Не удалось сохранить";
  }
});

function openZonesModal(category) {
  zonesCategory = category;
  zonesBackdrop.classList.add("open");
  renderZonesModal();
}

document.getElementById("menu-zones-zakhvatka").addEventListener("click", () => openZonesModal("Захватка"));
document.getElementById("menu-zones-crane").addEventListener("click", () => openZonesModal("Кран"));
document.getElementById("menu-zones-stance").addEventListener("click", () => openZonesModal("Стоянка"));
document.getElementById("zones-close").addEventListener("click", () => zonesBackdrop.classList.remove("open"));

// Откат последней правки зоны — целиком: реквизиты, ярусы И привязки
// элементов, которые изменил пересчёт (решение З12: «все изменения, которые
// задевает изменение точки, должны откатываться»).
document.getElementById("zones-undo").addEventListener("click", async () => {
  if (!lastZoneEdit) return;
  if (!confirm("Отменить последнюю правку зоны? Вернутся и координаты точек, и привязка элементов.")) return;
  try {
    const res = await api(`/zones/${lastZoneEdit.zoneId}/undo`, { method: "POST" });
    showToast(`Правка отменена: ярусов ${res.levels}, привязок восстановлено ${res.elements}.`, "info");
    lastZoneEdit = null;
    await renderZonesModal();
    if (state.sourceFile) await loadPlan(true);
  } catch (e) {
    showToast("Не удалось отменить: " + e.message, "warning");
  }
});
document.getElementById("zones-include-retired").addEventListener("change", renderZonesModal);

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

// ---------- Контрагенты / Договоры / Спецификации (см. Docs/backlog.md,
// "Контрактация 2.0") ----------
const counterpartiesBackdrop = document.getElementById("counterparties-backdrop");
const counterpartyEditBackdrop = document.getElementById("counterparty-edit-backdrop");
let editingCounterpartyId = null;

async function renderCounterpartiesList() {
  const list = await api("/counterparties");
  const box = document.getElementById("counterparties-list");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="hint-text">нет контрагентов</div>'; return; }
  for (const cp of list) {
    const block = document.createElement("div");
    block.className = "contract-block";
    block.innerHTML = `
      <div class="contract-block-header">
        <b>${escapeHtml(cp.short_name)}</b>
        <span class="hint-text">${escapeHtml(cp.full_name)}${cp.inn ? " · ИНН " + escapeHtml(cp.inn) : ""}${cp.code ? " · код " + escapeHtml(cp.code) : ""}</span>
        <button class="btn btn-sm btn-secondary" data-edit-counterparty="${cp.id}">Изменить</button>
      </div>
    `;
    box.appendChild(block);
    block.querySelector("[data-edit-counterparty]").addEventListener("click", () => openCounterpartyEdit(cp));
  }
}

document.getElementById("menu-counterparties").addEventListener("click", async () => {
  counterpartiesBackdrop.classList.add("open");
  await renderCounterpartiesList();
});
document.getElementById("counterparties-close").addEventListener("click", () => counterpartiesBackdrop.classList.remove("open"));
document.getElementById("counterparties-add").addEventListener("click", () => openCounterpartyEdit(null));

async function renderCounterpartyAgreements() {
  const box = document.getElementById("cpe-agreements-list");
  box.innerHTML = "Загрузка…";
  const agreements = await api(`/agreements?counterparty_id=${editingCounterpartyId}`);
  box.innerHTML = "";
  if (!agreements.length) box.innerHTML = '<div class="hint-text">нет договоров</div>';
  for (const a of agreements) {
    const row = document.createElement("div");
    row.className = "contract-block";
    row.innerHTML = `
      <div class="contract-block-header">
        <button type="button" class="hyperlink cpe-edit-agreement"><b>${escapeHtml(a.number)}</b><span class="hint-text">${a.agreement_date ? " от " + formatDateRu(a.agreement_date) : ""}</span></button>
      </div>
      <div class="cpe-specs-list"></div>
      <div class="row" style="gap:6px; margin-top:6px;">
        <input type="text" class="cpe-new-spec-number" placeholder="номер спецификации" style="flex:1;"/>
        <input type="date" class="cpe-new-spec-date"/>
        <button class="btn btn-sm btn-secondary cpe-add-spec" type="button">+ Спецификация</button>
      </div>
    `;
    box.appendChild(row);

    // Редактирование договора — тот же приём, что и у формы контрагента:
    // заменяем статичную шапку на инпуты, "Отмена" — просто перерисовка
    // всего списка (без ручного отслеживания "исходного" состояния).
    row.querySelector(".cpe-edit-agreement").addEventListener("click", () => {
      const header = row.querySelector(".contract-block-header");
      // .contract-block-header — flex-строка с justify-content:space-between
      // (нормально для статичного вида "текст + кнопка"), но с 4 полями
      // редактирования сжимала бы текстовый инпут почти до нуля — форма
      // редактирования получает свой собственный блочный контейнер, не
      // наследует flex-row родителя.
      header.style.display = "block";
      header.innerHTML = `
        <div class="row" style="gap:6px;">
          <input type="text" class="cpe-edit-agreement-number" value="${escapeHtml(a.number)}" style="flex:1; min-width:0;"/>
          <input type="date" class="cpe-edit-agreement-date" value="${a.agreement_date || ""}"/>
        </div>
        <div class="row" style="gap:6px; margin-top:6px;">
          <button class="btn btn-sm btn-primary cpe-save-agreement" type="button">Сохранить</button>
          <button class="btn btn-sm btn-secondary cpe-cancel-agreement" type="button">Отмена</button>
        </div>
      `;
      header.querySelector(".cpe-cancel-agreement").addEventListener("click", renderCounterpartyAgreements);
      header.querySelector(".cpe-save-agreement").addEventListener("click", async () => {
        const number = header.querySelector(".cpe-edit-agreement-number").value.trim();
        if (!number) return;
        const date = header.querySelector(".cpe-edit-agreement-date").value || null;
        await api(`/agreements/${a.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ counterparty_id: editingCounterpartyId, number, agreement_date: date }),
        });
        await renderCounterpartyAgreements();
      });
    });

    const specsBox = row.querySelector(".cpe-specs-list");
    const specs = await api(`/specifications?agreement_id=${a.id}`);
    if (!specs.length) {
      specsBox.innerHTML = '<div class="hint-text">нет спецификаций</div>';
    } else {
      specsBox.innerHTML = "";
      for (const s of specs) {
        const specRow = document.createElement("div");
        specRow.className = "row";
        specRow.style.cssText = "gap:6px; align-items:center; margin-top:2px;";
        specRow.innerHTML = `
          <button type="button" class="hyperlink cpe-edit-spec" style="flex:1;">— ${escapeHtml(s.number)}${s.specification_date ? " от " + formatDateRu(s.specification_date) : ""}</button>
        `;
        specsBox.appendChild(specRow);
        specRow.querySelector(".cpe-edit-spec").addEventListener("click", () => {
          // .row — flex со space-between (см. CSS), с 4 полями сжало бы
          // текстовый инпут почти до нуля (тот же фикс, что у договора выше)
          // — переключаем сам specRow на block-раскладку для режима правки.
          specRow.style.display = "block";
          specRow.innerHTML = `
            <div class="row" style="gap:6px;">
              <input type="text" class="cpe-edit-spec-number" value="${escapeHtml(s.number)}" style="flex:1; min-width:0;"/>
              <input type="date" class="cpe-edit-spec-date" value="${s.specification_date || ""}"/>
            </div>
            <div class="row" style="gap:6px; margin-top:6px;">
              <button class="btn btn-sm btn-primary cpe-save-spec" type="button">Сохранить</button>
              <button class="btn btn-sm btn-secondary cpe-cancel-spec" type="button">Отмена</button>
            </div>
          `;
          specRow.querySelector(".cpe-cancel-spec").addEventListener("click", renderCounterpartyAgreements);
          specRow.querySelector(".cpe-save-spec").addEventListener("click", async () => {
            const number = specRow.querySelector(".cpe-edit-spec-number").value.trim();
            if (!number) return;
            const date = specRow.querySelector(".cpe-edit-spec-date").value || null;
            await api(`/specifications/${s.id}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agreement_id: a.id, number, specification_date: date }),
            });
            await renderCounterpartyAgreements();
          });
        });
      }
    }

    row.querySelector(".cpe-add-spec").addEventListener("click", async () => {
      const number = row.querySelector(".cpe-new-spec-number").value.trim();
      if (!number) return;
      const date = row.querySelector(".cpe-new-spec-date").value || null;
      await api("/specifications", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: a.id, number, specification_date: date }),
      });
      await renderCounterpartyAgreements();
    });
  }
}

document.getElementById("cpe-add-agreement").addEventListener("click", async () => {
  if (!editingCounterpartyId) return; // только у уже сохранённого контрагента
  const number = document.getElementById("cpe-new-agreement-number").value.trim();
  if (!number) return;
  const date = document.getElementById("cpe-new-agreement-date").value || null;
  await api("/agreements", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ counterparty_id: editingCounterpartyId, number, agreement_date: date }),
  });
  document.getElementById("cpe-new-agreement-number").value = "";
  document.getElementById("cpe-new-agreement-date").value = "";
  await renderCounterpartyAgreements();
});

async function openCounterpartyEdit(cp) {
  editingCounterpartyId = cp ? cp.id : null;
  document.getElementById("counterparty-edit-title").textContent = cp ? "Изменить контрагента" : "Новый контрагент";
  document.getElementById("cpe-full-name").value = cp ? cp.full_name : "";
  document.getElementById("cpe-short-name").value = cp ? cp.short_name : "";
  document.getElementById("cpe-inn").value = (cp && cp.inn) || "";
  document.getElementById("cpe-kpp").value = (cp && cp.kpp) || "";
  document.getElementById("cpe-ogrn").value = (cp && cp.ogrn) || "";
  document.getElementById("cpe-legal-address").value = (cp && cp.legal_address) || "";
  document.getElementById("cpe-contact-person").value = (cp && cp.contact_person) || "";
  document.getElementById("cpe-contact-phone").value = (cp && cp.contact_phone) || "";
  document.getElementById("cpe-code").value = (cp && cp.code) || "";
  document.getElementById("counterparty-edit-error").textContent = "";
  // Договоры/спецификации — только у уже существующего контрагента
  // (у нового ещё нет id, договор ссылается на counterparty_id).
  document.getElementById("counterparty-agreements-section").style.display = cp ? "" : "none";
  if (cp) await renderCounterpartyAgreements();
  counterpartyEditBackdrop.classList.add("open");
}
document.getElementById("counterparty-edit-cancel").addEventListener("click", () => counterpartyEditBackdrop.classList.remove("open"));
document.getElementById("counterparty-edit-save").addEventListener("click", async () => {
  const body = {
    full_name: document.getElementById("cpe-full-name").value.trim(),
    short_name: document.getElementById("cpe-short-name").value.trim(),
    inn: document.getElementById("cpe-inn").value.trim() || null,
    kpp: document.getElementById("cpe-kpp").value.trim() || null,
    ogrn: document.getElementById("cpe-ogrn").value.trim() || null,
    legal_address: document.getElementById("cpe-legal-address").value.trim() || null,
    contact_person: document.getElementById("cpe-contact-person").value.trim() || null,
    contact_phone: document.getElementById("cpe-contact-phone").value.trim() || null,
    code: document.getElementById("cpe-code").value.trim() || null,
  };
  if (!body.full_name || !body.short_name) {
    document.getElementById("counterparty-edit-error").textContent = "Укажите полное и краткое наименование";
    return;
  }
  try {
    if (editingCounterpartyId) {
      await api(`/counterparties/${editingCounterpartyId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      const created = await api("/counterparties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      editingCounterpartyId = created.id;
    }
    await renderCounterpartiesList();
    // Договоры доступны только после сохранения — перерисовываем форму,
    // не закрываем её, чтобы сразу можно было добавить первый договор.
    document.getElementById("counterparty-agreements-section").style.display = "";
    await renderCounterpartyAgreements();
  } catch (e) {
    document.getElementById("counterparty-edit-error").textContent = e.message;
  }
});

// ---------- справочник префиксов марок (см. Docs/backlog.md,
// "Контрактация 2.0" — эвристика "префикс -> тип", донастраиваемая
// администратором) ----------
const markTypePrefixesBackdrop = document.getElementById("mark-type-prefixes-backdrop");

async function renderMarkTypePrefixesList() {
  const list = await api("/mark-type-prefixes");
  const box = document.getElementById("mark-type-prefixes-list");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="hint-text">нет префиксов</div>'; return; }
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.cssText = "gap:6px; align-items:center; margin-bottom:4px;";
    row.innerHTML = `
      <span style="flex:1;"><b>${escapeHtml(item.prefix)}</b> → ${escapeHtml(item.element_type)}</span>
      <button class="btn btn-sm btn-secondary" data-remove-prefix="${escapeHtml(item.prefix)}">✕</button>
    `;
    box.appendChild(row);
    row.querySelector("[data-remove-prefix]").addEventListener("click", async () => {
      await api(`/mark-type-prefixes/${encodeURIComponent(item.prefix)}`, { method: "DELETE" });
      await renderMarkTypePrefixesList();
    });
  }
}
document.getElementById("menu-mark-prefixes").addEventListener("click", async () => {
  // Тот же приём, что уже используется для ce-known-types (форма
  // контракта) — известные типы элементов из текущей загрузки, а не
  // отдельная захардкоженная копия серверного словаря ZHBI_TYPES.
  document.getElementById("mtp-new-type").innerHTML =
    Object.keys(state.labelVisibility).map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  await renderMarkTypePrefixesList();
  markTypePrefixesBackdrop.classList.add("open");
});
document.getElementById("mark-type-prefixes-close").addEventListener("click", () => markTypePrefixesBackdrop.classList.remove("open"));
document.getElementById("mtp-add").addEventListener("click", async () => {
  const prefix = document.getElementById("mtp-new-prefix").value.trim();
  if (!prefix) return;
  const elementType = document.getElementById("mtp-new-type").value;
  await api("/mark-type-prefixes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix, element_type: elementType }),
  });
  document.getElementById("mtp-new-prefix").value = "";
  await renderMarkTypePrefixesList();
});

// ---------- порог опоздания поставки — серверная настройка, общая для
// всех менеджеров; влияет на цвет допстроки марки (subLabelClass) и
// всплывающей подсказки (computeTooltipDateRows) ----------
const infoPlateSettingsBackdrop = document.getElementById("info-plate-settings-backdrop");
document.getElementById("menu-info-plate-settings").addEventListener("click", async () => {
  document.getElementById("info-plate-settings-error").textContent = "";
  try {
    const settings = await api("/settings/info-plate");
    document.getElementById("ips-threshold").value = settings.late_threshold_days;
    infoPlateSettingsBackdrop.classList.add("open");
  } catch (e) {
    alert("Не удалось загрузить настройку: " + e.message);
  }
});
document.getElementById("info-plate-settings-cancel").addEventListener("click", () => infoPlateSettingsBackdrop.classList.remove("open"));
document.getElementById("info-plate-settings-save").addEventListener("click", async () => {
  const value = Number(document.getElementById("ips-threshold").value);
  try {
    const settings = await api("/settings/info-plate", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_threshold_days: value }),
    });
    state.lateThresholdDays = settings.late_threshold_days;
    infoPlateSettingsBackdrop.classList.remove("open");
    refreshSubLabelDeliveryColors();
  } catch (e) {
    document.getElementById("info-plate-settings-error").textContent = e.message;
  }
});

// ---------- импорт контрактации / графика МС Project (см.
// Docs/backlog.md, "Контрактация 2.0", п.2/6) ----------
const contractingImportBackdrop = document.getElementById("contracting-import-backdrop");
document.getElementById("menu-contracting-import").addEventListener("click", () => {
  document.getElementById("contracting-import-file").value = "";
  document.getElementById("contracting-import-status").textContent = "";
  contractingImportBackdrop.classList.add("open");
});
document.getElementById("contracting-import-cancel").addEventListener("click", () => contractingImportBackdrop.classList.remove("open"));
document.getElementById("contracting-import-submit").addEventListener("click", async () => {
  const file = document.getElementById("contracting-import-file").files[0];
  const statusEl = document.getElementById("contracting-import-status");
  if (!file) { statusEl.textContent = "Сначала выберите файл .xlsx"; statusEl.style.color = "var(--color-danger)"; return; }
  statusEl.textContent = "Импорт…"; statusEl.style.color = "var(--color-text-muted)";
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/import-contracting-xlsx", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      statusEl.textContent = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      statusEl.style.color = "var(--color-danger)";
      return;
    }
    let msg = `Готово: строк обработано ${body.rows_processed}, контрактов затронуто ${body.contracts_touched}, ` +
      `позиций создано ${body.lines_inserted}, обновлено ${body.lines_updated}.`;
    if (body.unresolved_type_marks.length) msg += ` Тип не определён для марок: ${body.unresolved_type_marks.slice(0, 10).join(", ")}${body.unresolved_type_marks.length > 10 ? "…" : ""}.`;
    if (body.date_warnings.length) msg += ` Предупреждения по датам: ${body.date_warnings.length}.`;
    statusEl.textContent = msg;
    statusEl.style.color = "var(--color-text-muted)";
    await loadPlan();
  } catch (e) {
    statusEl.textContent = "Не удалось связаться с сервером: " + e.message;
    statusEl.style.color = "var(--color-danger)";
  }
});

const scheduleImportBackdrop = document.getElementById("schedule-import-backdrop");
document.getElementById("menu-schedule-import").addEventListener("click", () => {
  document.getElementById("schedule-import-file").value = "";
  document.getElementById("schedule-import-status").textContent = "";
  scheduleImportBackdrop.classList.add("open");
});
document.getElementById("schedule-import-cancel").addEventListener("click", () => scheduleImportBackdrop.classList.remove("open"));
document.getElementById("schedule-import-submit").addEventListener("click", async () => {
  const file = document.getElementById("schedule-import-file").files[0];
  const statusEl = document.getElementById("schedule-import-status");
  if (!file) { statusEl.textContent = "Сначала выберите файл .xlsx"; statusEl.style.color = "var(--color-danger)"; return; }
  statusEl.textContent = "Импорт…"; statusEl.style.color = "var(--color-text-muted)";
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/import-schedule-xlsx", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      statusEl.textContent = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      statusEl.style.color = "var(--color-danger)";
      return;
    }
    let msg = `Готово: строк обработано ${body.rows_processed}, пропущено ${body.rows_skipped}, элементов обновлено ${body.elements_updated}.`;
    if (body.unmatched_blocks.length) msg += ` Блоков без совпадений: ${body.unmatched_blocks.length}.`;
    statusEl.textContent = msg;
    statusEl.style.color = "var(--color-text-muted)";
    await loadPlan();
  } catch (e) {
    statusEl.textContent = "Не удалось связаться с сервером: " + e.message;
    statusEl.style.color = "var(--color-danger)";
  }
});

// ---------- контракты (см. Docs/backlog.md, "Контрактация 2.0") ----------
const contractsBackdrop = document.getElementById("contracts-backdrop");
const contractEditBackdrop = document.getElementById("contract-edit-backdrop");
let editingContractId = null;
let editingContract = null; // полный объект (с .lines) — нужен вкладке "Развёрнуто" для остатка, см. renderContractExpandedView
let counterpartiesFullCache = null; // снимок GET /counterparties/full на время открытой формы контракта

async function renderContractsList() {
  const contracts = await api("/contracts");
  const box = document.getElementById("contracts-list");
  box.innerHTML = "";
  if (!contracts.length) { box.innerHTML = '<div class="hint-text">нет контрактов</div>'; return contracts; }
  // Плоская таблица — Контрагент/Договор/Спецификация (живой запрос
  // пользователя, см. Docs/backlog.md, "Контрактация 2.0"). "Изменить" —
  // та же форма, что и создание, предзаполненная текущим содержимым
  // (openContractEdit(c) уже поддерживает оба случая) — "Развёрнуто"
  // теперь вкладка ВНУТРИ этой формы (см. setCeView), не отдельная
  // модалка. "Позиции" — план/факт/повреждено/остаток по (тип, марка),
  // СВЁРНУТО по умолчанию — не занимает место, пока не нужна.
  const table = document.createElement("table");
  table.className = "contract-lines-table";
  table.innerHTML = `
    <tr><th>Контрагент</th><th>Договор</th><th>Спецификация</th><th>Тема</th><th></th></tr>
  `;
  for (const c of contracts) {
    const agreementText = c.agreement_date ? `${escapeHtml(c.agreement_number)} от ${formatDateRu(c.agreement_date)}` : escapeHtml(c.agreement_number);
    const specText = c.specification_date ? `${escapeHtml(c.specification_number)} от ${formatDateRu(c.specification_date)}` : escapeHtml(c.specification_number);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.counterparty_short_name)}</td>
      <td>${agreementText}</td>
      <td>${specText}</td>
      <td>${c.theme ? escapeHtml(c.theme) : "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-secondary" data-edit-contract="${c.id}">Изменить</button>
        <button class="btn btn-sm btn-secondary" data-toggle-lines="${c.id}">Позиции…</button>
      </td>
    `;
    tr.querySelector("[data-edit-contract]").addEventListener("click", () => openContractEdit(c));
    table.appendChild(tr);

    const linesRow = document.createElement("tr");
    linesRow.style.display = "none";
    const linesHtml = c.lines.length
      ? c.lines.map(l => `
          <tr class="${l.exceeded ? "exceeded" : ""}">
            <td>${escapeHtml(l.element_type || "тип не определён")}</td><td>${escapeHtml(l.mark || "—")}</td>
            <td>${l.quantity}</td><td>${l.fact}</td><td>${l.damaged}</td><td>${l.remaining}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="6" class="hint-text">нет строк</td></tr>';
    linesRow.innerHTML = `
      <td colspan="5">
        <table class="contract-lines-table">
          <tr><th>Тип элемента</th><th>Марка</th><th>План</th><th>Факт</th><th>Повреждено</th><th>Остаток</th></tr>
          ${linesHtml}
        </table>
      </td>
    `;
    table.appendChild(linesRow);
    const toggleBtn = tr.querySelector("[data-toggle-lines]");
    toggleBtn.addEventListener("click", () => {
      const open = linesRow.style.display !== "none";
      linesRow.style.display = open ? "none" : "table-row";
      toggleBtn.textContent = open ? "Позиции…" : "Скрыть позиции";
    });
  }
  box.appendChild(table);
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
      matching.map(c => `<option value="${c.id}" ${defaultMap[type] === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
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

// ---------- "Развёрнуто" — вкладка ВНУТРИ формы контракта (живой запрос
// пользователя, была отдельной модалкой по кнопке "Развернуть…", см.
// Docs/backlog.md), не отдельная модалка. Сначала — физические элементы
// схемы, УЖЕ привязанные к контракту (с указанием, к какому элементу
// схемы привязана позиция, его статусом и датами поставки), следом —
// строки контракта, ещё не выбранные полностью (остаток), одной строкой
// на позицию, не по штуке — при остатке в сотни штук сотни пустых строк
// были бы бесполезны. ----------
function setCeView(view) {
  document.querySelectorAll("#ce-view-toggle .view-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.ceView === view));
  document.getElementById("ce-view-main").style.display = view === "main" ? "" : "none";
  document.getElementById("ce-view-expanded").style.display = view === "expanded" ? "" : "none";
  if (view === "expanded") renderContractExpandedView();
}
document.querySelectorAll("#ce-view-toggle .view-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => setCeView(btn.dataset.ceView));
});

async function renderContractExpandedView() {
  const tbody = document.getElementById("contract-elements-tbody");
  document.getElementById("contract-elements-error").textContent = "";
  if (!editingContractId) {
    tbody.innerHTML = '<tr><td colspan="7" class="hint-text">Сначала сохраните контракт — развёрнутый вид доступен только для уже сохранённого</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="7" class="hint-text">Загрузка…</td></tr>';
  try {
    const rows = await api(`/contracts/${editingContractId}/elements`);
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>№${r.id}${r.mark ? " · " + escapeHtml(r.mark) : ""}</td>
        <td>${escapeHtml(r.element_type || "—")}</td>
        <td>${escapeHtml(r.mark || "—")}</td>
        <td>${escapeHtml(state.statusLabels[r.current_status] || r.current_status)}</td>
        <td>${r.project_delivery_date ? formatDateRu(r.project_delivery_date) : "—"}</td>
        <td><input type="date" class="ce-elem-planned-date" data-element-id="${r.id}" value="${r.planned_delivery_date || ""}"/></td>
        <td>${r.actual_delivery_date ? formatDateRu(r.actual_delivery_date) : "—"}</td>
      `;
      tbody.appendChild(tr);
    }
    // Остаток — строки контракта, ещё не выбранные полностью физическими
    // элементами схемы (та же цифра, что и в "Позиции…" в списке контрактов).
    if (editingContract) {
      for (const l of editingContract.lines) {
        if (l.remaining <= 0) continue;
        const tr = document.createElement("tr");
        tr.className = "hint-text";
        tr.innerHTML = `
          <td>—</td>
          <td>${escapeHtml(l.element_type || "тип не определён")}</td>
          <td>${escapeHtml(l.mark || "—")}</td>
          <td colspan="4">без привязки к элементу схемы · остаток ${l.remaining} шт.</td>
        `;
        tbody.appendChild(tr);
      }
    }
    if (!tbody.children.length) tbody.innerHTML = '<tr><td colspan="7" class="hint-text">нет элементов</td></tr>';
    tbody.querySelectorAll(".ce-elem-planned-date").forEach(input => {
      // Пишет сразу по change, без отдельной кнопки "Сохранить" — тот же
      // приём, что уже работает у renderDefaultContracts выше.
      input.addEventListener("change", async () => {
        try {
          const updated = await api(`/elements/${input.dataset.elementId}/planned-delivery-date`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planned_delivery_date: input.value || null }),
          });
          const existing = state.byId.get(updated.id);
          if (existing) { Object.assign(existing, updated); updateElementSubLabel(existing); }
        } catch (e) {
          document.getElementById("contract-elements-error").textContent = "Не удалось сохранить дату: " + e.message;
        }
      });
    });
  } catch (e) {
    tbody.innerHTML = "";
    document.getElementById("contract-elements-error").textContent = e.message;
  }
}

// ---------- редактирование контракта: динамический список строк тип+марка+количество
// (см. Docs/backlog.md, "Контрактация 2.0" — марка добавлена к типу) ----------
function addContractLineRow(elementType, mark, quantity) {
  const container = document.getElementById("ce-lines");
  const row = document.createElement("div");
  row.className = "ce-line-row";
  row.innerHTML = `
    <input type="text" class="ce-line-type" list="ce-known-types" placeholder="тип элемента" value="${escapeHtml(elementType || "")}"/>
    <input type="text" class="ce-line-mark" list="ce-known-marks" placeholder="марка (необязательно)" value="${escapeHtml(mark || "")}"/>
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

// Каскадные Контрагент -> Договор -> Спецификация (см. Docs/backlog.md,
// "Контрактация 2.0" — заменяет свободнотекстовое поле "Поставщик").
// counterpartiesFullCache — снимок GET /counterparties/full на время
// открытой формы, тот же приём, что buildTypeSubtypeMarkMaps использовал
// для partии (state сканируется один раз при открытии, не на каждое
// изменение селекта).
function refreshAgreementSelect(selectedAgreementId) {
  const cp = counterpartiesFullCache.find(c => String(c.id) === document.getElementById("ce-counterparty").value);
  const agreements = cp ? cp.agreements : [];
  const agrSelect = document.getElementById("ce-agreement");
  agrSelect.innerHTML = agreements.map(a =>
    `<option value="${a.id}" ${String(a.id) === String(selectedAgreementId) ? "selected" : ""}>${escapeHtml(a.number)}${a.agreement_date ? " от " + formatDateRu(a.agreement_date) : ""}</option>`
  ).join("");
  refreshSpecificationSelect(agreements, undefined);
}
function refreshSpecificationSelect(agreements, selectedSpecificationId) {
  const agrSelect = document.getElementById("ce-agreement");
  const agr = agreements.find(a => String(a.id) === agrSelect.value);
  const specs = agr ? agr.specifications : [];
  const specSelect = document.getElementById("ce-specification");
  specSelect.innerHTML = specs.map(s =>
    `<option value="${s.id}" ${String(s.id) === String(selectedSpecificationId) ? "selected" : ""}>${escapeHtml(s.number)}${s.specification_date ? " от " + formatDateRu(s.specification_date) : ""}</option>`
  ).join("");
}
document.getElementById("ce-counterparty").addEventListener("change", () => { refreshAgreementSelect(); updateContractNamePreview(); });
document.getElementById("ce-agreement").addEventListener("change", () => {
  const cp = counterpartiesFullCache.find(c => String(c.id) === document.getElementById("ce-counterparty").value);
  refreshSpecificationSelect(cp ? cp.agreements : []);
  updateContractNamePreview();
});
document.getElementById("ce-specification").addEventListener("change", updateContractNamePreview);
document.getElementById("ce-theme").addEventListener("input", updateContractNamePreview);

// Наименование контракта — ВСЕГДА генерируется (build_contract_name,
// app/contracts.py), не вводится руками (живой запрос пользователя,
// 2026-07-28). Превью здесь — только для удобства (видно, что получится,
// до сохранения); авторитетное значение всегда приходит с бэкенда после
// сохранения (state.contracts из /plan-data) — та же формула, продублирована
// намеренно (простой однострочный шаблон, не бизнес-логика).
function buildContractNamePreviewText() {
  const cp = counterpartiesFullCache.find(c => String(c.id) === document.getElementById("ce-counterparty").value);
  if (!cp) return "";
  const agr = (cp.agreements || []).find(a => String(a.id) === document.getElementById("ce-agreement").value);
  if (!agr) return "";
  const spec = (agr.specifications || []).find(s => String(s.id) === document.getElementById("ce-specification").value);
  if (!spec) return "";
  const agreementText = agr.agreement_date ? `${agr.number} от ${formatDateRu(agr.agreement_date)}` : agr.number;
  const specText = spec.specification_date ? `${spec.number} от ${formatDateRu(spec.specification_date)}` : spec.number;
  const theme = document.getElementById("ce-theme").value.trim();
  let name = `${cp.short_name}/${agreementText}/${specText}`;
  if (theme) name += ` (${theme})`;
  return name;
}
function updateContractNamePreview() {
  document.getElementById("ce-name-preview").textContent = buildContractNamePreviewText() || "—";
}

async function openContractEdit(contract) {
  editingContractId = contract ? contract.id : null;
  editingContract = contract;
  setCeView("main");
  document.getElementById("contract-edit-title").textContent = contract ? "Изменить контракт" : "Новый контракт";
  document.getElementById("ce-theme").value = contract && contract.theme ? contract.theme : "";

  counterpartiesFullCache = await api("/counterparties/full");
  const cpSelect = document.getElementById("ce-counterparty");
  if (!counterpartiesFullCache.length) {
    document.getElementById("contract-edit-error").textContent = "Сначала добавьте хотя бы одного контрагента (Действия → Справочники → Контрагенты)";
  }
  cpSelect.innerHTML = counterpartiesFullCache.map(cp => `<option value="${cp.id}">${escapeHtml(cp.short_name)}</option>`).join("");
  if (contract) {
    cpSelect.value = String(contract.counterparty_id);
    refreshAgreementSelect(contract.agreement_id);
    document.getElementById("ce-agreement").value = String(contract.agreement_id);
    const cp = counterpartiesFullCache.find(c => String(c.id) === cpSelect.value);
    refreshSpecificationSelect(cp ? cp.agreements : [], contract.specification_id);
    document.getElementById("ce-specification").value = String(contract.specification_id);
  } else if (counterpartiesFullCache.length) {
    cpSelect.value = String(counterpartiesFullCache[0].id);
    refreshAgreementSelect();
  }
  updateContractNamePreview();

  // Известные типы элементов/марки после загрузки файла — подсказка
  // (datalist, не строгий список — ввести что-то нестандартное
  // по-прежнему можно, напр. марку, которой ещё нет на схеме), см.
  // Docs/backlog.md.
  document.getElementById("ce-known-types").innerHTML =
    Object.keys(state.labelVisibility).map(t => `<option value="${escapeHtml(t)}"></option>`).join("");
  const knownMarks = new Set(state.elements.map(e => e.mark).filter(Boolean));
  document.getElementById("ce-known-marks").innerHTML =
    Array.from(knownMarks).sort().map(m => `<option value="${escapeHtml(m)}"></option>`).join("");

  document.getElementById("ce-lines").innerHTML = "";
  if (contract && contract.lines.length) {
    for (const l of contract.lines) addContractLineRow(l.element_type, l.mark, l.quantity);
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
    element_type: row.querySelector(".ce-line-type").value.trim() || null,
    mark: row.querySelector(".ce-line-mark").value.trim() || null,
    quantity: Number(row.querySelector(".ce-line-qty").value || 0),
  })).filter(l => l.element_type || l.mark);
  const incidents = Array.from(document.querySelectorAll("#ce-incidents .ce-incident-row")).map(row => ({
    element_type: row.querySelector(".ce-incident-type").value.trim(),
    quantity: Number(row.querySelector(".ce-incident-qty").value || 0),
    incident_date: row.querySelector(".ce-incident-date").value,
    description: row.querySelector(".ce-incident-desc").value.trim() || null,
  })).filter(inc => inc.element_type && inc.incident_date);
  const specificationId = document.getElementById("ce-specification").value;
  if (!specificationId) {
    document.getElementById("contract-edit-error").textContent = "Выберите контрагента, договор и спецификацию";
    return;
  }
  const body = {
    specification_id: Number(specificationId),
    theme: document.getElementById("ce-theme").value.trim() || null,
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
    statusEl.textContent = `Готово: пользователей ${body.users_upserted}, цветов ${body.status_colors}, настроек подписей ${body.label_visibility}, настроек дат ${body.label_dates_visibility}.`;
    statusEl.style.color = "var(--color-text-muted)";
    await loadPlan();
  } catch (e) {
    statusEl.textContent = "Не удалось связаться с сервером: " + e.message;
    statusEl.style.color = "var(--color-danger)";
  }
});

// ---------- очистка истории статусов (только для тестирования) ----------
document.getElementById("menu-reset-history").addEventListener("click", async () => {
  document.getElementById("settings-menu").classList.remove("open");
  // Двойное предупреждение — действие затрагивает АБСОЛЮТНО ВСЕ элементы
  // во всех загруженных чертежах разом и необратимо через интерфейс (см.
  // Docs/backlog.md, живой запрос пользователя — функция именно "на
  // время тестирования", не для повседневного использования).
  if (!confirm(
    "Это удалит историю статусов у ВСЕХ элементов во ВСЕХ чертежах и вернёт " +
    "их в статус «Запланирован» (контракт и партия тоже снимутся). " +
    "Действие необратимо через интерфейс. Продолжить?"
  )) return;
  if (!confirm("Точно? Это затронет всю базу целиком, не только текущий чертёж.")) return;
  try {
    const result = await api("/admin/reset-status-history", { method: "POST" });
    showToast(`История сброшена у ${result.reset_count} элементов.`, "success");
    clearSelection();
    clearMultiSelection();
    await loadPlan();
  } catch (e) {
    showToast("Не удалось сбросить историю: " + e.message);
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
    let msg = `Готово: сопоставлено элементов ${body.matched_elements}, ` +
      `исправлено записей ${body.updated}, добавлено ${body.inserted}, ` +
      `пропущено дублей ${body.skipped_duplicate}, не найдено в этой БД ${body.unmatched_elements}.`;
    if (body.planned_shifted) msg += ` Записей «Запланирован» сдвинуто в начало истории: ${body.planned_shifted}.`;
    if (body.unpaired_existing) msg += ` В системе осталось событий, которых нет в файле: ${body.unpaired_existing} (не удалены).`;
    // Нераспознанная дата — опечатка в файле, а не рядовой пропуск: строка
    // молча не применилась, и об этом надо сказать с примерами.
    if (body.invalid_dates) {
      msg += ` Строк с нераспознанной датой (пропущены): ${body.invalid_dates}` +
        (body.invalid_date_examples && body.invalid_date_examples.length
          ? ` — ${body.invalid_date_examples.slice(0, 5).join("; ")}` : "") + ".";
    }
    if (body.unmatched_handles.length) msg += ` Примеры handle без совпадения: ${body.unmatched_handles.join(", ")}.`;
    setHistoryImportStatus(msg, false);
    await loadPlan();
  } catch (e) {
    setHistoryImportStatus("Не удалось связаться с сервером: " + e.message, true);
  } finally {
    historyImportSubmit.disabled = false;
  }
});

// ---------- восстановление статусов из выгрузки (авария БД) ----------
// Тот же backend (/import-history-xlsx), что и обычный импорт истории выше
// (app/history_import.py принимает и лист "История статусов", и "Статус на
// дату" — см. Docs/backlog.md, 2026-07-28), но mode ЖЁСТКО "replace", а не
// выбор пользователя: сразу после пересборки БД у каждого элемента уже есть
// свежая запись "Запланирован" с сегодняшней датой — "Дополнить" её не
// перекроет (она новее восстанавливаемых дат), только "Заменить" реально
// восстанавливает статус. Отдельный пункт меню вместо переиспользования
// диалога выше — чтобы не дать выбрать неработающий здесь режим.
const statusRestoreBackdrop = document.getElementById("status-restore-backdrop");
const statusRestoreFile = document.getElementById("status-restore-file");
const statusRestoreSubmit = document.getElementById("status-restore-submit");

function setStatusRestoreStatus(text, isError) {
  const elm = document.getElementById("status-restore-status");
  elm.textContent = text;
  elm.style.color = isError ? "var(--color-danger)" : "var(--color-text-muted)";
}

// ---------- карточка объекта (данные для отчёта «Динамика») ----------
const projectCardBackdrop = document.getElementById("project-card-backdrop");

// Списки редактируются как текст «по строке на пункт»: это привычнее
// таблицы с кнопками «добавить/удалить» для 3-5 коротких фраз, которые
// правят раз в день, и переживает копирование из письма целиком.
const linesToList = (v) => v.split("\n").map(s => s.trim()).filter(Boolean);
const listToLines = (a) => (a || []).join("\n");

document.getElementById("menu-project-card").addEventListener("click", async () => {
  projectCardBackdrop.classList.add("open");
  document.getElementById("pc-status").textContent = "";
  try {
    const c = await api("/settings/project-card");
    document.getElementById("pc-title").value = c.title || "";
    document.getElementById("pc-montage-deadline").value = c.montage_deadline || "";
    document.getElementById("pc-delivery-deadline").value = c.delivery_deadline || "";
    document.getElementById("pc-milestones").value =
      (c.milestones || []).map(m => `${m.label} | ${m.date}`).join("\n");
  } catch (e) {
    document.getElementById("pc-status").textContent = "Не удалось загрузить: " + e.message;
  }
});
document.getElementById("pc-cancel").addEventListener("click", () => projectCardBackdrop.classList.remove("open"));

document.getElementById("pc-save").addEventListener("click", async () => {
  const milestones = [];
  for (const line of linesToList(document.getElementById("pc-milestones").value)) {
    const [label, date] = line.split("|").map(s => s.trim());
    // Строку без даты молча не проглатываем: веха без даты не встанет на
    // график, и пользователь должен узнать об этом здесь, а не гадать потом.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      document.getElementById("pc-status").textContent =
        `Веха «${line}» — нужна дата в формате ГГГГ-ММ-ДД после знака «|»`;
      return;
    }
    milestones.push({ label, date });
  }
  try {
    await api("/settings/project-card", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: document.getElementById("pc-title").value.trim(),
        montage_deadline: document.getElementById("pc-montage-deadline").value || null,
        delivery_deadline: document.getElementById("pc-delivery-deadline").value || null,
        milestones,
      }),
    });
    projectCardBackdrop.classList.remove("open");
    showToast("Карточка объекта сохранена", "info");
    // Открытый отчёт «Динамика» сразу показывает новые данные.
    if (reportsBackdrop.classList.contains("open") && currentReport === "dynamics") loadReport();
  } catch (e) {
    document.getElementById("pc-status").textContent = "Не удалось сохранить: " + e.message;
  }
});


// ---------- редакции текстовых блоков отчёта (на дату) ----------
//
// Блоки меняются по ходу стройки, и отчёт за прошлую дату должен
// показывать то, что было актуально ТОГДА. Поэтому здесь не одно значение,
// а список редакций: отчёт берёт последнюю с датой не позже отчётной.
const reportNotesBackdrop = document.getElementById("report-notes-backdrop");
let rnRevisions = [];
let rnSelected = null;   // выбранная дата редакции; null — новая

function rnRenderList() {
  const box = document.getElementById("rn-list");
  if (!rnRevisions.length) {
    box.innerHTML = "<div class='hint-text' style='padding:8px 10px'>Редакций пока нет</div>";
    return;
  }
  box.innerHTML = rnRevisions.map(r => {
    const n = r.key_events.length + r.key_tasks.length + r.open_questions.length;
    return `<div class="rn-item${r.effective_date === rnSelected ? " active" : ""}" data-date="${r.effective_date}">
      ${formatDateRu(r.effective_date)}
      <div class="rn-meta">пунктов: ${n}${r.updated_by ? " · " + escapeHtml(r.updated_by) : ""}</div></div>`;
  }).join("");
}

function rnShow(date) {
  rnSelected = date;
  const r = rnRevisions.find(x => x.effective_date === date);
  document.getElementById("rn-date").value = date || new Date().toISOString().slice(0, 10);
  document.getElementById("rn-events").value = listToLines(r && r.key_events);
  document.getElementById("rn-tasks").value = listToLines(r && r.key_tasks);
  document.getElementById("rn-questions").value = listToLines(r && r.open_questions);
  document.getElementById("rn-delete").style.display = r ? "" : "none";
  document.getElementById("rn-status").textContent = "";
  rnRenderList();
}

async function rnLoad(selectDate) {
  const data = await api("/settings/report-notes");
  rnRevisions = data.revisions;
  // По умолчанию открываем самую свежую — с ней и работают чаще всего.
  rnShow(selectDate !== undefined ? selectDate : (rnRevisions[0] ? rnRevisions[0].effective_date : null));
}

async function openReportNotes(prefillDate) {
  reportNotesBackdrop.classList.add("open");
  try {
    await rnLoad();
    // Если открыли из отчёта на дату, для которой редакции ещё нет —
    // сразу предлагаем завести её на эту дату, а не искать вручную.
    if (prefillDate && !rnRevisions.some(r => r.effective_date === prefillDate)) {
      rnShow(null);
      document.getElementById("rn-date").value = prefillDate;
    }
  } catch (e) {
    document.getElementById("rn-status").textContent = "Не удалось загрузить: " + e.message;
  }
}

document.getElementById("menu-report-notes").addEventListener("click", () => openReportNotes());
document.getElementById("rn-close").addEventListener("click", () => reportNotesBackdrop.classList.remove("open"));
document.getElementById("rn-add").addEventListener("click", () => rnShow(null));
document.getElementById("rn-list").addEventListener("click", (e) => {
  const item = e.target.closest(".rn-item");
  if (item) rnShow(item.dataset.date);
});

document.getElementById("rn-save").addEventListener("click", async () => {
  const date = document.getElementById("rn-date").value;
  if (!date) { document.getElementById("rn-status").textContent = "Укажите дату, с которой действует редакция"; return; }
  try {
    const data = await api("/settings/report-notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        effective_date: date,
        key_events: linesToList(document.getElementById("rn-events").value),
        key_tasks: linesToList(document.getElementById("rn-tasks").value),
        open_questions: linesToList(document.getElementById("rn-questions").value),
      }),
    });
    rnRevisions = data.revisions;
    rnShow(date);
    document.getElementById("rn-status").textContent = "Сохранено";
    if (reportsBackdrop.classList.contains("open") && currentReport === "dynamics") loadReport();
  } catch (e) {
    document.getElementById("rn-status").textContent = "Не удалось сохранить: " + e.message;
  }
});

document.getElementById("rn-delete").addEventListener("click", async () => {
  if (!rnSelected) return;
  if (!confirm(`Удалить редакцию от ${formatDateRu(rnSelected)}?`)) return;
  try {
    await api(`/settings/report-notes/${rnSelected}`, { method: "DELETE" });
    await rnLoad();
    if (reportsBackdrop.classList.contains("open") && currentReport === "dynamics") loadReport();
  } catch (e) {
    document.getElementById("rn-status").textContent = "Не удалось удалить: " + e.message;
  }
});

// ==================== ОТЧЁТЫ (живой запрос 2026-07-29) ====================
//
// Одна форма на все отчёты: вид выбирается кнопками сверху, тело
// перерисовывается. Следующий отчёт добавляется записью в REPORTS и
// функцией отрисовки — без новой модалки и без дублирования кнопок
// «Печать / Excel / PDF».
//
// Данные считает СЕРВЕР (app/reports.py), хотя элементы уже лежат в
// браузере: тот же отчёт выгружается в XLSX и PDF, и если считать его в
// двух местах, числа на экране и в файле однажды разойдутся.
const reportsBackdrop = document.getElementById("reports-backdrop");

const REPORTS = {
  status: {
    title: "Статус монтажа изделий",
    endpoint: "/reports/status",
    render: renderTreeReport,
  },
  dynamics: {
    title: "Динамика монтажа и поставки ТМЦ",
    endpoint: "/reports/dynamics",
    render: renderDynamicsReport,
    needsDate: true,
  },
};
let currentReport = "status";
let reportData = null;
// Какие узлы свёрнуты. По умолчанию свёрнуто всё, кроме первой захватки —
// так же, как в исходной сводной таблице заказчика.
let reportCollapsed = new Set();

// Свёрнуто всё, кроме первой захватки — повторяет вид исходной сводной
// таблицы заказчика. Только у древовидных отчётов: у «Динамики» узлов нет.
function defaultCollapsedTree(data) {
  const collapsed = new Set();
  if (!data || !data.rows) return collapsed;
  data.rows.forEach((row, i) => {
    if (i > 0) collapsed.add(row.label);
    else (row.children || []).forEach((f, j) => { if (j > 0) collapsed.add(`${row.label}/${f.label}`); });
  });
  return collapsed;
}

function reportRequestBody() {
  const body = { source_file: state.sourceFile || null };
  if (document.getElementById("report-use-filter").checked) {
    body.element_ids = state.elements.filter(passesPlacementFilters).map(e => e.id);
  }
  if (REPORTS[currentReport].needsDate) {
    body.report_date = document.getElementById("report-date").value || null;
  }
  return body;
}

// collapsed/indent/tableAttr — параметры, а не константы: тот же отчёт
// рисуется и в форме, и на панели «Статус» (узкая колонка → меньший отступ
// уровня, своё состояние свёрнутости, свой класс таблицы).
function reportRowHtml(node, path, columns, collapsed, indent) {
  const свёрнут = collapsed.has(path);
  const есть_дети = node.children && node.children.length;
  const cells = columns.map(c => {
    const v = node.values[c.key];
    return `<td class="num">${v ? v : ""}</td>`;
  }).join("");
  const toggle = `<button class="report-toggle${есть_дети ? "" : " empty"}" data-path="${escapeHtml(path)}">${свёрнут ? "▸" : "▾"}</button>`;
  return `<tr class="lvl-${node.level}">
    <td style="padding-left:${indent + node.level * indent}px">${toggle}${escapeHtml(node.label)}</td>${cells}</tr>`;
}

function renderTreeReport(data, opts = {}) {
  const collapsed = opts.collapsed || reportCollapsed;
  const indent = opts.indent || 18;
  const tableAttr = opts.tableAttr || 'id="report-table"';
  const columns = data.columns;
  const parts = [`<table ${tableAttr}><thead><tr><th>${escapeHtml(data.root_label)}</th>` +
    columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join("") + "</tr></thead><tbody>"];

  const walk = (node, path) => {
    parts.push(reportRowHtml(node, path, columns, collapsed, indent));
    if (collapsed.has(path)) return; // потомки свёрнутого узла не рисуем вовсе
    for (const child of node.children || []) walk(child, `${path}/${child.label}`);
  };
  for (const row of data.rows) walk(row, row.label);

  const t = data.total;
  parts.push(`<tr class="total"><td>${escapeHtml(t.label)}</td>` +
    columns.map(c => `<td class="num">${t.values[c.key] || ""}</td>`).join("") + "</tr>");
  parts.push("</tbody></table>");
  return parts.join("");
}

// ---------- отчёт «Динамика»: график + таблицы + текстовые блоки ----------
//
// График рисуется своим кодом в SVG (решение пользователя), а не сторонней
// библиотекой: те же координаты потом повторяет reportlab в PDF, и никакой
// новый вендоринг не нужен.

const DYN_COLORS = {
  plan_smr: "#4A86C8",
  fact_delivery: "#E8703A",
  fact_montage: "#8C99A6",
};
// Порядок задаёт и порядок в легенде, и порядок отрисовки: факт поверх плана.
const DYN_SERIES = ["plan_smr", "fact_delivery", "fact_montage"];

function niceMax(value) {
  // Верх шкалы — «круглое» число над максимумом, иначе подписи оси
  // получаются вида 9422, 7537, 5651 и читаются плохо.
  if (value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / (pow / 2)) * (pow / 2);
}

function shortDate(iso) {
  const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const d = new Date(iso + "T00:00:00");
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
}

// compact — вариант для правой панели (~280 px): свои отбивки и размеры
// шрифта в единицах viewBox (виewBox почти совпадает с реальной шириной,
// иначе текст 11 px сжался бы до нечитаемых 3 px), без выносок вех и без
// легенды внутри SVG — легенда рисуется рядом обычным HTML.
function buildDynamicsChartSvg(data, width = 1000, height = 330, opts = {}) {
  const compact = !!opts.compact;
  const weeks = data.weeks;
  if (!weeks.length) return "<div class='hint-text'>Нет данных для графика</div>";
  const L = compact ? 30 : 52, R = compact ? 6 : 18, T = compact ? 8 : 46, B = compact ? 30 : 64;
  const fsAxis = compact ? 8 : 11;
  // null в ряду — «за отчётной датой факта нет» (см. build_dynamics_report):
  // такие точки не рисуются, кривая факта на отчётной дате обрывается.
  const seriesPoints = (key) => (data.series[key] || [])
    .map((v, i) => ({ v, i })).filter(p => p.v !== null && p.v !== undefined);
  const maxY = niceMax(Math.max(1, ...DYN_SERIES.flatMap(k => seriesPoints(k).map(p => p.v))));
  const x = i => L + (weeks.length === 1 ? 0 : i * (width - L - R) / (weeks.length - 1));
  const y = v => height - B - (v / maxY) * (height - T - B);

  const parts = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`];

  // Сетка и ось Y
  const gridLines = compact ? 4 : 5;
  for (let i = 0; i <= gridLines; i++) {
    const v = maxY * i / gridLines, yy = y(v);
    parts.push(`<line x1="${L}" y1="${yy}" x2="${width - R}" y2="${yy}" stroke="#E5E8EC" stroke-width="1"/>`);
    parts.push(`<text x="${L - (compact ? 4 : 8)}" y="${yy + 3}" font-size="${fsAxis}" fill="#8A94A0" text-anchor="end">${Math.round(v)}</text>`);
  }
  // Подписи недель: с прореживанием — иначе они налезают друг на друга.
  // На панели места хватает примерно на 5 подписей, в форме — на 18.
  const step = compact
    ? Math.max(1, Math.ceil(weeks.length / 5))
    : (weeks.length > 18 ? 2 : 1);
  const labelY = height - B + (compact ? 12 : 16);
  weeks.forEach((w, i) => {
    if (i % step) return;
    parts.push(`<text x="${x(i)}" y="${labelY}" font-size="${compact ? 8 : 10}" fill="#8A94A0" text-anchor="end"
      transform="rotate(-45 ${x(i)} ${labelY})">${shortDate(w)}</text>`);
  });

  // Линии
  for (const key of DYN_SERIES) {
    const points = seriesPoints(key);
    if (!points.some(p => p.v > 0)) continue;
    const d = points.map((p, n) => `${n ? "L" : "M"} ${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${DYN_COLORS[key]}" stroke-width="2.2" stroke-linejoin="round"/>`);
  }

  // Вехи: красная стрелка вниз к линии плана + выноска с датой
  const weekIndex = (iso) => {
    const target = iso.slice(0, 10);
    let best = 0;
    weeks.forEach((w, i) => { if (w <= target) best = i; });
    return best;
  };
  // На панели выноски не рисуем вовсе — текст на 280 px превратился бы в
  // мешанину; отчётная дата помечается одной тонкой вертикальной линией.
  const marks = compact
    ? []
    : [{ label: "Отчётная дата", date: data.report_date }]
      .concat((data.card.milestones || []).filter(m => m && m.date));
  if (compact) {
    const px = x(weekIndex(data.report_date));
    parts.push(`<line x1="${px}" y1="${T}" x2="${px}" y2="${height - B}" stroke="#C0392B" stroke-width="1" stroke-dasharray="3 3"/>`);
  }
  marks.forEach((m, n) => {
    const i = weekIndex(m.date);
    const px = x(i);
    const plan = (data.series.plan_smr || [])[i] || 0;
    const py = y(plan);
    // Выноски раскладываем на двух высотах через одну — иначе на близких
    // датах подписи накладываются друг на друга.
    const topY = 16 + (n % 2) * 16;
    parts.push(`<line x1="${px}" y1="${topY + 6}" x2="${px}" y2="${py - 6}" stroke="#C0392B" stroke-width="1.4"/>`);
    parts.push(`<path d="M ${px - 4} ${py - 10} L ${px} ${py - 2} L ${px + 4} ${py - 10} Z" fill="#C0392B"/>`);
    const text = m.date === data.report_date && !m.label.includes("Захват")
      ? m.label : `${m.label} ${formatDateRu(m.date)}`;
    const anchor = px > width * 0.75 ? "end" : (px < width * 0.2 ? "start" : "middle");
    parts.push(`<text x="${px}" y="${topY}" font-size="10.5" fill="#C0392B" text-anchor="${anchor}">${escapeHtml(text)}</text>`);
  });

  // Легенда (в compact её рисует HTML рядом — см. sideChartLegendHtml)
  let lx = L;
  for (const key of compact ? [] : DYN_SERIES) {
    parts.push(`<line x1="${lx}" y1="${height - 10}" x2="${lx + 22}" y2="${height - 10}" stroke="${DYN_COLORS[key]}" stroke-width="2.6"/>`);
    parts.push(`<text x="${lx + 28}" y="${height - 6}" font-size="11" fill="#4A5460">${escapeHtml(data.series_labels[key])}</text>`);
    lx += 34 + data.series_labels[key].length * 6.2;
  }
  parts.push("</svg>");
  return parts.join("");
}

function dynBlockTable(caption, block, note) {
  const dev = (v) => `<td class="${v < 0 ? "dyn-neg" : ""}">${v > 0 ? "+" + v : v}</td>`;
  return `<table>
    <caption>${escapeHtml(caption)}</caption>
    <tr><th rowspan="2">Всего в проекте</th><th colspan="3">Накопительно</th>
        <th colspan="3">На ${formatDateRu(block.date)}</th><th rowspan="2">%</th></tr>
    <tr><th>План</th><th>Факт</th><th>Отклонение</th><th>План</th><th>Факт</th><th>Отклонение</th></tr>
    <tr><td>${block.total}</td>
        <td>${block.cumulative.plan}</td><td>${block.cumulative.fact}</td>${dev(block.cumulative.deviation)}
        <td>${block.day.plan}</td><td>${block.day.fact}</td>${dev(block.day.deviation)}
        <td>${block.percent}%</td></tr>
  </table>${note ? `<div class="dyn-note">${escapeHtml(note)}</div>` : ""}`;
}

function dynList(cls, title, items) {
  const body = (items && items.length)
    ? `<ul>${items.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
    : `<div class="dyn-empty">не заполнено</div>`;
  // Кнопка правки прямо в блоке: искать форму в другом разделе меню, глядя
  // на пустой блок в отчёте, неудобно. Открывает редакцию на отчётную дату.
  return `<div class="dyn-box ${cls}"><h4>${escapeHtml(title)}
    <button type="button" class="dyn-edit" title="Изменить">✎</button></h4>${body}</div>`;
}

function renderDynamicsReport(data) {
  const card = data.card;
  const cov = data.plan_coverage;
  // Предупреждение о неполноте плана — обязательно и заметно: кривая по
  // части изделий внешне неотличима от полного плана и молча вводит в
  // заблуждение (см. разбор второго отчёта, Docs/backlog.md).
  const warns = [];
  if (cov.smr < cov.total) warns.push(`план СМР задан у ${cov.smr} изделий из ${cov.total}`);
  if (cov.delivery < cov.total) warns.push(`план поставки — у ${cov.delivery} из ${cov.total}`);

  const montage = { ...data.montage, date: data.report_date };
  const delivery = { ...data.delivery, date: data.report_date };

  return `
    <div class="dyn-head">
      <h3>Ежедневный отчёт за ${formatDateRu(data.report_date)}</h3>
      <div class="dyn-sub">${escapeHtml(data.subtitle)}</div>
      <div class="dyn-sub"><b>${escapeHtml(card.title || "— объект не заполнен —")}</b></div>
    </div>
    <div class="hint-text" style="text-align:center; margin-bottom:8px">
      ${card.notes_effective_date
        ? `События, задачи и вопросы — редакция от ${formatDateRu(card.notes_effective_date)}`
        : "События, задачи и вопросы на эту дату не заполнены"}
    </div>
    ${warns.length ? `<div class="dyn-warn">Внимание: ${escapeHtml(warns.join("; "))}. Кривая плана неполная.</div>` : ""}
    <div class="dyn-boxes">
      ${dynList("events", "Ключевые события", card.key_events)}
      ${dynList("tasks", "Ключевые задачи", card.key_tasks)}
    </div>
    <div class="dyn-chart">${buildDynamicsChartSvg(data)}</div>
    <div class="dyn-bottom">
      <div class="dyn-tables">
        ${dynBlockTable("Статус монтажа ЖБИ", montage,
          card.montage_deadline ? `* окончание монтажа изделий ${formatDateRu(card.montage_deadline)}` : "")}
        ${dynBlockTable("Статус поставки ЖБИ", delivery,
          card.delivery_deadline ? `** окончание поставки изделий ${formatDateRu(card.delivery_deadline)}` : "")}
      </div>
      <div style="flex:1">${dynList("questions", "Открытые вопросы", card.open_questions)}</div>
    </div>`;
}

async function loadReport() {
  const def = REPORTS[currentReport];
  document.getElementById("report-title").textContent = def.title;
  const statusLine = document.getElementById("report-status-line");
  statusLine.textContent = "Построение отчёта…";
  try {
    reportData = await api(def.endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reportRequestBody()),
    });
    reportCollapsed = defaultCollapsedTree(reportData);
    document.getElementById("report-body").innerHTML = def.render(reportData);
    statusLine.textContent = reportData.total
      ? `Всего изделий: ${reportData.total.values.total}`
      : `Отчётная дата: ${formatDateRu(reportData.report_date)}`;
    // Поле даты подставляем фактически применённой датой: сервер мог
    // подставить сегодняшнюю, если поле было пустым.
    if (def.needsDate && reportData.report_date) {
      document.getElementById("report-date").value = reportData.report_date;
    }
  } catch (e) {
    document.getElementById("report-body").innerHTML = "";
    statusLine.textContent = "Не удалось построить отчёт: " + e.message;
  }
}

function switchReport(key) {
  currentReport = key;
  [...document.querySelectorAll(".report-tab")].forEach(b => b.classList.toggle("active", b.dataset.report === key));
  document.getElementById("report-date-box").style.display = REPORTS[key].needsDate ? "" : "none";
  loadReport();
}

document.getElementById("report-tabs").addEventListener("click", (e) => {
  const key = e.target.dataset.report;
  if (!key || key === currentReport) return;
  switchReport(key);
});
document.getElementById("report-date").addEventListener("change", loadReport);

document.getElementById("report-body").addEventListener("click", (e) => {
  if (e.target.classList.contains("dyn-edit")) {
    openReportNotes(document.getElementById("report-date").value || null);
    return;
  }
  const path = e.target.dataset.path;
  if (path === undefined) return;
  if (reportCollapsed.has(path)) reportCollapsed.delete(path); else reportCollapsed.add(path);
  document.getElementById("report-body").innerHTML = REPORTS[currentReport].render(reportData);
});

document.getElementById("report-use-filter").addEventListener("change", loadReport);
document.getElementById("menu-report-status").addEventListener("click", () => {
  reportsBackdrop.classList.add("open");
  switchReport("status");
});
document.getElementById("menu-report-dynamics").addEventListener("click", () => {
  reportsBackdrop.classList.add("open");
  switchReport("dynamics");
});
document.getElementById("reports-close").addEventListener("click", () => reportsBackdrop.classList.remove("open"));
document.getElementById("report-print").addEventListener("click", () => window.print());

async function downloadReport(suffix, filename) {
  const res = await fetch(REPORTS[currentReport].endpoint + suffix, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reportRequestBody()),
  });
  if (!res.ok) { showToast("Не удалось выгрузить отчёт", "warning"); return; }
  // Скачивание через blob, а не переходом по ссылке: запрос POST (список id
  // может быть большим), обычной навигацией его не сделать.
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const reportFileName = (ext) => `${REPORTS[currentReport].title}.${ext}`;
document.getElementById("report-xlsx").addEventListener("click", () => downloadReport(".xlsx", reportFileName("xlsx")));
document.getElementById("report-pdf").addEventListener("click", () => downloadReport(".pdf", reportFileName("pdf")));

// ============ Те же отчёты на панели «Статус» (живой запрос 2026-07-30) ============
//
// Данные берутся у ТЕХ ЖЕ серверных эндпоинтов, что и форма «Действия →
// Отчёты» — числа на панели, в форме и в выгрузках не могут разойтись.
// Отличия только два: вёрстка под 320 px (см. .side-* в index.html) и то, что
// текущий фильтр схемы учитывается ВСЕГДА — панель отвечает на вопрос «что со
// тем, что я сейчас выбрал», а не «что по всему чертежу» (для второго есть
// форма с галочкой).
//
// Пересчёт — по факту изменения, но с задержкой: один клик по родителю в
// дереве фильтров меняет десятки значений, а тело запроса — список id (до
// 9422 на реальном файле). Без склейки это была бы очередь тяжёлых запросов.
const SIDE_REPORTS_DEBOUNCE_MS = 250;
let sideStatusData = null;
let sideDynData = null;
let sideStatusCollapsed = new Set();
let sideReportsDirty = true;
let sideReportsTimer = null;
let sideReportsRequestId = 0;

const statusTabActive = () => document.getElementById("tab-status").classList.contains("active");

function sideReportBody(withDate) {
  const body = {
    source_file: state.sourceFile || null,
    element_ids: state.elements.filter(passesPlacementFilters).map(e => e.id),
  };
  if (withDate) body.report_date = document.getElementById("side-dyn-date").value || null;
  return body;
}

// Вызывается из renderLegend: у легенды и у отчётов панели одни и те же
// исходные данные (отфильтрованные элементы + их статусы), значит и поводы
// пересчитаться одни и те же — отдельных хуков по всем местам смены статуса
// заводить не нужно.
function scheduleSidebarReports() {
  sideReportsDirty = true;
  // Скрытую панель не считаем вовсе: запрос не дешёвый, а пользователь его
  // результата не видит. При переходе на вкладку пересчёт сделает switchTab.
  if (!statusTabActive()) return;
  clearTimeout(sideReportsTimer);
  sideReportsTimer = setTimeout(loadSidebarReports, SIDE_REPORTS_DEBOUNCE_MS);
}

async function loadSidebarReports() {
  clearTimeout(sideReportsTimer);
  sideReportsTimer = null;
  const statusBody = document.getElementById("side-status-body");
  const dynBody = document.getElementById("side-dyn-body");
  if (!state.elements.length) {
    // Плана ещё нет (или все файлы выключены) — считать нечего.
    sideStatusData = sideDynData = null;
    statusBody.innerHTML = dynBody.innerHTML = '<div class="hint-text">нет данных</div>';
    document.getElementById("side-status-line").textContent = "";
    return;
  }
  sideReportsDirty = false;
  const my = ++sideReportsRequestId;
  if (!sideStatusData) statusBody.innerHTML = '<div class="hint-text">Построение…</div>';
  if (!sideDynData) dynBody.innerHTML = '<div class="hint-text">Построение…</div>';
  try {
    const post = (endpoint, withDate) => api(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sideReportBody(withDate)),
    });
    const [status, dyn] = await Promise.all([
      post("/reports/status", false),
      post("/reports/dynamics", true),
    ]);
    if (my !== sideReportsRequestId) return; // ответ на уже устаревший фильтр
    sideStatusData = status;
    sideDynData = dyn;
    sideStatusCollapsed = defaultCollapsedTree(status);
    renderSideStatusReport();
    renderSideDynamicsReport();
  } catch (e) {
    if (my !== sideReportsRequestId) return;
    // Данные прошлого расчёта здесь уже неактуальны (фильтр изменился) —
    // сбрасываем и подпись «Всего изделий», иначе она осталась бы от
    // прежнего фильтра и выглядела бы как настоящий результат.
    sideStatusData = sideDynData = null;
    statusBody.innerHTML = "";
    document.getElementById("side-status-line").textContent = "";
    dynBody.innerHTML = `<div class="error-text">Не удалось построить отчёты: ${escapeHtml(e.message)}</div>`;
  }
}

function renderSideStatusReport() {
  const data = sideStatusData;
  const body = document.getElementById("side-status-body");
  document.getElementById("side-status-line").textContent =
    data ? `Всего изделий: ${data.total.values.total}` : "";
  if (!data || !data.rows.length) {
    body.innerHTML = '<div class="hint-text">нет данных</div>';
    return;
  }
  // Колонок столько же, сколько в форме (все встретившиеся статусы +
  // «Остаток» + «В проекте») — сокращать состав нельзя, иначе сумма по
  // строке перестанет сходиться. Широкая часть уезжает в свой скролл, а
  // первая колонка липкая (тот же приём, что у легенды выше).
  body.innerHTML = `<div class="legend-table-wrap">${renderTreeReport(data, {
    collapsed: sideStatusCollapsed, indent: 8, tableAttr: 'class="side-table side-tree"',
  })}</div>`;
  const wrap = body.firstElementChild;
  requestAnimationFrame(() => {
    wrap.classList.toggle("scrollable", wrap.scrollWidth > wrap.clientWidth + 1);
  });
}

document.getElementById("side-status-body").addEventListener("click", (e) => {
  const path = e.target.dataset.path;
  if (path === undefined) return;
  if (sideStatusCollapsed.has(path)) sideStatusCollapsed.delete(path);
  else sideStatusCollapsed.add(path);
  renderSideStatusReport();
});

function sideChartLegendHtml(data) {
  return `<div class="side-chart-legend">${DYN_SERIES.map(k =>
    `<span><i style="background:${DYN_COLORS[k]}"></i>${escapeHtml(data.series_labels[k])}</span>`
  ).join("")}</div>`;
}

// Компактная замена широкой таблице отчёта: там «Накопительно» и «На дату»
// стоят рядом восемью колонками, здесь — двумя строками по три колонки,
// иначе на 280 px читаются только «...».
function sideDynBlock(title, block, dateIso) {
  const dev = (v) => `<td class="${v < 0 ? "dyn-neg" : ""}">${v > 0 ? "+" + v : v}</td>`;
  return `<div class="side-dyn-block">
    <h4>${escapeHtml(title)}<b>${block.percent}% (${block.cumulative.fact} из ${block.total})</b></h4>
    <table class="side-table side-dyn">
      <tr><th></th><th>План</th><th>Факт</th><th>Откл.</th></tr>
      <tr><td>Итого</td><td>${block.cumulative.plan}</td><td>${block.cumulative.fact}</td>${dev(block.cumulative.deviation)}</tr>
      <tr><td>${formatDateRu(dateIso)}</td><td>${block.day.plan}</td><td>${block.day.fact}</td>${dev(block.day.deviation)}</tr>
    </table>
  </div>`;
}

function sideNoteBox(title, items) {
  const body = (items && items.length)
    ? `<ul>${items.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
    : '<div class="dyn-empty">не заполнено</div>';
  return `<details><summary>${escapeHtml(title)}${items && items.length ? ` (${items.length})` : ""}</summary>${body}</details>`;
}

function renderSideDynamicsReport() {
  const data = sideDynData;
  const body = document.getElementById("side-dyn-body");
  if (!data) { body.innerHTML = ""; return; }
  // Дата — фактически применённая сервером (могла быть подставлена сегодняшняя).
  document.getElementById("side-dyn-date").value = data.report_date;
  const cov = data.plan_coverage;
  const warns = [];
  if (cov.smr < cov.total) warns.push(`СМР — у ${cov.smr} из ${cov.total}`);
  if (cov.delivery < cov.total) warns.push(`поставка — у ${cov.delivery} из ${cov.total}`);
  body.innerHTML = `
    <div class="side-chart">${buildDynamicsChartSvg(data, 280, 150, { compact: true })}</div>
    ${sideChartLegendHtml(data)}
    ${warns.length ? `<div class="side-dyn-warn">План задан не у всех изделий (${escapeHtml(warns.join("; "))}) — кривая плана неполная.</div>` : ""}
    ${sideDynBlock("Монтаж ЖБИ", data.montage, data.report_date)}
    ${sideDynBlock("Поставка ЖБИ", data.delivery, data.report_date)}
    <div class="side-dyn-notes">
      ${sideNoteBox("Ключевые события", data.card.key_events)}
      ${sideNoteBox("Ключевые задачи", data.card.key_tasks)}
      ${sideNoteBox("Открытые вопросы", data.card.open_questions)}
    </div>`;
}

document.getElementById("side-dyn-date").addEventListener("change", loadSidebarReports);

// «⤢» — тот же отчёт в полный размер. Галочку «учитывать фильтр» ставим:
// иначе форма показала бы другие числа, чем панель, с которой её открыли.
document.querySelectorAll(".side-report-open").forEach(btn => {
  btn.addEventListener("click", () => {
    document.getElementById("report-use-filter").checked = true;
    if (btn.dataset.report === "dynamics") {
      document.getElementById("report-date").value = document.getElementById("side-dyn-date").value;
    }
    reportsBackdrop.classList.add("open");
    switchReport(btn.dataset.report);
  });
});

// ---------- Резервные копии БД (живой запрос 2026-07-29, после инцидента
// с автоматической пересборкой базы — см. Docs/backlog.md) ----------
const backupsBackdrop = document.getElementById("backups-backdrop");

function formatBytes(n) {
  if (!n) return "";
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;
}

async function loadBackups() {
  const tbody = document.getElementById("backups-tbody");
  const status = document.getElementById("backups-status");
  status.textContent = "Загрузка списка…";
  try {
    const data = await api("/admin/backups");
    if (!data.backups.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint-text">Копий пока нет</td></tr>`;
      status.textContent = "";
      return;
    }
    tbody.innerHTML = data.backups.map(b => {
      const s = b.stats || {};
      const таблиц = Object.keys(s).length;
      // Показываем ключевые числа + сколько всего таблиц в копии: копия это
      // файл БД целиком, и полнота должна быть видна, а не подразумеваться.
      const содержимое = !таблиц ? "—"
        : `элементов ${s.elements ?? "—"}, история ${s.status_history ?? "—"}, `
          + `контрактов ${s.contracts ?? "—"}, пользователей ${s.users ?? "—"}`
          + `<br><span class="hint-text">всего таблиц: ${таблиц} (вся база целиком)</span>`;
      // Служебные копии приглушены: их много и создаются они сами, взгляд
      // должен цепляться за созданные человеком.
      const cls = b.kind === "manual" ? "" : ' class="backup-auto"';
      return `<tr${cls}>
        <td>${escapeHtml(b.created_at)}</td>
        <td>${escapeHtml(b.kind_label || b.kind)}</td>
        <td>${escapeHtml(b.user_name || "—")}</td>
        <td>${escapeHtml(b.comment || "")}</td>
        <td>${содержимое}</td>
        <td>${formatBytes(b.size_bytes)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-secondary" data-restore="${escapeHtml(b.name)}">Восстановить</button>
          <button class="btn btn-sm btn-secondary menu-item-danger" data-delete="${escapeHtml(b.name)}">Удалить</button>
        </td></tr>`;
    }).join("");
    status.textContent = `Всего копий: ${data.backups.length}`;
  } catch (e) {
    status.textContent = "Ошибка: " + e.message;
  }
}

document.getElementById("menu-backups").addEventListener("click", () => {
  backupsBackdrop.classList.add("open");
  loadBackups();
});
document.getElementById("backups-close").addEventListener("click", () => backupsBackdrop.classList.remove("open"));

document.getElementById("backup-create").addEventListener("click", async () => {
  const btn = document.getElementById("backup-create");
  const commentEl = document.getElementById("backup-comment");
  btn.disabled = true;
  document.getElementById("backups-status").textContent = "Создание копии…";
  try {
    const meta = await api("/admin/backups", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: commentEl.value.trim() || null }),
    });
    commentEl.value = "";
    showToast(`Копия создана: ${meta.name}`, "info");
    loadBackups();
  } catch (e) {
    document.getElementById("backups-status").textContent = "Не удалось создать копию: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("backups-tbody").addEventListener("click", async (e) => {
  const restore = e.target.dataset.restore;
  const del = e.target.dataset.delete;
  if (restore) {
    // Два подтверждения: восстановление заменяет ВСЮ базу целиком, это по
    // последствиям сравнимо с очисткой истории (там тоже два confirm).
    if (!confirm(`Восстановить базу из копии «${restore}»?\n\nТекущее состояние будет заменено полностью. Перед этим система автоматически снимет служебную копию.`)) return;
    if (!confirm("Точно восстановить? Все изменения, сделанные после этой копии, будут заменены её содержимым.")) return;
    document.getElementById("backups-status").textContent = "Восстановление…";
    try {
      const res = await api(`/admin/backups/${encodeURIComponent(restore)}/restore`, { method: "POST" });
      showToast(`Восстановлено из «${res.restored_from}». Служебная копия: ${res.safety_backup.name}`, "info");
      await loadSourceFiles();
      await loadPlan();
      loadBackups();
    } catch (err) {
      document.getElementById("backups-status").textContent = "Не удалось восстановить: " + err.message;
    }
    return;
  }
  if (del) {
    if (!confirm(`Удалить резервную копию «${del}»? Действие необратимо.`)) return;
    try {
      await api(`/admin/backups/${encodeURIComponent(del)}`, { method: "DELETE" });
      loadBackups();
    } catch (err) {
      showToast("Не удалось удалить: " + err.message, "warning");
    }
  }
});

// ---------- Журнал действий (живой запрос 2026-07-29) ----------
const activityBackdrop = document.getElementById("activity-backdrop");

// Журнал хранит время в UTC (app/activity._now — datetime.utcnow), а
// показывать его надо по местным часам пользователя. Живой репорт: после
// переименования объекта пользователь решил, что действие "не попало в
// логи" — событие было записано, но самая свежая строка стояла с временем
// на 3 часа раньше его собственных часов (Москва = UTC+3) и выглядела как
// давняя. Разбор строки — вручную, а не new Date(строка): формат
// "ГГГГ-ММ-ДД ЧЧ:ММ:СС.мс" без Z браузеры трактуют по-разному (кто как
// местное, кто как UTC).
function activityTimeLocal(at) {
  if (!at) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(at);
  if (!m) return at;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
         (m[7] ? `.${m[7].padStart(3, "0")}` : "");
}

// Обратное преобразование для границ поиска: пользователь выбирает даты по
// своему календарю, а сравнение идёт с UTC-строками в БД. Без этого поиск
// "за сегодня" терял бы первые часы суток (для UTC+3 — события с 00:00 до
// 03:00 местного времени).
function activityBoundToUtc(dateStr, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return dateStr;
  const d = endOfDay
    ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999)
    : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.` +
         String(d.getUTCMilliseconds()).padStart(3, "0");
}

// "system" — события, которые сделал не человек, а сам сервис: старт,
// применённые миграции схемы. Раньше они не писались вовсе, и в журнале
// были видны только действия пользователей (живой репорт 2026-07-30);
// показывать их как "сервер" рядом с действиями админа было бы неверно —
// у них нет автора.
const ACTIVITY_SOURCE_LABELS = { client: "браузер", server: "сервер", system: "система" };

function activityRowHtml(r) {
  const element = [r.element_type, r.subtype, r.mark].filter(Boolean).join(" / ");
  const label = v => (v && state.statusLabels[v]) || v || "";
  return `<tr>
    <td>${escapeHtml(activityTimeLocal(r.at))}</td>
    <td>${ACTIVITY_SOURCE_LABELS[r.source] || r.source || ""}</td>
    <td>${escapeHtml(r.user_name || "")}</td>
    <td>${escapeHtml(r.action)}</td>
    <td>${escapeHtml(element)}${r.entity_id ? ` <span class="hint-text">#${r.entity_id}</span>` : ""}</td>
    <td>${escapeHtml(label(r.old_value))}</td>
    <td>${escapeHtml(label(r.new_value))}</td>
    <td>${r.duration_ms === null || r.duration_ms === undefined ? "" : r.duration_ms}</td>
  </tr>`;
}

async function loadActivity() {
  const params = new URLSearchParams();
  const from = document.getElementById("activity-from").value;
  const to = document.getElementById("activity-to").value;
  const userId = document.getElementById("activity-user").value;
  const action = document.getElementById("activity-action").value;
  const text = document.getElementById("activity-text").value.trim();
  if (from) params.set("date_from", activityBoundToUtc(from, false));
  if (to) params.set("date_to", activityBoundToUtc(to, true));
  if (userId) params.set("user_id", userId);
  if (action) params.set("action", action);
  if (text) params.set("text", text);
  const summary = document.getElementById("activity-summary");
  summary.textContent = "Поиск…";
  try {
    const data = await api(`/activity?${params.toString()}`);
    document.getElementById("activity-tbody").innerHTML = data.rows.map(activityRowHtml).join("");
    summary.textContent = data.total > data.rows.length
      ? `Найдено ${data.total}, показаны первые ${data.rows.length}`
      : `Найдено ${data.total}`;
    // Список действий заполняем ФАКТИЧЕСКИ встретившимися, а не хардкодом:
    // набор действий будет расти, и забытый пункт в списке — это молча
    // недоступный фильтр.
    // Пересобираем список действий на КАЖДЫЙ поиск, сохраняя выбор: набор
    // действий растёт по ходу работы, а прежнее условие (заполнять только
    // если список пуст) означало, что новое действие не появится в фильтре
    // до перезагрузки страницы — то есть выглядит как "оно не пишется".
    const sel = document.getElementById("activity-action");
    const keep = sel.value;
    sel.innerHTML = ['<option value="">— любое —</option>']
      .concat(data.actions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)).join("");
    if (keep && data.actions.includes(keep)) sel.value = keep;
  } catch (e) {
    summary.textContent = "Ошибка: " + e.message;
  }
}

document.getElementById("menu-activity").addEventListener("click", async () => {
  activityBackdrop.classList.add("open");
  const userSel = document.getElementById("activity-user");
  if (userSel.options.length === 0) {
    try {
      const users = await api("/users");
      userSel.innerHTML = ['<option value="">— все —</option>'].concat(
        users.map(u => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`)).join("");
    } catch (e) {
      userSel.innerHTML = '<option value="">— все —</option>';
    }
  }
  loadActivity();
});
document.getElementById("activity-close").addEventListener("click", () => activityBackdrop.classList.remove("open"));
document.getElementById("activity-search").addEventListener("click", loadActivity);

document.getElementById("activity-cleanup").addEventListener("click", async () => {
  const before = document.getElementById("activity-cleanup-date").value;
  if (!before) { showToast("Укажите дату, раньше которой очищать", "warning"); return; }
  if (!confirm(`Удалить все записи журнала раньше ${formatDateRu(before)}? Действие необратимо.`)) return;
  try {
    const res = await api(`/activity/cleanup?before=${encodeURIComponent(before)}`, { method: "POST" });
    showToast(`Удалено записей: ${res.deleted}`, "info");
    loadActivity();
  } catch (e) {
    showToast("Не удалось очистить: " + e.message, "warning");
  }
});

// ---------- Загрузка из папки Input (пункт меню, живой запрос 2026-07-29:
// импорт при старте сервера убран, остаётся только явная команда) ----------
const importInputBackdrop = document.getElementById("import-input-backdrop");
const importInputSubmit = document.getElementById("import-input-submit");

document.getElementById("menu-import-input").addEventListener("click", async () => {
  const filesEl = document.getElementById("import-input-files");
  const warnEl = document.getElementById("import-input-warning");
  const reportEl = document.getElementById("import-input-report");
  reportEl.innerHTML = "";
  warnEl.textContent = "";
  filesEl.innerHTML = "<div class='hint-text'>Читаю папку…</div>";
  importInputSubmit.disabled = true;
  importInputBackdrop.classList.add("open");
  try {
    const data = await api("/admin/input-files");
    const rows = [];
    if (data.dxf.length) rows.push(`<b>Чертежи (.dxf):</b><br>${data.dxf.map(escapeHtml).join("<br>")}`);
    if (data.xlsx.length) rows.push(`<b>Таблицы (.xlsx):</b><br>${data.xlsx.map(escapeHtml).join("<br>")}`);
    filesEl.innerHTML = rows.length
      ? `<div class="hint-text">${rows.join("<br><br>")}</div>`
      : "<div class='hint-text'>Папка Input/ пуста — загружать нечего.</div>";
    // Предупреждение показываем ТОЛЬКО когда есть что перезаписывать —
    // пугать пустым предупреждением при пустой папке незачем.
    if (data.dxf.length) {
      warnEl.textContent = "Геометрия уже загруженных элементов этих чертежей будет "
        + "перезаписана. Статусы, история и привязка к контрактам хранятся отдельно "
        + "и не затрагиваются.";
    }
    importInputSubmit.disabled = !(data.dxf.length || data.xlsx.length);
  } catch (e) {
    filesEl.innerHTML = `<div class="error-text">Не удалось прочитать папку: ${escapeHtml(e.message)}</div>`;
  }
});
document.getElementById("import-input-cancel").addEventListener("click", () => importInputBackdrop.classList.remove("open"));

importInputSubmit.addEventListener("click", async () => {
  const reportEl = document.getElementById("import-input-report");
  importInputSubmit.disabled = true;
  reportEl.innerHTML = "<div class='hint-text'>Загрузка… это может занять до нескольких минут.</div>";
  try {
    const res = await api("/admin/import-input", { method: "POST" });
    reportEl.innerHTML = `<div class="hint-text"><b>Готово:</b><br>${res.report.map(escapeHtml).join("<br>")}</div>`;
    // Схема на экране показывает уже устаревшие данные — перечитываем и
    // список источников (мог появиться новый чертёж), и сам план.
    await loadSourceFiles();
    await loadPlan();
  } catch (e) {
    reportEl.innerHTML = `<div class="error-text">Ошибка импорта: ${escapeHtml(e.message)}</div>`;
  } finally {
    importInputSubmit.disabled = false;
  }
});

document.getElementById("menu-status-restore").addEventListener("click", () => {
  statusRestoreFile.value = "";
  setStatusRestoreStatus("", false);
  document.getElementById("status-restore-source").textContent = state.sourceFile || "(источник не выбран)";
  statusRestoreBackdrop.classList.add("open");
});
document.getElementById("status-restore-cancel").addEventListener("click", () => statusRestoreBackdrop.classList.remove("open"));

statusRestoreSubmit.addEventListener("click", async () => {
  const file = statusRestoreFile.files[0];
  if (!file) { setStatusRestoreStatus("Сначала выберите файл .xlsx", true); return; }
  if (!state.sourceFile) { setStatusRestoreStatus("Сначала выберите источник (чертёж) в тулбаре", true); return; }

  statusRestoreSubmit.disabled = true;
  setStatusRestoreStatus("Восстановление статусов…", false);

  const formData = new FormData();
  formData.append("file", file);
  formData.append("source_file", state.sourceFile);
  formData.append("mode", "replace");

  try {
    const res = await fetch("/import-history-xlsx", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setStatusRestoreStatus((body && body.detail) ? body.detail : `Ошибка ${res.status}`, true);
      return;
    }
    let msg = `Готово: сопоставлено элементов ${body.matched_elements}, восстановлено записей ${body.inserted}, ` +
      `не найдено в этой БД ${body.unmatched_elements}.`;
    if (body.invalid_dates) {
      msg += ` Строк с нераспознанной датой (пропущены): ${body.invalid_dates}` +
        (body.invalid_date_examples && body.invalid_date_examples.length
          ? ` — ${body.invalid_date_examples.slice(0, 5).join("; ")}` : "") + ".";
    }
    if (body.unmatched_handles.length) msg += ` Примеры handle без совпадения: ${body.unmatched_handles.join(", ")}.`;
    setStatusRestoreStatus(msg, false);
    await loadPlan();
  } catch (e) {
    setStatusRestoreStatus("Не удалось связаться с сервером: " + e.message, true);
  } finally {
    statusRestoreSubmit.disabled = false;
  }
});

// ---------- журнал версий ("?" в тулбаре, живой запрос пользователя) ----------
// Список — app/changelog.py (единственный источник данных, порядок уже
// от новой версии к старой — новую запись согласовывать с пользователем
// ПЕРЕД добавлением в тот файл, см. его собственный докстринг), сюда
// приходит уже готовым, фронтенд просто рендерит как есть, ни разу не
// пересортировывая. Кэшируется на время сеанса (state.changelog) — список
// не меняется, пока сервис не перезапустят с новой версией, повторный
// запрос при каждом открытии модалки не нужен.
document.getElementById("btn-changelog").addEventListener("click", async () => {
  const box = document.getElementById("changelog-list");
  const backdrop = document.getElementById("changelog-backdrop");
  if (!state.changelog) {
    box.innerHTML = '<div class="hint-text">Загрузка…</div>';
    backdrop.classList.add("open");
    try {
      state.changelog = await api("/changelog");
    } catch (e) {
      box.innerHTML = `<div class="error-text">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
      return;
    }
  } else {
    backdrop.classList.add("open");
  }
  box.innerHTML = state.changelog.map(entry => `
    <div class="changelog-entry">
      <div class="changelog-eyebrow">
        <span class="changelog-version">v${escapeHtml(entry.version)}</span>
        <span class="changelog-date">${escapeHtml(entry.date)}</span>
      </div>
      <h3>${escapeHtml(entry.title)}</h3>
      <ul>${entry.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `).join("");
});
document.getElementById("changelog-close").addEventListener("click", () => {
  document.getElementById("changelog-backdrop").classList.remove("open");
});

// ---------- экспорт XLS ----------
// "Учитывать текущий фильтр" (живой запрос пользователя, см.
// Docs/backlog.md) — фильтры (passesPlacementFilters) целиком считаются
// на клиенте, пересчитывать их на бэкенде было бы дублированием логики;
// вместо этого при отмеченном чекбоксе шлём уже готовый список id
// element_ids, потенциально тысячи штук — не помещается в query string
// GET-запроса, поэтому /export.xlsx теперь POST с JSON-телом и скачивание
// через blob, а не window.location.href (тот же паттерн, что уже есть у
// экспорта настроек — только там payload маленький, GET годился).
const exportBackdrop = document.getElementById("export-backdrop");

function updateExportFilterCount() {
  const el = document.getElementById("export-filter-count");
  if (!document.getElementById("export-use-filter").checked) { el.textContent = ""; return; }
  const count = state.elements.filter(passesPlacementFilters).length;
  el.textContent = `Сейчас проходит фильтр: ${count} из ${state.elements.length} элементов.`;
}
document.getElementById("btn-export").addEventListener("click", () => {
  exportBackdrop.classList.add("open");
  document.getElementById("export-error").textContent = "";
  updateExportFilterCount();
});
document.getElementById("export-cancel").addEventListener("click", () => exportBackdrop.classList.remove("open"));
document.getElementById("export-use-filter").addEventListener("change", updateExportFilterCount);
document.querySelectorAll('input[name="export-mode"]').forEach(r => r.addEventListener("change", () => {
  const mode = document.querySelector('input[name="export-mode"]:checked').value;
  document.getElementById("export-history-fields").style.display = mode === "history" ? "flex" : "none";
  document.getElementById("export-snapshot-fields").style.display = mode === "snapshot" ? "flex" : "none";
}));
document.getElementById("export-download").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="export-mode"]:checked').value;
  const errorEl = document.getElementById("export-error");
  errorEl.textContent = "";
  const body = { mode, source_file: state.sourceFile };
  if (mode === "history") {
    const from = document.getElementById("export-date-from").value;
    const to = document.getElementById("export-date-to").value;
    if (from) body.date_from = from;
    if (to) body.date_to = to;
  } else {
    const date = document.getElementById("export-date").value;
    if (date) body.date = date;
  }
  if (document.getElementById("export-use-filter").checked) {
    body.element_ids = state.elements.filter(passesPlacementFilters).map(e => e.id);
  }

  const downloadBtn = document.getElementById("export-download");
  downloadBtn.disabled = true;
  try {
    const res = await fetch("/export.xlsx", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error((errBody && errBody.detail) ? errBody.detail : `Ошибка ${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : "export.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportBackdrop.classList.remove("open");
  } catch (e) {
    errorEl.textContent = "Не удалось скачать: " + e.message;
  } finally {
    downloadBtn.disabled = false;
  }
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

document.getElementById("btn-upload").addEventListener("click", async () => {
  uploadFileInput.value = "";
  setUploadStatus("", false);
  uploadSubmit.disabled = false;
  uploadFileInput.disabled = false;
  uploadBackdrop.classList.add("open");
  // Список чертежей и слоёв теперь живёт в этой же форме (см. index.html):
  // перечитываем при каждом открытии — состав файлов мог измениться после
  // загрузки нового чертежа или импорта из папки Input.
  await renderFileSelectMenu();
});
document.getElementById("upload-cancel").addEventListener("click", () => uploadBackdrop.classList.remove("open"));

uploadSubmit.addEventListener("click", async () => {
  const file = uploadFileInput.files[0];
  if (!file) { setUploadStatus("Сначала выберите файл .dxf", true); return; }

  uploadSubmit.disabled = true;
  uploadFileInput.disabled = true;
  setUploadStatus("Разбор чертежа… это может занять до минуты для больших файлов.", false);

  const formData = new FormData();
  formData.append("file", file);

  try {
    // Фаза 1 — только разбор и сверка, в БД ничего не пишется (решение И3).
    // Применение — после того, как пользователь увидел, что изменится.
    const res = await fetch("/import-dxf/analyze", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const detail = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      setUploadStatus(detail, true);
      return;
    }

    setUploadStatus("Разбор готов — проверьте сводку изменений.", false);
    openImportReview(body);
  } catch (e) {
    setUploadStatus("Не удалось связаться с сервером: " + e.message, true);
  } finally {
    uploadSubmit.disabled = false;
    uploadFileInput.disabled = false;
  }
});

// ==================== СВОДКА РАСХОЖДЕНИЙ ИМПОРТА (решение И3) ====================
// Почему сводка, а не просто "готово, N элементов": переимпорт теперь
// ОБНОВЛЯЕТ существующие элементы вместе с их статусами и историей, а не
// создаёт новый набор строк. Значит у него появились последствия, которые
// пользователь обязан увидеть заранее: смену марки (она привязана к позиции
// контракта) и исчезновение элементов, по которым уже есть работа.

const importReviewBackdrop = document.getElementById("import-review-backdrop");
const importReviewBody = document.getElementById("import-review-body");
const importReviewHead = document.getElementById("import-review-head");
const importReviewStatus = document.getElementById("import-review-status");
const importReviewApply = document.getElementById("import-review-apply");
let pendingImport = null;

function importCountLine(label, value, danger) {
  if (!value) return "";
  const color = danger ? "var(--color-danger)" : "inherit";
  return `<div style="color:${color}"><b>${value}</b> — ${escapeHtml(label)}</div>`;
}

// Расхождения показываются человеческими названиями полей, а не именами
// столбцов БД: сводку читает прораб, а не разработчик.
const IMPORT_FIELD_LABELS = {
  mark: "Марка", element_type: "Тип", subtype: "Подтип",
  elevation_mm: "Отметка", floor: "Этаж",
};

// Статус в сводке — русской подписью, как везде в интерфейсе. Подписи
// приходят с сервера вместе с планом (state.statusLabels), но сводка может
// открыться до первой загрузки плана — тогда честнее показать код, чем
// пустоту.
function importStatusLabel(status) {
  return (state.statusLabels && state.statusLabels[status]) || status;
}

function importChangesText(changes) {
  return Object.entries(changes).map(([field, pair]) => {
    const label = IMPORT_FIELD_LABELS[field] || field;
    const was = pair[0] === null || pair[0] === undefined ? "—" : pair[0];
    const now = pair[1] === null || pair[1] === undefined ? "—" : pair[1];
    return `${escapeHtml(label)}: ${escapeHtml(String(was))} → ${escapeHtml(String(now))}`;
  }).join("; ");
}

function importDetailSection(title, rows, total, limit, renderRow) {
  if (!total) return "";
  const shown = rows.length;
  const cut = total > shown
    ? `<div class="hint-text">Показаны первые ${shown} из ${total}.</div>` : "";
  return `<details style="margin-top:10px">
    <summary><b>${escapeHtml(title)}: ${total}</b></summary>
    ${cut}
    <div style="max-height:none; font-size:12px; margin-top:6px">
      ${rows.map(renderRow).join("")}
    </div>
  </details>`;
}

function openImportReview(analysis) {
  pendingImport = analysis;
  const c = analysis.counts || {};
  const prev = analysis.previous_source_file;
  importReviewHead.innerHTML =
    `Объект: <b>${escapeHtml(analysis.object_name || "—")}</b>. ` +
    `Новый чертёж: <b>${escapeHtml(analysis.source_file)}</b>` +
    (prev ? `, прежний: ${escapeHtml(prev)}` : ", прежнего чертежа не было") + ".";

  const conflicts = c.mark_change_contract_conflicts || 0;
  importReviewBody.innerHTML =
    `<div style="margin-bottom:8px">
       ${importCountLine("сопоставлено по handle (тот же элемент чертежа)", c.matched_by_handle)}
       ${importCountLine("сопоставлено по геометрии (элемент перерисован)", c.matched_by_geometry)}
       ${importCountLine("новых элементов", c.new)}
       ${importCountLine("исчезло из чертежа (статусы и история сохранятся)", c.retired, c.retired_with_progress > 0)}
       ${importCountLine("из них с начатой работой (не «Запланирован»)", c.retired_with_progress, true)}
       ${importCountLine("сменилась марка", c.mark_changed, conflicts > 0)}
       ${importCountLine("из них перестают соответствовать позиции своего контракта", conflicts, true)}
       ${importCountLine("изменились другие реквизиты (отметка, подтип, этаж)", (c.attribute_changed || 0) - (c.mark_changed || 0))}
     </div>` +
    (c.mark_changed ? `<label style="display:flex; gap:8px; align-items:center; margin:10px 0">
        <input type="checkbox" id="import-accept-marks" checked/>
        <span>Принять смену марок из чертежа. Если снять — марки останутся прежними,
        остальная геометрия обновится в любом случае.</span>
      </label>` : "") +
    importDetailSection("Смена марки", analysis.details.mark_changes, c.mark_changed, analysis.detail_limit,
      r => `<div>${escapeHtml(r.element_type)} ${importChangesText(r.changes)}
             ${r.contract_conflict ? '<span style="color:var(--color-danger)">— не соответствует позиции контракта</span>' : ""}
             ${r.current_status !== "planned" ? `<span class="hint-text">(статус: ${escapeHtml(importStatusLabel(r.current_status))})</span>` : ""}</div>`) +
    importDetailSection("Исчезли из чертежа", analysis.details.retired, c.retired, analysis.detail_limit,
      r => `<div>${escapeHtml(r.element_type)} ${escapeHtml(r.mark || "без марки")}
             <span class="hint-text">(handle ${escapeHtml(r.dxf_handle)}, статус ${escapeHtml(importStatusLabel(r.current_status))})</span></div>`) +
    importDetailSection("Новые элементы", analysis.details.new, c.new, analysis.detail_limit,
      r => `<div>${escapeHtml(r.element_type)} ${escapeHtml(r.mark || "без марки")}
             <span class="hint-text">(отм. ${r.elevation_mm === null ? "—" : escapeHtml(String(r.elevation_mm))})</span></div>`) +
    importDetailSection("Изменились реквизиты", analysis.details.attribute_changes,
      (c.attribute_changed || 0) - (c.mark_changed || 0), analysis.detail_limit,
      r => `<div>${escapeHtml(r.element_type)} ${importChangesText(r.changes)}</div>`);

  importReviewStatus.textContent = "";
  importReviewApply.disabled = false;
  importReviewBackdrop.classList.add("open");
}

document.getElementById("import-review-cancel").addEventListener("click", () => {
  // Токен на сервере просто перестанет использоваться и вытеснится
  // следующими разборами — в БД по нему ничего не записано.
  pendingImport = null;
  importReviewBackdrop.classList.remove("open");
  setUploadStatus("Импорт отменён — данные не изменены.", false);
});

importReviewApply.addEventListener("click", async () => {
  if (!pendingImport) return;
  const acceptBox = document.getElementById("import-accept-marks");
  importReviewApply.disabled = true;
  importReviewStatus.textContent = "Применение…";
  try {
    const res = await fetch("/import-dxf/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: pendingImport.token,
        accept_mark_changes: acceptBox ? acceptBox.checked : true,
        keep_mark_element_ids: [],
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      importReviewStatus.textContent = (body && body.detail) ? body.detail : `Ошибка ${res.status}`;
      importReviewStatus.style.color = "var(--color-danger)";
      importReviewApply.disabled = false;
      return;
    }

    const marks = Object.entries(body.by_mark_source).map(([k, v]) => `${k}: ${v}`).join(", ");
    const axes = Object.entries(body.by_axis_status).map(([k, v]) => `${k}: ${v}`).join(", ");
    setUploadStatus(
      `Готово: ${body.total} элементов (новых: ${body.inserted}, обновлено: ${body.updated}` +
      (body.retired ? `, исчезло: ${body.retired}` : "") +
      (body.marks_kept ? `, оставлено прежних марок: ${body.marks_kept}` : "") + "). " +
      `Марки — ${marks}. Адресация — ${axes}. Оси: ${body.axis_grid.numeric} числовых, ${body.axis_grid.letter} буквенных.`,
      false
    );

    importReviewBackdrop.classList.remove("open");
    pendingImport = null;

    // Здесь раньше стоял layersCache.delete(body.source_file) — ссылка на
    // кэш, которого в коде нет ВООБЩЕ (проверено по всей истории файла:
    // единственное упоминание было это). После успешной загрузки чертежа
    // обработчик падал на ReferenceError, и пользователь вместо обновлённой
    // схемы получал "Не удалось связаться с сервером: layersCache is not
    // defined" — то есть выглядело это как сбой сети на ровном месте. Баг
    // достался по наследству и найден живым браузером при проверке этой
    // правки; см. Docs/backlog.md 2026-07-30.
    await loadSourceFiles();
    state.selection = new Map([[body.source_file, null]]);
    state.sourceFile = body.source_file;
    updateFileSelectSummary();
    await loadPlan(false); // новый чертёж — координаты другие, старый масштаб бессмысленен

    setTimeout(() => uploadBackdrop.classList.remove("open"), 1200);
  } catch (e) {
    importReviewStatus.textContent = "Не удалось связаться с сервером: " + e.message;
    importReviewStatus.style.color = "var(--color-danger)";
    importReviewApply.disabled = false;
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
//   дефолт, если ярус всего один). Если эта же колонна стоит под КОНЦОМ
//   ригеля ЕЩЁ ВЫШЕ (см. computeColumnEndExtensions, columnTopOverrides)
//   — вытягивается до него вместо базового потолка.
// - Плита перекрытия — фиксированная толщина (см. FLOOR_SLAB_THICKNESS_MM).
// - Ригель/Плита/Панель — квадратное сечение, высота = ширина контура.
function elementExtrusionHeight(element, levels, columnTopOverrides) {
  if (element.element_type === "Колонна") {
    const idx = levels.indexOf(element.elevation_mm);
    if (idx !== -1 && idx < levels.length - 1) return levels[idx + 1] - levels[idx];
    if (idx === levels.length - 1) {
      let ceiling = computeTopColumnCeiling(levels);
      const override = columnTopOverrides && columnTopOverrides.get(element.id);
      if (override !== undefined && (ceiling === null || override > ceiling)) ceiling = override;
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

// ---------- режим слабого компьютера (живой запрос 2026-07-29: "на слабых
// компьютерах работа с 3Д очень медленная") ----------
//
// Узкое место 3D на реальном файле — НЕ объём геометрии (9422 элемента, в
// среднем 3,6 вершины на контур — для видеокарты это пустяк), а ЧИСЛО
// вызовов отрисовки: меш грани + отдельный объект рёбер на каждый элемент,
// то есть ~18 800 вызовов на кадр. Их формирует процессор, и упирается
// слабая машина именно в него.
//
// Режим бьёт по двум самым дорогим статьям сразу:
//  - рёбра не создаются вовсе (см. build3DMeshForElement) — минус половина
//    объектов сцены;
//  - пиксельная плотность 1 вместо 1.5 — вдвое меньше пикселей на кадр
//    (на Retina это самая заметная часть работы фрагментного шейдера).
// Радикальное решение (слияние геометрии всех элементов одного статуса в
// один буфер, ~14 вызовов вместо 18 800) требует переделки поэлементного
// клика и скрытия по фильтрам — это отдельная крупная работа, см. Docs/TZ.md.
//
// Настройка КОМПЬЮТЕРА, а не проекта: живёт в localStorage браузера, не в
// БД. У прорабов машины разные, общая на всех настройка была бы бессмысленной.
const LOW_SPEC_KEY = "zhbi_low_spec";

function pixelRatioForCurrentMode() {
  const cap = state.lowSpec ? 1 : 1.5;
  return Math.min(window.devicePixelRatio || 1, cap);
}

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

function build3DMeshForElement(element, levels, columnTopOverrides) {
  if (!element.outline || element.outline.length < 3) return null; // нечего экструдировать
  const height = elementExtrusionHeight(element, levels, columnTopOverrides);
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
  //
  // В режиме слабого компьютера рёбра НЕ создаются вовсе (см. state.lowSpec):
  // это ровно половина всех объектов сцены и, соответственно, примерно
  // половина вызовов отрисовки на кадр — на реальном файле 9422 ребра из
  // ~18 800 объектов. Грань при этом остаётся полноценной, теряется только
  // чёрная окантовка, то есть картинка беднее, но не искажена.
  if (state.lowSpec) return mesh;

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

// ---------- 3D "наклейка" марки — вместо плавающей таблички-спрайта,
// прямо на грани элемента (заказчик запросил явно, 2026-07-24): текст
// идёт ВДОЛЬ элемента, по центру его длины, буквами во всю его ширину.
// Плита перекрытия/Ригель — на верхней и нижней (горизонтальных) гранях;
// Колонна — на всех боковых (вертикальных) гранях, текст читается СНИЗУ
// ВВЕРХ вдоль высоты (заказчик подтвердил именно так, не на торце —
// колонна вертикальная, её "длина" в этом смысле высота, а не крошечное
// сечение). Если марка не помещается по длине (короткий ригель и т.п.) —
// null, вызывающий код падает назад на плавающую табличку
// (build3DLabelSprite), как раньше. ----------
const DECAL_TYPES = new Set(["Плита перекрытия", "Ригель", "Колонна"]);
// Та же оценка ширины текста, что и в 2D (см. updateLabelBgRect) —
// согласованно, без per-glyph измерения на каждый элемент.
const DECAL_CHAR_WIDTH_RATIO = 0.62;
// Текст не должен занимать больше этой доли длины — небольшой запас,
// чтобы не "впритык" по самому краю.
const DECAL_FIT_MARGIN = 0.92;
// Горизонтальный отступ текстуры (getDecalTexture: paddingX=fontPx*0.3
// с каждой стороны) в тех же "долях символа", что и DECAL_CHAR_WIDTH_RATIO
// — canvas.height=fontPx*1.3, значит суммарный отступ (0.3*2=0.6 в долях
// fontPx) в мировых единицах составляет 0.6/1.3 доли world-высоты
// (=fontSize). Без этого слагаемого в maxFontByLength (см. ниже)
// формула считала только текст, реальная ширина наклейки (текст+отступы)
// вылезала за контур — тот же живой баг, что и у 2D-наклейки (Docs/backlog.md).
const DECAL_PAD_WIDTH_RATIO = 0.6 / 1.3;
// Небольшой вынос наклейки от истинной поверхности грани наружу —
// иначе плоскость наклейки лежит РОВНО на грани элемента (тот же
// z-fighting, что уже чинили для рёбер силуэта, см. polygonOffset
// выше) — саму геометрию элемента это не меняет, наклейка лишь
// декоративный оверлей поверх неё, в отличие от структурной геометрии
// (там заказчик потребовал точное соответствие входным данным).
const DECAL_SURFACE_OFFSET_MM = 5;

// Текстура наклейки — ОБЩАЯ на все элементы с ОДНОЙ и той же маркой, не
// своя на каждый элемент — марки часто повторяются десятки раз по всему
// зданию (см. Docs/backlog.md, "31 экземпляр марки 2Рк2 на одной
// отметке") — отдельная текстура на каждый экземпляр была бы тем же
// классом проблемы с производительностью, что уже чинили для материалов
// (см. getStatusMeshMaterial).
// Ключ кэша — марка + допстрока + её цвет (не только марка) — допстрока
// (код контрагента + плановая дата) отличается у РАЗНЫХ физических
// элементов с ОДНОЙ и той же маркой (разные контракты/плановые даты),
// текстуру по одной марке больше нельзя было бы безусловно шарить между
// ними (живой запрос пользователя: "в 3Д информации о дате и контрагенте
// не появилось вообще" — раньше наклейка вообще не показывала допстроку,
// только марку). Элементы БЕЗ допстроки (нет плановой даты/кода) по-прежнему
// делят одну текстуру на марку — самый частый случай, кэш не деградирует.
const decalTextureCache = new Map(); // "марка::допстрока::цвет" -> THREE.CanvasTexture

// Марка и допстрока — ОДНА строка, не две (живой запрос пользователя:
// "в одну строку марка и дата" — раньше 2 строки делали наклейку выше,
// из-за чего она реже проходила проверку "помещается по высоте
// стороны" в build3DMarkDecal и элемент чаще падал на плавающую
// табличку, которая визуально "отрывается" от поверхности).
function getDecalTexture(mark, subText, subColor) {
  const key = `${mark}::${subText || ""}::${subColor || ""}`;
  let texture = decalTextureCache.get(key);
  if (texture) return texture;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 64; // разрешение текстуры — не мировой размер, наклейка растягивается под реальные мм на плоскости
  ctx.font = `bold ${fontPx}px sans-serif`;
  const markWidthPx = ctx.measureText(mark + (subText ? " " : "")).width;
  let subWidthPx = 0;
  if (subText) { ctx.font = `${fontPx}px sans-serif`; subWidthPx = ctx.measureText(subText).width; }
  const paddingX = fontPx * 0.3;
  canvas.width = Math.max(1, Math.ceil(markWidthPx + subWidthPx) + paddingX * 2);
  canvas.height = Math.ceil(fontPx * 1.3);
  // Та же подложка/цвет, что уже подтверждена для плавающей 3D-таблички
  // (build3DLabelSprite) — визуальная согласованность между "наклейкой"
  // и запасным вариантом для коротких элементов.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  ctx.fillStyle = currentLabelColor();
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.fillText(mark, paddingX, canvas.height / 2);
  if (subText) {
    ctx.font = `${fontPx}px sans-serif`;
    ctx.fillStyle = subColor || "#555";
    ctx.fillText(subText, paddingX + markWidthPx, canvas.height / 2);
  }
  texture = new THREE.CanvasTexture(canvas);
  texture.userData.aspect = canvas.width / canvas.height;
  decalTextureCache.set(key, texture);
  return texture;
}

// Направление самой длинной стороны контура — устойчиво к лишним
// коллинеарным точкам-серединам в контуре (частый случай в реальных
// DXF, см. offsetOutlineMM выше): даже разрезанная пополам длинная
// сторона всё равно длиннее короткой.
function footprintLongAxisAngle(outline) {
  let bestLen = -1, bestDx = 1, bestDy = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % n];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) { bestLen = len; bestDx = dx; bestDy = dy; }
  }
  return Math.atan2(bestDy, bestDx);
}

// Ширина/длина контура — тот же подход (прямоугольник по площади и
// периметру), что и crossSectionWidth выше, но возвращает ОБА корня
// (crossSectionWidth — только меньший).
function footprintDimensions(outline) {
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
  if (disc < 0) { const s = Math.sqrt(area); return { width: s, length: s }; }
  const width = (halfPerimeter - Math.sqrt(disc)) / 2;
  return { width, length: halfPerimeter - width };
}

// Стороны контура с объединением коллинеарных соседей (та же проблема
// лишних точек-середин, что у offsetOutlineMM) — нужны ЦЕЛЬНЫЕ стороны
// многоугольника: наклейка на боковой грани колонны — одна на КАЖДУЮ
// реальную сторону, не на каждый отрезок между соседними точками контура.
function polygonSides(outline) {
  const pts = [];
  for (const p of outline) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push(p);
  }
  if (pts.length > 1) {
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(fx - lx, fy - ly) < 1e-6) pts.pop();
  }
  const n = pts.length;
  if (n < 3) return [];
  const raw = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 1e-6) raw.push({ a, b, dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] });
  }
  const sides = [];
  for (const edge of raw) {
    const prev = sides[sides.length - 1];
    if (prev) {
      const cross = prev.dir[0] * edge.dir[1] - prev.dir[1] * edge.dir[0];
      const dot = prev.dir[0] * edge.dir[0] + prev.dir[1] * edge.dir[1];
      if (Math.abs(cross) < 1e-6 && dot > 0) { prev.b = edge.b; continue; }
    }
    sides.push({ a: edge.a, b: edge.b, dir: edge.dir });
  }
  if (sides.length > 1) {
    const first = sides[0], last = sides[sides.length - 1];
    const cross = last.dir[0] * first.dir[1] - last.dir[1] * first.dir[0];
    const dot = last.dir[0] * first.dir[0] + last.dir[1] * first.dir[1];
    if (Math.abs(cross) < 1e-6 && dot > 0) {
      sides[sides.length - 1] = { a: last.a, b: first.b, dir: last.dir };
      sides.shift();
    }
  }
  return sides;
}

// Центр контура — через ограничивающий прямоугольник (min+max по
// каждой координате), НЕ среднее по вершинам. Простое среднее ломается
// на реальных DXF-контурах с лишними коллинеарными точками-серединами
// на длинных сторонах (частый случай, см. offsetOutlineMM выше) —
// смещается на десятки мм от истинного центра, потому что вершины
// распределены по контуру неравномерно (см. Docs/backlog.md, живой
// репорт пользователя 2026-07-25: на узком 600-мм сечении ригеля такое
// смещение утапливало одну из боковых наклеек НА 40+ мм ВНУТРЬ
// сплошного тела элемента, где её полностью закрывала собственная
// непрозрачная грань — снаружи выглядело как "надписи вообще нет").
// Min+max устойчив к любому числу лишних точек на прямых сторонах — и
// для ЛЮБОГО прямоугольника (в том числе повёрнутого — прямоугольник
// центрально-симметричен, его ограничивающий прямоугольник по осям XY
// всегда центрирован в ту же точку, независимо от угла поворота).
function footprintCentroid(outline) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// Толерантность привязки конца ригеля к ближайшей колонне верхнего
// яруса — по факту на реальных данных (260723_Чертежи для WEB.dxf,
// 34 ригеля/68 концов на отметке 39200) максимальное расстояние конец-
// ригеля-до-центра-опорной-колонны около 1000мм (адресация со
// смещением от оси — offset_x_mm/offset_y_mm — сдвигает колонну
// относительно "чистой" точки сетки), проверено live-скриптом на живой
// БД (см. Docs/backlog.md).
const COLUMN_BEAM_END_MATCH_TOLERANCE_MM = 1000;

// Колонны верхнего яруса, которые нужно вытянуть ВЫШЕ базового потолка
// (computeTopColumnCeiling) — конкретно те, что стоят под КОНЦОМ ригеля
// на ещё более высокой отметке (например, локальная кровля техпомещения
// над основной крышей — новый ярус ригелей/плит выше уже учтённого
// потолка). Колонна, которая просто оказалась ГЕОМЕТРИЧЕСКИ под
// серединой пролёта такого ригеля (не под его концом), высоту НЕ меняет
// — так и должно быть, ригель на неё не опирается (живой запрос
// пользователя, см. Docs/backlog.md). Только "Ригель" — по условию
// заказчика плита перекрытия лежит на ригеле, а не на колонне напрямую.
// Возвращает Map(id колонны -> самая высокая подходящая отметка).
function computeColumnEndExtensions(levels) {
  const overrides = new Map();
  if (!levels.length) return overrides;
  const topLevel = levels[levels.length - 1];
  const baseCeiling = computeTopColumnCeiling(levels);
  if (baseCeiling === null) return overrides;

  const topColumns = [];
  for (const e of state.elements) {
    if (e.element_type === "Колонна" && e.elevation_mm === topLevel && e.outline && e.outline.length >= 3) {
      const [ccx, ccy] = footprintCentroid(e.outline);
      topColumns.push({ id: e.id, cx: ccx, cy: ccy });
    }
  }
  if (!topColumns.length) return overrides;

  for (const beam of state.elements) {
    if (beam.element_type !== "Ригель") continue;
    if (beam.elevation_mm == null || beam.elevation_mm <= baseCeiling) continue; // уже накрыт базовым потолком
    if (!beam.outline || beam.outline.length < 3) continue;
    const dims = footprintDimensions(beam.outline);
    if (!dims) continue;
    const angle = footprintLongAxisAngle(beam.outline);
    const [bcx, bcy] = footprintCentroid(beam.outline);
    const halfLen = dims.length / 2;
    const dx = Math.cos(angle) * halfLen, dy = Math.sin(angle) * halfLen;
    const ends = [[bcx + dx, bcy + dy], [bcx - dx, bcy - dy]];
    for (const [ex, ey] of ends) {
      let best = null;
      for (const col of topColumns) {
        const d = Math.hypot(col.cx - ex, col.cy - ey);
        if (!best || d < best.d) best = { d, id: col.id };
      }
      if (best && best.d <= COLUMN_BEAM_END_MATCH_TOLERANCE_MM) {
        const prev = overrides.get(best.id);
        if (prev === undefined || beam.elevation_mm > prev) overrides.set(best.id, beam.elevation_mm);
      }
    }
  }
  return overrides;
}

// Ориентирует плоскую наклейку через явный базис (право/верх/нормаль) —
// надёжнее, чем подбирать углы поворота вручную (тот же класс ошибок,
// что уже ловили на зеркальности всей 3D-сцены, см. Docs/backlog.md,
// "3D — зеркальность"): right/normal/up — ортонормированная тройка,
// right×up=normal (правая система), PlaneGeometry по умолчанию лежит в
// локальной XY с нормалью +Z — базис ставит локальный X на right,
// Y на up, Z на normal.
function orientDecalMesh(mesh, center, right, normal) {
  const up = new THREE.Vector3().crossVectors(normal, right).normalize();
  const basis = new THREE.Matrix4().makeBasis(right, up, normal);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(center);
}

function buildDecalPlane(texture, worldWidth, worldHeight, center, right, normal) {
  const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
  const material = new THREE.MeshBasicMaterial({
    map: texture, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geometry, material);
  orientDecalMesh(mesh, center, right, normal);
  // Сохраняем "базовую" (немодифицированную) ориентацию — см.
  // updateDecalOrientation ниже: при вращении камеры вокруг элемента
  // текст на плоской наклейке (не билборд — лежит на грани) со
  // временем оказывается развёрнут "верх ногами" относительно текущего
  // ракурса (заказчик явно попросил это исправить, 2026-07-25) —
  // единственный выход из двух читаемых вариантов (право/лево = базовое
  // направление или развёрнутое на 180° вокруг нормали) выбирается
  // заново при каждом повороте камеры, без пересборки геометрии/текстуры.
  mesh.userData.decalCenter = center.clone();
  mesh.userData.decalNormal = normal.clone();
  mesh.userData.decalBaseRight = right.clone();
  return mesh;
}

// Разворачивает наклейку на 180° вокруг нормали, если её "верх" сейчас
// смотрит НА камеру — то есть зритель стоит с "дальней" стороны текста
// (там, куда указывает верх букв), а не с "ближней" (где строка
// начинается) — тот же принцип, что у листа на столе: читают его СО
// СТОРОНЫ, противоположной верху страницы (верх "уходит" от читателя), не
// с той, куда верх направлен. Раньше знак был перепутан на обратный —
// разворачивало ИМЕННО тогда, когда не нужно, и наоборот, поэтому вверх
// ногами оказывались вообще все наклейки на любом ракурсе, а не только
// часть (живой репорт пользователя 2026-07-25, см. Docs/backlog.md).
// Дёшево: только пересчёт кватерниона (см. orientDecalMesh), без
// пересборки geometry/texture.
function updateDecalOrientation(mesh, camera) {
  const { decalCenter, decalNormal, decalBaseRight } = mesh.userData;
  if (!decalCenter) return;
  const up = new THREE.Vector3().crossVectors(decalNormal, decalBaseRight).normalize();
  // Динамический разворот имеет смысл ТОЛЬКО когда "верх" текста
  // ГОРИЗОНТАЛЬНЫЙ (верх/низ плиты/ригеля — там при обходе камеры вокруг
  // здания по азимуту верх текста то смотрит на зрителя, то от него,
  // ровно то, что чинили). На боковых (вертикальных) гранях (колонна,
  // боковые грани ригеля) "верх" текста ВЕРТИКАЛЬНЫЙ — буквы стоят прямо
  // и не должны переворачиваться от того, выше или ниже камера конкретного
  // элемента: раньше это давало переворот "через раз" в зависимости от
  // высоты камеры относительно КАЖДОГО элемента по отдельности (живой
  // репорт пользователя 2026-07-25, см. Docs/backlog.md) — для них
  // используем ту базовую ориентацию, что задана при постройке, всегда.
  if (Math.abs(up.y) > 0.5) {
    orientDecalMesh(mesh, decalCenter, decalBaseRight, decalNormal);
    return;
  }
  const toCamera = new THREE.Vector3().subVectors(camera.position, decalCenter).normalize();
  const flip = up.dot(toCamera) > 0;
  const right = flip ? decalBaseRight.clone().negate() : decalBaseRight;
  orientDecalMesh(mesh, decalCenter, right, decalNormal);
}

function updateAllDecalOrientations() {
  const v3 = state.view3d;
  if (!v3.camera || !v3.markDecalById.size) return;
  for (const group of v3.markDecalById.values()) {
    // Скрытую наклейку разворачивать незачем: её не видно, а функция
    // вызывается на КАЖДОЕ движение камеры. Без этой проверки вращение
    // сцены с узким фильтром стоило столько же, сколько без фильтра
    // (живой запрос 2026-07-29: не обрабатывать то, что отфильтровано).
    if (!group.visible) continue;
    for (const mesh of group.children) updateDecalOrientation(mesh, v3.camera);
  }
}

// Строит "наклейку" на грани(ях) элемента — только для DECAL_TYPES с
// пригодным контуром; шрифт уменьшается, если марка+допстрока не
// помещаются по длине стороны (живой запрос пользователя — наклейка
// должна ВСЕГДА лежать на поверхности, не падать на плавающую табличку
// build3DLabelSprite из-за длинного текста). null — только если контура
// совсем нет/не того типа/марки нет вовсе (см. rebuild3DLabelSprite/
// build3DScene — тогда используется build3DLabelSprite).
function build3DMarkDecal(element, levels, columnTopOverrides) {
  if (!DECAL_TYPES.has(element.element_type)) return null;
  if (!element.mark || !element.outline || element.outline.length < 3) return null;

  // Допстрока (код контрагента + плановая дата) — та же информация, что
  // у плавающей 3D-подписи (build3DLabelSprite) и у 2D-наклейки, теперь
  // и на самой наклейке на грани (раньше наклейка несла только марку —
  // живой запрос пользователя, см. Docs/backlog.md). Цвет — тот же
  // критерий опоздания, что у допстроки везде (computeDeliveryLateStatus).
  const subText = elementSubLabelText(element);
  const subColor = deliveryColorHex(element);
  // Марка+допстрока — ОДНА строка (см. getDecalTexture) — длина для
  // фит-чека суммарная, не максимум из двух отдельных строк.
  const maxTextLen = element.mark.length + (subText ? subText.length + 1 : 0);

  const texture = getDecalTexture(element.mark, subText, subColor);
  const aspect = texture.userData.aspect;
  const group = new THREE.Group();
  // world.X=dxf.x, world.Z=-dxf.y (см. build3DMeshForElement) — та же
  // поправка знака применяется здесь для всех мировых координат наклейки.

  if (element.element_type === "Колонна") {
    const height = elementExtrusionHeight(element, levels, columnTopOverrides);
    const sides = polygonSides(element.outline);
    const centroid = footprintCentroid(element.outline);
    let any = false;
    for (const side of sides) {
      const width = Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1]);
      // Шрифт УМЕНЬШАЕТСЯ, если марка+допстрока не помещаются по высоте
      // этой стороны, а не отменяет наклейку целиком (живой запрос
      // пользователя: "точно как наклейка в пределах элемента" — всегда
      // на поверхности, а не иногда падать на плавающую табличку).
      const maxFontByLength = (height * DECAL_FIT_MARGIN) / (maxTextLen * DECAL_CHAR_WIDTH_RATIO + DECAL_PAD_WIDTH_RATIO);
      const fontSize = Math.min(width, maxFontByLength);
      any = true;
      const midX = (side.a[0] + side.b[0]) / 2, midY = (side.a[1] + side.b[1]) / 2;
      // "Наружу" — от центроида контура к середине стороны (устойчивее,
      // чем гадать знак перпендикуляра ребра отдельно).
      let nx = midX - centroid[0], ny = midY - centroid[1];
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen; ny /= nlen;
      const normal = new THREE.Vector3(nx, 0, -ny);
      const right = new THREE.Vector3(0, 1, 0); // текст снизу вверх вдоль высоты
      const center = new THREE.Vector3(midX, (element.elevation_mm || 0) + height / 2, -midY);
      center.addScaledVector(normal, DECAL_SURFACE_OFFSET_MM);
      group.add(buildDecalPlane(texture, fontSize * aspect, fontSize, center, right, normal));
    }
    if (!any) return null;
    return group;
  }

  // Плита перекрытия / Ригель — верх и низ, вдоль длинной стороны контура.
  const dims = footprintDimensions(element.outline);
  if (!dims) return null;
  // Шрифт уменьшается, если марка+допстрока не помещаются по длине —
  // не отменяет наклейку целиком (см. комментарий у Колонны выше).
  const maxFontByLength = (dims.length * DECAL_FIT_MARGIN) / (maxTextLen * DECAL_CHAR_WIDTH_RATIO + DECAL_PAD_WIDTH_RATIO);
  const fontSize = Math.min(dims.width, maxFontByLength);

  const angle = footprintLongAxisAngle(element.outline);
  const right = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
  const height = elementExtrusionHeight(element, levels, columnTopOverrides);
  const [cx0, cy0] = footprintCentroid(element.outline);
  const cx = cx0, cz = -cy0;
  const decalWorldWidth = fontSize * aspect;

  const topCenter = new THREE.Vector3(cx, (element.elevation_mm || 0) + height + DECAL_SURFACE_OFFSET_MM, cz);
  group.add(buildDecalPlane(texture, decalWorldWidth, fontSize, topCenter, right, new THREE.Vector3(0, 1, 0)));

  const bottomCenter = new THREE.Vector3(cx, (element.elevation_mm || 0) - DECAL_SURFACE_OFFSET_MM, cz);
  group.add(buildDecalPlane(texture, decalWorldWidth, fontSize, bottomCenter, right, new THREE.Vector3(0, -1, 0)));

  // Ригель — ЕЩЁ 2 наклейки, на боковых (вертикальных) гранях вдоль
  // длины (не только верх/низ) — заказчик явно попросил "с четырёх
  // сторон, а не с двух" (2026-07-25): сечение квадратное (ширина
  // контура = высота экструзии, см. crossSectionWidth), поэтому боковые
  // грани — те же LENGTH×WIDTH, что и верх/низ, тем же fontSize.
  // Плиту перекрытия не трогаем — про неё явно шла речь только про
  // верх/низ ("Сверху и снизу"), четыре стороны просил только для
  // ригелей.
  if (element.element_type === "Ригель") {
    // Перпендикуляр к длинной оси в плоскости DXF (поворот на 90°).
    const perpX = -Math.sin(angle), perpY = Math.cos(angle);
    const halfWidth = dims.width / 2;
    for (const sign of [1, -1]) {
      const sideCx = cx0 + perpX * halfWidth * sign;
      const sideCy = cy0 + perpY * halfWidth * sign;
      const normal = new THREE.Vector3(perpX * sign, 0, -perpY * sign);
      const center = new THREE.Vector3(sideCx, (element.elevation_mm || 0) + height / 2, -sideCy);
      center.addScaledVector(normal, DECAL_SURFACE_OFFSET_MM);
      // "право" ОБЯЗАНО зависеть от sign, не общее на обе стороны — иначе
      // "верх" текста (cross(normal,право)) у одной из двух граней
      // математически ВСЕГДА получается направлен вниз (доказано:
      // up.y = -sign при общем "право" на обе стороны — не эвристика,
      // подставлено и упрощено аналитически) — ровно то, что сообщил
      // пользователь (боковая грань к зрителю — вверх ногами, живой
      // репорт 2026-07-25, см. Docs/backlog.md). Домножение на -sign
      // даёт up.y=+1 (стабильно "вверх") на ОБЕИХ сторонах.
      const sideRight = right.clone().multiplyScalar(-sign);
      group.add(buildDecalPlane(texture, decalWorldWidth, fontSize, center, sideRight, normal));
    }
  }

  return group;
}

// Постоянная подпись марки в 3D (см. Docs/backlog.md, "Раунд из 3
// пунктов", 2026-07-17, п.3) — THREE.Sprite с canvas-текстурой: билборд
// к камере автоматический (не нужно ничего обновлять per-frame в
// render3DFrame()), в отличие от плоскости/TextGeometry. Провендорено только
// ядро Three.js (Sprite/SpriteMaterial — его часть) — CSS2DRenderer/
// TextGeometry НЕ провендорены, а по правилу проекта новый сторонний код
// требует отдельного подтверждения (см. CLAUDE.md), поэтому выбран путь
// без нового вендоринга.
function build3DLabelSprite(element, topY) {
  if (!element.mark) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 48; // размер текстуры холста — не экранный размер, см. sprite.scale ниже
  const subText = elementSubLabelText(element);
  const paddingX = 8, paddingY = 8;

  // Марка и допстрока — ОДНА строка (живой запрос пользователя: "должна
  // быть ... в одну строку марка и дата"), не две — та же причина и то
  // же решение, что и у наклейки на грани, см. getDecalTexture.
  ctx.font = `${fontPx}px sans-serif`;
  const markWidth = ctx.measureText(element.mark + (subText ? " " : "")).width;
  const subWidth = subText ? ctx.measureText(subText).width : 0;
  canvas.width = Math.ceil(markWidth + subWidth) + paddingX * 2;
  canvas.height = Math.ceil(fontPx) + paddingY * 2;

  // Полупрозрачная белая подложка — контраст на любом цвете элемента под
  // спрайтом (буквально то, что запрошено, см. Docs/backlog.md; в canvas,
  // в отличие от 2D SVG, это простая безопасная операция).
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textBaseline = "middle";
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillStyle = currentLabelColor();
  ctx.fillText(element.mark, paddingX, paddingY + fontPx / 2);
  if (subText) {
    // Цвет — по опозданию против начала СМР (тот же критерий, что и
    // 2D-допстрока, см. subLabelClass) — красный/зелёный/нейтральный.
    ctx.fillStyle = deliveryColorHex(element);
    ctx.fillText(subText, paddingX + markWidth, paddingY + fontPx / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true });
  const sprite = new THREE.Sprite(material);
  // Масштаб в мировых единицах (мм) — от собственного размера элемента
  // (см. label3DWorldHeight выше), не от глобального baseMarkerRadius.
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
  requestRender3D();
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
  for (const [id, decal] of state.view3d.markDecalById) {
    const element = state.byId.get(id);
    if (!element) continue;
    decal.visible = passesPlacementFilters(element) && state.labelVisibility[element.element_type] !== false;
  }
  requestRender3D();
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
  const levels = computeColumnLevels();
  const columnTopOverrides = computeColumnEndExtensions(levels);
  const topY = (element.elevation_mm || 0) + elementExtrusionHeight(element, levels, columnTopOverrides);

  // Элемент на "наклейке" (см. build3DMarkDecal) — теперь ТОЖЕ несёт
  // допстроку (код контрагента + плановая дата, живой запрос
  // пользователя — раньше наклейка показывала только марку), значит
  // тоже нуждается в пересборке при смене статуса/плановой даты, не
  // только плавающая табличка.
  if (v3.markDecalById.has(element.id)) {
    const oldDecal = v3.markDecalById.get(element.id);
    v3.scene.remove(oldDecal);
    for (const mesh of oldDecal.children) {
      mesh.geometry.dispose();
      // НЕ mesh.material.map.dispose() — текстура общая на (марка+допстрока+цвет), см. decalTextureCache
      mesh.material.dispose();
    }
    v3.markDecalById.delete(element.id);
    const decal = build3DMarkDecal(element, levels, columnTopOverrides);
    if (decal) {
      decal.visible = passesPlacementFilters(element) && state.labelVisibility[element.element_type] !== false;
      v3.scene.add(decal);
      v3.markDecalById.set(element.id, decal);
    }
  } else {
    const old = v3.labelSpriteById.get(element.id);
    if (old) {
      v3.scene.remove(old);
      old.material.map.dispose();
      old.material.dispose();
      v3.labelSpriteById.delete(element.id);
    }
    const sprite = build3DLabelSprite(element, topY);
    if (sprite) {
      sprite.visible = passesPlacementFilters(element) && state.labelVisibility[element.element_type] !== false;
      v3.scene.add(sprite);
      v3.labelSpriteById.set(element.id, sprite);
    }
  }
  requestRender3D();
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

// preserveCamera=true — пересобрать содержимое, НЕ трогая ракурс. Нужно при
// смене фильтра: сцена пересобирается на каждое изменение отбора (см. цикл
// по элементам ниже), и сброс камеры на общий вид при каждой галочке делал
// бы работу с фильтрами невыносимой.
function build3DScene(preserveCamera = false) {
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
  for (const decal of v3.markDecalById.values()) {
    v3.scene.remove(decal);
    for (const mesh of decal.children) {
      mesh.geometry.dispose();
      // НЕ mesh.material.map.dispose() — текстура ОБЩАЯ на марку
      // (decalTextureCache, см. getDecalTexture), живёт всю сессию, не
      // пересоздаётся на каждую перестройку сцены; сам материал (не
      // общий, свой на каждую грань-наклейку) — диспозится как обычно.
      mesh.material.dispose();
    }
  }
  v3.markDecalById.clear();

  const levels = computeColumnLevels();
  const columnTopOverrides = computeColumnEndExtensions(levels);
  for (const element of state.elements) {
    // Отфильтрованный элемент НЕ строится вовсе — ни меша, ни наклейки, ни
    // текстуры (живой запрос 2026-07-29: "система не занимается обработкой
    // элементов, не попавших в условия, а не просто скрывает их").
    // Раньше строилось всё, а фильтр применялся уже к готовому мешу через
    // visible=false: сцена оставалась полной, память тоже, и рендерер
    // перебирал все ~19 тысяч объектов каждый кадр, пусть и пропуская
    // скрытые. Теперь узкий фильтр делает сцену буквально маленькой.
    //
    // Плата: смена фильтра в 3D требует ПЕРЕСБОРКИ сцены, а не переключения
    // видимости (см. applyPlacementFilters). Это осознанный размен — чем
    // уже фильтр, тем дешевле и пересборка, и всё последующее вращение.
    if (!passesPlacementFilters(element)) continue;
    const mesh = build3DMeshForElement(element, levels, columnTopOverrides);
    if (!mesh) continue;
    // Материал теперь общий на статус (см. getStatusMeshMaterial) — менять
    // его emissive прямо здесь подсветило бы ВСЕ элементы этого статуса
    // разом; выбранный элемент получает отдельный, эксклюзивно свой
    // highlight-материал (см. getHighlightMeshMaterial).
    if (state.selectedId === element.id) mesh.material = getHighlightMeshMaterial(element.current_status);
    v3.scene.add(mesh);
    v3.meshById.set(element.id, mesh);

    const topY = (element.elevation_mm || 0) + elementExtrusionHeight(element, levels, columnTopOverrides);

    // Наклейка на грани (см. build3DMarkDecal) — только для Плиты
    // перекрытия/Ригеля/Колонны и только если марка помещается по длине;
    // иначе — прежняя плавающая табличка-спрайт (build3DLabelSprite).
    // Фильтр здесь уже пройден (иначе элемент пропущен выше), остаётся
    // только тумблер подписей по типу элемента.
    const labelVisible = state.labelVisibility[element.element_type] !== false;
    const decal = build3DMarkDecal(element, levels, columnTopOverrides);
    if (decal) {
      decal.visible = labelVisible;
      v3.scene.add(decal);
      v3.markDecalById.set(element.id, decal);
    } else {
      const sprite = build3DLabelSprite(element, topY);
      if (sprite) {
        sprite.visible = labelVisible;
        v3.scene.add(sprite);
        v3.labelSpriteById.set(element.id, sprite);
      }
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

  if (!preserveCamera) fit3DCameraToData();
  updateAllDecalOrientations(); // начальный ракурс — тоже должен быть читаемым, не только после первого поворота
  requestRender3D();
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
  renderer.setPixelRatio(pixelRatioForCurrentMode());
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x505050, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  // enableDamping=false — камера должна чётко следовать за курсором и
  // останавливаться сразу, как только оператор отпустил кнопку/колесо, а
  // не "докручиваться" по инерции ещё какое-то время (живой репорт
  // пользователя 2026-07-25: ощущалось как будто модель имеет массу).
  controls.enableDamping = false;
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
  // Наклейки марок (build3DMarkDecal) лежат плоско на грани, не билборд —
  // при повороте камеры вокруг элемента текст может оказаться "вверх
  // ногами" с текущего ракурса; пересчитываем на каждое движение камеры
  // (заказчик попросил явно, 2026-07-25), не только один раз при
  // построении — дёшево, только смена кватерниона у уже существующих
  // мешей, без пересборки geometry/texture (см. updateDecalOrientation).
  controls.addEventListener("change", updateAllDecalOrientations);
  // Главный источник кадров при обычной работе: пока оператор вращает/
  // зумит/панорамирует, OrbitControls шлёт "change" на каждое движение —
  // ровно на них и рисуем. Отпустил мышь — события кончились, кадры
  // тоже (см. requestRender3D). Подписка ПОСЛЕ updateAllDecalOrientations,
  // чтобы кадр рисовался уже с пересчитанным разворотом наклеек.
  controls.addEventListener("change", requestRender3D);

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
  requestRender3D(); // камера переставлена — нужен кадр с нового ракурса
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
  requestRender3D(); // размер холста изменился — перерисовать под новый вьюпорт
}

// ---------- рендер ПО ТРЕБОВАНИЮ, а не бесконечным циклом ----------
//
// Раньше здесь был обычный для примеров Three.js безусловный цикл
// (`renderer.render(...); requestAnimationFrame(animate3D)`) — сцена
// перерисовывалась 60 раз в секунду всё время, пока включён 3D, даже
// когда с ней вообще ничего не происходило. На реальном файле (9422
// элемента) один кадр — это ~19 тысяч draw call (меш грани + объект
// рёбер LineSegments2 на каждый элемент), плюс наклейки марок при
// включённых подписях; то есть больше миллиона вызовов отрисовки в
// секунду вхолостую. Живой репорт пользователя: браузер в простое,
// без единого действия с сервисом, светился в "Мониторинге системы"
// с энерговоздействием под 2900. Сам браузер это не гасит — rAF
// тормозится только у ПОЛНОСТЬЮ скрытой вкладки, а окно, просто
// перекрытое другим окном, для него остаётся видимым и активным.
//
// Непрерывный цикл здесь и не нужен: инерции у камеры нет
// (controls.enableDamping = false, см. init3DScene), анимаций в сцене
// тоже — новый кадр требуется РОВНО когда что-то изменилось. Все такие
// точки дёргают requestRender3D(): движение камеры (событие "change" у
// OrbitControls), пересборка сцены, смена видимости по фильтрам/
// тумблерам, смена статуса/выбора элемента, пересборка подписи,
// изменение размера вьюпорта, смена цветовой схемы.
//
// requestRender3D можно звать сколько угодно раз подряд — лишний кадр
// не закажется, пока уже заказанный не отрисуется (animationFrameId).
function render3DFrame() {
  const v3 = state.view3d;
  v3.animationFrameId = null;
  if (!v3.active || !v3.renderer) return;
  v3.controls.update();
  v3.renderer.render(v3.scene, v3.camera);
}

function requestRender3D() {
  const v3 = state.view3d;
  if (!v3.active || !v3.renderer) return;
  if (v3.animationFrameId !== null) return; // кадр уже заказан — хватит одного
  v3.animationFrameId = requestAnimationFrame(render3DFrame);
}

// Вкладку свернули/увели на задний план — снимаем уже заказанный кадр
// (браузер и сам его отложит, но так честнее); вернули — рисуем один
// кадр, чтобы холст точно был актуален после возможной потери
// содержимого буфера.
document.addEventListener("visibilitychange", () => {
  const v3 = state.view3d;
  if (document.hidden) {
    if (v3.animationFrameId !== null) {
      cancelAnimationFrame(v3.animationFrameId);
      v3.animationFrameId = null;
    }
    return;
  }
  requestRender3D();
});

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
  // Начало СМР/плановая/фактическая дата + опоздание — та же информация,
  // что на инфо-плашке (см. computeTooltipDateRows), только для элементов
  // с заданным началом СМР (иначе сравнивать не с чем, см. computeDeliveryLateStatus).
  const dateRows = computeTooltipDateRows(element);
  if (dateRows) {
    for (const row of dateRows) {
      const line = document.createElement("div");
      line.className = "t3d-row " + row.cls;
      line.textContent = row.text;
      tip.appendChild(line);
    }
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
const btnView3DLight = document.getElementById("btn-view-3d-light");

// Три режима: "2d", "3d", "3d-light". Лёгкий — не настройка в панели, а
// именно режим просмотра (живой запрос 2026-07-29): оператор переключается
// на него по ситуации, когда его машина не тянет, ровно так же как между 2D
// и 3D. Отличие лёгкого от обычного — state.lowSpec (см. LOW_SPEC_KEY):
// рёбра элементов не строятся и пиксельная плотность 1.
function updateViewModeButtons(mode) {
  btnView2D.classList.toggle("active", mode === "2d");
  btnView3D.classList.toggle("active", mode === "3d");
  btnView3DLight.classList.toggle("active", mode === "3d-light");
}

async function setViewMode(mode) {
  const v3 = state.view3d;
  const stage2d = document.getElementById("stage");
  const stage3d = document.getElementById("stage-3d");
  const wantLowSpec = mode === "3d-light";
  const want3D = mode === "3d" || wantLowSpec;

  // Уже ровно в этом режиме — выходим. Проверять только v3.active теперь
  // мало: "3d" и "3d-light" оба активны, но это РАЗНЫЕ режимы.
  if (want3D === v3.active && (!want3D || wantLowSpec === state.lowSpec)) return;

  if (!want3D) {
    v3.active = false;
    if (v3.animationFrameId !== null) {
      cancelAnimationFrame(v3.animationFrameId);
      v3.animationFrameId = null;
    }
    hide3DTooltip();
    stage3d.style.display = "none";
    stage2d.style.display = "";
    updateViewModeButtons("2d");
    return;
  }

  btnView3D.disabled = true;
  btnView3DLight.disabled = true;
  try {
    await ensureThreeLoaded();
  } catch (e) {
    showToast("Не удалось загрузить 3D: " + e.message, "warning");
    btnView3D.disabled = false;
    btnView3DLight.disabled = false;
    return;
  }

  // Флаг ДО init3DScene/build3DScene: от него зависят и плотность пикселей
  // рендерера, и то, строятся ли рёбра у мешей.
  const lowSpecChanged = state.lowSpec !== wantLowSpec;
  state.lowSpec = wantLowSpec;
  localStorage.setItem(LOW_SPEC_KEY, wantLowSpec ? "1" : "0");

  stage2d.style.display = "none";
  stage3d.style.display = "block";
  const hint = document.getElementById("stage-3d-hint");
  if (hint) hint.style.display = "none";

  init3DScene();
  if (v3.renderer && lowSpecChanged) v3.renderer.setPixelRatio(pixelRatioForCurrentMode());
  // Пересобираем сцену, если сменился вид 3D: рёбра создаются в момент
  // ПОСТРОЕНИЯ меша, простой сменой видимости их не убрать.
  if (!v3.active || lowSpecChanged) build3DScene();
  v3.active = true;
  updateViewModeButtons(mode);
  btnView3D.disabled = false;
  btnView3DLight.disabled = false;
  on3DResize();
  requestRender3D();
}

btnView2D.addEventListener("click", () => {
  setViewMode("2d").catch(e => showToast("Ошибка: " + e.message, "warning"));
});
btnView3DLight.addEventListener("click", () => {
  setViewMode("3d-light").catch(e => showToast("Ошибка 3D: " + e.message, "warning"));
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
// ---------- Требования к загружаемым файлам + образцы ----------
// Один и тот же свёрнутый блок во всех формах загрузки. Разметку строит
// этот код по описаниям с сервера (/import-templates, см.
// app/import_templates.py) — так описание формата лежит рядом с кодом,
// который этот формат ПРОВЕРЯЕТ, и не разъезжается с ним (ровно на этом
// расхождении все 671 строка графика МС Project ушли в "пропущено", см.
// Docs/backlog.md, 2026-07-30).
//
// Место вставки — <div class="import-template" data-template="ключ">
// (через запятую, если форма принимает несколько разных файлов — так
// сделано у загрузки из папки Input).

function renderTemplateColumns(columns) {
  const rows = columns.map(c => `
    <tr>
      <td class="tpl-name">${escapeHtml(c.name)}${c.required ? "" : '<br><span class="tpl-optional">необязательна</span>'}</td>
      <td>${escapeHtml(c.format)}</td>
      <td class="tpl-example">${escapeHtml(c.example)}</td>
    </tr>`).join("");
  return `
    <h4>Колонки (заголовки — в первой строке)</h4>
    <div class="tpl-scroll">
      <table>
        <thead><tr><th>Колонка</th><th>Формат данных</th><th>Пример</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderTemplateSections(sections) {
  return sections.map(s => `
    <h4>${escapeHtml(s.title)}</h4>
    <ul>${s.lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`).join("");
}

function renderTemplateBlock(tpl) {
  const parts = [];
  parts.push(tpl.intro.map(p => `<p>${escapeHtml(p)}</p>`).join(""));
  if (tpl.sheet) parts.push(`<p><b>Лист:</b> ${escapeHtml(tpl.sheet)}</p>`);
  if (tpl.columns && tpl.columns.length) parts.push(renderTemplateColumns(tpl.columns));
  if (tpl.sections && tpl.sections.length) parts.push(renderTemplateSections(tpl.sections));
  if (tpl.notes && tpl.notes.length) {
    parts.push(`<h4>Важно</h4><ul>${tpl.notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`);
  }
  return `
    <details>
      <summary>Требования к файлу: ${escapeHtml(tpl.title)} (${escapeHtml(tpl.file_ext)})</summary>
      <div class="tpl-body">${parts.join("")}</div>
    </details>
    <div class="tpl-sample">
      <button class="btn btn-secondary" data-template-sample="${escapeHtml(tpl.key)}">
        Скачать образец ${escapeHtml(tpl.file_ext)} (5 строк)
      </button>
      <div class="tpl-warning">
        В образце — демонстрационные данные на реальных значениях справочников.
        Он нужен как шаблон для заполнения; загружать сам образец в рабочую базу не следует.
      </div>
    </div>`;
}

async function downloadTemplateSample(key, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Готовится…";
  try {
    const res = await fetch(`/import-templates/${encodeURIComponent(key)}/sample`);
    if (!res.ok) throw new Error(`Ошибка ${res.status}`);
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = match ? decodeURIComponent(match[1]) : `obrazec_${key}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast("Не удалось скачать образец: " + e.message, "warning");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function initImportTemplates() {
  const holders = document.querySelectorAll(".import-template[data-template]");
  if (!holders.length) return;
  let byKey;
  try {
    const data = await api("/import-templates");
    byKey = new Map(data.templates.map(t => [t.key, t]));
  } catch (e) {
    return; // блок просто останется пустым, формы загрузки работают как раньше
  }
  holders.forEach(holder => {
    const keys = holder.dataset.template.split(",").map(s => s.trim()).filter(Boolean);
    holder.innerHTML = keys.map(k => (byKey.has(k) ? renderTemplateBlock(byKey.get(k)) : "")).join("");
  });
  // Один делегированный обработчик на документ, а не по одному на кнопку:
  // блоков шесть, кнопок в них девять, и все они перерисовываются целиком.
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-template-sample]");
    if (button) downloadTemplateSample(button.dataset.templateSample, button);
  });
}

async function bootApp() {
  const ok = await checkAuth();
  if (!ok) return;
  try {
    const settings = await api("/settings/info-plate");
    state.lateThresholdDays = settings.late_threshold_days;
  } catch (e) {
    // тихо — допстрока/подсказка просто будут использовать порог по
    // умолчанию (0), пока настройка недоступна (напр. только что
    // развёрнутый сервер)
  }
  initImportTemplates();  // без await — формы загрузки открываются не сразу
  await loadSourceFiles();
  await loadPlan(false); // первая загрузка — вписать схему целиком
  startPolling();        // совместная работа: подхватывать чужие правки
}

bootApp();

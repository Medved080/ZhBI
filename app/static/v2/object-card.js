// V2: «Карточка объекта» — ОДНА форма объекта на весь интерфейс (2026-10-20, запрос пользователя: «при переходе к объекту из шапки, из
// справочника и с карты открываются разные формы — объединить, в приоритете форма из шапки с фото, картой и кнопками перехода к модели»).
//
// Отрисовка вынесена из object-home.js, чтобы одну и ту же карточку показывали: заглавная страница объекта (выбор в шапке, переход с карты),
// правая область справочника «Проекты и объекты» (щелчок по объекту в дереве) — и там, и там правка реквизитов идёт ВНУТРИ карточки
// (кнопка «Изменить реквизиты» переключает её в форму-редактор, projects-objects.js).
//
// Данные — запись объекта из `GET /objects` (команда, адрес, координаты, СМУ, фото), на клиенте ничего не считается. Карта — отдельный ES-модуль
// map.js с ленивым import(); при уходе с карточки карта обязательно remove(): у каждой карты свой graphics-контекст, и без этого карты в
// браузере перестают строиться (CLAUDE.md).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS = { perspective: "Перспективный", active: "В работе", suspended: "Приостановлен", completed: "Завершён", archived: "Архивный" };
const KIND = { zhbi: "Учёт ЖБИ по чертежу", mfr: "Учёт МФР по модели" };
// Роли проектной команды — тот же список и порядок, что TEAM_ROLES в app/object_team.py.
const TEAM = [["dir_project", "Директор проекта"], ["head_project", "Руководитель проекта"], ["pm_office", "Проектный офис"],
  ["estimate", "Сметный отдел"], ["pto", "ПТО"], ["supply", "Снабжение"], ["site_chief", "Нач. участка"], ["gip", "ГИП"]];
// Куда можно перейти с карточки: (экран, подпись). Показываются только доступные на этом объекте.
const LINKS = [["ws-model", "Модель: схема 2D/3D"], ["ws-mfr", "Модель МФР"], ["ws-picker", "АРМ комплектовщика"], ["ws-foreman", "АРМ прораба"],
  ["report-status", "Статус монтажа"], ["report-dynamics", "Динамика поставки и монтажа"], ["report-completion", "Статус комплектации"],
  ["headcount", "Ввод численности"]];

let mapModule = null;
function ensureMapModule(api) {
  if (!mapModule) {
    mapModule = import("/static/map.js").then((m) => { m.init({ api: (path) => api.get(path) }); return m; });
  }
  return mapModule;
}

const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "http:" || x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; } };
const row = (k, v) => (v === null || v === undefined || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);

// page — элемент с классом oh-page (страница равна области и не прокручивается; контейнер должен иметь определённую высоту);
// o — запись объекта; opts:
//   api, go, isAllowed — кнопки переходов (только если объект — текущий в шапке: права считаются по нему), иначе isAllowed не передают;
//   openObject — «Перейти к объекту» для объекта, который не текущий (делает его текущим и открывает заглавную страницу);
//   onEdit — «Изменить реквизиты» / «Указать адрес» (нет права править — не передают).
// Возвращает { destroy } — обязательно вызвать перед перерисовкой и при уходе.
export function renderObjectCard(page, o, { api, go, isAllowed, openObject, onEdit } = {}) {
  let dead = false, pin = null;
  const coords = o.lat != null && o.lon != null;
  // «Тип учёта» показываем, только когда он что-то значит: у МФР он ставится осознанно, а у ЖБИ по умолчанию стоит у ЛЮБОГО объекта
  // (колонка objects.kind NOT NULL DEFAULT 'zhbi'), поэтому без загруженного чертежа подпись «ЖБИ по чертежу» вводила бы в заблуждение.
  const kindText = o.kind === "mfr" || (o.kind === "zhbi" && o.current_source_file) ? (KIND[o.kind] || o.kind) : "";
  // Отв. подразделение и директор СМУ — в «Проектной команде», как в форме и в «Справочнике ОС WEB» (2026-10-07).
  const team = row("Отв. подразделение", esc(o.smu_name)) + row("Директор СМУ", esc(o.smu_director_name))
    + TEAM.map(([k, label]) => row(label, o.team?.[k]?.name ? esc(o.team[k].name) : "")).join("");
  const media = safeUrl(o.media_url);
  const links = isAllowed
    ? LINKS.filter(([key]) => isAllowed(key)).map(([key, label]) => `<button type="button" class="v2-btn v2-primary" data-go="${esc(key)}">${esc(label)}</button>`).join("")
    : "";
  const open = openObject ? `<button type="button" class="v2-btn v2-primary" data-open-object>Перейти к объекту</button>` : "";
  const edit = onEdit ? `<button type="button" class="v2-btn" data-edit>Изменить реквизиты</button>` : "";
  page.innerHTML = `
    <div class="oh-head">
      <div class="oh-titles">
        <div class="oh-crumb">${esc(o.project_name || "")}</div>
        <h2 class="oh-title">${esc(o.name)}</h2>
        <div class="oh-sub"><span class="oh-chip oh-chip-${esc(o.status)}">${esc(STATUS[o.status] || o.status)}</span>
          ${kindText ? `<span>${esc(kindText)}</span>` : ""}${o.address ? `<span>${esc(o.address)}</span>` : ""}</div>
      </div>
      <div class="oh-actions">${open}${links}${edit}</div>
    </div>
    <div class="oh-grid">
      <div class="oh-col">
        <figure class="oh-photo${o.has_photo ? "" : " oh-photo-empty"}" title="${o.has_photo ? "" : "Фото не добавлено — показана заглушка"}">
          <img src="${o.has_photo ? `/objects/${o.id}/photo?t=${Date.now()}` : "/static/object-photo-placeholder.webp"}" alt="${o.has_photo ? "Фото объекта" : "Фото не добавлено"}"
            data-fallback="/static/object-photo-placeholder.webp">
        </figure>
        <section class="oh-card"><h3>Реквизиты</h3><dl class="oh-dl">
          ${row("Проект", esc(o.project_name))}${row("Статус", esc(STATUS[o.status] || o.status))}${row("Тип учёта", esc(kindText))}
          ${row("Адрес", esc(o.address))}${row("Координаты", coords ? `${esc(o.lat)}, ${esc(o.lon)}` : "")}
          ${media ? row("Фото и видео", `<a href="${esc(media)}" target="_blank" rel="noopener noreferrer">открыть папку</a>`) : ""}
          ${row("Описание", esc(o.description))}</dl></section>
      </div>
      <div class="oh-col">
        <section class="oh-card"><h3>Проектная команда</h3>${team ? `<dl class="oh-dl">${team}</dl>` : `<p class="v2-muted">Команда не заполнена${onEdit ? " — заполните её кнопкой «Изменить реквизиты»" : ""}.</p>`}</section>
        ${o.kind === "mfr" ? "" : `<section class="oh-card oh-card-uchet"><h3>Учёт</h3><dl class="oh-dl">
          ${row("Элементов на схеме", String(o.elements_current ?? 0))}${row("Чертёж", esc(o.current_source_file))}</dl>
          ${!o.current_source_file ? `<p class="v2-muted">Чертёж ещё не загружен — схемы пока нет.</p>` : ""}</section>`}
      </div>
      <section class="oh-mapbox" aria-label="Расположение объекта на карте">
        ${coords ? `<div class="oh-map" id="oh-map"></div><div class="oh-mapcap">${esc(o.address || o.name)} · ${esc(o.lat)}, ${esc(o.lon)}</div>`
          : `<div class="oh-nomap"><strong>Расположение не задано</strong><p class="v2-muted">У объекта нет координат: укажите адрес — точка определится по нему и появится на карте.</p>
              ${onEdit ? `<button type="button" class="v2-btn v2-primary" data-edit>Указать адрес</button>` : ""}</div>`}
      </section>
    </div>`;
  for (const b of page.querySelectorAll("[data-go]")) b.addEventListener("click", () => go?.(b.dataset.go));
  page.querySelector("[data-open-object]")?.addEventListener("click", () => openObject?.());
  for (const b of page.querySelectorAll("[data-edit]")) b.addEventListener("click", () => onEdit?.());
  // Фото не загрузилось (файл удалён с диска, нет доступа) — вместо пустой рамки показываем ту же заглушку.
  const img = page.querySelector(".oh-photo img");
  img?.addEventListener("error", () => { if (img.getAttribute("src") !== img.dataset.fallback) { img.src = img.dataset.fallback; img.closest(".oh-photo")?.classList.add("oh-photo-empty"); } });
  if (coords) {
    const box = page.querySelector("#oh-map");
    ensureMapModule(api).then((m) => m.createPinMap(box, { lat: o.lat, lon: o.lon, canEdit: false, onMove: () => {} }))
      .then((p) => { if (dead || !box.isConnected) { try { p.карта.remove(); } catch (e) { /* контекст мог быть потерян */ } return; } pin = p; })
      .catch((e) => { box.innerHTML = `<div class="v2-note">Карта недоступна: ${esc(e.message || "")}</div>`; });
  }
  return {
    destroy: () => { dead = true; if (pin) { try { pin.карта.remove(); } catch (e) { /* контекст уже мог быть потерян */ } pin = null; } },
  };
}

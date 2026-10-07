// V2: «Карточка объекта» — заглавная страница объекта (2026-10-06, запрос пользователя после протокола «Развитие WEB 4Q26»).
//
// Открывается при каждом выборе объекта в переключателе шапки (main.js: changeObject(id, { card: true })) и показывает паспорт
// объекта на весь экран: слева — реквизиты, проектная команда и показатели учёта, справа — карта с отметкой места расположения
// (та же мини-карта createPinMap, что в форме «Проекты и объекты», только без правки точки). Отсюда переходят в рабочие места и отчёты.
//
// Данные — `GET /objects` (тот же ответ, что у справочника «Проекты и объекты»: команда, адрес, координаты, СМУ), ничего не
// считается на клиенте. Карта — отдельный ES-модуль map.js с ленивым import(); при уходе с экрана карта обязательно remove(): у
// каждой карты свой graphics-контекст, и без этого карты в браузере перестают строиться (CLAUDE.md).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS = { perspective: "Перспективный", active: "В работе", suspended: "Приостановлен", completed: "Завершён", archived: "Архивный" };
const KIND = { zhbi: "Учёт ЖБИ по чертежу", mfr: "Учёт МФР по модели" };
// Роли проектной команды — тот же список и порядок, что TEAM_ROLES в app/object_team.py.
const TEAM = [["dir_project", "Директор проекта"], ["head_project", "Руководитель проекта"], ["pm_office", "Проектный офис"],
  ["estimate", "Сметный отдел"], ["pto", "ПТО"], ["supply", "Снабжение"], ["site_chief", "Нач. участка"], ["gip", "ГИП"]];
// Куда можно перейти с карточки: (экран, подпись). Показываются только доступные на этом объекте.
const LINKS = [["ws-model", "Модель: схема 2D/3D"], ["ws-mfr", "Модель МФР"], ["ws-picker", "АРМ комплектовщика"], ["ws-foreman", "АРМ прораба"],
  ["report-status", "Статус монтажа"], ["report-dynamics", "Динамика поставки и монтажа"], ["report-completion", "Статус комплектации"]];

let mapModule = null;
function ensureMapModule(api) {
  if (!mapModule) {
    mapModule = import("/static/map.js").then((m) => { m.init({ api: (path) => api.get(path) }); return m; });
  }
  return mapModule;
}

const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "http:" || x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; } };

export function mountObjectHome(el, { api, objectId, go, isAllowed }) {
  let dead = false, pin = null;
  el.className = "v2-page v2-app";   // без собственной прокрутки: страница по высоте равна рабочей области
  el.innerHTML = `<div class="oh-page"><p class="v2-muted">Загрузка…</p></div>`;
  const page = el.querySelector(".oh-page");

  const row = (k, v) => (v === null || v === undefined || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);

  function paint(o) {
    const coords = o.lat != null && o.lon != null;
    // «Тип учёта» показываем, только когда он что-то значит: у МФР он ставится осознанно, а у ЖБИ по умолчанию стоит у ЛЮБОГО объекта
    // (колонка objects.kind NOT NULL DEFAULT 'zhbi'), поэтому без загруженного чертежа подпись «ЖБИ по чертежу» вводила бы в заблуждение.
    const kindText = o.kind === "mfr" || (o.kind === "zhbi" && o.current_source_file) ? (KIND[o.kind] || o.kind) : "";
    // Отв. подразделение и директор СМУ — в «Проектной команде», как в форме и в «Справочнике ОС WEB» (2026-10-07).
    const team = row("Отв. подразделение", esc(o.smu_name)) + row("Директор СМУ", esc(o.smu_director_name))
      + TEAM.map(([k, label]) => row(label, o.team?.[k]?.name ? esc(o.team[k].name) : "")).join("");
    const media = safeUrl(o.media_url);
    const links = LINKS.filter(([key]) => isAllowed?.(key)).map(([key, label]) => `<button type="button" class="v2-btn v2-primary" data-go="${esc(key)}">${esc(label)}</button>`).join("");
    page.innerHTML = `
      <div class="oh-head">
        <div class="oh-titles">
          <div class="oh-crumb">${esc(o.project_name || "")}</div>
          <h2 class="oh-title">${esc(o.name)}</h2>
          <div class="oh-sub"><span class="oh-chip oh-chip-${esc(o.status)}">${esc(STATUS[o.status] || o.status)}</span>
            ${kindText ? `<span>${esc(kindText)}</span>` : ""}${o.address ? `<span>${esc(o.address)}</span>` : ""}</div>
        </div>
        <div class="oh-actions">${links}<button type="button" class="v2-btn" data-go="projects-objects">Изменить реквизиты</button></div>
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
          <section class="oh-card"><h3>Проектная команда</h3>${team ? `<dl class="oh-dl">${team}</dl>` : `<p class="v2-muted">Команда не заполнена — укажите её в «Проекты и объекты».</p>`}</section>
          ${o.kind === "mfr" ? "" : `<section class="oh-card oh-card-uchet"><h3>Учёт</h3><dl class="oh-dl">
            ${row("Элементов на схеме", String(o.elements_current ?? 0))}${row("Чертёж", esc(o.current_source_file))}</dl>
            ${!o.current_source_file ? `<p class="v2-muted">Чертёж ещё не загружен — схемы пока нет.</p>` : ""}</section>`}
        </div>
        <section class="oh-mapbox" aria-label="Расположение объекта на карте">
          ${coords ? `<div class="oh-map" id="oh-map"></div><div class="oh-mapcap">${esc(o.address || o.name)} · ${esc(o.lat)}, ${esc(o.lon)}</div>`
            : `<div class="oh-nomap"><strong>Расположение не задано</strong><p class="v2-muted">У объекта нет координат: укажите адрес в «Проекты и объекты» — точка определится по нему и появится на карте.</p>
                <button type="button" class="v2-btn v2-primary" data-go="projects-objects">Указать адрес</button></div>`}
        </section>
      </div>`;
    for (const b of page.querySelectorAll("[data-go]")) b.addEventListener("click", () => go?.(b.dataset.go));
    // Фото не загрузилось (файл удалён с диска, нет доступа) — вместо пустой рамки показываем ту же заглушку.
    const img = page.querySelector(".oh-photo img");
    img?.addEventListener("error", () => { if (img.getAttribute("src") !== img.dataset.fallback) { img.src = img.dataset.fallback; img.closest(".oh-photo")?.classList.add("oh-photo-empty"); } });
    if (coords) {
      const box = page.querySelector("#oh-map");
      ensureMapModule(api).then((m) => m.createPinMap(box, { lat: o.lat, lon: o.lon, canEdit: false, onMove: () => {} }))
        .then((p) => { if (dead || !box.isConnected) { try { p.карта.remove(); } catch (e) { /* контекст мог быть потерян */ } return; } pin = p; })
        .catch((e) => { box.innerHTML = `<div class="v2-note">Карта недоступна: ${esc(e.message || "")}</div>`; });
    }
  }

  (async () => {
    try {
      const list = await api.get("/objects");
      if (dead) return;
      const o = list.find((x) => x.id === objectId);
      if (!o) { page.innerHTML = `<p class="v2-note">Объект недоступен или не найден.</p>`; return; }
      paint(o);
    } catch (e) {
      if (!dead) page.innerHTML = `<p class="v2-auth-error" role="alert">Не удалось загрузить объект: ${esc(e?.detail || e?.message || e)}</p>`;
    }
  })();

  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    destroy: () => { dead = true; if (pin) { try { pin.карта.remove(); } catch (e) { /* контекст уже мог быть потерян */ } pin = null; } },
  };
}

// Карта проектов (2026-09-07).
//
// Отдельный модуль с ленивой загрузкой: MapLibre весит под мегабайт, и
// тянуть его на каждое открытие страницы ради экрана, куда заходят раз в
// день, незачем. Приём тот же, что у сцены Three.js.
//
// Подложка — файл PMTiles на нашем же сервере: наружу карта не ходит вовсе,
// потому что сервер в интернет не выпущен. Файла нет — рисуем точки на
// пустом фоне: взаимное расположение площадок видно и так.

let deps = null;          // {api, escapeHtml, showToast, switchObject}
let maplibre = null;      // window.maplibregl после загрузки UMD-сборки
let pmtilesReady = false;

export function init(зависимости) {
  deps = зависимости;
}

// MapLibre поставляется единой UMD-сборкой и кладёт себя в window; pmtiles —
// обычный модуль. Оба со своего сервера, поэтому CSP `script-src 'self'`
// пропускает и то и другое.
async function ensureLibs() {
  if (maplibre && pmtilesReady) return maplibre;
  if (!window.maplibregl) {
    await new Promise((resolve, reject) => {
      const стиль = document.createElement("link");
      стиль.rel = "stylesheet";
      стиль.href = "/static/vendor/maplibre/maplibre-gl.css";
      document.head.appendChild(стиль);
      const скрипт = document.createElement("script");
      скрипт.src = "/static/vendor/maplibre/maplibre-gl.js";
      скрипт.onload = resolve;
      скрипт.onerror = () => reject(new Error("не удалось загрузить библиотеку карты"));
      document.head.appendChild(скрипт);
    });
  }
  maplibre = window.maplibregl;
  if (!pmtilesReady) {
    // Берётся САМОДОСТАТОЧНАЯ сборка pmtiles (dist/pmtiles.js), а не её
    // ES-вариант: тот импортирует стороннюю библиотеку распаковки по имени
    // «fflate», и браузер такой импорт не разрешает — карта падала на
    // «Failed to resolve module specifier».
    if (!window.pmtiles) {
      await new Promise((resolve, reject) => {
        const скрипт = document.createElement("script");
        скрипт.src = "/static/vendor/pmtiles/pmtiles.js";
        скрипт.onload = resolve;
        скрипт.onerror = () => reject(new Error("не удалось загрузить чтение подложки"));
        document.head.appendChild(скрипт);
      });
    }
    // Протокол pmtiles:// учит MapLibre читать наш файл диапазонами байт —
    // без него пришлось бы поднимать тайловый сервер.
    const протокол = new window.pmtiles.Protocol();
    maplibre.addProtocol("pmtiles", протокол.tile);
    pmtilesReady = true;
  }
  return maplibre;
}

// Цвет точки по доле смонтированного. Та же логика, что у статусов на схеме:
// серое — не начато, зелёное — закончено.
function цветПоДоле(percent) {
  if (percent === null || percent === undefined) return "#9e9e9e";
  if (percent >= 100) return "#2e7d32";
  if (percent >= 60) return "#7cb342";
  if (percent >= 30) return "#f9a825";
  if (percent > 0) return "#ef6c00";
  return "#9e9e9e";
}

function стильКарты(config) {
  const источники = {};
  const слои = [{
    id: "фон", type: "background",
    paint: { "background-color": "#eceff1" },
  }];

  // Подложка из интернета — если администратор её включил. Растровая: это
  // готовые картинки, им не нужны ни шрифты, ни файл на диске.
  if (config.online && config.online_url) {
    источники.osm = {
      type: "raster",
      tiles: [config.online_url],
      tileSize: 256,
      maxzoom: 19,
      attribution: config.attribution,
    };
    слои.push({ id: "osm", type: "raster", source: "osm" });
  }
  (config.basemaps || []).filter((b) => !b.problem).forEach((b, i) => {
    const имя = "basemap" + i;
    источники[имя] = {
      type: "vector",
      url: "pmtiles://" + b.url,
      attribution: config.attribution,
    };
    // Слои подложки намеренно скупые: земля, вода, дороги, здания. Полный
    // стиль Protomaps — это сорок слоёв со шрифтами и спрайтами, а карте
    // проектов нужна узнаваемая подложка, а не самостоятельная карта.
    слои.push(
      { id: имя + "-земля", type: "fill", source: имя, "source-layer": "earth",
        paint: { "fill-color": "#f5f5f0" } },
      { id: имя + "-вода", type: "fill", source: имя, "source-layer": "water",
        paint: { "fill-color": "#bbdefb" } },
      { id: имя + "-дороги", type: "line", source: имя, "source-layer": "roads",
        paint: { "line-color": "#e0e0e0", "line-width": 1 } },
      { id: имя + "-здания", type: "fill", source: имя, "source-layer": "buildings",
        minzoom: 13, paint: { "fill-color": "#e0e0e0" } },
      // Названия населённых пунктов: без них подложка — набор цветных пятен,
      // и понять, у какого города стоит точка, нельзя.
      { id: имя + "-подписи", type: "symbol", source: имя, "source-layer": "places",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
        },
        paint: {
          "text-color": "#455a64",
          "text-halo-color": "#ffffff", "text-halo-width": 1.5,
        } },
    );
  });
  return {
    version: 8,
    // Глифы — это НЕ шрифт страницы: подписи на векторной карте рисуются
    // заранее подготовленными картинками символов, и без этого адреса
    // символьные слои молча не появляются (ровно так пропало число объектов
    // в кластере). Лежат у нас же, см. vendor/glyphs/README.txt.
    glyphs: "/static/vendor/glyphs/{fontstack}/{range}.pbf",
    sources: источники,
    layers: слои,
  };
}

function точкиGeoJSON(объекты) {
  return {
    type: "FeatureCollection",
    features: объекты.map((o) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [o.lon, o.lat] },
      properties: Object.assign({}, o, { color: цветПоДоле(o.percent) }),
    })),
  };
}

/**
 * Построить карту в контейнере.
 *
 * Возвращает объект с методами обновления: экран карты и мини-карта в форме
 * объекта — это одна и та же машинка с разными настройками.
 */
export async function createMap(контейнер, { center, zoom, interactive = true } = {}) {
  const ml = await ensureLibs();
  const config = await deps.api("/map/config");
  const карта = new ml.Map({
    container: контейнер,
    style: стильКарты(config),
    center: center || [config.default_center.lon, config.default_center.lat],
    zoom: zoom === undefined ? config.default_zoom : zoom,
    interactive,
    attributionControl: false,
  });
  // Указание авторства OpenStreetMap — требование лицензии ODbL, а не
  // украшение: без него подложку использовать нельзя.
  карта.addControl(new ml.AttributionControl({
    compact: true, customAttribution: config.attribution,
  }));
  if (interactive) карта.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
  return { карта, config, ml };
}

/**
 * Экран «Карта проектов»: точки объектов, всплывашка, переход на объект.
 */
export async function renderProjectMap(контейнер, { onOpenObject, onEmptyCoords }) {
  const { карта, config, ml } = await createMap(контейнер, {});
  const данные = await deps.api("/map/objects");

  // Ждём готовности стиля ОПРОСОМ, а не подпиской на событие.
  //
  // С подпиской получалась гонка в обе стороны: пока идёт запрос за
  // объектами, карта успевает загрузиться, и подписка на «load» опаздывает
  // навсегда — экран остаётся с надписью «Загрузка карты…». Обратная
  // проверка через loaded() тоже не годится: он ложный, пока есть
  // незавершённые запросы тайлов, то есть уже ПОСЛЕ события load.
  //
  // Опрос каждые сто миллисекунд гонок не имеет вовсе. Терпения — двадцать
  // секунд: при первом открытии библиотека карты (почти мегабайт) грузится
  // одновременно со схемой объекта, и десяти секунд там не хватало.
  await new Promise((resolve, reject) => {
    let срок = Date.now() + 20000;
    const проверить = () => {
      if (карта.isStyleLoaded()) return resolve();
      // Пока вкладка скрыта, браузер не вызывает кадры отрисовки, и карта
      // не грузится в принципе. Отсчёт терпения в это время не идёт: иначе
      // карта, открытая в фоновой вкладке, встречала бы человека ложным
      // сообщением «не успела загрузиться».
      if (document.hidden) срок = Date.now() + 20000;
      if (Date.now() > срок) {
        return reject(new Error("карта не успела загрузиться за 20 секунд"));
      }
      setTimeout(проверить, 100);
    };
    проверить();
  });

  карта.addSource("объекты", {
    type: "geojson",
    data: точкиGeoJSON(данные.objects),
    // Кластеризация: при двух сотнях объектов на одной площадке точки
    // сливаются в кляксу, и понять, сколько их там, нельзя.
    cluster: true,
    clusterRadius: 44,
    clusterMaxZoom: 12,
  });

  карта.addLayer({
    id: "кластеры", type: "circle", source: "объекты",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#546e7a",
      "circle-radius": ["step", ["get", "point_count"], 16, 5, 20, 20, 26],
      "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
    },
  });
  карта.addLayer({
    id: "кластеры-число", type: "symbol", source: "объекты",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
    },
    paint: { "text-color": "#ffffff" },
  });
  карта.addLayer({
    id: "объекты-точки", type: "circle", source: "объекты",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["get", "color"],
      // Размер по числу элементов: большая стройка должна и выглядеть
      // крупнее, иначе карта врёт о масштабе работ.
      "circle-radius": ["interpolate", ["linear"], ["get", "elements"],
        0, 6, 100, 8, 1000, 11, 10000, 15],
      "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
    },
  });

  const попап = new ml.Popup({ closeButton: true, closeOnClick: true, maxWidth: "320px" });

  карта.on("click", "объекты-точки", (e) => {
    const p = e.features[0].properties;
    const доля = (p.percent === null || p.percent === undefined || p.percent === "null")
      ? "—" : p.percent + " %";
    const узел = document.createElement("div");
    узел.className = "map-popup";
    узел.innerHTML = `
      <div class="map-popup-project">${deps.escapeHtml(p.project_name || "")}</div>
      <div class="map-popup-name">${deps.escapeHtml(p.name)}</div>
      ${p.address ? `<div class="map-popup-addr">${deps.escapeHtml(p.address)}</div>` : ""}
      <div class="map-popup-facts">
        Элементов: ${p.elements}. Смонтировано: ${доля}.
        ${p.smr_start || p.smr_end ? `<br/>Сроки СМР: ${p.smr_start || "—"} — ${p.smr_end || "—"}.` : ""}
        ${p.inherited === true || p.inherited === "true"
          ? `<br/><span class="hint-text">Координаты взяты у проекта.</span>` : ""}
      </div>
      <button type="button" class="btn btn-sm btn-primary map-popup-open">Открыть объект</button>`;
    узел.querySelector(".map-popup-open").addEventListener("click", () => {
      попап.remove();
      onOpenObject(Number(p.id));
    });
    попап.setLngLat(e.lngLat).setDOMContent(узел).addTo(карта);
  });

  // Клик по кластеру приближает к нему: разворачивать список в попапе
  // бессмысленно, там могут быть десятки объектов.
  карта.on("click", "кластеры", async (e) => {
    const [ф] = карта.queryRenderedFeatures(e.point, { layers: ["кластеры"] });
    const zoom = await карта.getSource("объекты").getClusterExpansionZoom(ф.properties.cluster_id);
    карта.easeTo({ center: ф.geometry.coordinates, zoom });
  });

  ["объекты-точки", "кластеры"].forEach((слой) => {
    карта.on("mouseenter", слой, () => { карта.getCanvas().style.cursor = "pointer"; });
    карта.on("mouseleave", слой, () => { карта.getCanvas().style.cursor = ""; });
  });

  function показатьВсе() {
    const точки = данные.objects;
    if (!точки.length) return;
    const границы = точки.reduce(
      (b, o) => b.extend([o.lon, o.lat]),
      new maplibre.LngLatBounds([точки[0].lon, точки[0].lat], [точки[0].lon, точки[0].lat]));
    карта.fitBounds(границы, { padding: 60, maxZoom: 14, duration: 0 });
  }
  показатьВсе();

  // Годные и негодные файлы подложки различает СЕРВЕР (см. project_map.py):
  // ошибка чтения внутри библиотеки уходит только в консоль браузера, и
  // человек видел бы пустой фон без единого слова о причине.
  const негодные = (config.basemaps || []).filter((b) => b.problem);
  // Подложка есть, если годен хоть один файл ИЛИ включена карта из
  // интернета: иначе экран сообщал бы «подложка не загружена», показывая
  // при этом карту.
  const естьПодложка = !!config.online
    || (config.basemaps || []).some((b) => !b.problem);
  const бедаСПодложкой = негодные.length
    ? `Файл подложки «${негодные[0].name}» не годится: ${негодные[0].problem}.`
    : null;
  // Признак передаётся В колбэк, а не читается вызывающим кодом из
  // результата: результат присваивается только ПОСЛЕ возврата из этой
  // функции, и заметка «подложка не загружена» не показывалась никогда.
  if (onEmptyCoords) {
    onEmptyCoords(данные.without_coords, данные.objects.length,
                  естьПодложка, бедаСПодложкой);
  }
  return {
    карта, объекты: данные.objects, показатьВсе, естьПодложка,
    навести: (id) => {
      const o = данные.objects.find((x) => x.id === id);
      if (o) карта.easeTo({ center: [o.lon, o.lat], zoom: 15 });
    },
  };
}

/**
 * Мини-карта в форме объекта: один перетаскиваемый пин.
 *
 * Координаты в классификаторе не хранятся — ни в КЛАДР, ни в ГАР, — поэтому
 * ставит их человек. Перетащить пин по карте занимает секунды, а вписать
 * шесть знаков после запятой руками не может никто.
 */
export async function createPinMap(контейнер, { lat, lon, onMove, canEdit }) {
  const есть = lat !== null && lat !== undefined && lon !== null && lon !== undefined;
  const { карта, ml } = await createMap(контейнер, {
    center: есть ? [lon, lat] : undefined,
    zoom: есть ? 15 : undefined,
  });
  const маркер = new ml.Marker({ draggable: !!canEdit, color: "#c62828" })
    .setLngLat(есть ? [lon, lat] : карта.getCenter())
    .addTo(карта);
  if (canEdit) {
    маркер.on("dragend", () => {
      const p = маркер.getLngLat();
      onMove(Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)));
    });
    // Клик по карте тоже ставит пин: тащить его через полгорода — лишняя
    // работа, когда нужное место видно на экране.
    карта.on("click", (e) => {
      маркер.setLngLat(e.lngLat);
      onMove(Number(e.lngLat.lat.toFixed(6)), Number(e.lngLat.lng.toFixed(6)));
    });
  }
  return {
    карта, маркер,
    показать: (широта, долгота) => {
      маркер.setLngLat([долгота, широта]);
      карта.easeTo({ center: [долгота, широта], zoom: Math.max(карта.getZoom(), 14) });
    },
  };
}

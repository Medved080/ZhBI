// Карта проектов (2026-09-07).
//
// Отдельный модуль с ленивой загрузкой: MapLibre весит под мегабайт, и
// тянуть его на каждое открытие страницы ради экрана, куда заходят раз в
// день, незачем. Приём тот же, что у сцены Three.js.
//
// Подложка — ОДИН из двух явных режимов (разбор 2026-09-22,
// Docs/v2-progress/basemap.md): «с сервера» (файлы PMTiles в data/map,
// наружу не ходит) или «из интернета» (растр OpenStreetMap, если его
// включил администратор). Вместе они не рисуются никогда. Ни того, ни
// другого — точки на пустом фоне: взаимное расположение площадок видно и так.

let deps = null;          // {api, escapeHtml, showToast, switchObject, statusColor, statusLabel}
let maplibre = null;      // window.maplibregl после загрузки UMD-сборки
let pmtilesReady = false;

export function init(зависимости) {
  deps = зависимости;
}

// ------------------------------------------------ геокодирование по адресу
//
// Ни КЛАДР, ни ГАР координат не содержат — единственный способ определить
// их автоматически заключается в том, чтобы спросить внешний геокодер.
// Тот же выключатель «Карта из интернета», что и у подложки: это один и тот
// же вопрос, можно ли браузеру ходить на сервисы OpenStreetMap.
let онлайнКонфиг = null;

async function получитьОнлайнКонфиг() {
  if (!онлайнКонфиг) онлайнКонфиг = await deps.api("/map/config");
  return онлайнКонфиг;
}

/**
 * Найти координаты через Nominatim (геокодер OpenStreetMap).
 *
 * `query` — либо готовая строка (свободный ввод адреса), либо разобранные
 * части `{city, street, county, state, country}` (адрес по классификатору).
 * Разбор частей — не прихоть: свободную строку «г Москва» геокодер ОДНАЖДЫ
 * прочитал как «гора Москва» и вернул точку в Красноярском крае за четыре
 * тысячи километров от настоящей Москвы — сокращение «г» перед названием
 * оказалось неоднозначным для его разбора текста. Части адреса у классификатора
 * УЖЕ лежат без сокращений (`address_parts[...].name`), и структурный поиск,
 * где «город» ищется в поле «город», а не гадается по свободному тексту,
 * этой ошибки не допускает.
 *
 * Возвращает null, а не бросает исключение, если геокодирование выключено,
 * запрос пустой или сервис не ответил: отсутствие координат — обычное дело,
 * а не повод ломать форму.
 *
 * Без пользовательских заголовков нарочно: любой добавленный заголовок
 * превращает простой GET в предварительный CORS-запрос, а Referer, который
 * браузер посылает сам, уже определяет наше приложение перед сервисом —
 * ровно то, что требует политика использования Nominatim.
 */
export async function geocodeAddress(query) {
  const config = await получитьОнлайнКонфиг();
  if (!config.online || !config.geocode_url) return null;

  const параметры = new URLSearchParams({
    format: "json", limit: "1", countrycodes: "ru", "accept-language": "ru",
  });
  if (typeof query === "string") {
    const строка = query.trim();
    if (строка.length < 3) return null;
    параметры.set("q", строка);
  } else if (query && typeof query === "object") {
    let естьЧтоИскать = false;
    for (const ключ of ["city", "street", "county", "state", "country"]) {
      if (query[ключ]) { параметры.set(ключ, query[ключ]); естьЧтоИскать = true; }
    }
    if (!естьЧтоИскать) return null;
  } else {
    return null;
  }

  try {
    const r = await fetch(config.geocode_url + "?" + параметры.toString());
    if (!r.ok) return null;
    const items = await r.json();
    if (!items.length) return null;
    const lat = parseFloat(items[0].lat), lon = parseFloat(items[0].lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
  } catch (e) {
    return null;   // офлайн или сеть недоступна — не повод ронять форму
  }
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
    maplibre.addProtocol("zhbi-glyphs", загрузитьГлифы);
    pmtilesReady = true;
  }
  return maplibre;
}

// Глифы подписей — только через этот протокол, не прямым адресом.
//
// Причина «прямоугольников» на подложке (2026-09-22): ранее были лишь два
// диапазона глифов (0-255 и 1024-1279), а в названиях из OSM встречаются
// «№», «–», «’», латиница с диакритикой. Запрос недостающего диапазона
// отвечал 404, воркер MapLibre ронял разбор ВСЕГО тайла, а 404 он считает
// «тайла нет» — тайл тихо пустел целиком: без суши, воды и дорог, без
// единой ошибки. Недостающий диапазон теперь — пустой набор глифов:
// тайл цел, пропадает только сам отсутствующий символ в подписи.
const ДИАПАЗОНЫ_ГЛИФОВ = new Set([
  "0-255", "256-511", "512-767", "768-1023", "1024-1279",
  "4096-4351", "8192-8447", "8448-8703",
]);

async function загрузитьГлифы(параметры, прерывание) {
  const путь = параметры.url.slice("zhbi-glyphs://".length);   // «шрифт/диапазон»
  const граница = путь.lastIndexOf("/");
  const шрифт = decodeURIComponent(путь.slice(0, граница));
  const диапазон = путь.slice(граница + 1);
  const пусто = { data: new ArrayBuffer(0) };
  if (!ДИАПАЗОНЫ_ГЛИФОВ.has(диапазон)) return пусто;
  const ответ = await fetch(`/static/vendor/glyphs/${encodeURIComponent(шрифт)}/${диапазон}.pbf`,
    { signal: прерывание.signal });
  return ответ.ok ? { data: await ответ.arrayBuffer() } : пусто;
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

// ------------------------------------------------------------ режим подложки
//
// Режим выбирает ЗРИТЕЛЬ (переключатель на карте, если доступны оба), по
// умолчанию — по настройке администратора: включил «Карту из интернета» —
// она и открывается. Выбор запоминается в браузере (localStorage), сам по
// себе режим не меняется: офлайн-режим не ходит в интернет ни при каких
// условиях, в том числе если файл подложки не читается.
const КЛЮЧ_РЕЖИМА = "zhbi.map.basemap";

function режимыПодложки(config) {
  const файлы = (config.basemaps || []).filter((b) => !b.problem);
  return { онлайн: !!(config.online && config.online_url), офлайн: файлы.length > 0, файлы };
}

function начальныйРежим(config) {
  const есть = режимыПодложки(config);
  let сохранённый = null;
  try { сохранённый = localStorage.getItem(КЛЮЧ_РЕЖИМА); } catch (e) { /* хранилище недоступно */ }
  if (сохранённый === "online" && есть.онлайн) return "online";
  if (сохранённый === "offline" && есть.офлайн) return "offline";
  // Локальная подложка надёжнее для первого входа и не посылает запросы
  // стороннему сервису. Явный выбор пользователя выше сохраняем.
  if (есть.офлайн) return "offline";
  if (есть.онлайн) return "online";
  return "none";
}

function запомнитьРежим(режим) {
  try { localStorage.setItem(КЛЮЧ_РЕЖИМА, режим); } catch (e) { /* не запомнится — не беда */ }
}

// ---------------------------------------------- несколько файлов PMTiles
//
// Обзорный файл страны (z0–8) и детальная вырезка региона (z0–14) —
// вырезки ОДНОЙ сборки Protomaps: на z0–8 их тайлы совпадают, детальный
// добавляет только уровни 9–14 и только в своём покрытии (прямоугольник из
// тайлов, задевающих его bbox). Поэтому: файлы — снизу вверх по max_zoom;
// каждый следующий рисуется поверх и лишь с уровня, где у пересекающихся с
// ним нижних файлов кончаются свои тайлы (их max_zoom + 1). Его суша и вода
// непрозрачны и целиком закрывают нижний файл в своих тайлах, за пределами
// покрытия остаётся нижний (обзорный). Подписи нижнего файла внутри bbox
// верхнего на его уровнях отключены — иначе названия задваивались бы.
function порядокФайлов(файлы) {
  const bbox = (b) => b.bbox || [-180, -85, 180, 85];
  const площадь = (b) => { const [з, ю, в, с] = bbox(b); return Math.max(0, в - з) * Math.max(0, с - ю); };
  const пересекаются = (a, b) => {
    const [з1, ю1, в1, с1] = bbox(a), [з2, ю2, в2, с2] = bbox(b);
    return з1 < в2 && з2 < в1 && ю1 < с2 && ю2 < с1;
  };
  const предел = (b) => (b.max_zoom === null || b.max_zoom === undefined ? 14 : b.max_zoom);
  const список = файлы.slice().sort((a, b) => предел(a) - предел(b) || площадь(b) - площадь(a));
  return список.map((ф, k) => {
    const ниже = список.slice(0, k).filter((g) => пересекаются(g, ф));
    const верх = ниже.length ? Math.max(...ниже.map(предел)) : -1;
    const с = верх >= 0 && верх < предел(ф) ? верх + 1 : 0;
    const [з, ю, в, сев] = bbox(ф);
    return { ...ф, с, полигон: { type: "Polygon", coordinates: [[[з, ю], [в, ю], [в, сев], [з, сев], [з, ю]]] } };
  });
}

// ------------------------------------------------------ офлайн-стиль
//
// Схема данных — Protomaps basemap v4 (метаданные файлов: version 4.15.2):
// слои earth, water, landcover, landuse, roads, buildings, boundaries,
// places; свойства kind, kind_detail, min_zoom, population_rank, name и
// name:ru. Шрифты — только вендоренные Noto Sans Regular/Bold.
const ЦВЕТ = {
  нетДанных: "#e3e6ea", земля: "#f3efe6", вода: "#a9cde8",
  лес: "#d5e5c5", зелень: "#e0ebcf", поле: "#efead8", город: "#ebe5dc",
  промзона: "#e8e0e4", особое: "#efe1dd", пески: "#efe6d0", лёд: "#fbfdff", болото: "#dde9e1",
  здание: "#dcd4c7", зданиеКонтур: "#cbc1b1",
  граница: "#9e8aa6", обводка: "#d3cabb",
  магистраль: "#f2a67c", главная: "#f7cf90", второстепенная: "#ffffff", улица: "#ffffff", дорожка: "#c9bfae", жд: "#a7a39c",
  подпись: "#3b3f45", подписьМелкая: "#5f646b", ореол: "#ffffff",
};
const НАЗВАНИЕ = ["coalesce", ["get", "name:ru"], ["get", "name"]];
const ширина = (пары) => ["interpolate", ["exponential", 1.6], ["zoom"], ...пары];

function слоиФайла(ф, ист, п) {
  const м = ф.с ? { minzoom: ф.с } : {};
  const полигон = ["==", ["geometry-type"], "Polygon"];
  const линия = ["==", ["geometry-type"], "LineString"];
  const вид = (...kinds) => ["match", ["get", "kind"], kinds, true, false];
  const деталь = (...kinds) => ["match", ["get", "kind_detail"], kinds, true, false];
  const тоннель = ["case", ["==", ["get", "is_tunnel"], true], 0.45, 1];
  const цветПокрова = ["match", ["get", "kind"],
    ["forest", "wood"], ЦВЕТ.лес,
    ["grassland", "park", "grass", "meadow", "national_park", "nature_reserve", "garden", "golf_course", "dog_park", "playground", "pitch", "cemetery", "allotments", "scrub", "village_green"], ЦВЕТ.зелень,
    ["farmland", "farmyard", "orchard", "vineyard"], ЦВЕТ.поле,
    ["urban_area", "residential"], ЦВЕТ.город,
    ["industrial", "commercial", "retail", "railway", "military", "garages", "construction", "aerodrome", "airfield"], ЦВЕТ.промзона,
    ["hospital", "school", "university", "college", "kindergarten"], ЦВЕТ.особое,
    ["barren", "sand", "bare_rock", "beach"], ЦВЕТ.пески,
    ["glacier"], ЦВЕТ.лёд,
    ["wetland"], ЦВЕТ.болото,
    "rgba(0,0,0,0)"];
  const дорога = (id, фильтр, цвет, пары, доп = {}) => ({
    id: п + id, type: "line", source: ист, "source-layer": "roads", ...м, ...доп.слой,
    filter: ["all", линия, фильтр],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": цвет, "line-width": ширина(пары), "line-opacity": тоннель, ...доп.paint },
  });
  // Главные дороги: trunk/primary отдельно от secondary/tertiary.
  const главная = ["all", вид("major_road"), деталь("trunk", "trunk_link", "primary", "primary_link")];
  const второстепенная = ["all", вид("major_road"), ["!", деталь("trunk", "trunk_link", "primary", "primary_link")]];
  return [
    { id: п + "суша", type: "fill", source: ист, "source-layer": "earth", ...м, filter: полигон,
      paint: { "fill-color": ЦВЕТ.земля } },
    { id: п + "покров", type: "fill", source: ист, "source-layer": "landcover", ...м, filter: полигон,
      paint: { "fill-color": цветПокрова, "fill-opacity": 0.7 } },
    { id: п + "землепользование", type: "fill", source: ист, "source-layer": "landuse", ...м, filter: полигон,
      paint: { "fill-color": цветПокрова } },
    // Вода непрозрачна, как и суша: вместе они закрывают нижний файл целиком.
    { id: п + "вода", type: "fill", source: ист, "source-layer": "water", ...м, filter: полигон,
      paint: { "fill-color": ЦВЕТ.вода } },
    { id: п + "реки", type: "line", source: ист, "source-layer": "water", ...м,
      filter: ["all", линия, вид("river", "canal", "stream")],
      paint: { "line-color": ЦВЕТ.вода,
        // Выражение по zoom допускается только одно и только наверху — вид внутри.
        "line-width": ширина([8, ["match", ["get", "kind"], "river", 0.8, 0], 12, ["match", ["get", "kind"], "river", 2, 0.4],
          14, ["match", ["get", "kind"], "river", 4, 1.2], 18, ["match", ["get", "kind"], "river", 14, 4]]) } },
    { id: п + "границы", type: "line", source: ист, "source-layer": "boundaries", ...м,
      filter: вид("country", "region"),
      layout: { "line-join": "round" },
      paint: { "line-color": ЦВЕТ.граница, "line-dasharray": [3, 2],
        "line-width": ширина([2, ["match", ["get", "kind"], "country", 0.8, 0.3], 10, ["match", ["get", "kind"], "country", 2, 1.2]]),
        "line-opacity": ["match", ["get", "kind"], "country", 0.9, 0.55] } },
    { id: п + "здания", type: "fill", source: ист, "source-layer": "buildings", minzoom: Math.max(13, ф.с || 0),
      paint: { "fill-color": ЦВЕТ.здание, "fill-outline-color": ЦВЕТ.зданиеКонтур } },
    дорога("дорожки", вид("path"), ЦВЕТ.дорожка, [14, 0.4, 18, 2], { слой: { minzoom: Math.max(15, ф.с || 0) } }),
    дорога("жд", ["all", вид("rail"), ["!", деталь("subway")]], ЦВЕТ.жд, [9, 0.4, 14, 1.2, 18, 2.5],
      { слой: { minzoom: Math.max(9, ф.с || 0) }, paint: { "line-dasharray": [4, 2] } }),
    // Обводки — под заливками своего класса, чтобы белые улицы читались на светлом фоне.
    дорога("улицы-обводка", вид("minor_road", "other"), ЦВЕТ.обводка, [12, 0.8, 14, 2.4, 18, 16], { слой: { minzoom: Math.max(12, ф.с || 0) } }),
    дорога("второстепенные-обводка", второстепенная, ЦВЕТ.обводка, [9, 0.8, 14, 4, 18, 22], { слой: { minzoom: Math.max(9, ф.с || 0) } }),
    дорога("главные-обводка", главная, ЦВЕТ.обводка, [6, 0.6, 14, 5.5, 18, 26]),
    дорога("улицы", вид("minor_road", "other"), ЦВЕТ.улица, [12, 0.4, 14, 1.6, 18, 13], { слой: { minzoom: Math.max(12, ф.с || 0) } }),
    дорога("второстепенные", второстепенная, ЦВЕТ.второстепенная, [9, 0.4, 14, 3, 18, 18], { слой: { minzoom: Math.max(9, ф.с || 0) } }),
    дорога("главные", главная, ЦВЕТ.главная, [6, 0.5, 14, 4, 18, 22]),
    дорога("магистрали", вид("highway"), ЦВЕТ.магистраль, [4, 0.5, 14, 5, 18, 26]),
  ];
}

function подписиФайла(ф, ист, п, выше) {
  const м = ф.с ? { minzoom: ф.с } : {};
  // Внутри bbox более детального файла на его уровнях подписи даёт он.
  const непересекается = выше.map((g) => ["any", ["<", ["zoom"], g.с], ["!", ["within", g.полигон]]]);
  const видно = [">=", ["zoom"], ["coalesce", ["get", "min_zoom"], 0]];
  const ранг = ["coalesce", ["get", "population_rank"], 0];
  return [{
    id: п + "подписи", type: "symbol", source: ист, "source-layer": "places", ...м,
    filter: ["all", видно, ...непересекается,
      ["match", ["get", "kind"], ["country", "region", "locality", "macrohood", "neighbourhood"], true, false],
      ["any", ["!=", ["get", "kind"], "country"], ["<=", ["zoom"], 6]],
      ["any", ["!", ["match", ["get", "kind"], ["macrohood", "neighbourhood"], true, false]], [">=", ["zoom"], 12]]],
    layout: {
      "text-field": НАЗВАНИЕ,
      "text-font": ["case", [">=", ранг, 11], ["literal", ["Noto Sans Bold"]], ["literal", ["Noto Sans Regular"]]],
      "text-size": ["match", ["get", "kind"],
        "country", 13,
        ["macrohood", "neighbourhood"], 11,
        ["interpolate", ["linear"], ранг, 0, 11, 8, 12, 11, 14, 14, 16]],
      "symbol-sort-key": ["-", 20, ранг],
      "text-max-width": 8,
      "text-padding": 3,
    },
    paint: {
      "text-color": ["match", ["get", "kind"], ["macrohood", "neighbourhood"], ЦВЕТ.подписьМелкая, ЦВЕТ.подпись],
      "text-halo-color": ЦВЕТ.ореол, "text-halo-width": 1.4,
    },
  }];
}

// Источники и слои подложки для режима. Все id начинаются с «подложка-»:
// по ним переключатель режима снимает старую подложку, не трогая точки
// объектов, кластеры и всплывашки, которые лежат выше отдельными слоями.
function подложка(config, режим) {
  const источники = {}, слои = [];
  if (режим === "online") {
    источники["подложка-osm"] = {
      type: "raster", tiles: [config.online_url], tileSize: 256, maxzoom: 19,
      attribution: config.attribution,
    };
    слои.push({ id: "подложка-osm", type: "raster", source: "подложка-osm" });
  } else if (режим === "offline") {
    const файлы = порядокФайлов(режимыПодложки(config).файлы);
    const подписи = [];
    файлы.forEach((ф, i) => {
      const ист = "подложка-файл" + i;
      источники[ист] = { type: "vector", url: "pmtiles://" + ф.url, attribution: config.attribution };
      слои.push(...слоиФайла(ф, ист, ист + "-"));
      // Подписи — над геометрией ВСЕХ файлов, верхний файл — первым.
      подписи.unshift(...подписиФайла(ф, ист, ист + "-", файлы.slice(i + 1)));
    });
    слои.push(...подписи);
  }
  return { источники, слои };
}

function стильКарты(config, режим) {
  const { источники, слои } = подложка(config, режим);
  return {
    version: 8,
    // Глифы — это НЕ шрифт страницы: подписи на векторной карте рисуются
    // заранее подготовленными картинками символов, и без этого адреса
    // символьные слои молча не появляются (ровно так пропало число объектов
    // в кластере). Лежат у нас же (vendor/glyphs/README.txt), читаются через
    // zhbi-glyphs:// — см. загрузитьГлифы().
    glyphs: "zhbi-glyphs://{fontstack}/{range}",
    sources: источники,
    // «Фон» виден только там, где данных нет вовсе (за покрытием файлов):
    // нарочно холоднее суши, чтобы граница данных читалась честно.
    layers: [{ id: "фон", type: "background", paint: { "background-color": ЦВЕТ.нетДанных } }, ...слои],
  };
}

// Сменить подложку на уже построенной карте: старые «подложка-*» снять,
// новые положить ПОД первый слой объектов — точки, кластеры и всплывашки
// остаются как были.
function применитьПодложку(карта, config, режим) {
  const стиль = карта.getStyle();
  стиль.layers.filter((l) => l.id.startsWith("подложка-")).forEach((l) => карта.removeLayer(l.id));
  Object.keys(стиль.sources).filter((id) => id.startsWith("подложка-")).forEach((id) => карта.removeSource(id));
  const { источники, слои } = подложка(config, режим);
  const над = карта.getStyle().layers.find((l) => l.id !== "фон" && !l.id.startsWith("подложка-"));
  Object.entries(источники).forEach(([id, s]) => карта.addSource(id, s));
  слои.forEach((l) => карта.addLayer(l, над ? над.id : undefined));
}

// Переключатель «С сервера / Из интернета» — только когда доступны оба.
// Показывает активный режим (aria-pressed) и запоминает выбор.
function вставитьСтильПереключателя() {
  if (document.querySelector("style[data-zhbi-basemap]")) return;
  const s = document.createElement("style");
  s.setAttribute("data-zhbi-basemap", "1");
  s.textContent = `
    .zhbi-basemap-ctrl { display: flex; align-items: stretch; font: 12px/1.2 system-ui, sans-serif; }
    .zhbi-basemap-ctrl .zhbi-basemap-cap { padding: 0 8px; display: flex; align-items: center; color: #555; }
    .maplibregl-ctrl-group.zhbi-basemap-ctrl button { width: auto; height: 29px; padding: 0 10px; border: 0;
      border-left: 1px solid #ddd; font: inherit; color: #333; white-space: nowrap; }
    .maplibregl-ctrl-group.zhbi-basemap-ctrl button[aria-pressed="true"] { background: #e3ecf7; color: #0b3d75; font-weight: 600; }
    .zhbi-basemap-ctrl .zhbi-basemap-warn { padding: 0 8px; display: flex; align-items: center; color: #b3261e; border-left: 1px solid #ddd; }
    .zhbi-basemap-ctrl .zhbi-basemap-warn[hidden] { display: none; }`;
  document.head.appendChild(s);
}

class ПереключательПодложки {
  constructor(config, режим, приСмене) {
    this.config = config; this.режим = режим; this.приСмене = приСмене;
  }
  onAdd(карта) {
    вставитьСтильПереключателя();
    const узел = document.createElement("div");
    узел.className = "maplibregl-ctrl maplibregl-ctrl-group zhbi-basemap-ctrl";
    узел.setAttribute("role", "group");
    узел.setAttribute("aria-label", "Подложка карты");
    узел.innerHTML = `<span class="zhbi-basemap-cap">Подложка:</span>
      <button type="button" data-basemap="offline" title="Карта из файлов на сервере — работает без интернета">С сервера</button>
      <button type="button" data-basemap="online" title="Карта OpenStreetMap из интернета">Из интернета</button>
      <span class="zhbi-basemap-warn" role="status" hidden title="Тайлы из интернета не загружаются — выберите «С сервера»">нет связи</span>`;
    const отметить = () => узел.querySelectorAll("button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.basemap === this.режим)));
    отметить();
    узел.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-basemap]");
      if (!b || b.dataset.basemap === this.режим) return;
      this.режим = b.dataset.basemap;
      запомнитьРежим(this.режим);
      отметить();
      this.сбойСети(false);
      const применить = () => применитьПодложку(карта, this.config, this.режим);
      // Стиль ещё грузится — сменим по его готовности, а не молча проглотим щелчок.
      try { применить(); } catch (err) { карта.once("load", применить); }
      if (this.приСмене) this.приСмене(this.режим);
    });
    this.узел = узел;
    return узел;
  }
  onRemove() { this.узел.remove(); }
  // Интернет пропал при режиме «Из интернета» — сказать об этом, но режим
  // не менять: переключается только сам зритель.
  сбойСети(есть) {
    const метка = this.узел && this.узел.querySelector(".zhbi-basemap-warn");
    if (метка) метка.hidden = !(есть && this.режим === "online");
  }
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
  const режим = начальныйРежим(config);
  const карта = new ml.Map({
    container: контейнер,
    style: стильКарты(config, режим),
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
  const есть = режимыПодложки(config);
  if (interactive && есть.онлайн && есть.офлайн) {
    const переключатель = new ПереключательПодложки(config, режим);
    карта.addControl(переключатель, "top-left");
    карта.on("error", (e) => { if (e && e.sourceId === "подложка-osm") переключатель.сбойСети(true); });
  }
  return { карта, config, ml, режим };
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
  // Точка-мишень (живой запрос 2026-09-08: «кружок с кольцом вокруг, как в
  // Google Maps по умолчанию, но красный контур всегда, заливка по
  // статусу, фон прозрачный») — два circle-слоя одного источника вместо
  // булавки: внешнее кольцо БЕЗ заливки и ВСЕГДА красное (кольцо шире
  // заливки, между ними виден зазор до самой подложки — никакой другой
  // заливки фона нет, круг рисуется только там, где сам круг), и
  // внутренняя точка того же цвета, что и раньше (доля смонтированного).
  // Слушатели клика/наведения — на кольце: его радиус больше, он целиком
  // накрывает внутреннюю точку, поэтому одного слоя хватает на обе цели.
  карта.addLayer({
    id: "объекты-точки", type: "circle", source: "объекты",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "rgba(0,0,0,0)",
      "circle-radius": ["interpolate", ["linear"], ["get", "elements"],
        0, 11, 100, 13, 1000, 16, 10000, 20],
      "circle-stroke-color": "#e53935", "circle-stroke-width": 2,
    },
  });
  карта.addLayer({
    id: "объекты-точки-заливка", type: "circle", source: "объекты",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["get", "color"],
      // Размер по числу элементов: большая стройка должна и выглядеть
      // крупнее, иначе карта врёт о масштабе работ.
      "circle-radius": ["interpolate", ["linear"], ["get", "elements"],
        0, 6, 100, 8, 1000, 11, 10000, 15],
    },
  });

  const попап = new ml.Popup({ closeButton: true, closeOnClick: true, maxWidth: "320px" });

  // Вынесено из обработчика клика по точке (живой запрос 2026-09-08:
  // «при клике в списке слева сразу открывать окошко, как будто по объекту
  // кликнули на карте») — строка сайдбара передаёт сюда СВОЙ объект из
  // `данные.objects` (обычный JS-объект), а клик по точке — properties
  // GeoJSON-фичи; поля совпадают, поэтому функция одна на оба случая.
  function открытьПопап(p, lngLat) {
    const доля = (p.percent === null || p.percent === undefined || p.percent === "null")
      ? "—" : p.percent + " %";
    // Превью — та же аватарка, что и в дереве справочника (GET
    // /objects/{id}/avatar); onerror прячет картинку молча, если файл вдруг
    // пропал с диска или у человека нет доступа к вложениям ИМЕННО этого
    // объекта (карта и вложения — разные разделы прав).
    const естьПревью = p.has_avatar === true || p.has_avatar === "true";
    const описание = (p.description || "").trim();
    const узел = document.createElement("div");
    узел.className = "map-popup";
    узел.innerHTML = `
      ${естьПревью ? `<img class="map-popup-avatar" src="/objects/${Number(p.id)}/avatar" alt=""
        onerror="this.remove()"/>` : ""}
      <div class="map-popup-project">${deps.escapeHtml(p.project_name || "")}</div>
      <div class="map-popup-name">
        <span class="status-dot" style="background:${deps.statusColor(p.status)}"></span>
        ${deps.escapeHtml(p.name)}
        <span class="map-popup-status">${deps.escapeHtml(deps.statusLabel(p.status))}</span>
      </div>
      ${описание ? `<div class="map-popup-desc">${deps.escapeHtml(описание)}</div>` : ""}
      <div class="map-popup-facts">
        Элементов: ${p.elements}. Смонтировано: ${доля}.
        ${p.smr_start || p.smr_end ? `<br/>Сроки СМР: ${p.smr_start || "—"} — ${p.smr_end || "—"}.` : ""}
        ${p.inherited === true || p.inherited === "true"
          ? `<br/><span class="hint-text">Координаты взяты у проекта.</span>` : ""}
      </div>
      <button type="button" class="btn btn-sm btn-primary map-popup-open">Свойства объекта</button>`;
    узел.querySelector(".map-popup-open").addEventListener("click", () => {
      попап.remove();
      onOpenObject(Number(p.id));
    });
    попап.setLngLat(lngLat).setDOMContent(узел).addTo(карта);
  }

  карта.on("click", "объекты-точки", (e) => {
    открытьПопап(e.features[0].properties, e.lngLat);
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
      if (!o) return;
      карта.easeTo({ center: [o.lon, o.lat], zoom: 15 });
      // Открывается СРАЗУ, а не по завершении полёта камеры: попап привязан
      // к географической точке и сам переезжает вместе с картой, тем же
      // способом, что и клик по самой точке (живой запрос 2026-09-08).
      открытьПопап(o, [o.lon, o.lat]);
    },
    // Отбор над картой (живой запрос 2026-09-08): источник точек создан ОДИН
    // раз при открытии, поэтому отбор перерисовывает не слой, а данные
    // самого источника — setData дешевле, чем пересоздавать источник и слои.
    // `объекты` (полный список для боковой панели без отбора) не трогаем —
    // список статусов/проектов в отборе строится по нему целиком.
    фильтровать: (список) => {
      карта.getSource("объекты").setData(точкиGeoJSON(список));
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

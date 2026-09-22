// Подсказка по точке графика — общий механизм для ВСЕХ SVG-графиков V2 (перенос из V1, app.js:
// registerChartHover/chartGeoFor/chartTooltipEl). Один слушатель mousemove на документе вместо
// отдельного обработчика у каждого графика: графиков уже два («Динамика», «Аналитическая справка»)
// и будет больше — заводить свою всплывающую панель на каждый лишняя работа и лишний узел в DOM.
//
// Регистр слабый (WeakMap по узлу SVG): график перерисовывается при каждой смене отчёта/параметров,
// и держать записи по идентификаторам значило бы копить мусор от каждой перерисовки.
import { esc } from "./screen-view.js";

const chartRegistry = new WeakMap();
const pendingChartGeo = [];

// data: { L, R, T, B, width, height, maxY, weeks, xLabel(w), unit, series: [{key,label,color,values}] }
// Возвращает разметку SVG с добавленным атрибутом data-chart-hover — вызывать в самом конце сборки строки.
export function registerChartHover(svgMarkup, geo) {
  pendingChartGeo.push(geo);
  return svgMarkup.replace("<svg ", `<svg data-chart-hover="${pendingChartGeo.length - 1}" `);
}

function chartGeoFor(svg) {
  let geo = chartRegistry.get(svg);
  if (geo) return geo;
  const i = Number(svg.dataset.chartHover);
  geo = pendingChartGeo[i];
  if (geo) chartRegistry.set(svg, geo);
  return geo || null;
}

function chartTooltipEl() {
  let el = document.getElementById("v2-chart-tooltip");
  if (!el) { el = document.createElement("div"); el.id = "v2-chart-tooltip"; document.body.appendChild(el); }
  return el;
}

function hideChartTooltip() {
  const el = document.getElementById("v2-chart-tooltip");
  if (el) el.style.display = "none";
  document.querySelectorAll("[data-chart-cursor]").forEach((g) => g.remove());
}

const numRu = (v) => Number(v).toLocaleString("ru-RU");

let bound = false;
export function ensureChartHoverListener() {
  if (bound) return;
  bound = true;
  document.addEventListener("mousemove", (e) => {
    const svg = e.target.closest ? e.target.closest("svg[data-chart-hover]") : null;
    if (!svg) { hideChartTooltip(); return; }
    const geo = chartGeoFor(svg);
    if (!geo) return;
    const rect = svg.getBoundingClientRect();
    // Курсор — в единицы viewBox: SVG растянут по ширине контейнера, и экранные пиксели с
    // координатами графика не совпадают.
    const k = rect.width / geo.width;
    const vx = (e.clientX - rect.left) / k;
    const vy = (e.clientY - rect.top) / k;

    const step = geo.weeks.length > 1 ? (geo.width - geo.L - geo.R) / (geo.weeks.length - 1) : 0;
    let i = step ? Math.round((vx - geo.L) / step) : 0;
    i = Math.max(0, Math.min(geo.weeks.length - 1, i));

    const X = (n) => geo.L + (step ? n * step : 0);
    const Y = (v) => geo.height - geo.B - (v / geo.maxY) * (geo.height - geo.T - geo.B);

    // Ближайший ряд — по вертикали в той же неделе: горизонталь у всех одинаковая.
    let best = null;
    for (const s of geo.series) {
      const v = s.values[i];
      if (v === null || v === undefined) continue;
      const d = Math.abs(Y(v) - vy);
      if (!best || d < best.d) best = { s, v, d };
    }
    if (!best) { hideChartTooltip(); return; }

    document.querySelectorAll("[data-chart-cursor]").forEach((g) => g.remove());
    const px = X(i), py = Y(best.v);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-chart-cursor", "1");
    g.innerHTML = `<line x1="${px}" y1="${geo.T}" x2="${px}" y2="${geo.height - geo.B}" stroke="#8A94A0" stroke-width="1" stroke-dasharray="3 3"/>
      <circle cx="${px}" cy="${py}" r="4" fill="#fff" stroke="${best.s.color}" stroke-width="2.5"/>`;
    svg.appendChild(g);

    const el = chartTooltipEl();
    el.innerHTML = `<b>${esc(best.s.label)}</b><div>${esc(geo.xLabel(geo.weeks[i]))}</div><div><b>${esc(numRu(Math.round(best.v)))}</b> ${esc(geo.unit || "изд.")}</div>`;
    el.style.display = "block";
    const w = el.offsetWidth;
    el.style.left = `${Math.min(e.clientX + 14, window.innerWidth - w - 8)}px`;
    el.style.top = `${e.clientY + 16}px`;
  });
}

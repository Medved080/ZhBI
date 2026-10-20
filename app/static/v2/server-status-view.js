// «Состояние сервера» — показатели виртуального сервера: загрузка процессора, ДОСТУПНАЯ оперативная память, свободное
// место на дисках (аналог окна V1 «Состояние сервера», app.js: renderServerStatus). Только чтение: `GET /admin/server-status`
// (шлюз записи не участвует). Пока экран открыт, опрос идёт каждые 5 с; цикл останавливается на destroy() и на скрытой
// вкладке не шлёт запросов. История процессора для графика копится здесь — на сервере её нет (см. app/server_status.py).
import { frame, errText } from "./admin-common.js";
import { esc } from "./screen-view.js";

(() => {
  if (document.querySelector("link[data-server-status-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/server-status.css"; l.setAttribute("data-server-status-css", "1");
  document.head.appendChild(l);
})();

const POLL_MS = 5000, HISTORY = 60;
const pct = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1).replace(".", ",")} %`);
// «Неизвестно» — прочерк, ноль осмыслен (как fmtSize в db-status-view.js)
const size = (n) => {
  if (n === null || n === undefined) return "—";
  if (n >= 1099511627776) return `${(n / 1099511627776).toFixed(2)} ТБ`;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} ГБ`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(0)} МБ`;
  return `${Math.round(n / 1024)} КБ`;
};
const uptime = (s) => {
  if (s === null || s === undefined) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
};
const meter = (p) => `<div class="v2-srv-meter" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, p || 0))}%"></span></div>`;
const LEVEL_WORD = { ok: "в норме", warning: "повышена", critical: "критично", unknown: "нет данных" };
const DISK_WORD = { ok: "достаточно", warning: "мало", critical: "критически мало", unknown: "нет данных" };

export function mountServerStatusView(el, { screen, groupTitle, api }) {
  const body = frame(el, screen, groupTitle);
  body.dataset.serverStatus = "1";
  let dead = false, busy = false, timer = null, first = true, error = "", data = null;
  const cpuHistory = [];

  function paint() {
    if (dead) return;
    if (!data) {
      body.innerHTML = error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось получить показатели сервера.</strong> ${esc(error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="srv-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      body.querySelector("#srv-retry")?.addEventListener("click", () => void tick());
      return;
    }
    const d = data, c = d.cpu, m = d.memory, h = d.host;
    const pts = cpuHistory.map((v, i, a) => `${a.length > 1 ? (100 * i / (a.length - 1)).toFixed(1) : 100},${(100 - (v || 0)).toFixed(1)}`).join(" ");
    const cpu = `<section class="v2-srv-card v2-srv-${esc(c.level)}" id="srv-cpu" aria-label="Процессор">
      <h3>Процессор</h3><div class="v2-srv-big">${esc(pct(c.percent))}</div>${meter(c.percent)}
      <div class="v2-srv-sub">Загрузка ${esc(LEVEL_WORD[c.level] || "")}. Ядер: ${esc(c.cores ?? "—")}${c.load_average ? `; нагрузка за 1 / 5 / 15 мин: ${esc(c.load_average.join(" / "))}` : ""}</div>
      <svg class="v2-srv-spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Загрузка процессора за последние минуты"><polyline points="${pts}"/></svg></section>`;
    const mem = m
      ? `<section class="v2-srv-card v2-srv-${esc(m.level)}" id="srv-mem" aria-label="Оперативная память">
      <h3>Оперативная память</h3><div class="v2-srv-big">${esc(size(m.available_bytes))}</div>
      <div class="v2-srv-sub">доступно из ${esc(size(m.total_bytes))}</div>${meter(m.used_percent)}
      <div class="v2-srv-sub">Занято ${esc(pct(m.used_percent))} (${esc(size(m.used_bytes))}) — ${esc(LEVEL_WORD[m.level] || "")}</div>
      ${m.container ? `<div class="v2-srv-sub">Предел контейнера: ${esc(size(m.container.limit_bytes))}, занято ${esc(pct(m.container.used_percent))}</div>` : ""}
      ${m.swap_total_bytes ? `<div class="v2-srv-sub">Подкачка: ${esc(size(m.swap_used_bytes))} из ${esc(size(m.swap_total_bytes))}</div>` : ""}</section>`
      : `<section class="v2-srv-card v2-srv-unknown" id="srv-mem"><h3>Оперативная память</h3><div class="v2-srv-big">—</div><div class="v2-srv-sub">не удалось прочитать данные о памяти</div></section>`;
    const disks = `<section class="v2-srv-card" id="srv-disk" aria-label="Дисковое пространство"><h3>Дисковое пространство</h3>${d.disks.length
      ? d.disks.map((k) => `<div class="v2-srv-disk v2-srv-${esc(k.level)}"><div class="v2-srv-disk-name">${esc(k.label)}</div>
        <div class="v2-srv-big">${esc(size(k.free))}</div>
        <div class="v2-srv-sub">свободно из ${esc(size(k.total))} (${esc(pct(k.free_percent))}) — ${esc(DISK_WORD[k.level] || "")}</div>${meter(100 - (k.free_percent ?? 100))}
        <div class="v2-srv-sub">${esc(k.path)}</div></div>`).join("")
      : `<div class="v2-srv-sub">не удалось узнать свободное место</div>`}</section>`;
    body.innerHTML = `
      <div class="v2-callout" role="note"><strong>Только просмотр.</strong> Показатели виртуального сервера, на котором работает сервис; обновляются каждые 5 секунд, пока экран открыт.
        Для памяти важна <b>доступная</b> часть: система держит остальное под кэш файлов и отдаёт программам по первому требованию.</div>
      <dl class="v2-srv-facts"><dt class="v2-muted">Сервер</dt><dd>${esc(h.name || "—")}</dd><dt class="v2-muted">Система</dt><dd>${esc(h.os || "—")}</dd>
        <dt class="v2-muted">Работает</dt><dd>${esc(uptime(h.uptime_seconds))}</dd></dl>
      ${error ? `<div class="v2-callout v2-callout-bad" role="alert">Не удалось обновить: ${esc(error)}. Показаны последние полученные значения.</div>` : ""}
      <div class="v2-srv-grid">${cpu}${mem}${disks}</div>
      ${d.source === "fallback" ? `<p class="v2-muted">Данные получены запасным способом (сервер не на Linux): значения приблизительные.</p>` : ""}
      <div class="v2-bar"><span class="v2-muted" role="status" aria-live="off">Обновлено: ${esc(new Date(d.time * 1000).toLocaleTimeString("ru-RU"))}</span>
        <button type="button" class="v2-btn" id="srv-refresh">Обновить сейчас</button></div>`;
    body.querySelector("#srv-refresh").addEventListener("click", () => void tick());
  }

  async function tick() {
    clearTimeout(timer);
    if (dead) return;
    if (!busy && !document.hidden) {
      busy = true;
      try {
        const d = await api.get("/admin/server-status" + (first ? "?open=1" : ""));
        if (dead) return;
        first = false; data = d; error = "";
        cpuHistory.push(d.cpu.percent);
        if (cpuHistory.length > HISTORY) cpuHistory.shift();
      } catch (e) { if (dead) return; error = errText(e); }
      finally { busy = false; }
      paint();
    }
    if (!dead) timer = setTimeout(tick, POLL_MS);
  }

  paint();
  void tick();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; clearTimeout(timer); } };
}

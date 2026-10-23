// Экран «Замеры производительности» (2026-10-23): один общий модуль для V1 (окно) и V2 (экран). Подключается классическим скриптом,
// отдаёт `window.zhbiPerfPanel.mount(контейнер, { request, confirm })`; `request(method, path, body)` — запрос к API через обёртку своего
// интерфейса (V1: api(), V2: api.js), `confirm(текст) → Promise<bool>` — диалог подтверждения своего интерфейса.
// Что умеет: включить и выключить сбор (сервер и браузеры, автоостановка через два часа), показать окно с последними операциями в углу
// экрана, свести замеры по операциям (число, среднее, медиана, p95, максимум, суммарное время), показать самые медленные записи с
// разбивкой (SQL, ожидание, скачивание, долгие скрипты), показать компьютеры, выгрузить CSV, очистить. Сам сбор — perf.js и app/perf_core.py.
(() => {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 1) => (v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: d }));
  const SIDE = { server: "сервер", client: "браузер" };
  const KIND = { http: "запрос", fetch: "запрос", screen: "экран", scene: "схема", frame: "долгий кадр", longtask: "долгая задача", event: "нажатие", page: "страница", span: "отрезок", error: "ошибка" };

  function injectCss() {
    if (document.getElementById("pf-css")) return;
    const st = document.createElement("style");
    st.id = "pf-css";
    st.textContent = `
.pf { font-size: 0.8125rem; line-height: 1.4; }
.pf-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin: 4px 0 12px; }
.pf-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(128,128,128,.4); }
.pf-badge i { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; display: inline-block; }
.pf-badge.on i { background: #2e9d57; box-shadow: 0 0 0 3px rgba(46,157,87,.25); }
.pf-note { opacity: .7; font-size: 0.75rem; }
.pf-tabs { display: flex; gap: 4px; margin: 10px 0 8px; border-bottom: 1px solid rgba(128,128,128,.3); }
.pf-tabs button { background: none; border: 0; padding: 6px 12px; cursor: pointer; font: inherit; color: inherit; opacity: .7; border-bottom: 2px solid transparent; }
.pf-tabs button[aria-selected="true"] { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
.pf-tools { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; align-items: center; }
.pf-tools input[type=search], .pf-tools select { padding: 4px 8px; font: inherit; }
.pf-scroll { overflow: auto; max-height: 56vh; border: 1px solid rgba(128,128,128,.25); border-radius: 6px; }
.pf table { border-collapse: collapse; width: 100%; font-size: 0.75rem; }
.pf th, .pf td { padding: 4px 8px; text-align: left; border-bottom: 1px solid rgba(128,128,128,.18); white-space: nowrap; }
.pf th { position: sticky; top: 0; background: Canvas; cursor: pointer; user-select: none; z-index: 1; }
.pf td.n, .pf th.n { text-align: right; font-variant-numeric: tabular-nums; }
.pf td.op { white-space: normal; word-break: break-word; min-width: 220px; max-width: 420px; }
.pf .slow { color: #d1453b; font-weight: 600; }
.pf .mid { color: #c9831d; }
.pf details summary { cursor: pointer; opacity: .8; }
.pf pre { margin: 4px 0; white-space: pre-wrap; word-break: break-word; font-size: 0.6875rem; max-width: 520px; }
.pf button.pf-btn { padding: 5px 12px; font: inherit; cursor: pointer; }
`;
    document.head.appendChild(st);
  }

  function mount(el, { request, confirm }) {
    injectCss();
    const perf = window.zhbiPerf;
    const ask = confirm || ((t) => Promise.resolve(window.confirm(t)));
    const M = { st: null, runs: [], run: "", tab: "ops", sum: null, slow: null, cli: null, side: "", q: "", sort: "total", dir: -1, timer: null, dead: false, busy: false, err: "" };
    el.innerHTML = `<div class="pf"><div class="pf-bar" id="pf-bar"></div><div id="pf-msg" class="pf-note"></div>
      <div class="pf-tabs" role="tablist"><button data-tab="ops" role="tab">Операции</button><button data-tab="slow" role="tab">Самые медленные</button><button data-tab="cli" role="tab">Компьютеры</button></div>
      <div id="pf-body"></div></div>`;
    const $ = (s) => el.querySelector(s);

    async function load() {
      if (M.dead) return;
      try {
        const runs = await request("GET", "/perf/runs");
        if (M.dead) return;
        M.st = runs.state; M.runs = runs.runs; M.total = runs.total; M.retention = runs.retention_days;
        if (perf) perf.setState({ ...M.st, can_control: true });
        if (!M.run || (M.st.on && !M.userPickedRun)) M.run = M.st.run_id || M.run || (M.runs[0] && M.runs[0].run_id) || "";
        const q = M.run ? `?run_id=${encodeURIComponent(M.run)}` : "";
        if (M.tab === "ops") M.sum = await request("GET", "/perf/summary" + q);
        else if (M.tab === "slow") M.slow = await request("GET", "/perf/slowest" + q + (q ? "&" : "?") + "limit=60");
        else M.cli = await request("GET", "/perf/clients" + q);
        M.err = "";
      } catch (e) { M.err = e && e.message ? e.message : String(e); }
      if (!M.dead) paint();
    }

    function until() {
      if (!M.st || !M.st.on || !M.st.until) return "";
      const d = new Date(M.st.until * 1000);
      return ` · автоостановка в ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    function paintBar() {
      const on = !!(M.st && M.st.on);
      const overlay = perf ? perf.overlayOn() : false;
      $("#pf-bar").innerHTML = `<span class="pf-badge ${on ? "on" : ""}"><i></i>${on ? `Сбор идёт · ${esc(M.st.run_id)}${until()}` : "Замеры выключены"}</span>
        <button type="button" class="pf-btn" data-act="toggle" ${M.busy ? "disabled" : ""}>${on ? "Остановить замеры" : "Включить замеры"}</button>
        <label><input type="checkbox" data-act="overlay" ${overlay ? "checked" : ""}> Окно с операциями в углу экрана</label>
        <label>Сбор: <select data-act="run">${M.runs.length ? M.runs.map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === M.run ? "selected" : ""}>${esc(r.run_id)} · ${fmt(r.n, 0)} зам.</option>`).join("") : `<option value="">нет данных</option>`}</select></label>
        <a class="pf-btn" data-act="export" href="${M.run ? `/perf/export.csv?run_id=${encodeURIComponent(M.run)}` : "#"}" download>Выгрузить CSV</a>
        <button type="button" class="pf-btn" data-act="clear" ${M.total ? "" : "disabled"}>Очистить всё</button>`;
      $("#pf-msg").textContent = M.err ? `Ошибка: ${M.err}` : `Замеры хранятся ${M.retention || 3} суток и удаляются сами; в базе сейчас ${fmt(M.total || 0, 0)} строк. Сбор замедляет работу на доли процента и сам выключается через два часа.`;
      for (const b of el.querySelectorAll(".pf-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === M.tab));
    }

    const cls = (ms) => (ms >= 1000 ? "slow" : ms >= 300 ? "mid" : "");
    function paintOps() {
      const sum = M.sum;
      if (!sum || !sum.ops) return `<p class="pf-note">${M.run ? "Загрузка…" : "Замеров пока нет — включите сбор и поработайте в системе."}</p>`;
      let rows = sum.ops.filter((o) => (!M.side || o.side === M.side) && (!M.q || o.op.toLowerCase().includes(M.q.toLowerCase())));
      const key = M.sort;
      rows = rows.slice().sort((a, b) => (typeof a[key] === "string" ? a[key].localeCompare(b[key]) * -M.dir : (a[key] - b[key]) * M.dir));
      const det = (o) => {
        const x = o.extra;
        if (!x) return "";
        if (o.side === "server") return `до 1-го байта ${fmt(x.ttfb)} · SQL ${fmt(x.sql_ms)}+${fmt(x.sql_fetch)} мс (${fmt(x.sql_n, 0)} зап.) · ${fmt((x.bytes || 0) / 1024)} КБ`;
        return `ожидание ${fmt(x.wait)} · скачивание ${fmt(x.dl)}${x.server != null ? ` · сервер ${fmt(x.server)}` : ""} · ${fmt((x.bytes || 0) / 1024)} КБ`;
      };
      const th = (k, t, n) => `<th class="${n ? "n" : ""}" data-sort="${k}">${t}${M.sort === k ? (M.dir < 0 ? " ▾" : " ▴") : ""}</th>`;
      return `<div class="pf-tools"><label>Сторона: <select data-act="side"><option value="">все</option><option value="server" ${M.side === "server" ? "selected" : ""}>сервер</option><option value="client" ${M.side === "client" ? "selected" : ""}>браузер</option></select></label>
        <input type="search" data-act="q" placeholder="Фильтр по названию операции" value="${esc(M.q)}"><span class="pf-note">${rows.length} из ${sum.ops.length} операций; «всего» — сколько времени операция съела суммарно (то, что выгоднее ускорять первым)</span></div>
        <div class="pf-scroll"><table><thead><tr>${th("side", "Сторона")}${th("kind", "Вид")}${th("op", "Операция")}${th("n", "Раз", 1)}${th("avg", "Среднее, мс", 1)}${th("p50", "Медиана", 1)}${th("p95", "p95", 1)}${th("max", "Макс", 1)}${th("total", "Всего, мс", 1)}<th>Разбивка (в среднем)</th></tr></thead><tbody>
        ${rows.map((o) => `<tr><td>${SIDE[o.side] || o.side}</td><td>${KIND[o.kind] || o.kind}</td><td class="op">${esc(o.op)}</td><td class="n">${fmt(o.n, 0)}</td><td class="n ${cls(o.avg)}">${fmt(o.avg)}</td><td class="n">${fmt(o.p50)}</td><td class="n ${cls(o.p95)}">${fmt(o.p95)}</td><td class="n ${cls(o.max)}">${fmt(o.max)}</td><td class="n">${fmt(o.total, 0)}</td><td>${esc(det(o))}</td></tr>`).join("") || `<tr><td colspan="10" class="pf-note">Нет строк по этому отбору</td></tr>`}</tbody></table></div>`;
    }
    function paintSlow() {
      const d = M.slow;
      if (!d) return `<p class="pf-note">Загрузка…</p>`;
      const sqlSlow = (j) => (j && j.sql_slow ? j.sql_slow.map((s) => `${fmt(s.ms)} мс — ${s.sql}`).join("\n") : "");
      return `<div class="pf-scroll"><table><thead><tr><th>Время (UTC)</th><th>Сторона</th><th>Операция</th><th class="n">мс</th><th>Пользователь</th><th>Подробности</th></tr></thead><tbody>
        ${(d.items || []).map((r) => {
          let j = null;
          try { j = r.details ? JSON.parse(r.details) : null; } catch (e) { j = null; }
          const extra = sqlSlow(j);
          return `<tr><td>${esc((r.at || "").slice(5, 23))}</td><td>${SIDE[r.side] || r.side}</td><td class="op">${esc(r.op)}</td><td class="n ${cls(r.duration_ms)}">${fmt(r.duration_ms)}</td><td>${esc(r.user_name || "")}</td>
            <td class="op"><details><summary>${esc(KIND[r.kind] || r.kind)}${j && j.status ? ` · ${j.status}` : ""}</summary><pre>${esc(extra ? "Самые долгие запросы SQL:\n" + extra + "\n\n" : "")}${esc(j ? JSON.stringify(j, null, 1) : "")}</pre></details></td></tr>`;
        }).join("") || `<tr><td colspan="6" class="pf-note">Замеров пока нет</td></tr>`}</tbody></table></div>`;
    }
    function paintCli() {
      const d = M.cli;
      if (!d) return `<p class="pf-note">Загрузка…</p>`;
      const dev = (x) => (x ? `${x.os || ""} · ${x.browser || ""} · ядер ${x.cores ?? "?"}, память ${x.mem_gb ?? "?"} ГБ · экран ${x.screen || "?"}${x.net ? ` · сеть ${x.net}${x.rtt_ms != null ? `, ${x.rtt_ms} мс` : ""}` : ""}` : "—");
      return `<div class="pf-scroll"><table><thead><tr><th>Вкладка</th><th>Пользователь</th><th class="n">Замеров</th><th class="n">Запросов</th><th class="n">Медиана запроса, мс</th><th class="n">p95</th><th class="n">Долгих кадров</th><th class="n">Макс. кадр, мс</th><th>Компьютер</th></tr></thead><tbody>
        ${(d.clients || []).map((c) => `<tr><td>${esc(c.client_id)}</td><td>${esc(c.user_name || "")}</td><td class="n">${c.n}</td><td class="n">${c.fetch_n}</td><td class="n">${fmt(c.fetch_p50)}</td><td class="n ${cls(c.fetch_p95)}">${fmt(c.fetch_p95)}</td><td class="n">${c.long_n}</td><td class="n ${cls(c.long_max)}">${fmt(c.long_max)}</td><td class="op">${esc(dev(c.device))}</td></tr>`).join("") || `<tr><td colspan="9" class="pf-note">Браузеры замеров ещё не присылали</td></tr>`}</tbody></table></div>`;
    }
    function paint() {
      if (M.dead) return;
      const active = document.activeElement;
      const keepQ = active && active.dataset && active.dataset.act === "q" ? active.selectionStart : null;
      paintBar();
      $("#pf-body").innerHTML = M.tab === "ops" ? paintOps() : M.tab === "slow" ? paintSlow() : paintCli();
      if (keepQ !== null) { const q = $('[data-act="q"]'); if (q) { q.focus(); q.setSelectionRange(keepQ, keepQ); } }
    }

    el.addEventListener("click", async (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { M.tab = tab.dataset.tab; M.err = ""; paint(); load(); return; }
      const th = e.target.closest("[data-sort]");
      if (th) { const k = th.dataset.sort; M.dir = M.sort === k ? -M.dir : (k === "op" || k === "side" || k === "kind" ? 1 : -1); M.sort = k; paint(); return; }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "toggle" && !M.busy) {
        M.busy = true; paintBar();
        try {
          const on = !(M.st && M.st.on);
          M.st = await request("POST", "/perf/capture", { on });
          if (perf) perf.setState(M.st);
          if (on) { M.run = M.st.run_id; M.userPickedRun = false; }
        } catch (err) { M.err = err && err.message ? err.message : String(err); }
        M.busy = false;
        await load();
      } else if (act.dataset.act === "clear") {
        if (!(await ask("Удалить ВСЕ замеры производительности? Это не затрагивает данные системы."))) return;
        try { await request("POST", "/perf/clear", {}); M.sum = M.slow = M.cli = null; } catch (err) { M.err = err && err.message ? err.message : String(err); }
        await load();
      }
    });
    el.addEventListener("change", (e) => {
      const a = e.target.dataset && e.target.dataset.act;
      if (a === "overlay" && perf) { perf.setOverlay(e.target.checked); }
      else if (a === "run") { M.run = e.target.value; M.userPickedRun = true; M.sum = M.slow = M.cli = null; paint(); load(); }
      else if (a === "side") { M.side = e.target.value; paint(); }
    });
    el.addEventListener("input", (e) => { if (e.target.dataset && e.target.dataset.act === "q") { M.q = e.target.value; paint(); } });

    paint();
    load();
    M.timer = setInterval(() => { if (!document.hidden && M.st && M.st.on) load(); }, 5000);
    return { destroy() { M.dead = true; clearInterval(M.timer); }, hasUnsavedChanges: () => false, guardLeave: async () => true };
  }

  window.zhbiPerfPanel = { mount };
})();

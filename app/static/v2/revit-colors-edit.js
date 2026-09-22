// «Цвета модели МФР»: цветовая схема объекта (`GET/PUT /revit-plan/colors?object_id=`, состав категорий —
// `GET /revit-plan/filters?object_id=`). Те же API и права, что у V1 (`revit_model`, запись); здесь только экран.
// Схема хранится ЦЕЛИКОМ (шаблон + цвета + прозрачность + свечение по категориям), поэтому запись — тоже целой схемой.
// Барьер безопасности данных: объект — из контекста экрана (смена объекта проходит сторож несохранённого); перед записью
// схема перечитывается — если её изменили после открытия экрана, перезапись только по явному подтверждению; одна запись
// за раз; ввод не теряется при ошибке; успех — после ответа сервера и повторного чтения (сверка по правилам сервера:
// цвета — нижним регистром, нулевые прозрачность/свечение не хранятся); неизвестный исход (сеть/5xx) не повторяется,
// а проверяется чтением; шаблон заменяет черновик целиком только по явному нажатию и показывает это в статусе.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

// Приведение схемы к виду, в котором её хранит сервер (для сверки «черновик ↔ записано»).
export function normScheme(s) {
  const colors = {};
  for (const [k, v] of Object.entries(s?.colors || {})) if (HEX.test(String(v || "").trim())) colors[String(k).slice(0, 100)] = String(v).trim().toLowerCase();
  const num = (m, max) => {
    const out = {};
    for (const [k, v] of Object.entries(m || {})) { const n = Math.trunc(Number(v)); if (Number.isFinite(n) && n > 0) out[String(k).slice(0, 100)] = Math.max(0, Math.min(max, n)); }
    return out;
  };
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return JSON.stringify({ preset: s?.preset || "custom", colors: sortKeys(colors), opacity: sortKeys(num(s?.opacity, 95)), glow: sortKeys(num(s?.glow, 100)) });
}

export function mountRevitColorsEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.revit;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false;
  // saved — то, что хранит сервер (по последнему чтению); draft — то, что на экране; cats — категории объекта
  const st = { saved: null, draft: null, presets: [], fallback: "#c8c8c8", cats: [], busy: false, error: "", seq: 0 };
  const q = `?object_id=${objectId}`;

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Схема правится в новом интерфейсе." : "Просмотр схемы."}</strong>
        Цвета относятся к выбранному в шапке объекту и видны всем, кто смотрит его модель. Шаблон задаёт всю схему разом; любой цвет можно поправить отдельно — тогда схема считается своей.
        ${canWrite ? "Сохраняется схема целиком." : "У вас нет права изменять эту схему."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="rc-body"></div>
      <p id="rc-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#rc-status"); if (n) n.textContent = t; };
  const dirty = () => !!st.saved && !!st.draft && normScheme(st.draft) !== normScheme(st.saved);
  const clone = (s) => ({ preset: s.preset, colors: { ...(s.colors || {}) }, opacity: { ...(s.opacity || {}) }, glow: { ...(s.glow || {}) } });
  const fill = (cat) => st.draft.colors[cat] || st.fallback;

  function paint() {
    if (dead) return;
    const body = $("#rc-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — схема цветов относится к объекту.</p>`; return; }
    if (!st.saved) {
      body.innerHTML = st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить схему.</strong> ${esc(st.error)}
           <div class="v2-callout-actions"><button type="button" class="v2-btn" id="rc-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#rc-retry")?.addEventListener("click", load);
      return;
    }
    const d = st.draft;
    const extra = Object.keys(d.colors).filter((k) => !st.cats.includes(k)).length;
    body.innerHTML = `<form id="rc-form" autocomplete="off">
      <div class="v2-bar" role="group" aria-label="Шаблон схемы">${st.presets.map((p) => `<button type="button" class="v2-btn ${d.preset === p.key ? "v2-primary" : ""}" data-preset="${esc(p.key)}" aria-pressed="${d.preset === p.key}" title="${esc(p.hint)}" ${canWrite ? "" : "disabled"}>${esc(p.title)}</button>`).join("")}
        ${d.preset === "custom" ? `<span class="v2-chip">сейчас: своя схема</span>` : ""}</div>
      ${st.cats.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Категория</th><th>Цвет</th><th>Прозрачность, %</th><th>Свечение, %</th></tr></thead><tbody>
        ${st.cats.map((c) => { const o = Number(d.opacity[c] || 0), g = Number(d.glow[c] || 0); return `<tr><td>${esc(c)}</td>
          <td><input type="color" data-cat="${esc(c)}" value="${esc(fill(c))}" aria-label="Цвет: ${esc(c)}" ${canWrite ? "" : "disabled"}> <code>${esc(fill(c))}</code></td>
          <td><input type="range" min="0" max="95" step="5" value="${o}" data-opacity="${esc(c)}" aria-label="Прозрачность: ${esc(c)}" ${canWrite ? "" : "disabled"}> <output>${o}%</output></td>
          <td><input type="range" min="0" max="100" step="5" value="${g}" data-glow="${esc(c)}" aria-label="Свечение: ${esc(c)}" ${canWrite ? "" : "disabled"}> <output>${g}%</output></td></tr>`; }).join("")}
      </tbody></table></div>` : `<p class="v2-muted">Категорий пока нет — загрузите выгрузку модели.</p>`}
      ${extra ? `<p class="v2-muted">В схеме есть ещё ${extra} категорий, которых нет в этом объекте: они сохраняются без изменений.</p>` : ""}
      ${canWrite ? `<div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="rc-save">Сохранить схему</button>
        <button type="button" class="v2-btn" id="rc-revert">Отменить правку</button>
        <button type="button" class="v2-btn" id="rc-refresh">Обновить</button></div>` : ""}</form>`;
    body.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
    body.querySelectorAll("input[data-cat]").forEach((i) => i.addEventListener("input", () => { d.preset = "custom"; d.colors[i.dataset.cat] = i.value; touched(i, "cat"); }));
    body.querySelectorAll("input[data-opacity]").forEach((i) => i.addEventListener("input", () => { d.preset = "custom"; d.opacity[i.dataset.opacity] = Number(i.value); i.nextElementSibling.textContent = `${i.value}%`; touched(i); }));
    body.querySelectorAll("input[data-glow]").forEach((i) => i.addEventListener("input", () => { d.preset = "custom"; d.glow[i.dataset.glow] = Number(i.value); i.nextElementSibling.textContent = `${i.value}%`; touched(i); }));
    $("#rc-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    $("#rc-revert")?.addEventListener("click", () => { st.draft = clone(st.saved); setStatus(""); paint(); });
    $("#rc-refresh")?.addEventListener("click", () => { if (dirty()) setStatus("Сначала сохраните или отмените правку."); else if (!st.busy) load(); });
    lock();
  }
  // Ползунки не перерисовываем на каждом шаге (иначе теряется захват мышью) — обновляем только кнопки и подпись цвета.
  function touched(input, kind) {
    if (kind === "cat") input.nextElementSibling.textContent = input.value;
    markPreset();
    lock();
  }
  // Подсветка активного шаблона без полной перерисовки.
  function markPreset() { const b = el.querySelectorAll("[data-preset]"); b.forEach((x) => { const on = x.dataset.preset === st.draft.preset; x.classList.toggle("v2-primary", on); x.setAttribute("aria-pressed", String(on)); }); }
  function lock() {
    el.querySelectorAll("#rc-form input, #rc-form button").forEach((c) => { c.disabled = st.busy || !canWrite; });
    if (!st.busy) { const s = $("#rc-save"), r = $("#rc-revert"); if (s) s.disabled = !dirty(); if (r) r.disabled = !dirty(); }
  }

  function applyPreset(key) {
    if (st.busy || !canWrite) return;
    const p = st.presets.find((x) => x.key === key);
    if (!p) return;
    st.draft = { preset: p.key, colors: { ...p.colors }, opacity: { ...(p.opacity || {}) }, glow: { ...(p.glow || {}) } };
    setStatus(`Шаблон «${p.title}» применён к черновику: при сохранении вся схема объекта будет заменена шаблоном.`);
    paint();
  }

  async function readAll() {
    const [s, f] = await Promise.all([api.get(`${spec.endpoint}${q}`), api.get(`${spec.filters}${q}`)]);
    return { s, cats: (f.categories || []).map((c) => c.category).filter(Boolean) };
  }

  const adopt = (r, keepDraft) => {
    st.saved = { preset: r.s.preset, colors: r.s.colors || {}, opacity: r.s.opacity || {}, glow: r.s.glow || {} };
    if (!keepDraft) st.draft = clone(st.saved);
    st.cats = r.cats;
  };
  async function load() {
    if (!objectId) { paint(); return; }
    const seq = ++st.seq;
    try {
      const r = await readAll();
      if (dead || seq !== st.seq) return;
      const keep = dirty(); // пока шёл запрос, человек мог начать правку — её ответом не затираем
      adopt(r, keep);
      st.presets = r.s.presets || []; st.fallback = r.s.fallback || "#c8c8c8"; st.error = "";
      if (keep) setStatus("Схема на сервере обновлена; ваша правка на экране сохранена.");
    } catch (e) {
      if (dead || seq !== st.seq) return;
      if (!st.saved) st.error = errText(e); else setStatus(`Схема не обновилась: ${errText(e)}`);
    }
    paint();
  }

  async function save() {
    if (st.busy || !canWrite || !dirty()) return;
    const payload = { preset: st.draft.preset, colors: st.draft.colors, opacity: st.draft.opacity, glow: st.draft.glow };
    const badColor = Object.entries(payload.colors).find(([, v]) => !HEX.test(v));
    if (badColor) { setStatus(`Некорректный цвет у «${badColor[0]}».`); return; }
    const want = normScheme(payload);
    st.busy = true; lock(); setStatus("Проверяем, не изменили ли схему другие…");
    try {
      const fresh = (await api.get(`${spec.endpoint}${q}`));
      if (dead) return;
      if (normScheme(fresh) !== normScheme(st.saved)) {
        st.busy = false; lock();
        const ok = await showConfirmDialog("Схему цветов изменили после того, как вы открыли экран. Перезаписать вашей версией (чужие изменения будут потеряны)?", { confirmLabel: "Перезаписать", danger: true });
        if (dead) return;
        if (!ok) { setStatus("Сохранение отменено: схема на сервере изменилась. Нажмите «Обновить» после сохранения или отмены правки."); return; }
        st.busy = true; lock();
      }
      setStatus("Сохранение…");
      await api.put(`${spec.endpoint}${q}`, payload);
      try {
        const r = await readAll();
        if (dead) return;
        adopt(r, false);
        setStatus(normScheme(r.s) === want ? "Схема сохранена и подтверждена чтением." : "Сервер вернул схему, отличную от отправленной — проверьте значения.");
      } catch {
        // запись прошла, а прочитать не вышло: принимаем отправленное как сохранённое, чтобы экран не считался несохранённым
        if (!dead) { st.saved = clone(payload); st.draft = clone(payload); setStatus("Сохранено, но перечитать не удалось — нажмите «Обновить»."); }
      }
      st.busy = false; paint();
    } catch (e) {
      if (dead) return;
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        try {
          const r = await readAll();
          if (dead) return;
          if (normScheme(r.s) === want) { adopt(r, false); setStatus("Сервер сохранил схему, хотя ответ не дошёл."); }
          else setStatus(`Изменение не подтверждено (${errText(e)}). Проверьте схему и повторите вручную.`);
        } catch { if (!dead) setStatus(`Неизвестно, сохранена ли схема (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
      } else setStatus(`Не удалось сохранить: ${errText(e)}`); // 4xx: введённое остаётся
      st.busy = false; paint();
    }
  }

  paint();
  load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Схема цветов изменена, но не сохранена. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}

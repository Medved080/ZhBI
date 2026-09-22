// «Цвет подписей марок»: личный цвет подписей на схеме (`PATCH /users/{свой id}/label-color`, как в V1). Хранится за
// пользователем и на других не влияет; менять его вправе только тот, у кого есть право записи в «Пользователи» — как в V1.
// Барьер безопасности данных: id — из сессии, одна запись за раз, ввод не теряется при ошибке, успех — после ответа
// сервера и повторного чтения `/me`, неизвестный исход (сеть/5xx) не повторяется, а проверяется чтением, сторож несохранённого.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = "#222222"; // как DEFAULT_LABEL_COLOR в V1
const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
// Сервер допускает #RGB и #RRGGBBAA, а поле выбора цвета — только #rrggbb: для показа приводим к шести знакам (альфа не показывается).
const to6 = (v) => {
  const x = String(v || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(x)) return x;
  if (/^#[0-9a-f]{3,4}$/.test(x)) return "#" + [...x.slice(1, 4)].map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/.test(x)) return x.slice(0, 7);
  return DEFAULT_COLOR;
};

export function mountLabelColorEdit(el, { screen, structure, objectId, api, user, rights, groupTitle }) {
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.users === "write";
  let dead = false, busy = false;
  let saved = (user.label_color || "").toLowerCase() || null; // то, что хранит сервер (null — цвет по умолчанию)
  const shown = (v) => (v ? to6(v) : DEFAULT_COLOR);
  let draft = shown(saved);
  const dirty = () => draft.toLowerCase() !== shown(saved).toLowerCase();

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Личная настройка." : "Просмотр."}</strong> Цвет подписей марок на схеме (2D и 3D) виден только вам и на других пользователей не влияет.
        ${canWrite ? "" : "У вас нет права менять эту настройку."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <form id="lc-form" autocomplete="off" class="v2-lc">
        <label class="v2-wire-field"><span>Цвет</span><input type="color" id="lc-color" ${canWrite ? "" : "disabled"}></label>
        <code id="lc-hex"></code>
        <span id="lc-sample" class="v2-lc-sample" aria-hidden="true">КП-12 · 3Ф-4</span>
        <div class="v2-bar">
          <button type="submit" class="v2-btn v2-primary" id="lc-save">Сохранить</button>
          <button type="button" class="v2-btn" id="lc-revert">Отменить правку</button>
          <button type="button" class="v2-btn" id="lc-reset">Сбросить на умолчание</button>
        </div>
      </form>
      <p id="lc-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#lc-status"); if (n) n.textContent = t; };

  function paint() {
    if (dead) return;
    $("#lc-color").value = draft;
    $("#lc-hex").textContent = draft + (saved === null && !dirty() ? " (по умолчанию)" : "");
    $("#lc-sample").style.color = draft;
    $("#lc-color").disabled = busy || !canWrite;
    $("#lc-save").disabled = busy || !canWrite || !dirty();
    $("#lc-revert").disabled = busy || !canWrite || !dirty();
    $("#lc-reset").disabled = busy || !canWrite || (saved === null && !dirty());
  }

  // Повторное чтение: единственный источник правды после записи.
  async function readBack() { const me = await api.get("/me"); return (me.label_color || "").toLowerCase() || null; }

  async function write(value) { // value — "#rrggbb" или null (сброс)
    if (busy || !canWrite) return;
    if (value !== null && !HEX.test(value)) { setStatus("Некорректный цвет."); return; }
    const want = value === null ? null : value.toLowerCase();
    busy = true; paint(); setStatus("Сохранение…");
    try {
      await api.patch(`/users/${user.id}/label-color`, { label_color: want });
      let got;
      try { got = await readBack(); } catch {
        // запись прошла, а прочитать не вышло: принимаем отправленное как сохранённое, чтобы экран не считался несохранённым
        if (!dead) { saved = want; user.label_color = want; draft = shown(want); setStatus("Сохранено, но перечитать не удалось — обновите страницу и проверьте."); }
        busy = false; paint(); return;
      }
      if (dead) return;
      saved = got; user.label_color = got; draft = shown(got);
      setStatus(got === want ? (want === null ? "Сброшено на цвет по умолчанию, подтверждено чтением." : "Цвет сохранён и подтверждён чтением.") : "Сервер вернул другой цвет — проверьте.");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        // исход неизвестен — не повторяем, сначала смотрим, что записано
        try {
          const got = await readBack();
          if (dead) return;
          if (got === want) { saved = got; user.label_color = got; draft = shown(got); setStatus("Сервер сохранил цвет, хотя ответ не дошёл."); }
          else setStatus(`Изменение не подтверждено (${errText(e)}). Введённое сохранено на экране — повторите вручную.`);
        } catch { if (!dead) setStatus(`Неизвестно, сохранён ли цвет (${errText(e)}). Обновите страницу и проверьте.`); }
      } else if (!dead) setStatus(`Не удалось сохранить: ${errText(e)}`); // 4xx: введённое остаётся
    } finally { busy = false; paint(); }
  }

  $("#lc-color").addEventListener("input", (e) => { draft = e.target.value; paint(); });
  $("#lc-form").addEventListener("submit", (e) => { e.preventDefault(); write(draft); });
  $("#lc-revert").addEventListener("click", () => { draft = shown(saved); paint(); });
  $("#lc-reset").addEventListener("click", () => { write(null); });
  paint();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Цвет подписей изменён, но не сохранён. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await write(draft);
      return !dirty();
    },
    destroy() { dead = true; },
  };
}

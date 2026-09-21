// «Обучение»: тест по инструкции и «Мои попытки»; «Как учатся сотрудники»: история попыток сотрудника (только чтение).
// Те же эндпоинты, что у V1 (`app/training.py`): GET /training/state, POST /training/attempts, POST /training/attempts/{id}/answer,
// GET /training/attempts[?user_id=], GET /training/attempts/{id}. Правильный вариант сервер отдаёт только ПОСЛЕ записи ответа; ответ на вопрос
// не меняется (повторный — 409), поэтому здесь двойной клик безопасен, а неизвестный исход не повторяется — состояние читается с сервера.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { errText } from "./admin-common.js";
import { mountReadScreen } from "./read-screen.js";
import { checkWrite } from "./write-gate.js";

const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const when = (v) => (v ? String(v).replace("T", " ").slice(0, 16) : "—");

function attemptsTable(rows, { withUser } = {}) {
  return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Начата</th><th>Набор</th><th class="num">Отвечено</th><th class="num">Верно</th><th>Завершена</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td>${esc(when(a.started_at))}</td><td>${esc(a.scope || "")}${a.role_name ? ` <span class="v2-muted">(${esc(a.role_name)})</span>` : ""}</td><td class="num">${a.answered} из ${a.questions}</td><td class="num">${a.correct}</td><td>${a.finished_at ? esc(when(a.finished_at)) : "не завершена"}</td>
      <td><button type="button" class="v2-btn" data-detail="${a.id}"${withUser ? ` data-user="${withUser}"` : ""}>Разбор</button></td></tr>`).join("")}</tbody></table></div>`;
}
function detailHtml(d) {
  const answers = d.answers || [];
  return `<div class="v2-callout" role="note"><strong>Попытка №${esc(d.id ?? "")}</strong>: ${answers.filter((x) => x.is_correct).length} верно из ${answers.length}.</div>
    ${answers.map((x, i) => `<div class="v2-perm"><div><strong>${i + 1}. ${esc(x.question)}</strong><small>Ответ: ${esc(x.chosen)}${x.is_correct ? " — верно" : ` — неверно; правильно: ${esc(x.correct_text)}`}${x.spent_ms != null ? ` · ${Math.round(x.spent_ms / 1000)} с` : ""}</small></div>
      <span class="v2-tag">${x.is_correct ? "верно" : "неверно"}</span></div>`).join("")}`;
}

export function mountTraining(el, ctx) {
  const { screen, api } = ctx;
  const canStart = checkWrite("POST", "/training/attempts", {}).allowed;
  el.className = "v2-page";
  el.innerHTML = `<div id="tr-read"></div><div class="v2-container v2-screen"><section class="v2-result" id="tr-test"></section><section class="v2-result" id="tr-attempts"></section></div>`;
  const readModule = mountReadScreen(el.querySelector("#tr-read"), { ...ctx, screen: { ...screen, impl: "read" } });
  const test = el.querySelector("#tr-test"), list = el.querySelector("#tr-attempts");
  let dead = false, busy = false, st = { attempt: null, rating: null, sections: [], error: "", fb: null, note: "" };
  const say = (t) => { st.note = t; const n = test.querySelector("#tr-note"); if (n) n.textContent = t; };

  function paint() {
    if (dead) return;
    const a = st.attempt;
    if (st.error) { test.innerHTML = `<h3>Проверить себя</h3><div class="v2-callout v2-callout-bad" role="alert">${esc(st.error)} <button type="button" class="v2-btn" id="tr-retry">Повторить</button></div>`; return; }
    if (!a) {
      test.innerHTML = `<h3>Проверить себя</h3>
        <p class="v2-muted">Тест по инструкции: ${esc(st.perAttempt || 20)} вопросов. Правильный вариант показывается после ответа; ответ изменить нельзя.${st.rating ? ` Ваш итог по всем разделам: лучшая попытка ${esc(st.rating.best)} из ${esc(st.rating.total)} (попыток: ${esc(st.rating.attempts)}).` : ""}</p>
        ${canStart ? `<div class="v2-inline"><label class="v2-field">Раздел<select id="tr-section"><option value="">Все доступные разделы</option>${st.sections.map((s) => `<option value="${esc(s.feature)}">${esc(s.section)}</option>`).join("")}</select></label>
          <button type="button" class="v2-btn v2-primary" id="tr-start" ${busy ? "disabled" : ""}>Начать тест</button></div>` : `<p class="v2-note">Начать тест в этом окружении нельзя.</p>`}
        <p class="v2-muted" id="tr-note" role="status" aria-live="polite">${esc(st.note)}</p>${st.fb?.finished ? `<div class="v2-callout" role="note"><strong>Тест завершён.</strong> Верно ${esc(st.fb.score.correct)} из ${esc(st.fb.score.questions)}.</div>` : ""}`;
      return;
    }
    const q = a.question;
    const fb = st.fb && !st.fb.finished ? st.fb : null;
    test.innerHTML = `<h3>Тест: вопрос ${q ? q.number : a.answered} из ${a.questions} <span class="v2-tag">верно ${a.correct}</span></h3>
      <p class="v2-muted">${esc(a.scope || "")}</p>
      ${fb ? `<div class="v2-callout ${fb.correct ? "" : "v2-callout-bad"}" role="status"><strong>${fb.correct ? "Верно." : `Неверно. Правильный ответ: ${esc(fb.correct_text)}`}</strong> ${esc(fb.explain || "")}</div>` : ""}
      ${q ? `<p><strong>${esc(q.block_title || "")}</strong></p><p>${esc(q.text)}</p>
      <div role="radiogroup" aria-label="Варианты ответа">${q.options.map((o, i) => `<label class="v2-role-check"><input type="radio" name="tr-opt" value="${i}" ${busy ? "disabled" : ""}><span>${esc(o)}</span></label>`).join("")}</div>
      <div class="v2-inline"><button type="button" class="v2-btn v2-primary" id="tr-answer" disabled>Ответить</button></div>` : `<p class="v2-note">Вопросов больше нет.</p>`}
      <p class="v2-muted" id="tr-note" role="status" aria-live="polite">${esc(st.note)}</p>`;
    const btn = test.querySelector("#tr-answer");
    test.querySelectorAll("input[name=tr-opt]").forEach((r) => r.addEventListener("change", () => { if (btn) btn.disabled = busy; }));
  }
  async function loadState() {
    try {
      const [s, g] = await Promise.all([api.get("/training/state"), api.get("/training/guide")]);
      if (dead) return false;
      st.attempt = s.attempt; st.rating = s.rating; st.perAttempt = s.questions_per_attempt; st.error = "";
      const seen = new Map();
      for (const b of g.blocks || []) if (b.feature && b.questions > 0 && !seen.has(b.feature)) seen.set(b.feature, b.section || b.title);
      st.sections = [...seen].map(([feature, section]) => ({ feature, section }));
      paint(); return true;
    } catch (e) { if (!dead) { st.error = `Не удалось загрузить тест: ${errText(e)}`; paint(); } return false; }
  }
  async function loadAttempts() {
    try {
      const d = await api.get("/training/attempts");
      if (dead) return;
      list.innerHTML = `<h3>Мои попытки</h3>${d.attempts.length ? attemptsTable(d.attempts) : `<p class="v2-muted">Попыток пока нет.</p>`}<div id="tr-detail" aria-live="polite"></div>`;
    } catch (e) { if (!dead) list.innerHTML = `<h3>Мои попытки</h3><p class="v2-muted">Не удалось загрузить: ${esc(errText(e))}</p>`; }
  }

  test.addEventListener("click", async (e) => {
    if (e.target.id === "tr-retry") { await loadState(); return; }
    if (busy) return;
    if (e.target.id === "tr-start") {
      const feature_key = test.querySelector("#tr-section")?.value || null;   // читаем ДО перерисовки: она пересоздаёт выбор раздела
      busy = true; paint(); say("Готовим вопросы…");
      try {
        const r = await api.post("/training/attempts", feature_key ? { feature_key } : {});
        st.fb = null;
        await loadState();
        say(r.resumed ? "Продолжаем незавершённую попытку (новая не начиналась)." : "");
      } catch (err) {
        if (unknownOutcome(err)) { const ok = await loadState(); say(ok && st.attempt ? "Сервер начал попытку, хотя ответ не дошёл." : `Неизвестно, начата ли попытка (${errText(err)}).`); }
        else say(errText(err));
      }
      busy = false; paint(); loadAttempts();
      return;
    }
    if (e.target.id === "tr-answer") {
      const sel = test.querySelector("input[name=tr-opt]:checked");
      const q = st.attempt?.question;
      if (!sel || !q) return;
      busy = true; test.querySelectorAll("input, button").forEach((c) => { c.disabled = true; });
      try {
        const r = await api.post(`/training/attempts/${st.attempt.id}/answer`, { question_key: q.key, option: Number(sel.value) });
        st.fb = r;
        st.attempt = { ...st.attempt, answered: r.score.answered, correct: r.score.correct, question: r.question };
        if (r.finished) { st.attempt = null; await loadState(); st.fb = r; loadAttempts(); }
        busy = false; paint();
      } catch (err) {
        if (unknownOutcome(err)) {
          // Ответ мог быть записан: повторно НЕ отправляем (сервер всё равно отклонил бы 409), читаем состояние.
          const before = q.key;
          const ok = await loadState();
          busy = false;
          if (ok && (!st.attempt || st.attempt.question?.key !== before)) { st.fb = null; paint(); say("Ответ записан, хотя ответ сервера не дошёл. Продолжайте со следующего вопроса."); }
          else { paint(); say(`Ответ не подтверждён (${errText(err)}). Можно ответить ещё раз.`); }
        } else { busy = false; if (err instanceof ApiError && err.status === 409) { await loadState(); paint(); say("Этот вопрос уже отвечен — показан следующий."); } else { paint(); say(errText(err)); } }
      }
    }
  });
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-detail]");
    if (!b) return;
    const box = list.querySelector("#tr-detail");
    box.textContent = "Загрузка…";
    try { box.innerHTML = detailHtml(await api.get(`/training/attempts/${b.dataset.detail}`)); }
    catch (err) { box.textContent = errText(err); }
  });
  loadState();
  loadAttempts();
  return { hasUnsavedChanges: () => false, guardLeave: async () => !busy, destroy() { dead = true; readModule?.destroy?.(); } };
}

export function mountTrainingHistory(el, ctx) {
  const { screen, api } = ctx;
  el.className = "v2-page";
  el.innerHTML = `<div id="th-read"></div><div class="v2-container v2-screen"><section class="v2-result" id="th-attempts"></section></div>`;
  const readModule = mountReadScreen(el.querySelector("#th-read"), { ...ctx, screen: { ...screen, impl: "read" } });
  const box = el.querySelector("#th-attempts");
  let dead = false;
  box.innerHTML = `<h3>Попытки сотрудника</h3><div class="v2-inline"><label class="v2-field">Сотрудник<select id="th-user"><option value="">— выберите —</option></select></label></div><div id="th-list"></div><div id="th-detail" aria-live="polite"></div>`;
  api.get("/training/ratings").then((d) => {
    if (dead) return;
    box.querySelector("#th-user").innerHTML += d.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
  }).catch((e) => { if (!dead) box.querySelector("#th-list").textContent = errText(e); });
  box.querySelector("#th-user").addEventListener("change", async (e) => {
    const id = e.target.value, out = box.querySelector("#th-list");
    box.querySelector("#th-detail").innerHTML = "";
    if (!id) { out.innerHTML = ""; return; }
    out.textContent = "Загрузка…";
    try { const d = await api.get(`/training/attempts?user_id=${encodeURIComponent(id)}`); out.innerHTML = d.attempts.length ? attemptsTable(d.attempts, { withUser: id }) : `<p class="v2-muted">Попыток нет.</p>`; }
    catch (err) { out.textContent = errText(err); }
  });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-detail]");
    if (!b) return;
    const out = box.querySelector("#th-detail"); out.textContent = "Загрузка…";
    try { out.innerHTML = detailHtml(await api.get(`/training/attempts/${b.dataset.detail}`)); }
    catch (err) { out.textContent = errText(err); }
  });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; readModule?.destroy?.(); } };
}

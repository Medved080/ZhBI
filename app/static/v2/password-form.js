// Форма смены СОБСТВЕННОГО пароля — одна на экран входа (обязательная смена) и раздел «Сменить пароль».
// Тот же эндпоинт, что у V1: `POST /me/change-password` (текущий пароль, новый). Все правила пароля проверяет СЕРВЕР
// (`auth.validate_password_strength`); требования читаются оттуда же (`GET /password-policy`) и показываются до отправки.
//
// Безопасность:
//  * значения паролей живут только в полях формы и уходят одним запросом; в журнал, адрес, хранилище браузера и текст ошибок не попадают;
//  * повторная отправка невозможна, пока идёт запрос; неизвестный исход (сеть/5xx) НЕ повторяется автоматически — сверяемся с сервером;
//  * у доменной учётной записи формы нет: пароль меняется в домене (сервер отвечает 409 так же).
import { ApiError } from "./api.js";

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountPasswordForm(host, { api, user, forced = false, onSuccess, onLogout }) {
  let dead = false, busy = false;
  if (user?.auth_method === "domain") {
    host.innerHTML = `<div class="v2-note">У вас доменная учётная запись: пароль меняется в домене, а не здесь.</div>`;
    return { destroy() { dead = true; } };
  }
  host.innerHTML = `
    <form id="pw-form" autocomplete="off" novalidate>
      <p class="v2-muted" id="pw-policy"></p>
      <label class="v2-field">Текущий пароль<input id="pw-cur" type="password" autocomplete="current-password"></label>
      <label class="v2-field">Новый пароль<input id="pw-new" type="password" autocomplete="new-password"></label>
      <label class="v2-field">Повторите новый пароль<input id="pw-rep" type="password" autocomplete="new-password"></label>
      <div class="v2-auth-error" id="pw-error" role="alert"></div>
      <div class="v2-inline"><button type="submit" class="v2-btn v2-primary" id="pw-submit">Сменить пароль</button>${forced ? `<button type="button" class="v2-btn" id="pw-logout">Выйти</button>` : ""}</div>
      <p class="v2-muted" id="pw-note" role="status" aria-live="polite"></p>
    </form>`;
  const $ = (s) => host.querySelector(s);
  api.get("/password-policy").then((p) => { if (!dead && $("#pw-policy")) $("#pw-policy").textContent = p.text || ""; }).catch(() => { /* подсказка вторична: правило всё равно проверит сервер */ });

  const setBusy = (v) => { busy = v; host.querySelectorAll("input, button").forEach((c) => { c.disabled = v; }); };
  const err = (t) => { $("#pw-error").textContent = t || ""; };

  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    err(""); $("#pw-note").textContent = "";
    const cur = $("#pw-cur").value, nw = $("#pw-new").value, rep = $("#pw-rep").value;
    if (!cur) { err("Введите текущий пароль"); $("#pw-cur").focus(); return; }
    if (!nw) { err("Введите новый пароль"); $("#pw-new").focus(); return; }
    if (nw !== rep) { err("Новый пароль и повтор не совпадают"); $("#pw-rep").focus(); return; }
    if (nw === cur) { err("Новый пароль должен отличаться от текущего"); $("#pw-new").focus(); return; }
    setBusy(true);
    try {
      const updated = await api.post("/me/change-password", { current_password: cur, new_password: nw });
      for (const id of ["#pw-cur", "#pw-new", "#pw-rep"]) $(id).value = "";
      setBusy(false);
      $("#pw-note").textContent = "Пароль изменён. Остальные ваши сеансы завершены.";
      onSuccess?.(updated);
    } catch (ex) {
      setBusy(false);
      if (ex instanceof ApiError && (ex.status === 0 || ex.status >= 500)) {
        // Исход неизвестен: пароль мог измениться. Не повторяем — спрашиваем сервер, требуется ли ещё смена.
        let text = `Неизвестно, изменён ли пароль (${ex.detail}). Ничего не повторено автоматически.`;
        try {
          const me = await api.get("/me");
          if (forced && !me.must_change_password) { onSuccess?.(me); return; }
          text += forced ? " Смена по-прежнему требуется — попробуйте ещё раз." : " Если пароль всё же изменился, войдите заново с новым.";
        } catch (e2) { text += " Проверьте связь с сервером и попробуйте позже."; }
        err(text);
      } else err(ex instanceof ApiError ? String(ex.detail) : "Не удалось сменить пароль");
      $("#pw-cur").focus();
    }
  });
  $("#pw-logout")?.addEventListener("click", () => { if (!busy) onLogout?.(); });
  return { destroy() { dead = true; }, isBusy: () => busy, hasInput: () => !!($("#pw-cur")?.value || $("#pw-new")?.value || $("#pw-rep")?.value) };
}

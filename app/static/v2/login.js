// Минимальный вход/смена пароля — часть ОБОЛОЧКИ V2, не пилота. Вся
// проверка (LDAP, антибрутфорс, сложность пароля) остаётся на сервере;
// здесь только форма поверх тех же эндпоинтов, что уже использует V1
// (POST /login, POST /me/change-password) — без своей копии правил.
import { ApiError } from "./api.js";
import { EXPERIMENTAL_NOTICE, checkWrite } from "./write-gate.js";

export async function renderLogin(root, { api, onSuccess }) {
  root.innerHTML = `
    <div class="v2-auth-screen">
      <div class="v2-auth-card">
        <h2>ЖБИ — новый интерфейс</h2>
        <small>${EXPERIMENTAL_NOTICE}. Вход тем же паролем, что и в текущем интерфейсе.</small>
        <form id="v2-login-form">
          <label class="v2-field">Логин
            <input id="v2-login-user" name="domain_login" autocomplete="username" list="v2-login-users" required>
            <datalist id="v2-login-users"></datalist>
          </label>
          <label class="v2-field">Пароль
            <input id="v2-login-pass" name="password" type="password" autocomplete="current-password">
          </label>
          <div class="v2-auth-error" id="v2-login-error" role="alert"></div>
          <button type="submit" class="v2-btn v2-primary">Войти</button>
        </form>
        <p class="v2-note"><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
      </div>
    </div>`;

  api.get("/login-users").then((list) => {
    const dl = root.querySelector("#v2-login-users");
    dl.innerHTML = list.map((u) => `<option value="${escapeAttr(u.domain_login)}">${escapeAttr(u.display_name)}</option>`).join("");
  }).catch(() => { /* список выключен администратором — обычный случай, не ошибка */ });

  root.querySelector("#v2-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = root.querySelector("#v2-login-error");
    errorEl.textContent = "";
    const domain_login = root.querySelector("#v2-login-user").value.trim();
    const password = root.querySelector("#v2-login-pass").value;
    try {
      const user = await api.post("/login", { domain_login, password });
      onSuccess(user);
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? String(err.detail) : "Не удалось войти";
    }
  });
}

export async function renderChangePassword(root, { api, onSuccess }) {
  // Смена пароля отключена политикой ограниченного выпуска (пароли — только в текущем интерфейсе): вместо формы —
  // объяснение и переход, чтобы человек не вводил пароли в экран, который всё равно откажет.
  if (!checkWrite("POST", "/me/change-password", {}).allowed) {
    root.innerHTML = `
      <div class="v2-auth-screen">
        <div class="v2-auth-card">
          <h2>Смена пароля</h2>
          <small>${EXPERIMENTAL_NOTICE}.</small>
          <p>Перед продолжением нужно задать свой пароль. В экспериментальном интерфейсе эта операция отключена — выполните её в текущем интерфейсе: войдите там, и система предложит задать новый пароль.</p>
          <p><a class="v2-btn v2-primary" href="/?ui=v1">Открыть текущий интерфейс</a></p>
        </div>
      </div>`;
    return;
  }
  root.innerHTML = `
    <div class="v2-auth-screen">
      <div class="v2-auth-card">
        <h2>Смена пароля</h2>
        <small>Администратор задал временный пароль — перед продолжением задайте свой</small>
        <form id="v2-pwd-form">
          <label class="v2-field">Текущий пароль
            <input id="v2-pwd-cur" type="password" autocomplete="current-password" required>
          </label>
          <label class="v2-field">Новый пароль
            <input id="v2-pwd-new" type="password" autocomplete="new-password" required>
          </label>
          <div class="v2-auth-error" id="v2-pwd-error" role="alert"></div>
          <button type="submit" class="v2-btn v2-primary">Сменить пароль</button>
        </form>
      </div>
    </div>`;

  root.querySelector("#v2-pwd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = root.querySelector("#v2-pwd-error");
    errorEl.textContent = "";
    try {
      const user = await api.post("/me/change-password", {
        current_password: root.querySelector("#v2-pwd-cur").value,
        new_password: root.querySelector("#v2-pwd-new").value,
      });
      onSuccess(user);
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? String(err.detail) : "Не удалось сменить пароль";
    }
  });
}

function escapeAttr(s) {
  return String(s ?? "").replace(/[&"'<>]/g, (c) =>
    ({ "&": "&amp;", '"': "&quot;", "'": "&#39;", "<": "&lt;", ">": "&gt;" }[c]));
}

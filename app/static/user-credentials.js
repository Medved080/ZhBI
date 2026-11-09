// Shared V1/V2 handoff. Plaintext credentials live only in this one-time dialog.
export function credentialsText(user, password, origin = location.origin) {
  const lines = ["PM", `Адрес: ${origin}/`, `Логин: ${user.domain_login}`];
  if (user.auth_method === "domain") lines.push("Вход: доменная учётная запись. Используйте свой доменный пароль.");
  else {
    lines.push(`Пароль: ${password}`);
    if (user.must_change_password) lines.push("При первом входе потребуется сменить пароль.");
  }
  return lines.join("\n");
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Corporate HTTP deployments may not expose the Clipboard API. */ }
  const input = document.createElement("textarea");
  input.value = text;
  input.className = "pc-clipboard";
  // Keep the fallback inside the modal: native dialogs make the rest of the page inert.
  (document.querySelector("dialog.pc-dialog[open]") || document.body).appendChild(input);
  input.select();
  try { if (!document.execCommand("copy")) throw Error("Clipboard unavailable"); }
  finally { input.remove(); }
}

export function showUserCredentials(user, password, { reset = false } = {}) {
  if (!document.querySelector('link[data-user-credentials]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "/static/user-credentials.css";
    css.dataset.userCredentials = ""; document.head.appendChild(css);
  }
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "pc-dialog";
    dialog.setAttribute("aria-labelledby", "pc-title");
    const element = (tag, text, className) => {
      const node = document.createElement(tag); node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const title = element("h2", reset ? "Новый пароль создан" : "Учётная запись создана");
    title.id = "pc-title"; dialog.appendChild(title);
    const domain = user.auth_method === "domain";
    dialog.appendChild(element("p", domain
      ? "Скопируйте адрес сервиса и логин для нового пользователя. Пароль хранится в домене."
      : "Пароль создан автоматически и показывается только сейчас. Скопируйте данные и передайте пользователю; при первом входе ему потребуется сменить пароль.", "pc-note"));
    const fields = element("dl", "", "pc-fields");
    for (const [label, value] of [["Адрес", `${location.origin}/`], ["Логин", user.domain_login],
      ...(domain ? [["Вход", "Доменная учётная запись"]] : [["Пароль", password]])]) {
      fields.append(element("dt", label), element("dd", value));
    }
    dialog.appendChild(fields);
    const status = element("p", "", "pc-status");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const actions = element("div", "", "pc-actions");
    const button = (text, action, primary = false) => {
      const b = element("button", text, `pc-btn${primary ? " pc-primary" : ""}`);
      b.type = "button"; b.addEventListener("click", action); actions.appendChild(b); return b;
    };
    const copy = async (text, message) => {
      try { await copyText(text); status.textContent = message; }
      catch { status.textContent = "Не удалось скопировать — выделите данные выше и скопируйте вручную."; }
    };
    button("Скопировать для отправки", () => copy(credentialsText(user, password),
      domain ? "Скопированы адрес и логин" : "Скопированы адрес, логин и пароль"), true);
    if (!domain) button("Только пароль", () => copy(password, "Пароль скопирован"));
    const warnLeave = (event) => { event.preventDefault(); event.returnValue = ""; };
    if (!domain) window.addEventListener("beforeunload", warnLeave);
    button("Готово", () => {
      window.removeEventListener("beforeunload", warnLeave);
      dialog.close(); dialog.remove();
      if (previous?.isConnected) previous.focus();
      resolve();
    });
    dialog.append(actions, status);
    // V1 also handles Escape on document; it must not close the editor underneath this modal.
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    });
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    document.body.appendChild(dialog); dialog.showModal();
  });
}

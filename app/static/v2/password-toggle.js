// Кнопка «показать / скрыть пароль» у поля пароля — то же, что в окне входа V1 (глазок справа от поля). Поле остаётся обычным
// <input>, поэтому менеджер паролей браузера работает как прежде; кнопка — рядом, внутри общей обёртки.
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 5.1A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/></svg>';

/** Оборачивает поле пароля и добавляет глазок. Возвращает `reset()` — вернуть поле в скрытый вид (после выхода и т. п.). */
export function attachPasswordToggle(input) {
  if (!input || input.dataset.pwToggle) return () => {};
  input.dataset.pwToggle = "1";
  const wrap = document.createElement("span");
  wrap.className = "v2-pw-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v2-pw-toggle";
  wrap.appendChild(btn);
  const paint = (show) => {
    input.type = show ? "text" : "password";
    btn.innerHTML = show ? EYE_OFF : EYE;
    btn.title = show ? "Скрыть пароль" : "Показать пароль";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", show ? "true" : "false");
  };
  btn.addEventListener("click", () => { paint(input.type === "password"); input.focus(); });
  paint(false);
  return () => paint(false);
}

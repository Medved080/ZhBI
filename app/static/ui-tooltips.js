// Единая подсказка по наведению и клавиатурному фокусу для V1/V2.
// Делегирование охватывает элементы, созданные после загрузки страницы;
// elementFromPoint позволяет показать причину недоступности disabled-кнопки.
(() => {
  const selector = "button, a[href], input:not([type=hidden]), select, textarea, label, summary, [data-tooltip], [role=button], [role=tab], [role=checkbox], [role=radio], [role=switch], [tabindex]:not([tabindex='-1'])[aria-label]";
  let tooltip = null, active = null, nativeTitle = null, describedBy = null;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);

  function description(control) {
    if (!control || control.matches("[data-no-tooltip]")) return "";
    const explicit = clean(control.getAttribute("data-tooltip") || control.getAttribute("aria-description") ||
      control.getAttribute("title") || (control === active ? nativeTitle : ""));
    if (explicit) return explicit;
    const label = control.labels?.[0] || control.closest("label") ||
      (control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null);
    const labelText = clean(label?.textContent);
    const named = clean(control.getAttribute("aria-label") || labelText);
    if (named) return named;
    if (control.matches("input, textarea")) return clean(control.getAttribute("placeholder")) ||
      (control.type === "checkbox" ? "Включить или выключить параметр" : "Введите значение");
    if (control.matches("select")) return "Выбрать значение из списка";
    const text = clean(control.textContent);
    if (text) return text;
    if (control.matches("a[href]")) return "Открыть ссылку";
    if (control.matches("button, [role=button]")) return "Выполнить действие";
    return "Управление";
  }

  function restoreAttributes() {
    if (active && nativeTitle !== null && active.isConnected) active.setAttribute("title", nativeTitle);
    if (active && active.isConnected) {
      if (describedBy === null) active.removeAttribute("aria-describedby");
      else active.setAttribute("aria-describedby", describedBy);
    }
    nativeTitle = null; describedBy = null;
  }
  function hide() {
    restoreAttributes(); active = null;
    if (tooltip) { tooltip.dataset.visible = "false"; tooltip.setAttribute("aria-hidden", "true"); }
  }
  function position(control, x, y) {
    const rect = control.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(x + 14, innerWidth - box.width - 8));
    let top = y + 18;
    if (top + box.height > innerHeight - 8) top = Math.max(8, rect.top - box.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
  function show(control, x, y) {
    const value = description(control);
    if (!value) { hide(); return; }
    if (active !== control) {
      restoreAttributes(); active = control;
      nativeTitle = control.hasAttribute("title") ? control.getAttribute("title") : null;
      describedBy = control.getAttribute("aria-describedby");
      if (nativeTitle !== null) control.removeAttribute("title");
      control.setAttribute("aria-describedby", [describedBy, "ui-control-tooltip"].filter(Boolean).join(" "));
    }
    if (!tooltip) {
      tooltip = document.createElement("div"); tooltip.id = "ui-control-tooltip";
      tooltip.setAttribute("role", "tooltip"); tooltip.setAttribute("aria-hidden", "true");
      document.body.appendChild(tooltip);
    }
    tooltip.textContent = value;
    tooltip.dataset.visible = "true";
    tooltip.setAttribute("aria-hidden", "false");
    position(control, x, y);
  }
  function controlAt(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) return null;
    const control = element.closest(selector);
    if (control) return control;
    const cell = element.closest("th, td, [data-ellipsis]");
    return cell && (cell.scrollWidth > cell.clientWidth + 1 || cell.scrollHeight > cell.clientHeight + 1) ? cell : null;
  }
  document.addEventListener("pointermove", (event) => {
    const control = controlAt(event.clientX, event.clientY);
    if (!control) hide();
    else show(control, event.clientX, event.clientY);
  }, true);
  document.addEventListener("focusin", (event) => {
    const control = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!control) { hide(); return; }
    const rect = control.getBoundingClientRect();
    show(control, rect.left + Math.min(rect.width / 2, 80), rect.bottom);
  }, true);
  document.addEventListener("focusout", () => { if (!active?.matches(":hover")) hide(); }, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  window.addEventListener("blur", hide);
})();

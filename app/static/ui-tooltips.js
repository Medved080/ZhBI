// Общие подсказки V1/V2: только пояснение назначения, а не повтор подписи.
// Наведение требует паузы; клавиатурный фокус показывает подсказку сразу.
(() => {
  const selector = "button, a[href], input:not([type=hidden]), select, textarea, label, summary, [title], [data-tooltip], [role=button], [role=tab], [role=checkbox], [role=radio], [role=switch], [tabindex]:not([tabindex='-1'])[aria-label]";
  const HOVER_DELAY = 1000;
  let tooltip = null, active = null, nativeTitle = null, describedBy = null;
  let timer = null, visible = false, pointerX = 0, pointerY = 0;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 320);
  const same = (a, b) => clean(a).toLocaleLowerCase("ru") === clean(b).toLocaleLowerCase("ru");

  function description(control) {
    if (!control || control.matches("[data-no-tooltip]")) return "";
    const label = control.labels?.[0] || control.closest("label") ||
      (control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null);
    const visibleName = clean(control.getAttribute("aria-label") || label?.textContent || control.textContent);
    const value = clean(control.value || control.getAttribute("placeholder"));
    const candidates = [control.getAttribute("data-tooltip"), control.getAttribute("aria-description"),
      control.getAttribute("title"), control === active ? nativeTitle : null];
    for (const candidate of candidates) {
      const tip = clean(candidate);
      if (tip && !same(tip, visibleName) && !same(tip, value)) return tip;
    }
    // Полный обрезанный текст полезен в таблице, но это не пояснение к полю.
    if (control.matches("th, td, [data-ellipsis]") &&
        (control.scrollWidth > control.clientWidth + 1 || control.scrollHeight > control.clientHeight + 1)) {
      return clean(control.textContent);
    }
    return "";
  }

  function restore() {
    if (active?.isConnected) {
      if (nativeTitle !== null) active.setAttribute("title", nativeTitle);
      if (describedBy === null) active.removeAttribute("aria-describedby");
      else active.setAttribute("aria-describedby", describedBy);
    }
    nativeTitle = null; describedBy = null;
  }
  function hide() {
    if (timer) clearTimeout(timer);
    timer = null; visible = false; restore(); active = null;
    if (tooltip) { tooltip.dataset.visible = "false"; tooltip.setAttribute("aria-hidden", "true"); }
  }
  function position(x, y) {
    const rect = active.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - box.width - 8))}px`;
    const below = y + 18;
    tooltip.style.top = `${below + box.height > innerHeight - 8 ? Math.max(8, rect.top - box.height - 8) : below}px`;
  }
  function show() {
    timer = null;
    if (!active?.isConnected) return hide();
    const value = description(active);
    if (!value) return;
    if (!tooltip) {
      tooltip = document.createElement("div"); tooltip.id = "ui-control-tooltip";
      tooltip.setAttribute("role", "tooltip"); tooltip.setAttribute("aria-hidden", "true");
      document.body.appendChild(tooltip);
    }
    active.setAttribute("aria-describedby", [describedBy, "ui-control-tooltip"].filter(Boolean).join(" "));
    tooltip.textContent = value; tooltip.dataset.visible = "true";
    tooltip.setAttribute("aria-hidden", "false"); visible = true;
    position(pointerX, pointerY);
  }
  function activate(control, x, y, delayed) {
    if (active !== control) {
      const hasExplanation = !!description(control);
      hide();
      active = control;
      nativeTitle = control.hasAttribute("title") ? control.getAttribute("title") : null;
      describedBy = control.getAttribute("aria-describedby");
      // Иначе браузер покажет собственный title раньше нашей задержки.
      if (nativeTitle !== null) control.removeAttribute("title");
      pointerX = x; pointerY = y;
      if (!hasExplanation) return;
      if (delayed) timer = setTimeout(show, HOVER_DELAY);
      else show();
    } else {
      pointerX = x; pointerY = y;
      if (visible) position(x, y);
    }
  }
  function controlAt(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) return null;
    const control = element.closest(selector);
    if (control) return control;
    if (active?.contains(element)) return active;
    const cell = element.closest("th, td, [data-ellipsis]");
    return cell && (cell.scrollWidth > cell.clientWidth + 1 || cell.scrollHeight > cell.clientHeight + 1) ? cell : null;
  }
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const control = controlAt(event.clientX, event.clientY);
    if (!control) hide();
    else activate(control, event.clientX, event.clientY, true);
  }, true);
  document.addEventListener("focusin", (event) => {
    const control = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!control) return hide();
    const rect = control.getBoundingClientRect();
    activate(control, rect.left + Math.min(rect.width / 2, 80), rect.bottom, false);
  }, true);
  document.addEventListener("focusout", () => { if (!active?.matches(":hover")) hide(); }, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  window.addEventListener("blur", hide);
})();

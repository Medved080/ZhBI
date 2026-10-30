const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

export function mountInstallationDate(host, { ids, value, request, onSaved }) {
  if (!host || !ids.length) return;
  if (!document.querySelector("link[data-install-date-css]")) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/static/planned-installation.css";
    link.dataset.installDateCss = "1"; document.head.appendChild(link);
  }
  host.innerHTML = `<form class="install-date-form"><label>Плановая дата монтажа<input type="date" name="date" value="${esc(value || "")}" required></label>
    <button type="submit">Сохранить${ids.length > 1 ? ` для ${ids.length} изделий` : ""}</button><button type="button" data-clear>Снять дату</button>
    <p role="status" aria-live="polite"></p></form>`;
  const form = host.querySelector("form"), message = form.querySelector("p");
  let busy = false;
  const save = async (date) => {
    if (busy) return;
    busy = true; form.querySelectorAll("button,input").forEach((n) => { n.disabled = true; }); message.textContent = "Сохранение…";
    try {
      const res = await request("/elements/bulk-planned-installation-date", { element_ids: ids, planned_installation_date: date });
      message.textContent = date ? "Плановая дата монтажа сохранена." : "Плановая дата монтажа снята.";
      await onSaved?.(res.updated);
    } catch (e) { message.textContent = e.message || "Не удалось сохранить дату"; }
    finally { busy = false; form.querySelectorAll("button,input").forEach((n) => { n.disabled = false; }); }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); if (form.reportValidity()) save(form.elements.date.value); });
  form.querySelector("[data-clear]").addEventListener("click", () => save(null));
}

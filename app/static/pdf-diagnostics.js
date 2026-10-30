// Общий просмотр замечаний PDF для V1/V2. Все замечания доступны, без усечения.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function pdfWarningsHtml(data) {
  if (!data.warnings?.length) return "";
  const rows = data.warnings.map((message, index) => {
    const info = data.warning_details?.[index];
    if (!info || !data.token) return `<li>${esc(message)}</li>`;
    const url = `/import-pdf/diagnostics/${encodeURIComponent(data.token)}/${index}`;
    const link = (href, title) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(title)}</a>`;
    let body;
    if (info.page) {
      body = `<p>${info.figures
        ? `Красным выделены фигуры этого замечания (${info.figures}). Номера на чертеже относятся только к ним.`
        : "Точный контур для этого замечания не определён; показан исходный лист для проверки."}</p>
        <p>${link(url, "Открыть фрагмент в полном размере")} · ${link(url + "?overview=true", "Лист целиком")}</p>
        <img src="${esc(url)}" loading="lazy" alt="Лист ${esc(info.page)}: ${esc(message)}"
          style="display:block;max-width:100%;max-height:60vh;width:auto;height:auto;border:1px solid #ddd" />`;
    } else {
      body = `<p>Замечание ко всему комплекту. Точный контур не определён. Исходные листы:</p>
        <p>${info.pages.map((page) => link(`${url}?page=${page}&overview=true`, `Лист ${page}`)).join(" · ")}</p>`;
    }
    return `<li><details><summary>${esc(message)}</summary>${body}</details></li>`;
  }).join("");
  return `<section aria-label="Замечания разбора PDF"><h3>Предупреждения (${data.warnings.length})</h3>
    <p>Раскройте замечание, чтобы увидеть отмеченные фигуры на исходном чертеже. Изображения доступны до применения или нового запуска сервера.</p>
    <ol style="padding-left:24px;line-height:1.5">${rows}</ol></section>`;
}

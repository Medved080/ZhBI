// Печать браузером (window.print()) — один общий узел на всё приложение V2 (mfr2). Разные экраны (отчёты, бланк обхода плоской
// шахматки) заполняют его ПЕРЕД каждым вызовом, а не держат каждый свой скрытый контейнер — иначе печать одного экрана могла бы
// показать поверх ещё и содержимое, оставленное другим экраном в прошлый раз (оба узла разом попадали бы под `@media print`).
// Скрыт вне печати, виден только в `@media print` — правило в `styles.css` (`#v2-print-area`).
export function printHtml(html) {
  let host = document.getElementById("v2-print-area");
  if (!host) { host = document.createElement("div"); host.id = "v2-print-area"; document.body.appendChild(host); }
  host.innerHTML = html;
  window.print();
}

import { clk, open, screen, setFile, text, reload, chk, summary, EX, SP } from "./hx.mjs";
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const b = await open("admin", { width: w, height: h });
  await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1200);
  const overflow = () => b.eval(`(()=>{const d=document.scrollingElement;const p=document.querySelector('#v2-content');return {page: d.scrollWidth - innerWidth, content: p.scrollWidth - p.clientWidth}})()`);
  for (const id of ["contracting-import", "schedule-import", "history-import", "status-restore", "objects-import", "bulk-edit", "upload-drawing", "import-input", "export-xls", "report-delivery", "report-contracting"]) {
    await screen(b, id); await b.sleep(600);
    const o = await overflow();
    chk(o.page <= 0 && o.content <= 2, `${w}×${h} ${id}: без горизонтальной прокрутки страницы (${JSON.stringify(o)})`);
  }
  // сверка bulk-edit: панель применения видна без прокрутки страницы
  await screen(b, "bulk-edit");
  await setFile(b, "#bk-file", EX + "/bk_fields.xlsx"); await clk(b, "#bk-analyze");
  await b.waitFor(`document.querySelector('#bk-table table')`, 30000);
  const vis = await b.eval(`(()=>{const r=document.querySelector('#bk-apply').getBoundingClientRect();return r.bottom<=innerHeight && r.top>=0})()`);
  chk(vis, `${w}×${h} bulk-edit: кнопка «Применить отмеченное» видна в окне (закреплена внизу)`);
  await b.shot(`${SP}/exchange_work/s_layout_${w}.png`);
  await reload(b, "#/");
  await b.close();
}
summary();

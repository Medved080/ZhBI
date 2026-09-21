import { open, screen, text, chk, summary, EX } from "./hx.mjs";
const IDS = ["contracting-import","schedule-import","history-import","status-restore","objects-import","bulk-edit"];
for (const user of ["user2", "user4", "user3"]) {
  const b = await open(user);
  const vis = await b.eval(`[...document.querySelectorAll('#v2-side button[data-section]')].map(x=>x.dataset.section).filter(x=>${JSON.stringify(IDS)}.includes(x))`);
  console.log(user, "видит экраны обмена:", JSON.stringify(vis));
  if (user === "user3") chk(vis.length === IDS.length, "user3 (второй админ) видит все операции");
  else chk(vis.length === 0, `${user}: экранов импорта в навигации нет`);
  await b.eval(`location.hash = "#/contracting-import"`); await b.sleep(800);
  const h = await b.eval(`document.querySelector('#v2-content h2')?.innerText||''`);
  if (user !== "user3") chk(!h.includes("Импорт контрактации"), `${user}: прямой адрес #/contracting-import не открывает форму (открыто: «${h}»)`);
  // прямой вызов API из страницы под этой ролью: 403
  const res = await b.eval(`(async()=>{const fd=new FormData();fd.append('file',new Blob([new Uint8Array([80,75])]),'a.xlsx');const r=await fetch('/import-contracting-xlsx?object_id=2',{method:'POST',body:fd});return r.status})()`);
  if (user !== "user3") chk(res === 403, `${user}: POST /import-contracting-xlsx прямым запросом → ${res}`);
  await b.close();
}
summary();

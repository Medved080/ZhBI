// Совместимость V1 на том же сервере после правок аудита: V1 загружается без ошибок, окна тех же 17 разделов открываются,
// 3D-предпросмотр зоны V1 строится (его код не трогали — контроль), сцена V1 в режиме кадра (embed-bridge.js правился) — в других проверках.
//   node scripts/audit_set/check_v1_smoke.mjs <копия БД> <порт>
import { session, ok, summary, BASE } from "./lib.mjs";

const b = await session(BASE, "admin");
await b.goto(BASE + "/?ui=v1&object_id=1", 1500);
await b.waitFor("!!document.getElementById('menu-view-mode') && typeof state === 'object' && state.elements && state.elements.length > 0", 60000, 500);
ok("V1 загрузился, схема объекта 1 показана", await b.eval("state.elements.length > 1000"));
const MENU = [
  ["menu-report-notes", "report-notes-backdrop"], ["menu-fill-scope", "fill-scope-backdrop"], ["menu-zones-zakhvatka", "zones-backdrop"],
  ["menu-subtypes", "subtypes-backdrop"], ["menu-mark-prefixes", "mark-type-prefixes-backdrop"], ["menu-address-classifier", "address-backdrop"],
  ["menu-db-status", "db-status-backdrop"], ["menu-bulk-edit", "bulk-edit-backdrop"], ["menu-admin-guide", "admin-guide-backdrop"],
  ["menu-view-mode", "menu-view-backdrop"], ["menu-label-color", "label-color-backdrop"], ["menu-colors", "settings-backdrop"],
  ["menu-shapes", "shapes-backdrop"], ["menu-zone-colors", "zone-colors-backdrop"], ["menu-info-plate-settings", "info-plate-settings-backdrop"],
];
for (const [menu, modal] of MENU) {
  const opened = await b.eval(`(async()=>{const m=document.getElementById(${JSON.stringify(menu)});if(!m)return 'нет пункта';m.click();await new Promise(r=>setTimeout(r,900));const d=document.getElementById(${JSON.stringify(modal)});const o=!!d&&d.classList.contains('open');if(d)d.classList.remove('open');return o})()`);
  ok(`V1: «${menu}» открывает ${modal}`, opened === true, String(opened));
}
// 3D-предпросмотр зоны в V1 (контроль, что он работает и что V2-перенос сравнивается с живым оригиналом)
const z = await b.eval(`(async()=>{document.getElementById('menu-zones-zakhvatka').click();await new Promise(r=>setTimeout(r,1500));const tr=document.querySelector('#zones-rows tr[data-zone-id]');if(!tr)return 'нет строки';tr.click();await new Promise(r=>setTimeout(r,1500));document.getElementById('zone-preview-3d').click();await new Promise(r=>setTimeout(r,2500));return !!document.querySelector('#zone-edit-preview3d canvas') && getComputedStyle(document.getElementById('zone-edit-preview3d')).display!=='none'})()`);
ok("V1: 3D-предпросмотр зоны строится", z === true, String(z));
ok("V1: без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
await b.close();
process.exit(summary());

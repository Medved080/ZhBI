// Зоны: 3D-предпросмотр в форме правки зоны (перенос V1 zonePreview3d). Настоящий backend, настоящие события мыши.
//   node scripts/audit_set/check_zones3d.mjs <копия БД> <порт>
import { session, sql, ok, summary, openSection, click, fill, DB, BASE, SHOTS, setObject, overflowX, as, regionColors } from "./lib.mjs";

for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const b = await session(BASE, "admin", { width: w, height: h });
  await openSection(b, "zones");
  await setObject(b, 1);
  // стоянка: у неё есть кран-владелец (красный контур) — самый полный случай
  await click(b, '[data-cat="Стоянка"]');
  await b.waitFor("!!document.querySelector('[data-open]')", 20000);
  const zone = sql(DB, "select z.id, z.name, (select count(*) from zone_levels l where l.zone_id=z.id) lv from zones z where z.object_id=1 and z.category='Стоянка' and z.is_current=1 and z.parent_zone_id is not null order by z.id limit 1")[0];
  await click(b, `[data-open="${zone.id}"]`);
  await b.waitFor("!!document.querySelector('#ze-preview')", 20000);
  ok(`${w}: форма открыта в 2D (как в V1 при каждом открытии)`, await b.eval(`document.querySelector('[data-pmode="2d"]').getAttribute('aria-pressed')==='true' && getComputedStyle(document.querySelector('#ze-preview')).display!=='none' && getComputedStyle(document.querySelector('#ze-preview3d')).display==='none'`));
  await click(b, '[data-pmode="3d"]');
  await b.waitFor("!!document.querySelector('#ze-preview3d canvas') && !!document.querySelector('#ze-preview3d').dataset.info", 20000);
  const info = JSON.parse(await b.eval("document.querySelector('#ze-preview3d').dataset.info"));
  ok(`${w}: 3D построен: объёмов = ярусов зоны (${zone.lv})`, info.meshes === zone.lv, JSON.stringify(info));
  ok(`${w}: 3D: контуры соседей и крана-владельца есть`, info.loops > 1, `контуров ${info.loops}`);
  ok(`${w}: 3D: номера точек активного яруса`, info.sprites >= 3, `подписей ${info.sprites}`);
  ok(`${w}: SVG 2D скрыт в режиме 3D`, await b.eval(`getComputedStyle(document.querySelector('#ze-preview')).display==='none'`));
  // вращение настоящим перетаскиванием мышью по холсту (OrbitControls)
  const r = await b.rect('#ze-preview3d canvas');
  await b.drag(r.cx - 60, r.cy, r.cx + 60, r.cy + 20, { steps: 10 });
  await b.sleep(300);
  // правка точки — предпросмотр перестраивается (подпись точки выделяется), камера НЕ переставляется
  await fill(b, 'input[data-pt="0:0:0"]', String(Number(await b.eval(`document.querySelector('input[data-pt="0:0:0"]').value`)) + 5000));
  await b.sleep(400);
  const info2 = JSON.parse(await b.eval("document.querySelector('#ze-preview3d').dataset.info"));
  ok(`${w}: вращение мышью сдвинуло камеру`, JSON.stringify(info2.camera) !== JSON.stringify(info.camera), `${info.camera} → ${info2.camera}`);
  // колесо — масштаб (холст мог сместиться прокруткой к полю ввода — меряем заново)
  const r2 = await b.rect('#ze-preview3d canvas');
  ok(`${w}: предпросмотр остаётся в поле зрения при прокрутке к полям точек (прилипает, как в V1)`, r2.y >= 0 && r2.y + r2.h <= h, `y=${Math.round(r2.y)}`);
  await b.wheel(r2.cx, r2.cy, -400); await b.sleep(300);
  await fill(b, 'input[data-pt="0:0:1"]', await b.eval(`document.querySelector('input[data-pt="0:0:1"]').value`));
  await b.sleep(300);
  const info3 = JSON.parse(await b.eval("document.querySelector('#ze-preview3d').dataset.info"));
  ok(`${w}: колесо приблизило камеру, правка точки не сбросила ракурс`, JSON.stringify(info3.camera) !== JSON.stringify(info2.camera));
  // пиксели холста не пусты: снимок в PNG и разница цветов
  await b.eval("document.querySelector('#ze-preview3d').scrollIntoView({block:'center'})"); await b.sleep(300);
  const colors = await regionColors(b, '#ze-preview3d canvas');
  ok(`${w}: холст 3D отрисован (не пустой: различных цветов ${colors})`, colors > 8);
  // «+ Ярус» — 3D строит новый объём, холст переносится в перерисованную форму
  await click(b, '#ze-add-level'); await b.sleep(600);
  const info4 = JSON.parse(await b.eval("document.querySelector('#ze-preview3d').dataset.info"));
  ok(`${w}: «+ Ярус» — объёмов стало на 1 больше, холст один`, info4.meshes === zone.lv + 1 && (await b.eval("document.querySelectorAll('#ze-preview3d canvas').length")) === 1, JSON.stringify(info4));
  ok(`${w}: нет горизонтальной прокрутки`, (await overflowX(b)) <= 1);
  if (SHOTS) await b.shot(`${SHOTS}/zones3d-${w}.png`);
  // обратно в 2D
  await click(b, '[data-pmode="2d"]'); await b.sleep(300);
  ok(`${w}: переключение обратно в 2D`, await b.eval(`getComputedStyle(document.querySelector('#ze-preview')).display!=='none' && !!document.querySelector('#ze-preview polygon')`));
  // уход без сохранения: сторож несохранённого → «Не сохранять»; WebGL освобождается
  const before = sql(DB, `select group_concat(outline_json,'|') g from zone_levels where zone_id=${zone.id}`)[0].g;
  await click(b, '#ze-back'); await b.sleep(300);
  const dlg = await b.eval("!!document.querySelector('.v2-dialog-backdrop')");
  ok(`${w}: сторож несохранённого при уходе из правки`, dlg);
  if (dlg) { await click(b, '.v2-dialog [data-choice="discard"]'); await b.sleep(500); }
  ok(`${w}: форма закрыта, холста 3D нет`, await b.eval("!document.querySelector('#ze-preview3d canvas') && !!document.querySelector('[data-cat]')"));
  const after = sql(DB, `select group_concat(outline_json,'|') g from zone_levels where zone_id=${zone.id}`)[0].g;
  ok(`${w}: предпросмотр ничего не записал (SQL контура тот же)`, before === after);
  ok(`${w}: без ошибок страницы`, b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close();
}

// Ограниченная роль: user4 (view) — правки зоны нет ни в V1 (canEditZones), ни в V2; сервер отказывает в записи
const u4 = await as("user4");
const z = sql(DB, "select id from zones where object_id=1 limit 1")[0];
const g = await u4.get(`/zones/${z.id}/geometry`);
const p = await u4.patch(`/zones/${z.id}`, { number: 1, name: "x", parent_zone_id: null, levels: [] });
ok("user4: PATCH /zones → 403", p.status === 403, `geometry ${g.status}, patch ${p.status}`);
// В V1 пункты меню «Захватки/Краны/Стоянки» требуют zones:write (index.html, data-feature-kind="write") — у роли «просмотр» их нет;
// в V2 экран так же не открывается (переход на «Начало»).
const b4 = await session(BASE, "user4");
await setObject(b4, 1); await openSection(b4, "zones"); await b4.sleep(1200);
ok("user4: экран зон недоступен, как пункт меню V1 (переход на «Начало»)", await b4.eval("location.hash==='#/' && !document.querySelector('[data-cat]')"));
await b4.close();
process.exit(summary());

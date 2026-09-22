// Настройки схемы, заданные в экранах V2, действительно применяются на СХЕМЕ рабочего места V2 (сцена V1 в кадре, мост zhbi-scene/1):
// цвет подписей, цвета статусов, форма маркеров, цвета зон, порог опоздания, видимость подписей, порог подписей и ракурс 3D (ЖБИ),
// цветовая схема модели (МФР). Настоящий backend, вход формой, настоящие щелчки/ввод (кроме системной палитры цвета и открытого
// списка <select> — у безголового браузера их нет, значение ставится программно с событием input/change, как у прежних проверок).
// После проверки все значения возвращаются к исходным (SQL сверяется).
//   node scripts/audit_set/check_scheme_settings.mjs <копия БД> <порт>
import { session, sql, ok, summary, go, click, fill, DB, BASE, SHOTS, setObject, frameEval, waitScene, as, idle, onBail } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
const setInput = (b, sel, value, ev = "input") => b.eval(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});if(!i)return false;i.value=${JSON.stringify(value)};i.dispatchEvent(new Event(${JSON.stringify(ev)},{bubbles:true}));return true})()`);
const statusText = (b, sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);

const admin = q1("select id, label_color, min_label_px, view3d_pitch_deg, view3d_yaw_deg from users where domain_login='admin'");
const baseStatus = q1("select color from status_colors where status='planned'").color;
const SHAPE_LAYER = "WEB_констр_Колонна_верхняя_ОТМП25800_элемент", SHAPE_TYPE = "Колонна";
const baseShape = sql(DB, `select shape from element_shapes where layer='${SHAPE_LAYER}' and element_type='${SHAPE_TYPE}'`)[0]?.shape ?? null;
const shapeEl = q1(`select id from elements where object_id=1 and layer='${SHAPE_LAYER}' and element_type='${SHAPE_TYPE}' limit 1`).id;
const plannedEl = q1(`select id from elements where object_id=1 and current_status='planned' and layer<>'${SHAPE_LAYER}' limit 1`).id;
const baseZone = q1("select color from zone_colors where object_id=1 and name='Кран 1'").color;
const baseLate = Number(q1("select value from app_settings where key='info_plate_late_threshold_days' and object_id=1").value);
const baseVis = q1("select visible from label_visibility where object_id=1 and element_type='Ригель'").visible;

async function restoreZhbi() {
  const a = await as("admin");
  const put = [];
  put.push(await a.patch(`/users/${admin.id}/label-color`, { label_color: admin.label_color }));
  put.push(await a.put("/status-colors", { planned: baseStatus }));
  put.push(await a.put("/element-shapes", [{ layer: SHAPE_LAYER, element_type: SHAPE_TYPE, shape: baseShape ?? "outline" }]));
  put.push(await a.put("/zone-colors?object_id=1", [{ name: "Кран 1", color: baseZone }]));
  put.push(await a.put("/settings/info-plate?object_id=1", { late_threshold_days: baseLate }));
  put.push(await a.put("/label-visibility?object_id=1", { "Ригель": !!Number(baseVis) }));
  put.push(await a.patch(`/users/${admin.id}/min-label-px`, { min_label_px: admin.min_label_px }));
  put.push(await a.patch(`/users/${admin.id}/view3d`, { view3d_pitch_deg: admin.view3d_pitch_deg ?? 30, view3d_yaw_deg: admin.view3d_yaw_deg ?? -30 }));
  return put;
}
onBail(restoreZhbi);

const b = await session(BASE, "admin");
await setObject(b, 1);

// ---- 1. Цвет подписей (экран label-color): настоящий щелчок «Сохранить»
await go(b, "label-color");
await b.waitFor("!!document.querySelector('#lc-color') && !document.querySelector('#lc-color').disabled");
await setInput(b, "#lc-color", "#2255aa");
await click(b, "#lc-save");
await b.waitFor(`/подтвержд|не удалось|неизвестно/i.test(document.querySelector('#lc-status')?.textContent||'')`, 15000);
ok("label-color: SQL users.label_color = #2255aa", q1(`select label_color c from users where id=${admin.id}`).c === "#2255aa");

// ---- 2. Цвета статусов (экран status-colors)
await go(b, "status-colors");
await b.waitFor(`!!document.querySelector('input[data-key="planned"]')`);
await setInput(b, 'input[data-key="planned"]', "#123456");
await click(b, "#ce-save");
await b.sleep(1200);
ok("status-colors: SQL planned = #123456", q1("select color from status_colors where status='planned'").color === "#123456");

// ---- 3. Форма маркеров (экран marker-shapes)
await go(b, "marker-shapes");
const shapeKey = JSON.stringify([SHAPE_LAYER, SHAPE_TYPE]);
const shapeSel = `select[data-key='${shapeKey.replace(/'/g, "\\'")}']`;
await b.waitFor(`!!document.querySelector(${JSON.stringify(shapeSel)})`, 15000);
ok("marker-shapes: строка пары есть", await b.eval(`!!document.querySelector(${JSON.stringify(shapeSel)})`));
await setInput(b, shapeSel, "square", "change");
await click(b, "#se2-save");
await b.sleep(1200);
ok("marker-shapes: SQL форма пары = square", sql(DB, `select shape from element_shapes where layer='${SHAPE_LAYER}' and element_type='${SHAPE_TYPE}'`)[0]?.shape === "square");

// ---- 4. Цвета зон (экран zone-colors, объект 1)
await go(b, "zone-colors");
await b.waitFor(`!!document.querySelector('input[type=color][data-key]')`);
const zoneKey = await b.eval(`[...document.querySelectorAll('input[type=color][data-key]')].map(i=>i.dataset.key).find(k=>/Кран 1/.test(k))`);
await setInput(b, `input[data-key="${zoneKey}"]`, "#aa00aa");
await click(b, "#ce-save");
await b.sleep(1200);
ok("zone-colors: SQL Кран 1 = #aa00aa", q1("select color from zone_colors where object_id=1 and name='Кран 1'").color === "#aa00aa");

// ---- 5. Порог опоздания (экран late-threshold): настоящий ввод с клавиатуры
await go(b, "late-threshold");
await b.waitFor("!!document.querySelector('#se-input')");
await fill(b, "#se-input", "5");
await click(b, "#se-save");
await b.sleep(1200);
ok("late-threshold: SQL = 5", Number(q1("select value from app_settings where key='info_plate_late_threshold_days' and object_id=1").value) === 5);

// ---- 6. Видимость подписей (экран label-visibility): настоящий щелчок по флажку «Ригель»
await go(b, "label-visibility");
await b.waitFor(`!!document.querySelector('input[data-vis="Ригель"]')`);
const visWas = await b.eval(`document.querySelector('input[data-vis="Ригель"]').checked`);
await click(b, `input[data-vis="Ригель"]`);
await click(b, "#vi-save");
await b.sleep(1200);
const visNow = q1("select visible from label_visibility where object_id=1 and element_type='Ригель'").visible;
ok("label-visibility: SQL Ригель переключён", Number(visNow) === (visWas ? 0 : 1), `было ${baseVis}, стало ${visNow}`);
ok("label-visibility: после сохранения экран не «изменён» (дефект: оставалась пометка и вопрос о несохранённом)", await b.eval(`!document.querySelector('#vi-body .v2-chip') && document.querySelector('#vi-save').disabled`));

// ---- 7. Внешний вид: порог подписей и ракурс 3D — настоящий ввод
await go(b, "appearance");
await fill(b, "#ap-minlabel", "18"); await click(b, "#ap-minlabel-save"); await b.sleep(900);
await fill(b, "#ap-pitch", "40"); await fill(b, "#ap-yaw", "20"); await click(b, "#ap-view3d-save"); await b.sleep(900);
const u = q1(`select min_label_px m, view3d_pitch_deg p, view3d_yaw_deg y from users where id=${admin.id}`);
ok("appearance: SQL min_label_px=18, pitch=40, yaw=20", Number(u.m) === 18 && Number(u.p) === 40 && Number(u.y) === 20, JSON.stringify(u));

// ---- Схема рабочего места V2 «Модель»: все настройки применены (кадр создаётся заново при входе в рабочее место)
await go(b, "ws-model");
await waitScene(b);
const f = await frameEval(b, `(()=>{
  const cs=getComputedStyle(document.documentElement);
  const lab=document.querySelector('.mark-label');
  const planned=[...document.querySelectorAll('.element-shape')].find(x=>{const e=state.byId.get(Number(x.getAttribute('data-id')));return e&&e.current_status==='planned'&&x.getAttribute('data-id')!=='${shapeEl}'});
  const shaped=document.querySelector('[data-id="${shapeEl}"]');
  const crane=state.zones.find(z=>z.category==='Кран'&&z.name==='Кран 1');
  const rigLabel=[...document.querySelectorAll('.mark-label')].find(t=>{const id=Number(t.getAttribute('data-id')||t.closest('[data-id]')?.getAttribute('data-id'));const e=state.byId.get(id);return e&&e.element_type==='Ригель'});
  return {
    labelVar: cs.getPropertyValue('--mark-label-color').trim(), labelFill: lab?getComputedStyle(lab).fill:null,
    statusPlanned: state.statusColors.planned, plannedFill: planned?planned.getAttribute('fill'):null, shapesDrawn: document.querySelectorAll('.element-shape').length,
    shape: state.elementShapes[shapeKeyFor(${JSON.stringify(SHAPE_LAYER)}, ${JSON.stringify(SHAPE_TYPE)})], renderedShape: shaped?shaped.getAttribute('data-shape'):null,
    craneColor: crane?crane.color:null, late: state.lateThresholdDays,
    visRig: state.labelVisibility['Ригель'], minLabel: minLabelPx(), angles: initial3DAngles(),
    rigLabelShown: rigLabel? getComputedStyle(rigLabel).display!=='none' : null,
  };
})()`);
console.log("   кадр:", JSON.stringify(f));
ok("схема V2: цвет подписей (CSS-переменная кадра и заливка подписи)", f.labelVar === "#2255aa" && (!f.labelFill || f.labelFill === "rgb(34, 85, 170)"), `${f.labelVar} / ${f.labelFill}`);
ok("схема V2: цвет статуса «Запланирован» у изделия на схеме", f.statusPlanned === "#123456" && String(f.plannedFill).toLowerCase() === "#123456", `${f.statusPlanned} / ${f.plannedFill}`);
ok("схема V2: форма маркера пары (состояние и нарисованная фигура)", f.shape === "square" && f.renderedShape === "square", `${f.shape} / ${f.renderedShape}`);
ok("схема V2: цвет зоны «Кран 1»", f.craneColor === "#aa00aa", f.craneColor);
ok("схема V2: порог опоздания объекта", f.late === 5, String(f.late));
ok("схема V2: видимость подписей типа «Ригель» — стартовое значение", (f.visRig !== false) === (Number(visNow) === 1), `state=${f.visRig}, показана=${f.rigLabelShown}`);
ok("схема V2: порог подписей и ракурс 3D пользователя", f.minLabel === 18 && f.angles.pitch === 40 && f.angles.yaw === 20, JSON.stringify([f.minLabel, f.angles]));
// панель V2 «Статус» берёт цвет статуса из снимка той же сцены
await click(b, '[data-tab="status"]'); await b.sleep(400);
const panelHasColor = await b.eval(`document.querySelector('#ws-panel-body').innerHTML.toLowerCase().includes('#123456')`);
ok("панель V2 рабочего места: цвет статуса тот же (#123456)", panelHasColor);
// 3D: начальный ракурс применяется при переходе в 3D (подъём камеры над целью ≈ 40°)
await click(b, '#ws-modes [data-view="3d"]');
await b.waitFor(`(()=>{const f=document.querySelector('iframe.ws-frame');try{return f.contentWindow.eval('state.view3d.active && !!state.view3d.camera')}catch(e){return false}})()`, 60000, 400).catch(() => {});
await b.sleep(2500);
const pitch3d = await frameEval(b, `(()=>{const c=state.view3d.camera,t=state.view3d.controls.target;const dx=c.position.x-t.x,dy=c.position.y-t.y,dz=c.position.z-t.z;return Math.round(Math.atan2(dy,Math.hypot(dx,dz))*180/Math.PI)})()`);
ok("схема V2 в 3D: подъём камеры = сохранённому (40°)", Math.abs(pitch3d - 40) <= 1, `${pitch3d}°`);
if (SHOTS) await b.shot(`${SHOTS}/scheme-settings-3d.png`);

// ---- Возврат исходных значений (HTTP под тем же admin, затем сверка SQL)
const put = await restoreZhbi();
ok("возврат исходных значений: все запросы 2xx", put.every((r) => r.status < 300), put.map((r) => r.status).join(","));
const back = q1(`select label_color, min_label_px from users where id=${admin.id}`);
ok("SQL после возврата совпадает с исходным", back.label_color === admin.label_color && Number(back.min_label_px) === Number(admin.min_label_px)
  && q1("select color from status_colors where status='planned'").color === baseStatus
  && q1("select color from zone_colors where object_id=1 and name='Кран 1'").color === baseZone
  && Number(q1("select value from app_settings where key='info_plate_late_threshold_days' and object_id=1").value) === baseLate
  && Number(q1("select visible from label_visibility where object_id=1 and element_type='Ригель'").visible) === Number(baseVis));
ok("без ошибок страницы (ЖБИ)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
await b.close();

// ---- МФР: цветовая схема модели (экран mfr-colors) применяется на схеме рабочего места «Модель МФР»
const baseRevit = sql(DB, "select value from app_settings where key='revit_colors' and object_id=4")[0]?.value ?? null;
const m = await session(BASE, "admin");
await setObject(m, 4);
await go(m, "mfr-colors");
await m.waitFor(`!!document.querySelector('input[type=color][data-cat="Стены"]')`, 20000);
await setInput(m, 'input[type=color][data-cat="Стены"]', "#ff8800");
await click(m, "#rc-save");
await m.sleep(1500);
const rv = JSON.parse(sql(DB, "select value from app_settings where key='revit_colors' and object_id=4")[0]?.value || "{}");
ok("mfr-colors: SQL цвет «Стены» объекта 4 = #ff8800", rv.colors?.["Стены"] === "#ff8800", JSON.stringify(rv.colors || {}).slice(0, 80));
await go(m, "ws-mfr");
await waitScene(m, 90000, "revitPlanState.objectId === 4 && revitColors.presets && revitColors.presets.length > 0");
const mc = await frameEval(m, `(()=>({wall: revitColors.colors['Стены'], preset: revitColors.preset}))()`);
ok("схема МФР V2: цвет «Стены» из сохранённой схемы", mc?.wall === "#ff8800", JSON.stringify(mc));
if (SHOTS) await m.shot(`${SHOTS}/scheme-settings-mfr.png`);
// возврат: прежняя схема целиком (если строки не было — схема по умолчанию объекта остаётся записанной, как отмечено в реестре)
const am = await as("admin");
if (baseRevit) {
  const r = await am.put("/revit-plan/colors?object_id=4", JSON.parse(baseRevit));
  ok("mfr-colors: возврат прежней схемы 2xx", r.status < 300, String(r.status));
  ok("mfr-colors: SQL совпадает с исходным", JSON.stringify(JSON.parse(sql(DB, "select value from app_settings where key='revit_colors' and object_id=4")[0].value)) === JSON.stringify(JSON.parse(baseRevit)));
} else {
  const cur = await am.get("/revit-plan/colors?object_id=4");
  const grey = (cur.data.presets || []).find((p) => p.key === "grey");
  const r = await am.put("/revit-plan/colors?object_id=4", { preset: "grey", colors: grey.colors, opacity: grey.opacity || {}, glow: grey.glow || {} });
  ok("mfr-colors: возврат к шаблону «Оттенки серого» 2xx", r.status < 300, String(r.status));
}
ok("без ошибок страницы (МФР)", m.exceptions.length === 0, m.exceptions.join(" | ").slice(0, 300));
await m.close();

// ---- Ограниченные роли: сервер отказывает в записи (403), как и в V1 (пунктов меню у них нет)
const u4 = await as("user4"), u2 = await as("user2");
const me4 = u4.me?.id ?? q1("select id from users where domain_login='user4'").id;
const deny = [
  ["label-color (user4, себе)", await u4.patch(`/users/${me4}/label-color`, { label_color: "#000000" })],
  ["status-colors (user4)", await u4.put("/status-colors", { planned: "#000000" })],
  ["status-colors (user2)", await u2.put("/status-colors", { planned: "#000000" })],
  ["element-shapes (user4)", await u4.put("/element-shapes", [{ layer: SHAPE_LAYER, element_type: SHAPE_TYPE, shape: "circle" }])],
  ["zone-colors (user4)", await u4.put("/zone-colors?object_id=1", [{ name: "Кран 1", color: "#000000" }])],
  ["late-threshold (user4)", await u4.put("/settings/info-plate?object_id=1", { late_threshold_days: 9 })],
  ["late-threshold (user2)", await u2.put("/settings/info-plate?object_id=1", { late_threshold_days: 9 })],
  ["label-visibility (user4)", await u4.put("/label-visibility?object_id=1", { "Ригель": true })],
  ["mfr-colors (user4)", await u4.put("/revit-plan/colors?object_id=4", { preset: "grey", colors: {}, opacity: {}, glow: {} })],
];
for (const [name, r] of deny) ok(`403: ${name}`, r.status === 403, String(r.status));
ok("после отказов ничего не изменилось (SQL)", q1("select color from status_colors where status='planned'").color === baseStatus
  && Number(q1("select value from app_settings where key='info_plate_late_threshold_days' and object_id=1").value) === baseLate);
process.exit(summary());

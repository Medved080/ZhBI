import { session, sql, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "appearance");
await b.sleep(500);

const uid = await b.eval(`document.querySelector('#ap-minlabel') ? 1 : 0`);
ok("поле min-label-px найдено", uid === 1);

const r1 = await b.rect("#ap-minlabel");
await b.click(r1.cx, r1.cy, { count: 3 });
await b.type("18");
await click(b, "#ap-minlabel-save");
await b.sleep(700);
const meId = sql(DB, "select id from users where domain_login='admin'")[0].id;
const row1 = sql(DB, `select min_label_px from users where id=${meId}`)[0];
ok("SQL: min_label_px сохранён = 18", Number(row1.min_label_px) === 18);

const rp = await b.rect("#ap-pitch"); await b.click(rp.cx, rp.cy, { count: 3 }); await b.type("40");
const ry = await b.rect("#ap-yaw"); await b.click(ry.cx, ry.cy, { count: 3 }); await b.type("200");
await click(b, "#ap-view3d-save");
await b.sleep(700);
const row2 = sql(DB, `select view3d_pitch_deg, view3d_yaw_deg from users where id=${meId}`)[0];
ok("SQL: pitch сохранён = 40", Number(row2.view3d_pitch_deg) === 40);
ok("SQL: yaw приведён к диапазону (200 -> -160)", Number(row2.view3d_yaw_deg) === -160);

await b.close();
process.exit(summary());

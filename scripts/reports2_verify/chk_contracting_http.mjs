// «График контрактации и поставки» — фильтр схемы на СЕРВЕРЕ (build_contracting_schedule(element_ids)): числа с
// отбором против прямого SQL по той же копии БД, пустой отбор, отбор «весь объект», чужие id, права (user2 только с
// доступом к объекту 1 — неполная роль готовится SQL в КОПИИ; user4 — просмотр; без входа). Настоящий сервер
// (scripts/real_auth_server.py), настоящий вход по паролю копии. Запуск: node scripts/reports2_verify/chk_contracting_http.mjs
import { startServer, stopServer, check, summary, sql, sql1, exec, SP, httpLogin } from "./lib.mjs";

const PORT = 8344;
const S = await startServer(PORT, `${SP}/r2_http`, {
  // user2 в копии БД: доступ к проекту 1 (оба объекта) и к объекту 1. Проектный доступ снимаем — остаётся ТОЛЬКО
  // объект 1, иначе «чужой объект» для него не найти.
  setup: (db) => exec(db, "DELETE FROM user_access WHERE object_id IS NULL AND user_id=(SELECT id FROM users WHERE domain_login='user2')"),
});
const EP = "/reports/contracting-schedule";
const rowKey = (r) => `${r.element_type || ""}|${r.mark}`;
try {
  const admin = await httpLogin(S.base, "admin");
  const full = await admin.post(EP, { object_id: 1, scale: "month" });
  check("без отбора: 200, строк > 0, ключа element_filter нет (ответ прежний)", full.status === 200 && full.json.rows.length > 0 && !("element_filter" in full.json), `строк ${full.json?.rows?.length}`);
  check("без отбора: в warning нет строки о фильтре схемы", !/фильтр схемы/.test(full.json.warning || ""));
  const byKeyFull = new Map(full.json.rows.map((r) => [rowKey(r), r]));

  // ---- отбор: изделия самой населённой стоянки объекта 1 ----
  const stance = sql1(S.db, "SELECT zone_stance_id FROM elements WHERE object_id=1 AND is_current=1 AND zone_stance_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1");
  const ids = sql(S.db, `SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND zone_stance_id=${stance}`).map((r) => r.id);
  const exp = sql(S.db, `SELECT coalesce(element_type,'') AS t, mark AS m, count(*) AS need,
      sum(CASE WHEN planned_delivery_date IS NOT NULL AND planned_delivery_date<>'' THEN 1 ELSE 0 END) AS planned,
      sum(CASE WHEN actual_delivery_date IS NOT NULL AND actual_delivery_date<>'' THEN 1 ELSE 0 END) AS fact,
      sum(CASE WHEN contract_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned
    FROM elements WHERE object_id=1 AND is_current=1 AND zone_stance_id=${stance} AND mark IS NOT NULL AND trim(mark)<>'' GROUP BY 1,2`);
  const expTot = exp.reduce((a, r) => ({ need: a.need + r.need, planned: a.planned + r.planned, fact: a.fact + r.fact, assigned: a.assigned + r.assigned }), { need: 0, planned: 0, fact: 0, assigned: 0 });
  const t0 = Date.now();
  const f = await admin.post(EP, { object_id: 1, scale: "month", element_ids: ids });
  const ms = Date.now() - t0;
  check("с отбором: 200", f.status === 200, `${ids.length} id стоянки ${stance}, ${ms} мс`);
  const t = f.json.totals;
  check("с отбором: потребность/план/факт/назначено = прямому SQL по отобранным", t.need === expTot.need && t.planned === expTot.planned && t.fact === expTot.fact && t.assigned === expTot.assigned,
    `отчёт ${JSON.stringify({ need: t.need, planned: t.planned, fact: t.fact, assigned: t.assigned })}; SQL ${JSON.stringify(expTot)}; без отбора need=${full.json.totals.need}`);
  check("с отбором: потребность МЕНЬШЕ, чем без отбора", t.need < full.json.totals.need, `${t.need} < ${full.json.totals.need}`);
  const keysF = new Set(f.json.rows.map(rowKey));
  const keysExp = new Set(exp.map((r) => `${r.t}|${r.m}`));
  check("с отбором: строки — ровно марки отобранных изделий", keysF.size === keysExp.size && [...keysExp].every((k) => keysF.has(k)), `марок ${keysF.size}, по SQL ${keysExp.size}, без отбора ${full.json.rows.length}`);
  const perRow = exp.every((e) => { const r = f.json.rows.find((x) => rowKey(x) === `${e.t}|${e.m}`); return r && r.need === e.need && r.planned === e.planned && r.fact === e.fact && r.assigned === e.assigned; });
  check("с отбором: по каждой марке потребность/план/факт/назначено = SQL", perRow);
  const contractedSame = f.json.rows.every((r) => r.contracted === (byKeyFull.get(rowKey(r))?.contracted ?? 0) && r.deficit === r.need - r.contracted);
  check("с отбором: «Законтрактовано» по марке НЕ делится (= без отбора), дефицит = потребность − законтрактовано", contractedSame);
  check("с отбором: element_filter и строка «Учтён фильтр схемы» в warning", f.json.element_filter?.elements === t.need && f.json.element_filter?.marks === f.json.rows.length && /Учтён фильтр схемы/.test(f.json.warning), JSON.stringify(f.json.element_filter));
  const sumDeltas = (row, k) => Object.values(row.deltas[k]).reduce((a, x) => a + x, 0);
  // Потребность встаёт на ось только с прогнозной датой (need_coverage.with_date), контракт — только с датой
  // спецификации (без неё — вне оси, так же и без отбора); план и факт — все.
  check("с отбором: приращения по периодам сходятся с итогами (план, факт; потребность — по изделиям с датой)",
    sumDeltas(f.json.totals, "planned") === t.planned && sumDeltas(f.json.totals, "fact") === t.fact && sumDeltas(f.json.totals, "need") === f.json.need_coverage.with_date && sumDeltas(f.json.totals, "contracted") <= t.contracted,
    `need на оси ${sumDeltas(f.json.totals, "need")} = с датой ${f.json.need_coverage.with_date} из ${f.json.need_coverage.total}`);

  // ---- пустой отбор, весь объект ----
  const e = await admin.post(EP, { object_id: 1, scale: "month", element_ids: [] });
  check("пустой отбор: строк нет, итоги нулевые", e.status === 200 && e.json.rows.length === 0 && e.json.totals.need === 0 && e.json.totals.contracted === 0, JSON.stringify(e.json?.totals && { need: e.json.totals.need, contracted: e.json.totals.contracted }));
  const allIds = sql(S.db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1").map((r) => r.id);
  const a = await admin.post(EP, { object_id: 1, scale: "month", element_ids: allIds });
  const same = ["need", "planned", "fact", "assigned"].every((k) => a.json.totals[k] === full.json.totals[k]);
  const noNeedRows = full.json.rows.filter((r) => r.need === 0).length;
  check("отбор «весь объект»: потребность/план/факт/назначено как без отбора", same, JSON.stringify({ all: a.json.totals.need, full: full.json.totals.need }));
  check("отбор «весь объект»: строк столько же, минус марки только из контрактов (без изделий в модели)", a.json.rows.length === full.json.rows.length - noNeedRows, `${a.json.rows.length} = ${full.json.rows.length} − ${noNeedRows}`);

  // ---- чужие id и права ----
  const foreign = sql(S.db, "SELECT id FROM elements WHERE object_id=2 AND is_current=1 LIMIT 5").map((r) => r.id);
  const mixA = await admin.post(EP, { object_id: 1, scale: "month", element_ids: [...ids, ...foreign] });
  check("администратор: id другого объекта в отборе объекта 1 не попадают в отчёт", mixA.status === 200 && mixA.json.totals.need === t.need, `need ${mixA.json?.totals?.need} (как без чужих: ${t.need})`);
  const u2 = await httpLogin(S.base, "user2");
  const own = await u2.post(EP, { object_id: 1, scale: "month", element_ids: ids });
  check("user2 (доступ только к объекту 1): свой отбор — 200, те же числа", own.status === 200 && own.json.totals.need === t.need);
  const mix2 = await u2.post(EP, { object_id: 1, scale: "month", element_ids: [...ids, ...foreign] });
  check("user2: отбор с id чужого объекта — 403 (запрос отклонён целиком)", mix2.status === 403, `${mix2.status} ${mix2.text.slice(0, 120)}`);
  const obj2 = await u2.post(EP, { object_id: 2, scale: "month" });
  check("user2: отчёт по чужому объекту — 403", obj2.status === 403, String(obj2.status));
  const u4 = await httpLogin(S.base, "user4");
  const v = await u4.post(EP, { object_id: 1, scale: "month", element_ids: ids });
  check("user4 (просмотр): чтение с отбором — 200, те же числа", v.status === 200 && v.json.totals.need === t.need, String(v.status));
  const anon = await fetch(`${S.base}${EP}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object_id: 1, element_ids: ids }) });
  check("без входа — 401", anon.status === 401, String(anon.status));
  // выгрузок в файл у отчёта нет и в V1 — сервер их не строит (ни с отбором, ни без)
  const x = await admin.post(`${EP}.xlsx`, { object_id: 1, element_ids: ids });
  check("выгрузки XLSX у отчёта нет (как и до правки)", x.status === 404 || x.status === 405, String(x.status));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  await stopServer();
}
process.exit(summary() ? 1 : 0);

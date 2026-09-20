// Самопроверка фейкового бэкенда стенда V2 (scripts/v2_tests/fake-backend.js)
// через НАСТОЯЩИЙ app/static/v2/api.js: без браузера, сервера и БД.
// Запуск: node scripts/v2_tests/fake-backend.selftest.mjs   (Node >= 22)
import { api, ApiError } from "../../app/static/v2/api.js";
import { installFakeBackend } from "./fake-backend.js";
const newSecret = "t-" + Math.random().toString(36).slice(2, 12); // синтетический, не хранится в коде
let ctlForPasswords = null; const userPassword = (login) => ctlForPasswords.data.users.find((u) => u.domain_login === login).password;

let failures = 0;
function check(cond, label) {
  if (cond) console.log("  ok   " + label);
  else { failures++; console.log("  FAIL " + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rejects(promise) {
  try { await promise; return null; } catch (e) { return e; }
}
// Завершился ли промис за ms (для проверки «пока держится hold, ответа нет»).
const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);
const isApiError = (e, status) => e instanceof ApiError && (status === undefined || e.status === status);

const originalFetch = globalThis.fetch;
const ctl = installFakeBackend(); ctlForPasswords = ctl;

console.log("Общие: /me, /me/permissions");
{
  const me = await api.get("/me");
  check(me.id === 1 && me.role === "admin" && me.display_name === "QA-Админов Анатолий Сергеевич", "вход по умолчанию — администратор");
  check(me.must_change_password === false && me.has_password === true && "ui_theme" in me, "UserOut: типичные поля на месте");
  const perms = await api.get("/me/permissions");
  check(perms.system_admin === true && perms.features.users === "write" && perms.features.dict_delete === "write", "администратор сервиса: всё write");
  check(Object.keys(perms.features).length >= 70 && perms.roles.length === 4 && perms.object_id === null, "features (весь реестр) и roles на месте");
  check(perms.role_features.user.status === "write" && perms.role_features.view.status === "read", "role_features: раскладка ролей");
  const mfr = await api.get("/me/permissions?object_id=6");
  check(mfr.object_kind === "mfr" && mfr.features.plan === "none" && mfr.not_applicable.includes("plan"), "объект МФР: разделы ЖБИ not_applicable даже у администратора");
  check(mfr.features.blocks === "write", "объект МФР: разделы МФР доступны");
  const e = await rejects(api.get("/me/permissions?object_id=999"));
  check(isApiError(e, 404) && e.detail === "Объект не найден", "permissions: несуществующий объект → 404");
}

console.log("Пользователи: список, создание, 409, 422");
{
  const users = await api.get("/users");
  check(users.length === 8 && users.every((u) => u.display_name.startsWith("QA-")), "GET /users: 8 синтетических пользователей");
  check(users[0].last_name < users[users.length - 1].last_name, "список отсортирован по фамилии");
  const nu = await api.post("/users", { last_name: "QA-Новый", first_name: "Н", domain_login: "qa.new", role: "user" });
  check(nu.id === 9 && nu.must_change_password === true && nu.auth_method === "local" && nu.has_password === false, "POST /users: создан (смена пароля по умолчанию)");
  check((await api.get("/users")).some((u) => u.id === 9), "новый пользователь виден в следующем GET");
  let e = await rejects(api.post("/users", { last_name: "QA-Дубль", domain_login: "qa.new", role: "user" }));
  check(isApiError(e, 409) && e.detail === "Такое доменное имя уже занято", "дубль логина → 409 со строкой detail");
  e = await rejects(api.post("/users", { first_name: "x" }));
  check(isApiError(e, 422) && /last_name: обязательное поле/.test(e.detail) && /domain_login: обязательное поле/.test(e.detail), "нет обязательных полей → 422 списком, ApiError.detail читаем");
  check(Array.isArray(e.rawDetail) && e.rawDetail[0].type === "missing", "rawDetail — список FastAPI");
  e = await rejects(api.post("/users", { last_name: "  ", domain_login: "qa.x", role: "user" }));
  check(isApiError(e, 422) && /last_name: слишком короткое значение/.test(e.detail), "пустая фамилия → 422");
  e = await rejects(api.post("/users", { last_name: "QA-Х", domain_login: "qa.y", role: "boss" }));
  check(isApiError(e, 422) && e.detail === "Неизвестная роль: boss", "неизвестная системная роль → 422 строкой");
  e = await rejects(api.patch("/users/999", { last_name: "QA-Х", domain_login: "qa.z", role: "user" }));
  check(isApiError(e, 404) && e.detail === "Пользователь не найден", "PATCH несуществующего → 404");
  e = await rejects(api.patch("/users/abc", { last_name: "QA-Х", domain_login: "qa.z", role: "user" }));
  check(isApiError(e, 422) && /user_id: нужно целое число/.test(e.detail), "нецелый id в пути → 422 int_parsing");
  e = await rejects(api.patch("/users/1", { last_name: "QA-Админов", domain_login: "qa.admin", role: "user" }));
  check(isApiError(e, 409) && /Нельзя снять роль администратора/.test(e.detail), "снять админа с себя → 409");
  const upd = await api.patch("/users/9", { last_name: "QA-Новый", first_name: "Новее", domain_login: "qa.new2", role: "view", position: " ", must_change_password: false });
  check(upd.first_name === "Новее" && upd.domain_login === "qa.new2" && upd.role === "view" && upd.must_change_password === false, "PATCH /users/{id}: правка применена");
  const pw = await api.post("/users/9/set-password", { password: newSecret, must_change_password: true });
  check(pw.has_password === true && pw.must_change_password === true, "set-password: пароль задан");
  e = await rejects(api.post("/users/9/set-password", { password: "short" }));
  check(isApiError(e, 422) && /не короче 8/.test(e.detail), "слабый пароль → 422");
  e = await rejects(api.post("/users/7/set-password", { password: newSecret }));
  check(isApiError(e, 409) && /доменная авторизация/.test(e.detail), "пароль доменному пользователю → 409");
}

console.log("hold(): запрос ждёт, release() отвечает; release(n) и fail()");
{
  ctl.clearLog();
  const h = ctl.hold("=/roles", "GET");
  let done = false;
  const p = api.get("/roles").then((r) => { done = true; return r; });
  await h.waitForRequest();
  check(h.pending === 1 && ctl.count("GET", "=/roles") === 1, "запрос уже в логе (count) и удерживается (pending) ДО ответа");
  check(ctl.log[0].released === false && ctl.log[0].status === null, "в логе: released=false, status ещё не проставлен");
  await sleep(30);
  check(!done, "пока hold не отпущен, ответа нет");
  h.release();
  const roles = await p;
  check(done && roles.roles.length === 4 && roles.features.length >= 70 && roles.sections.length === 13, "после release() — обычный ответ /roles");
  check(ctl.log[0].released === true && ctl.log[0].status === 200, "в логе: released=true, status=200");
  check(await settledWithin(api.get("/roles"), 200), "после release() следующие запросы идут свободно");

  const h2 = ctl.hold("=/smu");
  const a = api.get("/smu"), b = api.get("/smu");
  await h2.waitForRequest(2);
  check(h2.pending === 2, "несколько запросов копятся");
  h2.release(1);
  await a;
  check(h2.pending === 1 && !(await settledWithin(b, 30)), "release(1) отпускает только первый");
  h2.fail(503, "Сервис перегружен");
  const eb = await rejects(b);
  check(isApiError(eb, 503) && eb.detail === "Сервис перегружен", "fail(503, detail) → ApiError со статусом и текстом");
  check(ctl.log.filter((x) => x.path === "/smu").map((x) => x.status).join() === "200,503", "статусы в логе: 200 и 503");
}

console.log("failNext(): network, 422-список, 500 по умолчанию, HTML прокси");
{
  ctl.failNext("=/users", { network: true, method: "GET" });
  let e = await rejects(api.get("/users"));
  check(isApiError(e, 0) && /Нет связи с сервером/.test(e.detail), "network:true → ApiError status 0 («Нет связи»)");
  check(ctl.log[ctl.log.length - 1].status === 0, "в логе status=0");
  check(Array.isArray(await api.get("/users")), "следующий запрос уже проходит (times=1)");

  const before = (await api.get("/projects")).length;
  ctl.failNext("POST /projects", { status: 422, detail: [
    { loc: ["body", "name"], msg: "Field required", type: "missing" },
    { loc: ["body", "status"], msg: "String should have at least 1 character", type: "string_too_short" },
  ] });
  e = await rejects(api.post("/projects", { name: "QA-Не создастся" }));
  check(isApiError(e, 422) && e.detail === "Проверьте данные — name: обязательное поле; status: слишком короткое значение", "422-список → читаемый ApiError.detail");
  check(!e.detail.includes("[object"), "нет «[object Object]»");
  check((await api.get("/projects")).length === before, "упавший запрос не изменил данные");

  ctl.failNext("=/users", { times: 2 });
  e = await rejects(api.get("/users"));
  check(isApiError(e, 500) && e.detail === "Внутренняя ошибка сервера", "по умолчанию — 500 со строкой");
  check(isApiError(await rejects(api.get("/users")), 500) && Array.isArray(await api.get("/users")), "times=2: два отказа, третий ответ нормальный");

  ctl.failNext("=/users", { status: 502, rawBody: "<html>bad gateway</html>", contentType: "text/html" });
  e = await rejects(api.get("/users"));
  check(isApiError(e, 502) && e.detail === "Ошибка сервера (502). Повторите позже.", "HTML вместо JSON → запасной текст api.js");
}

console.log("Доступ пользователя: PUT /users/{id}/access и повторное чтение");
{
  const before = await api.get("/users/4/access");
  check(before.grants.length === 0 && before.system_admin === false, "у «без доступа» грантов нет");
  const put = await api.put("/users/4/access", { grants: [
    { project_id: 1, object_id: null, role: "user" }, { project_id: 2, object_id: 4, role: "contract" },
    { project_id: null, object_id: null, role: "view" },
  ] });
  check(put.grants.length === 3, "PUT вернул новый набор");
  const again = await api.get("/users/4/access");
  check(again.grants.length === 3 && again.grants[0].project_id === null, "GET: три гранта, «все проекты» (NULL) первым");
  check(again.grants.find((g) => g.object_id === 4).object_name === "QA-Секция 2.1", "имена проекта и объекта расшифрованы");
  const matrix = await api.get("/users/access-matrix");
  check(matrix.grants["4"].length === 3 && matrix.role_labels.view === "QA-Наблюдатель" && matrix.roles.length === 4, "access-matrix отражает запись");
  check(!("3" in { ...matrix.grants, 3: undefined }) || matrix.grants["3"].length === 1, "у других пользователей гранты не тронуты");
  const bad = [
    [{ grants: [{ project_id: null, object_id: null, role: "boss" }] }, 400, "Неизвестная роль «boss»"],
    [{ grants: [{ project_id: null, object_id: 4, role: "view" }] }, 400, null],
    [{ grants: [{ project_id: 1, object_id: 4, role: "view" }] }, 400, "Объект не принадлежит выбранному проекту"],
    [{ grants: [{ project_id: 1, object_id: null, role: "view" }, { project_id: 1, object_id: null, role: "view" }] }, 400, "В наборе есть повторяющиеся роли на одном уровне"],
    [{ grants: [{ project_id: 999, object_id: null, role: "view" }] }, 404, "Проект не найден"],
    [{ grants: [{ project_id: 1, object_id: 999, role: "view" }] }, 404, "Объект не найден"],
  ];
  for (const [body, status, text] of bad) {
    const e = await rejects(api.put("/users/4/access", body));
    check(isApiError(e, status) && (text === null || e.detail === text), `PUT access: ${status} ${text || "объект без проекта"}`);
  }
  check(isApiError(await rejects(api.put("/users/999/access", { grants: [] })), 404), "PUT access несуществующему пользователю → 404");
  check((await api.get("/users/4/access")).grants.length === 3, "после отказов набор не изменился");
  await api.put("/users/4/access", { grants: [] });
  check((await api.get("/users/4/access")).grants.length === 0, "пустой список снимает всё");
  check((await api.get("/users/1/access")).system_admin === true, "у администратора system_admin=true");

  const rm = await api.get("/users/6/rights-matrix?object_id=14");
  check(rm.object_roles.join() === "QA-Комплектовщик,QA-Прораб" && rm.object_kind === "zhbi" && rm.object_kind_label === "ЖБИ", "rights-matrix: роли на объекте (гранты трёх уровней складываются)");
  const st = rm.features.find((f) => f.key === "status");
  check(st.level === "write" && st.from_roles.map((r) => `${r.role}→${r.source}`).join() === "QA-Комплектовщик→все проекты,QA-Прораб→QA-Логпарк 8.1", "from_roles: источник роли (все проекты / объект)");
  check((await api.get("/users/1/rights-matrix")).system_admin === true, "rights-matrix администратора");
  check(isApiError(await rejects(api.get("/users/6/rights-matrix?object_id=999")), 404), "rights-matrix: объект не найден → 404");
}

console.log("Роли: создание, правка, порядок, ячейки, delete-plan, удаление");
{
  const r0 = await api.get("/roles");
  check(r0.roles.find((r) => r.key === "contract").granted === 2, "granted считается по user_access");
  const nr = await api.post("/roles", { name: "QA-Проверяющий" });
  check(/^qa_/.test(nr.key) && nr.name === "QA-Проверяющий" && nr.granted === 0 && nr.rank === 50, "POST /roles: новая роль пустая, rank +10");
  let e = await rejects(api.post("/roles", { name: "QA-Проверяющий" }));
  check(isApiError(e, 409) && e.detail === "Роль «QA-Проверяющий» уже есть", "дубль роли → 409 со строкой");
  e = await rejects(api.post("/roles", { name: "   " }));
  check(isApiError(e, 400) && e.detail === "Название роли не может быть пустым", "пустое название → 400 (как у бэкенда)");
  e = await rejects(api.post("/roles", {}));
  check(isApiError(e, 422) && /name: обязательное поле/.test(e.detail), "название не передано → 422-список");
  check((await api.patch(`/roles/${nr.key}`, { name: "QA-Проверяющий 2" })).name === "QA-Проверяющий 2", "PATCH /roles/{key}: переименование");
  check(isApiError(await rejects(api.patch(`/roles/${nr.key}`, { name: "QA-Прораб" })), 409), "переименование в занятое имя → 409");
  check(isApiError(await rejects(api.patch("/roles/nope", { name: "QA-Икс" })), 404), "PATCH несуществующей роли → 404");

  const keys = (await api.get("/roles")).roles.map((r) => r.key);
  await api.put("/roles/order", { keys: [...keys].reverse() });
  check((await api.get("/roles")).roles.map((r) => r.key).join() === [...keys].reverse().join(), "PUT /roles/order: порядок сохранён");
  check(isApiError(await rejects(api.put("/roles/order", { keys: keys.slice(1) })), 400), "порядок неполным списком → 400");

  const cell = await api.put("/roles/features", { items: [
    { role_key: nr.key, feature_key: "plan", level: "read" }, { role_key: nr.key, feature_key: "status", level: "write" },
    { role_key: nr.key, feature_key: "status", level: "write" },
  ] });
  check(cell.changed.length === 2 && cell.changed[0].was === "none" && cell.changed[0].now === "read", "PUT /roles/features: изменённые ячейки");
  const feats = (await api.get("/roles")).features;
  check(feats.find((f) => f.key === "plan").levels[nr.key] === "read", "GET /roles отражает ячейку");
  const atomic = await rejects(api.put("/roles/features", { items: [
    { role_key: nr.key, feature_key: "comment", level: "write" }, { role_key: nr.key, feature_key: "own_settings", level: "read" },
  ] }));
  check(isApiError(atomic, 400) && /роли не подчиняется/.test(atomic.detail), "раздел «своё» роли не подчиняется → 400");
  check((await api.get("/roles")).features.find((f) => f.key === "comment").levels[nr.key] === undefined, "ошибка на N-й ячейке не оставляет предыдущих");
  check(isApiError(await rejects(api.put("/roles/features", { items: [{ role_key: nr.key, feature_key: "zzz", level: "read" }] })), 400), "неизвестный раздел → 400");
  check(isApiError(await rejects(api.put("/roles/features", { items: [{ role_key: nr.key, feature_key: "plan", level: "x" }] })), 400), "неизвестный уровень → 400");

  await api.put("/users/4/access", { grants: [{ project_id: 2, object_id: null, role: nr.key }] });
  const plan = await api.get(`/roles/${nr.key}/delete-plan`);
  check(plan.granted === 1 && plan.users === 1 && plan.permissions === 2, "delete-plan: выдачи, люди, ячейки");
  const del = await api.delete(`/roles/${nr.key}`);
  check(del.deleted === nr.key && del.granted === 1, "DELETE /roles/{key}: снято выдач 1");
  check(!(await api.get("/roles")).roles.some((r) => r.key === nr.key), "роль исчезла из GET /roles");
  check((await api.get("/users/4/access")).grants.length === 0, "её выдачи сняты у пользователя");
  check(isApiError(await rejects(api.get(`/roles/${nr.key}/delete-plan`)), 404), "delete-plan удалённой роли → 404");
  check(isApiError(await rejects(api.delete(`/roles/${nr.key}`)), 404), "повторное удаление → 404");
}

console.log("Проекты и объекты: GET после POST, валидация, агрегаты");
{
  const p0 = await api.get("/projects");
  check(p0.length === 14 && p0.some((p) => p.objects_count === 0 && p.name.includes("без объектов")), "GET /projects: 14 проектов, один без объектов");
  const long = p0.find((p) => p.name.length > 150);
  check(long && long.address.length > 200, "есть проект с очень длинными названием и адресом");
  const np = await api.post("/projects", { name: "  QA-Новый проект  ", status: "active", description: null, address: "г QA-Город", lat: 55.5, lon: 37.5 });
  check(np.id === 15 && np.name === "QA-Новый проект" && np.objects_count === 0 && np.elements_count === 0 && np.lat === 55.5, "POST /projects: полный ProjectOut, имя без пробелов");
  const p1 = await api.get("/projects");
  check(p1.length === 15 && p1.some((p) => p.id === 15), "GET /projects после POST: 15, новый виден");
  const tree0 = (await api.get("/projects-tree")).projects;
  check(!tree0.some((p) => p.id === 15) && !tree0.some((p) => p.id === 9) && tree0.length === 13, "projects-tree прячет проекты без объектов (как бэкенд)");
  let e = await rejects(api.post("/projects", { name: "QA-Новый проект" }));
  check(isApiError(e, 409) && e.detail === "Проект с таким наименованием уже есть", "дубль проекта → 409");
  e = await rejects(api.post("/projects", { name: "   " }));
  check(isApiError(e, 400) && e.detail === "Наименование проекта не может быть пустым", "пустое имя → 400 (как у бэкенда)");
  e = await rejects(api.post("/projects", { description: "x" }));
  check(isApiError(e, 422) && /name: обязательное поле/.test(e.detail), "имя не передано → 422-список");
  e = await rejects(api.post("/projects", { name: "QA-Статус", status: "weird" }));
  check(isApiError(e, 400) && /^Статус бывает /.test(e.detail), "неизвестный статус → 400");
  e = await rejects(api.post("/projects", { name: "QA-Широта", lat: 100, lon: 10 }));
  check(isApiError(e, 400) && e.detail === "Широта вне допустимого диапазона (±90)", "широта вне диапазона → 400");
  const pp = await api.patch("/projects/15", { name: "QA-Новый проект 2", description: "описание" });
  check(pp.name === "QA-Новый проект 2" && pp.description === "описание" && pp.address === "г QA-Город", "PATCH проекта: меняются только присланные поля");
  e = await rejects(api.patch("/projects/1", { status: "archived" }));
  check(isApiError(e, 409) && /В проекте 3 активн/.test(e.detail), "архивация проекта с активными объектами → 409");
  check(isApiError(await rejects(api.patch("/projects/999", { name: "QA-Х" })), 404), "PATCH несуществующего проекта → 404");

  const o0 = await api.get("/objects");
  check(o0.length === 20 && o0.filter((o) => o.kind === "mfr").length === 1, "GET /objects: 20 объектов, один МФР");
  const o3 = o0.find((o) => o.id === 3);
  check(o3.has_avatar === true && o3.avatar_attachment_id === 1 && o3.smu_name === "QA-СМУ-2 Речное" && o3.smu_director_name === "QA-Кузнецов Сергей Николаевич", "объект 3: превью и имена справочников");
  const no = await api.post("/objects", { name: "QA-Новый объект", project_id: 15, kind: "mfr", smu_id: 1, responsible_id: 2, status: "active",
    description: null, smr_start_reported: "2026-01-01", media_url: null, lat: 55.1, lon: 37.1 });
  check(no.id === 21 && no.kind === "mfr" && no.project_name === "QA-Новый проект 2" && no.smu_name === "QA-СМУ-1 Северное" && no.responsible_name === "QA-Петров Пётр Петрович" && no.has_avatar === false, "POST /objects: полный ObjectOut с агрегатами");
  check((await api.get("/projects")).find((p) => p.id === 15).objects_count === 1, "objects_count проекта вырос");
  check((await api.get("/projects-tree")).projects.some((p) => p.id === 15 && p.objects.some((o) => o.id === 21)), "объект появился в projects-tree");
  e = await rejects(api.post("/objects", { name: "QA-Без проекта" }));
  check(isApiError(e, 422) && /project_id: обязательное поле/.test(e.detail), "нет project_id → 422");
  check(isApiError(await rejects(api.post("/objects", { name: "QA-Х", project_id: 999 })), 404), "проект не найден → 404");
  check(isApiError(await rejects(api.post("/objects", { name: "QA-Новый объект", project_id: 1 })), 409), "дубль объекта → 409");
  check(isApiError(await rejects(api.post("/objects", { name: "QA-Тип", project_id: 1, kind: "zzz" })), 400), "неизвестный тип учёта → 400");
  e = await rejects(api.post("/objects", { name: "QA-СМУ", project_id: 1, smu_id: 999 }));
  check(isApiError(e, 404) && e.detail === "СМУ: запись справочника не найдена", "несуществующее СМУ → 404");
  const mv = await api.patch("/objects/21", { project_id: 1, smu_id: null });
  check(mv.project_id === 1 && mv.smu_id === null && mv.smu_name === null, "PATCH объекта: перенос в проект, снятие СМУ");
  const pr = await api.get("/projects");
  check(pr.find((p) => p.id === 1).objects_count === 4 && pr.find((p) => p.id === 15).objects_count === 0, "агрегаты обоих проектов пересчитаны");
  check((await api.get("/smu")).length === 5 && (await api.get("/individuals")).length === 5, "справочники СМУ и физлиц: по 5");
  check((await api.post("/smu", { name: "QA-СМУ-6" })).id === 6 && isApiError(await rejects(api.post("/smu", { name: "qa-СМУ-6" })), 409), "POST /smu: создан; дубль (NOCASE по ASCII) → 409");
}

console.log("Вложения: загрузка через api.upload, скачивание, превью, удаление");
{
  ctl.clearLog();
  const fd = new FormData();
  fd.append("entity_type", "object");
  fd.append("entity_id", "20");
  fd.append("description", "QA-описание");
  fd.append("file", new Blob(["hello fake"], { type: "text/plain" }), "QA-файл.txt");
  const up = await api.upload("/attachments", fd);
  const att = up.attachments[0];
  check(up.attachments.length === 1 && att.filename === "QA-файл.txt" && att.size === 10 && att.content_type === "text/plain" && att.description === "QA-описание", "POST /attachments: {attachments:[…]}");
  check(att.uploaded_by === "QA-Админов Анатолий Сергеевич" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(att.uploaded_at) && !("_bytes" in att) && !("stored_name" in att), "служебные поля наружу не уходят");
  check(ctl.count("POST", "=/attachments") === 1, "count(): загрузка учтена в журнале");
  check(JSON.stringify(ctl.log[0].body) === JSON.stringify({ __form: ["entity_type", "entity_id", "description", "file", "QA-файл.txt"] }), "в логе FormData: имена полей и имена файлов");
  check((await api.get("/attachments?entity_type=object&entity_id=20")).attachments.length === 1, "GET /attachments видит загруженное");
  const res = await fetch(`/attachments/${att.id}/download`, { credentials: "same-origin" });
  const blob = await res.blob();
  check(res.ok && blob.size === 10 && blob.type === "application/octet-stream" && (await blob.text()) === "hello fake", "download: blob совпадает с загруженным");
  check(/filename\*=UTF-8''/.test(res.headers.get("Content-Disposition")), "download: Content-Disposition");

  let e = await rejects(api.put("/objects/20/avatar", { attachment_id: att.id }));
  check(isApiError(e, 400) && /только изображением/.test(e.detail), "превью из не-картинки → 400");
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const fd2 = new FormData();
  fd2.append("entity_type", "object"); fd2.append("entity_id", "20"); fd2.append("description", "");
  fd2.append("file", new Blob([png], { type: "image/png" }), "QA-превью.png");
  const img = (await api.upload("/attachments", fd2)).attachments.find((a) => a.filename === "QA-превью.png");
  check((await api.put("/objects/20/avatar", { attachment_id: img.id })).avatar_attachment_id === img.id, "PUT /objects/{id}/avatar: превью назначено");
  const o20 = (await api.get("/objects")).find((o) => o.id === 20);
  check(o20.has_avatar === true && o20.avatar_attachment_id === img.id && ctl.data.avatars[20] === img.id, "ObjectOut.has_avatar и data.avatars отражают превью");
  const av = await fetch("/objects/20/avatar");
  check(av.ok && (await av.blob()).type === "image/png", "GET /objects/{id}/avatar отдаёт картинку");
  const rest = await api.delete(`/attachments/${img.id}`);
  check(rest.attachments.length === 1 && rest.attachments[0].filename === "QA-файл.txt", "DELETE /attachments: {attachments: остальные}");
  check((await api.get("/objects")).find((o) => o.id === 20).has_avatar === false, "удаление вложения-превью снимает превью (ON DELETE SET NULL)");
  check(isApiError(await rejects(api.delete(`/attachments/${img.id}`)), 404), "повторное удаление → 404");
  const fd3 = new FormData(); fd3.append("entity_type", "object"); fd3.append("entity_id", "20");
  e = await rejects(api.upload("/attachments", fd3));
  check(isApiError(e, 422) && /file: обязательное поле/.test(e.detail), "загрузка без файла → 422");
  const fd4 = new FormData(); fd4.append("entity_type", "object"); fd4.append("entity_id", "20"); fd4.append("file", new Blob([]), "пусто.txt");
  e = await rejects(api.upload("/attachments", fd4));
  check(isApiError(e, 400) && e.detail === "Файл пустой", "пустой файл → 400");
  check((await api.get("/attachments?entity_type=object&entity_id=3")).attachments.length === 3, "у объекта 3 три вложения (включая длинное имя)");
  check((await api.get("/attachments?entity_type=project&entity_id=1")).attachments.length === 1, "у проекта 1 одно вложение");
  e = await rejects(api.get("/attachments?entity_type=object"));
  check(isApiError(e, 422) && /entity_id: обязательное поле/.test(e.detail), "GET /attachments без entity_id → 422");
  check(isApiError(await rejects(api.get("/attachments?entity_type=zzz&entity_id=1")), 400), "неизвестный вид сущности → 400");
}

console.log("delete-plan и удаление: blockers, чистое удаление");
{
  const plan = await api.get("/dictionaries/object/1/delete-plan");
  check(plan.plan.kind_title === "Объект" && plan.plan.label === "QA-Корпус 1.1" && plan.plan.replaceable === false, "план объекта: kind_title, label");
  check(plan.blockers.map((b) => `${b.label}:${b.count}`).join() === "Изделия:1252,Зоны:8,Договоры:2,Версии чертежа:2,Марки:15", "blockers объекта 1");
  check(plan.blockers[0].owner === "Объект «QA-Корпус 1.1»" && plan.plan.cascade.some((c) => c.label === "События, задачи, вопросы" && c.count === 3), "owner у blocker, cascade — «уходит вместе»");
  check(plan.plan.checked.every((c) => "handled" in c) && plan.plan.checked.some((c) => c.label === "elements.object_id"), "plan.checked по образцу dict_delete");
  let e = await rejects(api.post("/dictionaries/object/1/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 409) && /^Удалить нельзя, за записью ещё стоят данные: Объект «QA-Корпус 1.1»: Изделия — 1252/.test(e.rawDetail), "удаление с blockers → 409");
  check((await api.get("/objects")).some((o) => o.id === 1), "объект остался");
  const pplan = await api.get("/dictionaries/project/1/delete-plan");
  check(pplan.blockers.length === 1 && pplan.blockers[0].label === "Объекты" && pplan.blockers[0].count === 4, "проект 1: blocker «Объекты»");
  check(isApiError(await rejects(api.delete("/projects/1")), 409), "DELETE /projects/{id} с объектами → 409");

  const clean = await api.get("/dictionaries/project/9/delete-plan");
  check(clean.blockers.length === 0 && clean.plan.cascade.length === 0, "проект 9: чистое удаление, без blockers");
  const r = await api.post("/dictionaries/project/9/delete", { replacements: {}, mode: "replace" });
  check(r.deleted[0].kind === "project" && Array.isArray(r.moved), "POST delete → {deleted, moved}");
  check(!(await api.get("/projects")).some((p) => p.id === 9), "проект 9 исчез из GET /projects");
  e = await rejects(api.get("/dictionaries/project/9/delete-plan"));
  check(isApiError(e, 404) && e.detail === "Проект: запись не найдена", "план удалённого → 404");
  e = await rejects(api.post("/dictionaries/object/20/delete", { replacements: {}, mode: "merge" }));
  check(isApiError(e, 400) && /нет подчинённых/.test(e.detail), "mode=merge у объекта → 400");
  await api.post("/dictionaries/object/20/delete", { replacements: {}, mode: "replace" });
  check(!(await api.get("/objects")).some((o) => o.id === 20) && ctl.data.attachments.every((a) => !(a.entity_type === "object" && a.entity_id === 20)), "объект 20 удалён вместе с вложениями");
  check((await api.get("/dictionaries/project/14/delete-plan")).blockers.length === 0, "после удаления объекта проект 14 стал чистым");
  e = await rejects(api.get("/dictionaries/xyz/1/delete-plan"));
  check(isApiError(e, 404) && e.detail === "Неизвестный справочник: xyz", "неизвестный справочник → 404");
  e = await rejects(api.get("/dictionaries/object/abc/delete-plan"));
  check(isApiError(e, 422) && e.detail === "Неверный ключ записи", "нечисловой ключ → 422");
}

console.log("Сессия и вход");
{
  ctl.setSession(false);
  let e = await rejects(api.get("/users"));
  check(isApiError(e, 401) && e.detail === "Требуется вход", "setSession(false): 401 «Требуется вход»");
  check(isApiError(await rejects(api.get("/me")), 401) && isApiError(await rejects(api.get("/projects")), 401), "и /me, и остальное — 401");
  check((await api.get("/login-users")).length === 9, "/login-users публичный (без сессии)");
  e = await rejects(api.post("/login", { domain_login: "qa.writer", password: "неверный" }));
  check(isApiError(e, 401) && e.detail === "Неверный логин или пароль", "неверный пароль → 401");
  const u = await api.post("/login", { domain_login: "qa.writer", password: userPassword("qa.writer") });
  check(u.id === 2 && (await api.get("/me")).id === 2, "POST /login возвращает пользователя и открывает сессию");
  ctl.setSession(false);
  ctl.setSession(true);
  check(Array.isArray(await api.get("/users").catch(() => [])), "setSession(true): запросы снова проходят (или 403 у не-админа)");
}

console.log("Права обычного пользователя (loginAs)");
{
  ctl.reset();
  ctl.loginAs(3);
  let e = await rejects(api.get("/users"));
  check(isApiError(e, 403) && /^«Пользователи и выдача доступов»: просмотр требует роли хотя бы на одном объекте/.test(e.detail), "GET /users у наблюдателя → 403 с текстом как у бэкенда");
  const projects = await api.get("/projects");
  const objects = await api.get("/objects");
  check(projects.length === 1 && projects[0].id === 2 && projects[0].objects_count === 3 && objects.map((o) => o.id).join() === "4,5,6", "видны только проект 2 и его объекты");
  check((await api.get("/projects-tree")).projects[0].objects[0].roles.join() === "view", "в projects-tree у объекта роли пользователя");
  const perms = await api.get("/me/permissions?object_id=4");
  check(perms.system_admin === false && perms.object_roles.join() === "QA-Наблюдатель" && perms.features.plan === "read" && perms.features.status === "read" && perms.features.users === "none" && perms.features.attachments === "read", "permissions по ролям на объекте");
  check(isApiError(await rejects(api.put("/objects/4/avatar", { attachment_id: null })), 403), "превью без права на вложения → 403");
  e = await rejects(api.get("/attachments?entity_type=project&entity_id=1"));
  check(isApiError(e, 403) && e.detail === "Вложения проекта правит администратор сервиса", "вложения проекта — только администратору");
  check(isApiError(await rejects(api.get("/attachments?entity_type=object&entity_id=1")), 403), "чужой объект → 403");
  check(isApiError(await rejects(api.post("/projects", { name: "QA-Нельзя" })), 403), "создание проекта без права → 403");

  ctl.loginAs(8);
  e = await rejects(api.get("/projects"));
  check(isApiError(e, 403) && /должен быть заменён/.test(e.detail), "пароль надо сменить: всё, кроме /me и смены пароля, → 403");
  check((await api.get("/me")).must_change_password === true, "…а /me отвечает");
  e = await rejects(api.post("/me/change-password", { current_password: "неверный", new_password: newSecret }));
  check(isApiError(e, 403) && e.detail === "Текущий пароль указан неверно", "смена пароля: неверный текущий → 403");
  e = await rejects(api.post("/me/change-password", { current_password: userPassword("qa.mustchange"), new_password: "слабый" }));
  check(isApiError(e, 422), "смена пароля: слабый новый → 422");
  const ch = await api.post("/me/change-password", { current_password: userPassword("qa.mustchange"), new_password: newSecret });
  check(ch.must_change_password === false && Array.isArray(await api.get("/projects")), "после смены пароля работа возобновляется");
}

console.log("setPermissions / setUser / reset(overrides)");
{
  ctl.reset();
  ctl.setPermissions({ features: { users: "read" } });
  const pm = await api.get("/me/permissions");
  check(pm.features.users === "read" && pm.features.roles === "write" && pm.system_admin === true, "setPermissions сливается с рассчитанными правами");
  check(Array.isArray(await api.get("/users")), "чтение при users=read работает");
  const e = await rejects(api.put("/users/4/access", { grants: [] }));
  check(isApiError(e, 403), "запись при users=read → 403 (права применяются и в «сервере»)");
  ctl.setPermissions(null);
  check((await api.put("/users/4/access", { grants: [] })).system_admin === false, "setPermissions(null) возвращает расчётные права");
  ctl.setUser({ display_name: "QA-Подмена" });
  check((await api.get("/me")).display_name === "QA-Подмена", "setUser переопределяет /me");
  ctl.setUser(null);
  ctl.reset({ users: (rows) => rows.slice(0, 2), me: { ui_theme: "graphite" }, permissions: { features: { projects: "none" } } });
  check((await api.get("/users")).length === 2 && (await api.get("/me")).ui_theme === "graphite", "reset(overrides): таблицы (функцией) и me");
  check((await api.get("/me/permissions")).features.projects === "none", "reset(overrides): permissions");
  check(ctl.log.length === 3 || ctl.log.length === 4, "reset очистил журнал");
  ctl.reset();
  check(ctl.log.length === 0 && (await api.get("/users")).length === 8, "reset() без аргументов возвращает фикстуры");
}

console.log("Профили прав стенда (как в boot.js): данные видны, разделы сужены");
{
  ctl.reset();
  ctl.setPermissions({ system_admin: false, features: { users: "read", roles: "read", projects: "read", counterparties: "read", dict_delete: "none" } });
  const pm = await api.get("/me/permissions");
  check(pm.system_admin === false && pm.features.users === "read" && pm.features.attachments === "none" && pm.features.dict_delete === "none", "профиль readonly: features сужены, остальное по грантам (у админа их нет)");
  check((await api.get("/projects")).length === 14 && (await api.get("/objects")).length === 20, "профиль не прячет данные у записи с ролью admin");
  check(Array.isArray(await api.get("/users")) && isApiError(await rejects(api.post("/users", { last_name: "QA-Х", domain_login: "qa.q", role: "user" })), 403), "read: GET /users можно, POST → 403");
  check(isApiError(await rejects(api.get("/dictionaries/object/20/delete-plan")), 403), "dict_delete=none: delete-plan → 403");
  ctl.setPermissions({ system_admin: false, features: {} }, { replace: true });
  const none = await api.get("/me/permissions");
  check(none.features.users === "none" && none.features.projects === "none" && none.features.counterparties === "none", "профиль none: доступных разделов нет");
  ctl.setPermissions(null);
  check((await api.get("/me/permissions")).features.users === "write", "сброс профиля — снова администратор");
}

console.log("Адрес, карта, заглушки, маршрутизация");
{
  const st = await api.get("/address/status");
  check(Array.isArray(st.loaded) && st.loaded.length === 0 && st.objects_total === 0 && st.job === null, "КЛАДР «не загружен» (loaded пуст → ручной ввод)");
  check((await api.get("/address/settlements?q=мос")).items.length === 0, "подсказки классификатора пусты");
  const e = await rejects(api.get("/address/resolve?code=77000000000"));
  check(isApiError(e, 404) && e.detail === "Адрес по этому коду не найден", "resolve → 404");
  const cfg = await api.get("/map/config");
  check(cfg.online === false && cfg.geocode_url === null && cfg.basemaps.length === 0, "карта: онлайн-сервисы выключены (геокодер не вызывается)");
  const mo = await api.get("/map/objects");
  check(mo.objects.length > 0 && mo.without_coords > 0, "map/objects: точки и «без координат»");
  check((await api.get("/counterparties")).length === 0, "GET /counterparties — заглушка");
  const nf = await fetch("/nope");
  check(nf.status === 404 && (await nf.json()).detail === "Not Found", "неизвестный маршрут → 404");
  const mm = await fetch("/objects/1/avatar", { method: "POST" });
  check(mm.status === 405, "неверный метод → 405");
}

console.log("Задержка, whenIdle, waitFor, регистрация запросов");
{
  ctl.reset();
  ctl.setLatency("=/smu", 80, "GET");
  const t0 = Date.now();
  await api.get("/smu");
  check(Date.now() - t0 >= 70, "setLatency: ответ задержан");
  ctl.setLatency("=/smu", 0, "GET");
  const t1 = Date.now();
  await api.get("/smu");
  check(Date.now() - t1 < 60, "setLatency(…, 0) снимает задержку");
  const w = ctl.waitFor("GET", "=/individuals");
  const p = api.get("/individuals");
  check((await w).path === "/individuals", "waitFor: дождались запроса в журнале");
  await p;
  await ctl.whenIdle();
  check(ctl.count("GET", "=/individuals") === 1 && ctl.count("=/individuals") === 1 && ctl.count("/individuals") === 1, "count(): разные формы паттерна");
  check(ctl.count("GET", /\/smu$/) === 2 && ctl.log.every((x) => typeof x.seq === "number" && typeof x.t === "number" && x.done === true), "count(RegExp), поля seq/t/done");
  ctl.clearLog();
  check(ctl.log.length === 0, "clearLog()");
}

console.log("Итоги");
{
  check(ctl.internalErrors.length === 0, "внутренних ошибок стенда нет");
  check(api.hasPendingWrites() === false, "незавершённых записей нет");
  ctl.uninstall();
  check(globalThis.fetch === originalFetch, "uninstall() вернул оригинальный fetch");
}

console.log(failures ? `\nПровалено проверок: ${failures}` : "\nВсе проверки пройдены");
process.exitCode = failures ? 1 : 0;

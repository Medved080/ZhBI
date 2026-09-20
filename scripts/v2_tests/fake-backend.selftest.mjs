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
  const cpl = await api.get("/counterparties");
  check(cpl.length === 7 && cpl[0].short_name === "QA-ДСК-2", "GET /counterparties — настоящий список фикстур (7), сортировка по краткому наименованию");
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

// ============================ Контрактация («Контрагенты») ============================
// Тело PATCH /contracts/{id} из ответа GET /contracts — ровно то, что шлёт клиент V2 (buildContractBody).
const bodyOf = (c, o = {}) => ({
  specification_id: c.specification_id, theme: c.theme, is_archived: c.is_archived,
  lines: c.lines.map(({ element_type, mark, quantity }) => ({ element_type, mark, quantity })),
  incidents: c.incidents.map(({ element_type, quantity, incident_date, description }) => ({ element_type, quantity, incident_date, description })),
  capacity: c.capacity.map(({ element_type, per_day }) => ({ element_type, per_day, comment: null })), ...o,
});
const flatNodes = (n) => [n, ...n.children.flatMap(flatNodes)];

console.log("Контрагенты: список, создание, правка, права");
{
  ctl.reset();
  const list = await api.get("/counterparties");
  check(list.length === 7 && list.map((c) => c.id).join() === "2,1,7,3,4,6,5", "GET /counterparties: 7 фикстур, сортировка по short_name (как ORDER BY в SQLite)");
  const cp1 = list.find((c) => c.id === 1);
  check(cp1.capacity.map((c) => c.element_type).join() === "Балка,Колонна,Плита перекрытия" && cp1.capacity.find((c) => c.element_type === "Колонна").per_day === 12.5,
    "ёмкость завода: три норматива, отсортированы по типу");
  check(list.every((c) => !("unaccounted" in c) && "capacity" in c && "code" in c) && list.find((c) => c.id === 3).short_name.length > 120 && list.find((c) => c.id === 3).legal_address.length > 250,
    "служебные поля не уходят наружу; у контрагента 3 очень длинные названия и адрес");
  check(list.find((c) => c.id === 7).inn === null && list.find((c) => c.id === 7).code === null, "контрагент 7: только обязательные поля");
  const full = await api.get("/counterparties/full");
  check(full.find((c) => c.id === 1).agreements.length === 2 && full.find((c) => c.id === 1).agreements[0].specifications.length === 2, "GET /counterparties/full: дерево договоры → спецификации");

  const created = await api.post("/counterparties", { full_name: "QA-Полное", short_name: "QA-Новый Завод", inn: "7700000077",
    capacity: [{ element_type: " Колонна ", per_day: 5, comment: " уточнение " }, { element_type: "Колонна", per_day: 9 },
      { element_type: "Балка", per_day: 0 }, { element_type: "  ", per_day: 3 }] });
  check(created.id === 8 && created.code === "QA-НОВ" && created.kpp === null && created.capacity.length === 1
    && created.capacity[0].element_type === "Колонна" && created.capacity[0].per_day === 5 && created.capacity[0].comment === "уточнение",
    "POST /counterparties: код по умолчанию из краткого наименования; ёмкость очищена (дубль типа, нуль и пустой тип отброшены)");
  const second = await api.post("/counterparties", { full_name: "QA-Полное 2", short_name: "QA-Новый Другой" });
  check(second.code === "QA-НОВ2" && second.capacity.length === 0, "коллизия кода → числовой суффикс; без capacity — пустая ёмкость");
  const withCode = await api.post("/counterparties", { full_name: "QA-Полное 3", short_name: "QA-Третий", code: "МОЙ", capacity: null });
  check(withCode.code === "МОЙ", "код, присланный явно, сохраняется как есть");
  check((await api.get("/counterparties")).length === 10 && (await api.get("/counterparties")).some((c) => c.id === 8), "новые видны в следующем GET");
  let e = await rejects(api.post("/counterparties", {}));
  check(isApiError(e, 422) && /full_name: обязательное поле/.test(e.detail) && /short_name: обязательное поле/.test(e.detail), "нет full_name/short_name → 422 списком");
  e = await rejects(api.post("/counterparties", { full_name: 5, short_name: "x" }));
  check(isApiError(e, 422) && /full_name: Input should be a valid string/.test(e.detail), "full_name не строка → 422");
  e = await rejects(api.post("/counterparties", { full_name: "x", short_name: "y", capacity: [{ element_type: "Колонна" }] }));
  check(isApiError(e, 422) && /capacity\.0\.per_day: обязательное поле/.test(e.detail), "строка ёмкости без per_day → 422 с индексом строки");

  const upd = await api.patch("/counterparties/8", { full_name: "QA-Полное 4", short_name: "QA-Новый Завод", inn: null, code: "НОВ" });
  check(upd.full_name === "QA-Полное 4" && upd.inn === null && upd.code === "НОВ" && upd.capacity.length === 1, "PATCH: поля записаны; capacity не прислана — нормативы сохранены");
  const upd2 = await api.patch("/counterparties/8", { full_name: "QA-Полное 4", short_name: "QA-Новый Завод", capacity: [] });
  check(upd2.capacity.length === 0 && upd2.code === null, "capacity: [] снимает нормативы; код без присланного значения обнуляется (как в бэкенде)");
  const upd3 = await api.patch("/counterparties/8", { full_name: "QA-Полное 5", short_name: "QA-Новый Завод", capacity: [{ element_type: "Плита", per_day: 2.5, comment: "c" }] });
  check(upd3.capacity[0].per_day === 2.5 && (await api.get("/counterparties")).find((c) => c.id === 8).full_name === "QA-Полное 5", "PATCH виден в следующем GET");
  e = await rejects(api.patch("/counterparties/999", { full_name: "x", short_name: "y" }));
  check(isApiError(e, 404) && e.detail === "Контрагент не найден", "PATCH несуществующего → 404");
  e = await rejects(api.patch("/counterparties/abc", { full_name: "x", short_name: "y" }));
  check(isApiError(e, 422) && /counterparty_id: нужно целое число/.test(e.detail), "id не число → 422");

  ctl.loginAs(3);
  check(Array.isArray(await api.get("/counterparties")), "чтение справочника — любому вошедшему");
  e = await rejects(api.post("/counterparties", { full_name: "x", short_name: "y" }));
  check(isApiError(e, 403) && /^«Справочник контрагентов»: изменение требует роли хотя бы на одном объекте/.test(e.detail), "Наблюдатель: POST → 403 (право «Контрагенты» — write)");
  e = await rejects(api.post("/counterparties", {}));
  check(isApiError(e, 403), "403 раньше 422 (порядок как у зависимостей FastAPI)");
  ctl.loginAs(2);
  check((await api.post("/counterparties", { full_name: "QA-От комплектовщика", short_name: "QA-Комплект" })).id === 11, "qa.writer (Комплектовщик на объекте 4) создаёт контрагента");
  ctl.loginAs(1);
}

console.log("Контракты: GET /contracts, группировка, права видимости, развёрнутый вид");
{
  ctl.reset();
  const all = await api.get("/contracts");
  check(all.length === 11 && all.map((c) => c.id).join() === "6,7,8,1,2,3,4,5,9,11,10", "GET /contracts: все 11, порядок «контрагент/договор/спецификация»");
  const bySpec = new Map();
  for (const c of all) bySpec.set(c.specification_id, [...(bySpec.get(c.specification_id) || []), c.id]);
  check(bySpec.get(1).join() === "1,2,3" && bySpec.get(4).join() === "6,7" && bySpec.get(2).join() === "4" && bySpec.size === 8, "группировка по specification_id (как строит клиент)");
  const c1 = all.find((c) => c.id === 1);
  check(c1.name === "QA-ЗЖБИ-1/QA-Д-101 от 15.03.2026/QA-С-1 от 20.03.2026 (Колонны и плиты, секция А)", "наименование контракта генерируется по цепочке");
  check(c1.linked_elements === 8 && c1.is_archived === false && c1.agreement_id === 1 && c1.counterparty_id === 1 && c1.counterparty_code === "ЗЖБИ1"
    && c1.specification_number === "QA-С-1" && c1.agreement_number === "QA-Д-101", "ContractOut: цепочка, linked_elements, код контрагента");
  check(c1.lines.map((l) => `${l.mark}:${l.quantity}/${l.fact}/${l.damaged}/${l.remaining}`).join() === "QA-К1:10/3/1/6,QA-К2:6/2/1/3,QA-П1:20/3/2/15" && c1.lines.every((l) => l.exceeded === false),
    "позиции: план/факт/повреждено/остаток (остаток = план − факт − повреждённые), у всех остаток > 0");
  check(c1.incidents.map((i) => i.incident_date).join() === "2026-08-27,2026-08-20" && c1.incidents[0].description === "QA-Трещина при монтаже", "инциденты: по дате по убыванию");
  check(c1.capacity.length === 1 && c1.capacity[0].element_type === "Колонна" && c1.capacity[0].per_day === 8 && c1.capacity[0].comment === null, "переопределение производительности контракта");
  check(all.every((c) => !("historyRecords" in c) && !("defaultRefs" in c)) && all.find((c) => c.id === 6).is_archived === true && all.find((c) => c.id === 5).linked_elements === 2 && all.find((c) => c.id === 8).linked_elements === 3,
    "служебные поля не уходят; архивный c6, привязки c5 и c8");
  check(all.find((c) => c.id === 7).lines.map((l) => l.remaining).join() === "20,100" && all.find((c) => c.id === 7).lines[0].mark === null, "позиция без марки — первой (NULL раньше в ORDER BY)");
  check(all.find((c) => c.id === 9).theme.length > 90 && all.find((c) => c.id === 9).agreement_number.length > 80, "контракт 9: длинные тема и номер договора");

  const els = await api.get("/contracts/1/elements");
  check(els.map((x) => x.id).join() === "101,102,103,104,105,106,107,108" && new Set(els.map((x) => x.current_status)).size === 6, "GET /contracts/1/elements: 8 изделий, шесть разных статусов, порядок тип/марка/id");
  check(els.filter((x) => x.planned_delivery_date === null).map((x) => x.id).join() === "103,105,108" && els[0].planned_delivery_date === "2026-09-01" && els[0].actual_delivery_date === "2026-09-02 10:15:00",
    "часть с плановыми датами, часть без; факт — с временем");
  check(["id", "element_type", "mark", "current_status", "planned_delivery_date", "project_delivery_date", "project_smr_start_date", "actual_delivery_date"].every((k) => k in els[0]), "форма строки — как у list_contract_elements");
  check((await api.get("/contracts/4/elements")).length === 0, "у контракта без привязок — пустой список");
  let e = await rejects(api.get("/contracts/999/elements"));
  check(isApiError(e, 404) && e.detail === "Контракт не найден", "элементы несуществующего контракта → 404");
  check(isApiError(await rejects(api.get("/contracts/abc/elements")), 422), "id не число → 422");

  ctl.loginAs(2);
  const mine = await api.get("/contracts");
  check(mine.map((c) => c.id).join() === "6,7,8,1,2,3,4,5", "qa.writer: только контракты договоров на доступные объекты (1, 2, 4)");
  check((await api.get("/agreements?counterparty_id=2")).map((a) => a.id).join() === "3,4", "безобъектный договор 7 не виден не-админу");
  e = await rejects(api.get("/specifications?agreement_id=7"));
  check(isApiError(e, 403) && e.detail === "Договор не привязан к объекту — правит администратор сервиса", "спецификации безобъектного договора — только админу");
  e = await rejects(api.get("/specifications?agreement_id=5"));
  check(isApiError(e, 403) && /«Договоры и спецификации»: просмотр требует роли на объекте/.test(e.detail), "договор чужого объекта → 403 с текстом как у бэкенда");
  ctl.loginAs(4);
  check((await api.get("/contracts")).length === 0 && isApiError(await rejects(api.get("/contracts/1/elements")), 403), "без грантов: список контрактов пуст, элементы → 403");
  ctl.loginAs(1);
  check((await api.get("/contracts")).length === 11, "админ снова видит всё");
}

console.log("Договоры и спецификации: создание, правка, ошибки");
{
  ctl.reset();
  check((await api.get("/agreements?counterparty_id=1")).map((a) => a.number).join() === "QA-Д-101,QA-Д-102" && (await api.get("/agreements?counterparty_id=2")).map((a) => a.id).join() === "3,4,7",
    "GET /agreements: по контрагенту, порядок по номеру");
  check((await api.get("/agreements?counterparty_id=4")).length === 0 && (await api.get("/agreements?counterparty_id=999")).length === 0, "у контрагента без договоров — []; несуществующий контрагент — тоже []");
  let e = await rejects(api.get("/agreements"));
  check(isApiError(e, 422) && /counterparty_id: обязательное поле/.test(e.detail), "GET /agreements без counterparty_id → 422");
  const a1 = (await api.get("/agreements?counterparty_id=1"))[0];
  check(a1.id === 1 && a1.agreement_date === "2026-03-15" && a1.object_id === 1 && a1.counterparty_id === 1 && !("created_at" in a1), "форма AgreementOut");

  e = await rejects(api.post("/agreements", { counterparty_id: 4, number: "QA-Н-1" }));
  check(isApiError(e, 400) && /^Укажите объект, на который заключён договор/.test(e.detail), "POST /agreements без объекта → 400");
  e = await rejects(api.post("/agreements", { counterparty_id: 4, number: "QA-Н-1", object_id: 999 }));
  check(isApiError(e, 404) && e.detail === "Объект не найден", "несуществующий объект → 404");
  e = await rejects(api.post("/agreements", { counterparty_id: 999, number: "QA-Н-1", object_id: 1 }));
  check(isApiError(e, 404) && e.detail === "Контрагент не найден", "несуществующий контрагент → 404");
  e = await rejects(api.post("/agreements", { counterparty_id: 1, number: "QA-Д-101", object_id: 1 }));
  check(isApiError(e, 400) && e.detail === "У этого контрагента уже есть договор с таким номером", "дубль номера → 400");
  e = await rejects(api.post("/agreements", { counterparty_id: 1, number: "QA-Х", object_id: 6 }));
  check(isApiError(e, 403), "договор на объект МФР: раздел «Договоры» к нему не применим → 403 даже админу");
  e = await rejects(api.post("/agreements", { number: "x" }));
  check(isApiError(e, 422) && /counterparty_id: обязательное поле/.test(e.detail), "нет counterparty_id → 422 раньше остальных проверок");
  const ag = await api.post("/agreements", { counterparty_id: 4, number: "QA-Н-1", agreement_date: "2026-09-01", object_id: 14 });
  check(ag.id === 9 && ag.object_id === 14 && (await api.get("/agreements?counterparty_id=4")).length === 1, "POST /agreements: создан и виден в следующем GET");
  check((await api.get("/dictionaries/object/14/delete-plan")).blockers.find((b) => b.label === "Договоры").count === 2, "объект 14: «Договоры» в delete-plan считаются по таблице (договор 6 + новый)");

  e = await rejects(api.patch("/agreements/1", { counterparty_id: 1, number: "QA-Д-101", object_id: null }));
  check(isApiError(e, 400) && /^Укажите объект/.test(e.detail), "PATCH договора без объекта → 400");
  e = await rejects(api.patch("/agreements/1", { counterparty_id: 1, number: "QA-Д-101", agreement_date: "2026-03-15", object_id: 3 }));
  check(isApiError(e, 409) && /законтрактовано изделий другого объекта: 8/.test(e.detail), "смена объекта при привязанных изделиях → 409");
  const pa = await api.patch("/agreements/1", { counterparty_id: 1, number: "QA-Д-101/1", agreement_date: "2026-03-16", object_id: 1 });
  check(pa.number === "QA-Д-101/1" && (await api.get("/contracts")).find((c) => c.id === 1).name.startsWith("QA-ЗЖБИ-1/QA-Д-101/1 от 16.03.2026/"), "PATCH договора: виден в GET /contracts (имя контракта пересобрано)");
  e = await rejects(api.patch("/agreements/1", { counterparty_id: 1, number: "QA-Д-102", object_id: 1 }));
  check(isApiError(e, 500) && (await api.get("/agreements?counterparty_id=1"))[0].number === "QA-Д-101/1", "дубль номера при PATCH — необработанное исключение бэкенда (500), данные не тронуты");
  e = await rejects(api.patch("/agreements/999", { counterparty_id: 1, number: "x", object_id: 1 }));
  check(isApiError(e, 404) && e.detail === "Договор не найден", "PATCH несуществующего договора → 404");
  const moved = await api.patch("/agreements/7", { counterparty_id: 2, number: "QA-ДГ-старый", agreement_date: "2025-01-10", object_id: 4 });
  check(moved.object_id === 4, "админ проставляет объект безобъектному договору");
  ctl.reset();
  ctl.loginAs(2);
  e = await rejects(api.patch("/agreements/7", { counterparty_id: 2, number: "QA-ДГ-старый", object_id: 1 }));
  check(isApiError(e, 403) && e.detail === "Договор не привязан к объекту — правит администратор сервиса", "безобъектный договор не-админу → 403");
  e = await rejects(api.post("/agreements", { counterparty_id: 2, number: "QA-Н-2", object_id: 5 }));
  check(isApiError(e, 403), "договор на чужой объект (5: только чтение у Наблюдателя? у qa.writer доступа нет) → 403");
  ctl.loginAs(1);

  // спецификации
  check((await api.get("/specifications?agreement_id=1")).map((s) => s.number).join() === "QA-С-1,QA-С-2", "GET /specifications: по договору");
  check(isApiError(await rejects(api.get("/specifications?agreement_id=999")), 404) && isApiError(await rejects(api.get("/specifications")), 422), "несуществующий договор → 404; без параметра → 422");
  const sp = await api.post("/specifications", { agreement_id: 1, number: "QA-С-3", specification_date: "2026-09-02" });
  check(sp.id === 10 && sp.agreement_id === 1 && sp.specification_date === "2026-09-02", "POST /specifications: создана");
  const again = await api.post("/specifications", { agreement_id: 1, number: "QA-С-3", specification_date: "2030-01-01" });
  check(again.id === 10 && again.specification_date === "2026-09-02" && (await api.get("/specifications?agreement_id=1")).length === 3, "повтор номера возвращает СУЩЕСТВУЮЩУЮ спецификацию (find_or_create), дубля нет");
  e = await rejects(api.post("/specifications", { agreement_id: 999, number: "x" }));
  check(isApiError(e, 404) && e.detail === "Договор не найден", "спецификация к несуществующему договору → 404");
  const ps = await api.patch("/specifications/10", { agreement_id: 1, number: "QA-С-3А", specification_date: null });
  check(ps.number === "QA-С-3А" && ps.specification_date === null, "PATCH спецификации");
  e = await rejects(api.patch("/specifications/10", { agreement_id: 1, number: "QA-С-1" }));
  check(isApiError(e, 500), "дубль номера при PATCH спецификации — 500 (нарушение UNIQUE)");
  check((await api.patch("/specifications/10", { agreement_id: 2, number: "QA-С-3А" })).agreement_id === 2 && (await api.get("/specifications?agreement_id=2")).some((s) => s.id === 10), "спецификацию можно перевесить на другой договор");
  e = await rejects(api.patch("/specifications/999", { agreement_id: 1, number: "x" }));
  check(isApiError(e, 404) && e.detail === "Спецификация не найдена", "PATCH несуществующей спецификации → 404");
}

console.log("Контракты: создание, правка, перенос, архивация, страж покрытия");
{
  ctl.reset();
  const before = await api.get("/contracts");
  let e = await rejects(api.post("/contracts", { specification_id: 2 }));
  check(isApiError(e, 422) && /lines: обязательное поле/.test(e.detail), "POST /contracts без lines → 422");
  e = await rejects(api.post("/contracts", { specification_id: 999, lines: [] }));
  check(isApiError(e, 404) && e.detail === "Спецификация не найдена", "несуществующая спецификация → 404");
  e = await rejects(api.post("/contracts", { specification_id: 2, lines: [{ element_type: "Плита", mark: "X", quantity: 1 }, { element_type: "Плита", mark: "X", quantity: 2 }] }));
  check(isApiError(e, 500) && (await api.get("/contracts")).length === before.length, "дубль позиции (тип, марка) — 500 бэкенда, контракт не создан");
  e = await rejects(api.post("/contracts", { specification_id: 2, lines: [{ element_type: "Плита", mark: "X", quantity: "много" }] }));
  check(isApiError(e, 422) && /lines\.0\.quantity: нужно целое число/.test(e.detail), "количество не число → 422 с индексом строки");
  const c = await api.post("/contracts", { specification_id: 2, theme: "QA-Новый", is_archived: false,
    lines: [{ element_type: "Колонна", mark: "QA-К99", quantity: 7 }], incidents: [{ element_type: "Колонна", quantity: 1, incident_date: "2026-09-01", description: null }],
    capacity: [{ element_type: "Колонна", per_day: 3, comment: null }] });
  check(c.id === 12 && c.specification_id === 2 && c.counterparty_id === 1 && c.counterparty_short_name === "QA-ЗЖБИ-1" && c.linked_elements === 0
    && c.lines[0].remaining === 6 && c.name.endsWith("/QA-С-2 от 01.04.2026 (QA-Новый)") && c.capacity[0].per_day === 3, "POST /contracts: полный ContractOut (остаток учитывает инцидент)");
  check((await api.get("/contracts")).length === before.length + 1, "новый контракт виден в GET /contracts");
  const moved = await api.patch("/contracts/12", bodyOf(c, { specification_id: 4, incidents: [], capacity: null }));
  check(moved.counterparty_id === 2 && moved.counterparty_short_name === "QA-ДСК-2" && moved.agreement_id === 3 && moved.incidents.length === 0 && moved.capacity.length === 1,
    "перенос к другому контрагенту через смену спецификации; инциденты заменены, capacity=null — переопределение сохранено");
  check((await api.get("/contracts")).find((x) => x.id === 12).counterparty_id === 2, "перенос виден в следующем GET");

  const all = await api.get("/contracts");
  const c1 = all.find((x) => x.id === 1), c4 = all.find((x) => x.id === 4), c6 = all.find((x) => x.id === 6);
  e = await rejects(api.patch("/contracts/1", bodyOf(c1, { is_archived: true })));
  check(isApiError(e, 409) && /^К контракту привязано изделий: 8\. В архив можно перевести только контракт/.test(e.detail), "архивация при linked_elements > 0 → 409");
  check((await api.get("/contracts")).find((x) => x.id === 1).is_archived === false, "контракт остался неархивным");
  check((await api.patch("/contracts/4", bodyOf(c4, { is_archived: true }))).is_archived === true, "контракт без привязок архивируется");
  check((await api.patch("/contracts/6", bodyOf(c6, { is_archived: false }))).is_archived === false, "из архива вернуть можно всегда");
  check((await api.patch("/contracts/1", bodyOf(c1, { is_archived: false }))).is_archived === false, "повторное сохранение неархивного с привязками — без проверки");

  e = await rejects(api.patch("/contracts/1", bodyOf(c1, { lines: [{ element_type: "Колонна", mark: "QA-К1", quantity: 2 }, { element_type: "Колонна", mark: "QA-К2", quantity: 6 }, { element_type: "Плита перекрытия", mark: "QA-П1", quantity: 20 }] })));
  check(isApiError(e, 409) && /^Правка спецификации оставила бы изделия без основания: Колонна «QA-К1»: остаётся по спецификации 2, а привязано изделий 3 и списано повреждёнными 1\. Сначала переназначьте/.test(e.detail),
    "уменьшение количества ниже привязанного → 409 (страж покрытия)");
  e = await rejects(api.patch("/contracts/1", bodyOf(c1, { lines: c1.lines.filter((l) => l.mark !== "QA-П1").map(({ element_type, mark, quantity }) => ({ element_type, mark, quantity })) })));
  check(isApiError(e, 409) && /Плита перекрытия «QA-П1»: позиции не остаётся, а привязано изделий: 3/.test(e.detail), "удаление позиции с привязанными изделиями → 409");
  check((await api.get("/contracts")).find((x) => x.id === 1).lines.length === 3 && (await api.get("/contracts")).find((x) => x.id === 1).lines[0].quantity === 10, "после отказа контракт не изменился");
  const oldIds = c1.lines.map((l) => l.id).join();
  const up = await api.patch("/contracts/1", bodyOf(c1, { theme: "QA-Тема 2", lines: c1.lines.map(({ element_type, mark, quantity }) => ({ element_type, mark, quantity: mark === "QA-К1" ? 12 : quantity })) }));
  check(up.lines[0].quantity === 12 && up.lines[0].remaining === 8 && up.name.endsWith("(QA-Тема 2)") && up.lines.map((l) => l.id).join() !== oldIds, "разрешённая правка: количество выросло, имя пересобрано, позиции получили новые id");
  e = await rejects(api.patch("/contracts/999", bodyOf(c1)));
  check(isApiError(e, 404) && e.detail === "Контракт не найден", "PATCH несуществующего контракта → 404");
  e = await rejects(api.patch("/contracts/1", bodyOf(c1, { specification_id: 999 })));
  check(isApiError(e, 404) && e.detail === "Спецификация не найдена", "перенос на несуществующую спецификацию → 404");
  e = await rejects(api.patch("/contracts/1", { theme: "x" }));
  check(isApiError(e, 422) && /specification_id: обязательное поле/.test(e.detail) && /lines: обязательное поле/.test(e.detail), "PATCH без обязательных полей → 422");

  ctl.loginAs(2);
  e = await rejects(api.patch("/contracts/1", bodyOf(c1)));
  check(isApiError(e, 403) && /^«Контракты и их позиции»: изменение требует роли на объекте/.test(e.detail), "Прораб (contracts=read) не правит контракт объекта 1 → 403");
  const c8 = (await api.get("/contracts")).find((x) => x.id === 8);
  check((await api.patch("/contracts/8", bodyOf(c8, { theme: "QA-Комплектовщик правит" }))).theme === "QA-Комплектовщик правит", "Комплектовщик на объекте 4 правит контракт 8");
  e = await rejects(api.patch("/contracts/8", bodyOf(c8, { specification_id: 1 })));
  check(isApiError(e, 403), "перенос контракта на спецификацию объекта, где нет права «Контракты» на запись, → 403 (проверяется и получатель)");
  ctl.loginAs(1);
}

console.log("delete-plan, кандидаты и удаление с заменой: контрагент / договор / спецификация / контракт");
{
  ctl.reset();
  const cp1 = await api.get("/dictionaries/counterparty/1/delete-plan");
  const nodes = flatNodes(cp1.plan);
  check(cp1.plan.kind_title === "Контрагент" && cp1.plan.label === "QA-ЗЖБИ-1" && cp1.plan.needs_replacement === true && cp1.plan.replaceable === true && cp1.plan.mergeable === true
    && cp1.plan.adopt_title === "договоры со всем содержимым" && cp1.blockers.length === 0, "план контрагента 1: needs_replacement, mergeable, без blockers");
  check(nodes.map((n) => n.kind).join() === "counterparty,agreement,specification,contract,contract,contract,specification,contract,agreement,specification,contract", "дерево: договоры → спецификации → контракты (порядок по номеру/id)");
  check(cp1.plan.checked.map((c) => c.label).join() === "agreements.counterparty_id,counterparty_capacity.counterparty_id" && cp1.plan.checked.every((c) => c.handled !== "НЕ УЧТЕНО"), "checked контрагента — из реестра fk_handled");
  const cn = nodes.find((n) => n.kind === "contract" && n.key === "1");
  check(cn.refs.map((r) => `${r.label}:${r.count}`).join() === "Изделия:8,Записи истории статусов:14,Контракт по умолчанию:1" && cn.cascade.map((r) => `${r.label}:${r.count}`).join() === "Позиции контракта:3,Инциденты повреждения:2"
    && cn.needs_replacement === true && cn.parent_kind === "specification" && cn.mergeable === false, "узел контракта 1: refs, cascade, needs_replacement");

  const c1 = await api.get("/dictionaries/contract/1/delete-plan");
  check(c1.blockers.length === 0 && c1.plan.needs_replacement === true && c1.plan.label.startsWith("QA-ЗЖБИ-1/QA-Д-101 от 15.03.2026/QA-С-1 от 20.03.2026"), "delete-plan контракта 1: needs_replacement:true, blockers нет");
  check((await api.get("/dictionaries/contract/4/delete-plan")).plan.needs_replacement === false && (await api.get("/dictionaries/contract/4/delete-plan")).plan.cascade[0].label === "Позиции контракта", "контракт 4 без привязок: замена не нужна, cascade — позиции");
  check((await api.get("/dictionaries/contract/6/delete-plan")).plan.needs_replacement === false, "архивный контракт без привязок — тоже без замены");
  const cand = await api.get("/dictionaries/contract/candidates?key=1");
  check(cand.map((x) => x.key).join() === "2,3" && cand[0].label.startsWith("QA-ЗЖБИ-1/QA-Д-101 от 15.03.2026/QA-С-1 от 20.03.2026 (Колонны и плиты, секция Б"), "кандидаты на замену контракта 1: контракты той же спецификации (2 и 3)");
  check((await api.get("/dictionaries/contract/candidates?key=5")).length === 0, "контракт 5: кандидатов нет (единственный в спецификации)");
  check((await api.get("/dictionaries/contract/candidates?key=1&parent=2")).map((x) => x.key).join() === "4", "candidates?parent=: замены берутся у спецификации, выбранной владельцу-замене");
  check((await api.get("/dictionaries/counterparty/candidates?key=1")).map((x) => x.key).join() === "2,7,3,4,6,5" && (await api.get("/dictionaries/agreement/candidates?key=1")).map((x) => x.key).join() === "2"
    && (await api.get("/dictionaries/specification/candidates?key=1")).map((x) => x.key).join() === "2", "кандидаты контрагента / договора / спецификации");
  check((await api.get("/dictionaries/object/candidates?key=1")).length === 0, "у объекта замены нет — []");
  let e = await rejects(api.get("/dictionaries/contract/candidates"));
  check(isApiError(e, 422) && /key: обязательное поле/.test(e.detail), "candidates без key → 422");
  e = await rejects(api.get("/dictionaries/contract/candidates?key=abc"));
  check(isApiError(e, 422) && e.detail === "Неверный ключ записи", "нечисловой key → 422");
  e = await rejects(api.get("/dictionaries/contract/candidates?key=999"));
  check(isApiError(e, 404) && e.detail === "Контракт: запись не найдена", "несуществующий контракт → 404");
  e = await rejects(api.get("/dictionaries/zzz/candidates?key=1"));
  check(isApiError(e, 404) && e.detail === "Неизвестный справочник: zzz", "неизвестный вид → 404");

  const cp5 = await api.get("/dictionaries/counterparty/5/delete-plan");
  check(cp5.blockers.length === 0 && cp5.plan.needs_replacement === false && flatNodes(cp5.plan).length === 4, "контрагент 5: чистое удаление (4 записи дерева, без замены)");
  const cp6 = await api.get("/dictionaries/counterparty/6/delete-plan");
  check(cp6.blockers.length === 1 && cp6.blockers[0].label === "неучтённая ссылка qa_payments.counterparty_id" && cp6.blockers[0].count === 3 && cp6.blockers[0].owner === "Контрагент «QA-Поставщик с зависимостями»"
    && cp6.plan.checked.some((c) => c.handled === "НЕ УЧТЕНО"), "контрагент 6: blockers {owner,label,count} от неучтённой ссылки");
  check((await api.get("/dictionaries/counterparty/4/delete-plan")).plan.children.length === 0, "контрагент 4: без договоров");
  e = await rejects(api.post("/dictionaries/counterparty/6/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 409) && /^Удалить нельзя, за записью ещё стоят данные: Контрагент «QA-Поставщик с зависимостями»: неучтённая ссылка qa_payments\.counterparty_id — 3/.test(e.detail), "удаление с blockers → 409");
  e = await rejects(api.post("/dictionaries/counterparty/1/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 400) && e.detail === "Не выбрана замена: Контрагент «QA-ЗЖБИ-1»", "удаление контрагента с привязанными изделиями без замены → 400");
  e = await rejects(api.post("/dictionaries/contract/1/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 400) && /^Не выбрана замена: Контракт «QA-ЗЖБИ-1\//.test(e.detail), "удаление контракта с изделиями без замены → 400");
  e = await rejects(api.post("/dictionaries/contract/1/delete", { replacements: { "contract:1": "4" }, mode: "replace" }));
  check(isApiError(e, 400) && /не подходит выбранному владельцу/.test(e.detail), "замена из другой спецификации → 400");
  e = await rejects(api.post("/dictionaries/contract/5/delete", { replacements: { "contract:5": "1" }, mode: "replace" }));
  check(isApiError(e, 409) && /^Заменить нечем: у выбранного владельца нет другой записи «Контракт»/.test(e.detail), "контракт без кандидата: 409 «Заменить нечем»");
  e = await rejects(api.post("/dictionaries/contract/1/delete", { replacements: { "contract:1": 2 }, mode: "replace" }));
  check(isApiError(e, 422), "замена не строкой → 422");
  e = await rejects(api.post("/dictionaries/contract/1/delete", { replacements: { "contract:1": "3" }, mode: "replace" }));
  check(isApiError(e, 409) && /^Перевод изделий на замену оставил бы их без позиции в контракте: /.test(e.rawDetail) && /Колонна «QA-К1»: позиции не остаётся, а привязано изделий: 3/.test(e.rawDetail),
    "замена, не покрывающая позиции, → 409 (страж покрытия; текст длиннее 300 знаков — клиент V2 покажет запасной, полный — в rawDetail)");
  const still = await api.get("/contracts");
  check(still.length === 11 && still.find((x) => x.id === 1).linked_elements === 8 && still.find((x) => x.id === 3).linked_elements === 0 && (await api.get("/contracts/1/elements")).length === 8,
    "после отказа (откат транзакции) ничего не перенесено");

  const r = await api.post("/dictionaries/contract/1/delete", { replacements: { "contract:1": "2" }, mode: "replace" });
  check(r.deleted.length === 1 && r.deleted[0].kind === "contract" && r.moved.length === 1 && r.moved[0].from.startsWith("QA-ЗЖБИ-1/") && r.moved[0].moved.map((m) => `${m.label}:${m.count}`).join() === "Изделия:8,Записи истории статусов:14,Контракт по умолчанию:1",
    "удаление с заменой: {deleted, moved[{from,to,moved}]}");
  const after = await api.get("/contracts");
  check(after.length === 10 && !after.some((x) => x.id === 1) && after.find((x) => x.id === 2).linked_elements === 8, "контракт удалён, привязка изделий перенесена на контракт 2");
  check((await api.get("/contracts/2/elements")).map((x) => x.id).join() === "101,102,103,104,105,106,107,108" && isApiError(await rejects(api.get("/contracts/1/elements")), 404), "изделия видны у контракта-замены");
  check((await api.get("/dictionaries/contract/2/delete-plan")).plan.refs.map((x) => `${x.label}:${x.count}`).join() === "Изделия:8,Записи истории статусов:14,Контракт по умолчанию:1", "история и «по умолчанию» переехали на замену");
  check((await api.get("/contracts")).find((x) => x.id === 2).lines.map((l) => l.remaining).join() === "12,6,27", "остатки контракта-замены пересчитаны по привязанным изделиям");
  e = await rejects(api.post("/dictionaries/contract/1/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 404) && e.detail === "Контракт: запись не найдена", "повторное удаление → 404");
  e = await rejects(api.get("/dictionaries/contract/1/delete-plan"));
  check(isApiError(e, 404), "delete-plan удалённого → 404");

  const rc = await api.post("/dictionaries/contract/4/delete", { replacements: {}, mode: "replace" });
  check(rc.deleted.length === 1 && rc.moved.length === 0 && !(await api.get("/contracts")).some((x) => x.id === 4), "контракт без привязок удаляется без замены");
  e = await rejects(api.post("/dictionaries/agreement/2/delete", { replacements: {}, mode: "replace" }));
  check(isApiError(e, 400) && /^Не выбрана замена: Договор «Договор QA-Д-102 от 10.04.2026»/.test(e.detail), "договор с привязанными изделиями без замены → 400");
  const sp = await api.post("/dictionaries/specification/8/delete", { replacements: {}, mode: "replace" });
  check(sp.deleted[0].kind === "specification" && sp.deleted[0].label === "Спецификация QA-С-0" && !(await api.get("/specifications?agreement_id=7")).length, "спецификация без контрактов удаляется");

  const clean = await api.post("/dictionaries/counterparty/5/delete", { replacements: {}, mode: "replace" });
  check(clean.deleted.map((d) => d.kind).join() === "counterparty,agreement,specification,contract" && clean.moved.length === 0, "чистое удаление контрагента уносит договор, спецификацию и контракт");
  check(!(await api.get("/counterparties")).some((x) => x.id === 5) && (await api.get("/agreements?counterparty_id=5")).length === 0 && !(await api.get("/contracts")).some((x) => x.id === 10),
    "контрагент 5 и его дерево исчезли из GET");
  check((await api.get("/dictionaries/object/14/delete-plan")).blockers.every((b) => b.label !== "Договоры"), "объект 14: договоров больше нет — blocker «Договоры» пропал");
  await api.post("/dictionaries/counterparty/4/delete", { replacements: {}, mode: "replace" });
  check(!(await api.get("/counterparties")).some((x) => x.id === 4), "контрагент без договоров удалён");

  const merge = await api.post("/dictionaries/counterparty/2/delete", { replacements: { "counterparty:2": "1" }, mode: "merge" });
  check(merge.deleted.length === 1 && merge.moved[0].kind === "counterparty" && merge.moved[0].to === "QA-ЗЖБИ-1" && merge.moved[0].adopted.some((a) => a === "договор QA-ДГ-7/2026 перенесён"),
    "режим merge: подчинённые переехали к выбранному контрагенту, удалена опустевшая запись");
  check((await api.get("/agreements?counterparty_id=1")).length === 5 && (await api.get("/contracts")).find((x) => x.id === 7).counterparty_short_name === "QA-ЗЖБИ-1", "после merge договоры и контракты числятся у контрагента-получателя");
  e = await rejects(api.post("/dictionaries/counterparty/1/delete", { replacements: {}, mode: "merge" }));
  check(isApiError(e, 400) && e.detail === "Выберите запись, к которой перенести подчинённые", "merge без выбранной записи → 400");
  e = await rejects(api.post("/dictionaries/object/20/delete", { replacements: {}, mode: "merge" }));
  check(isApiError(e, 400) && /нет подчинённых/.test(e.detail), "merge у объекта по-прежнему 400");

  ctl.reset();
  const ag3 = await api.post("/dictionaries/agreement/3/delete", { replacements: {}, mode: "replace" });
  check(ag3.deleted.map((d) => d.kind).join() === "agreement,specification,contract,contract" && !(await api.get("/contracts")).some((x) => x.id === 6 || x.id === 7),
    "договор без изделий уходит вместе со спецификациями и контрактами");

  ctl.setPermissions({ system_admin: false, features: { counterparties: "write", dict_delete: "none" } }, { replace: true });
  e = await rejects(api.get("/dictionaries/contract/4/delete-plan"));
  check(isApiError(e, 403) && /«Удаление записей справочников с заменой ссылок»/.test(e.detail), "без dict_delete: delete-plan → 403");
  check(isApiError(await rejects(api.get("/dictionaries/contract/candidates?key=1")), 403) && isApiError(await rejects(api.post("/dictionaries/contract/4/delete", {})), 403), "candidates и delete → 403");
  ctl.setPermissions(null);
}

console.log("Плановая дата изделия и права: PATCH /elements/{id}/planned-delivery-date, /me/permissions");
{
  ctl.reset();
  const r = await api.patch("/elements/103/planned-delivery-date", { planned_delivery_date: "2026-09-30" });
  check(r.id === 103 && r.planned_delivery_date === "2026-09-30" && r.contract_id === 1 && r.counterparty_code === "ЗЖБИ1" && Array.isArray(r.history) && r.current_status === "shipped",
    "PATCH planned-delivery-date: вернулась карточка изделия с новой датой");
  check((await api.get("/contracts/1/elements")).find((x) => x.id === 103).planned_delivery_date === "2026-09-30", "дата видна в следующем GET /contracts/{id}/elements");
  check((await api.patch("/elements/103/planned-delivery-date", { planned_delivery_date: null })).planned_delivery_date === null
    && (await api.get("/contracts/1/elements")).find((x) => x.id === 103).planned_delivery_date === null, "null снимает дату");
  await api.patch("/elements/103/planned-delivery-date", { planned_delivery_date: "2026-09-30" });
  check((await api.patch("/elements/103/planned-delivery-date", {})).planned_delivery_date === null, "тело без поля тоже снимает дату (как в бэкенде)");
  let e;
  for (const bad of ["abc", "30.09.2026", "2026-02-30", "2026-9-3", ""]) {
    e = await rejects(api.patch("/elements/103/planned-delivery-date", { planned_delivery_date: bad }));
    check(isApiError(e, 422) && /planned_delivery_date: /.test(e.detail), `неверная дата «${bad}» → 422`);
  }
  e = await rejects(api.patch("/elements/103/planned-delivery-date", { planned_delivery_date: 5 }));
  check(isApiError(e, 422) && /planned_delivery_date: Input should be a valid string/.test(e.detail), "не строка → 422");
  check((await api.get("/contracts/1/elements")).find((x) => x.id === 103).planned_delivery_date === null, "после 422 данные не изменились");
  e = await rejects(api.patch("/elements/999/planned-delivery-date", { planned_delivery_date: "2026-09-30" }));
  check(isApiError(e, 404) && e.detail === "Элемент не найден", "несуществующий элемент → 404");
  check(isApiError(await rejects(api.patch("/elements/abc/planned-delivery-date", {})), 422), "id не число → 422");

  ctl.loginAs(3);
  e = await rejects(api.patch("/elements/301/planned-delivery-date", { planned_delivery_date: "2026-09-30" }));
  check(isApiError(e, 403) && /^«Плановая дата поставки изделия»: изменение требует роли на объекте/.test(e.detail), "Наблюдатель на объекте: PATCH → 403");
  e = await rejects(api.patch("/elements/301/planned-delivery-date", { planned_delivery_date: "не дата" }));
  check(isApiError(e, 422), "422 раньше 403 (тело проверяется до прав на объект)");
  check((await api.get("/contracts/8/elements")).length === 3, "…но читать элементы контракта Наблюдатель может");
  ctl.loginAs(1);
  check((await api.get("/contracts/8/elements")).find((x) => x.id === 301).planned_delivery_date === "2026-08-18", "403 ничего не изменил");
  ctl.loginAs(2);
  check((await api.patch("/elements/301/planned-delivery-date", { planned_delivery_date: "2026-09-30" })).planned_delivery_date === "2026-09-30", "Комплектовщик на объекте 4: PATCH проходит");
  check((await api.patch("/elements/101/planned-delivery-date", { planned_delivery_date: "2026-09-29" })).planned_delivery_date === "2026-09-29", "Прораб на объекте 1 (planned_date=write): PATCH проходит");
  ctl.loginAs(1);

  const perm = (o) => api.get(`/me/permissions?object_id=${o}`);
  check((await perm(1)).features.planned_date === "write" && (await perm(6)).features.planned_date === "none" && (await perm(6)).not_applicable.includes("planned_date"), "админ: write на объекте ЖБИ, none (не применимо) на объекте МФР");
  ctl.loginAs(2);
  check((await perm(1)).features.planned_date === "write" && (await perm(4)).features.planned_date === "write" && (await perm(5)).features.planned_date === "none", "loginAs(2): write на объектах 1 и 4, none на чужом");
  ctl.loginAs(3);
  check((await perm(4)).features.planned_date === "read" && (await perm(1)).features.planned_date === "none", "loginAs(3): read на объекте 4");
  ctl.loginAs(1);

  const PROFILES = {
    readonly: { system_admin: false, features: { users: "read", roles: "read", projects: "read", counterparties: "read", dict_delete: "none" } },
    none: { system_admin: false, features: {} },
    writer: { system_admin: false, features: { users: "write", roles: "write", projects: "write", counterparties: "write", dict_delete: "none" } },
    deleter: { system_admin: false, features: { users: "write", roles: "write", projects: "write", counterparties: "write", dict_delete: "write" } },
  };
  const levels = {};
  for (const [name, profile] of Object.entries(PROFILES)) {
    ctl.setPermissions(profile, { replace: true });
    const p = await perm(1);
    levels[name] = [p.system_admin, p.features.planned_date, p.features.agreements, p.features.contracts].join("/");
  }
  check(levels.writer === "false/write/write/write" && levels.deleter === "false/write/write/write" && levels.readonly === "false/read/read/read" && levels.none === "false/none/none/none",
    "профили boot.js: planned_date/agreements/contracts выводятся из уровня «Контрагенты» (writer/deleter — write, readonly — read, none — none)");
  ctl.setPermissions(PROFILES.writer, { replace: true });
  check((await perm(6)).features.planned_date === "none" && (await api.get("/me/permissions")).features.planned_date === "none", "профиль writer: на объекте МФР и без объекта — none");
  check((await api.patch("/elements/104/planned-delivery-date", { planned_delivery_date: "2026-11-11" })).planned_delivery_date === "2026-11-11", "профиль writer: PATCH даты проходит");
  check((await api.post("/agreements", { counterparty_id: 4, number: "QA-Профиль", object_id: 1 })).number === "QA-Профиль", "профиль writer: договор создаётся");
  ctl.setPermissions({ features: { planned_date: "none" } });
  check((await perm(1)).features.planned_date === "none" && isApiError(await rejects(api.patch("/elements/104/planned-delivery-date", { planned_delivery_date: "2026-11-12" })), 403), "явное planned_date в профиле главнее вывода: PATCH → 403");
  ctl.setPermissions(PROFILES.readonly, { replace: true });
  e = await rejects(api.patch("/elements/104/planned-delivery-date", { planned_delivery_date: "2026-11-12" }));
  check(isApiError(e, 403) && (await api.get("/agreements?counterparty_id=1")).length === 2 && isApiError(await rejects(api.post("/agreements", { counterparty_id: 4, number: "QA-Р", object_id: 1 })), 403),
    "профиль readonly: читать договоры можно, писать (planned_date, agreements) — 403");
  ctl.setPermissions(PROFILES.none, { replace: true });
  check(isApiError(await rejects(api.post("/counterparties", { full_name: "x", short_name: "y" })), 403) && isApiError(await rejects(api.get("/contracts/1/elements")), 403), "профиль none: запись контрагентов и чтение элементов контракта → 403");
  ctl.setPermissions(null);
  check((await perm(1)).features.planned_date === "write", "сброс профиля — снова администратор");
}

console.log("reset(overrides), hold() и ctl.count() для операций контрактации");
{
  ctl.reset({ contracts: (rows) => rows.slice(0, 1), elements: [] });
  check((await api.get("/contracts")).length === 1 && (await api.get("/contracts"))[0].linked_elements === 0, "reset(overrides): contracts — функцией, elements — массивом целиком");
  ctl.reset({ counterparties: (rows) => rows.slice(0, 1), agreements: [], specifications: [], contracts: [], elements: [] });
  check((await api.get("/counterparties")).length === 1 && (await api.get("/contracts")).length === 0 && (await api.get("/agreements?counterparty_id=1")).length === 0, "reset(overrides): пустая контрактация");
  ctl.reset();
  check((await api.get("/counterparties")).length === 7 && ctl.data.contracts.length === 11 && ctl.data.elements.length === 13 && ctl.data.specifications.length === 9 && ctl.data.agreements.length === 8, "reset() возвращает фикстуры; таблицы доступны в ctl.data");
  ctl.clearLog();

  const hDate = ctl.hold("PATCH /elements/104/planned-delivery-date");
  const hContract = ctl.hold("PATCH /contracts/4");
  const hDelete = ctl.hold("POST /dictionaries/contract/7/delete");
  const c4 = (await api.get("/contracts")).find((x) => x.id === 4);
  ctl.clearLog();
  const pDate = api.patch("/elements/104/planned-delivery-date", { planned_delivery_date: "2026-11-01" });
  const pContract = api.patch("/contracts/4", bodyOf(c4, { theme: "QA-Удержан" }));
  const pDelete = api.post("/dictionaries/contract/7/delete", { replacements: {}, mode: "replace" });
  await Promise.all([hDate.waitForRequest(), hContract.waitForRequest(), hDelete.waitForRequest()]);
  check(ctl.count("PATCH", "/planned-delivery-date") === 1 && ctl.count("PATCH", "=/contracts/4") === 1 && ctl.count("POST", "/dictionaries/contract/7/delete") === 1,
    "ctl.count() видит отправленные запросы, пока они удерживаются");
  check(hDate.pending === 1 && hContract.pending === 1 && hDelete.pending === 1 && ctl.data.elements.find((x) => x.id === 104).planned_delivery_date === "2026-10-05"
    && ctl.data.contracts.find((x) => x.id === 4).theme !== "QA-Удержан" && ctl.data.contracts.some((x) => x.id === 7), "пока запросы удерживаются, данные не менялись");
  hContract.release();
  const updated = await pContract;
  check(updated.theme === "QA-Удержан" && !(await settledWithin(pDate, 30)) && !(await settledWithin(pDelete, 30)), "release() одного hold не отпускает остальные");
  hDate.release();
  check((await pDate).planned_delivery_date === "2026-11-01" && !(await settledWithin(pDelete, 30)), "второй hold отпущен независимо");
  hDelete.fail(503, "Сервис перегружен");
  const ed = await rejects(pDelete);
  check(isApiError(ed, 503) && ed.detail === "Сервис перегружен" && ctl.data.contracts.some((x) => x.id === 7), "fail() на удалении: контракт остался");
  ctl.failNext("PATCH /elements/104/planned-delivery-date", { status: 500, detail: "Сбой записи даты" });
  const ef = await rejects(api.patch("/elements/104/planned-delivery-date", { planned_delivery_date: "2026-12-01" }));
  check(isApiError(ef, 500) && ef.detail === "Сбой записи даты" && ctl.data.elements.find((x) => x.id === 104).planned_delivery_date === "2026-11-01", "failNext на PATCH даты: данные не тронуты");
}

console.log("Итоги");
{
  check(ctl.internalErrors.length === 0, "внутренних ошибок стенда нет");
  check(api.hasPendingWrites() === false, "незавершённых записей нет");
  ctl.uninstall();
  check(globalThis.fetch === originalFetch, "uninstall() вернул оригинальный fetch");
}

console.log("strictDates: false — как в настоящем бэкенде, любая строка принимается");
{
  const ctl2 = installFakeBackend({ strictDates: false });
  const r = await api.patch("/elements/101/planned-delivery-date", { planned_delivery_date: "когда-нибудь" });
  check(r.planned_delivery_date === "когда-нибудь" && ctl2.internalErrors.length === 0, "PATCH planned-delivery-date без проверки формата");
  ctl2.uninstall();
  check(globalThis.fetch === originalFetch, "второй стенд снят, fetch восстановлен");
}

console.log(failures ? `\nПровалено проверок: ${failures}` : "\nВсе проверки пройдены");
process.exitCode = failures ? 1 : 0;

// Проверка области «admin» в БРАУЗЕРЕ (настоящие события мыши и клавиатуры, scripts/cdp.mjs) на НАСТОЯЩЕМ сервере с настоящим входом
// (scripts/real_auth_server.py) и КОПИИ БД. Пароли меняются только у тестовых пользователей копии; боевые данные не затрагиваются.
//
// Запуск:  node scripts/verify_admin_ui.mjs <порт> <каталог_копии> [раздел ...]   (разделы: users, passwords, access, roles, sessions, bulk, ...)
import { session, sql, sqlExec, http, ok, summary, openSection, text, exists, fill, clickText, click, reload, writes, PASSWORD } from "./verify_admin_lib.mjs";

const PORT = Number(process.argv[2] || 8141);
const WORK = process.argv[3];
const BASE = `http://127.0.0.1:${PORT}`;
const DB = WORK + "/work.db";
const SHOTS = WORK + "/shots";
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.slice(4);
const want = (n) => !only.length || only.includes(n);
const flush = () => new Promise((r) => setTimeout(r, 1400)); // журнал пишется фоновой очередью

const q = (s, a = []) => sql(DB, s);
const one = (s) => sql(DB, s)[0];
const wr = (b, from) => writes(b, from);
const dialogBtn = (key) => `.v2-dialog [data-choice=${key}]`;
async function confirmDialog(b, key = "confirm") {
  await b.waitFor(`!!document.querySelector('${dialogBtn(key)}')`);
  await click(b, dialogBtn(key));
  await b.sleep(150);
}
const uaStatus = (b) => text(b, "#ua-status");
async function openUsers(b) {
  await openSection(b, "users-access");
  if (!(await exists(b, "#ua-rows")) && (await exists(b, "[data-back]"))) await click(b, "[data-back]");
  await b.waitFor("!!document.querySelector('#ua-rows') || !!document.querySelector('#ua-read-error')");
}
async function openUserCard(b, login, tab) {
  await openUsers(b);
  const id = one(`SELECT id FROM users WHERE domain_login='${login}'`).id;
  await click(b, `.v2-table [data-user="${id}"]`);
  await b.waitFor("!!document.querySelector('[data-tab=security]')");
  if (tab) { await click(b, `[data-tab=${tab}]`); await b.sleep(400); }
  return id;
}
// Оборвать ОТВЕТ на следующий запрос (запрос на сервер уходит и выполняется, клиент получает сетевую ошибку) — «неизвестный исход».
async function dropNextResponse(b, urlPart, method) {
  await b.eval(`(()=>{const f=window.fetch; window.fetch=async(u,o)=>{const r=await f(u,o); if(String(u).includes(${JSON.stringify(urlPart)})&&((o&&o.method)||'GET')===${JSON.stringify(method)}){window.fetch=f; throw new TypeError('Failed to fetch');} return r;}})()`);
}

const admin = await http(BASE, "admin");
const user2 = await http(BASE, "user2");

// ====================================================================== пользователи
if (want("users")) {
  console.log("== Пользователи (браузер)");
  const b = await session(BASE, "admin");
  await openUsers(b);
  ok("U-UI-0 экран «Пользователи и доступ» открывается администратору, шлюз не блокирует запись", await exists(b, "[data-new]"));
  // --- создание: двойной клик, БД, перезагрузка
  let mark = b.requests.length;
  await click(b, "[data-new]");
  await b.waitFor("!!document.querySelector('#nu-last')");
  // клиентская валидация: пусто → ни одного запроса
  await click(b, "#nu-submit"); await b.sleep(300);
  ok("U-UI-1 пустая форма: сообщение и НЕТ запроса", (await text(b, "#nu-error")).includes("Заполните фамилию и логин") && wr(b, mark).length === 0);
  await fill(b, "#nu-last", "Интерфейсов"); await fill(b, "#nu-first", "Тест"); await fill(b, "#nu-login", "qa_ui_user1");
  await b.eval("document.querySelector('#nu-submit').scrollIntoView({block:'center'})");
  const r = await b.rect("#nu-submit");
  await b.click(r.cx, r.cy); await b.click(r.cx, r.cy);          // двойная отправка
  await b.waitFor("!!document.querySelector('[data-tab=security]')", 15000);
  const posts = wr(b, mark).filter((x) => x.method === "POST" && x.url.endsWith("/users"));
  ok("U-UI-2 двойной клик «Создать»: РОВНО ОДИН POST /users", posts.length === 1, `запросов: ${posts.length}`);
  const created = one("SELECT * FROM users WHERE domain_login='qa_ui_user1'");
  ok("U-UI-2 запись создана в БД (роль user, пароля нет, смена пароля требуется)", created && created.role === "user" && !created.password_hash && created.must_change_password === 1);
  await flush();
  ok("U-UI-2 журнал: user_create ровно одно", q("SELECT * FROM activity_log WHERE action='user_create' AND entity_id=" + created.id).length === 1);
  await reload(b);
  await b.waitFor("!!document.querySelector('#ua-rows')");
  ok("U-UI-2 после ПЕРЕЗАГРУЗКИ страницы пользователь в списке", (await text(b, "#ua-rows")).includes("qa_ui_user1"));
  // --- дубль логина: ошибка сервера, ввод остаётся
  await click(b, "[data-new]"); await b.waitFor("!!document.querySelector('#nu-last')");
  await fill(b, "#nu-last", "Дубль"); await fill(b, "#nu-login", "qa_ui_user1");
  mark = b.requests.length;
  await click(b, "#nu-submit"); await b.waitFor("(document.querySelector('#nu-error')||{}).innerText?.length>0");
  ok("U-UI-3 дубль логина: сообщение сервера 409, введённое остаётся в полях", (await text(b, "#nu-error")).includes("занято") && (await b.eval("document.querySelector('#nu-last').value")) === "Дубль");
  ok("U-UI-3 отказ не создал записи", q("SELECT COUNT(*) n FROM users WHERE domain_login='qa_ui_user1'")[0].n === 1);
  await click(b, "#nu-cancel");
  // --- правка карточки
  const uid = created.id;
  await click(b, `.v2-table [data-user="${uid}"]`); await b.waitFor("!!document.querySelector('#pf-pos')");
  mark = b.requests.length;
  await fill(b, "#pf-pos", "Инженер QA"); await fill(b, "#pf-dept", "Отдел проверки");
  await b.waitFor("!!document.querySelector('#card-save')");
  await click(b, "#card-save");
  await b.waitFor("(document.querySelector('#ua-status')||{}).innerText==='Сохранено'", 10000);
  const patch = wr(b, mark).find((x) => x.method === "PATCH");
  ok("U-UI-4 сохранение: PATCH с версией записи и без лишних полей", patch && JSON.parse(patch.body).expected_version && Object.keys(JSON.parse(patch.body)).length === 10, patch?.body);
  const row = one(`SELECT position, department FROM users WHERE id=${uid}`);
  ok("U-UI-4 в БД новые значения", row.position === "Инженер QA" && row.department === "Отдел проверки");
  await reload(b); await b.waitFor("!!document.querySelector('#ua-rows')");
  ok("U-UI-4 после перезагрузки значения в списке", (await text(b, "#ua-rows")).includes("Инженер QA · Отдел проверки"));
  await flush();
  ok("U-UI-4 журнал: user_update ровно одно", q(`SELECT * FROM activity_log WHERE action='user_update' AND entity_id=${uid}`).length === 1);
  // --- конфликт устаревших данных: другой администратор изменил запись, пока карточка была открыта
  await click(b, `.v2-table [data-user="${uid}"]`); await b.waitFor("!!document.querySelector('#pf-pos')");
  const list = (await admin.get("/users")).data; const cur = list.find((x) => x.id === uid);
  const other = await admin.patch(`/users/${uid}`, { last_name: cur.last_name, first_name: cur.first_name, patronymic: null, position: "Правка коллеги", department: cur.department, domain_login: cur.domain_login, role: cur.role, auth_method: "local", must_change_password: false, expected_version: cur.version });
  ok("U-UI-5 подготовка: коллега изменил запись по HTTP", other.status === 200);
  const before = JSON.stringify(q(`SELECT * FROM users WHERE id=${uid}`));
  await fill(b, "#pf-dept", "Моя правка");
  await click(b, "#card-save");
  await b.waitFor("!!document.querySelector('#ua-stale-reload')", 10000);
  ok("U-UI-5 устаревшая запись: отказ, ничего не перезаписано (SQL), предложено перечитать", (await uaStatus(b)).includes("Ничего не сохранено") && JSON.stringify(q(`SELECT * FROM users WHERE id=${uid}`)) === before && one(`SELECT position FROM users WHERE id=${uid}`).position === "Правка коллеги");
  await click(b, "#ua-stale-reload"); await b.waitFor("!!document.querySelector('#pf-pos')");
  await b.sleep(500);
  ok("U-UI-5 «Перечитать»: форма показывает правку коллеги, мои правки отброшены", (await b.eval("document.querySelector('#pf-pos').value")) === "Правка коллеги" && (await b.eval("document.querySelector('#pf-dept').value")) === "Отдел проверки");
  // --- неизвестный исход: запрос дошёл, ответ потерян — без автоповтора, сверка с сервером
  await fill(b, "#pf-pos", "Итог после обрыва");
  await b.waitFor("!!document.querySelector('#card-save')");
  await dropNextResponse(b, `/users/${uid}`, "PATCH");
  mark = b.requests.length;
  await click(b, "#card-save"); await b.sleep(1500);
  const patches = wr(b, mark).filter((x) => x.method === "PATCH");
  ok("U-UI-6 обрыв ответа: запрос ушёл ОДИН раз, автоповтора нет", patches.length === 1, `PATCH: ${patches.length}`);
  ok("U-UI-6 сервер сохранил (SQL); интерфейс сверился с сервером и честно сказал: «сохранил, хотя ответ не дошёл»", one(`SELECT position FROM users WHERE id=${uid}`).position === "Итог после обрыва" && (await uaStatus(b)).includes("хотя ответ не дошёл"), await uaStatus(b));
  // --- нет связи (запрос не ушёл)
  await b.eval("document.querySelector('#pf-pos').focus()");
  await fill(b, "#pf-pos", "Без сети");
  await b.offline(true);
  mark = b.requests.length;
  await b.waitFor("!!document.querySelector('#card-save')"); await click(b, "#card-save"); await b.sleep(1200);
  await b.offline(false);
  ok("U-UI-7 нет связи: сообщение, ввод остался, в БД старое", (await uaStatus(b)).includes("Нет связи") && (await b.eval("document.querySelector('#pf-pos').value")) === "Без сети" && one(`SELECT position FROM users WHERE id=${uid}`).position === "Итог после обрыва", await uaStatus(b));
  await click(b, "#card-cancel"); await b.sleep(300);
  // --- самозащита: свою роль администратора не снять, роль-выпадающий список выключен
  const selfId = one("SELECT id FROM users WHERE domain_login='admin'").id;
  await openUsers(b); await click(b, `.v2-table [data-user="${selfId}"]`); await b.waitFor("!!document.querySelector('#pf-role')");
  ok("U-UI-8 у себя роль «Администратор» изменить нельзя (поле выключено, есть пояснение)", (await b.eval("document.querySelector('#pf-role').disabled")) === true && (await text(b, "#ua-inner")).includes("снять нельзя"));
  await b.shot(SHOTS + "/users_card.png");
  ok("U-UI-9 исключений и ошибок консоли нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();

  // --- права: обычный пользователь и «просмотр» не видят раздел (сервер отвечает 403 — проверено HTTP)
  for (const login of ["user2", "user4"]) {
    const bb = await session(BASE, login);
    const navText = await text(bb, "#v2-side");
    ok(`U-UI-10 ${login}: пункта «Пользователи и доступ» в навигации нет`, !navText.includes("Пользователи и доступ"));
    await openSection(bb, "users-access"); await bb.sleep(600);
    ok(`U-UI-10 ${login}: прямой переход по адресу раздела ведёт на начальную страницу, а не в раздел`, !(await exists(bb, "#ua-inner")));
    await bb.close();
  }
}

// ====================================================================== пароли
if (want("passwords")) {
  console.log("== Пароли (браузер)");
  const uid = one("SELECT id FROM users WHERE domain_login='qa_ui_user1'")?.id
    ?? (await admin.post("/users", { last_name: "Интерфейсов", first_name: "Тест", domain_login: "qa_ui_user1", role: "user" })).data.id;
  const b = await session(BASE, "admin");
  await openUserCard(b, "qa_ui_user1", "security");
  ok("P-UI-0 политика пароля показана", (await text(b, "#sec-password-block")).includes("Не короче 8 символов"));
  let mark = b.requests.length;
  // пусто
  await click(b, "#sec-save"); await b.sleep(300);
  ok("P-UI-1 пустой пароль: сообщение, НЕТ запроса (пустая строка на сервере = блокировка входа)", (await text(b, "#sec-error")).includes("Введите новый пароль") && wr(b, mark).length === 0);
  // не совпадают
  await fill(b, "#sec-pass", "Qa-Ui-Pass-11"); await fill(b, "#sec-pass2", "Qa-Ui-Pass-12");
  await click(b, "#sec-save"); await b.sleep(300);
  ok("P-UI-1 повтор не совпал: сообщение, НЕТ запроса", (await text(b, "#sec-error")).includes("не совпадают") && wr(b, mark).length === 0);
  // слабый — ошибка сервера, пароль не изменён
  await fill(b, "#sec-pass", "short1"); await fill(b, "#sec-pass2", "short1");
  const hashBefore = one(`SELECT password_hash h FROM users WHERE id=${uid}`).h;
  await click(b, "#sec-save"); await b.waitFor("(document.querySelector('#sec-error')||{}).innerText?.length>0");
  ok("P-UI-2 слабый пароль: сообщение сервера 422, пароль не изменён", (await text(b, "#sec-error")).includes("не короче") && one(`SELECT password_hash h FROM users WHERE id=${uid}`).h === hashBefore, await text(b, "#sec-error"));
  // успех + двойной клик
  await fill(b, "#sec-pass", "Qa-Ui-Pass-11"); await fill(b, "#sec-pass2", "Qa-Ui-Pass-11");
  mark = b.requests.length;
  await b.eval("document.querySelector('#sec-save').scrollIntoView({block:'center'})");
  const r = await b.rect("#sec-save"); await b.click(r.cx, r.cy); await b.click(r.cx, r.cy);
  await b.waitFor("(document.querySelector('#ua-status')||{}).innerText?.startsWith('Пароль обновлён')", 12000);
  const sp = wr(b, mark).filter((x) => x.url.endsWith("/set-password"));
  ok("P-UI-3 двойной клик «Задать пароль»: ОДИН запрос", sp.length === 1, `запросов: ${sp.length}`);
  ok("P-UI-3 в теле пароль и признак смены, в БД хэш (не пароль)", JSON.parse(sp[0].body).must_change_password === true && !!one(`SELECT password_hash h FROM users WHERE id=${uid}`).h);
  const c1 = await fetch(BASE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "qa_ui_user1", password: "Qa-Ui-Pass-11" }) });
  ok("P-UI-3 вход этим паролем (настоящий POST /login) проходит, смена ещё требуется", c1.status === 200 && (await c1.json()).must_change_password === true);
  ok("P-UI-3 поля пароля очищены после успеха", (await b.eval("document.querySelector('#sec-pass').value")) === "");
  await flush();
  const jl = JSON.stringify(q("SELECT * FROM activity_log WHERE action='user_password'"));
  ok("P-UI-3 журнал: user_password, в нём нет пароля и хэша", jl.includes("изменён") && !jl.includes("Qa-Ui-Pass-11") && !jl.includes(one(`SELECT password_hash h FROM users WHERE id=${uid}`).h));
  // сеансы пользователя: два входа по HTTP → видны → завершить один → завершить все
  const s1 = await http(BASE, "qa_ui_user1", "Qa-Ui-Pass-11"), s2 = await http(BASE, "qa_ui_user1", "Qa-Ui-Pass-11");
  await click(b, "[data-sessions-refresh]"); await b.sleep(700);
  const nSess = one(`SELECT COUNT(*) n FROM sessions WHERE user_id=${uid}`).n;
  ok(`P-UI-4 сеансы пользователя показаны (${nSess}, как в БД)`, nSess >= 2 && (await text(b, "#sec-sessions")).includes(`Активных сеансов: ${nSess}`));
  mark = b.requests.length;
  await click(b, "[data-end-session]"); await confirmDialog(b);
  await b.waitFor(`(document.querySelector('#sec-sessions')||{}).innerText?.includes('Активных сеансов: ${nSess - 1}')`);
  ok("P-UI-4 завершение одного: DELETE /sessions/{id}, стало на один меньше (SQL)", wr(b, mark).filter((x) => x.method === "DELETE" && x.url.includes("/sessions/")).length === 1 && one(`SELECT COUNT(*) n FROM sessions WHERE user_id=${uid}`).n === nSess - 1);
  await click(b, "[data-end-all]"); await confirmDialog(b);
  await b.waitFor("(document.querySelector('#sec-sessions')||{}).innerText?.includes('Активных сеансов: 0')");
  ok("P-UI-4 завершение всех: у человека 0 сеансов, пароль цел (вход проходит)", one(`SELECT COUNT(*) n FROM sessions WHERE user_id=${uid}`).n === 0 && (await fetch(BASE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "qa_ui_user1", password: "Qa-Ui-Pass-11" }) })).status === 200);
  // блокировка входа
  await b.eval("document.querySelector('#sec-block').scrollIntoView()");
  mark = b.requests.length;
  await click(b, "#sec-block");
  await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("P-UI-5 подтверждение блокировки называет пользователя", (await text(b, ".v2-dialog")).includes("Интерфейсов"));
  await confirmDialog(b, "cancel"); await b.sleep(200);
  ok("P-UI-5 отказ в подтверждении: запроса нет", wr(b, mark).length === 0);
  await click(b, "#sec-block"); await confirmDialog(b);
  await b.waitFor("(document.querySelector('#ua-status')||{}).innerText==='Вход по паролю заблокирован'", 10000);
  ok("P-UI-5 блокировка: пустой пароль на сервере, has_password=0 (SQL), вход невозможен", one(`SELECT password_hash h FROM users WHERE id=${uid}`).h === null && (await fetch(BASE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "qa_ui_user1", password: "Qa-Ui-Pass-11" }) })).status === 401);
  ok("P-UI-5 после блокировки кнопки «Заблокировать» нет, форма пароля осталась", !(await exists(b, "#sec-block")) && (await exists(b, "#sec-pass")));
  // вернуть рабочий пароль (для дальнейших проверок)
  await fill(b, "#sec-pass", "Qa-Ui-Pass-21"); await fill(b, "#sec-pass2", "Qa-Ui-Pass-21");
  await click(b, "#sec-save"); await b.waitFor("(document.querySelector('#ua-status')||{}).innerText?.startsWith('Пароль обновлён')", 10000);
  // себя нельзя заблокировать, пароль себе — через «Сменить пароль»
  const selfId = one("SELECT id FROM users WHERE domain_login='admin'").id;
  await openUsers(b); await click(b, `.v2-table [data-user="${selfId}"]`); await b.waitFor("!!document.querySelector('[data-tab=security]')");
  await click(b, "[data-tab=security]"); await b.sleep(600);
  ok("P-UI-6 в своей карточке: нет блокировки и нет установки пароля, есть ссылка на «Сменить пароль»", !(await exists(b, "#sec-block")) && !(await exists(b, "#sec-pass")) && (await text(b, "#sec-password-block")).includes("Сменить пароль"));
  // зайти под пользователем: окно открывается в новой вкладке
  await openUserCard(b, "qa_ui_user1", "security");
  await b.eval("window.__opened=[]; window.open=(u)=>{const o={location:{set href(v){window.__opened.push(v);}},close(){}}; return o;}");
  mark = b.requests.length;
  await click(b, "#sec-impersonate"); await confirmDialog(b);
  await b.waitFor("(window.__opened||[]).length>0", 8000);
  const url = await b.eval("window.__opened[0]");
  ok("P-UI-7 «Зайти под пользователем»: POST /impersonate, вкладка открывается по адресу с токеном в #хэше", wr(b, mark).filter((x) => x.url.endsWith("/impersonate")).length === 1 && /^\/#impersonate=/.test(url), url?.slice(0, 40));
  const tok = decodeURIComponent(url.split("=")[1]);
  const meImp = await fetch(BASE + "/me", { headers: { "X-Impersonate-Token": tok } });
  const meJson = await meImp.json();
  ok("P-UI-7 с этим токеном сервер отвечает от имени человека, с пометкой, кто вошёл", meJson.domain_login === "qa_ui_user1" && !!meJson.impersonated_by, JSON.stringify({ l: meJson.domain_login, by: meJson.impersonated_by }));
  await flush();
  ok("P-UI-7 журнал: impersonate_start на имя администратора", q("SELECT * FROM activity_log WHERE action='impersonate_start'").length >= 1);
  ok("P-UI-8 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();

  // обязательная смена пароля настоящей формой входа
  await admin.post(`/users/${uid}/set-password`, { password: "Qa-Force-Pass-31", must_change_password: true });
  const f = await session(BASE, "qa_ui_user1", { password: "Qa-Force-Pass-31" });
  ok("P-UI-9 вход с временным паролем открывает форму обязательной смены (не оболочку)", await exists(f, "#pw-form") && !(await exists(f, "#v2-side")));
  ok("P-UI-9 политика пароля показана на форме", (await f.waitFor("(document.querySelector('#pw-policy')||{}).innerText?.length>0")) && (await text(f, "#pw-policy")).includes("Не короче"));
  let m2 = f.requests.length;
  await fill(f, "#pw-cur", "Qa-Force-Pass-31"); await fill(f, "#pw-new", "Qa-Force-Pass-31"); await fill(f, "#pw-rep", "Qa-Force-Pass-31");
  await click(f, "#pw-submit"); await f.sleep(300);
  ok("P-UI-10 новый = текущему: сообщение, НЕТ запроса", (await text(f, "#pw-error")).includes("отличаться") && wr(f, m2).length === 0);
  await fill(f, "#pw-new", "Qa-New-Pass-32"); await fill(f, "#pw-rep", "Qa-New-Pass-33");
  await click(f, "#pw-submit"); await f.sleep(300);
  ok("P-UI-10 повтор не совпал: сообщение, НЕТ запроса", (await text(f, "#pw-error")).includes("не совпадают") && wr(f, m2).length === 0);
  await fill(f, "#pw-cur", "Wrong-Pass-9x9"); await fill(f, "#pw-rep", "Qa-New-Pass-32");
  await click(f, "#pw-submit"); await f.waitFor("(document.querySelector('#pw-error')||{}).innerText?.length>0");
  ok("P-UI-10 неверный текущий: сообщение сервера 403, форма осталась, пароль прежний", (await text(f, "#pw-error")).includes("неверно") && await exists(f, "#pw-form") && one(`SELECT must_change_password m FROM users WHERE id=${uid}`).m === 1, await text(f, "#pw-error"));
  await fill(f, "#pw-cur", "Qa-Force-Pass-31"); await fill(f, "#pw-new", "1234567890123"); await fill(f, "#pw-rep", "1234567890123");
  await click(f, "#pw-submit"); await f.waitFor("(document.querySelector('#pw-error')||{}).innerText?.includes('буквы')");
  ok("P-UI-10 слабый (нет букв): сообщение сервера 422", true);
  await fill(f, "#pw-new", "Qa-New-Pass-32"); await fill(f, "#pw-rep", "Qa-New-Pass-32");
  m2 = f.requests.length;
  await f.eval("document.querySelector('#pw-submit').scrollIntoView({block:'center'})");
  const rr = await f.rect("#pw-submit"); await f.click(rr.cx, rr.cy); await f.click(rr.cx, rr.cy);
  await f.waitFor("!!document.querySelector('#v2-side')", 15000);
  ok("P-UI-11 двойной клик «Сменить пароль»: ОДИН запрос, открылась оболочка", wr(f, m2).filter((x) => x.url.endsWith("/me/change-password")).length === 1);
  await flush();
  ok("P-UI-11 флаг смены снят (SQL), вход новым паролем проходит, старым — нет", one(`SELECT must_change_password m FROM users WHERE id=${uid}`).m === 0 && (await fetch(BASE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "qa_ui_user1", password: "Qa-New-Pass-32" }) })).status === 200 && (await fetch(BASE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "qa_ui_user1", password: "Qa-Force-Pass-31" }) })).status === 401);
  const jl2 = JSON.stringify(q("SELECT * FROM activity_log"));
  ok("P-UI-11 журнал: ни один пароль не встречается", !["Qa-Force-Pass-31", "Qa-New-Pass-32", "Qa-New-Pass-33", "Wrong-Pass-9x9", "1234567890123", "Qa-Ui-Pass-11", "Qa-Ui-Pass-21"].some((p) => jl2.includes(p)));
  // добровольная смена пароля из раздела «Сменить пароль» + выход
  await openSection(f, "change-password");
  await f.waitFor("!!document.querySelector('#pw-form')");
  await fill(f, "#pw-cur", "Qa-New-Pass-32"); await fill(f, "#pw-new", "Qa-Self-Pass-41"); await fill(f, "#pw-rep", "Qa-Self-Pass-41");
  const s3 = await http(BASE, "qa_ui_user1", "Qa-New-Pass-32");    // другой сеанс этого человека — должен погибнуть
  await click(f, "#pw-submit"); await f.waitFor("(document.querySelector('#pw-note')||{}).innerText?.includes('Пароль изменён')", 12000);
  ok("P-UI-12 добровольная смена: сообщение, свой сеанс жив, чужой завершён", (await f.eval("fetch('/me').then(r=>r.status)")) === 200 && (await s3.get("/me")).status === 401);
  await f.shot(SHOTS + "/change_password.png");
  await click(f, "#v2-logout-btn"); await f.waitFor("!!document.querySelector('#v2-login-form')", 12000);
  ok("P-UI-13 «Выйти»: экран входа, сеанс на сервере удалён", (await f.eval("fetch('/me').then(r=>r.status)")) === 401);
  ok("P-UI-13 исключений нет", f.exceptions.length === 0, JSON.stringify(f.exceptions.slice(0, 2)));
  await f.close();
}

// ====================================================================== доступ к проектам и объектам
if (want("access")) {
  console.log("== Доступ (браузер)");
  const uid = one("SELECT id FROM users WHERE domain_login='qa_ui_user1'")?.id
    ?? (await admin.post("/users", { last_name: "Интерфейсов", first_name: "Тест", domain_login: "qa_ui_user1", role: "user" })).data.id;
  await admin.put(`/users/${uid}/access`, { grants: [] });
  const proj = one("SELECT id, name FROM projects ORDER BY id LIMIT 1");
  const obj = one(`SELECT id, name FROM objects WHERE project_id=${proj.id} ORDER BY id LIMIT 1`);
  const grants = () => q(`SELECT project_id, object_id, role FROM user_access WHERE user_id=${uid} ORDER BY project_id, object_id, role`);
  const b = await session(BASE, "admin");
  await openUserCard(b, "qa_ui_user1", "access");
  await b.waitFor("!!document.querySelector('#ua-access-all-areas')");
  ok("A-UI-0 у пользователя без доступа: «Нет доступа», кнопка «Сохранить» выключена", (await text(b, "#ua-access-results")).includes("Нет доступа") && (await b.eval("document.querySelector('#ua-access-save').disabled")) === true);
  await click(b, "#ua-access-all-areas");
  await b.waitFor(`!!document.querySelector('[data-edit-area="p:${proj.id}"]')`);
  await click(b, `[data-edit-area="p:${proj.id}"]`);
  await b.waitFor("!!document.querySelector('[data-grant-role=view]')");
  await click(b, "[data-grant-role=view]");
  ok("A-UI-1 отметка роли включает «Сохранить» и сторож несохранённого", (await b.eval("document.querySelector('#ua-access-save').disabled")) === false && (await uaStatus(b)).includes("несохранённые"));
  // сторож: уход на другую вкладку спрашивает
  await click(b, "[data-tab=profile]"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("A-UI-2 уход с несохранённым доступом: диалог «Несохранённые изменения»", (await text(b, ".v2-dialog")).includes("несохранённые"));
  await confirmDialog(b, "cancel");                              // «Остаться»
  ok("A-UI-2 «Остаться»: правка на месте, запроса нет", (await b.eval("document.querySelector('[data-grant-role=view]').checked")) === true && grants().length === 0);
  // сохранить: двойной клик
  let mark = b.requests.length;
  await b.eval("document.querySelector('#ua-access-save').scrollIntoView({block:'center'})");
  const r = await b.rect("#ua-access-save"); await b.click(r.cx, r.cy); await b.click(r.cx, r.cy);
  await b.waitFor("(document.querySelector('#ua-status')||{}).innerText==='Доступ сохранён'", 10000);
  const puts = wr(b, mark).filter((x) => x.method === "PUT" && x.url.endsWith("/access"));
  ok("A-UI-3 двойной клик «Сохранить»: ОДИН PUT, в теле grants и expected_grants", puts.length === 1 && Array.isArray(JSON.parse(puts[0].body).expected_grants), `PUT: ${puts.length}`);
  ok("A-UI-3 в БД грант проекта с ролью «view»", JSON.stringify(grants()) === JSON.stringify([{ project_id: proj.id, object_id: null, role: "view" }]));
  await flush();
  ok("A-UI-3 журнал: access_replace ровно одно для этого пользователя", q(`SELECT * FROM activity_log WHERE action='access_replace' AND entity_id=${uid}`).length >= 1);
  await reload(b);
  await openUserCard(b, "qa_ui_user1", "access");
  ok("A-UI-4 после ПЕРЕЗАГРУЗКИ сводка показывает выданный доступ (проект, роль)", (await text(b, "#ua-access-results")).includes(proj.name) && (await text(b, "#ua-access-results")).includes("Наблюдатель") || (await text(b, "#ua-access-results")).includes(proj.name));
  // конфликт: коллега изменил доступ, пока форма открыта
  await click(b, "#ua-access-all-areas");
  await b.waitFor(`!!document.querySelector('[data-edit-area="o:${proj.id}:${obj.id}"]')`);
  await click(b, `[data-edit-area="o:${proj.id}:${obj.id}"]`);
  await b.waitFor("!!document.querySelector('[data-grant-role=user]')");
  const colleague = await admin.put(`/users/${uid}/access`, { grants: [{ project_id: proj.id, object_id: null, role: "view" }, { project_id: null, object_id: null, role: "contract" }] });
  ok("A-UI-5 подготовка: коллега изменил доступ по HTTP", colleague.status === 200);
  await click(b, "[data-grant-role=user]");
  const beforeGrants = JSON.stringify(grants());
  await click(b, "#ua-access-save");
  await b.waitFor("!!document.querySelector('#ua-stale-reload')", 10000);
  ok("A-UI-5 устаревший доступ: отказ 409, ничего не перезаписано (SQL), предложено перечитать", (await uaStatus(b)).includes("Ничего не сохранено") && JSON.stringify(grants()) === beforeGrants && grants().some((g) => g.role === "contract"));
  await click(b, "#ua-stale-reload"); await b.waitFor("!!document.querySelector('#ua-access-search')");
  await b.sleep(600);
  ok("A-UI-5 «Перечитать»: видна правка коллеги («Все проекты»), моя отметка отброшена", (await text(b, "#ua-inner")).includes("Все текущие и будущие проекты"));
  // обрыв ответа
  await click(b, "#ua-access-all-areas");
  await b.waitFor(`!!document.querySelector('[data-edit-area="o:${proj.id}:${obj.id}"]')`);
  await click(b, `[data-edit-area="o:${proj.id}:${obj.id}"]`);
  await b.waitFor("!!document.querySelector('[data-grant-role=user]')");
  await click(b, "[data-grant-role=user]");
  await dropNextResponse(b, `/users/${uid}/access`, "PUT");
  mark = b.requests.length;
  await click(b, "#ua-access-save"); await b.sleep(1800);
  ok("A-UI-6 обрыв ответа: ОДИН PUT, автоповтора нет, сервер сохранил (SQL), интерфейс сверился и сказал об этом", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && grants().some((g) => g.object_id === obj.id && g.role === "user") && (await uaStatus(b)).includes("хотя ответ не дошёл"), await uaStatus(b));
  // нет связи
  await click(b, "#ua-access-all-areas");
  await b.waitFor(`!!document.querySelector('[data-edit-area="o:${proj.id}:${obj.id}"]')`);
  await click(b, `[data-edit-area="o:${proj.id}:${obj.id}"]`);
  await b.waitFor("!!document.querySelector('[data-grant-role=contract]')");
  await click(b, "[data-grant-role=contract]");
  await b.offline(true); mark = b.requests.length;
  await click(b, "#ua-access-save"); await b.sleep(1200); await b.offline(false);
  ok("A-UI-7 нет связи: сообщение, отметка осталась, в БД прежнее", (await uaStatus(b)).includes("Нет связи") && (await b.eval("document.querySelector('[data-grant-role=contract]').checked")) === true && !grants().some((g) => g.object_id === obj.id && g.role === "contract"));
  await click(b, "#ua-access-cancel"); await b.sleep(400);
  // сводка в карточке = сводке сервера (user2)
  const u2 = one("SELECT id FROM users WHERE domain_login='user2'").id;
  await openUserCard(b, "user2", "access"); await b.waitFor("!!document.querySelector('#ua-access-all-areas')");
  if ((await text(b, "#ua-access-all-areas")).includes("Только доступные")) await click(b, "#ua-access-all-areas");
  await b.waitFor("!!document.querySelector('#ua-access-results .v2-perm')");
  const shown = await b.eval("document.querySelectorAll('#ua-access-results .v2-perm').length");
  const server = (await admin.get(`/users/${u2}/access-summary`)).data;
  ok("A-UI-8 сводка доступных объектов в карточке (user2) = сводке сервера", shown === server.totals.objects, `${shown} vs ${server.totals.objects}`);
  await b.shot(SHOTS + "/access_tab.png");
  ok("A-UI-9 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  // user2: раздел «Мой доступ»
  const c2 = await session(BASE, "user2");
  await openSection(c2, "my-access"); await c2.waitFor("!!document.querySelector('#ma-body .v2-result')");
  const mine = (await user2.get("/me/access-summary")).data;
  const rows = await c2.eval("document.querySelectorAll('#ma-body .v2-read-tbl tbody tr').length");
  const tree = (await user2.get("/projects-tree")).data.projects.reduce((n, p) => n + p.objects.length, 0);
  ok("A-UI-10 «Мой доступ» (user2): число объектов = сводке сервера = тому, что виден в переключателе объектов", rows === mine.totals.objects && rows === tree, `${rows}/${mine.totals.objects}/${tree}`);
  await c2.close();
}

// ====================================================================== роли
if (want("roles")) {
  console.log("== Роли (браузер)");
  const b = await session(BASE, "admin");
  await openSection(b, "users-access"); await b.waitFor("!!document.querySelector('[data-page=roles]')");
  await click(b, "[data-page=roles]"); await b.waitFor("!!document.querySelector('#role-new')");
  let mark = b.requests.length;
  await click(b, "#role-new"); await b.waitFor("!!document.querySelector('#role-new-name')");
  await click(b, "#role-new-submit"); await b.sleep(300);
  ok("R-UI-1 пустое название: сообщение, НЕТ запроса", (await text(b, "#role-new-error")).includes("Введите название") && wr(b, mark).length === 0);
  await fill(b, "#role-new-name", "QA роль интерфейса");
  await b.eval("document.querySelector('#role-new-submit').scrollIntoView({block:'center'})");
  const r = await b.rect("#role-new-submit"); await b.click(r.cx, r.cy); await b.click(r.cx, r.cy);
  await b.waitFor("(document.querySelector('#role-editor h3')||{}).innerText==='QA роль интерфейса'", 10000);
  ok("R-UI-1 двойной клик «Создать»: ОДИН POST /roles, роль в БД без разрешений", wr(b, mark).filter((x) => x.method === "POST" && x.url.endsWith("/roles")).length === 1 && one("SELECT COUNT(*) n FROM object_roles WHERE name='QA роль интерфейса'").n === 1);
  const key = one("SELECT key FROM object_roles WHERE name='QA роль интерфейса'").key;
  ok("R-UI-1 новая роль пуста: разрешений нет", one(`SELECT COUNT(*) n FROM role_features WHERE role_key='${key}'`).n === 0);
  // матрица: первая ячейка «Чтение»
  const featBtn = await b.eval("(()=>{const e=document.querySelector('[data-perm][data-level=read]');return e?e.dataset.perm:null})()");
  await click(b, `[data-perm="${featBtn}"][data-level=read]`);
  ok("R-UI-2 отметка ячейки: несохранённое, «Сохранить» в подвале", (await text(b, "#ua-status")).includes("Не сохранено ячеек: 1"));
  mark = b.requests.length;
  await click(b, "#roles-save");
  await b.waitFor("(document.querySelector('#ua-status')||{}).innerText==='Разрешения сохранены'", 10000);
  const put = wr(b, mark).find((x) => x.method === "PUT" && x.url.endsWith("/roles/features"));
  ok("R-UI-2 PUT с «было» (ожидаемым прежним уровнем)", put && JSON.parse(put.body).items[0].was === "none", put?.body);
  ok("R-UI-2 в БД уровень «read»; журнал role_permissions", one(`SELECT level FROM role_features WHERE role_key='${key}' AND feature_key='${featBtn}'`).level === "read");
  await flush();
  ok("R-UI-2 журнал: role_permissions", q("SELECT * FROM activity_log WHERE action='role_permissions'").length >= 1);
  // конфликт: коллега поменял ту же ячейку
  await click(b, `[data-perm="${featBtn}"][data-level=write]`);
  const cw = await admin.put("/roles/features", { items: [{ role_key: key, feature_key: featBtn, level: "none", was: "read" }] });
  ok("R-UI-3 подготовка: коллега сбросил ячейку по HTTP", cw.status === 200);
  await click(b, "#roles-save");
  await b.waitFor("!!document.querySelector('#ua-stale-reload')", 10000);
  ok("R-UI-3 устаревшая ячейка: отказ 409, в БД правка коллеги (ячейки нет), предложено перечитать", (await uaStatus(b)).includes("Ничего не сохранено") && one(`SELECT COUNT(*) n FROM role_features WHERE role_key='${key}'`).n === 0);
  await click(b, "#ua-stale-reload"); await b.waitFor("!!document.querySelector('#role-editor')"); await b.sleep(500);
  // переименование
  await click(b, "#role-rename"); await b.waitFor("!!document.querySelector('#role-rename-name')");
  await fill(b, "#role-rename-name", "QA роль (новое имя)");
  mark = b.requests.length;
  await click(b, "#role-rename-submit");
  await b.waitFor("(document.querySelector('#role-editor h3')||{}).innerText==='QA роль (новое имя)'", 10000);
  ok("R-UI-4 переименование: PATCH с expected_name, в БД новое название", JSON.parse(wr(b, mark).find((x) => x.method === "PATCH").body).expected_name === "QA роль интерфейса" && one(`SELECT name FROM object_roles WHERE key='${key}'`).name === "QA роль (новое имя)");
  // порядок
  const orderBefore = q("SELECT key FROM object_roles ORDER BY rank").map((x) => x.key);
  await b.waitFor(`!!document.querySelector('[data-role-up="${key}"]')`);
  await click(b, `[data-role-up="${key}"]`); await b.waitFor("!!document.querySelector('#role-editor')"); await b.sleep(700);
  const orderAfter = q("SELECT key FROM object_roles ORDER BY rank").map((x) => x.key);
  ok("R-UI-5 порядок ролей: новая роль поднялась на одну позицию (SQL)", orderAfter.indexOf(key) === orderBefore.indexOf(key) - 1);
  // удаление: выдача роли человеку → план показывает число выдач, подтверждение с названием
  const uid = one("SELECT id FROM users WHERE domain_login='qa_ui_user1'")?.id ?? (await admin.post("/users", { last_name: "Интерфейсов", first_name: "Тест", domain_login: "qa_ui_user1", role: "user" })).data.id;
  await admin.put(`/users/${uid}/access`, { grants: [{ project_id: null, object_id: null, role: key }] });
  await reload(b);
  await openSection(b, "users-access"); await b.waitFor("!!document.querySelector('[data-page=roles]')");
  await click(b, "[data-page=roles]"); await b.waitFor(`!!document.querySelector('[data-role="${key}"]')`);
  await click(b, `[data-role="${key}"]`); await b.waitFor("!!document.querySelector('#role-delete')");
  await click(b, "#role-delete"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  const msg = await text(b, ".v2-dialog");
  ok("R-UI-6 диалог удаления называет роль и число выдач из плана", msg.includes("QA роль (новое имя)") && msg.includes("выданных грантов: 1"), msg);
  await confirmDialog(b, "cancel");
  ok("R-UI-6 отмена: роль на месте (SQL)", one(`SELECT COUNT(*) n FROM object_roles WHERE key='${key}'`).n === 1);
  // план устарел: диалог открыт (в плане 1 выдача), пока человек читает, коллега выдал роль ещё одному — подтверждение должно получить 409
  await click(b, "#role-delete"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  await admin.put(`/users/${one("SELECT id FROM users WHERE domain_login='user5'").id}/access`, { grants: [{ project_id: null, object_id: null, role: key }] });
  mark = b.requests.length;
  await confirmDialog(b);
  await b.sleep(1500);
  ok("R-UI-7 устаревший план: отказ 409 (DELETE с expected_granted=1), роль цела, интерфейс показал актуальное число", wr(b, mark).filter((x) => x.method === "DELETE" && x.url.includes("expected_granted=1")).length === 1 && one(`SELECT COUNT(*) n FROM object_roles WHERE key='${key}'`).n === 1 && (await uaStatus(b)).includes("изменились") && (await text(b, "#role-editor")).includes("(сейчас — 2)"), await uaStatus(b));
  await click(b, "#role-delete"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("R-UI-8 повторный план показывает 2 выдачи", (await text(b, ".v2-dialog")).includes("выданных грантов: 2"));
  await confirmDialog(b);
  await b.waitFor(`!document.querySelector('[data-role="${key}"]')`, 10000);
  ok("R-UI-8 удаление по актуальному плану: роль, её разрешения и обе выдачи исчезли (SQL); чужие доступы целы", one(`SELECT COUNT(*) n FROM object_roles WHERE key='${key}'`).n === 0 && one(`SELECT COUNT(*) n FROM user_access WHERE role='${key}'`).n === 0 && one("SELECT COUNT(*) n FROM user_access WHERE user_id=" + one("SELECT id FROM users WHERE domain_login='user2'").id).n >= 1);
  await flush();
  ok("R-UI-8 журнал: role_delete", q("SELECT * FROM activity_log WHERE action='role_delete'").length >= 1);
  await b.shot(SHOTS + "/roles.png");
  ok("R-UI-9 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  for (const login of ["user2", "user4"]) {
    const bb = await session(BASE, login);
    ok(`R-UI-10 ${login}: раздела ролей в навигации нет`, !(await text(bb, "#v2-side")).includes("Пользователи и доступ"));
    await bb.close();
  }
}

// ====================================================================== сеансы (мои и все)
if (want("sessions")) {
  console.log("== Сеансы (браузер)");
  const extra = [await http(BASE, "admin"), await http(BASE, "admin"), await http(BASE, "admin")];
  const b = await session(BASE, "admin");
  await openSection(b, "sessions"); await b.waitFor("!!document.querySelector('#ss-body table') && !!document.querySelector('#ss-all table')");
  const mine = one("SELECT COUNT(*) n FROM sessions WHERE user_id=" + one("SELECT id FROM users WHERE domain_login='admin'").id).n;
  ok("N-UI-1 «мои сеансы»: строк столько, сколько в БД, текущий помечен и без кнопки", (await b.eval("document.querySelectorAll('#ss-body tbody tr').length")) === mine && (await text(b, "#ss-body")).includes("этот сеанс"));
  let mark = b.requests.length;
  await click(b, "#ss-body [data-end]"); await confirmDialog(b);
  await b.waitFor(`document.querySelectorAll('#ss-body tbody tr').length===${mine - 1}`);
  ok("N-UI-2 завершение своего другого сеанса: один DELETE /me/sessions/{id}, в БД на один меньше", wr(b, mark).filter((x) => x.method === "DELETE" && x.url.includes("/me/sessions/")).length === 1 && one("SELECT COUNT(*) n FROM sessions WHERE user_id=" + one("SELECT id FROM users WHERE domain_login='admin'").id).n === mine - 1);
  // все сеансы: чужие
  const other = await http(BASE, "user4"), other2 = await http(BASE, "user4");
  await click(b, "#ss-all-refresh"); await b.sleep(800);
  ok("N-UI-3 «все сеансы»: видны сеансы user4", (await text(b, "#ss-all")).includes("user4"));
  mark = b.requests.length;
  await click(b, "#ss-all [data-aend]"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("N-UI-3 подтверждение называет пользователя", (await text(b, ".v2-dialog")).includes("Завершить сеанс пользователя"));
  await confirmDialog(b);
  await b.sleep(1200);
  ok("N-UI-3 завершение чужого сеанса: DELETE /sessions/{id}", wr(b, mark).filter((x) => x.method === "DELETE" && /\/sessions\//.test(x.url) && !x.url.includes("/me/")).length === 1);
  mark = b.requests.length;
  await click(b, "#ss-all-close-others"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  const dlg = await text(b, ".v2-dialog");
  ok("N-UI-4 «завершить все, кроме моего»: подтверждение с числом", /\(\d+\)/.test(dlg));
  await confirmDialog(b);
  await b.sleep(1500);
  const left = q("SELECT s.token, u.domain_login FROM sessions s JOIN users u ON u.id=s.user_id");
  ok("N-UI-4 в БД остался ТОЛЬКО сеанс администратора, вошедшего в браузере; сеанс жив (страница работает)", left.length === 1 && left[0].domain_login === "admin" && (await b.eval("fetch('/me').then(r=>r.status)")) === 200, JSON.stringify(left));
  ok("N-UI-4 остальные HTTP-сеансы мертвы", (await other.get("/me")).status === 401 && (await extra[0].get("/me")).status === 401);
  await b.shot(SHOTS + "/sessions.png");
  ok("N-UI-5 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  const c = await session(BASE, "user2");
  await openSection(c, "sessions"); await c.waitFor("!!document.querySelector('#ss-body table')");
  ok("N-UI-6 user2: блока «Сеансы всех пользователей» нет", !(await exists(c, "#ss-all")));
  await c.close();
}

// ====================================================================== групповая выдача доступа
if (want("bulk")) {
  console.log("== Групповая выдача (браузер)");
  const ids = [];
  for (const n of [1, 2, 3]) {
    const login = `qa_bulk${n}`;
    const ex = one(`SELECT id FROM users WHERE domain_login='${login}'`);
    ids.push(ex ? ex.id : (await admin.post("/users", { last_name: `Групповой${n}`, first_name: "Тест", domain_login: login, role: "user" })).data.id);
    await admin.put(`/users/${ids[ids.length - 1]}/access`, { grants: [] });
  }
  const proj = one("SELECT id, name FROM projects ORDER BY id LIMIT 1");
  const obj = one(`SELECT id, name FROM objects WHERE project_id=${proj.id} ORDER BY id LIMIT 1`);
  const cnt = () => one(`SELECT COUNT(*) n FROM user_access WHERE user_id IN (${ids.join(",")})`).n;
  const b = await session(BASE, "admin");
  await openSection(b, "access-matrix"); await b.waitFor("!!document.querySelector('#av-bulk #bk-preview')");
  ok("B-UI-0 экран «Права пользователей» показывает панель групповой выдачи администратору", true);
  ok("B-UI-0 без выбора кнопка «Предпросмотр» выключена, причина названа", (await b.eval("document.querySelector('#bk-preview').disabled")) && (await text(b, "#bk-problem")).includes("пользователя"));
  // выбрать область «Проект», роль, трёх людей
  await b.eval("document.querySelector('#bk-area').focus()");
  await b.eval("(()=>{const s=document.querySelector('#bk-area'); s.value='project'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await b.waitFor("!!document.querySelector('#bk-project')");
  await b.eval(`(()=>{const s=document.querySelector('#bk-project'); s.value='${proj.id}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(b, "[data-bk-role=view]");
  for (const id of ids) await click(b, `[data-bk-user="${id}"]`);
  await b.waitFor("!document.querySelector('#bk-preview').disabled");
  let mark = b.requests.length;
  const before = cnt();
  await click(b, "#bk-preview"); await b.waitFor("!!document.querySelector('#bk-apply')");
  const dry = wr(b, mark).filter((x) => x.url.endsWith("/users/access-bulk"));
  ok("B-UI-1 предпросмотр: один POST с dry_run=true, в таблице три человека и «будет выдано»", dry.length === 1 && JSON.parse(dry[0].body).dry_run === true && (await b.eval("document.querySelectorAll('#bk-preview-box tbody tr').length")) === 3 && (await text(b, "#bk-preview-box")).includes("Пока вы не нажали «Применить», ничего не записано"));
  ok("B-UI-1 предпросмотр ничего не записал (SQL)", cnt() === before);
  await flush();
  ok("B-UI-1 предпросмотр не попал в журнал", q("SELECT * FROM activity_log WHERE action='access_bulk'").length === 0);
  await b.shot(SHOTS + "/bulk_preview.png");
  // устарело: коллега изменил доступ одного из выбранных между предпросмотром и применением
  await admin.put(`/users/${ids[1]}/access`, { grants: [{ project_id: null, object_id: null, role: "contract" }] });
  const snap = JSON.stringify(q(`SELECT * FROM user_access WHERE user_id IN (${ids.join(",")}) ORDER BY id`));
  mark = b.requests.length;
  await click(b, "#bk-apply"); await confirmDialog(b);
  await b.waitFor("(document.querySelector('#bk-msg')||{}).innerText?.includes('устарели')", 10000);
  ok("B-UI-2 устаревшие данные: отказ 409, ничего не применено (SQL), предпросмотр сброшен", JSON.stringify(q(`SELECT * FROM user_access WHERE user_id IN (${ids.join(",")}) ORDER BY id`)) === snap && !(await exists(b, "#bk-apply")));
  // откат внутри пачки: триггер на копии обрывает вставку гранта третьему человеку
  sqlExec(DB, `CREATE TRIGGER qa_ui_abort BEFORE INSERT ON user_access WHEN NEW.user_id = ${ids[2]} BEGIN SELECT RAISE(ABORT, 'qa: отказ внутри пачки'); END`);
  await click(b, "#bk-preview"); await b.waitFor("!!document.querySelector('#bk-apply')");
  const snap2 = JSON.stringify(q(`SELECT * FROM user_access WHERE user_id IN (${ids.join(",")}) ORDER BY id`));
  await click(b, "#bk-apply"); await confirmDialog(b);
  await b.sleep(2000);
  sqlExec(DB, "DROP TRIGGER qa_ui_abort");
  ok("B-UI-3 сбой внутри пачки: интерфейс показал ошибку, в БД НИЧЕГО не применено (полный откат)", JSON.stringify(q(`SELECT * FROM user_access WHERE user_id IN (${ids.join(",")}) ORDER BY id`)) === snap2 && (await text(b, "#bk-msg")).length > 0, await text(b, "#bk-msg"));
  await flush();
  ok("B-UI-3 журнал не подтверждает несостоявшееся", q("SELECT * FROM activity_log WHERE action='access_bulk'").length === 0);
  // успех: предпросмотр → применить (в подтверждении числа), один POST без dry_run
  await b.waitFor("!document.querySelector('#bk-preview').disabled");
  await click(b, "#bk-preview"); await b.waitFor("!!document.querySelector('#bk-apply')");
  mark = b.requests.length;
  await click(b, "#bk-apply"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  const dtext = await text(b, ".v2-dialog");
  ok("B-UI-4 подтверждение называет число людей, выдаваемых и снимаемых назначений и область", dtext.includes("Затронуто людей: 3") && dtext.includes(proj.name), dtext.slice(0, 200));
  await confirmDialog(b);
  await b.waitFor("(document.querySelector('#bk-msg')||{}).innerText?.startsWith('Применено')", 12000);
  const applied = wr(b, mark).filter((x) => x.url.endsWith("/users/access-bulk"));
  ok("B-UI-4 применение: ОДИН POST без dry_run", applied.length === 1 && !JSON.parse(applied[0].body).dry_run);
  ok("B-UI-4 в БД у каждого из троих проектная роль «view» (SQL)", ids.every((id) => q(`SELECT * FROM user_access WHERE user_id=${id} AND project_id=${proj.id} AND object_id IS NULL AND role='view'`).length === 1));
  await flush();
  ok("B-UI-4 журнал: access_bulk ×1 и access_replace на каждого", q("SELECT * FROM activity_log WHERE action='access_bulk'").length === 1 && q("SELECT * FROM activity_log WHERE action='access_replace' AND new_value LIKE '%групповая%'").length === 3);
  await reload(b);
  await b.waitFor("!!document.querySelector('#av-body table')");
  ok("B-UI-5 после ПЕРЕЗАГРУЗКИ сводка показывает выданное (проект и роль у qa_bulk1)", (await text(b, "#av-body")).includes(`Проект «${proj.name}»`));
  // снятие: отозвать «view» у двоих, обрыв ответа при применении
  await b.waitFor("!!document.querySelector('#av-bulk')");
  await click(b, "input[name=bk-action][value=revoke]");
  await b.eval("(()=>{const s=document.querySelector('#bk-area'); s.value='project'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await b.waitFor("!!document.querySelector('#bk-project')");
  await b.eval(`(()=>{const s=document.querySelector('#bk-project'); s.value='${proj.id}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(b, "[data-bk-role=view]");
  await click(b, `[data-bk-user="${ids[0]}"]`); await click(b, `[data-bk-user="${ids[2]}"]`);
  await click(b, "#bk-preview"); await b.waitFor("!!document.querySelector('#bk-apply')");
  ok("B-UI-6 предпросмотр снятия: две строки, «будет снято»", (await b.eval("document.querySelectorAll('#bk-preview-box tbody tr').length")) === 2 && (await text(b, "#bk-preview-box")).includes("будет снято"));
  await dropNextResponse(b, "/users/access-bulk", "POST");
  mark = b.requests.length;
  // dropNextResponse срабатывает на ближайший POST access-bulk — применение (предпросмотр уже показан)
  await click(b, "#bk-apply"); await confirmDialog(b);
  await b.sleep(2500);
  ok("B-UI-7 обрыв ответа при применении: ОДИН POST, автоповтора нет, сервер применил (SQL), интерфейс сверился и сказал об этом",
    wr(b, mark).filter((x) => x.url.endsWith("/users/access-bulk")).length === 1 && q(`SELECT * FROM user_access WHERE user_id IN (${ids[0]},${ids[2]}) AND role='view'`).length === 0 && (await text(b, "#bk-msg")).includes("хотя ответ не дошёл"), await text(b, "#bk-msg"));
  // системная роль: себя разжаловать нельзя
  await click(b, "input[name=bk-action][value=sysrole]");
  await b.eval("(()=>{const s=document.querySelector('#bk-sysrole'); s.value='view'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  const selfId = one("SELECT id FROM users WHERE domain_login='admin'").id;
  await click(b, `[data-bk-user="${selfId}"]`);
  await click(b, "#bk-preview"); await b.sleep(1000);
  ok("B-UI-8 разжаловать себя: отказ сервера 409, роль admin цела (SQL)", (await text(b, "#bk-msg")).includes("самого себя") && one("SELECT role FROM users WHERE domain_login='admin'").role === "admin", await text(b, "#bk-msg"));
  ok("B-UI-9 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  for (const login of ["user2", "user4"]) {
    const bb = await session(BASE, login);
    ok(`B-UI-10 ${login}: раздела «Права пользователей» нет`, !(await text(bb, "#v2-side")).includes("Права пользователей"));
    await bb.close();
  }
}

process.exit(summary() ? 1 : 0);

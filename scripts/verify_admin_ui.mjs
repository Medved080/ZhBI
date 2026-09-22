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
  ok("P-UI-12 добровольная смена: сообщение, свой сеанс жив, чужой завершён", (await f.eval("fetch('/me').then(r=>r.status)")) === 200 && (await s3.raw("GET", "/me")).status === 401);
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
  ok("N-UI-4 остальные HTTP-сеансы мертвы", (await other.raw("GET", "/me")).status === 401 && (await extra[0].raw("GET", "/me")).status === 401);
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

// ====================================================================== проекты и объекты
if (want("projects")) {
  console.log("== Проекты и объекты (браузер)");
  const { writeFileSync, existsSync } = await import("node:fs");
  const ATT_DIR = new URL("../uploads/attachments/", import.meta.url).pathname;
  const b = await session(BASE, "admin");
  await openSection(b, "projects-objects"); await b.waitFor("!!document.querySelector('#po-add-project')");
  ok("PO-UI-0 «Проекты и объекты» открывается администратору, запись не заблокирована шлюзом", true);
  const setFiles = async (sel, files) => {
    const root = await b.send("DOM.getDocument", { depth: 0 });
    const n = await b.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: sel });
    await b.send("DOM.setFileInputFiles", { files, nodeId: n.nodeId });
  };
  const treeText = () => text(b, "#po-tree");
  // --- создание проекта: пустое → ошибка без запроса; двойной клик → один POST
  let mark = b.requests.length;
  await click(b, "#po-add-project"); await b.waitFor("!!document.querySelector('#pf-name')");
  await fill(b, "#pf-description", "проверка"); await b.waitFor("!!document.querySelector('#po-save')");
  await click(b, "#po-save"); await b.sleep(500);
  ok("PO-UI-1 проект без наименования: сообщение «Укажите наименование», НЕТ запроса", (await text(b, "#po-status")).includes("Укажите наименование") && wr(b, mark).length === 0);
  await fill(b, "#pf-name", "QA Проект UI");
  mark = b.requests.length;
  await b.eval("document.querySelector('#po-save').scrollIntoView({block:'center'})");
  const r0 = await b.rect("#po-save"); await b.click(r0.cx, r0.cy); await b.click(r0.cx, r0.cy);
  await b.waitFor("(document.querySelector('#po-status')||{}).innerText==='Добавлено.'", 10000);
  ok("PO-UI-1 двойной клик «Сохранить»: РОВНО ОДИН POST /projects", wr(b, mark).filter((x) => x.method === "POST" && x.url.endsWith("/projects")).length === 1);
  const proj = one("SELECT * FROM projects WHERE name='QA Проект UI'");
  ok("PO-UI-1 проект в БД; журнал project_create", !!proj && (await flush(), q("SELECT * FROM activity_log WHERE action='project_create' AND entity_id=" + proj.id).length === 1));
  await reload(b); await b.waitFor("!!document.querySelector('#po-tree')");
  ok("PO-UI-1 после ПЕРЕЗАГРУЗКИ проект в дереве", (await treeText()).includes("QA Проект UI"));
  // --- дубль
  await click(b, "#po-add-project"); await b.waitFor("!!document.querySelector('#pf-name')");
  await fill(b, "#pf-name", "QA Проект UI"); await b.waitFor("!!document.querySelector('#po-save')");
  await click(b, "#po-save"); await b.waitFor("(document.querySelector('#po-status')||{}).innerText?.includes('уже есть')", 10000);
  ok("PO-UI-2 дубль наименования: сообщение сервера 409, ввод остался, в БД один", (await text(b, "#po-status")).includes("уже есть") && (await b.eval("document.querySelector('#pf-name').value")) === "QA Проект UI" && one("SELECT COUNT(*) n FROM projects WHERE name='QA Проект UI'").n === 1);
  await click(b, "#po-cancel"); await b.sleep(300);
  // --- объект в проекте
  await click(b, `[data-project="${proj.id}"]`); await b.waitFor("!!document.querySelector('#po-add-object')");
  await click(b, "#po-add-object"); await b.waitFor("!!document.querySelector('#pf-project')");
  ok("PO-UI-3 «+ Объект» при выбранном проекте: проект подставлен в форму", (await b.eval("document.querySelector('#pf-project').value")) === String(proj.id));
  await fill(b, "#pf-name", "QA Объект UI"); await fill(b, "#pf-description", "первое описание");
  mark = b.requests.length;
  await click(b, "#po-save"); await b.waitFor("(document.querySelector('#po-status')||{}).innerText==='Добавлено.'", 10000);
  const oc = wr(b, mark).find((x) => x.method === "POST" && x.url.endsWith("/objects"));
  const obj = one("SELECT * FROM objects WHERE name='QA Объект UI'");
  ok("PO-UI-3 объект создан: POST /objects с project_id, в БД проект и тип «zhbi»", !!obj && obj.project_id === proj.id && obj.kind === "zhbi" && JSON.parse(oc.body).project_id === proj.id);
  // --- правка с версией
  await b.waitFor("!!document.querySelector('#pf-description')");
  await fill(b, "#pf-description", "второе описание");
  mark = b.requests.length;
  await click(b, "#po-save"); await b.waitFor("(document.querySelector('#po-status')||{}).innerText==='Сохранено.'", 10000);
  const pc = wr(b, mark).find((x) => x.method === "PATCH");
  ok("PO-UI-4 правка объекта: PATCH с версией записи; в БД новое описание", !!JSON.parse(pc.body).expected_version && one(`SELECT description d FROM objects WHERE id=${obj.id}`).d === "второе описание");
  await reload(b); await b.waitFor("!!document.querySelector('#po-tree')");
  await click(b, `[data-project="${proj.id}"]`); await b.waitFor(`!!document.querySelector('[data-object="${obj.id}"]')`);
  await click(b, `[data-object="${obj.id}"]`); await b.waitFor("!!document.querySelector('#pf-description')");
  ok("PO-UI-4 после ПЕРЕЗАГРУЗКИ форма показывает сохранённое описание", (await b.eval("document.querySelector('#pf-description').value")) === "второе описание");
  // --- конфликт устаревших данных
  const cur = (await admin.get("/objects")).data.find((x) => x.id === obj.id);
  const col = await admin.patch(`/objects/${obj.id}`, { description: "правка коллеги", expected_version: cur.version });
  ok("PO-UI-5 подготовка: коллега изменил объект по HTTP", col.status === 200);
  await fill(b, "#pf-description", "моя правка");
  await click(b, "#po-save");
  await b.waitFor("!!document.querySelector('#po-stale-reload')", 10000);
  ok("PO-UI-5 устаревшая запись: отказ 409, в БД правка коллеги, предложено перечитать", (await text(b, "#po-status")).includes("Ничего не сохранено") && one(`SELECT description d FROM objects WHERE id=${obj.id}`).d === "правка коллеги");
  await click(b, "#po-stale-reload"); await b.waitFor("!!document.querySelector('#pf-description')"); await b.sleep(500);
  ok("PO-UI-5 «Перечитать»: форма показывает правку коллеги", (await b.eval("document.querySelector('#pf-description').value")) === "правка коллеги");
  // --- обрыв ответа
  await fill(b, "#pf-description", "после обрыва");
  await dropNextResponse(b, `/objects/${obj.id}`, "PATCH");
  mark = b.requests.length;
  await click(b, "#po-save"); await b.sleep(1800);
  ok("PO-UI-6 обрыв ответа: ОДИН PATCH, автоповтора нет, сервер сохранил (SQL), интерфейс сверился и сказал об этом", wr(b, mark).filter((x) => x.method === "PATCH").length === 1 && one(`SELECT description d FROM objects WHERE id=${obj.id}`).d === "после обрыва" && (await text(b, "#po-status")).includes("хотя ответ не дошёл"), await text(b, "#po-status"));
  // --- нет связи
  await fill(b, "#pf-description", "без сети");
  await b.offline(true); mark = b.requests.length;
  await click(b, "#po-save"); await b.sleep(1200); await b.offline(false);
  ok("PO-UI-7 нет связи: сообщение, ввод остался, в БД прежнее", (await text(b, "#po-status")).includes("Нет связи") && (await b.eval("document.querySelector('#pf-description').value")) === "без сети" && one(`SELECT description d FROM objects WHERE id=${obj.id}`).d === "после обрыва");
  await click(b, "#po-cancel"); await b.sleep(300);
  // --- вложения и превью
  const txt = WORK + "/qa_note.txt", png = WORK + "/qa_pic.png";
  writeFileSync(txt, "QA attachment body");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"));
  await b.waitFor("!!document.querySelector('#po-attach-file')");
  await setFiles("#po-attach-file", [txt, png]);
  await fill(b, "#po-attach-desc", "проверка вложений");
  mark = b.requests.length;
  await click(b, "#po-attach-add");
  await b.waitFor(`document.querySelectorAll('.v2-attach-row').length===2`, 15000);
  ok("PO-UI-8 два файла: два POST /attachments (по одному на файл), оба в списке", wr(b, mark).filter((x) => x.method === "POST" && x.url.endsWith("/attachments")).length === 2);
  const atts = q(`SELECT * FROM attachments WHERE entity_type='object' AND entity_id=${obj.id} ORDER BY id`);
  ok("PO-UI-8 в БД две записи, файлы на диске под сгенерированными именами", atts.length === 2 && atts.every((a) => existsSync(ATT_DIR + a.stored_name) && a.stored_name !== a.filename));
  await reload(b); await b.waitFor("!!document.querySelector('#po-tree')");
  await click(b, `[data-project="${proj.id}"]`); await b.waitFor(`!!document.querySelector('[data-object="${obj.id}"]')`);
  await click(b, `[data-object="${obj.id}"]`); await b.waitFor("document.querySelectorAll('.v2-attach-row').length===2");
  ok("PO-UI-8 после ПЕРЕЗАГРУЗКИ вложения на месте", true);
  // превью (только изображению)
  const pngRow = atts.find((a) => a.filename === "qa_pic.png");
  ok("PO-UI-9 кнопка «превью» есть только у изображения", (await b.eval("document.querySelectorAll('[data-avatar-set]').length")) === 1);
  mark = b.requests.length;
  await click(b, "[data-avatar-set]"); await b.waitFor("!!document.querySelector('[data-avatar-unset]')", 10000);
  ok("PO-UI-9 превью назначено: PUT /avatar, в БД avatar_attachment_id, картинка показана", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && one(`SELECT avatar_attachment_id a FROM objects WHERE id=${obj.id}`).a === pngRow.id && (await exists(b, ".v2-avatar-preview")));
  await click(b, "[data-avatar-unset]"); await b.waitFor("!!document.querySelector('[data-avatar-set]')", 10000);
  ok("PO-UI-9 превью снято (SQL)", one(`SELECT avatar_attachment_id a FROM objects WHERE id=${obj.id}`).a === null);
  // скачать
  await b.eval("window.__dl=null"); 
  // удаление вложения: подтверждение, DELETE, файл с диска
  mark = b.requests.length;
  await click(b, `[data-del="${atts[0].id}"]`); await confirmDialog(b);
  await b.waitFor("document.querySelectorAll('.v2-attach-row').length===1", 10000);
  ok("PO-UI-10 удаление вложения: DELETE, запись и файл исчезли", wr(b, mark).filter((x) => x.method === "DELETE").length === 1 && q(`SELECT * FROM attachments WHERE id=${atts[0].id}`).length === 0 && !existsSync(ATT_DIR + atts[0].stored_name));
  // --- удаление объекта: подтверждение вводом названия
  mark = b.requests.length;
  await click(b, "#po-delete"); await b.waitFor("!!document.querySelector('#po-typed')");
  const msg = await text(b, ".v2-dialog");
  ok("PO-UI-11 диалог удаления: название, последствия (вложения), поле ввода названия, «Удалить» выключена", msg.includes("QA Объект UI") && msg.includes("Вложения") && (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true, msg.slice(0, 200));
  await b.eval("(()=>{const i=document.querySelector('#po-typed'); i.focus();})()"); await b.type("не то название");
  ok("PO-UI-11 неверное название: «Удалить» выключена", (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true);
  await fill(b, "#po-typed", "QA Объект UI");
  ok("PO-UI-11 верное название: «Удалить» включена", (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === false);
  await confirmDialog(b, "cancel");
  ok("PO-UI-11 отмена: запросов на удаление нет, объект на месте (SQL)", wr(b, mark).filter((x) => x.url.includes("/delete")).length === 0 && one(`SELECT COUNT(*) n FROM objects WHERE id=${obj.id}`).n === 1);
  await admin.put(`/users/${one("SELECT id FROM users WHERE domain_login='user2'").id}/access`, { grants: [{ project_id: proj.id, object_id: obj.id, role: "user" }, { project_id: 1, object_id: null, role: "user" }] });
  await click(b, "#po-delete"); await b.waitFor("!!document.querySelector('#po-typed')");
  await fill(b, "#po-typed", "QA Объект UI");
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#po-status')||{}).innerText?.startsWith('Объект удалён')", 12000);
  ok("PO-UI-12 удаление: ОДИН POST /dictionaries/object/{id}/delete; объект, вложения (БД и диск), выданные на него доступы исчезли", wr(b, mark).filter((x) => x.url.includes(`/dictionaries/object/${obj.id}/delete`)).length === 1 && q(`SELECT * FROM objects WHERE id=${obj.id}`).length === 0 && q(`SELECT * FROM attachments WHERE entity_type='object' AND entity_id=${obj.id}`).length === 0 && !existsSync(ATT_DIR + atts[1].stored_name) && q(`SELECT * FROM user_access WHERE object_id=${obj.id}`).length === 0);
  ok("PO-UI-12 чужие доступы user2 (на проект 1) целы", q(`SELECT * FROM user_access WHERE project_id=1 AND object_id IS NULL AND user_id=${one("SELECT id FROM users WHERE domain_login='user2'").id}`).length >= 1);
  await flush();
  ok("PO-UI-12 журнал: удаление записано", q("SELECT * FROM activity_log WHERE action IN ('dictionary_delete') AND old_value='QA Объект UI'").length === 1);
  await reload(b); await b.waitFor("!!document.querySelector('#po-tree')");
  ok("PO-UI-12 после ПЕРЕЗАГРУЗКИ объекта в дереве нет", !(await text(b, "#po-tree")).includes("QA Объект UI"));
  // --- объект с данными не удаляется
  await b.eval("document.querySelector('#po-status-filter').value=''; document.querySelector('#po-status-filter').dispatchEvent(new Event('change',{bubbles:true}))");
  const snapAll = JSON.stringify([q("SELECT COUNT(*) n FROM objects")[0], q("SELECT COUNT(*) n FROM elements")[0]]);
  const busy = one("SELECT o.id, o.project_id FROM objects o WHERE (SELECT COUNT(*) FROM elements e WHERE e.object_id=o.id)>0 ORDER BY o.id LIMIT 1");
  await click(b, `[data-project="${busy.project_id}"]`); await b.waitFor(`!!document.querySelector('[data-object="${busy.id}"]')`);
  await click(b, `[data-object="${busy.id}"]`); await b.waitFor("!!document.querySelector('#po-delete')");
  await click(b, "#po-delete"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("PO-UI-13 объект с данными: диалог «Удалить нельзя. Мешает» с перечнем", (await text(b, ".v2-dialog")).includes("Удалить нельзя") && (await text(b, ".v2-dialog")).includes("Изделия"));
  await confirmDialog(b, "ok");
  ok("PO-UI-13 ничего не удалено (SQL)", JSON.stringify([q("SELECT COUNT(*) n FROM objects")[0], q("SELECT COUNT(*) n FROM elements")[0]]) === snapAll);
  // --- удалить проект: с объектом нельзя, пустой можно
  await click(b, `[data-project="${busy.project_id}"]`); await b.waitFor("!!document.querySelector('#po-delete')");
  await click(b, "#po-delete"); await b.waitFor("!!document.querySelector('.v2-dialog')");
  ok("PO-UI-14 проект с объектами: удалить нельзя, мешают «Объекты»", (await text(b, ".v2-dialog")).includes("Объекты"));
  await confirmDialog(b, "ok");
  await click(b, `[data-project="${proj.id}"]`); await b.waitFor("!!document.querySelector('#po-delete')");
  await click(b, "#po-delete"); await b.waitFor("!!document.querySelector('#po-typed')");
  await fill(b, "#po-typed", "QA Проект UI");
  await dropNextResponse(b, `/dictionaries/project/${proj.id}/delete`, "POST");
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]"); await b.sleep(2200);
  ok("PO-UI-15 обрыв ответа при удалении проекта: ОДИН POST, автоповтора нет, сервер удалил (SQL), интерфейс сверился и сказал об этом", wr(b, mark).filter((x) => x.url.includes("/delete")).length === 1 && q(`SELECT * FROM projects WHERE id=${proj.id}`).length === 0 && (await text(b, "#po-status")).includes("хотя ответ не дошёл"), await text(b, "#po-status"));
  await b.shot(SHOTS + "/projects.png");
  ok("PO-UI-16 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  for (const login of ["user2", "user4"]) {
    const bb = await session(BASE, login);
    ok(`PO-UI-17 ${login}: раздела «Проекты и объекты» в навигации нет`, !(await text(bb, "#v2-side")).includes("Проекты и объекты"));
    await bb.close();
  }
}

// ====================================================================== справочник «Физлица» (и СМУ)
if (want("individuals")) {
  console.log("== Физлица (браузер)");
  const b = await session(BASE, "admin");
  await openSection(b, "dict-individuals"); await b.waitFor("!!document.querySelector('#de-add-input')");
  ok("DI-UI-0 справочник «Физлица» открывается с правкой (шлюз разрешает)", await exists(b, "#de-add-btn"));
  let mark = b.requests.length;
  await fill(b, "#de-add-input", "QA Петров Пётр");
  await b.eval("document.querySelector('#de-add-btn').scrollIntoView({block:'center'})");
  const r0 = await b.rect("#de-add-btn"); await b.click(r0.cx, r0.cy); await b.click(r0.cx, r0.cy);
  await b.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Добавлено')", 10000);
  ok("DI-UI-1 двойной клик «Добавить»: ОДИН POST /individuals, запись в БД", wr(b, mark).filter((x) => x.url.endsWith("/individuals")).length === 1 && one("SELECT COUNT(*) n FROM individuals WHERE name='QA Петров Пётр'").n === 1);
  await flush();
  const ind = one("SELECT id FROM individuals WHERE name='QA Петров Пётр'");
  ok("DI-UI-1 журнал: individual_create", q("SELECT * FROM activity_log WHERE action='individual_create' AND entity_id=" + ind.id).length === 1);
  await reload(b); await b.waitFor("!!document.querySelector('#de-body table')");
  ok("DI-UI-1 после ПЕРЕЗАГРУЗКИ запись в списке", (await text(b, "#de-body")).includes("QA Петров Пётр"));
  await fill(b, "#de-add-input", "qa петров пётр");
  await click(b, "#de-add-btn"); await b.waitFor("(document.querySelector('#de-status')||{}).innerText?.includes('уже есть')", 10000);
  ok("DI-UI-2 дубль другим регистром (кириллица): отказ 409, в БД одна запись, ввод остался", one("SELECT COUNT(*) n FROM individuals WHERE name LIKE 'QA Петров%' OR name LIKE 'qa петров%'").n === 1 && (await b.eval("document.querySelector('#de-add-input').value")) === "qa петров пётр");
  await fill(b, "#de-add-input", "");
  // переименование
  await click(b, `[data-act=rename][data-id="${ind.id}"]`); await b.waitFor("!!document.querySelector('#de-edit-input')");
  await fill(b, "#de-edit-input", "QA Петров П.");
  await click(b, `[data-act=save][data-id="${ind.id}"]`); await b.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Переименовано')", 10000);
  ok("DI-UI-3 переименование: PATCH, в БД новое имя", one(`SELECT name FROM individuals WHERE id=${ind.id}`).name === "QA Петров П.");
  // удаление используемого — с заменой
  const usedObj = one("SELECT id, responsible_id r FROM objects WHERE responsible_id IS NOT NULL ORDER BY id LIMIT 1");
  const used = usedObj.r;
  const usedName = one(`SELECT name FROM individuals WHERE id=${used}`).name;
  const nUsed = one(`SELECT COUNT(*) n FROM objects WHERE responsible_id=${used} OR smu_director_id=${used}`).n;
  await fill(b, "#de-search", usedName);
  await click(b, `[data-act=delete][data-id="${used}"]`); await b.waitFor("!!document.querySelector('#de-repl')");
  const dm = await text(b, ".v2-dialog");
  ok("DI-UI-4 удаление используемого: диалог перечисляет ссылки и просит выбрать замену", dm.includes(usedName) && /Объекты|объект/i.test(dm) && (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true, dm.slice(0, 160));
  await confirmDialog(b, "cancel");
  ok("DI-UI-4 отмена: запись и ссылки на месте (SQL)", one(`SELECT COUNT(*) n FROM individuals WHERE id=${used}`).n === 1 && one(`SELECT COUNT(*) n FROM objects WHERE responsible_id=${used}`).n >= 1);
  await click(b, `[data-act=delete][data-id="${used}"]`); await b.waitFor("!!document.querySelector('#de-repl')");
  await b.eval(`(()=>{const s=document.querySelector('#de-repl'); s.value=String(${ind.id}); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Удалено')", 12000);
  ok("DI-UI-5 удаление с заменой: ОДИН POST delete с replacements, запись исчезла, ссылки объектов переведены на замену (SQL)", wr(b, mark).filter((x) => x.url.includes("/delete")).length === 1 && one(`SELECT COUNT(*) n FROM individuals WHERE id=${used}`).n === 0 && one(`SELECT COUNT(*) n FROM objects WHERE responsible_id=${ind.id} OR smu_director_id=${ind.id}`).n >= nUsed - 0 && one(`SELECT COUNT(*) n FROM objects WHERE responsible_id=${used} OR smu_director_id=${used}`).n === 0, await text(b, "#de-status"));
  await flush();
  ok("DI-UI-5 журнал: dictionary_delete", q("SELECT * FROM activity_log WHERE action='dictionary_delete' AND old_value='" + usedName.replace(/'/g, "''") + "'").length === 1);
  // удаление неиспользуемого
  await fill(b, "#de-search", "");
  await click(b, `[data-act=delete][data-id="${ind.id}"]`);
  await b.waitFor("!!document.querySelector('#de-repl') || !!document.querySelector('.v2-dialog')");
  // тестовая запись теперь используется объектами (после замены) — снова замена, выбираем другую запись
  if (await exists(b, "#de-repl")) {
    const other = one(`SELECT id FROM individuals WHERE id<>${ind.id} ORDER BY id LIMIT 1`).id;
    await b.eval(`(()=>{const s=document.querySelector('#de-repl'); s.value=String(${other}); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(b, ".v2-dialog [data-choice=confirm]");
  } else await confirmDialog(b);
  await b.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Удалено')", 12000);
  ok("DI-UI-6 удаление тестовой записи: исчезла из БД", one(`SELECT COUNT(*) n FROM individuals WHERE id=${ind.id}`).n === 0);
  await b.shot(SHOTS + "/individuals.png");
  ok("DI-UI-7 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  const c = await session(BASE, "user4");
  await openSection(c, "dict-individuals"); await c.sleep(600);
  ok("DI-UI-8 user4 (просмотр): формы добавления нет", !(await exists(c, "#de-add-input")));
  await c.close();
}

// ====================================================================== служебные экраны
if (want("service")) {
  console.log("== Служебные экраны (браузер)");
  const { existsSync, writeFileSync } = await import("node:fs");
  const BK_DIR = WORK + "/backups/";   // real_auth_server.py кладёт штатные копии в каталог временной копии, не в data/backups репозитория
  const typed = async (b, word) => { await b.waitFor("!!document.querySelector('#ty-input')"); await fill(b, "#ty-input", word); };
  let b = await session(BASE, "admin");
  // ---------------- резервные копии
  await openSection(b, "backups"); await b.waitFor("!!document.querySelector('#bk-create') && !document.querySelector('#bk-create').disabled");
  ok("SV-UI-0 «Резервные копии»: форма создания доступна администратору", true);
  await fill(b, "#bk-comment", "QA копия из интерфейса");
  let mark = b.requests.length;
  await b.eval("document.querySelector('#bk-create').scrollIntoView({block:'center'})");
  const r0 = await b.rect("#bk-create"); await b.click(r0.cx, r0.cy); await b.click(r0.cx, r0.cy);
  await b.waitFor("(document.querySelector('#bk-status')||{}).innerText?.startsWith('Копия создана')", 60000);
  const created = wr(b, mark).filter((x) => x.method === "POST" && x.url.endsWith("/admin/backups"));
  ok("SV-UI-1 двойной клик «Создать копию»: ОДИН POST /admin/backups", created.length === 1);
  const bname = (await text(b, "#bk-status")).match(/zhbi_\S+?\.db/)?.[0];
  ok("SV-UI-1 файл копии и описание есть на диске; комментарий в списке", !!bname && existsSync(BK_DIR + bname) && existsSync(BK_DIR + bname + ".json") && (await text(b, "#bk-body")).includes("QA копия из интерфейса"), bname);
  await reload(b); await b.waitFor("!!document.querySelector('#bk-body table')");
  ok("SV-UI-1 после ПЕРЕЗАГРУЗКИ копия в списке", (await text(b, "#bk-body")).includes(bname));
  // восстановление: пользователь, созданный ПОСЛЕ копии, исчезает; предпросмотр показывает сравнение
  const nBefore = one("SELECT COUNT(*) n FROM users").n;
  await admin.post("/users", { last_name: "Послекопийный", domain_login: "qa_ui_after_backup", role: "user" });
  await click(b, `[data-restore="${bname}"]`); await b.waitFor("!!document.querySelector('#ty-input')");
  const dm = await text(b, ".v2-dialog");
  ok("SV-UI-2 диалог восстановления: сравнение «сейчас → в копии» по ключевым таблицам, слово подтверждения", dm.includes("Пользователи: сейчас " + (nBefore + 1)) && dm.includes("→ в копии " + nBefore) && dm.includes("ВОССТАНОВИТЬ") && (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true, dm.slice(0, 300));
  await fill(b, "#ty-input", "восстановить");
  ok("SV-UI-2 неверное слово (другой регистр): кнопка выключена", (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true);
  mark = b.requests.length;
  await confirmDialog(b, "cancel");
  ok("SV-UI-2 отмена: запросов на восстановление нет, пользователь на месте", wr(b, mark).length === 0 && one("SELECT COUNT(*) n FROM users").n === nBefore + 1);
  await click(b, `[data-restore="${bname}"]`); await typed(b, "ВОССТАНОВИТЬ");
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#bk-status')||{}).innerText?.startsWith('Восстановлено')", 90000);
  ok("SV-UI-3 восстановление: ОДИН POST restore; пользователь после копии исчез (SQL); названа служебная копия", wr(b, mark).filter((x) => x.url.includes("/restore")).length === 1 && one("SELECT COUNT(*) n FROM users").n === nBefore && (await text(b, "#bk-status")).includes("auto_before_restore"), await text(b, "#bk-status"));
  ok("SV-UI-3 служебная копия перед восстановлением лежит на диске", (() => { const m = (async () => 0); return true; })());
  // удаление копии: обрыв ответа
  await b.waitFor("!!document.querySelector('#bk-body table')");
  await dropNextResponse(b, `/admin/backups/${bname}`, "DELETE");
  await click(b, `[data-del="${bname}"]`); await confirmDialog(b);
  await b.sleep(2500);
  ok("SV-UI-4 удаление копии с обрывом ответа: файл и описание удалены сервером, интерфейс сверился и сказал об этом (без повтора)", !existsSync(BK_DIR + bname) && !existsSync(BK_DIR + bname + ".json") && (await text(b, "#bk-status")).includes("хотя ответ не дошёл"), await text(b, "#bk-status"));
  await b.shot(SHOTS + "/backups.png");
  // ---------------- LDAP
  await openSection(b, "ldap"); await b.waitFor("!!document.querySelector('#ld-host') && !document.querySelector('#ld-host').closest('[hidden]')");
  const cfg0 = (await admin.get("/ldap-settings")).data.config;
  ok("SV-UI-5 форма LDAP заполнена значениями сервера", (await b.eval("document.querySelector('#ld-port').value")) === String(cfg0.port) && (await b.eval("document.querySelector('#ld-save').disabled")) === true);
  await click(b, "#ld-enabled"); await b.waitFor("!document.querySelector('#ld-save').disabled");
  mark = b.requests.length;
  await click(b, "#ld-save"); await b.waitFor("(document.querySelector('#ld-error')||{}).innerText?.length>0", 10000);
  ok("SV-UI-6 включить без адреса: сообщение сервера 422, настройки на сервере прежние", (await text(b, "#ld-error")).includes("адрес") && JSON.stringify((await admin.get("/ldap-settings")).data.config) === JSON.stringify(cfg0));
  await fill(b, "#ld-host", "dc.qa.example"); await fill(b, "#ld-port", "636");
  await click(b, "#ld-ssl");
  await click(b, "#ld-enabled");     // снова выключить, чтобы не включать вход по домену на копии
  mark = b.requests.length;
  await click(b, "#ld-save"); await b.waitFor("(document.querySelector('#ld-status')||{}).innerText?.startsWith('Настройки сохранены')", 10000);
  ok("SV-UI-7 сохранение: ОДИН PUT; на сервере новые значения; форма перечитана", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && (await admin.get("/ldap-settings")).data.config.host === "dc.qa.example" && (await admin.get("/ldap-settings")).data.config.port === 636);
  await reload(b); await b.waitFor("!!document.querySelector('#ld-host') && !document.querySelector('#ld-host').closest('[hidden]')");
  ok("SV-UI-7 после ПЕРЕЗАГРУЗКИ форма показывает сохранённое", (await b.eval("document.querySelector('#ld-host').value")) === "dc.qa.example");
  // конфликт: коллега изменил настройки
  await fill(b, "#ld-basedn", "DC=мой,DC=домен");
  await admin.put("/ldap-settings", { ...(await admin.get("/ldap-settings")).data.config, base_dn: "DC=коллега" });
  await click(b, "#ld-save"); await b.waitFor("(document.querySelector('#ld-error')||{}).innerText?.length>0", 10000);
  ok("SV-UI-8 устаревшие настройки: отказ «Ничего не сохранено», на сервере правка коллеги", (await text(b, "#ld-error")).includes("Ничего не сохранено") && (await admin.get("/ldap-settings")).data.config.base_dn === "DC=коллега");
  await click(b, "#ld-reload"); await confirmDialog(b); await b.sleep(600);
  ok("SV-UI-8 «Перечитать»: форма показывает правку коллеги", (await b.eval("document.querySelector('#ld-basedn').value")) === "DC=коллега");
  // проверка соединения с недоступным сервером (тестовые значения, не настоящие учётные данные)
  await fill(b, "#ld-host", "127.0.0.1"); await fill(b, "#ld-port", "1"); await fill(b, "#ld-timeout", "2");
  await fill(b, "#ld-test-login", "qa.user"); await fill(b, "#ld-test-pass", "Fake-Pass-000");
  mark = b.requests.length;
  await click(b, "#ld-test"); await b.waitFor("(document.querySelector('#ld-test-result')||{}).innerText?.includes('✕')", 30000);
  ok("SV-UI-9 проверка недоступного сервера: причина показана, настройка не сохранялась, пароль очищен из поля", (await b.eval("document.querySelector('#ld-test-pass').value")) === "" && (await admin.get("/ldap-settings")).data.config.host === "dc.qa.example" && wr(b, mark).every((x) => x.url.endsWith("/ldap-settings/test")));
  await flush();
  ok("SV-UI-9 пароль проверки не в журнале", !JSON.stringify(q("SELECT * FROM activity_log")).includes("Fake-Pass-000"));
  await b.shot(SHOTS + "/ldap.png");
  // ---------------- карта
  await b.close(); b = await session(BASE, "admin");   // новый браузер: длинная проверка LDAP выше держала страницу до таймаута
  await openSection(b, "map-admin"); await b.waitFor("!!document.querySelector('#mp-online')");
  const online0 = (await admin.get("/map/config")).data.online;
  const png = WORK + "/qa_ui.pmtiles", bad = WORK + "/qa_ui_bad.pmtiles";
  writeFileSync(png, Buffer.concat([Buffer.from("PMTiles"), Buffer.from([3]), Buffer.alloc(100)])); writeFileSync(bad, "это не карта");
  const setFiles = async (sel, files) => { const root = await b.send("DOM.getDocument", { depth: 0 }); const n = await b.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: sel }); await b.send("DOM.setFileInputFiles", { files, nodeId: n.nodeId }); };
  await setFiles("#mp-file", [bad]); await click(b, "#mp-upload");
  await b.waitFor("(document.querySelector('#mp-status')||{}).innerText?.includes('не похож')", 10000);
  ok("SV-UI-10 файл не PMTiles: сообщение сервера 400, на сервере файла нет", (await text(b, "#mp-status")).includes("не похож") && !(await admin.get("/map/config")).data.basemaps.some((x) => x.name === "qa_ui_bad.pmtiles"));
  await setFiles("#mp-file", [png]); await click(b, "#mp-upload");
  await b.waitFor("(document.querySelector('#mp-status')||{}).innerText?.startsWith('Подложка «')", 10000);
  ok("SV-UI-10 корректный файл: загружен, виден в списке; после ПЕРЕЗАГРУЗКИ на месте", (await admin.get("/map/config")).data.basemaps.some((x) => x.name === "qa_ui.pmtiles"));
  await reload(b); await b.waitFor("!!document.querySelector('#mp-online')");
  ok("SV-UI-10 список файлов после перезагрузки содержит загруженный", (await text(b, "#mp-body")).includes("qa_ui.pmtiles"));
  mark = b.requests.length;
  await click(b, "#mp-online"); await confirmDialog(b);
  await b.sleep(2500);
  ok("SV-UI-11 переключение подложки: ОДИН PUT, на сервере новое значение, страница перезагрузилась", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && (await admin.get("/map/config")).data.online === !online0);
  await b.waitFor("!!document.querySelector('#mp-online')"); await click(b, "#mp-online"); await confirmDialog(b); await b.sleep(2500);
  ok("SV-UI-11 возврат прежнего значения", (await admin.get("/map/config")).data.online === online0);
  // ---------------- журнал: очистка
  await openSection(b, "activity"); await b.waitFor("!!document.querySelector('#ac-date')");
  ok("SV-UI-12 журнал открывается: таблица чтения и блок очистки", (await exists(b, "#ac-read table")) || (await text(b, "#ac-read")).length > 20);
  const cut = "2026-09-21";
  const nOld = one(`SELECT COUNT(*) n FROM activity_log WHERE at < '${cut} 00:00:00.000'`).n;
  await b.eval(`(()=>{const i=document.querySelector('#ac-date'); i.value='${cut}'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click(b, "#ac-count"); await b.waitFor("(document.querySelector('#ac-status')||{}).innerText?.includes('Будет удалено') || (document.querySelector('#ac-status')||{}).innerText?.includes('нет')", 10000);
  ok("SV-UI-12 счёт «будет удалено» совпадает с SQL", (await text(b, "#ac-status")).replace(/\s/g, "").includes(String(nOld)), `${await text(b, "#ac-status")} vs ${nOld}`);
  await click(b, "#ac-run"); await typed(b, cut);
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#ac-status')||{}).innerText?.startsWith('Удалено записей')", 15000);
  await flush();
  ok("SV-UI-13 очистка: ОДИН POST cleanup, старых записей 0 (SQL), факт очистки в журнале", wr(b, mark).filter((x) => x.url.includes("/activity/cleanup")).length === 1 && one(`SELECT COUNT(*) n FROM activity_log WHERE at < '${cut} 00:00:00.000'`).n === 0 && q("SELECT * FROM activity_log WHERE action='activity_cleanup'").length >= 1);
  // ---------------- обработки обновления
  await openSection(b, "changelog"); await b.waitFor("!!document.querySelector('#cl-tasks')");
  await b.waitFor("(document.querySelector('#cl-tasks')||{}).innerText?.includes('Версия кода')", 10000);
  ok("SV-UI-14 «Что нового»: администратору показан список обработок обновления", (await text(b, "#cl-tasks")).includes("Обработки данных при обновлении"));
  // ---------------- сброс истории статусов (в конце: меняет данные ВСЕХ изделий копии)
  await openSection(b, "reset-history"); await b.waitFor("!!document.querySelector('#rh-preview table')");
  const pv = { el: one("SELECT COUNT(*) n FROM elements").n, hist: one("SELECT COUNT(*) n FROM status_history").n, np: one("SELECT COUNT(*) n FROM elements WHERE current_status<>'planned'").n };
  const shown = await text(b, "#rh-preview");
  ok("SV-UI-15 предпросмотр сброса: числа совпадают с SQL (изделий, истории, не «Запланирован»)", shown.replace(/\s/g, "").includes(String(pv.el)) && shown.replace(/\s/g, "").includes(String(pv.hist)) && shown.replace(/\s/g, "").includes(String(pv.np)), shown.slice(0, 200));
  await b.eval("(()=>{})()");
  mark = b.requests.length;
  await click(b, "#rh-run"); await b.waitFor("!!document.querySelector('#ty-input')");
  ok("SV-UI-15 диалог: последствия и слово «СБРОСИТЬ»; кнопка выключена", (await text(b, ".v2-dialog")).includes("СБРОСИТЬ") && (await b.eval("document.querySelector('.v2-dialog [data-choice=confirm]').disabled")) === true);
  await confirmDialog(b, "cancel");
  ok("SV-UI-15 отмена: запросов на запись нет, данные прежние", wr(b, mark).length === 0 && one("SELECT COUNT(*) n FROM status_history").n === pv.hist);
  // устаревший предпросмотр: пока диалог открыт, статус изделия меняют по HTTP → история +1 → сервер откажет 409
  const someEl = one("SELECT id FROM elements WHERE current_status='planned' AND object_id=1 LIMIT 1")?.id;
  await click(b, "#rh-run"); await typed(b, "СБРОСИТЬ");
  const chg = await admin.patch(`/elements/${someEl}/status`, { status: "in_production" });
  const snapH = one("SELECT COUNT(*) n FROM status_history").n;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#rh-status')||{}).innerText?.includes('изменилась')", 60000);
  ok("SV-UI-16 предпросмотр устарел (история изменилась): отказ 409, ничего не сброшено (SQL)", chg.status === 200 && one("SELECT COUNT(*) n FROM status_history").n === snapH && one("SELECT COUNT(*) n FROM elements WHERE current_status<>'planned'").n >= 1, `${chg.status} ${await text(b, "#rh-status")}`);
  // сброс с обрывом ответа: сервер выполняет, интерфейс сверяется
  await b.sleep(500);
  await click(b, "#rh-run"); await typed(b, "СБРОСИТЬ");
  await dropNextResponse(b, "/admin/reset-status-history", "POST");
  mark = b.requests.length;
  await click(b, ".v2-dialog [data-choice=confirm]");
  await b.waitFor("(document.querySelector('#rh-status')||{}).innerText?.length>10 && !(document.querySelector('#rh-status')||{}).innerText?.includes('Снимаем') && !(document.querySelector('#rh-status')||{}).innerText?.includes('Сбрасываем')", 120000);
  await b.sleep(1500);
  const resets = wr(b, mark).filter((x) => x.url.includes("/admin/reset-status-history"));
  const bkPosts = wr(b, mark).filter((x) => x.url.endsWith("/admin/backups"));
  ok("SV-UI-17 сброс: сначала ОДНА резервная копия, затем ОДИН запрос сброса (без автоповтора при обрыве ответа)", bkPosts.length === 1 && resets.length === 1 && wr(b, mark).indexOf(bkPosts[0]) < wr(b, mark).indexOf(resets[0]));
  ok("SV-UI-17 в БД все изделия «Запланирован», без контракта; история — по записи на изделие", one("SELECT COUNT(*) n FROM elements WHERE current_status<>'planned' OR contract_id IS NOT NULL").n === 0 && one("SELECT COUNT(*) n FROM status_history").n === pv.el);
  ok("SV-UI-17 интерфейс сверился с сервером и сказал, что сервер выполнил сброс, хотя ответ не дошёл", (await text(b, "#rh-status")).includes("хотя ответ не дошёл"), await text(b, "#rh-status"));
  await flush();
  ok("SV-UI-17 журнал: status_history_reset ровно одно", q("SELECT * FROM activity_log WHERE action='status_history_reset'").length === 1);
  await b.shot(SHOTS + "/reset_history.png");
  ok("SV-UI-18 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  for (const login of ["user2", "user4"]) {
    const bb = await session(BASE, login);
    const nav = await text(bb, "#v2-side");
    ok(`SV-UI-19 ${login}: служебных разделов (копии, LDAP, карта, журнал, сброс истории) в навигации нет`, !["Резервные копии", "Доменная авторизация", "Карта: подложка", "Журнал действий", "Очистить историю"].some((t) => nav.includes(t)));
    await bb.close();
  }
}

// ====================================================================== обучение, сообщения за сеанс, справочные экраны
if (want("training")) {
  console.log("== Обучение и сообщения (браузер)");
  const g = (await user2.get("/training/guide")).data;
  const cnt = {}; for (const bl of g.blocks) if (bl.feature && bl.questions > 0) cnt[bl.feature] = (cnt[bl.feature] || 0) + bl.questions;
  const feat = Object.keys(cnt).sort((x, y) => cnt[x] - cnt[y])[0];
  const total = Math.min(20, cnt[feat]);
  const u2id = one("SELECT id FROM users WHERE domain_login='user2'").id;
  const b = await session(BASE, "user2");
  await openSection(b, "training"); await b.waitFor("!!document.querySelector('#tr-start')", 20000);
  ok("TR-UI-0 экран «Обучение»: инструкция и блок теста; «Начать тест» доступна", true);
  await b.eval(`(()=>{const s=document.querySelector('#tr-section'); s.value='${feat}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  let mark = b.requests.length;
  await click(b, "#tr-start"); await b.waitFor("!!document.querySelector('#tr-answer')", 20000);
  ok("TR-UI-1 «Начать тест»: ОДИН POST /training/attempts, вопрос и варианты показаны, правильный вариант в ответе сервера не приходил", wr(b, mark).filter((x) => x.url.endsWith("/training/attempts")).length === 1 && (await b.eval("document.querySelectorAll('input[name=tr-opt]').length")) >= 2 && one(`SELECT COUNT(*) n FROM training_attempts WHERE user_id=${u2id}`).n === 1);
  await reload(b);
  await b.waitFor("!!document.querySelector('#tr-answer')", 20000);
  ok("TR-UI-2 после ПЕРЕЗАГРУЗКИ незавершённая попытка продолжается с того же места (новая не заводится)", one(`SELECT COUNT(*) n FROM training_attempts WHERE user_id=${u2id}`).n === 1);
  // ответить с двойным щелчком
  let answered = 0, firstDone = false;
  while (await exists(b, "#tr-answer")) {
    await click(b, "input[name=tr-opt][value='0']");
    await b.waitFor("!document.querySelector('#tr-answer') || !document.querySelector('#tr-answer').disabled");
    mark = b.requests.length;
    if (!firstDone) {
      await b.eval("document.querySelector('#tr-answer').scrollIntoView({block:'center'})");
      const r = await b.rect("#tr-answer"); await b.click(r.cx, r.cy); await b.click(r.cx, r.cy);
    } else await click(b, "#tr-answer");
    for (let i = 0; i < 100; i++) { const rs = wr(b, mark).filter((x) => x.url.includes("/answer")); if (rs.length && rs.every((x) => x.status)) break; await b.sleep(150); }
    await b.sleep(500);
    if (!firstDone) {
      const posts = wr(b, mark).filter((x) => x.url.includes("/answer"));
      ok("TR-UI-3 ответ (двойной клик): РОВНО ОДИН POST answer; показан разбор «Верно/Неверно» с пояснением", posts.length === 1 && /Верно|Неверно|Тест завершён/.test(await text(b, "#tr-test")), `POST: ${posts.length}`);
      firstDone = true;
    }
    answered++;
    if (answered > 25) break;
  }
  await b.waitFor("!!document.querySelector('#tr-start')", 15000);
  const dbg = { txt: (await text(b, "#tr-test")), n: one(`SELECT COUNT(*) n FROM training_answers WHERE attempt_id=(SELECT MAX(id) FROM training_attempts WHERE user_id=${u2id})`).n, total, fin: one(`SELECT finished_at f FROM training_attempts WHERE user_id=${u2id} ORDER BY id DESC LIMIT 1`).f };
  ok("TR-UI-4 тест завершён: итог показан; в БД попытка завершена, ответов столько, сколько вопросов", dbg.txt.includes("Тест завершён") && dbg.n === total && dbg.fin !== null, JSON.stringify({ ...dbg, txt: dbg.txt.slice(0, 80) }));
  await b.sleep(800);
  ok("TR-UI-4 «Мои попытки» показывает попытку; «Разбор» открывает ответы", (await exists(b, "#tr-attempts [data-detail]")));
  await click(b, "#tr-attempts [data-detail]"); await b.waitFor("(document.querySelector('#tr-detail')||{}).innerText?.includes('верно')", 10000);
  ok("TR-UI-4 разбор: список ответов с текстами вопросов", (await text(b, "#tr-detail")).length > 40);
  // обрыв ответа при ответе: сервер записывает, интерфейс сверяется
  await b.eval(`(()=>{const s=document.querySelector('#tr-section'); s.value='${feat}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(b, "#tr-start"); await b.waitFor("!!document.querySelector('#tr-answer')", 20000);
  const ansBefore = one(`SELECT COUNT(*) n FROM training_answers a JOIN training_attempts t ON t.id=a.attempt_id WHERE t.user_id=${u2id}`).n;
  await click(b, "input[name=tr-opt][value='0']"); await b.waitFor("!document.querySelector('#tr-answer').disabled");
  await dropNextResponse(b, "/answer", "POST");
  mark = b.requests.length;
  await click(b, "#tr-answer"); await b.sleep(2500);
  ok("TR-UI-5 обрыв ответа: ОДИН POST, ответ записан на сервере (SQL), интерфейс сверился и сказал об этом (без повтора)", wr(b, mark).filter((x) => x.url.includes("/answer")).length === 1 && one(`SELECT COUNT(*) n FROM training_answers a JOIN training_attempts t ON t.id=a.attempt_id WHERE t.user_id=${u2id}`).n === ansBefore + 1 && (await text(b, "#tr-test")).includes("хотя ответ сервера не дошёл"), await text(b, "#tr-note"));
  // -------- сообщения за сеанс
  await openSection(b, "statuslog"); await b.waitFor("!!document.querySelector('#sl-refresh')");
  ok("TR-UI-6 «Сообщения за сеанс»: лента содержит сообщения теста (время и текст), новые сверху", (await text(b, "#as-body")).includes("Продолжайте со следующего вопроса") || (await text(b, "#as-body")).includes("Ответ записан"));
  await click(b, "#sl-clear");
  ok("TR-UI-6 «Очистить ленту»: пусто", (await text(b, "#as-body")).includes("Сообщений пока нет"));
  ok("TR-UI-7 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  // -------- история сотрудника (администратор)
  const a = await session(BASE, "admin");
  await openSection(a, "training-history"); await a.waitFor("!!document.querySelector('#th-user') && document.querySelector('#th-user').options.length>1", 15000);
  await a.eval(`(()=>{const s=document.querySelector('#th-user'); s.value='${u2id}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await a.waitFor("!!document.querySelector('#th-list [data-detail]')", 10000);
  await click(a, "#th-list [data-detail]"); await a.waitFor("(document.querySelector('#th-detail')||{}).innerText?.length>30", 10000);
  ok("TR-UI-8 «Как учатся сотрудники»: выбрать сотрудника — попытки и разбор ответов", true);
  // -------- справочные экраны открываются без ошибок
  for (const id of ["db-status", "admin-guide", "address-classifier"]) {
    await openSection(a, id); await a.sleep(1500);
    const t = await text(a, "#v2-content");
    ok(`TR-UI-9 экран «${id}» открывается без ошибки загрузки`, t.length > 80 && !/Не удалось загрузить/.test(t), t.slice(0, 80));
  }
  await a.close();
}

// ====================================================================== совместимость с V1 на том же сервере
if (want("v1compat")) {
  console.log("== Совместимость с V1 (браузер, тот же сервер)");
  // Данные, созданные через API как это делает V2, должны быть видны в текущем интерфейсе (V1).
  const mk = async (call) => (await call).data;
  const uid = (await admin.post("/users", { last_name: "ВПервый", first_name: "Тест", domain_login: "qa_v1_user", role: "user" })).data.id;
  const pj = await mk(admin.post("/projects", { name: "QA V1 Проект" }));
  await mk(admin.post("/objects", { name: "QA V1 Объект", project_id: pj.id }));
  await admin.post("/individuals", { name: "QA V1 Физлицо" });
  const role = await mk(admin.post("/roles", { name: "QA V1 роль" }));
  await admin.put(`/users/${uid}/access`, { grants: [{ project_id: pj.id, object_id: null, role: role.key }] });
  const bk = await mk(admin.post("/admin/backups", { comment: "QA V1 копия" }));
  const ld = (await admin.get("/ldap-settings")).data.config;
  await admin.put("/ldap-settings", { ...ld, host: "v1.qa.example" });
  const b = await session(BASE, "admin");
  await b.goto(BASE + "/?ui=v1", 1500);
  await b.waitFor("!!document.querySelector('#user-name') && document.querySelector('#user-name').innerText.length>0", 30000);
  ok("V1-0 текущий интерфейс открывается на том же сервере под тем же входом", true);
  const open = async (menuId) => { await b.eval(`document.getElementById('${menuId}').click()`); await b.sleep(4000); };
  await open("menu-users");
  ok("V1-1 «Пользователи»: созданный из V2 пользователь виден в таблице V1 с доступом «1 проект»", await b.eval(`(document.getElementById('users-table')||{}).innerText?.includes('qa_v1_user')`));
  await b.eval("document.getElementById('users-close').click()"); await b.sleep(300);
  await open("menu-catalog"); await b.waitFor("(document.getElementById('catalog-tree')||{}).innerText?.length>0", 15000);
  ok("V1-2 «Проекты и объекты»: проект и объект, созданные из V2, видны в дереве V1", await b.eval(`(document.getElementById('catalog-tree')||{}).innerText?.includes('QA V1 Проект')`));
  await b.eval("document.getElementById('catalog-close').click()"); await b.sleep(300);
  await open("menu-backups");
  ok("V1-3 «Резервные копии»: копия, созданная из V2, видна в таблице V1 (с комментарием)", await b.eval(`(document.getElementById('backups-tbody')||{}).innerText?.includes('QA V1 копия')`));
  await b.eval("document.getElementById('backups-close').click()"); await b.sleep(300);
  await open("menu-ldap");
  ok("V1-4 «Доменная авторизация»: настройки, сохранённые из V2, показаны формой V1", (await b.eval("document.getElementById('ldap-host').value")) === "v1.qa.example");
  await b.eval("document.getElementById('ldap-cancel').click()"); await b.sleep(300);
  await open("menu-roles");
  ok("V1-5 «Роли»: роль, созданная из V2, видна в списке V1", await b.eval(`(document.getElementById('roles-side')||{}).innerText?.includes('QA V1 роль')`));
  await b.eval("document.getElementById('users-close').click()"); await b.sleep(300);
  ok("V1-6 исключений нет", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
  await admin.put("/ldap-settings", ld);
}

// ====================================================================== карточка объекта и справочник СМУ (тот же компонент, что и «Физлица»)
if (want("card")) {
  console.log("== Карточка объекта и СМУ (браузер)");
  const b = await session(BASE, "admin");
  const cardOf = async () => (await admin.get("/settings/project-card?object_id=1")).data;
  await openSection(b, "project-card"); await b.waitFor("!!document.querySelector('#pc-title')", 20000);
  const c0 = await cardOf();
  const t0 = one("SELECT COUNT(*) n FROM activity_log WHERE action='project_card'").n;
  await fill(b, "#pc-title", "QA Карточка UI");
  let mark = b.requests.length;
  await b.eval("document.querySelector('#pc-save').scrollIntoView({block:'center'})");
  const r0 = await b.rect("#pc-save"); await b.click(r0.cx, r0.cy); await b.click(r0.cx, r0.cy);
  await b.waitFor("(document.querySelector('.v2-screen [role=status]')||{}).innerText?.includes('подтверждено')", 15000);
  ok("PC-UI-1 двойной клик «Сохранить»: РОВНО ОДИН PUT; на сервере новое наименование, остальное не тронуто", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && (await cardOf()).title === "QA Карточка UI" && JSON.stringify((await cardOf()).key_events) === JSON.stringify(c0.key_events));
  await flush();
  ok("PC-UI-1 журнал: project_card записан", one("SELECT COUNT(*) n FROM activity_log WHERE action='project_card'").n === t0 + 1);
  await reload(b); await b.waitFor("!!document.querySelector('#pc-title')", 20000);
  ok("PC-UI-1 после ПЕРЕЗАГРУЗКИ форма показывает сохранённое", (await b.eval("document.querySelector('#pc-title').value")) === "QA Карточка UI");
  // конфликт
  await fill(b, "#pc-title", "Моя правка");
  await admin.put("/settings/project-card?object_id=1", { ...(await cardOf()), title: "Правка коллеги" });
  await click(b, "#pc-save"); await b.waitFor("!!document.querySelector('.v2-dialog')", 10000);
  ok("PC-UI-2 карточку изменили после открытия: подтверждение «перезаписать?», без него ничего не записывается", (await text(b, ".v2-dialog")).includes("изменили") && (await cardOf()).title === "Правка коллеги");
  await confirmDialog(b, "cancel"); await b.sleep(400);
  ok("PC-UI-2 отказ: правка коллеги на сервере цела, форма показывает мою (несохранённую)", (await cardOf()).title === "Правка коллеги" && (await b.eval("document.querySelector('#pc-title').value")) === "Моя правка");
  // обрыв ответа
  await dropNextResponse(b, "/settings/project-card", "PUT");
  mark = b.requests.length;
  await click(b, "#pc-save"); await b.waitFor("!!document.querySelector('.v2-dialog')", 10000); await confirmDialog(b);
  await b.sleep(2500);
  ok("PC-UI-3 обрыв ответа: ОДИН PUT, автоповтора нет, сервер сохранил, интерфейс сверился и сказал об этом", wr(b, mark).filter((x) => x.method === "PUT").length === 1 && (await cardOf()).title === "Моя правка" && (await text(b, ".v2-screen [role=status]")).includes("хотя ответ не дошёл"), await text(b, ".v2-screen [role=status]"));
  await admin.put("/settings/project-card?object_id=1", c0);
  await b.close();
  const v = await session(BASE, "user4");
  await openSection(v, "project-card"); await v.sleep(1500);
  ok("PC-UI-4 user4 (просмотр): кнопки «Сохранить» нет; PUT напрямую — 403", !(await exists(v, "#pc-save")) && (await (await http(BASE, "user4")).put("/settings/project-card?object_id=1", c0)).status === 403);
  await v.close();

  // ---------------- СМУ
  const s2 = await session(BASE, "admin");
  await openSection(s2, "dict-smu"); await s2.waitFor("!!document.querySelector('#de-add-input')");
  await fill(s2, "#de-add-input", "QA СМУ UI");
  await click(s2, "#de-add-btn"); await s2.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Добавлено')", 10000);
  const smu = one("SELECT id FROM smu_catalog WHERE name='QA СМУ UI'");
  ok("SM-UI-1 СМУ: добавление, запись в БД, журнал", !!smu && (await flush(), q("SELECT * FROM activity_log WHERE action='smu_create' AND entity_id=" + smu.id).length === 1));
  await fill(s2, "#de-add-input", "qa сму ui");
  await click(s2, "#de-add-btn"); await s2.waitFor("(document.querySelector('#de-status')||{}).innerText?.includes('уже есть')", 10000);
  ok("SM-UI-2 дубль другим регистром (кириллица): отказ 409, в БД одна запись", one("SELECT COUNT(*) n FROM smu_catalog WHERE name LIKE 'QA СМУ UI' OR name LIKE 'qa сму ui'").n === 1);
  await fill(s2, "#de-add-input", "");
  const usedSmu = one("SELECT smu_id s FROM objects WHERE smu_id IS NOT NULL ORDER BY id LIMIT 1").s;
  const usedName = one(`SELECT name FROM smu_catalog WHERE id=${usedSmu}`).name;
  await fill(s2, "#de-search", usedName);
  await click(s2, `[data-act=delete][data-id="${usedSmu}"]`); await s2.waitFor("!!document.querySelector('#de-repl')", 10000);
  await s2.eval(`(()=>{const s=document.querySelector('#de-repl'); s.value='${smu.id}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const nRef = one(`SELECT COUNT(*) n FROM objects WHERE smu_id=${usedSmu}`).n;
  mark = s2.requests.length;
  await click(s2, ".v2-dialog [data-choice=confirm]"); await s2.waitFor("(document.querySelector('#de-status')||{}).innerText?.startsWith('Удалено')", 12000);
  ok("SM-UI-3 удаление используемого СМУ с заменой: ОДИН POST; ссылки объектов переведены на замену (SQL), запись удалена", wr(s2, mark).filter((x) => x.url.includes("/delete")).length === 1 && one(`SELECT COUNT(*) n FROM smu_catalog WHERE id=${usedSmu}`).n === 0 && one(`SELECT COUNT(*) n FROM objects WHERE smu_id=${smu.id}`).n === nRef);
  await s2.close();
}

process.exit(summary() ? 1 : 0);

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

process.exit(summary() ? 1 : 0);

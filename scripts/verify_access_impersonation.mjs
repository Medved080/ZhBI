// Проверка режима «Зайти под пользователем» в V2 (2026-09-22, исполнитель «access»): кнопка переключает ЭТУ ЖЕ
// вкладку (не открывает V1 в новой), полоса в шапке, права пересчитываются, сцена V1 в кадре рабочего места
// получает те же права БЕЗ правок workspace.js (общий sessionStorage той же вкладки), выход возвращает
// администратора к своей учётной записи. Настоящий backend (scripts/real_auth_server.py), настоящий вход,
// настоящие события мыши/клавиатуры (scripts/cdp.mjs).
//
// Запуск: .venv/bin/python scripts/real_auth_server.py <источник> 8290 <каталог-копии>  (в фоне)
//         node scripts/verify_access_impersonation.mjs http://127.0.0.1:8290
import { launch } from "./cdp.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8290";
const PASS = "Test-Pass-1234!";
let failed = 0;
function ok(cond, label) { console.log(`${cond ? "OK  " : "FAIL"} ${label}`); if (!cond) failed++; }

async function login(b, login) {
  await b.goto(`${BASE}/v2`);
  await b.waitFor(`!!document.querySelector("#v2-login-user")`);
  await b.clickSel("#v2-login-user");
  await b.type(login);
  await b.clickSel("#v2-login-pass");
  await b.type(PASS);
  await b.clickSel("#v2-login-form button[type=submit]");
  await b.waitFor(`!!document.querySelector("#v2-object-btn")`, 10000);
  await b.sleep(300);
}

async function openUsersAccess(b) {
  await b.eval(`location.hash = "#/users-access"`);
  await b.waitFor(`!!document.querySelector("[data-user]")`, 10000);
  await b.sleep(200);
}

async function openUserCard(b, userId, tab) {
  await b.eval(`document.querySelector('[data-user="${userId}"]').click()`);
  await b.waitFor(`!!document.querySelector("[data-tab]")`, 8000);
  if (tab) {
    await b.eval(`document.querySelector('[data-tab="${tab}"]').click()`);
    await b.sleep(250);
  }
}

async function main() {
  // ---- 1) admin переключает вкладку в режим «от имени» user2 (роль user, доступ к объекту 1) ----
  const b = await launch({ width: 1920, height: 1080 });
  try {
    await login(b, "admin");
    await openUsersAccess(b);
    await openUserCard(b, 416, "security");
    ok(await b.eval(`!!document.querySelector("#sec-impersonate")`), "кнопка «Зайти под пользователем…» видна администратору на чужой карточке");

    // подтверждение — showConfirmDialog (v2-dialog-backdrop), кнопка "Переключить"
    await b.eval(`document.getElementById("sec-impersonate").scrollIntoView({block:"center"})`);
    await b.sleep(150);
    await b.clickSel("#sec-impersonate");
    await b.waitFor(`!!document.querySelector(".v2-dialog-backdrop")`, 5000);
    const dialogText = await b.eval(`document.querySelector(".v2-dialog-backdrop p")?.textContent || ""`);
    ok(/Фамилия2 Имя2/.test(dialogText) || /переключить/i.test(dialogText), "диалог подтверждения называет пользователя и режим переключения (не «новую вкладку»)");
    ok(!/новую вкладку/i.test(dialogText), "текст диалога НЕ говорит про «новую вкладку» (старое поведение убрано)");

    const before = { hadNewTab: false };
    // Кликаем "Переключить" (primary-кнопка диалога)
    const btnCount = await b.eval(`document.querySelectorAll(".v2-dialog-backdrop [data-choice]").length`);
    await b.eval(`document.querySelector('.v2-dialog-backdrop [data-choice="confirm"]').click()`);
    // Ждём перезагрузку — сначала статус, затем сам reload (адрес остаётся тем же origin/path)
    await b.sleep(1500);
    await b.waitFor(`document.readyState === "complete"`, 10000);
    await b.waitFor(`!!document.querySelector("#v2-object-btn") || !!document.querySelector("#v2-login-user")`, 10000);
    await b.sleep(500);

    const stillLoggedIn = await b.eval(`!!document.querySelector("#v2-object-btn")`);
    ok(stillLoggedIn, "после переключения вкладка осталась в оболочке V2 (не ушла на экран входа/в V1)");
    const reqMarkAfterSwitch = b.requests.length; // всё ДО этой отметки — включая ожидаемый 401 у /me до самого первого входа
    ok(BASE && (await b.eval(`location.pathname`)).startsWith("/v2"), "адрес остался в /v2 (не открылась V1)");

    const barVisible = await b.eval(`!document.getElementById("v2-impersonation-bar")?.hidden`);
    ok(barVisible, "красная полоса режима «от имени» видна после переключения");
    const barText = await b.eval(`document.getElementById("v2-impersonation-text")?.textContent || ""`);
    ok(/Фамилия1 Имя1/.test(barText) && /Фамилия2 Имя2/.test(barText), `текст полосы называет и админа, и подопечного: "${barText}"`);

    const me = await b.eval(`fetch("/me",{credentials:"same-origin"}).then(r=>r.json())`);
    ok(me.display_name === "Фамилия2 Имя2" && me.role === "user", `«/me» вернул личность подопечного (${me.display_name}, роль ${me.role})`);
    ok(me.impersonated_by === "Фамилия1 Имя1", `«/me».impersonated_by = имя администратора ("${me.impersonated_by}")`);

    const perms = await b.eval(`fetch("/me/permissions",{credentials:"same-origin"}).then(r=>r.json())`);
    ok(perms.system_admin === false, "права пересчитаны: system_admin=false (права подопечного, не администратора)");

    // "Пользователи и доступ" не должна быть доступна подопечному (роль user, нет гранта users/roles)
    const navHasUsers = await b.eval(`!!document.querySelector('[data-nav-key="users-access"]') || Array.from(document.querySelectorAll("#v2-side a,#v2-side button")).some(e=>/Пользователи и доступ/.test(e.textContent||""))`);
    ok(!navHasUsers, "левая навигация подопечника НЕ показывает «Пользователи и доступ» (нет прав)");

    // ---- 2) сцена V1 в кадре рабочего места получает тот же контекст (общий sessionStorage вкладки) ----
    await b.eval(`location.hash = "#/ws-model"`);
    await b.sleep(3500);
    const frameOk = await b.eval(`!!document.querySelector("iframe.ws-frame")`);
    ok(frameOk, "рабочее место «Модель» открылось (кадр сцены создан) под правами подопечника");
    if (frameOk) {
      const sharedToken = await b.eval(`(() => { try { const f = document.querySelector("iframe.ws-frame"); return sessionStorage.getItem("zhbi_impersonate") === f.contentWindow.sessionStorage.getItem("zhbi_impersonate") && !!sessionStorage.getItem("zhbi_impersonate"); } catch(e) { return "ERR:" + e.message; } })()`);
      ok(sharedToken === true, `sessionStorage.zhbi_impersonate РАЗДЕЛЯЕТСЯ кадром и оболочкой (${sharedToken})`);
      // Если бы заголовок не долетал до кадра — сессия «от имени» не проходит по cookie (impersonator_user_id
      // сеансы исключены из get_user_by_session), и кадр получил бы 401 на /me — проверяем по журналу запросов.
      const frameMe = await b.eval(`(() => { const f = document.querySelector("iframe.ws-frame"); try { return f.contentWindow.state && f.contentWindow.state.currentUser ? f.contentWindow.state.currentUser.display_name : "NO_STATE"; } catch(e) { return "ERR:" + e.message; } })()`);
      console.log("    (диагностика) состояние кадра:", frameMe);
      const postSwitch = b.requests.slice(reqMarkAfterSwitch);
      const unauthorized = postSwitch.filter((r) => r.status === 401);
      ok(unauthorized.length === 0, `нет ни одного 401 среди ${postSwitch.length} запросов ПОСЛЕ переключения (заголовок «от имени» дошёл и до кадра); до переключения нормальный 401 у /me (ещё не вошли) не считается`);
    }

    // ---- 3) нельзя открыть ВТОРОЙ режим «от имени», пока активен этот (вложенность запрещена и на backend) ----
    const nested = await b.eval(`fetch("/users/417/impersonate",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"}).then(r=>r.status)`);
    ok(nested === 403, `вложенный вход отклонён backend (403), получено: ${nested}`);

    // ---- 4) выход — «Вернуться к своей учётной записи» ----
    await b.eval(`location.hash = "#/"`);
    await b.sleep(400);
    ok(await b.eval(`!document.getElementById("v2-impersonation-bar")?.hidden`), "полоса всё ещё видна перед выходом");
    await b.clickSel("#v2-impersonation-exit");
    await b.sleep(1200);
    await b.waitFor(`document.readyState === "complete"`, 10000);
    await b.waitFor(`!!document.querySelector("#v2-object-btn")`, 10000);
    await b.sleep(400);
    const meAfter = await b.eval(`fetch("/me",{credentials:"same-origin"}).then(r=>r.json())`);
    ok(meAfter.display_name === "Фамилия1 Имя1" && !meAfter.impersonated_by, `после выхода «/me» снова администратор ("${meAfter.display_name}"), impersonated_by=${meAfter.impersonated_by}`);
    ok(await b.eval(`document.getElementById("v2-impersonation-bar")?.hidden !== false`), "полоса скрыта после выхода");
    const tokenGone = await b.eval(`sessionStorage.getItem("zhbi_impersonate")`);
    ok(!tokenGone, "токен «от имени» удалён из sessionStorage после выхода");

    ok(b.exceptions.length === 0, `нет необработанных исключений в консоли (${b.exceptions.length})`);
  } finally {
    await b.close();
  }

  // ---- 5) отдельная вкладка: admin импersonирует другого админа (user3) — кнопка ДОЛЖНА заблокироваться (вложенность) ----
  const b2 = await launch({ width: 1920, height: 1080 });
  try {
    await login(b2, "admin");
    await openUsersAccess(b2);
    await openUserCard(b2, 417, "security"); // user3 — тоже role=admin
    await b2.eval(`document.getElementById("sec-impersonate").scrollIntoView({block:"center"})`);
    await b2.sleep(150);
    await b2.clickSel("#sec-impersonate");
    await b2.waitFor(`!!document.querySelector(".v2-dialog-backdrop")`, 5000);
    await b2.eval(`document.querySelector('.v2-dialog-backdrop [data-choice="confirm"]').click()`);
    await b2.sleep(1500);
    await b2.waitFor(`document.readyState === "complete"`, 10000);
    await b2.waitFor(`!!document.querySelector("#v2-object-btn")`, 10000);
    await b2.sleep(400);
    const me3 = await b2.eval(`fetch("/me",{credentials:"same-origin"}).then(r=>r.json())`);
    ok(me3.role === "admin" && me3.impersonated_by === "Фамилия1 Имя1", `режим «от имени» админа (user3) тоже работает (${me3.display_name}, роль ${me3.role})`);
    // теперь user3 (сам админ) открывает СВОЮ карточку user2 и пробует «Зайти под пользователем» — кнопка должна быть отключена (вложенность)
    await openUsersAccess(b2);
    await openUserCard(b2, 416, "security");
    const impBtnPresent = await b2.eval(`!!document.querySelector("#sec-impersonate")`);
    ok(!impBtnPresent, "кнопка «Зайти под пользователем…» СКРЫТА, пока сама вкладка уже в режиме «от имени» (защита от вложенности в интерфейсе)");
    const noteText = await b2.eval(`document.getElementById("ua-edit-panel")?.textContent || ""`);
    ok(/вложенность запрещена/i.test(noteText) || /Нельзя открыть/i.test(noteText), "вместо кнопки показана понятная причина");
    // выход
    await b2.clickSel("#v2-impersonation-exit");
    await b2.sleep(1200);
    await b2.waitFor(`!!document.querySelector("#v2-object-btn")`, 10000);
  } finally {
    await b2.close();
  }

  console.log(failed ? `\nИТОГ: ${failed} провалено` : "\nИТОГ: всё пройдено");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("СБОЙ СКРИПТА:", e); process.exit(2); });
